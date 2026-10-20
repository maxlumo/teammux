// The bare file-path grammar (board #431, owner 2026-10-20: "对聊天会话里出现的
// 文件路径 … 做更好的识别"). Agents write paths as plain text far more often
// than as `[text](path)` links: `src/lib/hub/Feed.svelte:118`, `/tmp/x/`,
// `~/.config/tmux-mobile/config.toml`. This module says what counts as one.
//
// Two layers, kept apart (#431 review P2), plus the code-span rule below:
// - the LEXICON, `matchPath(src, prev)`: is there a path at the start of
//   `src`, given the character before it?
// - the SCANNABLE REGIONS, `findPaths(text)`: where in PLAIN text to look.
//   Every URL is masked whole first, so a query like `?p=src/a.rs` is never
//   read as a path. It knows nothing about markdown: fences, code spans and
//   links are the renderer's context (core/markedSafeUrl.ts), and every other
//   caller states its own.
//
// The case table `path-grammar.cases.json` is the contract. This module's
// test runs every row, and the Rust twin (#432, `tmm log --files` and the
// server's file list) runs the same file. A row one side fails is a grammar
// disagreement, never a per-side exception.
//
// A path is ONE of four forms, optionally followed by `:line` or
// `:line:col` (digits):
//   A absolute   `/seg/…`, with at least two slashes in all: `/tmp/x` and
//                `/tmp/` match, `/compact` (a slash command) does not;
//   H home       `~/…`;
//   R explicit   `./…`, `../…`;
//   W workspace  `seg/…/name.ext`: at least one slash, a file-like LAST
//                segment (a name, a dot, an extension of 1-10 characters that
//                starts with a letter), and a FIRST segment with no dot unless
//                it starts with one (`.github/ci.yml` matches,
//                `github.com/a/b.js` and `v1.2/x.md` do not).
// Segments are ASCII letters, digits and `. _ - @ + % ~`; `=` is a left
// boundary, never part of a path (`--manifest-path=src-tauri/Cargo.toml`
// links `src-tauri/Cargo.toml`). Not supported,
// on purpose: spaces, non-ASCII segments, `#L12` fragments, and relative
// directories without `./` in prose (`foo/bar/` is too often prose).
//
// A code span is a third context, `codeSpanPath(body)`: its whole content is
// one of the forms above, or a workspace directory (`lab/out/x/`, #443). A
// table row's optional `code` field is what `codeSpanPath(input)` returns.

/** Where a bare URL or path ends: CJK and fullwidth characters. Code points
 * U+2E80-U+9FFF (CJK radicals through unified ideographs), U+3000-U+303F (CJK
 * punctuation), U+3040-U+30FF (Hiragana, Katakana), U+AC00-U+D7AF (Hangul
 * syllables), U+FF00-U+FFEF (halfwidth and fullwidth forms). Shared with the
 * URL autolinker, which is where it was first defined. */
export const STOP = /[\u2E80-\u9FFF\u3000-\u303F\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/u;

export interface PathMatch {
  /** The matched source text, `:line[:col]` included: the link's text. */
  raw: string;
  /** The filesystem path, without the line suffix. */
  path: string;
  line?: number;
  col?: number;
}

export interface FoundPath extends PathMatch {
  /** Offsets into the scanned string (UTF-16 units). Not part of the shared
   * case table: Rust counts bytes. */
  start: number;
  end: number;
}

const RUN = /^[A-Za-z0-9._@+%~/-]+/u;
const RUN_CHAR = /[A-Za-z0-9._@+%~/-]/u;
const LINE = /^:(\d+)(?::(\d+))?/u;
const FILE_LIKE = /^.+\.[A-Za-z][A-Za-z0-9]{0,9}$/u;

/** May a path start right after `prev`? The start of the text, whitespace,
 * one of `( " ' = ,`, or a CJK/fullwidth character. Never after a letter,
 * digit, `/`, `.`, `:` or `@`: that keeps `host:/a/b`, URL tails and
 * `a.b/c.d` fragments out. */
function leftOk(prev: string): boolean {
  return prev === '' || /\s/u.test(prev) || `("'=,`.includes(prev) || STOP.test(prev);
}

/** Trailing dots are sentence punctuation unless they ARE a path segment
 * that names a different directory (#431 review P1-A): `/tmp/x.` ends at
 * `/tmp/x`; `/tmp/..`, `../..` and `/tmp/...` stay whole. A single trailing
 * `.` segment is the directory before it (`/tmp/h2/.` is `/tmp/h2/`), so a
 * sentence's full stop after a directory is dropped, unless what is left would
 * no longer be a path (`./.` stays). Stripping never changes which directory
 * is named. */
function stripDots(p: string): string {
  const last = p.slice(p.lastIndexOf('/') + 1);
  if (/^\.{2,}$/u.test(last)) return p;
  if (last === '.') {
    const cut = p.slice(0, -1);
    return isPath(cut) ? cut : p;
  }
  return p.replace(/\.+$/u, '');
}

/** May `first` open a form-W path? Not empty, not `~user`, and no dot unless
 * it starts with one (`.github` yes, `github.com` and `v1.2` no). */
function workspaceFirst(first: string): boolean {
  return first !== '' && !first.startsWith('~') && !(first.includes('.') && !first.startsWith('.'));
}

function isPath(p: string): boolean {
  if (p.startsWith('//')) return false;
  if (p.startsWith('/')) return (p.match(/\//gu)?.length ?? 0) >= 2;
  if (p.startsWith('~/')) return p.length > 2;
  if (p.startsWith('./')) return p.length > 2;
  if (p.startsWith('../')) return p.length > 3;
  if (!p.includes('/')) return false;
  const segs = p.split('/');
  return workspaceFirst(segs[0]!) && FILE_LIKE.test(segs.at(-1)!);
}

/** The path at the start of `src`, or null. `prev` is the character before
 * it ('' at the start of the text). */
export function matchPath(src: string, prev: string): PathMatch | null {
  if (!leftOk(prev)) return null;
  const run = RUN.exec(src)?.[0];
  if (!run) return null;
  const suffix = LINE.exec(src.slice(run.length));
  const path = suffix ? run : stripDots(run);
  if (!isPath(path)) return null;
  if (!suffix) return { raw: path, path };
  const out: PathMatch = { raw: path + suffix[0], path, line: Number(suffix[1]) };
  if (suffix[2] !== undefined) out.col = Number(suffix[2]);
  return out;
}

/** The path an inline code span's WHOLE content is, or null (a span that only
 * contains one, `cargo test src/a.rs`, stays a command to copy). One more form
 * than prose (#443, owner 2026-10-20): a workspace DIRECTORY, two or more
 * segments and a trailing slash (`lab/out/x_audition/`), first segment as in
 * form W. Prose `foo/bar/` stays unlinked; a span is the writer marking a name. */
export function codeSpanPath(body: string): PathMatch | null {
  const hit = matchPath(body, '');
  if (hit) return hit.raw === body ? hit : null;
  if (!body.endsWith('/') || RUN.exec(body)?.[0] !== body) return null;
  const segs = body.slice(0, -1).split('/');
  if (segs.length < 2 || segs.includes('') || !workspaceFirst(segs[0]!)) return null;
  return { raw: body, path: body };
}

const URL_REGION = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/gu;

/** The paths in PLAIN text, in order. URLs (a scheme and `://`, up to
 * whitespace or a STOP character, query and fragment included) are masked
 * whole first. After a rejected position the scan moves ONE character on,
 * and `leftOk` decides whether a path may start there: never after a letter,
 * digit, `.`, `/` or `@`, so no fragment of a rejected run (`a.b/c.d`) is
 * read as a path. */
function* scan(text: string): Generator<FoundPath> {
  const masked = new Uint8Array(text.length);
  for (const m of text.matchAll(URL_REGION)) {
    const stop = m[0].search(STOP);
    masked.fill(1, m.index, m.index + (stop < 0 ? m[0].length : stop));
  }
  let i = 0;
  while (i < text.length) {
    if (masked[i] || !RUN_CHAR.test(text[i]!)) { i++; continue; }
    const hit = matchPath(text.slice(i), i === 0 ? '' : text[i - 1]!);
    if (hit && !masked.subarray(i, i + hit.raw.length).includes(1)) {
      yield { ...hit, start: i, end: i + hit.raw.length };
      i += hit.raw.length;
      continue;
    }
    i++;
  }
}

export function findPaths(text: string): FoundPath[] {
  return [...scan(text)];
}

/** Where the first path in `text` starts, or -1: the renderer's hint for
 * where its tokenizer should look next. */
export function firstPathAt(text: string): number {
  for (const hit of scan(text)) return hit.start;
  return -1;
}
