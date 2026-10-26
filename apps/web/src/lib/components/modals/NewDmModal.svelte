<script lang="ts">
  import { goto } from '$app/navigation';
  import { Limits, RelationshipType, type Channel } from '@dbb/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, post } from '$lib/api';
  import Modal from '../Modal.svelte';
  import Avatar from '../Avatar.svelte';

  let q = $state('');
  let picked = $state<string[]>([]);
  let error = $state('');
  let busy = $state(false);
  const friends = $derived(
    [...app.relationships.values()]
      .filter((r) => r.type === RelationshipType.FRIEND)
      .filter((r) => !q || app.displayName(r.user.id).toLowerCase().includes(q.toLowerCase()) || r.user.username.includes(q.toLowerCase())),
  );

  function toggle(id: string) {
    picked = picked.includes(id) ? picked.filter((x) => x !== id) : picked.length < Limits.GROUP_DM_MAX - 1 ? [...picked, id] : picked;
  }

  async function start() {
    busy = true;
    error = '';
    try {
      const c = await post<Channel>('/users/@me/channels', { recipientIds: picked });
      ui.newDm = false;
      goto(`/app/me/${c.id}`);
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="New message" onclose={() => (ui.newDm = false)}>
  <p class="faint small">Pick one friend for a DM, or up to {Limits.GROUP_DM_MAX - 1} for a group. To DM someone who isn't a friend, open their profile from a shared server.</p>
  <input class="input" placeholder="Search friends" bind:value={q} />
  <div class="list scroll">
    {#each friends as r (r.user.id)}
      <label class="f">
        <Avatar src={app.avatarOf(r.user.id)} name={app.displayName(r.user.id)} size={30} status={app.presence(r.user.id).status} />
        <span class="truncate" style="flex:1">{app.displayName(r.user.id)} <span class="faint">@{r.user.username}</span></span>
        <input type="checkbox" checked={picked.includes(r.user.id)} onchange={() => toggle(r.user.id)} />
      </label>
    {:else}
      <p class="faint">No friends to show.</p>
    {/each}
  </div>
  {#if error}<p class="error-text">{error}</p>{/if}
  {#snippet footer()}
    <button class="btn ghost" onclick={() => (ui.newDm = false)}>Cancel</button>
    <button class="btn primary" disabled={busy || !picked.length} onclick={start}>{picked.length > 1 ? 'Create group' : 'Message'}</button>
  {/snippet}
</Modal>

<style>
  .list {
    max-height: 320px;
    margin-top: 10px;
  }
  .f {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px;
    border-radius: 6px;
    cursor: pointer;
  }
  .f:hover {
    background: var(--hover);
  }
  .small {
    font-size: 0.82rem;
  }
</style>
