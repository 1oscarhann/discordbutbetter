import { ChannelType, isDmType, type GatewayEventName, type GatewayEvents } from '@dbb/shared';
import type { Ctx } from '../context.js';
import type { ChannelRow } from '../rows.js';

/**
 * Publish an event to everyone who can see a channel.
 * DMs: each recipient. Guild channels: the guild topic, filtered by VIEW_CHANNEL on the channel
 * (threads are filtered by their parent channel).
 */
export async function toChannel<K extends GatewayEventName>(
  ctx: Ctx,
  ch: Pick<ChannelRow, 'id' | 'type' | 'guild_id' | 'parent_id'>,
  t: K,
  d: GatewayEvents[K],
  opts: { exclude?: string[]; perm?: bigint; recipients?: string[] | null } = {},
): Promise<void> {
  if (isDmType(ch.type)) {
    const ids =
      opts.recipients ??
      (await ctx.sql<{ user_id: string }[]>`SELECT user_id FROM dm_recipients WHERE channel_id = ${ch.id}`).map((r) => r.user_id);
    const ex = new Set(opts.exclude ?? []);
    ctx.bus.toUsers(
      ids.filter((i) => !ex.has(i)),
      t,
      d,
    );
    return;
  }
  if (!ch.guild_id) return;
  const viewChannel = ch.type === ChannelType.THREAD ? (ch.parent_id ?? ch.id) : ch.id;
  ctx.bus.toGuild(ch.guild_id, t, d, { channelId: viewChannel, exclude: opts.exclude, perm: opts.perm });
}
