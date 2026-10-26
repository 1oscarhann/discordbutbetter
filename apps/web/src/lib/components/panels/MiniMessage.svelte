<script lang="ts">
  import type { Message } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { messageTime } from '$lib/util/time';
  import Avatar from '../Avatar.svelte';
  import Markdown from '../Markdown.svelte';
  import Attachments from '../chat/Attachments.svelte';

  let { message: m, onclick, label = null }: { message: Message; onclick?: () => void; label?: string | null } = $props();
</script>

<div class="mini">
  {#if label}<div class="label faint">{label}</div>{/if}
  <div class="row">
    <Avatar src={m.author ? app.avatarOf(m.author.id, m.guildId) : null} name={m.author ? app.displayName(m.author.id, m.guildId) : '?'} size={28} />
    <strong class="truncate">{m.author ? app.displayName(m.author.id, m.guildId) : 'Deleted user'}</strong>
    <span class="faint small">{messageTime(m.createdAt, app.settings.use24h)}</span>
    {#if onclick}<button class="btn small ghost jump" {onclick}>Jump</button>{/if}
  </div>
  {#if m.content}<div class="content"><Markdown content={m.content} guildId={m.guildId} jumboAllowed={false} /></div>{/if}
  {#if m.attachments.length}<Attachments attachments={m.attachments} />{/if}
</div>

<style>
  .mini {
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    margin-bottom: 8px;
  }
  .label {
    font-size: 0.72rem;
    margin-bottom: 4px;
  }
  .small {
    font-size: 0.72rem;
  }
  .jump {
    margin-left: auto;
  }
  .content {
    margin-top: 4px;
    font-size: 0.92rem;
  }
</style>
