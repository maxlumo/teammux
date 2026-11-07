import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeShellHeight, unpanShell, viewportKeyboard, webviewSizesForKeyboard } from './keyboard-fit.ts';

// Board #56, the owner's phone (2026-11-06): with the keyboard closed the
// composer was cut and the tab bar was below the screen; the shell height was
// a remembered maximum. With no keyboard up it is the CURRENT window height.
test('with no keyboard the shell is the current window height, never a remembered larger one', () => {
  assert.deepEqual(nativeShellHeight(0, 891, 780), { height: 780, fullHeight: 780 }, 'a taller height seen once is forgotten');
  assert.deepEqual(nativeShellHeight(0, 780, 891), { height: 891, fullHeight: 891 }, 'and a taller window is taken');
});

test('with the keyboard up the shell is the full height less the keyboard', () => {
  assert.deepEqual(nativeShellHeight(279, 780, 780), { height: 501, fullHeight: 780 });
  assert.deepEqual(nativeShellHeight(279, 780, 501), { height: 501, fullHeight: 780 }, 'a WebView that resized itself is not subtracted twice');
});

// Board #56, the keyboard-open screenshot: the WebView panned its visual
// viewport to show the focused composer, the shell then shrank by the keyboard
// height, and nothing undid the pan: the shell sat that far above the screen,
// with the same gap under the composer. Measured in Chromium (Docker, a panned
// visual viewport): window.scrollTo(0, 0) leaves offsetTop where it was;
// scrolling the shell's own box into view returns it to 0.
test('a panned visual viewport is returned to the shell top, and an unpanned one is left alone', () => {
  const calls: unknown[] = [];
  const shell = { scrollIntoView: (o: unknown) => calls.push(o) };
  assert.equal(unpanShell({ offsetTop: 225 }, shell), true);
  assert.deepEqual(calls, [{ block: 'start', inline: 'nearest' }]);
  assert.equal(unpanShell({ offsetTop: 0 }, shell), false, 'nothing to undo');
  assert.equal(unpanShell(null, shell), false, 'no visual viewport');
  assert.equal(unpanShell({ offsetTop: 225 }, null), false, 'no shell');
  assert.equal(calls.length, 1);
});

// Board #56 round 2 (orchestrator, Android's "Understand window insets in
// WebView", updated 2026-10-28): from M139 the WebView resizes the visual
// viewport for the keyboard itself, so the app sizing the shell from the native
// keyboard height as well handles the keyboard twice. One mechanism: such a
// WebView takes the browser's visualViewport path.
test('a WebView from M139 sizes for the keyboard itself; an older one, or an unknown one, does not', () => {
  const ua = (v: string) => `Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${v} Mobile Safari/537.36`;
  assert.equal(webviewSizesForKeyboard(ua('139.0.7258.94')), true);
  assert.equal(webviewSizesForKeyboard(ua('144.0.7559.20')), true);
  assert.equal(webviewSizesForKeyboard(ua('138.0.7204.179')), false);
  assert.equal(webviewSizesForKeyboard('Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36'), false, 'no Chrome version: the native path, as before');
});

// Board #56 round 3, validator-2's measurement (note 15, WebView 144): a window
// that shrank with the keyboard closed (844 -> 640) was read as keyboard-open
// against the remembered 844, which hid the tab bar. And its note 22: index.html
// declares interactive-widget=resizes-content, so a keyboard can shrink BOTH
// viewports (844 -> 544), which "visual shorter than the window" alone reads as
// closed. One rule for both: the keyboard can only be up while a text input is
// focused, and it is measured against the height the window had with nothing
// focused (and against the current window, for a WebView that only shrinks
// the visual viewport).
test('the keyboard is up only while an editable is focused, against the window and the resting height at the same width', () => {
  const rest = { height: 844, width: 390 };
  assert.deepEqual(viewportKeyboard(640, 640, 390, { height: 640, width: 390 }, false, 100), { open: false, kbHeight: 0 }, 'the window itself shrank, nothing focused');
  assert.deepEqual(viewportKeyboard(565, 844, 390, rest, true, 100), { open: true, kbHeight: 279 }, 'M139+: only the visual viewport shrank');
  assert.deepEqual(viewportKeyboard(544, 544, 390, rest, true, 100), { open: true, kbHeight: 300 }, 'resizes-content: both shrank (validator-2 note 22)');
  assert.deepEqual(viewportKeyboard(565, 844, 390, rest, false, 100), { open: false, kbHeight: 0 }, 'no focused editable: no keyboard');
  assert.deepEqual(viewportKeyboard(844, 844, 390, rest, true, 100), { open: false, kbHeight: 0 }, 'focused, nothing shrank (a hardware keyboard)');
  assert.deepEqual(viewportKeyboard(780, 844, 390, rest, true, 100), { open: false, kbHeight: 0 }, 'inside the threshold');
  assert.deepEqual(viewportKeyboard(390, 390, 844, rest, true, 100), { open: false, kbHeight: 0 }, 'rotated: a resting height of another width is not compared');
  assert.deepEqual(viewportKeyboard(150, 390, 844, rest, true, 100), { open: true, kbHeight: 240 }, 'rotated: the current window still counts');
  assert.deepEqual(viewportKeyboard(544, 544, 390, null, true, 100), { open: false, kbHeight: 0 }, 'no resting height yet: only the current window');
});
