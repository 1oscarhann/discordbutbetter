<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Bookmark } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, get, patch, post, put } from '$lib/api';
  import Icon from '../Icon.svelte';
  import MiniMessage from '../panels/MiniMessage.svelte';

  let folder = $state<string>('all');
  let items = $state<Bookmark[] | null>(null);
  let newFolder = $state('');

  async function load() {
    const q = folder === 'all' ? '' : `?folderId=${folder}`;
    try {
      items = await get<Bookmark[]>(`/users/@me/bookmarks${q}`);
      for (const b of items) app.bookmarkIds.add(b.message.id);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
      items = [];
    }
  }

  $effect(() => {
    void folder;
    void app.bookmarkIds.size;
    void load();
  });

  async function createFolder(e: Event) {
    e.preventDefault();
    if (!newFolder.trim()) return;
    try {
      await post('/users/@me/bookmark-folders', { name: newFolder.trim() });
      newFolder = '';
    } catch (err) {
      app.toast(errorMessage(err), 'error');
    }
  }

  async function move(b: Bookmark, folderId: string | null) {
    await put(`/users/@me/bookmarks/${b.message.id}`, { folderId, note: b.note }).catch((e) => app.toast(errorMessage(e), 'error'));
    void load();
  }

  async function saveNote(b: Bookmark, note: string) {
    if (note === b.note) return;
    await put(`/users/@me/bookmarks/${b.message.id}`, { folderId: b.folderId, note }).catch((e) => app.toast(errorMessage(e), 'error'));
  }

  function open(b: Bookmark) {
    const c = app.channel(b.message.channelId);
    if (!c) return;
    ui.jumpTo = { channelId: c.id, messageId: b.message.id };
    goto(c.guildId ? `/app/${c.guildId}/${c.id}` : `/app/me/${c.id}`);
  }

  async function renameFolder(id: string, current: string) {
    const name = prompt('Folder name', current);
    if (name && name.trim()) await patch(`/users/@me/bookmark-folders/${id}`, { name: name.trim() }).catch((e) => app.toast(errorMessage(e), 'error'));
  }
</script>

<header class="hdr">
  <button class="icon-btn burger" aria-label="Menu" onclick={() => { ui.mobileNav = true; }}><Icon name="menu" /></button>
  <Icon name="bookmark" /> <strong>Saved messages</strong>
</header>
<div class="body">
  <nav class="folders scroll">
    <button class="f" class:active={folder === 'all'} onclick={() => (folder = 'all')}>All saved</button>
    <button class="f" class:active={folder === 'none'} onclick={() => (folder = 'none')}>Unsorted</button>
    {#each app.bookmarkFolders as f (f.id)}
      <div class="frow">
        <button class="f" class:active={folder === f.id} onclick={() => (folder = f.id)} ondblclick={() => renameFolder(f.id, f.name)}>📁 {f.name}</button>
        <button
          class="icon-btn mini"
          title="Delete folder"
          onclick={() => ui.confirm(`Delete “${f.name}”?`, 'Messages in it stay saved, just unsorted.', 'Delete folder', async () => {
            await del(`/users/@me/bookmark-folders/${f.id}`);
            if (folder === f.id) folder = 'all';
          })}><Icon name="trash" size={14} /></button
        >
      </div>
    {/each}
    <form onsubmit={createFolder} class="newf">
      <input class="input" placeholder="New folder" bind:value={newFolder} maxlength="50" />
    </form>
  </nav>
  <div class="list scroll">
    {#if items === null}
      <p class="faint">Loading…</p>
    {:else if !items.length}
      <p class="faint empty">Nothing saved here. Use “Save message” from any message’s ⋯ menu.</p>
    {:else}
      {#each items as b (b.message.id)}
        <div class="item">
          <MiniMessage message={b.message} label={b.guildName ? `${b.guildName} · #${b.channelName}` : 'Direct message'} onclick={() => open(b)} />
          <div class="row tools">
            <input class="input note" placeholder="Add a note" value={b.note} onblur={(e) => saveNote(b, (e.target as HTMLInputElement).value)} maxlength="500" />
            <select class="select move" value={b.folderId ?? ''} onchange={(e) => move(b, (e.target as HTMLSelectElement).value || null)}>
              <option value="">Unsorted</option>
              {#each app.bookmarkFolders as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
            </select>
            <button class="icon-btn danger" title="Unsave" onclick={() => del(`/users/@me/bookmarks/${b.message.id}`)}><Icon name="trash" size={16} /></button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .hdr {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
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
  .folders {
    width: 210px;
    flex: none;
    padding: 12px 8px;
    border-right: 1px solid var(--border);
  }
  .frow {
    display: flex;
    align-items: center;
  }
  .f {
    flex: 1;
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-muted);
    font-weight: 600;
  }
  .f:hover {
    background: var(--hover);
  }
  .f.active {
    background: var(--active);
    color: var(--text);
  }
  .mini {
    width: 26px;
    height: 26px;
  }
  .newf {
    margin-top: 10px;
  }
  .list {
    flex: 1;
    padding: 16px 20px;
  }
  .item {
    max-width: 760px;
    margin-bottom: 14px;
  }
  .tools {
    margin-top: -4px;
  }
  .note {
    flex: 1;
    padding: 5px 8px;
    font-size: 0.85rem;
  }
  .move {
    width: 150px;
    padding: 5px;
    font-size: 0.85rem;
  }
  .empty {
    text-align: center;
    padding: 40px;
  }
  @media (max-width: 760px) {
    .burger {
      display: inline-grid;
    }
    .folders {
      display: none;
    }
  }
</style>
