<script lang="ts">
  import type { Channel, WatchState } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, post } from '$lib/api';
  import { duration } from '$lib/util/time';
  import Icon from '../Icon.svelte';

  /**
   * Synced YouTube. We talk to the youtube-nocookie embed over postMessage (the same protocol the
   * official IFrame API uses) so YouTube's API script never runs on our page. Everyone follows
   * the shared state from the server, using the gateway's clock offset to agree on "now".
   */
  let { channel, onclose }: { channel: Channel; onclose: () => void } = $props();

  const ws = $derived(app.watch.get(channel.id) ?? null);
  let iframe = $state<HTMLIFrameElement | null>(null);
  let box = $state<HTMLDivElement | null>(null);
  let url = $state('');
  let localTime = $state(0);
  let playerState = $state(-1);
  let ready = $state(false);
  let needsClick = $state(false);
  let loadedId = '';
  let lastSeek = 0;
  let volume = $state(80);
  let muted = $state(false);

  const YT_ORIGIN = 'https://www.youtube-nocookie.com';

  function cmd(func: string, args: unknown[] = []) {
    iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }), YT_ORIGIN);
  }

  function target(s: WatchState): number {
    return s.playing ? s.position + ((app.gateway.serverNow() - s.updatedAt) / 1000) * s.rate : s.position;
  }

  // messages from the player
  $effect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || e.source !== iframe?.contentWindow) return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (data.event === 'onReady') ready = true;
      if (data.event === 'infoDelivery' && data.info && typeof data.info === 'object') {
        const info = data.info as { currentTime?: number; playerState?: number };
        ready = true;
        if (typeof info.currentTime === 'number') localTime = info.currentTime;
        if (typeof info.playerState === 'number') onPlayerState(info.playerState);
      }
      if (data.event === 'onStateChange' && typeof data.info === 'number') onPlayerState(data.info);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });

  function onPlayerState(ps: number) {
    const was = playerState;
    playerState = ps;
    if (ps === 0 && was !== 0 && ws?.videoId) {
      void post(`/channels/${channel.id}/watch`, { action: 'ended', videoId: ws.videoId }).catch(() => {});
    }
  }

  // ask the iframe to start sending us events until it does
  $effect(() => {
    if (!iframe) return;
    const el = iframe;
    const t = setInterval(() => {
      if (ready) return clearInterval(t);
      el.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), YT_ORIGIN);
    }, 400);
    return () => clearInterval(t);
  });

  // load a new video when the shared one changes
  $effect(() => {
    const s = ws;
    if (!s?.videoId || !ready) return;
    if (s.videoId !== loadedId) {
      loadedId = s.videoId;
      cmd('loadVideoById', [{ videoId: s.videoId, startSeconds: Math.max(0, target(s)) }]);
      if (!s.playing) setTimeout(() => cmd('pauseVideo'), 400);
    }
  });

  // drift correction loop
  $effect(() => {
    const timer = setInterval(() => {
      const s = ws;
      if (!s?.videoId || !ready || s.videoId !== loadedId) return;
      const want = target(s);
      if (s.playing && playerState !== 1 && playerState !== 3) {
        cmd('playVideo');
        // if autoplay was blocked the state won't change: ask for a click
        setTimeout(() => {
          if (playerState !== 1 && playerState !== 3 && ws?.playing) needsClick = true;
        }, 1500);
      }
      if (!s.playing && playerState === 1) cmd('pauseVideo');
      if (Math.abs(localTime - want) > 1.5 && Date.now() - lastSeek > 2500) {
        lastSeek = Date.now();
        cmd('seekTo', [want, true]);
      }
      cmd('setPlaybackRate', [s.rate]);
    }, 1000);
    return () => clearInterval(timer);
  });

  async function control(body: Record<string, unknown>) {
    try {
      await post(`/channels/${channel.id}/watch`, body);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function load(e: Event) {
    e.preventDefault();
    if (!url.trim()) return;
    await control({ action: ws?.videoId ? 'queue_add' : 'load', url: url.trim() });
    url = '';
  }

  function seekBy(d: number) {
    if (!ws) return;
    void control({ action: 'seek', position: Math.max(0, target(ws) + d) });
  }

  // the iframe starts on the current video; later changes go through loadVideoById (no reload)
  let initialId = $state<string | null>(null);
  let initialStart = 0;
  $effect(() => {
    const s = ws;
    if (!s?.videoId) {
      initialId = null;
      loadedId = '';
      ready = false;
      return;
    }
    if (!initialId) {
      initialStart = Math.max(0, Math.floor(target(s)));
      loadedId = s.videoId;
      initialId = s.videoId;
    }
  });
  const embedSrc = $derived(
    initialId
      ? `${YT_ORIGIN}/embed/${initialId}?enablejsapi=1&autoplay=1&start=${initialStart}&controls=0&disablekb=1&rel=0&playsinline=1&iv_load_policy=3&origin=${encodeURIComponent(location.origin)}`
      : '',
  );

  function fullscreen() {
    void box?.requestFullscreen?.();
  }

  $effect(() => {
    if (!ready) return;
    cmd('setVolume', [volume]);
    cmd(muted ? 'mute' : 'unMute');
  });
</script>

<section class="watch">
  <div class="player" bind:this={box}>
    {#if ws?.videoId && embedSrc}
      <iframe
        bind:this={iframe}
        src={embedSrc}
        title="Watch together"
        allow="autoplay; encrypted-media; fullscreen"
        referrerpolicy="strict-origin"
      ></iframe>
      <!-- block direct clicks so everyone stays in sync through the shared controls -->
      <div class="shield" role="presentation" ondblclick={fullscreen}></div>
      {#if needsClick}
        <button class="clickme" onclick={() => ((needsClick = false), cmd('playVideo'))}><Icon name="play" size={22} /> Click to join playback</button>
      {/if}
    {:else}
      <div class="empty">
        <Icon name="tv" size={40} />
        <p>Paste a YouTube link to watch together. Everyone in the call stays on the same timestamp.</p>
        <p class="faint small">Uses youtube-nocookie.com, and only loads once something is playing.</p>
      </div>
    {/if}
  </div>

  {#if ws?.videoId}
    <div class="bar">
      <button class="icon-btn" title={ws.playing ? 'Pause' : 'Play'} onclick={() => control({ action: ws.playing ? 'pause' : 'play', position: target(ws) })}>
        <Icon name={ws.playing ? 'pause' : 'play'} />
      </button>
      <button class="icon-btn" title="Back 10s" onclick={() => seekBy(-10)}>-10</button>
      <button class="icon-btn" title="Forward 10s" onclick={() => seekBy(10)}>+10</button>
      <button class="icon-btn" title="Next in queue" onclick={() => control({ action: 'next' })}><Icon name="skip" size={18} /></button>
      <span class="time faint">{duration(localTime)}</span>
      <span class="title truncate" title={ws.title ?? ''}>{ws.title}</span>
      <select class="select rate" value={ws.rate} onchange={(e) => control({ action: 'rate', rate: Number((e.target as HTMLSelectElement).value) })}>
        {#each [0.5, 1, 1.25, 1.5, 2] as r (r)}<option value={r}>{r}×</option>{/each}
      </select>
      <button class="icon-btn" title={muted ? 'Unmute (just you)' : 'Mute (just you)'} onclick={() => (muted = !muted)}><Icon name={muted ? 'speaker-off' : 'speaker'} size={18} /></button>
      <input type="range" min="0" max="100" bind:value={volume} class="vol" title="Your volume" />
      <button class="icon-btn" title="Fullscreen" onclick={fullscreen}><Icon name="maximize" size={18} /></button>
      <button class="icon-btn danger" title="Stop for everyone" onclick={() => control({ action: 'stop' })}><Icon name="x" /></button>
    </div>
  {/if}

  <form class="add" onsubmit={load}>
    <input class="input" placeholder={ws?.videoId ? 'Add a YouTube link to the queue' : 'YouTube link'} bind:value={url} />
    <button class="btn primary small">{ws?.videoId ? 'Queue' : 'Play'}</button>
    {#if !ws?.videoId}<button type="button" class="btn small ghost" onclick={onclose}>Close</button>{/if}
  </form>

  {#if ws?.queue.length}
    <ol class="queue">
      {#each ws.queue as q, i (`${q.videoId}${i}`)}
        <li>
          <span class="truncate">{q.title}</span>
          <span class="faint small">added by {app.displayName(q.addedBy, channel.guildId)}</span>
          <button class="icon-btn mini" title="Remove" onclick={() => control({ action: 'queue_remove', index: i })}><Icon name="x" size={14} /></button>
        </li>
      {/each}
    </ol>
  {/if}
</section>

<style>
  .watch {
    background: var(--bg-2);
    border-radius: 12px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: none;
  }
  .player {
    position: relative;
    aspect-ratio: 16 / 9;
    max-height: 56vh;
    background: #000;
    border-radius: 8px;
    overflow: hidden;
  }
  .player iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
  .shield {
    position: absolute;
    inset: 0;
  }
  .clickme {
    position: absolute;
    inset: 0;
    margin: auto;
    width: fit-content;
    height: fit-content;
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 12px 18px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    font-weight: 700;
    cursor: pointer;
  }
  .empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    text-align: center;
    color: #ddd;
    padding: 20px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85rem;
  }
  .bar .icon-btn {
    font-weight: 700;
    font-size: 0.78rem;
  }
  .title {
    flex: 1;
    font-weight: 600;
    padding: 0 6px;
  }
  .time {
    font-variant-numeric: tabular-nums;
    padding: 0 4px;
  }
  .rate {
    width: 70px;
    padding: 4px;
  }
  .vol {
    width: 80px;
  }
  .add {
    display: flex;
    gap: 6px;
  }
  .queue {
    margin: 0;
    padding-left: 22px;
    font-size: 0.86rem;
  }
  .queue li {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .queue .truncate {
    flex: 1;
  }
  .mini {
    width: 22px;
    height: 22px;
  }
  .small {
    font-size: 0.75rem;
  }
</style>
