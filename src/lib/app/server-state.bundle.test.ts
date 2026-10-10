// One server's state as one value (board #335 ②b-2-1). The rules worth a test
// are the two the module header names: a bundle reads its storage when it is
// BUILT, which is why App builds it only once its server is current; and the
// person's own preferences are not part of it.
import test from 'node:test';
import assert from 'node:assert/strict';
// hub-prefs is a runes module: outside the compiler $state is the value
// itself, and `appPrefs` is built on `localStorage` at import time.
const live = new Map<string, string>();
(globalThis as any).$state = (value: unknown) => value;
(globalThis as any).localStorage = {
  getItem: (k: string) => live.get(k) ?? null,
  setItem: (k: string, v: string) => { live.set(k, String(v)); },
  removeItem: (k: string) => { live.delete(k); },
};
const { createServerState } = await import('./server-state.ts');
const { appPrefs } = await import('../hub/hub-prefs.svelte.ts');

test('a bundle reads the server that is current when it is BUILT', () => {
  // Through ②b the store is the bare localStorage, and a switch re-points its
  // live keys at the target (`pointTo`). A bundle built before that would
  // hold the server being LEFT — so App builds it in swapScope, after CURRENT
  // moved. This is the property that makes the timing matter.
  live.clear();
  live.set('tmux_hub_drafts', JSON.stringify({ app: 'A s draft' }));
  const a = createServerState(localStorage);
  // The switch surfaces B's slot into the live keys.
  live.set('tmux_hub_drafts', JSON.stringify({ app: 'B s draft' }));
  const b = createServerState(localStorage);
  assert.equal(a.prefs.draft('app'), 'A s draft', 'A s bundle kept what it read');
  assert.equal(b.prefs.draft('app'), 'B s draft', 'B s bundle read B s');
  assert.notEqual(a.prefs, b.prefs, 'two runtimes, two owners of the per-server half');
});

test('the person s preferences are not in a server s bundle', () => {
  // Feed level, tool-row cap and sidebar are the person's: two servers on
  // screen must not disagree about them, so every bundle reads the ONE owner.
  live.clear();
  const a = createServerState(localStorage);
  const b = createServerState(localStorage);
  appPrefs.setFeedLevel('chat');
  assert.equal(a.prefs.feedLevel, 'chat');
  assert.equal(b.prefs.feedLevel, 'chat');
  b.prefs.setSidebarCollapsed(true);
  assert.equal(appPrefs.sidebarCollapsed, true, 'a write through any bundle is the one owner s');
  assert.equal(a.prefs.sidebarCollapsed, true);
});

test('each server s centre holds its own alerts, and every centre shares the one bell', async () => {
  // The list is per server (`tmux_hub_alerts`, parked per server); the bell,
  // the popover and the jump in flight are the window's.
  const { centreSurface } = await import('../hub/notify-centre.svelte.ts');
  live.clear();
  live.set('tmux_hub_alerts', JSON.stringify([]));
  const a = createServerState(localStorage);
  a.centre.record({ key: 'proj:app|1', server: 'a', room: 'proj:app', session: 'app', project: 'app',
    seq: 1, id: '1', ts: 1, from: 'dev', toHuman: true, kind: 'reply', excerpt: 'x', viewed: false });
  // The switch surfaces B's (empty) list into the live key.
  live.set('tmux_hub_alerts', JSON.stringify([]));
  const b = createServerState(localStorage);
  assert.equal(a.centre.unviewed, 1);
  assert.equal(b.centre.unviewed, 0, 'B does not show A s alert');
  a.centre.requestJump(a.centre.items[0]!);
  assert.equal(b.centre.jump?.alert.key, 'proj:app|1', 'one jump request for the window');
  centreSurface.reset();
  assert.equal(a.centre.jump, null);
});

test('a same-machine merge hands the replaced runtime s state over; anything else starts fresh', async () => {
  // reviewer P1 on bdac94bd: identity repair folding alias A into canonical B
  // replaces the handle, and a fresh bundle there orphaned A's Files record —
  // its rows, its browse positions, and every attempt in flight, which a
  // later switch could then no longer find to suspend.
  const { stateForRuntime } = await import('./server-state.ts');
  live.clear();
  const old = createServerState(localStorage);
  const create = () => createServerState(localStorage);
  const merged = (id: string) => (id === 'alias' ? 'canon' : id);
  assert.equal(stateForRuntime({ id: 'alias', state: old }, 'canon', { survivorOf: merged, create }), old,
    'the canonical runtime adopts the SAME bundle — the attempt table included');
  assert.notEqual(stateForRuntime({ id: 'other', state: old }, 'canon', { survivorOf: merged, create }), old,
    'a different server is a different state');
  assert.notEqual(stateForRuntime({ id: 'gone', state: old }, 'canon', { survivorOf: () => '', create }), old,
    'an id nothing shows to be merged hands nothing over');
  assert.notEqual(stateForRuntime(null, 'canon', { survivorOf: merged, create }), old, 'a first bind is fresh');
  assert.notEqual(stateForRuntime({ id: 'alias', state: undefined }, 'canon', { survivorOf: merged, create }), undefined,
    'and there is always a state');
});

test('releasing a server s state forbids new attempts, then suspends and awaits the running ones', async () => {
  const { releaseServerState } = await import('./server-state.ts');
  const { SUSPEND } = await import('../files/download.ts');
  live.clear();
  const st = createServerState(localStorage);
  const running = new AbortController();
  let settle = () => {};
  st.files.memory.track('r', running, new Promise<void>((r) => { settle = r; }));
  let done = false;
  const releasing = releaseServerState(st).then(() => { done = true; });
  assert.equal(st.files.memory.sealed(), true, 'sealed first');
  assert.equal(running.signal.reason, SUSPEND, 'suspended, so its part is kept');
  await Promise.resolve();
  assert.equal(done, false, 'not released until the attempt settled');
  settle();
  await releasing;
  assert.equal(done, true);
});

test('a state already released is never handed over, merge or not (reviewer P1-b)', async () => {
  // A failed switch released the alias's state on the way out; the merge is
  // discovered only on the way back. Adopting that sealed record would leave
  // the canonical runtime unable to start a download.
  const { stateForRuntime, releaseServerState } = await import('./server-state.ts');
  live.clear();
  const old = createServerState(localStorage);
  await releaseServerState(old);
  const merged = (id: string) => (id === 'alias' ? 'canon' : id);
  const next = stateForRuntime({ id: 'alias', state: old }, 'canon', { survivorOf: merged, create: () => createServerState(localStorage) });
  assert.notEqual(next, old, 'a fresh state instead');
  assert.equal(next.files.memory.sealed(), false, 'which can start downloads');
});
