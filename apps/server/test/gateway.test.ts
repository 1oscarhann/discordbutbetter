import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelType, Permissions as P } from '@haunt/shared';
import { connectGateway, createTestApp, guildWith, register, sleep, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let base: string;
let a: Client, b: Client;
let guildId: string, general: string;

beforeAll(async () => {
  t = await createTestApp();
  base = await t.app.listen({ host: '127.0.0.1', port: 0 });
  a = await register(t, 'gwa');
  b = await register(t, 'gwb');
  const g = await guildWith(a, b);
  guildId = g.guild.id;
  general = g.general.id;
});
afterAll(async () => t.close());

describe('gateway', () => {
  it('rejects unauthenticated and cross-origin sockets', async () => {
    await expect(connectGateway(base, 'sid=nope')).rejects.toThrow(/401/);
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(base.replace('http', 'ws') + '/gateway', { headers: { cookie: a.cookie, origin: 'https://evil.example' } });
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_r, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it('READY has guilds, channels and presences', async () => {
    const gw = await connectGateway(base, b.cookie);
    const ready = await gw.waitFor('READY');
    expect(ready.user.id).toBe(b.id);
    expect(ready.guilds[0].id).toBe(guildId);
    expect(ready.guilds[0].channels.some((c: any) => c.id === general)).toBe(true);
    gw.close();
  });

  it('delivers messages and typing to channel viewers', async () => {
    const gw = await connectGateway(base, b.cookie);
    await gw.waitFor('READY');
    await a.req('POST', `/api/channels/${general}/messages`, { content: 'live!' });
    const m = await gw.waitFor('MESSAGE_CREATE', (d) => d.content === 'live!');
    expect(m.author.id).toBe(a.id);
    await a.req('POST', `/api/channels/${general}/typing`);
    const ty = await gw.waitFor('TYPING_START');
    expect(ty.userId).toBe(a.id);
    gw.close();
  });

  it('hidden channels never leak, and visibility changes arrive as CHANNEL_CREATE/DELETE', async () => {
    const gw = await connectGateway(base, b.cookie);
    await gw.waitFor('READY');
    const secret = (await a.req('POST', `/api/guilds/${guildId}/channels`, { name: 'mods only', type: ChannelType.TEXT, private: true })).body;
    await a.req('POST', `/api/channels/${secret.id}/messages`, { content: 'top secret' });
    await sleep(400);
    expect(gw.events.some((e) => e.t === 'CHANNEL_CREATE' && e.d.id === secret.id)).toBe(false);
    expect(gw.events.some((e) => e.t === 'MESSAGE_CREATE' && e.d.content === 'top secret')).toBe(false);

    // give b access via a member overwrite
    await a.req('PUT', `/api/channels/${secret.id}/permissions/${b.id}`, { type: 1, allow: P.VIEW_CHANNEL.toString(), deny: '0' });
    const created = await gw.waitFor('CHANNEL_CREATE', (d) => d.id === secret.id);
    expect(created.name).toBe('mods-only');
    await a.req('POST', `/api/channels/${secret.id}/messages`, { content: 'now you can see' });
    await gw.waitFor('MESSAGE_CREATE', (d) => d.content === 'now you can see');

    // take it away again
    await a.req('DELETE', `/api/channels/${secret.id}/permissions/${b.id}`);
    await gw.waitFor('CHANNEL_DELETE', (d) => d.id === secret.id);
    gw.close();
  });

  it('role changes recompute visibility', async () => {
    const gw = await connectGateway(base, b.cookie);
    await gw.waitFor('READY');
    const role = (await a.req('POST', `/api/guilds/${guildId}/roles`, { name: 'insider' })).body;
    const vip = (await a.req('POST', `/api/guilds/${guildId}/channels`, { name: 'vip', type: ChannelType.TEXT, private: true })).body;
    await a.req('PUT', `/api/channels/${vip.id}/permissions/${role.id}`, { type: 0, allow: P.VIEW_CHANNEL.toString(), deny: '0' });
    await a.req('PUT', `/api/guilds/${guildId}/members/${b.id}/roles/${role.id}`);
    await gw.waitFor('CHANNEL_CREATE', (d) => d.id === vip.id);
    await a.req('DELETE', `/api/guilds/${guildId}/members/${b.id}/roles/${role.id}`);
    await gw.waitFor('CHANNEL_DELETE', (d) => d.id === vip.id);
    gw.close();
  });

  it('joining a guild sends GUILD_CREATE; being kicked sends GUILD_DELETE', async () => {
    const c = await register(t, 'gwc');
    const gw = await connectGateway(base, c.cookie);
    await gw.waitFor('READY');
    const { invite } = await guildWith(a);
    await c.req('POST', `/api/invites/${invite}`);
    const gc = await gw.waitFor('GUILD_CREATE');
    await a.req('DELETE', `/api/guilds/${gc.id}/members/${c.id}`, {});
    await gw.waitFor('GUILD_DELETE', (d) => d.id === gc.id);
    gw.close();
  });

  it('presence: online on connect, offline with last seen on disconnect', async () => {
    const watcher = await connectGateway(base, a.cookie);
    await watcher.waitFor('READY');
    const gw = await connectGateway(base, b.cookie);
    await watcher.waitFor('PRESENCE_UPDATE', (d) => d.userId === b.id && d.status === 'online');
    gw.close();
    const off = await watcher.waitFor('PRESENCE_UPDATE', (d) => d.userId === b.id && d.status === 'offline');
    expect(off.lastSeenAt).not.toBeNull();
    watcher.close();
  });

  it('invisible looks offline to others', async () => {
    const watcher = await connectGateway(base, a.cookie);
    await watcher.waitFor('READY');
    const gw = await connectGateway(base, b.cookie);
    await watcher.waitFor('PRESENCE_UPDATE', (d) => d.userId === b.id && d.status === 'online');
    await b.req('PUT', '/api/users/@me/status', { status: 'invisible' });
    await watcher.waitFor('PRESENCE_UPDATE', (d) => d.userId === b.id && d.status === 'offline');
    await b.req('PUT', '/api/users/@me/status', { status: 'online' });
    gw.close();
    watcher.close();
  });
});
