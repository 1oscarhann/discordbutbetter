<script lang="ts" module>
  export interface PickedEmoji {
    /** Text to insert into a message. */
    text: string;
    /** Reaction key: unicode emoji, or c:<id>. */
    reactionKey: string;
    name: string;
  }

  type EmojiGroup = [string, [string, string, number][]];
  let cache: EmojiGroup[] | null = null;
  export async function loadEmojiData(): Promise<EmojiGroup[]> {
    cache ??= (await import('$lib/emoji-data.json')).default as unknown as EmojiGroup[];
    return cache;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { app } from '$lib/state/app.svelte';
  import { Permissions as P, type CustomEmoji } from '@haunt/shared';

  let { guildId = null, onpick }: { guildId?: string | null; onpick: (e: PickedEmoji) => void } = $props();

  let groups = $state<EmojiGroup[]>([]);
  let q = $state('');
  let input: HTMLInputElement;
  let tone = $state(Number(localStorageGet('skinTone') ?? 0));
  const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];

  function localStorageGet(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  }

  onMount(async () => {
    groups = await loadEmojiData();
    input?.focus();
  });

  // custom emoji: this server's, plus other servers' if allowed here
  const customGroups = $derived.by(() => {
    const out: { name: string; emojis: CustomEmoji[] }[] = [];
    const ext = !guildId || app.can(P.USE_EXTERNAL_EMOJIS, guildId);
    for (const g of app.guilds.values()) {
      if (!g.emojis.length) continue;
      if (g.guild.id !== guildId && !ext) continue;
      out.push({ name: g.guild.name, emojis: g.emojis });
    }
    out.sort((a, b) => (a.name === app.guilds.get(guildId ?? '')?.guild.name ? -1 : b.name === app.guilds.get(guildId ?? '')?.guild.name ? 1 : 0));
    return out;
  });

  const recent = $derived.by(() => {
    try {
      return (JSON.parse(localStorageGet('recentEmoji') ?? '[]') as string[]).slice(0, 16);
    } catch {
      return [];
    }
  });

  function withTone(e: string, supports: number): string {
    if (!supports || !tone) return e;
    // insert the modifier after the first code point
    const [first, ...rest] = [...e];
    return first + TONES[tone] + rest.join('');
  }

  function pickUnicode(e: string, slug: string, supports: number) {
    const v = withTone(e, supports);
    onpick({ text: v, reactionKey: v, name: slug });
  }

  function pickCustom(e: CustomEmoji) {
    onpick({ text: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`, reactionKey: `c:${e.id}`, name: e.name });
  }

  function customById(key: string): CustomEmoji | null {
    const id = key.slice(2);
    for (const g of app.guilds.values()) {
      const e = g.emojis.find((x) => x.id === id);
      if (e) return e;
    }
    return null;
  }

  const ql = $derived(q.trim().toLowerCase().replace(/^:|:$/g, ''));
  const results = $derived.by(() => {
    if (!ql) return null;
    const uni = groups.flatMap(([, list]) => list.filter(([, slug]) => slug.includes(ql))).slice(0, 80);
    const cus = customGroups.flatMap((g) => g.emojis.filter((e) => e.name.toLowerCase().includes(ql))).slice(0, 40);
    return { uni, cus };
  });

  function setTone(t: number) {
    tone = t;
    try {
      localStorage.setItem('skinTone', String(t));
    } catch {
      /* ignore */
    }
  }
</script>

<div class="picker menu">
  <div class="top">
    <input class="input" bind:this={input} bind:value={q} placeholder="Search emoji" />
    <select class="tone" value={tone} onchange={(e) => setTone(Number((e.target as HTMLSelectElement).value))} title="Skin tone">
      {#each TONES as t, i (i)}<option value={i}>{'👋' + t}</option>{/each}
    </select>
  </div>
  <div class="scroll body">
    {#if results}
      <div class="grid">
        {#each results.cus as e (e.id)}
          <button class="e" title=":{e.name}:" onclick={() => pickCustom(e)}><img src={e.url} alt=":{e.name}:" loading="lazy" /></button>
        {/each}
        {#each results.uni as [e, slug, s] (e)}
          <button class="e" title=":{slug}:" onclick={() => pickUnicode(e, slug, s)}>{withTone(e, s)}</button>
        {/each}
      </div>
      {#if !results.uni.length && !results.cus.length}<p class="faint">No emoji found.</p>{/if}
    {:else}
      {#if recent.length}
        <div class="gname">Recent</div>
        <div class="grid">
          {#each recent as key (key)}
            {#if key.startsWith('c:')}
              {@const ce = customById(key)}
              {#if ce}<button class="e" title=":{ce.name}:" onclick={() => pickCustom(ce)}><img src={ce.url} alt=":{ce.name}:" /></button>{/if}
            {:else}
              <button class="e" onclick={() => onpick({ text: key, reactionKey: key, name: key })}>{key}</button>
            {/if}
          {/each}
        </div>
      {/if}
      {#each customGroups as g (g.name)}
        <div class="gname">{g.name}</div>
        <div class="grid">
          {#each g.emojis as e (e.id)}
            <button class="e" title=":{e.name}:" onclick={() => pickCustom(e)}><img src={e.url} alt=":{e.name}:" loading="lazy" /></button>
          {/each}
        </div>
      {/each}
      {#each groups as [name, list] (name)}
        <div class="gname">{name}</div>
        <div class="grid">
          {#each list as [e, slug, s] (e)}
            <button class="e" title=":{slug}:" onclick={() => pickUnicode(e, slug, s)}>{e}</button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .picker {
    width: 352px;
    height: 400px;
    display: flex;
    flex-direction: column;
    padding: 8px;
  }
  .top {
    display: flex;
    gap: 6px;
    margin-bottom: 6px;
  }
  .tone {
    width: 54px;
    background: var(--bg-0);
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .body {
    flex: 1;
    min-height: 0;
  }
  .gname {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 8px 2px 4px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 2px;
  }
  .e {
    aspect-ratio: 1;
    display: grid;
    place-items: center;
    font-size: 1.45rem;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    padding: 2px;
  }
  .e:hover {
    background: var(--hover);
  }
  .e img {
    width: 30px;
    height: 30px;
    object-fit: contain;
  }
</style>
