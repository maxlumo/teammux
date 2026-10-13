<script>
  // The Board under the REAL provider and a REAL runtime (board #357): what App
  // builds around a tree — ServerScope with its liveness notification — rather
  // than the harness's bare context. Test-only.
  import ServerScope from '../app/ServerScope.svelte';
  import Board from './Board.svelte';
  import { realTestScope } from '../test/server-scope-host.ts';

  let props = $props();
  const { runtime, state } = realTestScope(globalThis.__mountScopeTransport);
</script>

<ServerScope {runtime} {state} eligible={() => runtime.alive()}>
  <Board {...props} />
</ServerScope>
