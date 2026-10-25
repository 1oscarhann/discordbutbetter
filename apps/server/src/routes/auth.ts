import type { FastifyInstance } from 'fastify';
import {
  ForgotPasswordSchema,
  LoginSchema,
  RegisterSchema,
  ResetPasswordSchema,
  TokenSchema,
} from '@dbb/shared';
import type { UserRow } from '../rows.js';
import { parse, requireAuth } from '../lib/validate.js';
import { hit, limit, limitPreset, Limits } from '../lib/ratelimit.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  clearSessionCookie,
  createSession,
  hashToken,
  revokeAllSessions,
  revokeSession,
  setSessionCookie,
} from '../auth/sessions.js';
import { badRequest, conflict, forbidden, tooMany, unauthorized } from '../errors.js';
import { randomToken, snowflake } from '../ids.js';
import { selfUser } from '../lib/serialize.js';
import { instanceInfo } from '../lib/instance.js';
import { resetEmailText, verifyEmailText } from '../lib/email.js';
import type { Ctx } from '../context.js';

export async function sendVerification(ctx: Ctx, userId: string, email: string): Promise<void> {
  if (!ctx.mailer.enabled) return;
  const token = randomToken(32);
  await ctx.sql`DELETE FROM email_tokens WHERE user_id = ${userId} AND kind = 'verify'`;
  await ctx.sql`
    INSERT INTO email_tokens (token_hash, user_id, kind, expires_at)
    VALUES (${hashToken(token)}, ${userId}, 'verify', now() + interval '24 hours')`;
  const link = `${ctx.config.publicUrl}/verify?token=${encodeURIComponent(token)}`;
  await ctx.mailer.send(email, `Confirm your ${ctx.config.appName} email`, verifyEmailText(ctx.config.appName, link)).catch((e: Error) =>
    ctx.log.error({ err: e }, 'verification email failed'),
  );
}

export async function createResetLink(ctx: Ctx, userId: string, ttlHours = 1): Promise<string> {
  const token = randomToken(32);
  await ctx.sql`
    INSERT INTO email_tokens (token_hash, user_id, kind, expires_at)
    VALUES (${hashToken(token)}, ${userId}, 'reset', now() + ${ttlHours + ' hours'}::interval)`;
  return `${ctx.config.publicUrl}/reset?token=${encodeURIComponent(token)}`;
}

export default async function authRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/instance', async () => instanceInfo(ctx));

  app.post('/auth/register', async (req, reply) => {
    await limit(req, 'register', ...Limits.registerIp, `ip:${req.ip}`, 'Too many sign-ups from here, try again later');
    const body = parse(RegisterSchema, req.body);
    if (ctx.config.registration === 'closed') throw forbidden('Sign-ups are closed on this server');

    const passwordHash = await hashPassword(body.password);
    const id = snowflake();
    const user = await ctx.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(9001)`;
      if (ctx.config.registration === 'invite') {
        const code = body.inviteCode?.trim();
        if (!code) throw forbidden('This server is invite-only — you need a sign-up code');
        const used = await tx`
          UPDATE instance_invites SET uses = uses + 1
          WHERE code = ${code} AND (max_uses = 0 OR uses < max_uses) AND (expires_at IS NULL OR expires_at > now())
          RETURNING code`;
        if (!used.length) throw forbidden('That sign-up code is invalid or used up');
      }
      const taken = await tx<{ username: string; email: string }[]>`
        SELECT username::text, email::text FROM users WHERE username = ${body.username} OR email = ${body.email}`;
      if (taken.some((t) => t.username === body.username)) throw conflict('That username is taken');
      if (taken.length) throw conflict('An account with that email already exists');
      const [{ count }] = (await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM users WHERE NOT deleted`) as unknown as [{ count: number }];
      const [u] = await tx<UserRow[]>`
        INSERT INTO users (id, username, email, password_hash, email_verified, is_admin)
        VALUES (${id}, ${body.username}, ${body.email}, ${passwordHash}, ${!ctx.mailer.enabled}, ${count === 0})
        RETURNING *`;
      return u!;
    });

    await sendVerification(ctx, user.id, body.email);
    const { token } = await createSession(ctx, user.id, req.headers['user-agent']);
    setSessionCookie(ctx, reply, token);
    return { user: selfUser(user) };
  });

  app.post('/auth/login', async (req, reply) => {
    await limit(req, 'login-ip', ...Limits.loginIp, `ip:${req.ip}`, 'Too many login attempts, wait a few minutes');
    const body = parse(LoginSchema, req.body);
    const login = body.login.toLowerCase();
    const acct = await hit(ctx.redis, 'login-acct', login, ...Limits.loginAccount);
    if (!acct.ok) throw tooMany(acct.retryAfter, 'Too many attempts on this account, wait a few minutes');

    const [u] = login.includes('@')
      ? await ctx.sql<UserRow[]>`SELECT * FROM users WHERE email = ${login}`
      : await ctx.sql<UserRow[]>`SELECT * FROM users WHERE username = ${login}`;
    const ok = await verifyPassword(u?.password_hash ?? null, body.password);
    if (!u || !ok || u.deleted) throw unauthorized('Wrong login or password');
    if (u.disabled) throw forbidden('This account has been disabled by the server admin');

    await ctx.redis.del(`rl:login-acct:${login}`);
    const { token } = await createSession(ctx, u.id, req.headers['user-agent']);
    setSessionCookie(ctx, reply, token);
    return { user: selfUser(u) };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.auth) await revokeSession(ctx, req.auth.sessionId);
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  app.post('/auth/verify-email', async (req) => {
    await limitPreset(req, 'emailIp', `ip:${req.ip}`);
    const { token } = parse(TokenSchema, req.body);
    const rows = await ctx.sql<{ user_id: string }[]>`
      DELETE FROM email_tokens WHERE token_hash = ${hashToken(token)} AND kind = 'verify' AND expires_at > now()
      RETURNING user_id`;
    const row = rows[0];
    if (!row) throw badRequest('That link is invalid or expired');
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET email_verified = true WHERE id = ${row.user_id} RETURNING *`;
    if (u) ctx.bus.toUser(u.id, 'SELF_UPDATE', selfUser(u));
    return { ok: true };
  });

  app.post('/auth/resend-verification', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'emailIp', auth.userId);
    if (!ctx.mailer.enabled) throw badRequest("Email isn't set up on this server");
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${auth.userId}`;
    if (!u?.email) throw badRequest('No email on this account');
    if (u.email_verified) throw badRequest('Already verified');
    await sendVerification(ctx, u.id, u.email);
    return { ok: true };
  });

  app.post('/auth/forgot-password', async (req) => {
    await limitPreset(req, 'emailIp', `ip:${req.ip}`);
    const { email } = parse(ForgotPasswordSchema, req.body);
    if (!ctx.mailer.enabled) {
      throw badRequest("This server can't send email. Ask the server admin for a reset link.");
    }
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE email = ${email} AND NOT deleted AND NOT disabled`;
    if (u) {
      // don't let someone spam a victim's inbox
      const r = await hit(ctx.redis, 'reset-mail', u.id, 3, 3600);
      if (r.ok) {
        const link = await createResetLink(ctx, u.id);
        ctx.mailer
          .send(email, `Reset your ${ctx.config.appName} password`, resetEmailText(ctx.config.appName, link))
          .catch((e: Error) => ctx.log.error({ err: e }, 'reset email failed'));
      }
    }
    // same answer either way, so this can't be used to check which emails have accounts
    return { ok: true };
  });

  app.post('/auth/reset-password', async (req, reply) => {
    await limitPreset(req, 'emailIp', `ip:${req.ip}`);
    const body = parse(ResetPasswordSchema, req.body);
    const rows = await ctx.sql<{ user_id: string }[]>`
      DELETE FROM email_tokens WHERE token_hash = ${hashToken(body.token)} AND kind = 'reset' AND expires_at > now()
      RETURNING user_id`;
    const row = rows[0];
    if (!row) throw badRequest('That reset link is invalid or expired');
    const hash = await hashPassword(body.password);
    await ctx.sql`UPDATE users SET password_hash = ${hash} WHERE id = ${row.user_id}`;
    await ctx.sql`DELETE FROM email_tokens WHERE user_id = ${row.user_id} AND kind = 'reset'`;
    await revokeAllSessions(ctx, row.user_id);
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });
}
