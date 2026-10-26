<script lang="ts">
  import type { Track } from 'livekit-client';
  import { Permissions as P, type Channel, type GameSession } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { voice } from '$lib/state/voice.svelte';
  import { get } from '$lib/api';
  import Icon from '../Icon.svelte';
  import Avatar from '../Avatar.svelte';
  import MessageList from '../chat/MessageList.svelte';
  import Composer from '../chat/Composer.svelte';
  import WatchTogether from '../activities/WatchTogether.svelte';
  import GameLauncher from '../activities/GameLauncher.svelte';
  import GameCard from '../activities/GameCard.svelte';

  let { channel }: { channel: Channel } = $props();
  const g = $derived(app.guilds.get(channel.guildId!)!);
  const here = $derived([...g.voice.values()].filter((v) => v.channelId === channel.id));
  const connected = $derived(voice.channelId === channel.id && voice.state !== 'idle');
  const watch = $derived(app.watch.get(channel.id));
  const games = $derived([...app.games.values()].filter((x) => x.channelId === channel.id && x.status !== 'finished'));
  let showChat = $state(false);
  let showWatch = $state(false);
  let launcher = $state<HTMLElement | null>(null);
  let focus = $state<string | null>(null);
  let composer = $state<ReturnType<typeof Composer> | null>(null);
  const canActivities = $derived(app.can(P.USE_ACTIVITIES, channel.guildId, channel.id));

  // load watch state + running games when opening the channel
  $effect(() => {
    const id = channel.id;
    void get<import('@haunt/shared').WatchState | null>(`/channels/${id}/watch`).then((w) => w?.videoId && app.watch.set(id, w)).catch(() => {});
    void get<GameSession[]>(`/channels/${id}/games`).then((list) => list.forEach((s) => app.games.set(s.id, s))).catch(() => {});
  });

  function attach(el: HTMLVideoElement, track: Track) {
    track.attach(el);
    return {
      update(t: Track) {
        track.detach(el);
        track = t;
        t.attach(el);
      },
      destroy() {
        track.detach(el);
      },
    };
  }

  const tiles = $derived([...voice.tiles.entries()].map(([key, t]) => ({ key, ...t })));
  const focused = $derived(focus ? tiles.find((t) => t.key === focus) : (tiles.find((t) => t.kind === 'screen') ?? null));
</script>

<div class="voice">
  <header class="hdr">
    <button class="icon-btn burger" aria-label="Menu" onclick={() => (ui.mobileNav = true)}><Icon name="menu" /></button>
    <Icon name="speaker" class="faint" />
    <strong class="truncate">{channel.name}</strong>
    <span class="faint">{here.length}{channel.userLimit ? `/${channel.userLimit}` : ''} connected</span>
    <span class="spacer"></span>
    {#if canActivities && connected}
      <button class="btn small" class:primary={showWatch || !!watch} onclick={() => (showWatch = !showWatch)}><Icon name="tv" size={16} /> Watch together</button>
      <button class="btn small" onclick={(e) => (launcher = e.currentTarget)}><Icon name="gamepad" size={16} /> Games</button>
    {/if}
    <button class="icon-btn" class:active={showChat} title="Chat" onclick={() => (showChat = !showChat)}><Icon name="message" /></button>
  </header>

  <div class="body">
    <div class="stage">
      {#if !app.instance?.voiceEnabled}
        <div class="center"><p class="muted">Voice isn't set up on this server. The admin needs to configure LiveKit.</p></div>
      {:else if !connected}
        <div class="center">
          <div class="avs">
            {#each here.slice(0, 8) as v (v.userId)}<Avatar src={app.avatarOf(v.userId, g.guild.id)} name={app.displayName(v.userId, g.guild.id)} size={48} />{/each}
          </div>
          <h2>{channel.name}</h2>
          <p class="muted">{here.length ? `${here.length} ${here.length === 1 ? 'person is' : 'people are'} here` : 'Nobody is here yet'}</p>
          <button class="btn primary" disabled={voice.state === 'connecting'} onclick={() => voice.join(g.guild.id, channel.id)}>
            {voice.state === 'connecting' ? 'Joining…' : 'Join voice'}
          </button>
        </div>
      {:else}
        {#if (showWatch || watch) && canActivities}
          <WatchTogether {channel} onclose={() => (showWatch = false)} />
        {/if}
        {#if games.length}
          <div class="games">
            {#each games as gs (gs.id)}<GameCard gameId={gs.id} {channel} />{/each}
          </div>
        {/if}
        {#if focused}
          <div class="focus">
            <video use:attach={focused.track} autoplay playsinline muted class:contain={focused.kind === 'screen'}></video>
            <span class="tag">{app.displayName(focused.identity, g.guild.id)}{focused.kind === 'screen' ? ' · screen' : ''}</span>
            <button class="icon-btn unfocus" title="Back to grid" onclick={() => (focus = 'none')}><Icon name="x" /></button>
          </div>
        {/if}
        <div class="grid" class:strip={!!focused}>
          {#each here as v (v.userId)}
            {@const cam = tiles.find((t) => t.identity === v.userId && t.kind === 'camera')}
            <button class="tile" class:speaking={voice.speaking.has(v.userId)} onclick={() => cam && (focus = cam.key)}>
              {#if cam}
                <video use:attach={cam.track} autoplay playsinline muted></video>
              {:else}
                <Avatar src={app.avatarOf(v.userId, g.guild.id)} name={app.displayName(v.userId, g.guild.id)} size={72} speaking={voice.speaking.has(v.userId)} />
              {/if}
              <span class="tag">
                {#if v.selfMute || v.serverMute}<Icon name="mic-off" size={13} />{/if}
                {#if v.selfDeaf || v.serverDeaf}<Icon name="headphones-off" size={13} />{/if}
                {app.displayName(v.userId, g.guild.id)}
              </span>
              {#if v.streaming}
                {@const scr = tiles.find((t) => t.identity === v.userId && t.kind === 'screen')}
                <span
                  class="live"
                  role="button"
                  tabindex="0"
                  onclick={(e) => (e.stopPropagation(), scr && (focus = scr.key))}
                  onkeydown={(e) => e.key === 'Enter' && scr && (focus = scr.key)}>LIVE · watch</span
                >
              {/if}
              {#if v.userId !== app.me?.id}
                <input
                  class="vol"
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={voice.volumes.get(v.userId) ?? 1}
                  title="Volume"
                  onclick={(e) => e.stopPropagation()}
                  oninput={(e) => voice.setVolume(v.userId, Number((e.target as HTMLInputElement).value))}
                />
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#if connected}
        <div class="controls">
          <button class="ctl" class:off={voice.selfMute} title={voice.selfMute ? 'Unmute' : 'Mute'} onclick={() => voice.toggleMute()}><Icon name={voice.selfMute ? 'mic-off' : 'mic'} /></button>
          <button class="ctl" class:off={voice.selfDeaf} title={voice.selfDeaf ? 'Undeafen' : 'Deafen'} onclick={() => voice.toggleDeaf()}><Icon name={voice.selfDeaf ? 'headphones-off' : 'headphones'} /></button>
          <button class="ctl" class:on={voice.camera} title="Camera" onclick={() => voice.toggleCamera()}><Icon name={voice.camera ? 'video' : 'video-off'} /></button>
          <button class="ctl" class:on={voice.screen} title="Share screen (1080p)" onclick={() => voice.toggleScreen('1080', 30)}><Icon name="screen" /></button>
          <button class="ctl leave" title="Leave" onclick={() => voice.leave()}><Icon name="phone-off" /></button>
        </div>
      {/if}
      {#if voice.error}<p class="error-text verr">{voice.error}</p>{/if}
    </div>

    {#if showChat}
      <aside class="chat">
        <MessageList {channel} embedded onEditLast={() => composer?.editLast()} onReply={(id) => composer?.replyTo(id)} />
        <Composer bind:this={composer} {channel} />
      </aside>
    {/if}
  </div>
</div>

{#if launcher}
  <GameLauncher anchor={launcher} {channel} onclose={() => (launcher = null)} />
{/if}

<style>
  .voice {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-0);
  }
  .hdr {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 0 16px;
    background: var(--bg-2);
    border-bottom: 1px solid var(--bg-0);
  }
  .burger {
    display: none;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .stage {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 12px;
    gap: 12px;
    overflow-y: auto;
  }
  .center {
    flex: 1;
    display: grid;
    place-content: center;
    justify-items: center;
    text-align: center;
    gap: 6px;
  }
  .avs {
    display: flex;
    gap: -8px;
  }
  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 360px));
    justify-content: center;
    align-content: center;
    gap: 10px;
    overflow: auto;
  }
  .grid:not(.strip) .tile {
    aspect-ratio: 16 / 9;
  }
  .grid.strip {
    flex: none;
    grid-auto-flow: column;
    grid-auto-columns: 180px;
    grid-template-columns: none;
    grid-auto-rows: 110px;
    overflow-x: auto;
  }
  .tile {
    position: relative;
    display: grid;
    place-items: center;
    background: var(--bg-2);
    border: 2px solid transparent;
    border-radius: 12px;
    overflow: hidden;
    cursor: pointer;
    padding: 0;
  }
  .tile.speaking {
    border-color: var(--success);
  }
  .tile video,
  .focus video {
    width: 100%;
    height: 100%;
    object-fit: cover;
    background: #000;
  }
  .focus video.contain {
    object-fit: contain;
  }
  .focus {
    position: relative;
    flex: 3;
    min-height: 260px;
    border-radius: 12px;
    overflow: hidden;
    background: #000;
  }
  .unfocus {
    position: absolute;
    top: 8px;
    right: 8px;
    background: rgb(0 0 0 / 0.5);
    color: #fff;
  }
  .tag {
    position: absolute;
    left: 8px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 4px;
    background: rgb(0 0 0 / 0.6);
    color: #fff;
    padding: 2px 8px;
    border-radius: 6px;
    font-size: 0.82rem;
  }
  .live {
    position: absolute;
    top: 8px;
    left: 8px;
    background: var(--danger);
    color: #fff;
    font-weight: 800;
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .vol {
    position: absolute;
    right: 8px;
    bottom: 10px;
    width: 70px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .tile:hover .vol {
    opacity: 1;
  }
  .controls {
    flex: none;
    display: flex;
    justify-content: center;
    gap: 12px;
    padding: 6px;
  }
  .ctl {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    border: none;
    background: var(--bg-3);
    color: var(--text);
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .ctl.off {
    background: var(--text);
    color: var(--danger);
  }
  .ctl.on {
    background: var(--accent);
    color: var(--accent-text);
  }
  .ctl.leave {
    background: var(--danger);
    color: #fff;
  }
  .games {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .chat {
    width: 360px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border-left: 1px solid var(--bg-0);
    min-height: 0;
  }
  .verr {
    text-align: center;
  }
  @media (max-width: 760px) {
    .burger {
      display: inline-grid;
    }
    .chat {
      position: absolute;
      inset: 48px 0 0 0;
      width: auto;
      z-index: 20;
    }
  }
</style>
