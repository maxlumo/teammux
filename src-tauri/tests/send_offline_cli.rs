//! `tmm send` tells the sender when a mention reached nobody (board #347),
//! through the REAL CLI against a fake server. The room keeps the message and
//! the system line; this is the immediate word for whoever typed the command,
//! and it is a NOTE, not a failure: the message is posted, and nothing is
//! queued for the absent agent.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// A server that answers `hub_post` with `offline` rows, like the real one
/// does when `deliver_mentions` typed to nobody.
fn fake(offline: serde_json::Value) -> String {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().to_string()).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let offline = offline.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let _ = ws.send(Message::Text(r#"{"id":1,"result":{"ok":true}}"#.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let result = match call["method"].as_str().unwrap_or_default() {
                    "hub_agents" => serde_json::json!({
                        "agents": [{ "name": "dev", "managed": true }, { "name": "reviewer", "managed": true }],
                        "session": "p"
                    }),
                    _ => {
                        let mut m = serde_json::json!({ "id": "m1", "seq": 7 });
                        if !offline.as_array().map(|a| a.is_empty()).unwrap_or(true) {
                            m["offline"] = offline.clone();
                        }
                        m
                    }
                };
                let _ = ws
                    .send(Message::Text(serde_json::json!({ "id": 2, "result": result }).to_string().into()))
                    .await;
                let _ = ws.close(None).await;
            }
        });
    });
    format!("ws://{}", rx.recv().unwrap())
}

fn run(addr: &str, args: &[&str]) -> (bool, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", std::env::temp_dir())
        .env("TMM_SERVER", addr)
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

/// The two words, each with its name, on stderr — and exit 0, because the
/// message IS in the room and the sender is being told, not failed.
#[test]
fn the_sender_is_told_which_mentions_reached_nobody() {
    let addr = fake(serde_json::json!([
        { "name": "reviewer", "why": "stopped" },
        { "name": "buildr", "why": "unknown" }
    ]));
    let (ok, out, err) = run(&addr, &["send", "@reviewer @buildr please look"]);
    assert!(ok, "a delivery to nobody is not a failed send: {err:?}");
    assert!(out.contains("✓ sent"), "{out:?}");
    assert!(err.contains("@reviewer is not online (stopped)"), "{err:?}");
    assert!(err.contains("@buildr is not online (unknown)"), "{err:?}");
    assert!(err.contains("nothing is queued"), "no retry is promised: {err:?}");
}

/// Everyone was reached: not a word.
#[test]
fn a_delivered_send_says_nothing_extra() {
    let addr = fake(serde_json::json!([]));
    let (ok, out, err) = run(&addr, &["send", "@dev please look"]);
    assert!(ok);
    assert!(out.contains("✓ sent"));
    assert!(!err.contains("not online"), "{err:?}");
}

/// `--output json` already prints the server's answer verbatim, so the rows
/// are there for a machine; the note is for a person and stays on stderr.
#[test]
fn json_mode_carries_the_rows_in_the_answer() {
    let addr = fake(serde_json::json!([{ "name": "reviewer", "why": "stopped" }]));
    let (ok, out, err) = run(&addr, &["send", "@reviewer hi", "--output", "json"]);
    assert!(ok);
    let v: serde_json::Value = serde_json::from_str(out.trim()).expect(&format!("{out:?}"));
    assert_eq!(v["offline"][0]["name"], "reviewer");
    assert_eq!(v["offline"][0]["why"], "stopped");
    assert!(err.contains("not online"), "a person reading the terminal is told too: {err:?}");
}
