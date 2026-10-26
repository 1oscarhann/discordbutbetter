import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['true', '1', 'yes'].includes(v)));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  PUBLIC_URL: z.url().default('http://localhost:5173'),
  APP_NAME: z.string().min(1).max(40).default('discordbutbetter'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  /**
   * How many reverse proxies sit in front of the app. "true" means one (e.g. Caddy). We never trust
   * the whole X-Forwarded-For chain: its leftmost entries come from the client and could be used
   * to dodge per-IP rate limits.
   */
  TRUST_PROXY: z
    .string()
    .regex(/^(true|false|yes|no|\d{1,2})?$/i, { error: 'TRUST_PROXY must be true, false or a number of proxies' })
    .optional()
    .transform((v): number | undefined => {
      if (v === undefined || v === '') return undefined;
      const l = v.toLowerCase();
      if (l === 'true' || l === 'yes') return 1;
      if (l === 'false' || l === 'no') return 0;
      return Number(l);
    }),

  DATABASE_URL: z.string().default('postgres://dbb:dbb@localhost:5432/dbb'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SECRET: z.string().optional(),

  REGISTRATION: z.enum(['open', 'invite', 'closed']).default('open'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_PATH: z.string().default('./data/files'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,

  MAX_UPLOAD_MB: z.coerce.number().positive().default(100),
  MAX_AVATAR_MB: z.coerce.number().positive().default(15),
  MAX_EMOJI_KB: z.coerce.number().positive().default(1024),
  EMOJIS_PER_GUILD: z.coerce.number().int().positive().default(250),
  STICKERS_PER_GUILD: z.coerce.number().int().positive().default(100),

  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_INTERNAL_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),

  IGDB_CLIENT_ID: z.string().optional(),
  IGDB_CLIENT_SECRET: z.string().optional(),
  RAWG_API_KEY: z.string().optional(),
  MUSIC_SEARCH: bool,

  WEB_DIR: z.string().optional(),
  /** Lets tests and local dev fetch private addresses from the link previewer. Never in production. */
  ALLOW_PRIVATE_FETCH: bool,
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';

  let secret = e.SECRET;
  if (!secret || secret.length < 32) {
    if (production) throw new Error('SECRET must be set to at least 32 random characters in production (try: openssl rand -hex 32)');
    secret = 'dev-only-secret-do-not-use-in-production-0123456789';
  }

  if (e.STORAGE_DRIVER === 's3' && (!e.S3_BUCKET || !e.S3_ACCESS_KEY || !e.S3_SECRET_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
  }

  const publicUrl = new URL(e.PUBLIC_URL);
  const voiceEnabled = !!(e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET);
  if (voiceEnabled && production && (e.LIVEKIT_API_SECRET?.length ?? 0) < 32) {
    throw new Error('LIVEKIT_API_SECRET must be at least 32 characters');
  }

  return {
    env: e.NODE_ENV,
    production,
    host: e.HOST,
    port: e.PORT,
    publicUrl: publicUrl.origin,
    secureCookies: publicUrl.protocol === 'https:',
    appName: e.APP_NAME,
    logLevel: e.LOG_LEVEL ?? (production ? 'warn' : 'info'),
    /** Hop count for Fastify; false = use the socket address. */
    trustProxy: ((e.TRUST_PROXY ?? (production ? 1 : 0)) || false) as number | false,
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    secret,
    registration: e.REGISTRATION,
    storage: {
      driver: e.STORAGE_DRIVER,
      path: e.STORAGE_PATH,
      s3: {
        endpoint: e.S3_ENDPOINT,
        region: e.S3_REGION,
        bucket: e.S3_BUCKET ?? '',
        accessKey: e.S3_ACCESS_KEY ?? '',
        secretKey: e.S3_SECRET_KEY ?? '',
        forcePathStyle: e.S3_FORCE_PATH_STYLE ?? true,
      },
    },
    limits: {
      uploadBytes: Math.floor(e.MAX_UPLOAD_MB * 1024 * 1024),
      avatarBytes: Math.floor(e.MAX_AVATAR_MB * 1024 * 1024),
      emojiBytes: Math.floor(e.MAX_EMOJI_KB * 1024),
      emojisPerGuild: e.EMOJIS_PER_GUILD,
      stickersPerGuild: e.STICKERS_PER_GUILD,
    },
    smtp: e.SMTP_URL ? { url: e.SMTP_URL, from: e.SMTP_FROM ?? `${e.APP_NAME} <no-reply@${publicUrl.hostname}>` } : null,
    livekit: voiceEnabled
      ? {
          url: e.LIVEKIT_URL!,
          internalUrl: e.LIVEKIT_INTERNAL_URL ?? e.LIVEKIT_URL!.replace(/^ws/, 'http'),
          apiKey: e.LIVEKIT_API_KEY!,
          apiSecret: e.LIVEKIT_API_SECRET!,
        }
      : null,
    igdb: e.IGDB_CLIENT_ID && e.IGDB_CLIENT_SECRET ? { clientId: e.IGDB_CLIENT_ID, clientSecret: e.IGDB_CLIENT_SECRET } : null,
    rawgKey: e.RAWG_API_KEY ?? null,
    musicSearch: e.MUSIC_SEARCH ?? true,
    webDir: e.WEB_DIR ?? null,
    allowPrivateFetch: !production && (e.ALLOW_PRIVATE_FETCH ?? false),
  };
}
