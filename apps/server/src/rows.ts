/** Row shapes as returned by postgres.js (bigint columns come back as strings). */

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  email_verified: boolean;
  password_hash: string | null;
  is_admin: boolean;
  disabled: boolean;
  deleted: boolean;
  avatar: string | null;
  banner: string | null;
  banner_kind: 'image' | 'video' | null;
  bio: string;
  pronouns: string;
  links: unknown;
  profile_theme: unknown;
  widgets: unknown;
  profile_song: unknown;
  guestbook_enabled: boolean;
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  custom_status: { text: string; emoji?: string | null; expiresAt?: string | null } | null;
  activity_playing: Record<string, unknown> | null;
  activity_listening: Record<string, unknown> | null;
  last_seen_at: Date | null;
  last_seen_privacy: 'everyone' | 'friends' | 'nobody';
  read_receipts: boolean;
  dm_policy: 'everyone' | 'friends';
  friend_policy: 'everyone' | 'mutual' | 'nobody';
  settings: unknown;
  created_at: Date;
}

export interface ChannelRow {
  id: string;
  type: number;
  guild_id: string | null;
  parent_id: string | null;
  name: string | null;
  topic: string | null;
  position: number;
  slowmode: number;
  user_limit: number;
  last_message_id: string | null;
  owner_id: string | null;
  icon: string | null;
  dm_key: string | null;
  disappearing_seconds: number;
  starter_message_id: string | null;
  archived: boolean;
  archived_at: Date | null;
  locked: boolean;
  auto_archive_minutes: number;
  message_count: number;
  created_at: Date;
}

export interface GuildRow {
  id: string;
  name: string;
  icon: string | null;
  banner: string | null;
  description: string;
  owner_id: string;
  system_channel_id: string | null;
  levels_enabled: boolean;
  levels_announce: boolean;
  levels_channel_id: string | null;
  created_at: Date;
}

export interface RoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  position: number;
  permissions: string;
}

export interface OverwriteRow {
  channel_id: string;
  target_id: string;
  target_type: 0 | 1;
  allow: string;
  deny: string;
}

export interface MemberRow {
  guild_id: string;
  user_id: string;
  nickname: string | null;
  avatar: string | null;
  bio: string;
  joined_at: Date;
  timeout_until: Date | null;
}

export interface FileRow {
  id: string;
  secret: string;
  owner_id: string | null;
  purpose: string;
  filename: string;
  content_type: string;
  size: string;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  animated: boolean;
  storage_key: string;
  claimed: boolean;
  created_at: Date;
}

export const USER_PUBLIC_JSON = (alias: string) =>
  `json_build_object('id', ${alias}.id::text, 'username', ${alias}.username::text, 'displayName', ${alias}.display_name, 'avatar', ${alias}.avatar, 'deleted', ${alias}.deleted)`;
