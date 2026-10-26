<script lang="ts">
  import type { FilePurposeValue } from '@dbb/shared';
  import { errorMessage, upload, type UploadedFile } from '$lib/api';
  import Icon from './Icon.svelte';

  /** Upload button with preview. Emits the uploaded file (or null when removed). */
  let {
    purpose,
    current = null,
    label = 'Upload',
    accept = 'image/png,image/jpeg,image/webp,image/gif,image/avif',
    round = false,
    width = 96,
    height = 96,
    onchange,
  }: {
    purpose: FilePurposeValue;
    current?: string | null;
    label?: string;
    accept?: string;
    round?: boolean;
    width?: number;
    height?: number;
    onchange: (f: UploadedFile | null) => void;
  } = $props();

  let input: HTMLInputElement;
  let progress = $state<number | null>(null);
  let error = $state('');
  let preview = $state<string | null>(null);
  let previewIsVideo = $state(false);

  const shown = $derived(preview ?? current);
  const isVideo = $derived(preview ? previewIsVideo : !!current && /\.(mp4|webm)(\?|$)/i.test(current));

  async function pick(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = '';
    if (!f) return;
    error = '';
    progress = 0;
    try {
      const up = upload(purpose, f, (p) => (progress = p));
      const res = await up.promise;
      preview = res.url;
      previewIsVideo = res.contentType.startsWith('video/');
      onchange(res);
    } catch (err) {
      error = errorMessage(err);
    } finally {
      progress = null;
    }
  }
</script>

<div class="ip">
  <button type="button" class="box" class:round style="width:{width}px;height:{height}px" onclick={() => input.click()} title={label}>
    {#if shown}
      {#if isVideo}
        <video src={shown} autoplay muted loop playsinline></video>
      {:else}
        <img src={shown} alt="" />
      {/if}
    {:else}
      <Icon name="image" size={24} />
    {/if}
    {#if progress !== null}<span class="prog">{Math.round(progress * 100)}%</span>{/if}
  </button>
  <div class="col" style="gap:4px">
    <button type="button" class="btn small" onclick={() => input.click()}><Icon name="upload" size={14} /> {label}</button>
    {#if shown}<button type="button" class="btn small ghost" onclick={() => ((preview = null), onchange(null))}>Remove</button>{/if}
    {#if error}<span class="error-text small">{error}</span>{/if}
  </div>
  <input type="file" hidden {accept} bind:this={input} onchange={pick} />
</div>

<style>
  .ip {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .box {
    position: relative;
    display: grid;
    place-items: center;
    border: 2px dashed var(--border);
    border-radius: 12px;
    background: var(--bg-0);
    overflow: hidden;
    cursor: pointer;
    padding: 0;
    color: var(--text-faint);
    flex: none;
  }
  .box.round {
    border-radius: 50%;
  }
  .box img,
  .box video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .prog {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.6);
    color: #fff;
    font-weight: 700;
  }
  .small {
    font-size: 0.8rem;
  }
</style>
