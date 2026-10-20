// Shared safe markdown rendering for chat bodies and skill previews.
//
// Agent output is UNTRUSTED, and marked (v17) no longer sanitizes, so HTML is
// escaped FIRST — markdown syntax (**, #, ```fences```, tables, links) still
// renders, but raw <script>/<img onerror> becomes inert literal text.
// Memoized because chat re-renders on every poll/push. Extracted from
// Team.svelte when the Hub (and the skill preview) needed the same contract.
// Importing this module also registers the CJK-aware autolinker.
import { marked } from 'marked';
import katex from 'katex';
import './markedSafeUrl.ts';
import { LruCache } from './lru.ts';

// Strikethrough requires DOUBLE tildes here, unlike GFM, which also accepts
// `~x~`. A single tilde is a range separator in everyday Chinese text — the
// weather reply `26~32℃，东风微风 … 26~32℃` opened a <del> at the first tilde
// and closed it at the next one, striking out several lines of a real answer
// (owner report, 2026-08-16). Being unable to strike text out is a small loss;
// striking out text nobody asked to strike is a wrong rendering of the content.
// Kept to one line as well: a <del> that spans a `breaks: true` newline is how
// the damage spread.
//
// A tilde run that is not a valid `~~…~~` is CONSUMED as plain text, because an
// overridden tokenizer that returns false falls back to marked's own — so
// refusing the match is not enough to stop it, the characters have to be taken
// out of play.
marked.use({
  tokenizer: {
    // The signature is marked's own; the return is a Del token, a text token
    // that swallows the tildes, or false when this is not our business.
    del(this: any, src: string): any {
      if (!src.startsWith('~')) return false;
      const m = /^~~(?=\S)([^\n]*?\S)~~/.exec(src);
      if (m) {
        return { type: 'del', raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
      }
      const run = /^~+/.exec(src)![0];
      return { type: 'text', raw: run, text: run };
    },
  },
});

// Bounded LRU, not a clear-at-500 Map: past 500 distinct bodies the old bound
// dropped EVERYTHING mid-render, and every poll re-parsed every message with
// marked + KaTeX until the cache refilled (review C, 2026-09-03). The feed's
// working set — the loaded pages, each body rendered once per poll — stays hot.
const MARKDOWN_CACHE_MAX = 500;
const cache = new LruCache<string, string>(MARKDOWN_CACHE_MAX);

/** In the chat, rendered/raw is a view switch. Agents often wrap an entire
 * answer (or a quoted .md file inside an answer) in ```markdown even though the
 * user asked to SEE the formatted result. In rendered view that language fence
 * is therefore transparent: remove only its wrapper and let its contents go
 * through the normal Markdown parser. Raw view still reads `m.body` untouched.
 *
 * Fence length matters: a four-backtick markdown wrapper may legitimately
 * contain triple-backtick code blocks, so only an equally long (or longer)
 * closing run ends it. Other language fences remain ordinary code blocks. */
function unwrapMarkdownFences(src: string): { text: string; from: number[] } {
  const lines = src.split('\n');
  const out: string[] = [];
  const from: number[] = [];
  let fence: { char: '`' | '~'; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!fence) {
      const open = /^\s*(`{3,}|~{3,})\s*(?:markdown|md)\s*$/i.exec(line);
      if (!open) { out.push(line); from.push(i); continue; }
      fence = { char: open[1]![0] as '`' | '~', len: open[1]!.length };
      continue;
    }
    const close = new RegExp(`^\\s*\\${fence.char}{${fence.len},}\\s*$`);
    if (close.test(line)) { fence = null; continue; }
    out.push(line);
    from.push(i);
  }
  // An unclosed language fence is malformed source. Do not silently reinterpret
  // the rest of the message; marked's normal code-fence behavior is safer.
  return fence ? { text: src, from: lines.map((_, i) => i) } : { text: out.join('\n'), from };
}

/** LaTeX in a chat body (owner, 2026-08-26: "latex公式要正确渲染"). Both
 * families agents actually emit: `\(x\)` / `\[x\]` (what LLMs default to)
 * and `$x$` / `$$x$$`. Order in the pipeline is load-bearing:
 * - AFTER code is holed out, so `$i` in a shell snippet is never math;
 * - BEFORE the & / < escape, so KaTeX reads the raw TeX (`a < b`, `\&`);
 * - the rendered HTML is holed out and restored AFTER marked, so neither the
 *   escape nor the parser can touch KaTeX's markup (it is generated from
 *   text, never from the message's raw HTML).
 * Dollar-inline follows the pandoc guards, because chat is full of money:
 * the opener must not be preceded by a word char (US$5) and must be followed
 * by non-space; the closer must follow non-space and not precede a digit —
 * so "costs $5, earns $10" stays prose while `$O(n \log n)$` renders. */
function renderMath(text: string, holes: string[], replace: Replace = plainReplace): string {
  const hole = (displayMode: boolean) => (_m: string, tex: string) => {
    let html: string;
    try { html = katex.renderToString(tex.trim(), { displayMode, throwOnError: false }); }
    catch { return _m; } // hard parser failure: leave the source visible
    holes.push(html);
    return `\x00MATH${holes.length - 1}\x00`;
  };
  // No body may cross a `\x00` — that byte only ever marks a holed-out code
  // span, and a formula that swallowed one rendered the placeholder as TeX
  // while the code itself never came back (2026-09-03).
  text = replace(text, /\\\[([^\x00]+?)\\\]/g, hole(true));
  text = replace(text, /\\\(([^\x00]+?)\\\)/g, hole(false));
  text = replace(text, /\$\$([^\x00]+?)\$\$/g, hole(true));
  return replace(text, /(?<![\w$])\$(?!\s)([^$\n\x00]*?[^\s$\x00])\$(?!\d)/g, hole(false));
}

/** How a pipeline step rewrites the text. `renderMath` takes it so the one
 * pipeline (`prepare`) can rewrite its traced text through it. */
type Replace = (text: string, re: RegExp, fn: (m: string, g1: string) => string) => string;
const plainReplace: Replace = (text, re, fn) => text.replace(re, fn as (m: string, ...rest: string[]) => string);

/** CJK-friendly emphasis (board 311, owner 2026-10-08: `**sdk-s3-ane 更省。**同场对比`
 * showed its asterisks). CommonMark §6.2 lets a delimiter run close only when it
 * is right-flanking: a run after punctuation must be followed by whitespace or
 * punctuation. Chinese and Japanese put the full stop INSIDE the bold and go on
 * with no space, so `**粗体。**后面` never closed — while `**bold.**after` is the
 * same rule working as intended for English, and stays literal. The fix is the
 * cjk-friendly proposal: a CJK neighbour counts like punctuation for the
 * flanking test. marked exposes no hook into its flanking regexes, so the run
 * gets an invisible PUNCTUATION neighbour (U+FFFC, category So, which marked
 * reads as punctuation) on its CJK side, and the mark is stripped from the HTML
 * after parsing. Only maximal `*`/`_` runs with punctuation on one side and a
 * CJK character on the other are touched; `a ** b`, `5 * 3 * 2` and every
 * holed-out code span are not. The underscore's own intraword rule still applies
 * (`前__粗体。__后` stays literal, as `snake__case` must). */
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303F\\uFF00-\\uFFEF';
const FLANK = '\uFFFC';
// `\x00` bounds a holed-out code span or formula. marked will see the span's
// backtick there (punctuation), so the rule must read the boundary as one too.
const PUNCT = '\\p{P}\\p{S}\\x00';
const CLOSE_BEFORE_CJK = new RegExp(`(?<=[${PUNCT}])(?<![*_])(\\*+|_+)(?=[${CJK}])`, 'gu');
const OPEN_AFTER_CJK = new RegExp(`(?<=[${CJK}])(\\*+|_+)(?![*_])(?=[${PUNCT}])`, 'gu');
export function renderMarkdown(body: string | null | undefined, opts: { spans?: boolean } = {}): string {
  const src = body || '';
  const spans = opts.spans === true;
  const memo = spans ? spanCache : cache;
  const hit = memo.get(src);
  if (hit !== undefined) return hit;
  const html = render(src, spans);
  memo.set(src, html); // evicts the least recently used past the bound
  return html;
}

/** The review span render (board #434) has its OWN cache: a chat render is
 * never served with `data-src` and a span render never without it, whatever
 * order the two are asked in. */
const spanCache = new LruCache<string, string>(MARKDOWN_CACHE_MAX);

/** A string and, for each UTF-16 unit, where it came from (board #434): `o[i]`
 * is the unit's offset in the source the pipeline started from, and `g[i]`
 * says the unit is not source text (a placeholder, a flanking mark, padding).
 * A generated run carries the origin of the source it replaced, so a span
 * still covers its lines. Every pipeline step below rewrites a `Traced`, so
 * the source position of every character marked sees is KNOWN, never
 * re-derived. */
type Traced = { s: string; o: number[]; g: boolean[] };

const traced = (s: string): Traced => ({ s, o: Array.from({ length: s.length }, (_v, i) => i), g: new Array<boolean>(s.length).fill(false) });
const sliceT = (t: Traced, a: number, b: number): Traced => ({ s: t.s.slice(a, b), o: t.o.slice(a, b), g: t.g.slice(a, b) });
const joinT = (parts: Traced[]): Traced => ({ s: parts.map((p) => p.s).join(''), o: parts.flatMap((p) => p.o), g: parts.flatMap((p) => p.g) });
/** `text`, generated, standing for the source units `[from, last]`. */
const genT = (text: string, from: number, last: number): Traced =>
  ({ s: text, o: Array.from({ length: text.length }, (_v, i) => (i === text.length - 1 ? last : from)), g: new Array<boolean>(text.length).fill(true) });

/** `String.replace(re, fn)` on a traced text, for a global `re`. `fn` returns
 * a plain string (unchanged → the match keeps its origins; anything else is
 * generated over the match) or a `Traced` built from the match itself. */
function replaceT(t: Traced, re: RegExp, fn: (m: RegExpMatchArray) => string | Traced): Traced {
  const parts: Traced[] = [];
  let pos = 0;
  for (const m of t.s.matchAll(re)) {
    const at = m.index!;
    parts.push(sliceT(t, pos, at));
    const r = fn(m);
    const end = at + m[0].length;
    if (typeof r !== 'string') parts.push(r);
    else if (r === m[0]) parts.push(sliceT(t, at, end));
    else parts.push(genT(r, t.o[at] ?? 0, t.o[end - 1] ?? t.o[at] ?? 0));
    pos = end;
  }
  parts.push(sliceT(t, pos, t.s.length));
  return joinT(parts);
}

/** Everything before marked, ONCE, for both modes: the transparent ```md
 * wrapper removed, code holed out, math rendered into placeholders, the CJK
 * flanking marks, code restored, `&` and `<` escaped. In span mode the
 * source is the LINE model (`\r\n` → `\n`), so origins are LINE offsets; a
 * lone CR (marked's break, the LINE model's character) refuses spans. */
function prepare(source: string, spans: boolean): { escaped: Traced; mathHoles: string[]; lone: boolean; src: string } {
  const lone = spans && /\r(?!\n)/.test(source);
  const src = spans ? source.replace(/\r\n/g, '\n') : source;
  // The wrapper: kept lines with their own origins, each joined by the
  // newline that ended it in the source.
  const unwrapped = unwrapMarkdownFences(src);
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const whole = traced(src);
  let t: Traced = unwrapped.text === src ? whole : joinT(unwrapped.from.flatMap((line, k) => {
    const a = starts[line]!, b = (starts[line + 1] ?? src.length + 1) - 1;
    const kept = sliceT(whole, a, b);
    return k < unwrapped.from.length - 1 ? [kept, b < src.length ? sliceT(whole, b, b + 1) : genT('\n', b - 1, b - 1)] : [kept];
  }));
  // Hole out code so math extraction cannot reach into it, run math on the
  // RAW text, then put the code back for the normal escape + parse. In span
  // mode a hole keeps its newlines as padding, so it moves no line.
  const codeHoles: Traced[] = [];
  const pads: number[] = [];
  const mathHoles: string[] = [];
  const codeHole = (m: RegExpMatchArray): Traced => {
    const at = m.index!;
    codeHoles.push(sliceT(t, at, at + m[0].length));
    const pad = spans ? (m[0].match(/\n/g) ?? []).length : 0;
    pads.push(pad);
    return genT(`\x00CODE${codeHoles.length - 1}\x00${'\n'.repeat(pad)}`, t.o[at] ?? 0, t.o[at + m[0].length - 1] ?? 0);
  };
  t = replaceT(t, /(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, codeHole);
  t = replaceT(t, /`[^`\n]+`/g, codeHole);
  renderMath(t.s, mathHoles, (text, re, fn) => {
    t = replaceT(t, re, (m) => fn(m[0], m[1]!));
    return t.s;
  });
  // The CJK flanking marks (cjk-friendly emphasis, above): an invisible
  // punctuation neighbour on the CJK side of a `*`/`_` run.
  const mark = (before: boolean) => (m: RegExpMatchArray): Traced => {
    const at = m.index!;
    const run = sliceT(t, at, at + m[0].length);
    const f = genT(FLANK, t.o[before ? at : at + m[0].length - 1] ?? 0, t.o[before ? at : at + m[0].length - 1] ?? 0);
    return before ? joinT([f, run]) : joinT([run, f]);
  };
  t = replaceT(t, CLOSE_BEFORE_CJK, mark(false));
  t = replaceT(t, OPEN_AFTER_CJK, mark(true));
  t = replaceT(t, /\x00CODE(\d+)\x00(\n*)/g, (m) => {
    const i = Number(m[1]);
    const at = m.index!, end = at + m[0].length;
    return joinT([codeHoles[i]!, sliceT(t, end - (m[2]!.length - pads[i]!), end)]);
  });
  // Escape `&` and `<` — and deliberately NOT `>`. Those two are all that raw
  // HTML needs to be inert: a tag cannot start without `<`, so `&lt;script>`
  // renders as text either way. Escaping `>` as well (which this did) also ate
  // every markdown construct that uses it: `> quote` arrived at the parser as
  // `&gt; quote`, so blockquotes NEVER rendered — reported as "the content is not
  // rendered as markdown", and it was right for that whole class of message.
  // An expansion keeps the origin of the character it stands for.
  t = replaceT(t, /[&<]/g, (m) => {
    const at = m.index!;
    const text = m[0] === '&' ? '&amp;' : '&lt;';
    return { s: text, o: new Array<number>(text.length).fill(t.o[at]!), g: new Array<boolean>(text.length).fill(false) };
  });
  return { escaped: t, mathHoles, lone, src };
}

/** The one pipeline. In span mode each top-level block also carries
 * `data-src="<first>-<last>"`: the 1-based LINE-model source lines its text
 * came from, read off the traced origins (so the transparent ```md wrapper's
 * deleted fence lines and a multi-line formula folded into one placeholder
 * are carried, not re-counted). When the mapping cannot be proved — a lone
 * CR, or token raws that do not rejoin into marked's input — no block gets a
 * span, and a rendered selection is refused for review rather than guessed.
 * The HTML is otherwise the same as the plain render (pinned on a corpus). */
function render(source: string, spans: boolean): string {
  const { escaped, mathHoles, lone, src } = prepare(source, spans);
  let html: string;
  try { html = spans && !lone ? spanned(escaped, src).html : marked.parse(escaped.s, MARKED) as string; }
  catch { html = escaped.s; }
  html = html.replace(/\uFFFC|%EF%BF%BC/g, ''); // the flanking marks
  html = html.replace(/\x00MATH(\d+)\x00/g, (_m, i) => mathHoles[Number(i)]!);
  return html;
}

const MARKED = { gfm: true, breaks: true } as const;

/** One review source map entry (board #434): a NON-whitespace character a
 * block shows, and the LINE-model UTF-16 offsets `[from, to)` of the source
 * that shows it. `gen` marks a generated region (a formula, a diagram) that
 * shows as ONE unit and maps to no selectable text. */
export type SeenUnit = { ch: string; from: number; to: number; gen: boolean };
/** A stamped block's source lines and what it shows; `seen` is null when its
 * tokens cannot be tied to the source (the block is then refused). */
export type BlockMap = { lines: [number, number]; seen: SeenUnit[] | null };
/** The one character a generated unit shows in a source map. */
export const GENERATED_UNIT = '\uFFFF';

/** marked over the traced `escaped`, block by block: each block's first tag
 * stamped with its source lines, and, for the review mapper, what each
 * stamped block shows tied to the source (`blockSeen`). */
function spanned(t: Traced, src: string): { html: string; blocks: BlockMap[] } {
  // `marked.parse` merges the given options over the instance's defaults,
  // which hold every `marked.use` extension (the safe URL renderer, the bare
  // path links, the del tokenizer); the lexer and parser called on their own
  // take the options AS GIVEN, so they get the same merge here.
  const opts = { ...marked.defaults, ...MARKED };
  const tokens = marked.lexer(t.s, opts);
  if (tokens.map((x) => x.raw).join('') !== t.s) return { html: marked.parser(tokens, opts), blocks: [] };
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  const lineOf = (off: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
  let at = 0;
  const out: string[] = [];
  const blocks: BlockMap[] = [];
  for (const tok of tokens) {
    const start = at;
    at += tok.raw.length;
    const body = tok.raw.replace(/\n+$/u, '');
    const one = Object.assign([tok], { links: tokens.links }) as unknown as Parameters<typeof marked.parser>[0];
    const html = marked.parser(one, opts);
    if (!html.trim() || !body.length) { out.push(html); continue; }
    const first = t.o[start], last = t.o[start + body.length - 1];
    if (first === undefined || last === undefined) { out.push(html); continue; }
    const lines: [number, number] = [lineOf(first), lineOf(last)];
    out.push(html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)/u, `$1 data-src="${lines[0]}-${lines[1]}"`));
    blocks.push({ lines, seen: blockSeen(t, tok, start) });
  }
  return { html: out.join(''), blocks };
}

/** What a top-level token SHOWS, as non-whitespace units tied to the source
 * (reviewer P1-A on 5b2a004f and 93c1b929). Position is PROVED, never found
 * by searching: every container's children are laid out, contiguously, in
 * that container's CONTENT, and the content is derived from the container's
 * own raw by the rule marked's tokenizer uses — a heading after its opening
 * marks and spaces, emphasis, strong, strikethrough and a link inside their
 * delimiters, a blockquote's lines after their `>` prefixes, a list item's
 * lines after its marker and indentation, a table cell between its own
 * pipes — and then checked character for character against the text marked
 * lexed the children from. Each child's raw must start exactly where the one
 * before it ended. A container whose content cannot be derived that way, a
 * child that is not where it must be, or a token kind this map does not know
 * (html) makes the block unmappable: null, refused, never a guess.
 *
 * What a leaf shows is fixed by its kind: text, a bare path or URL its
 * characters; inline and fenced code their content verbatim; an escape its
 * character over both source units; our own `&amp;`/`&lt;` one character; a
 * formula placeholder or a mermaid block one generated unit; a flanking mark
 * nothing. */
function blockSeen(t: Traced, top: { raw: string }, start: number): SeenUnit[] | null {
  type Tok = { type: string; raw?: string; text?: string; lang?: string; tokens?: Tok[]; items?: Tok[]; header?: { text: string; tokens: Tok[] }[]; rows?: { text: string; tokens: Tok[] }[][] };
  const out: SeenUnit[] = [];
  const unit = (c: Traced, ch: string, i: number, n: number, gen = false) =>
    out.push({ ch, from: c.o[i]!, to: c.o[i + n - 1]! + 1, gen });
  const emit = (c: Traced, a: number, b: number) => {
    const s = c.s;
    for (let i = a; i < b;) {
      const math = s.charCodeAt(i) === 0 ? /^\x00MATH\d+\x00/u.exec(s.slice(i, i + 24)) : null;
      if (math) { unit(c, GENERATED_UNIT, i, math[0].length, true); i += math[0].length; continue; }
      if (s.startsWith('&amp;', i)) { unit(c, '&', i, 5); i += 5; continue; }
      if (s.startsWith('&lt;', i)) { unit(c, '<', i, 4); i += 4; continue; }
      if (c.g[i] || /\s/u.test(s[i]!)) { i += 1; continue; }
      unit(c, s[i]!, i, 1);
      i += 1;
    }
  };
  const blank = (s: string) => /^\s*$/u.test(s);

  /** The content of a container whose content is ONE run of its raw: at
   * `at`, it must read exactly `text`. */
  const run = (r: Traced, at: number, text: string): Traced | null =>
    at >= 0 && r.s.startsWith(text, at) ? sliceT(r, at, at + text.length) : null;

  /** The content of a container built line by line: each raw line minus a
   * prefix that `prefixOk` accepts (marker, `>`, indentation), joined by its
   * own newline; it must read exactly `text`. Extra raw lines past the text
   * must be blank. */
  const byLines = (r: Traced, text: string, prefixOk: (prefix: string, line: number) => boolean): Traced | null => {
    const want = text.split('\n');
    const parts: Traced[] = [];
    let at = 0;
    const lines = r.s.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      if (i < want.length) {
        const w = want[i]!;
        if (!raw.endsWith(w)) return null;
        const cut = raw.length - w.length;
        if (!prefixOk(raw.slice(0, cut), i)) return null;
        parts.push(sliceT(r, at + cut, at + raw.length));
        if (i < want.length - 1) parts.push(sliceT(r, at + raw.length, at + raw.length + 1));
      } else if (!blank(raw)) return null;
      at += raw.length + 1;
    }
    const c = joinT(parts);
    return c.s === text ? c : null;
  };

  const contentOf = (tok: Tok, r: Traced): Traced | null => {
    const text = tok.text ?? '';
    const lead = /^ {0,3}/u.exec(r.s)![0].length;
    switch (tok.type) {
      case 'paragraph': case 'text': return run(r, lead, text) ?? run(r, 0, text);
      case 'heading': {
        const atx = /^ {0,3}#{1,6}(?=[ \t]|$)[ \t]*/u.exec(r.s);
        return atx ? run(r, atx[0].length, text) : run(r, lead, text);
      }
      case 'strong': case 'del': return run(r, 2, text);
      case 'em': return run(r, 1, text);
      case 'link': return r.s[0] === '[' ? run(r, 1, text) : null;
      case 'blockquote':
        return byLines(r, text, (p) => p === '' || /^ {0,3}>[ \t]?$/u.test(p) || /^ {0,3}>[ \t]?/u.exec(p)?.[0] === p);
      case 'list_item': {
        // A task item's text has its checkbox cut off, but its children
        // start with the checkbox token: the content is both.
        const box = tok.tokens?.[0]?.type === 'checkbox' ? tok.tokens[0].raw ?? '' : '';
        return byLines(r, box + text, (p, i) => (i === 0 ? /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]+|$)$/u.test(p) : /^[ \t]*$/u.test(p)));
      }
      default: return null;
    }
  };

  /** `kids` laid out from `at` in `c`, each where the one before ended; what
   * is left after the last is blank. */
  const layout = (c: Traced, kids: Tok[], at: number): boolean => {
    let pos = at;
    for (const k of kids) {
      const raw = k.raw ?? '';
      if (!c.s.startsWith(raw, pos)) return false;
      if (!node(c, k, pos)) return false;
      pos += raw.length;
    }
    return blank(c.s.slice(pos));
  };

  /** A table: each cell between its own pipes, trimmed, must read its text. */
  const table = (c: Traced, tok: Tok, pos: number): boolean => {
    const r = sliceT(c, pos, pos + (tok.raw ?? '').length);
    const lines = r.s.split('\n');
    const rows = [tok.header ?? [], ...(tok.rows ?? [])];
    let at = 0;
    for (let li = 0, ri = 0; li < lines.length; li++) {
      const line = lines[li]!;
      const base = at;
      at += line.length + 1;
      if (li === 1) continue; // the delimiter row shows nothing
      if (ri >= rows.length) { if (!blank(line)) return false; continue; }
      const cells = rows[ri++]!;
      // Unescaped pipes split the line; one leading and one trailing pipe are
      // the row's frame.
      const bars: number[] = [];
      for (let i = 0; i < line.length; i++) if (line[i] === '|' && line[i - 1] !== '\\') bars.push(i);
      const cuts = [-1, ...bars, line.length];
      const segs: [number, number][] = [];
      for (let k = 0; k + 1 < cuts.length; k++) segs.push([cuts[k]! + 1, cuts[k + 1]!]);
      if (segs.length && blank(line.slice(segs[0]![0], segs[0]![1])) && bars[0] !== undefined && blank(line.slice(0, bars[0]))) segs.shift();
      if (segs.length && blank(line.slice(segs[segs.length - 1]![0], segs[segs.length - 1]![1]))) segs.pop();
      if (segs.length !== cells.length) return false;
      for (let k = 0; k < cells.length; k++) {
        const [a, b] = segs[k]!;
        const seg = line.slice(a, b);
        const inner = seg.trim();
        if (inner !== cells[k]!.text) return false;
        const from = base + a + seg.indexOf(inner);
        if (!layout(sliceT(r, from, from + inner.length), cells[k]!.tokens, 0)) return false;
      }
    }
    return true;
  };

  const SILENT = new Set(['space', 'def', 'hr', 'br', 'checkbox', 'image']);
  /** The token `tok`, whose raw starts at `pos` in `c`. */
  function node(c: Traced, tok: Tok, pos: number): boolean {
    const raw = tok.raw ?? '';
    const end = pos + raw.length;
    if (SILENT.has(tok.type)) return true;
    if (tok.type === 'table') return table(c, tok, pos);
    if (tok.type === 'list') return layout(sliceT(c, pos, end), tok.items ?? [], 0);
    const kids = tok.tokens;
    if (kids && tok.type !== 'escape') {
      const inner = contentOf(tok, sliceT(c, pos, end));
      return !!inner && layout(inner, kids, 0);
    }
    if (tok.type === 'code') {
      if (tok.lang === 'mermaid') { unit(c, GENERATED_UNIT, pos, raw.length, true); return true; }
      // A fence's first line is its marker and info string; its last, the
      // closing marker. An indented block's indentation is whitespace.
      const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(raw);
      if (!fence) { emit(c, pos, end); return true; }
      const nl = raw.indexOf('\n');
      const body = raw.replace(/\n+$/u, '');
      const lastNl = body.lastIndexOf('\n');
      const closed = lastNl > nl && new RegExp(`^ {0,3}${fence[1]![0] === '`' ? '`' : '~'}{${fence[1]!.length},}\\s*$`, 'u').test(body.slice(lastNl + 1));
      if (nl >= 0) emit(c, pos + nl + 1, closed ? pos + lastNl : pos + body.length);
      return true;
    }
    if (tok.type === 'codespan' || tok.type === 'pathCode') {
      const ticks = /^`+/u.exec(raw)?.[0].length ?? 0;
      emit(c, pos + ticks, end - ticks);
      return true;
    }
    if (tok.type === 'escape') {
      for (const ch of (tok.text ?? '').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<')) if (!/\s/u.test(ch)) unit(c, ch, pos, raw.length);
      return true;
    }
    if (tok.type === 'text' || tok.type === 'safeUrl' || tok.type === 'pathRef') { emit(c, pos, end); return true; }
    return false; // html, or a kind this map does not know: refused
  }

  return node(t, top as Tok, start) ? out : null;
}

/** The review source map of a markdown document (board #434): for each
 * block the span render stamps, in order, its lines and what it shows tied
 * to the source. Null when the span render stamps nothing (a lone CR, raws
 * that do not rejoin). The same pipeline and the same lexing as the render,
 * so the map and the DOM it describes cannot disagree about the tokens;
 * the mapper still checks the DOM against `seen` before using it. */
export function markdownSourceMap(body: string): BlockMap[] | null {
  const { escaped, lone, src } = prepare(body || '', true);
  if (lone) return null;
  try {
    const { blocks } = spanned(escaped, src);
    return blocks.length ? blocks : null;
  } catch { return null; }
}
