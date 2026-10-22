/**
 * What a server announces it can do in its login answer's `caps` list (board
 * #377). A client that needs one checks it BEFORE it writes: an older server
 * announces no `caps` at all, and the answer to "can it?" is then a definite
 * no, not an unknown one.
 */

/** `hub_board_save` with `dispatch: true` hands the issue to its assignee. */
export const BOARD_DISPATCH = 'board_dispatch';
/** `hub_spawn` with `join` puts the new agent in a running team (board #382).
 * An older server ignores `join` and spawns the agent standalone, which reads
 * as a success; so a join is refused unless the server says it can. */
export const SPAWN_JOIN = 'spawn_join';
/** `hub_agent_set_team` exists (board #384): a running agent can be moved
 * into a team, or out, at runtime. An older server has no such verb, so the
 * Hub offers no move (drag targets and menu items disabled, with why). */
export const AGENT_TEAM = 'agent_team';

/** `hub_search` with `files: true` lists the files the messages mention (board #432). An older
 * server refuses an empty `grep` before it looks at `files` and answers a worded one with
 * messages, so the Files mode asks for this BEFORE it sends, not after reading an answer. */
export const HUB_FILES = 'hub_files';

/** The definition reads mask every MCP env/header value as `"<set>"`, and their saves keep the
 * stored value for it (board #451). An older server answers `mcp_list`, `registry_list` and
 * `teams_list` WITH the values (into a textarea) and would store the marker as a literal, so
 * none of those six calls is sent without this. */
export const MCP_MASKED = 'mcp_masked';

/** What an older server lacking a capability means for the person, per cap. */
const TOO_OLD: Record<string, string> = {
  [BOARD_DISPATCH]: 'This server is older than the app. Update the server to assign.',
  [SPAWN_JOIN]: 'This server is older than the app. Update the server to start an agent inside a team.',
  [AGENT_TEAM]: 'This server is older than the app. Update the server to move an agent between teams.',
  [HUB_FILES]: 'This server is older than the app. Update the server to list files.',
  [MCP_MASKED]: 'This server is older than the app and shows MCP secrets. Update the server to see or edit agent, team and MCP definitions.',
};

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

/** Wait for the CURRENT socket's login to answer, if it has not (board #377).
 * Resolves at once when it has. A login that never answers is not waited on
 * forever: after `waitMs` it is `login_pending`. This is the only `await` of
 * the gate; the CHECK (`requireCap`) is a separate, synchronous step so the
 * write that follows it reads the same socket the check did. */
export async function holdForLogin(
  connection: { getCaps(): string[] | undefined; whenCaps(timeoutMs?: number): Promise<string[]> },
  waitMs = 5000,
): Promise<void> {
  if (connection.getCaps() !== undefined) return;
  try { await connection.whenCaps(waitMs); } catch {
    throw new CapError('login_pending', 'The server has not answered its login yet. Try again in a moment.');
  }
}

/** The ONE check for a write that only an up-to-date server can do, bound to
 * the CURRENT authenticated socket (board #377 review, P1-B): an unanswered
 * login is never a yes, and a login that answered without `cap` is a refusal,
 * before anything is sent. SYNCHRONOUS on purpose: the caller sends in the
 * same block that this returns in, so no reconnect can slip between the
 * answer it checked and the socket it writes to. */
export function requireCap(connection: { getCaps(): string[] | undefined }, cap: string): void {
  const caps = connection.getCaps();
  if (caps === undefined) throw new CapError('login_pending', 'The server has not answered its login yet. Try again in a moment.');
  if (!caps.includes(cap)) throw new CapError('server_too_old', TOO_OLD[cap] ?? 'This server is older than the app. Update the server.');
}
