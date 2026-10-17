//! `tmm project archive|unarchive|delete` through the REAL CLI against a FAKE
//! server (board #415). `unarchive` is the recycle bin's restore: it finds an
//! ARCHIVED project by its session and sends `project_archive` with
//! `archived: false`, and neither archive verb brings the session down or
//! deletes anything. A delete that kept the homes says why.
//!
//! The fake speaks exactly what `try_rpc` speaks: token auth as id 1, one call
//! as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Calls = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

/// A server with one archived project, `parked` (id `parked-1`), that records
/// every call and answers a delete with `delete_answer`.
fn fake(delete_answer: serde_json::Value) -> (String, Calls) {
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().to_string()).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = r#"{"id":1,"result":{"ok":true,"authenticated":true}}"#;
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let result = match method.as_str() {
                    "project_list" => {
                        // Only an include_archived listing has the parked project.
                        let rows = if call["params"]["include_archived"] == true {
                            serde_json::json!([{ "project": { "id": "parked-1", "session": "parked", "name": "parked", "archived": true } }])
                        } else {
                            serde_json::json!([])
                        };
                        serde_json::json!({ "projects": rows })
                    }
                    "project_archive" => serde_json::json!({ "id": "parked-1", "archived": call["params"]["archived"].as_bool().unwrap_or(true) }),
                    "project_delete" => delete_answer.clone(),
                    _ => serde_json::json!({}),
                };
                let body = serde_json::json!({ "id": 2, "result": result });
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    (format!("ws://{}", rx.recv().unwrap()), calls)
}

fn run(server: &str, args: &[&str]) -> (bool, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", std::env::temp_dir())
        .env("TMM_SERVER", server)
        .env("TMM_TOKEN", "t")
        .env("TMM_PROJECT", "p")
        .env("TMM_AGENT", "orchestrator")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

fn methods(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
}

#[test]
fn unarchive_restores_an_archived_project_and_touches_nothing_else() {
    let (server, calls) = fake(serde_json::json!({}));
    let (ok, out, err) = run(&server, &["project", "unarchive", "parked"]);
    assert!(ok, "{out:?} {err:?}");
    assert!(out.contains("✓ unarchive parked"), "{out:?}");
    assert_eq!(methods(&calls), ["project_list", "project_archive"], "no down, no delete");
    let list = calls.lock().unwrap()[0].1.clone();
    assert_eq!(list["include_archived"], true, "an archived project is found by its session");
    let archive = calls.lock().unwrap()[1].1.clone();
    assert_eq!(archive, serde_json::json!({ "id": "parked-1", "archived": false }));
}

#[test]
fn archive_still_archives_by_default() {
    let (server, calls) = fake(serde_json::json!({}));
    let (ok, out, err) = run(&server, &["project", "archive", "parked"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(methods(&calls), ["project_list", "project_archive"]);
    let archive = calls.lock().unwrap()[1].1.clone();
    assert_eq!(archive, serde_json::json!({ "id": "parked-1" }), "no archived:false: the server's default, true");
}

#[test]
fn a_delete_that_kept_the_homes_says_who_keeps_them_and_why() {
    let (server, calls) = fake(serde_json::json!({
        "id": "parked-1", "deleted": true, "agent_homes_removed": 0,
        "agent_homes_kept_for": [
            { "project": "tmux-mobile", "reason": "declared" },
            { "project": "odd", "reason": "unresolved" }
        ]
    }));
    let (ok, out, err) = run(&server, &["project", "delete", "parked"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(methods(&calls), ["project_list", "project_delete"]);
    assert!(out.contains("✓ delete parked"), "{out:?}");
    assert!(out.contains("agent homes kept: the directory is also declared by tmux-mobile"), "{out:?}");
    assert!(out.contains("agent homes kept: the path of odd could not be resolved"), "{out:?}");

    let (server, _) = fake(serde_json::json!({ "id": "parked-1", "deleted": true, "agent_homes_removed": 2, "agent_homes_kept_for": [] }));
    let (ok, out, _) = run(&server, &["project", "delete", "parked"]);
    assert!(ok && !out.contains("kept"), "a delete that removed them says nothing more: {out:?}");
}
