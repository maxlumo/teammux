// Two servers' Hub preferences, held at once (board #335 ②a-4).
//
// Before the factory this module read `localStorage` at import time, so none
// of these rules could be tested outside a browser at all. Taking the storage
// is what makes them reachable — and it is also the mechanism ②b needs: each
// runtime gets a store scoped to its server (`app/server-store.ts`), which
// rewrites the resident keys and passes the person's own preferences through.
import test from 'node:test';
import assert from 'node:assert/strict';
// The store is a runes module; outside the compiler $state is the value
// itself (the downloads.test.ts / i18n.test.ts convention). The module also
// builds its DEFAULT instance at import time, on `localStorage` — these tests
// never touch that instance, but the import has to succeed, so the browser
// global is stubbed rather than the production path made lazy for a test.
(globalThis as any).$state = (value: unknown) => value;
(globalThis as any).localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
const { createAppPrefs, createHubPrefs, HUB_SERVER_KEYS } = await import('./hub-prefs.svelte.ts');

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    keys: () => [...m.keys()].sort(),
  };
}

/** What ②b hands a runtime: resident keys rewritten per server, everything
 * else passed through. Spelled out here rather than imported so this file
 * tests hub-prefs against the CONTRACT, not against one implementation. */
function scoped(storage: ReturnType<typeof mem>, serverId: string) {
  const resident = new Set<string>(HUB_SERVER_KEYS);
  const at = (k: string) => (resident.has(k) ? `${k}::${serverId}` : k);
  return {
    getItem: (k: string) => storage.getItem(at(k)),
    setItem: (k: string, v: string) => storage.setItem(at(k), v),
    removeItem: (k: string) => storage.removeItem(at(k)),
  };
}

test('two servers keep their own draft, lead, read mark and drawer for one project name', () => {
  // The collision: a project called `app` on both machines. Before #315 these
  // were global and a switch carried A's half-typed line into B.
  const disk = mem();
  const a = createHubPrefs(scoped(disk, 'a'));
  const b = createHubPrefs(scoped(disk, 'b'));

  a.setDraft('app', 'half a line on A');
  b.setDraft('app', 'half a line on B');
  a.setLead('app', 'builder');
  b.setLead('app', 'reviewer');
  a.setSeen('app', { seq: 12, ts: 1000 });
  b.setSeen('app', { seq: 3, ts: 500 });
  a.setDrawer('app', 'files');
  b.setDrawer('app', 'term');
  a.setRosterExpanded('app', true);

  assert.equal(a.draft('app'), 'half a line on A');
  assert.equal(b.draft('app'), 'half a line on B');
  assert.equal(a.lead('app'), 'builder');
  assert.equal(b.lead('app'), 'reviewer');
  assert.deepEqual(a.seen('app'), { seq: 12, ts: 1000 });
  assert.deepEqual(b.seen('app'), { seq: 3, ts: 500 });
  assert.equal(a.drawer('app'), 'files');
  assert.equal(b.drawer('app'), 'term');
  assert.equal(a.rosterExpanded('app'), true);
  assert.equal(b.rosterExpanded('app'), false, 'B never expanded its roster');
});

test('a preference changed on one server is immediately true on the other', () => {
  // The case the first version of this test missed by creating B only AFTER
  // A's writes, which hid a real bug (reviewer P1): the feed level, the
  // tool-row cap and the sidebar collapse are the PERSON's and the WINDOW's,
  // so BOTH live instances must see a change at once. A shared KEY is not
  // shared STATE — each factory used to keep its own copy, and B's went stale
  // until something rebuilt it.
  const disk = mem();
  const owner = createAppPrefs(disk);
  const a = createHubPrefs(scoped(disk, 'a'), owner);
  const b = createHubPrefs(scoped(disk, 'b'), owner);

  a.setFeedLevel('status');
  assert.equal(b.feedLevel, 'status', 'B is looking at the same person s app');
  a.setStepsRows(7);
  assert.equal(b.stepsRows, 7);
  b.setSidebarCollapsed(true);
  assert.equal(a.sidebarCollapsed, true, 'and it works in both directions');

  // Still written where every server reads it, never behind one.
  assert.ok(disk.keys().includes('tmux_hub_feed_level'));
  assert.ok(!disk.keys().some((k) => k.startsWith('tmux_hub_feed_level::')));
});

test('a server s own maps stay isolated while the preferences are shared', () => {
  // One owner for the person, one record per server, in the same pair of
  // instances — the two halves must not have been collapsed into one.
  const disk = mem();
  const owner = createAppPrefs(disk);
  const a = createHubPrefs(scoped(disk, 'a'), owner);
  const b = createHubPrefs(scoped(disk, 'b'), owner);
  a.setFeedLevel('chat');
  a.setDraft('app', 'A only');
  assert.equal(b.feedLevel, 'chat', 'shared');
  assert.equal(b.draft('app'), '', 'isolated');
});

test('the tool-row cap is clamped, on the way in and on the way out', () => {
  // A stored value passes the same clamp as the setter, so an old or
  // hand-edited entry cannot render a broken lane.
  const disk = mem();
  const owner = createAppPrefs(disk);
  const a = createHubPrefs(scoped(disk, 'a'), owner);
  a.setStepsRows(99999);
  const capped = a.stepsRows;
  assert.ok(capped < 99999, `the setter clamped it to ${capped}`);
  assert.equal(disk.getItem('tmux_hub_steps_rows'), String(capped), 'and stored what it clamped to');

  disk.setItem('tmux_hub_steps_rows', '99999');
  assert.equal(createAppPrefs(disk).stepsRows, capped, 'a hand-edited value is clamped on read too');
});

test('a late instance still reads the person s stored preferences', () => {
  const disk = mem();
  const a = createHubPrefs(scoped(disk, 'a'), createAppPrefs(disk));
  a.setFeedLevel('status');
  a.setStepsRows(7);
  a.setSidebarCollapsed(true);
  // A fresh owner, as a reload would build: the values come back off the disk.
  const later = createHubPrefs(scoped(disk, 'b'), createAppPrefs(disk));
  assert.equal(later.feedLevel, 'status');
  assert.equal(later.stepsRows, 7);
  assert.equal(later.sidebarCollapsed, true);
});

test('a rename follows the project on its own server only', () => {
  // The per-project maps are keyed by session name, so a rename has to move
  // every one of them or the room silently loses its lead and read marker.
  const disk = mem();
  const a = createHubPrefs(scoped(disk, 'a'));
  const b = createHubPrefs(scoped(disk, 'b'));
  for (const p of [a, b]) {
    p.setDraft('old', 'text');
    p.setLead('old', 'builder');
    p.setSeen('old', { seq: 5, ts: 50 });
    p.setDrawer('old', 'board');
    p.setRosterExpanded('old', true);
    p.setProject('old');
  }

  a.renameSession('old', 'new');
  assert.equal(a.draft('new'), 'text');
  assert.equal(a.draft('old'), '');
  assert.equal(a.lead('new'), 'builder');
  assert.deepEqual(a.seen('new'), { seq: 5, ts: 50 });
  assert.equal(a.drawer('new'), 'board');
  assert.equal(a.rosterExpanded('new'), true);
  assert.equal(a.project, 'new', 'the open project follows its own rename');

  // B has its own project called `old` and it did not move.
  assert.equal(b.draft('old'), 'text');
  assert.equal(b.draft('new'), '');
  assert.equal(b.project, 'old');
});

test('an empty draft leaves no row behind, per server', () => {
  // Called as the user types, so an empty draft REMOVES its key rather than
  // storing '' — otherwise every project ever visited leaves a row.
  const disk = mem();
  const a = createHubPrefs(scoped(disk, 'a'));
  const b = createHubPrefs(scoped(disk, 'b'));
  a.setDraft('app', 'typing');
  b.setDraft('app', 'typing');
  a.setDraft('app', '');
  assert.deepEqual(JSON.parse(disk.getItem('tmux_hub_drafts::a')!), {});
  assert.deepEqual(JSON.parse(disk.getItem('tmux_hub_drafts::b')!), { app: 'typing' });
});

test('a first visit to a server inherits nothing', () => {
  const disk = mem();
  const a = createHubPrefs(scoped(disk, 'a'));
  a.setDraft('app', 'text');
  a.setLead('app', 'builder');
  a.setProject('app');

  const fresh = createHubPrefs(scoped(disk, 'new-server'));
  assert.equal(fresh.draft('app'), '');
  assert.equal(fresh.lead('app'), null, 'nobody has chosen a lead there');
  assert.equal(fresh.project, '');
  assert.equal(fresh.drawer('app'), '');
  assert.equal(fresh.rosterExpanded('app'), false);
});
