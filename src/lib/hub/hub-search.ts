// The Hub's search box, pure part (board #432). What a query is, what a result
// row shows, and nothing about when or where: the request lifecycle is
// `hub-search.svelte.ts`, the surface is `HubSearch.svelte`.
//
// The match itself is the SERVER's (`hub_search`): substring, ASCII-case-
// insensitive, body or sender. The excerpt marks the same thing in the text a
// row shows, so the mark and the hit cannot disagree.

import type { FileMention } from '../core/ws-api.ts';

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

/** The project a file row came from, as the Hub knew it WHEN THE ANSWER LANDED (board #432
 * review): its id and session, and the folder it declared. Opening checks the project is still
 * that one; a relative path is never explained by a different project. */
export interface FileSource { id: string; session: string; path: string }

/** One file row of the Files mode: the wire shape (see `FileMention`) and the project it came from. */
export type FileHit = FileMention & { source: FileSource | null };

/** What the search box lists: the messages that match, or the files they mention. */
export type SearchMode = 'messages' | 'files';

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

/** A file row's identity, the same rule the server de-duplicates by: an absolute or `~` path is
 * one file wherever it was named, a relative one belongs to the room that named it. Pages of
 * one scan can repeat a key (an older message mentions it again); the client folds them. */
export function fileKey(f: Pick<FileHit, 'path' | 'room'>): string {
  return f.path.startsWith('/') || f.path.startsWith('~') ? f.path : `${f.room}\0${f.path}`;
}

/** Fold a later (OLDER) page into the rows so far: a file already listed keeps its newest
 * mention and only gains the page's count. The server never splits a message across pages,
 * so no mention is counted twice. */
export function mergeFiles(rows: readonly FileHit[], page: readonly FileHit[]): FileHit[] {
  const out = rows.map((r) => ({ ...r }));
  const at = new Map(out.map((r, i) => [fileKey(r), i] as const));
  for (const f of page) {
    const i = at.get(fileKey(f));
    const have = i === undefined ? undefined : out[i];
    if (have) have.count += f.count; else { at.set(fileKey(f), out.length); out.push({ ...f }); }
  }
  return out;
}

/** A path as a row draws it: the file name apart from the folder it is in. */
export function splitPath(path: string): { dir: string; name: string } {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? { dir: '', name: path } : { dir: path.slice(0, cut + 1), name: path.slice(cut + 1) };
}

/** `:12` or `:12:3` for a mention that named a line, else ''. */
export function lineSuffix(f: Pick<FileHit, 'line' | 'col'>): string {
  return f.line == null ? '' : f.col == null ? `:${f.line}` : `:${f.line}:${f.col}`;
}

/** A path cut for drawing: its folder and its file name apart, each with the parts a term
 * matched marked. Marked on the WHOLE path first, so a term that runs across the slash
 * ("src/ma") still marks both sides. */
export function pathParts(path: string, terms: readonly string[]): { dir: Segment[]; name: Segment[] } {
  const cut = splitPath(path).dir.length;
  const dir: Segment[] = [];
  const name: Segment[] = [];
  let at = 0;
  for (const seg of highlight(path, terms)) {
    const end = at + seg.text.length;
    if (at < cut) dir.push({ text: seg.text.slice(0, Math.max(0, cut - at)), mark: seg.mark });
    if (end > cut) name.push({ text: seg.text.slice(Math.max(0, cut - at)), mark: seg.mark });
    at = end;
  }
  return { dir: dir.filter((x) => x.text), name: name.filter((x) => x.text) };
}
