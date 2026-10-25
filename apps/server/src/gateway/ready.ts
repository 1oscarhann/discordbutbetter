import {
  RelationshipType,
  normaliseSettings,
  type Presence,
  type ReadyPayload,
  type Relationship,
  type RelationshipTypeValue,
} from '@dbb/shared';
import type { Ctx } from '../context.js';
import type { ChannelRow, UserRow } from '../rows.js';
import { buildFullGuild } from '../lib/guildstate.js';
import { channel as serChannel, publicUser, selfUser } from '../lib/serialize.js';
import { buildPresence, canSeeLastSeen, visibleStatuses } from '../lib/presence.js';
import { instanceInfo } from '../lib/instance.js';
import type { PermCache } from './permcache.js';

export async function loadDmChannels(ctx: Ctx, userId: string, onlyOpen = true) {
  const chans = await ctx.sql<ChannelRow[]>`
    SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.id
    WHERE r.user_id = ${userId} ${onlyOpen ? ctx.sql`AND r.open` : ctx.sql``}
    ORDER BY COALESCE(c.last_message_id, c.id) DESC LIMIT 300`;
  if (!chans.length) return [];
  const rec = await ctx.sql<(UserRow & { channel_id: string })[]>`
    SELECT u.*, r.channel_id FROM dm_recipients r JOIN users u ON u.id = r.user_id
    WHERE r.channel_id = ANY(${chans.map((c) => c.id)}::bigint[]) ORDER BY r.joined_at`;
  const byChan = new Map<string, UserRow[]>();
  for (const r of rec) {
    const l = byChan.get(r.channel_id) ?? [];
    l.push(r);
    byChan.set(r.channel_id, l);
  }
  return chans.map((c) => serChannel(c, [], (byChan.get(c.id) ?? []).map(publicUser)));
}

export async function loadRelationships(ctx: Ctx, userId: string): Promise<Relationship[]> {
  const rows = await ctx.sql<(UserRow & { rel_type: number; rel_created: Date })[]>`
    SELECT u.*, r.type AS rel_type, r.created_at AS rel_created
    FROM relationships r JOIN users u ON u.id = r.target_id WHERE r.user_id = ${userId}`;
  return rows.map((r) => ({ user: publicUser(r), type: r.rel_type as RelationshipTypeValue, since: r.rel_created.toISOString() }));
}

export async function buildReady(ctx: Ctx, cache: PermCache, userId: string, sessionId: string, visible: Map<string, Set<string>>): Promise<ReadyPayload | null> {
  const [me] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${userId}`;
  if (!me) return null;

  const guildIds = (await ctx.sql<{ guild_id: string }[]>`SELECT guild_id FROM guild_members WHERE user_id = ${userId} ORDER BY joined_at`).map(
    (g) => g.guild_id,
  );
  const guilds = [];
  for (const gid of guildIds) {
    const vis = await cache.visibleChannels(gid, userId);
    visible.set(gid, vis);
    const fg = await buildFullGuild(ctx, gid, userId, vis);
    if (fg) guilds.push(fg);
  }

  const [dms, relationships, readStates, gns, cns, folders] = await Promise.all([
    loadDmChannels(ctx, userId),
    loadRelationships(ctx, userId),
    ctx.sql<{ channel_id: string; last_read_id: string; mention_count: number }[]>`
      SELECT channel_id, last_read_id, mention_count FROM read_states WHERE user_id = ${userId}`,
    ctx.sql<{ guild_id: string; level: number; suppress_everyone: boolean; suppress_roles: boolean; muted_until: Date | null }[]>`
      SELECT * FROM guild_notification_settings WHERE user_id = ${userId}`,
    ctx.sql<{ channel_id: string; level: number; muted_until: Date | null }[]>`
      SELECT * FROM channel_notification_settings WHERE user_id = ${userId}`,
    ctx.sql<{ id: string; name: string; position: number }[]>`
      SELECT id, name, position FROM bookmark_folders WHERE user_id = ${userId} ORDER BY position, id`,
  ]);

  // presences for everyone the client will render
  const friendIds = new Set(relationships.filter((r) => r.type === RelationshipType.FRIEND).map((r) => r.user.id));
  const people = new Set<string>(friendIds);
  for (const d of dms) for (const r of d.recipients ?? []) people.add(r.id);
  for (const g of guilds) for (const m of g.members) people.add(m.user.id);
  people.add(userId);
  const presences: Presence[] = [];
  const ids = [...people];
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    const users = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ANY(${chunk}::bigint[])`;
    const statuses = await visibleStatuses(ctx, users);
    for (const u of users) {
      const status = u.id === userId ? (statuses.get(u.id) ?? 'offline') : (statuses.get(u.id) ?? 'offline');
      const p = buildPresence(u, status, { canSeeLastSeen: canSeeLastSeen(u, userId, friendIds.has(u.id)) });
      presences.push(p);
    }
  }

  return {
    user: selfUser(me),
    settings: normaliseSettings(me.settings),
    guilds,
    dms,
    relationships,
    readStates: readStates.map((r) => ({ channelId: r.channel_id, lastReadId: r.last_read_id, mentionCount: r.mention_count })),
    presences,
    guildNotificationSettings: gns.map((g) => ({
      guildId: g.guild_id,
      level: g.level as 0 | 1 | 2,
      suppressEveryone: g.suppress_everyone,
      suppressRoles: g.suppress_roles,
      mutedUntil: g.muted_until?.toISOString() ?? null,
    })),
    channelNotificationSettings: cns.map((c) => ({
      channelId: c.channel_id,
      level: c.level as -1 | 0 | 1 | 2,
      mutedUntil: c.muted_until?.toISOString() ?? null,
    })),
    bookmarkFolders: folders,
    instance: instanceInfo(ctx),
    sessionId,
    serverTime: Date.now(),
  };
}
