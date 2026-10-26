import type { FastifyInstance } from 'fastify';
import {
  ChannelType,
  CreateDmSchema,
  FriendRequestSchema,
  Limits,
  MessageType,
  RelationshipPutSchema,
  RelationshipType,
  type Relationship,
} from '@haunt/shared';
import type { ChannelRow, UserRow } from '../rows.js';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { publicUser, loadChannel, loadChannelById } from '../lib/serialize.js';
import { loadRelationships } from '../gateway/ready.js';
import { isBlockedEitherWay } from '../lib/audience.js';
import { snowflake } from '../ids.js';
import { broadcastPresence } from '../lib/presence.js';
import { insertSystemMessage } from '../services/messages.js';
import type { Ctx } from '../context.js';

async function rel(ctx: Ctx, a: string, b: string): Promise<number | null> {
  const [r] = await ctx.sql<{ type: number }[]>`SELECT type FROM relationships WHERE user_id = ${a} AND target_id = ${b}`;
  return r?.type ?? null;
}

async function setRel(ctx: Ctx, a: string, b: string, type: number) {
  await ctx.sql`
    INSERT INTO relationships (user_id, target_id, type) VALUES (${a}, ${b}, ${type})
    ON CONFLICT (user_id, target_id) DO UPDATE SET type = ${type}, created_at = now()`;
}

async function relObj(ctx: Ctx, viewer: string, target: string): Promise<Relationship | null> {
  const rows = await ctx.sql<(UserRow & { rel_type: number; rel_created: Date })[]>`
    SELECT u.*, r.type AS rel_type, r.created_at AS rel_created FROM relationships r JOIN users u ON u.id = r.target_id
    WHERE r.user_id = ${viewer} AND r.target_id = ${target}`;
  const r = rows[0];
  return r ? { user: publicUser(r), type: r.rel_type as Relationship['type'], since: r.rel_created.toISOString() } : null;
}

async function pushRel(ctx: Ctx, viewer: string, target: string) {
  const r = await relObj(ctx, viewer, target);
  if (r) ctx.bus.toUser(viewer, 'RELATIONSHIP_ADD', r);
  else ctx.bus.toUser(viewer, 'RELATIONSHIP_REMOVE', { userId: target });
}

export async function sharesGuild(ctx: Ctx, a: string, b: string): Promise<boolean> {
  const r = await ctx.sql`
    SELECT 1 FROM guild_members x JOIN guild_members y ON x.guild_id = y.guild_id WHERE x.user_id = ${a} AND y.user_id = ${b} LIMIT 1`;
  return r.length > 0;
}

export default async function relationshipRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/users/@me/relationships', async (req) => loadRelationships(ctx, requireAuth(req).userId));

  app.post('/users/@me/relationships', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'friendRequest');
    const { username } = parse(FriendRequestSchema, req.body);
    const [t] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE username = ${username} AND NOT deleted AND NOT disabled`;
    // same message for "doesn't exist", "blocked", "doesn't accept requests" — no probing
    const generic = badRequest("Couldn't send a friend request to that username");
    if (!t) throw generic;
    if (t.id === auth.userId) throw badRequest("You can't friend yourself (we've all been there)");
    if (await isBlockedEitherWay(ctx, auth.userId, t.id)) throw generic;
    const mine = await rel(ctx, auth.userId, t.id);
    if (mine === RelationshipType.FRIEND) throw conflict("You're already friends");
    if (mine === RelationshipType.OUTGOING) throw conflict('Request already sent');
    const [{ count }] = (await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM relationships WHERE user_id = ${auth.userId} AND type = 1`) as unknown as [{ count: number }];
    if (count >= Limits.FRIENDS_MAX) throw forbidden('Friend list is full');

    if (mine === RelationshipType.INCOMING) {
      // they already asked: accept
      await setRel(ctx, auth.userId, t.id, RelationshipType.FRIEND);
      await setRel(ctx, t.id, auth.userId, RelationshipType.FRIEND);
    } else {
      if (t.friend_policy === 'nobody') throw generic;
      if (t.friend_policy === 'mutual' && !(await sharesGuild(ctx, auth.userId, t.id))) throw generic;
      await setRel(ctx, auth.userId, t.id, RelationshipType.OUTGOING);
      await setRel(ctx, t.id, auth.userId, RelationshipType.INCOMING);
    }
    await pushRel(ctx, auth.userId, t.id);
    await pushRel(ctx, t.id, auth.userId);
    if (mine === RelationshipType.INCOMING) {
      await broadcastPresence(ctx, auth.userId, true);
      await broadcastPresence(ctx, t.id, true);
    }
    return relObj(ctx, auth.userId, t.id);
  });

  app.put('/users/@me/relationships/:userId', async (req) => {
    const auth = requireAuth(req);
    const target = idParam(req, 'userId');
    await limitPreset(req, 'friendRequest');
    const { type } = parse(RelationshipPutSchema, req.body);
    if (target === auth.userId) throw badRequest('Nope');
    const [t] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${target}`;
    if (!t) throw notFound('User not found');
    const mine = await rel(ctx, auth.userId, target);

    if (type === RelationshipType.FRIEND) {
      if (mine !== RelationshipType.INCOMING) throw badRequest('No friend request from them to accept');
      await setRel(ctx, auth.userId, target, RelationshipType.FRIEND);
      await setRel(ctx, target, auth.userId, RelationshipType.FRIEND);
      await pushRel(ctx, auth.userId, target);
      await pushRel(ctx, target, auth.userId);
      await broadcastPresence(ctx, auth.userId, true);
      await broadcastPresence(ctx, target, true);
    } else {
      // block: drop any friendship/requests on both sides, but keep their block of us if they have one
      await setRel(ctx, auth.userId, target, RelationshipType.BLOCKED);
      const theirs = await rel(ctx, target, auth.userId);
      if (theirs !== null && theirs !== RelationshipType.BLOCKED) {
        await ctx.sql`DELETE FROM relationships WHERE user_id = ${target} AND target_id = ${auth.userId}`;
        ctx.bus.toUser(target, 'RELATIONSHIP_REMOVE', { userId: auth.userId });
      }
      await pushRel(ctx, auth.userId, target);
    }
    return relObj(ctx, auth.userId, target);
  });

  app.delete('/users/@me/relationships/:userId', async (req) => {
    const auth = requireAuth(req);
    const target = idParam(req, 'userId');
    const mine = await rel(ctx, auth.userId, target);
    if (mine === null) throw notFound('Nothing to remove');
    await ctx.sql`DELETE FROM relationships WHERE user_id = ${auth.userId} AND target_id = ${target}`;
    ctx.bus.toUser(auth.userId, 'RELATIONSHIP_REMOVE', { userId: target });
    if (mine !== RelationshipType.BLOCKED) {
      // unfriend / cancel / decline also clears their side (unless they've blocked us)
      const del = await ctx.sql`
        DELETE FROM relationships WHERE user_id = ${target} AND target_id = ${auth.userId} AND type <> 2 RETURNING type`;
      if (del.length) ctx.bus.toUser(target, 'RELATIONSHIP_REMOVE', { userId: auth.userId });
    }
    return { ok: true };
  });

  // ---------- DMs ----------

  app.post('/users/@me/channels', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'dmCreate');
    const { recipientIds } = parse(CreateDmSchema, req.body);
    const others = recipientIds.filter((id) => id !== auth.userId);
    if (!others.length) throw badRequest('Pick someone to message');

    if (others.length === 1) {
      const other = others[0]!;
      const [t] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${other} AND NOT deleted`;
      if (!t) throw notFound('User not found');
      const friend = (await rel(ctx, auth.userId, other)) === RelationshipType.FRIEND;
      if (await isBlockedEitherWay(ctx, auth.userId, other)) throw forbidden("You can't message this person");
      if (!friend) {
        if (t.dm_policy === 'friends') throw forbidden('They only accept DMs from friends');
        if (!(await sharesGuild(ctx, auth.userId, other))) throw forbidden('You need to share a server or be friends to DM them');
      }
      const key = [auth.userId, other].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).join(':');
      const id = snowflake();
      const [c] = await ctx.sql<ChannelRow[]>`
        INSERT INTO channels (id, type, dm_key) VALUES (${id}, ${ChannelType.DM}, ${key})
        ON CONFLICT (dm_key) DO UPDATE SET dm_key = EXCLUDED.dm_key
        RETURNING *`;
      await ctx.sql`
        INSERT INTO dm_recipients (channel_id, user_id, open) VALUES (${c!.id}, ${auth.userId}, true), (${c!.id}, ${other}, false)
        ON CONFLICT (channel_id, user_id) DO NOTHING`;
      await ctx.sql`UPDATE dm_recipients SET open = true WHERE channel_id = ${c!.id} AND user_id = ${auth.userId}`;
      const ch = await loadChannel(ctx.sql, c!);
      ctx.bus.toUser(auth.userId, 'CHANNEL_CREATE', ch);
      return ch;
    }

    // group DM: only with friends
    if (others.length + 1 > Limits.GROUP_DM_MAX) throw badRequest(`Group DMs can have up to ${Limits.GROUP_DM_MAX} people`);
    const friends = await ctx.sql<{ target_id: string }[]>`
      SELECT target_id FROM relationships WHERE user_id = ${auth.userId} AND type = 1 AND target_id = ANY(${others}::bigint[])`;
    if (friends.length !== others.length) throw forbidden('You can only add friends to a group DM');
    const id = snowflake();
    await ctx.sql.begin(async (tx) => {
      await tx`INSERT INTO channels (id, type, owner_id) VALUES (${id}, ${ChannelType.GROUP_DM}, ${auth.userId})`;
      for (const u of [auth.userId, ...others]) {
        await tx`INSERT INTO dm_recipients (channel_id, user_id) VALUES (${id}, ${u})`;
      }
    });
    const ch = (await loadChannelById(ctx.sql, id))!;
    ctx.bus.toUsers([auth.userId, ...others], 'CHANNEL_CREATE', ch);
    return ch;
  });

  app.put('/channels/:id/recipients/:userId', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    await limitPreset(req, 'dmCreate');
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId} AND type = ${ChannelType.GROUP_DM}`;
    if (!c) throw notFound('Group DM not found');
    const members = (await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM dm_recipients WHERE channel_id = ${channelId}`).map((r) => r.user_id);
    if (!members.includes(auth.userId)) throw notFound('Group DM not found');
    if (members.includes(userId)) throw conflict('Already in the group');
    if (members.length >= Limits.GROUP_DM_MAX) throw forbidden('Group is full');
    if ((await rel(ctx, auth.userId, userId)) !== RelationshipType.FRIEND) throw forbidden('You can only add friends');
    await ctx.sql`INSERT INTO dm_recipients (channel_id, user_id) VALUES (${channelId}, ${userId})`;
    const ch = (await loadChannelById(ctx.sql, channelId))!;
    ctx.bus.toUsers(members, 'CHANNEL_UPDATE', ch);
    ctx.bus.toUser(userId, 'CHANNEL_CREATE', ch);
    await insertSystemMessage(ctx, c, MessageType.RECIPIENT_ADD, auth.userId, { userId });
    return ch;
  });

  app.delete('/channels/:id/recipients/:userId', async (req) => {
    const auth = requireAuth(req);
    const channelId = idParam(req, 'id');
    const userId = idParam(req, 'userId');
    const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${channelId} AND type = ${ChannelType.GROUP_DM}`;
    if (!c) throw notFound('Group DM not found');
    const members = (await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM dm_recipients WHERE channel_id = ${channelId}`).map((r) => r.user_id);
    if (!members.includes(auth.userId)) throw notFound('Group DM not found');
    if (userId !== auth.userId && c.owner_id !== auth.userId) throw forbidden('Only the group owner can remove people');
    if (!members.includes(userId)) throw notFound('Not in the group');
    await removeFromGroup(ctx, c, userId, auth.userId);
    return { ok: true };
  });
}

export async function removeFromGroup(ctx: Ctx, c: ChannelRow, userId: string, actorId: string): Promise<void> {
  await ctx.sql`DELETE FROM dm_recipients WHERE channel_id = ${c.id} AND user_id = ${userId}`;
  ctx.bus.toUser(userId, 'CHANNEL_DELETE', { id: c.id, guildId: null });
  const left = (await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM dm_recipients WHERE channel_id = ${c.id} ORDER BY joined_at`).map(
    (r) => r.user_id,
  );
  if (!left.length) {
    await ctx.sql`DELETE FROM channels WHERE id = ${c.id}`;
    return;
  }
  if (c.owner_id === userId) await ctx.sql`UPDATE channels SET owner_id = ${left[0]!} WHERE id = ${c.id}`;
  const ch = (await loadChannelById(ctx.sql, c.id))!;
  ctx.bus.toUsers(left, 'CHANNEL_UPDATE', ch);
  await insertSystemMessage(ctx, c, MessageType.RECIPIENT_REMOVE, actorId, { userId });
}
