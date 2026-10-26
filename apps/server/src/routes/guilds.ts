import type { FastifyInstance } from 'fastify';
import {
  AuditAction,
  ChannelType,
  CreateGuildSchema,
  CreateInviteSchema,
  DEFAULT_EVERYONE_PERMISSIONS,
  GuildPatchSchema,
  Limits,
  MessageType,
  Permissions as P,
  TransferGuildSchema,
  has,
  type Invite,
} from '@haunt/shared';
import type { ChannelRow, GuildRow, UserRow } from '../rows.js';
import { idParam, parse, requireAuth, strParam } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { inviteCode, snowflake } from '../ids.js';
import { guildAccess, requireChannelPerm, requireGuildPerm } from '../lib/perms.js';
import { guild as serGuild, loadMember, publicUser } from '../lib/serialize.js';
import { buildFullGuild } from '../lib/guildstate.js';
import { audit, diff } from '../lib/audit.js';
import { claimFile, deleteFile, fileIdFromUrl, fileUrl } from './files.js';
import { insertSystemMessage } from '../services/messages.js';
import { verifyPassword } from '../auth/passwords.js';
import { broadcastPresence } from '../lib/presence.js';
import { disconnectVoice, getUserVoice } from '../services/voice.js';
import type { Ctx } from '../context.js';

export async function removeMember(ctx: Ctx, guildId: string, userId: string): Promise<void> {
  const vs = await getUserVoice(ctx, userId);
  if (vs?.guildId === guildId) await disconnectVoice(ctx, userId);
  await ctx.sql`DELETE FROM guild_members WHERE guild_id = ${guildId} AND user_id = ${userId}`;
  ctx.bus.toGuild(guildId, 'GUILD_MEMBER_REMOVE', { guildId, userId }, { invalidate: true });
  ctx.bus.internalUser(userId, '_GUILD_LEAVE', { guildId });
}

async function deleteGuildFiles(ctx: Ctx, guildId: string, g: GuildRow) {
  await deleteFile(ctx, g.icon);
  await deleteFile(ctx, g.banner);
  const emoji = await ctx.sql<{ url: string }[]>`SELECT url FROM guild_emojis WHERE guild_id = ${guildId}`;
  const stickers = await ctx.sql<{ url: string }[]>`SELECT url FROM guild_stickers WHERE guild_id = ${guildId}`;
  for (const e of [...emoji, ...stickers]) await deleteFile(ctx, e.url);
  const avatars = await ctx.sql<{ avatar: string }[]>`SELECT avatar FROM guild_members WHERE guild_id = ${guildId} AND avatar IS NOT NULL`;
  for (const a of avatars) await deleteFile(ctx, a.avatar);
}

async function deleteGuildAttachments(ctx: Ctx, guildId: string) {
  for (;;) {
    const files = await ctx.sql<{ file_id: string }[]>`
      SELECT a.file_id FROM message_attachments a JOIN messages m ON m.id = a.message_id WHERE m.guild_id = ${guildId} LIMIT 500`;
    if (!files.length) return;
    for (const f of files) await deleteFile(ctx, f.file_id);
  }
}

/** Deletes a server and everything in it (files included) and tells every member's sessions. */
export async function deleteGuild(ctx: Ctx, id: string): Promise<void> {
  const [g] = await ctx.sql<GuildRow[]>`SELECT * FROM guilds WHERE id = ${id}`;
  if (!g) throw notFound('Server not found');
  const members = await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM guild_members WHERE guild_id = ${id}`;
  for (const m of members) {
    const vs = await getUserVoice(ctx, m.user_id);
    if (vs?.guildId === id) await disconnectVoice(ctx, m.user_id);
  }
  await deleteGuildFiles(ctx, id, g);
  await deleteGuildAttachments(ctx, id);
  await ctx.sql`DELETE FROM guilds WHERE id = ${id}`;
  await ctx.redis.del(`vs:${id}`);
  for (const m of members) ctx.bus.internalUser(m.user_id, '_GUILD_LEAVE', { guildId: id });
}

async function inviteObj(ctx: Ctx, code: string): Promise<Invite | null> {
  const [r] = await ctx.sql<
    {
      code: string;
      guild_id: string;
      channel_id: string | null;
      max_uses: number;
      uses: number;
      expires_at: Date | null;
      created_at: Date;
      g_name: string;
      g_icon: string | null;
      g_description: string;
      members: number;
      inviter_id: string | null;
    }[]
  >`
    SELECT i.*, g.name AS g_name, g.icon AS g_icon, g.description AS g_description,
      (SELECT count(*)::int FROM guild_members m WHERE m.guild_id = g.id) AS members
    FROM invites i JOIN guilds g ON g.id = i.guild_id WHERE i.code = ${code}`;
  if (!r) return null;
  if (r.expires_at && r.expires_at.getTime() < Date.now()) return null;
  if (r.max_uses > 0 && r.uses >= r.max_uses) return null;
  let inviter = null;
  if (r.inviter_id) {
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${r.inviter_id}`;
    if (u) inviter = publicUser(u);
  }
  const online = await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM guild_members WHERE guild_id = ${r.guild_id} LIMIT 5000`;
  let onlineCount = 0;
  if (online.length) {
    const pipe = ctx.redis.pipeline();
    const cutoff = Date.now() - 90_000;
    for (const o of online) pipe.zcount(`pres:${o.user_id}`, cutoff, '+inf');
    const res = (await pipe.exec()) ?? [];
    onlineCount = res.filter((x) => Number(x?.[1] ?? 0) > 0).length;
  }
  return {
    code: r.code,
    guild: { id: r.guild_id, name: r.g_name, icon: r.g_icon, description: r.g_description, memberCount: r.members, onlineCount },
    channelId: r.channel_id,
    inviter,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

export default async function guildRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post('/guilds', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'guildCreate');
    const body = parse(CreateGuildSchema, req.body);
    const [{ count }] = (await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM guild_members WHERE user_id = ${auth.userId}`) as unknown as [{ count: number }];
    if (count >= Limits.GUILDS_PER_USER) throw forbidden(`You can be in at most ${Limits.GUILDS_PER_USER} servers`);

    const id = snowflake();
    const icon = body.iconFileId ? fileUrl(await claimFile(ctx, body.iconFileId, auth.userId, ['guild_icon'])) : null;
    const textCat = snowflake();
    const general = snowflake();
    const voiceCat = snowflake();
    const voice = snowflake();
    await ctx.sql.begin(async (tx) => {
      await tx`INSERT INTO guilds (id, name, icon, owner_id, system_channel_id) VALUES (${id}, ${body.name}, ${icon}, ${auth.userId}, ${general})`;
      await tx`
        INSERT INTO roles (id, guild_id, name, position, permissions)
        VALUES (${id}, ${id}, '@everyone', 0, ${DEFAULT_EVERYONE_PERMISSIONS.toString()})`;
      await tx`INSERT INTO guild_members (guild_id, user_id) VALUES (${id}, ${auth.userId})`;
      await tx`
        INSERT INTO channels (id, type, guild_id, parent_id, name, position) VALUES
          (${textCat}, ${ChannelType.CATEGORY}, ${id}, NULL, 'Text channels', 0),
          (${general}, ${ChannelType.TEXT}, ${id}, ${textCat}, 'general', 0),
          (${voiceCat}, ${ChannelType.CATEGORY}, ${id}, NULL, 'Voice channels', 1),
          (${voice}, ${ChannelType.VOICE}, ${id}, ${voiceCat}, 'General', 0)`;
    });
    ctx.bus.internalUser(auth.userId, '_GUILD_JOIN', { guildId: id });
    const vis = new Set([textCat, general, voiceCat, voice]);
    return buildFullGuild(ctx, id, auth.userId, vis);
  });

  app.get('/guilds/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const a = await guildAccess(ctx, id, auth.userId);
    return { ...serGuild(a.data.guild), permissions: a.perms.toString() };
  });

  app.patch('/guilds/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_GUILD);
    const p = parse(GuildPatchSchema, req.body);
    const g = a.data.guild;
    const sets: Record<string, unknown> = {};
    const toDelete: (string | null)[] = [];
    if (p.name !== undefined) sets.name = p.name;
    if (p.description !== undefined) sets.description = p.description;
    if (p.iconFileId !== undefined && p.iconFileId !== fileIdFromUrl(g.icon)) {
      sets.icon = p.iconFileId ? fileUrl(await claimFile(ctx, p.iconFileId, auth.userId, ['guild_icon'])) : null;
      toDelete.push(g.icon);
    }
    if (p.bannerFileId !== undefined && p.bannerFileId !== fileIdFromUrl(g.banner)) {
      sets.banner = p.bannerFileId ? fileUrl(await claimFile(ctx, p.bannerFileId, auth.userId, ['guild_banner'])) : null;
      toDelete.push(g.banner);
    }
    if (p.systemChannelId !== undefined) {
      if (p.systemChannelId) {
        const [c] = await ctx.sql`SELECT 1 FROM channels WHERE id = ${p.systemChannelId} AND guild_id = ${id} AND type = ${ChannelType.TEXT}`;
        if (!c) throw badRequest('System channel must be a text channel in this server');
      }
      sets.system_channel_id = p.systemChannelId;
    }
    if (!Object.keys(sets).length) return serGuild(g);
    const [updated] = await ctx.sql<GuildRow[]>`UPDATE guilds SET ${ctx.sql(sets)} WHERE id = ${id} RETURNING *`;
    for (const f of toDelete) await deleteFile(ctx, f);
    await audit(ctx.sql, {
      guildId: id,
      actorId: auth.userId,
      action: AuditAction.GUILD_UPDATE,
      targetType: 'guild',
      targetId: id,
      changes: diff(g as unknown as Record<string, unknown>, sets),
    });
    ctx.bus.toGuild(id, 'GUILD_UPDATE', serGuild(updated!));
    return serGuild(updated!);
  });

  app.delete('/guilds/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const a = await guildAccess(ctx, id, auth.userId);
    if (!a.isOwner) throw forbidden('Only the owner can delete the server');
    await deleteGuild(ctx, id);
    return { ok: true };
  });

  app.post('/guilds/:id/transfer', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const body = parse(TransferGuildSchema, req.body);
    const a = await guildAccess(ctx, id, auth.userId);
    if (!a.isOwner) throw forbidden('Only the owner can transfer the server');
    const [me] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${auth.userId}`;
    if (!(await verifyPassword(me?.password_hash ?? null, body.password))) throw forbidden('Wrong password');
    const [m] = await ctx.sql`SELECT 1 FROM guild_members WHERE guild_id = ${id} AND user_id = ${body.userId}`;
    if (!m) throw badRequest('They must be a member of the server');
    const [g] = await ctx.sql<GuildRow[]>`UPDATE guilds SET owner_id = ${body.userId} WHERE id = ${id} RETURNING *`;
    await audit(ctx.sql, {
      guildId: id,
      actorId: auth.userId,
      action: AuditAction.GUILD_UPDATE,
      targetType: 'guild',
      targetId: id,
      changes: { ownerId: [auth.userId, body.userId] },
    });
    ctx.bus.toGuild(id, 'GUILD_UPDATE', serGuild(g!), { invalidate: true });
    ctx.bus.internalGuild(id, '_PERMS_CHANGED', { guildId: id });
    return serGuild(g!);
  });

  app.delete('/users/@me/guilds/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const a = await guildAccess(ctx, id, auth.userId);
    if (a.isOwner) throw forbidden('Transfer ownership or delete the server before leaving');
    await removeMember(ctx, id, auth.userId);
    return { ok: true };
  });

  // ---------- invites ----------

  app.post('/channels/:id/invites', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    await limitPreset(req, 'inviteCreate');
    const body = parse(CreateInviteSchema, req.body);
    const a = await requireChannelPerm(ctx, channelId, auth.userId, P.CREATE_INVITE);
    if (!a.channel.guild_id) throw badRequest('Invites are for server channels');
    const code = inviteCode();
    const expires = body.maxAgeSeconds > 0 ? new Date(Date.now() + body.maxAgeSeconds * 1000) : null;
    await ctx.sql`
      INSERT INTO invites (code, guild_id, channel_id, inviter_id, max_uses, expires_at)
      VALUES (${code}, ${a.channel.guild_id}, ${channelId}, ${auth.userId}, ${body.maxUses}, ${expires})`;
    await audit(ctx.sql, {
      guildId: a.channel.guild_id,
      actorId: auth.userId,
      action: AuditAction.INVITE_CREATE,
      targetType: 'invite',
      changes: { code, maxUses: body.maxUses, expiresAt: expires?.toISOString() ?? null },
    });
    return inviteObj(ctx, code);
  });

  app.get('/guilds/:id/invites', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_GUILD);
    const rows = await ctx.sql<{ code: string }[]>`SELECT code FROM invites WHERE guild_id = ${id} ORDER BY created_at DESC LIMIT 200`;
    const out = [];
    for (const r of rows) {
      const i = await inviteObj(ctx, r.code);
      if (i) out.push(i);
    }
    return out;
  });

  app.get('/invites/:code', async (req) => {
    await limitPreset(req, 'lookup', `ip:${req.ip}`);
    const code = strParam(req, 'code', 32);
    const i = await inviteObj(ctx, code);
    if (!i) throw notFound('This invite is invalid or has expired');
    return i;
  });

  app.post('/invites/:code', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'inviteJoin');
    const code = strParam(req, 'code', 32);
    const inv = await inviteObj(ctx, code);
    if (!inv) throw notFound('This invite is invalid or has expired');
    const guildId = inv.guild.id;
    const banned = await ctx.sql`SELECT 1 FROM bans WHERE guild_id = ${guildId} AND user_id = ${auth.userId}`;
    if (banned.length) throw forbidden("You're banned from this server");
    const already = await ctx.sql`SELECT 1 FROM guild_members WHERE guild_id = ${guildId} AND user_id = ${auth.userId}`;
    if (already.length) return { guildId, alreadyMember: true };
    const [{ count }] = (await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM guild_members WHERE user_id = ${auth.userId}`) as unknown as [{ count: number }];
    if (count >= Limits.GUILDS_PER_USER) throw forbidden(`You can be in at most ${Limits.GUILDS_PER_USER} servers`);

    await ctx.sql.begin(async (tx) => {
      const used = await tx`
        UPDATE invites SET uses = uses + 1
        WHERE code = ${code} AND (max_uses = 0 OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now())
        RETURNING code`;
      if (!used.length) throw notFound('This invite is invalid or has expired');
      await tx`INSERT INTO guild_members (guild_id, user_id) VALUES (${guildId}, ${auth.userId}) ON CONFLICT DO NOTHING`;
    });
    const m = await loadMember(ctx.sql, guildId, auth.userId);
    if (m) ctx.bus.toGuild(guildId, 'GUILD_MEMBER_ADD', m, { invalidate: true });
    ctx.bus.internalUser(auth.userId, '_GUILD_JOIN', { guildId });
    const [g] = await ctx.sql<GuildRow[]>`SELECT * FROM guilds WHERE id = ${guildId}`;
    if (g?.system_channel_id) {
      const [sc] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${g.system_channel_id}`;
      if (sc) await insertSystemMessage(ctx, sc, MessageType.MEMBER_JOIN, auth.userId, { userId: auth.userId });
    }
    await broadcastPresence(ctx, auth.userId, true);
    return { guildId, alreadyMember: false };
  });

  app.delete('/invites/:code', async (req) => {
    const auth = requireAuth(req);
    const code = strParam(req, 'code', 32);
    const [inv] = await ctx.sql<{ guild_id: string; inviter_id: string | null }[]>`SELECT guild_id, inviter_id FROM invites WHERE code = ${code}`;
    if (!inv) throw notFound('Invite not found');
    const a = await guildAccess(ctx, inv.guild_id, auth.userId);
    if (inv.inviter_id !== auth.userId && !has(a.perms, P.MANAGE_GUILD)) throw forbidden();
    await ctx.sql`DELETE FROM invites WHERE code = ${code}`;
    await audit(ctx.sql, { guildId: inv.guild_id, actorId: auth.userId, action: AuditAction.INVITE_DELETE, targetType: 'invite', changes: { code } });
    return { ok: true };
  });
}
