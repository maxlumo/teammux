import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./App.svelte', import.meta.url), 'utf8');
const picker = source.slice(source.indexOf('{#if serverMenuOpen}'), source.indexOf('<!-- Forgetting a saved server'));

test('both server doors describe the same non-modal picker, not an action menu (#165)', async () => {
  const prefs = await readFile(new URL('./lib/app/Preferences.svelte', import.meta.url), 'utf8');
  assert.match(picker, /role="dialog" aria-modal="false" aria-label=\{t\('serversTitle'\)\}/u);
  assert.match(picker, /id=\{serverPickerId\}/u);
  assert.doesNotMatch(picker, /role="menu"|role="menuitem"/u);
  assert.match(source, /aria-haspopup="dialog"\s+aria-expanded=\{serverMenuOpen\}\s+aria-controls=\{serverMenuOpen \? serverPickerId : undefined\}/u);
  assert.match(source, /serversControls=\{serverPickerId\}/u);
  assert.match(prefs, /aria-haspopup="dialog"/u);
  assert.match(prefs, /aria-controls=\{serversOpen \? serversControls : undefined\}/u);
});

test('server picker owns border-box placement and a bounded native scroller (#165)', () => {
  assert.match(picker, /bind:this=\{serverMenuEl\}/u);
  assert.match(picker, /bind:offsetWidth=\{serverMenuW\} bind:offsetHeight=\{serverMenuH\}/u);
  assert.doesNotMatch(picker, /bind:clientWidth|bind:clientHeight/u);
  assert.match(source, /if \(serverMenuEl && e\.target instanceof Node && serverMenuEl\.contains\(e\.target\)\) return;/u);
  const effect = source.slice(source.indexOf('if (!serverMenuOpen'), source.indexOf('/** Switch:'));
  assert.match(effect, /addEventListener\('scroll', onScroll, true\)/u);
  assert.match(effect, /removeEventListener\('scroll', onScroll, true\)/u);
  assert.match(effect, /if \(!\(scroller instanceof Node\) \|\| !origin \|\| !scroller\.contains\(origin\)\) return;/u,
    'background terminal output is not movement of the picker opener');
  const panel = /\.server-menu \{([^}]+)\}/u.exec(source)?.[1] ?? '';
  assert.match(panel, /width: max-content/u);
  // Since #326 the viewport cap is joined by the ROOM menuPlacement found at
  // the position it returned: beside the rail a narrow window shrinks the
  // picker and scrolls it, instead of sliding it back over the rail.
  assert.match(panel, /max-height: min\(calc\(100vh \/ var\(--ui-zoom, 1\) - 16px\), var\(--pop-maxh, 100vh\)\)/u);
  assert.match(panel, /max-width: min\(320px, calc\(100vw \/ var\(--ui-zoom, 1\) - 16px\), var\(--pop-maxw, 100vw\)\)/u);
  assert.match(panel, /overflow-y: auto/u);
});

test('server picker keys yield to modals and composition, with a local rename cancellation (#165)', async () => {
  // The rename and its IME contract live in the ONE ServerList (board 315).
  const list = await readFile(new URL('./lib/app/ServerList.svelte', import.meta.url), 'utf8');
  assert.match(list, /oncompositionstart=\{compositionStart\}/u);
  assert.match(list, /oncompositionend=\{compositionEnd\}/u);
  assert.match(list, /export function finish\(close = false\): boolean \{\s*if \(composing\) \{\s*pending = \{ id: renaming, close: pending\?\.close \|\| close \};\s*return false;/u,
    'outside dismissal must wait for the native final composition value');
  assert.match(source, /function closeServerPicker\(\) \{\s*if \(serverListEl && !serverListEl\.finish\(true\)\) return;/u);
  const finish = list.slice(list.indexOf('async function compositionEnd'), list.indexOf('/** svelte action: focus'));
  assert.ok(finish.indexOf('await tick()') >= 0 && finish.indexOf('await tick()') < finish.indexOf('composing = null'),
    'blur cannot bypass composition ending while the final input is still pending');
  assert.match(finish, /draft = composition\.input\.value/u);
  assert.match(list, /onkeydown=\{key\}/u);
  assert.match(list, /function key\(e: KeyboardEvent\) \{\s*if \(e\.isComposing \|\| e\.keyCode === 229 \|\| composing\) return;/u);
  assert.match(list, /export function cancelRename/u);
  const effect = source.slice(source.indexOf('if (!serverMenuOpen'), source.indexOf('/** Switch:'));
  assert.match(effect, /serverListEl\?\.isComposing\(\)/u);
  assert.match(effect, /if \(!serverListEl\?\.cancelRename\(\)\) closeServerPicker\(\);/u);
  assert.match(effect, /activeModal\(document\)/u);
  assert.match(effect, /menu\.contains\(document\.activeElement\)/u);
  assert.match(effect, /menu\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(effect, /const onDown = \(e\) => \{\s*if \(modalOwnsInteraction\(\)\) return;/u);
  assert.match(effect, /const onScroll = \(e\) => \{\s*if \(modalOwnsInteraction\(\)\) return;/u,
    'clicking or scrolling a confirmation cannot dismiss its underlying picker');
});

test('app navigation shortcuts yield to focused menu and picker controls (#165)', async () => {
  const shortcuts = await readFile(new URL('./lib/app/shortcuts.svelte.ts', import.meta.url), 'utf8');
  const guard = shortcuts.slice(shortcuts.indexOf('export function isShortcutInputTarget'), shortcuts.indexOf('export const shortcuts'));
  assert.match(guard, /\[role="menu"\]/u);
  assert.match(guard, /\[role="dialog"\]/u);
});

test('the server picker opens ABOVE a phone sidebar sheet — the sheet s ScopeNote row is one of its doors (#364)', async () => {
  // Measured 2026-10-14 at 390 (touch): at z 24 the picker opened UNDER the
  // z 26 sheet whose foot row had opened it; elementFromPoint hit the sheet.
  const css = await readFile(new URL('./app.css', import.meta.url), 'utf8');
  const z = (re: RegExp, text: string) => Number(re.exec(text)?.[1] ?? NaN);
  const sheet = z(/\.side-sheet\.side-sheet\.side-sheet \{[^}]*z-index: (\d+)/u, css);
  const strip = z(/\.sys-sidebar \{[^}]*?z-index: (\d+)/u, source);
  const menu = z(/\.server-menu \{[^}]*z-index: (\d+)/u, source);
  assert.ok(Number.isFinite(sheet) && Number.isFinite(menu), `both layers declare a z: sheet ${sheet}, menu ${menu}`);
  assert.ok(menu > sheet && (!Number.isFinite(strip) || menu > strip), `picker ${menu} above the sheet ${sheet} and its status strip ${strip}`);
  assert.ok(menu < 60, 'and under the Dialog tier (60), so a rename confirm still covers it');
});
