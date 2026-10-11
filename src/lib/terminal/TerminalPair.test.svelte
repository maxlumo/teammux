<script>
  // Host for Terminal.isolation.mount.test.ts (board #335 ③a): two REAL
  // runtimes from a real fleet — each its own `createConnection`, dialled
  // over its own socket — and one Terminal per runtime inside its own
  // ServerScope, both on the same target. What the test controls is the
  // socket; everything from the connection up is production code.
  import ServerScope from '../app/ServerScope.svelte';
  import Terminal from './Terminal.svelte';
  import { createServerFleet } from '../app/server-fleet.ts';
  import { createServerState } from '../app/server-state.ts';
  import { createServerStore } from '../app/server-store.ts';
  import { loadServers } from '../app/servers.ts';

  let { target = 'app:0.0' } = $props();
  const fleet = createServerFleet({ storage: localStorage });
  const runtimes = loadServers(localStorage).map((entry) => fleet.include(entry));
  let shown = $state([]);
  /** Which server's tree is focused (board #335 ③a-4): only its Terminal is
   * `active`. Null = both, the pre-③a shape. */
  let focus = $state(null);
  const exits = [];
  const switched = [];
  globalThis.__pair = {
    runtimes,
    exits,
    dial: () => Promise.all(runtimes.map((r) => r.dial())),
    show() {
      shown = runtimes.map((runtime) => ({ runtime, state: createServerState(createServerStore(localStorage, runtime.id)) }));
    },
    hide(id) { shown = shown.filter((s) => s.runtime.id !== id); },
    focus(id) { focus = id; },
    switched,
  };
</script>

{#each shown as s (s.runtime.id)}
  <div class="cell" data-server={s.runtime.id}>
    <ServerScope runtime={s.runtime} state={s.state}>
      <Terminal {target} session="app" visible active={focus === null || focus === s.runtime.id}
        onSwitchPane={(t) => switched.push(`${s.runtime.id}:${t}`)}
        onPaneExit={(t) => exits.push(`${s.runtime.id}:${t}`)} />
    </ServerScope>
  </div>
{/each}
