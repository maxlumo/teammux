//! `tmm log --seq N` (board #42) through the REAL CLI against a FAKE gateway.
//! It prints exactly room row N, whole, which is what a cut `[reply]` points
//! at. What this watches: the read asks `hub_log` for the one row below N+1,
//! the row printed is N itself and never its neighbour (`seq` is one
//! store-wide counter, so a room's numbers have gaps and the row below N+1
//! can be lower), and a bad number is refused
//! before any call.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

/// The room the fake serves: rows 7 and 9; 8 is another room's.
fn rows() -> Vec<serde_json::Value> {
    let tail = format!("{}TAIL-OF-THE-WHOLE-REPLY", "x".repeat(9000));
    vec![
        serde_json::json!({ "id": "m7", "seq": 7, "ts": 0, "from": "lead", "body": "older" }),
        serde_json::json!({ "id": "m9", "seq": 9, "ts": 0, "from": "reviewer", "body": tail }),
    ]
}

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
                let login = r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":[]}}"#;
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                // hub_log's paging: the newest `limit` rows with seq < before_seq.
                let before = call["params"]["before_seq"].as_i64().unwrap_or(i64::MAX);
                let limit = call["params"]["limit"].as_i64().unwrap_or(100) as usize;
                let mut page: Vec<_> = rows().into_iter().filter(|r| r["seq"].as_i64().unwrap() < before).collect();
                let keep = page.len().saturating_sub(limit);
                page.drain(..keep);
                let result = serde_json::json!({ "messages": page, "has_more": false, "head_seq": 9 });
                let body = serde_json::json!({ "id": 2, "result": result });
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
            .env("HOME", { let h = tmux_mobile::config::test_scratch("tmm-home"); std::fs::create_dir_all(&h).unwrap(); h })
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", "t")
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "orchestrator")
            .output()
            .unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[test]
fn log_seq_prints_exactly_that_row_whole() {
    let f = fake();
    let (ok, out, err) = f.run(&["log", "--seq", "9"]);
    assert!(ok, "{out:?} {err:?}");
    assert!(out.contains("] reviewer: xxx"), "the row's sender and body: {}", &out[..80.min(out.len())]);
    assert!(out.trim_end().ends_with("TAIL-OF-THE-WHOLE-REPLY"), "the whole body, not a cut: {}", &out[out.len().saturating_sub(80)..]);
    assert_eq!(out.lines().count(), 1, "one row");
    let calls = f.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "hub_log");
    assert_eq!((calls[0].1["before_seq"].clone(), calls[0].1["limit"].clone()), (serde_json::json!(10), serde_json::json!(1)));
}

#[test]
fn log_seq_never_prints_a_neighbour_for_a_number_this_room_lacks_and_refuses_a_bad_number() {
    let f = fake();
    let (ok, out, err) = f.run(&["log", "--seq", "8"]);
    assert!(!ok, "{out:?}");
    assert!(out.is_empty(), "row 7 is not row 8: {out:?}");
    assert!(err.contains("no message 8"), "{err:?}");

    for bad in ["0", "last", "-3"] {
        let f = fake();
        let (ok, _, err) = f.run(&["log", "--seq", bad]);
        assert!(!ok, "{bad}");
        assert!(err.contains("--seq needs a message number"), "{bad}: {err:?}");
        assert!(f.calls.lock().unwrap().is_empty(), "{bad}: refused before the call");
    }
}

/// Validator, 14:53 and 14:56 on 68f14dfe: `--seq` must not panic at the top
/// of i64 (it asks for the row below N+1), and it reads ONE row, so every
/// other `log` flag is refused by name before any call. An ignored flag
/// would print a row the reader did not ask for (`--from builder` printed
/// reviewer's row).
#[test]
fn log_seq_refuses_an_out_of_range_number_and_every_other_log_flag_before_the_call() {
    let f = fake();
    let (ok, out, err) = f.run(&["log", "--seq", "9223372036854775807"]);
    assert!(!ok, "{out:?}");
    assert!(err.contains("--seq needs a message number"), "a usage error, not a panic: {err:?}");
    assert!(!err.contains("panicked"), "{err:?}");
    assert!(f.calls.lock().unwrap().is_empty());

    for extra in [
        vec!["--global"], vec!["--from", "builder"], vec!["--since", "9999999999"], vec!["--limit", "5"],
        vec!["--before", "3"], vec!["--all"], vec!["--grep", "x"], vec!["--files"], vec!["-f"], vec!["--follow"],
    ] {
        let f = fake();
        let mut args = vec!["log", "--seq", "9"];
        args.extend(extra.iter().copied());
        let (ok, out, err) = f.run(&args);
        assert!(!ok, "{extra:?}: {out:?}");
        assert!(out.is_empty(), "{extra:?}: {out:?}");
        let flag = extra[0].trim_start_matches('-');
        assert!(err.contains("--seq reads one message") && err.contains(&format!("--{flag}")), "{extra:?}: {err:?}");
        assert!(f.calls.lock().unwrap().is_empty(), "{extra:?}: refused before the call");
    }
}
