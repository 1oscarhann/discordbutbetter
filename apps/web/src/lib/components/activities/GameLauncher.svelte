<script lang="ts">
  import { GAMES, GameKind, type Channel, type GameKindValue, type GameSession } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, post } from '$lib/api';
  import Popover from '../Popover.svelte';
  import Icon from '../Icon.svelte';

  let { anchor, channel, onclose }: { anchor: HTMLElement; channel: Channel; onclose: () => void } = $props();
  let pick = $state<GameKindValue | null>(null);
  let word = $state('');
  let rounds = $state(5);
  let busy = $state(false);

  async function start(kind: GameKindValue) {
    if (kind === 'hangman' && pick !== 'hangman') return void (pick = 'hangman');
    busy = true;
    try {
      const g = await post<GameSession>(`/channels/${channel.id}/games`, {
        kind,
        options: kind === 'hangman' ? { word } : kind === 'anagram' ? { rounds } : {},
      });
      app.games.set(g.id, g);
      onclose();
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    } finally {
      busy = false;
    }
  }
</script>

<Popover {anchor} placement="bottom-end" {onclose}>
  <div class="menu launcher">
    {#if pick === 'hangman'}
      <div class="col">
        <strong>Hangman</strong>
        <p class="faint small">Pick a secret word or phrase. Only you can see it.</p>
        <input class="input" type="password" placeholder="Secret word" bind:value={word} maxlength="30" autocomplete="off" />
        <div class="row">
          <button class="btn small ghost" onclick={() => (pick = null)}>Back</button>
          <span class="spacer"></span>
          <button class="btn small primary" disabled={busy || word.trim().length < 3} onclick={() => start('hangman')}>Start</button>
        </div>
      </div>
    {:else}
      {#each GameKind as k (k)}
        <button class="menu-item game" disabled={busy} onclick={() => start(k)}>
          <Icon name="gamepad" size={18} />
          <span class="col" style="gap:0">
            <strong>{GAMES[k].name}</strong>
            <span class="desc">{GAMES[k].description}</span>
          </span>
        </button>
        {#if k === 'anagram'}
          <label class="row rounds faint small">Rounds <input type="number" min="1" max="10" bind:value={rounds} class="input" style="width:64px;padding:3px 6px" /></label>
        {/if}
      {/each}
    {/if}
  </div>
</Popover>

<style>
  .launcher {
    width: 300px;
  }
  .game {
    align-items: flex-start;
  }
  .desc {
    font-size: 0.76rem;
    opacity: 0.75;
    white-space: normal;
  }
  .small {
    font-size: 0.8rem;
  }
  .rounds {
    padding: 0 10px 6px 36px;
  }
</style>
