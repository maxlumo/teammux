import test from 'node:test';
import assert from 'node:assert/strict';
import { agentClass, agentSummary, countParts, foldNotes, isUnread, pickNotes } from './dashboard.ts';
import { toMe } from './notifications.ts';

test('an agent counts once, in § 4 s order: needs you, not running, waiting, working, idle (leader #109 note 17)', () => {
  assert.equal(agentClass({ state: 'running' }), 'working');
  assert.equal(agentClass({ state: 'waiting' }), 'waiting');
  assert.equal(agentClass({ state: 'blocked' }), 'waiting');
  assert.equal(agentClass({ state: 'idle', detail: 'provider_failed' }), 'needsYou');
  assert.equal(agentClass({ state: 'exited', detail: 'cli_exited' }), 'needsYou', 'needsPerson lists cli_exited: the one definition, first');
  assert.equal(agentClass({ state: 'exited' }), 'notRunning');
  assert.equal(agentClass({ state: 'starting' }), 'notRunning');
  assert.equal(agentClass({ state: 'idle' }), 'idle');
});

test('the summary counts every agent once; a row for each that is not idle; the line names only non-zero parts', () => {
  const a = (name: string, state: string, detail = '') => ({ name, state, detail });
  const s = agentSummary([a('w1', 'running'), a('i1', 'idle'), a('f1', 'idle', 'auth_expired'), a('q1', 'waiting'), a('w2', 'running'), a('s1', 'starting')], 2);
  assert.deepEqual(s.counts, { needsYou: 1, notRunning: 1, waiting: 1, working: 2, idle: 1, stopped: 2 });
  assert.deepEqual(s.rows.map((r) => r.name), ['f1', 's1', 'q1', 'w1', 'w2']);
  assert.deepEqual(countParts(s.counts).map((p) => `${p.n} ${p.key}`), ['2 working', '1 waiting', '1 idle', '1 notRunning', '1 needsYou', '2 stopped']);
  assert.deepEqual(countParts(agentSummary([a('w1', 'running')], 0).counts).map((p) => p.key), ['working'], 'zeros are not shown');
});

test('toMe is the bell s record AND to the person; Notes takes the three newest, asks left out', () => {
  const m = (seq: number, from: string, to: string[], body: string, kind = 'msg') => ({ seq, id: seq, from, to, body, kind });
  assert.equal(toMe(m(1, 'dev', ['human'], 'shipped')), true);
  assert.equal(toMe(m(2, 'dev', ['lead'], 'to a teammate')), false, 'not to the person');
  assert.equal(toMe(m(3, 'human', ['human'], 'my own words')), false, 'never your own');
  const page1 = [m(10, 'dev', ['human'], 'old note'), m(11, 'dev', ['lead'], 'chatter')];
  const page0 = [m(20, 'dev', ['human'], 'note A'), m(21, 'lead', ['human'], '@human pick one', 'ask'), m(22, 'lead', ['human'], 'note B')];
  assert.deepEqual(pickNotes([page0, page1]).map((x) => x.seq), [22, 20, 10], 'newest first, across pages, the ask left out');
  assert.deepEqual(pickNotes([page0, page1], 1).map((x) => x.seq), [22]);
  assert.deepEqual(pickNotes([]), []);
});

test('unread is after the room s one mark; an unknown mark marks nothing', () => {
  assert.equal(isUnread({ seq: 5 }, { seq: 4 }), true);
  assert.equal(isUnread({ seq: 4 }, { seq: 4 }), false);
  assert.equal(isUnread({ seq: 1 }, null), true, 'no mark yet: all unread');
  assert.equal(isUnread({ seq: 9 }, undefined), false, 'could not read the mark: not claimed');
});

test('Notes folds a poll into its held lines and holds nothing else: 50 quiet polls leave the same three (#109 R1, leader note 110)', () => {
  const m = (seq: number, to = ['human'], body = `n${seq}`) => ({ seq, id: seq, from: 'dev', to, body, kind: 'msg' });
  let held = pickNotes([[m(1), m(2), m(3, ['lead']), m(4)]]);
  assert.deepEqual(held.map((x) => x.seq), [4, 2, 1]);
  for (let i = 0; i < 50; i++) held = foldNotes(held, [[]]);
  assert.deepEqual(held.map((x) => x.seq), [4, 2, 1], 'the same lines, the same size, after 50 quiet polls');
  held = foldNotes(held, [[m(5, ['lead']), m(6)]]);
  assert.deepEqual(held.map((x) => x.seq), [6, 4, 2], 'a new line in, the oldest out');
  held = foldNotes(held, [[m(9), m(10)], [m(7), m(8, ['lead'])]]);
  assert.deepEqual(held.map((x) => x.seq), [10, 9, 7], 'a gap read across pages, newest first');
});
