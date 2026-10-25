import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import type { VoiceState } from '@dbb/shared';
import type { Config } from '../config.js';
import type { Ctx } from '../context.js';

export interface Voice {
  /** Public LiveKit URL clients connect to. */
  url: string;
  rooms: RoomServiceClient;
  webhook: WebhookReceiver;
  token(p: { room: string; identity: string; name: string; canSpeak: boolean; canStream: boolean; canSubscribe: boolean; metadata: string }): Promise<string>;
}

export function createVoice(config: Config): Voice | null {
  const lk = config.livekit;
  if (!lk) return null;
  return {
    url: lk.url,
    rooms: new RoomServiceClient(lk.internalUrl, lk.apiKey, lk.apiSecret),
    webhook: new WebhookReceiver(lk.apiKey, lk.apiSecret),
    async token(p) {
      const at = new AccessToken(lk.apiKey, lk.apiSecret, { identity: p.identity, name: p.name, ttl: '6h', metadata: p.metadata });
      at.addGrant({
        room: p.room,
        roomJoin: true,
        canSubscribe: p.canSubscribe,
        canPublish: p.canSpeak || p.canStream,
        canPublishData: true,
        canUpdateOwnMetadata: false,
        canPublishSources: publishSources(p.canSpeak, p.canStream),
      });
      return at.toJwt();
    },
  };
}

export function publishSources(canSpeak: boolean, canStream: boolean): TrackSource[] {
  const s: TrackSource[] = [];
  if (canSpeak) s.push(TrackSource.MICROPHONE);
  if (canStream) s.push(TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  return s;
}

export const roomName = (channelId: string) => `ch_${channelId}`;
export const channelFromRoom = (room: string) => (/^ch_(\d+)$/.exec(room)?.[1] ?? null);

// ---------- voice state (Valkey) ----------
//   vs:<guildId>   hash userId -> VoiceState JSON
//   vsu:<userId>   "<guildId>:<channelId>"
//   vmod:<guildId>:<userId>  JSON {mute, deaf} — server mute/deafen persists between joins

export async function getUserVoice(ctx: Ctx, userId: string): Promise<VoiceState | null> {
  const loc = await ctx.redis.get(`vsu:${userId}`);
  if (!loc) return null;
  const [guildId] = loc.split(':');
  const raw = await ctx.redis.hget(`vs:${guildId}`, userId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VoiceState;
  } catch {
    return null;
  }
}

export async function setVoiceState(ctx: Ctx, vs: VoiceState): Promise<void> {
  await ctx.redis.multi().hset(`vs:${vs.guildId}`, vs.userId, JSON.stringify(vs)).set(`vsu:${vs.userId}`, `${vs.guildId}:${vs.channelId}`).exec();
  ctx.bus.toGuild(vs.guildId, 'VOICE_STATE_UPDATE', vs, { channelId: vs.channelId });
}

export async function clearVoiceState(ctx: Ctx, guildId: string, userId: string, onlyChannel?: string): Promise<boolean> {
  const raw = await ctx.redis.hget(`vs:${guildId}`, userId);
  if (!raw) return false;
  const vs = JSON.parse(raw) as VoiceState;
  if (onlyChannel && vs.channelId !== onlyChannel) return false;
  await ctx.redis.multi().hdel(`vs:${guildId}`, userId).del(`vsu:${userId}`).exec();
  ctx.bus.toGuild(guildId, 'VOICE_STATE_UPDATE', { guildId, userId, channelId: null }, { channelId: vs.channelId });
  // whoever left may have been controlling watch-together; game/watch state is cleaned by its own module
  return true;
}

export async function getServerMod(ctx: Ctx, guildId: string, userId: string): Promise<{ mute: boolean; deaf: boolean }> {
  const raw = await ctx.redis.get(`vmod:${guildId}:${userId}`);
  if (!raw) return { mute: false, deaf: false };
  try {
    return JSON.parse(raw) as { mute: boolean; deaf: boolean };
  } catch {
    return { mute: false, deaf: false };
  }
}

export async function setServerMod(ctx: Ctx, guildId: string, userId: string, mod: { mute: boolean; deaf: boolean }): Promise<void> {
  if (!mod.mute && !mod.deaf) await ctx.redis.del(`vmod:${guildId}:${userId}`);
  else await ctx.redis.set(`vmod:${guildId}:${userId}`, JSON.stringify(mod));
}

export async function participantsIn(ctx: Ctx, guildId: string, channelId: string): Promise<VoiceState[]> {
  const all = await ctx.redis.hgetall(`vs:${guildId}`);
  return Object.values(all)
    .map((v) => JSON.parse(v) as VoiceState)
    .filter((v) => v.channelId === channelId);
}

/** Kicks the user out of LiveKit (best effort) and clears their state. */
export async function disconnectVoice(ctx: Ctx, userId: string): Promise<VoiceState | null> {
  const vs = await getUserVoice(ctx, userId);
  if (!vs) {
    await ctx.redis.del(`vsu:${userId}`);
    return null;
  }
  if (ctx.voice) await ctx.voice.rooms.removeParticipant(roomName(vs.channelId), userId).catch(() => {});
  await clearVoiceState(ctx, vs.guildId, userId);
  return vs;
}
