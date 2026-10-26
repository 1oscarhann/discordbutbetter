import type {
  ChannelTypeValue,
  GameKindValue,
  MessageTypeValue,
  ProfileFont,
  RelationshipTypeValue,
  StatusValue,
  VisibleStatus,
} from './constants.js';
import type { ClientSettings } from './settings.js';

/** Snowflake ids are always strings on the wire. Permission bitfields are decimal strings. */
export type Id = string;

/** Path to a stored file, e.g. "/files/123/abcdef/name.png". */
export type AssetUrl = string;

export interface ProfileTheme {
  primary?: string;
  secondary?: string;
  angle?: number;
  accent?: string;
  font?: ProfileFont;
}

export interface ProfileLink {
  label: string;
  url: string;
}

export interface GameRef {
  name: string;
  /** Either a stored asset url or an external url from the game database (shown via the image proxy). */
  cover?: string | null;
  source: 'igdb' | 'rawg' | 'custom';
  sourceId?: string | null;
}

export interface SongRef {
  title: string;
  artist: string;
  cover?: string | null;
}

export type ProfileWidget =
  | { id: string; type: 'games'; title?: string; items: GameRef[] }
  | { id: string; type: 'songs'; title?: string; items: SongRef[] }
  | { id: string; type: 'currently_into'; title?: string; items: { label: string; emoji?: string }[] }
  | { id: string; type: 'photos'; title?: string; items: { url: AssetUrl; caption?: string }[] }
  | { id: string; type: 'text'; title?: string; content: string };

export type ProfileSong =
  | { kind: 'upload'; url: AssetUrl; title: string; durationMs?: number }
  | { kind: 'youtube'; videoId: string; title: string; start?: number };

export interface CustomStatus {
  text: string;
  emoji?: string | null;
  expiresAt?: string | null;
}

export interface PlayingActivity extends GameRef {
  lfg: boolean;
  since: string;
}

export interface ListeningActivity extends SongRef {
  since: string;
}

/** Minimal user info shown next to messages, member lists etc. */
export interface PublicUser {
  id: Id;
  username: string;
  displayName: string | null;
  avatar: AssetUrl | null;
  deleted?: boolean;
}

/** Full profile when someone opens a profile card. */
export interface UserProfile extends PublicUser {
  banner: AssetUrl | null;
  bannerKind: 'image' | 'video' | null;
  bio: string;
  pronouns: string;
  links: ProfileLink[];
  theme: ProfileTheme;
  widgets: ProfileWidget[];
  song: ProfileSong | null;
  guestbookEnabled: boolean;
  createdAt: string;
  /** Present when viewed in a server context. */
  member?: GuildMemberProfile | null;
  mutualGuilds: Id[];
  mutualFriends: PublicUser[];
  relationship: RelationshipTypeValue | null;
  presence: Presence;
}

export interface GuildMemberProfile {
  nickname: string | null;
  avatar: AssetUrl | null;
  bio: string;
  joinedAt: string;
  roles: Id[];
}

export interface Presence {
  userId: Id;
  status: VisibleStatus;
  customStatus: CustomStatus | null;
  playing: PlayingActivity | null;
  listening: ListeningActivity | null;
  /** Only present when offline and the user's privacy setting lets you see it. */
  lastSeenAt: string | null;
}

/** The logged-in user. */
export interface SelfUser extends PublicUser {
  email: string;
  emailVerified: boolean;
  isAdmin: boolean;
  status: StatusValue;
  customStatus: CustomStatus | null;
  playing: PlayingActivity | null;
  listening: ListeningActivity | null;
  privacy: PrivacySettings;
  createdAt: string;
}

export interface PrivacySettings {
  lastSeen: 'everyone' | 'friends' | 'nobody';
  readReceipts: boolean;
  dmPolicy: 'everyone' | 'friends';
  friendRequests: 'everyone' | 'mutual' | 'nobody';
}

export interface Role {
  id: Id;
  guildId: Id;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  permissions: string;
}

export interface Overwrite {
  id: Id;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface Channel {
  id: Id;
  type: ChannelTypeValue;
  guildId: Id | null;
  parentId: Id | null;
  name: string | null;
  topic: string | null;
  position: number;
  slowmode: number;
  userLimit: number;
  overwrites: Overwrite[];
  lastMessageId: Id | null;
  // DMs
  recipients?: PublicUser[];
  ownerId?: Id | null;
  icon?: AssetUrl | null;
  disappearingSeconds?: number;
  // Threads
  threadMeta?: ThreadMeta | null;
  createdAt: string;
}

export interface ThreadMeta {
  starterMessageId: Id | null;
  archived: boolean;
  locked: boolean;
  archivedAt: string | null;
  autoArchiveMinutes: number;
  messageCount: number;
  ownerId: Id;
}

export interface GuildMember {
  guildId: Id;
  user: PublicUser;
  nickname: string | null;
  avatar: AssetUrl | null;
  roles: Id[];
  joinedAt: string;
  timeoutUntil: string | null;
}

export interface Guild {
  id: Id;
  name: string;
  icon: AssetUrl | null;
  banner: AssetUrl | null;
  description: string;
  ownerId: Id;
  systemChannelId: Id | null;
  levels: LevelSettings;
  createdAt: string;
}

export interface LevelSettings {
  enabled: boolean;
  announceChannelId: Id | null;
  announce: boolean;
}

/** Sent in READY / GUILD_CREATE. Only channels the user can view are included. */
export interface FullGuild extends Guild {
  roles: Role[];
  channels: Channel[];
  threads: Channel[];
  members: GuildMember[];
  emojis: CustomEmoji[];
  stickers: Sticker[];
  voiceStates: VoiceState[];
  /** The user's effective guild-level permissions. */
  permissions: string;
}

export interface CustomEmoji {
  id: Id;
  guildId: Id;
  name: string;
  animated: boolean;
  url: AssetUrl;
}

export interface Sticker {
  id: Id;
  guildId: Id;
  name: string;
  description: string;
  url: AssetUrl;
  format: 'png' | 'apng' | 'gif' | 'webp';
}

export interface Attachment {
  id: Id;
  filename: string;
  contentType: string;
  size: number;
  url: AssetUrl;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  spoiler: boolean;
  description: string | null;
}

export interface Embed {
  type: 'link' | 'image' | 'video' | 'youtube';
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  color?: string;
  /** Always a proxied url (our own /api/proxy/image), never a third-party url. */
  image?: { url: string; width?: number; height?: number };
  thumbnail?: { url: string; width?: number; height?: number };
  youtubeId?: string;
}

export interface ReactionSummary {
  emoji: string; // unicode emoji, or "c:<id>" for custom
  name?: string; // custom emoji name
  animated?: boolean;
  count: number;
  me: boolean;
}

export interface MessageReference {
  id: Id;
  author: PublicUser | null;
  content: string;
  hasAttachments: boolean;
  deleted: boolean;
}

export interface Message {
  id: Id;
  channelId: Id;
  guildId: Id | null;
  author: PublicUser | null;
  type: MessageTypeValue;
  content: string;
  flags: number;
  replyTo: MessageReference | null;
  mentions: Id[];
  mentionRoles: Id[];
  mentionEveryone: boolean;
  attachments: Attachment[];
  embeds: Embed[];
  sticker: Sticker | null;
  reactions: ReactionSummary[];
  pinned: boolean;
  threadId: Id | null;
  editedAt: string | null;
  expiresAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  nonce?: string;
}

export interface MessageEdit {
  content: string;
  /** When this version was replaced by the next one. */
  replacedAt: string;
}

export interface ReadState {
  channelId: Id;
  lastReadId: Id;
  mentionCount: number;
}

export interface Relationship {
  user: PublicUser;
  type: RelationshipTypeValue;
  since: string;
}

export interface VoiceState {
  guildId: Id;
  channelId: Id;
  userId: Id;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  video: boolean;
  streaming: boolean;
}

export interface GuildNotificationSettings {
  guildId: Id;
  level: 0 | 1 | 2;
  suppressEveryone: boolean;
  suppressRoles: boolean;
  mutedUntil: string | null;
}

export interface ChannelNotificationSettings {
  channelId: Id;
  level: -1 | 0 | 1 | 2;
  mutedUntil: string | null;
}

export interface Invite {
  code: string;
  guild: Pick<Guild, 'id' | 'name' | 'icon' | 'description'> & { memberCount: number; onlineCount: number };
  channelId: Id | null;
  inviter: PublicUser | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface Ban {
  user: PublicUser;
  reason: string | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: Id;
  guildId: Id;
  actor: PublicUser | null;
  action: string;
  targetType: string | null;
  targetId: Id | null;
  changes: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
}

export interface AutomodRule {
  id: Id;
  guildId: Id;
  name: string;
  enabled: boolean;
  trigger:
    | { type: 'keyword'; keywords: string[]; allow: string[] }
    | { type: 'mention_spam'; limit: number }
    | { type: 'message_spam'; messages: number; seconds: number }
    | { type: 'invite_links' }
    | { type: 'link_filter'; blockedDomains: string[] };
  actions: AutomodAction[];
  exemptRoles: Id[];
  exemptChannels: Id[];
  createdAt: string;
}

export type AutomodAction =
  | { type: 'block'; message?: string }
  | { type: 'alert'; channelId: Id }
  | { type: 'timeout'; seconds: number };

export interface ScheduledMessage {
  id: Id;
  channelId: Id;
  content: string;
  flags: number;
  replyToId: Id | null;
  attachments: Attachment[];
  sendAt: string;
  createdAt: string;
  error: string | null;
}

export interface BookmarkFolder {
  id: Id;
  name: string;
  position: number;
}

export interface Bookmark {
  message: Message;
  folderId: Id | null;
  note: string;
  createdAt: string;
  channelName: string | null;
  guildName: string | null;
}

export interface WikiPage {
  id: Id;
  channelId: Id;
  title: string;
  content: string;
  position: number;
  pinned: boolean;
  createdBy: PublicUser | null;
  updatedBy: PublicUser | null;
  createdAt: string;
  updatedAt: string;
}

export interface WikiRevision {
  id: Id;
  title: string;
  content: string;
  editor: PublicUser | null;
  createdAt: string;
}

export interface LevelEntry {
  user: PublicUser;
  xp: number;
  level: number;
  messages: number;
  rank: number;
}

export interface LevelRole {
  level: number;
  roleId: Id;
}

export interface GuestbookEntry {
  id: Id;
  author: PublicUser;
  content: string;
  createdAt: string;
}

export interface WatchState {
  channelId: Id;
  videoId: string | null;
  title: string | null;
  playing: boolean;
  /** Seconds into the video at `updatedAt`. */
  position: number;
  /** Server time in ms. */
  updatedAt: number;
  rate: number;
  queue: { videoId: string; title: string; addedBy: Id }[];
  controller: Id | null;
}

export interface GameSession {
  id: Id;
  kind: GameKindValue;
  channelId: Id;
  hostId: Id;
  players: PublicUser[];
  status: 'lobby' | 'playing' | 'finished';
  /** Game-specific public view (hidden info stripped for the viewer). */
  view: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: Id;
  current: boolean;
  client: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface SearchResult {
  total: number;
  messages: Message[];
  /** Channel names for results, so the UI can label them. */
  channels: Record<Id, { name: string | null; guildId: Id | null }>;
}

export interface InstanceInfo {
  name: string;
  registration: 'open' | 'invite' | 'closed';
  emailEnabled: boolean;
  voiceEnabled: boolean;
  gameSearch: boolean;
  musicSearch: boolean;
  limits: {
    uploadBytes: number;
    avatarBytes: number;
    emojiBytes: number;
    emojisPerGuild: number;
    stickersPerGuild: number;
  };
}

export interface ReadyPayload {
  user: SelfUser;
  settings: ClientSettings;
  guilds: FullGuild[];
  dms: Channel[];
  relationships: Relationship[];
  readStates: ReadState[];
  presences: Presence[];
  guildNotificationSettings: GuildNotificationSettings[];
  channelNotificationSettings: ChannelNotificationSettings[];
  bookmarkFolders: BookmarkFolder[];
  instance: InstanceInfo;
  sessionId: Id;
  serverTime: number;
}

// ---------- instance admin ----------

export interface AdminStats {
  users: number;
  disabledUsers: number;
  servers: number;
  messages: number;
  files: number;
  fileBytes: number;
  registration: InstanceInfo['registration'];
  emailEnabled: boolean;
  voiceEnabled: boolean;
}

export interface AdminUser extends PublicUser {
  email: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  serverCount: number;
}

export interface AdminInvite {
  code: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
  createdBy: PublicUser | null;
}

export interface AdminGuild {
  id: Id;
  name: string;
  icon: AssetUrl | null;
  owner: PublicUser | null;
  memberCount: number;
  messageCount: number;
  createdAt: string;
}
