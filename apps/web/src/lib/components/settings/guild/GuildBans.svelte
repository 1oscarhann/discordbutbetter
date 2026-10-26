<script lang="ts">
  import type { Ban } from '@dbb/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { del, errorMessage, get } from '$lib/api';
  import { fullDate } from '$lib/util/time';
  import Avatar from '../../Avatar.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);
  let bans = $state<Ban[] | null>(null);
  let error = $state('');
  let q = $state('');

  get<Ban[]>(`/guilds/${gid}/bans`)
    .then((b) => (bans = b))
    .catch((e) => (error = errorMessage(e)));

  const shown = $derived((bans ?? []).filter((b) => !q.trim() || b.user.username.includes(q.trim().toLowerCase()) || b.user.id === q.trim()));

  async function unban(userId: string) {
    try {
      await del(`/guilds/${gid}/bans/${userId}`);
      bans = bans?.filter((b) => b.user.id !== userId) ?? null;
      app.toast('Unbanned', 'success');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<h2>Bans</h2>
<p class="muted">Banned people can't rejoin, even with an invite.</p>
{#if error}<p class="error-text">{error}</p>{/if}
{#if bans === null && !error}
  <p class="faint">Loading…</p>
{:else if bans}
  {#if bans.length > 8}<input class="input" placeholder="Search bans" bind:value={q} style="margin-bottom:10px" />{/if}
  {#each shown as b (b.user.id)}
    <div class="list-item">
      <Avatar src={b.user.avatar} name={b.user.displayName ?? b.user.username} size={32} />
      <span class="col" style="gap:0;flex:1;min-width:0">
        <strong class="truncate">{b.user.displayName ?? b.user.username} <span class="faint">@{b.user.username}</span></strong>
        <span class="faint small truncate">{fullDate(b.createdAt)}{b.reason ? ` · ${b.reason}` : ''}</span>
      </span>
      <button class="btn small" onclick={() => unban(b.user.id)}>Unban</button>
    </div>
  {:else}
    <p class="faint">Nobody's banned. Peaceful.</p>
  {/each}
{/if}
