<script lang="ts">
  import { Limits, Permissions as P, fileIdFromUrl, type UserProfile } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, patch } from '$lib/api';
  import ImagePicker from '../../ImagePicker.svelte';
  import ProfileCard from '../../profile/ProfileCard.svelte';
  import Avatar from '../../Avatar.svelte';

  let { initialGuild = null }: { initialGuild?: string | null } = $props();
  const guilds = $derived([...app.guilds.values()]);
  let guildId = $state(initialGuild ?? [...app.guilds.keys()][0] ?? '');
  const g = $derived(app.guilds.get(guildId));
  const canNick = $derived(!!guildId && (app.can(P.CHANGE_NICKNAME, guildId) || app.can(P.MANAGE_NICKNAMES, guildId)));

  let base = $state<UserProfile | null>(null);
  let nickname = $state('');
  let avatar = $state<string | null>(null);
  let bio = $state('');
  let error = $state('');
  let saving = $state(false);

  async function load(id: string) {
    base = null;
    error = '';
    if (!id) return;
    try {
      const p = await app.profile(app.me!.id, id, true);
      if (id !== guildId) return;
      base = p;
      nickname = p.member?.nickname ?? '';
      avatar = p.member?.avatar ?? null;
      bio = p.member?.bio ?? '';
    } catch (e) {
      error = errorMessage(e);
    }
  }
  $effect(() => {
    void load(guildId);
  });

  const dirty = $derived(!!base && (nickname !== (base.member?.nickname ?? '') || avatar !== (base.member?.avatar ?? null) || bio !== (base.member?.bio ?? '')));
  const preview = $derived(
    base ? { ...base, member: { ...(base.member ?? { joinedAt: base.createdAt, roles: [] }), nickname: nickname.trim() || null, avatar, bio } } : null,
  );

  async function save() {
    if (!base) return;
    saving = true;
    error = '';
    try {
      const body: Record<string, unknown> = {};
      if (nickname !== (base.member?.nickname ?? '')) body.nickname = nickname.trim() || null;
      if (avatar !== (base.member?.avatar ?? null)) body.avatarFileId = fileIdFromUrl(avatar);
      if (bio !== (base.member?.bio ?? '')) body.bio = bio;
      await patch(`/guilds/${guildId}/members/@me`, body);
      app.invalidateProfile(app.me!.id);
      await load(guildId);
      app.toast('Server profile saved', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }
</script>

<h2>Server profiles</h2>
<p class="muted">A different nickname, avatar or bio per server. Anything left empty falls back to your main profile.</p>

{#if !guilds.length}
  <p class="faint">You're not in any servers yet.</p>
{:else}
  <div class="field">
    <label for="sg">Server</label>
    <select id="sg" class="select" bind:value={guildId}>
      {#each guilds as gs (gs.guild.id)}<option value={gs.guild.id}>{gs.guild.name}</option>{/each}
    </select>
  </div>

  {#if base && preview && g}
    <div class="layout">
      <div class="form">
        <div class="field">
          <label for="nk">Nickname</label>
          <input id="nk" class="input" bind:value={nickname} maxlength="32" placeholder={app.me?.displayName || app.me?.username} disabled={!canNick} />
          {#if !canNick}<span class="hint">This server doesn't let you change your nickname.</span>{/if}
        </div>
        <div class="field">
          <span class="label">Server avatar</span>
          <div class="row" style="gap:12px">
            <ImagePicker purpose="member_avatar" current={avatar} round label="Server avatar" onchange={(f) => (avatar = f?.url ?? null)} />
            {#if avatar}<button class="btn small ghost" onclick={() => (avatar = null)}>Use my main avatar</button>{:else}<span class="faint small row" style="gap:6px">Using <Avatar src={app.me?.avatar ?? null} name={app.me?.username ?? ''} size={22} /></span>{/if}
          </div>
        </div>
        <div class="field">
          <label for="sb">Server bio <span class="faint">({bio.length}/{Limits.BIO_MAX})</span></label>
          <textarea id="sb" class="textarea" rows="4" bind:value={bio} maxlength={Limits.BIO_MAX} placeholder="Shown instead of your main bio in this server"></textarea>
        </div>
        {#if error}<p class="error-text">{error}</p>{/if}
        <div class="row" style="gap:8px">
          <button class="btn primary" disabled={!dirty || saving} onclick={save}>Save</button>
          {#if dirty}<button class="btn ghost" onclick={() => load(guildId)}>Reset</button>{/if}
        </div>
      </div>
      <aside class="preview">
        <div class="label">Preview in {g.guild.name}</div>
        <ProfileCard userId={base.id} {guildId} {preview} />
      </aside>
    </div>
  {:else if error}
    <p class="error-text">{error}</p>
  {:else}
    <p class="faint">Loading…</p>
  {/if}
{/if}

<style>
  .layout {
    display: flex;
    gap: 24px;
    align-items: flex-start;
  }
  .form {
    flex: 1;
    min-width: 0;
  }
  .preview {
    width: 340px;
    flex: none;
  }
  @media (max-width: 1100px) {
    .layout {
      flex-direction: column;
    }
    .preview {
      width: 100%;
      max-width: 360px;
    }
  }
</style>
