// Hub coordinator contracts. Feed, Composer and Roster own their view contracts.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./Hub.svelte', import.meta.url), 'utf8');
// The staging pipeline moved out of Hub unchanged (board #329): its rules are
// read where it now lives; send()'s own snapshot/restore stays here.
const pipeline = await readFile(new URL('./attachments.svelte.ts', import.meta.url), 'utf8');

test('Chat header hit targets occupy layout instead of overlapping neighbors (#166)', () => {
  assert.doesNotMatch(source, /\.hub-root\.compact \.page-head [^\n]*::before/u);
  const head = source.slice(source.indexOf('<div class="page-head '), source.indexOf('{#snippet emptyFeed()}'));
  assert.doesNotMatch(head, /class="icon-btn/u);
  assert.match(head, /<CommandButton[^>]*icon="files"/u);
});

test('All menu actions keep their opening identity while items follow live state (#180)', () => {
  const actions = source.slice(source.indexOf('function allItems('), source.indexOf('const visibleCtxItems'));
  assert.match(actions, /const current = \(\) => selected === session && ctxAt\?\.allMenuId === menuId;/u,
    'a stale callback cannot affect a new room or a reopened menu');
  assert.match(actions, /if \(current\(\) && recipient === ALL_TARGET\) setRecipient\(''\)/u,
    'Record only still requires All to be the destination (#258: the menu also opens by right-click)');
  assert.match(source, /recipient !== ctxAt\.allFor\)\) closeCtx\(\)/u, 'the menu closes when the destination it opened under changes');
  assert.match(source, /const allMenuId = Symbol\('all-menu'\)/u);
  assert.match(source, /const visibleCtxItems = \$derived\(ctxAt\?\.allSession \? allItems\(ctxAt\.allSession, ctxAt\.allMenuId\)\s*: ctxAt\?\.teamSession \? teamItems\(ctxAt\.teamSession, ctxAt\.team, ctxAt\.teamMenuId\) : ctxItems\)/u,
    'normal menus keep their captured lists; All and a team (#258) follow current busy/pending inputs');
  assert.match(source, /<ContextMenu at=\{ctxAt\} items=\{visibleCtxItems\}/u);
});
const rule = (selector: string) =>
  source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'u'))?.[1] ?? '';

test('whose pane the partition shows has ONE definition: pickDrawerAgent, at every seat (#209)', () => {
  // Owner 2026-09-20: "选中的 agent card 好像保留了，但是右边侧边栏对应的 terminal 好像没有
  // 保留到我选的 agent" — the room-switch restore and the late seat chose the
  // first managed agent themselves while openDrawer/#91 followed the recipient.
  assert.match(source, /import \{[^}]*\bpickDrawerAgent\b[^}]*\} from '\.\/hub\.ts'/u);
  assert.equal([...source.matchAll(/pickDrawerAgent\(agents, recipient\)/gu)].length, 3,
    'openDrawer, the room-switch restore and the late seat after a fresh roster');
  assert.doesNotMatch(source, /agents\.find\(\(x\) => x\.managed\) \?\? agents\[0\]/u, 'no private copy of the rule');
  assert.doesNotMatch(source, /agents\.find\(\(x\) => x\.managed && x\.name === recipient\)/u);
});

test('Watch always selects the terminal view and shares one route between menu and card (#173)', () => {
  assert.match(source, /function watchAgent\(agent\) \{\s*drawerView = 'term';\s*openDrawer\(agent\);/u);
  assert.match(source, /if \(a\) watchAgent\(a\)/u, '#180: Watch is the existing menu verb, not a reserved card slot');
  assert.match(source, /if \(a\) watchAgent\(a\)/u);
  assert.match(source, /if \(mobile \|\| \(compact && drawerView === 'term'\)\)/u,
    'a narrow desktop cannot open an invisible terminal drawer');
});
test('open drawer tracks yield to the container without overwriting requested widths (#158, #154)', () => {
  // Fixed tracks overflowed a 1000px desktop: 46 rail + 240 sidebar +
  // 280 chat + 520 drawer = 1086, hiding maximize/close. Both side tracks
  // must yield: shrinking only the drawer fails with a wide saved sidebar.
  // CSS owns this geometry; a unit helper would duplicate the grid algorithm.
  // Since board #174 the three tracks are ALWAYS declared and each side track
  // is the requested width times an animatable open factor (0 = closed): the
  // same minmax yield, one formula for rest and motion.
  assert.match(rule('.hub-root:not(.compact) .cols'),
    /grid-template-columns:\s*minmax\(0,\s*calc\(var\(--sidebar-w\) \* var\(--side-open\)\)\)\s+minmax\(280px,\s*1fr\)\s+minmax\(0,\s*calc\(var\(--hub-drawer-w,\s*520px\) \* var\(--drawer-open\)\)\)/u);
  assert.match(rule('.hub-root.drawer-open .cols'), /^\s*--drawer-open:\s*1;\s*$/u, 'open = factor 1, nothing else');
  assert.match(rule('.hub-root.compact .cols'), /grid-template-columns:\s*minmax\(0,\s*1fr\)/u,
    'compact keeps its existing single column');
  assert.equal([...source.matchAll(/style\.setProperty\('--hub-drawer-w'/g)].length, 1,
    'Hub restores the requested width once; layout does not write a clamped preference');
  assert.doesNotMatch(source, /localStorage\.setItem\('tmux_hub_drawer_w'/u,
    'SideHandle remains the only preference writer');
});

test('Hub keeps the Drawer mount gate, durable state and navigation authority (#136)', () => {
  // #174: the Drawer stays mounted while its track shrinks (drawerShown =
  // open OR closing) — the gate is that, and still desktop-only.
  assert.match(source, /\{#if drawerShown && !compact\}\s*<!--[^]*?-->\s*<div class="track drawer-track" id=\{drawerId\} bind:this=\{drawerTrackEl\}>\s*<Drawer/u);
  assert.match(source, /bind:drawerFilesDir onpick=\{pickWindow\} onclose=\{closeDrawer\}/u);
  assert.match(source, /onfilesback=\{\(back\) => \{ drawerFilesBack = back; \}\}/u);
  assert.match(source, /onexpand=\{\(\) => \(winsExpanded = !winsExpanded\)\}/u);
  assert.match(source, /termTarget = ''; winsExpanded = false;/u);
  assert.match(source, /onterminal=\{\(\) => \{ const m = [^]*?if \(m\) openTerminal\(selected, termTarget\); \}\}/u);
  // #181: maximize hands the parked position, else the project's declared path.
  assert.match(source, /onfiles=\{\(\) => openFilesTab\?\.\(selected, drawerFilesDir \|\| projectPath\)\}/u);
  assert.match(source, /onboard=\{\(\) => openBoardTab\?\.\(selected\)\}/u);
  assert.match(source, /drawerBoardNew = \{ n: \(drawerBoardNew\?\.n \?\? 0\) \+ 1 \}/u);
  assert.doesNotMatch(source, /<Terminal |<Files |<Board |function pillInfo|const winPills/u);
});

test('Hub keeps Feed coordination and exposes only the agreed reading boundary (#134)', () => {
  assert.match(source, /<Feed bind:this=\{feedView\}/u);
  assert.match(source, /bind:following bind:newBelow/u);
  assert.match(source, /onseen=\{markSeen\} onolder=\{loadOlder\} onpath=\{routePathRef\}/u);
  assert.match(source, /const scrollFeed = \(force = false\) => feedView\?\.scrollToTail\(force\);/u);
  assert.match(source, /return feedView\.withReadingAnchor\(mutate\);/u);
  assert.match(source, /feedView\?\.resetForRoom\(\);/u);
  assert.match(source, /following = !jumpIntent;\n\s*if \(feed\.length && !jumpIntent\) scrollFeed\(true\);/u,
    'room entry keeps its original tail intent — unless a centre jump owns the landing (#322)');
  assert.match(source, /if \(filterAgent\) \{ filterAgent = ''; return true; \}/u);
  assert.doesNotMatch(source, /onclearfilter/u, 'the filter shows and leaves in the strip, not a feed banner (owner, 2026-09-23)');
  assert.match(source, /--msg-max: min\(84%, 1360px\);/u,
    'the parent width token still agrees with Feed measurement');
  assert.match(source, /\{#snippet emptyFeed\(\)\}[\s\S]*?addAgents\(\[r\.name\], '', 'start'\)[\s\S]*?\{\/snippet\}/u,
    'the empty preset retains its parent spawn authority');
  assert.match(source, /let feedActions = \$state\.raw\(null\);/u,
    'the registration object keeps its identity, not a deep-proxied copy');
  assert.match(source, /if \(feedActions === handlers\) feedActions = null;/u);
  assert.match(source, /registerActions=\{registerFeedActions\}/u);
  assert.doesNotMatch(source, /feedEl|function measureHeld|function syncAsk|renderMarkdown/u);
});

test('Hub dot sizing has one shared declaration without restyling embedded pages (#132)', async () => {
  const css = await readFile(new URL('./hub-atoms.css', import.meta.url), 'utf8');
  assert.match(source, /import '\.\/hub-atoms\.css';/u);
  assert.match(css, /\.hub-root :where\(\.ac-top, \.m-state, \.win-pill\) > \.st \{ width: 6px; height: 6px; border-radius: 50%; flex: none; transition: background var\(--t-fast\); \}/u,
    ':where adds no specificity; the two classes match the former scoped rule');
  assert.doesNotMatch(source, /^\s*\.st \{/mu, 'the former private definition is removed');
  assert.doesNotMatch(css, /live-dot|@keyframes/u, 'status motion stays in app.css');
  assert.match(css, /\.hub-root :where\(\.m-state\) > \.note-dot \{ border: 1px dashed var\(--text3\); background: none; \}/u,
    '#168 removes the recipient menu selector, retaining the receipt note mark');
  assert.doesNotMatch(source, /^\s*\.note-dot \{/mu);
  assert.match(css, /\.hub-root :where\(\.page-head, \.drawer-head\) > \.spacer \{ flex: 1; \}/u,
    'the Hub and drawer headers share the original filler without a copy (#136)');
  assert.match(css, /\.hub-root :where\(\.feed, \.term-body\) > \.empty \{ color: var\(--text3\); font-size: var\(--fs-ui\); text-align: center; margin: auto; padding: 0 24px; line-height: 1\.6; \}/u);
  assert.doesNotMatch(source, /^\s*\.(?:spacer|empty) \{/mu,
    'only the existing direct parents receive these shared rules');
});

test('an uncached room unfolds: skeletons while it loads, then the feed from its tail and the roster from the left (motion.md wave 8)', () => {
  // The skeletons stand in ONLY while the room is not ready (an uncached
  // room; a cached one is ready at once and stays a cut) and are aria-hidden.
  assert.match(source, /<Feed[\s\S]*?\{roomReady\} \{justLoaded\} \{openedAt\}/u,
    'Feed receives the original readiness and motion gates (#134)');
  assert.match(source, /<Roster[\s\S]*?\{roomReady\} \{justLoaded\} \{rosterBase\}/u, 'the roster receives the same readiness and reveal gates');
  // Only an UNCACHED load sets it, and a timer clears it: the atoms animate
  // whatever mounts while the class is on, and an older page must not.
  assert.match(source, /if \(!c\) unfold\(\);\s*\n\s*roomReady = true;/u, 'the unfold is the uncached first fill\u2019s');
  assert.match(source, /justLoadedTimer = setTimeout\(\(\) => \{ justLoaded = false; \}, revealMs\(\)\);/u, 'cleared after one move plus the longest stagger');
  assert.match(source, /clearTimeout\(justLoadedTimer\); justLoaded = false; \/\/ an unfold belongs to the room that loaded/u, 'a switch mid-unfold cancels it');
});

test('Hub hover surfaces keep the shared status vocabulary (board #87)', () => {
  // The tone of the state row is the SAME family the dot paints — no second
  // colour language (rule 6).
  assert.match(source, /function stateTone\(state\) \{\s*switch \(stateDotColor\(state\)\)/u, 'the hover tone derives from stateDotColor');
  assert.match(source, /\{stateLabel\} \{stateTone\} onselect=\{setRecipient\}/u,
    'Roster consumes the existing shared formatters');
  assert.match(source, /\{agents\} \{panes\} \{managedAgents\} \{winsExpanded\} \{stateLabel\} \{stateTone\}/u,
    'Drawer consumes the same formatters without copying them (#136)');
});

test('Hub keeps selection, Back and consequential actions around the extracted Sidebar (#121)', () => {
  const start = source.indexOf('<Sidebar ');
  const sidebar = source.slice(start, source.indexOf('/>', start));
  assert.match(sidebar, /open=\{sideOpen\}/u);
  assert.match(sidebar, /onselect=\{\(session\) => \{ selectProject\(session\); sideOpen = false; \}\}/u);
  assert.match(sidebar, /onmenu=\{\(row, at\) => openCtx\(at, row\.project\.name, projectItems\(row\)\)\}/u,
    'context actions use the clicked row, never selectedRow');
  assert.match(sidebar, /onrestore=\{restoreProject\} onpurge=\{\(row\) => \{ if \(!purging\) \{ purgeError = ''; trashAsk = row; \} \}\}/u,
    '#167: a pending purge cannot be retargeted and a new intent clears its own error');
  assert.match(sidebar, /oncreate=\{\(\) => \{ createOpen = true; sideOpen = false; \}\}/u);
  assert.match(sidebar, /onclose=\{\(\) => \{ sideOpen = false; \}\}/u);
  assert.match(source, /backLayers\.register\('sidebar', \(\) => \{ if \(compact && !sideOpen\)/u);
  assert.doesNotMatch(source, /<aside class="sidebar"|function rowInfo|let trashOpen/u,
    'the old view and private fold state have one new owner');
});

test('Hub owns one strip above Composer; ContextMenu replaces the delayed menu (#168)', () => {
  const start = source.indexOf('<Roster ');
  const roster = source.slice(start, source.indexOf('/>', start));
  assert.match(roster, /\{composerText\} \{managedNames\} \{busyNames\} \{interrupting\}/u);
  assert.match(roster, /onselect=\{setRecipient\} oninterrupt=\{interrupt\}/u);
  assert.match(roster, /oncontext=\{\(at, name, info\) => openCtx\(at, name, agentItems\(name\), info\)\}/u);
  assert.equal([...source.matchAll(/<Roster /g)].length, 1);
  assert.ok(source.indexOf('<Feed ') < start && start < source.indexOf('<Composer '));
  assert.doesNotMatch(source, /menuFor|cardsEl|agentMenu|function cardClick|function toggleAgentMenu|class="a-menu/u,
    'the 260ms menu and its capture-listener lifetime are removed whole');
});

test('card and keyboard interrupts snapshot the same busy membership without changing reading intent (#168)', () => {
  const body = source.slice(source.indexOf('async function interrupt'), source.indexOf('async function withReadingAnchor'));
  assert.match(body, /const targets = busyTargetsFor\(target, agents\);/u);
  assert.match(body, /const jobs = targets\.map\(\(name\) => \(\{ session, name \}\)\);/u);
  assert.match(body, /await hubAgentInterrupt\(job\.session, job\.name\)/u);
  assert.match(body, /pending !== job/u, 'settling an old job cannot clear a newer one');
  assert.doesNotMatch(body, /following =|scrollFeed|setRecipient|hubAgentStop|hubAgentRestart/u);
  assert.equal([...source.matchAll(/oninterrupt=\{interrupt\}/g)].length, 2);
  assert.doesNotMatch(source, /fireInterrupt/u);
});

test('Hub keeps Composer transport and capture listeners at the coordinator boundary (#133)', () => {
  assert.match(source, /<Composer bind:this=\{composer\} bind:composerText \{selected\} \{compact\} \{recipient\}/u);
  assert.match(source, /onsend=\{send\} onstage=\{stageFiles\} onremove=\{removeAttachment\}/u);
  assert.match(source, /onmodels=\{modelsList\} oninterrupt=\{interrupt\}/u);
  assert.match(source, /onheightchange=\{\(\) => \{ if \(following\) scrollFeed\(true\); \}\}/u);
  assert.doesNotMatch(source, /onfocus=/u, 'focusing the composer must not drag a reader to the tail (#303)');
  assert.match(source, /caret: \(\) => composer\?\.caret\(\),/u, 'tokens land at the composer caret');
  assert.match(source, /focus: \(\) => composer\?\.focus\(\),/u);
  assert.match(pipeline, /let at = host\.caret\?\.\(\) \?\? host\.getText\(\)\.length;/u);
  assert.match(pipeline, /host\.focus\?\.\(\);/u);
  assert.doesNotMatch(source, /recipientChanged|closeRecipient/u);
  assert.match(source, /hubPrefs\.setDraft\(selected, composerText\)/u);
  const drawer = source.indexOf("if (!termOpen || !visible) return;");
  const transients = source.indexOf("if (!feedActions?.isOpen() && !composer?.hasTransient() && !replyTo) return;");
  assert.ok(transients > 0, 'the dismissal effect also listens while a reply chip is up (#290)');
  assert.ok(drawer < transients, 'surviving capture effects keep their order after menu removal');
  assert.match(source, /feedActions\?\.outside\(e\);\s*composer\?\.dismissOutside\(e\);/u);
  assert.match(source, /feedActions\?\.escape\(e\);\s*composer\?\.dismissEscape\(e\);/u);
  assert.doesNotMatch(source, /let (recipientOpen|paletteOff|intArm|composerEl)|function growComposer/u);
});

test('Back keeps the original priority and current live guards in one dispatcher (#119/#167)', () => {
  const region = source.slice(source.indexOf('const backLayers ='), source.indexOf('function agentItems'));
  const guards = {
    lightbox: "if (shotView) { shotView = ''; return true; }",
    contextMenu: 'if (ctxAt) { closeCtx(); return true; }',
    action: 'if (!pendingAct) return false; if (!acting) pendingAct = null; return true;',
    trash: 'if (!trashAsk) return false; if (!purging) trashAsk = null; return true;',
    picker: 'if (pickerOpen) { pickerOpen = false; return true; }',
    // #317: the dialog peels its OWN steps first (folder picker, new-folder
    // field) through the one function its Escape also asks, so Back and
    // Escape cannot disagree about what a draft is.
    create: 'if (!createOpen) return false; if (!createEl?.goBack()) createOpen = false; return true;',
    rename: 'if (renaming) { renaming = false; return true; }',
    jumpFilter: 'if (filterBefore) { restoreFilter(); return true; }',
    filter: "if (filterAgent) { filterAgent = ''; return true; }",
    reply: 'if (replyTo) { replyTo = null; return true; }',
    files: "if (termOpen && drawerView === 'files' && drawerFilesBack?.()) return true;",
    drawer: 'if (termOpen) { closeDrawer(); return true; }',
    sidebar: 'if (compact && !sideOpen) { sideOpen = true; return true; }',
  };
  for (const [layer, guard] of Object.entries(guards)) {
    // #167 deliberately replaces the busy fallthrough while keeping priority.
    const suffix = layer === 'action' || layer === 'trash' || layer === 'create' ? '' : ' return false;';
    assert.ok(region.includes(`backLayers.register('${layer}', () => { ${guard}${suffix} })`),
      `${layer} keeps its current guard/action inside a live callback`);
  }
  assert.equal([...region.matchAll(/backLayers\.register\(/g)].length, 13, 'the reply chip (#290) peels after the filter; a jump\'s cleared filter (#322) comes back first');
  assert.match(source, /registerBack=\{onGoBack \? backLayers\.register : null\}/u,
    'Composer registers its remaining palette slot with the same registry');
  assert.match(region, /onGoBack\(backLayers\.back\);/u);
  assert.match(region, /return \(\) => \{ for \(const dispose of disposers\) dispose\(\); \};/u);
  assert.doesNotMatch(region, /onGoBack\(\(\) =>|addEventListener|popstate|pushState/u,
    'the old dispatch chain and event routing do not coexist with the registry');
});

test('selecting an agent retargets an OPEN terminal partition (board #91)', () => {
  // Choosing who you talk to is also choosing whose pane you are watching:
  // when the drawer's terminal partition is open, clicking an agent card (and
  // every other setRecipient path — "talk to", restart)
  // switches the embedded terminal to that agent's window. The lookup is by
  // roster name, so @all and the room (which match no agent) naturally skip;
  // a CLOSED drawer must not spring open — this follows, it never opens.
  const body = source.slice(source.indexOf('function setRecipient'), source.indexOf('async function interrupt'));
  assert.match(body, /if \(termOpen && drawerView === 'term'\) \{\s*\n\s*const a = agents\.find\(\(x\) => x\.name === name\);\s*\n\s*if \(a\) pickWindow\(a\);/u,
    'an open terminal partition follows the new recipient');
  assert.ok(!body.includes('termOpen = true'), 'following never opens a closed drawer');
});

test('the filter and the detail level are reachable from menus, not only from a gesture and Settings', () => {
  // Review, 2026-09-03: filtering by agent existed only as an undocumented
  // double-click; the detail level only in Settings (cycleFeedLevel was dead).
  // #168 keeps the filter in the single right-click/long-press ContextMenu
  // after deleting the tap-menu and double-click paths. The project title's
  // menu still carries the three detail levels with the current one ticked.
  const items = source.slice(source.indexOf('function agentItems'), source.indexOf('function projectItems'));
  assert.equal([...items.matchAll(/filterItem\(name\)/g)].length, 2, 'live AND stopped agents get the filter verb');
  assert.match(source, /icon: 'filter',\s*onselect: \(\) => toggleFilter\(name\)/u, 'one funnel for the filter verb — the menu row and the card mark share it');
  assert.match(source, /function toggleFilter\(name\) \{\s*filterAgent = filterAgent === name \? '' : name;/u,
    '#168 ContextMenu retains the toggle without selecting or opening a second menu');
  assert.match(source, /projectItems\(selectedRow, true\)/u, 'the title caret asks for the view rows');
  const lv = source.slice(source.indexOf('function feedLevelItems'), source.indexOf('// The same dismissal'));
  assert.match(lv, /hubPrefs\.feedLevel === level \? 'check' : 'circle'/u, 'radio semantics through the menu\u2019s own icons');
  assert.match(lv, /hubPrefs\.setFeedLevel\(level\)/u, 'and it writes the one pref Settings reads');
  assert.ok(!source.includes('cycleFeedLevel'), 'the dead cycle control stays gone');
  // Board #289: "Only mine" sits beside the detail levels and is the SAME
  // filter state, so it and an agent filter exclude each other and Back
  // clears it; the roster never shows it as an agent's filter mark.
  assert.match(source, /\.\.\.\(withView \? \[\.\.\.feedLevelItems\(\), onlyMineItem\(\)\] : \[\]\)/u);
  assert.match(source, /label: t\('hubOnlyMine'\), icon: filterAgent === HUMAN \? 'check' : 'circle', onselect: \(\) => toggleFilter\(HUMAN\)/u);
  assert.match(source, /if \(filterAgent && filterAgent !== HUMAN && !managedAgents\.some/u, 'the human is not an agent that can leave the room');
  assert.match(source, /filterAgent=\{filterAgent === HUMAN \? '' : filterAgent\}/u, 'no agent card wears the Only-mine mark');
  assert.match(source, /backLayers\.register\('filter', \(\) => \{ if \(filterAgent\) \{ filterAgent = ''; return true; \}/u, 'Back peels it like any filter');
});

test('agent restart remains one parent action for roster and context menu (board #89)', async () => {
  const items = source.slice(source.indexOf('function agentItems'), source.indexOf('function projectItems'));
  assert.match(items, /label: t\('hubRestart'\), icon: 'refresh', onselect: \(\) => restartAgent\(name\)/u,
    'right-click and long-press keep the same restart action');
  assert.match(items, /onselect: \(\) => startAgent\(name\)/u);

  const action = source.slice(source.indexOf('async function restartAgent'), source.indexOf('// Live pushes'));
  assert.match(action, /await hubAgentRestart\(selected, name\)/u, 'Restart calls the existing lifecycle RPC');
  assert.match(action, /Promise\.all\(\[reload\(\), loadAgents\(\), loadFeed\(\)\]\)/u,
    'the roster and lifecycle line refresh after restart');

  const i18n = await readFile(new URL('../core/i18n.svelte.ts', import.meta.url), 'utf8');
  assert.match(i18n, /hubRestart: 'Restart'/u);
  assert.match(i18n, /hubRestart: '重启'/u);
});

test('sidebar dots and roster cards drink from ONE state map (board #8)', () => {
  // Both pollers route through mergeStates: the roster poll overlays its
  // project's keys onto the shared map, and the rooms poll overlays the
  // CURRENT roster onto its fresh snapshot before adopting it — whichever
  // response lands last, the freshest source drives the selected project.
  assert.match(source, /agentStates = mergeStates\(agentStates, s, got\);/u,
    'the 5s roster poll refreshes the shared dot map');
  assert.match(source, /agentStates = mergeStates\(roomsRes\.states \?\? \{\}, selected, agents\);/u,
    'the 20s snapshot is overlaid with the roster before it is adopted');
  assert.ok(!/agentStates = roomsRes\.states/u.test(source),
    'the raw snapshot is never adopted bare — that is the rollback bug');
});

test('the Manager flag is gone from the UI (owner, 2026-09-26)', async () => {
  // Hiring is an ability every agent has through `tmm`; a per-definition grant
  // added no authority ("本身就是 agent 自己能够通过命令行获得的能力").
  const agentsPage = await readFile(new URL('./AgentsPage.svelte', import.meta.url), 'utf8');
  const i18n = await readFile(new URL('../core/i18n.svelte.ts', import.meta.url), 'utf8');
  for (const [name, src] of [['Hub', source], ['AgentsPage', agentsPage]] as const) {
    assert.ok(!src.includes('can_hire') && !src.includes('m-badge'), `${name} carries neither the field nor the badge`);
  }
  assert.ok(!i18n.includes('agentsManager') && !i18n.includes('teamManager'), 'the Manager strings are retired');
});

test('history paging: anchored prepend, guarded rooms, parked cursors (board #9)', () => {
  // The prepend re-enters through the reading anchor — scrollTop compensation
  // is off (overflow-anchor: none), so without this every older page teleports
  // the reader.
  const walk = /async function loadOlder\(\) \{[\s\S]*?\n  \}/u.exec(source)?.[0] ?? '';
  assert.match(walk, /if \(selected !== s \|\| readGen !== g\) return;/u, 'a room switch, a jump or a return drops the in-flight page (#322 reading generation)');
  assert.match(walk, /await withReadingAnchor\(\(\) => \{/u,
    'the anchored prepend is AWAITED — releasing loadingOlder before the scroll compensation re-walked the same cursor');
  assert.match(walk, /if \(loadingOlder \|\| !selected \|\| \(!histMore && !actMore\)\) return;/u,
    'one walk at a time, parked at has_more=false');
  // Cursors ride the room cache, so returning to a room never re-walks it.
  assert.match(source, /roomCache\.set\(selected, \{ feed, lastTs, activity, lastActivityTs, agents, histSeq, histMore, actCursor, actMore \}\);/u,
    'both cursors and both has_more flags are parked per room');
  // The activity poll merges — the old concat-and-slice(-300) EVICTED walked
  // history, and a bare concat doubles what a page overlap re-sends.
  assert.match(source, /activity = mergeEvents\(activity, events\);/u, 'poll path merges');
  assert.ok(!source.includes('.slice(-300)'), 'the eviction cap is gone');
  assert.match(source, /onolder=\{loadOlder\}/u, 'both view entry points use this one walk');
});

test('the gap walk keeps captured inputs and validates its added return boundary (#118)', () => {
  const poll = source.slice(source.indexOf('async function loadFeed('), source.indexOf('async function loadActivity('));
  assert.match(source, /import \{ walkFeedGap \} from '\.\/hub-history\.ts';/u);
  assert.match(poll, /const floorTs = lastTs;/u, 'the floor is captured before the initial poll');
  assert.match(poll, /else if \(res\.has_more && \(res\.oldest_seq \?\? 0\) > 0\)/u,
    'first-page paging remains separate from the incremental gap');
  assert.match(poll, /await walkFeedGap\(\{ session: s, floorTs, cursor: res\.oldest_seq \},/u);
  assert.match(poll, /readPage: \(session, cursor\) => hubLog\(session, 0, 100, cursor\)/u,
    'the existing RPC page size and before_seq arguments remain in Hub');
  assert.match(poll, /stillCurrent: \(session\) => selected === session && ours\(\)/u);
  assert.match(poll, /mergePage: \(newer\) => \{ if \(ours\(\)\) feed = mergeMessages\(feed, newer\); \}/u,
    'each page merges into the live feed through the existing id dedupe — while the reading is still ours (#322)');
  assert.match(poll, /const ours = \(\) => selected === s && readGen === g && !windowed;/u);
  const awaited = poll.indexOf('const walked = await walkFeedGap');
  const guard = poll.indexOf('if (!walked || !ours()) return;');
  const batch = poll.indexOf('if (messages?.length) {');
  assert.ok(awaited >= 0 && guard > awaited && batch > guard,
    'a stale walk or room change during the new return await prevents batch adoption');
  assert.doesNotMatch(poll, /gapWalkStep|for \(let i = 0; i < 50/u, 'no second gap loop survives in the coordinator');
});

test('the drawer opens and closes through the reading anchor, everywhere', () => {
  // The drawer regrids the columns and every message rewraps; without the anchor
  // the reader's message drifts (owner, 2026-08-20). One open path and one close
  // path, both wrapped — a bare `termOpen = true/false` outside selectProject is
  // a trigger someone forgot to route.
  const bare = [...source.matchAll(/termOpen = (?:true|false)/g)].length;
  assert.equal(bare, 2, 'exactly the two wrapped mutations; selectProject restores via termOpen = !!dv');
  assert.match(source, /withReadingAnchor\(\(\) => \{ termOpen = true; \}\)/u);
  assert.match(source, /withReadingAnchor\(\(\) => \{ termOpen = false; \}\)/u);
  assert.match(source, /return feedView\.withReadingAnchor\(mutate\);/u,
    'Feed owns the actual reference and scroll writes (#134)');
});

test('an Esc typed into the drawer terminal reaches the pane, not closeDrawer', () => {
  // Escape is how every agent TUI cancels the turn it is running. The drawer's
  // window-capture listener used to eat it unconditionally — pressing Esc in
  // the focused terminal closed the drawer instead of reaching the agent
  // (owner, 2026-08-26). Two guards, both load-bearing:
  // an event from inside the terminal is the pane's,
  assert.match(source, /e\.target\?\.closest\?\.\('\.xterm'\)/u, 'focused-terminal Esc must pass through');
  assert.match(source, /e\.target\?\.closest\?\.\('\[role="menu"\]'\)/u,
    '#164: focused app menus own Escape even outside the drawer input territory');
  // and a HIDDEN Hub (pages stay mounted) must not steal the Terminal page's Esc.
  assert.match(source, /if \(!termOpen \|\| !visible\) return;/u, 'the listener is gated on visible');
});

test('the add-agent button is reachable in every project', () => {
  // Two gates hid the ONE entry point to an empty room, and each hid it in a
  // different situation: a non-empty-roster gate lost it with the last agent, and
  // a live-session gate still hid it on a CLOSED project (owner, 2026-08-24,
  // twice — "test 这个 project"). So the row hangs off the SELECTION and the
  // button off nothing: `projects::spawn` calls `tmux::ensure_session`, so a
  // spawn into a project that is down opens it.
  assert.match(source, /<Roster \{selected\} \{compact\}/u, 'the child owns its selected gate');
  assert.match(source, /onadd=\{\(\) => openPicker\('add'\)\}/u);
  assert.doesNotMatch(source, /\{#if liveSelected\}/u, 'no live gate stands between a project and its first agent');
  // The empty-room preset panel is the same entry point in another shape: it
  // must not disagree with the button about when adding an agent is possible.
  assert.match(source, /\{#if selected && !managedAgents\.length && registry\.length\}/u);
});

test('a confirmed project verb runs on the row it was asked on, never on `selected`', () => {
  // The context menu opens on ANY sidebar row; the confirm dialog then fired
  // `rows.find(… === selected)`, closing whichever project was OPEN instead of
  // the one long-pressed (owner, 2026-08-24: "关的不是我选中的 是其他的").
  // #167 freezes the project ID as well: a later poll cannot redirect the
  // mutation or its partial close/archive retry.
  assert.match(source, /askAction = \(kind, name, session = selected, where = null\)/u);
  const ask = source.slice(source.indexOf('const askAction'), source.indexOf('async function refreshActionView'));
  assert.match(ask, /const row = where \?\? rows\.find\(r => r\.project\.session === session\)/u);
  assert.match(ask, /projectId: row\?\.project\.id/u);
  const run = source.slice(source.indexOf('async function runAction'), source.indexOf('function restoreProject'));
  assert.match(run, /const down = act\.api \? act\.api\.projectDown : projectDown;\s*const archive = act\.api \? act\.api\.projectArchive : projectArchive;/u,
    'the verb runs on the api frozen at the ask — this Hub s, or the union row s SOURCE (#335 ③c, reviewer P1-C1)');
  assert.match(run, /await down\(projectId\)/u);
  assert.match(run, /await archive\(projectId, true\)/u);
  assert.doesNotMatch(run, /rows\.find|projectDelete/u, 'never re-resolved, never the irreversible purge');
  // The context menu's two destructive verbs both pass their row's identity.
  assert.match(source, /askAction\('down', name, session\)/u);
  assert.match(source, /askAction\('delete', name, session\)/u);
  // A union row's (another server's) verbs go through the SAME ask, with its
  // source frozen; the menu never calls an api itself (P1-C1).
  const foreign = source.slice(source.indexOf('function entryItems'), source.indexOf('async function bringUpRow'));
  assert.match(foreign, /askAction\('down', row\.project\.name, row\.project\.session, where\)/u);
  assert.match(foreign, /askAction\('delete', row\.project\.name, row\.project\.session, where\)/u);
  assert.doesNotMatch(foreign, /api\.project(?:Down|Delete|Archive)\(/u, 'no second action path beside the confirmed one');
  // The async flavor of the same bug: a poller's late reply must still be
  // about the project it asked about, or a project switch mid-flight merges
  // the OLD room's data into the NEW one. Each poller freezes `selected` and
  // drops a stale answer.
  const pollers = ['async function loadFeed', 'async function loadActivity', 'async function loadAgents'];
  for (const head of pollers) {
    const at = source.indexOf(head);
    assert.ok(at >= 0, `${head} exists`);
    const body = source.slice(at, at + 1200);
    assert.match(body, /const s = selected;/u, `${head} freezes its project`);
    assert.match(body, /if \(selected !== s\) return;/u, `${head} drops a stale answer`);
  }
});

test('the drawer has a board partition, and the tap prefers it on desktop (board #13)', () => {
  // The task sidebar: the REAL Board component, embedded, following the room's
  // project — the same split the files partition makes (page on the phone,
  // partition on desktop).
  assert.match(source, /\{drawerView\} \{drawerFilesReq\} \{drawerIssueReq\} \{drawerBoardNew\}/u,
    'the view receives the existing partition requests');
  assert.match(source, /drawerView = 'board'; openDrawer\(\);/u, 'the feed tap opens the partition on desktop');
  assert.match(source, /if \(mobile \|\| compact\) \{ openBoardTab\?\.\(selected, id\); return; \}/u,
    'the phone still jumps to the board page');
  assert.match(source, /e\.target\?\.closest\?\.\('\.board-body'\)/u,
    'an Esc inside the partition belongs to the Board (the files-body territory rule)');
});

test('the header toggles read board, files, terminal — the owner-set order (2026-08-29)', () => {
  const start = source.indexOf('<!-- The task board:');
  const bar = source.slice(start, source.indexOf('{#if selected}', start));
  // #166 changes only the renderer: the same order uses shared commands.
  const iBoard = bar.indexOf('icon="layout"');
  const iFiles = bar.indexOf('icon="files"');
  const iTerm = bar.indexOf('icon="terminal"');
  assert.ok(iBoard >= 0 && iFiles > iBoard && iTerm > iFiles, 'board, then files, then terminal');
});

test('the header folds the project verbs into ONE dots menu (owner, 2026-08-29)', () => {
  // Rename/Open/Close/Delete live behind the same projectItems menu the
  // sidebar row speaks — one source of truth; the partition toggles stay out
  // (navigation, not consequence).
  // `true` = plus the feed's detail-level rows (review, 2026-09-03) — the same
  // shared list, one flag, not a second menu.
  assert.match(source, /projectItems\(selectedRow, true\)\);/u, 'the dots button opens the shared menu');
  // The ⋯/name grouping is pinned by its own test below ("grouped WITH the
  // name") — the title-group holds them at a 3px gap, sibling of the h1.
  const head = source.slice(source.indexOf('class="h1-text"'), source.indexOf('{#if selected}', source.indexOf('class="h1-text"')));
  assert.ok(!head.includes('h1-pen'), 'the title pencil retired — rename lives in the menu');
  const bar = source.slice(source.indexOf('<span class="spacer"></span>'), source.indexOf('<!-- The task board:'));
  assert.ok(!bar.includes("name=\"trash\"") && !bar.includes("name=\"stop\"") && !bar.includes("name=\"zap\""),
    'no standalone delete/close/open buttons in the header');
  assert.ok(!bar.includes('name="dots"'), 'the ⋯ moved BESIDE the name (owner, 2026-08-30) — not in the right-aligned group');
});

test('the ⋯ is grouped WITH the name, so the row gap cannot separate them (owner, 2026-08-30)', () => {
  // "离 project name 还是有点远，可以直接紧挨着 name，让人觉得是可以点击操作的".
  // Being the next child of .page-head was not enough: the header's own gap
  // (10px, 7px compact) sat between them, and on ≤760px the shared
  // `.page-head h1 { flex: 1 1 auto }` stretched the title across the row and
  // parked the ⋯ at the far right. One content-sized group fixes both without
  // touching the shared rule.
  const group = source.slice(source.indexOf('<div class="title-group">'), source.indexOf('<!-- The FULL path'));
  assert.ok(group.length > 0, 'the title group must exist');
  assert.ok(group.includes('class="h1-text"'), 'the name lives in the group');
  assert.ok(group.includes('class="h1-edit"'), 'so does the rename input — the ⋯ must not jump when renaming starts');
  assert.ok(group.includes('icon="chevron-down"'), 'and so does its caret — the dropdown grammar (owner, 2026-08-30: "向下的直角箭头…像把这个名字展开")');
  assert.match(source, /\.title-group \{[^}]*gap: 1px[^}]*\}/u, 'a tight, deliberate gap — not the row rhythm');
  // The NAME wins the width fight against the PATH (owner, 2026-08-30: "名字
  // 还是优先要显示全的") but never against the BUTTONS (owner, 2026-09-02,
  // board #72: a long name on a phone pushed the icon buttons off-screen while
  // the group was `flex: none`). So: the group shrinks at weight 1 with
  // min-width 0 (the ellipsis can engage), the path at weight 1000 (it yields
  // first, and scrolls), the buttons are flex: none.
  assert.match(source, /\.title-group \{[^}]*flex: 0 1 auto; min-width: 0;[^}]*\}/u, 'the name group CAN shrink — buttons come first');
  assert.ok(!/\.title-group \{[^}]*flex: none/u.test(source), 'flex: none is what hid the buttons');
  // #234: no width cap on the name — the old 60% cap ellipsized the title
  // while the path still held width, inverting the stated priority. The
  // path's floor is what keeps it visible AND scrollable when compressed.
  assert.ok(!/\.title-group \{[^}]*max-width/u.test(source), 'a cap on the name inverts the name-over-path priority');
  assert.match(source, /\.path \{[\s\S]{0,900}?min-width: 8ch; flex: 0 1000 auto;/u,
    'the path gives way first — a 1000× shrink weight down to a scrollable floor');
  // The heading must not clip the command's native target or focus ring.
  const h1 = source.slice(source.indexOf('<h1>', source.indexOf('<div class="title-group">')), source.indexOf('</h1>'));
  assert.ok(!h1.includes('icon="chevron-down"'), 'the caret sits beside the h1, never inside it');
});

test('the Chat header path is selectable prose and a double-click copies the full value (board #88)', () => {
  const headPath = source.slice(source.indexOf('<!-- The FULL path'), source.indexOf('<span class="spacer"></span>'));
  assert.match(source, /import \{ copyText \} from '\.\.\/core\/clipboard\.ts';/u,
    'the shared clipboard helper keeps HTTP and WebView fallback behavior');
  assert.match(headPath, /<span class="path" use:wheelX use:doubleClickCopy=\{selectedRow\?\.project\.path \?\? ''\}/u,
    'the visible full path owns the double-click copy action');
  const action = source.slice(source.indexOf('function doubleClickCopy'), source.indexOf('</script>'));
  assert.match(action, /el\.addEventListener\('dblclick', onDoubleClick\)/u, 'double-click is attached without turning prose into a button');
  assert.match(action, /void copyText\(value\)/u, 'the exact untruncated project path is copied');
  assert.match(action, /kind: ok \? 'success' : 'error'/u, '#167 never claims Copied on a failed write');
  assert.match(source, /use:feedbackPosition=\{\{ trigger: headerCopyAnchor,/u);
  const css = rule('.path');
  assert.match(css, /user-select:\s*text/u, 'mouse drag selection explicitly overrides the app shell');
  assert.match(css, /-webkit-user-select:\s*text/u, 'WebKit selection is explicit too');
  assert.match(css, /cursor:\s*text/u, 'the cursor advertises selectable prose');
});

test('the drawer follows the project — partition parked and restored per room (board #23)', () => {
  // Owner: "chat的右侧边栏打开哪个的状态前端帮我记住，这样我切换不同的
  // project 回来原来的视图还在". ONE record point per direction — openDrawer
  // (every view switch routes through it) and closeDrawer (the one close
  // path) — and ONE restore point in selectProject. A second write site for
  // the same pref is how two sources of truth drift.
  assert.match(source, /withReadingAnchor\(\(\) => \{ termOpen = true; \}\);\n(?:\s*\/\/[^\n]*\n)*\s*hubPrefs\.setDrawer\(selected, drawerView\);/u,
    'opening records which partition this room shows');
  assert.match(source, /withReadingAnchor\(\(\) => \{ termOpen = false; \}\);\n\s*hubPrefs\.setDrawer\(selected, ''\);/u,
    'closing records closed');
  assert.equal([...source.matchAll(/hubPrefs\.setDrawer\(/g)].length, 2,
    'exactly the two record points');
  // Restore: compact has no drawer, an unknown room comes back closed, and
  // the old room's pane target never leaks into the new room's terminal.
  assert.match(source, /const dv = compact \? '' : hubPrefs\.drawer\(session\);/u);
  assert.match(source, /termOpen = !!dv;/u);
  assert.match(source, /termTarget = ''; winsExpanded = false;/u, 'stale pane target cleared on switch');
});

test('a stage job dies with its room, and nothing sends while one is in flight (board #25 review)', () => {
  // Lead review of 898d888, race (1): stageFiles is async — a project switch
  // mid-upload used to let the finished job refill the NEW room's composer
  // with the OLD room's attachment. clearAttachments (which selectProject
  // calls) bumps the generation; the job snapshots it at entry and re-checks
  // after EVERY await; the commit (pending, token, sequence) sits after the
  // last check with no await in between.
  assert.match(source, /const clearAttachments = \(\) => stager\.clear\(\);/u, 'the switch clears through the stager');
  assert.match(pipeline, /clear\(\) \{\n\s*attachGen\+\+;/u,
    'clear/switch invalidates every in-flight stage job');
  const stage = /async stage\(files: File\[\]\) \{([\s\S]*?)\n    \},/u.exec(pipeline)?.[1] ?? '';
  assert.ok(stage, 'stageFiles found');
  assert.match(stage, /const gen = attachGen;/u, 'the job snapshots its generation at entry');
  const code = stage.replace(/\/\/[^\n]*/g, ''); // comments SAY "await" too
  const awaits = [...code.matchAll(/await /g)].length;
  const checks = [...code.matchAll(/if \(stale\(\)\) return;/g)].length;
  assert.ok(awaits >= 6, `stageFiles has its awaits (saw ${awaits})`);
  assert.equal(checks, awaits, 'one staleness check per await — a new await without one is the race back');
  assert.ok(stage.lastIndexOf('if (stale()) return;') < stage.indexOf('pending = [...pending, item]'),
    'the commit mutates only after the final check');
  // Race (2): with text already typed, sendable stayed true while a job was
  // in flight — the message could leave without its attachment, which then
  // landed in an emptied composer as an orphaned token. Both gates, so the
  // keyboard's Enter (send() entry) and the pointer (disabled) agree; while
  // attaching the button is disabled OUTRIGHT, so an empty composer cannot
  // turn into a clickable interrupt mid-upload.
  const sendFn = /async function send\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.ok(sendFn, 'send found');
  assert.match(sendFn, /if \(attaching\) return;/u, 'send() refuses while a stage job is in flight');
  assert.match(source, /\{pending\} \{attaching\} \{failed\} \{sendable\}/u,
    'the view receives the same gate verdicts; its button contract lives in Composer.source');
  // The gate answers PER GENERATION, and every job books/releases only its
  // OWN entry: a stale job neither holds the new room's send closed nor —
  // via its finally — unlocks a job the new room started. A count or a flag
  // fails one side or the other (a blanket reset in clearAttachments would
  // let the old finally push it negative and free a running new job).
  assert.match(pipeline, /get attaching\(\) \{ return jobGens\.includes\(attachGen\); \}/u,
    'attaching asks whether the CURRENT generation has jobs');
  assert.match(source, /const attaching = \$derived\(stager\.attaching\);/u);
  assert.match(stage, /jobGens = \[\.\.\.jobGens, gen\];/u, 'a job books itself under its own generation');
  const fin = /finally \{([\s\S]*?)\n      \}/u.exec(stage)?.[1] ?? '';
  assert.match(fin, /jobGens\.indexOf\(gen\)/u, 'finally releases exactly its own entry');
  assert.ok(!/jobGens = \[\]/u.test(pipeline), 'nothing blanket-resets the job list');
  // Same genre on the way out (round 2): the SUCCESS path after `await
  // hubPost` used to reset attachSeq and refresh the feed unconditionally —
  // a room switched to mid-post that had staged its own attachments got its
  // token numbering reset (colliding numbers) and the wrong feed refreshed.
  // The post goes to the CAPTURED room; per-room state mutates only if the
  // user is still there; and a failed post must not restore the old room's
  // draft/attachments into the new one.
  assert.match(sendFn, /await hubPost\(room, text, 'human', re\);/u, 'the post names its room, not whatever is on screen');
  assert.equal([...sendFn.matchAll(/if \(selected !== room\) return;/g)].length, 2,
    'BOTH branches (command, message) stop their success path at the room boundary');
  const postIdx = sendFn.indexOf("await hubPost(room, text, 'human', re);");
  const guardIdx = sendFn.indexOf('if (selected !== room) return;', postIdx);
  const seqIdx = sendFn.indexOf('stager.resetSeq();');
  assert.ok(guardIdx > postIdx && seqIdx > guardIdx,
    'the message-path guard sits BETWEEN the post and the per-room mutations (attachSeq/loadFeed/scroll)');
  assert.match(sendFn, /if \(selected === room\) \{ stager\.pending = atts; composerText = raw; if \(re && !replyTo\) replyTo = quoteBack; \}/u,
    'a failed post restores only into its own room');
  // The slash-command branch is the same function, same race, same rule.
  assert.match(sendFn, /await hubCommand\(room, cmdTarget, cmd\.command\);/u);
  assert.match(sendFn, /if \(selected === room\) \{\s*composerText = raw;\s*commandFeedbackLifetime\.update\(feedbackToken, \{/u,
    'a failed command restores text and shows feedback only in its original room');
});

test('a failed attachment is a chip that blocks send, never a console line', () => {
  // Review, 2026-09-03: an oversized file or a failed upload only
  // console.warned, so the user could not tell what the message would carry.
  const stage = /async stage\(files: File\[\]\) \{([\s\S]*?)\n    \},/u.exec(pipeline)?.[1] ?? '';
  assert.ok(stage, 'stage found');
  assert.ok(!/console\.warn/u.test(stage), 'staging reports to the user, not to the console');
  assert.ok([...stage.matchAll(/failedAttachment\(/g)].length >= 3, 'too large, a per-file throw and a dir failure each become a chip');
  assert.match(stage, /try \{[\s\S]*?\} catch \(err\) \{[\s\S]*?if \(!stale\(\)\) pending = \[\.\.\.pending, failedAttachment/u,
    'the per-file catch guards staleness before it touches the room');
  const sendFn = /async function send\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(sendFn, /if \(failed\) return;/u, 'send() refuses while a failed chip stands');
  assert.match(pipeline, /sendable\(text: string\) \{ return !!text\.trim\(\) \|\| pending\.some\(\(a\) => !a\.error\); \}/u,
    'a failed chip alone is not content');
  assert.match(source, /const sendable = \$derived\(stager\.sendable\(composerText\)\);/u);
});

test('composer calculations use the pure helpers without moving send or its gates (#117)', () => {
  assert.match(source, /import \{ ALL_TARGET, attachmentBody, busyTargetsFor, targetMembers, targetTeam, teamTarget \} from '\.\/hub-composer\.ts';/u);
  const send = /async function send\(\) \{[\s\S]*?\n  \}/u.exec(source)?.[0] ?? '';
  const interpolation = send.indexOf('const body = attachmentBody(raw, atts);');
  assert.ok(interpolation > send.indexOf('if (attaching) return;'));
  assert.ok(interpolation > send.indexOf('if (failed) return;'));
  assert.match(send, /const body = attachmentBody\(raw, atts\);\s*const text = team \? addressedTeam\(body, members\) : addressed\(body, recipient\);/u,
    'the same attachment body is addressed to the selected snapshot; team expands to exact members');
  assert.match(send, /Promise\.allSettled\(members\.map\(\(name\) => hubCommand\(room, name, cmd\.command\)\)\)/u,
    'a team slash command is the native per-agent command path, not a new server target');
  assert.match(send, /if \(team && !members\.length\) \{\s*setRecipient\(''\);\s*if \(!cmd\?\.to && !mentionedAgents\(raw, targetMembers\(ALL_TARGET, agents\)\)\.length\) return;/u,
    'a vanished team stops implicit delivery but an explicit @name still wins');
  assert.match(pipeline, /const tok = attachToken\(a\);/u, 'removal uses the shared spelling');
  assert.match(pipeline, /const tok = attachToken\(item\);/u, 'staging uses that same spelling');
});

test('command failures use the shared anchored feedback surface (#239 review)', () => {
  assert.match(source, /const commandFeedbackLifetime = createFeedbackLifetime\(value => \{ commandFeedback = value; \}\);/u);
  assert.match(source, /onDestroy\(\(\) => commandFeedbackLifetime\.dispose\(\)\);/u);
  assert.match(source, /const failedNames = members\.filter\(\(_name, i\) => results\[i\]\.status === 'rejected'\)/u);
  assert.match(source, /hubCommandFailedFor'\)\.replace\('\{command\}', commandName\)\.replace\('\{names\}', failedNames\.join\(', '\)\)/u);
  assert.match(source, /if \(selected === room\) \{\s*composerText = raw;\s*commandFeedbackLifetime\.update\(feedbackToken, \{/u);
  assert.match(source, /<div class="composer-feedback pop-layer" use:feedbackPosition=/u);
  assert.match(source, /<OperationFeedback value=\{commandFeedback\} ondismiss=\{commandFeedbackLifetime\.clear\} \/>/u);
  assert.doesNotMatch(source, /class="command-error"|class="config-error composer-error"/u, 'no second error species');
});

test('the title caret expands the NAME — left-aligned on its real rect (board #32)', () => {
  // The project-actions menu used to right-align on the caret and could clip
  // at the right edge. It now anchors on the name element's REAL rect
  // (anchorOf → zoom-corrected) with the left alignment, so the menu's left
  // edge sits where the visible name starts; while renaming (the span is an
  // input) the caret itself anchors.
  assert.match(source, /<span class="h1-text" bind:this=\{titleNameEl\}>/u, 'the name span is the anchor');
  assert.match(source, /openCtx\(\{ anchor: anchorOf\(titleNameEl \?\? e\.currentTarget\), align: 'left' \}/u,
    'the title entry alone chooses the left alignment');
  // Every OTHER opener relies on ContextMenu's anchor-kind defaults: the six
  // pointer entries (right-click / long-press) land TOP-LEFT at the click
  // (owner, 2026-09-07, pinned in ui/popover.source.test.ts) and the card
  // caret's trigger rect keeps the right-aligned dialect. Exactly one opener
  // explicitly asks for left alignment.
  const opens = [...source.matchAll(/openCtx\((?!at, who)/g)].length; // call sites, not the definition
  const leftAligned = [...source.matchAll(/openCtx\(\{ anchor:[^}]*align: 'left'/g)].length;
  assert.equal(leftAligned, 1, 'ONE explicitly left-aligned entry');
  assert.equal(opens - leftAligned, 5, '#180 the captured All trigger, #258 the team menu, beside Sidebar (own row, and a union entry s row — #335 ③c-2) and Roster context entries');
  assert.ok(!/getBoundingClientRect\(\)[^]{0,80}openCtx/u.test(source),
    'no raw client rect reaches openCtx — anchorOf owns the zoom correction');
  // #166 replaces the 20px private caret with the shared command's centered
  // glyph and real 28/44px target; the original name anchor stays unchanged.
  assert.match(source, /<CommandButton variant="icon" icon="chevron-down" label=\{t\('hubProjectMenu'\)\} hasPopup="menu"/u);
  assert.doesNotMatch(source, /\.title-caret \{/u);
});

test('a path reference in a bubble opens the file preview, not the void (board #99)', async () => {
  const source = await readFile(new URL('./Hub.svelte', import.meta.url), 'utf8');
  // The bubble's click handler routes an anchor whose href is a PATH through
  // openPathRef; real URLs keep the browser's own behaviour.
  assert.match(source, /onpath=\{routePathRef\}/u, 'Feed delegates the decoded path into the original room router');
  // Desktop: the RIGHT DRAWER's embedded Files gets an imperative file request
  // (the drawerIssueReq pattern); compact jumps to the Files PAGE like every
  // other drawer feature does.
  assert.match(source, /drawerFilesReq = \{ file, n: \(drawerFilesReq\?\.n \?\? 0\) \+ 1 \}/u,
    'the drawer request carries the file and a bumped n');
  assert.match(source, /drawerView = 'files'; openDrawer\(\);/u, 'and the files drawer opens');
  assert.match(source, /openFilesTab\?\.\(target, [^)]*file[^)]*\)/u, 'compact hands off using the project captured at the click');
  assert.match(source, /\{drawerFilesReq\}/u, 'the drawer view receives the original file request');
  // A relative path resolves against the project's cwd before it travels.
  assert.match(source, /fsCwd\(/u, 'relative refs resolve against the project cwd');
});

test('the drawer REVEALS, it never resizes: pinned content, one moving gate, no transition on an xterm ancestor (board #174)', () => {
  // Owner, 2026-09-11: "右侧边栏 … 点击展开最好也是有动画展开". motion.md 3 and 9
  // stay true by technique: the track moves through an animatable @property
  // factor; the content is pinned at its final width for the whole move.
  assert.doesNotMatch(source, /@property --side-open/u, '#200: registered once, in app.css, for every page');
  assert.match(source, /@property --drawer-open \{\s*syntax: '<number>';\s*inherits: false;\s*initial-value: 0;\s*\}/u);
  // The transition exists in ONE place, gated, and names only the two factors.
  const moving = rule('.cols:global(.moving)');
  assert.match(moving, /^\s*transition:\s*--side-open var\(--t-move\) ease-out,\s*--drawer-open var\(--t-move\) ease-out;\s*$/u,
    'the gate carries the only transition, on the factors, on --t-move');
  assert.equal([...source.matchAll(/transition:[^;]*(?:grid-template-columns|width)/gu)].length, 0, 'no width or track-list transition anywhere');
  for (const sel of ['.track', '.track:global(.pin-start)', '.track:global(.pin-end)']) {
    assert.doesNotMatch(rule(sel), /transition|transform|animation/u, `${sel}: an xterm ancestor never moves itself`);
  }
  assert.match(rule('.track:global(.pin-start)'), /justify-self:\s*start/u);
  assert.match(rule('.track:global(.pin-end)'), /justify-self:\s*end/u);
  assert.match(rule('.hub-root:not(.compact) .cols'), /overflow:\s*hidden/u, 'the grid clips what the moving track has not uncovered yet');
  assert.match(source, /@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.cols:global\(\.moving\) \{ transition: none; \}/u, 'reduced motion = a cut');
  // Open: rest state first (through the reading anchor), flush, pin at the
  // FINAL width, then move from 0. Close: pin at the CURRENT width, rest
  // state, move from 1, unmount after the move (the lead's amendment: a cut
  // beside an animated open reads as a stutter).
  assert.match(source, /await withReadingAnchor\(\(\) => \{ termOpen = true; \}\);\s*\n\s*hubPrefs\.setDrawer\(selected, drawerView\);\s*\n\s*await revealDrawer\(0\);/u, 'open: anchor → pin → move from 0');
  assert.match(source, /const unpin = drawerTrackEl \? pinTrack\(drawerTrackEl, 'start'\) : null;\s*\n\s*drawerClosing = true;\s*\n\s*await withReadingAnchor\(\(\) => \{ termOpen = false; \}\);/u, 'close: pin first, then the rest state');
  assert.match(source, /await moveTrack\(colsEl, '--drawer-open', 1\);\s*\n\s*drawerClosing = false;\s*\n\s*unpin\?\.\(\);/u, 'close: unmount only after the move');
  assert.match(source, /const drawerShown = \$derived\(termOpen \|\| drawerClosing\);/u);
  assert.match(source, /class:drawer-open=\{termOpen && !compact\}/u, 'the rest class follows the intent, not the mount');
});

test('the sidebar collapses and expands by the same reveal, from ONE control that turns (board #174)', () => {
  // Rest state: the factor is 0 and the content is unreachable, not narrowed.
  assert.match(rule('.hub-root.side-collapsed .cols'), /^\s*--side-open:\s*0;\s*$/u);
  assert.match(source, /\.hub-root\.side-collapsed \.cols:not\(:global\(\.moving\)\) > \.track\.side \{ visibility: hidden; \}/u,
    'collapsed at rest = hidden from sight, tab order and assistive tech; visible only while it moves');
  assert.match(source, /<div class="track side" bind:this=\{sideTrackEl\}>\s*<Sidebar /u, 'the sidebar sits in its own track');
  assert.match(source, /class:side-collapsed=\{sideCollapsed && !compact\}/u, 'desktop only — the phone has its sheet');
  assert.match(source, /const sideCollapsed = \$derived\(hubPrefs\.sidebarCollapsed\);/u, 'the state IS the app-wide preference');
  // Collapse: pin at the current width, rest state, move from 1. Expand: rest
  // state, flush, pin at the FINAL width, move from 0 (placed first).
  assert.match(source, /const unpin = pinTrack\(sideTrackEl, 'end'\);\s*\n\s*await withReadingAnchor\(\(\) => hubPrefs\.setSidebarCollapsed\(true\)\);\s*\n\s*await moveTrack\(colsEl, '--side-open', 1\);\s*\n\s*unpin\(\);/u);
  assert.match(source, /await withReadingAnchor\(\(\) => hubPrefs\.setSidebarCollapsed\(false\)\);\s*\n\s*const unpin = pinTrack\(sideTrackEl, 'end'\);\s*\n\s*await moveTrack\(colsEl, '--side-open', 0\);\s*\n\s*unpin\(\);/u);
  // The control moved to the rail (board #202): the Hub renders no toggle of
  // its own; it keeps the animated writer the rail reaches through onReselect.
  assert.doesNotMatch(source, /sideToggle|side-toggle-ride|arrow-to-bar|--side-toggle-x/u);
  assert.doesNotMatch(source, /collapse=\{/u, 'the sidebar is handed no control');
  assert.match(source, /async function setSidebar\(collapsed\)/u);
});

test("re-selecting the Hub's rail tab toggles the sidebar (boards #199, #201)", () => {
  // Owner 2026-09-14 14:10: "左侧选项卡图标，选中点击也能展开，也能折叠".
  assert.match(source, /onReselect = null/u, 'a registration prop, like onGoBack');
  assert.match(source, /onReselect\?\.\(\(\) => \{ if \(!compact\) void setSidebar\(!sideCollapsed\); \}\);/u,
    'desktop only — the phone has no rail; a sheet has its own opener');
});

test('the phone Chat head is ONE dense tool group and the name may run up to it (board #228)', () => {
  // Owner 2026-09-21: "chat在手机上的按钮间的间距小一些，更紧凑一些，右上角的按钮 发送区的按钮，
  // 还有chat的标题要能够放下更宽的标题 下箭头右边不用留这么大间距". The 32px pitch is the
  // .compact-tools exception (#192/#193) the Files head already takes on touch;
  // the whole head wears it on compact so the menu, the caret and the three
  // toggles shrink together and the name gets the width their padding spent.
  assert.match(source, /<div class="page-head chat-head" class:compact-tools=\{compact\}>/u);
  const tools = source.slice(source.indexOf('<div class="head-tools">'), source.indexOf('{#if headerCopyFeedback && headerCopyAnchor}'));
  assert.ok(tools.includes('icon="layout"') && tools.includes('icon="files"') && tools.includes('icon="terminal"'), 'the three toggles are the group');
  assert.match(source, /\.head-tools \{ display: flex; align-items: center; gap: var\(--tool-gap\); flex: none; \}/u);
  // #228's compact max-width:none override died with the cap itself (#234):
  // the name now runs to the tools on EVERY layout, and on the desktop the
  // path compresses to its scrollable floor first.
  assert.ok(!source.includes('.hub-root.compact .title-group'), 'no compact override left — there is no cap to lift');
  assert.match(source, /\{#if !compact\}<span class="path"/u, 'the path is desktop-only');
});

test('a reply sends the quoted message\u2019s id; the server builds the quote, one per send (#290)', () => {
  assert.match(source, /const re = replyTo\?\.id;\s*const quoteBack = replyTo;\s*composerText = '';\s*stager\.pending = \[\]; \/\/ detached, not cleared[^\n]*\n\s*replyTo = null;/u, 'taken, then cleared, before the RPC');
  assert.match(source, /await hubPost\(room, text, 'human', re\);/u);
  assert.match(source, /if \(re && !replyTo\) replyTo = quoteBack;/u, 'a failed post keeps the quote with the draft');
  assert.match(source, /if \(!recipient && m\.from && managedAgents\.some\(\(a\) => a\.name === m\.from\)\) setRecipient\(m\.from\);/u, 'seats the quoted agent only when nobody is chosen');
  assert.match(source, /replyTo = null; \/\/ a quote belongs to the room it was taken in/u);
  assert.match(source, /backLayers\.register\('reply', \(\) => \{ if \(replyTo\) \{ replyTo = null; return true; \}/u, 'Back drops it');
  assert.doesNotMatch(source, /\[re /u, 'no second formatter in the client');
});

test('send DETACHES the staged set, never clears it: the thumbs live until the post settles (board #329 review)', () => {
  // clear() revokes the thumbs and bumps the generation; a send that used it
  // would kill the previews a failed post restores, and invalidate jobs.
  const sendFn = /async function send\(\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.ok(!/stager\.clear\(\)|clearAttachments\(\)/u.test(sendFn), 'send never clears');
  assert.match(sendFn, /const atts = pending;/u, 'the set is snapshotted');
  assert.match(sendFn, /stager\.pending = \[\];/u, 'then detached');
  assert.match(sendFn, /for \(const a of atts\) if \(a\.thumb\) URL\.revokeObjectURL\(a\.thumb\);\s*if \(selected !== room\) return;/u, 'revoked only after success');
});
