// Source-contract tests for App.svelte (see docs/conventions/testing.md):
// component wiring that node can't execute is pinned by matching the source.
// If one of these fails after an intentional change, update the assertion —
// the point is that the change must be INTENTIONAL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./App.svelte', import.meta.url), 'utf8');

test('sharing a connection reports only a current successful copy; failure uses Preferences (#167)', () => {
  // Preferences.mount executes the existing error/retry channel. This source
  // contract pins App's producer without claiming a full App client mount.
  const share = source.match(/async function shareConnectionLink\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(source, /import \{ createFeedbackLifetime \} from '\.\/lib\/ui\/feedback-lifetime\.ts';/u);
  assert.match(source, /const linkFeedback = createFeedbackLifetime\(value => \{ linkCopied = value\?\.kind === 'success'; \}\);/u);
  assert.match(share, /const attempt = linkFeedback\.begin\(\);/u);
  assert.match(share, /const context = linkContext;/u);
  assert.match(share, /linkFeedback\.current\(attempt\) && context === linkContext/u);
  for (const key of ['tmux_address', 'tmux_token', 'tmux_socket']) {
    assert.ok(share.split(`localStorage.getItem('${key}')`).length >= 3, `${key} is captured and rechecked`);
  }
  assert.match(share, /const copied = await copyText\(link\);\s*if \(!current\(\)\) return;\s*if \(!copied\) throw new Error\(t\('copyFailed'\)\);/u);
  assert.match(share, /linkFeedback\.update\(attempt, \{ kind: 'success', message: t\('linkCopied'\) \}\);/u);
  assert.doesNotMatch(share, /setTimeout|linkCopied = true|console\./u);
  assert.match(source, /onShare=\{shareConnectionLink\}/u, 'the existing command error channel receives rejection');
  assert.match(share, /const params = new URLSearchParams\(\);/u);
  for (const field of ['addr', 'token', 'socket']) assert.ok(share.includes(`params.set('${field}', ${field})`));
});

test('App link feedback belongs to its page and connection, and disposes with App (#167)', () => {
  // Polling can replace serverInfo without changing the machine. A primitive
  // descriptor keeps that refresh from invalidating the copy or its timer.
  const context = source.split('\n').find(line => line.includes('const linkContext = ')) ?? '';
  assert.match(context, /const linkContext = \$derived\(JSON\.stringify\(\{ page, connected, activeAddress, serverCurId, machineId: serverInfo\.machineId \}\)\);/u);
  assert.match(source, /\$effect\(\(\) => \{ void linkContext; linkFeedback\.clear\(\); \}\);/u);
  assert.match(source, /onDestroy\(\(\) => linkFeedback\.dispose\(\)\);/u);
});

test('desktop shortcuts yield to inputs and the active modal without changing browser history (#155)', async () => {
  assert.match(source, /import \{ activeModal \} from '\.\/lib\/ui\/modal\.ts';/u);
  assert.match(source, /const onShortcut = \(event\) => \{\s*if \(isShortcutInputTarget\(event\.target\)\) return;\s*if \(activeModal\(document\)\) return;/u);
  const shortcuts = await readFile(new URL('./lib/app/shortcuts.svelte.ts', import.meta.url), 'utf8');
  assert.match(shortcuts, /\[role="combobox"\], \[role="listbox"\]/u, 'select-only comboboxes are inputs too');
});

test('desktop browser context menus are globally suppressed while touch selection stays native', () => {
  assert.match(source, /import \{ installNativeContextMenuGuard \} from '\.\/lib\/ui\/native-context-menu\.ts';/u);
  assert.match(source, /\$effect\(\(\) => installNativeContextMenuGuard\(window\)\);/u,
    'one app-shell capture listener owns the policy for every page');
});

test('the retired unread-notification store stays retired (2026-09-01)', () => {
  // The old agent-notification dots (unread.json inbox + per-window attention
  // marks) were replaced by the project room's auto-post + read cursor and the
  // derived status dots — two unread ledgers never agreed (owner: "原来我用的
  // 感觉不是很好用"). App must not resurrect the store.
  assert.doesNotMatch(source, /agent-notifications\.svelte/u);
  assert.doesNotMatch(source, /syncAgentNotifications|markWindowRead/u);
});

test('Terminal navigation and page layer exist without an active target', () => {
  // The Sessions tab was retired into Terminal (2026-08-18): the list is
  // Terminal's sidebar, so no tab starts the list and terminal is always there.
  assert.doesNotMatch(source, /const t = \['sessions'\]/u);
  assert.match(source, /t\.push\('terminal'\)/u);
  assert.doesNotMatch(source, /switchTab\('sessions'\)/u);
  assert.match(
    source,
    /<button class:active=\{page === 'terminal'[\s\S]*?\{t\('terminal'\)\}[\s\S]*?<\/button>/u,
  );
  assert.match(
    source,
    /<div class="page-layer term-page" class:hidden=\{page !== 'terminal'\} bind:this=\{termPageEl\}>/u,
  );
  // The empty state keeps the page HEADER (ui-unification: every page's head
  // survives an empty detail pane — Chat, Agents, Settings all do), so the
  // else-branch opens with `.page-head` and the empty block follows it.
  assert.match(source, /\{:else\}[\s\S]{0,400}?<div class="page-head">\s*<h1>\{t\('terminal'\)\}<\/h1>/u);
  assert.match(source, /<div class="terminal-empty">/u);
  // The empty state's "Sessions" button goes through the one opener: a touch
  // layout lifts the drawer, the desktop hands focus to the list that is
  // already on screen. Setting `sessListOpen` alone did nothing on the
  // desktop — no desktop rule reads it (review, 2026-09-03).
  assert.match(source, /<div class="terminal-empty">[\s\S]*?<button class="chip-btn" onclick=\{openSessionsList\}>/u);
  const opener = /function openSessionsList\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(opener, /if \(layout\.isTouchDevice\) \{ sessListOpen = true; return; \}/u);
  assert.match(opener, /termSideEl\?\.querySelector\('\.sessions \.content \[tabindex="0"\], \.sessions \.content button'\)\?\.focus\(\)/u,
    'desktop: focus the list itself, never the SideHandle separator');
  assert.match(source, /<aside class="term-side"[^>]*bind:this=\{termSideEl\}>/u);
});

test('the Terminal page uses the shared sidebar geometry', () => {
  // ui-unification.md §1: wherever a sidebar exists it is THE sidebar — one
  // width variable, one resize affordance. Terminal was the last holdout
  // (a hardcoded 280px column with no handle).
  assert.match(source, /\.page-layer\.term-page \{[^}]*grid-template-columns: minmax\(0, calc\(var\(--sidebar-w\) \* var\(--side-open\)\)\)/u,
    '#200: the same variable, as a REVEAL track');
  const aside = source.match(/<aside class="term-side"[\s\S]*?<\/aside>/u)?.[0] ?? '';
  assert.match(aside, /<SideHandle \/>/u, 'the sidebar carries the shared handle');
  assert.doesNotMatch(source, /grid-template-columns: 280px/u);
});

test('the session list lives inside the Terminal page, sheeted on a phone', () => {
  // One Sessions instance, mounted as the terminal page's sidebar; on a phone
  // it slides over and a pick closes it.
  const mounts = source.match(/<Sessions\b/gu) ?? [];
  assert.equal(mounts.length, 1, 'exactly one Sessions mount');
  // side-sheet is the SHARED drawer dialect (app.css), CLASS-driven: applied
  // exactly when this page's own compact condition holds — touch AND narrow,
  // the old media gate (a media-gated sheet disagreed with the Hub's wider
  // compact and stacked the sidebar into the page; owner, 2026-08-30).
  const aside = source.match(/<aside class="term-side"[\s\S]*?<\/aside>/u)?.[0] ?? '';
  assert.match(aside, /class:side-sheet=\{layout\.isTouchDevice && narrowVp\}/u);
  assert.match(aside, /class:sheet=\{layout\.isTouchDevice\}/u);
  assert.match(aside, /class:open=\{layout\.isTouchDevice && narrowVp && sessListOpen\}/u);
  assert.match(aside, /onPick=\{\(\) => sessListOpen = false\}/u);
  // The terminal's session chip opens that same sheet on a phone.
  assert.match(source, /onOpenSessions=\{layout\.isTouchDevice \? \(\) => sessListOpen = true : null\}/u);
  // The phone Back gesture uses this sheet as Terminal's FLOOR (board #58),
  // matching Chat/Board: a bare Terminal lifts it; once open it falls through
  // and stays open, so Back can never close→open cycle. A Chat jump returns
  // to Chat before the ordinary floor lift.
  const jumpAt = source.indexOf("if (page === 'terminal' && jumpedFrom)");
  const liftAt = source.indexOf("if (page === 'terminal' && layout.isTouchDevice && narrowVp && !sessListOpen)");
  assert.ok(jumpAt >= 0 && liftAt > jumpAt, 'a Chat return slot outranks the Terminal floor');
  assert.match(source, /if \(page === 'terminal' && layout\.isTouchDevice && narrowVp && !sessListOpen\) \{\s*sessListOpen = true;\s*navPush\(\);\s*return;\s*\}/u,
    'bare compact Terminal lifts the session drawer and replenishes history');
  assert.ok(!/page === 'terminal' && sessListOpen[^\n]*sessListOpen = false/u.test(source),
    'an open floor never peels closed — no open/close loop');
});

// ── The desktop rail's icon order is the user's (board #6) ──────────────────
// The pure rules (normalize / reorder / drop geometry) are tested in
// lib/app/nav-order.test.ts. What node cannot execute — which element carries
// the gesture, which one must NOT, and that the phone is untouched — is pinned
// here by matching the source.
const rail = source.match(/<nav\n?\s*class="rail"[\s\S]*?<\/nav>/u)?.[0] ?? '';
const tabbar = source.match(/<nav class="tabbar"[^>]*>[\s\S]*?<\/nav>/u)?.[0] ?? '';

test('the rail renders the SAVED order, not a hardcoded sequence', () => {
  assert.ok(rail, 'the desktop rail must still be there');
  assert.match(rail, /\{#each railSlots as slot \(slot\)\}/u, 'the icons come from railSlots');
  assert.match(source, /let railOrder = \$state\(parseRailOrder\(localStorage\.getItem\(RAIL_ORDER_KEY\)\)\)/u,
    'the order is restored from localStorage through the untrusted-read helper');
  assert.match(source, /let railSlots = \$derived\(visibleRailSlots\(/u);

  // Availability filters the RENDERING only: hub/board/agents need the bus, and
  // the stored order keeps them so a toggled-off page returns where it was put.
  assert.match(source, /p === 'hub' \|\| p === 'board' \|\| p === 'agents' \? hubEligible : true/u);
  assert.doesNotMatch(rail, /\{#if hubEligible\}/u, 'the each + availability predicate replaced the per-icon gates');

  // No icon may be hardcoded back into the rail: that is how one of them stops
  // following the user's order without anything failing.
  assert.doesNotMatch(rail, /switchTab\('/u, 'a rail icon activates through railActivate(slot)');
  assert.match(rail, /onclick=\{\(\) => railActivate\(slot\)\}/u);
  assert.match(source, /function railActivate\(slot\)[\s\S]*?slot === 'prefs'\) togglePrefs\(\)[\s\S]*?switchTab\(slot\)/u,
    'the gear is a rail page icon like the others; it just toggles instead of switching');
});

test('every page icon is draggable and the brand is not', () => {
  // Consistency is the rule the rail is judged by: every page icon carries
  // the gesture — a single icon that refuses to move is unexplainable. The
  // brand is the app's mark, not a page; the server switcher (board #55) is
  // the one CONTROL among the buttons — no slot, no drag, only a popover.
  const buttons = rail.match(/<button[\s\S]*?<\/button>/gu) ?? [];
  assert.equal(buttons.length, 3, 'the templated page button and two controls: the notification centre (#322) and the server switcher');
  // The scratch terminal's toggle LEFT the rail in #326 — beside a column of
  // page icons it read as a second Terminal page, which it is not. It lives
  // in the system status bar now (its own contract below).
  assert.doesNotMatch(rail, /scratch/u, 'no scratch control among the rail icons');
  const bellBtn = buttons.find((b) => b.includes('rail-bell')) ?? '';
  assert.doesNotMatch(String(bellBtn), /data-rail-slot|onpointerdown/u, 'the bell is a control too');
  const pageBtn = buttons.find((b) => b.includes('data-rail-slot={slot}')) ?? '';
  assert.ok(pageBtn, 'the drop geometry is read off the page button');
  assert.match(String(pageBtn), /onpointerdown=\{\(e\) => railPointerDown\(e, slot\)\}/u);
  assert.match(String(pageBtn), /class:dragging=\{railDrag\?\.slot === slot\}/u);
  const serverBtn = buttons.find((b) => b.includes('rail-server')) ?? '';
  assert.ok(serverBtn, 'the switcher is the other button');
  assert.doesNotMatch(String(serverBtn), /data-rail-slot|onpointerdown/u,
    'a control: never a drag handle, never a drop anchor');

  const brand = rail.match(/<img class="rail-brand"[^>]*>/u)?.[0] ?? '';
  assert.ok(brand, 'the brand stays at the top of the rail');
  assert.doesNotMatch(brand, /data-rail-slot|onpointerdown/u, 'the brand is not a drag handle');
  assert.match(brand, /draggable="false"/u, 'and its native image drag must not fight the gesture');

  // The gap is a member of the order (so a drag can cross it) but never a handle.
  const spacer = rail.match(/<div class="rail-spacer"[^>]*>/u)?.[0] ?? '';
  assert.match(spacer, /data-rail-slot=\{slot\}/u, 'it is a drop anchor');
  assert.doesNotMatch(spacer, /onpointerdown/u, 'it is not a drag handle');
});

test('a plain click still switches pages; a drag never does', () => {
  // The whole risk of putting a gesture on a navigation button: the press that
  // was meant to switch pages must still switch pages.
  assert.match(source, /if \(Math\.abs\(dy\) < RAIL_DRAG_THRESHOLD\) return;/u,
    'the drag only begins after the threshold, so jitter on a click is not a reorder');
  assert.match(source, /function railActivate\(slot\) \{\s*if \(railClickGuard\) \{ railClickGuard = false; return; \}/u,
    'the click that follows a drag is swallowed');
  assert.match(source, /function railPointerUp\(\)[\s\S]*?railClickGuard = true;/u, 'a committed drag arms the guard');
  assert.match(source, /function railCancelDrag\(\)[\s\S]*?if \(railDrag\) railClickGuard = true;/u,
    'an ABANDONED drag arms it too — the pointer travelled, so it was not a pick');
  assert.match(source, /railClickGuard = false;\s*railPress = \{ slot/u,
    'every fresh press clears the guard, so a stale one cannot swallow the next click');
  // Capture at pointerdown: a fast drag leaving the 34px button must keep
  // reporting to the rail rather than to whatever it passes over.
  assert.match(source, /setPointerCapture\(e\.pointerId\)/u);
});

test('a drag shows what moves and where it lands, and can be abandoned', () => {
  assert.match(rail, /class:reordering=\{!!railDrag\}/u);
  assert.match(rail, /style:transform=\{railDrag\?\.slot === slot \? `translateY\(\$\{railDrag\.dy\}px\)` : null\}/u,
    'the carried icon follows the pointer by transform — it must not reflow the rail it is measuring');
  assert.match(rail, /<div\s*class="rail-drop appear"/u, 'the insertion line — it fades in (motion.md), never grows');
  assert.match(rail, /railDropOffset\(railDrag\.rects, railDrag\.idx\)/u);
  const style = source.match(/<style>[\s\S]*<\/style>/u)?.[0] ?? '';
  assert.match(style, /\.rail-drop \{[^}]*position: absolute/u, 'absolute, so opening it cannot reflow the snapshotted rects');
  assert.match(style, /\.rail\.reordering \{[^}]*user-select: none/u);
  assert.match(style, /\.rail\.reordering \.rail-btn:not\(\.dragging\):hover/u,
    'hover is suppressed mid-drag — under the cursor it reads as a second selection');
  // Escape / resize / a lost capture all end the drag: a stranded carried icon
  // with no release is the worst failure this gesture has.
  assert.match(source, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); railCancelDrag\(\); \}/u);
  assert.match(source, /window\.addEventListener\('resize', railCancelDrag\)/u);
  assert.match(source, /window\.addEventListener\('pointerup', railPointerUp, true\)/u);
});

test('the order persists, and the DEFAULT order stores nothing', () => {
  assert.match(
    source,
    /function setRailOrder\(next\) \{[\s\S]*?railOrderToStore\(next\)[\s\S]*?localStorage\.setItem\(RAIL_ORDER_KEY, raw\)[\s\S]*?localStorage\.removeItem\(RAIL_ORDER_KEY\)/u,
    'a null from railOrderToStore REMOVES the key rather than writing the shipped order back',
  );
  assert.match(source, /setRailOrder\(railDropAt\(railOrder, railDrag\.slot, railDrag\.rects, railDrag\.idx\)\)/u,
    'the drop commits through the pure path, with the SAME index the insertion line was drawn from');
});

test('the phone keeps the shipped order — the gesture is desktop-only', () => {
  // "桌面版左侧" is the whole scope. The bottom bar is thumb geography, and
  // press-and-drag there is the terminal's scroll.
  assert.ok(tabbar, 'the mobile tab bar must still be there');
  assert.doesNotMatch(tabbar, /railSlots|railOrder|data-rail-slot|onpointerdown/u,
    'the tab bar must not learn the rail order or the gesture');
  assert.match(tabbar, /onclick=\{\(\) => switchTab\('terminal'\)\}/u, 'it stays hardcoded in the shipped order');
  // Keyboard previous/next page follows the RAIL on desktop (one order, not a
  // hidden second one) while a touch layout keeps the shipped sequence.
  assert.match(
    source,
    /const tabs = \$derived\(\(\) => \{[\s\S]*?if \(!layout\.isTouchDevice\) return railSlots\.filter\(\(s\) => s !== RAIL_GAP && s !== 'prefs'\);/u,
  );
  assert.match(source, /const tabs = \$derived[\s\S]*?if \(hubEligible\) t\.push\('hub'\);[\s\S]*?t\.push\('terminal'\);/u,
    'the touch branch is unchanged');
});

// ── Agents is a Settings category on touch, a rail page on the desktop (#10) ──
test('the phone’s tab bar has no Agents icon, and the swipe does not stop there', () => {
  // Owner, 2026-08-29: "不用单独在底下一行展示了，现在看着有点多底下的标签".
  assert.ok(tabbar, 'the tab bar must still be there');
  assert.doesNotMatch(tabbar, /switchTab\('agents'\)/u, 'no Agents icon');
  assert.doesNotMatch(tabbar, /name="bot"/u);
  assert.match(tabbar, /onclick=\{togglePrefs\}/u, 'the gear is how you reach it now');
  // A swipe that reaches a page with no icon is a page you cannot get back to.
  const touchTabs = source.match(/const t = \[\];[\s\S]*?return t;/u)?.[0] ?? '';
  assert.ok(touchTabs, 'the touch tab sequence must still be there');
  assert.doesNotMatch(touchTabs, /'agents'/u, 'agents is not a swipe stop on touch');
  assert.match(touchTabs, /t\.push\('board'\)[\s\S]*?t\.push\('files'\)[\s\S]*?t\.push\('terminal'\)/u,
    'the owner-set order: chat, board, files, terminal (2026-08-29)');
});

test('the desktop rail keeps Agents as a draggable page icon', () => {
  // The whole point of scoping this to touch: nothing about the rail changes.
  assert.match(source, /agents:\s*\{ icon: 'bots',\s*label: 'agentsTitle' \}/u, 'still a rail item, wearing the crowd glyph the roster\'s All tab wears (owner, 2026-09-23: "tab 栏上的 icon 也用我们新画的吧")');
  assert.match(rail, /\{#each railSlots as slot \(slot\)\}/u, 'still the user’s draggable order');
  assert.match(source, /\{#if hubEligible && !agentsLivesInSettings\(layout\.isTouchDevice\)\}\s*<div class="page-layer" class:hidden=\{page !== 'agents'\}>/u,
    'and still a page layer — but not mounted on touch, where Settings owns the only instance');
});

test('every route into the agent config goes through ONE device-aware entry', () => {
  // Four places had to agree or it becomes unreachable in one of them; they all
  // call openAgentsConfig, which asks nav-state where Agents lives.
  assert.match(
    source,
    /function openAgentsConfig\(name = null, kind = 'agent'\) \{[\s\S]*?if \(agentsLivesInSettings\(layout\.isTouchDevice\)\) \{[\s\S]*?prefsOpenReq = \{ tab: kind === 'team' \? 'teams' : 'agents'[\s\S]*?if \(page !== 'prefs'\) togglePrefs\(\);[\s\S]*?\} else \{\s*switchTab\('agents'\);/u,
  );
  // The Hub's "configure agent" item: Settings on a phone, the page on a desktop.
  // #258: a team name's menu asks for its team editor through the same entry.
  assert.match(source, /openAgentConfig=\{\(name, kind\) => openAgentsConfig\(name, kind\)\}/u);
  assert.doesNotMatch(source, /openAgentConfig=\{\(name\) => \{[^}]*switchTab\('agents'\)/u,
    'it must not switch straight to a page that does not exist on touch');
});

test('a saved `agents` page never strands a phone on an unreachable layer', () => {
  assert.match(source, /const nav = restoreNav\(s\.page, layout\.isTouchDevice\);\s*page = nav\.page;/u,
    'restore asks nav-state, which redirects agents → Settings on touch');
  assert.match(source, /if \(nav\.settingsTab\) prefsOpenReq = \{ tab: nav\.settingsTab, n: \+\+prefsOpenSeq \};/u);
  // The redirect effect is one of the writers, so the sequence must NOT be read
  // back off the state it writes — that effect would depend on itself.
  assert.match(source, /let prefsOpenSeq = 0;/u);
  assert.doesNotMatch(source, /prefsOpenReq\?\.n/u);
  // And ANY other route that sets the page — a deep link, an older build, the
  // bus probe — is corrected by the same rule in the redirect effect.
  assert.match(
    source,
    /if \(page === 'agents' && agentsLivesInSettings\(layout\.isTouchDevice\)\) \{\s*page = 'prefs';\s*prefsOpenReq = \{ tab: 'agents', n: \+\+prefsOpenSeq \};/u,
  );
});

test('Settings only offers the category when there is a bus and no Agents page', () => {
  // hubEligible is the desktop-server gate; agentsLivesInSettings is the device.
  assert.match(source, /showAgents=\{hubEligible && agentsLivesInSettings\(layout\.isTouchDevice\)\}/u);
  // Since #335 ②b-2 a landing is delivered only to the tree it names, so the
  // jump travels through that one guard rather than straight from the state.
  assert.match(source, /agentsEditRequest=\{landingFor\(agentsEditReq\)\}/u, 'the Hub’s jump reaches the embedded editor');
  assert.match(source, /openRequest=\{prefsOpenReq\}/u);
});

test('a jump from the chat returns THERE on back, and deliberate navigation clears it (2026-08-29)', () => {
  // The one-deep return slot: set by the chat's cross-page jumps, cleared by
  // any real tab switch, consumed at the target page's back FLOOR.
  assert.match(source, /jumpedFrom = null; \/\/ deliberate navigation stands the return slot down/u,
    'switchTab clears the slot');
  assert.match(source, /if \(from === 'hub'\) jumpedFrom = 'hub';/u, 'opening a pane from the chat remembers');
  assert.match(source, /switchTab\('files'\); jumpedFrom = 'hub';/u, 'the files jump remembers (after the switch cleared)');
  assert.match(source, /switchTab\('board'\); jumpedFrom = 'hub';/u, 'the board jump too');
  for (const p of ['files', 'board', 'terminal']) {
    assert.match(source, new RegExp(`if \\(page === '${p}' && jumpedFrom\\) \\{ switchTab\\(jumpedFrom\\); return; \\}`, 'u'),
      `${p}'s floor prefers the return slot`);
  }
  // Order matters: the slot fires only at the FLOOR — after the page's own
  // onGoBack chain (and the terminal's session sheet) had their turn.
  const idxGoBack = source.indexOf("if (page === 'board' && boardGoBack && boardGoBack())");
  const idxSlot = source.indexOf("if (page === 'board' && jumpedFrom)");
  assert.ok(idxGoBack >= 0 && idxGoBack < idxSlot, 'peel first, return second');
});

test('board back on a phone lifts the project drawer, never the terminal (board #47)', () => {
  // The bottom-bar entry's floor is the DRAWER (Board's own chain lifts it);
  // App must not add a terminal fallback below it — a fall-through re-pushes,
  // exactly like Hub. Only the chat's jump (the return slot) leaves the page.
  assert.ok(!/if \(page === 'board'\) \{ page = 'terminal'; return; \}/u.test(source),
    'the board→terminal floor stays retired');
  // Files' floor is the SAME rule (owner, on the issue): its own chain climbs
  // parent directories; App adds no terminal fallback below it either.
  assert.ok(!/if \(page === 'files'\) \{ page = 'terminal'; return; \}/u.test(source),
    'the files→terminal floor stays retired');
  assert.match(source, /<Files [^\n]*jumped=\{!!jumpedFrom\}/u, 'the files page instance gets the return-slot gate');
  // Board is told whether a return slot exists, so its drawer lift can stand
  // aside and let back fall through to the conversation.
  assert.match(source, /<Board [^\n]*jumped=\{!!jumpedFrom\}/u, 'the return slot reaches the drawer-lift gate');
});

test('Terminal confirmations delegate before jump-back or drawer floor without another history listener (#167)', () => {
  // Actual pending/idle behavior is exercised by Sessions/Projects mount
  // tests; this pins App's wiring and preserves its touch-only history owner.
  const delegate = source.indexOf("if (page === 'terminal' && sessionsGoBack?.())");
  const jump = source.indexOf("if (page === 'terminal' && jumpedFrom)");
  const floor = source.indexOf("if (page === 'terminal' && layout.isTouchDevice && narrowVp && !sessListOpen)");
  assert.ok(delegate >= 0 && delegate < jump && delegate < floor);
  assert.match(source, /if \(page === 'terminal' && sessionsGoBack\?\.\(\)\) \{ navPush\(\); return; \}/u);
  assert.match(source, /onGoBack=\{\(fn\) => sessionsGoBack = fn\}/u);
  assert.equal([...source.matchAll(/addEventListener\('popstate'/gu)].length, 1);
});

test('the multi-server registry wires migrate → deep-link → boot, in that order (board #55)', () => {
  // Migration must run BEFORE the deep-link consumer: on a pre-registry
  // client a link would otherwise create the registry via upsert, turn
  // migrateServers into a no-op, and silently drop the current user +
  // history. The consumer then upserts the linked server by address.
  const idxMigrate = source.indexOf('migrateServers(localStorage)');
  const idxConsume = source.indexOf('consumeConnectUrlParams();');
  assert.ok(idxMigrate >= 0, 'boot migrates the single-server keys');
  assert.ok(idxMigrate < idxConsume, 'migrate BEFORE the deep-link consumer');
  assert.match(source, /activateConnected\(localStorage, \{ address: a2, token: token \|\| ''/u,
    'a deep-linked server joins the registry AND activates pre-boot (parks the old current)');
});

test('the rail server switcher sits above the configure group and only places (board #55)', () => {
  // "右下角agent上边": the entry rides the RAIL_GAP branch — glued to the top
  // of the bottom group, above agents in the shipped order — and is a
  // CONTROL: no data-rail-slot, so it can never become a drag target.
  const gapBranch = source.match(/\{#if slot === RAIL_GAP\}[\s\S]*?\{:else\}/u)?.[0] ?? '';
  assert.match(gapBranch, /class="rail-btn rail-server"/u, 'the switcher lives in the gap branch');
  assert.ok(!/rail-server[^>]*data-rail-slot/u.test(source), 'a control, not a draggable slot');
  assert.match(source, /onclick=\{\(e\) => toggleServerMenu\(e\)\}/u, 'it opens the registry popover');
  assert.match(gapBranch, /class="quarter-turn" class:on=\{serverMenuOpen\}><Icon name="swap-h"/u,
    'the symmetric swap glyph makes a visible quarter turn');
  assert.doesNotMatch(gapBranch, /class="flip"/u, '180° leaves swap-h looking unchanged');
});

test('the in-place server switch keeps its order (board 315, replaces the #55 reload)', async () => {
  // websocket-client.md §#55: guards → one intent (reconnect stopped, tree
  // unmounted) → downloads suspended + unmount persistence → park the source
  // (only a connected one) → socket closed → memory reset → connect WITHOUT
  // touching the mirror → only after auth activate + come up.
  const mod = await readFile(new URL('./lib/app/server-switch.ts', import.meta.url), 'utf8');
  const fn = mod.match(/async function switchTo\(target: SwitchTarget\): Promise<void> \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  const at = (needle: string) => { const i = fn.indexOf(needle); assert.ok(i >= 0, `switchTo has ${needle}`); return i; };
  const order = [
    'await d.confirmLeave()',
    'const intent = ++seq',
    'd.stopReconnect()',
    "set({ intent, from, target, phase: 'connecting'",
    'await d.suspendDownloads()',
    'await d.afterUnmount()',
    'parkFrom(d.storage, from.id)',
    'd.disconnect()',
    'd.resetMemory()',
    'await d.connect(target.address, target.token)',
    'activateSwitched(d.storage',
    'd.comeUp(target, entry)',
  ].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the switch steps run in the documented order');
  assert.match(fn, /if \(fromConnected && from\) \{\s*await d\.suspendDownloads\(\);\s*await d\.afterUnmount\(\);\s*parkFrom\(d\.storage, from\.id\);/u,
    'only a switch that LEFT a connected server parks — retry/back never re-park');
  assert.ok((fn.match(/intent !== seq/gu) ?? []).length >= 3, 'every await re-checks that this intent still owns the switch');
  // App wires the effects into that one module and calls nothing else.
  assert.match(source, /const serverSwitch = createServerSwitch\(\{/u);
  assert.match(source, /onstate: \(st\) => \{\s*switching = st;/u);
  // The reconnect machine is told WHERE by the one reader, for the CURRENT
  // entry (board #335 ②b-2-2) — it no longer reads connection keys itself.
  assert.match(source, /target: \(\) => targetOf\(localStorage, currentServerId\(localStorage\)\),/u);
  // The downloads the switch suspends are the LEAVING server's, from that
  // runtime's own record (board #335 ②b-2-1): `bound()` still names it here,
  // because the switch suspends before `resetMemory` revokes the handle.
  // ②b-2-3: the switch RELEASES the leaving server's state — new attempts
  // forbidden, running ones suspended, all of them settled — before the
  // socket moves; and it asks only the guards of the handle it destroys.
  assert.match(source, /suspendDownloads: async \(\) => \{ const st = serverStates\.get\(scopeSwap\.bound\(\)\); if \(st\) await releaseServerState\(st\); \},/u);
  assert.match(source, /confirmLeave: \(\) => confirmLeave\(\{ leaving: scopeSwap\.bound\(\), current: page,/u);
  // Every way a handle ends goes through ONE end (app/handle-end.ts; reviewer
  // P1-a on 0b8b9038 and on 48b40082): stopped now, its state RELEASED —
  // unless the handle replacing it ADOPTED that very state (a same-machine
  // merge) — and disposed only after that. The swap awaits it, so it shows
  // nothing until the end is over.
  assert.match(source, /const ends = createHandleEnds\(\{\s*stateOf: \(runtime\) => serverStates\.get\(runtime\),\s*adoptedElsewhere: \(state, runtime\) => \{\s*const next = scopeSwap\.bound\(\);\s*return !!next && next !== runtime && serverStates\.get\(next\) === state;\s*\},\s*release: releaseServerState,\s*\}\);/u);
  assert.match(source, /invalidate: async \(gone\) => \{[\s\S]*?await ends\.end\(gone\);\s*\},/u);
  // And NOTHING else in App disposes a runtime or releases a state: the
  // revoke, the handover's terminal verdict and the swap all hand the handle
  // to that end (the switch's own pre-connect release above is a release
  // without a dispose, and the end's second release is then a no-op).
  assert.equal([...source.matchAll(/\.dispose\(\)/gu)].length, 1, 'only App s link feedback disposes itself');
  assert.equal([...source.matchAll(/releaseServerState\(/gu)].length, 1, 'the switch s pre-connect release');
  assert.match(source, /const handovers = createHandovers\(\{ end: \(runtime\) => \{ void ends\.end\(runtime\); \} \}\);/u,
    'a connect attempt s "another server" verdict ends the handle the same way');
  assert.match(source, /comeUp: \(target\) => \{[\s\S]*?swapScope\(\);[\s\S]*?bringUp\(target\.address, target\.token\);/u);
  assert.doesNotMatch(source, /location\.reload\(/u, 'no reload remains on any switch or connect path');
  assert.doesNotMatch(source, /applySwitch/u, 'the reload-era plan is gone');
});

test('every App socket owner goes through the switch module and loses ownership on a switch (board 315 review P1)', () => {
  // The address rows and the optimizer move the socket within one server;
  // they share the switch's intent, so a stale attempt never restarts the
  // reconnect loop over a newer server's socket.
  const onAddress = source.match(/onAddress=\{\(address\) => \{[\s\S]*?\n      \}\}/u)?.[0] ?? '';
  assert.match(onAddress, /serverSwitch\.connectAddress\(address,/u);
  assert.doesNotMatch(onAddress, /reconnectMachine\.start|\bconnect\(/u, 'no direct connect or reconnect start');
  const opt = source.match(/async function optimizeConnection\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(opt, /await serverSwitch\.connectAddress\(best,/u);
  assert.doesNotMatch(opt, /reconnectMachine\.start|await connect\(/u);
  // Server answers land only for the server that was asked.
  // Asked through the bound runtime (board #335 ②b-2-2), and kept only if
  // the switch still owns the intent AND that runtime is still bound.
  assert.match(source, /function serverReady\(\) \{\s*const runtime = scopeSwap\.bound\(\);\s*if \(!runtime\) return;\s*const intent = serverSwitch\.intent;\s*(?:\s*\/\/[^\n]*\n)*\s*void runtime\.probeCaps\(\(caps\) => \{\s*if \(!serverSwitch\.owns\(intent\) \|\| scopeSwap\.bound\(\) !== runtime\) return;/u,
    'published as EACH answer lands, so a quick Hub answer is not held behind backends');
  assert.match(source, /if \(caps\.hub !== null\) hubState = \{ available: caps\.hub, probed: true \};/u,
    'the Hub flag moves only on a definitive answer');
  assert.doesNotMatch(source, /\bhubRooms\(|\bbackendsList\(/u, 'App asks no capability question over the facade');
  // The only remaining direct starts are the reconnect machine's own owners.
  const starts = [...source.matchAll(/reconnectMachine\.start\(\)/gu)].length;
  assert.equal(starts, 3, 'setOnDisconnect, the visibility resume and startReconnect — each guarded by the switch state');
});

test('the leave walk holds Settings mounted while guards are asked (board 315 review P1)', () => {
  assert.match(source, /\{#if page === 'prefs' \|\| holdPages\}\s*<div class="page-layer" class:hidden=\{page !== 'prefs'\}>/u,
    'revealing another page never unmounts an Agents editor that has not answered (LeaveHost.test.svelte mirrors this)');
  assert.match(source, /\{#if page === 'settings' \|\| holdPages\}\s*<div class="page-layer connect-layer" class:hidden=\{page !== 'settings'\}>\s*<Settings /u,
    'and the connect form: a walk it started must come back to it (reviewer P1-b on 48b40082)');
  assert.match(source, /confirmLeave: \(\) => confirmLeave\(\{ leaving: scopeSwap\.bound\(\), current: page, reveal: revealPage, hold: \(on\) => \{ holdPages = on; \} \}\),/u);
  // Both server lists read one connection-state input.
  assert.equal([...source.matchAll(/<ServerList [^>]*link=\{serverLink\}/gu)].length, 2);
});

test('the shell stays through a switch; only the server-bound content tree goes (board 315)', () => {
  assert.match(source, /const shell = \$derived\(connected \|\| !!switching\);/u);
  // Since #335 ②b-1 the key is the runtime HANDLE, and the tree is inside the
  // provider bound to it: a different server is a different handle, and every
  // page below reads that server's api at init.
  assert.match(source, /\{#if switching\}[\s\S]*?class="switch-panel[\s\S]*?\{:else\}[\s\S]*?\{#key scopeRuntime\}\s*<ServerScope runtime=\{scopeRuntime\} state=\{serverStates\.get\(scopeRuntime\)\}>/u,
    'the panel replaces the content tree; a different server rebuilds it, bound to that server');
  assert.match(source, /inert=\{switching\?\.phase === 'connecting'\}/u, 'SWITCHING: the rail takes no input');
  assert.match(source, /disabled=\{!!switching\}\s*onpointerdown=\{\(e\) => railPointerDown/u,
    'FAILED: page buttons stay disabled, only the server control works');
  assert.match(source, /<nav class="tabbar" inert=\{!!switching\}>/u);
  assert.match(source, /let sysMounted = \$derived\(connected\);/u, 'the old server’s readings unmount with the connection');
});

test('the content tree is bound to one server, and only the swap binds it (board #335 ②b-1)', () => {
  // The handle is assigned in exactly ONE place — the swap's `show` — so no
  // path can hand the tree a different server without the order that makes
  // the hand-over safe (unbind, settle, invalidate, bind). A direct
  // assignment would compile, look right, and mount the new server's pages
  // beside the old server's still-live ones, because `{#key}` creates the new
  // branch before destroying the old.
  // `$state.raw`: a runtime is an opaque HANDLE, and a deep proxy over it
  // breaks the one thing it is for — identity. The A→B→A restore test found
  // this: the saved-state guard could never pass.
  assert.match(source, /let scopeRuntime = \$state\.raw\(null\);/u, 'the handle is raw App state');
  assert.match(source, /let navRestored = \$state\.raw\(null\);/u);
  assert.equal([...source.matchAll(/(?<!let )scopeRuntime = /gu)].length, 1,
    'and after its declaration only createScopeSwap({ show }) assigns it');
  assert.match(source, /show: \(runtime\) => \{ scopeRuntime = runtime; \},/u);
  assert.match(source, /settle: \(\) => tick\(\),/u, 'the settle is where Svelte runs the teardown');
  // Each runtime's server state is built in ONE place, beside the runtime and
  // after swapScope read CURRENT — never on first sight of an entry: through
  // ②b the store is the bare localStorage, whose live keys are whichever
  // server is current (board #335 ②b-2-1).
  assert.equal([...source.matchAll(/createServerState\(/gu)].length, 1, 'one place builds a server s state');
  assert.equal([...source.matchAll(/serverStates\.set\(/gu)].length, 1, 'and one place hands it to a runtime');
  assert.match(source, /function swapScope\(\) \{(?:(?!\n  \}\n)[\s\S])*?serverStates\.set\(next, stateForRuntime\(/u,
    'inside swapScope — and a same-machine merge hands the replaced handle s state over (stateForRuntime)');
  assert.match(source, /invalidate: async \(gone\) => \{\s*(?:\/\/[^\n]*\n\s*)*clearLandings\(\);\s*(?:\/\/[^\n]*\n\s*)*await ends\.end\(gone\);/u,
    'the replaced handle is ENDED, not merely forgotten: two generations can borrow one connection');
  // WHICH server is read from the registry, never passed: identity repair can
  // absorb the entry we booted as into a machine's survivor and re-point
  // CURRENT at it, and from then on the app is on the survivor.
  assert.match(source, /function swapScope\(\) \{\s*const id = currentServerId\(localStorage\);/u);
  assert.match(source, /if \(held\?\.alive\(\) && !ends\.ending\(held\) && entry && held\.id === entry\.id\) return;/u,
    'a reconnect keeps its handle — but only a handle that is still alive and not being ended: a revoked lease cannot serve the same id again');
  assert.match(source, /const held = scopeSwap\.bound\(\);/u,
    'and it asks what the swap is already heading for, or one success path mints a handle nobody shows or releases');
  // The lease is given up BEFORE the shared socket can be re-dialled
  // elsewhere, on both paths that can reach another server.
  assert.match(source, /function revokeScope\(\) \{[\s\S]{0,600}?void ends\.end\(scopeSwap\.bound\(\)\);/u,
    'stopped at once, disposed only after its release (reviewer P1-a on 48b40082)');
  assert.match(source, /function resetServerMemory\(\) \{[\s\S]{0,400}?revokeScope\(\);/u,
    'the switch revokes before its connect (resetMemory runs before connect in server-switch.ts)');
  // The connect form SUSPENDS instead, because its address may be the same
  // server: revoking there would rebuild every page on an ordinary reconnect.
  // The form's handover resumes only on a conclusion that leaves the handle
  // serving its own server, and only with the ticket of the suspension in
  // force: a stale attempt's report must not lift a live one's protection.
  // The handover's rules live in app/handover.ts, where they are tested; App
  // only opens one per attempt and ends them all when it takes the handle
  // back itself.
  assert.match(source, /function suspendScope\(\) \{\s*return handovers\.open\(scopeSwap\.bound\(\)\);\s*\}/u);
  // And asks the leave walk of the handle a connect to ANOTHER server would
  // destroy, before anything is dialled (reviewer P1-c on 0b8b9038).
  // With NO address exemption (reviewer P1-b on 48b40082): an address is not
  // an identity, and which machine answers is known only after the dial.
  assert.match(source, /function confirmFormLeave\(\) \{\s*const held = scopeSwap\.bound\(\);\s*if \(!held\?\.alive\(\)\) return Promise\.resolve\(true\);\s*return confirmLeave\(\{ leaving: held, current: page,/u);
  assert.match(source, /function revokeScope\(\) \{[\s\S]{0,400}?handovers\.endAll\(\);/u,
    'the switch ends every open handover: an attempt that comes back after it writes nothing');
  assert.match(source, /handovers\.endAll\(\);\s*const next = entry \? createSingleRuntime\(entry, \{ storage: localStorage \}\) : null;\s*(?:\s*\/\/[^\n]*\n)*\s*if \(next\) \{\s*const replaced = held \? \{ id: held\.id, state: serverStates\.get\(held\) \} : null;\s*serverStates\.set\(next, stateForRuntime\(replaced, entry\.id, \{\s*survivorOf: \(id\) => mergedInto\(localStorage, id\),\s*create: \(\) => createServerState\(localStorage\),\s*\}\)\);\s*\}\s*void scopeSwap\.swap\(next\);/u,
    'and so does a swap — the tree is changing servers');
  assert.match(source, /<Settings \{onConnected\} beforeConnect=\{suspendScope\} confirmLeave=\{confirmFormLeave\} notice=\{reconnectError\} \/>/u,
    'and the form stands the handle down before it re-dials the socket itself');
  // The person-level surfaces are OUTSIDE the server-bound subtree, which is
  // what lets that subtree render nothing while it has no runtime — and what
  // keeps the gear from opening a blank page when there is no server.
  const beforeKey = source.slice(0, source.indexOf('{#key scopeRuntime}'));
  assert.ok(beforeKey.includes('<Settings {onConnected}'), 'Settings renders outside the scope');
  assert.ok(beforeKey.includes('<Preferences {connected}'), 'and so does Preferences');
  const keyed = source.slice(source.indexOf('{#key scopeRuntime}'), source.indexOf('</ServerScope>'));
  assert.ok(!keyed.includes('<Settings') && !keyed.includes('<Preferences'), 'and neither is inside it');
  assert.match(source, /createSingleRuntime\(entry, \{ storage: localStorage \}\)/u,
    'one runtime, on the facade s slot, so Single mode keeps one socket');
  // Every path that can change which server the app is on binds the tree.
  for (const [name, pattern] of [
    // Boot's order is the pin: consume the deep link, re-read WHO owns the
    // legacy record now that a link may have made another server current,
    // then bind.
    ['boot', /consumeConnectUrlParams\(\);[\s\S]{0,300}?navLiveOwner = navProvenance\(\);[\s\S]{0,400}?swapScope\(\);/u],
    ['bringUp', /function bringUp\(addr, token\) \{[\s\S]*?swapScope\(\);/u],
    ['a first connect', /page = defaultPage\(\)|swapScope\(\);\s*\n\s*\/\/ The device default/u],
    // A failover can be the connect that first learns the machine's id, and
    // then identity repair can absorb the entry the app was on. Read within
    // the function's own body: an unbounded pattern is satisfied by any later
    // `swapScope();` in the file (a negative control showed it).
    ['a failover', /function onReconnectSuccess\(useAddr, primaryAddr, handover\) \{(?:(?!\n  \}\n)[\s\S])*?swapScope\(\);/u],
  ] as const) assert.match(source, pattern, `${name} binds the content tree`);
  // An ABSORBED entry is followed, in the one place that reads CURRENT — and
  // which ids moved is the identity layer's RECORD of the merges it made,
  // never an inference from an id being absent (reviewer P1-a, 2026-10-10).
  assert.match(source, /const entry = id \? loadServers\(localStorage\)\.find\(\(s\) => s\.id === id\) : null;\s*followMerges\(\);\s*const held = scopeSwap\.bound\(\);/u);
  assert.match(source, /function followMerges\(\) \{\s*const survivorOf = \(serverId\) => mergedInto\(localStorage, serverId\);/u,
    'the survivor comes from servers.mergedInto');
  const follow = source.match(/function followMerges\(\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  assert.doesNotMatch(follow, /known|\.has\(/u, 'and nothing reads absence as a merge');
  for (const held of ['termPane = rebind(termPane);', 'filesRef = rebind(filesRef);', 'pane: rebind(c.pane)',
    'reownSavedNav(localStorage, survivorOf);'])
    assert.ok(follow.includes(held), `the merge reaches what App holds and the record: ${held}`);
  // Every CONFIRMED runtime opens the save gate: an arrival by restoring the
  // record, a same-server return or a failover by keeping what is on screen
  // (reviewer P1-b). Before, only a restore opened it, and a merge on the
  // other two paths left it shut on the replaced handle for good.
  assert.equal([...source.matchAll(/navRestored = target;/gu)].length, 2, 'the restore and the keep, nothing else');
  assert.match(source, /async function keepNavFor\(target\) \{\s*await scopeSwap\.settled\(\);\s*if \(!target \|\| scopeSwap\.shown\(\) !== target\) return;\s*navRestored = target;/u);
  assert.match(source, /function onReconnectSuccess\(useAddr, primaryAddr, handover\) \{(?:(?!\n  \}\n)[\s\S])*?swapScope\(\);\s*void keepNavFor\(scopeSwap\.bound\(\)\);/u,
    'a failover keeps');
  assert.match(source, /to keeps its handle and remounts nothing\.\s*swapScope\(\);\s*void keepNavFor\(scopeSwap\.bound\(\)\);/u,
    'and so does the connect page s same-server return');
  // The saved navigation names its server, and the restore is filtered to the
  // server it runs against (board #335 ②b-2).
  // One answer to which server a reference names — and it is the swap's
  // CONFIRMED target, never the tick in which nothing is shown: filtering a
  // restore against that emptiness dropped every pane of the server being
  // brought up.
  assert.match(source, /function navServerId\(\) \{[\s\S]{0,600}?return scopeSwap\.bound\(\)\?\.id \?\? '';/u);
  assert.doesNotMatch(source, /navServerId\(\) \{[\s\S]{0,600}?scopeRuntime\?\.id/u,
    'the shown handle is not the answer: it is null for a tick on every swap');
  // The restore belongs to ONE confirmed runtime, runs after the bind, and
  // does nothing for a runtime that is no longer on screen.
  assert.match(source, /async function restoreNavFor\(target\) \{\s*await scopeSwap\.settled\(\);\s*if \(!target \|\| scopeSwap\.shown\(\) !== target\) return;/u);
  assert.match(source, /readLegacyNav\(localStorage, navLiveOwner\), target\.id\);/u,
    'attributed by the tracked provenance, then filtered to this runtime');
  // Provenance is KNOWN, never derived from the bytes: two servers can hold
  // byte-identical records.
  assert.match(source, /function navProvenance\(\) \{\s*const id = currentServerId\(localStorage\);\s*return id && loadServers\(localStorage\)\.some\(\(srv\) => srv\.id === id\) \? id : '';/u,
    'and it validates CURRENT against the registry rather than trusting the string');
  assert.doesNotMatch(source, /navBoot|=== boot\.raw/u, 'no byte comparison decides ownership');
  assert.match(source, /if \(!navLiveOwner\) quarantineLegacyNav\(localStorage\);\s*consumeConnectUrlParams\(\);/u,
    'an input nobody owns is copied aside BEFORE anything can overwrite it');
  // Every ARRIVAL re-reads it, because arriving is what surfaces a server's
  // slot into the live key.
  assert.equal([...source.matchAll(/(?<!let )navLiveOwner = navProvenance\(\);/gu)].length, 3,
    'the deep link, the in-place switch and the connect page all surface a slot');
  // And nothing saves over that record until the restore for the bound
  // runtime has finished.
  assert.match(source, /if \(!connected \|\| !scopeRuntime \|\| navRestored !== scopeRuntime\) return;\s*saveNav\(/u);
  assert.match(source, /saveNav\(localStorage, \{ page, pane: termPane, splitLayout, splitCells \}\);/u,
    'the saved state writes the refs App already holds, rather than rebuilding them');
  // Every reference is minted in ONE place per kind, from the bound server.
  assert.match(source, /function showPane\(session, target\) \{\s*termPane = target \? paneRef\(navServerId\(\),/u);
  assert.match(source, /function showSession\(session\) \{\s*filesRef = session \? sessionRef\(navServerId\(\), session\) : null;/u);
  // Every write to the pane assigns a REF or null — never a bare target —
  // which is what makes "the identity has one home" checkable.
  assert.match(source, /let termPane = \$state\(null\);/u);
  for (const write of [...source.matchAll(/^\s*termPane = (.+)$/gmu)].slice(1)) {
    assert.match(write[1]!, /paneRef\(navServerId\(\)|^pane;$|^null;$|^move\(termPane\);$|^rebind\(termPane\);$|^s\.pane;$/u,
      `termPane = ${write[1]} — a pane is a reference, not a target string`);
  }
  // The strings consumers and the wire take are DERIVED: a serverId cannot
  // reach a `target` or `session` argument.
  assert.match(source, /const terminalTarget = \$derived\(termPane\?\.target \?\? ''\);/u);
  assert.match(source, /const terminalSession = \$derived\(termPane\?\.session \?\? ''\);/u);
  assert.match(source, /const filesSession = \$derived\(filesRef\?\.session \?\? ''\);/u);
  assert.match(source, /<SplitView cells=\{splitViewCells\}/u, 'and the split hands over strings too');
  // What it hands over is the pane's own names and NOTHING else: a serverId
  // that reached a `target` would be sent to tmux as part of a pane address.
  const adapter = source.match(/const splitViewCells = \$derived\([\s\S]*?\)\);/u)?.[0] ?? '';
  assert.match(adapter, /target: c\.pane\?\.target \?\? '',\s*session: c\.pane\?\.session \?\? '',/u);
  assert.doesNotMatch(adapter, /serverId/u, 'the serverId stops at this boundary');
  // A rename belongs to ONE server.
  assert.match(source, /const rename = \{ serverId: navServerId\(\), from, to \};\s*const move = \(ref\) => \(ref \? retargetRef\(ref, rename\) : ref\);/u);
  // A landing names its tree, and is delivered only to that tree.
  assert.match(source, /function landingFor\(request\) \{\s*return request && request\.serverId === navServerId\(\) \? request : null;/u);
  for (const req of ['filesNavReq', 'boardIssueReq']) {
    assert.match(source, new RegExp(`${req} = \\{ serverId: navServerId\\(\\),`, 'u'), `${req} names its tree`);
  }
  assert.doesNotMatch(source, /JSON\.parse\(localStorage\.getItem\('tmux_state'\)/u,
    'nothing parses the saved state by hand any more');
  // One definition of what a landing is: the swap and the reset share it.
  assert.match(source, /function resetServerMemory\(\) \{[\s\S]*?clearLandings\(\);/u);
  assert.equal([...source.matchAll(/filesNavReq = null/gu)].length, 1,
    'the landings are cleared in clearLandings and nowhere else');
});

test('failover success RECORDS by machine identity — and never moves CURRENT (board #55)', () => {
  // onReconnectSuccess proved a DIFFERENT address of the SAME machine —
  // recordServer merges it into the one entry instead of growing a second
  // "server" (the lead-review invariant: multi-server must not break the
  // multi-address semantics), and recording is NOT activating: CURRENT
  // stays put, no reload, the failover semantics own the socket swap.
  const fn = source.match(/function onReconnectSuccess\(useAddr, primaryAddr, handover\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(fn, /recordServer\(localStorage, \{[\s\S]*?address: useAddr/u, 'the active address follows the connect');
  assert.match(fn, /machineId: mid/u, 'merged by machine identity, never by address alone');
  assert.ok(!fn.includes('activateConnected') && !fn.includes('applySwitch'),
    'failover records; it never activates');
});

test('a Settings connect to a DIFFERENT server comes up in place before onConnected (board #55 → 315)', async () => {
  // connect() swaps the socket but every server-bound memory is the old
  // server's, and the old tmux_state was never parked. The form asks
  // activateConnected AFTER auth and BEFORE onConnected: same server →
  // proceed in place, different server → onConnected(true), which resets the
  // per-server memory and remounts the tree (board 315; was location.reload()).
  const settings = await readFile(new URL('./lib/app/Settings.svelte', import.meta.url), 'utf8');
  const fn = settings.match(/async function doConnect\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  const iAct = fn.indexOf('activateConnected(localStorage');
  const iSwitched = fn.indexOf('onConnected(true)');
  const iDone = fn.indexOf('onConnected(false)');
  assert.ok(iAct >= 0 && iSwitched > iAct && iDone > iSwitched,
    'activate → a different server comes up as a switch → only then the same-server path');
  // Since #335 ②b-1 each branch also reports what it ESTABLISHED, because the
  // handle may only resume on a conclusion that leaves it serving its own
  // server. An identity-activation failure is NOT a same-server success.
  assert.match(fn, /handover\?\.settle\('other-server'\);\s*onConnected\(true\);/u);
  assert.match(fn, /handover\?\.settle\('same-server'\);\s*onConnected\(false\);/u);
  assert.match(fn, /\} catch \{[\s\S]*?handover\?\.settle\('unresolved'\);[\s\S]*?\}\s*return;/u,
    'a peer that authenticated but could not be identified is an error, not a success');
  assert.match(fn, /handover\?\.settle\('no-peer'\);/u, 'and a dial that never got there says so');
  // The host's handover is part of the liveness question, so an attempt the
  // app is no longer waiting on writes no identity and brings nothing up —
  // including one from an instance that has been unmounted.
  // Three questions, and each covers a case the others cannot: the component
  // is still there (a re-dial that bypasses the handover leaves the host's
  // ticket current), this is still the instance's latest attempt, and the app
  // is still waiting on this handover at all.
  assert.match(fn, /const live = \(\) => mounted && attempt === attempts && !cancelled && \(handover\?\.current\(\) \?\? true\);/u);
  // And the credentials are frozen before the first write, because the fields
  // stay editable while the dial is in flight.
  assert.match(fn, /const url = normalizeAddress\(address\);\s*const tok = token;\s*const sock = socket\.trim\(\);/u);
  assert.doesNotMatch(fn.slice(fn.indexOf('await connect(')), /\btoken\b(?!:)|socket\.trim\(\)/u,
    'nothing after the dial re-reads a live field');
  // Adjacent to the first identity write, not merely somewhere above it: the
  // socket and import awaits sit between the post-connect check and this
  // point, and a handover can take over while they resolve.
  assert.match(fn, /if \(!live\(\)\) return;\s*\/\/ Save machine_id → address mapping/u,
    'liveness is re-checked immediately before the first identity write');
  // And nothing may AWAIT in that window: the transport is imported
  // statically so no module load can resolve between the check and the write.
  const guarded = fn.slice(fn.lastIndexOf('if (!live()) return;', fn.indexOf('activateConnected(localStorage')),
    fn.indexOf('activateConnected(localStorage'));
  assert.doesNotMatch(guarded, /\bawait\b|import\(/u,
    'an await between the check and the identity write is a window for a newer handover');
  assert.match(fn, /machineId: mid/u, 'the learned machine identity rides the activation');
  assert.doesNotMatch(settings, /location\.reload/u);
  const on = source.match(/function onConnected\(switched = false\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(on, /if \(switched\) \{[\s\S]*?resetServerMemory\(\);[\s\S]*?centreSurface\.reset\(\);[\s\S]*?swapScope\(\);[\s\S]*?bringUp\(/u,
    'the same reset + rebind + bring-up as an in-place switch — and swapScope builds the new server s state');
});

test('the boot auto-connect RECORDS the machine identity, never activates (board #55)', () => {
  // Most sessions connect through the boot path; without this stamp an
  // entry never learns its machineId and a later connect to an alternate
  // address of the SAME machine reads as a new server (live Chromium
  // finding). Record only — the entry booted as current.
  // The boot's half after connect is bringUp (board 315 shares it).
  // Since board #335 ②b-2-2 the BOUND runtime dials (the facade only for a
  // client with no saved entry), and a dial that authenticated — as this
  // entry or, after identity repair, as another — comes up through bringUp.
  // The dial owns the socket only while its claim on the host's owner counter
  // is current (reviewer P1-b on cc5e517e): the runtime asks it before it
  // records anything, and the outcome is acted on only while it still holds.
  assert.match(source, /const owner = handovers\.claim\(\);\s*const runtime = scopeSwap\.bound\(\);\s*const dialled = runtime \? runtime\.dial\(owner\.current\) : connect\(addr, token\)\.then\(\(\) => \(\{ ok: true \}\)\);\s*dialled\.then\(\(result\) => \{\s*clearTimeout\(timeout\);\s*if \(!owner\.current\(\)\) return;/u);
  assert.match(source, /\.catch\(\(\) => \{\s*clearTimeout\(timeout\);\s*if \(owner\.current\(\)\) page = 'settings';/u);
  assert.match(source, /if \(result\.ok\) \{ bringUp\(addr, token\); return; \}\s*if \(result\.reason === 'elsewhere'\) \{ void arrivedElsewhere\(result, addr, token, owner\); return; \}/u);
  // And every reconnect attempt takes the socket through a handover of its
  // own, concluded like the form's (reviewer P1 on c5487bef).
  assert.match(source, /attempt: \(\) => handovers\.open\(scopeSwap\.bound\(\)\),/u);
  // ...decided by WHO answered, the entry recordServer returns (reviewer P1-b
  // on 372cb4af), never by CURRENT not having moved; a recording failure is
  // `unresolved`, shown, and never a resume.
  const rs = source.match(/function onReconnectSuccess\(useAddr, primaryAddr, handover\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(rs, /\(\{ entry: canonical \} = recordServer\(localStorage,/u);
  assert.match(rs, /\} catch \{[\s\S]*?handover\?\.settle\('unresolved'\);\s*reconnectError = t\('configIdentityFailed'\);/u);
  assert.match(rs, /void arrivedElsewhere\(\{ entry: canonical, machineId: mid \}, useAddr, localStorage\.getItem\('tmux_token'\) \|\| '', handover\);/u,
    'another known machine: arrive there — and the ARRIVAL concludes the handover, after the walk');
  // A merge is concluded by the swap, never by a verdict (reviewer P1-a on
  // 48b40082): a verdict would end the handle before the survivor adopted
  // its state, and release what the survivor is about to take over.
  assert.match(rs, /if \(held && held\.id === canonical\.id\) handover\?\.settle\('same-server'\);\s*swapScope\(\);/u);
  assert.doesNotMatch(rs, /settle\('other-server'\)/u);
  assert.doesNotMatch(rs, /held\.id === currentServerId/u, 'CURRENT not moving is not an identity');
  // A SUPERSEDED dial reports nothing: whoever took the socket over owns the
  // outcome, and sending the app to Settings would undo a connect that is
  // succeeding. No mount can stage the race on the boot path, so it is pinned.
  assert.match(source, /if \(result\.reason !== 'superseded'\) page = 'settings';/u);
  const fn = (source.match(/dialled\.then\(\(result\) => \{[\s\S]*?\n    \}\)/u)?.[0] ?? '') + (source.match(/function bringUp\(addr, token\) \{[\s\S]*?\n  \}/u)?.[0] ?? '');
  assert.match(fn, /recordServer\(localStorage, \{[\s\S]*?machineId: mid/u, 'boot stamps the identity');
  assert.ok(!fn.includes('activateConnected'), 'boot never activates — it IS the current server');
  // ONE exception, kept out of that path on purpose (reviewer P1-a on
  // cc5e517e): the address answered as ANOTHER known machine and both entries
  // stay, so the socket is B's and the app arrives at B like the connect page
  // does. Only when CURRENT did not already move.
  const elsewhere = source.match(/async function arrivedElsewhere\(result, addr, token, attempt\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(elsewhere, /^async function arrivedElsewhere\(result, addr, token, attempt\) \{\s*if \(currentServerId\(localStorage\) === result\.entry\.id\) \{ bringUp\(addr, token\); return; \}/u,
    'an absorbed alias already moved CURRENT: just come up');
  // Arriving destroys A's tree: A's editors are asked first (reviewer, 18:54
  // on 5ca0e79e), and nothing — no verdict, no park — happens before they
  // answer. A stay holds the handle and closes B's socket.
  assert.match(elsewhere, /leave = await confirmLeave\(\{ leaving: scopeSwap\.bound\(\), current: page,[\s\S]*?if \(!attempt\.current\(\)\) return;\s*if \(!leave\) \{\s*attempt\.settle\?\.\('unresolved'\);\s*disconnect\(\);/u);
  assert.ok(elsewhere.indexOf('confirmLeave(') < elsewhere.indexOf("settle?.('other-server')")
    && elsewhere.indexOf("settle?.('other-server')") < elsewhere.indexOf('activateConnected('), 'ask, then conclude, then write');
  assert.match(elsewhere, /activateConnected\(localStorage,[\s\S]*?if \(act\.reload\) \{ onConnected\(true\); return; \}/u,
    'both kept: arrive at B through the connect page s different-server path');
});

test('doConnect never writes the live tmux_machine_id — activateConnected owns it (board #55)', async () => {
  // Lead blocker #2: the form pre-wrote the NEW machine's id into the live
  // key before activating, so parkAndPoint filed it under the OLD server's
  // parking slot. The map (tmux_machines, keyed by machineId) stays the
  // form's to update; the live key belongs to the activation.
  const settings = await readFile(new URL('./lib/app/Settings.svelte', import.meta.url), 'utf8');
  const fn = settings.match(/async function doConnect\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(!fn.includes("setItem('tmux_machine_id'"), 'no live machine-id pre-write in the form');
  assert.match(fn, /setItem\('tmux_machines'/u, 'the identity MAP update stays');
  // The boot path may write it: its server IS the current entry, no park to poison.
  const boot = (source.match(/dialled\.then\(\(result\) => \{[\s\S]*?\n    \}\)/u)?.[0] ?? '') + (source.match(/function bringUp\(addr, token\) \{[\s\S]*?\n  \}/u)?.[0] ?? '');
  assert.match(boot, /recordServer\(localStorage[\s\S]*?setItem\('tmux_machine_id', mid\)/u,
    'boot stamps the live key AFTER recording — it is the current server');
});

test('removing a saved server goes through the shared ConfirmDialog (board #55)', async () => {
  // Lead blocker #3: the × called removeServer directly — a destructive path
  // with no confirmation, in a dense popover. The × only CAPTURES the row's
  // identity, the shared dialog asks, and the confirm consumes the captured id
  // — never a re-read of the list or the current id, so a list that switched
  // or closed cannot retarget a delayed confirm. Lives in the ONE ServerList.
  const list = await readFile(new URL('./lib/app/ServerList.svelte', import.meta.url), 'utf8');
  assert.match(list, /victim = \{ id: s\.id, name: s\.name \}/u, 'the × only captures identity at click time');
  const fn = list.match(/function confirmRemove\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(fn, /const v = victim/u, 'confirm consumes the CAPTURED identity');
  assert.match(fn, /onremove\(v\.id\)/u, 'and removes by that id alone');
  assert.match(list, /<ConfirmDialog open=\{!!victim\}[\s\S]*?onconfirm=\{confirmRemove\} oncancel=\{\(\) => \(victim = null\)\}/u,
    'the shared dialog, cancel drops the capture');
  assert.match(source, /function serverRemove\(id\) \{ serverList = removeServer\(localStorage, id\);/u, 'App removes by the id it is handed');
});

test('one system-vitals strip serves desktop sidebar and an open phone drawer (board #85)', () => {
  // ONE component (src/lib/system/), transport injected from ws.ts — App
  // wires, it does not re-implement or mount one poller per page.
  assert.match(source, /import SystemStatus from '\.\/lib\/system\/SystemStatus\.svelte'/u,
    'the shared component, not a second rendering');
  assert.match(source, /import \{[^}]*\bsystemStatus\b[^}]*\} from '\.\/lib\/core\/ws\.ts'/u,
    'the typed wrapper is the injected transport');
  assert.equal((source.match(/<SystemStatus\b/gu) ?? []).length, 1, 'exactly one sampler component');
  assert.match(source, /load=\{systemStatus\}/u, 'load is INJECTED — the component never imports ws');
  assert.match(source, /sysMounted = \$derived\(connected\)/u,
    'connected clients share one sampler; layout only decides visibility');
  assert.match(source, /<main[^>]*class:touch-layout=\{shell && layout\.isTouchDevice\}/u,
    'touch mode is explicit on the shell');
  assert.match(source, /\{#if sysMounted\}[\s\S]{0,1600}<aside class="sys-sidebar compact-tools"[\s\S]{0,100}<SystemStatus/u,
    'mount gate wraps the sidebar strip');
  assert.match(source, /<SystemStatus[^/]*visible=\{connected\}/u,
    'a disconnect stops the singleton timer');
  // Desktop: exact sidebar column and exact reservation, never a main footer.
  assert.match(source, /\.sys-sidebar \{[^}]*position: fixed[^}]*left: 46px[^}]*width: var\(--sidebar-w\)/u,
    'desktop strip is confined to the primary sidebar column');
  assert.match(source, /--sys-sidebar-h: 24px/u, 'one compact named height owns geometry');
  // The bar also carries the scratch terminal's toggle (#326, owner: "可以把
  // 它放到我们的系统状态栏里"), desktop only, sized from the shared control
  // tokens so the bar reserves room instead of clipping it — and so a touch
  // device on the DESKTOP layout still gets a 44px target.
  assert.match(source, /<aside class="sys-sidebar compact-tools"[\s\S]{0,400}\{#if !layout\.isTouchDevice\}\s*\n\s*<button\s*\n\s*class="sys-scratch"/u,
    'the control sits beside the readings, in the one status bar');
  const ctl = source.slice(source.indexOf('class="sys-scratch"'), source.indexOf('><Icon name="terminal" size={14} /></button>'));
  assert.match(ctl, /aria-label=\{t\('scratchTitle'\)\}/u);
  assert.match(ctl, /aria-pressed=\{scratchOpen\}/u, 'the toggle states whether the panel is open');
  assert.match(ctl, /use:hoverInfo=\{\(\) => \{ const key = shortcutsOn \? shortcuts\.get\('toggleScratch'\) : ''/u,
    'the hover card still names it and its shortcut');
  assert.match(source, /--sys-ctl: 20px;/u, 'a mouse target that fits the 24px bar');
  // The bar and its control NEVER grow, on any pointer type (owner,
  // 2026-10-10: "现在把那一栏整体撑得特别高…需要维持得小一点"). #326 let a
  // coarse pointer take the control to --control-height and grew the bar with
  // it, so a desktop that merely REPORTS coarse — a touchscreen laptop in the
  // desktop layout, a trackpad answering coarse — showed a 48px strip to a
  // user holding a mouse. The control is rendered only where the layout says
  // there is no touch user, so what a coarse pointer gets is a bigger HIT
  // AREA, bounded by the bar's own box.
  assert.equal((source.match(/--sys-sidebar-h: /gu) ?? []).length, 1, 'one declaration of the bar height, nothing overrides it');
  assert.equal((source.match(/--sys-ctl: /gu) ?? []).length, 1, 'and one of the control size');
  const coarse = [...source.matchAll(/@media \(any-pointer: coarse\) \{([\s\S]*?)\n  \}/gu)].map((m) => m[1] ?? '');
  assert.equal(coarse.length, 1, 'the one coarse block this file has (the scan must keep finding it)');
  for (const block of coarse) {
    assert.doesNotMatch(block, /--sys-ctl|--sys-sidebar-h|main\.with-rail/u,
      'no pointer type resizes the bar or its control');
    assert.match(block, /\.sys-scratch::after \{[^}]*position: absolute;[^}]*inset: -2px -6px;/u,
      'a coarse pointer gets the hit area instead, inside the bar: 2px of its padding, 6px of dead space sideways');
  }
  assert.match(source, /\.sys-scratch \{[^}]*position: relative;/u, 'which needs the control to be the offset parent');
  assert.match(source, /\.sys-scratch \{[^}]*width: var\(--sys-ctl\); height: var\(--sys-ctl\)/u, 'one token sizes both');
  // The paint is gone at rest and appears for hover and press only (owner,
  // 2026-10-10: "那个背景不用一直显示，就是我鼠标移上去，或者我点击的时候能
  // 看到的形状"), in the icon-only family's own two states (.icon-btn).
  assert.match(source, /\.sys-scratch \{[^}]*background: none;/u, 'no background at rest');
  assert.match(source, /\.sys-scratch:hover \{ color: var\(--text\); background: var\(--surface2\); \}/u, 'hover wash');
  assert.match(source, /\.sys-scratch:active \{ color: var\(--accent\); background: var\(--accent-bg\); \}/u, 'press wash');
  assert.match(source, /\.sys-scratch\.open \{ color: var\(--accent\); \}/u,
    'and an OPEN panel is ink only — a wash would be a background showing all the time');
  // #337: a 20px square with --control-radius (12) IS a circle, which the
  // owner stopped in #218/#219. The corner comes from the PAINT token and the
  // bar wears the existing dense-group setter that scales it to 5px — no raw
  // px, same family as the Files toolbar's 20px squares.
  assert.match(source, /<aside class="sys-sidebar compact-tools"/u, 'the bar is a dense tool group');
  assert.match(source, /\.sys-scratch \{[^}]*border-radius: var\(--control-paint-radius\)/u,
    'the control takes the dense paint corner, never a field radius');
  assert.doesNotMatch(source.slice(source.indexOf('.sys-scratch {'), source.indexOf('.sys-scratch:hover')),
    /border-radius: (?:var\(--control-radius\)|var\(--ui-radius-control\)|\d+px|50%)/u,
    'and no field corner, literal or circle');
  assert.match(source, /\.with-rail :global\(\.sidebar\),\s*\.with-rail \.term-side,\s*\.with-rail :global\(\.files-left\) \{[^}]*padding-bottom: var\(--sys-sidebar-h\)/u,
    'every desktop primary sidebar reserves the exact strip height');
  // Touch: hidden at rest, shown only with the shared drawer's real OPEN
  // class, identical width/z-layer, and the open drawer reserves safe-area
  // inclusive bottom space so its final row stays reachable.
  assert.match(source, /\.touch-layout \.sys-sidebar \{[^}]*display: none[^}]*left: 0[^}]*width: min\(300px, 86vw\)[^}]*z-index: 27/u,
    'phone strip is parked and shares the drawer geometry');
  assert.match(source, /\.touch-layout:has\(:global\(\.page-layer:not\(\.hidden\) \.side-sheet\.open\)\) \.sys-sidebar \{ display: flex; \}/u,
    'an actually open shared drawer reveals it');
  assert.match(source, /\.touch-layout:has\(:global\(\.page-layer:not\(\.hidden\) \.side-sheet\.open\)\) :global\(\.side-sheet\.open\) \{[^}]*padding-bottom: calc\(var\(--sys-sidebar-h\) \+ var\(--sab\)\)/u,
    'the open drawer reserves status plus safe area');
  assert.ok(!/sys-footer/u.test(source), 'the retired full-width footer cannot regrow');
});

test('a typed address ends the running reconnect loop before it connects (review 2026-09-03)', async () => {
  // onAddress is a NEW intent. Without cancel() first, the machine's next
  // attempt raced this socket; ws.ts superseded the loser, whose 'connection
  // timeout' then marked a reachable address unreachable for two minutes.
  // Since board 315 the order lives in server-switch.ts connectAddress.
  const mod = await readFile(new URL('./lib/app/server-switch.ts', import.meta.url), 'utf8');
  assert.match(mod, /async function connectAddress\(address: string, token: string\)[\s\S]*?const intent = \+\+seq;\s*d\.stopReconnect\(\);\s*d\.disconnect\(\);\s*try \{\s*await d\.connect\(address, token\);/u,
    'cancel → disconnect → connect, in that order');
});

test('the back-gesture history dance is the phone’s; a desktop browser keeps its Back (2026-09-03)', () => {
  // The seed + re-push + popstate router protect the PHONE's back gesture
  // (app-shell.md). On a desktop layout there is no gesture, and the same
  // dance swallowed the browser's Back for good.
  assert.match(source, /function navPush\(\) \{\s*if \(!layout\.isTouchDevice\) return false;\s*history\.pushState\(\{ app: true \}, ''\);\s*return true;\s*\}/u);
  assert.match(source, /\$effect\(\(\) => \{\s*if \(!layout\.isTouchDevice\) return;[^]*?window\.addEventListener\('popstate', handler\);/u,
    'the popstate router installs only on the touch layout, and re-evaluates when the layout mode changes');
  // A caller only spends an entry it really pushed.
  assert.match(source, /prefsPushed = navPush\(\);/u);
  assert.doesNotMatch(source, /navPush\(\); prefsPushed = true;/u);
});

test('navigation is reachable by keyboard: no nav item opts out of the Tab order (2026-09-03)', () => {
  // Rail icons, the server control, the tab bar and the gear were all
  // tabindex="-1" — the whole navigation was unreachable by keyboard, with no
  // documented reason. The focus ring is the global button:focus-visible.
  const nav = source.match(/<nav class="topbar">[^]*?<\/nav>|<nav\s+class="rail"[^]*?<\/nav>|<nav class="tabbar"[^>]*>[^]*?<\/nav>/gu) ?? [];
  assert.equal(nav.length, 3, 'top bar, rail and tab bar are all present');
  for (const n of nav) assert.doesNotMatch(n, /tabindex="-1"/u, 'a nav item must stay in the Tab order');
  // The current page is announced, not only coloured.
  assert.match(source, /class="rail-btn"[^]*?aria-current=\{page === slot \? 'page' : undefined\}/u);
  assert.match(source, /class:active=\{page === 'terminal'\} aria-current=\{page === 'terminal' \? 'page' : undefined\}/u);
  const style = source.match(/<style>[^]*<\/style>/u)?.[0] ?? '';
  assert.doesNotMatch(style, /\.(?:rail-btn|tabbar button|gear-btn)[^{]*\{[^}]*outline:\s*none/u, 'the ring must not be switched off');
});

test('the server registry has an entry on the touch layout (2026-09-03)', () => {
  assert.match(source, /onServers=\{connected && layout\.isTouchDevice \? toggleServerMenu : null\}/u,
    'Settings gets the opener only where the rail (and its switcher) does not exist');
  // Board #319 (owner 2026-10-08): the row, the hover card and the switch
  // panel name the current server as its registry row does — one derived.
  assert.match(source, /const serverName = \$derived\(\s*currentServerName\(serverList, serverCurId, serverInfo, activeAddress\),/u,
    'the current server is named by its saved entry, the same name the list shows');
  assert.doesNotMatch(source, /serverInfo\.hostname \|\| hostLabel\(activeAddress\)/u, 'the hostname-first name cannot regrow');
  assert.match(source, /currentName: \(\) => serverName,/u, 'the switch panel\'s "Back to" uses the same name');
  // The popover's outside-dismissal spares whichever control opened it.
  assert.match(source, /serverMenuTrigger\?\.contains\?\.\(e\.target\)/u);
  assert.doesNotMatch(source, /closest\?\.\('\.server-menu, \.rail-server'\)/u);
});

test('the connect card is a raised surface, never canvas-on-canvas (owner, 2026-09-05)', async () => {
  // "应用第一次启动的时候，选项的卡片后面没有阴影" — the card painted itself
  // var(--bg) on the var(--bg) page, and dark mode's black drop shadow is
  // invisible on the near-black canvas, so the first screen read as a flat
  // outline. Dark elevation in this app comes from SURFACE LIFT (app.css:
  // "surface elevation — not from repainting"), the dialect every card
  // (.acard and friends) already wears; the drop shadow stays for the light
  // theme, where it does read.
  const settings = await readFile(new URL('./lib/app/Settings.svelte', import.meta.url), 'utf8');
  const card = settings.match(/\.card \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(card, /background: var\(--surface\);/u, 'the card lifts off the canvas');
  assert.doesNotMatch(card, /background: var\(--bg\);/u, 'canvas-on-canvas cannot regrow');
  assert.match(card, /box-shadow: 0 8px 32px/u, 'the drop shadow stays for the light theme');
});

test('the rail explains itself with the one hover card, and no native title beside it (motion.md §1.16, board #86)', () => {
  // A page icon: its name + its shortcut (read live from the bindings). The
  // switcher: the current server, its address and state. aria-labels stay —
  // the card is pointer-only, the label is for everyone.
  assert.match(rail, /aria-label=\{t\(RAIL_ITEMS\[slot\]\.label\)\}\s*use:hoverInfo=\{\(\) => railInfo\(slot\)\}/u);
  assert.match(rail, /aria-label=\{t\('serversTitle'\)\}\s*use:hoverInfo=\{serverCardInfo\}/u);
  assert.doesNotMatch(rail, /title=/u, 'no native title on the rail — the card took over');
  assert.match(source, /function railInfo\(slot\) \{[\s\S]*?shortcuts\.get\(RAIL_SHORTCUT\[slot\]\)[\s\S]*?note: key \? shortcutLabel\(key\) : undefined/u);
  assert.match(source, /function serverCardInfo\(\) \{[\s\S]*?title: serverName,[\s\S]*?serverInfo\.hostname !== serverName[\s\S]*?label: t\('hostname'\), value: serverInfo\.hostname[\s\S]*?label: t\('address'\), value: activeAddress/u);
  // The gear and the split toggle: name on the card, label for the reader.
  assert.match(source, /class="gear-btn"[^>]*aria-label=\{t\('settings'\)\} use:hoverInfo=\{\(\) => \(\{ title: t\('settings'\) \}\)\}/u);
  assert.match(source, /class="split-toggle state-ctl"[^>]*aria-label=\{t\('split'\)\} use:hoverInfo=\{\(\) => \(\{ title: t\('split'\) \}\)\}/u);
  assert.doesNotMatch(source, /class="(?:gear-btn|split-toggle state-ctl)"[^>]*title=/u);
});

test('the rail keeps the ONE travelling highlight; the tab bar is foreground-only (motion.md §1.14, owner 2026-09-05)', () => {
  // The phone bar's wash was retired the day after it arrived (owner,
  // 2026-09-05: "保持没有背景色，只有前景色的一个高亮样式…没有选中灰色 选中后
  // 前景有颜色" — the WeChat/Alipay dialect; its first paint also differed
  // from the post-tap state). Selection on the tab bar is the ink cross-fade
  // alone: grey at rest, accent when chosen, no background. The desktop rail
  // keeps the travelling wash (board #86).
  assert.match(tabbar, /^<nav class="tabbar" inert=\{!!switching\}>/u, 'no slideIndicator on the tab bar');
  assert.ok(!tabbar.includes('slide-pill'), 'no pill inside the tab bar');
  assert.ok(!source.includes('slide-ind'), 'no bar indicator anywhere in the shell');
  assert.match(rail, /use:slideIndicator=\{\{ key: page, active: '\.rail-btn\.active', hidden: !!railDrag \}\}/u,
    'the rail hides the marker while an icon is being dragged (slots are mid-transform) and re-measures on release');
  assert.match(rail, /<span class="slide-pill soft" aria-hidden="true"><\/span>/u);
  const style = source.match(/<style>[^]*<\/style>/u)?.[0] ?? '';
  // The buttons keep only their ink; on the tab bar the ink IS the state.
  assert.match(style, /\.rail-btn\.active \{ color: var\(--accent\); \}/u);
  assert.match(style, /\.tabbar button\.active \{ color: var\(--accent\); \}/u);
  assert.match(style, /\.tabbar button \{[^}]*color: var\(--text3\);/u, 'unchosen tabs rest grey');
  assert.doesNotMatch(style, /\.tabbar[^{]*\{[^}]*\.slide-pill/u);
  // The atom's look lives in app.css; App only positions it.
  assert.doesNotMatch(style, /\.slide-pill[^{]*\{[^}]*(background|width|height|transition)/u);
});

test('a second click on the active rail tab hands the page a reselect — the Hub expands its sidebar (board #199)', () => {
  // Owner 2026-09-14: "我应该在左侧的选项卡已经选中二次再点击的时候，也是自动帮我展开侧边栏".
  // switchTab returns when target === page; the rail used to swallow the click.
  assert.match(source, /function railActivate\(slot\) \{[\s\S]*?if \(slot === page\) \{ pageReselect\[slot\]\?\.\(\); return; \}/u);
  assert.match(source, /const pageReselect = \{\};/u);
  assert.match(source, /onReselect=\{\(fn\) => \{ pageReselect\.hub = fn; \}\}/u, 'the Hub registers its reselect like its back chain');
});

test('one shell-wide sidebar state: the Terminal page and the system status follow the Hub\'s collapse; reselect opens it on every page (board #200)', async () => {
  // Owner 2026-09-14: "左侧边栏收起的时候，底下的系统状态显示也要收起，而且这个折叠收起在不同的
  // 页面是同步的，不然我点击chat terminal board，展开状态不一致".
  assert.match(source, /const shellSideCollapsed = \$derived\(shell && !layout\.isTouchDevice && appPrefs\.sidebarCollapsed\);/u);
  assert.match(source, /<main class:with-rail=\{[^}]+\} class:touch-layout=\{[^}]+\} class:side-collapsed=\{shellSideCollapsed\} class:side-page=\{pageHasSidebar\}/u);
  assert.match(source, /pageReselect\.terminal = pageReselect\.board = \(\) => appPrefs\.setSidebarCollapsed\(!appPrefs\.sidebarCollapsed\);/u, '#199 on every page, a toggle since #201');
  assert.match(source, /<Board session=\{filesSession\} guardPage="board" visible=\{page === 'board'\} sideCollapsed=\{shellSideCollapsed\}/u);
  // The Terminal page's track is the Hub's technique: factor, gate, pin, hidden at rest.
  assert.match(source, /const unpin = pinTrack\(termSideEl, 'end'\);\s*\n\s*void moveTrack\(termPageEl, '--side-open', collapsed \? 1 : 0\)\.then\(unpin\);/u);
  assert.match(source, /\.page-layer\.term-page:global\(\.moving\) \{ transition: --side-open var\(--t-move\) ease-out; \}/u);
  assert.match(source, /\.with-rail\.side-collapsed \.page-layer\.term-page \{ --side-open: 0; \}/u);
  assert.match(source, /\.with-rail\.side-collapsed \.page-layer\.term-page:not\(:global\(\.moving\)\) > \.term-side \{ visibility: hidden; \}/u);
  assert.match(source, /\.term-side:global\(\.pin-end\) \{ justify-self: end; \}/u);
  // The system status retracts with it, on the same tempo, unreachable at rest.
  const sys = source.match(/\.with-rail\.side-collapsed \.sys-sidebar \{([^}]+)\}/u)?.[1] ?? '';
  assert.match(sys, /width: 0; padding-inline: 0;[^;]*; visibility: hidden;/u);
  assert.match(sys, /transition: width var\(--t-move\) ease-out, padding var\(--t-move\) ease-out, visibility 0s linear var\(--t-move\);/u);
  // The factor is registered once, in app.css.
  const css = await readFile(new URL('./app.css', import.meta.url), 'utf8');
  assert.equal([...css.matchAll(/@property --side-open \{/gu)].length, 1);
  assert.match(css, /@property --side-open \{ syntax: '<number>'; inherits: false; initial-value: 1; \}/u);
});

test('THE sidebar toggle is one fixed shell node at the content area\'s top-left, on every desktop page (boards #202 → #217)', async () => {
  // #202 (owner 2026-09-14): the Hub's riding node slid ~190px from under the
  // pointer, so the control moved to the rail. #217 (owner 2026-09-20, two
  // reference frames: "折叠按钮放到侧边栏上吧，类似这个设计我觉得挺好的"): back to the
  // sidebar — at its head row's LEFT end, where the collapsing track (it
  // shrinks from the right, content pinned left) never moves it; collapsed,
  // the same square at the same screen point leads the page head.
  const rail = source.match(/<nav\s+class="rail"[\s\S]*?<\/nav>/u)?.[0] ?? '';
  assert.doesNotMatch(rail, /CommandButton|panel-left|rail-head/u, 'the rail is brand + tabs again; no toggle, no head group, no rule');
  assert.match(source, /<img class="rail-brand"[^>]*\/>\s*\n\s*\{#each railSlots as slot \(slot\)\}/u, 'the brand is followed by the tabs');
  assert.match(source, /<\/nav>\s*\n(?:\s*<!--[\s\S]*?-->\s*\n)?\s*\{#if pageHasSidebar && !switching\}\s*<div class="shell-side-toggle">\s*<CommandButton variant="secondary" iconOnly icon="panel-left" expanded=\{!appPrefs\.sidebarCollapsed\} inside\s+label=\{appPrefs\.sidebarCollapsed \? t\('hubSidebarExpand'\) : t\('hubSidebarCollapse'\)\}\s+onclick=\{toggleShellSidebar\} \/>\s*<\/div>\s*\{\/if\}\s*\{\/if\}/u,
    'rendered once, beside the rail, under the desktop-connected guard AND only on a page that has the sidebar (#219); a quiet surface so it reads over a terminal');
  // #219 (owner: "files页面里，多显示了折叠左侧边栏的按钮，还有设置这些页面也都没兼容好"):
  // Files, Settings and Agents have no primary sidebar — no toggle, no head room.
  assert.match(source, /const SIDEBAR_PAGES = new Set\(\['hub', 'terminal', 'board'\]\);\s*\n\s*const pageHasSidebar = \$derived\(SIDEBAR_PAGES\.has\(page\)\);/u);
  assert.match(source, /class:side-collapsed=\{shellSideCollapsed\} class:side-page=\{pageHasSidebar\}/u,
    'the collapsed state stays app-wide (#200); which page is on screen is a second class');
  assert.equal([...source.matchAll(/icon="panel-left"/gu)].length, 1, 'ONE node — never one per state or per page');
  assert.match(source, /function toggleShellSidebar\(\) \{\s*\n\s*\(pageReselect\[page\] \?\? \(\(\) => appPrefs\.setSidebarCollapsed\(!appPrefs\.sidebarCollapsed\)\)\)\(\);/u,
    'the same act as a reselect: the page\'s delegate, else the shared state');
  const style = source.match(/<style>[\s\S]*<\/style>/u)?.[0] ?? '';
  const seat = style.match(/\.shell-side-toggle \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(seat, /position: fixed/u, 'fixed: neither the track nor a page scroll moves it');
  assert.match(seat, /left: calc\(46px \+ var\(--side-toggle-x\)\)/u, 'the rail\'s width in, one inset');
  assert.match(seat, /top: calc\(var\(--sat\) \+ \(var\(--page-head-h\) - var\(--control-height\)\) \/ 2\)/u, 'centred on the page-head row, under the status bar (#332)');
  assert.doesNotMatch(seat, /--side-open|transition/u, 'it does NOT ride the partition (#197)');
  assert.match(style, /\.rail-brand \{ border-radius: var\(--ui-radius-control\); margin-bottom: 8px; flex: none; \}/u, 'the brand spaces itself again (#215\'s head group is gone whole)');
  assert.doesNotMatch(style, /rail-head/u);

  // The rows it joins make room for it — ONE rule set in app.css, keyed on the shell state.
  const css = await readFile(new URL('./app.css', import.meta.url), 'utf8');
  assert.match(css, /--side-toggle-x: 8px;/u);
  const row = css.match(/\.with-rail:not\(\.side-collapsed\) \.side-toggle-row \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(row, /min-height: var\(--page-head-h\)/u, 'the sidebar\'s first head is the page-head row');
  assert.match(row, /margin-top: calc\(-1 \* var\(--side-toggle-x\)\)/u, 'absorbing the scroller\'s 8px so the text centre is the page head\'s');
  assert.match(row, /padding-left: calc\(var\(--side-toggle-x\) \+ var\(--control-height\)\)/u, 'text starts 8px after the square, like the collapsed title');
  assert.match(css, /\.with-rail\.side-page\.side-collapsed \.page-head \{ padding-left: calc\(var\(--side-toggle-x\) \* 2 \+ var\(--control-height\)\); \}/u,
    'the page head makes room only on a sidebar page (#219)');
  assert.doesNotMatch(css, /\.with-rail\.side-collapsed \.page-head \{/u);
  assert.match(css, /\.with-rail\.side-page \.page-head \{ transition: padding-left var\(--t-move\) ease-out; \}/u, 'the title slides with the track, never jumps');
  // Every desktop sidebar's first head wears the class.
  for (const [file, pattern] of [
    ['./lib/hub/Sidebar.svelte', /class="side-h side-head side-toggle-row"/u],
    ['./lib/hub/Board.svelte', /class="side-h side-toggle-row"/u],
    ['./lib/projects/Projects.svelte', /class:side-h=\{dense\} class:side-toggle-row=\{dense\}/u],
  ] as const) {
    assert.match(await readFile(new URL(file, import.meta.url), 'utf8'), pattern, `${file} makes room in its head row`);
  }
});

test('the phone tab bar hides for Files\' reading mode through one signal, gated on the visible page (board #226)', () => {
  // Owner 2026-09-20: reading mode takes the whole screen; the bottom bar goes
  // the way it goes for the keyboard — a cut — from one explicit prop, never a
  // second class writer on <html>.
  assert.match(source, /onimmersive=\{\(on\) => filesImmersive = on\}/u, 'Files reports, App mirrors');
  assert.match(source, /class:immersive=\{filesImmersive && page === 'files'\}/u, 'only while Files is the page on screen');
  assert.match(source, /\.immersive \.tabbar \{ display: none; \}/u);
  assert.match(source, /:global\(html\.keyboard-open\) \.tabbar \{ display: none; \}/u, 'the keyboard hide it sits beside');
});

test('every connect path runs the one server handshake, which loads backends_list (board #253)', () => {
  // The boot path (a page load with a saved token, the most common connect)
  // called probeHub alone, so setServedBackends never ran and the Agents
  // editor hid the queue/steer field on the live app while the mount tests,
  // which serve the list directly, passed. Each place that marks the socket
  // connected must reach serverReady(), and nothing may probe or load
  // backends on its own beside it.
  const ready = source.match(/function serverReady\(\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.match(ready, /runtime\.probeCaps\(/u, 'one probe, both questions');
  assert.match(ready, /setServedBackends\(caps\.backends\);/u);
  const sites = [...source.matchAll(/connected = true;/gu)].map((m) => m.index!);
  assert.equal(sites.length, 3, 'boot, reconnect success, manual connect');
  for (const at of sites) {
    const rest = source.slice(at);
    const nextFn = rest.search(/\n  (?:async )?function /u);
    const body = nextFn < 0 ? rest : rest.slice(0, nextFn);
    assert.match(body, /serverReady\(\);/u, `the connect path at offset ${at} runs the handshake`);
  }
  const outside = source.replace(/function serverReady\(\) \{[\s\S]*?\n  \}/u, '');
  assert.doesNotMatch(outside, /probeCaps\(/u, 'no path does half the handshake');
});

test('a connect lands on the default page, Chat — never a hard-coded Terminal (#333)', () => {
  const connected = source.match(/function onConnected\(switched = false\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(connected, 'onConnected found');
  assert.match(connected, /page = defaultPage\(\);/u);
  assert.doesNotMatch(connected, /page = 'terminal'/u);
  // The one hubless fallback stays: Chat on a server without the Hub becomes Terminal.
  assert.match(source, /if \(\(page === 'hub' \|\| page === 'agents' \|\| page === 'board'\) && hubState\.probed && !hubState\.available\) page = 'terminal';/u);
});

test('the fixed rail and the sidebar toggle start under the Android status bar (#332)', () => {
  // `main` pads in-flow content by --sat; a position: fixed element is not
  // in that flow, so each one adds the inset itself. 0 on a desktop.
  const style = source.match(/<style>[\s\S]*<\/style>/u)?.[0] ?? '';
  const rail = style.match(/\n  \.rail \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(rail, /position: fixed;/u);
  assert.match(rail, /left: 0; top: var\(--sat\); bottom: 0;/u, 'the rail starts under the status bar');
  const seat = style.match(/\.shell-side-toggle \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(seat, /var\(--sat\)/u, 'and so does the collapse button');
  assert.match(style, /main \{[\s\S]*?padding-top: var\(--sat\);/u, 'in-flow content keeps main\'s one inset');
});
