// Two-server behaviour of the in-place switch (board 315, reviewer P1 #4).
// The real switch (server-switch.ts), the real storage half (servers.ts),
// the real leave guards and the real download core run against two fake
// servers that answer as machine A or B. The fake transport has ws.ts's
// shape: one socket, requests go to whatever it is connected to, and
// disconnect() rejects everything still pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSwitch, type SwitchState, type SwitchTarget } from './server-switch.ts';
import { currentServerId, loadServers, migrateServers, RESIDENT_KEYS, recordServer, residentKey } from './servers.ts';
import { migrateServerState } from './server-state-migration.ts';
import { createServerStore } from './server-store.ts';
import { clearLeaveGuardsForTests, confirmLeave, registerLeaveGuard } from './leave-guards.ts';
import { createHandovers } from './handover.ts';
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
  // The boot's fold: A's pre-#335 live keys are A's slots from here on.
  migrateServerState(storage);
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
  const handovers = createHandovers({ end: () => {} });
  let looping = false;
  let frozen = false;
  let gate: (target: SwitchTarget) => void = () => {};
  const sw = createServerSwitch({
    storage,
    connected: () => connected,
    currentId: () => currentServerId(storage),
    currentName: () => loadServers(storage).find((s) => s.id === currentServerId(storage))?.name ?? '',
    confirmLeave: () => confirmLeave({ leaving: null, current: 'hub', reveal: async () => {}, hold: () => {} }),
    claim: () => handovers.claim(),
    frozen: () => frozen,
    identityFailed: (target) => { gate(target); },
    stopReconnect: () => { reconnects.push('stop'); looping = false; },
    reconnecting: () => looping,
    startReconnect: () => { reconnects.push(`start ${storage.getItem('tmux_address')}`); looping = true; },
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
  /** What a page writes and reads: the server it is bound to, its slots. */
  const slot = (id: string) => createServerStore(storage, id);
  /** Every key of every slot, and the legacy keys: what nothing may touch. */
  const everything = () => JSON.stringify([...RESIDENT_KEYS].flatMap((k) => [storage.getItem(k), ...[a.id, b.id].map((id) => storage.getItem(residentKey(k, id)))]));
  return { storage, slot, everything, w, a, b, sw, handovers, states, loop: (on: boolean) => { looping = on; }, freeze: (on: boolean) => { frozen = on; }, onGate: (fn: (target: SwitchTarget) => void) => { gate = fn; }, unmountWrites, resets, suspenders, reconnects, published,
    get connected() { return connected; }, get mounted() { return mounted; } };
}

test.beforeEach(() => clearLeaveGuardsForTests());

test('A→B→A with a same-named project keeps each server’s state (board 315)', async () => {
  const t = app();
  const [a, b] = [t.slot(t.a.id), t.slot(t.b.id)];
  // The Hub writes its draft on unmount — into A's slot, the server it is
  // bound to; nothing is parked (board #335 ②b-4).
  t.unmountWrites.push(() => a.setItem('tmux_hub_drafts', JSON.stringify({ app: 'draft on A, last keystroke' })));
  await t.sw.switchTo(t.b);
  assert.equal(t.w.at, 'ws://b:2');
  assert.equal(currentServerId(t.storage), t.b.id);
  assert.equal(b.getItem('tmux_hub_drafts'), null, 'B’s project `app` does not inherit A’s draft');
  assert.equal(b.getItem('tmux_hub_project'), null);
  assert.equal(b.getItem('tmux_state'), null, 'B starts on no target of A’s');
  assert.ok(t.connected && t.mounted, 'B is up, tree remounted');
  // On B the user opens `app` and types.
  b.setItem('tmux_hub_project', 'app');
  b.setItem('tmux_hub_drafts', JSON.stringify({ app: 'draft on B' }));
  b.setItem('tmux_state', '{"page":"hub"}');
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.a.id)!);
  assert.equal(t.w.at, 'ws://a:1');
  assert.equal(a.getItem('tmux_hub_drafts'), JSON.stringify({ app: 'draft on A, last keystroke' }));
  assert.equal(a.getItem('tmux_state'), '{"page":"terminal","terminalTarget":"app:1.1","terminalSession":"app"}');
  assert.equal(b.getItem('tmux_hub_drafts'), JSON.stringify({ app: 'draft on B' }), 'B’s kept for later');
});

test('acceptance: B fails twice → Back to A, A’s page, drafts and terminal target unchanged', async () => {
  const t = app();
  const before = t.everything();
  t.w.fail('ws://b:2', 2);
  await t.sw.switchTo(t.b);
  assert.equal(t.sw.state?.phase, 'failed');
  assert.equal(t.sw.state?.from?.id, t.a.id, 'the source is frozen');
  assert.equal(currentServerId(t.storage), t.a.id, 'CURRENT never moved to a server that did not answer');
  assert.equal(t.storage.getItem('tmux_address'), 'ws://a:1', 'nor did the mirror');
  await t.sw.retry();
  assert.equal(t.sw.state?.phase, 'failed', 'second failure');
  await t.sw.back(loadServers(t.storage));
  assert.equal(t.sw.state, null);
  assert.equal(t.w.at, 'ws://a:1');
  assert.equal(t.everything(), before, 'every slot of A and B, and every legacy key, as before');
  assert.equal(t.slot(t.a.id).getItem('tmux_hub_drafts'), JSON.stringify({ app: 'draft on A' }));
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
  const snapshot = t.everything();
  let asked = 0;
  const off = registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: async () => { asked++; return false; } });
  await t.sw.switchTo(t.b);
  off();
  assert.equal(asked, 1);
  assert.equal(t.sw.state, null);
  assert.equal(t.w.at, 'ws://a:1');
  assert.ok(t.connected && t.mounted);
  assert.equal(t.resets.length, 0, 'nothing was reset');
  assert.equal(t.everything(), snapshot, 'no slot and no legacy key moved');
});

test('a second address of the SAME machine folds into its entry and restores its state', async () => {
  const t = app();
  // Leave A for B, then add A's Tailscale address as if it were new.
  await t.sw.switchTo(t.b);
  const candidate: SwitchTarget = { id: '', name: 'a-ts', address: 'ws://a-ts:9', token: 'ta' };
  await t.sw.switchTo(candidate);
  assert.equal(loadServers(t.storage).length, 2, 'no third "server"');
  assert.equal(currentServerId(t.storage), t.a.id, 'the identity the server reported decides');
  assert.equal(t.slot(currentServerId(t.storage)).getItem('tmux_hub_drafts'), JSON.stringify({ app: 'draft on A' }), 'A’s state, not a fresh start');
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

test('an address connect takes the socket from the host s other owners, and loses it to a later one (reviewer P1 on 085b0e70)', async () => {
  // ONE owner counter for every socket change: an arrival waiting on its
  // leave dialog holds a handover; the address connect that takes the socket
  // makes it stale, so when the dialog answers it does nothing.
  const t = app();
  const waiting = t.handovers.open(null);
  assert.equal(await t.sw.connectAddress('ws://a:1', 'ta'), true);
  assert.equal(waiting.current(), false, 'the earlier owner is stale');

  // And the reverse: an owner that takes the socket while this one dials.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const real = t.w.connect.bind(t.w);
  (t.w as { connect: (a: string) => Promise<void> }).connect = async (addr: string) => { await gate; return real(addr); };
  const tap = t.sw.connectAddress('ws://a-ts:9', 'ta');
  await new Promise((r) => setTimeout(r, 0));
  t.handovers.open(null);                         // the connect form, say
  release();
  assert.equal(await tap, false, 'the address connect lost the socket');
  assert.deepEqual(t.published, ['ws://a:1'], 'and published nothing');
});

test('while a host leave walk asks, no address connect and no switch starts', async () => {
  const t = app();
  let answer!: (v: boolean) => void;
  const walk = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.sw.guarding, true);
  assert.equal(await t.sw.connectAddress('ws://a:1', 'ta'), false, 'the optimizer or an address row is refused');
  await t.sw.switchTo(t.b);
  assert.equal(currentServerId(t.storage), t.a.id, 'and so is a switch');
  answer(true);
  assert.equal(await walk, true);
  assert.equal(t.sw.guarding, false);
  assert.equal(await t.sw.connectAddress('ws://a:1', 'ta'), true, 'after it, they work again');
});

test('one walk at a time: a second one is refused, and its callback never runs (reviewer P1 on 4fbce02e)', async () => {
  const t = app();
  let answer!: (v: boolean) => void;
  const first = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  await new Promise((r) => setTimeout(r, 0));
  let ran = false;
  assert.equal(await t.sw.guard(async () => { ran = true; return true; }), false, 'refused: a stay');
  assert.equal(await t.sw.guard(async () => { ran = true; return true; }, { current: () => true }), false, 'with an owner of its own too');
  assert.equal(ran, false, 'the second walk never asked anything');
  answer(false);
  assert.equal(await first, false);
});

test('a walk takes the socket from everything already running (reviewer P1 on 4fbce02e)', async () => {
  const t = app();
  // The reconnect loop is running, and an attempt of the host's holds the
  // owner — a reconnect continuation, a boot dial.
  t.loop(true);
  const earlier = t.handovers.claim();
  const intent = t.sw.intent;
  let answer!: (v: boolean) => void;
  const walk = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.reconnects, ['stop'], 'the loop is frozen');
  assert.equal(earlier.current(), false, 'the earlier owner is stale');
  assert.equal(t.sw.owns(intent), false, 'and an optimizer probe begun before it owns nothing when it answers');
  answer(false);
  assert.equal(await walk, false);
  assert.deepEqual(t.reconnects, ['stop', 'start ws://a:1'], 'a stay starts the loop it froze again');

  // An accept leaves it to whoever leaves.
  t.reconnects.length = 0;
  t.loop(true);
  assert.equal(await t.sw.guard(async () => true), true);
  assert.deepEqual(t.reconnects, ['stop']);
});

test('a walk freezes an address connect already dialling; a stay puts its outcome back, an accept does not (reviewer P1 on 4fbce02e)', async () => {
  for (const stay of [true, false]) {
    const t = app();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = t.w.connect.bind(t.w);
    (t.w as { connect: (a: string) => Promise<void> }).connect = async (addr: string) => { await gate; return real(addr); };
    const tap = t.sw.connectAddress('ws://a:1', 'ta');
    await new Promise((r) => setTimeout(r, 0));
    let answer!: (v: boolean) => void;
    const walk = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
    await new Promise((r) => setTimeout(r, 0));
    release();                                     // it answers while the dialog is open
    assert.equal(await tap, false, 'the frozen attempt is not the owner');
    assert.deepEqual(t.published, [], 'and publishes nothing under the open dialog');
    answer(!stay);
    await walk;
    assert.deepEqual(t.published, stay ? ['ws://a:1'] : [], stay ? 'a stay puts its outcome back' : 'an accept leaves the socket to whoever leaves');
  }
});

test('a stay puts a FAILED frozen address connect back to the reconnect loop', async () => {
  const t = app();
  t.w.fail('ws://a:1', 1);
  let answer!: (v: boolean) => void;
  const tap = t.sw.connectAddress('ws://a:1', 'ta');
  const walk = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  assert.equal(await tap, false);
  assert.deepEqual(t.reconnects.filter((r) => r.startsWith('start')), [], 'no loop under the open dialog');
  answer(false);
  await walk;
  assert.deepEqual(t.reconnects.filter((r) => r.startsWith('start')), ['start ws://a:1']);
});

test('frozen: no switch and no address connect starts (board #335 ②b-4)', async () => {
  const t = app();
  t.freeze(true);
  await t.sw.switchTo(t.b);
  assert.equal(currentServerId(t.storage), t.a.id);
  assert.equal(t.w.at, 'ws://a:1');
  assert.equal(await t.sw.connectAddress('ws://a:1', 'ta'), false);
  t.freeze(false);
  await t.sw.switchTo(t.b);
  assert.equal(currentServerId(t.storage), t.b.id, 'thawed, it works');
});

test('a failure the host gate classifies as blocked is the host s: no failed panel, the target handed over (reviewer P1 on af59fb5d)', async () => {
  const t = app();
  t.w.fail('ws://b:2', 1);
  const handed: string[] = [];
  t.onGate((target) => { handed.push(target.id); t.freeze(true); });     // the gate blocks
  await t.sw.switchTo(t.b);
  assert.equal(t.sw.state, null, 'no failed panel over the host s Retry');
  assert.deepEqual(handed, [t.b.id], 'the gate got the target to keep');
  // An ordinary failure, the gate not blocking, is the switch s failed panel.
  t.freeze(false);
  t.onGate(() => {});
  t.w.fail('ws://b:2', 1);
  await t.sw.switchTo(t.b);
  assert.equal((t.sw.state as SwitchState | null)?.phase, 'failed');
});
