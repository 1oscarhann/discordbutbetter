import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type { Room, RemoteTrack, Track, Participant } from 'livekit-client';
import { api, errorMessage, post } from '../api';
import { app } from './app.svelte';

export interface Tile {
  identity: string;
  kind: 'camera' | 'screen';
  track: Track;
}

/**
 * LiveKit session. The SDK (~400KB) is only loaded the first time you join voice.
 */
class VoiceClient {
  state = $state<'idle' | 'connecting' | 'connected' | 'reconnecting'>('idle');
  guildId = $state<string | null>(null);
  channelId = $state<string | null>(null);
  selfMute = $state(false);
  selfDeaf = $state(false);
  camera = $state(false);
  screen = $state(false);
  canSpeak = $state(true);
  canStream = $state(true);
  speaking = new SvelteSet<string>();
  tiles = new SvelteMap<string, Tile>();
  volumes = new SvelteMap<string, number>();
  error = $state<string | null>(null);
  inputDeviceId = $state<string | null>(null);
  outputDeviceId = $state<string | null>(null);
  private room: Room | null = null;
  private audioEls = new Map<string, { identity: string; el: HTMLMediaElement }>();

  async join(guildId: string, channelId: string) {
    if (this.channelId === channelId && this.state !== 'idle') return;
    if (this.room) await this.leave(false);
    this.state = 'connecting';
    this.error = null;
    this.guildId = guildId;
    this.channelId = channelId;
    try {
      const { token, url, canSpeak, canStream } = await post<{ token: string; url: string; canSpeak: boolean; canStream: boolean }>(
        `/channels/${channelId}/voice/join`,
      );
      this.canSpeak = canSpeak;
      this.canStream = canStream;
      const lk = await import('livekit-client');
      const room = new lk.Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: this.inputDeviceId ?? undefined },
        audioOutput: this.outputDeviceId ? { deviceId: this.outputDeviceId } : undefined,
        publishDefaults: { simulcast: true, dtx: true, red: true, screenShareEncoding: lk.ScreenSharePresets.h1080fps30.encoding },
        videoCaptureDefaults: { resolution: lk.VideoPresets.h720.resolution },
      });
      this.room = room;
      room
        .on(lk.RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, p: Participant) => this.onTrack(track, p))
        .on(lk.RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub, p: Participant) => this.offTrack(track, p))
        .on(lk.RoomEvent.LocalTrackPublished, (pub) => pub.track && this.onLocalTrack(pub.track))
        .on(lk.RoomEvent.LocalTrackUnpublished, (pub) => pub.track && this.tiles.delete(`${room.localParticipant.identity}:${pub.track.source}`))
        .on(lk.RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
          this.speaking.clear();
          for (const s of speakers) this.speaking.add(s.identity);
        })
        .on(lk.RoomEvent.Reconnecting, () => (this.state = 'reconnecting'))
        .on(lk.RoomEvent.Reconnected, () => (this.state = 'connected'))
        .on(lk.RoomEvent.Disconnected, () => {
          if (this.room === room) this.cleanup();
        });
      const wsUrl = url.startsWith('/') ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${url}` : url;
      await room.connect(wsUrl, token);
      this.state = 'connected';
      if (canSpeak && !this.selfMute) {
        await room.localParticipant.setMicrophoneEnabled(true).catch((e: Error) => {
          this.error = `Microphone: ${e.message}`;
          this.selfMute = true;
        });
      }
      if (this.selfMute || this.selfDeaf) void this.pushState();
    } catch (e) {
      this.error = errorMessage(e);
      app.toast(`Couldn't join voice: ${this.error}`, 'error');
      await this.leave();
    }
  }

  async leave(notifyServer = true) {
    const room = this.room;
    this.room = null;
    if (room) await room.disconnect().catch(() => {});
    if (notifyServer) await post('/voice/leave').catch(() => {});
    this.cleanup();
  }

  private cleanup() {
    for (const a of this.audioEls.values()) a.el.remove();
    this.audioEls.clear();
    this.tiles.clear();
    this.speaking.clear();
    this.camera = false;
    this.screen = false;
    this.state = 'idle';
    this.channelId = null;
    this.guildId = null;
  }

  private onTrack(track: RemoteTrack, p: Participant) {
    if (track.kind === 'audio') {
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audioEls.set(track.sid ?? `${p.identity}:${track.source}`, { identity: p.identity, el });
      el.muted = this.selfDeaf;
      const v = this.volumes.get(p.identity);
      if (v !== undefined) el.volume = v;
      return;
    }
    const kind = track.source === 'screen_share' ? 'screen' : 'camera';
    this.tiles.set(`${p.identity}:${track.source}`, { identity: p.identity, kind, track });
  }

  private offTrack(track: RemoteTrack, p: Participant) {
    if (track.kind === 'audio') {
      const key = track.sid ?? `${p.identity}:${track.source}`;
      this.audioEls.get(key)?.el.remove();
      this.audioEls.delete(key);
      track.detach();
      return;
    }
    this.tiles.delete(`${p.identity}:${track.source}`);
    track.detach();
  }

  private onLocalTrack(track: Track) {
    if (track.kind !== 'video' || !this.room) return;
    const kind = track.source === 'screen_share' ? 'screen' : 'camera';
    this.tiles.set(`${this.room.localParticipant.identity}:${track.source}`, { identity: this.room.localParticipant.identity, kind, track });
  }

  private async pushState() {
    await api('PATCH', '/voice/state', { selfMute: this.selfMute, selfDeaf: this.selfDeaf, video: this.camera, streaming: this.screen }).catch(() => {});
  }

  async toggleMute() {
    if (!this.canSpeak && this.selfMute) return app.toast("You can't speak in this channel", 'error');
    this.selfMute = !this.selfMute;
    if (!this.selfMute && this.selfDeaf) this.setDeaf(false);
    await this.room?.localParticipant.setMicrophoneEnabled(!this.selfMute).catch((e: Error) => app.toast(e.message, 'error'));
    await this.pushState();
  }

  private setDeaf(v: boolean) {
    this.selfDeaf = v;
    for (const a of this.audioEls.values()) a.el.muted = v;
  }

  async toggleDeaf() {
    this.setDeaf(!this.selfDeaf);
    if (this.selfDeaf && !this.selfMute) {
      this.selfMute = true;
      await this.room?.localParticipant.setMicrophoneEnabled(false).catch(() => {});
    }
    await this.pushState();
  }

  async toggleCamera() {
    if (!this.room) return;
    if (!this.canStream) return app.toast("You can't turn on video here", 'error');
    try {
      await this.room.localParticipant.setCameraEnabled(!this.camera);
      this.camera = !this.camera;
      if (!this.camera) this.tiles.delete(`${this.room.localParticipant.identity}:camera`);
      await this.pushState();
    } catch (e) {
      app.toast(`Camera: ${errorMessage(e)}`, 'error');
    }
  }

  /** HD screen share is free: 1080p30 by default, 1440p/60 if you pick it. */
  async toggleScreen(quality: '720' | '1080' | '1440' = '1080', fps = 30) {
    if (!this.room) return;
    if (!this.canStream) return app.toast("You can't share your screen here", 'error');
    try {
      const res = { '720': { width: 1280, height: 720 }, '1080': { width: 1920, height: 1080 }, '1440': { width: 2560, height: 1440 } }[quality];
      await this.room.localParticipant.setScreenShareEnabled(!this.screen, {
        audio: true,
        resolution: { ...res, frameRate: fps },
        contentHint: fps > 30 ? 'motion' : 'detail',
        selfBrowserSurface: 'exclude',
      });
      this.screen = !this.screen;
      if (!this.screen) this.tiles.delete(`${this.room.localParticipant.identity}:screen_share`);
      await this.pushState();
    } catch (e) {
      // cancelling the picker isn't an error worth shouting about
      if (!/Permission denied|NotAllowed|AbortError/i.test(String(e))) app.toast(`Screen share: ${errorMessage(e)}`, 'error');
    }
  }

  setVolume(identity: string, v: number) {
    this.volumes.set(identity, v);
    for (const a of this.audioEls.values()) if (a.identity === identity) a.el.volume = v;
  }

  async setDevices(input: string | null, output: string | null) {
    this.inputDeviceId = input;
    this.outputDeviceId = output;
    if (this.room) {
      if (input) await this.room.switchActiveDevice('audioinput', input).catch(() => {});
      if (output) await this.room.switchActiveDevice('audiooutput', output).catch(() => {});
    }
  }

  async handleMove(d: { guildId: string; channelId: string | null }) {
    if (d.channelId === null) {
      app.toast('A moderator disconnected you from voice');
      await this.leave(false);
    } else {
      app.toast('A moderator moved you to another channel');
      await this.join(d.guildId, d.channelId);
    }
  }
}

export const voice = new VoiceClient();
