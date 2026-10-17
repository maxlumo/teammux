import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { HLJSApi } from 'highlight.js';
import {
  createPreviewRenderers, defaultWrapForMime, highlightCode, highlightLine,
  hljsLang, isPreviewable, mimeCategory, mimeFromName, renderCsv, streamsInline,
  type PreviewRenderContext,
} from './file-preview.ts';

test('preview classification and limits match the existing Files decisions', () => {
  for (const [mime, category] of [
    ['image/png', 'image'], ['text/markdown', 'markdown'], ['text/csv', 'csv'],
    ['text/html', 'html'], ['application/pdf', 'pdf'], ['text/plain', 'code'],
    ['application/json', 'code'], ['application/toml', 'code'],
    ['application/yaml', 'code'], ['application/octet-stream', 'other'],
  ] as const) assert.equal(mimeCategory(mime), category);
  assert.equal(mimeCategory(undefined), 'other');
  assert.equal(defaultWrapForMime('text/plain'), true);
  assert.equal(defaultWrapForMime('text/markdown'), true);
  assert.equal(defaultWrapForMime('text/typescript'), false);
  assert.equal(isPreviewable(null), false);
  assert.equal(isPreviewable({ mime_hint: 'text/plain', is_text: true, size: 512 * 1024 }), true);
  assert.equal(isPreviewable({ mime_hint: 'text/plain', is_text: true, size: 512 * 1024 + 1 }), false);
  assert.equal(isPreviewable({ mime_hint: 'application/pdf', size: 9e6 }), true);
  assert.equal(isPreviewable({ mime_hint: 'image/png', size: 9e6 }), true);
  assert.equal(isPreviewable({ mime_hint: 'application/octet-stream', size: 9e6 }, 'DECK.PPTX'), true);
  // Board #182: a video STREAMS — its size never decides previewability.
  assert.equal(mimeCategory('video/mp4'), 'video');
  assert.equal(mimeCategory('video/quicktime'), 'video');
  assert.equal(isPreviewable({ mime_hint: 'video/mp4', size: 2 * 1024 ** 3 }), true);
  assert.equal(streamsInline({ mime_hint: 'video/webm', size: 2 * 1024 ** 3 }), true, 'streamed kinds bypass the inline-bytes size gate');
  assert.equal(streamsInline({ mime_hint: 'image/png', size: 9e6 }), false, 'images still arrive as bytes');
  assert.equal(streamsInline(null), false);
  // Board #416: audio rides the same rule — a track's size never decides previewability either.
  for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/webm']) {
    assert.equal(mimeCategory(mime), 'audio', mime);
    assert.equal(streamsInline({ mime_hint: mime, size: 2 * 1024 ** 3 }), true, `${mime} bypasses the inline-bytes size gate`);
    assert.equal(isPreviewable({ mime_hint: mime, size: 2 * 1024 ** 3 }), true, mime);
  }
  assert.equal(mimeCategory('application/octet-stream'), 'other', 'a lookalike stays a download');
});

test('highlighters keep escaped fallback, known languages and existing error boundaries', () => {
  assert.equal(hljsLang('text/typescript'), 'ts');
  assert.equal(hljsLang('application/toml'), 'yaml');
  assert.equal(hljsLang('text/plain'), null);
  assert.equal(highlightCode('<tag> & text', undefined, null), '&lt;tag> &amp; text');
  assert.equal(highlightLine('<tag> & text', undefined, null), '&lt;tag> &amp; text');
  assert.equal(highlightCode(null, null, null), '');
  const calls: string[] = [];
  // Only the highlighter methods this module consumes, at the library boundary.
  const hljs = {
    getLanguage: (lang: string) => lang === 'ts',
    highlight: (_text: string, options: { language: string }) => {
      calls.push(options.language);
      return { value: '<span>typed</span>' };
    },
    highlightAuto: () => { calls.push('auto'); return { value: 'automatic' }; },
  } as unknown as HLJSApi;
  assert.equal(highlightCode('let n', 'text/typescript', hljs), '<span>typed</span>');
  assert.equal(highlightCode('plain', 'text/plain', hljs), 'automatic');
  assert.equal(highlightLine('plain', 'text/plain', hljs), 'plain', 'line rendering never auto-detects');
  assert.deepEqual(calls, ['ts', 'auto']);
  hljs.highlight = () => { throw new Error('grammar failed'); };
  hljs.highlightAuto = () => { throw new Error('auto failed'); };
  assert.equal(highlightLine('<x>', 'text/typescript', hljs), '&lt;x>');
  assert.equal(highlightCode('<x>', 'text/plain', hljs), '&lt;x>');
  assert.throws(() => highlightCode('x', 'text/typescript', hljs), /grammar failed/,
    'the move does not add a new catch around a known-language code highlight');
});

test('CSV output characterizes the existing simple splitter without changing its semantics', () => {
  assert.equal(renderCsv(null), '');
  assert.equal(renderCsv(''), '<table><thead><tr><th></th></tr></thead><tbody></tbody></table>');
  assert.equal(renderCsv(' name, value \n "one", <two>'),
    '<table><thead><tr><th>name</th><th>value</th></tr></thead><tbody><tr><td>one</td><td>&lt;two></td></tr></tbody></table>');
  assert.equal(renderCsv('a,b\n"x,y",z'),
    '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>x</td><td>y</td><td>z</td></tr></tbody></table>',
    'quoted commas are intentionally not reinterpreted in a mechanical extraction');
});

function context(overrides: Partial<PreviewRenderContext> = {}): PreviewRenderContext {
  return {
    currentFile: null, pdfContainer: null, htmlPreviewEl: null,
    download: async () => ({ data: '' }), onHighlight() {}, openPath() {},
    ...overrides,
  };
}

test('creating renderers and rendering empty surfaces does not load a heavy library', async () => {
  const renderers = createPreviewRenderers(context({ onHighlight: () => assert.fail('no highlighter requested') }));
  // Partial DOM boundary: the early-return query is all this path reads.
  const empty = { querySelectorAll: () => [] } as unknown as HTMLElement;
  await renderers.renderMermaidBlocks(empty);
  await renderers.renderPdf('');
  await renderers.resolveImages(null);
  renderers.dispose();
});

test('image resolution retains document-relative paths, MIME inference and missing-image text', async () => {
  const image = (src: string) => ({
    src, alt: '',
    getAttribute(name: string) { return name === 'src' ? this.src : null; },
  });
  const images = [image('photo.jpg'), image('/shared/icon.svg'), image('https://example.com/a.png'), image('data:image/png;base64,eA=='), image('missing.png')];
  const downloads: string[] = [];
  const renderers = createPreviewRenderers(context({
    currentFile: { path: '/docs/readme.md' },
    download: async path => {
      downloads.push(path);
      if (path.endsWith('missing.png')) throw new Error('missing');
      return { data: 'eA==', name: path };
    },
  }));
  await renderers.resolveImages({ querySelectorAll: () => images } as unknown as HTMLElement);
  assert.deepEqual(downloads, ['/docs/photo.jpg', '/shared/icon.svg', '/docs/missing.png']);
  assert.equal(images[0]!.src, 'data:image/jpeg;base64,eA==');
  assert.equal(images[1]!.src, 'data:image/svg+xml;base64,eA==');
  assert.equal(images[4]!.alt, '[missing.png]');
  assert.equal(mimeFromName('PHOTO.JPG'), 'image/jpeg');
  assert.equal(mimeFromName('unknown'), 'image/png');
});

test('iframe path handlers are replaced on load and removed on Files disposal', () => {
  const doc = new EventTarget();
  // Node 22's EventTarget needs the object form when removing capture
  // listeners; normalize this test boundary to the browser Document behavior.
  const remove = doc.removeEventListener.bind(doc);
  doc.removeEventListener = (type, listener, options) =>
    remove(type, listener, typeof options === 'boolean' ? { capture: options } : options);
  const opened: string[] = [];
  const renderers = createPreviewRenderers(context({
    htmlPreviewEl: { contentDocument: doc } as unknown as HTMLIFrameElement,
    openPath: path => opened.push(path),
  }));
  const click = () => {
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'target', { value: { closest: () => ({
      getAttribute: () => '../next.md',
      href: 'http://localhost:5173/next.md',
    }) } });
    doc.dispatchEvent(event);
    return event.defaultPrevented;
  };
  renderers.attachHtmlPreviewLinks();
  renderers.attachHtmlPreviewLinks();
  assert.equal(click(), true);
  assert.deepEqual(opened, ['../next.md'], 'exactly one installed path router');
  renderers.dispose();
  assert.equal(click(), false);
});

test('heavy imports remain lazy and each failed loader remains retryable', async () => {
  // Dynamic import/CSS/worker wiring is a build contract; browser checks cover
  // the actual PDF/mermaid/highlight output after the move.
  const source = await readFile(new URL('./file-preview.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import(?!\s+type\b)[^\n]* from '(?:pdfjs-dist|mermaid|highlight\.js)/mu);
  for (const [loader, pending] of [['loadHljs', 'hljsLoading'], ['loadMermaid', 'mermaidLoading'], ['loadPdfjs', 'pdfjsLoading']]) {
    assert.match(source, new RegExp(`function ${loader}\\(\\) \\{\\s*if \\(${pending}\\) return ${pending};`, 'u'));
    assert.ok(source.includes(`.catch(() => { ${pending} = null; return null; })`));
  }
  assert.match(source, /import\('highlight\.js\/styles\/github-dark\.min\.css'\)/u);
  assert.match(source, /import\('pdfjs-dist\/build\/pdf\.worker\.min\.mjs\?url'\)/u);
});
