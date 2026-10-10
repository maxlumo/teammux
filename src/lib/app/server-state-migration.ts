// Moving the per-server keys from "live plus parked" to "one slot per server"
// (board #335 ②a-3, reviewer r1 §C).
//
// Until board #335 ②b-4 a per-server key had TWO homes: the unprefixed one,
// which held whichever server was current, and `<key>::<id>`, where the
// switch filed the server you were leaving (park) and from which it surfaced
// the one you arrived at (point). That works for one server at a time and
// cannot work for two: with A and B both on screen there is no "the" live
// value, and the first write from B would overwrite A's.
//
// So the `::<id>` slot becomes the ONLY home, and the unprefixed key stops
// being a location. This function is the one-time fold that gets there, and
// three of its rules were each a bug first.
//
// COMPLETION IS RECORDED, IN ONE WRITE. The first version compared values,
// which is only idempotent while nothing else writes the slot — the moment the
// slot is the live home, a second run overwrites a NEWER resident value with
// the stale unprefixed one. The second version recorded completion in two
// markers, and two writes always leave a window: the per-server one lands, the
// global one fails, and then the server it folded into skips while the NEXT
// server folds the same leftover inputs into its own slot (reviewer P1-a,
// second round). So there is ONE marker and ONE write, carrying both facts —
// which layout, and which server received the inputs.
//
// THE LIVE SET IS AUTHORITATIVE IN FULL, not just its present keys. An absent
// live key means the value was CLEARED, and for the current server that is a
// definite conclusion rather than a guess: arriving at a server surfaced its
// park as the live key, so from that moment live and slot agreed, and any
// later divergence was a live-side change. Copying only the present keys made
// a cleared draft or a reset read-mark come back from the old park the moment
// the slot became the live home. So the fold files the WHOLE set — the old
// switch's park, kept here as the one place that still reads the live keys
// (`fileLive`).
//
// AN OWNER MUST BE KNOWN, AND THEN IT IS RECORDED (reviewer P1-c on the ②
// plan; P1-b/c on cf7e7957). The inputs belong to the server the last
// session left current. When CURRENT names a saved entry, that is the owner,
// and the fold runs at once. When it does not — empty, or an id nobody saved
// — the inputs are PENDING: nothing is filed anywhere, the navigation's bytes
// are copied aside (`quarantineLegacyNav`), and the marker records `pending`
// with the machine the legacy mirror named. That record is the attribution
// state, persisted, so a reload never re-infers it from whatever CURRENT
// says by then: a server a connect made current in the meantime is NOT the
// owner. Only a server whose machine IS that machine claims the inputs
// (`claimPending`), whenever it shows up; any other runs on its own empty
// slots and the inputs stay pending. There is no terminal "consumed,
// nobody's" state: only a fold ends pending.
//
// A CLAIM FOLDS BY THE FOLD'S RULE, except where the owner has written since
// (reviewer P1-1 on 08fdb6ba). A non-empty slot is not evidence of a newer
// value: it may be the owner's pre-#335 park, older than the live inputs by
// construction. So the pending record keeps a FINGERPRINT of every slot that
// existed when the inputs were set aside, and at the claim a slot that still
// matches its fingerprint (or never existed and still does not) takes the
// live value, or is cleared — the fold's rule — while a slot that changed,
// appeared or disappeared since was written by the owner on this build, and
// is kept. An identity merge that MOVES a slot first records the move on the
// pending record (servers.ts `moveSlots`), and a slot of the destination
// that matches the baseline of a server moved into it is not an edit either:
// a relocation, even one that failed part-way, is not a write by the owner. The record also
// fingerprints the INPUTS themselves (P2-a): only a
// build from before #335 writes them, and if one has since, the evidence
// they carry (the legacy mirror's machine) is read again before anybody
// claims them.
//
// With no inputs at all there is nothing to attribute: the marker records a
// fold into CURRENT once one exists.
//
// EVERY WRITE CAN FAIL, and a failure is `unrecorded`: the caller treats it
// as boot migration not complete (no server page, nothing that moves CURRENT,
// Retry). A thrown error is the same.
//
// What it does NOT do: clear the unprefixed keys. Nothing writes them any
// more, and a client rolled back to a build from before #335 finds exactly
// the state it left.
//
// App runs it at boot, before the deep link and before any page mounts, and
// again before it builds any server's state (`swapScope`) — which is where a
// fresh client folds for its first server and a pending input meets the
// server that can claim it.
import { LAYOUT_KEY, RESIDENT_KEYS, currentServerId, loadServers, residentKey } from './servers.ts';
import { quarantineLegacyNav } from './nav-saved.ts';
import type { ServerId } from './refs.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** A value's fingerprint: FNV-1a over its UTF-16 units, with its length.
 * Synchronous, because the fold runs before the first render. It decides
 * only "is this still the value that was there", never who owns anything. */
export function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${value.length}`;
}

/** The pre-#335 inputs, fingerprinted as one: an absent key counts. */
function inputsPrint(storage: Pick<Storage, 'getItem'>): string {
  return fingerprint(JSON.stringify(RESIDENT_KEYS.map((key) => storage.getItem(key))));
}

/** Every slot of every saved server that exists now, fingerprinted: what a
 * later claim compares against to tell an old park from a newer write. */
function slotPrints(storage: Store): Record<string, string> {
  const prints: Record<string, string> = {};
  for (const server of loadServers(storage)) {
    for (const key of RESIDENT_KEYS) {
      const value = storage.getItem(residentKey(key, server.id));
      if (value != null) prints[residentKey(key, server.id)] = fingerprint(value);
    }
  }
  return prints;
}

/** The servers whose slots may now sit in `id`'s: `id` itself, and every
 * server the pending record says was moved into it — transitively. */
function sourcesOf(id: ServerId, moved: readonly { from: string; to: string }[]): ServerId[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const m of moved) if (m.to === out[i] && !out.includes(m.from)) out.push(m.from);
  return out;
}

/** What a claim compares a slot against: the baselines of the slots that
 * existed when the inputs were set aside, and the moves recorded since. */
interface Since { slots: Record<string, string>; moved: { from: string; to: string }[] }

/** File every legacy live key under `id`'s slot; an absent live key clears
 * the slot (see the header). With `since` — a claim — a slot that matches no
 * baseline it could carry (its own, or one moved into it), present or absent,
 * was written by its owner after the inputs were set aside, and is kept. */
function fileLive(storage: Store, id: ServerId, since?: Since): { folded: string[]; cleared: string[] } {
  const folded: string[] = [];
  const cleared: string[] = [];
  const sources = since ? sourcesOf(id, since.moved) : [];
  for (const key of RESIDENT_KEYS) {
    const live = storage.getItem(key);
    const slot = storage.getItem(residentKey(key, id));
    if (since) {
      const baselines = sources.map((src) => since.slots[residentKey(key, src)]);
      const untouched = slot == null ? baselines.includes(undefined) : baselines.includes(fingerprint(slot));
      if (!untouched) continue;
    }
    if (live != null) { folded.push(key); storage.setItem(residentKey(key, id), live); }
    else if (slot != null) { cleared.push(key); storage.removeItem(residentKey(key, id)); }
  }
  return { folded, cleared };
}

/** Are there pre-#335 inputs to attribute? */
function hasInputs(storage: Store): boolean {
  return RESIDENT_KEYS.some((key) => storage.getItem(key) != null);
}

/** The completion marker. Unprefixed and single: its subject is the INPUTS,
 * which there is only one set of, and a second marker would mean a second
 * write and a window between them. Spelled in servers.ts, whose identity
 * merges move a pending record's slot baselines with the slots. */
export { LAYOUT_KEY };
/** The layout this fold produces. A version rather than a boolean so a later
 * layout change can tell "folded by #335" from "folded by whatever comes
 * next" instead of seeing an opaque true. */
export const LAYOUT_VERSION = '335';

/** What the marker records — the attribution state of the inputs:
 * `folded` into a server (the layout and which server received them, in one
 * write), or `pending` an owner that proves it is the legacy mirror's
 * machine. */
export type LayoutMark =
  | { v: string; state: 'folded'; into: ServerId }
  | {
    v: string; state: 'pending'; machineId: string;
    /** The inputs' fingerprint when that machine was read. */
    inputs?: string;
    /** Every slot that existed then, fingerprinted (see `fileLive`). */
    slots?: Record<string, string>;
    /** Identity merges that moved one server's slots into another's since
     * (servers.ts `moveSlots`). */
    moved?: { from: string; to: string }[];
  };

/** The marker, or null when nothing has been decided. Anything unparseable
 * still counts as consumed: the one thing worse than not knowing which fold
 * ran is reading the inputs a second time. A marker without a state is the
 * first #335 shape, `{v, into}`; one with an empty `into` read as pending. */
export function layoutMark(storage: Pick<Storage, 'getItem'>): LayoutMark | null {
  const raw = storage.getItem(LAYOUT_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const v = String(parsed.v ?? '');
      if (parsed.state === 'pending' || (parsed.state === undefined && !parsed.into)) {
        return {
          v, state: 'pending', machineId: String(parsed.machineId ?? storage.getItem('tmux_machine_id') ?? ''),
          ...(typeof parsed.inputs === 'string' ? { inputs: parsed.inputs } : {}),
          ...(parsed.slots && typeof parsed.slots === 'object' ? { slots: parsed.slots } : {}),
          ...(Array.isArray(parsed.moved) ? { moved: parsed.moved.filter((m: any) => m && typeof m.from === 'string' && typeof m.to === 'string') } : {}),
        };
      }
      return { v, state: 'folded', into: String(parsed.into ?? '') };
    }
  } catch { /* an older or hand-edited marker still means "consumed" */ }
  return { v: String(raw), state: 'folded', into: '' };
}

export interface MigrationReport {
  /** Did the fold move anything? */
  ran: boolean;
  /**
   * `folded`: it ran and is recorded.
   * `unrecorded`: a write failed (the fold's, the marker's, the quarantine
   *   copy's) — storage is failing, and nothing records what happened to the
   *   inputs. BOOT MIGRATION NOT COMPLETE (reviewer, 2026-10-09): no page that
   *   writes resident state, nothing that moves CURRENT, and retry. A
   *   writable page plus an unconsumed input set is the half-migrated client
   *   this whole design exists to avoid.
   * `pending`: the inputs have no proven owner yet; recorded, nothing moved.
   * `no-current`: no inputs and no server to mark them done for; no writes.
   * `already-done`: folded by an earlier run, and reading them again would
   *   overwrite newer resident values.
   */
  reason: 'folded' | 'unrecorded' | 'pending' | 'no-current' | 'already-done';
  /** The server the live values were filed under — or, for `already-done`,
   * the one an earlier run filed them under. */
  serverId: ServerId;
  /** Keys whose live value was copied into the slot. */
  folded: string[];
  /** Keys whose slot was REMOVED because the live value was gone: the user
   * cleared that draft, drawer or read-mark, and the old park must not come
   * back as this server's state. */
  cleared: string[];
}

/**
 * Decide the inputs' attribution, once: fold them into a CURRENT that names a
 * saved server, or record them pending a proof. A pending or folded marker
 * is final for this call.
 */
export function migrateServerState(storage: Store): MigrationReport {
  const none = (reason: MigrationReport['reason'], serverId = ''): MigrationReport =>
    ({ ran: false, reason, serverId, folded: [], cleared: [] });

  const done = layoutMark(storage);
  if (done?.state === 'folded') return none('already-done', done.into);
  if (done?.state === 'pending') return none('pending');

  const id = currentServerId(storage);
  const known = !!id && loadServers(storage).some((s) => s.id === id);
  if (!known) {
    if (!hasInputs(storage)) return none('no-current');
    // A CURRENT that names no saved server must not guess a slot, and the
    // next server to connect is not evidence either: set aside, recorded.
    try {
      quarantineLegacyNav(storage);
      storage.setItem(LAYOUT_KEY, JSON.stringify({
        v: LAYOUT_VERSION, state: 'pending', machineId: storage.getItem('tmux_machine_id') || '',
        inputs: inputsPrint(storage), slots: slotPrints(storage),
      } satisfies LayoutMark));
    } catch { return none('unrecorded'); }
    return none('pending');
  }
  return foldInto(storage, id);
}

/**
 * A pending input meets server `id`: fold it in only if `id`'s machine is the
 * one the legacy mirror named, by the fold's rule — keeping only what `id`
 * wrote since. Anything else changes nothing — `pending` again — however
 * often it is asked.
 */
export function claimPending(storage: Store, id: ServerId): MigrationReport {
  const none = (reason: MigrationReport['reason'], serverId = ''): MigrationReport =>
    ({ ran: false, reason, serverId, folded: [], cleared: [] });
  const done = layoutMark(storage);
  if (done?.state !== 'pending') return done ? none('already-done', done.into) : none('no-current');
  let evidence = done;
  const now = inputsPrint(storage);
  if (evidence.inputs !== undefined && evidence.inputs !== now) {
    // The inputs changed since they were set aside — only a build from
    // before #335 writes them — so the machine they belong to is read again
    // from the mirror that build keeps, before anybody claims them.
    evidence = { ...evidence, machineId: storage.getItem('tmux_machine_id') || '', inputs: now };
    try { storage.setItem(LAYOUT_KEY, JSON.stringify(evidence)); } catch { return none('unrecorded', id); }
  }
  const own = loadServers(storage).find((s) => s.id === id)?.machineId || '';
  if (!own || !evidence.machineId || own !== evidence.machineId) return none('pending');
  return foldInto(storage, id, { slots: evidence.slots ?? {}, moved: evidence.moved ?? [] });
}

function foldInto(storage: Store, id: ServerId, since?: Since): MigrationReport {
  let moved: { folded: string[]; cleared: string[] };
  try { moved = fileLive(storage, id, since); } catch { return { ran: true, reason: 'unrecorded', serverId: id, folded: [], cleared: [] }; }
  // Marked AFTER the move, so a failure part-way leaves the inputs readable
  // and the next run redoes the whole fold rather than half of it. Two
  // writes cannot be made atomic in `localStorage`; what is possible is one
  // write, and saying so when even that fails.
  try {
    storage.setItem(LAYOUT_KEY, JSON.stringify({ v: LAYOUT_VERSION, state: 'folded', into: id } satisfies LayoutMark));
  } catch { return { ran: true, reason: 'unrecorded', serverId: id, ...moved }; }
  return { ran: true, reason: 'folded', serverId: id, ...moved };
}
