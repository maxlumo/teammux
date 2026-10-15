import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState: number;
  sent: unknown[];
  binaryType = '';
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
    this.readyState = MockWebSocket.CLOSED;
  }

  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  // An encrypted frame arrives as an ArrayBuffer (binaryType = 'arraybuffer').
  binary(data: ArrayBuffer) {
    this.onmessage?.({ data });
  }
}

(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as any).WebSocket = MockWebSocket;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { subtle: null },
});

// One connection and its bound api, as a runtime holds them (board #335
// ②b-4 retired ws.ts's own slot; these were its lifecycle tests, and the
// lifecycle is the connection's).
const wsModule = await import(`./ws.ts?lifecycle=${Date.now()}`);
const wsConnection = wsModule.createConnection();
const wsClient = { ...wsConnection, ...wsModule.createWsApi(wsConnection), httpOriginForWs: wsModule.httpOriginForWs, deriveE2eMaterial: wsModule.deriveE2eMaterial, E2E_VERSION: wsModule.E2E_VERSION };

test('HTTP download base removes only the terminal WebSocket proxy segment', () => {
  assert.equal(wsClient.httpOriginForWs('ws://devbox:5173/ws'), 'http://devbox:5173');
  assert.equal(wsClient.httpOriginForWs('wss://devbox.example/tmux/ws?x=1'), 'https://devbox.example/tmux');
  assert.equal(wsClient.httpOriginForWs('wss://devbox.example/tmux'), 'https://devbox.example/tmux');
});

async function authenticate() {
  const connecting = wsClient.connect('ws://test', 'token');
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message({ server_nonce: '00'.repeat(16) });
  socket.message({ result: { authenticated: true, machine_id: 'machine', hostname: 'host' } });
  await connecting;
  return socket;
}

test('an unavailable authenticated socket requests recovery exactly once', async () => {
  let disconnects = 0;
  wsClient.setOnDisconnect(() => disconnects++);
  const socket = await authenticate();
  socket.readyState = MockWebSocket.CLOSED;

  await assert.rejects(wsClient.sendKeys('s:0.0', 'a'), { code: 'DISCONNECTED' });
  await assert.rejects(wsClient.sendKeys('s:0.0', 'b'), { code: 'DISCONNECTED' });
  assert.equal(disconnects, 1);

  wsClient.disconnect();
});

test('manual disconnect never requests recovery', async () => {
  let disconnects = 0;
  wsClient.setOnDisconnect(() => disconnects++);
  await authenticate();

  wsClient.disconnect();
  await assert.rejects(wsClient.sendKeys('s:0.0', 'a'), { code: 'DISCONNECTED' });
  assert.equal(disconnects, 0);
});

test('a stale close handler cannot clear a replacement connection', async () => {
  let disconnects = 0;
  wsClient.setOnDisconnect(() => disconnects++);
  const first = await authenticate();
  const staleClose = first.onclose!;
  await authenticate();

  staleClose({ code: 1006, reason: '', wasClean: false });
  assert.equal(wsClient.isConnected(), true);
  assert.equal(disconnects, 0);

  wsClient.disconnect();
});

test('an async send from an old socket is discarded after replacement', async () => {
  const first = await authenticate();
  wsClient.subscribe('s:0.0');

  const reconnecting = wsClient.connect('ws://test', 'token');
  const second = MockWebSocket.instances.at(-1)!;
  second.readyState = MockWebSocket.OPEN;
  second.message({ server_nonce: '00'.repeat(16) });
  second.message({ result: { authenticated: true, machine_id: 'machine', hostname: 'host' } });
  await reconnecting;
  await Promise.resolve();

  assert.equal(first.sent.some(frame => String(frame).includes('subscribe')), false);
  assert.equal(second.sent.some(frame => String(frame).includes('subscribe')), false);

  wsClient.unsubscribe('s:0.0');
  wsClient.disconnect();
});

test('concurrent RPC frames preserve request order on one socket', async () => {
  const socket = await authenticate();
  const first = wsClient.sendKeys('s:0.0', 'a');
  const second = wsClient.sendKeys('s:0.0', 'b');
  for (let i = 0; i < 5 && socket.sent.filter(frame => typeof frame === 'string' && frame.includes('send_keys')).length < 2; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }

  const requests: any[] = socket.sent
    .map((frame): any => typeof frame === 'string' ? JSON.parse(frame) : null)
    .filter(message => message?.method === 'send_keys');
  assert.deepEqual(requests.map(message => message.params.keys), ['a', 'b']);

  for (const request of requests) socket.message({ id: request.id, result: { ok: true } });
  await Promise.all([first, second]);
  wsClient.disconnect();
});

// ─── E2E handshake: real Web Crypto, fake server ────────────────────────
// The tests above run the plain-token path (`crypto.subtle` is null). These
// swap node's Web Crypto in for one test at a time and play the server side
// of the handshake, so the client's key derivation, version negotiation and
// per-direction ciphers are exercised against the documented protocol
// (docs/requirements/api-contracts/websocket-rpc.md).

const realCrypto = webcrypto as unknown as Crypto;
async function withWebCrypto<T>(fn: () => Promise<T>): Promise<T> {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto });
  try { return await fn(); }
  finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle: null } }); }
}

const utf8 = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map(h => parseInt(h, 16)));
async function until(cond: () => boolean, ticks = 400) {
  for (let i = 0; i < ticks && !cond(); i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(cond(), 'condition never became true');
}

// Web Crypto's lib.dom types want `ArrayBuffer`-backed views; node's Uint8Array
// is typed over ArrayBufferLike. One cast at the boundary, as ws.ts does.
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

/** The server half of the handshake, speaking either version. */
class FakeE2eServer {
  serverNonce = realCrypto.getRandomValues(new Uint8Array(16));
  negotiated = 0;
  private token: string;
  private version: 1 | 2;
  private encKey!: CryptoKey;
  private decKey!: CryptoKey;
  private sendCounter = 0;
  private recvCounter = 0;
  constructor(token: string, version: 1 | 2) {
    this.token = token;
    this.version = version;
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
    assert.equal(plain[0], 0x00, 'small RPC frames are sent uncompressed');
    return new TextDecoder().decode(plain.subarray(1));
  }
}

async function encryptedHandshake(server: FakeE2eServer) {
  const connecting = wsClient.connect('ws://test', 'tok');
  const socket = MockWebSocket.instances.at(-1)!;
  socket.readyState = MockWebSocket.OPEN;
  socket.message(server.nonceFrame());
  await until(() => socket.sent.length >= 1);
  const auth = JSON.parse(socket.sent[0] as string);
  assert.equal(await server.accept(auth), true, 'proof verifies under the negotiated version');
  socket.binary(await server.seal(JSON.stringify({ result: { authenticated: true, machine_id: 'm', hostname: 'h', e2e: server.negotiated } })));
  await connecting;
  return { socket, auth };
}

test('the client derives the same E2E keys as the server (shared vectors)', () => withWebCrypto(async () => {
  // Pinned to src-tauri/src/server/wire.rs `e2e_key_derivation_matches_the_client_vectors`.
  const sn = Uint8Array.from({ length: 16 }, (_, i) => i);
  const cn = Uint8Array.from({ length: 16 }, (_, i) => 16 + i);
  const v1 = await wsClient.deriveE2eMaterial('tmm-test-token', sn, cn, 1);
  assert.equal(hex(v1.proof), '3ed67f3af05161bcc3b7dfa90cdac9f122073ca497a2ed17061ef8228628d1c3');
  assert.equal(v1.send, v1.proof, 'v1: one key for everything');
  assert.equal(v1.recv, v1.proof);
  const v2 = await wsClient.deriveE2eMaterial('tmm-test-token', sn, cn, 2);
  assert.equal(hex(v2.proof), '3991dde940bf280c1b61ab909e69fd55371b88e9fbbb4dca564baf47fca8c3aa');
  assert.equal(hex(v2.send), 'efb72f80e209dd1e24ea4e8091743df8c74e5d1105549bc1b8129d5e77061082');
  assert.equal(hex(v2.recv), '5dee4968bc587b108b14a7c9d8fb9442e48c35ced0a6538fb1ce5418e48ba07d');
}));

test('a v2 server gets a v2 handshake: proof key, c2s and s2c are distinct keys', () => withWebCrypto(async () => {
  const server = new FakeE2eServer('tok', 2);
  const { socket, auth } = await encryptedHandshake(server);
  assert.equal(auth.params.e2e, 2, 'the client asks for the version the server advertised');
  assert.equal(server.negotiated, 2);
  assert.equal(wsClient.isConnected(), true);

  // An RPC goes out under c2s and its answer comes back under s2c.
  const pending = wsClient.listSessions();
  await until(() => socket.sent.length >= 2);
  const req = JSON.parse(await server.open(socket.sent[1]));
  assert.equal(req.method, 'list_sessions');
  socket.binary(await server.seal(JSON.stringify({ id: req.id, result: [] })));
  assert.deepEqual(await pending, []);
  wsClient.disconnect();
}));

test('a frame that fails to decrypt disconnects at once — the counter cannot recover', () => withWebCrypto(async () => {
  let disconnects = 0;
  wsClient.setOnDisconnect(() => disconnects++);
  const server = new FakeE2eServer('tok', 2);
  const { socket } = await encryptedHandshake(server);
  assert.equal(wsClient.isConnected(), true);

  // Garbage where a ciphertext should be: AES-GCM rejects it, and the receive
  // counter has already moved past this frame, so nothing later could decrypt.
  socket.binary(new Uint8Array(48).buffer);
  await until(() => !wsClient.isConnected());
  assert.equal(disconnects, 1, 'recovery is requested immediately, not after the idle probe');
  // Whatever the dead socket delivers afterwards is ignored.
  socket.binary(await server.seal(JSON.stringify({ method: 'pane_output', params: { target: 's:0.0', content: 'late' } })));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(disconnects, 1);
}));

test('encrypted frames are dispatched in arrival order even when decoding latency differs', () => withWebCrypto(async () => {
  const server = new FakeE2eServer('tok', 2);
  const { socket } = await encryptedHandshake(server);
  const seen: string[] = [];
  const listener = (_t: string, content: string) => { seen.push(content); };
  wsClient.addPaneOutputListener('s:0.0', listener);

  // Frame 1: a big snapshot, deflated on the wire → DecompressionStream, many
  // microtasks. Frame 2: a tiny one, plain → synchronous TextDecoder. Without
  // an ordered dispatch queue, frame 2 paints first and frame 1 overwrites it.
  const big = 'x'.repeat(4000);
  const first = await server.seal(JSON.stringify({ method: 'pane_output', params: { target: 's:0.0', content: big } }), true);
  const second = await server.seal(JSON.stringify({ method: 'pane_output', params: { target: 's:0.0', content: 'small' } }));
  socket.binary(first);
  socket.binary(second);
  await until(() => seen.length === 2);
  assert.deepEqual(seen.map(s => s.length), [4000, 5], 'wire order is dispatch order');

  wsClient.removePaneOutputListener('s:0.0', listener);
  wsClient.disconnect();
}));

test('a server that does not advertise e2e gets the v1 handshake', () => withWebCrypto(async () => {
  const server = new FakeE2eServer('tok', 1);
  const { socket, auth } = await encryptedHandshake(server);
  assert.equal(auth.params.e2e, 1);
  assert.equal(server.negotiated, 1);

  const pending = wsClient.listSessions();
  await until(() => socket.sent.length >= 2);
  const req = JSON.parse(await server.open(socket.sent[1]));
  socket.binary(await server.seal(JSON.stringify({ id: req.id, result: [] })));
  assert.deepEqual(await pending, []);
  wsClient.disconnect();
}));

test('the documented error codes are the server\'s, and the client keys on one of them (#337)', async () => {
  // A client that acts on a FAILURE must key on the code, because the message
  // is the server's one sentence for the human — translated, reworded, and in
  // #337's case naming a project. The table in the contract doc is what other
  // clients read, so it has to be the Rust constants, not a copy that drifts.
  const { readFile } = await import('node:fs/promises');
  const doc = await readFile(new URL('../../../docs/requirements/api-contracts/websocket-rpc.md', import.meta.url), 'utf8');
  const rpc = await readFile(new URL('../../../src-tauri/src/server/rpc.rs', import.meta.url), 'utf8');
  const codes = new Map<string, string>();
  for (const [, name, value] of rpc.matchAll(/const (ERR_[A-Z_]+): i32 = (-?\d+);/gu)) codes.set(name!, value!);
  assert.ok(codes.size >= 6, `found the server's codes: ${[...codes.keys()].join(', ')}`);
  const table = doc.slice(doc.indexOf('## Error Format'));
  for (const [name, value] of codes) {
    assert.ok(table.includes(`\`${value}\``), `${name} = ${value} is missing from the error table in websocket-rpc.md`);
  }
  // And the ones the client acts on are the same numbers on both sides.
  assert.equal(codes.get('ERR_SCRATCH_HELD'), '-32010');
  assert.equal(codes.get('ERR_SCRATCH_STALE'), '-32011');
  assert.equal(codes.get('ERR_AUTH'), '-32000');
  const client = await readFile(new URL('./rpc-codes.ts', import.meta.url), 'utf8');
  assert.match(client, /export const ERR_SCRATCH_HELD = -32010;/u, 'rpc-codes.ts mirrors it for the panel');
  assert.match(client, /export const ERR_SCRATCH_STALE = -32011;/u, 'and the one the panel RECOVERS from');
  assert.match(client, /export const ERR_AUTH = -32000;/u, 'and the refusal the reconnect loop stops on (#393)');
  // And it is NOT in ws.ts itself: every mount fixture mocks that module, so
  // a code defined there reads as undefined in a test and the feature keyed
  // on it looks disabled (#337 — this is how the release action first failed).
  const ws = await readFile(new URL('./ws.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(ws, /export const ERR_[A-Z_]+ =/u, 'codes live outside the mocked surface');
  assert.match(ws, /export \{ ERR_SCRATCH_HELD, ERR_SCRATCH_STALE \} from '\.\/rpc-codes\.ts';/u, 're-exported, so callers have one import');
});
