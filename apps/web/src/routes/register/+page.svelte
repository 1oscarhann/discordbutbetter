<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import AuthShell from '$lib/components/AuthShell.svelte';
  import { errorMessage, get, post } from '$lib/api';
  import { RegisterSchema, type InstanceInfo } from '@dbb/shared';

  let username = $state('');
  let email = $state('');
  let password = $state('');
  let confirm = $state('');
  let inviteCode = $state(page.url.searchParams.get('code') ?? '');
  let error = $state('');
  let busy = $state(false);
  let instance = $state<InstanceInfo | null>(null);

  onMount(async () => {
    instance = await get<InstanceInfo>('/instance').catch(() => null);
  });

  const usernameHint = $derived.by(() => {
    if (!username) return '';
    const r = RegisterSchema.shape.username.safeParse(username);
    return r.success ? '' : (r.error.issues[0]?.message ?? '');
  });

  async function submit(e: Event) {
    e.preventDefault();
    error = '';
    if (password !== confirm) {
      error = "Passwords don't match";
      return;
    }
    const parsed = RegisterSchema.safeParse({ username, email, password, inviteCode: inviteCode || undefined });
    if (!parsed.success) {
      error = parsed.error.issues[0]?.message ?? 'Check the form';
      return;
    }
    busy = true;
    try {
      await post('/auth/register', parsed.data);
      const next = page.url.searchParams.get('next');
      location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app';
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<AuthShell title="Create an account">
  {#if instance?.registration === 'closed'}
    <p class="muted">Sign-ups are closed on this server. Ask whoever runs it for an account.</p>
    <a class="btn block" href="/login">Back to login</a>
  {:else}
    <form onsubmit={submit}>
      <div class="field">
        <label for="email">Email</label>
        <input id="email" class="input" type="email" bind:value={email} autocomplete="email" required />
        <span class="hint">Only used to log in{instance?.emailEnabled ? ' and reset your password' : ''}. Never shown to anyone.</span>
      </div>
      <div class="field">
        <label for="username">Username</label>
        <input id="username" class="input" bind:value={username} autocomplete="username" required maxlength="32" />
        {#if usernameHint}<span class="error-text">{usernameHint}</span>{:else}<span class="hint">Lowercase letters, numbers, _ and .</span>{/if}
      </div>
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" class="input" type="password" bind:value={password} autocomplete="new-password" required minlength="8" />
      </div>
      <div class="field">
        <label for="pw2">Confirm password</label>
        <input id="pw2" class="input" type="password" bind:value={confirm} autocomplete="new-password" required />
      </div>
      {#if instance?.registration === 'invite'}
        <div class="field">
          <label for="code">Sign-up code</label>
          <input id="code" class="input" bind:value={inviteCode} required />
          <span class="hint">This server is invite-only.</span>
        </div>
      {/if}
      {#if error}<p class="error-text">{error}</p>{/if}
      <button class="btn primary block" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
      <p class="hint" style="margin-top:14px">No phone number, no ID, no face scan. Already have an account? <a href="/login{page.url.search}">Log in</a></p>
    </form>
  {/if}
</AuthShell>
