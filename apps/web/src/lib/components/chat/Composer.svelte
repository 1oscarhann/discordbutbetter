<script lang="ts" module>
  // drafts survive switching channels
  const drafts = new Map<string, string>();
</script>

<script lang="ts">
  import {
    ChannelType,
    Limits,
    MessageType,
    Permissions as P,
    formatBytes,
    isDmType,
    snowflakeFromTime,
    type Channel,
    type Message,
    type Sticker,
  } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, errorMessage, post, upload, type UploadedFile } from '$lib/api';
  import { channelTitle, disappearingLabel } from '$lib/util/channel';
  import Icon from '../Icon.svelte';
  import Popover from '../Popover.svelte';
  import Avatar from '../Avatar.svelte';
  import EmojiPicker, { loadEmojiData } from './EmojiPicker.svelte';

  let { channel }: { channel: Channel } = $props();

  interface Pending {
    key: string;
    file: File;
    preview: string | null;
    progress: number;
    uploaded: UploadedFile | null;
    error: string | null;
    spoiler: boolean;
    abort: () => void;
  }

  let text = $state('');
  let files = $state<Pending[]>([]);
  /** Enter was pressed while uploads were still running: send as soon as they finish. */
  let sendWhenReady = $state(false);
  $effect(() => {
    if (!sendWhenReady) return;
    if (!files.length) {
      sendWhenReady = false;
      return;
    }
    if (files.some((f) => !f.uploaded && !f.error)) return;
    sendWhenReady = false;
    if (files.some((f) => f.error)) app.toast('Some uploads failed — remove them and send again', 'error');
    else void send();
  });
  let reply = $state<{ messageId: string; ping: boolean } | null>(null);
  let editingId = $state<string | null>(null);
  let silent = $state(false);
  let ta = $state<HTMLTextAreaElement | null>(null);
  let emojiAnchor = $state<HTMLElement | null>(null);
  let stickerAnchor = $state<HTMLElement | null>(null);
  let moreAnchor = $state<HTMLElement | null>(null);
  let dragging = $state(false);
  let slowUntil = $state(0);
  let now = $state(Date.now());
  let lastTyping = 0;
  let fileInput = $state<HTMLInputElement | null>(null);

  const guildId = $derived(channel.guildId);
  const perms = $derived(app.perms(guildId, channel.id));
  const isThread = $derived(channel.type === ChannelType.THREAD);
  const canSend = $derived((perms & (isThread ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES)) !== 0n);
  const canAttach = $derived((perms & P.ATTACH_FILES) !== 0n);
  const member = $derived(guildId && app.me ? app.member(guildId, app.me.id) : null);
  const timedOut = $derived(!!member?.timeoutUntil && new Date(member.timeoutUntil).getTime() > now);
  const locked = $derived(isThread && !!channel.threadMeta?.locked && (perms & P.MANAGE_THREADS) === 0n);
  const bypassSlow = $derived((perms & (P.MANAGE_MESSAGES | P.MANAGE_CHANNELS)) !== 0n);
  const slowLeft = $derived(Math.max(0, Math.ceil((slowUntil - now) / 1000)));
  const placeholder = $derived(
    isDmType(channel.type)
      ? `Message ${channel.type === ChannelType.DM ? '@' : ''}${channelTitle(channel)}${channel.disappearingSeconds ? ` · disappears after ${disappearingLabel(channel.disappearingSeconds)}` : ''}`
      : `Message ${isThread ? '' : '#'}${channel.name}`,
  );

  // swap drafts when the channel changes
  let current = '';
  $effect(() => {
    const id = channel.id;
    if (current && current !== id) drafts.set(current, text);
    if (current !== id) {
      text = drafts.get(id) ?? '';
      reply = null;
      editingId = null;
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      files = [];
      current = id;
      queueMicrotask(() => ta?.focus());
    }
  });

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });

  $effect(() => {
    void text;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 300)}px`;
  });

  export function replyTo(messageId: string) {
    editingId = null;
    reply = { messageId, ping: true };
    ta?.focus();
  }

  export function editLast() {
    const list = app.messages.get(channel.id)?.list ?? [];
    const mine = [...list].reverse().find((m) => m.author?.id === app.me?.id && m.type === MessageType.DEFAULT && !m.pending);
    if (!mine) return;
    editingId = mine.id;
    reply = null;
    text = mine.content;
    queueMicrotask(() => ta?.focus());
  }

  function cancelEdit() {
    editingId = null;
    text = drafts.get(channel.id) ?? '';
  }

  function addFiles(list: FileList | File[]) {
    if (!canAttach) return app.toast("You can't upload files here", 'error');
    const max = app.instance?.limits.uploadBytes ?? Infinity;
    for (const f of list) {
      if (files.length >= Limits.ATTACHMENTS_PER_MESSAGE) {
        app.toast(`Up to ${Limits.ATTACHMENTS_PER_MESSAGE} files per message`, 'error');
        break;
      }
      if (f.size > max) {
        app.toast(`${f.name} is bigger than this server's ${formatBytes(max)} limit`, 'error');
        continue;
      }
      const key = crypto.randomUUID();
      const { promise, abort } = upload('attachment', f, (p) => {
        const x = files.find((y) => y.key === key);
        if (x) x.progress = p;
      });
      const item: Pending = {
        key,
        file: f,
        preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : null,
        progress: 0,
        uploaded: null,
        error: null,
        spoiler: false,
        abort,
      };
      files.push(item);
      promise
        .then((u) => {
          const x = files.find((y) => y.key === key);
          if (x) x.uploaded = u;
        })
        .catch((e) => {
          const x = files.find((y) => y.key === key);
          if (x) x.error = errorMessage(e);
        });
    }
  }

  function removeFile(key: string) {
    const f = files.find((x) => x.key === key);
    f?.abort();
    if (f?.preview) URL.revokeObjectURL(f.preview);
    files = files.filter((x) => x.key !== key);
  }

  async function send() {
    if (editingId) {
      const id = editingId;
      const content = text.trim();
      try {
        await api('PATCH', `/channels/${channel.id}/messages/${id}`, { content });
        editingId = null;
        text = '';
      } catch (e) {
        app.toast(errorMessage(e), 'error');
      }
      return;
    }
    let content = text.trim();
    let isSilent = silent;
    if (content.startsWith('@silent ')) {
      content = content.slice(8).trim();
      isSilent = true;
    }
    if (!content && !files.length) return;
    if (files.some((f) => !f.uploaded && !f.error)) {
      sendWhenReady = true;
      return;
    }
    if (files.some((f) => f.error)) return app.toast('Remove the failed uploads first', 'error');
    if (slowLeft > 0) return;

    const nonce = crypto.randomUUID();
    const attachments = files.map((f) => ({ fileId: f.uploaded!.id, spoiler: f.spoiler }));
    const replyRef = reply;
    // optimistic message
    const cm = app.msgs(channel.id);
    const me = app.me!;
    const temp: Message & { pending: 'sending' | 'failed' } = {
      id: `pending-${nonce}`,
      channelId: channel.id,
      guildId: channel.guildId,
      author: { id: me.id, username: me.username, displayName: me.displayName, avatar: me.avatar },
      type: MessageType.DEFAULT,
      content,
      flags: 0,
      replyTo: null,
      mentions: [],
      mentionRoles: [],
      mentionEveryone: false,
      attachments: [],
      embeds: [],
      sticker: null,
      reactions: [],
      pinned: false,
      threadId: null,
      editedAt: null,
      expiresAt: null,
      metadata: null,
      createdAt: new Date().toISOString(),
      nonce,
      pending: 'sending',
    };
    if (cm.loaded && !cm.hasMoreAfter) cm.list.push(temp);
    text = '';
    drafts.delete(channel.id);
    files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    files = [];
    reply = null;
    silent = false;
    if (channel.slowmode && !bypassSlow) slowUntil = Date.now() + channel.slowmode * 1000;
    try {
      const m = await post<Message>(`/channels/${channel.id}/messages`, {
        content,
        attachments,
        replyTo: replyRef ?? undefined,
        silent: isSilent,
        nonce,
      });
      m.nonce = nonce;
      app.upsertMessage(m);
    } catch (e) {
      const i = cm.list.findIndex((x) => x.nonce === nonce);
      if (i >= 0) cm.list[i] = { ...cm.list[i]!, pending: 'failed' } as never;
      app.toast(errorMessage(e), 'error');
      if (!content) return;
      // put it back so nothing is lost
      if (!text) text = content;
    }
  }

  async function sendSticker(s: Sticker) {
    stickerAnchor = null;
    try {
      await post(`/channels/${channel.id}/messages`, { content: '', stickerId: s.id, replyTo: reply ?? undefined });
      reply = null;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  // ---------- autocomplete ----------
  interface Suggestion {
    key: string;
    label: string;
    sub?: string;
    insert: string;
    avatar?: { src: string | null; name: string };
    emoji?: string;
    img?: string;
  }
  let suggestions = $state<Suggestion[]>([]);
  let selIdx = $state(0);
  let token = $state<{ start: number; end: number } | null>(null);

  async function updateSuggestions() {
    if (!ta) return;
    const before = text.slice(0, ta.selectionStart);
    const m = /(^|\s)([@#:])([^\s@#:]{0,32})$/.exec(before);
    if (!m) {
      suggestions = [];
      return;
    }
    const kind = m[2]!;
    const q = m[3]!.toLowerCase();
    token = { start: before.length - q.length - 1, end: ta.selectionStart };
    const out: Suggestion[] = [];
    if (kind === '@') {
      const people = guildId
        ? [...(app.guilds.get(guildId)?.members.values() ?? [])].map((x) => x.user)
        : (channel.recipients ?? []);
      for (const u of people) {
        const name = app.displayName(u.id, guildId);
        if (name.toLowerCase().includes(q) || u.username.includes(q)) {
          out.push({ key: `u${u.id}`, label: name, sub: u.username, insert: `<@${u.id}> `, avatar: { src: app.avatarOf(u.id, guildId), name } });
        }
        if (out.length >= 8) break;
      }
      if (guildId) {
        const canEveryone = (perms & P.MENTION_EVERYONE) !== 0n;
        if (canEveryone) {
          for (const w of ['everyone', 'here']) if (w.startsWith(q)) out.push({ key: w, label: `@${w}`, sub: w === 'everyone' ? 'Ping everyone here' : 'Ping everyone online', insert: `@${w} ` });
        }
        for (const r of app.guilds.get(guildId)?.sortedRoles ?? []) {
          if (r.id === guildId || !(r.mentionable || canEveryone)) continue;
          if (r.name.toLowerCase().includes(q)) out.push({ key: `r${r.id}`, label: `@${r.name}`, sub: 'Role', insert: `<@&${r.id}> ` });
        }
      }
    } else if (kind === '#' && guildId) {
      for (const c of app.guilds.get(guildId)?.channels.values() ?? []) {
        if (c.type === ChannelType.CATEGORY) continue;
        if (c.name?.toLowerCase().includes(q)) out.push({ key: c.id, label: `#${c.name}`, insert: `<#${c.id}> ` });
        if (out.length >= 10) break;
      }
    } else if (kind === ':' && q.length >= 2) {
      for (const g of app.guilds.values()) {
        for (const e of g.emojis) {
          if (e.name.toLowerCase().includes(q)) out.push({ key: `c${e.id}`, label: `:${e.name}:`, sub: g.guild.name, insert: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}> `, img: e.url });
          if (out.length >= 6) break;
        }
      }
      const data = await loadEmojiData();
      for (const [, list] of data) {
        for (const [e, slug] of list) {
          if (slug.includes(q)) out.push({ key: e, label: `:${slug}:`, insert: `${e} `, emoji: e });
          if (out.length >= 12) break;
        }
        if (out.length >= 12) break;
      }
    }
    suggestions = out.slice(0, 12);
    selIdx = 0;
  }

  function applySuggestion(s: Suggestion) {
    if (!token || !ta) return;
    text = text.slice(0, token.start) + s.insert + text.slice(token.end);
    const pos = token.start + s.insert.length;
    suggestions = [];
    queueMicrotask(() => {
      ta!.focus();
      ta!.selectionStart = ta!.selectionEnd = pos;
    });
  }

  function onKey(e: KeyboardEvent) {
    if (suggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selIdx = (selIdx + 1) % suggestions.length;
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selIdx = (selIdx - 1 + suggestions.length) % suggestions.length;
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applySuggestion(suggestions[selIdx]!);
        return;
      }
      if (e.key === 'Escape') {
        suggestions = [];
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && app.settings.sendOnEnter && !e.isComposing) {
      e.preventDefault();
      void send();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    } else if (e.key === 'ArrowUp' && !text) {
      e.preventDefault();
      editLast();
    } else if (e.key === 'Escape') {
      if (editingId) cancelEdit();
      else if (reply) reply = null;
    }
  }

  function onInput() {
    if (!editingId) drafts.set(channel.id, text);
    void updateSuggestions();
    if (text && Date.now() - lastTyping > 6000 && !editingId) {
      lastTyping = Date.now();
      app.gateway.send({ op: 'typing', d: { channelId: channel.id } });
    }
  }

  function onPaste(e: ClipboardEvent) {
    const items = e.clipboardData?.files;
    if (items?.length) {
      e.preventDefault();
      addFiles(items);
    }
  }

  // drop files anywhere on the window while this composer is mounted
  $effect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      dragging = true;
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) dragging = false;
    };
    const over = (e: DragEvent) => e.dataTransfer?.types.includes('Files') && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      dragging = false;
      if (!ui.settings && !ui.guildSettings) addFiles(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  });

  const replyMsg = $derived(reply ? app.messages.get(channel.id)?.list.find((m) => m.id === reply!.messageId) : null);
  const stickers = $derived.by(() => {
    const ext = !guildId || (perms & P.USE_EXTERNAL_STICKERS) !== 0n;
    return [...app.guilds.values()].filter((g) => g.stickers.length && (g.guild.id === guildId || ext)).map((g) => ({ name: g.guild.name, stickers: g.stickers }));
  });

  function insertAtCursor(s: string) {
    const pos = ta?.selectionStart ?? text.length;
    text = text.slice(0, pos) + s + text.slice(pos);
    queueMicrotask(() => {
      ta?.focus();
      if (ta) ta.selectionStart = ta.selectionEnd = pos + s.length;
    });
  }
</script>

{#if dragging && canAttach && canSend}
  <div class="dropzone"><div><Icon name="upload" size={40} /><p>Drop files to upload to <strong>{channelTitle(channel)}</strong></p></div></div>
{/if}

<div class="composer">
  {#if !canSend || timedOut || locked}
    <div class="blocked faint">
      {#if timedOut}
        <Icon name="clock" size={16} /> You're timed out until {new Date(member!.timeoutUntil!).toLocaleTimeString()}.
      {:else if locked}
        <Icon name="lock" size={16} /> This thread is locked.
      {:else}
        <Icon name="lock" size={16} /> You don't have permission to send messages here.
      {/if}
    </div>
  {:else}
    {#if suggestions.length}
      <div class="suggest menu">
        {#each suggestions as s, i (s.key)}
          <button class="sug" class:sel={i === selIdx} onmousedown={(e) => (e.preventDefault(), applySuggestion(s))} onmouseenter={() => (selIdx = i)}>
            {#if s.avatar}<Avatar src={s.avatar.src} name={s.avatar.name} size={22} />{/if}
            {#if s.emoji}<span class="se">{s.emoji}</span>{/if}
            {#if s.img}<img src={s.img} alt="" class="si" />{/if}
            <span class="truncate">{s.label}</span>
            {#if s.sub}<span class="faint small truncate">{s.sub}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if editingId}
      <div class="bar">
        <Icon name="edit" size={14} /> Editing message
        <span class="spacer"></span>
        <span class="faint small">esc to cancel</span>
        <button class="icon-btn small-btn" onclick={cancelEdit} aria-label="Cancel edit"><Icon name="x" size={14} /></button>
      </div>
    {:else if reply}
      <div class="bar">
        <span class="truncate">Replying to <strong>{replyMsg?.author ? app.displayName(replyMsg.author.id, guildId) : 'message'}</strong></span>
        <span class="spacer"></span>
        <button class="ping" class:on={reply.ping} onclick={() => (reply = { ...reply!, ping: !reply!.ping })} title="Ping them about the reply">
          <Icon name="at" size={14} /> {reply.ping ? 'ON' : 'OFF'}
        </button>
        <button class="icon-btn small-btn" onclick={() => (reply = null)} aria-label="Cancel reply"><Icon name="x" size={14} /></button>
      </div>
    {/if}

    {#if files.length}
      <div class="files">
        {#each files as f (f.key)}
          <div class="fcard" class:err={!!f.error}>
            {#if f.preview}<img src={f.preview} alt="" class:blur={f.spoiler} />{:else}<div class="ficon"><Icon name="file" size={30} /></div>{/if}
            <div class="fname truncate" title={f.file.name}>{f.file.name}</div>
            <div class="fmeta faint">{f.error ?? (f.uploaded ? formatBytes(f.file.size) : `${Math.round(f.progress * 100)}%`)}</div>
            {#if !f.uploaded && !f.error}<div class="prog" style="width:{f.progress * 100}%"></div>{/if}
            <div class="factions">
              <button class="icon-btn small-btn" title={f.spoiler ? 'Unmark spoiler' : 'Mark as spoiler'} onclick={() => (f.spoiler = !f.spoiler)}><Icon name="eye" size={14} /></button>
              <button class="icon-btn small-btn danger" title="Remove" onclick={() => removeFile(f.key)}><Icon name="trash" size={14} /></button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <div class="box" class:silent>
      {#if canAttach && !editingId}
        <button class="icon-btn" title="Upload files" onclick={() => fileInput?.click()}><Icon name="plus" /></button>
        <input type="file" multiple hidden bind:this={fileInput} onchange={(e) => (addFiles((e.target as HTMLInputElement).files ?? []), ((e.target as HTMLInputElement).value = ''))} />
      {/if}
      <textarea
        bind:this={ta}
        bind:value={text}
        rows="1"
        {placeholder}
        maxlength={Limits.MESSAGE_MAX}
        oninput={onInput}
        onkeydown={onKey}
        onpaste={onPaste}
        onblur={() => setTimeout(() => (suggestions = []), 150)}
        aria-label={placeholder}
      ></textarea>
      {#if text.length > Limits.MESSAGE_MAX - 300}<span class="count faint" class:over={text.length >= Limits.MESSAGE_MAX}>{Limits.MESSAGE_MAX - text.length}</span>{/if}
      {#if !editingId}
        <button class="icon-btn" class:active={silent} title={silent ? 'Silent: nobody gets pinged' : 'Send silently'} onclick={() => (silent = !silent)}>
          <Icon name={silent ? 'bell-off' : 'bell'} size={19} />
        </button>
        {#if stickers.length}<button class="icon-btn" title="Stickers" onclick={(e) => (stickerAnchor = e.currentTarget)}><Icon name="sticker" /></button>{/if}
        <button class="icon-btn" title="Send later" onclick={(e) => (moreAnchor = e.currentTarget)}><Icon name="clock" /></button>
      {/if}
      <button class="icon-btn" title="Emoji" onclick={(e) => (emojiAnchor = e.currentTarget)}><Icon name="smile" /></button>
      <button class="icon-btn send" title="Send" disabled={(!text.trim() && !files.length) || slowLeft > 0} onclick={send}><Icon name="send" size={18} /></button>
    </div>
    {#if channel.slowmode && !bypassSlow}
      <div class="slow faint">{slowLeft ? `Slowmode: wait ${slowLeft}s` : `Slowmode is on (${channel.slowmode}s)`}</div>
    {/if}
  {/if}
</div>

{#if emojiAnchor}
  <Popover anchor={emojiAnchor} placement="top-end" onclose={() => (emojiAnchor = null)}>
    <EmojiPicker {guildId} onpick={(e) => insertAtCursor(e.text)} />
  </Popover>
{/if}

{#if stickerAnchor}
  <Popover anchor={stickerAnchor} placement="top-end" onclose={() => (stickerAnchor = null)}>
    <div class="menu stickers scroll">
      {#each stickers as g (g.name)}
        <div class="gname">{g.name}</div>
        <div class="sgrid">
          {#each g.stickers as s (s.id)}
            <button class="st" title={s.name} onclick={() => sendSticker(s)}><img src={s.url} alt={s.name} loading="lazy" /></button>
          {/each}
        </div>
      {/each}
    </div>
  </Popover>
{/if}

{#if moreAnchor}
  <Popover anchor={moreAnchor} placement="top-end" onclose={() => (moreAnchor = null)}>
    <div class="menu">
      <button
        class="menu-item"
        onclick={() => {
          moreAnchor = null;
          ui.scheduleFor = { channelId: channel.id, content: text, replyTo: reply ?? undefined, silent };
          text = '';
          reply = null;
        }}><Icon name="clock" size={16} /> Send later…</button
      >
      <button class="menu-item" onclick={() => ((moreAnchor = null), (silent = !silent))}><Icon name="bell-off" size={16} /> {silent ? 'Turn off silent' : 'Silent send'}</button>
    </div>
  </Popover>
{/if}

<style>
  .composer {
    position: relative;
    padding: 0 16px 18px;
    flex: none;
  }
  .blocked {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px;
    background: var(--bg-1);
    border-radius: var(--radius);
  }
  .box {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    background: var(--bg-3);
    border-radius: var(--radius);
    padding: 6px 6px 6px 8px;
  }
  .box.silent {
    box-shadow: inset 0 0 0 1px var(--warning);
  }
  textarea {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    resize: none;
    padding: 6px 4px;
    max-height: 300px;
    line-height: 1.4;
    font-size: 1rem;
  }
  .send {
    display: none;
  }
  @media (max-width: 760px) {
    .send {
      display: inline-grid;
    }
  }
  .count {
    font-size: 0.75rem;
    align-self: center;
  }
  .count.over {
    color: var(--danger);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--bg-1);
    border-radius: var(--radius) var(--radius) 0 0;
    font-size: 0.85rem;
    color: var(--text-muted);
  }
  .bar + .box,
  .bar + .files {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  .small-btn {
    width: 24px;
    height: 24px;
  }
  .small {
    font-size: 0.75rem;
  }
  .ping {
    display: flex;
    align-items: center;
    gap: 3px;
    background: none;
    border: none;
    cursor: pointer;
    font-weight: 800;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .ping.on {
    color: var(--accent);
  }
  .files {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 10px;
    background: var(--bg-3);
    border-radius: var(--radius) var(--radius) 0 0;
    border-bottom: 1px solid var(--border);
  }
  .files + .box {
    border-top-left-radius: 0;
    border-top-right-radius: 0;
  }
  .fcard {
    position: relative;
    width: 170px;
    flex: none;
    background: var(--bg-1);
    border-radius: 6px;
    padding: 8px;
    overflow: hidden;
  }
  .fcard.err {
    box-shadow: inset 0 0 0 1px var(--danger);
  }
  .fcard img {
    width: 100%;
    height: 100px;
    object-fit: cover;
    border-radius: 4px;
  }
  .fcard img.blur {
    filter: blur(14px);
  }
  .ficon {
    height: 100px;
    display: grid;
    place-items: center;
    color: var(--text-faint);
  }
  .fname {
    font-size: 0.82rem;
    margin-top: 6px;
  }
  .fmeta {
    font-size: 0.72rem;
  }
  .prog {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 3px;
    background: var(--accent);
    transition: width 0.2s;
  }
  .factions {
    position: absolute;
    top: 4px;
    right: 4px;
    display: flex;
    background: var(--bg-float);
    border-radius: 6px;
  }
  .slow {
    font-size: 0.75rem;
    padding: 4px 4px 0;
    text-align: right;
  }
  .suggest {
    position: absolute;
    bottom: calc(100% - 10px);
    left: 16px;
    right: 16px;
    max-height: 320px;
    overflow-y: auto;
    z-index: 10;
  }
  .sug {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .sug.sel {
    background: var(--hover);
  }
  .se {
    font-size: 1.2rem;
    width: 22px;
    text-align: center;
  }
  .si {
    width: 22px;
    height: 22px;
    object-fit: contain;
  }
  .dropzone {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--accent) 35%, rgb(0 0 0 / 0.5));
    z-index: 90;
    display: grid;
    place-items: center;
    pointer-events: none;
    text-align: center;
    color: #fff;
  }
  .stickers {
    width: 320px;
    max-height: 360px;
    overflow-y: auto;
  }
  .gname {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-faint);
    margin: 6px 4px;
  }
  .sgrid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }
  .st {
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    padding: 4px;
  }
  .st:hover {
    background: var(--hover);
  }
  .st img {
    width: 88px;
    height: 88px;
    object-fit: contain;
  }
</style>
