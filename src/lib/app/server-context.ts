// Which server a subtree is looking at (board #335 ②a-3, decision D1).
//
// A component needs the API of ONE server, and it must be the same server for
// the whole life of that component instance. Threading it as a prop would mean
// editing every intermediate layer of App, Hub and Files; a module-level
// "current api" would mean an operation started on A can finish against B,
// which is the bug the whole phase exists to remove. So: a Svelte context set
// at the root of each server-bound subtree, read ONCE at init into a local
// const.
//
// "Once at init" is the contract, not an optimisation:
//
//   - a reference resolved at init is IMMUTABLE for the instance. An upload, a
//     download, a delete that is half done cannot re-target itself because the
//     user looked at another server meanwhile.
//   - split-screen falls out of it. Each cell wraps its own provider, so two
//     cells on two servers need no extra mechanism.
//   - it is also all Svelte gives us: `getContext` is only valid during
//     component initialisation. Reading it inside a handler or after an
//     `await` is a lifecycle error, not a style question.
//
// Three things must NOT use this, and take an explicit api or serverId
// instead (reviewer P2): framework helpers that are not components
// (`attachments.svelte.ts` and friends), background work that outlives the
// component that started it (a download, a notification landing), and
// union-list row actions, which take their runtime from the CLICKED ref — a
// list that spans servers has no single owner, so one `useServerApi()` for
// every row would send B's action to A.
//
// Not wired into production yet: ②a ships this; the ②b commit where App
// provides real runtimes is what mounts a provider.
import { getContext, setContext } from 'svelte';
import { compatSlotApi } from '../core/ws.ts';
import type { WsApi } from '../core/ws-api.ts';
import type { ServerId } from './refs.ts';
import type { ServerRuntime } from './server-runtime.ts';
import type { ServerState } from './server-state.ts';

const KEY = Symbol('tmm.server-scope');

/** Everything a server-bound subtree is bound to: the runtime it talks
 * through and the state the app remembers about that server (②b-2-1). ONE
 * context key for both — two keys could each answer "which server is this
 * subtree on" differently. */
export interface ServerScope {
  runtime: ServerRuntime;
  state: ServerState;
}

/**
 * Bind this subtree to one server — its runtime and its state. Call it during
 * the initialisation of the component that OWNS the subtree.
 *
 * ②b's contract on top of this: the subtree's owner is the runtime HANDLE, so
 * a replacement runtime for the same cell, target or serverId swaps the owner
 * while an ordinary reconnect inside one runtime (the handle is the same
 * object) remounts nothing.
 *
 * Keying on the handle gives the swap, NOT its order: Svelte creates the new
 * branch before destroying the old one (measured in
 * server-context.mount.test.ts). "The old owner is torn down — subscriptions
 * cleared, landings aimed at it invalidated — before the new one mounts" is a
 * separate, explicit step ②b has to sequence itself.
 */
export function setServerScope(scope: ServerScope): void {
  setContext(KEY, scope);
}

/** The context a component MOUNTED on its own needs to be bound to `scope` —
 * `mount(Component, { context })`, for a host that mounts a server-bound
 * component outside any provider (the mount tests). The same key, so there is
 * still one way to bind a scope. */
export function scopeContext(scope: ServerScope): Map<symbol, ServerScope> {
  return new Map([[KEY, scope]]);
}

/** The scope this subtree is bound to, or null when nothing provided one.
 * Init only — and ONE read per component (pinned): `scope.runtime` and
 * `scope.state` come from the same answer. */
export function useServerScope(): ServerScope | null {
  return getContext<ServerScope | undefined>(KEY) ?? null;
}

/** The runtime this subtree is bound to, or null when nothing provided one.
 * Init only. */
export function useServerRuntime(): ServerRuntime | null {
  return useServerScope()?.runtime ?? null;
}

/**
 * The server id this subtree is bound to, or NULL when nothing provided one.
 *
 * Null rather than a stand-in, deliberately (reviewer P2): until ②b the
 * fallback is the facade's one compatibility slot, and that slot is not a
 * server — the same handle has its server REPLACED on the next connect. A
 * fabricated "current" id would look stable while naming different machines
 * over time, and whatever got filed under it would be filed wrong. A caller
 * that needs an id to scope storage must refuse to act without one, the same
 * way `createServerStore` throws on an empty id.
 */
export function useServerId(): ServerId | null {
  return useServerRuntime()?.id ?? null;
}

/**
 * The RPC surface for this subtree's server, resolved once at init.
 *
 * With no provider it is the `ws.ts` facade — which is not a compatibility
 * shim with a second behaviour, it IS the path every page takes today. ②b
 * mounts real providers and ②b-3 deletes this fallback; after that a missing
 * provider is a runtime failure rather than a silent fall-back to whatever
 * server is current, so ②b-3 needs mount coverage for every consumer and
 * cannot lean on the compiler to find them.
 */
export function useServerApi(): WsApi {
  return useServerRuntime()?.api ?? compatSlotApi;
}
