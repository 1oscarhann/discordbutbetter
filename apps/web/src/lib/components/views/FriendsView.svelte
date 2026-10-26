<script lang="ts">
  import { goto } from '$app/navigation';
  import { RelationshipType, proxiedImage, type Channel, type Relationship } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, post, put } from '$lib/api';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';

  let tab = $state<'online' | 'all' | 'pending' | 'blocked' | 'add'>('online');
  let username = $state('');
  let addMsg = $state<{ ok: boolean; text: string } | null>(null);
  let filter = $state('');

  const rels = $derived([...app.relationships.values()]);
  const friends = $derived(rels.filter((r) => r.type === RelationshipType.FRIEND));
  const pending = $derived(rels.filter((r) => r.type === RelationshipType.INCOMING || r.type === RelationshipType.OUTGOING));
  const blocked = $derived(rels.filter((r) => r.type === RelationshipType.BLOCKED));
  const shown = $derived.by(() => {
    let list: Relationship[] = [];
    if (tab === 'online') list = friends.filter((r) => app.presence(r.user.id).status !== 'offline');
    else if (tab === 'all') list = friends;
    else if (tab === 'pending') list = pending;
    else if (tab === 'blocked') list = blocked;
    const f = filter.toLowerCase();
    return list
      .filter((r) => !f || app.displayName(r.user.id).toLowerCase().includes(f) || r.user.username.includes(f))
      .sort((a, b) => app.displayName(a.user.id).localeCompare(app.displayName(b.user.id)));
  });
  const active = $derived(friends.filter((r) => {
    const p = app.presence(r.user.id);
    return p.playing || p.listening;
  }));
  const lfg = $derived(active.filter((r) => app.presence(r.user.id).playing?.lfg));

  async function add(e: Event) {
    e.preventDefault();
    addMsg = null;
    try {
      await post('/users/@me/relationships', { username: username.trim().toLowerCase() });
      addMsg = { ok: true, text: `Friend request sent to ${username}.` };
      username = '';
    } catch (err) {
      addMsg = { ok: false, text: errorMessage(err) };
    }
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function message(userId: string) {
    try {
      const c = await post<Channel>('/users/@me/channels', { recipientIds: [userId] });
      goto(`/app/me/${c.id}`);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function statusLine(userId: string): string {
    const p = app.presence(userId);
    if (p.customStatus) return `${p.customStatus.emoji ?? ''} ${p.customStatus.text}`.trim();
    if (p.playing) return `Playing ${p.playing.name}`;
    if (p.listening) return `Listening to ${p.listening.title}`;
    return { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', offline: 'Offline' }[p.status];
  }
</script>

<header class="hdr">
  <button class="icon-btn burger" aria-label="Menu" onclick={() => { ui.mobileNav = true; }}><Icon name="menu" /></button>
  <Icon name="users" />
  <strong>Friends</strong>
  <span class="sep"></span>
  <div class="tabs-inline">
    {#each [['online', 'Online'], ['all', 'All'], ['pending', 'Pending'], ['blocked', 'Blocked']] as const as [k, label] (k)}
      <button class="t" class:active={tab === k} onclick={() => (tab = k)}>
        {label}
        {#if k === 'pending' && rels.some((r) => r.type === RelationshipType.INCOMING)}<span class="badge">{rels.filter((r) => r.type === RelationshipType.INCOMING).length}</span>{/if}
      </button>
    {/each}
    <button class="t add" class:active={tab === 'add'} onclick={() => (tab = 'add')}>Add friend</button>
  </div>
</header>

<div class="body">
  <div class="main scroll">
    {#if tab === 'add'}
      <div class="addbox">
        <h3>Add friend</h3>
        <p class="muted">Send a request with their username. Nobody can see your email or find you any other way.</p>
        <form class="addrow" onsubmit={add}>
          <input class="input" placeholder="username" bind:value={username} autocomplete="off" />
          <button class="btn primary" disabled={!username.trim()}>Send request</button>
        </form>
        {#if addMsg}<p class={addMsg.ok ? 'ok' : 'error-text'}>{addMsg.text}</p>{/if}
      </div>
    {:else}
      <input class="input search" placeholder="Search" bind:value={filter} />
      <div class="count faint">{tab.toUpperCase()} — {shown.length}</div>
      {#each shown as r (r.user.id)}
        <div class="friend">
          <button
            class="who"
            onclick={(e) => {
              const b = e.currentTarget.getBoundingClientRect();
              ui.profile = { userId: r.user.id, guildId: null, x: b.left + 60, y: b.top };
            }}
          >
            <Avatar src={app.avatarOf(r.user.id)} name={app.displayName(r.user.id)} size={36} status={r.type === RelationshipType.BLOCKED ? null : app.presence(r.user.id).status} />
            <span class="meta">
              <strong class="truncate">{app.displayName(r.user.id)} <span class="faint un">@{r.user.username}</span></strong>
              <span class="faint truncate sub">
                {r.type === RelationshipType.INCOMING ? 'Incoming friend request' : r.type === RelationshipType.OUTGOING ? 'Outgoing friend request' : r.type === RelationshipType.BLOCKED ? 'Blocked' : statusLine(r.user.id)}
              </span>
            </span>
          </button>
          <div class="acts">
            {#if r.type === RelationshipType.FRIEND}
              <button class="icon-btn" title="Message" onclick={() => message(r.user.id)}><Icon name="message" /></button>
              <button
                class="icon-btn danger"
                title="Remove friend"
                onclick={() => ui.confirm(`Remove ${app.displayName(r.user.id)}?`, 'They won’t be told, but you’ll both disappear from each other’s friend lists.', 'Remove friend', () => act(() => del(`/users/@me/relationships/${r.user.id}`)))}
                ><Icon name="x" /></button
              >
            {:else if r.type === RelationshipType.INCOMING}
              <button class="icon-btn" title="Accept" onclick={() => act(() => put(`/users/@me/relationships/${r.user.id}`, { type: 1 }))}><Icon name="check" /></button>
              <button class="icon-btn danger" title="Ignore" onclick={() => act(() => del(`/users/@me/relationships/${r.user.id}`))}><Icon name="x" /></button>
            {:else if r.type === RelationshipType.OUTGOING}
              <button class="icon-btn danger" title="Cancel" onclick={() => act(() => del(`/users/@me/relationships/${r.user.id}`))}><Icon name="x" /></button>
            {:else}
              <button class="btn small" onclick={() => act(() => del(`/users/@me/relationships/${r.user.id}`))}>Unblock</button>
            {/if}
          </div>
        </div>
      {:else}
        <p class="faint empty">
          {tab === 'online' ? 'No friends online right now.' : tab === 'pending' ? 'No pending requests.' : tab === 'blocked' ? "You haven't blocked anyone." : 'No friends yet — add some!'}
        </p>
      {/each}
    {/if}
  </div>

  <aside class="activity scroll">
    <h3>Active now</h3>
    {#if lfg.length}
      <div class="lfghead"><span class="lfg">LFG</span> Looking for people to play with</div>
      {#each lfg as r (r.user.id)}
        {@const p = app.presence(r.user.id).playing!}
        <div class="card act lfgcard">
          <div class="row">
            <Avatar src={app.avatarOf(r.user.id)} name={app.displayName(r.user.id)} size={28} />
            <strong class="truncate">{app.displayName(r.user.id)}</strong>
          </div>
          <div class="game">
            {#if p.cover}<img src={proxiedImage(p.cover, 128)} alt="" />{/if}
            <span class="truncate">{p.name}</span>
          </div>
          <button class="btn primary small block" onclick={() => message(r.user.id)}>I’m in — message them</button>
        </div>
      {/each}
    {/if}
    {#each active.filter((r) => !app.presence(r.user.id).playing?.lfg) as r (r.user.id)}
      {@const p = app.presence(r.user.id)}
      <div class="card act">
        <div class="row">
          <Avatar src={app.avatarOf(r.user.id)} name={app.displayName(r.user.id)} size={28} status={p.status} />
          <strong class="truncate">{app.displayName(r.user.id)}</strong>
        </div>
        {#if p.playing}
          <div class="game">
            {#if p.playing.cover}<img src={proxiedImage(p.playing.cover, 128)} alt="" />{/if}
            <span class="truncate">Playing {p.playing.name}</span>
          </div>
        {/if}
        {#if p.listening}
          <div class="game">
            {#if p.listening.cover}<img src={proxiedImage(p.listening.cover, 128)} alt="" />{/if}
            <span class="truncate">🎵 {p.listening.title} — {p.listening.artist}</span>
          </div>
        {/if}
      </div>
    {:else}
      {#if !lfg.length}<p class="faint small">When friends set what they’re playing or listening to, it shows up here.</p>{/if}
    {/each}
  </aside>
</div>

<style>
  .hdr {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--bg-0);
    overflow-x: auto;
  }
  .burger {
    display: none;
  }
  .sep {
    width: 1px;
    height: 22px;
    background: var(--border);
  }
  .tabs-inline {
    display: flex;
    gap: 6px;
  }
  .t {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 6px;
    border: none;
    background: none;
    cursor: pointer;
    font-weight: 600;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .t:hover {
    background: var(--hover);
    color: var(--text);
  }
  .t.active {
    background: var(--active);
    color: var(--text);
  }
  .t.add {
    background: var(--success);
    color: #fff;
  }
  .t.add.active {
    background: transparent;
    color: var(--success);
  }
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .main {
    flex: 1;
    padding: 16px 20px;
  }
  .search {
    margin-bottom: 14px;
  }
  .count {
    font-size: 0.75rem;
    font-weight: 700;
    margin-bottom: 8px;
  }
  .friend {
    display: flex;
    align-items: center;
    border-top: 1px solid var(--border);
    padding: 8px 6px;
    border-radius: 6px;
  }
  .friend:hover {
    background: var(--hover);
  }
  .who {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    min-width: 0;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .un {
    font-weight: 400;
    font-size: 0.85rem;
    display: none;
  }
  .friend:hover .un {
    display: inline;
  }
  .sub {
    font-size: 0.82rem;
  }
  .acts {
    display: flex;
    gap: 6px;
  }
  .acts .icon-btn {
    background: var(--bg-1);
    border-radius: 50%;
    width: 36px;
    height: 36px;
  }
  .addbox h3 {
    margin: 0 0 6px;
  }
  .addrow {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
  .ok {
    color: var(--success);
  }
  .empty {
    text-align: center;
    padding: 40px 0;
  }
  .activity {
    width: 320px;
    flex: none;
    padding: 16px;
    border-left: 1px solid var(--border);
  }
  .activity h3 {
    margin: 0 0 12px;
    font-size: 1.1rem;
  }
  .act {
    padding: 12px;
    margin-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .lfgcard {
    border-color: var(--success);
  }
  .lfghead {
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--success);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .lfg {
    background: var(--success);
    color: #fff;
    font-weight: 800;
    font-size: 0.65rem;
    padding: 1px 5px;
    border-radius: 4px;
  }
  .game {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.88rem;
  }
  .game img {
    width: 36px;
    height: 36px;
    object-fit: cover;
    border-radius: 6px;
  }
  .small {
    font-size: 0.85rem;
  }
  @media (max-width: 1000px) {
    .activity {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .burger {
      display: inline-grid;
    }
  }
</style>
