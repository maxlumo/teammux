// Where to reach one saved server (board #335 ②b-2-2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { targetOf } from './server-target.ts';

const store = (init: Record<string, string>) => ({ getItem: (k: string) => init[k] ?? null });
const registry = JSON.stringify([
  { id: 'a', name: 'alpha', address: 'ws://a-lan:9899', token: 'tA', machineId: 'm-a' },
  { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tB', machineId: 'm-b' },
  { id: 'n', name: 'new', address: 'ws://n:9899', token: 'tN' },
]);
const machines = JSON.stringify({ 'm-a': ['ws://a-lan:9899', 'ws://a-ts:9899'], 'm-b': ['ws://b-wan:9899', 'ws://b:9899'] });

test('the current server is where the ACTIVE MIRROR says, even ahead of the registry', () => {
  // The connect form, the optimizer, the address pick and a failover all
  // write the mirror before the registry learns: reading the registry here
  // would reconnect to the address the user just left.
  const s = store({
    tmux_servers: registry, tmux_server_current: 'a', tmux_machines: machines,
    tmux_address: 'ws://a-ts:9899', tmux_token: 'tA2', tmux_machine_id: 'm-a',
  });
  assert.deepEqual(targetOf(s, 'a'), {
    address: 'ws://a-ts:9899', token: 'tA2', machineId: 'm-a', alternates: ['ws://a-lan:9899'],
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

test('a client with no registry yet reconnects the mirror, as before', () => {
  // CURRENT is '' and so is the id App asks for: the mirror is the server.
  assert.deepEqual(targetOf(store({ tmux_address: 'ws://x:9899', tmux_token: 't' }), ''), {
    address: 'ws://x:9899', token: 't', machineId: '', alternates: [],
  });
  assert.equal(targetOf(store({}), ''), null, 'and with no address there is nothing to reconnect');
});
