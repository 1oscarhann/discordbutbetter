import type { FastifyInstance } from 'fastify';
import {
  AuditAction,
  CHANNEL_PERMISSIONS,
  ChannelPatchSchema,
  ChannelType,
  CreateChannelSchema,
  Limits,
  MessageType,
  OverwriteSchema,
  Permissions as P,
  PositionsSchema,
  has,
  isDmType,
  missingForGrant,
  permissionNames,
} from '@haunt/shared';
import type { ChannelRow, OverwriteRow } from '../rows.js';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { channelAccess, requireGuildPerm, type ChannelAccess } from '../lib/perms.js';
import { loadChannel, loadChannelById } from '../lib/serialize.js';
import { audit, diff } from '../lib/audit.js';
import { snowflake } from '../ids.js';
import { claimFile, deleteFile, fileIdFromUrl, fileUrl } from './files.js';
import { insertSystemMessage } from '../services/messages.js';
import { participantsIn, disconnectVoice } from '../services/voice.js';
import { removeFromGroup } from './relationships.js';
import { toChannel } from '../lib/fanout.js';
import type { Ctx } from '../context.js';

function normaliseName(type: number, name: string): string {
  if (type === ChannelType.TEXT || type === ChannelType.WIKI) {
    return name.toLowerCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'channel';
  }
  return name;
}

async function deleteChannelFiles(ctx: Ctx, channelIds: string[]) {
  for (;;) {
    const files = await ctx.sql<{ file_id: string }[]>`
      SELECT a.file_id FROM message_attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.channel_id = ANY(${channelIds}::bigint[]) LIMIT 500`;
    if (!files.length) return;
    for (const f of files) await deleteFile(ctx, f.file_id);
  }
}

async function publishChannelUpdate(ctx: Ctx, c: ChannelRow, permsChanged: boolean) {
  const ch = await loadChannel(ctx.sql, c);
  if (isDmType(c.type)) {
    const rec = (await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM dm_recipients WHERE channel_id = ${c.id}`).map((r) => r.user_id);
    ctx.bus.toUsers(rec, 'CHANNEL_UPDATE', ch);
  } else if (c.type === ChannelType.THREAD) {
    await toChannel(ctx, c, 'THREAD_UPDATE', ch);
  } else if (c.guild_id) {
    ctx.bus.toGuild(c.guild_id, 'CHANNEL_UPDATE', ch, { invalidate: true });
    if (permsChanged) ctx.bus.internalGuild(c.guild_id, '_PERMS_CHANGED', { guildId: c.guild_id });
  }
  return ch;
}

export default async function channelRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post('/guilds/:id/channels', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const body = parse(CreateChannelSchema, req.body);
    const a = await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_CHANNELS);
    const [{ count }] = (await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM channels WHERE guild_id = ${guildId} AND type <> ${ChannelType.THREAD}`) as unknown as [{ count: number }];
    if (count >= Limits.CHANNELS_PER_GUILD) throw forbidden('Channel limit reached');

    let parent: ChannelRow | null = null;
    if (body.parentId) {
      if (body.type === ChannelType.CATEGORY) throw badRequest("Categories can't be nested");
      [parent] = (await ctx.sql<ChannelRow[]>`
        SELECT * FROM channels WHERE id = ${body.parentId} AND guild_id = ${guildId} AND type = ${ChannelType.CATEGORY}`) as unknown as [ChannelRow];
      if (!parent) throw badRequest('Category not found');
    }
    const id = snowflake();
    const [{ pos }] = (await ctx.sql<{ pos: number }[]>`
      SELECT COALESCE(max(position) + 1, 0)::int AS pos FROM channels
      WHERE guild_id = ${guildId} AND parent_id IS NOT DISTINCT FROM ${parent?.id ?? null}::bigint AND type <> ${ChannelType.THREAD}`) as unknown as [{ pos: number }];

    await ctx.sql.begin(async (tx) => {
      await tx`
        INSERT INTO channels (id, type, guild_id, parent_id, name, topic, position, user_limit, slowmode)
        VALUES (${id}, ${body.type}, ${guildId}, ${parent?.id ?? null}, ${normaliseName(body.type, body.name)}, ${body.topic ?? null},
                ${pos}, ${body.userLimit ?? 0}, ${body.slowmode ?? 0})`;
      if (body.private) {
        await tx`INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny) VALUES (${id}, ${guildId}, 0, 0, ${P.VIEW_CHANNEL.toString()})`;
        if (!a.isOwner && !has(a.perms, P.ADMINISTRATOR)) {
          await tx`
            INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny)
            VALUES (${id}, ${auth.userId}, 1, ${(P.VIEW_CHANNEL | P.MANAGE_CHANNELS | P.MANAGE_ROLES).toString()}, 0)`;
        }
      } else if (parent) {
        // new channels start in sync with their category
        await tx`
          INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny)
          SELECT ${id}, target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = ${parent.id}`;
      }
    });
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${id}`;
    const ch = await loadChannel(ctx.sql, c!);
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.CHANNEL_CREATE, targetType: 'channel', targetId: id, changes: { name: ch.name, type: ch.type } });
    ctx.bus.toGuild(guildId, 'CHANNEL_CREATE', ch, { invalidate: true });
    return ch;
  });

  app.patch('/guilds/:id/channels', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const moves = parse(PositionsSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_CHANNELS);
    const chans = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE guild_id = ${guildId} AND type <> ${ChannelType.THREAD}`;
    const byId = new Map(chans.map((c) => [c.id, c]));
    for (const m of moves) {
      const c = byId.get(m.id);
      if (!c) throw badRequest('Unknown channel');
      if (m.parentId !== undefined && m.parentId !== null) {
        const p = byId.get(m.parentId);
        if (!p || p.type !== ChannelType.CATEGORY || c.type === ChannelType.CATEGORY) throw badRequest('Bad category');
      }
    }
    const changed: string[] = [];
    await ctx.sql.begin(async (tx) => {
      for (const m of moves) {
        const c = byId.get(m.id)!;
        const parentId = m.parentId === undefined ? c.parent_id : m.parentId;
        if (c.position === m.position && c.parent_id === parentId) continue;
        await tx`UPDATE channels SET position = ${m.position}, parent_id = ${parentId} WHERE id = ${m.id}`;
        changed.push(m.id);
      }
    });
    for (const id of changed) {
      const ch = await loadChannelById(ctx.sql, id);
      if (ch) ctx.bus.toGuild(guildId, 'CHANNEL_UPDATE', ch, { invalidate: true });
    }
    return { ok: true, changed: changed.length };
  });

  app.get('/channels/:id', async (req) => {
    const auth = requireAuth(req);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    return { ...(await loadChannel(ctx.sql, a.channel)), permissions: a.perms.toString() };
  });

  app.patch('/channels/:id', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const p = parse(ChannelPatchSchema, req.body);
    const a = await channelAccess(ctx, channelId, auth.userId);
    const c = a.channel;
    const sets: Record<string, unknown> = {};

    if (isDmType(c.type)) {
      if (p.disappearingSeconds !== undefined && p.disappearingSeconds !== c.disappearing_seconds) {
        sets.disappearing_seconds = p.disappearingSeconds;
      }
      if (c.type === ChannelType.GROUP_DM) {
        if (p.name !== undefined) sets.name = p.name;
        if (p.iconFileId !== undefined && p.iconFileId !== fileIdFromUrl(c.icon)) {
          sets.icon = p.iconFileId ? fileUrl(await claimFile(ctx, p.iconFileId, auth.userId, ['group_icon'])) : null;
          await deleteFile(ctx, c.icon);
        }
      }
      if (!Object.keys(sets).length) return loadChannel(ctx.sql, c);
      const [u] = await ctx.sql<ChannelRow[]>`UPDATE channels SET ${ctx.sql(sets)} WHERE id = ${channelId} RETURNING *`;
      if (sets.disappearing_seconds !== undefined) {
        await insertSystemMessage(ctx, u!, MessageType.DISAPPEARING_CHANGED, auth.userId, { seconds: p.disappearingSeconds });
      }
      if (sets.name !== undefined) await insertSystemMessage(ctx, u!, MessageType.CHANNEL_NAME_CHANGE, auth.userId, { name: p.name });
      if (sets.icon !== undefined) await insertSystemMessage(ctx, u!, MessageType.CHANNEL_ICON_CHANGE, auth.userId, null);
      return publishChannelUpdate(ctx, u!, false);
    }

    if (c.type === ChannelType.THREAD) {
      const isOwner = c.owner_id === auth.userId;
      const canManage = has(a.perms, P.MANAGE_THREADS);
      if (p.name !== undefined || p.archived !== undefined || p.autoArchiveMinutes !== undefined) {
        if (!isOwner && !canManage) throw forbidden();
        if (c.locked && !canManage) throw forbidden('This thread is locked');
      }
      if (p.locked !== undefined && !canManage) throw forbidden();
      if (p.name !== undefined) sets.name = p.name;
      if (p.archived !== undefined) {
        sets.archived = p.archived;
        sets.archived_at = p.archived ? new Date() : null;
      }
      if (p.locked !== undefined) sets.locked = p.locked;
      if (p.autoArchiveMinutes !== undefined) sets.auto_archive_minutes = p.autoArchiveMinutes;
      if (p.slowmode !== undefined) {
        if (!canManage) throw forbidden();
        sets.slowmode = p.slowmode;
      }
      if (!Object.keys(sets).length) return loadChannel(ctx.sql, c);
      const [u] = await ctx.sql<ChannelRow[]>`UPDATE channels SET ${ctx.sql(sets)} WHERE id = ${channelId} RETURNING *`;
      if (canManage && !isOwner) {
        await audit(ctx.sql, { guildId: c.guild_id!, actorId: auth.userId, action: AuditAction.THREAD_UPDATE, targetType: 'channel', targetId: c.id, changes: diff(c as never, sets) });
      }
      return publishChannelUpdate(ctx, u!, false);
    }

    // guild channel
    if (!has(a.perms, P.MANAGE_CHANNELS)) throw forbidden();
    if (p.name !== undefined) sets.name = normaliseName(c.type, p.name);
    if (p.topic !== undefined) sets.topic = p.topic;
    if (p.position !== undefined) sets.position = p.position;
    if (p.slowmode !== undefined) sets.slowmode = p.slowmode;
    if (p.userLimit !== undefined) {
      if (c.type !== ChannelType.VOICE) throw badRequest('Only voice channels have a user limit');
      sets.user_limit = p.userLimit;
    }
    if (p.parentId !== undefined) {
      if (c.type === ChannelType.CATEGORY && p.parentId) throw badRequest("Categories can't be nested");
      if (p.parentId) {
        const [cat] = await ctx.sql`SELECT 1 FROM channels WHERE id = ${p.parentId} AND guild_id = ${c.guild_id} AND type = ${ChannelType.CATEGORY}`;
        if (!cat) throw badRequest('Category not found');
      }
      sets.parent_id = p.parentId;
    }
    if (!Object.keys(sets).length) return loadChannel(ctx.sql, c);
    const [u] = await ctx.sql<ChannelRow[]>`UPDATE channels SET ${ctx.sql(sets)} WHERE id = ${channelId} RETURNING *`;
    await audit(ctx.sql, { guildId: c.guild_id!, actorId: auth.userId, action: AuditAction.CHANNEL_UPDATE, targetType: 'channel', targetId: c.id, changes: diff(c as never, sets) });
    return publishChannelUpdate(ctx, u!, false);
  });

  app.delete('/channels/:id', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const a = await channelAccess(ctx, channelId, auth.userId);
    const c = a.channel;

    if (c.type === ChannelType.DM) {
      await ctx.sql`UPDATE dm_recipients SET open = false WHERE channel_id = ${c.id} AND user_id = ${auth.userId}`;
      ctx.bus.toUser(auth.userId, 'CHANNEL_DELETE', { id: c.id, guildId: null });
      return { ok: true };
    }
    if (c.type === ChannelType.GROUP_DM) {
      await removeFromGroup(ctx, c, auth.userId, auth.userId);
      return { ok: true };
    }
    if (c.type === ChannelType.THREAD) {
      if (!has(a.perms, P.MANAGE_THREADS)) throw forbidden();
      await deleteChannelFiles(ctx, [c.id]);
      await ctx.sql`UPDATE messages SET thread_id = NULL WHERE thread_id = ${c.id}`;
      await ctx.sql`DELETE FROM channels WHERE id = ${c.id}`;
      await audit(ctx.sql, { guildId: c.guild_id!, actorId: auth.userId, action: AuditAction.THREAD_DELETE, targetType: 'channel', targetId: c.id, changes: { name: c.name } });
      await toChannel(ctx, c, 'THREAD_DELETE', { id: c.id, guildId: c.guild_id!, parentId: c.parent_id! });
      return { ok: true };
    }

    if (!has(a.perms, P.MANAGE_CHANNELS)) throw forbidden();
    const threads = await ctx.sql<{ id: string }[]>`SELECT id FROM channels WHERE parent_id = ${c.id} AND type = ${ChannelType.THREAD}`;
    if (c.type === ChannelType.VOICE && c.guild_id) {
      for (const vs of await participantsIn(ctx, c.guild_id, c.id)) await disconnectVoice(ctx, vs.userId);
      await ctx.redis.del(`watch:${c.id}`);
    }
    await deleteChannelFiles(ctx, [c.id, ...threads.map((t) => t.id)]);
    await ctx.sql.begin(async (tx) => {
      if (threads.length) await tx`DELETE FROM channels WHERE id = ANY(${threads.map((t) => t.id)}::bigint[])`;
      await tx`DELETE FROM channels WHERE id = ${c.id}`;
      await tx`UPDATE guilds SET system_channel_id = NULL WHERE system_channel_id = ${c.id}`;
      await tx`UPDATE guilds SET levels_channel_id = NULL WHERE levels_channel_id = ${c.id}`;
    });
    await audit(ctx.sql, { guildId: c.guild_id!, actorId: auth.userId, action: AuditAction.CHANNEL_DELETE, targetType: 'channel', targetId: c.id, changes: { name: c.name } });
    // children of a deleted category move to the top level
    if (c.type === ChannelType.CATEGORY) {
      const kids = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE guild_id = ${c.guild_id} AND parent_id IS NULL AND type <> ${ChannelType.THREAD}`;
      for (const k of kids) ctx.bus.toGuild(c.guild_id!, 'CHANNEL_UPDATE', await loadChannel(ctx.sql, k), { invalidate: true });
    }
    ctx.bus.toGuild(c.guild_id!, 'CHANNEL_DELETE', { id: c.id, guildId: c.guild_id }, { invalidate: true });
    return { ok: true };
  });

  // ---------- permission overwrites ----------

  async function overwriteAccess(channelId: string, userId: string): Promise<ChannelAccess> {
    const a = await channelAccess(ctx, channelId, userId);
    if (!a.channel.guild_id || a.channel.type === ChannelType.THREAD) throw badRequest('This channel has no permission settings');
    if (!has(a.perms, P.MANAGE_ROLES) && !has(a.perms, P.ADMINISTRATOR)) throw forbidden();
    return a;
  }

  app.put('/channels/:id/permissions/:targetId', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    const targetId = idParam(req, 'targetId');
    await limitPreset(req, 'modAction');
    const body = parse(OverwriteSchema, req.body);
    const a = await overwriteAccess(channelId, auth.userId);
    const guildId = a.channel.guild_id!;
    const allow = BigInt(body.allow);
    const deny = BigInt(body.deny);
    if ((allow | deny) & ~CHANNEL_PERMISSIONS) throw badRequest('Those permissions can only be set on roles, not channels');
    if (allow & deny) throw badRequest('A permission cannot be both allowed and denied');
    if (body.type === 0) {
      const [r] = await ctx.sql`SELECT 1 FROM roles WHERE id = ${targetId} AND guild_id = ${guildId}`;
      if (!r) throw badRequest('Role not found');
    } else {
      const [m] = await ctx.sql`SELECT 1 FROM guild_members WHERE user_id = ${targetId} AND guild_id = ${guildId}`;
      if (!m) throw badRequest('Member not found');
    }
    const [old] = await ctx.sql<OverwriteRow[]>`SELECT * FROM permission_overwrites WHERE channel_id = ${channelId} AND target_id = ${targetId}`;
    if (!a.guild!.isOwner) {
      // you can only change bits you have in this channel
      const changed = (allow ^ BigInt(old?.allow ?? 0)) | (deny ^ BigInt(old?.deny ?? 0));
      const missing = missingForGrant(a.perms, changed);
      if (missing) throw forbidden(`You can't change permissions you don't have: ${permissionNames(missing).join(', ')}`);
    }
    await ctx.sql`
      INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny)
      VALUES (${channelId}, ${targetId}, ${body.type}, ${allow.toString()}, ${deny.toString()})
      ON CONFLICT (channel_id, target_id) DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, target_type = EXCLUDED.target_type`;
    await audit(ctx.sql, {
      guildId,
      actorId: auth.userId,
      action: AuditAction.OVERWRITE_UPDATE,
      targetType: 'channel',
      targetId: channelId,
      changes: { target: targetId, targetType: body.type, allow: permissionNames(allow), deny: permissionNames(deny) },
    });
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId}`;
    return publishChannelUpdate(ctx, c!, true);
  });

  app.delete('/channels/:id/permissions/:targetId', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    const targetId = idParam(req, 'targetId');
    await limitPreset(req, 'modAction');
    const a = await overwriteAccess(channelId, auth.userId);
    const [old] = await ctx.sql<OverwriteRow[]>`SELECT * FROM permission_overwrites WHERE channel_id = ${channelId} AND target_id = ${targetId}`;
    if (!old) throw notFound('No overwrite for that');
    if (!a.guild!.isOwner) {
      const missing = missingForGrant(a.perms, BigInt(old.allow) | BigInt(old.deny));
      if (missing) throw forbidden(`You can't change permissions you don't have: ${permissionNames(missing).join(', ')}`);
    }
    await ctx.sql`DELETE FROM permission_overwrites WHERE channel_id = ${channelId} AND target_id = ${targetId}`;
    await audit(ctx.sql, { guildId: a.channel.guild_id!, actorId: auth.userId, action: AuditAction.OVERWRITE_DELETE, targetType: 'channel', targetId: channelId, changes: { target: targetId } });
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId}`;
    return publishChannelUpdate(ctx, c!, true);
  });

  app.post('/channels/:id/sync-permissions', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const a = await overwriteAccess(channelId, auth.userId);
    if (!a.channel.parent_id) throw badRequest('This channel is not in a category');
    if (!a.guild!.isOwner && !has(a.perms, P.ADMINISTRATOR)) {
      // syncing could hand out anything the category has; require the actor to hold all of it
      const cat = await ctx.sql<OverwriteRow[]>`SELECT * FROM permission_overwrites WHERE channel_id = ${a.channel.parent_id}`;
      const all = cat.reduce((acc, o) => acc | BigInt(o.allow) | BigInt(o.deny), 0n);
      const missing = missingForGrant(a.perms, all);
      if (missing) throw forbidden(`You can't sync permissions you don't have: ${permissionNames(missing).join(', ')}`);
    }
    await ctx.sql.begin(async (tx) => {
      await tx`DELETE FROM permission_overwrites WHERE channel_id = ${channelId}`;
      await tx`
        INSERT INTO permission_overwrites (channel_id, target_id, target_type, allow, deny)
        SELECT ${channelId}, target_id, target_type, allow, deny FROM permission_overwrites WHERE channel_id = ${a.channel.parent_id}`;
    });
    await audit(ctx.sql, { guildId: a.channel.guild_id!, actorId: auth.userId, action: AuditAction.OVERWRITE_UPDATE, targetType: 'channel', targetId: channelId, changes: { synced: true } });
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId}`;
    return publishChannelUpdate(ctx, c!, true);
  });
}
