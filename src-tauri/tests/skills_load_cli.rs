//! `tmm skills load` and `tmm skills list` through the REAL CLI against a
//! FAKE server (board #418): the text output is a header line (whitespace in
//! the description folded to one line), the SKILL.md
//! body and each other file as `<rel>  <abs path>`; `--output json` prints
//! the answer untouched; an unknown name exits 1 with the server's near
//! matches; the list shows each skill's root.
//!
//! The fake speaks exactly what `try_rpc` speaks: token auth as id 1, one call
//! as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Calls = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

/// A store with one bundle skill, `bundle`; any other name is unknown.
fn fake() -> (String, Calls) {
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
                let body = match (method.as_str(), call["params"]["name"].as_str()) {
                    ("skills_load", Some("bundle")) => serde_json::json!({ "id": 2, "result": {
                        "name": "bundle", "description": "does bundled\n  things", "root": "/state/skills/bundle",
                        "skill_md": "---\nname: bundle\n---\nRun scripts/x.sh.\n",
                        "files": [
                            { "rel": "references/a.md", "path": "/state/skills/bundle/references/a.md", "size": 4 },
                            { "rel": "scripts/x.sh", "path": "/state/skills/bundle/scripts/x.sh", "size": 17 }
                        ]
                    }}),
                    ("skills_load", _) => serde_json::json!({ "id": 2, "error": { "code": -32603, "message": "no skill 'bundl' — did you mean: bundle?" } }),
                    ("skills_list", _) => serde_json::json!({ "id": 2, "result": { "skills": [
                        { "name": "bundle", "source": "/src/bundle", "description": "does\tbundled\nthings", "root": "/state/skills/bundle" }
                    ] } }),
                    _ => serde_json::json!({ "id": 2, "result": {} }),
                };
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    (format!("ws://{}", rx.recv().unwrap()), calls)
}

fn run(server: &str, args: &[&str]) -> (Option<i32>, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
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

#[test]
fn load_prints_the_header_the_skill_md_and_each_other_file_as_a_path() {
    let (server, calls) = fake();
    let (code, out, err) = run(&server, &["skills", "load", "bundle"]);
    assert_eq!(code, Some(0), "{out:?} {err:?}");
    assert_eq!(calls.lock().unwrap().clone(), vec![("skills_load".to_string(), serde_json::json!({ "name": "bundle" }))], "one read-only call");
    assert_eq!(
        out,
        "bundle · does bundled things · /state/skills/bundle\n\n---\nname: bundle\n---\nRun scripts/x.sh.\n\nfiles:\n  references/a.md  /state/skills/bundle/references/a.md\n  scripts/x.sh  /state/skills/bundle/scripts/x.sh\n"
    );
}

#[test]
fn load_as_json_is_the_answer_untouched() {
    let (server, _) = fake();
    let (code, out, _) = run(&server, &["skills", "load", "bundle", "--output", "json"]);
    assert_eq!(code, Some(0));
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v["root"], "/state/skills/bundle");
    assert_eq!(v["files"][1]["path"], "/state/skills/bundle/scripts/x.sh");
    assert!(v["skill_md"].as_str().unwrap().contains("Run scripts/x.sh."));
    assert_eq!(v["description"], "does bundled\n  things", "json keeps the description as written");
}

#[test]
fn an_unknown_skill_exits_1_with_the_near_matches() {
    let (server, _) = fake();
    let (code, out, err) = run(&server, &["skills", "load", "bundl"]);
    assert_eq!(code, Some(1), "{out:?} {err:?}");
    assert!(err.contains("did you mean: bundle?"), "{err:?}");
    assert!(out.is_empty(), "nothing printed as if it loaded: {out:?}");
    let (code, _, err) = run(&server, &["skills", "load"]);
    assert_eq!(code, Some(5), "a missing name is a usage error: {err:?}");
}

#[test]
fn the_list_shows_each_skills_root() {
    let (server, _) = fake();
    let (code, out, _) = run(&server, &["skills", "list"]);
    assert_eq!(code, Some(0));
    assert_eq!(out, "bundle ← /src/bundle does bundled things · /state/skills/bundle\n");
}
