import { createHash, createHmac } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { youtubeId, type Embed, isAllowedCoverUrl } from '@dbb/shared';
import type { Ctx } from '../context.js';
import { safeFetch } from '../lib/safefetch.js';

/** HMAC so only urls our server put into embeds can go through the image proxy. */
export function signProxyUrl(secret: string, url: string): string {
  return createHmac('sha256', secret).update(url).digest('base64url').slice(0, 24);
}

export function proxied(ctx: Ctx, url: string): string {
  if (isAllowedCoverUrl(url)) return `/api/proxy/image?${new URLSearchParams({ url })}`;
  return `/api/proxy/image?${new URLSearchParams({ url, sig: signProxyUrl(ctx.config.secret, url) })}`;
}

function ua(ctx: Ctx) {
  return `Mozilla/5.0 (compatible; ${ctx.config.appName}-LinkPreview/1.0; +${ctx.config.publicUrl})`;
}

interface Meta {
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  themeColor?: string;
  type?: string;
}

export function parseMeta(html: string, baseUrl: string): Meta {
  const meta: Meta = {};
  let inTitle = false;
  let titleText = '';
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'title') inTitle = true;
        if (name !== 'meta') return;
        const key = (attrs.property || attrs.name || '').toLowerCase();
        const val = attrs.content;
        if (!val) return;
        switch (key) {
          case 'og:title':
            meta.title ??= val;
            break;
          case 'twitter:title':
            meta.title ??= val;
            break;
          case 'og:description':
          case 'twitter:description':
          case 'description':
            meta.description ??= val;
            break;
          case 'og:site_name':
            meta.siteName ??= val;
            break;
          case 'og:image':
          case 'og:image:url':
          case 'og:image:secure_url':
          case 'twitter:image':
          case 'twitter:image:src':
            meta.image ??= val;
            break;
          case 'og:image:width':
            meta.imageWidth ??= Number(val) || undefined;
            break;
          case 'og:image:height':
            meta.imageHeight ??= Number(val) || undefined;
            break;
          case 'theme-color':
            if (/^#[0-9a-f]{6}$/i.test(val)) meta.themeColor ??= val;
            break;
          case 'og:type':
            meta.type ??= val;
            break;
        }
      },
      ontext(text) {
        if (inTitle) titleText += text;
      },
      onclosetag(name) {
        if (name === 'title') inTitle = false;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  if (!meta.title && titleText.trim()) meta.title = titleText.trim();
  if (meta.image) {
    try {
      const abs = new URL(meta.image, baseUrl);
      meta.image = abs.protocol === 'https:' || abs.protocol === 'http:' ? abs.toString() : undefined;
    } catch {
      meta.image = undefined;
    }
  }
  return meta;
}

const clip = (s: string | undefined, n: number) => (s ? (s.length > n ? s.slice(0, n - 1) + '…' : s) : undefined);

async function unfurlOne(ctx: Ctx, url: string): Promise<Embed | null> {
  const yt = youtubeId(url);
  if (yt) {
    let title: string | undefined;
    let author: string | undefined;
    try {
      const r = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}`, {
        maxBytes: 64 * 1024,
        accept: 'application/json',
        userAgent: ua(ctx),
        timeoutMs: 5000,
      });
      if (r.status === 200) {
        const j = JSON.parse(r.body.toString('utf8')) as { title?: string; author_name?: string };
        title = j.title;
        author = j.author_name;
      }
    } catch {
      /* no title, still embed */
    }
    return {
      type: 'youtube',
      url,
      youtubeId: yt,
      title: clip(title, 256),
      siteName: author ? `YouTube · ${clip(author, 80)}` : 'YouTube',
      thumbnail: { url: proxied(ctx, `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`), width: 480, height: 360 },
    };
  }

  const res = await safeFetch(url, {
    maxBytes: 512 * 1024,
    stopAtLimit: true,
    accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5',
    userAgent: ua(ctx),
    timeoutMs: 7000,
  });
  if (res.status >= 400) return null;
  if (res.contentType.startsWith('image/') && res.contentType !== 'image/svg+xml') {
    return { type: 'image', url, image: { url: proxied(ctx, res.url) } };
  }
  if (res.contentType !== 'text/html' && res.contentType !== 'application/xhtml+xml') return null;
  const meta = parseMeta(res.body.toString('utf8'), res.url);
  if (!meta.title && !meta.description && !meta.image) return null;
  const embed: Embed = {
    type: 'link',
    url,
    title: clip(meta.title, 256),
    description: clip(meta.description, 350),
    siteName: clip(meta.siteName ?? new URL(res.url).hostname, 100),
    color: meta.themeColor,
  };
  if (meta.image) {
    const big = (meta.imageWidth ?? 0) >= 400 || meta.type === 'article' || meta.type === 'video.other';
    const img = { url: proxied(ctx, meta.image), width: meta.imageWidth, height: meta.imageHeight };
    if (big) embed.image = img;
    else embed.thumbnail = img;
  }
  return embed;
}

/** Unfurls up to 5 links, cached 24h per url. Never throws. */
export async function unfurl(ctx: Ctx, urls: string[]): Promise<Embed[]> {
  const out: Embed[] = [];
  for (const url of urls.slice(0, 5)) {
    const key = `embed:${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
    const cached = await ctx.redis.get(key);
    if (cached) {
      if (cached !== 'null') out.push(JSON.parse(cached) as Embed);
      continue;
    }
    let e: Embed | null = null;
    try {
      e = await unfurlOne(ctx, url);
    } catch {
      e = null;
    }
    await ctx.redis.set(key, JSON.stringify(e), 'EX', e ? 86400 : 3600);
    if (e) out.push(e);
  }
  return out;
}
