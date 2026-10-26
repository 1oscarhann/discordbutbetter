<script lang="ts">
  import { app } from '$lib/state/app.svelte';
  import { ui } from '$lib/state/ui.svelte';
  import { voice } from '$lib/state/voice.svelte';
  import { post } from '$lib/api';
  import SettingsShell from './SettingsShell.svelte';
  import AccountTab from './user/AccountTab.svelte';
  import ProfileTab from './user/ProfileTab.svelte';
  import ServerProfileTab from './user/ServerProfileTab.svelte';
  import PrivacyTab from './user/PrivacyTab.svelte';
  import NotificationsTab from './user/NotificationsTab.svelte';
  import AppearanceTab from './user/AppearanceTab.svelte';
  import ChatTab from './user/ChatTab.svelte';
  import VoiceTab from './user/VoiceTab.svelte';
  import SessionsTab from './user/SessionsTab.svelte';
  import DataTab from './user/DataTab.svelte';
  import AdminTab from './user/AdminTab.svelte';

  let { initialTab }: { initialTab: string } = $props();

  // "server-profile:<guildId>" opens the server profiles tab on that server
  const startGuild = initialTab.startsWith('server-profile:') ? initialTab.slice('server-profile:'.length) : null;
  let tab = $state(startGuild ? 'server-profiles' : initialTab);

  const sections = $derived([
    {
      title: 'User settings',
      items: [
        { id: 'account', label: 'My account' },
        { id: 'profile', label: 'Profile' },
        { id: 'server-profiles', label: 'Server profiles' },
        { id: 'privacy', label: 'Privacy & safety' },
        { id: 'sessions', label: 'Devices' },
        { id: 'data', label: 'Data & deletion' },
      ],
    },
    {
      title: 'App settings',
      items: [
        { id: 'appearance', label: 'Appearance' },
        { id: 'chat', label: 'Chat & accessibility' },
        { id: 'notifications', label: 'Notifications' },
        { id: 'voice', label: 'Voice & video' },
      ],
    },
    ...(app.me?.isAdmin ? [{ title: 'Instance', items: [{ id: 'admin', label: 'Instance admin' }] }] : []),
    { title: '', items: [{ id: 'logout', label: 'Log out', danger: true }] },
  ]);

  $effect(() => {
    if (tab === 'logout') {
      tab = 'account';
      ui.confirm('Log out?', 'You can log back in any time.', 'Log out', async () => {
        await voice.leave().catch(() => {});
        await post('/auth/logout').catch(() => {});
        app.loggedOut();
      });
    }
  });
</script>

<SettingsShell {sections} bind:tab onclose={() => (ui.settings = null)}>
  {#key tab}
    {#if tab === 'account'}
      <AccountTab />
    {:else if tab === 'profile'}
      <ProfileTab />
    {:else if tab === 'server-profiles'}
      <ServerProfileTab initialGuild={startGuild} />
    {:else if tab === 'privacy'}
      <PrivacyTab />
    {:else if tab === 'sessions'}
      <SessionsTab />
    {:else if tab === 'data'}
      <DataTab />
    {:else if tab === 'appearance'}
      <AppearanceTab />
    {:else if tab === 'chat'}
      <ChatTab />
    {:else if tab === 'notifications'}
      <NotificationsTab />
    {:else if tab === 'voice'}
      <VoiceTab />
    {:else if tab === 'admin' && app.me?.isAdmin}
      <AdminTab />
    {/if}
  {/key}
</SettingsShell>
