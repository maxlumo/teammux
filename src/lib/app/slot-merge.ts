// One resident slot of an absorbed server merged into its survivor's (board
// #335 ③b; orchestrator 15:02/15:04 and reviewer 15:03 on the absorb move).
//
// Identity repair folds an entry into the entry of the same machine. Until
// ③b only the CURRENT twin's slots were moved, as a whole copy, and every
// other twin's were deleted — harmless while only CURRENT was ever dialled,
// a data loss once Aggregate dials background members: an alias's drafts,
// read marks and alerts vanished, and a whole copy deleted every key of the
// survivor that the alias did not have. So the move is a MERGE, slot by
// slot, by these rules:
//
//   - a missing source never deletes: the survivor's value stays;
//   - a source landing on a missing (or empty) survivor value is taken;
//   - keys whose value is a collection merge losslessly — drafts by room,
//     read marks by the newer seq, alerts by key (an alert naming the
//     absorbed server names the survivor: the identity moved);
//   - anything else that differs is a REAL conflict, resolved by one rule:
//     the side that `wins` keeps it — the CURRENT twin's (the fold's rule:
//     the state the person was just using is authoritative), else the
//     survivor's — and the losing value is RETURNED, so the caller records
//     it (`recordLost`) instead of overwriting it silently.
//
// The same function serves a held write the gate flushes under the survivor
// (server-store.ts), so a slot and a pending write of it move by one rule.
// Framework-free: the identity layer and the store both import it.

const ALERTS_KEY = 'tmux_hub_alerts';
const DRAFTS_KEY = 'tmux_hub_drafts';
const SEEN_KEY = 'tmux_hub_seen';
/** Where a losing value is kept (device-wide, not a server's slot). */
export const LOST_KEY = 'tmux_slot_conflicts';
const LOST_CAP = 40;

/** A value's fingerprint: FNV-1a over its UTF-16 units, with its length.
 * Synchronous, because the fold runs before the first render. It decides
 * only "is this still the value that was there", never who owns anything
 * (server-state-migration.ts; here because a slot move hands baselines over). */
export function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${value.length}`;
}

export interface Merged {
  /** What the survivor's slot holds after the merge (null: no value). */
  value: string | null;
  /** The losing side's value of a real conflict, or null. */
  lost: string | null;
}

const empty = (v: string | null | undefined): v is null | undefined => v == null || v === '' || v === '{}' || v === '[]';
const parse = (v: string): unknown => { try { return JSON.parse(v); } catch { return undefined; } };
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every alert that named `from` names `to`. Anything else as it came. */
export function rebindAlertList(value: string, from: string, to: string): string {
  const list = parse(value);
  if (!Array.isArray(list)) return value;
  return JSON.stringify(list.map((a) => (isMap(a) && a.server === from ? { ...a, server: to } : a)));
}

/** Merge `source` (server `from`'s value of `key`) into `target` (server
 * `to`'s). `wins` says whose value a real conflict keeps. */
export function mergeSlot(key: string, target: string | null, source: string | null, from: string, to: string, wins: 'source' | 'target'): Merged {
  if (key === ALERTS_KEY && source != null) source = rebindAlertList(source, from, to);
  if (empty(source)) return { value: target, lost: null };
  if (empty(target) || target === source) return { value: source, lost: null };
  const s = parse(source);
  const t = parse(target);
  if (key === DRAFTS_KEY && isMap(s) && isMap(t)) {
    const out: Record<string, unknown> = { ...t };
    const lost: Record<string, unknown> = {};
    for (const [room, text] of Object.entries(s)) {
      const mine = out[room];
      if (mine == null || mine === '') { out[room] = text; continue; }
      if (text == null || text === '' || text === mine) continue;
      if (wins === 'source') { lost[room] = mine; out[room] = text; } else lost[room] = text;
    }
    return { value: JSON.stringify(out), lost: Object.keys(lost).length ? JSON.stringify(lost) : null };
  }
  if (key === SEEN_KEY && isMap(s) && isMap(t)) {
    const seq = (m: unknown) => (typeof m === 'number' ? m : isMap(m) && typeof m.seq === 'number' ? m.seq : -Infinity);
    const out: Record<string, unknown> = { ...t };
    for (const [room, mark] of Object.entries(s)) if (seq(mark) > seq(out[room])) out[room] = mark;
    return { value: JSON.stringify(out), lost: null };
  }
  if (key === ALERTS_KEY && Array.isArray(s) && Array.isArray(t)) {
    const keyOf = (a: unknown) => (isMap(a) && typeof a.key === 'string' ? a.key : null);
    const have = new Set(t.map(keyOf).filter(Boolean));
    const ts = (a: unknown) => (isMap(a) && typeof a.ts === 'number' ? a.ts : 0);
    const out = [...t, ...s.filter((a) => { const k = keyOf(a); return k != null && !have.has(k); })];
    // Newest first, as the log records them; the log's own cap applies on read.
    out.sort((a, b) => ts(b) - ts(a));
    return { value: JSON.stringify(out), lost: null };
  }
  return wins === 'source' ? { value: source, lost: target } : { value: target, lost: source };
}

/** Keep a losing value where a person (or a later tool) can find it: the
 * newest `LOST_CAP`, one row per (from, to, key, value). */
export function recordLost(storage: Pick<Storage, 'getItem' | 'setItem'>, row: { from: string; to: string; key: string; value: string }): void {
  let rows: unknown = [];
  try { rows = JSON.parse(storage.getItem(LOST_KEY) || '[]'); } catch { rows = []; }
  const list = (Array.isArray(rows) ? rows : []).filter((r) => !(isMap(r) && r.from === row.from && r.to === row.to && r.key === row.key && r.value === row.value));
  list.push(row);
  storage.setItem(LOST_KEY, JSON.stringify(list.slice(-LOST_CAP)));
}
