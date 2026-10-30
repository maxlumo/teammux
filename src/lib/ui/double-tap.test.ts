import test from 'node:test';
import assert from 'node:assert/strict';
import { doubletap, DOUBLE_TAP_MS } from './double-tap.ts';
import { HOLD_MS, SLOP_PX } from './longpress.ts';

// The action on a bare EventTarget: what a finger, a mouse and a pen send, in
// the order the browser sends it (board #484).
function rig(scope: unknown = 'room-a') {
  // The element and its window: an event sent to the window is one that
  // happened OUTSIDE the element (another card, the page).
  const win = new EventTarget();
  const node: EventTarget & { contains?: (t: unknown) => boolean; ownerDocument?: unknown } = new EventTarget();
  node.contains = (t) => t === node;
  node.ownerDocument = { defaultView: win };
  const fired: number[] = [];
  const clicks: string[] = [];
  const action = doubletap(node as unknown as HTMLElement, { scope, ondoubletap: () => fired.push(clicks.length) });
  node.addEventListener('click', (e) => clicks.push((e as unknown as { tag: string }).tag));
  const send = (type: string, props: Record<string, unknown>) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    node.dispatchEvent(e);
    return e;
  };
  /** One press: down, optional moves, up, then its compatibility click. */
  const press = (o: { t: number; x?: number; y?: number; type?: string; hold?: number; moveTo?: [number, number]; primary?: boolean; click?: boolean; tag?: string }) => {
    const base = { pointerType: o.type ?? 'touch', isPrimary: o.primary ?? true };
    const x = o.x ?? 50, y = o.y ?? 20;
    send('pointerdown', { ...base, clientX: x, clientY: y, timeStamp: o.t });
    if (o.moveTo) send('pointermove', { ...base, clientX: o.moveTo[0], clientY: o.moveTo[1], timeStamp: o.t + 10 });
    const [ux, uy] = o.moveTo ?? [x, y];
    send('pointerup', { ...base, clientX: ux, clientY: uy, timeStamp: o.t + (o.hold ?? 60) });
    if (o.click !== false) send('click', { tag: o.tag ?? `click@${o.t}` });
  };
  const outside = (type: string, props: Record<string, unknown> = {}) => {
    const e = new Event(type, { cancelable: true });
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    win.dispatchEvent(e);
  };
  const rescope = (next: unknown) => action.update({ scope: next, ondoubletap: () => fired.push(clicks.length) });
  return { node, fired, clicks, send, press, outside, rescope, action };
}

test('two finger taps make one double-tap; the first tap stays a tap, the second tap\u2019s click is swallowed (#484)', () => {
  const r = rig();
  r.press({ t: 1000, tag: 'tap1' });
  r.press({ t: 1000 + DOUBLE_TAP_MS - 70, tag: 'tap2' });
  assert.deepEqual(r.fired, [1], 'one double-tap, fired before the second click');
  assert.deepEqual(r.clicks, ['tap1'], 'tap 1 reached the element; tap 2 did not');
  r.press({ t: 1400, tag: 'tap3' });
  assert.deepEqual(r.clicks, ['tap1', 'tap3'], 'the guard was spent on tap 2');
  assert.deepEqual(r.fired, [1], 'a third tap starts a new pair');
});

test('only a finger pairs: a mouse and a pen keep their own double-click (#484 review P1-A)', () => {
  for (const type of ['mouse', 'pen']) {
    const r = rig();
    r.press({ t: 1000, type });
    r.press({ t: 1100, type });
    assert.deepEqual(r.fired, [], type);
    assert.equal(r.clicks.length, 2, `${type}: both clicks reach the element`);
  }
  const r = rig();
  r.press({ t: 1000, type: 'pen' });
  r.press({ t: 1100 });
  assert.deepEqual(r.fired, [], 'a pen tap and then a finger tap are not a pair');
});

test('what is not two clean taps breaks the pair (#484)', () => {
  const cases: Array<[string, (r: ReturnType<typeof rig>) => void]> = [
    ['too slow', (r) => { r.press({ t: 1000 }); r.press({ t: 1000 + DOUBLE_TAP_MS + 60 }); }],
    ['too far apart', (r) => { r.press({ t: 1000 }); r.press({ t: 1100, x: 50 + 41 }); }],
    ['a swipe on the second press (a strip scroll)', (r) => { r.press({ t: 1000 }); r.press({ t: 1100, moveTo: [50 + SLOP_PX + 1, 20] }); }],
    ['a swipe on the first press', (r) => { r.press({ t: 1000, moveTo: [50, 20 + SLOP_PX + 1] }); r.press({ t: 1100 }); }],
    ['a hold (a long press) on the second press', (r) => { r.press({ t: 1000 }); r.press({ t: 1100, hold: HOLD_MS }); }],
    // A hold first (its menu opened): a quick tap after its release is not its pair.
    ['a hold, then a quick tap', (r) => { r.press({ t: 1000, hold: HOLD_MS }); r.press({ t: 1000 + HOLD_MS + 50 }); }],
    ['a cancelled pointer between', (r) => { r.press({ t: 1000 }); r.send('pointercancel', { pointerType: 'touch', isPrimary: true }); r.press({ t: 1100 }); }],
    ['a second finger', (r) => { r.press({ t: 1000 }); r.press({ t: 1100, primary: false }); r.press({ t: 1200 }); }],
  ];
  for (const [name, run] of cases) {
    const r = rig();
    run(r);
    assert.deepEqual(r.fired, [], name);
  }
  // The second-finger case: its own press resets, and the next clean pair works.
  const r = rig();
  r.press({ t: 1000 }); r.press({ t: 1100, primary: false }); r.press({ t: 1200 }); r.press({ t: 1300 });
  assert.equal(r.fired.length, 1, 'a clean pair after the break still fires');
});

test('a guard with no compatibility click never eats a later activation (#484 review)', () => {
  // An engine that sends no click for the second tap: the next press clears it.
  let r = rig();
  r.press({ t: 1000, tag: 'tap1' });
  r.press({ t: 1100, click: false });
  assert.equal(r.fired.length, 1);
  r.press({ t: 2000, type: 'mouse', tag: 'later mouse click' });
  assert.deepEqual(r.clicks, ['tap1', 'later mouse click']);
  // ... and a key (a keyboard activation is a keydown, then a click).
  r = rig();
  r.press({ t: 1000, tag: 'tap1' });
  r.press({ t: 1100, click: false });
  r.send('keydown', { key: 'Enter' });
  r.send('click', { tag: 'Enter' });
  assert.deepEqual(r.clicks, ['tap1', 'Enter']);
});

test('what happens outside the element breaks its pair; a clean pair after it still fires (#484 review P1-A)', () => {
  const cases: Array<[string, (r: ReturnType<typeof rig>) => void]> = [
    ['a press elsewhere (another card, the strip) between the taps', (r) => { r.press({ t: 1000 }); r.outside('pointerdown', { pointerType: 'touch', isPrimary: true }); r.press({ t: 1150 }); }],
    ['a second finger elsewhere while the second press is held', (r) => {
      r.press({ t: 1000 });
      r.send('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 20, timeStamp: 1100 });
      r.outside('pointerdown', { pointerType: 'touch', isPrimary: false });
      r.send('pointerup', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 20, timeStamp: 1160 });
    }],
    ['a page scroll between the taps', (r) => { r.press({ t: 1000 }); r.outside('scroll'); r.press({ t: 1150 }); }],
  ];
  for (const [name, run] of cases) {
    const r = rig();
    run(r);
    assert.deepEqual(r.fired, [], name);
    r.press({ t: 3000 }); r.press({ t: 3120 });
    assert.equal(r.fired.length, 1, `${name}: a clean pair afterwards still fires`);
  }
  const r = rig();
  r.press({ t: 1000 }); r.press({ t: 1100 }); r.action.destroy();
  r.outside('pointerdown', { pointerType: 'touch', isPrimary: true });
  assert.equal(r.fired.length, 1, 'teardown leaves nothing behind that fires');
});

test('a pair completes only in the scope its first tap had (#484 review P1-B)', () => {
  // The element survives a room switch: the first tap belonged to the old room.
  let r = rig('room-a');
  r.press({ t: 1000 });
  r.rescope('room-b');
  r.press({ t: 1100 });
  assert.deepEqual(r.fired, [], 'no pair across the switch');
  r.press({ t: 3000 }); r.press({ t: 3100 });
  assert.equal(r.fired.length, 1, 'a clean pair in the new room fires');
  // A re-render with the SAME scope (tap 1 changed the selection) keeps the pair.
  r = rig('room-a');
  r.press({ t: 1000 });
  r.rescope('room-a');
  r.press({ t: 1100 });
  assert.equal(r.fired.length, 1, 'same scope, new callback: still one pair');
  // A press held across the switch is retired too.
  r = rig('room-a');
  r.press({ t: 1000 });
  r.send('pointerdown', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 20, timeStamp: 1100 });
  r.rescope('room-b');
  r.send('pointerup', { pointerType: 'touch', isPrimary: true, clientX: 50, clientY: 20, timeStamp: 1160 });
  assert.deepEqual(r.fired, [], 'the held press of the old room does not pair');
});

test('destroy removes the window capture listeners it added (#484 review P2-C, #485)', () => {
  // A window that keeps a ledger of live registrations by type, function and
  // capture, the triple removeEventListener must match. A retained listener
  // only resets state and never calls back, so counting callbacks proves
  // nothing; the ledger does.
  const live = new Map<string, number>();
  const fns = new Map<unknown, number>();
  const key = (type: string, fn: unknown, options?: boolean | AddEventListenerOptions) => {
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    if (!fns.has(fn)) fns.set(fn, fns.size);
    return `${type}|${fns.get(fn)}|${capture}`;
  };
  const win = {
    addEventListener: (type: string, fn: unknown, options?: boolean | AddEventListenerOptions) => {
      const k = key(type, fn, options); live.set(k, (live.get(k) ?? 0) + 1);
    },
    removeEventListener: (type: string, fn: unknown, options?: boolean | AddEventListenerOptions) => {
      const k = key(type, fn, options); const n = live.get(k) ?? 0;
      if (n <= 1) live.delete(k); else live.set(k, n - 1);
    },
  };
  const node: EventTarget & { contains?: (t: unknown) => boolean; ownerDocument?: unknown } = new EventTarget();
  node.contains = (t) => t === node;
  node.ownerDocument = { defaultView: win };
  const action = doubletap(node as unknown as HTMLElement, { scope: 'room-a', ondoubletap: () => {} });
  const types = () => [...live.keys()].map((k) => k.split('|')).map(([type, , capture]) => `${type}:${capture}`).sort();
  assert.deepEqual(types(), ['pointerdown:true', 'scroll:true'], 'the action watches the window in capture for presses and scrolls');
  action.update({ scope: 'room-b', ondoubletap: () => {} });
  assert.deepEqual(types(), ['pointerdown:true', 'scroll:true'], 'an update adds no second set');
  action.destroy();
  assert.deepEqual([...live.keys()], [], 'destroy removes both, by the same function and capture flag');
});
