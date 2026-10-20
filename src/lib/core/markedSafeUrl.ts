// A bare-URL autolinker for `marked` that stops at CJK / fullwidth characters.
//
// GFM's built-in autolink extends a bare URL until whitespace, so a URL pasted
// immediately before non-ASCII text — e.g. `https://host/admin（密码：xyz）` —
// swallows the trailing `（密码：xyz）` into the href. This inline extension
// matches the URL up to the first CJK or fullwidth char (and drops trailing
// sentence punctuation), leaving the rest as plain text.
//
// It also carries the two attribute-context guards every renderer needs
// (2026-09-03 review): a `"` inside a URL is percent-encoded before it lands in
// `href="\u2026"`, and a link or image whose target is not http(s), mailto or
// relative is rendered as its TEXT. The `&`/`<` escape the chat path applies
// makes text inert; an attribute has its own delimiter, and marked v17 does not
// sanitize schemes \u2014 `[x](javascript:\u2026)` used to reach the DOM as written.
//
// It also turns a bare FILE PATH (board #431, grammar in core/path-grammar.ts)
// into the same `<a href="path">` a `[text](path)` link produces, in prose and
// in an inline code span that is one path, never inside a link.
//
// `marked` is a singleton, so importing this module once registers it for every
// renderer (Files preview, Team chat, Chat view).
import { marked } from 'marked';
import { STOP, firstPathAt, matchPath } from './path-grammar.ts';

/** The ONE href encoder, for two kinds of input (#431 review P1-A).
 * - `'url'`: marked's own `cleanUrl`. It percent-encodes what encodeURI
 *   encodes (`"`, `'`, `<`, `>`, space\u2026) and undoes double-encoding of `%`,
 *   because a URL may arrive already encoded.
 * - `'path'`: a bare filesystem path is NOT an encoded URL. Its `%` is a
 *   literal byte (`/tmp/a%20b.md` is a file with `%20` in its name), so it is
 *   encodeURI with no undo, and `pathRef`'s one decodeURIComponent on click
 *   gives back exactly the matched path.
 * `null` when the input is not even encodable (a lone surrogate). */
export function encodeHref(href: string, kind: 'url' | 'path' = 'url'): string | null {
  try {
    const encoded = encodeURI(href);
    return kind === 'path' ? encoded : encoded.replace(/%25/g, '%');
  } catch { return null; }
}

/** Is this target something a reader can follow without running code?
 * Allowed: no scheme (relative, `#anchor`), `http:`, `https:`, `mailto:`.
 * The scheme is read the way a BROWSER reads an attribute \u2014 numeric and
 * `&colon;` entities decoded, ASCII control characters and spaces stripped
 * (`java\tscript:` is `javascript:` to WebKit) \u2014 so an encoding trick cannot
 * smuggle `javascript:` past a naive prefix test. */
export function safeLinkTarget(href: string | null | undefined, kind: 'link' | 'image' = 'link'): boolean {
  if (href == null) return false;
  const decoded = href
    .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Number(d) & 0x1fffff))
    .replace(/&#[xX]([0-9a-fA-F]+);?/g, (_m, h) => String.fromCodePoint(parseInt(h, 16) & 0x1fffff))
    .replace(/&colon;/gi, ':')
    .replace(/[\u0000-\u0020\u007f]/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(decoded);
  if (!m) return true; // relative
  const scheme = m[1]!.toLowerCase();
  if (scheme === 'http' || scheme === 'https') return true;
  return kind === 'link' && scheme === 'mailto';
}

marked.use({
  renderer: {
    // Returning `false` hands the token back to marked's default renderer, so
    // an allowed target renders exactly as before (title, escaping, encoding).
    link(this: any, token: any) {
      if (safeLinkTarget(token.href, 'link')) return false;
      return this.parser.parseInline(token.tokens);
    },
    image(this: any, token: any) {
      if (safeLinkTarget(token.href, 'image')) return false;
      // The alt text is plain text; escape it as marked would have.
      return String(token.text ?? '').replace(/&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  },
});

marked.use({
  extensions: [
    {
      name: 'safeUrl',
      level: 'inline',
      start(src: string) {
        const i = src.search(/https?:\/\//);
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^https?:\/\/[^\s<]+/.exec(src);
        if (!m) return;
        let url = m[0];
        const cut = url.search(STOP);
        if (cut >= 0) url = url.slice(0, cut);
        // Trailing sentence punctuation is almost never part of the URL.
        url = url.replace(/[.,;:!?'"]+$/, '');
        // Nothing meaningful past the scheme → let the default tokenizers try.
        if (!/^https?:\/\/.+/.test(url)) return;
        return { type: 'safeUrl', raw: url, href: url, text: url };
      },
      // The text is a substring of the (already HTML-escaped) source and goes
      // through unchanged. The href is an ATTRIBUTE: a `"` in the URL would end
      // it and the rest of the URL would become markup, so it is percent-encoded
      // exactly as marked's own autolink does. An unencodable URL is text.
      renderer(token: any) {
        const href = encodeHref(token.href);
        return href === null ? token.text : `<a href="${href}">${token.text}</a>`;
      },
    },
    // A bare file path (board #431, core/path-grammar.ts) becomes the SAME
    // `<a href="path">` a `[text](path)` link produces, so path-links.ts, the
    // Files routing, `:line` handling and the click priority stay one
    // mechanism. A URL is never re-read as a path, and that does NOT rest on
    // the registration order (marked tries a later-registered extension
    // first, #431 review P2). At a URL's start the path tokenizer refuses,
    // because a scheme run (`https`) holds no slash before its `:`. The URL
    // tokenizer then consumes the whole URL, query included; the URL rows of
    // markdown.test.ts pin it. Two token-stage decisions, both refused
    // while marked lexes a link's or an image's text (`lexer.state.inLink`),
    // so a path inside `[...](url)`, `[...][ref]` or `![...](img)` never
    // becomes a second, nested anchor (#431 review P1-B).
    {
      // An inline code span whose WHOLE content, as written, is one path.
      // A span that only contains a path (`cargo test src/a.rs`) is left to
      // marked's own codespan, so a command stays a command to copy.
      name: 'pathCode',
      level: 'inline',
      start(src: string) {
        const i = src.indexOf('`');
        return i < 0 ? undefined : i;
      },
      tokenizer(this: any, src: string) {
        if (this.lexer.state.inLink) return;
        const m = /^`([^`\n]+)`(?!`)/.exec(src);
        if (!m) return;
        const hit = matchPath(m[1]!, '');
        if (!hit || hit.raw !== m[1]) return;
        return { type: 'pathCode', raw: m[0], text: hit.raw };
      },
      renderer(token: any) {
        const href = encodeHref(token.text, 'path');
        return href === null ? `<code>${token.text}</code>` : `<a href="${href}"><code>${token.text}</code></a>`;
      },
    },
    {
      // A path in prose. The character before it comes from the token just
      // lexed, since marked hands the tokenizer only what is left.
      name: 'pathRef',
      level: 'inline',
      start(src: string) {
        const i = firstPathAt(src);
        return i < 0 ? undefined : i;
      },
      tokenizer(this: any, src: string, tokens: any[]) {
        if (this.lexer.state.inLink) return;
        const prev = String(tokens.at(-1)?.raw ?? '').slice(-1);
        const hit = matchPath(src, prev);
        if (!hit) return;
        return { type: 'pathRef', raw: hit.raw, text: hit.raw };
      },
      // The text is a substring of the (already escaped) source: a path holds
      // no `&` or `<`, so it goes through unchanged.
      renderer(token: any) {
        const href = encodeHref(token.text, 'path');
        return href === null ? token.text : `<a href="${href}">${token.text}</a>`;
      },
    },
  ],
});
