import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeShellHeight, unpanShell } from './keyboard-fit.ts';

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
