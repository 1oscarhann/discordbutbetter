import { ChannelType, type FullGuild, type VoiceState } from '@haunt/shared';
import type { Ctx } from '../context.js';
import type { ChannelRow, GuildRow, OverwriteRow, RoleRow } from '../rows.js';
import { guild as serGuild, role as serRole, channel as serChannel, loadMembers, loadEmojis, loadStickers } from './serialize.js';
import { guildPermissionsOf, loadGuildPermData, loadMember as loadMemberData } from './perms.js';

export async function voiceStatesOf(ctx: Ctx, guildId: string): Promise<VoiceState[]> {
  const all = await ctx.redis.hgetall(`vs:${guildId}`);
  return Object.values(all)
    .map((v) => {
      try {
        return JSON.parse(v) as VoiceState;
      } catch {
        return null;
      }
    })
    .filter((v): v is VoiceState => !!v);
}

/** The full guild payload for one user (only channels they can see). */
export async function buildFullGuild(ctx: Ctx, guildId: string, userId: string, visible: Set<string>): Promise<FullGuild | null> {
  const data = await loadGuildPermData(ctx.sql, guildId);
  if (!data) return null;
  const member = await loadMemberData(ctx.sql, guildId, userId);
  if (!member) return null;
  const g: GuildRow = data.guild;
  const [roles, channels, overwrites, threads, members, emojis, stickers, voiceStates] = await Promise.all([
    ctx.sql<RoleRow[]>`SELECT * FROM roles WHERE guild_id = ${guildId} ORDER BY position`,
    ctx.sql<ChannelRow[]>`SELECT * FROM channels WHERE guild_id = ${guildId} AND type <> ${ChannelType.THREAD} ORDER BY position, id`,
    ctx.sql<OverwriteRow[]>`
      SELECT o.* FROM permission_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ${guildId}`,
    ctx.sql<ChannelRow[]>`
      SELECT * FROM channels WHERE guild_id = ${guildId} AND type = ${ChannelType.THREAD} AND NOT archived ORDER BY id DESC LIMIT 500`,
    loadMembers(ctx.sql, guildId),
    loadEmojis(ctx.sql, guildId),
    loadStickers(ctx.sql, guildId),
    voiceStatesOf(ctx, guildId),
  ]);
  const owByChannel = new Map<string, OverwriteRow[]>();
  for (const o of overwrites) {
    const l = owByChannel.get(o.channel_id) ?? [];
    l.push(o);
    owByChannel.set(o.channel_id, l);
  }
  return {
    ...serGuild(g),
    roles: roles.map(serRole),
    channels: channels.filter((c) => visible.has(c.id)).map((c) => serChannel(c, owByChannel.get(c.id) ?? [])),
    threads: threads.filter((t) => t.parent_id && visible.has(t.parent_id)).map((t) => serChannel(t)),
    members,
    emojis,
    stickers,
    voiceStates: voiceStates.filter((v) => visible.has(v.channelId)),
    permissions: guildPermissionsOf(data, userId, member).toString(),
  };
}
