<script lang="ts">
  import type { ProfileSong } from '@dbb/shared';
  import { app } from '$lib/state/app.svelte';
  import Icon from '../Icon.svelte';

  /**
   * Profile song. Off by default for visitors (settings → "Autoplay profile songs"); always has a mute button.
   * Uploaded clips play from our server; YouTube songs use a hidden youtube-nocookie player that only loads
   * once playback starts.
   */
  let { song }: { song: ProfileSong } = $props();
  let playing = $state(app.settings.autoplayProfileSongs);
  let audio = $state<HTMLAudioElement | null>(null);

  $effect(() => {
    if (!audio) return;
    audio.volume = app.settings.profileSongVolume;
    if (playing) void audio.play().catch(() => (playing = false));
    else audio.pause();
  });
</script>

<div class="song">
  <button class="pbtn" onclick={() => (playing = !playing)} aria-label={playing ? 'Mute profile song' : 'Play profile song'}>
    <Icon name={playing ? 'speaker' : 'speaker-off'} size={16} />
  </button>
  <span class="truncate"><Icon name="music" size={12} /> {song.title}</span>
  {#if song.kind === 'upload'}
    <audio bind:this={audio} src={song.url} loop preload="none"></audio>
  {:else if playing}
    <iframe
      class="hidden"
      title="Profile song"
      src="https://www.youtube-nocookie.com/embed/{song.videoId}?autoplay=1&start={song.start ?? 0}&loop=1&playlist={song.videoId}&controls=0"
      allow="autoplay"
      referrerpolicy="strict-origin"
    ></iframe>
  {/if}
</div>

<style>
  .song {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    padding: 4px 8px 4px 4px;
    background: rgb(0 0 0 / 0.25);
    border-radius: 99px;
    max-width: 100%;
    color: #fff;
  }
  .pbtn {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: none;
    background: rgb(255 255 255 / 0.2);
    color: #fff;
    display: grid;
    place-items: center;
    cursor: pointer;
    flex: none;
  }
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    pointer-events: none;
    border: none;
  }
</style>
