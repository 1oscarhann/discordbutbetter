<script lang="ts">
  import { Limits, proxiedImage, type ProfileWidget } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, upload } from '$lib/api';
  import Icon, { type IconName } from '../Icon.svelte';
  import LookupSearch from './LookupSearch.svelte';

  /** Edits profile widgets in their display shape; ProfileTab converts them to the API input shape on save. */
  let { widgets = $bindable() }: { widgets: ProfileWidget[] } = $props();

  const TYPES: { type: ProfileWidget['type']; label: string; icon: IconName; max: number }[] = [
    { type: 'games', label: 'Favourite games', icon: 'gamepad', max: 6 },
    { type: 'songs', label: 'Top songs', icon: 'music', max: 6 },
    { type: 'currently_into', label: 'Currently into', icon: 'star', max: 10 },
    { type: 'photos', label: 'Photo grid', icon: 'image', max: 6 },
    { type: 'text', label: 'Custom text', icon: 'edit', max: 0 },
  ];
  const info = (t: ProfileWidget['type']) => TYPES.find((x) => x.type === t)!;
  const newId = () => ('w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 24);

  let adding = $state(false);
  function add(type: ProfileWidget['type']) {
    adding = false;
    const id = newId();
    const w: ProfileWidget =
      type === 'text' ? { id, type, content: '' } : type === 'games' ? { id, type, items: [] } : type === 'songs' ? { id, type, items: [] } : type === 'photos' ? { id, type, items: [] } : { id, type, items: [] };
    widgets = [...widgets, w];
  }
  function remove(id: string) {
    widgets = widgets.filter((w) => w.id !== id);
  }
  function update(id: string, fn: (w: ProfileWidget) => ProfileWidget) {
    widgets = widgets.map((w) => (w.id === id ? fn(w) : w));
  }
  function move(id: string, dir: -1 | 1) {
    const i = widgets.findIndex((w) => w.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= widgets.length) return;
    const next = [...widgets];
    [next[i], next[j]] = [next[j]!, next[i]!];
    widgets = next;
  }

  // drag & drop reordering (buttons above are the keyboard-friendly way)
  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  function drop(target: string) {
    const from = dragId;
    dragId = overId = null;
    if (!from || from === target) return;
    const next = widgets.filter((w) => w.id !== from);
    const idx = next.findIndex((w) => w.id === target);
    next.splice(idx, 0, widgets.find((w) => w.id === from)!);
    widgets = next;
  }

  // custom (non-database) entries and uploads
  let busy = $state<string | null>(null);
  let customName = $state<Record<string, string>>({});
  let customArtist = $state<Record<string, string>>({});
  let chipLabel = $state<Record<string, string>>({});
  let chipEmoji = $state<Record<string, string>>({});

  async function uploadTo(purpose: 'game_cover' | 'music_cover' | 'widget_photo', file: File, wid: string) {
    busy = wid;
    try {
      return await upload(purpose, file).promise;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
      return null;
    } finally {
      busy = null;
    }
  }
  function pickFile(accept: string, cb: (f: File) => void) {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => i.files?.[0] && cb(i.files[0]);
    i.click();
  }
  const IMG = 'image/png,image/jpeg,image/webp,image/gif,image/avif';
</script>

<div class="widgets">
  {#each widgets as w (w.id)}
    {@const t = info(w.type)}
    <div
      class="wcard"
      class:over={overId === w.id && dragId !== w.id}
      role="listitem"
      ondragover={(e) => {
        if (!dragId) return;
        e.preventDefault();
        overId = w.id;
      }}
      ondrop={(e) => {
        e.preventDefault();
        drop(w.id);
      }}
    >
      <div class="whead">
        <span
          class="grip"
          draggable="true"
          role="button"
          tabindex="-1"
          aria-label="Drag to reorder"
          ondragstart={(e) => {
            dragId = w.id;
            e.dataTransfer?.setData('text/plain', w.id);
          }}
          ondragend={() => (dragId = overId = null)}><Icon name="grip" size={16} /></span
        >
        <Icon name={t.icon} size={16} />
        <input class="input title" placeholder={t.label} value={w.title ?? ''} maxlength="40" oninput={(e) => update(w.id, (x) => ({ ...x, title: (e.target as HTMLInputElement).value || undefined }))} />
        <button class="icon-btn" type="button" title="Move up" onclick={() => move(w.id, -1)}><Icon name="chevron-up" size={15} /></button>
        <button class="icon-btn" type="button" title="Move down" onclick={() => move(w.id, 1)}><Icon name="chevron-down" size={15} /></button>
        <button class="icon-btn" type="button" title="Remove widget" onclick={() => remove(w.id)}><Icon name="trash" size={15} /></button>
      </div>

      {#if w.type === 'games'}
        <div class="items">
          {#each w.items as g, i (i)}
            <div class="it">
              {#if g.cover}<img src={proxiedImage(g.cover, 64)} alt="" />{:else}<span class="nc"><Icon name="gamepad" size={14} /></span>{/if}
              <span class="truncate" style="flex:1">{g.name}</span>
              <button class="icon-btn" type="button" onclick={() => update(w.id, (x) => (x.type === 'games' ? { ...x, items: x.items.filter((_, j) => j !== i) } : x))}><Icon name="x" size={14} /></button>
            </div>
          {/each}
        </div>
        {#if w.items.length < t.max}
          {#if app.instance?.gameSearch}
            <LookupSearch kind="games" onpick={(r) => update(w.id, (x) => (x.type === 'games' ? { ...x, items: [...x.items, { name: r.name, source: r.source ?? 'custom', sourceId: r.source ? r.sourceId : null, cover: r.coverUrl }] } : x))} />
          {/if}
          <div class="row custom">
            <input class="input" placeholder={app.instance?.gameSearch ? 'Or add a custom game' : 'Game name'} bind:value={customName[w.id]} maxlength="100" />
            <button
              class="btn small"
              type="button"
              disabled={!customName[w.id]?.trim() || busy === w.id}
              onclick={() =>
                pickFile(IMG, async (f) => {
                  const up = await uploadTo('game_cover', f, w.id);
                  if (!up) return;
                  const name = customName[w.id]!.trim();
                  customName[w.id] = '';
                  update(w.id, (x) => (x.type === 'games' ? { ...x, items: [...x.items, { name, source: 'custom', sourceId: null, cover: up.url }] } : x));
                })}>+ with cover</button
            >
            <button
              class="btn small"
              type="button"
              disabled={!customName[w.id]?.trim()}
              onclick={() => {
                const name = customName[w.id]!.trim();
                customName[w.id] = '';
                update(w.id, (x) => (x.type === 'games' ? { ...x, items: [...x.items, { name, source: 'custom', sourceId: null, cover: null }] } : x));
              }}>Add</button
            >
          </div>
        {/if}
      {:else if w.type === 'songs'}
        <div class="items">
          {#each w.items as s, i (i)}
            <div class="it">
              {#if s.cover}<img src={proxiedImage(s.cover, 64)} alt="" />{:else}<span class="nc"><Icon name="music" size={14} /></span>{/if}
              <span class="col" style="gap:0;flex:1;min-width:0"><span class="truncate">{s.title}</span><span class="faint small truncate">{s.artist}</span></span>
              <button class="icon-btn" type="button" onclick={() => update(w.id, (x) => (x.type === 'songs' ? { ...x, items: x.items.filter((_, j) => j !== i) } : x))}><Icon name="x" size={14} /></button>
            </div>
          {/each}
        </div>
        {#if w.items.length < t.max}
          {#if app.instance?.musicSearch}
            <LookupSearch kind="music" onpick={(r) => update(w.id, (x) => (x.type === 'songs' ? { ...x, items: [...x.items, { title: r.name, artist: r.subtitle || 'Unknown artist', cover: r.coverUrl }] } : x))} />
          {/if}
          <div class="row custom">
            <input class="input" placeholder="Song title" bind:value={customName[w.id]} maxlength="100" />
            <input class="input" placeholder="Artist" bind:value={customArtist[w.id]} maxlength="100" />
            <button
              class="btn small"
              type="button"
              disabled={!customName[w.id]?.trim() || !customArtist[w.id]?.trim()}
              onclick={() => {
                const title = customName[w.id]!.trim();
                const artist = customArtist[w.id]!.trim();
                customName[w.id] = customArtist[w.id] = '';
                update(w.id, (x) => (x.type === 'songs' ? { ...x, items: [...x.items, { title, artist, cover: null }] } : x));
              }}>Add</button
            >
          </div>
        {/if}
      {:else if w.type === 'currently_into'}
        <div class="chips">
          {#each w.items as c, i (i)}
            <span class="chip">{c.emoji ?? ''} {c.label}<button type="button" onclick={() => update(w.id, (x) => (x.type === 'currently_into' ? { ...x, items: x.items.filter((_, j) => j !== i) } : x))} aria-label="Remove">×</button></span>
          {/each}
        </div>
        {#if w.items.length < t.max}
          <form
            class="row custom"
            onsubmit={(e) => {
              e.preventDefault();
              const label = chipLabel[w.id]?.trim();
              if (!label) return;
              const emoji = chipEmoji[w.id]?.trim() || undefined;
              chipLabel[w.id] = chipEmoji[w.id] = '';
              update(w.id, (x) => (x.type === 'currently_into' ? { ...x, items: [...x.items, { label, emoji }] } : x));
            }}
          >
            <input class="input emoji-in" placeholder="🍜" bind:value={chipEmoji[w.id]} maxlength="16" aria-label="Emoji" />
            <input class="input" placeholder="Ramen, Celeste speedruns, knitting…" bind:value={chipLabel[w.id]} maxlength="40" />
            <button class="btn small" disabled={!chipLabel[w.id]?.trim()}>Add</button>
          </form>
        {/if}
      {:else if w.type === 'photos'}
        <div class="photos">
          {#each w.items as p, i (i)}
            <div class="ph">
              <img src={p.url} alt="" />
              <input
                class="input cap"
                placeholder="Caption"
                value={p.caption ?? ''}
                maxlength="80"
                oninput={(e) => update(w.id, (x) => (x.type === 'photos' ? { ...x, items: x.items.map((it, j) => (j === i ? { ...it, caption: (e.target as HTMLInputElement).value || undefined } : it)) } : x))}
              />
              <button class="icon-btn rm" type="button" onclick={() => update(w.id, (x) => (x.type === 'photos' ? { ...x, items: x.items.filter((_, j) => j !== i) } : x))}><Icon name="x" size={14} /></button>
            </div>
          {/each}
          {#if w.items.length < t.max}
            <button
              class="ph add"
              type="button"
              disabled={busy === w.id}
              onclick={() =>
                pickFile(IMG, async (f) => {
                  const up = await uploadTo('widget_photo', f, w.id);
                  if (up) update(w.id, (x) => (x.type === 'photos' ? { ...x, items: [...x.items, { url: up.url }] } : x));
                })}
            >
              <Icon name={busy === w.id ? 'hourglass' : 'plus'} size={22} />
            </button>
          {/if}
        </div>
      {:else if w.type === 'text'}
        <textarea
          class="textarea"
          rows="4"
          maxlength="1000"
          placeholder="Markdown works here"
          value={w.content}
          oninput={(e) => update(w.id, (x) => (x.type === 'text' ? { ...x, content: (e.target as HTMLTextAreaElement).value } : x))}
        ></textarea>
      {/if}
    </div>
  {/each}

  {#if widgets.length < Limits.WIDGETS_MAX}
    {#if adding}
      <div class="addmenu">
        {#each TYPES as t (t.type)}
          <button class="btn" type="button" onclick={() => add(t.type)}><Icon name={t.icon} size={15} /> {t.label}</button>
        {/each}
        <button class="btn ghost" type="button" onclick={() => (adding = false)}>Cancel</button>
      </div>
    {:else}
      <button class="btn ghost block" type="button" onclick={() => (adding = true)}><Icon name="plus" size={15} /> Add widget ({widgets.length}/{Limits.WIDGETS_MAX})</button>
    {/if}
  {/if}
</div>

<style>
  .wcard {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px;
    margin-bottom: 10px;
    background: var(--bg-1);
    border-top-width: 2px;
  }
  .wcard.over {
    border-top-color: var(--accent);
  }
  .whead {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }
  .grip {
    cursor: grab;
    color: var(--text-faint);
    display: grid;
  }
  .title {
    flex: 1;
    padding: 5px 8px;
  }
  .items .it {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
  }
  .it img,
  .nc {
    width: 30px;
    height: 30px;
    object-fit: cover;
    border-radius: 4px;
    display: grid;
    place-items: center;
    background: var(--bg-3);
    flex: none;
  }
  .custom {
    gap: 6px;
    margin-top: 6px;
  }
  .custom .input {
    flex: 1;
    min-width: 0;
  }
  .emoji-in {
    flex: 0 0 56px !important;
    text-align: center;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 4px 3px 10px;
    border-radius: 99px;
    background: var(--bg-3);
  }
  .chip button {
    border: none;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0 4px;
  }
  .photos {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .ph {
    position: relative;
    aspect-ratio: 1;
    border-radius: 8px;
    overflow: hidden;
    background: var(--bg-3);
  }
  .ph img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ph .cap {
    position: absolute;
    left: 4px;
    right: 4px;
    bottom: 4px;
    padding: 3px 6px;
    font-size: 0.75rem;
  }
  .ph .rm {
    position: absolute;
    top: 3px;
    right: 3px;
    background: rgb(0 0 0 / 0.5);
    color: #fff;
  }
  .ph.add {
    border: 2px dashed var(--border);
    cursor: pointer;
    display: grid;
    place-items: center;
    color: var(--text-muted);
  }
  .addmenu {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
</style>
