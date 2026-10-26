<script lang="ts">
  import { page } from '$app/state';
  import AuthShell from '$lib/components/AuthShell.svelte';
  import { errorMessage, post } from '$lib/api';

  const token = page.url.searchParams.get('token') ?? '';
  let password = $state('');
  let confirm = $state('');
  let done = $state(false);
  let error = $state('');
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    if (password !== confirm) {
      error = "Passwords don't match";
      return;
    }
    busy = true;
    error = '';
    try {
      await post('/auth/reset-password', { token, password });
      done = true;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AuthShell title="Choose a new password">
  {#if !token}
    <p class="error-text">This link is missing its token.</p>
  {:else if done}
    <p>Password changed. All your other sessions were logged out.</p>
    <a class="btn primary block" href="/login">Log in</a>
  {:else}
    <form onsubmit={submit}>
      <div class="field">
        <label for="pw">New password</label>
        <input id="pw" class="input" type="password" bind:value={password} autocomplete="new-password" minlength="8" required />
      </div>
      <div class="field">
        <label for="pw2">Confirm</label>
        <input id="pw2" class="input" type="password" bind:value={confirm} autocomplete="new-password" required />
      </div>
      {#if error}<p class="error-text">{error}</p>{/if}
      <button class="btn primary block" disabled={busy}>Set password</button>
    </form>
  {/if}
</AuthShell>
