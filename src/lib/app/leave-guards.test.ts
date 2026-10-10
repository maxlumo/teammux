import test from 'node:test';
import assert from 'node:assert/strict';
import { clearLeaveGuardsForTests, confirmLeave, registerLeaveGuard, type LeaveWalk } from './leave-guards.ts';

test.beforeEach(() => clearLeaveGuardsForTests());

function walk(current: string, seen: string[], leaving: object | null = null): LeaveWalk {
  return {
    leaving,
    current,
    reveal: async (page) => { seen.push(`show ${page}`); },
    hold: (on) => { seen.push(on ? 'hold' : 'release'); },
  };
}

test('the current page asks first; others are revealed, held, and the user ends where they started (board 315)', async () => {
  const seen: string[] = [];
  registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: async () => { seen.push('files?'); return true; } });
  registerLeaveGuard({ runtime: null, page: 'hub', dirty: () => false, ask: async () => { seen.push('hub?'); return true; } });
  registerLeaveGuard({ runtime: null, page: 'prefs', dirty: () => true, ask: async () => { seen.push('prefs?'); return true; } });
  assert.equal(await confirmLeave(walk('prefs', seen)), true);
  assert.deepEqual(seen, ['hold', 'prefs?', 'show files', 'files?', 'show prefs', 'release'],
    'the current page answers before any navigation; the held pages are released last');
});

test('a "stay" stops the walk and still returns to the start; a guard that left on its own is skipped', async () => {
  const seen: string[] = [];
  let offLater = () => {};
  registerLeaveGuard({ runtime: null, page: '', dirty: () => true, ask: async () => { seen.push('first'); offLater(); return true; } });
  offLater = registerLeaveGuard({ runtime: null, page: '', dirty: () => true, ask: async () => { seen.push('gone'); return true; } });
  registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: async () => { seen.push('third'); return false; } });
  registerLeaveGuard({ runtime: null, page: '', dirty: () => true, ask: async () => { seen.push('never'); return true; } });
  assert.equal(await confirmLeave(walk('hub', seen)), false);
  assert.deepEqual(seen, ['hold', 'first', 'show files', 'third', 'show hub', 'release']);
});

test('nothing dirty: no hold, no navigation', async () => {
  const seen: string[] = [];
  registerLeaveGuard({ runtime: null, page: 'files', dirty: () => false, ask: async () => true });
  assert.equal(await confirmLeave(walk('hub', seen)), true);
  assert.deepEqual(seen, []);
});

test('a leave asks only the guards of the handle it destroys (board #335 ②b-2-3)', async () => {
  // A and B can both have a dirty editor on a page of the same name. Leaving
  // A asks A's — on A's view — and never B's, which is not being destroyed.
  // An owner-less guard (outside every server's subtree) is asked always.
  const a = {}, b = {}, seen: string[] = [];
  registerLeaveGuard({ runtime: a, page: 'files', dirty: () => true, ask: async () => { seen.push('ask A'); return true; } });
  registerLeaveGuard({ runtime: b, page: 'files', dirty: () => true, ask: async () => { seen.push('ask B'); return true; } });
  registerLeaveGuard({ runtime: null, page: 'prefs', dirty: () => true, ask: async () => { seen.push('ask shell'); return true; } });
  assert.equal(await confirmLeave(walk('hub', seen, a)), true);
  assert.ok(seen.includes('ask A') && seen.includes('ask shell'));
  assert.ok(!seen.includes('ask B'), 'B s editor is not being thrown away');
});

test('a new handle for the same server is a different owner', async () => {
  // Identity, never the server id: the old handle's guard must not answer for
  // the new one's editor, nor be asked when the new one leaves.
  const old = { id: 'a' }, next = { id: 'a' }, seen: string[] = [];
  registerLeaveGuard({ runtime: old, page: 'files', dirty: () => true, ask: async () => { seen.push('old'); return false; } });
  assert.equal(await confirmLeave(walk('files', seen, next)), true, 'nothing of the new handle is dirty');
  assert.deepEqual(seen.filter((e) => !e.startsWith('show') && e !== 'hold' && e !== 'release'), []);
});
