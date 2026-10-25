import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Ctx, Auth } from '../context.js';
import { randomToken, snowflake } from '../ids.js';

export const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;
const CACHE_TTL = 300;

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** "Firefox on Linux" — enough to recognise a session, not enough to fingerprint. */
export function describeClient(ua: string | undefined): string {
  if (!ua) return 'Unknown';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /Tauri|tauri/.test(ua)
              ? 'Desktop app'
              : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
}

export async function createSession(ctx: Ctx, userId: string, ua: string | undefined): Promise<{ token: string; sessionId: string }> {
  const token = randomToken(32);
  const id = snowflake();
  await ctx.sql`
    INSERT INTO sessions (id, user_id, token_hash, client, expires_at)
    VALUES (${id}, ${userId}, ${hashToken(token)}, ${describeClient(ua)}, now() + ${SESSION_DAYS + ' days'}::interval)`;
  return { token, sessionId: id };
}

export function setSessionCookie(ctx: Ctx, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    maxAge: SESSION_DAYS * 86400,
  });
}

export function clearSessionCookie(ctx: Ctx, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies });
}

/** Looks up a session token. Cached in Valkey for 5 minutes; sliding 30-day expiry. */
export async function resolveSession(ctx: Ctx, token: string | undefined): Promise<Auth | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const h = hashToken(token);
  const key = `sess:${h.toString('hex')}`;
  const cached = await ctx.redis.get(key);
  if (cached) {
    const [userId, sessionId] = cached.split(':');
    if (userId && sessionId) return { userId, sessionId };
  }
  const rows = await ctx.sql<{ id: string; user_id: string; last_used_at: Date }[]>`
    SELECT s.id, s.user_id, s.last_used_at FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${h} AND s.expires_at > now() AND NOT u.disabled AND NOT u.deleted`;
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.last_used_at.getTime() > 3600_000) {
    await ctx.sql`
      UPDATE sessions SET last_used_at = now(), expires_at = now() + ${SESSION_DAYS + ' days'}::interval
      WHERE id = ${row.id}`;
  }
  await ctx.redis.set(key, `${row.user_id}:${row.id}`, 'EX', CACHE_TTL);
  return { userId: row.user_id, sessionId: row.id };
}

export async function revokeSession(ctx: Ctx, sessionId: string): Promise<void> {
  const rows = await ctx.sql<{ token_hash: Buffer; user_id: string }[]>`
    DELETE FROM sessions WHERE id = ${sessionId} RETURNING token_hash, user_id`;
  for (const r of rows) {
    await ctx.redis.del(`sess:${r.token_hash.toString('hex')}`);
    ctx.bus.toUser(r.user_id, 'SESSION_REVOKED', {}, { onlySession: sessionId });
  }
}

/** Revoke all sessions of a user, optionally keeping one. */
export async function revokeAllSessions(ctx: Ctx, userId: string, keep?: string): Promise<void> {
  const rows = await ctx.sql<{ id: string; token_hash: Buffer }[]>`
    DELETE FROM sessions WHERE user_id = ${userId} AND (${keep ?? null}::bigint IS NULL OR id <> ${keep ?? null}::bigint)
    RETURNING id, token_hash`;
  if (rows.length) await ctx.redis.del(...rows.map((r) => `sess:${r.token_hash.toString('hex')}`));
  for (const r of rows) ctx.bus.toUser(userId, 'SESSION_REVOKED', {}, { onlySession: r.id });
}

export function sessionToken(req: FastifyRequest): string | undefined {
  return req.cookies[SESSION_COOKIE];
}
