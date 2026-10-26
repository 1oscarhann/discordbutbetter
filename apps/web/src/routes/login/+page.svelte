<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AuthShell from '$lib/components/AuthShell.svelte';
  import { errorMessage, post } from '$lib/api';

  let login = $state('');
  let password = $state('');
  let error = $state('');
  let busy = $state(false);

  function safeNext(): string {
    const n = page.url.searchParams.get('next') ?? '/app';
    // only same-site relative paths, never //evil.com
    return n.startsWith('/') && !n.startsWith('//') ? n : '/app';
  }

  async function submit(e: Event) {
    e.preventDefault();
    error = '';
    busy = true;
    try {
      await post('/auth/login', { login, password });
      location.href = safeNext();
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AuthShell title="Welcome back">
  <form onsubmit={submit}>
    <div class="field">
      <label for="login">Email or username</label>
      <input id="login" class="input" bind:value={login} autocomplete="username" required />
    </div>
    <div class="field">
      <label for="pw">Password</label>
      <input id="pw" class="input" type="password" bind:value={password} autocomplete="current-password" required />
      <a class="hint" href="/forgot">Forgot your password?</a>
    </div>
    {#if error}<p class="error-text">{error}</p>{/if}
    <button class="btn primary block" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
    <p class="hint" style="margin-top:14px">New here? <a href="/register{page.url.search}">Create an account</a></p>
  </form>
</AuthShell>
