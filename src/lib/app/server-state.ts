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
