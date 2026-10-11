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
        setSocket: async () => {},
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
) {
  const order: string[] = [];
  const pool = candidates(order, dial);
  const app = await (await which).mount(context, {
    props: {
      onConnected(switched: boolean) { order.push(`connected:${switched}`); },
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
  assert.deepEqual(app.order, ['candidate', 'connect:wss://same.test/ws|', 'close', 'connected:false'],
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
  assert.deepEqual(app.order, ['candidate', 'connect:wss://same.test/ws|'], 'the dial is in flight');
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
