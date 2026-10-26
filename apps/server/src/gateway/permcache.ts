import { ChannelType, Permissions as P, has, type PermOverwrite } from '@haunt/shared';
import type { Db } from '../db.js';
import {
  channelPermissionsOf,
  guildPermissionsOf,
  loadGuildPermData,
  loadMember,
  toOverwrite,
  type GuildPermData,
  type MemberData,
} from '../lib/perms.js';
import type { OverwriteRow } from '../rows.js';

interface GuildEntry {
  data: GuildPermData;
  /** Non-thread channels with their overwrites. */
  channels: Map<string, { id: string; type: number; overwrites: PermOverwrite[] }>;
}

/**
 * Per-process cache of what's needed to compute permissions for connected users. Any event that
 * changes roles, overwrites, channels or member roles carries `invalidate`, which drops the guild here.
 */
export class PermCache {
  private guilds = new Map<string, Promise<GuildEntry | null>>();
  private members = new Map<string, Promise<MemberData | null>>();

  constructor(private db: Db) {}

  invalidateGuild(guildId: string): void {
    this.guilds.delete(guildId);
    for (const k of this.members.keys()) if (k.startsWith(guildId + ':')) this.members.delete(k);
  }

  private loadGuild(guildId: string): Promise<GuildEntry | null> {
    let p = this.guilds.get(guildId);
    if (!p) {
      p = (async () => {
        const data = await loadGuildPermData(this.db, guildId);
        if (!data) return null;
        const chans = await this.db<{ id: string; type: number }[]>`
          SELECT id, type FROM channels WHERE guild_id = ${guildId} AND type <> ${ChannelType.THREAD}`;
        const ows = await this.db<OverwriteRow[]>`
          SELECT o.* FROM permission_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ${guildId}`;
        const byChannel = new Map<string, PermOverwrite[]>();
        for (const o of ows) {
          const list = byChannel.get(o.channel_id) ?? [];
          list.push(toOverwrite(o));
          byChannel.set(o.channel_id, list);
        }
        return {
          data,
          channels: new Map(chans.map((c) => [c.id, { id: c.id, type: c.type, overwrites: byChannel.get(c.id) ?? [] }])),
        };
      })();
      p.catch(() => this.guilds.delete(guildId));
      this.guilds.set(guildId, p);
    }
    return p;
  }

  private loadMember(guildId: string, userId: string): Promise<MemberData | null> {
    const k = `${guildId}:${userId}`;
    let p = this.members.get(k);
    if (!p) {
      p = loadMember(this.db, guildId, userId);
      p.catch(() => this.members.delete(k));
      this.members.set(k, p);
    }
    return p;
  }

  async guildPerms(guildId: string, userId: string): Promise<bigint | null> {
    const g = await this.loadGuild(guildId);
    const m = await this.loadMember(guildId, userId);
    if (!g || !m) return null;
    return guildPermissionsOf(g.data, userId, m);
  }

  async channelPerms(guildId: string, channelId: string, userId: string): Promise<bigint> {
    const g = await this.loadGuild(guildId);
    const m = await this.loadMember(guildId, userId);
    if (!g || !m) return 0n;
    const c = g.channels.get(channelId);
    if (!c) return 0n;
    return channelPermissionsOf(g.data, userId, m, c.overwrites);
  }

  /** Set of non-thread channel ids this user can view. */
  async visibleChannels(guildId: string, userId: string): Promise<Set<string>> {
    const g = await this.loadGuild(guildId);
    const m = await this.loadMember(guildId, userId);
    const out = new Set<string>();
    if (!g || !m) return out;
    for (const c of g.channels.values()) {
      if (has(channelPermissionsOf(g.data, userId, m, c.overwrites), P.VIEW_CHANNEL)) out.add(c.id);
    }
    return out;
  }
}
