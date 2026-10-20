// Review annotations (board #434): the ONE place a rendered selection becomes
// a raw source range. Everything else about an annotation — the stored
// anchor, relocation, the feedback block — is the server's
// (`projects::review`); this module only maps what the person selected in
// the preview to wire coordinates, or refuses.
//
// Wire coordinates (delta 1, defined once): `line` 1-based; `col` 1-based in
// Unicode scalar values (code points), never UTF-16 units; ranges end
// EXCLUSIVE. The text is the LINE model (delta 2): `\r\n` and `\n` end a line,
// a lone `\r` is a character — the Rust `review::Model`, mirrored here by
// `reviewLines`. A selection is mapped uniquely or refused (delta 2 P1-A(2)):
// a guess would store the comment against the wrong text for good.

export type Range = { line: number; col: number; end_line: number; end_col: number };
/** `refused` is the i18n key of the reason, shown where the ＋ would be. */
export type Mapped = { range: Range } | { refused: string };

/** The LINE model's lines (Rust `review::Model`): split on `\r\n` or `\n`. */
export function reviewLines(src: string): string[] {
  return src.split(/\r\n|\n/u);
}

/** A UTF-16 offset in `text` → its 1-based scalar column. */
export function toScalarCol(text: string, utf16: number): number {
  return [...text.slice(0, Math.max(0, utf16))].length + 1;
}

/** A 1-based scalar column in `text` → its UTF-16 offset. */
export function toUtf16(text: string, col: number): number {
  return [...text].slice(0, Math.max(0, col - 1)).join('').length;
}

/**
 * A selection in the CODE preview, by row: `row` is the 0-based line index
 * (the `.cl-row` order) and `offset` the UTF-16 offset into that row's text.
 * A row's text is its LINE-model line, plus the CR of a CRLF or the
 * zero-width space an empty row shows; both are past the last column, so an
 * offset there clamps to the line's end. Rows map directly: no search.
 */
export function codeRange(lines: readonly string[], start: { row: number; offset: number }, end: { row: number; offset: number }): Mapped {
  const at = (p: { row: number; offset: number }) => {
    const text = lines[p.row];
    if (text === undefined) return null;
    const len = [...text].length;
    return { line: p.row + 1, col: Math.min(toScalarCol(text, p.offset), len + 1) };
  };
  const a = at(start), b = at(end);
  if (!a || !b) return { refused: 'reviewRefusedOutside' };
  const range = { line: a.line, col: a.col, end_line: b.line, end_col: b.col };
  if (b.line < a.line || (b.line === a.line && b.col <= a.col)) return { refused: 'reviewRefusedEmpty' };
  const sel = lines.slice(a.line - 1, b.line).map((l, k, all) => {
    const cs = [...l];
    const from = k === 0 ? a.col - 1 : 0;
    const to = k === all.length - 1 ? b.col - 1 : cs.length;
    return cs.slice(from, to).join('');
  });
  if (!sel.join('\n').trim()) return { refused: 'reviewRefusedBlank' };
  return { range };
}

/** LINE-model UTF-16 offsets `[from, to)` → wire coordinates. */
export function offsetsToRange(src: string, from: number, to: number): Range {
  const text = reviewLines(src).join('\n');
  const at = (off: number) => {
    const head = text.slice(0, off);
    const nl = head.lastIndexOf('\n');
    return { line: head.split('\n').length, col: toScalarCol(text.slice(nl + 1), off - nl - 1) };
  };
  const a = at(from), b = at(to);
  return { line: a.line, col: a.col, end_line: b.line, end_col: b.col };
}

/** Wire coordinates → LINE-model UTF-16 offsets `[from, to)`, or null when
 * the range is not in `src`. */
export function rangeToOffsets(src: string, r: Range): [number, number] | null {
  const lines = reviewLines(src);
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const at = (line: number, col: number) => {
    const text = lines[line - 1];
    return text === undefined || col > [...text].length + 1 ? null : starts[line - 1]! + toUtf16(text, col);
  };
  const a = at(r.line, r.col), b = at(r.end_line, r.end_col);
  return a === null || b === null || b <= a ? null : [a, b];
}

/** What a selection in the MARKDOWN preview maps to (board #434, reviewer
 * P1-A on 5b2a004f): the source map units it covers, in order, from the
 * DOM walk that was checked against the map (`review-ui.ts`). Nothing is
 * searched, so nothing can be found twice: the range runs from the first
 * selected unit's source to the last's. Only whitespace is refused, and so
 * is a selection that touches a generated region (a formula, a diagram). */
export function markdownRange(src: string, units: readonly { from: number; to: number; gen: boolean }[]): Mapped {
  if (!units.length) return { refused: 'reviewRefusedBlank' };
  if (units.some((u) => u.gen)) return { refused: 'reviewRefusedGenerated' };
  return { range: offsetsToRange(src, units[0]!.from, units[units.length - 1]!.to) };
}
