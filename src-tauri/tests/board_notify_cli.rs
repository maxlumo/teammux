//! `tmm board note --notify` through the REAL CLI against a FAKE server
//! (board #507 review P1-A). The server's half — the order, the frozen set,
//! the dedupe — is pinned in `server/hub_rpc.rs`; what these tests watch is
//! what the CLI SAYS about each answer and which exit status it gives, in
//! text and in JSON alike: only a recorded answer is a success, a room
//! failure is a failure that still names the stored note, and a lost or
//! malformed answer is UNKNOWN.
//!
//! The fake speaks exactly what `try_rpc` speaks: plain token auth as id 1,
//! one call as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// What the fake answers `hub_board_note` with.
#[derive(Clone)]
enum Act {
    /// This result.
    Answer(serde_json::Value),
    /// A JSON-RPC error (the server refused before writing).
    Error,
    /// Accept the call, then drop the socket: either half may exist.
    LoseAnswer,
}

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

fn fake(act: Act, caps: &'static [&'static str]) -> Fake {
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
                let act = act.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = serde_json::json!({ "id": 1, "result": { "ok": true, "authenticated": true, "caps": caps } });
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let body = match (method.as_str(), &act) {
                    ("hub_board_note", Act::LoseAnswer) => {
                        drop(ws);
                        continue;
                    }
                    ("hub_board_note", Act::Error) => serde_json::json!({ "id": 2, "error": { "code": -32602, "message": "no managed agent named ghost in this project" } }),
                    ("hub_board_note", Act::Answer(r)) => serde_json::json!({ "id": 2, "result": r }),
                    _ => serde_json::json!({ "id": 2, "result": { "ok": true } }),
                };
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    Fake { calls, addr: format!("ws://{}", rx.recv().unwrap()) }
}

const CAPS: &[&str] = &["board_dispatch", "board_notify"];
/// The token the TCP rows pass in `$TMM_TOKEN`: a sentinel, so "never
/// printed" is a check and not a coincidence.
const TOKEN: &str = "tok-SENTINEL-507";

fn recorded() -> serde_json::Value {
    serde_json::json!({
        "ok": true, "note": "stored", "recipients": ["dev", "human", "qa"],
        "line": "@dev @human @qa board #12: the fix is in (tmm board show 12)",
        "room": { "state": "recorded", "seq": 41, "id": "m-41" },
        "announce": { "attempted": ["dev"] },
        "offline": [{ "name": "qa", "why": "stopped" }],
        "notice": { "targets": ["lead"], "attempted": ["lead"] },
    })
}

fn room_failed() -> serde_json::Value {
    serde_json::json!({
        "ok": true, "note": "stored", "recipients": ["dev"],
        "line": "@dev board #12: $(rm -rf ~) `id` (tmm board show 12)",
        "room": { "state": "failed", "error": "database is locked" },
        "notice": { "targets": ["dev", "lead"], "attempted": ["dev"] },
    })
}

struct Run {
    code: i32,
    out: String,
    err: String,
}

impl Fake {
    fn run(&self, args: &[&str]) -> Run {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
            .args(args)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", { let h = tmux_mobile::config::test_scratch("tmm-home"); std::fs::create_dir_all(&h).unwrap(); h })
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", TOKEN)
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "validator")
            .output()
            .unwrap();
        Run {
            code: out.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&out.stdout).to_string(),
            err: String::from_utf8_lossy(&out.stderr).to_string(),
        }
    }
    fn notes(&self) -> Vec<serde_json::Value> {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == "hub_board_note").map(|(_, p)| p.clone()).collect()
    }
}

const NOTE: &[&str] = &["board", "note", "12", "the fix is in", "--notify", "@dev,@human @qa"];

fn with_json(args: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = args.iter().map(|a| a.to_string()).collect();
    v.extend(["--output".into(), "json".into()]);
    v
}

/// The request carries the parsed names and nothing the server must not get.
#[test]
fn a_recorded_answer_says_recorded_and_attempted_and_exits_zero_in_both_formats() {
    let f = fake(Act::Answer(recorded()), CAPS);
    let text = f.run(NOTE);
    assert_eq!(text.code, 0, "{} {}", text.out, text.err);
    assert!(text.out.contains("room line recorded for @dev, @human, @qa (seq 41)"), "{}", text.out);
    assert!(text.out.contains("delivery attempted: @dev"), "{}", text.out);
    assert!(text.out.contains("the issue's own notice: attempted for @lead"), "{}", text.out);
    assert!(text.err.contains("@qa is not online (stopped)"), "{}", text.err);
    for word in ["notified", "delivered", "announced to"] {
        assert!(!text.out.contains(word), "{word}: {}", text.out);
    }
    assert_eq!(f.notes()[0]["notify"], serde_json::json!(["dev", "human", "qa"]));

    // Nothing attempted is said as none, never as "nobody is there": tmux
    // may not have answered, and the offline notes say which (review P2).
    let mut none = recorded();
    none["announce"]["attempted"] = serde_json::json!([]);
    none["offline"] = serde_json::json!([{ "name": "dev", "why": "unchecked" }]);
    let quiet = fake(Act::Answer(none), CAPS).run(NOTE);
    assert_eq!(quiet.code, 0, "{}", quiet.err);
    assert!(quiet.out.contains("delivery attempted: none (see the offline notes)"), "{}", quiet.out);
    assert!(!quiet.out.contains("no live pane"), "{}", quiet.out);

    let args = with_json(NOTE);
    let json = f.run(&args.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(json.code, 0, "{}", json.err);
    let printed: serde_json::Value = serde_json::from_str(json.out.trim()).unwrap();
    assert_eq!(printed, recorded());
}

/// A room failure is a FAILURE in both formats — the note is stored, the room
/// line is not — and the recovery command is the server's line, quoted as
/// data, pointed at the same project and gateway.
#[test]
fn a_room_failure_exits_nonzero_in_both_formats_and_hands_over_the_servers_line() {
    let f = fake(Act::Answer(room_failed()), CAPS);
    let text = f.run(NOTE);
    assert_eq!(text.code, 1, "{} {}", text.out, text.err);
    assert!(!text.out.contains('✓'), "no success line: {}", text.out);
    assert!(text.err.contains("the note IS stored on #12"), "{}", text.err);
    assert!(text.err.contains("database is locked"), "{}", text.err);
    assert!(text.err.contains("attempted for @dev and is not confirmed"), "{}", text.err);
    // The server's exact line, as text on its own line, and no command to
    // paste (the restraint cut): the shell that would run one may hold
    // another gateway, root or token.
    assert!(text.err.lines().any(|l| l == "@dev board #12: $(rm -rf ~) `id` (tmm board show 12)"), "{}", text.err);
    assert!(text.err.contains("resend it by hand once you are sure of the original gateway, project and credentials"), "{}", text.err);
    for cmd in ["tmm send", "--project", "--server", "TMM_SOCKET", "XDG_CONFIG_HOME"] {
        assert!(!text.err.contains(cmd), "no command to paste ({cmd}): {}", text.err);
    }
    assert!(!text.err.contains(TOKEN), "the token is never printed: {}", text.err);

    let args = with_json(NOTE);
    let json = f.run(&args.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(json.code, 1, "JSON exits like text: {}", json.err);
    assert_eq!(serde_json::from_str::<serde_json::Value>(json.out.trim()).unwrap(), room_failed());
    assert!(json.err.contains("the note IS stored on #12"), "{}", json.err);
}

/// A lost answer, and every malformed one, is UNKNOWN in both formats: check
/// the card and the room, never re-run.
#[test]
fn a_lost_or_malformed_answer_is_unknown_in_both_formats() {
    let mut no_seq = recorded();
    no_seq["room"].as_object_mut().unwrap().remove("seq");
    // A room state the CLI does not know: neither recorded nor failed.
    let mut pending = recorded();
    pending["room"]["state"] = serde_json::json!("pending");
    for act in [
        Act::LoseAnswer,
        Act::Answer(serde_json::json!({})),
        Act::Answer(serde_json::json!({ "ok": true })),
        Act::Answer(serde_json::json!({ "ok": false })),
        Act::Answer(no_seq),
        Act::Answer(pending),
    ] {
        let f = fake(act, CAPS);
        for json in [false, true] {
            let args = if json { with_json(NOTE) } else { NOTE.iter().map(|a| a.to_string()).collect() };
            let r = f.run(&args.iter().map(String::as_str).collect::<Vec<_>>());
            assert_eq!(r.code, 1, "{} {}", r.out, r.err);
            assert!(r.err.contains("unknown whether the note was stored on #12"), "{}", r.err);
            assert!(r.err.contains("check issue #12's notes and the room"), "{}", r.err);
            // No command to paste. (A malformed answer's reason quotes the
            // answer, whose line itself says "tmm board show 12": that is
            // the server's text, not a command we print.)
            assert!(!r.err.contains("--project") && !r.err.lines().any(|l| l.starts_with("check:")), "no command to paste: {}", r.err);
            assert!(!r.err.contains(TOKEN), "{}", r.err);
            assert!(!r.err.contains("re-run"), "{}", r.err);
            assert!(!r.out.contains('✓'), "{}", r.out);
        }
    }
}

/// Refusals send nothing that could write: a server without the capability
/// is refused before the call, a shape error before the connection, and a
/// server error is the server's own refusal.
#[test]
fn refusals_write_nothing_and_say_why() {
    let old = fake(Act::Answer(recorded()), &["board_dispatch"]);
    let r = old.run(NOTE);
    assert_ne!(r.code, 0);
    assert!(old.notes().is_empty(), "an older gateway never receives the note");

    let f = fake(Act::Answer(recorded()), CAPS);
    let r = f.run(&["board", "note", "12", "x", "--notify", "dev"]);
    assert_eq!(r.code, 5, "{}", r.err);
    assert!(r.err.contains("needs its @"), "{}", r.err);
    let r = f.run(&["board", "note", "12", "x", "--notify", "＠dev"]);
    assert_eq!(r.code, 5);
    assert!(r.err.contains("full-width"), "{}", r.err);
    assert!(f.notes().is_empty(), "a bad recipient is refused before any call");

    let e = fake(Act::Error, CAPS);
    let r = e.run(NOTE);
    assert_ne!(r.code, 0);
    assert!(r.err.contains("no managed agent named ghost"), "{}", r.err);
    assert!(!r.err.contains("IS stored"), "a refusal is not a stored note: {}", r.err);
}

/// Without the flag the request and the output are what they always were.
#[test]
fn the_flagless_note_is_unchanged() {
    let f = fake(Act::Answer(serde_json::json!({ "ok": true })), CAPS);
    let r = f.run(&["board", "note", "12", "plain"]);
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(r.out.trim(), "✓ #12");
    let sent = &f.notes()[0];
    assert!(sent.get("notify").is_none(), "{sent}");
}
