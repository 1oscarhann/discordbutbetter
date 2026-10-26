<script lang="ts">
  import type { Invite } from '@dbb/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, post } from '$lib/api';
  import { copy } from '$lib/util/channel';
  import Modal from '../Modal.svelte';

  let { channelId }: { channelId: string } = $props();
  const channel = $derived(app.channel(channelId));
  let maxAge = $state(7 * 86400);
  let maxUses = $state(0);
  let invite = $state<Invite | null>(null);
  let error = $state('');

  async function make() {
    error = '';
    try {
      invite = await post<Invite>(`/channels/${channelId}/invites`, { maxAgeSeconds: maxAge, maxUses });
    } catch (e) {
      error = errorMessage(e);
    }
  }

  $effect(() => {
    void maxAge;
    void maxUses;
    void make();
  });

  const url = $derived(invite ? `${location.origin}/invite/${invite.code}` : '');
</script>

<Modal title="Invite friends to {channel?.guildId ? app.guilds.get(channel.guildId)?.guild.name : ''}" onclose={() => (ui.invite = null)}>
  <div class="field">
    <label for="iurl">Invite link</label>
    <div class="row">
      <input id="iurl" class="input" readonly value={url} onfocus={(e) => (e.target as HTMLInputElement).select()} />
      <button class="btn primary" disabled={!url} onclick={() => copy(url, 'Invite link copied')}>Copy</button>
    </div>
  </div>
  <div class="row">
    <div class="field" style="flex:1">
      <label for="age">Expires after</label>
      <select id="age" class="select" bind:value={maxAge}>
        <option value={1800}>30 minutes</option>
        <option value={3600}>1 hour</option>
        <option value={86400}>1 day</option>
        <option value={7 * 86400}>7 days</option>
        <option value={30 * 86400}>30 days</option>
        <option value={0}>Never</option>
      </select>
    </div>
    <div class="field" style="flex:1">
      <label for="uses">Max uses</label>
      <select id="uses" class="select" bind:value={maxUses}>
        <option value={0}>No limit</option>
        {#each [1, 5, 10, 25, 50, 100] as n (n)}<option value={n}>{n}</option>{/each}
      </select>
    </div>
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
</Modal>
