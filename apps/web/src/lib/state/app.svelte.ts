import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  ChannelType,
  MessageFlags,
  Permissions as P,
  RelationshipType,
  compareIds,
  computePermissions,
  defaultSettings,
  has,
  isDmType,
  plainPreview,
  type BookmarkFolder,
  type Channel,
  type ChannelNotificationSettings,
  type ClientSettings,
  type CustomEmoji,
  type FullGuild,
  type GameSession,
  type GatewayEventName,
  type GatewayEvents,
  type Guild,
  type GuildMember,
  type GuildNotificationSettings,
  type InstanceInfo,
  type Message,
  type Presence,
  type PublicUser,
  type ReadState,
  type Relationship,
  type Role,
  type ScheduledMessage,
  type SelfUser,
  type Sticker,
  type VoiceState,
  type WatchState,
  type WikiPage,
  type UserProfile,
} from '@dbb/shared';
import { Gateway } from '../gateway';
import { api, get, post } from '../api';
import { applyTheme } from '../theme';
import { notify } from '../util/notify';

export class GuildState {
  guild = $state<Guild>(null as unknown as Guild);
  roles = new SvelteMap<string, Role>();
  channels = new SvelteMap<string, Channel>();
  threads = new SvelteMap<string, Channel>();
  members = new SvelteMap<string, GuildMember>();
  emojis = $state<CustomEmoji[]>([]);
  stickers = $state<Sticker[]>([]);
  voice = new SvelteMap<string, VoiceState>();
  permissions = $state<bigint>(0n);

  constructor(fg: FullGuild) {
    this.load(fg);
  }

  load(fg: FullGuild) {
    const { roles, channels, threads, members, emojis, stickers, voiceStates, permissions, ...g } = fg;
    this.guild = g;
    this.roles.clear();
    for (const r of roles) this.roles.set(r.id, r);
    this.channels.clear();
    for (const c of channels) this.channels.set(c.id, c);
    this.threads.clear();
    for (const t of threads) this.threads.set(t.id, t);
    this.members.clear();
    for (const m of members) this.members.set(m.user.id, m);
    this.emojis = emojis;
    this.stickers = stickers;
    this.voice.clear();
    for (const v of voiceStates) this.voice.set(v.userId, v);
    this.permissions = BigInt(permissions);
  }

  get sortedRoles(): Role[] {
    return [...this.roles.values()].sort((a, b) => b.position - a.position);
  }
}

export class ChannelMessages {
  list = $state<(Message & { pending?: 'sending' | 'failed'; localFiles?: string[] })[]>([]);
  hasMoreBefore = $state(true);
  hasMoreAfter = $state(false);
  loading = $state(false);
  loaded = $state(false);
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

let toastId = 0;

class AppState {
  status = $state<'loading' | 'ready' | 'loggedout'>('loading');
  connection = $state<'connecting' | 'open' | 'closed'>('closed');
  me = $state<SelfUser | null>(null);
  settings = $state<ClientSettings>(defaultSettings());
  instance = $state<InstanceInfo | null>(null);
  sessionId = $state<string | null>(null);

  guilds = new SvelteMap<string, GuildState>();
  dms = new SvelteMap<string, Channel>();
  users = new SvelteMap<string, PublicUser>();
  presences = new SvelteMap<string, Presence>();
  relationships = new SvelteMap<string, Relationship>();
  readStates = new SvelteMap<string, ReadState>();
  messages = new SvelteMap<string, ChannelMessages>();
  typing = new SvelteMap<string, SvelteMap<string, number>>();
  guildNotif = new SvelteMap<string, GuildNotificationSettings>();
  channelNotif = new SvelteMap<string, ChannelNotificationSettings>();
  bookmarkFolders = $state<BookmarkFolder[]>([]);
  bookmarkIds = new SvelteSet<string>();
  scheduled = $state<ScheduledMessage[]>([]);
  watch = new SvelteMap<string, WatchState>();
  games = new SvelteMap<string, GameSession>();
  receipts = new SvelteMap<string, SvelteMap<string, string>>();
  wiki = new SvelteMap<string, WikiPage[]>();
  profiles = new SvelteMap<string, UserProfile>();
  toasts = $state<Toast[]>([]);

  /** Channel the user is looking at (for acks and notifications). */
  focusedChannel = $state<string | null>(null);
  windowFocused = $state(true);

  private channelGuild = new Map<string, string | null>();
  gateway: Gateway;

  constructor() {
    this.gateway = new Gateway(
      (t, d) => this.handle(t, d),
      (s) => (this.connection = s),
      () => this.loggedOut(),
    );
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => {
        this.windowFocused = true;
        if (this.focusedChannel) this.ack(this.focusedChannel);
      });
      window.addEventListener('blur', () => (this.windowFocused = false));
      setInterval(() => this.expireTyping(), 2000);
    }
  }

  // ---------------- lifecycle ----------------

  async start() {
    try {
      this.instance = await get<InstanceInfo>('/instance');
    } catch {
      /* offline; gateway retries */
    }
    this.gateway.connect();
  }

  stop() {
    this.gateway.disconnect();
  }

  loggedOut() {
    this.gateway.disconnect();
    this.status = 'loggedout';
    this.me = null;
    this.guilds.clear();
    this.dms.clear();
    if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    }
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const id = ++toastId;
    this.toasts = [...this.toasts, { id, text, kind }];
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500);
  }

  // ---------------- lookups ----------------

  channel(id: string | null | undefined): Channel | null {
    if (!id) return null;
    const dm = this.dms.get(id);
    if (dm) return dm;
    const gid = this.channelGuild.get(id);
    if (gid) {
      const g = this.guilds.get(gid);
      return g?.channels.get(id) ?? g?.threads.get(id) ?? null;
    }
    for (const g of this.guilds.values()) {
      const c = g.channels.get(id) ?? g.threads.get(id);
      if (c) return c;
    }
    return null;
  }

  guildOf(channelId: string): GuildState | null {
    const c = this.channel(channelId);
    return c?.guildId ? (this.guilds.get(c.guildId) ?? null) : null;
  }

  user(id: string | null | undefined): PublicUser | null {
    if (!id) return null;
    if (this.me && id === this.me.id) return this.me;
    return this.users.get(id) ?? null;
  }

  member(guildId: string | null | undefined, userId: string): GuildMember | null {
    if (!guildId) return null;
    return this.guilds.get(guildId)?.members.get(userId) ?? null;
  }

  displayName(userId: string, guildId?: string | null): string {
    const m = guildId ? this.member(guildId, userId) : null;
    if (m?.nickname) return m.nickname;
    const u = this.user(userId) ?? m?.user;
    if (!u) return 'Unknown user';
    if (u.deleted) return 'Deleted user';
    return u.displayName || u.username;
  }

  avatarOf(userId: string, guildId?: string | null): string | null {
    const m = guildId ? this.member(guildId, userId) : null;
    return m?.avatar ?? this.user(userId)?.avatar ?? m?.user.avatar ?? null;
  }

  roleColor(guildId: string | null | undefined, userId: string): string | null {
    if (!guildId) return null;
    const g = this.guilds.get(guildId);
    const m = g?.members.get(userId);
    if (!g || !m) return null;
    let best: Role | null = null;
    for (const id of m.roles) {
      const r = g.roles.get(id);
      if (r && r.color && (!best || r.position > best.position)) best = r;
    }
    return best ? `#${best.color.toString(16).padStart(6, '0')}` : null;
  }

  presence(userId: string): Presence {
    return (
      this.presences.get(userId) ?? { userId, status: 'offline', customStatus: null, playing: null, listening: null, lastSeenAt: null }
    );
  }

  /** Client-side permission check for showing/hiding UI. The server enforces everything regardless. */
  perms(guildId: string | null | undefined, channelId?: string | null): bigint {
    if (!guildId) {
      return P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS | P.EMBED_LINKS | P.ATTACH_FILES | P.USE_EXTERNAL_EMOJIS | P.USE_ACTIVITIES;
    }
    const g = this.guilds.get(guildId);
    const me = this.me;
    if (!g || !me) return 0n;
    const m = g.members.get(me.id);
    if (!m) return 0n;
    let ch = channelId ? (g.channels.get(channelId) ?? g.threads.get(channelId)) : null;
    if (ch?.type === ChannelType.THREAD && ch.parentId) ch = g.channels.get(ch.parentId) ?? null;
    return computePermissions({
      userId: me.id,
      guildId,
      ownerId: g.guild.ownerId,
      everyone: BigInt(g.roles.get(guildId)?.permissions ?? '0'),
      memberRoles: m.roles.map((id) => g.roles.get(id)).filter((r): r is Role => !!r).map((r) => ({ id: r.id, permissions: BigInt(r.permissions) })),
      overwrites: ch ? ch.overwrites.map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) })) : undefined,
      timedOut: !!m.timeoutUntil && new Date(m.timeoutUntil).getTime() > Date.now(),
    });
  }

  can(flag: bigint, guildId: string | null | undefined, channelId?: string | null): boolean {
    return has(this.perms(guildId, channelId), flag);
  }

  // ---------------- unreads ----------------

  isUnread(channelId: string): boolean {
    const c = this.channel(channelId);
    if (!c?.lastMessageId) return false;
    const rs = this.readStates.get(channelId);
    return compareIds(c.lastMessageId, rs?.lastReadId ?? '0') > 0;
  }

  mentions(channelId: string): number {
    return this.readStates.get(channelId)?.mentionCount ?? 0;
  }

  isChannelMuted(channelId: string): boolean {
    const cn = this.channelNotif.get(channelId);
    if (cn?.mutedUntil && new Date(cn.mutedUntil).getTime() > Date.now()) return true;
    const c = this.channel(channelId);
    if (c?.parentId) {
      const pn = this.channelNotif.get(c.parentId);
      if (pn?.mutedUntil && new Date(pn.mutedUntil).getTime() > Date.now()) return true;
    }
    return false;
  }

  isGuildMuted(guildId: string): boolean {
    const gn = this.guildNotif.get(guildId);
    return !!gn?.mutedUntil && new Date(gn.mutedUntil).getTime() > Date.now();
  }

  guildUnread(guildId: string): { unread: boolean; mentions: number } {
    const g = this.guilds.get(guildId);
    if (!g) return { unread: false, mentions: 0 };
    let unread = false;
    let mentions = 0;
    const muted = this.isGuildMuted(guildId);
    for (const c of [...g.channels.values(), ...g.threads.values()]) {
      if (c.type === ChannelType.CATEGORY || c.type === ChannelType.WIKI) continue;
      mentions += this.mentions(c.id);
      if (!muted && !this.isChannelMuted(c.id) && this.isUnread(c.id)) unread = true;
    }
    return { unread, mentions };
  }

  get dmMentionTotal(): number {
    let n = 0;
    for (const c of this.dms.values()) n += this.mentions(c.id);
    return n;
  }

  private ackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Mark a channel read (debounced). */
  ack(channelId: string) {
    if (!this.isUnread(channelId) && !this.mentions(channelId)) return;
    clearTimeout(this.ackTimers.get(channelId));
    this.ackTimers.set(
      channelId,
      setTimeout(async () => {
        const c = this.channel(channelId);
        if (!c?.lastMessageId) return;
        this.readStates.set(channelId, { channelId, lastReadId: c.lastMessageId, mentionCount: 0 });
        await post(`/channels/${channelId}/ack`, { messageId: c.lastMessageId }).catch(() => {});
      }, 600),
    );
  }

  // ---------------- messages ----------------

  msgs(channelId: string): ChannelMessages {
    let m = this.messages.get(channelId);
    if (!m) {
      m = new ChannelMessages();
      this.messages.set(channelId, m);
    }
    return m;
  }

  async loadMessages(channelId: string, mode: 'latest' | 'before' | 'after' | 'around' = 'latest', around?: string) {
    const cm = this.msgs(channelId);
    if (cm.loading) return;
    cm.loading = true;
    try {
      let q = 'limit=50';
      if (mode === 'before' && cm.list.length) q += `&before=${cm.list[0]!.id}`;
      if (mode === 'after' && cm.list.length) q += `&after=${cm.list[cm.list.length - 1]!.id}`;
      if (mode === 'around' && around) q += `&around=${around}`;
      const page = (await get<Message[]>(`/channels/${channelId}/messages?${q}`)).reverse();
      for (const m of page) if (m.author) this.users.set(m.author.id, m.author);
      if (mode === 'latest' || mode === 'around') {
        cm.list = page;
        cm.hasMoreBefore = page.length >= (mode === 'around' ? 20 : 50);
        cm.hasMoreAfter = mode === 'around';
      } else if (mode === 'before') {
        cm.list = [...page, ...cm.list];
        cm.hasMoreBefore = page.length >= 50;
        // keep memory bounded: drop the newest messages beyond 300 when scrolling far back
        if (cm.list.length > 300) {
          cm.list = cm.list.slice(0, 300);
          cm.hasMoreAfter = true;
        }
      } else {
        cm.list = [...cm.list, ...page];
        cm.hasMoreAfter = page.length >= 50;
        if (cm.list.length > 300) {
          cm.list = cm.list.slice(cm.list.length - 300);
          cm.hasMoreBefore = true;
        }
      }
      cm.loaded = true;
    } finally {
      cm.loading = false;
    }
  }

  upsertMessage(m: Message) {
    const cm = this.messages.get(m.channelId);
    if (!cm || !cm.loaded) return;
    const i = cm.list.findIndex((x) => x.id === m.id || (m.nonce && x.nonce === m.nonce && x.pending));
    if (i >= 0) {
      cm.list[i] = m;
      return;
    }
    if (cm.hasMoreAfter) return; // we're looking at history; the live tail isn't loaded
    cm.list.push(m);
    if (cm.list.length > 300) {
      cm.list.splice(0, cm.list.length - 300);
      cm.hasMoreBefore = true;
    }
  }

  private patchChannel(id: string, patch: Partial<Channel>) {
    const dm = this.dms.get(id);
    if (dm) return this.dms.set(id, { ...dm, ...patch });
    for (const g of this.guilds.values()) {
      const c = g.channels.get(id);
      if (c) return g.channels.set(id, { ...c, ...patch });
      const t = g.threads.get(id);
      if (t) return g.threads.set(id, { ...t, ...patch });
    }
  }

  // ---------------- profiles ----------------

  async profile(userId: string, guildId?: string | null, force = false): Promise<UserProfile> {
    const key = `${userId}:${guildId ?? ''}`;
    const cached = this.profiles.get(key);
    if (cached && !force) return cached;
    const p = await get<UserProfile>(`/users/${userId}/profile${guildId ? `?guildId=${guildId}` : ''}`);
    this.profiles.set(key, p);
    this.users.set(p.id, { id: p.id, username: p.username, displayName: p.displayName, avatar: p.avatar, deleted: p.deleted });
    return p;
  }

  invalidateProfile(userId: string) {
    for (const k of [...this.profiles.keys()]) if (k.startsWith(userId + ':')) this.profiles.delete(k);
  }

  // ---------------- settings ----------------

  async updateSettings(patch: Partial<ClientSettings>) {
    this.settings = { ...this.settings, ...patch };
    applyTheme(this.settings);
    try {
      this.settings = await api<ClientSettings>('PATCH', '/users/@me/settings', patch);
    } catch (e) {
      this.toast(String((e as Error).message), 'error');
    }
  }

  // ---------------- typing ----------------

  private expireTyping() {
    const now = Date.now();
    for (const [cid, users] of this.typing) {
      for (const [uid, exp] of users) if (exp < now) users.delete(uid);
      if (!users.size) this.typing.delete(cid);
    }
  }

  typingIn(channelId: string): string[] {
    const t = this.typing.get(channelId);
    return t ? [...t.keys()].filter((u) => u !== this.me?.id) : [];
  }

  // ---------------- gateway events ----------------

  private indexGuildChannels(g: GuildState) {
    for (const id of g.channels.keys()) this.channelGuild.set(id, g.guild.id);
    for (const id of g.threads.keys()) this.channelGuild.set(id, g.guild.id);
  }

  private rememberUsers(users: (PublicUser | null | undefined)[]) {
    for (const u of users) if (u && u.id !== this.me?.id) this.users.set(u.id, u);
  }

  handle<K extends GatewayEventName>(t: K, raw: GatewayEvents[K]) {
    const d = raw as never as GatewayEvents[GatewayEventName] & Record<string, unknown>;
    switch (t) {
      case 'READY': {
        const r = raw as GatewayEvents['READY'];
        this.me = r.user;
        this.settings = r.settings;
        this.instance = r.instance;
        this.sessionId = r.sessionId;
        applyTheme(this.settings);
        this.guilds.clear();
        this.channelGuild.clear();
        for (const fg of r.guilds) {
          const gs = new GuildState(fg);
          this.guilds.set(fg.id, gs);
          this.indexGuildChannels(gs);
          this.rememberUsers(fg.members.map((m) => m.user));
        }
        this.dms.clear();
        for (const c of r.dms) {
          this.dms.set(c.id, c);
          this.channelGuild.set(c.id, null);
          this.rememberUsers(c.recipients ?? []);
        }
        this.relationships.clear();
        for (const rel of r.relationships) {
          this.relationships.set(rel.user.id, rel);
          this.rememberUsers([rel.user]);
        }
        this.readStates.clear();
        for (const rs of r.readStates) this.readStates.set(rs.channelId, rs);
        this.presences.clear();
        for (const p of r.presences) this.presences.set(p.userId, p);
        this.guildNotif.clear();
        for (const g of r.guildNotificationSettings) this.guildNotif.set(g.guildId, g);
        this.channelNotif.clear();
        for (const c of r.channelNotificationSettings) this.channelNotif.set(c.channelId, c);
        this.bookmarkFolders = r.bookmarkFolders;
        // stale message caches after a reconnect: reload whatever is open
        for (const [cid, cm] of this.messages) {
          if (cid === this.focusedChannel) void this.loadMessages(cid);
          else this.messages.delete(cid);
          void cm;
        }
        this.status = 'ready';
        void get<ScheduledMessage[]>('/users/@me/scheduled-messages').then((s) => (this.scheduled = s)).catch(() => {});
        return;
      }
      case 'SELF_UPDATE':
        this.me = raw as SelfUser;
        this.invalidateProfile(this.me.id);
        return;
      case 'SETTINGS_UPDATE':
        this.settings = raw as ClientSettings;
        applyTheme(this.settings);
        return;
      case 'USER_UPDATE': {
        const u = raw as PublicUser;
        if (u.id === this.me?.id) this.me = { ...this.me, ...u };
        else this.users.set(u.id, u);
        for (const g of this.guilds.values()) {
          const m = g.members.get(u.id);
          if (m) g.members.set(u.id, { ...m, user: u });
        }
        this.invalidateProfile(u.id);
        return;
      }
      case 'PRESENCE_UPDATE': {
        const p = raw as Presence;
        this.presences.set(p.userId, p);
        return;
      }
      case 'RELATIONSHIP_ADD': {
        const r = raw as Relationship;
        const prev = this.relationships.get(r.user.id);
        this.relationships.set(r.user.id, r);
        this.users.set(r.user.id, r.user);
        if (r.type === RelationshipType.INCOMING && prev?.type !== RelationshipType.INCOMING) {
          notify(this, { title: 'Friend request', body: `${r.user.displayName || r.user.username} wants to be friends`, url: '/app/me' });
        }
        return;
      }
      case 'RELATIONSHIP_REMOVE':
        this.relationships.delete((raw as { userId: string }).userId);
        return;
      case 'GUILD_CREATE': {
        const fg = raw as FullGuild;
        const existing = this.guilds.get(fg.id);
        if (existing) existing.load(fg);
        else this.guilds.set(fg.id, new GuildState(fg));
        this.indexGuildChannels(this.guilds.get(fg.id)!);
        this.rememberUsers(fg.members.map((m) => m.user));
        return;
      }
      case 'GUILD_UPDATE': {
        const g = this.guilds.get((raw as Guild).id);
        if (g) g.guild = raw as Guild;
        return;
      }
      case 'GUILD_DELETE': {
        const id = (raw as { id: string }).id;
        const g = this.guilds.get(id);
        if (g) for (const cid of [...g.channels.keys(), ...g.threads.keys()]) this.messages.delete(cid);
        this.guilds.delete(id);
        if (typeof location !== 'undefined' && location.pathname.startsWith(`/app/${id}`)) location.href = '/app/me';
        return;
      }
      case 'GUILD_PERMISSIONS_UPDATE': {
        const x = raw as { guildId: string; permissions: string };
        const g = this.guilds.get(x.guildId);
        if (g) g.permissions = BigInt(x.permissions);
        return;
      }
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE': {
        const m = raw as GuildMember;
        this.guilds.get(m.guildId)?.members.set(m.user.id, m);
        this.rememberUsers([m.user]);
        if (m.user.id !== this.me?.id) this.invalidateProfile(m.user.id);
        return;
      }
      case 'GUILD_MEMBER_REMOVE': {
        const x = raw as { guildId: string; userId: string };
        this.guilds.get(x.guildId)?.members.delete(x.userId);
        this.guilds.get(x.guildId)?.voice.delete(x.userId);
        return;
      }
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const r = raw as Role;
        this.guilds.get(r.guildId)?.roles.set(r.id, r);
        return;
      }
      case 'GUILD_ROLE_DELETE': {
        const x = raw as { guildId: string; roleId: string };
        const g = this.guilds.get(x.guildId);
        if (!g) return;
        g.roles.delete(x.roleId);
        for (const [uid, m] of g.members) if (m.roles.includes(x.roleId)) g.members.set(uid, { ...m, roles: m.roles.filter((r) => r !== x.roleId) });
        return;
      }
      case 'GUILD_EMOJIS_UPDATE': {
        const x = raw as { guildId: string; emojis: CustomEmoji[] };
        const g = this.guilds.get(x.guildId);
        if (g) g.emojis = x.emojis;
        return;
      }
      case 'GUILD_STICKERS_UPDATE': {
        const x = raw as { guildId: string; stickers: Sticker[] };
        const g = this.guilds.get(x.guildId);
        if (g) g.stickers = x.stickers;
        return;
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const c = raw as Channel;
        if (isDmType(c.type)) {
          this.dms.set(c.id, c);
          this.channelGuild.set(c.id, null);
          this.rememberUsers(c.recipients ?? []);
        } else if (c.guildId) {
          this.guilds.get(c.guildId)?.channels.set(c.id, c);
          this.channelGuild.set(c.id, c.guildId);
        }
        return;
      }
      case 'CHANNEL_DELETE': {
        const x = raw as { id: string; guildId: string | null };
        if (x.guildId) this.guilds.get(x.guildId)?.channels.delete(x.id);
        else this.dms.delete(x.id);
        this.messages.delete(x.id);
        this.channelGuild.delete(x.id);
        return;
      }
      case 'THREAD_CREATE':
      case 'THREAD_UPDATE': {
        const c = raw as Channel;
        if (!c.guildId) return;
        const g = this.guilds.get(c.guildId);
        if (!g) return;
        if (c.threadMeta?.archived && !this.focusedChannel?.includes(c.id)) g.threads.delete(c.id);
        else g.threads.set(c.id, c);
        this.channelGuild.set(c.id, c.guildId);
        return;
      }
      case 'THREAD_DELETE': {
        const x = raw as { id: string; guildId: string };
        this.guilds.get(x.guildId)?.threads.delete(x.id);
        this.messages.delete(x.id);
        return;
      }
      case 'MESSAGE_CREATE': {
        const m = raw as Message;
        if (m.author) this.rememberUsers([m.author]);
        this.upsertMessage(m);
        this.patchChannel(m.channelId, { lastMessageId: m.id });
        if (m.threadId) {
          /* thread starter update arrives as MESSAGE_UPDATE */
        }
        const mine = m.author?.id === this.me?.id;
        if (mine) {
          this.readStates.set(m.channelId, { channelId: m.channelId, lastReadId: m.id, mentionCount: 0 });
        } else {
          const looking = this.focusedChannel === m.channelId && this.windowFocused && typeof document !== 'undefined' && !document.hidden;
          if (looking) this.ack(m.channelId);
          else {
            const c = this.channel(m.channelId);
            const mentioned = this.isMentioned(m);
            const isDm = c ? isDmType(c.type) : false;
            if (!(m.flags & MessageFlags.SILENT) && (mentioned || isDm)) {
              const rs = this.readStates.get(m.channelId);
              this.readStates.set(m.channelId, {
                channelId: m.channelId,
                lastReadId: rs?.lastReadId ?? '0',
                mentionCount: (rs?.mentionCount ?? 0) + 1,
              });
            }
            this.maybeNotify(m, mentioned);
          }
        }
        // the typing indicator for that user ends when their message lands
        if (m.author) this.typing.get(m.channelId)?.delete(m.author.id);
        return;
      }
      case 'MESSAGE_UPDATE':
        this.upsertMessage(raw as Message);
        return;
      case 'MESSAGE_DELETE': {
        const x = raw as { id: string; channelId: string };
        const cm = this.messages.get(x.channelId);
        if (cm) cm.list = cm.list.filter((m) => m.id !== x.id);
        this.bookmarkIds.delete(x.id);
        return;
      }
      case 'MESSAGE_DELETE_BULK': {
        const x = raw as { ids: string[]; channelId: string };
        const ids = new Set(x.ids);
        const cm = this.messages.get(x.channelId);
        if (cm) cm.list = cm.list.filter((m) => !ids.has(m.id));
        return;
      }
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE': {
        const x = raw as { channelId: string; messageId: string; userId: string; emoji: string; name?: string; animated?: boolean };
        const cm = this.messages.get(x.channelId);
        const msg = cm?.list.find((m) => m.id === x.messageId);
        if (!msg) return;
        const me = x.userId === this.me?.id;
        const r = msg.reactions.find((y) => y.emoji === x.emoji);
        if (t === 'MESSAGE_REACTION_ADD') {
          if (r) {
            if (me && r.me) return;
            r.count++;
            if (me) r.me = true;
          } else msg.reactions.push({ emoji: x.emoji, name: x.name, animated: x.animated, count: 1, me });
        } else if (r) {
          r.count--;
          if (me) r.me = false;
          if (r.count <= 0) msg.reactions = msg.reactions.filter((y) => y.emoji !== x.emoji);
        }
        return;
      }
      case 'MESSAGE_REACTION_REMOVE_EMOJI': {
        const x = raw as { channelId: string; messageId: string; emoji: string };
        const msg = this.messages.get(x.channelId)?.list.find((m) => m.id === x.messageId);
        if (msg) msg.reactions = msg.reactions.filter((y) => y.emoji !== x.emoji);
        return;
      }
      case 'MESSAGE_ACK': {
        const rs = raw as ReadState;
        this.readStates.set(rs.channelId, rs);
        return;
      }
      case 'DM_READ_RECEIPT': {
        const x = raw as { channelId: string; userId: string; messageId: string };
        let m = this.receipts.get(x.channelId);
        if (!m) {
          m = new SvelteMap();
          this.receipts.set(x.channelId, m);
        }
        m.set(x.userId, x.messageId);
        return;
      }
      case 'TYPING_START': {
        const x = raw as { channelId: string; userId: string };
        let m = this.typing.get(x.channelId);
        if (!m) {
          m = new SvelteMap();
          this.typing.set(x.channelId, m);
        }
        m.set(x.userId, Date.now() + 8000);
        return;
      }
      case 'CHANNEL_PINS_UPDATE':
        return;
      case 'VOICE_STATE_UPDATE': {
        const v = raw as VoiceState | { guildId: string; userId: string; channelId: null };
        const g = this.guilds.get(v.guildId);
        if (!g) return;
        if (v.channelId === null) g.voice.delete(v.userId);
        else g.voice.set(v.userId, v as VoiceState);
        return;
      }
      case 'VOICE_MOVE':
        void import('./voice.svelte').then(({ voice }) => voice.handleMove(raw as GatewayEvents['VOICE_MOVE']));
        return;
      case 'WATCH_STATE': {
        const w = raw as WatchState;
        if (w.videoId) this.watch.set(w.channelId, w);
        else this.watch.delete(w.channelId);
        return;
      }
      case 'GAME_UPDATE': {
        const g = raw as GameSession;
        this.games.set(g.id, g);
        return;
      }
      case 'GAME_DELETE':
        this.games.delete((raw as { id: string }).id);
        return;
      case 'WIKI_PAGE_CREATE':
      case 'WIKI_PAGE_UPDATE': {
        const p = raw as WikiPage;
        const list = this.wiki.get(p.channelId);
        if (!list) return;
        const i = list.findIndex((x) => x.id === p.id);
        const next = i >= 0 ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
        this.wiki.set(p.channelId, next.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position));
        return;
      }
      case 'WIKI_PAGE_DELETE': {
        const x = raw as { id: string; channelId: string };
        const list = this.wiki.get(x.channelId);
        if (list) this.wiki.set(x.channelId, list.filter((p) => p.id !== x.id));
        return;
      }
      case 'SCHEDULED_MESSAGE_CREATE':
      case 'SCHEDULED_MESSAGE_UPDATE': {
        const s = raw as ScheduledMessage;
        this.scheduled = [...this.scheduled.filter((x) => x.id !== s.id), s].sort((a, b) => a.sendAt.localeCompare(b.sendAt));
        return;
      }
      case 'SCHEDULED_MESSAGE_DELETE':
        this.scheduled = this.scheduled.filter((x) => x.id !== (raw as { id: string }).id);
        return;
      case 'BOOKMARK_UPDATE':
        this.bookmarkIds.add((raw as { messageId: string }).messageId);
        return;
      case 'BOOKMARK_DELETE':
        this.bookmarkIds.delete((raw as { messageId: string }).messageId);
        return;
      case 'BOOKMARK_FOLDERS_UPDATE':
        this.bookmarkFolders = (raw as { folders: BookmarkFolder[] }).folders;
        return;
      case 'NOTIFICATION_SETTINGS_UPDATE': {
        const x = raw as GatewayEvents['NOTIFICATION_SETTINGS_UPDATE'];
        if (x.guild) this.guildNotif.set(x.guild.guildId, x.guild);
        if (x.channel) this.channelNotif.set(x.channel.channelId, x.channel);
        return;
      }
      case 'SESSION_REVOKED':
        this.loggedOut();
        return;
    }
    void d;
  }

  isMentioned(m: Message): boolean {
    const me = this.me;
    if (!me) return false;
    if (m.mentions.includes(me.id)) return true;
    if (m.mentionEveryone) {
      const gn = m.guildId ? this.guildNotif.get(m.guildId) : null;
      return !gn?.suppressEveryone;
    }
    if (m.guildId && m.mentionRoles.length) {
      const gn = this.guildNotif.get(m.guildId);
      if (gn?.suppressRoles) return false;
      const mem = this.member(m.guildId, me.id);
      return !!mem && m.mentionRoles.some((r) => mem.roles.includes(r));
    }
    return false;
  }

  private maybeNotify(m: Message, mentioned: boolean) {
    if (m.flags & MessageFlags.SILENT) return;
    if (this.me?.status === 'dnd') return;
    const c = this.channel(m.channelId);
    if (!c) return;
    if (this.isChannelMuted(c.id)) return;
    if (c.guildId && this.isGuildMuted(c.guildId)) return;
    if (m.author && this.relationships.get(m.author.id)?.type === RelationshipType.BLOCKED) return;
    let should = false;
    if (isDmType(c.type)) should = true;
    else {
      const cl = this.channelNotif.get(c.id)?.level ?? -1;
      const level = cl >= 0 ? cl : (this.guildNotif.get(c.guildId!)?.level ?? 1);
      should = level === 0 || (level === 1 && mentioned);
    }
    if (!should) return;
    const who = m.author ? this.displayName(m.author.id, m.guildId) : 'Someone';
    const where = isDmType(c.type) ? '' : ` in #${c.name}`;
    notify(this, {
      title: `${who}${where}`,
      body: plainPreview(m.content) || (m.attachments.length ? '📎 Attachment' : m.sticker ? 'Sticker' : ''),
      url: c.guildId ? `/app/${c.guildId}/${c.id}` : `/app/me/${c.id}`,
      icon: m.author?.avatar ?? undefined,
    });
  }
}

export const app = new AppState();
