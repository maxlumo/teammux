//! One client connection: WS accept (with the HTTP download peel-off),
//! auth + optional E2E handshake, the request/push pump, heartbeat, and
//! the per-subscription capture loop. Split from server.rs 2026-07-22 —
//! content unchanged.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::{accept_async_with_config, tungstenite::Message, tungstenite::protocol::WebSocketConfig};

use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;

use crate::tmux;

use super::download::handle_http_download;
use super::rpc::{handle_request, handle_subscribe, handle_unsubscribe, Request, Response, Subscriptions, ERR_AUTH, ERR_INTERNAL, ERR_PARSE};
use super::wire::{bytes_to_hex, decode_wire_payload, derive_key, derive_session_keys, encode_wire_payload, hex_to_bytes, provided_token_matches, HalfCipher, E2E_VERSION};
use super::{AuthTracker, NotificationHub, Outbound, ResizeTracker,
    AUTH_LOCKOUT_SECS, AUTH_TRACKER_GC_AFTER_SECS, CONN_ID_COUNTER, MAX_AUTH_FAILURES,
    MAX_CAPTURE_FAILURES, SUBSCRIPTION_POLL_MS};

const WS_MAX_MESSAGE_BYTES: usize = 80 * 1024 * 1024;
const WS_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Before auth a peer has proven nothing, so it gets a small budget: the
/// handshake is two frames of a few hundred bytes, and a connection that has
/// not authenticated within the deadline is closed. Without these, N idle
/// sockets each hold a connection's tasks and an 80 MB message allowance on a
/// port that listens on 0.0.0.0 by default.
const PRE_AUTH_MAX_MESSAGE_BYTES: usize = 8 * 1024;
const AUTH_DEADLINE_SECS: u64 = 10;

/// Configure aggressive TCP keepalive on a freshly accepted connection.
///
/// Why: home routers / cellular NAT gateways drop "idle" TCP entries from
/// their state tables after as little as ~30 s. Without keepalive the next
/// packet hits a dropped entry, the gateway sends RST, and the WebSocket
/// dies with a 1006 abnormal close (ECONNRESET on the server side).
///
/// We already have a 15 s WebSocket PING — but that runs in user space and
/// may queue behind other traffic, drift past 30 s in adverse scheduling,
/// or fail to reach the gateway when buffered. TCP keepalive is a kernel
/// timer emitting empty ACK packets that **always** count as activity to
/// stateful firewalls. Combining both is a small belt-and-suspenders.
///
/// Tunables:
///   IDLE = 20 s — start sending probes after 20 s without any data on
///                 the socket. Far below the typical 30–60 s NAT idle
///                 threshold.
///   INTERVAL = 5 s — probe every 5 s if the first one didn't ack.
///   COUNT = OS default (typically 3–9). The connection is considered
///          dead after IDLE + INTERVAL × COUNT, so ~35 s worst case.
pub(super) fn enable_tcp_keepalive(stream: &TcpStream) {
    use socket2::{SockRef, TcpKeepalive};
    let ka = TcpKeepalive::new()
        .with_time(std::time::Duration::from_secs(20))
        .with_interval(std::time::Duration::from_secs(5));
    let sock = SockRef::from(stream);
    if let Err(e) = sock.set_tcp_keepalive(&ka) {
        eprintln!("⚠️  failed to enable TCP keepalive: {}", e);
    }
}

pub(super) fn ws_config() -> WebSocketConfig {
    let mut cfg = WebSocketConfig::default();
    cfg.max_message_size = Some(WS_MAX_MESSAGE_BYTES);
    cfg.max_frame_size = Some(WS_MAX_FRAME_BYTES);
    cfg
}

async fn subscription_loop(
    out_tx: tokio::sync::mpsc::UnboundedSender<Outbound>,
    subs: Subscriptions,
    snapshots_inflight: Arc<std::sync::atomic::AtomicUsize>,
) {
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(SUBSCRIPTION_POLL_MS));
    let mut fail_counts: HashMap<String, u32> = HashMap::new();
    loop {
        interval.tick().await;
        // Backpressure: latest-frame-wins. While a previous snapshot is still
        // queued or being written to a slow socket, skip the whole tick —
        // don't even run the tmux captures. The next tick after the link
        // drains captures *current* content, so the client always converges
        // on the freshest frame instead of replaying a backlog of stale ones.
        if snapshots_inflight.load(std::sync::atomic::Ordering::Acquire) > 0 {
            continue;
        }
        let targets: Vec<(String, String)> = {
            let map = subs.lock().await;
            map.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        };
        if targets.is_empty() {
            continue;
        }
        for (target, prev) in targets {
            let t = target.clone();
            let t2 = target.clone();
            let (new_content, cursor, trailing_trimmed, current_cmd) = match tokio::task::spawn_blocking(move || {
                // Get cursor first for pane width, then capture content immediately after
                // to minimize race window between the two tmux calls
                let info = tmux::cursor_info_with_cmd(&t2).unwrap_or((0, 0, 24, 80, String::new()));
                let (content, trailing) = tmux::capture_pane_with_width(&t, None, info.3)?;
                // Re-read cursor to get position matching the captured content.
                // Reuse the previous current_cmd — its value rarely flips
                // mid-tick and one tmux call is cheaper than two.
                let info2 = tmux::cursor_info_with_cmd(&t2).unwrap_or(info.clone());
                Ok::<_, String>((content, (info2.0, info2.1, info2.2, info2.3), trailing, info2.4))
            })
            .await
            {
                Ok(Ok(v)) => {
                    fail_counts.remove(&target);
                    v
                }
                _ => {
                    let count = fail_counts.entry(target.clone()).or_insert(0);
                    *count += 1;
                    if *count >= MAX_CAPTURE_FAILURES {
                        subs.lock().await.remove(&target);
                        fail_counts.remove(&target);
                        // Notify client that pane is gone
                        let msg = serde_json::json!({
                            "id": null,
                            "method": "pane_closed",
                            "params": { "target": target }
                        });
                        let _ = out_tx.send(Outbound::Encrypted(serde_json::to_string(&msg).unwrap()));
                    }
                    continue;
                }
            };
            // state_key is only used for change detection; including the
            // current command makes "command changed but content didn't"
            // (rare but possible: `clear` + new shell prompt) a real diff.
            let state_key = format!(
                "{}\x00{},{},{},{}\x00{}",
                new_content, cursor.0, cursor.1, cursor.2, cursor.3, current_cmd
            );
            if state_key == prev {
                continue;
            }
            subs.lock()
                .await
                .insert(target.clone(), state_key);
            let content_changed = !prev.is_empty()
                && prev.split('\x00').next().unwrap_or("") != new_content;
            // Detect command changes by comparing the third \x00-delimited
            // segment. Empty `prev` means first push → always include cmd.
            let prev_cmd = prev.split('\x00').nth(2).unwrap_or("");
            let cmd_changed = prev.is_empty() || prev_cmd != current_cmd;
            // Send raw tmux cursor position + trailing trimmed count for xterm.js row mapping
            let cursor_obj = serde_json::json!({ "x": cursor.0, "y": cursor.1, "w": cursor.3, "h": cursor.2, "t": trailing_trimmed });
            // Only include current_command when it actually changed, to keep
            // the hot path frame ~zero bytes heavier than before.
            let mut params = serde_json::Map::new();
            params.insert("target".into(), serde_json::Value::String(target.clone()));
            if content_changed || prev.is_empty() {
                params.insert("content".into(), serde_json::Value::String(new_content));
            }
            params.insert("cursor".into(), cursor_obj);
            if cmd_changed {
                params.insert("current_command".into(), serde_json::Value::String(current_cmd));
                // The pane's agent rides with every command change (board
                // #260): the terminal's keyboard overlay asks "is this a chat
                // TUI?", and that verdict has ONE definition — the listing's
                // process-derived `TmuxPane::agent` — not a second matcher in
                // the client over a process name. Once per change, not per frame.
                let t = target.clone();
                let agent = tokio::task::spawn_blocking(move || tmux::pane_agent(&t)).await.ok().flatten();
                params.insert("agent".into(), agent.map_or(serde_json::Value::Null, |a| serde_json::Value::String(a.into())));
            }
            let msg = serde_json::json!({
                "id": null,
                "method": "pane_output",
                "params": params,
            });
            // Increment BEFORE send: the send task decrements after the
            // frame hits the socket, so the counter can never be observed
            // at 0 while a snapshot is actually pending.
            snapshots_inflight.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
            if out_tx.send(Outbound::Snapshot(serde_json::to_string(&msg).unwrap())).is_err() {
                snapshots_inflight.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                return; // receiver has shut down
            }
        }
    }
}

/// What every connection shares with the server (board #151): built once at
/// the accept site and cloned per connection — every member is an `Arc` or a
/// `Copy`, so the clone is six pointer bumps. Per-connection facts (`addr`,
/// `conn_id`, the start instant) stay positional: they are minted at
/// different points of the accept path, not shared.
#[derive(Clone)]
pub struct ConnContext {
    pub token: Arc<String>,
    pub machine_id: Arc<String>,
    pub auth_tracker: AuthTracker,
    pub resize_tracker: ResizeTracker,
    pub grace_secs: u64,
    pub notifications: NotificationHub,
}

pub async fn handle_connection(stream: TcpStream, addr: SocketAddr, ctx: ConnContext) {
    dispatch(stream, addr, ctx, false).await
}

/// The one door for a connection, plain or TLS (board #323, `dispatch.rs`):
/// read the request head (bounded), route it, and hand the handler a
/// stream that replays every byte already read.
pub(super) async fn dispatch<S>(mut stream: S, addr: SocketAddr, ctx: ConnContext, tls: bool)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    use super::dispatch::{classify, read_head, Prefixed, Route};
    let (bytes, end) = match read_head(&mut stream).await {
        Ok(h) => h,
        Err(why) => {
            eprintln!("❌ {addr}: {why}");
            return;
        }
    };
    let route = classify(&bytes[..end]);
    let stream = Prefixed::new(bytes, stream);
    match route {
        Route::Download => return handle_http_download(stream, addr, ctx.token).await,
        Route::Static { head, target, accept } => return super::ui::serve(stream, head, &target, &accept).await,
        Route::Bad => return super::ui::bad_request(stream).await,
        Route::WebSocket => {}
    }

    let conn_id = CONN_ID_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let conn_started_at = std::time::Instant::now();
    println!("📱 Client connected{}: {} (conn_id={})", if tls { " (TLS)" } else { "" }, addr, conn_id);

    // Check if IP is locked out, and opportunistically GC old entries so
    // the tracker doesn't grow unbounded under a distributed scan.
    {
        let mut tracker = ctx.auth_tracker.lock().await;
        tracker.retain(|_ip, (_fails, since)| {
            since.elapsed().as_secs() < AUTH_TRACKER_GC_AFTER_SECS
        });
        if let Some((fails, since)) = tracker.get(&addr.ip()) {
            if *fails >= MAX_AUTH_FAILURES && since.elapsed().as_secs() < AUTH_LOCKOUT_SECS {
                eprintln!("🚫 Rejected {} (locked out, {} failures)", addr, fails);
                return;
            }
        }
    }

    let ws_stream = match accept_async_with_config(stream, Some(ws_config())).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("❌ {} handshake failed for {}: {}", if tls { "WSS" } else { "WebSocket" }, addr, e);
            return;
        }
    };

    handle_connection_ws(ws_stream, addr, ctx, conn_id, conn_started_at).await;
}

pub(super) async fn handle_connection_ws<S>(ws_stream: tokio_tungstenite::WebSocketStream<S>, addr: SocketAddr, ctx: ConnContext, conn_id: u64, conn_started_at: std::time::Instant)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ConnContext { token, machine_id, auth_tracker, resize_tracker, grace_secs, notifications } = ctx;
    // Check if IP is locked out
    {
        let tracker = auth_tracker.lock().await;
        if let Some((fails, since)) = tracker.get(&addr.ip()) {
            if *fails >= MAX_AUTH_FAILURES && since.elapsed().as_secs() < AUTH_LOCKOUT_SECS {
                eprintln!("🚫 Rejected {} (locked out, {} failures)", addr, fails);
                return;
            }
        }
    }

    let (ws_sender, mut receiver) = ws_stream.split();
    let subs: Subscriptions = Arc::new(Mutex::new(HashMap::new()));
    // conn_id allocated above so the "connected" log line carries it.
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let mut authenticated = false;
    // hub message-push task (board #107): the project rooms' own broadcast
    // channel, started once right after auth succeeds and aborted on
    // disconnect. Desktop-only, like the store it reads.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(unused_mut))]
    let mut hub_push_handle: Option<tokio::task::JoinHandle<()>> = None;
    // Receive-side cipher lives in this task and guards strict decrypt
    // ordering. Send-side cipher is handed off to the dedicated send task
    // (below) so business tasks can finish out of order without corrupting
    // the encrypt counter.
    let mut recv_cipher: Option<HalfCipher> = None;

    // Outbound channel: every response / push goes through this single
    // consumer, which encrypts (in FIFO) and ws.send()s. That is what lets
    // multiple business tasks run in parallel — they just enqueue strings.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Outbound>();

    // --- Send task ---
    // shutdown: raised if the send task fails. The receiver uses it to
    // break out of ws.recv() promptly so we don't sit in onmessage while
    // responses are silently piling up in the out_rx queue (whose consumer
    // is gone).
    let shutdown = Arc::new(tokio::sync::Notify::new());
    let shutdown_tx = shutdown.clone();
    // Snapshot in-flight counter shared between the subscription loop
    // (producer, increments + skips ticks while > 0) and the send task
    // (consumer, decrements after ws.send resolves).
    let snapshots_inflight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let snapshots_inflight_send = snapshots_inflight.clone();
    let send_task = tokio::spawn(async move {
        let mut ws_sender = ws_sender;
        let mut cipher: Option<HalfCipher> = None;
        while let Some(msg) = out_rx.recv().await {
            let is_snapshot = matches!(msg, Outbound::Snapshot(_));
            let frame = match msg {
                Outbound::Plain(s) => Message::Text(s.into()),
                Outbound::InitCipher(c) => { cipher = Some(c); continue; }
                Outbound::Ping(data) => Message::Ping(data.into()),
                Outbound::Encrypted(s) | Outbound::Snapshot(s) => {
                    if let Some(ref mut c) = cipher {
                        // 1. Frame + (optionally) deflate the JSON.
                        // 2. Encrypt the framed plaintext.
                        // 3. Send as a BINARY WebSocket frame — no base64.
                        // The framing byte rides INSIDE the ciphertext so the
                        // receiver only learns it after decrypting (it's not
                        // sensitive in itself, but keeping it inside avoids
                        // any accidental side-channel where wire size +
                        // tag together leak more than wire size alone).
                        let plaintext = encode_wire_payload(&s);
                        let ciphertext = c.encrypt(&plaintext);
                        Message::Binary(ciphertext.into())
                    } else {
                        // Plain-token fallback (no session cipher). Stays
                        // TEXT + raw JSON — same as before this change. We
                        // never compress here; the path is reserved for
                        // legacy http:// clients without Web Crypto, and
                        // simplicity matters more than bytes.
                        Message::Text(s.into())
                    }
                }
            };
            let send_result = ws_sender.send(frame).await;
            // Decrement regardless of send outcome — on error we break and
            // the connection tears down, but a clean counter avoids the
            // subscription loop spinning on a stale "in flight" forever if
            // teardown is slow.
            if is_snapshot {
                snapshots_inflight_send.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
            }
            if send_result.is_err() {
                break;
            }
        }
        // Channel closed OR ws.send failed. Either way, whoever's still
        // writing to out_tx should stop as soon as possible — tell the
        // receiver to bail.
        shutdown_tx.notify_waiters();
    });

    // Step 1: Send server_nonce (plain, pre-cipher). `e2e` advertises the
    // newest handshake this server speaks; a client that understands it asks
    // for it in its auth params, an older client ignores the field and gets v1.
    let mut server_nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut server_nonce);
    {
        let msg = serde_json::json!({ "server_nonce": bytes_to_hex(&server_nonce), "e2e": E2E_VERSION });
        if out_tx.send(Outbound::Plain(serde_json::to_string(&msg).unwrap())).is_err() {
            return;
        }
    }

    // Start subscription polling task (enqueues to out_tx like any task)
    let sub_handle = tokio::spawn(subscription_loop(out_tx.clone(), subs.clone(), snapshots_inflight.clone()));

    // Start keepalive: server sends WS PING every 15s; browsers auto-reply
    // with PONG in the WS layer without running app code, so this probes
    // TCP liveness without contending for the encrypt/send mutex. If we
    // haven't seen a PONG in PING_DEADLINE_SECS, assume the link is dead
    // and tell the connection to tear down.
    let last_pong_at = Arc::new(std::sync::Mutex::new(std::time::Instant::now()));
    const PING_INTERVAL_SECS: u64 = 15;
    const PING_DEADLINE_SECS: u64 = 45;
    let ping_handle = {
        let out_tx = out_tx.clone();
        let last_pong_at = last_pong_at.clone();
        let shutdown_for_ping = shutdown.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(PING_INTERVAL_SECS));
            tick.tick().await; // discard immediate first tick
            loop {
                tick.tick().await;
                let elapsed = last_pong_at.lock().unwrap().elapsed().as_secs();
                if elapsed > PING_DEADLINE_SECS {
                    eprintln!("💀 ping deadline exceeded ({}s > {}s) conn_id={}; tearing down", elapsed, PING_DEADLINE_SECS, conn_id);
                    shutdown_for_ping.notify_waiters();
                    return;
                }
                if out_tx.send(Outbound::Ping(b"hb".to_vec())).is_err() {
                    return; // send task gone
                }
            }
        })
    };

    let auth_deadline = tokio::time::sleep(std::time::Duration::from_secs(AUTH_DEADLINE_SECS));
    tokio::pin!(auth_deadline);
    while let Some(msg) = tokio::select! {
        m = receiver.next() => m,
        _ = shutdown.notified() => None,  // send task died — tear down
        _ = &mut auth_deadline, if !authenticated => {
            eprintln!("⏱️  no auth within {}s from {} conn_id={}; closing", AUTH_DEADLINE_SECS, addr, conn_id);
            None
        }
    } {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                // Annotate with conn_id + how long the connection had been
                // up. This is the path that fires on TCP RST / network
                // teardown; the "uptime" number is the most useful clue
                // when chasing NAT-dropped sessions.
                let up = conn_started_at.elapsed().as_secs();
                eprintln!(
                    "❌ Read error from {} (conn_id={}, authed={}, up={}s): {}",
                    addr, conn_id, authenticated, up, e
                );
                break;
            }
        };

        // Resolve every data-frame variant to plaintext JSON, then run the
        // existing request pipeline below. Control frames (Close/Ping/Pong)
        // fall through to the inner match.
        let plaintext: Option<String> = match &msg {
            Message::Text(text) => {
                if !authenticated && text.len() > PRE_AUTH_MAX_MESSAGE_BYTES {
                    eprintln!("❌ {} byte frame before auth from {} conn_id={}; closing", text.len(), addr, conn_id);
                    break;
                }
                if let Some(ref mut rc) = recv_cipher {
                    // Legacy: text + base64-encoded ciphertext + raw JSON
                    // plaintext. Kept for any old clients still using it;
                    // the new wire path goes through Message::Binary.
                    use base64::Engine;
                    let ct = base64::engine::general_purpose::STANDARD.decode(text.as_bytes()).unwrap_or_default();
                    match rc.decrypt(&ct) {
                        Ok(pt) => Some(String::from_utf8_lossy(&pt).to_string()),
                        Err(_) => { eprintln!("❌ Decrypt failed (text path) from {} conn_id={}", addr, conn_id); break; }
                    }
                } else {
                    Some(text.to_string())
                }
            }
            Message::Binary(bytes) => {
                // New wire: binary ciphertext, plaintext = framing byte +
                // (optionally deflated) JSON. Auth must already be set up.
                let Some(rc) = recv_cipher.as_mut() else {
                    eprintln!("❌ Binary frame before auth from {} conn_id={}", addr, conn_id);
                    break;
                };
                match rc.decrypt(bytes) {
                    Ok(pt) => match decode_wire_payload(&pt) {
                        Ok(s) => Some(s),
                        Err(e) => { eprintln!("❌ Wire decode failed from {} conn_id={}: {}", addr, conn_id, e); break; }
                    },
                    Err(_) => { eprintln!("❌ Decrypt failed (binary path) from {} conn_id={} bytes_len={}", addr, conn_id, bytes.len()); break; }
                }
            }
            _ => None,
        };

        if let Some(plaintext) = plaintext {
                let req = match serde_json::from_str::<Request>(&plaintext) {
                    Ok(r) => r,
                    Err(e) => {
                        let r = Response::err(None, ERR_PARSE, format!("invalid JSON: {}", e));
                        let _ = out_tx.send(if recv_cipher.is_some() {
                            Outbound::Encrypted(serde_json::to_string(&r).unwrap())
                        } else {
                            Outbound::Plain(serde_json::to_string(&r).unwrap())
                        });
                        continue;
                    }
                };

                if !authenticated {
                    // Auth must stay strictly serial (it sets up the ciphers).
                    if req.method != "auth" {
                        let r = Response::err(req.id, ERR_AUTH, "auth required — send {\"method\":\"auth\",\"params\":{\"token\":\"...\"}} first".into());
                        let _ = out_tx.send(Outbound::Plain(serde_json::to_string(&r).unwrap()));
                        break;
                    }
                    let client_nonce_hex = req.params.get("client_nonce").and_then(|v| v.as_str()).unwrap_or("");
                    let proof_hex = req.params.get("proof").and_then(|v| v.as_str()).unwrap_or("");
                    let plain_token = req.params.get("token").and_then(|v| v.as_str()).unwrap_or("");

                    if !client_nonce_hex.is_empty() && !proof_hex.is_empty() {
                        // Encrypted auth
                        let client_nonce_bytes = hex_to_bytes(client_nonce_hex).unwrap_or_default();
                        let proof_bytes = hex_to_bytes(proof_hex).unwrap_or_default();
                        if client_nonce_bytes.len() != 16 {
                            let r = Response::err(req.id, ERR_AUTH, "invalid client_nonce".into());
                            let _ = out_tx.send(Outbound::Plain(serde_json::to_string(&r).unwrap()));
                            break;
                        }
                        let mut cn = [0u8; 16];
                        cn.copy_from_slice(&client_nonce_bytes);
                        // The client picks the version it asked for; anything
                        // but an explicit `e2e: 2` is the v1 handshake, where
                        // one key served as proof key and both cipher keys.
                        let e2e_version = match req.params.get("e2e").and_then(|v| v.as_u64()) {
                            Some(E2E_VERSION) => E2E_VERSION,
                            _ => 1,
                        };
                        let (proof_key, recv_key, send_key) = if e2e_version == E2E_VERSION {
                            let k = derive_session_keys(&token, &server_nonce, &cn);
                            (k.proof, k.c2s, k.s2c)
                        } else {
                            let k = derive_key(&token, &server_nonce, &cn);
                            (k, k, k)
                        };
                        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&proof_key).unwrap();
                        // Bind proof to BOTH nonces so a captured proof from
                        // a previous handshake can't be replayed: each
                        // session has a fresh (server_nonce, client_nonce)
                        // pair, and the MAC commits to both.
                        mac.update(&server_nonce);
                        mac.update(&cn);
                        if mac.verify_slice(&proof_bytes).is_ok() {
                            authenticated = true;
                            auth_tracker.lock().await.remove(&addr.ip());
                            // Split into two independent cipher halves — one
                            // for the receive path (this task), one for the
                            // send path (send task). Under v2 they hold
                            // different keys, so the two directions can never
                            // seal two frames under one (key, nonce).
                            recv_cipher = Some(HalfCipher::new(&recv_key));
                            // The InitCipher message must be queued before
                            // any Encrypted message so the send task has its
                            // cipher ready. We enqueue it first, then the
                            // auth response.
                            let _ = out_tx.send(Outbound::InitCipher(HalfCipher::new(&send_key)));
                            let resp = serde_json::to_string(&serde_json::json!({"result":{"authenticated":true,"machine_id":*machine_id,"hostname":&hostname,"e2e":e2e_version,"build":crate::build_info::json()}})).unwrap();
                            let _ = out_tx.send(Outbound::Encrypted(resp));
                            #[cfg(not(any(target_os = "android", target_os = "ios")))]
                            {
                                hub_push_handle = Some(tokio::spawn(super::hub_rpc::hub_push_loop(out_tx.clone())));
                            }
                            continue;
                        } else {
                            let mut tracker = auth_tracker.lock().await;
                            let entry = tracker.entry(addr.ip()).or_insert((0, tokio::time::Instant::now()));
                            if entry.1.elapsed().as_secs() >= AUTH_LOCKOUT_SECS { *entry = (0, tokio::time::Instant::now()); }
                            entry.0 += 1;
                            eprintln!("🚫 Auth failed from {} (attempt {})", addr, entry.0);
                            drop(tracker);
                            let r = Response::err(req.id, ERR_AUTH, "invalid proof".into());
                            let _ = out_tx.send(Outbound::Plain(serde_json::to_string(&r).unwrap()));
                            break;
                        }
                    } else if provided_token_matches(plain_token, &token) {
                        // Legacy plain token auth (http:// fallback)
                        authenticated = true;
                        auth_tracker.lock().await.remove(&addr.ip());
                        let r = Response::ok(req.id, serde_json::json!({ "authenticated": true, "machine_id": *machine_id, "hostname": &hostname, "build": crate::build_info::json() }));
                        let _ = out_tx.send(Outbound::Plain(serde_json::to_string(&r).unwrap()));
                        #[cfg(not(any(target_os = "android", target_os = "ios")))]
                        {
                            hub_push_handle = Some(tokio::spawn(super::hub_rpc::hub_push_loop(out_tx.clone())));
                        }
                        continue;
                    } else {
                        let mut tracker = auth_tracker.lock().await;
                        let entry = tracker.entry(addr.ip()).or_insert((0, tokio::time::Instant::now()));
                        if entry.1.elapsed().as_secs() >= AUTH_LOCKOUT_SECS { *entry = (0, tokio::time::Instant::now()); }
                        entry.0 += 1;
                        let fails = entry.0;
                        drop(tracker);
                        eprintln!("🚫 Auth failed from {} (attempt {})", addr, fails);
                        let r = Response::err(req.id, ERR_AUTH, "invalid token".into());
                        let _ = out_tx.send(Outbound::Plain(serde_json::to_string(&r).unwrap()));
                        break;
                    }
                }

                // Post-auth dispatch. Each request is processed in its own
                // task so a slow one (fs_download, fs_upload) doesn't block
                // the receive loop from reading / dispatching the next one.
                // Responses are funneled through out_tx and the send task
                // keeps their encrypt + ws.send in FIFO order.
                let subs_c = subs.clone();
                let tracker_c = resize_tracker.clone();
                let out_tx_c = out_tx.clone();
                let token_c = token.clone();
                let notifications_c = notifications.clone();
                tokio::spawn(async move {
                    // Every handler below that touches SQLite, spawns tmux, or
                    // sleeps (send_command settles 200 ms per delivery) is
                    // synchronous and runs on the blocking pool: a worker
                    // thread that sits in `tmux send-keys` for an `@all`
                    // delivery would otherwise stall every connection's
                    // pushes and pings for the duration. Only the subscription
                    // map edits stay on the async side — they hold an async
                    // mutex and do no I/O.
                    let method = req.method.clone();
                    let response = match method.as_str() {
                        "subscribe" => {
                            let mut map = subs_c.lock().await;
                            handle_subscribe(&req.params, &mut map)
                        }
                        "unsubscribe" => {
                            let mut map = subs_c.lock().await;
                            handle_unsubscribe(&req.params, &mut map)
                        }
                        m if m.starts_with("hub_") => tokio::task::spawn_blocking(move || super::hub_rpc::handle_hub_request(&req, Some(&notifications_c)))
                            .await
                            .unwrap_or_else(|e| Response::err(None, ERR_INTERNAL, format!("task panic: {}", e))),
                        "resize_pane" => {
                            let id = req.id;
                            let p = &req.params;
                            let target = p.get("target").and_then(|v| v.as_str()).unwrap_or("").to_string();
                            let cols = p.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as usize;
                            let rows = p.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as usize;
                            let tracker = tracker_c.clone();
                            tokio::task::spawn_blocking(move || {
                                match tmux::resize_pane(&target, cols, rows) {
                                    Ok(()) => {
                                        let win = target.split('.').next().unwrap_or(&target).to_string();
                                        let session = target.split(':').next().unwrap_or(&target);
                                        let _ = tmux::set_resize_hook(session);
                                        // Register this conn as an active holder
                                        // of `win`, and cancel any in-flight
                                        // restore task — the window is actively
                                        // being used at a known size again.
                                        let mut t = tracker.lock().unwrap();
                                        let first_time_for_conn = t
                                            .per_conn
                                            .entry(conn_id)
                                            .or_default()
                                            .insert(win.clone());
                                        let state = t.per_window.entry(win).or_default();
                                        if let Some(h) = state.pending_restore.take() {
                                            h.abort();
                                        }
                                        if first_time_for_conn {
                                            state.active_conns = state.active_conns.saturating_add(1);
                                        }
                                        Response::ok(id, serde_json::json!({ "ok": true }))
                                    }
                                    Err(e) => Response::err(id, ERR_INTERNAL, e),
                                }
                            }).await.unwrap_or_else(|e| Response::err(None, ERR_INTERNAL, format!("task panic: {}", e)))
                        }
                        _ => tokio::task::spawn_blocking(move || handle_request(&req, &token_c))
                            .await
                            .unwrap_or_else(|e| Response::err(None, ERR_INTERNAL, format!("task panic: {}", e))),
                    };
                    let _ = out_tx_c.send(Outbound::Encrypted(serde_json::to_string(&response).unwrap()));
                });
            continue; // data frame handled
        }
        // Control frames fall through to here.
        match msg {
            Message::Close(_) => break,
            Message::Ping(_) => {
                // Browsers don't usually send WS PINGs (they only reply to
                // ours). If some non-browser client does, we just ignore it
                // here — the connection survives fine without an explicit
                // Pong because our own keepalive going the other way is what
                // we rely on.
            }
            Message::Pong(_) => {
                // Reply to our own keepalive ping: mark the link as alive.
                *last_pong_at.lock().unwrap() = std::time::Instant::now();
            }
            _ => {}
        }
    }

    sub_handle.abort();
    ping_handle.abort();
    if let Some(h) = hub_push_handle.take() {
        h.abort();
    }
    drop(out_tx); // close the channel so the send task finishes
    let _ = send_task.await;
    // Schedule restoration of any windows this connection resized, but only
    // for windows where this conn was the last remaining holder. Other
    // still-connected clients might be actively driving the same window at
    // a different size; in that case we just decrement and leave the window
    // alone. A grace timer absorbs short reconnects so the pane doesn't get
    // reflowed twice (once on disconnect, once on the reconnect resize).
    let windows = {
        let mut t = resize_tracker.lock().unwrap();
        t.per_conn.remove(&conn_id).unwrap_or_default()
    };
    // Decision made under the lock; side-effects (tmux call / await) happen
    // after the guard is dropped so the future stays Send.
    enum Decision { Skip, RestoreNow, Scheduled }
    for win in windows {
        let decision = {
            let mut t = resize_tracker.lock().unwrap();
            let Some(state) = t.per_window.get_mut(&win) else { continue };
            state.active_conns = state.active_conns.saturating_sub(1);
            if state.active_conns > 0 {
                Decision::Skip
            } else {
                // Defensively abort any existing pending (shouldn't be one,
                // since we only reach here as the final holder leaves).
                if let Some(h) = state.pending_restore.take() {
                    h.abort();
                }
                if grace_secs == 0 {
                    Decision::RestoreNow
                } else {
                    let tracker_c = resize_tracker.clone();
                    let w = win.clone();
                    let grace = std::time::Duration::from_secs(grace_secs);
                    let handle = tokio::spawn(async move {
                        tokio::time::sleep(grace).await;
                        // Re-check: a reconnect during the sleep would have
                        // aborted us, but abort is delivered at the next
                        // await point — we may have already passed the
                        // sleep. Confirm active_conns is still 0 before
                        // touching tmux.
                        let should_restore = {
                            let t = tracker_c.lock().unwrap();
                            t.per_window.get(&w).map(|s| s.active_conns == 0).unwrap_or(false)
                        };
                        if !should_restore { return; }
                        let w2 = w.clone();
                        let _ = tokio::task::spawn_blocking(move || tmux::run_resize_window_auto(&w2)).await;
                        eprintln!("📐 Restored window '{}' to auto-size (after {}s grace)", w, grace.as_secs());
                        let mut t = tracker_c.lock().unwrap();
                        if let Some(s) = t.per_window.get(&w) {
                            if s.active_conns == 0 {
                                t.per_window.remove(&w);
                            }
                        }
                    });
                    state.pending_restore = Some(handle);
                    Decision::Scheduled
                }
            }
        };
        match decision {
            Decision::Skip => {}
            Decision::RestoreNow => {
                let w = win.clone();
                let _ = tokio::task::spawn_blocking(move || tmux::run_resize_window_auto(&w)).await;
                eprintln!("📐 Restored window '{}' to auto-size", win);
                let mut t = resize_tracker.lock().unwrap();
                if let Some(s) = t.per_window.get(&win) {
                    if s.active_conns == 0 && s.pending_restore.is_none() {
                        t.per_window.remove(&win);
                    }
                }
            }
            Decision::Scheduled => {
                eprintln!("⏳ Window '{}' scheduled for restore in {}s", win, grace_secs);
            }
        }
    }
    let up = conn_started_at.elapsed().as_secs();
    println!(
        "👋 Client disconnected: {} (conn_id={}, authed={}, up={}s)",
        addr, conn_id, authenticated, up
    );
}
