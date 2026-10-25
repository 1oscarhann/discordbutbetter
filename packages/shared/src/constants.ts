export const ChannelType = {
  TEXT: 0,
  DM: 1,
  VOICE: 2,
  GROUP_DM: 3,
  CATEGORY: 4,
  WIKI: 5,
  THREAD: 10,
} as const;
export type ChannelTypeValue = (typeof ChannelType)[keyof typeof ChannelType];

export const GUILD_CHANNEL_TYPES: readonly ChannelTypeValue[] = [
  ChannelType.TEXT,
  ChannelType.VOICE,
  ChannelType.CATEGORY,
  ChannelType.WIKI,
];
export const TEXT_LIKE_TYPES: readonly ChannelTypeValue[] = [
  ChannelType.TEXT,
  ChannelType.DM,
  ChannelType.GROUP_DM,
  ChannelType.THREAD,
  ChannelType.VOICE, // voice channels have a text chat too
];

export function isDmType(t: number): boolean {
  return t === ChannelType.DM || t === ChannelType.GROUP_DM;
}

export const MessageType = {
  DEFAULT: 0,
  MEMBER_JOIN: 1,
  THREAD_CREATED: 2,
  PIN: 3,
  DISAPPEARING_CHANGED: 4,
  LEVEL_UP: 5,
  GAME: 6,
  RECIPIENT_ADD: 7,
  RECIPIENT_REMOVE: 8,
  CHANNEL_NAME_CHANGE: 9,
  AUTOMOD_ALERT: 10,
  CHANNEL_ICON_CHANGE: 11,
  WATCH_TOGETHER: 12,
} as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export const MessageFlags = {
  /** Silent send: nobody gets pinged or notified. */
  SILENT: 1 << 0,
  SUPPRESS_EMBEDS: 1 << 1,
  /** A reply that pings the replied-to author. */
  REPLY_PING: 1 << 2,
  /** Was sent via "send later". */
  SCHEDULED: 1 << 3,
} as const;

export const Status = ['online', 'idle', 'dnd', 'invisible'] as const;
export type StatusValue = (typeof Status)[number];
/** What other people see. */
export type VisibleStatus = 'online' | 'idle' | 'dnd' | 'offline';

export const RelationshipType = {
  FRIEND: 1,
  BLOCKED: 2,
  INCOMING: 3,
  OUTGOING: 4,
} as const;
export type RelationshipTypeValue = (typeof RelationshipType)[keyof typeof RelationshipType];

export const NotificationLevel = {
  ALL: 0,
  MENTIONS: 1,
  NOTHING: 2,
  /** Channels only: follow the server setting. */
  INHERIT: -1,
} as const;

export const LastSeenVisibility = ['everyone', 'friends', 'nobody'] as const;
export const DmPolicy = ['everyone', 'friends'] as const;
export const FriendRequestPolicy = ['everyone', 'mutual', 'nobody'] as const;

export const DISAPPEARING_OPTIONS = [0, 300, 3600, 8 * 3600, 86400, 7 * 86400, 30 * 86400] as const;

export const AuditAction = {
  GUILD_UPDATE: 'guild_update',
  CHANNEL_CREATE: 'channel_create',
  CHANNEL_UPDATE: 'channel_update',
  CHANNEL_DELETE: 'channel_delete',
  OVERWRITE_UPDATE: 'overwrite_update',
  OVERWRITE_DELETE: 'overwrite_delete',
  ROLE_CREATE: 'role_create',
  ROLE_UPDATE: 'role_update',
  ROLE_DELETE: 'role_delete',
  MEMBER_ROLE_UPDATE: 'member_role_update',
  MEMBER_UPDATE: 'member_update',
  MEMBER_KICK: 'member_kick',
  MEMBER_BAN: 'member_ban',
  MEMBER_UNBAN: 'member_unban',
  MEMBER_TIMEOUT: 'member_timeout',
  MEMBER_VOICE_UPDATE: 'member_voice_update',
  MEMBER_VOICE_MOVE: 'member_voice_move',
  MEMBER_VOICE_DISCONNECT: 'member_voice_disconnect',
  MESSAGE_DELETE: 'message_delete',
  MESSAGE_BULK_DELETE: 'message_bulk_delete',
  MESSAGE_PIN: 'message_pin',
  MESSAGE_UNPIN: 'message_unpin',
  INVITE_CREATE: 'invite_create',
  INVITE_DELETE: 'invite_delete',
  EMOJI_CREATE: 'emoji_create',
  EMOJI_UPDATE: 'emoji_update',
  EMOJI_DELETE: 'emoji_delete',
  STICKER_CREATE: 'sticker_create',
  STICKER_DELETE: 'sticker_delete',
  THREAD_UPDATE: 'thread_update',
  THREAD_DELETE: 'thread_delete',
  AUTOMOD_RULE_CREATE: 'automod_rule_create',
  AUTOMOD_RULE_UPDATE: 'automod_rule_update',
  AUTOMOD_RULE_DELETE: 'automod_rule_delete',
  AUTOMOD_BLOCK: 'automod_block',
  AUTOMOD_TIMEOUT: 'automod_timeout',
  WIKI_PAGE_CREATE: 'wiki_page_create',
  WIKI_PAGE_UPDATE: 'wiki_page_update',
  WIKI_PAGE_DELETE: 'wiki_page_delete',
  LEVEL_SETTINGS_UPDATE: 'level_settings_update',
} as const;
export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** Hard limits that are not host-configurable. Upload sizes are set by the host via env. */
export const Limits = {
  USERNAME_MIN: 2,
  USERNAME_MAX: 32,
  DISPLAY_NAME_MAX: 32,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 256,
  MESSAGE_MAX: 4000,
  ATTACHMENTS_PER_MESSAGE: 10,
  BIO_MAX: 1000,
  PRONOUNS_MAX: 40,
  PROFILE_LINKS_MAX: 5,
  WIDGETS_MAX: 8,
  CUSTOM_STATUS_MAX: 128,
  GUILD_NAME_MAX: 100,
  CHANNEL_NAME_MAX: 100,
  TOPIC_MAX: 1024,
  ROLE_NAME_MAX: 100,
  ROLES_PER_GUILD: 250,
  CHANNELS_PER_GUILD: 500,
  GROUP_DM_MAX: 10,
  REACTIONS_PER_MESSAGE: 20,
  GUESTBOOK_ENTRY_MAX: 200,
  WIKI_TITLE_MAX: 120,
  WIKI_CONTENT_MAX: 50000,
  AUTOMOD_KEYWORDS_MAX: 1000,
  AUTOMOD_RULES_MAX: 25,
  BOOKMARK_FOLDERS_MAX: 50,
  SCHEDULED_PER_USER: 100,
  SCHEDULE_MAX_DAYS: 365,
  SAVED_THEMES_MAX: 25,
  FRIENDS_MAX: 1000,
  GUILDS_PER_USER: 200,
  PROFILE_SONG_SECONDS: 60,
  BANNER_VIDEO_SECONDS: 15,
} as const;

export const PROFILE_FONTS = [
  'default',
  'inter',
  'space-grotesk',
  'lora',
  'playfair',
  'jetbrains-mono',
  'comic-neue',
  'pixel',
  'pacifico',
] as const;
export type ProfileFont = (typeof PROFILE_FONTS)[number];

export const PROFILE_FONT_LABELS: Record<ProfileFont, string> = {
  default: 'App default',
  inter: 'Inter',
  'space-grotesk': 'Space Grotesk',
  lora: 'Lora (serif)',
  playfair: 'Playfair Display',
  'jetbrains-mono': 'JetBrains Mono',
  'comic-neue': 'Comic Neue',
  pixel: 'Pixel (Press Start 2P)',
  pacifico: 'Pacifico (script)',
};

export const FilePurpose = [
  'attachment',
  'avatar',
  'banner',
  'guild_icon',
  'guild_banner',
  'emoji',
  'sticker',
  'profile_song',
  'widget_photo',
  'game_cover',
  'music_cover',
  'group_icon',
  'member_avatar',
] as const;
export type FilePurposeValue = (typeof FilePurpose)[number];

export const GameKind = ['tictactoe', 'connect4', 'hangman', 'anagram'] as const;
export type GameKindValue = (typeof GameKind)[number];

export const SNOWFLAKE_EPOCH = 1767225600000; // 2026-01-01T00:00:00Z

export function snowflakeTime(id: string): number {
  return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH;
}

/** Smallest id that could have been created at `ms` — handy for "after this time" queries. */
export function snowflakeFromTime(ms: number): string {
  return (BigInt(Math.max(0, ms - SNOWFLAKE_EPOCH)) << 22n).toString();
}

export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
