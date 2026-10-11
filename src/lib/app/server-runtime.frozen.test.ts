// A blocked app refuses NEW writes and keeps its reads (board #335 ③a,
// orchestrator's P1-D ruling 08:21). The gate is the runtime's api, so the
// question is asked when a call is MADE — a method a page captured long ago
// included — and the table it asks is `RPC_KIND`, the one classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection } from '../core/connection.ts';
import { RPC_KIND, createWsApi } from '../core/ws-api.ts';
import type { ConnectionSlot } from '../core/connection-registry.ts';
import { createServerRuntime } from './server-runtime.ts';

const storage = (() => {
  const m = new Map<string, string>([
    ['tmux_servers', JSON.stringify([{ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }])],
    ['tmux_server_current', 'a'],
  ]);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
})();

test('every RPC wrapper is classified read or write, and nothing else is in the table', () => {
  const api = createWsApi(createConnection());
  const wrappers = Object.keys(api).filter((k) => typeof (api as Record<string, unknown>)[k] === 'function').sort();
  assert.deepEqual(Object.keys(RPC_KIND).sort(), wrappers, 'a new wrapper must be classified; a removed one leaves the table');
  for (const [name, kind] of Object.entries(RPC_KIND)) assert.ok(kind === 'read' || kind === 'write', `${name}: ${kind}`);
});

test('the classification of what a blocked app must not send, and must still read', () => {
  // The writes a person makes from a mounted page, and the reads K keeps.
  for (const name of ['sendKeys', 'pasteText', 'hubPost', 'hubRead', 'fsWrite', 'fsUpload', 'boardSave', 'registrySave',
    'globalPromptSet', 'projectRename', 'killSession', 'newWindow', 'gitCmd', 'setPref', 'saveBookmarks']) {
    assert.equal(RPC_KIND[name as keyof typeof RPC_KIND], 'write', name);
  }
  for (const name of ['listSessionsWithPanes', 'capturePane', 'projectList', 'hubRooms', 'hubUnread', 'hubLog',
    'fsList', 'fsRead', 'fsDownloadUrl', 'fsDownloadHttp', 'systemStatus', 'boardList', 'registryList']) {
    assert.equal(RPC_KIND[name as keyof typeof RPC_KIND], 'read', name);
  }
});

/** A slot whose api records what reached it and can hold a call open. */
function slot() {
  const sent: string[] = [];
  let release: () => void = () => {};
  const api: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const name of Object.keys(RPC_KIND)) api[name] = async () => { sent.push(name); return {}; };
  api.hubPost = () => { sent.push('hubPost'); return new Promise((r) => { release = () => r({ ok: true }); }); };
  api.unlisted = async () => { sent.push('unlisted'); return {}; };
  const connection = { connect: async () => 'm-a', disconnect() {}, dispose() {}, getMachineId: () => 'm-a', getHostname: () => 'a' };
  return { slot: { connection, api } as unknown as ConnectionSlot, sent, finish: () => release() };
}

test('frozen: a NEW write is refused with the reason, a read goes through, a write already sent completes', async () => {
  const { slot: s, sent, finish } = slot();
  const runtime = createServerRuntime({ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }, { storage, slot: s });
  const post = runtime.api.hubPost;            // a page captured it at init
  const inFlight = post('proj:work', 'sent before the block');
  runtime.setFrozen(true);
  assert.equal(runtime.frozen(), true);
  await assert.rejects(post('proj:work', 'after'), /frozen: a writes nothing until the app's storage is recorded/u, 'the captured method asks at call time');
  await assert.rejects(runtime.api.sendKeys('work:1.0', 'x'), /frozen/u);
  await assert.rejects(runtime.api.fsWrite('/a', 'x'), /frozen/u);
  const unlisted = (runtime.api as unknown as Record<string, () => Promise<unknown>>).unlisted!;
  await assert.rejects(unlisted(), /frozen/u, 'a name the table does not know is not a read');
  await runtime.api.listSessionsWithPanes();
  await runtime.api.fsDownloadHttp('/a/x.png');
  finish();
  assert.deepEqual(await inFlight, { ok: true }, 'the write on the wire before the block completes');
  assert.deepEqual(sent, ['hubPost', 'listSessionsWithPanes', 'fsDownloadHttp'], 'nothing refused reached the slot, and nothing is replayed');

  runtime.setFrozen(false);
  void post('proj:work', 'after Retry');
  finish();
  assert.deepEqual(sent.slice(-1), ['hubPost'], 'thawed, the person s next send goes');
  assert.equal(runtime.alive(), true, 'freezing never ended the handle');
});

test('detached still refuses everything, frozen or not', async () => {
  const { slot: s } = slot();
  const runtime = createServerRuntime({ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }, { storage, slot: s });
  runtime.setFrozen(true);
  runtime.detach();
  await assert.rejects(runtime.api.listSessionsWithPanes(), /detached/u);
});

test('a frozen runtime over a REAL connection: a write never reaches the socket, a read does (#335 ③a)', async () => {
  const { MockWebSocket, handshakePlain, installDoubles } = await import('../core/connection.fixture.ts');
  const { createConnectionRegistry } = await import('../core/connection-registry.ts');
  installDoubles();
  const registry = createConnectionRegistry();
  const runtime = createServerRuntime({ id: 'a', name: 'alpha', address: 'ws://a:9899', token: 'tokA', machineId: 'm-a' }, { storage, slot: registry.ensure('a') });
  const socket = await handshakePlain(runtime.connection, 'ws://a:9899', 'tokA', 'm-a');
  const sent = () => socket.texts().map((f: { method: string }) => f.method);
  runtime.setFrozen(true);
  await assert.rejects(runtime.api.fsWrite('/a/notes.md', 'x'), /frozen/u);
  await assert.rejects(runtime.api.hubPost('proj:work', 'hi'), /frozen/u);
  void runtime.api.fsList('/a').catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!sent().includes('fs_write') && !sent().includes('hub_post'), `no write on the wire: ${sent().join(' ')}`);
  assert.ok(sent().includes('fs_list'), 'the read went out');
  runtime.setFrozen(false);
  void runtime.api.fsWrite('/a/notes.md', 'x').catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(sent().includes('fs_write'), 'thawed, the write goes');
  registry.disposeAll();
  void MockWebSocket;
});
