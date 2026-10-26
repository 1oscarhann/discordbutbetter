export type RightPanel = 'members' | 'pins' | 'search' | 'saved' | 'threads' | 'scheduled' | null;

class UiState {
  /** Profile card: anchored popout (with x/y) or a centered modal. */
  profile = $state<{ userId: string; guildId: string | null; x?: number; y?: number } | null>(null);
  lightbox = $state<{ src: string; alt: string; download?: string } | null>(null);
  confirmLink = $state<string | null>(null);
  settings = $state<string | null>(null);
  guildSettings = $state<{ guildId: string; tab: string } | null>(null);
  channelSettings = $state<string | null>(null);
  createGuild = $state(false);
  joinGuild = $state(false);
  invite = $state<string | null>(null);
  createChannel = $state<{ guildId: string; parentId: string | null; type: number } | null>(null);
  newDm = $state(false);
  customStatus = $state(false);
  activityPicker = $state<'playing' | 'listening' | null>(null);
  editHistory = $state<{ channelId: string; messageId: string } | null>(null);
  scheduleFor = $state<{ channelId: string; content: string; replyTo?: { messageId: string; ping: boolean }; silent: boolean } | null>(null);
  rightPanel = $state<RightPanel>('members');
  thread = $state<string | null>(null);
  searchQuery = $state('');
  mobileNav = $state(false);
  /** Message to scroll to and flash once the channel loads. */
  jumpTo = $state<{ channelId: string; messageId: string } | null>(null);
  reportConfirm = $state<{ title: string; body: string; danger?: boolean; confirm: string; onconfirm: () => void | Promise<void> } | null>(null);

  confirm(title: string, body: string, confirm: string, onconfirm: () => void | Promise<void>, danger = true) {
    this.reportConfirm = { title, body, confirm, onconfirm, danger };
  }
}

export const ui = new UiState();
