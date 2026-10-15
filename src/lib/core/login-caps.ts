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

/** Why a write that needs a server capability did not go (board #377). Both
 * carry a stable `code` so a page can say it in its own words. */
export type CapErrorCode = 'server_too_old' | 'login_pending';

export class CapError extends Error {
  readonly code: CapErrorCode;
  constructor(code: CapErrorCode, message: string) {
    super(message);
    this.name = 'CapError';
    this.code = code;
  }
}

/** The ONE gate for a write that only an up-to-date server can do, bound to
 * the CURRENT authenticated socket at the moment of writing (board #377
 * review, P1-B): an unanswered login is a wait, never a yes; a login that
 * answered without `cap` is a refusal, before anything is sent. The caller
 * sends in the same tick it returns, so no reconnect can slip between the
 * answer it checked and the socket it writes to. */
export async function requireCap(
  connection: { getCaps(): string[] | undefined; whenCaps(timeoutMs?: number): Promise<string[]> },
  cap: string,
  waitMs = 5000,
): Promise<void> {
  if (connection.getCaps() === undefined) {
    try { await connection.whenCaps(waitMs); } catch {
      throw new CapError('login_pending', 'The server has not answered its login yet. Try again in a moment.');
    }
  }
  const caps = connection.getCaps();
  if (caps === undefined) throw new CapError('login_pending', 'The server has not answered its login yet. Try again in a moment.');
  if (!caps.includes(cap)) throw new CapError('server_too_old', 'This server is older than the app. Update the server to assign.');
}
