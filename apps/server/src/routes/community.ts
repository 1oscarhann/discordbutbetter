import type { FastifyInstance } from 'fastify';
import {
  AuditAction,
  AutomodRulePatchSchema,
  AutomodRuleSchema,
  ChannelType,
  CreateEmojiSchema,
  CreateStickerSchema,
  EmojiPatchSchema,
  LevelRolesSchema,
  LevelSettingsSchema,
  Limits,
  Permissions as P,
  WikiPagePatchSchema,
  WikiPageSchema,
  canManageRole,
  has,
  levelFromXp,
  type AutomodRule,
  type WikiPage,
} from '@dbb/shared';
import type { GuildRow, UserRow } from '../rows.js';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { channelAccess, guildAccess, requireGuildPerm } from '../lib/perms.js';
import { guild as serGuild, loadEmojis, loadStickers, publicUser } from '../lib/serialize.js';
import { audit } from '../lib/audit.js';
import { snowflake } from '../ids.js';
import { claimFile, deleteFile, fileUrl } from './files.js';
import { toChannel } from '../lib/fanout.js';
import type { Ctx } from '../context.js';

interface WikiRow {
  id: string;
  channel_id: string;
  title: string;
  content: string;
  position: number;
  pinned: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

async function wikiObj(ctx: Ctx, r: WikiRow): Promise<WikiPage> {
  const ids = [r.created_by, r.updated_by].filter((x): x is string => !!x);
  const users = ids.length ? await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ANY(${ids}::bigint[])` : [];
  const u = new Map(users.map((x) => [x.id, publicUser(x)]));
  return {
    id: r.id,
    channelId: r.channel_id,
    title: r.title,
    content: r.content,
    position: r.position,
    pinned: r.pinned,
    createdBy: r.created_by ? (u.get(r.created_by) ?? null) : null,
    updatedBy: r.updated_by ? (u.get(r.updated_by) ?? null) : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

interface RuleRow {
  id: string;
  guild_id: string;
  name: string;
  enabled: boolean;
  trigger: AutomodRule['trigger'];
  actions: AutomodRule['actions'];
  exempt_roles: string[];
  exempt_channels: string[];
  created_at: Date;
}

const ruleObj = (r: RuleRow): AutomodRule => ({
  id: r.id,
  guildId: r.guild_id,
  name: r.name,
  enabled: r.enabled,
  trigger: r.trigger,
  actions: r.actions,
  exemptRoles: r.exempt_roles,
  exemptChannels: r.exempt_channels,
  createdAt: r.created_at.toISOString(),
});

export default async function communityRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // ================= wiki =================

  async function wikiAccess(channelId: string, userId: string) {
    const a = await channelAccess(ctx, channelId, userId);
    if (a.channel.type !== ChannelType.WIKI) throw badRequest('Not a wiki channel');
    return a;
  }

  app.get('/channels/:id/wiki', async (req) => {
    const auth = requireAuth(req);
    const a = await wikiAccess(idParam(req, 'id'), auth.userId);
    const rows = await ctx.sql<WikiRow[]>`
      SELECT * FROM wiki_pages WHERE channel_id = ${a.channel.id} ORDER BY pinned DESC, position, id`;
    return Promise.all(rows.map((r) => wikiObj(ctx, { ...r, content: r.content })));
  });

  app.get('/channels/:id/wiki/:pageId', async (req) => {
    const auth = requireAuth(req);
    const a = await wikiAccess(idParam(req, 'id'), auth.userId);
    const [r] = await ctx.sql<WikiRow[]>`SELECT * FROM wiki_pages WHERE id = ${idParam(req, 'pageId')} AND channel_id = ${a.channel.id}`;
    if (!r) throw notFound('Page not found');
    return wikiObj(ctx, r);
  });

  app.post('/channels/:id/wiki', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'edit');
    const body = parse(WikiPageSchema, req.body);
    const a = await wikiAccess(idParam(req, 'id'), auth.userId);
    if (!has(a.perms, P.MANAGE_WIKI)) throw forbidden('You need Manage Wiki to edit pages');
    const [{ count }] = (await ctx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM wiki_pages WHERE channel_id = ${a.channel.id}`) as unknown as [
      { count: number },
    ];
    if (count >= 200) throw forbidden('A wiki channel can have at most 200 pages');
    const id = snowflake();
    const [r] = await ctx.sql<WikiRow[]>`
      INSERT INTO wiki_pages (id, channel_id, title, content, position, pinned, created_by, updated_by)
      VALUES (${id}, ${a.channel.id}, ${body.title}, ${body.content}, ${count}, ${body.pinned}, ${auth.userId}, ${auth.userId})
      RETURNING *`;
    await ctx.sql`
      INSERT INTO wiki_revisions (id, page_id, title, content, editor_id) VALUES (${snowflake()}, ${id}, ${body.title}, ${body.content}, ${auth.userId})`;
    await audit(ctx.sql, { guildId: a.channel.guild_id!, actorId: auth.userId, action: AuditAction.WIKI_PAGE_CREATE, targetType: 'wiki', targetId: id, changes: { title: body.title } });
    const page = await wikiObj(ctx, r!);
    await toChannel(ctx, a.channel, 'WIKI_PAGE_CREATE', page);
    return page;
  });

  app.patch('/channels/:id/wiki/:pageId', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'edit');
    const p = parse(WikiPagePatchSchema, req.body);
    const a = await wikiAccess(idParam(req, 'id'), auth.userId);
    if (!has(a.perms, P.MANAGE_WIKI)) throw forbidden('You need Manage Wiki to edit pages');
    const pageId = idParam(req, 'pageId');
    const [old] = await ctx.sql<WikiRow[]>`SELECT * FROM wiki_pages WHERE id = ${pageId} AND channel_id = ${a.channel.id}`;
    if (!old) throw notFound('Page not found');
    const sets: Record<string, unknown> = { updated_by: auth.userId, updated_at: new Date() };
    if (p.title !== undefined) sets.title = p.title;
    if (p.content !== undefined) sets.content = p.content;
    if (p.pinned !== undefined) sets.pinned = p.pinned;
    if (p.position !== undefined) sets.position = p.position;
    const [r] = await ctx.sql<WikiRow[]>`UPDATE wiki_pages SET ${ctx.sql(sets)} WHERE id = ${pageId} RETURNING *`;
    if (p.title !== undefined || p.content !== undefined) {
      await ctx.sql`INSERT INTO wiki_revisions (id, page_id, title, content, editor_id) VALUES (${snowflake()}, ${pageId}, ${r!.title}, ${r!.content}, ${auth.userId})`;
      // keep the last 100 revisions per page
      await ctx.sql`
        DELETE FROM wiki_revisions WHERE page_id = ${pageId} AND id IN (SELECT id FROM wiki_revisions WHERE page_id = ${pageId} ORDER BY id DESC OFFSET 100)`;
      await audit(ctx.sql, { guildId: a.channel.guild_id!, actorId: auth.userId, action: AuditAction.WIKI_PAGE_UPDATE, targetType: 'wiki', targetId: pageId, changes: { title: r!.title } });
    }
    const page = await wikiObj(ctx, r!);
    await toChannel(ctx, a.channel, 'WIKI_PAGE_UPDATE', page);
    return page;
  });

  app.delete('/channels/:id/wiki/:pageId', async (req) => {
    const auth = requireAuth(req);
    const a = await wikiAccess(idParam(req, 'id'), auth.userId);
    if (!has(a.perms, P.MANAGE_WIKI)) throw forbidden();
    const pageId = idParam(req, 'pageId');
    const [r] = await ctx.sql<WikiRow[]>`DELETE FROM wiki_pages WHERE id = ${pageId} AND channel_id = ${a.channel.id} RETURNING *`;
    if (!r) throw notFound('Page not found');
    await audit(ctx.sql, { guildId: a.channel.guild_id!, actorId: auth.userId, action: AuditAction.WIKI_PAGE_DELETE, targetType: 'wiki', targetId: pageId, changes: { title: r.title } });
    await toChannel(ctx, a.channel, 'WIKI_PAGE_DELETE', { id: pageId, channelId: a.channel.id });
    return { ok: true };
  });

  app.get('/channels/:id/wiki/:pageId/revisions', async (req) => {
    const auth = requireAuth(req);
    const a = await wikiAccess(idParam(req, 'id'), auth.userId);
    const pageId = idParam(req, 'pageId');
    const [page] = await ctx.sql`SELECT 1 FROM wiki_pages WHERE id = ${pageId} AND channel_id = ${a.channel.id}`;
    if (!page) throw notFound('Page not found');
    const rows = await ctx.sql<(UserRow & { rev_id: string; rev_title: string; rev_content: string; rev_at: Date })[]>`
      SELECT r.id AS rev_id, r.title AS rev_title, r.content AS rev_content, r.created_at AS rev_at, u.*
      FROM wiki_revisions r LEFT JOIN users u ON u.id = r.editor_id WHERE r.page_id = ${pageId} ORDER BY r.id DESC LIMIT 100`;
    return rows.map((r) => ({
      id: r.rev_id,
      title: r.rev_title,
      content: r.rev_content,
      editor: r.id ? publicUser(r) : null,
      createdAt: r.rev_at.toISOString(),
    }));
  });

  // ================= levels =================

  app.get('/guilds/:id/levels', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const a = await guildAccess(ctx, guildId, auth.userId);
    const offset = Math.max(0, Math.min(10000, Number((req.query as { offset?: string }).offset ?? 0) || 0));
    const rows = await ctx.sql<(UserRow & { xp: string; lvl: number; msgs: number })[]>`
      SELECT u.*, x.xp, x.level AS lvl, x.messages AS msgs FROM member_xp x JOIN users u ON u.id = x.user_id
      JOIN guild_members m ON m.guild_id = x.guild_id AND m.user_id = x.user_id
      WHERE x.guild_id = ${guildId} ORDER BY x.xp DESC, x.user_id LIMIT 50 OFFSET ${offset}`;
    const [mine] = await ctx.sql<{ xp: string; level: number; messages: number; rank: number }[]>`
      SELECT xp, level, messages, (SELECT count(*)::int + 1 FROM member_xp y WHERE y.guild_id = x.guild_id AND y.xp > x.xp) AS rank
      FROM member_xp x WHERE guild_id = ${guildId} AND user_id = ${auth.userId}`;
    const roles = await ctx.sql<{ level: number; role_id: string }[]>`SELECT level, role_id FROM level_roles WHERE guild_id = ${guildId} ORDER BY level`;
    return {
      settings: serGuild(a.data.guild).levels,
      roles: roles.map((r) => ({ level: r.level, roleId: r.role_id })),
      leaderboard: rows.map((r, i) => ({ user: publicUser(r), xp: Number(r.xp), level: r.lvl, messages: r.msgs, rank: offset + i + 1 })),
      me: mine ? { xp: Number(mine.xp), ...levelFromXp(Number(mine.xp)), messages: mine.messages, rank: mine.rank } : null,
    };
  });

  app.patch('/guilds/:id/levels/settings', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const p = parse(LevelSettingsSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_GUILD);
    if (p.announceChannelId) {
      const [c] = await ctx.sql`SELECT 1 FROM channels WHERE id = ${p.announceChannelId} AND guild_id = ${guildId} AND type = ${ChannelType.TEXT}`;
      if (!c) throw badRequest('Pick a text channel in this server');
    }
    const sets: Record<string, unknown> = {};
    if (p.enabled !== undefined) sets.levels_enabled = p.enabled;
    if (p.announce !== undefined) sets.levels_announce = p.announce;
    if (p.announceChannelId !== undefined) sets.levels_channel_id = p.announceChannelId;
    if (!Object.keys(sets).length) throw badRequest('Nothing to change');
    const [g] = await ctx.sql<GuildRow[]>`UPDATE guilds SET ${ctx.sql(sets)} WHERE id = ${guildId} RETURNING *`;
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.LEVEL_SETTINGS_UPDATE, targetType: 'guild', targetId: guildId, changes: p });
    ctx.bus.toGuild(guildId, 'GUILD_UPDATE', serGuild(g!));
    return serGuild(g!).levels;
  });

  app.put('/guilds/:id/levels/roles', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const list = parse(LevelRolesSchema, req.body);
    const a = await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_ROLES);
    for (const r of list) {
      const role = a.data.roles.get(r.roleId);
      if (!role || r.roleId === guildId) throw badRequest('Unknown role');
      if (!canManageRole(a.highest, role.position, a.isOwner)) throw forbidden("You can't hand out roles at or above your highest role");
    }
    await ctx.sql.begin(async (tx) => {
      await tx`DELETE FROM level_roles WHERE guild_id = ${guildId}`;
      for (const r of list) await tx`INSERT INTO level_roles (guild_id, level, role_id) VALUES (${guildId}, ${r.level}, ${r.roleId}) ON CONFLICT DO NOTHING`;
    });
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.LEVEL_SETTINGS_UPDATE, targetType: 'guild', targetId: guildId, changes: { roles: list } });
    return list;
  });

  // ================= custom emoji & stickers =================

  app.get('/guilds/:id/emojis', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await guildAccess(ctx, guildId, auth.userId);
    return loadEmojis(ctx.sql, guildId);
  });

  app.post('/guilds/:id/emojis', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await limitPreset(req, 'upload');
    const body = parse(CreateEmojiSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_EMOJIS);
    const [{ count }] = (await ctx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM guild_emojis WHERE guild_id = ${guildId}`) as unknown as [
      { count: number },
    ];
    if (count >= ctx.config.limits.emojisPerGuild) throw forbidden(`This server has the maximum of ${ctx.config.limits.emojisPerGuild} emoji`);
    const dupe = await ctx.sql`SELECT 1 FROM guild_emojis WHERE guild_id = ${guildId} AND name = ${body.name}`;
    if (dupe.length) throw conflict('An emoji with that name already exists');
    const f = await claimFile(ctx, body.fileId, auth.userId, ['emoji']);
    const id = snowflake();
    await ctx.sql`
      INSERT INTO guild_emojis (id, guild_id, name, url, animated, creator_id)
      VALUES (${id}, ${guildId}, ${body.name}, ${fileUrl(f)}, ${f.animated}, ${auth.userId})`;
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.EMOJI_CREATE, targetType: 'emoji', targetId: id, changes: { name: body.name } });
    const emojis = await loadEmojis(ctx.sql, guildId);
    ctx.bus.toGuild(guildId, 'GUILD_EMOJIS_UPDATE', { guildId, emojis });
    return emojis.find((e) => e.id === id);
  });

  app.patch('/guilds/:id/emojis/:emojiId', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const emojiId = idParam(req, 'emojiId');
    const { name } = parse(EmojiPatchSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_EMOJIS);
    const dupe = await ctx.sql`SELECT 1 FROM guild_emojis WHERE guild_id = ${guildId} AND name = ${name} AND id <> ${emojiId}`;
    if (dupe.length) throw conflict('An emoji with that name already exists');
    const r = await ctx.sql`UPDATE guild_emojis SET name = ${name} WHERE id = ${emojiId} AND guild_id = ${guildId} RETURNING id`;
    if (!r.length) throw notFound('Emoji not found');
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.EMOJI_UPDATE, targetType: 'emoji', targetId: emojiId, changes: { name } });
    const emojis = await loadEmojis(ctx.sql, guildId);
    ctx.bus.toGuild(guildId, 'GUILD_EMOJIS_UPDATE', { guildId, emojis });
    return emojis.find((e) => e.id === emojiId);
  });

  app.delete('/guilds/:id/emojis/:emojiId', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const emojiId = idParam(req, 'emojiId');
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_EMOJIS);
    const [e] = await ctx.sql<{ url: string; name: string }[]>`DELETE FROM guild_emojis WHERE id = ${emojiId} AND guild_id = ${guildId} RETURNING url, name`;
    if (!e) throw notFound('Emoji not found');
    await deleteFile(ctx, e.url);
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.EMOJI_DELETE, targetType: 'emoji', targetId: emojiId, changes: { name: e.name } });
    ctx.bus.toGuild(guildId, 'GUILD_EMOJIS_UPDATE', { guildId, emojis: await loadEmojis(ctx.sql, guildId) });
    return { ok: true };
  });

  /** Image for a custom emoji by id (used when rendering <:name:id> from servers you're not in). */
  app.get('/emojis/:id', async (req, reply) => {
    requireAuth(req);
    const [e] = await ctx.sql<{ url: string }[]>`SELECT url FROM guild_emojis WHERE id = ${idParam(req, 'id')}`;
    if (!e) throw notFound('Emoji not found');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.redirect(e.url, 302);
  });

  app.get('/guilds/:id/stickers', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await guildAccess(ctx, guildId, auth.userId);
    return loadStickers(ctx.sql, guildId);
  });

  app.post('/guilds/:id/stickers', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await limitPreset(req, 'upload');
    const body = parse(CreateStickerSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_EMOJIS);
    const [{ count }] = (await ctx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM guild_stickers WHERE guild_id = ${guildId}`) as unknown as [
      { count: number },
    ];
    if (count >= ctx.config.limits.stickersPerGuild) throw forbidden(`This server has the maximum of ${ctx.config.limits.stickersPerGuild} stickers`);
    const f = await claimFile(ctx, body.fileId, auth.userId, ['sticker']);
    const format = f.content_type === 'image/gif' ? 'gif' : f.content_type === 'image/webp' ? 'webp' : f.animated ? 'apng' : 'png';
    const id = snowflake();
    await ctx.sql`
      INSERT INTO guild_stickers (id, guild_id, name, description, url, format, creator_id)
      VALUES (${id}, ${guildId}, ${body.name}, ${body.description}, ${fileUrl(f)}, ${format}, ${auth.userId})`;
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.STICKER_CREATE, targetType: 'sticker', targetId: id, changes: { name: body.name } });
    const stickers = await loadStickers(ctx.sql, guildId);
    ctx.bus.toGuild(guildId, 'GUILD_STICKERS_UPDATE', { guildId, stickers });
    return stickers.find((s) => s.id === id);
  });

  app.delete('/guilds/:id/stickers/:stickerId', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const stickerId = idParam(req, 'stickerId');
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_EMOJIS);
    const [s] = await ctx.sql<{ url: string; name: string }[]>`DELETE FROM guild_stickers WHERE id = ${stickerId} AND guild_id = ${guildId} RETURNING url, name`;
    if (!s) throw notFound('Sticker not found');
    await deleteFile(ctx, s.url);
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.STICKER_DELETE, targetType: 'sticker', targetId: stickerId, changes: { name: s.name } });
    ctx.bus.toGuild(guildId, 'GUILD_STICKERS_UPDATE', { guildId, stickers: await loadStickers(ctx.sql, guildId) });
    return { ok: true };
  });

  // ================= audit log =================

  app.get('/guilds/:id/audit-log', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await requireGuildPerm(ctx, guildId, auth.userId, P.VIEW_AUDIT_LOG);
    const q = req.query as { before?: string; action?: string; actorId?: string };
    const before = q.before && /^\d{1,20}$/.test(q.before) ? q.before : null;
    const actor = q.actorId && /^\d{1,20}$/.test(q.actorId) ? q.actorId : null;
    const action = q.action && /^[a-z_]{1,40}$/.test(q.action) ? q.action : null;
    const rows = await ctx.sql<
      (UserRow & { e_id: string; action: string; target_type: string | null; target_id: string | null; changes: Record<string, unknown> | null; reason: string | null; e_at: Date; actor_exists: boolean })[]
    >`
      SELECT e.id AS e_id, e.action, e.target_type, e.target_id, e.changes, e.reason, e.created_at AS e_at, (u.id IS NOT NULL) AS actor_exists, u.*
      FROM audit_log e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.guild_id = ${guildId}
        ${before ? ctx.sql`AND e.id < ${before}` : ctx.sql``}
        ${actor ? ctx.sql`AND e.actor_id = ${actor}` : ctx.sql``}
        ${action ? ctx.sql`AND e.action = ${action}` : ctx.sql``}
      ORDER BY e.id DESC LIMIT 50`;
    // resolve target users for display
    const targetIds = [...new Set(rows.filter((r) => r.target_type === 'user' && r.target_id).map((r) => r.target_id!))];
    const targets = targetIds.length ? await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ANY(${targetIds}::bigint[])` : [];
    return {
      entries: rows.map((r) => ({
        id: r.e_id,
        guildId,
        actor: r.actor_exists ? publicUser(r) : null,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        changes: r.changes,
        reason: r.reason,
        createdAt: r.e_at.toISOString(),
      })),
      users: targets.map(publicUser),
    };
  });

  // ================= automod =================

  app.get('/guilds/:id/automod', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_GUILD);
    const rows = await ctx.sql<RuleRow[]>`
      SELECT id, guild_id, name, enabled, trigger, actions, exempt_roles::text[] AS exempt_roles, exempt_channels::text[] AS exempt_channels, created_at
      FROM automod_rules WHERE guild_id = ${guildId} ORDER BY id`;
    return rows.map(ruleObj);
  });

  async function validateRule(guildId: string, rule: { actions?: AutomodRule['actions']; exemptRoles?: string[]; exemptChannels?: string[] }) {
    for (const a of rule.actions ?? []) {
      if (a.type === 'alert') {
        const [c] = await ctx.sql`SELECT 1 FROM channels WHERE id = ${a.channelId} AND guild_id = ${guildId} AND type = ${ChannelType.TEXT}`;
        if (!c) throw badRequest('Alert channel must be a text channel in this server');
      }
    }
    if (rule.exemptRoles?.length) {
      const r = await ctx.sql`SELECT id FROM roles WHERE guild_id = ${guildId} AND id = ANY(${rule.exemptRoles}::bigint[])`;
      if (r.length !== new Set(rule.exemptRoles).size) throw badRequest('Unknown exempt role');
    }
    if (rule.exemptChannels?.length) {
      const r = await ctx.sql`SELECT id FROM channels WHERE guild_id = ${guildId} AND id = ANY(${rule.exemptChannels}::bigint[])`;
      if (r.length !== new Set(rule.exemptChannels).size) throw badRequest('Unknown exempt channel');
    }
  }

  app.post('/guilds/:id/automod', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const body = parse(AutomodRuleSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_GUILD);
    const [{ count }] = (await ctx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM automod_rules WHERE guild_id = ${guildId}`) as unknown as [
      { count: number },
    ];
    if (count >= Limits.AUTOMOD_RULES_MAX) throw forbidden(`At most ${Limits.AUTOMOD_RULES_MAX} rules`);
    await validateRule(guildId, body);
    const id = snowflake();
    const [r] = await ctx.sql<RuleRow[]>`
      INSERT INTO automod_rules (id, guild_id, name, enabled, trigger, actions, exempt_roles, exempt_channels, creator_id)
      VALUES (${id}, ${guildId}, ${body.name}, ${body.enabled}, ${ctx.sql.json(body.trigger as never)}, ${ctx.sql.json(body.actions as never)},
              ${body.exemptRoles}::bigint[], ${body.exemptChannels}::bigint[], ${auth.userId})
      RETURNING id, guild_id, name, enabled, trigger, actions, exempt_roles::text[] AS exempt_roles, exempt_channels::text[] AS exempt_channels, created_at`;
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.AUTOMOD_RULE_CREATE, targetType: 'automod', targetId: id, changes: { name: body.name, trigger: body.trigger.type } });
    return ruleObj(r!);
  });

  app.patch('/guilds/:id/automod/:ruleId', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const ruleId = idParam(req, 'ruleId');
    await limitPreset(req, 'modAction');
    const p = parse(AutomodRulePatchSchema, req.body);
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_GUILD);
    await validateRule(guildId, p);
    const sets: Record<string, unknown> = {};
    if (p.name !== undefined) sets.name = p.name;
    if (p.enabled !== undefined) sets.enabled = p.enabled;
    if (p.trigger !== undefined) sets.trigger = ctx.sql.json(p.trigger as never);
    if (p.actions !== undefined) sets.actions = ctx.sql.json(p.actions as never);
    if (!Object.keys(sets).length && p.exemptRoles === undefined && p.exemptChannels === undefined) throw badRequest('Nothing to change');
    await ctx.sql.begin(async (tx) => {
      if (Object.keys(sets).length) await tx`UPDATE automod_rules SET ${tx(sets)} WHERE id = ${ruleId} AND guild_id = ${guildId}`;
      if (p.exemptRoles !== undefined) await tx`UPDATE automod_rules SET exempt_roles = ${p.exemptRoles}::bigint[] WHERE id = ${ruleId} AND guild_id = ${guildId}`;
      if (p.exemptChannels !== undefined) await tx`UPDATE automod_rules SET exempt_channels = ${p.exemptChannels}::bigint[] WHERE id = ${ruleId} AND guild_id = ${guildId}`;
    });
    const [r] = await ctx.sql<RuleRow[]>`
      SELECT id, guild_id, name, enabled, trigger, actions, exempt_roles::text[] AS exempt_roles, exempt_channels::text[] AS exempt_channels, created_at
      FROM automod_rules WHERE id = ${ruleId} AND guild_id = ${guildId}`;
    if (!r) throw notFound('Rule not found');
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.AUTOMOD_RULE_UPDATE, targetType: 'automod', targetId: ruleId, changes: { name: r.name } });
    return ruleObj(r);
  });

  app.delete('/guilds/:id/automod/:ruleId', async (req) => {
    const auth = requireAuth(req);
    const guildId = idParam(req, 'id');
    const ruleId = idParam(req, 'ruleId');
    await requireGuildPerm(ctx, guildId, auth.userId, P.MANAGE_GUILD);
    const [r] = await ctx.sql<{ name: string }[]>`DELETE FROM automod_rules WHERE id = ${ruleId} AND guild_id = ${guildId} RETURNING name`;
    if (!r) throw notFound('Rule not found');
    await audit(ctx.sql, { guildId, actorId: auth.userId, action: AuditAction.AUTOMOD_RULE_DELETE, targetType: 'automod', targetId: ruleId, changes: { name: r.name } });
    return { ok: true };
  });
}
