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
/// The longest a backend's ready screen is waited for (codex, claude, kiro
/// and kimi: 120 s), so a slow start is never called exited.
const LAUNCH_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

/// `st` as the Hub and `tmm agent list` show it for `pane`: the turn state,
/// unless the window's CLI exited to the shell.
pub fn shown(session: &str, workspace: Option<&str>, pane: &TmuxPane, mut st: AgentStatus) -> AgentStatus {
    if cli_exited(session, workspace, pane) {
        st.state = STATE.to_string();
        st.detail = DETAIL.to_string();
        st.error = String::new();
    }
    st
}

fn cli_exited(session: &str, workspace: Option<&str>, pane: &TmuxPane) -> bool {
    if pane.agent.is_some() || !crate::projects::is_managed_in(workspace, &pane.window_name) {
        return false;
    }
    let Some(home) = workspace.and_then(|ws| crate::projects::agents::home_dir(ws, &pane.window_name)) else { return false };
    if home.join("starting").exists() || crate::projects::restore_hold::held(session, &pane.window_name) {
        return false;
    }
    // No launch script, or one that cannot be dated: no launch is known to be
    // in progress, so the shell is what it looks like.
    let launched = std::fs::metadata(home.join(format!("launch-{}.sh", pane.window_name))).and_then(|m| m.modified());
    !launched.is_ok_and(|t| t.elapsed().is_ok_and(|age| age < LAUNCH_GRACE))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #65 item 3: a real tmux window, a real managed home, and a
    /// fake CLI (a program named `codex`) that runs and then exits.
    #[test]
    fn a_managed_cli_that_exited_to_the_shell_is_not_running_unless_a_launch_is_in_progress() {
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

        // It exits to the shell, long after its launch: not running.
        let shell = pane(None);
        let st = state(&shell);
        assert_eq!((st.state.as_str(), st.detail.as_str()), (STATE, DETAIL), "never idle");

        // A launch in progress keeps the turn state: a fresh launch script...
        launched(5);
        assert_eq!(state(&shell).state, "idle", "a CLI still coming up is not called exited");
        // ...or a restart's start mark.
        launched(600);
        std::fs::write(home.join("starting"), "{}").unwrap();
        assert_eq!(state(&shell).state, "idle", "a restart's hold keeps it");
        std::fs::remove_file(home.join("starting")).unwrap();
        assert_eq!(state(&shell).state, STATE);

        // An unmanaged shell window is just a shell.
        std::fs::remove_file(home.join("launch.json")).unwrap();
        assert_eq!(state(&shell).state, "idle");
    }
}
