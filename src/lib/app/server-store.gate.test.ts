// The pending-write table (board #335 ③a; orchestrator's final P1-D ruling
// 08:20, reviewer's details 08:20, validator's E4): while the app is blocked
// on its storage, resident writes are held — read back, never lost, never on
// disk — and Retry lands them in order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerStore, createWriteGate } from './server-store.ts';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const log: string[] = [];
  let failOn: string | null = null;
  return {
    m, log,
    failNext(key: string | null) { failOn = key; },
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { if (k === failOn) { failOn = null; throw new Error('QuotaExceededError'); } log.push(`set ${k}`); m.set(k, String(v)); },
    removeItem: (k: string) => { log.push(`rm ${k}`); m.delete(k); },
  };
}

test('an open gate changes nothing: every write lands where it always did', () => {
  const s = mem();
  const store = createServerStore(s, 'a', createWriteGate());
  store.setItem('tmux_hub_alerts', '[1]');
  store.setItem('tmux_theme', 'dark');
  assert.equal(s.m.get('tmux_hub_alerts::a'), '[1]');
  assert.equal(s.m.get('tmux_theme'), 'dark');
});

test('closed: a resident write is held and read back; the person s keys still pass through', () => {
  const s = mem({ 'tmux_hub_alerts::a': '[]' });
  const gate = createWriteGate();
  const store = createServerStore(s, 'a', gate);
  gate.close();
  store.setItem('tmux_hub_alerts', '[{"k":1}]');
  assert.equal(s.m.get('tmux_hub_alerts::a'), '[]', 'nothing on disk');
  assert.equal(store.getItem('tmux_hub_alerts'), '[{"k":1}]', 'the store answers what the page holds');
  store.setItem('tmux_theme', 'light');
  assert.equal(s.m.get('tmux_theme'), 'light', 'a person s key is not a server s slot');
  assert.equal(gate.pendingCount(), 1);
});

test('a removal is an intent of its own, not "nothing pending"', () => {
  const s = mem({ 'tmux_hub_drafts::a': '{"w":"x"}' });
  const gate = createWriteGate();
  const store = createServerStore(s, 'a', gate);
  gate.close();
  store.removeItem('tmux_hub_drafts');
  assert.equal(store.getItem('tmux_hub_drafts'), null, 'read back as removed');
  assert.equal(s.m.get('tmux_hub_drafts::a'), '{"w":"x"}');
  assert.equal(gate.flush(s), true);
  assert.equal(s.m.has('tmux_hub_drafts::a'), false, 'and removed on flush');
});

test('every view of one server shares one table, and another server s is its own', () => {
  const s = mem();
  const gate = createWriteGate();
  const bundle = createServerStore(s, 'a', gate);
  const nav = createServerStore(s, 'a', gate);
  const other = createServerStore(s, 'b', gate);
  gate.close();
  bundle.setItem('tmux_state', 'from-bundle');
  assert.equal(nav.getItem('tmux_state'), 'from-bundle', 'a temporary view of a sees a s pending value');
  assert.equal(other.getItem('tmux_state'), null, 'b does not');
});

test('Retry lands the LAST value with no further input — an unchanged setter cannot strand it (reviewer 08:19)', () => {
  const s = mem({ 'tmux_hub_seen::a': '"disk"' });
  const gate = createWriteGate();
  const store = createServerStore(s, 'a', gate);
  gate.close();
  store.setItem('tmux_hub_seen', '"one"');
  store.setItem('tmux_hub_seen', '"disk"');
  store.setItem('tmux_hub_seen', '"last"');
  assert.equal(gate.flush(s), true);
  assert.equal(s.m.get('tmux_hub_seen::a'), '"last"');
  assert.equal(gate.closed, false, 'the gate opens once all of it landed');
  assert.equal(gate.pendingCount(), 0);
});

test('flush writes in the order written, and a failure keeps the rest for the next Retry', () => {
  const s = mem();
  const gate = createWriteGate();
  const a = createServerStore(s, 'a', gate);
  const b = createServerStore(s, 'b', gate);
  gate.close();
  a.setItem('tmux_hub_alerts', 'A1');
  b.setItem('tmux_hub_alerts', 'B1');
  a.setItem('tmux_state', 'A2');
  s.failNext('tmux_hub_alerts::b');
  assert.equal(gate.flush(s), false, 'one entry could not be written');
  assert.equal(gate.closed, true, 'still blocked');
  assert.equal(s.m.get('tmux_hub_alerts::a'), 'A1', 'what landed stays landed');
  assert.equal(a.getItem('tmux_state'), 'A2', 'what did not is still read back');
  assert.equal(gate.pendingCount(), 2);
  assert.equal(gate.flush(s), true);
  assert.deepEqual(s.log, ['set tmux_hub_alerts::a', 'set tmux_hub_alerts::b', 'set tmux_state::a'], 'in the order written');
});

test('an alias s pending writes land under its canonical entry, never in the alias s deleted slot', () => {
  const s = mem();
  const gate = createWriteGate();
  const alias = createServerStore(s, 'alias', gate);
  const canon = createServerStore(s, 'canon', gate);
  gate.close();
  alias.setItem('tmux_hub_alerts', 'from-alias');   // arrived while blocked
  canon.setItem('tmux_hub_drafts', 'canon-draft');
  alias.setItem('tmux_hub_drafts', 'alias-later');  // the later write of a key wins
  // Retry's claim records that alias was folded into canon.
  assert.equal(gate.flush(s, (id) => (id === 'alias' ? 'canon' : id)), true);
  assert.equal(s.m.get('tmux_hub_alerts::canon'), 'from-alias', 'the alert survived the merge');
  assert.equal(s.m.get('tmux_hub_drafts::canon'), 'alias-later');
  assert.deepEqual([...s.m.keys()].filter((k) => k.endsWith('::alias')), [], 'nothing written back to the alias');
});

test('move hands one server s table to another, the later write of each key winning', () => {
  const s = mem();
  const gate = createWriteGate();
  const a = createServerStore(s, 'a', gate);
  const c = createServerStore(s, 'c', gate);
  gate.close();
  c.setItem('tmux_state', 'c-first');
  a.setItem('tmux_state', 'a-second');
  a.setItem('tmux_hub_seen', 'a-first');
  c.setItem('tmux_hub_seen', 'c-second');
  gate.move('a', 'c');
  assert.equal(c.getItem('tmux_state'), 'a-second', 'a wrote it later');
  assert.equal(c.getItem('tmux_hub_seen'), 'c-second', 'c wrote it later');
  assert.equal(a.getItem('tmux_state'), null, 'a holds nothing pending now');
});

test('E4: an alert that arrives during a block is on disk after Retry, and a reload finds it (validator E4)', async () => {
  // The real alert log over a gated store: the centre records the way the
  // Hub's push path does, the gate holds it, Retry flushes, and a NEW log
  // over the storage — what a reload builds — reads it back.
  (globalThis as { $state?: unknown }).$state = (v: unknown) => v;
  const { createAlertLog, ALERTS_KEY } = await import('../hub/notify-centre.svelte.ts');
  const s = mem();
  const gate = createWriteGate();
  const store = createServerStore(s, 'a', gate);
  const log = createAlertLog(store);
  gate.close();
  const alert = { key: 'proj:work|7', server: 'a', room: 'proj:work', session: 'work', project: 'work', seq: 7, id: '7',
    ts: 1, from: 'dev', toHuman: true, kind: 'reply' as const, excerpt: 'done?', viewed: false };
  log.record(alert);
  assert.equal(s.m.has(`${ALERTS_KEY}::a`), false, 'nothing on disk while blocked');
  assert.equal(log.items.length, 1, 'the bell shows it');
  assert.equal(JSON.parse(store.getItem(ALERTS_KEY)!).length, 1, 'and the store reads it back');
  assert.equal(gate.flush(s), true);
  const reloaded = createAlertLog(createServerStore(s, 'a', createWriteGate()));
  assert.deepEqual(reloaded.items.map((a) => a.key), ['proj:work|7'], 'a reload finds the alert');
});
