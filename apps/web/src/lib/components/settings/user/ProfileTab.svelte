<script lang="ts">
  import {
    Limits,
    PROFILE_FONTS,
    PROFILE_FONT_LABELS,
    fileIdFromUrl,
    youtubeId,
    youtubeStart,
    type ProfileFont,
    type ProfileLink,
    type ProfileSong,
    type ProfileTheme,
    type ProfileWidget,
    type SelfUser,
    type UserProfile,
  } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, patch, upload } from '$lib/api';
  import ImagePicker from '../../ImagePicker.svelte';
  import ProfileCard from '../../profile/ProfileCard.svelte';
  import WidgetEditor from '../../profile/WidgetEditor.svelte';
  import Icon from '../../Icon.svelte';

  type SongDraft = { kind: 'none' } | { kind: 'upload'; url: string; title: string; durationMs?: number } | { kind: 'youtube'; url: string; title: string };

  interface Draft {
    displayName: string;
    avatar: string | null;
    banner: string | null;
    bannerKind: 'image' | 'video' | null;
    pronouns: string;
    bio: string;
    links: ProfileLink[];
    customColors: boolean;
    primary: string;
    secondary: string;
    angle: number;
    useAccent: boolean;
    accent: string;
    font: ProfileFont;
    widgets: ProfileWidget[];
    song: SongDraft;
    guestbookEnabled: boolean;
  }

  let base = $state<UserProfile | null>(null);
  let draft = $state<Draft | null>(null);
  let original = $state('');
  let loadError = $state('');
  let saving = $state(false);
  let error = $state('');

  function songDraft(s: ProfileSong | null): SongDraft {
    if (!s) return { kind: 'none' };
    if (s.kind === 'upload') return { kind: 'upload', url: s.url, title: s.title, durationMs: s.durationMs };
    return { kind: 'youtube', url: `https://youtu.be/${s.videoId}${s.start ? `?t=${s.start}` : ''}`, title: s.title };
  }

  function fromProfile(p: UserProfile): Draft {
    const t = p.theme ?? {};
    return {
      displayName: p.displayName ?? '',
      avatar: p.avatar,
      banner: p.banner,
      bannerKind: p.bannerKind,
      pronouns: p.pronouns,
      bio: p.bio,
      links: p.links.map((l) => ({ ...l })),
      customColors: !!t.primary,
      primary: t.primary ?? '#5b4dff',
      secondary: t.secondary ?? t.primary ?? '#1c1d24',
      angle: t.angle ?? 160,
      useAccent: !!t.accent,
      accent: t.accent ?? '#7c6cff',
      font: t.font ?? 'default',
      widgets: structuredClone($state.snapshot(p.widgets) as ProfileWidget[]),
      song: songDraft(p.song),
      guestbookEnabled: p.guestbookEnabled,
    };
  }

  async function load() {
    try {
      const p = await app.profile(app.me!.id, null, true);
      base = p;
      draft = fromProfile(p);
      original = JSON.stringify(draft);
    } catch (e) {
      loadError = errorMessage(e);
    }
  }
  void load();

  const dirty = $derived(!!draft && JSON.stringify(draft) !== original);

  function themeOf(d: Draft): ProfileTheme {
    const t: ProfileTheme = {};
    if (d.customColors) {
      t.primary = d.primary;
      t.secondary = d.secondary;
      t.angle = d.angle;
    }
    if (d.useAccent) t.accent = d.accent;
    if (d.font !== 'default') t.font = d.font;
    return t;
  }

  function songOut(s: SongDraft): ProfileSong | null {
    if (s.kind === 'upload') return { kind: 'upload', url: s.url, title: s.title || 'Profile song', durationMs: s.durationMs };
    if (s.kind === 'youtube') {
      const id = youtubeId(s.url);
      return id ? { kind: 'youtube', videoId: id, title: s.title || 'Profile song', start: youtubeStart(s.url) } : null;
    }
    return null;
  }

  /** What other people will see, built from the unsaved draft. */
  const preview = $derived.by((): UserProfile | null => {
    if (!base || !draft) return null;
    return {
      ...base,
      displayName: draft.displayName.trim() || null,
      avatar: draft.avatar,
      banner: draft.banner,
      bannerKind: draft.bannerKind,
      pronouns: draft.pronouns,
      bio: draft.bio,
      links: draft.links.filter((l) => l.label && l.url),
      theme: themeOf(draft),
      widgets: draft.widgets,
      song: songOut(draft.song),
      guestbookEnabled: draft.guestbookEnabled,
      member: null,
    };
  });

  /** Display-shape widgets → API input shape (file ids for our uploads, urls for database covers). */
  function widgetInput(w: ProfileWidget): unknown {
    const cover = (c: string | null | undefined) => {
      const id = fileIdFromUrl(c);
      return id ? { coverFileId: id } : c ? { coverUrl: c } : {};
    };
    switch (w.type) {
      case 'games':
        return { id: w.id, type: w.type, title: w.title, items: w.items.map((g) => ({ name: g.name, source: g.source, sourceId: g.sourceId ?? null, ...cover(g.cover) })) };
      case 'songs':
        return { id: w.id, type: w.type, title: w.title, items: w.items.map((s) => ({ title: s.title, artist: s.artist, ...cover(s.cover) })) };
      case 'photos':
        return { id: w.id, type: w.type, title: w.title, items: w.items.map((p) => ({ fileId: fileIdFromUrl(p.url), caption: p.caption })) };
      case 'currently_into':
        return { id: w.id, type: w.type, title: w.title, items: w.items };
      case 'text':
        return { id: w.id, type: w.type, title: w.title, content: w.content };
    }
  }

  async function save() {
    if (!draft) return;
    const before = JSON.parse(original) as Draft;
    const d = draft;
    const body: Record<string, unknown> = {};
    if (d.displayName !== before.displayName) body.displayName = d.displayName.trim() || null;
    if (d.avatar !== before.avatar) body.avatarFileId = fileIdFromUrl(d.avatar);
    if (d.banner !== before.banner) body.bannerFileId = fileIdFromUrl(d.banner);
    if (d.pronouns !== before.pronouns) body.pronouns = d.pronouns;
    if (d.bio !== before.bio) body.bio = d.bio;
    if (JSON.stringify(d.links) !== JSON.stringify(before.links)) body.links = d.links.filter((l) => l.label.trim() || l.url.trim());
    if (JSON.stringify(themeOf(d)) !== JSON.stringify(themeOf(before))) body.theme = themeOf(d);
    if (JSON.stringify(d.widgets) !== JSON.stringify(before.widgets)) body.widgets = d.widgets.map(widgetInput);
    if (d.guestbookEnabled !== before.guestbookEnabled) body.guestbookEnabled = d.guestbookEnabled;
    if (JSON.stringify(d.song) !== JSON.stringify(before.song)) {
      const s = d.song;
      if (s.kind === 'none') body.song = null;
      else if (s.kind === 'upload') body.song = { kind: 'upload', fileId: fileIdFromUrl(s.url), title: s.title.trim() || 'Profile song' };
      else {
        if (!youtubeId(s.url)) return void (error = "That doesn't look like a YouTube link");
        body.song = { kind: 'youtube', url: s.url.trim(), title: s.title.trim() || 'Profile song' };
      }
    }
    saving = true;
    error = '';
    try {
      const res = await patch<SelfUser & { profile: UserProfile }>('/users/@me/profile', body);
      const { profile, ...self } = res;
      app.me = { ...app.me!, ...self };
      app.invalidateProfile(self.id);
      app.profiles.set(`${self.id}:`, profile);
      base = profile;
      draft = fromProfile(profile);
      original = JSON.stringify(draft);
      app.toast('Profile saved', 'success');
    } catch (e) {
      error = errorMessage(e);
    } finally {
      saving = false;
    }
  }

  function reset() {
    if (!base) return;
    draft = fromProfile(base);
    error = '';
  }

  // profile song upload
  let songBusy = $state(false);
  function pickSong() {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'audio/*';
    i.onchange = async () => {
      const f = i.files?.[0];
      if (!f || !draft) return;
      songBusy = true;
      try {
        const up = await upload('profile_song', f).promise;
        draft.song = { kind: 'upload', url: up.url, title: f.name.replace(/\.[^.]+$/, '').slice(0, 100), durationMs: up.durationMs ?? undefined };
      } catch (e) {
        app.toast(errorMessage(e), 'error');
      } finally {
        songBusy = false;
      }
    };
    i.click();
  }

  const GRADIENTS: [string, string][] = [
    ['#ff6a88', '#ff99ac'],
    ['#7f5af0', '#2cb67d'],
    ['#00c6ff', '#0072ff'],
    ['#f7971e', '#ffd200'],
    ['#11998e', '#38ef7d'],
    ['#232526', '#414345'],
    ['#ee0979', '#ff6a00'],
    ['#8e2de2', '#4a00e0'],
  ];
</script>

<h2>Profile</h2>
<p class="muted">Everything here is free — animated avatars, video banners, themes, widgets, songs. Changes show in the preview before you save.</p>
{#if loadError}<p class="error-text">{loadError}</p>{/if}

{#if draft && preview}
  <div class="layout">
    <div class="form">
      <div class="pics">
        <div class="field">
          <span class="label">Avatar</span>
          <ImagePicker
            purpose="avatar"
            current={draft.avatar}
            round
            label="Avatar (GIFs welcome)"
            onchange={(f) => draft && (draft.avatar = f?.url ?? null)}
          />
          {#if draft.avatar}<button class="btn small ghost" type="button" onclick={() => draft && (draft.avatar = null)}>Remove</button>{/if}
        </div>
        <div class="field" style="flex:1;min-width:0">
          <span class="label">Banner</span>
          <ImagePicker
            purpose="banner"
            current={draft.banner}
            label="Banner"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/mp4,video/webm"
            width={280}
            height={100}
            onchange={(f) => draft && ((draft.banner = f?.url ?? null), (draft.bannerKind = f ? (f.contentType.startsWith('video/') ? 'video' : 'image') : null))}
          />
          <span class="hint">Image, GIF, or MP4/WebM up to {Limits.BANNER_VIDEO_SECONDS}s (videos play muted).</span>
          {#if draft.banner}<button class="btn small ghost" type="button" onclick={() => draft && ((draft.banner = null), (draft.bannerKind = null))}>Remove banner</button>{/if}
        </div>
      </div>

      <div class="row two">
        <div class="field">
          <label for="dn">Display name</label>
          <input id="dn" class="input" bind:value={draft.displayName} maxlength={Limits.DISPLAY_NAME_MAX} placeholder={app.me?.username} />
        </div>
        <div class="field">
          <label for="pn">Pronouns</label>
          <input id="pn" class="input" bind:value={draft.pronouns} maxlength={Limits.PRONOUNS_MAX} placeholder="they/them" />
        </div>
      </div>

      <div class="field">
        <label for="bio">About me <span class="faint">({draft.bio.length}/{Limits.BIO_MAX})</span></label>
        <textarea id="bio" class="textarea" rows="5" bind:value={draft.bio} maxlength={Limits.BIO_MAX} placeholder="Markdown works: **bold**, *italic*, `code`, ||spoilers||, links"></textarea>
      </div>

      <div class="field">
        <span class="label">Links ({draft.links.length}/{Limits.PROFILE_LINKS_MAX})</span>
        {#each draft.links as l, i (i)}
          <div class="row link">
            <input class="input lbl" placeholder="Label" bind:value={l.label} maxlength="32" />
            <input class="input" placeholder="https://…" bind:value={l.url} maxlength="2048" type="url" />
            <button class="icon-btn" type="button" title="Remove" onclick={() => draft && (draft.links = draft.links.filter((_, j) => j !== i))}><Icon name="x" size={15} /></button>
          </div>
        {/each}
        {#if draft.links.length < Limits.PROFILE_LINKS_MAX}
          <button class="btn small ghost" type="button" onclick={() => draft && (draft.links = [...draft.links, { label: '', url: '' }])}><Icon name="plus" size={14} /> Add link</button>
        {/if}
        <span class="hint">Only http(s) links. Clicking one asks before leaving the app.</span>
      </div>

      <h3>Profile theme</h3>
      <label class="srow">
        <span class="txt"><strong>Custom background</strong><small>A colour or gradient behind your profile</small></span>
        <input type="checkbox" class="switch" bind:checked={draft.customColors} />
      </label>
      {#if draft.customColors}
        <div class="presets">
          {#each GRADIENTS as [a, b] (a + b)}
            <button
              type="button"
              class="gp"
              style="background:linear-gradient(135deg,{a},{b})"
              aria-label="Gradient {a} to {b}"
              onclick={() => draft && ((draft.primary = a), (draft.secondary = b))}
            ></button>
          {/each}
        </div>
        <div class="row colors">
          <label class="cl">Top <input type="color" bind:value={draft.primary} /></label>
          <label class="cl">Bottom <input type="color" bind:value={draft.secondary} /></label>
          <label class="cl grow">Angle <input type="range" min="0" max="360" bind:value={draft.angle} /> {draft.angle}°</label>
        </div>
      {/if}
      <label class="srow">
        <span class="txt"><strong>Accent colour</strong><small>Buttons and highlights on your profile</small></span>
        {#if draft.useAccent}<input type="color" bind:value={draft.accent} />{/if}
        <input type="checkbox" class="switch" bind:checked={draft.useAccent} />
      </label>
      <div class="field" style="margin-top:10px">
        <label for="font">Name font</label>
        <select id="font" class="select" bind:value={draft.font}>
          {#each PROFILE_FONTS as f (f)}<option value={f}>{PROFILE_FONT_LABELS[f]}</option>{/each}
        </select>
      </div>

      <h3>Widgets</h3>
      <p class="faint small">Drag to reorder.</p>
      <WidgetEditor bind:widgets={draft.widgets} />

      <h3>Profile song</h3>
      <p class="faint small">Never autoplays for visitors unless they turned that on themselves, and there's always a mute button.</p>
      <div class="seg">
        <button type="button" class:on={draft.song.kind === 'none'} onclick={() => draft && (draft.song = { kind: 'none' })}>None</button>
        <button type="button" class:on={draft.song.kind === 'upload'} onclick={pickSong} disabled={songBusy}>{songBusy ? 'Uploading…' : draft.song.kind === 'upload' ? 'Replace clip' : 'Upload a clip'}</button>
        <button type="button" class:on={draft.song.kind === 'youtube'} onclick={() => draft && draft.song.kind !== 'youtube' && (draft.song = { kind: 'youtube', url: '', title: '' })}>YouTube link</button>
      </div>
      {#if draft.song.kind === 'upload'}
        <div class="field">
          <label for="st">Title shown on your profile</label>
          <input id="st" class="input" bind:value={draft.song.title} maxlength="100" />
          <span class="hint">Clips can be up to {Limits.PROFILE_SONG_SECONDS} seconds.</span>
        </div>
      {:else if draft.song.kind === 'youtube'}
        <div class="field">
          <label for="yu">YouTube link</label>
          <input id="yu" class="input" bind:value={draft.song.url} placeholder="https://youtu.be/…?t=42" maxlength="300" />
          <span class="hint">Add ?t=SECONDS to start at a specific part. Plays through youtube-nocookie, and only after the visitor hits play.</span>
        </div>
        <div class="field">
          <label for="yt">Title</label>
          <input id="yt" class="input" bind:value={draft.song.title} maxlength="100" placeholder="Artist – Song" />
        </div>
      {/if}

      <h3>Guestbook</h3>
      <label class="srow">
        <span class="txt"><strong>Let friends sign my guestbook</strong><small>Only friends can post. You can delete any entry.</small></span>
        <input type="checkbox" class="switch" bind:checked={draft.guestbookEnabled} />
      </label>

      {#if error}<p class="error-text">{error}</p>{/if}
      {#if dirty}
        <div class="savebar fade-in">
          <span>Unsaved changes</span>
          <span class="spacer"></span>
          <button class="btn ghost" type="button" onclick={reset}>Reset</button>
          <button class="btn primary" type="button" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
        </div>
      {/if}
    </div>

    <aside class="preview">
      <div class="label">Preview</div>
      {#key preview.song ? JSON.stringify(preview.song) : ''}
        <ProfileCard userId={preview.id} {preview} />
      {/key}
    </aside>
  </div>
{:else if !loadError}
  <p class="faint">Loading…</p>
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
    position: sticky;
    top: 0;
  }
  .pics {
    display: flex;
    gap: 20px;
    flex-wrap: wrap;
  }
  .two {
    gap: 12px;
  }
  .two .field {
    flex: 1;
  }
  .link {
    gap: 6px;
    margin-bottom: 6px;
  }
  .link .input {
    flex: 1;
    min-width: 0;
  }
  .link .lbl {
    flex: 0 0 130px;
  }
  .presets {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 10px 0;
  }
  .gp {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    border: 2px solid var(--border);
    cursor: pointer;
  }
  .colors {
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 6px;
  }
  .cl {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .cl.grow {
    flex: 1;
  }
  input[type='color'] {
    width: 36px;
    height: 28px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  .seg button {
    padding: 7px 14px;
    border: none;
    background: var(--bg-1);
    cursor: pointer;
    color: var(--text-muted);
  }
  .seg button.on {
    background: var(--accent);
    color: var(--accent-text);
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
    z-index: 3;
  }
  @media (max-width: 1100px) {
    .layout {
      flex-direction: column-reverse;
    }
    .preview {
      position: static;
      width: 100%;
      max-width: 360px;
    }
  }
</style>
