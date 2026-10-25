/**
 * Discord-flavoured markdown -> AST. The client renders the AST with components;
 * nothing here ever produces raw HTML, so user content can't inject markup.
 *
 * Supported:
 *   blocks: ```code```, > quote, >>> quote-rest, # / ## / ### headers, -# subtext, - * 1. lists
 *   inline: **bold** *italic* _italic_ __underline__ ~~strike~~ ||spoiler|| `code`
 *           [masked](https://link) https://autolink <https://no-embed>
 *           <@user> <@&role> <#channel> @everyone @here <:emoji:id> <a:emoji:id> <t:unix:R>
 *           \escapes
 */

export type MdNode =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'b' | 'i' | 'u' | 's' | 'spoiler'; c: MdNode[] }
  | { t: 'code'; v: string }
  | { t: 'codeblock'; lang: string; v: string }
  | { t: 'quote'; c: MdNode[] }
  | { t: 'h'; level: 1 | 2 | 3; c: MdNode[] }
  | { t: 'sub'; c: MdNode[] }
  | { t: 'list'; ordered: boolean; start: number; items: MdNode[][] }
  | { t: 'link'; href: string; c: MdNode[]; masked: boolean }
  | { t: 'user'; id: string }
  | { t: 'role'; id: string }
  | { t: 'channel'; id: string }
  | { t: 'everyone' }
  | { t: 'here' }
  | { t: 'emoji'; id: string; name: string; animated: boolean }
  | { t: 'time'; ts: number; style: string };

export interface MdOptions {
  /** Allow #, ##, ### headers, lists and subtext (on for messages, bios, wiki). */
  blocks?: boolean;
  /** Parse mentions (off in bios, where they'd be meaningless). */
  mentions?: boolean;
  /** Max input length to parse; the rest is dropped. */
  maxLength?: number;
}

const MAX_DEPTH = 6;

function isSafeHref(href: string): boolean {
  try {
    const u = new URL(href);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

function trimUrl(url: string): string {
  // Drop trailing punctuation, and a trailing ")" unless parens are balanced.
  let u = url.replace(/[.,:;!?'"]+$/, '');
  while (u.endsWith(')')) {
    const open = (u.match(/\(/g) ?? []).length;
    const close = (u.match(/\)/g) ?? []).length;
    if (close > open) u = u.slice(0, -1);
    else break;
  }
  return u;
}

interface InlineRule {
  re: RegExp;
  parse: (m: RegExpExecArray, depth: number, opts: Required<MdOptions>, prev: string) => MdNode | MdNode[] | null;
}

function mergeText(nodes: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.t === 'text' && last && last.t === 'text') last.v += n.v;
    else out.push(n);
  }
  return out;
}

const rules: InlineRule[] = [
  {
    re: /\\([^\sA-Za-z0-9])/y,
    parse: (m) => ({ t: 'text', v: m[1]! }),
  },
  {
    re: /<(https?:\/\/[^\s>]+)>/y,
    parse: (m) => (isSafeHref(m[1]!) ? { t: 'link', href: m[1]!, c: [{ t: 'text', v: m[1]! }], masked: false } : null),
  },
  {
    re: /<@!?(\d{1,20})>/y,
    parse: (m, _d, o) => (o.mentions ? { t: 'user', id: m[1]! } : null),
  },
  {
    re: /<@&(\d{1,20})>/y,
    parse: (m, _d, o) => (o.mentions ? { t: 'role', id: m[1]! } : null),
  },
  {
    re: /<#(\d{1,20})>/y,
    parse: (m, _d, o) => (o.mentions ? { t: 'channel', id: m[1]! } : null),
  },
  {
    re: /<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>/y,
    parse: (m) => ({ t: 'emoji', id: m[3]!, name: m[2]!, animated: m[1] === 'a' }),
  },
  {
    re: /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y,
    parse: (m) => ({ t: 'time', ts: Number(m[1]), style: m[2] ?? 'f' }),
  },
  {
    re: /@(everyone|here)\b/y,
    parse: (m, _d, o) => (o.mentions ? { t: m[1] === 'everyone' ? 'everyone' : 'here' } : null),
  },
  {
    // [text](url) — text can't contain another link
    re: /\[((?:\\[\s\S]|[^\]\\\n]){1,200})\]\(\s*<?(https?:\/\/[^\s)<>]+)>?\s*\)/y,
    parse: (m, d, o) => {
      const href = m[2]!;
      if (!isSafeHref(href)) return null;
      const inner = parseInline(m[1]!, d + 1, o).filter((n) => n.t !== 'link');
      return { t: 'link', href, c: inner.length ? inner : [{ t: 'text', v: href }], masked: true };
    },
  },
  {
    re: /https?:\/\/[^\s<]+[^<.,:;"'\]\s]/y,
    parse: (m) => {
      const url = trimUrl(m[0]);
      if (!isSafeHref(url)) return null;
      const rest = m[0].slice(url.length);
      const link: MdNode = { t: 'link', href: url, c: [{ t: 'text', v: url }], masked: false };
      return rest ? [link, { t: 'text', v: rest }] : link;
    },
  },
  {
    re: /(`+)([\s\S]*?[^`])\1(?!`)/y,
    parse: (m) => ({ t: 'code', v: m[2]!.replace(/^ (.*) $/s, '$1') }),
  },
  {
    re: /\|\|([\s\S]+?)\|\|/y,
    parse: (m, d, o) => ({ t: 'spoiler', c: parseInline(m[1]!, d + 1, o) }),
  },
  {
    re: /\*\*([\s\S]+?)\*\*(?!\*)/y,
    parse: (m, d, o) => ({ t: 'b', c: parseInline(m[1]!, d + 1, o) }),
  },
  {
    re: /__([\s\S]+?)__(?!_)/y,
    parse: (m, d, o) => ({ t: 'u', c: parseInline(m[1]!, d + 1, o) }),
  },
  {
    re: /\*(?=\S)((?:\*\*[\s\S]+?\*\*|[\s\S])+?)\*(?!\*)/y,
    parse: (m, d, o) => (/\S$/.test(m[1]!) ? { t: 'i', c: parseInline(m[1]!, d + 1, o) } : null),
  },
  {
    re: /_((?:__[\s\S]+?__|[\s\S])+?)_(?![A-Za-z0-9_])/y,
    parse: (m, d, o, prev) => (/[A-Za-z0-9]/.test(prev) ? null : { t: 'i', c: parseInline(m[1]!, d + 1, o) }),
  },
  {
    re: /~~([\s\S]+?)~~/y,
    parse: (m, d, o) => ({ t: 's', c: parseInline(m[1]!, d + 1, o) }),
  },
  {
    re: /\n/y,
    parse: () => ({ t: 'br' }),
  },
];

const SPECIAL = /[\\<@[h*_~|`\n]/g;

export function parseInline(src: string, depth: number, opts: Required<MdOptions>): MdNode[] {
  if (depth > MAX_DEPTH) return [{ t: 'text', v: src }];
  const out: MdNode[] = [];
  let i = 0;
  let textStart = 0;
  const flush = (end: number) => {
    if (end > textStart) out.push({ t: 'text', v: src.slice(textStart, end) });
  };
  while (i < src.length) {
    let matched = false;
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(src);
      if (!m || m.index !== i) continue;
      const node = rule.parse(m, depth, opts, i > 0 ? src[i - 1]! : '');
      if (!node) continue;
      flush(i);
      if (Array.isArray(node)) out.push(...node);
      else out.push(node);
      i += m[0].length;
      textStart = i;
      matched = true;
      break;
    }
    if (matched) continue;
    // Jump to the next character that could start a rule.
    i++;
    SPECIAL.lastIndex = i;
    const next = SPECIAL.exec(src);
    i = next ? next.index : src.length;
  }
  flush(src.length);
  return mergeText(out);
}

const CODEBLOCK = /```(?:([A-Za-z0-9_+\-#.]{1,20})\n)?\n?([\s\S]*?)\n?```/g;

function parseBlocks(src: string, depth: number, opts: Required<MdOptions>, inQuote: boolean): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  CODEBLOCK.lastIndex = 0;
  let m: RegExpExecArray | null;
  const segments: Array<{ code: false; v: string } | { code: true; lang: string; v: string }> = [];
  while ((m = CODEBLOCK.exec(src))) {
    if (m.index > last) segments.push({ code: false, v: src.slice(last, m.index) });
    segments.push({ code: true, lang: m[1] ?? '', v: m[2] ?? '' });
    last = m.index + m[0].length;
  }
  if (last < src.length) segments.push({ code: false, v: src.slice(last) });

  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s]!;
    if (seg.code) {
      out.push({ t: 'codeblock', lang: seg.lang, v: seg.v });
      // swallow one newline after a code block
      const next = segments[s + 1];
      if (next && !next.code && next.v.startsWith('\n')) next.v = next.v.slice(1);
      continue;
    }
    out.push(...parseLines(seg.v, depth, opts, inQuote));
  }
  return out;
}

const LIST_ITEM = /^(\s{0,8})([-*]|\d{1,9}\.)\s+(.*)$/;

function parseLines(src: string, depth: number, opts: Required<MdOptions>, inQuote: boolean): MdNode[] {
  const out: MdNode[] = [];
  const lines = src.split('\n');
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(...parseInline(para.join('\n'), depth, opts));
      para = [];
    }
  };
  const pushBlock = (n: MdNode) => {
    // a paragraph ending right before a block: drop its trailing newline handling
    flushPara();
    const prev = out[out.length - 1];
    if (prev && prev.t === 'br') out.pop();
    out.push(n);
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!inQuote && depth < MAX_DEPTH) {
      if (l.startsWith('>>> ') || l === '>>>') {
        const rest = [l.slice(4), ...lines.slice(i + 1)].join('\n');
        pushBlock({ t: 'quote', c: parseBlocks(rest, depth + 1, opts, true) });
        return out;
      }
      if (l.startsWith('> ') || l === '>') {
        const q: string[] = [];
        while (i < lines.length && (lines[i]!.startsWith('> ') || lines[i] === '>')) {
          q.push(lines[i]!.slice(2));
          i++;
        }
        i--;
        pushBlock({ t: 'quote', c: parseBlocks(q.join('\n'), depth + 1, opts, true) });
        continue;
      }
    }
    if (opts.blocks) {
      const h = /^(#{1,3}) (.+)$/.exec(l);
      if (h) {
        pushBlock({ t: 'h', level: h[1]!.length as 1 | 2 | 3, c: parseInline(h[2]!, depth + 1, opts) });
        continue;
      }
      const sub = /^-# (.+)$/.exec(l);
      if (sub) {
        pushBlock({ t: 'sub', c: parseInline(sub[1]!, depth + 1, opts) });
        continue;
      }
      const li = LIST_ITEM.exec(l);
      if (li) {
        const ordered = li[2]!.endsWith('.');
        const start = ordered ? Number(li[2]!.slice(0, -1)) : 1;
        const items: MdNode[][] = [];
        while (i < lines.length) {
          const x = LIST_ITEM.exec(lines[i]!);
          if (!x || x[2]!.endsWith('.') !== ordered) break;
          items.push(parseInline(x[3]!, depth + 1, opts));
          i++;
        }
        i--;
        pushBlock({ t: 'list', ordered, start: Math.min(start, 1e6), items: items.slice(0, 100) });
        continue;
      }
    }
    // separate consecutive paragraph lines with a newline (rendered as <br>)
    if (out.length && para.length === 0) {
      const prev = out[out.length - 1]!;
      const isBlock = ['quote', 'h', 'sub', 'list', 'codeblock'].includes(prev.t);
      if (!isBlock) out.push({ t: 'br' });
    }
    para.push(l);
  }
  flushPara();
  return out;
}

export function parseMarkdown(src: string, options: MdOptions = {}): MdNode[] {
  const opts: Required<MdOptions> = {
    blocks: options.blocks ?? true,
    mentions: options.mentions ?? true,
    maxLength: options.maxLength ?? 60000,
  };
  const input = src.length > opts.maxLength ? src.slice(0, opts.maxLength) : src;
  const nodes = parseBlocks(input, 0, opts, false);
  // drop leading/trailing <br>
  while (nodes[0]?.t === 'br') nodes.shift();
  while (nodes[nodes.length - 1]?.t === 'br') nodes.pop();
  return nodes;
}

/** Collects all http(s) links that should get an embed (not <wrapped>, not inside spoilers or code). */
export function extractEmbedLinks(src: string, max = 5): string[] {
  const out: string[] = [];
  const walk = (nodes: MdNode[], inSpoiler: boolean) => {
    for (const n of nodes) {
      if (out.length >= max) return;
      if (n.t === 'link' && !inSpoiler) {
        const text = n.c[0];
        // <url> form is parsed as unmasked with text===href; we detect it on the raw source below
        if (!out.includes(n.href)) out.push(n.href);
      }
      if ('c' in n && Array.isArray(n.c)) walk(n.c as MdNode[], inSpoiler || n.t === 'spoiler');
      if (n.t === 'list') for (const it of n.items) walk(it, inSpoiler);
    }
  };
  walk(parseMarkdown(src), false);
  const suppressed = new Set([...src.matchAll(/<(https?:\/\/[^\s>]+)>/g)].map((m) => m[1]));
  return out.filter((u) => !suppressed.has(u));
}

export interface ExtractedMentions {
  users: string[];
  roles: string[];
  channels: string[];
  everyone: boolean;
  here: boolean;
  emojis: { id: string; name: string; animated: boolean }[];
}

/** Mentions in actual message text (ignores code blocks and inline code). */
export function extractMentions(src: string): ExtractedMentions {
  const res: ExtractedMentions = { users: [], roles: [], channels: [], everyone: false, here: false, emojis: [] };
  const walk = (nodes: MdNode[]) => {
    for (const n of nodes) {
      switch (n.t) {
        case 'user':
          if (!res.users.includes(n.id)) res.users.push(n.id);
          break;
        case 'role':
          if (!res.roles.includes(n.id)) res.roles.push(n.id);
          break;
        case 'channel':
          if (!res.channels.includes(n.id)) res.channels.push(n.id);
          break;
        case 'everyone':
          res.everyone = true;
          break;
        case 'here':
          res.here = true;
          break;
        case 'emoji':
          if (!res.emojis.some((e) => e.id === n.id)) res.emojis.push({ id: n.id, name: n.name, animated: n.animated });
          break;
        case 'list':
          n.items.forEach(walk);
          break;
        default:
          if ('c' in n && Array.isArray(n.c)) walk(n.c as MdNode[]);
      }
    }
  };
  walk(parseMarkdown(src));
  return res;
}

const EMOJI_ONLY = /^(?:\s|\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)*$/u;

/** True if the message is only emoji (max 27) — rendered big ("jumbo"). */
export function isEmojiOnly(nodes: MdNode[]): boolean {
  let count = 0;
  for (const n of nodes) {
    if (n.t === 'emoji') count++;
    else if (n.t === 'text') {
      if (!EMOJI_ONLY.test(n.v)) return false;
      const pics = n.v.match(/\p{Extended_Pictographic}/gu);
      count += pics ? pics.length : 0;
      if (/[0-9#*]/.test(n.v) && !/⃣/.test(n.v)) return false;
    } else if (n.t !== 'br') return false;
  }
  return count > 0 && count <= 27;
}
