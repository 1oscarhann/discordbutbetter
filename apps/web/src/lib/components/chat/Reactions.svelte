<script lang="ts">
  import type { Channel, Message, PublicUser } from '@haunt/shared';
  import { get } from '$lib/api';
  import { app } from '$lib/state/app.svelte';

  let { message, channel, onToggle }: { message: Message; channel: Channel; onToggle: (key: string) => void } = $props();
  let who = $state<Record<string, string>>({});

  function src(key: string): string {
    const id = key.slice(2);
    for (const g of app.guilds.values()) {
      const e = g.emojis.find((x) => x.id === id);
      if (e) return e.url;
    }
    return `/api/emojis/${id}`;
  }

  async function loadWho(key: string) {
    if (who[key]) return;
    try {
      const users = await get<PublicUser[]>(`/channels/${channel.id}/messages/${message.id}/reactions/${encodeURIComponent(key)}`);
      const names = users.slice(0, 12).map((u) => app.displayName(u.id, channel.guildId));
      who = { ...who, [key]: names.join(', ') + (users.length > 12 ? ` and ${users.length - 12} more` : '') };
    } catch {
      /* ignore */
    }
  }
</script>

<div class="reactions">
  {#each message.reactions as r (r.emoji)}
    <button
      class="r"
      class:me={r.me}
      onclick={() => onToggle(r.emoji)}
      onmouseenter={() => loadWho(r.emoji)}
      title={who[r.emoji] ? `${who[r.emoji]} reacted with ${r.emoji.startsWith('c:') ? `:${r.name}:` : r.emoji}` : ''}
    >
      {#if r.emoji.startsWith('c:')}
        <img src={src(r.emoji)} alt=":{r.name ?? 'emoji'}:" class="emoji" />
      {:else}
        <span class="u">{r.emoji}</span>
      {/if}
      <span class="n">{r.count}</span>
    </button>
  {/each}
</div>

<style>
  .reactions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .r {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: var(--bg-1);
    cursor: pointer;
    font-size: 0.9rem;
  }
  .r:hover {
    border-color: var(--border);
  }
  .r.me {
    background: color-mix(in srgb, var(--accent) 18%, transparent);
    border-color: var(--accent);
  }
  .u {
    font-size: 1.05rem;
    line-height: 1.2;
  }
  .emoji {
    width: 18px;
    height: 18px;
  }
  .n {
    font-weight: 700;
    font-size: 0.82rem;
    color: var(--text-muted);
  }
  .me .n {
    color: var(--text);
  }
</style>
