// The server scope a mounted fixture runs in (board #335 ②b-2-1): what App's
// provider gives every server-bound page — a runtime and that server's state —
// for a component the mount harness mounts on its own. The runtime is a
// stand-in (nothing reads its api until ②b-3 wires the pages to it); the state
// is built over the realm's `localStorage` when the scenario starts, after the
// test seeded it, the way App builds it once a server is current.
import { scopeContext } from '../app/server-context.ts';
import { createServerState } from '../app/server-state.ts';
import type { ServerRuntime } from '../app/server-runtime.ts';

export const testScopeContext = () => {
  const state = createServerState(localStorage);
  // Reachable from a test, so it can act on the server's state the way App
  // does — release it, say — without a second way to build one.
  (globalThis as { __serverState?: unknown }).__serverState = state;
  return scopeContext({ runtime: { id: 'test' } as ServerRuntime, state });
};
