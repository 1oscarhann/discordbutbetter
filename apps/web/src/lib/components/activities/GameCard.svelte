<script lang="ts">
  import { C4_COLS, GAMES, type Channel, type GameSession } from '@haunt/shared';
  import { app } from '$lib/state/app.svelte';
  import { errorMessage, get, post } from '$lib/api';
  import Avatar from '../Avatar.svelte';
  import Icon from '../Icon.svelte';

  let { gameId, channel }: { gameId: string; channel: Channel } = $props();
  const game = $derived(app.games.get(gameId) ?? null);
  let gone = $state(false);
  let guess = $state('');
  let now = $state(Date.now());

  $effect(() => {
    if (!app.games.has(gameId) && !gone) {
      void get<GameSession>(`/games/${gameId}`)
        .then((g) => app.games.set(g.id, g))
        .catch(() => (gone = true));
    }
  });

  $effect(() => {
    if (game?.kind !== 'anagram' || game.status !== 'playing') return;
    const t = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(t);
  });

  const me = $derived(app.me?.id ?? '');
  const inGame = $derived(!!game?.players.some((p) => p.id === me));
  const v = $derived((game?.view ?? {}) as Record<string, any>);
  const def = $derived(game ? GAMES[game.kind] : null);

  async function act(path: string, body?: unknown) {
    try {
      const g = await post<GameSession>(`/games/${gameId}/${path}`, body);
      if (g && 'id' in g) app.games.set(g.id, g);
    } catch (e) {
      app.toast(errorMessage(e), 'error');
    }
  }

  const move = (m: unknown) => act('move', { move: m });

  const myTurn = $derived.by(() => {
    if (!game || game.status !== 'playing') return false;
    if (game.kind === 'tictactoe' || game.kind === 'connect4') return game.players[v.turn as number]?.id === me;
    return inGame && game.hostId !== me;
  });

  const resultText = $derived.by(() => {
    if (!game || game.status !== 'finished') return '';
    const w = (v.winners as string[]) ?? [];
    if (v.draw && !w.length) return "It's a draw!";
    if (!w.length) return 'Game over.';
    const names = w.map((id) => app.displayName(id, channel.guildId));
    return w.includes(me) ? (w.length > 1 ? 'You won (together)! 🎉' : 'You won! 🎉') : `${names.join(', ')} won!`;
  });

  // anagram: when the round timer hits zero, any client can nudge the server to move on
  $effect(() => {
    if (game?.kind === 'anagram' && game.status === 'playing' && v.roundEndsAt && now > v.roundEndsAt + 800 && inGame) {
      void post(`/games/${gameId}/move`, { move: { type: 'tick' } })
        .then((g) => app.games.set((g as GameSession).id, g as GameSession))
        .catch(() => {});
    }
  });

  function submitGuess(e: Event) {
    e.preventDefault();
    if (!guess.trim()) return;
    if (game?.kind === 'hangman') void move({ guess: guess.trim() });
    else void move({ type: 'guess', guess: guess.trim() });
    guess = '';
  }

  const C4_COLORS = ['', '#f0506e', '#f5b84a'];
</script>

{#if gone && !game}
  <div class="card game faint small">This game has ended.</div>
{:else if game && def}
  <div class="card game" class:turn={myTurn}>
    <div class="head">
      <Icon name="gamepad" size={16} />
      <strong>{def.name}</strong>
      <span class="faint small">
        {game.status === 'lobby' ? 'Waiting for players' : game.status === 'playing' ? (myTurn ? 'Your turn!' : 'In progress') : 'Finished'}
      </span>
      <span class="spacer"></span>
      <div class="players">
        {#each game.players as p (p.id)}
          <span title={app.displayName(p.id, channel.guildId)}><Avatar src={app.avatarOf(p.id, channel.guildId)} name={app.displayName(p.id, channel.guildId)} size={22} /></span>
        {/each}
      </div>
    </div>

    {#if game.kind === 'tictactoe'}
      <div class="ttt">
        {#each v.board as cell, i (i)}
          <button class="cell" class:win={(v.line ?? []).includes(i)} disabled={!myTurn || cell !== 0} onclick={() => move({ cell: i })}>
            {cell === 1 ? '✕' : cell === 2 ? '◯' : ''}
          </button>
        {/each}
      </div>
      <div class="faint small legend">✕ {game.players[0] ? app.displayName(game.players[0].id, channel.guildId) : '?'} · ◯ {game.players[1] ? app.displayName(game.players[1].id, channel.guildId) : 'waiting…'}</div>
    {:else if game.kind === 'connect4'}
      <div class="c4" style="grid-template-columns:repeat({C4_COLS},1fr)">
        {#each v.board as cell, i (i)}
          <button
            class="hole"
            class:win={(v.line ?? []).includes(i)}
            class:last={v.last === i}
            disabled={!myTurn}
            onclick={() => move({ col: i % C4_COLS })}
            aria-label="Column {(i % C4_COLS) + 1}"
          >
            <span style:background={cell ? C4_COLORS[cell] : 'var(--bg-0)'}></span>
          </button>
        {/each}
      </div>
      <div class="faint small legend">
        <span style="color:{C4_COLORS[1]}">●</span> {game.players[0] ? app.displayName(game.players[0].id, channel.guildId) : '?'} ·
        <span style="color:{C4_COLORS[2]}">●</span> {game.players[1] ? app.displayName(game.players[1].id, channel.guildId) : 'waiting…'}
      </div>
    {:else if game.kind === 'hangman'}
      <div class="hang">
        <div class="gallows" aria-label="{v.wrong} of {v.maxWrong} wrong">
          {#each Array(v.maxWrong) as _, i (i)}<span class="life" class:lost={i < v.wrong}></span>{/each}
        </div>
        <div class="word">{v.masked}</div>
        {#if v.word && game.hostId === me && game.status === 'playing'}<div class="faint small">Your word: {v.word}</div>{/if}
        <div class="letters">
          {#each 'abcdefghijklmnopqrstuvwxyz' as l (l)}
            <button class="letter" class:used={v.guessed.includes(l)} disabled={!myTurn || v.guessed.includes(l)} onclick={() => move({ guess: l })}>{l}</button>
          {/each}
        </div>
        {#if v.lastGuess}<div class="faint small">{app.displayName(v.lastGuess.userId, channel.guildId)} guessed “{v.lastGuess.guess}” — {v.lastGuess.hit ? 'yes!' : 'nope'}</div>{/if}
        {#if myTurn}
          <form class="row" onsubmit={submitGuess}><input class="input" placeholder="Guess the whole word" bind:value={guess} /><button class="btn small">Guess</button></form>
        {/if}
      </div>
    {:else if game.kind === 'anagram'}
      <div class="ana">
        {#if game.status === 'lobby'}
          <p class="muted small">{v.rounds} rounds. {game.hostId === me ? 'Start when everyone has joined.' : 'Waiting for the host to start.'}</p>
          {#if game.hostId === me}<button class="btn primary small" onclick={() => move({ type: 'start' })}>Start</button>{/if}
        {:else if game.status === 'playing'}
          <div class="faint small">Round {v.round + 1} / {v.rounds} · {Math.max(0, Math.ceil((v.roundEndsAt - now) / 1000))}s</div>
          <div class="scrambled">{String(v.scrambled).toUpperCase().split('').join(' ')}</div>
          {#if inGame}
            <form class="row" onsubmit={submitGuess}><input class="input" placeholder="Unscramble it" bind:value={guess} autocomplete="off" /><button class="btn small primary">Go</button></form>
          {/if}
        {/if}
        <div class="scores">
          {#each Object.entries(v.scores ?? {}).sort((a, b) => (b[1] as number) - (a[1] as number)) as [uid, sc] (uid)}
            <span class="pill">{app.displayName(uid, channel.guildId)}: {sc}</span>
          {/each}
        </div>
        {#if v.history?.length}<div class="faint small">Last word: <strong>{v.history[v.history.length - 1].word}</strong></div>{/if}
      </div>
    {/if}

    {#if resultText}<div class="result">{resultText}</div>{/if}

    <div class="row actions">
      {#if !inGame && game.status !== 'finished' && (game.status === 'lobby' || game.kind === 'hangman' || game.kind === 'anagram')}
        <button class="btn primary small" onclick={() => act('join')}>Join</button>
      {/if}
      {#if inGame && game.status !== 'finished'}
        <button class="btn small ghost" onclick={() => act('leave')}>{game.hostId === me && game.status === 'lobby' ? 'Cancel game' : 'Leave'}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .game {
    padding: 12px;
    max-width: 380px;
    margin-top: 6px;
  }
  .game.turn {
    border-color: var(--accent);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  .players {
    display: flex;
  }
  .small {
    font-size: 0.78rem;
  }
  .ttt {
    display: grid;
    grid-template-columns: repeat(3, 64px);
    gap: 4px;
  }
  .cell {
    width: 64px;
    height: 64px;
    font-size: 2rem;
    font-weight: 800;
    background: var(--bg-3);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  .cell:disabled {
    cursor: default;
  }
  .cell.win {
    background: var(--success);
    color: #fff;
  }
  .c4 {
    display: grid;
    gap: 4px;
    background: #2853c9;
    padding: 6px;
    border-radius: 10px;
    width: fit-content;
  }
  .hole {
    width: 36px;
    height: 36px;
    padding: 3px;
    background: none;
    border: none;
    cursor: pointer;
  }
  .hole:disabled {
    cursor: default;
  }
  .hole span {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: 50%;
  }
  .hole.win span {
    box-shadow: 0 0 0 3px #fff;
  }
  .hole.last span {
    outline: 2px dashed rgb(255 255 255 / 0.6);
  }
  .legend {
    margin-top: 6px;
  }
  .hang {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .gallows {
    display: flex;
    gap: 4px;
  }
  .life {
    width: 18px;
    height: 6px;
    border-radius: 3px;
    background: var(--success);
  }
  .life.lost {
    background: var(--danger);
  }
  .word {
    font-family: var(--mono);
    font-size: 1.6rem;
    letter-spacing: 0.3em;
    white-space: pre;
  }
  .letters {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .letter {
    width: 26px;
    height: 28px;
    border: none;
    border-radius: 5px;
    background: var(--bg-3);
    cursor: pointer;
    font-weight: 700;
    text-transform: uppercase;
  }
  .letter.used {
    opacity: 0.3;
  }
  .ana {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .scrambled {
    font-family: var(--mono);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: 0.1em;
  }
  .scores {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .result {
    margin-top: 10px;
    font-weight: 800;
    color: var(--success);
  }
  .actions {
    margin-top: 10px;
  }
</style>
