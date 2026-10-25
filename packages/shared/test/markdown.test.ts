import { describe, expect, it } from 'vitest';
import { extractEmbedLinks, extractMentions, isEmojiOnly, parseMarkdown, type MdNode } from '../src/markdown.js';

const p = (s: string) => parseMarkdown(s);

describe('inline', () => {
  it('plain text', () => {
    expect(p('hello world')).toEqual([{ t: 'text', v: 'hello world' }]);
  });

  it('bold, italic, underline, strike, spoiler', () => {
    expect(p('**b**')).toEqual([{ t: 'b', c: [{ t: 'text', v: 'b' }] }]);
    expect(p('*i*')).toEqual([{ t: 'i', c: [{ t: 'text', v: 'i' }] }]);
    expect(p('_i_')).toEqual([{ t: 'i', c: [{ t: 'text', v: 'i' }] }]);
    expect(p('__u__')).toEqual([{ t: 'u', c: [{ t: 'text', v: 'u' }] }]);
    expect(p('~~s~~')).toEqual([{ t: 's', c: [{ t: 'text', v: 's' }] }]);
    expect(p('||x||')).toEqual([{ t: 'spoiler', c: [{ t: 'text', v: 'x' }] }]);
  });

  it('bold italic nests', () => {
    expect(p('***x***')).toEqual([{ t: 'b', c: [{ t: 'i', c: [{ t: 'text', v: 'x' }] }] }]);
  });

  it('snake_case words are not italic', () => {
    expect(p('my_var_name')).toEqual([{ t: 'text', v: 'my_var_name' }]);
  });

  it('inline code is literal', () => {
    expect(p('`**not bold**`')).toEqual([{ t: 'code', v: '**not bold**' }]);
  });

  it('escapes', () => {
    expect(p('\\*not italic\\*')).toEqual([{ t: 'text', v: '*not italic*' }]);
  });

  it('newlines become br', () => {
    expect(p('a\nb')).toEqual([{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }]);
  });

  it('unclosed markers stay text', () => {
    expect(p('**nope')).toEqual([{ t: 'text', v: '**nope' }]);
  });
});

describe('links', () => {
  it('autolinks and trims punctuation', () => {
    expect(p('see https://example.com/a.')).toEqual([
      { t: 'text', v: 'see ' },
      { t: 'link', href: 'https://example.com/a', c: [{ t: 'text', v: 'https://example.com/a' }], masked: false },
      { t: 'text', v: '.' },
    ]);
  });

  it('keeps balanced parens', () => {
    const n = p('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(n[0]).toMatchObject({ t: 'link', href: 'https://en.wikipedia.org/wiki/Foo_(bar)' });
  });

  it('masked links', () => {
    expect(p('[click](https://example.com)')).toEqual([
      { t: 'link', href: 'https://example.com', c: [{ t: 'text', v: 'click' }], masked: true },
    ]);
  });

  it('rejects javascript: and other schemes', () => {
    const n = p('[x](javascript:alert(1))');
    expect(JSON.stringify(n)).not.toContain('"t":"link"');
    expect(JSON.stringify(p('javascript:alert(1)'))).not.toContain('"t":"link"');
    expect(JSON.stringify(p('[x](data:text/html,hi)'))).not.toContain('"t":"link"');
  });

  it('rejects credentials in urls', () => {
    expect(JSON.stringify(p('https://user:pass@evil.com'))).not.toContain('"t":"link"');
  });

  it('extractEmbedLinks skips <wrapped>, spoilers and code', () => {
    expect(extractEmbedLinks('https://a.com <https://b.com> ||https://c.com|| `https://d.com` https://e.com')).toEqual([
      'https://a.com/',
      'https://e.com/',
    ].map((u) => u.replace(/\/$/, '')));
  });
});

describe('mentions and emoji', () => {
  it('parses mentions', () => {
    expect(p('<@123> <@&456> <#789> @everyone @here')).toEqual([
      { t: 'user', id: '123' },
      { t: 'text', v: ' ' },
      { t: 'role', id: '456' },
      { t: 'text', v: ' ' },
      { t: 'channel', id: '789' },
      { t: 'text', v: ' ' },
      { t: 'everyone' },
      { t: 'text', v: ' ' },
      { t: 'here' },
    ]);
  });

  it('mentions are text when disabled (bios)', () => {
    expect(parseMarkdown('<@123> @everyone', { mentions: false })).toEqual([{ t: 'text', v: '<@123> @everyone' }]);
  });

  it('extractMentions ignores code', () => {
    const m = extractMentions('<@1> `<@2>` ```\n<@3>\n``` @everyone <a:wave:55>');
    expect(m.users).toEqual(['1']);
    expect(m.everyone).toBe(true);
    expect(m.emojis).toEqual([{ id: '55', name: 'wave', animated: true }]);
  });

  it('custom emoji', () => {
    expect(p('<:pog:42>')).toEqual([{ t: 'emoji', id: '42', name: 'pog', animated: false }]);
  });

  it('timestamps', () => {
    expect(p('<t:1700000000:R>')).toEqual([{ t: 'time', ts: 1700000000, style: 'R' }]);
  });

  it('emoji-only detection', () => {
    expect(isEmojiOnly(p('😀😀'))).toBe(true);
    expect(isEmojiOnly(p('<:ab:1> 😀'))).toBe(true);
    expect(isEmojiOnly(p('hi 😀'))).toBe(false);
    expect(isEmojiOnly(p('123'))).toBe(false);
  });
});

describe('blocks', () => {
  it('code blocks keep content raw', () => {
    expect(p('```js\nconst a = **1**;\n```')).toEqual([{ t: 'codeblock', lang: 'js', v: 'const a = **1**;' }]);
  });

  it('quotes', () => {
    expect(p('> hi\n> there\nafter')).toEqual([
      { t: 'quote', c: [{ t: 'text', v: 'hi' }, { t: 'br' }, { t: 'text', v: 'there' }] },
      { t: 'text', v: 'after' },
    ]);
  });

  it('>>> quotes the rest', () => {
    const n = p('>>> a\nb');
    expect(n).toEqual([{ t: 'quote', c: [{ t: 'text', v: 'a' }, { t: 'br' }, { t: 'text', v: 'b' }] }]);
  });

  it('headers, subtext, lists', () => {
    expect(p('# Big')).toEqual([{ t: 'h', level: 1, c: [{ t: 'text', v: 'Big' }] }]);
    expect(p('-# small')).toEqual([{ t: 'sub', c: [{ t: 'text', v: 'small' }] }]);
    expect(p('- a\n- b')).toEqual([{ t: 'list', ordered: false, start: 1, items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] }]);
    expect(p('3. a\n4. b')).toMatchObject([{ t: 'list', ordered: true, start: 3 }]);
  });

  it('headers off when blocks disabled', () => {
    expect(parseMarkdown('# not', { blocks: false })).toEqual([{ t: 'text', v: '# not' }]);
  });
});

describe('robustness', () => {
  it('deep nesting does not blow the stack', () => {
    const s = '**'.repeat(500) + 'x' + '**'.repeat(500);
    expect(() => p(s)).not.toThrow();
  });

  it('huge input is truncated, not parsed forever', () => {
    const s = '*a'.repeat(100000);
    const start = Date.now();
    p(s);
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it('never emits html', () => {
    const nodes = p('<script>alert(1)</script><img src=x onerror=alert(1)>');
    const flat = JSON.stringify(nodes);
    expect(nodes.every((n: MdNode) => n.t === 'text')).toBe(true);
    expect(flat).toContain('<script>'); // as text, rendered escaped
  });
});
