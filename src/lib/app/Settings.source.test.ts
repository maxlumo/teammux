// CSS contract for the connect page (board #381, owner: "我页面缩放的话首页登录
// 页面好像超出页面了"). Its page layer and every ancestor clip, so a card taller
// than the window (the interface zoomed, a short window, a phone with the
// keyboard up) has only one way to stay reachable: the page scrolls itself.
// jsdom has no layout engine, so the geometry is proved in Chromium (the zoom
// matrix on the issue); this pins the two rules that geometry rests on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Settings.svelte', import.meta.url), 'utf8');
const style = source.slice(source.indexOf('<style>'));
const rule = (selector: string) => style.match(new RegExp(`\\n  \\${selector} \\{([^}]*)\\}`, 'u'))?.[1] ?? '';

test('the connect page is its own vertical scroller and never scrolls sideways (#381)', () => {
  const wrapper = rule('.wrapper');
  assert.ok(wrapper, 'the .wrapper rule exists');
  assert.match(wrapper, /flex: 1;/u, 'it fills the page layer');
  // A flex item's min-height defaults to its content, so without this the
  // wrapper grows with the card and overflow-y never has anything to scroll.
  assert.match(wrapper, /min-height: 0;/u, 'it may shrink below the card');
  assert.match(wrapper, /overflow-y: auto;/u, 'the card scrolls inside the window');
  assert.match(wrapper, /overflow-x: hidden;/u, 'no sideways scroll');
});

test('the card centres with auto margins, never align-items: center (#381)', () => {
  // Centring with align-items / justify-content keeps centring an item that
  // is taller than its scroller, so its top lands ABOVE the scroll origin,
  // where no scroll reaches. Auto margins collapse to zero instead: the card
  // starts at the top and the rest scrolls into view.
  const wrapper = rule('.wrapper');
  assert.doesNotMatch(wrapper, /align-items: center|justify-content: center|place-items|place-content/u, 'no centring on the scroller');
  assert.match(rule('.card'), /margin: auto;/u, 'the card centres itself');
});
