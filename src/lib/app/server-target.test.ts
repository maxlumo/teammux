// Where to reach one saved server (board #335 ②b-2-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { addressesOf, targetOf } from './server-target.ts';

const store = (init: Record<string, string>) => ({ getItem: (k: string) => init[k] ?? null });
const registry = JSON.stringify([
  { id: 'a', name: 'alpha', address: 'ws://a-lan:9899', token: 'tA', machineId: 'm-a' },
  { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tB', machineId: 'm-b' },
  { id: 'n', name: 'new', address: 'ws://n:9899', token: 'tN' },
]);
const machines = JSON.stringify({ 'm-a': ['ws://a-lan:9899', 'ws://a-ts:9899'], 'm-b': ['ws://b-wan:9899', 'ws://b:9899'] });

test('the current server is where its ENTRY says, whatever the mirror holds (board #335 ②b-4)', () => {
  // Every path that moves the active address records it on the entry once
  // it answers; an address in the mirror that never answered is not where
  // the server is.
  const s = store({
    tmux_servers: registry, tmux_server_current: 'a', tmux_machines: machines,
    tmux_address: 'ws://typed-but-never-answered:9899', tmux_token: 'tX', tmux_machine_id: 'm-old',
  });
  assert.deepEqual(targetOf(s, 'a'), {
    address: 'ws://a-lan:9899', token: 'tA', machineId: 'm-a', alternates: ['ws://a-ts:9899'],
  });
});

test('any other server is where its own entry says, with its own failover set', () => {
  const s = store({
    tmux_servers: registry, tmux_server_current: 'a', tmux_machines: machines,
    tmux_address: 'ws://a-ts:9899', tmux_token: 'tA2', tmux_machine_id: 'm-a',
  });
  assert.deepEqual(targetOf(s, 'b'), {
    address: 'ws://b:9899', token: 'tB', machineId: 'm-b', alternates: ['ws://b-wan:9899'],
  }, 'B s address, token and machine — nothing of the current server s');
  assert.deepEqual(targetOf(s, 'n')?.alternates, [], 'no machine yet: no failover set to borrow');
  assert.equal(targetOf(s, 'gone'), null, 'nothing saved: nowhere to go');
});

test('with no saved server there is nowhere to go', () => {
  assert.equal(targetOf(store({ tmux_address: 'ws://x:9899', tmux_token: 't' }), ''), null,
    'the mirror alone is not a server: the boot migrates it into an entry first');
});

test('a switch may dial the asked address, then the entry\u2019s own, then the machine\u2019s others, each once (board #353)', () => {
  const s = store({ tmux_servers: registry, tmux_server_current: 'b', tmux_machines: machines });
  assert.deepEqual(addressesOf(s, 'a', 'ws://a-lan:9899'), ['ws://a-lan:9899', 'ws://a-ts:9899']);
  assert.deepEqual(addressesOf(s, 'a', 'ws://a-ts:9899'), ['ws://a-ts:9899', 'ws://a-lan:9899'], 'a pick leads; the entry\u2019s own follows');
  assert.deepEqual(addressesOf(s, 'b', 'ws://b:9899'), ['ws://b:9899', 'ws://b-wan:9899']);
  assert.deepEqual(addressesOf(s, 'n', 'ws://n:9899'), ['ws://n:9899'], 'no machine yet: only itself');
  assert.deepEqual(addressesOf(s, '', 'ws://typed:9899'), ['ws://typed:9899'], 'a candidate with no entry has only what it named');
  assert.deepEqual(addressesOf(s, 'gone', 'ws://x:1'), ['ws://x:1']);
});
