import test from 'node:test';
import type { TestContext } from 'node:test';
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

// Board #449: a tap closes the viewer only if its GESTURE qualified: it began as the only finger on an
// unzoomed picture and nothing in it changed the zoom. The click that follows pointerup is judged by that
// record, never by the scale it finds. Every case sends the whole sequence (pointerdown, pointerup, click),
// as a browser does; a bare click proves nothing about a gesture.
type Mounted = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;
function gestures(app: Mounted) {
  const win = app.window as any;
  win.HTMLElement.prototype.setPointerCapture = () => {};
  // The viewer times a double-tap by performance.now() (300 ms), and jsdom's clock starts at 0 with the
  // window, which would make the very first tap look like a second one: the test owns the clock.
  let clock = 10_000;
  win.performance.now = () => clock;
  const stage = app.document.querySelector('.lb-stage')!;
  const pointer = (type: string, id: number, x = 100, y = 100) => {
    const e = new win.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: id });
    stage.dispatchEvent(e);
  };
  const click = () => stage.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  /** A finger (or the mouse) down and up on the picture, then the click the browser sends after. */
  const tap = (opts: { click?: boolean; id?: number; after?: number } = {}) => {
    clock += opts.after ?? 1000;                        // a new gesture by default; 100 makes it the second tap of a double-tap
    pointer('pointerdown', opts.id ?? 1); pointer('pointerup', opts.id ?? 1);
    if (opts.click !== false) click();
  };
  const wheelIn = () => stage.dispatchEvent(new win.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 100, clientY: 100, deltaY: -120 }));
  const scale = async () => { await app.flush(); return Number(/scale\(([\d.]+)\)/u.exec(app.document.querySelector<HTMLElement>('.lb-img')!.style.transform)?.[1] ?? NaN); };
  const wait = (ms: number) => { clock += ms; };
  return { pointer, click, tap, wheelIn, scale, wait };
}
async function viewer(context: TestContext) {
  let closed = 0;
  const app = await (await compiled).mount(context, { props: { src: 'x', onclose: () => { closed++; } }, modules: [] });
  return { app, g: gestures(app), closed: () => closed };
}

test('an unzoomed tap closes; Escape and the close control still do (#449 keeps #188)', async context => {
  const { app, g, closed } = await viewer(context);
  try {
    g.tap();
    assert.equal(closed(), 1, 'a clean tap on an unzoomed picture');
    app.document.querySelector<HTMLButtonElement>('.lb-close')!.click();
    assert.equal(closed(), 2, 'the close control');
    app.window.dispatchEvent(new (app.window as any).KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(closed(), 3, 'Escape');
  } finally { await app.close(); }
});

test('a double-tap that zooms back OUT does not close: its click finds scale 1 but its gesture started zoomed (#449)', async context => {
  const { app, g, closed } = await viewer(context);
  try {
    g.wheelIn();
    assert.ok(await g.scale() > 1, 'zoomed in');
    g.tap(); g.tap({ after: 100 });                     // two taps inside the double-tap window
    assert.equal(await g.scale(), 1, 'the second tap zoomed back out');
    assert.equal(closed(), 0, 'and neither click closed the viewer');
    g.tap();                                            // a NEW gesture, now unzoomed
    assert.equal(closed(), 1, 'the next tap is a fresh gesture and closes: the viewer is not stuck open');
  } finally { await app.close(); }
});

test('a zoomed tap, and a zoomed tap that moved, do not close (#449)', async context => {
  const { app, g, closed } = await viewer(context);
  try {
    g.wheelIn();
    g.tap();
    assert.equal(closed(), 0);
    g.pointer('pointerdown', 1); g.pointer('pointermove', 1, 140, 100); g.pointer('pointerup', 1, 140, 100); g.click();
    assert.equal(closed(), 0, 'a pan that ends in a click');
  } finally { await app.close(); }
});

test('a tap whose own gesture zooms IN does not close on its click (#449)', async context => {
  const { app, g, closed } = await viewer(context);
  try {
    g.tap({ click: false });                            // the first tap of a double-tap (its click did not close here)
    g.tap({ after: 100 });                              // the second: zooms in at pointerup, then its click arrives
    assert.ok(await g.scale() > 1, 'the second tap zoomed in');
    assert.equal(closed(), 0, 'a gesture that changed the zoom is not a close');
  } finally { await app.close(); }
});

test('a wheel step while the button is held makes the release no close (#449)', async context => {
  const { app, g, closed } = await viewer(context);
  try {
    g.pointer('pointerdown', 1);
    g.wheelIn();                                        // any real zoom path disqualifies, not only the double-tap
    g.pointer('pointerup', 1); g.click();
    assert.equal(closed(), 0);
  } finally { await app.close(); }
});

test('a second finger, and a cancelled gesture, are not taps; the next single press qualifies afresh (#449)', async context => {
  const { app, g, closed } = await viewer(context);
  try {
    g.wait(1000);
    g.pointer('pointerdown', 1); g.pointer('pointerdown', 2); g.pointer('pointerup', 2); g.pointer('pointerup', 1); g.click();
    assert.equal(closed(), 0, 'two fingers that never moved are not a tap');
    g.wait(1000);
    g.pointer('pointerdown', 1); g.pointer('pointercancel', 1); g.click();
    assert.equal(closed(), 0, 'a cancelled gesture is not a tap');
    g.tap({ after: 100 });                              // right after the cancel: not the second half of a double-tap
    assert.equal(closed(), 1, 'and old state never makes the viewer unclosable, nor does a cancel pair with the next tap');
  } finally { await app.close(); }
});
