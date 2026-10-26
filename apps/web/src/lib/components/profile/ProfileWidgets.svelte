<script lang="ts">
  import { proxiedImage, type ProfileWidget } from '@haunt/shared';
  import { ui } from '$lib/state/ui.svelte';
  import Markdown from '../Markdown.svelte';
  import Icon from '../Icon.svelte';

  let { widgets }: { widgets: ProfileWidget[] } = $props();
</script>

{#each widgets as w (w.id)}
  <section class="widget">
    <h4>{w.title || { games: 'Favourite games', songs: 'Top songs', currently_into: 'Currently into', photos: 'Photos', text: '' }[w.type]}</h4>
    {#if w.type === 'games'}
      <div class="covers">
        {#each w.items as g, i (i)}
          <div class="cover" title={g.name}>
            {#if g.cover}<img src={proxiedImage(g.cover, 256)} alt={g.name} loading="lazy" />{:else}<span class="nc"><Icon name="gamepad" /></span>{/if}
            <span class="cap truncate">{g.name}</span>
          </div>
        {/each}
      </div>
    {:else if w.type === 'songs'}
      <ol class="songs">
        {#each w.items as s, i (i)}
          <li>
            {#if s.cover}<img src={proxiedImage(s.cover, 128)} alt="" loading="lazy" />{:else}<span class="nc sm"><Icon name="music" size={16} /></span>{/if}
            <span class="col" style="gap:0;min-width:0"><strong class="truncate">{s.title}</strong><span class="faint truncate">{s.artist}</span></span>
          </li>
        {/each}
      </ol>
    {:else if w.type === 'currently_into'}
      <div class="chips">
        {#each w.items as c, i (i)}<span class="chip">{c.emoji ?? ''} {c.label}</span>{/each}
      </div>
    {:else if w.type === 'photos'}
      <div class="photos">
        {#each w.items as p, i (i)}
          <button class="photo" onclick={() => (ui.lightbox = { src: p.url, alt: p.caption ?? '' })} title={p.caption ?? ''}>
            <img src={p.url} alt={p.caption ?? ''} loading="lazy" />
          </button>
        {/each}
      </div>
    {:else if w.type === 'text'}
      <Markdown content={w.content} mentions={false} jumboAllowed={false} />
    {/if}
  </section>
{/each}

<style>
  .widget {
    margin-top: 12px;
  }
  h4 {
    margin: 0 0 6px;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.75;
  }
  .covers {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .cover {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .cover img,
  .nc {
    width: 100%;
    aspect-ratio: 3 / 4;
    object-fit: cover;
    border-radius: 6px;
    background: rgb(0 0 0 / 0.2);
    display: grid;
    place-items: center;
  }
  .cap {
    font-size: 0.72rem;
  }
  .songs {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .songs li {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
  }
  .songs img,
  .nc.sm {
    width: 34px;
    height: 34px;
    aspect-ratio: auto;
    border-radius: 4px;
    object-fit: cover;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .chip {
    padding: 3px 9px;
    border-radius: 99px;
    background: rgb(127 127 127 / 0.2);
    font-size: 0.82rem;
  }
  .photos {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }
  .photo {
    padding: 0;
    border: none;
    background: none;
    cursor: zoom-in;
  }
  .photo img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 6px;
    display: block;
  }
</style>
