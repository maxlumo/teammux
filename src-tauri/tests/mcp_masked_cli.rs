//! Board #451 through the REAL `tmm` binary. Against a REAL gateway
//! (`handle_connection` over an isolated state.db), no definition command
//! prints an MCP env/header value, in text or `--output json`, and a listed
//! definition saved back keeps every stored value. Against an OLDER gateway
//! (its login announces no `mcp_masked`), each of the six definition calls is
//! refused before it is sent: nothing is read, shown or saved.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tokio_tungstenite::tungstenite::Message;

use tmux_mobile::agent_notifications::AgentNotificationHub;
use tmux_mobile::server::{handle_connection, AuthTracker, ConnContext, ResizeTracker, ResizeTrackerInner};

/// One private config dir (and state.db inside it) for this test process,
/// set before the first store or config read: the library is built without
/// `cfg(test)` here, so nothing else isolates it (board #216).
fn isolated() -> &'static PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = tmux_mobile::config::fresh_process_dir("tmm-t451-config");
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        std::env::set_var("TMM_STATE_DB", dir.join("state.db"));
        dir
    })
}

/// A real gateway on a loopback port, for the whole process.
fn real_gateway() -> &'static String {
    static ADDR: OnceLock<String> = OnceLock::new();
    ADDR.get_or_init(|| {
        isolated();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap().to_string()).unwrap();
                let auth_tracker: AuthTracker = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
                let resize_tracker: ResizeTracker = Arc::new(std::sync::Mutex::new(ResizeTrackerInner::default()));
                let notifications = Arc::new(AgentNotificationHub::load());
                loop {
                    let Ok((stream, peer)) = listener.accept().await else { return };
                    let ctx = ConnContext {
                        token: Arc::new("t".into()),
                        machine_id: Arc::new("t451".into()),
                        auth_tracker: auth_tracker.clone(),
                        resize_tracker: resize_tracker.clone(),
                        grace_secs: 0,
                        notifications: notifications.clone(),
                        endpoint: Arc::new(serde_json::json!({})),
                        trusted_proxies: Arc::new(Default::default()),
                    };
                    tokio::spawn(handle_connection(stream, peer, ctx));
                }
            });
        });
        format!("ws://{}", rx.recv().unwrap())
    })
}

/// An older gateway: its login announces no `caps`; every call it is sent
/// is recorded (and answered, so a call that slips through would "work").
fn old_gateway() -> (String, Arc<Mutex<Vec<String>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().to_string()).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { continue };
                let Some(Ok(Message::Text(_))) = ws.next().await else { continue };
                let _ = ws.send(Message::Text(r#"{"id":1,"result":{"ok":true,"authenticated":true}}"#.into())).await;
                let Some(Ok(Message::Text(raw))) = ws.next().await else { continue };
                let call: serde_json::Value = serde_json::from_str(&raw).unwrap();
                seen.lock().unwrap().push(call["method"].as_str().unwrap_or_default().to_string());
                let reply = r#"{"id":2,"result":{"mcp":[{"name":"s","def":"{\"env\":{\"K\":\"SENTINEL-old\"}}"}],"agents":[],"teams":[],"ok":true}}"#;
                let _ = ws.send(Message::Text(reply.into())).await;
                let _ = ws.close(None).await;
            }
        });
    });
    (format!("ws://{}", rx.recv().unwrap()), calls)
}

fn tmm(server: &str, args: &[&str]) -> (bool, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"))
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", isolated())
        .env("XDG_CONFIG_HOME", isolated())
        .env("TMM_SERVER", server)
        .env("TMM_TOKEN", "t")
        .env("TMM_PROJECT", "p")
        .env("TMM_AGENT", "lead")
        .output()
        .unwrap();
    (out.status.success(), String::from_utf8_lossy(&out.stdout).to_string(), String::from_utf8_lossy(&out.stderr).to_string())
}

fn stored(sql: &str, name: &str) -> String {
    let db = rusqlite::Connection::open(isolated().join("state.db")).unwrap();
    db.query_row(sql, [name], |r| r.get::<_, String>(0)).unwrap()
}

#[test]
fn no_definition_command_prints_a_value_and_a_listed_definition_saves_back_whole() {
    let gw = real_gateway();
    let secret = "SENTINEL-451-cli";
    let ok = |args: &[&str]| {
        let (ok, out, err) = tmm(gw, args);
        assert!(ok, "{args:?}: {err}");
        assert!(!out.contains(secret) && !err.contains(secret), "{args:?} printed the secret:\n{out}{err}");
        out
    };
    let central = serde_json::json!({ "command": "srv", "env": { "KIRO_API_KEY": secret, "REF": "${HOME}" } }).to_string();
    ok(&["mcp", "save", "--name", "c451", "--def", &central]);
    let inline = serde_json::json!(["c451", { "name": "inl", "url": "https://mcp.example", "headers": { "Authorization": format!("Bearer {secret}") } }]).to_string();
    ok(&["registry", "save", "--name", "a451", "--backend", "kiro", "--system", "x", "--mcp", &inline]);
    let members = serde_json::json!([{ "name": "m", "role": "r", "agent": { "name": "", "backend": "kiro", "model": "", "effort": "", "system": "x", "skills": "[]",
        "mcp": serde_json::json!([{ "name": "inl", "command": "c", "env": { "K": secret } }]).to_string() } }]).to_string();
    ok(&["teams", "save", "--name", "t451", "--def", &members]);

    // Every read, both forms. The text form of mcp list shows the names and the marker.
    let text = ok(&["mcp", "list"]);
    assert!(text.contains("c451: ") && text.contains("\"KIRO_API_KEY\":\"<set>\"") && text.contains("\"REF\":\"<set>\""), "{text}");
    let listed = ok(&["mcp", "list", "--output", "json"]);
    for args in [&["registry", "list"][..], &["registry", "list", "--output", "json"], &["teams", "list"], &["teams", "list", "--output", "json"]] {
        ok(args);
    }

    // The listed def, saved back through tmm exactly as printed: the store keeps the value.
    let listed: serde_json::Value = serde_json::from_str(listed.trim()).unwrap();
    let def = listed["mcp"].as_array().unwrap().iter().find(|m| m["name"] == "c451").unwrap()["def"].as_str().unwrap().to_string();
    ok(&["mcp", "save", "--name", "c451", "--def", &def]);
    let kept = stored("SELECT def FROM reg_mcp WHERE name = ?1", "c451");
    assert!(kept.contains(secret) && kept.contains("${HOME}"), "{kept}");
    let agents: serde_json::Value = serde_json::from_str(ok(&["registry", "list", "--output", "json"]).trim()).unwrap();
    let mcp = agents["agents"].as_array().unwrap().iter().find(|a| a["name"] == "a451").unwrap()["mcp"].as_str().unwrap().to_string();
    ok(&["registry", "save", "--name", "a451", "--backend", "kiro", "--system", "x", "--mcp", &mcp]);
    assert!(stored("SELECT mcp FROM reg_agents WHERE name = ?1", "a451").contains(&format!("Bearer {secret}")));

    // A marker with nothing behind it: refused by name, nothing written.
    let before = stored("SELECT def FROM reg_mcp WHERE name = ?1", "c451");
    let (saved, _, err) = tmm(gw, &["mcp", "save", "--name", "c451", "--def", r#"{"command":"srv","env":{"NEW":"<set>"}}"#]);
    assert!(!saved && err.contains("env.NEW") && !err.contains(secret), "{err}");
    assert_eq!(stored("SELECT def FROM reg_mcp WHERE name = ?1", "c451"), before);

    // A row the gateway cannot read safely: every definition command refuses
    // without its text, and an explicit full save through tmm repairs it.
    let db = rusqlite::Connection::open(isolated().join("state.db")).unwrap();
    db.execute("UPDATE reg_agents SET mcp = ?1 WHERE name = 'a451'", [format!("[{{\"name\":\"s\",\"env\":\"{secret}\"}}]")]).unwrap();
    for args in [&["registry", "list"][..], &["registry", "list", "--output", "json"]] {
        let (listed, out, err) = tmm(gw, args);
        assert!(!listed && err.contains("agent 'a451'") && !out.contains(secret) && !err.contains(secret), "{args:?}: {out}{err}");
    }
    ok(&["registry", "save", "--name", "a451", "--backend", "kiro", "--system", "x", "--mcp", "[]"]);
    ok(&["registry", "list", "--output", "json"]);
}

#[test]
fn an_older_gateway_is_sent_none_of_the_six_definition_calls() {
    let (gw, calls) = old_gateway();
    let def = r#"{"command":"c"}"#;
    let cases: [&[&str]; 8] = [
        &["mcp", "list"],
        &["mcp", "list", "--output", "json"],
        &["mcp", "save", "--name", "s", "--def", def],
        &["registry", "list", "--output", "json"],
        &["registry", "save", "--name", "a", "--backend", "kiro", "--mcp", "[]"],
        &["teams", "list", "--output", "json"],
        &["teams", "save", "--name", "t", "--def", "[]"],
        &["registry", "list"],
    ];
    for args in cases {
        let (ok, out, err) = tmm(&gw, args);
        assert!(!ok, "{args:?} succeeded against an older gateway: {out}");
        assert!(err.contains("lacks `mcp_masked`") && err.contains("Nothing was read or saved."), "{args:?}: {err}");
        assert!(!out.contains("SENTINEL") && !err.contains("SENTINEL"), "{args:?}");
    }
    assert!(calls.lock().unwrap().is_empty(), "no call reached the older gateway: {:?}", calls.lock().unwrap());
}
