import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AdminInviteSchema, AdminUserPatchSchema, type AdminGuild, type AdminInvite, type AdminStats, type AdminUser } from '@haunt/shared';
import type { UserRow } from '../rows.js';
import type { Ctx } from '../context.js';
import { idParam, parse, requireAuth, strParam } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { publicUser, selfUser } from '../lib/serialize.js';
import { hashToken, revokeAllSessions } from '../auth/sessions.js';
import { inviteCode, randomToken } from '../ids.js';
import { disconnectVoice } from '../services/voice.js';
import { deleteGuild } from './guilds.js';

/**
 * Instance admin API. The first account on an instance is an admin; more can be added here or
 * with the CLI. The flag is re-read from the database on every request, never trusted from a cache.
 */
async function requireAdmin(ctx: Ctx, req: FastifyRequest): Promise<string> {
  const auth = requireAuth(req);
  const [u] = await ctx.sql<{ is_admin: boolean }[]>`SELECT is_admin FROM users WHERE id = ${auth.userId} AND NOT deleted AND NOT disabled`;
  if (!u?.is_admin) throw forbidden('Instance admins only');
  return auth.userId;
}

const pageOf = (req: FastifyRequest) => {
  const q = req.query as { q?: string; offset?: string };
  const search = String(q.q ?? '').trim().slice(0, 100);
  const offset = Math.max(0, Math.min(100_000, Number(q.offset ?? 0) || 0));
  return { search, offset };
};

/** Escape LIKE wildcards in user input. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export default async function adminRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/admin/stats', async (req): Promise<AdminStats> => {
    await requireAdmin(ctx, req);
    const [s] = await ctx.sql<{ users: number; disabled: number; servers: number; messages: number; files: number; bytes: string }[]>`
      SELECT (SELECT count(*) FROM users WHERE NOT deleted)::int AS users,
             (SELECT count(*) FROM users WHERE NOT deleted AND disabled)::int AS disabled,
             (SELECT count(*) FROM guilds)::int AS servers,
             (SELECT count(*) FROM messages)::int AS messages,
             (SELECT count(*) FROM files)::int AS files,
             (SELECT coalesce(sum(size), 0) FROM files)::text AS bytes`;
    return {
      users: s!.users,
      disabledUsers: s!.disabled,
      servers: s!.servers,
      messages: s!.messages,
      files: s!.files,
      fileBytes: Number(s!.bytes),
      registration: ctx.config.registration,
      emailEnabled: ctx.mailer.enabled,
      voiceEnabled: !!ctx.voice,
    };
  });

  // ---------- users ----------

  const adminUser = (u: UserRow & { server_count: number }): AdminUser => ({
    ...publicUser(u),
    email: u.email,
    emailVerified: u.email_verified,
    isAdmin: u.is_admin,
    disabled: u.disabled,
    createdAt: u.created_at.toISOString(),
    serverCount: u.server_count,
  });

  app.get('/admin/users', async (req): Promise<AdminUser[]> => {
    await requireAdmin(ctx, req);
    const { search, offset } = pageOf(req);
    const like = likeEscape(search.toLowerCase()) + '%';
    const rows = await ctx.sql<(UserRow & { server_count: number })[]>`
      SELECT u.*, (SELECT count(*) FROM guild_members m WHERE m.user_id = u.id)::int AS server_count
      FROM users u
      WHERE NOT u.deleted
        ${search ? ctx.sql`AND (u.username::text LIKE ${like} OR u.email::text LIKE ${like} OR u.id::text = ${search})` : ctx.sql``}
      ORDER BY u.id DESC LIMIT 50 OFFSET ${offset}`;
    return rows.map(adminUser);
  });

  app.patch('/admin/users/:id', async (req): Promise<AdminUser> => {
    const me = await requireAdmin(ctx, req);
    await limitPreset(req, 'modAction');
    const id = idParam(req, 'id');
    const p = parse(AdminUserPatchSchema, req.body);
    const [t] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${id} AND NOT deleted`;
    if (!t) throw notFound('User not found');

    if (p.disabled === true) {
      if (id === me) throw badRequest("You can't disable your own account");
      if (t.is_admin && p.isAdmin !== false) throw badRequest('Remove their admin rights first');
    }
    if (p.isAdmin === true && (p.disabled ?? t.disabled)) throw badRequest("Disabled accounts can't be admins");
    if (p.isAdmin === false && t.is_admin) {
      const [{ others }] = (await ctx.sql<{ others: number }[]>`
        SELECT count(*)::int AS others FROM users WHERE is_admin AND NOT disabled AND NOT deleted AND id <> ${id}`) as unknown as [{ others: number }];
      if (others === 0) throw badRequest('This is the last admin. Make someone else an admin first.');
    }

    const [u] = await ctx.sql<UserRow[]>`
      UPDATE users SET
        disabled = COALESCE(${p.disabled ?? null}::boolean, disabled),
        is_admin = COALESCE(${p.isAdmin ?? null}::boolean, is_admin)
      WHERE id = ${id} RETURNING *`;
    if (p.disabled === true && !t.disabled) {
      // log them out everywhere and drop them from voice
      await revokeAllSessions(ctx, id);
      await disconnectVoice(ctx, id).catch(() => {});
    }
    if (p.isAdmin !== undefined && p.isAdmin !== t.is_admin) ctx.bus.toUser(id, 'SELF_UPDATE', selfUser(u!));
    const [{ n }] = (await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM guild_members WHERE user_id = ${id}`) as unknown as [{ n: number }];
    return adminUser({ ...u!, server_count: n });
  });

  /** For instances without email: a one-time password reset link the admin passes on. */
  app.post('/admin/users/:id/reset-link', async (req) => {
    await requireAdmin(ctx, req);
    await limitPreset(req, 'modAction');
    const id = idParam(req, 'id');
    const [t] = await ctx.sql`SELECT 1 FROM users WHERE id = ${id} AND NOT deleted`;
    if (!t) throw notFound('User not found');
    const token = randomToken(32);
    const expires = new Date(Date.now() + 24 * 3600_000);
    await ctx.sql`
      INSERT INTO email_tokens (token_hash, user_id, kind, expires_at)
      VALUES (${hashToken(token)}, ${id}, 'reset', ${expires})`;
    return { url: `${ctx.config.publicUrl}/reset?token=${encodeURIComponent(token)}`, expiresAt: expires.toISOString() };
  });

  // ---------- sign-up invites (REGISTRATION=invite) ----------

  const listInvites = async (): Promise<AdminInvite[]> => {
    const rows = await ctx.sql<(UserRow & { code: string; max_uses: number; uses: number; inv_expires: Date | null; inv_created: Date; creator_exists: boolean })[]>`
      SELECT i.code, i.max_uses, i.uses, i.expires_at AS inv_expires, i.created_at AS inv_created, (u.id IS NOT NULL) AS creator_exists, u.*
      FROM instance_invites i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.expires_at IS NULL OR i.expires_at > now()
      ORDER BY i.created_at DESC LIMIT 200`;
    return rows.map((r) => ({
      code: r.code,
      maxUses: r.max_uses,
      uses: r.uses,
      expiresAt: r.inv_expires?.toISOString() ?? null,
      createdAt: r.inv_created.toISOString(),
      createdBy: r.creator_exists ? publicUser(r) : null,
    }));
  };

  app.get('/admin/invites', async (req) => {
    await requireAdmin(ctx, req);
    return listInvites();
  });

  app.post('/admin/invites', async (req) => {
    const me = await requireAdmin(ctx, req);
    await limitPreset(req, 'modAction');
    const body = parse(AdminInviteSchema, req.body ?? {});
    const code = inviteCode(12);
    await ctx.sql`
      INSERT INTO instance_invites (code, created_by, max_uses, expires_at)
      VALUES (${code}, ${me}, ${body.maxUses}, ${body.days > 0 ? new Date(Date.now() + body.days * 86400_000) : null})`;
    return { code, url: `${ctx.config.publicUrl}/register?code=${code}` };
  });

  app.delete('/admin/invites/:code', async (req) => {
    await requireAdmin(ctx, req);
    const code = strParam(req, 'code', 64);
    const rows = await ctx.sql`DELETE FROM instance_invites WHERE code = ${code} RETURNING code`;
    if (!rows.length) throw notFound('Invite not found');
    return { ok: true };
  });

  // ---------- servers ----------

  app.get('/admin/guilds', async (req): Promise<AdminGuild[]> => {
    await requireAdmin(ctx, req);
    const { search, offset } = pageOf(req);
    const like = '%' + likeEscape(search.toLowerCase()) + '%';
    const rows = await ctx.sql<(UserRow & { g_id: string; g_name: string; g_icon: string | null; g_created: Date; members: number; msgs: number; owner_exists: boolean })[]>`
      SELECT g.id AS g_id, g.name AS g_name, g.icon AS g_icon, g.created_at AS g_created,
             (SELECT count(*) FROM guild_members m WHERE m.guild_id = g.id)::int AS members,
             (SELECT count(*) FROM messages x WHERE x.guild_id = g.id)::int AS msgs,
             (u.id IS NOT NULL) AS owner_exists, u.*
      FROM guilds g LEFT JOIN users u ON u.id = g.owner_id
      WHERE true ${search ? ctx.sql`AND (lower(g.name) LIKE ${like} OR g.id::text = ${search})` : ctx.sql``}
      ORDER BY g.id DESC LIMIT 50 OFFSET ${offset}`;
    return rows.map((r) => ({
      id: r.g_id,
      name: r.g_name,
      icon: r.g_icon,
      owner: r.owner_exists ? publicUser(r) : null,
      memberCount: r.members,
      messageCount: r.msgs,
      createdAt: r.g_created.toISOString(),
    }));
  });

  /** Takedown: deletes the server and everything in it, same as the owner deleting it. */
  app.delete('/admin/guilds/:id', async (req) => {
    await requireAdmin(ctx, req);
    await limitPreset(req, 'modAction');
    await deleteGuild(ctx, idParam(req, 'id'));
    return { ok: true };
  });
}
