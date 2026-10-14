// A runtime reports the build its live socket's server named (board #368), and
// nothing it remembers: unlike a hostname an entry adopts, a build is a fact
// about the process answering NOW.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionSlot } from '../core/connection-registry.ts';
import type { BuildInfo } from '../core/build-info.ts';
import { createServerRuntime } from './server-runtime.ts';

const storage = (() => {
  const m = new Map<string, string>([
    ['tmux_servers', JSON.stringify([{ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }])],
    ['tmux_server_current', 'a'],
  ]);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
})();

const BUILD: BuildInfo = { version: '1.0.0', commit: '46392f16', built: '2026-10-14 07:40' };

function runtimeOver(answer: () => BuildInfo | null | undefined) {
  const connection = { connect: async () => 'm-a', disconnect() {}, dispose() {}, getMachineId: () => 'm-a', getHostname: () => 'a', getBuild: answer };
  return createServerRuntime({ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }, { storage, slot: { connection, api: {} } as unknown as ConnectionSlot });
}

test('the runtime\'s build is the live socket\'s, asked each time: named, none, then gone', () => {
  let live: BuildInfo | null | undefined = BUILD;
  const runtime = runtimeOver(() => live);
  assert.deepEqual(runtime.build(), BUILD);
  live = null;
  assert.equal(runtime.build(), null, 'an older server named none');
  live = undefined;
  assert.equal(runtime.build(), undefined, 'a closed socket: the last answer is not remembered');
});
