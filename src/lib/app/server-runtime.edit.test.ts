// A runtime's dial reads its entry before it awaits the answer (board #402
// review P1-A). In Aggregate a background server can be reconnecting while
// its row is edited in Settings › Connection: the edit is the newest
// explicit configuration, and the commit of that older dial must not undo it.
// The real runtime and the real storage half run against a connection whose
// handshake the case holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RPC_KIND } from '../core/ws-api.ts';
import type { ConnectionSlot } from '../core/connection-registry.ts';
import { createServerRuntime } from './server-runtime.ts';
import { loadServers, removeServerAddress, serverAddresses, setServerToken } from './servers.ts';

function mem(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } };
}

function rig() {
  const storage = mem({
    tmux_servers: JSON.stringify([
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
    ]),
    tmux_server_current: 'a',
    tmux_machines: JSON.stringify({ 'm-b': ['ws://b:9899', 'ws://b-ts:9899'] }),
  });
  const dials: string[] = [];
  let held: (() => void) | null = null;
  let holding = false;
  const connection = {
    async connect(address: string, token: string) {
      dials.push(`${address} ${token}`);
      if (holding) await new Promise<void>((r) => { held = r; });
      return 'm-b';
    },
    disconnect() {}, dispose() {}, getMachineId: () => 'm-b', getHostname: () => 'b', getBuild: () => null,
  };
  const api: Record<string, () => Promise<unknown>> = {};
  for (const name of Object.keys(RPC_KIND)) api[name] = async () => ({});
  const runtime = createServerRuntime(loadServers(storage).find((s) => s.id === 'b')!, { storage, slot: { connection, api } as unknown as ConnectionSlot });
  return {
    storage, runtime, dials,
    hold() { holding = true; },
    async release() { holding = false; const go = held; held = null; go?.(); for (let i = 0; i < 5; i++) await Promise.resolve(); },
    beta: () => loadServers(storage).find((s) => s.id === 'b')!,
  };
}

test('a held dial, then a token change, then the dial authenticates: the saved token stays, and the next dial uses it (#402 review P1-A)', async () => {
  const r = rig();
  r.hold();
  const dialling = r.runtime.dial();
  await Promise.resolve();
  assert.deepEqual(r.dials, ['ws://b:9899 tokB'], 'the dial read the old token');
  setServerToken(r.storage, 'b', 'tokB-new');
  await r.release();
  const result = await dialling;
  assert.equal(result.ok, true, 'the live connection authenticated and is kept: nothing re-dials');
  assert.equal(r.beta().token, 'tokB-new', 'the older dial does not write its token back');
  await r.runtime.dial();
  assert.equal(r.dials.at(-1), 'ws://b:9899 tokB-new', 'the next dial reads the saved token');
});

test('a held dial to an alternate, then that alternate is removed, then it answers: it is not made active nor put back (#402 review P1-A)', async () => {
  const r = rig();
  r.hold();
  const dialling = r.runtime.dial(() => true, { via: 'ws://b-ts:9899' });
  await Promise.resolve();
  assert.deepEqual(removeServerAddress(r.storage, 'b', 'ws://b-ts:9899'), { addresses: ['ws://b:9899'] });
  await r.release();
  assert.equal((await dialling).ok, true);
  assert.equal(r.beta().address, 'ws://b:9899', 'the removed address does not become the active one');
  assert.deepEqual(serverAddresses(r.storage, 'b'), ['ws://b:9899']);
  await r.runtime.dial();
  assert.equal(r.dials.at(-1), 'ws://b:9899 tokB', 'the next dial goes to the saved address');
});

test('without an edit in between, a dial records its address and token as before', async () => {
  const r = rig();
  const result = await r.runtime.dial(() => true, { via: 'ws://b-ts:9899' });
  assert.equal(result.ok, true);
  assert.equal(r.beta().address, 'ws://b-ts:9899', 'the address that just worked is the active one');
  assert.equal(r.beta().token, 'tokB');
});
