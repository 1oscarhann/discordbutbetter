<script lang="ts">
  import { Permissions as P, type Channel } from '@haunt/shared';
  import { errorMessage, get, post } from '$lib/api';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { timeAgo, idTime } from '$lib/util/time';
  import Icon from '../Icon.svelte';

  let { channel }: { channel: Channel } = $props();
  let archived = $state(false);
  let list = $state<Channel[]>([]);
  let name = $state('');
  const canCreate = $derived(app.can(P.CREATE_THREADS, channel.guildId, channel.id));

  $effect(() => {
    void channel.id;
    void archived;
    void get<Channel[]>(`/channels/${channel.id}/threads?archived=${archived}`).then((l) => (list = l)).catch(() => (list = []));
  });

  // keep in sync with live thread updates for active threads
  const live = $derived(archived ? list : [...(app.guilds.get(channel.guildId!)?.threads.values() ?? [])].filter((t) => t.parentId === channel.id));

  async function create(e: Event) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const t = await post<Channel>(`/channels/${channel.id}/threads`, { name: name.trim() });
      name = '';
      ui.thread = t.id;
    } catch (err) {
      app.toast(errorMessage(err), 'error');
    }
  }
</script>

<div class="top">
  <div class="tabs" style="margin:0">
    <button class="tab" class:active={!archived} onclick={() => (archived = false)}>Active</button>
    <button class="tab" class:active={archived} onclick={() => (archived = true)}>Archived</button>
  </div>
  {#if canCreate && !archived}
    <form class="row" onsubmit={create}>
      <input class="input" placeholder="New thread name" bind:value={name} maxlength="100" />
      <button class="btn primary small">Create</button>
    </form>
  {/if}
</div>
<div class="scroll body">
  {#each live as t (t.id)}
    <button class="thread" onclick={() => { ui.thread = t.id; }}>
      <Icon name="thread" size={18} />
      <span class="meta">
        <strong class="truncate">{t.name}</strong>
        <span class="faint small">
          {t.threadMeta?.messageCount ?? 0} {(t.threadMeta?.messageCount ?? 0) === 1 ? 'message' : 'messages'} · {timeAgo(idTime(t.lastMessageId ?? t.id))}
          {#if t.threadMeta?.locked} · 🔒{/if}
        </span>
      </span>
      {#if app.isUnread(t.id)}<span class="dot"></span>{/if}
    </button>
  {:else}
    <p class="faint empty">{archived ? 'No archived threads.' : 'No active threads. Start one from a message or above.'}</p>
  {/each}
</div>

<style>
  .top {
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .body {
    flex: 1;
    padding: 8px;
  }
  .thread {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--border);
    background: var(--bg-2);
    border-radius: var(--radius);
    cursor: pointer;
    margin-bottom: 6px;
    text-align: left;
  }
  .thread:hover {
    border-color: var(--accent);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .small {
    font-size: 0.76rem;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text);
  }
  .empty {
    text-align: center;
    padding: 20px;
  }
</style>
