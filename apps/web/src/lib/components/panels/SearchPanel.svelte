<script lang="ts">
  import { goto } from '$app/navigation';
  import type { Channel, SearchResult } from '@dbb/shared';
  import { errorMessage, get } from '$lib/api';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import MiniMessage from './MiniMessage.svelte';

  let { channel }: { channel: Channel } = $props();

  let q = $state(ui.searchQuery);
  let author = $state('');
  let has = $state('');
  let inThis = $state(false);
  let sort = $state<'newest' | 'oldest'>('newest');
  let result = $state<SearchResult | null>(null);
  let loading = $state(false);
  let error = $state('');
  let offset = $state(0);

  const people = $derived.by(() => {
    if (channel.guildId) return [...(app.guilds.get(channel.guildId)?.members.values() ?? [])].map((m) => m.user);
    const s = new Map<string, { id: string; username: string }>();
    for (const d of app.dms.values()) for (const r of d.recipients ?? []) s.set(r.id, r);
    return [...s.values()];
  });

  async function run(reset = true) {
    if (reset) offset = 0;
    loading = true;
    error = '';
    const params = new URLSearchParams({ sort, offset: String(offset), limit: '25' });
    if (q.trim()) params.set('q', q.trim());
    if (author) params.set('authorId', author);
    if (has) params.set('has', has);
    if (inThis) params.set('channelId', channel.id);
    try {
      const path = channel.guildId ? `/guilds/${channel.guildId}/messages/search` : '/users/@me/messages/search';
      result = await get<SearchResult>(`${path}?${params}`);
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (ui.searchQuery) {
      q = ui.searchQuery;
      ui.searchQuery = '';
      void run();
    }
  });

  function jump(channelId: string, messageId: string) {
    const c = app.channel(channelId);
    if (!c) return;
    ui.jumpTo = { channelId, messageId };
    if (c.id !== channel.id) goto(c.guildId ? `/app/${c.guildId}/${c.id}` : `/app/me/${c.id}`);
  }
</script>

<form class="filters" onsubmit={(e) => (e.preventDefault(), run())}>
  <input class="input" placeholder={channel.guildId ? 'Search this server' : 'Search your DMs'} bind:value={q} />
  <div class="row">
    <select class="select" bind:value={author}>
      <option value="">From anyone</option>
      {#each people as u (u.id)}<option value={u.id}>{app.displayName(u.id, channel.guildId)}</option>{/each}
    </select>
    <select class="select" bind:value={has}>
      <option value="">Has anything</option>
      <option value="file">Has file</option>
      <option value="image">Has image</option>
      <option value="video">Has video</option>
      <option value="link">Has link</option>
      <option value="embed">Has embed</option>
    </select>
  </div>
  <div class="row">
    <label class="row small"><input type="checkbox" bind:checked={inThis} /> Only this channel</label>
    <span class="spacer"></span>
    <select class="select tiny" bind:value={sort}><option value="newest">Newest</option><option value="oldest">Oldest</option></select>
    <button class="btn primary small" disabled={loading}>Search</button>
  </div>
</form>

<div class="scroll results">
  {#if error}<p class="error-text">{error}</p>{/if}
  {#if result}
    <p class="faint small">{result.total >= 5000 ? '5000+' : result.total} results</p>
    {#each result.messages as m (m.id)}
      {@const ch = result.channels[m.channelId]}
      <MiniMessage message={m} label={ch?.name ? `#${ch.name}` : null} onclick={() => jump(m.channelId, m.id)} />
    {/each}
    {#if result.total > offset + 25}
      <button class="btn block small" onclick={() => ((offset += 25), run(false))}>More results</button>
    {/if}
  {:else if !loading}
    <p class="faint small tip">Tip: the last word matches as a prefix, so “prog” finds “programming”.</p>
  {/if}
</div>

<style>
  .filters {
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    border-bottom: 1px solid var(--border);
  }
  .filters .select {
    padding: 6px;
    font-size: 0.85rem;
  }
  .tiny {
    width: auto;
  }
  .small {
    font-size: 0.82rem;
  }
  .results {
    flex: 1;
    padding: 10px;
  }
  .tip {
    text-align: center;
    padding: 20px 10px;
  }
</style>
