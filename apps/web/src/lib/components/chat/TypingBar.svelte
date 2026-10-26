<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  let { channelId, guildId }: { channelId: string; guildId: string | null } = $props();
  const who = $derived(app.typingIn(channelId).map((u) => app.displayName(u, guildId)));
  const text = $derived(
    who.length === 0
      ? ''
      : who.length === 1
        ? `${who[0]} is typing…`
        : who.length === 2
          ? `${who[0]} and ${who[1]} are typing…`
          : who.length === 3
            ? `${who[0]}, ${who[1]} and ${who[2]} are typing…`
            : 'Several people are typing…',
  );
</script>

<div class="typing" aria-live="polite">
  {#if text}
    <span class="dots"><i></i><i></i><i></i></span>
    <span class="truncate">{text}</span>
  {/if}
</div>

<style>
  .typing {
    height: 20px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 18px;
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-top: -20px;
    position: relative;
    z-index: 2;
    pointer-events: none;
  }
  .dots {
    display: inline-flex;
    gap: 3px;
  }
  .dots i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-muted);
    animation: bounce 1.2s infinite ease-in-out;
  }
  .dots i:nth-child(2) {
    animation-delay: 0.15s;
  }
  .dots i:nth-child(3) {
    animation-delay: 0.3s;
  }
  @keyframes bounce {
    0%,
    80%,
    100% {
      opacity: 0.35;
      transform: translateY(0);
    }
    40% {
      opacity: 1;
      transform: translateY(-3px);
    }
  }
</style>
