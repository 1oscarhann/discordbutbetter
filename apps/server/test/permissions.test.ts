import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelType, Permissions as P } from '@haunt/shared';
import { createTestApp, guildWith, register, type Client, type TestApp } from './helpers.js';

let t: TestApp;
let owner: Client, mod: Client, alice: Client, bob: Client, outsider: Client;
let guildId: string, general: string, everyoneId: string;

beforeAll(async () => {
  t = await createTestApp();
  owner = await register(t, 'owner');
  mod = await register(t, 'mod');
  alice = await register(t, 'alice');
  bob = await register(t, 'bob');
  outsider = await register(t, 'outsider');
  const g = await guildWith(owner, mod, alice, bob);
  guildId = g.guild.id;
  general = g.general.id;
  everyoneId = guildId;
});
afterAll(async () => t.close());

async function makeRole(perms: bigint, name = 'role') {
  const r = await owner.req('POST', `/api/guilds/${guildId}/roles`, { name, permissions: perms.toString() });
  expect(r.status).toBe(200);
  return r.body.id as string;
}

describe('guild visibility', () => {
  it('non-members get 404 for the guild, its channels and messages', async () => {
    expect((await outsider.req('GET', `/api/guilds/${guildId}`)).status).toBe(404);
    expect((await outsider.req('GET', `/api/channels/${general}/messages`)).status).toBe(404);
    expect((await outsider.req('POST', `/api/channels/${general}/messages`, { content: 'hi' })).status).toBe(404);
  });

  it('members can read and send in general', async () => {
    expect((await alice.req('POST', `/api/channels/${general}/messages`, { content: 'hello' })).status).toBe(200);
    expect((await bob.req('GET', `/api/channels/${general}/messages`)).status).toBe(200);
  });
});

describe('private channels and overwrites', () => {
  let secret: string;
  let vipRole: string;

  it('private channel is invisible to members without access', async () => {
    const c = await owner.req('POST', `/api/guilds/${guildId}/channels`, { name: 'Secret Stuff', type: ChannelType.TEXT, private: true });
    expect(c.status).toBe(200);
    expect(c.body.name).toBe('secret-stuff');
    secret = c.body.id;
    expect((await alice.req('GET', `/api/channels/${secret}`)).status).toBe(404);
    expect((await alice.req('GET', `/api/channels/${secret}/messages`)).status).toBe(404);
    expect((await alice.req('POST', `/api/channels/${secret}/messages`, { content: 'sneaky' })).status).toBe(404);
  });

  it('a role overwrite grants access', async () => {
    vipRole = await makeRole(0n, 'vip');
    expect((await owner.req('PUT', `/api/channels/${secret}/permissions/${vipRole}`, { type: 0, allow: P.VIEW_CHANNEL.toString(), deny: '0' })).status).toBe(200);
    expect((await owner.req('PUT', `/api/guilds/${guildId}/members/${alice.id}/roles/${vipRole}`)).status).toBe(200);
    expect((await alice.req('GET', `/api/channels/${secret}/messages`)).status).toBe(200);
    expect((await bob.req('GET', `/api/channels/${secret}/messages`)).status).toBe(404);
  });

  it('a member overwrite beats the role overwrite', async () => {
    await owner.req('PUT', `/api/channels/${secret}/permissions/${alice.id}`, { type: 1, allow: '0', deny: P.SEND_MESSAGES.toString() });
    expect((await alice.req('GET', `/api/channels/${secret}/messages`)).status).toBe(200);
    expect((await alice.req('POST', `/api/channels/${secret}/messages`, { content: 'x' })).status).toBe(403);
    await owner.req('DELETE', `/api/channels/${secret}/permissions/${alice.id}`);
    expect((await alice.req('POST', `/api/channels/${secret}/messages`, { content: 'x' })).status).toBe(200);
  });

  it('overwrites cannot contain guild-only permissions', async () => {
    const r = await owner.req('PUT', `/api/channels/${secret}/permissions/${vipRole}`, { type: 0, allow: P.BAN_MEMBERS.toString(), deny: '0' });
    expect(r.status).toBe(400);
  });

  it('search never returns messages from channels you cannot see', async () => {
    await owner.req('POST', `/api/channels/${secret}/messages`, { content: 'launchcodes are 1234' });
    await owner.req('POST', `/api/channels/${general}/messages`, { content: 'launchcodes are public here' });
    const b = await bob.req('GET', `/api/guilds/${guildId}/messages/search?q=launchcodes`);
    expect(b.status).toBe(200);
    expect(b.body.messages.map((m: any) => m.channelId)).toEqual([general]);
    const o = await owner.req('GET', `/api/guilds/${guildId}/messages/search?q=launchcode`);
    expect(o.body.total).toBe(2); // prefix match
  });

  it('read-only channel: view but not send', async () => {
    const c = await owner.req('POST', `/api/guilds/${guildId}/channels`, { name: 'announcements', type: ChannelType.TEXT });
    await owner.req('PUT', `/api/channels/${c.body.id}/permissions/${everyoneId}`, { type: 0, allow: '0', deny: P.SEND_MESSAGES.toString() });
    expect((await bob.req('GET', `/api/channels/${c.body.id}/messages`)).status).toBe(200);
    expect((await bob.req('POST', `/api/channels/${c.body.id}/messages`, { content: 'hi' })).status).toBe(403);
    expect((await owner.req('POST', `/api/channels/${c.body.id}/messages`, { content: 'hi' })).status).toBe(200);
  });
});

describe('role hierarchy and grants', () => {
  let modRole: string;
  let highRole: string;

  it('setup: mod gets a role with kick/ban/manage roles', async () => {
    // positions: new roles go to the bottom, so create the high one first
    highRole = await makeRole(0n, 'high');
    modRole = await makeRole(P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_ROLES | P.MANAGE_MESSAGES | P.MODERATE_MEMBERS, 'moderator');
    const roles = (await owner.req('GET', `/api/guilds/${guildId}/roles`)).body;
    const pos = (id: string) => roles.find((r: any) => r.id === id).position;
    expect(pos(highRole)).toBeGreaterThan(pos(modRole));
    expect((await owner.req('PUT', `/api/guilds/${guildId}/members/${mod.id}/roles/${modRole}`)).status).toBe(200);
  });

  it('cannot grant permissions you do not have', async () => {
    const r = await mod.req('POST', `/api/guilds/${guildId}/roles`, { name: 'evil', permissions: P.ADMINISTRATOR.toString() });
    expect(r.status).toBe(403);
    const ok = await mod.req('POST', `/api/guilds/${guildId}/roles`, { name: 'kicker', permissions: P.KICK_MEMBERS.toString() });
    expect(ok.status).toBe(200);
  });

  it('cannot assign roles at or above your highest role', async () => {
    expect((await mod.req('PUT', `/api/guilds/${guildId}/members/${bob.id}/roles/${highRole}`)).status).toBe(403);
    expect((await mod.req('PUT', `/api/guilds/${guildId}/members/${bob.id}/roles/${modRole}`)).status).toBe(403);
  });

  it('cannot edit a role above you, or edit @everyone name', async () => {
    expect((await mod.req('PATCH', `/api/guilds/${guildId}/roles/${highRole}`, { name: 'mine' })).status).toBe(403);
    expect((await owner.req('PATCH', `/api/guilds/${guildId}/roles/${everyoneId}`, { name: 'all' })).status).toBe(400);
  });

  it('cannot kick or ban the owner or someone higher', async () => {
    expect((await mod.req('DELETE', `/api/guilds/${guildId}/members/${owner.id}`, {})).status).toBe(403);
    await owner.req('PUT', `/api/guilds/${guildId}/members/${alice.id}/roles/${highRole}`);
    expect((await mod.req('DELETE', `/api/guilds/${guildId}/members/${alice.id}`, {})).status).toBe(403);
    expect((await mod.req('PUT', `/api/guilds/${guildId}/bans/${alice.id}`, {})).status).toBe(403);
  });

  it('plain members cannot kick at all', async () => {
    expect((await bob.req('DELETE', `/api/guilds/${guildId}/members/${alice.id}`, {})).status).toBe(403);
  });

  it('mods can delete others messages, members cannot; nobody edits others messages', async () => {
    const m = (await bob.req('POST', `/api/channels/${general}/messages`, { content: 'delete me' })).body;
    expect((await alice.req('DELETE', `/api/channels/${general}/messages/${m.id}`)).status).toBe(403);
    expect((await mod.req('PATCH', `/api/channels/${general}/messages/${m.id}`, { content: 'edited by mod' })).status).toBe(403);
    expect((await mod.req('DELETE', `/api/channels/${general}/messages/${m.id}`)).status).toBe(200);
    const log = (await owner.req('GET', `/api/guilds/${guildId}/audit-log`)).body;
    expect(log.entries.some((e: any) => e.action === 'message_delete' && e.targetId === bob.id)).toBe(true);
  });

  it('audit log needs VIEW_AUDIT_LOG', async () => {
    expect((await bob.req('GET', `/api/guilds/${guildId}/audit-log`)).status).toBe(403);
  });
});

describe('timeouts and bans', () => {
  it('timed-out members can read but not send or react', async () => {
    const m = (await alice.req('POST', `/api/channels/${general}/messages`, { content: 'react to me' })).body;
    expect((await mod.req('PATCH', `/api/guilds/${guildId}/members/${bob.id}`, { timeoutSeconds: 600, reason: 'cool off' })).status).toBe(200);
    expect((await bob.req('GET', `/api/channels/${general}/messages`)).status).toBe(200);
    expect((await bob.req('POST', `/api/channels/${general}/messages`, { content: 'let me talk' })).status).toBe(403);
    expect((await bob.req('PUT', `/api/channels/${general}/messages/${m.id}/reactions/${encodeURIComponent('👍')}/@me`)).status).toBe(403);
    expect((await mod.req('PATCH', `/api/guilds/${guildId}/members/${bob.id}`, { timeoutSeconds: 0 })).status).toBe(200);
    expect((await bob.req('POST', `/api/channels/${general}/messages`, { content: 'free' })).status).toBe(200);
  });

  it('banned users are removed and cannot rejoin', async () => {
    const { invite } = await guildWith(owner);
    const victim = await register(t, 'victim');
    expect((await victim.req('POST', `/api/invites/${invite}`)).status).toBe(200);
    const vGuild = (await owner.req('GET', `/api/invites/${invite}`)).body.guild.id;
    expect((await owner.req('PUT', `/api/guilds/${vGuild}/bans/${victim.id}`, { reason: 'spam', deleteMessageSeconds: 0 })).status).toBe(200);
    expect((await victim.req('GET', `/api/guilds/${vGuild}`)).status).toBe(404);
    expect((await victim.req('POST', `/api/invites/${invite}`)).status).toBe(403);
    expect((await owner.req('DELETE', `/api/guilds/${vGuild}/bans/${victim.id}`)).status).toBe(200);
    expect((await victim.req('POST', `/api/invites/${invite}`)).status).toBe(200);
  });
});

describe('mentions', () => {
  it('@everyone only counts with MENTION_EVERYONE', async () => {
    const m1 = (await bob.req('POST', `/api/channels/${general}/messages`, { content: '@everyone hi' })).body;
    expect(m1.mentionEveryone).toBe(false);
    const m2 = (await owner.req('POST', `/api/channels/${general}/messages`, { content: '@everyone hi' })).body;
    expect(m2.mentionEveryone).toBe(true);
  });
});

describe('DMs', () => {
  it('only recipients can read a DM', async () => {
    const dm = (await alice.req('POST', '/api/users/@me/channels', { recipientIds: [bob.id] })).body;
    expect((await alice.req('POST', `/api/channels/${dm.id}/messages`, { content: 'psst' })).status).toBe(200);
    expect((await bob.req('GET', `/api/channels/${dm.id}/messages`)).body.length).toBe(1);
    expect((await mod.req('GET', `/api/channels/${dm.id}/messages`)).status).toBe(404);
    // reopening returns the same channel
    expect((await alice.req('POST', '/api/users/@me/channels', { recipientIds: [bob.id] })).body.id).toBe(dm.id);
  });

  it('you cannot DM strangers (no shared server, not friends)', async () => {
    expect((await outsider.req('POST', '/api/users/@me/channels', { recipientIds: [alice.id] })).status).toBe(403);
  });

  it('blocking stops DMs both ways', async () => {
    const dm = (await alice.req('POST', '/api/users/@me/channels', { recipientIds: [mod.id] })).body;
    expect((await alice.req('PUT', `/api/users/@me/relationships/${mod.id}`, { type: 2 })).status).toBe(200);
    expect((await mod.req('POST', `/api/channels/${dm.id}/messages`, { content: 'hey' })).status).toBe(403);
    expect((await alice.req('POST', `/api/channels/${dm.id}/messages`, { content: 'hey' })).status).toBe(403);
    await alice.req('DELETE', `/api/users/@me/relationships/${mod.id}`);
    expect((await mod.req('POST', `/api/channels/${dm.id}/messages`, { content: 'hey' })).status).toBe(200);
  });

  it('dm policy "friends" blocks non-friends', async () => {
    await bob.req('PATCH', '/api/users/@me/privacy', { dmPolicy: 'friends' });
    expect((await mod.req('POST', '/api/users/@me/channels', { recipientIds: [bob.id] })).status).toBe(403);
    await bob.req('PATCH', '/api/users/@me/privacy', { dmPolicy: 'everyone' });
  });

  it('group DMs need friends', async () => {
    expect((await alice.req('POST', '/api/users/@me/channels', { recipientIds: [bob.id, mod.id] })).status).toBe(403);
    await alice.req('POST', '/api/users/@me/relationships', { username: 'bob' });
    await bob.req('PUT', `/api/users/@me/relationships/${alice.id}`, { type: 1 });
    await alice.req('POST', '/api/users/@me/relationships', { username: 'mod' });
    await mod.req('PUT', `/api/users/@me/relationships/${alice.id}`, { type: 1 });
    const g = await alice.req('POST', '/api/users/@me/channels', { recipientIds: [bob.id, mod.id] });
    expect(g.status).toBe(200);
    expect(g.body.type).toBe(ChannelType.GROUP_DM);
    expect(g.body.recipients.length).toBe(3);
  });
});

describe('profiles', () => {
  it('cannot view profiles of people you share nothing with', async () => {
    expect((await outsider.req('GET', `/api/users/${alice.id}/profile`)).status).toBe(404);
    expect((await bob.req('GET', `/api/users/${alice.id}/profile`)).status).toBe(200);
  });

  it('profile content is validated', async () => {
    expect((await alice.req('PATCH', '/api/users/@me/profile', { links: [{ label: 'x', url: 'javascript:alert(1)' }] })).status).toBe(400);
    expect((await alice.req('PATCH', '/api/users/@me/profile', { theme: { primary: 'url(evil)' } })).status).toBe(400);
    const ok = await alice.req('PATCH', '/api/users/@me/profile', {
      bio: '**hi** ‮evil',
      pronouns: 'she/her',
      theme: { primary: '#112233', secondary: '#445566', font: 'lora' },
      widgets: [{ id: 'w1', type: 'text', title: 'About', content: 'stuff' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.bio).toBe('**hi** evil'); // bidi override stripped
  });

  it('guestbook: friends only, owner can delete', async () => {
    // alice and bob are friends from the group DM test
    expect((await outsider.req('POST', `/api/users/${alice.id}/guestbook`, { content: 'hi' })).status).toBe(403);
    const e = await bob.req('POST', `/api/users/${alice.id}/guestbook`, { content: 'great profile' });
    expect(e.status).toBe(200);
    expect((await mod.req('DELETE', `/api/users/${alice.id}/guestbook/${e.body.id}`)).status).toBe(404);
    expect((await alice.req('DELETE', `/api/users/${alice.id}/guestbook/${e.body.id}`)).status).toBe(200);
  });

  it('last seen respects privacy', async () => {
    await t.ctx.sql`UPDATE users SET last_seen_at = now() - interval '1 hour' WHERE id = ${alice.id}`;
    await alice.req('PATCH', '/api/users/@me/privacy', { lastSeen: 'nobody' });
    expect((await bob.req('GET', `/api/users/${alice.id}/profile`)).body.presence.lastSeenAt).toBeNull();
    await alice.req('PATCH', '/api/users/@me/privacy', { lastSeen: 'friends' });
    expect((await bob.req('GET', `/api/users/${alice.id}/profile`)).body.presence.lastSeenAt).not.toBeNull(); // friend
    expect((await owner.req('GET', `/api/users/${alice.id}/profile`)).body.presence.lastSeenAt).toBeNull(); // not a friend
  });
});
