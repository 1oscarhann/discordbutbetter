import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, guildWith, register, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Client, bob: Client, carol: Client;

beforeAll(async () => {
  t = await createTestApp();
  admin = await register(t, 'root_user'); // first account on the instance → admin
  bob = await register(t, 'bob_admin_test');
  carol = await register(t, 'carol_admin_test');
});
afterAll(async () => t.close());
beforeEach(async () => {
  const keys = await t.ctx.redis.keys('rl:*');
  if (keys.length) await t.ctx.redis.del(...keys);
});

describe('instance admin', () => {
  it('makes the first account an admin and nobody else', async () => {
    expect((await admin.req('GET', '/api/users/@me')).body.isAdmin).toBe(true);
    expect((await bob.req('GET', '/api/users/@me')).body.isAdmin).toBe(false);
  });

  it('refuses every admin route to non-admins', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/stats'],
      ['GET', '/api/admin/users'],
      ['PATCH', `/api/admin/users/${carol.id}`, { disabled: true }],
      ['POST', `/api/admin/users/${carol.id}/reset-link`, {}],
      ['GET', '/api/admin/invites'],
      ['POST', '/api/admin/invites', {}],
      ['GET', '/api/admin/guilds'],
      ['DELETE', '/api/admin/guilds/123'],
    ];
    for (const [m, url, body] of calls) {
      const r = await bob.req(m, url, body);
      expect(r.status, `${m} ${url}`).toBe(403);
    }
  });

  it('shows stats and searches users', async () => {
    const s = await admin.req('GET', '/api/admin/stats');
    expect(s.status).toBe(200);
    expect(s.body.users).toBe(3);
    const r = await admin.req('GET', '/api/admin/users?q=bob_');
    expect(r.body.map((u: { username: string }) => u.username)).toEqual(['bob_admin_test']);
    expect(r.body[0].email).toBe('bob_admin_test@example.com');
    // LIKE wildcards in the search are literal, not patterns
    expect((await admin.req('GET', '/api/admin/users?q=%25')).body).toEqual([]);
  });

  it('disabling someone logs them out and blocks login', async () => {
    const r = await admin.req('PATCH', `/api/admin/users/${carol.id}`, { disabled: true });
    expect(r.status).toBe(200);
    expect(r.body.disabled).toBe(true);
    expect((await carol.req('GET', '/api/users/@me')).status).toBe(401);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      payload: JSON.stringify({ login: 'carol_admin_test', password: 'correct horse battery' }),
    });
    expect(login.statusCode).toBe(403);
    // and back
    expect((await admin.req('PATCH', `/api/admin/users/${carol.id}`, { disabled: false })).body.disabled).toBe(false);
  });

  it("won't let an admin lock themselves (or the instance) out", async () => {
    expect((await admin.req('PATCH', `/api/admin/users/${admin.id}`, { disabled: true })).status).toBe(400);
    // last admin can't be demoted
    expect((await admin.req('PATCH', `/api/admin/users/${admin.id}`, { isAdmin: false })).status).toBe(400);
    // with a second admin it works, and the new admin gets access
    expect((await admin.req('PATCH', `/api/admin/users/${bob.id}`, { isAdmin: true })).body.isAdmin).toBe(true);
    expect((await bob.req('GET', '/api/admin/stats')).status).toBe(200);
    // admins must lose admin before being disabled
    expect((await admin.req('PATCH', `/api/admin/users/${bob.id}`, { disabled: true })).status).toBe(400);
    expect((await admin.req('PATCH', `/api/admin/users/${bob.id}`, { isAdmin: false })).body.isAdmin).toBe(false);
    expect((await bob.req('GET', '/api/admin/stats')).status).toBe(403);
  });

  it('reset links work once', async () => {
    const r = await admin.req('POST', `/api/admin/users/${carol.id}/reset-link`, {});
    expect(r.status).toBe(200);
    const token = new URL(r.body.url).searchParams.get('token')!;
    const reset = (password: string) =>
      t.app.inject({
        method: 'POST',
        url: '/api/auth/reset-password',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
        payload: JSON.stringify({ token, password }),
      });
    expect((await reset('a brand new password')).statusCode).toBe(200);
    expect((await reset('another new password')).statusCode).toBe(400);
  });

  it('creates and revokes sign-up invites', async () => {
    const c = await admin.req('POST', '/api/admin/invites', { maxUses: 2, days: 1 });
    expect(c.status).toBe(200);
    expect(c.body.url).toContain(`/register?code=${c.body.code}`);
    const list = await admin.req('GET', '/api/admin/invites');
    expect(list.body.some((i: { code: string; maxUses: number }) => i.code === c.body.code && i.maxUses === 2)).toBe(true);
    expect((await admin.req('DELETE', `/api/admin/invites/${c.body.code}`)).status).toBe(200);
    expect((await admin.req('DELETE', `/api/admin/invites/${c.body.code}`)).status).toBe(404);
    expect((await admin.req('POST', '/api/admin/invites', { maxUses: -1 })).status).toBe(400);
  });

  it('lists and takes down servers', async () => {
    const dave = await register(t, 'dave_admin_test');
    const { guild } = await guildWith(bob, dave);
    const list = await admin.req('GET', '/api/admin/guilds');
    const row = list.body.find((g: { id: string }) => g.id === guild.id);
    expect(row.memberCount).toBe(2);
    expect(row.owner.username).toBe('bob_admin_test');
    expect((await admin.req('DELETE', `/api/admin/guilds/${guild.id}`)).status).toBe(200);
    expect((await bob.req('GET', `/api/guilds/${guild.id}`)).status).toBe(404);
  });
});
