// The servers Aggregate holds besides the focused one (board #335 ③b-1).
//
// The focused server comes up the way it always has — App's `activate`,
// which writes CURRENT and swaps the window onto it. Every OTHER included
// server is a BACKGROUND member: it joins on its own, never writes CURRENT,
// never takes the screen, and failing never touches another member (r1 §③A,
// reviewer P1-A on the ③ plan). A join is the bring-up's steps in the
// bring-up's order, each addressed to THIS member by id and owned by THIS
// member's activation generation:
//
//   1. the storage gate for its id (`gate`);
//   2. its runtime's own dial, owned by its own generation and asked at every
//      step whether the app still wants it (`wanted`);
//   3. the gate again, now that the dial taught the entry its machine — a
//      pending input belongs to the machine that proves it;
//   4. only then published (`onUp`): its state, its view, its tree.
//
// One retry policy, not two: a member nobody answered for keeps its runtime
// and App runs that runtime's own reconnect loop (`retry`), whose answer
// comes back through `answered` and the same steps 3–4. A member that a newer
// attempt, an exclusion or the mode going back to Single made stale
// concludes nothing: its runtime is let go of (`release`) and no status is
// written. A storage block stops a join where it stands and publishes
// nothing; Retry calls `sync` again, and `resume` redials every published
// member the block left without a connection (reviewer P1 on 453f02b8). A
// published member's reconnect passes step 3 too: a refused gate closes its
// socket and keeps it for Retry. A dial whose identity record THROWS is the
// host gate's (`unrecorded`), never an unhandled rejection.
//
// Each member's status is DERIVED from these edges: `connecting` while its
// first dial is out, `connected` once published and answering,
// `reconnecting` while its loop runs, `failed` with the reason. `excluded`
// is not a status here — an excluded server is not a member.
import type { ServerId } from './refs.ts';
import type { ServerEntry } from './servers.ts';
import type { ServerRuntime, DialResult } from './server-runtime.ts';
import type { Activations } from './activation.ts';

export type MemberStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting' }
  /** `unreachable`: no answer yet; `elsewhere`: another known machine
   * answered (`detail` names it); `storage`: the app is blocked on it. */
  | { kind: 'failed'; reason: 'unreachable' | 'elsewhere' | 'storage'; detail?: string };

export interface MemberDeps {
  /** The fleet's idle runtime for this entry, or undefined when it is no
   * longer saved. */
  include(entry: ServerEntry): ServerRuntime | undefined;
  /** The storage gate for server `id`. */
  gate(id: ServerId): 'ok' | 'claimed' | 'blocked';
  activations: Activations;
  /** Does the app still want this member — Aggregate, included, not the
   * focused server? Asked at every step. */
  wanted(id: ServerId): boolean;
  /** Publish a member that passed every gate. */
  onUp(runtime: ServerRuntime): void;
  /** A published member answered its reconnect (caps, resubscribe). */
  onBack?(runtime: ServerRuntime): void;
  /** Let go of a runtime: its loop stops, its state is released. */
  release(runtime: ServerRuntime): void;
  /** Start this runtime's own reconnect loop. */
  retry(runtime: ServerRuntime): void;
  /** Is this id still a saved entry? */
  saved(id: ServerId): boolean;
  /** A dial's identity record failed (the dial closed that socket): the
   * host gate classifies it. Answers whether the app is now blocked. */
  unrecorded(runtime: ServerRuntime): boolean;
  /** Close a published member's socket the gate refused; keep its runtime. */
  hold(runtime: ServerRuntime): void;
}

export interface Members {
  /** Make the member set exactly `entries`: join new ones, retry what a
   * block stopped, let go of the rest. Idempotent. */
  sync(entries: readonly ServerEntry[]): void;
  /** The published runtimes, in the order of the last `sync`. */
  runtimes(): ServerRuntime[];
  status(id: ServerId): MemberStatus | null;
  /** Does this member hold `runtime` (published or still trying)? */
  holds(runtime: ServerRuntime): boolean;
  /** Reports from a member's own reconnect loop. */
  reconnecting(runtime: ServerRuntime): void;
  answered(runtime: ServerRuntime, result: DialResult): void;
  gaveUp(runtime: ServerRuntime): void;
  /** A member's socket closed while the app is blocked: no loop now. */
  blocked(runtime: ServerRuntime): void;
  /** Retry: redial every published member that is not answering. */
  resume(): void;
  /** Stop one member: its attempts end, it is let go of, its status goes. */
  leave(id: ServerId): void;
  leaveAll(): void;
}

type Held = { runtime: ServerRuntime; published: boolean };

export function createMembers(deps: MemberDeps): Members {
  const held = new Map<ServerId, Held>();
  const statuses = $state<Record<ServerId, MemberStatus>>({});
  let order: ServerId[] = [];

  const set = (id: ServerId, status: MemberStatus | null) => {
    if (status) statuses[id] = status; else delete statuses[id];
  };
  const mine = (runtime: ServerRuntime) => held.get(runtime.id)?.runtime === runtime;

  async function join(entry: ServerEntry) {
    const id = entry.id;
    if (deps.gate(id) === 'blocked') { set(id, { kind: 'failed', reason: 'storage' }); return; }
    const runtime = deps.include(entry);
    if (!runtime) { set(id, null); return; }
    held.set(id, { runtime, published: false });
    set(id, { kind: 'connecting' });
    const owner = deps.activations.member(runtime).claim();
    let result: DialResult;
    try {
      result = await runtime.dial(() => owner.current() && mine(runtime) && deps.wanted(id));
    } catch {
      // The identity record threw. Still ours: the host gate decides — a
      // block keeps nothing of an unpublished member (Retry joins again); an
      // ordinary failure is one more unanswered dial.
      if (!owner.current() || !mine(runtime)) return;
      if (deps.unrecorded(runtime)) { forget(id); set(id, { kind: 'failed', reason: 'storage' }); return; }
      set(id, { kind: 'failed', reason: 'unreachable' });
      deps.retry(runtime);
      return;
    }
    if (!owner.current()) { if (mine(runtime) && !held.get(id)!.published) forget(id); return; }
    answered(runtime, result);
  }

  /** Steps 3–4 for a member still trying; the outcome for a published one. */
  function answered(runtime: ServerRuntime, result: DialResult) {
    const id = runtime.id;
    const h = held.get(id);
    if (!h || h.runtime !== runtime) return;
    if (!deps.wanted(id)) { leave(id); return; }
    if (result.ok) {
      // Step 3, for a join and a reconnect alike: the dial may have taught
      // the entry its machine, and a pending input is that machine's.
      if (deps.gate(id) === 'blocked') {
        if (!h.published) forget(id); else deps.hold(runtime);
        set(id, { kind: 'failed', reason: 'storage' });
        return;
      }
      if (!h.published) {
        h.published = true;
        deps.onUp(runtime);
      } else {
        deps.onBack?.(runtime);
      }
      set(id, { kind: 'connected' });
      return;
    }
    if (result.reason === 'elsewhere') {
      forget(id);
      // An alias absorbed into its machine's canonical entry is gone, and the
      // canonical is a member of its own (D2): no row left for it. Two known
      // entries where this one reached the other's machine: failed.
      if (deps.saved(id)) set(id, { kind: 'failed', reason: 'elsewhere', detail: result.entry.name || result.entry.address });
      return;
    }
    if (result.reason === 'gone') { forget(id); return; }
    if (result.reason === 'superseded') return;
    // No answer: the member keeps its runtime and its own loop retries it.
    set(id, { kind: 'failed', reason: 'unreachable' });
    deps.retry(runtime);
  }

  /** Let go of the member's runtime and its status. */
  function forget(id: ServerId) {
    const h = held.get(id);
    held.delete(id);
    if (h) deps.release(h.runtime);
    set(id, null);
  }

  function leave(id: ServerId) {
    const h = held.get(id);
    if (h) deps.activations.member(h.runtime).endAll();
    forget(id);
  }

  const known = () => [...new Set([...held.keys(), ...Object.keys(statuses)])];

  return {
    sync(entries) {
      order = entries.map((e) => e.id);
      const want = new Set(order);
      for (const id of known()) if (!want.has(id)) leave(id);
      for (const entry of entries) {
        const h = held.get(entry.id);
        if (h && h.runtime.alive()) continue;
        if (h) forget(entry.id);
        const st = statuses[entry.id];
        // `elsewhere` waits for the person (it names another known server);
        // everything else, a storage stop included, joins again.
        if (st?.kind === 'failed' && st.reason === 'elsewhere') continue;
        void join(entry);
      }
    },
    runtimes: () => order.map((id) => held.get(id)).filter((h): h is Held => !!h?.published).map((h) => h.runtime),
    status: (id) => statuses[id] ?? null,
    holds: (runtime) => mine(runtime),
    reconnecting(runtime) { if (mine(runtime)) set(runtime.id, { kind: 'reconnecting' }); },
    answered,
    gaveUp(runtime) { if (mine(runtime)) set(runtime.id, { kind: 'failed', reason: 'unreachable' }); },
    blocked(runtime) { if (mine(runtime)) set(runtime.id, { kind: 'failed', reason: 'storage' }); },
    resume() {
      for (const [id, h] of held) {
        if (!h.published || statuses[id]?.kind === 'connected') continue;
        set(id, { kind: 'reconnecting' });
        deps.retry(h.runtime);
      }
    },
    leave,
    leaveAll() { for (const id of known()) leave(id); },
  };
}
