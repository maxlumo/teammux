//! `tmm ask` (board #106) through the REAL CLI against a FAKE server: what
//! the CLI sends, that it refuses BEFORE sending on a server without `asks`,
//! and that a refused close exits non-zero with nothing claimed. The doors and
//! the state machine are the server's (`server/ask_tests.rs`,
//! `projects/store/asks.rs`).
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

fn ask(state: &str, closing: Option<&str>) -> serde_json::Value {
    let said = closing.map(|_| if state == "withdrawn" { "withdrawn: answered in chat".to_string() } else { "A · own row".to_string() });
    let long = format!("[re leader 07:40: 「＠human [ask] Desktop Aggregate: {}…」] ", "x".repeat(200));
    serde_json::json!({
        "said": said, "closing": closing.map(|c| format!("@leader {long}{c}")),
        "seq": 41, "asker": "leader", "question": "Desktop Aggregate: name on its own row?\nsecond line",
        "options": [{ "key": "A", "label": "own row" }, { "key": "B", "label": "disk to the card" }],
        "recommend": "A", "issue": 103, "state": state, "delivery": closing.map(|_| "found"),
    })
}

/// `caps`: whether the login answer announces `asks`; `close_applies`:
/// whether a withdrawal moves the state (else the fake answers as for an
/// ask somebody already answered).
fn fake(caps: bool, close_applies: bool) -> Fake {
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
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch","asks"]}}"#
                } else {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch"]}}"#
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let result = match method.as_str() {
                    "hub_ask" => serde_json::json!({ "ask": ask("open", None) }),
                    "hub_ask_list" => serde_json::json!({ "asks": [ask("open", None), ask("answered", Some("@leader [re …] A · own row"))] }),
                    "hub_ask_withdraw" if close_applies => serde_json::json!({ "applied": true, "ask": ask("withdrawn", Some("withdrawn: answered in chat")) }),
                    "hub_ask_withdraw" => serde_json::json!({ "applied": false, "refused": "already answered at 07:40", "ask": ask("answered", Some("@leader [re …] A · own row")) }),
                    _ => serde_json::json!({ "ok": true }),
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
            .env("TMM_AGENT", "leader")
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

#[test]
fn ask_sends_the_structure_once_and_prints_the_id() {
    let f = fake(true, true);
    let (ok, out, err) = f.run(&["ask", "Desktop Aggregate: name on its own row?", "--option", "A=own row", "--option", "B=disk to the card", "--recommend", "A", "--issue", "#103"]);
    assert!(ok, "{out:?} {err:?}");
    assert_eq!(f.methods(), vec!["hub_ask"]);
    let p = f.params_of("hub_ask");
    assert_eq!(p["from"], "leader");
    assert_eq!(p["question"], "Desktop Aggregate: name on its own row?");
    assert_eq!(p["options"], serde_json::json!([{ "key": "A", "label": "own row" }, { "key": "B", "label": "disk to the card" }]));
    assert_eq!((p["recommend"].as_str(), p["issue"].as_i64()), (Some("A"), Some(103)));
    assert!(out.contains("ask #41 is open"), "{out:?}");
}

#[test]
fn a_malformed_ask_is_refused_before_anything_is_sent() {
    let f = fake(true, true);
    for args in [vec!["ask"], vec!["ask", "q", "--option", "no-equals"], vec!["ask", "q", "--issue", "x"], vec!["ask", "close", "41"], vec!["ask", "close", "nope", "why"]] {
        let (ok, _, err) = f.run(&args);
        assert!(!ok, "{args:?} {err:?}");
    }
    assert!(f.methods().is_empty(), "{:?}", f.methods());
}

#[test]
fn an_older_server_is_refused_before_the_ask_is_sent() {
    let f = fake(false, true);
    for args in [vec!["ask", "q?"], vec!["ask", "list"], vec!["ask", "close", "41", "why"]] {
        let (ok, _, err) = f.run(&args);
        assert!(!ok, "{args:?}");
        assert!(err.contains("older than asks") && err.contains("Nothing was sent"), "{err:?}");
    }
    assert!(f.methods().is_empty(), "nothing reached the server: {:?}", f.methods());
}

#[test]
fn list_prints_open_and_closed_asks_with_their_answers() {
    let f = fake(true, true);
    let (ok, out, err) = f.run(&["ask", "list", "--all"]);
    assert!(ok, "{err:?}");
    assert_eq!(f.params_of("hub_ask_list")["all"], true);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines[0], "#41    open      leader: Desktop Aggregate: name on its own row?  [A*=own row | B=disk to the card]");
    assert!(lines[1].starts_with("#41    answered  leader:"), "{out}");
    // The answer itself, whole, however long the quote of the question in the
    // closing body is (validator F3).
    assert_eq!(lines[2], "        -> A · own row  (delivery: found)");
}

#[test]
fn close_withdraws_with_why_and_the_cited_message_and_a_refusal_exits_non_zero() {
    let f = fake(true, true);
    let (ok, out, err) = f.run(&["ask", "close", "#41", "answered", "in", "chat", "--re", "5120"]);
    assert!(ok, "{out:?} {err:?}");
    let p = f.params_of("hub_ask_withdraw");
    assert_eq!((p["seq"].as_i64(), p["from"].as_str(), p["why"].as_str(), p["re"].as_str()), (Some(41), Some("leader"), Some("answered in chat"), Some("5120")));
    assert!(out.contains("withdrew ask #41"), "{out:?}");

    let late = fake(true, false);
    let (ok, out, err) = late.run(&["ask", "close", "41", "too late"]);
    assert!(!ok, "a refused close is a failure: {out:?}");
    assert!(err.contains("already answered at 07:40") && err.contains("nothing was written"), "{err:?}");
    assert!(!out.contains("withdrew"), "{out:?}");
}
