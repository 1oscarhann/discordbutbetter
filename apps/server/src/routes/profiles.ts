import type { FastifyInstance } from 'fastify';
import {
  GuestbookPostSchema,
  ProfilePatchSchema,
  RelationshipType,
  youtubeId,
  youtubeStart,
  type ProfileSong,
  type ProfileWidget,
  type UserProfile,
  type RelationshipTypeValue,
} from '@dbb/shared';
import type { UserRow } from '../rows.js';
import { parse, requireAuth, idParam } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { forbidden, notFound } from '../errors.js';
import { publicUser, selfUser } from '../lib/serialize.js';
import { broadcastUserUpdate, isBlockedEitherWay, isConnected, isFriend } from '../lib/audience.js';
import { AssetDiff, urlsIn } from '../lib/assets.js';
import { buildPresence, canSeeLastSeen, visibleStatus } from '../lib/presence.js';
import { snowflake } from '../ids.js';
import { claimFile, deleteFile, fileIdFromUrl, fileUrl } from './files.js';

export default async function profileRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.patch('/users/@me/profile', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'profile');
    const p = parse(ProfilePatchSchema, req.body);
    const [u0] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${auth.userId}`;
    if (!u0) throw notFound();

    const sets: Record<string, unknown> = {};
    const oldFilesToDelete: (string | null)[] = [];

    if (p.displayName !== undefined) sets.display_name = p.displayName || null;
    if (p.bio !== undefined) sets.bio = p.bio;
    if (p.pronouns !== undefined) sets.pronouns = p.pronouns;
    if (p.links !== undefined) sets.links = ctx.sql.json(p.links);
    if (p.theme !== undefined) sets.profile_theme = ctx.sql.json(p.theme);
    if (p.guestbookEnabled !== undefined) sets.guestbook_enabled = p.guestbookEnabled;

    if (p.avatarFileId !== undefined && p.avatarFileId !== fileIdFromUrl(u0.avatar)) {
      sets.avatar = p.avatarFileId ? fileUrl(await claimFile(ctx, p.avatarFileId, auth.userId, ['avatar'])) : null;
      oldFilesToDelete.push(u0.avatar);
    }
    if (p.bannerFileId !== undefined && p.bannerFileId !== fileIdFromUrl(u0.banner)) {
      if (p.bannerFileId) {
        const f = await claimFile(ctx, p.bannerFileId, auth.userId, ['banner']);
        sets.banner = fileUrl(f);
        sets.banner_kind = f.content_type.startsWith('video/') ? 'video' : 'image';
      } else {
        sets.banner = null;
        sets.banner_kind = null;
      }
      oldFilesToDelete.push(u0.banner);
    }

    let widgetDiff: AssetDiff | null = null;
    if (p.widgets !== undefined) {
      widgetDiff = new AssetDiff(ctx, auth.userId, urlsIn(u0.widgets));
      const out: ProfileWidget[] = [];
      for (const w of p.widgets) {
        switch (w.type) {
          case 'games':
            out.push({ id: w.id, type: 'games', title: w.title, items: await Promise.all(w.items.map((g) => widgetDiff!.gameRef(g))) });
            break;
          case 'songs':
            out.push({ id: w.id, type: 'songs', title: w.title, items: await Promise.all(w.items.map((s) => widgetDiff!.songRef(s))) });
            break;
          case 'photos': {
            const items = [];
            for (const it of w.items) items.push({ url: await widgetDiff.use(it.fileId, ['widget_photo']), caption: it.caption });
            out.push({ id: w.id, type: 'photos', title: w.title, items });
            break;
          }
          case 'currently_into':
            out.push({ id: w.id, type: 'currently_into', title: w.title, items: w.items });
            break;
          case 'text':
            out.push({ id: w.id, type: 'text', title: w.title, content: w.content });
            break;
        }
      }
      sets.widgets = ctx.sql.json(out as never);
    }

    if (p.song !== undefined) {
      const old = u0.profile_song as ProfileSong | null;
      let song: ProfileSong | null = null;
      if (p.song?.kind === 'upload') {
        const keep = old?.kind === 'upload' && fileIdFromUrl(old.url) === p.song.fileId;
        if (keep) song = { ...old, title: p.song.title };
        else {
          const f = await claimFile(ctx, p.song.fileId, auth.userId, ['profile_song']);
          song = { kind: 'upload', url: fileUrl(f), title: p.song.title, durationMs: f.duration_ms ?? undefined };
          if (old?.kind === 'upload') oldFilesToDelete.push(old.url);
        }
      } else if (p.song?.kind === 'youtube') {
        song = { kind: 'youtube', videoId: youtubeId(p.song.url)!, title: p.song.title, start: youtubeStart(p.song.url) };
        if (old?.kind === 'upload') oldFilesToDelete.push(old.url);
      } else if (old?.kind === 'upload') {
        oldFilesToDelete.push(old.url);
      }
      sets.profile_song = song ? ctx.sql.json(song as never) : null;
    }

    if (!Object.keys(sets).length) return selfUser(u0);
    const [u] = await ctx.sql<UserRow[]>`UPDATE users SET ${ctx.sql(sets)} WHERE id = ${auth.userId} RETURNING *`;
    await widgetDiff?.commit();
    for (const f of oldFilesToDelete) await deleteFile(ctx, f);

    ctx.bus.toUser(auth.userId, 'SELF_UPDATE', selfUser(u!));
    if ('display_name' in sets || 'avatar' in sets) await broadcastUserUpdate(ctx, u!);
    return { ...selfUser(u!), profile: await buildProfile(u!, auth.userId, null) };
  });

  async function buildProfile(u: UserRow, viewerId: string, guildId: string | null): Promise<UserProfile> {
    const [rel] = await ctx.sql<{ type: number }[]>`SELECT type FROM relationships WHERE user_id = ${viewerId} AND target_id = ${u.id}`;
    const friend = rel?.type === RelationshipType.FRIEND;
    const mutualGuilds = await ctx.sql<{ guild_id: string }[]>`
      SELECT a.guild_id FROM guild_members a JOIN guild_members b ON a.guild_id = b.guild_id
      WHERE a.user_id = ${viewerId} AND b.user_id = ${u.id}`;
    const mutualFriends =
      viewerId === u.id
        ? []
        : await ctx.sql<UserRow[]>`
          SELECT x.* FROM relationships a JOIN relationships b ON a.target_id = b.target_id
          JOIN users x ON x.id = a.target_id
          WHERE a.user_id = ${viewerId} AND b.user_id = ${u.id} AND a.type = 1 AND b.type = 1 LIMIT 50`;
    let member: UserProfile['member'] = null;
    if (guildId && mutualGuilds.some((g) => g.guild_id === guildId)) {
      const [m] = await ctx.sql<{ nickname: string | null; avatar: string | null; bio: string; joined_at: Date; roles: string[] | null }[]>`
        SELECT m.nickname, m.avatar, m.bio, m.joined_at,
          (SELECT array_agg(role_id::text) FROM member_roles r WHERE r.guild_id = m.guild_id AND r.user_id = m.user_id) AS roles
        FROM guild_members m WHERE m.guild_id = ${guildId} AND m.user_id = ${u.id}`;
      if (m) member = { nickname: m.nickname, avatar: m.avatar, bio: m.bio, joinedAt: m.joined_at.toISOString(), roles: m.roles ?? [] };
    }
    const status = await visibleStatus(ctx, u);
    return {
      ...publicUser(u),
      banner: u.banner,
      bannerKind: u.banner_kind,
      bio: u.bio,
      pronouns: u.pronouns,
      links: (u.links as UserProfile['links']) ?? [],
      theme: (u.profile_theme as UserProfile['theme']) ?? {},
      widgets: (u.widgets as UserProfile['widgets']) ?? [],
      song: (u.profile_song as UserProfile['song']) ?? null,
      guestbookEnabled: u.guestbook_enabled,
      createdAt: u.created_at.toISOString(),
      member,
      mutualGuilds: mutualGuilds.map((g) => g.guild_id),
      mutualFriends: mutualFriends.map(publicUser),
      relationship: (rel?.type as RelationshipTypeValue | undefined) ?? null,
      presence: buildPresence(u, status, { canSeeLastSeen: canSeeLastSeen(u, viewerId, friend) }),
    };
  }

  app.get('/users/:id/profile', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const guildId = (req.query as { guildId?: string }).guildId;
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
    if (!u) throw notFound('User not found');
    // only people you share something with (or who sent you a request) can see your profile
    if (!(await isConnected(ctx, auth.userId, id))) throw notFound('User not found');
    if (u.deleted) {
      return { ...publicUser(u), banner: null, bannerKind: null, bio: '', pronouns: '', links: [], theme: {}, widgets: [], song: null, guestbookEnabled: false, createdAt: u.created_at.toISOString(), member: null, mutualGuilds: [], mutualFriends: [], relationship: null, presence: { userId: u.id, status: 'offline', customStatus: null, playing: null, listening: null, lastSeenAt: null } } satisfies UserProfile;
    }
    return buildProfile(u, auth.userId, guildId && /^\d{1,20}$/.test(guildId) ? guildId : null);
  });

  // ---------- guestbook ----------

  app.get('/users/:id/guestbook', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
    if (!u || !(await isConnected(ctx, auth.userId, id))) throw notFound('User not found');
    if (!u.guestbook_enabled && u.id !== auth.userId) return { enabled: false, entries: [] };
    const before = (req.query as { before?: string }).before;
    const rows = await ctx.sql<(UserRow & { entry_id: string; content_text: string; entry_created: Date })[]>`
      SELECT e.id AS entry_id, e.content AS content_text, e.created_at AS entry_created, a.*
      FROM guestbook_entries e JOIN users a ON a.id = e.author_id
      WHERE e.profile_id = ${id} ${before && /^\d{1,20}$/.test(before) ? ctx.sql`AND e.id < ${before}` : ctx.sql``}
      ORDER BY e.id DESC LIMIT 30`;
    return {
      enabled: u.guestbook_enabled,
      entries: rows.map((r) => ({ id: r.entry_id, author: publicUser(r), content: r.content_text, createdAt: r.entry_created.toISOString() })),
    };
  });

  app.post('/users/:id/guestbook', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    await limitPreset(req, 'guestbook');
    const { content } = parse(GuestbookPostSchema, req.body);
    if (id === auth.userId) throw forbidden("You can't sign your own guestbook");
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
    if (!u || u.deleted) throw notFound('User not found');
    if (!u.guestbook_enabled) throw forbidden('Their guestbook is turned off');
    if (!(await isFriend(ctx, id, auth.userId))) throw forbidden('Only friends can sign a guestbook');
    if (await isBlockedEitherWay(ctx, id, auth.userId)) throw forbidden();
    const entryId = snowflake();
    await ctx.sql`INSERT INTO guestbook_entries (id, profile_id, author_id, content) VALUES (${entryId}, ${id}, ${auth.userId}, ${content})`;
    // keep guestbooks bounded
    await ctx.sql`
      DELETE FROM guestbook_entries WHERE profile_id = ${id} AND id IN (
        SELECT id FROM guestbook_entries WHERE profile_id = ${id} ORDER BY id DESC OFFSET 500)`;
    const [a] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${auth.userId}`;
    return { id: entryId, author: publicUser(a!), content, createdAt: new Date().toISOString() };
  });

  app.delete('/users/:id/guestbook/:entryId', async (req) => {
    const auth = requireAuth(req);
    const id = idParam(req, 'id');
    const entryId = idParam(req, 'entryId');
    // the profile owner can delete anything on their guestbook; authors can delete their own entries
    const rows = await ctx.sql`
      DELETE FROM guestbook_entries WHERE id = ${entryId} AND profile_id = ${id}
        AND (profile_id = ${auth.userId} OR author_id = ${auth.userId})
      RETURNING id`;
    if (!rows.length) throw notFound('Entry not found');
    return { ok: true };
  });
}
