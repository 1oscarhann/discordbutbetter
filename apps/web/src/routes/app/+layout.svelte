<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { onUnauthorized } from '$lib/api';
  import ServerRail from '$lib/components/layout/ServerRail.svelte';
  import GuildSidebar from '$lib/components/layout/GuildSidebar.svelte';
  import DmSidebar from '$lib/components/layout/DmSidebar.svelte';
  import UserPanel from '$lib/components/layout/UserPanel.svelte';
  import Modals from '$lib/components/layout/Modals.svelte';

  let { children } = $props();
  const guildId = $derived(page.params.guildId ?? null);

  onMount(() => {
    const off = onUnauthorized(() => app.loggedOut());
    void app.start();
    return () => {
      off();
      app.stop();
    };
  });

  $effect(() => {
    const g = guildId ? app.guilds.get(guildId)?.guild.name : null;
    const n = app.instance?.name ?? '';
    const unread = app.dmMentionTotal + [...app.guilds.keys()].reduce((s, id) => s + app.guildUnread(id).mentions, 0);
    document.title = `${unread ? `(${unread}) ` : ''}${g ? `${g} · ` : ''}${n}`;
  });

  // close the mobile drawer on navigation
  $effect(() => {
    void page.url.pathname;
    ui.mobileNav = false;
  });
</script>

{#if app.status !== 'ready'}
  <div class="splash">
    <img src="/favicon.svg" alt="" width="56" height="56" />
    <p class="muted">{app.connection === 'closed' ? 'Connecting… (retrying)' : 'Loading…'}</p>
  </div>
{:else}
  <div class="shell" class:nav-open={ui.mobileNav}>
    <nav class="left" aria-label="Servers and channels">
      <ServerRail />
      <div class="sidebar">
        {#if guildId && app.guilds.has(guildId)}
          <GuildSidebar {guildId} />
        {:else}
          <DmSidebar />
        {/if}
        <UserPanel />
      </div>
    </nav>
    <button class="scrim" aria-label="Close menu" onclick={() => (ui.mobileNav = false)}></button>
    <section class="main">
      {#if app.connection !== 'open'}
        <div class="conn">Connection lost — reconnecting…</div>
      {/if}
      {#if app.me && !app.me.emailVerified && app.instance?.emailEnabled}
        <div class="verify">Check your inbox to confirm your email. <a href="/app/me" onclick={(e) => { e.preventDefault(); ui.settings = 'account'; }}>Resend</a></div>
      {/if}
      {@render children()}
    </section>
  </div>
  <Modals />
{/if}

<style>
  .splash {
    height: 100vh;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 12px;
    background: var(--bg-1);
  }
  .shell {
    display: flex;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }
  .left {
    display: flex;
    flex: none;
  }
  .sidebar {
    width: 248px;
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    min-height: 0;
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
  }
  .conn,
  .verify {
    background: var(--warning);
    color: #111;
    text-align: center;
    font-size: 0.85rem;
    font-weight: 600;
    padding: 4px;
  }
  .verify {
    background: var(--accent);
    color: var(--accent-text);
  }
  .verify a {
    color: inherit;
    text-decoration: underline;
  }
  .scrim {
    display: none;
  }
  @media (max-width: 760px) {
    .left {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 50;
      transform: translateX(-100%);
      transition: transform 0.18s ease;
    }
    .nav-open .left {
      transform: none;
    }
    .nav-open .scrim {
      display: block;
      position: fixed;
      inset: 0;
      background: rgb(0 0 0 / 0.5);
      z-index: 40;
      border: none;
    }
  }
</style>
