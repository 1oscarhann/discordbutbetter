import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  CHANNEL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  OverwriteType,
  Permissions as P,
  TIMEOUT_ALLOWED,
  canActOn,
  canManageRole,
  computePermissions,
  has,
  highestPosition,
  missingForGrant,
  parsePermissions,
  permissionNames,
  type PermOverwrite,
} from '../src/permissions.js';

const GUILD = '100';
const OWNER = '1';
const ALICE = '2';
const MOD_ROLE = '200';
const MUTED_ROLE = '201';
const VIP_ROLE = '202';

const base = {
  guildId: GUILD,
  ownerId: OWNER,
  everyone: DEFAULT_EVERYONE_PERMISSIONS,
};

function ow(id: string, type: 0 | 1, allow: bigint, deny: bigint): PermOverwrite {
  return { id, type, allow, deny };
}

describe('computePermissions: guild level', () => {
  it('owner gets everything even with no roles and a stripped @everyone', () => {
    expect(computePermissions({ ...base, everyone: 0n, userId: OWNER, memberRoles: [] })).toBe(ALL_PERMISSIONS);
  });

  it('a plain member gets exactly @everyone', () => {
    expect(computePermissions({ ...base, userId: ALICE, memberRoles: [] })).toBe(DEFAULT_EVERYONE_PERMISSIONS);
  });

  it('role permissions are OR-ed on top of @everyone', () => {
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [
        { id: MOD_ROLE, permissions: P.KICK_MEMBERS },
        { id: VIP_ROLE, permissions: P.MANAGE_MESSAGES },
      ],
    });
    expect(has(p, P.KICK_MEMBERS)).toBe(true);
    expect(has(p, P.MANAGE_MESSAGES)).toBe(true);
    expect(has(p, P.SEND_MESSAGES)).toBe(true);
    expect(has(p, P.BAN_MEMBERS)).toBe(false);
  });

  it('ADMINISTRATOR from any role grants everything', () => {
    const p = computePermissions({
      ...base,
      everyone: 0n,
      userId: ALICE,
      memberRoles: [{ id: MOD_ROLE, permissions: P.ADMINISTRATOR }],
    });
    expect(p).toBe(ALL_PERMISSIONS);
  });

  it('ADMINISTRATOR on @everyone grants everything to all members', () => {
    expect(computePermissions({ ...base, everyone: P.ADMINISTRATOR, userId: ALICE, memberRoles: [] })).toBe(ALL_PERMISSIONS);
  });
});

describe('computePermissions: channel overwrites', () => {
  it('no VIEW_CHANNEL in a channel means zero permissions there', () => {
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [{ id: MOD_ROLE, permissions: P.MANAGE_MESSAGES }],
      overwrites: [ow(GUILD, OverwriteType.ROLE, 0n, P.VIEW_CHANNEL)],
    });
    expect(p).toBe(0n);
  });

  it('@everyone deny can be re-allowed by a role overwrite (private channel pattern)', () => {
    const overwrites = [ow(GUILD, 0, 0n, P.VIEW_CHANNEL), ow(VIP_ROLE, 0, P.VIEW_CHANNEL, 0n)];
    expect(computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites })).toBe(0n);
    const vip = computePermissions({ ...base, userId: ALICE, memberRoles: [{ id: VIP_ROLE, permissions: 0n }], overwrites });
    expect(has(vip, P.VIEW_CHANNEL)).toBe(true);
    expect(has(vip, P.SEND_MESSAGES)).toBe(true);
  });

  it('role allow beats role deny when the member has both roles (allows applied after denies)', () => {
    const overwrites = [ow(MUTED_ROLE, 0, 0n, P.SEND_MESSAGES), ow(VIP_ROLE, 0, P.SEND_MESSAGES, 0n)];
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [
        { id: MUTED_ROLE, permissions: 0n },
        { id: VIP_ROLE, permissions: 0n },
      ],
      overwrites,
    });
    expect(has(p, P.SEND_MESSAGES)).toBe(true);
  });

  it('member overwrite beats role overwrites', () => {
    const overwrites = [ow(VIP_ROLE, 0, P.SEND_MESSAGES, 0n), ow(ALICE, 1, 0n, P.SEND_MESSAGES)];
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [{ id: VIP_ROLE, permissions: 0n }],
      overwrites,
    });
    expect(has(p, P.SEND_MESSAGES)).toBe(false);
    expect(has(p, P.VIEW_CHANNEL)).toBe(true);
  });

  it('member overwrite can allow what @everyone denies', () => {
    const overwrites = [ow(GUILD, 0, 0n, P.VIEW_CHANNEL), ow(ALICE, 1, P.VIEW_CHANNEL, 0n)];
    expect(has(computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites }), P.VIEW_CHANNEL)).toBe(true);
  });

  it('overwrites for roles the member does not have are ignored', () => {
    const overwrites = [ow(MOD_ROLE, 0, P.MANAGE_MESSAGES, 0n)];
    const p = computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites });
    expect(has(p, P.MANAGE_MESSAGES)).toBe(false);
  });

  it('overwrites for a different member are ignored', () => {
    const overwrites = [ow('999', 1, 0n, P.SEND_MESSAGES)];
    expect(has(computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites }), P.SEND_MESSAGES)).toBe(true);
  });

  it('overwrites can never grant guild-only permissions', () => {
    const overwrites = [ow(ALICE, 1, P.BAN_MEMBERS | P.ADMINISTRATOR | P.MANAGE_GUILD, 0n)];
    const p = computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites });
    expect(has(p, P.BAN_MEMBERS)).toBe(false);
    expect(has(p, P.ADMINISTRATOR)).toBe(false);
    expect(has(p, P.MANAGE_GUILD)).toBe(false);
  });

  it('overwrites can never strip guild-only permissions either', () => {
    const overwrites = [ow(GUILD, 0, 0n, P.KICK_MEMBERS)];
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [{ id: MOD_ROLE, permissions: P.KICK_MEMBERS }],
      overwrites,
    });
    expect(has(p, P.KICK_MEMBERS)).toBe(true);
  });

  it('owner and admins ignore overwrites entirely', () => {
    const overwrites = [ow(GUILD, 0, 0n, P.VIEW_CHANNEL), ow(OWNER, 1, 0n, P.VIEW_CHANNEL)];
    expect(computePermissions({ ...base, userId: OWNER, memberRoles: [], overwrites })).toBe(ALL_PERMISSIONS);
    expect(
      computePermissions({ ...base, userId: ALICE, memberRoles: [{ id: MOD_ROLE, permissions: P.ADMINISTRATOR }], overwrites }),
    ).toBe(ALL_PERMISSIONS);
  });

  it('read-only announcement channel: everyone can view but not send, mods can send', () => {
    const overwrites = [ow(GUILD, 0, 0n, P.SEND_MESSAGES), ow(MOD_ROLE, 0, P.SEND_MESSAGES, 0n)];
    const member = computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites });
    expect(has(member, P.VIEW_CHANNEL)).toBe(true);
    expect(has(member, P.SEND_MESSAGES)).toBe(false);
    const mod = computePermissions({ ...base, userId: ALICE, memberRoles: [{ id: MOD_ROLE, permissions: 0n }], overwrites });
    expect(has(mod, P.SEND_MESSAGES)).toBe(true);
  });
});

describe('computePermissions: timeouts', () => {
  it('timed-out members keep only view + read history', () => {
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [{ id: MOD_ROLE, permissions: P.MANAGE_MESSAGES | P.KICK_MEMBERS }],
      timedOut: true,
    });
    expect(p).toBe(TIMEOUT_ALLOWED);
  });

  it('timeout applies in channels too', () => {
    const p = computePermissions({ ...base, userId: ALICE, memberRoles: [], overwrites: [], timedOut: true });
    expect(p).toBe(TIMEOUT_ALLOWED);
    expect(has(p, P.SEND_MESSAGES)).toBe(false);
    expect(has(p, P.ADD_REACTIONS)).toBe(false);
    expect(has(p, P.CONNECT)).toBe(false);
  });

  it('timeout in a channel they cannot see is still zero', () => {
    const p = computePermissions({
      ...base,
      userId: ALICE,
      memberRoles: [],
      overwrites: [ow(GUILD, 0, 0n, P.VIEW_CHANNEL)],
      timedOut: true,
    });
    expect(p).toBe(0n);
  });

  it('owner and admins are immune to timeouts', () => {
    expect(computePermissions({ ...base, userId: OWNER, memberRoles: [], timedOut: true })).toBe(ALL_PERMISSIONS);
    expect(
      computePermissions({ ...base, userId: ALICE, memberRoles: [{ id: MOD_ROLE, permissions: P.ADMINISTRATOR }], timedOut: true }),
    ).toBe(ALL_PERMISSIONS);
  });
});

describe('hierarchy', () => {
  const roles = new Map([
    [GUILD, { position: 0 }],
    ['r1', { position: 1 }],
    ['r5', { position: 5 }],
    ['r9', { position: 9 }],
  ]);

  it('highestPosition picks the top role and ignores unknown ids', () => {
    expect(highestPosition([], roles)).toBe(0);
    expect(highestPosition(['r1', 'r9', 'r5'], roles)).toBe(9);
    expect(highestPosition(['nope'], roles)).toBe(0);
  });

  it('can act only on members strictly below you', () => {
    expect(canActOn({ userId: 'a', highest: 5 }, { userId: 'b', highest: 1 }, OWNER)).toBe(true);
    expect(canActOn({ userId: 'a', highest: 5 }, { userId: 'b', highest: 5 }, OWNER)).toBe(false);
    expect(canActOn({ userId: 'a', highest: 1 }, { userId: 'b', highest: 5 }, OWNER)).toBe(false);
  });

  it('nobody can act on the owner, the owner can act on anyone', () => {
    expect(canActOn({ userId: 'a', highest: 999 }, { userId: OWNER, highest: 0 }, OWNER)).toBe(false);
    expect(canActOn({ userId: OWNER, highest: 0 }, { userId: 'b', highest: 999 }, OWNER)).toBe(true);
  });

  it('you can never act on yourself', () => {
    expect(canActOn({ userId: 'a', highest: 5 }, { userId: 'a', highest: 1 }, OWNER)).toBe(false);
  });

  it('roles: manage only below your highest, owner manages all', () => {
    expect(canManageRole(5, 4, false)).toBe(true);
    expect(canManageRole(5, 5, false)).toBe(false);
    expect(canManageRole(5, 6, false)).toBe(false);
    expect(canManageRole(0, 100, true)).toBe(true);
  });
});

describe('missingForGrant', () => {
  it('flags bits the actor does not have', () => {
    const actor = P.MANAGE_ROLES | P.SEND_MESSAGES;
    expect(missingForGrant(actor, P.SEND_MESSAGES)).toBe(0n);
    expect(missingForGrant(actor, P.SEND_MESSAGES | P.BAN_MEMBERS)).toBe(P.BAN_MEMBERS);
  });

  it('admins can grant anything', () => {
    expect(missingForGrant(P.ADMINISTRATOR, ALL_PERMISSIONS)).toBe(0n);
  });
});

describe('helpers', () => {
  it('channel mask covers exactly the channel-applicable permissions', () => {
    for (const [name, bit] of Object.entries(P)) {
      const isChannelBit = (bit & CHANNEL_PERMISSIONS) === bit;
      const guildOnly = ['CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'MANAGE_EMOJIS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'VIEW_AUDIT_LOG', 'MANAGE_GUILD', 'ADMINISTRATOR'];
      expect(isChannelBit, name).toBe(!guildOnly.includes(name));
    }
  });

  it('every permission is a distinct single bit', () => {
    const bits = Object.values(P);
    expect(new Set(bits).size).toBe(bits.length);
    for (const b of bits) expect(b & (b - 1n)).toBe(0n);
  });

  it('parsePermissions strips unknown bits', () => {
    expect(parsePermissions((1n << 62n).toString())).toBe(0n);
    expect(parsePermissions(P.KICK_MEMBERS.toString())).toBe(P.KICK_MEMBERS);
  });

  it('permissionNames lists set flags', () => {
    expect(permissionNames(P.KICK_MEMBERS | P.VIEW_CHANNEL).sort()).toEqual(['KICK_MEMBERS', 'VIEW_CHANNEL']);
  });

  it('default @everyone cannot moderate', () => {
    for (const p of [P.KICK_MEMBERS, P.BAN_MEMBERS, P.MANAGE_MESSAGES, P.MANAGE_ROLES, P.MANAGE_CHANNELS, P.ADMINISTRATOR, P.MENTION_EVERYONE]) {
      expect(has(DEFAULT_EVERYONE_PERMISSIONS, p)).toBe(false);
    }
  });
});
