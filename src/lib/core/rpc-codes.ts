/**
 * Wire error codes a CLIENT acts on (board #337).
 *
 * Their own module, not `ws.ts`, for a reason a test caught: `ws.ts` is the
 * connection surface, and every mount fixture MOCKS it — a constant living
 * there reads as `undefined` inside a test, so a feature keyed on it looks
 * disabled while the code says otherwise. Codes are protocol facts, not
 * connection-bound calls, so they sit outside the mocked module. `ws.ts`
 * re-exports this one, so the public surface is unchanged.
 *
 * The server's table is `docs/requirements/api-contracts/websocket-rpc.md`
 * and its constants are `src-tauri/src/server/rpc.rs`; `ws.test.ts` fails if
 * the three disagree.
 */

/** The server REFUSED the credentials (board #393). In reply to the login
 * message it is the server's explicit "no": `invalid proof` on the encrypted
 * path, `invalid token` on the plain one — and on the encrypted path it arrives
 * as a PLAIN frame, because the server has no session key for a proof it just
 * rejected. The reconnect loop stops on the two credential answers among
 * this code's messages (`authKindOf` below, board #502) and on nothing else:
 * the server answered, and asking again for three minutes would only repeat the
 * answer (and feed the server's per-address lockout). Every other way a login
 * can fail — a socket closed during auth, a timeout, a frame we did not expect
 * — is not a refusal. */
export const ERR_AUTH = -32000;

/** What an ERR_AUTH in reply to the LOGIN says (board #502). The code alone
 * is not a refusal: the server sends the same -32000 for a frame that came
 * before the login (`auth required…`, a client race) and for a malformed
 * handshake (`invalid client_nonce`). Only the two credential answers refuse
 * the credentials and are remembered; the class is read ONCE, where the
 * login's error enters the client (core/connection.ts), and travels on the
 * error as `authKind` next to the unchanged wire code. The message is the
 * server's one sentence (`src-tauri/src/server/connection.rs`), matched
 * here and nowhere else; it is never shown.
 * - `token`: `invalid token` (the plain path) — the server refused the token.
 * - `proof`: `invalid proof` (the encrypted path) — the handshake proof
 *   derived from the token was rejected.
 * - `protocol`: `auth required…` or `invalid client_nonce` — not about the
 *   credentials; retried like a dropped dial.
 * - `unknown`: any other ERR_AUTH — not remembered, retried within the
 *   loop's budget, never passively re-armed. */
export type AuthKind = 'token' | 'proof' | 'protocol' | 'unknown';

export function authKindOf(message: unknown): AuthKind {
  const m = typeof message === 'string' ? message : '';
  if (m === 'invalid token') return 'token';
  if (m === 'invalid proof') return 'proof';
  if (m === 'invalid client_nonce' || m.startsWith('auth required')) return 'protocol';
  return 'unknown';
}

/** The login error's own text (#502 review P2-D): one of the server's known
 * sentences, shortened, or a fixed fallback — never the server's arbitrary
 * text, which is not shown or logged anywhere. The words a person reads come
 * from i18n by `authKind` (app/dial-order.ts `loginErrorKey`). */
export function loginMessage(kind: AuthKind, message: unknown): string {
  if (kind === 'token') return 'invalid token';
  if (kind === 'proof') return 'invalid proof';
  if (kind === 'protocol') return message === 'invalid client_nonce' ? 'invalid client_nonce' : 'auth required';
  return 'login refused (reason not recognised)';
}

/** `scratch_session` refused because a PROJECT holds the scratch terminal's
 * reserved session name. The refusal carries `{projectId, projectName,
 * session}` as its error data, and the panel offers "Release the name" on
 * this code — never on the message, which is the server's one sentence for
 * the human and may be translated. */
export const ERR_SCRATCH_HELD = -32010;

/** `scratch_release` refused because the project the reader confirmed is not
 * the one holding the name any more — nothing was renamed. The panel RECOVERS
 * from this instead of showing it: the snapshot it was about is gone, so it
 * drops it and asks `scratch_session` once, which is the one path that says
 * who holds the name now. The error carries no holder for that reason — a
 * copy here could be stale again by the time it was used. */
export const ERR_SCRATCH_STALE = -32011;
