<script lang="ts">
  import { parseMarkdown, isEmojiOnly, type MdNode } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { formatTimestamp, fullDate } from '$lib/util/time';
  import { goto } from '$app/navigation';

  let {
    content,
    guildId = null,
    blocks = true,
    mentions = true,
    jumboAllowed = true,
  }: { content: string; guildId?: string | null; blocks?: boolean; mentions?: boolean; jumboAllowed?: boolean } = $props();

  const nodes = $derived(parseMarkdown(content, { blocks, mentions }));
  const jumbo = $derived(jumboAllowed && isEmojiOnly(nodes));

  function emojiSrc(id: string): string {
    for (const g of app.guilds.values()) {
      const e = g.emojis.find((x) => x.id === id);
      if (e) return e.url;
    }
    return `/api/emojis/${id}`;
  }

  function channelName(id: string): string {
    const c = app.channel(id);
    return c?.name ?? 'unknown-channel';
  }

  function roleOf(id: string) {
    if (!guildId) return null;
    return app.guilds.get(guildId)?.roles.get(id) ?? null;
  }

  function openLink(e: MouseEvent, href: string, masked: boolean) {
    if (!masked) return; // plain links show the real url already
    e.preventDefault();
    ui.confirmLink = href;
  }

  function openUser(e: MouseEvent, id: string) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.profile = { userId: id, guildId, x: r.right + 8, y: r.top };
  }

  function revealSpoiler(e: Event) {
    (e.currentTarget as HTMLElement).classList.add('revealed');
  }
</script>

{#snippet render(list: MdNode[])}
  {#each list as n, i (i)}
    {#if n.t === 'text'}{n.v}{:else if n.t === 'br'}<br />{:else if n.t === 'b'}<strong>{@render render(n.c)}</strong>{:else if n.t === 'i'}<em
        >{@render render(n.c)}</em
      >{:else if n.t === 'u'}<u>{@render render(n.c)}</u>{:else if n.t === 's'}<s>{@render render(n.c)}</s>{:else if n.t === 'spoiler'}<span
        class="spoiler"
        role="button"
        tabindex="0"
        onclick={revealSpoiler}
        onkeydown={(e) => e.key === 'Enter' && revealSpoiler(e)}>{@render render(n.c)}</span
      >{:else if n.t === 'code'}<code>{n.v}</code>{:else if n.t === 'codeblock'}<pre><code data-lang={n.lang}>{n.v}</code></pre>{:else if n.t === 'quote'}<blockquote>
        {@render render(n.c)}
      </blockquote>{:else if n.t === 'h'}{#if n.level === 1}<h1>{@render render(n.c)}</h1>{:else if n.level === 2}<h2>{@render render(n.c)}</h2>{:else}<h3>
          {@render render(n.c)}
        </h3>{/if}{:else if n.t === 'sub'}<div class="sub">{@render render(n.c)}</div>{:else if n.t === 'list'}{#if n.ordered}<ol start={n.start}>
          {#each n.items as item, j (j)}<li>{@render render(item)}</li>{/each}
        </ol>{:else}<ul>
          {#each n.items as item, j (j)}<li>{@render render(item)}</li>{/each}
        </ul>{/if}{:else if n.t === 'link'}<a
        href={n.href}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
        title={n.masked ? n.href : undefined}
        onclick={(e) => openLink(e, n.href, n.masked)}>{@render render(n.c)}</a
      >{:else if n.t === 'user'}<button class="mention" onclick={(e) => openUser(e, n.id)}>@{app.displayName(n.id, guildId)}</button>{:else if n.t ===
      'role'}{@const r = roleOf(n.id)}<span
        class="mention"
        style={r?.color ? `color:#${r.color.toString(16).padStart(6, '0')};background:#${r.color.toString(16).padStart(6, '0')}22` : ''}
        >@{r?.name ?? 'deleted-role'}</span
      >{:else if n.t === 'channel'}{@const c = app.channel(n.id)}<a
        class="mention"
        href={c ? (c.guildId ? `/app/${c.guildId}/${c.id}` : `/app/me/${c.id}`) : undefined}
        onclick={(e) => {
          e.preventDefault();
          if (c) goto(c.guildId ? `/app/${c.guildId}/${c.id}` : `/app/me/${c.id}`);
        }}>#{channelName(n.id)}</a
      >{:else if n.t === 'everyone'}<span class="mention">@everyone</span>{:else if n.t === 'here'}<span class="mention">@here</span>{:else if n.t ===
      'emoji'}<img class="emoji" src={emojiSrc(n.id)} alt=":{n.name}:" title=":{n.name}:" loading="lazy" draggable="false" />{:else if n.t ===
      'time'}<time class="ts" title={fullDate(new Date(n.ts * 1000).toISOString())}>{formatTimestamp(n.ts, n.style, app.settings.use24h)}</time>{/if}
  {/each}
{/snippet}

<div class="md" class:jumbo>{@render render(nodes)}</div>

<style>
  .jumbo {
    font-size: 2.4em;
    line-height: 1.2;
  }
  .jumbo :global(.emoji) {
    width: 1.2em;
    height: 1.2em;
  }
  .ts {
    background: var(--bg-3);
    padding: 0 4px;
    border-radius: 4px;
  }
</style>
