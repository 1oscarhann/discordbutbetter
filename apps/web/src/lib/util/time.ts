import { snowflakeTime } from '@dbb/shared';

export function timeAgo(iso: string | number, now = Date.now()): string {
  const t = typeof iso === 'number' ? iso : new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
  const y = Math.round(mo / 12);
  return `${y} year${y === 1 ? '' : 's'} ago`;
}

export function timeUntil(iso: string): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function clockTime(d: Date, use24h: boolean): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !use24h });
}

export function messageTime(iso: string, use24h: boolean): string {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Today at ${clockTime(d, use24h)}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${clockTime(d, use24h)}`;
  return `${d.toLocaleDateString()} ${clockTime(d, use24h)}`;
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
}

export function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Discord-style <t:unix:style> rendering. */
export function formatTimestamp(unix: number, style: string, use24h: boolean): string {
  const d = new Date(unix * 1000);
  switch (style) {
    case 't':
      return clockTime(d, use24h);
    case 'T':
      return d.toLocaleTimeString(undefined, { hour12: !use24h });
    case 'd':
      return d.toLocaleDateString();
    case 'D':
      return d.toLocaleDateString(undefined, { dateStyle: 'long' });
    case 'F':
      return d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', hour12: !use24h });
    case 'R':
      return d.getTime() > Date.now() ? `in ${timeUntil(d.toISOString())}` : timeAgo(d.getTime());
    default:
      return d.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short', hour12: !use24h });
  }
}

export function idTime(id: string): number {
  return snowflakeTime(id);
}

export function duration(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
