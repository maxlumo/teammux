// The `backends_check` login cap of ONE runtime, followed live (board #492
// phase 2). The desktop Agents page and the phone's Settings both read their
// Backends entry through this and `backendsShown`, so the two cannot disagree.
// Call it during a component's init: it subscribes in an $effect.
import { untrack } from 'svelte';
import { backendsShown, capState, noteCap, type CapState } from './backends-view.ts';

type CapsSource = {
  connection?: {
    getCaps?: () => string[] | undefined;
    onCaps?: (cb: (caps: string[] | undefined) => void) => (() => void) | void;
  };
};

export function watchBackendsCap(runtime: () => CapsSource | null | undefined) {
  let seen = $state.raw<{ runtime: CapsSource | null; state: CapState }>({ runtime: null, state: 'unknown' });
  const read = (r: CapsSource | null | undefined, caps: string[] | undefined) => {
    const state = capState(caps);
    if (r) noteCap(r, state);
    seen = { runtime: r ?? null, state };
  };
  // The first paint already knows what the connection knows.
  untrack(() => { const r = runtime(); read(r, r?.connection?.getCaps?.()); });
  $effect(() => {
    const r = runtime();
    untrack(() => read(r, r?.connection?.getCaps?.()));
    if (!r) return;
    const off = r.connection?.onCaps?.((caps) => { if (untrack(runtime) === r) read(r, caps); });
    return typeof off === 'function' ? off : undefined;
  });
  return {
    get state(): CapState { return seen.state; },
    get shown(): boolean { return !!seen.runtime && backendsShown(seen.runtime, seen.state); },
  };
}
