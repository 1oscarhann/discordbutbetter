<script lang="ts">
  import type { ClientSettings } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';

  const s = $derived(app.settings);
  type BoolKey = { [K in keyof ClientSettings]: ClientSettings[K] extends boolean ? K : never }[keyof ClientSettings];
  const toggles: { key: BoolKey; label: string; desc: string }[] = [
    { key: 'sendOnEnter', label: 'Enter sends the message', desc: 'Off: Enter adds a new line and Ctrl+Enter sends' },
    { key: 'use24h', label: '24-hour time', desc: '13:37 instead of 1:37 PM' },
    { key: 'showEmbeds', label: 'Show link previews', desc: 'Previews are fetched by the server, never by your browser' },
    { key: 'reduceMotion', label: 'Reduce motion', desc: 'Tone down animations and transitions' },
    { key: 'autoplayProfileSongs', label: "Autoplay profile songs", desc: "Off by default. You can always mute one from the profile" },
    { key: 'showIds', label: 'Developer mode', desc: 'Adds "Copy ID" to menus' },
  ];
</script>

<h2>Chat & accessibility</h2>
{#each toggles as t (t.key)}
  <label class="srow">
    <span class="txt"><strong>{t.label}</strong><small>{t.desc}</small></span>
    <input type="checkbox" class="switch" checked={s[t.key]} onchange={(e) => app.updateSettings({ [t.key]: (e.target as HTMLInputElement).checked })} />
  </label>
{/each}

<div class="field" style="margin-top:16px">
  <label for="vol">Profile song volume — {Math.round(s.profileSongVolume * 100)}%</label>
  <input id="vol" type="range" min="0" max="1" step="0.05" value={s.profileSongVolume} onchange={(e) => app.updateSettings({ profileSongVolume: Number((e.target as HTMLInputElement).value) })} />
</div>

<h3>Keyboard shortcuts</h3>
<table class="keys">
  <tbody>
    <tr><td><kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">K</kbd></td><td>Quick switcher</td></tr>
    <tr><td><kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">,</kbd></td><td>Settings</td></tr>
    <tr><td><kbd class="kbd">Ctrl</kbd> + <kbd class="kbd">Shift</kbd> + <kbd class="kbd">M</kbd></td><td>Toggle mute</td></tr>
    <tr><td><kbd class="kbd">↑</kbd> in an empty message box</td><td>Edit your last message</td></tr>
    <tr><td><kbd class="kbd">Esc</kbd></td><td>Cancel reply / edit, close popups</td></tr>
    <tr><td><kbd class="kbd">Shift</kbd> + <kbd class="kbd">Enter</kbd></td><td>New line</td></tr>
  </tbody>
</table>

<style>
  .keys td {
    padding: 5px 12px 5px 0;
  }
  input[type='range'] {
    width: 100%;
  }
</style>
