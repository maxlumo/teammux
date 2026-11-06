//! `tmm send "@x /clear" --when-idle` and `tmm send --cancel <id>` (board #45)
//! through the REAL CLI against a FAKE server. What these tests watch is what
//! the CLI sends: `hub_command` with `when_idle`, only to a server whose login
//! announces `command_when_idle` (an older one would ignore the key and type
//! the command into a running turn, the 07:38 incident); `hub_command_cancel`
//! with the id; and the refusals that send nothing. When the command is typed
//! and what holds behind it is the server's, pinned in `projects/delivery.rs`.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Calls = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

/// `caps`: whether the login announces `command_when_idle`.
fn fake(caps: bool) -> (String, Calls) {
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
                let seen = seen.clone();
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let login = if caps {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch","command_when_idle"]}}"#
                } else {
                    r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch"]}}"#
                };
                let _ = ws.send(Message::Text(login.to_string().into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                let method = call["method"].as_str().unwrap_or_default().to_string();
                seen.lock().unwrap().push((method.clone(), call["params"].clone()));
                let result = match method.as_str() {
                    "hub_agents" => serde_json::json!({
                        "agents": [{ "name": "builder", "managed": true }, { "name": "validator", "managed": true }],
                        "session": "p"
                    }),
                    "hub_command" => serde_json::json!({ "sent": [], "waiting": [{ "agent": "builder", "id": 12 }], "command": "/clear", "refused": [] }),
                    "hub_command_cancel" => serde_json::json!({ "id": 12, "agent": "builder", "command": "/clear", "cancelled": true }),
                    _ => serde_json::json!({ "id": "m1", "seq": 7 }),
                };
                let _ = ws.send(Message::Text(serde_json::json!({ "id": 2, "result": result }).to_string().into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    (format!("ws://{}", rx.recv().unwrap()), calls)
}

fn run(addr: &str, args: &[&str]) -> (Option<i32>, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", { let h = tmux_mobile::config::test_scratch("tmm-home"); std::fs::create_dir_all(&h).unwrap(); h })
        .env("TMM_SERVER", addr)
        .env("TMM_TOKEN", "t")
        .env("TMM_PROJECT", "p")
        .env("TMM_AGENT", "orchestrator")
        .output()
        .unwrap();
    (out.status.code(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

fn methods(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().iter().map(|(m, _)| m.clone()).collect()
}

#[test]
fn a_waiting_command_is_sent_with_when_idle_and_its_cancel_id_is_printed() {
    let (addr, calls) = fake(true);
    let (code, out, err) = run(&addr, &["send", "@builder /clear", "--when-idle"]);
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(out.trim(), "✓ /clear → builder waits for its turn to end — cancel: tmm send --cancel 12");
    let calls = calls.lock().unwrap();
    let (m, p) = calls.last().unwrap();
    assert_eq!(m, "hub_command");
    assert_eq!((p["agent"].as_str(), p["text"].as_str(), p["from"].as_str(), p["when_idle"].as_bool()), (Some("builder"), Some("/clear"), Some("orchestrator"), Some(true)));
}

#[test]
fn a_plain_command_says_it_does_not_wait() {
    let (addr, calls) = fake(true);
    let (code, _, err) = run(&addr, &["send", "@builder /clear"]);
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(calls.lock().unwrap().last().unwrap().1["when_idle"], false);
}

#[test]
fn an_older_server_is_refused_before_the_command_is_sent() {
    let (addr, calls) = fake(false);
    let (code, _, err) = run(&addr, &["send", "@builder /clear", "--when-idle"]);
    assert_ne!(code, Some(0));
    assert!(err.contains("command_when_idle") && err.contains("Nothing was sent"), "{err}");
    assert!(!methods(&calls).contains(&"hub_command".to_string()), "{:?}", methods(&calls));
}

#[test]
fn when_idle_holds_only_a_command_and_never_a_timed_one() {
    let (addr, calls) = fake(true);
    for args in [
        &["send", "@builder please look", "--when-idle"][..],
        &["send", "@builder /clear", "--when-idle", "--status"][..],
        &["send", "@builder /clear", "--when-idle", "--in", "10m"][..],
    ] {
        let (code, _, err) = run(&addr, args);
        assert_eq!(code, Some(5), "{args:?}: {err}");
        assert!(err.contains("--when-idle"), "{args:?}: {err}");
    }
    assert!(methods(&calls).iter().all(|m| m == "hub_agents"), "nothing posted, commanded or scheduled: {:?}", methods(&calls));
}

#[test]
fn cancel_names_the_id_and_carries_nothing_else() {
    let (addr, calls) = fake(true);
    let (code, out, err) = run(&addr, &["send", "--cancel", "12"]);
    assert_eq!(code, Some(0), "{err}");
    assert_eq!(out.trim(), "✓ cancelled /clear → builder");
    assert_eq!(calls.lock().unwrap().last().unwrap(), &("hub_command_cancel".to_string(), serde_json::json!({ "session": "p", "id": 12, "from": "orchestrator" })));
    for args in [&["send", "--cancel", "x"][..], &["send", "@builder /clear", "--cancel", "12"][..], &["send", "--cancel", "12", "--when-idle"][..]] {
        let before = methods(&calls).len();
        let (code, _, err) = run(&addr, args);
        assert_eq!(code, Some(5), "{args:?}: {err}");
        assert_eq!(methods(&calls).len(), before, "{args:?}: nothing sent");
    }
}
