import { z } from 'zod';
import { Limits } from './constants.js';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, { error: 'Colour must look like #a1b2c3' });

export const THEME_KEYS = [
  'bg0',
  'bg1',
  'bg2',
  'bg3',
  'bgFloat',
  'text',
  'textMuted',
  'textFaint',
  'accent',
  'accentText',
  'link',
  'danger',
  'success',
  'warning',
  'border',
  'mention',
] as const;
export type ThemeKey = (typeof THEME_KEYS)[number];

export const THEME_KEY_LABELS: Record<ThemeKey, string> = {
  bg0: 'Server list',
  bg1: 'Sidebars',
  bg2: 'Chat background',
  bg3: 'Inputs and hover',
  bgFloat: 'Popups and menus',
  text: 'Main text',
  textMuted: 'Secondary text',
  textFaint: 'Faint text',
  accent: 'Accent',
  accentText: 'Text on accent',
  link: 'Links',
  danger: 'Danger',
  success: 'Success',
  warning: 'Warning',
  border: 'Borders',
  mention: 'Mention highlight',
};

export const ThemeColorsSchema = z.object(
  Object.fromEntries(THEME_KEYS.map((k) => [k, hex])) as Record<ThemeKey, typeof hex>,
);

export const ClientThemeSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    colors: ThemeColorsSchema,
    radius: z.number().int().min(0).max(16).default(8),
  })
  .strict();
export type ClientTheme = z.infer<typeof ClientThemeSchema>;

export const DARK_THEME: ClientTheme = {
  name: 'Midnight',
  radius: 8,
  colors: {
    bg0: '#0e0f13',
    bg1: '#16171d',
    bg2: '#1c1d24',
    bg3: '#262833',
    bgFloat: '#111218',
    text: '#e7e8ee',
    textMuted: '#a3a6b4',
    textFaint: '#6c7080',
    accent: '#7c6cff',
    accentText: '#ffffff',
    link: '#8fb4ff',
    danger: '#f0506e',
    success: '#3ecf8e',
    warning: '#f5b84a',
    border: '#2c2e3a',
    mention: '#3b3466',
  },
};

export const LIGHT_THEME: ClientTheme = {
  name: 'Daylight',
  radius: 8,
  colors: {
    bg0: '#e4e5ea',
    bg1: '#eff0f4',
    bg2: '#ffffff',
    bg3: '#e6e7ec',
    bgFloat: '#ffffff',
    text: '#1d1f27',
    textMuted: '#555a6b',
    textFaint: '#8a8fa0',
    accent: '#5b4dff',
    accentText: '#ffffff',
    link: '#2858c9',
    danger: '#d63155',
    success: '#1a9e64',
    warning: '#b77a0b',
    border: '#d5d7df',
    mention: '#e6e1ff',
  },
};

const THEME_PREFIX = 'THEME1.';

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Share code for a theme. Only hex colours and a name go in, so importing one can't inject CSS. */
export function encodeTheme(theme: ClientTheme): string {
  const t = ClientThemeSchema.parse(theme);
  const compact = { n: t.name, r: t.radius, c: THEME_KEYS.map((k) => t.colors[k].slice(1)).join('') };
  return THEME_PREFIX + toBase64Url(JSON.stringify(compact));
}

export function decodeTheme(code: string): ClientTheme | null {
  const s = code.trim();
  if (!s.startsWith(THEME_PREFIX) || s.length > 2000) return null;
  try {
    const raw = JSON.parse(fromBase64Url(s.slice(THEME_PREFIX.length))) as { n?: unknown; r?: unknown; c?: unknown };
    if (typeof raw.c !== 'string' || raw.c.length !== THEME_KEYS.length * 6) return null;
    const colors = Object.fromEntries(THEME_KEYS.map((k, i) => [k, '#' + (raw.c as string).slice(i * 6, i * 6 + 6)]));
    const parsed = ClientThemeSchema.safeParse({ name: raw.n, radius: raw.r, colors });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const settingsFields = {
  themeMode: [z.enum(['dark', 'light', 'custom']), 'dark'],
  customTheme: [ClientThemeSchema.nullable(), null],
  savedThemes: [z.array(ClientThemeSchema).max(Limits.SAVED_THEMES_MAX), []],
  compact: [z.boolean(), false],
  fontScale: [z.number().min(0.8).max(1.4), 1],
  reduceMotion: [z.boolean(), false],
  animateEmoji: [z.boolean(), true],
  showEmbeds: [z.boolean(), true],
  autoplayProfileSongs: [z.boolean(), false],
  profileSongVolume: [z.number().min(0).max(1), 0.5],
  desktopNotifications: [z.boolean(), true],
  notificationSounds: [z.boolean(), true],
  sendOnEnter: [z.boolean(), true],
  use24h: [z.boolean(), false],
  showIds: [z.boolean(), false],
  guildOrder: [z.array(z.string().regex(/^\d{1,20}$/)).max(500), []],
  highlightsThreshold: [z.number().int().min(10).max(1000), 30],
} as const;

type Fields = typeof settingsFields;
type FieldSchema<K extends keyof Fields> = Fields[K][0];

/** Patch schema: every field optional, NO defaults (zod 4 applies defaults inside .partial()). */
export const ClientSettingsPatchSchema = z
  .object(
    Object.fromEntries(Object.entries(settingsFields).map(([k, [schema]]) => [k, schema.optional()])) as {
      [K in keyof Fields]: z.ZodOptional<FieldSchema<K>>;
    },
  )
  .strict();

export type ClientSettings = { [K in keyof Fields]: z.infer<FieldSchema<K>> };

export const SETTINGS_DEFAULTS: ClientSettings = Object.fromEntries(
  Object.entries(settingsFields).map(([k, [, d]]) => [k, d]),
) as unknown as ClientSettings;

/** Merge stored (possibly old/partial) settings with defaults, dropping anything invalid. */
export function normaliseSettings(stored: unknown): ClientSettings {
  const out: Record<string, unknown> = structuredClone(SETTINGS_DEFAULTS) as unknown as Record<string, unknown>;
  if (stored && typeof stored === 'object') {
    for (const [k, [schema]] of Object.entries(settingsFields)) {
      const v = (stored as Record<string, unknown>)[k];
      if (v === undefined) continue;
      const r = (schema as z.ZodType).safeParse(v);
      if (r.success) out[k] = r.data;
    }
  }
  return out as ClientSettings;
}

export function defaultSettings(): ClientSettings {
  return structuredClone(SETTINGS_DEFAULTS);
}
