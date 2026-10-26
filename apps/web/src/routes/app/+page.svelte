<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  onMount(() => {
    let last: string | null = null;
    try {
      last = localStorage.getItem('lastPath');
    } catch {
      /* storage blocked */
    }
    goto(last && last.startsWith('/app/') ? last : '/app/me', { replaceState: true });
  });
</script>
