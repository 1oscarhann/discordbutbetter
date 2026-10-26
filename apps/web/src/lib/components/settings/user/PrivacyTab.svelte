<script lang="ts">
  import type { PrivacySettings, SelfUser } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, patch } from '$lib/api';

  const p = $derived(app.me!.privacy);

  async function set(body: Partial<PrivacySettings>) {
    try {
      const u = await patch<SelfUser>('/users/@me/privacy', body);
      app.me = { ...app.me!, ...u };
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<h2>Privacy & safety</h2>
<p class="muted">
  No tracking, no analytics, no ads, no IP logs. Uploaded images get their EXIF data (like GPS) stripped, and link previews and covers load through
  this server so third parties never see your IP.
</p>

<h3>"Last seen" when you're offline</h3>
{#each [['everyone', 'Everyone who can see your status'], ['friends', 'Friends only'], ['nobody', 'Nobody']] as const as [v, l] (v)}
  <label class="radio"><input type="radio" name="ls" checked={p.lastSeen === v} onchange={() => set({ lastSeen: v })} /> {l}</label>
{/each}
<p class="faint small">Going invisible also freezes your "last seen" at the moment you went invisible.</p>

<h3>Read receipts</h3>
<label class="srow">
  <span class="txt">
    <strong>Send read receipts in DMs</strong>
    <small>Works both ways: you only see someone's "Seen" if you both have this on.</small>
  </span>
  <input type="checkbox" class="switch" checked={p.readReceipts} onchange={(e) => set({ readReceipts: (e.target as HTMLInputElement).checked })} />
</label>

<h3>Who can DM you</h3>
{#each [['everyone', 'Anyone who shares a server with you'], ['friends', 'Friends only']] as const as [v, l] (v)}
  <label class="radio"><input type="radio" name="dm" checked={p.dmPolicy === v} onchange={() => set({ dmPolicy: v })} /> {l}</label>
{/each}

<h3>Who can send you friend requests</h3>
{#each [['everyone', 'Everyone'], ['mutual', 'People who share a server with you'], ['nobody', 'Nobody']] as const as [v, l] (v)}
  <label class="radio"><input type="radio" name="fr" checked={p.friendRequests === v} onchange={() => set({ friendRequests: v })} /> {l}</label>
{/each}

<h3>Encryption, honestly</h3>
<p class="faint small">
  Messages are encrypted in transit (HTTPS/WSS) but <strong>not end-to-end encrypted</strong>: whoever runs this server can technically read them.
  Only use instances run by people you trust, or run your own.
</p>
