<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    Permissions as P,
    RelationshipType,
    canActOn,
    highestPosition,
    proxiedImage,
    type Channel,
    type GuestbookEntry,
    type UserProfile,
  } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, del, errorMessage, get, post, put } from '$lib/api';
  import { loadFont, luminance, readableOn } from '$lib/theme';
  import { timeAgo } from '$lib/util/time';
  import { copy } from '$lib/util/channel';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';
  import Markdown from '../Markdown.svelte';
  import ProfileWidgets from './ProfileWidgets.svelte';
  import ProfileSongPlayer from './ProfileSongPlayer.svelte';
  import Popover from '../Popover.svelte';

  let { userId, guildId = null, preview = null }: { userId: string; guildId?: string | null; preview?: UserProfile | null } = $props();

  let profile = $state<UserProfile | null>(preview);
  let error = $state('');
  let tab = $state<'about' | 'guestbook' | 'mutual'>('about');
  let guestbook = $state<{ enabled: boolean; entries: GuestbookEntry[] } | null>(null);
  let gbText = $state('');
  let roleMenu = $state<HTMLElement | null>(null);
  let modMenu = $state<HTMLElement | null>(null);
  let dmText = $state('');

  $effect(() => {
    if (preview) {
      profile = preview;
      return;
    }
    error = '';
    void app
      .profile(userId, guildId, true)
      .then((p) => (profile = p))
      .catch((e) => (error = errorMessage(e)));
  });

  $effect(() => {
    if (tab === 'guestbook' && !guestbook && profile) {
      void get<{ enabled: boolean; entries: GuestbookEntry[] }>(`/users/${userId}/guestbook`).then((g) => (guestbook = g)).catch(() => {});
    }
  });

  const isMe = $derived(userId === app.me?.id);
  const presence = $derived(profile ? (app.presences.get(userId) ?? profile.presence) : null);
  const rel = $derived(app.relationships.get(userId)?.type ?? profile?.relationship ?? null);
  const theme = $derived(profile?.theme ?? {});
  const bgPrimary = $derived(theme.primary ?? null);
  const bgSecondary = $derived(theme.secondary ?? theme.primary ?? null);
  const background = $derived(
    bgPrimary ? `linear-gradient(${theme.angle ?? 160}deg, ${bgPrimary}, ${bgSecondary})` : 'var(--bg-float)',
  );
  const fg = $derived(bgPrimary ? readableOn(bgPrimary) : 'var(--text)');
  const accent = $derived(theme.accent ?? 'var(--accent)');
  const font = $derived(loadFont(theme.font));
  const dark = $derived(bgPrimary ? luminance(bgPrimary) < 0.6 : true);

  const g = $derived(guildId ? app.guilds.get(guildId) : null);
  const member = $derived(guildId ? app.member(guildId, userId) : null);
  const memberRoles = $derived(g && member ? g.sortedRoles.filter((r) => member.roles.includes(r.id)) : []);
  const myHighest = $derived(g && app.me ? (g.guild.ownerId === app.me.id ? Infinity : highestPosition(app.member(g.guild.id, app.me.id)?.roles ?? [], g.roles)) : 0);
  const theirHighest = $derived(g && member ? highestPosition(member.roles, g.roles) : 0);
  const canManageThem = $derived(!!g && !isMe && canActOn({ userId: app.me!.id, highest: myHighest }, { userId, highest: theirHighest }, g.guild.ownerId));
  const canRoles = $derived(!!g && app.can(P.MANAGE_ROLES, guildId));
  const nick = $derived(profile?.member?.nickname ?? null);
  const shownName = $derived(profile ? nick || profile.displayName || profile.username : '');
  const shownAvatar = $derived(profile ? (profile.member?.avatar ?? profile.avatar) : null);
  const shownBio = $derived(profile ? profile.member?.bio || profile.bio : '');

  async function act(fn: () => Promise<unknown>, ok?: string) {
    try {
      await fn();
      if (ok) app.toast(ok, 'success');
      app.invalidateProfile(userId);
      profile = await app.profile(userId, guildId, true);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function message(text?: string) {
    try {
      const c = await post<Channel>('/users/@me/channels', { recipientIds: [userId] });
      if (text?.trim()) await post(`/channels/${c.id}/messages`, { content: text.trim() });
      ui.profile = null;
      goto(`/app/me/${c.id}`);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function signGuestbook(e: Event) {
    e.preventDefault();
    if (!gbText.trim()) return;
    try {
      const entry = await post<GuestbookEntry>(`/users/${userId}/guestbook`, { content: gbText.trim() });
      guestbook = { enabled: true, entries: [entry, ...(guestbook?.entries ?? [])] };
      gbText = '';
    } catch (err) {
      app.toast(errorMessage(err), 'error');
    }
  }

  async function removeEntry(id: string) {
    await del(`/users/${userId}/guestbook/${id}`).catch((e) => app.toast(errorMessage(e), 'error'));
    if (guestbook) guestbook = { ...guestbook, entries: guestbook.entries.filter((x) => x.id !== id) };
  }

  async function toggleRole(roleId: string, has: boolean) {
    await act(() => (has ? del(`/guilds/${guildId}/members/${userId}/roles/${roleId}`) : put(`/guilds/${guildId}/members/${userId}/roles/${roleId}`)));
  }

  function timeout(seconds: number) {
    modMenu = null;
    void act(() => api('PATCH', `/guilds/${guildId}/members/${userId}`, { timeoutSeconds: seconds }), seconds ? 'Timed out' : 'Timeout removed');
  }

  function kick() {
    modMenu = null;
    ui.confirm(`Kick ${shownName}?`, 'They can rejoin with an invite.', 'Kick', async () => {
      await del(`/guilds/${guildId}/members/${userId}`, {});
      ui.profile = null;
    });
  }

  function ban() {
    modMenu = null;
    ui.confirm(`Ban ${shownName}?`, "They're removed and can't rejoin. Their messages from the last 24 hours are deleted too.", 'Ban', async () => {
      await put(`/guilds/${guildId}/bans/${userId}`, { deleteMessageSeconds: 86400 });
      ui.profile = null;
    }
    );
  }
</script>

<div class="card-p fade-in" style="--bg:{background};--fg:{fg};--accent-p:{accent};font-family:{font}" class:light={!dark}>
  {#if error}
    <div class="pad"><p class="error-text">{error}</p></div>
  {:else if !profile}
    <div class="pad faint">Loading…</div>
  {:else}
    <div class="banner" style:background={profile.banner ? undefined : bgPrimary ? 'rgb(0 0 0 / 0.15)' : 'var(--accent)'}>
      {#if profile.banner}
        {#if profile.bannerKind === 'video'}
          <video src={profile.banner} autoplay muted loop playsinline></video>
        {:else}
          <img src={profile.banner} alt="" />
        {/if}
      {/if}
      {#if profile.song}
        <div class="songpos"><ProfileSongPlayer song={profile.song} /></div>
      {/if}
    </div>
    <div class="avatarwrap">
      <Avatar src={shownAvatar} name={shownName} size={88} status={presence?.status ?? 'offline'} />
    </div>
    <div class="actions-top">
      {#if isMe}
        <button class="pbtn" onclick={() => { ui.profile = null; ui.settings = guildId ? `server-profile:${guildId}` : 'profile'; }}><Icon name="edit" size={14} /> Edit profile</button>
      {:else if rel === RelationshipType.FRIEND}
        <button class="pbtn" onclick={() => message()}><Icon name="message" size={14} /> Message</button>
      {:else if rel === RelationshipType.INCOMING}
        <button class="pbtn" onclick={() => act(() => put(`/users/@me/relationships/${userId}`, { type: 1 }), 'Friend added')}><Icon name="check" size={14} /> Accept</button>
      {:else if rel === RelationshipType.OUTGOING}
        <button class="pbtn" disabled>Request sent</button>
      {:else if rel !== RelationshipType.BLOCKED && !profile.deleted}
        <button class="pbtn" onclick={() => act(() => post('/users/@me/relationships', { username: profile!.username }), 'Friend request sent')}><Icon name="user-plus" size={14} /> Add friend</button>
      {/if}
    </div>

    <div class="pad">
      <div class="names">
        <h2 class="truncate">{shownName}</h2>
        <div class="un">
          @{profile.username}{#if profile.pronouns}&nbsp;·&nbsp;{profile.pronouns}{/if}
          {#if nick && profile.displayName && nick !== profile.displayName}<span class="faint"> · aka {profile.displayName}</span>{/if}
        </div>
      </div>

      {#if presence?.customStatus}
        <div class="cstatus">{presence.customStatus.emoji ?? ''} {presence.customStatus.text}</div>
      {/if}

      {#if presence?.playing || presence?.listening}
        <div class="activities">
          {#if presence.playing}
            <div class="act">
              {#if presence.playing.cover}<img src={proxiedImage(presence.playing.cover, 128)} alt="" />{:else}<span class="nc"><Icon name="gamepad" /></span>{/if}
              <div class="col" style="gap:0;min-width:0">
                <span class="lbl">Playing {#if presence.playing.lfg}<span class="lfg">LOOKING FOR GROUP</span>{/if}</span>
                <strong class="truncate">{presence.playing.name}</strong>
                <span class="sub">since {timeAgo(presence.playing.since)}</span>
              </div>
            </div>
          {/if}
          {#if presence.listening}
            <div class="act">
              {#if presence.listening.cover}<img src={proxiedImage(presence.listening.cover, 128)} alt="" />{:else}<span class="nc"><Icon name="music" /></span>{/if}
              <div class="col" style="gap:0;min-width:0">
                <span class="lbl">Listening to</span>
                <strong class="truncate">{presence.listening.title}</strong>
                <span class="sub truncate">{presence.listening.artist}</span>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <div class="ptabs">
        <button class:active={tab === 'about'} onclick={() => (tab = 'about')}>About</button>
        {#if !profile.deleted}<button class:active={tab === 'guestbook'} onclick={() => (tab = 'guestbook')}>Guestbook</button>{/if}
        {#if !isMe}<button class:active={tab === 'mutual'} onclick={() => (tab = 'mutual')}>Mutual</button>{/if}
      </div>

      <div class="tabbody scroll">
        {#if tab === 'about'}
          {#if shownBio}
            <div class="bio"><Markdown content={shownBio} mentions={false} jumboAllowed={false} /></div>
          {/if}
          {#if profile.links.length}
            <div class="links">
              {#each profile.links as l (l.url)}
                <a href={l.url} target="_blank" rel="noopener noreferrer nofollow me" title={l.url}><Icon name="link" size={13} /> {l.label}</a>
              {/each}
            </div>
          {/if}
          <ProfileWidgets widgets={profile.widgets} />
          {#if guildId && member && (memberRoles.length || (canRoles && (canManageThem || isMe)))}
            <section class="sect">
              <h4>Roles</h4>
              <div class="roles">
                {#each memberRoles as r (r.id)}
                  <span class="role">
                    <span class="rdot" style="background:{r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'var(--text-faint)'}"></span>{r.name}
                    {#if canRoles && (canManageThem || isMe)}<button class="rx" title="Remove role" onclick={() => toggleRole(r.id, true)}>×</button>{/if}
                  </span>
                {/each}
                {#if canRoles && (canManageThem || isMe)}
                  <button class="role add" onclick={(e) => (roleMenu = e.currentTarget)}>+ Add</button>
                {/if}
              </div>
            </section>
          {/if}
          <section class="sect small faint">
            {#if presence?.status === 'offline' && presence.lastSeenAt}<div>Last seen {timeAgo(presence.lastSeenAt)}</div>{/if}
            <div>Member since {new Date(profile.createdAt).toLocaleDateString()}</div>
            {#if profile.member}<div>Joined this server {new Date(profile.member.joinedAt).toLocaleDateString()}</div>{/if}
          </section>
        {:else if tab === 'guestbook'}
          {#if guestbook === null}
            <p class="sub">Loading…</p>
          {:else if !guestbook.enabled}
            <p class="sub">{isMe ? 'Your guestbook is turned off. Turn it on in profile settings.' : 'Guestbook is turned off.'}</p>
          {:else}
            {#if !isMe && rel === RelationshipType.FRIEND}
              <form class="gbform" onsubmit={signGuestbook}>
                <input class="input" placeholder="Leave a note (public)" bind:value={gbText} maxlength="200" />
                <button class="pbtn">Sign</button>
              </form>
            {:else if !isMe}
              <p class="sub small">Only friends can sign.</p>
            {/if}
            {#each guestbook.entries as e (e.id)}
              <div class="gb">
                <Avatar src={e.author.avatar} name={e.author.displayName || e.author.username} size={24} />
                <div class="col" style="gap:0;min-width:0;flex:1">
                  <span class="small"><strong>{e.author.displayName || e.author.username}</strong> <span class="sub">{timeAgo(e.createdAt)}</span></span>
                  <span class="gbtext">{e.content}</span>
                </div>
                {#if isMe || e.author.id === app.me?.id}<button class="rx" title="Delete" onclick={() => removeEntry(e.id)}>×</button>{/if}
              </div>
            {:else}
              <p class="sub">No entries yet.</p>
            {/each}
          {/if}
        {:else}
          <h4>Mutual servers ({profile.mutualGuilds.length})</h4>
          {#each profile.mutualGuilds as gid (gid)}
            {@const mg = app.guilds.get(gid)}
            {#if mg}
              <button class="mutual" onclick={() => { ui.profile = null; goto(`/app/${gid}`); }}>
                <Avatar src={mg.guild.icon} name={mg.guild.name} size={26} square />{mg.guild.name}
              </button>
            {/if}
          {/each}
          <h4 style="margin-top:12px">Mutual friends ({profile.mutualFriends.length})</h4>
          {#each profile.mutualFriends as f (f.id)}
            <button class="mutual" onclick={() => { ui.profile = { userId: f.id, guildId: null }; }}>
              <Avatar src={f.avatar} name={f.displayName || f.username} size={26} />{f.displayName || f.username}
            </button>
          {/each}
        {/if}
      </div>

      {#if !isMe && !profile.deleted}
        <div class="bottom">
          {#if rel !== RelationshipType.BLOCKED}
            <form class="quick" onsubmit={(e) => (e.preventDefault(), message(dmText))}>
              <input class="input" placeholder="Message @{profile.username}" bind:value={dmText} />
            </form>
          {/if}
          <div class="row wrap">
            {#if rel === RelationshipType.FRIEND}
              <button class="lnk" onclick={() => ui.confirm(`Remove ${shownName} as a friend?`, '', 'Remove friend', () => del(`/users/@me/relationships/${userId}`))}>Remove friend</button>
            {/if}
            {#if rel === RelationshipType.BLOCKED}
              <button class="lnk" onclick={() => act(() => del(`/users/@me/relationships/${userId}`), 'Unblocked')}>Unblock</button>
            {:else}
              <button class="lnk danger" onclick={() => ui.confirm(`Block ${shownName}?`, "They won't be able to DM you, and their messages get hidden.", 'Block', () => put(`/users/@me/relationships/${userId}`, { type: 2 }))}>Block</button>
            {/if}
            {#if g && canManageThem && (app.can(P.KICK_MEMBERS, guildId) || app.can(P.BAN_MEMBERS, guildId) || app.can(P.MODERATE_MEMBERS, guildId))}
              <button class="lnk" onclick={(e) => (modMenu = e.currentTarget)}><Icon name="shield" size={13} /> Moderate</button>
            {/if}
            {#if app.settings.showIds}<button class="lnk" onclick={() => copy(userId, 'ID copied')}>Copy ID</button>{/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>

{#if roleMenu && g}
  <Popover anchor={roleMenu} onclose={() => (roleMenu = null)}>
    <div class="menu scroll" style="max-height:300px">
      {#each g.sortedRoles.filter((r) => r.id !== guildId && (g.guild.ownerId === app.me?.id || r.position < myHighest)) as r (r.id)}
        {@const has = member?.roles.includes(r.id) ?? false}
        <button class="menu-item" onclick={() => toggleRole(r.id, has)}>
          <span class="rdot" style="background:{r.color ? `#${r.color.toString(16).padStart(6, '0')}` : 'var(--text-faint)'}"></span>
          {r.name}
          {#if has}<Icon name="check" size={14} />{/if}
        </button>
      {:else}
        <p class="faint" style="padding:6px">No roles you can assign.</p>
      {/each}
    </div>
  </Popover>
{/if}

{#if modMenu}
  <Popover anchor={modMenu} placement="top-start" onclose={() => (modMenu = null)}>
    <div class="menu">
      {#if app.can(P.MODERATE_MEMBERS, guildId)}
        {#if member?.timeoutUntil}
          <button class="menu-item" onclick={() => timeout(0)}>Remove timeout</button>
        {:else}
          {#each [[60, '60 seconds'], [300, '5 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']] as const as [s, l] (s)}
            <button class="menu-item" onclick={() => timeout(s)}><Icon name="clock" size={14} /> Time out for {l}</button>
          {/each}
        {/if}
      {/if}
      {#if app.can(P.KICK_MEMBERS, guildId)}<button class="menu-item danger" onclick={kick}>Kick</button>{/if}
      {#if app.can(P.BAN_MEMBERS, guildId)}<button class="menu-item danger" onclick={ban}>Ban</button>{/if}
    </div>
  </Popover>
{/if}

<style>
  .card-p {
    width: 340px;
    max-width: calc(100vw - 32px);
    border-radius: 14px;
    overflow: hidden;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    box-shadow: var(--shadow);
    position: relative;
  }
  .pad {
    padding: 0 16px 14px;
  }
  .banner {
    height: 120px;
    position: relative;
    overflow: hidden;
  }
  .banner img,
  .banner video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .songpos {
    position: absolute;
    right: 8px;
    bottom: 8px;
    max-width: 70%;
  }
  .avatarwrap {
    position: absolute;
    top: 72px;
    left: 14px;
    border-radius: 50%;
    border: 6px solid var(--bg-float);
    background: var(--bg-float);
  }
  .actions-top {
    display: flex;
    justify-content: flex-end;
    padding: 10px 12px 0;
    min-height: 44px;
  }
  .pbtn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: var(--accent-p);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 10px;
    font-weight: 700;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .pbtn:disabled {
    opacity: 0.6;
  }
  .names {
    margin-top: 10px;
  }
  h2 {
    margin: 0;
    font-size: 1.3rem;
  }
  .un {
    font-size: 0.86rem;
    opacity: 0.85;
  }
  .cstatus {
    margin-top: 6px;
    font-size: 0.9rem;
  }
  .activities {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
  }
  .act {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px;
    border-radius: 8px;
    background: rgb(0 0 0 / 0.18);
  }
  .light .act {
    background: rgb(0 0 0 / 0.06);
  }
  .act img,
  .nc {
    width: 46px;
    height: 46px;
    object-fit: cover;
    border-radius: 6px;
    flex: none;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.2);
  }
  .lbl {
    font-size: 0.7rem;
    font-weight: 800;
    text-transform: uppercase;
    opacity: 0.8;
  }
  .lfg {
    background: var(--success);
    color: #fff;
    padding: 0 4px;
    border-radius: 3px;
    margin-left: 4px;
  }
  .sub {
    font-size: 0.78rem;
    opacity: 0.75;
  }
  .ptabs {
    display: flex;
    gap: 14px;
    margin: 14px 0 0;
    border-bottom: 1px solid rgb(127 127 127 / 0.3);
  }
  .ptabs button {
    background: none;
    border: none;
    padding: 6px 0;
    cursor: pointer;
    font-weight: 600;
    opacity: 0.7;
    border-bottom: 2px solid transparent;
    color: inherit;
  }
  .ptabs button.active {
    opacity: 1;
    border-bottom-color: var(--accent-p);
  }
  .tabbody {
    max-height: 320px;
    padding-top: 6px;
  }
  .bio {
    margin-top: 6px;
    font-size: 0.9rem;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .links a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.82rem;
    background: rgb(127 127 127 / 0.2);
    color: inherit;
    padding: 3px 8px;
    border-radius: 99px;
  }
  .sect {
    margin-top: 12px;
  }
  h4 {
    margin: 0 0 6px;
    font-size: 0.72rem;
    text-transform: uppercase;
    opacity: 0.75;
  }
  .roles {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .role {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.78rem;
    padding: 2px 8px;
    border-radius: 6px;
    background: rgb(127 127 127 / 0.2);
    border: none;
    color: inherit;
  }
  .role.add {
    cursor: pointer;
  }
  .rdot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
  }
  .rx {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.7;
  }
  .small {
    font-size: 0.8rem;
  }
  .gbform {
    display: flex;
    gap: 6px;
    margin: 6px 0 10px;
  }
  .gb {
    display: flex;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid rgb(127 127 127 / 0.2);
  }
  .gbtext {
    font-size: 0.88rem;
    overflow-wrap: anywhere;
  }
  .mutual {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px;
    border: none;
    background: none;
    color: inherit;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .mutual:hover {
    background: rgb(127 127 127 / 0.2);
  }
  .bottom {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .quick .input {
    background: rgb(0 0 0 / 0.25);
    border-color: transparent;
    color: inherit;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .lnk {
    background: none;
    border: none;
    color: inherit;
    opacity: 0.8;
    font-size: 0.8rem;
    cursor: pointer;
    padding: 0;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }
  .lnk:hover {
    opacity: 1;
    text-decoration: underline;
  }
  .lnk.danger {
    color: var(--danger);
  }
</style>
