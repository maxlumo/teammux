//! `tmm merge` (board #445) through the REAL CLI against a FAKE server: the
//! issue is read before any local work, the note posted is exactly the line
//! printed, and a refused or lost note is said, never reported as success.
//! The git side (every landing and refusal row) is pinned on scratch repos in
//! `src/merge/tests.rs`; this file pins the CLI's calls and exit codes.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

#[derive(Clone, Copy, PartialEq)]
enum Act {
    Answer,
    Error,
    /// Accepted, then the socket dropped: the server may have done it.
    LoseAnswer,
    /// A successful reply that is not the expected shape: an issue without
    /// its id, a note without `ok: true`.
    Odd,
}

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

fn fake(plan: Vec<(&'static str, Act)>) -> Fake {
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
                let _ = ws.send(Message::Text(r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch"]}}"#.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let act = plan.iter().find(|(m, _)| *m == method).map(|(_, a)| *a).unwrap_or(Act::Answer);
                if act == Act::LoseAnswer {
                    drop(ws);
                    continue;
                }
                let body = match (method.as_str(), act) {
                    (_, Act::Error) => serde_json::json!({ "id": 2, "error": { "code": -32602, "message": "no issue #445 on this board" } }),
                    ("hub_board_get", Act::Odd) => serde_json::json!({ "id": 2, "result": { "id": 446, "title": "another issue" } }),
                    (_, Act::Odd) => serde_json::json!({ "id": 2, "result": {} }),
                    ("hub_board_get", _) => serde_json::json!({ "id": 2, "result": { "id": 445, "title": "tmm merge", "status": "review", "notes": [] } }),
                    _ => serde_json::json!({ "id": 2, "result": { "ok": true } }),
                };
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    Fake { calls, addr: format!("ws://{}", rx.recv().unwrap()) }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git").arg("-C").arg(dir).args(["-c", "core.hooksPath=/dev/null"]).args(args).env("HOME", dir).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

/// main with one file, and a one-commit branch `feat` carrying the Kiro trailer.
fn repo(name: &str) -> (PathBuf, String) {
    let root = tmux_mobile::config::test_scratch(name);
    std::fs::create_dir_all(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.name", "Ada Integrator"), ("user.email", "ada@example.com"), ("commit.gpgsign", "false")] {
        git(&root, &["config", k, v]);
    }
    std::fs::write(root.join("a.txt"), "a\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "base"]);
    git(&root, &["checkout", "-q", "-b", "feat"]);
    std::fs::write(root.join("b.txt"), "b\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-q", "-m", "feat: b", "-m", "Co-authored-by: Kiro Agent <244629292+kiro-agent@users.noreply.github.com>"]);
    let tip = git(&root, &["rev-parse", "HEAD"]);
    git(&root, &["checkout", "-q", "main"]);
    (root, tip)
}

impl Fake {
    fn run(&self, cwd: &Path, args: &[&str]) -> (i32, String, String) {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", { let h = tmux_mobile::config::test_scratch("tmm-home"); std::fs::create_dir_all(&h).unwrap(); h })
            .env("TMM_SERVER", &self.addr)
            .env("TMM_TOKEN", "t")
            .env("TMM_PROJECT", "p")
            .env("TMM_AGENT", "orchestrator")
            .output()
            .unwrap();
        (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
    }
    fn methods(&self) -> Vec<String> {
        self.calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
    }
    fn params(&self, method: &str) -> serde_json::Value {
        self.calls.lock().unwrap().iter().find(|(m, _)| m == method).map(|(_, p)| p.clone()).unwrap_or_else(|| panic!("{method} never called"))
    }
}

#[test]
fn a_merge_reads_the_issue_first_and_posts_exactly_the_line_it_prints() {
    let (root, tip) = repo("merge-cli-ok");
    let f = fake(vec![]);
    let (code, out, err) = f.run(&root, &["merge", "445", "feat", "--expect", &tip[..8]]);
    assert_eq!(code, 0, "{out} {err}");
    assert_eq!(f.methods(), ["hub_board_get", "hub_board_note"], "the issue is read before any local work, then ONE note");
    assert_eq!(f.params("hub_board_get")["id"], 445);
    let note = f.params("hub_board_note");
    assert_eq!((note["session"].as_str(), note["id"].as_i64(), note["who"].as_str()), (Some("p"), Some(445), Some("orchestrator")));
    let new = git(&root, &["rev-parse", "main"]);
    let body = note["body"].as_str().unwrap();
    assert_eq!(out.trim_end(), body, "the printed line is the posted note");
    assert!(body.contains(&format!("as {}", &new[..8])) && body.contains(&format!("at {}", &tip[..8])), "{body}");
    assert!(body.contains("the gates were confirmed by orchestrator, not checked by this command"));
}

#[test]
fn a_missing_issue_stops_before_any_local_work() {
    let (root, tip) = repo("merge-cli-noissue");
    let old = git(&root, &["rev-parse", "main"]);
    let f = fake(vec![("hub_board_get", Act::Error)]);
    let (code, _, err) = f.run(&root, &["merge", "445", "feat", "--expect", &tip]);
    assert_ne!(code, 0);
    assert!(err.contains("no issue #445"), "{err}");
    assert_eq!(f.methods(), ["hub_board_get"]);
    assert_eq!(git(&root, &["rev-parse", "main"]), old);
}

#[test]
fn expect_is_required_and_the_dry_run_posts_nothing() {
    let (root, tip) = repo("merge-cli-args");
    let f = fake(vec![]);
    let (code, _, err) = f.run(&root, &["merge", "445", "feat"]);
    assert_eq!(code, 5, "a usage error: {err}");
    assert!(err.contains("--expect") && f.methods().is_empty(), "{err}");
    let old = git(&root, &["rev-parse", "main"]);
    let (code, out, err) = f.run(&root, &["merge", "445", "feat", "--expect", &tip, "--dry-run"]);
    assert_eq!(code, 0, "{out} {err}");
    assert!(out.contains("would squash") && out.contains("no note was posted"), "{out}");
    assert_eq!(f.methods(), ["hub_board_get"]);
    assert_eq!(git(&root, &["rev-parse", "main"]), old);
}

#[test]
fn a_refused_or_lost_note_is_said_and_fails_the_command() {
    // An answer without `ok: true` does not confirm a stored note (reviewer P2-D on f3a34d16).
    for (act, says) in [(Act::Error, "NOTE NOT POSTED"), (Act::LoseAnswer, "NOTE UNKNOWN"), (Act::Odd, "NOTE UNKNOWN")] {
        let (root, tip) = repo("merge-cli-note");
        let old = git(&root, &["rev-parse", "main"]);
        let f = fake(vec![("hub_board_note", act)]);
        let (code, out, err) = f.run(&root, &["merge", "445", "feat", "--expect", &tip]);
        assert_eq!(code, 1, "{out} {err}");
        assert!(out.contains(says) && out.contains("tmm merge #445:"), "{out}");
        assert_ne!(git(&root, &["rev-parse", "main"]), old, "the merge itself landed");
        assert!(root.join(".git/tmm-merge.lock").exists(), "the state stays recorded");
    }
}

#[test]
fn an_answer_that_is_not_the_issue_stops_before_any_local_work() {
    let (root, tip) = repo("merge-cli-wrongissue");
    let old = git(&root, &["rev-parse", "main"]);
    let f = fake(vec![("hub_board_get", Act::Odd)]);
    let (code, _, err) = f.run(&root, &["merge", "445", "feat", "--expect", &tip]);
    assert_eq!(code, 1, "{err}");
    assert!(err.contains("is not that issue; nothing was merged"), "{err}");
    assert_eq!(f.methods(), ["hub_board_get"]);
    assert_eq!(git(&root, &["rev-parse", "main"]), old);
}
