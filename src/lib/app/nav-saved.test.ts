// The saved nav state across the v1 → v2 change (board #335 ②b-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_NAV, NAV_KEY, navFor, readLegacyNav, saveNav, type SavedNav } from './nav-saved.ts';
import { paneRef } from './refs.ts';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem(k: string, v: string) { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    raw: () => m.get(NAV_KEY),
  };
}

const v1 = (over: Record<string, unknown> = {}) => mem({
  [NAV_KEY]: JSON.stringify({
    page: 'terminal', terminalTarget: 'work:1.0', terminalSession: 'work', ...over,
  }),
});

test('a v1 record belongs to the server that owned the live keys', () => {
  const nav = readLegacyNav(v1(), 'a');
  assert.deepEqual(nav.pane, paneRef('a', 'work', 'work:1.0'));
  assert.equal(nav.page, 'terminal');
});

test('a legacy record is only ever attributed to the owner it is GIVEN', () => {
  // The rule is about where the record was read and what the caller could
  // establish, never about who happens to be current now: a deep link
  // activates B before anything restores, so filing A's panes under B is the
  // bug this shape exists to make unwritable. With nothing established, the
  // record is unattributed and nothing of it is restored — it stays for a
  // server that can prove it later (②b-4), rather than going to whoever
  // authenticates next.
  const a = readLegacyNav(v1(), 'a');
  const b = readLegacyNav(v1(), 'b');
  assert.equal(a.pane?.serverId, 'a');
  assert.equal(b.pane?.serverId, 'b', 'the function attributes what it is told');
  // And the proof that it decides nothing by itself: with no owner the panes
  // are dropped rather than filed under whoever asks.
  const none = readLegacyNav(v1(), '');
  assert.equal(none.pane, null, 'nothing to attribute means nothing restored');
  assert.equal(none.page, 'terminal', 'the tab is not a server s, so it survives');
  assert.deepEqual(none.splitCells, []);
  assert.equal(none.splitLayout, 1);
});

test('a v1 split restores its cells under the same owner', () => {
  const storage = v1({
    splitLayout: 2,
    splitCells: [{ id: 3, target: 'work:1.0', session: 'work' }, { id: 4, target: '', session: '' }],
  });
  const nav = readLegacyNav(storage, 'a');
  assert.equal(nav.splitLayout, 2);
  assert.deepEqual(nav.splitCells, [
    { id: 3, pane: paneRef('a', 'work', 'work:1.0') },
    { id: 4, pane: null },
  ]);
});

test('a v2 record carries its own server, and survives a round trip', () => {
  const storage = mem();
  const nav: SavedNav = {
    page: 'terminal',
    pane: paneRef('b', 'work', 'work:2.1'),
    splitLayout: 2,
    splitCells: [{ id: 1, pane: paneRef('b', 'work', 'work:2.1') }, { id: 2, pane: null }],
  };
  saveNav(storage, nav);
  // The owner argument is ignored: a v2 record knows whose it is, whatever the
  // caller believes.
  assert.deepEqual(readLegacyNav(storage, 'a'), nav);
  assert.match(storage.raw()!, /"v":2/u);
});

test('the restore keeps only the server it is running against', () => {
  // One runtime resolves the restore, and a pane on another server cannot be
  // captured over that connection — in the worst case the other server HAS a
  // pane by that name, and the reader lands on a stranger's terminal.
  const nav: SavedNav = {
    page: 'terminal',
    pane: paneRef('b', 'work', 'work:2.1'),
    splitLayout: 2,
    splitCells: [{ id: 1, pane: paneRef('a', 'work', 'work:1.0') }, { id: 2, pane: paneRef('b', 'work', 'work:2.1') }],
  };
  const mineA = navFor(nav, 'a');
  assert.equal(mineA.pane, null, 'B s pane is not restored on A');
  assert.deepEqual(mineA.splitCells, [
    { id: 1, pane: paneRef('a', 'work', 'work:1.0') },
    { id: 2, pane: null },
  ], 'a foreign cell empties and keeps its place, so the split keeps its shape');
  assert.equal(mineA.splitLayout, 2);
  assert.equal(mineA.page, 'terminal', 'the tab is the person s, not the server s');
});

test('storage is untrusted: junk is dropped, never repaired', () => {
  assert.deepEqual(readLegacyNav(mem({ [NAV_KEY]: 'not json' }), 'a'), EMPTY_NAV);
  assert.deepEqual(readLegacyNav(mem(), 'a'), EMPTY_NAV);
  assert.deepEqual(readLegacyNav(mem({ [NAV_KEY]: '"a string"' }), 'a'), EMPTY_NAV);
  // A v2 record whose pane is not a pane ref at all.
  const bad = mem({ [NAV_KEY]: JSON.stringify({ v: 2, page: 'files', pane: { kind: 'session', serverId: 'a', session: 'work' } }) });
  assert.equal(readLegacyNav(bad, 'a').pane, null);
  // A target with no session field falls back to the session the TARGET
  // names, because the target is what tmux resolves.
  const noSession = mem({ [NAV_KEY]: JSON.stringify({ page: 'terminal', terminalTarget: 'work:1.0' }) });
  assert.deepEqual(readLegacyNav(noSession, 'a').pane, paneRef('a', 'work', 'work:1.0'));
  // Cells that are not objects still hold their place by index.
  const cells = mem({ [NAV_KEY]: JSON.stringify({ v: 2, splitLayout: 2, splitCells: [null, { id: 7, pane: null }] }) });
  assert.deepEqual(readLegacyNav(cells, 'a').splitCells, [{ id: 0, pane: null }, { id: 7, pane: null }]);
});
