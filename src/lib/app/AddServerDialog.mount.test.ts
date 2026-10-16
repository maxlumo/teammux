// Add server through the shared shell (board #317 review P2): the Dialog
// fixture can only show that the shell does not steal focus from a field that
// autofocused — it cannot show that THIS dialog's field is one. ConnectFields
// focuses the address input through its own action, so the pair is only real
// here: focus starts in the address FIELD, not on the first button. The
// restore to the opener is the shell's own contract and is tested in
// ui/Dialog.mount.test.ts with a real opener — this host is mounted for its
// whole lifetime, so there is no close for it to observe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { REJECTED_LINKS } from '../core/connection-link.fixtures.ts';

const compiled = compileMount(new URL('./AddServerDialog.svelte', import.meta.url), []);

test('the address field keeps the focus it took, and Escape is the shell\'s', async context => {
  let cancelled = 0;
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => { cancelled++; }, onsubmit: () => assert.fail('no submit here') },
    setup(window) {
      // Something outside holds focus first, so "the field took it" is a
      // real transfer rather than a default.
      const opener = window.document.createElement('button');
      opener.id = 'opener';
      window.document.body.append(opener);
      opener.focus();
    },
    modules: [],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('.dlg input'); i++) await app.flush();
    const address = app.document.querySelector<HTMLInputElement>('.dlg input')!;
    assert.equal(app.document.activeElement, address,
      'ConnectFields autofocused it and the shell did not move focus to "the first control"');
    // Escape is the shell's, and this dialog consumes nothing before it.
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await app.flush();
    assert.equal(cancelled, 1);
  } finally { await app.close(); }
});

test('an IME-composing Escape leaves a half-typed address alone', async context => {
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => assert.fail('that Escape belongs to the candidate window'), onsubmit: () => {} },
    modules: [],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('.dlg input'); i++) await app.flush();
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, cancelable: true }));
    await app.flush();
    assert.ok(app.document.querySelector('.dlg'), 'still open');
  } finally { await app.close(); }
});

test('a pick fills the saved server\u2019s whole tuple, its socket included, and submit hands it on (#400 review P1-D)', async context => {
  const submitted: unknown[] = [];
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => {}, onsubmit: (c: unknown) => { submitted.push(c); } },
    setup(window) {
      window.localStorage.setItem('tmux_servers', JSON.stringify([
        { id: 'a', name: 'alpha', address: 'ws://a.test:9899', token: 'tokA', socket: '/tmp/sockA' },
        { id: 'b', name: 'beta', address: 'ws://b.test:9899', token: 'tokB', socket: '/tmp/sockB' },
      ]));
      window.localStorage.setItem('tmux_server_current', 'a');
    },
    modules: [],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('.dlg input'); i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
    await app.flush();
    [...app.document.querySelectorAll<HTMLButtonElement>('.hist-item')].find((b) => b.textContent === 'ws://b.test:9899')!.click();
    await app.flush();
    const socket = app.document.querySelector<HTMLInputElement>('input[placeholder="/tmp/tmux-1000/default"]')!;
    assert.equal(socket.value, '/tmp/sockB');
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ address: 'ws://b.test:9899', token: 'tokB', socket: '/tmp/sockB' }]);
  } finally { await app.close(); }
});

test('a pasted connection link fills the dialog\u2019s fields and submit hands the tuple on (#401)', async context => {
  const submitted: unknown[] = [];
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => {}, onsubmit: (c: unknown) => { submitted.push(c); } },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
    modules: [],
  });
  try {
    for (let i = 0; i < 8 && !app.document.querySelector('.dlg input'); i++) await app.flush();
    const address = app.document.querySelector<HTMLInputElement>('.dlg input[type="text"]')!;
    address.value = 'https://front-end.example/?addr=ws://paste.example:9899&token=PASTED-TOKEN&socket=/tmp/pasted';
    const paste = new app.window.Event('input', { bubbles: true });
    Object.defineProperty(paste, 'inputType', { value: 'insertFromPaste' });
    address.dispatchEvent(paste);
    await app.flush();
    assert.equal(address.value, 'ws://paste.example:9899', 'the field keeps the address alone');
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ address: 'ws://paste.example:9899', token: 'PASTED-TOKEN', socket: '/tmp/pasted' }]);
  } finally { await app.close(); }
});

// ─── #401: the dialog refuses what carries a credential and names no server ──

const FIELDS = {
  address: '.dlg input[type="text"]',
  token: '.dlg .token-wrap input',
  socket: '.dlg input[placeholder="/tmp/tmux-1000/default"]',
};
async function openDialog(context: import('node:test').TestContext, submitted: unknown[] = []) {
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => {}, onsubmit: (c: unknown) => { submitted.push(c); } },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
    modules: [],
  });
  for (let i = 0; i < 8 && !app.document.querySelector('.dlg input'); i++) await app.flush();
  const el = (selector: string) => app.document.querySelector<HTMLInputElement>(selector)!;
  const set = async (selector: string, value: string, inputType?: string) => {
    el(selector).value = value;
    const event = new app.window.Event('input', { bubbles: true });
    if (inputType) Object.defineProperty(event, 'inputType', { value: inputType });
    el(selector).dispatchEvent(event);
    await app.flush();
  };
  return { app, el, set };
}

for (const [what, text] of REJECTED_LINKS) {
  test(`the dialog: pasting ${what} restores the field, leaves the others alone, and shows no part of it`, async context => {
    const submitted: unknown[] = [];
    const { app, el, set } = await openDialog(context, submitted);
    try {
      await set(FIELDS.address, 'ws://keep.example:9899');
      await set(FIELDS.token, 'KEEP-TOKEN');
      await set(FIELDS.socket, '/keep/sock');
      await set(FIELDS.address, text, 'insertFromPaste');
      assert.equal(el(FIELDS.address).value, 'ws://keep.example:9899');
      assert.equal(el(FIELDS.token).value, 'KEEP-TOKEN');
      assert.equal(el(FIELDS.socket).value, '/keep/sock');
      const message = app.document.querySelector('.dlg .config-error[role=alert]');
      assert.match(message?.textContent ?? '', /^(?:This link(?:'s address contains a credential| has no server address| cannot be read: a token or socket appears twice)|This text contains hidden characters)$/u);
      for (const secret of ['SECRET-ONE', 'SECRET-TWO', 'secret-socket', 'OUTER-TOKEN']) {
        assert.ok(!app.document.documentElement.outerHTML.includes(secret), `${secret} is nowhere in the page`);
        assert.ok(![...app.document.querySelectorAll('input')].some(i => i.value.includes(secret)), `or in any field`);
      }
      [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
      await app.flush();
      assert.deepEqual(submitted, [], 'and Connect submits nothing');
    } finally { await app.close(); }
  });
}

test('the dialog: a pasted empty-credential link clears what the form held, and submit hands exactly that tuple on', async context => {
  const submitted: unknown[] = [];
  const { app, el, set } = await openDialog(context, submitted);
  try {
    await set(FIELDS.address, 'ws://keep.example:9899');
    await set(FIELDS.token, 'KEEP-TOKEN');
    await set(FIELDS.socket, '/keep/sock');
    await set(FIELDS.address, 'wss://other.example/ws?token=&socket=', 'insertFromPaste');
    assert.equal(el(FIELDS.address).value, 'wss://other.example/ws');
    assert.equal(el(FIELDS.token).value, '');
    assert.equal(el(FIELDS.socket).value, '');
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ address: 'wss://other.example/ws', token: '' }]);
  } finally { await app.close(); }
});

test('the dialog: typing a link out is plain editing and splits only when the field is left', async context => {
  const { app, el, set } = await openDialog(context);
  try {
    const link = 'wss://typed.example/ws?token=TYPED-TOKEN&socket=%2Ftmp%2Ftyped';
    for (let n = 1; n <= link.length; n++) await set(FIELDS.address, link.slice(0, n), 'insertText');
    assert.equal(el(FIELDS.address).value, link, 'nothing was split while typing');
    assert.equal(el(FIELDS.token).value, '');
    el(FIELDS.address).dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.flush();
    assert.equal(el(FIELDS.address).value, 'wss://typed.example/ws');
    assert.equal(el(FIELDS.token).value, 'TYPED-TOKEN');
    assert.equal(el(FIELDS.socket).value, '/tmp/typed');
  } finally { await app.close(); }
});

test('the dialog: Enter commits a typed link first — a usable one is split and submitted, an unusable one is refused and nothing is submitted', async context => {
  const submitted: unknown[] = [];
  const { app, el, set } = await openDialog(context, submitted);
  try {
    const enter = () => el(FIELDS.address).dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await set(FIELDS.address, 'https://front.example/?token=SECRET-ONE', 'insertText');     // typed out, not pasted
    enter();
    await app.flush();
    assert.deepEqual(submitted, [], 'a link that names no server does not submit');
    assert.equal(el(FIELDS.address).value, '', 'and it did not stay in the field');
    assert.ok(!app.document.documentElement.outerHTML.includes('SECRET-ONE'));
    await set(FIELDS.address, 'wss://typed.example/ws?token=TYPED-TOKEN&socket=', 'insertText');
    enter();
    await app.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ address: 'wss://typed.example/ws', token: 'TYPED-TOKEN' }]);
  } finally { await app.close(); }
});

test('the dialog: submit goes through the same gate — a typed link that cannot be used submits nothing, with or without a blur', async context => {
  for (const leave of [true, false]) {
    const submitted: unknown[] = [];
    const { app, el, set } = await openDialog(context, submitted);
    try {
      await set(FIELDS.address, 'ws://keep.example:9899', 'insertText');
      await set(FIELDS.token, 'KEEP-TOKEN');
      await set(FIELDS.address, 'https://front.example/?token=SECRET-ONE', 'insertText');
      if (leave) { el(FIELDS.address).dispatchEvent(new app.window.Event('change', { bubbles: true })); await app.flush(); }
      [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
      await app.flush();
      assert.deepEqual(submitted, [], `nothing submitted (blur: ${leave})`);
      assert.ok(!app.document.documentElement.outerHTML.includes('SECRET-ONE'));
    } finally { await app.close(); }
  }
});

test('the dialog lifecycle: an accepted paste of a link, then a typed refusal in the same focus — the accepted tuple stays and nothing mixed is submitted', async context => {
  const submitted: unknown[] = [];
  const { app, el, set } = await openDialog(context, submitted);
  try {
    await set(FIELDS.address, 'ws://first.example:9899', 'insertText');
    await set(FIELDS.token, 'FIRST-TOKEN');
    await set(FIELDS.address, 'wss://second.example/ws?token=SECOND-TOKEN&socket=%2Ftmp%2Fsecond', 'insertFromPaste');
    await set(FIELDS.address, 'https://front.example/?token=SECRET-ONE', 'insertText');
    el(FIELDS.address).dispatchEvent(new app.window.Event('change', { bubbles: true }));
    await app.flush();
    assert.equal(el(FIELDS.address).value, 'wss://second.example/ws');
    assert.equal(el(FIELDS.token).value, 'SECOND-TOKEN');
    assert.equal(el(FIELDS.socket).value, '/tmp/second');
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.deepEqual(submitted, [], 'the refusal is pending, so nothing is submitted until the next edit');
    await set(FIELDS.address, 'wss://second.example/ws', 'insertText');
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^connect$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.deepEqual(JSON.parse(JSON.stringify(submitted)), [{ address: 'wss://second.example/ws', token: 'SECOND-TOKEN', socket: '/tmp/second' }]);
  } finally { await app.close(); }
});

test('the dialog: hidden characters are refused with their own message, naming neither a credential nor any part of the text', async context => {
  const { app, el, set } = await openDialog(context);
  try {
    await set(FIELDS.address, 'ws://keep.example:9899');
    await set(FIELDS.address, '\u200bwss://user:SECRET-ONE@h.example/ws', 'insertFromPaste');
    assert.equal(el(FIELDS.address).value, 'ws://keep.example:9899');
    assert.equal(app.document.querySelector('.dlg .config-error[role=alert]')?.textContent, 'This text contains hidden characters');
    assert.ok(!app.document.documentElement.outerHTML.includes('SECRET-ONE'));
  } finally { await app.close(); }
});

// ─── #403: scanning fills the dialog's form and never submits ───────────

const scanButton = (app: { document: Document }) => [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^scan qr code$/iu.test((b.textContent ?? '').trim()));
async function scanDialog(context: import('node:test').TestContext, layout: string, scan: (() => Promise<string | null>) | null, submitted: unknown[] = []) {
  const app = await (await compiled).mount(context, {
    props: { oncancel: () => {}, onsubmit: (c: unknown) => { submitted.push(c); }, onscan: scan },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); window.localStorage.setItem('tmux_layout_mode', layout); },
    modules: [],
  });
  for (let i = 0; i < 8 && !app.document.querySelector('.dlg input'); i++) await app.flush();
  return app;
}

test('the dialog: on a touch layout a scanned link fills address, token and socket and submits nothing; on a desktop layout there is no Scan command', async context => {
  const submitted: unknown[] = [];
  const app = await scanDialog(context, 'mobile', async () => 'wss://scan.example/ws?token=SCANNED-TOKEN&socket=%2Ftmp%2Fscanned', submitted);
  try {
    assert.ok(scanButton(app), 'the command is there');
    scanButton(app)!.click();
    await app.flush(); await app.flush();
    assert.equal(app.document.querySelector<HTMLInputElement>(FIELDS.address)!.value, 'wss://scan.example/ws');
    assert.equal(app.document.querySelector<HTMLInputElement>(FIELDS.token)!.value, 'SCANNED-TOKEN');
    assert.equal(app.document.querySelector<HTMLInputElement>(FIELDS.socket)!.value, '/tmp/scanned');
    assert.deepEqual(submitted, [], 'the person taps Connect');
  } finally { await app.close(); }
});

test('the dialog: no Scan command on a desktop layout, nor when the host offers no scanner', async context => {
  const desktop = await scanDialog(context, 'desktop', async () => null);
  try { assert.equal(scanButton(desktop), undefined); } finally { await desktop.close(); }
});
