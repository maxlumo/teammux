// Two-server behaviour of the in-place switch (board 315, reviewer P1 #4).
// The real switch (server-switch.ts), the real storage half (servers.ts),
// the real leave guards and the real download core run against two fake
// servers that answer as machine A or B. The fake transport has ws.ts's
// shape: one socket, requests go to whatever it is connected to, and
// disconnect() rejects everything still pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSwitch, type SwitchState, type SwitchTarget } from './server-switch.ts';
import { currentServerId, loadServers, migrateServers, PARKED_KEYS, recordServer, STATE_PREFIX } from './servers.ts';
import { clearLeaveGuardsForTests, confirmLeave, registerLeaveGuard } from './leave-guards.ts';
import { download, SUSPEND, type DownloadSink } from '../files/download.ts';

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

/** Two servers behind one socket. `fail(addr, n)` makes the next n connects
 * to addr reject; `hold()` returns a request that resolves only when told. */
function world() {
  const servers: Record<string, { machine: string; sessions: string[] }> = {
    'ws://a:1': { machine: 'm-a', sessions: ['app'] },
    'ws://a-ts:9': { machine: 'm-a', sessions: ['app'] },
    'ws://b:2': { machine: 'm-b', sessions: ['app'] },
  };
  let at: string | null = null;
  const fails = new Map<string, number>();
  const pending = new Set<{ reject: (e: Error) => void }>();
  const log: string[] = [];
  return {
    log,
    get at() { return at; },
    fail(addr: string, n: number) { fails.set(addr, n); },
    async connect(addr: string) {
      const n = fails.get(addr) ?? 0;
      if (n > 0) { fails.set(addr, n - 1); throw new Error('connection timeout'); }
      if (!servers[addr]) throw new Error('connection failed');
      at = addr;
    },
    disconnect() {
      at = null;
      for (const p of pending) p.reject(new Error('disconnected'));
      pending.clear();
    },
    machineId() { return at ? servers[at]!.machine : ''; },
    /** An RPC: answered by the server the socket is on NOW, or rejected. */
    call(method: string): Promise<string> {
      if (!at) return Promise.reject(new Error('not connected'));
      const on = servers[at]!.machine;
      log.push(`${on}:${method}`);
      return Promise.resolve(`${on}:${method}`);
    },
    /** A slow RPC whose answer arrives when `release()` is called. */
    hold(method: string) {
      if (!at) return { promise: Promise.reject(new Error('not connected')), release() {} };
      const on = servers[at]!.machine;
      let ok!: (v: string) => void; let ko!: (e: Error) => void;
      const promise = new Promise<string>((res, rej) => { ok = res; ko = rej; });
      const entry = { reject: ko };
      pending.add(entry);
      return { promise, release() { if (pending.delete(entry)) ok(`${on}:${method}`); } };
    },
  };
}

/** The app around the switch: a connected flag, the hub keys a component
 * writes on unmount, and a mounted/unmounted content tree. */
function app(storage = mem({
  tmux_address: 'ws://a:1', tmux_token: 'ta', tmux_machine_id: 'm-a',
  tmux_machines: JSON.stringify({ 'm-a': ['ws://a:1'] }),
  tmux_state: '{"page":"terminal","terminalTarget":"app:1.1","terminalSession":"app"}',
  tmux_hub_project: 'app', tmux_hub_drafts: JSON.stringify({ app: 'draft on A' }),
})) {
  migrateServers(storage);
  const w = world();
  w.connect('ws://a:1');
  const a = loadServers(storage)[0]!;
  const b = recordServer(storage, { address: 'ws://b:2', token: 'tb', machineId: 'm-b' }).entry;
  let connected = true;
  let mounted = true;
  const states: (SwitchState | null)[] = [];
  const unmountWrites: (() => void)[] = [];
  const resets: string[] = [];
  const reconnects: string[] = [];
  const published: string[] = [];
  const sw = createServerSwitch({
    storage,
    connected: () => connected,
    currentId: () => currentServerId(storage),
    currentName: () => loadServers(storage).find((s) => s.id === currentServerId(storage))?.name ?? '',
    confirmLeave: () => confirmLeave({ leaving: null, current: 'hub', reveal: async () => {}, hold: () => {} }),
    stopReconnect: () => { reconnects.push('stop'); },
    startReconnect: () => { reconnects.push(`start ${storage.getItem('tmux_address')}`); },
    addressUp: (addr) => { published.push(addr); },
    onstate: (st) => { states.push(st); if (st) { connected = false; mounted = false; } },
    suspendDownloads: async () => { for (const s of suspenders) await s(); },
    afterUnmount: async () => { for (const f of unmountWrites.splice(0)) f(); },
    disconnect: () => w.disconnect(),
    resetMemory: () => { resets.push('reset'); },
    connect: (addr) => w.connect(addr),
    setSocket: async () => {},
    machineId: () => w.machineId(),
    comeUp: () => { connected = true; mounted = true; },
  });
  const suspenders: (() => Promise<void>)[] = [];
  return { storage, w, a, b, sw, states, unmountWrites, resets, suspenders, reconnects, published,
    get connected() { return connected; }, get mounted() { return mounted; } };
}

test.beforeEach(() => clearLeaveGuardsForTests());

test('A→B→A with a same-named project keeps each server’s state (board 315)', async () => {
  const t = app();
  // The Hub writes its draft on unmount — under A, before A is parked.
  t.unmountWrites.push(() => t.storage.setItem('tmux_hub_drafts', JSON.stringify({ app: 'draft on A, last keystroke' })));
  await t.sw.switchTo(t.b);
  assert.equal(t.w.at, 'ws://b:2');
  assert.equal(currentServerId(t.storage), t.b.id);
  assert.equal(t.storage.getItem('tmux_hub_drafts'), null, 'B’s project `app` does not inherit A’s draft');
  assert.equal(t.storage.getItem('tmux_hub_project'), null);
  assert.equal(t.storage.getItem('tmux_state'), null, 'B starts on no target of A’s');
  assert.ok(t.connected && t.mounted, 'B is up, tree remounted');
  // On B the user opens `app` and types.
  t.storage.setItem('tmux_hub_project', 'app');
  t.storage.setItem('tmux_hub_drafts', JSON.stringify({ app: 'draft on B' }));
  t.storage.setItem('tmux_state', '{"page":"hub"}');
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.a.id)!);
  assert.equal(t.w.at, 'ws://a:1');
  assert.equal(t.storage.getItem('tmux_hub_drafts'), JSON.stringify({ app: 'draft on A, last keystroke' }));
  assert.equal(t.storage.getItem('tmux_state'), '{"page":"terminal","terminalTarget":"app:1.1","terminalSession":"app"}');
  assert.equal(t.storage.getItem(`tmux_hub_drafts::${t.b.id}`), JSON.stringify({ app: 'draft on B' }), 'B’s parked for later');
});

test('acceptance: B fails twice → Back to A, A’s page, drafts and terminal target unchanged', async () => {
  const t = app();
  const before = Object.fromEntries(PARKED_KEYS.map((k) => [k, t.storage.getItem(k)]));
  t.w.fail('ws://b:2', 2);
  await t.sw.switchTo(t.b);
  assert.equal(t.sw.state?.phase, 'failed');
  assert.equal(t.sw.state?.from?.id, t.a.id, 'the source is frozen');
  assert.equal(currentServerId(t.storage), t.a.id, 'CURRENT never moved to a server that did not answer');
  assert.equal(t.storage.getItem('tmux_address'), 'ws://a:1', 'nor did the mirror');
  // A stray write in the failed world (nothing is mounted to make one, but
  // the rule must not depend on that): it must not become A's park.
  t.storage.setItem('tmux_state', '{"page":"settings"}');
  await t.sw.retry();
  assert.equal(t.sw.state?.phase, 'failed', 'second failure');
  const parked = t.storage.getItem(STATE_PREFIX + t.a.id);
  await t.sw.back(loadServers(t.storage));
  assert.equal(t.sw.state, null);
  assert.equal(t.w.at, 'ws://a:1');
  assert.equal(t.storage.getItem(STATE_PREFIX + t.a.id), parked, 'retry/back never re-parked A');
  for (const k of PARKED_KEYS) assert.equal(t.storage.getItem(k), before[k], `${k} is A’s, as before`);
});

test('a delayed read started on A never lands in B’s world', async () => {
  const t = app();
  const slow = t.w.hold('fs_list');
  let landed: string | null = null;
  const consumer = slow.promise.then((v) => { landed = v; }, () => { landed = 'rejected'; });
  const intent = t.sw.intent;
  await t.sw.switchTo(t.b);
  slow.release(); // A's answer, after B is up
  await consumer;
  assert.equal(landed, 'rejected', 'the socket switch rejected A’s pending read');
  assert.equal(t.sw.owns(intent), false, 'and an App-level async from before the switch is not current');
});

test('a running download is suspended, keeps its part, and never re-signs after the abort', async () => {
  const t = app();
  const signed: string[] = [];
  const ctrl = new AbortController();
  let kept: boolean | null = null;
  const sink: DownloadSink = {
    async open() { return { received: 0, etag: null }; },
    async reset() {}, async write() {}, async flush() {},
  };
  // The link dropped once; the attempt is waiting out its retry delay when
  // the switch arrives. Its next step would be a re-sign of the /dl URL.
  let wake!: () => void;
  const waiting = new Promise<void>((r) => { wake = r; });
  let inSleep!: () => void;
  const sleeping = new Promise<void>((r) => { inSleep = r; });
  const attempt = download({
    url: 'http://a/dl?sig=1', sink, signal: ctrl.signal,
    fetch: (async () => { throw new Error('network down'); }) as never,
    sleep: async () => { inSleep(); await waiting; },
    freshUrl: async () => { signed.push(await t.w.call('fs_download_http')); return 'http://x'; },
  }).catch((e) => { kept = !!(e?.cancelled && e.keepPart); });
  await sleeping;
  t.suspenders.push(async () => { ctrl.abort(SUSPEND); wake(); await attempt; });
  await t.sw.switchTo(t.b);
  assert.equal(kept, true, 'stopped as a suspend: the part is kept for a resume on A');
  assert.deepEqual(signed, [], 'no re-sign went out after the abort');
  assert.ok(!t.w.log.some((l) => l.startsWith('m-b:fs_download')), 'B was never asked for A’s file');
});

test('a dirty editor’s cancel leaves A connected and every key untouched', async () => {
  const t = app();
  const snapshot = JSON.stringify(PARKED_KEYS.map((k) => t.storage.getItem(k)));
  let asked = 0;
  const off = registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: async () => { asked++; return false; } });
  await t.sw.switchTo(t.b);
  off();
  assert.equal(asked, 1);
  assert.equal(t.sw.state, null);
  assert.equal(t.w.at, 'ws://a:1');
  assert.ok(t.connected && t.mounted);
  assert.equal(t.resets.length, 0, 'nothing was reset');
  assert.equal(JSON.stringify(PARKED_KEYS.map((k) => t.storage.getItem(k))), snapshot);
  assert.equal(t.storage.getItem(STATE_PREFIX + t.a.id), null, 'not even parked');
});

test('a second address of the SAME machine folds into its entry and restores its state', async () => {
  const t = app();
  // Leave A for B, then add A's Tailscale address as if it were new.
  await t.sw.switchTo(t.b);
  const candidate: SwitchTarget = { id: '', name: 'a-ts', address: 'ws://a-ts:9', token: 'ta' };
  await t.sw.switchTo(candidate);
  assert.equal(loadServers(t.storage).length, 2, 'no third "server"');
  assert.equal(currentServerId(t.storage), t.a.id, 'the identity the server reported decides');
  assert.equal(t.storage.getItem('tmux_hub_drafts'), JSON.stringify({ app: 'draft on A' }), 'A’s state, not a fresh start');
  assert.equal(t.storage.getItem('tmux_address'), 'ws://a-ts:9');
});

test('a superseded switch (A→B→C style) drops the older intent’s completion', async () => {
  const t = app();
  let releaseB!: () => void;
  const gate = new Promise<void>((r) => { releaseB = r; });
  const slowConnect = t.w.connect;
  // B's connect hangs; the connect page then takes the socket (supersede).
  (t.w as { connect: (a: string) => Promise<void> }).connect = async (addr: string) => { if (addr === 'ws://b:2') await gate; return slowConnect(addr); };
  const first = t.sw.switchTo(t.b);
  await new Promise((r) => setTimeout(r, 0));
  t.sw.supersede();
  releaseB();
  await first;
  assert.notEqual(currentServerId(t.storage), t.b.id, 'B’s late success did not activate');
});

test('an address connect of A still dialing when a switch to B starts neither reconnects A nor touches B (review P1)', async () => {
  const t = app();
  // The Connection page taps A's Tailscale address; it is still dialing.
  let releaseA!: () => void;
  const gate = new Promise<void>((r) => { releaseA = r; });
  const real = t.w.connect.bind(t.w);
  (t.w as { connect: (a: string) => Promise<void> }).connect = async (addr: string) => {
    if (addr === 'ws://a-ts:9') { await gate; throw new Error('disconnected'); }
    return real(addr);
  };
  const tap = t.sw.connectAddress('ws://a-ts:9', 'ta');
  await new Promise((r) => setTimeout(r, 0));
  // Meanwhile the user picks B.
  await t.sw.switchTo(t.b);
  assert.equal(t.w.at, 'ws://b:2');
  releaseA(); // A's attempt now rejects, as the switch's disconnect made it
  assert.equal(await tap, false);
  assert.deepEqual(t.reconnects.filter((r) => r.startsWith('start')), [], 'no reconnect loop started for anyone');
  assert.deepEqual(t.published, [], 'A’s attempt published nothing');
  assert.equal(t.w.at, 'ws://b:2', 'B’s socket untouched');
  assert.equal(currentServerId(t.storage), t.b.id);
  assert.equal(t.storage.getItem('tmux_address'), 'ws://b:2');
});

test('an address connect that fails on its own (no switch) still hands over to the reconnect loop', async () => {
  const t = app();
  t.w.fail('ws://a:1', 1);
  assert.equal(await t.sw.connectAddress('ws://a:1', 'ta'), false);
  assert.deepEqual(t.reconnects.filter((r) => r.startsWith('start')), ['start ws://a:1']);
  assert.equal(await t.sw.connectAddress('ws://a:1', 'ta'), true);
  assert.deepEqual(t.published, ['ws://a:1']);
});
