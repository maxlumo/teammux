/// <reference types="vite/client" />
import type { HLJSApi } from 'highlight.js';
import { isExternalWebUrl, openExternalUrl } from '../core/external-links.ts';
import { pathRef } from '../core/path-links.ts';
import { clearOwnBack, markOwnBack } from '../core/own-back.ts';

type Pdfjs = typeof import('pdfjs-dist');
type Mermaid = typeof import('mermaid')['default'];

export interface PreviewFile {
  name: string;
  path: string;
  /** `motion`: a Motion Photo's embedded video window, from the server's stat (board #133). */
  stat?: { mime_hint?: string | null; motion?: { offset: number; length: number } | null };
  content?: string | null;
  dataUrl?: string;
  /** A stream-signed /dl URL the media element fetches ranges from itself (board #182). */
  mediaUrl?: string;
  pdfData?: string;
  convertedHtml?: string;
}

export interface PreviewRenderContext {
  readonly currentFile: { path?: string } | null;
  readonly pdfContainer: HTMLElement | null;
  readonly htmlPreviewEl: HTMLIFrameElement | null;
  download: (path: string) => Promise<{ data: string; name?: string }>;
  onHighlight: (hljs: HLJSApi) => void;
  openPath: (path: string) => void;
}

export function defaultWrapForMime(mime: string | null | undefined): boolean {
  return mime === 'text/markdown' || mime === 'text/plain';
}

/** Kinds the browser streams straight from /dl (a `<video>` or an `<audio>`
 * fetching its own ranges) — no bytes cross the RPC, so no size gate applies
 * (board #182, audio #416). */
export function streamsInline(stat: { mime_hint?: string | null; size?: number } | null | undefined): boolean {
  const category = mimeCategory(stat?.mime_hint);
  return category === 'video' || category === 'audio';
}

export function isPreviewable(stat: { mime_hint?: string; is_text?: boolean; size: number } | null, name?: string): boolean {
  if (!stat) return false;
  const m = stat.mime_hint || '';
  if (m === 'application/pdf') return true;
  if (m.startsWith('image/')) return true;
  if (streamsInline(stat)) return true;
  if (stat.is_text && stat.size <= 512 * 1024) return true;
  if (name && /\.pptx$/i.test(name)) return true;
  return false;
}

/** The info card's Type line (board #133): the MIME type, and for a Motion Photo the words
 * `motionWords` (with `{size}`) naming it and its embedded video's size. */
export function typeLine(stat: { mime_hint?: string | null; motion?: { length: number } | null }, formatSize: (bytes: number) => string, motionWords: string): string {
  const mime = stat.mime_hint ?? '';
  return stat.motion ? `${mime} · ${motionWords.replace('{size}', formatSize(stat.motion.length))}` : mime;
}

export function mimeCategory(mime: string | null | undefined) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/csv') return 'csv';
  if (mime === 'text/html') return 'html';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/toml' || mime === 'application/yaml') return 'code';
  return 'other';
}

export function hljsLang(mime: string | null | undefined): string | null {
  const map: Record<string, string> = {
    'text/javascript': 'js', 'text/typescript': 'ts', 'text/python': 'python',
    'text/rust': 'rust', 'text/css': 'css', 'text/shell': 'bash', 'text/sql': 'sql',
    'text/go': 'go', 'text/java': 'java', 'text/ruby': 'ruby', 'text/c': 'c',
    'text/cpp': 'cpp', 'text/svelte': 'html', 'text/vue': 'html',
    'application/json': 'json', 'application/toml': 'yaml', 'application/yaml': 'yaml',
  };
  return map[mime ?? ''] || null;
}

export function highlightCode(text: string | null | undefined, mime: string | null | undefined, hljs: HLJSApi | null): string {
  if (text == null) return '';
  if (!hljs) return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lang = hljsLang(mime);
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(text, { language: lang }).value;
  }
  try { return hljs.highlightAuto(text).value; } catch { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
}

// Per-line highlighting deliberately skips auto-detection and cross-line state.
export function highlightLine(line: string, mime: string | null | undefined, hljs: HLJSApi | null): string {
  if (!line) return '';
  const lang = hljs ? hljsLang(mime) : null;
  if (lang && hljs!.getLanguage(lang)) {
    try { return hljs!.highlight(line, { language: lang }).value; } catch {}
  }
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

export function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif' };
  return map[ext ?? ''] || 'image/png';
}

export function renderCsv(text: string | null | undefined): string {
  if (text == null) return '';
  const lines = text.trim().split('\n');
  if (!lines.length) return '';
  const rows = lines.map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  let html = '<table><thead><tr>';
  rows[0]!.forEach(h => html += `<th>${h.replace(/</g,'&lt;')}</th>`);
  html += '</tr></thead><tbody>';
  rows.slice(1).forEach(r => {
    html += '<tr>';
    r.forEach(c => html += `<td>${c.replace(/</g,'&lt;')}</td>`);
    html += '</tr>';
  });
  return html + '</tbody></table>';
}

/** A minted HTML preview scope: the base URL, and the door's prefix on this
 * connection (`<http origin><proxy prefix>/dl/s/`) that the URL begins with. */
export interface PreviewScope { url: string; prefix: string }

/** An HTML preview's document, rebased onto its signed scope (board #433).
 *
 * The srcdoc is parsed INERT (a DOMParser document runs no script and fetches
 * nothing), every author `<base>` and `<meta http-equiv=refresh>` is removed,
 * and three elements lead `<head>`: a CSP that lets subresources come from
 * the scope door and `data:` only (no remote host, no script, no form, no
 * other base), a no-referrer policy, and the base itself. The CSP's sources
 * are the scope's `prefix` — this connection's http(s) origin and proxy
 * prefix plus `/dl/s/`, which the URL must begin with — so they are never cut
 * out of the URL by searching it. With no scope (`null`: a refused or failed
 * mint) there is no base and the CSP admits `data:` and inline styles only.
 *
 * `baseStyle` (board #111, the project page): ONE stylesheet, marked
 * `data-tmm-base`, placed after ours and before the author's head, so the
 * page's own CSS wins; the Files preview passes none. */
export function basedPreviewDoc(content: string, scope: PreviewScope | null, parser: DOMParser = new DOMParser(), baseStyle?: string): string {
  return preparePreview(content, scope, parser, baseStyle).html;
}

/** The author's link targets, kept by the PARENT from the serialization: the
 * frame's links are rewritten to `about:srcdoc#tmm-link-<nonce>-<n>` and the
 * page never holds the table (board #111, leader note 16). */
export interface PreviewLinks { nonce: string; hrefs: string[] }

/** `basedPreviewDoc`, with the link table. ONE link mechanism in every engine
 * (board #111 W1, measured): WebKit runs no event listener in a script-less
 * frame, so a click on a link under the scope base navigated the frame to the
 * door and the page was gone. A same-document fragment of the srcdoc keeps the
 * document, its fields and its media in Chromium and WebKit alike, and the
 * parent reads it from the frame's hash (`watchPreviewLinks`). */
export function preparePreview(content: string, scope: PreviewScope | null, parser: DOMParser = new DOMParser(), baseStyle?: string): { html: string; links: PreviewLinks } {
  let prefix: string | null = null;
  const scopeUrl = scope?.url ?? null;
  if (scope != null) {
    if (!scope.prefix.endsWith('/dl/s/') || !scope.url.startsWith(scope.prefix)) throw new Error('not a scope URL');
    // `;` and `,` end a CSP directive and a source list; percent-encoded they
    // match the same path (CSP compares paths decoded).
    prefix = scope.prefix.replace(/;/gu, '%3B').replace(/,/gu, '%2C');
  }
  const doc = parser.parseFromString(content, 'text/html');
  for (const el of doc.querySelectorAll('base')) el.remove();
  for (const el of doc.querySelectorAll('meta[http-equiv]')) {
    if (el.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh') el.remove();
  }
  // A referrer policy is not an intersection like a CSP: the author's meta or
  // a per-element attribute would override ours (review P2), so both go.
  for (const el of doc.querySelectorAll('meta[name]')) {
    if (el.getAttribute('name')?.trim().toLowerCase() === 'referrer') el.remove();
  }
  for (const el of doc.querySelectorAll('[referrerpolicy]')) el.removeAttribute('referrerpolicy');
  // Links: every a[href] and area[href] becomes a fragment of the srcdoc; the
  // author's href goes to the parent's table. A target, download or ping
  // would make the click something other than that fragment, so they go.
  const links: PreviewLinks = { nonce: linkNonce(), hrefs: [] };
  for (const el of doc.querySelectorAll('a[href], area[href]')) {
    links.hrefs.push(el.getAttribute('href') ?? '');
    el.setAttribute('href', `about:srcdoc#tmm-link-${links.nonce}-${links.hrefs.length - 1}`);
    for (const attr of ['target', 'download', 'ping']) el.removeAttribute(attr);
  }
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  // No scope (a refused or failed mint): the page still reads, but loads
  // nothing; without a base a relative URL would reach the APP's origin.
  csp.setAttribute('content', (prefix == null ? [
    "default-src 'none'", 'img-src data:', "style-src 'unsafe-inline'", 'font-src data:',
    "base-uri 'none'", "form-action 'none'",
  ] : [
    "default-src 'none'", `img-src ${prefix} data:`, `style-src ${prefix} 'unsafe-inline'`,
    `font-src ${prefix} data:`, `media-src ${prefix}`, "form-action 'none'", `base-uri ${prefix}`,
  ]).join('; '));
  const referrer = doc.createElement('meta');
  referrer.setAttribute('name', 'referrer');
  referrer.setAttribute('content', 'no-referrer');
  if (scopeUrl == null) doc.head.prepend(csp, referrer);
  else {
    const base = doc.createElement('base');
    base.setAttribute('href', scopeUrl);
    doc.head.prepend(csp, referrer, base);
  }
  // Review comments' highlights (board #434): the ONE style the frame gets,
  // added after the policy, in the same DOM and the same serialization on
  // both paths, allowed by the policy's own 'unsafe-inline'. The app's colour
  // tokens are custom properties of the PAGE and do not cross into the frame's
  // document, so the colour is the system colour Highlight mixed over
  // transparent: no literal, and it follows the reader's platform. Without the
  // Custom Highlight API it does nothing and the cards stay.
  const review = doc.createElement('style');
  review.textContent = '::highlight(review){background-color:color-mix(in srgb,Highlight 30%,transparent)}'
    + '::highlight(review-hot){background-color:color-mix(in srgb,Highlight 55%,transparent)}';
  (scopeUrl == null ? referrer : doc.head.children[2]!).after(review);
  if (baseStyle != null) {
    const sheet = doc.createElement('style');
    sheet.setAttribute('data-tmm-base', '');
    sheet.textContent = baseStyle;
    review.after(sheet);
  }
  // SERIALIZED, never reassembled (#433 review, orchestrator ruling): a fixed
  // doctype, then the serializer's own output of the prepared element. This
  // is a structural guarantee, not the fix for a shown injection: quoting the
  // author's doctype identifiers back by hand was measured to put nothing
  // before the policy (the tokenizer ends a doctype at any `>`), but nothing
  // parsed should be re-quoted by hand, and the identifiers mean nothing in a
  // sandboxed preview.
  const out = '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  // The invariant the policy rests on, checked on the output itself: parsed
  // again, the policy is <head>'s first element and no element precedes it.
  const again = parser.parseFromString(out, 'text/html');
  const first = again.head.firstElementChild;
  if (again.head.previousElementSibling || !first || first.tagName !== 'META'
    || first.getAttribute('http-equiv') !== 'Content-Security-Policy'
    || first.getAttribute('content') !== csp.getAttribute('content')) {
    throw new Error('the prepared preview does not lead with its policy');
  }
  return { html: out, links };
}

function linkNonce(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A bare `#fragment` link scrolls the preview's own document. Under the
 * scope base the browser would resolve it against the /dl/s/ URL and
 * navigate the frame there (board #433). `#` alone goes to the top. */
export function scrollToFragment(doc: Document, href: string): void {
  const raw = href.trim().slice(1);
  if (!raw) { doc.defaultView?.scrollTo(0, 0); return; }
  let id = raw;
  try { id = decodeURIComponent(raw); } catch {}
  const target = doc.getElementById(id) ?? doc.getElementsByName(id)[0] ?? null;
  target?.scrollIntoView();
}

/** Where one author href goes: the ONE link logic of a preview frame (board
 * #433, routed since #111 from the frame's hash): a fragment scrolls in the
 * document, a path opens in the app, a web link leaves the app, and anything
 * else (javascript:, data:, mailto:, …) is dead. */
export function routePreviewHref(doc: Document | null, href: string, openPath: (path: string) => void, openWeb: (url: string) => unknown = openExternalUrl): 'fragment' | 'path' | 'web' | 'dead' {
  const raw = href.trim();
  if (raw.startsWith('#')) { if (doc) scrollToFragment(doc, raw); return 'fragment'; }
  const path = pathRef(raw);
  if (path) { openPath(path); return 'path'; }
  // `//host/x` is a network reference: the scheme of the gateway it came from.
  const web = raw.startsWith('//') ? `${(doc?.baseURI && /^https:/u.test(doc.baseURI)) ? 'https:' : 'http:'}${raw}` : raw;
  if (isExternalWebUrl(web)) { void openWeb(web); return 'web'; }
  return 'dead';
}

/** Watch a preview frame's links (board #111, leader notes 16 and 20): one
 * timer reads the frame's hash while `active()`; a `#tmm-link-<nonce>-<n>`
 * is a click (or a keyboard activation) on link n. The app's own
 * history.back() then removes the entry the click added (marked, so the app's
 * Back router cannot mistake it), and once the frame's hash has returned (or
 * after `settleMs`) the href is routed, exactly once. If the back cannot be
 * confirmed the hash is replaced, so the same link works again, and the
 * leftover history entry is the documented cost. Latency is the period. */
export function watchPreviewLinks(frame: HTMLIFrameElement, links: PreviewLinks, route: (href: string, doc: Document | null) => void,
  { active = () => true, periodMs = 50, settleMs = 400, history: hist = globalThis.history }: { active?: () => boolean; periodMs?: number; settleMs?: number; history?: History } = {}): () => void {
  const prefix = `#tmm-link-${links.nonce}-`;
  let pending: { href: string; hash: string; until: number } | null = null;
  const tick = () => {
    const doc = frame.contentDocument;
    const hash = doc?.location.hash ?? '';
    if (pending) {
      // The frame was dropped (its file, project or server changed, or it was
      // unmounted): its intent goes with it, never to whatever replaced it (S1).
      if (!frame.isConnected || !doc) { pending = null; clearOwnBack(); return; }
      if (hash === pending.hash && Date.now() < pending.until) return;
      const { href, hash: was } = pending;
      pending = null;
      clearOwnBack();
      if (hash === was) frame.contentWindow?.location.replace('about:srcdoc#tmm-idle');
      route(href, doc ?? null);
      return;
    }
    if (!active() || !hash.startsWith(prefix)) return;
    const n = Number(hash.slice(prefix.length));
    const href = Number.isInteger(n) ? links.hrefs[n] : undefined;
    if (href === undefined) return;
    pending = { href, hash, until: Date.now() + settleMs };
    markOwnBack(pending.until);
    hist.back();
  };
  const timer = setInterval(tick, periodMs);
  return () => { clearInterval(timer); if (pending) clearOwnBack(); };
}

/** Preserve Files' loader lifetime and live DOM/file reads during extraction.
 * The host supplies getters; opening/closing a preview does not recreate caches. */
export function createPreviewRenderers(context: PreviewRenderContext) {
  let hljsLoading: Promise<HLJSApi | null> | null = null;
  function loadHljs() {
    if (hljsLoading) return hljsLoading;
    hljsLoading = Promise.all([
      import('highlight.js/lib/core'),
      import('highlight.js/lib/languages/javascript'),
      import('highlight.js/lib/languages/typescript'),
      import('highlight.js/lib/languages/python'),
      import('highlight.js/lib/languages/rust'),
      import('highlight.js/lib/languages/css'),
      import('highlight.js/lib/languages/json'),
      import('highlight.js/lib/languages/bash'),
      import('highlight.js/lib/languages/xml'),
      import('highlight.js/lib/languages/yaml'),
      import('highlight.js/lib/languages/sql'),
      import('highlight.js/lib/languages/go'),
      import('highlight.js/lib/languages/java'),
      import('highlight.js/lib/languages/ruby'),
      import('highlight.js/lib/languages/markdown'),
      import('highlight.js/styles/github-dark.min.css'),
    ]).then(([core, javascript, typescript, python, rust, css, json, bash, xml, yaml, sql, go, java, ruby, markdown]) => {
      const h = core.default;
      h.registerLanguage('javascript', javascript.default);
      h.registerLanguage('js', javascript.default);
      h.registerLanguage('typescript', typescript.default);
      h.registerLanguage('ts', typescript.default);
      h.registerLanguage('python', python.default);
      h.registerLanguage('rust', rust.default);
      h.registerLanguage('css', css.default);
      h.registerLanguage('json', json.default);
      h.registerLanguage('bash', bash.default);
      h.registerLanguage('sh', bash.default);
      h.registerLanguage('html', xml.default);
      h.registerLanguage('xml', xml.default);
      h.registerLanguage('svg', xml.default);
      h.registerLanguage('yaml', yaml.default);
      h.registerLanguage('sql', sql.default);
      h.registerLanguage('go', go.default);
      h.registerLanguage('java', java.default);
      h.registerLanguage('ruby', ruby.default);
      h.registerLanguage('markdown', markdown.default);
      context.onHighlight(h);
      return h;
    }).catch(() => { hljsLoading = null; return null; });
    return hljsLoading;
  }

  let mermaidLoading: Promise<Mermaid | null> | null = null;
  function loadMermaid() {
    if (mermaidLoading) return mermaidLoading;
    mermaidLoading = import('mermaid').then(m => {
      m.default.initialize({ startOnLoad: false, theme: 'dark' });
      return m.default;
    }).catch(() => { mermaidLoading = null; return null; });
    return mermaidLoading;
  }

  let pdfjsLoading: Promise<Pdfjs | null> | null = null;
  function loadPdfjs() {
    if (pdfjsLoading) return pdfjsLoading;
    pdfjsLoading = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    }).catch(() => { pdfjsLoading = null; return null; });
    return pdfjsLoading;
  }

  async function renderPdf(data: string) {
    if (!context.pdfContainer) return;
    const pdfjsLib = await loadPdfjs();
    if (!pdfjsLib || !context.pdfContainer) return;
    context.pdfContainer.innerHTML = '';
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const pdf = await pdfjsLib.getDocument({ data: bytes, verbosity: 0 }).promise;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const scale = (context.pdfContainer.clientWidth || 360) / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = '100%';
      canvas.style.marginBottom = '4px';
      context.pdfContainer.appendChild(canvas);
      // Preserve the existing context-based render options during the move.
      await page.render({ canvasContext: canvas.getContext('2d'), viewport } as Parameters<typeof page.render>[0]).promise;
    }
  }

  let mermaidId = 0;
  async function renderMermaidBlocks(container: HTMLElement | null) {
    if (!container) return;
    const blocks = container.querySelectorAll('code.language-mermaid');
    if (!blocks.length) return;
    const mermaid = await loadMermaid();
    if (!mermaid) return;
    for (const block of blocks) {
      const pre = block.parentElement;
      const id = `mermaid-${++mermaidId}`;
      const div = document.createElement('div');
      div.className = 'mermaid-block';
      try {
        const { svg } = await mermaid.render(id, block.textContent!);
        div.innerHTML = svg;
      } catch { div.textContent = block.textContent; }
      pre!.replaceWith(div);
    }
  }

  let removeHtmlPreviewLinks = () => {};
  /** At each load of the HTML preview's frame: its links, by the one watcher. */
  function attachHtmlPreviewLinks(links: PreviewLinks | null) {
    removeHtmlPreviewLinks();
    removeHtmlPreviewLinks = () => {};
    const frame = context.htmlPreviewEl;
    if (!frame || !links) return;
    removeHtmlPreviewLinks = watchPreviewLinks(frame, links, (href, doc) => { routePreviewHref(doc, href, context.openPath); },
      { active: () => frame.isConnected && frame.getClientRects().length > 0 });
  }

  async function resolveImages(container: HTMLElement | null) {
    if (!container) return;
    const dir = context.currentFile?.path?.replace(/\/[^/]+$/, '') || '';
    const imgs = container.querySelectorAll<HTMLImageElement>('img[src]');
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:') || src.startsWith('http')) continue;
      const fullPath = src.startsWith('/') ? src : dir + '/' + src;
      try {
        const r = await context.download(fullPath);
        const mime = mimeFromName(r.name || src);
        img.src = `data:${mime};base64,${r.data}`;
      } catch { img.alt = `[${src}]`; }
    }
  }

  return {
    loadHljs, renderPdf, renderMermaidBlocks, resolveImages, attachHtmlPreviewLinks,
    dispose() { removeHtmlPreviewLinks(); },
  };
}
