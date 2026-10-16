import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';
import { COMPLETION_FEEDBACK_MS } from '../ui/feedback-lifetime.ts';
import { parseConnectionLink } from '../core/connection-link.ts';

const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/clipboard.ts', import.meta.url),
]);

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function mount(context: TestContext, copy: (link: string) => boolean | Promise<boolean>, savedAddress = 'wss://fixture.test/ws') {
  const timers = new Set<unknown>();
  let scheduled = 0;
  const app = await (await compiled).mount(context, {
    props: { onConnected() {} },
    modules: [{ copyText: copy }],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      // The form opens on CURRENT's saved tuple (#400).
      window.localStorage.setItem('tmux_servers', JSON.stringify([
        { id: 'a', name: 'fixture', address: savedAddress, token: 'fake-token&=+', socket: '/tmp/fake socket' },
      ]));
      window.localStorage.setItem('tmux_server_current', 'a');
      const set = window.setTimeout, clear = window.clearTimeout;
      window.setTimeout = ((run, delay, ...args) => {
        const handle = set(run, delay, ...args);
        // Include the retired duration so the old implementation fails cleanup too.
        if (delay === COMPLETION_FEEDBACK_MS || delay === 2000) { timers.add(handle); scheduled++; }
        return handle;
      }) as typeof window.setTimeout;
      window.clearTimeout = handle => { timers.delete(handle); clear(handle); };
    },
  });
  const button = () => app.document.querySelector<HTMLButtonElement>('.share-btn')!;
  return {
    ...app, button, timers, scheduled: () => scheduled,
    async copy() { button().click(); await app.flush(); },
    async edit(selector: string, value: string) {
      const input = app.document.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
      await app.flush();
    },
  };
}

test('Settings copy failure stays visible and directly retryable; only success expires (#167)', async context => {
  let calls = 0;
  const app = await mount(context, link => {
    // The connection itself (#401): the gateway address with the credentials
    // as parameters, nothing of the front end that served this page.
    assert.ok(link.startsWith('wss://fixture.test/ws?'), 'the link starts at the gateway address');
    assert.doesNotMatch(link, /mount\.test|addr=/u, 'and carries no front end');
    assert.deepEqual(parseConnectionLink(link), { kind: 'link', link: { address: 'wss://fixture.test/ws', token: 'fake-token&=+', socket: '/tmp/fake socket' } });
    return ++calls > 1;
  });
  try {
    await app.copy();
    const error = app.document.querySelector('.card > .config-error[role=alert]');
    assert.equal(error?.textContent?.trim(), 'Copy failed');
    assert.equal(error?.nextElementSibling, app.button(), 'the inline error sits beside the direct retry');
    assert.equal(app.document.querySelector('.operation-feedback'), null, 'the connect card has no nested feedback frame');
    assert.equal(app.button().textContent?.trim(), 'Share connection link', 'false is never Copied');
    assert.equal(app.button().disabled, false, 'the original command is the direct retry');
    await app.advance(COMPLETION_FEEDBACK_MS * 2);
    assert.ok(app.document.querySelector('.config-error[role=alert]'), 'failure has no expiry');
    await app.copy();
    assert.equal(calls, 2);
    assert.equal(app.document.querySelector('.config-error[role=alert]'), null);
    assert.equal(app.button().textContent?.trim(), 'Link copied');
    await app.advance(COMPLETION_FEEDBACK_MS - 1);
    assert.equal(app.button().textContent?.trim(), 'Link copied');
    await app.advance(1);
    assert.equal(app.button().textContent?.trim(), 'Share connection link');
  } finally { await app.close(); }
});

test('Settings success uses the shared completion duration, not its old two-second timer (#167)', async context => {
  const app = await mount(context, () => true);
  try {
    await app.copy();
    assert.equal(app.button().textContent?.trim(), 'Link copied');
    await app.advance(COMPLETION_FEEDBACK_MS);
    assert.equal(app.button().textContent?.trim(), 'Share connection link');
  } finally { await app.close(); }
});

test('a newer Settings copy owns both its completion and expiry (#167)', async context => {
  const pending = deferred();
  let calls = 0;
  const app = await mount(context, () => ++calls === 2 ? pending.promise : true);
  try {
    await app.copy();
    await app.advance(COMPLETION_FEEDBACK_MS - 100);
    await app.copy();
    assert.equal(app.button().textContent?.trim(), 'Share connection link', 'a new attempt clears old success');
    await app.advance(100);
    pending.resolve(true); await app.flush();
    assert.equal(app.button().textContent?.trim(), 'Link copied');
    await app.advance(COMPLETION_FEEDBACK_MS - 1);
    assert.equal(app.button().textContent?.trim(), 'Link copied', 'the older timer cannot shorten this beat');
    await app.advance(1);
    assert.equal(app.button().textContent?.trim(), 'Share connection link');
  } finally { pending.resolve(true); await app.close(); }
});

test('Settings input A-B-A invalidates pending copies and visible feedback (#167)', async context => {
  const attempts: ReturnType<typeof deferred>[] = [];
  const app = await mount(context, () => {
    const pending = deferred(); attempts.push(pending); return pending.promise;
  });
  try {
    for (const [selector, value, other] of [
      ['.addr-wrap input', 'wss://fixture.test/ws', 'wss://other.test/ws'],
      ['.token-wrap input', 'fake-token&=+', 'other-fake-token'],
      ['input[placeholder="/tmp/tmux-1000/default"]', '/tmp/fake socket', '/tmp/other-fake'],
    ]) {
      await app.copy();
      const old = attempts.at(-1)!;
      await app.edit(selector!, other!);
      await app.edit(selector!, value!);
      old.resolve(true); await app.flush();
      assert.equal(app.button().textContent?.trim(), 'Share connection link', 'returning to the same input is a new context');
      await app.copy();
      attempts.at(-1)!.resolve(false); await app.flush();
      assert.ok(app.document.querySelector('.config-error[role=alert]'));
      await app.edit(selector!, other!);
      assert.equal(app.document.querySelector('.config-error[role=alert]'), null, 'editing clears the old error');
      await app.edit(selector!, value!);
    }
  } finally { for (const pending of attempts) pending.resolve(false); await app.close(); }
});

test('a late failed Settings copy cannot replace the latest success (#167)', async context => {
  const old = deferred();
  let calls = 0;
  const app = await mount(context, () => ++calls === 1 ? old.promise : true);
  try {
    await app.copy(); await app.copy();
    old.resolve(false); await app.flush();
    assert.equal(app.document.querySelector('.config-error[role=alert]'), null);
    assert.equal(app.button().textContent?.trim(), 'Link copied');
    await app.advance(COMPLETION_FEEDBACK_MS);
    assert.equal(app.button().textContent?.trim(), 'Share connection link');
  } finally { old.resolve(false); await app.close(); }
});

test('leaving Settings clears its completion timer (#167)', async context => {
  const app = await mount(context, () => true);
  try {
    await app.copy();
    await app.close();
    assert.equal(app.timers.size, 0, 'unmount releases the completion timer');
  } finally { await app.close(); }
});

test('a Settings copy resolving after unmount cannot publish or schedule feedback (#167)', async context => {
  const pending = deferred();
  const app = await mount(context, () => pending.promise);
  try {
    await app.copy(); await app.close();
    pending.resolve(true);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(app.scheduled(), 0, 'a departed connect page has no feedback lifetime');
  } finally { pending.resolve(false); await app.close(); }
});

test('an endpoint whose own query holds token or socket cannot be shared: nothing is copied, the message names no part of it (#401 review P2-C)', async context => {
  let copies = 0;
  const app = await mount(context, () => { copies++; return true; });
  try {
    await app.edit('.addr-wrap input', 'wss://fixture.test/ws?token=route-secret');
    await app.copy();
    assert.equal(copies, 0, 'no link was made');
    const error = app.document.querySelector('.card > .config-error[role=alert]');
    assert.equal(error?.textContent?.trim(), 'This address cannot be shared as a link');
    assert.ok(!app.document.documentElement.outerHTML.includes('route-secret'));
    await app.edit('.addr-wrap input', 'wss://fixture.test/ws?region=eu');
    await app.copy();
    assert.equal(copies, 1, 'an ordinary query is carried');
  } finally { await app.close(); }
});

test('a typed link that cannot be used leaves the form as it was: Share copies the restored address, not the refused text (#401 review round 3)', async context => {
  const copied: string[] = [];
  const app = await mount(context, link => { copied.push(link); return true; });
  try {
    await app.edit('.addr-wrap input', 'https://front.example/?token=SECRET-ONE');
    app.document.querySelector('.addr-wrap input')!.dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.flush();
    assert.equal(app.document.querySelector<HTMLInputElement>('.addr-wrap input')!.value, 'wss://fixture.test/ws');
    await app.copy();
    assert.equal(copied.length, 1);
    assert.deepEqual(parseConnectionLink(copied[0]!), { kind: 'link', link: { address: 'wss://fixture.test/ws', token: 'fake-token&=+', socket: '/tmp/fake socket' } });
    assert.ok(!copied[0]!.includes('SECRET-ONE') && !app.document.documentElement.outerHTML.includes('SECRET-ONE'));
  } finally { await app.close(); }
});

// The login Share is bound by the same one endpoint check as the connected Copy
// (#401 review round 4): an address that holds its own token or socket
// parameters is refused with the credential-free message, never copied with the
// parameters quietly removed.
for (const [what, address] of [
  ['both parameters', 'wss://fixture.test/ws?token=route-secret&socket=%2Froute-socket'],
  ['an encoded key', 'wss://fixture.test/ws?%74oken=route-secret'],
  ['a fragment', 'wss://fixture.test/ws#frag'],
  ['user info and a password', 'wss://user:route-secret@fixture.test/ws'],
  ['user info behind extra slashes', 'wss:////user:route-secret@fixture.test/ws'],
  ['user info behind a tab', 'wss:\t//user:route-secret@fixture.test/ws'],
] as const) {
  test(`Share refuses an address that holds ${what} of its own: nothing is copied, the saved address is left as it was, and the error message names no part of it`, async context => {
    let copies = 0;
    const app = await mount(context, () => { copies++; return true; }, address);
    try {
      const field = () => app.document.querySelector<HTMLInputElement>('.addr-wrap input')!.value;
      assert.equal(field(), address, 'the form opened on the saved address as it is');
      await app.copy();
      assert.equal(copies, 0, 'no link was made');
      assert.equal(app.document.querySelector('.card > .config-error[role=alert]')?.textContent?.trim(), 'This address cannot be shared as a link');
      assert.equal(field(), address, 'the saved address stays in the input exactly as saved (it is not rewritten into something shareable; only the MESSAGE is proven credential-free)');
      assert.equal(app.document.querySelector<HTMLInputElement>('.token-wrap input')!.value, 'fake-token&=+', 'nor was a credential taken out of it');
      assert.ok(!/route-secret|route-socket/u.test(app.document.querySelector('.card > .config-error')?.textContent ?? ''), 'the message names no part of it');
    } finally { await app.close(); }
  });
}
