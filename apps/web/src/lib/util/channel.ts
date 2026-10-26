import { ChannelType, type Channel } from '@haunt/shared';
import { app } from '$lib/state/app.svelte';

export function channelTitle(c: Channel | null): string {
  if (!c) return '';
  if (c.type === ChannelType.DM || c.type === ChannelType.GROUP_DM) {
    if (c.type === ChannelType.GROUP_DM && c.name) return c.name;
    const others = (c.recipients ?? []).filter((r) => r.id !== app.me?.id);
    return others.map((u) => app.displayName(u.id)).join(', ') || 'Just you';
  }
  return c.name ?? '';
}

export function channelHref(c: Channel): string {
  return c.guildId ? `/app/${c.guildId}/${c.id}` : `/app/me/${c.id}`;
}

export function disappearingLabel(s: number): string {
  if (!s) return 'Off';
  if (s < 3600) return `${s / 60} minutes`;
  if (s < 86400) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
  return `${s / 86400} day${s === 86400 ? '' : 's'}`;
}

export function copy(text: string, label = 'Copied') {
  void navigator.clipboard.writeText(text).then(() => app.toast(label, 'success'));
}
