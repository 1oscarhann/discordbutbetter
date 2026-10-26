import { randomInt } from 'node:crypto';
import { MessageType, XP_COOLDOWN_SECONDS, XP_PER_MESSAGE_MAX, XP_PER_MESSAGE_MIN, levelFromXp } from '@haunt/shared';
import type { Ctx } from '../context.js';
import type { ChannelRow, GuildRow } from '../rows.js';
import { loadMember } from '../lib/serialize.js';

/** Gives XP for a message (once per minute per member), handles level-ups, role rewards and the announcement. */
export async function awardXp(ctx: Ctx, guild: GuildRow, userId: string, channel: ChannelRow): Promise<void> {
  if (!guild.levels_enabled) return;
  const fresh = await ctx.redis.set(`xpcd:${guild.id}:${userId}`, '1', 'EX', XP_COOLDOWN_SECONDS, 'NX');
  if (fresh !== 'OK') {
    await ctx.sql`
      INSERT INTO member_xp (guild_id, user_id, messages) VALUES (${guild.id}, ${userId}, 1)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET messages = member_xp.messages + 1`;
    return;
  }
  const gain = randomInt(XP_PER_MESSAGE_MIN, XP_PER_MESSAGE_MAX + 1);
  const [row] = await ctx.sql<{ xp: string; level: number }[]>`
    INSERT INTO member_xp (guild_id, user_id, xp, messages, updated_at) VALUES (${guild.id}, ${userId}, ${gain}, 1, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET xp = member_xp.xp + ${gain}, messages = member_xp.messages + 1, updated_at = now()
    RETURNING xp, level`;
  if (!row) return;
  const { level } = levelFromXp(Number(row.xp));
  if (level <= row.level) return;
  await ctx.sql`UPDATE member_xp SET level = ${level} WHERE guild_id = ${guild.id} AND user_id = ${userId}`;

  // role rewards for every level reached
  const rewards = await ctx.sql<{ role_id: string }[]>`
    SELECT role_id FROM level_roles WHERE guild_id = ${guild.id} AND level <= ${level}`;
  if (rewards.length) {
    const added = await ctx.sql`
      INSERT INTO member_roles (guild_id, user_id, role_id)
      SELECT ${guild.id}, ${userId}, r.id FROM roles r WHERE r.id = ANY(${rewards.map((r) => r.role_id)}::bigint[]) AND r.guild_id = ${guild.id}
      ON CONFLICT DO NOTHING RETURNING role_id`;
    if (added.length) {
      const m = await loadMember(ctx.sql, guild.id, userId);
      if (m) ctx.bus.toGuild(guild.id, 'GUILD_MEMBER_UPDATE', m, { invalidate: true });
      ctx.bus.internalGuild(guild.id, '_PERMS_CHANGED', { guildId: guild.id, userId });
    }
  }

  if (guild.levels_announce) {
    let target: Pick<ChannelRow, 'id' | 'type' | 'guild_id' | 'parent_id'> = channel;
    if (guild.levels_channel_id) {
      const [c] = await ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE id = ${guild.levels_channel_id} AND guild_id = ${guild.id}`;
      if (c) target = c;
    }
    const { insertSystemMessage } = await import('./messages.js');
    await insertSystemMessage(ctx, target, MessageType.LEVEL_UP, userId, { level, userId });
  }
}
