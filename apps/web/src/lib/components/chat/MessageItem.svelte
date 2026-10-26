<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    ChannelType,
    MessageFlags,
    MessageType,
    Permissions as P,
    RelationshipType,
    isDmType,
    plainPreview,
    type Channel,
    type Message,
  } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { api, del, errorMessage, post, put } from '$lib/api';
  import { clockTime, fullDate, messageTime } from '$lib/util/time';
  import { copy, disappearingLabel } from '$lib/util/channel';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';
  import Markdown from '../Markdown.svelte';
  import Popover from '../Popover.svelte';
  import Attachments from './Attachments.svelte';
  import EmbedView from './EmbedView.svelte';
  import Reactions from './Reactions.svelte';
  import EmojiPicker from './EmojiPicker.svelte';
  import GameCard from '../activities/GameCard.svelte';

  let {
    message: m,
    channel,
    grouped: groupedProp = false,
    flash = false,
    onReply,
    onJump,
    readBy,
    compactActions = false,
  }: {
    message: Message & { pending?: 'sending' | 'failed'; localFiles?: string[] };
    channel: Channel;
    grouped?: boolean;
    flash?: boolean;
    onReply?: (id: string) => void;
    onJump?: (id: string) => void;
    readBy?: string[];
    compactActions?: boolean;
  } = $props();
  // compact mode repeats the name on every line, IRC-style
  const grouped = $derived(groupedProp && !app.settings.compact);

  const guildId = $derived(channel.guildId);
  const authorId = $derived(m.author?.id ?? '');
  const mine = $derived(authorId === app.me?.id);
  const name = $derived(m.author ? app.displayName(authorId, guildId) : 'Deleted user');
  const color = $derived(m.author ? app.roleColor(guildId, authorId) : null);
  const mentioned = $derived(!mine && app.isMentioned(m));
  const blocked = $derived(!mine && !!authorId && app.relationships.get(authorId)?.type === RelationshipType.BLOCKED);
  const canManage = $derived(!!guildId && app.can(P.MANAGE_MESSAGES, guildId, channel.id));
  const canReact = $derived(app.can(P.ADD_REACTIONS, guildId, channel.id));
  const canThread = $derived(!!guildId && channel.type === ChannelType.TEXT && app.can(P.CREATE_THREADS, guildId, channel.id) && !m.threadId);
  const saved = $derived(app.bookmarkIds.has(m.id));

  let showBlocked = $state(false);
  let editing = $state(false);
  let editText = $state('');
  let editEl = $state<HTMLTextAreaElement | null>(null);
  let pickerAnchor = $state<HTMLElement | null>(null);
  let moreAnchor = $state<HTMLElement | null>(null);

  export function startEdit() {
    editText = m.content;
    editing = true;
    queueMicrotask(() => {
      editEl?.focus();
      if (editEl) editEl.selectionStart = editEl.selectionEnd = editEl.value.length;
    });
  }

  async function saveEdit() {
    const content = editText.trim();
    if (content === m.content) return (editing = false);
    if (!content && !m.attachments.length) return askDelete();
    try {
      await api('PATCH', `/channels/${channel.id}/messages/${m.id}`, { content });
      editing = false;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function askDelete() {
    ui.confirm('Delete message?', plainPreview(m.content, 200) || 'This message', 'Delete', async () => {
      await del(`/channels/${channel.id}/messages/${m.id}`);
    });
  }

  async function react(key: string) {
    pickerAnchor = null;
    const existing = m.reactions.find((r) => r.emoji === key);
    try {
      if (existing?.me) await del(`/channels/${channel.id}/messages/${m.id}/reactions/${encodeURIComponent(key)}/@me`);
      else await put(`/channels/${channel.id}/messages/${m.id}/reactions/${encodeURIComponent(key)}/@me`);
      rememberEmoji(key);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function rememberEmoji(key: string) {
    try {
      const recent: string[] = JSON.parse(localStorage.getItem('recentEmoji') ?? '[]');
      localStorage.setItem('recentEmoji', JSON.stringify([key, ...recent.filter((k) => k !== key)].slice(0, 24)));
    } catch {
      /* ignore */
    }
  }

  const quick = $derived.by(() => {
    try {
      const r: string[] = JSON.parse(localStorage.getItem('recentEmoji') ?? '[]');
      return [...new Set([...r.filter((k) => !k.startsWith('c:')), '👍', '❤️', '😂'])].slice(0, 3);
    } catch {
      return ['👍', '❤️', '😂'];
    }
  });

  async function togglePin() {
    moreAnchor = null;
    try {
      if (m.pinned) await del(`/channels/${channel.id}/pins/${m.id}`);
      else await put(`/channels/${channel.id}/pins/${m.id}`);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function toggleSave(folderId: string | null = null) {
    moreAnchor = null;
    try {
      if (saved && folderId === null) await del(`/users/@me/bookmarks/${m.id}`);
      else {
        await put(`/users/@me/bookmarks/${m.id}`, { folderId, note: '' });
        app.toast('Saved', 'success');
      }
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function startThread() {
    moreAnchor = null;
    const name = plainPreview(m.content, 60) || 'Thread';
    try {
      const t = await post<Channel>(`/channels/${channel.id}/threads`, { name, messageId: m.id });
      ui.thread = t.id;
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function retry() {
    const cm = app.messages.get(channel.id);
    if (!cm) return;
    cm.list = cm.list.filter((x) => x.id !== m.id);
    try {
      await post(`/channels/${channel.id}/messages`, { content: m.content, nonce: m.nonce });
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  function openProfile(e: MouseEvent, userId: string) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.profile = { userId, guildId, x: r.right + 10, y: r.top };
  }

  function sysUser(id: unknown): string {
    return typeof id === 'string' ? app.displayName(id, guildId) : 'Someone';
  }
</script>

{#if m.type !== MessageType.DEFAULT}
  <!-- system messages -->
  <div class="sys" class:flash data-mid={m.id}>
    {#if m.type === MessageType.MEMBER_JOIN}
      <span class="sysicon join"><Icon name="chevron-right" size={16} /></span>
      <span><button class="link" onclick={(e) => openProfile(e, authorId)}>{name}</button> joined the server. Say hi! 👋</span>
    {:else if m.type === MessageType.THREAD_CREATED}
      <span class="sysicon"><Icon name="thread" size={16} /></span>
      <span>{name} started a thread: <button class="link" onclick={() => { ui.thread = String(m.metadata?.threadId); }}>{String(m.metadata?.name ?? 'thread')}</button></span>
    {:else if m.type === MessageType.PIN}
      <span class="sysicon"><Icon name="pin" size={16} /></span>
      <span>{name} pinned <button class="link" onclick={() => onJump?.(String(m.metadata?.messageId))}>a message</button>. <button class="link" onclick={() => { ui.rightPanel = 'pins'; }}>See all pins</button></span>
    {:else if m.type === MessageType.DISAPPEARING_CHANGED}
      <span class="sysicon"><Icon name="hourglass" size={16} /></span>
      <span>
        {name}
        {Number(m.metadata?.seconds) ? `turned on disappearing messages: new messages vanish after ${disappearingLabel(Number(m.metadata?.seconds))}.` : 'turned off disappearing messages.'}
      </span>
    {:else if m.type === MessageType.LEVEL_UP}
      <span class="sysicon lvl"><Icon name="trophy" size={16} /></span>
      <span>🎉 <button class="link" onclick={(e) => openProfile(e, String(m.metadata?.userId))}>{sysUser(m.metadata?.userId)}</button> reached <strong>level {String(m.metadata?.level)}</strong>!</span>
    {:else if m.type === MessageType.RECIPIENT_ADD}
      <span class="sysicon join"><Icon name="user-plus" size={16} /></span>
      <span>{name} added {sysUser(m.metadata?.userId)} to the group.</span>
    {:else if m.type === MessageType.RECIPIENT_REMOVE}
      <span class="sysicon leave"><Icon name="logout" size={16} /></span>
      <span>{m.metadata?.userId === authorId ? `${name} left the group.` : `${name} removed ${sysUser(m.metadata?.userId)} from the group.`}</span>
    {:else if m.type === MessageType.CHANNEL_NAME_CHANGE}
      <span class="sysicon"><Icon name="edit" size={16} /></span>
      <span>{name} renamed the group to <strong>{String(m.metadata?.name ?? '')}</strong>.</span>
    {:else if m.type === MessageType.CHANNEL_ICON_CHANGE}
      <span class="sysicon"><Icon name="image" size={16} /></span>
      <span>{name} changed the group icon.</span>
    {:else if m.type === MessageType.WATCH_TOGETHER}
      <span class="sysicon"><Icon name="tv" size={16} /></span>
      <span>{name} started watching <strong>{String(m.metadata?.title ?? 'a video')}</strong> together. Join the voice channel to watch.</span>
    {:else if m.type === MessageType.GAME}
      <div class="gamewrap">
        <div class="row"><span class="sysicon"><Icon name="gamepad" size={16} /></span> <span>{name} started a game of <strong>{String(m.metadata?.name ?? '')}</strong></span></div>
        <GameCard gameId={String(m.metadata?.gameId)} {channel} />
      </div>
    {:else if m.type === MessageType.AUTOMOD_ALERT}
      <div class="automod">
        <div class="row"><Icon name="shield" size={16} /> <strong>AutoMod</strong> <span class="faint">· {String(m.metadata?.ruleName)}</span></div>
        <div class="faint small">
          {sysUser(m.metadata?.userId)} in <a href={`/app/${guildId}/${String(m.metadata?.channelId)}`}>#{app.channel(String(m.metadata?.channelId))?.name ?? 'channel'}</a> —
          {String(m.metadata?.reason)}
        </div>
        <blockquote>{String(m.metadata?.content ?? '')}</blockquote>
      </div>
    {/if}
    <time class="faint small" title={fullDate(m.createdAt)}>{messageTime(m.createdAt, app.settings.use24h)}</time>
  </div>
{:else if blocked && !showBlocked}
  <div class="blocked" data-mid={m.id}>
    <Icon name="ban" size={14} /> Message from someone you blocked. <button class="link" onclick={() => (showBlocked = true)}>Show</button>
  </div>
{:else}
  <article
    class="msg"
    class:grouped
    class:mentioned
    class:flash
    class:pending={m.pending === 'sending'}
    class:failed={m.pending === 'failed'}
    class:editing
    data-mid={m.id}
  >
    {#if m.replyTo}
      <div class="reply">
        <span class="spine"></span>
        {#if m.replyTo.deleted || !m.replyTo.author}
          <span class="faint ital">Original message was deleted</span>
        {:else}
          <Avatar src={app.avatarOf(m.replyTo.author.id, guildId)} name={app.displayName(m.replyTo.author.id, guildId)} size={16} />
          <button class="rname" style:color={app.roleColor(guildId, m.replyTo.author.id)} onclick={(e) => openProfile(e, m.replyTo!.author!.id)}>
            @{app.displayName(m.replyTo.author.id, guildId)}
          </button>
          <button class="rtext truncate" onclick={() => onJump?.(m.replyTo!.id)}>
            {plainPreview(m.replyTo.content, 140) || (m.replyTo.hasAttachments ? 'Click to see attachment' : '…')}
          </button>
        {/if}
      </div>
    {/if}

    <div class="gutter">
      {#if grouped}
        <time class="hovertime" title={fullDate(m.createdAt)}>{clockTime(new Date(m.createdAt), app.settings.use24h)}</time>
      {:else}
        <button class="avbtn" onclick={(e) => m.author && openProfile(e, authorId)} aria-label="Profile of {name}">
          <Avatar src={m.author ? app.avatarOf(authorId, guildId) : null} {name} size={40} />
        </button>
      {/if}
    </div>

    <div class="main">
      {#if !grouped}
        <div class="head">
          <button class="author" style:color onclick={(e) => m.author && openProfile(e, authorId)}>{name}</button>
          {#if guildId && authorId === app.guilds.get(guildId)?.guild.ownerId}<span title="Server owner" class="crown"><Icon name="crown" size={13} /></span>{/if}
          <time class="faint small" title={fullDate(m.createdAt)}>{messageTime(m.createdAt, app.settings.use24h)}</time>
          {#if m.flags & MessageFlags.SCHEDULED}<span class="faint" title="Sent with send later"><Icon name="clock" size={12} /></span>{/if}
          {#if m.flags & MessageFlags.SILENT}<span class="faint" title="Silent message"><Icon name="bell-off" size={12} /></span>{/if}
          {#if m.expiresAt}<span class="faint" title="Disappears {fullDate(m.expiresAt)}"><Icon name="hourglass" size={12} /></span>{/if}
        </div>
      {/if}

      {#if editing}
        <div class="editor">
          <textarea
            class="textarea"
            bind:this={editEl}
            bind:value={editText}
            rows={Math.min(10, editText.split('\n').length + 1)}
            onkeydown={(e) => {
              if (e.key === 'Escape') editing = false;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void saveEdit();
              }
            }}
          ></textarea>
          <div class="faint small">escape to <button class="link" onclick={() => (editing = false)}>cancel</button> · enter to <button class="link" onclick={saveEdit}>save</button></div>
        </div>
      {:else if m.content}
        <div class="content">
          <Markdown content={m.content} {guildId} />
          {#if m.editedAt}
            <button class="edited faint" title="Edited {fullDate(m.editedAt)} — click for history" onclick={() => { ui.editHistory = { channelId: channel.id, messageId: m.id }; }}>(edited)</button>
          {/if}
        </div>
      {/if}

      {#if m.attachments.length}<Attachments attachments={m.attachments} />{/if}
      {#if m.sticker}
        <img class="sticker" src={m.sticker.url} alt={m.sticker.name} title={m.sticker.name} width="160" height="160" loading="lazy" />
      {/if}
      {#if app.settings.showEmbeds && !(m.flags & MessageFlags.SUPPRESS_EMBEDS)}
        {#each m.embeds as e, i (i)}<EmbedView embed={e} />{/each}
      {/if}
      {#if m.reactions.length}<Reactions message={m} {channel} onToggle={react} />{/if}
      {#if m.threadId}
        {@const t = app.channel(m.threadId)}
        <button class="threadlink" onclick={() => { ui.thread = m.threadId; }}>
          <Icon name="thread" size={14} />
          <strong>{t?.name ?? 'Thread'}</strong>
          <span class="faint">{t?.threadMeta?.messageCount ?? 0} {(t?.threadMeta?.messageCount ?? 0) === 1 ? 'message' : 'messages'} ›</span>
        </button>
      {/if}
      {#if m.pending === 'failed'}
        <div class="error-text small">Couldn't send. <button class="link" onclick={retry}>Retry</button></div>
      {/if}
      {#if readBy?.length}
        <div class="seen faint small" title="Read by {readBy.map((u) => app.displayName(u)).join(', ')}">
          <Icon name="check" size={12} /> Seen{isDmType(channel.type) && channel.type === ChannelType.GROUP_DM ? ` by ${readBy.map((u) => app.displayName(u)).join(', ')}` : ''}
        </div>
      {/if}
    </div>

    {#if !m.pending && !editing}
      <div class="toolbar" class:show={!!pickerAnchor || !!moreAnchor}>
        {#if canReact && !compactActions}
          {#each quick as q (q)}<button class="tb" title="React {q}" onclick={() => react(q)}>{q}</button>{/each}
        {/if}
        {#if canReact || m.reactions.length}
          <button class="tb" title="Add reaction" onclick={(e) => (pickerAnchor = e.currentTarget)}><Icon name="smile" size={18} /></button>
        {/if}
        {#if onReply && app.can(P.SEND_MESSAGES, guildId, channel.id)}
          <button class="tb" title="Reply" onclick={() => onReply(m.id)}><Icon name="reply" size={18} /></button>
        {/if}
        {#if canThread && !compactActions}
          <button class="tb" title="Create thread" onclick={startThread}><Icon name="thread" size={18} /></button>
        {/if}
        {#if mine}
          <button class="tb" title="Edit" onclick={startEdit}><Icon name="edit" size={17} /></button>
        {/if}
        <button class="tb" title="More" onclick={(e) => (moreAnchor = e.currentTarget)}><Icon name="more" size={18} /></button>
      </div>
    {/if}
  </article>
{/if}

{#if pickerAnchor}
  <Popover anchor={pickerAnchor} placement="left-start" onclose={() => (pickerAnchor = null)}>
    <EmojiPicker {guildId} onpick={(e) => react(e.reactionKey)} />
  </Popover>
{/if}

{#if moreAnchor}
  <Popover anchor={moreAnchor} placement="bottom-end" onclose={() => (moreAnchor = null)}>
    <div class="menu">
      {#if mine}<button class="menu-item" onclick={() => ((moreAnchor = null), startEdit())}><Icon name="edit" size={16} /> Edit message</button>{/if}
      {#if onReply}<button class="menu-item" onclick={() => ((moreAnchor = null), onReply(m.id))}><Icon name="reply" size={16} /> Reply</button>{/if}
      {#if canThread}<button class="menu-item" onclick={startThread}><Icon name="thread" size={16} /> Create thread</button>{/if}
      {#if !guildId || canManage}
        <button class="menu-item" onclick={togglePin}><Icon name="pin" size={16} /> {m.pinned ? 'Unpin' : 'Pin'} message</button>
      {/if}
      <button class="menu-item" onclick={() => toggleSave(null)}><Icon name="bookmark" size={16} /> {saved ? 'Remove from saved' : 'Save message'}</button>
      {#if !saved && app.bookmarkFolders.length}
        {#each app.bookmarkFolders as f (f.id)}
          <button class="menu-item sub" onclick={() => toggleSave(f.id)}>↳ Save to “{f.name}”</button>
        {/each}
      {/if}
      <div class="menu-sep"></div>
      {#if m.content}<button class="menu-item" onclick={() => ((moreAnchor = null), copy(m.content, 'Text copied'))}><Icon name="copy" size={16} /> Copy text</button>{/if}
      <button class="menu-item" onclick={() => ((moreAnchor = null), copy(`${location.origin}${guildId ? `/app/${guildId}` : '/app/me'}/${channel.id}?m=${m.id}`, 'Link copied'))}>
        <Icon name="link" size={16} /> Copy message link
      </button>
      {#if app.settings.showIds}<button class="menu-item" onclick={() => ((moreAnchor = null), copy(m.id, 'ID copied'))}><Icon name="copy" size={16} /> Copy ID</button>{/if}
      {#if mine || canManage}
        <div class="menu-sep"></div>
        <button class="menu-item danger" onclick={() => ((moreAnchor = null), askDelete())}><Icon name="trash" size={16} /> Delete message</button>
      {/if}
    </div>
  </Popover>
{/if}

<style>
  .msg {
    position: relative;
    display: grid;
    grid-template-columns: 56px 1fr;
    padding: 2px 48px 2px 16px;
    margin-top: 14px;
  }
  :global([data-compact='1']) .msg {
    grid-template-columns: 1fr;
    margin-top: 1px;
    padding-top: 1px;
    padding-bottom: 1px;
  }
  :global([data-compact='1']) .gutter {
    display: none;
  }
  :global([data-compact='1']) .head {
    display: inline-flex;
    float: left;
    margin-right: 8px;
    line-height: inherit;
  }
  :global([data-compact='1']) .head time {
    order: -1;
    min-width: 4.2em;
  }
  :global([data-compact='1']) .msg .main::after {
    content: '';
    display: block;
    clear: both;
  }
  .msg.grouped {
    margin-top: 0;
  }
  .msg:hover {
    background: color-mix(in srgb, var(--bg-0) 25%, transparent);
  }
  .msg.mentioned {
    background: color-mix(in srgb, var(--mention) 55%, transparent);
    box-shadow: inset 2px 0 0 var(--warning);
  }
  .msg.flash,
  .sys.flash {
    animation: flash 2s ease-out;
  }
  @keyframes flash {
    0%,
    30% {
      background: color-mix(in srgb, var(--accent) 30%, transparent);
    }
  }
  .msg.pending {
    opacity: 0.55;
  }
  .msg.failed .content {
    color: var(--danger);
  }
  .reply {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 5px;
    padding-left: 56px;
    position: relative;
    font-size: 0.82rem;
    min-width: 0;
    margin-bottom: 2px;
  }
  .spine {
    position: absolute;
    left: 34px;
    top: 9px;
    width: 22px;
    height: 10px;
    border-left: 2px solid var(--bg-3);
    border-top: 2px solid var(--bg-3);
    border-top-left-radius: 6px;
  }
  .rname,
  .rtext {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: inherit;
  }
  .rname {
    font-weight: 700;
    flex: none;
  }
  .rtext {
    color: var(--text-muted);
    text-align: left;
    flex: 1;
  }
  .rtext:hover {
    color: var(--text);
  }
  .ital {
    font-style: italic;
  }
  .gutter {
    padding-top: 2px;
  }
  .avbtn {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .hovertime {
    display: none;
    font-size: 0.68rem;
    color: var(--text-faint);
    padding-top: 4px;
  }
  .msg:hover .hovertime {
    display: block;
  }
  .main {
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    line-height: 1.3;
  }
  .author {
    background: none;
    border: none;
    padding: 0;
    font-weight: 700;
    cursor: pointer;
    font-size: 1rem;
  }
  .author:hover {
    text-decoration: underline;
  }
  .crown {
    color: var(--warning);
    align-self: center;
  }
  .small {
    font-size: 0.75rem;
  }
  .content {
    line-height: 1.45;
  }
  .content :global(.md) {
    display: inline;
  }
  .edited {
    background: none;
    border: none;
    padding: 0 0 0 4px;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .edited:hover {
    text-decoration: underline;
  }
  .editor {
    margin: 4px 0;
  }
  .editor .textarea {
    min-height: 44px;
  }
  .sticker {
    display: block;
    margin-top: 4px;
    object-fit: contain;
  }
  .threadlink {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--bg-1);
    border: 1px solid var(--border);
    cursor: pointer;
    font-size: 0.85rem;
  }
  .threadlink:hover {
    border-color: var(--accent);
  }
  .seen {
    display: flex;
    align-items: center;
    gap: 3px;
    justify-content: flex-end;
    margin-top: 2px;
  }
  .toolbar {
    position: absolute;
    right: 16px;
    top: -14px;
    display: none;
    background: var(--bg-float);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 2px;
    z-index: 4;
  }
  .msg:hover .toolbar,
  .toolbar.show {
    display: flex;
  }
  .tb {
    width: 32px;
    height: 30px;
    display: grid;
    place-items: center;
    background: none;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.05rem;
  }
  .tb:hover {
    background: var(--hover);
    color: var(--text);
  }
  .sys {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 48px 6px 34px;
    margin-top: 8px;
    color: var(--text-muted);
    font-size: 0.92rem;
  }
  .sys > span:not(.sysicon) {
    flex: 1;
  }
  .sysicon {
    color: var(--text-faint);
    display: inline-grid;
    width: 22px;
    flex: none;
    padding-top: 1px;
  }
  .sysicon.join {
    color: var(--success);
  }
  .sysicon.leave {
    color: var(--danger);
  }
  .sysicon.lvl {
    color: var(--warning);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--text);
    font-weight: 600;
    cursor: pointer;
    font-size: inherit;
  }
  .link:hover {
    text-decoration: underline;
  }
  .gamewrap,
  .automod {
    flex: 1;
    min-width: 0;
  }
  .automod {
    border-left: 3px solid var(--warning);
    padding-left: 10px;
  }
  .automod blockquote {
    margin: 4px 0;
    color: var(--text);
    white-space: pre-wrap;
  }
  .blocked {
    padding: 6px 16px 6px 72px;
    color: var(--text-faint);
    font-size: 0.85rem;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .menu-item.sub {
    font-size: 0.82rem;
    padding-left: 30px;
  }
  @media (max-width: 760px) {
    .msg {
      padding-right: 12px;
    }
  }
</style>
