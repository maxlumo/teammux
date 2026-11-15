// Board #132 (design record #131): the drawer goes beside the chat only when both fit, through
// the real Hub wiring (HubLayout in drawer-fit.svelte.ts). jsdom has no layout: a controllable
// ResizeObserver stands in for the Hub's width.
import assert from 'node:assert/strict';
import test from 'node:test';
import { compileMount } from '../test/mount.ts';

let compilation: ReturnType<typeof compileMount> | undefined;
const compiledHub = () => compilation ??= compileMount(new URL('./Hub.svelte', import.meta.url), [
  new URL('../core/ws.ts', import.meta.url),
], { serverScope: true });

function roomFixture() {
  return {
    rpc: {
      projectList: async () => ({ projects: [{ project: { id: 'fixture', name: 'Fixture', session: 'fixture', path: '/fixture' }, live: true, slots: [] }] }),
      listSessionsWithPanes: async () => ({ panes: [] }),
      hubRooms: async () => ({ rooms: {}, states: {} }),
      hubUnread: async () => ({ rooms: {} }),
      hubRead: async () => ({ rooms: {} }),
      registryList: async () => ({ agents: [] }),
      teamsList: async () => ({ teams: [] }),
      hubAgents: async () => ({ agents: [{ name: 'alice', window: 0, managed: true, agent: 'kiro', state: 'idle' }] }),
      hubLog: async () => ({ messages: [], has_more: false }),
      hubActivity: async () => ({ events: [], has_more: false }),
      addTeamMessageListener: () => undefined,
      removeTeamMessageListener: () => undefined,
      addAgentRenamedListener: () => undefined,
      removeAgentRenamedListener: () => undefined,
      getCaps: () => ['board_dispatch', 'spawn_join', 'agent_team'],
      onCaps: () => undefined,
    },
  };
}

// ── Board #132 (design record #131): the drawer beside the chat only when it fits ─────────
// The Hub's own width is measured (a controllable ResizeObserver stands in for layout); under
// a coarse pointer the chat head needs 414 px and the drawer 320. At the owner's landscape
// inner screen (776 wide, 730 for the Hub) the Files button opens the Files PAGE (the compact
// Hub's own path); at 1280 it opens the drawer; an open drawer that stops fitting is not
// drawn and comes back when the room returns, its intent kept.
test('the drawer goes beside the chat only when the chat head and the drawer both fit; else the button opens the page (#132)', { timeout: 60000 }, async (context) => {
  const { rpc } = roomFixture();
  const routes: unknown[] = [];
  const observers: { cb: (entries: unknown[]) => void; els: Element[] }[] = [];
  let width = 730;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: false, openFilesTab: (...args: unknown[]) => routes.push(args) },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_sidebar', '1');   // the sidebar collapsed
      window.matchMedia = (media: string) => Object.assign(new window.EventTarget(), { media, matches: media === '(any-pointer: coarse)', onchange: null, addListener() {}, removeListener() {} });
      window.ResizeObserver = class { cb: (e: unknown[]) => void; els: Element[] = []; constructor(cb: (e: unknown[]) => void) { this.cb = cb; observers.push(this); } observe(el: Element) { this.els.push(el); this.cb([{ target: el, contentRect: { width, height: 700 } }]); } unobserve() {} disconnect() {} } as never;
    },
    modules: [{ ...rpc, fsList: async () => ({ entries: [] }), fsCwd: async () => ({ path: '/fixture' }), getPrefs: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }), gitCmd: async () => ({ code: 1 }) }],
  });
  const resize = async (w: number) => { width = w; for (const o of observers) o.cb(o.els.map((target) => ({ target, contentRect: { width: w, height: 700 } }))); for (let i = 0; i < 8; i++) await app.flush(); };
  const files = () => app.document.querySelector<HTMLButtonElement>('.page-head [aria-label="Files"]')!;
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.h1-text')?.textContent; i++) await app.flush();
    files().click(); for (let i = 0; i < 12; i++) await app.flush();
    assert.equal(app.document.querySelector('.drawer'), null, '776×717: no drawer beside a 316 px chat');
    assert.equal(routes.length, 1, 'the button opens the Files page instead');
    assert.equal(files().getAttribute('aria-expanded'), null, 'and does not claim to disclose a drawer');
    await resize(1234);
    files().click(); for (let i = 0; i < 12; i++) await app.flush();
    assert.ok(app.document.querySelector('.drawer'), '1280: beside');
    assert.equal(routes.length, 1);
    await resize(730);
    assert.equal(app.document.querySelector('.drawer'), null, 'it stops fitting: not drawn');
    await resize(1234);
    assert.ok(app.document.querySelector('.drawer'), 'the room is back: so is the drawer (its intent was kept)');
    const root = app.document.querySelector<HTMLElement>('.hub-root')!;
    assert.equal(root.style.getPropertyValue('--chat-min'), '414px', 'the grid\'s chat floor is the same head minimum');
  } finally { await app.close(); }
});

// Validator-2 note 5 on d6bf4b28: the sidebar's own resize handle (SideHandle) writes
// --sidebar-w on the document root without resizing the Hub, so a width read only when the Hub
// resized stayed stale and the drawer was kept beside a 305 px squeeze. The rule reads the
// sidebar's width whenever that variable is written.
test('widening the sidebar through its handle re-judges the drawer at once (#132 R1)', { timeout: 60000 }, async (context) => {
  const { rpc } = roomFixture();
  const routes: unknown[] = [];
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: false, openFilesTab: (...args: unknown[]) => routes.push(args) },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_sidebar', '0');   // the sidebar shown
      window.document.documentElement.style.setProperty('--sidebar-w', '240px');
      window.ResizeObserver = class { cb: (e: unknown[]) => void; constructor(cb: (e: unknown[]) => void) { this.cb = cb; } observe(el: Element) { this.cb([{ target: el, contentRect: { width: 934, height: 700 } }]); } unobserve() {} disconnect() {} } as never;
    },
    modules: [{ ...rpc, fsList: async () => ({ entries: [] }), fsCwd: async () => ({ path: '/fixture' }), getPrefs: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }), gitCmd: async () => ({ code: 1 }) }],
  });
  const settle = async () => { for (let i = 0; i < 12; i++) await app.flush(); };
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.h1-text')?.textContent; i++) await app.flush();
    // 980×740 with a mouse: 934 - 240 - 324 = 370 ≥ 320, beside.
    app.document.querySelector<HTMLButtonElement>('.page-head [aria-label="Files"]')!.click(); await settle();
    assert.ok(app.document.querySelector('.drawer'), 'beside at a 240 px sidebar');
    // The handle widens the sidebar to 420 (as SideHandle does: the root's variable only).
    app.document.documentElement.style.setProperty('--sidebar-w', '420px'); await settle();
    assert.equal(app.document.querySelector('.drawer'), null, '934 - 420 - 324 = 190 < 320: no longer drawn');
    app.document.documentElement.style.setProperty('--sidebar-w', '240px'); await settle();
    assert.ok(app.document.querySelector('.drawer'), 'narrowed again: back, its intent kept');
  } finally { await app.close(); }
});

// Reviewer, #132 @4c381904: Back and Escape acted on the drawer's INTENT (termOpen) while the
// rule had stopped drawing it, so in a Hub with no room Back consumed an invisible drawer and
// cleared the project's saved drawer instead of reaching the next layer. They act on the drawn
// drawer only; the intent survives them.
test('Back and Escape pass a drawer the rule is not drawing, and its intent survives them (#132 R2)', { timeout: 60000 }, async (context) => {
  const { rpc } = roomFixture();
  const observers: { cb: (entries: unknown[]) => void; els: Element[] }[] = [];
  let width = 1234;
  let back: (() => boolean) | undefined;
  const app = await (await compiledHub()).mount(context, {
    props: { visible: true, mobile: false, openFilesTab: () => undefined, onGoBack: (fn: () => boolean) => { back = fn; } },
    setup(window) {
      window.Element.prototype.getAnimations = () => [];
      window.localStorage.setItem('tmux_hub_sidebar', '1');
      window.matchMedia = (media: string) => Object.assign(new window.EventTarget(), { media, matches: media === '(any-pointer: coarse)', onchange: null, addListener() {}, removeListener() {} });
      window.ResizeObserver = class { cb: (e: unknown[]) => void; els: Element[] = []; constructor(cb: (e: unknown[]) => void) { this.cb = cb; observers.push(this); } observe(el: Element) { this.els.push(el); this.cb([{ target: el, contentRect: { width, height: 700 } }]); } unobserve() {} disconnect() {} } as never;
    },
    modules: [{ ...rpc, fsList: async () => ({ entries: [] }), fsCwd: async () => ({ path: '/fixture' }), getPrefs: async () => ({}), getBookmarks: async () => ({ bookmarks: [] }), gitCmd: async () => ({ code: 1 }) }],
  });
  const settle = async () => { for (let i = 0; i < 12; i++) await app.flush(); };
  const resize = async (w: number) => { width = w; for (const o of observers) o.cb(o.els.map((target) => ({ target, contentRect: { width: w, height: 700 } }))); await settle(); };
  const saved = () => JSON.parse(app.window.localStorage.getItem('tmux_hub_drawer') || '{}');
  try {
    for (let i = 0; i < 12 && !app.document.querySelector('.h1-text')?.textContent; i++) await app.flush();
    app.document.querySelector<HTMLButtonElement>('.page-head [aria-label="Files"]')!.click(); await settle();
    assert.ok(app.document.querySelector('.drawer'));
    const before = JSON.stringify(saved());
    await resize(730);
    assert.equal(app.document.querySelector('.drawer'), null);
    assert.equal(back?.(), false, 'Back passes a drawer that is not drawn');
    const esc = new app.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    app.document.body.dispatchEvent(esc); await settle();
    assert.equal(esc.defaultPrevented, false, 'Escape is not taken by a drawer that is not drawn');
    assert.equal(JSON.stringify(saved()), before, 'the project\'s drawer is still saved');
    await resize(1234);
    assert.ok(app.document.querySelector('.drawer'), 'the room is back: so is the drawer');
    assert.equal(back?.(), true, 'and Back closes it again');
  } finally { await app.close(); }
});
