import {
  ChannelType,
  Permissions as P,
  computePermissions,
  has,
  highestPosition,
  isDmType,
  type PermOverwrite,
} from '@dbb/shared';
import type { Db } from '../db.js';
import type { Ctx } from '../context.js';
import type { ChannelRow, GuildRow, OverwriteRow, RoleRow } from '../rows.js';
import { forbidden, notFound } from '../errors.js';

/** What a DM participant can do. */
export const DM_PERMISSIONS =
  P.VIEW_CHANNEL |
  P.SEND_MESSAGES |
  P.READ_MESSAGE_HISTORY |
  P.ADD_REACTIONS |
  P.EMBED_LINKS |
  P.ATTACH_FILES |
  P.USE_EXTERNAL_EMOJIS |
  P.USE_EXTERNAL_STICKERS |
  P.USE_ACTIVITIES;

export interface GuildPermData {
  guild: GuildRow;
  roles: Map<string, { id: string; permissions: bigint; position: number; mentionable: boolean; name: string }>;
  everyone: bigint;
}

export interface MemberData {
  roles: string[];
  timeoutUntil: Date | null;
}

export async function loadGuildPermData(db: Db, guildId: string): Promise<GuildPermData | null> {
  const [guild] = await db<GuildRow[]>`SELECT * FROM guilds WHERE id = ${guildId}`;
  if (!guild) return null;
  const roles = await db<RoleRow[]>`SELECT * FROM roles WHERE guild_id = ${guildId}`;
  const map = new Map(
    roles.map((r) => [
      r.id,
      { id: r.id, permissions: BigInt(r.permissions), position: r.position, mentionable: r.mentionable, name: r.name },
    ]),
  );
  return { guild, roles: map, everyone: map.get(guildId)?.permissions ?? 0n };
}

export async function loadMember(db: Db, guildId: string, userId: string): Promise<MemberData | null> {
  const rows = await db<{ timeout_until: Date | null; roles: string[] | null }[]>`
    SELECT m.timeout_until,
      (SELECT array_agg(role_id::text) FROM member_roles mr WHERE mr.guild_id = m.guild_id AND mr.user_id = m.user_id) AS roles
    FROM guild_members m WHERE m.guild_id = ${guildId} AND m.user_id = ${userId}`;
  const r = rows[0];
  if (!r) return null;
  return { roles: r.roles ?? [], timeoutUntil: r.timeout_until };
}

export async function loadOverwrites(db: Db, channelId: string): Promise<PermOverwrite[]> {
  const rows = await db<OverwriteRow[]>`SELECT * FROM permission_overwrites WHERE channel_id = ${channelId}`;
  return rows.map(toOverwrite);
}

export function toOverwrite(r: OverwriteRow): PermOverwrite {
  return { id: r.target_id, type: r.target_type, allow: BigInt(r.allow), deny: BigInt(r.deny) };
}

export function isTimedOut(m: MemberData | null): boolean {
  return !!m?.timeoutUntil && m.timeoutUntil.getTime() > Date.now();
}

export function memberRolesFor(data: GuildPermData, member: MemberData) {
  return member.roles.map((id) => data.roles.get(id)).filter((r): r is NonNullable<typeof r> => !!r && r.id !== data.guild.id);
}

export function guildPermissionsOf(data: GuildPermData, userId: string, member: MemberData): bigint {
  return computePermissions({
    userId,
    guildId: data.guild.id,
    ownerId: data.guild.owner_id,
    everyone: data.everyone,
    memberRoles: memberRolesFor(data, member),
    timedOut: isTimedOut(member),
  });
}

export function channelPermissionsOf(data: GuildPermData, userId: string, member: MemberData, overwrites: PermOverwrite[]): bigint {
  return computePermissions({
    userId,
    guildId: data.guild.id,
    ownerId: data.guild.owner_id,
    everyone: data.everyone,
    memberRoles: memberRolesFor(data, member),
    overwrites,
    timedOut: isTimedOut(member),
  });
}

export function highestOf(data: GuildPermData, userId: string, member: MemberData): number {
  if (userId === data.guild.owner_id) return Number.MAX_SAFE_INTEGER;
  return highestPosition(member.roles, data.roles);
}

export interface GuildAccess {
  data: GuildPermData;
  member: MemberData;
  perms: bigint;
  highest: number;
  isOwner: boolean;
}

/** 404 if the guild doesn't exist or you're not in it (don't leak existence). */
export async function guildAccess(ctx: Ctx | { sql: Db }, guildId: string, userId: string): Promise<GuildAccess> {
  const db = ctx.sql;
  const data = await loadGuildPermData(db, guildId);
  if (!data) throw notFound('Server not found');
  const member = await loadMember(db, guildId, userId);
  if (!member) throw notFound('Server not found');
  return {
    data,
    member,
    perms: guildPermissionsOf(data, userId, member),
    highest: highestOf(data, userId, member),
    isOwner: data.guild.owner_id === userId,
  };
}

export async function requireGuildPerm(ctx: Ctx, guildId: string, userId: string, flag: bigint): Promise<GuildAccess> {
  const a = await guildAccess(ctx, guildId, userId);
  if (!has(a.perms, flag)) throw forbidden();
  return a;
}

export interface ChannelAccess {
  channel: ChannelRow;
  /** For threads: the parent channel. */
  parent: ChannelRow | null;
  perms: bigint;
  guild: GuildAccess | null;
  /** DM recipients (user ids), only for DMs. */
  recipients: string[] | null;
}

export async function getChannel(db: Db, channelId: string): Promise<ChannelRow | null> {
  const [c] = await db<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId}`;
  return c ?? null;
}

/**
 * Resolves what `userId` can do in a channel. 404 if they can't see it at all.
 * Threads use their parent channel's overwrites.
 */
export async function channelAccess(ctx: Ctx | { sql: Db }, channelId: string, userId: string): Promise<ChannelAccess> {
  const db = ctx.sql;
  const channel = await getChannel(db, channelId);
  if (!channel) throw notFound('Channel not found');

  if (isDmType(channel.type)) {
    const rec = await db<{ user_id: string }[]>`SELECT user_id::text FROM dm_recipients WHERE channel_id = ${channelId}`;
    const ids = rec.map((r) => r.user_id);
    if (!ids.includes(userId)) throw notFound('Channel not found');
    return { channel, parent: null, perms: DM_PERMISSIONS, guild: null, recipients: ids };
  }

  if (!channel.guild_id) throw notFound('Channel not found');
  const guild = await guildAccess(ctx, channel.guild_id, userId);
  let parent: ChannelRow | null = null;
  let overwriteSource = channel.id;
  if (channel.type === ChannelType.THREAD) {
    parent = channel.parent_id ? await getChannel(db, channel.parent_id) : null;
    if (!parent) throw notFound('Channel not found');
    overwriteSource = parent.id;
  }
  const overwrites = await loadOverwrites(db, overwriteSource);
  const perms = channelPermissionsOf(guild.data, userId, guild.member, overwrites);
  if (!has(perms, P.VIEW_CHANNEL)) throw notFound('Channel not found');
  return { channel, parent, perms, guild, recipients: null };
}

export async function requireChannelPerm(ctx: Ctx, channelId: string, userId: string, flag: bigint): Promise<ChannelAccess> {
  const a = await channelAccess(ctx, channelId, userId);
  if (!has(a.perms, flag)) throw forbidden();
  return a;
}

/** Can this user send in this channel (handles threads, locks, DMs with blocks)? Throws if not. */
export async function assertCanSend(ctx: Ctx, a: ChannelAccess, userId: string): Promise<void> {
  const c = a.channel;
  if (c.type === ChannelType.CATEGORY || c.type === ChannelType.WIKI) throw forbidden("You can't send messages here");
  if (c.type === ChannelType.THREAD) {
    if (!has(a.perms, P.SEND_MESSAGES_IN_THREADS)) throw forbidden();
    if (c.locked && !has(a.perms, P.MANAGE_THREADS)) throw forbidden('This thread is locked');
  } else if (!has(a.perms, P.SEND_MESSAGES)) {
    if (a.guild && isTimedOut(a.guild.member)) throw forbidden("You're timed out in this server");
    throw forbidden();
  }
  if (c.type === ChannelType.DM && a.recipients) {
    const other = a.recipients.find((r) => r !== userId);
    if (other) {
      const blocked = await ctx.sql`
        SELECT 1 FROM relationships WHERE type = 2 AND
          ((user_id = ${userId} AND target_id = ${other}) OR (user_id = ${other} AND target_id = ${userId}))`;
      if (blocked.length) throw forbidden("You can't message this person");
      const [o] = await ctx.sql<{ dm_policy: string; deleted: boolean }[]>`SELECT dm_policy, deleted FROM users WHERE id = ${other}`;
      if (!o || o.deleted) throw forbidden('This account was deleted');
      if (o.dm_policy === 'friends') {
        const f = await ctx.sql`SELECT 1 FROM relationships WHERE user_id = ${other} AND target_id = ${userId} AND type = 1`;
        if (!f.length) throw forbidden('They only accept DMs from friends');
      }
    }
  }
}

/** All user ids who can currently view a guild channel (for mention counting). */
export async function viewersOf(db: Db, data: GuildPermData, channelId: string, candidateIds?: string[]): Promise<string[]> {
  const overwrites = await loadOverwrites(db, channelId);
  const rows = candidateIds
    ? await db<{ user_id: string; timeout_until: Date | null; roles: string[] | null }[]>`
        SELECT m.user_id::text, m.timeout_until,
          (SELECT array_agg(role_id::text) FROM member_roles mr WHERE mr.guild_id = m.guild_id AND mr.user_id = m.user_id) AS roles
        FROM guild_members m WHERE m.guild_id = ${data.guild.id} AND m.user_id = ANY(${candidateIds}::bigint[])`
    : await db<{ user_id: string; timeout_until: Date | null; roles: string[] | null }[]>`
        SELECT m.user_id::text, m.timeout_until,
          (SELECT array_agg(role_id::text) FROM member_roles mr WHERE mr.guild_id = m.guild_id AND mr.user_id = m.user_id) AS roles
        FROM guild_members m WHERE m.guild_id = ${data.guild.id}`;
  return rows
    .filter((r) => {
      const p = channelPermissionsOf(data, r.user_id, { roles: r.roles ?? [], timeoutUntil: r.timeout_until }, overwrites);
      return has(p, P.VIEW_CHANNEL);
    })
    .map((r) => r.user_id);
}
