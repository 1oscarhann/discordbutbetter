import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ChannelType, MessageFlags } from '@dbb/shared';
import { createTestApp, guildWith, register, sleep, type Client, type TestApp } from './helpers.js';
import { JOBS } from '../src/jobs/index.js';

let t: TestApp;
let a: Client, b: Client, c: Client;
let guildId: string, general: string;

const job = (name: string) => JOBS.find((j) => j.name === name)!.run(t.ctx);

beforeAll(async () => {
  t = await createTestApp();
  a = await register(t, 'anna');
  b = await register(t, 'ben');
  c = await register(t, 'cleo');
  const g = await guildWith(a, b, c);
  guildId = g.guild.id;
  general = g.general.id;
});
afterAll(async () => t.close());

/** Tests here send bursts of messages; clear rate-limit and slowmode counters between them. */
async function resetLimits() {
  const keys = await t.ctx.redis.keys('rl:*');
  if (keys.length) await t.ctx.redis.del(...keys);
}
beforeEach(resetLimits);

async function upload(cl: Client, purpose: string, buf: Buffer, filename: string) {
  const boundary = '----dbbtest' + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
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

describe('messages', () => {
  it('send, edit with history, delete', async () => {
    const m = (await a.req('POST', `/api/channels/${general}/messages`, { content: 'first version', nonce: 'n1' })).body;
    expect(m.content).toBe('first version');
    expect(m.nonce).toBe('n1');
    const e = await a.req('PATCH', `/api/channels/${general}/messages/${m.id}`, { content: 'second version' });
    expect(e.body.editedAt).not.toBeNull();
    await a.req('PATCH', `/api/channels/${general}/messages/${m.id}`, { content: 'third version' });
    const hist = (await b.req('GET', `/api/channels/${general}/messages/${m.id}/edits`)).body;
    expect(hist.map((h: any) => h.content)).toEqual(['second version', 'first version']);
    expect((await a.req('DELETE', `/api/channels/${general}/messages/${m.id}`)).status).toBe(200);
    expect((await b.req('GET', `/api/channels/${general}/messages/${m.id}`)).status).toBe(404);
  });

  it('pagination before/after/around', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      await resetLimits();
      ids.push((await a.req('POST', `/api/channels/${general}/messages`, { content: `p${i}` })).body.id);
    }
    const latest = (await b.req('GET', `/api/channels/${general}/messages?limit=5`)).body;
    expect(latest.map((m: any) => m.content)).toEqual(['p11', 'p10', 'p9', 'p8', 'p7']);
    const before = (await b.req('GET', `/api/channels/${general}/messages?limit=3&before=${ids[5]}`)).body;
    expect(before.map((m: any) => m.content)).toEqual(['p4', 'p3', 'p2']);
    const after = (await b.req('GET', `/api/channels/${general}/messages?limit=3&after=${ids[5]}`)).body;
    expect(after.map((m: any) => m.content)).toEqual(['p8', 'p7', 'p6']);
    const around = (await b.req('GET', `/api/channels/${general}/messages?limit=4&around=${ids[5]}`)).body;
    expect(around.map((m: any) => m.content)).toEqual(['p7', 'p6', 'p5', 'p4', 'p3']);
  });

  it('message rate limit kicks in', async () => {
    let status = 0;
    for (let i = 0; i < 8; i++) status = (await c.req('POST', `/api/channels/${general}/messages`, { content: `spam ${i}` })).status;
    expect(status).toBe(429);
  });

  it('replies, reactions, pins', async () => {
    const m = (await a.req('POST', `/api/channels/${general}/messages`, { content: 'react here' })).body;
    const r = (await b.req('POST', `/api/channels/${general}/messages`, { content: 'reply', replyTo: { messageId: m.id, ping: true } })).body;
    expect(r.replyTo.id).toBe(m.id);
    expect(r.mentions).toContain(a.id);
    expect(r.flags & MessageFlags.REPLY_PING).toBeTruthy();

    const fire = encodeURIComponent('🔥');
    expect((await b.req('PUT', `/api/channels/${general}/messages/${m.id}/reactions/${fire}/@me`)).status).toBe(200);
    expect((await c.req('PUT', `/api/channels/${general}/messages/${m.id}/reactions/${fire}/@me`)).status).toBe(200);
    expect((await c.req('PUT', `/api/channels/${general}/messages/${m.id}/reactions/notanemoji/@me`)).status).toBe(400);
    const got = (await b.req('GET', `/api/channels/${general}/messages/${m.id}`)).body;
    expect(got.reactions).toEqual([{ emoji: '🔥', count: 2, me: true }]);

    expect((await b.req('PUT', `/api/channels/${general}/pins/${m.id}`)).status).toBe(403);
    expect((await a.req('PUT', `/api/channels/${general}/pins/${m.id}`)).status).toBe(200);
    expect((await b.req('GET', `/api/channels/${general}/pins`)).body.map((x: any) => x.id)).toContain(m.id);
  });

  it('"while you were away" returns the most-reacted messages since a point', async () => {
    const start = (await a.req('POST', `/api/channels/${general}/messages`, { content: 'baseline' })).body.id;
    const hot = (await a.req('POST', `/api/channels/${general}/messages`, { content: 'hot take' })).body;
    const meh = (await b.req('POST', `/api/channels/${general}/messages`, { content: 'meh' })).body;
    for (const [cl, e] of [[b, '😂'], [c, '😂'], [c, '💯']] as const) {
      await cl.req('PUT', `/api/channels/${general}/messages/${hot.id}/reactions/${encodeURIComponent(e)}/@me`);
    }
    await c.req('PUT', `/api/channels/${general}/messages/${meh.id}/reactions/${encodeURIComponent('👍')}/@me`);
    const h = (await c.req('GET', `/api/channels/${general}/highlights?after=${start}`)).body;
    expect(h.messages.map((m: any) => m.id)).toEqual([hot.id]); // meh only has 1 reaction (< 2)
    expect(h.unread).toBe(2);
  });

  it('mentions bump mention counts; silent send does not; ack clears', async () => {
    await a.req('POST', `/api/channels/${general}/messages`, { content: `<@${c.id}> look` });
    await a.req('POST', `/api/channels/${general}/messages`, { content: `<@${c.id}> silent one`, silent: true });
    const [rs] = await t.ctx.sql`SELECT mention_count FROM read_states WHERE user_id = ${c.id} AND channel_id = ${general}`;
    expect(rs!.mention_count).toBe(1);
    const last = (await c.req('GET', `/api/channels/${general}/messages?limit=1`)).body[0];
    expect(last.flags & MessageFlags.SILENT).toBeTruthy();
    await c.req('POST', `/api/channels/${general}/ack`, { messageId: last.id });
    const [rs2] = await t.ctx.sql`SELECT mention_count FROM read_states WHERE user_id = ${c.id} AND channel_id = ${general}`;
    expect(rs2!.mention_count).toBe(0);
  });

  it('threads', async () => {
    const m = (await a.req('POST', `/api/channels/${general}/messages`, { content: 'thread starter' })).body;
    const th = (await b.req('POST', `/api/channels/${general}/threads`, { name: 'side chat', messageId: m.id })).body;
    expect(th.type).toBe(ChannelType.THREAD);
    expect((await c.req('POST', `/api/channels/${th.id}/messages`, { content: 'in thread' })).status).toBe(200);
    const list = (await c.req('GET', `/api/channels/${general}/threads`)).body;
    expect(list[0].threadMeta.messageCount).toBe(1);
    // lock: only managers can post
    expect((await b.req('PATCH', `/api/channels/${th.id}`, { locked: true })).status).toBe(403);
    expect((await a.req('PATCH', `/api/channels/${th.id}`, { locked: true })).status).toBe(200);
    expect((await c.req('POST', `/api/channels/${th.id}/messages`, { content: 'nope' })).status).toBe(403);
  });

  it('bookmarks with folders; gone when you lose access', async () => {
    const m = (await a.req('POST', `/api/channels/${general}/messages`, { content: 'save me' })).body;
    const folders = (await c.req('POST', '/api/users/@me/bookmark-folders', { name: 'Recipes' })).body;
    expect((await c.req('PUT', `/api/users/@me/bookmarks/${m.id}`, { folderId: folders[0].id, note: 'good' })).status).toBe(200);
    expect((await c.req('GET', '/api/users/@me/bookmarks')).body[0].message.id).toBe(m.id);
    expect((await c.req('GET', `/api/users/@me/bookmarks?folderId=${folders[0].id}`)).body.length).toBe(1);
  });
});

describe('DM extras', () => {
  it('disappearing messages expire', async () => {
    const dm = (await a.req('POST', '/api/users/@me/channels', { recipientIds: [b.id] })).body;
    expect((await a.req('PATCH', `/api/channels/${dm.id}`, { disappearingSeconds: 123 })).status).toBe(400);
    expect((await a.req('PATCH', `/api/channels/${dm.id}`, { disappearingSeconds: 300 })).status).toBe(200);
    const m = (await a.req('POST', `/api/channels/${dm.id}/messages`, { content: 'poof' })).body;
    expect(m.expiresAt).not.toBeNull();
    await t.ctx.sql`UPDATE messages SET expires_at = now() - interval '1 second' WHERE id = ${m.id}`;
    // hidden immediately even before the reaper runs
    expect((await b.req('GET', `/api/channels/${dm.id}/messages`)).body.some((x: any) => x.id === m.id)).toBe(false);
    await job('disappearing');
    const [row] = await t.ctx.sql`SELECT 1 FROM messages WHERE id = ${m.id}`;
    expect(row).toBeUndefined();
  });

  it('read receipts need both sides on', async () => {
    const dm = (await a.req('POST', '/api/users/@me/channels', { recipientIds: [c.id] })).body;
    const m = (await a.req('POST', `/api/channels/${dm.id}/messages`, { content: 'did you read this' })).body;
    await c.req('POST', `/api/channels/${dm.id}/ack`, { messageId: m.id });
    expect((await a.req('GET', `/api/channels/${dm.id}/read-receipts`)).body).toEqual([{ userId: c.id, messageId: m.id }]);
    await c.req('PATCH', '/api/users/@me/privacy', { readReceipts: false });
    expect((await a.req('GET', `/api/channels/${dm.id}/read-receipts`)).body).toEqual([]);
    await c.req('PATCH', '/api/users/@me/privacy', { readReceipts: true });
    await a.req('PATCH', '/api/users/@me/privacy', { readReceipts: false });
    expect((await a.req('GET', `/api/channels/${dm.id}/read-receipts`)).body).toEqual([]);
  });
});

describe('send later', () => {
  it('validates time and sends when due, re-checking permissions', async () => {
    expect((await b.req('POST', `/api/channels/${general}/scheduled-messages`, { content: 'too soon', sendAt: new Date().toISOString() })).status).toBe(400);
    const s = (await b.req('POST', `/api/channels/${general}/scheduled-messages`, { content: 'from the past future', sendAt: new Date(Date.now() + 120_000).toISOString() })).body;
    expect((await b.req('GET', '/api/users/@me/scheduled-messages')).body.length).toBe(1);
    await t.ctx.sql`UPDATE scheduled_messages SET send_at = now() WHERE id = ${s.id}`;
    await job('scheduled');
    expect((await b.req('GET', '/api/users/@me/scheduled-messages')).body.length).toBe(0);
    const last = (await a.req('GET', `/api/channels/${general}/messages?limit=1`)).body[0];
    expect(last.content).toBe('from the past future');
    expect(last.flags & MessageFlags.SCHEDULED).toBeTruthy();

    // lose access before it fires -> it errors instead of sending
    const s2 = (await b.req('POST', `/api/channels/${general}/scheduled-messages`, { content: 'never', sendAt: new Date(Date.now() + 120_000).toISOString() })).body;
    await t.ctx.sql`UPDATE scheduled_messages SET send_at = now() WHERE id = ${s2.id}`;
    await a.req('PATCH', `/api/guilds/${guildId}/members/${b.id}`, { timeoutSeconds: 600 });
    await job('scheduled');
    const pending = (await b.req('GET', '/api/users/@me/scheduled-messages')).body;
    expect(pending[0].error).toMatch(/timed out/i);
    await a.req('PATCH', `/api/guilds/${guildId}/members/${b.id}`, { timeoutSeconds: 0 });
  });
});

describe('uploads', () => {
  it('strips EXIF/GPS from JPEGs and sniffs the real type', async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#ff0000' } })
      .jpeg()
      .withExif({ IFD0: { Make: 'SnitchPhone', Copyright: 'secret-location' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    const up = await upload(a, 'attachment', jpeg, 'holiday.txt');
    expect(up.status).toBe(200);
    expect(up.body.contentType).toBe('image/jpeg');
    expect(up.body.filename).toBe('holiday.jpg');
    const file = await t.app.inject({ method: 'GET', url: up.body.url });
    expect(file.statusCode).toBe(200);
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(String(file.headers['content-security-policy'])).toContain('sandbox');
    const meta = await sharp(file.rawPayload).metadata();
    expect(meta.exif).toBeUndefined();
    expect(file.rawPayload.includes(Buffer.from('SnitchPhone'))).toBe(false);
  });

  it('files with a wrong secret 404, non-media files are forced to download', async () => {
    const up = await upload(a, 'attachment', Buffer.from('<html><script>alert(1)</script></html>'), 'page.html');
    expect(up.status).toBe(200);
    const res = await t.app.inject({ method: 'GET', url: up.body.url });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment/);
    const bad = up.body.url.replace(/\/files\/(\d+)\/[^/]+/, '/files/$1/AAAAAAAAAAAAAAAAAAAAAA');
    expect((await t.app.inject({ method: 'GET', url: bad })).statusCode).toBe(404);
  });

  it('range requests work (video seeking)', async () => {
    const up = await upload(a, 'attachment', Buffer.alloc(5000, 7), 'blob.bin');
    const res = await t.app.inject({ method: 'GET', url: up.body.url, headers: { range: 'bytes=100-199' } });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.length).toBe(100);
  });

  it('avatars must be images and get resized', async () => {
    expect((await upload(a, 'avatar', Buffer.from('not an image'), 'x.png')).status).toBe(400);
    const big = await sharp({ create: { width: 2000, height: 1000, channels: 4, background: '#00ff00' } }).png().toBuffer();
    const up = await upload(a, 'avatar', big, 'me.png');
    expect(up.status).toBe(200);
    expect(up.body.width).toBe(512);
    expect(up.body.height).toBe(512);
    const p = await a.req('PATCH', '/api/users/@me/profile', { avatarFileId: up.body.id });
    expect(p.body.avatar).toBe(up.body.url);
    // can't reuse someone else's upload
    const up2 = await upload(b, 'avatar', big, 'b.png');
    expect((await a.req('PATCH', '/api/users/@me/profile', { avatarFileId: up2.body.id })).status).toBe(400);
  });

  it('attachments: claimed once, need ATTACH_FILES', async () => {
    const up = await upload(a, 'attachment', Buffer.from('hello'), 'hi.txt');
    await resetLimits();
    const m = await a.req('POST', `/api/channels/${general}/messages`, { attachments: [{ fileId: up.body.id }] });
    expect(m.status).toBe(200);
    expect(m.body.attachments[0].filename).toBe('hi.txt');
    expect((await a.req('POST', `/api/channels/${general}/messages`, { attachments: [{ fileId: up.body.id }] })).status).toBe(400);
  });
});

describe('automod', () => {
  it('keyword filter blocks, with wildcards and leetspeak', async () => {
    const r = await a.req('POST', `/api/guilds/${guildId}/automod`, {
      name: 'no badwords',
      trigger: { type: 'keyword', keywords: ['heck', 'darn*'] },
      actions: [{ type: 'block', message: 'Language!' }],
    });
    expect(r.status).toBe(200);
    expect((await b.req('POST', `/api/channels/${general}/messages`, { content: 'what the h3ck' })).body.error).toBe('Language!');
    expect((await b.req('POST', `/api/channels/${general}/messages`, { content: 'darnit' })).status).toBe(403);
    expect((await b.req('POST', `/api/channels/${general}/messages`, { content: 'heckin is fine (whole word only)' })).status).toBe(200);
    // the owner is exempt
    expect((await a.req('POST', `/api/channels/${general}/messages`, { content: 'heck' })).status).toBe(200);
  });
});

describe('levels', () => {
  it('awards XP once per minute and can be turned off', async () => {
    await t.ctx.redis.del(`xpcd:${guildId}:${c.id}`);
    await c.req('POST', `/api/channels/${general}/messages`, { content: 'xp please' });
    await sleep(300);
    const lb = (await c.req('GET', `/api/guilds/${guildId}/levels`)).body;
    expect(lb.me.xp).toBeGreaterThanOrEqual(15);
    expect((await b.req('PATCH', `/api/guilds/${guildId}/levels/settings`, { enabled: false })).status).toBe(403);
    expect((await a.req('PATCH', `/api/guilds/${guildId}/levels/settings`, { enabled: false })).status).toBe(200);
  });
});
