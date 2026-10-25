/**
 * Permission bitflags. Stored as BIGINT in Postgres, sent over the wire as decimal strings.
 *
 * Bits 0-23 can be overridden per channel. Bits 32+ are guild-wide only and are ignored in
 * channel overwrites (the server rejects overwrites that try to set them).
 */
export const Permissions = {
  VIEW_CHANNEL: 1n << 0n,
  SEND_MESSAGES: 1n << 1n,
  READ_MESSAGE_HISTORY: 1n << 2n,
  ADD_REACTIONS: 1n << 3n,
  EMBED_LINKS: 1n << 4n,
  ATTACH_FILES: 1n << 5n,
  MENTION_EVERYONE: 1n << 6n,
  USE_EXTERNAL_EMOJIS: 1n << 7n,
  USE_EXTERNAL_STICKERS: 1n << 8n,
  MANAGE_MESSAGES: 1n << 9n,
  CREATE_THREADS: 1n << 10n,
  SEND_MESSAGES_IN_THREADS: 1n << 11n,
  MANAGE_THREADS: 1n << 12n,
  CONNECT: 1n << 13n,
  SPEAK: 1n << 14n,
  STREAM: 1n << 15n,
  MUTE_MEMBERS: 1n << 16n,
  DEAFEN_MEMBERS: 1n << 17n,
  MOVE_MEMBERS: 1n << 18n,
  USE_ACTIVITIES: 1n << 19n,
  CREATE_INVITE: 1n << 20n,
  MANAGE_CHANNELS: 1n << 21n,
  /** Guild-wide: manage roles. In a channel overwrite: manage that channel's permissions. */
  MANAGE_ROLES: 1n << 22n,
  MANAGE_WIKI: 1n << 23n,

  CHANGE_NICKNAME: 1n << 32n,
  MANAGE_NICKNAMES: 1n << 33n,
  MANAGE_EMOJIS: 1n << 34n,
  KICK_MEMBERS: 1n << 35n,
  BAN_MEMBERS: 1n << 36n,
  MODERATE_MEMBERS: 1n << 37n,
  VIEW_AUDIT_LOG: 1n << 38n,
  MANAGE_GUILD: 1n << 39n,
  ADMINISTRATOR: 1n << 40n,
} as const;

export type PermissionName = keyof typeof Permissions;

export const ALL_PERMISSIONS: bigint = Object.values(Permissions).reduce((a, b) => a | b, 0n);

/** Bits that may appear in a channel permission overwrite. */
export const CHANNEL_PERMISSIONS: bigint = (1n << 24n) - 1n;

export const DEFAULT_EVERYONE_PERMISSIONS: bigint =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.ADD_REACTIONS |
  Permissions.EMBED_LINKS |
  Permissions.ATTACH_FILES |
  Permissions.USE_EXTERNAL_EMOJIS |
  Permissions.USE_EXTERNAL_STICKERS |
  Permissions.CREATE_THREADS |
  Permissions.SEND_MESSAGES_IN_THREADS |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.STREAM |
  Permissions.USE_ACTIVITIES |
  Permissions.CREATE_INVITE |
  Permissions.CHANGE_NICKNAME;

/** What a timed-out member keeps. */
export const TIMEOUT_ALLOWED: bigint = Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY;

export const PERMISSION_INFO: Record<PermissionName, { label: string; description: string; channel: boolean }> = {
  VIEW_CHANNEL: { label: 'View channels', description: 'See the channel and read new messages.', channel: true },
  SEND_MESSAGES: { label: 'Send messages', description: 'Post messages in text channels.', channel: true },
  READ_MESSAGE_HISTORY: { label: 'Read message history', description: 'Read messages sent before they opened the channel.', channel: true },
  ADD_REACTIONS: { label: 'Add reactions', description: 'Add new reactions to messages.', channel: true },
  EMBED_LINKS: { label: 'Embed links', description: 'Links they post get a preview.', channel: true },
  ATTACH_FILES: { label: 'Attach files', description: 'Upload files and images.', channel: true },
  MENTION_EVERYONE: { label: 'Mention @everyone and all roles', description: 'Use @everyone, @here and ping roles that are not mentionable.', channel: true },
  USE_EXTERNAL_EMOJIS: { label: 'Use emoji from other servers', description: 'Use custom emoji from other servers they are in.', channel: true },
  USE_EXTERNAL_STICKERS: { label: 'Use stickers from other servers', description: 'Use stickers from other servers they are in.', channel: true },
  MANAGE_MESSAGES: { label: 'Manage messages', description: 'Delete and pin other people\'s messages.', channel: true },
  CREATE_THREADS: { label: 'Create threads', description: 'Start new threads.', channel: true },
  SEND_MESSAGES_IN_THREADS: { label: 'Send messages in threads', description: 'Reply inside threads.', channel: true },
  MANAGE_THREADS: { label: 'Manage threads', description: 'Rename, lock, archive and delete threads.', channel: true },
  CONNECT: { label: 'Connect', description: 'Join voice channels.', channel: true },
  SPEAK: { label: 'Speak', description: 'Talk in voice channels.', channel: true },
  STREAM: { label: 'Video and screen share', description: 'Turn on camera or share their screen.', channel: true },
  MUTE_MEMBERS: { label: 'Mute members', description: 'Server-mute other people in voice.', channel: true },
  DEAFEN_MEMBERS: { label: 'Deafen members', description: 'Server-deafen other people in voice.', channel: true },
  MOVE_MEMBERS: { label: 'Move members', description: 'Move people between voice channels or disconnect them.', channel: true },
  USE_ACTIVITIES: { label: 'Use activities', description: 'Start watch-together and mini games.', channel: true },
  CREATE_INVITE: { label: 'Create invites', description: 'Make invite links.', channel: true },
  MANAGE_CHANNELS: { label: 'Manage channels', description: 'Create, edit and delete channels.', channel: true },
  MANAGE_ROLES: { label: 'Manage roles', description: 'Create and edit roles below their highest role, and edit channel permissions.', channel: true },
  MANAGE_WIKI: { label: 'Manage wiki', description: 'Create and edit wiki pages.', channel: true },
  CHANGE_NICKNAME: { label: 'Change own nickname', description: 'Set their own server profile nickname.', channel: false },
  MANAGE_NICKNAMES: { label: 'Manage nicknames', description: 'Change other members\' nicknames.', channel: false },
  MANAGE_EMOJIS: { label: 'Manage emoji and stickers', description: 'Upload and delete custom emoji and stickers.', channel: false },
  KICK_MEMBERS: { label: 'Kick members', description: 'Remove members below them.', channel: false },
  BAN_MEMBERS: { label: 'Ban members', description: 'Ban members below them.', channel: false },
  MODERATE_MEMBERS: { label: 'Time out members', description: 'Stop members below them from chatting for a while.', channel: false },
  VIEW_AUDIT_LOG: { label: 'View audit log', description: 'See who changed what.', channel: false },
  MANAGE_GUILD: { label: 'Manage server', description: 'Edit server name, icon, automod, levels and settings.', channel: false },
  ADMINISTRATOR: { label: 'Administrator', description: 'Every permission, ignores channel overwrites. Hand this out carefully.', channel: false },
};

export function has(perms: bigint, flag: bigint): boolean {
  return (perms & flag) === flag;
}

export function hasAny(perms: bigint, flags: bigint): boolean {
  return (perms & flags) !== 0n;
}

export const OverwriteType = { ROLE: 0, MEMBER: 1 } as const;
export type OverwriteTypeValue = (typeof OverwriteType)[keyof typeof OverwriteType];

export interface PermOverwrite {
  id: string;
  type: OverwriteTypeValue;
  allow: bigint;
  deny: bigint;
}

export interface PermRole {
  id: string;
  permissions: bigint;
  position: number;
}

export interface PermissionInput {
  userId: string;
  guildId: string;
  ownerId: string;
  /** Permissions of the @everyone role (whose id equals the guild id). */
  everyone: bigint;
  /** Roles the member has (excluding @everyone). */
  memberRoles: Pick<PermRole, 'id' | 'permissions'>[];
  /** Channel overwrites. Omit to compute guild-level permissions. */
  overwrites?: PermOverwrite[];
  /** Member is currently timed out. */
  timedOut?: boolean;
}

/**
 * Discord-style permission resolution:
 *  owner -> everything; ADMINISTRATOR -> everything;
 *  base = @everyone | member roles;
 *  then channel overwrites in order: @everyone, roles (all denies then all allows), member;
 *  timed-out members keep only view + read history;
 *  no VIEW_CHANNEL in a channel -> nothing at all in that channel.
 */
export function computePermissions(input: PermissionInput): bigint {
  if (input.userId === input.ownerId) return ALL_PERMISSIONS;

  let perms = input.everyone;
  for (const r of input.memberRoles) perms |= r.permissions;

  if (has(perms, Permissions.ADMINISTRATOR)) return ALL_PERMISSIONS;

  if (input.overwrites) {
    const roleIds = new Set(input.memberRoles.map((r) => r.id));
    const everyoneOw = input.overwrites.find((o) => o.type === OverwriteType.ROLE && o.id === input.guildId);
    if (everyoneOw) {
      perms &= ~(everyoneOw.deny & CHANNEL_PERMISSIONS);
      perms |= everyoneOw.allow & CHANNEL_PERMISSIONS;
    }
    let allow = 0n;
    let deny = 0n;
    for (const o of input.overwrites) {
      if (o.type === OverwriteType.ROLE && o.id !== input.guildId && roleIds.has(o.id)) {
        allow |= o.allow;
        deny |= o.deny;
      }
    }
    perms &= ~(deny & CHANNEL_PERMISSIONS);
    perms |= allow & CHANNEL_PERMISSIONS;
    const memberOw = input.overwrites.find((o) => o.type === OverwriteType.MEMBER && o.id === input.userId);
    if (memberOw) {
      perms &= ~(memberOw.deny & CHANNEL_PERMISSIONS);
      perms |= memberOw.allow & CHANNEL_PERMISSIONS;
    }
  }

  if (input.timedOut) perms &= TIMEOUT_ALLOWED;

  if (input.overwrites && !has(perms, Permissions.VIEW_CHANNEL)) return 0n;

  return perms;
}

/** Highest role position the member holds. @everyone is position 0. */
export function highestPosition(memberRoleIds: Iterable<string>, roles: Map<string, Pick<PermRole, 'position'>>): number {
  let max = 0;
  for (const id of memberRoleIds) {
    const r = roles.get(id);
    if (r && r.position > max) max = r.position;
  }
  return max;
}

export interface HierarchyMember {
  userId: string;
  highest: number;
}

/** Can `actor` kick/ban/timeout/nickname `target`? Nobody can act on the owner; owner can act on anyone else. */
export function canActOn(actor: HierarchyMember, target: HierarchyMember, ownerId: string): boolean {
  if (actor.userId === target.userId) return false;
  if (target.userId === ownerId) return false;
  if (actor.userId === ownerId) return true;
  return actor.highest > target.highest;
}

/** Can someone with this highest position edit/assign a role at `rolePosition`? */
export function canManageRole(actorHighest: number, rolePosition: number, isOwner: boolean): boolean {
  if (isOwner) return true;
  return rolePosition < actorHighest;
}

/**
 * When a non-owner, non-admin edits a role or overwrite, every bit they grant or deny must be one they hold.
 * Returns the offending bits (0n means OK).
 */
export function missingForGrant(actorPerms: bigint, requested: bigint): bigint {
  if (has(actorPerms, Permissions.ADMINISTRATOR)) return 0n;
  return requested & ~actorPerms;
}

export function permissionNames(perms: bigint): PermissionName[] {
  return (Object.keys(Permissions) as PermissionName[]).filter((k) => has(perms, Permissions[k]));
}

export function parsePermissions(value: string | number | bigint): bigint {
  const v = typeof value === 'bigint' ? value : BigInt(value);
  return v & ALL_PERMISSIONS;
}
