// The server context with real components (board #335 ②a-3, decision D1).
//
// A source pin can say nobody reads the context after an await; only a mount
// can say that two subtrees bound to two servers each send to their own, that
// an action started before the user looked elsewhere still lands on the
// server it was started on, and that an owned subtree never so much as holds
// the compatibility slot's api (reviewer r1 §F).
//
// Nothing here is mocked. Since ②b-4 there is no provider-less fallback: a
// consumer without a provider fails to mount.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

let compiled: ReturnType<typeof compileMount> | undefined;
const fixture = () => compiled ??= compileMount(new URL('./ServerContext.test.svelte', import.meta.url), []);

/** A runtime double: the real runtime and the fleet have their own tests, and
 * what this one has to be is identifiable — whose api answered. */
function runtime(id: string, log: string[]) {
  return {
    id,
    api: {
      listSessions: async () => { log.push(`${id}:list_sessions`); return [{ name: `on-${id}` }]; },
    },
  };
}

async function mount(context: TestContext) {
  const f = await fixture();
  return f.mount(context, { modules: [] });
}

// Values cross the jsdom realm boundary, so a foreign array is never
// reference-equal to a local one: copy it in before asserting structure.
const seen = (app: { window: any }) =>
  Array.from((app.window.__ctxSeen ?? []) as { label: string; serverId: string | null; usesCompat: boolean; mounted: boolean }[],
    (s) => ({ label: s.label, serverId: s.serverId, usesCompat: s.usesCompat, mounted: s.mounted }));
const ctl = (app: { window: any }) => app.window.__ctx as { runtimes: unknown[]; bare: boolean };
const ask = (app: { document: Document }, label: string) =>
  app.document.querySelector<HTMLButtonElement>(`button.ask[data-label="${label}"]`);
const answer = (app: { document: Document }, label: string) =>
  app.document.querySelector(`span.answer[data-label="${label}"]`)?.textContent ?? '';
const flush = async (app: { flush: () => Promise<void> }, n = 6) => { for (let i = 0; i < n; i++) await app.flush(); };

test('with no provider a consumer does not mount: there is no fallback (board #335 ②b-4)', async (t) => {
  // Until ②b-4 it took the facade's compatibility slot — "whichever server it
  // was on". That slot is gone, so a page outside a provider has no server,
  // and asking for one is an error rather than someone else's api.
  const app = await mount(t);
  ctl(app).bare = true;
  await flush(app);
  assert.equal(ask(app, 'no-provider'), null, 'nothing mounted');
  assert.match(app.document.querySelector('.no-scope')?.textContent ?? '', /no server scope/u, 'and it says why');
  assert.deepEqual(seen(app).filter((s) => s.label === 'no-provider'), [], 'it never got as far as init');
});

test('two subtrees on two servers each send to their own, and hold no slot', async (t) => {
  const app = await mount(t);
  const log: string[] = [];
  ctl(app).runtimes = [runtime('a', log), runtime('b', log)];
  await flush(app, 4);

  assert.equal(ask(app, 'a')?.dataset.server, 'a');
  assert.equal(ask(app, 'b')?.dataset.server, 'b');
  // r1 §F: nothing can leak onto a slot that no owned consumer references.
  assert.deepEqual(seen(app).filter((s) => s.mounted && s.label !== 'no-provider').map((s) => s.usesCompat),
    [false, false]);

  ask(app, 'b')!.click();
  await flush(app);
  assert.deepEqual(log, ['b:list_sessions'], 'B s button asked B');
  assert.equal(answer(app, 'b'), 'on-b');
  assert.equal(answer(app, 'a'), '', 'and nothing landed in A');

  ask(app, 'a')!.click();
  await flush(app);
  assert.deepEqual(log, ['b:list_sessions', 'a:list_sessions']);
  assert.equal(answer(app, 'a'), 'on-a');
});

test('an action already under way keeps the server it started on', async (t) => {
  // The reason the context is read once at init. The user taps on A, and while
  // the request is in flight the provider set changes — a switch, a cell
  // re-bound, B arriving. A's answer must still be A's.
  const app = await mount(t);
  const log: string[] = [];
  ctl(app).bare = false;
  const a = runtime('a', log);
  ctl(app).runtimes = [a];
  await flush(app, 4);

  ask(app, 'a')!.click();                      // awaits before it calls
  ctl(app).runtimes = [a, runtime('b', log)];  // the world changes mid-flight
  await flush(app, 8);
  assert.deepEqual(log, ['a:list_sessions'], 'the call went to A, not to whoever is newest');
  assert.equal(answer(app, 'a'), 'on-a');
});

test('a replacement runtime for the same server remounts; the same handle does not', async (t) => {
  // ②b's subtree contract, measured from here. The subtree is keyed by the
  // HANDLE, so an ordinary reconnect inside one runtime (the same object) does
  // NOT remount anything — remounting on every reconnect would throw away the
  // state the always-mounted pages exist to keep — while a REPLACEMENT runtime
  // for the same server does swap the owner.
  //
  // What the key does not give, and this test pins so ②b cannot assume it:
  // Svelte creates the new branch BEFORE destroying the old one. So "the old
  // owner is torn down before the new one mounts" is not a property of
  // `{#key}`; b1 has to sequence that explicitly (tear the old owner down,
  // invalidate landings aimed at it, then hand the cell its new runtime) if it
  // wants the two to be ordered.
  const app = await mount(t);
  const log: string[] = [];
  ctl(app).bare = false;
  const first = runtime('a', log);
  ctl(app).runtimes = [first];
  await flush(app, 4);
  const mine = () => seen(app).filter((s) => s.label === 'a').map((s) => s.mounted);
  assert.deepEqual(mine(), [true]);

  // Same handle, re-assigned: a reconnect, not a new server.
  ctl(app).runtimes = [first];
  await flush(app, 4);
  assert.deepEqual(mine(), [true], 'no remount');

  // A replacement handle for the same id: the owner is swapped, new first.
  ctl(app).runtimes = [runtime('a', log)];
  await flush(app, 4);
  assert.deepEqual(mine(), [true, true, false],
    'the key swaps the owner, and it mounts the new one before destroying the old');
  // Whatever the order, the consumer on screen afterwards is the new owner's,
  // and the old one is gone.
  assert.equal(seen(app).filter((s) => s.label === 'a').length, 3);
  ask(app, 'a')!.click();
  await flush(app);
  assert.deepEqual(log, ['a:list_sessions'], 'and the surviving consumer asks its own runtime');
});
