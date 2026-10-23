// Review comments on the HTML preview (board #434, files-review.md § HTML):
// the DOM side — the frame's walk, the check, the selection and the
// highlight. The source side (parse5's positions) is review-html-map.ts.
// The #433 frame shows `basedPreviewDoc(content)`; a selection in it maps to
// the SOURCE only through positions a spec parser recorded, checked unit for
// unit against the frame's own DOM, and is refused otherwise — the same rule
// as the markdown mapper.
//
// Coordinates, layer by layer (design delta 1):
//   raw bytes  → revision (sha256), unchanged;
//   content    → the frame, CRLF kept (the browser folds CRLF itself);
//   LINE text  → content with \r\n → \n; a lone \r refuses the document;
//                this is what parse5 reads, so its offsets ARE LINE offsets;
//   units      → {ch, from, to} in LINE UTF-16 units;
//   wire       → offsetsToRange (review-anchor.ts).

import { offsetsToRange, rangeToOffsets, type Mapped, type Range } from './review-anchor.ts';

/** One shown, non-whitespace UTF-16 unit and the LINE-text span `[from, to)`
 * that shows it. A character reference's units all share its whole span. A
 * generated unit (an editable or form region) maps to no selectable text. */
export type HtmlUnit = { ch: string; from: number; to: number; gen: boolean };

/** The one character a generated unit shows. */
export const GEN = '\uFFFF';

/** Subtrees whose text is not shown: the head (our CSP, base, meta and the
 * highlight style live there too), scripts, styles, templates, the title. */
export const HIDDEN = new Set(['head', 'script', 'style', 'template', 'title', 'noframes']);
/** Regions whose text is editable or a form control's: one generated unit,
 * never an anchor (design delta 1, P2). */
export const editable = (tag: string, attr: (name: string) => string | null) =>
  tag === 'textarea' || tag === 'select' || (attr('contenteditable') !== null && attr('contenteditable')!.toLowerCase() !== 'false');

/** One shown unit of the frame's DOM: a non-whitespace UTF-16 unit of a text
 * node, or a whole editable/form element. */
type DomUnit = { node: Node; i: number; gen: boolean; ch: string };

/** The frame document's shown units, walked by the same rules. */
function domUnits(doc: Document): DomUnit[] {
  const out: DomUnit[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const v = n.nodeValue ?? '';
      for (let i = 0; i < v.length; i++) if (!/\s/u.test(v[i]!)) out.push({ node: n, i, gen: false, ch: v[i]! });
      return;
    }
    if (n.nodeType !== 1) return;
    const el = n as Element;
    const tag = el.localName;
    if (HIDDEN.has(tag)) return;
    if (editable(tag, (name) => el.getAttribute(name))) { out.push({ node: el, i: 0, gen: true, ch: GEN }); return; }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  if (doc.documentElement) walk(doc.documentElement);
  return out;
}

/** The frame's units IF they are exactly the map's, unit for unit; else null.
 * Checked again at every selection and every paint, so a DOM changed under
 * the map (a contenteditable edit) is refused, never near-matched. */
export function alignedHtml(doc: Document, map: readonly HtmlUnit[] | null): DomUnit[] | null {
  if (!map) return null;
  const dom = domUnits(doc);
  if (dom.length !== map.length) return null;
  for (let i = 0; i < dom.length; i++) {
    if (dom[i]!.gen !== map[i]!.gen || (!dom[i]!.gen && dom[i]!.ch !== map[i]!.ch)) return null;
  }
  return dom;
}

/** The DOM-order run `map[i..j]` as ONE ordered source span, or null.
 * Proved in one bounded pass: each unit starts at or after the previous
 * one's end, or shares its whole span (a reference's units, the one allowed
 * equality); and no unit outside the run lies inside the span. Error
 * recovery can show text in another order than its source (foster
 * parenting moves table text before the table, keeping its later
 * location): a run that steps back, or whose span holds a unit the run does
 * not, is not provably one source range and is refused, never widened or
 * cut (reviewer P1 on 6a4950ec). */
function orderedSpan(map: readonly HtmlUnit[], i: number, j: number): [number, number] | null {
  for (let k = i + 1; k <= j; k++) {
    const a = map[k - 1]!, b = map[k]!;
    if (b.from < a.to && !(b.from === a.from && b.to === a.to)) return null;
  }
  const s = map[i]!.from, e = map[j]!.to;
  for (let k = 0; k < map.length; k++) {
    if (k >= i && k <= j) continue;
    const u = map[k]!;
    if (u.from < e && u.to > s) return null;
  }
  return [s, e];
}

/** A selection in the frame → its source range: the units it covers WHOLLY,
 * from the first one's source to the last one's, proved to be one ordered
 * span. Nothing is searched. A selection that covers part of a character
 * reference stores the whole reference (its units share its span). */
export function htmlSelection(doc: Document, sel: globalThis.Range | null, src: string, map: readonly HtmlUnit[] | null): Mapped | null {
  if (!sel || sel.collapsed || !doc.body?.contains(sel.commonAncestorContainer)) return null;
  const dom = alignedHtml(doc, map);
  if (!dom) return { refused: 'reviewRefusedRendered' };
  let i = -1, j = -1;
  for (let k = 0; k < dom.length; k++) {
    const u = dom[k]!;
    const inside = u.gen ? sel.intersectsNode(u.node)
      : sel.comparePoint(u.node, u.i) === 0 && sel.comparePoint(u.node, u.i + 1) === 0;
    if (!inside) continue;
    if (map![k]!.gen) return { refused: 'reviewRefusedGenerated' };
    if (i < 0) i = k;
    j = k;
  }
  if (i < 0) return { refused: 'reviewRefusedBlank' };
  // A reference half selected is selected whole: its units share one span.
  while (i > 0 && map![i - 1]!.from === map![i]!.from && map![i - 1]!.to === map![i]!.to) i--;
  while (j < map!.length - 1 && map![j + 1]!.from === map![j]!.from && map![j + 1]!.to === map![j]!.to) j++;
  const span = orderedSpan(map!, i, j);
  if (!span) return { refused: 'reviewRefusedOrder' };
  return { range: offsetsToRange(src, span[0], span[1]) };
}

/** A stored range → its DOM Range in the frame (that document's own Range):
 * the shown units whose source lies in it, when they are one DOM run in
 * source order (the same proof as a selection). Null when none is shown or
 * the order cannot be proved: the card stays without a highlight. */
export function htmlHighlight(doc: Document, range: Range, src: string, map: readonly HtmlUnit[] | null): globalThis.Range | null {
  const off = rangeToOffsets(src, range);
  const dom = alignedHtml(doc, map);
  if (!off || !dom) return null;
  const [s, e] = off;
  let first = -1, last = -1;
  for (let k = 0; k < map!.length; k++) {
    const u = map![k]!;
    if (u.gen || u.to <= s || u.from >= e) continue;
    if (first < 0) first = k;
    last = k;
  }
  if (first < 0) return null;
  // Every unit between first and last lies in the range once the run is in
  // source order, so the order proof is the whole check.
  if (!orderedSpan(map!, first, last)) return null;
  const r = doc.createRange();
  r.setStart(dom[first]!.node, dom[first]!.i);
  r.setEnd(dom[last]!.node, dom[last]!.i + 1);
  return r;
}
