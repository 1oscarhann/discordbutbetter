/** XP needed to go from `level` to `level + 1` (MEE6-style curve). */
export function xpToNext(level: number): number {
  return 5 * level * level + 50 * level + 100;
}

/** Total XP needed to reach `level` from 0. */
export function totalXpFor(level: number): number {
  let total = 0;
  for (let l = 0; l < level; l++) total += xpToNext(l);
  return total;
}

export function levelFromXp(xp: number): { level: number; current: number; needed: number } {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpToNext(level) && level < 1000) {
    remaining -= xpToNext(level);
    level++;
  }
  return { level, current: remaining, needed: xpToNext(level) };
}

export const XP_PER_MESSAGE_MIN = 15;
export const XP_PER_MESSAGE_MAX = 25;
export const XP_COOLDOWN_SECONDS = 60;
