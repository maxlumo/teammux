import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendCatalog } from '../core/agents.ts';
import { draftOf, draftDirty, draftValid, draftPatch, isSubmitChord, rebaseDraft, issueRef, ISSUE_REF_CHARS, assignNotes, chipCols, assigneeView } from './board.ts';

// Since board #15 a draft carries all four editable fields; these helpers
// build the full shape from the short form the assertions speak.
const d = (over: Partial<{ title: string; body: string; status: string; assignee: string }>) => ({
  title: '', body: '', status: '', assignee: '', ...over,
});

test('an issue draft saves explicitly, cancels cleanly, and patches only what changed (board #11)', () => {
  const issue = { title: 'fix login', body: 'step 2 breaks' };
  const clean = draftOf(issue);
  assert.deepEqual(clean, d({ title: 'fix login', body: 'step 2 breaks' }));
  assert.ok(!draftDirty(clean, issue), 'a fresh draft is not dirty');
  assert.equal(draftPatch(clean, issue), null, 'nothing changed, nothing to save');

  // Editing one field patches ONE field — the untouched body must not ride
  // along and overwrite a concurrent edit (the server COALESCEs).
  const retitled = { ...clean, title: 'fix login flow' };
  assert.ok(draftDirty(retitled, issue));
  assert.deepEqual(draftPatch(retitled, issue), { title: 'fix login flow' });

  const rebodied = { ...clean, body: 'root cause: session cookie' };
  assert.deepEqual(draftPatch(rebodied, issue), { body: 'root cause: session cookie' });

  // Both changed → both sent; the title is trimmed on the way out.
  const both = d({ title: '  new title ', body: 'b' });
  assert.deepEqual(draftPatch(both, issue), { title: 'new title', body: 'b' });

  // A blank title is FINE while a body holds (board #31: title optional) —
  // the patch clears it verbatim; blanking BOTH is contentless and invalid.
  const blank = { ...clean, title: '   ' };
  assert.ok(draftValid(blank), 'body still says something');
  assert.deepEqual(draftPatch(blank, issue), { title: '' });
  const contentless = { ...clean, title: '   ', body: ' ' };
  assert.ok(!draftValid(contentless));
  assert.equal(draftPatch(contentless, issue), null);

  // Cancel = draftOf(sel) again: identity with the stored issue.
  assert.ok(!draftDirty(draftOf(issue), issue));

  // Whitespace typed IS an edit until removed (dirty), but body-only spaces
  // still patch verbatim — the body is prose, not an id.
  const spaced = { ...clean, body: 'step 2 breaks ' };
  assert.ok(draftDirty(spaced, issue));
  assert.deepEqual(draftPatch(spaced, issue), { body: 'step 2 breaks ' });
});

test('status and assignee are DRAFT fields too — a stray tap changes nothing until ✓ (board #15)', () => {
  const issue = { title: 'T', body: 'B', status: 'todo', assignee: '' };
  const clean = draftOf(issue);
  assert.deepEqual(clean, d({ title: 'T', body: 'B', status: 'todo' }));
  assert.ok(!draftDirty(clean, issue));

  // Sliding the status marks the draft dirty and patches ONE field.
  const moved = { ...clean, status: 'doing' };
  assert.ok(draftDirty(moved, issue), 'a status change is an edit awaiting the ✓');
  assert.deepEqual(draftPatch(moved, issue), { status: 'doing' });

  // Picking an assignee likewise — the dispatch happens at SAVE time.
  const assigned = { ...clean, assignee: 'builder' };
  assert.deepEqual(draftPatch(assigned, issue), { assignee: 'builder' });

  // Cancel restores both: identity again.
  assert.ok(!draftDirty(draftOf(issue), issue));

  // The rebase covers the new fields: an agent's concurrent take (status +
  // assignee moved server-side) flows into an untouched draft…
  const server = d({ title: 'T', body: 'B', status: 'doing', assignee: 'builder-2' });
  const flowed = rebaseDraft(clean, clean, server);
  assert.deepEqual(flowed.draft, server);
  assert.equal(draftPatch(flowed.draft, flowed.base), null);

  // …while the user's own pending status keeps priority on a clash, and the
  // patch declares exactly that field.
  const clash = rebaseDraft({ ...clean, status: 'review' }, clean, server);
  assert.equal(clash.draft.status, 'review', 'the touched status keeps the user\u2019s pick');
  assert.equal(clash.draft.assignee, 'builder-2', 'the untouched assignee follows the server');
  assert.deepEqual(draftPatch(clash.draft, clash.base), { status: 'review' });
});

test('rebase: the agent\u2019s concurrent edit survives a title-only save (#11 review)', () => {
  // The lead's exact scenario: user opens {A, B}, edits ONLY the title;
  // an agent writes a new body B' server-side; a refetch (after a move or
  // note) brings it in.
  const base = d({ title: 'A', body: 'B' });
  const draft = d({ title: 'A2', body: 'B' });
  const server = d({ title: 'A', body: 'B-agent' });
  const r = rebaseDraft(draft, base, server);
  assert.equal(r.draft.body, 'B-agent', 'the untouched body follows the server');
  assert.equal(r.draft.title, 'A2', 'the touched title keeps the user\u2019s edit');
  assert.deepEqual(r.base, server, 'the base catches up to the server');
  // The save then ships ONLY the touched field — the agent's body is safe.
  assert.deepEqual(draftPatch(r.draft, r.base), { title: 'A2' });

  // Both sides touched the same field: the user's copy wins locally and the
  // patch declares it — overwriting is now a choice, not an accident.
  const clash = rebaseDraft(d({ title: 'A2', body: 'B' }), base, d({ title: 'A3', body: 'B' }));
  assert.equal(clash.draft.title, 'A2');
  assert.deepEqual(draftPatch(clash.draft, clash.base), { title: 'A2' });

  // Nothing touched: draft and base both become the server copy — clean.
  const clean = rebaseDraft(base, base, server);
  assert.deepEqual(clean.draft, server);
  assert.equal(draftPatch(clean.draft, clean.base), null);

  // After a successful save the server carries the saved text: the rebase
  // normalizes the draft to clean without an explicit reset.
  const saved = rebaseDraft(d({ title: 'A2', body: 'B' }), base, d({ title: 'A2', body: 'B' }));
  assert.equal(draftPatch(saved.draft, saved.base), null);
});

test('issueRef: one fallback names every titleless issue (board #31)', () => {
  // A real title wins, trimmed.
  assert.equal(issueRef({ id: 7, title: '  Fix login  ', body: 'whatever' }), 'Fix login');
  // No title → the body, whitespace squashed to one line.
  assert.equal(issueRef({ id: 7, title: '', body: 'the flow\n  breaks   at step 2' }), 'the flow breaks at step 2');
  // Long bodies cut on a CODE POINT boundary with the … marker (no split
  // surrogate: 𝓍 is astral).
  const long = '𝓍标题可空'.repeat(20);
  const r = issueRef({ id: 7, title: ' ', body: long });
  assert.equal([...r].length, ISSUE_REF_CHARS + 1, 'cut + one … char');
  assert.ok(r.endsWith('…'));
  assert.ok(r.startsWith('𝓍标题可空'));
  // Exactly at the budget: complete, no marker.
  const exact = 'x'.repeat(ISSUE_REF_CHARS);
  assert.equal(issueRef({ id: 7, body: exact }), exact);
  // Legacy all-empty → the id; missing fields never throw.
  assert.equal(issueRef({ id: 7, title: '', body: '   ' }), '#7');
  assert.equal(issueRef(null), '#0');
});

// ── Sidebar counts (board #39) ──────────────────────────────────────────────

test('countsOf speaks the server dialect: zero-filled vocabulary, explicit total, null for empty (board #39)', async () => {
  const { countsOf, BOARD_STATUSES } = await import('./board.ts');
  // One todo, two done: every OTHER status is PRESENT as 0 — the client
  // never guesses the vocabulary — and total is a field, not a sum.
  const c = countsOf([{ status: 'todo' }, { status: 'done' }, { status: 'done' }]);
  assert.deepEqual(c, { todo: 1, doing: 0, review: 0, done: 2, total: 3 });
  for (const s of BOARD_STATUSES) assert.ok(c && typeof c[s] === 'number', `${s} always present`);
  // EMPTY is null, never an all-zeros row — absence is the hide signal,
  // mirroring hub_board_counts (a zero row would make emptiness two checks).
  assert.equal(countsOf([]), null);
  // A foreign status counts toward total only, exactly like the server.
  assert.deepEqual(countsOf([{ status: 'weird' }]), { todo: 0, doing: 0, review: 0, done: 0, total: 1 });
});

test('applyCounts makes create/delete IMMEDIATE: first issue appears, last issue removes the key (board #39)', async () => {
  const { applyCounts } = await import('./board.ts');
  const before = { other: { todo: 1, doing: 0, review: 0, done: 0, total: 1 } };
  // Creating the FIRST issue: the session's key appears at once — the
  // sidebar must not wait out the 20 s poll.
  const created = applyCounts(before, 'mine', [{ status: 'todo' }]);
  assert.deepEqual(created['mine'], { todo: 1, doing: 0, review: 0, done: 0, total: 1 });
  assert.deepEqual(created['other'], before['other'], 'other boards untouched');
  // Deleting the LAST issue: the key is REMOVED (absence = hide), never
  // left as zeros.
  const gone = applyCounts(created, 'mine', []);
  assert.ok(!('mine' in gone), 'empty board leaves the map');
  assert.ok('other' in gone, 'other boards survive');
  // Immutable: $state consumers see a NEW map, the old one is unchanged.
  assert.ok(!('mine' in before), 'input map never mutated');
  assert.notEqual(created, before);
});

test('visibleBoards hides empty boards and keeps the given order (board #39)', async () => {
  const { visibleBoards } = await import('./board.ts');
  const rows = [
    { project: { session: 'a', name: 'A' } },
    { project: { session: 'b', name: 'B' } },
    { project: { session: 'c', name: 'C' } },
  ];
  const counts = {
    a: { todo: 0, doing: 0, review: 0, done: 1, total: 1 },
    c: { todo: 2, doing: 0, review: 0, done: 0, total: 2 },
  };
  // b has NO key (empty board) → hidden; order of the rest is the caller's
  // (sortRows already ordered by conversation).
  assert.deepEqual(visibleBoards(rows, counts).map((r) => r.project.session), ['a', 'c']);
  // A defensive zero row hides too: the check is total>0, not key-exists.
  assert.deepEqual(visibleBoards(rows, { b: { todo: 0, doing: 0, review: 0, done: 0, total: 0 } }), []);
  assert.deepEqual(visibleBoards([], counts), []);
});

test('boardTitle answers from the FULL list — a hidden empty board still has its name (board #39)', async () => {
  const { boardTitle } = await import('./board.ts');
  const all = [
    { project: { session: 'shown', name: 'Shown' } },
    { project: { session: 'empty', name: 'Empty but named' } },
  ];
  // The current board is empty and filtered OUT of the sidebar, yet the
  // page-head names it — that is where the first issue gets created.
  assert.equal(boardTitle(all, 'empty'), 'Empty but named');
  assert.equal(boardTitle(all, 'shown'), 'Shown');
  // Unknown session → null, and the component falls back (session string,
  // then the generic page name) exactly like before.
  assert.equal(boardTitle(all, 'gone'), null);
  assert.equal(boardTitle([], 'x'), null);
});

test('assignNotes: the dispatch carries the thread — chronological, authored, separated (board #42)', () => {
  // Nothing to say appends NOTHING: no notes, an empty array, or the bare
  // count a LIST row carries instead of the thread.
  assert.equal(assignNotes(7, []), '');
  assert.equal(assignNotes(7, 3), '');
  assert.equal(assignNotes(7, null), '');
  assert.equal(assignNotes(7, undefined), '');

  // Multi-note: ordered by `at` ASCENDING whatever order the caller holds,
  // each line keeps its author, and the block opens with a blank line + a
  // counted header so the original description stays clearly separate.
  const out = assignNotes(42, [
    { author: 'builder-2', body: 'second finding', at: 20 },
    { author: 'human', body: 'first: check the cache', at: 10 },
    { author: 'lead', body: 'third — ship it', at: 30 },
  ]);
  assert.equal(out, [
    '',
    '',
    'Notes (3):',
    '- human: first: check the cache',
    '- builder-2: second finding',
    '- lead: third — ship it',
  ].join('\n'), 'chronological, authored, no truncation marker when it fits');

  // A note's inner newlines squash to spaces: one note stays ONE line, so
  // the bullet grammar and the character budget both hold.
  assert.equal(
    assignNotes(5, [{ author: 'a', body: 'line one\n  line two\n\nline three', at: 1 }]),
    '\n\nNotes (1):\n- a: line one line two line three',
  );
});

test('assignNotes: an explicit budget truncates — one giant note cannot flood the pane (board #42)', () => {
  // ONE giant note is sliced at the budget and pointed at `tmm board show`.
  const giant = assignNotes(9, [{ author: 'a', body: 'x'.repeat(5000), at: 1 }], 200);
  const [, , header, line, tail] = giant.split('\n');
  assert.equal(header, 'Notes (1):');
  assert.ok(line!.length <= 201, `the sliced line respects the budget (+ the … marker): ${line!.length}`);
  assert.ok(line!.endsWith('…'), 'a partial note is marked');
  assert.equal(tail, '… — `tmm board show 9`', 'no notes were fully omitted, but the pointer to the rest stands');

  // Later notes past the budget are dropped and COUNTED; the tail names how
  // many more the thread holds and where to read them.
  const many = assignNotes(11, [
    { author: 'a', body: 'k'.repeat(90), at: 1 },
    { author: 'b', body: 'k'.repeat(90), at: 2 },
    { author: 'c', body: 'unreached', at: 3 },
    { author: 'd', body: 'unreached too', at: 4 },
  ], 200);
  assert.match(many, /\n… \+2 more — `tmm board show 11`$/u, 'omitted notes are counted in the tail');
  assert.ok(!many.includes('unreached'), 'past-budget notes are not leaked');

  // A useless sliver of remaining room drops the partial note outright —
  // the marker line speaks for it instead of a fragment.
  const sliver = assignNotes(3, [
    { author: 'a', body: 'k'.repeat(180), at: 1 },
    { author: 'b', body: 'a real point that matters', at: 2 },
  ], 200);
  assert.ok(!sliver.includes('- b:'), 'a fragment under the minimum slice is not worth emitting');
  assert.match(sliver, /\+1 more/u);

  // Within budget: identity — no marker, no pointer.
  const fits = assignNotes(4, [{ author: 'a', body: 'short', at: 1 }], 200);
  assert.ok(!fits.includes('tmm board show'), 'a fitting thread needs no pointer');
});

test('chipCols: one row when it fits, else 2×2, else one column — never three (board #39, owner)', () => {
  // Owner (2026-09-01): "如果一行能 放下放一行也行，甚至两行放不下，就放一
  // 列，动态适配" — on top of the standing rule 不要 3+1. Grid columns are
  // EQUAL (1fr), so the widest chip is the exact unit: n columns fit iff
  // n·chip + (n−1)·gap ≤ width.
  // chip 50, gap 10: 4 cols need 230, 2 cols need 110.
  assert.equal(chipCols(230, 50, 10), 4, 'exactly fits four across');
  assert.equal(chipCols(229, 50, 10), 2, 'one pixel short of four → the 2×2 rectangle');
  assert.equal(chipCols(110, 50, 10), 2, 'exactly fits two columns');
  assert.equal(chipCols(109, 50, 10), 1, 'one pixel short of two → single column');
  assert.equal(chipCols(1, 50, 10), 1, 'a sliver still renders one column');
  // Unmeasured (first paint, before the mirror reports) keeps the rectangle:
  // 2×2 is the layout every width can wear without a 3+1 flash.
  assert.equal(chipCols(0, 50, 10), 2, 'unmeasured width → default rectangle');
  assert.equal(chipCols(230, 0, 10), 2, 'unmeasured chip → default rectangle');
  // NEVER three: the whole domain maps into {1, 2, 4}.
  for (let w = 0; w <= 400; w++) {
    const c = chipCols(w, 50, 10);
    assert.ok(c === 1 || c === 2 || c === 4, `w=${w} gave ${c}`);
  }
});

test('assigneeView: an agent wears its backend icon; the dot only in doing, only while running (board #293, #327)', () => {
  // An unanswered catalog: the faces this build ships (board #335 ②b-3 —
  // the catalog is the caller's, the server whose board this is).
  const catalog = createBackendCatalog();
  const agents = [
    { name: 'builder', state: 'working', managed: true, agent: 'kiro' },
    { name: 'validator', state: 'idle', managed: true, agent: 'codex' },
    { name: 'shell', state: 'working', managed: false, agent: 'claude' },
  ];
  assert.equal(assigneeView('', agents, 'doing', {}, catalog), null, 'unassigned: nothing');
  assert.deepEqual(assigneeView('builder', agents, 'doing', {}, catalog), { name: 'builder', icon: '/assets/kiro.svg', live: true }, 'its own backend face, lit while working in DOING');
  for (const col of ['todo', 'review', 'done']) {
    assert.deepEqual(assigneeView('builder', agents, col, {}, catalog), { name: 'builder', icon: '/assets/kiro.svg', live: false }, `${col}: the face, never the working dot`);
  }
  assert.deepEqual(assigneeView('validator', agents, 'doing', {}, catalog), { name: 'validator', icon: '/assets/codex.svg', live: false }, 'idle: no dot');
  assert.deepEqual(assigneeView('reviewer', agents, 'doing', { reviewer: 'claude' }, catalog), { name: 'reviewer', icon: '/assets/claude.svg', live: false },
    'stopped: the remembered backend keeps its face');
  assert.deepEqual(assigneeView('ghost', agents, 'doing', {}, catalog), { name: 'ghost', icon: null, live: false }, 'never seen: no picture to wear, never an invented letter');
  assert.equal(assigneeView('shell', agents, 'doing', {}, catalog)?.live, false, 'a direct window is not a managed agent');
  assert.deepEqual(assigneeView('human', agents, 'doing', {}, catalog), { name: 'human', icon: null, live: false }, 'the human is not an agent: no picture');
});

test('rememberBackends folds each poll into what was known', async () => {
  const { rememberBackends } = await import('./board.ts');
  const known = { old: 'kiro' };
  assert.equal(rememberBackends(known, [{ name: 'old', agent: 'kiro', managed: true }]), known, 'nothing new: the same object');
  assert.deepEqual(rememberBackends(known, [{ name: 'b', agent: 'codex', managed: true }, { name: 'x', agent: 'claude', managed: false }, { name: 'n', agent: null }]),
    { old: 'kiro', b: 'codex' }, 'a stopped agent missing from this poll is kept; direct windows and unknowns are not learned');
});

test('the submit chord is Cmd or Ctrl + Enter, never a bare/Shift Enter and never mid-IME (board #36, #348)', () => {
  const k = (o: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }>) =>
    isSubmitChord({ key: 'Enter', metaKey: false, ctrlKey: false, isComposing: false, ...o });
  assert.equal(k({ metaKey: true }), true, 'Cmd+Enter (mac)');
  assert.equal(k({ ctrlKey: true }), true, 'Ctrl+Enter (everywhere else)');
  assert.equal(k({}), false, 'a bare Enter is a newline');
  assert.equal(k({ key: 'a', metaKey: true }), false, 'only Enter');
  assert.equal(k({ metaKey: true, isComposing: true }), false, 'the Enter that commits an IME candidate is not a submit');
  assert.equal(k({ ctrlKey: true, isComposing: true }), false);
});
