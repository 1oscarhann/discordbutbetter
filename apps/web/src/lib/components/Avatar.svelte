<script lang="ts">
  import { initials } from '@dbb/shared';
  import type { VisibleStatus } from '@dbb/shared';
  import StatusDot from './StatusDot.svelte';

  let {
    src = null,
    name = '?',
    size = 40,
    status = null,
    speaking = false,
    square = false,
  }: { src?: string | null; name?: string; size?: number; status?: VisibleStatus | null; speaking?: boolean; square?: boolean } = $props();

  let failed = $state(false);
  // deterministic colour for the initials fallback
  const hue = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
</script>

<span class="avatar" class:speaking class:square style="width:{size}px;height:{size}px">
  {#if src && !failed}
    <img {src} alt="" width={size} height={size} loading="lazy" decoding="async" onerror={() => (failed = true)} />
  {:else}
    <span class="fallback" style="background:hsl({hue} 45% 42%);font-size:{Math.max(10, size * 0.38)}px">{initials(name)}</span>
  {/if}
  {#if status}
    <span class="dot" style="--s:{Math.max(10, size * 0.32)}px">
      <StatusDot {status} size={Math.max(10, size * 0.32)} />
    </span>
  {/if}
</span>

<style>
  .avatar {
    position: relative;
    display: inline-block;
    flex: none;
    border-radius: 50%;
  }
  .avatar.square {
    border-radius: 28%;
  }
  .avatar img,
  .fallback {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
    display: grid;
    place-items: center;
    color: #fff;
    font-weight: 700;
    user-select: none;
  }
  .speaking {
    box-shadow:
      0 0 0 2px var(--bg-1),
      0 0 0 4px var(--success);
  }
  .dot {
    position: absolute;
    right: -2px;
    bottom: -2px;
    border-radius: 50%;
    background: var(--bg-1);
    padding: 2px;
    display: grid;
  }
</style>
