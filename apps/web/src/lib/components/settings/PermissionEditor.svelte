<script lang="ts">
  import { PERMISSION_INFO, Permissions as P, type PermissionName } from '@haunt/shared';

  /**
   * role mode: a toggle per permission (allow bits).
   * overwrite mode: ✕ / ／ / ✓ per channel permission (deny / inherit / allow).
   */
  let {
    mode,
    allow,
    deny = 0n,
    editable = () => true,
    onchange,
  }: {
    mode: 'role' | 'overwrite';
    allow: bigint;
    deny?: bigint;
    editable?: (bit: bigint) => boolean;
    onchange: (allow: bigint, deny: bigint) => void;
  } = $props();

  const GROUPS: { title: string; perms: PermissionName[] }[] = [
    { title: 'General', perms: ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EMOJIS', 'VIEW_AUDIT_LOG', 'MANAGE_GUILD', 'CREATE_INVITE', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES', 'MANAGE_WIKI'] },
    { title: 'Moderation', perms: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS'] },
    {
      title: 'Text',
      perms: [
        'SEND_MESSAGES',
        'SEND_MESSAGES_IN_THREADS',
        'CREATE_THREADS',
        'EMBED_LINKS',
        'ATTACH_FILES',
        'ADD_REACTIONS',
        'USE_EXTERNAL_EMOJIS',
        'USE_EXTERNAL_STICKERS',
        'MENTION_EVERYONE',
        'MANAGE_MESSAGES',
        'MANAGE_THREADS',
        'READ_MESSAGE_HISTORY',
      ],
    },
    { title: 'Voice & activities', perms: ['CONNECT', 'SPEAK', 'STREAM', 'USE_ACTIVITIES', 'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS'] },
    { title: 'Advanced', perms: ['ADMINISTRATOR'] },
  ];

  let filter = $state('');

  function set(bit: bigint, v: 'allow' | 'neutral' | 'deny') {
    let a = allow & ~bit;
    let d = deny & ~bit;
    if (v === 'allow') a |= bit;
    if (v === 'deny') d |= bit;
    onchange(a, d);
  }
</script>

<input class="input" placeholder="Search permissions" bind:value={filter} style="margin-bottom:10px" />
{#each GROUPS as g (g.title)}
  {@const list = g.perms.filter((n) => (mode === 'role' || PERMISSION_INFO[n].channel) && (!filter || PERMISSION_INFO[n].label.toLowerCase().includes(filter.toLowerCase())))}
  {#if list.length}
    <h4>{g.title}</h4>
    {#each list as n (n)}
      {@const bit = P[n]}
      {@const can = editable(bit)}
      <div class="perm" class:disabled={!can}>
        <div class="txt">
          <div class="pl">{PERMISSION_INFO[n].label}</div>
          <div class="pd faint">{PERMISSION_INFO[n].description}</div>
        </div>
        {#if mode === 'role'}
          <input type="checkbox" class="switch" checked={(allow & bit) !== 0n} disabled={!can} onchange={(e) => set(bit, (e.target as HTMLInputElement).checked ? 'allow' : 'neutral')} />
        {:else}
          <div class="tri" role="radiogroup" aria-label={PERMISSION_INFO[n].label}>
            <button class="deny" class:on={(deny & bit) !== 0n} disabled={!can} title="Deny" onclick={() => set(bit, 'deny')}>✕</button>
            <button class="neutral" class:on={((allow | deny) & bit) === 0n} disabled={!can} title="Inherit" onclick={() => set(bit, 'neutral')}>／</button>
            <button class="allow" class:on={(allow & bit) !== 0n} disabled={!can} title="Allow" onclick={() => set(bit, 'allow')}>✓</button>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
{/each}

<style>
  h4 {
    margin: 16px 0 6px;
    font-size: 0.75rem;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .perm {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 0;
    border-bottom: 1px solid var(--border);
  }
  .perm.disabled {
    opacity: 0.5;
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .pl {
    font-weight: 600;
  }
  .pd {
    font-size: 0.8rem;
  }
  .tri {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
    flex: none;
  }
  .tri button {
    width: 32px;
    height: 28px;
    border: none;
    background: var(--bg-0);
    cursor: pointer;
    font-weight: 800;
    color: var(--text-faint);
  }
  .tri .deny.on {
    background: var(--danger);
    color: #fff;
  }
  .tri .neutral.on {
    background: var(--bg-3);
    color: var(--text);
  }
  .tri .allow.on {
    background: var(--success);
    color: #fff;
  }
</style>
