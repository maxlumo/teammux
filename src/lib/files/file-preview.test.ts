import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { HLJSApi } from 'highlight.js';
import {
  basedPreviewDoc, createPreviewRenderers, defaultWrapForMime, highlightCode, highlightLine,
  hljsLang, isPreviewable, mimeCategory, mimeFromName, renderCsv, scrollToFragment, streamsInline,
  type PreviewRenderContext,
} from './file-preview.ts';
import { JSDOM, requestInterceptor } from 'jsdom';

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

// Board #433: an HTML preview is rebased onto its signed scope.
const at = (url: string, prefix: string) => ({ url, prefix });
const SCOPE = at('https://gw.example/tmux/dl/s/9/1.2/sig/L3A/site/', 'https://gw.example/tmux/dl/s/');
const parse = (html: string) => new new JSDOM('').window.DOMParser().parseFromString(html, 'text/html');
const based = (html: string, scope = SCOPE) => basedPreviewDoc(html, scope, new new JSDOM('').window.DOMParser());

test('the preview leads its head with the scope CSP, no referrer and the one base', () => {
  const doc = parse(based('<!doctype html><html lang="en"><head><title>T</title></head><body><p>hi</p></body></html>'));
  const lead = [...doc.head.children].slice(0, 3);
  assert.equal(lead[0]!.getAttribute('http-equiv'), 'Content-Security-Policy');
  const csp = lead[0]!.getAttribute('content');
  assert.equal(csp, "default-src 'none'; img-src https://gw.example/tmux/dl/s/ data:; "
    + "style-src https://gw.example/tmux/dl/s/ 'unsafe-inline'; font-src https://gw.example/tmux/dl/s/ data:; "
    + "media-src https://gw.example/tmux/dl/s/; form-action 'none'; base-uri https://gw.example/tmux/dl/s/");
  assert.doesNotMatch(csp!, /script-src|https:\/\/gw\.example\/tmux\/dl\/s\/9/u, 'no script source; the prefix is the door, not this cap');
  assert.equal(lead[1]!.getAttribute('name'), 'referrer');
  assert.equal(lead[1]!.getAttribute('content'), 'no-referrer');
  assert.equal(lead[2]!.tagName, 'BASE');
  assert.equal(lead[2]!.getAttribute('href'), SCOPE.url);
  assert.equal(doc.querySelectorAll('base').length, 1);
  assert.equal(doc.documentElement.getAttribute('lang'), 'en');
  assert.equal(doc.querySelector('p')!.textContent, 'hi');
  assert.match(based('<!doctype html><p>x</p>'), /^<!DOCTYPE html><html>/u);
  assert.match(based('<p>x</p>'), /^<!DOCTYPE html><html>/u, 'one fixed doctype, whatever the author wrote');
});

test('an author doctype is never quoted back: its identifiers cannot open an element before the policy', () => {
  const vectors = [
    `<!DOCTYPE html SYSTEM '"><img src="https://example.invalid/sys">'><p>x</p>`,
    `<!DOCTYPE html SYSTEM '"<img src=x'><p>x</p>`,
    `<!DOCTYPE html PUBLIC '"<img src=x ' "y"><p>x</p>`,
    `<!DOCTYPE html PUBLIC "a'b" '"<iframe src=y '><p>x</p>`,
    `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"><p>x</p>`,
  ];
  for (const scope of [SCOPE, null]) {
    for (const vector of vectors) {
      const out = basedPreviewDoc(vector, scope, new new JSDOM('').window.DOMParser());
      assert.match(out, /^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/u, vector);
      const doc = parse(out);
      // The first vector's inner `>` already ends its doctype in the FIRST
      // parse, so its <img> is the author's body element; no reparse adds one.
      assert.equal(doc.querySelectorAll('img, iframe').length, parse(vector).querySelectorAll('img, iframe').length, vector);
      assert.equal(doc.head.firstElementChild!.getAttribute('http-equiv'), 'Content-Security-Policy');
      assert.equal(doc.head.previousElementSibling, null);
      for (const el of doc.querySelectorAll('img, iframe')) assert.equal(el.closest('body') !== null, true, 'only in the body, after the policy');
      assert.equal(doc.querySelector('p')!.textContent, 'x');
    }
  }
});

test('the output is refused unless, parsed again, it leads with its policy', () => {
  // A parser whose second parse loses the policy stands for any serializer
  // break the fixtures above do not know yet.
  const real = new new JSDOM('').window.DOMParser();
  let calls = 0;
  const breaking = { parseFromString: (s: string, t: DOMParserSupportedType) => real.parseFromString(++calls === 2 ? '<img src="x"><p>x</p>' : s, t) } as DOMParser;
  assert.throws(() => basedPreviewDoc('<p>x</p>', SCOPE, breaking), /does not lead with its policy/u);
});

test('an author base and a refresh are removed, inert text is kept', () => {
  const out = based(`<head><base href="https://evil.example/"><meta http-equiv=" REFRESH " content="0;url=https://evil.example/">
    <meta http-equiv="content-type" content="text/html; charset=utf-8"></head>
    <body><base href="/late/"><template><base href="/tpl/"></template><!-- <base href="/c/"> -->
    <pre>&lt;base href="/text/"&gt;</pre></body>`);
  const doc = parse(out);
  assert.deepEqual([...doc.querySelectorAll('base')].map(b => b.getAttribute('href')), [SCOPE.url]);
  assert.equal([...doc.querySelectorAll('meta[http-equiv]')].filter(m => /refresh/iu.test(m.getAttribute('http-equiv')!)).length, 0);
  assert.equal(doc.querySelectorAll('meta[http-equiv="content-type"]').length, 1, 'only a refresh is removed');
  assert.ok(out.includes('<template><base href="/tpl/"></template>'), 'template content is inert and untouched');
  assert.ok(out.includes('<!-- <base href="/c/"> -->'));
  assert.ok(out.includes('&lt;base href="/text/"&gt;'));
});

test("an author's referrer policy, meta or attribute, is removed so ours holds", () => {
  for (const scope of [SCOPE, null]) {
    const doc = parse(basedPreviewDoc(`<head><meta name=" Referrer " content="unsafe-url"><meta name="viewport" content="w"></head>
      <img src="a.png" referrerpolicy="unsafe-url"><a href="x" referrerpolicy="origin">x</a><link rel="stylesheet" href="s.css" referrerpolicy="unsafe-url">`,
      scope, new new JSDOM('').window.DOMParser()));
    assert.deepEqual([...doc.querySelectorAll('meta[name]')].map(m => [m.getAttribute('name'), m.getAttribute('content')]),
      [['referrer', 'no-referrer'], ['viewport', 'w']]);
    assert.equal(doc.querySelectorAll('[referrerpolicy]').length, 0);
  }
});

test('the CSP prefix keeps the proxy path and cannot be split by the URL', () => {
  const direct = parse(based('<p>', at('http://10.0.0.2:7681/dl/s/9/1.2/s/L3A/', 'http://10.0.0.2:7681/dl/s/'))).querySelector('meta')!.getAttribute('content')!;
  assert.match(direct, /img-src http:\/\/10\.0\.0\.2:7681\/dl\/s\/ data:/u);
  const odd = parse(based('<p>', at('https://gw.example/a;b,c/dl/s/9/1.2/s/L3A/x/', 'https://gw.example/a;b,c/dl/s/'))).querySelector('meta')!.getAttribute('content')!;
  assert.match(odd, /img-src https:\/\/gw\.example\/a%3Bb%2Cc\/dl\/s\/ data:;/u);
  assert.equal(odd.split(';').length, 7, 'seven directives, none injected');
  assert.throws(() => based('<p>', at('https://gw.example/dl?path=%2Fx', 'https://gw.example/dl?')), /not a scope URL/u);
  assert.throws(() => based('<p>', at('https://other.example/dl/s/9/1.2/s/L3A/', 'https://gw.example/dl/s/')), /not a scope URL/u, 'the URL begins with its prefix');
  // A proxy prefix that itself holds /dl/s/: the policy is the connection's
  // whole door prefix, never the URL cut at its first /dl/s/ (review P2).
  const nested = parse(based('<p>', at('https://gw.example/dl/s/proxy/dl/s/9/1.2/s/L3A/', 'https://gw.example/dl/s/proxy/dl/s/'))).querySelector('meta')!.getAttribute('content')!;
  assert.match(nested, /img-src https:\/\/gw\.example\/dl\/s\/proxy\/dl\/s\/ data:;/u);
});

test('with no scope the page keeps no base and its CSP admits data: and inline styles only', () => {
  const doc = parse(basedPreviewDoc('<head><base href="https://evil.example/"><meta http-equiv=refresh content="0"></head><p>x</p>',
    null, new new JSDOM('').window.DOMParser()));
  const lead = [...doc.head.children];
  assert.equal(lead[0]!.getAttribute('content'),
    "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'");
  assert.equal(lead[1]!.getAttribute('content'), 'no-referrer');
  assert.equal(doc.querySelectorAll('base, meta[http-equiv=refresh]').length, 0);
  assert.equal(doc.querySelector('p')!.textContent, 'x');
});

test('the transform parses inert: no script runs and nothing is fetched', async () => {
  const requests: string[] = [];
  const window = new JSDOM('', { runScripts: 'dangerously', resources: { interceptors: [requestInterceptor((request) => {
    requests.push(request.url);
    return Promise.resolve(new Response('', { headers: { 'Content-Type': 'text/css' } }));
  })] } }).window;
  (window as unknown as { hit: () => void }).hit = () => requests.push('script');
  const out = basedPreviewDoc('<script>hit()</script><img src="a.png" onerror="hit()"><link rel="stylesheet" href="s.css">'
    + '<iframe src="f.html"></iframe>', SCOPE, new window.DOMParser());
  assert.deepEqual(requests, []);
  // The control: the same loader does see a live document's request.
  window.document.head.innerHTML = '<link rel="stylesheet" href="https://gw.example/s.css">';
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(requests, ['https://gw.example/s.css']);
  assert.ok(out.includes('<script>hit()</script>'), 'the sandbox, not the transform, keeps scripts from running');
});

test('a fragment link scrolls its own document by id, then by name, decoded once', () => {
  const doc = parse('<a id="top-link" href="#">top</a><h2 id="sec">S</h2><h2 id="中文">Z</h2><a name="a b"></a><h2 id="%41">P</h2>');
  const scrolled: string[] = [];
  for (const el of doc.querySelectorAll('h2, a[name]')) {
    (el as HTMLElement).scrollIntoView = () => { scrolled.push(el.getAttribute('id') ?? `name:${el.getAttribute('name')}`); };
  }
  let top = 0;
  Object.defineProperty(doc, 'defaultView', { value: { scrollTo: () => { top++; } } });
  scrollToFragment(doc, '#sec');
  scrollToFragment(doc, '#%E4%B8%AD%E6%96%87');
  scrollToFragment(doc, '#中文');
  scrollToFragment(doc, '#a%20b');
  scrollToFragment(doc, '#%2541');
  scrollToFragment(doc, '#missing');
  scrollToFragment(doc, '#%E4');
  scrollToFragment(doc, '#');
  assert.deepEqual(scrolled, ['sec', '中文', '中文', 'name:a b', '%41']);
  assert.equal(top, 1);
});

test('in the preview frame a fragment scrolls, a path opens Files, and nothing navigates', () => {
  const window = new JSDOM('<a id="f" href="#sec">f</a><h2 id="sec">S</h2><a id="p" href="next.html">p</a>'
    + '<a id="m" href="mailto:x@y">m</a><map><area id="a" href="z.html"></map><span id="n">n</span>').window;
  const doc = window.document;
  const scrolled: string[] = [];
  (doc.getElementById('sec') as HTMLElement).scrollIntoView = () => { scrolled.push('sec'); };
  const opened: string[] = [];
  const renderers = createPreviewRenderers(context({
    htmlPreviewEl: { contentDocument: doc } as unknown as HTMLIFrameElement,
    openPath: path => opened.push(path),
  }));
  renderers.attachHtmlPreviewLinks();
  const click = (id: string) => {
    const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    doc.getElementById(id)!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const gesture = (id: string, init: MouseEventInit, type = 'click') => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    doc.getElementById(id)!.dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(gesture('f', { button: 1 }, 'auxclick'), true, 'a middle click on a fragment is prevented');
  assert.equal(gesture('f', { ctrlKey: true }), true);
  assert.equal(gesture('f', { metaKey: true }), true);
  assert.equal(gesture('f', { shiftKey: true }), true);
  assert.deepEqual(scrolled, [], '... and none of them scrolls');
  assert.equal(click('f'), true);
  assert.deepEqual(scrolled, ['sec']);
  assert.deepEqual(opened, [], 'a fragment never reaches Files');
  assert.equal(click('p'), true);
  assert.deepEqual(opened, ['next.html']);
  assert.equal(click('m'), true, 'an unknown scheme is prevented');
  assert.equal(click('a'), true, 'an area is prevented');
  assert.equal(click('n'), false, 'a click on no link is left alone');
  renderers.dispose();
  assert.equal(click('f'), false);
});
