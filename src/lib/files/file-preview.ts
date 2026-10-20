/// <reference types="vite/client" />
import type { HLJSApi } from 'highlight.js';
import { installExternalLinkHandler } from '../core/external-links.ts';
import { installPathLinkHandler } from '../core/path-links.ts';

type Pdfjs = typeof import('pdfjs-dist');
type Mermaid = typeof import('mermaid')['default'];

export interface PreviewFile {
  name: string;
  path: string;
  stat?: { mime_hint?: string | null };
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
 * mint) there is no base and the CSP admits `data:` and inline styles only. */
export function basedPreviewDoc(content: string, scope: PreviewScope | null, parser: DOMParser = new DOMParser()): string {
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
  return out;
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

/** The preview frame's links: a fragment scrolls in the document, a path
 * opens in Files, an external URL leaves through its handler, and any other
 * activation is prevented — a frame under the scope base never navigates. */
function installHtmlPreviewLinks(doc: Document | null, openPath: (path: string) => void): () => void {
  if (!doc) return () => {};
  const fragment = (event: Event) => {
    const mouse = event as MouseEvent;
    if (mouse.defaultPrevented) return;
    const anchor = (mouse.target as Element | null)?.closest?.('a[href]');
    const href = anchor?.getAttribute('href')?.trim() ?? '';
    if (!href.startsWith('#')) return;
    mouse.preventDefault();
    // Only a plain primary click scrolls; a middle or modified click (a
    // "new tab" gesture) is prevented and does nothing (review P2).
    const plain = mouse.type === 'click' && mouse.button === 0
      && !mouse.ctrlKey && !mouse.metaKey && !mouse.shiftKey && !mouse.altKey;
    if (plain) scrollToFragment(doc, href);
  };
  const rest = (event: Event) => {
    if ((event.target as Element | null)?.closest?.('a[href], area[href]')) event.preventDefault();
  };
  doc.addEventListener('click', fragment, true);
  doc.addEventListener('auxclick', fragment, true);
  const removePaths = installPathLinkHandler(doc, openPath);
  const removeExternal = installExternalLinkHandler(doc);
  doc.addEventListener('click', rest, true);
  doc.addEventListener('auxclick', rest, true);
  return () => {
    doc.removeEventListener('click', fragment, true);
    doc.removeEventListener('auxclick', fragment, true);
    removePaths();
    removeExternal();
    doc.removeEventListener('click', rest, true);
    doc.removeEventListener('auxclick', rest, true);
  };
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
  function attachHtmlPreviewLinks() {
    removeHtmlPreviewLinks();
    const doc = context.htmlPreviewEl?.contentDocument ?? null;
    removeHtmlPreviewLinks = installHtmlPreviewLinks(doc, context.openPath);
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
