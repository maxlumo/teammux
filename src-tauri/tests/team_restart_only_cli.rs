//! `tmm agent restart --team <team> --only <name>[,<name>]` through the REAL
//! CLI against a FAKE server (board #46). `hub_team_restart` has taken `only`
//! since #286 (the retry of the members that failed); the CLI did not expose
//! it, so restarting ONE member to apply its new definition meant restarting
//! the whole team, busy members included. A name the team does not have is
//! an error, never a silent "nothing to do".
//!
//! The fake speaks what `try_rpc` speaks: plain token auth as id 1, one call
//! as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// The fake team's members, all live.
const MEMBERS: &[&str] = &["lead", "val"];

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

/// `hub_team_restart` answers as the real one does for a team whose members
/// are all still in its definition: every member, or those `only` names.
fn fake() -> Fake {
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
                let login = serde_json::json!({ "id": 1, "result": { "ok": true, "authenticated": true, "caps": [] } });
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let params = call["params"].clone();
                seen.lock().unwrap().push((call["method"].as_str().unwrap_or_default().to_string(), params.clone()));
                let restarted: Vec<&str> = match params["only"].as_array() {
                    Some(only) => MEMBERS.iter().copied().filter(|m| only.iter().any(|o| o == m)).collect(),
                    None => MEMBERS.to_vec(),
                };
                let body = serde_json::json!({ "id": 2, "result": { "restarted": restarted, "spawned": [], "stopped": [], "kept": [], "errors": [] } });
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    Fake { calls, addr: format!("ws://{}", rx.recv().unwrap()) }
}

impl Fake {
    fn run(&self, args: &[&str]) -> (i32, String, String) {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", { let h = tmux_mobile::config::test_scratch("tmm-home"); std::fs::create_dir_all(&h).unwrap(); h })
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", "t")
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "lead")
            .output()
            .unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }
    fn restarts(&self) -> Vec<serde_json::Value> {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == "hub_team_restart").map(|(_, p)| p.clone()).collect()
    }
}

#[test]
fn only_restarts_the_named_member_and_no_one_else() {
    let f = fake();
    let (code, out, err) = f.run(&["agent", "restart", "--team", "sq", "--only", "val"]);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(out.trim(), "✓ restarted: val");
    assert_eq!(f.restarts(), vec![serde_json::json!({ "session": "p", "team": "sq", "only": ["val"] })]);
}

#[test]
fn a_comma_list_names_several_members() {
    let f = fake();
    let (code, out, err) = f.run(&["agent", "restart", "--team", "sq", "--only", "val, lead"]);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(f.restarts()[0]["only"], serde_json::json!(["val", "lead"]));
}

#[test]
fn without_only_the_whole_team_is_aligned_as_before() {
    let f = fake();
    let (code, out, _) = f.run(&["agent", "restart", "--team", "sq"]);
    assert_eq!(code, 0);
    assert_eq!(out.trim(), "✓ restarted: lead, val");
    assert_eq!(f.restarts(), vec![serde_json::json!({ "session": "p", "team": "sq" })]);
}

#[test]
fn a_name_the_team_does_not_have_is_an_error_not_silence() {
    let f = fake();
    let (code, out, err) = f.run(&["agent", "restart", "--team", "sq", "--only", "val,ghost"]);
    assert_eq!(code, 1, "{out}{err}");
    assert!(out.contains("✓ restarted: val"), "{out}");
    assert!(err.contains("ghost") && err.contains("sq"), "{err}");
}

#[test]
fn only_without_names_or_without_a_team_is_a_usage_error_and_sends_nothing() {
    let f = fake();
    for args in [
        &["agent", "restart", "--team", "sq", "--only", " , "][..],
        &["agent", "restart", "--team", "sq", "--only"][..],
        &["agent", "restart", "val", "--only", "val"][..],
    ] {
        let (code, _, err) = f.run(args);
        assert_eq!(code, 5, "{args:?}: {err}");
        assert!(err.contains("--only"), "{args:?}: {err}");
    }
    assert!(f.restarts().is_empty(), "nothing was sent");
}
