import { hash, verify } from '@node-rs/argon2';

// OWASP's recommended argon2id baseline: 19 MiB, 2 iterations. Light enough for a Pi under load.
// algorithm 2 = Argon2id (the const enum can't be imported under verbatimModuleSyntax)
const OPTS = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

let dummy: Promise<string> | null = null;

/** Verifies; with a null hash it still burns the same time so you can't tell if an account exists. */
export async function verifyPassword(hashStr: string | null, password: string): Promise<boolean> {
  if (!hashStr) {
    dummy ??= hashPassword('not-a-real-password-just-burning-time');
    await verify(await dummy, password).catch(() => false);
    return false;
  }
  try {
    return await verify(hashStr, password);
  } catch {
    return false;
  }
}
