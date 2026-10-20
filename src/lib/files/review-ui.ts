// Board #434: the DOM side of review annotations — reading a selection out of
// the preview, finding a stored range in it again for the highlight, the
// per-instance highlight registry, and the small rules the cards and the
// feedback hand-off share. The mapping itself is `review-anchor.ts`.

import { codeRange, markdownRange, rangeToOffsets, toUtf16, type Mapped, type Range } from './review-anchor.ts';
import { GENERATED_UNIT, type BlockMap, type SeenUnit } from '../core/markdown.ts';

/** The code preview's rows, in order (`.cl-row .cl-code`). */
function codeRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.cl-row .cl-code')];
}

/** UTF-16 offset of `(node, offset)` inside `el`'s text. */
function offsetIn(el: Element, node: Node, offset: number): number {
  const r = el.ownerDocument.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return r.toString().length;
}

/** The DOM point at UTF-16 offset `off` of `el`'s text. */
function pointAt(el: Element, off: number): { node: Node; offset: number } {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  let left = off;
  let last: Node | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n.nodeValue ?? '').length;
    if (left <= len) return { node: n, offset: left };
    left -= len;
    last = n;
  }
  return last ? { node: last, offset: (last.nodeValue ?? '').length } : { node: el, offset: 0 };
}

/** What a selection inside the code preview maps to, or null when it is not
 * one (outside, collapsed, or in the gutter only). `lines` is the LINE model
 * of the file. */
export function codeSelection(root: ParentNode, sel: Range | globalThis.Range | null, lines: readonly string[]): Mapped | null {
  const r = sel as globalThis.Range | null;
  if (!r || r.collapsed) return null;
  const rows = codeRows(root);
  const rowOf = (n: Node) => rows.findIndex((row) => row.contains(n));
  const a = rowOf(r.startContainer), b = rowOf(r.endContainer);
  if (a < 0 || b < 0) return null;
  return codeRange(lines, { row: a, offset: offsetIn(rows[a]!, r.startContainer, r.startOffset) }, { row: b, offset: offsetIn(rows[b]!, r.endContainer, r.endOffset) });
}

/** Rendered regions that show generated text, not source: a KaTeX render
 * (or its error), a mermaid diagram or its code before the diagram lands.
 * Each is ONE unit in the walk, as in the source map. */
const GENERATED = '.katex, .katex-display, .katex-error, .mermaid-block, code.language-mermaid';

/** One shown unit of a block in the DOM: a non-whitespace UTF-16 unit of a
 * text node, or a whole generated element. */
type DomUnit = { node: Node; i: number; gen: boolean; ch: string };

/** A block's shown units, in document order. */
function domUnits(block: Element): DomUnit[] {
  const out: DomUnit[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) {
      const v = n.nodeValue ?? '';
      for (let i = 0; i < v.length; i++) if (!/\s/u.test(v[i]!)) out.push({ node: n, i, gen: false, ch: v[i]! });
      return;
    }
    if (n.nodeType !== 1) return;
    if ((n as Element).matches(GENERATED)) { out.push({ node: n, i: 0, gen: true, ch: GENERATED_UNIT }); return; }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  for (let c = block.firstChild; c; c = c.nextSibling) walk(c);
  return out;
}

/** The DOM units of stamped block `k`, IF they are exactly what the source
 * map says the block shows (unit for unit); otherwise null — the block is
 * refused, never mapped by a near match. */
function aligned(el: Element, block: BlockMap | undefined): { dom: DomUnit[]; seen: SeenUnit[] } | null {
  const seen = block?.seen;
  if (!seen) return null;
  const dom = domUnits(el);
  if (dom.length !== seen.length) return null;
  for (let i = 0; i < dom.length; i++) {
    if (dom[i]!.gen !== seen[i]!.gen || (!dom[i]!.gen && dom[i]!.ch !== seen[i]!.ch)) return null;
  }
  return { dom, seen };
}

/** The top-level stamped blocks, in order: the k-th is the map's k-th. */
const stamped = (root: Element) => [...root.children].filter((el) => el.hasAttribute('data-src'));

/** What a selection inside the markdown preview maps to (reviewer P1-A on
 * 5b2a004f), or null when it is not one. The touched blocks are walked
 * and checked against the source map (`core/markdown.ts`
 * `markdownSourceMap`); the units the selection covers WHOLLY give the range,
 * from the first one's source to the last one's. Nothing is searched, so a
 * selection is never resolved to another occurrence. A block that does not
 * align, or a document with no map, is refused. */
export function markdownSelection(root: HTMLElement, sel: globalThis.Range | null, src: string, map: BlockMap[] | null): Mapped | null {
  if (!sel || sel.collapsed || !root.contains(sel.commonAncestorContainer)) return null;
  const blocks = stamped(root);
  if (!map || map.length !== blocks.length) return { refused: 'reviewRefusedRendered' };
  const units: SeenUnit[] = [];
  for (let k = 0; k < blocks.length; k++) {
    const el = blocks[k]!;
    if (!sel.intersectsNode(el)) continue;
    const a = aligned(el, map[k]);
    if (!a) return { refused: 'reviewRefusedRendered' };
    a.dom.forEach((u, i) => {
      const inside = u.gen ? sel.intersectsNode(u.node)
        : sel.comparePoint(u.node, u.i) === 0 && sel.comparePoint(u.node, u.i + 1) === 0;
      if (inside) units.push(a.seen[i]!);
    });
  }
  return markdownRange(src, units);
}

/** The DOM range of a stored range in the CODE preview, or null when its
 * rows are not rendered (past the line cap). */
export function codeHighlight(root: ParentNode, range: Range, lines: readonly string[]): globalThis.Range | null {
  const rows = codeRows(root);
  const a = rows[range.line - 1], b = rows[range.end_line - 1];
  if (!a || !b) return null;
  const doc = a.ownerDocument;
  const r = doc.createRange();
  const s = pointAt(a, toUtf16(lines[range.line - 1] ?? '', range.col));
  const e = pointAt(b, toUtf16(lines[range.end_line - 1] ?? '', range.end_col));
  r.setStart(s.node, s.offset);
  r.setEnd(e.node, e.offset);
  return r;
}

/** The DOM range of a stored range in the MARKDOWN preview: the shown units
 * whose source lies in it, through the same checked walk as a selection.
 * Null when none is shown (a block that does not align, a range only over
 * markup or a formula): the card stays, with no highlight. */
export function markdownHighlight(root: HTMLElement, range: Range, src: string, map: BlockMap[] | null): globalThis.Range | null {
  const off = rangeToOffsets(src, range);
  const blocks = stamped(root);
  if (!off || !map || map.length !== blocks.length) return null;
  const [s, e] = off;
  let first: DomUnit | null = null, last: DomUnit | null = null;
  for (let k = 0; k < blocks.length; k++) {
    const b = map[k]!;
    if (b.lines[1] < range.line || b.lines[0] > range.end_line) continue;
    const a = aligned(blocks[k]!, b);
    if (!a) continue;
    a.seen.forEach((u, i) => {
      if (u.gen || u.to <= s || u.from >= e) return;
      first ??= a.dom[i]!;
      last = a.dom[i]!;
    });
  }
  if (!first || !last) return null;
  const f: DomUnit = first, l: DomUnit = last;
  const r = root.ownerDocument.createRange();
  r.setStart(f.node, f.i);
  r.setEnd(l.node, l.i + 1);
  return r;
}

/** The two highlight names, styled once in app.css (`::highlight(review)`,
 * `::highlight(review-hot)`). `CSS.highlights` is one registry per document
 * and a Files page and the Hub drawer's Files can both be painting, so each
 * instance adds and removes only ITS OWN ranges in the shared `Highlight`
 * (review P2) and never clears the registry. */
export const HIGHLIGHT = 'review';
export const HIGHLIGHT_HOT = 'review-hot';

type HighlightLike = { add(r: globalThis.Range): unknown; delete(r: globalThis.Range): unknown; size: number };

/** One instance's hold on a highlight name: `set` replaces this instance's
 * ranges (and no one else's), `clear` removes them. `null` where the Custom
 * Highlight API is absent (Chromium 105+, Safari 17.2+, Firefox 140+): the
 * cards still work, with no highlight. */
export function ownHighlight(win: Window & typeof globalThis, name: string): { set: (ranges: globalThis.Range[]) => void; clear: () => void } | null {
  const reg = (win as unknown as { CSS?: { highlights?: Map<string, HighlightLike> } }).CSS?.highlights;
  const Ctor = (win as unknown as { Highlight?: new (...r: globalThis.Range[]) => HighlightLike }).Highlight;
  if (!reg || !Ctor) return null;
  let mine: globalThis.Range[] = [];
  const clear = () => {
    const h = reg.get(name);
    if (h) { for (const r of mine) h.delete(r); if (!h.size) reg.delete(name); }
    mine = [];
  };
  return {
    set(ranges) {
      clear();
      if (!ranges.length) return;
      let h = reg.get(name);
      if (!h) { h = new Ctor(); reg.set(name, h); }
      for (const r of ranges) h.add(r);
      mine = [...ranges];
    },
    clear,
  };
}

/** Which project a previewed file's comments belong to (delta 2 P1-C): the
 * projects whose root holds the file, innermost root only. `session` is the
 * Files instance's own project (the Hub drawer's room, the page's current
 * session): among several at that root it is the declared one, never a
 * guess. `chosen` is null when the person has to pick. */
export function reviewProjects<P extends { id: string; path: string; session: string }>(projects: readonly P[], file: string, session: string): { candidates: P[]; chosen: P | null } {
  const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/u, '') : p);
  const holds = (root: string) => file === root || file.startsWith(root === '/' ? '/' : `${root}/`);
  const covering = projects.filter((p) => p.path && holds(strip(p.path)));
  if (!covering.length) return { candidates: [], chosen: null };
  const depth = Math.max(...covering.map((p) => strip(p.path).length));
  const candidates = covering.filter((p) => strip(p.path).length === depth);
  const chosen = candidates.length === 1 ? candidates[0]! : candidates.find((p) => p.session === session) ?? null;
  return { candidates, chosen };
}

/** The feedback block appended to a draft: after the text already there,
 * separated by a blank line. Pure. */
export function appendDraft(current: string, block: string): string {
  const head = current.replace(/\s+$/u, '');
  return head ? `${head}\n\n${block}` : block;
}

/** An unsaved comment (delta 2 P1-C), kept in the server's review state
 * (`review-state.ts`) under `draftKey`. A new comment keeps the range it was
 * opened for; a stale one keeps its text, and the next selection's ＋
 * reopens it. Every write stores a new object, and the object IS the draft's
 * identity: a save forgets only the very object it submitted. */
export type NoteDraft = { text: string; range?: Range; revision?: string; quote?: string };
/** `(project_id, path)` for a new comment, plus the annotation id for an edit. */
export const draftKey = (projectId: string, path: string, id = '') => JSON.stringify([projectId, path, id]);
