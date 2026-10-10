// The order in which the server-bound subtree changes servers (board #335
// ②b-1). Each case below is a rule the key alone does not give.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopeSwap } from './server-scope.ts';
import type { ServerRuntime } from './server-runtime.ts';

/** A handle double: what the swap needs from a runtime is its identity. */
const handle = (id: string) => ({ id } as ServerRuntime);

function host() {
  const log: string[] = [];
  /** Resolves on the next microtask, where Svelte's tick would resolve. */
  let settled = 0;
  const swap = createScopeSwap({
    show: (rt) => log.push(`show:${rt?.id ?? 'none'}`),
    settle: async () => { settled++; log.push('settle'); },
    invalidate: (rt) => log.push(`invalidate:${rt.id}`),
  });
  return { log, swap, settles: () => settled };
}

test('a first bind happens at once, with nothing to tear down', async () => {
  // At boot the tree renders immediately. A bind deferred by a tick would
  // mount every page unbound and then rebuild them, which is the remount this
  // mechanism exists to avoid — so the synchronous part of swap() must have
  // shown the runtime before the promise is even awaited.
  const h = host();
  const a = handle('a');
  const pending = h.swap.swap(a);
  assert.deepEqual(h.log, ['show:a'], 'shown before any await');
  assert.equal(h.swap.shown(), a);
  await pending;
  assert.deepEqual(h.log, ['show:a'], 'and it does not settle or invalidate');
  assert.equal(h.settles(), 0);
});

test('the same handle is not a different server', async () => {
  // A reconnect replaces the socket INSIDE one runtime. Remounting on it
  // would throw away the state the always-mounted pages exist to keep.
  const h = host();
  const a = handle('a');
  await h.swap.swap(a);
  await h.swap.swap(a);
  assert.deepEqual(h.log, ['show:a'], 'no unbind, no settle, no remount');
});

test('a replacement unbinds, settles, invalidates, then binds — in that order', async () => {
  const h = host();
  const a = handle('a');
  const b = handle('b');
  await h.swap.swap(a);
  h.log.length = 0;
  await h.swap.swap(b);
  assert.deepEqual(h.log, ['show:none', 'settle', 'invalidate:a', 'show:b']);
  assert.equal(h.swap.shown(), b);
});

test('the new runtime is not shown before the old subtree has settled', async () => {
  // The reason the step exists: `{#key}` creates the new branch BEFORE
  // destroying the old one, so without the settle the new pages would mount
  // beside the old server's still-live ones.
  const h = host();
  await h.swap.swap(handle('a'));
  h.log.length = 0;
  const pending = h.swap.swap(handle('b'));
  assert.deepEqual(h.log, ['show:none', 'settle'], 'unbound, and waiting');
  assert.equal(h.swap.shown(), null, 'nothing is bound in between');
  await pending;
  assert.deepEqual(h.log, ['show:none', 'settle', 'invalidate:a', 'show:b']);
});

test('unbinding to nothing invalidates too', async () => {
  // The server was removed, or the registry no longer resolves CURRENT: the
  // landings aimed at that tree are just as stale as on a replacement.
  const h = host();
  await h.swap.swap(handle('a'));
  h.log.length = 0;
  await h.swap.swap(null);
  assert.deepEqual(h.log, ['show:none', 'settle', 'invalidate:a', 'show:none']);
  assert.equal(h.swap.shown(), null);
});

test('a superseded swap shows nothing, and every handle it touched is released', async () => {
  // Two swaps overlapping: the later one decides what is shown. The earlier
  // one must not mount its own target over it — and BOTH handles it touched
  // are owed a release: the one it unbound, and its own target, which the
  // later swap replaced before it was ever shown. On a borrowed slot an
  // unreleased handle is a live lease nobody will revoke.
  const h = host();
  const a = handle('a');
  await h.swap.swap(a);
  h.log.length = 0;
  const b = handle('b');
  const first = h.swap.swap(b);
  const second = h.swap.swap(handle('c'));
  await Promise.all([first, second]);
  assert.deepEqual(h.log, [
    'show:none', 'settle',                    // the first swap unbinds A
    'settle',                                 // the second takes over
    'invalidate:a', 'invalidate:b', 'show:c', // and pays both debts
  ]);
  assert.equal(h.swap.shown()?.id, 'c', 'B was never shown');
  assert.ok(!h.log.includes('show:b'));
  assert.equal(h.log.filter((l) => l === 'invalidate:a').length, 1, 'and A only once');
});

test('a swap already heading for a server is not repeated', async () => {
  // One success path asks twice — the switch's comeUp and then bringUp — and
  // in between nothing is shown. Comparing against `shown` would start a
  // second swap and mint a second handle, which is never shown and therefore
  // never released.
  const h = host();
  await h.swap.swap(handle('a'));
  h.log.length = 0;
  const b = handle('b');
  const first = h.swap.swap(b);
  assert.equal(h.swap.bound(), b, 'the swap in flight says where it is going');
  await h.swap.swap(b);                       // the same target, asked again
  await first;
  assert.deepEqual(h.log, ['show:none', 'settle', 'invalidate:a', 'show:b']);
  assert.equal(h.swap.shown(), b);
});

test('an orphan is not invalidated twice by a later swap', async () => {
  const h = host();
  await h.swap.swap(handle('a'));
  await h.swap.swap(handle('b'));
  h.log.length = 0;
  await h.swap.swap(handle('c'));
  assert.deepEqual(h.log, ['show:none', 'settle', 'invalidate:b', 'show:c'],
    'only the handle this swap unbound');
});
