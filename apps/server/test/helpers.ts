import type { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createDb, migrate } from '../src/db.js';
import { createRedis } from '../src/redis.js';
import { createStorage } from '../src/lib/storage.js';
import { createMailer } from '../src/lib/email.js';
import { Bus } from '../src/lib/bus.js';
import { buildApp } from '../src/app.js';
import type { Ctx } from '../src/context.js';
import { setAllowPrivateFetch } from '../src/lib/safefetch.js';

export interface TestApp {
  app: FastifyInstance;
  ctx: Ctx;
  close: () => Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({ ...process.env, ...env });
  const sql = createDb(config.databaseUrl, 5);
  await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS citext;');
  await migrate(sql);
  const redis = createRedis(config.redisUrl);
  const sub = createRedis(config.redisUrl);
  await redis.flushdb();
  setAllowPrivateFetch(false);
  const { app, shutdownGateway } = await buildApp(
    { config, sql, redis, sub, storage: createStorage(config), mailer: createMailer(config, () => {}), bus: new Bus(redis), voice: null },
    { logger: false },
  );
  await app.ready();
  return {
    app,
    ctx: app.ctx,
    close: async () => {
      shutdownGateway();
      await app.close();
      await sql.end({ timeout: 2 });
      redis.disconnect();
      sub.disconnect();
    },
  };
}

export interface Client {
  id: string;
  username: string;
  cookie: string;
  req: <T = any>(method: string, url: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

export function clientFor(app: FastifyInstance, cookie: string, id = '', username = ''): Client {
  return {
    id,
    username,
    cookie,
    async req(method, url, body) {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie, origin: 'http://localhost:5173', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        payload: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let parsed: unknown = res.body;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        /* not json */
      }
      return { status: res.statusCode, body: parsed as never };
    },
  };
}

let ipCounter = 1;

export async function register(t: TestApp, username: string, password = 'correct horse battery'): Promise<Client> {
  // spread sign-ups over fake IPs so the per-IP sign-up limit doesn't trip
  const ip = `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    payload: JSON.stringify({ username, email: `${username}@example.com`, password }),
  });
  if (res.statusCode !== 200) throw new Error(`register ${username}: ${res.statusCode} ${res.body}`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const user = JSON.parse(res.body).user;
  return clientFor(t.app, cookie, user.id, user.username);
}

/** Creates a guild owned by `owner` and has every other client join through an invite. */
export async function guildWith(owner: Client, ...members: Client[]) {
  const g = (await owner.req('POST', '/api/guilds', { name: 'Test server' })).body;
  const general = g.channels.find((c: any) => c.name === 'general');
  const inv = (await owner.req('POST', `/api/channels/${general.id}/invites`, { maxAgeSeconds: 0, maxUses: 0 })).body;
  for (const m of members) {
    const r = await m.req('POST', `/api/invites/${inv.code}`);
    if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
  }
  return { guild: g, general, invite: inv.code as string };
}

export async function connectGateway(baseUrl: string, cookie: string) {
  const ws = new WebSocket(baseUrl.replace('http', 'ws') + '/gateway', { headers: { cookie, origin: 'http://localhost:5173' } });
  const events: { t: string; d: any }[] = [];
  const waiters: { pred: (e: { t: string; d: any }) => boolean; resolve: (e: { t: string; d: any }) => void }[] = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.op !== 'dispatch') return;
    const e = { t: msg.t, d: msg.d };
    events.push(e);
    for (const w of [...waiters]) {
      if (w.pred(e)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`ws status ${res.statusCode}`)));
  });
  const waitFor = (t: string, pred: (d: any) => boolean = () => true, timeout = 4000) =>
    new Promise<any>((resolve, reject) => {
      const found = events.find((e) => e.t === t && pred(e.d));
      if (found) return resolve(found.d);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
      waiters.push({ pred: (e) => e.t === t && pred(e.d), resolve: (e) => (clearTimeout(timer), resolve(e.d)) });
    });
  return { ws, events, waitFor, close: () => ws.close() };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
