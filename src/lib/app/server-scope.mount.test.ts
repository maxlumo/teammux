// The swap's order, measured in a real Svelte tree (board #335 ②b-1).
//
// `server-scope.test.ts` proves the order the module produces; only a mount
// can prove two things about the actual wiring. First, that the step in the
// middle is where the old subtree really dies: Svelte creates a keyed branch
// BEFORE destroying the one it replaces (`server-context.mount.test.ts`
// measures exactly that), so "the old server's pages are gone before the new
// server's pages exist" is a property of this sequence and of nothing else.
// Second, that NO server-bound page exists while no server is bound — the
// provider renders nothing without a runtime, and the fixture below renders
// its children unconditionally, the way App renders its pages, so the
// suppression has to come from the primitive rather than from the host
// (reviewer P1-b, 2026-10-10).
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

let compiled: ReturnType<typeof compileMount> | undefined;
const fixture = () => compiled ??= compileMount(new URL('./ServerScope.test.svelte', import.meta.url), []);

/** A handle double: the real runtime has its own tests, and what the subtree
 * needs from one is an identity and an api that says whose it is. */
function runtime(id: string, log: string[] = []) {
  return {
    id,
    api: { listSessions: async () => { log.push(`${id}:list_sessions`); return [{ name: `on-${id}` }]; } },
  };
}

async function mount(context: TestContext) {
  const f = await fixture();
  return f.mount(context, { modules: [] });
}

/** One ordered trace: the consumer writes its mount and destroy, the fixture
 * writes the release. Values cross the jsdom realm, so copy them in. */
const trace = (app: { window: any }) =>
  Array.from((app.window.__ctxSeen ?? []) as unknown[], (e: any) =>
    typeof e === 'string' ? e : `${e.mounted ? 'mount' : 'destroy'}:${e.label}`);
/** Every mount that happened holding anything but its own runtime's api. A
 * page that never mounts cannot send an RPC either, so this is also the
 * answer to "did anything unbound reach the wire". */
const unbound = (app: { window: any }) =>
  Array.from((app.window.__ctxSeen ?? []) as unknown[])
    .filter((e: any) => typeof e !== 'string' && e.mounted && e.usesCompat)
    .map((e: any) => String(e.label));
const swap = (app: { window: any }, rt: unknown) => app.window.__scope.swap(rt);
const flush = async (app: { flush: () => Promise<void> }, n = 6) => { for (let i = 0; i < n; i++) await app.flush(); };

test('the old subtree is destroyed, and its handle released, before the new one mounts', async (t) => {
  const app = await mount(t);
  await swap(app, runtime('a'));
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a']);

  await swap(app, runtime('b'));
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a', 'destroy:a', 'release:a', 'mount:b'],
    'destroy first, then the release, then the new owner');
  assert.deepEqual(unbound(app), [], 'and nothing server-bound ever mounted without a server');
});

test('no server-bound page exists while no server is bound', async (t) => {
  // The gap in a swap, and the fresh client before its first connect. The
  // children here are rendered unconditionally, so if the provider rendered
  // them without a runtime they would mount holding the facade — which is
  // what "unbound" counts.
  const app = await mount(t);
  await flush(app);
  assert.deepEqual(trace(app), [], 'nothing mounted before a runtime existed');
  assert.equal(app.document.querySelector('button.ask'), null);

  await swap(app, runtime('a'));
  await flush(app);
  await swap(app, runtime('b'));
  await flush(app);
  await swap(app, null);
  await flush(app);
  assert.deepEqual(unbound(app), [],
    'not during the gap between two servers, and not after unbinding');
  assert.ok(!trace(app).includes('mount:unbound'), 'the unbound label never appears');
  assert.equal(app.document.querySelector('button.ask'), null, 'and nothing is left on screen');
});

test('the same handle changes nothing in the tree', async (t) => {
  // A reconnect: the socket is replaced inside one runtime. Remounting here
  // would discard what the always-mounted pages keep across a blip.
  const app = await mount(t);
  const a = runtime('a');
  await swap(app, a);
  await flush(app);
  await swap(app, a);
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a'], 'no destroy, no second mount, no release');
});

test('each subtree is bound to its own runtime, and keeps it across the handover', async (t) => {
  const app = await mount(t);
  const log: string[] = [];
  await swap(app, runtime('a', log));
  await flush(app);
  const button = app.document.querySelector<HTMLButtonElement>('button.ask[data-label="a"]');
  assert.ok(button, 'the bound consumer mounted');
  assert.equal(button.dataset.server, 'a');
  assert.equal(button.dataset.compat, '0', 'it holds its own runtime s api, by identity');

  // And the api it holds is still A's after the tree has moved on — the
  // reason the context is read once at init.
  button.click();
  await swap(app, runtime('b', log));
  await flush(app, 8);
  assert.deepEqual(log, ['a:list_sessions']);
});

test('a swap already heading for a server is not repeated', async (t) => {
  // Through the real tree: asking twice for the same target (App's comeUp and
  // then bringUp) must not build the subtree twice.
  const app = await mount(t);
  await swap(app, runtime('a'));
  await flush(app);
  const b = runtime('b');
  const first = swap(app, b);
  await swap(app, b);
  await first;
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a', 'destroy:a', 'release:a', 'mount:b']);
  assert.equal(app.window.__scope.shown(), b);
});

test('a subtree gets the state its host built for THAT runtime, with the runtime', async (t) => {
  // ②b-2-1: the provider binds the runtime and its server's state as ONE
  // scope. A provider that dropped the state, or kept the previous one, would
  // give B's pages A's memory beside B's api.
  const app = await mount(t);
  await swap(app, runtime('a'));
  await flush(app);
  await swap(app, runtime('b'));
  await flush(app);
  const seen = Array.from((app.window.__ctxSeen ?? []) as unknown[])
    .filter((e: any) => typeof e !== 'string' && e.mounted)
    .map((e: any) => `${e.label}:${e.stateOf}`);
  assert.deepEqual(seen, ['a:a', 'b:b'], 'each subtree saw its own runtime s state');
});
