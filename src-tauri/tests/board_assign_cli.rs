//! `tmm board assign` through the REAL CLI against a FAKE server (board #367
//! review P1-B). The verb is two RPCs with a persistent write between them,
//! so the only honest test of its failure paths is the staged one: a server
//! that answers the reads, accepts the save, and then loses the hand-off's
//! response. A pure test of `assign_brief` cannot see any of this — the `-`
//! that never reached the parser was the first proof of that.
//!
//! The fake speaks exactly what `try_rpc` speaks: plain token auth as id 1,
//! one call as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// What the fake does with one method's call.
#[derive(Clone, Copy, PartialEq)]
enum Act {
    /// Answer with the canned result.
    Answer,
    /// Answer with a JSON-RPC error.
    Error,
    /// Accept the request and then drop the socket: the server may well have
    /// DONE it, and only the answer was lost. That is the case the CLI must
    /// not describe as "not posted".
    LoseAnswer,
}

struct Fake {
    /// Every method the CLI called, in order.
    calls: Arc<Mutex<Vec<String>>>,
    /// The issue's assignee, as the fake's own state: a `hub_board_save`
    /// writes it and the next `hub_board_get` reads it back. Without this a
    /// "re-run" is only ever `"" → name` and the same-assignee contract is
    /// untested (reviewer's P2 on c7751e21).
    assignee: Arc<Mutex<String>>,
    addr: String,
}

/// Serve `tmm`'s connections until the process is done with us. `plan` maps a
/// method to what to do with it; anything unlisted is answered `{}`.
fn fake(plan: Vec<(&'static str, Act)>) -> Fake {
    fake_with(plan, "")
}

/// The same fake, with the issue already assigned to `assignee`.
fn fake_with(plan: Vec<(&'static str, Act)>, assignee: &str) -> Fake {
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let state: Arc<Mutex<String>> = Arc::new(Mutex::new(assignee.to_string()));
    let held = state.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().to_string()).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let seen = seen.clone();
                let plan = plan.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                // id 1: auth.
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let _ = ws
                    .send(Message::Text(r#"{"id":1,"result":{"ok":true}}"#.to_string().into()))
                    .await;
                // id 2: the one call.
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push(method.clone());
                let act = plan
                    .iter()
                    .find(|(m, _)| *m == method)
                    .map(|(_, a)| *a)
                    .unwrap_or(Act::Answer);
                // The state changes only when the save really HAPPENS
                // (reviewer's P2 on 0176c02e): an `Act::Error` save must
                // leave the assignee as it was, or "the save did not happen"
                // is a claim the fake quietly contradicts. `LoseAnswer` DOES
                // write — the request was accepted and only its reply is
                // lost, which is the whole point of that case.
                if method == "hub_board_save" && act != Act::Error {
                    if let Some(a) = call["params"]["assignee"].as_str() {
                        *held.lock().unwrap() = a.to_string();
                    }
                }
                let current = held.lock().unwrap().clone();
                if act == Act::LoseAnswer {
                    // Accepted, never answered: the request may have run.
                    drop(ws);
                    continue;
                }
                let body = match (method.as_str(), act) {
                    (_, Act::Error) => serde_json::json!({ "id": 2, "error": { "code": -32603, "message": "boom" } }),
                    ("hub_board_get", _) => serde_json::json!({ "id": 2, "result": {
                        "id": 12, "title": "Fix the login flow", "body": "", "status": "todo",
                        "assignee": current, "created_by": "human", "notes": []
                    }}),
                    ("hub_agents", _) => serde_json::json!({ "id": 2, "result": {
                        "agents": [{ "name": "builder-2", "managed": true }], "session": "p"
                    }}),
                    _ => serde_json::json!({ "id": 2, "result": { "ok": true, "id": 12 } }),
                };
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    let addr = rx.recv().unwrap();
    Fake { calls, assignee: state, addr: format!("ws://{addr}") }
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
            .env("TMM_AGENT", "orchestrator")
            .output()
            .unwrap();
        (
            out.status.success(),
            String::from_utf8_lossy(&out.stdout).to_string(),
            String::from_utf8_lossy(&out.stderr).to_string(),
        )
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn assignee(&self) -> String {
        self.assignee.lock().unwrap().clone()
    }
}

/// The save landed and the hand-off's answer was LOST. The assignment is a
/// fact; the notification is UNKNOWN — it may well have been posted. The CLI
/// has to say both, and must not fabricate "was not posted" (reviewer's
/// P1-B-1: a lost response is not a failed request).
#[test]
fn a_lost_handoff_answer_is_reported_as_unconfirmed_not_as_a_failure() {
    let f = fake(vec![("hub_post", Act::LoseAnswer)]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(!ok, "a command that could not finish exits non-zero");
    assert!(out.contains("#12") && out.contains("builder-2"), "the assignment that landed is said: {out:?}");
    assert!(out.contains("saved"), "{out:?}");
    let said = format!("{out}{err}");
    assert!(said.contains("could not be confirmed"), "the uncertainty is named: {said:?}");
    assert!(said.contains("may already have been posted"), "{said:?}");
    assert!(said.contains("may duplicate"), "the re-run's cost is named: {said:?}");
    assert!(!said.contains("was NOT posted") && !said.contains("has not been told"),
        "no fabricated certainty: {said:?}");
    assert_eq!(
        f.calls(),
        vec!["hub_board_get", "hub_agents", "hub_board_save", "hub_post"],
        "the issue is read, the name checked, then saved, then handed off"
    );
}

/// The same failure in `--output json`: a machine caller gets the partial
/// result instead of a human sentence (reviewer's P1-B-2).
#[test]
fn the_partial_result_is_machine_readable_in_json_mode() {
    let f = fake(vec![("hub_post", Act::LoseAnswer)]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2", "--output", "json"]);
    assert!(!ok);
    let v: serde_json::Value = serde_json::from_str(out.trim()).expect(&format!("stdout must be JSON: {out:?}"));
    assert_eq!(v["issue"], 12);
    assert_eq!(v["assignee"], "builder-2");
    assert_eq!(v["saved"], true);
    assert_eq!(v["notified"], "unconfirmed");
    assert!(err.contains("could not be confirmed"), "the explanation goes to stderr: {err:?}");
}

/// A save that really failed is a failure with nothing to report: no
/// hand-off is attempted, so nobody is told about an assignment that does
/// not exist.
#[test]
fn a_failed_save_posts_nothing() {
    let f = fake_with(vec![("hub_board_save", Act::Error)], "dev");
    let (ok, _out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(!ok);
    assert!(err.contains("boom"), "{err:?}");
    assert!(!f.calls().contains(&"hub_post".to_string()), "{:?}", f.calls());
    assert_eq!(f.assignee(), "dev", "the save did not happen: nobody was reassigned");
}

/// A name this project does not run is refused at the door, before any
/// write: an assignment to a typo is an issue nobody is doing.
#[test]
fn an_unknown_name_writes_nothing() {
    let f = fake(vec![]);
    let (ok, _out, err) = f.run(&["board", "assign", "12", "buildr-2"]);
    assert!(!ok);
    assert!(err.contains("no managed agent named buildr-2"), "{err:?}");
    let calls = f.calls();
    assert!(!calls.contains(&"hub_board_save".to_string()), "{calls:?}");
    assert!(!calls.contains(&"hub_post".to_string()), "{calls:?}");
}

/// The whole path when nothing goes wrong: the issue read, the name checked,
/// the save, the hand-off — in that order and no more. (The hand-off's one
/// ADDRESS is asserted where it is decided, on `assign_brief` through
/// `mention_names`; this test watches the calls, not the text.)
#[test]
fn a_clean_assignment_makes_the_four_calls_in_order() {
    let f = fake(vec![]);
    let (ok, out, _err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(ok, "{out:?}");
    assert!(out.contains("✓ #12 → builder-2"), "{out:?}");
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_agents", "hub_board_save", "hub_post"]);
}

/// Re-running with the SAME assignee is the documented recovery path after a
/// hand-off whose answer was lost, so it is not a no-op: the save is idempotent
/// and the notification is sent again (tmm-cli.md says so, and says it may
/// duplicate). This case is what keeps that contract from being quietly
/// "optimised" into a skip, which would leave the only recovery path dead.
#[test]
fn re_running_with_the_same_assignee_re_sends_the_hand_off() {
    // ALREADY assigned to the same name, so the second run really is
    // builder-2 → builder-2 (the fake carries the assignee between calls).
    let f = fake_with(vec![], "builder-2");
    let (ok, out, _err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(ok, "{out:?}");
    assert_eq!(f.assignee(), "builder-2", "the save is a no-op on the board");
    assert_eq!(
        f.calls(),
        vec!["hub_board_get", "hub_agents", "hub_board_save", "hub_post"],
        "and the hand-off goes out anyway — that is the recovery path after a lost answer"
    );
    // The clear-then-same sequence a human would type is the same contract.
    let (ok, _out, _err) = f.run(&["board", "assign", "12", "-"]);
    assert!(ok);
    assert_eq!(f.assignee(), "", "`-` really cleared it in the fake's state");
}

/// `-` clears, which needs no hand-off: nobody to tell.
#[test]
fn clearing_tells_nobody() {
    let f = fake(vec![]);
    let (ok, out, _err) = f.run(&["board", "assign", "12", "-"]);
    assert!(ok, "{out:?}");
    assert!(out.contains("unassigned"), "{out:?}");
    let calls = f.calls();
    assert!(calls.contains(&"hub_board_save".to_string()), "{calls:?}");
    assert!(!calls.contains(&"hub_post".to_string()), "{calls:?}");
    assert!(!calls.contains(&"hub_agents".to_string()), "no name to check: {calls:?}");
}
