// The connection layer's one import for the app (board #335 ②b-4).
//
// Until ②b this module was a FACADE: one connection in one slot, its RPCs and
// lifecycle re-exported, and every page talked to "whichever server that slot
// was on". Phase ② gave every server an explicit runtime and every page a
// scope, so the slot, its RPC exports and the compatibility api went with the
// last consumer (orchestrator's ruling, 2026-10-11 01:43). What is left:
//
//   - the types and the factories — a connection, its bound api, a registry
//     of them — so the app wires runtimes from one import, and a mount test
//     can mock that one module;
//   - the DEVICE's reachability memory below, deliberately global.
//
// Do not add a connection or an RPC here again. A page takes its server's
// api from its scope (app/server-context.ts); App takes it from the runtime
// it is bound to.
export type { Cursor, TeamMessage, PaneOutputCb, PaneClosedCb, RpcClientError, Connection } from './connection.ts';
export { E2E_VERSION, deriveE2eMaterial, createConnection } from './connection.ts';
export type {
  TmuxSession, TmuxPane, HubAgent, HubWake, RoomUnread, ReadMark, ServerMark,
  BoardIssue, BoardCountRow, HubActivityEvent, RegAgent, TeamMember, RegTeam,
  RegSkill, RegMcpServer, WsApi,
} from './ws-api.ts';
export { httpOriginForWs, createWsApi } from './ws-api.ts';
export { createConnectionRegistry } from './connection-registry.ts';
export type { ConnectionKey, ConnectionRegistry, ConnectionSlot } from './connection-registry.ts';

// The wire error codes a client acts on live in rpc-codes.ts, outside this
// mocked-in-tests module (board #337); re-exported so the public surface is
// one import.
export { ERR_SCRATCH_HELD, ERR_SCRATCH_STALE } from './rpc-codes.ts';

// ─── Device reachability (GLOBAL, deliberately not per-connection) ───────
// What follows is the ONE piece of module state this file still owns, and it
// is a property of the DEVICE, not of any server: whether an address is
// reachable from the network this phone is on right now. Classification is
// pure, the failure memory is keyed by URL, and its invalidation is a
// platform event ('online', connection type change) — so it is shared by
// every connection and belongs outside connection.ts, which must stay free of
// `window` (reviewer r1 §3, orchestrator ruling 2026-10-09). It is NOT
// authentication and NOT machine identity: a viable address proves nothing
// about which server answers on it.

// --- Address optimization ---

const PROBE_TIMEOUT_MS = 3000;

// Classify address: 0=LAN, 1=Tailscale, 2=Internet
export function classifyAddress(url: string): number {
  try {
    const host = new URL(url).hostname;
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 0;
    if (/^100\./.test(host)) return 1;
    return 2;
  } catch { return 2; }
}

export const ADDRESS_LABELS = ['LAN', 'Tailscale', 'WAN'];

// ─── Probe failure memory ────────────────────────────────────────────────
// The browser can't read its own subnet (no reliable "am I on this LAN?"
// signal in a WebView), so we approximate it from history: an address that
// just failed a probe will keep failing until the device changes networks.
// Remember failures and skip those addresses for a cooldown window; clear
// the memory the moment the platform reports a network change (wifi join,
// cellular handoff) — that's exactly when a dead LAN address may have come
// alive.
const PROBE_FAIL_COOLDOWN_MS = 2 * 60 * 1000;
const probeFailedAt = new Map<string, number>(); // url -> timestamp of last failed probe

function clearProbeMemory() {
  probeFailedAt.clear();
}

// True if the address has no fresh probe/connect failure on record.
// Used by the reconnect round-robin to skip addresses that just proved
// unreachable (e.g. LAN IPs while the phone is on cellular).
export function isAddressViable(url: string): boolean {
  const failedAt = probeFailedAt.get(url);
  return !failedAt || Date.now() - failedAt > PROBE_FAIL_COOLDOWN_MS;
}

// Record a reachability failure observed outside probeAddress (e.g. a real
// connect() attempt that timed out or failed before auth).
export function noteAddressUnreachable(url: string | null | undefined) {
  if (url) probeFailedAt.set(url, Date.now());
}
window.addEventListener('online', clearProbeMemory);
// Network type / subnet change (wifi↔cellular, AP switch) on supporting platforms.
(navigator as any).connection?.addEventListener?.('change', clearProbeMemory);

// Lightweight probe: WebSocket handshake only, no auth
function probeAddress(url: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    try {
      const probe = new WebSocket(url);
      const timer = setTimeout(() => { try { probe.close(); } catch {} resolve(false); }, PROBE_TIMEOUT_MS);
      probe.onopen = () => { clearTimeout(timer); try { probe.close(); } catch {} resolve(true); };
      probe.onerror = () => { clearTimeout(timer); resolve(false); };
    } catch { resolve(false); }
  }).then(ok => {
    if (ok) probeFailedAt.delete(url);
    else probeFailedAt.set(url, Date.now());
    return ok;
  });
}

// Probe addresses in parallel, return best reachable one (LAN > Tailscale > Internet).
// Addresses with a fresh probe failure are skipped — they cannot have come
// back without a network change, and that clears the memory. If every
// candidate is in cooldown (e.g. total outage just now), probe them all
// anyway rather than returning nothing.
export async function findBestAddress(addresses: string[] | null | undefined): Promise<string | null> {
  if (!addresses || addresses.length <= 1) return addresses?.[0] || null;
  const sorted = [...addresses].sort((a, b) => classifyAddress(a) - classifyAddress(b));
  const now = Date.now();
  let candidates = sorted.filter(url => {
    const failedAt = probeFailedAt.get(url);
    return !failedAt || now - failedAt > PROBE_FAIL_COOLDOWN_MS;
  });
  if (candidates.length === 0) candidates = sorted;
  const results = await Promise.all(candidates.map(url => probeAddress(url)));
  for (let i = 0; i < candidates.length; i++) {
    if (results[i]) return candidates[i]!;
  }
  return null;
}
