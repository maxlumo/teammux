//! `tmm registry save` and `tmm teams save` through the REAL CLI against a FAKE
//! server (board #411 review): a save whose answer lists `unapplied` homes (the
//! definition is saved, but running agents still use the old one) says so on
//! stderr after the checkmark, naming window and project, and still exits 0; a
//! clean save says nothing more; `--output json` prints the answer untouched.
//!
//! The fake speaks exactly what `try_rpc` speaks: token auth as id 1, one call
//! as id 2, a fresh connection per RPC.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// A server that answers every save with `result`.
fn fake(result: serde_json::Value) -> String {
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
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let body = serde_json::json!({ "id": 2, "result": result });
                let _ = ws.send(Message::Text(body.to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    format!("ws://{}", rx.recv().unwrap())
}

fn run(server: &str, args: &[&str]) -> (bool, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", std::env::temp_dir())
        .env("TMM_SERVER", server)
        .env("TMM_TOKEN", "t")
        .env("TMM_PROJECT", "p")
        .env("TMM_AGENT", "orchestrator")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

fn partial() -> serde_json::Value {
    serde_json::json!({ "ok": true, "name": "d1", "members": 1, "unapplied": [
        { "project": "/ws/a", "window": "dsh-1", "definition": "d1", "kind": "failed", "error": "write failed" },
        { "project": "/ws/b", "window": "dsh-2", "definition": "", "kind": "unknown", "error": "its recipe is not readable" },
    ] })
}

#[test]
fn a_registry_save_that_reached_not_every_home_says_which_after_the_checkmark() {
    let server = fake(partial());
    let (ok, out, err) = run(&server, &["registry", "save", "--name", "d1", "--backend", "dsh"]);
    assert!(ok, "the declaration was saved: exit 0. {out:?} {err:?}");
    assert!(out.contains("✓ saved d1"), "{out:?}");
    assert!(err.contains("saved, but 1 running agent(s) still use the old settings"), "{err:?}");
    assert!(err.contains("dsh-1 [/ws/a]: write failed"), "{err:?}");
    // A home whose state could not be confirmed is not claimed to run the old settings.
    let (failed, unconfirmed) = err.split_once("application not confirmed").expect(&err);
    assert!(failed.contains("dsh-1") && !failed.contains("dsh-2"), "{err:?}");
    assert!(unconfirmed.contains("dsh-2 [/ws/b]: its recipe is not readable") && !unconfirmed.contains("dsh-1"), "{err:?}");
}

#[test]
fn a_team_save_that_reached_not_every_home_says_which_after_the_checkmark() {
    let server = fake(partial());
    let (ok, out, err) = run(&server, &["teams", "save", "--name", "crew", "--def", r#"[{"name":"m","base":"d1"}]"#]);
    assert!(ok, "{out:?} {err:?}");
    assert!(out.contains("✓ saved team crew"), "{out:?}");
    assert!(err.contains("dsh-1 [/ws/a]: write failed"), "{err:?}");
}

#[test]
fn a_clean_save_says_nothing_more_and_json_is_the_answer_untouched() {
    let server = fake(serde_json::json!({ "ok": true, "name": "d1" }));
    let (ok, out, err) = run(&server, &["registry", "save", "--name", "d1", "--backend", "dsh"]);
    assert!(ok && out.contains("✓ saved d1"), "{out:?}");
    assert_eq!(err, "", "nothing to warn about: {err:?}");

    let server = fake(partial());
    let (ok, out, _err) = run(&server, &["registry", "save", "--name", "d1", "--backend", "dsh", "--output", "json"]);
    assert!(ok, "{out:?}");
    assert_eq!(serde_json::from_str::<serde_json::Value>(out.trim()).unwrap()["unapplied"][0]["window"], "dsh-1");
}
