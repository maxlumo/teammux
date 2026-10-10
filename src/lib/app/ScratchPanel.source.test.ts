// Board #324 source contract: the scratch panel reuses the one Terminal and
// the one resize handle, slides on the shared tempo, owns no Escape inside
// the terminal, and App mounts it inside the server key, desktop only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ScratchPanel.svelte', import.meta.url), 'utf8');
const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');

test('the shared Terminal and SideHandle, one slide tempo, no backdrop', () => {
  assert.match(source, /import Terminal from '\.\.\/terminal\/Terminal\.svelte';/u);
  assert.match(source, /<Terminal \{target\} \{session\} \{fontSize\} embedded chromeless active=\{open\} visible=\{open\} onPaneExit=\{ended\} \/>/u);
  assert.match(source, /<SideHandle varName="--scratch-h"[^>]*edge="top"[^>]*always \/>/u);
  // Docked RIGHT since #326, so the grab edge is the panel's LEFT side.
  assert.match(source, /<SideHandle varName="--scratch-w"[^>]*edge="left"[^>]*always \/>/u);
  const css = (/<style>[\s\S]*<\/style>/u.exec(source)?.[0] ?? '').replace(/\/\*[\s\S]*?\*\//gu, '');
  assert.match(css, /transition: transform var\(--t-move\) ease/u);
  assert.doesNotMatch(css, /\d+ms|scrim|backdrop/u, 'no private tempo, no backdrop');
});

test('Escape closes from the head only; the terminal keeps it', () => {
  assert.match(source, /<header class="scratch-head" onkeydown=\{onHeadKey\}/u);
  assert.doesNotMatch(source, /window\.addEventListener\('keydown'|<section[^>]*onkeydown/u, 'no Escape catcher over the terminal');
});

test('App: desktop only, inside the server scope, closed when a switch starts; the toggle is a registry shortcut', async () => {
  // Inside the PROVIDER, not merely inside the key (board #335 ②b-1): the
  // panel's Terminal has to be bound to the same server as the pages, and a
  // panel mounted beside `<ServerScope>` would keep answering from the facade.
  const keyed = app.slice(app.indexOf('{#key scopeRuntime}'), app.indexOf('</ServerScope>'));
  assert.match(keyed, /\{#if !layout\.isTouchDevice && connected\}\s*<ScratchPanel open=\{scratchOpen\} live=\{!switching\}/u);
  assert.match(app, /\$effect\(\(\) => \{ if \(switching\) scratchOpen = false; \}\);/u);
  // The reset's own ORDER is not this pin's subject (since #335 ②b-1 it gives
  // up the server handle's lease first); that the panel closes there is.
  assert.match(app, /function resetServerMemory\(\) \{[\s\S]{0,400}?scratchOpen = false;/u);
  assert.match(app, /toggleScratch\(\) \{ scratchOpen = !scratchOpen; \},/u);
  const shortcuts = await readFile(new URL('./shortcuts.ts', import.meta.url), 'utf8');
  assert.match(shortcuts, /\{ id: 'toggleScratch', label: 'shortcutToggleScratch', group: 'panels', default: 'Mod2\+Backquote'/u);
});

test('the scratch RPCs are desktop-gated like projects (#324 review): a phone build never names the module', async () => {
  const rpc = await readFile(new URL('../../../src-tauri/src/server/rpc.rs', import.meta.url), 'utf8');
  for (const m of ['scratch_session', 'scratch_kill']) {
    assert.match(rpc, new RegExp(`#\\[cfg\\(not\\(any\\(target_os = "android", target_os = "ios"\\)\\)\\)\\]\\n\\s*"${m}" =>`, 'u'), `${m} carries the projects gate`);
  }
});

test('the panel size is clamped by the layout itself, on restore and as the window shrinks (#324 review)', () => {
  // Measured in Chromium: h=1200 / w=1400 restored into 900x600 and then
  // 700x420 keeps the head and the handle on screen for both edges
  // (temp/check/c324clamp.mjs); ResizeObserver refits the terminal, no timer.
  assert.match(source, /height: min\(var\(--scratch-h, 320px\), calc\(100vh \/ var\(--ui-zoom, 1\) - 80px\)\);/u);
  assert.match(source, /width: min\(var\(--scratch-w, 560px\), calc\(100vw \/ var\(--ui-zoom, 1\) - var\(--shell-left, 0px\) - 80px\)\);/u);
  assert.match(source, /<Terminal \{target\} \{session\}/u, 'the server\'s returned session name, never spelled here');
  assert.doesNotMatch(source, /setTimeout|setInterval/u, 'no timed resize');
});

test('the side-docked panel starts under the Android status bar (#332)', () => {
  // The vertical dock moved from the left edge to the right (#326); it is
  // still fixed, so it still adds the status-bar inset itself. (The popover
  // top-inset gap #332 recorded is a separate, still-open item.)
  const right = source.match(/\.scratch\.right \{([^}]*)\}/u)?.[1] ?? '';
  assert.match(right, /left: auto; top: var\(--sat, 0px\); height: auto;/u, 'fixed, so it carries --sat itself');
  assert.match(right, /border-left: 1px solid var\(--border\)/u, 'the border faces the content it covers');
  assert.match(right, /transform: translateX\(100%\)/u, 'and it rests off the RIGHT edge');
  assert.doesNotMatch(source, /\.scratch\.left|scratchLeft/u, 'the left dock is gone, not kept beside it');
});

test('the edge is two icons, bottom | right, with their words as accessible names (#326)', () => {
  // Owner, 2026-10-09: "上面的按钮不用写'bottom'之类的文字了 你用两个小图标去
  // 做状态切换" — the ONE Segmented control, in its icon mode, not two
  // hand-rolled buttons.
  assert.match(source, /<Segmented options=\{\[\{ value: 'bottom', label: t\('scratchBottom'\), icon: 'panel-bottom' \}, \{ value: 'right', label: t\('scratchRight'\), icon: 'panel-right' \}\]\}/u);
  assert.match(source, /value=\{edge\} onchange=\{\(v\) => onedge\(v\)\} ariaLabel=\{t\('scratchEdge'\)\}/u);
});

test('opening converges on a live session, from every state the panel knows (#326)', () => {
  // The owner kept opening the panel on nothing: a hidden Terminal stays
  // subscribed, so a session that ended behind the panel's back delivered
  // pane_closed while it was CLOSED, and the open effect only re-ensured from
  // idle|error — leaving the bare "Session ended" line.
  assert.match(source, /if \(phase === 'ready'\) void focusTerminal\(intent\);\s*\n\s*else void ensure\(\);/u,
    'ready focuses what it has; every other state ensures');
  // The retry-loop guard it must not lose: the effect still tracks `open` and
  // `live` only, so no ANSWER can trigger the next ensure.
  assert.match(source, /\$effect\(\(\) => \{\s*\n\s*if \(!live\) \{ intent\+\+; return; \}\s*\n\s*if \(open\) untrack\(\(\) => \{/u);
});
