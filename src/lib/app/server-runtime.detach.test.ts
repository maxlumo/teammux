// A runtime that stops serving can be OBSERVED (board #357): `alive()` is a
// plain read, so a reactive host needs the edge. One notification, once,
// after `alive()` is already false, whoever ends the handle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RPC_KIND } from '../core/ws-api.ts';
import type { ConnectionSlot } from '../core/connection-registry.ts';
import { createServerRuntime } from './server-runtime.ts';

const storage = (() => {
  const m = new Map<string, string>([
    ['tmux_servers', JSON.stringify([{ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }])],
    ['tmux_server_current', 'a'],
  ]);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
})();
const build = () => {
  const api: Record<string, () => Promise<unknown>> = {};
  for (const name of Object.keys(RPC_KIND)) api[name] = async () => ({});
  const connection = { connect: async () => 'm-a', disconnect() {}, dispose() {}, getMachineId: () => 'm-a', getHostname: () => 'a' };
  return createServerRuntime({ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }, { storage, slot: { connection, api } as unknown as ConnectionSlot });
};

test('detach() tells every listener once, after alive() is already false', () => {
  const runtime = build();
  const seen: boolean[] = [];
  runtime.onDetach(() => seen.push(runtime.alive()));
  runtime.onDetach(() => seen.push(runtime.alive()));
  assert.deepEqual(seen, [], 'nothing before the end');
  runtime.detach();
  assert.deepEqual(seen, [false, false], 'both told, and the handle already refuses');
  runtime.detach();
  runtime.dispose();
  assert.equal(seen.length, 2, 'a second end of an ended handle tells nobody again');
});

test('dispose() of a live handle is an end too; an unsubscribed listener is not told', () => {
  const runtime = build();
  let told = 0, gone = 0;
  runtime.onDetach(() => told++);
  const off = runtime.onDetach(() => gone++);
  off();
  runtime.dispose();
  assert.equal(told, 1);
  assert.equal(gone, 0);
});

test('a listener that throws does not undo the detach nor starve the others', () => {
  const runtime = build();
  let reached = false;
  runtime.onDetach(() => { throw new Error('listener failed'); });
  runtime.onDetach(() => { reached = true; });
  runtime.detach();
  assert.equal(runtime.alive(), false);
  assert.equal(reached, true);
});
