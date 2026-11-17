import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Board #109 (validator S3, T1): two contracts of the view, pinned in its source.
const src = readFileSync(new URL('./Dashboard.svelte', import.meta.url), 'utf8');
const style = src.slice(src.indexOf('<style>')).replace(/\/\*[\s\S]*?\*\//gu, '');

test('the Dashboard positions the shared .side-win atoms and never restyles them (design-language § 2, #109 T1)', () => {
  assert.doesNotMatch(style, /\.side-win-name[^{]*\{/u, 'no scoped rule on .side-win-name: its variants live in app.css');
  assert.doesNotMatch(style, /\.side-win-dot[^{]*\{/u);
  assert.match(src, /class="side-win-name whole"/u, 'the row s name wears the atom s named variant');
  assert.match(readFileSync(new URL('../../app.css', import.meta.url), 'utf8'), /\.side-win \.side-win-name\.whole \{ max-width: none; \}/u);
});

test('every tappable element of the view is a control-height target (44px on touch, #109 S3)', () => {
  const tappable = [...src.matchAll(/<(button|summary)\b([^>]*)>/gu)].map((m) => /class="([^" ]*)/u.exec(m[2]!)?.[1] ?? m[1]!);
  // #150 adds the doors that were text (an ask line, the oldest doing, a finished issue) and the fold line.
  assert.deepEqual([...new Set(tappable)].sort(), ['dash-agent', 'dash-door', 'dash-fold-line', 'dash-line', 'dash-more', 'dash-note-row', 'summary']);
  const rule = (sel: string) => [...style.matchAll(/([^{}]+)\{([^}]*)\}/gu)].filter((m) => m[1]!.split(',').some((s) => s.trim() === sel)).map((m) => m[2]).join(';');
  for (const sel of ['.dash-line', '.dash-agent', '.dash-note-row', '.dash-more', '.dash-finished > summary', '.dash-door', '.dash-block > summary']) {
    assert.match(rule(sel), /min-height: var\(--control-height\)/u, `${sel} has the control height`);
  }
});

test('an age is its own .side-age element, never inside the words that elide (#109 S5)', () => {
  assert.equal([...src.matchAll(/<span class="side-age">\{agoShort\(/gu)].length, 3, 'status, note and finished ages');
  for (const words of ['dash-status-text', 'dash-done-text', 'dash-text']) {
    assert.doesNotMatch(src, new RegExp(`class="${words}">[^<]*agoShort`, 'u'), `${words} carries no age`);
  }
});

// Board #147 (leader note 3, condition 1): the Dashboard lays out by the width it HAS, the
// Board's `board` container (the tab beside its project list, or the Hub drawer), never by
// the viewport; 760 stays the design language's one compact breakpoint.
test('the Dashboard\u2019s narrow form follows its container, at the one 760 breakpoint (#147)', async () => {
  const { readFile } = await import('node:fs/promises');
  const dash = await readFile(new URL('./Dashboard.svelte', import.meta.url), 'utf8');
  assert.match(dash, /@container board \(max-width: 760px\) \{\s*\.dash-note-row \{ flex-wrap: wrap;/u);
  assert.doesNotMatch(dash, /@media/u, 'no viewport query left in the Dashboard');
});
