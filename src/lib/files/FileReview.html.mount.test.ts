// Board #434, the HTML preview, through the real Files page: the frame's
// binding (design delta 2), selection → ＋ → card against the frame's own
// document, its own highlight registry, and the binding's retirement on a
// hide that fires no load, also with the map still pending.
//
// jsdom does not load `srcdoc`; the setup writes the frame's document from
// its srcdoc and fires `load`, as a browser does. The source map
// (review-html-map.ts) is the REAL module, run here with parse5 and handed
// to the page as plain data, with one seam: it can be held, to order a
// pending map against an exit. The DOM side runs in the page, unmocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';
import * as realMap from './review-html-map.ts';

const compiled = compileMount(new URL('./Files.test.svelte', import.meta.url),
  [new URL('../core/ws.ts', import.meta.url), new URL('./review-html-map.ts', import.meta.url)], { serverScope: true });
type App = Awaited<ReturnType<Awaited<typeof compiled>['mount']>>;

const PAGE = '<!doctype html>\r\n<html><body>\r\n<h1>Report &amp; notes</h1>\r\n<p>first paragraph</p>\r\n</body></html>\r\n';
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

function rpc(calls: { method: string; args: unknown[] }[]) {
  const log = (method: string, fn: (...a: any[]) => unknown) => (...args: unknown[]) => { calls.push({ method, args }); return fn(...args); };
  return {
    fsCwd: async () => ({ path: '/w' }),
    fsList: async () => ({ path: '/w', entries: [{ name: 'page.html', path: '/w/page.html', type: 'file', size: 90 }] }),
    fsStat: async (path: string) => ({ path, is_text: true, writable: true, readable: true, size: 90, mime_hint: 'text/html' }),
    fsRead: async () => ({ content: PAGE, revision: 'r1' }),
    fsPreviewBase: async () => { throw new Error('no scope in this fixture'); },
    getBookmarks: async () => ({ bookmarks: [] }), getPrefs: async () => ({}), saveBookmarks: async () => ({}), setPref: async () => ({}),
    gitCmd: async () => ({ code: 1, stdout: '' }),
    projectList: async () => ({ projects: [{ project: { id: 'p1', name: 'One', session: 'fixture', path: '/w' }, live: true, slots: [] }] }),
    reviewList: log('reviewList', async (target: object) => ({ ...target, revision: 'r1', annotations: [] })),
    reviewAdd: log('reviewAdd', async () => ({ id: 'n1', line: 3, col: 5, end_line: 3, end_col: 11, quote: 'Report', pre: '', suf: '', note: 'n', status: 'open', revision: 'r1', created: 1, updated: 1, by: 'human' })),
  };
}

/** The frames' documents written from their srcdoc, a load fired, and a
 * stand-in Custom Highlight API in each frame window (counting loads). */
function frames(win: any, loads: { n: number }) {
  const write = (f: HTMLIFrameElement) => {
    const src = f.getAttribute('srcdoc');
    if (src == null || !f.isConnected || (f as any).__written === src) return;
    (f as any).__written = src;
    const d = f.contentDocument!;
    d.open(); d.write(src); d.close();
    const fw = f.contentWindow as any;
    fw.Highlight = class extends Set { constructor(...r: unknown[]) { super(r); } };
    fw.CSS = { highlights: new Map() };
    if (!('fonts' in d)) Object.defineProperty(d, 'fonts', { configurable: true, value: new fw.EventTarget() });
    loads.n++;
    f.dispatchEvent(new win.Event('load'));
  };
  // A browser loads a srcdoc document in a task of its own, after the frame
  // is in the page and the page's effects have run.
  const later = (f: HTMLIFrameElement) => win.setTimeout(() => write(f), 0);
  new win.MutationObserver((records: MutationRecord[]) => {
    for (const r of records) {
      if (r.target instanceof win.HTMLIFrameElement) later(r.target as HTMLIFrameElement);
      for (const n of r.addedNodes) {
        if (n instanceof win.HTMLIFrameElement) later(n as HTMLIFrameElement);
        if (n instanceof win.Element) for (const f of (n as Element).querySelectorAll('iframe')) later(f as HTMLIFrameElement);
      }
    }
  }).observe(win.document, { subtree: true, childList: true, attributes: true, attributeFilter: ['srcdoc'] });
}

async function settle(app: App) { for (let i = 0; i < 12; i++) await app.flush(); }
function button(app: App, label: string) {
  const el = [...app.document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label);
  assert.ok(el, `button ${label}`);
  return el;
}
const frameEl = (app: App) => app.document.querySelector<HTMLIFrameElement>('iframe.html-preview')!;
async function selectInFrame(app: App, needle: string) {
  const doc = frameEl(app).contentDocument!;
  const w = doc.createTreeWalker(doc.body, 4);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const i = (n as Text).data.indexOf(needle);
    if (i < 0) continue;
    const r = doc.createRange();
    r.setStart(n, i); r.setEnd(n, i + needle.length);
    const sel = doc.getSelection()!;
    sel.removeAllRanges(); sel.addRange(r);
    doc.dispatchEvent(new (frameEl(app).contentWindow as any).Event('selectionchange'));
    await settle(app);
    return;
  }
  throw new Error(`no ${needle} in the frame`);
}
async function open(app: App) {
  const row = [...app.document.querySelectorAll<HTMLButtonElement>('.file-list .file-main')].find((b) => b.textContent?.includes('page.html'))!;
  row.click(); await settle(app);
  await app.advance(1); await settle(app); // the frame's own load task
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((y) => { resolve = y; }); return { promise, resolve }; }

test('select in the frame → ＋ → saved with the LINE-model range; the highlight is in the frame\u2019s OWN registry', async (context) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const loads = { n: 0 };
  let annotations: unknown[] = [];
  const modules = rpc(calls);
  modules.reviewList = (async (target: object) => ({ ...target, revision: 'r1', annotations })) as never;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules, realMap], pendingImports: ['highlight.js'],
    setup(win) { frames(win, loads); (win as any).CSS = { highlights: new Map() }; (win as any).Highlight = class extends Set {}; },
  });
  try {
    await settle(app);
    await open(app);
    assert.equal(loads.n, 1, 'the frame loaded once');
    await selectInFrame(app, 'Report');
    button(app, 'Comment').click(); await settle(app);
    const input = app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!;
    input.value = 'why'; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle(app);
    button(app, 'Save comment').click(); await settle(app);
    const add = plain(calls.find((c) => c.method === 'reviewAdd')!.args);
    assert.deepEqual([add[1], add[2], add[3]], [{ line: 3, col: 5, end_line: 3, end_col: 11 }, 'why', 'r1'], 'line 3 after two CRLFs, the source\u2019s own columns');
    // A stored comment is painted in the FRAME's registry, not the page's.
    annotations = [{ id: 'a', line: 3, col: 12, end_line: 3, end_col: 17, quote: '&amp;', pre: '', suf: '', note: 'amp', status: 'open', revision: 'r1', created: 1, updated: 1, by: 'human',
      at: { state: 'located', range: { line: 3, col: 12, end_line: 3, end_col: 17 } } }];
    button(app, 'Refresh').click(); await settle(app);
    await app.advance(1); await settle(app); // a renewed base is a new frame and a new load
    const fw = frameEl(app).contentWindow as any;
    const painted = [...(fw.CSS.highlights.get('review') ?? [])] as Range[];
    assert.deepEqual(painted.map((r) => r.toString()), ['&'], 'the reference shows as & and is highlighted whole');
    assert.equal(((app.window as any).CSS.highlights as Map<string, unknown>).size, 0, 'the page\u2019s own registry is untouched');
  } finally { await app.close(); }
});

test('hide → show with the SAME document and no load: the old binding is retired, a fresh one resumes review', async (context) => {
  const loads = { n: 0 };
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc([]), realMap], pendingImports: ['highlight.js'],
    setup(win) { frames(win, loads); },
  });
  try {
    await settle(app);
    await open(app);
    const doc = frameEl(app).contentDocument;
    await selectInFrame(app, 'first');
    assert.ok(app.document.querySelector('.rv-pick'), 'bound: the ＋ is offered');
    await app.setProps({ visible: false }); await settle(app);
    assert.equal(app.document.querySelector('.rv-pick'), null, 'hidden: no binding, no ＋');
    await selectInFrame(app, 'paragraph');
    assert.equal(app.document.querySelector('.rv-pick'), null, 'a selection while hidden is ignored');
    await app.setProps({ visible: true }); await settle(app);
    assert.equal(frameEl(app).contentDocument, doc, 'the same document');
    assert.equal(loads.n, 1, 'and no load');
    await selectInFrame(app, 'paragraph');
    assert.ok(app.document.querySelector('.rv-pick'), 'a fresh binding resumes review');
  } finally { await app.close(); }
});

test('a pending map, hide → show, then the old map arrives: it installs nothing; the new binding does', async (context) => {
  const held = deferred<void>();
  let hold = true;
  const asked: number[] = [];
  const html = { ...realMap, htmlSourceMap: async (content: string) => {
    asked.push(asked.length + 1);
    if (hold) await held.promise; // every map asked before the release is held
    return realMap.htmlSourceMap(content);
  } };
  const loads = { n: 0 };
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc([]), html], pendingImports: ['highlight.js'],
    setup(win) { frames(win, loads); },
  });
  try {
    await settle(app);
    await open(app);
    await selectInFrame(app, 'first');
    assert.equal(app.document.querySelector('.rv-pick'), null, 'the map is pending: nothing is selectable yet');
    await app.setProps({ visible: false }); await settle(app);
    await app.setProps({ visible: true }); await settle(app);
    hold = false;
    held.resolve();
    await settle(app);
    assert.ok(asked.length >= 2, 'the fresh binding asked for its own map');
    await selectInFrame(app, 'first');
    assert.ok(app.document.querySelector('.rv-pick'), 'the NEW binding is installed and selectable');
    assert.equal(loads.n, 1, 'no load was needed');
  } finally { await app.close(); }
});

test('a page whose two parses disagree says why, keeps the preview, and offers no ＋', async (context) => {
  const modules = rpc([]);
  modules.fsRead = (async () => ({ content: '<p>&copy 2026</p>', revision: 'r1' })) as never;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules, realMap], pendingImports: ['highlight.js'],
    setup(win) { frames(win, { n: 0 }); },
  });
  try {
    await settle(app);
    await open(app);
    assert.match(app.document.querySelector('.rv-status[role=status]')?.textContent ?? '', /cannot be commented on here: its text could not be matched/u);
    assert.ok(frameEl(app).getAttribute('sandbox') === 'allow-same-origin', 'the frame is unchanged');
    await selectInFrame(app, '2026');
    assert.equal(app.document.querySelector('.rv-pick'), null);
  } finally { await app.close(); }
});

test('a pending map that arrives while the preview is hidden binds nothing', async (context) => {
  const held = deferred<void>();
  const html = { ...realMap, htmlSourceMap: async (content: string) => { await held.promise; return realMap.htmlSourceMap(content); } };
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [rpc([]), html], pendingImports: ['highlight.js'],
    setup(win) { frames(win, { n: 0 }); },
  });
  try {
    await settle(app);
    await open(app);
    await app.setProps({ visible: false }); await settle(app);
    held.resolve(); await settle(app);
    await selectInFrame(app, 'first');
    assert.equal(app.document.querySelector('.rv-pick'), null, 'the retired binding installed nothing: no ＋ while hidden');
  } finally { await app.close(); }
});

test('a re-read with the same text at new offsets maps through the NEW source, never a cached map', async (context) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const modules = rpc(calls);
  let content = PAGE, rev = 'r1';
  modules.fsRead = (async () => ({ content, revision: rev })) as never;
  modules.reviewList = (async (target: object) => ({ ...target, revision: rev, annotations: [] })) as never;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules, realMap], pendingImports: ['highlight.js'],
    setup(win) { frames(win, { n: 0 }); },
  });
  try {
    await settle(app);
    await open(app);
    content = PAGE.replace('<h1>', '<h1 class="x">'); rev = 'r2';
    button(app, 'Refresh').click(); await settle(app);
    await app.advance(1); await settle(app);
    await selectInFrame(app, 'Report');
    button(app, 'Comment').click(); await settle(app);
    const input = app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!;
    input.value = 'why'; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle(app);
    button(app, 'Save comment').click(); await settle(app);
    const add = plain(calls.find((c) => c.method === 'reviewAdd')!.args);
    assert.deepEqual([add[1], add[3]], [{ line: 3, col: 15, end_line: 3, end_col: 21 }, 'r2'], 'the new source\u2019s columns, ten to the right');
  } finally { await app.close(); }
});

test('a late resource or font in the frame re-places the cards (a fixed-height root resizes nothing)', async (context) => {
  const at = { top: 300 };
  const annotations = [{ id: 'a', line: 4, col: 4, end_line: 4, end_col: 9, quote: 'first', pre: '', suf: '', note: 'n', status: 'open', revision: 'r1', created: 1, updated: 1, by: 'human',
    at: { state: 'located', range: { line: 4, col: 4, end_line: 4, end_col: 9 } } }];
  const modules = rpc([]);
  modules.reviewList = (async (target: object) => ({ ...target, revision: 'r1', annotations })) as never;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules, realMap], pendingImports: ['highlight.js'],
    setup(win: any) {
      frames(win, { n: 0 });
      // The page measures the wrapper wide and the lane at 160; the frame's
      // ranges are wherever `at` says, and its document has a font set.
      win.ResizeObserver = class {
        cb: (e: unknown[]) => void;
        constructor(cb: (e: unknown[]) => void) { this.cb = cb; }
        observe(el: Element) { if (el.classList?.contains('rv-wrap')) this.cb([{ contentRect: { width: 1200 } }]); }
        unobserve() {} disconnect() {}
      };
      const orig = win.HTMLElement.prototype.getBoundingClientRect;
      win.HTMLElement.prototype.getBoundingClientRect = function () {
        return this.classList.contains('rv-lane') ? { top: 160, bottom: 700, left: 900, right: 1160 } : orig.call(this);
      };
      Object.defineProperty(win.HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return this.classList.contains('rv-card') ? 100 : 0; } });
      new win.MutationObserver(() => {
        const f = win.document.querySelector('iframe.html-preview') as HTMLIFrameElement | null;
        const fw = f?.contentWindow as any;
        if (!fw || fw.__laid) return;
        fw.__laid = true;
        fw.Range.prototype.getBoundingClientRect = () => ({ top: at.top, bottom: at.top + 20, left: 0, right: 10 });
      }).observe(win.document, { subtree: true, childList: true });
    },
  });
  try {
    await settle(app);
    await open(app);
    const fw = frameEl(app).contentWindow as any;
    const doc = frameEl(app).contentDocument! as Document & { fonts?: EventTarget };
    const card = () => parseFloat(app.document.querySelector<HTMLElement>('.rv-lane-inner [data-review-id="a"]')!.style.top);
    assert.equal(card(), 140, 'level with its text: 300 in the frame, the lane at 160');
    at.top = 420;
    doc.body.dispatchEvent(new fw.Event('load')); // an image or stylesheet arriving: no DOM change, no resize
    await app.advance(20); await settle(app);
    assert.equal(card(), 260, 'a resource load re-places');
    at.top = 500;
    doc.fonts!.dispatchEvent(new fw.Event('loadingdone'));
    await app.advance(20); await settle(app);
    assert.equal(card(), 340, 'a font arriving re-places');
  } finally { await app.close(); }
});

test('part of a multi-scalar reference selected: the draft quotes and stores the WHOLE reference (reviewer P2 on 6a4950ec)', async (context) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const modules = rpc(calls);
  modules.fsRead = (async () => ({ content: '<p>x &NotEqualTilde; y</p>', revision: 'r1' })) as never;
  const app = await (await compiled).mount(context, {
    props: { visible: true, session: 'fixture' }, modules: [modules, realMap], pendingImports: ['highlight.js'],
    setup(win) { frames(win, { n: 0 }); },
  });
  try {
    await settle(app);
    await open(app);
    await selectInFrame(app, '\u2242'); // the first of the two scalars it shows
    button(app, 'Comment').click(); await settle(app);
    assert.equal(app.document.querySelector('.rv-new .rv-quote')?.textContent, '\u2242\u0338', 'the draft quotes what the mapped range shows');
    const input = app.document.querySelector<HTMLTextAreaElement>('.rv-new textarea')!;
    input.value = 'n'; input.dispatchEvent(new app.window.Event('input', { bubbles: true })); await settle(app);
    button(app, 'Save comment').click(); await settle(app);
    const add = plain(calls.find((c) => c.method === 'reviewAdd')!.args);
    assert.deepEqual(add[1], { line: 1, col: 6, end_line: 1, end_col: 21 }, 'the whole &NotEqualTilde;');
  } finally { await app.close(); }
});
