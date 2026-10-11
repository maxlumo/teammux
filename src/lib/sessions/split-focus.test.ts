// Where "type in the terminal" lands (board 316 review P1), against the DOM
// SplitView renders (.cell[data-cell-id] + .active, xterm's helper textarea
// inside each cell). jsdom tracks focus, so the assertion is about the
// element keystrokes would go to. SplitView itself is not mounted here (its
// Terminals need xterm, which the mount tier cannot load); the source pins
// below tie this markup to SplitView and the call to App.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { terminalFocusTarget } from './split-focus.ts';

function page(cells: { id: number; pane: boolean; active?: boolean }[]) {
  const dom = new JSDOM(`<div class="term-page"><div class="term-main"><div class="split-grid">${cells.map((c) =>
    `<div class="cell${c.active ? ' active' : ''}" data-cell-id="${c.id}"><div class="cell-body">${c.pane
      ? `<div class="xterm"><textarea class="xterm-helper-textarea" data-cell="${c.id}"></textarea></div>`
      : '<button class="cell-empty">+</button>'}</div></div>`).join('')}</div></div></div>`);
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s.replace(/"/gu, '\\"') };
  return dom;
}

test('split screen: the ACTIVE cell takes the focus, never the first terminal', () => {
  const dom = page([{ id: 1, pane: true }, { id: 2, pane: true, active: true }]);
  const doc = dom.window.document;
  // Focus was elsewhere (the user clicked into cell 2, then into the Hub).
  doc.body.focus();
  terminalFocusTarget(doc.querySelector('.term-page'), 2)?.focus();
  assert.equal((doc.activeElement as HTMLElement).dataset.cell, '2', 'keystrokes go to cell 2');
  assert.notEqual((doc.activeElement as HTMLElement).dataset.cell, '1', 'cell 1 receives no key');
});

test('an active cell with no pane takes nothing; it never falls through to another cell', () => {
  const dom = page([{ id: 1, pane: true }, { id: 2, pane: false, active: true }]);
  assert.equal(terminalFocusTarget(dom.window.document.querySelector('.term-page'), 2), null);
});

test('single pane: the page’s one terminal', () => {
  const dom = page([{ id: 0, pane: true }]);
  const target = terminalFocusTarget(dom.window.document.querySelector('.term-page'), null);
  assert.equal(target?.dataset.cell, '0');
});

test('SplitView marks each cell with its id, and App passes the active id in split screen only', async () => {
  const split = await readFile(new URL('./SplitView.svelte', import.meta.url), 'utf8');
  assert.match(split, /class="cell"\s+data-cell-id=\{cell\.id\}\s+class:active=\{cell\.id === activeCellId\}/u);
  // ③a-4: a cell takes window input only when its tree is focused too.
  assert.match(split, /active=\{focused && cell\.id === activeCellId\}/u);
  const app = await readFile(new URL('../../App.svelte', import.meta.url), 'utf8');
  assert.match(app, /terminalFocusTarget\(termPageEl, splitActive \? view\.activeCellId : null\)\?\.focus\(\);/u);
  assert.match(app, /<SplitView [^\n]*\n[^\n]*visible=\{shown && page === 'terminal'\} focused=\{!held\}/u, 'and App says whether the tree is focused');
  assert.doesNotMatch(app, /querySelector\('\.term-page \.xterm-helper-textarea'\)/u, 'the first-terminal lookup is gone');
});
