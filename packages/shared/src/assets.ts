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

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => [...p][0] ?? '').join('').toUpperCase() || '?';
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
