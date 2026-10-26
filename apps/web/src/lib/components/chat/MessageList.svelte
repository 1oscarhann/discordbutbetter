<script lang="ts">
  import { tick, untrack } from 'svelte';
  import { ChannelType, MessageType, compareIds, isDmType, type Channel, type Message } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { get } from '$lib/api';
  import { channelTitle } from '$lib/util/channel';
  import { dayLabel } from '$lib/util/time';
  import MessageItem from './MessageItem.svelte';
  import TypingBar from './TypingBar.svelte';
  import Icon from '../Icon.svelte';
  import Avatar from '../Avatar.svelte';
  import Markdown from '../Markdown.svelte';

  let { channel, embedded = false, onEditLast, onReply }: { channel: Channel; embedded?: boolean; onEditLast: () => void; onReply: (id: string) => void } = $props();

  const cm = $derived(app.messages.get(channel.id));
  let scroller = $state<HTMLDivElement | null>(null);
  let content = $state<HTMLDivElement | null>(null);
  let atBottom = $state(true);
  let readAtOpen = $state<string | null>(null);
  let highlights = $state<{ unread: number; messages: Message[] } | null>(null);
  let highlightsOpen = $state(true);
  let flashId = $state<string | null>(null);

  function scrollToBottom() {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  async function scrollToMessage(id: string) {
    await tick();
    const el = scroller?.querySelector<HTMLElement>(`[data-mid="${id}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      flashId = id;
      setTimeout(() => (flashId = null), 2200);
    }
  }

  export async function jumpTo(id: string) {
    if (cm?.list.some((m) => m.id === id)) return scrollToMessage(id);
    await app.loadMessages(channel.id, 'around', id);
    await scrollToMessage(id);
  }

  // open / switch channel
  $effect(() => {
    const id = channel.id;
    untrack(() => {
      const c = app.msgs(id);
      readAtOpen = app.readStates.get(id)?.lastReadId ?? null;
      const wasUnread = app.isUnread(id);
      highlights = null;
      highlightsOpen = true;
      const jump = ui.jumpTo?.channelId === id ? ui.jumpTo.messageId : null;
      if (jump) {
        ui.jumpTo = null;
        void app.loadMessages(id, 'around', jump).then(() => scrollToMessage(jump));
      } else if (!c.loaded || c.hasMoreAfter) {
        void app.loadMessages(id).then(async () => {
          await tick();
          scrollToBottom();
        });
      } else {
        void tick().then(scrollToBottom);
      }
      if (wasUnread && readAtOpen && readAtOpen !== '0' && !embedded) {
        void get<{ unread: number; messages: Message[] }>(`/channels/${id}/highlights?after=${readAtOpen}`)
          .then((h) => {
            if (h.unread >= app.settings.highlightsThreshold && h.messages.length) highlights = h;
          })
          .catch(() => {});
      }
      app.ack(id);
    });
  });

  // jump requests for the current channel (search results, pins, replies)
  $effect(() => {
    const j = ui.jumpTo;
    if (j && j.channelId === channel.id) {
      untrack(() => {
        ui.jumpTo = null;
        void jumpTo(j.messageId);
      });
    }
  });

  // stick to the bottom when new messages arrive
  let stick = true;
  $effect.pre(() => {
    void cm?.list.length;
    if (scroller) stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  });
  $effect(() => {
    void cm?.list.length;
    if (stick) void tick().then(scrollToBottom);
  });

  // images/embeds loading change height: stay pinned if we were at the bottom
  $effect(() => {
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (atBottom) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  });

  async function loadOlder() {
    if (!cm || cm.loading || !cm.hasMoreBefore || !scroller) return;
    const prevHeight = scroller.scrollHeight;
    const prevTop = scroller.scrollTop;
    await app.loadMessages(channel.id, 'before');
    await tick();
    if (scroller) scroller.scrollTop = prevTop + (scroller.scrollHeight - prevHeight);
  }

  async function loadNewer() {
    if (!cm || cm.loading || !cm.hasMoreAfter) return;
    await app.loadMessages(channel.id, 'after');
  }

  function onScroll() {
    if (!scroller) return;
    const fromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    const was = atBottom;
    atBottom = fromBottom < 40;
    if (scroller.scrollTop < 400) void loadOlder();
    if (fromBottom < 400) void loadNewer();
    if (atBottom && !was && !cm?.hasMoreAfter) app.ack(channel.id);
  }

  async function jumpToPresent() {
    if (cm?.hasMoreAfter) await app.loadMessages(channel.id);
    await tick();
    scrollToBottom();
  }

  function grouped(list: Message[], i: number): boolean {
    const m = list[i]!;
    const prev = list[i - 1];
    if (!prev || !m.author || !prev.author) return false;
    if (m.type !== MessageType.DEFAULT || prev.type !== MessageType.DEFAULT) return false;
    if (m.replyTo) return false;
    if (m.author.id !== prev.author.id) return false;
    if (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 7 * 60_000) return false;
    return new Date(m.createdAt).toDateString() === new Date(prev.createdAt).toDateString();
  }

  function newDay(list: Message[], i: number): boolean {
    const prev = list[i - 1];
    return !prev || new Date(prev.createdAt).toDateString() !== new Date(list[i]!.createdAt).toDateString();
  }

  const firstUnreadId = $derived.by(() => {
    if (!readAtOpen || !cm) return null;
    const m = cm.list.find((x) => compareIds(x.id, readAtOpen!) > 0 && x.author?.id !== app.me?.id && !x.pending);
    return m?.id ?? null;
  });

  // read receipts: the newest of my messages each other person has read up to
  const receiptFor = $derived.by(() => {
    const r = app.receipts.get(channel.id);
    if (!r || !cm || !app.me?.privacy.readReceipts) return new Map<string, string[]>();
    const mine = cm.list.filter((m) => m.author?.id === app.me!.id && !m.pending);
    const out = new Map<string, string[]>();
    for (const [userId, upTo] of r) {
      const last = [...mine].reverse().find((m) => compareIds(m.id, upTo) <= 0);
      if (last) out.set(last.id, [...(out.get(last.id) ?? []), userId]);
    }
    return out;
  });

  const isDm = $derived(isDmType(channel.type));
  const other = $derived(channel.type === ChannelType.DM ? (channel.recipients ?? []).find((r) => r.id !== app.me?.id) : null);
</script>

<div class="wrap">
  {#if highlights && highlightsOpen}
    <div class="away fade-in">
      <div class="away-head">
        <Icon name="star" size={16} />
        <strong>While you were away</strong>
        <span class="faint">{highlights.unread} new messages · most reacted</span>
        <span class="spacer"></span>
        <button class="icon-btn" aria-label="Dismiss" onclick={() => (highlightsOpen = false)}><Icon name="x" size={16} /></button>
      </div>
      {#each highlights.messages as h (h.id)}
        <button class="away-item" onclick={() => jumpTo(h.id)}>
          <Avatar src={h.author ? app.avatarOf(h.author.id, channel.guildId) : null} name={h.author ? app.displayName(h.author.id, channel.guildId) : '?'} size={22} />
          <strong>{h.author ? app.displayName(h.author.id, channel.guildId) : 'Unknown'}</strong>
          <span class="truncate muted">{h.content || (h.attachments.length ? '📎 attachment' : '')}</span>
          <span class="reacts">{h.reactions.slice(0, 3).map((r) => (r.emoji.startsWith('c:') ? `:${r.name}:` : r.emoji)).join(' ')} {h.reactions.reduce((n, r) => n + r.count, 0)}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="scroller scroll" bind:this={scroller} onscroll={onScroll}>
    <div class="content" bind:this={content}>
      {#if cm && !cm.hasMoreBefore}
        <div class="welcome">
          {#if isDm}
            {#if other}
              <Avatar src={app.avatarOf(other.id)} name={app.displayName(other.id)} size={72} />
              <h2>{app.displayName(other.id)}</h2>
              <p class="muted">This is the beginning of your direct messages with <strong>@{other.username}</strong>.</p>
            {:else}
              <h2>{channelTitle(channel)}</h2>
              <p class="muted">The beginning of this group.</p>
            {/if}
          {:else if channel.type === ChannelType.THREAD}
            <div class="bigicon"><Icon name="thread" size={34} /></div>
            <h2>{channel.name}</h2>
          {:else}
            <div class="bigicon"><Icon name="hash" size={38} /></div>
            <h2>Welcome to #{channel.name}!</h2>
            <p class="muted">This is the start of the #{channel.name} channel.</p>
            {#if channel.topic}<div class="muted"><Markdown content={channel.topic} guildId={channel.guildId} /></div>{/if}
          {/if}
        </div>
      {:else if cm?.loading}
        <div class="loading faint">Loading…</div>
      {/if}

      {#if cm}
        {#each cm.list as m, i (m.id)}
          {#if newDay(cm.list, i)}
            <div class="day"><span>{dayLabel(m.createdAt)}</span></div>
          {/if}
          {#if m.id === firstUnreadId}
            <div class="newline"><span>New</span></div>
          {/if}
          <MessageItem message={m} {channel} grouped={grouped(cm.list, i) && m.id !== firstUnreadId} flash={flashId === m.id} {onReply} onJump={jumpTo} readBy={receiptFor.get(m.id)} />
        {/each}
      {/if}
      <div class="bottom-pad"></div>
    </div>
  </div>

  {#if !atBottom && (cm?.hasMoreAfter || (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 1200))}
    <button class="present" onclick={jumpToPresent}>Jump to present <Icon name="arrow-down" size={14} /></button>
  {/if}
  <TypingBar channelId={channel.id} guildId={channel.guildId} />
</div>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && !embedded && !ui.profile && document.activeElement?.tagName !== 'INPUT') app.ack(channel.id);
  }}
/>

<style>
  .wrap {
    flex: 1;
    min-height: 0;
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-anchor: none;
  }
  .content {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    min-height: 100%;
    padding-top: 16px;
  }
  .bottom-pad {
    height: 18px;
    flex: none;
  }
  .welcome {
    padding: 16px 16px 8px;
  }
  .welcome h2 {
    margin: 8px 0 4px;
    font-size: 1.6rem;
  }
  .bigicon {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: var(--bg-3);
    display: grid;
    place-items: center;
  }
  .loading {
    padding: 20px;
    text-align: center;
  }
  .day,
  .newline {
    display: flex;
    align-items: center;
    margin: 12px 16px 4px;
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-faint);
  }
  .day::before,
  .day::after,
  .newline::before {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .day span {
    padding: 0 8px;
  }
  .newline {
    color: var(--danger);
    margin: 6px 16px 0;
  }
  .newline::before {
    background: var(--danger);
  }
  .newline span {
    background: var(--danger);
    color: #fff;
    border-radius: 4px;
    padding: 0 5px;
    font-size: 0.68rem;
  }
  .present {
    position: absolute;
    right: 18px;
    bottom: 36px;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: 99px;
    padding: 7px 14px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: var(--shadow);
    z-index: 5;
  }
  .away {
    margin: 8px 16px 0;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px;
    flex: none;
  }
  .away-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 6px;
    color: var(--warning);
  }
  .away-head .faint {
    font-size: 0.82rem;
  }
  .away-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 6px;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
    font-size: 0.9rem;
  }
  .away-item:hover {
    background: var(--hover);
  }
  .away-item .truncate {
    flex: 1;
  }
  .reacts {
    font-size: 0.85rem;
    color: var(--text-muted);
    white-space: nowrap;
  }
</style>
