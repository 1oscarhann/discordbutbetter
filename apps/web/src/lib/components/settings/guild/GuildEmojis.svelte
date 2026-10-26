<script lang="ts">
  import { formatBytes, type CustomEmoji } from '@haunt/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, patch, post, upload } from '$lib/api';
  import Icon from '../../Icon.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);
  const limits = $derived(app.instance?.limits);

  let busy = $state(false);
  let error = $state('');
  let emojiInput: HTMLInputElement;
  let stickerInput: HTMLInputElement;

  function nameFrom(filename: string): string {
    const base = filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 32);
    return base.length >= 2 ? base : `emoji_${Math.floor(Math.random() * 1000)}`;
  }

  async function addEmojis(e: Event) {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    (e.target as HTMLInputElement).value = '';
    if (!files.length) return;
    busy = true;
    error = '';
    for (const f of files) {
      try {
        if (limits && f.size > limits.emojiBytes) throw new Error(`${f.name} is over ${formatBytes(limits.emojiBytes)}`);
        const up = await upload('emoji', f).promise;
        await post(`/guilds/${gid}/emojis`, { name: nameFrom(f.name), fileId: up.id });
      } catch (err) {
        error = errorMessage(err);
        break;
      }
    }
    busy = false;
  }

  let renaming = $state<string | null>(null);
  let newName = $state('');
  async function rename(em: CustomEmoji) {
    if (newName === em.name) return void (renaming = null);
    try {
      await patch(`/guilds/${gid}/emojis/${em.id}`, { name: newName });
      renaming = null;
    } catch (err) {
      app.toast(errorMessage(err), 'error');
    }
  }

  // stickers
  let stickerFile = $state<File | null>(null);
  let stickerName = $state('');
  let stickerDesc = $state('');
  let stickerPreview = $state<string | null>(null);
  function pickSticker(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    stickerFile = f;
    stickerName = f.name.replace(/\.[^.]+$/, '').slice(0, 30);
    if (stickerPreview) URL.revokeObjectURL(stickerPreview);
    stickerPreview = URL.createObjectURL(f);
  }
  async function addSticker(e: Event) {
    e.preventDefault();
    if (!stickerFile) return;
    busy = true;
    error = '';
    try {
      const up = await upload('sticker', stickerFile).promise;
      await post(`/guilds/${gid}/stickers`, { name: stickerName, description: stickerDesc, fileId: up.id });
      stickerFile = null;
      stickerName = stickerDesc = '';
      if (stickerPreview) URL.revokeObjectURL(stickerPreview);
      stickerPreview = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<h2>Emoji</h2>
<p class="muted">
  Custom emoji for this server — animated ones too, free. Members can also use them in other servers that allow external emoji. {g.emojis.length}/{limits?.emojisPerGuild ?? '?'} used,
  up to {limits ? formatBytes(limits.emojiBytes) : '?'} each.
</p>
<input bind:this={emojiInput} type="file" accept="image/png,image/gif,image/webp,image/jpeg,image/avif" multiple hidden onchange={addEmojis} />
<button class="btn primary" disabled={busy || (!!limits && g.emojis.length >= limits.emojisPerGuild)} onclick={() => emojiInput.click()}>
  <Icon name="upload" size={15} /> {busy ? 'Uploading…' : 'Upload emoji'}
</button>
{#if error}<p class="error-text">{error}</p>{/if}

<div class="grid">
  {#each g.emojis as em (em.id)}
    <div class="em">
      <img src={em.url} alt={em.name} width="32" height="32" />
      {#if renaming === em.id}
        <input
          class="input small"
          bind:value={newName}
          maxlength="32"
          onkeydown={(e) => {
            if (e.key === 'Enter') void rename(em);
            if (e.key === 'Escape') renaming = null;
          }}
          onblur={() => rename(em)}
        />
      {:else}
        <button class="nm truncate" title="Rename" onclick={() => ((renaming = em.id), (newName = em.name))}>:{em.name}:</button>
      {/if}
      {#if em.animated}<span class="pill">GIF</span>{/if}
      <button class="icon-btn" title="Delete" onclick={() => ui.confirm(`Delete :${em.name}:?`, 'Messages that used it will show the name instead.', 'Delete', () => del(`/guilds/${gid}/emojis/${em.id}`))}>
        <Icon name="trash" size={14} />
      </button>
    </div>
  {:else}
    <p class="faint">No custom emoji yet.</p>
  {/each}
</div>

<h3>Stickers ({g.stickers.length}/{limits?.stickersPerGuild ?? '?'})</h3>
<form class="sform" onsubmit={addSticker}>
  <input bind:this={stickerInput} type="file" accept="image/png,image/apng,image/gif,image/webp" hidden onchange={pickSticker} />
  <button type="button" class="drop" onclick={() => stickerInput.click()}>
    {#if stickerPreview}<img src={stickerPreview} alt="" />{:else}<Icon name="sticker" size={28} /><span class="small faint">PNG, APNG, GIF, WebP</span>{/if}
  </button>
  <div class="col" style="flex:1">
    <input class="input" placeholder="Sticker name" bind:value={stickerName} maxlength="30" required />
    <input class="input" placeholder="Description (for screen readers)" bind:value={stickerDesc} maxlength="100" />
    <button class="btn primary" disabled={busy || !stickerFile || stickerName.trim().length < 2}>Add sticker</button>
  </div>
</form>
<div class="sgrid">
  {#each g.stickers as s (s.id)}
    <div class="st">
      <img src={s.url} alt={s.description || s.name} />
      <span class="truncate small">{s.name}</span>
      <button class="icon-btn del" title="Delete" onclick={() => ui.confirm(`Delete sticker ${s.name}?`, '', 'Delete', () => del(`/guilds/${gid}/stickers/${s.id}`))}><Icon name="trash" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 6px;
    margin-top: 14px;
  }
  .em {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 8px;
    background: var(--bg-1);
  }
  .em img {
    object-fit: contain;
  }
  .nm {
    flex: 1;
    min-width: 0;
    text-align: left;
    border: none;
    background: none;
    cursor: text;
    font-family: var(--font-mono, monospace);
    font-size: 0.85rem;
  }
  .em .input {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
  }
  .sform {
    display: flex;
    gap: 14px;
    align-items: stretch;
  }
  .sform .col {
    gap: 8px;
  }
  .drop {
    width: 130px;
    height: 130px;
    border: 2px dashed var(--border);
    border-radius: 10px;
    background: var(--bg-1);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    cursor: pointer;
    color: var(--text-muted);
  }
  .drop img {
    max-width: 110px;
    max-height: 110px;
    object-fit: contain;
  }
  .sgrid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
    margin-top: 14px;
  }
  .st {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px;
    border-radius: 8px;
    background: var(--bg-1);
  }
  .st img {
    width: 96px;
    height: 96px;
    object-fit: contain;
  }
  .st .del {
    position: absolute;
    top: 4px;
    right: 4px;
  }
</style>
