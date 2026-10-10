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
 * The storage view of ONE server.
 *
 * An empty `serverId` is refused rather than tolerated: a view that silently
 * fell back to the unprefixed keys would write one server's drafts into the
 * place every other server reads, and it would do it only on the path where
 * the current server has not resolved yet — the hardest case to notice.
 */
export function createServerStore(storage: Store, serverId: ServerId): ServerStore {
  if (!serverId) throw new Error('createServerStore: a server store needs a serverId');
  const keyFor = (key: string) => (isResidentKey(key) ? residentKey(key, serverId) : key);
  return {
    serverId,
    keyFor,
    getItem: (key) => storage.getItem(keyFor(key)),
    setItem: (key, value) => storage.setItem(keyFor(key), value),
    removeItem: (key) => storage.removeItem(keyFor(key)),
  };
}
