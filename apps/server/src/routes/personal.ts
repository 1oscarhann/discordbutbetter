import type { FastifyInstance } from 'fastify';
import {
  BookmarkFolderSchema,
  BookmarkPutSchema,
  ChannelNotificationPatchSchema,
  GuildNotificationPatchSchema,
  Limits,
  MessageFlags,
  Permissions as P,
  ScheduleMessageSchema,
  ScheduledPatchSchema,
  has,
  type Bookmark,
  type ScheduledMessage,
} from '@haunt/shared';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { assertCanSend, channelAccess, guildAccess } from '../lib/perms.js';
import { queryMessages } from '../lib/serialize.js';
import { snowflake } from '../ids.js';
import { claimFile, deleteFile, fileUrl } from './files.js';
import type { Ctx } from '../context.js';

interface ScheduledRow {
  id: string;
  user_id: string;
  channel_id: string;
  content: string;
  flags: number;
  reply_to_id: string | null;
  reply_ping: boolean;
  attachments: { fileId: string; spoiler: boolean; description?: string }[];
  send_at: Date;
  error: string | null;
  created_at: Date;
}

export async function scheduledObj(ctx: Ctx, r: ScheduledRow): Promise<ScheduledMessage> {
  const ids = r.attachments.map((a) => a.fileId);
  const files = ids.length
    ? await ctx.sql<{ id: string; secret: string; filename: string; content_type: string; size: string; width: number | null; height: number | null; duration_ms: number | null }[]>`
        SELECT id, secret, filename, content_type, size, width, height, duration_ms FROM files WHERE id = ANY(${ids}::bigint[])`
    : [];
  const byId = new Map(files.map((f) => [f.id, f]));
  return {
    id: r.id,
    channelId: r.channel_id,
    content: r.content,
    flags: r.flags,
    replyToId: r.reply_to_id,
    attachments: r.attachments
      .map((a) => {
        const f = byId.get(a.fileId);
        return f
          ? {
              id: f.id,
              filename: f.filename,
              contentType: f.content_type,
              size: Number(f.size),
              url: fileUrl(f),
              width: f.width,
              height: f.height,
              durationMs: f.duration_ms,
              spoiler: a.spoiler,
              description: a.description ?? null,
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x),
    sendAt: r.send_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    error: r.error,
  };
}

export default async function personalRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // ---------- notification settings ----------

  const muteUntil = (s: number | null | undefined) =>
    s === undefined ? undefined : s === null ? null : s === -1 ? new Date('9999-12-31T00:00:00Z') : new Date(Date.now() + s * 1000);

  app.patch('/users/@me/guilds/:id/notifications', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const p = parse(GuildNotificationPatchSchema, req.body);
    await guildAccess(ctx, guildId, auth.userId);
    const mu = muteUntil(p.muteSeconds);
    const [r] = await ctx.sql<{ guild_id: string; level: number; suppress_everyone: boolean; suppress_roles: boolean; muted_until: Date | null }[]>`
      INSERT INTO guild_notification_settings (user_id, guild_id, level, suppress_everyone, suppress_roles, muted_until)
      VALUES (${auth.userId}, ${guildId}, ${p.level ?? 1}, ${p.suppressEveryone ?? false}, ${p.suppressRoles ?? false}, ${mu ?? null})
      ON CONFLICT (user_id, guild_id) DO UPDATE SET
        level = COALESCE(${p.level ?? null}::smallint, guild_notification_settings.level),
        suppress_everyone = COALESCE(${p.suppressEveryone ?? null}::boolean, guild_notification_settings.suppress_everyone),
        suppress_roles = COALESCE(${p.suppressRoles ?? null}::boolean, guild_notification_settings.suppress_roles),
        muted_until = CASE WHEN ${mu === undefined} THEN guild_notification_settings.muted_until ELSE ${mu ?? null}::timestamptz END
      RETURNING *`;
    const out = {
      guildId: r!.guild_id,
      level: r!.level as 0 | 1 | 2,
      suppressEveryone: r!.suppress_everyone,
      suppressRoles: r!.suppress_roles,
      mutedUntil: r!.muted_until?.toISOString() ?? null,
    };
    ctx.bus.toUser(auth.userId, 'NOTIFICATION_SETTINGS_UPDATE', { guild: out });
    return out;
  });

  app.patch('/users/@me/channels/:id/notifications', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    const p = parse(ChannelNotificationPatchSchema, req.body);
    await channelAccess(ctx, channelId, auth.userId);
    const mu = muteUntil(p.muteSeconds);
    const [r] = await ctx.sql<{ channel_id: string; level: number; muted_until: Date | null }[]>`
      INSERT INTO channel_notification_settings (user_id, channel_id, level, muted_until)
      VALUES (${auth.userId}, ${channelId}, ${p.level ?? -1}, ${mu ?? null})
      ON CONFLICT (user_id, channel_id) DO UPDATE SET
        level = COALESCE(${p.level ?? null}::smallint, channel_notification_settings.level),
        muted_until = CASE WHEN ${mu === undefined} THEN channel_notification_settings.muted_until ELSE ${mu ?? null}::timestamptz END
      RETURNING *`;
    const out = { channelId: r!.channel_id, level: r!.level as -1 | 0 | 1 | 2, mutedUntil: r!.muted_until?.toISOString() ?? null };
    ctx.bus.toUser(auth.userId, 'NOTIFICATION_SETTINGS_UPDATE', { channel: out });
    return out;
  });

  // ---------- send later ----------

  app.get('/users/@me/scheduled-messages', async (req) => {
    const auth = requireAuth(req);
    const rows = await ctx.sql<ScheduledRow[]>`SELECT * FROM scheduled_messages WHERE user_id = ${auth.userId} ORDER BY send_at`;
    return Promise.all(rows.map((r) => scheduledObj(ctx, r)));
  });

  app.post('/channels/:id/scheduled-messages', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'edit');
    const body = parse(ScheduleMessageSchema, req.body);
    const sendAt = new Date(body.sendAt);
    if (sendAt.getTime() < Date.now() + 30_000) throw badRequest('Pick a time at least a minute from now');
    if (sendAt.getTime() > Date.now() + Limits.SCHEDULE_MAX_DAYS * 86400_000) throw badRequest(`At most ${Limits.SCHEDULE_MAX_DAYS} days ahead`);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    await assertCanSend(ctx, a, auth.userId);
    if (body.attachments.length && !has(a.perms, P.ATTACH_FILES)) throw forbidden("You can't upload files here");
    const [{ count }] = (await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM scheduled_messages WHERE user_id = ${auth.userId}`) as unknown as [{ count: number }];
    if (count >= Limits.SCHEDULED_PER_USER) throw forbidden(`You can have at most ${Limits.SCHEDULED_PER_USER} scheduled messages`);
    // claim the files now so they aren't garbage-collected while waiting
    for (const att of body.attachments) await claimFile(ctx, att.fileId, auth.userId, ['attachment']);
    // release the claim right after so sendMessage can claim them again at send time
    if (body.attachments.length) {
      await ctx.sql`UPDATE files SET claimed = false, created_at = ${sendAt} WHERE id = ANY(${body.attachments.map((x) => x.fileId)}::bigint[])`;
    }
    const id = snowflake();
    const [r] = await ctx.sql<ScheduledRow[]>`
      INSERT INTO scheduled_messages (id, user_id, channel_id, content, flags, reply_to_id, reply_ping, attachments, send_at)
      VALUES (${id}, ${auth.userId}, ${a.channel.id}, ${body.content}, ${body.silent ? MessageFlags.SILENT : 0},
              ${body.replyTo?.messageId ?? null}, ${body.replyTo?.ping ?? true}, ${ctx.sql.json(body.attachments as never)}, ${sendAt})
      RETURNING *`;
    const out = await scheduledObj(ctx, r!);
    ctx.bus.toUser(auth.userId, 'SCHEDULED_MESSAGE_CREATE', out);
    return out;
  });

  app.patch('/scheduled-messages/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const p = parse(ScheduledPatchSchema, req.body);
    const [old] = await ctx.sql<ScheduledRow[]>`SELECT * FROM scheduled_messages WHERE id = ${id} AND user_id = ${auth.userId}`;
    if (!old) throw notFound('Scheduled message not found');
    const sets: Record<string, unknown> = { error: null };
    if (p.content !== undefined) {
      if (!p.content.trim() && !old.attachments.length) throw badRequest('Message is empty');
      sets.content = p.content;
    }
    if (p.sendAt !== undefined) {
      const t = new Date(p.sendAt);
      if (t.getTime() < Date.now() + 30_000) throw badRequest('Pick a time at least a minute from now');
      sets.send_at = t;
      if (old.attachments.length) {
        await ctx.sql`UPDATE files SET created_at = ${t} WHERE id = ANY(${old.attachments.map((x) => x.fileId)}::bigint[]) AND NOT claimed`;
      }
    }
    if (p.silent !== undefined) sets.flags = p.silent ? MessageFlags.SILENT : 0;
    const [r] = await ctx.sql<ScheduledRow[]>`UPDATE scheduled_messages SET ${ctx.sql(sets)} WHERE id = ${id} RETURNING *`;
    const out = await scheduledObj(ctx, r!);
    ctx.bus.toUser(auth.userId, 'SCHEDULED_MESSAGE_UPDATE', out);
    return out;
  });

  app.delete('/scheduled-messages/:id', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const [r] = await ctx.sql<ScheduledRow[]>`DELETE FROM scheduled_messages WHERE id = ${id} AND user_id = ${auth.userId} RETURNING *`;
    if (!r) throw notFound('Scheduled message not found');
    for (const a of r.attachments) await deleteFile(ctx, a.fileId);
    ctx.bus.toUser(auth.userId, 'SCHEDULED_MESSAGE_DELETE', { id, sentMessageId: null });
    return { ok: true };
  });

  // ---------- saved messages ----------

  app.get('/users/@me/bookmarks', async (req) => {
    const auth = requireAuth(req);
    const folderId = (req.query as { folderId?: string }).folderId;
    const rows = await ctx.sql<{ message_id: string; folder_id: string | null; note: string; created_at: Date; channel_id: string }[]>`
      SELECT b.message_id, b.folder_id, b.note, b.created_at, m.channel_id FROM bookmarks b JOIN messages m ON m.id = b.message_id
      WHERE b.user_id = ${auth.userId}
        ${folderId === 'none' ? ctx.sql`AND b.folder_id IS NULL` : folderId && /^\d+$/.test(folderId) ? ctx.sql`AND b.folder_id = ${folderId}` : ctx.sql``}
      ORDER BY b.created_at DESC LIMIT 500`;
    // only show messages you can still see
    const visible = new Map<string, { name: string | null; guildName: string | null } | null>();
    for (const r of rows) {
      if (visible.has(r.channel_id)) continue;
      try {
        const a = await channelAccess(ctx, r.channel_id, auth.userId);
        visible.set(r.channel_id, has(a.perms, P.READ_MESSAGE_HISTORY) ? { name: a.channel.name, guildName: a.guild?.data.guild.name ?? null } : null);
      } catch {
        visible.set(r.channel_id, null);
      }
    }
    const ok = rows.filter((r) => visible.get(r.channel_id));
    if (!ok.length) return [];
    const msgs = await queryMessages(ctx.sql, auth.userId, ctx.sql`m.id = ANY(${ok.map((r) => r.message_id)}::bigint[])`, { limit: 500 });
    const byId = new Map(msgs.map((m) => [m.id, m]));
    return ok
      .filter((r) => byId.has(r.message_id))
      .map(
        (r): Bookmark => ({
          message: byId.get(r.message_id)!,
          folderId: r.folder_id,
          note: r.note,
          createdAt: r.created_at.toISOString(),
          channelName: visible.get(r.channel_id)!.name,
          guildName: visible.get(r.channel_id)!.guildName,
        }),
      );
  });

  app.put('/users/@me/bookmarks/:messageId', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'general');
    const messageId = idParam(req, 'messageId');
    const body = parse(BookmarkPutSchema, req.body ?? {});
    const [m] = await ctx.sql<{ channel_id: string }[]>`SELECT channel_id FROM messages WHERE id = ${messageId}`;
    if (!m) throw notFound('Message not found');
    const a = await channelAccess(ctx, m.channel_id, auth.userId);
    if (!has(a.perms, P.READ_MESSAGE_HISTORY)) throw notFound('Message not found');
    if (body.folderId) {
      const [f] = await ctx.sql`SELECT 1 FROM bookmark_folders WHERE id = ${body.folderId} AND user_id = ${auth.userId}`;
      if (!f) throw badRequest('Folder not found');
    }
    await ctx.sql`
      INSERT INTO bookmarks (user_id, message_id, folder_id, note) VALUES (${auth.userId}, ${messageId}, ${body.folderId}, ${body.note})
      ON CONFLICT (user_id, message_id) DO UPDATE SET folder_id = EXCLUDED.folder_id, note = EXCLUDED.note`;
    ctx.bus.toUser(auth.userId, 'BOOKMARK_UPDATE', { messageId, folderId: body.folderId, note: body.note });
    return { ok: true };
  });

  app.delete('/users/@me/bookmarks/:messageId', async (req) => {
    const auth = requireAuth(req);
    const messageId = idParam(req, 'messageId');
    await ctx.sql`DELETE FROM bookmarks WHERE user_id = ${auth.userId} AND message_id = ${messageId}`;
    ctx.bus.toUser(auth.userId, 'BOOKMARK_DELETE', { messageId });
    return { ok: true };
  });

  const pushFolders = async (userId: string) => {
    const folders = await ctx.sql<{ id: string; name: string; position: number }[]>`
      SELECT id, name, position FROM bookmark_folders WHERE user_id = ${userId} ORDER BY position, id`;
    ctx.bus.toUser(userId, 'BOOKMARK_FOLDERS_UPDATE', { folders });
    return folders;
  };

  app.get('/users/@me/bookmark-folders', async (req) => {
    const auth = requireAuth(req);
    return ctx.sql`SELECT id, name, position FROM bookmark_folders WHERE user_id = ${auth.userId} ORDER BY position, id`;
  });

  app.post('/users/@me/bookmark-folders', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'general');
    const { name } = parse(BookmarkFolderSchema, req.body);
    const [{ count }] = (await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM bookmark_folders WHERE user_id = ${auth.userId}`) as unknown as [{ count: number }];
    if (count >= Limits.BOOKMARK_FOLDERS_MAX) throw forbidden('Too many folders');
    await ctx.sql`INSERT INTO bookmark_folders (id, user_id, name, position) VALUES (${snowflake()}, ${auth.userId}, ${name}, ${count})`;
    return pushFolders(auth.userId);
  });

  app.patch('/users/@me/bookmark-folders/:id', async (req) => {
    const auth = requireAuth(req);
    const { name } = parse(BookmarkFolderSchema, req.body);
    const r = await ctx.sql`UPDATE bookmark_folders SET name = ${name} WHERE id = ${idParam(req, 'id')} AND user_id = ${auth.userId} RETURNING id`;
    if (!r.length) throw notFound('Folder not found');
    return pushFolders(auth.userId);
  });

  app.delete('/users/@me/bookmark-folders/:id', async (req) => {
    const auth = requireAuth(req);
    const r = await ctx.sql`DELETE FROM bookmark_folders WHERE id = ${idParam(req, 'id')} AND user_id = ${auth.userId} RETURNING id`;
    if (!r.length) throw notFound('Folder not found');
    return pushFolders(auth.userId);
  });
}
