<script lang="ts">
  import { Permissions as P, has, type Role } from '@dbb/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, patch, post, put } from '$lib/api';
  import PermissionEditor from '../PermissionEditor.svelte';
  import Avatar from '../../Avatar.svelte';
  import Icon from '../../Icon.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);
  const isOwner = $derived(g.guild.ownerId === app.me?.id);
  const myPerms = $derived(app.perms(gid));
  const isAdmin = $derived(isOwner || has(myPerms, P.ADMINISTRATOR));
  const myHighest = $derived.by(() => {
    if (isOwner) return Infinity;
    const m = app.me ? g.members.get(app.me.id) : null;
    return Math.max(0, ...(m?.roles ?? []).map((r) => g.roles.get(r)?.position ?? 0));
  });
  const canEdit = (r: Role) => r.id === gid || isOwner || r.position < myHighest;

  const roles = $derived(g.sortedRoles.filter((r) => r.id !== gid));
  const everyone = $derived(g.roles.get(gid));

  let selectedId = $state<string | null>(null);
  const selected = $derived(selectedId ? (g.roles.get(selectedId) ?? null) : null);
  let sub = $state<'display' | 'permissions' | 'members'>('display');

  // editable draft of the selected role
  let name = $state('');
  let color = $state('#99aab5');
  let hasColor = $state(false);
  let hoist = $state(false);
  let mentionable = $state(false);
  let permissions = $state(0n);
  let error = $state('');
  let saving = $state(false);

  function load(r: Role | null) {
    error = '';
    if (!r) return;
    name = r.name;
    hasColor = r.color !== 0;
    color = r.color ? '#' + r.color.toString(16).padStart(6, '0') : '#99aab5';
    hoist = r.hoist;
    mentionable = r.mentionable;
    permissions = BigInt(r.permissions);
  }
  $effect(() => {
    // reload the draft when switching roles (not on every gateway update of the same role)
    void selectedId;
    load(selectedId ? (g.roles.get(selectedId) ?? null) : null);
  });

  const colorNum = $derived(hasColor ? parseInt(color.slice(1), 16) || 0 : 0);
  const dirty = $derived(
    !!selected &&
      (name !== selected.name || colorNum !== selected.color || hoist !== selected.hoist || mentionable !== selected.mentionable || permissions !== BigInt(selected.permissions)),
  );

  async function save() {
    if (!selected) return;
    saving = true;
    error = '';
    try {
      const body: Record<string, unknown> = {};
      if (selected.id !== gid) {
        if (name !== selected.name) body.name = name;
        if (colorNum !== selected.color) body.color = colorNum;
        if (hoist !== selected.hoist) body.hoist = hoist;
        if (mentionable !== selected.mentionable) body.mentionable = mentionable;
      }
      if (permissions !== BigInt(selected.permissions)) body.permissions = permissions.toString();
      const r = await patch<Role>(`/guilds/${gid}/roles/${selected.id}`, body);
      g.roles.set(r.id, r);
      app.toast('Role saved', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }

  async function create() {
    try {
      const r = await post<Role>(`/guilds/${gid}/roles`, { name: 'new role' });
      g.roles.set(r.id, r);
      selectedId = r.id;
      sub = 'display';
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function remove(r: Role) {
    ui.confirm(`Delete ${r.name}?`, 'Everyone with this role loses it. Channel permissions for it are removed too.', 'Delete role', async () => {
      await del(`/guilds/${gid}/roles/${r.id}`);
      if (selectedId === r.id) selectedId = null;
    });
  }

  // ---- drag to reorder ----
  let dragId = $state<string | null>(null);
  let overId = $state<string | null>(null);
  async function drop(targetId: string) {
    const from = dragId;
    dragId = overId = null;
    if (!from || from === targetId) return;
    const list = roles.map((r) => r.id); // highest first
    list.splice(list.indexOf(from), 1);
    list.splice(list.indexOf(targetId), 0, from);
    const n = list.length;
    try {
      await patch(`/guilds/${gid}/roles`, list.map((id, i) => ({ id, position: n - i })));
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  // ---- members of a role ----
  const roleMembers = $derived(selected ? [...g.members.values()].filter((m) => m.roles.includes(selected.id)) : []);
  let addQuery = $state('');
  const addCandidates = $derived.by(() => {
    if (!selected || addQuery.trim().length < 1) return [];
    const q = addQuery.toLowerCase();
    return [...g.members.values()]
      .filter((m) => !m.roles.includes(selected.id) && (m.user.username.includes(q) || app.displayName(m.user.id, gid).toLowerCase().includes(q)))
      .slice(0, 8);
  });
  async function addMember(userId: string) {
    if (!selected) return;
    try {
      await put(`/guilds/${gid}/members/${userId}/roles/${selected.id}`);
      addQuery = '';
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
  async function removeMember(userId: string) {
    if (!selected) return;
    try {
      await del(`/guilds/${gid}/members/${userId}/roles/${selected.id}`);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  const PRESETS = ['#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#11806a', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300'];
</script>

<div class="head">
  <h2>Roles</h2>
  <span class="spacer"></span>
  <button class="btn primary" onclick={create}><Icon name="plus" size={15} /> Create role</button>
</div>
<p class="muted">Roles higher in the list win. Drag to reorder — you can only move roles below your own highest role.</p>

<div class="layout">
  <div class="list">
    {#each roles as r (r.id)}
      <div
        class="role"
        class:active={selectedId === r.id}
        class:over={overId === r.id && dragId !== r.id}
        class:locked={!canEdit(r)}
        draggable={canEdit(r)}
        role="listitem"
        ondragstart={(e) => {
          dragId = r.id;
          e.dataTransfer?.setData('text/plain', r.id);
        }}
        ondragover={(e) => {
          if (!dragId || !canEdit(r)) return;
          e.preventDefault();
          overId = r.id;
        }}
        ondragleave={() => overId === r.id && (overId = null)}
        ondrop={(e) => {
          e.preventDefault();
          void drop(r.id);
        }}
        ondragend={() => (dragId = overId = null)}
      >
        {#if canEdit(r)}<span class="grip"><Icon name="grip" size={14} /></span>{:else}<span class="grip"><Icon name="lock" size={12} /></span>{/if}
        <button class="rb" onclick={() => ((selectedId = r.id), (sub = 'display'))}>
          <span class="dot" style="background:{r.color ? '#' + r.color.toString(16).padStart(6, '0') : 'var(--text-faint)'}"></span>
          <span class="truncate">{r.name}</span>
          <span class="faint count">{[...g.members.values()].filter((m) => m.roles.includes(r.id)).length}</span>
        </button>
      </div>
    {/each}
    {#if everyone}
      <div class="role" class:active={selectedId === gid}>
        <span class="grip"></span>
        <button class="rb" onclick={() => ((selectedId = gid), (sub = 'permissions'))}>
          <span class="dot" style="background:var(--text-faint)"></span>
          <span class="truncate">@everyone</span>
        </button>
      </div>
    {/if}
  </div>

  <div class="editor">
    {#if selected}
      {@const editable = canEdit(selected)}
      <div class="tabs">
        {#if selected.id !== gid}<button class="tab" class:active={sub === 'display'} onclick={() => (sub = 'display')}>Display</button>{/if}
        <button class="tab" class:active={sub === 'permissions'} onclick={() => (sub = 'permissions')}>Permissions</button>
        {#if selected.id !== gid}<button class="tab" class:active={sub === 'members'} onclick={() => (sub = 'members')}>Members ({roleMembers.length})</button>{/if}
      </div>
      {#if !editable}<p class="faint small"><Icon name="lock" size={12} /> This role is at or above your highest role, so you can't change it.</p>{/if}

      {#if sub === 'display' && selected.id !== gid}
        <div class="field">
          <label for="rn">Role name</label>
          <input id="rn" class="input" bind:value={name} maxlength="100" disabled={!editable} />
        </div>
        <div class="field">
          <span class="label">Colour</span>
          <div class="colors">
            <button class="sw none" class:on={!hasColor} title="No colour" disabled={!editable} onclick={() => (hasColor = false)}><Icon name="x" size={14} /></button>
            {#each PRESETS as p (p)}
              <button class="sw" class:on={hasColor && color === p} style="background:{p}" title={p} disabled={!editable} onclick={() => ((color = p), (hasColor = true))} aria-label="Colour {p}"></button>
            {/each}
            <input type="color" class="custom" value={color} disabled={!editable} oninput={(e) => ((color = (e.target as HTMLInputElement).value), (hasColor = true))} title="Custom colour" />
          </div>
        </div>
        <label class="srow">
          <span class="txt"><strong>Show separately in the member list</strong><small>Members with this role get their own section</small></span>
          <input type="checkbox" class="switch" bind:checked={hoist} disabled={!editable} />
        </label>
        <label class="srow">
          <span class="txt"><strong>Anyone can @mention this role</strong><small>People with "Mention everyone" can always mention it</small></span>
          <input type="checkbox" class="switch" bind:checked={mentionable} disabled={!editable} />
        </label>
        {#if editable}
          <button class="btn danger" style="margin-top:20px" onclick={() => remove(selected)}><Icon name="trash" size={15} /> Delete role</button>
        {/if}
      {:else if sub === 'permissions'}
        {#if selected.id === gid}<p class="muted small">Everyone in the server gets these. Give out the powerful stuff through roles instead.</p>{/if}
        <PermissionEditor
          mode="role"
          allow={permissions}
          editable={(bit) => editable && (isAdmin || has(myPerms, bit))}
          onchange={(a) => (permissions = a)}
        />
      {:else if sub === 'members'}
        {#if editable}
          <div class="addm">
            <input class="input" placeholder="Add members — search by name" bind:value={addQuery} />
            {#if addCandidates.length}
              <div class="cands menu">
                {#each addCandidates as m (m.user.id)}
                  <button class="menu-item" onclick={() => addMember(m.user.id)}>
                    <Avatar src={app.avatarOf(m.user.id, gid)} name={app.displayName(m.user.id, gid)} size={22} />
                    {app.displayName(m.user.id, gid)} <span class="faint">@{m.user.username}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        {#each roleMembers as m (m.user.id)}
          <div class="list-item">
            <Avatar src={app.avatarOf(m.user.id, gid)} name={app.displayName(m.user.id, gid)} size={28} />
            <span class="truncate" style="flex:1">{app.displayName(m.user.id, gid)} <span class="faint">@{m.user.username}</span></span>
            {#if editable}<button class="icon-btn" title="Remove role" onclick={() => removeMember(m.user.id)}><Icon name="x" size={15} /></button>{/if}
          </div>
        {:else}
          <p class="faint">Nobody has this role yet.</p>
        {/each}
      {/if}

      {#if error}<p class="error-text">{error}</p>{/if}
      {#if dirty && editable}
        <div class="savebar fade-in">
          <span>Unsaved changes</span>
          <span class="spacer"></span>
          <button class="btn ghost" onclick={() => load(selected)}>Reset</button>
          <button class="btn primary" disabled={saving || !name.trim()} onclick={save}>Save</button>
        </div>
      {/if}
    {:else}
      <p class="faint">Pick a role to edit it.</p>
    {/if}
  </div>
</div>

<style>
  .head {
    display: flex;
    align-items: center;
  }
  .layout {
    display: flex;
    gap: 18px;
    margin-top: 14px;
  }
  .list {
    width: 210px;
    flex: none;
  }
  .role {
    display: flex;
    align-items: center;
    border-radius: 6px;
    border-top: 2px solid transparent;
  }
  .role.over {
    border-top-color: var(--accent);
  }
  .role.active {
    background: var(--active);
  }
  .role:hover:not(.active) {
    background: var(--hover);
  }
  .grip {
    width: 20px;
    display: grid;
    place-items: center;
    color: var(--text-faint);
    cursor: grab;
  }
  .role.locked .grip {
    cursor: default;
  }
  .rb {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px 7px 2px;
    border: none;
    background: none;
    cursor: pointer;
    text-align: left;
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex: none;
  }
  .count {
    margin-left: auto;
    font-size: 0.75rem;
  }
  .editor {
    flex: 1;
    min-width: 0;
  }
  .colors {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }
  .sw {
    width: 28px;
    height: 28px;
    border-radius: 6px;
    border: 2px solid transparent;
    cursor: pointer;
    display: grid;
    place-items: center;
  }
  .sw.none {
    background: var(--bg-0);
    color: var(--text-faint);
  }
  .sw.on {
    border-color: var(--text);
  }
  .custom {
    width: 40px;
    height: 30px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }
  .addm {
    position: relative;
    margin-bottom: 10px;
  }
  .cands {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    z-index: 5;
  }
  .savebar {
    position: sticky;
    bottom: 12px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 10px;
    background: var(--bg-0);
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
    margin-top: 16px;
  }
  @media (max-width: 700px) {
    .layout {
      flex-direction: column;
    }
    .list {
      width: auto;
    }
  }
</style>
