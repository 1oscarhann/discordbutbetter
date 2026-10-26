<script lang="ts">
  import { ChannelType, Permissions as P, isDmType } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { get } from '$lib/api';
  import ChannelHeader from './ChannelHeader.svelte';
  import MessageList from './MessageList.svelte';
  import Composer from './Composer.svelte';
  import RightPanel from '../panels/RightPanel.svelte';
  import ThreadPane from '../panels/ThreadPane.svelte';

  let { channelId, embedded = false }: { channelId: string; embedded?: boolean } = $props();
  const channel = $derived(app.channel(channelId));
  const guildId = $derived(channel?.guildId ?? null);
  let composer = $state<ReturnType<typeof Composer> | null>(null);

  // track focus for acks and notifications (the embedded thread pane doesn't steal it)
  $effect(() => {
    if (embedded) return;
    app.focusedChannel = channelId;
    try {
      if (channel) localStorage.setItem('lastPath', location.pathname);
    } catch {
      /* ignore */
    }
    return () => {
      if (app.focusedChannel === channelId) app.focusedChannel = null;
    };
  });

  // DMs: load read receipts once
  $effect(() => {
    if (!channel || !isDmType(channel.type) || app.receipts.has(channelId)) return;
    void get<{ userId: string; messageId: string }[]>(`/channels/${channelId}/read-receipts`).then(async (rows) => {
      const { SvelteMap } = await import('svelte/reactivity');
      const m = new SvelteMap<string, string>();
      for (const r of rows) m.set(r.userId, r.messageId);
      app.receipts.set(channelId, m);
    });
  });

  const showSide = $derived(!embedded && (!!ui.thread || (ui.rightPanel && (ui.rightPanel !== 'members' || !!guildId))));
</script>

{#if channel}
  <div class="chat" class:embedded>
    {#if !embedded}<ChannelHeader {channel} />{/if}
    <div class="body">
      <div class="col-main">
        <MessageList {channel} {embedded} onEditLast={() => composer?.editLast()} onReply={(id) => composer?.replyTo(id)} />
        <Composer bind:this={composer} {channel} />
      </div>
      {#if showSide}
        {#if ui.thread && !embedded}
          <ThreadPane threadId={ui.thread} />
        {:else if ui.rightPanel}
          <RightPanel {channel} panel={ui.rightPanel} />
        {/if}
      {/if}
    </div>
  </div>
{:else}
  <div class="missing">
    <p class="muted">This channel doesn't exist or you can't see it.</p>
  </div>
{/if}

<style>
  .chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .col-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .missing {
    flex: 1;
    display: grid;
    place-items: center;
  }
</style>
