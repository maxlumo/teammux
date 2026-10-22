import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #175 (owner, 2026-09-11: chat images rendered as the amber dashed
// path chip). The signed /dl URL was minted when the message RENDERED while
// the <img> was `loading="lazy"`; the browser fetched minutes later with a
// signature that dies at 60 s → 403 → failed. The signature belongs to the
// FETCH: mint it when the image nears the viewport, re-sign once on error,
// and hand the viewer a fresh URL.
// Bound to one server's scope, as App's provider binds it (board #335 ②b).
const compiled = compileMount(new URL('./ChatImage.svelte', import.meta.url), [new URL('../core/ws.ts', import.meta.url)], { serverScope: true });

type Observer = { targets: Element[]; fire(isIntersecting: boolean): void };
/** A hand-driven IntersectionObserver: jsdom has none, and the test decides
 * when the image "nears the viewport". */
function fakeIntersection(win: any): Observer {
  const observers: { cb: (entries: unknown[]) => void; targets: Element[] }[] = [];
  win.IntersectionObserver = class {
    cb: (entries: unknown[]) => void; targets: Element[] = [];
    constructor(cb: (entries: unknown[]) => void) { this.cb = cb; observers.push(this); }
    observe(el: Element) { this.targets.push(el); }
    unobserve() {}
    disconnect() { this.targets = []; }
  };
  return {
    get targets() { return observers.flatMap((o) => o.targets); },
    fire(isIntersecting: boolean) {
      for (const o of observers) if (o.targets.length) o.cb(o.targets.map((target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 })));
    },
  };
}

test('the /dl signature is minted when the image nears the viewport, re-signed once on error, fresh for the viewer (board #175)', async (context) => {
  const signed: string[] = [];
  const viewed: string[] = [];
  let io!: Observer;
  const app = await (await compiled).mount(context, {
    props: { src: '/ws/.tmm/uploads/shot.png', alt: 'codex', onview: (url: string) => viewed.push(url) },
    modules: [{ fsDownloadHttp: async (path: string) => { signed.push(path); return { url: `https://h/dl?path=${encodeURIComponent(path)}&sig=${signed.length}`, name: 'shot.png' }; } }],
    setup: (win) => { io = fakeIntersection(win); },
  });
  try {
    const doc = app.document;
    // 1. Rendered, not yet near: nothing is signed and nothing is fetched.
    assert.equal(signed.length, 0, 'no signature at render time');
    assert.equal(doc.querySelector('img'), null, 'no <img> before the fetch is about to happen');
    assert.equal(io.targets.length, 1, 'the host element is observed');
    assert.ok(doc.querySelector('.ci-ref:not(.failed)'), 'pending: the reference is named in grey, not as a failure');
    // 2. Nearing the viewport mints ONE signature; the observer IS the laziness.
    io.fire(true);
    await app.flush(); await app.flush();
    assert.equal(signed.length, 1);
    const img = doc.querySelector<HTMLImageElement>('img.ci')!;
    assert.ok(img, 'the image mounts with its signed url');
    assert.equal(img.getAttribute('src'), 'https://h/dl?path=%2Fws%2F.tmm%2Fuploads%2Fshot.png&sig=1');
    assert.equal(img.getAttribute('loading'), null, 'no second laziness beside the observer');
    // 3. A dead signature (403 → error) is re-signed exactly once.
    img.dispatchEvent(new app.window.Event('error'));
    await app.flush(); await app.flush();
    assert.equal(signed.length, 2, 'one re-sign');
    const img2 = doc.querySelector<HTMLImageElement>('img.ci')!;
    assert.equal(img2.getAttribute('src'), 'https://h/dl?path=%2Fws%2F.tmm%2Fuploads%2Fshot.png&sig=2');
    assert.equal(doc.querySelector('.ci-ref.failed'), null, 'not failed after one error');
    // 4. The viewer gets a FRESH url, never the thumbnail's.
    doc.querySelector<HTMLButtonElement>('button.ci-link')!.click();
    await app.flush(); await app.flush();
    assert.equal(signed.length, 3, 'opening the viewer signs again');
    assert.deepEqual(viewed, ['https://h/dl?path=%2Fws%2F.tmm%2Fuploads%2Fshot.png&sig=3']);
    // 5. A second load error means the file is really unreachable: failed, no loop.
    img2.dispatchEvent(new app.window.Event('error'));
    await app.flush(); await app.flush();
    assert.ok(doc.querySelector('.ci-ref.failed'), 'the reference is named in warn colour');
    assert.equal(doc.querySelector('img'), null);
    assert.equal(signed.length, 3, 'no third re-sign for the thumbnail');
  } finally { await app.close(); }
});

test('a direct URL needs no signature and no observer round-trip', async (context) => {
  let io!: Observer;
  const app = await (await compiled).mount(context, {
    props: { src: 'https://example.test/a.png', alt: 'x', onview: () => {} },
    modules: [{ fsDownloadHttp: async () => assert.fail('a direct url is never signed') }],
    setup: (win) => { io = fakeIntersection(win); },
  });
  try {
    assert.equal(app.document.querySelector('img.ci')?.getAttribute('src'), 'https://example.test/a.png');
    void io;
  } finally { await app.close(); }
});

// Board #447: the viewer is handed the URL AND the reference of the SAME tap, so a download from it
// saves the file the reader tapped, whatever the thumbnail does afterwards.
test('the tap hands the viewer its URL, its claim and the reference taken at that tap; a later src change cannot change them (#447)', async (context) => {
  const opened: { url: string; claim: unknown; ref: string | null }[] = [];
  let release!: () => void;
  const held = new Promise<void>((ok) => { release = ok; });
  const app = await (await compiled).mount(context, {
    props: {
      src: '/ws/a.png', alt: 'x',
      onviewstart: () => ({ n: 1 }),
      onview: (url: string, claim: unknown, ref: string | null) => opened.push({ url, claim, ref }),
    },
    modules: [{ fsDownloadHttp: async (path: string) => { await held; return { url: `https://h/dl?p=${encodeURIComponent(path)}`, name: 'a.png' }; } }],
    setup: (win) => { fakeIntersection(win); },
  });
  try {
    app.document.querySelector<HTMLButtonElement>('button.ci-link')!.click();   // the tap on A; its signature is held
    await app.flush();
    await app.setProps({ src: '/ws/b.png' });                                     // the thumbnail moves on to B
    release();
    await app.flush(); await app.flush();
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.ref, '/ws/a.png', 'the reference is the one of the tap, not the prop read later');
    assert.equal(opened[0]!.url, 'https://h/dl?p=%2Fws%2Fa.png', 'and the URL was signed for that same reference');
    assert.deepEqual(opened[0]!.claim, { n: 1 });
  } finally { await app.close(); }
});

test('a direct URL has no server file: the viewer is told no reference (#447)', async (context) => {
  const opened: (string | null)[] = [];
  const app = await (await compiled).mount(context, {
    props: { src: 'https://example.test/a.png', alt: 'x', onview: (_url: string, _claim: unknown, ref: string | null) => opened.push(ref) },
    modules: [{ fsDownloadHttp: async () => assert.fail('a direct url is never signed') }],
    setup: (win) => { fakeIntersection(win); },
  });
  try {
    app.document.querySelector<HTMLButtonElement>('button.ci-link')!.click();
    await app.flush(); await app.flush();
    assert.deepEqual(opened, [null]);
  } finally { await app.close(); }
});
