<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ChannelType } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import ChatView from '$lib/components/chat/ChatView.svelte';
  import VoiceView from '$lib/components/views/VoiceView.svelte';
  import WikiView from '$lib/components/views/WikiView.svelte';

  const guildId = $derived(page.params.guildId ?? '');
  const channelId = $derived(page.params.channelId ?? null);
  const g = $derived(app.guilds.get(guildId));
  const channel = $derived(channelId ? app.channel(channelId) : null);

  // no channel in the url: go to the last one you used, or the first text channel
  // A server you just created or joined can reach us over the gateway a moment after we navigate
  // here, so give it a few seconds before deciding it doesn't exist.
  $effect(() => {
    if (g || app.status !== 'ready') return;
    const id = guildId;
    const t = setTimeout(() => {
      if (!app.guilds.has(id) && page.params.guildId === id) goto('/app/me', { replaceState: true });
    }, 5000);
    return () => clearTimeout(t);
  });

  $effect(() => {
    if (!g) return;
    if (channelId) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(`lastChannel:${guildId}`);
    } catch {
      /* ignore */
    }
    const first = [...g.channels.values()]
      .filter((c) => c.type === ChannelType.TEXT)
      .sort((a, b) => {
        const pa = a.parentId ? (g.channels.get(a.parentId)?.position ?? 0) : -1;
        const pb = b.parentId ? (g.channels.get(b.parentId)?.position ?? 0) : -1;
        return pa - pb || a.position - b.position;
      })[0];
    const target = last && g.channels.has(last) ? last : first?.id;
    if (target) goto(`/app/${guildId}/${target}`, { replaceState: true });
  });

  // on narrow screens panels sit on top of the chat: close them when you switch channels
  $effect(() => {
    void channelId;
    if (window.innerWidth <= 1100) ui.rightPanel = null;
  });

  $effect(() => {
    if (!channelId) return;
    try {
      localStorage.setItem(`lastChannel:${guildId}`, channelId);
    } catch {
      /* ignore */
    }
    const m = page.url.searchParams.get('m');
    if (m) ui.jumpTo = { channelId, messageId: m };
  });
</script>

{#if !g}
  <div class="empty"><p class="faint">Loading…</p></div>
{:else if !channelId}
  <div class="empty"><p class="muted">No channels you can see in {g.guild.name} yet.</p></div>
{:else if !channel}
  <div class="empty"><p class="muted">This channel doesn't exist or you can't see it.</p></div>
{:else}
  {#key channelId}
    {#if channel.type === ChannelType.VOICE}
      <VoiceView {channel} />
    {:else if channel.type === ChannelType.WIKI}
      <WikiView {channel} />
    {:else}
      <ChatView channelId={channel.id} />
    {/if}
  {/key}
{/if}

<style>
  .empty {
    flex: 1;
    display: grid;
    place-items: center;
  }
</style>
