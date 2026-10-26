<script lang="ts">
  import type { Snippet } from 'svelte';

  /**
   * Floating panel anchored to a point or element; flips to stay on screen; closes on outside click / Esc.
   */
  let {
    x,
    y,
    anchor = null,
    placement = 'bottom-start',
    onclose,
    children,
  }: {
    x?: number;
    y?: number;
    anchor?: HTMLElement | null;
    placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start' | 'left-start';
    onclose: () => void;
    children: Snippet;
  } = $props();

  let el: HTMLDivElement;
  let pos = $state({ left: -9999, top: -9999 });

  function place() {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = x ?? 0;
    let top = y ?? 0;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      if (placement.startsWith('bottom')) {
        top = r.bottom + 6;
        left = placement.endsWith('end') ? r.right - w : r.left;
      } else if (placement.startsWith('top')) {
        top = r.top - h - 6;
        left = placement.endsWith('end') ? r.right - w : r.left;
      } else if (placement === 'right-start') {
        left = r.right + 8;
        top = r.top;
      } else {
        left = r.left - w - 8;
        top = r.top;
      }
    }
    // keep on screen
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (top + h > window.innerHeight - 8) top = anchor && placement.startsWith('bottom') ? anchor.getBoundingClientRect().top - h - 6 : window.innerHeight - h - 8;
    pos = { left: Math.max(8, left), top: Math.max(8, top) };
  }

  $effect(() => {
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    const down = (e: MouseEvent) => {
      if (!el.contains(e.target as Node) && !anchor?.contains(e.target as Node)) onclose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onclose();
    setTimeout(() => window.addEventListener('mousedown', down), 0);
    window.addEventListener('keydown', key);
    window.addEventListener('resize', onclose);
    return () => {
      ro.disconnect();
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
      window.removeEventListener('resize', onclose);
    };
  });
</script>

<div class="pop fade-in" bind:this={el} style="left:{pos.left}px;top:{pos.top}px">
  {@render children()}
</div>

<style>
  .pop {
    position: fixed;
    z-index: 80;
  }
</style>
