// The lifetime of connection objects, and nothing else (board #335 ①).
//
// A registry hands out one Connection + its bound API per key and keeps them
// alive until someone removes them. What it deliberately does NOT do:
//
//   - dial. `ensure` builds an idle object; connecting is the caller's verb,
//     because only the caller knows the address, the token and whether now is
//     the right moment.
//   - decide identity. A key is whatever the layer above calls a server; the
//     registry never reads storage, never parses a URL and never compares
//     machine ids. `src/lib/app/servers.ts` stays the one authority on which
//     saved server is which (phase ② binds `ServerEntry.id` as the key).
//   - pick a focus. There is no "current" entry here. `ws.ts` keeps its own
//     memory-only compatibility key, and that is a property of the facade,
//     not of this map.
//
// Two `ensure` calls with the same key return the SAME object, so a caller
// cannot accidentally mint a second client for one server.
import { createConnection, type Connection } from './connection.ts';
import { createWsApi, type WsApi } from './ws-api.ts';

/** Phase ① uses a Symbol (the facade's memory-only slot); phase ② uses
 * `ServerEntry.id`. Both are opaque to this module. */
export type ConnectionKey = string | symbol;

export interface ConnectionSlot {
  connection: Connection;
  /** Every RPC, already bound to `connection`. */
  api: WsApi;
}

export interface ConnectionRegistry {
  /** The slot for `key`, created idle on first ask. Never dials. */
  ensure(key: ConnectionKey): ConnectionSlot;
  get(key: ConnectionKey): ConnectionSlot | undefined;
  /** Drop `key` and dispose ONLY its connection. Unknown keys are a no-op. */
  remove(key: ConnectionKey): void;
  /** Forget `key`'s slot WITHOUT disposing it, and return it: for an owner
   * that ends the connection itself, later, after work that still needs it
   * has settled (board #335 ②b-4: the fleet ends a runtime release → dispose).
   * A new `ensure(key)` meanwhile builds a fresh object. */
  take(key: ConnectionKey): ConnectionSlot | undefined;
  /** Dispose every slot of THIS registry. */
  disposeAll(): void;
}

export function createConnectionRegistry(): ConnectionRegistry {
  const slots = new Map<ConnectionKey, ConnectionSlot>();

  function ensure(key: ConnectionKey): ConnectionSlot {
    let slot = slots.get(key);
    if (!slot) {
      const connection = createConnection();
      slot = { connection, api: createWsApi(connection) };
      slots.set(key, slot);
    }
    return slot;
  }

  function remove(key: ConnectionKey) {
    const slot = slots.get(key);
    if (!slot) return;
    slots.delete(key);
    slot.connection.dispose();
  }

  function disposeAll() {
    // Snapshot first: dispose() must not observe a map being mutated under it.
    const all = [...slots.values()];
    slots.clear();
    for (const slot of all) slot.connection.dispose();
  }

  function take(key: ConnectionKey) {
    const slot = slots.get(key);
    slots.delete(key);
    return slot;
  }

  return { ensure, get: (key) => slots.get(key), remove, take, disposeAll };
}
