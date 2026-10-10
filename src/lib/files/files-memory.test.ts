// What the Files pages remember about one server, and that two servers
// remember separately (board #335 ②a-4).
//
// These rules used to live in Files.svelte's `<script module>`, where only a
// mount test could reach them. As a factory they are directly testable, and
// `Files.mount.test.ts` passing unchanged is the evidence the component still
// behaves the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFilesMemory } from './files-memory.ts';

test('two servers park the same session name separately', () => {
  // The collision this exists for: a project called `app` on both machines.
  // Keying by session name alone made returning to one server show the
  // other's directory.
  const a = createFilesMemory();
  const b = createFilesMemory();
  a.park('app', { cwd: '/srv/a/app', sourceDir: '/srv/a' });
  b.park('app', { cwd: '/srv/b/app', sourceDir: '/srv/b' });
  assert.deepEqual(a.position('app'), { cwd: '/srv/a/app', sourceDir: '/srv/a' });
  assert.deepEqual(b.position('app'), { cwd: '/srv/b/app', sourceDir: '/srv/b' });
  assert.equal(a.position('other'), undefined, 'a first visit inherits nothing');

  // Dropping one server's positions leaves the other's.
  a.reset();
  assert.equal(a.position('app'), undefined);
  assert.deepEqual(b.position('app'), { cwd: '/srv/b/app', sourceDir: '/srv/b' });
});

test('the one-writer rule holds across instances of one server, not across two', () => {
  // Board #305: the page and the drawer write the same part folder, so one
  // part has one writer. On two servers the same path yields the same part id
  // only if the machine id is the same — and when it is not, the two attempts
  // are different files and must not block each other.
  const a = createFilesMemory();
  const b = createFilesMemory();
  const page = {};
  const drawer = {};
  a.claim('part-1', { owner: page, adopt() {} });

  assert.equal(a.writerOf('part-1')?.owner, page, 'the drawer sees the page s claim');
  assert.equal(b.writerOf('part-1'), undefined, 'the other server has no claim on it');
  b.claim('part-1', { owner: drawer, adopt() {} });
  assert.equal(a.writerOf('part-1')?.owner, page, 'and claiming there did not take A s');

  a.release('part-1');
  assert.equal(a.writerOf('part-1'), undefined);
  assert.equal(b.writerOf('part-1')?.owner, drawer, 'releasing A s left B s');
});

test('a suspend stops this server s attempts and waits for them', () => {
  // The rule a switch depends on: every attempt is aborted with the switch's
  // reason, and the promise resolves only once each has SETTLED, so no retry
  // or re-sign of the old server's chain goes out after the socket moves.
  const a = createFilesMemory();
  const reasons: unknown[] = [];
  const settle: (() => void)[] = [];
  for (const id of ['r1', 'r2']) {
    const control = new AbortController();
    control.signal.addEventListener('abort', () => reasons.push(control.signal.reason));
    a.track(id, control, new Promise<void>((resolve) => settle.push(() => resolve())));
  }
  let done = false;
  const suspending = a.suspend('switching').then(() => { done = true; });

  assert.deepEqual(reasons, ['switching', 'switching'], 'both were aborted with the switch s reason');
  return Promise.resolve().then(() => {
    assert.equal(done, false, 'and it is still waiting for them to settle');
    settle[0]!();
    return Promise.resolve();
  }).then(() => {
    assert.equal(done, false, 'one settled is not all settled');
    settle[1]!();
    return suspending;
  }).then(() => {
    assert.equal(done, true);
  });
});

test('a suspend on one server does not touch the other s attempts', () => {
  const a = createFilesMemory();
  const b = createFilesMemory();
  const aborted: string[] = [];
  const track = (m: ReturnType<typeof createFilesMemory>, id: string) => {
    const control = new AbortController();
    control.signal.addEventListener('abort', () => aborted.push(id));
    m.track(id, control, Promise.resolve());
    return control;
  };
  track(a, 'a-row');
  const bControl = track(b, 'b-row');

  return a.suspend('switching').then(() => {
    assert.deepEqual(aborted, ['a-row'], 'B s transfer kept running');
    assert.equal(bControl.signal.aborted, false);
  });
});

test('a finished attempt is neither awaited nor aborted', () => {
  // `untrack` has to forget BOTH halves, and this fixture catches either one:
  // keep the settle and a switch waits forever on a transfer that has already
  // ended; keep the abort handle and the switch aborts a row that finished,
  // because this attempt's controller was never aborted.
  const a = createFilesMemory();
  const aborted: string[] = [];
  const control = new AbortController();
  control.signal.addEventListener('abort', () => aborted.push('r1'));
  a.track('r1', control, new Promise<void>(() => { /* never settles */ }));
  a.untrack('r1');
  a.abort('gone');                   // an unknown row is a no-op, not a throw
  return a.suspend('switching').then(() => {
    assert.deepEqual(aborted, [], 'the finished attempt was neither aborted nor awaited');
  });
});

test('an attempt that untracks itself on abort is still awaited', () => {
  // A CONSTRUCTED ordering, not a transcript of the component: the real
  // `finally` (Files.svelte) untracks and settles in the same synchronous
  // block, so there the snapshot is not what saves it. This fixture splits
  // those two steps — untrack synchronously on abort, settle later — because
  // that is the shape in which the rule is falsifiable at all: `suspend` must
  // snapshot the settles BEFORE aborting, or an abort that shortens the live
  // map leaves it waiting for nothing. The rule is cheap and the ordering it
  // protects against is one `await` away in any future download path.
  const a = createFilesMemory();
  let settle: () => void = () => {};
  const control = new AbortController();
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  control.signal.addEventListener('abort', () => { a.untrack('r1'); });
  a.track('r1', control, settled);

  let done = false;
  const suspending = a.suspend('switching').then(() => { done = true; });
  return Promise.resolve().then(() => Promise.resolve()).then(() => {
    assert.equal(done, false, 'it is waiting for an attempt that has already untracked itself');
    settle();
    return suspending;
  }).then(() => assert.equal(done, true));
});

test('resetting the browse positions does not forget a running transfer', () => {
  // A switch resets the positions AND suspends the transfers; whichever order
  // App calls them in, dropping the attempt bookkeeping would leave a running
  // download nobody can stop or wait for — and its part is the leaving
  // server's file.
  const a = createFilesMemory();
  const aborted: string[] = [];
  const control = new AbortController();
  control.signal.addEventListener('abort', () => aborted.push('r1'));
  a.track('r1', control, Promise.resolve());
  a.claim('part-1', { owner: {}, adopt() {} });

  a.reset();
  assert.ok(a.writerOf('part-1'), 'the part still has its writer');
  return a.suspend('switching').then(() => {
    assert.deepEqual(aborted, ['r1'], 'and the transfer could still be stopped and awaited');
  });
});

test('browser row ids are unique within a record', () => {
  // They need to be unique in the record that holds them and nowhere else:
  // two servers' rows live in two records.
  const a = createFilesMemory();
  const b = createFilesMemory();
  const ids = [a.nextWebRowId(), a.nextWebRowId(), a.nextWebRowId()];
  assert.equal(new Set(ids).size, 3, `${ids.join(' ')}`);
  assert.equal(b.nextWebRowId(), ids[0], 'and each record counts for itself');
});

test('a sealed record aborts an attempt that registers after the seal (board #335 ②b-2-3)', async () => {
  // `suspend` snapshots what is tracked when it is called, so an attempt
  // started in the gap would outlive the release. Sealing is the separate
  // first step that closes the gap.
  const m = createFilesMemory();
  const early = new AbortController();
  let earlyDone = () => {};
  m.track('early', early, new Promise<void>((r) => { earlyDone = r; }));
  m.seal('suspend');
  assert.equal(m.sealed(), true);
  const late = new AbortController();
  let lateDone = () => {};
  m.track('late', late, new Promise<void>((r) => { lateDone = r; }));
  assert.equal(late.signal.aborted, true, 'the late attempt is aborted the moment it registers');
  assert.equal(late.signal.reason, 'suspend');
  let released = false;
  const releasing = m.suspend('suspend').then(() => { released = true; });
  assert.equal(early.signal.aborted, true);
  await Promise.resolve();
  assert.equal(released, false, 'and the release waits for both to settle');
  earlyDone(); lateDone();
  await releasing;
  assert.equal(released, true);
  m.seal('other');
  assert.equal(m.sealed(), true, 'idempotent');
});
