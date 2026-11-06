//! `tmm board note --agreement` and `board show`'s current agreement (board
//! #44) through the REAL CLI against a FAKE server. What these watch: the
//! note carries `agreement: true` on both note paths, an older server is
//! refused before anything is written, and `show` prints the current
//! agreement before the thread and labels the superseded one. The derivation
//! itself is the store's, pinned in `projects/store/board.rs`.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// The one issue the fake serves: its thread holds two agreements, the
/// second superseding the first.
fn issue() -> serde_json::Value {
    serde_json::json!({
        "id": 29, "title": "Restart after /new", "body": "the original brief", "status": "doing",
        "assignee": "builder-2", "created_by": "orchestrator", "blocked_by": [], "blocked": false,
        "agreement": { "n": 3, "author": "orchestrator", "body": "agreed: resume only a proven rollout", "at": 300 },
        "notes": [
            { "n": 1, "author": "builder-2", "body": "plan", "at": 100, "agreement": false, "superseded_by": null },
            { "n": 2, "author": "orchestrator", "body": "agreed: resume the newest thread", "at": 200, "agreement": true, "superseded_by": 3 },
            { "n": 3, "author": "orchestrator", "body": "agreed: resume only a proven rollout", "at": 300, "agreement": true, "superseded_by": null }
        ]
    })
}

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

/// `caps`: whether the login answer announces `board_agreement` (an older
/// server announces the rest).
fn fake(caps: bool) -> Fake {
    fake_board(caps, board())
}

/// The same fake serving `served` as its board.
fn fake_board(caps: bool, served: serde_json::Value) -> Fake {
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
                let served = served.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = if caps {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch","board_notify","board_blocks","board_agreement"]}}"#
                } else {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch","board_notify","board_blocks"]}}"#
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let result = match method.as_str() {
                    "hub_board_list" => served.clone(),
                    "hub_board_get" => issue(),
                    "hub_board_note" if call["params"].get("notify").is_some() => serde_json::json!({
                        "ok": true, "note": "stored", "recipients": ["builder-2"], "line": "x",
                        "room": { "state": "recorded", "seq": 1, "id": "m1" },
                        "announce": { "attempted": ["builder-2"] },
                        "notice": { "targets": [], "attempted": [] }
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


/// `--agreement` declares the note as it is written: one call, carrying the flag.
#[test]
fn a_note_posted_as_the_agreement_carries_the_flag_in_one_call() {
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "note", "29", "agreed: resume only a proven rollout", "--agreement"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(f.methods(), vec!["hub_board_note"]);
    let p = f.params_of("hub_board_note");
    assert_eq!(p["agreement"], true);
    assert_eq!(p["body"], "agreed: resume only a proven rollout");

    // With --notify too: still one call, carrying both.
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "note", "29", "agreed", "--agreement", "--notify", "@builder-2"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(f.methods(), vec!["hub_board_note"]);
    let p = f.params_of("hub_board_note");
    assert_eq!((p["agreement"].clone(), p["notify"].clone()), (serde_json::json!(true), serde_json::json!(["builder-2"])));

    // A plain note says nothing about agreements.
    let f = fake(true);
    assert!(f.run(&["board", "note", "29", "plain"]).0);
    assert_eq!(f.params_of("hub_board_note").get("agreement"), None);
}

/// An older server would store a plain note as if it had worked: refused
/// before the call, on both note paths.
#[test]
fn an_agreement_on_an_older_server_is_refused_before_anything_is_written() {
    for args in [
        vec!["board", "note", "29", "agreed", "--agreement"],
        vec!["board", "note", "29", "agreed", "--agreement", "--notify", "@builder-2"],
    ] {
        let f = fake(false);
        let (ok, _, err) = f.run(&args);
        assert!(!ok, "{args:?}");
        assert!(err.contains("board_agreement"), "{args:?}: {err:?}");
        assert!(f.methods().is_empty(), "{args:?}: {:?}", f.methods());
    }
    // A plain note on the same older server still goes.
    let f = fake(false);
    assert!(f.run(&["board", "note", "29", "plain"]).0);
}

/// `show` prints the current agreement BEFORE the original text and the
/// thread, and labels each agreement note in the thread.
#[test]
fn show_prints_the_current_agreement_first_and_labels_the_superseded_one() {
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "show", "29"]);
    assert!(ok, "{out:?} {err:?}");
    let at = |needle: &str| out.find(needle).unwrap_or_else(|| panic!("{needle:?} not in {out}"));
    let current = at("current agreement (note 3, orchestrator): agreed: resume only a proven rollout");
    assert!(current < at("the original brief"), "{out}");
    assert!(current < at("· builder-2: plan"), "{out}");
    assert!(out.contains("· orchestrator [agreement, superseded by note 3]: agreed: resume the newest thread"), "{out}");
    assert!(out.contains("· orchestrator [agreement]: agreed: resume only a proven rollout"), "{out}");
}

/// Board #42 AC1: a notice names `#N note n`, and `--note n` prints exactly
/// that note, whole: its head, then its body, and nothing else of the issue.
/// A number the thread does not have is an error, never the nearest note.
#[test]
fn show_note_prints_exactly_the_named_note_and_refuses_one_that_is_not_there() {
    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "show", "29", "--note", "2"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(out, "#29 note 2 · orchestrator [agreement, superseded by note 3]\nagreed: resume the newest thread\n");
    assert_eq!(f.methods(), vec!["hub_board_get"]);

    let f = fake(true);
    let (ok, out, err) = f.run(&["board", "show", "29", "--note", "4"]);
    assert!(!ok, "{out:?}");
    assert!(out.is_empty(), "{out:?}");
    assert!(err.contains("#29 has no note 4") && err.contains("notes 1-3"), "{err:?}");

    let f = fake(true);
    let (ok, _, err) = f.run(&["board", "show", "29", "--note", "last"]);
    assert!(!ok);
    assert!(err.contains("--note needs a note number"), "{err:?}");
    assert!(f.methods().is_empty(), "refused before the call: {:?}", f.methods());
}
