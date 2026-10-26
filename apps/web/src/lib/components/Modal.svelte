<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';

  let {
    title = '',
    onclose,
    width = 480,
    children,
    footer,
    bare = false,
  }: { title?: string; onclose: () => void; width?: number; children: Snippet; footer?: Snippet; bare?: boolean } = $props();

  let dialog: HTMLDivElement;

  $effect(() => {
    const prev = document.activeElement as HTMLElement | null;
    // focus the first focusable thing
    const first = dialog.querySelector<HTMLElement>('input, textarea, select, button:not(.close)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onclose();
      }
      if (e.key === 'Tab') {
        const els = [...dialog.querySelectorAll<HTMLElement>('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter(
          (el) => !el.hasAttribute('disabled'),
        );
        if (!els.length) return;
        const [a, b] = [els[0]!, els[els.length - 1]!];
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          b.focus();
        } else if (!e.shiftKey && document.activeElement === b) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
    };
  });
</script>

<div class="backdrop" role="presentation" onmousedown={(e) => e.target === e.currentTarget && onclose()}>
  <div class="dialog fade-in" class:bare bind:this={dialog} role="dialog" aria-modal="true" aria-label={title} style="max-width:{width}px">
    {#if !bare}
      <header>
        <h2>{title}</h2>
        <button class="icon-btn close" onclick={onclose} aria-label="Close"><Icon name="x" /></button>
      </header>
    {/if}
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(0 0 0 / 0.6);
    display: grid;
    place-items: center;
    z-index: 100;
    padding: 16px;
  }
  .dialog {
    width: 100%;
    max-height: calc(100vh - 32px);
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 4px);
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .dialog.bare {
    background: transparent;
    border: none;
    box-shadow: none;
  }
  header {
    display: flex;
    align-items: center;
    padding: 16px 16px 4px 20px;
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 1.15rem;
  }
  .body {
    padding: 12px 20px 20px;
    overflow-y: auto;
  }
  .bare .body {
    padding: 0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    background: var(--bg-0);
  }
</style>
