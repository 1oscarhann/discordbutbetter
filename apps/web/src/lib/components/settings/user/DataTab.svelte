<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, del } from '$lib/api';
  import Modal from '../../Modal.svelte';

  let open = $state(false);
  let password = $state('');
  let deleteMessages = $state(false);
  let typed = $state('');
  let error = $state('');
  let busy = $state(false);
  const owned = $derived([...app.guilds.values()].filter((g) => g.guild.ownerId === app.me?.id));

  async function remove(e: Event) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await del('/users/@me', { password, deleteMessages });
      location.href = '/login?deleted=1';
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<h2>Data & deletion</h2>

<h3>Download your data</h3>
<p class="muted">A JSON file with everything stored about you: account, sessions, relationships, server memberships, every message you've sent, bookmarks and file list.</p>
<a class="btn" href="/api/users/@me/export" download>Download my data</a>

<h3>Delete account</h3>
<p class="muted">
  Your profile, friends, files, bookmarks and settings are deleted and your name becomes "Deleted user". Messages you sent stay (so conversations still make
  sense) unless you choose to delete them too. This can't be undone.
</p>
{#if owned.length}
  <p class="error-text">You own {owned.map((g) => g.guild.name).join(', ')}. Transfer or delete {owned.length === 1 ? 'it' : 'them'} first.</p>
{/if}
<button class="btn danger" disabled={owned.length > 0} onclick={() => ((open = true), (password = typed = ''), (error = ''))}>Delete my account</button>

{#if open}
  <Modal title="Delete your account" onclose={() => (open = false)} width={460}>
    <form id="del" onsubmit={remove}>
      <label class="srow">
        <span class="txt"><strong>Also delete every message I've sent</strong><small>Can take a while on big accounts</small></span>
        <input type="checkbox" class="switch" bind:checked={deleteMessages} />
      </label>
      <div class="field" style="margin-top:12px">
        <label for="pw">Password</label>
        <input id="pw" class="input" type="password" bind:value={password} autocomplete="current-password" required />
      </div>
      <div class="field">
        <label for="ty">Type DELETE to confirm</label>
        <input id="ty" class="input" bind:value={typed} />
      </div>
      {#if error}<p class="error-text">{error}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (open = false)}>Cancel</button>
      <button class="btn danger" type="submit" form="del" disabled={busy || typed !== 'DELETE' || !password}>Delete forever</button>
    {/snippet}
  </Modal>
{/if}
