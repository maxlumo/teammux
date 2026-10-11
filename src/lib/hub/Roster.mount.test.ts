import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// #266: expanding is only meaningful when the single row overflows. jsdom has
// no layout, so the strip's widths are supplied: `.cards` is 300px wide and
// its single row needs `rowWidth` px — but only in the single-row form, as a
// browser reports once the wrapped class is lifted.
const compiled = compileMount(new URL('./Roster.svelte', import.meta.url), [], { serverScope: true });

const agent = (name: string) => ({ name, window: 1, managed: true, agent: 'kiro', state: 'idle', since: 10 });

async function strip(context: test.TestContext, names: string[], rowWidth: number) {
  const agents = names.map(agent);
  return (await compiled).mount(context, {
    props: {
      selected: 'room', roomReady: true, managedAgents: agents, managedNames: names,
      recipient: names[0], expanded: true, selectedRow: { project: { path: '/room' }, slots: [] },
    },
    modules: [],
    setup(win) {
      const width = (el: Element, single: number, wrapped: number) =>
        el.classList.contains('cards') ? (el.classList.contains('expanded') ? wrapped : single) : 0;
      Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get() { return width(this, 300, 300); } });
      Object.defineProperty(win.HTMLElement.prototype, 'scrollWidth', { get() { return width(this, rowWidth, 300); } });
    },
  });
}

test('a room whose cards fit keeps the lit tab and offers no chevron, whatever the pref says (#266)', async (context) => {
  const app = await strip(context, ['kiro'], 120);
  try {
    const cards = app.document.querySelector('.cards')!;
    assert.equal(cards.classList.contains('expanded'), false, 'the remembered expanded pref does not wrap a row that fits');
    assert.equal(app.document.querySelector('.roster-toggle'), null, 'nothing to expand: no chevron');
    assert.ok(app.document.querySelector('.slide-pill.tab .tab-shape'), 'the one-path lit tab (with its feet) marks the card');
    assert.equal(app.document.querySelector('.ctx-value'), null);
  } finally { await app.close(); }
});

test('an overflowing room still expands under the kept pref and offers the chevron (#266)', async (context) => {
  const app = await strip(context, ['a', 'b', 'c', 'd', 'e', 'f'], 640);
  try {
    const cards = app.document.querySelector('.cards')!;
    assert.equal(cards.classList.contains('expanded'), true);
    assert.equal(app.document.querySelector('.roster-toggle button')?.getAttribute('aria-expanded'), 'true');
    assert.equal(app.document.querySelector('.slide-pill.tab'), null, 'the wrapped list keeps its closed boxes');
  } finally { await app.close(); }
});
