// The Hub's search box, pure part (board #432). What a query is, what a result
// row shows, and nothing about when or where: the request lifecycle is
// `hub-search.svelte.ts`, the surface is `HubSearch.svelte`.
//
// The match itself is the SERVER's (`hub_search`): substring, ASCII-case-
// insensitive, body or sender. The excerpt marks the same thing in the text a
// row shows, so the mark and the hit cannot disagree.

/** One search hit as the server returns it (`message_json`): enough to draw a
 * row and to ask the Hub to open the message. */
export interface SearchHit {
  id: string;
  seq: number;
  /** Epoch milliseconds. */
  ts: number;
  /** Who said it (the wire field is `from`). */
  from: string;
  /** The room it was said in (`proj:<session>` or a named room). */
  room: string;
  body: string;
}

/** A piece of text and whether it is the part that matched. Drawn as text
 * nodes, never as HTML, so a message body cannot inject markup. */
export interface Segment { text: string; mark: boolean }

/** The most words one search takes: the server refuses more (`MAX_SEARCH_TERMS` in
 * `server/hub_rpc.rs`; `HubSearch.source.test.ts` pins the two together), so the box says
 * so instead of sending a request that can only fail. */
export const SEARCH_MAX_TERMS = 32;

/** The terms of a query: split on whitespace, blanks gone. The server trims
 * and lower-cases each again; sending them already clean keeps the request,
 * the label and the excerpt on one definition. */
export function searchTerms(query: string): string[] {
  return query.split(/\s+/u).filter(Boolean);
}

/** The query as the request identifies it: terms joined by ONE space. Two
 * spellings of the same terms are the same request. */
export function normalizeQuery(query: string): string {
  return searchTerms(query).join(' ');
}

/** ASCII-only lower-casing, which keeps every index: `toLowerCase()` can change
 * a string's length (`İ`), and the excerpt cuts the ORIGINAL by indexes found
 * in the lowered copy. It is also exactly what the server's `lower()` does. */
const fold = (s: string): string => s.replace(/[A-Z]/gu, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Every [start, end) of a term in `text`, merged where they touch or overlap,
 * so "dep" and "deploy" in one word make ONE mark. */
function ranges(text: string, terms: readonly string[]): [number, number][] {
  const hay = fold(text);
  const found: [number, number][] = [];
  for (const term of terms) {
    const needle = fold(term);
    if (!needle) continue;
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      found.push([at, at + needle.length]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** `text` cut into marked and unmarked pieces. An empty term list marks nothing. */
export function highlight(text: string, terms: readonly string[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const [start, end] of ranges(text, terms)) {
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out.length ? out : [{ text, mark: false }];
}

/** The line a result row shows for a message body: newlines flattened, then a
 * window of at most `max` characters around the FIRST match (a little context
 * before it, the rest after), with … where text was cut. A body whose match
 * was only in the sender starts from its beginning. Marked like `highlight`. */
export function excerptOf(body: string, terms: readonly string[], max = 90, lead = 24): Segment[] {
  const flat = body.replace(/\s+/gu, ' ').trim();
  if (flat.length <= max) return highlight(flat, terms);
  const first = ranges(flat, terms)[0];
  let start = first ? Math.max(0, first[0] - lead) : 0;
  // A window that would end short of the text is pulled back to a full one,
  // so a match near the end does not leave the row half empty.
  start = Math.min(start, Math.max(0, flat.length - max));
  const end = Math.min(flat.length, start + max);
  const segs = highlight(flat.slice(start, end), terms);
  if (start > 0) segs.unshift({ text: '…', mark: false });
  if (end < flat.length) segs.push({ text: '…', mark: false });
  return segs;
}

/** The server answers oldest first (its contract is shared with `tmm log`);
 * a search box answers "where did I see that", usually recently, so the list
 * is newest first. */
export function newestFirst<T>(hits: readonly T[]): T[] {
  return [...hits].reverse();
}
