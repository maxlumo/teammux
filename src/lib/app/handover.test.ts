// Handing the shared socket over, as rules (board #335 ②b-1).
//
// Each case below is a hole that was open at some point, and the last two are
// the ones a boolean cannot close: a stale attempt ENDING the handle a live
// one is protecting, and an attempt changing its mind after it concluded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandovers } from './handover.ts';
import type { ServerRuntime } from './server-runtime.ts';

/** A handle double that records what the handovers did to it. */
function handle() {
  const log: string[] = [];
  let tickets = 0;
  return {
    log,
    runtime: {
      suspend: () => { const t = ++tickets; log.push(`suspend:${t}`); return t; },
      settle: (ticket: number, verdict: string) => log.push(`settle:${ticket}:${verdict}`),
    } as unknown as ServerRuntime,
  };
}

test('an attempt stands the handle down and reports its verdict', () => {
  const h = handle();
  const handovers = createHandovers();
  const first = handovers.open(h.runtime);
  assert.equal(first.current(), true);
  first.settle('same-server');
  assert.deepEqual(h.log, ['suspend:1', 'settle:1:resume']);
});

test('each conclusion carries the verdict it means', () => {
  for (const [outcome, verdict] of [
    ['same-server', 'resume'],
    ['no-peer', 'resume'],
    ['other-server', 'release'],
    ['unresolved', 'hold'],
  ] as const) {
    const h = handle();
    createHandovers().open(h.runtime).settle(outcome);
    assert.deepEqual(h.log, ['suspend:1', `settle:1:${verdict}`], outcome);
  }
});

test('a newer handover makes the older one stale, for every verdict', () => {
  // Including the terminal one: a late "another server authenticated" would
  // end the handle the live handover is protecting, and that one may still
  // resume.
  const h = handle();
  const handovers = createHandovers();
  const first = handovers.open(h.runtime);
  const second = handovers.open(h.runtime);
  h.log.length = 0;

  first.settle('other-server');
  assert.equal(first.current(), false);
  assert.deepEqual(h.log, [], 'the stale attempt decided nothing at all');

  second.settle('same-server');
  assert.deepEqual(h.log, ['settle:2:resume'], 'the live one decides');
});

test('a verdict is consumed once, hold included', () => {
  // `hold` is a conclusion, not a deferral: an attempt that has had its say
  // cannot come back and resume what it left suspended.
  const h = handle();
  const handovers = createHandovers();
  const only = handovers.open(h.runtime);
  only.settle('unresolved');
  only.settle('same-server');
  only.settle('other-server');
  assert.deepEqual(h.log, ['suspend:1', 'settle:1:hold'], 'only the first verdict counted');
});

test('the host can end every open handover', () => {
  // What a server switch does: leaving is already decided, so an attempt that
  // comes back afterwards writes no identity and brings nothing up — which is
  // what `current()` tells its caller before it does either.
  const h = handle();
  const handovers = createHandovers();
  const inFlight = handovers.open(h.runtime);
  h.log.length = 0;

  handovers.endAll();

  assert.equal(inFlight.current(), false, 'the attempt is no longer the one the app waits on');
  inFlight.settle('same-server');
  assert.deepEqual(h.log, [], 'and its conclusion changes nothing');
});

test('a handover with no server bound still answers', () => {
  // A fresh client has no runtime to stand down, and the caller should not
  // have to care: it opens a handover, asks, and concludes the same way.
  const handovers = createHandovers();
  const first = handovers.open(null);
  assert.equal(first.current(), true);
  first.settle('same-server');          // no throw
  handovers.endAll();
  assert.equal(first.current(), false);
});
