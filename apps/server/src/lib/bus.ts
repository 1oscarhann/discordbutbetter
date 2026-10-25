import type { GatewayEventName, GatewayEvents } from '@dbb/shared';
import type { Redis } from '../redis.js';

/**
 * Envelope published to Valkey. The gateway on every process receives it and decides, per socket,
 * whether to deliver it.
 */
export interface Envelope {
  t: GatewayEventName | InternalEvent;
  d: unknown;
  /** Guild events about a channel: only sockets that can see this channel get it. */
  channelId?: string;
  /** Extra permission bits (decimal string) required in that channel/guild. */
  perm?: string;
  only?: string[];
  exclude?: string[];
  onlySession?: string;
  excludeSession?: string;
  /** Drop cached permission data for this guild before filtering (roles/overwrites/members changed). */
  invalidate?: boolean;
}

/** Control messages between the API and the gateway; never sent to clients as-is. */
export type InternalEvent =
  /** User joined a guild: subscribe their sockets and send GUILD_CREATE. d = { guildId } */
  | '_GUILD_JOIN'
  /** User left/was removed: unsubscribe and send GUILD_DELETE. d = { guildId } */
  | '_GUILD_LEAVE'
  /** Permissions changed in a guild: recompute each member's visible channels. d = { guildId, userId? } */
  | '_PERMS_CHANGED'
  /** A per-viewer payload (mini games): d = { t, byUser: { [userId]: payload }, fallback } */
  | '_PER_USER';

export interface PublishOpts {
  only?: string[];
  exclude?: string[];
  onlySession?: string;
  excludeSession?: string;
}

export class Bus {
  constructor(private redis: Redis) {}

  private pub(topic: string, env: Envelope): void {
    this.redis.publish(topic, JSON.stringify(env)).catch((e: Error) => console.error('[bus] publish failed', e.message));
  }

  toUser<K extends GatewayEventName>(userId: string, t: K, d: GatewayEvents[K], opts: PublishOpts = {}): void {
    this.pub(`u:${userId}`, { t, d, ...opts });
  }

  toUsers<K extends GatewayEventName>(userIds: Iterable<string>, t: K, d: GatewayEvents[K], opts: PublishOpts = {}): void {
    for (const id of new Set(userIds)) this.toUser(id, t, d, opts);
  }

  toGuild<K extends GatewayEventName>(
    guildId: string,
    t: K,
    d: GatewayEvents[K],
    opts: PublishOpts & { channelId?: string; perm?: bigint; invalidate?: boolean } = {},
  ): void {
    const { perm, ...rest } = opts;
    this.pub(`g:${guildId}`, { t, d, ...rest, perm: perm !== undefined ? perm.toString() : undefined });
  }

  internalUser(userId: string, t: InternalEvent, d: unknown): void {
    this.pub(`u:${userId}`, { t, d });
  }

  internalGuild(guildId: string, t: InternalEvent, d: unknown, opts: { invalidate?: boolean } = {}): void {
    this.pub(`g:${guildId}`, { t, d, ...opts });
  }

  /** Sends a different payload to each listed user (used for games with hidden info). */
  perUser<K extends GatewayEventName>(userIds: string[], t: K, byUser: Record<string, GatewayEvents[K]>): void {
    for (const id of userIds) {
      const d = byUser[id];
      if (d !== undefined) this.toUser(id, t, d);
    }
  }
}
