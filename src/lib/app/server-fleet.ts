// Which servers the app is holding at once (board #335 ②).
//
// Three layers, one job each, and the fleet is the wiring between them:
//
//   `core/connection-registry.ts`  object LIFETIME — one connection per key
//   `app/servers.ts`               IDENTITY — which saved entry is which
//   `app/server-fleet.ts`          the set of runtimes the app holds
//
// Like `registry.ensure`, `include` never dials: it hands back an idle runtime,
// because only the caller knows whether now is the moment to contact a server.
// And like the registry, it has no "current" — a fleet is a set, not a focus.
// Phase ②a's production fleet still holds exactly one member; the aggregate
// switch that fills it is ③.
//
// One machine, one runtime. `servers.ts` already guarantees one ENTRY per
// machine, so keying by `ServerEntry.id` is normally enough, but a caller
// holding a stale entry (a list read before a merge) must not be able to open
// a second client for a machine that already has one.
import { createConnectionRegistry, type ConnectionRegistry } from '../core/connection-registry.ts';
import type { ServerId } from './refs.ts';
import { loadServers, type ServerEntry } from './servers.ts';
import { createServerRuntime, type ServerRuntime } from './server-runtime.ts';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ServerFleetDeps {
  storage: Store;
  /** Normally the fleet's own. Injectable so a test (and ②b's App) can share
   * one registry, since object lifetime is the registry's to own. */
  registry?: ConnectionRegistry;
  connectTimeoutMs?: number;
  /**
   * How a runtime the fleet lets go of is ENDED (board #335 ②b-4; reviewer
   * and orchestrator, 01:46): the host's one end — stop it, release its
   * server's state, then dispose (app/handle-end.ts). Without it the fleet
   * disposes at once, which is right only for a host with no state to
   * release. Either way the id is free immediately: its slot leaves the
   * registry now, so a re-include builds a new connection while the old one
   * is still being ended.
   */
  end?: (runtime: ServerRuntime) => void | Promise<void>;
}

export interface ServerFleet {
  /** The runtime for this entry, created idle on first ask. Returns the
   * EXISTING runtime when one already serves that entry — or that machine —
   * and `undefined` for an entry that is no longer in the saved registry, so
   * a caller holding a stale list cannot re-register a server that identity
   * has already merged away or removed. */
  include(entry: ServerEntry): ServerRuntime | undefined;
  get(id: ServerId): ServerRuntime | undefined;
  /** The runtime serving a machine, by the id its entry or its live socket
   * reports. Empty machine ids never match. */
  byMachine(machineId: string): ServerRuntime | undefined;
  ids(): ServerId[];
  all(): ServerRuntime[];
  /**
   * Drop every runtime whose entry has left the saved registry.
   *
   * `servers.ts` is the identity authority, and `recordServer` can delete
   * entries that belong to OTHER runtimes: it absorbs every twin of the
   * machine that just authenticated. So membership follows the entry set,
   * reconciled here after each `recordServer`, instead of each runtime
   * discovering its own loss — a runtime that has not dialled yet, or is
   * still authenticating, has no occasion to discover anything and would sit
   * here holding a socket for a server that no longer exists.
   *
   * This re-applies `servers.ts`'s rules; it does not re-decide identity. The
   * fleet never merges by address on its own.
   */
  reconcile(): ServerId[];
  /** Drop one server: its runtime is disposed and its connection released.
   * Every other runtime, including a dial in flight, is untouched. */
  drop(id: ServerId): void;
  dropAll(): void;
}

export function createServerFleet(deps: ServerFleetDeps): ServerFleet {
  const { storage, connectTimeoutMs } = deps;
  const registry = deps.registry ?? createConnectionRegistry();
  const runtimes = new Map<ServerId, ServerRuntime>();

  function byMachine(machineId: string): ServerRuntime | undefined {
    if (!machineId) return undefined;
    for (const rt of runtimes.values()) if (rt.machineId() === machineId) return rt;
    return undefined;
  }

  function include(entry: ServerEntry): ServerRuntime | undefined {
    const held = runtimes.get(entry.id);
    if (held) return held;
    // A stale list must not re-register a server identity has let go of. The
    // saved registry is the authority on what exists, and an entry absent
    // from it has either been removed or absorbed into another machine's.
    if (!loadServers(storage).some((s) => s.id === entry.id)) return undefined;
    const twin = entry.machineId ? byMachine(entry.machineId) : undefined;
    if (twin) return twin;
    const runtime = createServerRuntime(entry, {
      storage,
      slot: registry.ensure(entry.id),
      // Every recordServer can change the entry SET, so membership is
      // reconciled against it rather than each runtime watching itself.
      onRegistryChanged: reconcile,
      ...(connectTimeoutMs == null ? {} : { connectTimeoutMs }),
    });
    runtimes.set(entry.id, runtime);
    return runtime;
  }

  function reconcile(): ServerId[] {
    const saved = new Set(loadServers(storage).map((s) => s.id));
    const gone = [...runtimes.keys()].filter((id) => !saved.has(id));
    // drop() disposes the runtime, which is terminal: a dial still
    // authenticating is cancelled, the socket closes, the liveness clock
    // stops, and a reply already on the wire resolves nothing — so a late
    // answer cannot recreate the entry identity has just absorbed.
    for (const id of gone) drop(id);
    return gone;
  }

  function drop(id: ServerId): void {
    const runtime = runtimes.get(id);
    if (!runtime) return;
    runtimes.delete(id);
    // The host's end, when it has one: release first, dispose last (whose
    // final step disposes the connection). The slot leaves the registry NOW
    // either way, so the two maps never disagree about what is alive.
    if (deps.end) {
      registry.take(id);
      void deps.end(runtime);
      return;
    }
    // The runtime's dispose releases the connection; removing the key from the
    // registry keeps the two maps from disagreeing about what is alive.
    runtime.dispose();
    registry.remove(id);
  }

  function dropAll(): void {
    for (const id of [...runtimes.keys()]) drop(id);
  }

  return {
    include,
    get: (id) => runtimes.get(id),
    byMachine,
    ids: () => [...runtimes.keys()],
    all: () => [...runtimes.values()],
    reconcile,
    drop,
    dropAll,
  };
}
