//! Board #77: a message to a managed agent whose CLI exited to the shell is
//! HELD, never typed into that shell, and reaches the CLI once it is
//! restarted. Real tmux, a real managed home, and a fake codex (a python
//! script named `codex.py`, which the pane's process detection reads as
//! codex) that paints codex's ready line and prints `SUBMIT:<line>` for
//! each Enter; Ctrl-C makes it exit to the shell it was typed into.

use super::hub_rpc::handle_hub_request;
use super::test_util::req;

struct Teardown(String, std::path::PathBuf);
impl Drop for Teardown {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

#[test]
fn a_line_to_an_agent_whose_cli_exited_is_held_and_reaches_it_after_a_restart() {
    crate::projects::tests::use_test_store();
    crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
    let session = format!("tmm-held-exit-{}", uuid::Uuid::new_v4());
    let ws = crate::config::test_scratch("tmm-held-exit-ws");
    let home = ws.join(".tmm/agents/dev");
    std::fs::create_dir_all(&home).unwrap();
    let fake = ws.join("codex.py");
    std::fs::write(&fake, "\
import os, sys, time, tty
tty.setraw(0)
time.sleep(0.5)
sys.stdout.write('Ask Codex to do anything\\r\\n'); sys.stdout.flush()
buf = b''
while True:
    c = os.read(0, 1)
    if c == b'\\x03':
        sys.exit(0)
    if c == b'\\r':
        sys.stdout.write('SUBMIT:' + buf.decode('utf-8', 'replace') + '\\r\\n'); sys.stdout.flush()
        buf = b''
    else:
        buf += c
").unwrap();
    let cmd = format!("python3 {}", fake.display());
    crate::projects::spawn::LaunchRecipe { backend: "codex", env: &[], cmd: &cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
    let created = std::process::Command::new("tmux")
        .args(["new-session", "-d", "-x", "200", "-y", "50", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "bash --norc --noprofile"])
        .status()
        .is_ok_and(|s| s.success());
    if !created {
        eprintln!("no tmux server — skipping");
        let _ = std::fs::remove_dir_all(&ws);
        return;
    }
    let _teardown = Teardown(session.clone(), ws.clone());
    crate::tmux::new_named_window(&session, "keep", &ws.to_string_lossy()).unwrap();
    crate::projects::adopt(&session, Some("held-exit-test")).expect("adopt project");
    let target = format!("{session}:dev");
    let screen = || crate::tmux::capture_pane_plain(&target, Some(200)).unwrap_or_default();
    let wait = |ok: &dyn Fn() -> bool, ms: u64| (0..ms / 50).any(|_| ok() || { std::thread::sleep(std::time::Duration::from_millis(50)); false });
    let agent = || crate::tmux::list_panes(&session).unwrap_or_default().into_iter().find(|p| p.window_name == "dev").and_then(|p| p.agent);
    let state = || {
        let r = handle_hub_request(&req("hub_agents", serde_json::json!({ "session": session })), None).result.unwrap();
        r["agents"].as_array().unwrap().iter().find(|a| a["name"] == "dev").map(|a| a["state"].as_str().unwrap_or("").to_string()).unwrap_or_default()
    };
    let submits = || screen().lines().filter(|l| l.starts_with("SUBMIT:")).map(str::to_string).collect::<Vec<_>>();

    // The CLI runs, then exits to the shell it was typed into.
    crate::tmux::send_command(&target, &cmd).unwrap();
    assert!(wait(&|| agent() == Some("codex") && screen().contains("Ask Codex"), 10000), "the fake codex runs: {:?}", screen());
    crate::tmux::run_tmux(&["send-keys", "-t", &target, "C-c"]).unwrap();
    assert!(wait(&|| agent().is_none(), 10000), "it exited: {:?}", screen());
    assert_eq!(state(), crate::projects::exited::STATE, "#65: shown as not running");

    // A line whose body would run a command in a shell is held, not typed.
    let marker = ws.join("marker");
    let body = format!("@dev please run $(touch {})", marker.display());
    let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "lead", "body": body })), None);
    assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(!marker.exists(), "nothing was typed into the shell: {:?}", screen());
    assert_eq!(crate::projects::telemetry::held_rows(&session, "dev").len(), 1, "the line is held");
    let warns: Vec<String> = crate::projects::telemetry::recent_events(&session, 0)
        .into_iter()
        .filter(|e| e.window == "dev" && e.kind == "warn" && e.text.contains("not running"))
        .map(|e| e.text)
        .collect();
    assert_eq!(warns.len(), 1, "the sender is told once: {warns:?}");
    assert!(warns[0].contains("tmm agent restart dev"), "and how to restart it: {}", warns[0]);

    // A /command is refused for it, not typed (a /word in a shell runs a path).
    let r = handle_hub_request(&req("hub_command", serde_json::json!({ "session": session, "agent": "dev", "text": "/status" })), None);
    let said = serde_json::to_string(&r.result.clone().or_else(|| r.error.as_ref().map(|e| serde_json::json!(e.message)))).unwrap();
    assert!(said.contains("not running"), "{said}");
    assert!(!screen().contains("/status"), "nothing typed: {:?}", screen());

    // A second line is held behind it, and told about no second time.
    let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": session, "from": "lead", "body": "@dev and this too" })), None);
    assert!(r.error.is_none());
    assert_eq!(crate::projects::telemetry::held_rows(&session, "dev").len(), 2);

    // Restarted: the new CLI comes up, and the held lines reach it once.
    let r = handle_hub_request(&req("hub_agent_restart", serde_json::json!({ "session": session, "agent": "dev" })), None);
    assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    assert!(wait(&|| submits().iter().any(|l| l.contains("and this too")), 20000), "the held lines arrive: {:?}", screen());
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let got = submits();
    assert_eq!(got.iter().filter(|l| l.contains("please run")).count(), 1, "once: {got:?}");
    assert!(!marker.exists(), "typed into the CLI, never run by a shell");
    assert!(crate::projects::telemetry::held_rows(&session, "dev").is_empty(), "nothing left held");
}
