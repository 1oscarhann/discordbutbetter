import type { FastifyInstance } from 'fastify';
import {
  AuditAction,
  Limits,
  Permissions as P,
  RolePatchSchema,
  RolePositionsSchema,
  RoleSchema,
  canManageRole,
  missingForGrant,
  parsePermissions,
  permissionNames,
} from '@haunt/shared';
import type { RoleRow } from '../rows.js';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { guildAccess, requireGuildPerm, type GuildAccess } from '../lib/perms.js';
import { role as serRole } from '../lib/serialize.js';
import { audit } from '../lib/audit.js';
import { snowflake } from '../ids.js';
import type { Ctx } from '../context.js';

function assertCanGrant(a: GuildAccess, requested: bigint) {
  if (a.isOwner) return;
  const missing = missingForGrant(a.perms, requested);
  if (missing) throw forbidden(`You can't grant permissions you don't have: ${permissionNames(missing).join(', ')}`);
}

async function broadcastRoles(ctx: Ctx, guildId: string) {
  const roles = await ctx.sql<RoleRow[]>`SELECT * FROM roles WHERE guild_id = ${guildId} ORDER BY position`;
  for (const r of roles) ctx.bus.toGuild(guildId, 'GUILD_ROLE_UPDATE', serRole(r), { invalidate: true });
  ctx.bus.internalGuild(guildId, '_PERMS_CHANGED', { guildId });
}

export default async function roleRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.get('/guilds/:id/roles', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await guildAccess(ctx, id, auth.userId);
    const roles = await ctx.sql<RoleRow[]>`SELECT * FROM roles WHERE guild_id = ${id} ORDER BY position`;
    return roles.map(serRole);
  });

  app.post('/guilds/:id/roles', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const body = parse(RoleSchema, req.body);
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_ROLES);
    if (a.data.roles.size >= Limits.ROLES_PER_GUILD) throw forbidden(`A server can have at most ${Limits.ROLES_PER_GUILD} roles`);
    const perms = parsePermissions(body.permissions);
    assertCanGrant(a, perms);
    const roleId = snowflake();
    // new roles go to the bottom (just above @everyone)
    const [r] = await ctx.sql.begin(async (tx) => {
      await tx`UPDATE roles SET position = position + 1 WHERE guild_id = ${id} AND position >= 1`;
      return tx<RoleRow[]>`
        INSERT INTO roles (id, guild_id, name, color, hoist, mentionable, position, permissions)
        VALUES (${roleId}, ${id}, ${body.name}, ${body.color}, ${body.hoist}, ${body.mentionable}, 1, ${perms.toString()})
        RETURNING *`;
    });
    await audit(ctx.sql, {
      guildId: id,
      actorId: auth.userId,
      action: AuditAction.ROLE_CREATE,
      targetType: 'role',
      targetId: roleId,
      changes: { name: body.name, permissions: permissionNames(perms) },
    });
    ctx.bus.toGuild(id, 'GUILD_ROLE_CREATE', serRole(r!), { invalidate: true });
    await broadcastRoles(ctx, id);
    return serRole(r!);
  });

  app.patch('/guilds/:id/roles/:roleId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const roleId = idParam(req, 'roleId');
    await limitPreset(req, 'modAction');
    const p = parse(RolePatchSchema, req.body);
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_ROLES);
    const [old] = await ctx.sql<RoleRow[]>`SELECT * FROM roles WHERE id = ${roleId} AND guild_id = ${id}`;
    if (!old) throw notFound('Role not found');
    const isEveryone = roleId === id;
    if (!isEveryone && !canManageRole(a.highest, old.position, a.isOwner)) throw forbidden("You can't edit roles at or above your highest role");
    if (isEveryone && (p.name !== undefined || p.hoist !== undefined || p.mentionable !== undefined || p.color !== undefined)) {
      throw badRequest('@everyone can only have its permissions changed');
    }
    const sets: Record<string, unknown> = {};
    if (p.name !== undefined) sets.name = p.name;
    if (p.color !== undefined) sets.color = p.color;
    if (p.hoist !== undefined) sets.hoist = p.hoist;
    if (p.mentionable !== undefined) sets.mentionable = p.mentionable;
    if (p.permissions !== undefined) {
      const next = parsePermissions(p.permissions);
      const prev = BigInt(old.permissions);
      // you may only toggle bits you hold yourself (adding *or* removing)
      assertCanGrant(a, next ^ prev);
      sets.permissions = next.toString();
    }
    if (!Object.keys(sets).length) return serRole(old);
    const [r] = await ctx.sql<RoleRow[]>`UPDATE roles SET ${ctx.sql(sets)} WHERE id = ${roleId} RETURNING *`;
    const changes: Record<string, unknown> = { ...sets };
    if (sets.permissions) {
      const prev = BigInt(old.permissions);
      const next = BigInt(sets.permissions as string);
      changes.permissions = { added: permissionNames(next & ~prev), removed: permissionNames(prev & ~next) };
    }
    await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.ROLE_UPDATE, targetType: 'role', targetId: roleId, changes });
    ctx.bus.toGuild(id, 'GUILD_ROLE_UPDATE', serRole(r!), { invalidate: true });
    ctx.bus.internalGuild(id, '_PERMS_CHANGED', { guildId: id });
    return serRole(r!);
  });

  app.delete('/guilds/:id/roles/:roleId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const roleId = idParam(req, 'roleId');
    await limitPreset(req, 'modAction');
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_ROLES);
    if (roleId === id) throw badRequest("@everyone can't be deleted");
    const role = a.data.roles.get(roleId);
    if (!role) throw notFound('Role not found');
    if (!canManageRole(a.highest, role.position, a.isOwner)) throw forbidden("You can't delete roles at or above your highest role");
    await ctx.sql.begin(async (tx) => {
      await tx`DELETE FROM roles WHERE id = ${roleId}`;
      await tx`DELETE FROM permission_overwrites WHERE target_id = ${roleId} AND target_type = 0`;
      await tx`UPDATE roles SET position = position - 1 WHERE guild_id = ${id} AND position > ${role.position}`;
    });
    await audit(ctx.sql, { guildId: id, actorId: auth.userId, action: AuditAction.ROLE_DELETE, targetType: 'role', targetId: roleId, changes: { name: role.name } });
    ctx.bus.toGuild(id, 'GUILD_ROLE_DELETE', { guildId: id, roleId }, { invalidate: true });
    await broadcastRoles(ctx, id);
    return { ok: true };
  });

  app.patch('/guilds/:id/roles', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await limitPreset(req, 'modAction');
    const moves = parse(RolePositionsSchema, req.body);
    const a = await requireGuildPerm(ctx, id, auth.userId, P.MANAGE_ROLES);
    const roles = [...a.data.roles.values()].filter((r) => r.id !== id);
    const wanted = new Map(moves.map((m) => [m.id, m.position]));
    for (const m of moves) {
      const r = a.data.roles.get(m.id);
      if (!r || m.id === id) throw badRequest('Unknown role');
      if (!a.isOwner && (r.position >= a.highest || m.position >= a.highest)) {
        throw forbidden("You can't move roles at or above your highest role");
      }
    }
    // apply, then renumber 1..n keeping the requested order
    const ordered = roles
      .map((r) => ({ id: r.id, pos: wanted.get(r.id) ?? r.position, moved: wanted.has(r.id) }))
      .sort((x, y) => x.pos - y.pos || (x.moved === y.moved ? 0 : x.moved ? 1 : -1));
    // roles above the actor must keep their positions relative to everything
    if (!a.isOwner) {
      const above = roles.filter((r) => r.position >= a.highest).map((r) => r.id);
      const before = roles.sort((x, y) => x.position - y.position).map((r) => r.id).filter((r) => above.includes(r));
      const after = ordered.map((r) => r.id).filter((r) => above.includes(r));
      if (before.join() !== after.join()) throw forbidden("You can't move roles at or above your highest role");
    }
    await ctx.sql.begin(async (tx) => {
      let i = 1;
      for (const r of ordered) await tx`UPDATE roles SET position = ${i++} WHERE id = ${r.id}`;
    });
    await broadcastRoles(ctx, id);
    const out = await ctx.sql<RoleRow[]>`SELECT * FROM roles WHERE guild_id = ${id} ORDER BY position`;
    return out.map(serRole);
  });
}
