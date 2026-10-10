// One list over two servers (board #335 ②a-5), against the real ordering
// rules — the projects list's own `sortRows`/`projectUpdatedMs`, not a
// restatement of them. Nothing here touches a component: ②a's a5 is the
// projection and the ref outputs, and ②b wires the consumers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contributors, onRow, unionRows, type RowRuntime, type ServerSlice } from './server-union.ts';
import type { WsApi } from '../core/ws-api.ts';
import { issueRef, projectRef, refKey, sessionRef } from './refs.ts';
import { compareRows, compareRowsWithClock, projectUpdatedMs, sortRows, type Project, type ProjectRow } from '../projects/projects.ts';

const project = (over: Partial<Project> & { id: string; session: string }): Project => ({
  name: over.session, path: `/srv/${over.session}`, adopted: false, autostart: false,
  created_at: 0, archived: false, ...over,
});
const row = (id: string, session: string, over: Partial<Project> & { live?: boolean } = {}): ProjectRow => {
  const { live = false, ...rest } = over;
  return { project: project({ id, session, ...rest }), slots: [], live };
};

const slice = <T,>(serverId: string, order: number, items: T[], over: Partial<ServerSlice<T>> = {}): ServerSlice<T> =>
  ({ serverId, name: serverId.toUpperCase(), order, ok: true, items, ...over });

/**
 * The real Projects adapter: the domain's own source-qualified comparator,
 * reached with EACH server's own room clock. `talkBy` is serverId → that
 * server's `hub_rooms` answer, because a room id is unique only within a
 * server — one shared map cannot say that `proj:app` is busy on B and quiet
 * on A.
 */
const projectSpec = (talkBy: Record<string, Record<string, number>> = {}) => ({
  ref: (serverId: string, r: ProjectRow) => projectRef(serverId, r.project.id),
  compare: (a: { serverId: string; item: ProjectRow }, b: { serverId: string; item: ProjectRow }) =>
    compareRowsWithClock(
      { row: a.item, talk: talkBy[a.serverId] ?? {} },
      { row: b.item, talk: talkBy[b.serverId] ?? {} },
    ),
});

test('one server contributing is that server s list, untagged', () => {
  // The Single-mode shape: same order, no tag column, nothing to explain.
  const rows = [row('p1', 'alpha', { live: true }), row('p2', 'beta')];
  const union = unionRows([slice('a', 0, sortRows(rows))], projectSpec());
  assert.deepEqual(union.rows.map((r) => r.item.project.id), ['p1', 'p2']);
  assert.deepEqual(union.rows.map((r) => r.tag), [null, null], 'nothing to tell apart');
  assert.deepEqual(union.missing, []);
});

test('ONE server s order is never changed, whatever the comparator says', () => {
  // The P1 this replaces a `rank` for. `projectUpdatedMs` falls back to
  // `last_seen_at`, which `sortRows` deliberately ignores because the capturer
  // rewrites it every tick — so the two clocks DISAGREE, and a union that
  // ranked rows itself reordered a single server's list.
  const stale = row('p1', 'stale', { last_up_at: 100, last_seen_at: 9_000 });
  const recent = row('p2', 'recent', { last_up_at: 500, last_seen_at: 500 });
  // The two clocks really do disagree on this pair.
  const byUpdated = [stale, recent].slice().sort((a, b) => projectUpdatedMs(b) - projectUpdatedMs(a));
  const bySortRows = sortRows([stale, recent]);
  assert.notDeepEqual(byUpdated.map((r) => r.project.id), bySortRows.map((r) => r.project.id),
    'the fixture is only meaningful if the two clocks differ');

  const union = unionRows([slice('a', 0, bySortRows)], projectSpec());
  assert.deepEqual(union.rows.map((r) => r.item.project.id), bySortRows.map((r) => r.project.id),
    'the union hands back exactly what the domain ordered');

  // And it holds for ANY given order, because a merge of one list cannot
  // reorder it — even an order the comparator would not have produced.
  const reversed = [...bySortRows].reverse();
  assert.deepEqual(
    unionRows([slice('a', 0, reversed)], projectSpec()).rows.map((r) => r.item.project.id),
    reversed.map((r) => r.project.id),
    'a merge of one list is that list, by construction');
});

test('two servers interleave by the projects list s own rule', () => {
  // Open first, then by activity, newest first — and across servers, not
  // server by server. The comparator is projects.ts's own.
  const talkA = { 'proj:a-chat': 3000 };
  const talkB = { 'proj:b-chat': 5000 };
  const a = [row('a1', 'a-open', { live: true }), row('a2', 'a-chat')];
  const b = [row('b1', 'b-open', { live: true }), row('b2', 'b-chat')];
  const union = unionRows(
    [slice('a', 0, sortRows(a, talkA)), slice('b', 1, sortRows(b, talkB))],
    projectSpec({ a: talkA, b: talkB }),
  );
  assert.deepEqual(union.rows.map((r) => `${r.serverId}:${r.item.project.id}`),
    ['a:a1', 'b:b1', 'b:b2', 'a:a2'],
    'both open rows first, then the busier chat, whichever server it is on');
});

test('equal rows fall in saved-server order, stably', () => {
  // Two servers whose rows rank identically must not flicker with whichever
  // answered first; the registry order decides, every render.
  const a = [row('a1', 'same'), row('a2', 'same-too')];
  const b = [row('b1', 'same'), row('b2', 'same-too')];
  const first = unionRows([slice('b', 1, b), slice('a', 0, a)], projectSpec());
  const second = unionRows([slice('a', 0, a), slice('b', 1, b)], projectSpec());
  const ids = (u: typeof first) => u.rows.map((r) => `${r.serverId}:${r.item.project.id}`);
  assert.deepEqual(ids(first), ids(second), 'the slice argument order changes nothing');
  assert.deepEqual(ids(first), ['a:a1', 'a:a2', 'b:b1', 'b:b2']);
});

test('one server failing leaves the other s list whole, and still says whose it is', () => {
  // Two failures in one: a shorter list with no explanation, and — the P1 —
  // the source tag vanishing because only one server answered. In Aggregate
  // mode with A and B included, B dropping must not make A's rows stop saying
  // they are A's. The tag follows the SOURCE SET, not the answer count.
  const a = [row('a1', 'alpha', { live: true })];
  const union = unionRows(
    [slice('a', 0, a), slice('b', 1, [] as ProjectRow[], { ok: false })],
    projectSpec(),
  );
  assert.deepEqual(union.rows.map((r) => r.item.project.id), ['a1']);
  assert.deepEqual(union.missing, ['b']);
  assert.deepEqual(union.rows.map((r) => r.tag), ['A'],
    'B is still one of this list s servers, so A s rows are still labelled');
});

test('the mode can decide the tag outright', () => {
  // Where the MODE rather than the count is what matters, ②b says so.
  const a = [row('a1', 'alpha')];
  const forced = unionRows([slice('a', 0, a)], { ...projectSpec(), showSource: true });
  assert.deepEqual(forced.rows.map((r) => r.tag), ['A'], 'Aggregate with one server still labels');
  const hidden = unionRows(
    [slice('a', 0, a), slice('b', 1, [row('b1', 'beta')])],
    { ...projectSpec(), showSource: false },
  );
  assert.deepEqual(hidden.rows.map((r) => r.tag), [null, null], 'and a view may suppress it');
});

test('the busier of two IDENTICAL projects wins, measured on its own server', () => {
  // The reviewer's counter-example, and the reason the comparator takes the
  // source. A and B each have a project that is identical in every field —
  // same id, session, room, up/created — so the ONLY thing that can order
  // them is each server's own room clock. A single shared room→ts map cannot
  // even express the difference: both rooms are called `proj:app`.
  // The activity floor is `last_up_at * 1000` (rows are seconds, the bus is
  // ms), so the clocks have to be ABOVE it or they decide nothing — the first
  // version of this fixture used talk=1000/9000 against a 100s up time and
  // both sides came out equal, which proved nothing.
  const upSec = 100;
  const floorMs = upSec * 1000;
  const quiet = floorMs + 1_000;
  const busy = floorMs + 9_000;
  const same = () => row('p1', 'app', { last_up_at: upSec, created_at: upSec });
  const slices = [slice('a', 0, [same()]), slice('b', 1, [same()])];

  // B is busier, AND it is later in the saved order — so a correct answer has
  // to override the tie-break, not fall back to it.
  const bBusier = unionRows(slices, projectSpec({
    a: { 'proj:app': quiet },
    b: { 'proj:app': busy },
  }));
  assert.deepEqual(bBusier.rows.map((r) => r.serverId), ['b', 'a'],
    'B talked more recently, so B heads the list despite being the later server');

  // Swap the clocks and the order swaps with them.
  const aBusier = unionRows(slices, projectSpec({
    a: { 'proj:app': busy },
    b: { 'proj:app': quiet },
  }));
  assert.deepEqual(aBusier.rows.map((r) => r.serverId), ['a', 'b']);

  // With no clocks at all they are genuinely equal, and only then does the
  // saved order decide.
  assert.deepEqual(unionRows(slices, projectSpec()).rows.map((r) => r.serverId), ['a', 'b']);
  // And the one shared map the old adapter closed over cannot express this at
  // all: both rooms are `proj:app`, so whatever it holds, the two rows read
  // the same activity and fall back to the saved order.
  const shared = { 'proj:app': busy };
  const bothFromOneMap = unionRows(slices, {
    ref: (serverId: string, r: ProjectRow) => projectRef(serverId, r.project.id),
    compare: (x, y) => compareRowsWithClock({ row: x.item, talk: shared }, { row: y.item, talk: shared }),
  });
  assert.deepEqual(bothFromOneMap.rows.map((r) => r.serverId), ['a', 'b'],
    'one room map makes the busier server invisible — which is the bug');
});

test('each server s own list keeps its own order while they interleave', () => {
  // The same collision inside each server: two projects called `app` and
  // `app-2` on both machines, ordered differently on each by their own clock.
  // The union must interleave them without disturbing either sequence.
  const talkA = { 'proj:app': 9_000_000, 'proj:app-2': 1_000_000 };
  const talkB = { 'proj:app': 2_000_000, 'proj:app-2': 8_000_000 };
  const rows = () => [row('p1', 'app'), row('p2', 'app-2')];
  const a = sortRows(rows(), talkA);
  const b = sortRows(rows(), talkB);
  assert.deepEqual(a.map((r) => r.project.session), ['app', 'app-2'], 'A s own order');
  assert.deepEqual(b.map((r) => r.project.session), ['app-2', 'app'], 'B s own order, the other way');

  const union = unionRows([slice('a', 0, a), slice('b', 1, b)], projectSpec({ a: talkA, b: talkB }));
  assert.deepEqual(union.rows.map((r) => `${r.serverId}:${r.item.project.session}`),
    ['a:app', 'b:app-2', 'b:app', 'a:app-2'],
    'interleaved by activity across servers, each server s sequence intact');
  // And each server's rows appear in exactly the order that server gave.
  for (const [id, own] of [['a', a], ['b', b]] as const) {
    assert.deepEqual(
      union.rows.filter((r) => r.serverId === id).map((r) => r.item.project.session),
      own.map((r) => r.project.session),
      `${id} s sequence is untouched`);
  }
});

test('a server that has not answered yet is simply absent', () => {
  // Independent arrival: the list is complete for the servers that have
  // answered, and grows when the next one does.
  const a = [row('a1', 'alpha')];
  const b = [row('b1', 'beta')];
  const early = unionRows([slice('a', 0, a)], projectSpec());
  assert.deepEqual(early.rows.map((r) => r.serverId), ['a']);
  assert.deepEqual(early.missing, [], 'not answered yet is not a failure');
  const later = unionRows([slice('a', 0, a), slice('b', 1, b)], projectSpec());
  assert.deepEqual(later.rows.map((r) => r.serverId), ['a', 'b']);
});

test('same-named objects on two servers are different rows with different keys', () => {
  // The collision the whole phase exists for: a project called `app` on both
  // machines. Two rows, two keys, two refs — and each ref names its own
  // server, which is where ②b's row action gets its runtime.
  const a = [row('p1', 'app')];
  const b = [row('p1', 'app')];                       // same project id, too
  const union = unionRows([slice('a', 0, a), slice('b', 1, b)], projectSpec());
  assert.equal(union.rows.length, 2);
  const [first, second] = union.rows;
  assert.notEqual(first!.key, second!.key, 'the {#each} keys cannot collide');
  assert.equal(first!.key, refKey(projectRef('a', 'p1')));
  assert.equal(second!.ref.serverId, 'b');
  assert.deepEqual(union.rows.map((r) => r.tag), ['A', 'B'], 'and both rows say which server');
});

test('the tag appears only when more than one server contributes', () => {
  const a = [row('a1', 'alpha')];
  const b = [row('b1', 'beta')];
  // An empty but live slice still counts: its server is on screen, so the
  // list does not grow a tag the moment that server's first row arrives.
  const withEmpty = unionRows([slice('a', 0, a), slice('b', 1, [] as ProjectRow[])], projectSpec());
  assert.deepEqual(withEmpty.rows.map((r) => r.tag), ['A']);
  const alone = unionRows([slice('a', 0, a)], projectSpec());
  assert.deepEqual(alone.rows.map((r) => r.tag), [null], 'one server in the list, no tag');
  const both = unionRows([slice('a', 0, a), slice('b', 1, b)], projectSpec());
  assert.deepEqual(both.rows.map((r) => r.tag), ['A', 'B']);
});

test('without a comparator each server s given order is kept', () => {
  // A list whose order IS the server's answer — tmux's session order. The
  // union must not reorder it, only interleave by server.
  const union = unionRows(
    [slice('a', 0, ['s2', 's1']), slice('b', 1, ['s9', 's3'])],
    { ref: (serverId, name: string) => sessionRef(serverId, name) },
  );
  assert.deepEqual(union.rows.map((r) => `${r.serverId}:${r.item}`),
    ['a:s2', 'a:s1', 'b:s9', 'b:s3']);
});

test('it projects any ref kind, with session-local ids kept apart', () => {
  // Board issue #3 of `app` on A is not #3 of `app` on B — the id is
  // session-local, so only the ref keeps them apart.
  const union = unionRows(
    [slice('a', 0, [3, 7]), slice('b', 1, [3])],
    { ref: (serverId, id: number) => issueRef(serverId, 'app', id) },
  );
  assert.equal(new Set(union.rows.map((r) => r.key)).size, 3, 'three distinct issues');
  assert.deepEqual(union.rows.map((r) => `${r.serverId}#${r.item}`), ['a#3', 'a#7', 'b#3']);
});

test('contributors are listed in saved-server order, failures included', () => {
  // What a per-server header or an "unreachable" notice reads.
  const slices = [
    slice('b', 1, [] as ProjectRow[], { ok: false }),
    slice('a', 0, [row('a1', 'alpha')]),
  ];
  assert.deepEqual(contributors(slices).map((s) => `${s.serverId}:${s.ok}`), ['a:true', 'b:false']);
});

// ── Row actions (board #335 ②b-1-3) ─────────────────────────────────────
// A union list has no owner a component could read from its context, so a
// row action takes its runtime from the CLICKED row's ref. These run the
// action through two runtimes whose apis record every call, which is what
// "B's click reaches B and nothing else" has to mean.


/** A runtime double whose api records each call as `<server>:<method>:<arg>`. */
function runtimeFor(id: string, sent: string[], alive = () => true): RowRuntime {
  const api = { killSession: async (name: string) => { sent.push(`${id}:kill_session:${name}`); } } as unknown as WsApi;
  return { api, alive };
}

test('a row action runs on the server its row came from, and only there', async () => {
  const sent: string[] = [];
  const fleet = new Map([['a', runtimeFor('a', sent)], ['b', runtimeFor('b', sent)]]);
  const list = unionRows([
    slice('a', 0, [{ name: 'app' }]),
    slice('b', 1, [{ name: 'app' }]),
  ], { ref: (serverId, s) => sessionRef(serverId, s.name) });
  const bRow = list.rows.find((r) => r.serverId === 'b')!;
  await onRow(bRow, (id) => fleet.get(id), (api, ref) => api.killSession(ref.session));
  assert.deepEqual(sent, ['b:kill_session:app'], 'B s same-named session, on B, and nothing on A');
});

test('the api is frozen at the click: what changes while the action waits does not re-target it', async () => {
  // The action awaits between two calls. Meanwhile B's handle is replaced —
  // a reconnect that mints a new runtime, or a switch. The rest of the action
  // must not move to the new handle: an operation started on one runtime
  // finishes on it (or is refused by its gate), never on another.
  const sent: string[] = [];
  const fleet = new Map([['b', runtimeFor('b', sent)]]);
  let lookups = 0;
  const row = { ref: sessionRef('b', 'app') };
  let release = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const done = onRow(row, (id) => { lookups++; return fleet.get(id); }, async (api, ref) => {
    await api.killSession(ref.session);
    await waiting;
    await api.killSession(`${ref.session}-2`);
  });
  fleet.set('b', runtimeFor('b-new', sent));
  release();
  await done;
  assert.equal(lookups, 1, 'the runtime is looked up once, at the click');
  assert.deepEqual(sent, ['b:kill_session:app', 'b:kill_session:app-2'], 'both calls went to the handle that was clicked');
});

test('no live runtime for the row s server means no action, and no fallback', async () => {
  // Falling back to "the current server" is exactly how a click on B's row
  // acts on A, so a row whose server is absent or dead does nothing at all.
  const sent: string[] = [];
  const fleet = new Map([['a', runtimeFor('a', sent)], ['dead', runtimeFor('dead', sent, () => false)]]);
  let acted = false;
  const act = (api: WsApi) => { acted = true; return api.killSession('app'); };
  assert.equal(onRow({ ref: sessionRef('b', 'app') }, (id) => fleet.get(id), act), null, 'B is not in the fleet');
  assert.equal(onRow({ ref: sessionRef('dead', 'app') }, (id) => fleet.get(id), act), null, 'a detached runtime');
  assert.equal(acted, false);
  assert.deepEqual(sent, [], 'and A — the one that IS there — received nothing');
});
