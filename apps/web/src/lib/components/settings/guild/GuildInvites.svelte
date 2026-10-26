<script lang="ts">
  import type { Invite } from '@haunt/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { del, errorMessage, get } from '$lib/api';
  import { timeUntil } from '$lib/util/time';
  import { copy } from '$lib/util/channel';
  import Avatar from '../../Avatar.svelte';
  import Icon from '../../Icon.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);
  let invites = $state<Invite[] | null>(null);
  let error = $state('');

  async function load() {
    try {
      invites = await get<Invite[]>(`/guilds/${gid}/invites`);
    } catch (e) {
      error = errorMessage(e);
    }
  }
  void load();

  async function revoke(code: string) {
    try {
      await del(`/invites/${code}`);
      invites = invites?.filter((i) => i.code !== code) ?? null;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  const link = (code: string) => `${location.origin}/invite/${code}`;
</script>

<h2>Invites</h2>
<p class="muted">Every active invite link. Revoking one stops it working immediately; people who already joined stay.</p>
{#if error}<p class="error-text">{error}</p>{/if}
{#if invites === null && !error}
  <p class="faint">Loading…</p>
{:else if invites}
  <table class="tbl">
    <thead><tr><th>Inviter</th><th>Code</th><th>Uses</th><th>Expires</th><th></th></tr></thead>
    <tbody>
      {#each invites as i (i.code)}
        <tr>
          <td>
            <span class="row" style="gap:6px">
              {#if i.inviter}<Avatar src={i.inviter.avatar} name={i.inviter.displayName ?? i.inviter.username} size={20} />{app.displayName(i.inviter.id, gid)}{:else}<span class="faint">Deleted user</span>{/if}
            </span>
          </td>
          <td><code>{i.code}</code></td>
          <td>{i.uses}{i.maxUses ? ` / ${i.maxUses}` : ''}</td>
          <td>{i.expiresAt ? timeUntil(i.expiresAt) : 'Never'}</td>
          <td class="acts">
            <button class="icon-btn" title="Copy link" onclick={() => copy(link(i.code))}><Icon name="copy" size={15} /></button>
            <button class="icon-btn" title="Revoke" onclick={() => revoke(i.code)}><Icon name="x" size={15} /></button>
          </td>
        </tr>
      {:else}
        <tr><td colspan="5" class="faint">No active invites. Make one from any channel's invite button.</td></tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .tbl {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
  }
  th {
    text-align: left;
    font-size: 0.72rem;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 6px 8px;
  }
  td {
    padding: 8px;
    border-top: 1px solid var(--border);
  }
  .acts {
    text-align: right;
    white-space: nowrap;
  }
</style>
