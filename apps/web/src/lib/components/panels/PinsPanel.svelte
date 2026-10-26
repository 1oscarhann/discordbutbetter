<script lang="ts">
  import type { Channel, Message } from '@haunt/shared';
  import { get } from '$lib/api';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import MiniMessage from './MiniMessage.svelte';

  let { channel }: { channel: Channel } = $props();
  let pins = $state<Message[] | null>(null);

  $effect(() => {
    const id = channel.id;
    // refetch when a pin changes in the loaded list
    void app.messages.get(id)?.list.filter((m) => m.pinned).length;
    pins = null;
    void get<Message[]>(`/channels/${id}/pins`).then((p) => (pins = p)).catch(() => (pins = []));
  });
</script>

<div class="scroll body">
  {#if pins === null}
    <p class="faint">Loading…</p>
  {:else if !pins.length}
    <p class="faint empty">Nothing pinned here yet. Pin important messages from their ⋯ menu.</p>
  {:else}
    {#each pins as m (m.id)}
      <MiniMessage message={m} onclick={() => (ui.jumpTo = { channelId: channel.id, messageId: m.id })} />
    {/each}
  {/if}
</div>

<style>
  .body {
    flex: 1;
    padding: 10px;
  }
  .empty {
    text-align: center;
    padding: 20px;
  }
</style>
