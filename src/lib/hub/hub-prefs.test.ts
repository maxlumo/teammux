// Unit tests for hub-prefs.svelte.ts — the runes module runs under node with
// the `$state` shim (docs/conventions/testing.md) and an in-memory localStorage.
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
const writes: string[] = [];
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { writes.push(k); store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).$state = (v: unknown) => v;

const { createHubPrefs } = await import('./hub-prefs.svelte.ts');
// One server's prefs over this storage, as App builds a runtime's (②b-2-1).
const hubPrefs = createHubPrefs(localStorage);

test('the lead has three states: a name, the ROOM (empty string), and nobody chose (null)', () => {
  // Review C (2026-09-03): '' used to be stored as an ABSENT key, so choosing
  // "send to the room" was indistinguishable from never having chosen, and the
  // next roster poll re-seated a lead the user had just dismissed.
  assert.equal(hubPrefs.lead('proj-a'), null, 'nobody chose yet');
  hubPrefs.setLead('proj-a', 'dev');
  assert.equal(hubPrefs.lead('proj-a'), 'dev');
  hubPrefs.setLead('proj-a', '');
  assert.equal(hubPrefs.lead('proj-a'), '', 'the room is a real, remembered choice');
  assert.equal(JSON.parse(store.get('tmux_hub_lead')!)['proj-a'], '', 'and it is persisted as such');
  hubPrefs.clearLead('proj-a');
  assert.equal(hubPrefs.lead('proj-a'), null, 'cleared = back to nobody chose');
  assert.ok(!('proj-a' in JSON.parse(store.get('tmux_hub_lead')!)), 'a cleared project leaves no row');
});

test('renameSession carries the lead — including the room choice — onto the new session name', () => {
  hubPrefs.setLead('old', '');
  hubPrefs.setLead('other', 'qa');
  hubPrefs.renameSession('old', 'new');
  assert.equal(hubPrefs.lead('old'), null);
  assert.equal(hubPrefs.lead('new'), '', 'the room choice survives the rename');
  assert.equal(hubPrefs.lead('other'), 'qa', 'unrelated projects untouched');
});

const ROSTER_KEY = 'tmux_hub_roster_expanded';
let moduleVersion = 0;
async function freshPrefs(): Promise<typeof hubPrefs> {
  // A fresh module AND a fresh instance: the real localStorage read on reload,
  // through the factory App builds each runtime's prefs with.
  const fresh = await import(new URL(`./hub-prefs.svelte.ts?roster=${++moduleVersion}`, import.meta.url).href);
  return fresh.createHubPrefs(localStorage, fresh.createAppPrefs(localStorage));
}

test('roster expansion is per session and survives a fresh-module reload (#168)', async () => {
  store.clear();
  const prefs = await freshPrefs();
  assert.equal(prefs.rosterExpanded('alpha'), false);
  assert.equal(prefs.rosterExpanded('beta'), false);
  prefs.setRosterExpanded('alpha', true);
  assert.equal(prefs.rosterExpanded('alpha'), true);
  assert.equal(prefs.rosterExpanded('beta'), false);
  assert.deepEqual(JSON.parse(store.get(ROSTER_KEY)!), { alpha: true });

  const reloaded = await freshPrefs();
  assert.equal(reloaded.rosterExpanded('alpha'), true);
  assert.equal(reloaded.rosterExpanded('beta'), false);
  reloaded.setRosterExpanded('beta', true);
  reloaded.setRosterExpanded('alpha', false);
  assert.equal(reloaded.rosterExpanded('alpha'), false);
  assert.equal(reloaded.rosterExpanded('beta'), true);
  assert.deepEqual(JSON.parse(store.get(ROSTER_KEY)!), { beta: true }, 'collapsed sessions leave no entry');
  const collapsed = await freshPrefs();
  assert.equal(collapsed.rosterExpanded('alpha'), false);
  assert.equal(collapsed.rosterExpanded('beta'), true);
});

test('empty sessions do not write roster preferences and only true expands (#168)', async () => {
  store.clear();
  store.set(ROSTER_KEY, JSON.stringify({ alpha: true, beta: false, invalid: 'true', '': true }));
  const prefs = await freshPrefs();
  assert.equal(prefs.rosterExpanded('alpha'), true);
  assert.equal(prefs.rosterExpanded('beta'), false);
  assert.equal(prefs.rosterExpanded('invalid'), false);
  assert.equal(prefs.rosterExpanded(''), false);
  const saved = store.get(ROSTER_KEY);
  writes.length = 0;
  prefs.setRosterExpanded('', true);
  prefs.setRosterExpanded('', false);
  assert.deepEqual(writes, []);
  assert.equal(store.get(ROSTER_KEY), saved);
});

test('renameSession moves and persists roster expansion exactly once (#168)', async () => {
  store.clear();
  const prefs = await freshPrefs();
  prefs.setRosterExpanded('old', true);
  prefs.setRosterExpanded('other', true);
  prefs.setDrawer('old', 'files');
  prefs.setLead('old', '');
  prefs.setSeen('old', { seq: 7, ts: 123 });
  prefs.setDraft('old', 'draft');
  prefs.setProject('old');
  writes.length = 0;
  prefs.renameSession('old', 'new');
  assert.equal(writes.filter(key => key === ROSTER_KEY).length, 1);
  assert.deepEqual(JSON.parse(store.get(ROSTER_KEY)!), { other: true, new: true });
  assert.equal(prefs.rosterExpanded('old'), false);
  assert.equal(prefs.rosterExpanded('new'), true);
  assert.equal(prefs.rosterExpanded('other'), true);
  assert.equal(prefs.drawer('new'), 'files');
  assert.equal(prefs.lead('new'), '');
  assert.deepEqual(prefs.seen('new'), { seq: 7, ts: 123 });
  assert.equal(prefs.draft('new'), 'draft');
  assert.equal(prefs.project, 'new');
  const reloaded = await freshPrefs();
  assert.equal(reloaded.rosterExpanded('old'), false);
  assert.equal(reloaded.rosterExpanded('new'), true);
  assert.equal(reloaded.rosterExpanded('other'), true);
  writes.length = 0;
  reloaded.renameSession('', 'new');
  reloaded.renameSession('new', '');
  reloaded.renameSession('new', 'new');
  assert.deepEqual(writes, [], 'invalid and identity renames remain no-ops');
});

test('the sidebar collapse is one app-wide switch: persisted, default open, untouched by a project rename (board #174)', async () => {
  const prefs = await freshPrefs();
  assert.equal(prefs.sidebarCollapsed, false, 'open by default — the project list is the desktop map');
  writes.length = 0;
  prefs.setSidebarCollapsed(true);
  assert.equal(prefs.sidebarCollapsed, true);
  assert.deepEqual(writes, ['tmux_hub_sidebar']);
  assert.equal(store.get('tmux_hub_sidebar'), '1');
  const reloaded = await freshPrefs();
  assert.equal(reloaded.sidebarCollapsed, true, 'survives a reload');
  writes.length = 0;
  reloaded.renameSession('alpha', 'beta');
  assert.equal(reloaded.sidebarCollapsed, true);
  assert.ok(!writes.includes('tmux_hub_sidebar'), 'not a per-project preference');
  reloaded.setSidebarCollapsed(false);
  assert.equal(store.get('tmux_hub_sidebar'), '0');
});

test('the read mark is a seq + ts; a legacy bare ts reads as seq 0 (#322)', async () => {
  store.clear();
  store.set('tmux_hub_seen', JSON.stringify({ old: 500 }));
  const prefs = await freshPrefs();
  assert.deepEqual(prefs.seen('old'), { seq: 0, ts: 500 });
  assert.deepEqual(prefs.seen('none'), { seq: 0, ts: 0 });
  prefs.setSeen('old', { seq: 42, ts: 600 });
  assert.deepEqual(JSON.parse(store.get('tmux_hub_seen')!), { old: { seq: 42, ts: 600 } });
  assert.deepEqual(prefs.seen('old'), { seq: 42, ts: 600 });
});
