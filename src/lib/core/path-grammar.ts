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
// Segments are ASCII letters, digits and `. _ - @ + % ~`, and LETTERS of any
// script INSIDE a path (board #100, owner 2026-11-09: "这里的有中文的文件路径，
// 好像有问题": `/tmp/fontctl-preview-f6u3hm48/乐米月萤宋-preview.png` linked only
// up to the CJK file name): a run of non-ASCII letters or digits joins the
// path when the path goes on right after it, through a `/`, `-` or `_`, or
// a `.` followed by an ASCII letter or digit (`乐米月萤宋-preview.png`,
// `中文目录/file.txt`, `报告.pdf`). A run that ENDS the token stays prose,
// as before: `/foo/bar已更新` is `/foo/bar`, and so is `src/a.rs第3行` (a
// digit after the run is not the path going on). A path still starts with
// an ASCII character, and CJK punctuation and fullwidth forms always stop
// it. `=` is a left boundary, never part of a path
// (`--manifest-path=src-tauri/Cargo.toml` links `src-tauri/Cargo.toml`).
// Not supported, on purpose: spaces, `#L12` fragments, and relative
// directories without `./` in prose (`foo/bar/` is too often prose).
//
// A code span is a third context, `codeSpanPath(body)`: its whole content is
// one of the forms above, or a workspace directory (`lab/out/x/`, #443). A
// table row's optional `code` field is what `codeSpanPath(input)` returns.

/** Where a bare URL ends, and where a path ends unless a letter run inside
 * it is followed by more path (`takeRun`): CJK and fullwidth characters. Code points
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
/** Letters or digits of another script that may sit INSIDE a path (#100):
 * not ASCII, a letter or a number by Unicode property (Alphabetic, \p{N}:
 * `〇` is a number), never punctuation and never a fullwidth form. The Rust
 * twin's `is_word` is the same set. */
const WORD_CHAR = /(?![\x00-\x7F\uFF00-\uFFEF])[\p{Alphabetic}\p{N}]/u;
const WORD_RUN = new RegExp(`^(?:${WORD_CHAR.source})+`, 'u');


/** The path-shaped runs at the start of `src`, shortest first: ASCII path
 * characters, then each run of other letters the path goes on after (#100
 * rounds 0-1, orchestrator note 7): followed by ANY path character that is
 * still there once sentence dots are dropped (`报告v1.pdf`, `文件2026.md`,
 * `中文Dir/file.txt`, `乐米月萤宋-preview.png`). A run that ends the token
 * (`/foo/bar已更新`, `已更新.`) is prose. Every cut is a candidate: the
 * longest that is a path wins (`src/a.rs第3行` is `src/a.rs`, since
 * `src/a.rs第3` is not file-like). */
function takeRuns(src: string): string[] {
  let out = RUN.exec(src)?.[0] ?? '';
  if (!out) return [];
  const cuts = [out];
  for (;;) {
    const rest = src.slice(out.length);
    const word = WORD_RUN.exec(rest)?.[0];
    if (!word) return cuts;
    // Round 2 (orchestrator note 13): the rest of the token (path and word
    // characters, sentence dots dropped) must carry a PATH SIGNAL, a further
    // `/` or a `.` + an ASCII letter or digit; a bare letter or digit tail
    // (`第3行`) is prose in every path form.
    const token = /^(?:[A-Za-z0-9._@+%~/-]|(?![\x00-\x7F\uFF00-\uFFEF])[\p{Alphabetic}\p{N}])*/u.exec(rest.slice(word.length))?.[0] ?? '';
    const signal = /\/|\.[A-Za-z0-9]/u.test(token.replace(/\.+$/u, ''));
    if (!signal) return cuts;
    out += word + (RUN.exec(rest.slice(word.length))?.[0] ?? '');
    cuts.push(out);
  }
}
const takeRun = (src: string) => takeRuns(src).at(-1) ?? '';
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
  for (const run of takeRuns(src).reverse()) {
    const suffix = LINE.exec(src.slice(run.length));
    const path = suffix ? run : stripDots(run);
    if (!isPath(path)) continue;
    if (!suffix) return { raw: path, path };
    const out: PathMatch = { raw: path + suffix[0], path, line: Number(suffix[1]) };
    if (suffix[2] !== undefined) out.col = Number(suffix[2]);
    return out;
  }
  return null;
}

/** The path an inline code span's WHOLE content is, or null (a span that only
 * contains one, `cargo test src/a.rs`, stays a command to copy). One more form
 * than prose (#443, owner 2026-10-20): a workspace DIRECTORY, two or more
 * segments and a trailing slash (`lab/out/x_audition/`), first segment as in
 * form W. Prose `foo/bar/` stays unlinked; a span is the writer marking a name. */
export function codeSpanPath(body: string): PathMatch | null {
  const hit = matchPath(body, '');
  if (hit) return hit.raw === body ? hit : null;
  if (!body.endsWith('/') || takeRun(body) !== body) return null;
  const segs = body.slice(0, -1).split('/');
  if (segs.length < 2 || segs.includes('') || !workspaceFirst(segs[0]!)) return null;
  return { raw: body, path: body };
}

const URL_REGION = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S*/gu;
/** Does `c` (one CODE POINT) end a URL's mask? (#100 rounds 1-3,
 * orchestrator notes 7, 13 and 20.) The ORIGINAL terminators: CJK
 * punctuation (U+3000-U+303F, except its letters and numbers by category,
 * so `〇` is not one) and the fullwidth forms. A symbol (`☃`), a CJK letter
 * or an astral letter (`𠮷`) inside a query is the URL's. This is URL
 * TERMINATION; `WORD_CHAR` is path-run ADMISSION, a different question. */
export const isUrlTerminator = (c: string): boolean => {
  const cp = c.codePointAt(0) ?? 0;
  return (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0x3000 && cp <= 0x303F && !/[\p{Alphabetic}\p{N}]/u.test(c));
};
/** The UTF-16 offset where a URL's mask ends inside `text`, -1 for none:
 * classified by whole code points (for..of), offsets kept in UTF-16 units. */
const urlMaskEnd = (text: string): number => {
  let i = 0;
  for (const c of text) { if (isUrlTerminator(c)) return i; i += c.length; }
  return -1;
};

/** The paths in PLAIN text, in order. URLs (a scheme and `://`, up to
 * whitespace or a STOP character, query and fragment included) are masked
 * whole first. After a rejected position the scan moves ONE character on,
 * and `leftOk` decides whether a path may start there: never after a letter,
 * digit, `.`, `/` or `@`, so no fragment of a rejected run (`a.b/c.d`) is
 * read as a path. */
function* scan(text: string): Generator<FoundPath> {
  const masked = new Uint8Array(text.length);
  for (const m of text.matchAll(URL_REGION)) {
    const stop = urlMaskEnd(m[0]);
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
