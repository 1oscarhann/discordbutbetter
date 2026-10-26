<script lang="ts">
  import { goto } from '$app/navigation';
  import type { FullGuild } from '@haunt/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { errorMessage, post, type UploadedFile } from '$lib/api';
  import Modal from '../Modal.svelte';
  import ImagePicker from '../ImagePicker.svelte';
  import { app } from '$lib/state/app.svelte';

  let name = $state(`${app.me?.displayName || app.me?.username}'s server`);
  let icon = $state<UploadedFile | null>(null);
  let error = $state('');
  let busy = $state(false);

  async function create(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      const g = await post<FullGuild>('/guilds', { name, iconFileId: icon?.id ?? null });
      // use the response right away instead of waiting for the gateway's GUILD_CREATE
      app.handle('GUILD_CREATE', g);
      ui.createGuild = false;
      goto(`/app/${g.id}`);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Create a server" onclose={() => { ui.createGuild = false; }}>
  <form id="cg" onsubmit={create}>
    <p class="muted">Your server is where you and your friends hang out. Everything is free — big uploads, custom emoji, HD streams.</p>
    <div class="field"><ImagePicker purpose="guild_icon" label="Upload icon" round onchange={(f) => (icon = f)} /></div>
    <div class="field">
      <label for="gn">Server name</label>
      <input id="gn" class="input" bind:value={name} maxlength="100" required />
    </div>
    {#if error}<p class="error-text">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button class="btn ghost" onclick={() => { ui.createGuild = false; }}>Cancel</button>
    <button class="btn primary" form="cg" disabled={busy || name.trim().length < 2}>Create</button>
  {/snippet}
</Modal>
