// A poll answer that changes nothing assigns nothing (board #444).
//
// Every 5 s `hub_agents` answered the same roster, and `agents = got` handed
// Svelte a new array anyway. Everything that reads the roster ran again: the
// feed's `feedBlocks` over the whole loaded history (it resolves senders through
// `agents`), the Feed's sticky-ask layout pass, the roster and the composer's
// completion lists. On a stalling link those answers land in bursts, and the
// person typing waits behind them (#444 rig). `adopt` is the one check at the
// store boundary: the CURRENT value is kept when the answer has the same content,
// so a Svelte `$state` assignment of it is a no-op (same reference, nothing
// notified).
//
// Content is JSON content: plain objects, arrays and primitives, compared
// deeply; an object's keys in any order; `undefined` members are absent, as
// JSON reads them. An element that is the same reference is equal without being
// walked, so a merged list that only re-sorted the objects it already held costs
// one pass.

export function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const arrA = Array.isArray(a), arrB = Array.isArray(b);
  if (arrA !== arrB) return false;
  if (arrA) {
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!sameContent(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const kx = keys(x), ky = keys(y);
  if (kx.length !== ky.length) return false;
  for (const k of kx) if (!Object.hasOwn(y, k) || !sameContent(x[k], y[k])) return false;
  return true;
}

/** `prev` when `next` has the same content, else `next`. */
export function adopt<T>(prev: T, next: T): T {
  return sameContent(prev, next) ? prev : next;
}
