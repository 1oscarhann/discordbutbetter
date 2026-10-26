<script lang="ts">
  import { goto } from '$app/navigation';
  import { ChannelType, compareIds, isDmType } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { channelHref, channelTitle } from '$lib/util/channel';
  import Modal from '../Modal.svelte';
  import Icon, { type IconName } from '../Icon.svelte';

  interface Item {
    key: string;
    label: string;
    sub: string;
    icon: IconName;
    href: string;
    last: string;
    unread: boolean;
  }

  let q = $state('');
  let sel = $state(0);

  const all = $derived.by((): Item[] => {
    const out: Item[] = [];
    for (const c of app.dms.values()) {
      out.push({ key: c.id, label: channelTitle(c), sub: c.type === ChannelType.GROUP_DM ? 'Group DM' : 'Direct message', icon: 'at', href: channelHref(c), last: c.lastMessageId ?? '0', unread: app.isUnread(c.id) });
    }
    for (const g of app.guilds.values()) {
      out.push({ key: 'g' + g.guild.id, label: g.guild.name, sub: 'Server', icon: 'home', href: `/app/${g.guild.id}`, last: '0', unread: false });
      for (const c of g.channels.values()) {
        if (c.type === ChannelType.CATEGORY || isDmType(c.type)) continue;
        const icon: IconName = c.type === ChannelType.VOICE ? 'speaker' : c.type === ChannelType.WIKI ? 'book' : 'hash';
        out.push({ key: c.id, label: c.name ?? '', sub: g.guild.name, icon, href: channelHref(c), last: c.lastMessageId ?? '0', unread: app.isUnread(c.id) });
      }
      for (const t of g.threads.values()) {
        out.push({ key: t.id, label: t.name ?? '', sub: `Thread in ${g.guild.name}`, icon: 'thread', href: channelHref(t), last: t.lastMessageId ?? '0', unread: app.isUnread(t.id) });
      }
    }
    return out;
  });

  /** Subsequence match; consecutive and early hits score higher. */
  function score(label: string, query: string): number {
    const l = label.toLowerCase();
    if (l === query) return 1000;
    if (l.startsWith(query)) return 500 - l.length;
    const idx = l.indexOf(query);
    if (idx >= 0) return 300 - idx;
    let li = 0;
    let s = 0;
    for (const ch of query) {
      const f = l.indexOf(ch, li);
      if (f < 0) return -1;
      s += f === li ? 3 : 1;
      li = f + 1;
    }
    return s;
  }

  const results = $derived.by(() => {
    const query = q.trim().toLowerCase().replace(/^[#@]/, '');
    if (!query) {
      // nothing typed: unread first, then most recently active
      return [...all]
        .filter((i) => i.last !== '0')
        .sort((a, b) => Number(b.unread) - Number(a.unread) || compareIds(b.last, a.last))
        .slice(0, 12);
    }
    return all
      .map((i) => ({ i, s: score(i.label, query) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || compareIds(b.i.last, a.i.last))
      .slice(0, 12)
      .map((x) => x.i);
  });

  $effect(() => {
    void results;
    sel = 0;
  });

  function open(i: Item | undefined) {
    if (!i) return;
    ui.quickSwitcher = false;
    void goto(i.href);
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = (sel + 1) % Math.max(1, results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel - 1 + results.length) % Math.max(1, results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(results[sel]);
    }
  }
</script>

<Modal title="Jump to" onclose={() => (ui.quickSwitcher = false)} width={520}>
  <input class="input big" placeholder="Where to? Channels, DMs, servers…" bind:value={q} onkeydown={key} aria-label="Search" />
  <div class="list" role="listbox">
    {#each results as r, i (r.key)}
      <button class="it" class:sel={i === sel} role="option" aria-selected={i === sel} onmouseenter={() => (sel = i)} onclick={() => open(r)}>
        <Icon name={r.icon} size={16} />
        <span class="truncate" class:unread={r.unread}>{r.label}</span>
        <span class="faint small truncate sub">{r.sub}</span>
      </button>
    {:else}
      <p class="faint small">{q ? 'Nothing matches.' : 'Start typing to search.'}</p>
    {/each}
  </div>
  <p class="faint small hint"><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> to pick, <kbd class="kbd">Enter</kbd> to go, <kbd class="kbd">Esc</kbd> to close</p>
</Modal>

<style>
  .big {
    font-size: 1.05rem;
    padding: 12px;
  }
  .list {
    margin-top: 10px;
    max-height: 50vh;
    overflow: auto;
  }
  .it {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    color: var(--text-muted);
  }
  .it.sel {
    background: var(--active);
    color: var(--text);
  }
  .unread {
    font-weight: 700;
    color: var(--text);
  }
  .sub {
    margin-left: auto;
    flex: none;
    max-width: 45%;
  }
  .hint {
    margin: 10px 0 0;
  }
</style>
