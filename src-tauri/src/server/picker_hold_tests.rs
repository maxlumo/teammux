//! Board #66 item 1: a delivery to a managed codex whose pane shows one of
//! codex's own pickers is HELD, never typed into the picker, and is typed
//! once the composer is back. Real tmux, a real managed home, and a fake
//! codex (`codex.py`, read as codex by the pane's process detection) that
//! paints the screens measured on codex-cli 0.166.0 (`live-check
//! codex-picker`): its composer, and after a person types `/new` and Enter,
//! the "Where should the new conversation run?" picker, where a digit picks
//! an option (`PICKED:<d>`, as the real one took the `2` of `2026`) and
//! Escape closes it. An Enter at the composer prints `SUBMIT:<line>`.

use super::hub_rpc::handle_hub_request;
use super::test_util::req;

struct Teardown(String, std::path::PathBuf);
impl Drop for Teardown {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
        let _ = std::fs::remove_dir_all(&self.1);
    }
}

const FAKE: &str = "\
import os, sys, time, tty
tty.setraw(0)
time.sleep(0.5)
seen = []
def paint(picker):
    out = '\\x1b[2J\\x1b[H' + ''.join(l + '\\r\\n' for l in seen) + '\\r\\n'
    if picker:
        out += '  Where should the new conversation run?\\r\\n\\r\\n'
        out += '\\u203a 1. Use current Git worktree  Keep using the current working directory\\r\\n'
        out += '  2. Create new Git worktree   Create a separate checkout of this repository\\r\\n\\r\\n'
        out += '  enter select \\u00b7 esc back\\r\\n'
    else:
        out += '\\u203a Ask Codex to do anything\\r\\n\\r\\n'
        out += '  GPT-6.1-Sol high \\u00b7 Context 0% used \\u00b7 /w\\r\\n'
        out += '  ? for shortcuts\\r\\n'
    sys.stdout.write(out); sys.stdout.flush()
picker = False
buf = b''
paint(False)
while True:
    c = os.read(0, 1)
    if picker:
        if c == b'\\x1b':
            picker = False
        elif c.isdigit():
            seen.append('PICKED:' + c.decode()); picker = False
        paint(picker)
        continue
    if c == b'\\r':
        line = buf.decode('utf-8', 'replace'); buf = b''
        if line == '/new':
            picker = True
        else:
            seen.append('SUBMIT:' + line)
        paint(picker)
    else:
        buf += c
";

struct Rig {
    session: String,
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
        std::fs::write(&fake, FAKE).unwrap();
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
        let rig = Rig { target: format!("{session}:dev"), _teardown: Teardown(session.clone(), ws.clone()), session };
        crate::tmux::new_named_window(&rig.session, "keep", &ws.to_string_lossy()).unwrap();
        crate::projects::adopt(&rig.session, Some(tag)).expect("adopt project");
        crate::tmux::send_command(&rig.target, &cmd).unwrap();
        assert!(wait(&|| rig.screen().contains("Ask Codex"), 10000), "the fake codex runs: {:?}", rig.screen());
        Some(rig)
    }
    fn screen(&self) -> String {
        crate::tmux::capture_pane_plain(&self.target, Some(0)).unwrap_or_default()
    }
    fn lines(&self, prefix: &str) -> Vec<String> {
        self.screen().lines().filter(|l| l.starts_with(prefix)).map(str::to_string).collect()
    }
    fn post(&self, body: &str) {
        let r = handle_hub_request(&req("hub_post", serde_json::json!({ "session": self.session, "from": "lead", "body": body })), None);
        assert!(r.error.is_none(), "{:?}", r.error.map(|e| e.message));
    }
    fn held(&self) -> usize {
        crate::projects::telemetry::held_rows(&self.session, "dev").len()
    }
    /// A person at the pane: keys straight into tmux, never a delivery.
    fn keys(&self, keys: &[&str]) {
        for k in keys {
            let mut args = vec!["send-keys", "-t", &self.target];
            if k.starts_with('/') { args.push("-l"); }
            args.push(k);
            crate::tmux::run_tmux(&args).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }
}

fn wait(ok: &dyn Fn() -> bool, ms: u64) -> bool {
    (0..ms / 50).any(|_| ok() || { std::thread::sleep(std::time::Duration::from_millis(50)); false })
}

#[test]
fn a_line_to_a_codex_with_its_picker_open_is_held_and_typed_once_the_composer_is_back() {
    let Some(rig) = Rig::start("held-picker") else { return };

    // A person opens /new's picker in the pane.
    rig.keys(&["/new", "Enter"]);
    assert!(wait(&|| rig.screen().contains("enter select"), 5000), "the picker is open: {:?}", rig.screen());

    // The delivery (its stamp carries digits, like the incident's `2026`) waits.
    rig.post("@dev pick nothing 2");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert!(rig.lines("PICKED:").is_empty(), "nothing answered the picker: {:?}", rig.screen());
    assert!(rig.screen().contains("enter select"), "the picker is still open: {:?}", rig.screen());
    assert_eq!(rig.held(), 1, "the line is held");

    // The capture tick's pass leaves it held while the picker stays open.
    crate::projects::delivery::release_closed_pickers();
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(rig.held(), 1, "still held under an open picker");
    assert!(rig.lines("PICKED:").is_empty(), "{:?}", rig.screen());

    // The person closes it; the next tick types the line, once, into the composer.
    rig.keys(&["Escape"]);
    assert!(wait(&|| rig.screen().contains("Ask Codex"), 5000), "the composer is back: {:?}", rig.screen());
    crate::projects::delivery::release_closed_pickers();
    assert!(wait(&|| rig.lines("SUBMIT:").iter().any(|l| l.contains("pick nothing 2")), 10000), "the line is typed: {:?}", rig.screen());
    std::thread::sleep(std::time::Duration::from_millis(500));
    let got = rig.lines("SUBMIT:");
    assert_eq!(got.iter().filter(|l| l.contains("pick nothing 2")).count(), 1, "once: {got:?}");
    assert!(rig.lines("PICKED:").is_empty(), "{:?}", rig.screen());
    assert_eq!(rig.held(), 0);
}

#[test]
fn a_line_to_a_codex_at_its_composer_is_typed_at_once() {
    let Some(rig) = Rig::start("open-composer") else { return };
    rig.post("@dev straight in");
    assert!(wait(&|| rig.lines("SUBMIT:").iter().any(|l| l.contains("straight in")), 10000), "typed at once: {:?}", rig.screen());
    assert_eq!(rig.held(), 0);
}

/// Round 2 (reviewer's R1): only the screen capture fails, while the pane,
/// its process and the typing work. An unread screen holds the line, a menu
/// closed while the capture still fails keeps it held, and it is typed once
/// only after a capture reads the composer.
#[test]
fn a_screen_that_cannot_be_read_holds_until_a_read_shows_the_composer() {
    use std::sync::atomic::Ordering::SeqCst;
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            crate::projects::delivery::picker_hold::FAIL_CAPTURE.store(false, SeqCst);
        }
    }
    let Some(rig) = Rig::start("held-unread") else { return };
    let _restore = Restore;
    rig.keys(&["/new", "Enter"]);
    assert!(wait(&|| rig.screen().contains("enter select"), 5000), "the picker is open: {:?}", rig.screen());

    crate::projects::delivery::picker_hold::FAIL_CAPTURE.store(true, SeqCst);
    rig.post("@dev unread 2");
    std::thread::sleep(std::time::Duration::from_millis(1500));
    assert_eq!(rig.held(), 1, "an unread screen holds the line");
    assert!(rig.lines("PICKED:").is_empty(), "{:?}", rig.screen());

    // The menu closes, but the capture still fails: the tick keeps it held.
    rig.keys(&["Escape"]);
    assert!(wait(&|| rig.screen().contains("Ask Codex"), 5000), "{:?}", rig.screen());
    crate::projects::delivery::release_closed_pickers();
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(rig.held(), 1, "no successful read, no release");
    assert!(rig.lines("SUBMIT:").is_empty(), "{:?}", rig.screen());

    // A capture that reads the composer releases it, once.
    crate::projects::delivery::picker_hold::FAIL_CAPTURE.store(false, SeqCst);
    crate::projects::delivery::release_closed_pickers();
    assert!(wait(&|| rig.lines("SUBMIT:").iter().any(|l| l.contains("unread 2")), 10000), "typed after a good read: {:?}", rig.screen());
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert_eq!(rig.lines("SUBMIT:").iter().filter(|l| l.contains("unread 2")).count(), 1, "once: {:?}", rig.screen());
    assert!(rig.lines("PICKED:").is_empty(), "{:?}", rig.screen());
    assert_eq!(rig.held(), 0);
}
