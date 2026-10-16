// The connect form dials its OWN candidate connection and hands the app a
// recorded identity, never a socket (board #335 ②b-4; orchestrator's ruling,
// 01:43, and its 01:46 addendum).
//
// Until ②b-4 this form re-dialled the one socket every server-bound page was
// talking over, so the host had to stand its handle down first and the form
// had to report what it CONCLUDED about the peer (a handover). Each attempt
// now has a connection of its own — App's candidate — so nothing a server's
// pages are using moves while an address nobody has identified answers. What
// stays is the generation: only the latest attempt, and only while the app is
// still waiting on it (`current()`), may write identity or bring anything up.
//
// A source pin would only say the calls are written somewhere in the
// function. A mount says they happened, and in which order.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), []);
// The identity layer, mocked, so the one failure that matters can happen: a
// peer authenticates and the client cannot record WHICH server it is.
const withIdentity = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('./servers.ts', import.meta.url),
]);

type Dial = (url: string, token: string) => Promise<string>;
/** The candidate App hands the form: one per attempt, recorded in `order`,
 * current until `stale()` (what a switch or a newer attempt does). */
function candidates(order: string[], dial: Dial, machine = 'm-a') {
  let generation = 0;
  return {
    stale() { generation++; },
    open() {
      const mine = ++generation;
      let closed = false;
      order.push('candidate');
      return {
        connect: (url: string, token: string) => { order.push(`connect:${url}|${token}`); return dial(url, token); },
        setSocket: async (sock: string) => { order.push(`socket:${sock}`); },
        machineId: () => machine,
        current: () => !closed && mine === generation,
        close: () => { if (!closed) { closed = true; order.push('close'); } },
      };
    },
  };
}

async function mount(
  context: TestContext,
  dial: Dial,
  seed: (storage: Storage) => void = () => {},
  modules: Record<string, (...args: any[]) => unknown>[] = [],
  which = compiled,
  /** What the app's second handshake does (reviewer P1-D on cc45d7d1): the
   * server's OWN runtime dials after the candidate, and the form waits on
   * it. Default: nothing to wait on. */
  second: (switched: boolean) => { done: Promise<string | null>; cancel(): void } | void = () => {},
) {
  const order: string[] = [];
  const pool = candidates(order, dial);
  const app = await (await which).mount(context, {
    props: {
      onConnected(switched: boolean) { order.push(`connected:${switched}`); return second(switched); },
      openCandidate: () => pool.open(),
    },
    modules,
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      seed(window.localStorage);
    },
  });
  return { ...app, order, pool };
}

/** Type an address and submit the form the way a person does. */
async function connectTo(app: Awaited<ReturnType<typeof mount>>, address: string) {
  const input = app.document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!;
  input.value = address;
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
  const form = app.document.querySelector<HTMLFormElement>('form');
  if (form) form.dispatchEvent(new app.window.Event('submit', { bubbles: true, cancelable: true }));
  else app.document.querySelector<HTMLButtonElement>('button[type="submit"], .connect-btn')!.click();
  for (let i = 0; i < 8; i++) await app.flush();
}

const alpha = (storage: Storage) => {
  storage.setItem('tmux_servers', JSON.stringify([
    { id: 'a', name: 'alpha', address: 'wss://same.test/ws', token: 'tok', machineId: 'm-a', named: true },
  ]));
  storage.setItem('tmux_server_current', 'a');
};

test('an attempt dials its own candidate, records identity, closes it, and only then tells the app', async (context) => {
  const app = await mount(context, async () => 'm-a', alpha);
  await connectTo(app, 'wss://same.test/ws');
  assert.deepEqual(app.order, ['candidate', 'connect:wss://same.test/ws|tok', 'close', 'connected:false'],
    'the server s own connection dials after this, so the candidate is closed before App is told');
  assert.match(app.window.localStorage.getItem('tmux_servers') ?? '', /m-a/u, 'and the machine was recorded first');
});

test('a connect to another server says so, so App comes up on it in place', async (context) => {
  const app = await mount(context, async () => 'm-b', alpha);
  app.pool.open = ((open) => () => ({ ...open(), machineId: () => 'm-b' }))(app.pool.open.bind(app.pool));
  await connectTo(app, 'wss://other.test/ws');
  assert.equal(app.order.at(-1), 'connected:true', `switched: ${app.order.join(' → ')}`);
  assert.equal(app.window.localStorage.getItem('tmux_server_current') === 'a', false, 'CURRENT moved to the new server');
});

test('a dial that never reached a peer closes its candidate and tells the app nothing', async (context) => {
  const app = await mount(context, async () => { throw new Error('refused'); });
  await connectTo(app, 'wss://down.test/ws');
  assert.deepEqual(app.order, ['candidate', 'connect:wss://down.test/ws|', 'close']);
  assert.match(app.document.querySelector('.error')?.textContent ?? '', /refused/u, 'the person is told why');
});

test('a superseded attempt brings nothing up', async (context) => {
  // A dial is in flight and the person cancels and submits again. The older
  // attempt's late answer must not bring the app up or write identity.
  const pending: ((machine: string) => void)[] = [];
  const app = await mount(context, () => new Promise((resolve) => { pending.push(resolve); }), alpha);
  await connectTo(app, 'wss://same.test/ws');            // attempt 1, in flight
  const cancel = [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => /cancel/iu.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`));
  assert.ok(cancel, 'the connecting state offers Cancel');
  cancel.click();
  await app.flush();
  assert.ok(app.order.includes('close'), 'Cancel closes the candidate');
  await connectTo(app, 'wss://same.test/ws');            // attempt 2 supersedes it
  assert.equal(pending.length, 2, 'both dials are waiting');
  pending[0]!('m-a');                                     // the OLD dial settles
  for (let i = 0; i < 8; i++) await app.flush();
  assert.ok(!app.order.some((o) => o.startsWith('connected')), 'the superseded attempt brought nothing up');
});

test('a peer that authenticated but could not be identified is not a success', async (context) => {
  // B authenticates, the registry write fails. The app must NOT be told it is
  // connected, the candidate is closed, and the form says why.
  const app = await mount(context, async () => 'm-b', () => {}, [{
    activateConnected: () => { throw new Error('storage full'); },
    rememberedAddresses: () => [],      // the form's suggestions and pre-fill read the same module
    currentConnection: () => null,
  }], withIdentity);
  await connectTo(app, 'wss://stranger.test/ws');
  assert.deepEqual(app.order, ['candidate', 'connect:wss://stranger.test/ws|', 'close'],
    'the candidate it could not identify is closed');
  assert.ok(!app.order.some((o) => o.startsWith('connected')), 'and the app was never told this was its server');
  assert.match(app.document.querySelector('.error')?.textContent ?? '', /identif/iu, 'the person is told why');
});

test('an attempt the APP has moved on from writes nothing and brings nothing up (the host activation generation)', async (context) => {
  // The candidate is current only while the app is still waiting on it: a
  // switch, a revoke or any newer activation makes it stale (orchestrator's
  // addendum, 01:46: late results from a superseded activation are no-ops).
  let release: ((machine: string) => void) | null = null;
  const app = await mount(context, () => new Promise((resolve) => { release = resolve; }), alpha);
  await connectTo(app, 'wss://same.test/ws');
  assert.deepEqual(app.order, ['candidate', 'connect:wss://same.test/ws|tok'], 'the dial is in flight');
  app.pool.stale();                                       // the app moved on
  const registryBefore = app.window.localStorage.getItem('tmux_servers');
  release!('m-a');
  for (let i = 0; i < 8; i++) await app.flush();
  assert.ok(!app.order.some((o) => o.startsWith('connected')), 'the stale attempt brought nothing up');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), registryBefore, 'and wrote no identity');
});

test('an attempt dies with the form: no identity, no onConnected, and its candidate is closed', async (context) => {
  let release: ((machine: string) => void) | null = null;
  const app = await mount(context, () => new Promise((resolve) => { release = resolve; }), alpha);
  await connectTo(app, 'wss://b.test/ws');
  const registryBefore = app.window.localStorage.getItem('tmux_servers');
  await app.unmount();                                   // the reader leaves the form
  assert.ok(app.order.includes('close'), 'leaving the form closes its candidate');
  release!('m-b');                                        // and the dial comes back
  for (let i = 0; i < 8; i++) await app.flush();
  assert.ok(!app.order.some((o) => o.startsWith('connected')), 'the dead attempt brought nothing up');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), registryBefore, 'and wrote no identity');
});

test('the credentials an attempt uses are the ones it started with', async (context) => {
  // The fields are live inputs a reader can keep typing into. An identity
  // write that re-read them would record a server nobody dialled
  // (orchestrator's ruling, 2026-10-10).
  let release: ((machine: string) => void) | null = null;
  const activated: string[] = [];
  const app = await mount(context, () => new Promise((resolve) => { release = resolve; }), () => {}, [{
    activateConnected: (_storage: unknown, entry: { address: string; token: string }) => {
      activated.push(`${entry.address}|${entry.token}`);
      return { reload: false };
    },
    rememberedAddresses: () => [],
    currentConnection: () => null,
  }], withIdentity);
  const field = (selector: string, value: string) => {
    const input = app.document.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  };
  field('input[type="text"]', 'wss://dialled.test/ws');
  const tokenField = app.document.querySelector<HTMLInputElement>('input[type="password"], .token-wrap input');
  assert.ok(tokenField, 'the card has a token field');
  field('input[type="password"], .token-wrap input', 'dialled-token');
  await app.flush();
  [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 4; i++) await app.flush();
  assert.ok(app.order.includes('connect:wss://dialled.test/ws|dialled-token'), `the dial used what was typed: ${app.order.join(' → ')}`);
  field('input[type="password"], .token-wrap input', 'typed-after');   // the reader keeps editing
  await app.flush();
  release!('m-a');
  for (let i = 0; i < 8; i++) await app.flush();
  assert.deepEqual(activated, ['wss://dialled.test/ws|dialled-token'], 'the identity write used the credentials the attempt dialled with');
});

/** The form with a host leave walk the case controls. */
async function withWalk(context: TestContext, confirmLeave: (address: string) => Promise<boolean>) {
  const order: string[] = [];
  const pool = candidates(order, async () => 'm-b');
  const app = await (await compiled).mount(context, {
    props: { onConnected() { order.push('connected'); }, openCandidate: () => pool.open(), confirmLeave },
    modules: [],
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
  });
  const field = (selector: string, value: string) => {
    const input = app.document.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  };
  const submit = () => [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  return { app, order, field, submit };
}

test('the walk is asked about, and the dial uses, what was submitted — not what is typed while it is open (reviewer P1-b on 48b40082)', async (context) => {
  const asked: string[] = [];
  let answer: (leave: boolean) => void = () => {};
  const { app, order, field, submit } = await withWalk(context, (address) => {
    asked.push(address);
    return new Promise((resolve) => { answer = resolve; });
  });
  field('input[type="text"]', 'wss://approved.test/ws');
  field('input[type="password"], .token-wrap input', 'approved-token');
  await app.flush();
  submit();
  await app.flush();
  assert.deepEqual(asked, ['wss://approved.test/ws'], 'the walk is asked about the submitted address');
  assert.equal(order.length, 0, `and no candidate is opened while it is open: ${order.join(', ')}`);
  field('input[type="text"]', 'wss://typed-later.test/ws');   // edited during the walk
  field('input[type="password"], .token-wrap input', 'typed-later');
  await app.flush();
  answer(true);
  for (let i = 0; i < 8; i++) await app.flush();
  assert.deepEqual(order.filter((o) => o.startsWith('connect:')), ['connect:wss://approved.test/ws|approved-token'],
    'exactly one dial, to what was approved');
  assert.equal(app.window.localStorage.getItem('tmux_address'), 'wss://approved.test/ws', 'and that is what was saved');
});

test('a leave walk that fails is a stay: the form stops connecting, and nothing is left unhandled', async (context) => {
  const { app, order, field, submit } = await withWalk(context, () => Promise.reject(new Error('the walk broke')));
  field('input[type="text"]', 'wss://other.test/ws');
  await app.flush();
  submit();
  for (let i = 0; i < 8; i++) await app.flush();
  assert.deepEqual(order, [], 'no candidate was opened and nothing was dialled');
  assert.ok([...app.document.querySelectorAll<HTMLButtonElement>('button')].some((b) => /^connect$/iu.test((b.textContent ?? '').trim())),
    'the form is back to Connect, not stuck connecting');
});

// ── Reviewer P1-D on cc45d7d1: the form's busy state is its OWN attempt's,
// through the server's second handshake, and Cancel reaches that handshake.

const buttons = (app: { document: Document }) => [...app.document.querySelectorAll<HTMLButtonElement>('button')]
  .map((b) => (b.textContent ?? '').trim()).filter(Boolean);
const press = (app: { document: Document }, name: RegExp) =>
  [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => name.test((b.textContent ?? '').trim()))!.click();

test('after an ordinary auth failure the person can press Connect again, with no Cancel first', async (context) => {
  let refuse = true;
  const app = await mount(context, async () => { if (refuse) throw new Error('bad token'); return 'm-a'; }, alpha);
  await connectTo(app, 'wss://same.test/ws');
  assert.match(app.document.querySelector('.error')?.textContent ?? '', /bad token/u, 'the failure is shown');
  assert.ok(buttons(app).includes('Connect') && !buttons(app).includes('Cancel'), `the form is back to Connect: ${buttons(app).join(' | ')}`);
  refuse = false;
  press(app, /^connect$/iu);
  for (let i = 0; i < 8; i++) await app.flush();
  assert.equal(app.order.filter((o) => o === 'candidate').length, 2, 'the second press dialled a candidate of its own');
  assert.equal(app.order.at(-1), 'connected:false', 'and that one got through');
});

test('a second handshake that fails shows a usable error and allows a retry', async (context) => {
  let failure: string | null = 'the server s own dial was refused';
  const app = await mount(context, async () => 'm-a', alpha, [], compiled, () => ({ done: Promise.resolve(failure), cancel() {} }));
  await connectTo(app, 'wss://same.test/ws');
  assert.match(app.document.querySelector('.error')?.textContent ?? '', /own dial was refused/u, 'the second handshake s failure is the form s error');
  assert.ok(buttons(app).includes('Connect'), `and Connect is offered again: ${buttons(app).join(' | ')}`);
  failure = null;
  press(app, /^connect$/iu);
  for (let i = 0; i < 8; i++) await app.flush();
  assert.equal(app.order.filter((o) => o.startsWith('connected')).length, 2, 'the retry ran the whole road again');
  assert.equal(app.document.querySelector('.error'), null, 'and the old error is gone');
});

test('Cancel while the second handshake is out cancels THAT handshake, and its late answer changes nothing in the form', async (context) => {
  let answer: (failure: string | null) => void = () => {};
  let cancelled = 0;
  const app = await mount(context, async () => 'm-a', alpha, [], compiled,
    () => ({ done: new Promise<string | null>((resolve) => { answer = resolve; }), cancel() { cancelled++; } }));
  await connectTo(app, 'wss://same.test/ws');
  assert.ok(buttons(app).includes('Cancel'), `the form stays busy through the second handshake: ${buttons(app).join(' | ')}`);
  press(app, /^cancel$/iu);
  await app.flush();
  assert.equal(cancelled, 1, 'Cancel reached the server s own dial');
  assert.ok(buttons(app).includes('Connect'), 'and the form is free');
  answer('refused, late');
  for (let i = 0; i < 8; i++) await app.flush();
  assert.equal(app.document.querySelector('.error'), null, 'a cancelled attempt reports nothing');
});

test('leaving the form during the second handshake cancels it too', async (context) => {
  let cancelled = 0;
  const app = await mount(context, async () => 'm-a', alpha, [], compiled,
    () => ({ done: new Promise<string | null>(() => {}), cancel() { cancelled++; } }));
  await connectTo(app, 'wss://same.test/ws');
  await app.unmount();
  assert.equal(cancelled, 1, 'nothing the form started outlives it');
});

test('a candidate the app stopped waiting on is closed, and the form is not left busy', async (context) => {
  let release: ((machine: string) => void) | null = null;
  const app = await mount(context, () => new Promise((resolve) => { release = resolve; }), alpha);
  await connectTo(app, 'wss://same.test/ws');
  app.pool.stale();                                       // a newer activation took over
  release!('m-a');
  for (let i = 0; i < 8; i++) await app.flush();
  assert.equal(app.order.at(-1), 'close', `the superseded candidate leaves no live connection: ${app.order.join(' → ')}`);
  assert.ok(buttons(app).includes('Connect'), `and the form is back to Connect: ${buttons(app).join(' | ')}`);
});

// Board #381: the page layer clips, so the one scroller the person has is the
// form's own `.wrapper` (its CSS is pinned in Settings.source.test.ts and its
// geometry proved in Chromium). That only helps if every action the card
// offers is rendered INSIDE that scroller, in each state the card can be in.
test('every action on the card renders inside the page\'s own scroller (#381)', async (context) => {
  let release: ((machine: string) => void) | null = null;
  const app = await mount(context, () => new Promise((resolve) => { release = resolve; }), alpha);
  const scroller = app.document.querySelector('.wrapper');
  assert.ok(scroller, 'the form renders its scroller');
  assert.ok(scroller.querySelector(':scope > .card'), 'the card sits directly in it');
  const outside = () => [...app.document.querySelectorAll('button')]
    .filter((button) => !scroller.contains(button)).map((button) => button.textContent?.trim());
  assert.ok(buttons(app).includes('Connect') && buttons(app).some((label) => /share/iu.test(label)), `idle: Connect and Share render: ${buttons(app).join(' | ')}`);
  assert.deepEqual(outside(), [], 'idle: no action outside the scroller');
  await connectTo(app, 'wss://same.test/ws');
  assert.ok(buttons(app).includes('Cancel'), `connecting: Cancel renders: ${buttons(app).join(' | ')}`);
  assert.deepEqual(outside(), [], 'connecting: no action outside the scroller');
  release!('m-a');
  for (let i = 0; i < 8; i++) await app.flush();
});

// ─── #400 review P1-D: a pick applies the saved server's WHOLE tuple ──────

const SOCKET_INPUT = 'input[placeholder="/tmp/tmux-1000/default"]';
const twoSaved = (socketB?: string) => (storage: Storage) => {
  storage.setItem('tmux_servers', JSON.stringify([
    { id: 'a', name: 'alpha', address: 'wss://a.test/ws', token: 'tokA', socket: '/tmp/sockA', machineId: 'm-a', named: true },
    { id: 'b', name: 'beta', address: 'wss://b.test/ws', token: 'tokB', ...(socketB ? { socket: socketB } : {}), machineId: 'm-b', named: true },
  ]));
  storage.setItem('tmux_server_current', 'a');
};

async function pickThenConnect(app: Awaited<ReturnType<typeof mount>>, address: string) {
  const value = (selector: string) => app.document.querySelector<HTMLInputElement>(selector)!.value;
  const fields = () => ({ address: value('input[type="text"]'), token: value('.token-wrap input'), socket: value(SOCKET_INPUT) });
  const opened = fields();
  app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
  await app.flush();
  [...app.document.querySelectorAll<HTMLButtonElement>('.hist-item')].find((b) => b.textContent === address)!.click();
  await app.flush();
  const picked = fields();
  [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
  for (let i = 0; i < 8; i++) await app.flush();
  return { opened, picked };
}

test('picking a saved server applies its address, token AND socket, and the connect sets that socket and records that tuple', async (context) => {
  const app = await mount(context, async () => 'm-b', twoSaved('/tmp/sockB'));
  app.pool.open = ((open) => () => ({ ...open(), machineId: () => 'm-b' }))(app.pool.open.bind(app.pool));
  const { opened, picked } = await pickThenConnect(app, 'wss://b.test/ws');
  assert.deepEqual(opened, { address: 'wss://a.test/ws', token: 'tokA', socket: '/tmp/sockA' }, 'the form opened on alpha\u2019s tuple');
  assert.deepEqual(picked, { address: 'wss://b.test/ws', token: 'tokB', socket: '/tmp/sockB' }, 'and beta\u2019s pick replaced all three, not two');
  assert.deepEqual(app.order.filter((o) => o.startsWith('connect:') || o.startsWith('socket:')),
    ['connect:wss://b.test/ws|tokB', 'socket:/tmp/sockB'], 'the socket set on beta is beta\u2019s, never alpha\u2019s');
  const ls = app.window.localStorage;
  const beta = JSON.parse(ls.getItem('tmux_servers')!).find((e: { id: string }) => e.id === 'b');
  assert.equal(beta.socket, '/tmp/sockB', 'the recorded tuple is beta\u2019s own');
  assert.equal(ls.getItem('tmux_socket'), '/tmp/sockB');
});

test('picking a saved server that has no socket clears the previous server\u2019s socket: nothing is set on it and none is recorded', async (context) => {
  const app = await mount(context, async () => 'm-b', twoSaved());
  app.pool.open = ((open) => () => ({ ...open(), machineId: () => 'm-b' }))(app.pool.open.bind(app.pool));
  const { opened, picked } = await pickThenConnect(app, 'wss://b.test/ws');
  assert.equal(opened.socket, '/tmp/sockA');
  assert.deepEqual(picked, { address: 'wss://b.test/ws', token: 'tokB', socket: '' }, 'alpha\u2019s socket did not follow the pick');
  assert.deepEqual(app.order.filter((o) => o.startsWith('connect:') || o.startsWith('socket:')), ['connect:wss://b.test/ws|tokB'], 'no setSocket on beta');
  const ls = app.window.localStorage;
  const beta = JSON.parse(ls.getItem('tmux_servers')!).find((e: { id: string }) => e.id === 'b');
  assert.equal('socket' in beta, false, 'beta\u2019s recorded tuple has no socket');
  assert.equal(ls.getItem('tmux_socket'), null);
});
