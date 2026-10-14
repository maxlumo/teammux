<script>
  // Host for Terminal.strip.mount.test.ts (#365): ONE real runtime over a
  // test-owned socket, one Terminal in its ServerScope, and a host that does
  // what App does with a window switch — it moves the target — so the strip's
  // current tab (and its marker) can be watched following it.
  import ServerScope from '../app/ServerScope.svelte';
  import Terminal from './Terminal.svelte';
  import { createServerFleet } from '../app/server-fleet.ts';
  import { createServerState } from '../app/server-state.ts';
  import { createServerStore } from '../app/server-store.ts';
  import { loadServers } from '../app/servers.ts';

  const fleet = createServerFleet({ storage: localStorage });
  const runtime = fleet.include(loadServers(localStorage)[0]);
  const serverState = createServerState(createServerStore(localStorage, runtime.id));
  let target = $state('app:0.0');
  let shown = $state(false);
  globalThis.__strip = {
    dial: () => runtime.dial(),
    show() { shown = true; },
    retarget(t) { target = t; },
    get target() { return target; },
  };
</script>

{#if shown}
  <ServerScope {runtime} state={serverState}>
    <Terminal {target} session="app" visible active onSwitchPane={(t) => { target = t; }} />
  </ServerScope>
{/if}
