// Builds src/lib/emoji-data.json (compact) from unicode-emoji-json. Run: node scripts/emoji.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const groups = JSON.parse(readFileSync(new URL('../node_modules/unicode-emoji-json/data-by-group.json', import.meta.url), 'utf8'));
const out = groups
  .filter((g) => g.slug !== 'component')
  .map((g) => [g.name, g.emojis.map((e) => [e.emoji, e.slug, e.skin_tone_support ? 1 : 0])]);
writeFileSync(new URL('../src/lib/emoji-data.json', import.meta.url), JSON.stringify(out));
console.log('groups', out.length, 'emoji', out.reduce((n, g) => n + g[1].length, 0));
