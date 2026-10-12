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

test('a flush moves an absorbed server s held writes onto its survivor by the slot rule: the later write wins a real conflict, the loser is recorded (#335 ③b)', () => {
  const s = mem();
  const gate = createWriteGate();
  const a = createServerStore(s, 'a', gate);
  const c = createServerStore(s, 'c', gate);
  gate.close();
  c.setItem('tmux_state', 'c-first');
  a.setItem('tmux_state', 'a-second');
  a.setItem('tmux_hub_seen', JSON.stringify({ work: { seq: 5 } }));
  c.setItem('tmux_hub_seen', JSON.stringify({ work: { seq: 3 }, ops: { seq: 1 } }));
  assert.equal(gate.flush(s, (id) => (id === 'a' ? 'c' : id)), true);
  assert.equal(s.getItem('tmux_state::c'), 'a-second', 'a wrote it later: a real conflict, the later write wins');
  assert.deepEqual(JSON.parse(s.getItem('tmux_slot_conflicts')!), [{ from: 'a', to: 'c', key: 'tmux_state', value: 'c-first' }], 'and c s value is recorded, not lost');
  assert.deepEqual(JSON.parse(s.getItem('tmux_hub_seen::c')!), { work: { seq: 5 }, ops: { seq: 1 } }, 'read marks merge: the newer seq per room');
  assert.equal(s.getItem('tmux_state::a'), null, 'nothing lands under the absorbed id');
});

test('a held write of an absorbed server merges with the survivor s value ON DISK: a held removal deletes nothing, drafts merge by room (#335 ③b)', () => {
  const s = mem();
  s.setItem('tmux_hub_drafts::c', JSON.stringify({ ops: 'TYPED on canonical' }));
  s.setItem('tmux_hub_lead::c', 'canon-lead');
  const gate = createWriteGate();
  const a = createServerStore(s, 'a', gate);
  gate.close();
  a.setItem('tmux_hub_drafts', JSON.stringify({ work: 'typed on the alias' }));
  a.removeItem('tmux_hub_lead');
  assert.equal(gate.flush(s, (id) => (id === 'a' ? 'c' : id)), true);
  assert.deepEqual(JSON.parse(s.getItem('tmux_hub_drafts::c')!), { ops: 'TYPED on canonical', work: 'typed on the alias' }, 'both drafts kept');
  assert.equal(s.getItem('tmux_hub_lead::c'), 'canon-lead', 'the alias s removal of its own key deletes nothing of canonical s');
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

test('an alert held under an alias names its canonical entry after a merge flush; a third server s alert is left alone (#335 ③a, reviewer P1-4)', async () => {
  (globalThis as { $state?: unknown }).$state = (v: unknown) => v;
  const { createAlertLog, ALERTS_KEY } = await import('../hub/notify-centre.svelte.ts');
  const s = mem();
  const gate = createWriteGate();
  const log = createAlertLog(createServerStore(s, 'alias', gate));
  gate.close();
  const alert = (id: string, server: string) => ({ key: `proj:work|${id}`, server, room: 'proj:work', session: 'work', project: 'work', seq: Number(id), id,
    ts: Number(id), from: 'dev', toHuman: true, kind: 'reply' as const, excerpt: 'x', viewed: false });
  log.record(alert('1', 'alias'));
  log.record(alert('2', 'third'));                 // a ref to a server nothing merged
  assert.equal(gate.flush(s, (id) => (id === 'alias' ? 'canon' : id)), true);
  assert.equal(s.m.has(`${ALERTS_KEY}::alias`), false, 'nothing written back to the alias');
  const landed = createAlertLog(createServerStore(s, 'canon', createWriteGate())).items;
  assert.deepEqual(landed.map((a) => [a.id, a.server]).sort(), [['1', 'canon'], ['2', 'third']], 'the alias s alert names canon; the third stays');
});

test('a survivor nothing shows (\'\') keeps the entry where it is — never written to an empty slot', () => {
  const s = mem();
  const gate = createWriteGate();
  const store = createServerStore(s, 'gone', gate);
  gate.close();
  store.setItem('tmux_state', 'x');
  assert.equal(gate.flush(s, () => ''), true);
  assert.equal(s.m.get('tmux_state::gone'), 'x');
  assert.equal([...s.m.keys()].some((k) => k.endsWith('::')), false);
});

test('a move whose loser cannot be recorded keeps the absorbed entry pending: the flush does not land, and the next one merges it (orchestrator 16:32 on 0f668e4f)', () => {
  const s = mem();
  const gate = createWriteGate();
  const a = createServerStore(s, 'a', gate);
  const c = createServerStore(s, 'c', gate);
  gate.close();
  c.setItem('tmux_state', 'c-first');
  a.setItem('tmux_state', 'a-second');
  s.failNext('tmux_slot_conflicts');
  assert.equal(gate.flush(s, (id) => (id === 'a' ? 'c' : id)), false, 'the loser could not be recorded: the flush did not land');
  assert.equal(gate.closed, true, 'the gate stays closed');
  assert.equal(gate.peek('a', 'tmux_state'), 'a-second', 'and the absorbed entry is still pending, not dropped');
  assert.equal(s.getItem('tmux_state::c'), null, 'nothing was written');
  assert.equal(gate.flush(s, (id) => (id === 'a' ? 'c' : id)), true, 'the next flush lands');
  assert.equal(s.getItem('tmux_state::c'), 'a-second');
  assert.deepEqual(JSON.parse(s.getItem('tmux_slot_conflicts')!), [{ from: 'a', to: 'c', key: 'tmux_state', value: 'c-first' }], 'with the loser recorded once');
});

test('an unreadable conflict store blocks the move instead of being written over (orchestrator 16:32 on 0f668e4f)', () => {
  const s = mem({ tmux_slot_conflicts: '{not json' });
  const gate = createWriteGate();
  const a = createServerStore(s, 'a', gate);
  const c = createServerStore(s, 'c', gate);
  gate.close();
  c.setItem('tmux_state', 'c-first');
  a.setItem('tmux_state', 'a-second');
  assert.equal(gate.flush(s, (id) => (id === 'a' ? 'c' : id)), false);
  assert.equal(s.getItem('tmux_slot_conflicts'), '{not json', 'the earlier losers are not erased');
  assert.equal(gate.peek('a', 'tmux_state'), 'a-second', 'and nothing pending was lost');
});
