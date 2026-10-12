// A server's own corner of storage (board #335 ②a-3).
//
// The per-server keys stopped having two homes — a live unprefixed one for
// whichever server was current, and `<key>::<id>` where the switch filed the
// one you left — and are resident at `<key>::<id>`. With two servers on
// screen there is no "the" live value, so a store that answers "which server
// are you asking about" is the whole mechanism.
//
// It is a `Storage` view and not a new accessor vocabulary on purpose. The
// per-project semantics — what a SeenMark is, that an empty draft removes its
// row, how `stepsRows` clamps — live in `hub-prefs.svelte.ts` and
// `notify-centre.svelte.ts` and must keep living there; a second copy here
// would be the "one mechanism per job" regression, and it would drift. ②b
// points those modules' storage at this view and leaves their logic untouched.
//
// Two rules decide what is scoped:
//
//   - a RESIDENT key is rewritten, to `servers.ts`'s `residentKey`. The list
//     is `servers.ts`'s `RESIDENT_KEYS`: one list, which the identity layer
//     also uses when it removes or merges an entry.
//   - everything else PASSES THROUGH, unchanged. The user's preferences —
//     theme, fonts, zoom, language, shortcuts, notification switches, the feed
//     level, the sidebar collapse — are properties of the PERSON and the
//     WINDOW, not of a server, and scoping them would mean the same human gets
//     a different app depending on which machine they are looking at. The
//     registry's own keys (`tmux_servers`, CURRENT, `tmux_machines`) and the
//     active mirror (`tmux_address`, `tmux_token`, `tmux_socket`) pass through
//     too, because their home is the `ServerEntry`.
//
// Passing the mirror through is not a claim that those credentials are
// scoped by server: they describe whichever server is current, for the
// connect form and the boot gate. Where to reach a server is read from its
// ENTRY, by id (`server-target.ts`).
//
// In production since board #335 ②b-4: every server's state is built over
// its own view.
import type { ServerId } from './refs.ts';
import { RESIDENT_KEYS, residentKey } from './servers.ts';
import { mergeSlot, recordLost } from './slot-merge.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const resident: readonly string[] = RESIDENT_KEYS;

/** Is this key one server's state, rather than the person's or the window's?
 * A linear scan over nine names, not a module-level Set: a cached collection
 * at file scope is the shape board #315's pin exists to catch, and an
 * exemption for a constant lookup table is one more thing a reader has to
 * verify is really constant. */
export function isResidentKey(key: string): boolean {
  return resident.includes(key);
}

export interface ServerStore extends Store {
  readonly serverId: ServerId;
  /** Where a key actually lands. Exposed so a test — and a future migration —
   * can state the layout without rebuilding the string. */
  keyFor(key: string): string;
}

/**
 * The app's ONE pending-write table (board #335 ③a; orchestrator's final
 * P1-D ruling, 08:20). While the app is blocked on its storage, a mounted
 * tree keeps working — an alert still arrives, a read mark still moves — but
 * nothing may land in a resident slot until the migration is recorded,
 * because a write there is exactly the half-migrated client the block exists
 * to prevent. So a CLOSED gate takes every resident write instead of the
 * storage, and gives it back on a read, so what the pages hold and what their
 * store answers never disagree. Retry, once the claim has run, `flush`es the
 * table in the order it was written; the gate opens only when every entry has
 * landed, and an entry that could not be written stays, with everything after
 * it, for the next Retry. Nothing waits for a "next write": a setter that
 * returns early on an unchanged value cannot strand anything.
 *
 * - One table per APP, keyed by server: every store view of one server — its
 *   state bundle's, the navigation's — sees the same pending value.
 * - A removal is an intent of its own (`null`), not "nothing pending".
 * - The person's keys pass through: they are not a server's slot.
 * - A merge moves the table with the slot (`move`, and `flush`'s
 *   `survivorOf`): an alias's pending writes land under its canonical entry,
 *   never back in the alias's deleted slot; the later write of a key wins.
 * - Memory only: closing the page before a Retry has flushed loses what is
 *   pending, as typing into a blocked app always did.
 */
export interface WriteGate {
  readonly closed: boolean;
  close(): void;
  /** The pending value of server `id`'s `key`: `undefined` when nothing is
   * pending, `null` for a pending removal. */
  peek(id: ServerId, key: string): string | null | undefined;
  record(id: ServerId, key: string, value: string | null): void;
  /** Write the table in order, each entry under its server's survivor. True —
   * and the gate open — only once every entry has landed. An entry whose
   * server was absorbed moves to the survivor by the ONE slot rule
   * (`slot-merge.ts`, board #335 ③b): merged with the survivor's pending
   * value, else its value on disk — a held removal of the absorbed server's
   * key deletes nothing of the survivor's, collections merge, an alert
   * naming the absorbed server names the survivor (reviewer P1-4 on
   * 6b923c0d), and a real conflict is won by the LATER write (a held write
   * is later than anything on disk) with the loser recorded, never
   * overwritten in silence. An id nothing shows to be any saved entry
   * (`survivorOf` → '') keeps its own. */
  flush(storage: Store, survivorOf?: (id: ServerId) => ServerId): boolean;
  pendingCount(): number;
}

export function createWriteGate(): WriteGate {
  let closed = false;
  let seq = 0;
  /** `id \0 key` → the entry; `seq` is the order it was last written. */
  const table = new Map<string, { id: ServerId; key: string; value: string | null; seq: number }>();
  const slot = (id: ServerId, key: string) => `${id}\u0000${key}`;
  const put = (id: ServerId, key: string, value: string | null, at: number) => {
    const held = table.get(slot(id, key));
    if (held && held.seq > at) return;            // the later write of a key wins
    table.set(slot(id, key), { id, key, value, seq: at });
  };
  const move = (storage: Store, from: ServerId, to: ServerId) => {
    if (!from || !to || from === to) return;
    for (const [k, e] of [...table].sort(([, x], [, y]) => x.seq - y.seq)) {
      if (e.id !== from) continue;
      const held = table.get(slot(to, e.key));
      const target = held ? held.value : storage.getItem(residentKey(e.key, to));
      const wins = held && held.seq > e.seq ? 'target' : 'source';
      const { value, lost } = mergeSlot(e.key, target, e.value, from, to, wins);
      // The loser is recorded, then the survivor's entry is written, and only
      // THEN is the absorbed one's entry let go of (orchestrator 16:32 on
      // 0f668e4f): a read or record that throws leaves the table as it was,
      // and the next flush runs this same, idempotent merge again.
      if (lost != null) recordLost(storage, { from, to, key: e.key, value: lost });
      table.set(slot(to, e.key), { id: to, key: e.key, value, seq: Math.max(e.seq, held?.seq ?? 0) });
      table.delete(k);
    }
  };
  return {
    get closed() { return closed; },
    close() { closed = true; },
    peek: (id, key) => table.get(slot(id, key))?.value,
    record(id, key, value) { put(id, key, value, ++seq); },
    flush(storage, survivorOf = (id) => id) {
      // A move that cannot read or record is a flush that did not land: the
      // gate stays closed, which keeps the app blocked until the next Retry.
      try {
        for (const id of new Set([...table.values()].map((e) => e.id))) move(storage, id, survivorOf(id));
      } catch { return false; }
      for (const e of [...table.values()].sort((a, b) => a.seq - b.seq)) {
        const key = residentKey(e.key, e.id);
        try {
          if (e.value === null) storage.removeItem(key); else storage.setItem(key, e.value);
        } catch { return false; }
        table.delete(slot(e.id, e.key));
      }
      closed = false;
      return true;
    },
    pendingCount: () => table.size,
  };
}

/**
 * The storage view of ONE server.
 *
 * An empty `serverId` is refused rather than tolerated: a view that silently
 * fell back to the unprefixed keys would write one server's drafts into the
 * place every other server reads, and it would do it only on the path where
 * the current server has not resolved yet — the hardest case to notice.
 *
 * With a `gate`, a resident write while it is closed goes to the table, and a
 * resident read answers from it first (see `WriteGate`).
 */
export function createServerStore(storage: Store, serverId: ServerId, gate?: WriteGate): ServerStore {
  if (!serverId) throw new Error('createServerStore: a server store needs a serverId');
  const keyFor = (key: string) => (isResidentKey(key) ? residentKey(key, serverId) : key);
  const held = (key: string) => !!gate?.closed && isResidentKey(key);
  return {
    serverId,
    keyFor,
    getItem: (key) => {
      const pending = gate && isResidentKey(key) ? gate.peek(serverId, key) : undefined;
      return pending !== undefined ? pending : storage.getItem(keyFor(key));
    },
    setItem: (key, value) => (held(key) ? gate!.record(serverId, key, String(value)) : storage.setItem(keyFor(key), value)),
    removeItem: (key) => (held(key) ? gate!.record(serverId, key, null) : storage.removeItem(keyFor(key))),
  };
}
