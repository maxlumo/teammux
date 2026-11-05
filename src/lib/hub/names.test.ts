import assert from 'node:assert/strict';
import test from 'node:test';
import { agentNames, patchNames } from './names.ts';

// The cases of address.rs's `Names` tests (board #20), read on the client
// over the same wire table: the client APPLIES the server's labels, it never
// computes one.
const squad = agentNames([
  { agent: 'builder', label: 'bob', aliases: ['bobby', 'bo'] },
  { agent: 'validator', label: 'validator', aliases: ['val'] },
]);

test('every name an agent has or had resolves to its physical name (#21)', () => {
  for (const n of ['builder', 'bob', 'bobby', 'bo']) assert.equal(squad.resolve(n), 'builder', n);
  assert.equal(squad.resolve('val'), 'validator', 'a reset agent\'s previous label still resolves');
  assert.equal(squad.resolve('reviewer'), 'reviewer', 'an agent with no label is its own name');
  assert.equal(squad.resolve('all'), 'all');
  assert.equal(squad.resolve('Bob'), 'Bob', 'names are exact');
});

test('any of its names shows the current label (#21)', () => {
  for (const n of ['builder', 'bob', 'bobby']) assert.equal(squad.shown(n), 'bob', n);
  assert.equal(squad.shown('val'), 'validator');
  assert.equal(squad.shown('reviewer'), 'reviewer');
  assert.equal(squad.shown('human'), 'human');
});

test('aliasesOf lists the names that still reach an agent besides its label (#21)', () => {
  assert.deepEqual(squad.others('builder'), ['builder', 'bobby', 'bo']);
  assert.deepEqual(squad.others('validator'), ['val']);
  assert.deepEqual(squad.others('reviewer'), []);
});

test('a malformed wire table maps nothing; an older server sends none (#21)', () => {
  const n = agentNames([{ agent: 'x' }, 'junk', null] as unknown[]);
  assert.equal(n.shown('x'), 'x');
  assert.equal(agentNames(undefined).resolve('bob'), 'bob');
});

test('an agent_renamed push patches the table in place (#21)', () => {
  const before = [{ agent: 'builder', label: 'bob', aliases: [] as string[] }, { agent: 'qa', label: 'tess', aliases: [] as string[] }];
  const after = patchNames(before, { agent: 'builder', label: 'robert', aliases: ['bob'] });
  assert.deepEqual(after, [{ agent: 'builder', label: 'robert', aliases: ['bob'] }, { agent: 'qa', label: 'tess', aliases: [] }]);
  assert.deepEqual(patchNames(after, { agent: 'new', label: 'n', aliases: [] }).map((l) => l.agent), ['builder', 'qa', 'new'], 'a first label is added');
  assert.deepEqual(before[0]!.label, 'bob', 'the old table is not mutated');
});
