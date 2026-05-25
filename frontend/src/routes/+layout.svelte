<script lang="ts">
  import { page } from '$app/stores';
  import RouteNavigation from '$lib/RouteNavigation.svelte';
  import '../app.css';

  $: isDashboardRoute = $page.url.pathname === '/';
</script>

{#if !isDashboardRoute}
  <RouteNavigation />
{/if}

<slot />
