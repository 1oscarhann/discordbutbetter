<script lang="ts">
  import { ChannelType, Permissions as P, isDmType, type Channel } from '@haunt/shared';
  import { goto } from '$app/navigation';
  import { app } from '$lib/state/app.svelte';
  import { ui, type RightPanel } from '$lib/state/ui.svelte';
  import { channelTitle, disappearingLabel } from '$lib/util/channel';
  import { timeAgo } from '$lib/util/time';
  import Icon, { type IconName } from '../Icon.svelte';
  import Avatar from '../Avatar.svelte';
  import Markdown from '../Markdown.svelte';
  import StatusDot from '../StatusDot.svelte';
  import GameLauncher from '../activities/GameLauncher.svelte';

  let { channel }: { channel: Channel } = $props();

  const isDm = $derived(isDmType(channel.type));
  const other = $derived(channel.type === ChannelType.DM ? (channel.recipients ?? []).find((r) => r.id !== app.me?.id) : null);
  const presence = $derived(other ? app.presence(other.id) : null);
  const parent = $derived(channel.type === ChannelType.THREAD && channel.parentId ? app.channel(channel.parentId) : null);
  let q = $state('');
  let gameAnchor = $state<HTMLElement | null>(null);

  function togglePanel(p: RightPanel) {
    ui.thread = null;
    ui.rightPanel = ui.rightPanel === p ? null : p;
  }

  const icon = $derived<IconName>(
    channel.type === ChannelType.THREAD ? 'thread' : channel.type === ChannelType.VOICE ? 'speaker' : channel.type === ChannelType.WIKI ? 'book' : 'hash',
  );

  function search(e: Event) {
    e.preventDefault();
    if (!q.trim()) return;
    ui.searchQuery = q.trim();
    ui.thread = null;
    ui.rightPanel = 'search';
  }
</script>

<header class="hdr">
  <button class="icon-btn burger" aria-label="Menu" onclick={() => (ui.mobileNav = true)}><Icon name="menu" /></button>
  {#if channel.type === ChannelType.DM && other}
    <Avatar src={app.avatarOf(other.id)} name={app.displayName(other.id)} size={26} />
    <button
      class="name truncate"
      onclick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        ui.profile = { userId: other.id, guildId: null, x: r.left, y: r.bottom + 6 };
      }}>{app.displayName(other.id)}</button
    >
    {#if presence}
      <span class="presence">
        <StatusDot status={presence.status} size={9} />
        {#if presence.status === 'offline' && presence.lastSeenAt}<span class="faint">last seen {timeAgo(presence.lastSeenAt)}</span>{/if}
      </span>
    {/if}
  {:else if isDm}
    <Avatar src={channel.icon} name={channelTitle(channel)} size={26} />
    <span class="name truncate">{channelTitle(channel)}</span>
  {:else}
    <Icon name={icon} class="faint" />
    {#if parent}
      <button class="parent truncate" onclick={() => goto(`/app/${channel.guildId}/${parent.id}`)}>{parent.name}</button>
      <Icon name="chevron-right" size={14} class="faint" />
    {/if}
    <span class="name truncate">{channel.name}</span>
  {/if}
  {#if channel.topic}
    <span class="divider-v"></span>
    <div class="topic truncate" title={channel.topic}><Markdown content={channel.topic} guildId={channel.guildId} blocks={false} jumboAllowed={false} /></div>
  {/if}
  {#if isDm && channel.disappearingSeconds}
    <span class="pill" title="Messages here disappear">⏳ {disappearingLabel(channel.disappearingSeconds)}</span>
  {/if}
  <div class="spacer"></div>
  <div class="tools">
    {#if isDm}
      <button class="icon-btn" class:active={!!gameAnchor} title="Play a game" onclick={(e) => (gameAnchor = gameAnchor ? null : (e.currentTarget as HTMLElement))}><Icon name="gamepad" /></button>
    {/if}
    {#if channel.type === ChannelType.TEXT}
      <button class="icon-btn" class:active={ui.rightPanel === 'threads'} title="Threads" onclick={() => togglePanel('threads')}><Icon name="thread" /></button>
    {/if}
    {#if isDm || (channel.guildId && app.can(P.MANAGE_CHANNELS, channel.guildId, channel.id) && channel.type !== ChannelType.THREAD)}
      <button class="icon-btn" title="Channel settings" onclick={() => (ui.channelSettings = channel.id)}><Icon name="settings" /></button>
    {/if}
    {#if channel.guildId}
      <button class="icon-btn" title="Notification settings" onclick={() => (ui.channelSettings = `notif:${channel.id}`)}>
        <Icon name={app.isChannelMuted(channel.id) ? 'bell-off' : 'bell'} />
      </button>
    {/if}
    <button class="icon-btn" class:active={ui.rightPanel === 'pins'} title="Pinned messages" onclick={() => togglePanel('pins')}><Icon name="pin" /></button>
    {#if channel.guildId}
      <button class="icon-btn" class:active={ui.rightPanel === 'members'} title="Members" onclick={() => togglePanel('members')}><Icon name="users" /></button>
    {/if}
    <form class="search" onsubmit={search}>
      <input placeholder="Search" bind:value={q} aria-label="Search messages" />
      <Icon name="search" size={15} />
    </form>
  </div>
</header>

{#if gameAnchor}<GameLauncher anchor={gameAnchor} {channel} onclose={() => (gameAnchor = null)} />{/if}

<style>
  .hdr {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px 0 16px;
    border-bottom: 1px solid var(--bg-0);
    box-shadow: 0 1px 0 rgb(0 0 0 / 0.12);
    min-width: 0;
  }
  .burger {
    display: none;
  }
  .name {
    font-weight: 700;
    background: none;
    border: none;
    padding: 0;
    font-size: 1rem;
    cursor: default;
    flex: none;
    max-width: 30%;
  }
  button.name {
    cursor: pointer;
  }
  .parent {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-weight: 600;
    max-width: 20%;
    padding: 0;
  }
  .presence {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
  }
  .divider-v {
    width: 1px;
    height: 22px;
    background: var(--border);
    flex: none;
  }
  .topic {
    color: var(--text-muted);
    font-size: 0.88rem;
    flex: 1;
    max-height: 1.4em;
  }
  .topic :global(.md) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    margin-left: 6px;
    color: var(--text-faint);
  }
  .search input {
    width: 150px;
    background: var(--bg-0);
    border: none;
    border-radius: 6px;
    padding: 5px 26px 5px 8px;
    font-size: 0.85rem;
    outline: none;
    transition: width 0.15s;
  }
  .search input:focus {
    width: 220px;
  }
  .search :global(svg) {
    position: absolute;
    right: 7px;
  }
  @media (max-width: 760px) {
    .burger {
      display: inline-grid;
    }
    .topic,
    .divider-v,
    .search {
      display: none;
    }
    .name {
      max-width: 50%;
    }
  }
</style>
