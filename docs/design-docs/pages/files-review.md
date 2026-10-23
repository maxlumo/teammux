# Files preview — review annotations (board #434)

Owner, 2026-10-20: review comments in the Files preview, modelled on
laminar-log's portal 批注. Select text in a source or markdown preview, write
a comment, see it as a card beside the highlight, edit, resolve or delete it.
The comments are stored with the project, and one "Send as feedback" puts them
into the Hub composer as a document-feedback block for an agent. `tmm review`
does the same from an agent's shell. The HTML preview (the #433 frame) is
reviewable too, through its own source map and frame binding below.

The design was CLEARed at delta 3 on the issue. This page keeps the rules and
their reasons: the store, the anchors, the rendered-selection mapper, the UI,
the hand-off to the Hub, and the limits.

## Rules and their reasons

### The store, its lock, and containment at the object

**Where.** `<project root>/.tmm/reviews/<sha256(relpath)>.json`, holding
`{schema: 1, path: <relpath>, annotations: [...]}`. The hash is only a
filename. A store whose `schema` or `path` does not match is an error, never
adopted. `.tmm/` is gitignored, so reviews persist in the project FOLDER: they
survive restarts, they are not in Git, and they go with the folder.

**One read-modify-write protocol** (`projects::review::with_store`, the one
door). A write opens a stable sidecar, `<key>.json.lock`, which is created
once and never replaced, so the lock binds to one inode, and takes `LOCK_EX`
on it. It reads the store, mutates it, writes an `O_EXCL` temp file, fsyncs
it, `renameat`s it over the store, fsyncs the directory, and unlocks. An
absent store is empty.

**A read is truly read-only** (reviewer P2 on 5b2a004f): it opens only the
store, `O_RDONLY`, creates nothing (no directory, no sidecar) and takes no
lock, so it works in a read-only `reviews` directory. It needs no lock:
because a writer replaces the store by `renameat`, a reader's one open sees
one whole version, the one before a concurrent write or the one after it.
The earlier `LOCK_SH` read created a sidecar for every file merely listed. Unreadable or unparseable JSON is an ERROR and
is never overwritten. A store loaded as `[]` and then written back would
silently delete every comment in it.

Within one store, the lock serializes every read-modify-write, so updates to
different annotations never lose each other. For two updates to the same id,
the later write wins, field by field as sent.

**Containment binds the objects actually opened** (`review::Root`). A path is
checked only once, and only as a handle:

1. The project's declared root is canonicalized ONCE and its `(dev, ino)` is
   read. It is then opened `O_DIRECTORY | O_NOFOLLOW` and must match by
   `fstat` AND by the fd's own path (`/proc/self/fd/N` on Linux,
   `F_GETPATH` on macOS). If the root was replaced in between by a symlink,
   by a symlinked parent, or by another real directory, the open is refused.
2. `.tmm` and `reviews` are opened relative to that handle, each
   `O_DIRECTORY | O_NOFOLLOW`, and made with `mkdirat` only by a write. A
   symlink at either level is refused.
3. The lock, the store and the temp file are opened relative to the
   `reviews` handle, `O_NOFOLLOW`, and must be regular files by `fstat`. The
   temp file is `O_EXCL` under a random name, so a planted file or link is
   never written through.
4. The source file is canonicalized once (`Root::relpath`). An internal
   symlink is followed there, and its target must lie inside the root. The
   resulting relpath is then walked component by component from the root
   handle, `O_NOFOLLOW` on every step. Revision and quote come from one read
   of the final fd, so a component swapped for a link after the resolve
   fails instead of being followed.

An identity or path mismatch refuses the request. It never retries by path.

Pinned by `projects::review::tests`: the round trip, and a read that creates
nothing; corrupt, wrong-schema and wrong-path stores (each an error, the file
byte-identical afterwards); eight concurrent writers, one paused inside its
lock, with no annotation lost; paths outside the root and symlinks out
refused, and an internal link resolved to its target; planted links at
`.tmm`, `reviews`, the JSON, the lock and the source file, each refused or
never followed, with the target untouched; the root swapped between its
identity read and its open for a symlink, a symlinked parent or another real
directory, each refused, plus an undisturbed control; `reviews` swapped for a
link after the root was proved, with nothing written outside; the source's
directory swapped for a link between resolve and read, refused.

### One text model, one coordinate definition, anchors that never guess

**Wire coordinates, defined once.** These are used by the store, the RPCs
and `tmm review`:
- `line` is 1-based;
- `col` is 1-based and counted in Unicode scalar values (Rust `char`s, JS code
  points), never UTF-16 units or bytes;
- a range `{line, col, end_line, end_col}` ends EXCLUSIVE.

**The LINE model** (`review::Model`) is the one text everything is compared
on. `\r\n` and `\n` both end a line and become `\n`, once; a lone `\r` is an
ordinary character; nothing else is normalized. The quote, its context
(`pre`/`suf`, `CONTEXT` = 32 scalars each side), relocation and the feedback
block's "in" line all read this text. So a comment survives a CRLF↔LF
conversion, and a multi-line quote holds `\n`, never `\r`. The revision is
still the sha256 of the raw bytes. A file that is not UTF-8 is not text and
cannot be reviewed.

**The source revision.** `fs_read` returns `revision`: the sha256 hex of
exactly the bytes it decoded. `review_add` carries the revision of what the
person selected in. Under the store's lock, the server reads the source ONCE,
compares the revision and cuts the quote from that same read. A different
revision answers `{stale, revision}`, stores nothing, and the client keeps
the draft. A whitespace-only, empty or out-of-bounds range is refused.
`review_list` returns the CURRENT revision, and the client paints highlights
only when that is the revision of the content it rendered.

**Relocation** (`review::locate`) returns `located`, `missing` or
`ambiguous`, and never a guessed position:
- The stored range is used only when the revision is the stored one AND the
  text at it is the stored quote. A store on disk is a hand-editable file
  and is not trusted.
- Otherwise, every exact occurrence of the quote is a candidate, scored by
  the agreeing run of `pre` before it and `suf` after it, counted in
  NON-whitespace scalars (whitespace must agree for a run to continue, but
  the blank line around every paragraph says nothing about which copy this
  is).
- When the stored context holds a non-whitespace scalar, it is evidence: a
  candidate that scores zero against it is not the commented text, even when
  it is the only one (validator on 5b2a004f, orchestrator's ruling). Two
  identical paragraphs, the first commented and then edited, had left the
  comment silently `located` on the second. No candidate left is `missing`.
- Context that is empty or ONLY whitespace is no evidence either way
  (reviewer on 93c1b929): every exact occurrence stays a candidate. So a
  one-line `hello` file, whose only context is its newline, keeps its comment
  through an LF→CRLF conversion (the revision changes, the LINE text does
  not), and two such copies are `ambiguous`.
- This is a heuristic that refuses rather than guesses, not a proof of
  identity.
- A unique best is `located`. A tie, including identical context, is
  `ambiguous`, and the card keeps its quote and note with no position.

**The feedback block** (`review::feedback`, the one formatter, in the portal
批注 shape):

```text
[Document feedback on <abs path> — N comments]
1. (line L, col C, "<selection…>" in "<source line>"): "<comment>"
2. (lines A–B, col C, "<selection…>" in "<source lines>"): "<comment>"
3. ("<selection…>"): "<comment>"        ← missing or ambiguous
```

Only open comments with a note are included, and a selection is cut at 60
scalars. A whitespace run that holds a newline becomes one space. Every
user-sourced field (the path, the selection, the source line, the note) goes
through `address::unaddressed`, so `@` becomes `＠`. Pasting the block into a
message therefore addresses nobody new: `mention_names` reads nothing in it,
and `@builder <block>` names exactly `builder`.

**The RPCs** (desktop project dispatch; websocket-rpc.md has the shapes):
`review_list`, `review_add`, `review_update` (note and/or `open|resolved`),
`review_delete` and `review_feedback`. Each takes `project_id`, or the
caller's `session` for `tmm`, plus an ABSOLUTE `path`. The server alone
resolves the project, its verified root and the canonical relpath: a
relative path is refused, never resolved against the gateway's cwd. There is
no role system. An authenticated connection has the broad access `fs_write`
has. On the filesystem, list and feedback need the source readable, add also
needs `reviews` writable, and update and delete need `reviews` writable.

**`tmm review`** is the same store from the shell. The TARGET gateway owns
the path, the content and the revision (reviewer P1-D on 5b2a004f): tmm
makes a relative path absolute against its cwd, lexically, and never
canonicalizes, opens or measures the file. A file that exists only on the
gateway is reviewable, a local copy with other content changes nothing, and
`--lines` goes as numbers (`review_add` `lines`/`cols`) that the server
expands in the one read it anchors against. A stale answer is an error, never
a success. The verbs:
- `list <path> [--all]`;
- `add <path> --lines A[-B] [--cols C-D] --note <text>`: whole lines in the
  LINE model, unless `--cols` (inclusive) narrows them;
- `resolve|reopen|delete <path> <id>`;
- `feedback <path>`.

Pinned by `review::anchor_tests`:
- the coordinate table: emoji, CJK, CRLF, a lone CR, multi-line, and
  whitespace-only, empty and out-of-bounds ranges refused;
- relocation: the same revision, text inserted above, identical context
  ambiguous, text edited away missing, an untrusted stored range;
- a CRLF quote surviving a line inserted above, CRLF→LF, LF→CRLF, and a
  lone CR;
- the exact feedback block, with `@` neutralized in the path, the
  selection, the line and the note, and the cut.

And by `review::rpc_tests` (stale refused and nothing stored; add with
`fs_read`'s revision; the same project by session; a relative path refused;
update, feedback, resolve hiding it, delete, unknown id and status refused;
relocation after the file changed; whole lines measured by the server in
its own read), by `review::tests` (a read that creates no lock and works in a
read-only `reviews` directory), by `a_lone_copy_with_no_matching_context_is_missing`
and by the real CLI against a fake gateway, `tests/review_cli.rs` (a path
that exists only on the server, a local copy with other content, a stale
answer).

### A rendered selection maps uniquely to the source, or is refused

`files/review-anchor.ts` is the ONE place a rendered selection becomes a raw
range. The server does the rest. A guess would store the comment against the
wrong text for good, so a selection that cannot be mapped is refused and the
person's draft note is kept.

**Code preview.** A selection maps by its rows (`.cl-row` order = LINE-model
lines), with no search (`codeRange`). DOM offsets are UTF-16 and are
converted to scalar columns in one place (`toScalarCol` / `toUtf16`). An
offset past the line's last scalar clamps to the line's end: that covers the
CR of a CRLF row and the zero-width space of an empty row. A whitespace-only
selection is refused.

**Markdown preview: the renderer's own positions, never a stripper.**
Reviewer P1-A on 5b2a004f showed why the first mapper was wrong: it
stripped `*` and backticks from the source to guess what the render shows,
so in `` `a*b` a\*b `` (one backslash) the code span's `a*b` lost its
asterisk, only the escaped twin was left as a candidate, and selecting the
code stored the comment on the twin. The stripper and its context scoring
are deleted. The mapping is now proved from three facts.

1. **One traced pipeline** (`core/markdown.ts` `prepare`). Every step
   before marked (the transparent ```md wrapper removed, code holed out,
   math folded into placeholders, the CJK flanking marks, code restored,
   `&`/`<` escaped) rewrites a `Traced` string: each UTF-16 unit carries the
   offset of the source unit it came from, and generated units (a
   placeholder, a flanking mark, padding) are marked as such. Chat and the
   span render run the same steps; only the span render reads the
   origins. `data-src="<first>-<last>"`, the 1-based LINE-model lines of each
   top-level block, is read off them, so the wrapper's deleted fence lines
   and a formula folded across lines are carried, not re-counted.
2. **The tokens' own raws, laid out in their parent's CONTENT**
   (`blockSeen`; reviewer P1-A on 93c1b929). marked's top-level raws rejoin
   into its input exactly (otherwise no spans at all), so each block's start
   is known. Below that, position is PROVED, never found by searching:
   every container's content is derived from its own raw by the rule
   marked's tokenizer uses — a heading after its opening marks and spaces;
   emphasis, strong, strikethrough and a link inside their delimiters; a
   blockquote's lines after their `>` prefixes (a lazy line keeps all of
   itself); a list item's lines after its marker and indentation, with a task
   item's checkbox token at the front; a table cell between its own pipes —
   and that content must read EXACTLY the text marked lexed the children
   from. Each child's raw must then start exactly where the one before it
   ended. The first version found each child with `indexOf` from the
   parent's raw start, so in `# # **x**` the body's `#` was "found" at the
   heading marker: equal visible text is not proof of position. What each
   leaf SHOWS is fixed by its kind: text, a bare path or URL its characters;
   inline and fenced code their content verbatim; an escape its character
   over both source units; our own `&amp;`/`&lt;` one character; a formula
   placeholder or a mermaid block one GENERATED unit; a flanking mark
   nothing. The result, `markdownSourceMap(body)`, is per stamped block the
   non-whitespace units it shows with their source offsets. A container
   whose content cannot be derived (a table cell holding `\|`, which marked
   unescapes), a child that is not where it must be, or a token kind the map
   does not know (html) makes that block unmappable.
3. **A DOM walk checked against it** (`files/review-ui.ts`). A stamped
   block's text nodes, non-whitespace unit by unit, with each `.katex`,
   `.katex-display`, `.katex-error`, `.mermaid-block` or
   `code.language-mermaid` element as one generated unit, must equal the
   map's units exactly. Whitespace is left out on both sides because the
   HTML's formatting newlines are not source. A block that does not align
   is refused; nothing near-matches.

A selection then maps to the units it covers WHOLLY (`Range.comparePoint`),
from the first one's source offset to the last one's (`markdownRange`).
Nothing is searched, so a selection can never be resolved to another
occurrence, and a word that appears twice with identical context maps to the
one selected. A selection of only whitespace, or one that touches a
generated unit, is refused. The highlight is the same walk backwards: the
shown units whose source lies in the stored range.

When the span render cannot be proved, NO block gets a span and a rendered
selection is refused (the Limits below). That happens for a lone CR, which
marked reads as a break and the LINE model as a character, and when the
top-level token raws do not rejoin into marked's input. Otherwise the HTML is
the plain render's, byte for byte. The span render has its own LRU cache, so
a chat render never carries `data-src` and a span render is never served to
chat, in either call order. The span mode lexes and parses with marked's
merged defaults, as `marked.parse` does, so every `marked.use` extension
(safe URLs, bare path links, the del tokenizer) applies in both modes.

Pinned by `core/markdown.test.ts`: the span render equals the plain render
on a corpus once `data-src` is removed; the `data-src` table (the md wrapper's
second paragraph, a paragraph after a 4-line formula, reference definitions,
a nested list in a blockquote, fenced code → multi-line math → paragraph,
CRLF, a lone CR with no spans); and the cache in both orders, including a
body that spells the other mode's key.

Pinned by `files/review-map.test.ts`, each row rendered by the real
`renderMarkdown` into a real DOM and selected as a person would: the
reviewer's `` `a*b` a\*b `` row (the code's `a*b` is the first range, the
escaped one covers its backslash); identical paragraphs and a zero-context
twin in one sentence; emphasis, a link, a heading, escapes, `&` and `<`, and a
selection from one element into another; inline code holding markup and
escaped backticks; selections across paragraphs, list items and a
blockquote; a KaTeX region refused, the prose beside it mapped, and lines
after a multi-line formula unshifted; the md wrapper, CRLF, emoji, CJK
emphasis, a table cell's `-` (never the delimiter row), a bare path and a
URL; fenced code, a mermaid block refused, a nested list in a quote; every
block of a corpus aligned with its highlight equal to its text; a lone CR
and a DOM edited under the map refused; and the content rows: `# # **x**`
(the visible `#` is column 3, never the marker), stars and brackets that
equal their delimiters, closing hashes, a setext heading, an escaped `>` and
a lazy line in a blockquote, a nested quote, a nested list item past both
markers, a continuation line, a wide ordered marker, and a table cell with
an escaped pipe refused with its whole table. And by `files/review-anchor.test.ts`:
the LINE model's shared rows read out of `review.rs`, the code rows (emoji,
multi-line, a CRLF row; outside, empty or whitespace-only refused), and the
offset conversions.

### An HTML selection maps through parse5's positions, checked against the frame

The HTML preview is the #433 frame (`basedPreviewDoc(content)`, sandboxed,
no scripts). The design was CLEARed at delta 2 on the issue. A selection in
it maps to the source the way the markdown one does: positions are proved,
then checked against the DOM, and refused otherwise (`files/review-html.ts`).

**Coordinates, layer by layer.**
- Raw bytes give the revision, sha256 as before.
- `content`, the string `fs_read` returns, is what the frame shows. The
  browser folds CRLF to LF before it tokenizes.
- The LINE text is `content` with `\r\n` → `\n`. A lone `\r` refuses the
  document, because the browser reads it as LF and the LINE model as a
  character. The LINE text is parse5's INPUT, so its offsets ARE LINE
  offsets.
- Units are `{ch, from, to}` in LINE UTF-16 units.
- The wire form is `offsetsToRange`, as for markdown.

**Source positions** come from parse5 8.0.1 (`sourceCodeLocationInfo`,
`scriptingEnabled: false`, the frame's own scripting state, so `<noscript>`
is markup in both parses). It is loaded on first use through ONE lazy entry
(`loadHtmlParser`, together with `entities` 8.1.0, parse5's own decoder).
A spec parser is not rebuilt by hand (tenet 2).

**Its cost, measured** (`vite build` on this branch, `gzip -c | wc -c`): the
lazy entry loads three chunks, parse5 26,300 B, the decode tables parse5 and
entities share 17,782 B, and entities 6,543 B, 50,625 B gzip in all. None is
in `index.html` or imported statically by the main chunk; they load when an
HTML preview inside a project is first bound. The one lazy entry is pinned
by `files/review-html.test.ts`. Measure again when either
version moves.

**What a text node shows**, unit by unit, from its raw slice:
- A character reference is recognised only WITH its semicolon (`&name;`,
  `&#n;`, `&#xn;`) and decoded by `entities.decodeHTML`.
- All the units a reference shows share its whole source span. Selecting
  part of an astral `&#x1F600;`, for example, stores the whole reference,
  and the card's quote and highlight show it.
- The decoded slice must EQUAL the node's value. If it does not, or the
  node has no location, the document is refused, never searched. That
  covers a legacy reference without its semicolon, which parse5 decodes,
  and text moved by error recovery.

**Hidden and generated.**
- The head (where basedPreviewDoc's CSP, base and style live), `script`,
  `style`, `template`, `title` and `noframes` show nothing in either walk.
- A `textarea`, a `select` (with its options) and a `[contenteditable]`
  (any value but `false`) are ONE generated unit each, never an anchor. A
  selection touching one is refused.

**The check.** The frame document's walk must equal the map unit for unit.
It is checked again at every selection and every paint, so an edit in a
contenteditable region or a DOM changed under the map is refused.

**Order** (reviewer P1 on 6a4950ec). The walk is in DOM order, and error
recovery can show text in another order than its source: foster parenting
moves `B` in `<table><tr><td>A</td></tr>B</table>` before the table, with
its later location kept, in parse5 and in a browser alike. So the units a
selection covers are accepted only as ONE ordered span, proved in bounded
passes (`orderedSpan`): each unit starts at or after the previous one's
end, or shares its whole span (a reference's units, the one allowed
equality), and no unit outside the run lies inside the span. Otherwise the
selection is refused with its reason (`reviewRefusedOrder`), never widened
to min/max and never cut to its first unit. A stored range is painted by the
same proof: the units in it must be one DOM run in source order, or the card
stays without a highlight.

**The quote is the mapped range's.** The draft's quote is what the mapped
range shows, read back through the same inverse a highlight uses, so a
reference half selected is quoted and highlighted whole.

Pinned by `files/review-html.test.ts`, each frame built through the real
`basedPreviewDoc` serialization and parsed again:
- entities, with the whole span stored, an astral reference half selected,
  and a reference next to an emoji;
- CRLF before the node and across lines, with the stored line/col checked;
- a lone CR refused, in text and in markup;
- nested inline elements, twins, script and style skipped, noscript shown,
  a comment;
- a foster-parented table, single nodes: a proved position or a refusal;
- text shown out of source order: B→A refused, A→C refused (its span holds
  the unselected B), single nodes exact, a stored range over both painted
  nowhere; an ordinary selection across elements exact both ways. jsdom's
  `DOMParser` leaves the stray text after the table, unlike a browser, so
  this row sets the frame's DOM in the browser's order;
- a selection over 200,000 units, computed without an argument spread;
- form and editable regions refused, and an edited DOM refused;
- a legacy `&copy` refusing the document, while a bare `AT&T` stays literal.

The module is split by realm: `files/review-html-map.ts` is the source side
(the lazy parse5 entry, `htmlSourceMap`), `files/review-html.ts` the DOM side
(the walk, the check, `htmlSelection`, `htmlHighlight`). The mount test mocks
the source side only, and the DOM side runs in the frame's realm.

### The HTML frame is bound to one loaded Document, or to nothing

The preview lives in an iframe, so the review works on the FRAME's document,
selection, `Range`s and `CSS.highlights` registry, never the page's.

**One conversion, `Surface.toParent`.** Every surface (the code view, the
markdown render, the frame) gives its document, window, root, scroller and
one function from its client rects to the page's zoomed CSS pixels. The page
surfaces divide by `uiZoom()`. The frame surface adds the frame's own
content-box origin, `frame.rect / uiZoom + clientLeft/Top`, to the inner
rect, once: an inner rect already reflects the frame's scroll, the frame's
rect any outer one. Hit testing (a click on a highlight) never converts; it
stays in the frame's own coordinates. The ＋, the reason and the card tops
all go through `toParent`, so there is no second formula.

**One effect owns the binding.** It depends on what a binding is made of:
the frame ELEMENT, its loads, the source revision and text, the review
target, the preview's life (`context()`) and the host's eligibility. Every
run retires the previous binding at once: `bindGen` moves and the document,
the map and the pending ＋ are dropped. A new binding is installed only when
its map arrives while `bindGen`, the frame's `contentDocument` and the
revision are all unchanged, and the map aligns with that document unit for
unit (`alignedHtml`). Otherwise nothing is bound and the reason is shown.
- A srcdoc change remounts the frame (FilePreview's `{#if htmlSrcdoc}`), so
  the old binding is retired by the element changing, before the new
  document exists.
- A hide→show of the SAME loaded document fires no load. The frame is
  remembered in a `WeakSet` once it has loaded, so the effect binds again on
  the context change alone (reviewer residual on delta 1).
- The parsed map is cached by source text and may be reused across
  bindings. A document's nodes and Ranges never are.

**Listeners live in the frame's window**: the MutationObserver on its
documentElement, the scroll on its document, and the late-resource re-place.
An HTML root may have a fixed height, so a `ResizeObserver` on it is not
enough: placement also runs on the document's resource `load` events
(capture), on `fonts.loadingdone`, and on the frame element's own resize.

**The highlight style is in the frame.** App tokens do not cross into it,
so `basedPreviewDoc` writes ONE `<style>` after the policy (the CSP and
referrer, and the base when there is one): `::highlight(review)` and
`::highlight(review-hot)` from the system `Highlight` colour at 30% and 55%.
It is after the CSP so the policy governs it, and it is the same on both the
scoped and unscoped paths.

**The reason line.** A frame that cannot be commented on says why, in the
person's language: no document, the two parses disagree, or the parser
failed to load (with its error).

Pinned by `files/FileReview.html.mount.test.ts` (the real Files page and
frame, with the map module mocked to the real one): select → ＋ → note saves
`{line 3, col 5, end_col 11}` and paints into the FRAME's registry; hide→show
of the same document with no load binds and paints again; a map still
pending over hide→show installs nothing when it arrives, while the new
binding does; a map arriving while the preview is hidden binds nothing; a
re-read with the same text at new offsets maps through the new source, not
a cached map; a resource `load` and a `fonts` `loadingdone` in the frame
each re-place the cards; part of a multi-scalar reference selected is
quoted in the draft and stored whole; `&copy` shows the reason and no ＋. By
`files/file-preview.test.ts` (one style, after the policy, on both paths)
and `files/FileReview.source.test.ts` (both `toParent` conversions, and card
tops and the ＋ through them).

### The cards, the ＋ and the highlights

`files/FileReview.svelte` wraps the preview (`children`) for a text file:
code (the lined view), markdown and HTML (the frame, bound as above). It is
off for every other kind, and for a file in no project, where the preview
renders alone.

**Which project.** The Files instance asks `project_list` when a text file
opens and on every re-read. The projects whose root holds the file are the
candidates, innermost root only (`reviewProjects`). One candidate is it. Of
several at that root, the one whose session is the Files instance's own
(the Hub drawer's room) is it. Otherwise the person picks with `ui/Select`,
and nothing is read until they do. No candidate turns the feature off. A
FAILED `project_list` is not "no candidate" (reviewer P2): it shows the
error with a Retry, and nothing is read or written until it answers.

**No toolbar.** A non-empty selection inside the preview shows one floating
"＋ Comment", placed by `menuPlacement` beside the selection. A selection
that maps but is refused (whitespace, generated text, a tie, a document with
no spans) shows the reason, in the person's language, where the ＋ would
be: `review-anchor.ts` returns i18n keys. Mousedown on it keeps the
selection, and a touch press holds the mapping while the selection collapses
under the finger.

**The editor is a card.** ＋ opens a card with the quote and a textarea:
Save and Cancel, ⌘/Ctrl+Enter saves, an empty note cannot be saved. Save
sends the range with the revision `fs_read` returned for the text on
screen. A stale answer keeps the card and its text and says the file
changed. A local editor save clears the revision until the next read, so
nothing is added or painted against text the server never hashed.

**A card** shows the quote (cut at 60), the note, and its place: "Line N",
"beyond the preview (line N)" for a located line past the 3000-line cap,
"no longer in the file" (missing) or "more than once; no position"
(ambiguous). Edit, Resolve or Reopen, and Delete are in the card's
ContextMenu, opened by right-click, long-press or its ⋯ button. Delete goes
through ConfirmDialog. Resolved cards hide behind a "Show resolved" toggle.

**Unsaved notes** live in the server's runtime state
(`ServerState.review.notes`, `files/review-state.ts`), keyed by
`(project_id, path[, annotation id])`. A file switch, a project pick or a
Reload keeps them, and coming back restores the open editors. Two projects
at one root never share a note. Cancel drops one.

**Layout by the preview's own width.** A `ResizeObserver` on the wrapper
decides it. Narrower than 260 + 440 px (a phone, a narrow drawer, a split
pane), the cards fold under the preview behind "Comments (N)", the same card
atom. No bottom sheet, no Dialog.

**The wide column** (reviewer P1-C and the validator's findings on
5b2a004f). Its head keeps "Comments (N)" on one line (ellipsis if it must),
with "Send as feedback" on the row under it; at 1440 the count had wrapped
beside the button. Under the head, the lane is a real scroller: its content
is as tall as the preview's content or the card stack, whichever is taller,
so every card and its menu stay reachable however many long comments sit on
one short paragraph. Nothing in the column is clipped.
- Each card is placed in the preview's content coordinates only:
  `(rangeTop − scrollerTop) / uiZoom + scroller.scrollTop`, plus the
  scroller BOX's offset from the lane box. Client rects are divided by
  `uiZoom()`, the rule every popover follows, because a CSS `top` is in
  zoomed pixels. The lane's own `scrollTop` is in no formula, card top or
  lane height (reviewer P1-C on 93c1b929): it was, so a re-place after the
  person scrolled the lane (a hover, a focus, an editor growing) moved every
  card by that scroll and undid it.
- The take-over rule: a scroll of the preview drives the lane's
  `scrollTop`, so a card stays level with its highlight; a scroll of the
  lane by the person is left alone until the preview scrolls again. Past
  the preview's end, the lane scrolls on by itself.
- Cards never overlap: each is pushed below the one above it, with the
  lane's token gap. Cards with no highlight (missing, ambiguous, beyond the
  cap, another revision) follow in line order; the card being written sits
  at its selection.
- Placement runs on every change to the cards or the highlights: a paint (a
  read, an add, an edit, a resolve, a delete, a Reload, the preview
  re-rendering), any card changing height (a `ResizeObserver` on each: an
  editor opening, a note growing), and a scroll. Placing only on scroll is
  what left two cards on top of each other after a Save.

**The fold clears the system-status strip.** Below the compact width on
the desktop layout, the fold row is a bottom control in the strip's corner.
It clears the strip by the shell's one reserve rule, the same
`--sys-sidebar-h` bottom the sidebars take (`.files.strip-over`,
system-status.md), with no offset or layer of its own (validator on
4500d422: both buttons took 0 clicks under the strip).

**The editor being typed in stays in view.** When a re-place MOVES it (a
Reload left a new comment's text off screen, so it goes to the lane top),
it is scrolled into view by the same `scrollIntoView` a card's focus uses.
A scroll moves no card, so it never pulls the lane against the person's
scrolling. A card's menu button is named "Comment actions: <quote>".

Spacing in the component is from the existing tokens (`--ui-gap`,
`--config-label-gap`, `--menu-item-padding-*`); the column's width is one
value, `CARD_W`, handed to CSS as `--rv-card-w`.

**Highlights** use the CSS Custom Highlight API (Chromium 105+, Safari
17.2+, Firefox 140+; the Android System WebView follows Chromium). The DOM
the preview renders is never touched. `::highlight(review)` and
`::highlight(review-hot)` are styled once in `app.css` from the accent
tokens. The hot one is the card under the pointer or focus. `CSS.highlights`
is one registry per document, so each Files instance adds and removes ONLY
its own ranges in those shared names (`ownHighlight`) and never clears the
registry. This replaces the per-instance names of the delta-3 note: a
`::highlight()` name cannot be a variable in a stylesheet, and per-instance
names would need a stylesheet injected per instance. The rule that mattered
(an instance never clears another's highlight) is unchanged. Without the API
there are no highlights and the cards work as before.

Highlights are painted only while the listing's revision is the preview's.
Otherwise the cards list with "Reload to place the comments". A code range
is painted from its rows (`codeHighlight`). A markdown range is found again
as its shown text, once, inside the block whose span holds its first line
(`markdownHighlight`); found twice or not at all, the card stays without a
highlight. Whenever the preview's DOM changes (the highlighter landing,
mermaid, a Reload), a `MutationObserver` paints again.

**A click on highlighted text** focuses its card. A non-empty selection and
a link both keep the click. The point is read with
`caretPositionFromPoint`/`caretRangeFromPoint`, and nothing calls
`preventDefault`.

**Refresh.** The cards are read again on Reload and when the preview is
returned to (Files' re-read bumps `reviewRefresh`). A `tmm review` change
appears then. There is no live sync.

### Send as feedback: one landing, and the person's recipient wins

"Send as feedback" (shown while there are open comments) does this:
1. Captures the project's recipient generation (`recipientIntent`).
2. Asks `review_feedback` for the open target.
3. Asks `project_list` again and finds the project by its stable id, so a
   rename is followed. A removed project lands nothing, and the button says
   so. An answer for a target the page has left is dropped.
4. Lands the block ONCE (`landFeedback`). If a Hub on this server shows that
   room, the block goes into its LIVE composer, after what the person typed
   there (the Hub registers its composer in `ServerState.review.composers`).
   Otherwise it is appended to that room's stored draft, read at that moment.
5. On the Files page, App then opens the Hub on that room through the same
   `hubSelectReq` landing a union pick uses. The Hub drawer's Files needs
   nothing more.

**Every request is bound to the preview's life** (reviewer P1-B on
5b2a004f and 93c1b929). The life is a monotonic generation, bumped on EVERY
exit: Files hidden or its operation context changing (`feedbackContext`:
session, root, directory, view, file, navigation request), the host's
binding changing (`scope.eligible`: a server away, and back), another
review target, and the component going away. A feedback request, a save,
an edit, a resolve or a delete captures the generation when it starts and
asks after EVERY await, and again before landing or asking App to
navigate, whether it is unchanged. A request that saw any exit is dead
even when the same preview comes back before its answer: comparing the
context's values again would have revived it (hide→show, away→back). A
dead request writes no draft, sets no recipient and switches no tab. Every
exit also ends `saving` and `sending`, so the page it leads to is never
stuck behind a dead request; each flag is cleared by the request that set
it when it ends.

**A save forgets only the draft it submitted, by identity, from one
source.** Every write of an unsaved note makes a NEW object, and that object
is the draft's identity. Each editor HOLDS the object it displays: a save
sends that object's text (and, for a new comment, its selection), and the
same object is what its success, a Cancel and the editor itself compare
against (reviewer P1-B on 3a33f2ea). The Files page and the Hub drawer share
one server's notes map, so the map's latest object can be the OTHER
editor's; taking it for this one's made A's save, sent with A's text, erase
B's unsaved draft. The map stores each key's latest write, so a rebuilt
editor gets the last keystroke back; it loses an object only to the
success or Cancel of THAT object. A per-key counter was not enough either
(reviewer on 58df654c): Cancel deletes the entry, so a draft made again
under the same key restarted at the same count. A note typed while its
first version was saving — in the same editor, in the other editor on the
same key, after leaving the file and coming back, or after a Cancel and a
new selection or a re-opened edit — is another object, survives and can be
saved. Cancel stays available while a save is pending. An accepted draft
never reappears. One limit: the map keeps one draft per key, so when both
editors write the same key, the one written last is the one a rebuilt
editor restores.

Nothing is sent. The person presses Send, and the delivery is the ordinary
typed one.

**The recipient.** Every explicit choice goes through the Hub's one
`setRecipient`, which bumps the project's generation: a name, All, a team
and the empty record-only choice alike. When the block lands in a live
composer and the generation is still the captured one, the automatic
recipient applies: an agent recipient is kept, otherwise the last managed
agent that posted in the room, otherwise unchanged. Any choice in between,
including empty→alice→empty and alice→bob→alice, keeps the person's latest
choice. The generation is keyed by project id, so a rename keeps it, and it
is memory only, like the request it guards. A block that lands in a stored
draft sets no recipient: the room's own lead seating applies when it opens.

### Limits

- The quote and the "in" line are the LINE form of the text (CRLF and LF
  both `\n`), not raw bytes. The revision is the raw bytes' hash.
- A selection that cannot be mapped is refused, never guessed. A markdown
  document whose span render cannot be proved (a lone CR, token raws that do
  not rejoin), or a block whose content cannot be derived or whose DOM does
  not align with its source map (raw HTML, a table cell holding `\|`),
  cannot be commented on in the rendered view.
  `tmm review add --lines` still reaches it.
- Without the Custom Highlight API there are cards only.
- No live sync: Reload or a return shows other writers' changes.
- HTML: the frame runs no scripts, so a page that builds its text with
  script shows (and maps) only its static markup. A document whose two
  parses disagree (error recovery the frame's parser does differently) is
  refused whole, as is one with a legacy entity (no semicolon) or a lone
  CR. A selection across text shown out of source order (foster-parented
  table text) is refused. A form or editable region (textarea, select,
  contenteditable) cannot be selected; `tmm review add --lines` still
  reaches all of these.

Pinned by `files/FileReview.mount.test.ts` (the real Files page): select → ＋
→ note → the add carries the range and revision, and the card follows; a
stale add keeps the note; the card states, including beyond the cap; an
instance clearing only its own highlight ranges, and cards without the API;
resolve through the menu and delete through the one confirm; feedback
landing in the renamed room's latest draft, and nothing for a removed
project; two projects at one root, picked, each with its own note; no
affordance outside a project; a markdown selection mapped inside its markup
and highlighted; the wide column under a fake layout (a card level with
its highlight, a second card on the same line saved without a Reload placed
below the first, the missing card after both, the lane as tall as the
stack, the lane following a preview scroll; a lane scrolled to its end with the
preview still, a hover and a focus re-placing nothing, and its last card
resolving); a pending `review_feedback` and a pending second
`project_list`, each walked through Back, hide, a server switch and another
file, landing nothing and navigating nowhere, with the next send landing; a
save retired by a file switch forgetting its note while the next file saves;
a failed `project_list` shown as an error with a Retry and nothing read
until it answers. The ABA order: a pending `review_feedback` and a pending second
`project_list`, each over hide→show and server away→back BEFORE the answer
arrives, landing nothing; and a note typed while its first version was
saving surviving that save, for an add, for an edit, and after leaving the
file and coming back; and a draft cancelled while its save was pending and
made again under the same key (one keystroke each, so any counter would
match) surviving that save with its own text and selection, for an add and
for an edit. And by `files/FileReview.two.mount.test.ts`, the Files page
and the drawer on one server and one key: A writes, B writes, A saves
without typing again → the request is A's text and selection, B's draft
stays open and in the shared notes and saves its own; the same for an edit,
with B's editor rebuilt from the shared notes; and A's Cancel closing A only,
B's draft staying in the shared notes and coming back when B is rebuilt. Also by `files/FileReview.source.test.ts` (the lane scrolls and nothing in
the column clips, spacing from tokens, card tops divided by `uiZoom`), by
`files/review-state.test.ts` (draft and live landings, the generation, ABA) and by `hub/Hub.mount.test.ts` (the live
composer keeps the typed text, an agent recipient is kept, the last agent
poster is picked only while nobody chose, and both ABA sequences keep the
person's choice).
