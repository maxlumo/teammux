<script>
  // Host for the scope-swap mount test (board #335 ②b-1). It is App's shape,
  // using App's primitives and no others: ONE keyed `ServerScope` around the
  // server-bound children, and the swap as the only way the handle changes.
  //
  // The children are rendered UNCONDITIONALLY, exactly as App renders its
  // pages. An earlier version of this fixture guarded them with `{#if shown}`,
  // which production does not have, and that guard was the only reason the
  // teardown order looked right: `ServerScope` was still rendering a
  // provider-less tree during the gap (reviewer P1-b, 2026-10-10). The
  // suppression has to come from the primitive under test.
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
    invalidate: (runtime) => { (globalThis.__ctxSeen ??= []).push(`release:${runtime.id}`); },
  });

  globalThis.__scope = {
    swap: (runtime) => swap.swap(runtime),
    shown: () => swap.shown(),
    bound: () => swap.bound(),
  };
</script>

{#key shown}
  <ServerScope runtime={shown}>
    <Consumer label={shown?.id ?? 'unbound'} />
  </ServerScope>
{/key}
