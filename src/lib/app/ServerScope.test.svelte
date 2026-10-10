<script>
  // Host for the scope-swap mount test (board #335 ②b-1). It is App's shape:
  // ONE keyed `ServerScope` around the server-bound tree, and the swap as the
  // only way the handle changes — so what the test measures is the real
  // Svelte teardown order, not a description of it.
  import { tick } from 'svelte';
  import ServerScope from './ServerScope.svelte';
  import Consumer from './ServerContext.test.consumer.svelte';
  import { createScopeSwap } from './server-scope.ts';

  let shown = $state(null);
  const swap = createScopeSwap({
    show: (runtime) => { shown = runtime; },
    settle: () => tick(),
    // Into the same ordered trace the consumer writes its mount and destroy
    // into: what this test is about is where this step falls between them.
    invalidate: (runtime) => { (globalThis.__ctxSeen ??= []).push(`invalidate:${runtime.id}`); },
  });

  globalThis.__scope = {
    swap: (runtime) => swap.swap(runtime),
    shown: () => swap.shown(),
  };
</script>

{#key shown}
  <ServerScope runtime={shown}>
    {#if shown}<Consumer label={shown.id} />{/if}
  </ServerScope>
{/key}
