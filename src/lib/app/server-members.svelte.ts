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
import { isAuthRefusal } from './dial-order.ts';
import { candidateVerdict, memoryRefusedAttempts, type Eligibility, type RefusedAttempts } from './refused-attempts.ts';
import type { ServerId } from './refs.ts';
import type { ServerEntry } from './servers.ts';
import type { ServerRuntime, DialResult } from './server-runtime.ts';
import type { Activation, Activations } from './activation.ts';

export type MemberStatus =
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'reconnecting' }
  /** `unreachable`: no answer yet; `elsewhere`: another known machine
   * answered (`detail` names it); `storage`: the app is blocked on it. */
  | { kind: 'failed'; reason: 'unreachable' | 'auth' | 'unknown' | 'elsewhere' | 'storage'; detail?: string }
  /** A published member whose IDENTITY is gone — its entry absorbed into
   * another, or its own reconnect reached another known machine — while its
   * tree, drafts and all, is still mounted: detached at once (its api
   * refuses, its socket is closed), kept until the person is asked
   * (reviewer P1-5 on 3a0b4feb; orchestrator 03:40). `into` names where. */
  | { kind: 'orphan'; into: string };

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
  /** Is this runtime's own reconnect loop running now? */
  trying(runtime: ServerRuntime): boolean;
  /** The attempts a server refused the token for (#458; refused-attempts.ts):
   * kept per member id, on the device as digests. Absent: memory only. */
  refusals?: RefusedAttempts;
  /** Where and with which token this member's next dial goes (its route). */
  target?: (id: ServerId) => { address: string; token: string; alternates?: string[] } | null;
  /** Is this id still a saved entry? */
  saved(id: ServerId): boolean;
  /** A dial's identity record failed (the dial closed that socket): the
   * host gate classifies it. Answers whether the app is now blocked. */
  unrecorded(runtime: ServerRuntime): boolean;
  /** Close a published member's socket the gate refused; keep its runtime. */
  hold(runtime: ServerRuntime): void;
  /** A published member lost its identity: stop it serving NOW (detach the
   * runtime, close its socket) and keep its tree for the person to be asked
   * (`orphaned`). The host asks and then `dismiss`es. */
  detach(runtime: ServerRuntime): void;
  orphaned?(runtime: ServerRuntime, into: string): void;
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
  /** `'auth'`: the server refused the credentials (#458 validator V1);
   * `'unknown'`: every address is held, its refusal state unknowable. */
  gaveUp(runtime: ServerRuntime, reason?: 'auth' | 'unknown'): void;
  /** A dial of this member's own loop came back refused for the address and
   * token it sent (`tried`, from the dial's own result): that attempt is not
   * sent again by any path; another address or token is another attempt. */
  refusedBy(runtime: ServerRuntime, tried: { address: string; token: string } | undefined): void;
  /** A member's socket closed while the app is blocked: no loop now. */
  blocked(runtime: ServerRuntime): void;
  /** Retry: redial every published member that is not answering. */
  resume(): void;
  /** The person picked this member (#458). The ONE explicit retry door: a
   * member whose own loop has stopped (it gave up, or a refusal ended it)
   * gets one fresh loop; one already trying — its first join in flight, or
   * its loop running — gets nothing new (no second dial, the watchdog
   * untouched). A refusal the app does not dial past (storage, another known
   * machine, an orphan, not held) is not bypassed. Nothing passive calls it. */
  ask(id: ServerId): 'connected' | 'trying' | 'started' | 'token' | 'held' | 'refused';
  /** The focus moved ONTO this published member (#335 D2): it leaves the
   * set without being let go of — the window owns it now. False when the
   * set does not hold it published. */
  handOver(runtime: ServerRuntime): boolean;
  /** The focus moved OFF this runtime, which stays up (`up`: answering now):
   * the set holds it as a published member from here, without dialling it
   * again. */
  adopt(runtime: ServerRuntime, up: boolean): void;
  /** Stop one member: its attempts end, it is let go of, its status goes. */
  leave(id: ServerId): void;
  /** Is `runtime` an orphan — detached, tree kept, awaiting the person? */
  orphan(runtime: ServerRuntime): boolean;
  /** The identity layer declared this published member's entry gone — at
   * ITS synchronous boundary (the fleet's drop on absorption; reviewer R1 on
   * aed2f654): detach now, keep the tree. False when the set does not hold
   * it published (nothing to keep; the caller ends it). */
  absorbed(runtime: ServerRuntime): boolean;
  /** The person answered about an orphan: let it go. */
  dismiss(runtime: ServerRuntime): void;
  leaveAll(): void;
}

/** `join`: the owner of the join in flight for an unpublished member. A
 * join a block (or any `endAll`) made stale is no longer anybody's, and a
 * sync starts it again — it is never skipped because the handle is alive
 * (orchestrator 16:12; reviewer P1 on 97824925). */
type Held = { runtime: ServerRuntime; published: boolean; join?: Activation; orphan?: boolean };

export function createMembers(deps: MemberDeps): Members {
  const held = new Map<ServerId, Held>();
  const statuses = $state<Record<ServerId, MemberStatus>>({});
  let order: ServerId[] = [];

  const set = (id: ServerId, status: MemberStatus | null) => {
    if (status) statuses[id] = status; else delete statuses[id];
  };
  const mine = (runtime: ServerRuntime) => held.get(runtime.id)?.runtime === runtime;
  /** The ONE dial-eligibility fact (#458 validator V1; review on the token
   * state): did this member's server refuse the (address, token) its next
   * dial would send? Kept outside the member's slot and status — a re-join,
   * a block, a reconnect report change none of it — and asked by every dial
   * entry: join (every sync's), resume and the pick's ask. A pair not
   * decided ('pending', 'unknown') is not dialled, a pick included. A
   * changed address or token is another attempt. */
  const refused = deps.refusals ?? memoryRefusedAttempts();
  /** The last entry each member was synced with: a member whose join a
   * refusal stopped has no slot, and is still a member (it can be chosen). */
  const lastEntry = new Map<ServerId, ServerEntry>();
  /** The member's dial eligibility comes from its CANDIDATE SET — every
   * address of its machine, each with the token it would send (validator
   * V3 on 36b2d37e): one refused pair takes out that pair, never the
   * member. 'ok' when some pair is decided ok (the first such is where a
   * join dials); 'pending' while none is ok and some is still compared;
   * 'unknown' when none is ok or pending but some is unknowable; 'refused'
   * only when every pair is. */
  function candidates(entry: ServerEntry): { can: Eligibility; via?: string; token: string } {
    const t = deps.target?.(entry.id) ?? { address: entry.address, token: entry.token };
    const all = [t.address, ...(t.alternates ?? [])];
    const states = all.map((a) => refused.check(entry.id, a, t.token));
    const ok = states.indexOf('ok');
    const can = candidateVerdict(states);
    return can === 'ok' && ok > 0 ? { can, via: all[ok], token: t.token } : { can, token: t.token };
  }
  const eligible = (entry: ServerEntry): Eligibility => candidates(entry).can;
  /** One pair refused: recorded, and the member's state is its SET's — a
   * member another 'ok' or 'pending' pair is left for is still trying (its
   * loop goes on or waits), never "token refused" (ruling on f20d1ea0).
   * Returns that verdict. */
  function markRefused(runtime: ServerRuntime, tried: { address: string; token: string } | undefined, published: boolean): Eligibility {
    const id = runtime.id;
    if (tried) refused.add(id, tried.address, tried.token);
    const can = eligible(runtime.entry());
    if (can === 'refused' || can === 'unknown') set(id, { kind: 'failed', reason: can === 'refused' ? 'auth' : 'unknown' });
    else set(id, { kind: published ? 'reconnecting' : 'connecting' });
    return can;
  }

  async function join(entry: ServerEntry) {
    const id = entry.id;
    // An attempt its server refused is not sent again by any join — a sync's
    // (a rename elsewhere, a focus move, a reload) included. One not decided
    // yet (its digest is being computed) waits, and the digest syncs again;
    // one that can never be decided is held until its connection is edited.
    const { can, via, token } = candidates(entry);
    if (can === 'pending') { set(id, { kind: 'connecting' }); return; }
    if (can !== 'ok') { set(id, { kind: 'failed', reason: can === 'refused' ? 'auth' : 'unknown' }); return; }
    if (deps.gate(id) === 'blocked') { set(id, { kind: 'failed', reason: 'storage' }); return; }
    const runtime = deps.include(entry);
    if (!runtime) { set(id, null); return; }
    const owner = deps.activations.member(runtime).claim();
    const slot: Held = { runtime, published: false, join: owner };
    held.set(id, slot);
    set(id, { kind: 'connecting' });
    let result: DialResult;
    try {
      // Its primary address refused this token: the join dials the first
      // address that is decided ok instead, never the refused pair.
      // The pair checked is the pair sent: the join dials in this turn, with
      // the token its check read (#458 ruling on 77e1185d).
      result = await runtime.dial(() => owner.current() && mine(runtime) && deps.wanted(id), via ? { via, token } : { token });
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
    // A stale join (a block's endAll, a leave) concludes nothing. It lets go
    // of the member only while the member is still THIS join's — a newer
    // join Retry started on the same handle is not undone by the older one's
    // late answer (reviewer P1 on 97824925).
    if (!owner.current()) { if (held.get(id) === slot) forget(id); return; }
    slot.join = undefined;
    answered(runtime, result);
  }

  /** Steps 3–4 for a member still trying; the outcome for a published one. */
  function answered(runtime: ServerRuntime, result: DialResult) {
    const id = runtime.id;
    const h = held.get(id);
    if (!h || h.runtime !== runtime) return;
    // An orphan's identity is over: a dial of its that answers late — the
    // reconnect whose own arrival elsewhere made it one, say — concludes
    // nothing, least of all a leave that would end its kept tree unasked
    // (reviewer P1-A on e0dafe3c).
    if (h.orphan) return;
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
    if (result.reason === 'elsewhere' || result.reason === 'gone') {
      const into = result.reason === 'elsewhere' ? (result.entry.name || result.entry.address) : '';
      // A PUBLISHED member has a tree, and maybe drafts in it: its identity
      // ends now, its editors do not (P1-5) — it is an orphan until asked.
      if (h.published) { orphan(h, into); return; }
      forget(id);
      // An alias absorbed into its machine's canonical entry is gone, and the
      // canonical is a member of its own (D2): no row left for it. Two known
      // entries where this one reached the other's machine: failed.
      if (result.reason === 'elsewhere' && deps.saved(id)) set(id, { kind: 'failed', reason: 'elsewhere', detail: into });
      return;
    }
    if (result.reason === 'superseded') return;
    // The server answered and refused the token: nothing retries it.
    if (result.reason === 'failed' && isAuthRefusal(result.error)) {
      // Another address of its machine is still a candidate or still being
      // compared (#458 validator V3): its own loop, as after any failed join,
      // tries what is left or waits for it.
      const can = markRefused(runtime, result.tried, h.published);
      if (can === 'ok' || can === 'pending') deps.retry(runtime);
      return;
    }
    // No answer: the member keeps its runtime and its own loop retries it.
    set(id, { kind: 'failed', reason: 'unreachable' });
    deps.retry(runtime);
  }

  /** A published member's identity is gone: detach it, keep its tree. */
  function orphan(h: Held, into: string) {
    if (h.orphan) return;
    h.orphan = true;
    deps.activations.member(h.runtime).endAll();
    deps.detach(h.runtime);
    set(h.runtime.id, { kind: 'orphan', into });
    deps.orphaned?.(h.runtime, into);
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
      lastEntry.clear();
      for (const e of entries) lastEntry.set(e.id, e);
      const want = new Set(order);
      for (const id of known()) {
        if (want.has(id)) continue;
        const h = held.get(id);
        // Its id is no longer saved (absorbed) while its tree is up: an
        // orphan, kept for the person; a plain unwanted member leaves.
        if (h?.published && !h.orphan && !deps.saved(id)) { orphan(h, ''); continue; }
        if (h?.orphan) continue;
        leave(id);
      }
      for (const entry of entries) {
        const h = held.get(entry.id);
        // An orphan under a saved id (elsewhere, both entries kept) is not
        // re-joined over: the person decides first.
        if (h?.orphan) continue;
        // Alive and published, or alive with its own join still current: in
        // hand. A join nobody owns any more (a block ended it) is not — it
        // is joined again, on the same handle.
        if (h && h.runtime.alive() && (h.published || h.join?.current())) continue;
        // A dead handle is let go of and replaced; a live one whose join went
        // stale is kept and joins again (the fleet hands the same handle back).
        if (h && !h.runtime.alive()) forget(entry.id);
        const st = statuses[entry.id];
        // `elsewhere` waits for the person (it names another known server);
        // everything else, a storage stop included, joins again.
        if (st?.kind === 'failed' && st.reason === 'elsewhere') continue;
        void join(entry);
      }
    },
    // Orphans are published trees too — mounted, held — and come last.
    runtimes: () => [...order.map((id) => held.get(id)).filter((h): h is Held => !!h?.published && !h.orphan).map((h) => h.runtime),
      ...[...held.values()].filter((h) => h.orphan).map((h) => h.runtime)],
    status: (id) => statuses[id] ?? null,
    holds: (runtime) => mine(runtime),
    reconnecting(runtime) { if (mine(runtime) && !held.get(runtime.id)?.orphan) set(runtime.id, { kind: 'reconnecting' }); },
    orphan: (runtime) => !!held.get(runtime.id)?.orphan && mine(runtime),
    absorbed(runtime) {
      const h = held.get(runtime.id);
      if (!h || h.runtime !== runtime || !h.published) return false;
      orphan(h, '');
      return true;
    },
    dismiss(runtime) { if (mine(runtime) && held.get(runtime.id)?.orphan) forget(runtime.id); },
    answered,
    gaveUp(runtime, reason) {
      const h = held.get(runtime.id);
      if (!mine(runtime) || h?.orphan) return;
      if (reason) set(runtime.id, { kind: 'failed', reason });
      else set(runtime.id, { kind: 'failed', reason: 'unreachable' });
    },
    blocked(runtime) { if (mine(runtime)) set(runtime.id, { kind: 'failed', reason: 'storage' }); },
    refusedBy(runtime, tried) { const h = held.get(runtime.id); if (mine(runtime) && !h?.orphan) markRefused(runtime, tried, !!h?.published); },
    handOver(runtime) {
      const h = held.get(runtime.id);
      if (!h || h.runtime !== runtime || !h.published || h.orphan) return false;
      held.delete(runtime.id);
      set(runtime.id, null);
      order = order.filter((id) => id !== runtime.id);
      return true;
    },
    adopt(runtime, up) {
      held.set(runtime.id, { runtime, published: true });
      set(runtime.id, { kind: up ? 'connected' : 'reconnecting' });
      if (!order.includes(runtime.id)) order = [...order, runtime.id];
    },
    resume() {
      for (const [id, h] of held) {
        if (!h.published || h.orphan || statuses[id]?.kind === 'connected') continue;
        // A pending set's loop waits for its comparison and dials nothing.
        const can = eligible(h.runtime.entry());
        if (can !== 'ok' && can !== 'pending') continue;
        set(id, { kind: 'reconnecting' });
        deps.retry(h.runtime);
      }
    },
    ask(id) {
      const h = held.get(id);
      if (!h) {
        // A member a refusal (or an undecided one) stopped before it had a
        // slot — a reload with a stored refusal: still a member, so still
        // choosable. A refused, undecided or unknowable attempt is recorded
        // and dials nothing; an edited one joins.
        const entry = lastEntry.get(id);
        const st = statuses[id];
        const stopped = st?.kind === 'connecting' || (st?.kind === 'failed' && (st.reason === 'auth' || st.reason === 'unknown'));
        if (!entry || !deps.wanted(id) || !stopped) return 'refused';
        const can = eligible(entry);
        if (can === 'refused') return 'token';
        if (can !== 'ok') return 'held';
        void join(entry);
        return 'started';
      }
      if (h.orphan || !h.runtime.alive()) return 'refused';
      const can = eligible(h.runtime.entry());
      if (can === 'refused') return 'token';
      if (can === 'unknown') return 'held';
      const st = statuses[id];
      if (st?.kind === 'failed' && (st.reason === 'storage' || st.reason === 'elsewhere')) return 'refused';
      if (h.published && st?.kind === 'connected' && h.runtime.connection.isConnected()) return 'connected';
      // A set still being compared: its loop waits for the comparison and
      // dials nothing until it is decided ok — a stopped one is started to
      // wait, so the decision reaches it (the loop's wake), not a sync.
      if (h.join?.current() || deps.trying(h.runtime)) return can === 'pending' ? 'held' : 'trying';
      if (deps.gate(id) === 'blocked') return 'refused';
      set(id, { kind: h.published ? 'reconnecting' : 'connecting' });
      deps.retry(h.runtime);
      return can === 'pending' ? 'held' : 'started';
    },
    leave,
    leaveAll() { for (const id of known()) leave(id); },
  };
}
