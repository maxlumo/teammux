// ONE connection to one tmux-mobile server.
//
// Everything mutable about a live link belongs to the object `createConnection`
// returns: the socket, the request counter and its pending map, the
// pane/team listener registries, the subscription refcounts, the negotiated
// per-direction ciphers and the liveness timers. Two connections therefore
// share nothing — the same request id, the same pane target and the same room
// name on both is not a collision, because neither has a routing table the
// other can reach (board #335 ①).
//
// A connection OUTLIVES its socket: a reconnect to the same server replaces
// the socket inside one object, which is why listeners and refcounts survive
// `disconnect()` and only `dispose()` releases them.
//
// This module owns the transport and nothing else. It must not import
// localStorage, a Svelte store, anything under src/lib/app, or `window`:
// identity, persistence, reconnect policy and device reachability are the app
// layer's (connection.source.test.ts pins that boundary).

import { parseBuild, type BuildInfo } from './build-info.ts';
import { parseCaps } from './login-caps.ts';
import { ERR_AUTH } from './rpc-codes.ts';

// Cursor: x/y position, width, height, trailing trimmed lines.
export interface Cursor { x: number; y: number; w: number; h: number; t: number }
// Team messages / notification snapshots are consumed by still-unconverted
// .js modules; keep them loose until those convert and pin the real shape.
export type TeamMessage = any;
export type PaneOutputCb = (
  target: string,
  content: string | undefined,
  cursor: Cursor | undefined,
  currentCommand: string | undefined,
  /** Sent WITH current_command: the pane's agent backend, null for none. */
  agent: string | null | undefined,
) => void;
export type PaneClosedCb = (target: string) => void;
// Errors surfaced by this module carry an optional `code`: a JSON-RPC error
// code (number) for definitive server answers, or 'DISCONNECTED' (string)
// for transport-level failures.
export type RpcClientError = Error & { code?: number | string; data?: unknown };

/** The server's explicit refusal of the credentials, as a login failure: an Error that
 * carries the wire code the reconnect loop stops on (`isAuthRefusal`, app/dial-order.ts). */
const refusal = (message: unknown): RpcClientError => Object.assign(new Error(typeof message === 'string' && message ? message : 'auth failed'), { code: ERR_AUTH });

// One key per direction. Under the v1 handshake both fields hold the same key
// (kept for old servers); under v2 they are distinct HKDF outputs, so the two
// directions can never seal two frames under one (key, nonce) pair.
type Cipher = { sendKey: CryptoKey; recvKey: CryptoKey; sendCounter: number; recvCounter: number };
// The raw WebSocket plus our per-connection attachments (send serialization
// queue, receive dispatch queue, negotiated cipher, identity getters).
interface AppSocket extends WebSocket {
  _sendQueue: Promise<void>;
  _recvQueue: Promise<void>;
  _cipher: Cipher | null;
  _getMachineId?: () => string | null;
  _getHostname?: () => string | null;
  /** undefined until the login answered; null when it named no build. */
  _getBuild?: () => BuildInfo | null | undefined;
  /** undefined until the login answered; [] when it named none (board #377). */
  _getCaps?: () => string[] | undefined;
}

// ─── Wire framing for the encrypted binary path ─────────────────────────
// Encrypted frames travel as binary; the plaintext (post-decrypt) starts
// with a 1-byte tag telling us how to decode the rest:
//   0x00 = raw UTF-8 JSON
//   0x01 = raw deflate (RFC 1951) of UTF-8 JSON
// Plaintext-token connections (no Web Crypto) keep using TEXT frames with
// no framing.
const WIRE_PLAIN_JSON = 0x00;
const WIRE_DEFLATE_JSON = 0x01;
// Same threshold as the server: below this, deflate's overhead loses to
// the input size, so we just send plaintext.
const COMPRESS_MIN_BYTES = 256;

const CONNECT_TIMEOUT_MS = 5000;
// Default timeout for ordinary RPCs. Long-running methods (fs_download,
// fs_upload) override with a much larger value at their call site.
// Short default → consecutive timeouts feel a dead link quickly AND the
// UI flips to "Reconnecting" fast. See call() for the interplay with
// `pending.size` gating.
const RPC_TIMEOUT_MS = 6000;
const BASE64_CHUNK_SIZE = 8192;

// Idle-ping threshold. The server pushes pane snapshots at 200 ms and
// PINGs at 15 s, so under normal conditions the link sees inbound traffic
// every few hundred ms even when the user is idle. If we go this long
// without hearing anything, the link is plausibly half-open (mobile
// network parked the TCP socket without telling us) — issue a ping RPC
// so onclose fires within ~6 s instead of waiting 45 s for the server's
// own PING deadline.
const IDLE_PROBE_THRESHOLD_MS = 8000;
const IDLE_PROBE_INTERVAL_MS = 4000;  // how often we check the threshold

// Consecutive RPC timeouts only force a disconnect when the inbound channel
// has ALSO been silent this long. On a high-RTT link (bad cellular, 5-7 s
// round trips) small RPCs time out while pane_output pushes keep arriving —
// the link is alive, just slow; tearing it down and re-handshaking makes
// things strictly worse.
const TIMEOUT_DISCONNECT_INBOUND_SILENCE_MS = 10000;

// Liveness is handled at the WebSocket protocol layer: the server sends
// PING frames periodically and the browser auto-replies with PONG at a
// layer we never touch. When TCP really dies, `ws.onclose` fires and the
// app layer reacts via `onDisconnect`. Client-side JSON-RPC "ping" RPCs
// are no longer needed here.

// --- Crypto helpers (Web Crypto API) ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// E2E handshake versions. The server advertises the newest it speaks in its
// `server_nonce` frame (`e2e: 2`); we ask for that one in our auth params and
// fall back to v1 for a server that never mentions it. Mirrors
// `src-tauri/src/server/wire.rs` — the labels must match byte for byte.
export const E2E_VERSION = 2;
const E2E_INFO_V1 = 'tmux-mobile-e2e';
const E2E_INFO_V2_PROOF = 'tmux-mobile-e2e/v2/proof';
const E2E_INFO_V2_C2S = 'tmux-mobile-e2e/v2/c2s';
const E2E_INFO_V2_S2C = 'tmux-mobile-e2e/v2/s2c';

async function hkdfBits(token: string, serverNonce: Uint8Array, clientNonce: Uint8Array, info: string): Promise<ArrayBuffer> {
  const salt = new Uint8Array(32);
  salt.set(serverNonce, 0);
  salt.set(clientNonce, 16);
  const ikm = new TextEncoder().encode(token);
  const baseKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) }, baseKey, 256);
}

/// The raw session secrets for one handshake version: what we prove with,
/// what we encrypt with (client→server), what we decrypt with (server→client).
/// v1 is ONE key doing all three jobs — that is the defect v2 removes.
/// Exported so the test suite can pin these bytes to the server's vectors.
export async function deriveE2eMaterial(token: string, serverNonce: Uint8Array, clientNonce: Uint8Array, version: number): Promise<{ proof: Uint8Array; send: Uint8Array; recv: Uint8Array }> {
  if (version === E2E_VERSION) {
    const [proof, send, recv] = await Promise.all([
      hkdfBits(token, serverNonce, clientNonce, E2E_INFO_V2_PROOF),
      hkdfBits(token, serverNonce, clientNonce, E2E_INFO_V2_C2S),
      hkdfBits(token, serverNonce, clientNonce, E2E_INFO_V2_S2C),
    ]);
    return { proof: new Uint8Array(proof), send: new Uint8Array(send), recv: new Uint8Array(recv) };
  }
  const one = new Uint8Array(await hkdfBits(token, serverNonce, clientNonce, E2E_INFO_V1));
  return { proof: one, send: one, recv: one };
}

async function buildSession(token: string, serverNonce: Uint8Array, clientNonce: Uint8Array, version: number): Promise<{ proof: Uint8Array; cipher: Cipher }> {
  const m = await deriveE2eMaterial(token, serverNonce, clientNonce, version);
  const hmacKey = await crypto.subtle.importKey('raw', m.proof as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // Bind proof to BOTH nonces (see server-side comment in handle auth).
  const msg = new Uint8Array(serverNonce.length + clientNonce.length);
  msg.set(serverNonce, 0);
  msg.set(clientNonce, serverNonce.length);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, msg);
  const [sendKey, recvKey] = await Promise.all([
    crypto.subtle.importKey('raw', m.send as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']),
    crypto.subtle.importKey('raw', m.recv as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']),
  ]);
  return { proof: new Uint8Array(sig), cipher: { sendKey, recvKey, sendCounter: 0, recvCounter: 0 } };
}

function makeNonce(counter: number): Uint8Array {
  const n = new Uint8Array(12);
  const view = new DataView(n.buffer);
  // counter in bytes 4-11 (big-endian u64)
  view.setUint32(4, Math.floor(counter / 0x100000000));
  view.setUint32(8, counter >>> 0);
  return n;
}

// Compress a JSON string into the wire-plaintext byte stream:
// [framing byte] [body bytes]. Returns Uint8Array. Falls back to plain
// when the input is small or compresses to no benefit.
async function encodeWirePayload(text: string): Promise<Uint8Array> {
  const utf8 = new TextEncoder().encode(text);
  if (utf8.length < COMPRESS_MIN_BYTES || typeof CompressionStream === 'undefined') {
    const out = new Uint8Array(1 + utf8.length);
    out[0] = WIRE_PLAIN_JSON;
    out.set(utf8, 1);
    return out;
  }
  // CompressionStream is native (zlib via the platform), much faster than
  // any JS deflate library and zero CPU on V8's JIT.
  const stream = new Blob([utf8 as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  if (compressed.length + 1 >= utf8.length + 1) {
    // Pathological: compressing made it bigger. Fall back to plain.
    const out = new Uint8Array(1 + utf8.length);
    out[0] = WIRE_PLAIN_JSON;
    out.set(utf8, 1);
    return out;
  }
  const out = new Uint8Array(1 + compressed.length);
  out[0] = WIRE_DEFLATE_JSON;
  out.set(compressed, 1);
  return out;
}

// Inverse of encodeWirePayload: decode a wire-plaintext byte buffer
// (framing byte + body) back into the original JSON string.
async function decodeWirePayload(bytes: Uint8Array): Promise<string> {
  if (!bytes || bytes.length < 1) throw new Error('empty wire payload');
  const tag = bytes[0]!; // length checked above
  const body = bytes.subarray(1);
  if (tag === WIRE_PLAIN_JSON) {
    return new TextDecoder().decode(body);
  }
  if (tag === WIRE_DEFLATE_JSON) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('server sent deflate but DecompressionStream is unavailable');
    }
    const stream = new Blob([body as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }
  throw new Error(`unknown wire framing tag: 0x${tag.toString(16)}`);
}

// Encrypt a JSON string and return a Uint8Array suitable for ws.send().
// The plaintext is the wire-framed payload (compressed or not).
async function encryptMsg(text: string, cipher: Cipher | null): Promise<string | Uint8Array> {
  if (!cipher) return text; // plain path: caller sends it as text
  const plaintext = await encodeWirePayload(text);
  const nonce = makeNonce(cipher.sendCounter++);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, cipher.sendKey, plaintext as BufferSource);
  return new Uint8Array(ct);
}

// Decrypt an inbound binary ciphertext into the original JSON string.
async function decryptMsg(buf: string | ArrayBuffer | Uint8Array, cipher: Cipher | null): Promise<string> {
  if (!cipher) {
    // Plain-token fallback: buf is already the decoded text.
    return typeof buf === 'string' ? buf : new TextDecoder().decode(buf as ArrayBuffer);
  }
  // decryptMsg with a cipher is only ever called with binary frames.
  const ctBytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf as ArrayBuffer);
  const nonce = makeNonce(cipher.recvCounter++);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, cipher.recvKey, ctBytes as BufferSource);
  return decodeWirePayload(new Uint8Array(pt));
}

function addListener<CB>(map: Map<string, Set<CB>>, target: string, cb: CB) {
  let set = map.get(target);
  if (!set) { set = new Set(); map.set(target, set); }
  set.add(cb);
}
function removeListener<CB>(map: Map<string, Set<CB>>, target: string, cb: CB) {
  const set = map.get(target);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) map.delete(target);
}

// What every caller of a connection can do. The members are CLOSURES over
// one object's state, not prototype methods, so destructuring them is safe
// and a reference stays bound to the connection it came from.
export interface Connection {
  /** Dial `url`, authenticate with `token`, replace whatever socket this
   * object had. Resolves with the server's machine id. */
  connect(url: string, token: string, timeoutMs?: number): Promise<string | null>;
  /** Close the socket deliberately: pending RPCs reject, recovery is NOT
   * requested, and listeners / subscription refcounts are KEPT (the pages
   * that registered them are still mounted). */
  disconnect(): void;
  /** Final teardown of this object, and TERMINAL: after it, `connect` and
   * `call` reject, registering a listener or a subscription is dropped, and a
   * replacement comes only from the registry. Idempotent, and it touches no
   * other connection. */
  dispose(): void;
  call<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  isConnected(): boolean;
  getMachineId(): string | null | undefined;
  getHostname(): string | null | undefined;
  /** The build the server said it runs in its login answer (board #368):
   * undefined while there is no authenticated socket, null when the server
   * named none (an older one). */
  getBuild(): BuildInfo | null | undefined;
  /** The capabilities the server announced in its login answer (board #377):
   * undefined while there is no authenticated socket, `[]` for an older server
   * that announced none. */
  getCaps(): string[] | undefined;
  /** Observe the capabilities of the CURRENT authenticated socket (board
   * #377): called with the list when a login answers, and with `undefined`
   * when the socket goes away or is replaced, so a page that shows or hides
   * something by capability follows a reconnect to a server with others.
   * Returns the unsubscribe. */
  onCaps(cb: (caps: string[] | undefined) => void): () => void;
  /** The capabilities of the current socket: at once if its login has
   * answered, else as soon as one does. Rejects after `timeoutMs` (a login
   * that never answers must not hold a caller forever) or when disposed. */
  whenCaps(timeoutMs?: number): Promise<string[]>;
  /** The URL the current socket was dialled with — the origin a signed
   * download URL of THIS connection must be resolved against. */
  url(): string | null;
  setOnDisconnect(cb: (() => void) | null): void;
  addPaneOutputListener(target: string, cb: PaneOutputCb): void;
  removePaneOutputListener(target: string, cb: PaneOutputCb): void;
  addPaneClosedListener(target: string, cb: PaneClosedCb): void;
  removePaneClosedListener(target: string, cb: PaneClosedCb): void;
  addTeamMessageListener(cb: (message: TeamMessage) => void): void;
  removeTeamMessageListener(cb: (message: TeamMessage) => void): void;
  subscribe(target: string): void;
  unsubscribe(target: string): void;
  resubscribeActive(): void;
}

export function createConnection(): Connection {
  let ws: AppSocket | null = null;
  let wsUrl: string | null = null;
  let requestId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: RpcClientError) => void }>();
  // Per-target listener registries. Each mounted Terminal registers a callback
  // keyed by its own target, so multiple terminals (split-screen) coexist —
  // pane_output / pane_closed are routed to the matching listeners instead of a
  // single shared callback that instances would overwrite.
  //
  // Value is a Set of callbacks, NOT a single cb: two split cells can show the
  // SAME target (same window), and both must receive every push. With a single
  // cb the second registration silently replaced the first, so only one cell
  // refreshed. A Set fans out to all, and removing one cell's cb leaves the
  // other's intact.
  const paneOutputListeners = new Map<string, Set<PaneOutputCb>>();
  const paneClosedListeners = new Map<string, Set<PaneClosedCb>>();
  // Team group-chat message push listeners (Team tab). Unkeyed — one stream
  // for the whole room — so a plain Set, not a per-target map.
  const teamMessageListeners = new Set<(message: TeamMessage) => void>();
  let onDisconnect: (() => void) | null = null;
  /** Who watches the current socket's capabilities (`onCaps`). */
  const capsListeners = new Set<(caps: string[] | undefined) => void>();
  /** Callers parked in `whenCaps`: disposing the connection ends their wait now, not at their timer. */
  const capsWaiters = new Set<(reason: Error) => void>();
  function emitCaps() {
    const caps = ws?._getCaps?.();
    for (const cb of [...capsListeners]) { try { cb(caps); } catch {} }
  }
  let recoveryEnabled = false;
  let disconnectNotified = false;
  // Idle-probe state. lastInboundAt is updated on every inbound message
  // (any frame: handshake, RPC reply, push). idleProbeTimer is the periodic
  // checker that fires a `ping` RPC if nothing has arrived for too long.
  let lastInboundAt = 0;
  let idleProbeTimer: ReturnType<typeof setInterval> | null = null;
  let idleProbeInFlight = false;
  // Terminal once dispose() has run: see the note on dispose() below. Nothing
  // sets it back.
  let disposed = false;

  function rejectDisposed<T>(): Promise<T> {
    const err: RpcClientError = new Error('connection disposed');
    err.code = 'DISCONNECTED';
    return Promise.reject(err);
  }

  // Subscription refcount per target. The server keeps ONE subscription entry
  // per target, so two split cells on the same window must NOT let the first
  // cell's unmount send `unsubscribe` and cut the survivor's feed. We send the
  // wire subscribe only on the 0→1 transition and unsubscribe only on 1→0.
  // (The set of who-wants-it is the count; resubscribe-on-reconnect re-sends
  // for every still-positive target.)
  const subRefcount = new Map<string, number>();

  // These take the cb so the caller can register/unregister its own listener
  // without disturbing other cells on the same target. Callers MUST pass the
  // same function reference to remove that they passed to add.
  //
  // Adding anything to a DISPOSED connection is dropped: a late registration
  // from an unmounted view must not leave state on an object the registry has
  // already forgotten. Removal always runs — it only ever deletes.
  function addPaneOutputListener(target: string, cb: PaneOutputCb) { if (!disposed) addListener(paneOutputListeners, target, cb); }
  function removePaneOutputListener(target: string, cb: PaneOutputCb) { removeListener(paneOutputListeners, target, cb); }
  function addPaneClosedListener(target: string, cb: PaneClosedCb) { if (!disposed) addListener(paneClosedListeners, target, cb); }
  function removePaneClosedListener(target: string, cb: PaneClosedCb) { removeListener(paneClosedListeners, target, cb); }
  function addTeamMessageListener(cb: (message: TeamMessage) => void) { if (!disposed) teamMessageListeners.add(cb); }
  function removeTeamMessageListener(cb: (message: TeamMessage) => void) { teamMessageListeners.delete(cb); }
  function setOnDisconnect(cb: (() => void) | null) { if (!disposed) onDisconnect = cb; }

  function notifyDisconnect(reason: string) {
    if (!recoveryEnabled || disconnectNotified) return;
    disconnectNotified = true;
    onDisconnect?.();
  }

  function sendOnSocket(socket: AppSocket, message: string): Promise<void> {
    const send = socket._sendQueue.then(async () => {
      const out = await encryptMsg(message, socket._cipher);
      if (ws !== socket || socket.readyState !== WebSocket.OPEN) {
        const error: RpcClientError = new Error('connection changed before send');
        error.code = 'DISCONNECTED';
        throw error;
      }
      socket.send(out);
    });
    // Keep the socket queue usable after one send fails; callers still receive
    // the original rejection through the returned promise.
    socket._sendQueue = send.catch(() => {});
    return send;
  }

  // Issue a ping RPC if the inbound channel has been silent past the
  // threshold. ping is cheap (one RTT, ~zero bytes), and using a regular
  // RPC means timeout / error handling already exists in `call()` — three
  // consecutive failures already trigger forceDisconnect.
  //
  // Skip when:
  //   - another idle probe is in flight (avoid stacking)
  //   - a real RPC is already in flight (its response will reset the clock,
  //     and stacking probes on top of a slow legitimate RPC is wasteful)
  //   - the threshold hasn't elapsed (pane_output / RPC reply already
  //     reset lastInboundAt)
  function maybeIdleProbe() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (idleProbeInFlight) return;
    if (pending.size > 0) return;
    if (Date.now() - lastInboundAt < IDLE_PROBE_THRESHOLD_MS) return;
    idleProbeInFlight = true;
    // Use a tighter timeout than RPC_TIMEOUT_MS — we already know the link
    // hasn't said anything in 8 s, no point waiting another 6.
    call('ping', {}, 4000).catch(() => {}).finally(() => {
      idleProbeInFlight = false;
    });
  }

  function startIdleProbe() {
    stopIdleProbe();
    lastInboundAt = Date.now();
    idleProbeTimer = setInterval(maybeIdleProbe, IDLE_PROBE_INTERVAL_MS);
  }

  function stopIdleProbe() {
    if (idleProbeTimer) clearInterval(idleProbeTimer);
    idleProbeTimer = null;
    idleProbeInFlight = false;
  }

  function rejectAllPending(reason?: string) {
    const err: RpcClientError = new Error(reason || 'disconnected');
    err.code = 'DISCONNECTED';
    for (const { reject: rej } of pending.values()) rej(err);
    pending.clear();
  }

  // A dial that has not settled yet. Until it does, two things are alive that
  // nothing else can reach: the promise the caller is awaiting and the connect
  // timeout. Both belong to this connection's lifetime — a superseded dial, a
  // deliberate disconnect and a dispose each have to end them, or the object is
  // "released" while a timer and an unanswered promise outlive it (review
  // P1-a, 2026-10-09).
  type Dial = { settle: () => void; fail: (err: RpcClientError) => void; timeout: ReturnType<typeof setTimeout> | null };
  const dialing = new Set<Dial>();

  function endDial(dial: Dial) {
    if (dial.timeout !== null) clearTimeout(dial.timeout);
    dial.timeout = null;
    dialing.delete(dial);
  }

  /** Settle every unfinished dial with `reason` and clear its timeout. The
   * socket itself is closed by whoever called this (connect's own teardown,
   * disconnect) — this is only about the attempt. */
  function cancelDialing(reason: string) {
    for (const dial of [...dialing]) {
      endDial(dial);
      const err: RpcClientError = new Error(reason);
      err.code = 'DISCONNECTED';
      dial.fail(err);
    }
  }

  function connect(url: string, token: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<string | null> {
    if (disposed) return rejectDisposed();
    // An earlier attempt still waiting for a nonce or an auth answer is over:
    // its socket is about to be replaced, so nothing can ever answer it.
    cancelDialing('superseded by new connect');
    // Close any existing connection before creating a new one.
    // IMPORTANT: null ALL handlers (including onmessage) so any in-flight events on
    // the old socket don't fire handlers that still close over module-level `ws` and
    // accidentally send frames on the NEW socket (common race during reconnect).
    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.close();
      } catch {}
      ws = null;
      emitCaps();
      stopIdleProbe();
      rejectAllPending('superseded by new connect');
    }
    recoveryEnabled = false;
    disconnectNotified = false;
    rpcTimeouts = 0;
    wsUrl = url;

    return new Promise<string | null>((resolveRaw, rejectRaw) => {
      // One record per attempt, so a cancellation can reach THIS promise and
      // THIS timer. Every settle path below goes through these two.
      const dial: Dial = { settle: () => {}, fail: rejectRaw, timeout: null };
      const resolve = (value: string | null) => { endDial(dial); resolveRaw(value); };
      const reject = (error: unknown) => { endDial(dial); rejectRaw(error); };
      dial.fail = reject;
      dialing.add(dial);

      let socket!: AppSocket;
      try {
        ws = new WebSocket(url) as AppSocket;
        socket = ws;
        // Every handler below closes over this identity. A stale close or an
        // async encrypted send from an older connection must never mutate or
        // write through the module-level pointer after reconnect replaced it.
        // Receive ciphertext as ArrayBuffer rather than Blob so we can decrypt
        // synchronously without a Blob → arrayBuffer round-trip per message.
        socket.binaryType = 'arraybuffer';
        socket._sendQueue = Promise.resolve();
        socket._recvQueue = Promise.resolve();
        socket._cipher = null;
      } catch (e) {
        reject(e);
        return;
      }

      const timeout = setTimeout(() => {
        try { socket?.close(); } catch {}
        reject(new Error('connection timeout'));
      }, timeoutMs);
      dial.timeout = timeout;

      let authed = false;
      let cipher: Cipher | null = null;
      let serverNonce: Uint8Array | null = null;
      let machineId: string | null = null;
      let hostname: string | null = null;
      let build: BuildInfo | null = null;
      let caps: string[] = [];

      function authSuccess() {
        clearTimeout(timeout);
        authed = true;
        socket._cipher = cipher;
        emitCaps();
        recoveryEnabled = true;
        disconnectNotified = false;
        // Liveness is the server's job at the protocol layer: it sends WS
        // PING every 15 s and tears down TCP after a 45 s deadline. That
        // surfaces here as `ws.onclose`. We add an application-layer idle
        // probe (below) so we trip onclose within ~14 s instead of 45 s
        // when the link goes half-open (common on mobile networks).
        startIdleProbe();
        resolve(machineId);
      }

      // Expose getters
      socket._getMachineId = () => machineId;
      socket._getHostname = () => hostname;
      socket._getBuild = () => (authed ? build : undefined);
      socket._getCaps = () => (authed ? caps : undefined);

      // Frames are handled strictly in arrival order. Decrypt + wire-decode is
      // async, and its latency depends on the frame: a ≥256-byte payload goes
      // through DecompressionStream (several tasks), a small one through a
      // synchronous TextDecoder — so two `await`s started back to back can
      // finish in the other order. For pane_output that paints snapshot N
      // after N+1 and, because the server only pushes on change, leaves the
      // stale screen up until the next change. One per-socket promise chain,
      // the mirror of `_sendQueue`, keeps dispatch order = wire order.
      socket.onmessage = (event) => {
        if (ws !== socket) return;
        // Any inbound message resets the idle clock — the link is alive,
        // even if the message is just a handshake / push / heartbeat.
        lastInboundAt = Date.now();
        const job = socket._recvQueue.then(() => handleMessage(event));
        // A failed frame must not stall the chain; the handler already turned
        // every failure it cares about into a disconnect or a dropped frame.
        socket._recvQueue = job.catch(() => {});
      };

      async function handleMessage(event: MessageEvent) {
        if (ws !== socket) return;
        // event.data is either a string (text frames: handshake, plain auth
        // path) or an ArrayBuffer (binary frames: encrypted messages).
        const isBinary = event.data instanceof ArrayBuffer;
        // Protocol-boundary escape hatch: frames are parsed from the wire and
        // narrowed by the runtime checks below, not by the type system.
        let data: any;
        if (!isBinary) {
          try { data = JSON.parse(event.data); } catch {}
        }

        // Step 1: Receive server_nonce (always text)
        if (!authed && !serverNonce && data?.server_nonce) {
          serverNonce = hexToBytes(data.server_nonce);
          if (crypto.subtle) {
            // Encrypted auth. The server names the newest handshake it speaks;
            // an older server sends no `e2e` and gets the v1 derivation.
            const version = data.e2e === E2E_VERSION ? E2E_VERSION : 1;
            const clientNonce = crypto.getRandomValues(new Uint8Array(16));
            const session = await buildSession(token, serverNonce, clientNonce, version);
            if (ws !== socket) return;
            cipher = session.cipher;
            socket.send(JSON.stringify({
              method: 'auth',
              params: { client_nonce: bytesToHex(clientNonce), proof: bytesToHex(session.proof), e2e: version }
            }));
          } else {
            // Fallback: plain token auth (http:// context, no Web Crypto)
            socket.send(JSON.stringify({ method: 'auth', params: { token } }));
          }
          return;
        }

        // Step 2: Auth response
        if (!authed && serverNonce) {
          if (cipher) {
            // Encrypted auth response — must arrive as a binary frame.
            if (!isBinary) {
              clearTimeout(timeout); cipher = null;
              // ONE plain frame is expected here and it is a refusal: the server has no
              // session key for a proof it just rejected, so its `invalid proof`
              // (ERR_AUTH) comes as text (connection.rs). It is kept as such — the
              // reconnect loop stops on it instead of dialling for three minutes — and
              // it is ONLY ever a refusal: a plain frame is never read as a login that
              // succeeded (no downgrade), and any other unexpected frame stays the
              // protocol error it always was (board #393).
              if (data?.error?.code === ERR_AUTH) reject(refusal(data.error.message));
              else reject(new Error('auth failed: expected binary auth response'));
              return;
            }
            try {
              const pt = await decryptMsg(event.data, cipher);
              if (ws !== socket) return;
              const resp = JSON.parse(pt);
              if (resp.result?.authenticated) { machineId = resp.result.machine_id; hostname = resp.result.hostname; build = parseBuild(resp.result.build); caps = parseCaps(resp.result.caps); authSuccess(); return; }
            } catch {}
            clearTimeout(timeout); cipher = null; reject(new Error('auth failed')); return;
          } else {
            // Plain (token) response — text frame.
            if (data?.result?.authenticated) { machineId = data.result.machine_id; hostname = data.result.hostname; build = parseBuild(data.result.build); caps = parseCaps(data.result.caps); authSuccess(); return; }
            clearTimeout(timeout);
            reject(data?.error?.code === ERR_AUTH ? refusal(data.error.message) : new Error(data?.error?.message || 'auth failed'));
            return;
          }
        }

        // Post-auth: every encrypted message arrives as a binary frame and
        // gets decrypted + wire-decoded into JSON. Plain-token connections
        // continue to receive text frames (data is already parsed above).
        if (authed && cipher) {
          if (!isBinary) return; // ignore unexpected text frames after encrypted auth
          let pt;
          try { pt = await decryptMsg(event.data, cipher); }
          catch {
            // The receive counter already advanced for this frame, so every
            // later frame would fail too: the session is dead from here on.
            // Say so now — waiting for the idle probe's three timeouts left the
            // app silently frozen for ~20 s before reconnect kicked in.
            if (ws === socket) forceDisconnect('decrypt failed');
            return;
          }
          if (ws !== socket) return;
          try { data = JSON.parse(pt); } catch { return; }
        }

        if (!data) return;

        if (data.method === 'pane_output') {
          // current_command (with the pane's `agent`) is included only on the
          // first push and when it actually changes — most ticks omit it. Fan out to EVERY listener
          // on this target (multiple split cells may show the same window).
          const tgt = data.params?.target;
          const set = paneOutputListeners.get(tgt);
          if (set) for (const cb of set) cb(tgt, data.params?.content, data.params?.cursor, data.params?.current_command, data.params?.agent);
          return;
        }

        if (data.method === 'pane_closed') {
          const tgt = data.params?.target;
          const set = paneClosedListeners.get(tgt);
          if (set) for (const cb of set) cb(tgt);
          return;
        }

        if (data.method === 'team_message') {
          const m = data.params?.message;
          if (m) for (const cb of teamMessageListeners) cb(m);
          return;
        }

        if (data.id != null && pending.has(data.id)) {
          const { resolve: res, reject: rej } = pending.get(data.id)!; // guarded by pending.has above
          pending.delete(data.id);
          if (data.error) {
            const err: RpcClientError = new Error(data.error.message);
            // JSON-RPC error code, so callers can tell a definitive server answer
            // (e.g. -32601 method-not-found → no team bus) from transport errors.
            err.code = data.error.code;
            // And its optional `data`: facts a caller needs to ACT on the
            // failure rather than only show it (board #337 — which project
            // holds the scratch name, so the confirmation names it and the
            // release can only touch that one).
            if (data.error.data !== undefined) err.data = data.error.data;
            rej(err);
          } else res(data.result);
        }
      }

      socket.onclose = (ev) => {
        clearTimeout(timeout);
        if (ws !== socket) {
          return;
        }
        stopIdleProbe();
        const wasAuthed = authed;
        authed = false;
        ws = null;
        emitCaps();
        rejectAllPending(wasAuthed ? 'connection lost' : 'connection closed during auth');
        // Surface close-frame metadata so we can tell client-initiated from
        // server-initiated from network-killed disconnects:
        //   1000 = normal close
        //   1001 = "going away" — common when an Android webview is
        //          backgrounded; the OS suspends the WS without sending
        //          a clean close. May surface here without a code at all.
        //   1006 = abnormal closure, no close frame received (usual TCP RST
        //          on mobile networks)
        //   custom 4xxx codes = the server's `break`/`return` paths just
        //          drop the connection without a code, you'll see 1006.
        if (wasAuthed) notifyDisconnect('socket closed');
        else reject(new Error('connection closed during auth'));
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        if (!authed) reject(new Error('connection failed'));
      };
    });
  }

  function disconnect() {
    if (disposed) return;
    const socket = ws;
    ws = null;
    emitCaps();
    recoveryEnabled = false;
    disconnectNotified = false;
    stopIdleProbe();
    rejectAllPending('disconnected');
    cancelDialing('disconnected');
    if (!socket) return;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    try { socket.close(); } catch {}
  }

  function isConnected(): boolean {
    return ws?.readyState === WebSocket.OPEN;
  }

  function getMachineId(): string | null | undefined {
    return ws?._getMachineId?.();
  }

  function getHostname(): string | null | undefined {
    return ws?._getHostname?.();
  }

  function getBuild(): BuildInfo | null | undefined {
    return ws?._getBuild?.();
  }

  function getCaps(): string[] | undefined {
    return ws?._getCaps?.();
  }

  function onCaps(cb: (caps: string[] | undefined) => void): () => void {
    capsListeners.add(cb);
    return () => { capsListeners.delete(cb); };
  }

  function whenCaps(timeoutMs = 5000): Promise<string[]> {
    if (disposed) return Promise.reject(new Error('connection disposed'));
    const known = getCaps();
    if (known) return Promise.resolve(known);
    return new Promise<string[]>((resolve, reject) => {
      const done = () => { clearTimeout(timer); off(); capsWaiters.delete(abort); };
      const abort = (reason: Error) => { done(); reject(reason); };
      const off = onCaps((caps) => { if (caps) { done(); resolve(caps); } });
      const timer = setTimeout(() => abort(new Error('the server has not answered its login')), timeoutMs);
      capsWaiters.add(abort);
    });
  }

  let rpcTimeouts = 0;

  function forceDisconnect(reason?: string) {
    if (!ws) return;
    const socket = ws;
    ws = null;
    emitCaps();
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    try { socket.close(); } catch {}
    stopIdleProbe();
    rejectAllPending(reason || 'forced disconnect');
    notifyDisconnect(reason || 'forced disconnect');
  }

  function call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    if (disposed) return rejectDisposed<T>();
    return new Promise<T>((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        notifyDisconnect('RPC attempted without an open socket');
        const error: RpcClientError = new Error('not connected');
        error.code = 'DISCONNECTED';
        reject(error);
        return;
      }
      const socket = ws;
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        rpcTimeouts++;
        // Only tear down the connection when consecutive timeouts *and* there
        // is nothing else still in flight. If another RPC is still pending
        // (e.g. a big download), its single huge response frame is almost
        // certainly what's delaying our little polling RPCs — the link is
        // alive, just momentarily monopolized. We'd rather let the pollers
        // fail individually and keep the connection open. Real dead-link
        // scenarios still trip: once the long RPC also fails or completes,
        // the next idle window will re-check.
        const inboundSilenceMs = Date.now() - lastInboundAt;
        if (rpcTimeouts >= 3 && pending.size === 0 && inboundSilenceMs >= TIMEOUT_DISCONNECT_INBOUND_SILENCE_MS) {
          forceDisconnect('3 consecutive RPC timeouts');
        } else if (rpcTimeouts >= 3 && inboundSilenceMs < TIMEOUT_DISCONNECT_INBOUND_SILENCE_MS) {
          // Server pushes are still arriving — the link is alive but slow
          // (or our requests are being starved by a big inbound frame).
          // Reset the counter so we re-evaluate from scratch instead of
          // tripping the breaker the moment pushes pause.
          rpcTimeouts = 0;
        }
        reject(new Error('request timeout'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); rpcTimeouts = 0; resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const msg = JSON.stringify({ id, method, params });
      sendOnSocket(socket, msg).catch((error) => {
        pending.delete(id);
        clearTimeout(timer);
        notifyDisconnect('RPC send lost its socket');
        reject(error);
      });
    });
  }

  function sendSubscribe(target: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ method: 'subscribe', params: { target } });
    const socket = ws;
    sendOnSocket(socket, msg).catch(() => {});
  }
  function sendUnsubscribe(target: string) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = JSON.stringify({ method: 'unsubscribe', params: { target } });
    const socket = ws;
    sendOnSocket(socket, msg).catch(() => {});
  }

  function subscribe(target: string) {
    if (disposed) return;
    const n = (subRefcount.get(target) || 0) + 1;
    subRefcount.set(target, n);
    if (n === 1) sendSubscribe(target); // first subscriber → tell the server
  }

  function unsubscribe(target: string) {
    if (disposed) return;
    const n = (subRefcount.get(target) || 0) - 1;
    if (n <= 0) {
      subRefcount.delete(target);
      sendUnsubscribe(target); // last subscriber left → tell the server
    } else {
      subRefcount.set(target, n);
    }
  }

  // Re-send subscribe for every target with a live refcount. Used after a
  // reconnect, where the server forgot all subscriptions. Does NOT change
  // refcounts (the cells are still mounted; only the wire state was lost).
  function resubscribeActive() {
    if (disposed) return;
    for (const target of subRefcount.keys()) sendSubscribe(target);
  }

  function url(): string | null {
    return wsUrl;
  }

  // dispose() is the END of this object, not a reset (review P1-b,
  // 2026-10-09). Without a terminal flag an old handle held by a retry
  // closure or an unmounted view could dial again AFTER the registry removed
  // it: `ensure(key)` would then hand out a fresh object while the forgotten
  // one still owned a live socket — two connections behind one key, one of
  // them invisible to the registry that is supposed to own every lifetime.
  // A new connection comes only from the registry.
  //
  // disconnect() is the other verb and is unchanged: it keeps the listener
  // registries and the subscription refcounts, because a reconnect to the same
  // server must not lose a still-mounted Terminal's feed.
  function dispose() {
    if (disposed) return;
    disconnect(); // ends the socket, the pending RPCs and any unfinished dial
    disposed = true;
    onDisconnect = null;
    paneOutputListeners.clear();
    paneClosedListeners.clear();
    teamMessageListeners.clear();
    for (const abort of [...capsWaiters]) abort(new Error('connection disposed'));
    capsListeners.clear();
    subRefcount.clear();
  }

  return {
    connect, disconnect, dispose, call, isConnected, getMachineId, getHostname, getBuild, getCaps, onCaps, whenCaps, url,
    setOnDisconnect,
    addPaneOutputListener, removePaneOutputListener,
    addPaneClosedListener, removePaneClosedListener,
    addTeamMessageListener, removeTeamMessageListener,
    subscribe, unsubscribe, resubscribeActive,
  };
}
