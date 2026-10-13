// The bell's union (board #335 ③c-4).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { CentreSource } from './centre-union.svelte.ts';
import type { Alert } from '../hub/notify-centre.svelte.ts';
(globalThis as { $state?: unknown }).$state = (v: unknown) => v;
const { createCentreUnion, unionAlerts, activeOwners } = await import('./centre-union.svelte.ts');
const { createAlertLog, createCentreSurface } = await import('../hub/notify-centre.svelte.ts');

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const alert = (server: string, id: string, ts: number, viewed = false): Alert => ({
  key: `proj:app|${id}`, server, room: 'proj:app', session: 'app', project: 'app', seq: Number(id), id, ts, from: 'dev', toHuman: true, kind: 'reply', excerpt: `m${id}`, viewed,
});
function world(opts: { bAvailable?: boolean } = {}) {
  const a = createAlertLog(mem()), b = createAlertLog(mem());
  a.record(alert('a', '1', 100)); a.record(alert('a', '3', 300));
  b.record(alert('b', '2', 200)); b.record(alert('b', '4', 400, true));
  const sources: CentreSource[] = [
    { serverId: 'a', name: 'alpha', order: 0, log: a, available: true },
    { serverId: 'b', name: 'beta', order: 1, log: b, available: opts.bAvailable ?? true },
  ];
  const surface = createCentreSurface();
  return { a, b, sources, union: createCentreUnion(() => sources, surface) };
}

test('unionAlerts: newest first across servers, each row tagged when more than one server is in the SET, ties by saved order', () => {
  const { sources } = world();
  assert.deepEqual(unionAlerts(sources).map((r) => `${r.server}:${r.id}:${r.tag}`), ['b:4:beta', 'a:3:alpha', 'b:2:beta', 'a:1:alpha']);
  assert.deepEqual(unionAlerts([sources[0]!]).map((r) => r.tag), [null, null], 'one server: no tag');
  // Same ts: saved order breaks the tie, stably.
  const tie: CentreSource[] = [
    { serverId: 'b', name: 'beta', order: 1, log: { items: [alert('b', '7', 700)], unviewed: 1 } as never, available: true },
    { serverId: 'a', name: 'alpha', order: 0, log: { items: [alert('a', '7', 700)], unviewed: 1 } as never, available: true },
  ];
  assert.deepEqual(unionAlerts(tie).map((r) => r.server), ['a', 'b']);
  // A source with no log (never joined) contributes nothing and breaks nothing.
  assert.equal(unionAlerts([...sources, { serverId: 'c', name: 'c', order: 2, log: null, available: false }]).length, 4);
});

test('the union counts only AVAILABLE sources unviewed; viewed/failed reach the source list; Clear clears available lists only (D6)', () => {
  const w = world({ bAvailable: false });
  assert.equal(w.union.unviewed, 2, 'A s two unviewed; B s unavailable list is not counted');
  assert.deepEqual(w.union.items.filter((r) => r.unavailable).map((r) => r.id), ['4', '2'], 'B s rows shown, marked unavailable');
  w.union.viewed(alert('a', '1', 100));
  assert.equal(w.a.items.find((x) => x.id === '1')?.viewed, true, 'viewed reached A s list');
  assert.equal(w.b.items.find((x) => x.id === '2')?.viewed, false, 'not B s');
  w.union.failed(alert('b', '2', 200), 'gone');
  assert.equal(w.b.items.find((x) => x.id === '2')?.failed, 'gone', 'failed reached B s list');
  assert.equal(w.union.clearable, true, 'A has entries to clear');
  w.union.clear();
  assert.deepEqual(w.a.items, [], 'A cleared');
  assert.equal(w.b.items.length, 2, 'B untouched');
  assert.equal(w.b.items.filter((x) => !x.viewed).length, 1, 'and not marked read');
  assert.equal(w.union.clearable, false, 'nothing clearable left: only the unavailable list remains');
  assert.equal(w.union.items.length, 2, 'which is still shown');
});

test('the union is the window s one surface: anchor, jump and consume are the shared surface s', () => {
  const w = world();
  const el = {} as HTMLElement;
  w.union.toggle(el);
  assert.equal(w.union.anchor, el);
  w.union.requestJump(alert('b', '2', 200));
  assert.equal(w.union.jump?.alert.server, 'b');
  const n = w.union.jump!.n;
  assert.equal(w.union.isCurrent(n), true);
  w.union.consume(n);
  assert.equal(w.union.jump, null);
  w.union.close();
  assert.equal(w.union.anchor, null);
});

test('activeOwners: the focus owns its id; a published member owns over an orphan of the same id, whatever the array order (P1-C3 (c))', () => {
  const focus = { id: 'a', tag: 'focus' };
  const oldC = { id: 'c', tag: 'orphan' }, freshC = { id: 'c', tag: 'fresh' }, b = { id: 'b', tag: 'b' };
  const orphan = (r: { tag: string }) => r.tag === 'orphan';
  // Orphan first, fresh later — and the reverse.
  assert.equal(activeOwners(focus, [oldC, b, freshC], orphan).get('c'), freshC, 'the fresh runtime is the owner, not the last pushed');
  assert.equal(activeOwners(focus, [freshC, b, oldC], orphan).get('c'), freshC, 'and not the first pushed');
  assert.equal(activeOwners(focus, [oldC], orphan).get('c'), oldC, 'an orphan alone still owns its index (shown unavailable)');
  // The focus wins over a member of the same id (a stale member handle).
  const staleA = { id: 'a', tag: 'stale' };
  assert.equal(activeOwners(focus, [staleA], () => false).get('a'), focus);
  assert.equal(activeOwners(null, [b], () => false).get('a'), undefined, 'no focus: nothing invented');
});
