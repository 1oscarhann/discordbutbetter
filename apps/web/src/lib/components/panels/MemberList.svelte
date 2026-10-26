<script lang="ts">
  import { Permissions as P, computePermissions, has, type GuildMember, type Role } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';

  let { guildId, channelId }: { guildId: string; channelId: string } = $props();
  const g = $derived(app.guilds.get(guildId));

  /** Only show people who can see this channel (like Discord). */
  const visible = $derived.by(() => {
    if (!g) return [] as GuildMember[];
    let ch = g.channels.get(channelId) ?? g.threads.get(channelId) ?? null;
    if (ch?.parentId && g.threads.has(channelId)) ch = g.channels.get(ch.parentId) ?? null;
    const ow = ch?.overwrites.map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
    const everyone = BigInt(g.roles.get(guildId)?.permissions ?? '0');
    return [...g.members.values()].filter((m) =>
      has(
        computePermissions({
          userId: m.user.id,
          guildId,
          ownerId: g.guild.ownerId,
          everyone,
          memberRoles: m.roles.map((r) => g.roles.get(r)).filter((r): r is Role => !!r).map((r) => ({ id: r.id, permissions: BigInt(r.permissions) })),
          overwrites: ow,
        }),
        P.VIEW_CHANNEL,
      ),
    );
  });

  const groups = $derived.by(() => {
    if (!g) return [];
    const hoisted = g.sortedRoles.filter((r) => r.hoist && r.id !== guildId);
    const buckets = new Map<string, GuildMember[]>();
    const online: GuildMember[] = [];
    const offline: GuildMember[] = [];
    for (const m of visible) {
      const st = app.presence(m.user.id).status;
      if (st === 'offline') {
        offline.push(m);
        continue;
      }
      const top = hoisted.find((r) => m.roles.includes(r.id));
      if (top) buckets.set(top.id, [...(buckets.get(top.id) ?? []), m]);
      else online.push(m);
    }
    const byName = (a: GuildMember, b: GuildMember) => app.displayName(a.user.id, guildId).localeCompare(app.displayName(b.user.id, guildId));
    const out: { title: string; members: GuildMember[]; offline?: boolean }[] = [];
    for (const r of hoisted) {
      const list = buckets.get(r.id);
      if (list?.length) out.push({ title: r.name, members: list.sort(byName) });
    }
    if (online.length) out.push({ title: 'Online', members: online.sort(byName) });
    if (offline.length) out.push({ title: 'Offline', members: offline.sort(byName).slice(0, 200), offline: true });
    return out;
  });

  function open(e: MouseEvent, userId: string) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.profile = { userId, guildId, x: r.left - 312, y: r.top };
  }
</script>

<div class="list scroll">
  {#each groups as grp (grp.title)}
    <div class="gt">{grp.title} — {grp.members.length}</div>
    {#each grp.members as m (m.user.id)}
      {@const p = app.presence(m.user.id)}
      <button class="mem" class:off={grp.offline} onclick={(e) => open(e, m.user.id)}>
        <Avatar src={app.avatarOf(m.user.id, guildId)} name={app.displayName(m.user.id, guildId)} size={32} status={p.status} />
        <span class="meta">
          <span class="name truncate" style:color={app.roleColor(guildId, m.user.id)}>
            {app.displayName(m.user.id, guildId)}
            {#if g?.guild.ownerId === m.user.id}<Icon name="crown" size={12} class="crown" />{/if}
          </span>
          {#if p.status !== 'offline' || p.playing}
            <span class="sub truncate">
              {#if p.playing}
                {#if p.playing.lfg}<span class="lfg">LFG</span>{/if} Playing <strong>{p.playing.name}</strong>
              {:else if p.listening}
                Listening to <strong>{p.listening.title}</strong>
              {:else if p.customStatus}
                {p.customStatus.emoji ?? ''} {p.customStatus.text}
              {/if}
            </span>
          {/if}
        </span>
      </button>
    {/each}
  {/each}
</div>

<style>
  .list {
    flex: 1;
    padding: 8px 8px 16px;
  }
  .gt {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 14px 8px 4px;
  }
  .mem {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 5px 8px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .mem:hover {
    background: var(--hover);
  }
  .mem.off {
    opacity: 0.45;
  }
  .mem.off:hover {
    opacity: 1;
  }
  .meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name {
    font-weight: 600;
    font-size: 0.92rem;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .name :global(.crown) {
    color: var(--warning);
  }
  .sub {
    font-size: 0.74rem;
    color: var(--text-muted);
  }
  .lfg {
    background: var(--success);
    color: #fff;
    font-weight: 800;
    font-size: 0.62rem;
    padding: 0 4px;
    border-radius: 4px;
    margin-right: 2px;
  }
</style>
