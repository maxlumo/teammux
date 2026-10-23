// The attempts a server REFUSED the token for (board #458, validator V1;
// review on the token state). One fact per member id: the (address, token)
// pairs an attempt actually sent and the server at that address answered
// "no" to. An auth refusal proves only that the peer at THAT address refused
// THAT token: a misrouted or alternate address saying no does not block the
// correct address with the same token (orchestrator's ruling on de5645f7).
//
// - In memory the pairs are kept as sent, for this page.
// - On this device they are kept as SHA-256 digests of the pair (Web Crypto,
//   the digest connection.ts already relies on), an equality fingerprint and
//   nothing more: it is not a protection of the token, which the registry
//   stores anyway.
// - Two states are not "no refusal", and they are not the same:
//   'pending' — a stored digest exists and this pair's digest is still being
//   computed: nothing dials it, a pick included; it is answered when ready.
//   'unknown' — a stored fact that cannot be COMPARED (no Web Crypto, or a
//   digest call that rejects): nothing dials it, a pick included (fail
//   closed; there is no person-forced attempt in #458). It holds for the
//   token the server had when it was first asked about; Edit connection with
//   another token is the repair. Only a server the stored fact names is.
// - A stored value that cannot be READ (junk, a digest of the wrong shape) is
//   a corruption, not a refusal (validator V4 on f20d1ea0; ruling): it is
//   reset ONCE — moved aside under the first free key of REFUSED_ASIDE_KEY,
//   REFUSED_ASIDE_KEY.2, … (`asideKey`: never deleted, never overwritten by
//   a later corruption), the store emptied, and only then the reset
//   reported (`reset`; an emptying that fails goes to `failed` instead) — and every member dials as
//   on a fresh device. A refusal re-records on its first answer: after a
//   reset the exposure is one auth failure per refused pair, the same as a
//   first load on a fresh device. If the value cannot be moved aside it is
//   left in place, the page starts empty all the same, nothing is written
//   over it, and the failure goes to the storage error handling.
// - A write that fails is reported to the caller's storage error handling.
// - Without Web Crypto (an insecure page context) the fact cannot be digested:
//   it is kept for this page only, and a stored one is unknown.

import type { ServerId } from './refs.ts';

export const REFUSED_KEY = 'tmux_refused_tokens';
/** Where an unreadable REFUSED_KEY value is kept, for diagnosis. */
export const REFUSED_ASIDE_KEY = 'tmux_refused_tokens_unreadable';
/** The first key an unreadable value can be kept under without replacing
 * one kept before: REFUSED_ASIDE_KEY, then REFUSED_ASIDE_KEY.2, .3, … */
export function asideKey(storage: { getItem(key: string): string | null }): string {
  if (storage.getItem(REFUSED_ASIDE_KEY) == null) return REFUSED_ASIDE_KEY;
  let n = 2;
  while (storage.getItem(`${REFUSED_ASIDE_KEY}.${n}`) != null) n++;
  return `${REFUSED_ASIDE_KEY}.${n}`;
}
/** Pairs kept per server: a refusal per address it has; more is old history. */
const MAX_PER_SERVER = 8;

/** May this (address, token) be sent? See the header for each state. */
export type Eligibility = 'ok' | 'refused' | 'pending' | 'unknown';

/** The ONE reading of a member's candidate set — every address of its
 * machine, each with the token it would send (#458 validator V3; ruling on
 * f20d1ea0): one pair's state is never the member's while another pair is
 * still 'ok' or 'pending'. 'ok' when some pair is ok; else 'pending' while
 * some is still compared; else 'refused' only when every pair is; else
 * 'unknown'. The member set's join and the reconnect loop both read it. */
export function candidateVerdict(states: readonly Eligibility[]): Eligibility {
  if (states.includes('ok')) return 'ok';
  if (states.includes('pending')) return 'pending';
  return states.length > 0 && states.every((s) => s === 'refused') ? 'refused' : 'unknown';
}

export interface RefusedAttempts {
  check(id: ServerId, address: string, token: string): Eligibility;
  /** The attempt was refused: remember it, here and on the device. */
  add(id: ServerId, address: string, token: string): void;
}

export interface RefusedDeps {
  read(): string | null;
  write(text: string | null): void;
  /** Keep an unreadable value under `asideKey`; throws when it
   * cannot. Absent: it cannot, so the value is left in place. */
  aside?: (text: string) => void;
  /** The stored value was unreadable and has been reset (moved aside). */
  reset?: () => void;
  /** SHA-256 of a string, hex; absent in an insecure context. */
  digest?: (text: string) => Promise<string>;
  /** A write could not land (the caller's storage error handling). */
  failed(): void;
  /** A digest the stored fact needed has just been computed, or could not
   * be: ask again. */
  ready(): void;
}

const pair = (address: string, token: string) => `${address}\u0000${token}`;

export function createRefusedAttempts(deps: RefusedDeps): RefusedAttempts {
  const mem = new Map<ServerId, Set<string>>();
  let stored: Record<ServerId, string[]> = {};
  /** The unreadable value could not be moved aside: never written over. */
  let pinned = false;
  let text: string | null = null;
  try {
    text = deps.read();
    if (text != null) {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
      for (const [id, list] of Object.entries(v as Record<string, unknown>)) {
        if (!Array.isArray(list) || !list.every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/u.test(d))) throw new Error('not a list of SHA-256 digests');
        stored[id] = list as string[];
      }
    }
  } catch {
    stored = {};
    // Reset once, after the caller has finished setting up (its callbacks
    // may name what it declares later): the value moved aside, then the
    // store emptied. A read that threw has nothing to move.
    const junk = text;
    if (junk == null) { pinned = true; queueMicrotask(() => deps.failed()); } else {
      pinned = true;                          // until it is safely aside
      queueMicrotask(() => {
        try { if (!deps.aside) throw new Error('nowhere to keep it'); deps.aside(junk); } catch { deps.failed(); return; }
        pinned = false;
        // Said reset only once it is: an emptying that failed is a storage
        // failure, and the old value is still where it was.
        try { deps.write(null); } catch { deps.failed(); return; }
        deps.reset?.();
      });
    }
  }
  /** In the unknown state, the token each server was first asked about:
   * that one is held; another (an edit) is a new declaration. */
  const unknownToken = new Map<ServerId, string>();
  const unknownFor = (id: ServerId, token: string): Eligibility => {
    if (!unknownToken.has(id)) unknownToken.set(id, token);
    return unknownToken.get(id) === token ? 'unknown' : 'ok';
  };
  /** Digests computed so far, by pair; `''` while one is being computed. */
  const digests = new Map<string, string>();
  /** Pairs whose digest call rejected: never comparable, so unknown. */
  const uncomputable = new Set<string>();
  const digestNow = (p: string): string | undefined => {
    const d = digests.get(p);
    if (d) return d;
    if (d === '' || !deps.digest) return undefined;
    const digest = deps.digest;
    digests.set(p, '');
    void digest(p).then((hex) => { digests.set(p, hex); deps.ready(); }, () => { digests.delete(p); uncomputable.add(p); deps.ready(); });
    return undefined;
  };
  function persist(id: ServerId, p: string) {
    if (!deps.digest) return; // this page only
    void deps.digest(p).then((hex) => {
      digests.set(p, hex);
      const list = [...new Set([...(stored[id] ?? []), hex])].slice(-MAX_PER_SERVER);
      stored = { ...stored, [id]: list };
      if (pinned) return;                     // this page only: the unreadable value is not written over
      try { deps.write(JSON.stringify(stored)); } catch { deps.failed(); }
    }, () => deps.failed());
  }
  return {
    check(id, address, token) {
      const p = pair(address, token);
      if (mem.get(id)?.has(p)) return 'refused';
      const list = stored[id];
      if (!list) return 'ok';
      if (!deps.digest || uncomputable.has(p)) return unknownFor(id, token);
      const d = digestNow(p);
      if (d === undefined) return 'pending';
      return list.includes(d) ? 'refused' : 'ok';
    },
    add(id, address, token) {
      const p = pair(address, token);
      let set = mem.get(id);
      if (!set) { set = new Set(); mem.set(id, set); }
      set.add(p);
      persist(id, p);
    },
  };
}

/** The in-memory store a member set uses when nothing else is given (tests). */
export function memoryRefusedAttempts(): RefusedAttempts {
  return createRefusedAttempts({ read: () => null, write: () => {}, failed: () => {}, ready: () => {} });
}
