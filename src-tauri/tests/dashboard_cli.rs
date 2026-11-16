//! `tmm dashboard publish|unpublish` (board #111) through the REAL CLI against
//! a FAKE server: the folder is sent ABSOLUTE and unopened (the server reads
//! it, #434 P1-D), the caller is the publisher, and a server without
//! `dashboard_page` is refused before anything is sent. The store and its
//! doors are the server's (`projects/page_tests.rs`, `server/page_rpc_tests.rs`).
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

struct Fake {
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    addr: String,
}

fn fake(caps: bool) -> Fake {
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
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["dashboard","dashboard_page"]}}"#
                } else {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["dashboard"]}}"#
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let result = match method.as_str() {
                    "page_publish" => serde_json::json!({ "rev": 3, "files": 2, "bytes": 3 * 1024 * 1024 + 1, "by": "leader" }),
                    "page_unpublish" => serde_json::json!({ "rev": 3 }),
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
    fn run(&self, cwd: &std::path::Path, args: &[&str]) -> (bool, String, String) {
        let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
            .args(args)
            .current_dir(cwd)
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
}

#[test]
fn publish_sends_the_folder_absolute_and_unopened_and_says_the_revision() {
    let f = fake(true);
    let cwd = tmux_mobile::config::test_scratch("tmm-111-cli");
    std::fs::create_dir_all(&cwd).unwrap();
    // The folder does not exist here: the CLI neither opens nor checks it.
    let (ok, out, err) = f.run(&cwd, &["dashboard", "publish", "status/../page"]);
    assert!(ok, "{out:?} {err:?}");
    let calls = f.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    let (method, p) = &calls[0];
    assert_eq!(method, "page_publish");
    assert_eq!(p["dir"], format!("{}/status/../page", cwd.display()), "absolute, lexically; the server resolves it");
    assert_eq!((p["session"].as_str(), p["who"].as_str()), (Some("p"), Some("leader")));
    assert_eq!(out.trim(), "✓ published revision 3 of p's page (2 files, 3.0 MiB)");
}

#[test]
fn unpublish_takes_it_down_and_an_older_server_is_refused_before_sending() {
    let f = fake(true);
    let cwd = tmux_mobile::config::test_scratch("tmm-111-cli-down");
    std::fs::create_dir_all(&cwd).unwrap();
    let (ok, out, err) = f.run(&cwd, &["dashboard", "unpublish"]);
    assert!(ok, "{err:?}");
    assert_eq!(f.methods(), vec!["page_unpublish"]);
    assert!(out.contains("took p's page down (revision 3)"), "{out:?}");

    let old = fake(false);
    for args in [vec!["dashboard", "publish", "x"], vec!["dashboard", "unpublish"]] {
        let (ok, _, err) = old.run(&cwd, &args);
        assert!(!ok, "{args:?}");
        assert!(err.contains("older than project pages") && err.contains("Nothing was published"), "{err:?}");
    }
    assert!(old.methods().is_empty(), "{:?}", old.methods());
    for args in [vec!["dashboard", "publish"], vec!["dashboard"], vec!["dashboard", "show"]] {
        let (ok, _, _) = f.run(&cwd, &args);
        assert!(!ok, "{args:?} is a usage error");
    }
    assert_eq!(f.methods(), vec!["page_unpublish"], "no usage error reached the server");
}
