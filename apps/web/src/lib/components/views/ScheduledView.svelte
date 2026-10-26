<script lang="ts">
  import { MessageFlags, type ScheduledMessage } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, patch } from '$lib/api';
  import { channelTitle } from '$lib/util/channel';
  import { fullDate, timeUntil } from '$lib/util/time';
  import Icon from '../Icon.svelte';
  import Markdown from '../Markdown.svelte';

  let editing = $state<string | null>(null);
  let content = $state('');
  let when = $state('');

  function toLocalInput(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function startEdit(s: ScheduledMessage) {
    editing = s.id;
    content = s.content;
    when = toLocalInput(s.sendAt);
  }

  async function save(s: ScheduledMessage) {
    try {
      await patch(`/scheduled-messages/${s.id}`, { content, sendAt: new Date(when).toISOString() });
      editing = null;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<header class="hdr">
  <button class="icon-btn burger" aria-label="Menu" onclick={() => { ui.mobileNav = true; }}><Icon name="menu" /></button>
  <Icon name="clock" /> <strong>Scheduled messages</strong>
</header>
<div class="list scroll">
  <p class="muted">Messages you’ve set to send later. They go out as you, and are re-checked against your permissions when they fire.</p>
  {#each app.scheduled as s (s.id)}
    {@const c = app.channel(s.channelId)}
    <div class="card item" class:err={!!s.error}>
      <div class="row">
        <strong>{c ? (c.guildId ? `#${c.name}` : channelTitle(c)) : 'Unknown channel'}</strong>
        {#if c?.guildId}<span class="faint">· {app.guilds.get(c.guildId)?.guild.name}</span>{/if}
        <span class="spacer"></span>
        <span class="pill" title={fullDate(s.sendAt)}><Icon name="clock" size={12} /> in {timeUntil(s.sendAt)}</span>
        {#if s.flags & MessageFlags.SILENT}<span class="pill"><Icon name="bell-off" size={12} /> silent</span>{/if}
      </div>
      {#if s.error}<p class="error-text">Couldn’t send: {s.error}. Edit the time to try again.</p>{/if}
      {#if editing === s.id}
        <textarea class="textarea" bind:value={content} rows="3"></textarea>
        <div class="row" style="margin-top:8px">
          <input class="input" type="datetime-local" bind:value={when} style="max-width:240px" />
          <span class="spacer"></span>
          <button class="btn small ghost" onclick={() => (editing = null)}>Cancel</button>
          <button class="btn small primary" onclick={() => save(s)}>Save</button>
        </div>
      {:else}
        <div class="content"><Markdown content={s.content || '*(attachments only)*'} guildId={c?.guildId ?? null} /></div>
        {#if s.attachments.length}<div class="faint small">📎 {s.attachments.map((a) => a.filename).join(', ')}</div>{/if}
        <div class="row" style="margin-top:8px">
          <span class="faint small">Sends {fullDate(s.sendAt)}</span>
          <span class="spacer"></span>
          <button class="btn small" onclick={() => startEdit(s)}><Icon name="edit" size={14} /> Edit</button>
          <button class="btn small danger" onclick={() => del(`/scheduled-messages/${s.id}`).catch((e) => app.toast(errorMessage(e), 'error'))}>
            <Icon name="trash" size={14} /> Cancel
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <p class="faint empty">Nothing scheduled. In any chat, use the 🕒 button next to the message box to send later.</p>
  {/each}
</div>

<style>
  .hdr {
    height: 48px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-bottom: 1px solid var(--bg-0);
  }
  .burger {
    display: none;
  }
  .list {
    flex: 1;
    padding: 16px 20px;
    max-width: 820px;
  }
  .item {
    margin-bottom: 12px;
  }
  .item.err {
    border-color: var(--danger);
  }
  .content {
    margin-top: 8px;
  }
  .small {
    font-size: 0.8rem;
  }
  .empty {
    text-align: center;
    padding: 40px;
  }
  @media (max-width: 760px) {
    .burger {
      display: inline-grid;
    }
  }
</style>
