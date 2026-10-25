import type { ClientSettings } from './settings.js';
import type {
  BookmarkFolder,
  Channel,
  ChannelNotificationSettings,
  CustomEmoji,
  GameSession,
  Guild,
  GuildMember,
  GuildNotificationSettings,
  Id,
  Message,
  Presence,
  PublicUser,
  ReadState,
  ReadyPayload,
  Relationship,
  Role,
  ScheduledMessage,
  SelfUser,
  Sticker,
  VoiceState,
  WatchState,
  WikiPage,
  FullGuild,
} from './types.js';

/**
 * Gateway protocol (JSON over a single WebSocket at /gateway, authenticated by the session cookie).
 *
 * server -> client: { op: 'hello' | 'heartbeat_ack' | 'dispatch' | 'invalid_session' | 'reconnect', t?, d? }
 * client -> server: { op: 'heartbeat' | 'idle' | 'typing', d }
 */

export const HEARTBEAT_INTERVAL_MS = 30_000;

export type ClientMessage =
  | { op: 'heartbeat'; d: { t: number } }
  /** Client-side idle detection: true after 10 minutes without input, false on activity. */
  | { op: 'idle'; d: { idle: boolean } }
  | { op: 'typing'; d: { channelId: Id } };

export interface GatewayEvents {
  READY: ReadyPayload;
  /** Public info of some user changed (name, avatar). */
  USER_UPDATE: PublicUser;
  /** Your own account changed (from another tab/device or the server). */
  SELF_UPDATE: SelfUser;
  SETTINGS_UPDATE: ClientSettings;
  PRESENCE_UPDATE: Presence;
  RELATIONSHIP_ADD: Relationship;
  RELATIONSHIP_REMOVE: { userId: Id };

  GUILD_CREATE: FullGuild;
  GUILD_UPDATE: Guild;
  GUILD_DELETE: { id: Id };
  GUILD_MEMBER_ADD: GuildMember;
  GUILD_MEMBER_UPDATE: GuildMember;
  GUILD_MEMBER_REMOVE: { guildId: Id; userId: Id };
  GUILD_ROLE_CREATE: Role;
  GUILD_ROLE_UPDATE: Role;
  GUILD_ROLE_DELETE: { guildId: Id; roleId: Id };
  GUILD_EMOJIS_UPDATE: { guildId: Id; emojis: CustomEmoji[] };
  GUILD_STICKERS_UPDATE: { guildId: Id; stickers: Sticker[] };
  /** Your effective guild-level permissions changed. Channel visibility changes arrive as CHANNEL_CREATE/DELETE. */
  GUILD_PERMISSIONS_UPDATE: { guildId: Id; permissions: string };

  CHANNEL_CREATE: Channel;
  CHANNEL_UPDATE: Channel;
  CHANNEL_DELETE: { id: Id; guildId: Id | null };
  CHANNEL_PINS_UPDATE: { channelId: Id; guildId: Id | null };
  THREAD_CREATE: Channel;
  THREAD_UPDATE: Channel;
  THREAD_DELETE: { id: Id; guildId: Id; parentId: Id };

  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: Message;
  MESSAGE_DELETE: { id: Id; channelId: Id; guildId: Id | null };
  MESSAGE_DELETE_BULK: { ids: Id[]; channelId: Id; guildId: Id | null };
  MESSAGE_REACTION_ADD: { channelId: Id; messageId: Id; userId: Id; emoji: string; name?: string; animated?: boolean };
  MESSAGE_REACTION_REMOVE: { channelId: Id; messageId: Id; userId: Id; emoji: string };
  MESSAGE_REACTION_REMOVE_EMOJI: { channelId: Id; messageId: Id; emoji: string };
  /** Your read position moved (sync between your own tabs/devices). */
  MESSAGE_ACK: ReadState;
  /** Someone read up to messageId in a DM. Only sent when both of you have read receipts on. */
  DM_READ_RECEIPT: { channelId: Id; userId: Id; messageId: Id };
  TYPING_START: { channelId: Id; guildId: Id | null; userId: Id; at: number };

  VOICE_STATE_UPDATE: VoiceState | { guildId: Id; userId: Id; channelId: null };
  /** The server moved you to another voice channel (or disconnected you when channelId is null). */
  VOICE_MOVE: { guildId: Id; channelId: Id | null };
  WATCH_STATE: WatchState;
  GAME_UPDATE: GameSession;
  GAME_DELETE: { id: Id; channelId: Id };

  WIKI_PAGE_CREATE: WikiPage;
  WIKI_PAGE_UPDATE: WikiPage;
  WIKI_PAGE_DELETE: { id: Id; channelId: Id };

  SCHEDULED_MESSAGE_CREATE: ScheduledMessage;
  SCHEDULED_MESSAGE_UPDATE: ScheduledMessage;
  SCHEDULED_MESSAGE_DELETE: { id: Id; sentMessageId: Id | null };

  BOOKMARK_UPDATE: { messageId: Id; folderId: Id | null; note: string };
  BOOKMARK_DELETE: { messageId: Id };
  BOOKMARK_FOLDERS_UPDATE: { folders: BookmarkFolder[] };

  NOTIFICATION_SETTINGS_UPDATE: {
    guild?: GuildNotificationSettings;
    channel?: ChannelNotificationSettings;
  };

  /** This session was logged out (password change, "log out everywhere"). */
  SESSION_REVOKED: Record<string, never>;
}

export type GatewayEventName = keyof GatewayEvents;

export type ServerMessage =
  | { op: 'hello'; d: { heartbeatInterval: number } }
  | { op: 'heartbeat_ack'; d: { t: number; server: number } }
  | { op: 'invalid_session' }
  | { op: 'reconnect' }
  | { [K in GatewayEventName]: { op: 'dispatch'; t: K; d: GatewayEvents[K] } }[GatewayEventName];

export type DispatchOf<K extends GatewayEventName> = { op: 'dispatch'; t: K; d: GatewayEvents[K] };
