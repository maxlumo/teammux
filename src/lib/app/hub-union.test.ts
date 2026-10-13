// The Hub sidebar's union source (board #335 ③c-2): a projection of each
// Hub's own ordered list, merged by the one rule with each row on its own
// server's clock; published per runtime; withdrawn with the tree.
import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as { $state?: unknown }).$state = (v: unknown) => v;
const { createHubUnion } = await import('./hub-union.svelte.ts');
import type { ProjectRow } from '../projects/projects.ts';

const row = (name: string, live: boolean, updated = 0): ProjectRow =>
  ({ project: { id: `${name}-id`, name, session: name, path: `/${name}`, room: `proj:${name}`, updated_at: updated }, slots: [], live } as unknown as ProjectRow);
const slice = (rows: ProjectRow[], talk: Record<string, number> = {}, state: { answered?: boolean; failed?: boolean } = {}) =>
  ({ rows, talk, unread: {}, agentStates: {}, panes: [], answered: state.answered ?? true, failed: state.failed ?? false, icon: () => null });
const two = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }];

test('one server s slice is its own list, untagged; two merge by the domain rule, each on its server s clock, tagged', () => {
  const u = createHubUnion();
  const ra = { id: 'ra' }, rb = { id: 'rb' };
  u.publish(ra, 'a', slice([row('app', true), row('old', false)], { 'proj:app': 1000 }));
  let list = u.rows([{ id: 'a', name: 'alpha' }]);
  assert.deepEqual(list.rows.map((r) => [r.item.project.name, r.tag]), [['app', null], ['old', null]], 'one included: as published, no tag');
  assert.deepEqual(list.missing, []);
  // B publishes a same-named `app`, more active by ITS clock.
  u.publish(rb, 'b', slice([row('app', true), row('other', true)], { 'proj:app': 9000, 'proj:other': 50 }));
  list = u.rows(two);
  assert.deepEqual(list.rows.map((r) => `${r.tag}:${r.item.project.name}`), ['beta:app', 'alpha:app', 'beta:other', 'alpha:old'],
    'live first; among live, the more recent by each row s OWN server s talk; saved order breaks ties');
  assert.equal(new Set(list.rows.map((r) => r.key)).size, 4, 'keys never collide across servers');
  assert.ok(list.rows.every((r) => r.key.includes(r.serverId)), 'each key names its server');
  assert.equal(list.rows[0]!.slice.talk['proj:app'], 9000, 'a row carries its own server s clock and maps');
});

test('an included server with no slice is MISSING, not silently absent; a withdrawn runtime s slice goes; a stale runtime publishes nothing', () => {
  const u = createHubUnion();
  const ra = { id: 'ra' };
  u.publish(ra, 'a', slice([row('app', true)]));
  let list = u.rows(two);
  assert.deepEqual(list.missing, ['b'], 'B has not published');
  assert.deepEqual(list.rows.map((r) => r.tag), ['alpha'], 'and A s rows still say where they are from');
  u.withdraw(ra);
  list = u.rows(two);
  assert.deepEqual(list.rows, []);
  assert.deepEqual(list.missing, ['a', 'b']);
});

test('a slice is keyed by the RUNTIME: a replaced runtime for the same id does not inherit the old one s rows', () => {
  const u = createHubUnion();
  const old = { id: 'a1' }, fresh = { id: 'a2' };
  u.publish(old, 'a', slice([row('stale', true)]));
  u.publish(fresh, 'a', slice([row('fresh', true)]));
  u.withdraw(old);
  assert.deepEqual(u.rows([{ id: 'a', name: 'alpha' }]).rows.map((r) => r.item.project.name), ['fresh']);
});

test('a slice that has not ANSWERED is missing, not an empty list; a slice whose latest refresh FAILED keeps its last good rows and is named unavailable (P1-C4)', () => {
  const u = createHubUnion();
  const ra = { id: 'ra' }, rb = { id: 'rb' };
  u.publish(ra, 'a', slice([row('app', true)]));
  // B's Hub mounted and published from the start, its first list still out.
  u.publish(rb, 'b', slice([], {}, { answered: false }));
  let r = u.rows(two);
  assert.deepEqual(r.missing, ['b'], 'B has not answered: missing, though a slice exists');
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(r.rows.map((x) => `${x.serverId}:${x.item.project.name}`), ['a:app']);
  // B's first list FAILS: still missing (nothing good to keep), not unavailable.
  u.publish(rb, 'b', slice([], {}, { answered: false, failed: true }));
  r = u.rows(two);
  assert.deepEqual(r.missing, ['b'], 'a first failure is still "no list yet"');
  assert.deepEqual(r.unavailable, []);
  // B answers.
  u.publish(rb, 'b', slice([row('other', true)]));
  r = u.rows(two);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.rows.map((x) => `${x.serverId}:${x.item.project.name}`).sort(), ['a:app', 'b:other']);
  // B's next refresh fails: the last good rows stay; B is named unavailable.
  u.publish(rb, 'b', slice([row('other', true)], {}, { failed: true }));
  r = u.rows(two);
  assert.deepEqual(r.missing, [], 'not missing: there IS a list');
  assert.deepEqual(r.unavailable, ['b'], 'named unavailable');
  assert.ok(r.rows.some((x) => x.serverId === 'b' && x.item.project.name === 'other'), 'the last good row is kept');
  // Recovered.
  u.publish(rb, 'b', slice([row('other', true)]));
  assert.deepEqual(u.rows(two).unavailable, []);
});

test('a row carries ITS server s catalog: the slice s icon, not the focus s (P2-5)', () => {
  const u = createHubUnion();
  u.publish({ id: 'ra' }, 'a', { ...slice([row('app', true)]), icon: () => '/a.svg' });
  u.publish({ id: 'rb' }, 'b', { ...slice([row('other', true)]), icon: () => '/b.svg' });
  const r = u.rows(two);
  assert.equal(r.rows.find((x) => x.serverId === 'b')!.slice.icon('codex'), '/b.svg');
  assert.equal(r.rows.find((x) => x.serverId === 'a')!.slice.icon('codex'), '/a.svg');
});
