//! `tmm` picks its transport by the selection table (board #440), through
//! the REAL CLI against FAKE gateways: one on TCP (this config's port) and
//! one on this config's local socket. The fakes record every connection by
//! transport, so "went over the socket", "never touched TCP" and "made no
//! second RPC" are observations.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Copy, PartialEq)]
enum Act { Answer, RefuseAuth, LoseAnswer }

type Log = Arc<Mutex<Vec<String>>>;

/// Serve one WS session per connection on an accepted stream, logging
/// `<tag>:<method>` for the auth and the call.
async fn serve<S>(stream: S, tag: &'static str, log: Log, act: Act, endpoint: serde_json::Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    log.lock().unwrap().push(format!("{tag}:connect"));
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
    let Some(Ok(Message::Text(_))) = ws.next().await else { return };
    log.lock().unwrap().push(format!("{tag}:auth"));
    if act == Act::RefuseAuth {
        let _ = ws.send(Message::Text(r#"{"id":1,"error":{"code":-32000,"message":"invalid token"}}"#.into())).await;
        return;
    }
    let login = serde_json::json!({ "id": 1, "result": { "authenticated": true, "caps": [], "endpoint": endpoint } });
    let _ = ws.send(Message::Text(login.to_string().into())).await;
    let Some(Ok(Message::Text(raw))) = ws.next().await else { return };
    let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
    log.lock().unwrap().push(format!("{tag}:{}", call["method"].as_str().unwrap_or("")));
    if act == Act::LoseAnswer { return; }
    let _ = ws.send(Message::Text(r#"{"id":2,"result":{"agents":[],"session":"p"}}"#.into())).await;
    let _ = ws.close(None).await;
}

struct Rig {
    xdg: PathBuf,
    port: u16,
    log: Log,
    /// The fakes' own lifetime (review P2): Drop stops their runtime and
    /// joins its thread, so a rig never outlives its test.
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Rig {
    /// A config dir whose config.toml names a TCP fake; `socket` binds a
    /// local fake at this config's socket path, answering `endpoint`.
    fn new(socket: Option<(Act, Option<serde_json::Value>)>, tcp: Act) -> Rig {
        let xdg = PathBuf::from(format!("/tmp/t440c-{}", &uuid_like()));
        let cfg = xdg.join("tmux-mobile");
        std::fs::create_dir_all(&cfg).unwrap();
        let log: Log = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = std::sync::mpsc::channel();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let (l1, l2) = (log.clone(), log.clone());
        let sock_dir = cfg.join("sock");
        let canon = std::fs::canonicalize(&cfg).unwrap().to_string_lossy().to_string();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build().unwrap();
            rt.block_on(async move {
                let tcp_l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let port = tcp_l.local_addr().unwrap().port();
                let own = serde_json::json!({ "port": port, "config": canon });
                let uds = socket.map(|(act, endpoint)| {
                    std::fs::create_dir_all(&sock_dir).unwrap();
                    std::fs::set_permissions(&sock_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
                    let path = sock_dir.join("gateway.sock");
                    let l = tokio::net::UnixListener::bind(&path).unwrap();
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
                    (l, act, endpoint.unwrap_or(own.clone()))
                });
                tx.send(port).unwrap();
                let local = tokio::task::LocalSet::new();
                local.run_until(async move {
                    if let Some((l, act, endpoint)) = uds {
                        let log = l1.clone();
                        tokio::task::spawn_local(async move {
                            loop {
                                let Ok((s, _)) = l.accept().await else { return };
                                tokio::task::spawn_local(serve(s, "uds", log.clone(), act, endpoint.clone()));
                            }
                        });
                    }
                    loop {
                        tokio::select! {
                            _ = &mut stopped => return,
                            accepted = tcp_l.accept() => {
                                let Ok((s, _)) = accepted else { return };
                                tokio::task::spawn_local(serve(s, "tcp", l2.clone(), tcp, serde_json::Value::Null));
                            }
                        }
                    }
                }).await;
            });
        });
        let port = rx.recv().unwrap();
        std::fs::write(cfg.join("config.toml"), format!("token = \"t\"\nport = {port}\nhost = \"127.0.0.1\"\n")).unwrap();
        Rig { xdg, port, log, stop: Some(stop), thread: Some(thread) }
    }
    fn socket(&self) -> PathBuf { self.xdg.join("tmux-mobile/sock/gateway.sock") }
    fn run(&self, env: &[(&str, &str)], args: &[&str]) -> (i32, String) {
        let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"));
        cmd.args(args).env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.xdg)
            .env("XDG_CONFIG_HOME", &self.xdg)
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "a");
        for (k, v) in env { cmd.env(k, v); }
        let out = cmd.output().unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stderr).to_string())
    }
    fn log(&self) -> Vec<String> {
        std::thread::sleep(std::time::Duration::from_millis(100));
        self.log.lock().unwrap().clone()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() { let _ = stop.send(()); }
        if let Some(t) = self.thread.take() { let _ = t.join(); }
        let _ = std::fs::remove_dir_all(&self.xdg);
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    format!("{:x}{:x}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().subsec_nanos())
}

const CALL: &[&str] = &["agent", "list"];

#[test]
fn the_default_target_goes_over_this_configs_socket_and_never_touches_tcp() {
    let r = Rig::new(Some((Act::Answer, None)), Act::Answer);
    let (code, err) = r.run(&[], CALL);
    assert_eq!(code, 0, "{err}");
    assert_eq!(r.log(), vec!["uds:connect", "uds:auth", "uds:hub_agents"]);
}

#[test]
fn an_explicit_target_is_tcp_even_with_a_socket_present() {
    let r = Rig::new(Some((Act::Answer, None)), Act::Answer);
    let url = format!("ws://127.0.0.1:{}", r.port);
    assert_eq!(r.run(&[], &["agent", "list", "--server", &url]).0, 0);
    assert_eq!(r.log(), vec!["tcp:connect", "tcp:auth", "tcp:hub_agents"], "--server");
    r.log.lock().unwrap().clear();
    assert_eq!(r.run(&[("TMM_SERVER", &url)], CALL).0, 0);
    assert_eq!(r.log(), vec!["tcp:connect", "tcp:auth", "tcp:hub_agents"], "TMM_SERVER");
    r.log.lock().unwrap().clear();
    assert_eq!(r.run(&[("TMM_SERVER", &url), ("TMM_SOCKET", r.socket().to_str().unwrap())], CALL).0, 0);
    assert_eq!(r.log(), vec!["tcp:connect", "tcp:auth", "tcp:hub_agents"], "an explicit target beats a recipe's socket");
}

#[test]
fn a_masked_socket_is_tcp_and_an_absent_one_falls_back_to_tcp() {
    let r = Rig::new(Some((Act::Answer, None)), Act::Answer);
    assert_eq!(r.run(&[("TMM_SOCKET", "")], CALL).0, 0);
    assert_eq!(r.log(), vec!["tcp:connect", "tcp:auth", "tcp:hub_agents"], "TMM_SOCKET='' (a starter had none)");
    let r = Rig::new(None, Act::Answer);
    assert_eq!(r.run(&[], CALL).0, 0);
    assert_eq!(r.log(), vec!["tcp:connect", "tcp:auth", "tcp:hub_agents"], "no socket yet: the default over TCP");
}

#[test]
fn a_socket_of_another_gateway_is_refused_after_the_login_and_nothing_else_is_sent() {
    let other = serde_json::json!({ "port": 1, "config": "/elsewhere" });
    let r = Rig::new(Some((Act::Answer, Some(other))), Act::Answer);
    let (code, err) = r.run(&[], CALL);
    assert_ne!(code, 0);
    assert!(err.contains("another gateway"), "{err}");
    assert_eq!(r.log(), vec!["uds:connect", "uds:auth"], "no call after the login, no TCP");
}

#[test]
fn a_refused_login_or_a_lost_answer_on_the_socket_is_never_retried_over_tcp() {
    let r = Rig::new(Some((Act::RefuseAuth, None)), Act::Answer);
    let (code, err) = r.run(&[], CALL);
    assert_eq!(code, 3, "the auth exit code: {err}");
    assert_eq!(r.log(), vec!["uds:connect", "uds:auth"], "a bad token never reaches the TCP lockout");
    let r = Rig::new(Some((Act::LoseAnswer, None)), Act::Answer);
    let (code, err) = r.run(&[], CALL);
    assert_ne!(code, 0, "{err}");
    assert_eq!(r.log(), vec!["uds:connect", "uds:auth", "uds:hub_agents"], "one call, no second one over TCP");
}

#[test]
fn a_socket_that_is_not_this_users_private_socket_is_refused_before_any_byte() {
    let r = Rig::new(Some((Act::Answer, None)), Act::Answer);
    std::fs::set_permissions(r.socket(), std::fs::Permissions::from_mode(0o666)).unwrap();
    let (code, err) = r.run(&[], CALL);
    assert_ne!(code, 0);
    assert!(err.contains("is not used"), "{err}");
    assert_eq!(r.log(), Vec::<String>::new(), "not connected, and no TCP either");
    std::fs::set_permissions(r.socket(), std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::set_permissions(r.socket().parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let (code, err) = r.run(&[], CALL);
    assert_ne!(code, 0);
    assert!(err.contains("0700"), "{err}");
    assert_eq!(r.log(), Vec::<String>::new());
}

#[test]
fn a_relative_tmm_socket_is_a_usage_error_with_nothing_sent() {
    let r = Rig::new(Some((Act::Answer, None)), Act::Answer);
    let (code, err) = r.run(&[("TMM_SOCKET", "rel/gateway.sock")], CALL);
    assert_eq!(code, 5, "{err}");
    assert!(err.contains("TMM_SOCKET must be an absolute path"), "{err}");
    assert_eq!(r.log(), Vec::<String>::new(), "no socket and no TCP were tried");
}

#[test]
fn a_dropped_tcp_handshake_names_the_lockout_as_a_possible_cause() {
    // A listener that accepts and closes at once, as a locked-out gateway does.
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("ws://{}", l.local_addr().unwrap());
    std::thread::spawn(move || { for s in l.incoming() { drop(s); } });
    let dir = PathBuf::from(format!("/tmp/t440d-{}", uuid_like()));
    std::fs::create_dir_all(dir.join("tmux-mobile")).unwrap();
    std::fs::write(dir.join("tmux-mobile/config.toml"), "token = \"t\"\nport = 1\n").unwrap();
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(["agent", "list", "--server", &url])
        .env_clear().env("PATH", "/usr/bin:/bin").env("HOME", &dir).env("XDG_CONFIG_HOME", &dir).env("TMM_PROJECT", "p")
        .output().unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("possibly the per-IP auth lockout"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
    assert!(!Path::new(&dir).exists());
}
