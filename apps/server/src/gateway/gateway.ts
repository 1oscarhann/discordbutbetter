import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  HEARTBEAT_INTERVAL_MS,
  Permissions as P,
  ChannelType,
  has,
  zId,
  type Channel,
  type ClientMessage,
  type ServerMessage,
} from '@haunt/shared';
import type { Ctx } from '../context.js';
import type { Envelope } from '../lib/bus.js';
import { PermCache } from './permcache.js';
import { buildReady } from './ready.js';
import { buildFullGuild } from '../lib/guildstate.js';
import { loadChannelById } from '../lib/serialize.js';
import { socketDown, socketHeartbeat, socketIdle, socketUp } from '../lib/presence.js';
import { channelAccess } from '../lib/perms.js';
import { toChannel } from '../lib/fanout.js';

const HEARTBEAT_TIMEOUT = HEARTBEAT_INTERVAL_MS * 2.5;
const MAX_BUFFERED = 8 * 1024 * 1024;

/** Process-wide Valkey subscriber → connections. */
class Hub {
  private topics = new Map<string, Set<Conn>>();

  constructor(
    private ctx: Ctx,
    private cache: PermCache,
  ) {
    ctx.sub.on('message', (topic: string, raw: string) => this.onMessage(topic, raw));
  }

  subscribe(topic: string, conn: Conn) {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
      this.ctx.sub.subscribe(topic).catch((e: Error) => this.ctx.log.error({ err: e }, 'subscribe failed'));
    }
    set.add(conn);
  }

  unsubscribe(topic: string, conn: Conn) {
    const set = this.topics.get(topic);
    if (!set) return;
    set.delete(conn);
    if (!set.size) {
      this.topics.delete(topic);
      this.ctx.sub.unsubscribe(topic).catch(() => {});
    }
  }

  private onMessage(topic: string, raw: string) {
    let env: Envelope;
    try {
      env = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (env.invalidate && topic.startsWith('g:')) this.cache.invalidateGuild(topic.slice(2));
    const set = this.topics.get(topic);
    if (!set) return;
    for (const c of set) c.enqueue(topic, env);
  }

  get connectionCount() {
    let n = 0;
    for (const s of this.topics.values()) n += s.size;
    return n;
  }
}

class Conn {
  readonly id = randomUUID();
  lastHeartbeat = Date.now();
  /** guildId -> visible non-thread channel ids */
  visible = new Map<string, Set<string>>();
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private msgBudget = 60;
  private idle = false;
  private topics = new Set<string>();

  constructor(
    private ctx: Ctx,
    private hub: Hub,
    private cache: PermCache,
    private ws: WebSocket,
    readonly userId: string,
    readonly sessionId: string,
  ) {}

  send(msg: ServerMessage) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.close(4009, 'Too slow');
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  close(code: number, reason: string) {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }

  private sub(topic: string) {
    if (this.topics.has(topic)) return;
    this.topics.add(topic);
    this.hub.subscribe(topic, this);
  }

  private unsub(topic: string) {
    if (!this.topics.delete(topic)) return;
    this.hub.unsubscribe(topic, this);
  }

  enqueue(topic: string, env: Envelope) {
    this.queue = this.queue
      .then(() => this.deliver(topic, env))
      .catch((e: Error) => this.ctx.log.warn({ err: e, t: env.t }, 'gateway delivery failed'));
  }

  async start() {
    this.send({ op: 'hello', d: { heartbeatInterval: HEARTBEAT_INTERVAL_MS } });
    this.sub(`u:${this.userId}`);
    const guilds = await this.ctx.sql<{ guild_id: string }[]>`SELECT guild_id FROM guild_members WHERE user_id = ${this.userId}`;
    for (const g of guilds) this.sub(`g:${g.guild_id}`);
    // events that arrive while READY is being built wait in the queue behind it
    this.queue = this.queue.then(async () => {
      const ready = await buildReady(this.ctx, this.cache, this.userId, this.sessionId, this.visible);
      if (!ready) {
        this.send({ op: 'invalid_session' });
        this.close(4001, 'Invalid session');
        return;
      }
      this.send({ op: 'dispatch', t: 'READY', d: ready });
    });
    await socketUp(this.ctx, this.userId, this.id);
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    for (const t of [...this.topics]) this.unsub(t);
    await socketDown(this.ctx, this.userId, this.id);
  }

  private async deliver(topic: string, env: Envelope) {
    if (this.closed) return;
    if (env.only && !env.only.includes(this.userId)) return;
    if (env.exclude?.includes(this.userId)) return;
    if (env.onlySession && env.onlySession !== this.sessionId) return;
    if (env.excludeSession && env.excludeSession === this.sessionId) return;

    switch (env.t) {
      case '_GUILD_JOIN':
        return this.joinGuild((env.d as { guildId: string }).guildId);
      case '_GUILD_LEAVE':
        return this.leaveGuild((env.d as { guildId: string }).guildId);
      case '_PERMS_CHANGED': {
        const d = env.d as { guildId: string; userId?: string };
        if (d.userId && d.userId !== this.userId) return;
        return this.recompute(d.guildId);
      }
      case '_PER_USER':
        return;
      case 'SESSION_REVOKED':
        this.send({ op: 'dispatch', t: 'SESSION_REVOKED', d: {} });
        this.close(4004, 'Session revoked');
        return;
    }

    if (topic.startsWith('g:')) {
      const guildId = topic.slice(2);
      const vis = this.visible.get(guildId);
      if (!vis) return;
      if (env.t === 'CHANNEL_CREATE' || env.t === 'CHANNEL_UPDATE') {
        const ch = env.d as Channel;
        const perms = await this.cache.channelPerms(guildId, ch.id, this.userId);
        if (has(perms, P.VIEW_CHANNEL)) {
          const isNew = !vis.has(ch.id);
          vis.add(ch.id);
          this.send({ op: 'dispatch', t: isNew ? 'CHANNEL_CREATE' : env.t, d: ch });
        } else if (vis.has(ch.id)) {
          vis.delete(ch.id);
          this.send({ op: 'dispatch', t: 'CHANNEL_DELETE', d: { id: ch.id, guildId } });
        }
        return;
      }
      if (env.t === 'CHANNEL_DELETE') {
        const id = (env.d as { id: string }).id;
        if (!vis.has(id)) return;
        vis.delete(id);
      } else if (env.channelId && !vis.has(env.channelId)) {
        return;
      }
      if (env.perm) {
        const need = BigInt(env.perm);
        const perms = env.channelId
          ? await this.cache.channelPerms(guildId, env.channelId, this.userId)
          : ((await this.cache.guildPerms(guildId, this.userId)) ?? 0n);
        if (!has(perms, need)) return;
      }
    }
    this.send({ op: 'dispatch', t: env.t, d: env.d } as ServerMessage);
  }

  private async joinGuild(guildId: string) {
    if (this.visible.has(guildId)) return;
    this.cache.invalidateGuild(guildId);
    this.sub(`g:${guildId}`);
    const vis = await this.cache.visibleChannels(guildId, this.userId);
    this.visible.set(guildId, vis);
    const fg = await buildFullGuild(this.ctx, guildId, this.userId, vis);
    if (fg) this.send({ op: 'dispatch', t: 'GUILD_CREATE', d: fg });
  }

  private async leaveGuild(guildId: string) {
    this.unsub(`g:${guildId}`);
    this.visible.delete(guildId);
    this.send({ op: 'dispatch', t: 'GUILD_DELETE', d: { id: guildId } });
  }

  private async recompute(guildId: string) {
    const old = this.visible.get(guildId);
    if (!old) return;
    const now = await this.cache.visibleChannels(guildId, this.userId);
    this.visible.set(guildId, now);
    for (const id of old) if (!now.has(id)) this.send({ op: 'dispatch', t: 'CHANNEL_DELETE', d: { id, guildId } });
    for (const id of now) {
      if (old.has(id)) continue;
      const ch = await loadChannelById(this.ctx.sql, id);
      if (ch) this.send({ op: 'dispatch', t: 'CHANNEL_CREATE', d: ch });
    }
    const perms = await this.cache.guildPerms(guildId, this.userId);
    if (perms !== null) this.send({ op: 'dispatch', t: 'GUILD_PERMISSIONS_UPDATE', d: { guildId, permissions: perms.toString() } });
  }

  async onMessage(raw: string) {
    if (--this.msgBudget < 0) {
      this.close(4008, 'Rate limited');
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.close(4002, 'Invalid payload');
      return;
    }
    switch (msg?.op) {
      case 'heartbeat': {
        this.lastHeartbeat = Date.now();
        const t = typeof msg.d?.t === 'number' ? msg.d.t : 0;
        this.send({ op: 'heartbeat_ack', d: { t, server: Date.now() } });
        await socketHeartbeat(this.ctx, this.userId, this.id);
        return;
      }
      case 'idle': {
        const idle = !!msg.d?.idle;
        if (idle === this.idle) return;
        this.idle = idle;
        await socketIdle(this.ctx, this.userId, this.id, idle);
        return;
      }
      case 'typing': {
        const id = zId.safeParse(msg.d?.channelId);
        if (!id.success) return;
        const fresh = await this.ctx.redis.set(`typing:${id.data}:${this.userId}`, '1', 'EX', 5, 'NX');
        if (fresh !== 'OK') return;
        try {
          const a = await channelAccess(this.ctx, id.data, this.userId);
          const need = a.channel.type === ChannelType.THREAD ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES;
          if (!has(a.perms, need)) return;
          await toChannel(
            this.ctx,
            a.channel,
            'TYPING_START',
            { channelId: a.channel.id, guildId: a.channel.guild_id, userId: this.userId, at: Date.now() },
            { exclude: [this.userId], recipients: a.recipients },
          );
        } catch {
          /* no access: ignore silently */
        }
        return;
      }
      default:
        this.close(4002, 'Unknown op');
    }
  }

  refillBudget() {
    this.msgBudget = 60;
  }
}

export function registerGateway(app: FastifyInstance): { shutdown: () => void } {
  const ctx = app.ctx;
  const cache = new PermCache(ctx.sql);
  const hub = new Hub(ctx, cache);
  const conns = new Set<Conn>();

  const timer = setInterval(() => {
    const now = Date.now();
    void now;
    for (const c of conns) c.refillBudget();
  }, 60_000);
  const hbTimer = setInterval(() => {
    const now = Date.now();
    for (const c of conns) if (now - c.lastHeartbeat > HEARTBEAT_TIMEOUT) c.close(4003, 'Heartbeat timeout');
  }, 15_000);

  app.get(
    '/gateway',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        // WebSockets ignore CORS, so check Origin ourselves (cross-site WebSocket hijacking)
        const origin = req.headers.origin;
        if (origin && origin !== ctx.config.publicUrl) return reply.code(403).send({ error: 'Bad origin' });
        if (!req.auth) return reply.code(401).send({ error: 'Not logged in' });
      },
    },
    (socket, req) => {
      const auth = req.auth!;
      const conn = new Conn(ctx, hub, cache, socket, auth.userId, auth.sessionId);
      conns.add(conn);
      socket.on('message', (data, isBinary) => {
        if (isBinary) return conn.close(4002, 'Binary not supported');
        void conn.onMessage(data.toString());
      });
      socket.on('close', () => {
        conns.delete(conn);
        void conn.stop().catch((e: Error) => ctx.log.warn({ err: e }, 'gateway stop failed'));
      });
      socket.on('error', () => conn.close(1011, 'error'));
      conn.start().catch((e: Error) => {
        ctx.log.error({ err: e }, 'gateway start failed');
        conn.close(1011, 'Internal error');
      });
    },
  );

  return {
    shutdown() {
      clearInterval(timer);
      clearInterval(hbTimer);
      for (const c of conns) {
        c.send({ op: 'reconnect' });
        c.close(1012, 'Restarting');
      }
    },
  };
}
