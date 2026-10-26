<script lang="ts">
  import { formatBytes, type Attachment } from '@haunt/shared';
  import { ui } from '$lib/state/ui.svelte';
  import Icon from '../Icon.svelte';

  let { attachments }: { attachments: Attachment[] } = $props();
  const images = $derived(attachments.filter((a) => a.contentType.startsWith('image/')));
  const others = $derived(attachments.filter((a) => !a.contentType.startsWith('image/')));
  let revealed = $state<Record<string, boolean>>({});

  function size(a: Attachment, max = 400) {
    if (!a.width || !a.height) return { w: undefined, h: undefined };
    const scale = Math.min(1, max / a.width, (max * 0.85) / a.height);
    return { w: Math.round(a.width * scale), h: Math.round(a.height * scale) };
  }
</script>

{#if images.length}
  <div class="grid" class:multi={images.length > 1}>
    {#each images as a (a.id)}
      {@const s = size(a, images.length > 1 ? 260 : 400)}
      <button
        class="img"
        class:spoiler={a.spoiler && !revealed[a.id]}
        onclick={() => (a.spoiler && !revealed[a.id] ? (revealed = { ...revealed, [a.id]: true }) : (ui.lightbox = { src: a.url, alt: a.description ?? a.filename, download: a.url }))}
      >
        <img src={a.url} alt={a.description ?? a.filename} width={s.w} height={s.h} loading="lazy" decoding="async" />
        {#if a.spoiler && !revealed[a.id]}<span class="spoiler-label">SPOILER</span>{/if}
      </button>
    {/each}
  </div>
{/if}

{#each others as a (a.id)}
  {#if a.contentType.startsWith('video/')}
    <div class="media" class:spoiler={a.spoiler && !revealed[a.id]}>
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={a.url} controls preload="metadata" playsinline style="max-width:min(480px,100%);max-height:360px"></video>
      {#if a.spoiler && !revealed[a.id]}<button class="spoiler-label cover" onclick={() => (revealed = { ...revealed, [a.id]: true })}>SPOILER</button>{/if}
    </div>
  {:else if a.contentType.startsWith('audio/')}
    <div class="file">
      <Icon name="music" size={28} />
      <div class="meta">
        <a href={a.url} download class="truncate">{a.filename}</a>
        <audio src={a.url} controls preload="none"></audio>
      </div>
    </div>
  {:else}
    <div class="file">
      <Icon name="file" size={30} />
      <div class="meta">
        <a href={a.url} download={a.filename} class="truncate" rel="noopener">{a.filename}</a>
        <span class="faint">{formatBytes(a.size)}</span>
      </div>
      <a class="icon-btn" href={a.url} download={a.filename} title="Download"><Icon name="download" size={18} /></a>
    </div>
  {/if}
{/each}

<style>
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
    max-width: 540px;
  }
  .img {
    position: relative;
    padding: 0;
    border: none;
    background: var(--bg-1);
    border-radius: 6px;
    overflow: hidden;
    cursor: zoom-in;
    max-width: 100%;
  }
  .img img {
    display: block;
    max-width: 100%;
    height: auto;
    max-height: 340px;
    object-fit: cover;
  }
  .multi .img img {
    max-height: 200px;
  }
  .spoiler img,
  .spoiler video {
    filter: blur(28px);
  }
  .spoiler-label {
    position: absolute;
    inset: 0;
    margin: auto;
    width: fit-content;
    height: fit-content;
    background: rgb(0 0 0 / 0.65);
    color: #fff;
    font-weight: 800;
    font-size: 0.8rem;
    padding: 6px 12px;
    border-radius: 99px;
    border: none;
    cursor: pointer;
  }
  .media {
    position: relative;
    margin-top: 4px;
    width: fit-content;
    border-radius: 6px;
    overflow: hidden;
  }
  .media video {
    display: block;
    background: #000;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 4px;
    padding: 10px 12px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    max-width: 440px;
    color: var(--text-muted);
  }
  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.88rem;
  }
  .meta audio {
    width: 100%;
    height: 32px;
    margin-top: 4px;
  }
</style>
