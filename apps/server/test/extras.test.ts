import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ChannelType, Permissions as P, MessageType } from '@haunt/shared';
import { createTestApp, guildWith, register, type Client, type TestApp } from './helpers.js';
import { FetchBlocked, isPublicAddress, safeFetch } from '../src/lib/safefetch.js';
import { parseMeta } from '../src/services/embeds.js';
import { domainBlocked, matchKeyword } from '../src/services/automod.js';
import { toTsQuery } from '../src/routes/search.js';
import { setVoiceState } from '../src/services/voice.js';

let t: TestApp;
let a: Client, b: Client, c: Client;
let guildId: string, general: string;

beforeAll(async () => {
  t = await createTestApp();
  a = await register(t, 'xa');
  b = await register(t, 'xb');
  c = await register(t, 'xc');
  const g = await guildWith(a, b, c);
  guildId = g.guild.id;
  general = g.general.id;
});
afterAll(async () => t.close());
beforeEach(async () => {
  const keys = await t.ctx.redis.keys('rl:*');
  if (keys.length) await t.ctx.redis.del(...keys);
});

async function upload(cl: Client, purpose: string, buf: Buffer, filename: string) {
  const boundary = '----x' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n\r\n`),
    buf,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await t.app.inject({
    method: 'POST',
    url: `/api/files?purpose=${purpose}`,
    headers: { cookie: cl.cookie, origin: 'http://localhost:5173', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe('SSRF protection', () => {
  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '169.254.169.254', '::1', 'fc00::1', '100.64.0.1', '0.0.0.0', '::ffff:127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses private targets, odd ports and schemes', async () => {
    const opts = { maxBytes: 1000, accept: '*/*', userAgent: 'test' };
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://example.com:22/', 'file:///etc/passwd', 'http://u:p@example.com/']) {
      await expect(safeFetch(url, opts), url).rejects.toBeInstanceOf(FetchBlocked);
    }
  });
});

describe('helpers', () => {
  it('parses OpenGraph tags', () => {
    const m = parseMeta(
      `<html><head><title>Fallback</title><meta property="og:title" content="Real &amp; Title"><meta name="description" content="Desc">
       <meta property="og:image" content="/img.png"><meta name="theme-color" content="#123abc"></head></html>`,
      'https://example.com/page',
    );
    expect(m).toMatchObject({ title: 'Real & Title', description: 'Desc', image: 'https://example.com/img.png', themeColor: '#123abc' });
  });

  it('keyword matching', () => {
    expect(matchKeyword('you are a h@ck3r', ['hacker'], [])).toBe('hacker');
    expect(matchKeyword('shacker', ['hacker'], [])).toBeNull();
    expect(matchKeyword('shacker', ['*hacker'], [])).toBe('*hacker');
    expect(matchKeyword('scunthorpe', ['*cunt*'], ['scunthorpe'])).toBeNull();
    expect(matchKeyword('buy cheap pills now', ['cheap pills'], [])).toBe('cheap pills');
  });

  it('domain matching', () => {
    expect(domainBlocked('evil.com', ['evil.com'])).toBe(true);
    expect(domainBlocked('a.evil.com', ['evil.com'])).toBe(true);
    expect(domainBlocked('notevil.com', ['evil.com'])).toBe(false);
    expect(domainBlocked('x.evil.com', ['*.evil.com'])).toBe(true);
  });

  it('tsquery building strips operators', () => {
    expect(toTsQuery("hello wor")).toBe('hello & wor:*');
    expect(toTsQuery("a & b | !c")).toBe('a & b & c:*');
    expect(toTsQuery("&&&")).toBeNull();
  });
});

describe('mini games over the API', () => {
  it('tic-tac-toe in a DM', async () => {
    const dm = (await a.req('POST', '/api/users/@me/channels', { recipientIds: [b.id] })).body;
    const g = (await a.req('POST', `/api/channels/${dm.id}/games`, { kind: 'tictactoe' })).body;
    expect(g.status).toBe('lobby');
    expect((await c.req('POST', `/api/games/${g.id}/join`)).status).toBe(404); // not in the DM
    const joined = (await b.req('POST', `/api/games/${g.id}/join`)).body;
    expect(joined.status).toBe('playing');
    expect((await b.req('POST', `/api/games/${g.id}/move`, { move: { cell: 0 } })).status).toBe(400); // not b's turn
    expect((await a.req('POST', `/api/games/${g.id}/move`, { move: { cell: 4 } })).status).toBe(200);
    const msgs = (await b.req('GET', `/api/channels/${dm.id}/messages`)).body;
    expect(msgs.some((m: any) => m.type === MessageType.GAME && m.metadata.gameId === g.id)).toBe(true);
  });

  it('hangman never shows the word to guessers', async () => {
    const dm = (await a.req('POST', '/api/users/@me/channels', { recipientIds: [c.id] })).body;
    const g = (await a.req('POST', `/api/channels/${dm.id}/games`, { kind: 'hangman', options: { word: 'secret' } })).body;
    expect(g.view.word).toBe('secret'); // host sees it
    await c.req('POST', `/api/games/${g.id}/join`);
    const seen = (await c.req('GET', `/api/games/${g.id}`)).body;
    expect(seen.view.word).toBeNull();
    expect(JSON.stringify(seen)).not.toContain('secret');
    const after = (await c.req('POST', `/api/games/${g.id}/move`, { move: { guess: 'e' } })).body;
    expect(after.view.masked).toBe('_e__e_');
  });

  it('voice-channel games need you to be in the call', async () => {
    const voice = (await a.req('GET', `/api/guilds/${guildId}`)).body;
    void voice;
    const chans = await t.ctx.sql<{ id: string }[]>`SELECT id FROM channels WHERE guild_id = ${guildId} AND type = ${ChannelType.VOICE}`;
    const vc = chans[0]!.id;
    expect((await b.req('POST', `/api/channels/${vc}/games`, { kind: 'connect4' })).status).toBe(403);
    await setVoiceState(t.ctx, { guildId, channelId: vc, userId: b.id, selfMute: false, selfDeaf: false, serverMute: false, serverDeaf: false, video: false, streaming: false });
    expect((await b.req('POST', `/api/channels/${vc}/games`, { kind: 'connect4' })).status).toBe(200);
    // watch together: same rule
    expect((await c.req('POST', `/api/channels/${vc}/watch`, { action: 'load', url: 'https://youtu.be/dQw4w9WgXcQ' })).status).toBe(403);
    const w = await b.req('POST', `/api/channels/${vc}/watch`, { action: 'pause', position: 0 });
    expect(w.status).toBe(404); // nothing loaded yet
  });

  it('voice join says voice is not configured instead of failing weirdly', async () => {
    const chans = await t.ctx.sql<{ id: string }[]>`SELECT id FROM channels WHERE guild_id = ${guildId} AND type = ${ChannelType.VOICE}`;
    expect((await a.req('POST', `/api/channels/${chans[0]!.id}/voice/join`)).status).toBe(503);
  });
});

describe('wiki', () => {
  it('everyone reads, only MANAGE_WIKI edits, revisions kept', async () => {
    const w = (await a.req('POST', `/api/guilds/${guildId}/channels`, { name: 'Rules', type: ChannelType.WIKI })).body;
    const page = (await a.req('POST', `/api/channels/${w.id}/wiki`, { title: 'Rules', content: '1. be nice' })).body;
    expect((await b.req('GET', `/api/channels/${w.id}/wiki/${page.id}`)).body.content).toBe('1. be nice');
    expect((await b.req('PATCH', `/api/channels/${w.id}/wiki/${page.id}`, { content: 'anarchy' })).status).toBe(403);
    const role = (await a.req('POST', `/api/guilds/${guildId}/roles`, { name: 'editor', permissions: P.MANAGE_WIKI.toString() })).body;
    await a.req('PUT', `/api/guilds/${guildId}/members/${b.id}/roles/${role.id}`);
    expect((await b.req('PATCH', `/api/channels/${w.id}/wiki/${page.id}`, { content: '1. be very nice' })).status).toBe(200);
    const revs = (await c.req('GET', `/api/channels/${w.id}/wiki/${page.id}/revisions`)).body;
    expect(revs.map((r: any) => r.content)).toEqual(['1. be very nice', '1. be nice']);
    expect((await a.req('POST', `/api/channels/${w.id}/messages`, { content: 'chat here?' })).status).toBe(403);
  });
});

describe('custom emoji', () => {
  it('uploads, uses, and strips emoji you cannot use', async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 4, background: '#ff00ff' } }).png().toBuffer();
    const up = await upload(a, 'emoji', png, 'party.png');
    expect(up.body.width).toBe(128);
    expect((await b.req('POST', `/api/guilds/${guildId}/emojis`, { name: 'party', fileId: up.body.id })).status).toBe(403);
    const e = (await a.req('POST', `/api/guilds/${guildId}/emojis`, { name: 'party', fileId: up.body.id })).body;
    const m = (await b.req('POST', `/api/channels/${general}/messages`, { content: `yay <:party:${e.id}>` })).body;
    expect(m.content).toBe(`yay <:party:${e.id}>`);
    // c is not in a's *other* guild, so in a DM with a stranger-ish context the emoji from a guild c isn't in is stripped
    const other = await register(t, 'xother');
    const dm = (await a.req('POST', '/api/users/@me/channels', { recipientIds: [c.id] })).body;
    void other;
    const m2 = (await c.req('POST', `/api/channels/${dm.id}/messages`, { content: `<:fake:${'9'.repeat(18)}>` })).body;
    expect(m2.content).toBe(':fake:');
    expect((await b.req('PUT', `/api/channels/${general}/messages/${m.id}/reactions/c:${e.id}/@me`)).status).toBe(200);
  });
});

describe('settings, status, activity', () => {
  it('settings patch merges and validates', async () => {
    const s1 = (await a.req('PATCH', '/api/users/@me/settings', { compact: true })).body;
    expect(s1.compact).toBe(true);
    const s2 = (await a.req('PATCH', '/api/users/@me/settings', { fontScale: 1.2 })).body;
    expect(s2.compact).toBe(true);
    expect((await a.req('PATCH', '/api/users/@me/settings', { fontScale: 99 })).status).toBe(400);
    expect((await a.req('PATCH', '/api/users/@me/settings', { customTheme: { name: 'x', colors: { bg0: 'red' } } })).status).toBe(400);
  });

  it('manual playing status with LFG and allowlisted covers only', async () => {
    expect((await a.req('PUT', '/api/users/@me/activity/playing', { name: 'Celeste', source: 'custom', coverUrl: 'https://evil.com/x.png' })).status).toBe(400);
    const ok = await a.req('PUT', '/api/users/@me/activity/playing', {
      name: 'Celeste',
      source: 'igdb',
      sourceId: '26226',
      coverUrl: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co3byy.jpg',
      lfg: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.playing).toMatchObject({ name: 'Celeste', lfg: true });
    // stays while offline
    const p = (await b.req('GET', `/api/users/${a.id}/profile`)).body;
    expect(p.presence.playing.name).toBe('Celeste');
    expect((await a.req('PATCH', '/api/users/@me/activity/playing', { lfg: false })).body.playing.lfg).toBe(false);
  });

  it('custom status with expiry', async () => {
    const r = await a.req('PUT', '/api/users/@me/custom-status', { text: 'brb', emoji: '🍕', expiresInSeconds: 3600 });
    expect(r.body.customStatus.text).toBe('brb');
    expect(r.body.customStatus.expiresAt).not.toBeNull();
  });
});

describe('account deletion', () => {
  it('owners must transfer first; deleted users become tombstones', async () => {
    expect((await a.req('DELETE', '/api/users/@me', { password: 'correct horse battery' })).status).toBe(409);
    const d = await register(t, 'leaving');
    const dmWith = (await d.req('POST', '/api/users/@me/channels', { recipientIds: [] }).catch(() => null)) ?? null;
    void dmWith;
    expect((await d.req('DELETE', '/api/users/@me', { password: 'wrong' })).status).toBe(403);
    expect((await d.req('DELETE', '/api/users/@me', { password: 'correct horse battery' })).status).toBe(200);
    const [row] = await t.ctx.sql`SELECT email, password_hash, deleted, username FROM users WHERE id = ${d.id}`;
    expect(row).toMatchObject({ email: null, password_hash: null, deleted: true });
    expect((await d.req('GET', '/api/users/@me')).status).toBe(401);
  });

  it('data export works', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/users/@me/export', headers: { cookie: b.cookie } });
    expect(res.statusCode).toBe(200);
    const j = JSON.parse(res.body);
    expect(j.account.username).toBe('xb');
    expect(j.account.password_hash).toBeUndefined();
  });
});
