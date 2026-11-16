<script>
  // Host for #134's mount test: the Files page, and the transfer limit setting a test changes mid-run
  // (the same module instance the page's downloads go through).
  import Files from './Files.svelte';
  import { transferPrefs } from './transfers.svelte.ts';
  let props = $props();
  globalThis.__transferLimit = (n) => transferPrefs.setLimit(n);
</script>

<Files {...props} />
