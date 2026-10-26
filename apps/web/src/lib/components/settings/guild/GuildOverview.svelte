<script lang="ts">
  import { goto } from '$app/navigation';
  import { ChannelType } from '@haunt/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, patch, post, type UploadedFile } from '$lib/api';
  import ImagePicker from '../../ImagePicker.svelte';
  import Modal from '../../Modal.svelte';

  let { g }: { g: GuildState } = $props();
  const guild = $derived(g.guild);
  const isOwner = $derived(guild.ownerId === app.me?.id);

  let name = $state('');
  let description = $state('');
  let systemChannelId = $state('');
  let icon = $state<UploadedFile | null | undefined>(undefined);
  let banner = $state<UploadedFile | null | undefined>(undefined);
  let saving = $state(false);
  let error = $state('');

  function reset() {
    name = guild.name;
    description = guild.description;
    systemChannelId = guild.systemChannelId ?? '';
    icon = undefined;
    banner = undefined;
  }
  reset();

  const textChannels = $derived([...g.channels.values()].filter((c) => c.type === ChannelType.TEXT).sort((a, b) => a.position - b.position));
  const dirty = $derived(
    name !== guild.name || description !== guild.description || systemChannelId !== (guild.systemChannelId ?? '') || icon !== undefined || banner !== undefined,
  );

  async function save() {
    saving = true;
    error = '';
    try {
      const body: Record<string, unknown> = {};
      if (name !== guild.name) body.name = name;
      if (description !== guild.description) body.description = description;
      if (systemChannelId !== (guild.systemChannelId ?? '')) body.systemChannelId = systemChannelId || null;
      if (icon !== undefined) body.iconFileId = icon?.id ?? null;
      if (banner !== undefined) body.bannerFileId = banner?.id ?? null;
      await patch(`/guilds/${guild.id}`, body);
      icon = undefined;
      banner = undefined;
      app.toast('Server updated', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }

  // ---- transfer ----
  let transferOpen = $state(false);
  let transferTo = $state('');
  let transferPw = $state('');
  let transferErr = $state('');
  const others = $derived([...g.members.values()].filter((m) => m.user.id !== app.me?.id && !m.user.deleted));
  async function transfer(e: Event) {
    e.preventDefault();
    transferErr = '';
    try {
      await post(`/guilds/${guild.id}/transfer`, { userId: transferTo, password: transferPw });
      transferOpen = false;
      app.toast('Ownership transferred', 'success');
    } catch (err) {
      transferErr = errorMessage(err);
    }
  }

  // ---- delete ----
  let deleteOpen = $state(false);
  let typed = $state('');
  async function remove() {
    try {
      await del(`/guilds/${guild.id}`);
      ui.guildSettings = null;
      goto('/app/me');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<h2>Server overview</h2>
<div class="top">
  <div class="field">
    <span class="label">Icon</span>
    <ImagePicker purpose="guild_icon" current={guild.icon} round label="Server icon" onchange={(f) => (icon = f)} />
  </div>
  <div class="field" style="flex:1">
    <span class="label">Banner</span>
    <ImagePicker purpose="guild_banner" current={guild.banner} label="Server banner" width={300} height={110} onchange={(f) => (banner = f)} />
    <span class="hint">Shown at the top of the channel list. Animated GIFs work — no subscription required, obviously.</span>
  </div>
</div>
<div class="field">
  <label for="gn">Server name</label>
  <input id="gn" class="input" bind:value={name} maxlength="100" />
</div>
<div class="field">
  <label for="gd">Description</label>
  <textarea id="gd" class="textarea" bind:value={description} maxlength="300" rows="3" placeholder="What's this server about? Shown on invites."></textarea>
</div>
<div class="field">
  <label for="sc">System messages channel</label>
  <select id="sc" class="select" bind:value={systemChannelId}>
    <option value="">None</option>
    {#each textChannels as c (c.id)}<option value={c.id}>#{c.name}</option>{/each}
  </select>
  <span class="hint">Where "someone joined" messages go.</span>
</div>
{#if error}<p class="error-text">{error}</p>{/if}
{#if dirty}
  <div class="savebar fade-in">
    <span>You have unsaved changes</span>
    <span class="spacer"></span>
    <button class="btn ghost" onclick={reset}>Reset</button>
    <button class="btn primary" disabled={saving || name.trim().length < 2} onclick={save}>Save changes</button>
  </div>
{/if}

{#if isOwner}
  <h3>Danger zone</h3>
  <div class="danger-zone">
    <div class="srow">
      <span class="txt"><strong>Transfer ownership</strong><small>Give the server to another member. You'll lose owner powers.</small></span>
      <button class="btn" onclick={() => (transferOpen = true)}>Transfer</button>
    </div>
    <div class="srow">
      <span class="txt"><strong>Delete server</strong><small>Deletes every channel, message, file and role. No undo.</small></span>
      <button class="btn danger" onclick={() => ((deleteOpen = true), (typed = ''))}>Delete server</button>
    </div>
  </div>
{/if}

{#if transferOpen}
  <Modal title="Transfer ownership" onclose={() => (transferOpen = false)} width={440}>
    <form id="tf" onsubmit={transfer}>
      <div class="field">
        <label for="tt">New owner</label>
        <select id="tt" class="select" bind:value={transferTo} required>
          <option value="" disabled>Pick a member</option>
          {#each others as m (m.user.id)}<option value={m.user.id}>{app.displayName(m.user.id, guild.id)} (@{m.user.username})</option>{/each}
        </select>
      </div>
      <div class="field">
        <label for="tp">Your password</label>
        <input id="tp" class="input" type="password" bind:value={transferPw} autocomplete="current-password" required />
      </div>
      {#if transferErr}<p class="error-text">{transferErr}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (transferOpen = false)}>Cancel</button>
      <button class="btn danger" type="submit" form="tf" disabled={!transferTo || !transferPw}>Transfer</button>
    {/snippet}
  </Modal>
{/if}

{#if deleteOpen}
  <Modal title="Delete {guild.name}?" onclose={() => (deleteOpen = false)} width={440}>
    <p>This permanently deletes the server for everyone. Type the server name to confirm.</p>
    <input class="input" bind:value={typed} placeholder={guild.name} />
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (deleteOpen = false)}>Cancel</button>
      <button class="btn danger" disabled={typed.trim() !== guild.name.trim()} onclick={remove}>Delete forever</button>
    {/snippet}
  </Modal>
{/if}

<style>
  .top {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
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
  .danger-zone {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    border-radius: 10px;
    padding: 0 14px;
  }
  .danger-zone .srow:last-child {
    border-bottom: none;
  }
</style>
