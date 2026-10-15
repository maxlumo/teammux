/**
 * What a server announces it can do in its login answer's `caps` list (board
 * #377). A client that needs one checks it BEFORE it writes: an older server
 * announces no `caps` at all, and the answer to "can it?" is then a definite
 * no, not an unknown one.
 */

/** `hub_board_save` with `dispatch: true` hands the issue to its assignee. */
export const BOARD_DISPATCH = 'board_dispatch';

/** A login answer's `caps`: the plain, non-empty strings in it, or `[]` for an
 * older server that sends none (or anything that is not a list). */
export function parseCaps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === 'string' && c !== '');
}

/** True only when the server is KNOWN to lack `cap`: `caps` is undefined while
 * there is no authenticated socket, and an unanswered question is not a no. */
export function lacksCap(caps: string[] | undefined, cap: string): boolean {
  return Array.isArray(caps) && !caps.includes(cap);
}
