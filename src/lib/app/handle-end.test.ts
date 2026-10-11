// Ending a handle: stop now, dispose only once its state is released (board
// #335 ②b-2-3, reviewer P1-a on 48b40082).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandleEnds } from './handle-end.ts';

function rig() {
  const log: string[] = [];
  const handle = (id: string) => ({
    id,
    detach: () => { log.push(`detach:${id}`); },
    dispose: () => { log.push(`dispose:${id}`); },
  });
  type H = ReturnType<typeof handle>;
  const states = new Map<H, string>();
  let adopter: H | null = null;
  let finish: () => void = () => {};
  const ends = createHandleEnds<H, string>({
    stateOf: (h) => states.get(h),
    adoptedElsewhere: (s, h) => !!adopter && adopter !== h && states.get(adopter) === s,
    release: (s) => { log.push(`release:${s}`); return new Promise<void>((r) => { finish = () => { log.push(`released:${s}`); r(); }; }); },
  });
  return { log, handle, states, ends, adopt: (h: H) => { adopter = h; }, finish: () => finish() };
}

test('the handle stops at once and is disposed only after its state is released', async () => {
  const r = rig();
  const a = r.handle('a');
  r.states.set(a, 'A');
  const done = r.ends.end(a);
  assert.deepEqual(r.log, ['detach:a', 'release:A'], 'stopped, release started, NOT disposed');
  assert.equal(r.ends.ending(a), true, 'and not reusable');
  await Promise.resolve();
  assert.ok(!r.log.includes('dispose:a'));
  r.finish();
  await done;
  assert.deepEqual(r.log, ['detach:a', 'release:A', 'released:A', 'dispose:a']);
});

test('every path waits on the same end', async () => {
  const r = rig();
  const a = r.handle('a');
  r.states.set(a, 'A');
  const one = r.ends.end(a);
  const two = r.ends.end(a);
  assert.equal(one, two);
  r.finish();
  await one;
  assert.equal(r.log.filter((e) => e === 'dispose:a').length, 1, 'disposed once');
});

test('an ADOPTED state is not released: the same server keeps running', async () => {
  const r = rig();
  const alias = r.handle('alias');
  const canon = r.handle('canon');
  r.states.set(alias, 'A');
  r.states.set(canon, 'A');
  r.adopt(canon);
  await r.ends.end(alias);
  assert.deepEqual(r.log, ['detach:alias', 'dispose:alias'], 'ended without a release');
});

test('a handle with no state ends at once', async () => {
  const r = rig();
  await r.ends.end(r.handle('x'));
  await r.ends.end(null);
  assert.deepEqual(r.log, ['detach:x', 'dispose:x']);
});

// The same order with the REAL pieces App wires together — a server's real
// state and its release, and the real scope swap — so the order is not only
// the helper's promise. Only the handle is a double, so it is where the
// detach and the dispose are recorded.
(globalThis as any).$state ??= (value: unknown) => value;
(globalThis as any).localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { createServerState, releaseServerState } = await import('./server-state.ts');
const { createScopeSwap } = await import('./server-scope.ts');

function wired() {
  const log: string[] = [];
  type Handle = { id: string; detach(): void; dispose(): void };
  const handle = (id: string): Handle => ({
    id,
    detach: () => { log.push(`detach:${id}`); },
    dispose: () => { log.push(`dispose:${id}`); },
  });
  const states = new WeakMap<Handle, ReturnType<typeof createServerState>>();
  let shown: Handle | null = null;
  const swap = createScopeSwap({
    show: (h) => { shown = h as unknown as Handle | null; if (h) log.push(`show:${(h as unknown as Handle).id}`); },
    settle: () => Promise.resolve(),
    invalidate: (gone) => ends.end(gone as unknown as Handle),
  });
  const ends = createHandleEnds<Handle, ReturnType<typeof createServerState>>({
    stateOf: (h) => states.get(h),
    adoptedElsewhere: (state, h) => {
      const next = swap.bound() as unknown as Handle | null;
      return !!next && next !== h && states.get(next) === state;
    },
    release: releaseServerState,
  });
  /** A download in flight on `h`'s server: it hears the abort at once and
   * settles only when the case says so. */
  const downloading = (h: Handle) => {
    const state = createServerState(localStorage);
    states.set(h, state);
    const control = new AbortController();
    control.signal.addEventListener('abort', () => log.push(`aborted:${h.id}`));
    let finish: () => void = () => {};
    const settled = new Promise<void>((resolve) => { finish = () => { log.push(`settled:${h.id}`); resolve(); }; });
    assert.equal(state.files.memory.track('row', control, settled), true);
    return finish;
  };
  return { log, handle, states, swap, ends, downloading, shown: () => shown };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('a revoke and the swap after it end the handle once, after its download settles, before B shows', async () => {
  const w = wired();
  const a = w.handle('a');
  const b = w.handle('b');
  await w.swap.swap(a as never);
  const finish = w.downloading(a);
  void w.ends.end(a);                              // an end already started (a fleet drop)
  w.states.set(b, createServerState(localStorage));
  const swapped = w.swap.swap(b as never);         // and the swap that follows
  await flush();
  assert.equal(w.shown(), null, 'nothing shown while A is ending');
  assert.ok(!w.log.includes('dispose:a'));
  finish();
  await swapped;
  const order = w.log.filter((e) => /^(aborted|settled|dispose):a$|^show:b$/u.test(e));
  assert.deepEqual(order, ['aborted:a', 'settled:a', 'dispose:a', 'show:b'], 'stop, settle, dispose, then B');
});
