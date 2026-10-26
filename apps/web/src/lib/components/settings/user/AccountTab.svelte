<script lang="ts">
  import { Limits, type SelfUser } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { errorMessage, post, put } from '$lib/api';
  import { fullDate } from '$lib/util/time';
  import Avatar from '../../Avatar.svelte';
  import Modal from '../../Modal.svelte';

  const me = $derived(app.me!);

  let editing = $state<'username' | 'email' | 'password' | null>(null);
  let value = $state('');
  let password = $state('');
  let newPassword = $state('');
  let confirmPw = $state('');
  let error = $state('');
  let busy = $state(false);

  function open(k: NonNullable<typeof editing>) {
    editing = k;
    value = k === 'username' ? me.username : k === 'email' ? me.email : '';
    password = newPassword = confirmPw = '';
    error = '';
  }

  async function submit(e: Event) {
    e.preventDefault();
    error = '';
    if (editing === 'password' && newPassword !== confirmPw) return void (error = "New passwords don't match");
    busy = true;
    try {
      if (editing === 'username') app.me = { ...me, ...(await put<SelfUser>('/users/@me/username', { username: value, password })) };
      else if (editing === 'email') app.me = { ...me, ...(await put<SelfUser>('/users/@me/email', { email: value, password })) };
      else if (editing === 'password') await put('/users/@me/password', { currentPassword: password, newPassword });
      app.toast(editing === 'password' ? 'Password changed — other devices were logged out' : 'Saved', 'success');
      editing = null;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function resend() {
    try {
      await post('/auth/resend-verification');
      app.toast('Verification email sent', 'success');
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }
</script>

<h2>My account</h2>
<div class="hero card">
  <Avatar src={me.avatar} name={me.displayName || me.username} size={72} />
  <div class="col" style="gap:2px;flex:1;min-width:0">
    <strong class="dn truncate">{me.displayName || me.username}</strong>
    <span class="faint">@{me.username} · joined {fullDate(me.createdAt)}</span>
    {#if me.isAdmin}<span class="pill" style="align-self:flex-start">Instance admin</span>{/if}
  </div>
  <button class="btn primary" onclick={() => (ui.settings = 'profile')}>Edit profile</button>
</div>

<div class="rows card">
  <div class="srow">
    <span class="txt"><span class="label">Username</span><span>@{me.username}</span></span>
    <button class="btn" onclick={() => open('username')}>Edit</button>
  </div>
  <div class="srow">
    <span class="txt">
      <span class="label">Email</span>
      <span>{me.email} {#if !me.emailVerified}<span class="pill warn">Unverified</span>{/if}</span>
      <small>Only used to log in and reset your password. Never shown to anyone, never used for marketing.</small>
    </span>
    {#if !me.emailVerified && app.instance?.emailEnabled}<button class="btn ghost" onclick={resend}>Resend</button>{/if}
    <button class="btn" onclick={() => open('email')}>Edit</button>
  </div>
  <div class="srow">
    <span class="txt"><span class="label">Password</span><span>••••••••••</span></span>
    <button class="btn" onclick={() => open('password')}>Change</button>
  </div>
</div>
<p class="faint small">No phone number, no ID scan, no face scan. That's all we have on you.</p>

{#if editing}
  <Modal title={editing === 'username' ? 'Change username' : editing === 'email' ? 'Change email' : 'Change password'} onclose={() => (editing = null)} width={440}>
    <form id="acc" onsubmit={submit}>
      {#if editing === 'username'}
        <div class="field">
          <label for="v">Username</label>
          <input id="v" class="input" bind:value maxlength={Limits.USERNAME_MAX} autocomplete="username" required />
          <span class="hint">2–32 lowercase letters, numbers, _ and .</span>
        </div>
      {:else if editing === 'email'}
        <div class="field">
          <label for="v">Email</label>
          <input id="v" class="input" type="email" bind:value maxlength="254" autocomplete="email" required />
          {#if app.instance?.emailEnabled}<span class="hint">We'll send a link to confirm the new address.</span>{/if}
        </div>
      {:else}
        <div class="field">
          <label for="np">New password</label>
          <input id="np" class="input" type="password" bind:value={newPassword} minlength={Limits.PASSWORD_MIN} maxlength={Limits.PASSWORD_MAX} autocomplete="new-password" required />
        </div>
        <div class="field">
          <label for="cp">Confirm new password</label>
          <input id="cp" class="input" type="password" bind:value={confirmPw} autocomplete="new-password" required />
        </div>
      {/if}
      <div class="field">
        <label for="pw">{editing === 'password' ? 'Current password' : 'Your password'}</label>
        <input id="pw" class="input" type="password" bind:value={password} autocomplete="current-password" required />
      </div>
      {#if error}<p class="error-text">{error}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (editing = null)}>Cancel</button>
      <button class="btn primary" type="submit" form="acc" disabled={busy}>Save</button>
    {/snippet}
  </Modal>
{/if}

<style>
  .hero {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 12px 0;
  }
  .dn {
    font-size: 1.2rem;
  }
  .rows {
    padding: 0 16px;
  }
  .rows .srow:last-child {
    border-bottom: none;
  }
  .pill.warn {
    background: color-mix(in srgb, var(--warning) 25%, transparent);
  }
</style>
