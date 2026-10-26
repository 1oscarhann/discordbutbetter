<script lang="ts">
  import { goto } from '$app/navigation';
  import { Permissions as P } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, errorMessage, get } from '$lib/api';
  import type { Channel } from '@dbb/shared';
  import MessageList from '../chat/MessageList.svelte';
  import Composer from '../chat/Composer.svelte';
  import Icon from '../Icon.svelte';

  let { threadId }: { threadId: string } = $props();
  let fetched = $state<Channel | null>(null);
  const thread = $derived(app.channel(threadId) ?? fetched);
  let composer = $state<ReturnType<typeof Composer> | null>(null);

  // archived threads aren't in the live list; fetch them
  $effect(() => {
    if (!app.channel(threadId)) void get<Channel>(`/channels/${threadId}`).then((c) => (fetched = c)).catch(() => (ui.thread = null));
  });

  const canManage = $derived(thread?.guildId ? app.can(P.MANAGE_THREADS, thread.guildId, threadId) : false);
  const isOwner = $derived(thread?.threadMeta?.ownerId === app.me?.id);

  async function setFlag(patch: Record<string, unknown>) {
    try {
      fetched = await api<Channel>('PATCH', `/channels/${threadId}`, patch);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

{#if thread}
  <aside class="pane">
    <header>
      <Icon name="thread" size={18} />
      <strong class="truncate">{thread.name}</strong>
      <span class="spacer"></span>
      {#if canManage}
        <button class="icon-btn" title={thread.threadMeta?.locked ? 'Unlock' : 'Lock'} onclick={() => setFlag({ locked: !thread.threadMeta?.locked })}>
          <Icon name="lock" size={17} />
        </button>
      {/if}
      {#if canManage || isOwner}
        <button class="icon-btn" title={thread.threadMeta?.archived ? 'Unarchive' : 'Archive'} onclick={() => setFlag({ archived: !thread.threadMeta?.archived })}>
          <Icon name="inbox" size={17} />
        </button>
      {/if}
      <button class="icon-btn" title="Open full view" onclick={() => goto(`/app/${thread.guildId}/${thread.id}`)}><Icon name="maximize" size={17} /></button>
      <button class="icon-btn" title="Close" onclick={() => (ui.thread = null)}><Icon name="x" size={18} /></button>
    </header>
    <MessageList channel={thread} embedded onEditLast={() => composer?.editLast()} onReply={(id) => composer?.replyTo(id)} />
    <Composer bind:this={composer} channel={thread} />
  </aside>
{/if}

<style>
  .pane {
    width: min(440px, 45%);
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--bg-0);
    background: var(--bg-2);
  }
  header {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--bg-0);
  }
  @media (max-width: 1100px) {
    .pane {
      position: absolute;
      right: 0;
      top: 48px;
      bottom: 0;
      width: min(440px, 100%);
      z-index: 30;
      box-shadow: var(--shadow);
    }
  }
</style>
