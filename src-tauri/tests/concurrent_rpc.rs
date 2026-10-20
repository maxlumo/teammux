//! Integration tests for the concurrent WS RPC refactor.
//!
//! Each test spins up a real `handle_connection` on a loopback TCP socket,
//! drives it through a tokio-tungstenite client, and checks that:
//!   - requests issued in parallel come back in parallel (not serialized)
//!   - encrypted payloads decrypt cleanly across many concurrent requests
//!     (i.e. the send-cipher counter never reorders)
//!
//! Notes:
//!   - We speak the full encrypted handshake (server_nonce → client_nonce +
//!     HMAC proof → AES-GCM session), so these tests also exercise the
//!     InitCipher / Plain / Encrypted funnel end-to-end.
//!   - The tests don't touch tmux or fs; they hit the `ping` RPC, which is
//!     handled synchronously inside handle_request and runs on the
//!     blocking threadpool. Concurrency is visible as overlapping latency.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use tmux_mobile::agent_notifications::AgentNotificationHub;
use tmux_mobile::server::{
    decode_wire_payload, derive_session_keys, handle_connection, ConnContext, AuthTracker, ResizeTracker,
    ResizeTrackerInner, E2E_VERSION,
};

// --- Test harness ---

/// This crate is built WITHOUT `cfg(test)` on the library, so the lib's
/// test-process config dir does not apply here; `AgentNotificationHub::load()`
/// would resolve to the operator's real `~/.config/tmux-mobile`. Point the
/// XDG door — the one config-dir override the app has — at a temp dir once
/// per process (board #216). Set before any config read; the tests here run
/// in one process and this is the first thing each server does.
fn isolate_config_dir() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // Per process, earlier runs' dirs reclaimed (board #268).
        let dir = tmux_mobile::config::fresh_process_dir("tmm-itest-config");
        std::env::set_var("XDG_CONFIG_HOME", &dir);
    });
}

/// Spin up a one-shot server on a loopback port, return (addr, token).
/// Accepts exactly one connection and then stops (enough for a single
/// test client).
async fn spawn_server_once(token: &str) -> SocketAddr {
    isolate_config_dir();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let token = Arc::new(token.to_string());
    let machine_id = Arc::new("test-machine".to_string());
    let auth_tracker: AuthTracker = Arc::new(Mutex::new(HashMap::new()));
    let resize_tracker: ResizeTracker =
        Arc::new(std::sync::Mutex::new(ResizeTrackerInner::default()));

    tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => break,
            };
            let ctx = ConnContext {
                token: token.clone(),
                machine_id: machine_id.clone(),
                auth_tracker: auth_tracker.clone(),
                resize_tracker: resize_tracker.clone(),
                // grace=0 keeps test teardown synchronous (no lingering timer tasks).
                grace_secs: 0,
                notifications: Arc::new(AgentNotificationHub::load()),
                endpoint: Arc::new(serde_json::json!({})),
            };
            tokio::spawn(handle_connection(stream, peer, ctx));
        }
    });
    addr
}

/// Performs the encrypted handshake: receives server_nonce, derives the
/// session key, sends client_nonce + proof, verifies the encrypted auth
/// response, and returns two `Aes256Gcm` ciphers (send / recv) + their
/// counters.
struct Client {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
    send_cipher: Aes256Gcm,
    send_counter: u64,
    recv_cipher: Aes256Gcm,
    recv_counter: u64,
}

fn derive_key(token: &str, server_nonce: &[u8; 16], client_nonce: &[u8; 16]) -> [u8; 32] {
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(server_nonce);
    salt[16..].copy_from_slice(client_nonce);
    let hk = Hkdf::<Sha256>::new(Some(&salt), token.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(b"tmux-mobile-e2e", &mut key).unwrap();
    key
}

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .filter_map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn make_nonce(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

impl Client {
    /// The v1 handshake: what every client shipped before the direction keys
    /// speaks. Kept as the default so the whole suite doubles as the proof
    /// that a v1 client is still served.
    async fn connect(addr: SocketAddr, token: &str) -> Self {
        Self::connect_with(addr, token, 1).await
    }

    async fn connect_with(addr: SocketAddr, token: &str, version: u64) -> Self {
        let url = format!("ws://{}/", addr);
        let (mut ws, _) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws connect");

        // Step 1: receive server_nonce. The server advertises the newest
        // handshake it speaks; a v2-capable client asks for it explicitly.
        let msg = ws.next().await.expect("no msg").expect("recv error");
        let text = match msg {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text, got {:?}", other),
        };
        let v: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_eq!(v["e2e"].as_u64(), Some(E2E_VERSION), "server advertises its E2E version");
        let server_nonce_hex = v["server_nonce"].as_str().expect("server_nonce");
        let server_nonce_vec = hex_decode(server_nonce_hex);
        let mut server_nonce = [0u8; 16];
        server_nonce.copy_from_slice(&server_nonce_vec);

        // Step 2: compute client nonce + proof, derive the session keys.
        // v1: one key for the proof and both directions. v2: three keys.
        let client_nonce: [u8; 16] = rand::random();
        let (proof_key, send_key, recv_key) = if version == E2E_VERSION {
            let k = derive_session_keys(token, &server_nonce, &client_nonce);
            (k.proof, k.c2s, k.s2c)
        } else {
            let k = derive_key(token, &server_nonce, &client_nonce);
            (k, k, k)
        };
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&proof_key).unwrap();
        mac.update(&server_nonce);
        mac.update(&client_nonce);
        let proof = mac.finalize().into_bytes();

        // Step 3: send auth (a v1 client has no `e2e` field at all)
        let mut params = serde_json::json!({
            "client_nonce": hex_encode(&client_nonce),
            "proof": hex_encode(&proof),
        });
        if version == E2E_VERSION {
            params["e2e"] = serde_json::json!(E2E_VERSION);
        }
        let auth = serde_json::json!({ "method": "auth", "params": params });
        ws.send(Message::Text(serde_json::to_string(&auth).unwrap().into()))
            .await
            .unwrap();

        // Step 4: receive encrypted auth response. The server sends encrypted
        // payloads as BINARY frames whose plaintext is a wire-framing byte +
        // (optionally deflated) JSON — NOT base64 text. See server.rs send_task.
        let msg = ws.next().await.expect("no msg").expect("recv");
        let ct = match msg {
            Message::Binary(b) => b.to_vec(),
            other => panic!("expected encrypted binary frame, got {:?}", other),
        };
        let recv_cipher = Aes256Gcm::new_from_slice(&recv_key).unwrap();
        let wire = recv_cipher
            .decrypt(Nonce::from_slice(&make_nonce(0)), ct.as_ref())
            .expect("decrypt auth resp");
        let json = decode_wire_payload(&wire).expect("wire decode");
        let resp: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(resp["result"]["authenticated"].as_bool().unwrap_or(false));
        assert_eq!(resp["result"]["e2e"].as_u64(), Some(version), "server echoes the negotiated version");
        // Board #368: the login answer says which build this server is, in the
        // encrypted answer too, and a client parses it back whole.
        assert_eq!(resp["result"]["build"], tmux_mobile::build_info::json(), "the sealed login answer carries the build");
        assert_eq!(resp["result"]["caps"], serde_json::json!(["board_dispatch", "spawn_join", "agent_team"]), "the sealed login answer announces what the server can do (board #377; spawn_join #382; agent_team #384)");
        assert_eq!(tmux_mobile::build_info::parse(&resp["result"]), Some(tmux_mobile::build_info::Build::ours()));

        Self {
            ws,
            send_cipher: Aes256Gcm::new_from_slice(&send_key).unwrap(),
            send_counter: 0,
            recv_cipher,
            recv_counter: 1, // server already burned counter 0 on the auth response
        }
    }

    async fn send_rpc(&mut self, id: u64, method: &str) {
        let req = serde_json::json!({"id": id, "method": method, "params": {}});
        let json = serde_json::to_string(&req).unwrap();
        let nonce = make_nonce(self.send_counter);
        self.send_counter += 1;
        let ct = self
            .send_cipher
            .encrypt(Nonce::from_slice(&nonce), json.as_bytes())
            .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&ct);
        self.ws.send(Message::Text(b64.into())).await.unwrap();
    }

    async fn recv_response(&mut self) -> serde_json::Value {
        // Skip server keepalive PINGs — they can arrive interleaved with RPC
        // responses and are not part of the encrypted stream.
        let ct = loop {
            let msg = self.ws.next().await.expect("no msg").expect("recv");
            match msg {
                Message::Binary(b) => break b.to_vec(),
                Message::Ping(_) | Message::Pong(_) => continue,
                other => panic!("unexpected msg: {:?}", other),
            }
        };
        let nonce = make_nonce(self.recv_counter);
        self.recv_counter += 1;
        let wire = self
            .recv_cipher
            .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
            .expect("decrypt rpc resp — counter misalignment?");
        let json = decode_wire_payload(&wire).expect("wire decode");
        serde_json::from_str(&json).expect("json")
    }
}

// --- Tests ---

#[tokio::test]
async fn concurrent_pings_decrypt_cleanly() {
    // Simulates the main post-refactor risk: many RPCs fired at once must
    // all come back AND must each decrypt — which they can only do if the
    // server's send_cipher counter advances in the same order the client's
    // recv_cipher counter does.
    let addr = spawn_server_once("test-token-1").await;
    let mut client = Client::connect(addr, "test-token-1").await;

    const N: u64 = 20;
    for i in 1..=N {
        client.send_rpc(i, "ping").await;
    }

    let mut ids_seen = std::collections::HashSet::new();
    for _ in 0..N {
        let v = client.recv_response().await;
        let id = v["id"].as_u64().expect("id in response");
        assert_eq!(v["result"].as_str(), Some("pong"));
        assert!(
            ids_seen.insert(id),
            "duplicate response id {}",
            id
        );
    }
    assert_eq!(ids_seen.len() as u64, N);
}

#[tokio::test]
async fn concurrent_pings_do_not_serialize() {
    // If the server were still serial, N pings would take at least N * per-RPC
    // latency. We expect them to overlap — total wall time should be well
    // below the serial-case lower bound. Ping is in-process (no tmux), so
    // per-RPC is microseconds; we can't meaningfully assert speedup. Instead
    // we assert that responses start arriving before we've finished sending.
    let addr = spawn_server_once("test-token-2").await;
    let mut client = Client::connect(addr, "test-token-2").await;

    const N: u64 = 50;
    let start = Instant::now();
    for i in 1..=N {
        client.send_rpc(i, "ping").await;
    }
    let send_done = start.elapsed();

    for _ in 0..N {
        let _ = client.recv_response().await;
    }
    let total = start.elapsed();

    // The primary assertion: everything came back.
    // Secondary: total stays well within a generous budget. If the server
    // truly serialized against heavy RPCs this still passes (pings are
    // trivial) — the stronger guarantee is the "decrypt cleanly" test,
    // which actually catches reordering bugs.
    println!(
        "send {} pings in {:?}, total round-trip {:?}",
        N, send_done, total
    );
    assert!(
        total < Duration::from_secs(5),
        "50 pings took {:?}, something is very wrong",
        total
    );
}

#[tokio::test]
async fn responses_may_interleave_but_id_matches() {
    // Since business tasks now run concurrently, response id ordering is not
    // guaranteed. The client MUST match responses by id, not arrival order.
    // Here we verify that every id we sent comes back exactly once, even if
    // not in request order.
    let addr = spawn_server_once("test-token-3").await;
    let mut client = Client::connect(addr, "test-token-3").await;

    let mut sent: Vec<u64> = (1..=30).collect();
    for &i in &sent {
        client.send_rpc(i, "ping").await;
    }

    let mut seen: Vec<u64> = Vec::new();
    for _ in 0..sent.len() {
        let v = client.recv_response().await;
        seen.push(v["id"].as_u64().unwrap());
    }

    sent.sort();
    let mut seen_sorted = seen.clone();
    seen_sorted.sort();
    assert_eq!(seen_sorted, sent, "every request id should come back exactly once");
}

#[tokio::test]
async fn client_counter_mismatch_fails_decrypt() {
    // Meta-test: confirms the harness actually notices counter
    // desynchronization. We grab one encrypted response, then try to
    // decrypt it with the wrong counter and expect AES-GCM to reject it.
    // This is what the real tests rely on to catch server-side reordering.
    let addr = spawn_server_once("test-token-4").await;
    let mut client = Client::connect(addr, "test-token-4").await;
    client.send_rpc(1, "ping").await;

    let ct = loop {
        let msg = client.ws.next().await.unwrap().unwrap();
        match msg {
            Message::Binary(b) => break b.to_vec(),
            Message::Ping(_) | Message::Pong(_) => continue,
            other => panic!("expected binary frame, got {:?}", other),
        }
    };

    // Note: ct here is the AES-GCM ciphertext of the wire payload (framing
    // byte + JSON). We only check that GCM authentication keys off the nonce
    // counter — we don't decode the wire payload, so deflate is irrelevant.
    // Correct counter (1) would succeed; wrong counter (99) must fail.
    let wrong_nonce = make_nonce(99);
    let result = client.recv_cipher.decrypt(Nonce::from_slice(&wrong_nonce), ct.as_ref());
    assert!(result.is_err(), "decrypt with bad counter should fail");

    // And the correct counter still works — proves we didn't mangle the ciphertext.
    let right_nonce = make_nonce(client.recv_counter);
    let result = client.recv_cipher.decrypt(Nonce::from_slice(&right_nonce), ct.as_ref());
    assert!(result.is_ok(), "decrypt with correct counter should succeed");
}

#[tokio::test]
async fn slow_rpc_does_not_block_fast_rpc() {
    // This is the test that would fail if we reverted to the serial
    // handle_request-and-send loop. We fire one fs_download of a
    // sizable file (so the server blocks on read + base64 for a
    // moment) plus several pings right after. With the concurrent
    // refactor a ping response must arrive BEFORE the download
    // response. With the old serial loop it would arrive after.
    use tokio::io::AsyncWriteExt;

    let addr = spawn_server_once("test-token-5").await;
    let mut client = Client::connect(addr, "test-token-5").await;

    // Create a ~4 MB temp file — big enough that base64 + write takes
    // measurable time, small enough to stay under fs::MAX_READ_SIZE.
    // Inside this process's config dir, so a panic leaves it for the next
    // run's reclaim rather than in the shared temp root.
    let tmp = std::path::PathBuf::from(std::env::var_os("XDG_CONFIG_HOME").unwrap()).join("slow_rpc_test.bin");
    {
        let mut f = tokio::fs::File::create(&tmp).await.unwrap();
        let chunk = vec![0u8; 64 * 1024];
        for _ in 0..64 {
            f.write_all(&chunk).await.unwrap();
        }
        f.sync_all().await.unwrap();
    }
    let tmp_path = tmp.to_string_lossy().to_string();

    // id=1 download, id=2..=5 pings
    let req = serde_json::json!({"id": 1, "method": "fs_download", "params": {"path": tmp_path}});
    let json = serde_json::to_string(&req).unwrap();
    let nonce = make_nonce(client.send_counter);
    client.send_counter += 1;
    let ct = client
        .send_cipher
        .encrypt(Nonce::from_slice(&nonce), json.as_bytes())
        .unwrap();
    client
        .ws
        .send(Message::Text(
            base64::engine::general_purpose::STANDARD.encode(&ct).into(),
        ))
        .await
        .unwrap();

    for i in 2..=5u64 {
        client.send_rpc(i, "ping").await;
    }

    // Every arrival, with WHEN. The order alone is not enough to judge: see the
    // inconclusive case below.
    let t0 = std::time::Instant::now();
    let mut arrivals: Vec<(u64, std::time::Duration)> = Vec::new();
    for _ in 0..5 {
        let v = client.recv_response().await;
        arrivals.push((v["id"].as_u64().unwrap(), t0.elapsed()));
    }

    // Clean up before asserting so a failed assert doesn't leak the file.
    let _ = tokio::fs::remove_file(&tmp).await;

    let download = arrivals.iter().find(|(id, _)| *id == 1).map(|(_, at)| *at).unwrap();
    let first_ping = arrivals.iter().filter(|(id, _)| *id != 1).map(|(_, at)| *at).min().unwrap();

    // The property: a ping does not have to WAIT for the download. A serial
    // server could only answer the pings after it finished the download, because
    // the download was requested first.
    if first_ping < download {
        return; // concurrency observed
    }

    // The download's frame came first, and that does NOT prove serialization —
    // which is why this test may not assert on it. Measured here, 2026-08-20:
    //
    //   download  507.6 ms
    //   ping      508.6 ms   (1 ms later)
    //   pings     557.0 ms   ×3
    //
    // The download response is ~5.3 MB of base64, and the client reads frames
    // sequentially: whatever the server WROTE first is all we can observe, and the
    // 1 ms gap says the pings were already sitting in the socket buffer behind that
    // one huge frame. A concurrent server that simply finished the 4 MB read before
    // it parsed the pings (the file is in page cache) looks exactly like a serial
    // one from here. Asserting on the order anyway is what made this test fail
    // about two runs in three on a loaded host with nothing in the concurrency path
    // touched, and cost a reader real time deciding whether their change broke it
    // (docs/todo.md §F, 2026-08-19).
    //
    // So this test PROVES concurrency when it sees it and reports inconclusive
    // otherwise. A one-directional prover that never cries wolf is worth more than
    // a coin-flip assertion people learn to ignore; the day someone reverts to the
    // serial loop, the pings can never come back first and this can never pass its
    // early return again on a quiet machine.
    eprintln!(
        "inconclusive: the download's frame ({download:?}) preceded every ping \
         (first at {first_ping:?}), which a concurrent server does too — arrivals: {arrivals:?}"
    );
}

// --- E2E v2: one key per direction ---

#[tokio::test]
async fn v2_handshake_round_trips_with_direction_keys() {
    // A client that asks for v2 proves with the proof key, sends under c2s,
    // and reads under s2c. If the server derived any of the three
    // differently, either the proof is rejected or a decrypt fails here.
    let addr = spawn_server_once("test-token-v2").await;
    let mut client = Client::connect_with(addr, "test-token-v2", E2E_VERSION).await;
    client.send_rpc(1, "ping").await;
    let v = client.recv_response().await;
    assert_eq!(v["id"].as_u64(), Some(1));
    assert_eq!(v["result"].as_str(), Some("pong"));
}

#[tokio::test]
async fn v1_client_is_still_served_after_v2() {
    // The pre-v2 client: no `e2e` in its auth params, one key everywhere.
    // The server must keep speaking v1 to it and say so in the result.
    let addr = spawn_server_once("test-token-v1").await;
    let mut client = Client::connect_with(addr, "test-token-v1", 1).await;
    client.send_rpc(1, "ping").await;
    let v = client.recv_response().await;
    assert_eq!(v["result"].as_str(), Some("pong"));
}

#[tokio::test]
async fn v2_proof_is_rejected_when_the_client_did_not_ask_for_v2() {
    // The version is the CLIENT's request: a proof computed with the v2
    // proof key but sent without `e2e: 2` must fail, because the server then
    // verifies with the v1 key. Guards against a server that silently tries
    // both derivations (which would let the field lie about the cipher keys).
    let addr = spawn_server_once("test-token-v2x").await;
    let url = format!("ws://{}/", addr);
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let msg = ws.next().await.unwrap().unwrap();
    let text = match msg { Message::Text(t) => t.to_string(), _ => panic!("text expected") };
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let mut server_nonce = [0u8; 16];
    server_nonce.copy_from_slice(&hex_decode(v["server_nonce"].as_str().unwrap()));
    let client_nonce: [u8; 16] = rand::random();
    let k = derive_session_keys("test-token-v2x", &server_nonce, &client_nonce);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&k.proof).unwrap();
    mac.update(&server_nonce);
    mac.update(&client_nonce);
    let proof = mac.finalize().into_bytes();
    let auth = serde_json::json!({"method": "auth", "params": {
        "client_nonce": hex_encode(&client_nonce), "proof": hex_encode(&proof)}});
    ws.send(Message::Text(serde_json::to_string(&auth).unwrap().into())).await.unwrap();
    match ws.next().await.unwrap().unwrap() {
        Message::Text(t) => {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            assert!(v["error"].is_object(), "expected rejection, got {:?}", v);
        }
        other => panic!("unexpected frame: {:?}", other),
    }
}

#[tokio::test]
async fn auth_proof_must_bind_client_nonce() {
    // Regression guard for the R2 hardening: a proof computed only over
    // server_nonce (the previous formula) must be rejected. This ensures
    // the server really requires the new commitment over both nonces.
    let addr = spawn_server_once("test-token-6").await;
    let url = format!("ws://{}/", addr);
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // Receive server_nonce
    let msg = ws.next().await.unwrap().unwrap();
    let text = match msg {
        Message::Text(t) => t.to_string(),
        _ => panic!("text expected"),
    };
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let server_nonce_hex = v["server_nonce"].as_str().unwrap();
    let server_nonce_vec = hex_decode(server_nonce_hex);
    let mut server_nonce = [0u8; 16];
    server_nonce.copy_from_slice(&server_nonce_vec);

    // Build a proof using the OLD formula (server_nonce only).
    let client_nonce: [u8; 16] = rand::random();
    let key = derive_key("test-token-6", &server_nonce, &client_nonce);
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).unwrap();
    mac.update(&server_nonce);
    // NOTE: deliberately NOT updating with client_nonce.
    let bad_proof = mac.finalize().into_bytes();

    let auth = serde_json::json!({
        "method": "auth",
        "params": {
            "client_nonce": hex_encode(&client_nonce),
            "proof": hex_encode(&bad_proof),
        }
    });
    ws.send(Message::Text(serde_json::to_string(&auth).unwrap().into()))
        .await
        .unwrap();

    // Expect an error response + a close; server rejects the proof.
    let resp = ws.next().await.unwrap().unwrap();
    match resp {
        Message::Text(t) => {
            let v: serde_json::Value = serde_json::from_str(&t).unwrap();
            assert!(v["error"].is_object(), "expected error, got {:?}", v);
            let msg = v["error"]["message"].as_str().unwrap_or("");
            assert!(
                msg.contains("proof") || msg.contains("auth"),
                "unexpected error message: {}",
                msg
            );
        }
        other => panic!("unexpected frame: {:?}", other),
    }
}

// --- WebSocket protocol-level keepalive ---

/// Minimal test client that speaks encrypted auth, grabs its cipher, and
/// then lets the caller drive inbound/outbound WS frames directly. Used for
/// keepalive tests that care about PING/PONG at the WS layer, not the
/// higher-level RPC behavior.
async fn raw_authed_client(
    addr: SocketAddr,
    token: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>> {
    // Reuse Client::connect for the handshake, then pull its ws out.
    let c = Client::connect(addr, token).await;
    c.ws
}

#[tokio::test]
async fn server_sends_ws_pings_that_auto_pong() {
    // Integration sanity: within one PING_INTERVAL_SECS window, at least
    // one Message::Ping must arrive from the server. tokio-tungstenite
    // auto-replies with Pong at the stream level on the next poll, so
    // steady-state we don't see ourselves miss a heartbeat.
    //
    // NB: we intentionally don't have a companion test for "server drops
    // an unresponsive peer" at this layer — tokio-tungstenite auto-
    // responds to inbound Pings on behalf of the application, so any
    // pure-Rust test client does pong whether we ask it to or not.
    // That failure mode (client's Pong never makes it back through a
    // half-open TCP connection) would need platform-level network
    // fault injection; we rely on code review + manual testing for it.
    let addr = spawn_server_once("test-token-keepalive").await;
    let mut ws = raw_authed_client(addr, "test-token-keepalive").await;

    let mut saw_ping = false;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(18) {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Ping(data)))) => {
                saw_ping = true;
                ws.send(Message::Pong(data)).await.unwrap();
                break;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => panic!("ws error: {:?}", e),
            Ok(None) => panic!("connection closed unexpectedly"),
            Err(_) => {}
        }
    }
    assert!(saw_ping, "server did not send a WS PING within 18s");
}

/// Minimal plain-text client — no encrypted handshake, just the legacy
/// token path. Used to verify that http:// clients (where `crypto.subtle`
/// is unavailable) still get post-auth RPC responses.
struct PlainClient {
    ws: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
}

impl PlainClient {
    async fn connect(addr: SocketAddr, token: &str) -> Self {
        let url = format!("ws://{}/", addr);
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

        // Drain server_nonce (we ignore it and auth with plain token).
        let _ = ws.next().await.unwrap().unwrap();

        let auth = serde_json::json!({"method": "auth", "params": {"token": token}});
        ws.send(Message::Text(serde_json::to_string(&auth).unwrap().into()))
            .await
            .unwrap();

        // Expect a plain-text auth OK.
        let msg = ws.next().await.unwrap().unwrap();
        let text = match msg {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text, got {:?}", other),
        };
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["result"]["authenticated"].as_bool(), Some(true), "plain auth failed: {}", text);
        assert_eq!(v["result"]["build"], tmux_mobile::build_info::json(), "the plain login answer carries the build");
        assert_eq!(v["result"]["caps"], serde_json::json!(["board_dispatch", "spawn_join", "agent_team"]), "the plain login answer announces what the server can do (board #377; spawn_join #382; agent_team #384)");

        Self { ws }
    }

    async fn send_rpc(&mut self, id: u64, method: &str) {
        let req = serde_json::json!({"id": id, "method": method, "params": {}});
        self.ws.send(Message::Text(serde_json::to_string(&req).unwrap().into()))
            .await.unwrap();
    }

    async fn recv(&mut self) -> serde_json::Value {
        // Response is plain text (no encryption in plain-token mode).
        let msg = self.ws.next().await.unwrap().unwrap();
        let text = match msg {
            Message::Text(t) => t.to_string(),
            other => panic!("expected text, got {:?}", other),
        };
        serde_json::from_str(&text).unwrap()
    }
}

#[tokio::test]
async fn plain_token_auth_delivers_rpc_responses() {
    // Regression for 'send [...]: Encrypted before InitCipher — dropped'.
    // After plain-token auth the server's send cipher is intentionally not
    // initialized; previously this caused every subsequent Outbound::Encrypted
    // (i.e. any post-auth RPC response) to be dropped and the client would
    // see a dead connection. With the plain fallback in the send task,
    // responses should flow in cleartext.
    let addr = spawn_server_once("plain-test-token").await;
    let mut c = PlainClient::connect(addr, "plain-test-token").await;
    c.send_rpc(42, "ping").await;
    let resp = tokio::time::timeout(Duration::from_secs(3), c.recv())
        .await
        .expect("timed out waiting for ping response — the response was likely dropped by send_task");
    assert_eq!(resp["id"].as_u64(), Some(42));
    assert_eq!(resp["result"].as_str(), Some("pong"));
}


/// Before auth a peer has proven nothing, so its frame budget is small: a
/// text frame over the pre-auth cap closes the connection instead of being
/// parsed. (The 80 MB allowance is for an authenticated `fs_upload`.)
#[tokio::test]
async fn an_oversized_frame_before_auth_closes_the_connection() {
    let addr = spawn_server_once("preauth-cap-token").await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/", addr)).await.unwrap();
    let _nonce = ws.next().await.unwrap().unwrap();
    // A syntactically plausible auth request padded past 8 KB.
    let padded = serde_json::json!({"method": "auth", "params": {"token": "x".repeat(9 * 1024)}});
    ws.send(Message::Text(serde_json::to_string(&padded).unwrap().into())).await.unwrap();
    let next = tokio::time::timeout(Duration::from_secs(3), ws.next())
        .await
        .expect("server should have closed the connection, not kept reading");
    let closed = match next {
        None => true,
        Some(Ok(Message::Close(_))) => true,
        Some(Err(_)) => true,
        Some(Ok(other)) => panic!("expected close, got a frame: {other:?}"),
    };
    assert!(closed);
    // And the same request under the cap is still parsed (rejected as a bad
    // token, which proves it reached the auth handler).
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{}/", addr)).await.unwrap();
    let _nonce = ws.next().await.unwrap().unwrap();
    let small = serde_json::json!({"method": "auth", "params": {"token": "wrong"}});
    ws.send(Message::Text(serde_json::to_string(&small).unwrap().into())).await.unwrap();
    let reply = tokio::time::timeout(Duration::from_secs(3), ws.next()).await.unwrap().unwrap().unwrap();
    let text = reply.into_text().unwrap();
    assert!(text.contains("error"), "small frame must reach the auth handler: {text}");
}
