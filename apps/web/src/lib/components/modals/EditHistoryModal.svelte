<script lang="ts">
  import type { MessageEdit, Message } from '@haunt/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { get } from '$lib/api';
  import { fullDate } from '$lib/util/time';
  import Modal from '../Modal.svelte';
  import Markdown from '../Markdown.svelte';

  let { channelId, messageId }: { channelId: string; messageId: string } = $props();
  let edits = $state<MessageEdit[] | null>(null);
  const msg = $derived(app.messages.get(channelId)?.list.find((m) => m.id === messageId) as Message | undefined);

  $effect(() => {
    void get<MessageEdit[]>(`/channels/${channelId}/messages/${messageId}/edits`).then((e) => (edits = e)).catch(() => (edits = []));
  });
</script>

<Modal title="Edit history" onclose={() => { ui.editHistory = null; }} width={560}>
  {#if msg}
    <div class="ver current">
      <div class="faint small">Current · edited {msg.editedAt ? fullDate(msg.editedAt) : ''}</div>
      <Markdown content={msg.content} guildId={msg.guildId} />
    </div>
  {/if}
  {#if edits === null}
    <p class="faint">Loading…</p>
  {:else}
    {#each edits as e, i (i)}
      <div class="ver">
        <div class="faint small">{i === edits.length - 1 ? 'Original' : 'Earlier version'} · replaced {fullDate(e.replacedAt)}</div>
        <Markdown content={e.content} guildId={msg?.guildId ?? null} />
      </div>
    {/each}
  {/if}
</Modal>

<style>
  .ver {
    padding: 10px 12px;
    border-left: 3px solid var(--bg-3);
    margin-bottom: 10px;
    background: var(--bg-0);
    border-radius: 0 6px 6px 0;
  }
  .ver.current {
    border-left-color: var(--accent);
  }
  .small {
    font-size: 0.78rem;
    margin-bottom: 4px;
  }
</style>
