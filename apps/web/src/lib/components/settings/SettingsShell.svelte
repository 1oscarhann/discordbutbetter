<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';

  let {
    sections,
    tab = $bindable(),
    onclose,
    children,
    footer,
  }: {
    sections: { title: string; items: { id: string; label: string; danger?: boolean }[] }[];
    tab: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  } = $props();

  let navOpen = $state(false);

  $effect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.backdrop') && onclose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
</script>

<div class="shell fade-in" role="dialog" aria-modal="true">
  <nav class="side scroll" class:open={navOpen}>
    <div class="inner">
      {#each sections as s (s.title)}
        <div class="st">{s.title}</div>
        {#each s.items as it (it.id)}
          <button class="item" class:active={tab === it.id} class:danger={it.danger} onclick={() => ((tab = it.id), (navOpen = false))}>{it.label}</button>
        {/each}
        <div class="sep"></div>
      {/each}
    </div>
  </nav>
  <main class="content scroll">
    <button class="icon-btn menu-btn" onclick={() => (navOpen = !navOpen)} aria-label="Sections"><Icon name="menu" /></button>
    <div class="inner">{@render children()}</div>
    {#if footer}<div class="footer">{@render footer()}</div>{/if}
  </main>
  <button class="close" onclick={onclose} aria-label="Close settings"><Icon name="x" size={22} /><span class="faint">ESC</span></button>
</div>

<style>
  .shell {
    position: fixed;
    inset: 0;
    z-index: 90;
    display: flex;
    background: var(--bg-2);
  }
  .side {
    flex: 1 0 220px;
    display: flex;
    justify-content: flex-end;
    background: var(--bg-1);
    padding: 60px 8px 20px 20px;
  }
  .side .inner {
    width: 200px;
  }
  .st {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 6px 10px;
  }
  .item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 7px 10px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 2px;
  }
  .item:hover {
    background: var(--hover);
    color: var(--text);
  }
  .item.active {
    background: var(--active);
    color: var(--text);
  }
  .item.danger {
    color: var(--danger);
  }
  .sep {
    height: 1px;
    background: var(--border);
    margin: 8px 10px;
  }
  .content {
    flex: 1 1 800px;
    padding: 60px 40px 80px;
    position: relative;
  }
  .content .inner {
    max-width: 740px;
  }
  .footer {
    position: sticky;
    bottom: 0;
    max-width: 740px;
    margin-top: 20px;
  }
  .close {
    position: fixed;
    top: 54px;
    right: 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 0.7rem;
    font-weight: 700;
  }
  .close :global(svg) {
    border: 2px solid currentColor;
    border-radius: 50%;
    padding: 4px;
    width: 34px;
    height: 34px;
  }
  .menu-btn {
    display: none;
  }
  @media (max-width: 860px) {
    .side {
      position: fixed;
      inset: 0 auto 0 0;
      width: 260px;
      z-index: 2;
      transform: translateX(-100%);
      transition: transform 0.15s;
      padding-top: 20px;
      justify-content: flex-start;
    }
    .side.open {
      transform: none;
    }
    .menu-btn {
      display: inline-grid;
      position: absolute;
      top: 12px;
      left: 12px;
    }
    .content {
      padding: 56px 16px 80px;
    }
    .close {
      top: 12px;
      right: 12px;
    }
  }
</style>
