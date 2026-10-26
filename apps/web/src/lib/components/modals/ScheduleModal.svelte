<script lang="ts">
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, post } from '$lib/api';
  import { channelTitle } from '$lib/util/channel';
  import Modal from '../Modal.svelte';

  let { channelId, content: initial, replyTo, silent: initialSilent }: { channelId: string; content: string; replyTo?: { messageId: string; ping: boolean }; silent: boolean } = $props();
  let content = $state(initial);
  let silent = $state(initialSilent);
  const pad = (n: number) => String(n).padStart(2, '0');
  const inHour = new Date(Date.now() + 3600_000);
  let when = $state(`${inHour.getFullYear()}-${pad(inHour.getMonth() + 1)}-${pad(inHour.getDate())}T${pad(inHour.getHours())}:${pad(inHour.getMinutes())}`);
  let error = $state('');
  let busy = $state(false);
  const channel = $derived(app.channel(channelId));

  function preset(mins: number) {
    const d = new Date(Date.now() + mins * 60_000);
    when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function tomorrowMorning() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
  }

  async function schedule() {
    busy = true;
    error = '';
    try {
      await post(`/channels/${channelId}/scheduled-messages`, { content, sendAt: new Date(when).toISOString(), replyTo, silent });
      ui.scheduleFor = null;
      app.toast(`Scheduled for ${new Date(when).toLocaleString()}`, 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Send later" onclose={() => (ui.scheduleFor = null)}>
  <p class="faint small">To {channel?.guildId ? `#${channel.name}` : channelTitle(channel)}</p>
  <div class="field"><textarea class="textarea" bind:value={content} rows="4" placeholder="Message"></textarea></div>
  <div class="row presets">
    <button class="btn small" onclick={() => preset(30)}>In 30 min</button>
    <button class="btn small" onclick={() => preset(120)}>In 2 hours</button>
    <button class="btn small" onclick={tomorrowMorning}>Tomorrow 9:00</button>
  </div>
  <div class="field">
    <label for="when">When</label>
    <input id="when" class="input" type="datetime-local" bind:value={when} />
  </div>
  <label class="row"><input type="checkbox" bind:checked={silent} /> Send silently (no pings)</label>
  {#if error}<p class="error-text">{error}</p>{/if}
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (ui.scheduleFor = null)}>Cancel</button>
    <button class="btn primary" disabled={busy || !content.trim()} onclick={schedule}>Schedule</button>
  {/snippet}
</Modal>

<style>
  .small {
    font-size: 0.82rem;
  }
  .presets {
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
</style>
