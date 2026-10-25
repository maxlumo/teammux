import test from 'node:test';
import assert from 'node:assert/strict';
import { androidFullscreen, canFullscreen, canPip, clampTo, errorKind, fmtTime, Intents, seekWindow, third } from './media-player.ts';

// Board #453: the player's rules.

test('time reads m:ss, or h:mm:ss once the film reaches an hour; nothing known reads --:--', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(83.9), '1:23');
  assert.equal(fmtTime(83, 2700), '1:23');
  assert.equal(fmtTime(83, 3600), '0:01:23');
  assert.equal(fmtTime(3725), '1:02:05');
  for (const n of [NaN, Infinity, -1]) assert.equal(fmtTime(n), '--:--');
});

test('the seek window comes from the duration or seekable, never buffered (#453 P1-A)', () => {
  assert.deepEqual(seekWindow(120, []), { lo: 0, hi: 120 });
  assert.deepEqual(seekWindow(120, [{ start: 0, end: 120 }]), { lo: 0, hi: 120 });
  assert.equal(seekWindow(NaN, []), null, 'before metadata');
  assert.equal(seekWindow(0, []), null);
  assert.equal(seekWindow(Infinity, []), null, 'unknown length, nothing seekable');
  assert.deepEqual(seekWindow(Infinity, [{ start: 0, end: 30 }]), { lo: 0, hi: 30 }, 'unknown length: seekable ends it');
  const w = seekWindow(600, [{ start: 0, end: 600 }])!;
  assert.equal(clampTo(450, w), 450, 'a seek past what is buffered is allowed');
  assert.equal(clampTo(-3, w), 0);
  assert.equal(clampTo(9000, w), 600);
});

test('a seek into a hole between seekable ranges lands at the nearest seekable point (#453 review P2)', () => {
  const two = [{ start: 0, end: 100 }, { start: 300, end: 600 }];
  const w = seekWindow(600, two)!;
  assert.equal(clampTo(50, w, two), 50, 'inside a range: as asked');
  assert.equal(clampTo(450, w, two), 450);
  assert.equal(clampTo(150, w, two), 100, 'closer to the first range\'s end');
  assert.equal(clampTo(260, w, two), 300, 'closer to the second range\'s start');
  assert.equal(clampTo(200, w, two), 300, 'a tie goes forward');
  assert.equal(clampTo(9000, w, two), 600);
  assert.equal(clampTo(150, w), 150, 'no ranges known: the window alone');
});

test('a tap lands in a third; errors split into unplayable and transient', () => {
  assert.equal(third(10, 300), 'left');
  assert.equal(third(150, 300), 'middle');
  assert.equal(third(290, 300), 'right');
  assert.equal(third(10, 0), 'middle');
  assert.equal(errorKind(4), 'unplayable');
  assert.equal(errorKind(3), 'unplayable');
  assert.equal(errorKind(2), 'transient');
  assert.equal(errorKind(1), 'transient');
  assert.equal(errorKind(undefined), 'transient');
});

test('fullscreen needs the host and the API; picture-in-picture the API alone (#453 P2)', () => {
  const ok = { requestFullscreen: () => {} };
  const web = { android: false, androidFullscreen: false };
  assert.equal(canFullscreen(web, { fullscreenEnabled: true }, ok), true, 'a browser, and the macOS app (macOSPrivateApi, #454): the API decides');
  assert.equal(canFullscreen({ android: true, androidFullscreen: false }, { fullscreenEnabled: true }, ok), false, 'the Android app without its custom-view host (#454): WebView reports the API anyway');
  assert.equal(canFullscreen({ android: true, androidFullscreen: true }, { fullscreenEnabled: true }, ok), true, 'the Android app with the host installed (#454)');
  assert.equal(canFullscreen({ android: true, androidFullscreen: true }, { fullscreenEnabled: false }, ok), false);
  assert.equal(androidFullscreen({}), false, 'no interface: no fullscreen');
  assert.equal(androidFullscreen({ AndroidFullscreen: { available: () => false } }), false, 'not installed yet, or the install check failed');
  assert.equal(androidFullscreen({ AndroidFullscreen: { available: () => true } }), true);
  assert.equal(androidFullscreen({ AndroidFullscreen: { available: () => { throw new Error('bridge'); } } }), false, 'a bridge error is a no');
  assert.equal(androidFullscreen({ AndroidFullscreen: { available: () => 'true' } }), false, 'only a real true');
  assert.equal(canFullscreen(web, { fullscreenEnabled: false }, ok), false);
  assert.equal(canFullscreen(web, { fullscreenEnabled: true }, {}), false);
  const v = { requestPictureInPicture: () => {}, disablePictureInPicture: false };
  assert.equal(canPip({ pictureInPictureEnabled: true }, v), true);
  assert.equal(canPip({ pictureInPictureEnabled: false }, v), false);
  assert.equal(canPip({ pictureInPictureEnabled: true }, { ...v, disablePictureInPicture: true }), false);
  assert.equal(canPip({ pictureInPictureEnabled: true }, {}), false);
});

test('a late request never undoes a newer one; with none, the life end wins (#453 P1-C)', () => {
  const i = new Intents();
  // R1 pending -> hide -> show -> R2 in effect -> R1 resolves.
  const r1 = i.begin('play', true);
  i.endLife();                          // hide
  assert.equal(i.current(r1), false);
  assert.equal(i.wants('play'), false, 'with no R2, the late R1 must be undone');
  const r2 = i.begin('play', true);     // shown again; the user plays
  assert.equal(i.current(r2), true);
  assert.equal(i.current(r1), false, 'R1 is stale');
  assert.equal(i.wants('play'), true, 'R2 asked to play: the stale R1 leaves it alone');
  // A pause is an intent too: R3 play pending, the user pauses, R3 resolves.
  const r3 = i.begin('play', true);
  i.begin('play', false);
  assert.equal(i.current(r3), false);
  assert.equal(i.wants('play'), false, 'the pause wins');
  // Kinds are separate.
  const f = i.begin('fullscreen', true);
  i.begin('pip', true);
  assert.equal(i.current(f), true, 'a PiP request does not stale a fullscreen one');
  i.endLife();
  assert.equal(i.wants('fullscreen') || i.wants('pip') || i.wants('seek'), false, 'a life end turns every kind off');
});
