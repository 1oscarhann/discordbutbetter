/**
 * Text cleanup applied to every piece of user text before it is stored.
 * - Unicode NFC normalisation
 * - strips control characters (keeps \n and \t in multiline text)
 * - strips bidi override/isolate characters (used to spoof filenames and links)
 * - caps stacked combining marks ("zalgo") at 4 per character
 */
const CONTROL_MULTILINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const CONTROL_SINGLE = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;
const ZALGO = /(\p{M}{4})\p{M}+/gu;
const ZERO_WIDTH_RUN = /[​-‍⁠﻿]{3,}/g;

export function cleanMultiline(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_MULTILINE, '')
    .replace(BIDI, '')
    .replace(ZALGO, '$1')
    .replace(ZERO_WIDTH_RUN, '');
}

export function cleanSingleLine(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[\t\n\r]/g, ' ')
    .replace(CONTROL_SINGLE, '')
    .replace(BIDI, '')
    .replace(ZALGO, '$1')
    .replace(ZERO_WIDTH_RUN, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only http(s) URLs with a host, no credentials. Returns the normalised URL or null. */
export function safeHttpUrl(input: string): string | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  if (u.username || u.password) return null;
  return u.toString();
}

export function isHexColor(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

export const USERNAME_RE = /^[a-z0-9_.]{2,32}$/;

export function normaliseUsername(s: string): string {
  return s.trim().toLowerCase();
}

/** Escape for safe insertion into HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Extracts a YouTube video id from the common URL shapes, or null. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (YT_ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

/** Parses "t=1m30s" / "t=90" / "start=90" from a YouTube URL. */
export function youtubeStart(input: string): number {
  try {
    const u = new URL(input);
    const t = u.searchParams.get('t') ?? u.searchParams.get('start');
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!m) return 0;
    return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  } catch {
    return 0;
  }
}

/** Plain-text preview of message markdown (for notifications, reply previews). */
export function plainPreview(content: string, max = 120): string {
  const s = content
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\|\|[\s\S]*?\|\|/g, '▒▒▒▒')
    .replace(/[*_~`>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
