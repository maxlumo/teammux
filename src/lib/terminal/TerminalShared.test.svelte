<script>
  // Host for Terminal.shared.mount.test.ts (board #395): ONE real runtime and
  // two Terminals on the SAME pane, as the app has them — the Terminal page's
  // and the Hub drawer's — each told separately whether it is shown. What the
  // test controls is the socket, the boxes' sizes and their observers.
  import ServerScope from '../app/ServerScope.svelte';
  import Terminal from './Terminal.svelte';
  import { createServerFleet } from '../app/server-fleet.ts';
  import { createServerState } from '../app/server-state.ts';
  import { createServerStore } from '../app/server-store.ts';
  import { loadServers } from '../app/servers.ts';

  let { target = 'app:0.0' } = $props();
  const fleet = createServerFleet({ storage: localStorage });
  const runtime = loadServers(localStorage).map((entry) => fleet.include(entry))[0];
  const serverState = createServerState(createServerStore(localStorage, runtime.id));
  let mounted = $state(false);
  let shown = $state({ page: false, drawer: true });
  globalThis.__shared = {
    dial: () => runtime.dial(),
    mount() { mounted = true; },
    show(which, on) { shown = { ...shown, [which]: on }; },
  };
</script>

{#if mounted}
  <ServerScope {runtime} state={serverState}>
    <div class="cell" data-cell="page"><Terminal {target} session="app" visible={shown.page} active={shown.page} /></div>
    <div class="cell" data-cell="drawer"><Terminal {target} session="app" embedded chromeless visible={shown.drawer} active={shown.drawer} /></div>
  </ServerScope>
{/if}
