<script lang="ts" module>
  export interface LookupResult {
    name: string;
    subtitle?: string;
    sourceId: string;
    coverUrl: string | null;
    source?: 'igdb' | 'rawg';
  }
</script>

<script lang="ts">
  import { proxiedImage } from '@haunt/shared';
  import { errorMessage, get } from '$lib/api';
  import Icon from '../Icon.svelte';

  /** Search box for the game database / MusicBrainz. Results go through our image proxy. */
  let { kind, onpick, placeholder }: { kind: 'games' | 'music'; onpick: (r: LookupResult) => void; placeholder?: string } = $props();

  let q = $state('');
  let results = $state<LookupResult[]>([]);
  let searching = $state(false);
  let error = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;

  function search() {
    clearTimeout(timer);
    error = '';
    if (q.trim().length < 2) {
      results = [];
      return;
    }
    timer = setTimeout(async () => {
      searching = true;
      try {
        results = await get<LookupResult[]>(`/search/${kind}?q=${encodeURIComponent(q.trim())}`);
      } catch (e) {
        error = errorMessage(e);
        results = [];
      } finally {
        searching = false;
      }
    }, 350);
  }

  function pick(r: LookupResult) {
    onpick(r);
    q = '';
    results = [];
  }
</script>

<div class="ls">
  <input class="input" placeholder={placeholder ?? (kind === 'games' ? 'Search games' : 'Search songs')} bind:value={q} oninput={search} />
  {#if error}<p class="error-text small">{error}</p>{/if}
  {#if searching || results.length}
    <div class="res menu scroll">
      {#if searching}<p class="faint small" style="padding:6px">Searching…</p>{/if}
      {#each results as r (r.sourceId)}
        <button class="menu-item" type="button" onclick={() => pick(r)}>
          {#if r.coverUrl}<img src={proxiedImage(r.coverUrl, 64)} alt="" loading="lazy" />{:else}<span class="nc"><Icon name={kind === 'games' ? 'gamepad' : 'music'} size={14} /></span>{/if}
          <span class="col" style="gap:0;min-width:0">
            <span class="truncate">{r.name}</span>
            {#if r.subtitle}<span class="faint small truncate">{r.subtitle}</span>{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ls {
    position: relative;
  }
  .res {
    position: absolute;
    left: 0;
    right: 0;
    top: calc(100% + 4px);
    max-height: 280px;
    z-index: 10;
  }
  .res img,
  .nc {
    width: 30px;
    height: 30px;
    object-fit: cover;
    border-radius: 4px;
    flex: none;
    display: grid;
    place-items: center;
    background: var(--bg-3);
  }
</style>
