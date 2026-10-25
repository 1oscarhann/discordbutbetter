import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { createRedis } from './redis.js';
import { createStorage } from './lib/storage.js';
import { createMailer } from './lib/email.js';
import { Bus } from './lib/bus.js';
import { buildApp } from './app.js';
import { startJobs } from './jobs/index.js';
import { createVoice } from './services/voice.js';
import { setAllowPrivateFetch } from './lib/safefetch.js';

async function main() {
  const config = loadConfig();
  const sql = createDb(config.databaseUrl);
  await migrate(sql, (m) => console.log(`[db] ${m}`));
  const redis = createRedis(config.redisUrl);
  const sub = createRedis(config.redisUrl);
  setAllowPrivateFetch(config.allowPrivateFetch);

  const ctxBase = {
    config,
    sql,
    redis,
    sub,
    storage: createStorage(config),
    mailer: createMailer(config, (m) => console.log(m)),
    bus: new Bus(redis),
    voice: createVoice(config),
  };
  const { app, shutdownGateway } = await buildApp(ctxBase);
  const stopJobs = startJobs(app.ctx);

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`${config.appName} listening on ${config.host}:${config.port} (public url ${config.publicUrl})`);
  if (!config.livekit) app.log.warn('LiveKit not configured: voice, video and screen share are off');
  if (!config.smtp) app.log.info('SMTP not configured: no emails; use the CLI for password reset links');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info(`${signal}: shutting down`);
    stopJobs();
    shutdownGateway();
    await app.close().catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
    redis.disconnect();
    sub.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
