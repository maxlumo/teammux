// Two servers' alert lists and the one bell above them (board #335 ②a-4).
//
// `notify-centre.test.ts` covers the pure rules (`withAlert`, `readThrough`,
// `alertOf`) and is unchanged. This file is about the OWNERSHIP split the
// factory makes explicit: the list is per server, the popover and the jump
// request are per window.
import test from 'node:test';
import assert from 'node:assert/strict';
// The store is a runes module; outside the compiler $state is the value
// itself (the downloads.test.ts / i18n.test.ts convention).
(globalThis as any).$state = (value: unknown) => value;
const { createAlertLog, createCentreSurface, alertOf, ALERTS_KEY } =
  await import('./notify-centre.svelte.ts');

function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
  };
}

/** One server's slot, the way ②b scopes it. */
const scoped = (disk: ReturnType<typeof mem>, id: string) => ({
  getItem: (k: string) => disk.getItem(`${k}::${id}`),
  setItem: (k: string, v: string) => disk.setItem(`${k}::${id}`, v),
});

const alert = (server: string, session: string, id: string, over: Partial<{ seq: number; ts: number }> = {}) =>
  alertOf(
    { id, from: 'builder', ts: over.ts ?? 1000, seq: over.seq ?? 1, to: ['human'] } as any,
    { server, room: `proj:${session}`, session, project: session, kind: 'reply' as any, viewed: false, excerpt: 'hi' },
  );

test('two servers keep their own alerts for the same room name', () => {
  // A project called `app` on both machines produces alert keys that are
  // identical except for the server, so one list per server is what keeps
  // them apart — and clearing one must not clear the other.
  const disk = mem();
  const a = createAlertLog(scoped(disk, 'a'));
  const b = createAlertLog(scoped(disk, 'b'));
  a.record(alert('a', 'app', 'm1'));
  b.record(alert('b', 'app', 'm1'));
  assert.equal(a.unviewed, 1);
  assert.equal(b.unviewed, 1);

  a.viewed(a.items[0]!.key);
  assert.equal(a.unviewed, 0);
  assert.equal(b.unviewed, 1, 'viewing A s entry says nothing about B s');

  b.clear();
  assert.equal(b.items.length, 0);
  assert.equal(a.items.length, 1, 'clearing one list leaves the other');
  assert.ok(disk.getItem(`${ALERTS_KEY}::a`), 'each list is stored in its own slot');
});

test('reading a room on one server does not view the other s entries', () => {
  // `markRoomRead` is keyed by session name, which is exactly the collision:
  // reading `app` on A must not mark `app` on B as seen.
  const disk = mem();
  const a = createAlertLog(scoped(disk, 'a'));
  const b = createAlertLog(scoped(disk, 'b'));
  a.record(alert('a', 'app', 'm1', { seq: 5 }));
  b.record(alert('b', 'app', 'm1', { seq: 5 }));

  a.markRoomRead('app', 9);
  assert.equal(a.unviewed, 0);
  assert.equal(b.unviewed, 1, 'B s watermark is B s');
});

test('a failure message belongs to the list that holds the entry', () => {
  const disk = mem();
  const a = createAlertLog(scoped(disk, 'a'));
  const b = createAlertLog(scoped(disk, 'b'));
  const shared = alert('a', 'app', 'm1');
  a.record(shared);
  b.record({ ...shared, server: 'b' });
  a.failed(shared.key, 'gone');
  assert.equal(a.items[0]?.failed, 'gone');
  assert.equal(b.items[0]?.failed, undefined, 'the same key on B is a different entry');
});

test('one window has ONE bell, popover and jump request', () => {
  // A second anchor would be two popovers in one corner; a per-server jump
  // counter would let two requests both believe they are current.
  const surface = createCentreSurface();
  const bell = {} as HTMLElement;
  const header = {} as HTMLElement;

  surface.toggle(bell);
  assert.equal(surface.anchor, bell);
  surface.toggle(header);
  assert.equal(surface.anchor, header, 'the other control takes the popover over');
  surface.toggle(header);
  assert.equal(surface.anchor, null, 'and the same control closes it');

  // A jump for A, then one for B: only the newest is current, whichever
  // server it names.
  const first = alert('a', 'app', 'm1');
  surface.requestJump(first);
  const n1 = surface.jump!.n;
  surface.requestJump(alert('b', 'app', 'm1'));
  const n2 = surface.jump!.n;
  assert.notEqual(n1, n2);
  assert.equal(surface.isCurrent(n1), false, 'A s request was superseded');
  assert.equal(surface.isCurrent(n2), true);
  assert.equal(surface.jump!.alert.server, 'b');

  // Consuming a superseded request leaves the current one alone.
  surface.consume(n1);
  assert.equal(surface.jump?.n, n2);
  surface.consume(n2);
  assert.equal(surface.jump, null, 'and a consumed request is never replayed');
});

test('leaving a server drops anything aimed at it', () => {
  // A jump request names one server's message. If the user leaves that
  // server, the request must not land somewhere else.
  const surface = createCentreSurface();
  surface.toggle({} as HTMLElement);
  surface.requestJump(alert('a', 'app', 'm1'));
  surface.reset();
  assert.equal(surface.jump, null);
  assert.equal(surface.anchor, null, 'and the popover is closed with it');
});

test('a log with no storage still works', () => {
  // Private mode, or a realm without localStorage: the list is in memory and
  // nothing throws.
  const a = createAlertLog(null);
  a.record(alert('a', 'app', 'm1'));
  assert.equal(a.unviewed, 1);
  assert.deepEqual(createAlertLog(null).items, [], 'and a new one has nothing to read');
});
