<script lang="ts">
  import { goto } from '$app/navigation';
  import { ui } from '$lib/state/ui.svelte';
  import { errorMessage, post } from '$lib/api';
  import Modal from '../Modal.svelte';

  let link = $state('');
  let error = $state('');
  let busy = $state(false);

  function codeOf(s: string): string {
    const t = s.trim();
    const m = t.match(/\/invite\/([A-Za-z0-9]+)/);
    return m ? m[1]! : t;
  }

  async function join(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const r = await post<{ guildId: string }>(`/invites/${encodeURIComponent(codeOf(link))}`);
      ui.joinGuild = false;
      goto(`/app/${r.guildId}`);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Join a server" onclose={() => { ui.joinGuild = false; }}>
  <form id="jg" onsubmit={join}>
    <div class="field">
      <label for="inv">Invite link or code</label>
      <input id="inv" class="input" bind:value={link} placeholder="https://…/invite/abc123 or abc123" required />
    </div>
    {#if error}<p class="error-text">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button class="btn ghost" onclick={() => { ui.joinGuild = false; }}>Cancel</button>
    <button class="btn primary" form="jg" disabled={busy || !link.trim()}>Join</button>
  {/snippet}
</Modal>
