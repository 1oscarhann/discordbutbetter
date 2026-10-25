import type { FastifyInstance } from 'fastify';
import {
  ChangeEmailSchema,
  ChangePasswordSchema,
  ChangeUsernameSchema,
  ClientSettingsPatchSchema,
  CustomStatusSchema,
  DeleteAccountSchema,
  LfgSchema,
  ListeningSchema,
  PlayingSchema,
  PrivacyPatchSchema,
  StatusSchema,
  normaliseSettings,
} from '@dbb/shared';
import type { UserRow } from '../rows.js';
import { parse, requireAuth, idParam } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { clearSessionCookie, revokeAllSessions, revokeSession } from '../auth/sessions.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { selfUser } from '../lib/serialize.js';
import { broadcastPresence } from '../lib/presence.js';
import { broadcastUserUpdate } from '../lib/audience.js';
import { AssetDiff, urlsIn } from '../lib/assets.js';
import { sendVerification } from './auth.js';
import { deleteFile } from './files.js';
import { disconnectVoice } from '../services/voice.js';
import type { Ctx } from '../context.js';

async function me(ctx: Ctx, userId: string): Promise<UserRow> {
  const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${userId}`;
  if (!u) throw unauthorized();
  return u;
}

async function checkPassword(ctx: Ctx, userId: string, password: string) {
  const u = await me(ctx, userId);
  if (!(await verifyPassword(u.password_hash, password))) throw forbidden('Wrong password');
  return u;
}

export default async function meRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  const pushSelf = (u: UserRow, excludeSession?: string) => ctx.bus.toUser(u.id, 'SELF_UPDATE', selfUser(u), { excludeSession });

  app.get('/users/@me', async (req) => selfUser(await me(ctx, requireAuth(req).userId)));

  app.put('/users/@me/username', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'profile');
    const body = parse(ChangeUsernameSchema, req.body);
    await checkPassword(ctx, auth.userId, body.password);
    const taken = await ctx.sql`SELECT 1 FROM users WHERE username = ${body.username} AND id <> ${auth.userId}`;
    if (taken.length) throw conflict('That username is taken');
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET username = ${body.username} WHERE id = ${auth.userId} RETURNING *`;
    pushSelf(u!, auth.sessionId);
    await broadcastUserUpdate(ctx, u!);
    return selfUser(u!);
  });

  app.put('/users/@me/email', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'emailIp', auth.userId);
    const body = parse(ChangeEmailSchema, req.body);
    await checkPassword(ctx, auth.userId, body.password);
    const taken = await ctx.sql`SELECT 1 FROM users WHERE email = ${body.email} AND id <> ${auth.userId}`;
    if (taken.length) throw conflict('An account with that email already exists');
    const [u] = await ctx.sql<UserRow[]>`
      UPDATE users SET email = ${body.email}, email_verified = ${!ctx.mailer.enabled} WHERE id = ${auth.userId} RETURNING *`;
    await sendVerification(ctx, auth.userId, body.email);
    pushSelf(u!, auth.sessionId);
    return selfUser(u!);
  });

  app.put('/users/@me/password', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'loginAccount', auth.userId);
    const body = parse(ChangePasswordSchema, req.body);
    await checkPassword(ctx, auth.userId, body.currentPassword);
    const hash = await hashPassword(body.newPassword);
    await ctx.sql`UPDATE users SET password_hash = ${hash} WHERE id = ${auth.userId}`;
    // everyone else is logged out; this session stays
    await revokeAllSessions(ctx, auth.userId, auth.sessionId);
    return { ok: true };
  });

  app.delete('/users/@me', async (req, reply) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'loginAccount', auth.userId);
    const body = parse(DeleteAccountSchema, req.body);
    const u = await checkPassword(ctx, auth.userId, body.password);
    const owned = await ctx.sql<{ id: string; name: string }[]>`SELECT id, name FROM guilds WHERE owner_id = ${auth.userId}`;
    if (owned.length) {
      throw conflict(`Transfer or delete your servers first: ${owned.map((g) => g.name).join(', ')}`);
    }
    await disconnectVoice(ctx, auth.userId);

    const guilds = await ctx.sql<{ guild_id: string }[]>`DELETE FROM guild_members WHERE user_id = ${auth.userId} RETURNING guild_id`;
    for (const g of guilds) {
      ctx.bus.toGuild(g.guild_id, 'GUILD_MEMBER_REMOVE', { guildId: g.guild_id, userId: auth.userId }, { invalidate: true });
    }
    const rels = await ctx.sql<{ target_id: string }[]>`
      DELETE FROM relationships WHERE user_id = ${auth.userId} RETURNING target_id`;
    await ctx.sql`DELETE FROM relationships WHERE target_id = ${auth.userId}`;
    for (const r of rels) ctx.bus.toUser(r.target_id, 'RELATIONSHIP_REMOVE', { userId: auth.userId });

    if (body.deleteMessages) {
      // batch so a huge history doesn't hold one giant transaction
      for (;;) {
        const batch = await ctx.sql<{ id: string; channel_id: string; guild_id: string | null }[]>`
          SELECT id, channel_id, guild_id FROM messages WHERE author_id = ${auth.userId} LIMIT 500`;
        if (!batch.length) break;
        const ids = batch.map((m) => m.id);
        const files = await ctx.sql<{ file_id: string }[]>`
          SELECT file_id FROM message_attachments WHERE message_id = ANY(${ids}::bigint[])`;
        await ctx.sql`DELETE FROM messages WHERE id = ANY(${ids}::bigint[])`;
        for (const f of files) await deleteFile(ctx, f.file_id);
      }
    }

    // profile files
    for (const url of [u.avatar, u.banner, ...urlsIn(u.widgets), ...urlsIn(u.profile_song), ...urlsIn(u.activity_playing), ...urlsIn(u.activity_listening)]) {
      await deleteFile(ctx, url);
    }
    await ctx.sql`DELETE FROM guestbook_entries WHERE profile_id = ${auth.userId} OR author_id = ${auth.userId}`;
    await ctx.sql`DELETE FROM bookmarks WHERE user_id = ${auth.userId}`;
    await ctx.sql`DELETE FROM scheduled_messages WHERE user_id = ${auth.userId}`;
    await ctx.sql`DELETE FROM read_states WHERE user_id = ${auth.userId}`;
    await ctx.sql`UPDATE dm_recipients SET open = false WHERE user_id = ${auth.userId}`;
    const [dead] = await ctx.sql<UserRow[]>`
      UPDATE users SET
        username = ${'deleted_user_' + auth.userId}, display_name = NULL, email = NULL, password_hash = NULL,
        email_verified = false, deleted = true, avatar = NULL, banner = NULL, banner_kind = NULL, bio = '',
        pronouns = '', links = '[]', profile_theme = '{}', widgets = '[]', profile_song = NULL,
        custom_status = NULL, activity_playing = NULL, activity_listening = NULL, last_seen_at = NULL,
        settings = '{}', is_admin = false
      WHERE id = ${auth.userId} RETURNING *`;
    await revokeAllSessions(ctx, auth.userId);
    if (dead) await broadcastUserUpdate(ctx, dead);
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  /** Everything we store about you, as JSON. */
  app.get('/users/@me/export', async (req, reply) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'search', auth.userId);
    const u = await me(ctx, auth.userId);
    const [sessions, relationships, guilds, messages, bookmarks, scheduled, guestbook, files] = await Promise.all([
      ctx.sql`SELECT id::text, client, created_at, last_used_at FROM sessions WHERE user_id = ${auth.userId}`,
      ctx.sql`SELECT target_id::text, type, created_at FROM relationships WHERE user_id = ${auth.userId}`,
      ctx.sql`SELECT g.id::text, g.name, m.nickname, m.bio, m.joined_at FROM guild_members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ${auth.userId}`,
      ctx.sql`SELECT id::text, channel_id::text, guild_id::text, content, created_at, edited_at FROM messages WHERE author_id = ${auth.userId} ORDER BY id LIMIT 200000`,
      ctx.sql`SELECT message_id::text, note, created_at FROM bookmarks WHERE user_id = ${auth.userId}`,
      ctx.sql`SELECT id::text, channel_id::text, content, send_at FROM scheduled_messages WHERE user_id = ${auth.userId}`,
      ctx.sql`SELECT profile_id::text, content, created_at FROM guestbook_entries WHERE author_id = ${auth.userId}`,
      ctx.sql`SELECT id::text, purpose, filename, content_type, size::text, created_at FROM files WHERE owner_id = ${auth.userId}`,
    ]);
    const { password_hash: _ph, ...account } = u;
    reply.header('Content-Disposition', `attachment; filename="${ctx.config.appName}-export-${u.username}.json"`);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return JSON.stringify(
      { exportedAt: new Date().toISOString(), account, sessions, relationships, guilds, messages, bookmarks, scheduled, guestbook, files },
      null,
      2,
    );
  });

  app.patch('/users/@me/settings', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'general');
    const patch = parse(ClientSettingsPatchSchema, req.body);
    const u = await me(ctx, auth.userId);
    const next = normaliseSettings({ ...normaliseSettings(u.settings), ...patch });
    const json = JSON.stringify(next);
    if (json.length > 64 * 1024) throw badRequest('Settings too large');
    await ctx.sql`UPDATE users SET settings = ${ctx.sql.json(next as never)} WHERE id = ${auth.userId}`;
    ctx.bus.toUser(auth.userId, 'SETTINGS_UPDATE', next, { excludeSession: auth.sessionId });
    return next;
  });

  app.patch('/users/@me/privacy', async (req) => {
    const auth = requireAuth(req);
    const p = parse(PrivacyPatchSchema, req.body);
    const [u] = await ctx.sql<UserRow[]>`
      UPDATE users SET
        last_seen_privacy = COALESCE(${p.lastSeen ?? null}, last_seen_privacy),
        read_receipts = COALESCE(${p.readReceipts ?? null}::boolean, read_receipts),
        dm_policy = COALESCE(${p.dmPolicy ?? null}, dm_policy),
        friend_policy = COALESCE(${p.friendRequests ?? null}, friend_policy)
      WHERE id = ${auth.userId} RETURNING *`;
    pushSelf(u!, auth.sessionId);
    if (p.lastSeen) await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.put('/users/@me/status', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'general');
    const { status } = parse(StatusSchema, req.body);
    const before = await me(ctx, auth.userId);
    // going invisible freezes "last seen" at this moment
    const [u] =
      status === 'invisible' && before.status !== 'invisible'
        ? await ctx.sql<UserRow[]>`UPDATE users SET status = ${status}, last_seen_at = now() WHERE id = ${auth.userId} RETURNING *`
        : await ctx.sql<UserRow[]>`UPDATE users SET status = ${status} WHERE id = ${auth.userId} RETURNING *`;
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.put('/users/@me/custom-status', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'profile');
    const body = parse(CustomStatusSchema, req.body);
    const cs = {
      text: body.text,
      emoji: body.emoji ?? null,
      expiresAt: body.expiresInSeconds ? new Date(Date.now() + body.expiresInSeconds * 1000).toISOString() : null,
    };
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET custom_status = ${ctx.sql.json(cs)} WHERE id = ${auth.userId} RETURNING *`;
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.delete('/users/@me/custom-status', async (req) => {
    const auth = requireAuth(req);
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET custom_status = NULL WHERE id = ${auth.userId} RETURNING *`;
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.put('/users/@me/activity/playing', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'profile');
    const body = parse(PlayingSchema, req.body);
    const u0 = await me(ctx, auth.userId);
    const diff = new AssetDiff(ctx, auth.userId, urlsIn(u0.activity_playing));
    const game = await diff.gameRef(body);
    const playing = { ...game, lfg: body.lfg, since: new Date().toISOString() };
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET activity_playing = ${ctx.sql.json(playing)} WHERE id = ${auth.userId} RETURNING *`;
    await diff.commit();
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.patch('/users/@me/activity/playing', async (req) => {
    const auth = requireAuth(req);
    const { lfg } = parse(LfgSchema, req.body);
    const [u] = await ctx.sql<UserRow[]>`
      UPDATE users SET activity_playing = jsonb_set(activity_playing, '{lfg}', to_jsonb(${lfg}::boolean))
      WHERE id = ${auth.userId} AND activity_playing IS NOT NULL RETURNING *`;
    if (!u) throw notFound('Pick a game first');
    pushSelf(u);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u);
  });

  app.delete('/users/@me/activity/playing', async (req) => {
    const auth = requireAuth(req);
    const u0 = await me(ctx, auth.userId);
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET activity_playing = NULL WHERE id = ${auth.userId} RETURNING *`;
    await new AssetDiff(ctx, auth.userId, urlsIn(u0.activity_playing)).commit();
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.put('/users/@me/activity/listening', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'profile');
    const body = parse(ListeningSchema, req.body);
    const u0 = await me(ctx, auth.userId);
    const diff = new AssetDiff(ctx, auth.userId, urlsIn(u0.activity_listening));
    const song = await diff.songRef(body);
    const listening = { ...song, since: new Date().toISOString() };
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET activity_listening = ${ctx.sql.json(listening)} WHERE id = ${auth.userId} RETURNING *`;
    await diff.commit();
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.delete('/users/@me/activity/listening', async (req) => {
    const auth = requireAuth(req);
    const u0 = await me(ctx, auth.userId);
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET activity_listening = NULL WHERE id = ${auth.userId} RETURNING *`;
    await new AssetDiff(ctx, auth.userId, urlsIn(u0.activity_listening)).commit();
    pushSelf(u!);
    await broadcastPresence(ctx, auth.userId, true);
    return selfUser(u!);
  });

  app.get('/users/@me/sessions', async (req) => {
    const auth = requireAuth(req);
    const rows = await ctx.sql<{ id: string; client: string; created_at: Date; last_used_at: Date }[]>`
      SELECT id, client, created_at, last_used_at FROM sessions WHERE user_id = ${auth.userId} AND expires_at > now()
      ORDER BY last_used_at DESC`;
    return rows.map((r) => ({
      id: r.id,
      current: r.id === auth.sessionId,
      client: r.client,
      createdAt: r.created_at.toISOString(),
      lastUsedAt: r.last_used_at.toISOString(),
    }));
  });

  app.delete('/users/@me/sessions/:id', async (req, reply) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const [s] = await ctx.sql`SELECT id FROM sessions WHERE id = ${id} AND user_id = ${auth.userId}`;
    if (!s) throw notFound('Session not found');
    await revokeSession(ctx, id);
    if (id === auth.sessionId) clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  app.delete('/users/@me/sessions', async (req) => {
    const auth = requireAuth(req);
    await revokeAllSessions(ctx, auth.userId, auth.sessionId);
    return { ok: true };
  });
}
