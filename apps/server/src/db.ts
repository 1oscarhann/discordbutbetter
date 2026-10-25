import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type Sql = postgres.Sql<{ bigint: string }>;
export type Tx = postgres.TransactionSql<{ bigint: string }>;
/** Anything you can run a query on: the pool or a transaction. */
export type Db = Sql | Tx;
/** A composable SQL fragment, e.g. sql`m.channel_id = ${id}`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Fragment = postgres.PendingQuery<any>;

export function createDb(url: string, max = 10): Sql {
  return postgres(url, {
    max,
    idle_timeout: 30,
    connect_timeout: 10,
    // bigint (int8) stays a string: snowflakes and permission bits don't fit in a JS number
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: string | bigint | number) => v.toString(),
        parse: (v: string) => v,
      },
    },
    transform: { undefined: null },
    onnotice: () => {},
  }) as unknown as Sql;
}

function migrationsDir(): string {
  // works from src/ (tsx) and from dist/ (bundled)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return process.env.MIGRATIONS_DIR ?? path.resolve(here, '../migrations');
}

/** Applies migrations/NNN_name.sql in order, each in its own transaction, once. */
export async function migrate(sql: Sql, log: (msg: string) => void = () => {}): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  // serialise concurrent app processes booting at the same time
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(872346)`;
    const applied = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    const files = (await readdir(migrationsDir())).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const body = await readFile(path.join(migrationsDir(), f), 'utf8');
      log(`applying migration ${f}`);
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
    }
  });
}
