// The one runtime production holds while `ws.ts` still owns the socket
// (board #335 ②b-1).
//
// ②b's provider needs a `ServerRuntime` to bind a subtree to, and production
// has to keep exactly ONE socket while it gets one: sixteen modules still
// import their RPCs from the `ws.ts` facade at module level, and a runtime
// minted through the fleet builds its OWN connection (`registry.ensure` by
// entry id). That would be a second, never-dialled client sitting beside the
// live one, and every page that had not moved yet would be talking to the
// other socket. So the Single-mode runtime is built ON the facade's
// compatibility slot: `useServerApi()` inside a provided subtree returns the
// very api the un-migrated modules call, which is what lets each ②b commit be
// behaviour-identical in Single mode instead of a flag day.
//
// Two things this module is deliberate about.
//
// IT IS A FILE OF ITS OWN, so `server-runtime.ts` stays facade-free. That
// module's pin (`server-fleet.source.test.ts`) forbids the ws.ts import there
// and the reason stands: a RUNTIME that reaches the compatibility slot is the
// "whichever server is current" bug phase ② exists to remove, and it would
// look correct for as long as production holds one server. The compatibility
// edge belongs in one file that b3-4 deletes whole, not inside the module
// that outlives it.
//
// RELEASING THIS RUNTIME CLOSES ITS SOCKET; IT DOES NOT END THE OBJECT.
// `Connection.dispose()` is terminal by design (board #335 ①) and this object
// is the transport of every module that has not moved yet, so the slot handed
// to the runtime maps `dispose` onto `disconnect`. That is not a weakening of
// the runtime contract: for a SHARED slot, "this server is released" and "the
// socket is closed" are the same event, and the runtime's own terminal flag
// still makes the handle dead — a disposed runtime cannot dial again, which
// is what the contract is for. Without this, the two terminal paths inside
// `dial` (the entry removed mid-auth, this id absorbed by a twin) would end
// the app's only transport permanently, from a path that is supposed to
// report a result and let the caller recover.
//
// b3-4 deletes this file together with `compatSlotApi` and the slot itself,
// and the fleet mints the runtime from then on.
import { compatSlotApi, connection } from '../core/ws.ts';
import { createServerRuntime, type ServerRuntime, type ServerRuntimeDeps } from './server-runtime.ts';
import type { ServerEntry } from './servers.ts';

/**
 * A runtime for `entry` over the facade's one compatibility slot.
 *
 * Every other dependency is the caller's, exactly as for a fleet runtime, so
 * the only difference between this and what b3-4 replaces it with is WHERE
 * the connection comes from.
 */
export function createSingleRuntime(
  entry: ServerEntry,
  deps: Omit<ServerRuntimeDeps, 'slot'>,
): ServerRuntime {
  return createServerRuntime(entry, {
    ...deps,
    slot: {
      // A view, not a wrapper with behaviour: every member is the facade's own
      // closure, and only `dispose` is remapped (see the note above).
      connection: { ...connection, dispose: connection.disconnect },
      api: compatSlotApi,
    },
  });
}
