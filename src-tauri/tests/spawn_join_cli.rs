//! `tmm spawn --join` through the REAL CLI against a FAKE server (board #382,
//! reviewer P1-A on 56a3ad44). An older server ignores the `join` key and
//! spawns the agent standalone, then answers success: a join the person asked
//! for, silently not done. So a join is refused unless THIS connection's login
//! announced `spawn_join`, before the spawn is sent; a standalone spawn needs
//! nothing and works against any server.
//!
//! The fake speaks exactly what `try_rpc` speaks: plain token auth as id 1,
//! one call as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fake {
    /// Every call the CLI made: (method, params).
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

/// A server whose login answer carries `caps` (None = an older server, no
/// `caps` at all). `hub_spawn` answers the way the real one does.
fn fake(caps: Option<&'static [&'static str]>) -> Fake {
    let calls: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().to_string()).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let seen = seen.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = match caps {
                    Some(c) => serde_json::json!({ "id": 1, "result": { "ok": true, "authenticated": true, "caps": c } }),
                    None => serde_json::json!({ "id": 1, "result": { "ok": true, "authenticated": true } }),
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                // A refused join closes the socket here: nothing more to read.
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method, call["params"].clone()));
                // The real hub_spawn names the team it joined, null when none;
                // an older one never names one.
                let team = if caps.is_some() { call["params"]["join"].clone() } else { serde_json::Value::Null };
                let body = serde_json::json!({ "id": 2, "result": { "window_name": "helper", "pane": "%1", "backend": "kiro", "team": team } });
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    Fake { calls, addr: format!("ws://{}", rx.recv().unwrap()) }
}

impl Fake {
    fn run(&self, args: &[&str]) -> (bool, String, String) {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", std::env::temp_dir())
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", "t")
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "lead")
            .output()
            .unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }
    fn spawns(&self) -> Vec<serde_json::Value> {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == "hub_spawn").map(|(_, p)| p.clone()).collect()
    }
}

#[test]
fn a_join_against_a_server_without_spawn_join_spawns_nothing() {
    let old = fake(None);
    let (ok, out, err) = old.run(&["spawn", "helper", "--join", "squad"]);
    assert!(!ok, "refused: {out}");
    assert!(err.contains("lacks `spawn_join`") && err.contains("update the server to join. Nothing was spawned."), "{err}");
    assert!(old.spawns().is_empty(), "nothing was sent, so nothing can have started standalone");

    // Announcing other caps is not announcing this one.
    let dispatch_only = fake(Some(&["board_dispatch"]));
    let (ok, _, _) = dispatch_only.run(&["spawn", "helper", "--join", "squad"]);
    assert!(!ok);
    assert!(dispatch_only.spawns().is_empty());
}

#[test]
fn a_standalone_spawn_needs_no_cap_and_a_join_with_it_is_sent_once() {
    let old = fake(None);
    let (ok, out, err) = old.run(&["spawn", "helper"]);
    assert!(ok, "{err}");
    assert_eq!(out.trim(), "✓ spawned helper");
    let sent = old.spawns();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].get("join").is_none(), "standalone carries no join: {}", sent[0]);

    let new = fake(Some(&["board_dispatch", "spawn_join"]));
    let (ok, out, err) = new.run(&["spawn", "helper", "--join", "squad"]);
    assert!(ok, "{err}");
    assert_eq!(out.trim(), "✓ spawned helper (joined team squad)");
    let sent = new.spawns();
    assert_eq!(sent.len(), 1, "one spawn");
    assert_eq!(sent[0]["join"], "squad");
}
