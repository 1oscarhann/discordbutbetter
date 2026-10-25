import { Redis } from 'ioredis';

export type { Redis };

export function createRedis(url: string): Redis {
  const r = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableAutoPipelining: true,
    lazyConnect: false,
  });
  r.on('error', (e) => {
    // ioredis reconnects on its own; just don't crash on transient errors
    if ((e as NodeJS.ErrnoException).code !== 'ECONNREFUSED') console.error('[valkey]', e.message);
  });
  return r;
}

/** Simple distributed lock for background jobs. Returns true if we got it. */
export async function tryLock(redis: Redis, name: string, ttlMs: number): Promise<boolean> {
  const ok = await redis.set(`lock:${name}`, process.pid.toString(), 'PX', ttlMs, 'NX');
  return ok === 'OK';
}
