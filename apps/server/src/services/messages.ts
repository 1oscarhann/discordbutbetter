import {
  AuditAction,
  ChannelType,
  MessageFlags,
  MessageType,
  Permissions as P,
  extractEmbedLinks,
  extractMentions,
  has,
  isDmType,
  type Message,
  type MessageTypeValue,
} from '@haunt/shared';
import type { Ctx } from '../context.js';
import type { ChannelRow, GuildRow } from '../rows.js';
import { badRequest, forbidden, notFound, tooMany } from '../errors.js';
import { snowflake } from '../ids.js';
import { assertCanSend, type ChannelAccess, viewersOf } from '../lib/perms.js';
import { loadMessage, loadChannelById } from '../lib/serialize.js';
import { toChannel } from '../lib/fanout.js';
import { audit } from '../lib/audit.js';
import { claimFile, deleteFile } from '../routes/files.js';
import { runAutomod } from './automod.js';
import { unfurl } from './embeds.js';
import { awardXp } from './levels.js';
import { liveSockets } from '../lib/presence.js';

export interface SendInput {
  access: ChannelAccess;
  authorId: string;
  content: string;
  attachments: { fileId: string; spoiler: boolean; description?: string }[];
  stickerId?: string;
  replyTo?: { messageId: string; ping: boolean };
  silent: boolean;
  suppressEmbeds: boolean;
  nonce?: string;
  scheduled?: boolean;
}

interface MessageRow {
  id: string;
  channel_id: string;
  guild_id: string | null;
  author_id: string | null;
  type: number;
  content: string;
  flags: number;
  reply_to_id: string | null;
  pinned: boolean;
  thread_id: string | null;
  created_at: Date;
}

export async function getMessageRow(ctx: Ctx, channelId: string, messageId: string): Promise<MessageRow> {
  const [m] = await ctx.sql<MessageRow[]>`
    SELECT id, channel_id, guild_id, author_id, type, content, flags, reply_to_id, pinned, thread_id, created_at
    FROM messages WHERE id = ${messageId} AND channel_id = ${channelId} AND (expires_at IS NULL OR expires_at > now())`;
  if (!m) throw notFound('Message not found');
  return m;
}

/** Replaces custom emoji the author isn't allowed to use with :name: text. */
async function filterEmoji(ctx: Ctx, content: string, authorId: string, a: ChannelAccess): Promise<string> {
  const { emojis } = extractMentions(content);
  if (!emojis.length) return content;
  const rows = await ctx.sql<{ id: string; guild_id: string; member: boolean }[]>`
    SELECT e.id, e.guild_id,
      EXISTS (SELECT 1 FROM guild_members m WHERE m.guild_id = e.guild_id AND m.user_id = ${authorId}) AS member
    FROM guild_emojis e WHERE e.id = ANY(${emojis.map((e) => e.id)}::bigint[])`;
  const ok = new Set<string>();
  for (const r of rows) {
    if (a.channel.guild_id && r.guild_id === a.channel.guild_id) ok.add(r.id);
    else if (r.member && has(a.perms, P.USE_EXTERNAL_EMOJIS)) ok.add(r.id);
  }
  return content.replace(/<a?:([A-Za-z0-9_]{2,32}):(\d{1,20})>/g, (m, name: string, id: string) => (ok.has(id) ? m : `:${name}:`));
}

/** Core send path, shared by POST /messages and the send-later job. */
export async function sendMessage(ctx: Ctx, input: SendInput): Promise<Message> {
  const a = input.access;
  const ch = a.channel;
  await assertCanSend(ctx, a, input.authorId);
  if (input.attachments.length && !has(a.perms, P.ATTACH_FILES)) throw forbidden("You can't upload files here");

  // slowmode
  const slowSource = ch.type === ChannelType.THREAD && a.parent ? a.parent : ch;
  if (slowSource.slowmode > 0 && !has(a.perms, P.MANAGE_MESSAGES) && !has(a.perms, P.MANAGE_CHANNELS)) {
    const ok = await ctx.redis.set(`slow:${ch.id}:${input.authorId}`, '1', 'EX', slowSource.slowmode, 'NX');
    if (ok !== 'OK') {
      const ttl = await ctx.redis.ttl(`slow:${ch.id}:${input.authorId}`);
      throw tooMany(Math.max(1, ttl), `Slowmode is on — wait ${Math.max(1, ttl)}s`);
    }
  }

  // sticker
  let stickerId: string | null = null;
  if (input.stickerId) {
    const [s] = await ctx.sql<{ id: string; guild_id: string; member: boolean }[]>`
      SELECT s.id, s.guild_id, EXISTS (SELECT 1 FROM guild_members m WHERE m.guild_id = s.guild_id AND m.user_id = ${input.authorId}) AS member
      FROM guild_stickers s WHERE s.id = ${input.stickerId}`;
    if (!s || !s.member) throw badRequest('Sticker not found');
    if (s.guild_id !== ch.guild_id && !has(a.perms, P.USE_EXTERNAL_STICKERS)) throw forbidden("You can't use stickers from other servers here");
    stickerId = s.id;
  }

  // reply
  let replyAuthor: string | null = null;
  if (input.replyTo) {
    const [r] = await ctx.sql<{ author_id: string | null }[]>`
      SELECT author_id FROM messages WHERE id = ${input.replyTo.messageId} AND channel_id = ${ch.id}`;
    if (!r) throw badRequest("The message you're replying to is gone");
    replyAuthor = r.author_id;
  }

  let content = await filterEmoji(ctx, input.content, input.authorId, a);
  const parsed = extractMentions(content);

  // mentions
  let mentionUsers = parsed.users.slice(0, 100);
  let mentionRoles: string[] = [];
  let mentionEveryone = false;
  let mentionHere = false;
  let guild: GuildRow | null = null;
  if (a.guild) {
    guild = a.guild.data.guild;
    const canEveryone = has(a.perms, P.MENTION_EVERYONE);
    mentionEveryone = parsed.everyone && canEveryone;
    mentionHere = parsed.here && canEveryone;
    mentionRoles = parsed.roles.filter((id) => {
      const r = a.guild!.data.roles.get(id);
      return r && id !== guild!.id && (r.mentionable || canEveryone);
    });
    if (mentionUsers.length) {
      const members = await ctx.sql<{ user_id: string }[]>`
        SELECT user_id FROM guild_members WHERE guild_id = ${guild.id} AND user_id = ANY(${mentionUsers}::bigint[])`;
      const set = new Set(members.map((m) => m.user_id));
      mentionUsers = mentionUsers.filter((u) => set.has(u));
    }
  } else if (a.recipients) {
    const set = new Set(a.recipients);
    mentionUsers = mentionUsers.filter((u) => set.has(u));
  }
  if (input.replyTo?.ping && replyAuthor && replyAuthor !== input.authorId && !mentionUsers.includes(replyAuthor)) {
    mentionUsers.push(replyAuthor);
  }

  // automod (guilds only)
  if (a.guild) {
    const res = await runAutomod(ctx, {
      guildId: a.guild.data.guild.id,
      channelIds: [ch.id, ...(a.parent ? [a.parent.id] : []), ...(ch.parent_id ? [ch.parent_id] : [])],
      channelId: ch.id,
      userId: input.authorId,
      content,
      memberRoles: a.guild.member.roles,
      perms: a.perms,
      mentionCount: parsed.users.length + parsed.roles.length + (parsed.everyone || parsed.here ? 1 : 0),
      isEdit: false,
    });
    if (res.blocked) throw forbidden(res.message ?? 'Blocked by automod');
  }

  let flags = 0;
  if (input.silent) flags |= MessageFlags.SILENT;
  if (input.suppressEmbeds) flags |= MessageFlags.SUPPRESS_EMBEDS;
  if (input.replyTo?.ping) flags |= MessageFlags.REPLY_PING;
  if (input.scheduled) flags |= MessageFlags.SCHEDULED;

  const expiresAt = isDmType(ch.type) && ch.disappearing_seconds > 0 ? new Date(Date.now() + ch.disappearing_seconds * 1000) : null;
  const id = snowflake();

  let reopened: string[] = [];
  await ctx.sql.begin(async (tx) => {
    await tx`
      INSERT INTO messages (id, channel_id, guild_id, author_id, type, content, flags, reply_to_id, mentions, mention_roles, mention_everyone, sticker_id, expires_at)
      VALUES (${id}, ${ch.id}, ${ch.guild_id}, ${input.authorId}, ${MessageType.DEFAULT}, ${content}, ${flags},
              ${input.replyTo?.messageId ?? null}, ${mentionUsers}::bigint[], ${mentionRoles}::bigint[], ${mentionEveryone || mentionHere},
              ${stickerId}, ${expiresAt})`;
    let pos = 0;
    for (const att of input.attachments) {
      await claimFile({ sql: tx as never }, att.fileId, input.authorId, ['attachment']);
      await tx`
        INSERT INTO message_attachments (message_id, file_id, position, spoiler, description)
        VALUES (${id}, ${att.fileId}, ${pos++}, ${att.spoiler}, ${att.description ?? null})`;
    }
    await tx`UPDATE channels SET last_message_id = ${id} WHERE id = ${ch.id}`;
    if (ch.type === ChannelType.THREAD) {
      await tx`UPDATE channels SET message_count = message_count + 1, archived = false, archived_at = NULL WHERE id = ${ch.id}`;
    }
    if (isDmType(ch.type)) {
      const rows = await tx<{ user_id: string }[]>`
        UPDATE dm_recipients SET open = true WHERE channel_id = ${ch.id} AND NOT open RETURNING user_id`;
      reopened = rows.map((r) => r.user_id);
    }
    await tx`
      INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (${input.authorId}, ${ch.id}, ${id}, 0)
      ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = ${id}, mention_count = 0, updated_at = now()`;
  });

  // unread mention badges
  if (!input.silent) await bumpMentions(ctx, a, input.authorId, { users: mentionUsers, roles: mentionRoles, everyone: mentionEveryone, here: mentionHere });

  const msg = (await loadMessage(ctx.sql, '0', id))!;
  if (input.nonce) msg.nonce = input.nonce;

  // a DM that someone had closed pops back open for them
  if (reopened.length) {
    const dm = await loadChannelById(ctx.sql, ch.id);
    if (dm) ctx.bus.toUsers(reopened, 'CHANNEL_CREATE', dm);
  }
  if (ch.type === ChannelType.THREAD) {
    const t = await loadChannelById(ctx.sql, ch.id);
    if (t) await toChannel(ctx, ch, 'THREAD_UPDATE', t);
  }
  await toChannel(ctx, ch, 'MESSAGE_CREATE', msg, { recipients: a.recipients });

  // after the response: link previews and XP
  setImmediate(() => {
    void (async () => {
      if (!input.suppressEmbeds && has(a.perms, P.EMBED_LINKS)) {
        const links = extractEmbedLinks(content);
        if (links.length) {
          const embeds = await unfurl(ctx, links);
          if (embeds.length) {
            const upd = await ctx.sql`UPDATE messages SET embeds = ${ctx.sql.json(embeds as never)} WHERE id = ${id} RETURNING id`;
            if (upd.length) {
              const m2 = await loadMessage(ctx.sql, '0', id);
              if (m2) await toChannel(ctx, ch, 'MESSAGE_UPDATE', m2, { recipients: a.recipients });
            }
          }
        }
      }
      if (guild) await awardXp(ctx, guild, input.authorId, ch);
    })().catch((e: Error) => ctx.log.warn({ err: e }, 'post-send work failed'));
  });
  return msg;
}

async function bumpMentions(
  ctx: Ctx,
  a: ChannelAccess,
  authorId: string,
  m: { users: string[]; roles: string[]; everyone: boolean; here: boolean },
): Promise<void> {
  const ch = a.channel;
  let targets: string[] = [];
  if (isDmType(ch.type)) {
    targets = (a.recipients ?? []).filter((u) => u !== authorId);
  } else if (a.guild) {
    const data = a.guild.data;
    const viewSource = ch.type === ChannelType.THREAD && a.parent ? a.parent.id : ch.id;
    const candidates = new Set<string>(m.users);
    let everyoneTargets: string[] = [];
    if (m.everyone || m.here) {
      everyoneTargets = await viewersOf(ctx.sql, data, viewSource);
      if (m.here && !m.everyone) {
        const online: string[] = [];
        for (const u of everyoneTargets) if ((await liveSockets(ctx, u)).length) online.push(u);
        everyoneTargets = online;
      }
      const suppress = new Set(
        (await ctx.sql<{ user_id: string }[]>`
          SELECT user_id FROM guild_notification_settings WHERE guild_id = ${data.guild.id} AND suppress_everyone`).map((r) => r.user_id),
      );
      everyoneTargets = everyoneTargets.filter((u) => !suppress.has(u));
    }
    if (m.roles.length) {
      const rows = await ctx.sql<{ user_id: string }[]>`
        SELECT DISTINCT mr.user_id FROM member_roles mr
        WHERE mr.guild_id = ${data.guild.id} AND mr.role_id = ANY(${m.roles}::bigint[])
          AND NOT EXISTS (SELECT 1 FROM guild_notification_settings s WHERE s.user_id = mr.user_id AND s.guild_id = mr.guild_id AND s.suppress_roles)`;
      for (const r of rows) candidates.add(r.user_id);
    }
    const direct = candidates.size ? await viewersOf(ctx.sql, data, viewSource, [...candidates]) : [];
    targets = [...new Set([...direct, ...everyoneTargets])].filter((u) => u !== authorId);
  }
  if (!targets.length) return;
  await ctx.sql`
    INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count)
    SELECT u, ${ch.id}, 0, 1 FROM unnest(${targets}::bigint[]) AS u
    ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1, updated_at = now()`;
}

/** System messages (joins, level ups, pins, game invites, automod alerts…). Never notify. */
export async function insertSystemMessage(
  ctx: Ctx,
  ch: Pick<ChannelRow, 'id' | 'type' | 'guild_id' | 'parent_id'>,
  type: MessageTypeValue,
  authorId: string | null,
  metadata: Record<string, unknown> | null,
  content = '',
): Promise<Message | null> {
  const id = snowflake();
  const [full] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${ch.id}`;
  if (!full) return null;
  const expiresAt = isDmType(full.type) && full.disappearing_seconds > 0 ? new Date(Date.now() + full.disappearing_seconds * 1000) : null;
  await ctx.sql`
    INSERT INTO messages (id, channel_id, guild_id, author_id, type, content, flags, metadata, expires_at)
    VALUES (${id}, ${ch.id}, ${ch.guild_id}, ${authorId}, ${type}, ${content}, ${MessageFlags.SILENT},
            ${metadata ? ctx.sql.json(metadata as never) : null}, ${expiresAt})`;
  await ctx.sql`UPDATE channels SET last_message_id = ${id} WHERE id = ${ch.id}`;
  const msg = await loadMessage(ctx.sql, '0', id);
  if (msg) await toChannel(ctx, ch, 'MESSAGE_CREATE', msg);
  return msg;
}

export async function editMessage(
  ctx: Ctx,
  a: ChannelAccess,
  userId: string,
  messageId: string,
  patch: { content?: string; suppressEmbeds?: boolean },
): Promise<Message> {
  const m = await getMessageRow(ctx, a.channel.id, messageId);
  const isAuthor = m.author_id === userId;
  if (m.type !== MessageType.DEFAULT) throw forbidden("System messages can't be edited");
  if (patch.content !== undefined && !isAuthor) throw forbidden('You can only edit your own messages');
  if (patch.suppressEmbeds !== undefined && !isAuthor && !(a.guild && has(a.perms, P.MANAGE_MESSAGES))) throw forbidden();

  let flags = m.flags;
  if (patch.suppressEmbeds !== undefined) flags = patch.suppressEmbeds ? flags | MessageFlags.SUPPRESS_EMBEDS : flags & ~MessageFlags.SUPPRESS_EMBEDS;

  const contentChanged = patch.content !== undefined && patch.content !== m.content;
  if (contentChanged) {
    const content = await filterEmoji(ctx, patch.content!, userId, a);
    const hasAtt = await ctx.sql`SELECT 1 FROM message_attachments WHERE message_id = ${m.id} LIMIT 1`;
    if (!content.trim() && !hasAtt.length) throw badRequest("A message can't be empty — delete it instead");
    if (a.guild) {
      const res = await runAutomod(ctx, {
        guildId: a.guild.data.guild.id,
        channelIds: [a.channel.id, ...(a.parent ? [a.parent.id] : []), ...(a.channel.parent_id ? [a.channel.parent_id] : [])],
        channelId: a.channel.id,
        userId,
        content,
        memberRoles: a.guild.member.roles,
        perms: a.perms,
        mentionCount: 0,
        isEdit: true,
      });
      if (res.blocked) throw forbidden(res.message ?? 'Blocked by automod');
    }
    const parsed = extractMentions(content);
    await ctx.sql.begin(async (tx) => {
      await tx`INSERT INTO message_edits (message_id, content) VALUES (${m.id}, ${m.content})`;
      await tx`
        UPDATE messages SET content = ${content}, edited_at = now(), flags = ${flags}, embeds = '[]',
          mentions = ${parsed.users.slice(0, 100)}::bigint[]
        WHERE id = ${m.id}`;
    });
  } else if (flags !== m.flags) {
    await ctx.sql`UPDATE messages SET flags = ${flags} WHERE id = ${m.id}`;
  }

  const msg = (await loadMessage(ctx.sql, '0', m.id))!;
  await toChannel(ctx, a.channel, 'MESSAGE_UPDATE', msg, { recipients: a.recipients });

  if (contentChanged && !(flags & MessageFlags.SUPPRESS_EMBEDS) && has(a.perms, P.EMBED_LINKS)) {
    setImmediate(() => {
      void (async () => {
        const embeds = await unfurl(ctx, extractEmbedLinks(msg.content));
        if (!embeds.length) return;
        await ctx.sql`UPDATE messages SET embeds = ${ctx.sql.json(embeds as never)} WHERE id = ${m.id}`;
        const m2 = await loadMessage(ctx.sql, '0', m.id);
        if (m2) await toChannel(ctx, a.channel, 'MESSAGE_UPDATE', m2, { recipients: a.recipients });
      })().catch(() => {});
    });
  }
  return msg;
}

/** Deletes messages and their files. Caller has already checked permissions. */
export async function hardDeleteMessages(ctx: Ctx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const files = await ctx.sql<{ file_id: string }[]>`SELECT file_id FROM message_attachments WHERE message_id = ANY(${ids}::bigint[])`;
  await ctx.sql`DELETE FROM messages WHERE id = ANY(${ids}::bigint[])`;
  for (const f of files) await deleteFile(ctx, f.file_id);
}

export async function deleteMessage(ctx: Ctx, a: ChannelAccess, userId: string, messageId: string, reason?: string): Promise<void> {
  const m = await getMessageRow(ctx, a.channel.id, messageId);
  const isAuthor = m.author_id === userId;
  const canManage = !!a.guild && has(a.perms, P.MANAGE_MESSAGES);
  if (!isAuthor && !canManage) throw forbidden('You can only delete your own messages');
  await hardDeleteMessages(ctx, [m.id]);
  if (!isAuthor && a.guild) {
    await audit(ctx.sql, {
      guildId: a.guild.data.guild.id,
      actorId: userId,
      action: AuditAction.MESSAGE_DELETE,
      targetType: 'user',
      targetId: m.author_id,
      changes: { channelId: a.channel.id, content: m.content.slice(0, 500) },
      reason: reason ?? null,
    });
  }
  await toChannel(ctx, a.channel, 'MESSAGE_DELETE', { id: m.id, channelId: a.channel.id, guildId: a.channel.guild_id }, { recipients: a.recipients });
}
