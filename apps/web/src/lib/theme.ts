import { DARK_THEME, LIGHT_THEME, THEME_KEYS, type ClientSettings, type ClientTheme, type ProfileFont } from '@dbb/shared';

const CSS_VAR: Record<string, string> = {
  bg0: '--bg-0',
  bg1: '--bg-1',
  bg2: '--bg-2',
  bg3: '--bg-3',
  bgFloat: '--bg-float',
  text: '--text',
  textMuted: '--text-muted',
  textFaint: '--text-faint',
  accent: '--accent',
  accentText: '--accent-text',
  link: '--link',
  danger: '--danger',
  success: '--success',
  warning: '--warning',
  border: '--border',
  mention: '--mention',
};

export function themeFor(s: ClientSettings): ClientTheme {
  if (s.themeMode === 'light') return LIGHT_THEME;
  if (s.themeMode === 'custom' && s.customTheme) return s.customTheme;
  return DARK_THEME;
}

/** Colours are validated hex strings (zod on the server + decodeTheme), so this can't inject CSS. */
export function applyTheme(s: ClientSettings, preview?: ClientTheme) {
  if (typeof document === 'undefined') return;
  const theme = preview ?? themeFor(s);
  const root = document.documentElement;
  for (const k of THEME_KEYS) {
    const v = theme.colors[k];
    if (/^#[0-9a-fA-F]{6}$/.test(v)) root.style.setProperty(CSS_VAR[k]!, v);
  }
  root.style.setProperty('--radius', `${theme.radius}px`);
  root.style.setProperty('--font-scale', String(s.fontScale));
  root.dataset.compact = s.compact ? '1' : '0';
  root.dataset.reduceMotion = s.reduceMotion ? '1' : '0';
  const dark = luminance(theme.colors.bg2) < 0.4;
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export function readableOn(hex: string): string {
  return luminance(hex) > 0.6 ? '#111111' : '#ffffff';
}

const FONT_FAMILY: Record<ProfileFont, string> = {
  default: 'inherit',
  inter: "'Inter', sans-serif",
  'space-grotesk': "'Space Grotesk', sans-serif",
  lora: "'Lora', serif",
  playfair: "'Playfair Display', serif",
  'jetbrains-mono': "'JetBrains Mono', monospace",
  'comic-neue': "'Comic Neue', cursive",
  pixel: "'Press Start 2P', monospace",
  pacifico: "'Pacifico', cursive",
};

const loaded = new Set<ProfileFont>();

/** Profile fonts are bundled (no Google Fonts) and only downloaded when a profile actually uses one. */
export function loadFont(font: ProfileFont | undefined): string {
  if (!font || font === 'default') return 'inherit';
  if (!loaded.has(font)) {
    loaded.add(font);
    const loaders: Record<Exclude<ProfileFont, 'default'>, () => Promise<unknown>> = {
      inter: () => import('@fontsource/inter/600.css'),
      'space-grotesk': () => import('@fontsource/space-grotesk/500.css'),
      lora: () => import('@fontsource/lora/500.css'),
      playfair: () => import('@fontsource/playfair-display/600.css'),
      'jetbrains-mono': () => import('@fontsource/jetbrains-mono/500.css'),
      'comic-neue': () => import('@fontsource/comic-neue/700.css'),
      pixel: () => import('@fontsource/press-start-2p/400.css'),
      pacifico: () => import('@fontsource/pacifico/400.css'),
    };
    void loaders[font]();
  }
  return FONT_FAMILY[font];
}
