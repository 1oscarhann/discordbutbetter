import type { FastifyRequest } from 'fastify';
import type { Redis } from '../redis.js';
import { tooMany } from '../errors.js';

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

/** Fixed-window counter in Valkey. Atomic via MULTI. */
export async function hit(redis: Redis, bucket: string, key: string, limit: number, windowSec: number): Promise<LimitResult> {
  const k = `rl:${bucket}:${key}`;
  const res = await redis.multi().incr(k).expire(k, windowSec, 'NX').ttl(k).exec();
  const count = Number(res?.[0]?.[1] ?? 0);
  const ttl = Math.max(1, Number(res?.[2]?.[1] ?? windowSec));
  return { ok: count <= limit, remaining: Math.max(0, limit - count), retryAfter: ttl };
}

export function clientKey(req: FastifyRequest): string {
  return req.auth?.userId ?? `ip:${req.ip}`;
}

/** Throws 429 when over the limit. Default key: user id, or IP for logged-out requests. */
export async function limit(
  req: FastifyRequest,
  bucket: string,
  max: number,
  windowSec: number,
  key: string = clientKey(req),
  message?: string,
): Promise<void> {
  const r = await hit(req.server.ctx.redis, bucket, key, max, windowSec);
  if (!r.ok) throw tooMany(r.retryAfter, message ?? `Slow down — try again in ${r.retryAfter}s`);
}

/** Preset limits, in one place so they're easy to tune. [max, windowSeconds] */
export const Limits = {
  loginIp: [20, 600],
  loginAccount: [8, 600],
  registerIp: [5, 3600],
  emailIp: [5, 3600],
  messageChannel: [5, 5],
  messageGlobal: [15, 10],
  edit: [10, 10],
  reaction: [20, 10],
  upload: [30, 60],
  friendRequest: [20, 3600],
  dmCreate: [20, 600],
  guildCreate: [10, 3600],
  inviteJoin: [20, 3600],
  inviteCreate: [20, 600],
  search: [20, 60],
  guestbook: [10, 3600],
  profile: [30, 600],
  lookup: [30, 60],
  typing: [12, 60],
  proxy: [300, 60],
  modAction: [60, 60],
  game: [60, 30],
  watch: [40, 30],
  general: [120, 60],
} as const satisfies Record<string, readonly [number, number]>;

export async function limitPreset(req: FastifyRequest, name: keyof typeof Limits, key?: string): Promise<void> {
  const [max, win] = Limits[name];
  return limit(req, name, max, win, key);
}
