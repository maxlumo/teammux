// The app's ACTIVATION generations (board #335 ②b-4; reviewer and
// orchestrator, 2026-10-11 01:46; per member since ③a, reviewer P1-A on the
// ③ plan).
//
// Every attempt to bring a server up claims a generation, and the latest
// claim is the only one that may conclude anything: a late result from one
// that was superseded records no identity, brings nothing up and concludes
// nothing.
//
// Two kinds of attempt, and they must not supersede each other:
//
//   - the WINDOW's: a focus change, the connect form's candidate, a switch,
//     an address change, a leave walk holding the socket. They are about the
//     server in front of the person, and there is one of those.
//   - a MEMBER's own: its join and its reconnect attempts. Each held server
//     has its own (`member(key)`), so one server hanging, reconnecting or
//     being excluded never makes another's attempt stale — one server
//     failing does not touch the rest (r1 §③).
//
// Where they meet: a window attempt that acts ON a member (`claim(key)`)
// also ends that member's attempts in flight — the form taking over A's
// socket ends A's reconnect, which is ②b's rule — and nobody else's. Ending a
// member (`member(key).endAll()`, on exclude or removal) ends only its own.
// `endAll()` with no key ends everything: the root teardown and the global
// storage block. Same-id runtimes are different keys (a handle, not an id),
// so a new handle's attempts never inherit an old one's.
//
// Until ②b-4 this was app/handover.ts, which also stood the bound runtime
// down for the length of an attempt. Each runtime owns its connection now and
// an attempt dials its own, so the suspension went; the generation stayed.
export interface Activation {
  /** Is the app still waiting on THIS attempt? */
  current(): boolean;
}

export interface MemberActivations {
  /** Claim this member's generation for one of its own attempts. */
  claim(): Activation;
  /** End this member's attempts in flight; no other member's. */
  endAll(): void;
}

export interface Activations {
  /** Claim the WINDOW's generation; acting on member `key`, end its own
   * attempts in flight too. */
  claim(key?: object | null): Activation;
  /** One member's generation, made on first ask. */
  member(key: object): MemberActivations;
  /** Nothing in flight is the app's any more: every generation ends. */
  endAll(): void;
}

export function createActivations(): Activations {
  /** Bumped by `endAll()`: it ends every claim, the window's and each member's. */
  let epoch = 0;
  let latest = 0;
  const members = new WeakMap<object, MemberActivations>();
  const member = (key: object): MemberActivations => {
    let held = members.get(key);
    if (!held) {
      let own = 0;
      held = {
        claim() {
          const mine = ++own;
          const at = epoch;
          return { current: () => mine === own && at === epoch };
        },
        endAll() { own++; },
      };
      members.set(key, held);
    }
    return held;
  };
  return {
    claim(key) {
      if (key) member(key).endAll();
      const mine = ++latest;
      return { current: () => mine === latest };
    },
    member,
    endAll() { latest++; epoch++; },
  };
}
