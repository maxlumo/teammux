// Background members (board #335 ③b-1): each joins on its own, through the
// bring-up's gates, and one failing, hanging or leaving never touches another.
import test from 'node:test';
import assert from 'node:assert/strict';
(globalThis as { $state?: unknown }).$state = (v: unknown) => v;
const { createMembers } = await import('./server-members.svelte.ts');
const { createRefusedAttempts } = await import('./refused-attempts.ts');
type RefusedAttempts = ReturnType<typeof createRefusedAttempts>;
const { createActivations } = await import('./activation.ts');
import type { DialResult, ServerRuntime } from './server-runtime.ts';

type Fake = ServerRuntime & { answer(r: DialResult): void; answerFirst(r: DialResult): void; throws(): void; dials: number; owns: (() => boolean)[]; vias: string[]; tokens: (string | undefined)[] };
const entry = (id: string) => ({ id, name: id, address: `ws://${id}:9899`, token: 't' });

function world(ids: string[], refusals?: RefusedAttempts) {
  const runtimes = new Map<string, Fake>();
  const log: string[] = [];
  const wanted = new Set(ids);
  const saved = new Set(ids);
  let gate: (id: string) => 'ok' | 'claimed' | 'blocked' = () => 'ok';
  let blocks = true;
  /** Ids whose socket is up, and ids whose own reconnect loop is running. */
  const up = new Set<string>();
  const looping = new Set<string>();
  /** A saved entry's token, as the person last edited it. */
  const tokens = new Map<string, string>();
  /** A saved entry's active address, as the person last edited it. */
  const addresses = new Map<string, string>();
  /** A machine's other addresses (the failover set). */
  const alternates = new Map<string, string[]>();
  const make = (id: string): Fake => {
    let resolve: (r: DialResult) => void = () => {};
    let reject: (e: Error) => void = () => {};
    const pending: ((r: DialResult) => void)[] = [];
    let alive = true;
    const rt = {
      id, dials: 0, owns: [] as (() => boolean)[], vias: [] as string[], tokens: [] as (string | undefined)[],
      alive: () => alive,
      dial(owns?: () => boolean, how?: { via?: string; token?: string }) { rt.dials++; rt.vias.push(how?.via ?? ''); rt.tokens.push(how?.token); rt.owns.push(owns ?? (() => true)); log.push(`dial:${id}`); return new Promise<DialResult>((r, j) => { resolve = r; reject = j; pending.push(r); }); },
      /** The LATEST dial answers. */
      answer(r: DialResult) { resolve(r); },
      /** The OLDEST dial still out answers (a stale one, late). */
      answerFirst(r: DialResult) { pending.shift()?.(r); },
      /** The dial's identity record throws. */
      throws() { reject(new Error('QuotaExceededError')); },
      detach() { alive = false; },
      connection: { isConnected: () => up.has(id) },
      entry: () => ({ ...entry(id), address: addresses.get(id) ?? `ws://${id}:9899`, token: tokens.get(id) ?? 't' }),
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
    retry: (rt) => { log.push(`retry:${rt.id}`); looping.add(rt.id); },
    trying: (rt) => looping.has(rt.id),
    ...(refusals ? { refusals } : {}),
    target: (id) => ({ address: addresses.get(id) ?? `ws://${id}:9899`, token: tokens.get(id) ?? 't', alternates: alternates.get(id) ?? [] }),
    saved: (id) => saved.has(id),
    unrecorded: (rt) => { log.push(`unrecorded:${rt.id}`); return blocks; },
    hold: (rt) => log.push(`hold:${rt.id}`),
    detach: (rt) => { log.push(`detach:${rt.id}`); (rt as Fake).detach(); },
    orphaned: (rt, into) => log.push(`orphaned:${rt.id}:${into}`),
  });
  return { members, runtimes, log, wanted, saved, up, looping, tokens, addresses, alternates, endAll: () => activations.endAll(), setGate: (g: typeof gate) => { gate = g; }, rt: (id: string) => runtimes.get(id)!,
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

test('an orphan s late answer concludes nothing — not a leave, whoever is wanted now (reviewer P1-A on e0dafe3c)', async () => {
  // B is published and orphaned (absorbed). Its reconnect, out when it was,
  // answers late: `answered` used to test `wanted` first — false for an
  // orphan — and LEAVE it, ending the kept tree unasked. And when the
  // absorption moved CURRENT onto B itself (the canonical the focus handed
  // over to), the same test dropped the new focus from the set.
  const w = world(['b']);
  w.members.sync([entry('b')]);
  w.rt('b').answer(ok('b'));
  await settle();
  const b = w.rt('b');
  assert.equal(w.members.absorbed(b), true);
  assert.deepEqual(w.log.filter((e) => /detach|orphaned|release/u.test(e)), ['detach:b', 'orphaned:b:']);
  w.wanted.delete('b');
  w.members.answered(b, ok('b'));
  assert.equal(w.members.orphan(b), true, 'still an orphan');
  assert.ok(!w.log.includes('release:b'), 'not released by the late answer');
  assert.deepEqual(w.members.runtimes(), [b], 'its tree is still held');
  w.members.answered(b, { ok: false, reason: 'elsewhere', entry: entry('d') as never, machineId: 'm-d', hostname: 'd' });
  assert.equal(w.members.orphan(b), true);
  assert.ok(!w.log.includes('release:b'));
  w.members.dismiss(b);
  assert.ok(w.log.includes('release:b'), 'only the person s answer lets it go');
});

// ---- #458: the person's pick is the ONE explicit retry door ----

test('a pick during the first join or a running loop dials nothing new; a stopped loop gets exactly one fresh loop (#458 P1-B)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  await settle();
  assert.equal(w.members.ask('b'), 'trying', 'its first join is in flight');
  assert.equal(w.rt('b').dials, 1, 'no second dial');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), [], 'and no loop started beside the join');
  w.rt('b').answer(unreachable);
  await settle();
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b'], 'the join failed: its own loop took over');
  assert.equal(w.members.ask('b'), 'trying', 'a pick while the loop runs');
  assert.equal(w.members.ask('b'), 'trying', 'and another');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b'], 'neither restarts nor extends the loop');
  // The loop gives up.
  w.looping.delete('b'); w.members.gaveUp(w.rt('b'));
  assert.equal(w.members.status('b')?.kind, 'failed');
  assert.equal(w.members.ask('b'), 'started', 'a pick after the give-up');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b', 'retry:b'], 'exactly one fresh loop');
  assert.equal(w.members.status('b')?.kind, 'connecting', 'and the row says it is trying again');
  assert.equal(w.members.ask('b'), 'trying', 'a second pick while that loop runs adds nothing');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b', 'retry:b']);
});

test('a pick does not dial past a refusal the app keeps: storage, another known machine, an orphan, nothing held (#458 P1-B)', async () => {
  const w = world(['a', 'b', 'c']);
  w.members.sync(['a', 'b'].map(entry));
  await settle();
  w.members.blocked(w.rt('a'));
  assert.equal(w.members.ask('a'), 'refused', 'storage');
  w.rt('b').answer({ ok: false, reason: 'elsewhere', entry: entry('c') } as never);
  await settle();
  assert.equal(w.members.ask('b'), 'refused', 'reached another known machine');
  assert.equal(w.members.ask('c'), 'refused', 'not held at all');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), [], 'nothing dialled');
});

test('a pick of a member that is up says so and dials nothing (#458)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  await settle();
  w.up.add('b'); w.rt('b').answer(ok('b'));
  await settle();
  assert.equal(w.members.ask('b'), 'connected');
  assert.equal(w.rt('b').dials, 1);
});

const authRefused = async (address: string, token: string) => {
  const { ERR_AUTH } = await import('../core/rpc-codes.ts');
  return { ok: false as const, reason: 'failed' as const, error: Object.assign(new Error('invalid proof'), { code: ERR_AUTH }), tried: { address, token } };
};
const B = 'ws://b:9899';

test('a token refusal is terminal for the retry door: three picks dial nothing; an edited token may be tried once (#458 validator V1)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(await authRefused(B, 't'));
  await settle();
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'auth' }, 'its own state, not "not answering"');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), [], 'no loop after a refusal');
  for (let i = 0; i < 3; i++) assert.equal(w.members.ask('b'), 'token');
  assert.equal(w.rt('b').dials, 1, 'three picks: nothing dialled');
  w.tokens.set('b', 't2');
  assert.equal(w.members.ask('b'), 'started', 'an edited token is another attempt');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b']);
});

test('a loop that stopped on a token refusal is the same terminal state (#458 validator V1)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(unreachable);
  await settle();
  w.looping.delete('b'); w.members.refusedBy(w.rt('b'), { address: B, token: 't' }); w.members.gaveUp(w.rt('b'), 'auth');
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'auth' });
  assert.equal(w.members.ask('b'), 'token');
  assert.deepEqual(w.log.filter((l) => l.startsWith('retry:')), ['retry:b'], 'only the join failure s loop; the pick adds nothing');
});

test('a refused attempt is one eligibility fact for EVERY dial entry: repeated syncs, a block then ask (#458 review on the token state, P1-A)', async () => {
  const w = world(['a', 'b']);
  w.members.sync(['a', 'b'].map(entry));
  await settle();
  w.rt('b').answer(await authRefused(B, 't'));
  w.up.add('a'); w.rt('a').answer(ok('a'));
  await settle();
  const dials = w.rt('b').dials;
  for (let i = 0; i < 3; i++) { w.members.sync(['a', 'b'].map(entry)); await settle(); }
  assert.equal(w.rt('b').dials, dials, 'three syncs: no dial');
  w.members.blocked(w.rt('b'));
  assert.equal(w.members.ask('b'), 'token', 'a block s status does not forget the refusal');
  assert.equal(w.rt('b').dials, dials);
});

test('a PUBLISHED member whose reconnect was refused: a storage block and Retry (resume) never redial it (#458 review on the token state, P1-A)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  await settle();
  w.up.add('b'); w.rt('b').answer(ok('b'));
  await settle();
  w.up.delete('b');
  w.members.reconnecting(w.rt('b'));
  w.members.refusedBy(w.rt('b'), { address: B, token: 't' });
  w.members.gaveUp(w.rt('b'), 'auth');
  w.members.blocked(w.rt('b'));
  const before = w.log.filter((l) => l === 'retry:b').length;
  w.members.resume();
  assert.equal(w.log.filter((l) => l === 'retry:b').length, before, 'Retry redials what is not answering, never a refused attempt');
});

test('a refusal belongs to the ATTEMPT: T1 in flight, edited to T2, T1 refused — T2 may be tried; back to T1, it is not resent (#458 review, P1-B)', async () => {
  const w = world(['b']);
  w.members.sync([entry('b')]);
  await settle();
  w.tokens.set('b', 't2');
  w.rt('b').answer(await authRefused(B, 't'));
  await settle();
  assert.deepEqual(w.log.filter((l) => l === 'retry:b'), ['retry:b'], 'T2 was never refused: its loop tries it, as after any failed join');
  assert.equal(w.members.ask('b'), 'trying', 'and a pick adds nothing');
  w.looping.delete('b');
  w.tokens.set('b', 't');
  w.members.gaveUp(w.rt('b'));
  assert.equal(w.members.ask('b'), 'token', 'T1 at B was refused: not sent again');
});

test('a refusal is of the (address, token) pair: an ALTERNATE address that refused does not block the correct one; a fixed address with the same token dials once, the old pair never (#458 ruling P1-B)', async () => {
  const w = world(['b']);
  w.addresses.set('b', 'ws://wrong:9899');
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(await authRefused('ws://wrong:9899', 't'));
  await settle();
  assert.equal(w.members.ask('b'), 'token', 'the wrong address with T: not resent');
  w.members.sync([entry('b')]); await settle();
  assert.equal(w.rt('b').dials, 1, 'nor by a sync');
  // The person fixes the address; the token is unchanged.
  w.addresses.set('b', 'ws://b:9899');
  assert.equal(w.members.ask('b'), 'started', 'the fixed address with the same token: one explicit attempt');
});

/** Web Crypto answers on the real event loop: give it real time. */
const digestSettle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10)); };

test('the refused attempts outlive a reload, as SHA-256 digests; after the reload the member is still choosable, and an edited token joins (#458 ruling P1-A)', async () => {
  const box: { stored: string | null } = { stored: null };
  const store = () => createRefusedAttempts({
    read: () => box.stored, write: (t) => { box.stored = t; }, failed: () => { throw new Error('unexpected write failure'); }, ready: () => {},
    digest: async (text) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex'),
  });
  const first = world(['b'], store());
  first.members.sync([entry('b')]);
  await settle();
  first.rt('b').answer(await authRefused(B, 't'));
  await digestSettle();
  const kept = box.stored ?? '';
  assert.ok(kept && JSON.parse(kept).b?.length === 1, 'kept for the next page');
  assert.ok(!kept.includes('"t"') && !kept.includes(B), 'a digest, never the token or the address');
  // The reload.
  const second = world(['b'], store());
  second.members.sync([entry('b')]);
  await digestSettle();
  second.members.sync([entry('b')]);                  // its digest is ready: ask again
  await digestSettle();
  assert.equal(second.runtimes.get('b')?.dials ?? 0, 0, 'the refused attempt is not sent after the reload');
  assert.deepEqual(second.members.status('b'), { kind: 'failed', reason: 'auth' });
  assert.equal(second.members.ask('b'), 'token', 'and the member is still choosable: the pick records, dials nothing');
  second.tokens.set('b', 't2');
  assert.equal(second.members.ask('b'), 'held', 'an edited token: its comparison is still out, so nothing dials yet');
  assert.equal(second.runtimes.get('b')?.dials ?? 0, 0);
  await digestSettle();
  assert.equal(second.members.ask('b'), 'started', 'compared and not refused: it joins');
  await settle();
  assert.equal(second.rt('b').dials, 1);
});

test('a stored fact that cannot be COMPARED (no Web Crypto) is UNKNOWN, not "no refusal": nothing dials it, a pick included; an edited token is the repair; an unreadable one is reset and dials (#458 ruling P2, P1-B; V4)', async () => {
  const unreadable = createRefusedAttempts({ read: () => '{not json', write: () => {}, aside: () => {}, failed: () => {}, ready: () => {} });
  const v = world(['b'], unreadable);
  v.members.sync([entry('b')]);
  await settle();
  assert.equal(v.rt('b').dials, 1, 'an unreadable store is a corruption, reset: B is dialled as on a fresh device');
  const incomparable = createRefusedAttempts({ read: () => JSON.stringify({ b: ['ab'.repeat(32)] }), write: () => {}, failed: () => {}, ready: () => {} });
  const w = world(['b'], incomparable);
  w.members.sync([entry('b')]);
  await settle();
  assert.equal(w.runtimes.get('b')?.dials ?? 0, 0, 'fail closed: nothing dials');
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'unknown' });
  for (let i = 0; i < 3; i++) assert.equal(w.members.ask('b'), 'held', 'the pick records, and dials nothing');
  assert.equal(w.runtimes.get('b')?.dials ?? 0, 0);
  w.tokens.set('b', 't2');
  assert.equal(w.members.ask('b'), 'started', 'an edited token is a new declaration');
  await settle();
  assert.equal(w.rt('b').dials, 1, 'once');
});

test('a held digest, a pick before it is compared, then a match: zero dials throughout (#458 ruling P1-B)', async () => {
  const sha = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  const stored = JSON.stringify({ b: [await sha(`${B}\u0000t`)] });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held = createRefusedAttempts({
    read: () => stored, write: () => {}, failed: () => {}, ready: () => {},
    digest: async (text) => { await gate; return sha(text); },
  });
  const w = world(['b'], held);
  w.members.sync([entry('b')]);
  await settle();
  assert.equal(w.runtimes.get('b')?.dials ?? 0, 0, 'pending: not dialled');
  assert.deepEqual(w.members.status('b'), { kind: 'connecting' }, 'not decided yet: neither refused nor unknown');
  assert.equal(w.members.ask('b'), 'held', 'a pick while the comparison is out records, dials nothing');
  assert.equal(w.members.ask('b'), 'held');
  release();
  await digestSettle();
  w.members.sync([entry('b')]);                       // the digest came: ask again
  await settle();
  assert.equal(w.runtimes.get('b')?.dials ?? 0, 0, 'the match is a refusal: still no dial');
  assert.equal(w.members.ask('b'), 'token');
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'auth' });
});

test('a write of a refusal that fails reaches the storage error handling (#458 ruling P2)', async () => {
  let failed = 0;
  const broken = createRefusedAttempts({
    read: () => null, write: () => { throw new Error('QuotaExceededError'); }, failed: () => { failed++; }, ready: () => {},
    digest: async () => 'd',
  });
  const w = world(['b'], broken);
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(await authRefused(B, 't'));
  await settle(); await settle();
  assert.equal(failed, 1, 'said to the caller');
  assert.equal(w.members.ask('b'), 'token', 'and still known for this page');
});

test('one refused pair takes out that pair, never the member: B1 refused T, B2 is tried with T — by the join, after a sync, and by a pick (#458 validator V3)', async () => {
  const w = world(['b']);
  w.alternates.set('b', ['ws://b2:9899']);
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(await authRefused(B, 't'));         // B1 (the primary) refused T
  await settle();
  // B2 is still a candidate: the member is not refused, and its loop tries what is left.
  assert.deepEqual(w.log.filter((l) => l === 'retry:b'), ['retry:b'], 'its own loop, as after any failed join');
  assert.notDeepEqual(w.members.status('b'), { kind: 'failed', reason: 'auth' }, 'not shown as refused');
  assert.equal(w.members.ask('b'), 'trying', 'a pick adds nothing to it');
  w.looping.delete('b'); w.members.gaveUp(w.rt('b'));
  assert.equal(w.members.ask('b'), 'started', 'once that loop stopped, a pick runs the connect flow over what is left');
  // A fresh member set (a reload with the refusal in memory): the join goes to B2, never B1.
  const store = createRefusedAttempts({ read: () => null, write: () => {}, failed: () => {}, ready: () => {} });
  store.add('b', B, 't');
  const v = world(['b'], store);
  v.alternates.set('b', ['ws://b2:9899']);
  v.members.sync([entry('b')]);
  await settle();
  assert.deepEqual(v.rt('b').vias, ['ws://b2:9899'], 'the join dials B2 with T; B1 is never re-sent');
  // Both refused: now the member is.
  store.add('b', 'ws://b2:9899', 't');
  v.rt('b').answer(await authRefused('ws://b2:9899', 't'));
  await settle();
  assert.equal(v.members.ask('b'), 'token', 'every pair refused: the member is');
  assert.equal(v.rt('b').dials, 1);
});

test('a member WITH a slot whose new pair is still being compared: a pick records, dials nothing (#458 ruling P1-B)', async () => {
  const sha = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let slow = false;
  const store = createRefusedAttempts({
    read: () => null, write: () => {}, failed: () => {}, ready: () => {},
    digest: async (text) => { if (slow) await gate; return sha(text); },
  });
  const w = world(['b'], store);
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(await authRefused(B, 't'));          // refused in this session: the slot is kept
  await digestSettle();
  slow = true;
  w.tokens.set('b', 't2');                              // a new pair, its digest held
  assert.equal(w.members.ask('b'), 'held', 'compared yet? no: the pick is held');
  // Its stopped loop is started to WAIT (ruling on f20d1ea0): the loop dials
  // nothing while its set is pending (reconnect.test.ts), and the digest's
  // result reaches it by wake(), which a sync would not (it skips slots).
  assert.deepEqual(w.log.filter((l) => l === 'retry:b'), ['retry:b'], 'one loop, started to wait');
  assert.equal(w.members.ask('b'), 'held', 'a second pick while it waits starts nothing more');
  assert.deepEqual(w.log.filter((l) => l === 'retry:b'), ['retry:b']);
  release();
});

// ---- #458 ruling on f20d1ea0: a member's state is its candidate SET's ----
/** A store whose digest for one pair is held until released. */
function heldDigest(holdPair: (text: string) => boolean) {
  const sha = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let readies = 0;
  let stored: string | null = null;
  const store = () => createRefusedAttempts({
    read: () => stored, write: (t) => { stored = t; }, failed: () => {}, ready: () => { readies++; },
    digest: async (text) => { if (holdPair(text)) await gate; return sha(text); },
  });
  return { store, release: () => release(), readies: () => readies };
}

test('a join refused at B1 while B2 is still compared: not "token refused" — the member keeps trying and its loop waits (#458 ruling on f20d1ea0)', async () => {
  const B2 = 'ws://b2:9899';
  const d = heldDigest((text) => text.startsWith(B2));
  // Session 1 records a refusal for b, so session 2 compares every pair.
  const first = world(['b'], d.store());
  first.members.sync([entry('b')]);
  await settle();
  first.rt('b').answer(await authRefused('ws://old:9899', 't'));
  await digestSettle();
  const w = world(['b'], d.store());
  w.alternates.set('b', [B2]);
  // B1's digest is ready once asked; B2's is held.
  w.members.sync([entry('b')]);
  await digestSettle();
  w.members.sync([entry('b')]);
  await settle();
  assert.equal(w.rt('b').dials, 1, 'B1 dialled (decided ok)');
  w.rt('b').answer(await authRefused(B, 't'));
  await settle();
  assert.deepEqual(w.members.status('b'), { kind: 'connecting' }, 'B2 is still compared: the member is trying, not refused');
  assert.deepEqual(w.log.filter((l) => l === 'retry:b'), ['retry:b'], 'its own loop is started, to wait for B2');
  d.release();
});

test('a loop s refusal at one pair (refusedBy) sets the member from its set: an ok sibling keeps it reconnecting; all refused is auth; a fact that cannot be compared is unknown (#458 ruling on f20d1ea0)', async () => {
  const B2 = 'ws://b2:9899';
  const w = world(['b']);
  w.alternates.set('b', [B2]);
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(ok('b'));
  await settle();
  w.members.reconnecting(w.rt('b'));
  w.members.refusedBy(w.rt('b'), { address: B, token: 't' });
  assert.deepEqual(w.members.status('b'), { kind: 'reconnecting' }, 'B2 still ok: one pair refused is not the member');
  w.members.refusedBy(w.rt('b'), { address: B2, token: 't' });
  assert.deepEqual(w.members.status('b'), { kind: 'failed', reason: 'auth' }, 'every pair refused: the member is');

  const v = world(['b'], createRefusedAttempts({ read: () => JSON.stringify({ b: ['ab'.repeat(32)] }), write: () => {}, failed: () => {}, ready: () => {} }));
  v.alternates.set('b', [B2]);
  v.members.sync([entry('b')]);
  await settle();
  assert.deepEqual(v.members.status('b'), { kind: 'failed', reason: 'unknown' }, 'a stored fact it cannot compare (no Web Crypto): unknown, no dial');
  assert.equal(v.runtimes.get('b'), undefined);
});

test('Retry s resume starts the loop of a published member whose set is pending (it waits), and skips one that is refused (#458 ruling on f20d1ea0)', async () => {
  const d = heldDigest((text) => text.includes('t2'));
  const first = world(['b'], d.store());
  first.members.sync([entry('b')]);
  await settle();
  first.rt('b').answer(await authRefused('ws://old:9899', 't'));
  await digestSettle();
  const w = world(['b'], d.store());
  w.members.sync([entry('b')]);
  await digestSettle();
  w.members.sync([entry('b')]);
  await settle();
  w.rt('b').answer(ok('b'));
  await settle();
  w.members.gaveUp(w.rt('b'));                        // its loop gave up (unreachable)
  w.tokens.set('b', 't2');                            // a new pair, its digest held
  w.members.resume();
  assert.deepEqual(w.log.filter((l) => l === 'retry:b'), ['retry:b'], 'pending: its loop is started to wait for the comparison');
  d.release();
});

test('a digest that cannot be computed is unknown, reported by ready(), never "still computing" (#458 review P2 on f20d1ea0)', async () => {
  let readies = 0;
  const sha = async (text: string) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  const stored = JSON.stringify({ b: [await sha('ws://x:9899\u0000t')] });
  const store = createRefusedAttempts({
    read: () => stored, write: () => {}, failed: () => {}, ready: () => { readies++; },
    digest: async (text) => { if (text.startsWith(B)) throw new Error('OperationError'); return sha(text); },
  });
  assert.equal(store.check('b', B, 't'), 'pending', 'asked: being computed');
  await digestSettle();
  assert.equal(readies, 1, 'the failure is reported like a result');
  assert.equal(store.check('b', B, 't'), 'unknown', 'and the pair is unknown from then on');
  store.check('b', 'ws://x:9899', 't');
  await digestSettle();
  assert.equal(store.check('b', 'ws://x:9899', 't'), 'refused', 'another pair of the same server is still compared');
});

test('candidateVerdict is the one reading of a set: any ok → ok; else any pending → pending; all refused → refused; else unknown (#458 ruling on f20d1ea0)', async () => {
  const { candidateVerdict } = await import('./refused-attempts.ts');
  const rows: [Parameters<typeof candidateVerdict>[0], string][] = [
    [['refused', 'ok'], 'ok'], [['pending', 'ok'], 'ok'], [['unknown', 'ok'], 'ok'],
    [['refused', 'pending'], 'pending'], [['unknown', 'pending'], 'pending'],
    [['refused', 'refused'], 'refused'], [['refused'], 'refused'],
    [['refused', 'unknown'], 'unknown'], [['unknown'], 'unknown'], [[], 'unknown'],
  ];
  for (const [states, want] of rows) assert.equal(candidateVerdict(states), want, states.join('+'));
});

test('a join dials with the token its check read — the checked pair is the dialled pair (#458 ruling on 77e1185d)', async () => {
  const w = world(['b']);
  w.alternates.set('b', ['ws://b2:9899']);
  w.tokens.set('b', 't-now');
  w.members.sync([entry('b')]);
  await settle();
  assert.deepEqual(w.rt('b').tokens, ['t-now'], 'the token it checked, handed to the dial');
});
