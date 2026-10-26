<script lang="ts">
  import AuthShell from '$lib/components/AuthShell.svelte';
  import { errorMessage, post } from '$lib/api';

  let email = $state('');
  let sent = $state(false);
  let error = $state('');
  let busy = $state(false);

  async function submit(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      await post('/auth/forgot-password', { email });
      sent = true;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AuthShell title="Reset your password">
  {#if sent}
    <p>If an account exists for <strong>{email}</strong>, a reset link is on its way. It expires in an hour.</p>
    <a class="btn block" href="/login">Back to login</a>
  {:else}
    <form onsubmit={submit}>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" class="input" type="email" bind:value={email} required />
      </div>
      {#if error}<p class="error-text">{error}</p>{/if}
      <button class="btn primary block" disabled={busy}>Send reset link</button>
      <p class="hint" style="margin-top:14px"><a href="/login">Back to login</a></p>
    </form>
  {/if}
</AuthShell>
