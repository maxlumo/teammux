// The Sessions page's search over one pane (board #91): case-insensitive,
// against its command, its window's name AND that window's agent label (a
// renamed agent is found by the name a person knows it by; names.ts is the
// one reading), its path and its agent tag.
import type { Names } from '../hub/names.ts';

export interface SearchPane { window_name?: string; current_command?: string; current_path?: string }

export function paneMatches(p: SearchPane, q: string, names: Names, tag = ''): boolean {
  if (!q) return true;
  const ql = q.toLowerCase();
  const has = (v: string | undefined) => (v || '').toLowerCase().includes(ql);
  return has(p.current_command) || has(p.window_name) || has(p.window_name ? names.shown(p.window_name) : '') || has(p.current_path) || has(tag);
}
