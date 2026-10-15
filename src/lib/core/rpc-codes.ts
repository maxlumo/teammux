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
 * rejected. The reconnect loop stops on this code and on nothing else: the
 * server answered, and asking again for three minutes would only repeat the
 * answer (and feed the server's per-address lockout). Every other way a login
 * can fail — a socket closed during auth, a timeout, a frame we did not expect
 * — is not a refusal. */
export const ERR_AUTH = -32000;

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
