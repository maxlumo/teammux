import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewClaim } from './view-claim.ts';

test('only the answer to the latest tap may open (board #329, #447)', () => {
  const claim = createViewClaim();
  const first = claim.begin();
  const second = claim.begin();
  assert.equal(claim.accept(first), false, 'an older tap is dropped');
  assert.equal(claim.accept(second), true);
  assert.equal(claim.accept(undefined), false, 'no claim, no open');
});

test('a claim from another epoch is dead; the epoch is a counter, so A to B to A is never the first one back', () => {
  let generation = 1;
  const claim = createViewClaim(() => generation);
  const atA = claim.begin();
  generation++;          // B
  assert.equal(claim.accept(atA), false);
  generation++;          // and back on A's place: a new generation, not the old one
  assert.equal(claim.accept(atA), false);
});

test('retire kills every claim taken so far and resurrects none', () => {
  const claim = createViewClaim();
  const held = claim.begin();
  claim.retire();
  assert.equal(claim.accept(held), false, 'a late signature after hide/close does not open');
  const fresh = claim.begin();
  assert.equal(claim.accept(fresh), true, 'a new tap after retire is a new claim');
  assert.equal(claim.accept(held), false, 'and the old one stays dead');
});
