// The connect form hands the shared socket over in the right ORDER, and gives
// it back whatever the outcome (board #335 ②b-1, reviewer P1-b ii and the
// 2026-10-10 follow-up).
//
// This form can reach a DIFFERENT server than the one the app is on, and
// through ②b every page is talking over one connection object. So the host
// must get to stand its current handle down BEFORE the socket is re-dialled:
// after it points elsewhere, a call still in flight from the old tree — or a
// callback that settles before the new tree mounts — would be the old
// server's work sent to the new one.
//
// And it must get the handle BACK when the attempt settles, because nobody
// knows until the server authenticates whether this address is the same
// server. Revoking outright would remount every always-mounted page on an
// ordinary reconnect and throw away the state they exist to keep.
//
// A source pin would only say the calls are written somewhere in the
// function. A mount says they happened, and in which order.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';
import { createHandovers } from './handover.ts';

const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
]);

async function mount(
  context: TestContext,
  connect: () => Promise<unknown>,
  seed: (storage: Storage) => void = () => {},
) {
  const order: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {
      onConnected() { order.push('connected'); },
      beforeConnect() {
        order.push('stand-down');
        return {
          current: () => true,
          settle: (outcome: string) => order.push(`conclude:${outcome}`),
        };
      },
    },
    modules: [{
      connect: async (...args: unknown[]) => { order.push('connect'); return connect.apply(null, args as []); },
      disconnect: () => {},
      getMachineId: () => 'm-a',
      setSocket: async () => {},
    }],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      seed(window.localStorage);
    },
  });
  return { ...app, order };
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

test('the current server s handle stands down BEFORE the socket is re-dialled', async (context) => {
  const app = await mount(context, async () => 'm-a');
  await connectTo(app, 'wss://other.test/ws');
  assert.ok(app.order.includes('connect'), `the form dialled: ${app.order.join(' → ')}`);
  assert.deepEqual(app.order.slice(0, 2), ['stand-down', 'connect'],
    'first the handle stands down; after the re-dial the old tree would be talking to the new server');
});

test('a same-server reconnect reports that conclusion, after the dial', async (context) => {
  // The reconnect case: the identity layer confirms this is the server we
  // were on, so the host may keep its handle. Without a conclusion to report,
  // a plain reconnect would replace the handle, rebuild every page and ask no
  // leave guard.
  // The client is already on this machine: a saved entry, current, with the
  // mirror pointing at it. Only then is re-dialling it a RECONNECT rather
  // than a first connect to an unknown server.
  const app = await mount(context, async () => 'm-a', (storage) => {
    storage.setItem('tmux_servers', JSON.stringify([
      { id: 'a', name: 'alpha', address: 'wss://same.test/ws', token: 'tok', machineId: 'm-a', named: true },
    ]));
    storage.setItem('tmux_server_current', 'a');
    storage.setItem('tmux_address', 'wss://same.test/ws');
    storage.setItem('tmux_token', 'tok');
    storage.setItem('tmux_machine_id', 'm-a');
  });
  await connectTo(app, 'wss://same.test/ws');
  assert.ok(app.order.indexOf('conclude:same-server') > app.order.indexOf('connect'),
    `concluded after the dial: ${app.order.join(' → ')}`);
  assert.equal(app.order.at(-1), 'connected', 'and App is told last');
});

test('a dial that never reached a peer says so', async (context) => {
  // No authenticated stranger on the socket, so there is nothing for the old
  // handle to be confused with.
  const app = await mount(context, async () => { throw new Error('refused'); });
  await connectTo(app, 'wss://down.test/ws');
  assert.deepEqual(app.order, ['stand-down', 'connect', 'conclude:no-peer']);
});

test('a superseded attempt concludes nothing', async (context) => {
  // Handovers overlap in ordinary use: a dial is in flight and the person
  // submits again (or leaves the form and comes back, which is a new
  // instance). The older attempt must not report a conclusion — with a
  // boolean suspension its late "I am done" would lift the live attempt's
  // protection and put the old server's pages on a socket that is still
  // authenticating (reviewer P1, 2026-10-10).
  const pending: ((machine: string) => void)[] = [];
  const app = await mount(context, () => new Promise((resolve) => { pending.push(resolve); }));
  await connectTo(app, 'wss://same.test/ws');          // attempt 1, in flight
  assert.deepEqual(app.order, ['stand-down', 'connect'], 'the first dial is pending');

  // The form does not let one instance dial twice at once (the button is
  // disabled while connecting), so the second attempt starts the way a person
  // reaches it: cancel, then submit again.
  const cancel = [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => /cancel/iu.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`));
  assert.ok(cancel, 'the connecting state offers Cancel');
  cancel.click();
  await app.flush();
  await connectTo(app, 'wss://same.test/ws');          // attempt 2 supersedes it
  assert.deepEqual(app.order.filter((o) => o === 'connect').length, 2, 'two dials were started');

  assert.equal(pending.length, 2, 'both dials are waiting');
  pending[0]!('m-a');                                   // the OLD dial settles
  for (let i = 0; i < 8; i++) await app.flush();
  assert.deepEqual(app.order.filter((o) => o.startsWith('conclude')), [],
    'the superseded attempt reported nothing at all');
  assert.ok(!app.order.includes('connected'), 'and did not bring the app up either');
});

// The identity layer, mocked, so the one failure that matters can happen: a
// peer authenticates and the client cannot record WHICH server it is.
const withIdentity = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
  new URL('./servers.ts', import.meta.url),
]);

test('a peer that authenticated but could not be identified is not a same-server success', async (context) => {
  // The reviewer's second fixture: B authenticates, the registry write fails,
  // CURRENT still names A. Reporting "the function finished" would resume A's
  // handle onto B's socket. The conclusion must be `unresolved`, the form must
  // say so, and the app must NOT be told it is connected.
  const order: string[] = [];
  const app = await (await withIdentity).mount(context, {
    props: {
      onConnected(switched: boolean) { order.push(`connected:${switched}`); },
      beforeConnect() {
        order.push('stand-down');
        return {
          current: () => true,
          settle: (outcome: string) => order.push(`conclude:${outcome}`),
        };
      },
    },
    modules: [
      {
        connect: async () => { order.push('connect'); return 'm-b'; },
        disconnect: () => { order.push('disconnect'); },
        getMachineId: () => 'm-b',
        setSocket: async () => {},
      },
      {
        // Everything Settings asks of the identity layer, with the one write
        // that fails.
        activateConnected: () => { order.push('activate'); throw new Error('storage full'); },
      },
    ],
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
  });
  await connectTo({ ...app, order }, 'wss://stranger.test/ws');

  assert.deepEqual(order, ['stand-down', 'connect', 'activate', 'conclude:unresolved', 'disconnect'],
    'the attempt concluded `unresolved` and dropped the socket it could not identify');
  assert.ok(!order.some((o) => o.startsWith('connected')),
    'and the app was never told this was its server');
  assert.match(app.document.querySelector('.error')?.textContent ?? '',
    /identif/iu, 'the person is told why');
});

test('an attempt the HOST has moved on from writes nothing and concludes nothing', async (context) => {
  // Across instances (reviewer, 2026-10-10): this form can be unmounted
  // mid-dial and a new one started, so the form's own counter cannot be the
  // whole answer — to the old instance its attempt is still its latest. The
  // host's handover is the authority, and it says the app is waiting on
  // someone else now. The late dial must then write no identity, bring
  // nothing up and settle nothing.
  // The REAL handover bookkeeping, and the real way it goes stale: the host
  // ends every open handover when it takes the handle back (a switch), which
  // is `handovers.endAll()` — not a boolean this test flips (reviewer,
  // 2026-10-10).
  const order: string[] = [];
  const handovers = createHandovers({ end: () => {} });
  let release: ((machine: string) => void) | null = null;
  const app = await (await compiled).mount(context, {
    props: {
      onConnected(switched: boolean) { order.push(`connected:${switched}`); },
      beforeConnect() {
        order.push('stand-down');
        const handover = handovers.open(null);
        return {
          current: () => handover.current(),
          settle: (outcome: string) => {
            handover.settle(outcome as 'same-server');
            if (handover.current()) order.push(`conclude:${outcome}`);
          },
        };
      },
    },
    modules: [{
      connect: (url: string) => {
        order.push(`connect:${url}`);
        return new Promise((resolve) => { release = resolve; });
      },
      disconnect: () => {},
      getMachineId: () => 'm-a',
      setSocket: async () => {},
    }],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      window.localStorage.setItem('tmux_servers', JSON.stringify([
        { id: 'a', name: 'alpha', address: 'wss://same.test/ws', token: 'tok', machineId: 'm-a', named: true },
      ]));
      window.localStorage.setItem('tmux_server_current', 'a');
    },
  });
  await connectTo({ ...app, order }, 'wss://same.test/ws');
  assert.deepEqual(order, ['stand-down', 'connect:wss://same.test/ws'], 'the dial is in flight');

  // The app took the handle back — what `revokeScope` does on a switch.
  handovers.endAll();
  const registryBefore = app.window.localStorage.getItem('tmux_servers');
  release!('m-a');
  for (let i = 0; i < 8; i++) await app.flush();

  assert.deepEqual(order.filter((o) => o.startsWith('conclude') || o.startsWith('connected')), [],
    'the stale attempt settled nothing and brought nothing up');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), registryBefore,
    'and wrote no identity');
});

test('an attempt dies with the form: no identity, no onConnected, no disconnect', async (context) => {
  // The host's ticket cannot cover this one (orchestrator's ruling,
  // 2026-10-10): a re-dial that does NOT go through a handover — the
  // Connection page's address rows, the periodic optimizer — leaves the
  // host's handover current. So a dial started by a form the reader has since
  // left would still look live, and could disconnect or write identity over
  // the socket that re-dial now owns.
  const order: string[] = [];
  let release: ((machine: string) => void) | null = null;
  const app = await (await compiled).mount(context, {
    props: {
      onConnected(switched: boolean) { order.push(`connected:${switched}`); },
      beforeConnect() {
        order.push('stand-down');
        // Still "current": nothing else started a handover, which is exactly
        // the case the component's own lifetime has to answer.
        return { current: () => true, settle: (o: string) => order.push(`conclude:${o}`) };
      },
    },
    modules: [{
      connect: () => { order.push('connect'); return new Promise((resolve) => { release = resolve; }); },
      disconnect: () => { order.push('disconnect'); },
      getMachineId: () => 'm-b',
      setSocket: async () => {},
    }],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      window.localStorage.setItem('tmux_servers', JSON.stringify([
        { id: 'a', name: 'alpha', address: 'wss://a.test/ws', token: 'tok', machineId: 'm-a', named: true },
      ]));
      window.localStorage.setItem('tmux_server_current', 'a');
    },
  });
  await connectTo({ ...app, order }, 'wss://b.test/ws');
  assert.deepEqual(order, ['stand-down', 'connect'], 'the dial is in flight');
  const registryBefore = app.window.localStorage.getItem('tmux_servers');

  await app.unmount();                                   // the reader leaves the form
  release!('m-b');                                        // and the dial comes back
  for (let i = 0; i < 8; i++) await app.flush();

  assert.deepEqual(order, ['stand-down', 'connect'],
    'the dead attempt concluded nothing, brought nothing up and disconnected nothing');
  assert.equal(app.window.localStorage.getItem('tmux_servers'), registryBefore,
    'and wrote no identity');
});

test('the credentials an attempt uses are the ones it started with', async (context) => {
  // The fields are live inputs a reader can keep typing into. An identity
  // write that re-read them would record a server nobody dialled — a token
  // that was never authenticated, filed against the address that was
  // (orchestrator's ruling, 2026-10-10).
  const seen: { url?: string; token?: string } = {};
  const order: string[] = [];
  let release: ((machine: string) => void) | null = null;
  const app = await (await withIdentity).mount(context, {
    props: {
      onConnected() { order.push('connected'); },
      beforeConnect() { return { current: () => true, settle: () => {} }; },
    },
    modules: [
      {
        connect: (url: string, token: string) => {
          seen.url = url;
          seen.token = token;
          return new Promise((resolve) => { release = resolve; });
        },
        disconnect: () => {},
        getMachineId: () => 'm-a',
        setSocket: async () => {},
      },
      {
        activateConnected: (_storage: unknown, entry: { address: string; token: string }) => {
          order.push(`activate:${entry.address}|${entry.token}`);
          return { reload: false };
        },
      },
    ],
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
  });

  // Type an address and a token, submit, then keep typing while it dials.
  const field = (selector: string, value: string) => {
    const input = app.document.querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  };
  field('input[type="text"]', 'wss://dialled.test/ws');
  const tokenField = app.document.querySelector<HTMLInputElement>('input[type="password"], .token-wrap input');
  if (tokenField) {
    tokenField.value = 'dialled-token';
    tokenField.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  }
  await app.flush();
  const submit = [...app.document.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => /^connect$/iu.test((b.textContent ?? '').trim()));
  assert.ok(submit, `the card has a connect button: ${
    [...app.document.querySelectorAll('button')].map((b) => b.textContent?.trim()).join(' | ')}`);
  submit.click();
  for (let i = 0; i < 4; i++) await app.flush();
  assert.equal(seen.url, 'wss://dialled.test/ws', 'the dial used what was typed');

  if (tokenField) {
    tokenField.value = 'typed-after';                    // the reader keeps editing
    tokenField.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    await app.flush();
  }
  release!('m-a');
  for (let i = 0; i < 8; i++) await app.flush();

  assert.deepEqual(order.filter((o) => o.startsWith('activate')),
    [`activate:wss://dialled.test/ws|${seen.token}`],
    'the identity write used the credentials the attempt dialled with');
});

/** The form with a host leave walk the case controls. */
async function withWalk(context: TestContext, confirmLeave: (address: string) => Promise<boolean>) {
  const order: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {
      onConnected() { order.push('connected'); },
      beforeConnect() { order.push('stand-down'); return { current: () => true, settle: () => {} }; },
      confirmLeave,
    },
    modules: [{
      connect: async (url: string, token: string) => { order.push(`connect:${url}|${token}`); return 'm-b'; },
      disconnect: () => {},
      getMachineId: () => 'm-b',
      setSocket: async () => {},
    }],
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
  // The credentials freeze at SUBMIT, before the walk's await: the walk can
  // stay open for as long as a dialog takes, and the fields stay live inputs
  // (a person, or a late autofill) the whole time. The target the person
  // approved has to be the one dialled.
  const asked: string[] = [];
  let answer: (leave: boolean) => void = () => {};
  const { app, order, field, submit } = await withWalk(context, (address) => {
    asked.push(address);
    return new Promise((resolve) => { answer = resolve; });
  });
  field('input[type="text"]', 'wss://approved.test/ws');
  const tokenField = app.document.querySelector<HTMLInputElement>('input[type="password"], .token-wrap input');
  assert.ok(tokenField, 'the card has a token field');
  tokenField.value = 'approved-token';
  tokenField.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  await app.flush();
  submit();
  await app.flush();
  assert.deepEqual(asked, ['wss://approved.test/ws'], 'the walk is asked about the submitted address');
  assert.equal(order.length, 0, `and nothing is dialled while it is open: ${order.join(', ')}`);

  field('input[type="text"]', 'wss://typed-later.test/ws');   // edited during the walk
  tokenField.value = 'typed-later';
  tokenField.dispatchEvent(new app.window.Event('input', { bubbles: true }));
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
  assert.deepEqual(order, [], 'nothing stood down and nothing was dialled');
  assert.ok([...app.document.querySelectorAll<HTMLButtonElement>('button')].some((b) => /^connect$/iu.test((b.textContent ?? '').trim())),
    'the form is back to Connect, not stuck connecting');
});
