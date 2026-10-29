import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMount } from '../test/mount.ts';

// Board #433: an HTML preview's frame is bound to the base minted for it.
const compiled = compileMount(new URL('./FilePreview.svelte', import.meta.url), []);
const noop = () => {};
const html = (path: string, content: string) => ({ path, name: path.slice(path.lastIndexOf('/') + 1), stat: { mime_hint: 'text/html' }, content });
const scope = (dir: string) => `https://gw.example/tmux/dl/s/9/1.2/sig/L3A/${dir}/`;
const at = (url: string) => ({ url, prefix: 'https://gw.example/tmux/dl/s/' });

function mints() {
  const asked: string[] = [];
  const pending: { resolve: (scope: { url: string; prefix: string }) => void; reject: (e: Error) => void }[] = [];
  const previewBase = (path: string) => new Promise<{ url: string; prefix: string }>((resolve, reject) => { asked.push(path); pending.push({ resolve, reject }); });
  return { asked, pending, previewBase };
}

async function mount(context: test.TestContext, file: object, extra: Record<string, unknown>) {
  return (await compiled).mount(context, { modules: [], props: {
    currentFile: file, fontSize: 14, wrapLines: false, hljs: null, showAllLines: false,
    previewLinkClick: noop, attachHtmlPreviewLinks: noop,
    previewBodyEl: null, previewEl: null, htmlPreviewEl: null, pdfContainer: null, ...extra,
  } });
}

test('the frame mounts only once its base answers, with the base leading its document', async context => {
  const m = mints();
  const app = await mount(context, html('/p/site/index.html', '<h1>Hi</h1>'), { previewBase: m.previewBase });
  assert.deepEqual(m.asked, ['/p/site/index.html']);
  assert.equal(app.document.querySelector('iframe'), null, 'no unbased frame while the base is minted');
  m.pending[0]!.resolve(at(scope('site')));
  await app.flush();
  const frame = app.document.querySelector('iframe')!;
  assert.equal(frame.getAttribute('sandbox'), 'allow-same-origin');
  const srcdoc = frame.getAttribute('srcdoc')!;
  assert.match(srcdoc, new RegExp(`<base href="${scope('site').replace(/[./]/gu, '\\$&')}">`, 'u'));
  assert.ok(srcdoc.indexOf('Content-Security-Policy') < srcdoc.indexOf('<base'), 'the CSP precedes the base');
  assert.ok(srcdoc.includes('<h1>Hi</h1>'));
});

test('a base that answers late, for a file no longer shown, is dropped', async context => {
  const m = mints();
  const app = await mount(context, html('/p/a.html', '<p>A</p>'), { previewBase: m.previewBase });
  await app.setProps({ currentFile: html('/p/b/b.html', '<p>B</p>') });
  assert.deepEqual(m.asked, ['/p/a.html', '/p/b/b.html']);
  m.pending[0]!.resolve(at(scope('a')));
  await app.flush();
  assert.equal(app.document.querySelector('iframe'), null, "A's base never shows B");
  m.pending[1]!.resolve(at(scope('b')));
  await app.flush();
  const srcdoc = app.document.querySelector('iframe')!.getAttribute('srcdoc')!;
  assert.ok(srcdoc.includes(scope('b')) && srcdoc.includes('<p>B</p>'));
  assert.ok(!srcdoc.includes(scope('a')));
});

test("an earlier file's answer arriving after the shown file's never replaces it", async context => {
  const m = mints();
  const app = await mount(context, html('/p/a.html', '<p>A</p>'), { previewBase: m.previewBase });
  await app.setProps({ currentFile: html('/p/b/b.html', '<p>B</p>') });
  m.pending[1]!.resolve(at(scope('b')));
  await app.flush();
  m.pending[0]!.resolve(at(scope('a')));
  await app.flush();
  const srcdoc = app.document.querySelector('iframe')?.getAttribute('srcdoc') ?? '';
  assert.ok(srcdoc.includes(scope('b')) && srcdoc.includes('<p>B</p>'), 'B stays shown');
});

test("an earlier file's late refusal says nothing over the shown file", async context => {
  const m = mints();
  const errors: string[] = [];
  const app2 = await mount(context, html('/p/a.html', '<p>A</p>'), { previewBase: m.previewBase, onpreviewerror: (e: string) => errors.push(e) });
  await app2.setProps({ currentFile: html('/p/b/b.html', '<p>B</p>') });
  m.pending[1]!.resolve(at(scope('b')));
  m.pending[0]!.reject(new Error('late refusal'));
  await app2.flush();
  assert.deepEqual(errors, []);
  assert.ok(app2.document.querySelector('iframe')!.getAttribute('srcdoc')!.includes(scope('b')));
});

test('a failed mint reports its error and shows the page under a CSP that loads nothing', async context => {
  const m = mints();
  const errors: string[] = [];
  const app = await mount(context, html('/p/x.html', '<base href="https://evil.example/"><p>X</p>'), { previewBase: m.previewBase, onpreviewerror: (e: string) => errors.push(e) });
  m.pending[0]!.reject(new Error('scope root refused'));
  await app.flush();
  assert.deepEqual(errors, ['Resources not loaded; Reload to retry: scope root refused']);
  const srcdoc = app.document.querySelector('iframe')!.getAttribute('srcdoc')!;
  assert.ok(srcdoc.includes('<p>X</p>'), 'the page still reads');
  assert.ok(srcdoc.includes(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"`));
  assert.ok(!srcdoc.includes('<base'), 'no base: neither the scope nor the author one');
});

test('every showing mints its own base: a reload and a return each ask again', async context => {
  const m = mints();
  const file = html('/p/r.html', '<p>1</p>');
  const app = await mount(context, file, { previewBase: m.previewBase });
  m.pending[0]!.resolve(at(scope('one')));
  await app.flush();
  assert.ok(app.document.querySelector('iframe'));
  // Reload: the same file with new content mints again; the old frame goes.
  await app.setProps({ currentFile: { ...file, content: '<p>2</p>' } });
  assert.equal(m.asked.length, 2);
  assert.equal(app.document.querySelector('iframe'), null, 'the old base never frames the new content');
  m.pending[1]!.resolve(at(scope('two')));
  await app.flush();
  assert.ok(app.document.querySelector('iframe')!.getAttribute('srcdoc')!.includes('<p>2</p>'));
  // Away (another kind) and back (Back restores the file): a fresh mint.
  await app.setProps({ currentFile: { path: '/p/a.txt', name: 'a.txt', stat: { mime_hint: 'text/plain' }, content: 'a' } });
  assert.equal(app.document.querySelector('iframe'), null);
  await app.setProps({ currentFile: { ...file, content: '<p>2</p>' } });
  assert.equal(m.asked.length, 3, 'the base is never cached on the file');
  m.pending[2]!.resolve(at(scope('three')));
  await app.flush();
  assert.ok(app.document.querySelector('iframe')!.getAttribute('srcdoc')!.includes(scope('three')));
});

// Board #481: an SVG that has only a viewBox has an aspect ratio and no width, so the button that wrapped it was 0
// wide and the picture 0 x 0 in the preview. jsdom cannot lay anything out, so what is pinned here is the contract the
// layout rule keys on: a vector's button carries `vector` (and the CSS gives it a containing box), a bitmap's does
// not, and both pictures wear the one checker atom.
const picture = (mime: string, name: string) => ({ path: `/p/${name}`, name, stat: { mime_hint: mime }, dataUrl: `data:${mime};base64,eA==` });

test('a vector picture gets the sizing button, a bitmap keeps its natural size; both wear the checker (#481)', async context => {
  for (const [mime, name, vector] of [['image/svg+xml', 'logo.svg', true], ['image/png', 'logo.png', false], ['image/webp', 'logo.webp', false], ['image/svg', 'odd.svg', true]] as const) {
    const app = await mount(context, picture(mime, name), {});
    try {
      const button = app.document.querySelector<HTMLButtonElement>('.image-preview .image-open')!;
      assert.ok(button, `${mime}: the picture is the one button into the viewer`);
      assert.equal(button.classList.contains('vector'), vector, `${mime}: vector class only for an SVG`);
      assert.equal(button.getAttribute('aria-label'), name);
      const img = button.querySelector('img')!;
      assert.ok(img.classList.contains('alpha-checker'), `${mime}: the picture wears the shared checker`);
      assert.equal(img.getAttribute('src'), `data:${mime};base64,eA==`);
    } finally { await app.close(); }
  }
});

test('the picture opens the viewer once, whatever it is (#481)', async context => {
  const asked: string[] = [];
  for (const [mime, name] of [['image/svg+xml', 'logo.svg'], ['image/png', 'logo.png']] as const) {
    const app = await mount(context, picture(mime, name), { onview: (src: string) => asked.push(src) });
    try { app.document.querySelector<HTMLButtonElement>('.image-open')!.click(); } finally { await app.close(); }
  }
  assert.deepEqual(asked, ['data:image/svg+xml;base64,eA==', 'data:image/png;base64,eA=='], 'one call per activation, with the picture\u2019s own data URL');
});
