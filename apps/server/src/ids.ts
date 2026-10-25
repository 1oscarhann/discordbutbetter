import { randomBytes, randomInt } from 'node:crypto';
import { SNOWFLAKE_EPOCH } from '@dbb/shared';

/**
 * 64-bit time-sortable ids: 42 bits ms since 2026-01-01, 10 bits worker, 12 bits sequence.
 * Worker id is random per process so several app processes don't collide.
 */
const WORKER = BigInt(randomInt(0, 1024));
let lastMs = 0;
let seq = 0;

export function snowflake(): string {
  let now = Date.now();
  if (now < lastMs) now = lastMs; // clock went backwards: stick to the last ms
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) {
      // sequence exhausted for this ms: spin to the next one
      while (Date.now() <= lastMs) {
        /* busy wait < 1ms */
      }
      now = Date.now();
    }
  } else {
    seq = 0;
  }
  lastMs = now;
  return ((BigInt(now - SNOWFLAKE_EPOCH) << 22n) | (WORKER << 12n) | BigInt(seq)).toString();
}

/** URL-safe random token. 32 bytes = 256 bits by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Short human-friendly code (invites). 10 chars ≈ 58 bits. */
export function inviteCode(len = 10): string {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return s;
}
