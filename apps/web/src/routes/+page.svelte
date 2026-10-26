<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from '$lib/api';

  onMount(async () => {
    try {
      await get('/users/@me');
      location.replace('/app');
    } catch {
      location.replace('/login');
    }
  });
</script>
