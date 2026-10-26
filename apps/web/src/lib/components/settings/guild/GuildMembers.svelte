<script lang="ts">
  import { Permissions as P, type GuildMember } from '@haunt/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, errorMessage, patch, put } from '$lib/api';
  import { fullDate, timeUntil } from '$lib/util/time';
  import Avatar from '../../Avatar.svelte';
  import Icon from '../../Icon.svelte';
  import Modal from '../../Modal.svelte';
  import Popover from '../../Popover.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);
  const isOwner = $derived(g.guild.ownerId === app.me?.id);
  const can = (f: bigint) => app.can(f, gid);

  const highestOf = (userId: string) => {
    if (userId === g.guild.ownerId) return Infinity;
    const m = g.members.get(userId);
    return Math.max(0, ...(m?.roles ?? []).map((r) => g.roles.get(r)?.position ?? 0));
  };
  const myHighest = $derived(app.me ? highestOf(app.me.id) : 0);
  /** Mirrors the server's hierarchy check so we don't offer buttons that will just 403. */
  const canActOn = (m: GuildMember) => m.user.id !== g.guild.ownerId && m.user.id !== app.me?.id && (isOwner || highestOf(m.user.id) < myHighest);

  let q = $state('');
  let roleFilter = $state('');
  const list = $derived.by(() => {
    const s = q.trim().toLowerCase();
    return [...g.members.values()]
      .filter((m) => !s || m.user.username.includes(s) || app.displayName(m.user.id, gid).toLowerCase().includes(s) || m.user.id === s)
      .filter((m) => !roleFilter || m.roles.includes(roleFilter))
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  });
  let shown = $state(100);

  let menu = $state<{ m: GuildMember; anchor: HTMLElement } | null>(null);
  let action = $state<{ kind: 'kick' | 'ban' | 'timeout' | 'nick' | 'roles'; m: GuildMember } | null>(null);
  let reason = $state('');
  let deleteSeconds = $state(0);
  let timeoutSeconds = $state(3600);
  let nick = $state('');
  let roleDraft = $state<string[]>([]);
  let error = $state('');

  function open(kind: NonNullable<typeof action>['kind'], m: GuildMember) {
    menu = null;
    error = '';
    reason = '';
    deleteSeconds = 0;
    timeoutSeconds = 3600;
    nick = m.nickname ?? '';
    roleDraft = [...m.roles];
    action = { kind, m };
  }

  async function run() {
    if (!action) return;
    const { kind, m } = action;
    const uid = m.user.id;
    error = '';
    try {
      if (kind === 'kick') await api('DELETE', `/guilds/${gid}/members/${uid}`, { reason: reason || undefined });
      else if (kind === 'ban') await put(`/guilds/${gid}/bans/${uid}`, { reason: reason || undefined, deleteMessageSeconds: deleteSeconds });
      else if (kind === 'timeout') await patch(`/guilds/${gid}/members/${uid}`, { timeoutSeconds, reason: reason || undefined });
      else if (kind === 'nick') await patch(`/guilds/${gid}/members/${uid}`, { nickname: nick.trim() || null });
      else if (kind === 'roles') await patch(`/guilds/${gid}/members/${uid}`, { roles: roleDraft, reason: reason || undefined });
      app.toast(kind === 'kick' ? 'Kicked' : kind === 'ban' ? 'Banned' : 'Saved', 'success');
      action = null;
    } catch (e) {
      error = errorMessage(e);
    }
  }

  async function untimeout(m: GuildMember) {
    try {
      await patch(`/guilds/${gid}/members/${m.user.id}`, { timeoutSeconds: 0 });
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  const assignable = $derived(g.sortedRoles.filter((r) => r.id !== gid && (isOwner || r.position < myHighest)));
  const timedOut = (m: GuildMember) => !!m.timeoutUntil && new Date(m.timeoutUntil).getTime() > Date.now();
  const TIMEOUTS = [
    [60, '60 seconds'],
    [300, '5 minutes'],
    [600, '10 minutes'],
    [3600, '1 hour'],
    [86400, '1 day'],
    [604800, '1 week'],
    [2419200, '28 days'],
  ] as const;
</script>

<h2>Members</h2>
<p class="muted">{g.members.size} members.</p>
<div class="row filters">
  <input class="input" placeholder="Search by name, username or id" bind:value={q} />
  <select class="select" bind:value={roleFilter}>
    <option value="">All roles</option>
    {#each g.sortedRoles.filter((r) => r.id !== gid) as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
  </select>
</div>

<div class="members">
  {#each list.slice(0, shown) as m (m.user.id)}
    <div class="list-item">
      <button class="who" onclick={(e) => (ui.profile = { userId: m.user.id, guildId: gid, x: e.clientX, y: e.clientY })}>
        <Avatar src={app.avatarOf(m.user.id, gid)} name={app.displayName(m.user.id, gid)} size={32} />
        <span class="col" style="gap:0;min-width:0">
          <strong class="truncate" style="color:{app.roleColor(gid, m.user.id) ?? 'inherit'}">
            {app.displayName(m.user.id, gid)}
            {#if m.user.id === g.guild.ownerId}<Icon name="crown" size={12} />{/if}
          </strong>
          <span class="faint small truncate">@{m.user.username} · joined {fullDate(m.joinedAt)}</span>
        </span>
      </button>
      <div class="chips">
        {#each m.roles.map((r) => g.roles.get(r)).filter((r) => !!r).sort((a, b) => b!.position - a!.position).slice(0, 3) as r (r!.id)}
          <span class="chip"><span class="dot" style="background:{r!.color ? '#' + r!.color.toString(16).padStart(6, '0') : 'var(--text-faint)'}"></span>{r!.name}</span>
        {/each}
        {#if m.roles.length > 3}<span class="chip">+{m.roles.length - 3}</span>{/if}
      </div>
      {#if timedOut(m)}
        <span class="pill warn" title="Timed out">
          <Icon name="clock" size={12} /> {timeUntil(m.timeoutUntil!)}
        </span>
      {/if}
      <button class="icon-btn" aria-label="Actions" onclick={(e) => (menu = { m, anchor: e.currentTarget as HTMLElement })}><Icon name="more" size={16} /></button>
    </div>
  {/each}
  {#if list.length > shown}<button class="btn ghost block" onclick={() => (shown += 100)}>Show more ({list.length - shown} left)</button>{/if}
</div>

{#if menu}
  {@const m = menu.m}
  {@const actOk = canActOn(m)}
  <Popover anchor={menu.anchor} placement="bottom-end" onclose={() => (menu = null)}>
    <div class="menu">
      <button class="menu-item" onclick={() => ((ui.profile = { userId: m.user.id, guildId: gid }), (menu = null))}><Icon name="user-plus" size={15} /> Profile</button>
      {#if can(P.MANAGE_NICKNAMES) && (actOk || m.user.id === app.me?.id)}<button class="menu-item" onclick={() => open('nick', m)}><Icon name="edit" size={15} /> Change nickname</button>{/if}
      {#if can(P.MANAGE_ROLES)}<button class="menu-item" onclick={() => open('roles', m)}><Icon name="shield" size={15} /> Roles</button>{/if}
      {#if actOk && (can(P.MODERATE_MEMBERS) || can(P.KICK_MEMBERS) || can(P.BAN_MEMBERS))}<div class="menu-sep"></div>{/if}
      {#if actOk && can(P.MODERATE_MEMBERS)}
        {#if timedOut(m)}
          <button class="menu-item" onclick={() => ((menu = null), untimeout(m))}><Icon name="clock" size={15} /> Remove timeout</button>
        {:else}
          <button class="menu-item danger" onclick={() => open('timeout', m)}><Icon name="clock" size={15} /> Timeout</button>
        {/if}
      {/if}
      {#if actOk && can(P.KICK_MEMBERS)}<button class="menu-item danger" onclick={() => open('kick', m)}><Icon name="logout" size={15} /> Kick</button>{/if}
      {#if actOk && can(P.BAN_MEMBERS)}<button class="menu-item danger" onclick={() => open('ban', m)}><Icon name="ban" size={15} /> Ban</button>{/if}
    </div>
  </Popover>
{/if}

{#if action}
  {@const name = app.displayName(action.m.user.id, gid)}
  <Modal
    title={action.kind === 'kick' ? `Kick ${name}` : action.kind === 'ban' ? `Ban ${name}` : action.kind === 'timeout' ? `Timeout ${name}` : action.kind === 'nick' ? `Nickname for ${name}` : `Roles for ${name}`}
    onclose={() => (action = null)}
    width={460}
  >
    {#if action.kind === 'kick'}
      <p>They can come back with a new invite.</p>
    {:else if action.kind === 'ban'}
      <p>They're removed and can't rejoin until unbanned.</p>
      <div class="field">
        <label for="dm">Delete their recent messages</label>
        <select id="dm" class="select" bind:value={deleteSeconds}>
          <option value={0}>Don't delete any</option>
          <option value={3600}>Last hour</option>
          <option value={21600}>Last 6 hours</option>
          <option value={86400}>Last 24 hours</option>
          <option value={259200}>Last 3 days</option>
          <option value={604800}>Last 7 days</option>
        </select>
      </div>
    {:else if action.kind === 'timeout'}
      <p>They can read but can't talk, react, or join voice until it runs out.</p>
      <div class="field">
        <label for="to">Duration</label>
        <select id="to" class="select" bind:value={timeoutSeconds}>
          {#each TIMEOUTS as [s, l] (s)}<option value={s}>{l}</option>{/each}
        </select>
      </div>
    {:else if action.kind === 'nick'}
      <div class="field">
        <label for="nn">Nickname</label>
        <input id="nn" class="input" bind:value={nick} maxlength="32" placeholder={action.m.user.displayName ?? action.m.user.username} />
        <span class="hint">Leave empty to reset.</span>
      </div>
    {:else if action.kind === 'roles'}
      <div class="rolelist scroll">
        {#each g.sortedRoles.filter((r) => r.id !== gid) as r (r.id)}
          {@const ok = assignable.some((x) => x.id === r.id)}
          <label class="srow" class:disabled={!ok}>
            <span class="dot" style="background:{r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--text-faint)'}"></span>
            <span class="txt">{r.name}</span>
            <input
              type="checkbox"
              disabled={!ok}
              checked={roleDraft.includes(r.id)}
              onchange={(e) => (roleDraft = (e.target as HTMLInputElement).checked ? [...roleDraft, r.id] : roleDraft.filter((x) => x !== r.id))}
            />
          </label>
        {/each}
      </div>
    {/if}
    {#if action.kind !== 'nick'}
      <div class="field">
        <label for="rs">Reason (shows in the audit log)</label>
        <input id="rs" class="input" bind:value={reason} maxlength="512" />
      </div>
    {/if}
    {#if error}<p class="error-text">{error}</p>{/if}
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (action = null)}>Cancel</button>
      <button class="btn {action?.kind === 'kick' || action?.kind === 'ban' || action?.kind === 'timeout' ? 'danger' : 'primary'}" onclick={run}>
        {action?.kind === 'kick' ? 'Kick' : action?.kind === 'ban' ? 'Ban' : action?.kind === 'timeout' ? 'Timeout' : 'Save'}
      </button>
    {/snippet}
  </Modal>
{/if}

<style>
  .filters {
    gap: 8px;
    margin: 10px 0;
  }
  .filters .input {
    flex: 1;
  }
  .filters .select {
    width: 180px;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
    padding: 0;
  }
  .chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: 40%;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    padding: 2px 7px;
    border-radius: 99px;
    background: var(--bg-3);
  }
  .dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex: none;
  }
  .pill.warn {
    background: color-mix(in srgb, var(--warning, #f0b232) 25%, transparent);
    display: inline-flex;
    gap: 4px;
    align-items: center;
  }
  .rolelist {
    max-height: 320px;
    margin-bottom: 10px;
  }
  .rolelist .srow {
    padding: 7px 0;
  }
  .srow.disabled {
    opacity: 0.5;
  }
  @media (max-width: 640px) {
    .chips {
      display: none;
    }
  }
</style>
