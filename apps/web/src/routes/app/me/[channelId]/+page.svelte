<script lang="ts">
  import { page } from '$app/state';
  import ChatView from '$lib/components/chat/ChatView.svelte';
  import { ui } from '$lib/state/ui.svelte';

  const channelId = $derived(page.params.channelId ?? '');
  // deep link to a message: /app/me/<channel>?m=<message>
  $effect(() => {
    const m = page.url.searchParams.get('m');
    if (m && channelId) ui.jumpTo = { channelId, messageId: m };
  });
</script>

{#key channelId}
  <ChatView {channelId} />
{/key}
