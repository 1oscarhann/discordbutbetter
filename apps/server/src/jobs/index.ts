import { ChannelType, SNOWFLAKE_EPOCH, isDmType, type VoiceState } from '@haunt/shared';
import type { Ctx } from '../context.js';
import { tryLock } from '../redis.js';
import { HttpError } from '../errors.js';
import { channelAccess } from '../lib/perms.js';
import { hardDeleteMessages, sendMessage } from '../services/messages.js';
import { scheduledObj } from '../routes/personal.js';
import { loadChannel, selfUser } from '../lib/serialize.js';
import { toChannel } from '../lib/fanout.js';
import { broadcastPresence } from '../lib/presence.js';
import { clearVoiceState, roomName } from '../services/voice.js';
import { afterVoiceLeave } from '../routes/activities.js';
import type { ChannelRow, UserRow } from '../rows.js';

type Job = { name: string; everyMs: number; run: (ctx: Ctx) => Promise<void> };

async function sendScheduled(ctx: Ctx) {
  const due = await ctx.sql<
    { id: string; user_id: string; channel_id: string; content: string; flags: number; reply_to_id: string | null; reply_ping: boolean; attachments: { fileId: string; spoiler: boolean; description?: string }[]; send_at: Date; error: string | null; created_at: Date }[]
  >`SELECT * FROM scheduled_messages WHERE send_at <= now() AND error IS NULL ORDER BY send_at LIMIT 25`;
  for (const s of due) {
    try {
      // permissions are re-checked at send time: if you lost access, it doesn't go out
      const a = await channelAccess(ctx, s.channel_id, s.user_id);
      const msg = await sendMessage(ctx, {
        access: a,
        authorId: s.user_id,
        content: s.content,
        attachments: s.attachments,
        replyTo: s.reply_to_id ? { messageId: s.reply_to_id, ping: s.reply_ping } : undefined,
        silent: (s.flags & 1) === 1,
        suppressEmbeds: false,
        scheduled: true,
      });
      await ctx.sql`DELETE FROM scheduled_messages WHERE id = ${s.id}`;
      ctx.bus.toUser(s.user_id, 'SCHEDULED_MESSAGE_DELETE', { id: s.id, sentMessageId: msg.id });
    } catch (e) {
      const reason = e instanceof HttpError ? e.message : 'Failed to send';
      if (!(e instanceof HttpError)) ctx.log.warn({ err: e }, 'scheduled send failed');
      if (e instanceof HttpError && e.status === 429) continue; // slowmode etc: retry next tick
      const [r] = await ctx.sql<typeof due>`UPDATE scheduled_messages SET error = ${reason} WHERE id = ${s.id} RETURNING *`;
      if (r) ctx.bus.toUser(s.user_id, 'SCHEDULED_MESSAGE_UPDATE', await scheduledObj(ctx, r));
    }
  }
}

async function reapDisappearing(ctx: Ctx) {
  const rows = await ctx.sql<{ id: string; channel_id: string }[]>`
    SELECT id, channel_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= now() ORDER BY expires_at LIMIT 1000`;
  if (!rows.length) return;
  await hardDeleteMessages(ctx, rows.map((r) => r.id));
  const byChannel = new Map<string, string[]>();
  for (const r of rows) byChannel.set(r.channel_id, [...(byChannel.get(r.channel_id) ?? []), r.id]);
  for (const [channelId, ids] of byChannel) {
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId}`;
    if (c && isDmType(c.type)) await toChannel(ctx, c, 'MESSAGE_DELETE_BULK', { ids, channelId, guildId: null });
  }
}

async function archiveThreads(ctx: Ctx) {
  const rows = await ctx.sql<ChannelRow[]>`
    UPDATE channels SET archived = true, archived_at = now()
    WHERE type = ${ChannelType.THREAD} AND NOT archived
      AND to_timestamp((((COALESCE(last_message_id, id) >> 22) + ${SNOWFLAKE_EPOCH}) / 1000.0)) + make_interval(mins => auto_archive_minutes) < now()
    RETURNING *`;
  for (const t of rows) await toChannel(ctx, t, 'THREAD_UPDATE', await loadChannel(ctx.sql, t));
}

async function expireStatuses(ctx: Ctx) {
  const rows = await ctx.sql<UserRow[]>`
    UPDATE users SET custom_status = NULL
    WHERE custom_status IS NOT NULL AND custom_status->>'expiresAt' IS NOT NULL
      AND (custom_status->>'expiresAt')::timestamptz < now()
    RETURNING *`;
  for (const u of rows) {
    ctx.bus.toUser(u.id, 'SELF_UPDATE', selfUser(u));
    await broadcastPresence(ctx, u.id, true);
  }
}

async function gcFiles(ctx: Ctx) {
  const rows = await ctx.sql<{ storage_key: string }[]>`
    DELETE FROM files WHERE id IN (
      SELECT id FROM files WHERE NOT claimed AND created_at < now() - interval '24 hours' LIMIT 500
    ) RETURNING storage_key`;
  for (const r of rows) await ctx.storage.delete(r.storage_key).catch(() => {});
  if (rows.length) ctx.log.info(`file gc: removed ${rows.length} unused uploads`);
}

async function reconcileVoice(ctx: Ctx) {
  if (!ctx.voice) return;
  let cursor = '0';
  do {
    const [next, keys] = await ctx.redis.scan(cursor, 'MATCH', 'vs:*', 'COUNT', 200);
    cursor = next;
    for (const key of keys) {
      const guildId = key.slice(3);
      const all = await ctx.redis.hgetall(key);
      const byChannel = new Map<string, (VoiceState & { t?: number })[]>();
      for (const raw of Object.values(all)) {
        const vs = JSON.parse(raw) as VoiceState & { t?: number };
        byChannel.set(vs.channelId, [...(byChannel.get(vs.channelId) ?? []), vs]);
      }
      for (const [channelId, states] of byChannel) {
        let present: Set<string>;
        try {
          present = new Set((await ctx.voice.rooms.listParticipants(roomName(channelId))).map((p) => p.identity));
        } catch {
          present = new Set(); // room doesn't exist
        }
        for (const vs of states) {
          // give people a minute to finish connecting before declaring them gone
          if (!present.has(vs.userId) && Date.now() - (vs.t ?? 0) > 60_000) {
            await clearVoiceState(ctx, guildId, vs.userId, channelId);
            await afterVoiceLeave(ctx, guildId, channelId);
          }
        }
      }
    }
  } while (cursor !== '0');
}

async function cleanup(ctx: Ctx) {
  await ctx.sql`DELETE FROM sessions WHERE expires_at < now()`;
  await ctx.sql`DELETE FROM email_tokens WHERE expires_at < now()`;
  await ctx.sql`DELETE FROM invites WHERE expires_at < now() - interval '1 day'`;
  await ctx.sql`DELETE FROM instance_invites WHERE expires_at < now() - interval '7 days'`;
  await ctx.sql`DELETE FROM audit_log WHERE created_at < now() - interval '180 days'`;
}

export const JOBS: Job[] = [
  { name: 'scheduled', everyMs: 5_000, run: sendScheduled },
  { name: 'disappearing', everyMs: 15_000, run: reapDisappearing },
  { name: 'threads', everyMs: 300_000, run: archiveThreads },
  { name: 'statuses', everyMs: 60_000, run: expireStatuses },
  { name: 'files', everyMs: 3_600_000, run: gcFiles },
  { name: 'voice', everyMs: 60_000, run: reconcileVoice },
  { name: 'cleanup', everyMs: 3_600_000, run: cleanup },
];

/** Runs each job on its interval; a Valkey lock makes sure only one app process runs a job at a time. */
export function startJobs(ctx: Ctx): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const job of JOBS) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if (await tryLock(ctx.redis, `job:${job.name}`, Math.max(1000, job.everyMs - 500))) await job.run(ctx);
      } catch (e) {
        ctx.log.error({ err: e }, `job ${job.name} failed`);
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, job.everyMs));
    setTimeout(tick, 2000 + Math.random() * 3000);
  }
  return () => timers.forEach(clearInterval);
}
