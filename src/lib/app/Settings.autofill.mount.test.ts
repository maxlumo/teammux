import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compileMount } from '../test/mount.ts';
import { removeServer } from './servers.ts';
import { REJECTED_LINKS as REJECTED } from '../core/connection-link.fixtures.ts';

// Board #323 (reviewer P1): the desktop app fills this machine's gateway
// into Settings — and its token/socket NEVER end up next to another
// server's address. The real Settings, a desktop platform, and a
// get_local_config whose answer the test releases when it wants. The shell
// is the real platform detection (a `__TAURI__` global, desktop UA).
const compiled = compileMount(new URL('./Settings.svelte', import.meta.url), [
  new URL('../core/clipboard.ts', import.meta.url),
]);

const LOCAL = { url: 'ws://[::1]:19900', token: 'LOCAL-TOKEN', tmux_socket: '/local/sock', host: '::', port: 19900 };
const ADDR = 'input[placeholder="ws://host:port"]';
const TOKEN = 'input[placeholder="auth token"]';
const SOCKET = 'input[placeholder="/tmp/tmux-1000/default"]';

/** Saved servers (the registry is the only list the form suggests from, #400). */
const saved = (...servers: { address: string; token: string; socket?: string }[]) => ({
  tmux_servers: JSON.stringify(servers.map((s, i) => ({ id: `s${i}`, name: `s${i}`, address: s.address, token: s.token, ...(s.socket ? { socket: s.socket } : {}) }))),
});

async function mount(context: TestContext, saved: Record<string, string>, userAgent?: string, extraProps: Record<string, unknown> = {}) {
  const calls: string[] = [];
  let release!: (cfg: typeof LOCAL) => void;
  const answer = new Promise<typeof LOCAL>(yes => { release = yes; });
  const app = await (await compiled).mount(context, {
    props: { onConnected() {}, ...extraProps },
    modules: [
      { copyText: () => true },
    ],
    setup(window) {
      window.localStorage.setItem('tmux_locale', 'en');
      for (const [k, v] of Object.entries(saved)) window.localStorage.setItem(k, v);
      if (userAgent) Object.defineProperty(window.navigator, 'userAgent', { value: userAgent });
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
        core: { invoke: (cmd: string) => { calls.push(cmd); return cmd === 'get_local_config' ? answer : Promise.reject(new Error(cmd)); } },
      };
    },
  });
  const field = (sel: string) => app.document.querySelector<HTMLInputElement>(sel)!;
  return {
    ...app,
    calls,
    value: (sel: string) => field(sel).value,
    async edit(sel: string, value: string) {
      field(sel).value = value;
      field(sel).dispatchEvent(new app.window.Event('input', { bubbles: true }));
      await app.flush();
    },
    async pick(address: string) {
      app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
      await app.flush();
      const row = [...app.document.querySelectorAll<HTMLButtonElement>('.hist-item')].find(b => b.textContent === address);
      assert.ok(row, `the suggestions have ${address}`);
      row!.click();
      await app.flush();
    },
    async answer() {
      release(LOCAL);
      for (let i = 0; i < 6; i++) await app.flush();
    },
  };
}

test('a fresh desktop app is filled with this machine\'s gateway', async context => {
  const app = await mount(context, {});
  await app.answer();
  assert.equal(app.value(ADDR), LOCAL.url);
  assert.equal(app.value(TOKEN), LOCAL.token);
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket);
});

test('a saved remote address with no token gets no local token or socket', async context => {
  const app = await mount(context, { ...saved({ address: 'ws://remote.example:9899', token: '' }), tmux_server_current: 's0' });
  await app.answer();
  assert.equal(app.value(ADDR), 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), '');
  assert.equal(app.value(SOCKET), '');
});

test('a remote address typed while the config loads gets no local credentials', async context => {
  const app = await mount(context, {});
  await app.edit(ADDR, 'ws://remote.example:9899');
  await app.answer();
  assert.equal(app.value(ADDR), 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), '');
  assert.equal(app.value(SOCKET), '');
});

test('auto-filled local credentials do not follow the address to a remote; typed ones stay', async context => {
  const app = await mount(context, {});
  await app.answer();
  assert.equal(app.value(TOKEN), LOCAL.token);
  await app.edit(ADDR, 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), '', 'the local token is gone');
  assert.equal(app.value(SOCKET), '', 'the local socket is gone');
  await app.edit(TOKEN, 'REMOTE-TOKEN');
  await app.edit(ADDR, 'ws://other.example:9899');
  assert.equal(app.value(TOKEN), 'REMOTE-TOKEN', 'what the person typed is never cleared');
});

test('the Android app never fills a phone with its own loopback config', async context => {
  const app = await mount(context, {}, 'Mozilla/5.0 (Linux; Android 14) AppleWebKit');
  await app.answer();
  assert.deepEqual(app.calls, [], 'get_local_config is not even asked');
  assert.equal(app.value(TOKEN), '');
});

test('a pick keeps its own token, and the auto-filled local socket does not follow it', async context => {
  const app = await mount(context, saved(
    { address: 'ws://remote.example:9899', token: 'REMOTE-TOKEN' },
    { address: 'ws://other.example:9899', token: '' },
  ));
  await app.answer();
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket, 'filled for the local gateway');
  await app.pick('ws://remote.example:9899');
  assert.equal(app.value(ADDR), 'ws://remote.example:9899');
  assert.equal(app.value(TOKEN), 'REMOTE-TOKEN', "the entry's own token stays");
  assert.equal(app.value(SOCKET), '', 'the local socket does not ride along to the remote');
});

test('picking the local gateway from the suggestions keeps its socket', async context => {
  const app = await mount(context, saved(
    { address: 'ws://remote.example:9899', token: 'REMOTE-TOKEN' },
    { address: LOCAL.url, token: 'OLD-LOCAL-TOKEN' },
  ));
  await app.answer();
  await app.pick(LOCAL.url);
  assert.equal(app.value(TOKEN), 'OLD-LOCAL-TOKEN', "the entry's token is the person's choice");
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket, 'still the local gateway: its socket stays');
  await app.pick('ws://remote.example:9899');
  assert.equal(app.value(TOKEN), 'REMOTE-TOKEN');
  assert.equal(app.value(SOCKET), '', 'then a remote pick: the local socket still does not follow');
});

test('the suggestions are the saved servers, re-read each time the list opens, and a row has no forget button (#400)', async context => {
  const app = await mount(context, {
    ...saved(
      { address: 'ws://one.example:9899', token: 'ONE' },
      { address: 'ws://two.example:9899', token: 'TWO' },
      { address: 'ws://three.example:9899', token: 'THREE' },
    ),
    tmux_server_current: 's0',
    // Left over from before the registry was the only list: not offered.
    tmux_address_history: JSON.stringify([{ address: 'ws://stale.example:9899', token: 'STALE' }]),
  });
  const rows = async () => {
    app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
    await app.flush();
    const out = [...app.document.querySelectorAll('.hist-item')].map(b => b.textContent);
    const forget = app.document.querySelector('.hist-del');
    app.document.querySelector<HTMLButtonElement>('.hist-btn')!.click();
    await app.flush();
    assert.equal(forget, null, 'forgetting is Settings › Connection\u2019s, not the form\u2019s');
    return out;
  };
  assert.deepEqual(await rows(), ['ws://one.example:9899', 'ws://two.example:9899', 'ws://three.example:9899']);
  // Another page deletes a server while this form stays mounted.
  removeServer(app.window.localStorage, 's1');
  assert.deepEqual(await rows(), ['ws://one.example:9899', 'ws://three.example:9899']);
});

test('the form opens on CURRENT\u2019s saved tuple, never on a mirror the registry does not hold (#400)', async context => {
  const app = await mount(context, {
    ...saved({ address: 'ws://a.example:9899', token: 'TOKEN-A', socket: '/tmp/sock-a' }, { address: 'ws://b.example:9899', token: 'TOKEN-B', socket: '/tmp/sock-b' }),
    tmux_server_current: 's0',
    // An unfinished attempt, and a server deleted on an older build.
    tmux_address: 'ws://deleted.example:9899', tmux_token: 'TOKEN-DELETED', tmux_socket: '/tmp/sock-deleted',
  });
  await app.answer();
  assert.equal(app.value(ADDR), 'ws://a.example:9899');
  assert.equal(app.value(TOKEN), 'TOKEN-A');
  assert.equal(app.value(SOCKET), '/tmp/sock-a');
  assert.ok(!app.document.body.innerHTML.includes('deleted.example'), 'the deleted address is nowhere on the page');
});

test('one saved server with one address still has its suggestion list, and a pick brings its tuple back (#400 review P2-C)', async context => {
  const app = await mount(context, { ...saved({ address: 'ws://only.example:9899', token: 'ONLY' }), tmux_server_current: 's0' });
  await app.answer();
  await app.edit(ADDR, 'ws://typed.example:9899');                  // the person moved off it
  assert.ok(app.document.querySelector('.hist-btn'), 'the list opens with a single row');
  await app.pick('ws://only.example:9899');
  assert.equal(app.value(ADDR), 'ws://only.example:9899');
  assert.equal(app.value(TOKEN), 'ONLY');
});

test('picking the local gateway when its saved entry has a socket applies that socket, not the auto-filled one (#400 review P1-D)', async context => {
  const app = await mount(context, saved(
    { address: 'ws://remote.example:9899', token: 'REMOTE-TOKEN', socket: '/remote/sock' },
    { address: LOCAL.url, token: 'SAVED-LOCAL-TOKEN', socket: '/saved/local/sock' },
  ));
  await app.answer();
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket, 'the desktop autofill put the config socket in');
  await app.pick(LOCAL.url);
  assert.equal(app.value(TOKEN), 'SAVED-LOCAL-TOKEN');
  assert.equal(app.value(SOCKET), '/saved/local/sock', 'the saved entry\u2019s own socket wins');
  await app.pick('ws://remote.example:9899');
  assert.equal(app.value(SOCKET), '/remote/sock', 'and a remote pick takes the remote\u2019s, never the previous one\u2019s');
});

test('a socket the person typed does not survive picking a saved server that has none; only the untouched auto-filled local one does (#400 review P1-D)', async context => {
  const app = await mount(context, saved(
    { address: 'ws://remote.example:9899', token: 'REMOTE-TOKEN' },
    { address: LOCAL.url, token: 'OLD-LOCAL-TOKEN' },
  ));
  await app.answer();
  await app.edit(SOCKET, '/typed/sock');
  await app.pick(LOCAL.url);
  assert.equal(app.value(SOCKET), '', 'the entry has no socket, and the typed one belongs to nobody saved');
});

// ─── #401: a connection link fills the fields it names ───────────────────

const NEW_LINK = 'wss://paste.example/ws?token=PASTED-TOKEN&socket=%2Ftmp%2Fpasted';
const OLD_LINK = 'https://some-front-end.example/app/?addr=wss%3A%2F%2Fpaste.example%2Fws&token=PASTED-TOKEN&socket=%2Ftmp%2Fpasted';
const OLD_HASH_LINK = 'https://some-front-end.example/#/files?address=wss://paste.example/ws&token=PASTED-TOKEN&socket=/tmp/pasted';

type Mounted = Awaited<ReturnType<typeof mount>>;
/** A whole text arriving at once, the way a browser reports a paste. */
async function paste(app: Mounted, selector: string, text: string) {
  const el = app.document.querySelector<HTMLInputElement>(selector)!;
  el.value = text;
  const event = new app.window.Event('input', { bubbles: true });
  Object.defineProperty(event, 'inputType', { value: 'insertFromPaste' });
  el.dispatchEvent(event);
  await app.flush();
}
/** The person types `text` one character at a time, then leaves the field. */
async function typeOut(app: Mounted, selector: string, text: string, { commit = true } = {}) {
  const el = app.document.querySelector<HTMLInputElement>(selector)!;
  el.dispatchEvent(new app.window.Event('focus'));
  el.value = '';
  for (const char of text) {
    el.value += char;
    const event = new app.window.Event('input', { bubbles: true });
    Object.defineProperty(event, 'inputType', { value: 'insertText' });
    Object.defineProperty(event, 'data', { value: char });
    el.dispatchEvent(event);
  }
  await app.flush();
  if (commit) { el.dispatchEvent(new app.window.Event('change', { bubbles: true })); await app.flush(); }
}

for (const [form, link] of [['the new form', NEW_LINK], ['the old front-end form', OLD_LINK], ['the old front-end hash form', OLD_HASH_LINK]]) {
  test(`pasting a connection link in ${form} into the address field fills address, token and socket, and the field keeps only the address`, async context => {
    const app = await mount(context, {});
    await app.answer();
    await paste(app, ADDR, link!);
    assert.equal(app.value(ADDR), 'wss://paste.example/ws', 'the field shows the address alone');
    assert.equal(app.value(TOKEN), 'PASTED-TOKEN');
    assert.equal(app.value(SOCKET), '/tmp/pasted');
    assert.equal(app.document.querySelector(TOKEN)!.getAttribute('type'), 'password', 'and the token stays masked');
    assert.ok(!app.document.body.textContent!.includes('PASTED-TOKEN'), 'the token is not on the page as text');
  });
}

test('a pasted link without a socket clears the previous one; a bare address pasted is left exactly as typed', async context => {
  const app = await mount(context, {});
  await app.answer();
  assert.equal(app.value(SOCKET), LOCAL.tmux_socket, 'the desktop autofill put the local socket in');
  await paste(app, ADDR, 'wss://paste.example/ws?token=PASTED-TOKEN');
  assert.equal(app.value(TOKEN), 'PASTED-TOKEN');
  assert.equal(app.value(SOCKET), '', 'the local socket does not follow a link to another server');
  await paste(app, ADDR, 'ws://bare.example:9899');
  assert.equal(app.value(ADDR), 'ws://bare.example:9899');
  assert.equal(app.value(TOKEN), 'PASTED-TOKEN', 'a bare address carries no credentials, so none are touched');
});

test('the Android app takes the same paste (it runs the same form)', async context => {
  const app = await mount(context, {}, 'Mozilla/5.0 (Linux; Android 14) AppleWebKit');
  await paste(app, ADDR, NEW_LINK);
  assert.equal(app.value(ADDR), 'wss://paste.example/ws');
  assert.equal(app.value(TOKEN), 'PASTED-TOKEN');
  assert.equal(app.value(SOCKET), '/tmp/pasted');
});

test('a link for the address already in the field still rewrites the field to the address alone (the token is never left in view)', async context => {
  const app = await mount(context, {});
  await app.answer();
  await app.edit(ADDR, 'wss://paste.example/ws');                       // the state now holds exactly this address
  await paste(app, ADDR, NEW_LINK);                                     // and a link for the same address arrives
  assert.equal(app.value(ADDR), 'wss://paste.example/ws');
  assert.equal(app.value(TOKEN), 'PASTED-TOKEN');
});

// A built link is always a link, even with nothing to carry: pasted over a form
// that holds ANOTHER server's token and socket it must clear them, not keep them.
const HELD = saved({ address: 'ws://keep.example:9899', token: 'KEEP-TOKEN', socket: '/keep/sock' });
for (const [what, link, want] of [
  ['both empty', 'wss://paste.example/ws?token=&socket=', { token: '', socket: '' }],
  ['an empty token', 'wss://paste.example/ws?token=&socket=%2Fonly-socket', { token: '', socket: '/only-socket' }],
  ['an empty socket', 'wss://paste.example/ws?token=ONLY-TOKEN&socket=', { token: 'ONLY-TOKEN', socket: '' }],
  ['an old link with an empty token', 'https://front.example/?addr=wss://paste.example/ws&token=', { token: '', socket: '' }],
  ['no socket parameter at all', 'wss://paste.example/ws?token=ONLY-TOKEN', { token: 'ONLY-TOKEN', socket: '' }],
] as const) {
  test(`a pasted link with ${what} applies exactly its tuple over a form holding another server's credentials`, async context => {
    const app = await mount(context, { ...HELD, tmux_server_current: 's0' });
    await app.answer();
    assert.equal(app.value(TOKEN), 'KEEP-TOKEN', 'the form opened on the held tuple');
    await paste(app, ADDR, link);
    assert.equal(app.value(ADDR), 'wss://paste.example/ws');
    assert.equal(app.value(TOKEN), want.token, 'the previous server\u2019s token did not stay');
    assert.equal(app.value(SOCKET), want.socket, 'nor its socket');
  });
}

// What is recognised as carrying a credential but cannot be used is NEVER left
// in the visible field: the field goes back, the other fields stay, and one
// message that names no part of the text says why.
for (const [what, text] of REJECTED) {
  test(`pasting ${what} restores the field, leaves the other fields alone, and shows no part of it`, async context => {
    const app = await mount(context, { ...HELD, tmux_server_current: 's0' });
    await app.answer();
    await paste(app, ADDR, text);
    const address = app.document.querySelector<HTMLInputElement>(ADDR)!;
    assert.equal(address.value, 'ws://keep.example:9899', 'the address element went back to its previous value');
    assert.equal(app.value(TOKEN), 'KEEP-TOKEN');
    assert.equal(app.value(SOCKET), '/keep/sock');
    const message = app.document.querySelector('.fields .config-error[role=alert]');
    assert.match(message?.textContent ?? '', /^(?:This link(?:'s address contains a credential| has no server address| cannot be read: a token or socket appears twice)|This text contains hidden characters)$/u, 'one message about the problem');
    for (const secret of ['SECRET-ONE', 'SECRET-TWO', 'secret-socket', 'OUTER-TOKEN']) {
      assert.ok(!(message?.textContent ?? '').includes(secret), `the message does not carry ${secret}`);
      assert.ok(!app.document.documentElement.outerHTML.includes(secret), `and ${secret} is nowhere in the page`);
      assert.ok(![...app.document.querySelectorAll('input')].some(i => i.value.includes(secret)), `or in any field`);
    }
  });
}

test('hidden characters are refused with their own message, which names neither a credential nor any part of the text', async context => {
  const app = await mount(context, { ...HELD, tmux_server_current: 's0' });
  await app.answer();
  await paste(app, ADDR, '\u200bwss://user:SECRET-ONE@h.example/ws');
  assert.equal(app.value(ADDR), 'ws://keep.example:9899');
  assert.equal(app.document.querySelector('.fields .config-error[role=alert]')?.textContent, 'This text contains hidden characters');
  assert.ok(!app.document.documentElement.outerHTML.includes('SECRET-ONE'));
});

test('typing a link out is plain editing: it is not split character by character, only when the field is left', async context => {
  const app = await mount(context, {});
  await app.answer();
  await typeOut(app, ADDR, NEW_LINK, { commit: false });
  assert.equal(app.value(ADDR), NEW_LINK, 'every typed character stayed in the address field');
  assert.notEqual(app.value(TOKEN), 'P', 'the first character of the token did not start a split');
  assert.notEqual(app.value(TOKEN), 'PASTED-TOKEN', 'and nothing was taken yet');
  app.document.querySelector(ADDR)!.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  await app.flush();
  assert.equal(app.value(ADDR), 'wss://paste.example/ws', 'leaving the field splits the finished link');
  assert.equal(app.value(TOKEN), 'PASTED-TOKEN');
  assert.equal(app.value(SOCKET), '/tmp/pasted');
});

test('a typed link that cannot be used is taken out of the field when it is left, back to what the field held', async context => {
  const app = await mount(context, { ...HELD, tmux_server_current: 's0' });
  await app.answer();
  await typeOut(app, ADDR, 'https://front.example/?token=SECRET-ONE');
  assert.equal(app.value(ADDR), 'ws://keep.example:9899');
  assert.equal(app.value(TOKEN), 'KEEP-TOKEN');
  assert.match(app.document.querySelector('.fields .config-error[role=alert]')?.textContent ?? '', /no server address/u);
  assert.ok(!app.document.documentElement.outerHTML.includes('SECRET-ONE'));
  await typeOut(app, ADDR, 'ws://other.example:9899');
  assert.equal(app.document.querySelector('.fields .config-error'), null, 'the next edit clears the message');
});

// Each refusal says what is actually wrong (a validator P3 on #401): a credential
// inside the decoded address is not "a token or socket appears twice".
for (const [what, text, message] of [
  ['a credential inside the decoded addr', 'https://front.example/?addr=wss%3A%2F%2Fh%2Fws%23token%3DSECRET-ONE&token=OUTER-TOKEN', "This link's address contains a credential"],
  ['a repeated token', 'wss://other.example/ws?token=SECRET-ONE&token=SECRET-TWO', 'This link cannot be read: a token or socket appears twice'],
  ['user info', 'wss://user:SECRET-ONE@h.example/ws', "This link's address contains a credential"],
  ['user info behind extra slashes', 'wss:////user:SECRET-ONE@h.example/ws', "This link's address contains a credential"],
  ['user info behind a zero-width space', '\u200bwss://user:SECRET-ONE@h.example/ws', 'This text contains hidden characters'],
  ['a clean address behind a delete character', '\u007fwss://h.example/ws', 'This text contains hidden characters'],
  ['an endpoint with user info and a password', 'wss://user:SECRET-ONE@h.example/ws', "This link's address contains a credential"],
  ['an http address in an old link', 'https://front.example/?addr=http%3A%2F%2Fh%3A1&token=SECRET-ONE', 'This link has no server address'],
  ['a token-only old link', 'https://front.example/?token=SECRET-ONE', 'This link has no server address'],
] as const) {
  test(`the refusal for ${what} says what is wrong`, async context => {
    const app = await mount(context, { ...HELD, tmux_server_current: 's0' });
    await app.answer();
    await paste(app, ADDR, text);
    assert.equal(app.document.querySelector('.fields .config-error[role=alert]')?.textContent, message);
  });
}

// ─── #403: scanning a connection QR code fills the form, never connects ──

const MOBILE = { tmux_layout_mode: 'mobile' };
const SCAN = 'button[aria-label="Scan QR code"], .command-button';
const scanButton = (app: Mounted) => [...app.document.querySelectorAll<HTMLButtonElement>('button')].find(b => /^scan qr code$/iu.test((b.textContent ?? '').trim()));
const scanning = (text: string | null) => ({ onScan: async () => text });

test('the Scan command is a phone command: absent on a desktop layout, absent when the host offers no scanner, present on touch', async context => {
  const desktop = await mount(context, { tmux_layout_mode: 'desktop' }, undefined, scanning(null));
  assert.equal(scanButton(desktop), undefined, 'a desktop layout offers no scan');
});

test('a touch layout with no scanner offered shows no Scan command', async context => {
  const app = await mount(context, { ...MOBILE });
  assert.equal(scanButton(app), undefined);
});

test('on a touch layout the Scan command is there, and a scan of a connection link fills address, token and socket without connecting', async context => {
  const connected: unknown[] = [];
  const app = await mount(context, { ...MOBILE }, undefined, { ...scanning('wss://scan.example/ws?token=SCANNED-TOKEN&socket=%2Ftmp%2Fscanned'), onConnected: (...a: unknown[]) => connected.push(a) });
  await app.answer();
  assert.ok(scanButton(app), 'the command is there');
  scanButton(app)!.click();
  await app.flush(); await app.flush();
  assert.equal(app.value(ADDR), 'wss://scan.example/ws');
  assert.equal(app.value(TOKEN), 'SCANNED-TOKEN');
  assert.equal(app.value(SOCKET), '/tmp/scanned');
  assert.equal(app.document.querySelector(TOKEN)!.getAttribute('type'), 'password', 'the token stays masked');
  assert.ok(!app.document.documentElement.outerHTML.includes('SCANNED-TOKEN'), 'and is nowhere in the page');
  assert.equal(app.document.querySelector('.fields .config-error'), null);
  assert.deepEqual(connected, [], 'nothing was connected: the person taps Connect');
});

for (const [what, text, address, token] of [
  ['a bare gateway address fills the address alone and clears the previous credentials', 'wss://bare.example/ws', 'wss://bare.example/ws', ''],
  ['an old front-end link is read like a pasted one', 'https://front.example/?addr=wss%3A%2F%2Fold.example%2Fws&token=OLD-TOKEN', 'wss://old.example/ws', 'OLD-TOKEN'],
] as const) {
  test(`a scan: ${what}`, async context => {
    const app = await mount(context, { ...HELD, ...MOBILE, tmux_server_current: 's0' }, undefined, scanning(text));
    await app.answer();
    scanButton(app)!.click();
    await app.flush(); await app.flush();
    assert.equal(app.value(ADDR), address);
    assert.equal(app.value(TOKEN), token);
    assert.equal(app.value(SOCKET), '', 'the previous server\u2019s socket did not follow');
  });
}

for (const [what, text] of [
  ['text that is not a connection', 'hello, this is a poster for a concert'],
  ['a url that is not a gateway', 'https://example.com/tickets?id=7'],
  ['an old token-only link', 'https://front.example/?token=SECRET-ONE'],
  ['a link whose addr hides a credential', 'https://front.example/?addr=wss%3A%2F%2Fh%2Fws%23token%3DSECRET-ONE&token=OUTER-TOKEN'],
] as const) {
  test(`a scan of ${what} is refused: the form is as it was, one message, no part of the code is shown`, async context => {
    const app = await mount(context, { ...HELD, ...MOBILE, tmux_server_current: 's0' }, undefined, scanning(text));
    await app.answer();
    scanButton(app)!.click();
    await app.flush(); await app.flush();
    assert.equal(app.value(ADDR), 'ws://keep.example:9899');
    assert.equal(app.value(TOKEN), 'KEEP-TOKEN');
    assert.equal(app.value(SOCKET), '/keep/sock');
    const message = app.document.querySelector('.fields .config-error[role=alert]')?.textContent ?? '';
    assert.match(message, /^This (?:is not a connection code|link(?: has no server address|.s address contains (?:a credential|a token or socket)| cannot be read.*))$/u);
    const html = app.document.documentElement.outerHTML;
    for (const secret of ['SECRET-ONE', 'OUTER-TOKEN', 'concert', 'tickets']) assert.ok(!html.includes(secret), `${secret} is nowhere in the page`);
  });
}

for (const [what, text, message] of [
  ['an old token-only link', 'https://front.example/?token=SECRET-ONE', 'This link has no server address'],
  ['a repeated token', 'wss://other.example/ws?token=SECRET-ONE&token=SECRET-TWO', 'This link cannot be read: a token or socket appears twice'],
] as const) {
  test(`a scan of ${what} is refused with the link's own reason, not the generic one`, async context => {
    const app = await mount(context, { ...HELD, ...MOBILE, tmux_server_current: 's0' }, undefined, scanning(text));
    await app.answer();
    scanButton(app)!.click();
    await app.flush(); await app.flush();
    assert.equal(app.document.querySelector('.fields .config-error[role=alert]')?.textContent, message);
  });
}

test('a refusal is cleared by the next scan, and the next scan fills the form', async context => {
  const texts = ['hello, this is a poster', 'wss://good.example/ws?token=GOOD-TOKEN&socket='];
  const app = await mount(context, { ...HELD, ...MOBILE, tmux_server_current: 's0' }, undefined, { onScan: async () => texts.shift() ?? null });
  await app.answer();
  scanButton(app)!.click();
  await app.flush(); await app.flush();
  assert.equal(app.document.querySelector('.fields .config-error[role=alert]')?.textContent, 'This is not a connection code');
  scanButton(app)!.click();
  await app.flush(); await app.flush();
  assert.equal(app.document.querySelector('.fields .config-error'), null, 'the old message is gone');
  assert.equal(app.value(ADDR), 'wss://good.example/ws');
  assert.equal(app.value(TOKEN), 'GOOD-TOKEN');
});

test('a cancelled scan changes nothing', async context => {
  const app = await mount(context, { ...HELD, ...MOBILE, tmux_server_current: 's0' }, undefined, scanning(null));
  await app.answer();
  scanButton(app)!.click();
  await app.flush(); await app.flush();
  assert.equal(app.value(ADDR), 'ws://keep.example:9899');
  assert.equal(app.document.querySelector('.fields .config-error'), null);
});
