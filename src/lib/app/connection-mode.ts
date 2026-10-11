// How many servers this device connects to at once (board #335 ③).
//
// Two device settings, both the PERSON's rather than a server's, so they live
// on unprefixed keys that `server-store.ts` passes through:
//
//   tmux_connection_mode    'single' (today, the default) or 'aggregate'
//   tmux_excluded_servers   the saved entries Aggregate leaves out
//
// Storage is untrusted input: a value this build does not know, a key that
// cannot be read, JSON of the wrong shape — each reads as the default (Single,
// nothing excluded) rather than as an error, and nothing is repaired on read.
//
// The excluded set means something only against the saved registry, so it is
// always READ through it: an id that is no longer saved — forgotten, or an
// alias the identity layer absorbed into its machine's survivor — drops out at
// once, with no second write to forget. It is not handed to the survivor
// (orchestrator, D5): whether the survivor is included is its own mark. Every
// write stores the set already pruned, so stale ids do not accumulate.
//
// Not to be confused with `server-mode.ts`, which is about THIS computer's
// own server (#323).
import type { ServerId } from './refs.ts';

type Reader = Pick<Storage, 'getItem'>;
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export const MODE_KEY = 'tmux_connection_mode';
export const EXCLUDED_KEY = 'tmux_excluded_servers';

export type ConnectionMode = 'single' | 'aggregate';

const read = (storage: Reader, key: string): string | null => {
  try { return storage.getItem(key); } catch { return null; }
};

/** The device's mode: 'aggregate' only when that is exactly what is stored. */
export function readMode(storage: Reader): ConnectionMode {
  return read(storage, MODE_KEY) === 'aggregate' ? 'aggregate' : 'single';
}

export function writeMode(storage: Store, mode: ConnectionMode): void {
  storage.setItem(MODE_KEY, mode === 'aggregate' ? 'aggregate' : 'single');
}

/** The excluded ids that are still saved servers, in no particular order. */
export function readExcluded(storage: Reader, saved: readonly { id: ServerId }[]): Set<ServerId> {
  return storedExcluded(storage, saved) ?? new Set();
}

/** The stored set, or null when storage could not be READ — which is not
 * "nothing excluded": a write built on it would erase every exclusion
 * (reviewer D5 on the ③ plan). Junk that was read is empty, not an error. */
function storedExcluded(storage: Reader, saved: readonly { id: ServerId }[]): Set<ServerId> | null {
  const known = new Set(saved.map((s) => s.id));
  let text: string | null;
  try { text = storage.getItem(EXCLUDED_KEY); } catch { return null; }
  let raw: unknown;
  try { raw = JSON.parse(text ?? '[]'); } catch { raw = []; }
  const out = new Set<ServerId>();
  if (Array.isArray(raw)) for (const id of raw) if (typeof id === 'string' && known.has(id)) out.add(id);
  return out;
}

/** Exclude or include one saved server. Returns the set as stored; THROWS,
 * writing nothing, when the current set cannot be read, so the caller can
 * say so instead of silently including every server again. */
export function setExcluded(storage: Store, saved: readonly { id: ServerId }[], id: ServerId, excluded: boolean): Set<ServerId> {
  const next = storedExcluded(storage, saved);
  if (!next) throw new Error('the excluded servers could not be read');
  if (excluded && saved.some((s) => s.id === id)) next.add(id);
  else next.delete(id);
  storage.setItem(EXCLUDED_KEY, JSON.stringify([...next]));
  return next;
}

/** The saved entries Aggregate connects to, in saved order — which is also
 * the stable tie-break of every union (r1 §E). A new entry is included,
 * because nothing has excluded it; a rename changes nothing, because the set
 * holds ids. */
export function includedServers<E extends { id: ServerId }>(saved: readonly E[], excluded: ReadonlySet<ServerId>): E[] {
  return saved.filter((s) => !excluded.has(s.id));
}
