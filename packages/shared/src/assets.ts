/**
 * Covers and embed images from third parties are never loaded directly by the browser:
 * they go through our image proxy so the third party never sees the viewer's IP.
 */
export function proxiedImage(url: string | null | undefined, width?: number): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return url; // our own stored file or an already-proxied url
  const q = new URLSearchParams({ url });
  if (width) q.set('w', String(width));
  return `/api/proxy/image?${q.toString()}`;
}

/** "Alice Smith" -> "AS"; emoji and symbols are skipped ("Alice ✨" -> "A"). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  const out = words
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
  return out || [...name.trim()][0] || '?';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** "/files/123/secret/name.png" -> "123" */
export function fileIdFromUrl(url: string | null | undefined): string | null {
  const m = url?.match(/^\/files\/(\d+)\//);
  return m?.[1] ?? null;
}
