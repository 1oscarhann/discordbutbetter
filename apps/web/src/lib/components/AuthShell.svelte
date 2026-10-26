<script lang="ts">
  import type { Snippet } from 'svelte';
  import { onMount } from 'svelte';
  import { get } from '$lib/api';
  import type { InstanceInfo } from '@haunt/shared';

  let { title, children }: { title: string; children: Snippet } = $props();
  let name = $state('');
  onMount(async () => {
    try {
      name = (await get<InstanceInfo>('/instance')).name;
      document.title = `${title} · ${name}`;
    } catch {
      /* ignore */
    }
  });
</script>

<main class="auth">
  <div class="card fade-in">
    <div class="brand">
      <img src="/favicon.svg" alt="" width="40" height="40" />
      <span>{name}</span>
    </div>
    <h1>{title}</h1>
    {@render children()}
  </div>
  <p class="foot faint">No tracking, no ads, no ID checks. Self-hosted.</p>
</main>

<style>
  .auth {
    min-height: 100vh;
    display: grid;
    place-content: center;
    gap: 16px;
    padding: 24px;
    background:
      radial-gradient(1200px 600px at 10% -10%, color-mix(in srgb, var(--accent) 25%, transparent), transparent),
      radial-gradient(900px 500px at 110% 110%, color-mix(in srgb, var(--success) 12%, transparent), transparent),
      var(--bg-0);
    overflow-y: auto;
    height: 100vh;
  }
  .card {
    width: min(420px, calc(100vw - 32px));
    padding: 28px;
    border-radius: 16px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 800;
    font-size: 1.1rem;
    margin-bottom: 16px;
  }
  h1 {
    font-size: 1.45rem;
    margin: 0 0 18px;
  }
  .foot {
    text-align: center;
    font-size: 0.82rem;
  }
</style>
