//! `tmm log --files` through the REAL CLI against a FAKE gateway (board #432, Files mode).
//! What a unit test of the helpers cannot see is the wiring: that the loop follows the
//! cursor and sends `before_seq`, stops at `--limit`, refuses a gateway that answers with
//! messages (one that predates Files mode), refuses a cursor that does not move back, starts
//! from `--before`, and that the plain log does not swallow a `--before`.
//!
//! The fake speaks what `try_rpc` speaks: plain token auth as id 1, one call as id 2, a fresh
//! connection per RPC; every `hub_search` is answered from the next scripted page.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

fn row(path: &str, count: u64) -> serde_json::Value {
    serde_json::json!({ "path": path, "line": null, "col": null, "room": "proj:p", "id": format!("i-{path}"), "seq": 7, "ts": 0, "from": "kiro", "count": count })
}
fn page(files: Vec<serde_json::Value>, next: Option<i64>) -> serde_json::Value {
    serde_json::json!({ "files": files, "next": next, "scanned": 10 })
}

/// A gateway that announces `hub_files`, answering `pages` in order.
fn fake(pages: Vec<serde_json::Value>) -> Fake {
    fake_caps(pages, Some(&["board_dispatch", "spawn_join", "agent_team", "hub_files"]))
}

/// `caps` None = the previous release: its login announces nothing, and its `hub_search` refuses an EMPTY
/// `grep` as a bad request before it looks at `files` (the default way into `--files`).
fn fake_caps(pages: Vec<serde_json::Value>, caps: Option<&'static [&'static str]>) -> Fake {
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
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = match caps {
                    Some(c) => serde_json::json!({ "id": 1, "result": { "ok": true, "authenticated": true, "caps": c } }),
                    None => serde_json::json!({ "id": 1, "result": { "ok": true, "authenticated": true } }),
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let n = {
                    let mut seen = seen.lock().unwrap();
                    seen.push((call["method"].as_str().unwrap_or_default().to_string(), call["params"].clone()));
                    seen.len()
                };
                let old_and_empty = caps.is_none() && call["params"]["grep"].as_array().is_none_or(|g| g.is_empty());
                let reply = if old_and_empty {
                    serde_json::json!({ "id": 2, "error": { "code": -32602, "message": "grep must be a non-empty array of search terms" } })
                } else {
                    serde_json::json!({ "id": 2, "result": pages.get(n - 1).cloned().unwrap_or_else(|| page(vec![], None)) })
                };
                let _ = ws.send(Message::Text(reply.to_string().into())).await;
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
            .env("HOME", std::env::temp_dir())
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", "t")
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "lead")
            .output()
            .unwrap();
        (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }
    fn searches(&self) -> Vec<serde_json::Value> {
        self.calls.lock().unwrap().iter().filter(|(m, _)| m == "hub_search").map(|(_, p)| p.clone()).collect()
    }
}

#[test]
fn the_cursor_is_followed_page_by_page_and_the_counts_are_summed() {
    let gw = fake(vec![
        page(vec![row("/a.md", 2), row("src/x.rs", 1)], Some(40)),
        page(vec![row("/a.md", 3)], Some(10)),
        page(vec![row("src/y.rs", 1)], None),
    ]);
    let (ok, out, err) = gw.run(&["log", "--files", "--limit", "100"]);
    assert!(ok, "{err}");
    let sent = gw.searches();
    assert_eq!(sent.len(), 3, "three pages");
    assert!(sent.iter().all(|p| p["files"] == true && p["session"] == "p"), "{sent:?}");
    assert_eq!(sent.iter().map(|p| p["before_seq"].as_i64()).collect::<Vec<_>>(), vec![None, Some(40), Some(10)], "each page asks below the last message the one before read");
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3, "{out}");
    assert!(lines[0].contains("/a.md") && lines[0].contains("x5"), "the second page adds to the count: {out}");
    assert!(lines[1].contains("src/x.rs") && lines[2].contains("src/y.rs"), "{out}");
    assert!(!err.contains("continue with"), "the history was read to its end: {err}");
}

#[test]
fn the_limit_stops_the_run_and_the_cursor_to_continue_is_printed() {
    let gw = fake(vec![page(vec![row("/a.md", 1)], Some(40)), page(vec![row("/b.md", 1)], None)]);
    let (ok, out, err) = gw.run(&["log", "--files", "--limit", "1"]);
    assert!(ok, "{err}");
    assert_eq!(gw.searches().len(), 1, "one page reached the limit");
    assert!(out.contains("/a.md") && !out.contains("/b.md"), "{out}");
    assert!(err.contains("continue with --before 40"), "{err}");
    // The same run in JSON: the cursor is data, not a stderr hint.
    let gw = fake(vec![page(vec![row("/a.md", 1)], Some(40))]);
    let (ok, json, err) = gw.run(&["log", "--files", "--limit", "1", "--output", "json"]);
    assert!(ok, "{err}");
    let v: serde_json::Value = serde_json::from_str(json.trim()).unwrap();
    assert_eq!((v["files"].as_array().map(Vec::len), v["next"].as_i64()), (Some(1), Some(40)), "{json}");
}

#[test]
fn before_starts_where_an_earlier_run_stopped() {
    let gw = fake(vec![page(vec![row("/b.md", 1)], None)]);
    let (ok, out, err) = gw.run(&["log", "--files", "--before", "40"]);
    assert!(ok, "{err}");
    assert_eq!(gw.searches()[0]["before_seq"], 40);
    assert!(out.contains("/b.md"));
    // The cursor it started from counts too: a gateway that answers with a `next` at or above it is not moving.
    let stuck = fake(vec![page(vec![row("/c.md", 1)], Some(50)), page(vec![row("/d.md", 1)], None)]);
    let (ok, _, err) = stuck.run(&["log", "--files", "--before", "40", "--limit", "100"]);
    assert!(!ok);
    assert!(err.contains("did not move back"), "{err}");
}

#[test]
fn a_gateway_that_answers_with_messages_is_refused_not_read_as_no_files() {
    // One that SAYS it can and still answers without a file page is not trusted either.
    let gw = fake(vec![serde_json::json!({ "messages": [], "more": false })]);
    let (ok, out, err) = gw.run(&["log", "--files"]);
    assert!(!ok, "{out}");
    assert!(err.contains("does not list files") && err.contains("update the gateway"), "{err}");
    assert_eq!(gw.searches().len(), 1, "and nothing was asked again");
}

#[test]
fn an_older_gateway_is_refused_from_its_login_before_anything_is_sent_even_on_the_empty_search() {
    // The previous release refuses an empty grep as a bad request, and answers a worded one with
    // messages. The default `tmm log --files` is the empty one; the login's caps decide, not the answer.
    for args in [vec!["log", "--files"], vec!["log", "--files", "--grep", "docs"]] {
        let gw = fake_caps(vec![serde_json::json!({ "messages": [], "more": false })], None);
        let (ok, out, err) = gw.run(&args);
        assert!(!ok, "{args:?}: {out}");
        assert!(err.contains("does not list files") && err.contains("lacks `hub_files`") && err.contains("Nothing was read."), "{args:?}: {err}");
        assert!(!err.contains("grep must be"), "{args:?}: the gateway's own bad-request text is not what the person sees: {err}");
        assert_eq!(gw.searches().len(), 0, "{args:?}: no search reached it");
    }
    // Announcing other caps is not announcing this one.
    let between = fake_caps(vec![], Some(&["board_dispatch", "spawn_join", "agent_team"]));
    let (ok, _, err) = between.run(&["log", "--files"]);
    assert!(!ok && err.contains("lacks `hub_files`"), "{err}");
    assert_eq!(between.searches().len(), 0);
}

#[test]
fn a_cursor_that_does_not_move_back_ends_the_run_instead_of_looping() {
    let gw = fake(vec![page(vec![row("/a.md", 1)], Some(40)), page(vec![row("/b.md", 1)], Some(40)), page(vec![row("/c.md", 1)], None)]);
    let (ok, _, err) = gw.run(&["log", "--files", "--limit", "100"]);
    assert!(!ok);
    assert!(err.contains("did not move back"), "{err}");
    assert_eq!(gw.searches().len(), 2, "the second page was the last asked");
}

#[test]
fn the_plain_log_refuses_a_before_it_would_ignore() {
    let gw = fake(vec![]);
    for args in [vec!["log", "--before", "9"], vec!["log", "--grep", "a", "--before", "9"]] {
        let (ok, _, err) = gw.run(&args);
        assert!(!ok, "{args:?}");
        assert!(err.contains("--before continues a --files list"), "{args:?}: {err}");
    }
    assert!(gw.calls.lock().unwrap().is_empty(), "refused before any call");
}
