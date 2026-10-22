import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileMount } from '../test/mount.ts';

// Board #453: the media position bar's commit protocol, per input kind.

const compiled = compileMount(new URL('./MediaRange.svelte', import.meta.url), []);

async function bar(context: test.TestContext) {
  const log: string[] = [];
  const app = await (await compiled).mount(context, {
    props: { value: 10, max: 600, label: 'Position', valuetext: '0:10 of 10:00',
      buffered: [{ start: 0, end: 60 }, { start: 300, end: 330 }], epoch: 0,
      onpreview: (v: number) => log.push(`preview ${v}`), oncommit: (v: number) => log.push(`commit ${v}`), oncancel: () => log.push('cancel') },
    modules: [],
  });
  const range = app.document.querySelector('input')!;
  const fire = (type: string) => range.dispatchEvent(new app.window.Event(type, { bubbles: true }));
  const move = (v: number) => { range.value = String(v); fire('input'); };
  return { app, range, fire, move, log };
}

test('a native range with its value said, and the buffered ranges painted', async (context) => {
  const { app, range } = await bar(context);
  try {
    assert.equal(range.type, 'range');
    assert.equal(range.getAttribute('aria-label'), 'Position');
    assert.equal(range.getAttribute('aria-valuetext'), '0:10 of 10:00');
    assert.equal(range.max, '600');
    assert.equal(range.valueAsNumber, 10);
    const bufs = [...app.document.querySelectorAll<HTMLElement>('.mr-buf')].map((b) => [b.style.left, b.style.width]);
    assert.deepEqual(bufs, [['0%', '10%'], ['50%', '5%']], 'buffered spans, as a share of the length');
  } finally { await app.close(); }
});

test('a pointer drag previews on input and commits once on release, whatever order change comes in', async (context) => {
  const { app, fire, move, log } = await bar(context);
  try {
    fire('pointerdown'); move(120); move(240); fire('pointerup'); fire('change'); fire('lostpointercapture');
    assert.deepEqual(log, ['preview 120', 'preview 240', 'commit 240'], 'change after the release is not a second commit');
    log.length = 0;
    fire('pointerdown'); move(90); fire('change'); fire('pointerup');
    assert.deepEqual(log, ['preview 90', 'commit 90'], 'change before the release commits once');
  } finally { await app.close(); }
});

test('a cancelled or lost pointer seeks nothing', async (context) => {
  const { app, fire, move, log } = await bar(context);
  try {
    fire('pointerdown'); move(300); fire('pointercancel');
    fire('pointerdown'); move(400); fire('lostpointercapture');
    assert.deepEqual(log, ['preview 300', 'cancel', 'preview 400', 'cancel']);
  } finally { await app.close(); }
});

test('keyboard and assistive technology commit on change, with no pointerup, and keep their keys', async (context) => {
  const { app, range, fire, move, log } = await bar(context);
  try {
    let reached = 0;
    app.window.addEventListener('keydown', () => { reached++; });
    range.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    move(11); fire('change');
    assert.deepEqual(log, ['preview 11', 'commit 11']);
    assert.equal(reached, 0, 'the range keeps its arrow: it stops propagating, so the player does not also seek');
    // A pointer release whose change never came does not swallow the next key's commit.
    log.length = 0;
    fire('pointerdown'); move(50); fire('pointerup');
    range.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    move(600); fire('change');
    assert.deepEqual(log, ['preview 50', 'commit 50', 'preview 600', 'commit 600']);
  } finally { await app.close(); }
});

test('each input is one transaction, and the host hears its id (#453 review P1-A)', async (context) => {
  const { app, fire, move } = await bar(context);
  const seen: string[] = [];
  await app.setProps({ onpreview: (v: number, tx: number) => seen.push(`p${tx}:${v}`), oncommit: (v: number, tx: number) => seen.push(`c${tx}:${v}`), oncancel: (tx: number) => seen.push(`x${tx}`) });
  try {
    fire('pointerdown'); move(100); move(200); fire('pointerup');
    move(201); fire('change');
    fire('pointerdown'); move(50); fire('pointercancel');
    assert.deepEqual(seen, ['p1:100', 'p1:200', 'c1:200', 'p2:201', 'c2:201', 'p3:50', 'x3']);
  } finally { await app.close(); }
});

test('a host epoch bump kills the open drag: the same finger previews, commits and cancels nothing until lifted (#453 review P1-A)', async (context) => {
  const { app, range, fire, move, log } = await bar(context);
  try {
    fire('pointerdown'); move(300);
    await app.setProps({ epoch: 1 });
    move(350);
    assert.equal(range.valueAsNumber, 10, 'a dead move puts the thumb back at once');
    move(400); fire('change'); fire('pointerup'); fire('lostpointercapture');
    assert.deepEqual(log, ['preview 300'], 'the old finger after the bump is nobody\'s');
    assert.equal(range.valueAsNumber, 10, 'and its thumb goes back to the host\'s value');
    fire('pointerdown'); move(120); fire('pointerup');
    assert.deepEqual(log, ['preview 300', 'preview 120', 'commit 120'], 'a new pointer is a new transaction');
    // A keyboard/AT transaction open across a bump commits nothing either.
    log.length = 0;
    move(130); await app.setProps({ epoch: 2 }); fire('change');
    assert.deepEqual(log, ['preview 130']);
  } finally { await app.close(); }
});

test('after a pointer release whose change never came, an assistive adjustment with no key still commits (#453 review P1-A)', async (context) => {
  const { app, fire, move, log } = await bar(context);
  try {
    fire('pointerdown'); move(50); fire('pointerup');
    move(60); fire('change');
    assert.deepEqual(log, ['preview 50', 'commit 50', 'preview 60', 'commit 60'], 'the old trailing-change mark does not eat it');
    // Validator V1: a STILL press (no input at all), then the AX increment.
    log.length = 0;
    fire('pointerdown'); fire('pointerup');
    move(90); fire('change');
    assert.deepEqual(log.slice(-2), ['preview 90', 'commit 90'], 'an adjust after a still press commits');
  } finally { await app.close(); }
});

test('after a cancel or a lost capture, late events of that pointer seek nothing (#453 review P1-A)', async (context) => {
  const { app, fire, move, log } = await bar(context);
  try {
    fire('pointerdown'); move(300); fire('pointercancel'); fire('change'); fire('pointerup');
    fire('pointerdown'); move(400); fire('lostpointercapture'); fire('change'); fire('pointerup');
    assert.deepEqual(log, ['preview 300', 'cancel', 'preview 400', 'cancel']);
  } finally { await app.close(); }
});

// Review round 5: a pointer event with an id and a type, and a release
// that lands outside the range (its capture lost).
function ptr(app: Awaited<ReturnType<typeof bar>>['app'], type: string, init: { id?: number; kind?: string } = {}) {
  const e = new app.window.Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerId', { value: init.id ?? 1 });
  Object.defineProperty(e, 'pointerType', { value: init.kind ?? 'mouse' });
  return e;
}

test('a lost capture ends the transaction, not the press: the held finger\'s inputs are dropped until its real release (#453 review round 5)', async (context) => {
  const { app, range, fire, move, log } = await bar(context);
  try {
    range.dispatchEvent(ptr(app, 'pointerdown')); move(300);
    range.dispatchEvent(ptr(app, 'lostpointercapture'));
    move(350);
    assert.equal(range.valueAsNumber, 10, 'the thumb snaps back');
    fire('change');
    range.dispatchEvent(ptr(app, 'pointerup'));
    assert.deepEqual(log, ['preview 300', 'cancel'], 'no seek, no new transaction from the held finger');
    range.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    move(11); fire('change');
    assert.deepEqual(log, ['preview 300', 'cancel', 'preview 11', 'commit 11'], 'a genuine keyboard adjust after the real release commits');
  } finally { await app.close(); }
});

test('a host bump, then a lost capture, then the same finger keeps going: nothing until it lifts, wherever it lifts (#453 review round 5)', async (context) => {
  const { app, range, fire, move, log } = await bar(context);
  try {
    range.dispatchEvent(ptr(app, 'pointerdown')); move(300);
    await app.setProps({ epoch: 1 });
    range.dispatchEvent(ptr(app, 'lostpointercapture'));
    move(320); fire('change'); move(330); fire('change');
    assert.deepEqual(log, ['preview 300'], 'not re-read as an AT adjust under the new epoch');
    // The real release lands elsewhere (no capture), seen on the window.
    app.document.body.dispatchEvent(ptr(app, 'pointerup'));
    move(40); fire('change');
    assert.deepEqual(log, ['preview 300', 'preview 40', 'commit 40'], 'after the real release an AT adjust commits');
  } finally { await app.close(); }
});

test('a pointercancel is not a release either; another finger\'s pointerup does not end the press (#453 review round 5)', async (context) => {
  const { app, range, fire, move, log } = await bar(context);
  try {
    range.dispatchEvent(ptr(app, 'pointerdown', { id: 1 })); move(100);
    range.dispatchEvent(ptr(app, 'pointerup', { id: 2 }));
    app.document.body.dispatchEvent(ptr(app, 'pointerup', { id: 2 }));
    move(150);
    range.dispatchEvent(ptr(app, 'pointerup', { id: 1 }));
    assert.deepEqual(log, ['preview 100', 'preview 150', 'commit 150'], 'finger 2 lifting changes nothing for finger 1');
    log.length = 0;
    range.dispatchEvent(ptr(app, 'pointerdown', { id: 3, kind: 'touch' })); move(200);
    range.dispatchEvent(ptr(app, 'pointercancel', { id: 3, kind: 'touch' }));
    move(210); fire('change');
    assert.deepEqual(log, ['preview 200', 'cancel'], 'the cancelled touch still holds its inputs');
    // No pointerup follows a pointercancel: the touch's own end releases it.
    const end = new app.window.Event('touchend', { bubbles: true });
    Object.defineProperty(end, 'touches', { value: [] });
    app.document.body.dispatchEvent(end);
    move(220); fire('change');
    assert.deepEqual(log, ['preview 200', 'cancel', 'preview 220', 'commit 220'], 'released: an AT adjust commits');
    // A genuinely new pointerdown starts a new transaction even over a dead press.
    log.length = 0;
    range.dispatchEvent(ptr(app, 'pointerdown', { id: 4 })); move(300); range.dispatchEvent(ptr(app, 'lostpointercapture', { id: 4 }));
    range.dispatchEvent(ptr(app, 'pointerdown', { id: 5 })); move(310); range.dispatchEvent(ptr(app, 'pointerup', { id: 5 }));
    assert.deepEqual(log, ['preview 300', 'cancel', 'preview 310', 'commit 310']);
    // Over a LIVE press, a new pointerdown cancels the old transaction first.
    log.length = 0;
    range.dispatchEvent(ptr(app, 'pointerdown', { id: 6 })); move(400);
    range.dispatchEvent(ptr(app, 'pointerdown', { id: 7 })); move(410); range.dispatchEvent(ptr(app, 'pointerup', { id: 7 }));
    range.dispatchEvent(ptr(app, 'pointerup', { id: 6 }));
    assert.deepEqual(log, ['preview 400', 'cancel', 'preview 410', 'commit 410'], 'one transaction at a time; the old finger\'s up is nobody\'s');
  } finally { await app.close(); }
});

test('source pin: min, max and step are written before value (#453)', () => {
  const src = readFileSync(new URL('./MediaRange.svelte', import.meta.url), 'utf8');
  assert.match(src, /<input type="range" min="0" \{max\} \{step\} \{value\}/u);
  assert.match(src, /touch-action: none/u, 'a drag on the bar is a seek, never a page gesture');
});
