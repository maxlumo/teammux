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

test('the phone s session sheet is ONE list: foreign rows inline, the grouped section desktop-only; "phone" is the host s (#357)', async () => {
  // The component never decides what a phone is: the host passes the sheet s
  // own condition (App: isTouchDevice && narrowVp, the same as `.side-sheet`).
  assert.match(source, /onPickServer = null, foreignInline = false/u);
  assert.doesNotMatch(source, /foreignInline = \$derived|const foreignInline/u, 'no second definition of "phone" in the component');
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /union=\{sessionsUnionFor\} onPickServer=\{pickServerPane\} foreignInline=\{layout\.isTouchDevice && narrowVp\}/u);
  assert.match(app, /class:side-sheet=\{layout\.isTouchDevice && narrowVp\}/u, 'the same condition as the sheet itself');
  // Inline rows: the sidebar row dress, the tag on the second line, under the
  // Projects section; the grouped section is the other branch of the same flag.
  const inline = source.slice(source.indexOf('{#if foreignInline && foreign && !isSearching}'), source.indexOf('Creating a project is the same ROW'));
  assert.ok(inline.length > 0, 'the inline branch exists');
  assert.match(inline, /class="side-row proj-row foreign"/u);
  assert.match(inline, /\{#if r\.tag\}<span class="p-source"><ServerTag name=\{r\.tag\} \/><\/span>\{\/if\}/u);
  assert.match(inline, /onPickServer\?\.\(r\.ref\); onPick\?\.\(\);/u, 'the same pick as the grouped rows: focus + open there, close the sheet');
  assert.ok(source.indexOf('<Projects') < source.indexOf('{#if foreignInline && foreign && !isSearching}'), 'the inline rows follow this server s Projects section');
  assert.match(source, /\{#if !foreignInline && foreign && !isSearching && \(foreign\.rows\.length \|\| foreign\.missing\.length\)\}/u, 'phone: the section is gone, desktop: unchanged');
});

test('a foreign row shows the project NAME from the HOST s map, keyed by server + session; Sessions imports nothing of the Hub (#357)', async () => {
  assert.match(source, /foreignNames = null/u);
  assert.match(source, /const foreignName = \(r: \{ serverId: string; item: \{ name: string \} \}\) => foreignNames\?\.get\(`\$\{r\.serverId\}\\u0000\$\{r\.item\.name\}`\) \|\| r\.item\.name;/u, 'keyed by server AND session; absent → the session name');
  assert.equal(source.match(/\{foreignName\(r\)\}/gu)?.length, 2, 'the inline row and the grouped row both show it');
  assert.doesNotMatch(source, /hub-union|HubUnion|createHubUnion|projectNames/u, 'the derivation is the host s');
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /const projectNames = \$derived\.by\(\(\) => \{[\s\S]*?hubUnion\.rows\(tagScope\.included\)\.rows[\s\S]*?names\.set\(`\$\{r\.serverId\}\\u0000\$\{r\.item\.project\.session\}`, r\.item\.project\.name\)/u, 'derived in App from the Hub union s already-published rows');
  assert.match(app, /foreignNames=\{projectNames\}/u);
  // The empty hint is about THIS server when another server s rows are listed.
  assert.match(source, /\{foreign && foreign\.rows\.length \? t\('noSessionsHere'\) : t\('noSessions'\)\}/u);
});
