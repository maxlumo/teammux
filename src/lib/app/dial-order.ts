// How a server's addresses are walked when ONE dial must find a way in
// (board #353). Pure and framework-free: the reconnect machine and the
// server switch both ask these three, so "which address first", "how long may
// one take" and "what does a dead one look like" have one definition.
//
// The probe (ws.ts) only proves the WebSocket handshake. An address that
// answers it and then never authenticates (a captive LAN, a half-open
// middlebox) is exactly the one that must not decide for the whole server:
// the next address is tried when the dial itself fails, not only when the
// probe does.

import { ERR_AUTH } from '../core/rpc-codes.ts';

/** A dial that got nowhere because the address cannot be reached: a timeout,
 * a refusal, a socket that closed during auth. An AUTH refusal is not one:
 * the server answered, and another address of it would answer the same. */
export function isReachabilityFailure(e: unknown): boolean {
  const message = typeof e === 'string' ? e : String((e as { message?: unknown } | null)?.message ?? '');
  return /timeout|connection failed|closed during auth/i.test(message);
}

/** The server ANSWERED and refused the credentials: the login failed with its
 * ERR_AUTH (`invalid proof` on the encrypted path, `invalid token` on the plain
 * one — core/connection.ts keeps the code on the error). Not a drop and not a
 * reachability failure: the reconnect loop stops at once instead of retrying the
 * same answer for its whole window, and instead of feeding the server's lockout
 * (board #393). By the CODE, never by the message: a protocol surprise such as
 * "expected binary auth response", a timeout and a socket closed during auth are
 * not a bad token. */
export function isAuthRefusal(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === ERR_AUTH;
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
