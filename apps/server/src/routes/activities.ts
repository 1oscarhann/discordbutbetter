import type { FastifyInstance } from 'fastify';
import {
  ChannelType,
  CreateGameSchema,
  GAMES,
  GameMoveSchema,
  MessageType,
  Permissions as P,
  VoiceStatePatchSchema,
  WatchControlSchema,
  anagramCatchUp,
  has,
  isDmType,
  youtubeId,
  youtubeStart,
  type GameSession,
  type GameState,
  type WatchState,
  type AnagramData,
} from '@haunt/shared';
import type { UserRow } from '../rows.js';
import { idParam, parse, requireAuth } from '../lib/validate.js';
import { limitPreset } from '../lib/ratelimit.js';
import { badRequest, forbidden, notFound, unavailable } from '../errors.js';
import { channelAccess, type ChannelAccess } from '../lib/perms.js';
import { publicUser } from '../lib/serialize.js';
import { toChannel } from '../lib/fanout.js';
import { snowflake } from '../ids.js';
import { safeFetch } from '../lib/safefetch.js';
import { insertSystemMessage } from '../services/messages.js';
import {
  channelFromRoom,
  clearVoiceState,
  disconnectVoice,
  getServerMod,
  getUserVoice,
  participantsIn,
  roomName,
  setVoiceState,
} from '../services/voice.js';
import type { Ctx } from '../context.js';

// ============ watch together state ============

const WATCH_TTL = 12 * 3600;

async function getWatch(ctx: Ctx, channelId: string): Promise<WatchState | null> {
  const raw = await ctx.redis.get(`watch:${channelId}`);
  return raw ? (JSON.parse(raw) as WatchState) : null;
}

async function putWatch(ctx: Ctx, a: ChannelAccess, s: WatchState | null) {
  if (s) await ctx.redis.set(`watch:${s.channelId}`, JSON.stringify(s), 'EX', WATCH_TTL);
  else await ctx.redis.del(`watch:${a.channel.id}`);
  const out: WatchState = s ?? {
    channelId: a.channel.id,
    videoId: null,
    title: null,
    playing: false,
    position: 0,
    updatedAt: Date.now(),
    rate: 1,
    queue: [],
    controller: null,
  };
  await toChannel(ctx, a.channel, 'WATCH_STATE', out);
}

function currentPosition(s: WatchState, now = Date.now()): number {
  return s.playing ? s.position + ((now - s.updatedAt) / 1000) * s.rate : s.position;
}

async function youtubeTitle(ctx: Ctx, videoId: string): Promise<string> {
  const key = `yttitle:${videoId}`;
  const cached = await ctx.redis.get(key);
  if (cached) return cached;
  try {
    const r = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, {
      maxBytes: 64 * 1024,
      accept: 'application/json',
      userAgent: `Mozilla/5.0 (compatible; ${ctx.config.appName}/1.0)`,
      timeoutMs: 4000,
    });
    if (r.status === 200) {
      const t = String((JSON.parse(r.body.toString('utf8')) as { title?: string }).title ?? '').slice(0, 200);
      if (t) {
        await ctx.redis.set(key, t, 'EX', 86400 * 7);
        return t;
      }
    }
  } catch {
    /* fall through */
  }
  return 'YouTube video';
}

// ============ games state ============

interface StoredGame {
  id: string;
  kind: GameSession['kind'];
  channelId: string;
  guildId: string | null;
  createdAt: number;
  updatedAt: number;
  state: GameState;
}

const GAME_TTL = 24 * 3600;

async function getGame(ctx: Ctx, id: string): Promise<StoredGame | null> {
  const raw = await ctx.redis.get(`game:${id}`);
  return raw ? (JSON.parse(raw) as StoredGame) : null;
}

async function sessionFor(ctx: Ctx, g: StoredGame, viewerId: string): Promise<GameSession> {
  const users = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ANY(${g.state.players}::bigint[])`;
  const byId = new Map(users.map((u) => [u.id, publicUser(u)]));
  const def = GAMES[g.kind];
  return {
    id: g.id,
    kind: g.kind,
    channelId: g.channelId,
    hostId: g.state.hostId,
    players: g.state.players.map((p) => byId.get(p)).filter((u): u is NonNullable<typeof u> => !!u),
    status: g.state.status,
    view: {
      ...(def.view(g.state, viewerId, Date.now()) as object),
      winners: g.state.winners,
      draw: g.state.draw,
    },
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

async function publishGame(ctx: Ctx, a: ChannelAccess, g: StoredGame) {
  // everyone gets the public view; the host gets their own (hangman: they can see the word) right after
  const pub = await sessionFor(ctx, g, '0');
  await toChannel(ctx, a.channel, 'GAME_UPDATE', pub, { recipients: a.recipients });
  const hostView = await sessionFor(ctx, g, g.state.hostId);
  if (JSON.stringify(hostView.view) !== JSON.stringify(pub.view)) ctx.bus.toUser(g.state.hostId, 'GAME_UPDATE', hostView);
}

async function saveGame(ctx: Ctx, g: StoredGame) {
  const ttl = g.state.status === 'finished' ? 600 : GAME_TTL;
  await ctx.redis.set(`game:${g.id}`, JSON.stringify(g), 'EX', ttl);
}

async function withGameLock<T>(ctx: Ctx, id: string, fn: () => Promise<T>): Promise<T> {
  const key = `glock:${id}`;
  for (let i = 0; i < 20; i++) {
    if ((await ctx.redis.set(key, '1', 'PX', 3000, 'NX')) === 'OK') {
      try {
        return await fn();
      } finally {
        await ctx.redis.del(key);
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw unavailable('Game is busy, try again');
}

/** For voice channels you must be in the call to play; DMs: any member. */
async function activityAccess(ctx: Ctx, channelId: string, userId: string, mustBeInVoice: boolean): Promise<ChannelAccess> {
  const a = await channelAccess(ctx, channelId, userId);
  if (!isDmType(a.channel.type) && a.channel.type !== ChannelType.VOICE) throw badRequest('Activities run in DMs and voice channels');
  if (!has(a.perms, P.USE_ACTIVITIES)) throw forbidden("You can't start activities here");
  if (mustBeInVoice && a.channel.type === ChannelType.VOICE) {
    const vs = await getUserVoice(ctx, userId);
    if (vs?.channelId !== channelId) throw forbidden('Join the voice channel first');
  }
  return a;
}

/** Called when someone leaves a voice channel: clean up activities if it's now empty. */
export async function afterVoiceLeave(ctx: Ctx, guildId: string, channelId: string) {
  const left = await participantsIn(ctx, guildId, channelId);
  if (left.length) return;
  await ctx.redis.del(`watch:${channelId}`);
  const ids = await ctx.redis.smembers(`games:${channelId}`);
  for (const id of ids) await ctx.redis.del(`game:${id}`);
  await ctx.redis.del(`games:${channelId}`);
}

export default async function activityRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // ================= voice =================

  app.post('/channels/:id/voice/join', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'watch');
    if (!ctx.voice) throw unavailable('Voice is not set up on this server');
    const channelId = idParam(req, 'id');
    const a = await channelAccess(ctx, channelId, auth.userId);
    if (a.channel.type !== ChannelType.VOICE || !a.guild) throw badRequest('Not a voice channel');
    const moved = (await ctx.redis.get(`vmove:${auth.userId}`)) === channelId;
    if (!moved && !has(a.perms, P.CONNECT)) throw forbidden("You can't join this voice channel");
    const here = await participantsIn(ctx, a.guild.data.guild.id, channelId);
    if (a.channel.user_limit > 0 && !moved && !has(a.perms, P.MOVE_MEMBERS) && here.filter((p) => p.userId !== auth.userId).length >= a.channel.user_limit) {
      throw forbidden('This voice channel is full');
    }
    if (moved) await ctx.redis.del(`vmove:${auth.userId}`);

    const prev = await getUserVoice(ctx, auth.userId);
    if (prev && prev.channelId !== channelId) {
      await disconnectVoice(ctx, auth.userId);
      await afterVoiceLeave(ctx, prev.guildId, prev.channelId);
    }
    const mod = await getServerMod(ctx, a.guild.data.guild.id, auth.userId);
    const [u] = await ctx.sql<UserRow[]>`SELECT * FROM users WHERE id = ${auth.userId}`;
    const canSpeak = (has(a.perms, P.SPEAK) || moved) && !mod.mute;
    const canStream = has(a.perms, P.STREAM);
    const token = await ctx.voice.token({
      room: roomName(channelId),
      identity: auth.userId,
      name: u?.display_name || u?.username || 'user',
      canSpeak,
      canStream,
      canSubscribe: !mod.deaf,
      metadata: JSON.stringify({ guildId: a.guild.data.guild.id }),
    });
    await setVoiceState(ctx, {
      guildId: a.guild.data.guild.id,
      channelId,
      userId: auth.userId,
      selfMute: prev?.channelId === channelId ? prev.selfMute : false,
      selfDeaf: prev?.channelId === channelId ? prev.selfDeaf : false,
      serverMute: mod.mute,
      serverDeaf: mod.deaf,
      video: false,
      streaming: false,
      ...({ t: Date.now() } as object),
    });
    return { token, url: ctx.voice.url, room: roomName(channelId), canSpeak, canStream };
  });

  app.post('/voice/leave', async (req) => {
    const auth = requireAuth(req);
    const vs = await disconnectVoice(ctx, auth.userId);
    if (vs) await afterVoiceLeave(ctx, vs.guildId, vs.channelId);
    return { ok: true };
  });

  app.patch('/voice/state', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'watch');
    const p = parse(VoiceStatePatchSchema, req.body);
    const vs = await getUserVoice(ctx, auth.userId);
    if (!vs) throw badRequest("You're not in a voice channel");
    if (p.video || p.streaming) {
      const a = await channelAccess(ctx, vs.channelId, auth.userId);
      if (!has(a.perms, P.STREAM)) throw forbidden("You can't share video here");
    }
    const next = {
      ...vs,
      selfMute: p.selfMute ?? vs.selfMute,
      selfDeaf: p.selfDeaf ?? vs.selfDeaf,
      video: p.video ?? vs.video,
      streaming: p.streaming ?? vs.streaming,
    };
    await setVoiceState(ctx, next);
    return next;
  });

  // LiveKit tells us who actually joined/left. Signed with our API secret.
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post('/livekit/webhook', async (req, reply) => {
    if (!ctx.voice) return reply.code(404).send();
    let ev;
    try {
      ev = await ctx.voice.webhook.receive(String(req.body ?? ''), req.headers.authorization);
    } catch {
      return reply.code(401).send({ error: 'bad signature' });
    }
    const channelId = ev.room?.name ? channelFromRoom(ev.room.name) : null;
    if (!channelId) return { ok: true };
    const [c] = await ctx.sql<{ guild_id: string | null }[]>`SELECT guild_id FROM channels WHERE id = ${channelId}`;
    if (!c?.guild_id) return { ok: true };
    const userId = ev.participant?.identity;
    if (ev.event === 'participant_left' && userId && /^\d+$/.test(userId)) {
      if (await clearVoiceState(ctx, c.guild_id, userId, channelId)) await afterVoiceLeave(ctx, c.guild_id, channelId);
    } else if (ev.event === 'participant_joined' && userId && /^\d+$/.test(userId)) {
      const vs = await getUserVoice(ctx, userId);
      if (!vs || vs.channelId !== channelId) {
        const mod = await getServerMod(ctx, c.guild_id, userId);
        await setVoiceState(ctx, {
          guildId: c.guild_id,
          channelId,
          userId,
          selfMute: false,
          selfDeaf: false,
          serverMute: mod.mute,
          serverDeaf: mod.deaf,
          video: false,
          streaming: false,
          ...({ t: Date.now() } as object),
        });
      }
    } else if (ev.event === 'room_finished') {
      for (const vs of await participantsIn(ctx, c.guild_id, channelId)) await clearVoiceState(ctx, c.guild_id, vs.userId, channelId);
      await afterVoiceLeave(ctx, c.guild_id, channelId);
    }
    return { ok: true };
  });

  // ================= watch together =================

  app.get('/channels/:id/watch', async (req) => {
    const auth = requireAuth(req);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    if (a.channel.type !== ChannelType.VOICE) throw badRequest('Watch together runs in voice channels');
    return (await getWatch(ctx, a.channel.id)) ?? null;
  });

  app.post('/channels/:id/watch', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'watch');
    const body = parse(WatchControlSchema, req.body);
    const channelId = idParam(req, 'id');
    const a = await activityAccess(ctx, channelId, auth.userId, true);
    if (a.channel.type !== ChannelType.VOICE) throw badRequest('Watch together runs in voice channels');
    const now = Date.now();
    let s = await getWatch(ctx, channelId);

    const load = async (videoId: string, title: string, start: number): Promise<WatchState> => ({
      channelId,
      videoId,
      title,
      playing: true,
      position: start,
      updatedAt: now,
      rate: s?.rate ?? 1,
      queue: s?.queue ?? [],
      controller: auth.userId,
    });

    switch (body.action) {
      case 'load': {
        const vid = youtubeId(body.url);
        if (!vid) throw badRequest('Paste a YouTube link');
        s = await load(vid, await youtubeTitle(ctx, vid), youtubeStart(body.url));
        await insertSystemMessage(ctx, a.channel, MessageType.WATCH_TOGETHER, auth.userId, { videoId: vid, title: s.title });
        break;
      }
      case 'queue_add': {
        const vid = youtubeId(body.url);
        if (!vid) throw badRequest('Paste a YouTube link');
        const title = await youtubeTitle(ctx, vid);
        if (!s?.videoId) s = await load(vid, title, youtubeStart(body.url));
        else {
          if (s.queue.length >= 50) throw forbidden('Queue is full');
          s.queue.push({ videoId: vid, title, addedBy: auth.userId });
        }
        break;
      }
      case 'queue_remove':
        if (!s) throw notFound('Nothing playing');
        s.queue.splice(body.index, 1);
        break;
      case 'next':
      case 'ended': {
        if (!s) throw notFound('Nothing playing');
        if (body.action === 'ended' && body.videoId !== s.videoId) return s; // someone else already advanced
        const nxt = s.queue.shift();
        if (nxt) s = { ...s, videoId: nxt.videoId, title: nxt.title, playing: true, position: 0, updatedAt: now, controller: auth.userId };
        else s = { ...s, playing: false, position: currentPosition(s, now), updatedAt: now };
        break;
      }
      case 'play':
        if (!s?.videoId) throw notFound('Nothing loaded');
        s = { ...s, playing: true, position: body.position, updatedAt: now, controller: auth.userId };
        break;
      case 'pause':
        if (!s?.videoId) throw notFound('Nothing loaded');
        s = { ...s, playing: false, position: body.position, updatedAt: now, controller: auth.userId };
        break;
      case 'seek':
        if (!s?.videoId) throw notFound('Nothing loaded');
        s = { ...s, position: body.position, updatedAt: now, controller: auth.userId };
        break;
      case 'rate':
        if (!s?.videoId) throw notFound('Nothing loaded');
        s = { ...s, position: currentPosition(s, now), updatedAt: now, rate: body.rate, controller: auth.userId };
        break;
      case 'stop':
        s = null;
        break;
    }
    await putWatch(ctx, a, s);
    return s;
  });

  // ================= mini games =================

  app.get('/channels/:id/games', async (req) => {
    const auth = requireAuth(req);
    const a = await channelAccess(ctx, idParam(req, 'id'), auth.userId);
    const ids = await ctx.redis.smembers(`games:${a.channel.id}`);
    const out: GameSession[] = [];
    for (const id of ids) {
      const g = await getGame(ctx, id);
      if (!g) {
        await ctx.redis.srem(`games:${a.channel.id}`, id);
        continue;
      }
      out.push(await sessionFor(ctx, g, auth.userId));
    }
    return out.sort((x, y) => y.createdAt - x.createdAt);
  });

  app.post('/channels/:id/games', async (req) => {
    const auth = requireAuth(req);
    await limitPreset(req, 'game');
    const body = parse(CreateGameSchema, req.body);
    const a = await activityAccess(ctx, idParam(req, 'id'), auth.userId, true);
    const active = await ctx.redis.smembers(`games:${a.channel.id}`);
    let live = 0;
    for (const id of active) if (await ctx.redis.exists(`game:${id}`)) live++;
    if (live >= 5) throw forbidden('Too many games running here — finish one first');
    const def = GAMES[body.kind];
    const created = def.create(auth.userId, body.options, Math.random, Date.now());
    if (!created.ok) throw badRequest(created.error);
    const g: StoredGame = {
      id: snowflake(),
      kind: body.kind,
      channelId: a.channel.id,
      guildId: a.channel.guild_id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: created.state,
    };
    await saveGame(ctx, g);
    await ctx.redis.sadd(`games:${a.channel.id}`, g.id);
    await ctx.redis.expire(`games:${a.channel.id}`, GAME_TTL);
    await publishGame(ctx, a, g);
    await insertSystemMessage(ctx, a.channel, MessageType.GAME, auth.userId, { gameId: g.id, kind: g.kind, name: def.name });
    return sessionFor(ctx, g, auth.userId);
  });

  app.get('/games/:id', async (req) => {
    const auth = requireAuth(req);
    const g = await getGame(ctx, idParam(req, 'id'));
    if (!g) throw notFound('That game is over');
    await channelAccess(ctx, g.channelId, auth.userId);
    if (g.kind === 'anagram' && anagramCatchUp(g.state as GameState<AnagramData>, Math.random, Date.now())) await saveGame(ctx, g);
    return sessionFor(ctx, g, auth.userId);
  });

  const act = (action: 'join' | 'move' | 'leave') =>
    async function (req: import('fastify').FastifyRequest) {
      const auth = requireAuth(req);
      await limitPreset(req, 'game');
      const id = idParam(req, 'id');
      const move = action === 'move' ? parse(GameMoveSchema, req.body).move : null;
      return withGameLock(ctx, id, async () => {
        const g = await getGame(ctx, id);
        if (!g) throw notFound('That game is over');
        const a = await activityAccess(ctx, g.channelId, auth.userId, action !== 'leave');
        const def = GAMES[g.kind];
        const now = Date.now();
        let next: GameState;
        if (action === 'join') {
          const r = def.join(g.state, auth.userId, Math.random, now);
          if (!r.ok) throw badRequest(r.error);
          next = r.state;
        } else if (action === 'move') {
          const r = def.move(g.state, auth.userId, move, Math.random, now);
          if (!r.ok) throw badRequest(r.error);
          next = r.state;
        } else {
          if (!g.state.players.includes(auth.userId)) throw badRequest("You're not in this game");
          next = structuredClone(g.state);
          if (auth.userId === next.hostId && next.status === 'lobby') {
            await ctx.redis.del(`game:${id}`);
            await ctx.redis.srem(`games:${g.channelId}`, id);
            await toChannel(ctx, a.channel, 'GAME_DELETE', { id, channelId: g.channelId }, { recipients: a.recipients });
            return { ok: true };
          }
          next.players = next.players.filter((p) => p !== auth.userId);
          if (next.status === 'playing' && def.maxPlayers === 2) {
            // forfeit
            next.status = 'finished';
            next.winners = next.players;
          } else if (next.status === 'playing' && (auth.userId === next.hostId || next.players.length === 0)) {
            next.status = 'finished';
          }
        }
        g.state = next;
        g.updatedAt = now;
        await saveGame(ctx, g);
        await publishGame(ctx, a, g);
        return sessionFor(ctx, g, auth.userId);
      });
    };

  app.post('/games/:id/join', act('join'));
  app.post('/games/:id/move', act('move'));
  app.post('/games/:id/leave', act('leave'));
}
