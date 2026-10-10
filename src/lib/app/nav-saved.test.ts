// The saved nav state across the v1 → v2 change (board #335 ②b-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_NAV, NAV_KEY, QUARANTINE_KEY, navFor, quarantineLegacyNav, readLegacyNav, reownSavedNav, saveNav, type SavedNav } from './nav-saved.ts';
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

test('an input nobody owns is copied aside, once, with its evidence', () => {
  // `readLegacyNav` returning no panes preserves nothing: the shell saves its
  // own navigation over the same key as soon as it comes up (reviewer P1-c).
  const storage = mem({
    [NAV_KEY]: '{"page":"terminal","terminalTarget":"work:1.0"}',
    tmux_machine_id: 'm-old',
  });
  assert.equal(quarantineLegacyNav(storage), true);
  const kept = JSON.parse(storage.getItem(QUARANTINE_KEY)!);
  assert.equal(kept.raw, '{"page":"terminal","terminalTarget":"work:1.0"}');
  assert.equal(kept.machineId, 'm-old', 'the evidence ②b-4 needs to let a server claim it');
  assert.ok(typeof kept.at === 'number');
  // The live key stays writable: what is preserved is the copy.
  assert.ok(storage.getItem(NAV_KEY));

  // The FIRST one wins — a later boot must not overwrite the original with
  // whatever the shell has written since.
  storage.setItem(NAV_KEY, '{"v":2,"page":"hub","pane":null,"splitLayout":1,"splitCells":[]}');
  assert.equal(quarantineLegacyNav(storage), false);
  assert.equal(JSON.parse(storage.getItem(QUARANTINE_KEY)!).raw,
    '{"page":"terminal","terminalTarget":"work:1.0"}');

  // Nothing to keep is not a failure.
  assert.equal(quarantineLegacyNav(mem()), false);
});

test('a record this build does not understand is junk, not a v1 record', () => {
  // Guessing at a newer layout is how it gets misread (reviewer P2).
  const future = mem({ [NAV_KEY]: JSON.stringify({ v: 3, page: 'files', pane: { kind: 'pane', serverId: 'a', session: 'w', target: 'w:1.0' } }) });
  assert.deepEqual(readLegacyNav(future, 'a'), EMPTY_NAV);
});

test('a record that disagrees with itself is refused, not repaired', () => {
  // The target is what tmux resolves; a `session` that is not its prefix means
  // the two were written by different things.
  const mismatch = mem({ [NAV_KEY]: JSON.stringify({ page: 'terminal', terminalTarget: 'work:1.0', terminalSession: 'other' }) });
  assert.equal(readLegacyNav(mismatch, 'a').pane, null);
  // An empty serverId is not an attribution.
  const unowned = mem({ [NAV_KEY]: JSON.stringify({ v: 2, pane: { kind: 'pane', serverId: '', session: 'w', target: 'w:1.0' } }) });
  assert.equal(readLegacyNav(unowned, 'a').pane, null);
});

test('a split restores as whole cells with distinct ids', () => {
  const storage = mem({ [NAV_KEY]: JSON.stringify({
    page: 'terminal',
    terminalTarget: 'work:1.0',
    splitLayout: 2.5,                       // not a whole count
    splitCells: [{ id: 3, target: 'work:1.0' }, { id: 3, target: 'work:2.0' }],
  }) });
  const nav = readLegacyNav(storage, 'a');
  assert.equal(nav.splitLayout, 1, 'a fractional layout is not a layout');
  assert.deepEqual(nav.splitCells.map((c) => c.id), [3, 0],
    'a duplicate id falls back to an id nobody is using');
  // The position is NOT a free slot (reviewer P2-b, 2026-10-10): `[1, 1]`
  // used to give the second cell position 1 — the id the first cell had just
  // claimed — and two cells with one id make the keyed list and
  // `activeCellId` disagree about which cell is which.
  const collide = mem({ [NAV_KEY]: JSON.stringify({
    v: 2, splitLayout: 3,
    splitCells: [{ id: 1, pane: null }, { id: 1, pane: null }, { id: 'x', pane: null }],
  }) });
  const ids = readLegacyNav(collide, 'a').splitCells.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, `every id is its own: ${ids.join(',')}`);
  assert.deepEqual(ids, [1, 0, 2], 'the given id is kept, the rest take the lowest free one');
});

test('a record written by an absorbed entry names the survivor', () => {
  // Identity repair folded alias A into canonical B and deleted A, so A's
  // v2 record names an id no entry claims any more — and `navFor(..., 'b')`
  // would drop the navigation of the machine the app is connected to
  // (reviewer P1, 2026-10-10).
  const storage = mem();
  saveNav(storage, {
    page: 'terminal',
    pane: paneRef('a', 'work', 'work:1.0'),
    splitLayout: 2,
    splitCells: [{ id: 0, pane: paneRef('a', 'work', 'work:1.0') }, { id: 1, pane: paneRef('a', 'work', 'work:2.0') }],
  });
  assert.equal(reownSavedNav(storage, new Set(['b']), 'b'), true);
  const nav = readLegacyNav(storage, '');
  assert.deepEqual(nav.pane, paneRef('b', 'work', 'work:1.0'));
  assert.deepEqual(nav.splitCells.map((c) => c.pane?.serverId), ['b', 'b'], 'the cells came too');
  assert.deepEqual(navFor(nav, 'b').splitCells.map((c) => c.pane?.target), ['work:1.0', 'work:2.0'],
    'and the restore for B keeps every pane');
});

test('a record whose server is still saved is left exactly as it is', () => {
  // Being another server's record is not being absorbed, and a v1 record owns
  // nothing to rewrite: its provenance is the caller's.
  const live = mem();
  saveNav(live, { page: 'terminal', pane: paneRef('b', 'work', 'work:1.0'), splitLayout: 1, splitCells: [] });
  const before = live.getItem(NAV_KEY);
  assert.equal(reownSavedNav(live, new Set(['a', 'b']), 'a'), false, 'B is saved, so B keeps its record');
  assert.equal(live.getItem(NAV_KEY), before, 'and the bytes are untouched');
  const legacy = mem({ [NAV_KEY]: '{"page":"terminal","terminalTarget":"work:1.0"}' });
  assert.equal(reownSavedNav(legacy, new Set(['b']), 'b'), false, 'a v1 record names no server');
  assert.equal(legacy.getItem(NAV_KEY), '{"page":"terminal","terminalTarget":"work:1.0"}');
  assert.equal(reownSavedNav(mem({ [NAV_KEY]: 'not json' }), new Set(['b']), 'b'), false);
});
