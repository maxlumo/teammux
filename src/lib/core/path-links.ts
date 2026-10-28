import { findPaths } from './path-grammar.ts';
import { encodeHref } from './markedSafeUrl.ts';

/** A file reference, not an external URL or an in-document fragment. */
export function pathRef(href: string | null | undefined): string {
  const raw = href?.trim() ?? '';
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return '';
  const path = (raw.split('#')[0] ?? '').replace(/:\d+(?::\d+)?$/u, '');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path)) return '';
  try { return decodeURIComponent(path); } catch { return path; }
}

/** Resolve filesystem segments, not against the browser's HTTP origin. */
export function resolvePathRef(base: string, ref: string): string {
  if (ref.startsWith('/') || ref.startsWith('~')) return ref;
  const parts: string[] = [];
  for (const part of `${base}/${ref}`.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return '/' + parts.join('/');
}

export function handlePathLinkClick(event: MouseEvent, open: (path: string) => void): boolean {
  if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1)) return false;
  const anchor = (event.target as Element | null)?.closest?.('a[href]');
  const path = pathRef(anchor?.getAttribute('href'));
  if (!path) return false;
  event.preventDefault();
  event.stopPropagation();
  open(path);
  return true;
}

/** iframe events stay in their document; use the same path policy there. */
export function installPathLinkHandler(root: Document | HTMLElement | null, open: (path: string) => void): () => void {
  if (!root) return () => {};
  const activate = (event: Event) => { handlePathLinkClick(event as MouseEvent, open); };
  root.addEventListener('click', activate, true);
  root.addEventListener('auxclick', activate, true);
  return () => {
    root.removeEventListener('click', activate, true);
    root.removeEventListener('auxclick', activate, true);
  };
}

/** One piece of a line of plain text: words, or a path with the `href` a path link carries. */
export interface LinkPart { text: string; href?: string }

/** Split a line of PLAIN text (a tool call's argument, board #475) into words and path links.
 * It is the message body's recogniser and the message body's href, not a second one: the paths
 * are `findPaths` (core/path-grammar.ts, the case table's grammar) and the href is what
 * `markedSafeUrl`'s `pathRef` token writes (`encodeHref(raw, 'path')`), so a click lands in
 * `handlePathLinkClick` and the room's one router exactly like a path in a message. Shape, not
 * existence: the preview says when the file is missing. The parts always join back to `text`. */
export function pathLinkParts(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let at = 0;
  for (const hit of findPaths(text)) {
    const href = encodeHref(hit.raw, 'path');
    if (href === null) continue;
    if (hit.start > at) parts.push({ text: text.slice(at, hit.start) });
    parts.push({ text: hit.raw, href });
    at = hit.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
