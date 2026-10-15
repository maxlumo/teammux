// Source-contract test for Settings hosting the agent configuration (board #10,
// owner 2026-08-29: "手机上的 Agent 设置页面应该归到 settings 里边的一个子页面,
// 不用单独在底下一行展示了，现在看着有点多底下的标签").
//
// The rule that must not rot: on a phone this category shows the REAL
// AgentsPage. A second implementation of the same editors is how the two
// devices start disagreeing about what an agent definition even has — and
// nothing would fail while they drifted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Preferences.svelte', import.meta.url), 'utf8');
const style = source.match(/<style>[\s\S]*<\/style>/u)?.[0] ?? '';

test('the Agents category embeds the real AgentsPage, never a copy of it', () => {
  assert.match(source, /import AgentsPage from '\.\.\/hub\/AgentsPage\.svelte'/u);
  assert.match(source, /<AgentsPage\b/u, 'the page itself is mounted here');
  // A copy would have to talk to the registry directly. Settings must not.
  assert.doesNotMatch(source, /registrySave|registryDelete|registryList/u,
    'agent definitions are edited in AgentsPage and only there');
  assert.match(style, /\.agents-embed \{[^}]*flex: 1[^}]*min-height: 0/u,
    'it is a page (height:100%), so it takes the shell’s remaining height rather than sitting in the padded pane');
});

test('the category exists only where Agents is not a page of its own', () => {
  // showAgents is App's call (nav-state's agentsLivesInSettings && hubEligible):
  // the desktop rail keeps Agents as a page with its own draggable icon.
  assert.match(source, /showAgents = false/u, 'off by default, so a host that says nothing gets the old Settings');
  // Four rows on the phone (owner, 2026-09-02: "把 team agent mcp skill 分开几个
  // 二级设置页面吧"), each the REAL page narrowed by `section` — since
  // 2026-09-05 as their own labelled AGENT group.
  assert.match(source, /\.\.\.\(showAgents \? \[\{\s*id: 'agent', label: \(\) => t\('settingsGroupAgent'\), rows: \[\s*\{ id: 'agents', label: \(\) => t\('agentsTitle'\) \},\s*\{ id: 'teams', label: \(\) => t\('teamsTitle'\) \},\s*\{ id: 'skills', label: \(\) => t\('skillsTitle'\) \},\s*\{ id: 'mcp', label: \(\) => t\('mcpTitle'\) \},\s*\],\s*\}\] : \[\]\)/u,
    'four rows, each labelled with its section’s own name, in one AGENT group');
  // ③a: one instance per MEMBER, each narrowed by its own last category.
  assert.match(source, /<AgentsPage\s+section=\{sectionOf\(g\.runtime\)\}/u, 'the one instance is narrowed by the category, never copied');
  // The two-group order (owner, 2026-09-05: "分成两组：1. 关于本身应用层面的
  // 一些设置 2. 关于 Agent 层面的设置"): the APP group — Appearance, Chat,
  // Notifications, (Shortcuts,) Connection — precedes the AGENT group. Chat
  // (feed detail, tool rows) replaced the one-row Terminal category on
  // 2026-09-25: terminal size and spacing are the terminal's LOOK and sit in
  // Appearance with its font (owner, 2026-09-24). Connection ends the APP group as its way out; it no longer trails
  // the agent rows (the pre-group "Connection stays last" rule, superseded).
  const list = source.match(/const groups = \$derived\(\[[\s\S]*?\]\);/u)?.[0] ?? '';
  const order = ['appearance', 'chat', 'notifications', 'shortcuts', 'connection', 'about', 'agents', 'teams', 'skills', 'mcp']
    .map((id) => list.indexOf(`id: '${id}'`));
  assert.ok(order.every((i) => i >= 0), 'every category sits in the grouped list');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'app group first, About closing it right after Connection, then the agent group');
  assert.match(source, /const tabs = \$derived\(groups\.flatMap\(\(g\) => g\.rows\)\);/u,
    'the flat list every consumer reads is derived FROM the groups — one source of order');
  // A restored category that does not exist here must not leave a blank pane.
  assert.match(source, /!showAgents && AGENT_TABS\.includes\(tab\)/u);
  assert.match(source, /untrack\(\(\) => selectTab\('appearance', undefined, undefined, false\)\)/u,
    '#156: capability corrections use the exit guard without opening a drill');
});

test('groups label themselves only when there are two, in the sidebar\u2019s own header voice (owner, 2026-09-05)', () => {
  // "分成两组" — the labels exist FOR the contrast: a desktop list with no
  // agent group is one group, and one labelled group is noise. The label is
  // the shared .side-h dialect (group-label like Sessions/Projects), never a
  // new species; no scoped rule may re-declare its box or type
  // (ui/sidebar.source.test.ts owns that drift).
  assert.match(source, /\{#each groups as g \(g\.id\)\}\s*\{#if groups\.length > 1\}<div class="group-label side-h">\{g\.label\(\)\}<\/div>\{\/if\}/u,
    'a label per group, only when a second group exists');
  assert.match(source, /\{#each g\.rows as item \(item\.id\)\}/u, 'the rows render inside their group');
  assert.doesNotMatch(style, /\.group-label/u, 'no scoped .group-label rule — .side-h owns the box and type');
});

test('the category is restorable, and it opens on request', () => {
  assert.match(source, /AGENT_TABS\.includes\(storedTab\)/u, 'a reload comes back to the category you were in');
  assert.match(source, /let openedRequest = 0;/u);
  assert.match(
    source,
    /const req = openRequest;\s*if \(!req \|\| req\.n === openedRequest\) return;[\s\S]*?if \(tabs\.some\(\(x\) => x\.id === req\.tab\)\) untrack\(\(\) => selectTab\(req\.tab, \(\) => \{\s*openedRequest = req\.n;/u,
    '#156: one-shot requests are consumed only inside the accepted category action',
  );
});

// ③a (reviewer P1-C): each member's guest registers its own back chain,
// guard and drilled state; the page asks the SHOWN guest's at use time.
test('back peels the embedded page first, then the category', () => {
  // Same order the page uses on its own: dialog, editor, then out. Getting this
  // backwards drops the user out of Settings mid-edit.
  assert.match(
    source,
    /onGoBack\?\.\(\(\) => \{[\s\S]*?if \(AGENT_TABS\.includes\(tab\) && agentsBack\(\)\) return true;[\s\S]*?if \(catOpen && isCompact\(\)\) \{ closeCat\(\); return true; \}/u,
  );
  assert.match(source, /onGoBack=\{\(fn: \(\) => boolean\) => \{ reg\(g\.runtime\)\.back = fn; \}\}/u, 'the embedded page hands its chain up');
});

test('one head at a time: Settings yields its own to the editor', () => {
  // The embedded editor brings a .page-head of its own; two stacked title bars
  // is most of a phone's first screenful.
  assert.match(source, /\{#if !\(AGENT_TABS\.includes\(tab\) && agentsDrilled\)\}\s*<div class="page-head config-page-head">/u);
  assert.match(source, /onDrilled=\{\(d: boolean\) => setDrilled\(g\.runtime, d\)\}/u);
});

test('a tapped address wears the running cue until the socket settles (2026-09-03)', () => {
  // The dot is the app-wide class from app.css, never a local re-implementation.
  assert.match(source, /<span class="addr-dot" class:live-dot=\{pending\}><\/span>/u);
  assert.match(source, /\{@const pending = address === pendingAddress\}/u);
  const dotRules = style.match(/[^{}]*addr-dot[^{]*\{[^}]*\}/gu)?.join('\n') ?? '';
  assert.ok(dotRules, 'the dot has rules');
  assert.doesNotMatch(dotRules, /animation|box-shadow|@keyframes/u, 'no local re-implementation — .live-dot is the one running cue');
  // At rest achromatic; the current and the dialing row accent.
  assert.match(style, /\.addr-dot\{[^}]*background:var\(--status-sleep\)/u);
  assert.match(style, /\.address-list button\.active \.addr-dot,\.address-list button\.pending \.addr-dot\{background:var\(--accent\)\}/u);
});

test('category and address rows explain themselves with the one hover card (motion.md §1.16, board #86)', () => {
  // A category row's label is terse; the card says what is inside (one i18n
  // hint per category, kept OUTSIDE `tabs` so the pinned list shape holds).
  assert.match(source, /class="side-row" class:open=\{tab === item\.id\} onclick=\{\(\) => selectTab\(item\.id\)\}\s*use:hoverInfo=\{\(\) => \(\{ title: item\.label\(\), text: TAB_HINTS\[item\.id\]/u);
  for (const id of ['appearance', 'chat', 'notifications', 'shortcuts', 'agents', 'teams', 'skills', 'mcp', 'connection', 'about']) {
    assert.match(source, new RegExp(`${id}: 'settings[A-Za-z]+Hint'`, 'u'), `${id} has a hint`);
  }
  // An address row: the address and its state (current / dialing / alternate);
  // the dialing cue used to be a native title — the card replaces it.
  assert.match(source, /\{@const active = address === activeAddress\}/u);
  const addr = source.match(/<button type="button" class="config-input address-choice" class:active class:pending[\s\S]*?onclick=/u)?.[0] ?? '';
  assert.match(addr, /use:hoverInfo=\{\(\) => \(\{ title: address, lines: \[pending/u);
  assert.doesNotMatch(addr, /title=/u);
});

test('failover addresses are removable and drag-reorderable through ONE write path (board #222)', () => {
  // The list's order IS the failover priority the reconnect round-robin walks.
  // Remove and reorder never touch storage themselves: both hand the new list
  // to App's onAddressesChange, which persists through servers.ts's
  // saveMachineAddresses — the map's one writer.
  assert.match(source, /onAddressesChange\?: \(addresses: string\[\]\) => void/u);
  assert.match(source, /onAddressesChange\(addresses\.filter\(\(a\) => a !== address\)\)/u, 'remove hands up the filtered list');
  assert.match(source, /onAddressesChange\(listDropAt\(addresses, addrDrag\.address, addrDrag\.rects, addrDrag\.idx\)\)/u,
    'the drop commits from the SAME index the insertion line was drawn from');
  // The drag is the rail's idiom, not a second dialect: the shared threshold
  // and drop geometry come from nav-order.ts, the carried row moves by
  // transform, and the commit animates with the shared flip tempo.
  // Since #384 the press itself (threshold, capture, cancel) is the ONE
  // press-drag, executed in ui/press-drag.test.ts; the list keeps the drop
  // geometry, and a finger may start it because the grip opts out of
  // scrolling.
  assert.match(source, /import \{ listDropAt, railDropIndex, railDropOffset \} from '\.\/nav-order\.ts'/u);
  assert.match(source, /import \{ createPressDrag \} from '\.\.\/ui\/press-drag\.ts'/u);
  assert.match(source, /const addrDrags = createPressDrag<[\s\S]*?>\(\{[\s\S]*?touch: true,/u, 'a finger may start it on the grip');
  assert.doesNotMatch(source, /RAIL_DRAG_THRESHOLD|setPointerCapture|addEventListener\('pointerup'/u, 'no second press mechanism here');
  assert.match(source, /if \(!addrDrag\) return;\s*return addrDrags\.listen\(\);/u, 'Escape, a resize and a lost capture end the drag');
  assert.match(source, /as address \(address\)/u, 'a keyed each — flip needs stable identity');
  assert.match(source, /animate:flip=\{\{ duration: moveMs\(\) \}\}/u);
  // The grip, not the row, is the handle: the row is already a switch command,
  // and on touch a whole-row vertical drag would fight the page's scroll.
  assert.match(source, /class="addr-grip" aria-label=\{t\('addressDrag'\)\}/u);
  assert.match(source, /onkeydown=\{\(e\) => addrGripKey\(e, address\)\}/u, 'the keyboard form of the same reorder');
  assert.match(style, /\.addr-grip \{[^}]*touch-action: none/u, 'the grip opts out of scrolling');
  // A gesture target, but the same hit box the commands get: --control-height
  // is the 44px floor on touch (review, board #222).
  assert.match(style, /\.addr-grip \{[^}]*width: var\(--control-height\); height: var\(--control-height\)/u);
  // The ACTIVE address is the live connection — it is never removable. The ×
  // is the shared danger icon command (rule 6), exactly the roster's Stop:
  // the atom carries the hit box, radius, ink and focus ring — never a local
  // raw button (review, board #222).
  assert.match(source, /\{#if addresses\.length && !active\}[\s\S]{0,400}?<CommandButton variant="danger" iconOnly bare icon="x" label=\{`\$\{t\('delete'\)\} \$\{address\}`\}/u);
  assert.doesNotMatch(style, /\.addr-del/u, 'no local delete button — the atom owns the look');
  // The lifted row's shadow is the menu token, never a literal rgba.
  assert.match(style, /\.address-row\.lifted \.address-choice \{[^}]*box-shadow: var\(--menu-shadow\)/u);
  assert.doesNotMatch(style, /rgba\(/u, 'no literal colors — tokens only');
  // The legacy agent-hooks management surface is gone whole (board #222): the
  // UI, its RPC wrappers and its state left together.
  assert.doesNotMatch(source, /agentHooks|hook-backends|hook-control|hookStatus/u);
});

test('the category list and a switched category unfold instead of flashing (motion.md §1.15, board #86)', () => {
  // First paint only for the list: on compact the drill display-toggles the
  // sidebar, and a re-shown list must not replay the unfold over the
  // drill-back slide (one motion per view).
  assert.match(source, /<div class="side-scroll subtle-scroll" class:reveal=\{!drillAnim\} use:scrollFade>/u);
  // #156 retires the cards; the same accepted category key reveals its form.
  assert.match(source, /\{#key tab\}\s*<div class="pref-content">\s*<div class="config-form reveal">/u);
  assert.match(source, /<\/div>\s*\{\/key\}\s*\{\/if\}\s*<\/div>\s*<\/section>/u, 'the key closes with the pane');
});

test('the phone reaches the server registry from the top of Settings (2026-09-03)', () => {
  // The row exists only when App hands over the opener (touch layout); it is a
  // .side-row like the categories, not a new species, and it opens the SAME
  // registry popover the desktop rail opens.
  // #165 classifies the editable registry as a non-modal picker dialog.
  assert.match(source, /\{#if onServers\}\s*<button class="side-row server-row"[^>]*aria-haspopup="dialog"/u);
  assert.match(source, /aria-controls=\{serversOpen \? serversControls : undefined\}/u);
  assert.match(source, /onclick=\{\(e\) => onServers\?\.\(e\)\}/u);
  assert.match(source, /<span class="quarter-turn" class:on=\{serversOpen\}><Icon name="swap-h" size=\{14\} \/><\/span>/u,
    'the symmetric swap glyph turns 90°, not an invisible 180°');
  assert.match(source, /<span class="r-label">\{serverName\}<\/span>/u, 'the current server\'s saved NAME (App currentServerName), never the raw address');
  assert.match(source, /onServers = null,/u, 'off by default — the desktop rail has its own control');
});


test('settings controls use labels and values, not a subtitle under every row (board #87)', () => {
  for (const key of [
    'themeHint', 'languageHint', 'layoutHint', 'hubFeedLevelHint', 'hubStepsRowsHint',
    'uiFontBodyHint', 'uiFontDisplayHint', 'uiZoomHint', 'hubNotifyHint',
    'hubNotifyLevelHint', 'hubNotifyTestHint', 'fontFamilyHint', 'fontSizeHint',
    'lineHeightHint', 'shortcutGlobalScope', 'shortcutTerminalScope', 'debugHint',
  ]) {
    assert.doesNotMatch(source, new RegExp(`<small>\\{t\\('${key}'\\)\\}<\\/small>`, 'u'),
      `${key} must not become persistent tutorial copy`);
  }
  assert.match(source, /notifyPerm === 'denied'[\s\S]{0,120}<small class="config-note">\{t\('hubNotifyDenied'\)\}<\/small>/u,
    'an actual permission problem still explains itself');
  assert.match(source, /class="config-error font-error appear" role="alert"/u, 'validation errors remain visible');
});

test('Settings adopts shared configuration geometry and semantic controls (#156)', () => {
  for (const component of ['CommandButton', 'Switch', 'Stepper', 'Slider']) {
    assert.match(source, new RegExp(`import ${component} from '../ui/${component}\\.svelte'`, 'u'));
    assert.match(source, new RegExp(`<${component}\\b`, 'u'));
  }
  assert.match(source, /class="config-head-inner"/u);
  assert.match(source, /class="preference-row"/u);
  assert.match(source, /class="pref-label"/u);
  assert.match(source, /class="pref-control/u);
  assert.doesNotMatch(style, /setting-card|setting-row|\.stepper|\.range-wrap|\.hook-action|\.reset|--ui-control-height|720px|999px/u,
    'retired per-page cards, controls and dimensions must not survive the migration');
  assert.match(source, /class="config-input mono shortcut-key"[\s\S]*?data-shortcut-recorder/u,
    'the native key recorder retains its own input semantics and shares field geometry');
  assert.match(source, /onGuardExit=\{\(guard: Guard\) => registerAgentsGuard\(g\.runtime, guard\)\}/u);
  assert.match(source, /editRequest=\{acceptedAgentRequest\?\.serverId === g\.runtime\.id && sectionOf\(g\.runtime\) === \(acceptedAgentRequest\.kind === 'team' \? 'teams' : 'agents'\) \? acceptedAgentRequest : null\}/u,
    'a queued Agent (or, #258, Team) jump is never forwarded into another section');
  assert.doesNotMatch(source, /addEventListener\(['"]popstate|pushState\(/u,
    'the local guard must not become a second browser-history controller');
  const layout = source.slice(source.indexOf('function measureLayout'), source.indexOf('let drillPushed'));
  assert.match(layout, /node\.clientWidth < sidebar \+ editor/u,
    'the category/form budget follows available container space');
  assert.match(layout, /observer\.observe\(sidebar\)/u, 'the shared resizer also changes the budget');
  assert.doesNotMatch(layout, /selectTab|onDrill|history\.|tab =/u,
    'layout changes presentation, never navigation or the mounted draft');
  assert.doesNotMatch(style, /container-type/u, 'fixed Select popovers retain the viewport');
});

test('Settings opts into compact rhythm without styling shared atoms or changing embedded Agent geometry (#162)', () => {
  assert.match(source, /<section class="preferences" class:config-compact=\{!AGENT_TABS\.includes\(tab\)\}/u);
  assert.doesNotMatch(style, /\.preference-row|\.config-form|\.config-field-label|\.segmented|\.sel-trigger|\.command-button/u,
    'the shared row/control owners implement the compact look');
  assert.doesNotMatch(style, /--(?:font-(?:ui|display|mono)|bg|text)\s*:/u,
    'the prototype font/canvas overrides must not replace user font roles or recolor unrelated content');
});

test('the three font pickers demonstrate themselves and name their scope (board #97)', async () => {
  // "我其实没看懂设置的到底是哪里的字体，最好选择的字体本身就有样式": every
  // font Select renders its options IN the family each names (fontPreview),
  // and each row explains WHICH surfaces its role paints through the hover
  // card (the #87 dialect — never a persistent subtitle) + the aria-label.
  // #156 retires dense here: a font value shares the Agent form's body step,
  // even though it previews a different family.
  for (const [sel, hint] of [
    [/bind:value=\{fontInput\} editable fontPreview emptyFace="var\(--font-mono\)"/u, /use:hoverInfo=\{\(\) => \(\{ title: t\('fontFamily'\), text: t\('fontFamilyHint'\) \}\)\}/u],
    [/bind:value=\{uiFontInput\} editable fontPreview/u, /use:hoverInfo=\{\(\) => \(\{ title: t\('uiFontBody'\), text: t\('uiFontBodyHint'\) \}\)\}/u],
    [/bind:value=\{displayFontInput\} editable fontPreview/u, /use:hoverInfo=\{\(\) => \(\{ title: t\('uiFontDisplay'\), text: t\('uiFontDisplayHint'\) \}\)\}/u],
  ] as const) {
    assert.match(source, sel, `the picker previews: ${sel}`);
    assert.match(source, hint, `its scope is explained on hover: ${hint}`);
  }
  // The mechanism lives in the ONE Select (rule 6), opt-in per instance.
  const select = await readFile(new URL('../ui/Select.svelte', import.meta.url), 'utf8');
  assert.match(select, /style:font-family=\{fontPreview && o\.value \? `'\$\{o\.value\.replace\(\/\['"\]\/g, ''\)\}'` : undefined\}/u,
    'each option wears the family it names');
  assert.match(select, /style:font-family=\{fontPreview && value\.trim\(\) \? `'\$\{value\.trim\(\)\.replace\(\/\['"\]\/g, ''\)\}'` : \(fontPreview && emptyFace\) \|\| undefined\}/u,
    'the combo field wears the current value\u2019s face');
  // Board 312: each font field carries its reset, the Slider's undo atom —
  // never a second reset species.
  for (const [role, pref] of [['ui', 'uiFont'], ['display', 'displayFont'], ['mono', 'fonts']]) {
    assert.match(source, new RegExp(`<CommandButton variant="icon" icon="undo" label=\\{\\x60[^\\x60]*\\x60\\}\\s+disabled=\\{fontState\\.${role}\\.pending \\|\\| !${pref}\\.custom\\} onclick=\\{\\(\\) => resetFont\\('${role}'\\)\\} />`, 'u'),
      `${role}: reset is the undo icon button, disabled at the default`);
  }
});
