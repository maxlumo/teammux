import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOST_KEY, recordLost } from './slot-merge.ts';

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
};
const row = (n: number) => ({ from: 'a', to: 'c', key: 'tmux_state', value: `v${n}` });

test('every unresolved loser is kept: no cap drops the oldest (orchestrator 16:32 on 0f668e4f)', () => {
  const s = mem();
  for (let n = 0; n < 100; n++) recordLost(s, row(n));
  const rows = JSON.parse(s.getItem(LOST_KEY)!) as { value: string }[];
  assert.equal(rows.length, 100);
  assert.equal(rows[0]!.value, 'v0', 'the first loser is still there');
  recordLost(s, row(0));
  assert.equal((JSON.parse(s.getItem(LOST_KEY)!) as unknown[]).length, 100, 'the same row is recorded once');
});

test('a conflict store that cannot be read throws and is not written over', () => {
  for (const bad of ['{not json', '{"a":1}']) {
    const s = mem({ [LOST_KEY]: bad });
    assert.throws(() => recordLost(s, row(1)));
    assert.equal(s.getItem(LOST_KEY), bad);
  }
  const failing = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('unreached'); } };
  assert.throws(() => recordLost(failing, row(1)), /SecurityError/u, 'a read that throws is not swallowed');
});
