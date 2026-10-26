<script lang="ts">
  import { ui } from '$lib/state/ui.svelte';
  import { errorMessage } from '$lib/api';
  import { app } from '$lib/state/app.svelte';
  import Modal from '../Modal.svelte';
  import ProfileCard from '../profile/ProfileCard.svelte';
  import Popover from '../Popover.svelte';
  import Icon from '../Icon.svelte';
  import CreateGuildModal from '../modals/CreateGuildModal.svelte';
  import JoinGuildModal from '../modals/JoinGuildModal.svelte';
  import InviteModal from '../modals/InviteModal.svelte';
  import CreateChannelModal from '../modals/CreateChannelModal.svelte';
  import NewDmModal from '../modals/NewDmModal.svelte';
  import CustomStatusModal from '../modals/CustomStatusModal.svelte';
  import ActivityPicker from '../modals/ActivityPicker.svelte';
  import EditHistoryModal from '../modals/EditHistoryModal.svelte';
  import ScheduleModal from '../modals/ScheduleModal.svelte';
  import ChannelSettings from '../settings/ChannelSettings.svelte';
  import GuildSettings from '../settings/GuildSettings.svelte';
  import UserSettings from '../settings/UserSettings.svelte';
  import QuickSwitcher from '../modals/QuickSwitcher.svelte';

  let confirmBusy = $state(false);
  let confirmError = $state('');

  async function doConfirm() {
    const c = ui.reportConfirm;
    if (!c) return;
    confirmBusy = true;
    confirmError = '';
    try {
      await c.onconfirm();
      ui.reportConfirm = null;
    } catch (e) {
      confirmError = errorMessage(e);
    } finally {
      confirmBusy = false;
    }
  }

  function host(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }
</script>

{#if ui.profile}
  {#if ui.profile.x !== undefined && ui.profile.y !== undefined && window.innerWidth > 760}
    <Popover x={ui.profile.x} y={ui.profile.y} onclose={() => (ui.profile = null)}>
      <ProfileCard userId={ui.profile.userId} guildId={ui.profile.guildId} />
    </Popover>
  {:else}
    <Modal bare width={420} onclose={() => (ui.profile = null)}>
      <ProfileCard userId={ui.profile.userId} guildId={ui.profile.guildId} />
    </Modal>
  {/if}
{/if}

{#if ui.lightbox}
  <div class="lightbox" role="presentation" onclick={() => (ui.lightbox = null)} onkeydown={(e) => e.key === 'Escape' && (ui.lightbox = null)}>
    <img src={ui.lightbox.src} alt={ui.lightbox.alt} />
    <div class="lbar">
      <a href={ui.lightbox.src} target="_blank" rel="noopener noreferrer" onclick={(e) => e.stopPropagation()}>Open original</a>
      {#if ui.lightbox.download}<a href={ui.lightbox.download} download onclick={(e) => e.stopPropagation()}>Download</a>{/if}
    </div>
  </div>
{/if}

{#if ui.confirmLink}
  {@const url = ui.confirmLink}
  <Modal title="Leaving to another site" onclose={() => (ui.confirmLink = null)}>
    <p>This link goes to <strong>{host(url)}</strong>:</p>
    <p class="url">{url}</p>
    <p class="faint small">The link text was different from where it actually goes. Make sure you trust it.</p>
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (ui.confirmLink = null)}>Go back</button>
      <a class="btn primary" href={url} target="_blank" rel="noopener noreferrer nofollow" onclick={() => (ui.confirmLink = null)}>Visit site</a>
    {/snippet}
  </Modal>
{/if}

{#if ui.reportConfirm}
  {@const c = ui.reportConfirm}
  <Modal title={c.title} onclose={() => (ui.reportConfirm = null)} width={440}>
    <p class="muted">{c.body}</p>
    {#if confirmError}<p class="error-text">{confirmError}</p>{/if}
    {#snippet footer()}
      <button class="btn ghost" onclick={() => (ui.reportConfirm = null)}>Cancel</button>
      <button class="btn {c.danger ? 'danger' : 'primary'}" disabled={confirmBusy} onclick={doConfirm}>{c.confirm}</button>
    {/snippet}
  </Modal>
{/if}

{#if ui.createGuild}<CreateGuildModal />{/if}
{#if ui.joinGuild}<JoinGuildModal />{/if}
{#if ui.invite}<InviteModal channelId={ui.invite} />{/if}
{#if ui.createChannel}<CreateChannelModal {...ui.createChannel} />{/if}
{#if ui.newDm}<NewDmModal />{/if}
{#if ui.customStatus}<CustomStatusModal />{/if}
{#if ui.activityPicker}<ActivityPicker kind={ui.activityPicker} />{/if}
{#if ui.editHistory}<EditHistoryModal {...ui.editHistory} />{/if}
{#if ui.scheduleFor}<ScheduleModal {...ui.scheduleFor} />{/if}
{#if ui.channelSettings}<ChannelSettings target={ui.channelSettings} />{/if}
{#if ui.guildSettings}<GuildSettings guildId={ui.guildSettings.guildId} initialTab={ui.guildSettings.tab} />{/if}
{#if ui.settings}<UserSettings initialTab={ui.settings} />{/if}
{#if ui.quickSwitcher}<QuickSwitcher />{/if}

<!-- global shortcuts -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && ui.lightbox) ui.lightbox = null;
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'k' && app.me) {
      e.preventDefault();
      ui.quickSwitcher = !ui.quickSwitcher;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      ui.settings = 'account';
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm' && app.me) {
      e.preventDefault();
      void import('$lib/state/voice.svelte').then(({ voice }) => voice.toggleMute());
    }
  }}
/>

<style>
  .lightbox {
    position: fixed;
    inset: 0;
    z-index: 150;
    background: rgb(0 0 0 / 0.85);
    display: grid;
    place-items: center;
    padding: 24px;
    cursor: zoom-out;
  }
  .lightbox img {
    max-width: 100%;
    max-height: calc(100vh - 80px);
    object-fit: contain;
    border-radius: 6px;
  }
  .lbar {
    position: absolute;
    bottom: 16px;
    display: flex;
    gap: 16px;
  }
  .lbar a {
    color: #fff;
    font-weight: 600;
  }
  .url {
    word-break: break-all;
    background: var(--bg-0);
    padding: 8px 10px;
    border-radius: 6px;
    font-family: var(--mono);
    font-size: 0.85rem;
  }
  .small {
    font-size: 0.82rem;
  }
</style>
