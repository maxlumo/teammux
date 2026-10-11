import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXCLUDED_KEY, MODE_KEY, includedServers, readExcluded, readMode, setExcluded, writeMode,
} from './connection-mode.ts';
import { isResidentKey, createServerStore } from './server-store.ts';

const memory = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
};
const saved = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('the mode is Single unless Aggregate is exactly what is stored', () => {
  assert.equal(readMode(memory()), 'single', 'nothing stored: Single, today s behaviour');
  assert.equal(readMode(memory({ [MODE_KEY]: 'aggregate' })), 'aggregate');
  assert.equal(readMode(memory({ [MODE_KEY]: 'single' })), 'single');
  for (const odd of ['Aggregate', 'multi', '', '1', '{"mode":"aggregate"}']) {
    assert.equal(readMode(memory({ [MODE_KEY]: odd })), 'single', `an unknown value (${JSON.stringify(odd)}) is Single`);
  }
  const throwing = { getItem: () => { throw new Error('SecurityError'); } };
  assert.equal(readMode(throwing), 'single', 'storage that cannot be read is Single, not a crash');
});

test('writing the mode stores one of the two words', () => {
  const s = memory();
  writeMode(s, 'aggregate');
  assert.equal(s.map.get(MODE_KEY), 'aggregate');
  writeMode(s, 'single');
  assert.equal(s.map.get(MODE_KEY), 'single');
  writeMode(s, 'other' as never);
  assert.equal(s.map.get(MODE_KEY), 'single', 'nothing else is ever written');
});

test('the excluded set is read through the saved registry, and junk reads as empty', () => {
  assert.deepEqual([...readExcluded(memory(), saved)], [], 'default: nothing excluded');
  assert.deepEqual([...readExcluded(memory({ [EXCLUDED_KEY]: '["b"]' }), saved)], ['b']);
  for (const junk of ['{', '"b"', '{"b":true}', 'null', '42']) {
    assert.deepEqual([...readExcluded(memory({ [EXCLUDED_KEY]: junk }), saved)], [], `junk ${junk} is empty`);
  }
  assert.deepEqual([...readExcluded(memory({ [EXCLUDED_KEY]: '["b", 7, null, {"id":"c"}]' }), saved)], ['b'], 'non-ids are skipped, not repaired');
  const throwing = { getItem: () => { throw new Error('SecurityError'); } };
  assert.deepEqual([...readExcluded(throwing, saved)], []);
});

test('an id that is no longer saved drops out on read: forgotten, or absorbed into a survivor', () => {
  const s = memory({ [EXCLUDED_KEY]: '["b","gone"]' });
  assert.deepEqual([...readExcluded(s, saved)], ['b'], 'an id nobody saved is not in the set');
  // b is absorbed into its machine's survivor a: b leaves the registry, and
  // its exclusion is NOT handed to a (D5) — a is included by its own mark.
  const afterAbsorb = [{ id: 'a' }, { id: 'c' }];
  assert.deepEqual([...readExcluded(s, afterAbsorb)], [], 'b s mark went with b');
  assert.deepEqual(includedServers(afterAbsorb, readExcluded(s, afterAbsorb)).map((e) => e.id), ['a', 'c']);
  // An entry later saved under the same id would be a coincidence the id
  // generator does not make; the stored set is pruned on the next write anyway.
  setExcluded(s, afterAbsorb, 'c', true);
  assert.deepEqual(JSON.parse(s.map.get(EXCLUDED_KEY)!), ['c'], 'every write stores the pruned set');
});

test('exclude and include one server; an unsaved id is never added', () => {
  const s = memory();
  assert.deepEqual([...setExcluded(s, saved, 'b', true)], ['b']);
  assert.deepEqual([...setExcluded(s, saved, 'c', true)].sort(), ['b', 'c']);
  assert.deepEqual([...setExcluded(s, saved, 'b', false)], ['c']);
  assert.deepEqual([...setExcluded(s, saved, 'nobody', true)], ['c'], 'excluding an id that is not saved does nothing');
  assert.deepEqual(JSON.parse(s.map.get(EXCLUDED_KEY)!), ['c']);
});

test('a set that cannot be read is never overwritten: the write refuses (reviewer D5)', () => {
  const s = memory({ [EXCLUDED_KEY]: '["b"]' });
  let unreadable = true;
  const flaky = { ...s, getItem: (k: string) => { if (unreadable && k === EXCLUDED_KEY) throw new Error('SecurityError'); return s.getItem(k); } };
  assert.throws(() => setExcluded(flaky, saved, 'c', true), /could not be read/u);
  assert.equal(s.map.get(EXCLUDED_KEY), '["b"]', 'b is still excluded');
  unreadable = false;
  assert.deepEqual([...setExcluded(flaky, saved, 'c', true)].sort(), ['b', 'c']);
  // Junk that WAS read is a set nobody can use: a write replaces it.
  const junk = memory({ [EXCLUDED_KEY]: '{' });
  assert.deepEqual([...setExcluded(junk, saved, 'b', true)], ['b']);
});

test('Aggregate includes every saved entry not excluded, in saved order, a new one included', () => {
  const named = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }, { id: 'c', name: 'gamma' }];
  assert.deepEqual(includedServers(named, new Set(['b'])).map((e) => e.id), ['a', 'c']);
  const withNew = [...named, { id: 'd', name: 'delta' }];
  assert.deepEqual(includedServers(withNew, new Set(['b'])).map((e) => e.id), ['a', 'c', 'd'], 'a newly saved server is included');
  const renamed = named.map((e) => (e.id === 'b' ? { ...e, name: 'beta renamed' } : e));
  assert.deepEqual(includedServers(renamed, new Set(['b'])).map((e) => e.id), ['a', 'c'], 'a rename does not change the selection');
});

test('both keys are the person s: a server s store passes them through unprefixed', () => {
  assert.equal(isResidentKey(MODE_KEY), false);
  assert.equal(isResidentKey(EXCLUDED_KEY), false);
  const s = memory();
  const store = createServerStore(s, 'a');
  writeMode(store, 'aggregate');
  setExcluded(store, saved, 'b', true);
  assert.equal(s.map.get(MODE_KEY), 'aggregate', 'not under a server s slot');
  assert.equal(s.map.get(EXCLUDED_KEY), '["b"]');
  assert.deepEqual([...s.map.keys()].filter((k) => k.includes('::')), []);
});
