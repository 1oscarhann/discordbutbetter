<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import AuthShell from '$lib/components/AuthShell.svelte';
  import { errorMessage, post } from '$lib/api';

  let state = $state<'working' | 'ok' | 'error'>('working');
  let error = $state('');

  onMount(async () => {
    try {
      await post('/auth/verify-email', { token: page.url.searchParams.get('token') ?? '' });
      state = 'ok';
    } catch (e) {
      error = errorMessage(e);
      state = 'error';
    }
  });
</script>

<AuthShell title="Email verification">
  {#if state === 'working'}
    <p class="muted">Checking your link…</p>
  {:else if state === 'ok'}
    <p>Your email is confirmed. 🎉</p>
    <a class="btn primary block" href="/app">Open the app</a>
  {:else}
    <p class="error-text">{error}</p>
    <a class="btn block" href="/app">Open the app</a>
  {/if}
</AuthShell>
