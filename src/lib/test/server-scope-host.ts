// The server scope a mounted fixture runs in (board #335 ②b-2-1): what App's
// provider gives every server-bound page — a runtime and that server's state —
// for a component the mount harness mounts on its own. The state is built over
// the realm's `localStorage` when the scenario starts, after the test seeded
// it, the way App builds it once a server is current.
//
// The runtime speaks through the test's mocked `core/ws.ts` (②b-3): its api
// AND its connection are that one transport, which is what the Single runtime
// is in production — it borrows the facade's slot, whose connection and api
// are the same socket. So a page bound to its scope makes exactly the calls
// the test mocked, and a page that still imports the facade makes them too,
// until the slot is retired.
import { scopeContext } from '../app/server-context.ts';
import { createServerState } from '../app/server-state.ts';
import type { ServerRuntime } from '../app/server-runtime.ts';

/** One server's scope over `transport`: what App hands the provider, or —
 * for Preferences' embedded editor — the guest props (②b-3). */
export const testScope = (transport?: unknown) => {
  const state = createServerState(localStorage);
  // Reachable from a test, so it can act on the server's state the way App
  // does — release it, say — without a second way to build one.
  (globalThis as { __serverState?: unknown }).__serverState = state;
  const runtime = { id: 'test', api: transport, connection: transport } as unknown as ServerRuntime;
  return { runtime, state };
};

export const testScopeContext = (transport?: unknown) => scopeContext(testScope(transport));
