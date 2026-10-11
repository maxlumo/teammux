<script>
  // Host for the Preferences mount tests (board #335 ②b-3): App gives the
  // embedded Agents editor its GUEST scope — the bound runtime and its state —
  // and this host does the same over the realm's mocked transport.
  import Preferences from './Preferences.svelte';
  import { testScope } from '../test/server-scope-host.ts';
  let { initial = null, register = null, ...rest } = $props();
  // svelte-ignore state_referenced_locally
  let props = $state({ ...(initial ?? rest) });
  // svelte-ignore state_referenced_locally
  register?.((next) => Object.assign(props, next));
  const guest = testScope(globalThis.__mountScopeTransport);
</script>

<Preferences {...props} guests={[guest]} guestShown={guest.runtime} />
