<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';
  import Popover from '../Popover.svelte';
  import { del, errorMessage, patch } from '$lib/api';
  import { Permissions as P } from '@haunt/shared';

  const active = $derived(page.params.guildId ?? null);

  const ordered = $derived.by(() => {
    const order = app.settings.guildOrder;
    const all = [...app.guilds.values()];
    return all.sort((a, b) => {
      const ia = order.indexOf(a.guild.id);
      const ib = order.indexOf(b.guild.id);
      if (ia === -1 && ib === -1) return 0;
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
  });

  let menu = $state<{ guildId: string; x: number; y: number } | null>(null);
  let dragId = $state<string | null>(null);

  function lastChannel(guildId: string): string {
    try {
      return localStorage.getItem(`lastChannel:${guildId}`) ?? '';
    } catch {
      return '';
    }
  }

  function open(guildId: string) {
    const c = lastChannel(guildId);
    goto(`/app/${guildId}${c && app.channel(c) ? `/${c}` : ''}`);
  }

  function drop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const ids = ordered.map((g) => g.guild.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    dragId = null;
    void app.updateSettings({ guildOrder: ids });
  }

  async function markRead(guildId: string) {
    const g = app.guilds.get(guildId);
    if (!g) return;
    for (const c of [...g.channels.values(), ...g.threads.values()]) if (app.isUnread(c.id) || app.mentions(c.id)) app.ack(c.id);
    menu = null;
  }

  async function toggleMute(guildId: string) {
    menu = null;
    try {
      await patch(`/users/@me/guilds/${guildId}/notifications`, { muteSeconds: app.isGuildMuted(guildId) ? null : -1 });
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function leave(guildId: string) {
    menu = null;
    const g = app.guilds.get(guildId);
    ui.confirm(`Leave ${g?.guild.name}?`, "You won't be able to rejoin unless you're invited again.", 'Leave server', async () => {
      await del(`/users/@me/guilds/${guildId}`);
      goto('/app/me');
    });
  }
</script>

<div class="rail scroll" role="list">
  <a
    href="/app/me"
    class="item home"
    class:active={!active}
    title="Direct messages"
    onclick={(e) => {
      e.preventDefault();
      goto('/app/me');
    }}
  >
    <span class="pill" class:show={!active}></span>
    <span class="icon"><img src="/favicon.svg" alt="" width="30" height="30" /></span>
    {#if app.dmMentionTotal}<span class="badge mb">{app.dmMentionTotal}</span>{/if}
  </a>
  <div class="sep"></div>
  {#each ordered as g (g.guild.id)}
    {@const u = app.guildUnread(g.guild.id)}
    <div
      class="item"
      class:active={active === g.guild.id}
      class:dragging={dragId === g.guild.id}
      role="listitem"
      draggable="true"
      ondragstart={() => (dragId = g.guild.id)}
      ondragover={(e) => e.preventDefault()}
      ondrop={() => drop(g.guild.id)}
      ondragend={() => (dragId = null)}
    >
      <span class="pill" class:show={active === g.guild.id || u.unread} class:full={active === g.guild.id}></span>
      <button
        class="icon"
        title={g.guild.name}
        onclick={() => open(g.guild.id)}
        oncontextmenu={(e) => {
          e.preventDefault();
          menu = { guildId: g.guild.id, x: e.clientX, y: e.clientY };
        }}
      >
        <Avatar src={g.guild.icon} name={g.guild.name} size={46} square={active === g.guild.id} />
      </button>
      {#if u.mentions}<span class="badge mb">{u.mentions > 99 ? '99+' : u.mentions}</span>{/if}
    </div>
  {/each}
  <button class="item add" title="Create a server" onclick={() => (ui.createGuild = true)}>
    <span class="icon"><Icon name="plus" size={22} /></span>
  </button>
  <button class="item add" title="Join a server" onclick={() => (ui.joinGuild = true)}>
    <span class="icon"><Icon name="globe" size={20} /></span>
  </button>
</div>

{#if menu}
  {@const gid = menu.guildId}
  <Popover x={menu.x} y={menu.y} onclose={() => (menu = null)}>
    <div class="menu">
      <button class="menu-item" onclick={() => markRead(gid)}><Icon name="check" size={16} /> Mark as read</button>
      <button class="menu-item" onclick={() => toggleMute(gid)}>
        <Icon name={app.isGuildMuted(gid) ? 'bell' : 'bell-off'} size={16} />
        {app.isGuildMuted(gid) ? 'Unmute server' : 'Mute server'}
      </button>
      {#if app.can(P.CREATE_INVITE, gid)}
        <button
          class="menu-item"
          onclick={() => {
            const first = [...(app.guilds.get(gid)?.channels.values() ?? [])].find((c) => c.type === 0);
            if (first) ui.invite = first.id;
            menu = null;
          }}><Icon name="user-plus" size={16} /> Invite people</button
        >
      {/if}
      <button
        class="menu-item"
        onclick={() => {
          ui.guildSettings = { guildId: gid, tab: 'overview' };
          menu = null;
        }}><Icon name="settings" size={16} /> Server settings</button
      >
      {#if app.guilds.get(gid)?.guild.ownerId !== app.me?.id}
        <div class="menu-sep"></div>
        <button class="menu-item danger" onclick={() => leave(gid)}><Icon name="logout" size={16} /> Leave server</button>
      {/if}
    </div>
  </Popover>
{/if}

<style>
  .rail {
    width: 72px;
    flex: none;
    background: var(--bg-0);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 12px 0;
  }
  .item {
    position: relative;
    display: grid;
    place-items: center;
    width: 72px;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--text);
  }
  .item.dragging {
    opacity: 0.4;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg-2);
    border: none;
    padding: 0;
    cursor: pointer;
    transition: border-radius 0.15s;
    overflow: hidden;
    color: inherit;
  }
  .item:hover .icon,
  .item.active .icon {
    border-radius: 30%;
  }
  .home .icon {
    background: var(--bg-2);
  }
  .home.active .icon {
    background: var(--accent);
  }
  .add .icon {
    color: var(--success);
  }
  .add:hover .icon {
    background: var(--success);
    color: #fff;
  }
  .pill {
    position: absolute;
    left: 0;
    width: 4px;
    height: 0;
    border-radius: 0 4px 4px 0;
    background: var(--text);
    transition: height 0.15s;
  }
  .pill.show {
    height: 8px;
  }
  .pill.full,
  .item:hover .pill {
    height: 36px;
  }
  .mb {
    position: absolute;
    right: 10px;
    bottom: -2px;
    border: 3px solid var(--bg-0);
    height: 22px;
    min-width: 22px;
    border-radius: 11px;
  }
  .sep {
    width: 32px;
    height: 2px;
    border-radius: 1px;
    background: var(--bg-3);
    flex: none;
  }
</style>
