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
  assert.deepEqual([...new Set(tappable)].sort(), ['dash-agent', 'dash-line', 'dash-more', 'dash-note-row', 'summary']);
  const rule = (sel: string) => [...style.matchAll(/([^{}]+)\{([^}]*)\}/gu)].filter((m) => m[1]!.split(',').some((s) => s.trim() === sel)).map((m) => m[2]).join(';');
  for (const sel of ['.dash-line', '.dash-agent', '.dash-note-row', '.dash-more', '.dash-finished > summary']) {
    assert.match(rule(sel), /min-height: var\(--control-height\)/u, `${sel} has the control height`);
  }
});

test('an age is its own .side-age element, never inside the words that elide (#109 S5)', () => {
  assert.equal([...src.matchAll(/<span class="side-age">\{agoShort\(/gu)].length, 3, 'status, note and finished ages');
  for (const words of ['dash-status-text', 'dash-done-text', 'dash-text']) {
    assert.doesNotMatch(src, new RegExp(`class="${words}">[^<]*agoShort`, 'u'), `${words} carries no age`);
  }
});
