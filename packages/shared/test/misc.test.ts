import { describe, expect, it } from 'vitest';
import { DARK_THEME, decodeTheme, encodeTheme, ClientSettingsPatchSchema, normaliseSettings, SETTINGS_DEFAULTS } from '../src/settings.js';
import { cleanMultiline, cleanSingleLine, safeHttpUrl, youtubeId, youtubeStart } from '../src/text.js';
import { GAMES, anagramCatchUp } from '../src/games/index.js';
import { levelFromXp, totalXpFor } from '../src/levels.js';
import { CreateMessageSchema, ProfilePatchSchema, RegisterSchema, OverwriteSchema, CustomStatusSchema } from '../src/schemas.js';
import { snowflakeFromTime, snowflakeTime, compareIds } from '../src/constants.js';

describe('themes', () => {
  it('round-trips', () => {
    const code = encodeTheme(DARK_THEME);
    expect(code.startsWith('THEME1.')).toBe(true);
    expect(decodeTheme(code)).toEqual(DARK_THEME);
  });

  it('rejects garbage and injection attempts', () => {
    expect(decodeTheme('nope')).toBeNull();
    expect(decodeTheme('THEME1.' + btoa('{"n":"x","c":"red;}body{display:none"}'))).toBeNull();
    expect(decodeTheme('THEME1.!!!!')).toBeNull();
  });
});

describe('settings', () => {
  it('patch does not fill in defaults', () => {
    expect(ClientSettingsPatchSchema.parse({ compact: true })).toEqual({ compact: true });
  });
  it('patch rejects unknown keys', () => {
    expect(ClientSettingsPatchSchema.safeParse({ evil: 1 }).success).toBe(false);
  });
  it('normalise drops invalid stored values', () => {
    const s = normaliseSettings({ compact: 'yes', fontScale: 1.2, junk: 1 });
    expect(s.compact).toBe(SETTINGS_DEFAULTS.compact);
    expect(s.fontScale).toBe(1.2);
    expect('junk' in s).toBe(false);
  });
});

describe('text cleaning', () => {
  it('strips control and bidi characters', () => {
    expect(cleanSingleLine('a‮b\u0007c\n d')).toBe('abc d');
    expect(cleanMultiline('a\r\nb\u0000')).toBe('a\nb');
  });
  it('caps zalgo', () => {
    const z = 'a' + '́'.repeat(50);
    expect([...cleanSingleLine(z)].length).toBe(5);
  });
  it('safeHttpUrl', () => {
    expect(safeHttpUrl('https://x.com/a')).toBe('https://x.com/a');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('https://u:p@x.com')).toBeNull();
    expect(safeHttpUrl('ftp://x.com')).toBeNull();
  });
  it('youtube ids', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(youtubeId('https://evil.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeStart('https://youtu.be/x?t=1m30s')).toBe(90);
  });
});

describe('schemas', () => {
  it('register normalises username and email', () => {
    const r = RegisterSchema.parse({ username: '  Cool.User ', email: ' A@B.CO ', password: 'longenough' });
    expect(r.username).toBe('cool.user');
    expect(r.email).toBe('a@b.co');
  });
  it('register rejects reserved and bad usernames', () => {
    for (const u of ['everyone', 'a', 'has space', 'émoji', 'deleted_user_1', 'a..b']) {
      expect(RegisterSchema.safeParse({ username: u, email: 'a@b.co', password: 'longenough' }).success, u).toBe(false);
    }
  });
  it('profile links must be http(s)', () => {
    expect(ProfilePatchSchema.safeParse({ links: [{ label: 'x', url: 'javascript:alert(1)' }] }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ links: [{ label: 'x', url: 'https://ok.com' }] }).success).toBe(true);
  });
  it('profile theme colours must be hex', () => {
    expect(ProfilePatchSchema.safeParse({ theme: { primary: 'red' } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ theme: { primary: '#ff0000;}' } }).success).toBe(false);
    expect(ProfilePatchSchema.safeParse({ theme: { primary: '#ff0000', font: 'comic-neue' } }).success).toBe(true);
    expect(ProfilePatchSchema.safeParse({ theme: { font: 'Arial' } }).success).toBe(false);
  });
  it('widget covers must come from allowed hosts', () => {
    const w = (coverUrl: string) => ({
      widgets: [{ id: 'a', type: 'games', items: [{ name: 'X', source: 'igdb', coverUrl }] }],
    });
    expect(ProfilePatchSchema.safeParse(w('https://images.igdb.com/igdb/image/upload/t_cover_big/x.jpg')).success).toBe(true);
    expect(ProfilePatchSchema.safeParse(w('https://evil.com/tracker.gif')).success).toBe(false);
  });
  it('empty messages rejected', () => {
    expect(CreateMessageSchema.safeParse({ content: '   ' }).success).toBe(false);
    expect(CreateMessageSchema.safeParse({ content: 'hi' }).success).toBe(true);
  });
  it('message length enforced after cleaning', () => {
    expect(CreateMessageSchema.safeParse({ content: 'a'.repeat(4001) }).success).toBe(false);
  });
  it('permission strings validated', () => {
    expect(OverwriteSchema.safeParse({ type: 0, allow: '1', deny: '-1' }).success).toBe(false);
    expect(OverwriteSchema.safeParse({ type: 0, allow: '99999999999999999999', deny: '0' }).success).toBe(false);
  });
  it('custom status needs text or emoji', () => {
    expect(CustomStatusSchema.safeParse({ text: '' }).success).toBe(false);
    expect(CustomStatusSchema.safeParse({ text: '', emoji: '🔥' }).success).toBe(true);
  });
});

describe('snowflakes', () => {
  it('time round trip', () => {
    const t = Date.UTC(2026, 5, 1);
    expect(snowflakeTime(snowflakeFromTime(t))).toBe(t);
  });
  it('compareIds works across lengths', () => {
    expect(compareIds('9', '10')).toBeLessThan(0);
    expect(compareIds('100', '99')).toBeGreaterThan(0);
    expect(compareIds('5', '5')).toBe(0);
  });
});

describe('levels', () => {
  it('level curve', () => {
    expect(levelFromXp(0).level).toBe(0);
    expect(levelFromXp(99).level).toBe(0);
    expect(levelFromXp(100).level).toBe(1);
    expect(levelFromXp(totalXpFor(10)).level).toBe(10);
    expect(levelFromXp(totalXpFor(10) - 1).level).toBe(9);
  });
});

describe('games', () => {
  const rand = () => 0.42;
  it('tic-tac-toe win', () => {
    const g = GAMES.tictactoe;
    let s = (g.create('a', {}, rand, 0) as any).state;
    expect(g.move(s, 'a', { cell: 0 }, rand, 0).ok).toBe(false); // lobby
    s = (g.join(s, 'b', rand, 0) as any).state;
    expect(s.status).toBe('playing');
    expect(g.move(s, 'b', { cell: 0 }, rand, 0)).toMatchObject({ ok: false, error: 'Not your turn' });
    for (const [p, c] of [['a', 0], ['b', 3], ['a', 1], ['b', 4]] as const) s = (g.move(s, p, { cell: c }, rand, 0) as any).state;
    expect(g.move(s, 'a', { cell: 0 }, rand, 0)).toMatchObject({ ok: false, error: 'Cell taken' });
    s = (g.move(s, 'a', { cell: 2 }, rand, 0) as any).state;
    expect(s.status).toBe('finished');
    expect(s.winners).toEqual(['a']);
  });

  it('tic-tac-toe rejects junk moves', () => {
    const g = GAMES.tictactoe;
    let s = (g.create('a', {}, rand, 0) as any).state;
    s = (g.join(s, 'b', rand, 0) as any).state;
    for (const m of [null, {}, { cell: -1 }, { cell: 9 }, { cell: 1.5 }, { cell: '1' }]) {
      expect(g.move(s, 'a', m, rand, 0).ok).toBe(false);
    }
    expect(g.move(s, 'c', { cell: 0 }, rand, 0).ok).toBe(false);
  });

  it('connect four vertical win and full column', () => {
    const g = GAMES.connect4;
    let s = (g.create('a', {}, rand, 0) as any).state;
    s = (g.join(s, 'b', rand, 0) as any).state;
    for (let i = 0; i < 3; i++) {
      s = (g.move(s, 'a', { col: 0 }, rand, 0) as any).state;
      s = (g.move(s, 'b', { col: 1 }, rand, 0) as any).state;
    }
    s = (g.move(s, 'a', { col: 0 }, rand, 0) as any).state;
    expect(s.status).toBe('finished');
    expect(s.winners).toEqual(['a']);
  });

  it('connect four diagonal win', () => {
    const g = GAMES.connect4;
    let s = (g.create('a', {}, rand, 0) as any).state;
    s = (g.join(s, 'b', rand, 0) as any).state;
    const seq: [string, number][] = [
      ['a', 0], ['b', 1], ['a', 1], ['b', 2], ['a', 2], ['b', 3], ['a', 2], ['b', 3], ['a', 3], ['b', 6], ['a', 3],
    ];
    for (const [p, c] of seq) {
      const r = g.move(s, p, { col: c }, rand, 0);
      expect(r.ok, `${p}->${c}`).toBe(true);
      s = (r as any).state;
    }
    expect(s.status).toBe('finished');
    expect(s.winners).toEqual(['a']);
  });

  it('hangman hides the word from guessers and reveals at the end', () => {
    const g = GAMES.hangman;
    expect(g.create('host', { word: 'a1' }, rand, 0).ok).toBe(false);
    let s = (g.create('host', { word: 'Cat' }, rand, 0) as any).state;
    s = (g.join(s, 'g', rand, 0) as any).state;
    expect((g.view(s, 'g', 0) as any).word).toBeNull();
    expect((g.view(s, 'g', 0) as any).masked).toBe('___');
    expect((g.view(s, 'host', 0) as any).word).toBe('cat');
    expect(g.move(s, 'host', { guess: 'c' }, rand, 0).ok).toBe(false);
    s = (g.move(s, 'g', { guess: 'c' }, rand, 0) as any).state;
    expect((g.view(s, 'g', 0) as any).masked).toBe('c__');
    s = (g.move(s, 'g', { guess: 'dog' }, rand, 0) as any).state;
    expect(s.data.wrong).toBe(1);
    s = (g.move(s, 'g', { guess: 'cat' }, rand, 0) as any).state;
    expect(s.status).toBe('finished');
    expect(s.winners).toEqual(['g']);
  });

  it('hangman loses after 6 wrong', () => {
    const g = GAMES.hangman;
    let s = (g.create('host', { word: 'cat' }, rand, 0) as any).state;
    s = (g.join(s, 'g', rand, 0) as any).state;
    for (const l of 'bdefgh') s = (g.move(s, 'g', { guess: l }, rand, 0) as any).state;
    expect(s.status).toBe('finished');
    expect(s.winners).toEqual(['host']);
  });

  it('anagram rounds and timeouts', () => {
    const g = GAMES.anagram;
    let s = (g.create('h', { rounds: 2 }, Math.random, 0) as any).state;
    s = (g.join(s, 'p', Math.random, 0) as any).state;
    expect(g.move(s, 'p', { type: 'start' }, Math.random, 0).ok).toBe(false);
    s = (g.move(s, 'h', { type: 'start' }, Math.random, 1000) as any).state;
    const word = s.data.words[0];
    expect(g.move(s, 'p', { type: 'guess', guess: 'zzzz' }, Math.random, 2000).ok).toBe(false);
    s = (g.move(s, 'p', { type: 'guess', guess: word }, Math.random, 2000) as any).state;
    expect(s.data.scores.p).toBe(1);
    expect(s.data.round).toBe(1);
    // let round 2 time out
    anagramCatchUp(s, Math.random, 2000 + 46_000);
    expect(s.status).toBe('finished');
    expect(s.winners).toEqual(['p']);
  });
});
