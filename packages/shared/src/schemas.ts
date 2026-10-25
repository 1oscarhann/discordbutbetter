import { z } from 'zod';
import {
  ChannelType,
  DISAPPEARING_OPTIONS,
  DmPolicy,
  FriendRequestPolicy,
  GameKind,
  LastSeenVisibility,
  Limits,
  PROFILE_FONTS,
  Status,
} from './constants.js';
import { cleanMultiline, cleanSingleLine, normaliseUsername, safeHttpUrl, USERNAME_RE, youtubeId } from './text.js';

// ---------- primitives ----------

export const zId = z.string().regex(/^\d{1,20}$/, { error: 'Invalid id' });

export const zBigintString = z
  .string()
  .regex(/^\d{1,20}$/, { error: 'Invalid permission value' })
  .refine((s) => BigInt(s) < 1n << 63n, { error: 'Permission value out of range' });

export const zHex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Colour must look like #a1b2c3' });

/** Single-line text, cleaned, then length-checked. */
export function line(max: number, min = 0) {
  return z
    .string()
    .max(max * 4 + 64)
    .transform(cleanSingleLine)
    .pipe(z.string().min(min).max(max));
}

/** Multiline text, cleaned, then length-checked. */
export function text(max: number, min = 0) {
  return z
    .string()
    .max(max * 4 + 64)
    .transform(cleanMultiline)
    .pipe(z.string().min(min).max(max));
}

export const zHttpUrl = z
  .string()
  .max(2048)
  .transform((s, ctx) => {
    const u = safeHttpUrl(s);
    if (!u) {
      ctx.addIssue({ code: 'custom', message: 'Must be an http(s) link' });
      return z.NEVER;
    }
    return u;
  });

export const zUsername = z
  .string()
  .max(64)
  .transform(normaliseUsername)
  .pipe(
    z
      .string()
      .regex(USERNAME_RE, { error: '2–32 characters: lowercase letters, numbers, underscore and dot' })
      .refine((u) => !RESERVED_USERNAMES.has(u) && !u.startsWith('deleted_user'), {
        error: 'That username is reserved',
      })
      .refine((u) => !u.includes('..'), { error: 'No double dots' }),
  );

export const RESERVED_USERNAMES = new Set([
  'everyone',
  'here',
  'admin',
  'administrator',
  'system',
  'support',
  'moderator',
  'staff',
  'root',
  'null',
  'undefined',
]);

export const zEmail = z.string().trim().toLowerCase().max(254).pipe(z.email({ error: 'Invalid email address' }));

export const zPassword = z
  .string()
  .min(Limits.PASSWORD_MIN, { error: `At least ${Limits.PASSWORD_MIN} characters` })
  .max(Limits.PASSWORD_MAX);

/** Allowed external image hosts for game/music covers (rendered through our image proxy). */
export const ALLOWED_COVER_HOSTS = ['images.igdb.com', 'media.rawg.io', 'coverartarchive.org', 'archive.org'];

export function isAllowedCoverUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_COVER_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

const zCoverUrl = z
  .string()
  .max(1024)
  .refine(isAllowedCoverUrl, { error: 'Cover must come from the game/music search or be an upload' });

// ---------- auth ----------

export const RegisterSchema = z
  .object({
    username: zUsername,
    email: zEmail,
    password: zPassword,
    inviteCode: z.string().trim().max(64).optional(),
  })
  .strict();

export const LoginSchema = z
  .object({
    login: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(Limits.PASSWORD_MAX),
  })
  .strict();

export const TokenSchema = z.object({ token: z.string().min(16).max(200) }).strict();
export const ForgotPasswordSchema = z.object({ email: zEmail }).strict();
export const ResetPasswordSchema = z.object({ token: z.string().min(16).max(200), password: zPassword }).strict();
export const ChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(Limits.PASSWORD_MAX), newPassword: zPassword })
  .strict();
export const ChangeEmailSchema = z.object({ email: zEmail, password: z.string().min(1).max(Limits.PASSWORD_MAX) }).strict();
export const PasswordConfirmSchema = z.object({ password: z.string().min(1).max(Limits.PASSWORD_MAX) }).strict();
export const ChangeUsernameSchema = z
  .object({ username: zUsername, password: z.string().min(1).max(Limits.PASSWORD_MAX) })
  .strict();

// ---------- profile ----------

export const ProfileThemeSchema = z
  .object({
    primary: zHex.optional(),
    secondary: zHex.optional(),
    angle: z.number().int().min(0).max(360).optional(),
    accent: zHex.optional(),
    font: z.enum(PROFILE_FONTS).optional(),
  })
  .strict();

export const ProfileLinkSchema = z.object({ label: line(32, 1), url: zHttpUrl }).strict();

export const GameRefInputSchema = z
  .object({
    name: line(100, 1),
    source: z.enum(['igdb', 'rawg', 'custom']),
    sourceId: z.string().max(64).regex(/^[\w-]+$/).nullable().optional(),
    coverUrl: zCoverUrl.nullable().optional(),
    coverFileId: zId.nullable().optional(),
  })
  .strict();
export type GameRefInput = z.infer<typeof GameRefInputSchema>;

export const SongRefInputSchema = z
  .object({
    title: line(100, 1),
    artist: line(100, 1),
    coverUrl: zCoverUrl.nullable().optional(),
    coverFileId: zId.nullable().optional(),
  })
  .strict();
export type SongRefInput = z.infer<typeof SongRefInputSchema>;

const widgetId = z.string().regex(/^[A-Za-z0-9_-]{1,24}$/);
const widgetTitle = line(40).optional();

export const WidgetInputSchema = z.discriminatedUnion('type', [
  z.object({ id: widgetId, type: z.literal('games'), title: widgetTitle, items: z.array(GameRefInputSchema).max(6) }).strict(),
  z.object({ id: widgetId, type: z.literal('songs'), title: widgetTitle, items: z.array(SongRefInputSchema).max(6) }).strict(),
  z
    .object({
      id: widgetId,
      type: z.literal('currently_into'),
      title: widgetTitle,
      items: z.array(z.object({ label: line(40, 1), emoji: line(16).optional() }).strict()).max(10),
    })
    .strict(),
  z
    .object({
      id: widgetId,
      type: z.literal('photos'),
      title: widgetTitle,
      items: z.array(z.object({ fileId: zId, caption: line(80).optional() }).strict()).max(6),
    })
    .strict(),
  z.object({ id: widgetId, type: z.literal('text'), title: widgetTitle, content: text(1000) }).strict(),
]);
export type WidgetInput = z.infer<typeof WidgetInputSchema>;

export const ProfileSongInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upload'), fileId: zId, title: line(100, 1) }).strict(),
  z
    .object({
      kind: z.literal('youtube'),
      url: z
        .string()
        .max(300)
        .refine((s) => youtubeId(s) !== null, { error: 'Not a YouTube link' }),
      title: line(100, 1),
    })
    .strict(),
]);

export const ProfilePatchSchema = z
  .object({
    displayName: line(Limits.DISPLAY_NAME_MAX).nullable().optional(),
    bio: text(Limits.BIO_MAX).optional(),
    pronouns: line(Limits.PRONOUNS_MAX).optional(),
    links: z.array(ProfileLinkSchema).max(Limits.PROFILE_LINKS_MAX).optional(),
    theme: ProfileThemeSchema.optional(),
    widgets: z
      .array(WidgetInputSchema)
      .max(Limits.WIDGETS_MAX)
      .refine((w) => new Set(w.map((x) => x.id)).size === w.length, { error: 'Duplicate widget id' })
      .optional(),
    avatarFileId: zId.nullable().optional(),
    bannerFileId: zId.nullable().optional(),
    song: ProfileSongInputSchema.nullable().optional(),
    guestbookEnabled: z.boolean().optional(),
  })
  .strict();
export type ProfilePatch = z.infer<typeof ProfilePatchSchema>;

export const PrivacyPatchSchema = z
  .object({
    lastSeen: z.enum(LastSeenVisibility).optional(),
    readReceipts: z.boolean().optional(),
    dmPolicy: z.enum(DmPolicy).optional(),
    friendRequests: z.enum(FriendRequestPolicy).optional(),
  })
  .strict();

export const StatusSchema = z.object({ status: z.enum(Status) }).strict();

export const CustomStatusSchema = z
  .object({
    text: line(Limits.CUSTOM_STATUS_MAX),
    emoji: line(64).nullable().optional(),
    expiresInSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 86400)
      .nullable()
      .optional(),
  })
  .strict()
  .refine((s) => s.text.length > 0 || !!s.emoji, { error: 'Add some text or an emoji' });

export const PlayingSchema = GameRefInputSchema.extend({ lfg: z.boolean().default(false) }).strict();
export const LfgSchema = z.object({ lfg: z.boolean() }).strict();
export const ListeningSchema = SongRefInputSchema;

export const GuestbookPostSchema = z.object({ content: text(Limits.GUESTBOOK_ENTRY_MAX, 1) }).strict();

// ---------- relationships / DMs ----------

export const FriendRequestSchema = z.object({ username: zUsername }).strict();
export const RelationshipPutSchema = z.object({ type: z.union([z.literal(1), z.literal(2)]) }).strict();
export const CreateDmSchema = z
  .object({ recipientIds: z.array(zId).min(1).max(Limits.GROUP_DM_MAX - 1) })
  .strict()
  .refine((d) => new Set(d.recipientIds).size === d.recipientIds.length, { error: 'Duplicate recipients' });

// ---------- guilds ----------

export const CreateGuildSchema = z
  .object({ name: line(Limits.GUILD_NAME_MAX, 2), iconFileId: zId.nullable().optional() })
  .strict();

export const GuildPatchSchema = z
  .object({
    name: line(Limits.GUILD_NAME_MAX, 2).optional(),
    iconFileId: zId.nullable().optional(),
    bannerFileId: zId.nullable().optional(),
    description: text(300).optional(),
    systemChannelId: zId.nullable().optional(),
  })
  .strict();

export const TransferGuildSchema = z.object({ userId: zId, password: z.string().min(1).max(256) }).strict();

const guildChannelType = z.union([
  z.literal(ChannelType.TEXT),
  z.literal(ChannelType.VOICE),
  z.literal(ChannelType.CATEGORY),
  z.literal(ChannelType.WIKI),
]);

export const CreateChannelSchema = z
  .object({
    name: line(Limits.CHANNEL_NAME_MAX, 1),
    type: guildChannelType,
    parentId: zId.nullable().optional(),
    topic: text(Limits.TOPIC_MAX).optional(),
    userLimit: z.number().int().min(0).max(99).optional(),
    slowmode: z.number().int().min(0).max(21600).optional(),
    private: z.boolean().optional(),
  })
  .strict();

export const ChannelPatchSchema = z
  .object({
    name: line(Limits.CHANNEL_NAME_MAX, 1).optional(),
    topic: text(Limits.TOPIC_MAX).nullable().optional(),
    parentId: zId.nullable().optional(),
    position: z.number().int().min(0).max(10000).optional(),
    slowmode: z.number().int().min(0).max(21600).optional(),
    userLimit: z.number().int().min(0).max(99).optional(),
    // DMs
    disappearingSeconds: z
      .number()
      .int()
      .refine((n) => (DISAPPEARING_OPTIONS as readonly number[]).includes(n), { error: 'Unsupported timer' })
      .optional(),
    iconFileId: zId.nullable().optional(),
    // Threads
    archived: z.boolean().optional(),
    locked: z.boolean().optional(),
    autoArchiveMinutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).optional(),
  })
  .strict();

export const PositionsSchema = z
  .array(z.object({ id: zId, position: z.number().int().min(0).max(10000), parentId: zId.nullable().optional() }).strict())
  .min(1)
  .max(500);

export const OverwriteSchema = z
  .object({ type: z.union([z.literal(0), z.literal(1)]), allow: zBigintString, deny: zBigintString })
  .strict();

export const RoleSchema = z
  .object({
    name: line(Limits.ROLE_NAME_MAX, 1),
    color: z.number().int().min(0).max(0xffffff).default(0),
    hoist: z.boolean().default(false),
    mentionable: z.boolean().default(false),
    permissions: zBigintString.default('0'),
  })
  .strict();

export const RolePatchSchema = z
  .object({
    name: line(Limits.ROLE_NAME_MAX, 1).optional(),
    color: z.number().int().min(0).max(0xffffff).optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
    permissions: zBigintString.optional(),
  })
  .strict();

export const RolePositionsSchema = z
  .array(z.object({ id: zId, position: z.number().int().min(1).max(10000) }).strict())
  .min(1)
  .max(Limits.ROLES_PER_GUILD);

export const reasonField = line(512).optional();

export const MemberPatchSchema = z
  .object({
    nickname: line(32).nullable().optional(),
    roles: z.array(zId).max(Limits.ROLES_PER_GUILD).optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(0)
      .max(28 * 86400)
      .optional(),
    mute: z.boolean().optional(),
    deaf: z.boolean().optional(),
    /** Move to another voice channel; null disconnects. */
    voiceChannelId: zId.nullable().optional(),
    reason: reasonField,
  })
  .strict();

export const SelfMemberPatchSchema = z
  .object({
    nickname: line(32).nullable().optional(),
    avatarFileId: zId.nullable().optional(),
    bio: text(Limits.BIO_MAX).optional(),
  })
  .strict();

export const KickSchema = z.object({ reason: reasonField }).strict();
export const BanSchema = z
  .object({
    reason: reasonField,
    deleteMessageSeconds: z
      .number()
      .int()
      .min(0)
      .max(7 * 86400)
      .default(0),
  })
  .strict();

export const CreateInviteSchema = z
  .object({
    maxAgeSeconds: z
      .number()
      .int()
      .min(0)
      .max(30 * 86400)
      .default(7 * 86400),
    maxUses: z.number().int().min(0).max(1000).default(0),
  })
  .strict();

export const EmojiNameSchema = z.string().regex(/^[A-Za-z0-9_]{2,32}$/, { error: '2–32 letters, numbers or _' });
export const CreateEmojiSchema = z.object({ name: EmojiNameSchema, fileId: zId }).strict();
export const EmojiPatchSchema = z.object({ name: EmojiNameSchema }).strict();
export const CreateStickerSchema = z
  .object({ name: line(30, 2), description: line(100).default(''), fileId: zId })
  .strict();

const keyword = z
  .string()
  .max(60)
  .transform((s) => cleanSingleLine(s).toLowerCase())
  .pipe(z.string().min(1).max(60));

export const AutomodTriggerSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('keyword'),
      keywords: z.array(keyword).min(1).max(Limits.AUTOMOD_KEYWORDS_MAX),
      allow: z.array(keyword).max(100).default([]),
    })
    .strict(),
  z.object({ type: z.literal('mention_spam'), limit: z.number().int().min(2).max(50) }).strict(),
  z
    .object({
      type: z.literal('message_spam'),
      messages: z.number().int().min(2).max(50),
      seconds: z.number().int().min(2).max(120),
    })
    .strict(),
  z.object({ type: z.literal('invite_links') }).strict(),
  z
    .object({
      type: z.literal('link_filter'),
      blockedDomains: z
        .array(
          z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/, { error: 'Domain like example.com or *.example.com' }),
        )
        .min(1)
        .max(500),
    })
    .strict(),
]);

export const AutomodActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('block'), message: line(150).optional() }).strict(),
  z.object({ type: z.literal('alert'), channelId: zId }).strict(),
  z
    .object({
      type: z.literal('timeout'),
      seconds: z
        .number()
        .int()
        .min(60)
        .max(28 * 86400),
    })
    .strict(),
]);

export const AutomodRuleSchema = z
  .object({
    name: line(60, 1),
    enabled: z.boolean().default(true),
    trigger: AutomodTriggerSchema,
    actions: z.array(AutomodActionSchema).min(1).max(3),
    exemptRoles: z.array(zId).max(50).default([]),
    exemptChannels: z.array(zId).max(50).default([]),
  })
  .strict();

export const AutomodRulePatchSchema = z
  .object({
    name: line(60, 1).optional(),
    enabled: z.boolean().optional(),
    trigger: AutomodTriggerSchema.optional(),
    actions: z.array(AutomodActionSchema).min(1).max(3).optional(),
    exemptRoles: z.array(zId).max(50).optional(),
    exemptChannels: z.array(zId).max(50).optional(),
  })
  .strict();

export const LevelSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    announce: z.boolean().optional(),
    announceChannelId: zId.nullable().optional(),
  })
  .strict();

export const LevelRolesSchema = z
  .array(z.object({ level: z.number().int().min(1).max(500), roleId: zId }).strict())
  .max(50);

export const GuildNotificationPatchSchema = z
  .object({
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    suppressEveryone: z.boolean().optional(),
    suppressRoles: z.boolean().optional(),
    /** null unmutes, -1 mutes forever */
    muteSeconds: z
      .number()
      .int()
      .min(-1)
      .max(365 * 86400)
      .nullable()
      .optional(),
  })
  .strict();

export const ChannelNotificationPatchSchema = z
  .object({
    level: z.union([z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]).optional(),
    muteSeconds: z
      .number()
      .int()
      .min(-1)
      .max(365 * 86400)
      .nullable()
      .optional(),
  })
  .strict();

// ---------- messages ----------

export const AttachmentRefSchema = z
  .object({ fileId: zId, spoiler: z.boolean().default(false), description: line(500).optional() })
  .strict();

export const CreateMessageSchema = z
  .object({
    content: text(Limits.MESSAGE_MAX).default(''),
    attachments: z.array(AttachmentRefSchema).max(Limits.ATTACHMENTS_PER_MESSAGE).default([]),
    stickerId: zId.optional(),
    replyTo: z.object({ messageId: zId, ping: z.boolean().default(true) }).strict().optional(),
    silent: z.boolean().default(false),
    suppressEmbeds: z.boolean().default(false),
    nonce: z.string().max(64).optional(),
  })
  .strict()
  .refine((m) => m.content.trim().length > 0 || m.attachments.length > 0 || !!m.stickerId, {
    error: 'Message is empty',
  });
export type CreateMessageInput = z.infer<typeof CreateMessageSchema>;

export const EditMessageSchema = z
  .object({ content: text(Limits.MESSAGE_MAX).optional(), suppressEmbeds: z.boolean().optional() })
  .strict();

export const BulkDeleteSchema = z
  .object({ ids: z.array(zId).min(2).max(100) })
  .strict()
  .refine((d) => new Set(d.ids).size === d.ids.length, { error: 'Duplicate ids' });

export const AckSchema = z.object({ messageId: zId }).strict();

export const MessagesQuerySchema = z
  .object({
    before: zId.optional(),
    after: zId.optional(),
    around: zId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const CreateThreadSchema = z
  .object({
    name: line(Limits.CHANNEL_NAME_MAX, 1),
    messageId: zId.optional(),
    autoArchiveMinutes: z.union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)]).default(1440),
  })
  .strict();

export const ScheduleMessageSchema = z
  .object({
    content: text(Limits.MESSAGE_MAX).default(''),
    attachments: z.array(AttachmentRefSchema).max(Limits.ATTACHMENTS_PER_MESSAGE).default([]),
    replyTo: z.object({ messageId: zId, ping: z.boolean().default(true) }).strict().optional(),
    silent: z.boolean().default(false),
    sendAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((m) => m.content.trim().length > 0 || m.attachments.length > 0, { error: 'Message is empty' });

export const ScheduledPatchSchema = z
  .object({
    content: text(Limits.MESSAGE_MAX).optional(),
    sendAt: z.iso.datetime({ offset: true }).optional(),
    silent: z.boolean().optional(),
  })
  .strict();

export const BookmarkPutSchema = z.object({ folderId: zId.nullable().default(null), note: text(500).default('') }).strict();
export const BookmarkFolderSchema = z.object({ name: line(50, 1) }).strict();

export const SearchQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    authorId: zId.optional(),
    channelId: zId.optional(),
    mentions: zId.optional(),
    has: z
      .union([z.enum(['file', 'image', 'video', 'link', 'embed']), z.array(z.enum(['file', 'image', 'video', 'link', 'embed']))])
      .optional(),
    before: z.iso.date().optional(),
    after: z.iso.date().optional(),
    pinned: z.enum(['true', 'false']).optional(),
    sort: z.enum(['newest', 'oldest', 'relevance']).default('newest'),
    offset: z.coerce.number().int().min(0).max(5000).default(0),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();

// ---------- wiki ----------

export const WikiPageSchema = z
  .object({
    title: line(Limits.WIKI_TITLE_MAX, 1),
    content: text(Limits.WIKI_CONTENT_MAX),
    pinned: z.boolean().default(false),
  })
  .strict();

export const WikiPagePatchSchema = z
  .object({
    title: line(Limits.WIKI_TITLE_MAX, 1).optional(),
    content: text(Limits.WIKI_CONTENT_MAX).optional(),
    pinned: z.boolean().optional(),
    position: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

// ---------- voice / activities ----------

export const VoiceStatePatchSchema = z
  .object({
    selfMute: z.boolean().optional(),
    selfDeaf: z.boolean().optional(),
    video: z.boolean().optional(),
    streaming: z.boolean().optional(),
  })
  .strict();

export const WatchControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('load'), url: z.string().max(300) }).strict(),
  z.object({ action: z.literal('play'), position: z.number().min(0).max(86400 * 2) }).strict(),
  z.object({ action: z.literal('pause'), position: z.number().min(0).max(86400 * 2) }).strict(),
  z.object({ action: z.literal('seek'), position: z.number().min(0).max(86400 * 2) }).strict(),
  z.object({ action: z.literal('rate'), rate: z.union([z.literal(0.5), z.literal(1), z.literal(1.25), z.literal(1.5), z.literal(2)]) }).strict(),
  z.object({ action: z.literal('queue_add'), url: z.string().max(300) }).strict(),
  z.object({ action: z.literal('queue_remove'), index: z.number().int().min(0).max(99) }).strict(),
  z.object({ action: z.literal('next') }).strict(),
  z.object({ action: z.literal('stop') }).strict(),
  z.object({ action: z.literal('ended'), videoId: z.string().max(20) }).strict(),
]);

export const CreateGameSchema = z
  .object({
    kind: z.enum(GameKind),
    options: z
      .object({
        word: z.string().max(40).optional(),
        rounds: z.number().int().min(1).max(10).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export const GameMoveSchema = z.object({ move: z.unknown() }).strict();
