<script>
  // Board #479: the Hub's drawer mounts a fresh Files on every open and drops
  // it under a 760px window; the next instance is born in the same server's
  // Files record. `shown` is that mount gate; the output is the embedder's
  // read of `currentPath`.
  import Files from './Files.svelte';
  let { shown = true, ...rest } = $props();
  let currentPath = $state('');
</script>

{#if shown}<Files {...rest} bind:currentPath />{/if}
<output class="current-path">{currentPath}</output>
