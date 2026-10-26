<script lang="ts">
  import { Limits } from '@dbb/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, put } from '$lib/api';
  import Modal from '../Modal.svelte';
  import Popover from '../Popover.svelte';
  import EmojiPicker from '../chat/EmojiPicker.svelte';

  const cur = app.presence(app.me!.id).customStatus;
  let text = $state(cur?.text ?? '');
  let emoji = $state(cur?.emoji ?? '');
  let expires = $state<number | null>(null);
  let picker = $state<HTMLElement | null>(null);
  let error = $state('');

  async function save() {
    error = '';
    try {
      await put('/users/@me/custom-status', { text, emoji: emoji || null, expiresInSeconds: expires });
      ui.customStatus = false;
    } catch (e) {
      error = errorMessage(e);
    }
  }
</script>

<Modal title="Set a custom status" onclose={() => (ui.customStatus = false)}>
  <div class="field">
    <label for="cs">What's up?</label>
    <div class="row">
      <button class="btn emoji" onclick={(e) => (picker = e.currentTarget)}>{emoji || '🙂'}</button>
      <input id="cs" class="input" bind:value={text} maxlength={Limits.CUSTOM_STATUS_MAX} placeholder="Vibing" />
    </div>
  </div>
  <div class="field">
    <label for="exp">Clear after</label>
    <select id="exp" class="select" bind:value={expires}>
      <option value={1800}>30 minutes</option>
      <option value={3600}>1 hour</option>
      <option value={4 * 3600}>4 hours</option>
      <option value={86400}>Today (24h)</option>
      <option value={7 * 86400}>This week</option>
      <option value={null}>Don't clear</option>
    </select>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (ui.customStatus = false)}>Cancel</button>
    <button class="btn primary" disabled={!text.trim() && !emoji} onclick={save}>Save</button>
  {/snippet}
</Modal>

{#if picker}
  <Popover anchor={picker} onclose={() => (picker = null)}>
    <EmojiPicker onpick={(e) => ((emoji = e.reactionKey.startsWith('c:') ? emoji : e.text), (picker = null))} />
  </Popover>
{/if}

<style>
  .emoji {
    font-size: 1.2rem;
    padding: 6px 10px;
  }
</style>
