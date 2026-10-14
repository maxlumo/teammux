import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Sessions.svelte', import.meta.url), 'utf8');

test('confirmation Back delegates locally without owning browser history (#167, 2026-09-12)', () => {
  // App owns native Back; the nested caller exposes only its local contract.
  assert.doesNotMatch(source, /\b(?:window|document)\.addEventListener\(['"](?:popstate|keydown)['"]/u);
});

test('kill confirmations explicitly distinguish process icons from deletion (#167, 2026-09-12)', () => {
  // Glyph choice belongs to the caller; danger alone cannot mean trash.
  assert.match(source, /confirmIcon=\{pendingKill\?\.kind === 'window' \? 'x' : 'stop'\}/u);
  assert.match(source, /confirmKillSessionAction'\), icon: 'stop'/u);
  assert.match(source, /confirmKillWindowAction'\), icon: 'x'/u);
});

test('the retired unread-notification dots stay retired (2026-09-01)', () => {
  assert.doesNotMatch(source, /agent-notifications\.svelte/u);
  assert.doesNotMatch(source, /attention-dot|sessionHasNotification/u);
});

test('the sidebar creates a project with the shared row, not its own button', () => {
  // ui-unification.md: every sidebar's create affordance is `.side-row.add`
  // (Chat's projects, Agents' defs/skills/MCP). The Terminal sidebar used a
  // full-width bordered button in a bottom bar, which is what made the two
  // sidebars read as different apps even though the dialog behind them is the
  // same one (owner, 2026-08-19).
  assert.match(source, /\{#if !chips && trackedReady && !hasProjects\}\s*<button class="side-row add"[\s\S]*?projectNew/u,
    'the foot row remains only while there is no list to head (owner, 2026-09-23: the command moved to the Projects head)');
  assert.match(source, /oncreate=\{\(\) => showNew = true\}/u, 'the Projects head opens the same dialog');
  // The page dialect keeps its button — but only there.
  assert.match(source, /\{#if chips\}\s*<button class="new-btn"/u);
});

test('sidebar section headers speak the shared .side-h dialect', () => {
  // Two header styles in ONE column (accent-bold group headers above dense
  // mono PROJECTS) is the drift the shared vocabulary exists to stop. The
  // fix is to WEAR the class, not to restate its properties — restating
  // them is how the tracking ended up at 1.05px next to Chat's 1.4px.
  // (One header since board #100 deleted the Team group; the dialect rule
  // is per header, not per count.)
  const labels = source.match(/<div class="group-label"[^>]*>/gu) ?? [];
  assert.ok(labels.length >= 1, 'the group header exists');
  for (const l of labels) assert.match(l, /class:side-h=\{!chips\}/u);
  const dense = /\.sessions\.sidebar-mode \.group-label \{([\s\S]*?)\}/u.exec(source)?.[1] ?? '';
  assert.doesNotMatch(dense, /font-family|font-size|letter-spacing/u, 'type comes from app.css');
  // A flat list gets a header too, so no group of rows is unlabelled.
  assert.match(source, /\{#if !chips && filtered\.length > 0\}\s*<div class="group-label"/u);
});

test('the phone s session sheet is ONE list: the foreign rows are handed to Projects and merged INTO it, never appended; "phone" is the host s (#357, #371)', async () => {
  // The component never decides what a phone is: the host passes the sheet s
  // own condition (App: isTouchDevice && narrowVp, the same as `.side-sheet`).
  assert.match(source, /onPickServer = null, foreignInline = false/u);
  assert.doesNotMatch(source, /foreignInline = \$derived|const foreignInline/u, 'no second definition of "phone" in the component');
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /union=\{sessionsUnionFor\} onPickServer=\{pickServerPane\} foreignInline=\{layout\.isTouchDevice && narrowVp\}/u);
  assert.match(app, /class:side-sheet=\{layout\.isTouchDevice && narrowVp\}/u, 'the same condition as the sheet itself');
  // #371: the rows are DRAWN by the host (the pick action is Sessions s) but
  // PLACED by Projects, among this server s rows, by the one comparator. #357
  // appended them after the whole project list, past the fold of a long one.
  const projects = source.slice(source.indexOf('<Projects'), source.indexOf('Creating a project is the same ROW'));
  assert.match(projects, /foreign=\{foreignInline && foreign && !isSearching && union \? \{ rows: foreign\.rows, order: union\.included\.map\(\(s\) => s\.id\), clock: foreignClock \} : null\}/u, 'handed to Projects, only on the phone, never while searching');
  assert.match(projects, /foreignRow=\{foreignRowView\}/u);
  const row = source.slice(source.indexOf('{#snippet foreignRowView'), source.indexOf('{/snippet}', source.indexOf('{#snippet foreignRowView')));
  assert.ok(row.length > 0, 'the foreign row snippet exists');
  assert.match(row, /class="side-row proj-row foreign"/u);
  assert.match(row, /\{#if f\.tag\}<span class="p-source"><ServerTag name=\{f\.tag\} \/><\/span>\{\/if\}/u, 'the tag on its own second line (#360)');
  assert.match(row, /onPickServer\?\.\(f\.ref\); onPick\?\.\(\);/u, 'the same pick as the grouped rows: focus + open there, close the sheet');
  // Nothing draws the foreign rows beside Projects any more: the only
  // `foreign.rows` loop left is the DESKTOP group below.
  assert.equal(source.match(/\{#each foreign\.rows/gu)?.length, 1, 'one loop over foreign.rows: the desktop group');
  assert.ok(source.indexOf('{#each foreign.rows') > source.indexOf('<Projects'), 'and it is below the list, as the desktop group is');
  assert.match(source, /\{#if !foreignInline && foreign && !isSearching && \(foreign\.rows\.length \|\| foreign\.missing\.length\)\}/u, 'phone: the section is gone, desktop: unchanged');
  // A server that has not published is a STATUS, named above the list.
  assert.ok(source.indexOf('class="side-row proj-row missing"') < source.indexOf('<Projects'), 'missing rows sit above the list: a status is not ranked');
});

test('a foreign row shows the project NAME and takes its CLOCK from the HOST s map, keyed by server + session; Sessions imports nothing of the Hub (#357, #371)', async () => {
  assert.match(source, /foreignProjects = null/u);
  assert.match(source, /const foreignClock = \(serverId: string, session: string\) => foreignProjects\?\.get\(clockKey\(serverId, session\)\) \?\? null;/u, 'keyed by server AND session; absent → null');
  assert.match(source, /const foreignName = \(r: \{ serverId: string; item: \{ name: string \} \}\) => foreignClock\(r\.serverId, r\.item\.name\)\?\.name \|\| r\.item\.name;/u, 'absent → the session name');
  assert.equal(source.match(/\{foreignName\(r\)\}/gu)?.length, 1, 'the grouped (desktop) row shows it; the inline row s name comes from the merge');
  assert.doesNotMatch(source, /hub-union|HubUnion|createHubUnion|projectNames/u, 'the derivation is the host s');
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /const projectClocks = \$derived\.by\(\(\) => \{[\s\S]*?hubUnion\.rows\(tagScope\.included\)\.rows[\s\S]*?clocks\.set\(clockKey\(r\.serverId, r\.item\.project\.session\), \{ name: r\.item\.project\.name, row: r\.item, talk: r\.slice\.talk \}\)/u, 'derived in App from the Hub union s already-published rows, each with ITS server s clock');
  assert.match(app, /foreignProjects=\{projectClocks\}/u);
  // The empty hint is about THIS server when another server s rows are listed.
  assert.match(source, /\{foreign && foreign\.rows\.length \? t\('noSessionsHere'\) : t\('noSessions'\)\}/u);
});
