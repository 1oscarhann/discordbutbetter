<script lang="ts">
  import { Permissions as P } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { errorMessage, patch } from '$lib/api';
  import SettingsShell from './SettingsShell.svelte';
  import GuildOverview from './guild/GuildOverview.svelte';
  import GuildRoles from './guild/GuildRoles.svelte';
  import GuildEmojis from './guild/GuildEmojis.svelte';
  import GuildInvites from './guild/GuildInvites.svelte';
  import GuildMembers from './guild/GuildMembers.svelte';
  import GuildBans from './guild/GuildBans.svelte';
  import GuildAudit from './guild/GuildAudit.svelte';
  import GuildAutomod from './guild/GuildAutomod.svelte';
  import GuildLevels from './guild/GuildLevels.svelte';

  let { guildId, initialTab }: { guildId: string; initialTab: string } = $props();
  const g = $derived(app.guilds.get(guildId));
  let tab = $state(initialTab);

  const can = (flag: bigint) => app.can(flag, guildId);

  const sections = $derived.by(() => {
    const server: { id: string; label: string }[] = [];
    if (can(P.MANAGE_GUILD)) server.push({ id: 'overview', label: 'Overview' });
    if (can(P.MANAGE_ROLES)) server.push({ id: 'roles', label: 'Roles' });
    if (can(P.MANAGE_EMOJIS)) server.push({ id: 'emojis', label: 'Emoji & stickers' });
    if (can(P.MANAGE_GUILD)) server.push({ id: 'levels', label: 'Levels' });
    const mod: { id: string; label: string }[] = [];
    if (can(P.KICK_MEMBERS) || can(P.BAN_MEMBERS) || can(P.MODERATE_MEMBERS) || can(P.MANAGE_ROLES) || can(P.MANAGE_NICKNAMES)) mod.push({ id: 'members', label: 'Members' });
    if (can(P.MANAGE_GUILD)) mod.push({ id: 'invites', label: 'Invites' });
    if (can(P.BAN_MEMBERS)) mod.push({ id: 'bans', label: 'Bans' });
    if (can(P.MANAGE_GUILD)) mod.push({ id: 'automod', label: 'AutoMod' });
    if (can(P.VIEW_AUDIT_LOG)) mod.push({ id: 'audit', label: 'Audit log' });
    const you = [
      { id: 'notifications', label: 'Notifications' },
      ...(g?.guild.levels.enabled ? [{ id: 'leaderboard', label: 'Leaderboard' }] : []),
    ];
    return [
      ...(server.length ? [{ title: g?.guild.name ?? 'Server', items: server }] : []),
      ...(mod.length ? [{ title: 'Moderation', items: mod }] : []),
      { title: 'You', items: you },
    ];
  });

  // if you lose access to the tab you're on (role changed while open), fall back to something you can see
  $effect(() => {
    const all = sections.flatMap((s) => s.items.map((i) => i.id));
    if (!all.includes(tab)) tab = all[0] ?? 'notifications';
  });
  // guild deleted / left while open
  $effect(() => {
    if (!g) ui.guildSettings = null;
  });

  const gn = $derived(app.guildNotif.get(guildId));
  async function setNotif(body: Record<string, unknown>) {
    try {
      await patch(`/users/@me/guilds/${guildId}/notifications`, body);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  const mutedUntil = $derived(gn?.mutedUntil ? new Date(gn.mutedUntil) : null);
  const muted = $derived(!!mutedUntil && mutedUntil.getTime() > Date.now());
</script>

{#if g}
  <SettingsShell {sections} bind:tab onclose={() => { ui.guildSettings = null; }}>
    {#key tab}
      {#if tab === 'overview'}
        <GuildOverview {g} />
      {:else if tab === 'roles'}
        <GuildRoles {g} />
      {:else if tab === 'emojis'}
        <GuildEmojis {g} />
      {:else if tab === 'levels'}
        <GuildLevels {g} manage />
      {:else if tab === 'leaderboard'}
        <GuildLevels {g} manage={false} />
      {:else if tab === 'members'}
        <GuildMembers {g} />
      {:else if tab === 'invites'}
        <GuildInvites {g} />
      {:else if tab === 'bans'}
        <GuildBans {g} />
      {:else if tab === 'automod'}
        <GuildAutomod {g} />
      {:else if tab === 'audit'}
        <GuildAudit {g} />
      {:else if tab === 'notifications'}
        <h2>Notifications</h2>
        <p class="muted">How {g.guild.name} is allowed to bother you. Channels can override this.</p>
        <div class="field">
          <span class="label">Notify me about</span>
          {#each [[0, 'All messages'], [1, 'Only @mentions'], [2, 'Nothing']] as const as [v, l] (v)}
            <label class="radio"><input type="radio" name="glvl" checked={(gn?.level ?? 1) === v} onchange={() => setNotif({ level: v })} /> {l}</label>
          {/each}
        </div>
        <label class="srow">
          <span class="txt"><strong>Suppress @everyone and @here</strong><small>Don't ping me when someone pings everyone</small></span>
          <input type="checkbox" class="switch" checked={gn?.suppressEveryone ?? false} onchange={(e) => setNotif({ suppressEveryone: (e.target as HTMLInputElement).checked })} />
        </label>
        <label class="srow">
          <span class="txt"><strong>Suppress role mentions</strong><small>Only ping me when I'm mentioned by name</small></span>
          <input type="checkbox" class="switch" checked={gn?.suppressRoles ?? false} onchange={(e) => setNotif({ suppressRoles: (e.target as HTMLInputElement).checked })} />
        </label>
        <div class="field" style="margin-top:16px">
          <label for="gmute">Mute the whole server</label>
          <select id="gmute" class="select" value="" onchange={(e) => { const v = (e.target as HTMLSelectElement).value; (e.target as HTMLSelectElement).value = ''; if (v) setNotif({ muteSeconds: v === 'off' ? null : Number(v) }); }}>
            <option value="" disabled>{muted ? `Muted until ${mutedUntil!.getFullYear() > 9000 ? 'you unmute' : mutedUntil!.toLocaleString()}` : 'Not muted'}</option>
            <option value="900">For 15 minutes</option>
            <option value="3600">For 1 hour</option>
            <option value="28800">For 8 hours</option>
            <option value="86400">For 24 hours</option>
            <option value="-1">Until I turn it back on</option>
            <option value="off">Unmute</option>
          </select>
          <span class="hint">Muted servers don't show unread dots. Direct @mentions still show a badge.</span>
        </div>
      {/if}
    {/key}
  </SettingsShell>
{/if}
