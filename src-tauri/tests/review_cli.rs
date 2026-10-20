//! `tmm review` through the REAL CLI against a FAKE gateway (board #434,
//! reviewer P1-D on 5b2a004f): the target gateway owns the path, the content
//! and the revision. tmm never canonicalizes, opens or measures the file: a
//! path that exists only on the server is sent as given, a local copy with
//! other content changes nothing in the request, `--lines` goes as numbers
//! for the server to expand in its own read, and a stale answer is an error,
//! never a success.
//!
//! The fake speaks exactly what `try_rpc` speaks: token auth as id 1, one call
//! as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Calls = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

/// A gateway whose `review_add` answers `add` (the server's own quote of
/// its own file) or, with `stale`, the stale refusal.
fn fake(stale: bool) -> (String, Calls) {
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
                    "review_add" if stale => serde_json::json!({ "stale": true, "revision": "r2" }),
                    "review_add" => serde_json::json!({ "id": "c1", "quote": "abcdef", "line": 2, "col": 1, "end_line": 2, "end_col": 7 }),
                    "review_list" => serde_json::json!({ "project_id": "p", "path": call["params"]["path"], "revision": "r1", "annotations": [] }),
                    _ => serde_json::json!({}),
                };
                let _ = ws.send(Message::Text(serde_json::json!({ "id": 2, "result": result }).to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    (format!("ws://{}", rx.recv().unwrap()), calls)
}

fn run(server: &str, cwd: &std::path::Path, args: &[&str]) -> (Option<i32>, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", std::env::temp_dir())
        .env("TMM_SERVER", server)
        .env("TMM_TOKEN", "t")
        .env("TMM_PROJECT", "p")
        .env("TMM_AGENT", "builder")
        .output()
        .unwrap();
    (out.status.code(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

fn scratch() -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("tmm-review-cli-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn a_path_that_exists_only_on_the_server_is_sent_as_given() {
    let (server, calls) = fake(false);
    let here = scratch();
    let remote = "/srv/only-on-the-gateway/src/main.rs";
    assert!(!std::path::Path::new(remote).exists());
    let (code, out, err) = run(&server, &here, &["review", "add", remote, "--lines", "2", "--note", "why"]);
    assert_eq!(code, Some(0), "{out:?} {err:?}");
    assert!(out.contains("✓ review comment c1"), "{out:?}");
    let (code, _, err) = run(&server, &here, &["review", "list", remote]);
    assert_eq!(code, Some(0), "{err:?}");
    let calls = calls.lock().unwrap().clone();
    assert_eq!(calls[0], ("review_add".to_string(), serde_json::json!({ "session": "p", "path": remote, "lines": [2, 2], "note": "why", "by": "builder" })),
        "the numbers as given, no range measured here, no revision");
    assert_eq!(calls[1].1["path"], remote);
}

#[test]
fn a_local_copy_with_other_content_changes_nothing_in_the_request() {
    let (server, calls) = fake(false);
    let here = scratch();
    // This machine has `abc` on line 2; the gateway's file says `abcdef`. A
    // client that measured its own copy would send end_col 4.
    std::fs::write(here.join("f.txt"), "one\nabc\n").unwrap();
    let (code, out, err) = run(&server, &here, &["review", "add", "f.txt", "--lines", "2", "--note", "n"]);
    assert_eq!(code, Some(0), "{out:?} {err:?}");
    let (_, params) = calls.lock().unwrap()[0].clone();
    assert_eq!(params["lines"], serde_json::json!([2, 2]));
    assert!(params.get("range").is_none() && params.get("revision").is_none(), "nothing measured or read locally: {params}");
    // A relative path is made absolute against the shell's cwd, lexically.
    assert_eq!(params["path"], here.join("f.txt").to_string_lossy().as_ref());
    assert!(out.contains("abcdef"), "the quote is the server's: {out:?}");
    // --cols goes as the inclusive numbers.
    let (code, _, _) = run(&server, &here, &["review", "add", "f.txt", "--lines", "2", "--cols", "2-4", "--note", "n"]);
    assert_eq!(code, Some(0));
    assert_eq!(calls.lock().unwrap()[1].1["cols"], serde_json::json!([2, 4]));
}

#[test]
fn a_stale_answer_is_an_error_not_a_success() {
    let (server, _) = fake(true);
    let here = scratch();
    let (code, out, err) = run(&server, &here, &["review", "add", "/srv/f.rs", "--lines", "1", "--note", "n"]);
    assert_eq!(code, Some(1), "{out:?} {err:?}");
    assert!(err.contains("changed while the comment was added"), "{err:?}");
    assert!(!out.contains('✓'), "never printed as stored: {out:?}");
}
