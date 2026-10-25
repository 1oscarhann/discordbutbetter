import type { AuditActionValue } from '@dbb/shared';
import type { Db } from '../db.js';
import { snowflake } from '../ids.js';

export async function audit(
  db: Db,
  e: {
    guildId: string;
    actorId: string | null;
    action: AuditActionValue;
    targetType?: string;
    targetId?: string | null;
    changes?: Record<string, unknown> | null;
    reason?: string | null;
  },
): Promise<void> {
  await db`
    INSERT INTO audit_log (id, guild_id, actor_id, action, target_type, target_id, changes, reason)
    VALUES (${snowflake()}, ${e.guildId}, ${e.actorId}, ${e.action}, ${e.targetType ?? null}, ${e.targetId ?? null},
            ${e.changes ? db.json(e.changes as never) : null}, ${e.reason ?? null})`;
}

/** Shallow diff of two objects for the audit log: { field: [before, after] } */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(after)) {
    if (after[k] === undefined) continue;
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a ?? null, b ?? null];
  }
  return out;
}
