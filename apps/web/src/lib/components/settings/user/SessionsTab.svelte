<script lang="ts">
  import type { Session } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, get } from '$lib/api';
  import { fullDate, timeAgo } from '$lib/util/time';
  import Icon from '../../Icon.svelte';

  let sessions = $state<Session[] | null>(null);
  let error = $state('');
  async function load() {
    try {
      sessions = await get<Session[]>('/users/@me/sessions');
    } catch (e) {
      error = errorMessage(e);
    }
  }
  void load();

  async function revoke(s: Session) {
    try {
      await del(`/users/@me/sessions/${s.id}`);
      if (s.current) app.loggedOut();
      else sessions = sessions?.filter((x) => x.id !== s.id) ?? null;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<h2>Devices</h2>
<p class="muted">Everywhere you're logged in. We store a short description of the browser and when it was last used — no IP addresses, no locations.</p>
{#if error}<p class="error-text">{error}</p>{/if}
{#if sessions}
  {#each sessions as s (s.id)}
    <div class="list-item">
      <Icon name="globe" size={20} />
      <span class="col" style="gap:0;flex:1;min-width:0">
        <strong class="truncate">{s.client || 'Unknown browser'} {#if s.current}<span class="pill">This device</span>{/if}</strong>
        <span class="faint small">Logged in {fullDate(s.createdAt)} · active {timeAgo(s.lastUsedAt)}</span>
      </span>
      <button class="btn small" onclick={() => revoke(s)}>{s.current ? 'Log out' : 'Revoke'}</button>
    </div>
  {/each}
  {#if sessions.length > 1}
    <button
      class="btn danger"
      style="margin-top:12px"
      onclick={() =>
        ui.confirm('Log out everywhere else?', 'Every other device gets logged out right away.', 'Log them out', async () => {
          await del('/users/@me/sessions');
          await load();
        })}>Log out all other devices</button
    >
  {/if}
{:else if !error}
  <p class="faint">Loading…</p>
{/if}
