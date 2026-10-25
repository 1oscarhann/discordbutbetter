-- Initial schema. All ids are app-generated snowflakes (bigint, time-sortable).
-- Asset columns (avatar, banner, icon, ...) hold a path like /files/<id>/<secret>/<name>.

CREATE EXTENSION IF NOT EXISTS citext;

-- ============ accounts ============

CREATE TABLE users (
  id                 bigint PRIMARY KEY,
  username           citext NOT NULL UNIQUE,
  display_name       text,
  email              citext UNIQUE,              -- null once the account is deleted
  email_verified     boolean NOT NULL DEFAULT false,
  password_hash      text,                       -- argon2id; null once deleted
  is_admin           boolean NOT NULL DEFAULT false,
  disabled           boolean NOT NULL DEFAULT false,
  deleted            boolean NOT NULL DEFAULT false,

  avatar             text,
  banner             text,
  banner_kind        text CHECK (banner_kind IN ('image', 'video')),
  bio                text NOT NULL DEFAULT '',
  pronouns           text NOT NULL DEFAULT '',
  links              jsonb NOT NULL DEFAULT '[]',
  profile_theme      jsonb NOT NULL DEFAULT '{}',
  widgets            jsonb NOT NULL DEFAULT '[]',
  profile_song       jsonb,
  guestbook_enabled  boolean NOT NULL DEFAULT true,

  status             text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'idle', 'dnd', 'invisible')),
  custom_status      jsonb,
  activity_playing   jsonb,
  activity_listening jsonb,
  last_seen_at       timestamptz,

  last_seen_privacy  text NOT NULL DEFAULT 'everyone' CHECK (last_seen_privacy IN ('everyone', 'friends', 'nobody')),
  read_receipts      boolean NOT NULL DEFAULT true,
  dm_policy          text NOT NULL DEFAULT 'everyone' CHECK (dm_policy IN ('everyone', 'friends')),
  friend_policy      text NOT NULL DEFAULT 'everyone' CHECK (friend_policy IN ('everyone', 'mutual', 'nobody')),

  settings           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Opaque session tokens; only the SHA-256 hash is stored. No IP addresses are kept.
CREATE TABLE sessions (
  id           bigint PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  client       text NOT NULL DEFAULT '',          -- coarse "Firefox on Linux"
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE email_tokens (
  token_hash bytea PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('verify', 'reset')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user ON email_tokens (user_id, kind);

-- Instance-level invite codes, used when REGISTRATION=invite.
CREATE TABLE instance_invites (
  code       text PRIMARY KEY,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  max_uses   int NOT NULL DEFAULT 1,
  uses       int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relationships (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       smallint NOT NULL CHECK (type IN (1, 2, 3, 4)), -- 1 friend, 2 blocked, 3 incoming, 4 outgoing
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id),
  CHECK (user_id <> target_id)
);
CREATE INDEX relationships_target ON relationships (target_id);

-- ============ files ============

CREATE TABLE files (
  id           bigint PRIMARY KEY,
  secret       text NOT NULL,                  -- 128-bit random, part of the url
  owner_id     bigint REFERENCES users(id) ON DELETE SET NULL,
  purpose      text NOT NULL,
  filename     text NOT NULL,
  content_type text NOT NULL,
  size         bigint NOT NULL,
  width        int,
  height       int,
  duration_ms  int,
  animated     boolean NOT NULL DEFAULT false,
  storage_key  text NOT NULL,
  claimed      boolean NOT NULL DEFAULT false, -- false until something references it; unclaimed files are GC'd after 24h
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_unclaimed ON files (created_at) WHERE NOT claimed;

-- ============ guilds ============

CREATE TABLE guilds (
  id                  bigint PRIMARY KEY,
  name                text NOT NULL,
  icon                text,
  banner              text,
  description         text NOT NULL DEFAULT '',
  owner_id            bigint NOT NULL REFERENCES users(id),
  system_channel_id   bigint,
  levels_enabled      boolean NOT NULL DEFAULT true,
  levels_announce     boolean NOT NULL DEFAULT true,
  levels_channel_id   bigint,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- The @everyone role has id = guild id and position 0.
CREATE TABLE roles (
  id          bigint PRIMARY KEY,
  guild_id    bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       int NOT NULL DEFAULT 0,
  hoist       boolean NOT NULL DEFAULT false,
  mentionable boolean NOT NULL DEFAULT false,
  position    int NOT NULL,
  permissions bigint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roles_guild ON roles (guild_id);

CREATE TABLE guild_members (
  guild_id      bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname      text,
  avatar        text,
  bio           text NOT NULL DEFAULT '',
  joined_at     timestamptz NOT NULL DEFAULT now(),
  timeout_until timestamptz,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX guild_members_user ON guild_members (user_id);

CREATE TABLE member_roles (
  guild_id bigint NOT NULL,
  user_id  bigint NOT NULL,
  role_id  bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES guild_members(guild_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role ON member_roles (role_id);

CREATE TABLE bans (
  guild_id   bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     text,
  banned_by  bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

-- ============ channels ============
-- One table for guild channels, DMs, group DMs and threads.
-- type: 0 text, 1 dm, 2 voice, 3 group dm, 4 category, 5 wiki, 10 thread

CREATE TABLE channels (
  id                   bigint PRIMARY KEY,
  type                 smallint NOT NULL,
  guild_id             bigint REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id            bigint REFERENCES channels(id) ON DELETE SET NULL, -- category, or parent channel for threads
  name                 text,
  topic                text,
  position             int NOT NULL DEFAULT 0,
  slowmode             int NOT NULL DEFAULT 0,
  user_limit           int NOT NULL DEFAULT 0,
  last_message_id      bigint,
  -- DMs
  owner_id             bigint REFERENCES users(id) ON DELETE SET NULL,  -- group DM owner / thread creator
  icon                 text,
  dm_key               text UNIQUE,                 -- "<lowId>:<highId>" for 1:1 DMs
  disappearing_seconds int NOT NULL DEFAULT 0,
  -- threads
  starter_message_id   bigint,
  archived             boolean NOT NULL DEFAULT false,
  archived_at          timestamptz,
  locked               boolean NOT NULL DEFAULT false,
  auto_archive_minutes int NOT NULL DEFAULT 1440,
  message_count        int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX channels_guild ON channels (guild_id) WHERE guild_id IS NOT NULL;
CREATE INDEX channels_parent ON channels (parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE permission_overwrites (
  channel_id  bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id   bigint NOT NULL,
  target_type smallint NOT NULL CHECK (target_type IN (0, 1)), -- 0 role, 1 member
  allow       bigint NOT NULL DEFAULT 0,
  deny        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_id)
);

CREATE TABLE dm_recipients (
  channel_id bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  open       boolean NOT NULL DEFAULT true,   -- shown in the DM list
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX dm_recipients_user ON dm_recipients (user_id);

CREATE TABLE invites (
  code       text PRIMARY KEY,
  guild_id   bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id bigint REFERENCES channels(id) ON DELETE SET NULL,
  inviter_id bigint REFERENCES users(id) ON DELETE SET NULL,
  max_uses   int NOT NULL DEFAULT 0,
  uses       int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_guild ON invites (guild_id);

-- ============ messages ============

CREATE TABLE messages (
  id               bigint PRIMARY KEY,
  channel_id       bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id         bigint,
  author_id        bigint REFERENCES users(id) ON DELETE SET NULL,
  type             smallint NOT NULL DEFAULT 0,
  content          text NOT NULL DEFAULT '',
  flags            int NOT NULL DEFAULT 0,
  reply_to_id      bigint,
  mentions         bigint[] NOT NULL DEFAULT '{}',
  mention_roles    bigint[] NOT NULL DEFAULT '{}',
  mention_everyone boolean NOT NULL DEFAULT false,
  sticker_id       bigint,
  embeds           jsonb NOT NULL DEFAULT '[]',
  pinned           boolean NOT NULL DEFAULT false,
  thread_id        bigint,
  metadata         jsonb,
  edited_at        timestamptz,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  search           tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX messages_channel ON messages (channel_id, id DESC);
CREATE INDEX messages_guild_author ON messages (guild_id, author_id, id DESC);
CREATE INDEX messages_search ON messages USING gin (search);
CREATE INDEX messages_expires ON messages (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX messages_pinned ON messages (channel_id) WHERE pinned;
CREATE INDEX messages_mentions ON messages USING gin (mentions);

-- Previous versions of edited messages (shown as edit history).
CREATE TABLE message_edits (
  id          bigserial PRIMARY KEY,
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content     text NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_edits_message ON message_edits (message_id, id);

CREATE TABLE message_attachments (
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id     bigint NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position    smallint NOT NULL DEFAULT 0,
  spoiler     boolean NOT NULL DEFAULT false,
  description text,
  PRIMARY KEY (message_id, file_id)
);
CREATE INDEX message_attachments_file ON message_attachments (file_id);

-- emoji: a unicode emoji, or "c:<custom emoji id>"
CREATE TABLE reactions (
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, emoji, user_id)
);

CREATE TABLE read_states (
  user_id       bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id  bigint NOT NULL DEFAULT 0,
  mention_count int NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX read_states_channel ON read_states (channel_id);

CREATE TABLE scheduled_messages (
  id          bigint PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  content     text NOT NULL DEFAULT '',
  flags       int NOT NULL DEFAULT 0,
  reply_to_id bigint,
  reply_ping  boolean NOT NULL DEFAULT true,
  attachments jsonb NOT NULL DEFAULT '[]',   -- [{fileId, spoiler, description}]
  send_at     timestamptz NOT NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scheduled_due ON scheduled_messages (send_at) WHERE error IS NULL;
CREATE INDEX scheduled_user ON scheduled_messages (user_id);

CREATE TABLE bookmark_folders (
  id         bigint PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bookmark_folders_user ON bookmark_folders (user_id);

CREATE TABLE bookmarks (
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  folder_id  bigint REFERENCES bookmark_folders(id) ON DELETE SET NULL,
  note       text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- ============ notifications ============

CREATE TABLE guild_notification_settings (
  user_id           bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guild_id          bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  level             smallint NOT NULL DEFAULT 1,  -- 0 all, 1 mentions, 2 nothing
  suppress_everyone boolean NOT NULL DEFAULT false,
  suppress_roles    boolean NOT NULL DEFAULT false,
  muted_until       timestamptz,
  PRIMARY KEY (user_id, guild_id)
);

CREATE TABLE channel_notification_settings (
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  level       smallint NOT NULL DEFAULT -1, -- -1 inherit
  muted_until timestamptz,
  PRIMARY KEY (user_id, channel_id)
);

-- ============ emoji / stickers ============

CREATE TABLE guild_emojis (
  id         bigint PRIMARY KEY,
  guild_id   bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name       text NOT NULL,
  url        text NOT NULL,
  animated   boolean NOT NULL DEFAULT false,
  creator_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name)
);

CREATE TABLE guild_stickers (
  id          bigint PRIMARY KEY,
  guild_id    bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  url         text NOT NULL,
  format      text NOT NULL,
  creator_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guild_stickers_guild ON guild_stickers (guild_id);

-- ============ moderation ============

CREATE TABLE audit_log (
  id          bigint PRIMARY KEY,
  guild_id    bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  actor_id    bigint REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   bigint,
  changes     jsonb,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_guild ON audit_log (guild_id, id DESC);

CREATE TABLE automod_rules (
  id              bigint PRIMARY KEY,
  guild_id        bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name            text NOT NULL,
  enabled         boolean NOT NULL DEFAULT true,
  trigger         jsonb NOT NULL,
  actions         jsonb NOT NULL,
  exempt_roles    bigint[] NOT NULL DEFAULT '{}',
  exempt_channels bigint[] NOT NULL DEFAULT '{}',
  creator_id      bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automod_rules_guild ON automod_rules (guild_id);

-- ============ wiki ============

CREATE TABLE wiki_pages (
  id         bigint PRIMARY KEY,
  channel_id bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text NOT NULL DEFAULT '',
  position   int NOT NULL DEFAULT 0,
  pinned     boolean NOT NULL DEFAULT false,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_pages_channel ON wiki_pages (channel_id, position);

CREATE TABLE wiki_revisions (
  id         bigint PRIMARY KEY,
  page_id    bigint NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title      text NOT NULL,
  content    text NOT NULL,
  editor_id  bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wiki_revisions_page ON wiki_revisions (page_id, id DESC);

-- ============ levels ============

CREATE TABLE member_xp (
  guild_id   bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  xp         bigint NOT NULL DEFAULT 0,
  level      int NOT NULL DEFAULT 0,
  messages   int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX member_xp_rank ON member_xp (guild_id, xp DESC);

CREATE TABLE level_roles (
  guild_id bigint NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  level    int NOT NULL,
  role_id  bigint NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, level, role_id)
);

-- ============ profiles ============

CREATE TABLE guestbook_entries (
  id         bigint PRIMARY KEY,
  profile_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_id  bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guestbook_profile ON guestbook_entries (profile_id, id DESC);
