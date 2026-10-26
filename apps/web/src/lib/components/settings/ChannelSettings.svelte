<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    CHANNEL_PERMISSIONS,
    ChannelType,
    DISAPPEARING_OPTIONS,
    Permissions as P,
    RelationshipType,
    has,
    isDmType,
    type Channel,
    type Overwrite,
  } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, del, errorMessage, patch, post, put, type UploadedFile } from '$lib/api';
  import { channelTitle, disappearingLabel } from '$lib/util/channel';
  import Modal from '../Modal.svelte';
  import PermissionEditor from './PermissionEditor.svelte';
  import ImagePicker from '../ImagePicker.svelte';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';

  let { target }: { target: string } = $props();
  const channelId = $derived(target.replace(/^notif:/, ''));
  const c = $derived(app.channel(channelId));
  const isDm = $derived(c ? isDmType(c.type) : false);
  const g = $derived(c?.guildId ? app.guilds.get(c.guildId) : null);
  const canManage = $derived(!!c?.guildId && app.can(P.MANAGE_CHANNELS, c.guildId, c.id));
  const canPerms = $derived(!!c?.guildId && (app.can(P.MANAGE_ROLES, c.guildId, c.id) || app.can(P.ADMINISTRATOR, c.guildId)));
  let tab = $state(target.startsWith('notif:') ? 'notifications' : 'overview');

  // overview form
  let name = $state('');
  let topic = $state('');
  let slowmode = $state(0);
  let userLimit = $state(0);
  let icon = $state<UploadedFile | null | undefined>(undefined);
  let saving = $state(false);
  let error = $state('');
  $effect(() => {
    if (!c) return;
    name = c.name ?? '';
    topic = c.topic ?? '';
    slowmode = c.slowmode;
    userLimit = c.userLimit;
  });

  async function saveOverview() {
    if (!c) return;
    saving = true;
    error = '';
    try {
      if (isDm) {
        const body: Record<string, unknown> = {};
        if (c.type === ChannelType.GROUP_DM && name !== (c.name ?? '')) body.name = name;
        if (icon !== undefined) body.iconFileId = icon?.id ?? null;
        if (Object.keys(body).length) await patch(`/channels/${c.id}`, body);
      } else {
        await patch(`/channels/${c.id}`, {
          name,
          topic: topic || null,
          slowmode,
          ...(c.type === ChannelType.VOICE ? { userLimit } : {}),
        });
      }
      app.toast('Saved', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }

  // permissions
  let selected = $state<string | null>(null);
  let draft = $state<{ allow: bigint; deny: bigint } | null>(null);
  let addAnchor = $state(false);
  const overwrites = $derived(c?.overwrites ?? []);
  const sel = $derived(selected ? (overwrites.find((o) => o.id === selected) ?? null) : null);
  $effect(() => {
    void selected;
    draft = sel ? { allow: BigInt(sel.allow), deny: BigInt(sel.deny) } : selected ? { allow: 0n, deny: 0n } : null;
  });
  const myChannelPerms = $derived(c?.guildId ? app.perms(c.guildId, c.id) : 0n);
  const isOwner = $derived(g?.guild.ownerId === app.me?.id);

  function owLabel(o: { id: string; type: number }): string {
    if (o.type === 0) return o.id === c?.guildId ? '@everyone' : (g?.roles.get(o.id)?.name ?? 'deleted role');
    return app.displayName(o.id, c?.guildId);
  }

  async function saveOverwrite() {
    if (!c || !selected || !draft) return;
    const type = sel ? sel.type : g?.roles.has(selected) ? 0 : 1;
    try {
      await put(`/channels/${c.id}/permissions/${selected}`, { type, allow: draft.allow.toString(), deny: draft.deny.toString() });
      app.toast('Permissions saved', 'success');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function removeOverwrite(id: string) {
    if (!c) return;
    try {
      await del(`/channels/${c.id}/permissions/${id}`);
      if (selected === id) selected = null;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function sync() {
    if (!c) return;
    try {
      await post(`/channels/${c.id}/sync-permissions`);
      app.toast('Synced with category', 'success');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  const addable = $derived.by(() => {
    if (!g) return [];
    const taken = new Set(overwrites.map((o) => o.id));
    const roles = g.sortedRoles.filter((r) => !taken.has(r.id)).map((r) => ({ id: r.id, label: r.id === g.guild.id ? '@everyone' : r.name, kind: 'role' }));
    const members = [...g.members.values()].filter((m) => !taken.has(m.user.id)).slice(0, 200).map((m) => ({ id: m.user.id, label: app.displayName(m.user.id, g.guild.id), kind: 'member' }));
    return [...roles, ...members];
  });

  // notifications
  const cn = $derived(app.channelNotif.get(channelId));
  async function setNotif(body: Record<string, unknown>) {
    try {
      await patch(`/users/@me/channels/${channelId}/notifications`, body);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  // DM members
  const friends = $derived([...app.relationships.values()].filter((r) => r.type === RelationshipType.FRIEND && !(c?.recipients ?? []).some((x) => x.id === r.user.id)));
  let addMember = $state('');
</script>

{#if c}
  <Modal title={isDm ? channelTitle(c) : `#${c.name}`} onclose={() => (ui.channelSettings = null)} width={680}>
    <div class="tabs">
      <button class="tab" class:active={tab === 'overview'} onclick={() => (tab = 'overview')}>Overview</button>
      {#if !isDm && canPerms && c.type !== ChannelType.THREAD}<button class="tab" class:active={tab === 'permissions'} onclick={() => (tab = 'permissions')}>Permissions</button>{/if}
      {#if isDm && c.type === ChannelType.GROUP_DM}<button class="tab" class:active={tab === 'members'} onclick={() => (tab = 'members')}>Members</button>{/if}
      <button class="tab" class:active={tab === 'notifications'} onclick={() => (tab = 'notifications')}>Notifications</button>
    </div>

    {#if tab === 'overview'}
      {#if isDm}
        {#if c.type === ChannelType.GROUP_DM}
          <div class="field"><ImagePicker purpose="group_icon" current={c.icon ?? null} round label="Group icon" onchange={(f) => (icon = f)} /></div>
          <div class="field"><label for="gname">Group name</label><input id="gname" class="input" bind:value={name} maxlength="100" /></div>
          <button class="btn primary" disabled={saving} onclick={saveOverview}>Save</button>
        {/if}
        <div class="field" style="margin-top:18px">
          <label for="dis">Disappearing messages</label>
          <select id="dis" class="select" value={c.disappearingSeconds ?? 0} onchange={(e) => patch(`/channels/${c.id}`, { disappearingSeconds: Number((e.target as HTMLSelectElement).value) }).catch((err) => app.toast(errorMessage(err), 'error'))}>
            {#each DISAPPEARING_OPTIONS as s (s)}<option value={s}>{s ? `After ${disappearingLabel(s)}` : 'Off'}</option>{/each}
          </select>
          <span class="hint">New messages in this conversation delete themselves for everyone after the timer. Anyone in the conversation can change it, and everyone sees when it changes.</span>
        </div>
      {:else if canManage}
        <div class="field"><label for="cname">Channel name</label><input id="cname" class="input" bind:value={name} maxlength="100" /></div>
        {#if c.type !== ChannelType.CATEGORY}
          <div class="field"><label for="ctopic">Topic</label><textarea id="ctopic" class="textarea" bind:value={topic} maxlength="1024" rows="3"></textarea></div>
          <div class="field">
            <label for="slow">Slowmode</label>
            <select id="slow" class="select" bind:value={slowmode}>
              {#each [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 21600] as s (s)}<option value={s}>{s === 0 ? 'Off' : s < 60 ? `${s}s` : s < 3600 ? `${s / 60}m` : `${s / 3600}h`}</option>{/each}
            </select>
          </div>
        {/if}
        {#if c.type === ChannelType.VOICE}
          <div class="field"><label for="ulim">User limit (0 = none)</label><input id="ulim" class="input" type="number" min="0" max="99" bind:value={userLimit} /></div>
        {/if}
        {#if error}<p class="error-text">{error}</p>{/if}
        <div class="row">
          <button class="btn primary" disabled={saving} onclick={saveOverview}>Save changes</button>
          <span class="spacer"></span>
          <button
            class="btn danger"
            onclick={() => ui.confirm(`Delete ${c.name}?`, 'This can’t be undone. All messages in it are deleted.', 'Delete channel', async () => {
              await del(`/channels/${c.id}`);
              ui.channelSettings = null;
              if (c.guildId) goto(`/app/${c.guildId}`);
            })}><Icon name="trash" size={15} /> Delete channel</button
          >
        </div>
      {:else}
        <p class="muted">You can’t edit this channel.</p>
      {/if}
    {:else if tab === 'permissions' && g}
      <div class="perms">
        <div class="owlist">
          {#if c.parentId}<button class="btn small block" onclick={sync} title="Copy the category's permissions">Sync with category</button>{/if}
          <div class="label" style="margin:10px 0 4px">Roles & members</div>
          {#each overwrites as o (o.id)}
            <div class="ow" class:active={selected === o.id}>
              <button class="owb" onclick={() => (selected = o.id)}>{o.type === 1 ? '@' : ''}{owLabel(o)}</button>
              {#if o.id !== c.guildId}<button class="icon-btn mini" title="Remove" onclick={() => removeOverwrite(o.id)}><Icon name="x" size={13} /></button>{/if}
            </div>
          {/each}
          {#if !overwrites.some((o) => o.id === c.guildId)}
            <div class="ow" class:active={selected === c.guildId}><button class="owb" onclick={() => (selected = c.guildId!)}>@everyone</button></div>
          {/if}
          <button class="btn small ghost block" onclick={() => (addAnchor = !addAnchor)}><Icon name="plus" size={14} /> Add role or member</button>
          {#if addAnchor}
            <select class="select" size="8" onchange={(e) => ((selected = (e.target as HTMLSelectElement).value), (addAnchor = false))}>
              {#each addable as a (a.id)}<option value={a.id}>{a.kind === 'member' ? '@' : ''}{a.label}</option>{/each}
            </select>
          {/if}
        </div>
        <div class="editor">
          {#if selected && draft}
            <div class="row" style="margin-bottom:8px">
              <strong>{selected === c.guildId ? '@everyone' : g.roles.has(selected) ? g.roles.get(selected)?.name : app.displayName(selected, g.guild.id)}</strong>
              <span class="spacer"></span>
              <button class="btn primary small" onclick={saveOverwrite}>Save</button>
            </div>
            <PermissionEditor
              mode="overwrite"
              allow={draft.allow}
              deny={draft.deny}
              editable={(bit) => isOwner || has(myChannelPerms, P.ADMINISTRATOR) || ((bit & CHANNEL_PERMISSIONS) !== 0n && has(myChannelPerms, bit))}
              onchange={(a, d) => (draft = { allow: a, deny: d })}
            />
          {:else}
            <p class="faint">Pick a role or member on the left to change what they can do in this channel.</p>
          {/if}
        </div>
      </div>
    {:else if tab === 'members' && c.type === ChannelType.GROUP_DM}
      {#each c.recipients ?? [] as r (r.id)}
        <div class="row mem">
          <Avatar src={app.avatarOf(r.id)} name={app.displayName(r.id)} size={30} />
          <span class="truncate" style="flex:1">{app.displayName(r.id)} {#if c.ownerId === r.id}<Icon name="crown" size={13} />{/if}</span>
          {#if c.ownerId === app.me?.id && r.id !== app.me?.id}
            <button class="btn small danger" onclick={() => del(`/channels/${c.id}/recipients/${r.id}`).catch((e) => app.toast(errorMessage(e), 'error'))}>Remove</button>
          {/if}
        </div>
      {/each}
      {#if friends.length}
        <div class="row" style="margin-top:12px">
          <select class="select" bind:value={addMember}>
            <option value="">Add a friend…</option>
            {#each friends as f (f.user.id)}<option value={f.user.id}>{app.displayName(f.user.id)}</option>{/each}
          </select>
          <button class="btn primary" disabled={!addMember} onclick={() => put(`/channels/${c.id}/recipients/${addMember}`).then(() => (addMember = '')).catch((e) => app.toast(errorMessage(e), 'error'))}>Add</button>
        </div>
      {/if}
      <button class="btn danger" style="margin-top:18px" onclick={() => ui.confirm('Leave this group?', '', 'Leave', async () => { await del(`/channels/${c.id}`); ui.channelSettings = null; goto('/app/me'); })}>Leave group</button>
    {:else if tab === 'notifications'}
      {#if !isDm}
        <div class="field">
          <label for="lvl">Notify me about</label>
          <select id="lvl" class="select" value={cn?.level ?? -1} onchange={(e) => setNotif({ level: Number((e.target as HTMLSelectElement).value) })}>
            <option value={-1}>Use server default</option>
            <option value={0}>All messages</option>
            <option value={1}>Only @mentions</option>
            <option value={2}>Nothing</option>
          </select>
        </div>
      {/if}
      <div class="field">
        <label for="mute">Mute</label>
        <select id="mute" class="select" value="" onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v !== '') setNotif({ muteSeconds: v === 'off' ? null : Number(v) }); }}>
          <option value="" disabled>{cn?.mutedUntil && new Date(cn.mutedUntil).getTime() > Date.now() ? `Muted until ${new Date(cn.mutedUntil).getFullYear() > 9000 ? 'you unmute' : new Date(cn.mutedUntil).toLocaleString()}` : 'Not muted'}</option>
          <option value="900">For 15 minutes</option>
          <option value="3600">For 1 hour</option>
          <option value="28800">For 8 hours</option>
          <option value="86400">For 24 hours</option>
          <option value="-1">Until I turn it back on</option>
          <option value="off">Unmute</option>
        </select>
        <span class="hint">Muted channels don't light up as unread and never notify. @mentions still count.</span>
      </div>
    {/if}
  </Modal>
{/if}

<style>
  .perms {
    display: flex;
    gap: 16px;
    min-height: 360px;
  }
  .owlist {
    width: 190px;
    flex: none;
  }
  .ow {
    display: flex;
    align-items: center;
    border-radius: 6px;
  }
  .ow.active {
    background: var(--active);
  }
  .owb {
    flex: 1;
    text-align: left;
    padding: 6px 8px;
    border: none;
    background: none;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini {
    width: 24px;
    height: 24px;
  }
  .editor {
    flex: 1;
    min-width: 0;
  }
  .mem {
    padding: 6px 0;
  }
  @media (max-width: 640px) {
    .perms {
      flex-direction: column;
    }
    .owlist {
      width: auto;
    }
  }
</style>
