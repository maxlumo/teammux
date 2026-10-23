// Board #434, the HTML preview's SOURCE side: what each text node shows, tied
// to LINE-text offsets by parse5's recorded positions (files-review.md §
// HTML). The DOM side, which checks it against the frame, is review-html.ts.

import { editable, GEN, HIDDEN, type HtmlUnit } from './review-html.ts';

type Parse5 = typeof import('parse5');
type Entities = typeof import('entities');
let loading: Promise<[Parse5, Entities]> | null = null;
/** parse5 and entities load on first use, never at startup: the ONE lazy
 * entry (orchestrator ruling). */
export function loadHtmlParser(): Promise<[Parse5, Entities]> {
  loading ??= Promise.all([import('parse5'), import('entities')]).catch((e) => { loading = null; throw e; });
  return loading;
}

type P5Node = {
  nodeName: string; tagName?: string; value?: string; attrs?: { name: string; value: string }[];
  childNodes?: P5Node[]; content?: P5Node;
  sourceCodeLocation?: { startOffset: number; endOffset: number } | null;
};

/** What a text node's raw source shows, unit by unit, or null when its
 * decoding is not provably the node's value. A reference is recognised only
 * with its semicolon (`&name;`, `&#n;`, `&#xn;`) and decoded by entities'
 * decodeHTML, the rules parse5 itself uses; every unit it shows shares its
 * whole span. Anything else — a legacy reference without its semicolon, a
 * slice that is not the node's whole text (foster parenting, a split
 * source) — fails the final equality and refuses the document. */
function textUnits(raw: string, start: number, value: string, decode: (s: string) => string, out: HtmlUnit[]): boolean {
  let shown = '';
  const push = (text: string, from: number, to: number) => {
    shown += text;
    for (const ch of text) for (let k = 0; k < ch.length; k++) if (!/\s/u.test(ch)) out.push({ ch: ch[k]!, from, to, gen: false });
  };
  for (let i = 0; i < raw.length;) {
    if (raw[i] === '&') {
      const ref = /^&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/u.exec(raw.slice(i, i + 40))?.[0];
      if (ref) {
        const text = decode(ref);
        if (text !== ref) { push(text, start + i, start + i + ref.length); i += ref.length; continue; }
      }
    }
    const cp = raw.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    push(ch, start + i, start + i + ch.length);
    i += ch.length;
  }
  return shown === value;
}

/**
 * The review source map of an HTML document: its shown units in document
 * order, each tied to the LINE text. Null when it cannot be proved: a lone
 * CR, a text node without a location, a decoding that does not equal the
 * node's value. parse5 runs with scripting OFF, as the sandboxed frame does,
 * so `<noscript>` parses as markup in both.
 */
export async function htmlSourceMap(content: string): Promise<HtmlUnit[] | null> {
  if (/\r(?!\n)/u.test(content)) return null;
  const line = content.replace(/\r\n/gu, '\n');
  const [p5, ent] = await loadHtmlParser();
  const doc = p5.parse(line, { sourceCodeLocationInfo: true, scriptingEnabled: false }) as unknown as P5Node;
  const out: HtmlUnit[] = [];
  const walk = (n: P5Node): boolean => {
    if (n.nodeName === '#text') {
      // Whitespace shows no unit, wherever error recovery put it (the
      // newline after </html> lands in the body without a location).
      if (!/\S/u.test(n.value ?? '')) return true;
      const loc = n.sourceCodeLocation;
      if (!loc) return false;
      return textUnits(line.slice(loc.startOffset, loc.endOffset), loc.startOffset, n.value ?? '', ent.decodeHTML, out);
    }
    if (n.nodeName === '#comment' || n.nodeName === '#documentType') return true;
    const tag = n.tagName ?? '';
    if (HIDDEN.has(tag)) return true;
    if (tag && editable(tag, (name) => n.attrs?.find((a) => a.name === name)?.value ?? null)) {
      const loc = n.sourceCodeLocation;
      out.push({ ch: GEN, from: loc?.startOffset ?? 0, to: loc?.endOffset ?? 0, gen: true });
      return true;
    }
    for (const c of n.childNodes ?? []) if (!walk(c)) return false;
    return true;
  };
  return walk(doc) ? out : null;
}
