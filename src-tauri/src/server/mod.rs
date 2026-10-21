use crate::agent_notifications::AgentNotificationHub;
use crate::tmux;
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
mod wire;
pub use wire::{encode_wire_payload, decode_wire_payload, derive_session_keys, SessionKeys, E2E_VERSION, WIRE_PLAIN_JSON, WIRE_DEFLATE_JSON, COMPRESS_MIN_BYTES};
use wire::HalfCipher;
mod download;
mod hub_rpc;
mod rpc;
mod connection;
mod dispatch;
pub mod client_ip;
mod local_socket;
pub mod ui;
pub use connection::{handle_connection, ConnContext, Peer};
#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
pub use local_socket::{path_in as local_socket_path, peer_uid as local_peer_uid};
use connection::enable_tcp_keepalive;

pub type NotificationHub = Arc<AgentNotificationHub>;

/// What this server can do that a client may need to know BEFORE it writes,
/// announced in the login answer as `caps` (board #377). `board_dispatch`: a
/// `hub_board_save` that carries `dispatch: true` hands the issue to its
/// assignee. `spawn_join` (board #382): a `hub_spawn` with `join` puts the
/// agent in that running team (an older server ignores the key and spawns it
/// standalone). `agent_team` (board #384): `hub_agent_set_team` exists, so the
/// Hub may offer moving a running agent between teams. `hub_files` (board #432): `hub_search`
/// with `files: true` lists the files the messages mention. An older server REFUSES an empty
/// `grep` before it ever looks at `files`, and answers a worded one with messages, so a client
/// that needs Files asks for this first instead of guessing from the shape of an answer. An older server announces no `caps` at all, and a client that
/// needs one refuses the write instead of saving a label nobody acts on. The
/// phone's server has no Hub, so it announces none.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) const LOGIN_CAPS: &[&str] = &["board_dispatch", "spawn_join", "agent_team", "hub_files"];
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) const LOGIN_CAPS: &[&str] = &[];

// ─── RoomPoster implementation ───────────────────────────────────────────────
// The notification hub needs to post into project rooms from the hook consumer
// (a background task without a per-request context). This adapter bridges the
// `RoomPoster` trait to the hub's own message store (projects::rooms, board
// #107).
//
// A final reply is recorded once, then delivered only along the reply edge
// captured when the turn opened. The delivered `[reply]` envelope does not
// create a reverse edge, preventing ping-pong.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct HubRoomPoster;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl crate::agent_notifications::RoomPoster for HubRoomPoster {
    fn post_final(&self, session: &str, agent: &str, body: &str, reply_to: &[String]) -> Result<(), String> {
        post_final_with(session, agent, body, reply_to, |target, line| {
            hub_rpc::deliver_chat_line(session, target, line);
        })
    }
}

/// `post_final` with the typing injected (board #289, validator 11:34: the
/// rule must be pinned where it is applied, not only in `pane_targets`).
/// Recorded to every edge target; typed only to the ones with a pane — the
/// human has none, and reads the room. The room row is the posting outcome
/// (board #404 round 6): when it cannot be written nothing is typed and the
/// error is returned, so a numbered consumer retries the post.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn post_final_with(session: &str, agent: &str, body: &str, reply_to: &[String], mut deliver: impl FnMut(&str, &str)) -> Result<(), String> {
    let room = hub_rpc::project_room(session);
    crate::projects::rooms::post_routed(&room, agent, body, reply_to)?;
    for target in crate::address::pane_targets(reply_to) {
        let line = format!("[tmm chat {}] {agent}: [reply] {body}", hub_rpc::stamp_now());
        deliver(target, &line);
    }
    Ok(())
}

#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
mod reply_edge_tests {
    /// Board #289: a final reply to a turn the human and lead asked in is
    /// RECORDED to both and TYPED only to lead.
    #[test]
    fn a_reply_is_recorded_to_the_human_and_typed_only_to_agents() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-reply-rec-{}", uuid::Uuid::new_v4());
        let mut typed = Vec::new();
        let edge = vec!["lead".to_string(), "human".to_string()];
        super::post_final_with(&session, "dev", "done", &edge, |target, line| typed.push((target.to_string(), line.to_string()))).unwrap();
        assert_eq!(typed.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(), vec!["lead"], "never typed to the human");
        assert!(typed[0].1.ends_with("dev: [reply] done"));
        let room = super::hub_rpc::project_room(&session);
        let page = crate::projects::rooms::history_page(&room, None, 5);
        assert_eq!(page["messages"][0]["to"], serde_json::json!(["lead", "human"]), "recorded to both");
    }

    /// Board #404 round 6: the room row IS the posting outcome. When it
    /// cannot be written the error is returned and nothing is typed, so a
    /// numbered consumer retries the whole post; once it can, one row and
    /// one typed line.
    #[test]
    fn a_reply_the_room_did_not_record_is_an_error_and_types_nothing() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-reply-fail-{}", uuid::Uuid::new_v4());
        let room = super::hub_rpc::project_room(&session);
        let sql = |q: String| crate::projects::telemetry::exec_test_sql(&q);
        sql(format!("CREATE TEMP TRIGGER room404 BEFORE INSERT ON hub_msgs WHEN NEW.room = '{room}' BEGIN SELECT RAISE(ABORT, 'disk full'); END;"));
        let mut typed = Vec::new();
        let edge = vec!["lead".to_string()];
        let out = super::post_final_with(&session, "dev", "done", &edge, |target, _| typed.push(target.to_string()));
        sql("DROP TRIGGER room404;".into());
        assert!(out.is_err());
        assert!(typed.is_empty(), "nothing typed for a reply the room does not hold");
        assert_eq!(crate::projects::rooms::history_page(&room, None, 5)["messages"].as_array().map_or(0, |m| m.len()), 0);
        super::post_final_with(&session, "dev", "done", &edge, |target, _| typed.push(target.to_string())).unwrap();
        assert_eq!(typed, ["lead"]);
        assert_eq!(crate::projects::rooms::history_page(&room, None, 5)["messages"].as_array().unwrap().len(), 1);
    }
}

// Brute-force protection: track failed auth attempts per IP
pub type AuthTracker = Arc<Mutex<HashMap<IpAddr, (u32, tokio::time::Instant)>>>;

// Resize tracking: per-window state so that short disconnects (app
// backgrounded, network blip) don't trigger an immediate tmux
// `resize-window -A`, which reflows the pane to a non-mobile size and
// makes the re-connect feel like "页面刷新半天". On the last connection
// to a window dropping off, we schedule a restore task that sleeps for
// `grace_secs`; if any connection resizes the window again before it
// fires we abort the task and the window stays at mobile size.
//
// - `per_conn[conn_id]` : windows this connection has resized. Used at
//   disconnect time to know which windows to decrement.
// - `per_window[win]`   : aggregate state — how many still-connected
//   connections are "holding" the window at its current size, and any
//   in-flight grace timer.
#[derive(Default)]
pub struct ResizeTrackerInner {
    pub per_conn: HashMap<u64, std::collections::HashSet<String>>,
    pub per_window: HashMap<String, WindowResizeState>,
}

#[derive(Default)]
pub struct WindowResizeState {
    pub active_conns: u32,
    pub pending_restore: Option<tokio::task::JoinHandle<()>>,
}

pub type ResizeTracker = Arc<std::sync::Mutex<ResizeTrackerInner>>;

static CONN_ID_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

const MAX_AUTH_FAILURES: u32 = 5;
const AUTH_LOCKOUT_SECS: u64 = 60;
// Drop auth-tracker entries whose last activity is older than this (in
// seconds). Otherwise a distributed scan from many IPs would grow the
// HashMap unboundedly; each IP only needs to be remembered for as long
// as the lockout could still apply.
const AUTH_TRACKER_GC_AFTER_SECS: u64 = 600;
const SUBSCRIPTION_POLL_MS: u64 = 200;
const MAX_CAPTURE_FAILURES: u32 = 5;

/// Outbound message types funneled through the single send task. The send
/// task is what guarantees encrypt-counter ordering: even if many business
/// tasks finish out of order, they enqueue into this channel and the one
/// consumer encrypts + ws.send in strict FIFO order.
enum Outbound {
    /// Plain text frame — used only for the initial `server_nonce` handshake
    /// and the plain-fallback auth response (legacy path for http:// clients
    /// without Web Crypto).
    Plain(String),
    /// Ciphertext path. Once the send task has been given its cipher (via
    /// `InitCipher`), every payload here is encrypted in enqueue order.
    Encrypted(String),
    /// Same wire treatment as `Encrypted`, but flags a pane snapshot whose
    /// completion decrements the shared in-flight counter. Snapshots are
    /// latest-frame-wins: the subscription loop refuses to enqueue a new one
    /// while a previous one is still queued or being written to a slow
    /// socket. Without this, a link slower than the 200 ms capture cadence
    /// accumulates stale frames without bound (channel + kernel buffer), the
    /// client renders seconds-old content, and small RPC replies queue
    /// behind megabytes of dead snapshots until they time out.
    Snapshot(String),
    /// Hand a freshly-built send-side cipher to the send task. Emitted once,
    /// right after successful encrypted auth. Must be enqueued *before* any
    /// `Encrypted` message for that session, otherwise the send task drops
    /// the message with a warning.
    InitCipher(HalfCipher),
    /// Protocol-level WebSocket PING frame. Browsers auto-reply with PONG
    /// without application code running, so this probes TCP liveness without
    /// contending with JSON-RPC traffic for the encrypt/send mutex.
    Ping(Vec<u8>),
}

pub async fn start(host: &str, port: u16, token: &str) -> Result<(), Box<dyn std::error::Error>> {
    start_with_socket(host, port, token, "unknown", None, None, None, 600).await
}

#[allow(clippy::too_many_arguments)]
pub async fn start_with_socket(
    host: &str,
    port: u16,
    token: &str,
    machine_id: &str,
    socket: Option<String>,
    tls_cert: Option<String>,
    tls_key: Option<String>,
    disconnect_grace_secs: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    start_with_socket_ready(host, port, token, machine_id, socket, tls_cert, tls_key, disconnect_grace_secs, client_ip::TrustedProxies::Off, None).await
}

/// `start_with_socket`, telling `ready` the moment the listener is bound and
/// TLS is loaded — i.e. right before the first `accept` (board #323: the
/// desktop app says `embedded` only then). Every earlier failure returns Err
/// with `ready` dropped unsent.
#[allow(clippy::too_many_arguments)]
pub async fn start_with_socket_ready(
    host: &str,
    port: u16,
    token: &str,
    machine_id: &str,
    socket: Option<String>,
    tls_cert: Option<String>,
    tls_key: Option<String>,
    disconnect_grace_secs: u64,
    trusted_proxies: client_ip::TrustedProxies,
    ready: Option<tokio::sync::oneshot::Sender<()>>,
) -> Result<(), Box<dyn std::error::Error>> {
    tmux::set_socket(socket);
    // Best-effort harden existing config.toml so upgraded installs with the
    // old loose permissions get fixed on next start.
    crate::config::harden_config_perms();
    let addr = format!("{}:{}", host, port);
    let listener = TcpListener::bind(&addr).await?;
    let token = Arc::new(token.to_string());
    let machine_id = Arc::new(machine_id.to_string());
    let auth_tracker: AuthTracker = Arc::new(Mutex::new(HashMap::new()));
    let resize_tracker: ResizeTracker = Arc::new(std::sync::Mutex::new(ResizeTrackerInner::default()));
    // What a local login is told (board #440): this config's port and its
    // canonical config dir, so a tmm can refuse a socket of another gateway.
    let config_dir = crate::config::config_dir();
    let endpoint = Arc::new(serde_json::json!({
        "port": port,
        "config": std::fs::canonicalize(&config_dir).unwrap_or_else(|_| config_dir.clone()).to_string_lossy(),
    }));
    // Board #441: whose X-Forwarded-For the lockout believes. Said once at
    // start when the key is set but ignored, by position only.
    if let client_ip::TrustedProxies::Ignored(why) = &trusted_proxies {
        eprintln!("⚠️ trusted_proxies ignored ({why}): the auth lockout keys on the TCP peer");
    }
    let trusted_proxies = Arc::new(trusted_proxies);
    let notifications = Arc::new(AgentNotificationHub::load());
    notifications.ensure_helper().map_err(|error| format!("Failed to prepare agent notification helper: {error}"))?;
    // Board #394: every session's turn facts are replayed from the activity
    // log BEFORE the hook inbox is read and before the first accept, so the
    // first read after a restart derives from the log and no live fact lands
    // on an empty record first. Blocking SQLite work: it runs on the blocking
    // pool and is AWAITED here (review P2), so no runtime worker is held and
    // nothing below starts until it is done. A replay that panicked is said
    // and the start goes on; its sessions are recovered at their first touch.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if let Err(e) = tokio::task::spawn_blocking(crate::projects::telemetry::recover_on_start).await {
            eprintln!("⚠  the turn-fact replay at start did not finish ({e}); each session is recovered when first touched");
        }
    }
    // Board #422 round 3: the reboot restore's small durable decision — the
    // trigger, the batch with a hold for every planned agent slot, and this
    // boot's `restore_decided` — is AWAITED here, before the hook inbox,
    // capture, the start flush, wakes and the first accept. Window creation
    // runs in the background below. On unless `restore_on_start = false`.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let restore_start = {
        let inputs = crate::projects::restore_run::start_inputs();
        let decide = inputs.clone();
        match tokio::task::spawn_blocking(move || crate::projects::restore_run::prepare_on_start(&decide)).await {
            Ok(start) => start.map(|s| (inputs, s)),
            Err(e) => {
                eprintln!("⚠  the reboot restore's prepare did not finish ({e})");
                None
            }
        }
    };
    tokio::spawn(notifications.clone().run());

    // Fold live tmux state back into the project declarations. Nobody
    // hand-writes a project; the capturer is what makes "close it and reopen it
    // later" possible. The notification hub supplies the agent conversation
    // ids, so a restored window resumes instead of starting blank.
    // Desktop-only (state.db is not built for mobile).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        crate::projects::set_agent_sessions(notifications.clone());
        tokio::spawn(crate::projects::capture_loop());
        // The recovery drift guard (board #362): at start and daily, a CLI
        // newer than the one recovery's error shapes were measured on is
        // said in the rooms that run it, once per version.
        tokio::spawn(crate::projects::recovery::drift_loop());
        // Pull any pre-#107 chat history out of the legacy team.db, exactly
        // once. Blocking SQLite work, so it runs before the listener loop.
        crate::projects::rooms::import_legacy();
        // Inject the room poster so hook-sourced stop events can auto-post
        // managed agents' final replies into the project chat room. The hub's
        // message store is always there on desktop (state.db), so this no
        // longer depends on a team bus being configured.
        let poster: Arc<dyn crate::agent_notifications::RoomPoster> = Arc::new(HubRoomPoster);
        notifications.set_room_poster(poster);
        // The restore's tmux work, after the room poster is in place; its
        // windows are held from their creation (restore_hold).
        if let Some((inputs, start)) = restore_start {
            std::thread::spawn(move || crate::projects::restore_run::continue_schedule(inputs, start));
        }
        // Lines held for a busy queue-mode agent (board #257) whose turn a
        // restart finds over are typed now, not at the first feed read.
        tokio::task::spawn_blocking(crate::projects::delivery::flush_on_start);
        // Scheduled wakes (board #275): one sleeper; missed ones fire once now.
        tokio::spawn(crate::projects::wakes::run(hub_rpc::fire_wake));
    }

    // Load TLS config if cert+key provided
    let tls_acceptor = match (&tls_cert, &tls_key) {
        (Some(cert_path), Some(key_path)) => {
            let cert_data = std::fs::read(cert_path)
                .map_err(|e| format!("Failed to read TLS cert {}: {}", cert_path, e))?;
            let key_data = std::fs::read(key_path)
                .map_err(|e| format!("Failed to read TLS key {}: {}", key_path, e))?;

            let certs: Vec<_> = rustls_pemfile::certs(&mut &cert_data[..])
                .filter_map(|r| r.ok())
                .collect();
            let key = rustls_pemfile::private_key(&mut &key_data[..])
                .map_err(|e| format!("Failed to parse TLS key: {}", e))?
                .ok_or("No private key found in key file")?;

            let config = tokio_rustls::rustls::ServerConfig::builder()
                .with_no_client_auth()
                .with_single_cert(certs, key)
                .map_err(|e| format!("TLS config error: {}", e))?;
            Some(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
        }
        _ => None,
    };

    let scheme = if tls_acceptor.is_some() { "wss" } else { "ws" };
    println!("🚀 tmux-mobile server listening on {}://{}", scheme, addr);
    // The token is the one secret. Show it to a person at a terminal (first
    // run, pairing a phone); never write it into a log — a supervised server's
    // stdout is a file, and that file would undo config.toml's 0600.
    {
        use std::io::IsTerminal;
        if std::io::stdout().is_terminal() {
            println!("🔑 Token: {}", token);
        } else {
            println!("🔑 Token: not printed (stdout is not a terminal) — see {}", crate::config::config_dir().join("config.toml").display());
        }
    }
    println!("   Methods: auth, list_sessions, list_panes, capture_pane, send_keys, send_command, new_session, kill_session, subscribe, unsubscribe");

    // The local door (board #440), after the TCP bind succeeded: a 0600 Unix
    // socket in `<config>/sock/`, no IP lockout. Any failure leaves this
    // gateway TCP-only with the reason said; it never stops the start.
    #[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
    {
        let ctx = ConnContext {
            token: token.clone(),
            machine_id: machine_id.clone(),
            auth_tracker: auth_tracker.clone(),
            resize_tracker: resize_tracker.clone(),
            grace_secs: disconnect_grace_secs,
            notifications: notifications.clone(),
            endpoint: endpoint.clone(),
            trusted_proxies: trusted_proxies.clone(),
        };
        // Every step that can fail comes BEFORE the announcement and the
        // published path (review P2): a failure drops the socket (its own
        // node removed) and nothing says it is ready.
        let opened = local_socket::open(&config_dir).and_then(|socket| {
            let listener = socket.listener.try_clone().and_then(tokio::net::UnixListener::from_std)
                .map_err(|e| format!("{}: {e}", socket.path.display()))?;
            Ok((socket, listener))
        });
        match opened {
            Ok((socket, listener)) => {
                println!("🔌 local socket: {}", socket.path.display());
                // Published once per process, for its life: the socket task
                // below owns the socket until the process ends.
                let _ = BOUND_LOCAL_SOCKET.set(socket.path.clone());
                tokio::spawn(serve_local(socket, listener, ctx));
            }
            Err(why) => eprintln!("⚠  local socket unavailable ({why}); this gateway is TCP only, and a local tmm uses TCP"),
        }
    }

    if let Some(tx) = ready {
        let _ = tx.send(());
    }
    loop {
        let (stream, addr) = listener.accept().await?;
        // OS-level NAT-friendly heartbeat. Must happen on the raw TcpStream
        // before tokio-rustls / tokio-tungstenite wrap it.
        enable_tcp_keepalive(&stream);
        // Disable Nagle. Our traffic is small JSON-RPC frames + occasional
        // big payloads — Nagle's 40 ms coalescing doesn't help here and
        // adds latency to interactive keystrokes.
        let _ = stream.set_nodelay(true);

        let ctx = ConnContext {
            token: token.clone(),
            machine_id: machine_id.clone(),
            auth_tracker: auth_tracker.clone(),
            resize_tracker: resize_tracker.clone(),
            grace_secs: disconnect_grace_secs,
            notifications: notifications.clone(),
            endpoint: endpoint.clone(),
            trusted_proxies: trusted_proxies.clone(),
        };
        if let Some(ref acceptor) = tls_acceptor {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                match acceptor.accept(stream).await {
                    Ok(tls_stream) => connection::dispatch(tls_stream, Peer::Tcp(addr), ctx, true).await,
                    Err(e) => eprintln!("❌ TLS handshake failed for {}: {}", addr, e),
                }
            });
        } else {
            tokio::spawn(handle_connection(stream, addr, ctx));
        }
    }
}

/// The local socket this gateway bound, once it is accepted on (board #440):
/// what a spawn writes into an agent's recipe as `TMM_SOCKET`.
static BOUND_LOCAL_SOCKET: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn bound_local_socket() -> Option<std::path::PathBuf> {
    BOUND_LOCAL_SOCKET.get().cloned()
}

/// Accept on the local socket for the gateway's life (board #440). The
/// socket (and its claim) lives as long as this task.
#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
async fn serve_local(socket: local_socket::LocalSocket, listener: tokio::net::UnixListener, ctx: ConnContext) {
    let me = unsafe { libc::geteuid() };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => { eprintln!("❌ local socket accept: {e}"); continue; }
        };
        let peer = local_socket::peer_uid(&stream);
        tokio::spawn(admit_local(stream, peer, me, ctx.clone()));
    }
    #[allow(unreachable_code)]
    { drop(socket); }
}

/// The local door's one gate, for every accepted stream (review P1-B): only
/// a peer whose credentials say THIS uid reaches the WebSocket and the token
/// auth; another uid, or credentials that cannot be read, is closed before a
/// byte is read or written. `peer` is what SO_PEERCRED / getpeereid said,
/// passed in so a test can drive the refusal without a second user.
#[cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]
async fn admit_local<S>(stream: S, peer: std::io::Result<u32>, me: u32, ctx: ConnContext)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    match peer {
        Ok(uid) if uid == me => connection::dispatch(stream, Peer::Local, ctx, false).await,
        other => eprintln!("🚫 local socket: peer is not this user ({other:?}); closed"),
    }
}

#[cfg(all(test, unix))]
mod admit_local_tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio::io::AsyncReadExt;
    use tokio_tungstenite::tungstenite::Message;

    fn ctx() -> ConnContext {
        ConnContext {
            token: Arc::new("tok-adm".into()),
            machine_id: Arc::new("m".into()),
            auth_tracker: Arc::new(Mutex::new(HashMap::new())),
            resize_tracker: Arc::new(std::sync::Mutex::new(Default::default())),
            grace_secs: 0,
            notifications: Arc::new(AgentNotificationHub::load()),
            endpoint: Arc::new(serde_json::json!({ "port": 1, "config": "/c" })),
            trusted_proxies: Arc::new(Default::default()),
        }
    }

    /// Another uid, or unreadable credentials: closed before any byte, so a
    /// client that sends a WebSocket upgrade reads nothing back.
    #[tokio::test]
    async fn a_peer_of_another_uid_or_unknown_credentials_is_closed_before_a_byte() {
        for peer in [Ok(4242u32), Err(std::io::Error::from_raw_os_error(libc::ENOTCONN))] {
            let (mut client, server) = tokio::net::UnixStream::pair().unwrap();
            let what = format!("{peer:?}");
            tokio::spawn(admit_local(server, peer, 1000, ctx()));
            use tokio::io::AsyncWriteExt;
            let _ = client.write_all(b"GET / HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").await;
            // Bounded: an open door would answer the upgrade and keep the
            // stream open, which must fail here, not hang.
            let mut out = Vec::new();
            let read = tokio::time::timeout(std::time::Duration::from_secs(2), client.read_to_end(&mut out)).await;
            assert!(read.is_ok(), "{what}: the stream was not closed (got {:?})", String::from_utf8_lossy(&out));
            assert!(out.is_empty(), "{what}: nothing is answered, got {:?}", String::from_utf8_lossy(&out));
        }
    }

    /// The same entry with this uid: the WebSocket and the token auth.
    #[tokio::test]
    async fn this_uid_reaches_the_token_auth() {
        let (client, server) = tokio::net::UnixStream::pair().unwrap();
        tokio::spawn(admit_local(server, Ok(1000), 1000, ctx()));
        let (mut ws, _) = tokio_tungstenite::client_async("ws://local/", client).await.unwrap();
        let _nonce = ws.next().await;
        ws.send(Message::Text(r#"{"id":1,"method":"auth","params":{"token":"tok-adm"}}"#.into())).await.unwrap();
        let reply = ws.next().await.unwrap().unwrap();
        assert!(reply.to_text().unwrap().contains("\"authenticated\":true"), "{reply:?}");
    }
}

#[cfg(test)]
pub(super) mod test_util {
    use super::rpc::Request;

    pub(super) fn req(method: &str, params: serde_json::Value) -> Request {
        Request { id: Some(1), method: method.to_string(), params }
    }
}

/// Board #394: the turn-fact replay runs at start on the blocking pool and
/// is AWAITED before the hook inbox is read, before the capture, drift,
/// flush and wake loops start, before `ready` is told and before the first
/// connection is accepted (review P2). The regression tests call the replay
/// themselves, so the order of the start sequence is pinned here.
#[cfg(test)]
mod start_order {
    #[test]
    fn the_turn_facts_are_replayed_before_the_inbox_and_the_first_accept() {
        let src = include_str!("mod.rs");
        let start = &src[src.find("pub async fn start_with_socket_ready(").unwrap()..];
        let start = &start[..start.find("\n}\n").unwrap()];
        let at = |needle: &str| start.find(needle).unwrap_or_else(|| panic!("{needle} missing from the start sequence"));
        let replay = at("tokio::task::spawn_blocking(crate::projects::telemetry::recover_on_start).await");
        for later in [
            "tokio::spawn(notifications.clone().run());",
            "tokio::spawn(crate::projects::capture_loop());",
            "tokio::spawn(crate::projects::recovery::drift_loop());",
            "crate::projects::delivery::flush_on_start",
            "tokio::spawn(crate::projects::wakes::run(",
            "tx.send(())",
            "listener.accept()",
        ] {
            assert!(replay < at(later), "the replay is awaited before {later}");
        }
        assert_eq!(start.matches("recover_on_start").count(), 1, "one replay, awaited, nowhere else in the start");
    }

    /// Board #422 round 3: the reboot restore's prepare (its decision, the
    /// batch and its holds) is AWAITED before the hook inbox, capture, the
    /// start flush, wakes, `ready` and the first accept; its tmux work is
    /// spawned after the room poster is installed, never awaited.
    #[test]
    fn the_restore_is_prepared_before_any_delivery_path_and_run_after_the_room_poster() {
        let src = include_str!("mod.rs");
        let start = &src[src.find("pub async fn start_with_socket_ready(").unwrap()..];
        let start = &start[..start.find("\n}\n").unwrap()];
        let at = |needle: &str| start.find(needle).unwrap_or_else(|| panic!("{needle} missing from the start sequence"));
        let prepare = at("crate::projects::restore_run::prepare_on_start(&decide)).await");
        assert!(at("tokio::task::spawn_blocking(crate::projects::telemetry::recover_on_start).await") < prepare);
        for later in [
            "tokio::spawn(notifications.clone().run());",
            "tokio::spawn(crate::projects::capture_loop());",
            "crate::projects::delivery::flush_on_start",
            "tokio::spawn(crate::projects::wakes::run(",
            "tx.send(())",
            "listener.accept()",
        ] {
            assert!(prepare < at(later), "the prepare is awaited before {later}");
        }
        let run = at("crate::projects::restore_run::continue_schedule(inputs, start)");
        assert!(at("notifications.set_room_poster(poster);") < run, "the room poster is in place first");
        assert!(start.contains("std::thread::spawn(move || crate::projects::restore_run::continue_schedule(inputs, start));"), "on its own thread");
        assert!(!start.contains(".join()"), "never joined: the listener does not wait for the windows");
        assert!(!start[run..].starts_with("crate::projects::restore_run::continue_schedule(inputs, start)).await"), "never awaited");
        assert_eq!(start.matches("prepare_on_start").count(), 1);
    }
}

/// The wire error strings are a CONTRACT, not prose (board #146): `tmm` maps
/// -32601 to EXIT_NOT_FOUND and -32602 to EXIT_USAGE, the client tells an old
/// server apart by -32601, and agents read the messages. This table freezes
/// every hand-written error literal in rpc.rs / hub_rpc.rs and one row per
/// pass-through class (a missing param, a store error carried verbatim) BEFORE
/// the dispatchers are folded behind a `?`-returning inner fn, so each step of
/// that fold has to reproduce these bytes. A row moving here is a wire change
/// and needs its own reason.
#[cfg(test)]
mod golden_errors {
    use super::rpc::*;
    use super::test_util::req;

    fn check(tag: &str, r: Response, code: i32, message: &str) {
        let e = r.error.unwrap_or_else(|| panic!("{tag}: expected an error"));
        assert_eq!((e.code, e.message.as_str()), (code, message), "{tag}");
    }

    #[test]
    fn every_error_literal_and_class_is_pinned() {
        crate::projects::tests::use_test_store();
        let session = format!("golden-{}", uuid::Uuid::new_v4());
        let hub = |m: &str, mut p: serde_json::Value| {
            if let Some(o) = p.as_object_mut() {
                o.entry("session").or_insert(serde_json::Value::String(session.clone()));
            }
            super::hub_rpc::handle_hub_request(&req(m, p), None)
        };
        let rpc = |m: &str, p: serde_json::Value| handle_request(&req(m, p), "token");

        // ── pass-through classes ─────────────────────────────────────────
        check("missing param (hub)", super::hub_rpc::handle_hub_request(&req("hub_post", serde_json::json!({"body": "x"})), None),
            ERR_INVALID_PARAMS, "missing required param: session");
        check("missing param (rpc)", rpc("list_panes", serde_json::json!({})), ERR_INVALID_PARAMS, "missing required param: session");
        check("store error carried verbatim", hub("hub_board_note", serde_json::json!({"id": 999999, "body": "n"})),
            ERR_INVALID_PARAMS, "no issue #999999 on this board");

        // ── hub_rpc.rs literals ──────────────────────────────────────────
        check("hub_command", hub("hub_command", serde_json::json!({"agent": "a", "text": "model"})),
            ERR_INVALID_PARAMS, "a command must start with '/'");
        check("hub_command no such agent", hub("hub_command", serde_json::json!({"agent": "nobody-such", "text": "/model"})),
            ERR_INVALID_PARAMS, format!("no managed agent named 'nobody-such' in session '{session}'").as_str());
        check("hub_search", hub("hub_search", serde_json::json!({"grep": []})),
            ERR_INVALID_PARAMS, "grep must be a non-empty array of search terms");
        for m in ["hub_msg_archive", "hub_msg_restore", "hub_msg_purge"] {
            check(m, hub(m, serde_json::json!({"ids": []})), ERR_INVALID_PARAMS, "ids must be a non-empty array");
        }
        for m in ["hub_board_get", "hub_board_note", "hub_board_delete"] {
            check(m, hub(m, serde_json::json!({})), ERR_INVALID_PARAMS, "id required");
        }
        check("hub_board_delete absent", hub("hub_board_delete", serde_json::json!({"id": 999999})),
            ERR_INVALID_PARAMS, "no issue #999999 on this board");
        check("unknown hub method", hub("hub_nope", serde_json::json!({})), ERR_METHOD_NOT_FOUND, "unknown hub method: hub_nope");
        // Two multi-line literals the first census missed (found by the c2
        // conversion): the agent-control arms' identity checks.
        for m in ["hub_agent_interrupt", "hub_agent_stop", "hub_agent_restart", "hub_agent_fork"] {
            check(m, hub(m, serde_json::json!({"agent": "nobody-such"})),
                ERR_INVALID_PARAMS, "'nobody-such' is not an agent this app started");
        }
        // Board #271: the live queue/steer switch.
        check("hub_agent_input_mode bad mode", hub("hub_agent_input_mode", serde_json::json!({"agent": "x", "mode": "interrupt"})),
            ERR_INVALID_PARAMS, "mode must be queue or steer, not 'interrupt'");
        check("hub_agent_input_mode not ours", hub("hub_agent_input_mode", serde_json::json!({"agent": "nobody-such", "mode": "steer"})),
            ERR_INVALID_PARAMS, "'nobody-such' is not an agent this app started");

        // ── rpc.rs literals ──────────────────────────────────────────────
        check("git allowlist", rpc("git", serde_json::json!({"subcmd": "rm"})), ERR_INVALID_PARAMS, "git subcommand not allowed: rm");
        let nul = format!("a{}b", char::from(0u8));
        check("git nul", rpc("git", serde_json::json!({"subcmd": "status", "args": [nul]})), ERR_INVALID_PARAMS, "invalid characters in argument");
        check("fs_convert format", rpc("fs_convert", serde_json::json!({"path": "x.pptx", "format": "pdf"})),
            ERR_INVALID_PARAMS, "only html format supported");
        check("fs_convert ext", rpc("fs_convert", serde_json::json!({"path": "x.docx"})), ERR_INVALID_PARAMS, "unsupported file type: .docx");
        check("resize_pane", rpc("resize_pane", serde_json::json!({})), ERR_INTERNAL, "resize_pane handled elsewhere");
        check("unknown method", rpc("nope", serde_json::json!({})), ERR_METHOD_NOT_FOUND, "unknown method: nope");

        // `restart failed: {e}` needs a live tmux session with a managed agent
        // whose relaunch fails — not reachable here, so the literal is pinned
        // at the source with its code.
        let src = include_str!("hub_rpc.rs");
        assert!(src.contains(r#"Response::err(id, ERR_INTERNAL, format!("restart failed: {e}"))"#)
            || src.contains(r#"RpcError::Internal(format!("restart failed: {e}"))"#)
            || src.contains(r#".map_err(|e| RpcError::Internal(format!("restart failed: {e}")))"#),
            "the restart-failed literal moved or changed");
    }
}
