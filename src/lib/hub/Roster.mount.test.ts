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

// Board #384: a card dragged onto a team asks Hub to move it there. jsdom has
// no layout, so each drop target's box is supplied by its `data-drop` key
// ('-' = standalone): one row, squad | standalone | ops.
const BOXES: Record<string, [number, number]> = { squad: [0, 200], '-': [210, 300], ops: [310, 420] };
async function dragStrip(context: test.TestContext, agents: Record<string, unknown>[], canMove = true, strip: [number, number] = [0, 1000]) {
  const moves: [string, string][] = [];
  const scopes: unknown[] = [];
  const picks: string[] = [];
  const names = agents.map((a) => String(a.name));
  const app = await (await compiled).mount(context, {
    props: {
      selected: 'room', roomReady: true, managedAgents: agents, managedNames: names,
      recipient: names[0], selectedRow: { project: { path: '/room' }, slots: [] },
      moveScope: { session: 'room', epoch: 0, ok: canMove },
      onmove: (name: string, team: string, scope: unknown) => { moves.push([name, team]); scopes.push(scope); },
      onselect: (name: string) => { picks.push(name); },
    },
    modules: [],
    setup(win) {
      win.Element.prototype.getAnimations = () => [];
      // The boxes appear with the drag's `data-drop`, which flip reads as a
      // move; jsdom has no Web Animations, and the motion is not under test.
      win.Element.prototype.animate = function () { return { cancel() {}, finish() {}, onfinish: null, finished: Promise.resolve() } as unknown as Animation; };
      win.HTMLElement.prototype.getBoundingClientRect = function () {
        // The strip's own visible box; every target is clipped to it.
        const box = (this as HTMLElement).classList.contains('cards') ? strip : BOXES[(this as HTMLElement).dataset.drop ?? ''];
        const [left, right] = box ?? [0, 0];
        return { left, right, top: 0, bottom: box ? 60 : 0, width: right - left, height: box ? 60 : 0, x: left, y: 0, toJSON() {} } as DOMRect;
      };
    },
  });
  const card = (name: string) => app.document.querySelector<HTMLElement>(`.acard[data-agent="${name}"] .agent-select`)!;
  const at = (type: string, el: Element, x: number, y = 30) => el.dispatchEvent(new app.window.PointerEvent(type,
    { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1, clientX: x, clientY: y }));
  return { app, moves, scopes, picks, card, at };
}
const member = (name: string, team: string | null, joined = false) =>
  ({ ...agent(name), team, joined });

test('a card dropped on another team asks to move it there; the click after the drag is no pick (#384)', async (context) => {
  const { app, moves, picks, card, at } = await dragStrip(context, [member('lead', 'squad'), member('solo', null), member('ops1', 'ops')]);
  try {
    const solo = card('solo');
    // A press that never became a drag is over at its release: a later hover
    // move across the strip (no button held) must not lift the card.
    at('pointerdown', solo, 250);
    at('pointerup', solo, 250);
    at('pointermove', app.document.querySelector('.cards')!, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'a click is not left armed');
    at('pointerdown', solo, 250);
    at('pointermove', solo, 250 - 5);
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'below the threshold it is still a click');
    at('pointermove', solo, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted')?.getAttribute('data-agent'), 'solo', 'past it the card is carried');
    assert.ok(app.document.querySelector('.cards.reordering'));
    at('pointermove', solo, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.roster-cluster.drop-target')?.getAttribute('data-drop'), 'squad', 'the team under the pointer is the target, though one live member draws it as a plain card');
    assert.equal(app.document.querySelector('.standalone-slot'), null, 'a standalone card is offered no standalone slot');
    at('pointerup', solo, 100);
    solo.click();
    await app.flush();
    assert.deepEqual(moves, [['solo', 'squad']]);
    assert.deepEqual(picks, [], 'the release is not also a pick');
    assert.equal(app.document.querySelector('.acard.lifted'), null);
    assert.equal(app.document.querySelector('[data-drop]'), null, 'the targets are marked only while carrying');
  } finally { await app.close(); }
});

test('a card in a team carried with no standalone card shown gets the temporary slot; Escape abandons (#384)', async (context) => {
  const { app, moves, card, at } = await dragStrip(context, [member('lead', 'squad'), member('helper', 'squad', true), member('ops1', 'ops')]);
  try {
    const helper = card('helper');
    at('pointerdown', helper, 50);
    at('pointermove', helper, 250);
    await app.flush();
    assert.ok(app.document.querySelector('.standalone-slot'), 'the slot appears with the drag');
    at('pointermove', helper, 250);
    await app.flush();
    assert.ok(app.document.querySelector('.standalone-slot.drop-target'), 'and is measured as a target once it is in');
    at('pointermove', helper, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.drop-target'), null, 'its own team is not a target');
    app.window.dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await app.flush();
    assert.equal(app.document.querySelector('.standalone-slot'), null, 'Escape abandons: the slot goes');
    at('pointerup', helper, 250);
    assert.deepEqual(moves, [], 'nothing moved');

    at('pointerdown', helper, 50);
    at('pointermove', helper, 250);
    await app.flush();
    at('pointermove', helper, 250);
    await app.flush();
    at('pointerup', helper, 250);
    await app.flush();
    assert.deepEqual(moves, [['helper', '']], 'a drop on the slot is leave = ""');
  } finally { await app.close(); }
});

test('a server that cannot move an agent carries no card, and a click stays a click (#384)', async (context) => {
  const { app, moves, picks, card, at } = await dragStrip(context, [member('lead', 'squad'), member('solo', null)], false);
  try {
    const solo = card('solo');
    at('pointerdown', solo, 250);
    at('pointermove', solo, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted'), null);
    at('pointerup', solo, 100);
    solo.click();
    await app.flush();
    assert.deepEqual(moves, []);
    assert.deepEqual(picks, ['solo'], 'no drag ran, so its click guard is not armed');
  } finally { await app.close(); }
});

test('a drag belongs to the context it was pressed in: a new one cancels it, and a press from the old one moves nothing (#384, P1-A)', async (context) => {
  const { app, moves, scopes, card, at } = await dragStrip(context, [member('lead', 'squad'), member('solo', null), member('ops1', 'ops')]);
  // Scopes are made in the CLIENT realm, as Hub's are: Svelte proxies only
  // its own realm's plain objects, and a scope kept in $state would then
  // never be === the current one (the trap the first cut fell into).
  const scope = (session: string, n: number, ok = true) => app.window.JSON.parse(JSON.stringify({ session, n, ok }));
  try {
    const solo = card('solo');
    const pressed = scope('room', 0);
    await app.setProps({ moveScope: pressed });
    at('pointerdown', solo, 250);
    at('pointermove', solo, 100);
    await app.flush();
    at('pointermove', solo, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.roster-cluster.drop-target')?.getAttribute('data-drop'), 'squad', 'carried, with a target');
    // Another project is selected and back again (A -> B -> A): a NEW scope
    // object each time, so the old gesture is gone, not revived.
    await app.setProps({ moveScope: scope('other', 1) });
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'a new context cancels the drag at once');
    await app.setProps({ moveScope: scope('room', 2) });
    at('pointermove', solo, 100);
    app.window.dispatchEvent(new app.window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse', pointerId: 1, clientX: 100, clientY: 30 }));
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'and the old press is not revived by the next move');
    assert.deepEqual(moves, [], 'the window release after the switch moves nothing');

    // A press made in one context and dragged after it changed starts nothing.
    at('pointerdown', solo, 250);
    await app.setProps({ moveScope: scope('room', 3) });
    at('pointermove', solo, 100);
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'a press from an old context is not a drag');
    at('pointerup', solo, 100);

    // The commit holds on its own, before the cancel can run: a drag carried
    // over a target, then a context change and the release in ONE task (the
    // cancel effect runs later). Effects and render flush together, so a press
    // that outlives a change is cancelled before any target can be measured:
    // that order needs no test of its own (capturing the scope at the press
    // is pinned in Roster.source).
    await app.setProps({ moveScope: scope('room', 7) });
    at('pointerdown', solo, 250);
    for (const x of [100, 100]) { at('pointermove', solo, x); await app.flush(); }
    void app.setProps({ moveScope: scope('room', 8) });
    at('pointerup', solo, 100);
    await app.flush();
    assert.deepEqual(moves, [], 'the commit refuses a drag of an older context');

    // The page hidden (or the cap lost) mid-drag: ok goes false, the drag ends.
    const now = scope('room', 3);
    await app.setProps({ moveScope: now });
    at('pointerdown', solo, 250);
    for (const x of [100, 100]) { at('pointermove', solo, x); await app.flush(); }
    assert.ok(app.document.querySelector('.acard.lifted'));
    await app.setProps({ moveScope: scope('room', 3, false) });
    app.window.dispatchEvent(new app.window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse', pointerId: 1, clientX: 100, clientY: 30 }));
    await app.flush();
    assert.deepEqual(moves, [], 'nothing moves from a hidden page or a server that lost the cap');

    // In a steady context the move goes, and hands over the scope it was pressed in.
    const steady = scope('room', 4);
    await app.setProps({ moveScope: steady });
    at('pointerdown', solo, 250);
    for (const x of [100, 100]) { at('pointermove', solo, x); await app.flush(); }
    at('pointerup', solo, 100);
    await app.flush();
    assert.deepEqual(moves, [['solo', 'squad']]);
    assert.equal(scopes[0], steady, 'the scope of the press');
  } finally { await app.close(); }
});

test('a drop target is the part of a group the strip shows: one scrolled or clipped out is no target, and a scroll ends the drag (#384, P2-2)', async (context) => {
  // The strip shows 0..300: squad whole, the standalone group whole, ops
  // (310..420) not at all.
  const { app, moves, card, at } = await dragStrip(context, [member('lead', 'squad'), member('solo', null), member('ops1', 'ops')], true, [0, 300]);
  try {
    const solo = card('solo');
    at('pointerdown', solo, 250);
    for (const x of [360, 360]) { at('pointermove', solo, x); await app.flush(); }
    assert.equal(app.document.querySelector('.drop-target'), null, 'over ops, outside the strip: no target');
    at('pointerup', solo, 360);
    await app.flush();
    assert.deepEqual(moves, [], 'and no move');

    at('pointerdown', solo, 250);
    for (const x of [100, 100]) { at('pointermove', solo, x); await app.flush(); }
    assert.equal(app.document.querySelector('.drop-target')?.getAttribute('data-drop'), 'squad');
    app.document.querySelector('.cards')!.dispatchEvent(new app.window.Event('scroll'));
    await app.flush();
    assert.equal(app.document.querySelector('.acard.lifted'), null, 'the strip scrolled: the geometry is stale, the drag ends');
    at('pointerup', solo, 100);
    await app.flush();
    assert.deepEqual(moves, [], 'nothing moves');

    at('pointerdown', solo, 250);
    for (const x of [100, 100]) { at('pointermove', solo, x); await app.flush(); }
    at('pointerup', solo, 100);
    await app.flush();
    assert.deepEqual(moves, [['solo', 'squad']], 'a visible target still takes the drop');
  } finally { await app.close(); }
});

test('a roster change mid-drag measures the targets again (#384, P2-2)', async (context) => {
  const agents = [member('lead', 'squad'), member('solo', null), member('ops1', 'ops')];
  const { app, moves, card, at } = await dragStrip(context, agents);
  try {
    const solo = card('solo');
    at('pointerdown', solo, 250);
    for (const x of [365, 365]) { at('pointermove', solo, x); await app.flush(); }
    assert.equal(app.document.querySelector('.drop-target')?.getAttribute('data-drop'), 'ops');
    // ops moves (a member arrives and the layout shifts): its box is now
    // 430..540, so the point it was under is empty strip.
    BOXES.ops = [430, 540];
    await app.setProps({ managedAgents: [...agents, member('ops2', 'ops')] });
    at('pointermove', solo, 365);
    await app.flush();
    assert.equal(app.document.querySelector('.drop-target'), null, 're-measured: no stale target');
    at('pointerup', solo, 365);
    await app.flush();
    assert.deepEqual(moves, [], 'no move to where ops used to be');
  } finally { BOXES.ops = [310, 420]; await app.close(); }
});
