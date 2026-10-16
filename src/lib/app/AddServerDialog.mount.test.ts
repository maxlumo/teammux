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
