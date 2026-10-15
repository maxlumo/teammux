// CSS contract for the PWA install banner (board #387, found by the validator
// in #381). At interface scale 150-180%, and in the viewports browser zoom
// 200% leaves, the banner squeezed its text to one word per line, pushed its
// actions 22-36 px past the window's edge and sat on Connect / Share. jsdom has
// no layout engine, so the geometry is measured in Chromium (the matrix on the
// issue); this pins the rules that geometry rests on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (rel: string) => readFile(new URL(rel, import.meta.url), 'utf8');
const rule = (source: string, selector: string) =>
  source.slice(source.indexOf('<style>')).match(new RegExp(`\\n  ${selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} \\{([^}]*)\\}`, 'u'))?.[1] ?? '';

test('the banner fits the window: its width comes from the viewport and its content wraps inside it (#387)', async () => {
  const source = await read('./InstallPrompt.svelte');
  const banner = rule(source, '.install-banner');
  assert.match(banner, /width: min\(440px, calc\(100vw \/ var\(--ui-zoom, 1\) - 24px\)\);/u, 'never wider than the window, at any interface scale');
  assert.match(banner, /box-sizing: border-box;/u, 'the padding is inside that width');
  assert.match(banner, /flex-wrap: wrap;/u, 'a narrow banner wraps instead of pushing its actions out');
  const body = rule(source, '.install-body');
  assert.match(body, /flex: 1 1 0;/u, 'the text takes the room left beside the icon');
  assert.match(body, /min-width: 9em;/u, 'and keeps a readable measure: below it the actions move to their own line');
  assert.match(rule(source, '.install-actions'), /margin-left: auto;/u, 'wrapped actions stay at the end');
});

test('the space the banner takes is MEASURED and published while it shows, and the connect page stops above it (#387)', async () => {
  const source = await read('./InstallPrompt.svelte');
  // No pixel constant stands for the banner's height: it is read from its box.
  assert.match(source, /root\.style\.setProperty\('--install-reserve', `\$\{el\.offsetHeight \+ below\}px`\)/u);
  assert.match(source, /new ResizeObserver\(publish\)/u, 're-read when the banner reflows');
  assert.match(source, /root\.style\.removeProperty\('--install-reserve'\)/u, 'and removed with the banner');
  assert.doesNotMatch(source, /--install-reserve:\s*\d/u, 'never a literal');
  const settings = await read('../app/Settings.svelte');
  assert.match(rule(settings, '.wrapper'), /margin-bottom: var\(--install-reserve, 0px\);/u, 'the connect page scroller ends above the banner');
});
