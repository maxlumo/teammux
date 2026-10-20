// The landing of a review feedback block and the recipient generation
// (board #434 delta 2/3 P1-C), as pure functions over one server's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpRecipientIntent, createReviewState, landFeedback, recipientIntent, registerComposer } from './review-state.ts';

function prefs(initial: Record<string, string> = {}) {
  const drafts = { ...initial };
  return { drafts, draft: (s: string) => drafts[s] ?? '', setDraft: (s: string, t: string) => { drafts[s] = t; } };
}

test('a room nobody shows gets the block appended to its draft as it is NOW', () => {
  const state = createReviewState();
  const p = prefs({ room: 'typed meanwhile  \n' });
  assert.equal(landFeedback(state, p, { projectId: 'p1', session: 'room', block: 'B', intent: 0 }), 'draft');
  assert.equal(p.drafts.room, 'typed meanwhile\n\nB');
  landFeedback(state, p, { projectId: 'p1', session: 'empty', block: 'B', intent: 0 });
  assert.equal(p.drafts.empty, 'B', 'no blank line before a block in an empty draft');
});

test('a Hub showing the room takes it live; another room\u2019s Hub does not', () => {
  const state = createReviewState();
  const p = prefs();
  const got: [string, string, boolean][] = [];
  const offA = registerComposer(state, { session: () => 'a', append: (b, auto) => got.push(['a', b, auto]) });
  registerComposer(state, { session: () => 'b', append: (b, auto) => got.push(['b', b, auto]) });
  assert.equal(landFeedback(state, p, { projectId: 'pa', session: 'a', block: 'X', intent: 0 }), 'live');
  assert.deepEqual(got, [['a', 'X', true]]);
  assert.deepEqual(p.drafts, {}, 'the live text reaches the draft through the Hub, not here');
  offA();
  assert.equal(landFeedback(state, p, { projectId: 'pa', session: 'a', block: 'Y', intent: 0 }), 'draft');
});

test('the automatic recipient is allowed only while the generation is the captured one (A→B→A)', () => {
  const state = createReviewState();
  const got: boolean[] = [];
  registerComposer(state, { session: () => 'r', append: (_b, auto) => got.push(auto) });
  const asked = recipientIntent(state, 'p1');
  bumpRecipientIntent(state, 'p1'); bumpRecipientIntent(state, 'p1'); // empty → alice → empty
  landFeedback(state, prefs(), { projectId: 'p1', session: 'r', block: 'B', intent: asked });
  bumpRecipientIntent(state, 'other');
  landFeedback(state, prefs(), { projectId: 'p1', session: 'r', block: 'B', intent: recipientIntent(state, 'p1') });
  assert.deepEqual(got, [false, true], 'another project\u2019s choices do not count');
  bumpRecipientIntent(state, undefined); // a room with no project id bumps nothing
  assert.equal(recipientIntent(state, ''), 0);
});
