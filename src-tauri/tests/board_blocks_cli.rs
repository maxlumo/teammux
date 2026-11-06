//! `tmm board` blocking edges and the frontier (board #43) through the REAL
//! CLI against a FAKE server. What these tests watch is what the CLI sends
//! (`blocked_by` on a create, `hub_board_block` for an edit), that it refuses
//! BEFORE writing on a server without `board_blocks`, and that `frontier`
//! filters on the server's own `blocked`, never a second rule. The edge
//! rules themselves (cycle, self, another board) are the store's, pinned in
//! `projects/store/board.rs`.
//!
//! The fake speaks what `try_rpc` speaks: token auth as id 1, one call as
//! id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

/// The board the fake serves: #38 in doing, #39 doing and blocked by #38,
/// #40 done, #41 todo blocked by the done #40, #42 todo with no edge.
fn board() -> serde_json::Value {
    serde_json::json!({
        "statuses": ["todo", "doing", "review", "done"],
        "issues": [
            { "id": 38, "title": "Restart ends the turn", "status": "doing", "assignee": "builder", "created_by": "orchestrator", "notes": 3, "blocked_by": [], "blocked": false },
            { "id": 39, "title": "Report provider failures", "status": "doing", "assignee": "builder-2", "created_by": "orchestrator", "notes": 2, "blocked_by": [38], "blocked": true },
            { "id": 40, "title": "Shipped already", "status": "done", "assignee": "", "created_by": "human", "notes": 0, "blocked_by": [], "blocked": false },
            { "id": 41, "title": "After the shipped one", "status": "todo", "assignee": "", "created_by": "human", "notes": 0, "blocked_by": [40], "blocked": false },
            { "id": 42, "title": "Free standing", "status": "todo", "assignee": "", "created_by": "human", "notes": 0, "blocked_by": [], "blocked": false }
        ]
    })
}

/// `caps`: whether the login answer announces `board_blocks` (an older
/// server announces only `board_dispatch`).
fn fake(caps: bool) -> Fake {
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
                let login = if caps {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch","board_blocks"]}}"#
                } else {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch"]}}"#
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let result = match method.as_str() {
                    "hub_board_list" => board(),
                    "hub_board_get" => {
                        let id = call["params"]["id"].as_i64().unwrap_or(0);
                        let mut issue = board()["issues"].as_array().unwrap().iter().find(|i| i["id"] == id).cloned().unwrap_or(serde_json::json!({}));
                        issue["notes"] = serde_json::json!([]);
                        issue["body"] = serde_json::json!("");
                        issue
                    }
                    "hub_board_block" => serde_json::json!({
                        "ok": true,
                        "added": call["params"]["add"].clone(),
                        "removed": call["params"]["remove"].clone(),
                        "issue": { "id": call["params"]["id"], "blocked_by": [38], "blocked": true }
                    }),
                    _ => serde_json::json!({ "ok": true, "id": 43 }),
                };
                let body = serde_json::json!({ "id": 2, "result": result });
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    let addr = rx.recv().unwrap();
    Fake { calls, addr: format!("ws://{addr}") }
}

impl Fake {
    fn run(&self, args: &[&str]) -> (bool, String, String) {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", { let h = tmux_mobile::config::test_scratch("tmm-home"); std::fs::create_dir_all(&h).unwrap(); h })
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", "t")
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "orchestrator")
            .output()
            .unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }
    fn methods(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
    }
    fn params_of(&self, method: &str) -> serde_json::Value {
        let calls = self.calls.lock().unwrap();
        calls.iter().find(|(m, _)| m == method).map(|(_, p)| p.clone()).unwrap_or_else(|| panic!("{method} was never called"))
    }
}

/// `add --blocked-by` files the issue WITH its edges in the one save.
#[test]
fn add_with_blocked_by_files_the_issue_with_its_edges_in_one_save() {
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "add", "Wire the frontier", "--blocked-by", "38,#39"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(f.methods(), vec!["hub_board_save"]);
    assert_eq!(f.params_of("hub_board_save")["blocked_by"], serde_json::json!([38, 39]));
    assert!(out.contains("#43"), "{out:?}");
}

/// A server without `board_blocks` would file the issue edge-less as if it
/// had worked: the CLI refuses before anything is sent.
#[test]
fn an_older_server_is_refused_before_any_edge_is_written() {
    let f = fake(false);
    let (ok, _, err) = f.run(&["board", "add", "Wire the frontier", "--blocked-by", "38"]);
    assert!(!ok);
    assert!(err.contains("older"), "{err:?}");
    let (ok, _, _) = f.run(&["board", "block", "39", "38"]);
    assert!(!ok);
    assert!(!f.methods().iter().any(|m| m == "hub_board_save" || m == "hub_board_block"), "{:?}", f.methods());
}

/// `block` and `unblock` are the edit verbs: one `hub_board_block` each.
#[test]
fn block_and_unblock_send_one_edit_each() {
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "block", "39", "38,41"]);
    assert!(ok, "{out:?} {err:?}");
    let p = f.params_of("hub_board_block");
    assert_eq!((p["id"].clone(), p["add"].clone(), p["remove"].clone()), (serde_json::json!(39), serde_json::json!([38, 41]), serde_json::Value::Null));
    assert!(out.contains("#39"), "{out:?}");

    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "unblock", "#39", "38"]);
    assert!(ok, "{out:?} {err:?}");
    let p = f.params_of("hub_board_block");
    assert_eq!((p["add"].clone(), p["remove"].clone()), (serde_json::Value::Null, serde_json::json!([38])));
}

/// A malformed list is a usage error, and nothing is sent.
#[test]
fn a_malformed_issue_list_is_refused_before_any_call() {
    let f = fake(true);
    for args in [
        vec!["board", "block", "39", "38,x"],
        vec!["board", "block", "39"],
        vec!["board", "unblock", "x", "38"],
        vec!["board", "add", "t", "--blocked-by", ""],
    ] {
        let (ok, _, err) = f.run(&args);
        assert!(!ok, "{args:?} must fail");
        assert!(err.contains("issue"), "{args:?}: {err:?}");
    }
    assert!(f.methods().is_empty(), "{:?}", f.methods());
}

/// The frontier is every NOT-done issue whose blockers are all done, with its
/// status; it reads the server's `blocked`, never a second rule.
#[test]
fn frontier_lists_open_issues_whose_blockers_are_all_done() {
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "frontier"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(f.methods(), vec!["hub_board_list"]);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert!(lines[0].starts_with("#38") && lines[0].contains("doing"), "{out}");
    assert!(lines[1].starts_with("#41") && lines[1].contains("todo"), "{out}");
    assert!(lines[2].starts_with("#42") && lines[2].contains("todo"), "{out}");
    assert!(!out.contains("#39 "), "blocked by the doing #38: {out}");
    assert!(!out.contains("#40 "), "done is not on the frontier: {out}");

    // JSON: the same issues, as the server shaped them.
    let (ok, out, _) = f.run(&["board", "frontier", "--output", "json"]);
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    let ids: Vec<i64> = v["issues"].as_array().unwrap().iter().map(|i| i["id"].as_i64().unwrap()).collect();
    assert_eq!(ids, vec![38, 41, 42]);
}

/// `list` and `show` say what blocks an issue, and whether it still does.
#[test]
fn list_and_show_name_the_blockers() {
    let f = fake(true);
    let (ok, out, _) = f.run(&["board", "list"]);
    assert!(ok);
    let row = out.lines().find(|l| l.contains("#39")).unwrap();
    assert!(row.contains("blocked by #38"), "{row:?}");
    let free = out.lines().find(|l| l.contains("#41")).unwrap();
    assert!(!free.contains("blocked"), "a done blocker no longer blocks: {free:?}");

    let (ok, out, _) = f.run(&["board", "show", "39"]);
    assert!(ok);
    assert!(out.contains("blocked by #38"), "{out:?}");
}
