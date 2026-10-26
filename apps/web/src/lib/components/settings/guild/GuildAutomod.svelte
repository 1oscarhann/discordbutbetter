<script lang="ts">
  import { ChannelType, Limits, type AutomodAction, type AutomodRule } from '@haunt/shared';
  import { app, type GuildState } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { del, errorMessage, get, patch, post } from '$lib/api';
  import Modal from '../../Modal.svelte';
  import Icon from '../../Icon.svelte';

  let { g }: { g: GuildState } = $props();
  const gid = $derived(g.guild.id);
  let rules = $state<AutomodRule[] | null>(null);
  let loadError = $state('');

  get<AutomodRule[]>(`/guilds/${gid}/automod`)
    .then((r) => (rules = r))
    .catch((e) => (loadError = errorMessage(e)));

  type TriggerType = AutomodRule['trigger']['type'];
  const TRIGGERS: { type: TriggerType; label: string; desc: string }[] = [
    { type: 'keyword', label: 'Blocked words', desc: 'Catch specific words or phrases' },
    { type: 'mention_spam', label: 'Mention spam', desc: 'Too many @mentions in one message' },
    { type: 'message_spam', label: 'Message flood', desc: 'Too many messages too fast' },
    { type: 'invite_links', label: 'Invite links', desc: 'Block invites to other servers' },
    { type: 'link_filter', label: 'Link filter', desc: 'Block links to certain websites' },
  ];

  // ---- editor ----
  let editing = $state<{ id: string | null } | null>(null);
  let name = $state('');
  let enabled = $state(true);
  let ttype = $state<TriggerType>('keyword');
  let keywords = $state('');
  let allowWords = $state('');
  let mentionLimit = $state(5);
  let floodMessages = $state(5);
  let floodSeconds = $state(5);
  let domains = $state('');
  let doBlock = $state(true);
  let blockMsg = $state('');
  let doAlert = $state(false);
  let alertChannel = $state('');
  let doTimeout = $state(false);
  let timeoutSecs = $state(600);
  let exemptRoles = $state<string[]>([]);
  let exemptChannels = $state<string[]>([]);
  let error = $state('');

  const splitList = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
  const textChannels = $derived([...g.channels.values()].filter((c) => c.type === ChannelType.TEXT || c.type === ChannelType.CATEGORY || c.type === ChannelType.WIKI).sort((a, b) => a.position - b.position));

  function edit(r: AutomodRule | null, preset?: TriggerType) {
    error = '';
    name = r?.name ?? TRIGGERS.find((t) => t.type === (preset ?? 'keyword'))!.label;
    enabled = r?.enabled ?? true;
    ttype = r?.trigger.type ?? preset ?? 'keyword';
    const t = r?.trigger;
    keywords = t?.type === 'keyword' ? t.keywords.join('\n') : '';
    allowWords = t?.type === 'keyword' ? t.allow.join('\n') : '';
    mentionLimit = t?.type === 'mention_spam' ? t.limit : 5;
    floodMessages = t?.type === 'message_spam' ? t.messages : 5;
    floodSeconds = t?.type === 'message_spam' ? t.seconds : 5;
    domains = t?.type === 'link_filter' ? t.blockedDomains.join('\n') : '';
    const acts = r?.actions ?? [{ type: 'block' }];
    const b = acts.find((a) => a.type === 'block');
    const al = acts.find((a) => a.type === 'alert');
    const to = acts.find((a) => a.type === 'timeout');
    doBlock = !!b;
    blockMsg = b && 'message' in b ? (b.message ?? '') : '';
    doAlert = !!al;
    alertChannel = al && al.type === 'alert' ? al.channelId : '';
    doTimeout = !!to;
    timeoutSecs = to && to.type === 'timeout' ? to.seconds : 600;
    exemptRoles = [...(r?.exemptRoles ?? [])];
    exemptChannels = [...(r?.exemptChannels ?? [])];
    editing = { id: r?.id ?? null };
  }

  function buildTrigger(): AutomodRule['trigger'] {
    switch (ttype) {
      case 'keyword':
        return { type: 'keyword', keywords: splitList(keywords), allow: splitList(allowWords) };
      case 'mention_spam':
        return { type: 'mention_spam', limit: mentionLimit };
      case 'message_spam':
        return { type: 'message_spam', messages: floodMessages, seconds: floodSeconds };
      case 'invite_links':
        return { type: 'invite_links' };
      case 'link_filter':
        return { type: 'link_filter', blockedDomains: splitList(domains).map((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '')) };
    }
  }

  async function save(e: Event) {
    e.preventDefault();
    if (!editing) return;
    error = '';
    const actions: AutomodAction[] = [];
    if (doBlock) actions.push(blockMsg.trim() ? { type: 'block', message: blockMsg.trim() } : { type: 'block' });
    if (doAlert) {
      if (!alertChannel) return void (error = 'Pick a channel for alerts');
      actions.push({ type: 'alert', channelId: alertChannel });
    }
    if (doTimeout) actions.push({ type: 'timeout', seconds: timeoutSecs });
    if (!actions.length) return void (error = 'Pick at least one action');
    const body = { name, enabled, trigger: buildTrigger(), actions, exemptRoles, exemptChannels };
    try {
      if (editing.id) {
        const r = await patch<AutomodRule>(`/guilds/${gid}/automod/${editing.id}`, body);
        rules = rules?.map((x) => (x.id === r.id ? r : x)) ?? [r];
      } else {
        const r = await post<AutomodRule>(`/guilds/${gid}/automod`, body);
        rules = [...(rules ?? []), r];
      }
      editing = null;
    } catch (err) {
      error = errorMessage(err);
    }
  }

  async function toggle(r: AutomodRule) {
    try {
      const n = await patch<AutomodRule>(`/guilds/${gid}/automod/${r.id}`, { enabled: !r.enabled });
      rules = rules?.map((x) => (x.id === n.id ? n : x)) ?? null;
    } catch (err) {
      app.toast(errorMessage(err), 'error');
    }
  }

  function remove(r: AutomodRule) {
    ui.confirm(`Delete "${r.name}"?`, '', 'Delete rule', async () => {
      await del(`/guilds/${gid}/automod/${r.id}`);
      rules = rules?.filter((x) => x.id !== r.id) ?? null;
    });
  }

  function describe(r: AutomodRule): string {
    const t = r.trigger;
    const what =
      t.type === 'keyword'
        ? `${t.keywords.length} blocked word${t.keywords.length === 1 ? '' : 's'}`
        : t.type === 'mention_spam'
          ? `more than ${t.limit} mentions`
          : t.type === 'message_spam'
            ? `${t.messages} messages in ${t.seconds}s`
            : t.type === 'invite_links'
              ? 'invite links'
              : `${t.blockedDomains.length} blocked site${t.blockedDomains.length === 1 ? '' : 's'}`;
    const acts = r.actions.map((a) => (a.type === 'block' ? 'block' : a.type === 'alert' ? 'alert mods' : `timeout ${Math.round(a.seconds / 60)}m`)).join(', ');
    return `${what} → ${acts}`;
  }
</script>

<h2>AutoMod</h2>
<p class="muted">
  Filters that run on every message before it's posted. People with Manage Server or Administrator skip them. Max {Limits.AUTOMOD_RULES_MAX} rules.
</p>
{#if loadError}<p class="error-text">{loadError}</p>{/if}

{#if rules}
  {#each rules as r (r.id)}
    <div class="list-item rule">
      <span class="col" style="gap:0;flex:1;min-width:0">
        <strong class="truncate">{r.name}</strong>
        <span class="faint small truncate">{describe(r)}</span>
      </span>
      <input type="checkbox" class="switch" checked={r.enabled} onchange={() => toggle(r)} aria-label="Enabled" />
      <button class="icon-btn" title="Edit" onclick={() => edit(r)}><Icon name="edit" size={15} /></button>
      <button class="icon-btn" title="Delete" onclick={() => remove(r)}><Icon name="trash" size={15} /></button>
    </div>
  {/each}

  {#if rules.length < Limits.AUTOMOD_RULES_MAX}
    <h3>Add a rule</h3>
    <div class="presets">
      {#each TRIGGERS as t (t.type)}
        <button class="preset" onclick={() => edit(null, t.type)}>
          <strong>{t.label}</strong>
          <span class="faint small">{t.desc}</span>
        </button>
      {/each}
    </div>
  {/if}
{/if}

{#if editing}
  <Modal title={editing.id ? 'Edit rule' : 'New rule'} onclose={() => (editing = null)} width={560}>
    <form id="amf" onsubmit={save}>
      <div class="field">
        <label for="rn">Rule name</label>
        <input id="rn" class="input" bind:value={name} maxlength="60" required />
      </div>
      <div class="field">
        <label for="tt">Trigger</label>
        <select id="tt" class="select" bind:value={ttype}>
          {#each TRIGGERS as t (t.type)}<option value={t.type}>{t.label}</option>{/each}
        </select>
      </div>

      {#if ttype === 'keyword'}
        <div class="field">
          <label for="kw">Blocked words (one per line or comma-separated)</label>
          <textarea id="kw" class="textarea" rows="5" bind:value={keywords} required></textarea>
          <span class="hint">
            <code>word</code> matches the whole word, <code>word*</code> words starting with it, <code>*word</code> words ending with it,
            <code>*word*</code> anywhere. Matching ignores case, accents and common swaps like 4→a, 3→e, $→s.
          </span>
        </div>
        <div class="field">
          <label for="aw">Allowed words (exceptions)</label>
          <textarea id="aw" class="textarea" rows="2" bind:value={allowWords} placeholder="e.g. scunthorpe"></textarea>
        </div>
      {:else if ttype === 'mention_spam'}
        <div class="field">
          <label for="ml">Max mentions per message</label>
          <input id="ml" class="input" type="number" min="2" max="50" bind:value={mentionLimit} />
        </div>
      {:else if ttype === 'message_spam'}
        <div class="row" style="gap:10px">
          <div class="field" style="flex:1">
            <label for="fm">Messages</label>
            <input id="fm" class="input" type="number" min="2" max="50" bind:value={floodMessages} />
          </div>
          <div class="field" style="flex:1">
            <label for="fs">Within (seconds)</label>
            <input id="fs" class="input" type="number" min="2" max="120" bind:value={floodSeconds} />
          </div>
        </div>
      {:else if ttype === 'invite_links'}
        <p class="faint small">Blocks invite links to other servers (on this instance and discord.gg-style links).</p>
      {:else if ttype === 'link_filter'}
        <div class="field">
          <label for="bd">Blocked sites</label>
          <textarea id="bd" class="textarea" rows="4" bind:value={domains} placeholder={'example.com\n*.sketchy.biz'} required></textarea>
          <span class="hint"><code>example.com</code> blocks it and its subdomains.</span>
        </div>
      {/if}

      <h4>When it triggers</h4>
      <label class="act"><input type="checkbox" bind:checked={doBlock} /> Block the message</label>
      {#if doBlock}
        <input class="input sub" bind:value={blockMsg} maxlength="150" placeholder="Custom message shown to them (optional)" />
      {/if}
      <label class="act"><input type="checkbox" bind:checked={doAlert} /> Send an alert to a channel</label>
      {#if doAlert}
        <select class="select sub" bind:value={alertChannel}>
          <option value="" disabled>Pick a channel</option>
          {#each [...g.channels.values()].filter((c) => c.type === ChannelType.TEXT) as c (c.id)}<option value={c.id}>#{c.name}</option>{/each}
        </select>
      {/if}
      <label class="act"><input type="checkbox" bind:checked={doTimeout} /> Time them out</label>
      {#if doTimeout}
        <select class="select sub" bind:value={timeoutSecs}>
          <option value={60}>1 minute</option>
          <option value={300}>5 minutes</option>
          <option value={600}>10 minutes</option>
          <option value={3600}>1 hour</option>
          <option value={86400}>1 day</option>
          <option value={604800}>1 week</option>
        </select>
      {/if}

      <details class="exempt">
        <summary>Exemptions ({exemptRoles.length + exemptChannels.length})</summary>
        <div class="cols">
          <div>
            <div class="label">Roles</div>
            {#each g.sortedRoles.filter((r) => r.id !== gid) as r (r.id)}
              <label class="chk"><input type="checkbox" checked={exemptRoles.includes(r.id)} onchange={(e) => (exemptRoles = (e.target as HTMLInputElement).checked ? [...exemptRoles, r.id] : exemptRoles.filter((x) => x !== r.id))} /> {r.name}</label>
            {/each}
          </div>
          <div>
            <div class="label">Channels</div>
            {#each textChannels as c (c.id)}
              <label class="chk"><input type="checkbox" checked={exemptChannels.includes(c.id)} onchange={(e) => (exemptChannels = (e.target as HTMLInputElement).checked ? [...exemptChannels, c.id] : exemptChannels.filter((x) => x !== c.id))} /> {c.type === ChannelType.CATEGORY ? '▸ ' : '#'}{c.name}</label>
            {/each}
          </div>
        </div>
      </details>

      <label class="act" style="margin-top:12px"><input type="checkbox" bind:checked={enabled} /> Rule enabled</label>
      {#if error}<p class="error-text">{error}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (editing = null)}>Cancel</button>
      <button class="btn primary" type="submit" form="amf">Save rule</button>
    {/snippet}
  </Modal>
{/if}

<style>
  .rule {
    gap: 8px;
  }
  .presets {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 8px;
  }
  .preset {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--bg-1);
    cursor: pointer;
  }
  .preset:hover {
    border-color: var(--accent);
  }
  h4 {
    margin: 16px 0 6px;
    font-size: 0.78rem;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .act,
  .chk {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: pointer;
  }
  .sub {
    margin: 2px 0 8px 24px;
    width: calc(100% - 24px);
  }
  .exempt {
    margin-top: 12px;
  }
  .exempt summary {
    cursor: pointer;
    font-weight: 600;
  }
  .cols {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    max-height: 220px;
    overflow: auto;
    margin-top: 8px;
  }
  code {
    background: var(--bg-0);
    padding: 0 4px;
    border-radius: 4px;
  }
</style>
