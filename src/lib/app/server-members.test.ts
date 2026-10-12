// Background members (board #335 ③b-1): each joins on its own, through the
// bring-up's gates, and one failing, hanging or leaving never touches another.
import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as { $state?: unknown }).$state = (v: unknown) => v;
const { createMembers } = await import('./server-members.svelte.ts');
const { createActivations } = await import('./activation.ts');
import type { DialResult, ServerRuntime } from './server-runtime.ts';

type Fake = ServerRuntime & { answer(r: DialResult): void; answerFirst(r: DialResult): void; throws(): void; dials: number; owns: (() => boolean)[] };
const entry = (id: string) => ({ id, name: id, address: `ws://${id}:9899`, token: 't' });

function world(ids: string[]) {
  const runtimes = new Map<string, Fake>();
  const log: string[] = [];
  const wanted = new Set(ids);
  const saved = new Set(ids);
  let gate: (id: string) => 'ok' | 'claimed' | 'blocked' = () => 'ok';
  let blocks = true;
  const make = (id: string): Fake => {
    let resolve: (r: DialResult) => void = () => {};
    let reject: (e: Error) => void = () => {};
    const pending: ((r: DialResult) => void)[] = [];
    let alive = true;
    const rt = {
      id, dials: 0, owns: [] as (() => boolean)[],
      alive: () => alive,
      dial(owns?: () => boolean) { rt.dials++; rt.owns.push(owns ?? (() => true)); log.push(`dial:${id}`); return new Promise<DialResult>((r, j) => { resolve = r; reject = j; pending.push(r); }); },
      /** The LATEST dial answers. */
      answer(r: DialResult) { resolve(r); },
      /** The OLDEST dial still out answers (a stale one, late). */
      answerFirst(r: DialResult) { pending.shift()?.(r); },
      /** The dial's identity record throws. */
      throws() { reject(new Error('QuotaExceededError')); },
      detach() { alive = false; },
    } as unknown as Fake;
    return rt;
  };
  const activations = createActivations();
  const members = createMembers({
    include: (e) => { if (!saved.has(e.id)) return undefined; let rt = runtimes.get(e.id); if (!rt || !rt.alive()) { rt = make(e.id); runtimes.set(e.id, rt); } return rt; },
    gate: (id) => gate(id),
    activations,
    wanted: (id) => wanted.has(id),
    onUp: (rt) => log.push(`up:${rt.id}`),
    onBack: (rt) => log.push(`back:${rt.id}`),
    release: (rt) => { log.push(`release:${rt.id}`); (rt as Fake).detach(); },
    retry: (rt) => log.push(`retry:${rt.id}`),
    saved: (id) => saved.has(id),
    unrecorded: (rt) => { log.push(`unrecorded:${rt.id}`); return blocks; },
    hold: (rt) => log.push(`hold:${rt.id}`),
    detach: (rt) => { log.push(`detach:${rt.id}`); (rt as Fake).detach(); },
    orphaned: (rt, into) => log.push(`orphaned:${rt.id}:${into}`),
  });
  return { members, runtimes, log, wanted, saved, endAll: () => activations.endAll(), setGate: (g: typeof gate) => { gate = g; }, rt: (id: string) => runtimes.get(id)!,
    /** What the host gate answers for a failed identity record. */
    blocking: (b: boolean) => { blocks = b; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
const ok = (id: string): DialResult => ({ ok: true, entry: entry(id) as never });
const unreachable: DialResult = { ok: false, reason: 'failed', error: new Error('timeout') };

test('every included server joins in parallel: B hanging never holds C, and none of them writes the focus', async () => {
  const w = world(['a', 'b', 'c']);
  w.members.sync(['a', 'b', 'c'].map(entry));
  await settle();
  assert.deepEqual(w.log, ['dial:a', 'dial:b', 'dial:c'], 'all three dial at once');
  w.rt('c').answer(ok('c'));
  w.rt('a').answer(ok('a'));
  await settle();
  assert.deepEqual(w.members.runtimes().map((r) => r.id), ['a', 'c'], 'A and C are up while B still hangs');
  assert.equal(w.members.status('b')?.kind, 'connecting');
  assert.equal(w.members.status('c')?.kind, 'connected');
});

test('a member nobody answers keeps its runtime and its own loop retries it; the others are untouched', async () => {
  const w = world(['a', 'b']);
  w.members.sync(['a', 'b'].map(entry));
  await settle();
  w.rt('b').answer(unreachable);
  w.rt('a').answer(ok('a'));
  await settle();
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'unreachable' });
  assert.ok(w.log.includes('retry:b'), 'B s own loop takes over');
  assert.ok(!w.log.includes('release:b'), 'and B s runtime is kept for it');
  // The loop answers later: B is published through the same gate.
  w.members.answered(w.rt('b'), ok('b'));
  assert.ok(w.log.includes('up:b'));
  assert.equal(w.members.status('b')?.kind, 'connected');
});

test('excluding B mid-dial: its late answer publishes nothing and B is let go of; A is untouched', async () => {
  const w = world(['a', 'b']);
  w.members.sync(['a', 'b'].map(entry));
  await settle();
  w.wanted.delete('b');
  w.members.sync([entry('a')]);
  assert.ok(w.log.includes('release:b'), 'B was let go of at once');
  assert.equal(w.rt('b').owns[0]!(), false, 'B s dial no longer owns anything');
  w.rt('b').answer(ok('b'));
  w.rt('a').answer(ok('a'));
  await settle();
  assert.ok(!w.log.includes('up:b'), 'the late answer published nothing');
  assert.equal(w.members.status('b'), null, 'and B has no row');
  assert.deepEqual(w.members.runtimes().map((r) => r.id), ['a']);
});

test('a storage block at either gate publishes nothing; the next sync joins again', async () => {
  const w = world(['a']);
  w.setGate(() => 'blocked');
  w.members.sync([entry('a')]);
  await settle();
  assert.equal(w.log.length, 0, 'blocked before the dial: nothing dials');
  assert.deepEqual(w.members.status('a'), { kind: 'failed', reason: 'storage' });
  w.setGate(() => 'ok');
  w.members.sync([entry('a')]);
  await settle();
  // The dial proves the machine; the gate after it blocks.
  w.setGate(() => 'blocked');
  w.rt('a').answer(ok('a'));
  await settle();
  assert.ok(!w.log.includes('up:a'), 'blocked after the dial: not published');
  assert.ok(w.log.includes('release:a'));
  w.setGate(() => 'ok');
  w.members.sync([entry('a')]);
  await settle();
  w.rt('a').answer(ok('a'));
  await settle();
  assert.ok(w.log.includes('up:a'), 'Retry s sync brings it up');
});

test('an alias absorbed into its canonical entry leaves no row; two known entries on one machine fail with a name', async () => {
  const w = world(['alias', 'b']);
  w.members.sync(['alias', 'b'].map(entry));
  await settle();
  w.saved.delete('alias');                       // identity repair absorbed it
  w.rt('alias').answer({ ok: false, reason: 'elsewhere', entry: entry('canon') as never, machineId: 'm', hostname: 'h' });
  w.rt('b').answer({ ok: false, reason: 'elsewhere', entry: { ...entry('c'), name: 'gamma' } as never, machineId: 'm-c', hostname: 'h' });
  await settle();
  assert.equal(w.members.status('alias'), null, 'no permanent row for an entry that is gone');
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'elsewhere', detail: 'gamma' });
  w.members.sync(['b'].map(entry));
  await settle();
  assert.equal(w.rt('b').dials, 1, 'elsewhere waits for the person: sync does not redial it');
});

test('a published member s reconnect is reported, and leaving it ends its loop s answer', async () => {
  const w = world(['a']);
  w.members.sync([entry('a')]);
  await settle();
  w.rt('a').answer(ok('a'));
  await settle();
  const rt = w.rt('a');
  w.members.reconnecting(rt);
  assert.equal(w.members.status('a')?.kind, 'reconnecting');
  w.members.answered(rt, ok('a'));
  assert.ok(w.log.includes('back:a'), 'its comeback is told to App');
  assert.equal(w.members.status('a')?.kind, 'connected');
  w.members.leave('a');
  w.members.answered(rt, ok('a'));
  assert.equal(w.members.status('a'), null, 'a left member s late answer writes nothing');
  assert.equal(w.members.runtimes().length, 0);
});

test('a join whose identity record throws goes to the host gate: blocked, it keeps nothing and the next sync joins again; not blocked, it retries (reviewer P1 on 453f02b8)', async () => {
  const w = world(['b', 'c']);
  w.members.sync([entry('b'), entry('c')]);
  w.rt('b').throws();
  await settle();
  assert.ok(w.log.includes('unrecorded:b'), 'the host gate was asked');
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'storage' });
  assert.ok(w.log.includes('release:b') && !w.members.holds(w.rt('b')), 'and B s runtime is let go of');
  assert.deepEqual(w.members.status('c'), { kind: 'connecting' }, 'C is untouched');
  w.members.sync([entry('b'), entry('c')]);                       // Retry
  assert.equal(w.rt('b').dials, 1, 'a fresh runtime dials again');
  w.blocking(false);
  w.rt('c').throws();
  await settle();
  assert.deepEqual(w.members.status('c'), { kind: 'failed', reason: 'unreachable' }, 'not a block: one more unanswered dial');
  assert.ok(w.log.includes('retry:c') && w.members.holds(w.rt('c')), 'its own loop retries it');
});

test('a published member s reconnect passes the post-dial gate: refused, its socket is held for Retry and nothing comes back (reviewer P1 on 453f02b8)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  w.rt('b').answer(ok('b'));
  await settle();
  assert.deepEqual(w.members.runtimes().map((r) => r.id), ['b']);
  w.setGate(() => 'blocked');
  w.members.answered(w.rt('b'), ok('b'));                          // its loop answered
  assert.ok(w.log.includes('hold:b') && !w.log.includes('back:b'), `held, not brought back: ${w.log.join(',')}`);
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'storage' });
  assert.deepEqual(w.members.runtimes().map((r) => r.id), ['b'], 'still published: its tree stays');
  w.setGate(() => 'ok');
  w.members.resume();                                              // Retry
  assert.ok(w.log.includes('retry:b'), 'Retry redials it');
  w.members.answered(w.rt('b'), ok('b'));
  assert.ok(w.log.includes('back:b'));
  assert.deepEqual(w.members.status('b'), { kind: 'connected' });
});

test('resume redials only published members that are not answering (reviewer P1 on 453f02b8)', async () => {
  const w = world(['b', 'c']);
  w.members.sync([entry('b'), entry('c')]);
  w.rt('b').answer(ok('b')); w.rt('c').answer(ok('c'));
  await settle();
  w.members.blocked(w.rt('b'));                                    // B s socket closed during the block
  w.members.resume();
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b'], 'C was answering: left alone');
  assert.deepEqual(w.members.status('b'), { kind: 'reconnecting' });
});

test('a focus move hands a published member to the window and takes the old focus in, dialling nothing (#335 ③b-2, D2)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  w.rt('b').answer(ok('b'));
  await settle();
  const b = w.rt('b');
  const a = { id: 'a', alive: () => true } as unknown as ServerRuntime;
  assert.equal(w.members.handOver(b), true, 'B leaves the set');
  assert.equal(w.members.holds(b), false);
  assert.deepEqual(w.members.runtimes(), []);
  assert.equal(w.members.status('b'), null, 'with no row of its own: it is the focus');
  w.members.adopt(a, true);
  assert.equal(w.members.holds(a), true, 'A is a member now');
  assert.deepEqual(w.members.runtimes(), [a], 'published');
  assert.deepEqual(w.members.status('a'), { kind: 'connected' });
  assert.ok(!w.log.some((e) => e.startsWith('release:')), 'nothing was let go of');
  assert.equal(w.log.filter((e) => e.startsWith('dial:')).length, 1, 'and only B s join dialled');
  // A sync that wants A keeps it as it is — no second dial.
  w.members.sync([entry('a')]);
  await settle();
  assert.equal(w.log.filter((e) => e.startsWith('dial:')).length, 1);
  assert.ok(w.log.includes('release:b') === false, 'B is not let go of: the window owns it');
});

test('a member not published yet is not handed over', () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  assert.equal(w.members.handOver(w.rt('b')), false, 'still joining: not a focus move');
  assert.equal(w.members.holds(w.rt('b')), true);
});

test('Retry joins again a member whose join a block made stale, even with its handle alive; the stale answer undoes nothing (reviewer P1 on 97824925)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  const b = w.rt('b');
  assert.equal(b.dials, 1, 'B s join is out');
  // The block: every attempt in flight ends (holdStorage's endAll).
  assert.equal(b.owns[0]!(), true);
  w.endAll();
  assert.equal(b.owns[0]!(), false, 'the join is nobody s now');
  // Retry's sync, BEFORE the stale answer arrives: B is alive and not
  // published, and it is joined again on the same handle.
  w.members.sync([entry('b')]);
  assert.equal(w.rt('b'), b, 'the same handle');
  assert.equal(b.dials, 2, 'dialled again');
  // The OLD dial answers now, late: it concludes nothing and lets go of
  // nothing — the new join owns B.
  b.answerFirst(ok('b'));
  await settle();
  assert.ok(!w.log.includes('release:b'), 'the stale answer did not let B go');
  assert.equal(w.members.holds(b), true);
  b.answer(ok('b'));
  await settle();
  assert.deepEqual(w.members.runtimes(), [b], 'the new join publishes B');
  assert.equal(w.log.filter((e) => e === 'up:b').length, 1, 'once');
});

test('a published member whose reconnect reaches another known machine becomes an ORPHAN: detached now, kept until dismissed (reviewer P1-5 on 3a0b4feb)', async () => {
  const w = world(['b', 'd']);
  w.members.sync([entry('b')]);
  w.rt('b').answer(ok('b'));
  await settle();
  const b = w.rt('b');
  w.members.answered(b, { ok: false, reason: 'elsewhere', entry: entry('d') as never, machineId: 'm-d', hostname: 'd.host' });
  assert.deepEqual(w.log.filter((e) => /detach|orphaned|release/u.test(e)), ['detach:b', 'orphaned:b:d'], 'detached and reported, not released');
  assert.equal(w.members.orphan(b), true);
  assert.deepEqual(w.members.status('b'), { kind: 'orphan', into: 'd' });
  assert.deepEqual(w.members.runtimes(), [b], 'still a published tree');
  // A sync that still wants B (its entry is saved) does not join over the
  // orphan; a sync that no longer wants it does not leave it either.
  w.members.sync([entry('b')]);
  assert.equal(b.dials, 1, 'no new dial over the orphan');
  w.members.sync([]);
  assert.equal(w.members.orphan(b), true, 'kept');
  assert.ok(!w.log.some((e) => e === 'release:b'));
  assert.equal(w.members.handOver(b), false, 'an orphan cannot become the focus');
  w.members.dismiss(b);
  assert.ok(w.log.includes('release:b'), 'dismissed: let go of');
  assert.deepEqual(w.members.runtimes(), []);
  assert.equal(w.members.status('b'), null);
});

test('a published member whose entry was absorbed (no longer saved) becomes an orphan on sync, not a leave', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  w.rt('b').answer(ok('b'));
  await settle();
  const b = w.rt('b');
  w.saved.delete('b');
  w.members.sync([]);
  assert.equal(w.members.orphan(b), true);
  assert.deepEqual(w.members.status('b'), { kind: 'orphan', into: '' });
  assert.ok(w.log.includes('detach:b') && !w.log.includes('release:b'), 'detached, not released');
  w.members.dismiss(b);
  assert.ok(w.log.includes('release:b'));
});

test('an UNPUBLISHED member that answers elsewhere or gone has no tree to keep: let go as before', async () => {
  const w = world(['b', 'd']);
  w.members.sync([entry('b')]);
  const b = w.rt('b');
  b.answer({ ok: false, reason: 'elsewhere', entry: entry('d') as never, machineId: 'm-d', hostname: 'd.host' });
  await settle();
  assert.ok(w.log.includes('release:b'));
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'elsewhere', detail: 'd' });
  assert.equal(w.members.orphan(b), false);
});
