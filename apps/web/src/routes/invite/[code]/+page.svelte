<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import AuthShell from '$lib/components/AuthShell.svelte';
  import Avatar from '$lib/components/Avatar.svelte';
  import { ApiError, errorMessage, get, post } from '$lib/api';
  import type { Invite } from '@dbb/shared';

  let invite = $state<Invite | null>(null);
  let error = $state('');
  let loggedIn = $state(false);
  let busy = $state(false);
  const code = page.params.code ?? '';

  onMount(async () => {
    try {
      invite = await get<Invite>(`/invites/${encodeURIComponent(code)}`);
    } catch (e) {
      error = errorMessage(e);
    }
    try {
      await get('/users/@me');
      loggedIn = true;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) loggedIn = false;
    }
  });

  async function join() {
    busy = true;
    try {
      const r = await post<{ guildId: string }>(`/invites/${encodeURIComponent(code)}`);
      location.href = `/app/${r.guildId}`;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<AuthShell title="You've been invited">
  {#if error}
    <p class="error-text">{error}</p>
    <a class="btn block" href="/app">Open the app</a>
  {:else if !invite}
    <p class="muted">Loading invite…</p>
  {:else}
    <div class="inv">
      <Avatar src={invite.guild.icon} name={invite.guild.name} size={64} square />
      <div>
        <div class="faint">{invite.inviter ? `${invite.inviter.displayName || invite.inviter.username} invited you to join` : 'Join'}</div>
        <div class="gname">{invite.guild.name}</div>
        <div class="faint small"><span class="on">●</span> {invite.guild.onlineCount} online · {invite.guild.memberCount} {invite.guild.memberCount === 1 ? 'member' : 'members'}</div>
      </div>
    </div>
    {#if invite.guild.description}<p class="muted">{invite.guild.description}</p>{/if}
    {#if loggedIn}
      <button class="btn primary block" onclick={join} disabled={busy}>Accept invite</button>
    {:else}
      <a class="btn primary block" href="/register?next={encodeURIComponent(page.url.pathname)}">Create an account to join</a>
      <p class="hint" style="margin-top:10px">Already have one? <a href="/login?next={encodeURIComponent(page.url.pathname)}">Log in</a></p>
    {/if}
  {/if}
</AuthShell>

<style>
  .on {
    color: var(--success);
  }
  .inv {
    display: flex;
    gap: 14px;
    align-items: center;
    margin-bottom: 16px;
  }
  .gname {
    font-size: 1.3rem;
    font-weight: 800;
  }
  .small {
    font-size: 0.85rem;
  }
</style>
