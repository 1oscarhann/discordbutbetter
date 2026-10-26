<script lang="ts">
  import type { Embed } from '@haunt/shared';
  import { ui } from '$lib/state/ui.svelte';
  import Icon from '../Icon.svelte';

  let { embed }: { embed: Embed } = $props();
  // YouTube only loads (and only sees the viewer) after an explicit click
  let playing = $state(false);
</script>

{#if embed.type === 'image' && embed.image}
  <button class="imgonly" onclick={() => { ui.lightbox = { src: embed.image!.url, alt: embed.url }; }}>
    <img src={embed.image.url} alt="" loading="lazy" />
  </button>
{:else}
  <div class="embed" style:border-left-color={embed.color ?? 'var(--bg-3)'}>
    <div class="text">
      {#if embed.siteName}<div class="site faint">{embed.siteName}</div>{/if}
      {#if embed.title}
        <a class="title" href={embed.url} target="_blank" rel="noopener noreferrer nofollow">{embed.title}</a>
      {/if}
      {#if embed.description && embed.type !== 'youtube'}<p class="desc">{embed.description}</p>{/if}
      {#if embed.type === 'youtube' && embed.youtubeId}
        <div class="yt">
          {#if playing}
            <iframe
              src="https://www.youtube-nocookie.com/embed/{embed.youtubeId}?autoplay=1&rel=0"
              title={embed.title ?? 'YouTube video'}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              referrerpolicy="strict-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            ></iframe>
          {:else}
            <button class="play" onclick={() => (playing = true)} title="Play (loads from youtube-nocookie.com)">
              {#if embed.thumbnail}<img src={embed.thumbnail.url} alt="" loading="lazy" />{/if}
              <span class="pbtn"><Icon name="play" size={26} /></span>
            </button>
            <div class="faint note">Nothing loads from YouTube until you press play.</div>
          {/if}
        </div>
      {:else if embed.image}
        <button class="big" onclick={() => { ui.lightbox = { src: embed.image!.url, alt: embed.title ?? '' }; }}>
          <img src={embed.image.url} alt="" loading="lazy" />
        </button>
      {/if}
    </div>
    {#if embed.thumbnail && embed.type === 'link'}
      <img class="thumb" src={embed.thumbnail.url} alt="" loading="lazy" />
    {/if}
  </div>
{/if}

<style>
  .embed {
    display: flex;
    gap: 12px;
    max-width: 520px;
    margin-top: 6px;
    padding: 10px 12px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    border-left: 4px solid;
    border-radius: 6px;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .site {
    font-size: 0.75rem;
    margin-bottom: 2px;
  }
  .title {
    font-weight: 700;
    display: block;
    margin-bottom: 4px;
  }
  .desc {
    margin: 0;
    font-size: 0.87rem;
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .thumb {
    width: 80px;
    height: 80px;
    object-fit: cover;
    border-radius: 6px;
    flex: none;
  }
  .big,
  .play,
  .imgonly {
    display: block;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    margin-top: 8px;
    position: relative;
  }
  .big img,
  .imgonly img {
    max-width: 100%;
    max-height: 300px;
    border-radius: 6px;
    display: block;
  }
  .imgonly img {
    max-width: min(400px, 100%);
  }
  .yt {
    margin-top: 8px;
  }
  .yt iframe {
    width: min(480px, 100%);
    aspect-ratio: 16 / 9;
    border: none;
    border-radius: 6px;
  }
  .play img {
    width: min(480px, 100%);
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 6px;
    display: block;
  }
  .pbtn {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 56px;
    height: 56px;
    border-radius: 50%;
    background: rgb(0 0 0 / 0.65);
    color: #fff;
    display: grid;
    place-items: center;
  }
  .note {
    font-size: 0.72rem;
    margin-top: 4px;
  }
</style>
