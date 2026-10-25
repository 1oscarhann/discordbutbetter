import type { FastifyInstance } from 'fastify';
import { ChannelType, Permissions as P, SearchQuerySchema, has, type SearchResult } from '@dbb/shared';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { guildAccess, channelPermissionsOf, loadOverwrites } from '../lib/perms.js';
import { queryMessages } from '../lib/serialize.js';
import type { Ctx } from '../context.js';
import type { Db } from '../db.js';

/**
 * Turns "hello wor" into the tsquery  hello & wor:*  (last word is a prefix match).
 * Only letters/numbers survive, so users can't inject tsquery operators.
 */
export function toTsQuery(q: string): string | null {
  const words = q
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .slice(0, 12);
  if (!words.length) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}:*` : w)).join(' & ');
}

type Q = ReturnType<typeof SearchQuerySchema.parse>;

function filters(db: Db, q: Q) {
  const parts = [];
  const tq = q.q ? toTsQuery(q.q) : null;
  if (tq) parts.push(db`m.search @@ to_tsquery('simple', ${tq})`);
  if (q.authorId) parts.push(db`m.author_id = ${q.authorId}`);
  if (q.mentions) parts.push(db`${q.mentions}::bigint = ANY(m.mentions)`);
  if (q.before) parts.push(db`m.created_at < ${q.before}::date`);
  if (q.after) parts.push(db`m.created_at >= ${q.after}::date + 1`);
  if (q.pinned === 'true') parts.push(db`m.pinned`);
  const has = q.has ? (Array.isArray(q.has) ? q.has : [q.has]) : [];
  for (const h of has) {
    if (h === 'file') parts.push(db`EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id)`);
    if (h === 'image')
      parts.push(db`EXISTS (SELECT 1 FROM message_attachments a JOIN files f ON f.id = a.file_id WHERE a.message_id = m.id AND f.content_type LIKE 'image/%')`);
    if (h === 'video')
      parts.push(db`EXISTS (SELECT 1 FROM message_attachments a JOIN files f ON f.id = a.file_id WHERE a.message_id = m.id AND f.content_type LIKE 'video/%')`);
    if (h === 'link') parts.push(db`m.content ~ 'https?://'`);
    if (h === 'embed') parts.push(db`jsonb_array_length(m.embeds) > 0`);
  }
  parts.push(db`m.type = 0`);
  return parts.reduce((acc, p) => db`${acc} AND ${p}`);
}

async function run(ctx: Ctx, viewerId: string, channelIds: string[], q: Q): Promise<SearchResult> {
  if (!channelIds.length) return { total: 0, messages: [], channels: {} };
  const where = ctx.sql`m.channel_id = ANY(${channelIds}::bigint[]) AND ${filters(ctx.sql, q)}`;
  const [{ total }] = (await ctx.sql<{ total: number }[]>`
    SELECT count(*)::int AS total FROM (SELECT 1 FROM messages m WHERE ${where} AND (m.expires_at IS NULL OR m.expires_at > now()) LIMIT 5000) x`) as unknown as [
    { total: number },
  ];
  const messages = await queryMessages(ctx.sql, viewerId, where, {
    order: q.sort === 'oldest' ? 'asc' : 'desc',
    limit: q.limit,
    offset: q.offset,
  });
  const ids = [...new Set(messages.map((m) => m.channelId))];
  const chans = ids.length
    ? await ctx.sql<{ id: string; name: string | null; guild_id: string | null }[]>`SELECT id, name, guild_id FROM channels WHERE id = ANY(${ids}::bigint[])`
    : [];
  return { total, messages, channels: Object.fromEntries(chans.map((c) => [c.id, { name: c.name, guildId: c.guild_id }])) };
}

export default async function searchRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/guilds/:id/messages/search', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'search');
    const guildId = idParam(req, 'id');
    const q = parse(SearchQuerySchema, req.query);
    const a = await guildAccess(ctx, guildId, auth.userId);
    // only channels you can read history in (plus their threads)
    const chans = await ctx.sql<{ id: string; type: number; parent_id: string | null }[]>`
      SELECT id, type, parent_id FROM channels WHERE guild_id = ${guildId} AND type IN (${ChannelType.TEXT}, ${ChannelType.VOICE}, ${ChannelType.THREAD})`;
    const readable = new Set<string>();
    for (const c of chans.filter((c) => c.type !== ChannelType.THREAD)) {
      const perms = channelPermissionsOf(a.data, auth.userId, a.member, await loadOverwrites(ctx.sql, c.id));
      if (has(perms, P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY)) readable.add(c.id);
    }
    for (const t of chans.filter((c) => c.type === ChannelType.THREAD)) if (t.parent_id && readable.has(t.parent_id)) readable.add(t.id);
    let ids = [...readable];
    if (q.channelId) ids = ids.filter((i) => i === q.channelId);
    return run(ctx, auth.userId, ids, q);
  });

  app.get('/users/@me/messages/search', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'search');
    const q = parse(SearchQuerySchema, req.query);
    const rows = await ctx.sql<{ channel_id: string }[]>`SELECT channel_id FROM dm_recipients WHERE user_id = ${auth.userId}`;
    let ids = rows.map((r) => r.channel_id);
    if (q.channelId) ids = ids.filter((i) => i === q.channelId);
    return run(ctx, auth.userId, ids, q);
  });
}
