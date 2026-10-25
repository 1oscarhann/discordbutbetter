import { AuditAction, MessageType, Permissions as P, hasAny, type AutomodAction, type AutomodRule } from '@dbb/shared';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { loadMember } from '../lib/serialize.js';

interface RuleRow {
  id: string;
  guild_id: string;
  name: string;
  enabled: boolean;
  trigger: AutomodRule['trigger'];
  actions: AutomodAction[];
  exempt_roles: string[];
  exempt_channels: string[];
}

export interface AutomodInput {
  guildId: string;
  /** The channel (for threads: pass the parent too, both are checked for exemptions). */
  channelIds: string[];
  /** Where to report: the actual channel. */
  channelId: string;
  userId: string;
  content: string;
  memberRoles: string[];
  perms: bigint;
  mentionCount: number;
  isEdit: boolean;
}

export interface AutomodResult {
  blocked: boolean;
  message?: string;
}

/** Lowercase, strip accents and common symbol substitutions so "Ⓑ@d" still matches "bad". */
export function normaliseForMatch(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/7/g, 't');
}

/**
 * Keyword syntax: `word` matches the whole word, `word*` a prefix, `*word` a suffix, `*word*` anywhere.
 * No regex from users — so no ReDoS.
 */
export function matchKeyword(content: string, keywords: string[], allow: string[]): string | null {
  const norm = normaliseForMatch(content);
  const words = norm.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const allowed = new Set(allow.map(normaliseForMatch));
  for (const raw of keywords) {
    const k = normaliseForMatch(raw);
    const starts = k.startsWith('*');
    const ends = k.endsWith('*');
    const core = k.replace(/^\*|\*$/g, '');
    if (!core) continue;
    if (starts && ends) {
      if (norm.includes(core) && !words.some((w) => allowed.has(w) && w.includes(core))) return raw;
    } else if (ends) {
      if (words.some((w) => w.startsWith(core) && !allowed.has(w))) return raw;
    } else if (starts) {
      if (words.some((w) => w.endsWith(core) && !allowed.has(w))) return raw;
    } else if (core.includes(' ')) {
      if (` ${words.join(' ')} `.includes(` ${core} `)) return raw;
    } else if (words.includes(core) && !allowed.has(core)) {
      return raw;
    }
  }
  return null;
}

const INVITE_RE = /(?:discord(?:app)?\.(?:gg|com\/invite)|\/invite)\/[A-Za-z0-9-]{2,}/i;
const HOST_RE = /https?:\/\/([^\s/?#<>]+)/gi;

export function domainsIn(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(HOST_RE)) {
    const host = m[1]!.toLowerCase().replace(/:\d+$/, '').replace(/^.*@/, '');
    out.push(host);
  }
  return out;
}

export function domainBlocked(host: string, blocked: string[]): boolean {
  return blocked.some((b) => (b.startsWith('*.') ? host === b.slice(2) || host.endsWith(b.slice(1)) : host === b || host.endsWith('.' + b)));
}

export async function runAutomod(ctx: Ctx, input: AutomodInput): Promise<AutomodResult> {
  if (hasAny(input.perms, P.ADMINISTRATOR | P.MANAGE_GUILD)) return { blocked: false };
  const rules = await ctx.sql<RuleRow[]>`
    SELECT id, guild_id, name, enabled, trigger, actions, exempt_roles::text[] AS exempt_roles, exempt_channels::text[] AS exempt_channels
    FROM automod_rules WHERE guild_id = ${input.guildId} AND enabled`;
  if (!rules.length) return { blocked: false };

  let blocked = false;
  let blockMessage: string | undefined;
  for (const r of rules) {
    if (r.exempt_roles.some((id) => input.memberRoles.includes(id))) continue;
    if (r.exempt_channels.some((id) => input.channelIds.includes(id))) continue;

    let hitReason: string | null = null;
    const t = r.trigger;
    if (t.type === 'keyword') {
      const k = matchKeyword(input.content, t.keywords, t.allow ?? []);
      if (k) hitReason = `blocked word "${k}"`;
    } else if (t.type === 'mention_spam') {
      if (input.mentionCount > t.limit) hitReason = `${input.mentionCount} mentions (limit ${t.limit})`;
    } else if (t.type === 'message_spam') {
      if (!input.isEdit) {
        const key = `spam:${input.guildId}:${input.userId}`;
        const now = Date.now();
        const res = await ctx.redis
          .multi()
          .zadd(key, now, `${now}:${Math.random()}`)
          .zremrangebyscore(key, 0, now - t.seconds * 1000)
          .zcard(key)
          .expire(key, t.seconds + 5)
          .exec();
        const count = Number(res?.[2]?.[1] ?? 0);
        if (count > t.messages) hitReason = `${count} messages in ${t.seconds}s`;
      }
    } else if (t.type === 'invite_links') {
      if (INVITE_RE.test(input.content)) hitReason = 'invite link';
    } else if (t.type === 'link_filter') {
      const bad = domainsIn(input.content).find((h) => domainBlocked(h, t.blockedDomains));
      if (bad) hitReason = `blocked link (${bad})`;
    }
    if (!hitReason) continue;

    for (const a of r.actions) {
      if (a.type === 'block') {
        blocked = true;
        blockMessage ??= a.message || `Your message was blocked by this server's automod (${r.name}).`;
      } else if (a.type === 'alert') {
        await postAlert(ctx, a.channelId, input, r.name, hitReason).catch(() => {});
      } else if (a.type === 'timeout') {
        await automodTimeout(ctx, input.guildId, input.userId, a.seconds, `${r.name}: ${hitReason}`).catch(() => {});
      }
    }
    if (r.actions.some((a) => a.type === 'block')) {
      await audit(ctx.sql, {
        guildId: input.guildId,
        actorId: null,
        action: AuditAction.AUTOMOD_BLOCK,
        targetType: 'user',
        targetId: input.userId,
        changes: { rule: r.name, reason: hitReason, channelId: input.channelId },
      });
    }
  }
  return blocked ? { blocked: true, message: blockMessage } : { blocked: false };
}

async function postAlert(ctx: Ctx, alertChannelId: string, input: AutomodInput, ruleName: string, reason: string) {
  const [ch] = await ctx.sql<{ id: string; guild_id: string; type: number; parent_id: string | null }[]>`
    SELECT id, guild_id, type, parent_id FROM channels WHERE id = ${alertChannelId} AND guild_id = ${input.guildId}`;
  if (!ch) return;
  const { insertSystemMessage } = await import('./messages.js');
  await insertSystemMessage(ctx, ch, MessageType.AUTOMOD_ALERT, null, {
    ruleName,
    reason,
    userId: input.userId,
    channelId: input.channelId,
    content: input.content.slice(0, 500),
  });
}

async function automodTimeout(ctx: Ctx, guildId: string, userId: string, seconds: number, reason: string) {
  const until = new Date(Date.now() + seconds * 1000);
  await ctx.sql`UPDATE guild_members SET timeout_until = ${until} WHERE guild_id = ${guildId} AND user_id = ${userId}`;
  await audit(ctx.sql, {
    guildId,
    actorId: null,
    action: AuditAction.AUTOMOD_TIMEOUT,
    targetType: 'user',
    targetId: userId,
    changes: { timeoutUntil: until.toISOString() },
    reason,
  });
  const m = await loadMember(ctx.sql, guildId, userId);
  if (m) ctx.bus.toGuild(guildId, 'GUILD_MEMBER_UPDATE', m, { invalidate: true });
  ctx.bus.internalGuild(guildId, '_PERMS_CHANGED', { guildId, userId });
}
