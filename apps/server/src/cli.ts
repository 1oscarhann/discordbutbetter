/**
 * Admin CLI. In Docker:  docker compose exec app node dist/cli.js <command>
 * Locally:               pnpm --filter @haunt/server cli <command>
 */
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { createRedis } from './redis.js';
import { inviteCode } from './ids.js';
import { hashToken } from './auth/sessions.js';
import { randomToken } from './ids.js';

const HELP = `Usage: cli <command> [args]

  migrate                         apply database migrations
  reset-link <email|username>     print a one-time password reset link (valid 24h)
  make-admin <username>           mark a user as instance admin
  remove-admin <username>
  disable-user <username>         block login and kick all sessions
  enable-user <username>
  create-invite [uses] [days]     sign-up code for REGISTRATION=invite (default 1 use, 7 days)
  list-invites
  stats                           counts of users, servers, messages, files
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }
  const config = loadConfig();
  const sql = createDb(config.databaseUrl, 2);
  const redis = createRedis(config.redisUrl);
  try {
    const findUser = async (q: string) => {
      const [u] = q.includes('@')
        ? await sql<{ id: string; username: string }[]>`SELECT id, username::text FROM users WHERE email = ${q.toLowerCase()}`
        : await sql<{ id: string; username: string }[]>`SELECT id, username::text FROM users WHERE username = ${q.toLowerCase()}`;
      if (!u) throw new Error(`No user ${q}`);
      return u;
    };
    const kickSessions = async (userId: string) => {
      const rows = await sql<{ token_hash: Buffer }[]>`DELETE FROM sessions WHERE user_id = ${userId} RETURNING token_hash`;
      if (rows.length) await redis.del(...rows.map((r) => `sess:${r.token_hash.toString('hex')}`));
      await redis.publish(`u:${userId}`, JSON.stringify({ t: 'SESSION_REVOKED', d: {} }));
    };

    switch (cmd) {
      case 'migrate':
        await migrate(sql, console.log);
        console.log('done');
        break;
      case 'reset-link': {
        const u = await findUser(args[0] ?? '');
        const token = randomToken(32);
        await sql`
          INSERT INTO email_tokens (token_hash, user_id, kind, expires_at)
          VALUES (${hashToken(token)}, ${u.id}, 'reset', now() + interval '24 hours')`;
        console.log(`Reset link for @${u.username} (valid 24h, single use):\n${config.publicUrl}/reset?token=${encodeURIComponent(token)}`);
        break;
      }
      case 'make-admin':
      case 'remove-admin': {
        const u = await findUser(args[0] ?? '');
        await sql`UPDATE users SET is_admin = ${cmd === 'make-admin'} WHERE id = ${u.id}`;
        console.log(`@${u.username} is ${cmd === 'make-admin' ? 'now' : 'no longer'} an admin`);
        break;
      }
      case 'disable-user':
      case 'enable-user': {
        const u = await findUser(args[0] ?? '');
        await sql`UPDATE users SET disabled = ${cmd === 'disable-user'} WHERE id = ${u.id}`;
        if (cmd === 'disable-user') await kickSessions(u.id);
        console.log(`@${u.username} ${cmd === 'disable-user' ? 'disabled and logged out' : 'enabled'}`);
        break;
      }
      case 'create-invite': {
        const uses = Number(args[0] ?? 1);
        const days = Number(args[1] ?? 7);
        const code = inviteCode(12);
        await sql`
          INSERT INTO instance_invites (code, max_uses, expires_at)
          VALUES (${code}, ${uses}, ${days > 0 ? new Date(Date.now() + days * 86400_000) : null})`;
        console.log(`Sign-up code: ${code}  (${uses || 'unlimited'} uses, ${days > 0 ? `expires in ${days} days` : 'never expires'})`);
        console.log(`Share: ${config.publicUrl}/register?code=${code}`);
        break;
      }
      case 'list-invites': {
        const rows = await sql`SELECT code, uses, max_uses, expires_at FROM instance_invites ORDER BY created_at DESC LIMIT 50`;
        console.table(rows);
        break;
      }
      case 'stats': {
        const [s] = await sql`
          SELECT (SELECT count(*) FROM users WHERE NOT deleted)::int AS users,
                 (SELECT count(*) FROM guilds)::int AS servers,
                 (SELECT count(*) FROM messages)::int AS messages,
                 (SELECT count(*) FROM files)::int AS files,
                 (SELECT pg_size_pretty(coalesce(sum(size), 0)) FROM files) AS file_bytes`;
        console.table([s]);
        break;
      }
      default:
        console.log(`Unknown command "${cmd}"\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    await sql.end({ timeout: 2 });
    redis.disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
