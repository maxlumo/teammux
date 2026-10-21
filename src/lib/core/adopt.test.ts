import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adopt, sameContent } from './adopt.ts';

// Board #444: a poll answer that changes nothing assigns nothing.

test('the same content keeps the current value, by reference', () => {
  const cur = [{ name: 'claude', state: 'idle', vitals: { model: 'x', context_pct: 12 } }, { name: 'kiro', state: 'running', vitals: null }];
  const answer = JSON.parse(JSON.stringify(cur));
  assert.notEqual(answer, cur);
  assert.equal(adopt(cur, answer), cur, 'an identical roster answer is not a new roster');
  assert.equal(adopt({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }).a, 1);
  const keyOrder = { a: 1, b: 2 };
  assert.equal(adopt(keyOrder, { b: 2, a: 1 }), keyOrder, 'key order is not content');
  const absent: { a: number; b?: number } = { a: 1 };
  assert.equal(adopt(absent, { a: 1, b: undefined }), absent, 'an undefined member is absent, as JSON reads it');
});

test('any difference adopts the answer', () => {
  const cur = [{ name: 'claude', state: 'idle', since: 1 }];
  for (const next of [
    [{ name: 'claude', state: 'running', since: 1 }],
    [{ name: 'claude', state: 'idle', since: 2 }],
    [{ name: 'claude', state: 'idle', since: 1, detail: 'Bash' }],
    [{ name: 'claude', state: 'idle' }],
    [],
    [{ name: 'claude', state: 'idle', since: 1 }, { name: 'kiro' }],
    [{ name: 'claude', state: 'idle', since: '1' }],
  ]) assert.equal(adopt(cur, next as typeof cur), next, JSON.stringify(next));
  assert.equal(sameContent([], {}), false, 'an array is not an object');
  assert.equal(sameContent(null, {}), false);
  assert.equal(sameContent({ a: null }, { a: undefined }), false, 'null is a value');
});

test('a merged list holding the same objects is equal without being walked', () => {
  let reads = 0;
  const m = { get body() { reads++; return 'x'; } };
  assert.equal(sameContent([m, m], [m, m]), true);
  assert.equal(reads, 0, 'same references are equal by identity');
});

test('Hub adopts every poll answer it stores (#444)', () => {
  const src = readFileSync(new URL('../hub/Hub.svelte', import.meta.url), 'utf8');
  for (const line of [
    'agents = adopt(agents, got);',
    'stoppedTeams = adopt(stoppedTeams, r.stopped_teams ?? {});',
    'agentStates = adopt(agentStates, mergeStates(agentStates, s, got));',
    'agentStates = adopt(agentStates, mergeStates(roomsRes.states ?? {}, selected, agents));',
    'feed = adopt(feed, mergeMessages(feed, messages));',
    'talkMap = adopt(talkMap, talk);',
    'trash = adopt(trash, all.filter((r) => r.project.archived));',
    'rows = adopt(rows, sortRows(all.filter((r) => !r.project.archived), talk));',
    'panes = adopt(panes, sp.panes ?? []);',
  ]) assert.ok(src.includes(line), line);
  assert.doesNotMatch(src, /^\s*agents = got;/mu, 'the raw roster assignment is gone');
});
