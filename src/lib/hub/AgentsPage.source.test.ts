import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./AgentsPage.svelte', import.meta.url), 'utf8');
const i18n = await readFile(new URL('../core/i18n.svelte.ts', import.meta.url), 'utf8');

test('delete and neutral discard own explicit glyphs and reuse the existing exit copy (#167, 2026-09-12)', () => {
  // Source pins caller semantics, while mount tests exercise async behavior.
  assert.match(source, /confirmLabel=\{t\('delete'\)\} confirmIcon="trash" error=\{removeError\}/u);
  assert.match(source, /confirmLabel=\{t\('configDiscard'\)\} confirmIcon="check" cancelLabel=\{t\('configKeepEditing'\)\}/u);
});

test('Agent-family forms opt into the shared compact composition (#163)', () => {
  assert.match(source, /class="agents-root config-compact config-entity"/u);
  assert.doesNotMatch(source, /\.config-field\s*\{|\.config-row\s*\{/u,
    'shared field layout belongs to app.css, not a page-local override');
});

test('member identity is circular and unframed without removing the member boundary (#163)', async () => {
  const avatar = /\.member-ava \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(avatar, /width: 32px; height: 32px; border-radius: 50%/u);
  assert.doesNotMatch(avatar, /box-shadow|border:/u);
  assert.match(source, /\.member-ava \{ width: 34px; height: 34px; \}/u);
  const member = /\.member \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(member, /border: 1px solid var\(--border\)/u);
  const css = await readFile(new URL('../../app.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.agents-root \.member-ava/u,
    'a circle must not opt into the global squircle policy');
});

test('the desktop config page has THREE levels: categories | rows | editor (board #94)', () => {
  // "在桌面版，可以再多一级，右侧拆分成两级": the chosen category's rows are
  // their own column, so an open editor no longer REPLACES them — the list
  // stays beside what it selected. Compact keeps the two-level drill; the
  // phone's Settings sections keep their sidebar-of-rows shape.
  // Backends (board #492) is a category without a roster, so it has no rows column.
  assert.match(source, /class:with-rows=\{!section && cat !== 'backends'\}/u, 'the third column exists only on the desktop page');
  assert.match(source, /<aside class="cat-rows config-navigation">/u, 'the rows column is its own shared configuration navigation');
  assert.match(source, /\{#if !section && cat !== 'backends'\}[\s\S]{0,900}?<aside class="cat-rows config-navigation">/u, 'and renders only without a section');
  assert.match(source, /\{@render rows\(cat\)\}/u, 'the ONE rows snippet feeds it — no second list dialect');
  // The global instructions have no roster, only the one document.
  assert.match(source, /class:open=\{!!editingGlobal\} onclick=\{startGlobal\}[\s\S]{0,120}?AGENTS\.md/u,
    'the global category\u2019s level is its single AGENTS.md row');
  // Its width is a real divider with a remembered width, like every other.
  assert.match(source, /varName="--agents-rows-w" storeKey="tmux_agents_rows_w"/u, 'the rows column has its own SideHandle');
  assert.match(source, /\.agents-root\.with-rows \{ grid-template-columns: var\(--sidebar-w\) var\(--agents-rows-w, 240px\) minmax\(0, 1fr\); \}/u,
    'three grid columns on the desktop');
  assert.match(source, /localStorage\.getItem\('tmux_agents_rows_w'\)/u, 'the width survives reload');
  // Compact degrades to the pre-#94 shape: the drill, not a squeezed grid.
  const media = /@media \(max-width: 760px\) \{([\s\S]*?)\n  \}/u.exec(source)?.[1] ?? '';
  assert.match(media, /\.cat-rows \{ display: none; \}/u, 'the rows column is desktop-only');
  assert.match(media, /\.agents-root, \.agents-root\.with-rows \{ grid-template-columns: minmax\(0, 1fr\); \}/u,
    'compact is one column regardless');
  // The rows moved OUT of the main column — the old in-mid list stays retired.
  assert.ok(!source.includes('cat-list'), 'no rows in the editor column');
});

test('team members have exactly three sources, and only bare agents own prompt, Skills and MCP', () => {
  assert.match(source,
    /\{ value: '', label: t\('teamsBare'\) \}[\s\S]{0,400}?\.\.\.defs\.map\([\s\S]{0,220}?teamsCustomAgent[\s\S]{0,400}?\.\.\.subTeams\.map/u,
    'the source picker offers bare backend, custom registry agent, then sub-team');
  assert.match(source,
    /\{#if !m\.base && !m\.team && m\.agent\}[\s\S]*?bind:value=\{m\.agent\.system\}[\s\S]*?m\.agent\.skillSel[\s\S]*?m\.agent\.mcpSel[\s\S]*?\{\/if\}/u,
    'the bare branch owns prompt, Skills and MCP controls');
  // #156: the submitted payload also defines dirty state. Its serialization
  // vectors now execute in config-draft.test.ts instead of pinning a copy here.
  assert.match(source, /payload = configPayload\(draft\)/u, 'Save uses the shared payload definition');
  assert.match(source,
    /if \(v\.startsWith\('team:'\)\)[\s\S]{0,160}?m\.agent = null[\s\S]{0,160}?m\.agent = v \? null : \(m\.agent \?\? bareEditor\(\)\)/u,
    'switching to inherited sources drops bare-only configuration');
});

test('the team editor opens a readable member card and focuses one member at a time', () => {
  assert.match(source, /class="member" class:open=\{m\.expanded\}/u, 'each member has one stable card');
  assert.match(source, /class="member-summary"[\s\S]{0,120}?aria-expanded=\{m\.expanded\}[\s\S]{0,360}?onclick=\{\(\) => toggleMember\(i\)\}/u,
    'the broad summary, not a tiny chevron, opens the member');
  assert.match(source, /member-ava[\s\S]{0,900}?member-title[\s\S]{0,220}?member-source[\s\S]{0,220}?member-role/u,
    'the summary identifies the backend, member, source and role');
  assert.match(source, /function toggleMember\(i\)[\s\S]{0,260}?expanded: opening && k === i/u,
    'opening one member closes every other member');
  assert.match(source, /\{#if m\.expanded\}[\s\S]{0,120}?<div class="member-body appear">/u,
    'details mount only while expanded');
  assert.match(source, /teamsMemberSetup[\s\S]{0,500}?bind:value=\{m\.name\}/u,
    'the member name moves into the expanded identity section');
  assert.match(source, /class="config-row"[\s\S]{0,1400}?onchange=\{\(v\) => setBase\(i, v\)\}/u,
    'the member source moves into the expanded identity section');
  assert.match(source, /class="member-section"[\s\S]{0,220}?teamsOverrides/u,
    'custom-agent overrides have a clear section');
  assert.match(source, /class="member-section"[\s\S]{0,220}?teamsBareConfig/u,
    'bare-agent configuration has a clear section');
  assert.match(source, /class="config-input" rows="12"[\s\S]{0,160}?use:autoGrow/u,
    'the bare-agent prompt gets a document-sized auto-growing editor');
  assert.match(source, /class="config-input" rows="6" bind:value=\{m\.role\}[\s\S]{0,180}?use:autoGrow/u,
    'the member role grows with its prompt instead of staying a four-line keyhole');
  // #156 deliberately retires the private team width/heights and membership
  // pills: shared config atoms own dimensions, shared commands own hit targets.
  assert.match(source, /<CommandButton icon="plus" label=\{t\('teamsAddMember'\)\}/u);
  assert.doesNotMatch(source, /\.agent-prompt \{|\.row3 \{|\.member-actions \.icon-btn \{/u);
  assert.match(source, /<CheckboxGroup label=\{t\('agentsSkills'\)\} value=\{m\.agent\.skillSel\}/u);
});

test('the shared team description is presented as rules, not a vague purpose', () => {
  assert.match(i18n, /teamsDesc: 'Team rules'/u);
  assert.match(i18n, /teamsDesc: '小组规则'/u);
  assert.match(source, /t\('teamsDesc'\)[\s\S]{0,180}?class="config-input"[\s\S]{0,180}?bind:value=\{editingTeam\.description\}[\s\S]{0,180}?use:autoGrow/u,
    'the existing durable description field keeps carrying the renamed rules in a full-width growing editor');
});

test('form columns follow actual container budgets without containing fixed popovers (#156)', () => {
  assert.match(source, /new ResizeObserver\(measure\)/u);
  assert.match(source, /node\.clientWidth < sidebar \+ rows \+ editor/u);
  assert.match(source, /getPropertyValue\('--config-editor-width'\)/u);
  assert.match(source, /return \(\) => observer\.disconnect\(\)/u);
  assert.doesNotMatch(source, /container-type:|popstate|history\.pushState/u);
  assert.match(source, /class="editor config-form"><fieldset class="config-fields" disabled=\{saving \|\| removing\}/u);
});

test('configuration metadata stays readable and does not displace the category name (#156)', () => {
  const memberSource = /\.member-source \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(memberSource, /color: var\(--text2\)/u);
  assert.match(memberSource, /var\(--fs-sub\)/u);
  assert.doesNotMatch(memberSource, /text-overflow: ellipsis/u);
  assert.doesNotMatch(source, /\{#if c\.count\}[^]*?\{:else\}<span class="r-backend">AGENTS\.md/u);
});

test('the editable description preview keeps the body role and full touch target (#156)', () => {
  const rule = /\.desc-view \{([^}]*)\}/u.exec(source)?.[1] ?? '';
  assert.match(rule, /font-size: var\(--fs-body\)/u);
  assert.match(rule, /min-height: var\(--control-height\)/u);
});

test('entity errors use the same readable alert atom as Settings (#156)', () => {
  assert.equal((source.match(/class="err config-error appear" role="alert"/gu) ?? []).length, 7);
  assert.doesNotMatch(source, /\.err \{/u, 'no private error frame or low-contrast ink');
});

test('the Agents list groups use the shared atoms, and every spawn surface reads the one availability reader (#7)', async () => {
  // Headings are the shared .side-h, the divider is the --border hairline,
  // the reason dot is the one state colour language; no literal colour.
  assert.match(source, /<div class="agent-group" class:divided=\{id === 'custom'\} role="group" aria-label=\{t\(label\)\}>\s*<div class="side-h">\{t\(label\)\}<\/div>/u);
  assert.match(source, /\.agent-group\.divided \{ border-top: 1px solid var\(--border\);/u);
  assert.match(source, /<span class="r-dot" class:live-dot=\{stateIsLive\('waiting'\)\} style:background=\{stateDotColor\('waiting'\)\} aria-hidden="true"><\/span>\{why\}/u);
  const block = /\/\* Board #7: the two groups[\s\S]*?\.r-dot \{[^}]*\}/u.exec(source)?.[0] ?? '';
  assert.ok(block, 'the group CSS block');
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgb\(|font-size:/iu, 'tokens only: no literal colour, no raw font size');
  // validator-2 S1 (round 1): an unavailable thing dims with the ONE disabled
  // token (design-language.md: native disabled semantics at 0.4), never a
  // literal opacity, on every surface that greys one.
  assert.match(block, /\.side-row\.unavailable \.ava, \.side-row\.unavailable \.r-backend \{ opacity: var\(--control-disabled-opacity\); \}/u);
  // Every place that lists agents to start, and the team member picker, asks
  // the ONE reader; none re-derives availability from readiness itself.
  const spawners = {
    'AgentsPage.svelte': source,
    'Hub.svelte': await readFile(new URL('./Hub.svelte', import.meta.url), 'utf8'),
    'CreateProjectDialog.svelte': await readFile(new URL('../projects/CreateProjectDialog.svelte', import.meta.url), 'utf8'),
  };
  for (const [file, text] of Object.entries(spawners)) {
    assert.match(text, /import \{[^}]*\bunavailableText\b[^}]*\} from '(\.\/|\.\.\/hub\/)backends-view\.ts'/u, file);
    assert.doesNotMatch(text, /availability\?*\.state/u, `${file} reads availability only through backends-view`);
  }
  assert.match(spawners['Hub.svelte'], /disabled=\{starting \|\| !!why\}/u, 'the roster start list offers no start');
  assert.match(spawners['Hub.svelte'], /disabled=\{!!why && !startPick\.includes\(r\.name\)\}/u, 'the start dialog offers no pick');
  assert.match(spawners['CreateProjectDialog.svelte'], /disabled=\{!!why && !agents\.includes\(r\.name\)\}/u);
  assert.match(source, /hint: unavailableText\(d, t\) \|\| undefined/u, 'the team member picker says why');
  for (const [file, text] of Object.entries(spawners)) {
    const css = text.slice(text.lastIndexOf('<style'));
    assert.doesNotMatch(css, /(?:unavailable|:disabled)[^{]*\{[^}]*opacity:\s*0?\.\d/u, `${file}: a disabled or unavailable rule uses --control-disabled-opacity, not a literal`);
  }
  // validator-2 P1 (round 1): a TEAM start is a spawn too; both team surfaces
  // read the one team reader and offer no start for an unavailable team.
  const hub = spawners['Hub.svelte'];
  assert.match(hub, /import \{ firstReport, keepAvailable, settleAvailability, teamUnavailableText, unavailableText \} from '\.\/backends-view\.ts'/u);
  assert.match(hub, /<button class="start-row team" class:unavailable=\{!!why\} disabled=\{starting \|\| !!why\}/u, 'the roster start list team row');
  assert.match(hub, /<button class="agent-pick team" disabled=\{starting \|\| !!why\}/u, 'the start dialog team row');
  assert.equal(hub.match(/@const why = teamUnavailableText\(tm, t\)/gu)?.length, 2);
  // Round 2 (reviewer 08:57): every spawn surface waits for the first
  // readiness report through the ONE helper, guarded to once.
  assert.match(source, /settleAvailability\(defs, firstReport\(guardOwner\.api\)\)/u);
  assert.match(hub, /settleAvailability\(\[\.\.\.registry, \.\.\.teams\], firstReport\(scope\.runtime\.api\)\)/u);
  assert.match(spawners['CreateProjectDialog.svelte'], /settleAvailability\(registry, firstReport\(scope\.runtime\.api\)\)/u);
  for (const [file, text] of Object.entries(spawners)) assert.doesNotMatch(text, /backends_check/u, `${file}: no direct probe`);
  // Round 3 (reviewer 10:23 P1-R2): each re-list drops a pick the server now
  // greys, through the ONE helper, so a stale pick cannot be submitted.
  assert.match(hub, /registry = r\.agents \?\? \[\]; startPick = keepAvailable\(startPick, registry\);/u);
  assert.match(spawners['CreateProjectDialog.svelte'], /registry = r\.agents \?\? \[\];\n    agents = keepAvailable\(agents, registry\);/u);
  // The waits are one call each, never a timer or a poll.
  for (const [file, name] of [['Hub.svelte', 'loadStartLists'], ['CreateProjectDialog.svelte', 'loadRegistry']] as const) {
    const body = new RegExp(`async function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`, 'u').exec(spawners[file])?.[0] ?? '';
    assert.ok(body, `${file}: ${name}`);
    assert.doesNotMatch(body, /setTimeout|setInterval|poll\(/u, `${file}: ${name} waits once, it never polls`);
  }
  // English and Chinese strings exist for every new key.
  for (const key of ['agentsGroupDefaults', 'agentsGroupCustom', 'agentsUnavailable', 'agentsUnavailableMissing', 'teamsUnavailable', 'teamsUnavailableMissing']) {
    assert.equal(i18n.match(new RegExp(`\\b${key}:`, 'gu'))?.length, 2, key);
  }
});
