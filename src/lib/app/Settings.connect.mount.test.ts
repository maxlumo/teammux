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

const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
]);

async function mount(context: TestContext, connect: () => Promise<unknown>) {
  const order: string[] = [];
  const app = await (await compiled).mount(context, {
    props: {
      onConnected() { order.push('connected'); },
      beforeConnect() {
        order.push('stand-down');
        return () => order.push('resume');
      },
    },
    modules: [{
      connect: async (...args: unknown[]) => { order.push('connect'); return connect.apply(null, args as []); },
      disconnect: () => {},
      getMachineId: () => 'm-a',
      setSocket: async () => {},
    }],
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
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

test('and it is handed back when the attempt settles', async (context) => {
  // The reconnect case: the address turns out to be the same server, so the
  // host must be able to keep its handle. If the form never gave it back, a
  // plain reconnect would replace the handle, rebuild every page and ask no
  // leave guard.
  const app = await mount(context, async () => 'm-a');
  await connectTo(app, 'wss://same.test/ws');
  assert.ok(app.order.indexOf('resume') > app.order.indexOf('connect'),
    `resumed after the dial: ${app.order.join(' → ')}`);
  assert.equal(app.order.at(-1), 'resume', 'and last, once the outcome is known');
});

test('a failed attempt hands the handle back too', async (context) => {
  // The tree is still on the server it was on; nothing changed hands.
  const app = await mount(context, async () => { throw new Error('refused'); });
  await connectTo(app, 'wss://down.test/ws');
  assert.deepEqual(app.order, ['stand-down', 'connect', 'resume']);
});
