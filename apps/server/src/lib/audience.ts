import type { Ctx } from '../context.js';
import type { UserRow } from '../rows.js';
import { publicUser } from './serialize.js';

/** Users connected to `userId` by friendship or a DM. */
export async function directContacts(ctx: Ctx, userId: string): Promise<string[]> {
  const rows = await ctx.sql<{ id: string }[]>`
    SELECT target_id AS id FROM relationships WHERE user_id = ${userId} AND type IN (1, 3, 4)
    UNION
    SELECT r2.user_id AS id FROM dm_recipients r1 JOIN dm_recipients r2 ON r2.channel_id = r1.channel_id
    WHERE r1.user_id = ${userId} AND r2.user_id <> ${userId}`;
  return rows.map((r) => r.id);
}

/** Tells everyone who can see this user that their name/avatar changed. */
export async function broadcastUserUpdate(ctx: Ctx, u: UserRow): Promise<void> {
  const pu = publicUser(u);
  const guilds = await ctx.sql<{ guild_id: string }[]>`SELECT guild_id FROM guild_members WHERE user_id = ${u.id}`;
  for (const g of guilds) ctx.bus.toGuild(g.guild_id, 'USER_UPDATE', pu);
  ctx.bus.toUsers(await directContacts(ctx, u.id), 'USER_UPDATE', pu);
}

/** Do these two users share anything (guild, friendship/request, DM)? Used to gate profile views. */
export async function isConnected(ctx: Ctx, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const rows = await ctx.sql`
    SELECT 1 WHERE
      EXISTS (SELECT 1 FROM guild_members x JOIN guild_members y ON x.guild_id = y.guild_id WHERE x.user_id = ${a} AND y.user_id = ${b})
      OR EXISTS (SELECT 1 FROM relationships WHERE user_id = ${a} AND target_id = ${b} AND type <> 2)
      OR EXISTS (SELECT 1 FROM dm_recipients x JOIN dm_recipients y ON x.channel_id = y.channel_id WHERE x.user_id = ${a} AND y.user_id = ${b})`;
  return rows.length > 0;
}

export async function isFriend(ctx: Ctx, a: string, b: string): Promise<boolean> {
  const rows = await ctx.sql`SELECT 1 FROM relationships WHERE user_id = ${a} AND target_id = ${b} AND type = 1`;
  return rows.length > 0;
}

export async function isBlockedEitherWay(ctx: Ctx, a: string, b: string): Promise<boolean> {
  const rows = await ctx.sql`
    SELECT 1 FROM relationships WHERE type = 2 AND ((user_id = ${a} AND target_id = ${b}) OR (user_id = ${b} AND target_id = ${a}))`;
  return rows.length > 0;
}
