import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Board.svelte', import.meta.url), 'utf8');
const appCss = await readFile(new URL('../../app.css', import.meta.url), 'utf8');

test('the issue detail is a DRAFT: explicit save, clean cancel, guarded exits (board #11)', () => {
  // Only the explicit Save persists the text fields — the inputs bind the
  // draft, never sel, and the save routes through draftPatch so untouched
  // fields stay off the wire.
  assert.match(source, /<input class="d-title-input" bind:value=\{draft\.title\}/u, 'the title edits the draft');
  assert.match(source, /<textarea class="d-body-edit" bind:this=\{bodyEl\} bind:value=\{draft\.body\}/u, 'the body edits the draft');
  assert.match(source, /const patch = draftPatch\(saved, draftBase\);/u,
    'save diffs against the draft BASE — diffing the live issue ships stale untouched fields (#11 review)');
  assert.match(source, /onclick=\{saveDraft\}/u, 'save is a button, not a side effect');
  assert.match(source, /disabled=\{busy \|\| !draftValid\(\{ \.\.\.draft, body: bodyStage\.body\(draft\.body\) \}\) \|\| blocked\(bodyStage\)\}/u, 'saving twice / a blank title is unclickable');
  // Cancel ASKS since board #15 ("当前状态没有保存，是否退出"): it routes
  // through the same guard every exit uses, and the dialog's confirm is the
  // one place that restores the base.
  assert.match(source, /onclick=\{\(\) => guard\(\(\) => \{\}\)\}/u, 'cancel asks before discarding');
  assert.match(source, /draft = \{ \.\.\.draftBase \};/u,
    'confirming restores the draft BASE — the server text the user started from, kept fresh by the rebase');
  // Every exit that would drop a dirty draft goes through the confirm
  // dialect: the back button, Escape, the phone's back gesture, a sidebar
  // project switch. Nothing silently discards.
  assert.match(source, /onclick=\{\(\) => guard\(\(\) => \(sel = null\)\)\}/u, 'the back button is guarded');
  assert.match(source, /if \(sel && \(dirty \|\| noteDirty\)\) \{ pendingDiscard = \(\) => \{ sel = null; \}; e\.stopPropagation\(\); return; \}/u,
    'Escape asks first while dirty');
  assert.match(source, /if \(sel && \(dirty \|\| noteDirty\)\) \{ pendingDiscard = \(\) => \{ sel = null; \}; return true; \}/u,
    'the back gesture asks first while dirty');
  assert.match(source, /function pick\(s: string\) \{\s*\n\s*guard\(/u, 'a sidebar switch asks first');
  assert.match(source, /<ConfirmDialog open=\{!!pendingDiscard\} danger=\{false\}/u,
    'the shared confirm dialect, neutral tone — discarding an edit is not deleting a file');
  // A refetch REBASES three-way: untouched fields follow the server, touched
  // fields keep the user's text (#11 review) — never a blind draft reset.
  const refetch = source.slice(source.indexOf('async function refetchSel'), source.indexOf('// Assigning DOES'));
  assert.match(refetch, /const r = rebaseDraft\(draft, draftBase, draftOf\(fresh\)\);/u, 'refetchSel rebases');
  assert.ok(!refetch.includes('draft = draftOf(sel)'), 'and never blindly resets the draft');
});

test('assignment is ONE dispatch — the detail picker and the create dialog share it (board #11)', () => {
  // dispatchAssign is the single carrier of assignment=dispatch semantics:
  // saving the assignee AND typing the brief into the agent's pane. Exactly
  // one hubPost call site proves nobody re-implements the delivery half.
  assert.match(source, /async function dispatchAssign\(ctx: OpCtx, id: number, name: string, title = '', body = '', notes: \{ author: string; body: string; at: number \}\[\] = \[\]\)/u, 'the one dispatch function');
  assert.equal(source.split('hubPost(').length - 1, 1, 'exactly one delivery call site, inside dispatchAssign');
  // The brief carries the NOTE THREAD too (board #42): the delivery appends
  // assignNotes — chronological, authored, budget-capped in board.ts — so an
  // agent cannot miss the discussion under the issue.
  // …and the reading order is a HANDOFF (board #51): who assigned it leads
  // the message, the note thread follows the issue, and the tmm instructions
  // ride LAST — never between the issue and its thread.
  assert.match(source, /await hubPost\(ctx\.session, `@\$\{name\} \$\{msg\}\$\{assignNotes\(id, notes\)\}\\n\$\{take\}`\);/u,
    'the dispatch order: message, notes, then the take instructions last');
  // The ORIGINAL issue body is the task input, not a notification preview:
  // dispatch must carry all of it. The pane path uses paste-buffer and has no
  // 400-char transport ceiling, so a frontend excerpt silently loses context.
  assert.match(source, /const b = body\.trim\(\) \? ` — \$\{body\.trim\(\)\}\.` : '\.';/u,
    'assignment carries the complete issue body');
  assert.ok(!source.includes('const EXCERPT ='), 'assignment has no body excerpt budget');
  assert.match(source, /\.replace\('\{who\}', 'human'\)/u, 'the assigner is the subject at the front');
  assert.match(source, /const take = t\('boardAssignTake'\)\.replaceAll\('\{id\}', String\(id\)\);/u,
    'the instructions are their own i18n atom, filled per issue');
  assert.match(source, /const notes = Array\.isArray\(sel\.notes\) \? sel\.notes : \[\];[\s\S]*if \(assignee !== undefined && alive\) await dispatchAssign\(ctx, id, assignee, saved\.title, saved\.body, notes\);/u,
    'a ✓-confirmed assignee change routes through it (board #15) and carries the OPEN issue\u2019s thread (board #42)');
  assert.match(source, /if \(wantAssign && created != null && alive\) await dispatchAssign\(ctx, created, wantAssign, title, body\);/u,
    'create-with-assignee dispatches too — a fresh issue HAS no notes, so none ride (board #42)');
  // The form closes the MOMENT the create succeeds — before the dispatch can
  // fail — because a retryable form after a successful create mints
  // duplicate issues (#11 review). Order in the source is the guarantee.
  const create = source.slice(source.indexOf('async function createIssue'), source.indexOf('async function addNote'));
  const closes = create.indexOf('creating = false;');
  const dispatches = create.indexOf('await dispatchAssign(ctx, created');
  assert.ok(closes > -1 && dispatches > -1 && closes < dispatches,
    'the form is gone before the dispatch is attempted');
  assert.ok(create.indexOf('busy = false;\n      return;') < closes,
    'only a FAILED create keeps the form for an honest retry');
});

test('the layout hierarchy: one compact title line, the body visibly bigger (board #11)', () => {
  const style = source.slice(source.indexOf('<style>'));
  assert.match(style, /\.d-title-input \{[^}]*padding: 7px 10px;/u, 'the title stays a single compact line');
  assert.ok(!/\.d-title-input \{[^}]*min-height/u.test(style), 'no tall title');
  const body = /\.d-body-edit \{[^}]*min-height: (\d+)px;[\s\S]{0,400}?resize: vertical;/u.exec(style);
  assert.ok(body, 'the body field declares a min-height and grows');
  // The 200px fixed size was retired for autoGrow (owner, 2026-08-29: "有的框
  // 很大 有空白 应该自适应"): the min-height is a FLOOR under an adaptive box,
  // so it stays small — content, not the constant, makes the body big.
  assert.ok(Number(body![1]) >= 48 && Number(body![1]) <= 120, `the floor is small (${body![1]}px) — autoGrow does the sizing`);
});

test('the sidebar orders by conversation, and rows are summaries (reopened #11)', () => {
  // Same recipe as the Hub: hub_rooms feeds sortRows, newest talk first —
  // into the FULL list; the shown rows are the derived filter (board #39).
  assert.match(source, /allProjects = sortRows\(\(r\.projects \?\? \[\]\)\.filter\([\s\S]*?archived\), talkMap\);/u,
    'sortRows over the talk map, archived rows dropped');
  assert.match(source, /ask\(\(\) => hubRooms\(\)\)\.catch/u, 'the talk map comes from hub_rooms, fail-soft (started in the #357 thunk)');
  const row = source.slice(source.indexOf('class="side-row proj-row"'), source.indexOf('</aside>'));
  // #357: the row's clock is ITS server's (`r.slice.talk` — this server's
  // talkMap in Single, the source server's in a union), the rule every union
  // row follows since ③c-2 (reviewer P1, 2026-10-10).
  assert.match(row, /class="side-age">\{projectAgeLabel\(p, r\.slice\.talk, projectTick\)\}/u,
    'rows carry the same updated age as Chat and Terminal, by the row s own server s clock');
  // The second line is COLUMN COUNTS in the shared chip dress — never the
  // Chat row's agent chips (board #39 kept the summary rule: no roster here).
  assert.ok(!row.includes('a.icon'), 'no agent chips — the Board row summarises the BOARD, not the roster');
  assert.match(row, /countColor\(st\)/u, 'the chips speak the board status language through the sidebar remap');
});

test('notes are a timeline: author + time header, content box below (reopened #11)', () => {
  // The time became a real <button> with board #46 (the accessible action
  // trigger) but keeps its place and clothes: right of the author, one line.
  assert.match(source, /<div class="n-head">\s*<span class="n-author">\{n\.author\}<\/span>[\s\S]*?<button class="n-at"/u,
    'author left, time right, one header line');
  assert.match(source, /<div class="n-text"[\s\S]*?onclick=\{\(\) => toggleNoteActs\(i\)\}>\{withImages\(n\.body\.trim\(\)\)\.text\}<\/div>/u,
    'the content is its own box below, trimmed');
  const style = source.slice(source.indexOf('<style>'));
  assert.match(style, /\.n-at \{[^}]*margin-left: auto/u, 'the time right-aligns');
  assert.match(style, /\.n-author \{ color: var\(--accent\)/u, 'the author wears the accent ink');
  assert.match(source, /\{t\('boardOpenedBy'\)\} <span class="m-name">\{sel\.created_by\}<\/span>/u,
    'the opened-by name is highlighted too');
});

test('a board\u2019s first fill unfolds its columns; a poll is a cut (motion.md wave 8)', () => {
  assert.match(source, /<div class="col-scroll subtle-scroll" class:reveal=\{justLoaded\}>/u, 'each column\u2019s card list wears .reveal');
  assert.match(source, /if \(!ready\) unfold\(\); \/\/ the first answer for this board, not a poll\s*\n\s*issues = r\.issues;\s*\n\s*ready = true;/u,
    'only the first answer after a project switch unfolds');
  assert.match(source, /justLoadedTimer = setTimeout\(\(\) => \{ justLoaded = false; \}, revealMs\(\)\);/u, 'cleared after one move plus the longest stagger');
  assert.match(source, /ready = false; issues = \[\];[^\n]*\n(?:[^\n]*\n)*?\s*if \(justLoadedTimer\) clearTimeout\(justLoadedTimer\); justLoaded = false;/u, 'a switch mid-unfold cancels it');
});

test('a card\u2019s hover card says only what the card does not (motion.md principle 16, board #284)', () => {
  assert.match(source, /<button class="card" animate:flip=\{\{ duration: moveMs\(\) \}\} onclick=\{\(\) => openIssue\(i\.id\)\} use:hoverInfo=\{\(\) => cardInfo\(i\)\}>/u,
    'the card wears use:hoverInfo');
  const info = /function cardInfo\(i: BoardIssue\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.ok(info, 'cardInfo exists');
  // Owner 2026-09-30: "不要做重复内容展示". The card already shows each of
  // these; the hover repeats none (the column header is the status).
  for (const dup of [/title:/u, /text:/u, /issueRef/u, /i\.body/u, /created_by/u, /assignee/u, /status/u, /noteCount|i\.notes/u, /\bago\(/u]) {
    assert.ok(!dup.test(info), `the hover must not repeat the card: ${dup}`);
  }
  // What the card lacks: WHEN, absolute, in the one local form.
  assert.match(info, /t\('boardHoverCreated'\), value: localWhen\(i\.created_at\)/u, 'created, absolute');
  assert.match(info, /if \(i\.updated_at > i\.created_at\) lines\.push\(\{ label: t\('boardHoverUpdated'\), value: localWhen\(i\.updated_at\) \}\)/u,
    'updated, absolute, only when it differs from created');
  assert.match(info, /if \(!i\.created_at\) return null;/u, 'nothing to say, no card');
  assert.ok(!/<button class="card"[^>]*\stitle=/u.test(source), 'no native title beside the card');
});

test('columns scroll alone; the page holds still (reopened #11)', () => {
  const style = source.slice(source.indexOf('<style>'));
  assert.match(style, /\.board \{[^}]*overflow: hidden/u, 'the page is not the scroller');
  assert.match(style, /\.cols \{[^}]*flex: 1;\s*\n\s*min-height: 0;/u, 'the column grid takes the available height');
  assert.match(style, /\.col-scroll \{\s*\n\s*overflow-y: auto;/u, 'each column\u2019s cards area is its own scroller');
  assert.match(source, /<div class="col-scroll subtle-scroll"( class:reveal=\{justLoaded\})?>\s*\{#each items/u, 'the scroller wraps the cards, not the header');
  assert.match(style, /\.detail \{[^}]*overflow-y: auto/u, 'the detail view brings its own scroller');
});

test('create lives in the head, and compact gets the hamburger drawer (reopened #11)', () => {
  const head = source.slice(source.indexOf('<div class="page-head">'), source.indexOf('</div>', source.indexOf('boardNew')));
  assert.match(head, /class="icon-btn" title=\{t\('boardNew'\)\}/u, 'new-issue is the head\u2019s top-right action (plain since #98 round two: the + is not a confirm)');
  assert.ok(!source.includes('class="new-issue"'), 'the bottom button is gone');
  // The drawer speaks the Chat/Terminal dialect: hamburger toggle, sheet,
  // scrim, and the back gesture closes the drawer FIRST.
  assert.match(source, /class="icon-btn side-toggle"[^>]*\n?[^>]*onclick=\{\(\) => \(sideOpen = !sideOpen\)\}/u,
    'the hamburger toggles the drawer');
  assert.match(source, /<aside class="sidebar" class:side-sheet=\{narrowVp\} class:open=\{narrowVp && sideOpen\} bind:this=\{sideEl\}>/u,
    'the sidebar wears the SHARED sheet dialect, CLASS-driven by the page\u2019s own narrow condition');
  assert.match(source, /class="side-scrim" onclick=\{\(\) => \(sideOpen = false\)\}/u, 'the scrim dismisses');
  // Back does NOT close the drawer: the drawer is the compact FLOOR — Hub's
  // own rule — lifted by the chain's last step and falling through while
  // open, so it can never cycle open/close (board #47).
  assert.match(source, /if \(narrowVp && !sideOpen && !jumped\) \{ sideOpen = true; return true; \}/u,
    'a bare compact list lifts the drawer as the floor');
  assert.ok(!/if \(sideOpen\) \{ sideOpen = false; return true; \}/u.test(source),
    'the retired drawer-peel stays retired — a peel would cycle against the lift');
  assert.match(source, /sideOpen = false; \/\/ choosing closes the drawer/u, 'picking a project closes it');
  const style = source.slice(source.indexOf('<style>'));
  assert.match(appCss, /\.side-sheet\.side-sheet\.side-sheet \{[\s\S]{0,400}?transform: translateX\(-100%\);[\s\S]{0,200}?transition: transform var\(--t-move\)/u,
    'the sheet parks off-canvas and slides — the shared motion grammar, in app.css');
  assert.ok(!/@media[^{]*\{[^{}]*\n\s*\.side-sheet \{/u.test(appCss),
    'the sheet is CLASS-driven, never media-gated — a media gate disagreed with the Hub\u2019s wider compact (owner, 2026-08-30)');
  // The SHEET's parked transform is the geometry that must not be copied; the
  // compact drill keyframes (motion.md: detail from the right, columns from the
  // left) are a different thing and live here like AgentsPage's.
  assert.ok(!style.includes('translateX(-100%)'), 'the component does not re-declare the shared geometry');
  assert.ok(!/\.sidebar[^{]*\{[^}]*transform/u.test(style), 'and gives its sidebar no transform of its own');
  assert.ok(!style.includes('.board-root.picked'), 'the second-page drilldown is retired');
});

test('a parked drawer casts no shadow back onto the page (board #14, now the SHARED sheet)', () => {
  // The guarantee moved into app.css with the one drawer dialect (owner,
  // 2026-08-30): parked = no cast, depth only while open.
  const parked = /\.side-sheet\.side-sheet\.side-sheet \{[\s\S]*?\n\}/u.exec(appCss)?.[0] ?? '';
  assert.match(parked, /transform: translateX\(-100%\);/u, 'the closed drawer is parked off-canvas');
  const shadows = [...parked.matchAll(/box-shadow:\s*([^;]+);/gu)].map((m) => m[1]?.trim());
  assert.deepEqual(shadows, ['none'], 'the closed rule has exactly one shadow declaration, and it is invisible');
  assert.match(appCss, /\.side-sheet\.side-sheet\.side-sheet\.open \{ transform: none; box-shadow: 10px 0 30px rgba\(0, 0, 0, 0\.22\); \}/u,
    'depth appears only while open');
  // The TRIPLED selector is load-bearing: each page's scoped base rule
  // (.sidebar.svelte-hash — 0,2,0) beat a single-class shared rule, the
  // sheet stayed in flow and took the top half of the screen (owner,
  // 2026-08-30: "上半部分是抽屉的内容，上下给分开了").
  assert.match(parked, /position: fixed/u, 'the sheet leaves the flow');
  assert.ok(!/\n\.side-sheet \{/u.test(appCss), 'no weaker single-class copy that a scoped rule could beat');
  // And no component keeps a private copy that could drift.
  const style = source.slice(source.indexOf('<style>'));
  assert.ok(!style.includes('box-shadow: 10px'), 'the Board carries no private sheet cast');
})

test('the sheet keeps its compositor layer WITHOUT becoming a fixed containing block (board #21)', async () => {
  // The blink: the open state is `transform: none`, so without a standing
  // compositing hint the WebView drops the sheet's layer at transitionend and
  // re-rasterizes it into the parent — a blank frame at the exact moment the
  // drawer finishes opening. Android Chrome hides that seam; the compiled
  // APK's System WebView showed it (owner, 2026-08-30).
  const parked = /\.side-sheet\.side-sheet\.side-sheet \{[\s\S]*?\n\}/u.exec(appCss)?.[0] ?? '';
  assert.match(parked, /will-change: opacity;/u,
    'the sheet is promoted for its whole mounted life, not just while the transform transitions');
  // The hint must NOT come from the containing-block family: a standing
  // transform/perspective/filter hint re-anchors position:fixed DESCENDANTS to
  // the 300px sheet (the .page lesson, and the design-language rule) — and the
  // Terminal sheet's tree really has them, verified structurally below.
  assert.ok(!/will-change:[^;]*(transform|perspective|filter)/u.test(parked),
    'no standing containing-block hint on the sheet');
  // The evidence, kept live so the constraint cannot silently expire: the
  // term-side sheet mounts Sessions, and Sessions renders dialogs whose
  // backdrop/dialog are position:fixed — they must keep the VIEWPORT.
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /<aside class="term-side" class:side-sheet=\{[^}]+\}[\s\S]{0,200}?<Sessions /u,
    'the Terminal sheet mounts Sessions inside the aside');
  const sessions = await readFile(new URL('../sessions/Sessions.svelte', import.meta.url), 'utf8');
  assert.match(sessions, /<CreateProjectDialog /u, 'Sessions renders the create dialog in its tree');
  assert.match(sessions, /<ConfirmDialog /u, 'Sessions renders the confirm dialog in its tree');
  for (const rel of ['../projects/CreateProjectDialog.svelte', '../ui/ConfirmDialog.svelte']) {
    const dlg = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.match(dlg, /<Dialog\b/u, `${rel} renders the ONE dialog shell (#317)`);
  }
  // Since #317 the overlay itself is ui/Dialog, so the constraint has one
  // owner — and stays live evidence rather than two copies of a `position`.
  const shell = await readFile(new URL('../ui/Dialog.svelte', import.meta.url), 'utf8');
  assert.match(shell, /position: fixed/u, 'the dialog shell is a fixed overlay — it must anchor to the viewport');
})

test('a feed jump opens its issue in its OWN session (board #13 follow-up)', () => {
  // The request names the session because a manual pick may have parked the
  // page elsewhere and issue ids are session-gated; the dirty-draft guard
  // still stands between the jump and an open edit.
  assert.match(source, /issueRequest = null/u, 'the request arrives as a prop');
  assert.match(source, /if \(req\.session && req\.session !== cur\) \{ cur = req\.session; picked = !embedded; \}/u,
    'the jump re-aims the page at the issue\u2019s session — embedded keeps following the room');
  assert.match(source, /const run = \(\) => \{[\s\S]*?if \(req\.session[\s\S]*?guard\(run\);/u, 'the dirty guard wraps the jump (the continuation `run`, #357: also re-checked for validity before it runs)');
  assert.match(source, /void openIssue\(req\.id\);/u, 'and the issue detail opens');
  assert.match(source, /req\.n === issueReqSeen/u, 'each request fires once — the n makes the newest win');
});

test('the board embeds in the Hub drawer without its sidebar (board #13 follow-up)', () => {
  assert.match(source, /embedded = false/u, 'embedded is a prop');
  assert.match(source, /<div class="board-root" class:embedded class:side-collapsed=\{sideCollapsed && !narrowVp && !embedded\} bind:this=\{rootEl\}>/u, 'the root wears it');
  assert.match(source, /\{#if !embedded\}\s*\n\s*<aside class="sidebar"/u, 'no project sidebar in the drawer');
  const style = source.slice(source.indexOf('<style>'));
  assert.match(style, /\.board-root\.embedded \{ grid-template-columns: minmax\(0, 1fr\); \}/u,
    'one column — the drawer names the project');
});

test('the boxes ADAPT to their content (owner, 2026-08-29)', () => {
  // Editors grow with what is typed OR what openIssue swaps in; the display
  // box hugs its content instead of banding full-width blank.
  assert.match(source, /function autoGrow\(el: HTMLTextAreaElement/u, 'one grow helper');
  assert.match(source, /bind:value=\{draft\.body\} use:autoGrow=\{draft\.body\}/u, 'the body editor wears it');
  // The create form's body does NOT autoGrow: it FILLS the leftover height
  // and scrolls inside itself (owner, 2026-08-29 follow-up).
  const style = source.slice(source.indexOf('<style>'));
  assert.match(style, /\.d-body-edit \{[^}]*min-height: 72px/u, 'min-height is a floor, not a size');
  assert.match(style, /\.n-text \{[^}]*width: fit-content/u, 'a short note is a small box');
  assert.ok(!style.includes('.n-body'), 'the display/input class collision is retired');
});

test('the create form: one-line growing title, assign, then a filling body (owner, 2026-08-29)', () => {
  const form = source.slice(source.indexOf("{:else if creating}"), source.indexOf("{:else}", source.indexOf("{:else if creating}")));
  const iTitle = form.indexOf('class="n-title one-line"');
  const iAssign = form.indexOf('<Select value={nAssignee}');
  const iBody = form.indexOf('class="d-body-edit fill"');
  assert.ok(iTitle >= 0 && iAssign > iTitle && iBody > iAssign, 'title, then assign, then the body');
  assert.match(form, /rows="1"[^>]*bind:value=\{nTitle\}[\s\S]{0,80}?use:autoGrow=\{nTitle\}/u,
    'the title starts as ONE line and grows with its text');
  const style = source.slice(source.indexOf('<style>'));
  assert.match(style, /\.n-title\.one-line \{ flex: none; resize: none; overflow: hidden; \}/u,
    'the title never stretches in the column and has no resize handle');
  assert.match(style, /\.d-body-edit\.fill \{ flex: 1;[^}]*overflow-y: auto/u,
    'the body takes the leftover height and scrolls INSIDE');
});

test('the detail speaks board #15: project-named page, status slider, confirmed changes', () => {
  // ① The page names the PROJECT, not itself — from the FULL list since
  // board #39: an empty board is hidden from the sidebar but keeps its name.
  assert.match(source, /<h1>\{boardTitle\(allProjects, cur\) \?\? \(cur \|\| t\('board'\)\)\}<\/h1>/u,
    'the title is the project name');
  // ② The status is a segmented SLIDER editing the draft: sweep (pointer
  // capture + move) or tap; nothing reaches the server until the ✓.
  assert.match(source, /onpointerdown=\{segDown\}/u, 'the track takes the pointer');
  assert.match(source, /onpointermove=\{\(e\) => segDrag && segPick\(e\)\}/u, 'sweeping slides the pick');
  // The chosen stop is a SELECTED segment, not a CTA (review, 2026-09-03):
  // design-language.md §3 says segmented active = accent border + wash, and
  // --accent-fill is reserved for solid calls to action. Since motion.md
  // principle 14 the wash and outline are carried by the ONE travelling
  // .slide-pill behind the stops (app.css atom), and the stop keeps only the
  // accent ink — so the highlight glides instead of switching.
  const pill = /\n\.slide-pill \{([^}]*)\}/u.exec(appCss)?.[1] ?? '';
  assert.match(pill, /background: var\(--accent-bg\)/u, 'the wash (on the pill)');
  assert.match(pill, /var\(--accent-line\)/u, 'the outline (on the pill)');
  const on = /\.seg-b\.on \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(on, /color: var\(--accent\)/u, 'the stop keeps the accent ink');
  assert.ok(!/background|box-shadow/u.test(on), 'and paints no wash or ring of its own — the pill carries them');
  assert.ok(!/accent-fill/u.test(on) && !/accent-fill/u.test(pill), 'never the solid CTA fill');
  assert.match(source, /<div class="seg"[^>]*\n\s*bind:this=\{segEl\}\n\s*use:slideIndicator=\{\{ key: draft\.status, active: '\.on' \}\}/u, 'the track re-measures on the draft status');
  assert.match(source, /<div class="seg"[\s\S]{0,600}?<span class="slide-pill" aria-hidden="true"><\/span>\s*\{#each STATUSES/u, 'one pill, first child of the track');
  const seg = /\.seg \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(seg, /position: relative/u, 'the track is the pill\u2019s offset parent');
  assert.match(/\.seg-b \{([^}]*)\}/u.exec(source)?.[1] ?? '', /position: relative; z-index: 1;/u, 'the stops sit above the pill');
  assert.match(source, /onclick=\{\(\) => \{ if \(!submitting\) draft\.status = st; \}\}/u, 'tapping a stop picks it — into the DRAFT');
  assert.ok(!source.includes('Select value={sel.status}'), 'the status Select is retired');
  // ③ The assignee edits the draft too — dirty raises the head\u2019s ✓/undo,
  // and only saveDraft dispatches.
  assert.match(source, /<Select value=\{draft\.assignee\}/u, 'the picker shows the draft');
  assert.match(source, /onchange=\{\(v: string\) => \{ if \(!submitting\) draft\.assignee = v; \}\}/u, 'changing it is an edit, not a write');
});

test('the four areas use the whole width; only the detail keeps a reading cap (board #96)', () => {
  // "四个区域…左右占满": an 1100px cap on .board centred the columns and wasted
  // the margins of a wide screen. The cap moved to the DETAIL view, where
  // prose and form fields genuinely read better bounded.
  const board = /\.board \{([^}]*)\}/su.exec(source)?.[1] ?? '';
  assert.ok(!/max-width/u.test(board), 'the board container is uncapped — the columns take the window');
  assert.ok(!/margin: 0 auto/u.test(board), 'and is not centred against a cap');
  const detail = /\n  \.detail \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(detail, /max-width: 1100px; margin: 0 auto; width: 100%;/u, 'the detail keeps the reading width, centred');
});

test('the slider\u2019s thumb is NESTED in the track (board #95)', () => {
  // "边缘线条都出框了…要像是真的一个滑块": the pill used to slide flush against
  // the track's own border — full control radius plus a 1px ring grinding on
  // a 1px frame, and full-height stop dividers running into it — which read
  // as lines escaping the box. A real slider nests: padded track, thumb on
  // the INNER radius (outer minus inset — the nesting rule), and short
  // centre detents that yield around the thumb.
  const seg = /\.seg \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(seg, /padding: 3px;/u, 'the track is padded — the thumb floats inside the frame');
  assert.match(source, /\.seg :global\(\.slide-pill\) \{ border-radius: calc\(var\(--ui-radius-control\) - 3px\); \}/u,
    'the thumb wears the nested radius (scoped — the rail/tab pills keep the atom\u2019s)');
  assert.match(/\.seg-b \{([^}]*)\}/u.exec(source)?.[1] ?? '', /border-radius: calc\(var\(--ui-radius-control\) - 3px\)/u,
    'the stops share the nested radius, so hover matches the thumb');
  assert.match(source, /\.seg-b \+ \.seg-b::before \{[^}]*top: 25%; height: 50%;/u,
    'detents are short centre lines, never touching the frame');
  assert.ok(!/\.seg-b \+ \.seg-b \{ border-left/u.test(source), 'the full-height dividers stay retired');
  assert.match(source, /\.seg-b\.on::before, \.seg-b\.on \+ \.seg-b::before \{ background: transparent; \}/u,
    'the pair flanking the thumb steps aside');
});

test('the bar IS Chat\u2019s page-head, and the name appears once (board #15 reopen)', () => {
  // The shared app.css dialect carries height/padding/border/type — the
  // component may not re-style it (the drift that split the sidebars once).
  assert.match(source, /<div class="page-head">/u, 'the shared class, not a scoped .head');
  const style = source.slice(source.indexOf('<style>'));
  assert.ok(!style.includes('.page-head'), 'no scoped re-style of the shared bar');
  assert.ok(!/\.head \{/u.test(style), 'the old scoped head rules are retired');
  assert.ok(!source.includes('h-session'), 'the project name is written ONCE — the session chip retired');
});

test('embedded, the Board brings no head of its own — the drawer head is the head (board #23)', () => {
  // The embedded page-head only repeated the project name the drawer head
  // already carries ("不需要 project 单独显示一行了"): the WHOLE bar is gated,
  // not just the hamburger.
  assert.match(source, /\{#if !embedded\}\s*\n\s*<div class="page-head">/u,
    'the page-head renders only on the standalone page');
  // Creation still has one entry point per surface: the drawer head's + sends
  // a request, and the guard between it and a dirty draft still stands.
  assert.match(source, /const req = createRequest;[\s\S]{0,200}?guard\(\(\) => \{ sel = null; creating = true; \}\);/u,
    'a create request routes through the same dirty-draft guard as every other jump');
});

test('four areas tile as 1, 2 or 4 — never 3 — and the BOARD is the ruler (board #27)', () => {
  // auto-fit packed as many 170px tracks as fit, so a ~560–700px board (a
  // routine drawer width) showed 3 across with the fourth orphaned on its
  // own row — neither the side-by-side reading nor the stack. The count is
  // now a ladder of container queries against the BOARD itself, so the
  // standalone page and the Hub drawer obey the same thresholds by
  // construction and the viewport plays no part.
  assert.match(source, /\.board \{[^}]*container-type: inline-size/su, 'the board is an inline-size container');
  assert.match(source, /\.board \{[^}]*container-name: board/su, 'named, so the ladder cannot silently re-anchor');
  assert.ok(!/repeat\(auto-(?:fit|fill)/u.test(source), 'no auto-packing — that is where 3 came from');
  // The complete set of shapes .cols may take: 1 (the base — since board
  // #33 a COLUMN FLEX so sparse/dense areas can size independently), 2, 4.
  assert.match(source, /\.cols \{[^}]*display: flex;\s*flex-direction: column;/su, 'the base is ONE column (flex, adaptive)');
  assert.match(source, /@container board \(min-width: 350px\) \{\s*\.cols \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/su,
    'the 2-step RESTORES the grid');
  assert.match(source, /@container board \(min-width: 710px\) \{\s*\.cols \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}\s*\}/u);
  assert.equal([...source.matchAll(/@container board/g)].length, 2, 'exactly the two steps — a third step is a fifth shape');
  assert.ok(!/repeat\(3/u.test(source), 'three columns exist nowhere');
  // The thresholds keep the cards' own 170px minimum honest (gap 10):
  // 2×170+10 = 350, 4×170+3×10 = 710 — and the 4-step sits above the 2-step.
  const steps = [...source.matchAll(/@container board \(min-width: (\d+)px\)/g)].map((m) => Number(m[1]));
  const [two = 0, four = 0] = steps;
  assert.ok(two < four, 'the ladder ascends');
  assert.ok(two >= 2 * 170 + 10 && four >= 4 * 170 + 3 * 10, 'each step affords its tracks at 170px min');
  // GRID modes (2-col stacks two rows) still share the height equally so
  // every area keeps its own scroller (the page holds still); since #33 the
  // equal-rows rule lives INSIDE the query — the 1-col base is adaptive.
  assert.match(source, /@container board \(min-width: 350px\) \{\s*\.cols \{[^}]*grid-auto-rows: minmax\(0, 1fr\);/su,
    'equal rows are a GRID rule, scoped to the ≥2-col steps');
  assert.ok(!/\.cols \{[^}]*grid-auto-rows[^}]*\}\s*@container/su.test(source.slice(0, source.indexOf('@container'))),
    'the base declares no equal rows — sparse areas must be free to hug content');
});

test('the 1-column base sizes areas by their CONTENT class — sparse hugs, dense shares (board #33)', () => {
  // Four unconditionally equal areas squeezed every real column to a
  // quarter-screen while empty ones stood stretched. The mechanism is ONE
  // class computed from the data, no fixed card heights, no JS measuring.
  assert.match(source, /\{@const items = col\(s\)\}/u, 'each area computes its items ONCE');
  assert.match(source, /class:sparse=\{items\.length <= 1\}/u, '0 or 1 card marks the area sparse');
  // The two flex behaviors, and only in the base (grid items ignore flex):
  assert.match(source, /\.colm\.sparse \{ flex: none; \}/u, 'sparse: header + content, nothing stretched');
  assert.match(source, /\.colm:not\(\.sparse\) \{ flex: 1 1 0; \}/u, 'dense areas share the leftover equally');
  // The count and the list read the SAME computation (no double col(s) call
  // that could disagree mid-poll).
  assert.match(source, /<span class="col-n">\{items\.length\}<\/span>/u, 'the header count reads items');
  assert.match(source, /\{#each items as i \(i\.id\)\}/u, 'the cards read items');
  // Every column keeps its own scroller in all shapes (#27's rule survives).
  assert.match(source, /\.col-scroll \{\s*overflow-y: auto;/su, 'the internal scroller stays');
});

test('in one column every card is compact, so a lone card cannot take the screen (board #328)', () => {
  // #33 sizes a sparse area by its content; one long card was content too.
  // The base clamps the title to 2 lines and the preview to 1; the 2-column
  // step — the same one that restores the grid — restores the full card.
  const rule = (sel: string) => new RegExp(`\\n  ${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`, 'u').exec(source)?.[1] ?? '';
  assert.match(rule('.c-title'), /-webkit-line-clamp: 2;\s*line-clamp: 2;/u, 'base: title to 2 lines');
  assert.match(rule('.c-body'), /-webkit-line-clamp: 1;\s*line-clamp: 1;/u, 'base: preview to 1 line');
  assert.match(source, /@container board \(min-width: 350px\) \{\s*\.cols \{[^}]*\}\s*\/\*[^*]*\*\/\s*\.card \.c-title \{ -webkit-line-clamp: unset; line-clamp: none; \}\s*\.card \.c-body \{ -webkit-line-clamp: 4; line-clamp: 4; \}\s*\}/su,
    'the 2-column step restores the full card');
  assert.equal([...source.matchAll(/(?<!-webkit-)line-clamp: 4/g)].length, 1, 'ONE place sets the 4-line preview');
  assert.ok(!/\.colm\.sparse \{[^}]*max-height/u.test(source), 'no second sizing rule on sparse areas');
});

test('the note reply wraps and grows — one autoGrow, chat keyboard semantics (board #28)', () => {
  // "发送消息如果消息过长要自动帮我换行，现在是一直在一行里，前边都看不到了":
  // the reply was a single-line <input> that scrolled horizontally. It is now
  // a textarea in the input's exact clothes — soft wrap is the element's
  // default, autoGrow raises it, one line at rest.
  assert.match(source, /<textarea class="note-input" rows="1"[^>]*bind:value=\{noteText\}/su,
    'the reply is a one-line-at-rest textarea');
  assert.match(source, /class="note-input"[^>]*use:autoGrow=\{noteText\}/su, 'it grows through the SHARED action');
  assert.ok(!/<input[^>]*noteText/su.test(source), 'the single-line input is gone');
  assert.equal([...source.matchAll(/function autoGrow/g)].length, 1, 'ONE autoGrow — no second copy');
  // Keyboard: Enter sends, Shift+Enter is a real newline (no preventDefault
  // on that path), and an IME composition's Enter commits the composition,
  // never the note. preventDefault on the send path keeps the sent text free
  // of a trailing newline.
  assert.match(source,
    /note-input[^>]*onkeydown=\{\(e\) => \{ if \(e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing\) \{ e\.preventDefault\(\); addNote\(\); \} \}\}/su,
    'Enter sends; Shift+Enter and IME Enter do not');
  // Sending clears the bound value, and autoGrow's update refits — that is
  // the shrink-back path, so both halves must exist.
  assert.match(source, /noteText = ''; noteStage\.clear\(\); \/\/ persisted\s*await refetchSel\(ctx\);/u, 'send clears the value');
  assert.match(source, /update: \(_v: string\) => fit\(\)/u, 'the action refits when the bound value changes');
  // The dress is the input's own (shared rule with the create title), the
  // box never shows a scrollbar while measuring, and the send button rides
  // the LAST line instead of stranding mid-text.
  assert.match(source, /\.note-input, \.n-title \{/u, 'one dress, shared');
  assert.match(source, /\.note-input \{ resize: none; overflow: hidden; \}/u);
  assert.match(source, /\.note-add \{ display: flex; gap: 6px; align-items: flex-end; \}/u,
    'the button pins to the bottom line');
});

test('the create form submits from the keyboard: title Enter, body Cmd/Ctrl+Enter, IME never (board #36)', () => {
  // Owner (2026-09-01): "我在 board 填写完 issue 描述后，可以 cmd+enter 直接
  // 提交确认". The body is MULTI-LINE, so a bare Enter must stay a newline —
  // the submit chord is Cmd+Enter (mac) / Ctrl+Enter (everywhere else), the
  // pair every chat product speaks. Both modifiers, one handler: metaKey OR
  // ctrlKey, so the contract holds cross-platform.
  assert.match(source,
    /d-body-edit fill[^>]*onkeydown=\{\(e\) => \{ if \(e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\) && !e\.isComposing\) \{ e\.preventDefault\(\); createIssue\(\); \} \}\}/su,
    'the create body submits on Cmd/Ctrl+Enter only — a bare or Shift Enter falls through to a real newline');
  // The IME guard is load-bearing on BOTH create inputs: a composition's
  // Enter commits the candidate text, never the issue (the note box set the
  // precedent, board #28). The title's plain-Enter submit shipped without
  // the guard — a CJK title committed by Enter would have created the issue
  // mid-composition.
  assert.match(source,
    /n-title one-line[^>]*onkeydown=\{\(e\) => \{ if \(e\.key === 'Enter' && !e\.shiftKey && !e\.isComposing\) \{ e\.preventDefault\(\); createIssue\(\); \} \}\}/su,
    "the title's Enter submit carries the same isComposing guard");
  // Same createIssue as the ✓ button — the chord is a trigger, not a second
  // submit path (createIssue itself holds the not-contentless + busy gates,
  // so a submit with neither field filled is a no-op from any trigger).
  const triggers = [...source.matchAll(/e\.preventDefault\(\); createIssue\(\);/g)].length;
  assert.equal(triggers, 2, 'exactly two keyboard trigger sites (title, body) — the button references the fn');
  assert.match(source, /onclick=\{createIssue\}/u, 'the ✓ button shares the one submit');
  // The DETAIL editor deliberately does NOT take the chord (lead, board #36:
  // create body is the scope; the docs mandate no uniformity): its save is
  // the diffed, guarded saveDraft button.
  assert.ok(!/d-body-edit" [^>]*onkeydown/su.test(source), 'the detail body editor binds no keydown');
});

test('the sidebar consumes ONE bulk counts read and reacts to local writes at once (board #39)', () => {
  // The bulk read rides loadProjects' parallel batch — never a per-project
  // boardList walk, which is the N+1 hub_board_counts exists to prevent.
  assert.match(source, /ask\(\(\) => boardCounts\(\)\)\.catch\(\(\) => null\)/u,
    'boardCounts joins the Promise.all batch, fail-soft');
  assert.equal([...source.matchAll(/boardList\(/g)].length, 1,
    'exactly ONE boardList call site — the current board\'s own load(), no sidebar walk');
  // The sidebar list is DERIVED through the pure filter: only boards with
  // issues render (total>0), and a local counts change re-filters without
  // waiting for any poll.
  assert.match(source, /const projects = \$derived\(visibleBoards\(allProjects, countsMap\)\);/u,
    'the shown rows are derived from the full list + counts');
  // load() folds the fresh issues into the counts map — create-first appears
  // and delete-last disappears NOW, not at the 20 s poll.
  const load = source.slice(source.indexOf('async function load()'), source.indexOf('let agents ='));
  assert.match(load, /countsMap = applyCounts\(countsMap, s, issues\);/u,
    'a successful boardList refreshes this session\'s counts immediately (keyed by the frozen session)');
  // The page-head names the CURRENT board from the FULL list: an empty board
  // is hidden from the sidebar yet still shows its name, and its main area
  // can create the first issue.
  assert.match(source, /<h1>\{boardTitle\(allProjects, cur\) \?\? \(cur \|\| t\('board'\)\)\}<\/h1>/u,
    'the h1 reads the unfiltered list with the old fallbacks');
  // No session to follow → the first NON-EMPTY board, i.e. the first row the
  // sidebar actually shows.
  assert.match(source, /if \(!cur\) cur = visibleBoards\(allProjects, countsMap\)\[0\]\?\.project\.session \?\? '';/u,
    'the default selection is the first visible board');
  // Each row's second line is the four columns in FIXED order, zeros
  // included, wearing the shared chip atoms + the one board status language.
  assert.match(source, /\{#each STATUSES as st \(st\)\}[\s\S]*?side-win-dot" style:background=\{countColor\(st\)\}[\s\S]*?\{statusLabel\(st\)\}[\s\S]*?\{c\?\.\[st as keyof BoardCountRow\] \?\? 0\}/u,
    'four chips, fixed vocabulary order, count present even at 0');
});

test('the four count chips adapt 4×1 / 2×2 / 1×4 — never a ragged 3+1 (board #39, owner)', () => {
  // Owner (2026-09-01), twice: "不要 3 1 这样的布局，列之间左侧点点要对齐",
  // then "如果一行能 放下放一行也行，甚至两行放不下，就放一列，动态适配".
  // The columns are EQUAL (1fr), so fitting is exact arithmetic on the
  // WIDEST chip — chipCols (pure, tested in board.test.ts) maps every width
  // into {4, 2, 1}. The measurement comes from a hidden GHOST row (the
  // composer's mirror-div pattern): same structure as a real row, height 0,
  // nowrap chips at natural width, carrying the sidebar's widest count so
  // digits are priced in.
  assert.match(source, /<div class="side-row proj-row mirror" aria-hidden="true">/u,
    'the ghost row measures, and assistive tech never hears it');
  assert.match(source, /bind:clientWidth=\{winsW\}/u, 'the ghost reports the row width');
  assert.match(source, /bind:clientWidth=\{chipWs\[i\]\}/u, 'each ghost chip reports its natural width');
  assert.match(source, /chipCols\(winsW, Math\.max\(\.\.\.chipWs\), CHIP_GAP_X\)/u,
    'the column count is the pure function of the measurements');
  assert.match(source, /<span class="side-wins grid" style:grid-template-columns=\{`repeat\(\$\{cols\}, minmax\(0, 1fr\)\)`\}>/u,
    'every real row wears the measured column count');
  // The shared base rule stays: 2×2 is the pre-measure fallback every width
  // can wear without a 3+1 flash.
  assert.match(appCss, /\.side-wins\.grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u,
    'the app.css base: two equal columns until the mirror reports');
  // The ghost's own clothes are load-bearing: without them it renders as a
  // VISIBLE empty row and its chips wrap — which both shows a duplicate and
  // measures the wrapped (wrong) widths.
  assert.match(appCss, /\.proj-row\.mirror \{ height: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; visibility: hidden; pointer-events: none; \}/u,
    'the ghost is zero-height, invisible and inert');
  assert.match(appCss, /\.proj-row\.mirror \.side-wins \{ flex-wrap: nowrap; \}[\s\S]{0,10}\.proj-row\.mirror \.side-win \{ flex: none; \}/u,
    'ghost chips sit nowrap at natural width — that IS the measurement');
});

test("the sidebar count chips wear the owner's four categorical colours — locally, never in the language (board #39, owner)", () => {
  // Owner (2026-09-01), third ruling on these chips: "done 和 todo 颜色又不
  // 一样了，四个设为 红 橙 黄 紫四个颜色吧" — the two near-greys (todo's
  // --text3 vs done's --status-sleep) read as inconsistent — then the FOURTH
  // (same day): "红 蓝 黄紫 吧，橙色和红色区分不明显" — at a 5px dot the
  // red/orange pair blurred, so doing swaps to BLUE. Four clearly-distinct
  // CATEGORICAL colours in board order: red, blue, yellow, purple; blue is
  // var(--accent), the app's own blue and incidentally the colour the global
  // language already gives doing. All theme tokens (a literal hex would only
  // be right in one theme), none of them the live dot's green — the first
  // ruling stands by construction. The remap stays deliberately scoped
  // (lead): the feed's "→ done" badge keeps boardStatusColor's language.
  assert.match(source,
    /const COUNT_COLORS: Record<string, string> = \{\s*todo: 'var\(--status-danger\)',\s*doing: 'var\(--accent\)',\s*review: 'var\(--status-warn\)',\s*done: 'var\(--status-purple\)',\s*\};/u,
    'the four-colour map: 红蓝黄紫 in board order, tokens only');
  assert.match(source, /const countColor = \(st: string\) => COUNT_COLORS\[st\] \?\? boardStatusColor\(st\);/u,
    'unknown statuses still delegate to the one language');
  // Purple is the only NEW token in the four-colour map. Pin BOTH theme
  // definitions: the component contract alone would stay green if one theme
  // silently lost the variable and rendered a transparent Done dot.
  const purples = [...appCss.matchAll(/--status-purple:\s*#([0-9a-f]{6})/giu)].map((m) => String(m[1]).toLowerCase());
  assert.deepEqual(purples, ['a78bfa', '7c3aed'], 'purple is defined once per theme: dark violet-400, light violet-600');
  assert.ok(!/side-win-dot" style:background=\{boardStatusColor\(st\)\}/.test(source),
    'the chip dot never bypasses the remap');
  // Colour is a garnish, not the identity: every chip carries its LABEL and
  // COUNT, so the four columns stay readable with no colour at all.
  assert.match(source, /\{statusLabel\(st\)\}<\/span>\s*<span class="b-count">/u,
    'label + count on every chip — non-colour-identifiable');
});

test('load() is pinned to the board it was asked FOR — a stale response never writes the new board (board #39 review)', () => {
  // The race: load() awaits boardList while the user switches projects; with
  // live `cur` the OLD board's response then paints its issues into the NEW
  // board and — since the counts fold — applies the old list's counts to the
  // new session, hiding/showing the wrong project in the sidebar. So the
  // session is FROZEN at entry, every RPC asks for the frozen name, and
  // every await re-checks identity before touching state.
  const load = source.slice(source.indexOf('async function load()'), source.indexOf('let agents ='));
  assert.match(load, /const s = cur;/u, 'the session is frozen at entry');
  assert.match(load, /await boardList\(s\)/u, 'the board read asks for the frozen session');
  assert.match(load, /await hubAgents\(s\)/u, 'the roster read asks for the frozen session');
  assert.ok(!/boardList\(cur\)|hubAgents\(cur\)/.test(load), 'no RPC in load() reads the LIVE cur');
  // Both awaited branches guard before writing — including the CATCH: an
  // error about a board we already left must not paint on the new one.
  assert.match(load, /const current = \(\) => cur === s && request === readSequence;/u,
    '#167: an older read of the same room cannot resurrect a later deletion');
  const guards = [...load.matchAll(/if \(!current\(\)\) return;/g)].length;
  assert.ok(guards >= 3, `every await (boardList ok/err, hubAgents ok) re-checks identity — found ${guards} guards`);
  assert.match(load, /countsMap = applyCounts\(countsMap, s, issues\);/u,
    'the counts fold names the FROZEN session, never live cur');
});

test('every destructive/discarding path confirms through the SHARED dialog (board #29)', () => {
  // Delete: the button only REQUESTS; nothing reaches boardDelete before the
  // confirm, and the executor uses the session+issue CAPTURED at request
  // time — a poll refetch, a selection change or a project switch while the
  // dialog stands open cannot redirect the delete.
  assert.match(source, /onclick=\{requestDelete\}/u, 'the delete button requests, never deletes');
  assert.match(source, /pendingDelete = \{ session: cur, id: sel\.id, title: issueRef\(sel\) \};/u,
    'the request captures its target — named via issueRef, a titleless issue confirms by its body (board #31)');
  assert.equal([...source.matchAll(/boardDelete\(/g)].length, 1, 'ONE call site, inside the confirm executor');
  assert.match(source, /await boardDelete\(cap\.session, cap\.id\);/u, 'the executor deletes the CAPTURED target');
  assert.match(source, /const cap = pendingDelete;\n\s*if \(!cap \|\| busy\) return;/u, 'busy blocks a double confirm');
  assert.match(source, /if \(cur === cap\.session\) \{\n\s*if \(sel\?\.id === cap\.id\) sel = null;/u,
    'success cleans only the MATCHING view');
  // The danger dialog is the shared component in the shared shape.
  assert.match(source, /<ConfirmDialog open=\{!!pendingDelete\} danger compact=\{narrowVp\} \{busy\}/u,
    'delete confirms in danger tone, phone-sheet aware, busy-held');
  assert.match(source, /t\('boardDeleteConfirmTitle'\)\.replace\('\{title\}', pendingDelete\?\.title \?\? ''\)/u,
    'the dialog names the captured issue — not whatever is selected now');
  // Discard: typed-but-uncreated create data is unsaved work; every exit
  // (explicit cancel, Escape, back, sidebar pick via guard) asks through the
  // SAME neutral dialog, a confirmed discard truly clears the form, and a
  // clean form navigates silently.
  assert.match(source, /const createDirty = \$derived\(creating && \(!!\(nTitle\.trim\(\) \|\| nBody\.trim\(\) \|\| nAssignee\) \|\| holds\(createStage\)\)\);/u);
  assert.match(source, /if \(dirty \|\| noteDirty \|\| createDirty\) pendingDiscard = action;/u, 'ONE guard covers both kinds of unsaved work');
  assert.match(source, /aria-label=\{t\('cancel'\)\} onclick=\{\(\) => guard\(\(\) => \(creating = false\)\)\}/u,
    'the create form\u2019s explicit cancel goes through the guard');
  assert.match(source, /if \(creating && createDirty\) \{ pendingDiscard = \(\) => \{ creating = false; \}; e\.stopPropagation\(\); return; \}/u,
    'Escape asks before dropping create data');
  assert.match(source, /if \(creating && createDirty\) \{ pendingDiscard = \(\) => \{ creating = false; \}; return true; \}/u,
    'the back gesture asks too');
  assert.match(source, /if \(pendingDelete\) \{ if \(!busy\) pendingDelete = null; return true; \}/u,
    '#167: pending Back is consumed; only an idle confirmation can dismiss');
  assert.match(source, /pendingDiscard = null; draft = \{ \.\.\.draftBase \}; nTitle = ''; nBody = ''; nAssignee = '';/u,
    'a confirmed discard actually clears the create fields');
  assert.match(source, /<ConfirmDialog open=\{!!pendingDiscard\} danger=\{false\} compact=\{narrowVp\}/u,
    'discard confirms in neutral tone, phone-sheet aware');
  assert.match(source, /note=\{creating \? t\('boardCreateDiscardNote'\) : t\('boardDiscardNote'\)\}/u,
    'the words say WHAT is lost — an uncreated issue is not an unsaved edit');
  // No second confirmation species: no browser confirm(), no hand-rolled modal.
  assert.ok(!/window\.confirm|[^.\w]confirm\(/u.test(source), 'no browser confirm');
  assert.equal([...source.matchAll(/<ConfirmDialog /g)].length, 2, 'exactly the two shared dialogs');
  // The EXTERNAL session follow is a cur write point too (#29 review): the
  // last-touched session moving under typed create data would reset the view
  // and wipe it with no dialog at all. The gate blocks on BOTH kinds of
  // unsaved work and resumes the moment they clear; the other cur writes are
  // guard-wrapped (pick, the feed jump) or fire only while no board shows.
  assert.match(source, /\$effect\(\(\) => \{ if \(session && \(!picked \|\| !cur\) && !dirty && !noteDirty && !createDirty && !submitting\) cur = session; \}\);/u,
    'the follow gate blocks dirty AND createDirty');
});

test('titles are optional, and the WIRING honors it — not just the pure helpers (board #31)', () => {
  // The lead's review point: draftValid/issueRef being green proves the
  // helpers, not the component. These pins hold the four joints where a
  // regression would silently restore the title-only world.

  // 1) The create ENTRY and the create BUTTON both speak title||body — a
  //    body-only issue must be creatable from either path.
  assert.match(source, /if \(!\(nTitle\.trim\(\) \|\| createStage\.sendable\(nBody\)\) \|\| busy \|\| blocked\(createStage\)\) return;/u,
    'createIssue gates on title OR body');
  assert.match(source, /disabled=\{!\(nTitle\.trim\(\) \|\| createStage\.sendable\(nBody\)\) \|\| busy \|\| blocked\(createStage\)\} onclick=\{createIssue\}/u,
    'the create button disables only when BOTH are empty');

  // 2) The card's title is the shared fallback, never the raw field…
  assert.match(source, /<span class="c-title">\{issueRef\(cardText\(i\)\)\}<\/span>/u,
    'a titleless card wears its body excerpt via issueRef');
  assert.ok(!/<span class="c-title">\{i\.title\}<\/span>/u.test(source),
    'the raw i.title rendering must not return');

  // 3) …and a titleless card does NOT repeat the same body as a preview.
  assert.match(source, /\{#if i\.body && i\.title\?\.trim\(\)\}<span class="c-body">/u,
    'the preview renders only under a real title — the same text twice reads as a bug');

  // 4) The wiring exists at all: issueRef is imported from the pure module.
  assert.match(source, /import \{[^}]*\bissueRef\b[^}]*\} from '\.\/board\.ts';/u,
    'issueRef comes from board.ts — no component-local copy');
});

test('the card body preview is prose, not chrome: the content font role (board #246)', () => {
  // The card is a <button>, and app.css gives every button the display face;
  // the body excerpt is the issue's text, so it must name the content role.
  assert.match(appCss, /^button \{ font-family: var\(--font-display\); \}/mu, 'the inherited face this rule overrides');
  const cBody = /\n  \.c-body \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(cBody, /font-family: var\(--font-ui\);/u, '.c-body wears --font-ui');
});

test('locked issue text is static selectable prose; the workflow stays live (board #43)', () => {
  // Exactly TWO editable branches — the title and the body. editable comes
  // from the server (assignee empty AND no agent ever touched it, 842f970);
  // the frontend only consumes it.
  const branches = [...source.matchAll(/\{#if sel\.editable\}([\s\S]*?)\{\/if\}/gu)];
  assert.equal(branches.length, 2, 'title + body, nothing else forks on editable');

  // Editable keeps the REAL inputs; locked renders the ORIGINAL text as a
  // static div — never a disabled input (an input is an edit affordance
  // whether or not it accepts keys).
  assert.match(branches[0]![1]!, /<input class="d-title-input" bind:value=\{draft\.title\}/u, 'editable title is the input');
  assert.match(branches[0]![1]!, /\{:else if sel\.title\.trim\(\)\}\s*<div class="d-title-static">\{sel\.title\}<\/div>/u, 'locked title is static text');
  assert.match(branches[1]![1]!, /<textarea class="d-body-edit" bind:this=\{bodyEl\} bind:value=\{draft\.body\}/u, 'editable body is the textarea');
  // trim() may only GATE the render — the output is the original, verbatim:
  // a CLI-written body's leading/trailing newlines are history too, and
  // pre-wrap makes them real (review blocker on ebda03b).
  assert.match(branches[1]![1]!, /\{:else if sel\.body\.trim\(\)\}[\s\S]*<div class="d-body-static">\{sel\.body\}<\/div>/u, 'locked body renders RAW');
  assert.ok(!branches[1]![1]!.includes('d-body-static">{sel.body.trim()}'), 'the display layer never rewrites the record');
  assert.ok(!/d-title-input[^>]*\bdisabled\b/u.test(source) && !/d-body-edit[^>]*\bdisabled\b/u.test(source),
    'locked is a different ELEMENT, not a disabled input');

  // The workflow controls live OUTSIDE both branches: a locked issue still
  // slides status, picks an assignee, and takes note replies — the draft
  // machinery keeps patching those (with no input bound, a patch can never
  // carry title/body, matching the server's refusal).
  for (const [, inner] of branches) {
    assert.ok(!inner!.includes('class="seg"') && !inner!.includes('<Select') && !inner!.includes('note-input'),
      'status slider / assignee / note reply never fork on editable');
  }
  assert.match(source, /class="seg" role="radiogroup"/u, 'the slider is still there');
  assert.match(source, /class="note-input"/u, 'the note composer is still there');

  // Selectability is EXPLICIT (the app shell's global user-select:none only
  // opts inputs back in): locked title/body and every historical note body
  // carry the full trio.
  const style = source.slice(source.indexOf('<style>'));
  for (const cls of ['.d-title-static', '.d-body-static', '.n-text']) {
    const at = style.indexOf(cls);
    assert.ok(at > -1, `${cls} styled`);
    const block = style.slice(at, style.indexOf('}', at));
    assert.match(block, /user-select: text/u, `${cls} selectable`);
    assert.match(block, /-webkit-user-select: text/u, `${cls} selectable in WebKit`);
    assert.match(block, /cursor: text/u, `${cls} reads as text`);
  }
});

test('a note bubble reveals ONE Copy action in Chat\u2019s own dialect (board #46)', async () => {
  // ONE state record answers "which row is open" — every transition is a
  // pure message-actions.ts function, and the gen token self-scopes the Copy beat
  // (review blocker: a global boolean let Copy A's stale timeout close
  // Copy B's row — the race is replayed executable in message-actions.test.ts).
  assert.match(source, /let acts = \$state<MessageActsState>\(MESSAGE_ACTS_IDLE\);/u, 'one open-row state');
  assert.equal(source.split('{#if acts.open === i}').length - 1, 1, 'exactly one action-row render site');
  assert.match(source, /setNoteActions\(acts\.open === i \? -1 : i\);/u, 'tap the same note to close, another to switch');

  // The clipboard gets the RAW n.body — the display trims, the record does
  // not (the #43 verbatim rule, applied to what leaves the app).
  assert.match(source, /onclick=\{\(event\) => copyNote\(i, n\.body, event\.currentTarget\)\}/u, 'copy carries identity, raw body and the live trigger');
  assert.ok(!source.includes('copyNote(n.body.trim()'), 'never the trimmed rendering');
  assert.match(source, /await copyText\(body \?\? ''\)/u, '#167 uses the shared fallback rather than a private writer');
  assert.doesNotMatch(source, /navigator\.clipboard\.writeText/u);
  // The attempt's identity is captured BEFORE the clipboard await (second
  // blocker: a deferred resolve stamped Copied onto whatever was open by
  // then); the stamp lands only into its own context, and the dismiss timer
  // arms only on a landing.
  assert.match(source, /const attempt = acts\.gen;[\s\S]{0,400}await copyText/u,
    'the attempt gen is read before the await');
  assert.match(source, /messageActsCopyFailed\(acts, attempt, t\('copyFailed'\)\);\s*if \(next === acts\) return;/u,
    'a stale resolve is orphaned — no stamp, no timer');
  assert.match(source, /if \(ok\) \{\s*const gen = next\.gen;\s*cancelCopyExpiry = scheduleCompletion\(\(\) => \{ acts = messageActsExpired\(acts, gen\); \}\);/u,
    '#167: only success expires, through the one completion scheduler');

  // Close semantics: outside pointerdown, Escape as the topmost peel, and
  // every context switch (issue open, project change) resets.
  assert.match(source, /if \(!el\?\.closest\?\.\('\.m-acts, \.n-wrap, \.n-at, \.note-feedback'\)\) setNoteActions\(-1\);/u,
    'outside pointerdown closes');
  // Escape closes via a WINDOW-capture listener (the note text is a div, so
  // focus stays on <body> and a .bmain-scoped handler never hears the key),
  // standing down for open dialogs and stopping the press it consumes.
  assert.match(source, /if \(e\.key !== 'Escape' \|\| pendingDiscard \|\| pendingDelete\) return;\n\s+setNoteActions\(-1\); e\.stopPropagation\(\);/u,
    'Escape peels the action row before the board\u2019s other layers');
  assert.match(source, /window\.addEventListener\('keydown', onEsc, true\);/u, 'at window capture, while a row is open');
  assert.match(source, /setNoteActions\(-1\); \/\/ a different issue, a fresh slate/u, 'openIssue resets');
  // The project-switch effect must UNTRACK its acts read: the effect keys on
  // `cur`, and subscribing it to what it writes loops it to death (caught
  // live as effect_update_depth_exceeded).
  assert.match(source, /untrack\(\(\) => setNoteActions\(-1\)\)/u,
    '#167 resets state and cancels expiry together, still untracked');

  // #43 must survive: a drag-selection's tail click never toggles the row.
  assert.match(source, /if \(typeof getSelection === 'function' && !\(getSelection\(\)\?\.isCollapsed \?\? true\)\) return;/u,
    'a live selection wins over the action row');

  // The dialect is SHARED, not copied: the atoms live in app.css (lifted
  // verbatim from Hub), and neither wearer re-styles them — the same
  // anti-drift rule the sidebar atoms follow.
  // #166 keeps the overlay geometry but derives its half-height offset from
  // the actual 28/44px command; both consumers retire private button paint.
  assert.match(appCss, /\.m-acts \{\n  position: absolute; z-index: 8; bottom: calc\(var\(--control-height\) \/ -2\); right: 10px;/u,
    'app.css owns the action row, out of the flow (absolute overlay)');
  assert.doesNotMatch(appCss, /\.m-acts button(?::|\s|\.)/u, 'CommandButton is the sole paint owner');
  assert.match(appCss, /justify-content: safe flex-end/u, 'short incoming bubbles fall back inside their left edge');
  assert.match(appCss, /\.m-acts > \.command-button \{ pointer-events: auto; \}/u,
    'only actual commands intercept input, not the empty alignment track');
  assert.match(source, /<CommandButton iconOnly icon=\{acts\.copied \? 'check' : 'copy'\}/u);
  assert.match(source, /\.notes \{[^}]*padding-bottom: calc\(var\(--control-height\) \/ 2\)/u,
    '#166: last-note Copy cannot take the note-add input hit region');
  assert.match(appCss, /--bubble-in: color-mix\(in srgb, var\(--bg\) 92%, white 8%\);/u,
    'the bubble surface token is global — the buttons render outside Hub');
  assert.ok(!/^\s*\.m-acts/mu.test(source.slice(source.indexOf('<style>'))), 'Board carries no scoped .m-acts rule');
  const hub = await readFile(new URL('./Hub.svelte', import.meta.url), 'utf8');
  assert.ok(!/^\s*\.m-acts/mu.test(hub.slice(hub.indexOf('<style>'))), 'Hub carries no scoped .m-acts rule either');
  assert.ok(!hub.includes("--bubble-in: color-mix"), 'Hub no longer re-declares the promoted token');

  // Accessibility: the note text stays TEXT (no role=button on it); the time
  // is the real focusable trigger, Chat's meta-trailer pattern.
  assert.ok(!/n-text[^>]*role=/u.test(source), 'the note body is text to assistive tech');
  assert.match(source, /<button class="n-at" aria-label=\{t\('hubMsgActions'\)\}\n\s+onclick=\{\(e\) => \{ e\.stopPropagation\(\);/u,
    'the time is the accessible trigger and never bubbles into the body toggle');

  // The overlay anchors to the bubble, not the row: relative fit-content
  // wrapper in Board's own clothes.
  assert.match(source, /\.n-wrap \{ position: relative; width: fit-content; max-width: 100%; \}/u,
    'the wrapper pins the overlay to the bubble corner');
  assert.match(source, /<div class="n-wrap">/u, 'and the markup wears it');
});

test('a Board note long-press stays native and never opens its Copy overlay (board #48)', () => {
  // Owner: "类似对于board里的每条也适用" (2026-09-01). Like Chat, a Board
  // note must leave touch/pen contextmenu native, then consume Android/WebKit's
  // following compatibility click before toggleNoteActs can open `.m-acts`.
  // mark() never preventDefaults, so selection remains the system's gesture.
  assert.match(source, /import \{ selectionClickGuard \} from '\.\.\/ui\/native-context-menu\.ts';/u);
  assert.match(source, /const noteSelectionClicks = selectionClickGuard\(\);/u);
  assert.match(source,
    /<div class="n-text" lang=\{hanLang\(n\.body\)\} oncontextmenu=\{\(e\) => \{ noteSelectionClicks\.mark\(e, i\); \}\} onclick=\{\(\) => toggleNoteActs\(i\)\}>/u,
    'the note only marks contextmenu; it never preventDefaults the native hold');
  const toggle = source.match(/function toggleNoteActs\(i: number\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(toggle, /if \(noteSelectionClicks\.consume\(i\)\) return;/u,
    'the following click is consumed before the selection fallback and overlay toggle');
  assert.match(toggle, /getSelection\(\)\?\.isCollapsed/u,
    'a genuine non-collapsed selection remains an independent fallback');
});

test('the \u2713 answers the edit: save returns to the board, and sits RIGHTMOST (board #48 v2)', () => {
  // Owner: "我改了后点击对勾应该自动回到主页面，不用停留在详情页。而且按钮
  // 顺序帮我调整一下，一般习惯对勾在最右边，防止误点击" (2026-09-01).
  // 1) A SUCCESSFUL save leaves the detail view — the ✓ answered the edit;
  //    a FAILED save stays put with the error and the typed draft (retry is
  //    honest, the same asymmetry createIssue already has).
  const save = source.match(/async function saveDraft\(\) \{[\s\S]*?\n  \}/u)?.[0] || '';
  assert.match(save, /sel = null;/u, 'success path returns to the list');
  assert.ok(save.indexOf('sel = null') < save.indexOf('} catch'),
    'the return is the SUCCESS path — the catch keeps the detail open');
  assert.ok(!/refetchSel\(\)/u.test(save),
    'no refetch of a detail view the save just left');
  // 2) Button order in the detail head: … spacer, trash, then the draft's
  //    undo + ✓ — the ✓ is the LAST control, and undo separates it from
  //    trash so the muscle-memory rightmost tap can never hit delete.
  const head = source.match(/<div class="d-head">[\s\S]*?onclick=\{saveDraft\}[\s\S]*?<\/div>/u)?.[0] ?? '';
  const trashAt = head.indexOf('requestDelete');
  const undoAt = head.indexOf('guard(() => {})');
  const checkAt = head.indexOf('saveDraft');
  assert.ok(trashAt >= 0 && undoAt >= 0 && checkAt >= 0, 'all three verbs live in the head');
  assert.ok(trashAt < undoAt && undoAt < checkAt,
    `order is trash < undo < \u2713 (got ${trashAt}, ${undoAt}, ${checkAt})`);
});

test('an armed confirm is a FILLED accent button — the one .go rule, confirms only (board #98)', async () => {
  // Owner (#98): the armed ✓ must be unmissable. Round two: "绿色好像是有点
  // 丑了，可以用带背景色的按钮…不要用单独的线条了，颜色也调回以前的颜色。
  // 加号按钮不用调整" — so: solid accent FILL (the grammar
  // .chip-btn.primary.danger already speaks), page-background ink, hover by
  // brightness; and .go is worn by confirms only.
  assert.match(appCss, /\.icon-btn\.go:not\(:disabled\) \{[^}]*background: var\(--accent\); color: var\(--bg\)/u,
    'a clickable ✓ is a filled accent button');
  assert.match(appCss, /\.icon-btn\.go:not\(:disabled\):hover \{[^}]*brightness/u,
    'hover answers with brightness, not a colour change');
  assert.ok(!/\.icon-btn\.go[^}]*stroke-width/u.test(appCss),
    'the lone-stroke treatment is retired (round two: 不要用单独的线条了)');
  // The boardNew + OPENS a form — not a confirm, not a .go (owner: 加号保持
  // 以前的样式). Neither entry point wears the class.
  assert.ok(!/class="icon-btn go" title=\{t\('boardNew'\)\}/u.test(source), 'Board\'s + is a plain icon-btn');
  const hub = await readFile(new URL('./Hub.svelte', import.meta.url), 'utf8');
  assert.ok(!/class="icon-btn go" title=\{t\('boardNew'\)\}/u.test(hub), 'Hub\'s + is a plain icon-btn');
  // ONE mechanism: no page redefines the go colour locally.
  const agents = await readFile(new URL('./AgentsPage.svelte', import.meta.url), 'utf8');
  assert.ok(!/\.icon-btn\.go[^}]*var\(--accent\)/u.test(agents),
    'no page redefines the go colour locally');
});

test("the Board's sidebar follows the shell-wide collapse with the Hub's reveal (board #200)", () => {
  const style = source.slice(source.indexOf('<style>'));
  assert.match(source, /sideCollapsed = false/u, 'a prop from the shell');
  assert.match(source, /const unpin = pinTrack\(sideEl, 'end'\);\s*\n\s*void moveTrack\(rootEl, '--side-open', collapsed \? 1 : 0\)\.then\(unpin\);/u);
  assert.match(source, /if \(!visible \|\| embedded \|\| narrowVp \|\| !rootEl \|\| !sideEl\) return;/u, 'no motion off-screen, in the drawer or on the phone sheet');
  assert.match(style, /\.board-root \{[^}]*--side-open: 1; grid-template-columns: minmax\(0, calc\(var\(--sidebar-w\) \* var\(--side-open\)\)\) minmax\(0, 1fr\);[^}]*overflow: hidden;/u);
  assert.match(style, /\.board-root:global\(\.moving\) \{ transition: --side-open var\(--t-move\) ease-out; \}/u);
  assert.match(style, /\.board-root\.side-collapsed \{ --side-open: 0; \}/u);
  assert.match(style, /\.board-root\.side-collapsed:not\(:global\(\.moving\)\) > \.sidebar \{ visibility: hidden; \}/u);
  assert.match(style, /\.sidebar:global\(\.pin-end\) \{ justify-self: end; \}/u);
});

test('a card names its assignee with its backend icon, and the working dot only in doing (board #293, #327)', () => {
  assert.match(source, /\{@const who = assigneeView\(i\.assignee, agents, s, backends, catalog\)\}/u,
    'one pure helper decides, told the column and this server s catalog (#335 ②b-3)');
  assert.match(source, /<span class="c-tile"><img class="ava" src=\{who\.icon\} alt="" \/>/u, 'the backend face in the app-wide .ava atom');
  assert.doesNotMatch(source, /c-tile" style:background|\.slice\(0, 1\)\.toUpperCase\(\)/u, 'no invented lettered tile on the board');
  assert.match(source, /\{#if who\.live\}<span class="c-live live-dot" aria-hidden="true"><\/span>\{\/if\}/u, 'the status language\u2019s own live cue');
  assert.match(source, /\.c-assignee \{ color: var\(--text2\); \}/u, 'the name in --text2, not accent');
  assert.equal((source.match(/hubAgents\(/gu) ?? []).length, 1, 'no second hub_agents loop');
  assert.equal([...source.matchAll(/agents\.map\(\(a\) => \(\{ value: a\.name, label: a\.name, icon: backendIcon\(a\.agent\) \?\? undefined \}\)\)/gu)].length, 2, 'both pickers wear the same face');
});

test('images: one materialized body per submit, given to the save AND the brief; refused while uploading or failed (board #329)', () => {
  const save = source.slice(source.indexOf('async function saveDraft'), source.indexOf('async function createIssue'));
  assert.match(save, /if \(!sel \|\| busy \|\| blocked\(bodyStage\)\) return;/u, 'save refuses while uploading/failed');
  assert.match(save, /const saved = \{ \.\.\.draft, body: bodyStage\.body\(draft\.body\) \};/u, 'frozen at entry');
  assert.match(save, /dispatchAssign\(ctx, id, assignee, saved\.title, saved\.body, notes\)/u, 'the brief carries the saved text');
  const create = source.slice(source.indexOf('async function createIssue'), source.indexOf('async function addNote'));
  assert.match(create, /const body = createStage\.body\(nBody\)\.trim\(\);/u);
  assert.match(create, /boardSave\(ctx\.session, \{ title, body \}\)/u);
  assert.match(create, /dispatchAssign\(ctx, created, wantAssign, title, body\)/u, 'assign-at-birth briefs the stored body');
  const note = source.slice(source.indexOf('async function addNote'), source.indexOf('// ── Delete is CONFIRMED'));
  assert.match(note, /blocked\(noteStage\)\) return;[\s\S]*const body = noteStage\.body\(noteText\)\.trim\(\);[\s\S]*await boardNote\(ctx\.session, id, body\);/u);
  // The SAME atoms as the chat: one pipeline, one strip, one image, one viewer.
  assert.match(source, /import \{ createStager, attachPaste, type Stager \} from '\.\/attachments\.svelte\.ts';/u);
  assert.equal([...source.matchAll(/<AttachStrip /g)].length, 3, 'three editors, one strip');
  assert.match(source, /<ChatImage \{src\}/u);
  assert.match(source, /import Lightbox from '\.\.\/ui\/Lightbox\.svelte';/u);
  assert.doesNotMatch(source, /fsUpload|canvas|createImageBitmap/u, 'no second upload path');
});

test('every submit acts on its frozen context, never the live cur/sel; the page registers the server-switch guard (board #329 review)', () => {
  for (const fn of ['saveDraft', 'createIssue', 'addNote']) {
    const start = source.indexOf(`async function ${fn}()`);
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    assert.match(body, /const ctx = freeze\(\);/u, `${fn} freezes its context`);
    const code = body.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /\((?:cur|sel\.id),/u, `${fn}: no live cur/sel passed to an RPC`);
    assert.doesNotMatch(code, /await [a-zA-Z]+\([^)]*\bsel\.id\b/u, `${fn}: the issue id is frozen, not read after an await`);
    assert.match(body, /submitting = true/u, `${fn} locks its editors`);
  }
  assert.match(source, /const owns = \(c: OpCtx\) => alive && c\.gen === opGen;/u);
  assert.match(source, /registerLeaveGuard\(\{\s*runtime: guardOwner,\s*page: guardPage,/u, 'the #315 walk reaches the Board, as its owner s guard');
  assert.match(source, /if \(noteDirty\) \{ await refetchSel\(ctx\); return; \}/u, 'a body save keeps a note draft on screen');
});

test('the whole draft is locked while it is submitted, and a saved draft adopts what was sent (board #329 review)', () => {
  assert.match(source, /<input class="d-title-input" bind:value=\{draft\.title\} placeholder=\{t\('boardTitlePh'\)\} readonly=\{submitting\} \/>/u);
  assert.match(source, /disabled=\{submitting\} onclick=\{\(\) => \{ if \(!submitting\) draft\.status = st; \}\}/u);
  assert.equal([...source.matchAll(/<Select value=\{(?:draft\.assignee|nAssignee)\} dense disabled=\{submitting\}/gu)].length, 2);
  assert.equal([...source.matchAll(/onremove=\{\(i\) => \{ if \(!submitting\) \w+Stage\.remove\(i\); \}\}/gu)].length, 3);
  assert.match(source, /for \(const f of Object\.keys\(patch\) as \(keyof typeof saved\)\[\]\) \{ draft\[f\] = saved\[f\]; draftBase\[f\] = saved\[f\]; \}\s*bodyStage\.clear\(\);/u,
    'the snapshot is adopted BEFORE the map is cleared and the refetch rebases');
  assert.match(source, /onviewstart=\{claimView\} onview=\{acceptView\}/u, 'each tap claims for itself');
});

test('the Board s sidebar is the Hub s union, one row template (#357, owner 2026-10-13)', () => {
  // ONE merge: the Board publishes to the generalised projects union, never a
  // second comparator or poller (tenet 9).
  assert.match(source, /import type \{ BoardUnion, BoardUnionRow \} from '\.\.\/app\/hub-union\.svelte\.ts';/u);
  assert.match(source, /union\.source\.publish\(guardOwner, serverId, \{ rows: allProjects, talk: talkMap, counts: countsMap, answered: completeOnce, failed: listFailed \}\)/u, 'it publishes its own slice, by its runtime — THE counts map as it stands (bulk batches, boardList results and local confirmations all write it), answered only once BOTH reads have answered (reviewer P1-A, R1 on 0feb403e)');
  assert.match(source, /if \(!bc\) \{ listFailed = true; return; \}/u, 'a counts failure changes a flag, never the map: it can not read as "no boards"');
  assert.doesNotMatch(source, /complete\?\.|let complete = |complete = \{/u, 'no second, frozen counts snapshot');
  assert.match(source, /\$effect\(\(\) => \(\) => \{ union\?\.source\.withdraw\(guardOwner\); \}\);/u, 'and withdraws it with the tree');
  // The row list: the union filtered by EACH SERVER'S counts, else this server's
  // own boards as single-server entries — never one shape for Aggregate and
  // another for Single.
  assert.match(source, /unionList\.rows\.filter\(\(r\) => \(r\.slice\.counts\[r\.item\.project\.session\]\?\.total \?\? 0\) > 0\)/u, 'an empty board is hidden by ITS server s counts (board #39)');
  assert.match(source, /: projects\.map\(\(p\) => \(\{ serverId, item: p, ref: sessionRef\(serverId, p\.project\.session\)/u, 'Single: this server s rows, same shape');
  assert.equal(source.match(/\{#each sideRows as r \(r\.key\)\}/gu)?.length, 1, 'ONE row template');
  assert.doesNotMatch(source, /\{#each projects as /u, 'the old per-server loop is gone');
  const row = source.slice(source.indexOf('{#each sideRows as r (r.key)}'), source.indexOf('{#each missingRows'));
  assert.match(row, /\{#if r\.tag\}<span class="p-source"><ServerTag name=\{r\.tag\} \/><\/span>\{\/if\}/u, 'the tag on its own second line, the tag rule (#360)');
  assert.match(row, /r\.slice\.counts\[p\.project\.session\]/u, 'the counts are the row s own server s');
  assert.match(row, /onclick=\{\(\) => pickRow\(r\)\}/u);
  // A foreign pick is the host s: focus + landing; the body stays one server s.
  assert.match(source, /if \(r\.serverId === serverId\) \{ pick\(r\.item\.project\.session\); return; \}\s*sideOpen = false;\s*onPickServer\?\.\(r\.ref\);/u);
  // D4: a hidden member keeps ONLY its list refresh; the age tick is shown-only.
  assert.match(source, /if \(!visible && !union\) return;\s*loadProjects\(\);\s*const iv = setInterval\(loadProjects, 20000\);\s*return \(\) => clearInterval\(iv\);/u, 'the one existing 20 s cadence, cleared when the tree goes or the member leaves (#357 rule b): no second timer, none that outlives its tree');
  assert.match(source, /\$effect\(\(\) => \{\s*if \(!visible\) return;\s*const ageIv = setInterval\(\(\) => \{ projectTick = Date\.now\(\); \}, 1000\);/u);
  // A landing with no issue opens nothing.
  assert.match(source, /if \(req\.id\) void openIssue\(req\.id\);/u);
});

test('the Board s list reads start inside a thunk: a call that throws must not strand a read already started (#357)', () => {
  // A detached runtime s gate refuses SYNCHRONOUSLY. In an array literal the
  // first read had already been issued, so a throw at the second left its
  // rejection with no handler (an unhandled rejection, seen as leaked
  // "not connected" / "B list failed" across the App suite once a HIDDEN
  // member began refreshing its list).
  assert.match(source, /const ask = <T,>\(f: \(\) => Promise<T>\): Promise<T> => \(async \(\) => f\(\)\)\(\);/u);
  assert.match(source, /ask\(\(\) => projectList\(\)\),\s*ask\(\(\) => hubRooms\(\)\)\.catch\(\(\) => \(\{ rooms: \{\} \}\)\),\s*ask\(\(\) => boardCounts\(\)\)\.catch\(\(\) => null\),/u);
  assert.doesNotMatch(source, /Promise\.all\(\[\s*projectList\(\),/u, 'no bare call in the array literal');
});

test('a landing is HELD until the board can take it, newest wins, and ONE eligibility covers the hold, the free and the continuation (#357 reviewer P1-B / R2)', () => {
  // Marking the request seen BEFORE the guard ran dropped it for good when the
  // guard refused (this board's own request running).
  assert.doesNotMatch(source, /issueReqSeen = req\.n;\s*guard\(/u, 'seen is never advanced into a guard that may refuse');
  assert.match(source, /issueReqSeen = req\.n;\s*voidLanding\(\);[^\n]*\n\s*if \(ok\) landing = req;/u, 'arrival records the newest request, voids the older, and holds it only if the board can act NOW');
  assert.match(source, /if \(!req\) \{ if \(landing \|\| landingParked\) voidLanding\(\); return; \}/u, 'a cleared request voids what it held');
  // ONE eligibility: displayed ∧ the HOST's word (focused ∧ serving) ∧ not destroyed.
  assert.match(source, /const eligible = \(\) => visible && \(scope\.eligible \? scope\.eligible\(\) : true\) && alive;/u, 'displayed ∧ focused ∧ serving (the host answers) ∧ alive');
  assert.doesNotMatch(source, /currentServerId|serverCurId|from '[^']*server-switch/u, 'the board never imports the current binding nor compares ids for it');
  assert.match(source, /const ok = eligible\(\);\s*if \(!ok\) \{ untrack\(voidLanding\); return; \}\s*if \(submitting\) return;/u, 'checked when the board frees, before it may act; ineligible voids');
  assert.match(source, /if \(gen !== landingGen \|\| !eligible\(\)\) return;/u, 'and re-checked right before the continuation runs');
  assert.match(source, /\$effect\(\(\) => \{ const ok = eligible\(\); if \(!ok && landingParked\) untrack\(voidLanding\); \}\);/u, 'a question the landing parked goes with it');
  assert.match(source, /if \(landingParked && pendingDiscard === landingParked\) pendingDiscard = null;/u, 'withdrawn from the existing guard — no new modal');
  assert.match(source, /if \(req\.id\) void openIssue\(req\.id\);\s*else sel = null;/u, 'id 0 = the board LIST: an open detail is left (dirty → the existing Keep/Discard)');
  // The transaction boundary: the question the LANDING parked is re-checked
  // BEFORE the discard clears the draft / note / attachments — not only before
  // the final navigation — and only the landing's own question is restricted.
  assert.match(source, /if \(go && go === landingParked && landingParkedOk && !landingParkedOk\(\)\) \{ voidLanding\(\); return; \}\s*pendingDiscard = null; draft = \{ \.\.\.draftBase \};/u, 'the check precedes every side effect of the Discard');
  assert.match(source, /landingParkedOk = \(\) => gen === landingGen && eligible\(\);/u);
});

test('the measurement ghost is priced by the RENDERED rows counts, not the focused server s map (#357 reviewer P2)', () => {
  assert.match(source, /const maxCount = \$derived\(Math\.max\(0, \.\.\.sideRows\.flatMap\(\(r\) => \{\s*const c = r\.slice\.counts\[r\.item\.project\.session\];/u);
  assert.doesNotMatch(source, /Object\.values\(countsMap\)\.flatMap/u, 'the old focus-only map is gone');
});

test('the Board head wears the Hub head s Name + tag atom from app.css — no local paint (#357 reviewer P2, #359 grammar)', () => {
  assert.match(source, /<div class="title-stack" class:stacked=\{narrowVp\} use:titleFit=\{\{ active: !narrowVp, key: [\s\S]*?\}\}>\s*<div class="name-line"><h1>\{boardTitle\(allProjects, cur\) \?\? \(cur \|\| t\('board'\)\)\}<\/h1><\/div>\s*<ServerTag name=\{scope\?\.tag\} \/>\s*<\/div>/u, 'name line (the name) then the tag as the stack s second item');
  const style = source.slice(source.indexOf('<style>'));
  assert.doesNotMatch(style, /title-stack|name-line/u, 'the atom is app.css s, not re-declared here');
  assert.match(appCss, /\.page-head \.title-stack \{/u);
  // #369: the Board's head wears the same ONE fit action as the Hub's (any head with a tag does).
  assert.match(source, /import \{ titleFit \} from '\.\.\/ui\/title-fit\.ts';/u);
  assert.match(source, /use:titleFit=\{\{ active: !narrowVp, key: /u, 'the phone is stacked by its own class: the action is a no-op there');
});
