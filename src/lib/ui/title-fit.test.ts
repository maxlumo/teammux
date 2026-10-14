import test from 'node:test';
import assert from 'node:assert/strict';
import { FIT_CLASS, OVERFLOW_TOLERANCE_PX, overflowsItself, titleFit } from './title-fit.ts';

// The Name + tag stack's fit test (#369). jsdom has no layout, so the action
// is held with a fake element whose widths the test sets, and fake observers /
// rAF the test fires by hand: what is pinned is WHEN it measures and WHAT it
// writes (one class, nothing else), not pixels (those are the real browser's:
// the matrix on #369).

function fixture(widths = { scrollWidth: 100, clientWidth: 100 }, shape: 'hub' | 'board' = 'hub') {
  const resizeCallbacks: (() => void)[] = [];
  const mutationCallbacks: (() => void)[] = [];
  const observed = new Set<unknown>();
  const watchedChildren = new Map<unknown, unknown>();
  let disconnects = 0;
  class Resize {
    constructor(fn: () => void) { resizeCallbacks.push(fn); }
    observe(node: unknown) { observed.add(node); }
    disconnect() { observed.clear(); disconnects++; }
  }
  class Mutation {
    constructor(fn: () => void) { mutationCallbacks.push(fn); }
    observe(node: unknown, init: unknown) { watchedChildren.set(node, init); }
    disconnect() { watchedChildren.clear(); }
  }
  const frames = new Map<number, () => void>();
  let nextFrame = 1, cancelled = 0;
  const view = {
    ResizeObserver: Resize,
    MutationObserver: Mutation,
    requestAnimationFrame: (fn: () => void) => { frames.set(nextFrame, fn); return nextFrame++; },
    cancelAnimationFrame: (id: number) => { cancelled++; frames.delete(id); },
  };
  const classes = new Set<string>();
  const writes: string[] = [];
  const head = {}, group = {};
  const stack = {
    ...widths,
    ownerDocument: { defaultView: view },
    // The Hub: head > group > stack. The Board: head > stack (parent IS the head).
    parentElement: shape === 'board' ? head : group,
    closest: (sel: string) => (sel === '.page-head' ? head : null),
    classList: {
      add(name: string) { classes.add(name); writes.push(`+${name}`); },
      remove(name: string) { classes.delete(name); writes.push(`-${name}`); },
    },
    style: new Proxy({}, { set() { throw new Error('the action writes no style'); } }),
  };
  const flush = () => { const run = [...frames.values()]; frames.clear(); run.forEach((fn) => fn()); };
  return { stack, classes, writes, observed, watchedChildren, head, group, resizeCallbacks, mutationCallbacks, frames, flush, cancelled: () => cancelled, disconnects: () => disconnects };
}

test('overflowsItself: past the tolerance is an overflow, sub-pixel rounding is not', () => {
  assert.equal(OVERFLOW_TOLERANCE_PX, 1);
  assert.equal(overflowsItself({ scrollWidth: 100, clientWidth: 100 }), false);
  assert.equal(overflowsItself({ scrollWidth: 100.4, clientWidth: 100 }), false, 'the group shrinks a few hundredths while the path has room');
  assert.equal(overflowsItself({ scrollWidth: 101, clientWidth: 100 }), false, 'the tolerance is inclusive');
  assert.equal(overflowsItself({ scrollWidth: 101.5, clientWidth: 100 }), true);
  assert.equal(overflowsItself({ scrollWidth: 60, clientWidth: 100 }), false, 'room to spare is a fit');
});

test('titleFit: a stack that overflows itself wears the class, one that fits does not', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  titleFit(f.stack as unknown as HTMLElement);
  assert.ok(f.classes.has(FIT_CLASS), 'the tag does not fit beside the name: under it');
  const g = fixture({ scrollWidth: 120, clientWidth: 120 });
  titleFit(g.stack as unknown as HTMLElement);
  assert.equal(g.classes.has(FIT_CLASS), false, 'it fits: beside it');
});

test('titleFit: every test takes the class off BEFORE it reads, then decides — measured once, one class, no style', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  f.classes.add(FIT_CLASS); // arrives already wrapped
  titleFit(f.stack as unknown as HTMLElement);
  assert.deepEqual(f.writes.slice(0, 2), ['-fit-wrapped', '+fit-wrapped'], 'removed first (the column form would hide the overflow), then set from the reading');
  assert.deepEqual([...new Set(f.writes.map((w) => w.slice(1)))], [FIT_CLASS], 'the only thing it ever writes is that one class (a style write throws)');
});

test('titleFit: re-tests on the head and the group resizing — coalesced to one frame — and the stack widening takes the class off', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  titleFit(f.stack as unknown as HTMLElement);
  assert.deepEqual([...f.observed], [f.group, f.head], 'the parent group and the head, nothing else');
  assert.ok(f.classes.has(FIT_CLASS));
  const before = f.writes.length;
  f.stack.clientWidth = 200; // the head widened: the tag fits again
  f.resizeCallbacks[0]!();
  f.resizeCallbacks[0]!();
  f.resizeCallbacks[0]!();
  assert.equal(f.frames.size, 1, 'a burst of observer calls is ONE frame');
  assert.equal(f.writes.length, before, 'nothing measured before the frame');
  f.flush();
  assert.equal(f.classes.has(FIT_CLASS), false, 'back beside the name');
  f.stack.scrollWidth = 260;
  f.resizeCallbacks[0]!();
  f.flush();
  assert.ok(f.classes.has(FIT_CLASS), 'and under it again when the head narrows');
});

test('titleFit: the answer is a function of the layout, so asking twice never flips it', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  titleFit(f.stack as unknown as HTMLElement);
  for (let i = 0; i < 5; i++) { f.resizeCallbacks[0]!(); f.flush(); assert.ok(f.classes.has(FIT_CLASS), `run ${i}`); }
});

test('titleFit: a changed key (rename, new tag) re-tests; the same words do not need an observer to be heard', () => {
  const f = fixture({ scrollWidth: 120, clientWidth: 120 });
  const action = titleFit(f.stack as unknown as HTMLElement, { key: 'app|dev' });
  assert.equal(f.classes.has(FIT_CLASS), false);
  f.stack.scrollWidth = 190; // the tag got longer: in the column form no box the observer sees may have changed
  action.update({ key: 'app|dev-dsk-cfu-devbox-2a-79ac0e36' });
  assert.ok(f.classes.has(FIT_CLASS), 'update re-tests at once');
});

test('titleFit: inactive (the phone) is a no-op that takes its class off and observes nothing', () => {
  const f = fixture({ scrollWidth: 300, clientWidth: 100 });
  f.classes.add(FIT_CLASS);
  const action = titleFit(f.stack as unknown as HTMLElement, { active: false });
  assert.equal(f.classes.has(FIT_CLASS), false, 'the phone is stacked by its own class');
  assert.equal(f.observed.size, 0, 'no observer on the phone');
  action.update({ active: true });
  assert.ok(f.classes.has(FIT_CLASS), 'a window widened out of the phone form starts testing');
  assert.equal(f.observed.size, 2);
  action.update({ active: false });
  assert.equal(f.classes.has(FIT_CLASS), false);
  assert.equal(f.observed.size, 0, 'and stops again');
});

test('titleFit: destroy cancels the pending frame, disconnects, and takes the class off', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  const action = titleFit(f.stack as unknown as HTMLElement);
  f.resizeCallbacks[0]!();
  assert.equal(f.frames.size, 1);
  action.destroy();
  assert.equal(f.cancelled(), 1, 'the queued test never runs on a torn-down stack');
  assert.equal(f.observed.size, 0);
  assert.equal(f.classes.has(FIT_CLASS), false);
});

test('titleFit (the Board\'s shape, parent === head): one element is observed once, resize AND child set', () => {
  const f = fixture({ scrollWidth: 120, clientWidth: 120 }, 'board');
  titleFit(f.stack as unknown as HTMLElement);
  assert.deepEqual([...f.observed], [f.head], 'one element, once');
  assert.deepEqual([...f.watchedChildren.entries()], [[f.head, { childList: true }]], 'its direct children only: no subtree, no attributes');
});

test('titleFit: a control appearing in the head (the Board\'s "new" button) re-tests though no box the resize observer watches changed', () => {
  // The state the first S1 missed (#369 review P1): the head keeps its size, the
  // key is unchanged, a sibling appears and the room the stack is GIVEN shrinks.
  const f = fixture({ scrollWidth: 120, clientWidth: 120 }, 'board');
  titleFit(f.stack as unknown as HTMLElement, { key: 'Board|dev' });
  assert.equal(f.classes.has(FIT_CLASS), false, 'inline: it fits');
  f.stack.clientWidth = 90; // the new button took room; the stack shrank, nothing resized the head
  assert.equal(f.frames.size, 0);
  f.mutationCallbacks[0]!();
  assert.equal(f.frames.size, 1, 'the child-set change schedules ONE frame');
  f.flush();
  assert.ok(f.classes.has(FIT_CLASS), 'and the tag drops under the name');
  // The reverse: the control leaves, the room comes back.
  f.stack.clientWidth = 120;
  f.mutationCallbacks[0]!();
  f.flush();
  assert.equal(f.classes.has(FIT_CLASS), false, 'back beside the name, with no resize and no key change');
});

test('titleFit: resize and child-set triggers share ONE frame', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  titleFit(f.stack as unknown as HTMLElement);
  const before = f.writes.length;
  f.resizeCallbacks[0]!();
  f.mutationCallbacks[0]!();
  f.mutationCallbacks[0]!();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(f.writes.length - before, 2, 'one test = one remove + one add');
});

test('titleFit: resize -> update -> destroy -> flush writes nothing after destroy (the lost-frame-handle bug, #369 review P2-A)', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  const action = titleFit(f.stack as unknown as HTMLElement);
  f.resizeCallbacks[0]!(); // queues frame A
  assert.equal(f.frames.size, 1);
  action.update({ key: 'renamed' }); // a synchronous test: must CANCEL A, not forget it
  assert.equal(f.frames.size, 0, 'the superseded frame is cancelled');
  f.resizeCallbacks[0]!(); // queues frame B
  action.destroy();
  assert.equal(f.frames.size, 0, 'destroy cancels what is queued');
  const at = f.writes.length;
  f.flush();
  f.resizeCallbacks[0]!();
  f.mutationCallbacks[0]!();
  f.flush();
  assert.equal(f.writes.length, at, 'nothing measured and nothing written after destroy');
  assert.equal(f.classes.has(FIT_CLASS), false);
});

test('titleFit: update coalesces with a queued frame — never a second frame for the same layout', () => {
  const f = fixture({ scrollWidth: 120, clientWidth: 120 });
  const action = titleFit(f.stack as unknown as HTMLElement);
  f.resizeCallbacks[0]!();
  action.update({ key: 'a' });
  f.resizeCallbacks[0]!();
  assert.equal(f.frames.size, 1, 'a trigger after update queues again exactly once');
});

test('titleFit: inactive observes neither size nor child set, and destroy releases both', () => {
  const f = fixture({ scrollWidth: 300, clientWidth: 100 });
  const action = titleFit(f.stack as unknown as HTMLElement, { active: false });
  assert.equal(f.observed.size + f.watchedChildren.size, 0);
  action.update({ active: true });
  assert.equal(f.observed.size, 2);
  assert.equal(f.watchedChildren.size, 2);
  action.destroy();
  assert.equal(f.observed.size + f.watchedChildren.size, 0);
});

test('titleFit: update with the SAME key and active measures nothing (Svelte rebuilds the options object on every list refresh)', () => {
  const f = fixture({ scrollWidth: 170, clientWidth: 120 });
  const action = titleFit(f.stack as unknown as HTMLElement, { active: true, key: 'app|dev|false' });
  const before = f.writes.length;
  f.resizeCallbacks[0]!(); // a frame is queued and must survive a no-op update
  action.update({ active: true, key: 'app|dev|false' });
  action.update({ active: true, key: 'app|dev|false' });
  assert.equal(f.writes.length, before, 'no measurement, no write');
  assert.equal(f.frames.size, 1, 'and the queued frame is left alone');
  f.flush();
  action.update({ active: true, key: 'app|dev|true' });
  assert.ok(f.writes.length > before + 2, 'a changed key does measure');
});
