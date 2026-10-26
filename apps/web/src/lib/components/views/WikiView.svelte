<script lang="ts">
  import { Limits, Permissions as P, type Channel, type WikiPage, type WikiRevision } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, del, errorMessage, get, post } from '$lib/api';
  import { fullDate, timeAgo } from '$lib/util/time';
  import Icon from '../Icon.svelte';
  import Markdown from '../Markdown.svelte';

  let { channel }: { channel: Channel } = $props();
  const pages = $derived(app.wiki.get(channel.id) ?? null);
  const canEdit = $derived(app.can(P.MANAGE_WIKI, channel.guildId, channel.id));
  let selected = $state<string | null>(null);
  const page = $derived(pages?.find((p) => p.id === selected) ?? pages?.[0] ?? null);

  let editing = $state<'new' | 'edit' | null>(null);
  let title = $state('');
  let content = $state('');
  let pinned = $state(false);
  let preview = $state(false);
  let revisions = $state<WikiRevision[] | null>(null);
  let viewingRev = $state<WikiRevision | null>(null);
  let busy = $state(false);

  $effect(() => {
    const id = channel.id;
    if (!app.wiki.has(id)) void get<WikiPage[]>(`/channels/${id}/wiki`).then((l) => app.wiki.set(id, l)).catch((e) => app.toast(errorMessage(e), 'error'));
  });

  function startNew() {
    editing = 'new';
    title = '';
    content = '';
    pinned = false;
    preview = false;
    revisions = null;
  }

  function startEdit() {
    if (!page) return;
    editing = 'edit';
    title = page.title;
    content = page.content;
    pinned = page.pinned;
    preview = false;
    revisions = null;
  }

  async function save() {
    busy = true;
    try {
      if (editing === 'new') {
        const p = await post<WikiPage>(`/channels/${channel.id}/wiki`, { title, content, pinned });
        selected = p.id;
      } else if (page) {
        await api('PATCH', `/channels/${channel.id}/wiki/${page.id}`, { title, content, pinned });
      }
      editing = null;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    } finally {
      busy = false;
    }
  }

  async function showRevisions() {
    if (!page) return;
    revisions = await get<WikiRevision[]>(`/channels/${channel.id}/wiki/${page.id}/revisions`).catch(() => []);
  }

  async function restore(r: WikiRevision) {
    if (!page) return;
    try {
      await api('PATCH', `/channels/${channel.id}/wiki/${page.id}`, { title: r.title, content: r.content });
      viewingRev = null;
      revisions = null;
      app.toast('Restored', 'success');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<header class="hdr">
  <button class="icon-btn burger" aria-label="Menu" onclick={() => (ui.mobileNav = true)}><Icon name="menu" /></button>
  <Icon name="book" class="faint" />
  <strong>{channel.name}</strong>
  {#if channel.topic}<span class="faint truncate">— {channel.topic}</span>{/if}
  <span class="spacer"></span>
  {#if canEdit}<button class="btn small primary" onclick={startNew}><Icon name="plus" size={16} /> New page</button>{/if}
</header>

<div class="body">
  <nav class="pages scroll">
    {#if pages === null}
      <p class="faint small">Loading…</p>
    {:else}
      {#each pages as p (p.id)}
        <button class="pg" class:active={page?.id === p.id && !editing} onclick={() => ((selected = p.id), (editing = null), (revisions = null))}>
          {#if p.pinned}<Icon name="pin" size={13} />{/if}
          <span class="truncate">{p.title}</span>
        </button>
      {:else}
        <p class="faint small">No pages yet.{canEdit ? ' Write the first one!' : ''}</p>
      {/each}
    {/if}
  </nav>

  <article class="doc scroll">
    {#if editing}
      <div class="editor">
        <input class="input titlein" placeholder="Page title" bind:value={title} maxlength={Limits.WIKI_TITLE_MAX} />
        <div class="row">
          <div class="tabs" style="margin:0;border:none">
            <button class="tab" class:active={!preview} onclick={() => (preview = false)}>Write</button>
            <button class="tab" class:active={preview} onclick={() => (preview = true)}>Preview</button>
          </div>
          <span class="spacer"></span>
          <label class="row small"><input type="checkbox" bind:checked={pinned} /> Pin to top</label>
        </div>
        {#if preview}
          <div class="rendered"><Markdown content={content || '*Nothing yet*'} guildId={channel.guildId} jumboAllowed={false} /></div>
        {:else}
          <textarea class="textarea body-in" bind:value={content} maxlength={Limits.WIKI_CONTENT_MAX} placeholder="Markdown: # headings, **bold**, lists, links, `code`…"></textarea>
        {/if}
        <div class="row">
          <span class="faint small">{content.length} / {Limits.WIKI_CONTENT_MAX}</span>
          <span class="spacer"></span>
          <button class="btn ghost" onclick={() => (editing = null)}>Cancel</button>
          <button class="btn primary" disabled={busy || !title.trim()} onclick={save}>Save</button>
        </div>
      </div>
    {:else if viewingRev}
      <div class="revhead row">
        <strong>Revision from {fullDate(viewingRev.createdAt)}</strong>
        <span class="faint">by {viewingRev.editor ? app.displayName(viewingRev.editor.id, channel.guildId) : 'unknown'}</span>
        <span class="spacer"></span>
        <button class="btn small ghost" onclick={() => (viewingRev = null)}>Back</button>
        {#if canEdit}<button class="btn small primary" onclick={() => restore(viewingRev!)}>Restore this version</button>{/if}
      </div>
      <h1>{viewingRev.title}</h1>
      <Markdown content={viewingRev.content} guildId={channel.guildId} jumboAllowed={false} />
    {:else if page}
      <div class="meta row">
        <span class="faint small">Updated {timeAgo(page.updatedAt)}{page.updatedBy ? ` by ${app.displayName(page.updatedBy.id, channel.guildId)}` : ''}</span>
        <span class="spacer"></span>
        <button class="btn small ghost" onclick={showRevisions}><Icon name="clock" size={14} /> History</button>
        {#if canEdit}
          <button class="btn small" onclick={startEdit}><Icon name="edit" size={14} /> Edit</button>
          <button
            class="btn small danger"
            onclick={() => ui.confirm(`Delete “${page.title}”?`, 'The page and its history will be gone.', 'Delete page', async () => {
              await del(`/channels/${channel.id}/wiki/${page.id}`);
              selected = null;
            })}><Icon name="trash" size={14} /></button
          >
        {/if}
      </div>
      <h1>{page.title}</h1>
      <Markdown content={page.content} guildId={channel.guildId} jumboAllowed={false} />
      {#if revisions}
        <div class="revs card">
          <strong>History</strong>
          {#each revisions as r (r.id)}
            <button class="rev" onclick={() => (viewingRev = r)}>
              <span>{fullDate(r.createdAt)}</span>
              <span class="faint">{r.editor ? app.displayName(r.editor.id, channel.guildId) : 'unknown'}</span>
            </button>
          {/each}
        </div>
      {/if}
    {:else if pages}
      <div class="emptydoc">
        <Icon name="book" size={40} />
        <p class="muted">This wiki is empty.</p>
        {#if canEdit}<button class="btn primary" onclick={startNew}>Write the first page</button>{/if}
      </div>
    {/if}
  </article>
</div>

<style>
  .hdr {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 0 16px;
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
  .pages {
    width: 230px;
    flex: none;
    padding: 10px 8px;
    border-right: 1px solid var(--border);
  }
  .pg {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 7px 10px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-muted);
    text-align: left;
  }
  .pg:hover {
    background: var(--hover);
  }
  .pg.active {
    background: var(--active);
    color: var(--text);
    font-weight: 600;
  }
  .doc {
    flex: 1;
    padding: 20px 32px 60px;
    max-width: 900px;
  }
  .doc h1 {
    margin: 8px 0 16px;
    font-size: 2rem;
  }
  .doc :global(.md) {
    line-height: 1.6;
  }
  .meta {
    border-bottom: 1px solid var(--border);
    padding-bottom: 8px;
  }
  .small {
    font-size: 0.8rem;
  }
  .editor {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .titlein {
    font-size: 1.4rem;
    font-weight: 700;
  }
  .body-in {
    min-height: 50vh;
    font-family: var(--mono);
    font-size: 0.9rem;
  }
  .rendered {
    min-height: 50vh;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px;
  }
  .revs {
    margin-top: 24px;
  }
  .rev {
    display: flex;
    justify-content: space-between;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .rev:hover {
    background: var(--hover);
  }
  .revhead {
    margin-bottom: 8px;
  }
  .emptydoc {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding-top: 15vh;
    color: var(--text-faint);
  }
  @media (max-width: 760px) {
    .burger {
      display: inline-grid;
    }
    .pages {
      width: 140px;
    }
    .doc {
      padding: 16px;
    }
  }
</style>
