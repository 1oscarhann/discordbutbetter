<script lang="ts">
  import { proxiedImage } from '@dbb/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { del, errorMessage, get, put, type UploadedFile } from '$lib/api';
  import Modal from '../Modal.svelte';
  import ImagePicker from '../ImagePicker.svelte';
  import Icon from '../Icon.svelte';

  /**
   * Manual "Playing" / "Listening to": no game detection, no scrobbling. You pick it, it stays until you change it.
   */
  let { kind }: { kind: 'playing' | 'listening' } = $props();

  interface Result {
    name: string;
    subtitle?: string;
    sourceId: string;
    coverUrl: string | null;
  }

  const me = $derived(app.me!);
  const current = $derived(kind === 'playing' ? me.playing : me.listening);
  const searchOn = $derived(kind === 'playing' ? app.instance?.gameSearch : app.instance?.musicSearch);

  let q = $state('');
  let results = $state<Result[]>([]);
  let searching = $state(false);
  let searchError = $state('');
  let custom = $state(!searchOn);
  let name = $state('');
  let artist = $state('');
  let cover = $state<UploadedFile | null>(null);
  let lfg = $state(kind === 'playing' ? (app.me?.playing?.lfg ?? false) : false);
  let error = $state('');
  let timer: ReturnType<typeof setTimeout>;

  function search() {
    clearTimeout(timer);
    if (q.trim().length < 2) {
      results = [];
      return;
    }
    timer = setTimeout(async () => {
      searching = true;
      searchError = '';
      try {
        results = await get<Result[]>(`/search/${kind === 'playing' ? 'games' : 'music'}?q=${encodeURIComponent(q.trim())}`);
      } catch (e) {
        searchError = errorMessage(e);
        results = [];
      } finally {
        searching = false;
      }
    }, 350);
  }

  async function choose(r: Result) {
    error = '';
    try {
      if (kind === 'playing') {
        await put('/users/@me/activity/playing', { name: r.name, source: app.instance?.gameSearch ? 'igdb' : 'custom', sourceId: r.sourceId, coverUrl: r.coverUrl, lfg });
      } else {
        await put('/users/@me/activity/listening', { title: r.name, artist: r.subtitle || 'Unknown artist', coverUrl: r.coverUrl });
      }
      ui.activityPicker = null;
    } catch (e) {
      error = errorMessage(e);
    }
  }

  async function saveCustom(e: Event) {
    e.preventDefault();
    error = '';
    try {
      if (kind === 'playing') {
        await put('/users/@me/activity/playing', { name, source: 'custom', coverFileId: cover?.id ?? null, lfg });
      } else {
        await put('/users/@me/activity/listening', { title: name, artist, coverFileId: cover?.id ?? null });
      }
      ui.activityPicker = null;
    } catch (err) {
      error = errorMessage(err);
    }
  }

  async function clear() {
    await del(`/users/@me/activity/${kind}`).catch(() => {});
    ui.activityPicker = null;
  }

</script>

<Modal title={kind === 'playing' ? 'What are you playing?' : 'What are you listening to?'} onclose={() => (ui.activityPicker = null)} width={520}>
  {#if current}
    <div class="current card">
      {#if current.cover}<img src={proxiedImage(current.cover, 128)} alt="" />{/if}
      <div class="col" style="gap:2px;flex:1;min-width:0">
        <span class="faint small">{kind === 'playing' ? 'Playing' : 'Listening to'}</span>
        <strong class="truncate">{'name' in current ? current.name : current.title}</strong>
        {#if 'artist' in current}<span class="faint truncate">{current.artist}</span>{/if}
      </div>
      <button class="btn small danger" onclick={clear}>Clear</button>
    </div>
  {/if}
  {#if kind === 'playing'}
    <label class="row lfg">
      <span class="lfgtag">LFG</span>
      <span class="col" style="gap:0;flex:1"><strong>Looking for group</strong><span class="faint small">Friends see you want people to play with</span></span>
      <input
        type="checkbox"
        class="switch"
        checked={lfg}
        onchange={async () => {
          lfg = !lfg;
          if (me.playing) await import('$lib/api').then(({ patch }) => patch('/users/@me/activity/playing', { lfg })).catch(() => {});
        }}
      />
    </label>
  {/if}

  {#if !custom}
    <div class="field">
      <input class="input" placeholder={kind === 'playing' ? 'Search games' : 'Search songs'} bind:value={q} oninput={search} />
    </div>
    {#if searchError}<p class="error-text small">{searchError}</p>{/if}
    <div class="results scroll">
      {#if searching}<p class="faint small">Searching…</p>{/if}
      {#each results as r (r.sourceId)}
        <button class="res" onclick={() => choose(r)}>
          {#if r.coverUrl}<img src={proxiedImage(r.coverUrl, 128)} alt="" loading="lazy" />{:else}<span class="nocover"><Icon name={kind === 'playing' ? 'gamepad' : 'music'} /></span>{/if}
          <span class="col" style="gap:0;min-width:0">
            <strong class="truncate">{r.name}</strong>
            {#if r.subtitle}<span class="faint small truncate">{r.subtitle}</span>{/if}
          </span>
        </button>
      {/each}
    </div>
    <button class="btn ghost small" onclick={() => (custom = true)}>Can't find it? Add your own</button>
  {:else}
    <form id="cust" onsubmit={saveCustom}>
      <div class="field">
        <label for="nm">{kind === 'playing' ? 'Game name' : 'Song title'}</label>
        <input id="nm" class="input" bind:value={name} maxlength="100" required />
      </div>
      {#if kind === 'listening'}
        <div class="field">
          <label for="ar">Artist</label>
          <input id="ar" class="input" bind:value={artist} maxlength="100" required />
        </div>
      {/if}
      <div class="field">
        <label for="cv">Cover image (optional)</label>
        <ImagePicker purpose={kind === 'playing' ? 'game_cover' : 'music_cover'} label="Upload cover" onchange={(f) => (cover = f)} />
      </div>
    </form>
    {#if searchOn}<button class="btn ghost small" onclick={() => (custom = false)}>← Back to search</button>{/if}
  {/if}
  {#if error}<p class="error-text">{error}</p>{/if}
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (ui.activityPicker = null)}>Close</button>
    {#if custom}<button class="btn primary" form="cust" disabled={!name.trim() || (kind === 'listening' && !artist.trim())}>Save</button>{/if}
  {/snippet}
</Modal>

<style>
  .current {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
    padding: 10px;
  }
  .current img {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 6px;
  }
  .lfg {
    padding: 8px 0 14px;
  }
  .lfgtag {
    background: var(--success);
    color: #fff;
    font-weight: 800;
    font-size: 0.7rem;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .results {
    max-height: 340px;
    margin-bottom: 8px;
  }
  .res {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 6px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .res:hover {
    background: var(--hover);
  }
  .res img,
  .nocover {
    width: 44px;
    height: 44px;
    object-fit: cover;
    border-radius: 6px;
    flex: none;
    display: grid;
    place-items: center;
    background: var(--bg-0);
  }
  .small {
    font-size: 0.8rem;
  }
</style>
