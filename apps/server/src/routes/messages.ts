import type { FastifyInstance } from 'fastify';
import {
  AckSchema,
  AuditAction,
  BulkDeleteSchema,
  ChannelType,
  CreateMessageSchema,
  CreateThreadSchema,
  EditMessageSchema,
  Limits,
  MessageType,
  MessagesQuerySchema,
  Permissions as P,
  compareIds,
  has,
  isDmType,
} from '@dbb/shared';
import type { ChannelRow, UserRow } from '../rows.js';
import { idParam, parse, requireAuth, strParam } from '../lib/validate.js';
import { limit, limitPreset, Limits as RL } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { channelAccess, requireChannelPerm } from '../lib/perms.js';
import { loadChannel, loadMessage, publicUser, queryMessages } from '../lib/serialize.js';
import { toChannel } from '../lib/fanout.js';
import { audit } from '../lib/audit.js';
import { snowflake } from '../ids.js';
import { deleteMessage, editMessage, getMessageRow, hardDeleteMessages, insertSystemMessage, sendMessage } from '../services/messages.js';
import type { Ctx } from '../context.js';

const EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|‍|️|⃣|[\u{1F1E6}-\u{1F1FF}])+$/u;

/** Validates a reaction key: a unicode emoji, or c:<id> for a custom one the user may use here. */
async function resolveReactionEmoji(ctx: Ctx, raw: string, userId: string, guildId: string | null, perms: bigint) {
  const key = decodeURIComponent(raw);
  if (key.startsWith('c:')) {
    const id = key.slice(2);
    if (!/^\d{1,20}$/.test(id)) throw badRequest('Bad emoji');
    const [e] = await ctx.sql<{ id: string; guild_id: string; name: string; animated: boolean; member: boolean }[]>`
      SELECT e.id, e.guild_id, e.name, e.animated,
        EXISTS (SELECT 1 FROM guild_members m WHERE m.guild_id = e.guild_id AND m.user_id = ${userId}) AS member
      FROM guild_emojis e WHERE e.id = ${id}`;
    if (!e) throw badRequest('Unknown emoji');
    if (e.guild_id !== guildId && (!e.member || !has(perms, P.USE_EXTERNAL_EMOJIS))) throw forbidden("You can't use that emoji here");
    return { key, name: e.name, animated: e.animated };
  }
  if (key.length > 32 || !EMOJI_RE.test(key)) throw badRequest('Bad emoji');
  return { key, name: undefined, animated: undefined };
}

export default async function messageRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/channels/:id/messages', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    const q = parse(MessagesQuerySchema, req.query);
    const a = await requireChannelPerm(ctx, channelId, auth.userId, P.READ_MESSAGE_HISTORY);
    const ch = a.channel.id;
    if (q.around) {
      const half = Math.floor(q.limit / 2);
      const older = await queryMessages(ctx.sql, auth.userId, ctx.sql`m.channel_id = ${ch} AND m.id <= ${q.around}`, { limit: half + 1 });
      const newer = await queryMessages(ctx.sql, auth.userId, ctx.sql`m.channel_id = ${ch} AND m.id > ${q.around}`, { order: 'asc', limit: half });
      return [...newer.reverse(), ...older];
    }
    if (q.after) {
      const rows = await queryMessages(ctx.sql, auth.userId, ctx.sql`m.channel_id = ${ch} AND m.id > ${q.after}`, { order: 'asc', limit: q.limit });
      return rows.reverse();
    }
    return queryMessages(ctx.sql, auth.userId, q.before ? ctx.sql`m.channel_id = ${ch} AND m.id < ${q.before}` : ctx.sql`m.channel_id = ${ch}`, {
      limit: q.limit,
    });
  });

  app.get('/channels/:id/messages/:mid', async (req) => {
    const auth = requireAuth(req);
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.READ_MESSAGE_HISTORY);
    const m = await loadMessage(ctx.sql, auth.userId, idParam(req, 'mid'));
    if (!m || m.channelId !== a.channel.id) throw notFound('Message not found');
    return m;
  });

  app.post('/channels/:id/messages', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    await limit(req, 'msg-ch', ...RL.messageChannel, `${auth.userId}:${channelId}`, "You're sending messages too fast");
    await limit(req, 'msg', ...RL.messageGlobal, auth.userId, "You're sending messages too fast");
    const body = parse(CreateMessageSchema, req.body);
    const a = await channelAccess(ctx, channelId, auth.userId);
    return sendMessage(ctx, {
      access: a,
      authorId: auth.userId,
      content: body.content,
      attachments: body.attachments,
      stickerId: body.stickerId,
      replyTo: body.replyTo,
      silent: body.silent,
      suppressEmbeds: body.suppressEmbeds,
      nonce: body.nonce,
    });
  });

  app.patch('/channels/:id/messages/:mid', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'edit');
    const body = parse(EditMessageSchema, req.body);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    return editMessage(ctx, a, auth.userId, idParam(req, 'mid'), body);
  });

  app.delete('/channels/:id/messages/:mid', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'edit');
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    await deleteMessage(ctx, a, auth.userId, idParam(req, 'mid'));
    return { ok: true };
  });

  app.get('/channels/:id/messages/:mid/edits', async (req) => {
    const auth = requireAuth(req);
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.READ_MESSAGE_HISTORY);
    const m = await getMessageRow(ctx, a.channel.id, idParam(req, 'mid'));
    const rows = await ctx.sql<{ content: string; replaced_at: Date }[]>`
      SELECT content, replaced_at FROM message_edits WHERE message_id = ${m.id} ORDER BY id DESC LIMIT 100`;
    return rows.map((r) => ({ content: r.content, replacedAt: r.replaced_at.toISOString() }));
  });

  app.post('/channels/:id/messages/bulk-delete', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'modAction');
    const { ids } = parse(BulkDeleteSchema, req.body);
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.MANAGE_MESSAGES);
    if (!a.guild) throw badRequest('Bulk delete is for server channels');
    const found = await ctx.sql<{ id: string }[]>`SELECT id FROM messages WHERE channel_id = ${a.channel.id} AND id = ANY(${ids}::bigint[])`;
    const real = found.map((f) => f.id);
    await hardDeleteMessages(ctx, real);
    await audit(ctx.sql, {
      guildId: a.guild.data.guild.id,
      actorId: auth.userId,
      action: AuditAction.MESSAGE_BULK_DELETE,
      targetType: 'channel',
      targetId: a.channel.id,
      changes: { count: real.length },
    });
    await toChannel(ctx, a.channel, 'MESSAGE_DELETE_BULK', { ids: real, channelId: a.channel.id, guildId: a.channel.guild_id });
    return { deleted: real.length };
  });

  // ---------- reactions ----------

  app.put('/channels/:id/messages/:mid/reactions/:emoji/@me', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'reaction');
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.READ_MESSAGE_HISTORY);
    const m = await getMessageRow(ctx, a.channel.id, idParam(req, 'mid'));
    const e = await resolveReactionEmoji(ctx, strParam(req, 'emoji', 100), auth.userId, a.channel.guild_id, a.perms);
    const existing = await ctx.sql<{ emoji: string }[]>`SELECT DISTINCT emoji FROM reactions WHERE message_id = ${m.id}`;
    const isNew = !existing.some((x) => x.emoji === e.key);
    // adding to an existing reaction is allowed without ADD_REACTIONS (like Discord), starting a new one isn't
    if (isNew && !has(a.perms, P.ADD_REACTIONS)) throw forbidden("You can't add new reactions here");
    if (isNew && existing.length >= Limits.REACTIONS_PER_MESSAGE) throw forbidden('This message has too many different reactions');
    if (a.guild && a.guild.member.timeoutUntil && a.guild.member.timeoutUntil.getTime() > Date.now()) throw forbidden("You're timed out");
    const ins = await ctx.sql`
      INSERT INTO reactions (message_id, emoji, user_id) VALUES (${m.id}, ${e.key}, ${auth.userId}) ON CONFLICT DO NOTHING RETURNING 1`;
    if (ins.length) {
      await toChannel(ctx, a.channel, 'MESSAGE_REACTION_ADD', {
        channelId: a.channel.id,
        messageId: m.id,
        userId: auth.userId,
        emoji: e.key,
        name: e.name,
        animated: e.animated,
      }, { recipients: a.recipients });
    }
    return { ok: true };
  });

  app.delete('/channels/:id/messages/:mid/reactions/:emoji/@me', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'reaction');
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    const mid = idParam(req, 'mid');
    const emoji = decodeURIComponent(strParam(req, 'emoji', 100));
    const del = await ctx.sql`
      DELETE FROM reactions WHERE message_id = ${mid} AND emoji = ${emoji} AND user_id = ${auth.userId}
        AND message_id IN (SELECT id FROM messages WHERE channel_id = ${a.channel.id}) RETURNING 1`;
    if (del.length) {
      await toChannel(ctx, a.channel, 'MESSAGE_REACTION_REMOVE', { channelId: a.channel.id, messageId: mid, userId: auth.userId, emoji }, { recipients: a.recipients });
    }
    return { ok: true };
  });

  app.delete('/channels/:id/messages/:mid/reactions/:emoji/:userId', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'modAction');
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.MANAGE_MESSAGES);
    if (!a.guild) throw forbidden();
    const mid = idParam(req, 'mid');
    const userId = idParam(req, 'userId');
    const emoji = decodeURIComponent(strParam(req, 'emoji', 100));
    const del = await ctx.sql`
      DELETE FROM reactions WHERE message_id = ${mid} AND emoji = ${emoji} AND user_id = ${userId}
        AND message_id IN (SELECT id FROM messages WHERE channel_id = ${a.channel.id}) RETURNING 1`;
    if (del.length) await toChannel(ctx, a.channel, 'MESSAGE_REACTION_REMOVE', { channelId: a.channel.id, messageId: mid, userId, emoji });
    return { ok: true };
  });

  app.delete('/channels/:id/messages/:mid/reactions/:emoji', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'modAction');
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.MANAGE_MESSAGES);
    if (!a.guild) throw forbidden();
    const mid = idParam(req, 'mid');
    const emoji = decodeURIComponent(strParam(req, 'emoji', 100));
    await ctx.sql`DELETE FROM reactions WHERE message_id = ${mid} AND emoji = ${emoji} AND message_id IN (SELECT id FROM messages WHERE channel_id = ${a.channel.id})`;
    await toChannel(ctx, a.channel, 'MESSAGE_REACTION_REMOVE_EMOJI', { channelId: a.channel.id, messageId: mid, emoji });
    return { ok: true };
  });

  app.get('/channels/:id/messages/:mid/reactions/:emoji', async (req) => {
    const auth = requireAuth(req);
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.READ_MESSAGE_HISTORY);
    const m = await getMessageRow(ctx, a.channel.id, idParam(req, 'mid'));
    const emoji = decodeURIComponent(strParam(req, 'emoji', 100));
    const rows = await ctx.sql<UserRow[]>`
      SELECT u.* FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ${m.id} AND r.emoji = ${emoji}
      ORDER BY r.created_at LIMIT 100`;
    return rows.map(publicUser);
  });

  // ---------- pins ----------

  app.get('/channels/:id/pins', async (req) => {
    const auth = requireAuth(req);
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.READ_MESSAGE_HISTORY);
    return queryMessages(ctx.sql, auth.userId, ctx.sql`m.channel_id = ${a.channel.id} AND m.pinned`, { limit: 100 });
  });

  for (const pin of [true, false]) {
    app[pin ? 'put' : 'delete']('/channels/:id/pins/:mid', async (req) => {
      const auth = requireAuth(req);
      await limitPreset(req, 'modAction');
      const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
      if (a.guild && !has(a.perms, P.MANAGE_MESSAGES)) throw forbidden();
      const m = await getMessageRow(ctx, a.channel.id, idParam(req, 'mid'));
      if (m.pinned === pin) return { ok: true };
      if (pin) {
        const [{ count }] = (await ctx.sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM messages WHERE channel_id = ${a.channel.id} AND pinned`) as unknown as [{ count: number }];
        if (count >= 100) throw forbidden('This channel already has 100 pins');
      }
      await ctx.sql`UPDATE messages SET pinned = ${pin} WHERE id = ${m.id}`;
      if (a.guild) {
        await audit(ctx.sql, {
          guildId: a.guild.data.guild.id,
          actorId: auth.userId,
          action: pin ? AuditAction.MESSAGE_PIN : AuditAction.MESSAGE_UNPIN,
          targetType: 'message',
          targetId: m.id,
          changes: { channelId: a.channel.id },
        });
      }
      const full = await loadMessage(ctx.sql, '0', m.id);
      if (full) await toChannel(ctx, a.channel, 'MESSAGE_UPDATE', full, { recipients: a.recipients });
      await toChannel(ctx, a.channel, 'CHANNEL_PINS_UPDATE', { channelId: a.channel.id, guildId: a.channel.guild_id }, { recipients: a.recipients });
      if (pin) await insertSystemMessage(ctx, a.channel, MessageType.PIN, auth.userId, { messageId: m.id });
      return { ok: true };
    });
  }

  // ---------- typing, read state, receipts ----------

  app.post('/channels/:id/typing', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'typing');
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    const need = a.channel.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
    if (!has(a.perms, need)) throw forbidden();
    const fresh = await ctx.redis.set(`typing:${a.channel.id}:${auth.userId}`, '1', 'EX', 5, 'NX');
    if (fresh === 'OK') {
      await toChannel(ctx, a.channel, 'TYPING_START', { channelId: a.channel.id, guildId: a.channel.guild_id, userId: auth.userId, at: Date.now() }, {
        exclude: [auth.userId],
        recipients: a.recipients,
      });
    }
    return { ok: true };
  });

  app.post('/channels/:id/ack', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'general');
    const { messageId } = parse(AckSchema, req.body);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    const [rs] = await ctx.sql<{ last_read_id: string; mention_count: number }[]>`
      INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (${auth.userId}, ${a.channel.id}, ${messageId}, 0)
      ON CONFLICT (user_id, channel_id) DO UPDATE SET
        last_read_id = GREATEST(read_states.last_read_id, EXCLUDED.last_read_id), mention_count = 0, updated_at = now()
      RETURNING last_read_id, mention_count`;
    ctx.bus.toUser(auth.userId, 'MESSAGE_ACK', { channelId: a.channel.id, lastReadId: rs!.last_read_id, mentionCount: 0 }, { excludeSession: auth.sessionId });

    // read receipts: DMs only, and only between people who both have them on
    if (isDmType(a.channel.type) && a.recipients) {
      const [me] = await ctx.sql<{ read_receipts: boolean }[]>`SELECT read_receipts FROM users WHERE id = ${auth.userId}`;
      if (me?.read_receipts) {
        const others = await ctx.sql<{ id: string }[]>`
          SELECT id FROM users WHERE id = ANY(${a.recipients.filter((r) => r !== auth.userId)}::bigint[]) AND read_receipts`;
        ctx.bus.toUsers(others.map((o) => o.id), 'DM_READ_RECEIPT', { channelId: a.channel.id, userId: auth.userId, messageId: rs!.last_read_id });
      }
    }
    return { channelId: a.channel.id, lastReadId: rs!.last_read_id, mentionCount: 0 };
  });

  app.get('/channels/:id/read-receipts', async (req) => {
    const auth = requireAuth(req);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    if (!isDmType(a.channel.type) || !a.recipients) return [];
    const [me] = await ctx.sql<{ read_receipts: boolean }[]>`SELECT read_receipts FROM users WHERE id = ${auth.userId}`;
    if (!me?.read_receipts) return [];
    const rows = await ctx.sql<{ user_id: string; last_read_id: string }[]>`
      SELECT rs.user_id, rs.last_read_id FROM read_states rs JOIN users u ON u.id = rs.user_id
      WHERE rs.channel_id = ${a.channel.id} AND rs.user_id <> ${auth.userId} AND u.read_receipts`;
    return rows.map((r) => ({ userId: r.user_id, messageId: r.last_read_id }));
  });

  /** "While you were away": the most-reacted messages since you last read the channel. */
  app.get('/channels/:id/highlights', async (req) => {
    const auth = requireAuth(req);
    const after = (req.query as { after?: string }).after;
    if (!after || !/^\d{1,20}$/.test(after)) throw badRequest('after is required');
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.READ_MESSAGE_HISTORY);
    const top = await ctx.sql<{ id: string; total: number }[]>`
      SELECT m.id, count(r.*)::int AS total FROM messages m JOIN reactions r ON r.message_id = m.id
      WHERE m.channel_id = ${a.channel.id} AND m.id > ${after} AND m.type = 0
      GROUP BY m.id HAVING count(r.*) >= 2 ORDER BY total DESC, m.id DESC LIMIT 5`;
    const [{ unread }] = (await ctx.sql<{ unread: number }[]>`
      SELECT count(*)::int AS unread FROM messages WHERE channel_id = ${a.channel.id} AND id > ${after}`) as unknown as [{ unread: number }];
    if (!top.length) return { unread, messages: [] };
    const msgs = await queryMessages(ctx.sql, auth.userId, ctx.sql`m.id = ANY(${top.map((t) => t.id)}::bigint[])`, { limit: 5 });
    const order = new Map(top.map((t, i) => [t.id, i]));
    return { unread, messages: msgs.sort((x, y) => order.get(x.id)! - order.get(y.id)!) };
  });

  // ---------- threads ----------

  app.post('/channels/:id/threads', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'modAction');
    const body = parse(CreateThreadSchema, req.body);
    const a = await requireChannelPerm(ctx, idParam(req, 'id'), auth.userId, P.CREATE_THREADS);
    const parent = a.channel;
    if (parent.type !== ChannelType.TEXT) throw badRequest('Threads can only be started in text channels');
    if (body.messageId) {
      const m = await getMessageRow(ctx, parent.id, body.messageId);
      if (m.thread_id) throw badRequest('That message already has a thread');
    }
    const id = snowflake();
    await ctx.sql.begin(async (tx) => {
      await tx`
        INSERT INTO channels (id, type, guild_id, parent_id, name, owner_id, starter_message_id, auto_archive_minutes)
        VALUES (${id}, ${ChannelType.THREAD}, ${parent.guild_id}, ${parent.id}, ${body.name}, ${auth.userId}, ${body.messageId ?? null}, ${body.autoArchiveMinutes})`;
      if (body.messageId) await tx`UPDATE messages SET thread_id = ${id} WHERE id = ${body.messageId}`;
    });
    const [t] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${id}`;
    const thread = await loadChannel(ctx.sql, t!);
    await toChannel(ctx, parent, 'THREAD_CREATE', thread);
    if (body.messageId) {
      const m = await loadMessage(ctx.sql, '0', body.messageId);
      if (m) await toChannel(ctx, parent, 'MESSAGE_UPDATE', m);
    } else {
      await insertSystemMessage(ctx, parent, MessageType.THREAD_CREATED, auth.userId, { threadId: id, name: body.name });
    }
    return thread;
  });

  app.get('/channels/:id/threads', async (req) => {
    const auth = requireAuth(req);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    const archived = (req.query as { archived?: string }).archived === 'true';
    const rows = await ctx.sql<ChannelRow[]>`
      SELECT * FROM channels WHERE parent_id = ${a.channel.id} AND type = ${ChannelType.THREAD} AND archived = ${archived}
      ORDER BY COALESCE(last_message_id, id) DESC LIMIT 100`;
    const out = [];
    for (const r of rows) out.push(await loadChannel(ctx.sql, r));
    return out.sort((x, y) => compareIds(y.lastMessageId ?? y.id, x.lastMessageId ?? x.id));
  });
}
