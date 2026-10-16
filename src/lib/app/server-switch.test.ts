// Two-server behaviour of the in-place switch (board 315, reviewer P1 #4).
// The real switch (server-switch.ts), the real storage half (servers.ts),
// the real leave guards and the real download core run against two fake
// servers that answer as machine A or B. The fake transport has ws.ts's
// shape: one socket, requests go to whatever it is connected to, and
// disconnect() rejects everything still pending.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSwitch, type SwitchState, type SwitchTarget } from './server-switch.ts';
import { addressesOf } from './server-target.ts';
import { dialOrder, dialTimeoutMs } from './dial-order.ts';
import { currentServerId, loadServers, migrateServers, RESIDENT_KEYS, recordServer, residentKey } from './servers.ts';
import { migrateServerState } from './server-state-migration.ts';
import { createServerStore } from './server-store.ts';
import { clearLeaveGuardsForTests, confirmLeave, registerLeaveGuard } from './leave-guards.ts';
import { createActivations } from './activation.ts';
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
    'ws://b-wan:3': { machine: 'm-b', sessions: ['app'] },
    // A third machine, saved by no fixture (board #402 review round 3).
    'ws://c:4': { machine: 'm-c', sessions: ['app'] },
    'ws://c-alt:5': { machine: 'm-c', sessions: ['app'] },
  };
  let at: string | null = null;
  const fails = new Map<string, number>();
  const refused = new Set<string>();
  const pending = new Set<{ reject: (e: Error) => void }>();
  const log: string[] = [];
  return {
    log,
    get at() { return at; },
    fail(addr: string, n: number) { fails.set(addr, n); },
    /** The server answers on `addr` and refuses the token. */
    refuse(addr: string) { refused.add(addr); },
    async connect(addr: string) {
      if (refused.has(addr)) throw new Error('auth failed');
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
  const idles: string[] = [];
  const dials: string[] = [];
  const tokens: string[] = [];
  const unreachable: string[] = [];
  const handovers = createActivations();
  let frozen = false;
  /** What the TARGET's own runtime bring-up answers (App's `activate`):
   * null once it is up, or why not. */
  let bringUp: () => Promise<string | null> = async () => null;
  let gate: (target: SwitchTarget) => void = () => {};
  /** A dial a case holds until it says so (board #402 review P1-A). */
  let holdDial: (addr: string) => Promise<void> | null = () => null;
  const sw = createServerSwitch({
    storage,
    connected: () => connected,
    currentId: () => currentServerId(storage),
    currentName: () => loadServers(storage).find((s) => s.id === currentServerId(storage))?.name ?? '',
    confirmLeave: () => confirmLeave({ leaving: null, current: 'hub', reveal: async () => {}, hold: () => {} }),
    claim: () => handovers.claim(),
    frozen: () => frozen,
    identityFailed: (target) => { gate(target); },
    stopReconnect: () => { reconnects.push('stop'); },
    startReconnect: () => { reconnects.push(`start ${currentServerId(storage)}`); },
    addressUp: (addr) => { published.push(addr); },
    onidle: () => { idles.push(`idle after ${published.length} published, state ${states.at(-1) ? 'on' : 'off'}`); },
    onstate: (st) => { states.push(st); if (st) { connected = false; mounted = false; } },
    // The candidate: in this world one socket stands for "what the switch
    // dialled", the server's own runtimes are App's (App.shell covers them).
    disconnect: () => { resets.push('candidate-closed'); },
    connect: async (addr, token, timeoutMs) => {
      dials.push(`${addr}@${timeoutMs}`);
      tokens.push(token);
      const held = holdDial(addr);
      if (held) await held;
      return w.connect(addr);
    },
    // The server's other addresses (board #353), as App wires them.
    addresses: (target) => dialOrder(addressesOf(storage, target.id, target.address), () => true),
    dialTimeout: () => dialTimeoutMs(2), // every fixture address is an internet one (ws.ts needs a window)
    unreachable: (addr) => { unreachable.push(addr); },
    setSocket: async () => {},
    machineId: () => w.machineId(),
    redial: (addr) => w.connect(addr).then(() => 'up' as const),
    comeUp: async () => {
      resets.push(`come-up ${currentServerId(storage)}`);
      const failure = await bringUp();
      if (failure === null) { connected = true; mounted = true; }
      return failure;
    },
  });
  /** What a page writes and reads: the server it is bound to, its slots. */
  const slot = (id: string) => createServerStore(storage, id);
  /** Every key of every slot, and the legacy keys: what nothing may touch. */
  const everything = () => JSON.stringify([...RESIDENT_KEYS].flatMap((k) => [storage.getItem(k), ...[a.id, b.id].map((id) => storage.getItem(residentKey(k, id)))]));
  return { storage, slot, everything, w, a, b, sw, handovers, states, freeze: (on: boolean) => { frozen = on; }, onGate: (fn: (target: SwitchTarget) => void) => { gate = fn; }, onBringUp: (fn: () => Promise<string | null>) => { bringUp = fn; }, onDial: (fn: (addr: string) => Promise<void> | null) => { holdDial = fn; }, resets, reconnects, published, idles, dials, tokens, unreachable,
    get connected() { return connected; }, get mounted() { return mounted; } };
}

test.beforeEach(() => clearLeaveGuardsForTests());

test('A→B→A with a same-named project keeps each server’s state (board 315)', async () => {
  const t = app();
  const [a, b] = [t.slot(t.a.id), t.slot(t.b.id)];
  // The Hub's drafts live in A's slot, the server it is bound to; nothing is
  // parked (board #335 ②b-4).
  a.setItem('tmux_hub_drafts', JSON.stringify({ app: 'draft on A, last keystroke' }));
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
  assert.deepEqual(t.resets, [], 'nothing was dialled, nothing came up');
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
  const tap = t.sw.connectAddress('ws://a-ts:9');
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
  assert.equal(await t.sw.connectAddress('ws://a:1'), false);
  assert.deepEqual(t.reconnects.filter((r) => r.startsWith('start')), [`start ${t.a.id}`]);
  assert.equal(await t.sw.connectAddress('ws://a:1'), true);
  assert.deepEqual(t.published, ['ws://a:1']);
});

test('an address connect takes the socket from the host s other owners, and loses it to a later one (reviewer P1 on 085b0e70)', async () => {
  // ONE owner counter for every socket change: an arrival waiting on its
  // leave dialog holds a handover; the address connect that takes the socket
  // makes it stale, so when the dialog answers it does nothing.
  const t = app();
  const waiting = t.handovers.claim();
  assert.equal(await t.sw.connectAddress('ws://a:1'), true);
  assert.equal(waiting.current(), false, 'the earlier owner is stale');

  // And the reverse: an owner that takes the socket while this one dials.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const real = t.w.connect.bind(t.w);
  (t.w as { connect: (a: string) => Promise<void> }).connect = async (addr: string) => { await gate; return real(addr); };
  const tap = t.sw.connectAddress('ws://a-ts:9');
  await new Promise((r) => setTimeout(r, 0));
  t.handovers.claim();                         // the connect form, say
  release();
  assert.equal(await tap, false, 'the address connect lost the socket');
  assert.deepEqual(t.published, ['ws://a:1'], 'and published nothing');
});

test('while a host leave walk asks, nothing starts on top of it — and nothing is frozen either (board #335 ②b-4)', async () => {
  // One question at a time: no switch and no address change start while the
  // person is being asked. The walk stops no reconnect loop and takes no
  // socket — every server has its own connection.
  const t = app();
  let answer!: (v: boolean) => void;
  const walk = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.sw.guarding, true);
  assert.deepEqual(t.reconnects, [], 'the walk stopped no reconnect loop');
  assert.equal(await t.sw.connectAddress('ws://a:1'), false, 'no address change on top of the question');
  await t.sw.switchTo(t.b);
  assert.equal(currentServerId(t.storage), t.a.id, 'and no switch');
  let idle = false;
  void t.sw.idle().then(() => { idle = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(idle, false, 'what waits for the walk is still waiting');
  answer(true);
  assert.equal(await walk, true);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(idle, true, 'and goes on once it is answered');
  assert.equal(await t.sw.connectAddress('ws://a:1'), true, 'after it, they work again');
});

test('one walk at a time: a second one is refused, and its callback never runs (reviewer P1 on 4fbce02e)', async () => {
  const t = app();
  let answer!: (v: boolean) => void;
  const first = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  await new Promise((r) => setTimeout(r, 0));
  let ran = false;
  assert.equal(await t.sw.guard(async () => { ran = true; return true; }), false, 'refused: a stay');
  assert.equal(ran, false, 'the second walk never asked anything');
  answer(false);
  assert.equal(await first, false);
});

test('frozen: no switch and no address connect starts (board #335 ②b-4)', async () => {
  const t = app();
  t.freeze(true);
  await t.sw.switchTo(t.b);
  assert.equal(currentServerId(t.storage), t.a.id);
  assert.equal(t.w.at, 'ws://a:1');
  assert.equal(await t.sw.connectAddress('ws://a:1'), false);
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

test('B s own bring-up failing puts CURRENT back on A, which was never ended (ruling (a), 04:04)', async () => {
  // The candidate reached B and recorded it, so CURRENT moved; B's OWN
  // runtime then could not come up. A was not reset, not released, not
  // ended: CURRENT returns to it, the panel offers Back, and Back is A again.
  const t = app();
  t.onBringUp(async () => 'B s own dial failed');
  await t.sw.switchTo(t.b);
  assert.deepEqual(t.resets, [`come-up ${t.b.id}`, 'candidate-closed'], 'B was activated, its own bring-up failed, the candidate closed');
  assert.equal(t.sw.state?.phase, 'failed');
  assert.equal(t.sw.state?.error, 'B s own dial failed');
  assert.equal(currentServerId(t.storage), t.a.id, 'CURRENT is A s again');
  t.onBringUp(async () => null);
  await t.sw.back(loadServers(t.storage));
  assert.equal(t.sw.state, null);
  assert.equal(currentServerId(t.storage), t.a.id);
  assert.ok(t.connected && t.mounted, 'A is up');
});

test('the switch gives nothing of A up before B is up: no reset step runs ahead of the bring-up (ruling (a))', async () => {
  const t = app();
  let current = '';
  t.onBringUp(async () => { current = currentServerId(t.storage); return null; });
  await t.sw.switchTo(t.b);
  assert.equal(current, t.b.id, 'B is CURRENT when its own runtime comes up');
  assert.deepEqual(t.resets, [`come-up ${t.b.id}`], 'and that is the first thing the switch asks the host to do');
});

test('the window is BUSY for the length of every operation, and goes idle once after the last one has completed — the walk s answer returned, the switch concluded, the address published (#335 ③b; reviewer P1-B/P2 on e0dafe3c)', async () => {
  const t = app();
  // A walk: busy from the guard to its answer, idle AFTER the answer is out.
  let answer!: (v: boolean) => void;
  const walk = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  assert.equal(t.sw.busy, true, 'a walk holds the window');
  assert.deepEqual(t.idles, []);
  answer(true);
  assert.equal(await walk, true);
  assert.equal(t.sw.busy, false);
  assert.deepEqual(t.idles, ['idle after 0 published, state off'], 'idle once, after the walk');
  // An address connect: busy until addressUp has run (the caller's completion).
  t.idles.length = 0;
  const addr = t.sw.connectAddress('ws://a:1');
  assert.equal(t.sw.busy, true, 'an address connect holds the window');
  assert.equal(await addr, true);
  assert.deepEqual(t.idles, ['idle after 1 published, state off'], 'idle after addressUp, not before');
  // A switch: busy from its confirm walk to its conclusion; idle after
  // `onstate(null)` — the switch has committed and the tree is shown.
  t.idles.length = 0;
  let up!: () => void;
  t.onBringUp(() => new Promise<string | null>((r) => { up = () => r(null); }));
  const sw = t.sw.switchTo(t.b);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.sw.busy, true, 'a switch in flight holds the window');
  assert.deepEqual(t.idles, [], 'and the confirm walk ending inside it did NOT free it');
  up();
  await sw;
  assert.equal(t.sw.busy, false);
  assert.deepEqual(t.idles, ['idle after 1 published, state off'], 'idle once, after the switch concluded');
  assert.equal(currentServerId(t.storage), t.b.id);
  // A refused operation (over a walk) never counts.
  t.idles.length = 0;
  const walk2 = t.sw.guard(() => new Promise<boolean>((r) => { answer = r; }));
  assert.equal(await t.sw.connectAddress('ws://b:2'), false, 'refused over the walk');
  assert.equal(await t.sw.guard(async () => true), false, 'a second walk is refused');
  assert.deepEqual(t.idles, [], 'refusals free nothing');
  answer(false);
  await walk2;
  assert.deepEqual(t.idles, ['idle after 1 published, state off'], 'one idle, when the real walk ends');
});

test('a failed switch s panel is dismissed by the host without a new intent; a switch in flight is not (#335 ③b, an owed focus handover)', async () => {
  const t = app();
  t.onBringUp(async () => 'B refused');
  await t.sw.switchTo(t.b);
  assert.equal(t.sw.state?.phase, 'failed');
  assert.equal(currentServerId(t.storage), t.a.id, 'CURRENT back on A');
  const seq = t.sw.intent;
  const phase = () => (t.sw.state as SwitchState | null)?.phase ?? null;
  t.sw.dismiss();
  assert.equal(phase(), null, 'the panel is put away');
  assert.equal(t.sw.intent, seq, 'no new intent');
  assert.equal(t.states.at(-1), null, 'the host saw it go');
  // In flight: untouched.
  let up!: () => void;
  t.onBringUp(() => new Promise<string | null>((r) => { up = () => r(null); }));
  const sw = t.sw.switchTo(t.b);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(phase(), 'connecting');
  t.sw.dismiss();
  assert.equal(phase(), 'connecting', 'a switch in flight is not dismissed');
  up();
  await sw;
  assert.equal(currentServerId(t.storage), t.b.id);
});

// Board #353: a switch walks the server's addresses. The address that answers
// the probe and then never authenticates ("LAN is up, the socket stalls") used
// to be the only one a switch ever dialled; now a reachability failure hands
// over to the next address inside the same switch.
function twoAddresses() {
  const t = app();
  t.storage.setItem('tmux_machines', JSON.stringify({ 'm-a': ['ws://a:1'], 'm-b': ['ws://b:2', 'ws://b-wan:3'] }));
  return t;
}

test('the first address times out: the switch falls over to the next and records the one that answered (board #353)', async () => {
  const t = twoAddresses();
  t.w.fail('ws://b:2', 1);
  await t.sw.switchTo(t.b);
  assert.deepEqual(t.dials, ['ws://b:2@5000', 'ws://b-wan:3@5000'], 'the target first, then the machine\u2019s other address, each with its class timeout');
  assert.deepEqual(t.unreachable, ['ws://b:2'], 'the dead one is remembered, the live one is not');
  assert.equal(t.w.at, 'ws://b-wan:3');
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.address, 'ws://b-wan:3', 'the entry now says where the server proved to be');
  assert.equal(t.states.at(-1), null, 'the switch concluded');
  assert.ok(t.connected && t.mounted);
  assert.equal(t.resets.filter((r) => r === 'candidate-closed').length >= 1, true, 'the dead candidate was closed before the next dial');
});

test('an auth refusal is the server answering: the walk stops and no address is blamed (board #353)', async () => {
  const t = twoAddresses();
  t.w.refuse('ws://b:2');
  await t.sw.switchTo(t.b);
  assert.deepEqual(t.dials, ['ws://b:2@5000'], 'another address of the same server would refuse the same token');
  assert.deepEqual(t.unreachable, []);
  const st = t.states.at(-1)!;
  assert.equal(st.phase, 'failed');
  assert.equal(st.error, 'auth failed');
});

test('every address unreachable: the panel names the last one tried and offers all of them (board #353)', async () => {
  const t = twoAddresses();
  t.w.fail('ws://b:2', 9); t.w.fail('ws://b-wan:3', 9);
  await t.sw.switchTo(t.b);
  const st = t.states.at(-1)!;
  assert.equal(st.phase, 'failed');
  assert.equal(st.address, 'ws://b-wan:3', 'the last one tried');
  assert.deepEqual(st.addresses, ['ws://b:2', 'ws://b-wan:3'], 'the whole set, in the order tried');
  assert.equal(st.target.address, 'ws://b:2', 'Retry starts again from what was asked for');
  assert.deepEqual(t.unreachable, ['ws://b:2', 'ws://b-wan:3']);
  assert.equal(t.states.some((s) => s?.phase === 'connecting' && s.address === 'ws://b-wan:3'), true, 'the panel followed the dial to the second address');
});

test('a pick from the failed panel dials exactly that address, with no fall-over, and becomes the entry\u2019s address on success (board #353)', async () => {
  const t = twoAddresses();
  t.w.fail('ws://b:2', 9); t.w.fail('ws://b-wan:3', 2); // the walk spends one, the first pick the other
  await t.sw.switchTo(t.b);
  assert.equal(t.states.at(-1)!.phase, 'failed');
  t.dials.length = 0;
  await t.sw.retryAt('ws://b-wan:3'); // still failing once: no fall-over to b:2
  assert.deepEqual(t.dials, ['ws://b-wan:3@5000'], 'exactly the one picked');
  assert.equal(t.states.at(-1)!.phase, 'failed');
  assert.deepEqual(t.states.at(-1)!.addresses, ['ws://b:2', 'ws://b-wan:3'], 'the panel keeps offering the whole set, in the same order');
  t.dials.length = 0;
  await t.sw.retryAt('ws://b-wan:3'); // it answers now
  assert.deepEqual(t.dials, ['ws://b-wan:3@5000']);
  assert.equal(t.w.at, 'ws://b-wan:3');
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.address, 'ws://b-wan:3');
  assert.equal(t.states.at(-1), null);
});

test('a server with one address is dialled once, as before (board #353)', async () => {
  const t = app();
  t.w.fail('ws://b:2', 1);
  await t.sw.switchTo(t.b);
  assert.deepEqual(t.dials, ['ws://b:2@5000'], 'nothing else to try');
  assert.equal(t.states.at(-1)!.phase, 'failed');
  assert.deepEqual(t.states.at(-1)!.addresses, ['ws://b:2']);
});

test('a pick belongs to its one operation: the Retry after a failed pick is the whole walk again (board #353 review P1)', async () => {
  const t = twoAddresses();
  t.w.fail('ws://b:2', 9); t.w.fail('ws://b-wan:3', 2); // the walk and the pick each spend one; the Retry's walk reaches it alive
  await t.sw.switchTo(t.b);
  assert.equal(t.states.at(-1)!.phase, 'failed');
  await t.sw.retryAt('ws://b-wan:3'); // a pick that is still dead
  const failedPick = t.states.at(-1)!;
  assert.equal(failedPick.phase, 'failed');
  assert.equal(failedPick.address, 'ws://b-wan:3', 'the panel names the pick that failed');
  assert.equal(failedPick.target.address, 'ws://b:2', 'while the state still holds what was ASKED for, not the pick');
  assert.deepEqual(failedPick.addresses, ['ws://b:2', 'ws://b-wan:3'], 'and the list holds still');
  // The picked address has recovered. A plain Retry must be the whole walk: the dead first address, then it.
  t.dials.length = 0;
  await t.sw.retry();
  assert.deepEqual(t.dials, ['ws://b:2@5000', 'ws://b-wan:3@5000'], 'the whole walk, not the last pick alone');
  assert.equal(t.w.at, 'ws://b-wan:3');
  assert.equal(t.states.at(-1), null);
});

test('the reviewer\u2019s sequence: the walk fails on A and B, a pick of A fails, B recovers, a plain Retry dials B and records it (board #353 review P1)', async () => {
  const t = twoAddresses();
  t.w.fail('ws://b:2', 9); t.w.fail('ws://b-wan:3', 1); // A = b:2 stays dead, B = b-wan:3 failed once, in the walk
  await t.sw.switchTo(t.b);
  assert.equal(t.states.at(-1)!.phase, 'failed');
  t.dials.length = 0;
  await t.sw.retryAt('ws://b:2');
  assert.deepEqual(t.dials, ['ws://b:2@5000'], 'a pick is still exactly one dial');
  assert.equal(t.states.at(-1)!.phase, 'failed');
  t.dials.length = 0;
  await t.sw.retry(); // B has recovered
  assert.deepEqual(t.dials, ['ws://b:2@5000', 'ws://b-wan:3@5000'], 'the plain Retry walks the set again, it is not the pick\u2019s only');
  assert.equal(t.w.at, 'ws://b-wan:3');
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.address, 'ws://b-wan:3', 'and records the address that answered');
});

// Board #402 review P1-A: an edit made in Settings › Connection while a switch
// to that server is dialling is the newest explicit configuration. The switch
// that read the old token or address before it awaited must not put them back
// when it commits.
test('a switch in flight while beta s token is changed commits without the old token, and the next dial uses the new one (#402 review P1-A)', async () => {
  const { setServerToken } = await import('./servers.ts');
  const t = app();
  let release!: () => void;
  t.onDial((addr) => (addr === 'ws://b:2' ? new Promise<void>((r) => { release = r; }) : null));
  const switching = t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.b.id)!);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.tokens, ['tb'], 'the switch dialled with the token it read');
  // The person saves a new token for beta while that dial is held.
  setServerToken(t.storage, t.b.id, 'tb-new');
  t.onDial(() => null);
  release();
  await switching;
  assert.equal(currentServerId(t.storage), t.b.id, 'the switch still arrives: the live connection is kept');
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.token, 'tb-new', 'the saved token is not overwritten by the one the switch dialled');
  assert.equal(t.storage.getItem('tmux_token'), 'tb-new', 'nor is the mirror');
  // The next dial of beta reads the saved configuration.
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.a.id)!);
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.b.id)!);
  assert.equal(t.tokens.at(-1), 'tb-new');
});

test('a switch in flight to an alternate that is removed meanwhile does not make it active or put it back (#402 review P1-A)', async () => {
  const { removeServerAddress, serverAddresses, saveMachineAddresses } = await import('./servers.ts');
  const t = app();
  saveMachineAddresses(t.storage, 'm-b', ['ws://b:2', 'ws://b-wan:3']);
  // beta's own address is down: the switch walks to the alternate, held.
  t.w.fail('ws://b:2', 1);
  let release!: () => void;
  t.onDial((addr) => (addr === 'ws://b-wan:3' ? new Promise<void>((r) => { release = r; }) : null));
  const switching = t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.b.id)!);
  for (let i = 0; i < 5 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(release, 'the dial to the alternate is held');
  assert.deepEqual(removeServerAddress(t.storage, t.b.id, 'ws://b-wan:3'), { addresses: ['ws://b:2'] });
  t.onDial(() => null);
  release();
  await switching;
  assert.equal(currentServerId(t.storage), t.b.id, 'the live connection on it is kept');
  const b = loadServers(t.storage).find((s) => s.id === t.b.id)!;
  assert.equal(b.address, 'ws://b:2', 'the removed address does not become the active one');
  assert.deepEqual(serverAddresses(t.storage, t.b.id), ['ws://b:2'], 'nor is it put back into the set');
  assert.equal(t.storage.getItem('tmux_address'), 'ws://b:2', 'the mirror is the saved tuple');
  // The next dial of beta does not try it.
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.a.id)!);
  const mark = t.dials.length;
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.b.id)!);
  assert.ok(!t.dials.slice(mark).some((d) => d.startsWith('ws://b-wan:3')), `the removed address is not dialled: ${t.dials.slice(mark)}`);
});

// Board #402 review P1-A residual (a): the leave prompt is an await before
// the dial. A target picked before it (or a Retry's, taken at the failure)
// must not dial one snapshot while the commit protects another.
test('an edit made while the leave prompt is up is what the switch dials, and the commit keeps it (#402 review P1-A residual)', async () => {
  const { setServerToken } = await import('./servers.ts');
  const t = app();
  const picked = loadServers(t.storage).find((s) => s.id === t.b.id)!;   // the row the person clicked, before the edit
  let answer!: (leave: boolean) => void;
  const off = registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: () => new Promise<boolean>((r) => { answer = r; }) });
  const switching = t.sw.switchTo(picked);
  for (let i = 0; i < 5 && !answer; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(answer, 'the leave prompt is up');
  setServerToken(t.storage, t.b.id, 'tb-new');
  answer(true);
  await switching;
  off();
  assert.deepEqual(t.tokens, ['tb-new'], 'the switch dials the token saved during the prompt, not the picked row s');
  assert.equal(currentServerId(t.storage), t.b.id);
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.token, 'tb-new', 'and the commit keeps it');
  assert.equal(t.storage.getItem('tmux_token'), 'tb-new');
});

test('a Retry dials the entry as it is now, not the target the failure kept (#402 review P1-A residual)', async () => {
  const { setServerToken } = await import('./servers.ts');
  const t = app();
  t.w.fail('ws://b:2', 1);
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.b.id)!);
  assert.equal(t.sw.state?.phase, 'failed');
  setServerToken(t.storage, t.b.id, 'tb-new');
  await t.sw.retry();
  assert.equal(t.tokens.at(-1), 'tb-new', 'the Retry dials the saved token');
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.token, 'tb-new');
});

test('typed credentials (Add server over a saved address) are dialled as given and an edit made meanwhile still wins (#402 review P1-A residual)', async () => {
  const { setServerToken } = await import('./servers.ts');
  const t = app();
  const b = loadServers(t.storage).find((s) => s.id === t.b.id)!;
  let answer!: (leave: boolean) => void;
  const off = registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: () => new Promise<boolean>((r) => { answer = r; }) });
  const switching = t.sw.switchTo({ ...b, token: 'tb-typed', explicit: true });
  for (let i = 0; i < 5 && !answer; i++) await new Promise((r) => setTimeout(r, 0));
  setServerToken(t.storage, t.b.id, 'tb-settings');
  answer(true);
  await switching;
  off();
  assert.deepEqual(t.tokens, ['tb-typed'], 'the typed token is what was submitted');
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.token, 'tb-settings', 'the edit made after it is the newest and is kept');
  // Without an edit, the typed token is recorded, as before.
  const u = app();
  const ub = loadServers(u.storage).find((s) => s.id === u.b.id)!;
  await u.sw.switchTo({ ...ub, token: 'tb-typed', explicit: true });
  assert.equal(loadServers(u.storage).find((s) => s.id === u.b.id)!.token, 'tb-typed');
});

test('an address added while the leave prompt is up and removed while the dial is held does not become active (#402 review P1-A residual: the observation is taken with the re-read target)', async () => {
  const { addServerAddress, removeServerAddress, serverAddresses } = await import('./servers.ts');
  const t = app();
  t.w.fail('ws://b:2', 1);                 // beta's proven address is down
  let answer!: (leave: boolean) => void;
  const off = registerLeaveGuard({ runtime: null, page: 'files', dirty: () => true, ask: () => new Promise<boolean>((r) => { answer = r; }) });
  let release!: () => void;
  t.onDial((addr) => (addr === 'ws://b-wan:3' ? new Promise<void>((r) => { release = r; }) : null));
  const switching = t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.b.id)!);
  for (let i = 0; i < 5 && !answer; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok('addresses' in addServerAddress(t.storage, t.b.id, 'ws://b-wan:3'), 'added during the prompt');
  answer(true);
  for (let i = 0; i < 10 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(release, 'the switch walks to the added address, held');
  assert.deepEqual(removeServerAddress(t.storage, t.b.id, 'ws://b-wan:3'), { addresses: ['ws://b:2'] }, 'removed during the dial');
  t.onDial(() => null);
  release();
  await switching;
  off();
  assert.equal(loadServers(t.storage).find((s) => s.id === t.b.id)!.address, 'ws://b:2', 'the removed address is not made active');
  assert.deepEqual(serverAddresses(t.storage, t.b.id), ['ws://b:2'], 'nor put back');
});

test('a held switch to a machine-less entry, then the machine it reaches is saved and its token edited: the commit keeps that token, in the registry and the mirror, and the next dial sends it (#402 review round 3)', async () => {
  const { setServerToken } = await import('./servers.ts');
  const t = app();
  const x = recordServer(t.storage, { address: 'ws://c-alt:5', token: 'tx' }).entry;
  assert.equal(x.machineId, undefined, 'the target knows no machine yet');
  let release!: () => void;
  t.onDial((addr) => (addr === 'ws://c-alt:5' ? new Promise<void>((r) => { release = r; }) : null));
  const switching = t.sw.switchTo(loadServers(t.storage).find((s) => s.id === x.id)!);
  for (let i = 0; i < 5 && !release; i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(release, 'the dial is held');
  const c = recordServer(t.storage, { address: 'ws://c:4', token: 'tc-saved', machineId: 'm-c' }).entry;
  setServerToken(t.storage, c.id, 'tc-edited');
  t.onDial(() => null);
  release();
  await switching;
  const saved = loadServers(t.storage).find((s) => s.id === c.id)!;
  assert.equal(currentServerId(t.storage), c.id, 'the answer resolves to the machine s entry');
  assert.equal(saved.token, 'tc-edited', 'whose newest token is not overwritten by the target s');
  assert.equal(t.storage.getItem('tmux_token'), 'tc-edited', 'nor is the mirror');
  assert.ok(!loadServers(t.storage).some((s) => s.id === x.id), 'the machine-less target is absorbed, as before');
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === t.a.id)!);
  await t.sw.switchTo(loadServers(t.storage).find((s) => s.id === c.id)!);
  assert.equal(t.tokens.at(-1), 'tc-edited', 'the next dial sends the newest token');
});
