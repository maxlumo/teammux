<script>
  // A consumer the way every page becomes one in ②b: read the context ONCE at
  // init into a local const, then use that const for the instance's whole
  // life — including from a handler that runs long after init, and across an
  // await, where reading the context again would return nothing.
  import { onDestroy } from 'svelte';
  import { compatSlotApi } from '../core/ws.ts';
  import { useServerApi, useServerId, useServerScope } from './server-context.ts';

  let { label } = $props();
  const api = useServerApi();
  const serverId = useServerId();
  // The state the provider bound WITH the runtime (②b-2-1): a page must see
  // its own server's memory, never another's beside this server's api.
  const stateOf = useServerScope()?.state?.of ?? null;
  // Identity, not a call log: an owned subtree must not even HOLD the
  // compatibility slot's api (reviewer r1 §F). Nothing can leak onto a slot
  // nobody has a reference to.
  const usesCompat = api === compatSlotApi;
  let answer = $state('');

  // The instance's own name, captured at init like everything else here: this
  // consumer belongs to one server for its whole life.
  // svelte-ignore state_referenced_locally
  const mine = { label: String(label), serverId, usesCompat, stateOf };
  globalThis.__ctxSeen ??= [];
  globalThis.__ctxSeen.push({ ...mine, mounted: true });
  onDestroy(() => { globalThis.__ctxSeen.push({ ...mine, mounted: false }); });

  async function ask() {
    // Deliberately awaits first: the api in hand must still be this
    // instance's server, whatever the user looked at meanwhile.
    await Promise.resolve();
    try {
      const sessions = await api.listSessions();
      answer = (sessions ?? []).map((s) => s.name).join(',');
    } catch (e) { answer = `ERR ${e?.message ?? e}`; }
  }
</script>

<button class="ask" data-label={label} data-server={serverId ?? ''} data-compat={usesCompat ? '1' : '0'} onclick={ask}>ask {label}</button>
<span class="answer" data-label={label}>{answer}</span>
