<script lang="ts">
  import { ChannelType, Permissions as P, type LevelEntry, type LevelRole, type LevelSettings } from '@dbb/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { errorMessage, get, patch, put } from '$lib/api';
  import Avatar from '../../Avatar.svelte';
  import Icon from '../../Icon.svelte';

  let { g, manage }: { g: GuildState; manage: boolean } = $props();
  const gid = $derived(g.guild.id);
  const settings = $derived(g.guild.levels);
  const canRoles = $derived(app.can(P.MANAGE_ROLES, gid));

  interface LevelsResponse {
    settings: LevelSettings;
    roles: LevelRole[];
    leaderboard: LevelEntry[];
    me: { xp: number; level: number; current: number; needed: number; messages: number; rank: number } | null;
  }
  let data = $state<LevelsResponse | null>(null);
  let error = $state('');
  let offset = $state(0);
  let more = $state(false);

  async function load(reset = true) {
    try {
      const o = reset ? 0 : offset;
      const res = await get<LevelsResponse>(`/guilds/${gid}/levels?offset=${o}`);
      data = reset || !data ? res : { ...res, leaderboard: [...data.leaderboard, ...res.leaderboard] };
      offset = o + res.leaderboard.length;
      more = res.leaderboard.length === 50;
      if (reset) roleDraft = res.roles.map((r) => ({ ...r }));
    } catch (e) {
      error = errorMessage(e);
    }
  }
  void load();

  async function setSetting(body: Partial<LevelSettings>) {
    try {
      await patch(`/guilds/${gid}/levels/settings`, body);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  let roleDraft = $state<LevelRole[]>([]);
  let newLevel = $state(5);
  let newRole = $state('');
  async function saveRoles(next: LevelRole[]) {
    try {
      const saved = await put<LevelRole[]>(`/guilds/${gid}/levels/roles`, next);
      roleDraft = saved.sort((a, b) => a.level - b.level);
      newRole = '';
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  const textChannels = $derived([...g.channels.values()].filter((c) => c.type === ChannelType.TEXT).sort((a, b) => a.position - b.position));
  const medal = (rank: number) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`);
</script>

{#if manage}
  <h2>Levels</h2>
  <p class="muted">Members earn XP for chatting (once a minute at most, so spamming doesn't help). Turn it off if your server isn't into that.</p>
  <label class="srow">
    <span class="txt"><strong>Enable levels</strong><small>Track XP and show the leaderboard</small></span>
    <input type="checkbox" class="switch" checked={settings.enabled} onchange={(e) => setSetting({ enabled: (e.target as HTMLInputElement).checked })} />
  </label>
  {#if settings.enabled}
    <label class="srow">
      <span class="txt"><strong>Announce level-ups</strong><small>Post a message when someone levels up</small></span>
      <input type="checkbox" class="switch" checked={settings.announce} onchange={(e) => setSetting({ announce: (e.target as HTMLInputElement).checked })} />
    </label>
    {#if settings.announce}
      <div class="field" style="margin-top:10px">
        <label for="ac">Announce in</label>
        <select id="ac" class="select" value={settings.announceChannelId ?? ''} onchange={(e) => setSetting({ announceChannelId: (e.target as HTMLSelectElement).value || null })}>
          <option value="">The channel they leveled up in</option>
          {#each textChannels as c (c.id)}<option value={c.id}>#{c.name}</option>{/each}
        </select>
      </div>
    {/if}

    <h3>Level rewards</h3>
    {#if canRoles}
      <p class="faint small">Hand out a role automatically when someone reaches a level.</p>
      {#each roleDraft as r, i (r.level + ':' + r.roleId)}
        <div class="list-item">
          <span class="lvl">Lv {r.level}</span>
          <span class="truncate" style="flex:1">{g.roles.get(r.roleId)?.name ?? 'deleted role'}</span>
          <button class="icon-btn" title="Remove" onclick={() => saveRoles(roleDraft.filter((_, j) => j !== i))}><Icon name="x" size={15} /></button>
        </div>
      {/each}
      <div class="row" style="gap:8px;margin-top:6px">
        <input class="input" type="number" min="1" max="500" bind:value={newLevel} style="width:90px" aria-label="Level" />
        <select class="select" bind:value={newRole} style="flex:1">
          <option value="" disabled>Role to give</option>
          {#each g.sortedRoles.filter((r) => r.id !== gid) as r (r.id)}<option value={r.id}>{r.name}</option>{/each}
        </select>
        <button class="btn primary" disabled={!newRole || newLevel < 1} onclick={() => saveRoles([...roleDraft, { level: newLevel, roleId: newRole }])}>Add</button>
      </div>
    {:else}
      <p class="faint small">You need Manage Roles to set level rewards.</p>
    {/if}
  {/if}
  <h3>Leaderboard</h3>
{:else}
  <h2>Leaderboard</h2>
{/if}

{#if error}<p class="error-text">{error}</p>{/if}
{#if data}
  {#if data.me}
    <div class="me card">
      <span class="big">{medal(data.me.rank)}</span>
      <span class="col" style="gap:4px;flex:1">
        <strong>You're level {data.me.level}</strong>
        <div class="bar"><div style="width:{Math.min(100, (data.me.current / Math.max(1, data.me.needed)) * 100)}%"></div></div>
        <span class="faint small">{data.me.current} / {data.me.needed} XP to level {data.me.level + 1} · {data.me.messages} messages</span>
      </span>
    </div>
  {/if}
  {#each data.leaderboard as e (e.user.id)}
    <div class="list-item">
      <span class="rank">{medal(e.rank)}</span>
      <Avatar src={app.avatarOf(e.user.id, gid) ?? e.user.avatar} name={app.displayName(e.user.id, gid)} size={30} />
      <span class="truncate" style="flex:1">{app.displayName(e.user.id, gid)}</span>
      <span class="faint small">{e.messages} msgs</span>
      <span class="lvl">Lv {e.level}</span>
    </div>
  {:else}
    <p class="faint">No XP yet — go talk to each other.</p>
  {/each}
  {#if more}<button class="btn ghost block" onclick={() => load(false)}>Show more</button>{/if}
{/if}

<style>
  .lvl {
    font-weight: 700;
    font-size: 0.8rem;
    padding: 2px 8px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-text, #fff);
    white-space: nowrap;
  }
  .rank {
    width: 34px;
    text-align: center;
    font-weight: 700;
  }
  .me {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 12px;
  }
  .big {
    font-size: 1.6rem;
    font-weight: 800;
  }
  .bar {
    height: 8px;
    border-radius: 99px;
    background: var(--bg-0);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    background: var(--accent);
  }
</style>
