<script lang="ts">
  import { voice } from '$lib/state/voice.svelte';
  import { app } from '$lib/state/app.svelte';

  let inputs = $state<MediaDeviceInfo[]>([]);
  let outputs = $state<MediaDeviceInfo[]>([]);
  let labelled = $state(false);
  let error = $state('');
  let level = $state(0);
  let testing = $state(false);
  let stopTest: (() => void) | null = null;
  const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  async function refresh() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      inputs = all.filter((d) => d.kind === 'audioinput');
      outputs = all.filter((d) => d.kind === 'audiooutput');
      labelled = inputs.some((d) => d.label);
    } catch {
      error = "Your browser won't list audio devices here.";
    }
  }
  void refresh();

  async function allow() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await refresh();
    } catch {
      error = 'Microphone access was blocked. Allow it in your browser site settings.';
    }
  }

  async function test() {
    if (testing) return stop();
    error = '';
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: voice.inputDeviceId ? { exact: voice.inputDeviceId } : undefined, echoCancellation: true, noiseSuppression: true },
      });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let raf = 0;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        level = Math.min(1, peak / 90);
        raf = requestAnimationFrame(tick);
      };
      tick();
      testing = true;
      stopTest = () => {
        cancelAnimationFrame(raf);
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
        level = 0;
        testing = false;
      };
      if (!labelled) void refresh();
    } catch {
      error = "Couldn't open your microphone.";
    }
  }
  function stop() {
    stopTest?.();
    stopTest = null;
  }
  $effect(() => () => stop());
</script>

<h2>Voice & video</h2>
{#if !app.instance?.voiceEnabled}
  <p class="error-text">Voice isn't set up on this server (no LiveKit configured), so these settings won't do much yet.</p>
{/if}
{#if error}<p class="error-text">{error}</p>{/if}
{#if !labelled}
  <p class="muted">Your browser hides device names until you allow microphone access.</p>
  <button class="btn" onclick={allow}>Allow microphone access</button>
{/if}

<div class="row two">
  <div class="field">
    <label for="in">Input device</label>
    <select id="in" class="select" value={voice.inputDeviceId ?? ''} onchange={(e) => voice.setDevices((e.target as HTMLSelectElement).value || null, voice.outputDeviceId)}>
      <option value="">Default</option>
      {#each inputs as d (d.deviceId)}{#if d.deviceId && d.deviceId !== 'default'}<option value={d.deviceId}>{d.label || 'Microphone'}</option>{/if}{/each}
    </select>
  </div>
  <div class="field">
    <label for="out">Output device</label>
    <select id="out" class="select" value={voice.outputDeviceId ?? ''} disabled={!canPickOutput} onchange={(e) => voice.setDevices(voice.inputDeviceId, (e.target as HTMLSelectElement).value || null)}>
      <option value="">Default</option>
      {#each outputs as d (d.deviceId)}{#if d.deviceId && d.deviceId !== 'default'}<option value={d.deviceId}>{d.label || 'Speaker'}</option>{/if}{/each}
    </select>
    {#if !canPickOutput}<span class="hint">Your browser doesn't let sites pick the output device — change it in your OS.</span>{/if}
  </div>
</div>

<h3>Mic test</h3>
<div class="row" style="gap:12px">
  <button class="btn" onclick={test}>{testing ? 'Stop' : "Let's check"}</button>
  <div class="meter"><div style="width:{level * 100}%"></div></div>
</div>
<p class="faint small">Noise suppression, echo cancellation and auto gain are on (your browser's built-in ones).</p>

<h3>Screen share</h3>
<p class="faint small">
  Pick the quality when you start sharing: up to 1440p at 60fps, free. What you actually get depends on your upload speed and the server's bandwidth.
  On the Linux desktop app, screen sharing depends on WebKitGTK and can be flaky — use a browser there if it misbehaves.
</p>

<style>
  .two {
    gap: 12px;
  }
  .two .field {
    flex: 1;
    min-width: 0;
  }
  .meter {
    flex: 1;
    height: 10px;
    border-radius: 99px;
    background: var(--bg-0);
    overflow: hidden;
  }
  .meter div {
    height: 100%;
    background: var(--success);
    transition: width 60ms linear;
  }
</style>
