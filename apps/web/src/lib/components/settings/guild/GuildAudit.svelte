<script lang="ts">
  import { AuditAction, type AuditLogEntry, type PublicUser } from '@dbb/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { errorMessage, get } from '$lib/api';
  import { timeAgo, fullDate } from '$lib/util/time';
  import Avatar from '../../Avatar.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);

  let entries = $state<AuditLogEntry[]>([]);
  const users = new Map<string, PublicUser>();
  let loading = $state(false);
  let done = $state(false);
  let error = $state('');
  let action = $state('');
  let actorId = $state('');
  let expanded = $state<string | null>(null);

  async function load(reset = false) {
    if (loading) return;
    loading = true;
    error = '';
    try {
      const qs = new URLSearchParams();
      if (!reset && entries.length) qs.set('before', entries[entries.length - 1]!.id);
      if (action) qs.set('action', action);
      if (actorId) qs.set('actorId', actorId);
      const res = await get<{ entries: AuditLogEntry[]; users: PublicUser[] }>(`/guilds/${gid}/audit-log?${qs}`);
      for (const u of res.users) users.set(u.id, u);
      entries = reset ? res.entries : [...entries, ...res.entries];
      done = res.entries.length < 50;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }
  void load(true);

  const LABELS: Record<string, string> = {
    guild_update: 'updated the server',
    channel_create: 'created a channel',
    channel_update: 'updated a channel',
    channel_delete: 'deleted a channel',
    overwrite_update: 'changed channel permissions',
    overwrite_delete: 'removed channel permissions',
    role_create: 'created a role',
    role_update: 'updated a role',
    role_delete: 'deleted a role',
    member_role_update: 'changed roles for',
    member_update: 'updated',
    member_kick: 'kicked',
    member_ban: 'banned',
    member_unban: 'unbanned',
    member_timeout: 'changed the timeout of',
    member_voice_update: 'server-muted/deafened',
    member_voice_move: 'moved',
    member_voice_disconnect: 'disconnected',
    message_delete: 'deleted a message by',
    message_bulk_delete: 'bulk-deleted messages',
    message_pin: 'pinned a message',
    message_unpin: 'unpinned a message',
    invite_create: 'created an invite',
    invite_delete: 'deleted an invite',
    emoji_create: 'added an emoji',
    emoji_update: 'renamed an emoji',
    emoji_delete: 'deleted an emoji',
    sticker_create: 'added a sticker',
    sticker_delete: 'deleted a sticker',
    thread_update: 'updated a thread',
    thread_delete: 'deleted a thread',
    automod_rule_create: 'created an AutoMod rule',
    automod_rule_update: 'updated an AutoMod rule',
    automod_rule_delete: 'deleted an AutoMod rule',
    automod_block: 'AutoMod blocked a message from',
    automod_timeout: 'AutoMod timed out',
    wiki_page_create: 'created a wiki page',
    wiki_page_update: 'edited a wiki page',
    wiki_page_delete: 'deleted a wiki page',
    level_settings_update: 'changed level settings',
  };

  function targetLabel(e: AuditLogEntry): string {
    if (!e.targetId) return '';
    switch (e.targetType) {
      case 'user': {
        const u = users.get(e.targetId) ?? app.user(e.targetId);
        return u ? (u.displayName ?? u.username) : 'a deleted user';
      }
      case 'channel': {
        const c = g.channels.get(e.targetId) ?? g.threads.get(e.targetId);
        return c ? `#${c.name}` : String((e.changes as { name?: string } | null)?.name ?? 'a deleted channel');
      }
      case 'role':
        return g.roles.get(e.targetId)?.name ?? String((e.changes as { name?: string } | null)?.name ?? 'a deleted role');
      default:
        return '';
    }
  }

  function summary(v: unknown): string {
    const s = JSON.stringify(v, null, 2) ?? '';
    return s.length > 2000 ? s.slice(0, 2000) + '…' : s;
  }

  const actors = $derived([...new Map(entries.filter((e) => e.actor).map((e) => [e.actor!.id, e.actor!])).values()]);
</script>

<h2>Audit log</h2>
<p class="muted">Every moderation and admin action in this server. Entries older than 180 days are deleted automatically.</p>
<div class="row" style="gap:8px;margin:10px 0">
  <select class="select" bind:value={action} onchange={() => load(true)}>
    <option value="">All actions</option>
    {#each Object.values(AuditAction) as a (a)}<option value={a}>{LABELS[a] ?? a}</option>{/each}
  </select>
  <select class="select" bind:value={actorId} onchange={() => load(true)}>
    <option value="">Anyone</option>
    {#each actors as u (u.id)}<option value={u.id}>{u.displayName ?? u.username}</option>{/each}
  </select>
</div>
{#if error}<p class="error-text">{error}</p>{/if}

{#each entries as e (e.id)}
  {@const isAuto = e.action.startsWith('automod_') && !e.action.startsWith('automod_rule')}
  <div class="entry">
    <button class="line" onclick={() => (expanded = expanded === e.id ? null : e.id)}>
      {#if e.actor && !isAuto}
        <Avatar src={e.actor.avatar} name={e.actor.displayName ?? e.actor.username} size={28} />
      {:else}
        <span class="bot">{isAuto ? '🛡️' : '?'}</span>
      {/if}
      <span class="txt">
        {#if !isAuto}<strong>{e.actor ? (e.actor.displayName ?? e.actor.username) : 'Deleted user'}</strong>{/if}
        {LABELS[e.action] ?? e.action}
        {#if targetLabel(e)}<strong>{targetLabel(e)}</strong>{/if}
        {#if e.reason}<span class="faint"> — “{e.reason}”</span>{/if}
      </span>
      <span class="faint small when" title={fullDate(e.createdAt)}>{timeAgo(e.createdAt)}</span>
    </button>
    {#if expanded === e.id && e.changes}
      <pre class="changes">{summary(e.changes)}</pre>
    {/if}
  </div>
{:else}
  {#if !loading}<p class="faint">Nothing logged yet.</p>{/if}
{/each}
{#if loading}<p class="faint">Loading…</p>{/if}
{#if !done && !loading && entries.length}<button class="btn ghost block" onclick={() => load()}>Load older</button>{/if}

<style>
  .entry {
    border-radius: 8px;
    background: var(--bg-1);
    margin-bottom: 6px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .when {
    white-space: nowrap;
  }
  .bot {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--bg-3);
    flex: none;
  }
  .changes {
    margin: 0;
    padding: 8px 12px 12px 48px;
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-muted);
  }
</style>
