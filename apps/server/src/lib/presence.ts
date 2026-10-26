import type { Presence, VisibleStatus, PlayingActivity, ListeningActivity } from '@haunt/shared';
import type { Ctx } from '../context.js';
import type { UserRow } from '../rows.js';
import { customStatusOf } from './serialize.js';

/**
 * Presence lives in Valkey:
 *   pres:<uid>   ZSET socketId -> last heartbeat ms (all live sockets, any process)
 *   pidle:<uid>  SET  socketIds that report idle
 *   pstat:<uid>  last broadcast visible status (to only broadcast on change)
 * A socket is live if it heartbeated in the last 90s, so a crashed process ages out on its own.
 */
const STALE_MS = 90_000;

type PresenceUser = Pick<
  UserRow,
  'id' | 'status' | 'custom_status' | 'activity_playing' | 'activity_listening' | 'last_seen_at' | 'last_seen_privacy' | 'deleted'
>;

export async function liveSockets(ctx: Ctx, userId: string): Promise<string[]> {
  const now = Date.now();
  await ctx.redis.zremrangebyscore(`pres:${userId}`, 0, now - STALE_MS);
  return ctx.redis.zrange(`pres:${userId}`, 0, -1);
}

export async function visibleStatus(ctx: Ctx, u: Pick<UserRow, 'id' | 'status' | 'deleted'>): Promise<VisibleStatus> {
  if (u.deleted || u.status === 'invisible') return 'offline';
  const live = await liveSockets(ctx, u.id);
  if (!live.length) return 'offline';
  if (u.status === 'dnd') return 'dnd';
  if (u.status === 'idle') return 'idle';
  const idle = await ctx.redis.smembers(`pidle:${u.id}`);
  const idleSet = new Set(idle);
  return live.every((s) => idleSet.has(s)) ? 'idle' : 'online';
}

/** Batch version for READY. */
export async function visibleStatuses(ctx: Ctx, users: Pick<UserRow, 'id' | 'status' | 'deleted'>[]): Promise<Map<string, VisibleStatus>> {
  const out = new Map<string, VisibleStatus>();
  if (!users.length) return out;
  const now = Date.now();
  const pipe = ctx.redis.pipeline();
  for (const u of users) {
    pipe.zrangebyscore(`pres:${u.id}`, now - STALE_MS, '+inf');
    pipe.smembers(`pidle:${u.id}`);
  }
  const res = (await pipe.exec()) ?? [];
  users.forEach((u, i) => {
    const live = (res[i * 2]?.[1] as string[]) ?? [];
    const idle = new Set((res[i * 2 + 1]?.[1] as string[]) ?? []);
    let s: VisibleStatus;
    if (u.deleted || u.status === 'invisible' || !live.length) s = 'offline';
    else if (u.status === 'dnd') s = 'dnd';
    else if (u.status === 'idle') s = 'idle';
    else s = live.every((x) => idle.has(x)) ? 'idle' : 'online';
    out.set(u.id, s);
  });
  return out;
}

export function buildPresence(u: PresenceUser, status: VisibleStatus, opts: { canSeeLastSeen: boolean }): Presence {
  return {
    userId: u.id,
    status,
    customStatus: u.deleted ? null : customStatusOf(u),
    playing: u.deleted ? null : ((u.activity_playing as PlayingActivity | null) ?? null),
    listening: u.deleted ? null : ((u.activity_listening as ListeningActivity | null) ?? null),
    lastSeenAt: status === 'offline' && opts.canSeeLastSeen && u.last_seen_at ? u.last_seen_at.toISOString() : null,
  };
}

export function canSeeLastSeen(u: Pick<UserRow, 'id' | 'last_seen_privacy'>, viewerId: string, isFriend: boolean): boolean {
  if (u.id === viewerId) return true;
  if (u.last_seen_privacy === 'everyone') return true;
  if (u.last_seen_privacy === 'friends') return isFriend;
  return false;
}

/** Everyone who should hear about this user's presence: guild-mates (via guild topics) and friends. */
export async function broadcastPresence(ctx: Ctx, userId: string, force = false): Promise<void> {
  const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${userId}`;
  if (!u) return;
  const status = await visibleStatus(ctx, u);
  if (!force) {
    const prev = await ctx.redis.getset(`pstat:${userId}`, status);
    if (prev === status) return;
  } else {
    await ctx.redis.set(`pstat:${userId}`, status);
  }
  const friends = await ctx.sql<{ target_id: string }[]>`
    SELECT target_id FROM relationships WHERE user_id = ${userId} AND type = 1`;
  const friendIds = friends.map((f) => f.target_id);

  const full = buildPresence(u, status, { canSeeLastSeen: true });
  const noLastSeen = { ...full, lastSeenAt: null };

  // friends: may see last seen when privacy is everyone/friends
  const friendPayload = u.last_seen_privacy === 'nobody' ? noLastSeen : full;
  ctx.bus.toUsers([...friendIds, userId], 'PRESENCE_UPDATE', friendPayload);

  // guild-mates who aren't friends: only with privacy = everyone
  const guildPayload = u.last_seen_privacy === 'everyone' ? full : noLastSeen;
  const guilds = await ctx.sql<{ guild_id: string }[]>`SELECT guild_id FROM guild_members WHERE user_id = ${userId}`;
  for (const g of guilds) {
    ctx.bus.toGuild(g.guild_id, 'PRESENCE_UPDATE', guildPayload, { exclude: [...friendIds, userId] });
  }
  // DM partners who are neither friends nor guild-mates still see online/offline in the DM header
  const dmPartners = await ctx.sql<{ user_id: string }[]>`
    SELECT DISTINCT r2.user_id FROM dm_recipients r1
    JOIN dm_recipients r2 ON r2.channel_id = r1.channel_id AND r2.user_id <> r1.user_id
    WHERE r1.user_id = ${userId}
      AND r2.user_id <> ALL(${friendIds}::bigint[])
      AND NOT EXISTS (SELECT 1 FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id
                      WHERE a.user_id = ${userId} AND b.user_id = r2.user_id)
    LIMIT 500`;
  ctx.bus.toUsers(dmPartners.map((d) => d.user_id), 'PRESENCE_UPDATE', guildPayload);
}

export async function socketUp(ctx: Ctx, userId: string, socketId: string): Promise<void> {
  await ctx.redis.zadd(`pres:${userId}`, Date.now(), socketId);
  await ctx.redis.expire(`pres:${userId}`, 3600);
  await broadcastPresence(ctx, userId);
}

export async function socketHeartbeat(ctx: Ctx, userId: string, socketId: string): Promise<void> {
  await ctx.redis.zadd(`pres:${userId}`, Date.now(), socketId);
  await ctx.redis.expire(`pres:${userId}`, 3600);
}

export async function socketIdle(ctx: Ctx, userId: string, socketId: string, idle: boolean): Promise<void> {
  if (idle) await ctx.redis.sadd(`pidle:${userId}`, socketId);
  else await ctx.redis.srem(`pidle:${userId}`, socketId);
  await ctx.redis.expire(`pidle:${userId}`, 3600);
  await broadcastPresence(ctx, userId);
}

export async function socketDown(ctx: Ctx, userId: string, socketId: string): Promise<void> {
  await ctx.redis.zrem(`pres:${userId}`, socketId);
  await ctx.redis.srem(`pidle:${userId}`, socketId);
  const live = await liveSockets(ctx, userId);
  if (!live.length) {
    // last device gone: record last seen (unless invisible — then it stays frozen at when they went invisible)
    await ctx.sql`UPDATE users SET last_seen_at = now() WHERE id = ${userId} AND status <> 'invisible'`;
  }
  await broadcastPresence(ctx, userId);
}
