//! Declaration → tmux. The reverse direction of `capture`.
//!
//! `up` is idempotent by construction: it matches windows BY NAME and only
//! creates what is missing. It never renames, reorders or restarts a window
//! that is already there, because the session it is reconciling may be the one
//! you are typing in right now.

use super::agents;
use super::store::{Project, Slot, SlotKind};
// ONE shell quoter for every line typed into a pane — the same one `spawn`
// uses. This module carried its own copy with a narrower safe set.
use crate::tmux;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SlotResult {
    pub window_name: String,
    /// `created` | `existing` | `skipped` | `failed`
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpReport {
    pub session: String,
    pub created_session: bool,
    pub slots: Vec<SlotResult>,
}

/// Bring a project up: ensure its session exists and every settled slot has a
/// window. Unsettled slots are skipped — they have not earned a place in the
/// restored workspace yet (see `capture::SETTLE_SECS`).
pub fn up(project: &Project, slots: &[Slot]) -> Result<UpReport, String> {
    let existed = tmux::session_exists(&project.session);
    let mut results = Vec::new();
    let restorable: Vec<&Slot> = slots.iter().filter(|s| s.is_settled()).collect();

    if !existed {
        tmux::ensure_session(&project.session, &project.path)?;
        // A fresh session already owns one window, named after the shell. Give
        // it to the first slot instead of leaving a stray window behind.
        if let Some(first) = restorable.first() {
            let target = format!("{}:^", project.session);
            tmux::rename_window(&target, &first.window_name)?;
            results.push(start_in_existing(project, first, &target));
        }
    }

    for slot in restorable
        .iter()
        .skip(if existed { 0 } else { 1 })
        .copied()
    {
        results.push(create_or_keep(project, slot));
    }

    for slot in slots.iter().filter(|s| !s.is_settled()) {
        results.push(SlotResult {
            window_name: slot.window_name.clone(),
            status: "skipped",
            error: None,
        });
    }

    Ok(UpReport {
        session: project.session.clone(),
        created_session: !existed,
        slots: results,
    })
}

/// Bring ONE agent slot up — the restart button's half of `up`. Same code
/// path as `up` takes for a single slot (slot cwd, hooks refresh, the exact
/// `agent_session_id` resume, staged script), for this slot ONLY: a restart of
/// one stopped agent used to go through `up`, which also resumed every OTHER
/// stopped agent in the project (owner, 2026-09-20, board #210). `None` when
/// the project has no agent slot by that name — the caller falls back to a
/// fresh resume spawn, as before.
pub fn up_agent(project: &Project, slots: &[Slot], window_name: &str) -> Option<SlotResult> {
    let slot = slots
        .iter()
        .find(|s| s.kind == SlotKind::Agent && s.window_name == window_name)?;
    Some(create_or_keep(project, slot))
}

fn create_or_keep(project: &Project, slot: &Slot) -> SlotResult {
    if tmux::find_window_by_name(&project.session, &slot.window_name).is_some() {
        return SlotResult {
            window_name: slot.window_name.clone(),
            status: "existing",
            error: None,
        };
    }
            let cwd = absolute_cwd(&project.path, &slot.cwd);
    // A managed agent's hooks are re-materialized before it starts: the config
    // on disk was written by whatever version spawned it, and hooks are how we
    // observe the agent at all.
    if slot.kind == SlotKind::Agent {
        super::spawn::refresh_hooks(&project.path, &slot.window_name);
    }
    match tmux::new_named_window(&project.session, &slot.window_name, &cwd) {
        Ok(pane) => {
            // A fresh pane: type only once its shell shows a prompt (#325).
            tmux::wait_for_shell(&pane, tmux::SHELL_READY);
            let mut result = SlotResult {
                window_name: slot.window_name.clone(),
                status: "created",
                error: None,
            };
            if let Err(e) = run_slot_command(project, slot, &pane) {
                result.error = Some(e);
            }
            result
        }
        Err(e) => SlotResult {
            window_name: slot.window_name.clone(),
            status: "failed",
            error: Some(e),
        },
    }
}

fn start_in_existing(project: &Project, slot: &Slot, target: &str) -> SlotResult {
    let cwd = absolute_cwd(&project.path, &slot.cwd);
    let mut result = SlotResult {
        window_name: slot.window_name.clone(),
        status: "created",
        error: None,
    };
    // Only called for a session `up` just created: its first pane is fresh.
    tmux::wait_for_shell(target, tmux::SHELL_READY);
    if !slot.cwd.is_empty() {
        if let Err(e) = tmux::send_command(target, &format!("cd {}", crate::shell::quote(&cwd))) {
            result.error = Some(e);
            return result;
        }
    }
    if let Err(e) = run_slot_command(project, slot, target) {
        result.error = Some(e);
    }
    result
}

/// Only agent slots and explicitly declared commands are replayed. Restoring a
/// workspace must not re-execute whatever the user happened to be running last
/// time (decision 5 in the exec plan). An agent goes back into the conversation
/// it was in, not to a blank prompt — see `agents::launch_line`.
#[cfg(test)]
pub(super) fn slot_command(slot: &Slot) -> Option<String> {
    slot_command_in(slot, None)
}

/// `project_path` enables the managed-agent path: a spawned agent restarts
/// with its FULL identity (isolated home env + --agent + resume) via the
/// launch recipe `spawn` persisted. Without it the generic backend launch
/// line runs the user-space config, whose kiro hooks never fire (measured) —
/// the restarted agent kept answering but went observably deaf: no tool rows,
/// no delivery receipts, every message "unconfirmed" (owner report 2026-08-18).
pub(super) fn slot_command_in(slot: &Slot, project_path: Option<&str>) -> Option<String> {
    if !slot.auto_run {
        return None;
    }
    let command = match slot.kind {
        SlotKind::Agent => {
            let recipe = project_path.and_then(|p| {
                super::spawn::relaunch_line(p, &slot.window_name, slot.agent_session_id.as_deref())
            });
            match recipe {
                Some(line) => line,
                None => slot
                    .command
                    .as_deref()
                    .and_then(|backend| agents::launch_line(backend, slot.agent_session_id.as_deref()))?,
            }
        }
        SlotKind::Shell => slot.command.clone()?,
    };
    (!command.trim().is_empty()).then_some(command)
}

/// The strict launch door for a restore after a reboot (board #422):
/// `Ok(None)` for a shell (nothing is replayed), `Ok(Some(line))` for an
/// agent ONLY when its exact conversation can be resumed — a managed agent
/// through its recipe (`spawn::relaunch_line_exact`), an adopted one through
/// its CLI's `resume_id` — and `Err` otherwise. Never `resume_recent`,
/// `--resume` or a blank launch; `slot_command_in` keeps manual `up`'s
/// behaviour unchanged.
pub(crate) fn slot_command_exact(project_path: &str, slot: &Slot, managed: bool) -> Result<Option<String>, String> {
    if slot.kind == SlotKind::Shell {
        return Ok(None);
    }
    let id = slot.agent_session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("{}: no saved conversation", slot.window_name))?;
    if managed {
        match super::managed::managed_state(project_path, &slot.window_name) {
            super::managed::ManagedState::Managed => {}
            super::managed::ManagedState::Plain => return Err(format!("{}: the managed home is missing", slot.window_name)),
            super::managed::ManagedState::Unknown(e) => return Err(format!("{}: the managed home cannot be read: {e}", slot.window_name)),
        }
        return super::spawn::relaunch_line_exact(project_path, &slot.window_name, id).map(Some);
    }
    let backend = slot.command.as_deref().unwrap_or("");
    agents::launch_line_exact(backend, id).map(Some).ok_or_else(|| format!("{}: {backend} cannot resume an exact conversation", slot.window_name))
}

/// What is typed into an agent's pane for `cmd`: its tmm identity prefix,
/// staged as a script in its home when it has one (the one shape `up` and
/// the restore executor share).
pub(crate) fn launch_text(project: &Project, slot: &Slot, cmd: &str) -> String {
    let prefixed = if slot.kind == SlotKind::Agent {
        format!(
            "TMM_PROJECT={} TMM_AGENT={} {}",
            crate::shell::quote(&project.session),
            crate::shell::quote(&slot.window_name),
            cmd
        )
    } else {
        cmd.to_string()
    };
    let staged = (slot.kind == SlotKind::Agent)
        .then(|| stage_relaunch_script(&project.path, &slot.window_name, &prefixed))
        .flatten();
    staged.unwrap_or(prefixed)
}

fn run_slot_command(project: &Project, slot: &Slot, target: &str) -> Result<(), String> {
    match slot_command_in(slot, Some(&project.path)) {
        // Agents get their tmm identity: the project is the session, the agent
        // name is the window. Resumed agents keep the user's own config (no
        // isolated home — that is spawn's job), but tmm works in their window
        // and telemetry can attribute their declarations.
        //
        // NEVER send a long line via send-keys — tty shims swallow bursts
        // ≳2KB (team/launch.rs), and a managed recipe can carry a big
        // identity (claude's --append-system-prompt rides the cmd). Spawn
        // learned this first and sources a script; the restart replay broke
        // the same way when codex's ~6 KB line hit the pane half typed
        // (owner, 2026-09-08: "codex 重启好像有点问题"). Same cure:
        // `launch_text` stages the line as a script in the agent's home.
        Some(cmd) => tmux::send_command(target, &launch_text(project, slot, &cmd)),
        None => Ok(()),
    }
}

/// Write `full` as a launch script in the managed agent's home and hand back
/// the short `. <script>` line to type instead. `None` when the window has no
/// isolated home (an adopted agent slot) or the write fails — the caller then
/// types the line directly, which is the old behaviour and fine for the short
/// generic launch lines those windows have.
fn stage_relaunch_script(project_path: &str, window_name: &str, full: &str) -> Option<String> {
    let home = super::agents::home_dir(project_path, window_name)?;
    if !home.is_dir() {
        return None;
    }
    let script = crate::backends::shared::write_launch_script(&home, window_name, full).ok()?;
    Some(format!(". {}", crate::shell::quote(&script.to_string_lossy())))
}

/// Take a project down: kill the session, keep the declaration.
pub fn down(project: &Project) -> Result<(), String> {
    if !tmux::session_exists(&project.session) {
        return Ok(());
    }
    tmux::kill_session(&project.session)
}

pub fn absolute_cwd(project_path: &str, slot_cwd: &str) -> String {
    if slot_cwd.is_empty() {
        return project_path.to_string();
    }
    if slot_cwd.starts_with('/') {
        return slot_cwd.to_string();
    }
    format!("{}/{}", project_path.trim_end_matches('/'), slot_cwd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot(name: &str, cwd: &str, settled: bool) -> Slot {
        Slot {
            id: None,
            ord: 0,
            window_name: name.into(),
            cwd: cwd.into(),
            kind: SlotKind::Shell,
            command: None,
            auto_run: false,
            agent_session_id: None,
            first_seen_at: 1_000,
            settled_at: settled.then_some(1_200),
        }
    }

    fn project(name: &str, path: &str) -> Project {
        Project {
            id: name.into(),
            name: name.into(),
            path: path.into(),
            icon: None,
            session: name.into(),
            adopted: false,
            autostart: false,
            created_at: 1_000,
            last_up_at: None,
            last_seen_at: None,
            archived: false,
            room: String::new(),
        }
    }

    #[test]
    fn slot_cwd_resolves_against_the_project_root() {
        assert_eq!(absolute_cwd("/w/app", ""), "/w/app");
        assert_eq!(absolute_cwd("/w/app", "src"), "/w/app/src");
        assert_eq!(absolute_cwd("/w/app/", "src"), "/w/app/src");
        assert_eq!(absolute_cwd("/w/app", "/other"), "/other");
    }

    #[test]
    fn quoting_survives_spaces_and_quotes() {
        assert_eq!(crate::shell::quote("/w/app"), "/w/app");
        assert_eq!(crate::shell::quote("/w/my app"), "'/w/my app'");
        assert_eq!(crate::shell::quote("it's"), r"'it'\''s'");
    }

    #[test]
    fn a_restored_agent_window_resumes_its_conversation() {
        let mut agent = slot("kiro", "", true);
        agent.kind = SlotKind::Agent;
        agent.command = Some("kiro".into());
        agent.auto_run = true;

        // No id learned yet: resume this directory's newest conversation.
        assert_eq!(slot_command(&agent).as_deref(), Some("kiro-cli chat --resume"));

        // With the id the hooks reported, go back to that exact one — a
        // directory can hold several conversations (real case: two kiro
        // sessions in this repo), so "most recent" is a guess and the id is not.
        agent.agent_session_id = Some("aa816dcf-6615-4e41-86bb-1c9ec1c2c6a1".into());
        assert_eq!(
            slot_command(&agent).as_deref(),
            Some("kiro-cli chat --resume-id aa816dcf-6615-4e41-86bb-1c9ec1c2c6a1")
        );
    }

    #[test]
    fn an_observed_shell_process_is_never_replayed() {
        let mut shell = slot("dev", "", true);
        shell.command = Some("npm run dev".into());
        assert_eq!(slot_command(&shell), None, "auto_run is off for shells");

        // Even a stale conversation id cannot make a shell slot run anything.
        shell.agent_session_id = Some("conv-1".into());
        assert_eq!(slot_command(&shell), None);
    }

    #[test]
    fn up_and_down_reconcile_a_real_session_idempotently() {
        let mut scratch = tmux::Scratch::new("recon");
        let path = std::path::PathBuf::from(scratch.path());
        let p = project(&scratch.session("s"), path.to_str().unwrap());

        let slots = vec![
            slot("editor", "", true),
            slot("logs", "sub", true),
            slot("scratch", "", false),
        ];
        std::fs::create_dir_all(path.join("sub")).unwrap();

        let first = up(&p, &slots).unwrap();
        assert!(first.created_session);
        let created: Vec<_> = first.slots.iter().filter(|s| s.status == "created").collect();
        assert_eq!(created.len(), 2, "both settled slots got a window");
        assert!(
            first.slots.iter().any(|s| s.window_name == "scratch" && s.status == "skipped"),
            "an unsettled slot is not restored"
        );
        let windows: Vec<String> = tmux::list_named_windows(&p.session)
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(windows.len(), 2, "no stray shell window left over: {windows:?}");
        assert!(windows.contains(&"editor".to_string()));
        assert!(windows.contains(&"logs".to_string()));

        let second = up(&p, &slots).unwrap();
        assert!(!second.created_session);
        assert!(
            second.slots.iter().filter(|s| s.status == "existing").count() == 2,
            "second up must change nothing: {:?}",
            second.slots
        );
        assert_eq!(tmux::list_named_windows(&p.session).len(), 2);

        down(&p).unwrap();
        assert!(!tmux::session_exists(&p.session));
        down(&p).unwrap_or_else(|e| panic!("down must be idempotent: {e}"));
    }

    /// Restarting ONE stopped agent must bring back THAT agent only. It used
    /// to go through the project-wide `up`, which also resumed every other
    /// stopped agent in the project (owner, 2026-09-20, board #210). The
    /// single-slot path keeps the exact conversation id: `--resume-id <id>`,
    /// never a degraded `--resume`.
    #[test]
    fn up_agent_restarts_only_the_named_agent_with_its_exact_conversation() {
        let mut scratch = tmux::Scratch::new("upagent");
        let path = std::path::PathBuf::from(scratch.path());
        let ws = path.to_str().unwrap();
        let p = project(&scratch.session("s"), ws);

        // Two managed agents, both with a recipe (a harmless `echo` stands in
        // for the CLI) and both with a recorded conversation.
        let mut slots = Vec::new();
        for name in ["a", "b"] {
            let home = crate::projects::spawn::agent_home(ws, name);
            std::fs::create_dir_all(&home).unwrap();
            crate::projects::spawn::LaunchRecipe {
                backend: "kiro",
                env: &[],
                cmd: &format!("echo restarted-{name}"),
                spawned_by: "",
                team: None,
                agent_def: "",
                member: "",
                from_member: "",
                input_mode: "",
            }
            .write(&home)
            .unwrap();
            let mut s = slot(name, "", true);
            s.kind = SlotKind::Agent;
            s.command = Some("kiro".into());
            s.auto_run = true;
            s.agent_session_id = Some(format!("conv-{name}"));
            slots.push(s);
        }
        tmux::ensure_session(&p.session, ws).unwrap();
        // Both stopped: neither window exists.
        assert!(tmux::find_window_by_name(&p.session, "a").is_none());
        assert!(tmux::find_window_by_name(&p.session, "b").is_none());

        // An unknown name is nobody's slot — the caller falls back to spawn.
        assert!(up_agent(&p, &slots, "nobody").is_none());

        let r = up_agent(&p, &slots, "a").expect("a is a slot");
        assert_eq!(r.status, "created", "{r:?}");
        assert!(r.error.is_none(), "{r:?}");
        assert!(tmux::find_window_by_name(&p.session, "a").is_some(), "a is back");
        assert!(
            tmux::find_window_by_name(&p.session, "b").is_none(),
            "b was not asked for and must stay stopped"
        );
        // The staged relaunch line resumes a's EXACT conversation.
        let staged =
            std::fs::read_to_string(crate::projects::spawn::agent_home(ws, "a").join("launch-a.sh")).unwrap();
        assert!(staged.contains("TMM_AGENT=a "), "identity: {staged}");
        assert!(staged.contains("echo restarted-a --resume-id conv-a"), "exact id, not --resume: {staged}");

        // A second call for a live agent changes nothing.
        let again = up_agent(&p, &slots, "a").unwrap();
        assert_eq!(again.status, "existing");
        assert_eq!(tmux::list_named_windows(&p.session).iter().filter(|(n, _)| n == "a").count(), 1);
        assert!(tmux::find_window_by_name(&p.session, "b").is_none(), "still stopped");

        down(&p).unwrap();
    }

    /// The restart replay must never send-keys a long line (tty bursts ≳2KB
    /// get mangled — how codex's ~6 KB relaunch broke, owner 2026-09-08): a
    /// managed agent's line is staged as a script in its home and SOURCED.
    /// Windows without an isolated home keep the direct send, unchanged.
    #[test]
    fn a_managed_relaunch_is_staged_as_a_script_not_a_burst() {
        let ws = std::env::temp_dir().join(format!("tmm-stage-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm").join("agents").join("dev");
        std::fs::create_dir_all(&home).unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let long_line = format!("TMM_PROJECT=p TMM_AGENT=dev command codex {}", "x".repeat(6000));
        let staged = stage_relaunch_script(&ws_str, "dev", &long_line).expect("managed home stages");
        assert!(staged.starts_with(". "), "a source line, not the payload: {staged}");
        assert!(staged.len() < 200, "short enough for one burst: {}", staged.len());
        let script_path = staged.trim_start_matches(". ").trim_matches('\'').to_string();
        let script = std::fs::read_to_string(&script_path).unwrap();
        assert!(script.contains(&long_line), "the script carries the full line");
        // No isolated home → no staging, the caller types the line directly.
        assert!(stage_relaunch_script(&ws_str, "byhand", "kiro-cli chat").is_none());
        std::fs::remove_dir_all(&ws).ok();
    }
}
