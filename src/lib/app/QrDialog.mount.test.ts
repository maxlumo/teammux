// The connection QR dialog (board #403) in the app's modal shell: it draws the
// modules it is given, names the code without naming the link, and closes by
// Hide or Escape. It is never handed the link.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import { qrMatrix, qrPath } from '../core/qr.ts';

const compiled = compileMount(new URL('./QrDialog.svelte', import.meta.url), []);
const MATRIX = qrMatrix('ws://h:9899?token=FAKE-TOKEN&socket=');

async function open(context: import('node:test').TestContext, oncancel: () => void) {
  const app = await (await compiled).mount(context, {
    props: { matrix: MATRIX, oncancel },
    setup(window) { window.localStorage.setItem('tmux_locale', 'en'); },
    modules: [],
  });
  for (let i = 0; i < 8 && !app.document.querySelector('.dlg svg'); i++) await app.flush();
  return app;
}

test('the dialog draws exactly the modules it is given, in the paper and ink tokens, and names the code without naming the link', async context => {
  const app = await open(context, () => {});
  try {
    const svg = app.document.querySelector('.dlg svg.qr')!;
    assert.equal(svg.getAttribute('role'), 'img');
    assert.equal(svg.getAttribute('aria-label'), 'Connection QR code');
    assert.equal(svg.getAttribute('viewBox'), `0 0 ${MATRIX.length + 8} ${MATRIX.length + 8}`, 'the 4-module quiet zone is inside the paper');
    assert.equal(svg.querySelector('path.ink')!.getAttribute('d'), qrPath(MATRIX));
    assert.ok(svg.querySelector('rect.paper'));
    const text = app.document.querySelector('.dlg')!.textContent ?? '';
    assert.match(text, /Anyone who scans this code can connect to this server/u);
    assert.ok(!/FAKE-TOKEN|h:9899/u.test(app.document.documentElement.outerHTML), 'neither the token nor the address is anywhere in the page');
  } finally { await app.close(); }
});

test('Hide and Escape both close it', async context => {
  let cancelled = 0;
  const app = await open(context, () => { cancelled++; });
  try {
    [...app.document.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => /^hide$/iu.test((b.textContent ?? '').trim()))!.click();
    await app.flush();
    assert.equal(cancelled, 1, 'Hide');
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await app.flush();
    assert.equal(cancelled, 2, 'Escape');
  } finally { await app.close(); }
});
