// The order in which the server-bound subtree changes servers (board #335
// ②b-1). Each case below is a rule the key alone does not give.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createScopeSwap } from './server-scope.ts';
import type { ServerRuntime } from './server-runtime.ts';

/** A handle double: what the swap needs from a runtime is its identity. */
const handle = (id: string) => ({ id } as ServerRuntime);

function host({ hold = false } = {}) {
  const log: string[] = [];
  /** Resolves on the next microtask, where Svelte's tick would resolve —
   * unless the case holds it open, which is how "the host has not settled
   * yet" becomes observable. */
  let settled = 0;
  let open = () => {};
  const swap = createScopeSwap({
    show: (rt) => log.push(`show:${rt?.id ?? 'none'}`),
    settle: () => {
      settled++;
      log.push('settle');
      return hold ? new Promise<void>((resolve) => { open = resolve; }) : Promise.resolve();
    },
    invalidate: (rt) => { log.push(`invalidate:${rt.id}`); },
  });
  return { log, swap, settles: () => settled, release: () => open() };
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

test('an unbind right after the first bind is not read as a repeat of it', async () => {
  // `pending` is null in two different situations — no swap is running, and a
  // swap has just bound its target — so `next === pending` read `swap(null)`
  // as a repeat of the bind still finishing its `finally` and dropped the
  // unbind entirely (reviewer P2-a, 2026-10-10). The public contract of
  // `swap(null)` is that A is released.
  const h = host();
  const a = handle('a');
  void h.swap.swap(a);                        // first bind: synchronous, pending cleared
  await h.swap.swap(null);                    // in the same turn, before the finally ran
  assert.deepEqual(h.log, ['show:a', 'show:none', 'settle', 'invalidate:a', 'show:none'],
    'the unbind happened, and A was released');
  assert.equal(h.swap.shown(), null);
  assert.equal(h.swap.bound(), null);
});

test('settled() resolves on the bind, and a repeat of the swap in flight IS that swap', async () => {
  // What `settled()` is for is waiting until the subtree is actually bound —
  // the restore reads the record for the server on screen. Asking for the
  // same server again used to hand the waiter a promise that was already
  // over, because the repeat early-returns and the wrapper overwrote the one
  // still in flight (reviewer P2-a, 2026-10-10): `await settled()` then
  // returned with nothing shown, which is the very state the restore guards
  // against.
  const h = host({ hold: true });
  const a = handle('a');
  const b = handle('b');
  await h.swap.swap(a);                       // first bind: immediate
  const first = h.swap.swap(b);
  assert.equal(h.swap.shown(), null, 'the subtree is unbound while the host settles');

  let bound = false;
  const waiting = h.swap.settled().then(() => { bound = true; });
  assert.equal(h.swap.swap(b), first, 'the same target, asked again, is the request in flight');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(bound, false, 'and nothing has resolved: the bind has not happened');
  assert.equal(h.swap.shown(), null);

  h.release();
  await first;
  await waiting;
  assert.equal(bound, true);
  assert.equal(h.swap.shown(), b, 'settled() resolved on the bind itself');
  // Nothing in flight: a waiter does not block on a swap that is over.
  await h.swap.settled();
  assert.deepEqual(h.log, ['show:a', 'show:none', 'settle', 'invalidate:a', 'show:b']);
});

test('nothing is shown until the replaced runtime s release has finished (board #335 ②b-2-3)', async () => {
  // reviewer P1-a: the release of a runtime's state waits for work it
  // started; binding the next runtime before that would let the old work's
  // retries go out over a socket the new one already uses.
  const log: string[] = [];
  const finish = new Map<string, () => void>();
  const swap = createScopeSwap({
    show: (rt) => log.push(`show:${rt?.id ?? 'none'}`),
    settle: async () => { log.push('settle'); },
    invalidate: (rt) => new Promise<void>((resolve) => { log.push(`release:${rt.id}`); finish.set(rt.id, () => { log.push(`released:${rt.id}`); resolve(); }); }),
  });
  await swap.swap(handle('a'));
  const going = swap.swap(handle('b'));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(log, ['show:a', 'show:none', 'settle', 'release:a'], 'B is not shown while A is releasing');
  // A swap that arrives meanwhile with nothing of its own to tear down
  // waits too.
  const third = swap.swap(handle('c'));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(!log.includes('show:c'), 'C waits too');
  // C's own teardown releases B (never shown), and C waits for that AND A's.
  finish.get('b')?.();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.ok(!log.includes('show:c'), 'still waiting on A');
  finish.get('a')!();
  await going; await third;
  assert.equal(log.at(-1), 'show:c', 'shown only after every release finished');
  assert.ok(!log.includes('show:b'), 'and B, superseded, was never shown');
});

test('a refocus moves what is shown without tearing anything down (#335 D2)', async () => {
  const h = host();
  const a = handle('a');
  const b = handle('b');
  await h.swap.swap(a);
  h.log.length = 0;
  assert.equal(h.swap.refocus(b), true);
  assert.deepEqual(h.log, ['show:b'], 'no unbind, no settle, no invalidate');
  assert.equal(h.swap.shown(), b);
  assert.equal(h.swap.bound(), b);
  assert.equal(h.swap.refocus(b), false, 'already shown');
});

test('a refocus never races a swap: refused while one is in flight or nothing is shown', async () => {
  const h = host({ hold: true });
  const a = handle('a');
  const b = handle('b');
  const c = handle('c');
  assert.equal(h.swap.refocus(a), false, 'nothing shown yet');
  await h.swap.swap(a);
  const going = h.swap.swap(b);                    // held at settle
  assert.equal(h.swap.refocus(c), false, 'a swap is in flight');
  h.release();
  await going;
  assert.equal(h.swap.shown(), b, 'and the swap finished as it would have');
});
