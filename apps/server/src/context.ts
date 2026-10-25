import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import type { Redis } from './redis.js';
import type { Storage } from './lib/storage.js';
import type { Mailer } from './lib/email.js';
import type { Bus } from './lib/bus.js';
import type { Voice } from './services/voice.js';

/** Everything a route or service needs. One per process. */
export interface Ctx {
  config: Config;
  sql: Sql;
  redis: Redis;
  /** Dedicated connection for SUBSCRIBE. */
  sub: Redis;
  storage: Storage;
  mailer: Mailer;
  bus: Bus;
  voice: Voice | null;
  log: FastifyBaseLogger;
}

export interface Auth {
  userId: string;
  sessionId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
  interface FastifyRequest {
    auth: Auth | null;
  }
}
