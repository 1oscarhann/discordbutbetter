# Haunt

**Your group's usual haunt.** A self-hosted place for text, voice, video and screen share with your friends — no ID or face scans, no tracking, and nothing behind a paywall. One `docker compose up` on a VPS or a Raspberry Pi.

- **Private by default.** Email + password only. No phone number, no ID checks, no analytics, no ads, no IP logs. Image uploads get their EXIF (GPS etc.) stripped. Link previews and game/music covers load through your server, so third parties never see your users' IPs.
- **Everything free.** Upload limits are whatever *you* set. Animated avatars, video banners, custom emoji and stickers, 1440p/60fps screen share — all on.
- **Light.** The whole web app is about 175 KB of gzipped JS on first load; voice, emoji data and fonts load only when used.

> **Honest up front:** messages are encrypted in transit (HTTPS/WSS) but **not end-to-end encrypted**. Whoever runs the server can read them. Use instances run by people you trust — or run your own.

---

## What's in it

**Chat** — servers, invites, text/voice/wiki channels, categories, threads · markdown, replies, reactions (incl. custom emoji), link previews, typing indicators · edits with visible edit history · 1:1 and group DMs · pins · full-text search with filters · unread tracking, @mentions, per-server and per-channel notification settings · Ctrl+K quick switcher

**Voice** — voice channels with camera and screen share (up to 1440p60), per-person volume, server mute/deafen/move · **watch YouTube together** in sync · **mini games** in DMs and voice (tic-tac-toe, connect four, hangman, anagram race)

**Profiles** — animated avatar, banner (image, GIF or short video), markdown bio, pronouns, links · profile theme (colours/gradient, accent, font) · per-server nickname/avatar/bio · drag-to-reorder widgets (favourite games, top songs, currently into, photo grid, custom text) · profile song (upload or YouTube; never autoplays unless the visitor opted in; always has a mute button) · guestbook · custom status with emoji and expiry

**Presence** — online/idle/do not disturb/invisible · "last seen X ago" with a privacy setting (everyone/friends/nobody) · **manual** "Playing" (game search via IGDB or RAWG, or a custom game with your own cover) with a Looking-for-group toggle · manual "Listening to" (MusicBrainz search or custom)

**Extras** — "While you were away" (most-reacted messages since you last read) · send later · silent messages · disappearing DM messages · saved messages in folders · server levels/XP with role rewards (owners can turn it off) · DM read receipts (only if *both* people turn them on) · client theme editor with shareable theme codes

**Moderation** — roles with per-channel permission overwrites and a proper hierarchy · kick, ban, timeout · audit log · AutoMod (blocked words with wildcards, mention spam, message floods, invite links, link filter; block / alert / timeout) · instance admin panel (users, disable accounts, password reset links, sign-up links, server takedowns)

**Apps** — web app (any modern browser, works at phone width) · desktop app (Tauri) for Windows, macOS and Linux

## What's not done / known limits

Read this before you deploy. None of these are hidden behind fake buttons — they just don't exist yet.

- **No end-to-end encryption** (see above).
- **No DM voice/video calls.** Voice, video and screen share live in server voice channels. Games and watch-together don't need voice and work in DMs.
- **No push notifications when the app is closed.** Notifications come from the open tab/app; there's no Google/Apple push service involved (on purpose). No mobile apps (out of scope).
- **No TURN relay configured.** People behind very strict networks that block UDP *and* port 7881 can't connect to voice. LiveKit has a built-in TURN server you can enable — not wired up here.
- **No 2FA**, and **no in-app "report message" flow** — members report to mods/admins however your community does.
- **Search** is language-agnostic word/prefix matching (Postgres `simple` config): no stemming, so "running" won't find "run".
- **Email** is plain text and has only been tested against a stub mailer, not a real SMTP provider.
- **Desktop app:** builds are unsigned (expect SmartScreen/Gatekeeper warnings) and there's no auto-update. It has been compiled and run on Linux; Windows and macOS builds haven't been tested by me. On Linux, voice/screen share depend on your distro's WebKitGTK having WebRTC (screen share needs WebKitGTK ≥ 2.42) — if it misbehaves, use the browser.
- **Scaling:** built so several app instances can share Postgres/Valkey, but only a single instance has been tested.
- **Not every UI flow has an automated browser test.** API tests cover permissions, auth, messaging, gateway, admin and extras. The browser suites in `e2e/` click through sign-up, servers, invites, messaging, edits, mentions, reactions, uploads (incl. EXIF stripping), search, profiles, settings, roles, audit log, DMs, games, compact mode, the admin panel, phone layout, saved messages, threads, send later, wiki, friends, guestbook, disappearing messages, profile songs and two-person voice. **Not** clicked through by a test: watch-together (needs YouTube), camera and screen share (voice was tested with a fake mic only), custom emoji/sticker uploads, the AutoMod editor, levels, read receipts, "While you were away", theme share codes in the UI (the codec itself is unit-tested) and server profiles.
- **No license file yet** — pick one before you publish this.

---

## Run it on a server

You need:

- a 64-bit Linux machine (amd64 or arm64) with **Docker** and the **Docker Compose plugin**
- a **domain** pointing at it (an A/AAAA record)
- these ports open (firewall *and* router port-forwarding if it's at home):

| Port | Why |
|---|---|
| 80/tcp, 443/tcp, 443/udp | HTTPS (Caddy gets a Let's Encrypt certificate automatically) |
| 7881/tcp | voice/video fallback over TCP |
| 50000–50100/udp | voice/video media (WebRTC) |

Then:

```sh
git clone <this repo> haunt && cd haunt
sh infra/gen-env.sh chat.example.com   # writes .env with fresh random secrets
docker compose up -d                   # builds the app image the first time (a few minutes)
```

Open `https://chat.example.com`. **The first account you create is the instance admin.** Done.

Want to close sign-ups after your friends are in? Set `REGISTRATION=invite` (or `closed`) in `.env` and `docker compose up -d` again. With `invite`, admins hand out sign-up links from **Settings → Instance admin → Sign-up links**.

### Raspberry Pi

Works on a Pi 4 or 5 with **64-bit** Raspberry Pi OS (every image used ships arm64; LiveKit has no 32-bit build). 4 GB RAM should be plenty for a friend group (not benchmarked). The first `docker compose up` builds the app on the Pi, which takes a while — that's normal.

### Trying it locally (no domain)

```sh
sh infra/gen-env.sh localhost
echo "LIVEKIT_USE_EXTERNAL_IP=false" >> .env
docker compose up -d
```

Open `https://localhost` and accept the browser warning (Caddy uses a local certificate for `localhost`). Voice works between browsers on the same machine.

---

## Running the instance

### Admin

The first account is an instance admin. Admins get **Settings → Instance admin**:

- stats (accounts, servers, messages, storage)
- search users · disable/enable accounts (logs them out everywhere) · make/remove admins (you can't remove the last admin or disable yourself)
- **password reset links** — the way to help someone who forgot their password when you haven't set up email
- sign-up links for `REGISTRATION=invite`
- list servers and take one down

The same things from a shell:

```sh
docker compose exec app node dist/cli.js help
docker compose exec app node dist/cli.js reset-link <username|email>
docker compose exec app node dist/cli.js make-admin <username>
docker compose exec app node dist/cli.js disable-user <username>
docker compose exec app node dist/cli.js create-invite [uses] [days]
docker compose exec app node dist/cli.js stats
```

### Configuration

Everything lives in `.env` (see `.env.example` for comments). The important ones:

| Variable | Default | What it does |
|---|---|---|
| `DOMAIN` | — | Your domain. Caddy gets the certificate; the app uses `https://$DOMAIN`. |
| `APP_NAME` | `Haunt` | Name shown in the UI, browser tab, emails. |
| `SECRET` | — | 64 random hex chars. Signs image-proxy URLs etc. |
| `POSTGRES_PASSWORD` | — | Database password. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | — | Shared between the app and LiveKit. Secret ≥ 32 chars. |
| `REGISTRATION` | `open` | `open`, `invite` (needs a sign-up link) or `closed`. |
| `MAX_UPLOAD_MB` | `100` | Max attachment size. |
| `MAX_AVATAR_MB` / `MAX_EMOJI_KB` | `15` / `1024` | Avatar/banner and emoji size limits. |
| `EMOJIS_PER_GUILD` / `STICKERS_PER_GUILD` | `250` / `100` | Per-server limits. |
| `SMTP_URL`, `SMTP_FROM` | unset | Optional email for verification and password resets. Without it accounts work immediately and admins hand out reset links. |
| `IGDB_CLIENT_ID` + `IGDB_CLIENT_SECRET`, or `RAWG_API_KEY` | unset | Optional game search for "Playing". Without it people type their game in. |
| `MUSIC_SEARCH` | `true` | Song search for "Listening to" via MusicBrainz (no key). |
| `STORAGE_DRIVER` + `S3_*` | `local` | Store files in any S3-compatible bucket (Garage, R2, B2, AWS…) instead of the local volume. |
| `LIVEKIT_USE_EXTERNAL_IP` | `true` | LiveKit finds your public IP via STUN. Set `false` for LAN-only setups. |
| `TRUST_PROXY` | `1` in production | How many reverse proxies are in front of the app. Compose sets it to 1 (Caddy). Only the address your own proxy adds is trusted, so clients can't fake their IP to dodge rate limits. If you expose the app directly with no proxy, set `false`. |

### Updating

```sh
git pull
docker compose up -d --build
```

Database migrations run automatically on start.

### Backups

Two things hold your data: the Postgres database and the uploaded files.

```sh
docker compose exec -T postgres pg_dump -U haunt haunt | gzip > haunt-db-$(date +%F).sql.gz
docker run --rm -v haunt_files:/data -v "$PWD":/backup alpine tar czf /backup/haunt-files-$(date +%F).tgz -C /data .
```

(If you use S3 storage, back up the bucket instead of the volume.)

---

## Desktop app

`apps/desktop` is a small [Tauri 2](https://tauri.app) shell: a local page asks for your server's address, then the window loads that server's web app. The server's page gets **no** access to native APIs. Links open in your normal browser. Mic, camera and screen capture are allowed for the server you picked.

Build it on the OS you want an app for (Tauri doesn't cross-compile):

```sh
# prerequisites: Rust (rustup), Node 22+, pnpm, plus Tauri's OS deps:
# https://tauri.app/start/prerequisites/  (Linux: libwebkit2gtk-4.1-dev, libgtk-3-dev, librsvg2-dev …)
pnpm install
pnpm --filter @haunt/desktop build     # installers end up in apps/desktop/src-tauri/target/release/bundle/
```

To rebrand it, change `productName` and `identifier` in `apps/desktop/src-tauri/tauri.conf.json` and drop a 1024×1024 `icon.png` in `apps/desktop`, then run `pnpm --filter @haunt/desktop icons`.

---

## Development

Needs Node 22+, pnpm 10, Postgres 16+ (with the `citext` extension available) and Valkey or Redis.

```sh
pnpm install
createuser -P haunt                 # password: haunt
createdb -O haunt haunt
createdb -O haunt haunt_test
pnpm dev                            # API on :3000, web app on http://localhost:5173
```

The server's defaults point at `postgres://haunt:haunt@localhost:5432/haunt` and `redis://localhost:6379`; override with environment variables (the same names as in `.env.example`).

```sh
pnpm test        # shared + server tests (server tests use the haunt_test database and Valkey db 15)
pnpm typecheck
pnpm build
```

Browser tests (two headless users clicking through the app) run against a live instance — a fresh database is best, since they register `alice`, `bob`, `kim` and `lee`:

```sh
pnpm exec playwright install chromium   # once
pnpm e2e                                # e2e/smoke.cjs + e2e/flows.cjs against `pnpm dev` (localhost:5173); BASE=… for another instance
BASE=https://localhost node e2e/voice.cjs   # needs LiveKit, e.g. the local compose stack. Screenshots go to e2e/.shots/
```

### Layout

```
packages/shared   types, zod schemas, permissions, markdown parser, games, themes (used by both sides)
apps/server       Fastify API + WebSocket gateway, jobs, admin CLI
apps/web          SvelteKit app (static build, served by the server)
apps/desktop      Tauri desktop shell
infra/            Caddyfile, .env generator
docs/             ARCHITECTURE.md: schema, API, gateway events, permission model
```

## Privacy & security notes

- **Stored about you:** username, email, password hash (argon2id), your profile, your messages and files, and a short device label per login ("Firefox on Linux"). **Not stored:** IP addresses, locations, analytics. Logs don't include IPs or query strings, and Caddy writes no access log.
- **Export / delete:** Settings → Data & deletion downloads everything stored about you as JSON, or deletes your account (optionally with all your messages).
- **Server-side checks everywhere:** every input is validated, every permission is checked on the server, auth and messaging are rate-limited, and profile content (bios, links, themes) is sanitised — themes and theme codes can only contain colours.
- **Uploads** are served with `nosniff` and a sandboxing CSP; anything that isn't an image/video/audio downloads instead of opening. File URLs contain an unguessable secret.
- **Web app CSP** allows scripts only from the server itself (plus the exact hash of SvelteKit's one-line bootstrap). Embeds use `youtube-nocookie.com`. Fonts are bundled — no Google Fonts.
