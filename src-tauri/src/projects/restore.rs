//! Self-healing after a host reboot (board #422) — the evidence and the
//! decision. Nothing here creates a session, a window or a pane.
//!
//! Three kinds of fact, kept apart (design table, 2026-10-18):
//!
//! * **declaration** — the project rows and slots, and the durable intents a
//!   person leaves: `down` (until a successful `up`) and a managed agent's
//!   Stop (until it is started again). `store::restore` holds the intents;
//! * **complete observation** — the CHECKPOINT the capture tick publishes for
//!   its tmux socket, and only when it saw the whole server: the listing
//!   succeeded before and after, named the same server both times, and every
//!   live project's windows were read (`checkpoint_from`);
//! * **work in progress** — the restore batch, which is a later round's.
//!
//! The decision is two pure functions over those facts: `reboot_trigger`
//! (only a host reboot that took the server with it restores anything) and
//! `plan` (which projects and which of their windows, each skip with its
//! reason). The capture tick never reads `last_seen_at` for any of it.

use super::store::{Checkpoint, CheckpointProject, CheckpointWindow, Project, RestoreIntents, Slot, SlotKind, TmuxInstance};
use super::capture::Observed;
use crate::tmux;

// ---- the host and the tmux server, as they are now ----------------------

/// The host's boot identity: Linux `/proc/sys/kernel/random/boot_id`, macOS
/// `kern.bootsessionuuid` (both measured 2026-10-18). `None` anywhere else or
/// on any read error — and an unknown boot restores nothing.
pub fn boot_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    let raw = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok();
    #[cfg(target_os = "macos")]
    let raw = std::process::Command::new("sysctl")
        .args(["-n", "kern.bootsessionuuid"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string());
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let raw: Option<String> = None;
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The socket this gateway's tmux commands reach: the configured one, else
/// the implicit per-user default. It keys the checkpoint.
pub fn socket_key() -> String {
    tmux::get_socket().unwrap_or_else(|| tmux::implicit_socket().to_string_lossy().to_string())
}

/// What the tmux server on our socket is, right now. `Unknown` is its own
/// answer — a query that failed for any reason other than "no server" is
/// never read as an empty server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxNow {
    Present { instance: TmuxInstance, sessions: Vec<String> },
    Absent,
    Unknown(String),
}

impl TmuxNow {
    pub fn session_names(&self) -> std::collections::HashSet<String> {
        match self {
            TmuxNow::Present { sessions, .. } => sessions.iter().cloned().collect(),
            _ => Default::default(),
        }
    }
}

const SEP: &str = "<TMM_SEP>";

/// ONE `list-sessions` names the server and every session at once.
pub fn tmux_now() -> TmuxNow {
    let format = format!("#{{pid}}{SEP}#{{start_time}}{SEP}#{{socket_path}}{SEP}#{{session_name}}");
    match tmux::run_tmux(&["list-sessions", "-F", &format]) {
        Ok(out) => parse_listing(&out),
        Err(e) if tmux::session_confirmed_absent(&e) => TmuxNow::Absent,
        Err(e) => TmuxNow::Unknown(e),
    }
}

/// Every line must name the same server; a listing that does not (or names
/// none) is not an identity.
fn parse_listing(out: &str) -> TmuxNow {
    let mut instance: Option<TmuxInstance> = None;
    let mut sessions = Vec::new();
    for line in out.lines().filter(|l| !l.is_empty()) {
        let parts: Vec<&str> = line.splitn(4, SEP).collect();
        let [pid, start, socket, name] = parts[..] else {
            return TmuxNow::Unknown(format!("unreadable list-sessions line: {line}"));
        };
        let (Ok(pid), Ok(start_time)) = (pid.parse::<u32>(), start.parse::<u64>()) else {
            return TmuxNow::Unknown(format!("unreadable list-sessions line: {line}"));
        };
        let this = TmuxInstance { socket: socket.to_string(), pid, start_time };
        match &instance {
            Some(seen) if *seen != this => return TmuxNow::Unknown("list-sessions named two servers".into()),
            Some(_) => {}
            None => instance = Some(this),
        }
        sessions.push(name.to_string());
    }
    match instance {
        Some(instance) => TmuxNow::Present { instance, sessions },
        None => TmuxNow::Unknown("list-sessions listed no session".into()),
    }
}

// ---- publication: only a complete observation becomes a checkpoint -------

/// The checkpoint's view of one live project: each observed window once (by
/// name, as `capture::merge` keeps the first), described by the slot the SAME
/// tick folded for it — kind, backend and conversation id are the
/// declaration's, written in the same transaction (`Store::commit_tick`), so
/// evidence and declaration can never be two generations. `managed` names the
/// agent windows whose home is managed, read before the store lock.
pub fn checkpoint_windows(observed: &[Observed], merged: &[Slot], managed: &std::collections::HashSet<String>) -> Vec<CheckpointWindow> {
    let mut seen = std::collections::HashSet::new();
    observed
        .iter()
        .filter(|o| seen.insert(o.window_name.clone()))
        .filter_map(|o| merged.iter().find(|s| s.window_name == o.window_name))
        .map(|s| {
            let agent = s.kind == SlotKind::Agent;
            CheckpointWindow {
                name: s.window_name.clone(),
                kind: s.kind,
                managed: agent && managed.contains(&s.window_name),
                backend: s.command.clone().filter(|_| agent),
                agent_session_id: s.agent_session_id.clone().filter(|_| agent),
            }
        })
        .collect()
}

/// The checkpoint a tick may publish, or why it may not. Complete means:
/// both listings answered, they named the SAME server (or both found none),
/// and every live project's windows were read (`incomplete` names the first
/// that was not). Anything less advances nothing — the previous checkpoint
/// stays the evidence. `gen` is left for `Store::commit_tick` to assign.
pub fn checkpoint_from(
    before: &TmuxNow,
    after: &TmuxNow,
    incomplete: Option<String>,
    projects: Vec<CheckpointProject>,
    boot_id: Option<String>,
    at: u64,
) -> Result<Checkpoint, String> {
    let tmux = match (before, after) {
        (TmuxNow::Unknown(e), _) | (_, TmuxNow::Unknown(e)) => return Err(format!("tmux unknown: {e}")),
        (TmuxNow::Absent, TmuxNow::Absent) => None,
        (TmuxNow::Present { instance: a, .. }, TmuxNow::Present { instance: b, .. }) if a == b => Some(a.clone()),
        _ => return Err("the tmux server changed during the observation".into()),
    };
    if let Some(why) = incomplete {
        return Err(why);
    }
    if tmux.is_none() && !projects.is_empty() {
        return Err("projects observed with no server".into());
    }
    Ok(Checkpoint { gen: 0, at, boot_id, tmux, projects })
}

// ---- the trigger: a host reboot that took the server with it -------------

/// The checkpoint a restore reads (F4 decision): the latest, unless it saw no
/// server and the kept previous one — which did — is from the SAME boot. A
/// tmux death in the last tick before a reboot then still restores; a kept
/// checkpoint from an earlier boot never does (it would bring back what was
/// up two reboots ago). The way out for "I killed everything, then
/// rebooted" is a down, whose mark the plan honours.
pub fn evidence<'a>(latest: Option<&'a Checkpoint>, prev: Option<&'a Checkpoint>) -> Option<&'a Checkpoint> {
    match (latest, prev) {
        (Some(l), Some(p)) if l.tmux.is_none() && p.tmux.is_some() && l.boot_id.is_some() && l.boot_id == p.boot_id => Some(p),
        (latest, _) => latest,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Trigger {
    Restore,
    Skip(String),
}

/// Whether a gateway start restores anything (R0–R3). Only a host reboot
/// counts: the checkpoint's boot id and today's are both known and differ,
/// and the server that held the sessions is gone — none now, or another
/// instance on the socket. Everything else is a person's act or a fact we
/// cannot read, and restores nothing: the last session killed while the
/// gateway was stopped (same boot), a `kill-server` without a reboot (same
/// boot), a session missing from a live server (same instance), an unknown
/// boot or tmux state, and no checkpoint at all (the first start after the
/// upgrade).
pub fn reboot_trigger(enabled: bool, cp: Option<&Checkpoint>, boot_now: Option<&str>, tmux_now: &TmuxNow) -> Trigger {
    let skip = |why: &str| Trigger::Skip(why.to_string());
    if !enabled {
        return skip("restore on start is off");
    }
    let Some(cp) = cp else {
        return skip("no checkpoint for this tmux socket yet");
    };
    let (Some(then), Some(now)) = (cp.boot_id.as_deref(), boot_now) else {
        return skip("the host's boot identity is unknown");
    };
    if then == now {
        return skip("the host did not reboot");
    }
    match tmux_now {
        TmuxNow::Unknown(e) => Trigger::Skip(format!("the tmux server's state is unknown: {e}")),
        TmuxNow::Present { instance, .. } if cp.tmux.as_ref() == Some(instance) => {
            skip("the tmux server that held the sessions is still running")
        }
        _ => Trigger::Restore,
    }
}

// ---- the plan: which projects, which windows, and why not the rest -------

/// Why a project or a window is not in the plan. One word each for a
/// machine, `text` for a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Deleted,
    Archived,
    Down,
    PathMissing,
    NotLive,
    NotDeclared,
    KindMismatch,
    ChangedSinceCheckpoint,
    Unsettled,
    Stopped,
    ManagedHomeMissing,
    NoSavedConversation,
    NoExactResume,
    AutostartAgent,
}

impl SkipReason {
    pub fn text(self) -> &'static str {
        match self {
            SkipReason::Deleted => "the project was deleted",
            SkipReason::Archived => "the project is archived",
            SkipReason::Down => "the project was taken down",
            SkipReason::PathMissing => "the project's directory is gone",
            SkipReason::NotLive => "not running at the last checkpoint",
            SkipReason::NotDeclared => "not in the declaration yet",
            SkipReason::KindMismatch => "the checkpoint and the declaration disagree on what this window is",
            SkipReason::ChangedSinceCheckpoint => "the agent's declared identity changed since the checkpoint",
            SkipReason::Unsettled => "younger than the settle window",
            SkipReason::Stopped => "the agent was stopped",
            SkipReason::ManagedHomeMissing => "the managed home or its launch recipe is missing",
            SkipReason::NoSavedConversation => "no saved conversation",
            SkipReason::NoExactResume => "the CLI cannot resume an exact conversation",
            SkipReason::AutostartAgent => "autostart starts shells only; agents are not started",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ProjectSkip {
    pub id: String,
    pub name: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct WindowSkip {
    pub name: String,
    pub reason: SkipReason,
}

/// One window to bring back, with everything its launch needs: an agent
/// carries the exact conversation it resumes, never "the newest one".
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PlannedWindow {
    pub name: String,
    pub kind: SlotKind,
    pub managed: bool,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct PlannedProject {
    pub id: String,
    pub name: String,
    pub path: String,
    pub session: String,
    /// Brought back for its `autostart` flag, not because the checkpoint saw
    /// it: shells only.
    pub autostart_only: bool,
    pub windows: Vec<PlannedWindow>,
    pub skipped: Vec<WindowSkip>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Plan {
    /// The checkpoint this plan was read from.
    pub source_gen: u64,
    pub projects: Vec<PlannedProject>,
    pub skipped: Vec<ProjectSkip>,
}

/// A project as declared now, with its slots.
pub struct Declared {
    pub project: Project,
    pub slots: Vec<Slot>,
}

/// The filesystem facts the plan needs, read at plan time (the test passes
/// its own).
pub trait Facts {
    fn path_exists(&self, path: &str) -> bool;
    /// The managed launch door can build this window's line: the home is
    /// managed and its `launch.json` holds a command.
    fn managed_recipe(&self, project_path: &str, window: &str) -> bool;
    /// The generic line resumes an exact conversation (adopted agents).
    fn exact_resume(&self, backend: &str) -> bool;
}

pub struct LiveFacts;

impl Facts for LiveFacts {
    fn path_exists(&self, path: &str) -> bool {
        std::path::Path::new(path).is_dir()
    }

    fn managed_recipe(&self, project_path: &str, window: &str) -> bool {
        let Some(home) = super::agents::home_dir(project_path, window) else { return false };
        super::managed::home_is_managed(&home, window)
            && std::fs::read_to_string(home.join("launch.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .is_some_and(|v| v.get("cmd").and_then(|c| c.as_str()).is_some_and(|c| !c.trim().is_empty()))
    }

    fn exact_resume(&self, backend: &str) -> bool {
        super::agents::resumes_exactly(backend)
    }
}

/// What to bring back from `cp`, given what is declared and intended NOW.
///
/// A project comes back when the checkpoint saw it live and it still exists,
/// is not archived, was not taken down, and its directory is there. Of its
/// slots, only those that were LIVE in the checkpoint, settled, and not
/// stopped by a person; an agent additionally needs its saved conversation
/// id and an identity that can be proven — a managed agent its recipe, an
/// adopted one a CLI that resumes exactly. `include_autostart` adds autostart
/// projects the checkpoint did not see, as shells only (nothing is guessed
/// from history), under the same project rules. Pure: every fact is an input.
pub fn plan(cp: &Checkpoint, declared: &[Declared], intents: &RestoreIntents, include_autostart: bool, facts: &dyn Facts) -> Plan {
    let by_id: std::collections::HashMap<&str, &Declared> = declared.iter().map(|d| (d.project.id.as_str(), d)).collect();
    let mut out = Plan { source_gen: cp.gen, projects: Vec::new(), skipped: Vec::new() };
    for seen in &cp.projects {
        let Some(d) = by_id.get(seen.id.as_str()) else {
            out.skipped.push(ProjectSkip { id: seen.id.clone(), name: seen.session.clone(), reason: SkipReason::Deleted });
            continue;
        };
        match project_block(&d.project, intents, facts) {
            Some(reason) => out.skipped.push(skip_project(&d.project, reason)),
            None => out.projects.push(plan_project(d, Some(seen), intents, facts)),
        }
    }
    if include_autostart {
        for d in declared.iter().filter(|d| d.project.autostart) {
            if cp.projects.iter().any(|p| p.id == d.project.id) {
                continue;
            }
            match project_block(&d.project, intents, facts) {
                Some(reason) => out.skipped.push(skip_project(&d.project, reason)),
                None => out.projects.push(plan_project(d, None, intents, facts)),
            }
        }
    }
    out
}

fn skip_project(p: &Project, reason: SkipReason) -> ProjectSkip {
    ProjectSkip { id: p.id.clone(), name: p.name.clone(), reason }
}

fn project_block(p: &Project, intents: &RestoreIntents, facts: &dyn Facts) -> Option<SkipReason> {
    if p.archived {
        Some(SkipReason::Archived)
    } else if intents.down.contains(&p.id) {
        Some(SkipReason::Down)
    } else if !facts.path_exists(&p.path) {
        Some(SkipReason::PathMissing)
    } else {
        None
    }
}

/// `seen` is the checkpoint's view of the project; `None` for an
/// autostart-only project.
fn plan_project(d: &Declared, seen: Option<&CheckpointProject>, intents: &RestoreIntents, facts: &dyn Facts) -> PlannedProject {
    let p = &d.project;
    let mut windows = Vec::new();
    let mut skipped = Vec::new();
    for slot in &d.slots {
        let live = seen.map(|s| s.windows.iter().find(|w| w.name == slot.window_name));
        match window_verdict(p, slot, live, intents, facts) {
            Ok(managed) => windows.push(PlannedWindow {
                name: slot.window_name.clone(),
                kind: slot.kind,
                managed,
                cwd: slot.cwd.clone(),
                backend: (slot.kind == SlotKind::Agent).then(|| slot.command.clone()).flatten(),
                agent_session_id: (slot.kind == SlotKind::Agent).then(|| slot.agent_session_id.clone()).flatten(),
            }),
            Err(reason) => skipped.push(WindowSkip { name: slot.window_name.clone(), reason }),
        }
    }
    // A window the checkpoint saw that the declaration does not hold (it was
    // younger than one fold) is said, so "why did X not come back" has an answer.
    if let Some(seen) = seen {
        for w in seen.windows.iter().filter(|w| !d.slots.iter().any(|s| s.window_name == w.name)) {
            skipped.push(WindowSkip { name: w.name.clone(), reason: SkipReason::NotDeclared });
        }
    }
    PlannedProject {
        id: p.id.clone(),
        name: p.name.clone(),
        path: p.path.clone(),
        session: p.session.clone(),
        autostart_only: seen.is_none(),
        windows,
        skipped,
    }
}

/// `live`: `None` = autostart-only (no checkpoint view); `Some(None)` = the
/// checkpoint did not see this window. `Ok(managed)` when it comes back.
fn window_verdict(
    p: &Project,
    slot: &Slot,
    live: Option<Option<&CheckpointWindow>>,
    intents: &RestoreIntents,
    facts: &dyn Facts,
) -> Result<bool, SkipReason> {
    let managed = match live {
        Some(None) => return Err(SkipReason::NotLive),
        // The plan never takes the declaration's identity over the
        // observation's (review P1-B): a window the checkpoint saw as a
        // shell is never planned as an agent, nor the reverse, and an agent
        // whose backend or conversation moved on since is not this one.
        Some(Some(w)) if w.kind != slot.kind => return Err(SkipReason::KindMismatch),
        Some(Some(w)) if w.kind == SlotKind::Agent && (w.backend != slot.command || w.agent_session_id != slot.agent_session_id) => {
            return Err(SkipReason::ChangedSinceCheckpoint)
        }
        Some(Some(w)) => w.managed,
        None if slot.kind == SlotKind::Agent => return Err(SkipReason::AutostartAgent),
        None => false,
    };
    if !slot.is_settled() {
        return Err(SkipReason::Unsettled);
    }
    if intents.stopped.contains(&(p.id.clone(), slot.window_name.clone())) {
        return Err(SkipReason::Stopped);
    }
    if slot.kind == SlotKind::Shell {
        return Ok(false);
    }
    if !slot.agent_session_id.as_deref().is_some_and(|s| !s.trim().is_empty()) {
        return Err(SkipReason::NoSavedConversation);
    }
    if managed {
        if !facts.managed_recipe(&p.path, &slot.window_name) {
            return Err(SkipReason::ManagedHomeMissing);
        }
    } else if !slot.command.as_deref().is_some_and(|b| facts.exact_resume(b)) {
        return Err(SkipReason::NoExactResume);
    }
    Ok(managed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn inst(pid: u32, start_time: u64) -> TmuxInstance {
        TmuxInstance { socket: "/tmp/tmux-1/default".into(), pid, start_time }
    }

    fn present(pid: u32, start_time: u64) -> TmuxNow {
        TmuxNow::Present { instance: inst(pid, start_time), sessions: vec!["a".into()] }
    }

    fn win(name: &str, kind: SlotKind, managed: bool) -> CheckpointWindow {
        CheckpointWindow { name: name.into(), kind, managed, backend: None, agent_session_id: None }
    }

    /// The window as the tick that folded `slot` would have recorded it.
    fn seen_as(slot: &Slot, managed: bool) -> CheckpointWindow {
        let obs = Observed {
            window: 0,
            window_name: slot.window_name.clone(),
            cwd: String::new(),
            kind: slot.kind,
            command: None,
            agent_session_id: None,
        };
        let managed: HashSet<String> = managed.then(|| slot.window_name.clone()).into_iter().collect();
        checkpoint_windows(&[obs], std::slice::from_ref(slot), &managed).remove(0)
    }

    fn checkpoint(boot: Option<&str>, tmux: Option<TmuxInstance>, projects: Vec<CheckpointProject>) -> Checkpoint {
        Checkpoint { gen: 4, at: 1_000, boot_id: boot.map(str::to_string), tmux, projects }
    }

    fn cp_project(id: &str, windows: Vec<CheckpointWindow>) -> CheckpointProject {
        CheckpointProject { id: id.into(), session: id.into(), windows }
    }

    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: format!("{id}-name"),
            path: format!("/w/{id}"),
            icon: None,
            session: id.into(),
            adopted: false,
            autostart: false,
            created_at: 1,
            last_up_at: None,
            last_seen_at: None,
            archived: false,
            room: String::new(),
        }
    }

    fn shell(name: &str) -> Slot {
        Slot {
            id: None,
            ord: 0,
            window_name: name.into(),
            cwd: "sub".into(),
            kind: SlotKind::Shell,
            command: Some("npm run dev".into()),
            auto_run: false,
            agent_session_id: None,
            first_seen_at: 1,
            settled_at: Some(200),
        }
    }

    fn agent(name: &str, backend: &str, id: Option<&str>) -> Slot {
        Slot {
            kind: SlotKind::Agent,
            command: Some(backend.into()),
            auto_run: true,
            agent_session_id: id.map(str::to_string),
            cwd: String::new(),
            ..shell(name)
        }
    }

    /// Paths that exist, managed homes whose recipe reads, CLIs with an
    /// exact resume — whatever the test says.
    struct Fake {
        paths: HashSet<String>,
        recipes: HashSet<(String, String)>,
        exact: HashSet<String>,
    }

    impl Fake {
        fn with_paths(paths: &[&str]) -> Fake {
            Fake {
                paths: paths.iter().map(|p| p.to_string()).collect(),
                recipes: HashSet::new(),
                exact: ["kiro", "claude"].iter().map(|s| s.to_string()).collect(),
            }
        }
    }

    impl Facts for Fake {
        fn path_exists(&self, path: &str) -> bool {
            self.paths.contains(path)
        }
        fn managed_recipe(&self, project_path: &str, window: &str) -> bool {
            self.recipes.contains(&(project_path.to_string(), window.to_string()))
        }
        fn exact_resume(&self, backend: &str) -> bool {
            self.exact.contains(backend)
        }
    }

    fn names(p: &PlannedProject) -> Vec<&str> {
        p.windows.iter().map(|w| w.name.as_str()).collect()
    }

    fn reason_of(p: &PlannedProject, name: &str) -> Option<SkipReason> {
        p.skipped.iter().find(|s| s.name == name).map(|s| s.reason)
    }

    // ---- T1: only a complete observation is published ---------------------

    #[test]
    fn t1_only_a_complete_observation_becomes_a_checkpoint() {
        let ok = || vec![cp_project("a", vec![win("w", SlotKind::Shell, false)])];
        // Control: the same server before and after, every project read.
        let cp = checkpoint_from(&present(7, 900), &present(7, 900), None, ok(), Some("boot".into()), 1_000).unwrap();
        assert_eq!(cp.tmux, Some(inst(7, 900)));
        assert_eq!(cp.projects.len(), 1);
        assert_eq!(cp.boot_id.as_deref(), Some("boot"));

        // A tmux query that failed is not an empty server, before or after.
        let unknown = TmuxNow::Unknown("tmux error: Permission denied".into());
        assert!(checkpoint_from(&unknown, &present(7, 900), None, ok(), None, 1).is_err());
        assert!(checkpoint_from(&present(7, 900), &unknown, None, ok(), None, 1).is_err());
        // The server changed under the observation: another instance, or it went away.
        assert!(checkpoint_from(&present(7, 900), &present(8, 950), None, ok(), None, 1).is_err());
        assert!(checkpoint_from(&present(7, 900), &TmuxNow::Absent, None, ok(), None, 1).is_err());
        assert!(checkpoint_from(&TmuxNow::Absent, &present(7, 900), None, vec![], None, 1).is_err());
        // One project whose windows could not be read makes the whole tick incomplete.
        let partial = Some("b: can't find session: b".to_string());
        assert!(checkpoint_from(&present(7, 900), &present(7, 900), partial, ok(), None, 1).is_err());

        // No server before and after is a complete observation: nothing was up.
        let none = checkpoint_from(&TmuxNow::Absent, &TmuxNow::Absent, None, vec![], Some("boot".into()), 1).unwrap();
        assert_eq!((none.tmux, none.projects.len()), (None, 0));
    }

    /// The checkpoint describes each live window by the slot the same tick
    /// folded: one entry per name, live windows only (a stopped managed slot
    /// the fold kept is not live), the agent identity carried, a shell's
    /// observed command not.
    #[test]
    fn checkpoint_windows_are_the_folded_slots_of_the_live_windows() {
        let obs = |name: &str, kind| Observed { window: 0, window_name: name.into(), cwd: String::new(), kind, command: None, agent_session_id: None };
        let observed = vec![obs("a", SlotKind::Agent), obs("a", SlotKind::Shell), obs("sh", SlotKind::Shell)];
        let merged = vec![agent("a", "kiro", Some("conv-a")), shell("sh"), agent("stopped", "kiro", Some("conv-s"))];
        let managed = HashSet::from(["a".to_string(), "sh".to_string()]);
        let got = checkpoint_windows(&observed, &merged, &managed);
        assert_eq!(
            got,
            vec![
                CheckpointWindow { name: "a".into(), kind: SlotKind::Agent, managed: true, backend: Some("kiro".into()), agent_session_id: Some("conv-a".into()) },
                CheckpointWindow { name: "sh".into(), kind: SlotKind::Shell, managed: false, backend: None, agent_session_id: None },
            ]
        );
    }

    #[test]
    fn a_listing_names_one_server_or_is_unknown() {
        let line = |pid: &str, name: &str| format!("{pid}{SEP}1792331366{SEP}/tmp/s{SEP}{name}\n");
        let got = parse_listing(&format!("{}{}", line("408431", "a"), line("408431", "b c")));
        assert_eq!(
            got,
            TmuxNow::Present {
                instance: TmuxInstance { socket: "/tmp/s".into(), pid: 408431, start_time: 1792331366 },
                sessions: vec!["a".into(), "b c".into()],
            }
        );
        assert!(matches!(parse_listing(&format!("{}{}", line("1", "a"), line("2", "b"))), TmuxNow::Unknown(_)));
        assert!(matches!(parse_listing(""), TmuxNow::Unknown(_)), "a listing with no session names no server");
        assert!(matches!(parse_listing("garbage\n"), TmuxNow::Unknown(_)));
    }

    /// The real tmux shapes (measured 2026-10-18, tmux 3.6a): a private
    /// server answers Present with its own pid, the same on a second ask; no
    /// server is Absent; an unreachable socket is Unknown, never Absent.
    #[test]
    fn the_tmux_server_reads_as_present_absent_or_unknown() {
        let scope = tmux::test_support::GlobalSocket::hold();
        let server = tmux::test_support::PrivateTmux::start(&scope, "restore-now");
        assert_eq!(tmux_now(), TmuxNow::Absent, "no server yet on a fresh socket");
        server.run(&["new-session", "-d", "-s", "one"]).unwrap();
        server.run(&["new-session", "-d", "-s", "two words"]).unwrap();
        let first = tmux_now();
        let TmuxNow::Present { instance, sessions } = &first else { panic!("{first:?}") };
        assert_eq!(instance.socket, server.socket());
        assert!(instance.pid > 0 && instance.start_time > 0);
        assert_eq!(sessions.iter().collect::<HashSet<_>>(), HashSet::from([&"one".to_string(), &"two words".to_string()]));
        assert_eq!(tmux_now(), first, "the same server answers the same identity");
        assert_eq!(socket_key(), server.socket(), "the checkpoint is keyed by the socket we reach");

        let dir = std::env::temp_dir().join(format!("tmm-test-restore-locked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        scope.set(Some(dir.join("x.sock").to_string_lossy().to_string()));
        let locked = tmux_now();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(matches!(locked, TmuxNow::Unknown(_)), "permission denied is unknown, not an empty server: {locked:?}");
        drop(server);
    }

    // ---- T2/T3: a person's down outlives every later observation ----------

    #[test]
    fn t2_t3_a_down_suppresses_until_an_explicit_up_clears_it() {
        let cp = checkpoint(Some("old"), Some(inst(7, 900)), vec![cp_project("a", vec![win("w", SlotKind::Shell, false)])]);
        let declared = vec![Declared { project: project("a"), slots: vec![shell("w")] }];
        let facts = Fake::with_paths(&["/w/a"]);
        // Control: no intent, the project comes back.
        let open = plan(&cp, &declared, &RestoreIntents::default(), false, &facts);
        assert_eq!(open.projects.len(), 1);
        // T2: the checkpoint saw it live (the down raced the observation, the
        // same second included) — the durable mark still wins.
        // T3: the kill failed and later ticks keep seeing it live — still
        // suppressed; no observation revokes a person's down.
        let mut intents = RestoreIntents::default();
        intents.down.insert("a".into());
        let downed = plan(&cp, &declared, &intents, false, &facts);
        assert!(downed.projects.is_empty());
        assert_eq!(downed.skipped, vec![ProjectSkip { id: "a".into(), name: "a-name".into(), reason: SkipReason::Down }]);
    }

    // ---- T4 (+ T19's reread half): which projects ------------------------

    #[test]
    fn t4_only_a_seen_live_existing_reachable_project_is_planned() {
        let w = || vec![win("w", SlotKind::Shell, false)];
        let cp = checkpoint(
            Some("old"),
            Some(inst(7, 900)),
            vec![
                cp_project("seen", w()),
                cp_project("downed", w()),
                cp_project("archived", w()),
                cp_project("deleted", w()),
                cp_project("nopath", w()),
            ],
        );
        let mut archived = project("archived");
        archived.archived = true;
        let mut auto_down = project("auto-down");
        auto_down.autostart = true;
        let mut auto_archived = project("auto-archived");
        auto_archived.autostart = true;
        auto_archived.archived = true;
        let mut auto = project("auto");
        auto.autostart = true;
        let declared: Vec<Declared> = [project("seen"), project("downed"), archived, project("nopath"), auto_down, auto_archived, auto, project("never")]
            .into_iter()
            .map(|p| Declared { project: p, slots: vec![shell("w")] })
            .collect();
        let mut intents = RestoreIntents::default();
        intents.down.insert("downed".into());
        intents.down.insert("auto-down".into());
        let facts = Fake::with_paths(&["/w/seen", "/w/downed", "/w/archived", "/w/auto-down", "/w/auto-archived", "/w/auto", "/w/never"]);

        let got = plan(&cp, &declared, &intents, false, &facts);
        assert_eq!(got.source_gen, 4);
        assert_eq!(got.projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["seen"]);
        let reasons: Vec<(&str, SkipReason)> = got.skipped.iter().map(|s| (s.id.as_str(), s.reason)).collect();
        assert_eq!(
            reasons,
            [
                ("downed", SkipReason::Down),
                ("archived", SkipReason::Archived),
                ("deleted", SkipReason::Deleted),
                ("nopath", SkipReason::PathMissing),
            ]
        );
        assert!(!got.skipped.iter().any(|s| s.id == "never"), "a project the checkpoint did not see is not considered");

        // With autostart: only the autostart project that nothing suppresses is
        // added — autostart never beats a down or an archive.
        let got = plan(&cp, &declared, &intents, true, &facts);
        let ids: Vec<&str> = got.projects.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["seen", "auto"]);
        assert!(got.projects[1].autostart_only);
        assert!(got.skipped.iter().any(|s| s.id == "auto-down" && s.reason == SkipReason::Down));
        assert!(got.skipped.iter().any(|s| s.id == "auto-archived" && s.reason == SkipReason::Archived));
    }

    // ---- T5 (+ T19): which windows ---------------------------------------

    #[test]
    fn t5_only_live_unstopped_windows_with_a_provable_identity_are_planned() {
        let mut unsettled = shell("U");
        unsettled.settled_at = None;
        let slots = vec![
            agent("A", "kiro", Some("conv-a")), // live managed, recipe reads
            agent("B", "kiro", Some("conv-b")), // managed, stopped before the checkpoint: not live
            agent("C", "kiro", Some("conv-c")), // live managed, home deleted
            agent("D", "kiro", None),           // live managed, no saved conversation
            agent("E", "claude", Some("conv-e")), // live adopted, CLI resumes exactly
            shell("F"),                         // live shell
            agent("G", "kiro", Some("conv-g")), // live managed, stopped AFTER the checkpoint
            agent("H", "dsh", Some("conv-h")),  // live adopted, no exact generic resume
            unsettled,
        ];
        let managed = ["A", "C", "D", "G"];
        let mut windows: Vec<CheckpointWindow> =
            slots.iter().filter(|s| s.window_name != "B").map(|s| seen_as(s, managed.contains(&s.window_name.as_str()))).collect();
        windows.push(win("young", SlotKind::Shell, false));
        let cp = checkpoint(Some("old"), Some(inst(7, 900)), vec![cp_project("p", windows)]);
        let declared = vec![Declared { project: project("p"), slots }];
        let mut facts = Fake::with_paths(&["/w/p"]);
        for w in ["A", "B", "D", "G"] {
            facts.recipes.insert(("/w/p".into(), w.into()));
        }
        let mut intents = RestoreIntents::default();
        intents.stopped.insert(("p".into(), "G".into()));

        let got = plan(&cp, &declared, &intents, false, &facts);
        let p = &got.projects[0];
        assert_eq!(names(p), ["A", "E", "F"]);
        let a = &p.windows[0];
        assert_eq!((a.managed, a.agent_session_id.as_deref(), a.backend.as_deref()), (true, Some("conv-a"), Some("kiro")), "the exact id travels with the plan");
        assert_eq!((p.windows[1].managed, p.windows[1].agent_session_id.as_deref()), (false, Some("conv-e")));
        let f = &p.windows[2];
        assert_eq!((f.kind, f.cwd.as_str(), f.backend.as_deref()), (SlotKind::Shell, "sub", None), "a shell's observed command is never carried");
        assert_eq!(reason_of(p, "B"), Some(SkipReason::NotLive));
        assert_eq!(reason_of(p, "C"), Some(SkipReason::ManagedHomeMissing));
        assert_eq!(reason_of(p, "D"), Some(SkipReason::NoSavedConversation));
        assert_eq!(reason_of(p, "G"), Some(SkipReason::Stopped));
        assert_eq!(reason_of(p, "H"), Some(SkipReason::NoExactResume));
        assert_eq!(reason_of(p, "U"), Some(SkipReason::Unsettled));
        assert_eq!(reason_of(p, "young"), Some(SkipReason::NotDeclared));

        // Control: restarting G clears its mark, and it is planned again.
        let got = plan(&cp, &declared, &RestoreIntents::default(), false, &facts);
        assert_eq!(names(&got.projects[0]), ["A", "E", "F", "G"]);
        // T19's reread half: the home lost after the checkpoint is seen at plan time.
        facts.recipes.remove(&("/w/p".to_string(), "A".to_string()));
        let got = plan(&cp, &declared, &RestoreIntents::default(), false, &facts);
        assert_eq!(reason_of(&got.projects[0], "A"), Some(SkipReason::ManagedHomeMissing));
    }

    #[test]
    fn an_autostart_project_the_checkpoint_did_not_see_brings_shells_only() {
        let cp = checkpoint(Some("old"), Some(inst(7, 900)), vec![]);
        let mut p = project("auto");
        p.autostart = true;
        let declared = vec![Declared { project: p, slots: vec![shell("F"), agent("A", "kiro", Some("conv-a"))] }];
        let mut facts = Fake::with_paths(&["/w/auto"]);
        facts.recipes.insert(("/w/auto".into(), "A".into()));
        let got = plan(&cp, &declared, &RestoreIntents::default(), true, &facts);
        let p = &got.projects[0];
        assert!(p.autostart_only);
        assert_eq!(names(p), ["F"]);
        assert_eq!(reason_of(p, "A"), Some(SkipReason::AutostartAgent));
        // Control: without the autostart flag in play nothing is planned.
        assert!(plan(&cp, &declared, &RestoreIntents::default(), false, &facts).projects.is_empty());
    }

    /// Review P1-B: the plan never stitches two generations together. A
    /// window the checkpoint saw as a shell whose declaration still says agent
    /// (a fold that did not land with it) is refused, never planned as a CLI;
    /// the reverse too; and an agent whose backend or conversation moved on
    /// since the checkpoint is not the one it saw.
    #[test]
    fn the_plan_refuses_a_window_whose_declaration_disagrees_with_the_checkpoint() {
        let mut facts = Fake::with_paths(&["/w/p"]);
        facts.recipes.insert(("/w/p".into(), "w".into()));
        let run = |cp_window: CheckpointWindow, slot: Slot| {
            let cp = checkpoint(Some("old"), Some(inst(7, 900)), vec![cp_project("p", vec![cp_window])]);
            let got = plan(&cp, &[Declared { project: project("p"), slots: vec![slot] }], &RestoreIntents::default(), false, &facts);
            got.projects[0].clone()
        };
        let old_agent = agent("w", "kiro", Some("conv-1"));
        // Control: a checkpoint taken with this very declaration plans it.
        assert_eq!(names(&run(seen_as(&old_agent, true), old_agent.clone())), ["w"]);
        // Observed shell, declared agent: no CLI.
        let p = run(win("w", SlotKind::Shell, false), old_agent.clone());
        assert!(p.windows.is_empty(), "{p:?}");
        assert_eq!(reason_of(&p, "w"), Some(SkipReason::KindMismatch));
        // Observed agent, declared shell.
        let p = run(seen_as(&old_agent, true), shell("w"));
        assert_eq!(reason_of(&p, "w"), Some(SkipReason::KindMismatch));
        // Same kind, another conversation or another backend.
        let p = run(seen_as(&old_agent, true), agent("w", "kiro", Some("conv-2")));
        assert_eq!(reason_of(&p, "w"), Some(SkipReason::ChangedSinceCheckpoint));
        let p = run(seen_as(&old_agent, true), agent("w", "claude", Some("conv-1")));
        assert_eq!(reason_of(&p, "w"), Some(SkipReason::ChangedSinceCheckpoint));
    }

    // ---- T6: the trigger matrix -------------------------------------------

    #[test]
    fn t6_only_a_reboot_that_took_the_server_restores() {
        let cp = checkpoint(Some("boot-1"), Some(inst(7, 900)), vec![]);
        let restore = |enabled, cp: Option<&Checkpoint>, boot: Option<&str>, now: &TmuxNow| reboot_trigger(enabled, cp, boot, now) == Trigger::Restore;

        // Control: a new boot, and the server is gone or another instance.
        assert!(restore(true, Some(&cp), Some("boot-2"), &TmuxNow::Absent));
        assert!(restore(true, Some(&cp), Some("boot-2"), &present(8, 950)));
        let empty = checkpoint(Some("boot-1"), None, vec![]);
        assert!(restore(true, Some(&empty), Some("boot-2"), &present(8, 950)), "a server that appeared after the reboot is a new instance");

        // Same boot, new server: the last session killed while the gateway was
        // stopped, or a kill-server — a person's act, not a reboot.
        assert!(!restore(true, Some(&cp), Some("boot-1"), &TmuxNow::Absent));
        assert!(!restore(true, Some(&cp), Some("boot-1"), &present(8, 950)));
        // New boot but the SAME server instance (nothing was lost).
        assert!(!restore(true, Some(&cp), Some("boot-2"), &present(7, 900)));
        // Unknown boot (either side) or unknown tmux.
        assert!(!restore(true, Some(&cp), None, &TmuxNow::Absent));
        let no_boot = checkpoint(None, Some(inst(7, 900)), vec![]);
        assert!(!restore(true, Some(&no_boot), Some("boot-2"), &TmuxNow::Absent));
        assert!(!restore(true, Some(&cp), Some("boot-2"), &TmuxNow::Unknown("Permission denied".into())));
        // No checkpoint (first start after the upgrade), and the kill switch.
        assert!(!restore(true, None, Some("boot-2"), &TmuxNow::Absent));
        assert!(!restore(false, Some(&cp), Some("boot-2"), &TmuxNow::Absent));
        assert_eq!(
            reboot_trigger(true, Some(&cp), Some("boot-1"), &TmuxNow::Absent),
            Trigger::Skip("the host did not reboot".into()),
            "every skip says why"
        );
    }

    /// F4 decision: an empty latest checkpoint defers to the kept one from the
    /// same boot, and the trigger then restores from it after a reboot; a kept
    /// one from an earlier boot is never used.
    #[test]
    fn an_empty_latest_checkpoint_defers_to_the_kept_one_from_the_same_boot() {
        let seen = checkpoint(Some("boot-1"), Some(inst(7, 900)), vec![cp_project("a", vec![win("w", SlotKind::Shell, false)])]);
        let empty = checkpoint(Some("boot-1"), None, vec![]);
        assert_eq!(evidence(Some(&empty), Some(&seen)), Some(&seen));
        assert_eq!(reboot_trigger(true, evidence(Some(&empty), Some(&seen)), Some("boot-2"), &TmuxNow::Absent), Trigger::Restore);
        // Controls: a latest that saw a server is the evidence; a kept one from another boot is not.
        assert_eq!(evidence(Some(&seen), Some(&seen)), Some(&seen));
        let earlier = checkpoint(Some("boot-0"), Some(inst(5, 100)), vec![cp_project("old", vec![])]);
        assert_eq!(evidence(Some(&empty), Some(&earlier)), Some(&empty));
        assert_eq!(evidence(None, Some(&seen)), None, "no latest, no evidence");
        let unknown_boot = checkpoint(None, None, vec![]);
        assert_eq!(evidence(Some(&unknown_boot), Some(&seen)), Some(&unknown_boot), "an unknown boot never matches");
        let unknown_seen = checkpoint(None, Some(inst(7, 900)), vec![]);
        assert_eq!(evidence(Some(&unknown_boot), Some(&unknown_seen)), Some(&unknown_boot), "two unknown boots are not the same boot");
    }

    /// The live filesystem facts the plan reads (validator L10): a managed
    /// recipe needs a launch.json with a command; an exact resume is a
    /// backend's `resume_id`, which dsh and openclaw do not have.
    #[test]
    fn live_facts_read_the_recipe_and_the_resume_table() {
        let ws = std::env::temp_dir().join(format!("tmm-facts-{}", uuid::Uuid::new_v4()));
        let path = ws.to_string_lossy().to_string();
        for (name, recipe) in [("ok", r#"{"cmd":"kiro-cli chat"}"#), ("nocmd", "{}"), ("blank", r#"{"cmd":"  "}"#), ("broken", "{")] {
            std::fs::create_dir_all(ws.join(".tmm/agents").join(name)).unwrap();
            std::fs::write(ws.join(".tmm/agents").join(name).join("launch.json"), recipe).unwrap();
        }
        let f = LiveFacts;
        assert!(f.path_exists(&path) && !f.path_exists("/nonexistent-tmm-422"));
        assert!(f.managed_recipe(&path, "ok"));
        for name in ["nocmd", "blank", "broken", "missing", ".."] {
            assert!(!f.managed_recipe(&path, name), "{name}");
        }
        assert!(f.exact_resume("kiro") && f.exact_resume("codex") && f.exact_resume("claude"));
        assert!(!f.exact_resume("dsh") && !f.exact_resume("openclaw") && !f.exact_resume("nope"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Validator F1 + review P1-A residual: a hire, a team member and a fork
    /// all go through `spawn`, which takes ONE start permit once the window
    /// name is decided and before anything is written for it, and finishes it
    /// after the launch; the nested launches (`launch_window`, `respawn`)
    /// never read or clear a Stop — a restart's respawn runs under the hub's
    /// permit. The planner then sees no mark for an agent hired again.
    #[test]
    fn every_managed_launch_is_a_start_for_the_stop_intent() {
        let src = include_str!("spawn.rs");
        let prod = &src[..src.find("\n#[cfg(test)]").unwrap()];
        let body_of = |sig: &str| {
            let body = &prod[prod.find(sig).unwrap_or_else(|| panic!("{sig}"))..];
            body[..body.find("\n}\n").unwrap()].to_string()
        };
        let spawn = body_of("pub fn spawn(req: &SpawnRequest)");
        let (permit, materialize, launch, finish) = (
            spawn.find("super::start_permit(req.session, &window_name)").expect("spawn takes a permit"),
            spawn.find("materialize(&section").unwrap(),
            spawn.find("launch_window(req").unwrap(),
            spawn.find("permit.finish(true)").expect("and finishes it"),
        );
        assert!(spawn.find("let window_name = match").unwrap() < permit && permit < materialize && launch < finish, "{spawn}");
        for sig in ["fn launch_window(", "pub fn respawn("] {
            let body = body_of(sig);
            assert!(!body.contains("start_permit") && !body.contains("slot_stopped") && !body.contains("finish("), "{sig} must not touch the intent: {body}");
        }

        let slot = agent("G", "kiro", Some("conv-g"));
        let cp = checkpoint(Some("old"), Some(inst(7, 900)), vec![cp_project("p", vec![seen_as(&slot, true)])]);
        let declared = vec![Declared { project: project("p"), slots: vec![slot] }];
        let mut facts = Fake::with_paths(&["/w/p"]);
        facts.recipes.insert(("/w/p".into(), "G".into()));
        let mut stopped = RestoreIntents::default();
        stopped.stopped.insert(("p".into(), "G".into()));
        assert_eq!(reason_of(&plan(&cp, &declared, &stopped, false, &facts).projects[0], "G"), Some(SkipReason::Stopped));
        // Started again through spawn: its mark is gone, and it is planned.
        assert_eq!(names(&plan(&cp, &declared, &RestoreIntents::default(), false, &facts).projects[0]), ["G"]);
    }

    #[test]
    fn the_boot_identity_is_read_on_this_host() {
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            let id = boot_id().expect("linux and macOS expose a boot identity");
            assert_eq!(id, id.trim());
            assert_eq!(boot_id().as_deref(), Some(id.as_str()), "stable within one boot");
        }
    }
}
