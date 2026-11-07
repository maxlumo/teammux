//! A managed agent whose CLI exited to the shell is shown as NOT RUNNING
//! (board #65 item 3), never as idle.
//!
//! Incident, 2026-11-07 15:36 (token-porta): after a failed codex resume,
//! validator and reviewer sat at a bare shell while `tmm agent list` said
//! `idle`. Status is derived from turn edges (agent-status.md), and a CLI
//! that exits sends none, so the last edge said rest. The fact already
//! exists: a managed window's agent is named by its recipe
//! (`agents::detect_pane`), while the pane's PROCESS-derived agent
//! (`TmuxPane::agent`, board #260) is `None` once the CLI is gone.
//!
//! A pane between a launch and its CLI coming up is a shell too, so three
//! facts say a launch is in progress, and any one of them keeps the turn
//! state as it is: a start mark (`<home>/starting`, delivery's restart
//! hold), a restore hold (`restore_hold::held`), and a launch younger than
//! `LAUNCH_GRACE` (every managed launch rewrites `<home>/launch-<name>.sh`:
//! spawn, restart, restore, fork).

use crate::projects::telemetry::AgentStatus;
use crate::tmux::TmuxPane;

/// The state a CLI that exited is shown in. Not one of the turn states:
/// no turn can be open or at rest in a process that is gone.
pub const STATE: &str = "exited";
/// Its detail, a person's to clear (`recovery::person_remedy`).
pub const DETAIL: &str = "cli_exited";
/// The state of a window launched less than LAUNCH_GRACE ago whose CLI has
/// not been seen yet: a shell, but never called idle (validator, #65 round 1).
pub const STARTING: &str = "starting";
/// The longest a backend's ready screen is waited for (codex, claude, kiro
/// and kimi: 120 s), so a slow start is never called exited. It covers only
/// the time BEFORE the CLI has been seen in its pane.
const LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_secs(120);
/// What a pane at a shell runs (`pane_current_command`). A window whose pane
/// runs anything else (a wrapper, a test's `cat`) is not judged here.
const SHELLS: [&str; 9] = ["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh", "ash"];

/// One window's CLI, read from its pane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cli {
    /// Running, or not judged: its turn state stands.
    Shown,
    /// Launched, not seen yet, within the grace.
    Starting,
    /// Seen and gone, or never seen past the grace: back at the shell.
    Exited,
}

/// `st` as the Hub and `tmm agent list` show it for `pane`: the turn state,
/// unless the window's CLI is starting or exited to the shell.
pub fn shown(session: &str, workspace: Option<&str>, pane: &TmuxPane, mut st: AgentStatus) -> AgentStatus {
    let (state, detail) = match classify(session, workspace, pane) {
        Cli::Shown => return st,
        Cli::Starting => (STARTING, ""),
        Cli::Exited => (STATE, DETAIL),
    };
    st.state = state.to_string();
    st.detail = detail.to_string();
    st.error = String::new();
    st
}

/// Is `window`'s CLI not running right now (board #77): starting or exited?
/// The same reading as `shown`, for the delivery door: a line typed into
/// that pane would run in its shell. The window's active pane, read now.
pub fn not_running(session: &str, window: &str) -> bool {
    read_now(session, window) != Cli::Shown
}

/// The one notice of a line held for a CLI that is not running (board #77),
/// in the held warn's words: `held (<this>): 1 line will be typed when it clears`.
pub fn held_reason(session: &str, window: &str) -> String {
    match read_now(session, window) {
        Cli::Starting => "the agent is starting: its CLI has not come up yet".to_string(),
        _ => format!("the agent is not running: its CLI exited to the shell; restart it with `tmm agent restart {window}`"),
    }
}

fn read_now(session: &str, window: &str) -> Cli {
    let Some(workspace) = crate::projects::project_for_session(session).ok().flatten().map(|p| p.path) else { return Cli::Shown };
    crate::tmux::list_panes(session)
        .unwrap_or_default()
        .iter()
        .find(|p| p.window_name == window && p.active)
        .map_or(Cli::Shown, |pane| classify(session, Some(&workspace), pane))
}

/// The launch each window's CLI was last SEEN running under (its launch
/// script's mtime). Memory only: a gateway restart forgets it, and a window
/// then falls back to the grace.
fn seen() -> &'static std::sync::Mutex<std::collections::HashMap<(String, String), Option<std::time::SystemTime>>> {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<(String, String), Option<std::time::SystemTime>>>> = std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default)
}

fn classify(session: &str, workspace: Option<&str>, pane: &TmuxPane) -> Cli {
    if !crate::projects::is_managed_in(workspace, &pane.window_name) {
        return Cli::Shown;
    }
    let Some(home) = workspace.and_then(|ws| crate::projects::agents::home_dir(ws, &pane.window_name)) else { return Cli::Shown };
    let launched = std::fs::metadata(home.join(format!("launch-{}.sh", pane.window_name))).and_then(|m| m.modified()).ok();
    let key = (session.to_string(), pane.window_name.clone());
    if pane.agent.is_some() {
        seen().lock().unwrap().insert(key, launched);
        return Cli::Shown;
    }
    // A restart's start mark and a restore hold have their own state and hold.
    if !SHELLS.contains(&pane.current_command.as_str()) || home.join("starting").exists() || crate::projects::restore_hold::held(session, &pane.window_name) {
        return Cli::Shown;
    }
    // Seen under THIS launch and now back at the shell: exited, at once.
    if seen().lock().unwrap().get(&key) == Some(&launched) {
        return Cli::Exited;
    }
    let young = launched.is_some_and(|t| t.elapsed().is_ok_and(|age| age < LAUNCH_GRACE));
    if young { Cli::Starting } else { Cli::Exited }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #65 item 3: a real tmux window, a real managed home, and a
    /// fake CLI (a program named `codex`) that runs and then exits.
    #[test]
    fn a_managed_cli_that_exited_to_the_shell_is_not_running_and_one_not_seen_yet_is_starting() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-exited-{}", uuid::Uuid::new_v4());
        let ws = crate::config::test_scratch("tmm-exited-ws");
        struct Teardown(String, std::path::PathBuf);
        impl Drop for Teardown {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), r#"{"backend":"codex","cmd":"codex"}"#).unwrap();
        // A program NAMED codex (a copy of `sleep`): the process name is what
        // the pane's agent is derived from, and it exits on its own.
        let cli = ws.join("codex");
        std::fs::copy("/bin/sleep", &cli).unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c", &ws.to_string_lossy(), "sh"])
            .status()
            .is_ok_and(|s| s.success());
        if !created {
            eprintln!("no tmux server — skipping");
            let _ = std::fs::remove_dir_all(&ws);
            return;
        }
        let _teardown = Teardown(session.clone(), ws.clone());
        crate::projects::adopt(&session, Some("exited-test")).expect("adopt");
        let w = ws.to_string_lossy().to_string();
        let script = home.join("launch-dev.sh");
        let launched = |ago: u64| {
            std::fs::write(&script, "codex\n").unwrap();
            let f = std::fs::File::options().write(true).open(&script).unwrap();
            f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(ago)).unwrap();
        };
        let pane = |want: Option<&str>| {
            for _ in 0..100 {
                let p = crate::tmux::list_panes(&session).unwrap().into_iter().find(|p| p.window_name == "dev").unwrap();
                if p.agent == want {
                    return p;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            panic!("the pane's agent never became {want:?}");
        };
        let state = |p: &TmuxPane| shown(&session, Some(&w), p, crate::projects::telemetry::derive(&session, "dev", 0));

        // The CLI runs: its turn state, whatever the launch's age.
        launched(600);
        crate::tmux::send_command(&format!("{session}:dev"), &format!("{} 4", cli.display())).unwrap();
        let running = pane(Some("codex"));
        assert_eq!(state(&running).state, "idle", "a live CLI keeps its turn state");

        // It exits to the shell: not running.
        let shell = pane(None);
        let st = state(&shell);
        assert_eq!((st.state.as_str(), st.detail.as_str()), (STATE, DETAIL), "never idle");

        // A fresh launch whose CLI has not been seen yet: starting, never idle.
        launched(5);
        assert_eq!(state(&shell).state, STARTING, "a CLI still coming up is not called exited, nor idle");
        // Seen under that young launch, then gone: exited at once, whatever
        // the launch's age (validator's note 13: the 15:36 resume refusal died
        // seconds after its launch).
        crate::tmux::send_command(&format!("{session}:dev"), &format!("{} 2", cli.display())).unwrap();
        let again = pane(Some("codex"));
        assert_eq!(state(&again).state, "idle");
        let shell = pane(None);
        assert_eq!(state(&shell).state, STATE, "seen, then the shell: exited at once");

        // A restart's start mark has its own state and hold.
        launched(600);
        std::fs::write(home.join("starting"), "{}").unwrap();
        assert_eq!(state(&shell).state, "idle", "a restart's hold keeps the turn state");
        std::fs::remove_file(home.join("starting")).unwrap();
        assert_eq!(state(&shell).state, STATE, "never seen under this launch, past the grace");

        // A pane that is not a shell is not judged (a wrapper, a test's `cat`).
        crate::tmux::send_command(&format!("{session}:dev"), "exec cat").unwrap();
        let other = (0..100).find_map(|_| {
            let p = crate::tmux::list_panes(&session).unwrap().into_iter().find(|p| p.window_name == "dev").unwrap();
            if p.current_command == "cat" { Some(p) } else { std::thread::sleep(std::time::Duration::from_millis(100)); None }
        }).expect("the pane runs cat");
        assert_eq!(state(&other).state, "idle");

        // An unmanaged shell window is just a shell.
        std::fs::remove_file(home.join("launch.json")).unwrap();
        assert_eq!(state(&other).state, "idle");
    }
}
