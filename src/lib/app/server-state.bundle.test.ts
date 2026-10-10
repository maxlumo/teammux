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
