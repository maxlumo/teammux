<script>
  // Host for the per-member guest test (board #335 ③a, reviewer P1-C): TWO
  // guest scopes over two transports, and a control to change which one is
  // shown — what App does when focus moves between Aggregate members.
  import Preferences from './Preferences.svelte';
  import { createServerState } from './server-state.ts';
  let { ...initial } = $props();
  // svelte-ignore state_referenced_locally
  let rest = $state({ ...initial });
  globalThis.__guestProps = (next) => Object.assign(rest, next);
  const make = (id, transport) => ({ runtime: { id, api: transport, connection: transport }, state: createServerState(localStorage) });
  const a = make('a', globalThis.__guestA);
  const b = make('b', globalThis.__guestB);
  // Raw: a runtime is a handle, compared by identity (App's scopeRuntime too).
  let shown = $state.raw(a.runtime);
  globalThis.__showGuest = (id) => { shown = id === 'a' ? a.runtime : b.runtime; };
</script>

<Preferences {...rest} guests={[a, b]} guestShown={shown} />
