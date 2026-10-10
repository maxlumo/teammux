// The swap's order, measured in a real Svelte tree (board #335 ②b-1).
//
// `server-scope.test.ts` proves the order the module produces; only a mount
// can prove that the step in the middle is where the old subtree actually
// dies. Svelte creates a keyed branch BEFORE destroying the one it replaces
// (`server-context.mount.test.ts` measures exactly that), so "the old server's
// pages are gone before the new server's pages exist" is a property of this
// sequence and of nothing else: unbind, let the host settle, invalidate, bind.
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
 * writes the invalidate. Values cross the jsdom realm, so copy them in. */
const trace = (app: { window: any }) =>
  Array.from((app.window.__ctxSeen ?? []) as unknown[], (e: any) =>
    typeof e === 'string' ? e : `${e.mounted ? 'mount' : 'destroy'}:${e.label}`);
const swap = (app: { window: any }, rt: unknown) => app.window.__scope.swap(rt);
const flush = async (app: { flush: () => Promise<void> }, n = 6) => { for (let i = 0; i < n; i++) await app.flush(); };

test('the old subtree is destroyed, and its landings cleared, before the new one mounts', async (t) => {
  const app = await mount(t);
  await swap(app, runtime('a'));
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a']);

  await swap(app, runtime('b'));
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a', 'destroy:a', 'invalidate:a', 'mount:b'],
    'destroy first, then the invalidate, then the new owner');
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
  assert.deepEqual(trace(app), ['mount:a'], 'no destroy, no second mount, no invalidate');
});

test('each subtree is bound to its own runtime, and a provider-less one is not', async (t) => {
  const app = await mount(t);
  const log: string[] = [];
  await swap(app, runtime('a', log));
  await flush(app);
  const button = app.document.querySelector<HTMLButtonElement>('button.ask[data-label="a"]');
  assert.ok(button, 'the bound consumer mounted');
  assert.equal(button.dataset.server, 'a');
  assert.equal(button.dataset.compat, '0', 'it does not even hold the compatibility slot');

  // And the api it holds is still A's after the tree has moved on — the
  // reason the context is read once at init.
  button.click();
  await swap(app, runtime('b', log));
  await flush(app, 8);
  assert.deepEqual(log, ['a:list_sessions']);
});

test('unbinding to nothing leaves no bound subtree, and clears what was aimed at it', async (t) => {
  // CURRENT no longer resolves (the entry was removed, or a fresh client
  // disconnected): the pages fall back to the facade, which is the path they
  // took before any of this existed.
  const app = await mount(t);
  await swap(app, runtime('a'));
  await flush(app);
  await swap(app, null);
  await flush(app);
  assert.deepEqual(trace(app), ['mount:a', 'destroy:a', 'invalidate:a']);
  assert.equal(app.window.__scope.shown(), null);
  assert.equal(app.document.querySelector('button.ask'), null, 'nothing bound is mounted');
});
