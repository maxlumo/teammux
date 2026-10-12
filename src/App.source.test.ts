// Source-contract tests for App.svelte (see docs/conventions/testing.md):
// component wiring that node can't execute is pinned by matching the source.
// If one of these fails after an intentional change, update the assertion —
// the point is that the change must be INTENTIONAL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./App.svelte', import.meta.url), 'utf8');
// The bound tree's navigation and back chains live in its view (#335 ③a).
const viewSource = await readFile(new URL('./lib/app/server-view.svelte.ts', import.meta.url), 'utf8');

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
    // ③a-4: per tree — hidden unless it is the focused tree's page, and the
    // element is that tree's view's.
    /<div class="page-layer term-page" class:hidden=\{!shown \|\| page !== 'terminal'\} bind:this=\{v\.termPageEl\}>/u,
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
  assert.match(source, /<aside class="term-side"[^>]*bind:this=\{v\.termSideEl\}>/u);
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
  const jumpAt = source.indexOf("if (page === 'terminal' && view.jumpedFrom)");
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
  assert.match(source, /\{#if v\.hubState\.available && !agentsLivesInSettings\(layout\.isTouchDevice\)\}\s*<div class="page-layer" class:hidden=\{!shown \|\| page !== 'agents'\}>/u,
    'and still a page layer — but not mounted on touch, where Settings owns the only instance');
});

test('every route into the agent config goes through ONE device-aware entry', () => {
  // Four places had to agree or it becomes unreachable in one of them; they all
  // call openAgentsConfig, which asks nav-state where Agents lives.
  assert.match(
    source,
    /function openAgentsConfig\(name = null, kind = 'agent', runtime = bound\(\), v = view\) \{[\s\S]*?if \(agentsLivesInSettings\(layout\.isTouchDevice\)\) \{[\s\S]*?prefsOpenReq = \{ tab: kind === 'team' \? 'teams' : 'agents'[\s\S]*?if \(page !== 'prefs'\) togglePrefs\(\);[\s\S]*?\} else \{\s*switchTab\('agents'\);/u,
  );
  // The Hub's "configure agent" item: Settings on a phone, the page on a desktop.
  // #258: a team name's menu asks for its team editor through the same entry.
  assert.match(source, /openAgentConfig=\{\(name, kind\) => openAgentsConfig\(name, kind, runtime, v\)\}/u);
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
  // While the migration is blocked the guest stays the bound runtime's and is
  // HELD, not unmounted (③a; orchestrator 08:17, one mechanism): inert, with
  // the reason, its writes refused by the frozen runtime and held by the gate.
  assert.match(source, /showAgents=\{hubEligible && agentsLivesInSettings\(layout\.isTouchDevice\)\}/u);
  // ③a: one guest per member, the focused one shown (reviewer P1-C).
  assert.match(source, /guests=\{members\.map\(\(runtime\) => \(\{ runtime, state: serverStates\.get\(runtime\) \}\)\)\} guestShown=\{scopeRuntime\}\s*guestHeld=\{storageHeld \? t\('migrationBlockedNote'\) : ''\}\s*visible=\{page === 'prefs'\}/u, 'and whether the page is on screen (③a: a kept, hidden page s guest takes no input)');
  // Since #335 ②b-2 a landing is delivered only to the tree it names, so the
  // jump travels through that one guard rather than straight from the state.
  // ③a (reviewer P1-1(b)): the request names its server; Preferences hands
  // it to that member's guest only.
  assert.match(source, /agentsEditRequest=\{view\.agentsEditReq\}/u, 'the Hub’s jump reaches the embedded editor');
  assert.match(source, /openRequest=\{prefsOpenReq\}/u);
});

test('a jump from the chat returns THERE on back, and deliberate navigation clears it (2026-08-29)', () => {
  // The one-deep return slot: set by the chat's cross-page jumps, cleared by
  // any real tab switch, consumed at the target page's back FLOOR.
  assert.match(source, /view\.jumpedFrom = null; \/\/ deliberate navigation stands the return slot down/u,
    'switchTab clears the slot');
  assert.match(source, /if \(from === 'hub'\) view\.jumpedFrom = 'hub';/u, 'opening a pane from the chat remembers');
  // ③a-4: a jump from a tree's Hub is recorded in THAT tree's view.
  assert.match(source, /switchTab\('files'\); v\.jumpedFrom = 'hub';/u, 'the files jump remembers (after the switch cleared)');
  assert.match(source, /switchTab\('board'\); v\.jumpedFrom = 'hub';/u, 'the board jump too');
  for (const p of ['files', 'board', 'terminal']) {
    assert.match(source, new RegExp(`if \\(page === '${p}' && view\\.jumpedFrom\\) \\{ switchTab\\(view\\.jumpedFrom\\); return; \\}`, 'u'),
      `${p}'s floor prefers the return slot`);
  }
  // Order matters: the slot fires only at the FLOOR — after the page's own
  // onGoBack chain (and the terminal's session sheet) had their turn.
  const idxGoBack = source.indexOf("if (page === 'board' && view.boardGoBack && view.boardGoBack())");
  const idxSlot = source.indexOf("if (page === 'board' && view.jumpedFrom)");
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
  assert.match(source, /<Files [^\n]*jumped=\{!!v\.jumpedFrom\}/u, 'the files page instance gets the return-slot gate');
  // Board is told whether a return slot exists, so its drawer lift can stand
  // aside and let back fall through to the conversation.
  assert.match(source, /<Board [^\n]*jumped=\{!!v\.jumpedFrom\}/u, 'the return slot reaches the drawer-lift gate');
});

test('Terminal confirmations delegate before jump-back or drawer floor without another history listener (#167)', () => {
  // Actual pending/idle behavior is exercised by Sessions/Projects mount
  // tests; this pins App's wiring and preserves its touch-only history owner.
  const delegate = source.indexOf("if (page === 'terminal' && view.sessionsGoBack?.())");
  const jump = source.indexOf("if (page === 'terminal' && view.jumpedFrom)");
  const floor = source.indexOf("if (page === 'terminal' && layout.isTouchDevice && narrowVp && !sessListOpen)");
  assert.ok(delegate >= 0 && delegate < jump && delegate < floor);
  assert.match(source, /if \(page === 'terminal' && view\.sessionsGoBack\?\.\(\)\) \{ navPush\(\); return; \}/u);
  assert.match(source, /onGoBack=\{\(fn\) => v\.sessionsGoBack = fn\}/u, 'registered in its tree s view (③a-4)');
  assert.equal([...source.matchAll(/addEventListener\('popstate'/gu)].length, 1);
});

test('the multi-server registry wires migrate → deep-link → boot, in that order (board #55)', () => {
  // Migration must run BEFORE the deep-link consumer: on a pre-registry
  // client a link would otherwise create the registry via upsert, turn
  // migrateServers into a no-op, and silently drop the current user +
  // history. The consumer then upserts the linked server by address.
  assert.match(source, /function prepareStorage\(\) \{\s*try \{\s*migrateServers\(localStorage\);/u, 'boot migrates the single-server keys first');
  assert.match(source, /prepareStorage\(\);\s*takeBootLink\(takeConnectLink\(\)\);/u, 'migrate BEFORE the deep link is applied');
  assert.match(source, /if \(address\) activateConnected\(localStorage, \{ address, token: token \|\| '',/u,
    'a deep-linked server joins the registry AND activates pre-boot');
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
  // websocket-client.md §#55, order (a) (orchestrator, 2026-10-11 04:04):
  // guards → one intent (the tree hidden) → dial the target as a candidate
  // WITHOUT touching CURRENT → only after auth point CURRENT at it and bring
  // the target's own runtime up. The server left is not stopped, parked or
  // reset on the way: it is ended only once the target is bound, and a
  // failure puts CURRENT back on it.
  const mod = await readFile(new URL('./lib/app/server-switch.ts', import.meta.url), 'utf8');
  const fn = mod.match(/async function switchTo\(target: SwitchTarget\): Promise<void> \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  const at = (needle: string) => { const i = fn.indexOf(needle); assert.ok(i >= 0, `switchTo has ${needle}`); return i; };
  const order = [
    'await guard(() => d.confirmLeave())',
    'const intent = ++seq',
    'd.stopReconnect()',
    "set({ intent, from, target, phase: 'connecting'",
    'await d.connect(target.address, target.token)',
    'activateSwitched(d.storage',
    'd.comeUp(target, entry)',
    'restoreCurrent(d.storage, left)',
  ].map(at);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the switch steps run in the documented order');
  assert.doesNotMatch(fn, /suspendDownloads|afterUnmount|resetMemory/u,
    'nothing of the server left is given up before the target is bound (reviewer P2-1 on cc45d7d1)');
  assert.match(fn, /if \(moved && left && !d\.frozen\(\)\) \{\s*try \{ restoreCurrent\(d\.storage, left\); \} catch \{ d\.identityFailed\?\.\(target\); \}\s*\}/u,
    'a target that did not come up hands CURRENT back to the server left, unless the migration froze it');
  assert.doesNotMatch(mod, /parkFrom|pointTo/u, 'the switch moves CURRENT and nothing else');
  assert.ok((fn.match(/intent !== seq/gu) ?? []).length >= 3, 'every await re-checks that this intent still owns the switch');
  // App wires the effects into that one module and calls nothing else.
  assert.match(source, /const serverSwitch = createServerSwitch\(\{/u);
  assert.match(source, /onstate: \(st\) => \{\s*switching = st;/u);
  // Each runtime has its OWN reconnect loop (reviewer P1-A on cc45d7d1), told
  // WHERE by the one reader for THAT runtime's entry — never the mirror, and
  // never whichever server is current by the time it dials.
  assert.match(source, /target: \(\) => targetOf\(localStorage, runtime\.id\),/u);
  assert.match(source, /function reconnect\(\) \{\s*const runtime = bound\(\);\s*return runtime \? reconnectorOf\(runtime\) : noReconnector;\s*\}/u,
    'the shell s reconnect is the bound runtime s loop');
  assert.match(source, /confirmLeave: \(\) => confirmLeave\(\{ leaving: scopeSwap\.bound\(\), current: page,/u);
  // Every way a handle ends goes through ONE end (app/handle-end.ts; reviewer
  // P1-a on 0b8b9038 and on 48b40082): stopped now, its state RELEASED —
  // unless the handle replacing it ADOPTED that very state (a same-machine
  // merge) — and disposed only after that. The swap awaits it, so it shows
  // nothing until the end is over.
  assert.match(source, /const ends = createHandleEnds\(\{\s*stateOf: \(runtime\) => serverStates\.get\(runtime\),\s*adoptedElsewhere: \(state, runtime\) => \{\s*const next = scopeSwap\.bound\(\);\s*return !!next && next !== runtime && serverStates\.get\(next\)\?\.files === state\.files;\s*\},\s*release: releaseServerState,\s*\}\);/u);
  assert.match(source, /invalidate: async \(gone\) => \{[\s\S]*?await ends\.end\(gone\);\s*\},/u);
  // And NOTHING else in App disposes a runtime or releases a state: the
  // swap, the fleet's drop and the root teardown all hand the handle to that
  // end. Two `.dispose()`: App's link feedback, and the connect form's
  // CANDIDATE (board #335 ②b-4), which is a bare connection no runtime held.
  assert.equal([...source.matchAll(/\.dispose\(\)/gu)].length, 2, 'App s link feedback and the candidate dispose themselves');
  assert.match(source, /function openCandidate\(\) \{[\s\S]*?close\(\) \{[\s\S]*?connection\.dispose\(\);/u, 'the candidate is the second');
  assert.equal([...source.matchAll(/releaseServerState\(/gu)].length, 0, 'only the one end releases a state');
  assert.match(source, /const activations = createActivations\(\);/u, 'the activation generation');
  // The switch's candidate closes and the target's own runtime comes up on
  // the one bring-up road, replacing the server left only once bound.
  assert.match(source, /comeUp: \(\) => \{\s*switchCandidate\?\.close\(\);[\s\S]*?activate\(\{ replace: true, elsewhere: 'fail', up: \(\) => \{ bringUp\(\); resubscribeAll\(\); \} \}\);\s*return run\.done;/u);
  assert.doesNotMatch(source, /location\.reload\(/u, 'no reload remains on any switch or connect path');
  assert.doesNotMatch(source, /applySwitch/u, 'the reload-era plan is gone');
});

test('every App socket owner goes through the switch module and loses ownership on a switch (board 315 review P1)', () => {
  // The address rows and the optimizer move the socket within one server;
  // they share the switch's intent, so a stale attempt never restarts the
  // reconnect loop over a newer server's socket.
  const onAddress = source.match(/onAddress=\{\(address\) => \{[\s\S]*?\n      \}\}/u)?.[0] ?? '';
  // One argument: WHERE. The current runtime dials it with its own token and
  // checks who answered (reviewer P1-A on cc45d7d1), so no caller hands the
  // switch an address/token pair a mirror could have changed.
  assert.match(onAddress, /serverSwitch\.connectAddress\(address\)/u);
  assert.doesNotMatch(onAddress, /reconnect\(\)\.start|\bconnect\(/u, 'no direct connect or reconnect start');
  const opt = source.match(/async function optimizeConnection\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(opt, /await serverSwitch\.connectAddress\(best\);/u);
  assert.doesNotMatch(opt, /reconnect\(\)\.start|await connect\(/u);
  // Server answers land only for the server that was asked.
  // Asked through the bound runtime (board #335 ②b-2-2), and kept only if
  // the switch still owns the intent AND that runtime is still bound.
  assert.match(source, /function serverReady\(runtime = scopeSwap\.bound\(\)\) \{\s*if \(!runtime\) return;\s*const intent = serverSwitch\.intent;\s*(?:\s*\/\/[^\n]*\n)*\s*const asked = runtime === scopeSwap\.bound\(\)\s*\? \(\) => serverSwitch\.owns\(intent\) && scopeSwap\.bound\(\) === runtime\s*: \(\) => aggregate\.holds\(runtime\);\s*(?:\s*\/\/[^\n]*\n)*\s*void runtime\.probeCaps\(\(caps\) => \{\s*if \(!asked\(\)\) return;/u,
    'published as EACH answer lands, so a quick Hub answer is not held behind backends');
  assert.match(source, /if \(caps\.hub !== null\) viewOf\(runtime\)\.hubState = \{ available: caps\.hub, probed: true \};/u,
    'the Hub flag moves only on a definitive answer');
  assert.doesNotMatch(source, /\bhubRooms\(|\bbackendsList\(/u, 'App asks no capability question over the facade');
  // The only remaining direct starts are the reconnect machine's own owners.
  // Each is the BOUND runtime's own loop (reconnect()); no raw address path
  // and no shared machine remain (reviewer P1-A on cc45d7d1).
  assert.doesNotMatch(source, /reconnectMachine/u, 'the one shared reconnect machine is gone');
  const starts = [...source.matchAll(/reconnect\(\)\.start\(\)/gu)].length;
  assert.equal(starts, 4, 'the drop, the switch s startReconnect, the migration Retry and the visibility resume — each guarded');
});

test('the leave walk holds Settings mounted while guards are asked (board 315 review P1)', () => {
  assert.match(source, /\{#if page === 'prefs' \|\| holdPages \|\| prefsKept\}\s*<div class="page-layer" class:hidden=\{page !== 'prefs'\}>/u,
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
  assert.match(source, /\{#if switching\}[\s\S]*?class="switch-panel[\s\S]*?\{:else\}[\s\S]*?\{#each members as runtime \(runtime\)\}\s*\{@const v = viewOf\(runtime\)\}\s*\{@const held = storageHeld \|\| runtime !== scopeRuntime\}\s*\{@const shown = !held\}(?:\s*<!--[\s\S]*?-->)?\s*<div class="scope-tree" class:held inert=\{held\}>\s*<ServerScope \{runtime\} state=\{serverStates\.get\(runtime\)\}>/u,
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
  // The restored-runtime mark is the view's, raw for the same reason (③a).
  // ③a-4: a view per runtime handle; the window's is the focused one's.
  // Single holds one member, so a view shared by every runtime would look
  // the same until ③b mounts two trees: this pins the per-handle map.
  assert.match(source, /function viewOf\(runtime\) \{\s*let v = views\.get\(runtime\);\s*if \(!v\) \{ v = createServerView\(\); views\.set\(runtime, v\); \}\s*return v;\s*\}/u);
  // And a tree out of focus takes no window input: its Terminal is inactive.
  assert.match(source, /<Terminal target=\{v\.terminalTarget\}[^\n]*\n\s*visible=\{shown && page === 'terminal'\} active=\{!held\}/u);
  assert.match(source, /const view = \$derived\(scopeRuntime \? viewOf\(scopeRuntime\) : noServerView\);/u);
  assert.match(viewSource, /navRestored = \$state\.raw<unknown>\(null\);/u);
  assert.equal([...source.matchAll(/(?<!let )scopeRuntime = /gu)].length, 1,
    'and after its declaration only createScopeSwap({ show }) assigns it');
  assert.match(source, /show: \(runtime\) => \{ scopeRuntime = runtime; \},/u);
  assert.match(source, /settle: \(\) => tick\(\),/u, 'the settle is where Svelte runs the teardown');
  // Each runtime's server state is built in ONE place, beside the runtime and
  // after swapScope read CURRENT — never on first sight of an entry: through
  // ②b the store is the bare localStorage, whose live keys are whichever
  // server is current (board #335 ②b-2-1).
  assert.equal([...source.matchAll(/createServerState\(/gu)].length, 1, 'one place builds a server s state');
  // Handed to a runtime by its mint — or, when the dial's own gate just
  // filed claimed inputs into the slots of a runtime nobody has shown yet,
  // rebuilt from them before it is published (reviewer P1-3 on 341554b3).
  assert.equal([...source.matchAll(/serverStates\.set\(/gu)].length, 3, 'the mint, the dial gate s claim, and a background member s publish (③b-1)');
  assert.match(source, /if \(gate\.fold === 'claimed'\) serverStates\.set\(runtime, stateFor\(runtime\.id\)\);\s*c\.publishing\(\);/u);
  // In mintCurrent, swapScope's first half (board #335 ②b-4: a runtime is
  // minted before it is shown, so it can dial first).
  assert.match(source, /function mintCurrent\(\) \{ return mintFrom\(foldCurrent\(\)\); \}/u, 'the mint is the gate, then the runtime');
  assert.match(source, /function mintFrom\(\{ id, fold \}\) \{(?:(?!\n  \}\n)[\s\S])*?serverStates\.set\(next, stateFor\(entry\.id\)\);/u);
  assert.match(source, /function stateFor\(id\) \{\s*const held = scopeSwap\.bound\(\);[\s\S]*?return stateForRuntime\(replaced, id, \{/u,
    'a same-machine merge hands the replaced handle s state over (stateForRuntime)');
  assert.match(source, /function swapScope\(\) \{\s*const minted = mintCurrent\(\);\s*if \(!minted\.keep\) void scopeSwap\.swap\(minted\.runtime\);\s*\}/u);
  assert.match(source, /invalidate: async \(gone\) => \{\s*(?:\/\/[^\n]*\n\s*)*clearLandings\(\);\s*(?:\/\/[^\n]*\n\s*)*if \(gone\) forgetReconnector\(gone\);\s*if \(gone && fleet\.get\(gone\.id\) === gone\) fleet\.drop\(gone\.id\);\s*await ends\.end\(gone\);/u,
    'the replaced handle s own reconnect loop stops, it leaves the fleet and is ENDED, release then dispose, not merely forgotten');
  // WHICH server is read from the registry, never passed: identity repair can
  // absorb the entry we booted as into a machine's survivor and re-point
  // CURRENT at it, and from then on the app is on the survivor.
  assert.match(source, /function foldCurrent\(\) \{\s*const id = currentServerId\(localStorage\);/u);
  assert.match(source, /if \(held\?\.alive\(\) && !ends\.ending\(held\) && entry && held\.id === entry\.id && fold !== 'claimed'\) return \{ keep: true, runtime: held \};/u,
    'a reconnect keeps its handle — but only a handle that is still alive and not being ended: a revoked lease cannot serve the same id again');
  assert.match(source, /const held = scopeSwap\.bound\(\);/u,
    'and it asks what the swap is already heading for, or one success path mints a handle nobody shows or releases');
  // No handle is given up before its replacement is bound (order (a),
  // orchestrator 2026-10-11 04:04): every server has a connection of its own,
  // so there is no shared socket to revoke a lease over. The one bring-up
  // road swaps the tree over first, and only then resets App's memory of
  // the server left; the swap's own end releases, then disposes, it.
  assert.doesNotMatch(source, /revokeScope/u, 'the shared-socket revoke is gone, whole');
  assert.match(source, /provisional\.delete\(runtime\);[\s\S]{0,600}?const swapped = m\.keep \? Promise\.resolve\(\) : scopeSwap\.swap\(runtime\);\s*if \(replace\) \{\s*resetServerMemory\(\);/u,
    'bound first, then the memory of the server left is reset');
  assert.doesNotMatch(source.match(/function resetServerMemory\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '', /ends\.end|activations\.endAll|dispose/u,
    'the reset ends nothing: the swap did');
  // The connect form neither revokes nor suspends (board #335 ②b-4): it
  // dials its own CANDIDATE, so the handle's socket never moves under it, and
  // the candidate is the app's latest activation (`claim`) — a revoke closes
  // it, a newer attempt makes it stale.
  assert.match(source, /function openCandidate\(\) \{\s*heldOffline = false;[^\n]*\n\s*candidateOpen\?\.close\(\);\s*(?:\/\/[^\n]*\n\s*)*const owner = activations\.claim\(scopeSwap\.bound\(\)\);\s*const connection = createConnection\(\);/u);
  assert.match(source, /current: \(\) => !closed && owner\.current\(\),/u);
  // And asks the leave walk of the handle a connect to ANOTHER server would
  // destroy, before anything is dialled (reviewer P1-c on 0b8b9038).
  // With NO address exemption (reviewer P1-b on 48b40082): an address is not
  // an identity, and which machine answers is known only after the dial.
  assert.match(source, /function confirmFormLeave\(\) \{\s*const held = scopeSwap\.bound\(\);\s*if \(!held\?\.alive\(\)\) return Promise\.resolve\(true\);\s*return serverSwitch\.guard\(\(\) => confirmLeave\(\{ leaving: held, current: page,/u);
  // The runtime is the FLEET's (board #335 ②b-4): one connection each.
  assert.match(source, /activations\.claim\(held\);\s*(?:\/\/[^\n]*\n\s*)*fleet\.reconcile\(\);[\s\S]{0,1200}?const next = entry \? fleet\.include\(entry\) \?\? null : null;\s*(?:\/\/[^\n]*\n\s*)*if \(next\) wireDrop\(next\);\s*(?:\s*\/\/[^\n]*\n)*\s*if \(storageHeld\) next\?\.setFrozen\(true\);\s*(?:\s*\/\/[^\n]*\n)*\s*if \(next && !serverStates\.has\(next\)\) serverStates\.set\(next, stateFor\(entry\.id\)\);\s*(?:\s*\/\/[^\n]*\n)*\s*if \(next && !views\.has\(next\) && held && held\.id !== entry\.id && mergedInto\(localStorage, held\.id\) === entry\.id\) views\.set\(next, viewOf\(held\)\);\s*return \{ keep: false, runtime: next \};/u,
    'a mint for another server makes every attempt in flight stale — the tree is changing servers');
  assert.match(source, /<Settings \{onConnected\} \{openCandidate\} confirmLeave=\{confirmFormLeave\} notice=\{reconnectError\}\s*frozen=/u,
    'and the form dials a candidate of its own');
  // The person-level surfaces are OUTSIDE the server-bound subtree, which is
  // what lets that subtree render nothing while it has no runtime — and what
  // keeps the gear from opening a blank page when there is no server.
  const beforeKey = source.slice(0, source.indexOf('{#key scopeRuntime}'));
  assert.ok(beforeKey.includes('<Settings {onConnected}'), 'Settings renders outside the scope');
  assert.ok(beforeKey.includes('<Preferences {connected}'), 'and so does Preferences');
  const keyed = source.slice(source.indexOf('{#key scopeRuntime}'), source.indexOf('</ServerScope>'));
  assert.ok(!keyed.includes('<Settings') && !keyed.includes('<Preferences'), 'and neither is inside it');
  // Single mode holds one runtime at a time, on a connection of its own from
  // the fleet (board #335 ②b-4): the switch drops the one it left.
  assert.match(source, /const next = entry \? fleet\.include\(entry\) \?\? null : null;/u,
    'the fleet mints the runtime');
  // The one it replaces stays in the fleet, running, until the replacement
  // is bound (order (a)); the swap's invalidate lets go of it (pinned above).
  assert.doesNotMatch(source.match(/function mintCurrent\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '', /if \(held && fleet\.get\(held\.id\) === held\)/u,
    'a mint never drops the bound runtime of another server');
  // Every path that can change which server the app is on binds the tree —
  // the boot, and the ONE bring-up road (reviewer P1-B on cc45d7d1): a
  // connect, a switch, an arrival, a merge and a Retry all `activate`, which
  // dials the runtime it minted and binds it only once that dial answered.
  // A failover keeps its handle; one whose dial found another machine (or
  // its own entry absorbed) arrives there, which activates.
  for (const [name, pattern] of [
    // Boot's order is the pin (board #335 ②b-4, orchestrator's ruling on the
    // ② plan): migrate the registry, load it, FOLD, then the deep link, then
    // bind. A fold after the link would file A's live state into B's slot.
    ['boot', /prepareStorage\(\);\s*takeBootLink\(takeConnectLink\(\)\);[\s\S]{0,900}?swapScope\(\);/u],
    ['activate', /function activate\(\{ replace = false, elsewhere = 'arrive', up, minted = null, chain = null \}\) \{(?:(?!\n  \}\n)[\s\S])*?provisional\.delete\(runtime\);(?:(?!\n  \}\n)[\s\S])*?: scopeSwap\.swap\(runtime\);/u],
    ['a failover that landed elsewhere', /function onReconnected\(runtime, result, attempt\) \{(?:(?!\n  \}\n)[\s\S])*?void arrivedElsewhere\(result, attempt\);/u],
  ] as const) assert.match(source, pattern, `${name} binds the content tree`);
  assert.doesNotMatch(source.match(/function bringUp\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '', /swapScope|scopeSwap\.swap|recordServer/u,
    'bringUp binds and records nothing: the dial recorded, the activation bound');
  // An ABSORBED entry is followed, in the one place that reads CURRENT — and
  // which ids moved is the identity layer's RECORD of the merges it made,
  // never an inference from an id being absent (reviewer P1-a, 2026-10-10).
  assert.match(source, /let fold = id \? foldFor\(id\) : 'ok';[\s\S]{0,600}?if \(fold !== 'blocked' && !releaseStorage\(\)\) \{ holdStorage\(\); fold = 'blocked'; \}\s*if \(fold !== 'blocked' && !followMerges\(\)\) \{ holdStorage\(\); fold = 'blocked'; \}\s*return \{ id, fold \};\s*\}\s*function mintFrom\(\{ id, fold \}\) \{\s*const entry = fold !== 'blocked' \? loadServers\(localStorage\)\.find\(\(s\) => s\.id === id\) \?\? null : null;\s*const held = scopeSwap\.bound\(\);/u,
    'no server s state is built before the fold has run for it, and none at all while it cannot be recorded');
  assert.match(source, /function followMerges\(\) \{\s*const survivorOf = \(serverId\) => mergedInto\(localStorage, serverId\);/u,
    'the survivor comes from servers.mergedInto');
  const follow = source.match(/function followMerges\(\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  assert.doesNotMatch(follow, /known|\.has\(/u, 'and nothing reads absence as a merge');
  for (const held of ['view.termPane = rebind(view.termPane);', 'view.filesRef = rebind(view.filesRef);', 'pane: rebind(c.pane)',
    'reownSavedNav(createServerStore(localStorage, id, writeGate), survivorOf);'])
    assert.ok(follow.includes(held), `the merge reaches what App holds and the record: ${held}`);
  // Every CONFIRMED runtime opens the save gate: an arrival by restoring the
  // record, a same-server return or a failover by keeping what is on screen
  // (reviewer P1-b). Before, only a restore opened it, and a merge on the
  // other two paths left it shut on the replaced handle for good.
  assert.equal([...source.matchAll(/view\.navRestored = target;/gu)].length, 2, 'the restore and the keep, nothing else');
  assert.match(source, /async function keepNavFor\(target\) \{\s*await scopeSwap\.settled\(\);\s*if \(!target \|\| scopeSwap\.shown\(\) !== target\) return;\s*view\.navRestored = target;/u);
  assert.match(source, /function onReconnected\(runtime, result, attempt\) \{(?:(?!\n  \}\n)[\s\S])*?void keepNavFor\(runtime\);/u,
    'a failover keeps');
  assert.match(source, /return activate\(\{ replace: false, up: \(\) => \{[\s\S]{0,300}?void keepNavFor\(scopeSwap\.bound\(\)\);/u,
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
  assert.match(source, /navFor\(readNav\(createServerStore\(localStorage, target\.id, writeGate\)\), target\.id\);/u,
    'read from THIS server s slot, then filtered to this runtime (board #335 ②b-4)');
  // Ownership is WHERE a record is read (board #335 ②b-4): there is no live
  // record left to track the provenance of, and nothing compares bytes.
  assert.doesNotMatch(source, /navProvenance|navLiveOwner|navBoot|=== boot\.raw/u, 'no tracked provenance and no byte comparison');
  // And nothing saves over that record until the restore for the bound
  // runtime has finished.
  assert.match(source, /if \(!connected \|\| !scopeRuntime \|\| view\.navRestored !== scopeRuntime\) return;\s*saveNav\(/u);
  assert.match(source, /saveNav\(createServerStore\(localStorage, scopeRuntime\.id, writeGate\), \{ page, pane: view\.termPane, splitLayout: view\.splitLayout, splitCells: view\.splitCells \}\);/u,
    'the saved state writes the refs App already holds, rather than rebuilding them');
  // Every reference is minted in ONE place per kind, from the bound server.
  // ③b-1: minted for the tree that asks, from ITS runtime; the window's
  // forms are that, for the bound tree.
  assert.match(source, /function showPane\(session, target\) \{ showPaneIn\(bound\(\), view, session, target\); \}/u);
  assert.match(source, /function showPaneIn\(runtime, v, session, target\) \{\s*v\.termPane = target && runtime \? paneRef\(runtime\.id,/u);
  assert.match(source, /function showSession\(session\) \{ showSessionIn\(bound\(\), view, session\); \}/u);
  assert.match(source, /function showSessionIn\(runtime, v, session\) \{\s*v\.filesRef = session && runtime \? sessionRef\(runtime\.id, session\) : null;/u);
  for (const write of [...source.matchAll(/^\s*v\.termPane = (.+)$/gmu)]) {
    assert.match(write[1]!, /paneRef\(runtime\.id|^null;$|^s\.pane;$/u, `v.termPane = ${write[1]} — a pane is a reference`);
  }
  // Every write to the pane assigns a REF or null — never a bare target —
  // which is what makes "the identity has one home" checkable.
  assert.match(viewSource, /termPane = \$state<PaneRef \| null>\(null\);/u);
  for (const write of [...source.matchAll(/^\s*view\.termPane = (.+)$/gmu)].slice(1)) {
    assert.match(write[1]!, /paneRef\(navServerId\(\)|^pane;$|^null;$|^move\(view\.termPane\);$|^rebind\(view\.termPane\);$|^s\.pane;$/u,
      `view.termPane = ${write[1]} — a pane is a reference, not a target string`);
  }
  // The strings consumers and the wire take are DERIVED: a serverId cannot
  // reach a `target` or `session` argument.
  // ③a-4: they are derived in the VIEW (server-view.svelte.ts), per tree.
  assert.match(viewSource, /get terminalTarget\(\): string \{ return this\.termPane\?\.target \?\? ''; \}/u);
  assert.match(viewSource, /get terminalSession\(\): string \{ return this\.termPane\?\.session \?\? ''; \}/u);
  assert.match(viewSource, /get filesSession\(\): string \{ return this\.filesRef\?\.session \?\? ''; \}/u);
  assert.match(source, /<SplitView cells=\{v\.splitViewCells\}/u, 'and the split hands over strings too');
  // What it hands over is the pane's own names and NOTHING else: a serverId
  // that reached a `target` would be sent to tmux as part of a pane address.
  const adapter = viewSource.match(/get splitViewCells\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(adapter, /target: c\.pane\?\.target \?\? '', session: c\.pane\?\.session \?\? ''/u);
  assert.doesNotMatch(adapter, /serverId/u, 'the serverId stops at this boundary');
  // A rename belongs to ONE server — the one its event names (reviewer P1 on
  // the b3 binding range; the rename-event test below pins the source).
  assert.match(source, /const rename = \{ serverId, from, to \};\s*const move = \(ref\) => \(ref \? retargetRef\(ref, rename\) : ref\);/u);
  // A landing names its tree, and is delivered only to that tree.
  // ③a-4: to the tree it names — each tree asks with its own runtime.
  assert.match(source, /function landingFor\(request, runtime\) \{\s*return request && runtime && request\.serverId === runtime\.id \? request : null;/u);
  for (const req of ['agentsEditReq', 'filesNavReq', 'boardIssueReq']) {
    assert.match(source, new RegExp(`landingFor\\(v\\.${req}, runtime\\)`, 'u'), `${req} is delivered to its own tree`);
  }
  for (const req of ['filesNavReq', 'boardIssueReq']) {
    assert.match(source, new RegExp(`v\\.${req} = \\{ serverId: runtime\\.id,`, 'u'), `${req} names its tree`);
  }
  assert.doesNotMatch(source, /JSON\.parse\(localStorage\.getItem\('tmux_state'\)/u,
    'nothing parses the saved state by hand any more');
  // One definition of what a landing is: the swap and the reset share it.
  assert.match(source, /function resetServerMemory\(\) \{[\s\S]*?clearLandings\(\);/u);
  assert.equal([...source.matchAll(/filesNavReq = null/gu)].length, 1,
    'the landings are cleared in clearLandings and nowhere else');
});

test('failover success RECORDS by machine identity — and never moves CURRENT (board #55)', async () => {
  // A reconnect that proved a DIFFERENT address of the SAME machine merges it
  // into the one entry instead of growing a second "server" (the lead-review
  // invariant: multi-server must not break the multi-address semantics), and
  // recording is NOT activating. Since reviewer P1-A on cc45d7d1 that record
  // is the reconnecting runtime's OWN dial — the address it was told to try,
  // stamped with the machine that answered — so App's success path records
  // nothing, and an answer from another machine never reaches it as "up".
  const runtimeSrc = await readFile(new URL('./lib/app/server-runtime.ts', import.meta.url), 'utf8');
  assert.match(runtimeSrc, /const address = how\.via \|\| route\?\.address \|\| target\.address;/u, 'the failover address is the one dialled');
  assert.match(runtimeSrc, /recordServer\(storage, \{\s*address,\s*token,[\s\S]*?machineId: machine/u,
    'the active address follows the connect, merged by machine identity, never by address alone');
  assert.match(source, /connect: \(address, _token, timeoutMs, claim\) => serverSwitch\.idle\(\)\.then\(\(\) => \{\s*if \(!claim\?\.current\(\)\) throw new Error\('superseded'\);\s*return runtime\.dial\(\(\) => claim\.current\(\), \{ via: address, timeoutMs \}\);/u,
    'the reconnect loop dials through the runtime it belongs to, under THAT attempt s own claim (reviewer P1-2 on 341554b3)');
  assert.match(source, /onSuccess: \(_useAddr, _primaryAddr, attempt, result\) => \(bound\(\) === runtime \? onReconnected\(runtime, result, attempt\) : memberReconnected\(runtime, result\)\),/u, 'and hands on that attempt s own result');
  const rc = source.match(/function reconnectorOf\(runtime\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  assert.doesNotMatch(rc, /let (claim|last)\b/u, 'nothing in a loop is shared between its attempts');
  const fn = source.match(/function onReconnected\(runtime, result, attempt\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(fn, 'onReconnected found');
  assert.ok(!/recordServer|activateConnected|applySwitch/u.test(fn), 'failover records nothing more, and never activates');
  assert.match(fn, /if \(!result\?\.ok\) \{ void arrivedElsewhere\(result, attempt\); return; \}/u,
    'another machine s answer is an ARRIVAL there, never this server resumed over it');
});

test('a Settings connect to a DIFFERENT server comes up in place before onConnected (board #55 → 315)', async () => {
  // connect() swaps the socket but every server-bound memory is the old
  // server's, and the old tmux_state was never parked. The form asks
  // activateConnected AFTER auth and BEFORE onConnected: same server →
  // proceed in place, different server → onConnected(true), which resets the
  // per-server memory and remounts the tree (board 315; was location.reload()).
  const settings = await readFile(new URL('./lib/app/Settings.svelte', import.meta.url), 'utf8');
  const fn = settings.match(/async function doConnect\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  // Since board #335 ②b-4 one call carries the verdict: activate records
  // identity, the candidate closes, and onConnected(switched) follows.
  const iAct = fn.indexOf('activateConnected(localStorage');
  const iSwitched = fn.indexOf('switched = act.reload;');
  const iClose = fn.indexOf('own.close();\n      const second = onConnected(switched) || null;');
  assert.ok(iAct >= 0 && iSwitched > iAct && iClose > iSwitched,
    'activate → the verdict → the candidate closes → only then the app is told');
  // And the form stays busy through the server's OWN handshake, shows its
  // failure, and Cancel reaches it (reviewer P1-D on cc45d7d1).
  assert.match(fn, /secondHalf = second;\s*second\?\.committed\?\.then\([^\n]*\n\s*const failure = second \? await second\.done : null;\s*if \(mine\(\) && failure\) error = failure;/u);
  assert.match(fn, /\} finally \{(?:\s*\/\/[^\n]*)*\s*own\.close\(\);\s*if \(candidate === own\) candidate = null;\s*if \(mine\(\)\) \{ connecting = false; committing = false; secondHalf = null; \}\s*\}/u,
    'every end of an attempt closes its candidate and, if it is still the form s, ends the busy state');
  assert.match(settings, /function cancelConnect\(\) \{[\s\S]*?secondHalf\?\.cancel\(\);/u, 'Cancel covers the second handshake');
  // Until its point of no return; past it, no Cancel is offered (reviewer P2 on 027d1a92).
  assert.match(fn, /second\?\.committed\?\.then\(\(\) => \{ if \(mine\(\) && secondHalf === second\) committing = true; \}\);/u);
  assert.match(settings, /\{#if !committing\}\s*<button class="cancel-btn" onclick=\{cancelConnect\}>/u);
  // An identity-activation failure is NOT a success: an error, the
  // candidate closed, the app not told (board #335 ②b-4).
  assert.match(fn, /\} catch \{[\s\S]*?error = t\('configIdentityFailed'\);\s*own\.close\(\);[\s\S]*?\}\s*return;/u,
    'a peer that authenticated but could not be identified is an error, not a success');
  // Three questions, and each covers a case the others cannot: the component
  // is still there, this is still the instance's latest attempt, and the app
  // is still waiting on this candidate at all (the host activation
  // generation; orchestrator's addendum, 01:46).
  // `mine` (this form's attempt: its busy state and error) is apart from
  // `live` (may it still conclude anything for the app), so a candidate the
  // app stopped waiting on can never be what leaves the form busy.
  assert.match(fn, /const mine = \(\) => mounted && attempt === attempts && !cancelled;\s*const live = \(\) => mine\(\) && own\.current\(\);/u);
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
  const on = source.match(/function onConnected\(switched = false\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  const act = source.match(/function activate\(\{ replace = false, elsewhere = 'arrive', up, minted = null, chain = null \}\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  // A different server ARRIVES: its runtime is minted (its state built),
  // DIALS on its own connection, and only then is shown, the memory of the
  // server left reset, and the app brought up (board #335 ②b-4: its
  // handshake is the identity of record; order (a): the one left is ended
  // only after). A failure puts CURRENT back on the server left.
  assert.match(on, /const left = bound\(\)\?\.id \?\? '';[\s\S]*?if \(switched\) return arriveAt\(left\);/u);
  assert.match(source, /function arriveAt\(left, elsewhere = 'arrive', chain = null\) \{[\s\S]*?restoreCurrent\(localStorage, left\)[\s\S]*?c\.onCancel\(back\);[\s\S]*?activate\(\{ replace: true, elsewhere,[\s\S]*?if \(failure && c\.current\(\)\) back\(\);/u,
    'a failure or a cancel goes back to the server left — only for the chain that is still the app s (reviewer P1-4 on 341554b3)');
  assert.match(act, /const m = minted \?\? mintCurrent\(\);[\s\S]*?const owner = activations\.claim\(scopeSwap\.bound\(\)\);[\s\S]*?runtime\.dial\(owner\.current\)\.then\(async \(result\) => \{\s*if \(!owner\.current\(\)\) \{ releaseMinted\(runtime, owner\); return null; \}[\s\S]*?const gate = foldCurrent\(\);\s*if \(gate\.fold === 'blocked'\) return blockedAfterDial\(runtime, owner\);[\s\S]*?c\.publishing\(\);[\s\S]*?const swapped = m\.keep \? Promise\.resolve\(\) : scopeSwap\.swap\(runtime\);\s*if \(replace\) \{\s*resetServerMemory\(\);\s*centreSurface\.reset\(\);[\s\S]*?await swapped;\s*if \(!owner\.current\(\) \|\| scopeSwap\.bound\(\) !== runtime\) return null;\s*up\(result\);/u,
    'mint → claim → dial → (still the latest) the storage gate for what it learned → publish → reset → BOUND → bring up (reviewer P1-3 on 341554b3)');
  // A gate that blocks publishes nothing and ends nothing (ruling K, 06:09).
  const blocked = source.match(/function blockedAfterDial\(runtime, owner\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(blocked, /releaseMinted\(runtime, owner\);[\s\S]*?owedActivation = true;/u);
  assert.doesNotMatch(blocked, /scopeSwap\.swap|ends\.end|fleet\.drop/u, 'the runtime the tree is bound to is not ended by the block');
  // ③a (orchestrator 08:17): the tree stays mounted while blocked, held —
  // inert and hidden — so nothing typed is lost; this was "no tree renders".
  assert.match(source, /\{#each members as runtime \(runtime\)\}\s*\{@const v = viewOf\(runtime\)\}\s*\{@const held = storageHeld \|\| runtime !== scopeRuntime\}\s*\{@const shown = !held\}(?:\s*<!--[\s\S]*?-->)?\s*<div class="scope-tree" class:held inert=\{held\}>\s*<ServerScope /u, 'and the server tree is held while blocked, as is every tree out of focus');
  // A link a redirect or a re-mint starts is part of the SAME chain: awaited,
  // and cancelled with it (reviewer P1-4 on 341554b3).
  assert.match(act, /return activate\(\{ replace, elsewhere, up, minted: mintFrom\(gate\), chain: c \}\)\.done;/u, 'a re-mint is the next link, awaited');
  assert.doesNotMatch(act, /void activate\(|void arrivedElsewhere\(/u, 'no link is fire-and-forget');
  assert.match(act, /if \(result\.reason === 'elsewhere'\) \{[\s\S]*?if \(elsewhere === 'arrive'\) return arrivedElsewhere\(result, owner, c\);/u, 'what the runtime s own dial found is the identity of record, and that arrival is the chain s next link');
  assert.match(act, /const handle = \(done\) => \(\{ done, cancel: c\.cancel, current: c\.current, committed: c\.committed \}\);/u, 'and the caller can wait on the whole chain, cancel it, ask whether it is still the latest, and learn when it can no longer be cancelled');
});

test('the boot auto-connect RECORDS the machine identity, never activates (board #55)', () => {
  // Most sessions connect through the boot path; without this stamp an
  // entry never learns its machineId and a later connect to an alternate
  // address of the SAME machine reads as a new server (live Chromium
  // finding). Record only — the entry booted as current.
  // Since reviewer P1-A/P1-B on cc45d7d1 the boot takes the ONE bring-up
  // road: CURRENT's own runtime dials WHERE its entry says (never a mirror
  // an unanswered form left), and that dial is what records the identity
  // (pinned in the failover test). The activation is claimed after the
  // mint, so the boot never invalidates its own claim.
  const boot = source.match(/\$effect\(\(\) => \{\s*\/\/ Not while the migration is blocked;[\s\S]*?\n  \}\);/u)?.[0] ?? '';
  assert.match(boot, /const route = targetOf\(localStorage, currentServerId\(localStorage\)\);/u);
  assert.match(boot, /const run = activate\(\{ replace: false, up: \(\) => \{ bringUp\(\); \} \}\);\s*run\.done\.then\(\(failure\) => \{\s*clearTimeout\(timeout\);\s*if \(failure\) page = 'settings';/u);
  assert.doesNotMatch(boot, /activateConnected|recordServer|tmux_address|\.dial\(/u, 'boot never activates, records or dials around the road');
  const act = source.match(/function activate\(\{ replace = false, elsewhere = 'arrive', up, minted = null, chain = null \}\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  assert.match(act, /const m = minted \?\? mintCurrent\(\);[\s\S]*?const owner = activations\.claim\(scopeSwap\.bound\(\)\);/u, 'claimed AFTER the mint, whose endAll would otherwise end it');
  assert.match(act, /\.catch\(\(\) => \{\s*(?:\/\/[^\n]*\n\s*)*releaseMinted\(runtime, owner\);\s*if \(!owner\.current\(\)\) return null;\s*page = 'settings';\s*storageFailed\(\);/u,
    'a write that fails inside the dial goes to the host gate (reviewer P1 on 23879812) — and a stale one reports nothing (reviewer P1-4 on 341554b3)');
  // A SUPERSEDED dial reports nothing: whoever took over owns the outcome,
  // and sending the app to Settings would undo a connect that is succeeding.
  assert.match(act, /if \(result\.reason === 'superseded'\) return null;/u);
  // Every identity-write failure path reports to the ONE gate.
  for (const [where, pattern] of [
    ['the form', /onIdentityFailed=\{storageFailed\}/u],
    ['a reconnect', /reconnectError = t\('configIdentityFailed'\);\s*storageFailed\(\);/u],
    ['an arrival', /\} catch \{ page = 'settings'; storageFailed\(\); return t\('configIdentityFailed'\); \}/u],
    ['a switch', /identityFailed: storageFailed,/u],
    ['an address change', /\}, \(\) => \{ if \(mine\(\)\) storageFailed\(\); return 'handled'; \}\);/u],
    ['a deep link', /\} catch \{ storageFailed\(\); \}\s*\/\/ the saved connection stays as it was/u],
  ] as const) assert.match(source, pattern, `${where} reports through the gate`);
  // Every reconnect attempt claims the activation, and dials through the
  // runtime it belongs to, after any walk has answered.
  // ③a (reviewer P1-3): a chain's cancel is local — the window's attempts
  // and the server it was bringing up, never every member's; `endAll()` is
  // the root's (the teardown) and the block's alone.
  assert.match(source, /const mine = !!owner\?\.current\(\);\s*cancelled = true;\s*(?:\/\/[^\n]*\n\s*)*if \(mine\) activations\.claim\(runtime\);/u);
  assert.deepEqual([...source.matchAll(/activations\.endAll\(\)/gu)].length, 2, 'endAll: holdStorage and onDestroy, nowhere else');
  // ③a: a reconnect claims its OWN runtime's generation (reviewer P1-A).
  assert.match(source, /attempt: \(\) => activations\.member\(runtime\)\.claim\(\),/u);
  assert.match(source, /connect: \(address, _token, timeoutMs, claim\) => serverSwitch\.idle\(\)\.then\(\(\) => \{\s*if \(!claim\?\.current\(\)\) throw new Error\('superseded'\);/u,
    'one question at a time: a reconnect dial waits for the walk, and one taken over meanwhile is nobody s');
  const rc = source.match(/function reconnectorOf\(runtime\) \{[\s\S]*?\n  \}\n/u)?.[0] ?? '';
  assert.doesNotMatch(rc, /heldOffline = false|recordServer|tmux_address|tmux_token/u, 'an automatic attempt lifts no stay, records nothing itself and reads no mirror');
  // The dial found ANOTHER known machine and both entries stay: the app
  // arrives there like the connect page does, after asking A's editors
  // (reviewer, 18:54 on 5ca0e79e). An absorbed alias already moved CURRENT:
  // the survivor's own runtime dials (reviewer P1-B on cc45d7d1).
  const elsewhere = source.match(/async function arrivedElsewhere\(result, attempt, chain = null\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  // #335 ③b-2: the absorbed alias's survivor is a NEW tree too, so both
  // arrivals ask the bound tree's pages first, through ONE helper.
  assert.match(elsewhere, /^async function arrivedElsewhere\(result, attempt, chain = null\) \{\s*if \(migrationBlocked\) \{[^\n]*\}\s*(?:\/\/[^\n]*\n\s*)*if \(!attempt\.current\(\)\) return null;\s*(?:\/\/[^\n]*\n\s*)*const same = currentServerId\(localStorage\) === result\.entry\.id;\s*(?:\/\/[^\n]*\n\s*)*const leave = await askToReplace\(\);\s*if \(leave === null \|\| !attempt\.current\(\)\) return null;\s*if \(!leave\) \{[\s\S]*?\n    \}\s*(?:\/\/[^\n]*\n\s*)*if \(same\) return activate\(\{ replace: false, up: \(\) => \{ bringUp\(\); resubscribeAll\(\); \}, chain \}\)\.done;/u,
    'a stale arrival does nothing; every arrival asks first; an absorbed alias comes up on the canonical runtime s own dial');
  const ask = source.match(/async function askToReplace\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(ask, /leave = await serverSwitch\.guard\(\(\) => confirmLeave\(\{ leaving, current: page,[\s\S]*?if \(!leave\) \{\s*connected = false;\s*heldOffline = true;/u);
  assert.equal([...source.matchAll(/askToReplace\(\)/gu)].length, 2, 'defined once, used once: every automatic arrival goes through arrivedElsewhere');
  assert.ok(elsewhere.indexOf('askToReplace(') < elsewhere.indexOf('activateConnected('), 'ask, then write');
  assert.match(elsewhere, /const run = act\.reload \? arriveAt\(left, 'arrive', chain\) : activate\([\s\S]*?chain \}\);\s*return await run\.done;/u,
    'both kept: arrive at B through the connect page s different-server path');
  // A drop while blocked dials nothing, and is owed to Retry (orchestrator 16:12).
  assert.match(source, /function onDrop\(\) \{\s*if \(switching\) return;[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*if \(heldOffline\) return;\s*if \(migrationBlocked\) \{ owedActivation = true; return; \}/u);
  assert.match(source, /if \(document\.visibilityState !== 'visible' \|\| switching \|\| serverSwitch\.guarding \|\| heldOffline \|\| migrationBlocked\) return;/u);
  assert.match(source, /if \(!serverSwitch\.owns\(intent\) \|\| serverSwitch\.guarding \|\| heldOffline \|\| migrationBlocked\) return;/u, 'a probe that answers during a walk, or after a stay, moves nothing');
});

test('the fold gate: an unrecorded migration binds no server and moves no CURRENT (board #335 ②b-4)', async () => {
  // ONE persisted attribution state (server-state-migration.ts), and every
  // step the boot needs before a bind inside one recoverable gate.
  // ③a: a block is decided through holdStorage, which closes the write gate
  // and freezes every runtime in the same turn.
  assert.match(source, /function prepareStorage\(\) \{\s*try \{\s*migrateServers\(localStorage\);\s*if \(migrateServerState\(localStorage\)\.reason === 'unrecorded'\) holdStorage\(\);(?:\s*\/\/[^\n]*)*\s*else migrationBlocked = false;\s*\} catch \{ holdStorage\(\); \}/u,
    'a registry or attribution write that fails is the same blocked state, never a throw out of App');
  // A block is the app's until Retry (reviewer P1 on 453f02b8): the gate
  // never re-prepares it open, and the only preparations are the boot, the
  // host gate when NOT blocked, and Retry.
  assert.match(source, /function foldFor\(id\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(migrationBlocked\) return 'blocked';\s*let reason;/u);
  assert.equal([...source.matchAll(/\bprepareStorage\(\);/gu)].length, 3, 'boot, storageFailed, retryMigration');
  assert.match(source, /function storageFailed\(switchTarget = null\) \{\s*if \(migrationBlocked\) return;\s*prepareStorage\(\);/u);
  assert.match(source, /if \(reason === 'pending'\) \{\s*const claim = claimPending\(localStorage, id\)\.reason;/u, 'a pending input meets every server that is bound');
  assert.doesNotMatch(source, /requireProof|foldNeedsProof|quarantineLegacyNav/u, 'nothing re-infers the attribution per App instance');
  // Frozen while blocked: every way CURRENT could move.
  assert.match(source, /if \(link && migrationBlocked\) deferredLink = link;/u, 'a deep link waits');
  assert.match(source, /if \(autoConnectAttempted \|\| connected \|\| switching \|\| migrationBlocked\) return;/u, 'no boot dial');
  assert.match(source, /frozen: \(\) => migrationBlocked,/u, 'no switch, no address connect');
  assert.match(source, /async function optimizeConnection\(\) \{\s*if \(migrationBlocked\) return;/u, 'no optimizer');
  assert.match(source, /function onReconnected\(runtime, result, attempt\) \{(?:(?!\n  \}\n)[\s\S])*?if \(migrationBlocked\) \{ runtime\.connection\.disconnect\(\); connected = false; owedActivation = true; return; \}/u, 'no late reconnect; Retry owes it its dial');
  assert.match(source, /frozen=\{migrationBlocked \? t\('migrationBlockedNote'\) : ''\} onRetry=\{retryMigration\}/u, 'and the form offers only Retry');
  const settings = await readFile(new URL('./lib/app/Settings.svelte', import.meta.url), 'utf8');
  assert.match(settings, /async function doConnect\(\) \{\s*if \(frozen\) return;/u, 'not only its button');
  // And every other registry writer (reviewer P2-b on 08fdb6ba).
  assert.match(source, /if \(!hostname \|\| migrationBlocked\) return;/u, 'the hostname adoption');
  assert.match(source, /function serverRename\(id, name\) \{ if \(!migrationBlocked\)/u);
  assert.match(source, /function serverRemove\(id\) \{ if \(migrationBlocked\) return;/u);
  assert.match(source, /onAddressesChange=\{\(next\) => \{\s*if \(migrationBlocked\) return;/u);
  // No runtime is minted while blocked, so nothing dials and the dial's
  // record never runs; Retry owes the activation the block stopped.
  assert.match(source, /if \(!runtime\) \{(?:\s*\/\/[^\n]*)*\s*if \(migrationBlocked\) \{ enterBlocked\(\); owedActivation = true; \}\s*else if \(!m\.keep\) void scopeSwap\.swap\(null\);/u,
    'a blocked bring-up dials nothing, records nothing, is owed its dial — and keeps the source');
  // Every way into the blocked state is the ONE `enterBlocked`, which ends
  // nothing (ruling K; reviewer on 027d1a92: the pre-dial and the host-gate
  // entries ended A before).
  const enter = source.match(/function enterBlocked\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(enter, 'enterBlocked found');
  assert.doesNotMatch(enter, /scopeSwap\.swap|swapScope|ends\.end|fleet\.drop/u, 'the blocked state ends nothing');
  const gateFn = source.match(/function storageFailed\(switchTarget = null\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.match(gateFn, /enterBlocked\(\);/u);
  assert.doesNotMatch(gateFn, /scopeSwap\.swap|swapScope\(/u, 'the host gate unbinds nothing');
  assert.match(source, /function bringUp\(\) \{[\s\S]*?if \(migrationBlocked\) \{ page = defaultPage\(\); return; \}/u, 'bringUp restores nothing while frozen');
  // The merge rewrite is inside the gate (P1-3), and Retry resumes the
  // connection by its real state (P1-2).
  assert.match(source, /if \(fold !== 'blocked' && !followMerges\(\)\) \{ holdStorage\(\); fold = 'blocked'; \}/u);
  assert.match(source, /if \(minted\.runtime\.connection\.isConnected\(\)\) serverReady\(\);\s*else if \(!heldOffline\) reconnect\(\)\.start\(\);/u,
    'a block mid-session resumes the bound runtime s own loop');
  assert.match(source, /const owed = owedActivation && !heldOffline;\s*owedActivation = false;[\s\S]{0,600}?if \(!owed\) return;\s*autoConnectAttempted = true;[\s\S]{0,300}?void activate\(\{ minted, replace: !minted\.keep,/u,
    'an owed activation dials the runtime it minted, through the one road');
  // Retry re-dials whatever the block or an absorption interrupted, members
  // included, never by whether a handle is alive (orchestrator 16:12); a
  // re-dial that lands elsewhere asks in `arrivedElsewhere`.
  assert.match(source, /syncMembers\(\);\s*aggregate\.resume\(\);/u);
  // Every per-server read and write goes through the server's store.
  assert.match(source, /saveNav\(createServerStore\(localStorage, scopeRuntime\.id, writeGate\),/u);
  assert.match(source, /readNav\(createServerStore\(localStorage, target\.id, writeGate\)\)/u);
  assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem|removeItem)\('tmux_(?:state|hub_project|hub_drafts|hub_seen|hub_lead|hub_drawer|hub_roster_expanded|hub_alerts|machine_id)'/u,
    'App reads and writes no legacy per-server key');
});

test('nothing writes the unprefixed tmux_machine_id (board #55, #335 ②b-4)', async () => {
  // Lead blocker #2: the form pre-wrote the NEW machine's id into the live
  // key before activating, so parkAndPoint filed it under the OLD server's
  // parking slot. The map (tmux_machines, keyed by machineId) stays the
  // form's to update; the live key belongs to the activation.
  const settings = await readFile(new URL('./lib/app/Settings.svelte', import.meta.url), 'utf8');
  const fn = settings.match(/async function doConnect\(\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(!fn.includes("setItem('tmux_machine_id'"), 'no live machine-id pre-write in the form');
  assert.match(fn, /setItem\('tmux_machines'/u, 'the identity MAP update stays');
  // Nothing writes it since board #335 ②b-4: it is the frozen legacy mirror,
  // the evidence a server must match to claim pre-#335 inputs.
  assert.doesNotMatch(source, /setItem\('tmux_machine_id'/u, 'App writes no unprefixed machine id');
  for (const mod of ['./lib/app/servers.ts', './lib/app/server-switch.ts', './lib/app/server-runtime.ts']) {
    assert.doesNotMatch(await readFile(new URL(mod, import.meta.url), 'utf8'), /setItem\('tmux_machine_id'/u, `${mod} writes none either`);
  }
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
  assert.match(source, /function serverRemove\(id\) \{ if \(migrationBlocked\) return; serverList = removeServer\(localStorage, id\);/u, 'App removes by the id it is handed');
});

test('one system-vitals strip serves desktop sidebar and an open phone drawer (board #85)', () => {
  // ONE component (src/lib/system/), transport injected from ws.ts — App
  // wires, it does not re-implement or mount one poller per page.
  assert.match(source, /import SystemStatus from '\.\/lib\/system\/SystemStatus\.svelte'/u,
    'the shared component, not a second rendering');
  // The bound runtime's (board #335 ②b-4): there is no module-level one.
  assert.doesNotMatch(source, /import \{[^}]*\bsystemStatus\b[^}]*\} from ['"]\.\/lib\/core\/ws\.ts['"]/u,
    'no facade import of the sampler');
  assert.equal((source.match(/<SystemStatus\b/gu) ?? []).length, 1, 'exactly one sampler component');
  assert.match(source, /load=\{\(\) => bound\(\)\?\.api\.systemStatus\(\)/u, 'load is INJECTED, from the bound runtime — the component never imports ws');
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
  // Since reviewer P1-A on cc45d7d1 the CURRENT runtime redials it itself:
  // no shared socket to disconnect first, and no token passed in.
  assert.match(mod, /function connectAddress\(address: string\)[\s\S]*?const intent = \+\+seq;[\s\S]*?const owner = d\.claim\(\);[\s\S]*?d\.stopReconnect\(\);\s*return d\.redial\(address, mine, owner\)\.then\(/u,
    'claim → cancel → redial, handing the dial THIS attempt s ownership (reviewer P1-2 on 341554b3)');
  assert.doesNotMatch(mod.match(/function connectAddress\(address: string\)[\s\S]*?\n  \}/u)?.[0] ?? '', /d\.disconnect\(\)|d\.connect\(/u,
    'an address change never touches the switch s candidate');
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
  assert.match(source, /function railActivate\(slot\) \{[\s\S]*?if \(slot === page\) \{ \(\(storageHeld \? null : view\.pageReselect\[slot\]\) \?\? shellReselect\[slot\]\)\?\.\(\); return; \}/u);
  assert.match(viewSource, /pageReselect: Record<string, \(\(\) => void\) \| undefined> = \{\};/u);
  assert.match(source, /onReselect=\{\(fn\) => \{ v\.pageReselect\.hub = fn; \}\}/u, 'the Hub registers its reselect like its back chain');
});

test('one shell-wide sidebar state: the Terminal page and the system status follow the Hub\'s collapse; reselect opens it on every page (board #200)', async () => {
  // Owner 2026-09-14: "左侧边栏收起的时候，底下的系统状态显示也要收起，而且这个折叠收起在不同的
  // 页面是同步的，不然我点击chat terminal board，展开状态不一致".
  assert.match(source, /const shellSideCollapsed = \$derived\(shell && !layout\.isTouchDevice && appPrefs\.sidebarCollapsed\);/u);
  assert.match(source, /<main class:with-rail=\{[^}]+\} class:touch-layout=\{[^}]+\} class:side-collapsed=\{shellSideCollapsed\} class:side-page=\{pageHasSidebar\}/u);
  // ③a-4: the shell's toggle is the fallback for a page no tree registered.
  assert.match(source, /const toggleShellSide = \(\) => appPrefs\.setSidebarCollapsed\(!appPrefs\.sidebarCollapsed\);[\s\S]{0,200}?const shellReselect = \{ terminal: toggleShellSide, board: toggleShellSide \};/u, '#199 on every page, a toggle since #201');
  assert.match(source, /<Board session=\{v\.filesSession\} guardPage="board" visible=\{shown && page === 'board'\} sideCollapsed=\{shellSideCollapsed\}/u);
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
  assert.match(source, /function toggleShellSidebar\(\) \{\s*\n\s*\(\(storageHeld \? null : view\.pageReselect\[page\]\) \?\? toggleShellSide\)\(\);/u,
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
  assert.match(source, /onimmersive=\{\(on\) => v\.filesImmersive = on\}/u, 'Files reports, App mirrors');
  assert.match(source, /class:immersive=\{view\.filesImmersive && page === 'files'\}/u, 'only while Files is the page on screen');
  assert.match(source, /\.immersive \.tabbar \{ display: none; \}/u);
  assert.match(source, /:global\(html\.keyboard-open\) \.tabbar \{ display: none; \}/u, 'the keyboard hide it sits beside');
});

test('every connect path runs the one server handshake, which loads backends_list (board #253)', () => {
  // The boot path (a page load with a saved token, the most common connect)
  // called probeHub alone, so the backend list was never loaded and the Agents
  // editor hid the queue/steer field on the live app while the mount tests,
  // which serve the list directly, passed. Each place that marks the socket
  // connected must reach serverReady(), and nothing may probe or load
  // backends on its own beside it.
  const ready = source.match(/function serverReady\(runtime = scopeSwap\.bound\(\)\) \{([\s\S]*?)\n  \}/u)?.[1] ?? '';
  assert.match(ready, /runtime\.probeCaps\(/u, 'one probe, both questions');
  // Into the bound runtime's own catalog (board #335 ②b-3).
  assert.match(ready, /serverStates\.get\(runtime\)\?\.backends\.set\(caps\.backends\);/u);
  const sites = [...source.matchAll(/connected = true;/gu)].map((m) => m.index!);
  assert.equal(sites.length, 3, 'boot, reconnect success, manual connect');
  for (const at of sites) {
    const rest = source.slice(at);
    const nextFn = rest.search(/\n  (?:async )?function /u);
    const body = nextFn < 0 ? rest : rest.slice(0, nextFn);
    assert.match(body, /serverReady\(\);/u, `the connect path at offset ${at} runs the handshake`);
  }
  const outside = source.replace(/function serverReady\(runtime = scopeSwap\.bound\(\)\) \{[\s\S]*?\n  \}/u, '');
  assert.doesNotMatch(outside, /probeCaps\(/u, 'no path does half the handshake');
});

test('a connect lands on the default page, Chat — never a hard-coded Terminal (#333)', () => {
  // The same-server branch of the one connect path (board #335 ②b-4).
  const connected = source.match(/function onConnected\(switched = false\) \{[\s\S]*?\n  \}/u)?.[0] ?? '';
  assert.ok(connected, 'onConnected found');
  assert.match(connected, /page = defaultPage\(\);/u);
  assert.doesNotMatch(connected, /page = 'terminal'/u);
  // The one hubless fallback stays: Chat on a server without the Hub becomes Terminal.
  assert.match(source, /if \(\(page === 'hub' \|\| page === 'agents' \|\| page === 'board'\) && view\.hubState\.probed && !view\.hubState\.available\) page = 'terminal';/u);
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

test('a project rename moves only the references of the server that renamed it (reviewer P1 on the b3 binding range)', () => {
  // The Hub names its own server on the event, from its scope; App does not
  // fill in whichever server is bound, and an event naming none moves nothing.
  const handler = source.match(/const onRenamed = \(e\) => \{([\s\S]*?)\n    \};/u)?.[1] ?? '';
  assert.match(handler, /const \{ serverId, from, to \} = e\.detail \?\? \{\};/u);
  assert.match(handler, /if \(!serverId \|\| !from/u, 'no server named, nothing moves');
  assert.match(handler, /const rename = \{ serverId, from, to \};/u);
  assert.doesNotMatch(handler, /navServerId\(\)/u, 'never the bound server s id');
});

test('a reconnect is announced for ONE server, named (board #335 ②b-4, reviewer P2 on the b3 binding range)', () => {
  assert.equal([...source.matchAll(/'ws-reconnected'/gu)].length, 1, 'one place announces it');
  assert.match(source, /function announceReconnected\(runtime = bound\(\)\) \{\s*const id = runtime\?\.id;\s*if \(id\) window\.dispatchEvent\(new CustomEvent\('ws-reconnected', \{ detail: \{ serverId: id \} \}\)\);/u,
    'naming the bound runtime, and never with no server');
});
