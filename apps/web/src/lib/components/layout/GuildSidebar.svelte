<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ChannelType, Permissions as P, type Channel } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { voice } from '$lib/state/voice.svelte';
  import { del, errorMessage, patch } from '$lib/api';
  import Icon from '../Icon.svelte';
  import Avatar from '../Avatar.svelte';
  import Popover from '../Popover.svelte';
  import type { IconName } from '../Icon.svelte';

  let { guildId }: { guildId: string } = $props();
  const g = $derived(app.guilds.get(guildId)!);
  const activeChannel = $derived(page.params.channelId ?? null);

  let collapsed = $state<Record<string, boolean>>({});
  $effect(() => {
    try {
      collapsed = JSON.parse(localStorage.getItem(`collapsed:${guildId}`) ?? '{}');
    } catch {
      collapsed = {};
    }
  });
  function toggle(id: string) {
    collapsed = { ...collapsed, [id]: !collapsed[id] };
    try {
      localStorage.setItem(`collapsed:${guildId}`, JSON.stringify(collapsed));
    } catch {
      /* ignore */
    }
  }

  const tree = $derived.by(() => {
    const all = [...g.channels.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const cats = all.filter((c) => c.type === ChannelType.CATEGORY);
    const loose = all.filter((c) => c.type !== ChannelType.CATEGORY && !c.parentId);
    const byParent = (id: string) =>
      all
        .filter((c) => c.parentId === id && c.type !== ChannelType.CATEGORY)
        .sort((a, b) => Number(a.type === ChannelType.VOICE) - Number(b.type === ChannelType.VOICE) || a.position - b.position);
    return { loose, cats: cats.map((c) => ({ cat: c, children: byParent(c.id) })) };
  });

  const threadsByParent = $derived.by(() => {
    const m = new Map<string, Channel[]>();
    for (const t of g.threads.values()) {
      if (!t.parentId || t.threadMeta?.archived) continue;
      m.set(t.parentId, [...(m.get(t.parentId) ?? []), t]);
    }
    return m;
  });

  const ICON: Record<number, IconName> = {
    [ChannelType.TEXT]: 'hash',
    [ChannelType.VOICE]: 'speaker',
    [ChannelType.WIKI]: 'book',
    [ChannelType.THREAD]: 'thread',
  };

  let headerEl = $state<HTMLElement | null>(null);
  let headerOpen = $state(false);
  let channelMenu = $state<{ channel: Channel; x: number; y: number } | null>(null);
  const canManage = $derived(app.can(P.MANAGE_CHANNELS, guildId));
  const isOwner = $derived(g.guild.ownerId === app.me?.id);
  const anySettings = $derived(
    app.can(P.MANAGE_GUILD, guildId) ||
      app.can(P.MANAGE_ROLES, guildId) ||
      app.can(P.MANAGE_EMOJIS, guildId) ||
      app.can(P.VIEW_AUDIT_LOG, guildId) ||
      app.can(P.BAN_MEMBERS, guildId) ||
      app.can(P.KICK_MEMBERS, guildId) ||
      app.can(P.MANAGE_CHANNELS, guildId),
  );

  function openChannel(c: Channel) {
    if (c.type === ChannelType.VOICE && app.instance?.voiceEnabled && voice.channelId !== c.id) void voice.join(guildId, c.id);
    try {
      localStorage.setItem(`lastChannel:${guildId}`, c.id);
    } catch {
      /* ignore */
    }
    goto(`/app/${guildId}/${c.id}`);
  }

  function inviteChannel(): string | null {
    const first = tree.loose.concat(tree.cats.flatMap((c) => c.children)).find((c) => c.type === ChannelType.TEXT);
    return activeChannel && g.channels.get(activeChannel)?.type === ChannelType.TEXT ? activeChannel : (first?.id ?? null);
  }

  async function muteChannel(c: Channel) {
    channelMenu = null;
    try {
      await patch(`/users/@me/channels/${c.id}/notifications`, { muteSeconds: app.isChannelMuted(c.id) ? null : -1 });
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function deleteChannel(c: Channel) {
    channelMenu = null;
    ui.confirm(`Delete #${c.name}?`, 'All messages in it will be gone for good.', 'Delete channel', async () => {
      await del(`/channels/${c.id}`);
      if (activeChannel === c.id) goto(`/app/${guildId}`);
    });
  }
</script>

<header class="head" bind:this={headerEl}>
  <button class="title" onclick={() => (headerOpen = !headerOpen)}>
    <span class="truncate">{g.guild.name}</span>
    <Icon name="chevron-down" size={16} />
  </button>
</header>
{#if g.guild.banner}
  <div class="banner" style="background-image:url({g.guild.banner})"></div>
{/if}

<div class="list scroll">
  {#snippet channelRow(c: Channel)}
    {@const unread = app.isUnread(c.id) && !app.isChannelMuted(c.id)}
    {@const mentions = app.mentions(c.id)}
    <div class="crow" class:active={activeChannel === c.id} class:unread class:muted={app.isChannelMuted(c.id)}>
      {#if unread && activeChannel !== c.id}<span class="dot"></span>{/if}
      <button
        class="cbtn"
        onclick={() => openChannel(c)}
        oncontextmenu={(e) => {
          e.preventDefault();
          channelMenu = { channel: c, x: e.clientX, y: e.clientY };
        }}
      >
        <Icon name={ICON[c.type] ?? 'hash'} size={18} />
        {#if c.overwrites.some((o) => o.id === guildId && (BigInt(o.deny) & P.VIEW_CHANNEL) !== 0n)}<Icon name="lock" size={11} class="lockico" />{/if}
        <span class="truncate">{c.name}</span>
      </button>
      {#if mentions}<span class="badge">{mentions}</span>{/if}
      {#if c.type !== ChannelType.VOICE && app.can(P.CREATE_INVITE, guildId, c.id)}
        <button class="icon-btn mini hov" title="Invite" onclick={() => (ui.invite = c.id)}><Icon name="user-plus" size={15} /></button>
      {/if}
      {#if canManage}
        <button class="icon-btn mini hov" title="Edit channel" onclick={() => (ui.channelSettings = c.id)}><Icon name="settings" size={15} /></button>
      {/if}
    </div>
    {#if c.type === ChannelType.VOICE}
      {@const people = [...g.voice.values()].filter((v) => v.channelId === c.id)}
      {#if people.length}
        <div class="vlist">
          {#each people as v (v.userId)}
            <button
              class="vuser"
              onclick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                ui.profile = { userId: v.userId, guildId, x: r.right + 8, y: r.top };
              }}
            >
              <Avatar src={app.avatarOf(v.userId, guildId)} name={app.displayName(v.userId, guildId)} size={22} speaking={voice.speaking.has(v.userId)} />
              <span class="truncate">{app.displayName(v.userId, guildId)}</span>
              {#if v.streaming}<span class="live">LIVE</span>{/if}
              {#if v.video}<Icon name="video" size={13} />{/if}
              {#if v.serverMute || v.selfMute}<Icon name="mic-off" size={13} class={v.serverMute ? 'red' : ''} />{/if}
              {#if v.serverDeaf || v.selfDeaf}<Icon name="headphones-off" size={13} class={v.serverDeaf ? 'red' : ''} />{/if}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
    {#each threadsByParent.get(c.id) ?? [] as t (t.id)}
      <div class="crow thread" class:active={activeChannel === t.id} class:unread={app.isUnread(t.id)}>
        <button class="cbtn" onclick={() => goto(`/app/${guildId}/${t.id}`)}>
          <span class="branch"></span>
          <span class="truncate">{t.name}</span>
        </button>
        {#if app.mentions(t.id)}<span class="badge">{app.mentions(t.id)}</span>{/if}
      </div>
    {/each}
  {/snippet}

  {#each tree.loose as c (c.id)}{@render channelRow(c)}{/each}
  {#each tree.cats as { cat, children } (cat.id)}
    <div class="cat">
      <button class="catbtn" onclick={() => toggle(cat.id)}>
        <Icon name={collapsed[cat.id] ? 'chevron-right' : 'chevron-down'} size={12} stroke={3} />
        <span class="truncate">{cat.name}</span>
      </button>
      {#if canManage}
        <button class="icon-btn mini hov2" title="Create channel" onclick={() => (ui.createChannel = { guildId, parentId: cat.id, type: ChannelType.TEXT })}>
          <Icon name="plus" size={15} />
        </button>
      {/if}
    </div>
    {#each children.filter((c) => !collapsed[cat.id] || activeChannel === c.id || app.isUnread(c.id)) as c (c.id)}{@render channelRow(c)}{/each}
  {/each}
  {#if !tree.loose.length && !tree.cats.length}
    <p class="faint empty">No channels you can see yet.</p>
  {/if}
</div>

{#if headerOpen}
  <Popover anchor={headerEl} onclose={() => (headerOpen = false)}>
    <div class="menu" style="width:220px">
      {#if inviteChannel() && app.can(P.CREATE_INVITE, guildId)}
        <button class="menu-item" onclick={() => ((ui.invite = inviteChannel()), (headerOpen = false))}><Icon name="user-plus" size={16} /> Invite people</button>
      {/if}
      {#if anySettings}
        <button class="menu-item" onclick={() => ((ui.guildSettings = { guildId, tab: 'overview' }), (headerOpen = false))}><Icon name="settings" size={16} /> Server settings</button>
      {/if}
      {#if canManage}
        <button class="menu-item" onclick={() => ((ui.createChannel = { guildId, parentId: null, type: ChannelType.TEXT }), (headerOpen = false))}><Icon name="plus" size={16} /> Create channel</button>
        <button class="menu-item" onclick={() => ((ui.createChannel = { guildId, parentId: null, type: ChannelType.CATEGORY }), (headerOpen = false))}><Icon name="menu" size={16} /> Create category</button>
      {/if}
      {#if g.guild.levels.enabled}
        <button class="menu-item" onclick={() => ((ui.guildSettings = { guildId, tab: 'leaderboard' }), (headerOpen = false))}><Icon name="trophy" size={16} /> Leaderboard</button>
      {/if}
      <button class="menu-item" onclick={() => ((ui.guildSettings = { guildId, tab: 'notifications' }), (headerOpen = false))}><Icon name="bell" size={16} /> Notification settings</button>
      <button class="menu-item" onclick={() => ((ui.settings = `server-profile:${guildId}`), (headerOpen = false))}><Icon name="edit" size={16} /> Edit server profile</button>
      {#if !isOwner}
        <div class="menu-sep"></div>
        <button
          class="menu-item danger"
          onclick={() => {
            headerOpen = false;
            ui.confirm(`Leave ${g.guild.name}?`, "You won't be able to rejoin unless you're invited again.", 'Leave server', async () => {
              await del(`/users/@me/guilds/${guildId}`);
              goto('/app/me');
            });
          }}><Icon name="logout" size={16} /> Leave server</button
        >
      {/if}
    </div>
  </Popover>
{/if}

{#if channelMenu}
  {@const c = channelMenu.channel}
  <Popover x={channelMenu.x} y={channelMenu.y} onclose={() => (channelMenu = null)}>
    <div class="menu">
      <button class="menu-item" onclick={() => ((channelMenu = null), app.ack(c.id))}><Icon name="check" size={16} /> Mark as read</button>
      <button class="menu-item" onclick={() => muteChannel(c)}>
        <Icon name={app.isChannelMuted(c.id) ? 'bell' : 'bell-off'} size={16} />
        {app.isChannelMuted(c.id) ? 'Unmute' : 'Mute'} channel
      </button>
      <button class="menu-item" onclick={() => ((channelMenu = null), navigator.clipboard.writeText(`${location.origin}/app/${guildId}/${c.id}`))}>
        <Icon name="link" size={16} /> Copy link
      </button>
      {#if canManage}
        <div class="menu-sep"></div>
        <button class="menu-item" onclick={() => ((ui.channelSettings = c.id), (channelMenu = null))}><Icon name="settings" size={16} /> Edit channel</button>
        <button class="menu-item danger" onclick={() => deleteChannel(c)}><Icon name="trash" size={16} /> Delete channel</button>
      {/if}
    </div>
  </Popover>
{/if}

<style>
  .head {
    height: 48px;
    flex: none;
    border-bottom: 1px solid var(--bg-0);
    box-shadow: 0 1px 0 rgb(0 0 0 / 0.15);
  }
  .title {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 14px;
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 700;
    font-size: 1rem;
    text-align: left;
  }
  .title:hover {
    background: var(--hover);
  }
  .title .truncate {
    flex: 1;
  }
  .banner {
    height: 90px;
    background-size: cover;
    background-position: center;
    flex: none;
  }
  .list {
    flex: 1;
    padding: 8px 8px 16px;
  }
  .cat {
    display: flex;
    align-items: center;
    margin-top: 14px;
  }
  .catbtn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    cursor: pointer;
    text-transform: uppercase;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--text-faint);
    padding: 4px 2px;
    min-width: 0;
  }
  .catbtn:hover {
    color: var(--text);
  }
  .crow {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 6px;
    margin: 1px 0;
    color: var(--text-faint);
  }
  .crow:hover {
    background: var(--hover);
    color: var(--text-muted);
  }
  .crow.active {
    background: var(--active);
    color: var(--text);
  }
  .crow.unread {
    color: var(--text);
    font-weight: 700;
  }
  .crow.muted {
    opacity: 0.5;
  }
  .dot {
    position: absolute;
    left: -8px;
    width: 4px;
    height: 8px;
    border-radius: 0 4px 4px 0;
    background: var(--text);
  }
  .cbtn {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: none;
    background: none;
    cursor: pointer;
    color: inherit;
    font-weight: inherit;
    text-align: left;
    min-width: 0;
    position: relative;
  }
  .cbtn :global(.lockico) {
    position: absolute;
    left: 18px;
    top: 14px;
  }
  .mini {
    width: 24px;
    height: 24px;
  }
  .hov {
    display: none;
  }
  .crow:hover .hov,
  .crow.active .hov {
    display: inline-grid;
  }
  .hov2 {
    opacity: 0.7;
  }
  .thread .cbtn {
    padding-left: 22px;
    font-size: 0.9rem;
  }
  .branch {
    width: 10px;
    height: 12px;
    border-left: 2px solid var(--bg-3);
    border-bottom: 2px solid var(--bg-3);
    border-bottom-left-radius: 6px;
    margin-top: -8px;
    flex: none;
  }
  .vlist {
    padding: 0 0 4px 26px;
  }
  .vuser {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 3px 6px;
    border: none;
    background: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.88rem;
    border-radius: 6px;
    text-align: left;
  }
  .vuser:hover {
    background: var(--hover);
  }
  .vuser .truncate {
    flex: 1;
  }
  .vuser :global(.red) {
    color: var(--danger);
  }
  .live {
    background: var(--danger);
    color: #fff;
    font-size: 0.62rem;
    font-weight: 800;
    padding: 0 4px;
    border-radius: 4px;
  }
  .empty {
    padding: 12px;
    font-size: 0.9rem;
  }
</style>
