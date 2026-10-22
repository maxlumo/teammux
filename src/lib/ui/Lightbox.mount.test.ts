import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

const compiled = compileMount(new URL('./Lightbox.svelte', import.meta.url), []);

// Board #447: the viewer's download control. The Lightbox is a generic atom: it offers the control
// only when its host hands a handler, and it is exactly what it was without one.

test('the download control exists only when the host hands a handler, beside close (#447)', async context => {
  const plain = await (await compiled).mount(context, { props: { src: 'data:image/png;base64,eA==' }, modules: [] });
  try {
    assert.equal(plain.document.querySelector('.lb-download'), null, 'no handler, no control');
    assert.ok(plain.document.querySelector('.lb-close'));
  } finally { await plain.close(); }
  let calls = 0;
  const app = await (await compiled).mount(context, { props: { src: 'data:image/png;base64,eA==', ondownload: () => { calls++; } }, modules: [] });
  try {
    const button = app.document.querySelector<HTMLButtonElement>('.lb-bar .lb-download')!;
    assert.ok(button, 'offered with a handler');
    assert.equal(button.type, 'button');
    assert.equal(button.getAttribute('aria-label'), 'Download');
    assert.equal(button.tabIndex, 0, 'a real button: Tab reaches it, Enter and Space activate it');
    assert.ok(button.nextElementSibling?.classList.contains('lb-close'), 'it sits beside the close control, in the same bar');
    button.click();
    assert.equal(calls, 1, 'one activation, one call');
  } finally { await app.close(); }
});

test('the control is hidden while a save for this open runs, and the status is the one OperationFeedback (#447)', async context => {
  const app = await (await compiled).mount(context, {
    props: { src: 'x', ondownload: () => {}, downloading: true, status: { kind: 'progress', glyph: 'download', message: 'Downloading', detail: '/srv/a.png', progress: 40 } },
    modules: [],
  });
  try {
    assert.equal(app.document.querySelector('.lb-download'), null, 'one tap, one attempt');
    assert.match(app.document.querySelector('.lb-status .operation-feedback')?.textContent ?? '', /Downloading/u);
    assert.ok(app.document.querySelector('.lb-close'), 'close is never hidden');
  } finally { await app.close(); }
});

test('only the image stage takes the pointer: pressing a bar control neither captures it nor starts a gesture (#447)', async context => {
  const app = await (await compiled).mount(context, { props: { src: 'x', ondownload: () => {} }, modules: [] });
  try {
    const win = app.window as any;
    const captured: Element[] = [];
    win.HTMLElement.prototype.setPointerCapture = function (this: Element) { captured.push(this); };
    const stage = app.document.querySelector('.lb-stage')!;
    const button = app.document.querySelector<HTMLButtonElement>('.lb-download')!;
    // jsdom has no PointerEvent: the handlers read pointerId and clientX/Y, which a MouseEvent can carry.
    const press = (el: Element) => {
      for (const type of ['pointerdown', 'pointerup']) {
        const e = new win.MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        el.dispatchEvent(e);
      }
    };
    press(button);
    assert.deepEqual(captured, [], 'the bar is outside the capture region: its release and click stay on it');
    press(app.document.querySelector('.lb-close')!);
    assert.deepEqual(captured, []);
    press(stage);
    assert.equal(captured.length, 1, 'the stage still captures its own gestures');
    assert.equal(captured[0], stage);
  } finally { await app.close(); }
});

test('the stage keeps the close gestures: backdrop tap closes while unzoomed, Escape closes, ✕ closes (#447 kept #188)', async context => {
  let closed = 0;
  const app = await (await compiled).mount(context, { props: { src: 'x', onclose: () => { closed++; } }, modules: [] });
  try {
    const win = app.window as any;
    app.window.HTMLElement.prototype.setPointerCapture = () => {};
    const stage = app.document.querySelector('.lb-stage')!;
    stage.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.equal(closed, 1, 'a clean tap on the backdrop');
    app.document.querySelector<HTMLButtonElement>('.lb-close')!.click();
    assert.equal(closed, 2, 'the close control');
    app.window.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(closed, 3, 'Escape');
  } finally { await app.close(); }
});
