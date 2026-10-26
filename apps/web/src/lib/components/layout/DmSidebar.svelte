<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ChannelType, RelationshipType, compareIds, type Channel } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del } from '$lib/api';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';

  const active = $derived(page.params.channelId ?? null);
  const path = $derived(page.url.pathname);
  const pending = $derived([...app.relationships.values()].filter((r) => r.type === RelationshipType.INCOMING).length);

  const dms = $derived(
    [...app.dms.values()].sort((a, b) => compareIds(b.lastMessageId ?? b.id, a.lastMessageId ?? a.id)),
  );

  let filter = $state('');
  const shown = $derived(filter ? dms.filter((d) => dmName(d).toLowerCase().includes(filter.toLowerCase())) : dms);

  function others(c: Channel) {
    return (c.recipients ?? []).filter((r) => r.id !== app.me?.id);
  }

  function dmName(c: Channel): string {
    if (c.type === ChannelType.GROUP_DM && c.name) return c.name;
    const o = others(c);
    if (!o.length) return 'Just you';
    return o.map((u) => app.displayName(u.id)).join(', ');
  }

  async function close(e: MouseEvent, c: Channel) {
    e.stopPropagation();
    if (c.type === ChannelType.GROUP_DM) {
      ui.confirm(`Leave ${dmName(c)}?`, "You won't get messages from this group anymore unless someone adds you back.", 'Leave group', async () => {
        await del(`/channels/${c.id}`);
        if (active === c.id) goto('/app/me');
      });
      return;
    }
    await del(`/channels/${c.id}`);
    if (active === c.id) goto('/app/me');
  }
</script>

<header class="head">
  <input class="search" placeholder="Find a conversation" bind:value={filter} />
</header>
<div class="list scroll">
  <a class="nav" class:active={path === '/app/me'} href="/app/me" onclick={(e) => (e.preventDefault(), goto('/app/me'))}>
    <Icon name="users" /> Friends
    {#if pending}<span class="badge">{pending}</span>{/if}
  </a>
  <a class="nav" class:active={path === '/app/me/saved'} href="/app/me/saved" onclick={(e) => (e.preventDefault(), goto('/app/me/saved'))}>
    <Icon name="bookmark" /> Saved messages
  </a>
  <a class="nav" class:active={path === '/app/me/scheduled'} href="/app/me/scheduled" onclick={(e) => (e.preventDefault(), goto('/app/me/scheduled'))}>
    <Icon name="clock" /> Scheduled
    {#if app.scheduled.length}<span class="pill">{app.scheduled.length}</span>{/if}
  </a>

  <div class="sect">
    <span>Direct messages</span>
    <button class="icon-btn mini" title="New message" onclick={() => (ui.newDm = true)}><Icon name="plus" size={16} /></button>
  </div>

  {#each shown as c (c.id)}
    {@const o = others(c)}
    {@const unread = app.isUnread(c.id)}
    <div class="dm" class:active={active === c.id} class:unread role="link" tabindex="0" onclick={() => goto(`/app/me/${c.id}`)} onkeydown={(e) => e.key === 'Enter' && goto(`/app/me/${c.id}`)}>
      {#if c.type === ChannelType.GROUP_DM}
        <Avatar src={c.icon} name={dmName(c)} size={32} />
      {:else}
        <Avatar src={o[0] ? app.avatarOf(o[0].id) : null} name={dmName(c)} size={32} status={o[0] ? app.presence(o[0].id).status : null} />
      {/if}
      <div class="meta">
        <span class="truncate name">{dmName(c)}</span>
        {#if c.type === ChannelType.GROUP_DM}
          <span class="sub truncate">{(c.recipients ?? []).length} members</span>
        {:else if o[0] && app.presence(o[0].id).customStatus}
          <span class="sub truncate">{app.presence(o[0].id).customStatus?.emoji ?? ''} {app.presence(o[0].id).customStatus?.text}</span>
        {:else if o[0] && app.presence(o[0].id).playing}
          <span class="sub truncate">Playing {app.presence(o[0].id).playing?.name}</span>
        {/if}
      </div>
      {#if app.mentions(c.id)}<span class="badge">{app.mentions(c.id)}</span>{/if}
      <button class="icon-btn x" title={c.type === ChannelType.GROUP_DM ? 'Leave group' : 'Close DM'} onclick={(e) => close(e, c)}><Icon name="x" size={14} /></button>
    </div>
  {:else}
    <p class="faint empty">No conversations yet. Start one with the + above.</p>
  {/each}
</div>

<style>
  .head {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    padding: 0 10px;
    border-bottom: 1px solid var(--bg-0);
  }
  .search {
    width: 100%;
    background: var(--bg-0);
    border: none;
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 0.86rem;
    outline: none;
  }
  .list {
    flex: 1;
    padding: 8px;
  }
  .nav {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px;
    border-radius: 6px;
    color: var(--text-muted);
    font-weight: 600;
    text-decoration: none !important;
  }
  .nav:hover {
    background: var(--hover);
    color: var(--text);
  }
  .nav.active {
    background: var(--active);
    color: var(--text);
  }
  .nav .badge,
  .nav .pill {
    margin-left: auto;
  }
  .sect {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 16px 4px 4px 8px;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .mini {
    width: 22px;
    height: 22px;
  }
  .dm {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-muted);
  }
  .dm:hover {
    background: var(--hover);
    color: var(--text);
  }
  .dm.active {
    background: var(--active);
    color: var(--text);
  }
  .dm.unread .name {
    color: var(--text);
    font-weight: 700;
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .sub {
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .x {
    width: 22px;
    height: 22px;
    visibility: hidden;
  }
  .dm:hover .x {
    visibility: visible;
  }
  .empty {
    padding: 8px;
    font-size: 0.88rem;
  }
</style>
