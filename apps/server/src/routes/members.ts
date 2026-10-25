import type { FastifyInstance } from 'fastify';
import {
  AuditAction,
  BanSchema,
  ChannelType,
  KickSchema,
  MemberPatchSchema,
  Permissions as P,
  SelfMemberPatchSchema,
  canActOn,
  canManageRole,
  has,
  highestPosition,
} from '@dbb/shared';
import type { UserRow } from '../rows.js';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { channelAccess, guildAccess, loadMember as loadMemberData, requireGuildPerm, type GuildAccess } from '../lib/perms.js';
import { loadMember, loadMembers, publicUser } from '../lib/serialize.js';
import { audit } from '../lib/audit.js';
import { claimFile, deleteFile, fileIdFromUrl, fileUrl } from './files.js';
import { removeMember } from './guilds.js';
import { hardDeleteMessages } from '../services/messages.js';
import { disconnectVoice, getServerMod, getUserVoice, roomName, setServerMod, setVoiceState, publishSources } from '../services/voice.js';
import type { Ctx } from '../context.js';

async function target(ctx: Ctx, a: GuildAccess, userId: string) {
  const m = await loadMemberData(ctx.sql, a.data.guild.id, userId);
  if (!m) throw notFound('Member not found');
  const highest = userId === a.data.guild.owner_id ? Number.MAX_SAFE_INTEGER : highestPosition(m.roles, a.data.roles);
  return { m, highest };
}

function assertHierarchy(a: GuildAccess, actorId: string, targetId: string, targetHighest: number) {
  if (!canActOn({ userId: actorId, highest: a.highest }, { userId: targetId, highest: targetHighest }, a.data.guild.owner_id)) {
    throw forbidden("You can't do that to someone with an equal or higher role");
  }
}

async function pushMember(ctx: Ctx, guildId: string, userId: string, permsChanged: boolean) {
  const m = await loadMember(ctx.sql, guildId, userId);
  if (m) ctx.bus.toGuild(guildId, 'GUILD_MEMBER_UPDATE', m, { invalidate: permsChanged });
  if (permsChanged) ctx.bus.internalGuild(guildId, '_PERMS_CHANGED', { guildId, userId });
  return m;
}

export default async function memberRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/guilds/:id/members', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await guildAccess(ctx, id, auth.userId);
    return loadMembers(ctx.sql, id);
  });

  app.get('/guilds/:id/members/:userId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await guildAccess(ctx, id, auth.userId);
    const m = await loadMember(ctx.sql, id, idParam(req, 'userId'));
    if (!m) throw notFound('Member not found');
    return m;
  });

  app.patch('/guilds/:id/members/@me', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await limitPreset(req, 'profile');
    const p = parse(SelfMemberPatchSchema, req.body);
    const a = await guildAccess(ctx, id, auth.userId);
    const [cur] = await ctx.sql<{ avatar: string | null }[]>`SELECT avatar FROM guild_members WHERE guild_id = ${id} AND user_id = ${auth.userId}`;
    const sets: Record<string, unknown> = {};
    if (p.nickname !== undefined) {
      if (!has(a.perms, P.CHANGE_NICKNAME)) throw forbidden("You can't change your nickname here");
      sets.nickname = p.nickname || null;
    }
    if (p.bio !== undefined) sets.bio = p.bio;
    let oldAvatar: string | null = null;
    if (p.avatarFileId !== undefined && p.avatarFileId !== fileIdFromUrl(cur?.avatar)) {
      sets.avatar = p.avatarFileId ? fileUrl(await claimFile(ctx, p.avatarFileId, auth.userId, ['member_avatar', 'avatar'])) : null;
      oldAvatar = cur?.avatar ?? null;
    }
    if (Object.keys(sets).length) {
      await ctx.sql`UPDATE guild_members SET ${ctx.sql(sets)} WHERE guild_id = ${id} AND user_id = ${auth.userId}`;
      await deleteFile(ctx, oldAvatar);
    }
    return pushMember(ctx, id, auth.userId, false);
  });

  app.patch('/guilds/:id/members/:userId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    await limitPreset(req, 'modAction');
    const p = parse(MemberPatchSchema, req.body);
    const a = await guildAccess(ctx, id, auth.userId);
    const t = await target(ctx, a, userId);
    const self = userId === auth.userId;
    let permsChanged = false;

    if (p.nickname !== undefined) {
      if (self) {
        if (!has(a.perms, P.CHANGE_NICKNAME) && !has(a.perms, P.MANAGE_NICKNAMES)) throw forbidden();
      } else {
        if (!has(a.perms, P.MANAGE_NICKNAMES)) throw forbidden();
        assertHierarchy(a, auth.userId, userId, t.highest);
      }
      await ctx.sql`UPDATE guild_members SET nickname = ${p.nickname || null} WHERE guild_id = ${id} AND user_id = ${userId}`;
      if (!self) {
        await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_UPDATE, targetType: 'user', targetId: userId, changes: { nickname: p.nickname }, reason: p.reason });
      }
    }

    if (p.roles !== undefined) {
      if (!has(a.perms, P.MANAGE_ROLES)) throw forbidden();
      const wanted = new Set(p.roles.filter((r) => r !== id));
      for (const r of wanted) if (!a.data.roles.has(r)) throw badRequest('Unknown role');
      const current = new Set(t.m.roles);
      const added = [...wanted].filter((r) => !current.has(r));
      const removed = [...current].filter((r) => !wanted.has(r));
      for (const r of [...added, ...removed]) {
        if (!canManageRole(a.highest, a.data.roles.get(r)!.position, a.isOwner)) throw forbidden("You can't assign roles at or above your highest role");
      }
      if (!self && !a.isOwner && (added.length || removed.length)) assertHierarchy(a, auth.userId, userId, t.highest);
      await ctx.sql.begin(async (tx) => {
        if (removed.length) await tx`DELETE FROM member_roles WHERE guild_id = ${id} AND user_id = ${userId} AND role_id = ANY(${removed}::bigint[])`;
        for (const r of added) await tx`INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (${id}, ${userId}, ${r}) ON CONFLICT DO NOTHING`;
      });
      if (added.length || removed.length) {
        permsChanged = true;
        await audit(ctx.sql, {
          guildId: id,
          actorId: auth.userId,
          action: AuditAction.MEMBER_ROLE_UPDATE,
          targetType: 'user',
          targetId: userId,
          changes: { added, removed },
          reason: p.reason,
        });
      }
    }

    if (p.timeoutSeconds !== undefined) {
      if (!has(a.perms, P.MODERATE_MEMBERS)) throw forbidden();
      assertHierarchy(a, auth.userId, userId, t.highest);
      const targetAccess = await guildAccess(ctx, id, userId);
      if (has(targetAccess.perms, P.ADMINISTRATOR)) throw forbidden("Admins can't be timed out");
      const until = p.timeoutSeconds > 0 ? new Date(Date.now() + p.timeoutSeconds * 1000) : null;
      await ctx.sql`UPDATE guild_members SET timeout_until = ${until} WHERE guild_id = ${id} AND user_id = ${userId}`;
      permsChanged = true;
      await audit(ctx.sql, {
        guildId: id,
        actorId: auth.userId,
        action: AuditAction.MEMBER_TIMEOUT,
        targetType: 'user',
        targetId: userId,
        changes: { timeoutUntil: until?.toISOString() ?? null },
        reason: p.reason,
      });
      if (until) {
        const vs = await getUserVoice(ctx, userId);
        if (vs?.guildId === id) await disconnectVoice(ctx, userId);
      }
    }

    if (p.mute !== undefined || p.deaf !== undefined) {
      if (p.mute !== undefined && !has(a.perms, P.MUTE_MEMBERS)) throw forbidden();
      if (p.deaf !== undefined && !has(a.perms, P.DEAFEN_MEMBERS)) throw forbidden();
      if (!self) assertHierarchy(a, auth.userId, userId, t.highest);
      const mod = await getServerMod(ctx, id, userId);
      const next = { mute: p.mute ?? mod.mute, deaf: p.deaf ?? mod.deaf };
      await setServerMod(ctx, id, userId, next);
      const vs = await getUserVoice(ctx, userId);
      if (vs?.guildId === id) {
        await setVoiceState(ctx, { ...vs, serverMute: next.mute, serverDeaf: next.deaf });
        if (ctx.voice) {
          const ca = await channelAccess(ctx, vs.channelId, userId).catch(() => null);
          const canSpeak = !!ca && has(ca.perms, P.SPEAK) && !next.mute;
          const canStream = !!ca && has(ca.perms, P.STREAM);
          await ctx.voice.rooms
            .updateParticipant(roomName(vs.channelId), userId, {
              permission: {
                canSubscribe: !next.deaf,
                canPublish: canSpeak || canStream,
                canPublishData: true,
                canPublishSources: publishSources(canSpeak, canStream),
              },
            })
            .catch((e: Error) => ctx.log.warn({ err: e }, 'livekit updateParticipant failed'));
        }
      }
      await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_VOICE_UPDATE, targetType: 'user', targetId: userId, changes: next, reason: p.reason });
    }

    if (p.voiceChannelId !== undefined) {
      if (!has(a.perms, P.MOVE_MEMBERS)) throw forbidden();
      if (!self) assertHierarchy(a, auth.userId, userId, t.highest);
      const vs = await getUserVoice(ctx, userId);
      if (!vs || vs.guildId !== id) throw badRequest("They aren't in a voice channel here");
      if (p.voiceChannelId === null) {
        await disconnectVoice(ctx, userId);
        ctx.bus.toUser(userId, 'VOICE_MOVE', { guildId: id, channelId: null });
        await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_VOICE_DISCONNECT, targetType: 'user', targetId: userId, reason: p.reason });
      } else {
        const dest = await channelAccess(ctx, p.voiceChannelId, auth.userId);
        if (dest.channel.type !== ChannelType.VOICE || dest.channel.guild_id !== id) throw badRequest('Pick a voice channel in this server');
        if (!has(dest.perms, P.CONNECT)) throw forbidden("You can't connect to that channel yourself");
        // lets the moved user join the destination even without CONNECT there
        await ctx.redis.set(`vmove:${userId}`, p.voiceChannelId, 'EX', 60);
        ctx.bus.toUser(userId, 'VOICE_MOVE', { guildId: id, channelId: p.voiceChannelId });
        await audit(ctx.sql, {
          guildId: id,
          actorId: auth.userId,
          action: AuditAction.MEMBER_VOICE_MOVE,
          targetType: 'user',
          targetId: userId,
          changes: { from: vs.channelId, to: p.voiceChannelId },
          reason: p.reason,
        });
      }
    }

    return pushMember(ctx, id, userId, permsChanged);
  });

  app.put('/guilds/:id/members/:userId/roles/:roleId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    const roleId = idParam(req, 'roleId');
    await limitPreset(req, 'modAction');
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_ROLES);
    const role = a.data.roles.get(roleId);
    if (!role || roleId === id) throw notFound('Role not found');
    if (!canManageRole(a.highest, role.position, a.isOwner)) throw forbidden("You can't assign roles at or above your highest role");
    await target(ctx, a, userId);
    await ctx.sql`INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (${id}, ${userId}, ${roleId}) ON CONFLICT DO NOTHING`;
    await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_ROLE_UPDATE, targetType: 'user', targetId: userId, changes: { added: [roleId] } });
    return pushMember(ctx, id, userId, true);
  });

  app.delete('/guilds/:id/members/:userId/roles/:roleId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    const roleId = idParam(req, 'roleId');
    await limitPreset(req, 'modAction');
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_ROLES);
    const role = a.data.roles.get(roleId);
    if (!role || roleId === id) throw notFound('Role not found');
    if (!canManageRole(a.highest, role.position, a.isOwner)) throw forbidden("You can't remove roles at or above your highest role");
    const t = await target(ctx, a, userId);
    if (userId !== auth.userId && !a.isOwner && t.highest >= a.highest) throw forbidden("You can't take roles from someone with an equal or higher role");
    await ctx.sql`DELETE FROM member_roles WHERE guild_id = ${id} AND user_id = ${userId} AND role_id = ${roleId}`;
    await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_ROLE_UPDATE, targetType: 'user', targetId: userId, changes: { removed: [roleId] } });
    return pushMember(ctx, id, userId, true);
  });

  app.delete('/guilds/:id/members/:userId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    await limitPreset(req, 'modAction');
    const { reason } = parse(KickSchema, req.body ?? {});
    const a = await requireGuildPerm(ctx, id, auth.userId, P.KICK_MEMBERS);
    const t = await target(ctx, a, userId);
    assertHierarchy(a, auth.userId, userId, t.highest);
    await removeMember(ctx, id, userId);
    await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_KICK, targetType: 'user', targetId: userId, reason });
    return { ok: true };
  });

  // ---------- bans ----------

  app.get('/guilds/:id/bans', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await requireGuildPerm(ctx, id, auth.userId, P.BAN_MEMBERS);
    const rows = await ctx.sql<(UserRow & { reason: string | null; banned_at: Date })[]>`
      SELECT u.*, b.reason, b.created_at AS banned_at FROM bans b JOIN users u ON u.id = b.user_id
      WHERE b.guild_id = ${id} ORDER BY b.created_at DESC LIMIT 1000`;
    return rows.map((r) => ({ user: publicUser(r), reason: r.reason, createdAt: r.banned_at.toISOString() }));
  });

  app.put('/guilds/:id/bans/:userId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    await limitPreset(req, 'modAction');
    const body = parse(BanSchema, req.body ?? {});
    const a = await requireGuildPerm(ctx, id, auth.userId, P.BAN_MEMBERS);
    if (userId === auth.userId) throw badRequest("You can't ban yourself");
    if (userId === a.data.guild.owner_id) throw forbidden("You can't ban the owner");
    const [u] = await ctx.sql`SELECT 1 FROM users WHERE id = ${userId}`;
    if (!u) throw notFound('User not found');
    const isMember = await loadMemberData(ctx.sql, id, userId);
    if (isMember) {
      const t = await target(ctx, a, userId);
      assertHierarchy(a, auth.userId, userId, t.highest);
    }
    await ctx.sql`
      INSERT INTO bans (guild_id, user_id, reason, banned_by) VALUES (${id}, ${userId}, ${body.reason ?? null}, ${auth.userId})
      ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = EXCLUDED.reason, banned_by = EXCLUDED.banned_by`;
    if (isMember) await removeMember(ctx, id, userId);
    if (body.deleteMessageSeconds > 0) {
      const since = new Date(Date.now() - body.deleteMessageSeconds * 1000);
      const msgs = await ctx.sql<{ id: string; channel_id: string }[]>`
        SELECT id, channel_id FROM messages WHERE guild_id = ${id} AND author_id = ${userId} AND created_at > ${since} LIMIT 5000`;
      const byChannel = new Map<string, string[]>();
      for (const m of msgs) byChannel.set(m.channel_id, [...(byChannel.get(m.channel_id) ?? []), m.id]);
      await hardDeleteMessages(ctx, msgs.map((m) => m.id));
      for (const [channelId, ids] of byChannel) {
        const [c] = await ctx.sql<{ type: number; parent_id: string | null }[]>`SELECT type, parent_id FROM channels WHERE id = ${channelId}`;
        const viewId = c?.type === ChannelType.THREAD && c.parent_id ? c.parent_id : channelId;
        ctx.bus.toGuild(id, 'MESSAGE_DELETE_BULK', { ids, channelId, guildId: id }, { channelId: viewId });
      }
    }
    await audit(ctx.sql, {
      guildId: id,
      actorId: auth.userId,
      action: AuditAction.MEMBER_BAN,
      targetType: 'user',
      targetId: userId,
      changes: { deleteMessageSeconds: body.deleteMessageSeconds },
      reason: body.reason,
    });
    return { ok: true };
  });

  app.delete('/guilds/:id/bans/:userId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    await limitPreset(req, 'modAction');
    await requireGuildPerm(ctx, id, auth.userId, P.BAN_MEMBERS);
    const rows = await ctx.sql`DELETE FROM bans WHERE guild_id = ${id} AND user_id = ${userId} RETURNING user_id`;
    if (!rows.length) throw notFound('Not banned');
    await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.MEMBER_UNBAN, targetType: 'user', targetId: userId });
    return { ok: true };
  });
}
