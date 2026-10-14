// The doubles the connection tests share: a WebSocket stand-in and the
// SERVER half of the E2E handshake, speaking either version with real Web
// Crypto. Installation is an explicit call, never an import side effect —
// `ws.ts` reads the globals when it dials, and a test that drives the facade
// needs them in place first.
//
// Nothing here fakes our own transport: the client code under test is the
// real `createConnection` / the real `ws.ts`.
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number;
  sent: unknown[];
  binaryType = '';
  closed = 0;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    MockWebSocket.instances.push(this);
  }

  send(data: unknown) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close() {
    this.closed++;
    this.readyState = MockWebSocket.CLOSED;
  }

  /** A text frame (handshake, plain-token path). */
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  /** An encrypted frame: binaryType is 'arraybuffer'. */
  binary(data: ArrayBuffer) {
    this.onmessage?.({ data });
  }

  /** The JSON requests this socket received, in wire order. */
  texts(): any[] {
    return this.sent
      .map((frame): any => (typeof frame === 'string' ? JSON.parse(frame) : null))
      .filter(Boolean);
  }
}

export const realCrypto = webcrypto as unknown as Crypto;

/** Put the browser globals the transport reads in place. */
export function installDoubles() {
  (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
  (globalThis as any).WebSocket = MockWebSocket;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: null } });
}

/** Real Web Crypto for the duration of `fn`, then back to the plain path. */
export async function withWebCrypto<T>(fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto });
  try { return await fn(); }
  finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: null } }); }
}

/** Count the timers a connection leaves behind. Both kinds matter: the idle
 * probe is an interval, and an unfinished dial's connect timeout is a timeout
 * (review P1-a — only counting intervals is what hid it). */
export function trackTimers() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const intervals = new Set<unknown>();
  const timeouts = new Set<unknown>();
  (globalThis as any).setInterval = (...args: any[]) => {
    const id = (realSetInterval as any)(...args);
    intervals.add(id);
    return id;
  };
  (globalThis as any).clearInterval = (id: any) => {
    intervals.delete(id);
    return (realClearInterval as any)(id);
  };
  (globalThis as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) => {
    if (typeof fn !== 'function') return (realSetTimeout as any)(fn, ms, ...rest);
    // A timeout that FIRES is finished whether or not anyone cleared it.
    let id: any;
    id = (realSetTimeout as any)((...a: any[]) => { timeouts.delete(id); fn(...a); }, ms, ...rest);
    timeouts.add(id);
    return id;
  };
  (globalThis as any).clearTimeout = (id: any) => {
    timeouts.delete(id);
    return (realClearTimeout as any)(id);
  };
  return {
    /** Intervals still running. */
    intervals: () => intervals.size,
    /** Timeouts neither cleared nor fired. */
    timeouts: () => timeouts.size,
    live: () => intervals.size + timeouts.size,
    restore() {
      for (const id of intervals) (realClearInterval as any)(id);
      for (const id of timeouts) (realClearTimeout as any)(id);
      intervals.clear();
      timeouts.clear();
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

const utf8 = new TextEncoder();
export const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
export const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map(h => parseInt(h, 16)));
export async function until(cond: () => boolean, ticks = 400) {
  for (let i = 0; i < ticks && !cond(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(cond(), 'condition never became true');
}
/** Let every queued microtask and timer-0 continuation run. */
export async function settle(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

// Web Crypto's lib.dom types want `ArrayBuffer`-backed views; node's Uint8Array
// is typed over ArrayBufferLike. One cast at the boundary, as connection.ts does.
const buf = (b: Uint8Array) => b as BufferSource;
async function hkdf(token: string, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await realCrypto.subtle.importKey('raw', buf(utf8.encode(token)), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await realCrypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(utf8.encode(info)) }, base, 256));
}
function gcmNonce(counter: number): Uint8Array {
  const n = new Uint8Array(12);
  new DataView(n.buffer).setUint32(8, counter);
  return n;
}

/** The server half of the handshake, speaking either version. One instance is
 * one server: its nonce, its keys and its two frame counters are its own, so
 * two of them can talk to two connections at the same time. */
export class FakeE2eServer {
  serverNonce = realCrypto.getRandomValues(new Uint8Array(16));
  negotiated = 0;
  machineId: string;
  hostname: string;
  /** What the login answer's `build` says (board #368); undefined = an older
   * server, whose answer has no such member at all. */
  build?: unknown;
  private token: string;
  private version: 1 | 2;
  private encKey!: CryptoKey;
  private decKey!: CryptoKey;
  private sendCounter = 0;
  private recvCounter = 0;
  constructor(token: string, version: 1 | 2 = 2, machineId = 'machine', hostname = 'host') {
    this.token = token;
    this.version = version;
    this.machineId = machineId;
    this.hostname = hostname;
  }

  nonceFrame() {
    return this.version === 2 ? { server_nonce: hex(this.serverNonce), e2e: 2 } : { server_nonce: hex(this.serverNonce) };
  }

  /** Verifies the proof the way connection.rs does: with the version the CLIENT asked for. */
  async accept(auth: any): Promise<boolean> {
    const clientNonce = unhex(auth.params.client_nonce);
    const salt = new Uint8Array(32); salt.set(this.serverNonce, 0); salt.set(clientNonce, 16);
    const requested = auth.params.e2e === 2 ? 2 : 1;
    let proof: Uint8Array, enc: Uint8Array, dec: Uint8Array;
    if (requested === 2) {
      proof = await hkdf(this.token, salt, 'tmux-mobile-e2e/v2/proof');
      enc = await hkdf(this.token, salt, 'tmux-mobile-e2e/v2/s2c');
      dec = await hkdf(this.token, salt, 'tmux-mobile-e2e/v2/c2s');
    } else {
      proof = enc = dec = await hkdf(this.token, salt, 'tmux-mobile-e2e');
    }
    const mac = await realCrypto.subtle.importKey('raw', buf(proof), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const msg = new Uint8Array(32); msg.set(this.serverNonce, 0); msg.set(clientNonce, 16);
    if (!(await realCrypto.subtle.verify('HMAC', mac, buf(unhex(auth.params.proof)), buf(msg)))) return false;
    this.encKey = await realCrypto.subtle.importKey('raw', buf(enc), { name: 'AES-GCM' }, false, ['encrypt']);
    this.decKey = await realCrypto.subtle.importKey('raw', buf(dec), { name: 'AES-GCM' }, false, ['decrypt']);
    this.negotiated = requested;
    return true;
  }

  /** Encrypt one server→client frame; `deflate` picks the compressed wire tag. */
  async seal(json: string, deflate = false): Promise<ArrayBuffer> {
    let body = utf8.encode(json);
    if (deflate) {
      const stream = new Blob([body as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      body = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    const plain = new Uint8Array(1 + body.length);
    plain[0] = deflate ? 0x01 : 0x00;
    plain.set(body, 1);
    return realCrypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(gcmNonce(this.sendCounter++)) }, this.encKey, buf(plain));
  }

  /** Decrypt one client→server frame into its JSON text. */
  async open(frame: unknown): Promise<string> {
    const ct = frame as Uint8Array;
    const plain = new Uint8Array(await realCrypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(gcmNonce(this.recvCounter++)) }, this.decKey, buf(ct)));
    const body = plain.subarray(1);
    if (plain[0] === 0x01) {
      const stream = new Blob([body as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(stream).text();
    }
    return new TextDecoder().decode(body);
  }

  /** Every request this server has not yet read, in wire order. The GCM
   * receive counter only moves forward, so each frame is decrypted once. */
  async drain(socket: MockWebSocket): Promise<any[]> {
    const out: any[] = [];
    while (this.cursor < socket.sent.length) out.push(JSON.parse(await this.open(socket.sent[this.cursor++])));
    return out;
  }
  /** The next request, waiting for it to arrive. */
  async next(socket: MockWebSocket): Promise<any> {
    await until(() => socket.sent.length > this.cursor);
    return (await this.drain(socket))[0];
  }
  /** Frames before this index are the plaintext handshake, not ciphertext. */
  cursor = 1;
}

/** Dial `conn` at `url` and complete the encrypted handshake with `server`. */
export async function handshake(
  conn: { connect(url: string, token: string, timeoutMs?: number): Promise<string | null> },
  server: FakeE2eServer,
  url: string,
  token: string,
): Promise<MockWebSocket> {
  const connecting = conn.connect(url, token);
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message(server.nonceFrame());
  await until(() => socket.sent.length >= 1);
  const auth = JSON.parse(socket.sent[0] as string);
  assert.equal(await server.accept(auth), true, 'proof verifies under the negotiated version');
  socket.binary(await server.seal(JSON.stringify({
    result: {
      authenticated: true, machine_id: server.machineId, hostname: server.hostname, e2e: server.negotiated,
      ...(server.build === undefined ? {} : { build: server.build }),
    },
  })));
  await connecting;
  return socket;
}

/** The plain-token handshake (no Web Crypto): text frames throughout. */
export async function handshakePlain(
  conn: { connect(url: string, token: string, timeoutMs?: number): Promise<string | null> },
  url: string,
  token: string,
  machineId = 'machine',
  build?: unknown,
): Promise<MockWebSocket> {
  const connecting = conn.connect(url, token);
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message({ server_nonce: '00'.repeat(16) });
  socket.message({ result: { authenticated: true, machine_id: machineId, hostname: machineId + '.host', ...(build === undefined ? {} : { build }) } });
  await connecting;
  return socket;
}
