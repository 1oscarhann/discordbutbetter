import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientFor, createTestApp, register, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

const post = (url: string, body: unknown, extra: Record<string, string> = {}, ip = '10.9.9.9') =>
  t.app.inject({
    method: 'POST',
    url,
    remoteAddress: ip,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173', ...extra },
    payload: JSON.stringify(body),
  });

describe('auth', () => {
  it('first user becomes instance admin, later users do not', async () => {
    const a = await register(t, 'firstuser');
    const b = await register(t, 'seconduser');
    expect((await a.req('GET', '/api/users/@me')).body.isAdmin).toBe(true);
    expect((await b.req('GET', '/api/users/@me')).body.isAdmin).toBe(false);
  });

  it('rejects duplicate usernames and emails', async () => {
    await register(t, 'dupe');
    const r1 = await post('/api/auth/register', { username: 'DUPE', email: 'other@example.com', password: 'longpassword' }, {}, '10.1.1.1');
    expect(r1.statusCode).toBe(409);
    const r2 = await post('/api/auth/register', { username: 'dupe2', email: 'dupe@example.com', password: 'longpassword' }, {}, '10.1.1.2');
    expect(r2.statusCode).toBe(409);
  });

  it('validates input and rejects unknown fields', async () => {
    expect((await post('/api/auth/register', { username: 'x', email: 'a@b.co', password: 'longpassword' }, {}, '10.1.1.3')).statusCode).toBe(400);
    expect((await post('/api/auth/register', { username: 'okname', email: 'nope', password: 'longpassword' }, {}, '10.1.1.4')).statusCode).toBe(400);
    expect((await post('/api/auth/register', { username: 'okname', email: 'a@b.co', password: 'short' }, {}, '10.1.1.5')).statusCode).toBe(400);
    expect(
      (await post('/api/auth/register', { username: 'okname', email: 'a@b.co', password: 'longpassword', isAdmin: true }, {}, '10.1.1.6')).statusCode,
    ).toBe(400);
  });

  it('logs in with username or email, rejects a wrong password with a generic error', async () => {
    await register(t, 'loginuser', 'the right password');
    const ok1 = await post('/api/auth/login', { login: 'loginuser', password: 'the right password' });
    expect(ok1.statusCode).toBe(200);
    const ok2 = await post('/api/auth/login', { login: 'LoginUser@Example.com', password: 'the right password' });
    expect(ok2.statusCode).toBe(200);
    const bad = await post('/api/auth/login', { login: 'loginuser', password: 'wrong' });
    expect(bad.statusCode).toBe(401);
    const ghost = await post('/api/auth/login', { login: 'nobody', password: 'wrong' });
    expect(ghost.statusCode).toBe(401);
    expect(JSON.parse(bad.body).error).toBe(JSON.parse(ghost.body).error);
  });

  it('session cookie is httpOnly + SameSite=Lax and only the hash is stored', async () => {
    const res = await post('/api/auth/register', { username: 'cookieuser', email: 'cookie@example.com', password: 'longpassword' }, {}, '10.1.2.1');
    const sc = String(res.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    const token = sc.split(';')[0]!.split('=')[1]!;
    const rows = await t.ctx.sql`SELECT token_hash FROM sessions`;
    expect(rows.every((r) => !Buffer.from(r.token_hash as Buffer).toString().includes(token))).toBe(true);
  });

  it('rate-limits login attempts per account', async () => {
    await register(t, 'bruteme');
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await post('/api/auth/login', { login: 'bruteme', password: 'nope' + i }, {}, `10.2.0.${i}`)).statusCode;
    }
    expect(last).toBe(429);
  });

  it('blocks cross-origin state-changing requests (CSRF)', async () => {
    const c = await register(t, 'csrfuser');
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/users/@me/profile',
      headers: { cookie: c.cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      payload: JSON.stringify({ bio: 'pwned' }),
    });
    expect(res.statusCode).toBe(403);
    const res2 = await t.app.inject({
      method: 'PATCH',
      url: '/api/users/@me/profile',
      headers: { cookie: c.cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      payload: JSON.stringify({ bio: 'pwned' }),
    });
    expect(res2.statusCode).toBe(403);
  });

  it('logout revokes the session; changing password logs out other sessions', async () => {
    const c = await register(t, 'sessuser', 'first password');
    const login = await post('/api/auth/login', { login: 'sessuser', password: 'first password' });
    const other = clientFor(t.app, String(login.headers['set-cookie']).split(';')[0]!);
    expect((await other.req('GET', '/api/users/@me')).status).toBe(200);
    expect((await c.req('PUT', '/api/users/@me/password', { currentPassword: 'first password', newPassword: 'second password' })).status).toBe(200);
    await t.ctx.redis.flushdb(); // drop the 5-minute session cache so we hit the DB
    expect((await other.req('GET', '/api/users/@me')).status).toBe(401);
    expect((await c.req('GET', '/api/users/@me')).status).toBe(200);
    await c.req('POST', '/api/auth/logout');
    expect((await c.req('GET', '/api/users/@me')).status).toBe(401);
  });

  it('forgot-password says email is not configured instead of pretending', async () => {
    const r = await post('/api/auth/forgot-password', { email: 'who@example.com' }, {}, '10.3.3.3');
    expect(r.statusCode).toBe(400);
  });

  it('closed registration', async () => {
    const t2 = await createTestApp({ REGISTRATION: 'closed' });
    const r = await t2.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ username: 'nope', email: 'nope@example.com', password: 'longpassword' }),
    });
    expect(r.statusCode).toBe(403);
    await t2.close();
    // the second app wiped the schema, rebuild ours for any later tests in this file
    t = await createTestApp();
  });
});
