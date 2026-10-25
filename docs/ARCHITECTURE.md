# Architecture

## Overview

```
                 ┌──────────────── one VPS / Raspberry Pi ────────────────┐
 browser /       │                                                         │
 Tauri app ──────┼─► Caddy (TLS, :443) ─┬─► app  (Node 22, Fastify)        │
                 │                      │     ├─ REST  /api/*              │
                 │                      │     ├─ WS    /gateway            │
                 │                      │     ├─ files /files/*            │
                 │                      │     ├─ web client (static SPA)   │
                 │                      │     └─ background jobs           │
                 │                      │          │        │              │
                 │                      │      Postgres   Valkey           │
                 │                      │      (data,     (pub/sub,        │
                 │                      │       search)    presence,       │
                 │                      │                  rate limits,    │
                 │                      │                  voice/watch/    │
                 │                      │                  game state)     │
                 │                      └─► LiveKit /livekit (signalling)  │
 media (UDP) ────┼────────────────────────► LiveKit :50000-50100/udp       │
                 │   files: local volume (default) or any S3 bucket        │
                 └─────────────────────────────────────────────────────────┘
```

One Node process does everything: REST API, WebSocket gateway, serving the built SvelteKit SPA,
file serving and background jobs. You can run more than one of them behind a load balancer: all
cross-process state goes through Valkey pub/sub, and the jobs use `FOR UPDATE SKIP LOCKED` /
Valkey locks so they don't double-fire.

### Why these pieces

| Piece | Choice | Why |
|---|---|---|
| API | Fastify 5 | Fast, schema-friendly, tiny memory footprint |
| DB access | `postgres` (porsager) + plain SQL migrations | No ORM layer, every query is visible SQL, parameterised by tagged templates |
| Search | Postgres `tsvector` + GIN | No extra service (Meilisearch/Elastic would eat a Pi's RAM) |
| Cache/pubsub | Valkey 8 | Open-source Redis fork (Redis changed its license), same protocol |
| Files | Local disk by default, S3 optional | Zero setup; MinIO stopped shipping images in 2025 so it's not bundled |
| Voice | LiveKit | SFU with simulcast, screen share, self-hostable, arm64 images |
| Client | SvelteKit 2 SPA (Svelte 5 runes) | Small bundles, no virtual DOM, fast |
| Desktop | Tauri 2 | Uses the OS webview instead of bundling Chromium |
| Passwords | argon2id (`@node-rs/argon2`) | Prebuilt binaries for x64 + arm64, no node-gyp |

## Code layout

```
packages/shared   permissions, zod input schemas, API types, gateway event types,
                  markdown parser, mini-game rules, theme codec, text sanitising
apps/server       Fastify app, gateway, jobs, migrations, CLI
apps/web          SvelteKit client
apps/desktop      Tauri shell
infra/            Caddyfile, LiveKit config
```

The **same zod schemas** validate forms in the client and every request body on the server.
The server never trusts the client: the client-side checks are only for UX.

## Request lifecycle

1. Caddy terminates TLS, forwards to the app.
2. `onRequest`: security headers, CSRF origin check for unsafe methods, session lookup
   (cookie → SHA-256 → Valkey cache → Postgres).
3. Route-level rate limit (Valkey fixed window, keyed by user id or IP).
4. Body parsed with the shared zod schema (strict: unknown keys are rejected).
5. Permission check against freshly computed permissions (`packages/shared/src/permissions.ts`).
6. DB write, then a gateway event is published to Valkey.

## Realtime fan-out

Events are published to Valkey channels:

- `u:<userId>` — events for one user (their DMs, relationships, read states, settings, scheduled messages…)
- `g:<guildId>` — guild events. Each event carries an optional `channelId` and required permission.

Every app process holds one Valkey subscriber. When a socket connects it subscribes (ref-counted)
to its own `u:` channel and the `g:` channel of every guild it's in. For a guild event the gateway
checks **per socket** whether that user can view the channel (using a per-process permission
cache that is dropped whenever roles, overwrites, members or channels change). So hidden channels
never leak, even their names.

When anything permission-related changes in a guild, the gateway recomputes each connected
member's visible channel set and sends `CHANNEL_CREATE` / `CHANNEL_DELETE` diffs, so the client
never has to compute permissions to stay correct.

Presence goes out to the guild channels the user is in and to each friend's `u:` channel.

## Permissions

Discord's model, implemented in `packages/shared/src/permissions.ts` and unit-tested in
`packages/shared/test/permissions.test.ts`:

- Owner → everything. `ADMINISTRATOR` → everything, ignores overwrites.
- Base = `@everyone` role (id = guild id) | all member roles.
- Channel overwrites: `@everyone` deny/allow → all member roles' denies, then allows → member overwrite.
- Overwrites only touch channel-scoped bits (0–23). Guild-only bits (kick, ban, admin…) can't be granted per channel.
- Timed-out members keep only `VIEW_CHANNEL` + `READ_MESSAGE_HISTORY`.
- No `VIEW_CHANNEL` → zero permissions in that channel.
- Hierarchy: you can only manage roles below your highest role, only kick/ban/timeout members whose
  highest role is below yours, never the owner, and only grant permission bits you have yourself.
- Threads use the parent channel's permissions (plus `SEND_MESSAGES_IN_THREADS`, `MANAGE_THREADS`).

## Privacy measures

- No IP addresses stored anywhere. Sessions keep a coarse client name ("Firefox on Linux").
- Uploaded images are re-encoded with `sharp`, which strips EXIF/GPS metadata.
- Link previews are fetched by the server, and preview images go through `/api/proxy/image`,
  so third-party sites never see a viewer's IP. Game/music covers are proxied the same way.
- YouTube uses `youtube-nocookie.com` and only loads when someone presses play / starts watch-together.
- Fonts are bundled. No Google Fonts, no CDNs, no analytics, no telemetry.
- Last seen can be hidden (everyone / friends / nobody). Invisible freezes your last-seen time.
- Read receipts only flow when **both** people have them on.
- Account deletion removes your profile, sessions, relationships and DMs list, and leaves a
  "Deleted user" tombstone on old messages. `GET /api/users/@me/export` gives you your data.
- DMs are **not** end-to-end encrypted. Whoever runs the server can read them. This is stated in the README.

## Security measures

- argon2id (64 MiB memory, 3 iterations). Constant-time-ish login (a dummy hash is verified when the user doesn't exist).
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when served over HTTPS; token is 256-bit random; only its hash is stored.
- CSRF: unsafe requests must have an `Origin` header matching `PUBLIC_URL` (or no `Origin` but `Sec-Fetch-Site: same-origin`).
- Rate limits (Valkey): auth (per IP and per account), messages (per user per channel + global per user),
  uploads, friend requests, typing, search, guestbook, invites.
- Every body validated with strict zod schemas; all text NFC-normalised, control/bidi characters stripped, zalgo capped.
- Profile content: links must be http(s), colours must be `#rrggbb`, fonts come from a fixed list, widget
  covers must be our own uploads or from the game/music DB hosts, themes are only hex colours (share codes are re-validated on import).
- Markdown is parsed into an AST and rendered with components — never `innerHTML` — and only http(s) links are kept.
- Uploaded files: content type sniffed from magic bytes (the client's claim is ignored), served with
  `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, and anything that's not an
  image/video/audio is forced to download. SVG is always a download.
- Server-side fetches (link previews, image proxy) block private, loopback, link-local and metadata IP ranges,
  re-check on every redirect, and cap size and time.
- Security headers on the app: strict CSP, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`.

## Database schema

Full DDL: [`apps/server/migrations/001_init.sql`](../apps/server/migrations/001_init.sql).

| Table | What it holds |
|---|---|
| `users` | Account, profile (bio, pronouns, links, theme, widgets, song, banner), status, activities, privacy settings, client settings JSON |
| `sessions` | Hashed session tokens |
| `email_tokens` | Hashed email verification / password reset tokens |
| `instance_invites` | Sign-up codes for invite-only instances |
| `relationships` | Friends, blocks, pending requests (both directions stored) |
| `files` | Every upload: owner, purpose, sniffed type, size, dimensions/duration, storage key, url secret |
| `guilds` | Servers (+ level settings) |
| `roles` | Roles; `@everyone` has id = guild id |
| `guild_members` | Membership + per-server nickname, avatar, bio, timeout |
| `member_roles` | Member ↔ role |
| `bans` | Bans |
| `channels` | Text, voice, category, wiki channels, DMs, group DMs, threads |
| `permission_overwrites` | Per-channel role/member allow/deny |
| `dm_recipients` | Who is in each DM / group DM |
| `invites` | Server invite links |
| `messages` | Messages incl. generated `tsvector` for search, disappearing `expires_at` |
| `message_edits` | Edit history |
| `message_attachments` | Message ↔ file |
| `reactions` | One row per user per emoji per message |
| `read_states` | Last read message + mention count per user per channel |
| `scheduled_messages` | "Send later" queue |
| `bookmark_folders`, `bookmarks` | Saved messages |
| `guild_notification_settings`, `channel_notification_settings` | Notification levels and mutes |
| `guild_emojis`, `guild_stickers` | Custom emoji and stickers |
| `audit_log` | Who did what |
| `automod_rules` | Word filter, mention spam, message spam, invite links, link filter |
| `wiki_pages`, `wiki_revisions` | Wiki channel pages + full revision history |
| `member_xp`, `level_roles` | Levels/XP and role rewards |
| `guestbook_entries` | Profile guestbook |

Ephemeral state in Valkey: sessions cache, presence, voice states, watch-together state, mini-game
state, typing throttle, slowmode, rate limits, link preview and game/music search caches.

## REST API

All under `/api`. Bodies are JSON unless noted. ★ = requires a specific permission.

**Instance & auth**
`GET /instance` · `POST /auth/register` · `POST /auth/login` · `POST /auth/logout` ·
`POST /auth/verify-email` · `POST /auth/resend-verification` · `POST /auth/forgot-password` · `POST /auth/reset-password`

**Me**
`GET /users/@me` · `PATCH /users/@me/profile` · `PUT /users/@me/username` · `PUT /users/@me/email` · `PUT /users/@me/password` ·
`DELETE /users/@me` · `GET /users/@me/export` · `PATCH /users/@me/settings` · `PATCH /users/@me/privacy` ·
`PUT /users/@me/status` · `PUT|DELETE /users/@me/custom-status` · `PUT|PATCH|DELETE /users/@me/activity/playing` ·
`PUT|DELETE /users/@me/activity/listening` · `GET /users/@me/sessions` · `DELETE /users/@me/sessions/:id` · `DELETE /users/@me/sessions`

**Users, friends, DMs**
`GET /users/:id/profile?guildId=` · `GET|POST /users/:id/guestbook` · `DELETE /users/:id/guestbook/:entryId` ·
`GET|POST /users/@me/relationships` · `PUT|DELETE /users/@me/relationships/:userId` ·
`POST /users/@me/channels` (open DM / create group DM) · `PUT|DELETE /channels/:id/recipients/:userId`

**Guilds**
`POST /guilds` · `GET|PATCH|DELETE /guilds/:id` · `POST /guilds/:id/transfer` · `DELETE /users/@me/guilds/:id` (leave) ·
`GET /guilds/:id/members` · `GET /guilds/:id/members/:userId` · `PATCH /guilds/:id/members/@me` ·
`PATCH /guilds/:id/members/:userId` ★ (nickname, roles, timeout, voice mute/deafen/move) · `DELETE /guilds/:id/members/:userId` ★ kick ·
`PUT|DELETE /guilds/:id/members/:userId/roles/:roleId` ★ · `GET /guilds/:id/bans` ★ · `PUT|DELETE /guilds/:id/bans/:userId` ★ ·
`GET|POST /guilds/:id/roles` · `PATCH /guilds/:id/roles` ★ (positions) · `PATCH|DELETE /guilds/:id/roles/:roleId` ★ ·
`POST /guilds/:id/channels` ★ · `PATCH /guilds/:id/channels` ★ (positions) · `GET /guilds/:id/invites` ★ ·
`GET /guilds/:id/audit-log` ★ · `GET|POST /guilds/:id/automod` ★ · `PATCH|DELETE /guilds/:id/automod/:ruleId` ★ ·
`GET|POST /guilds/:id/emojis` · `PATCH|DELETE /guilds/:id/emojis/:emojiId` ★ · `GET|POST /guilds/:id/stickers` · `DELETE /guilds/:id/stickers/:stickerId` ★ ·
`GET /guilds/:id/levels` · `PATCH /guilds/:id/levels/settings` ★ · `GET|PUT /guilds/:id/levels/roles` ★ ·
`GET /guilds/:id/messages/search` · `PATCH /users/@me/guilds/:id/notifications`

**Invites**
`POST /channels/:id/invites` ★ · `GET /invites/:code` · `POST /invites/:code` (join) · `DELETE /invites/:code` ★

**Channels & messages**
`GET|PATCH|DELETE /channels/:id` · `PUT|DELETE /channels/:id/permissions/:targetId` ★ · `POST /channels/:id/sync-permissions` ★ ·
`GET|POST /channels/:id/messages` · `GET|PATCH|DELETE /channels/:id/messages/:mid` · `GET /channels/:id/messages/:mid/edits` ·
`POST /channels/:id/messages/bulk-delete` ★ · `PUT|DELETE /channels/:id/messages/:mid/reactions/:emoji/@me` ·
`GET /channels/:id/messages/:mid/reactions/:emoji` · `DELETE /channels/:id/messages/:mid/reactions/:emoji` ★ ·
`GET /channels/:id/pins` · `PUT|DELETE /channels/:id/pins/:mid` ★ · `POST /channels/:id/typing` · `POST /channels/:id/ack` ·
`GET /channels/:id/highlights?after=` (While you were away) · `GET|POST /channels/:id/threads` ·
`PATCH /users/@me/channels/:id/notifications` · `GET /users/@me/messages/search` (DMs)

**Send later, saved messages**
`GET /users/@me/scheduled-messages` · `POST /channels/:id/scheduled-messages` · `PATCH|DELETE /scheduled-messages/:id` ·
`GET /users/@me/bookmarks` · `PUT|DELETE /users/@me/bookmarks/:messageId` · `GET|POST /users/@me/bookmark-folders` · `PATCH|DELETE /users/@me/bookmark-folders/:id`

**Wiki**
`GET|POST /channels/:id/wiki` · `GET|PATCH|DELETE /channels/:id/wiki/:pageId` ★ · `GET /channels/:id/wiki/:pageId/revisions`

**Voice & activities**
`POST /channels/:id/voice/join` → LiveKit token · `POST /voice/leave` · `PATCH /voice/state` ·
`GET|POST /channels/:id/watch` (watch together) · `GET|POST /channels/:id/games` · `GET /games/:id` · `POST /games/:id/join|move|leave` ·
`POST /livekit/webhook` (signed by LiveKit)

**Files & lookups**
`POST /files?purpose=` (multipart) · `GET /files/:id/:secret/:name?` (outside `/api`) · `GET /proxy/image?url=&sig=` ·
`GET /search/games?q=` · `GET /search/music?q=` · `GET /emojis/:id` (redirect to the emoji's file)

## WebSocket gateway

Single socket at `/gateway`, authenticated by the session cookie on upgrade. JSON frames.

Server → client:

| op | payload |
|---|---|
| `hello` | `{ heartbeatInterval }` |
| `heartbeat_ack` | `{ t, server }` — echo of the client time + server time (used for watch-together clock sync) |
| `dispatch` | `{ t: EVENT_NAME, d }` |
| `invalid_session` | session expired/revoked → go to login |
| `reconnect` | server shutting down → reconnect with backoff |

Client → server:

| op | payload |
|---|---|
| `heartbeat` | `{ t }` every 30s; no heartbeat for 75s closes the socket |
| `idle` | `{ idle }` — client idle detection (10 min), turns "online" into "idle" |
| `typing` | `{ channelId }` — throttled to once per 5s per channel |

Dispatch events (types in [`packages/shared/src/events.ts`](../packages/shared/src/events.ts)):

| Event | When / who gets it |
|---|---|
| `READY` | On connect: you, settings, guilds (with roles, visible channels, threads, members, emoji, stickers, voice states), DMs, friends, read states, presences, notification settings, bookmark folders, instance info |
| `SELF_UPDATE` | Your account changed (other tab/device) |
| `SETTINGS_UPDATE` | Your client settings changed |
| `USER_UPDATE` | Someone's name/avatar changed → everyone who shares a guild/DM/friendship |
| `PRESENCE_UPDATE` | Status, custom status, playing/listening, last seen |
| `RELATIONSHIP_ADD` / `RELATIONSHIP_REMOVE` | Friend requests, accepts, blocks, removals |
| `GUILD_CREATE` / `GUILD_UPDATE` / `GUILD_DELETE` | Joined/created, edited, left/kicked/banned/deleted |
| `GUILD_MEMBER_ADD` / `_UPDATE` / `_REMOVE` | Joins, nickname/roles/timeout/server profile changes, leaves |
| `GUILD_ROLE_CREATE` / `_UPDATE` / `_DELETE` | Role changes |
| `GUILD_EMOJIS_UPDATE` / `GUILD_STICKERS_UPDATE` | Emoji/sticker list changed |
| `GUILD_PERMISSIONS_UPDATE` | Your effective guild permissions changed |
| `CHANNEL_CREATE` / `_UPDATE` / `_DELETE` | Channel changes; also sent when a channel becomes visible/invisible to you |
| `CHANNEL_PINS_UPDATE` | Pins changed |
| `THREAD_CREATE` / `_UPDATE` / `_DELETE` | Threads |
| `MESSAGE_CREATE` / `_UPDATE` / `_DELETE` / `_DELETE_BULK` | Messages (incl. embeds arriving after unfurl, disappearing messages expiring) |
| `MESSAGE_REACTION_ADD` / `_REMOVE` / `_REMOVE_EMOJI` | Reactions |
| `MESSAGE_ACK` | Your read position moved (sync across devices) |
| `DM_READ_RECEIPT` | Someone read up to a message in a DM (only when both sides have receipts on) |
| `TYPING_START` | Someone started typing |
| `VOICE_STATE_UPDATE` | Join/leave/mute/deafen/video/stream in voice |
| `VOICE_MOVE` | A mod moved or disconnected you |
| `WATCH_STATE` | Watch-together state (video, playing, position, queue) |
| `GAME_UPDATE` / `GAME_DELETE` | Mini game state (each viewer gets their own view; hidden info stripped) |
| `WIKI_PAGE_CREATE` / `_UPDATE` / `_DELETE` | Wiki pages |
| `SCHEDULED_MESSAGE_CREATE` / `_UPDATE` / `_DELETE` | Your send-later queue |
| `BOOKMARK_UPDATE` / `BOOKMARK_DELETE` / `BOOKMARK_FOLDERS_UPDATE` | Your saved messages |
| `NOTIFICATION_SETTINGS_UPDATE` | Your notification settings |
| `SESSION_REVOKED` | This session was logged out |

## Background jobs

All run inside the app process, every few seconds, safe with multiple processes:

| Job | Interval | What |
|---|---|---|
| Scheduled messages | 5s | Sends due "send later" messages, re-checking permissions at send time |
| Disappearing messages | 15s | Deletes expired DM messages (and their files), broadcasts deletes |
| Thread archiver | 5 min | Archives threads idle longer than their auto-archive time |
| Custom status expiry | 60s | Clears expired custom statuses |
| File GC | 1h | Deletes uploads nobody claimed within 24h |
| Voice reconcile | 60s | Syncs voice states with LiveKit's actual room participants |
| Cleanup | 1h | Expired sessions, email tokens, invites; audit log older than 180 days |

## Valkey keys

| Key | Type | TTL |
|---|---|---|
| `sess:<hash>` | string (user id + session id) | 5 min |
| `presence:<userId>` | hash: status, idle socket count, sockets | refreshed by heartbeats |
| `vs:<guildId>` | hash userId → voice state JSON | none (reconciled) |
| `watch:<channelId>` | JSON | 12h |
| `game:<id>`, `games:<channelId>` | JSON / set | 24h |
| `rl:<bucket>:<key>` | counter | window |
| `slow:<channelId>:<userId>` | flag | slowmode seconds |
| `typing:<channelId>:<userId>` | flag | 5s |
| `xpcd:<guildId>:<userId>` | flag | 60s |
| `spam:<guildId>:<userId>` | sorted set | rule window |
| `embed:<sha>` | link preview JSON | 24h |
| `gsearch:<q>`, `msearch:<q>` | search results | 24h |
| `lock:<job>` | job lock | job interval |
