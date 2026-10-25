import type {
  Channel,
  CustomEmoji,
  Guild,
  GuildMember,
  Message,
  Overwrite,
  PrivacySettings,
  PublicUser,
  Role,
  SelfUser,
  Sticker,
  MessageTypeValue,
  ChannelTypeValue,
  PlayingActivity,
  ListeningActivity,
  CustomStatus,
} from '@dbb/shared';
import { ChannelType } from '@dbb/shared';
import type { Db, Fragment } from '../db.js';
import type { ChannelRow, GuildRow, OverwriteRow, RoleRow, UserRow } from '../rows.js';

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function publicUser(u: Pick<UserRow, 'id' | 'username' | 'display_name' | 'avatar' | 'deleted'>): PublicUser {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatar: u.avatar,
    ...(u.deleted ? { deleted: true } : {}),
  };
}

export function customStatusOf(u: Pick<UserRow, 'custom_status'>): CustomStatus | null {
  const cs = u.custom_status;
  if (!cs) return null;
  if (cs.expiresAt && new Date(cs.expiresAt).getTime() < Date.now()) return null;
  return { text: cs.text ?? '', emoji: cs.emoji ?? null, expiresAt: cs.expiresAt ?? null };
}

export function privacyOf(u: UserRow): PrivacySettings {
  return {
    lastSeen: u.last_seen_privacy,
    readReceipts: u.read_receipts,
    dmPolicy: u.dm_policy,
    friendRequests: u.friend_policy,
  };
}

export function selfUser(u: UserRow): SelfUser {
  return {
    ...publicUser(u),
    email: u.email ?? '',
    emailVerified: u.email_verified,
    isAdmin: u.is_admin,
    status: u.status,
    customStatus: customStatusOf(u),
    playing: (u.activity_playing as PlayingActivity | null) ?? null,
    listening: (u.activity_listening as ListeningActivity | null) ?? null,
    privacy: privacyOf(u),
    createdAt: iso(u.created_at)!,
  };
}

export function guild(g: GuildRow): Guild {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    banner: g.banner,
    description: g.description,
    ownerId: g.owner_id,
    systemChannelId: g.system_channel_id,
    levels: { enabled: g.levels_enabled, announce: g.levels_announce, announceChannelId: g.levels_channel_id },
    createdAt: iso(g.created_at)!,
  };
}

export function role(r: RoleRow): Role {
  return {
    id: r.id,
    guildId: r.guild_id,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    mentionable: r.mentionable,
    position: r.position,
    permissions: r.permissions.toString(),
  };
}

export function overwrite(o: OverwriteRow): Overwrite {
  return { id: o.target_id, type: o.target_type, allow: o.allow.toString(), deny: o.deny.toString() };
}

export function channel(c: ChannelRow, overwrites: OverwriteRow[] = [], recipients?: PublicUser[]): Channel {
  const out: Channel = {
    id: c.id,
    type: c.type as ChannelTypeValue,
    guildId: c.guild_id,
    parentId: c.parent_id,
    name: c.name,
    topic: c.topic,
    position: c.position,
    slowmode: c.slowmode,
    userLimit: c.user_limit,
    overwrites: overwrites.map(overwrite),
    lastMessageId: c.last_message_id,
    createdAt: iso(c.created_at)!,
  };
  if (c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM) {
    out.recipients = recipients ?? [];
    out.ownerId = c.owner_id;
    out.icon = c.icon;
    out.disappearingSeconds = c.disappearing_seconds;
  }
  if (c.type === ChannelType.THREAD) {
    out.threadMeta = {
      starterMessageId: c.starter_message_id,
      archived: c.archived,
      locked: c.locked,
      archivedAt: iso(c.archived_at),
      autoArchiveMinutes: c.auto_archive_minutes,
      messageCount: c.message_count,
      ownerId: c.owner_id ?? '',
    };
  }
  return out;
}

/** Loads a channel with its overwrites (and recipients for DMs) and serialises it. */
export async function loadChannel(db: Db, c: ChannelRow): Promise<Channel> {
  if (c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM) {
    const rec = await db<UserRow[]>`
      SELECT u.* FROM dm_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ${c.id} ORDER BY r.joined_at`;
    return channel(c, [], rec.map(publicUser));
  }
  const ows = await db<OverwriteRow[]>`SELECT * FROM permission_overwrites WHERE channel_id = ${c.id}`;
  return channel(c, ows);
}

export async function loadChannelById(db: Db, id: string): Promise<Channel | null> {
  const [c] = await db<ChannelRow[]>`SELECT * FROM channels WHERE id = ${id}`;
  return c ? loadChannel(db, c) : null;
}

interface MemberQueryRow {
  guild_id: string;
  user_id: string;
  nickname: string | null;
  avatar: string | null;
  joined_at: Date;
  timeout_until: Date | null;
  roles: string[] | null;
  u_username: string;
  u_display_name: string | null;
  u_avatar: string | null;
  u_deleted: boolean;
}

function memberFromRow(r: MemberQueryRow): GuildMember {
  return {
    guildId: r.guild_id,
    user: publicUser({ id: r.user_id, username: r.u_username, display_name: r.u_display_name, avatar: r.u_avatar, deleted: r.u_deleted }),
    nickname: r.nickname,
    avatar: r.avatar,
    roles: r.roles ?? [],
    joinedAt: iso(r.joined_at)!,
    timeoutUntil: r.timeout_until && r.timeout_until.getTime() > Date.now() ? iso(r.timeout_until) : null,
  };
}

export async function loadMembers(db: Db, guildId: string, userIds?: string[]): Promise<GuildMember[]> {
  const rows = await db<MemberQueryRow[]>`
    SELECT m.guild_id, m.user_id, m.nickname, m.avatar, m.joined_at, m.timeout_until,
      (SELECT array_agg(role_id::text) FROM member_roles mr WHERE mr.guild_id = m.guild_id AND mr.user_id = m.user_id) AS roles,
      u.username::text AS u_username, u.display_name AS u_display_name, u.avatar AS u_avatar, u.deleted AS u_deleted
    FROM guild_members m JOIN users u ON u.id = m.user_id
    WHERE m.guild_id = ${guildId} ${userIds ? db`AND m.user_id = ANY(${userIds}::bigint[])` : db``}
    ORDER BY m.joined_at`;
  return rows.map(memberFromRow);
}

export async function loadMember(db: Db, guildId: string, userId: string): Promise<GuildMember | null> {
  return (await loadMembers(db, guildId, [userId]))[0] ?? null;
}

export async function loadEmojis(db: Db, guildId: string): Promise<CustomEmoji[]> {
  const rows = await db<{ id: string; guild_id: string; name: string; animated: boolean; url: string }[]>`
    SELECT id, guild_id, name, animated, url FROM guild_emojis WHERE guild_id = ${guildId} ORDER BY name`;
  return rows.map((e) => ({ id: e.id, guildId: e.guild_id, name: e.name, animated: e.animated, url: e.url }));
}

export async function loadStickers(db: Db, guildId: string): Promise<Sticker[]> {
  const rows = await db<{ id: string; guild_id: string; name: string; description: string; url: string; format: string }[]>`
    SELECT id, guild_id, name, description, url, format FROM guild_stickers WHERE guild_id = ${guildId} ORDER BY name`;
  return rows.map((s) => ({
    id: s.id,
    guildId: s.guild_id,
    name: s.name,
    description: s.description,
    url: s.url,
    format: s.format as Sticker['format'],
  }));
}

// ---------------- messages ----------------

interface MessageQueryRow {
  id: string;
  channel_id: string;
  guild_id: string | null;
  type: number;
  content: string;
  flags: number;
  reply_to_id: string | null;
  mentions: string[];
  mention_roles: string[];
  mention_everyone: boolean;
  embeds: Message['embeds'];
  pinned: boolean;
  thread_id: string | null;
  metadata: Record<string, unknown> | null;
  edited_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  author: PublicUser | null;
  reply: Message['replyTo'];
  attachments: Message['attachments'];
  reactions: Message['reactions'];
  sticker: Message['sticker'];
}

const PU = (a: string) =>
  `CASE WHEN ${a}.id IS NULL THEN NULL ELSE json_build_object('id', ${a}.id::text, 'username', ${a}.username::text, 'displayName', ${a}.display_name, 'avatar', ${a}.avatar, 'deleted', ${a}.deleted) END`;

/**
 * The one query that builds full message objects. `where` is a postgres.js fragment on alias `m`.
 */
export async function queryMessages(
  db: Db,
  viewerId: string,
  where: Fragment,
  opts: { order?: 'asc' | 'desc'; limit?: number; offset?: number } = {},
): Promise<Message[]> {
  const order = opts.order === 'asc' ? db`ASC` : db`DESC`;
  const result = await db<MessageQueryRow[]>`
    SELECT m.id, m.channel_id, m.guild_id, m.type, m.content, m.flags, m.reply_to_id,
      m.mentions::text[] AS mentions, m.mention_roles::text[] AS mention_roles, m.mention_everyone,
      m.embeds, m.pinned, m.thread_id, m.metadata, m.edited_at, m.expires_at, m.created_at,
      ${db.unsafe(PU('u'))} AS author,
      (SELECT json_build_object(
          'id', r.id::text, 'content', left(r.content, 300), 'deleted', false,
          'hasAttachments', EXISTS (SELECT 1 FROM message_attachments ra WHERE ra.message_id = r.id),
          'author', ${db.unsafe(PU('ru'))})
        FROM messages r LEFT JOIN users ru ON ru.id = r.author_id WHERE r.id = m.reply_to_id) AS reply,
      COALESCE((SELECT json_agg(json_build_object(
          'id', f.id::text, 'filename', f.filename, 'contentType', f.content_type, 'size', f.size,
          'url', '/files/' || f.id || '/' || f.secret || '/' || f.filename,
          'width', f.width, 'height', f.height, 'durationMs', f.duration_ms,
          'spoiler', a.spoiler, 'description', a.description) ORDER BY a.position)
        FROM message_attachments a JOIN files f ON f.id = a.file_id WHERE a.message_id = m.id), '[]'::json) AS attachments,
      COALESCE((SELECT json_agg(json_build_object('emoji', x.emoji, 'count', x.cnt, 'me', x.me, 'name', e.name, 'animated', e.animated) ORDER BY x.first)
        FROM (SELECT emoji, count(*)::int AS cnt, bool_or(user_id = ${viewerId}) AS me, min(created_at) AS first
              FROM reactions WHERE message_id = m.id GROUP BY emoji) x
        LEFT JOIN guild_emojis e ON e.id = CASE WHEN x.emoji LIKE 'c:%' THEN substr(x.emoji, 3)::bigint END), '[]'::json) AS reactions,
      (SELECT json_build_object('id', s.id::text, 'guildId', s.guild_id::text, 'name', s.name, 'description', s.description, 'url', s.url, 'format', s.format)
        FROM guild_stickers s WHERE s.id = m.sticker_id) AS sticker
    FROM messages m LEFT JOIN users u ON u.id = m.author_id
    WHERE ${where} AND (m.expires_at IS NULL OR m.expires_at > now())
    ORDER BY m.id ${order}
    LIMIT ${opts.limit ?? 50} OFFSET ${opts.offset ?? 0}`;
  return result.map(messageFromRow);
}

function messageFromRow(r: MessageQueryRow): Message {
  let replyTo = r.reply;
  if (!replyTo && r.reply_to_id) replyTo = { id: r.reply_to_id, author: null, content: '', hasAttachments: false, deleted: true };
  return {
    id: r.id,
    channelId: r.channel_id,
    guildId: r.guild_id,
    author: r.author,
    type: r.type as MessageTypeValue,
    content: r.content,
    flags: r.flags,
    replyTo,
    mentions: r.mentions ?? [],
    mentionRoles: r.mention_roles ?? [],
    mentionEveryone: r.mention_everyone,
    attachments: (r.attachments ?? []).map((a) => ({ ...a, size: Number(a.size) })),
    embeds: r.embeds ?? [],
    sticker: r.sticker,
    reactions: (r.reactions ?? []).map((x) =>
      x.emoji.startsWith('c:') ? x : { emoji: x.emoji, count: x.count, me: x.me },
    ) as Message['reactions'],
    pinned: r.pinned,
    threadId: r.thread_id,
    editedAt: iso(r.edited_at),
    expiresAt: iso(r.expires_at),
    metadata: r.metadata,
    createdAt: iso(r.created_at)!,
  };
}

export async function loadMessage(db: Db, viewerId: string, messageId: string): Promise<Message | null> {
  const rows = await queryMessages(db, viewerId, db`m.id = ${messageId}`, { limit: 1 });
  return rows[0] ?? null;
}

/** Messages as seen by "nobody in particular" (reaction.me = false) — for broadcasting. */
export async function loadMessageForBroadcast(db: Db, messageId: string): Promise<Message | null> {
  return loadMessage(db, '0', messageId);
}
