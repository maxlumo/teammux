// The project page's logic (board #111; docs/design-docs/features/dashboard.md
// § The project page). Pure, so its lifetime rule, its "in progress" reading
// and its look are tested without a frame. ProjectPage.svelte draws it.

/** The current page as the dashboard read names it (`hub_dashboard.page`). */
export interface PageHead { rev: number; by: string; at: number }

/** A loaded document: which revision it is and until when its door opens. */
export interface PageDoc { rev: number; exp: number }

/** The expiry (unix seconds) a scope cap carries: the segment right after the
 * door's own prefix on this connection (`<origin><proxy prefix>/dl/s/`), never
 * the first `/dl/s/<digits>/` found anywhere: a proxy prefix may hold one
 * (validator F4). NaN when the URL is not under the prefix or the segment is
 * not digits, which reads as already expired. */
export function capExpiry(url: string, prefix: string): number {
  if (!url.startsWith(prefix)) return Number.NaN;
  const seg = url.slice(prefix.length).split('/')[0] ?? '';
  return /^\d+$/u.test(seg) ? Number(seg) : Number.NaN;
}

/** Is the document on screen behind the server's page, or past its door's
 * lifetime? */
export function staleness(doc: PageDoc, head: PageHead, nowMs: number): 'current' | 'newer' | 'outdated' {
  if (head.rev !== doc.rev) return 'newer';
  return !(nowMs < doc.exp * 1000) ? 'outdated' : 'current';
}

/** THE adoption rule (board-dashboard.md § 6; AC6 as amended by leader Q2):
 * no document yet loads the newest; a stale one (a newer revision, or past
 * its 4 h) is replaced only when nothing is in progress, otherwise the header
 * offers Refresh. A head the read could not give (`undefined`) decides
 * nothing; no page (`null`) is the caller's absent section. */
export function decide(doc: PageDoc | null, head: PageHead | null | undefined, busy: boolean, nowMs: number): 'none' | 'load' | 'offer' {
  if (!head) return 'none';
  if (!doc) return 'load';
  if (staleness(doc, head, nowMs) === 'current') return 'none';
  return busy ? 'offer' : 'load';
}

/** The page's form controls as they were when it LOADED (validator F3): an
 * attribute is not the loaded state (an untouched first option, range or
 * colour has a value but no default in Chromium and WebKit), so "edited" is
 * measured against this snapshot, taken by the parent at the frame's load. */
export type FieldSnapshot = string[];

const CONTROLS = 'input, textarea, select';
const SKIPPED = ['button', 'submit', 'reset', 'image', 'hidden'];

function stateOf(el: Element): string | null {
  if (el.tagName === 'SELECT') return [...(el as HTMLSelectElement).options].map((o) => (o.selected ? '1' : '0')).join('');
  if (el.tagName === 'TEXTAREA') return (el as HTMLTextAreaElement).value;
  const input = el as HTMLInputElement;
  if (SKIPPED.includes(input.type)) return null;
  if (input.type === 'checkbox' || input.type === 'radio') return input.checked ? '1' : '0';
  if (input.type === 'file') return String(input.files?.length ?? 0);
  return input.value;
}

export function fieldSnapshot(doc: Document): FieldSnapshot {
  return [...doc.querySelectorAll(CONTROLS)].map((el) => stateOf(el) ?? '');
}

/** The controls whose state differs from the snapshot (by document order: a
 * script-less page cannot add or remove one). */
export function editedFields(doc: Document, snap: FieldSnapshot): number {
  let n = 0;
  [...doc.querySelectorAll(CONTROLS)].forEach((el, i) => {
    const now = stateOf(el);
    if (now !== null && now !== (snap[i] ?? '')) n++;
  });
  return n;
}

/** Media the person started and that has not ended. */
export function playingMedia(doc: Document): number {
  return [...doc.querySelectorAll<HTMLMediaElement>('audio, video')].filter((m) => !m.paused && !m.ended).length;
}

/** "In progress": what the adoption rule must not take from under the person. */
export function inProgress(doc: Document | null, snap: FieldSnapshot): boolean {
  return !!doc && (editedFields(doc, snap) > 0 || playingMedia(doc) > 0);
}

/** The frame's height: the document's own block, so the page can shrink
 * (the base sheet takes html and body margins away). */
export function contentHeight(doc: Document): number {
  return Math.ceil(doc.documentElement.getBoundingClientRect().height);
}

/** The app tokens a page reads, by their app names. Their VALUES are read from
 * the app's computed style at injection time, so the page follows the current
 * theme and the reader's font settings; nothing here is a literal. */
export const PAGE_TOKENS = [
  '--bg', '--surface', '--surface2', '--text', '--text2', '--text3', '--accent', '--accent-ink',
  '--border', '--input-border', '--input-bg', '--code-bg', '--status-ok', '--status-warn', '--status-danger',
  '--font-ui', '--font-display', '--font-mono',
  '--fs-meta', '--fs-sub', '--fs-ui', '--fs-body', '--fs-title', '--fs-display',
  '--ui-radius-control', '--ui-radius-panel',
] as const;

/** The element sheet: plain semantic HTML in the app's look, by the tokens
 * alone. The page may add its own CSS after it. The bundled webfonts do not
 * reach the frame (its policy admits fonts from the door and data: only), so
 * each role's stack falls back along the app's own chain (leader, Q3). */
const BASE_SHEET = [
  'html,body{margin:0;background:transparent}',
  'html{color:var(--text);font:400 var(--fs-body)/1.6 var(--font-ui);-webkit-text-size-adjust:100%}',
  'body{overflow-wrap:break-word}',
  'h1,h2,h3,h4,h5,h6{font-family:var(--font-display);font-weight:600;line-height:1.3;margin:0.9em 0 0.4em}',
  'h1{font-size:var(--fs-display)}h2{font-size:var(--fs-title)}h3,h4,h5,h6{font-size:var(--fs-body)}',
  'body>:first-child{margin-top:0}',
  'p,ul,ol,dl,table,details,pre,blockquote,figure{margin:0.5em 0}',
  'ul,ol{padding-left:1.4em}',
  'a{color:var(--accent-ink)}',
  'small,figcaption,caption{color:var(--text2);font-size:var(--fs-meta)}',
  'code,kbd,samp,pre{font-family:var(--font-mono);font-size:var(--fs-ui)}',
  'code{background:var(--surface2);padding:0 0.3em;border-radius:var(--ui-radius-control)}',
  'pre{background:var(--code-bg);padding:0.75em;border-radius:var(--ui-radius-panel);overflow-x:auto}',
  'pre code{background:none;padding:0}',
  'table{border-collapse:collapse;width:100%;font-size:var(--fs-ui)}',
  'th,td{border:1px solid var(--input-border);padding:0.4em 0.6em;text-align:left;vertical-align:top}',
  'th{background:var(--surface2);font-weight:600}',
  'hr{border:0;border-top:1px solid var(--border);margin:1em 0}',
  'blockquote{border-left:3px solid var(--accent);padding-left:0.75em;color:var(--text2);margin-left:0}',
  'details{border:1px solid var(--border);border-radius:var(--ui-radius-panel);padding:0.4em 0.75em}',
  'summary{cursor:pointer;font-weight:600}',
  'img,video,svg,canvas{max-width:100%;height:auto}',
  'audio{width:100%}',
  'progress,meter{accent-color:var(--accent);vertical-align:middle}',
  'input,select,textarea,button{font:inherit;color:inherit;background:var(--input-bg);border:1px solid var(--input-border);border-radius:var(--ui-radius-control)}',
  ':focus-visible{outline:2px solid var(--accent);outline-offset:2px}',
].join('');

/** The sheet the frame gets: the CURRENT values of the tokens, then the
 * element sheet. `read` is the app's computed style lookup. */
export function pageSheet(read: (name: string) => string, dark: boolean): string {
  const vars = PAGE_TOKENS.map((name) => `${name}:${read(name).trim()}`).join(';');
  return `:root{color-scheme:${dark ? 'dark' : 'light'};${vars}}${BASE_SHEET}`;
}
