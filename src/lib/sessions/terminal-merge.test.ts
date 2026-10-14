// The Terminal list is the Hub's merged-list rule over sessions (board #371):
// each server's slice in its own order, interleaved by the one comparator.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTerminalRows, clockKey, type ProjectClock } from './terminal-merge.ts';
import type { ProjectRow } from '../projects/projects.ts';
import { paneRef } from '../app/refs.ts';

const row = (session: string, live: boolean, lastUp = 0, id = session): ProjectRow => ({
  project: { id, name: session, path: '/p/' + session, session, adopted: false, autostart: false, created_at: 0, last_up_at: lastUp, archived: false, room: `proj:${session}` },
  slots: [], live,
});
const pick = (name: string) => ({ name, windows: 1, attached: false, target: `${name}:0.0` });
const foreign = (serverId: string, name: string) => ({ serverId, item: pick(name), ref: paneRef(serverId, name, `${name}:0.0`), tag: serverId });
const names = (rows: ReturnType<typeof mergeTerminalRows>) => rows.map((r) => r.item.kind === 'local' ? r.item.row.project.session : `${r.serverId}/${r.item.pick.name}`);

// devbox (local) has live l-new (up at 5000 s) and l-old (up at 1000 s), then stopped s1, s2.
const local = [row('l-new', true, 5000), row('l-old', true, 1000), row('s1', false, 9000), row('s2', false, 8000)];
const clocks = new Map<string, ProjectClock>([
  [clockKey('mac', 'm-mid'), { name: 'M Mid', row: row('m-mid', true, 3000), talk: {} }],
  [clockKey('mac', 'm-hot'), { name: 'M Hot', row: row('m-hot', true, 9000), talk: {} }],
]);
const base = { localId: 'dev', local, localTalk: {}, order: ['dev', 'mac'], clock: (s: string, n: string) => clocks.get(clockKey(s, n)) };

test('a foreign live row sits where its recency puts it among the local live rows: not first, not last', () => {
  const merged = mergeTerminalRows({ ...base, foreign: [foreign('mac', 'm-mid')] });
  assert.deepEqual(names(merged), ['l-new', 'mac/m-mid', 'l-old', 's1', 's2'], 'between 5000 and 1000; before every stopped project');
});

test('the most recent live row of either server leads; the foreign slice is ordered by the same rule', () => {
  const merged = mergeTerminalRows({ ...base, foreign: [foreign('mac', 'm-mid'), foreign('mac', 'm-hot')] }); // tmux order: mid, hot
  assert.deepEqual(names(merged), ['mac/m-hot', 'l-new', 'mac/m-mid', 'l-old', 's1', 's2']);
});

test('the clock is the row\'s OWN server\'s: the same room name on two servers is two clocks', () => {
  // Both servers have a project in room proj:app. Only the LOCAL one has been talked in (9000 s);
  // the local list is in its own order (`sortRows`), so the talked-in app leads it.
  const withApp = [row('app', true, 0), ...local];
  const talked = { ...base, local: withApp, localTalk: { 'proj:app': 9_000_000 }, clock: () => ({ name: 'app', row: row('app', true, 0), talk: {} }) };
  const merged = names(mergeTerminalRows({ ...talked, foreign: [foreign('mac', 'app')] }));
  assert.deepEqual(merged, ['app', 'l-new', 'l-old', 'mac/app', 's1', 's2'],
    'the foreign app is measured by ITS empty clock (0), not by the local proj:app\'s 9000 s');
});

test('a session with no project row is live but unclocked: after every clocked live row, before the stopped ones', () => {
  const merged = mergeTerminalRows({ ...base, foreign: [foreign('mac', 'untracked')] });
  assert.deepEqual(names(merged), ['l-new', 'l-old', 'mac/untracked', 's1', 's2']);
  const item = merged.find((r) => r.item.kind === 'foreign')!.item;
  assert.equal(item.kind === 'foreign' && item.clocked, false);
});

test('a project row marked stopped on the Hub is still live here: a session exists', () => {
  const c = new Map([[clockKey('mac', 'm-hot'), { name: 'M Hot', row: row('m-hot', false, 9000), talk: {} }]]);
  const merged = mergeTerminalRows({ ...base, clock: (s, n) => c.get(clockKey(s, n)), foreign: [foreign('mac', 'm-hot')] });
  assert.deepEqual(names(merged), ['mac/m-hot', 'l-new', 'l-old', 's1', 's2'], 'live outranks stopped, as everywhere');
});

test('with no foreign rows the list is this server\'s own, row for row (Single is structurally untouched)', () => {
  const merged = mergeTerminalRows({ ...base, foreign: [] });
  assert.deepEqual(names(merged), ['l-new', 'l-old', 's1', 's2']);
  assert.deepEqual(merged.map((r) => r.key), local.map((r) => `local:${r.project.id}`));
});

test('equal rows keep the saved server order, and a local slice is never reordered by the merge', () => {
  const same = new Map<string, ProjectClock>([[clockKey('mac', 'twin'), { name: 'twin', row: row('twin', true, 5000), talk: {} }]]);
  const merged = mergeTerminalRows({ ...base, clock: (s, n) => same.get(clockKey(s, n)), foreign: [foreign('mac', 'twin')] });
  assert.deepEqual(names(merged).slice(0, 2), ['l-new', 'mac/twin'], 'a tie goes to the server saved first (devbox)');
  const reversed = mergeTerminalRows({ ...base, order: ['mac', 'dev'], clock: (s, n) => same.get(clockKey(s, n)), foreign: [foreign('mac', 'twin')] });
  assert.deepEqual(names(reversed).slice(0, 2), ['mac/twin', 'l-new']);
  assert.deepEqual(names(merged).filter((n) => !n.includes('/')), ['l-new', 'l-old', 's1', 's2'], 'the local order is its own');
});

test('a foreign row carries the project NAME when the host knows one, else the session', () => {
  const merged = mergeTerminalRows({ ...base, foreign: [foreign('mac', 'm-mid'), foreign('mac', 'untracked')] });
  const label = (s: string) => { const it = merged.find((r) => r.item.kind === 'foreign' && r.item.pick.name === s)!.item; return it.kind === 'foreign' ? it.name : ''; };
  assert.equal(label('m-mid'), 'M Mid');
  assert.equal(label('untracked'), 'untracked');
});
