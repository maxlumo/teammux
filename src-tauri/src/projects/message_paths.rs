//! The file paths a chat message mentions (board #432, the Files mode of the
//! Hub's search and `tmm log --files`).
//!
//! Three layers, kept apart (design revision 1, P1-B):
//!
//! 1. the path LEXICON, `match_path` / `find_paths`: a Rust twin of
//!    `src/lib/core/path-grammar.ts` (board #431). The case table
//!    `src/lib/core/path-grammar.cases.json` is the contract; the TS test and
//!    this file's test run the same rows. A row one side fails is a grammar
//!    disagreement, never a per-side exception.
//! 2. explicit link targets, `path_ref`: today's `pathRef` (core/path-links.ts)
//!    for the target of `[text](target)`: not a scheme, not `#fragment`, not
//!    `//`, percent-decoded, `:line` stripped. `README.md` IS a path there
//!    though never as a bare word.
//! 3. the scannable REGIONS, `paths_in_body`: which parts of a message are
//!    looked at. The rule is that the list is a NAMED SUBSET of what the feed
//!    links: the feed is the TypeScript renderer (marked), this is not a
//!    Markdown parser, so every construct it does not understand is SKIPPED,
//!    never guessed. `src/lib/core/message-paths.cases.json` is the shared
//!    corpus: each row says what the bubble links (`feed`, checked against the
//!    real renderer by a TS test) and what Files lists (`files`, checked here);
//!    both tests assert files is a subset of feed and that every difference
//!    names a gap from a closed list.
//!
//! Listed: prose paths, a code span that is exactly one path, the target of an
//! inline `[text](target)` link. Skipped: fenced blocks (except the transparent
//! outer `markdown`/`md` fence the renderer unwraps), other code spans, math,
//! URLs (masked whole), link text, images, reference-style links and their
//! definitions, and indented lines that may be code.

/// A path found in text: `raw` is the matched source, `:line[:col]` included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMatch {
    pub raw: String,
    pub path: String,
    pub line: Option<u64>,
    pub col: Option<u64>,
}

/// One mention in a message: the path, as the feed's click would open it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathMention {
    pub path: String,
    pub line: Option<u64>,
    pub col: Option<u64>,
}

/// Where a bare URL or path ends: CJK and fullwidth characters. The TypeScript
/// `STOP` lists U+2E80-U+9FFF, U+3000-U+303F, U+3040-U+30FF, U+AC00-U+D7AF and
/// U+FF00-U+FFEF; the two middle ranges lie inside the first, so the set is
/// three ranges here.
pub fn is_stop(c: char) -> bool {
    matches!(c as u32, 0x2E80..=0x9FFF | 0xAC00..=0xD7AF | 0xFF00..=0xFFEF)
}

/// JavaScript's `\s`, which is not Rust's `char::is_whitespace` (it adds U+FEFF
/// and differs on U+180E and the line separators).
fn js_space(c: char) -> bool {
    matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn is_run(c: char) -> bool {
    c.is_ascii_alphanumeric() || "._@+%~/-".contains(c)
}

/// May a path start right after `prev`? The start of the text, whitespace, one
/// of `( " ' = ,`, or a CJK/fullwidth character.
fn left_ok(prev: Option<char>) -> bool {
    match prev {
        None => true,
        Some(c) => js_space(c) || "(\"'=,".contains(c) || is_stop(c),
    }
}

fn file_like(segment: &str) -> bool {
    // A name, a dot, and an extension of 1-10 characters starting with a letter.
    let Some(dot) = segment.rfind('.') else { return false };
    if dot == 0 {
        return false;
    }
    let ext = &segment[dot + 1..];
    let mut chars = ext.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && ext.len() <= 10
        && ext.chars().all(|c| c.is_ascii_alphanumeric())
}

fn is_path(p: &str) -> bool {
    if p.starts_with("//") {
        return false;
    }
    if p.starts_with('/') {
        return p.matches('/').count() >= 2;
    }
    if p.starts_with("~/") {
        return p.len() > 2;
    }
    if p.starts_with("./") {
        return p.len() > 2;
    }
    if p.starts_with("../") {
        return p.len() > 3;
    }
    if !p.contains('/') {
        return false;
    }
    let segs: Vec<&str> = p.split('/').collect();
    let first = segs[0];
    if first.is_empty() || first.starts_with('~') || (first.contains('.') && !first.starts_with('.')) {
        return false;
    }
    file_like(segs[segs.len() - 1])
}

/// Trailing dots are sentence punctuation unless they ARE a path segment that
/// names a different directory: `/tmp/x.` ends at `/tmp/x`; `/tmp/..`, `../..`
/// and `/tmp/...` stay whole. A single trailing `.` segment is the directory
/// before it, unless what is left would no longer be a path (`./.` stays).
fn strip_dots(p: &str) -> String {
    let last = &p[p.rfind('/').map_or(0, |i| i + 1)..];
    if last.len() >= 2 && last.chars().all(|c| c == '.') {
        return p.to_string();
    }
    if last == "." {
        let cut = &p[..p.len() - 1];
        return if is_path(cut) { cut.to_string() } else { p.to_string() };
    }
    p.trim_end_matches('.').to_string()
}

/// `:line` or `:line:col` (ASCII digits) at the start of `src`: the numbers and
/// how many characters it took.
fn line_suffix(src: &[char]) -> (Option<u64>, Option<u64>, usize) {
    if src.first() != Some(&':') {
        return (None, None, 0);
    }
    let digits = |from: usize| src[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let n1 = digits(1);
    if n1 == 0 {
        return (None, None, 0);
    }
    let number = |from: usize, n: usize| src[from..from + n].iter().collect::<String>().parse::<u64>().unwrap_or(u64::MAX);
    let line = number(1, n1);
    let after = 1 + n1;
    if src.get(after) == Some(&':') {
        let n2 = digits(after + 1);
        if n2 > 0 {
            return (Some(line), Some(number(after + 1, n2)), after + 1 + n2);
        }
    }
    (Some(line), None, after)
}

/// The path at the start of `src`, or None. `prev` is the character before it.
pub fn match_path(src: &[char], prev: Option<char>) -> Option<PathMatch> {
    if !left_ok(prev) {
        return None;
    }
    let n = src.iter().take_while(|c| is_run(**c)).count();
    if n == 0 {
        return None;
    }
    let run: String = src[..n].iter().collect();
    let (line, col, used) = line_suffix(&src[n..]);
    let path = if used > 0 { run } else { strip_dots(&run) };
    if !is_path(&path) {
        return None;
    }
    let suffix: String = src[n..n + used].iter().collect();
    Some(PathMatch { raw: format!("{path}{suffix}"), path, line, col })
}

/// Which characters of `text` belong to a URL (`scheme://` up to whitespace or
/// a STOP character): a path inside one is never a path (`?p=src/a.rs`).
fn mask_urls(text: &[char]) -> Vec<bool> {
    let mut masked = vec![false; text.len()];
    let mut floor = 0usize; // a match starts at or after the end of the previous one
    let mut i = 0usize;
    while i + 2 < text.len() {
        if text[i] == ':' && text[i + 1] == '/' && text[i + 2] == '/' {
            let mut s = i;
            while s > floor && (text[s - 1].is_ascii_alphanumeric() || "+.-".contains(text[s - 1])) {
                s -= 1;
            }
            if let Some(k) = (s..i).find(|k| text[*k].is_ascii_alphabetic()) {
                let mut end = i + 3;
                while end < text.len() && !js_space(text[end]) {
                    end += 1;
                }
                let stop = (k..end).find(|j| is_stop(text[*j])).unwrap_or(end);
                for m in masked.iter_mut().take(stop).skip(k) {
                    *m = true;
                }
                floor = end;
                i = end;
                continue;
            }
        }
        i += 1;
    }
    masked
}

/// Every path in PLAIN text, in order, with its start (in characters). URLs are
/// masked whole first. After a rejected position the scan moves ONE character
/// on, and `left_ok` decides whether a path may start there.
pub fn find_paths(text: &[char]) -> Vec<(usize, PathMatch)> {
    let masked = mask_urls(text);
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < text.len() {
        if masked[i] || !is_run(text[i]) {
            i += 1;
            continue;
        }
        let prev = if i == 0 { None } else { Some(text[i - 1]) };
        if let Some(hit) = match_path(&text[i..], prev) {
            let n = hit.raw.chars().count();
            if !masked[i..i + n].iter().any(|b| *b) {
                out.push((i, hit));
                i += n;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// The target of an explicit link, read as the feed's click reads it
/// (`pathRef`): the path it opens, with an optional `:line[:col]`. None when it
/// is a URL, a fragment or a protocol-relative target.
pub fn path_ref(href: &str) -> Option<PathMention> {
    let raw = href.trim_matches(js_space);
    if raw.is_empty() || raw.starts_with('#') || raw.starts_with("//") {
        return None;
    }
    let part = raw.split('#').next().unwrap_or("");
    let chars: Vec<char> = part.chars().collect();
    // Strip a trailing :line[:col].
    let mut end = chars.len();
    let mut line = None;
    let mut col = None;
    let tail_digits = |upto: usize| chars[..upto].iter().rev().take_while(|c| c.is_ascii_digit()).count();
    let d1 = tail_digits(end);
    if d1 > 0 && end > d1 && chars[end - d1 - 1] == ':' {
        let n1: u64 = chars[end - d1..end].iter().collect::<String>().parse().unwrap_or(u64::MAX);
        let before = end - d1 - 1;
        let d2 = tail_digits(before);
        if d2 > 0 && before > d2 && chars[before - d2 - 1] == ':' {
            let n2: u64 = chars[before - d2..before].iter().collect::<String>().parse().unwrap_or(u64::MAX);
            line = Some(n2);
            col = Some(n1);
            end = before - d2 - 1;
        } else {
            line = Some(n1);
            end = before;
        }
    }
    let path: String = chars[..end].iter().collect();
    // A scheme: ^[a-zA-Z][a-zA-Z0-9+.-]*:
    let mut it = path.chars();
    if matches!(it.next(), Some(c) if c.is_ascii_alphabetic()) {
        for c in it {
            if c == ':' {
                return None;
            }
            if !(c.is_ascii_alphanumeric() || "+.-".contains(c)) {
                break;
            }
        }
    }
    if path.is_empty() {
        return None;
    }
    Some(PathMention { path: percent_decode(&path).unwrap_or(path), line, col })
}

/// `decodeURIComponent`: None where it would throw (a bad escape or bytes that
/// are not UTF-8), and the caller keeps the text as written.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| (c as char).to_digit(16);
            let (h, l) = (b.get(i + 1).and_then(|c| hex(*c))?, b.get(i + 2).and_then(|c| hex(*c))?);
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---------------------------------------------------------------- regions --

/// Stands in the text for every region that is not looked at (a fenced block, a
/// code span, math, a link, an indented line). It is neither a path character
/// nor a left boundary, so what follows it cannot start a path from it.
const HOLE: char = '\u{1}';

/// Stands in for a URL (`hole_urls`). Unlike `HOLE` it is not a region: a formula or a code span
/// that CONTAINS a URL is still that formula or span (the other passes refuse a body holding a
/// `HOLE`, because a region cannot hold a region), and the URL's own text still must not be read
/// as a path. It is neither a path character nor a left boundary, like `HOLE`.
const URL_HOLE: char = '\u{2}';

/// A hole is empty (skipped) or carries a mention (a code span that is exactly
/// one path, the target of an inline link).
type Holes = Vec<Option<PathMention>>;

/// The renderer's transparent `markdown`/`md` fence (`unwrapMarkdownFences`):
/// only the wrapper goes, so its contents are read like any other text.
fn unwrap_markdown_fences(src: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in src.split('\n') {
        let t = line.trim_matches(js_space);
        match fence {
            None => {
                let ch = t.chars().next();
                if let Some(c @ ('`' | '~')) = ch {
                    let run = t.chars().take_while(|x| *x == c).count();
                    let rest = t[run..].trim_matches(js_space);
                    if run >= 3 && (rest.eq_ignore_ascii_case("markdown") || rest.eq_ignore_ascii_case("md")) {
                        fence = Some((c, run));
                        continue;
                    }
                }
                out.push(line);
            }
            Some((c, len)) => {
                if t.chars().count() >= len && t.chars().all(|x| x == c) {
                    fence = None;
                    continue;
                }
                out.push(line);
            }
        }
    }
    // An unclosed language fence is malformed source: the renderer keeps it.
    if fence.is_some() { src.to_string() } else { out.join("\n") }
}

/// Fenced blocks (a run of three or more backticks or tildes, up to the same
/// run or the end) and single-backtick code spans are holes. A span that is
/// exactly one path is a mention, as the renderer's `pathCode` makes it a link:
/// not padded, not part of a longer backtick run, not escaped.
fn hole_code(src: &str) -> (Vec<char>, Holes) {
    let chars: Vec<char> = src.chars().collect();
    let mut fenced: Vec<char> = Vec::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '`' || c == '~' {
            let run = chars[i..].iter().take_while(|x| **x == c).count();
            if run >= 3 {
                let marker = &chars[i..i + run];
                let mut j = i + run;
                let mut close = None;
                while j + run <= chars.len() {
                    if &chars[j..j + run] == marker {
                        close = Some(j + run);
                        break;
                    }
                    j += 1;
                }
                fenced.push(HOLE);
                i = close.unwrap_or(chars.len());
                continue;
            }
        }
        fenced.push(c);
        i += 1;
    }
    let mut out: Vec<char> = Vec::with_capacity(fenced.len());
    let mut holes: Holes = Vec::new();
    let mut i = 0;
    while i < fenced.len() {
        let c = fenced[i];
        if c == HOLE {
            out.push(HOLE);
            holes.push(None);
            i += 1;
            continue;
        }
        if c == '`' {
            let mut k = i + 1;
            while k < fenced.len() && fenced[k] != '`' && fenced[k] != '\n' {
                k += 1;
            }
            if k > i + 1 && k < fenced.len() && fenced[k] == '`' {
                let content = &fenced[i + 1..k];
                let alone = fenced.get(k + 1) != Some(&'`');
                let escaped = i > 0 && fenced[i - 1] == '\\';
                let mention = if alone && !escaped {
                    match_path(content, None).filter(|m| m.raw.chars().count() == content.len()).map(|m| PathMention { path: m.path, line: m.line, col: m.col })
                } else {
                    None
                };
                out.push(HOLE);
                holes.push(mention);
                i = k + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    (out, holes)
}

/// Replace `open`..`close` (a lazy, non-empty body with no hole in it) by a hole.
fn hole_delimited(text: Vec<char>, holes: Holes, open: &[char], close: &[char]) -> (Vec<char>, Holes) {
    let mut out = Vec::with_capacity(text.len());
    let mut kept = Vec::new();
    let mut pending = holes.into_iter();
    let n = text.len();
    let mut i = 0;
    while i < n {
        if text[i..].starts_with(open) {
            let body = i + open.len();
            // The body is at least one character and holds no hole; the closer is
            // the EARLIEST one (the renderer's lazy match).
            let mut found = None;
            if body < n && text[body] != HOLE {
                let mut j = body + 1;
                while j + close.len() <= n && text[j - 1] != HOLE {
                    if text[j..].starts_with(close) {
                        found = Some(j + close.len());
                        break;
                    }
                    j += 1;
                }
            }
            if let Some(end) = found {
                out.push(HOLE);
                kept.push(None);
                i = end;
                continue;
            }
        }
        if text[i] == HOLE {
            kept.push(pending.next().flatten());
        }
        out.push(text[i]);
        i += 1;
    }
    (out, kept)
}

/// The inline `$…$` form with the renderer's pandoc guards: the opener is not
/// after a word character or `$` and is followed by non-space; the closer
/// follows a non-space, non-`$` and is not followed by a digit; no newline or
/// hole inside.
fn hole_dollar(text: Vec<char>, holes: Holes) -> (Vec<char>, Holes) {
    let mut out = Vec::with_capacity(text.len());
    let mut kept = Vec::new();
    let mut pending = holes.into_iter();
    let n = text.len();
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut i = 0;
    while i < n {
        if text[i] == '$' && !(i > 0 && (word(text[i - 1]) || text[i - 1] == '$')) && i + 1 < n && !js_space(text[i + 1]) {
            let mut k = i + 2;
            let mut found = None;
            while k < n {
                let prev = text[k - 1];
                if prev == '$' || prev == '\n' || prev == HOLE {
                    break;
                }
                if text[k] == '$' {
                    if !js_space(prev) && !text.get(k + 1).is_some_and(|c| c.is_ascii_digit()) {
                        found = Some(k + 1);
                    }
                    break;
                }
                k += 1;
            }
            if let Some(end) = found {
                out.push(HOLE);
                kept.push(None);
                i = end;
                continue;
            }
        }
        if text[i] == HOLE {
            kept.push(pending.next().flatten());
        }
        out.push(text[i]);
        i += 1;
    }
    (out, kept)
}

fn hole_math(text: Vec<char>, holes: Holes) -> (Vec<char>, Holes) {
    let (t, h) = hole_delimited(text, holes, &['\\', '['], &['\\', ']']);
    let (t, h) = hole_delimited(t, h, &['\\', '('], &['\\', ')']);
    let (t, h) = hole_delimited(t, h, &['$', '$'], &['$', '$']);
    hole_dollar(t, h)
}

/// A line indented four or more columns after a blank line (or the start) is
/// code to Markdown, and may be a nested list's content: both are skipped.
fn hole_indented(text: Vec<char>, holes: Holes) -> (Vec<char>, Holes) {
    let mut out = Vec::with_capacity(text.len());
    let mut kept = Vec::new();
    let mut pending = holes.into_iter();
    let mut prev_blank = true; // the start of the text counts as blank
    let mut i = 0;
    while i < text.len() {
        let end = text[i..].iter().position(|c| *c == '\n').map_or(text.len(), |p| i + p);
        let line = &text[i..end];
        let mut width = 0;
        for c in line {
            match c {
                ' ' => width += 1,
                '\t' => width += 4,
                _ => break,
            }
        }
        let blank = line.iter().all(|c| js_space(*c));
        if width >= 4 && !blank && prev_blank {
            for c in line {
                if *c == HOLE {
                    pending.next();
                }
            }
            out.push(HOLE);
            kept.push(None);
            // prev_blank stays true: the next indented line continues the block.
        } else {
            for c in line {
                if *c == HOLE {
                    kept.push(pending.next().flatten());
                }
                out.push(*c);
            }
            prev_blank = blank;
        }
        if end < text.len() {
            out.push('\n');
        }
        i = end + 1;
    }
    (out, kept)
}

/// The matching `]` of the `[` at `open` (nesting counted), within one
/// paragraph (no blank line), or None.
fn close_bracket(text: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < text.len() {
        match text[i] {
            '\\' => i += 1,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            '\n' if text.get(i + 1) == Some(&'\n') => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

/// The matching `)` of the `(` at `open`, on the same line, or None.
fn close_paren(text: &[char], open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut i = open;
    while i < text.len() {
        match text[i] {
            '\\' => i += 1,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            '\n' => return None,
            _ => {}
        }
        i += 1;
    }
    None
}

/// A link destination this module will read: no whitespace, brackets, angle
/// brackets, quotes or parentheses. Anything else (a title, `<…>`) is a link
/// the renderer understands and this does not, so it lists nothing.
fn plain_destination(target: &[char]) -> bool {
    !target.is_empty() && !target.iter().any(|c| js_space(*c) || "()[]<>\"".contains(*c) || *c == HOLE)
}

/// A URL swallows everything up to the next space (the renderer's `safeUrl` tokenizer), so a
/// bracket, a backtick or a link INSIDE one is not a construct of its own:
/// `https://h.dev/?q=[x](README.md)` is one external link. This pass turns every URL that
/// STARTS in plain text into a `URL_HOLE` before any other construct is looked for. "Plain text" is
/// decided left to right, because the renderer's tokenizers race by start: a URL that begins
/// inside a code span or a link (`[https://h.dev/a](docs/x.md)`) is that construct's, and the
/// link still wins. Over-masking only loses a mention, which a subset may do; the corpus pins
/// both directions.
fn hole_urls(src: &str) -> String {
    let t: Vec<char> = src.chars().collect();
    let scheme = |c: char| c.is_ascii_alphanumeric() || "+.-".contains(c);
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < t.len() {
        let c = t[i];
        // A URL starts where a scheme-character run meets `://` (as `mask_urls` reads it): the
        // scheme begins at the run's first letter, and it ends at a space or a STOP character.
        if scheme(c) && !(i > 0 && scheme(t[i - 1])) {
            let run = t[i..].iter().take_while(|x| scheme(**x)).count();
            let colon = i + run;
            if t.get(colon..colon + 3) == Some(&[':', '/', '/']) {
                if let Some(k) = (i..colon).find(|k| t[*k].is_ascii_alphabetic()) {
                    let mut end = colon + 3;
                    while end < t.len() && !js_space(t[end]) {
                        end += 1;
                    }
                    let stop = (k..end).find(|j| is_stop(t[*j])).unwrap_or(end);
                    out.extend(&t[i..k]);
                    out.push(URL_HOLE);
                    i = stop;
                    continue;
                }
            }
        }
        let mut end = i + 1;
        if c == '`' {
            let run = t[i..].iter().take_while(|x| **x == '`').count();
            if run == 1 {
                // A single-backtick span closes on the same line, as `hole_code` reads it.
                if let Some(k) = (i + 1..t.len()).take_while(|k| t[*k] != '\n').find(|k| t[*k] == '`') {
                    end = k + 1;
                }
            } else {
                end = i + run;
            }
        } else if c == '[' && !(i > 0 && t[i - 1] == '\\') {
            if let Some(close) = close_bracket(&t, i) {
                end = match t.get(close + 1) {
                    Some('(') => close_paren(&t, close + 1).map_or(close + 1, |p| p + 1),
                    _ => close + 1,
                };
            }
        }
        out.extend(&t[i..end]);
        i = end;
    }
    out
}

/// The text of a link destination as the renderer reads it: a backslash before an ASCII
/// punctuation character is that character (`docs/a\_b.md` opens `docs/a_b.md`); before
/// anything else it stays.
fn unescape_punctuation(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match (c, it.peek()) {
            ('\\', Some(n)) if n.is_ascii_punctuation() => {
                out.push(*n);
                it.next();
            }
            _ => out.push(c),
        }
    }
    out
}

/// Links and their relatives. `[text](target)` yields the target (a mention when
/// it is a path) and drops the text; every other bracket construct (an image, a
/// reference `[text][ref]`, a shortcut `[text]`, a definition line) is dropped
/// whole and lists nothing.
fn hole_links(text: Vec<char>, holes: Holes) -> (Vec<char>, Holes) {
    let mut out = Vec::with_capacity(text.len());
    let mut kept: Holes = Vec::new();
    let mut pending = holes.into_iter();
    let n = text.len();
    let mut i = 0;
    while i < n {
        let line_start = i == 0 || text[i - 1] == '\n';
        // A definition: up to three spaces, [label]: ...
        if line_start {
            let sp = text[i..].iter().take_while(|c| **c == ' ').count().min(3);
            if text.get(i + sp) == Some(&'[') {
                if let Some(close) = close_bracket(&text, i + sp) {
                    if text.get(close + 1) == Some(&':') && !text[i + sp + 1..close].contains(&'\n') {
                        let end = text[i..].iter().position(|c| *c == '\n').map_or(n, |p| i + p);
                        text[i..end].iter().filter(|c| **c == HOLE).for_each(|_| { pending.next(); });
                        out.push(HOLE);
                        kept.push(None);
                        i = end;
                        continue;
                    }
                }
            }
        }
        if text[i] == '[' && !(i > 0 && text[i - 1] == '\\') {
            if let Some(close) = close_bracket(&text, i) {
                let (group_end, mention) = match text.get(close + 1) {
                    Some('(') => match close_paren(&text, close + 1) {
                        Some(paren) => {
                            let label = &text[i + 1..close];
                            let target = &text[close + 2..paren];
                            let image = i > 0 && text[i - 1] == '!';
                            let simple = !label.iter().any(|c| *c == '[' || *c == ']');
                            let mention = if !image && simple && plain_destination(target) {
                                path_ref(&unescape_punctuation(&target.iter().collect::<String>()))
                            } else {
                                None
                            };
                            (paren + 1, mention)
                        }
                        None => (close + 1, None),
                    },
                    Some('[') => match close_bracket(&text, close + 1) {
                        Some(r) => (r + 1, None),
                        None => (close + 1, None),
                    },
                    _ => (close + 1, None),
                };
                text[i..group_end].iter().filter(|c| **c == HOLE).for_each(|_| { pending.next(); });
                out.push(HOLE);
                kept.push(mention);
                i = group_end;
                continue;
            }
        }
        if text[i] == HOLE {
            kept.push(pending.next().flatten());
        }
        out.push(text[i]);
        i += 1;
    }
    (out, kept)
}

/// The paths a message mentions, in order of appearance (duplicates kept: the
/// caller counts and de-duplicates).
pub fn paths_in_body(body: &str) -> Vec<PathMention> {
    let unwrapped = hole_urls(&unwrap_markdown_fences(body));
    let (text, holes) = hole_code(&unwrapped);
    let (text, holes) = hole_math(text, holes);
    let (text, holes) = hole_indented(text, holes);
    let (text, holes) = hole_links(text, holes);
    let mut hole_mentions = holes.into_iter();
    let mut prose = find_paths(&text).into_iter().peekable();
    let mut out = Vec::new();
    for (pos, c) in text.iter().enumerate() {
        while let Some((start, _)) = prose.peek() {
            if *start > pos {
                break;
            }
            let (_, m) = prose.next().expect("peeked");
            out.push(PathMention { path: m.path, line: m.line, col: m.col });
        }
        if *c == HOLE {
            if let Some(Some(m)) = hole_mentions.next() {
                out.push(m);
            }
        }
    }
    out
}

/// The cheap SQL pre-filter for the Files scan: every mention this module can
/// produce holds a `/` (all four bare forms, a code span that is one path) or
/// is the target of a link (`](`). A superset, by construction and by the
/// corpus test; a widening of the subset that forgets it fails that test.
pub const CANDIDATE_LIKE: [&str; 2] = ["%/%", "%](%"];

pub fn is_candidate(body: &str) -> bool {
    body.contains('/') || body.contains("](")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    /// The shared lexicon table (board #431): the TypeScript test runs the same
    /// rows. `raw` is asserted too: both sides read the same matched text.
    #[test]
    fn every_row_of_the_shared_path_grammar_table() {
        let rows: Vec<Value> = serde_json::from_str(include_str!("../../../src/lib/core/path-grammar.cases.json")).unwrap();
        assert!(rows.len() >= 50, "the table was read: {} rows", rows.len());
        for row in rows {
            let input = row["input"].as_str().unwrap();
            let want: Vec<(String, String, Option<u64>, Option<u64>)> = row["paths"].as_array().unwrap().iter()
                .map(|p| (p["raw"].as_str().unwrap().to_string(), p["path"].as_str().unwrap().to_string(), p["line"].as_u64(), p["col"].as_u64()))
                .collect();
            let got: Vec<_> = find_paths(&chars(input)).into_iter().map(|(_, m)| (m.raw, m.path, m.line, m.col)).collect();
            assert_eq!(got, want, "{input:?}");
        }
    }

    #[test]
    fn the_stop_set_is_the_cjk_and_fullwidth_ranges() {
        for c in ['见', '。', '（', 'ア', '한', '：'] {
            assert!(is_stop(c), "{c}");
        }
        for c in ['a', '/', '.', 'é', ' '] {
            assert!(!is_stop(c), "{c}");
        }
    }

    /// pathRef (core/path-links.ts) for the target of an explicit link.
    #[test]
    fn an_explicit_target_is_read_like_the_feeds_click() {
        let p = |s: &str| path_ref(s).map(|m| (m.path, m.line, m.col));
        assert_eq!(p("README.md"), Some(("README.md".into(), None, None)), "a bare word IS a path as an explicit target");
        assert_eq!(p("my%20notes.md"), Some(("my notes.md".into(), None, None)), "percent-decoded");
        assert_eq!(p("src/a.rs:12:5"), Some(("src/a.rs".into(), Some(12), Some(5))));
        assert_eq!(p("src/a.rs:12"), Some(("src/a.rs".into(), Some(12), None)));
        assert_eq!(p("/tmp/x#frag"), Some(("/tmp/x".into(), None, None)), "the fragment is dropped");
        assert_eq!(p("%zz"), Some(("%zz".into(), None, None)), "a bad escape is kept as written");
        for not in ["", "#top", "//host/x", "https://x.dev/a", "mailto:a@b.c", "javascript:alert(1)"] {
            assert_eq!(p(not), None, "{not}");
        }
    }

    #[derive(serde::Deserialize)]
    struct Row {
        body: String,
        feed: Vec<String>,
        files: Vec<String>,
        gap: Option<String>,
    }

    /// The gaps Files v1 names (docs/design-docs/features/hub-feed.md); a row
    /// whose files differ from its feed names one of these, and no other.
    const GAPS: [&str; 5] = ["reference-style link", "emphasis boundary", "bracketed text", "indented line", "link title"];

    /// The shared message corpus. The TypeScript test renders each body and
    /// checks `feed`; this runs the same bodies and checks `files`.
    #[test]
    fn every_row_of_the_shared_message_corpus() {
        let rows: Vec<Row> = serde_json::from_str(include_str!("../../../src/lib/core/message-paths.cases.json")).unwrap();
        assert!(rows.len() >= 25, "the corpus was read: {} rows", rows.len());
        for row in rows {
            let got: Vec<String> = paths_in_body(&row.body).into_iter().map(|m| m.path).collect();
            assert_eq!(got, row.files, "files for {:?}", row.body);
            let mut unseen = row.feed.clone();
            for path in &got {
                let at = unseen.iter().position(|f| f == path);
                assert!(at.is_some(), "Files lists {path:?}, which the bubble does not link: {:?}", row.body);
                unseen.remove(at.unwrap());
            }
            match (&row.gap, got == row.feed) {
                (Some(g), false) => assert!(GAPS.contains(&g.as_str()), "unknown gap {g:?} for {:?}", row.body),
                (None, false) => panic!("feed and files differ without a named gap: {:?}", row.body),
                (Some(_), true) => panic!("a gap is named but feed and files agree: {:?}", row.body),
                (None, true) => {}
            }
            // The SQL pre-filter must let through everything Files can list.
            if !row.files.is_empty() {
                assert!(is_candidate(&row.body), "the candidate filter would drop {:?}", row.body);
            }
        }
    }

    #[test]
    fn a_message_with_no_slash_and_no_link_is_not_a_candidate() {
        assert!(!is_candidate("README.md is the file"));
        assert!(is_candidate("[README](README.md)"));
        assert!(is_candidate("see src/a.rs"));
    }
}
