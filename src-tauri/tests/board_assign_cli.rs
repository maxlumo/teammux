//! `tmm board assign` through the REAL CLI against a FAKE server (board #367,
//! reshaped by #377). The verb used to be two RPCs with a persistent write
//! between them (save, then post the hand-off), and the only honest test of
//! its failure paths was a server that lost the second answer. The server now
//! makes the hand-off inside the save, so the CLI makes ONE write: what these
//! tests watch is the calls it makes, what that write carries, and what it
//! says when the answer is bad, lost, or reports an absent agent. The hand-off
//! TEXT and its single delivery are pinned where they are made, in
//! `server/hub_rpc.rs`.
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
    /// not describe as success.
    LoseAnswer,
    /// Answer a save the way the server does when the hand-off reached no
    /// pane (`dispatch: "offline"` with hub_post's `offline` rows, board
    /// #347): the board is right, nobody was typed to.
    Offline,
    /// The server saved but names a name it does not declare: nothing posted.
    NotManaged,
    /// The save landed and the telling failed (board #377 review P1-A): an
    /// ANSWER, not an error.
    Failed,
}

struct Fake {
    /// Every method the CLI called, in order.
    calls: Arc<Mutex<Vec<String>>>,
    /// The params of every call, parallel to `calls`.
    params: Arc<Mutex<Vec<serde_json::Value>>>,
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

/// A server that predates `board_dispatch`: its login answer carries no `caps`.
fn old_fake() -> Fake {
    fake_opts(vec![], "", false)
}

/// The same fake, with the issue already assigned to `assignee`.
fn fake_with(plan: Vec<(&'static str, Act)>, assignee: &str) -> Fake {
    fake_opts(plan, assignee, true)
}

fn fake_opts(plan: Vec<(&'static str, Act)>, assignee: &str, caps: bool) -> Fake {
    let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let sent: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sent_in = sent.clone();
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
                let sent_in = sent_in.clone();
                let plan = plan.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                // id 1: auth.
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = if caps {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch"]}}"#
                } else {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true}}"#
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                // id 2: the one call.
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push(method.clone());
                sent_in.lock().unwrap().push(call["params"].clone());
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
                    ("hub_board_save", Act::Offline) => serde_json::json!({ "id": 2, "result": {
                        "ok": true, "id": 12, "dispatch": "offline", "offline": [{ "name": "builder-2", "why": "stopped" }]
                    }}),
                    ("hub_board_save", Act::NotManaged) => serde_json::json!({ "id": 2, "result": {
                        "ok": true, "id": 12, "dispatch": "offline",
                        "dispatch_error": "builder-2 is not a managed agent of this project, so nothing was posted"
                    }}),
                    ("hub_board_save", Act::Failed) => serde_json::json!({ "id": 2, "result": {
                        "ok": true, "id": 12, "dispatch": "failed", "dispatch_error": "the room is full"
                    }}),
                    // The real server answers `dispatch` only when the request
                    // asked and there was somebody to tell.
                    ("hub_board_save", _) if call["params"]["dispatch"] == true && call["params"]["assignee"].as_str().is_some_and(|a| !a.is_empty()) =>
                        serde_json::json!({ "id": 2, "result": { "ok": true, "id": 12, "dispatch": "sent" } }),
                    _ => serde_json::json!({ "id": 2, "result": { "ok": true, "id": 12 } }),
                };
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    let addr = rx.recv().unwrap();
    Fake { calls, params: sent, assignee: state, addr: format!("ws://{addr}") }
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
    /// The params of the one call to `method`.
    fn params_of(&self, method: &str) -> serde_json::Value {
        let calls = self.calls();
        let at = calls.iter().position(|m| m == method).unwrap_or_else(|| panic!("{method} was never called: {calls:?}"));
        self.params.lock().unwrap()[at].clone()
    }
    fn assignee(&self) -> String {
        self.assignee.lock().unwrap().clone()
    }
}

/// The whole path when nothing goes wrong: the issue read, the name checked,
/// ONE save — and no post of its own. The hand-off is the server's (board
/// #377); a CLI that posted one as well would type it into the pane twice.
#[test]
fn a_clean_assignment_is_one_save_and_posts_nothing_itself() {
    let f = fake(vec![]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(ok, "{out:?} {err:?}");
    assert!(out.contains("✓ #12 → builder-2"), "{out:?}");
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_agents", "hub_board_save"]);
    assert_eq!(err, "", "nothing to warn about: {err:?}");
    // What the write carries is what makes the server hand the issue over:
    // the assignee, WHO is handing it (the brief says "orchestrator assigned
    // this to you"), and the request to tell the agent.
    assert_eq!(
        f.params_of("hub_board_save"),
        serde_json::json!({ "session": "p", "id": 12, "assignee": "builder-2", "who": "orchestrator", "dispatch": true })
    );
}

/// Naming the SAME assignee again still sends the save. The server hands the
/// issue over whenever a flagged save names an assignee, and that is how a
/// person re-sends a hand-off to an agent that was offline the first time or
/// whose answer was lost (tmm-cli.md says so, and says it may duplicate). A
/// CLI that skipped the save when the board already says `builder-2` would
/// kill that recovery path without a sound.
#[test]
fn naming_the_same_assignee_again_still_sends_the_save() {
    // ALREADY assigned to the same name (the fake carries the assignee
    // between calls).
    let f = fake_with(vec![], "builder-2");
    let (ok, out, _err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(ok, "{out:?}");
    assert_eq!(f.assignee(), "builder-2", "the save is a no-op on the board");
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_agents", "hub_board_save"]);
    assert_eq!(f.params_of("hub_board_save")["assignee"], "builder-2");
    // The clear-then-same sequence a human would type is the same contract.
    let (ok, _out, _err) = f.run(&["board", "assign", "12", "-"]);
    assert!(ok);
    assert_eq!(f.assignee(), "", "`-` really cleared it in the fake's state");
}

/// Board #377 review P1-B. A server that predates `board_dispatch` would save
/// a label no agent is ever told about and let the CLI print a success line.
/// The login answer is read BEFORE the save is sent: the command refuses with
/// nothing written.
#[test]
fn a_server_without_the_capability_is_refused_before_anything_is_saved() {
    let f = old_fake();
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(!ok, "{out:?}");
    assert!(!out.contains('✓'), "no success line: {out:?}");
    assert!(err.contains("update the server") && err.contains("Nothing was saved"), "{err:?}");
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_agents"], "the save was never sent");
    assert_eq!(f.assignee(), "", "and the board is untouched");

    // `add --assignee` is the same door; `add` without one needs no capability.
    let (ok, _out, err) = f.run(&["board", "add", "Ship it", "--assignee", "builder-2"]);
    assert!(!ok && err.contains("update the server"), "{err:?}");
    assert!(!f.calls().contains(&"hub_board_save".to_string()), "{:?}", f.calls());
    let (ok, out, _err) = f.run(&["board", "add", "Ship it"]);
    assert!(ok && out.contains("✓ #12 on the board"), "{out:?}");
    assert_eq!(f.calls().last().map(String::as_str), Some("hub_board_save"));
    assert!(f.params_of("hub_board_save").get("dispatch").is_none(), "an unassigned add asks for no hand-off");
}

/// Board #377. An issue filed with an assignee hands it over at birth — one
/// save, asking the server to tell the agent.
#[test]
fn add_with_an_assignee_asks_for_the_hand_off_in_the_same_save() {
    let f = fake(vec![]);
    let (ok, out, err) = f.run(&["board", "add", "Ship it", "--body", "Today", "--assignee", "builder-2"]);
    assert!(ok, "{out:?} {err:?}");
    assert!(out.contains("✓ #12 on the board"), "{out:?}");
    assert_eq!(f.calls(), vec!["hub_board_save"]);
    assert_eq!(
        f.params_of("hub_board_save"),
        serde_json::json!({ "session": "p", "title": "Ship it", "body": "Today", "who": "orchestrator", "assignee": "builder-2", "dispatch": true })
    );
}

/// The save landed (the fake writes it) and its ANSWER was lost. The CLI
/// cannot know whether the server also handed the issue over, so it does not
/// say "✓": it fails, with the transport's own words, and a re-run is the
/// recovery.
#[test]
fn a_lost_answer_is_a_failure_not_a_success() {
    let f = fake(vec![("hub_board_save", Act::LoseAnswer)]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(!ok, "a command that could not finish exits non-zero");
    assert!(!out.contains('✓'), "no success line for an answer nobody read: {out:?}");
    assert!(!err.trim().is_empty(), "it says why: {err:?}");
    assert_eq!(f.assignee(), "builder-2", "and the save did land, which is why a re-run is safe");
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_agents", "hub_board_save"]);
}

/// Board #377 review P1-A. The server SAVED and the post failed: that is an
/// answer, and the CLI tells it apart from a failed save. The assignment is
/// said (it is on the board), the agent not being told is said, and the exit
/// is non-zero because the command did not finish what it was asked.
#[test]
fn a_failed_hand_off_is_saved_but_not_told_and_exits_non_zero() {
    let f = fake(vec![("hub_board_save", Act::Failed)]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(!ok);
    assert!(out.contains("✓ #12 → builder-2"), "the assignment landed and is said: {out:?}");
    assert!(err.contains("could not be posted: the room is full"), "{err:?}");
    assert!(err.contains("IS assigned to builder-2") && err.contains("was not told"), "{err:?}");
    assert!(err.contains("tmm board assign 12 builder-2"), "the way to send it again is named: {err:?}");
    assert_eq!(f.assignee(), "builder-2");

    // A machine caller reads the same facts from the answer it was printed.
    let (ok, out, _err) = f.run(&["board", "assign", "12", "builder-2", "--output", "json"]);
    assert!(!ok);
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or_else(|_| panic!("stdout must be JSON: {out:?}"));
    assert_eq!((v["id"].as_i64(), v["dispatch"].as_str()), (Some(12), Some("failed")));
}

/// A save that really failed is a failure with nothing else done.
#[test]
fn a_failed_save_changes_nothing() {
    let f = fake_with(vec![("hub_board_save", Act::Error)], "dev");
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(!ok);
    assert!(!out.contains('✓'), "{out:?}");
    assert!(err.contains("boom"), "{err:?}");
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
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_agents"], "read and checked, never saved");
}

/// `-` clears: one save, no name to check, nothing to wait for.
#[test]
fn clearing_is_one_save_and_checks_no_name() {
    let f = fake(vec![]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "-"]);
    assert!(ok, "{out:?}");
    assert!(out.contains("unassigned"), "{out:?}");
    assert_eq!(err, "", "{err:?}");
    assert_eq!(f.calls(), vec!["hub_board_get", "hub_board_save"]);
    assert_eq!(f.params_of("hub_board_save")["assignee"], "");
}

/// The server's answer says the hand-off reached no pane (the agent is
/// stopped): the board is right, and the person at the keyboard is told, in
/// the words `tmm send` uses, where they are looking (board #347). Both entry
/// points say it (reviewer's P2 on `add --assignee`).
#[test]
fn an_absent_assignee_is_said_on_stderr_and_the_command_still_succeeds() {
    let f = fake(vec![("hub_board_save", Act::Offline)]);
    let (ok, out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(ok, "the assignment landed: {out:?} {err:?}");
    assert!(out.contains("✓ #12 → builder-2"), "{out:?}");
    assert!(err.contains("@builder-2 is not online (stopped)"), "{err:?}");
    assert!(err.contains("nothing is queued for it"), "{err:?}");

    let (ok, out, err) = f.run(&["board", "add", "Ship it", "--assignee", "builder-2"]);
    assert!(ok, "{out:?} {err:?}");
    assert!(err.contains("@builder-2 is not online (stopped)"), "add says it too: {err:?}");

    // A name the project never declared: nothing was posted at all, and the
    // note says why.
    let f = fake(vec![("hub_board_save", Act::NotManaged)]);
    let (ok, _out, err) = f.run(&["board", "assign", "12", "builder-2"]);
    assert!(ok);
    assert!(err.contains("not a managed agent of this project") && err.contains("nothing is queued for it"), "{err:?}");
}
