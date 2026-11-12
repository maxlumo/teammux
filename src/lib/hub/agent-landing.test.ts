import test from 'node:test';
import assert from 'node:assert/strict';
import { discussFor, landingFor, stepLanding } from './agent-landing.ts';

// Board #109 S6, S9 and T5: the landings' rules, case by case (the Hub's and App's mount
// tests drive the same through the real wiring).
const at = (room: string, here: boolean, roster: string[] = [], rosterKnown = false, gen = 1) => ({ room, gen, here, roster, rosterKnown });

test('a request makes an agent landing only when it names an agent, bound to its room and visit', () => {
  assert.deepEqual(landingFor({ session: 'a', agent: 'alice' }, 'b', 1), { session: 'a', gen: 1, seen: false, agent: 'alice' });
  assert.deepEqual(landingFor({ agent: 'alice' }, 'b', 2), { session: 'b', gen: 2, seen: false, agent: 'alice' }, 'no session: the room shown');
  assert.equal(landingFor({ session: 'a' }, 'b', 1), null);
});

test('ready while here applies it; ready while away drops it, never kept', () => {
  const l = landingFor({ session: 'a', agent: 'alice' }, 'a', 1);
  assert.deepEqual(stepLanding(l, at('a', true, ['alice'])), { next: null, apply: l });
  assert.deepEqual(stepLanding(l, at('a', false, ['alice'])), { next: null });
  const d = discussFor('a', 'm9', 1);
  assert.deepEqual(stepLanding(d, at('a', true, [], false)), { next: { ...d, seen: true } }, 'Discuss waits for the roster to be known');
  assert.deepEqual(stepLanding(d, at('a', true, [], true)), { next: null, apply: d }, 'known (even empty): decide now');
  assert.deepEqual(stepLanding(d, at('a', false, [], true)), { next: null }, 'known while away: dropped');
});

test('waiting: seen once here; leaving the room, a new visit of it, or losing focus once seen voids it', () => {
  for (const l of [landingFor({ session: 'a', agent: 'alice' }, 'a', 1)!, discussFor('a', 'm9', 1)]) {
    const seen = stepLanding(l, at('a', true)).next!;
    assert.equal(seen.seen, true);
    assert.equal(stepLanding(seen, at('a', true)).next, seen, 'nothing changed: the same landing');
    assert.equal(stepLanding(seen, at('a', false)).next, null, 'focus lost after holding it');
    assert.equal(stepLanding(l, at('a', false)).next, l, 'not yet seen: arriving away does not void it');
    assert.equal(stepLanding(seen, at('b', true, ['alice'], true)).next, null, 'another room');
    assert.deepEqual(stepLanding(seen, at('a', true, ['alice'], true, 2)), { next: null }, 'A -> B -> A: a new visit, even back in A');
  }
});
