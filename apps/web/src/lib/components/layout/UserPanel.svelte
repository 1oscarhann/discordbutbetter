<script lang="ts">
  import { goto } from '$app/navigation';
  import { Status, type StatusValue } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { voice } from '$lib/state/voice.svelte';
  import { del, errorMessage, put } from '$lib/api';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';
  import Popover from '../Popover.svelte';
  import StatusDot from '../StatusDot.svelte';

  let anchor = $state<HTMLElement | null>(null);
  let open = $state(false);
  let screenMenu = $state<HTMLElement | null>(null);

  const me = $derived(app.me!);
  const myStatus = $derived(app.presence(me.id).status);
  const vc = $derived(voice.channelId ? app.channel(voice.channelId) : null);
  const vg = $derived(voice.guildId ? app.guilds.get(voice.guildId) : null);

  const LABEL: Record<StatusValue, string> = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible' };
  const DESC: Record<StatusValue, string> = {
    online: '',
    idle: '',
    dnd: "You won't get notifications",
    invisible: "You'll look offline, but can still use everything",
  };

  async function setStatus(s: StatusValue) {
    open = false;
    try {
      await put('/users/@me/status', { status: s });
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  async function clearStatus() {
    await del('/users/@me/custom-status').catch(() => {});
  }
</script>

{#if voice.state !== 'idle'}
  <div class="voicebar">
    <div class="vinfo">
      <div class="vstate" class:ok={voice.state === 'connected'}>
        <Icon name="zap" size={14} />
        {voice.state === 'connected' ? 'Voice connected' : voice.state === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </div>
      <button class="vchan truncate" onclick={() => vc && goto(`/app/${vc.guildId}/${vc.id}`)}>{vc?.name ?? ''} / {vg?.guild.name ?? ''}</button>
    </div>
    <button class="icon-btn" class:active={voice.camera} title="Camera" onclick={() => voice.toggleCamera()}><Icon name={voice.camera ? 'video' : 'video-off'} size={18} /></button>
    <button class="icon-btn" class:active={voice.screen} title="Share screen" onclick={(e) => (voice.screen ? voice.toggleScreen() : (screenMenu = e.currentTarget))}><Icon name="screen" size={18} /></button>
    <button class="icon-btn danger" title="Disconnect" onclick={() => voice.leave()}><Icon name="phone-off" size={18} /></button>
  </div>
{/if}

<div class="panel">
  <button class="me" bind:this={anchor} onclick={() => (open = !open)}>
    <Avatar src={me.avatar} name={me.displayName || me.username} size={34} status={myStatus === 'offline' && me.status === 'invisible' ? 'offline' : myStatus} />
    <span class="names">
      <span class="dn truncate">{me.displayName || me.username}</span>
      <span class="un truncate">
        {#if app.presence(me.id).customStatus}{app.presence(me.id).customStatus?.emoji ?? ''} {app.presence(me.id).customStatus?.text}{:else}@{me.username}{/if}
      </span>
    </span>
  </button>
  <button class="icon-btn" class:danger={voice.selfMute} title={voice.selfMute ? 'Unmute' : 'Mute'} onclick={() => voice.toggleMute()}>
    <Icon name={voice.selfMute ? 'mic-off' : 'mic'} size={18} />
  </button>
  <button class="icon-btn" class:danger={voice.selfDeaf} title={voice.selfDeaf ? 'Undeafen' : 'Deafen'} onclick={() => voice.toggleDeaf()}>
    <Icon name={voice.selfDeaf ? 'headphones-off' : 'headphones'} size={18} />
  </button>
  <button class="icon-btn" title="Settings" onclick={() => (ui.settings = 'account')}><Icon name="settings" size={18} /></button>
</div>

{#if open}
  <Popover {anchor} placement="top-start" onclose={() => (open = false)}>
    <div class="menu" style="width:260px">
      {#each Status as s (s)}
        <button class="menu-item status" onclick={() => setStatus(s)}>
          <StatusDot status={s === 'invisible' ? 'invisible' : s} size={11} />
          <span class="col" style="gap:0">
            <span>{LABEL[s]} {#if me.status === s}<Icon name="check" size={13} />{/if}</span>
            {#if DESC[s]}<span class="desc">{DESC[s]}</span>{/if}
          </span>
        </button>
      {/each}
      <div class="menu-sep"></div>
      <button class="menu-item" onclick={() => ((ui.customStatus = true), (open = false))}><Icon name="smile" size={16} /> {app.presence(me.id).customStatus ? 'Edit' : 'Set'} custom status</button>
      {#if app.presence(me.id).customStatus}
        <button class="menu-item" onclick={() => ((open = false), clearStatus())}><Icon name="x" size={16} /> Clear custom status</button>
      {/if}
      <button class="menu-item" onclick={() => ((ui.activityPicker = 'playing'), (open = false))}>
        <Icon name="gamepad" size={16} /> {me.playing ? `Playing ${me.playing.name}` : 'Set what you’re playing'}
      </button>
      <button class="menu-item" onclick={() => ((ui.activityPicker = 'listening'), (open = false))}>
        <Icon name="music" size={16} /> {me.listening ? `Listening to ${me.listening.title}` : 'Set what you’re listening to'}
      </button>
      <div class="menu-sep"></div>
      <button class="menu-item" onclick={() => ((ui.profile = { userId: me.id, guildId: null }), (open = false))}><Icon name="eye" size={16} /> View my profile</button>
      <button class="menu-item" onclick={() => ((ui.settings = 'profile'), (open = false))}><Icon name="edit" size={16} /> Edit profile</button>
      <button class="menu-item" onclick={() => (navigator.clipboard.writeText(me.username), (open = false), app.toast('Username copied'))}><Icon name="copy" size={16} /> Copy username</button>
    </div>
  </Popover>
{/if}

{#if screenMenu}
  <Popover anchor={screenMenu} placement="top-start" onclose={() => (screenMenu = null)}>
    <div class="menu">
      <div class="faint" style="padding:4px 9px;font-size:.78rem">Screen share quality (all free)</div>
      {#each [['720', 30], ['1080', 30], ['1080', 60], ['1440', 30], ['1440', 60]] as const as [q, fps] (`${q}${fps}`)}
        <button class="menu-item" onclick={() => ((screenMenu = null), voice.toggleScreen(q, fps))}>{q}p · {fps} fps</button>
      {/each}
    </div>
  </Popover>
{/if}

<style>
  .panel {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 8px;
    background: color-mix(in srgb, var(--bg-0) 60%, var(--bg-1));
  }
  .me {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 3px 4px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .me:hover {
    background: var(--hover);
  }
  .names {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.2;
  }
  .dn {
    font-weight: 700;
    font-size: 0.88rem;
  }
  .un {
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .status {
    align-items: flex-start;
  }
  .status :global(.dot) {
    margin-top: 4px;
  }
  .desc {
    font-size: 0.75rem;
    opacity: 0.75;
  }
  .voicebar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 8px;
    border-top: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-0) 60%, var(--bg-1));
  }
  .vinfo {
    flex: 1;
    min-width: 0;
  }
  .vstate {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 0.82rem;
    font-weight: 700;
    color: var(--warning);
  }
  .vstate.ok {
    color: var(--success);
  }
  .vchan {
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    color: var(--text-muted);
    font-size: 0.75rem;
    cursor: pointer;
    text-align: left;
  }
  .vchan:hover {
    text-decoration: underline;
  }
</style>
