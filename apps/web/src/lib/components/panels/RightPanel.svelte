<script lang="ts">
  import type { Channel } from '@haunt/shared';
  import { ui, type RightPanel } from '$lib/state/ui.svelte';
  import MemberList from './MemberList.svelte';
  import PinsPanel from './PinsPanel.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import ThreadsPanel from './ThreadsPanel.svelte';
  import Icon from '../Icon.svelte';

  let { channel, panel }: { channel: Channel; panel: NonNullable<RightPanel> } = $props();
  const TITLES: Record<string, string> = { pins: 'Pinned messages', search: 'Search', threads: 'Threads', members: 'Members' };
</script>

<aside class="side">
  {#if panel !== 'members'}
    <header>
      <strong>{TITLES[panel] ?? ''}</strong>
      <button class="icon-btn" aria-label="Close" onclick={() => (ui.rightPanel = channel.guildId ? 'members' : null)}><Icon name="x" size={18} /></button>
    </header>
  {/if}
  {#if panel === 'members' && channel.guildId}
    <MemberList guildId={channel.guildId} channelId={channel.id} />
  {:else if panel === 'pins'}
    <PinsPanel {channel} />
  {:else if panel === 'search'}
    <SearchPanel {channel} />
  {:else if panel === 'threads'}
    <ThreadsPanel {channel} />
  {/if}
</aside>

<style>
  .side {
    width: 300px;
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    min-height: 0;
    border-left: 1px solid var(--bg-0);
  }
  header {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 0 14px;
    border-bottom: 1px solid var(--bg-0);
  }
  @media (max-width: 1100px) {
    .side {
      position: absolute;
      right: 0;
      top: 48px;
      bottom: 0;
      z-index: 30;
      box-shadow: var(--shadow);
    }
  }
  @media (max-width: 760px) {
    .side {
      width: 100%;
    }
  }
</style>
