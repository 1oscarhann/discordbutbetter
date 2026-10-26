<script lang="ts">
  import { DARK_THEME, LIGHT_THEME, Limits, THEME_KEYS, THEME_KEY_LABELS, decodeTheme, encodeTheme, type ClientTheme, type ThemeKey } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { applyTheme, themeFor } from '$lib/theme';
  import { copy } from '$lib/util/channel';

  const s = $derived(app.settings);

  // the editor works on a copy; the whole app previews it live until you save or leave
  let editing = $state<ClientTheme | null>(null);
  let importCode = $state('');
  let importError = $state('');

  function startEditing(from: ClientTheme) {
    editing = structuredClone($state.snapshot(from) as ClientTheme);
  }
  $effect(() => {
    if (editing) applyTheme(app.settings, $state.snapshot(editing) as ClientTheme);
  });
  // leaving the tab (or closing settings) drops an unsaved preview
  $effect(() => () => applyTheme(app.settings));

  async function useMode(mode: 'dark' | 'light') {
    editing = null;
    await app.updateSettings({ themeMode: mode });
  }

  async function saveCustom() {
    if (!editing) return;
    const t = $state.snapshot(editing) as ClientTheme;
    const saved = [...s.savedThemes.filter((x) => x.name !== t.name), t].slice(-Limits.SAVED_THEMES_MAX);
    await app.updateSettings({ themeMode: 'custom', customTheme: t, savedThemes: saved });
    editing = null;
  }

  async function applySaved(t: ClientTheme) {
    editing = null;
    await app.updateSettings({ themeMode: 'custom', customTheme: t });
  }

  async function removeSaved(t: ClientTheme) {
    await app.updateSettings({ savedThemes: s.savedThemes.filter((x) => x !== t && x.name !== t.name) });
  }

  function doImport() {
    importError = '';
    const t = decodeTheme(importCode);
    if (!t) return void (importError = "That's not a valid theme code");
    startEditing(t);
    importCode = '';
  }

  function contrast(a: string, b: string): number {
    const lum = (hex: string) => {
      const n = parseInt(hex.slice(1), 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  }
  const lowContrast = $derived(editing ? contrast(editing.colors.text, editing.colors.bg2) < 4.5 : false);
  const groups: { title: string; keys: ThemeKey[] }[] = [
    { title: 'Backgrounds', keys: ['bg0', 'bg1', 'bg2', 'bg3', 'bgFloat', 'border'] },
    { title: 'Text', keys: ['text', 'textMuted', 'textFaint', 'link'] },
    { title: 'Accents', keys: ['accent', 'accentText', 'mention', 'success', 'warning', 'danger'] },
  ];
</script>

<h2>Appearance</h2>

<div class="modes">
  {#each [['dark', DARK_THEME], ['light', LIGHT_THEME]] as const as [mode, t] (mode)}
    <button class="mode" class:on={s.themeMode === mode && !editing} onclick={() => useMode(mode)}>
      <span class="sw" style="background:{t.colors.bg2};border-color:{t.colors.border}">
        <span style="background:{t.colors.bg1}"></span><span style="background:{t.colors.accent}"></span>
      </span>
      {t.name}
    </button>
  {/each}
  <button class="mode" class:on={s.themeMode === 'custom' || !!editing} onclick={() => startEditing(s.customTheme ?? themeFor(s))}>
    <span class="sw custom"></span>
    Custom
  </button>
</div>

{#if editing}
  <div class="editor card fade-in">
    <div class="row" style="gap:8px">
      <input class="input" bind:value={editing.name} maxlength="40" placeholder="Theme name" style="flex:1" />
      <button class="btn ghost" onclick={() => ((editing = null), applyTheme(app.settings))}>Cancel</button>
      <button class="btn primary" disabled={!editing.name.trim()} onclick={saveCustom}>Save & use</button>
    </div>
    <p class="faint small">Previewing live across the whole app.</p>
    {#if lowContrast}<p class="error-text small">Heads up: main text on the chat background is hard to read (contrast below 4.5:1).</p>{/if}
    <div class="start row">
      <span class="faint small">Start from:</span>
      <button class="btn small" onclick={() => startEditing({ ...DARK_THEME, name: editing?.name || 'My theme' })}>Midnight</button>
      <button class="btn small" onclick={() => startEditing({ ...LIGHT_THEME, name: editing?.name || 'My theme' })}>Daylight</button>
    </div>
    {#each groups as g (g.title)}
      <h3>{g.title}</h3>
      <div class="colors">
        {#each g.keys as k (k)}
          <label class="color">
            <input type="color" bind:value={editing.colors[k]} />
            <span class="col" style="gap:0;min-width:0">
              <span class="truncate">{THEME_KEY_LABELS[k]}</span>
              <code class="faint small">{editing.colors[k]}</code>
            </span>
          </label>
        {/each}
      </div>
    {/each}
    <div class="field" style="margin-top:14px">
      <label for="rad">Corner roundness — {editing.radius}px</label>
      <input id="rad" type="range" min="0" max="16" bind:value={editing.radius} />
    </div>
    <div class="field">
      <span class="label">Share code</span>
      <div class="row" style="gap:6px">
        <input class="input code" readonly value={editing.name.trim() ? encodeTheme($state.snapshot(editing) as ClientTheme) : ''} onfocus={(e) => (e.target as HTMLInputElement).select()} />
        <button class="btn" disabled={!editing.name.trim()} onclick={() => editing && copy(encodeTheme($state.snapshot(editing) as ClientTheme), 'Theme code copied')}>Copy</button>
      </div>
      <span class="hint">Theme codes only contain colours and a name — importing one can't run code or load anything.</span>
    </div>
  </div>
{/if}

<h3>Import a theme</h3>
<div class="row" style="gap:6px">
  <input class="input code" placeholder="THEME1.…" bind:value={importCode} />
  <button class="btn" disabled={!importCode.trim()} onclick={doImport}>Preview</button>
</div>
{#if importError}<p class="error-text small">{importError}</p>{/if}

{#if s.savedThemes.length}
  <h3>Your themes ({s.savedThemes.length}/{Limits.SAVED_THEMES_MAX})</h3>
  <div class="saved">
    {#each s.savedThemes as t (t.name)}
      <div class="list-item">
        <span class="mini" style="background:linear-gradient(135deg,{t.colors.bg2} 50%,{t.colors.accent} 50%)"></span>
        <span class="truncate" style="flex:1">{t.name} {#if s.themeMode === 'custom' && s.customTheme?.name === t.name}<span class="pill">In use</span>{/if}</span>
        <button class="btn small" onclick={() => applySaved(t)}>Use</button>
        <button class="btn small ghost" onclick={() => startEditing(t)}>Edit</button>
        <button class="btn small ghost" onclick={() => copy(encodeTheme(t), 'Theme code copied')}>Code</button>
        <button class="btn small ghost" onclick={() => removeSaved(t)}>Delete</button>
      </div>
    {/each}
  </div>
{/if}

<h3>Layout</h3>
<label class="srow">
  <span class="txt"><strong>Compact messages</strong><small>Fit more messages on screen, IRC-style</small></span>
  <input type="checkbox" class="switch" checked={s.compact} onchange={(e) => app.updateSettings({ compact: (e.target as HTMLInputElement).checked })} />
</label>
<div class="field" style="margin-top:12px">
  <label for="fs">Text size — {Math.round(s.fontScale * 100)}%</label>
  <input id="fs" type="range" min="0.8" max="1.4" step="0.05" value={s.fontScale} onchange={(e) => app.updateSettings({ fontScale: Number((e.target as HTMLInputElement).value) })} />
</div>

<style>
  .modes {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    margin: 12px 0;
  }
  .mode {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    border: 2px solid transparent;
    border-radius: 12px;
    padding: 8px;
    background: none;
    cursor: pointer;
    color: var(--text);
    font-weight: 600;
  }
  .mode.on {
    border-color: var(--accent);
  }
  .sw {
    width: 96px;
    height: 64px;
    border-radius: 10px;
    border: 1px solid;
    display: flex;
    gap: 6px;
    padding: 8px;
  }
  .sw span:first-child {
    width: 24px;
    border-radius: 4px;
  }
  .sw span:last-child {
    width: 30px;
    height: 10px;
    border-radius: 99px;
    align-self: flex-end;
  }
  .sw.custom {
    background: conic-gradient(from 90deg, #ff6a88, #f7971e, #ffd200, #38ef7d, #00c6ff, #7f5af0, #ff6a88);
    border-color: transparent;
  }
  .editor {
    margin-bottom: 10px;
  }
  .start {
    gap: 6px;
    margin: 6px 0;
  }
  .colors {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 6px;
  }
  .color {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border-radius: 8px;
    background: var(--bg-0);
    cursor: pointer;
  }
  .color input {
    width: 34px;
    height: 34px;
    border: none;
    padding: 0;
    background: none;
    cursor: pointer;
    flex: none;
  }
  .code {
    flex: 1;
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
  }
  .mini {
    width: 26px;
    height: 26px;
    border-radius: 6px;
    flex: none;
  }
  input[type='range'] {
    width: 100%;
  }
</style>
