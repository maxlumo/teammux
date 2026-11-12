// Board #107: the room's ask rows — read, closed, refused and repainted from the server's
// answer, and a late read of another room dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).$state = (v: unknown) => v;
const { AskBook, isAsk, closingSeq, askerState, deliveryWord } = await import('./asks.svelte.ts');

const row = (seq: number, patch: Record<string, unknown> = {}) => ({
  seq, room: 'proj:p', ts: 1, asker: 'lead', question: 'q', options: [{ key: 'A', label: 'a' }, { key: 'B', label: 'b' }],
  recommend: 'A', issue: null, state: 'open', closed_seq: null, closed_at: null, answer_key: null, said: null, closing: null, delivery: null, ...patch,
});

/** One server's asks, shared by two clients: the first close applies, a later one is
 * refused with the winner's row (asks.md § One transaction closes it). */
function server() {
  const asks = new Map<number, any>([[7, row(7)]]);
  const close = (seq: number, patch: Record<string, unknown>) => {
    const a = asks.get(seq)!;
    if (a.state !== 'open') return { applied: false, refused: 'already answered at 08:41', ask: a };
    const next = { ...a, ...patch, closed_at: 2, delivery: 'found' };
    asks.set(seq, next);
    return { applied: true, ask: next };
  };
  return {
    asks,
    api: {
      hubAskList: async () => ({ asks: [...asks.values()] }),
      hubAskAnswer: async (_s: string, seq: number, option?: string, text?: string) => close(seq, { state: 'answered', answer_key: option ?? null, said: [option, text].filter(Boolean).join(' — ') }),
      hubAskDismiss: async (_s: string, seq: number) => close(seq, { state: 'dismissed', said: 'dismissed: I will not answer this' }),
    },
  };
}

test('two clients answer at once: one applies, the other is refused and repaints with the winner', async () => {
  const s = server();
  const one = new AskBook(s.api);
  const two = new AskBook(s.api);
  await one.load('p');
  await two.load('p');
  assert.equal(one.rows[7]!.state, 'open');
  await Promise.all([one.answer(7, 'A'), two.answer(7, 'B')]);
  assert.equal(one.rows[7]!.answer_key, 'A');
  assert.equal(one.refused[7], undefined, 'the winner is not refused');
  assert.equal(two.rows[7]!.answer_key, 'A', 'the loser shows the winner\'s answer');
  assert.equal(two.refused[7], 'already answered at 08:41');
  assert.equal(s.asks.get(7).answer_key, 'A', 'one close on the server');
  await two.dismiss(7);
  assert.equal(two.rows[7]!.state, 'answered', 'a dismiss of a closed ask is refused too');
});

test('a late read for a room no longer shown is dropped; a failed read is not "no asks"', async () => {
  let release: (v: unknown) => void = () => {};
  const api = {
    hubAskList: (session: string) => session === 'old' ? new Promise((r) => { release = r; }) as Promise<any> : Promise.resolve({ asks: [row(9)] }),
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  };
  const book = new AskBook(api as any);
  const slow = book.load('old');
  await book.load('new');
  release({ asks: [row(1)] });
  await slow;
  assert.deepEqual(Object.keys(book.rows), ['9'], 'the old room\'s answer is dropped');
  assert.equal(book.loaded, true);
  const failing = new AskBook({ ...api, hubAskList: async () => { throw new Error('down'); } } as any);
  await failing.load('p');
  assert.equal(failing.failed, true, 'a failed read is said, never an empty list');
  assert.equal(failing.loaded, false);
});

test('the helpers: an ask is kind ask, a closing line names its ask by its derived id, the asker\'s state, the delivery words', () => {
  assert.equal(isAsk({ kind: 'ask' }), true);
  assert.equal(isAsk({ kind: 'msg', body: '@human [ask] typed by hand' } as { kind?: unknown }), false, 'never from the body');
  assert.equal(closingSeq({ id: 'ask:12:close' }), 12);
  assert.equal(closingSeq({ id: 'ask:12:closed' }), null);
  const agents = [{ name: 'lead', managed: true }, { name: 'shell', managed: false }];
  assert.equal(askerState('lead', agents, []), 'live');
  assert.equal(askerState('lead', agents, ['lead']), 'stopped');
  assert.equal(askerState('gone', agents, []), 'gone');
  assert.equal(askerState('shell', agents, []), 'gone', 'an unmanaged window is no asker');
  assert.deepEqual(['found', 'stopped', 'gone', 'unknown', 'unchecked', null].map(deliveryWord), ['sent', 'stopped', 'gone', 'unconfirmed', 'unconfirmed', null]);
});

test('a list read begun before a close never reopens the closed ask (validator-2 F1): a close is final', async () => {
  let release: (v: { asks: unknown[] }) => void = () => {};
  let reads = 0;
  const book = new AskBook({
    hubAskList: async () => (++reads === 1 ? { asks: [row(7)] } : new Promise((r) => { release = r; })),
    hubAskAnswer: async () => ({ applied: true, ask: row(7, { state: 'answered', answer_key: 'A', said: 'A · a', closed_at: 2 }) }),
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  const late = book.load('p');
  await book.answer(7, 'A');
  release({ asks: [row(7), row(8)] });
  await late;
  assert.equal(book.rows[7]!.state, 'answered', 'the older open snapshot does not roll the close back');
  assert.equal(book.rows[8]!.state, 'open', 'the rest of that read still lands');
});

test('a close the network rejects says so and returns false; nothing is marked closed (validator-2 F2)', async () => {
  const book = new AskBook({
    hubAskList: async () => ({ asks: [row(7)] }),
    hubAskAnswer: async () => { throw new Error('network unavailable'); },
    hubAskDismiss: async () => { throw new Error('network unavailable'); },
  } as never);
  await book.load('p');
  assert.equal(await book.answer(7, undefined, 'my words'), false);
  assert.equal(book.rows[7]!.state, 'open');
  assert.equal(book.errors[7], 'network unavailable');
  assert.equal(book.busy[7], undefined);
  assert.equal(await book.dismiss(7), false);
});

test('a close that lands returns true and clears an earlier send error', async () => {
  let fail = true;
  const book = new AskBook({
    hubAskList: async () => ({ asks: [row(7)] }),
    hubAskAnswer: async () => { if (fail) throw new Error('network unavailable'); return { applied: true, ask: row(7, { state: 'answered', said: 'w' }) }; },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  await book.answer(7, undefined, 'w');
  fail = false;
  assert.equal(await book.answer(7, undefined, 'w'), true);
  assert.equal(book.errors[7], undefined);
});

/** A read held open until the test releases it, after a close already answered. */
async function lateRead(closed: Record<string, unknown>, snapshot: Record<string, unknown>) {
  let release: (v: { asks: unknown[] }) => void = () => {};
  let reads = 0;
  const book = new AskBook({
    hubAskList: async () => (++reads === 1 ? { asks: [row(7)] } : new Promise((r) => { release = r; })),
    hubAskAnswer: async () => ({ applied: true, ask: row(7, closed) }),
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  const late = book.load('p');
  await book.answer(7, 'A');
  release({ asks: [row(7, snapshot)] });
  await late;
  return book;
}
const answered = { state: 'answered', answer_key: 'A', said: 'A · a', closed_at: 2 };

test('forward-only merge: a closed snapshot without delivery keeps the known delivery (validator-2 F1 expanded)', async () => {
  const book = await lateRead({ ...answered, delivery: 'found' }, { ...answered, delivery: null });
  assert.equal(book.rows[7]!.state, 'answered');
  assert.equal(book.rows[7]!.delivery, 'found', 'the server closes and pushes before it writes delivery');
});

test('forward-only merge: a newer snapshot with a different real delivery replaces it', async () => {
  const book = await lateRead({ ...answered, delivery: 'found' }, { ...answered, delivery: 'gone' });
  assert.equal(book.rows[7]!.delivery, 'gone');
});

test('forward-only merge: a snapshot never turns a closed row open, whatever its delivery', async () => {
  const book = await lateRead({ ...answered, delivery: 'found' }, { delivery: 'found' });
  assert.equal(book.rows[7]!.state, 'answered');
});

test('an ask the feed shows is missing only after a read begun for it returns without it; a failure says so too', async () => {
  let asks: unknown[] = [];
  let fail = false;
  let release: () => void = () => {};
  let hold = false;
  const book = new AskBook({
    hubAskList: async () => { if (hold) await new Promise<void>((r) => { release = r; }); if (fail) throw new Error('down'); return { asks }; },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  assert.equal(book.missing[9], undefined, 'a read that did not know of #9 says nothing about it');
  hold = true;
  const pending = book.ensure('p', [9]);
  assert.equal(book.missing[9], undefined, 'while the read for it is in flight, not missing');
  assert.equal(book.ensure('p', [9]), null, 'one read for it at a time');
  asks = [row(9)];
  release(); await pending;
  assert.equal(book.rows[9]!.state, 'open');
  assert.equal(book.ensure('p', [9]), null, 'a row it has needs no read');
  hold = false;
  await book.ensure('p', [10]);
  assert.equal(book.missing[10], true, 'read for it and absent: could not be loaded');
  assert.equal(book.ensure('p', [10]), null, 'not read again in a loop');
  fail = true;
  await book.load('p');
  assert.equal(book.failed, true);
});

test('two failed closes of different asks keep both errors; a later success clears only its own (validator-2 F2 @ 612870ec)', async () => {
  const gates: Record<number, (e?: Error) => void> = {};
  const book = new AskBook({
    hubAskList: async () => ({ asks: [row(7), row(8)] }),
    hubAskAnswer: (_s: string, seq: number) => new Promise((ok, no) => { gates[seq] = (e) => (e ? no(e) : ok({ applied: true, ask: row(seq, { state: 'answered', said: 'x' }) })); }),
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  const a = book.answer(7, 'A'); const b = book.answer(8, 'A');
  gates[7]!(new Error('first failed')); await a;
  gates[8]!(new Error('second failed')); await b;
  assert.deepEqual({ ...book.errors }, { 7: 'first failed', 8: 'second failed' });
  const c = book.answer(8, 'A'); const d = book.answer(7, 'A');
  gates[8]!(); await c;
  assert.equal(book.errors[7], 'first failed', 'another ask settling never removes this one\'s error');
  assert.equal(book.errors[8], undefined);
  gates[7]!(); await d;
});

/** A server whose room holds asks; `calls` records each list read's `all`. */
function room(rows: any[]) {
  const calls: boolean[] = [];
  let fail = false;
  const api = {
    hubAskList: async (_s: string, all = true) => { calls.push(all); if (fail) throw new Error('down'); return { asks: rows.filter((r) => all || r.state === 'open') }; },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  };
  return { calls, api, set: (next: any[]) => { rows = next; }, fail: (v: boolean) => { fail = v; } };
}

test('reconcile: the steady state reads only the open set (R1 cost)', async () => {
  const r = room([row(7), row(8, { state: 'answered', said: 'x', closed_at: 2, delivery: 'found' })]);
  const book = new AskBook(r.api as never);
  await book.load('p');
  r.calls.length = 0;
  await book.reconcile('p'); await book.reconcile('p');
  assert.deepEqual(r.calls, [false, false], 'nothing needs a full read');
});

test('reconcile: a loaded-open ask the open set no longer lists is read in full and shows closed (R1, missed close)', async () => {
  const r = room([row(7)]);
  const book = new AskBook(r.api as never);
  await book.load('p');
  r.set([row(7, { state: 'answered', said: 'A · a', closed_at: 2, delivery: 'found' })]);
  r.calls.length = 0;
  await book.reconcile('p');
  assert.deepEqual(r.calls, [false, true]);
  assert.equal(book.rows[7]!.state, 'answered');
  assert.equal(book.rows[7]!.delivery, 'found');
});

test('reconcile: a closed row with no delivery yet is re-read until known, at most three times (R1, delivery written after the push)', async () => {
  const r = room([row(7, { state: 'answered', said: 'x', closed_at: 2, delivery: null })]);
  const book = new AskBook(r.api as never);
  await book.load('p');
  r.calls.length = 0;
  await book.reconcile('p');
  assert.deepEqual(r.calls, [false, true], 'still unknown: read in full');
  r.set([row(7, { state: 'answered', said: 'x', closed_at: 2, delivery: 'found' })]);
  await book.reconcile('p');
  assert.equal(book.rows[7]!.delivery, 'found', 'the later delivery appears on a passive client');
  r.calls.length = 0;
  await book.reconcile('p');
  assert.deepEqual(r.calls, [false], 'known: back to the open set');
  // A row the server never completes stops costing full reads.
  const s = room([row(9, { state: 'answered', said: 'x', closed_at: 2, delivery: null })]);
  const other = new AskBook(s.api as never);
  await other.load('p');
  for (let i = 0; i < 6; i++) await other.reconcile('p');
  assert.equal(s.calls.filter((all) => all).length, 1 + 3, 'the opening read plus three re-reads, then the open set only');
});

test('reconcile: a failed read retries in full at the next boundary by itself and clears the stale mark (R1)', async () => {
  const r = room([row(7)]);
  const book = new AskBook(r.api as never);
  await book.load('p');
  r.fail(true);
  await book.reconcile('p');
  assert.equal(book.failed, true);
  r.fail(false);
  r.set([row(7, { state: 'dismissed', said: 'dismissed: no', closed_at: 2, delivery: 'found' })]);
  r.calls.length = 0;
  await book.reconcile('p');
  assert.deepEqual(r.calls, [true], 'after a failure the next boundary reads in full');
  assert.equal(book.failed, false);
  assert.equal(book.rows[7]!.state, 'dismissed');
});

test('reconcile: one read in flight at a time; a new open ask from the open set is added', async () => {
  let release: () => void = () => {};
  const calls: boolean[] = [];
  const book = new AskBook({
    hubAskList: async (_s: string, all = true) => { calls.push(all); if (!all) await new Promise<void>((r) => { release = r; }); return { asks: all ? [] : [row(11)] }; },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('p');
  const a = book.reconcile('p');
  await book.reconcile('p');
  assert.deepEqual(calls, [true, false], 'the second boundary does not read beside the first');
  release(); await a;
  assert.equal(book.rows[11]!.state, 'open');
});

test('a reconcile begun for room A never lands in room B after a switch (leader note 59)', async () => {
  let release: (v: { asks: unknown[] }) => void = () => {};
  let holdOpen = false;
  const book = new AskBook({
    hubAskList: async (s: string, all = true) => {
      if (!all && holdOpen) return new Promise((r) => { release = r; });
      return { asks: s === 'a' ? [row(7)] : [row(20)] };
    },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  await book.load('a');
  holdOpen = true;
  const late = book.reconcile('a');
  await book.load('b');
  release({ asks: [row(7), row(8)] });
  await late;
  assert.deepEqual(Object.keys(book.rows), ['20'], 'only room B\'s rows');
});

test('the draft is the store\'s: kept until that ask\'s close lands (by anyone), dropped on a room change (#107 round 5)', async () => {
  const r = room([row(7), row(8)]);
  const book = new AskBook(r.api as never);
  await book.load('p');
  book.setDraft(7, { text: 'mine', tried: 'B' });
  book.setDraft(8, { text: 'other' });
  assert.deepEqual(book.drafts[7], { text: 'mine', tried: 'B' });
  r.set([row(7, { state: 'answered', said: 'A · a', closed_at: 2, delivery: 'found' }), row(8)]);  // closed elsewhere
  await book.reconcile('p');
  assert.equal(book.drafts[7], undefined, 'a close that lands clears that ask\'s draft');
  assert.deepEqual(book.drafts[8], { text: 'other' }, 'and only that one');
  await book.load('q');
  assert.deepEqual({ ...book.drafts }, {}, 'a room change drops them with the rest');
});

test('setDraft is a no-op for a closed ask or one the store has no row for (#107 round 5 guard)', async () => {
  const r = room([row(7, { state: 'answered', said: 'x', closed_at: 2, delivery: 'found' }), row(8)]);
  const book = new AskBook(r.api as never);
  await book.load('p');
  book.setDraft(7, { text: 'stale', tried: 'A' });
  book.setDraft(99, { text: 'nowhere' });
  assert.deepEqual({ ...book.drafts }, {}, 'nothing restores a closed ask\'s draft');
  book.setDraft(8, { text: 'live' });
  assert.deepEqual(book.drafts[8], { text: 'live' });
});

test('one read of a room in flight: load, ensure and reconcile share it; a push during it is read once after it, and lands (#109 T6)', async () => {
  let active = 0, peak = 0, calls = 0;
  const releases: (() => void)[] = [];
  let answer: unknown[] = [row(7)];
  const book = new AskBook({
    hubAskList: async () => { calls++; active++; peak = Math.max(peak, active); await new Promise<void>((r) => releases.push(r)); active--; return { asks: answer }; },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  const first = book.load('p', [7]);
  const ensured = book.ensure('p', [8]);
  const pushed = book.load('p');
  const polled = book.reconcile('p');
  assert.equal(calls, 1, 'one in flight; the others wait or are dropped');
  answer = [row(7, { state: 'answered', answer_key: 'A', said: 'A · a', closed_at: 2 })];
  releases.shift()!(); await first;
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 2, 'the queued full read starts once the first settles, once');
  releases.shift()!(); await Promise.all([ensured, pushed, polled]);
  assert.equal(peak, 1);
  assert.equal(book.rows[7]!.state, 'answered', 'the pushed close lands');
});

test('the in-flight read is PER ROOM: A -> B -> A with A still pending never starts a second A; A and B may overlap (#109 T6, leader note 80)', async () => {
  const active: Record<string, number> = {}, peak: Record<string, number> = {};
  const releases: Record<string, (() => void)[]> = {};
  const book = new AskBook({
    hubAskList: async (s: string) => {
      active[s] = (active[s] ?? 0) + 1; peak[s] = Math.max(peak[s] ?? 0, active[s]!);
      await new Promise<void>((r) => (releases[s] ??= []).push(r));
      active[s]!--; return { asks: [row(s === 'A' ? 1 : 2)] };
    },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  const a1 = book.load('A');
  const b = book.load('B');
  const a2 = book.load('A');
  assert.deepEqual({ A: active.A, B: active.B }, { A: 1, B: 1 }, 'A and B overlap; the second A waits');
  releases.B!.shift()!(); await b;
  releases.A!.shift()!(); await a1;
  await Promise.resolve(); await Promise.resolve();
  releases.A!.shift()!(); await a2;
  assert.deepEqual(peak, { A: 1, B: 1 });
  assert.ok(book.rows[1], 'A s own read, after the stale one, landed');
});

test('a read that settles after dispose writes nothing; its queued caller settles with it (#109, validator-2 note 123)', async () => {
  let release!: () => void, calls = 0;
  const book = new AskBook({
    hubAskList: async () => { calls++; await new Promise<void>((r) => { release = r; }); return { asks: [row(9)] }; },
    hubAskAnswer: async () => { throw new Error('unused'); },
    hubAskDismiss: async () => { throw new Error('unused'); },
  } as never);
  const running = book.load('p');
  const queued = book.load('p');
  book.dispose();
  release(); await running; await queued;
  assert.equal(calls, 1, 'the queued read never ran');
  assert.deepEqual(Object.keys(book.rows), [], 'nothing written after dispose');
});
