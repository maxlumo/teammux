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

/// A managed codex window whose fake CLI ran and exited to bash.
struct Rig {
    session: String,
    ws: std::path::PathBuf,
    target: String,
    _teardown: Teardown,
}

impl Rig {
    fn start(tag: &str) -> Option<Rig> {
        crate::projects::tests::use_test_store();
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("tmm-{tag}-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch(&format!("tmm-{tag}-ws"));
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
            return None;
        }
        let rig = Rig { target: format!("{session}:dev"), _teardown: Teardown(session.clone(), ws.clone()), session, ws };
        crate::tmux::new_named_window(&rig.session, "keep", &rig.ws.to_string_lossy()).unwrap();
        crate::projects::adopt(&rig.session, Some(tag)).expect("adopt project");
        // The CLI runs, then exits to the shell it was typed into.
        crate::tmux::send_command(&rig.target, &cmd).unwrap();
        assert!(wait(&|| rig.agent() == Some("codex") && rig.screen().contains("Ask Codex"), 10000), "the fake codex runs: {:?}", rig.screen());
        crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "C-c"]).unwrap();
        assert!(wait(&|| rig.agent().is_none(), 10000), "it exited: {:?}", rig.screen());
        assert_eq!(rig.state(), crate::projects::exited::STATE, "#65: shown as not running");
        Some(rig)
    }
    fn screen(&self) -> String {
        crate::tmux::capture_pane_plain(&self.target, Some(200)).unwrap_or_default()
    }
    fn agent(&self) -> Option<&'static str> {
        crate::tmux::list_panes(&self.session).unwrap_or_default().into_iter().find(|p| p.window_name == "dev").and_then(|p| p.agent)
    }
    fn state(&self) -> String {
        let r = handle_hub_request(&req("hub_agents", serde_json::json!({ "session": self.session })), None).result.unwrap();
        r["agents"].as_array().unwrap().iter().find(|a| a["name"] == "dev").map(|a| a["state"].as_str().unwrap_or("").to_string()).unwrap_or_default()
    }
    fn submits(&self) -> Vec<String> {
        self.screen().lines().filter(|l| l.starts_with("SUBMIT:")).map(str::to_string).collect()
    }
    fn post(&self, body: &str) {
        let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": self.session, "from": "lead", "body": body })), None);
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    }
    fn command(&self, text: &str) -> String {
        let r = handle_hub_request(&req("hub_command", serde_json::json!({ "session": self.session, "agent": "dev", "text": text })), None);
        serde_json::to_string(&r.result.clone().or_else(|| r.error.as_ref().map(|e| serde_json::json!(e.message)))).unwrap()
    }
    fn warns(&self, words: &str) -> Vec<String> {
        crate::projects::telemetry::recent_events(&self.session, 0).into_iter().filter(|e| e.window == "dev" && e.kind == "warn" && e.text.contains(words)).map(|e| e.text).collect()
    }
    fn held(&self) -> usize {
        crate::projects::telemetry::held_rows(&self.session, "dev").len()
    }
    fn restart(&self) {
        let r = handle_hub_request(&req("hub_agent_restart", serde_json::json!({ "session": self.session, "agent": "dev" })), None);
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    }
}

fn wait(ok: &dyn Fn() -> bool, ms: u64) -> bool {
    (0..ms / 50).any(|_| ok() || { std::thread::sleep(std::time::Duration::from_millis(50)); false })
}

#[test]
fn a_line_to_an_agent_whose_cli_exited_is_held_and_reaches_it_after_a_restart() {
    let Some(rig) = Rig::start("held-exit") else { return };

    // A line whose body would run a command in a shell is held, not typed.
    let marker = rig.ws.join("marker");
    let body = format!("@dev please run $(touch {})", marker.display());
    rig.post(&body);
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(!marker.exists(), "nothing was typed into the shell: {:?}", rig.screen());
    assert_eq!(rig.held(), 1, "the line is held");
    let warns = rig.warns("not running");
    assert_eq!(warns.len(), 1, "the sender is told once: {warns:?}");
    assert!(warns[0].contains("tmm agent restart dev"), "and how to restart it: {}", warns[0]);

    // A /command is refused for it, not typed (a /word in a shell runs a path).
    let said = rig.command("/status");
    assert!(said.contains("not running"), "{said}");
    assert!(!rig.screen().contains("/status"), "nothing typed: {:?}", rig.screen());

    // A second line is held behind it, and told about no second time.
    rig.post("@dev and this too");
    assert_eq!(rig.held(), 2);

    // Restarted: the new CLI comes up, and the held lines reach it once.
    rig.restart();
    assert!(wait(&|| rig.submits().iter().any(|l| l.contains("and this too")), 20000), "the held lines arrive: {:?}", rig.screen());
    std::thread::sleep(std::time::Duration::from_millis(1000));
    let got = rig.submits();
    assert_eq!(got.iter().filter(|l| l.contains("please run")).count(), 1, "once: {got:?}");
    assert!(!marker.exists(), "typed into the CLI, never run by a shell");
    assert_eq!(rig.held(), 0, "nothing left held");
}

/// Reviewer R1 on #77: a failed read of the CLI's state is never permission
/// to type. With only the pane listing failing (every other tmux query and
/// the send itself work), a line to the dead shell is held and a /command is
/// refused; the card keeps its last state. Once the read works again the line
/// stays held because the CLI is in fact exited, and a restart's ready CLI
/// gets it once. A live agent whose read failed gets its line once the read
/// works (orchestrator note 14: a hold from a failed observation never strands).
#[test]
fn a_failed_read_of_the_cli_state_holds_the_line_and_never_types_it() {
    use crate::projects::exited::PANE_READ_FAILS_IN_TEST as FAIL;
    use std::sync::atomic::Ordering::Relaxed;
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            crate::projects::exited::PANE_READ_FAILS_IN_TEST.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let Some(rig) = Rig::start("held-unread") else { return };
    let _clear = Clear;
    let marker = rig.ws.join("marker");

    FAIL.store(true, Relaxed);
    rig.post(&format!("@dev please run $(touch {})", marker.display()));
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(!marker.exists(), "a failed read typed nothing into the shell: {:?}", rig.screen());
    assert_eq!(rig.held(), 1, "held");
    assert_eq!(rig.warns("could not be read").len(), 1, "told once, and why: {:?}", rig.warns(""));
    let said = rig.command("/status");
    assert!(said.contains("could not be read"), "{said}");
    assert!(!rig.screen().contains("/status"), "no slash write: {:?}", rig.screen());

    // The read works again: the CLI is exited, so the line stays held...
    FAIL.store(false, Relaxed);
    crate::projects::delivery::flush_idle(&rig.session);
    assert_eq!(rig.held(), 1);
    assert!(!marker.exists());
    // ...until a restart's ready CLI takes it, once.
    rig.restart();
    assert!(wait(&|| rig.submits().iter().any(|l| l.contains("please run")), 20000), "{:?}", rig.screen());
    std::thread::sleep(std::time::Duration::from_millis(1000));
    assert_eq!(rig.submits().iter().filter(|l| l.contains("please run")).count(), 1);
    assert_eq!(rig.held(), 0);

    // Now live: a failed read holds its next line, and the first flush after
    // the read works again delivers it.
    FAIL.store(true, Relaxed);
    rig.post("@dev while unread");
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert_eq!(rig.held(), 1, "held while its state cannot be read");
    assert!(!rig.submits().iter().any(|l| l.contains("while unread")));
    FAIL.store(false, Relaxed);
    crate::projects::delivery::flush_idle(&rig.session);
    assert!(wait(&|| rig.submits().iter().any(|l| l.contains("while unread")), 5000), "released once the read works: {:?}", rig.screen());
    assert_eq!(rig.submits().iter().filter(|l| l.contains("while unread")).count(), 1);
    assert!(!marker.exists());
}
