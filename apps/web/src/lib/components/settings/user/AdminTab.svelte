<script lang="ts">
  import { formatBytes, type AdminGuild, type AdminInvite, type AdminStats, type AdminUser } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, get, patch, post } from '$lib/api';
  import { fullDate, timeUntil } from '$lib/util/time';
  import { copy } from '$lib/util/channel';
  import Avatar from '../../Avatar.svelte';
  import Icon from '../../Icon.svelte';
  import Modal from '../../Modal.svelte';

  let sub = $state<'overview' | 'users' | 'invites' | 'servers'>('overview');

  // ---- overview ----
  let stats = $state<AdminStats | null>(null);
  let error = $state('');
  async function loadStats() {
    try {
      stats = await get<AdminStats>('/admin/stats');
    } catch (e) {
      error = errorMessage(e);
    }
  }
  void loadStats();

  // ---- users ----
  let users = $state<AdminUser[]>([]);
  let userQ = $state('');
  let userMore = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function loadUsers(reset = true) {
    try {
      const off = reset ? 0 : users.length;
      const page = await get<AdminUser[]>(`/admin/users?q=${encodeURIComponent(userQ.trim())}&offset=${off}`);
      users = reset ? page : [...users, ...page];
      userMore = page.length === 50;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  function searchUsers() {
    clearTimeout(timer);
    timer = setTimeout(() => loadUsers(), 250);
  }
  async function setUser(u: AdminUser, body: { disabled?: boolean; isAdmin?: boolean }) {
    try {
      const n = await patch<AdminUser>(`/admin/users/${u.id}`, body);
      users = users.map((x) => (x.id === n.id ? n : x));
      void loadStats();
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  let resetFor = $state<{ user: AdminUser; url: string; expiresAt: string } | null>(null);
  async function resetLink(u: AdminUser) {
    try {
      const r = await post<{ url: string; expiresAt: string }>(`/admin/users/${u.id}/reset-link`);
      resetFor = { user: u, ...r };
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  // ---- invites ----
  let invites = $state<AdminInvite[]>([]);
  let maxUses = $state(1);
  let days = $state(7);
  async function loadInvites() {
    try {
      invites = await get<AdminInvite[]>('/admin/invites');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  async function createInvite() {
    try {
      const r = await post<{ code: string; url: string }>('/admin/invites', { maxUses, days });
      copy(r.url, 'Sign-up link copied');
      await loadInvites();
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  // ---- servers ----
  let guilds = $state<AdminGuild[]>([]);
  let guildQ = $state('');
  let guildMore = $state(false);
  async function loadGuilds(reset = true) {
    try {
      const off = reset ? 0 : guilds.length;
      const page = await get<AdminGuild[]>(`/admin/guilds?q=${encodeURIComponent(guildQ.trim())}&offset=${off}`);
      guilds = reset ? page : [...guilds, ...page];
      guildMore = page.length === 50;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  function searchGuilds() {
    clearTimeout(timer);
    timer = setTimeout(() => loadGuilds(), 250);
  }
  let takedown = $state<AdminGuild | null>(null);
  let typed = $state('');
  async function deleteGuild() {
    if (!takedown) return;
    try {
      await del(`/admin/guilds/${takedown.id}`);
      guilds = guilds.filter((g) => g.id !== takedown!.id);
      takedown = null;
      void loadStats();
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  $effect(() => {
    if (sub === 'users' && !users.length) void loadUsers();
    if (sub === 'invites') void loadInvites();
    if (sub === 'servers' && !guilds.length) void loadGuilds();
  });

  const REG: Record<string, string> = {
    open: 'Open — anyone can sign up',
    invite: 'Invite only — people need a sign-up link',
    closed: 'Closed — no new accounts',
  };
</script>

<h2>Instance admin</h2>
<p class="muted">You run this server. These tools affect everyone on it, so the actions here are deliberate and some can't be undone.</p>

<div class="tabs">
  <button class="tab" class:active={sub === 'overview'} onclick={() => (sub = 'overview')}>Overview</button>
  <button class="tab" class:active={sub === 'users'} onclick={() => (sub = 'users')}>Users</button>
  <button class="tab" class:active={sub === 'invites'} onclick={() => (sub = 'invites')}>Sign-up links</button>
  <button class="tab" class:active={sub === 'servers'} onclick={() => (sub = 'servers')}>Servers</button>
</div>

{#if sub === 'overview'}
  {#if error}<p class="error-text">{error}</p>{/if}
  {#if stats}
    <div class="stats">
      <div class="stat card"><strong>{stats.users}</strong><span>accounts{stats.disabledUsers ? ` (${stats.disabledUsers} disabled)` : ''}</span></div>
      <div class="stat card"><strong>{stats.servers}</strong><span>servers</span></div>
      <div class="stat card"><strong>{stats.messages}</strong><span>messages</span></div>
      <div class="stat card"><strong>{formatBytes(stats.fileBytes)}</strong><span>in {stats.files} files</span></div>
    </div>
    <h3>Setup</h3>
    <div class="srow"><span class="txt"><strong>Registration</strong><small>{REG[stats.registration]}</small></span></div>
    <div class="srow"><span class="txt"><strong>Email</strong><small>{stats.emailEnabled ? 'SMTP is set up: verification and password resets go by email' : 'No SMTP: accounts work right away; use "Reset link" on the Users tab when someone forgets their password'}</small></span></div>
    <div class="srow"><span class="txt"><strong>Voice & video</strong><small>{stats.voiceEnabled ? 'LiveKit is connected' : 'Off — LiveKit is not configured'}</small></span></div>
    <p class="faint small">These come from the server's environment (.env). Change them there and restart.</p>
  {/if}
{:else if sub === 'users'}
  <input class="input" placeholder="Search username, email or id" bind:value={userQ} oninput={searchUsers} style="margin-bottom:10px" />
  {#each users as u (u.id)}
    <div class="list-item">
      <Avatar src={u.avatar} name={u.displayName ?? u.username} size={32} />
      <span class="col" style="gap:0;flex:1;min-width:0">
        <strong class="truncate">
          {u.displayName ?? u.username} <span class="faint">@{u.username}</span>
          {#if u.isAdmin}<span class="pill">Admin</span>{/if}
          {#if u.disabled}<span class="pill bad">Disabled</span>{/if}
        </strong>
        <span class="faint small truncate">{u.email ?? 'no email'}{u.email && !u.emailVerified ? ' (unverified)' : ''} · joined {fullDate(u.createdAt)} · in {u.serverCount} {u.serverCount === 1 ? 'server' : 'servers'}</span>
      </span>
      <button class="btn small" title="One-time password reset link" onclick={() => resetLink(u)}>Reset link</button>
      {#if u.id !== app.me?.id}
        {#if u.isAdmin}
          <button class="btn small ghost" onclick={() => ui.confirm(`Remove admin from @${u.username}?`, '', 'Remove admin', () => setUser(u, { isAdmin: false }), false)}>Remove admin</button>
        {:else if !u.disabled}
          <button class="btn small ghost" onclick={() => ui.confirm(`Make @${u.username} an instance admin?`, 'They get every power on this page, including taking down servers and making more admins.', 'Make admin', () => setUser(u, { isAdmin: true }))}>Make admin</button>
        {/if}
        {#if u.disabled}
          <button class="btn small" onclick={() => setUser(u, { disabled: false })}>Enable</button>
        {:else if !u.isAdmin}
          <button class="btn small danger" onclick={() => ui.confirm(`Disable @${u.username}?`, "They're logged out everywhere and can't log back in until you enable them. Their messages stay.", 'Disable', () => setUser(u, { disabled: true }))}>Disable</button>
        {/if}
      {/if}
    </div>
  {:else}
    <p class="faint">No matches.</p>
  {/each}
  {#if userMore}<button class="btn ghost block" onclick={() => loadUsers(false)}>Load more</button>{/if}
{:else if sub === 'invites'}
  <p class="muted small">
    Sign-up links let people create an account when registration is set to <code>invite</code>{stats && stats.registration !== 'invite' ? ` (yours is currently "${stats.registration}", so these aren't needed right now)` : ''}.
  </p>
  <div class="row" style="gap:8px;flex-wrap:wrap">
    <label class="row small" style="gap:6px">Uses <input class="input" type="number" min="0" max="1000" bind:value={maxUses} style="width:80px" /></label>
    <label class="row small" style="gap:6px">Days <input class="input" type="number" min="0" max="365" bind:value={days} style="width:80px" /></label>
    <button class="btn primary" onclick={createInvite}><Icon name="plus" size={15} /> Create & copy link</button>
  </div>
  <p class="faint small">0 uses = unlimited, 0 days = never expires.</p>
  {#each invites as i (i.code)}
    <div class="list-item">
      <code class="truncate" style="flex:1">{i.code}</code>
      <span class="faint small">{i.uses}/{i.maxUses || '∞'} used · {i.expiresAt ? `expires in ${timeUntil(i.expiresAt)}` : 'never expires'}</span>
      <button class="icon-btn" title="Copy link" onclick={() => copy(`${location.origin}/register?code=${i.code}`, 'Sign-up link copied')}><Icon name="copy" size={15} /></button>
      <button class="icon-btn" title="Revoke" onclick={() => del(`/admin/invites/${i.code}`).then(loadInvites).catch((e) => app.toast(errorMessage(e), 'error'))}><Icon name="x" size={15} /></button>
    </div>
  {:else}
    <p class="faint">No active sign-up links.</p>
  {/each}
{:else if sub === 'servers'}
  <input class="input" placeholder="Search server name or id" bind:value={guildQ} oninput={searchGuilds} style="margin-bottom:10px" />
  {#each guilds as g (g.id)}
    <div class="list-item">
      <Avatar src={g.icon} name={g.name} size={32} square />
      <span class="col" style="gap:0;flex:1;min-width:0">
        <strong class="truncate">{g.name}</strong>
        <span class="faint small truncate">owner @{g.owner?.username ?? 'deleted'} · {g.memberCount} members · {g.messageCount} messages · made {fullDate(g.createdAt)}</span>
      </span>
      <button class="btn small danger" onclick={() => ((takedown = g), (typed = ''))}>Take down</button>
    </div>
  {:else}
    <p class="faint">No servers.</p>
  {/each}
  {#if guildMore}<button class="btn ghost block" onclick={() => loadGuilds(false)}>Load more</button>{/if}
{/if}

{#if resetFor}
  <Modal title="Reset link for @{resetFor.user.username}" onclose={() => (resetFor = null)} width={500}>
    <p>Send this to them privately. It works once and expires in {timeUntil(resetFor.expiresAt)}.</p>
    <div class="row" style="gap:6px">
      <input class="input" readonly value={resetFor.url} onfocus={(e) => (e.target as HTMLInputElement).select()} style="flex:1" />
      <button class="btn primary" onclick={() => copy(resetFor!.url, 'Link copied')}>Copy</button>
    </div>
  </Modal>
{/if}

{#if takedown}
  <Modal title="Take down {takedown.name}?" onclose={() => (takedown = null)} width={460}>
    <p>Deletes the server for all {takedown.memberCount} members: every channel, message and file in it. There's no undo.</p>
    <input class="input" bind:value={typed} placeholder="Type the server name to confirm" />
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (takedown = null)}>Cancel</button>
      <button class="btn danger" disabled={typed.trim() !== takedown?.name.trim()} onclick={deleteGuild}>Delete server</button>
    {/snippet}
  </Modal>
{/if}

<style>
  .tabs {
    margin: 12px 0;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .stat strong {
    font-size: 1.5rem;
  }
  .stat span {
    color: var(--text-muted);
    font-size: 0.85rem;
  }
  .pill.bad {
    background: color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .list-item {
    flex-wrap: wrap;
  }
</style>
