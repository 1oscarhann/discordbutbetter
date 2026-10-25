import type { GameKindValue } from '../constants.js';
import { ANAGRAM_WORDS } from './words.js';

/**
 * Server-authoritative mini games. The server keeps the full state, runs moves through these pure
 * functions and sends each viewer `view(state, viewerId)`, which strips hidden info (e.g. the hangman word).
 */

export interface GameState<D = unknown> {
  kind: GameKindValue;
  hostId: string;
  players: string[];
  status: 'lobby' | 'playing' | 'finished';
  winners: string[];
  draw: boolean;
  data: D;
}

export type MoveResult<D> = { ok: true; state: GameState<D> } | { ok: false; error: string };

export interface GameOptions {
  word?: string;
  rounds?: number;
}

export interface GameDefinition<D = any> {
  kind: GameKindValue;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  create(hostId: string, options: GameOptions, rand: () => number, now: number): { ok: true; state: GameState<D> } | { ok: false; error: string };
  join(state: GameState<D>, userId: string, rand: () => number, now: number): MoveResult<D>;
  move(state: GameState<D>, userId: string, move: unknown, rand: () => number, now: number): MoveResult<D>;
  view(state: GameState<D>, viewerId: string, now: number): unknown;
}

function err<D>(error: string): MoveResult<D> {
  return { ok: false, error };
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

// ---------------- Tic-tac-toe ----------------

export interface TicTacToeData {
  board: number[]; // 0 empty, 1 X (players[0]), 2 O (players[1])
  turn: 0 | 1;
  line: number[] | null;
}

const TTT_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const ticTacToe: GameDefinition<TicTacToeData> = {
  kind: 'tictactoe',
  name: 'Tic-tac-toe',
  description: 'Three in a row. Two players.',
  minPlayers: 2,
  maxPlayers: 2,
  create(hostId) {
    return {
      ok: true,
      state: {
        kind: 'tictactoe',
        hostId,
        players: [hostId],
        status: 'lobby',
        winners: [],
        draw: false,
        data: { board: Array(9).fill(0), turn: 0, line: null },
      },
    };
  },
  join(state, userId) {
    if (state.status !== 'lobby') return err('Game already started');
    if (state.players.includes(userId)) return err('Already in the game');
    const s = clone(state);
    s.players.push(userId);
    if (s.players.length === 2) s.status = 'playing';
    return { ok: true, state: s };
  },
  move(state, userId, move) {
    if (state.status !== 'playing') return err('Game is not running');
    const idx = state.players.indexOf(userId);
    if (idx === -1) return err('You are not playing');
    if (idx !== state.data.turn) return err('Not your turn');
    const cell = (move as { cell?: unknown })?.cell;
    if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 0 || cell > 8) return err('Bad move');
    if (state.data.board[cell] !== 0) return err('Cell taken');
    const s = clone(state);
    s.data.board[cell] = idx + 1;
    const win = TTT_LINES.find((l) => l.every((c) => s.data.board[c] === idx + 1));
    if (win) {
      s.status = 'finished';
      s.winners = [userId];
      s.data.line = win;
    } else if (s.data.board.every((c) => c !== 0)) {
      s.status = 'finished';
      s.draw = true;
    } else {
      s.data.turn = (1 - s.data.turn) as 0 | 1;
    }
    return { ok: true, state: s };
  },
  view(state) {
    return state.data;
  },
};

// ---------------- Connect four ----------------

export interface Connect4Data {
  board: number[]; // 7 cols x 6 rows, row-major from the top: index = row * 7 + col
  turn: 0 | 1;
  last: number | null;
  line: number[] | null;
}

export const C4_COLS = 7;
export const C4_ROWS = 6;

function c4Winner(board: number[], idx: number): number[] | null {
  const p = board[idx];
  if (!p) return null;
  const r0 = Math.floor(idx / C4_COLS);
  const c0 = idx % C4_COLS;
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ] as const) {
    const cells = [idx];
    for (const sign of [1, -1]) {
      let r = r0 + dr * sign;
      let c = c0 + dc * sign;
      while (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS && board[r * C4_COLS + c] === p) {
        cells.push(r * C4_COLS + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (cells.length >= 4) return cells.sort((a, b) => a - b);
  }
  return null;
}

export const connectFour: GameDefinition<Connect4Data> = {
  kind: 'connect4',
  name: 'Connect four',
  description: 'Drop discs, get four in a row. Two players.',
  minPlayers: 2,
  maxPlayers: 2,
  create(hostId) {
    return {
      ok: true,
      state: {
        kind: 'connect4',
        hostId,
        players: [hostId],
        status: 'lobby',
        winners: [],
        draw: false,
        data: { board: Array(C4_COLS * C4_ROWS).fill(0), turn: 0, last: null, line: null },
      },
    };
  },
  join: ticTacToe.join as unknown as GameDefinition<Connect4Data>['join'],
  move(state, userId, move) {
    if (state.status !== 'playing') return err('Game is not running');
    const idx = state.players.indexOf(userId);
    if (idx === -1) return err('You are not playing');
    if (idx !== state.data.turn) return err('Not your turn');
    const col = (move as { col?: unknown })?.col;
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= C4_COLS) return err('Bad move');
    let target = -1;
    for (let r = C4_ROWS - 1; r >= 0; r--) {
      if (state.data.board[r * C4_COLS + col] === 0) {
        target = r * C4_COLS + col;
        break;
      }
    }
    if (target === -1) return err('Column full');
    const s = clone(state);
    s.data.board[target] = idx + 1;
    s.data.last = target;
    const line = c4Winner(s.data.board, target);
    if (line) {
      s.status = 'finished';
      s.winners = [userId];
      s.data.line = line;
    } else if (s.data.board.every((c) => c !== 0)) {
      s.status = 'finished';
      s.draw = true;
    } else {
      s.data.turn = (1 - s.data.turn) as 0 | 1;
    }
    return { ok: true, state: s };
  },
  view(state) {
    return state.data;
  },
};

// ---------------- Hangman ----------------

export interface HangmanData {
  word: string;
  guessed: string[];
  wrong: number;
  maxWrong: number;
  lastGuess: { userId: string; guess: string; hit: boolean } | null;
}

function normaliseWord(w: string): string {
  return w
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function hangmanSolved(d: HangmanData): boolean {
  return [...d.word].every((ch) => ch === ' ' || d.guessed.includes(ch));
}

export const hangman: GameDefinition<HangmanData> = {
  kind: 'hangman',
  name: 'Hangman',
  description: 'The host picks a secret word, everyone else guesses letters. Up to 8 guessers.',
  minPlayers: 2,
  maxPlayers: 9,
  create(hostId, options) {
    const word = normaliseWord(options.word ?? '');
    if (!/^[a-z]+(?: [a-z]+)*$/.test(word) || word.replace(/ /g, '').length < 3 || word.length > 30) {
      return { ok: false, error: 'Word must be 3–30 letters (a–z, spaces allowed)' };
    }
    return {
      ok: true,
      state: {
        kind: 'hangman',
        hostId,
        players: [hostId],
        status: 'playing',
        winners: [],
        draw: false,
        data: { word, guessed: [], wrong: 0, maxWrong: 6, lastGuess: null },
      },
    };
  },
  join(state, userId) {
    if (state.status === 'finished') return err('Game is over');
    if (state.players.includes(userId)) return err('Already in the game');
    if (state.players.length >= 9) return err('Game is full');
    const s = clone(state);
    s.players.push(userId);
    return { ok: true, state: s };
  },
  move(state, userId, move) {
    if (state.status !== 'playing') return err('Game is not running');
    if (userId === state.hostId) return err('You picked the word, no guessing');
    if (!state.players.includes(userId)) return err('Join the game first');
    const raw = (move as { guess?: unknown })?.guess;
    if (typeof raw !== 'string') return err('Bad move');
    const guess = normaliseWord(raw);
    const s = clone(state);
    const d = s.data;
    if (guess.length === 1) {
      if (!/^[a-z]$/.test(guess)) return err('Letters only');
      if (d.guessed.includes(guess)) return err('Already guessed');
      d.guessed.push(guess);
      const hit = d.word.includes(guess);
      if (!hit) d.wrong++;
      d.lastGuess = { userId, guess, hit };
    } else {
      if (guess.length < 2 || guess.length > 30) return err('Bad guess');
      const hit = guess === d.word;
      if (hit) {
        for (const ch of d.word) {
          if (ch !== ' ' && !d.guessed.includes(ch)) d.guessed.push(ch);
        }
      } else {
        d.wrong++;
      }
      d.lastGuess = { userId, guess, hit };
    }
    if (hangmanSolved(d)) {
      s.status = 'finished';
      s.winners = s.players.filter((p) => p !== s.hostId);
    } else if (d.wrong >= d.maxWrong) {
      s.status = 'finished';
      s.winners = [s.hostId];
    }
    return { ok: true, state: s };
  },
  view(state, viewerId) {
    const d = state.data;
    const reveal = state.status === 'finished' || viewerId === state.hostId;
    return {
      masked: [...d.word].map((ch) => (ch === ' ' ? ' ' : d.guessed.includes(ch) || reveal ? ch : '_')).join(''),
      word: reveal ? d.word : null,
      guessed: d.guessed,
      wrong: d.wrong,
      maxWrong: d.maxWrong,
      lastGuess: d.lastGuess,
    };
  },
};

// ---------------- Anagram race ----------------

export interface AnagramData {
  words: string[];
  round: number; // 0-based, -1 before start
  scrambled: string;
  roundEndsAt: number;
  roundSeconds: number;
  scores: Record<string, number>;
  history: { word: string; winner: string | null }[];
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function scramble(word: string, rand: () => number): string {
  for (let tries = 0; tries < 10; tries++) {
    const s = shuffle([...word], rand).join('');
    if (s !== word) return s;
  }
  return [...word].reverse().join('');
}

function anagramAdvance(s: GameState<AnagramData>, winner: string | null, rand: () => number, now: number) {
  const d = s.data;
  d.history.push({ word: d.words[d.round]!, winner });
  if (winner) d.scores[winner] = (d.scores[winner] ?? 0) + 1;
  d.round++;
  if (d.round >= d.words.length) {
    s.status = 'finished';
    const best = Math.max(0, ...Object.values(d.scores));
    s.winners = best > 0 ? Object.keys(d.scores).filter((k) => d.scores[k] === best) : [];
    s.draw = s.winners.length !== 1;
    d.scrambled = '';
  } else {
    d.scrambled = scramble(d.words[d.round]!, rand);
    d.roundEndsAt = now + d.roundSeconds * 1000;
  }
}

/** Applies any timeouts that passed. Returns true if the state changed. */
export function anagramCatchUp(s: GameState<AnagramData>, rand: () => number, now: number): boolean {
  let changed = false;
  while (s.status === 'playing' && now >= s.data.roundEndsAt) {
    anagramAdvance(s, null, rand, s.data.roundEndsAt);
    changed = true;
  }
  return changed;
}

export const anagramRace: GameDefinition<AnagramData> = {
  kind: 'anagram',
  name: 'Anagram race',
  description: 'Unscramble the word first to score. The host starts when everyone is in. Up to 16 players.',
  minPlayers: 1,
  maxPlayers: 16,
  create(hostId, options, rand) {
    const rounds = Math.min(10, Math.max(1, options.rounds ?? 5));
    const words = shuffle([...ANAGRAM_WORDS], rand).slice(0, rounds);
    return {
      ok: true,
      state: {
        kind: 'anagram',
        hostId,
        players: [hostId],
        status: 'lobby',
        winners: [],
        draw: false,
        data: { words, round: -1, scrambled: '', roundEndsAt: 0, roundSeconds: 45, scores: { [hostId]: 0 }, history: [] },
      },
    };
  },
  join(state, userId) {
    if (state.status === 'finished') return err('Game is over');
    if (state.players.includes(userId)) return err('Already in the game');
    if (state.players.length >= 16) return err('Game is full');
    const s = clone(state);
    s.players.push(userId);
    s.data.scores[userId] = 0;
    return { ok: true, state: s };
  },
  move(state, userId, move, rand, now) {
    const s = clone(state);
    const m = move as { type?: unknown; guess?: unknown };
    if (m?.type === 'start') {
      if (s.status !== 'lobby') return err('Already started');
      if (userId !== s.hostId) return err('Only the host can start');
      s.status = 'playing';
      s.data.round = 0;
      s.data.scrambled = scramble(s.data.words[0]!, rand);
      s.data.roundEndsAt = now + s.data.roundSeconds * 1000;
      return { ok: true, state: s };
    }
    if (s.status !== 'playing') return err('Game is not running');
    if (m?.type === 'tick') {
      return anagramCatchUp(s, rand, now) ? { ok: true, state: s } : err('Round still running');
    }
    if (!s.players.includes(userId)) return err('Join the game first');
    if (m?.type !== 'guess' || typeof m.guess !== 'string') return err('Bad move');
    anagramCatchUp(s, rand, now);
    if (s.status !== 'playing') return { ok: true, state: s };
    const guess = m.guess.trim().toLowerCase();
    if (guess !== s.data.words[s.data.round]) return err('Nope');
    anagramAdvance(s, userId, rand, now);
    return { ok: true, state: s };
  },
  view(state) {
    const d = state.data;
    return {
      round: d.round,
      rounds: d.words.length,
      scrambled: d.scrambled,
      roundEndsAt: d.roundEndsAt,
      scores: d.scores,
      history: d.history,
    };
  },
};

export const GAMES: Record<GameKindValue, GameDefinition> = {
  tictactoe: ticTacToe,
  connect4: connectFour,
  hangman,
  anagram: anagramRace,
};
