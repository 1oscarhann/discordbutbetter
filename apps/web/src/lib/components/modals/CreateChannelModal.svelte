<script lang="ts">
  import { goto } from '$app/navigation';
  import { ChannelType, type Channel } from '@haunt/shared';
  import { ui } from '$lib/state/ui.svelte';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, post } from '$lib/api';
  import Modal from '../Modal.svelte';
  import Icon, { type IconName } from '../Icon.svelte';

  let { guildId, parentId, type: initialType }: { guildId: string; parentId: string | null; type: number } = $props();
  let type = $state(initialType);
  let name = $state('');
  let isPrivate = $state(false);
  let error = $state('');
  let busy = $state(false);
  const isCategory = $derived(type === ChannelType.CATEGORY);

  const TYPES: { t: number; icon: IconName; label: string; desc: string }[] = [
    { t: ChannelType.TEXT, icon: 'hash', label: 'Text', desc: 'Messages, images, links, threads' },
    { t: ChannelType.VOICE, icon: 'speaker', label: 'Voice', desc: 'Talk, video, screen share, watch together' },
    { t: ChannelType.WIKI, icon: 'book', label: 'Wiki', desc: 'Pinned, editable pages: rules, guides, docs' },
  ];

  async function create(e: Event) {
    e.preventDefault();
    busy = true;
    error = '';
    try {
      // read props before closing: they come from ui.createChannel and go away with it
      const gid = guildId;
      const c = await post<Channel>(`/guilds/${gid}/channels`, { name, type, parentId: isCategory ? null : parentId, private: isPrivate });
      // don't wait for the gateway echo, or the page briefly can't find the channel
      app.guilds.get(gid)?.channels.set(c.id, c);
      ui.createChannel = null;
      if (c.type !== ChannelType.CATEGORY) goto(`/app/${gid}/${c.id}`);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<Modal title={isCategory ? 'Create category' : 'Create channel'} onclose={() => { ui.createChannel = null; }}>
  <form id="cc" onsubmit={create}>
    {#if !isCategory}
      {#if parentId}<p class="faint small">In {app.channel(parentId)?.name}</p>{/if}
      <div class="types">
        {#each TYPES as t (t.t)}
          <label class="type" class:sel={type === t.t}>
            <input type="radio" name="t" value={t.t} bind:group={type} hidden />
            <Icon name={t.icon} />
            <span class="col" style="gap:0"><strong>{t.label}</strong><span class="faint small">{t.desc}</span></span>
          </label>
        {/each}
      </div>
    {/if}
    <div class="field">
      <label for="cn">Name</label>
      <input id="cn" class="input" bind:value={name} maxlength="100" required placeholder={isCategory ? 'New category' : type === ChannelType.VOICE ? 'Hangout' : 'new-channel'} />
    </div>
    <label class="row priv">
      <Icon name="lock" size={16} />
      <span class="col" style="gap:0;flex:1"><strong>Private</strong><span class="faint small">Only roles and members you add can see it</span></span>
      <input type="checkbox" class="switch" bind:checked={isPrivate} />
    </label>
    {#if error}<p class="error-text">{error}</p>{/if}
  </form>
  {#snippet footer()}
    <button class="btn ghost" onclick={() => { ui.createChannel = null; }}>Cancel</button>
    <button class="btn primary" form="cc" disabled={busy || !name.trim()}>Create</button>
  {/snippet}
</Modal>

<style>
  .types {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }
  .type {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: var(--bg-0);
    border: 1px solid transparent;
    cursor: pointer;
  }
  .type.sel {
    border-color: var(--accent);
    background: var(--bg-3);
  }
  .small {
    font-size: 0.8rem;
  }
  .priv {
    padding: 8px 0;
  }
</style>
