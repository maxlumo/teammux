// How a server's addresses are walked when ONE dial must find a way in
// (board #353). Framework-free: the reconnect machine and the server switch
// both ask these, so "which address first", "how long may one take", "what
// does a dead one look like" and the round that walks them (board #495) have
// one definition.
//
// The probe (ws.ts) only proves the WebSocket handshake. An address that
// answers it and then never authenticates (a captive LAN, a half-open
// middlebox) is exactly the one that must not decide for the whole server:
// the next address is tried when the dial itself fails, not only when the
// probe does.

import { ERR_AUTH, type AuthKind } from '../core/rpc-codes.ts';

/** A dial that got nowhere because the address cannot be reached: a timeout,
 * a refusal, a socket that closed during auth. An AUTH refusal is not one:
 * the server answered, and another address of it would answer the same. */
export function isReachabilityFailure(e: unknown): boolean {
  const message = typeof e === 'string' ? e : String((e as { message?: unknown } | null)?.message ?? '');
  return /timeout|connection failed|closed during auth/i.test(message);
}

/** The server ANSWERED and refused the credentials: the login failed with its
 * ERR_AUTH and an answer about the credentials — `invalid proof` on the
 * encrypted path, `invalid token` on the plain one. core/connection.ts keeps
 * the code on the error and classifies the answer once, as `authKind`
 * (rpc-codes.ts `authKindOf`, board #502). Not a drop and not a reachability
 * failure: the reconnect loop stops at once instead of retrying the same
 * answer for its whole window, and instead of feeding the server's lockout
 * (board #393). By the code AND the class, never the code alone: the same
 * code answers a frame sent before the login (`auth required`, a client race,
 * #502) and a malformed handshake, and neither is a bad token; a timeout and a
 * socket closed during auth are not either. */
export function isAuthRefusal(e: unknown): boolean {
  const err = e as { code?: unknown; authKind?: unknown } | null;
  return err?.code === ERR_AUTH && (err.authKind === 'token' || err.authKind === 'proof');
}

/** A login the server answered with an ERR_AUTH that is not about the
 * credentials (board #502; review P1-A): `'protocol'` for its known protocol
 * answers (`auth required…`, `invalid client_nonce`), `'login'` for one this
 * client does not recognise; null for everything else. Neither is a refusal
 * (nothing is remembered) nor a dead address: the loop retries it within its
 * budget, a give-up says which it was, and nothing passive starts it again. */
export function loginFailure(e: unknown): 'protocol' | 'login' | null {
  const err = e as { code?: unknown; authKind?: unknown } | null;
  if (err?.code !== ERR_AUTH) return null;
  return err.authKind === 'protocol' ? 'protocol' : err.authKind === 'unknown' ? 'login' : null;
}

/** The ONE translation of a login error into words a person reads (an i18n
 * key), by its class and never by the server's text (#502 review P2-D): the
 * member row, the connect card and the switch panel all say it this way.
 * null: not a login error (the caller's own words apply). */
export function loginErrorKey(e: unknown): string | null {
  const err = e as { code?: unknown; authKind?: unknown } | null;
  if (err?.code !== ERR_AUTH) return null;
  const kind = err.authKind;
  return kind === 'token' || kind === 'proof' || kind === 'protocol' || kind === 'unknown' ? loginKey(kind) : null;
}

/** The i18n key for one login-error class: the table `loginErrorKey` and a
 * member's row (`failureKey`) both read. */
export function loginKey(kind: AuthKind): string {
  switch (kind) {
    case 'token': return 'memberTokenRefused';
    case 'proof': return 'memberProofRefused';
    case 'protocol': return 'memberLoginProtocol';
    default: return 'memberLoginUnknown';
  }
}

/** How long ONE dial of an address of class 0 (LAN), 1 (Tailscale) or 2
 * (internet) may take before it is given up: LAN should fail fast, a far
 * region legitimately needs a handshake's worth. */
export function dialTimeoutMs(addressClass: number): number {
  return addressClass === 0 ? 2000 : addressClass === 1 ? 3000 : 5000;
}

/** The order to try a server's addresses in: the caller's order (the one it
 * was asked for first, then the failover order), without repeats, with the
 * ones that just failed LAST — still tried when nothing else is left, because
 * a person's explicit pick must be able to dial an address the memory
 * distrusts. */
export function dialOrder(addresses: readonly string[], viable: (address: string) => boolean): string[] {
  const unique = [...new Set(addresses.filter(Boolean))];
  return [...unique.filter(viable), ...unique.filter((a) => !viable(a))];
}

/** One (address, token) a dial sends. Two dials are the same attempt only
 * when both are the same: a changed token at the same address is another. */
export type DialPair = { address: string; token: string };
export const pairKey = (pair: DialPair) => `${pair.address}\u0000${pair.token}`;

/** What the caller's `pick` answers: the next pair to dial now, or why not.
 * `exhausted`: every pair the caller would send has been tried this round;
 * `wait`: nothing can be decided yet; `end`: nothing will be sent. */
export type RoundPick =
  | { kind: 'dial'; pair: DialPair }
  | { kind: 'exhausted' }
  | { kind: 'wait' }
  | { kind: 'end'; reason: 'auth' | 'unknown' | 'gone' | 'spent' };

/** How a round ended. `ok` carries the dial's OWN answer, untouched (a
 * runtime's identity and storage outcomes are its host's to read).
 * `abandoned`: the caller stopped owning the attempt; nothing was concluded. */
export type RoundResult<A> =
  | { kind: 'ok'; pair: DialPair; answer: A }
  | { kind: 'exhausted'; error: unknown }
  | { kind: 'stopped'; pair: DialPair; error: unknown }
  | { kind: 'wait' }
  | { kind: 'end'; reason: 'auth' | 'unknown' | 'gone' | 'spent' }
  | { kind: 'abandoned' };

export interface RoundDeps<A> {
  /** The caller's wait before a dial (a walk asking the person). The LAST
   * await before the pick: what is picked after it is what is sent. */
  before?: () => Promise<unknown>;
  /** The next pair, read NOW from the caller's current declaration, given
   * the pairs this round already sent. Synchronous: the pair it returns is
   * dialled in the same turn. */
  pick: (tried: ReadonlySet<string>) => RoundPick;
  dial: (pair: DialPair, timeoutMs: number | undefined) => Promise<A>;
  /** Does the caller still own this attempt? Asked before every pick and
   * FIRST after every dial returns. */
  live: () => boolean;
  /** A dial was rejected: go on to the next pair, or stop the round. Given
   * the pair that dial SENT. */
  failed: (pair: DialPair, error: unknown) => 'next' | 'stop';
  timeoutOf?: (address: string) => number | undefined;
  /** A reachability failure (only those) of `address`: the cooldown memory. */
  unreachable?: (address: string) => void;
  /** A dial is about to go out (synchronous: a counter, a label). */
  onDial?: (pair: DialPair) => void;
}

/**
 * ONE round over a server's addresses (board #495): one dial at a time, in
 * the order `pick` gives, until one answers, the caller stops it, or nothing
 * is left. Framework-free and dependency-injected; it owns no timer and no
 * policy. The switch and the reconnect machine both walk through it, each
 * with its own `pick` (what may be sent) and `failed` (what a refusal means).
 */
export async function runRound<A>(r: RoundDeps<A>): Promise<RoundResult<A>> {
  const tried = new Set<string>();
  let lastError: unknown;
  for (;;) {
    if (r.before) {
      try { await r.before(); } catch { /* the wait ended either way */ }
    }
    if (!r.live()) return { kind: 'abandoned' };
    const next = r.pick(tried);
    if (next.kind === 'exhausted') return { kind: 'exhausted', error: lastError };
    if (next.kind !== 'dial') return next;
    const { pair } = next;
    tried.add(pairKey(pair));
    r.onDial?.(pair);
    let answer: A;
    try {
      answer = await r.dial(pair, r.timeoutOf?.(pair.address));
    } catch (error) {
      if (!r.live()) return { kind: 'abandoned' };
      lastError = error;
      if (isReachabilityFailure(error)) r.unreachable?.(pair.address);
      if (r.failed(pair, error) === 'stop') return { kind: 'stopped', pair, error };
      continue;
    }
    if (!r.live()) return { kind: 'abandoned' };
    return { kind: 'ok', pair, answer };
  }
}
