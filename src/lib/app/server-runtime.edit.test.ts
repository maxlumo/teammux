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
import { loadServers, recordServer, removeServerAddress, serverAddresses, setServerToken } from './servers.ts';
import { targetOf } from './server-target.ts';

function mem(init: Record<string, string>) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } };
}

const TWO = [
  { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
  { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', machineId: 'm-b', named: true },
];
/** The runtime is beta's; `answers` is the machine beta's dial reaches. */
function rig({ servers = TWO, answers = 'm-b' }: { servers?: object[]; answers?: string } = {}) {
  const storage = mem({
    tmux_servers: JSON.stringify(servers),
    tmux_server_current: 'a',
    tmux_machines: JSON.stringify({ 'm-a': ['ws://a:9899'], 'm-b': ['ws://b:9899', 'ws://b-ts:9899'] }),
  });
  const dials: string[] = [];
  let held: (() => void) | null = null;
  let holding = false;
  const connection = {
    async connect(address: string, token: string) {
      dials.push(`${address} ${token}`);
      if (holding) await new Promise<void>((r) => { held = r; });
      return answers;
    },
    disconnect() {}, dispose() {}, getMachineId: () => answers, getHostname: () => answers, getBuild: () => null,
  };
  const api: Record<string, () => Promise<unknown>> = {};
  for (const name of Object.keys(RPC_KIND)) api[name] = async () => ({});
  const runtime = createServerRuntime(loadServers(storage).find((s) => s.id === 'b')!, { storage, slot: { connection, api } as unknown as ConnectionSlot });
  return {
    storage, runtime, dials, connection, api,
    hold() { holding = true; },
    async release() { holding = false; const go = held; held = null; go?.(); for (let i = 0; i < 5; i++) await Promise.resolve(); },
    beta: () => loadServers(storage).find((s) => s.id === 'b')!,
    alpha: () => loadServers(storage).find((s) => s.id === 'a')!,
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

// Review P1-A residual (b): the commit protects the entry the answer RESOLVED
// to, not only the one that was dialled.
test('a held dial to beta that answers as saved alpha, with alpha s token changed meanwhile: alpha keeps its new token (#402 review P1-A residual)', async () => {
  const r = rig({ answers: 'm-a' });
  r.hold();
  const dialling = r.runtime.dial();
  await Promise.resolve();
  setServerToken(r.storage, 'a', 'tokA-new');
  await r.release();
  const result = await dialling;
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'elsewhere', 'beta s address reaches alpha');
  assert.equal(r.alpha().token, 'tokA-new', 'the older dial does not write beta s token onto alpha');
  assert.equal(r.beta().token, 'tokB', 'beta is untouched');
  // Without an edit, the answer records on alpha as before.
  const u = rig({ answers: 'm-a' });
  await u.runtime.dial();
  assert.equal(u.alpha().token, 'tokB', 'unchanged behaviour: the credential that worked is recorded on the machine it reached');
  assert.equal(u.alpha().address, 'ws://b:9899');
});

test('a held dial of a machine-less alias that answers as alpha absorbs it into alpha, and alpha s token changed meanwhile is kept (#402 review P1-A residual)', async () => {
  const r = rig({
    servers: [
      { id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a', named: true },
      { id: 'b', name: 'beta', address: 'ws://b:9899', token: 'tokB', named: true },
    ],
    answers: 'm-a',
  });
  r.hold();
  const dialling = r.runtime.dial();
  await Promise.resolve();
  setServerToken(r.storage, 'a', 'tokA-new');
  await r.release();
  await dialling;
  const ids = loadServers(r.storage).map((s) => s.id);
  assert.deepEqual(ids, ['a'], 'the alias is absorbed into alpha, as before');
  assert.equal(r.alpha().token, 'tokA-new', 'and alpha keeps the token saved while the dial was held');
});

// Review round 3 P1-A residual: an entry SAVED after the dial's snapshot is
// newer than the dial, though the snapshot never saw it.
test('a held dial to beta, then alpha is saved and its token edited, then beta answers as alpha: alpha keeps its newest token, and the next dial of alpha sends it (#402 review round 3)', async () => {
  const r = rig({ servers: [TWO[1]!], answers: 'm-a' });
  r.hold();
  const dialling = r.runtime.dial();
  await Promise.resolve();
  const { entry: alpha } = recordServer(r.storage, { address: 'ws://a:9899', token: 'tokA-saved', machineId: 'm-a' });
  setServerToken(r.storage, alpha.id, 'tokA-edited');
  await r.release();
  const result = await dialling;
  assert.equal(result.ok === false && result.reason, 'elsewhere');
  const saved = loadServers(r.storage).find((s) => s.id === alpha.id)!;
  assert.equal(saved.token, 'tokA-edited', 'the older dial does not write beta s token onto the alpha saved after it began');
  assert.equal(targetOf(r.storage, alpha.id)?.token, 'tokA-edited', 'and the one reader every dial asks gives the newest token');
  const runtimeA = createServerRuntime(saved, { storage: r.storage, slot: { connection: r.connection, api: r.api } as unknown as ConnectionSlot });
  await runtimeA.dial();
  assert.match(r.dials.at(-1)!, / tokA-edited$/u, 'the next dial of alpha sends it');
  // Without an edit and without an observation of alpha, the creation path
  // when NO entry exists at the commit is unchanged: the answer creates alpha.
  const u = rig({ servers: [TWO[1]!], answers: 'm-a' });
  await u.runtime.dial();
  const created = loadServers(u.storage).find((s) => s.machineId === 'm-a');
  assert.equal(created?.token, 'tokB', 'a machine reached for the first time is recorded with the credential that worked');
});

test('a failed dial names the token IT sent: an edit that lands while it is out does not become the one refused (#458 review on the token state, P1-B)', async () => {
  const r = rig();
  r.hold();
  let refuse = false;
  const connect = r.connection.connect.bind(r.connection);
  r.connection.connect = async (address: string, token: string) => {
    const answer = await connect(address, token);
    if (refuse) throw Object.assign(new Error('invalid proof'), { code: -32000 });
    return answer;
  };
  refuse = true;
  const dialling = r.runtime.dial();
  await Promise.resolve();
  setServerToken(r.storage, 'b', 'tokB-new');
  await r.release();
  const result = await dialling;
  assert.equal(result.ok, false);
  assert.deepEqual(result.ok === false && result.reason === 'failed' ? result.tried : undefined, { address: 'ws://b:9899', token: 'tokB' }, 'the attempt s own address and token, never the entry s current ones');
  assert.equal(r.beta().token, 'tokB-new', 'and the edit stands');
});

test('a dial sends the pair its caller decided — the token passed, not the entry s token re-read — and an attempt not owned when it would send sends nothing (#458 ruling on 77e1185d)', async () => {
  const r = rig();
  setServerToken(r.storage, 'b', 'tokB-edited');       // an edit after the caller's check
  const result = await r.runtime.dial(() => true, { via: 'ws://b-ts:9899', token: 'tokB' });
  assert.deepEqual(r.dials, ['ws://b-ts:9899 tokB'], 'the checked pair is the dialled pair');
  assert.equal(result.ok, true);
  const stale = await r.runtime.dial(() => false, { via: 'ws://b:9899', token: 'tokB' });
  assert.deepEqual(stale, { ok: false, reason: 'superseded' });
  assert.equal(r.dials.length, 1, 'not owned at the send: nothing sent');
});
