// What the app remembers about ONE server, as one value (board #335 ②b-2-1).
//
// Before this, every piece of it was a module singleton — the Hub's
// per-project maps, the alert list, the backend catalog, Files' browse
// positions and download rows — and an in-place switch had to remember to
// reset or re-read each one (`resetServerMemory`, `reloadServerState`). A
// store somebody forgot to list followed the user onto the next server.
//
// Now the state belongs to a RUNTIME: App builds a bundle for each runtime it
// binds, the provider hands it to the subtree with the runtime, and a page
// reads it from its scope once at init. A different server is a different
// runtime and so a different bundle; nothing has to be told to forget.
//
// TWO RULES this value exists to keep:
//
//   - ONE OWNER PER KEY. A field joins the bundle in the SAME commit its module
//     singleton is deleted. Two live instances over the same storage keys
//     would each hold their own copy and the later write would win — the
//     drafts lost on the first switch after an upgrade that ②a's review
//     caught in the plan.
//   - BUILT AFTER THE SERVER IS CURRENT. Through ②b the storage is still the
//     bare `localStorage`, whose unprefixed keys `pointTo` re-points at
//     whichever server is current. A bundle built before CURRENT moved would
//     read the server being LEFT. So App builds it in `swapScope` — the one
//     reader of CURRENT, and the step that binds the runtime — and never on
//     first sight of an entry (reviewer, b2-1 plan). b2-4 hands each bundle a
//     store scoped to its server, and then the timing stops mattering.
import { createHubPrefs, type HubPrefs } from '../hub/hub-prefs.svelte.ts';
import { createAlertLog, createCentre, type Centre } from '../hub/notify-centre.svelte.ts';
import { createFilesMemory, type FilesMemory } from '../files/files-memory.ts';
import { createDownloads, type DownloadStore } from '../files/downloads.svelte.ts';
import { SUSPEND } from '../files/download.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ServerState {
  /** The Hub's per-project memory: lead, read mark, draft, drawer, roster
   * disclosure, and which project was open. The person's own preferences
   * (feed level, tool-row cap, sidebar) are NOT here: they live in `appPrefs`,
   * one owner however many servers are on screen. */
  prefs: HubPrefs;
  /** This server's notification centre: ITS alert list, and the window's one
   * bell, popover and jump request, which every server's centre shares. */
  centre: Centre;
  /** What the Files pages remember about this server, and its download rows,
   * TOGETHER: the page and the Hub's drawer share one record, and removing
   * the runtime has to forbid new attempts, suspend and await, then release
   * (②a's ruling). Memory only — nothing of it is stored. */
  files: { memory: FilesMemory; downloads: DownloadStore };
}

/** One server's state, over `storage`. Call it only once that server is
 * CURRENT — see the module header. */
export function createServerState(storage: Store): ServerState {
  return {
    prefs: createHubPrefs(storage),
    centre: createCentre(createAlertLog(storage)),
    files: { memory: createFilesMemory(), downloads: createDownloads() },
  };
}

/**
 * The state a new runtime for entry `id` starts with (reviewer P1 on
 * bdac94bd, 2026-10-10).
 *
 * Usually a fresh bundle. The exception is the runtime it replaces being the
 * SAME MACHINE under an id identity repair has since folded into `id` — an
 * alias absorbed into its canonical entry on a same-server reconnect or a
 * failover. That is not a different server, so its state is not a different
 * state, and it TRANSFERS: a fresh bundle would empty the Downloads rows and
 * browse positions of the machine still on screen, and — the dangerous half —
 * orphan every download attempt in flight, which outlives the components that
 * started it. A later switch suspends only the bundle it can find, so those
 * attempts would never be stopped, and their retries would go out over
 * whatever the socket reaches next.
 *
 * WHICH ids merged is the identity layer's record (`survivorOf`, i.e.
 * `servers.mergedInto`), never an inference from an id being absent.
 */
export function stateForRuntime(
  replaced: { id: string; state: ServerState | undefined } | null,
  id: string,
  deps: { survivorOf: (id: string) => string; create: () => ServerState },
): ServerState {
  const merged = !!replaced && replaced.id !== id && deps.survivorOf(replaced.id) === id;
  // A state already released (or being released) is never handed over: its
  // Files record is sealed for good, and adopting it would leave the
  // canonical runtime unable to start a download (reviewer P1-b,
  // 2026-10-10). A failed switch's Back is the ordinary way here: the switch
  // released the alias's state on the way out, and the merge is discovered
  // only on the way back.
  const live = merged && replaced.state && !replaced.state.files.memory.sealed() ? replaced.state : null;
  return live ?? deps.create();
}

/**
 * Release one server's state (board #335 ②b-2-3): what removing a runtime
 * owes the work it started, in the order ②a ruled.
 *
 *   1. FORBID NEW ATTEMPTS. `suspend` snapshots what is tracked when it is
 *      called and does not seal off a later `track`, so this is its own step:
 *      a download started in the gap is aborted the moment it registers.
 *   2. SUSPEND every attempt tracked, keeping its part on disk (the bytes are
 *      that server's file, resumed when the user is back on it).
 *   3. AWAIT their settle, so no retry, re-sign or fallback of that server's
 *      chain can go out after this resolves — over a socket that may by then
 *      reach another server.
 *   4. Drop: the caller lets go of the bundle.
 *
 * Idempotent, so every path that ends a runtime may call it.
 */
export async function releaseServerState(state: ServerState): Promise<void> {
  state.files.memory.seal(SUSPEND);
  await state.files.memory.suspend(SUSPEND);
}
