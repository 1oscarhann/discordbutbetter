import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import { isAllowedCoverUrl } from '@haunt/shared';
import { requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, unavailable } from '../errors.js';
import { safeFetch } from '../lib/safefetch.js';
import { signProxyUrl } from '../services/embeds.js';
import { handleUpload } from './files.js';
import type { Ctx } from '../context.js';

export interface LookupResult {
  name: string;
  subtitle?: string;
  sourceId: string;
  coverUrl: string | null;
  /** Which game database the result came from (games only). */
  source?: 'igdb' | 'rawg';
}

const ua = (ctx: Ctx) => `${ctx.config.appName}/1.0 (+${ctx.config.publicUrl})`;

async function igdbToken(ctx: Ctx): Promise<string> {
  const cached = await ctx.redis.get('igdb:token');
  if (cached) return cached;
  const { clientId, clientSecret } = ctx.config.igdb!;
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    { method: 'POST', signal: AbortSignal.timeout(6000) },
  );
  if (!res.ok) throw unavailable('Game search is misconfigured (IGDB auth failed)');
  const j = (await res.json()) as { access_token: string; expires_in: number };
  await ctx.redis.set('igdb:token', j.access_token, 'EX', Math.max(60, j.expires_in - 300));
  return j.access_token;
}

async function searchGames(ctx: Ctx, q: string): Promise<LookupResult[]> {
  if (ctx.config.igdb) {
    const token = await igdbToken(ctx);
    const safe = q.replace(/["\\;]/g, ' ').slice(0, 80);
    const res = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: { 'Client-ID': ctx.config.igdb.clientId, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: `search "${safe}"; fields name,cover.image_id,first_release_date; where version_parent = null; limit 12;`,
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 401) await ctx.redis.del('igdb:token');
    if (!res.ok) throw unavailable('Game search failed, try again');
    const j = (await res.json()) as { id: number; name: string; cover?: { image_id: string }; first_release_date?: number }[];
    return j.map((g) => ({
      name: g.name,
      subtitle: g.first_release_date ? String(new Date(g.first_release_date * 1000).getUTCFullYear()) : undefined,
      sourceId: String(g.id),
      source: 'igdb' as const,
      coverUrl: g.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : null,
    }));
  }
  if (ctx.config.rawgKey) {
    const res = await fetch(
      `https://api.rawg.io/api/games?key=${encodeURIComponent(ctx.config.rawgKey)}&search=${encodeURIComponent(q)}&page_size=12`,
      { headers: { 'User-Agent': ua(ctx) }, signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) throw unavailable('Game search failed, try again');
    const j = (await res.json()) as { results: { id: number; name: string; released?: string; background_image?: string | null }[] };
    return j.results.map((g) => ({
      name: g.name,
      subtitle: g.released?.slice(0, 4),
      sourceId: String(g.id),
      source: 'rawg' as const,
      coverUrl: g.background_image && isAllowedCoverUrl(g.background_image) ? g.background_image : null,
    }));
  }
  throw unavailable("Game search isn't set up on this server — add a custom game instead");
}

/** MusicBrainz allows ~1 request/second; serialise across processes with a Valkey lock. */
async function musicbrainzSlot(ctx: Ctx) {
  for (let i = 0; i < 30; i++) {
    if ((await ctx.redis.set('mb:slot', '1', 'PX', 1100, 'NX')) === 'OK') return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw unavailable('Music search is busy, try again in a moment');
}

async function searchMusic(ctx: Ctx, q: string): Promise<LookupResult[]> {
  if (!ctx.config.musicSearch) throw unavailable("Music search is turned off on this server — type the song in yourself");
  await musicbrainzSlot(ctx);
  const query = q.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').slice(0, 100);
  const res = await fetch(`https://musicbrainz.org/ws/2/recording?fmt=json&limit=12&query=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': ua(ctx), Accept: 'application/json' },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw unavailable('Music search failed, try again');
  const j = (await res.json()) as {
    recordings: { id: string; title: string; 'artist-credit'?: { name: string }[]; releases?: { id: string; title: string }[] }[];
  };
  return j.recordings.map((r) => {
    const rel = r.releases?.[0];
    return {
      name: r.title,
      subtitle: r['artist-credit']?.map((a) => a.name).join(', ') ?? '',
      sourceId: r.id,
      coverUrl: rel ? `https://coverartarchive.org/release/${rel.id}/front-250` : null,
    };
  });
}

const PROXY_WIDTHS = [64, 128, 256, 400, 600, 800, 1200];

export default async function lookupRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post('/files', async (req) => handleUpload(ctx, req));

  for (const [path, fn, prefix] of [
    ['/search/games', searchGames, 'gsearch'],
    ['/search/music', searchMusic, 'msearch'],
  ] as const) {
    app.get(path, async (req) => {
      requireAuth(req);
      const q = String((req.query as { q?: string }).q ?? '').trim();
      if (q.length < 2 || q.length > 100) throw badRequest('Type at least 2 characters');
      const key = `${prefix}:${createHash('sha256').update(q.toLowerCase()).digest('hex').slice(0, 24)}`;
      const cached = await ctx.redis.get(key);
      if (cached) return JSON.parse(cached) as LookupResult[];
      await limitPreset(req, 'lookup');
      const results = await fn(ctx, q);
      await ctx.redis.set(key, JSON.stringify(results), 'EX', 86400);
      return results;
    });
  }

  /**
   * Image proxy: link-preview images and game/music covers are fetched by us, so the third party
   * never sees the viewer. Only urls we signed (embeds) or the cover-art hosts are allowed.
   */
  app.get('/proxy/image', async (req, reply) => {
    const auth = requireAuth(req);
    const q = req.query as { url?: string; sig?: string; w?: string };
    const url = String(q.url ?? '');
    if (!url || url.length > 2048) throw badRequest('Bad url');
    if (!isAllowedCoverUrl(url)) {
      const expected = Buffer.from(signProxyUrl(ctx.config.secret, url));
      const got = Buffer.from(String(q.sig ?? ''));
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw forbidden('Unsigned url');
    }
    const want = Number(q.w ?? 1200);
    const width = PROXY_WIDTHS.find((w) => w >= want) ?? 1200;
    const cacheKey = `px:${createHash('sha256').update(`${width}:${url}`).digest('hex').slice(0, 32)}`;
    const cached = await ctx.redis.getBuffer(cacheKey);
    reply.header('Cache-Control', 'private, max-age=86400');
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    reply.header('X-Content-Type-Options', 'nosniff');
    if (cached) return reply.type(cached.subarray(0, 4).toString() === 'GIF8' ? 'image/gif' : 'image/webp').send(cached);
    await limitPreset(req, 'proxy', auth.userId);

    let fetched;
    try {
      fetched = await safeFetch(url, { maxBytes: 12 * 1024 * 1024, accept: 'image/*', userAgent: ua(ctx), timeoutMs: 8000 });
    } catch {
      return reply.code(502).send();
    }
    if (fetched.status >= 400 || !fetched.contentType.startsWith('image/') || fetched.contentType.includes('svg')) {
      return reply.code(415).send();
    }
    let out: Buffer;
    try {
      const meta = await sharp(fetched.body, { animated: true, limitInputPixels: 50_000_000 }).metadata();
      const animated = (meta.pages ?? 1) > 1;
      out = await sharp(fetched.body, { animated, limitInputPixels: 50_000_000 })
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82, effort: 2 })
        .toBuffer();
    } catch {
      return reply.code(415).send();
    }
    if (out.length < 1024 * 1024) await ctx.redis.set(cacheKey, out, 'EX', 3600);
    return reply.type('image/webp').send(out);
  });
}
