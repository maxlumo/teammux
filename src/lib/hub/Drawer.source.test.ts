import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile(new URL('./Drawer.svelte', import.meta.url), 'utf8');

test('window choices and the one-character disclosure keep both target dimensions (#166)', () => {
  const pill = /\.win-pill \{([^}]+)\}/u.exec(source)?.[1] ?? '';
  assert.match(pill, /height: var\(--control-height\)/u);
  assert.match(pill, /min-width: var\(--control-height\)/u);
});

test('the drawer pills show AGENT windows; the rest fold behind +N (board #92)', () => {
  // The switcher is for watching agents; shells and other windows are noise
  // that pushed the agent pills out of the bar ("只 filter 出当前有效的 agent
  // window，其他 window 可以帮我折叠起来"). Folded windows stay one tap away
  // behind a +N pill of the same family; the window currently ON SCREEN is
  // always a pill even when it belongs to the folded set — the bar may never
  // hide what the terminal is showing.
  // #320 moved the rule into ONE pure function (hub.ts drawerWindowPills,
  // unit-tested there): the shell window first, agents, the pane on screen.
  assert.match(source, /const bar = \$derived\(drawerWindowPills\(agents, winsExpanded,\s*\(a\) => termTarget\.startsWith\(`\$\{selected\}:\$\{a\.window\}\.`\)\)\);/u,
    'the bar reads the one definition, with the on-screen rule');
  assert.match(source, /const winsFolded = \$derived\(bar\.folded\);/u, 'the +N counts what is hidden');
  assert.doesNotMatch(source, /agents\.filter\(\(a\) => a\.agent/u, 'no private second fold rule');
  assert.match(source, /\{#each winPills as a \(a\.window\)\}/u, 'the pill loop reads the filtered list');
  assert.match(source, /\{#if winsFolded > 0 \|\| winsExpanded\}/u,
    'the toggle appears only when something is (or was) folded');
  const toggle = /<button class="win-pill state-ctl more"[\s\S]{0,600}?<\/button>/u.exec(source)?.[0] ?? '';
  assert.match(toggle, /onclick=\{onexpand\}/u, 'one tap requests the parent-owned unfold');
  assert.match(toggle, /winsExpanded \? t\('hubWinLess'\) : t\('hubWinMore'\)\.replace\('\{n\}', String\(winsFolded\)\)/u,
    'the toggle explains itself in words, not just a glyph');
});

test('the drawer wears the app ground and its head is the page-head\u2019s twin (board #23)', async () => {
  // A hardcoded #000 drawer leaked out as a black seam beside the chat column
  // ("侧边栏竖线现在是一个黑色的线条"): the terminal paints its OWN theme-
  // adapted background, so every uncovered sliver of the drawer read as black
  // in a light app. The drawer's ground is the app's.
  const drawer = /\.drawer \{ display: flex;[^}]*\}/u.exec(source)?.[0] ?? '';
  assert.match(drawer, /background: var\(--bg\);/u, 'the drawer sits on the theme ground');
  assert.ok(!source.includes('background: #000'), 'no hardcoded black ground anywhere in the Hub');
  // #166: preserve the matching divider via one owner, now letting a real
  // coarse target grow BOTH headers instead of drawing overlapping overlays.
  const atoms = await readFile(new URL('./hub-atoms.css', import.meta.url), 'utf8');
  const head = /\.hub-root \.chat-head \{[^}]*\}/u.exec(atoms)?.[0] ?? '';
  assert.match(source, /class="drawer-head chat-head"/u);
  assert.doesNotMatch(source, /\.drawer-head \{/u, 'no second header recipe');
  assert.match(head, /min-height: 42px; box-sizing: border-box;/u, 'the head shares the page-head height');
  assert.match(head, /border-bottom: 1px solid var\(--border\);/u, 'and the page-head border');
  assert.ok(!head.includes('background'), 'transparent over the shared ground — no second color');
  // The board partition's + lives in the drawer head and reaches the embedded
  // Board as a request (its own page-head is gone — see Board.source.test).
  assert.match(source, /onclick=\{onnewissue\}/u, 'the + requests the parent-owned counter update');
  assert.match(source, /<Board [^>]*createRequest=\{drawerBoardNew\}/u, 'and the Board receives it');
  // Parent-owned suppression (the lead's belt over the child's gate): the
  // drawer KNOWS the embedding, so it enforces the one-header contract itself —
  // any page-head a prop/HMR/child-path drift might leak into the partition
  // neither shows nor keeps its height. display:none, not visibility: a
  // hidden-but-laid-out header would still push the board down ("保留高度").
  assert.match(source, /\.board-body :global\(\.page-head\) \{ display: none; \}/u,
    'the drawer suppresses any child page-head — the drawer head is the only header');
});

test('Drawer is the real three-partition view with the original lifetimes (#136)', () => {
  assert.match(source, /import Terminal from '\.\.\/terminal\/Terminal\.svelte';/u);
  assert.match(source, /import Files from '\.\.\/files\/Files\.svelte';/u);
  assert.match(source, /import Board from '\.\/Board\.svelte';/u);
  assert.match(source, /<div class="term-body" class:off=\{drawerView !== 'term'\}>/u);
  assert.match(source, /\{#if termTarget\}\s*\{#key termTarget\}\s*<Terminal/u);
  assert.match(source, /active=\{visible && drawerView === 'term'\} visible=\{visible && drawerView === 'term'\}/u);
  assert.match(source, /\.term-body\.off \{ visibility: hidden; position: absolute; inset: 0; \}/u);
  assert.match(source, /drawerFilesDir = \$bindable\(''\), drawerFilesPath = \$bindable\(''\)/u);
  assert.match(source, /<Files [^>]*singlePane jumped onGoBack=\{onfilesback\} navRequest=\{drawerFilesReq\} bind:currentDir=\{drawerFilesDir\} bind:currentPath=\{drawerFilesPath\}/u);
  assert.match(source, /<Board [^>]*embedded issueRequest=\{drawerIssueReq\} createRequest=\{drawerBoardNew\}/u);
  assert.doesNotMatch(/<Board[^>]*>/u.exec(source)?.[0] ?? '', /onGoBack/u);
  assert.doesNotMatch(source, /\$state\(|core\/ws|hubPrefs|addEventListener|popstate/u,
    'persistent state, transport, preferences and capture listeners remain in Hub');
  assert.match(source, /onclick=\{\(\) => pickWindow\(a\)\}/u, 'pick carries the clicked window');
  for (const action of ['onterminal', 'onfiles', 'onboard', 'onnewissue', 'closeDrawer']) {
    assert.ok(source.includes(`onclick={${action}}`));
  }
  assert.match(source, /<SideHandle varName="--hub-drawer-w" storeKey="tmux_hub_drawer_w"/u);
  assert.match(source, /min=\{320\} max=\{900\} def=\{520\} edge="left"/u);
  assert.match(source, /class="win-pill state-ctl"[\s\S]{0,320}?use:hoverInfo=\{\(\) => pillInfo\(a\)\}/u);
  assert.doesNotMatch(source, /^\s*\.(spacer|empty|st|live-dot) \{/mu, 'shared atoms stay shared');
});
