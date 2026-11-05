//! Managed-agent identity: the ONE definition of an agent this app created (its isolated home and recipe), who spawned it, which team it belongs to, and removing it.
//!
//! One family of `projects` (board #152): moved whole from mod.rs, which stays
//! the facade — every `projects::X` path is a re-export of this file.

use super::*;

/// Remove ONE agent from a project: kill its window if it is running, drop its
/// slot so `up` never recreates it, and delete its isolated home so it stops
/// counting as "an agent this app created". Stop is the pause button; this is
/// the eject button (owner: "stop 以外，也可以删除 Agent").
///
/// It removes whatever of those three the agent still has, and only refuses when
/// there is NOTHING of it left in this project. The narrower rule — a managed
/// home must exist — made two ordinary cases unremovable (owner report,
/// 2026-08-19: "停止的 agent，没办法 remove"):
///
/// * a STOPPED agent still holds a slot, and the roster offers it exactly
///   because starting it resumes its conversation; refusing to remove it left
///   the declaration as the only way to get rid of it;
/// * an agent whose home was deleted by hand (or that was never ours — a window
///   the user started, which the capturer adopts into a slot all the same) could
///   never be dropped, so `up` kept recreating a window nobody wanted.
///
/// The slot is what makes it a member of the project, so the slot is what
/// authorizes the removal. `home_removed` reports whether there was a home.
pub fn agent_remove(session: &str, agent: &str) -> Result<Value, String> {
    // Inside the one name-allocation boundary (board #20 review P1-R1): a
    // rename of this agent is either before the remove (its names deleted
    // here) or after it (refused, not an agent), never in between.
    spawn::with_allocation(|| agent_remove_now(session, agent))
}

fn agent_remove_now(session: &str, agent: &str) -> Result<Value, String> {
    // Before anything is looked up or killed: the name is about to be a
    // `remove_dir_all` target under `.tmm/agents/`, and `managed_home` would
    // answer "yes, a directory" for `..`.
    agents::valid_name(agent)?;
    let project = project_for_session(session)?
        .ok_or_else(|| format!("no project for session '{session}'"))?;
    let home = managed_home(session, agent);
    let declared = with_store(|store| store.slots(&project.id))?
        .iter()
        .any(|s| s.window_name == agent);
    // Kill the window first, or the capture loop would re-add the slot we are
    // about to delete from a window that is still alive.
    let mut window_killed = false;
    if let Ok(panes) = crate::tmux::list_panes(session) {
        if let Some(p) = panes.iter().find(|p| p.window_name == agent) {
            if home.is_some() || declared {
                // A window that will not die keeps the agent alive and the
                // capture loop re-adopting it; removing the slot and home
                // anyway would leave a running agent that is no longer ours.
                crate::tmux::kill_window(&format!("{session}:{}", p.window))
                    .map_err(|e| format!("'{agent}' was not removed — its window did not close: {e}"))?;
                window_killed = true;
            }
        }
    }
    if home.is_none() && !declared && !window_killed {
        return Err(format!("'{agent}' is not an agent of project '{}'", project.name));
    }
    // A process outside the window that still holds the home would write it
    // back after the delete (board #26: omp's text-predict worker, 5 min
    // later), so it is stopped first; one that will not exit refuses.
    if let Some(h) = &home {
        stop_home_workers(h).map_err(|e| format!("'{agent}' was not removed — {e}"))?;
    }
    let slot_removed = with_store(|store| store.delete_slot(&project.id, agent))?;
    // A removed agent has no Stop left to honour (board #422).
    with_store(|store| store.forget_slot_stopped(&project.id, agent))?;
    // The identity is gone for good: so are its accepted person-needed paints
    // (board #362 c). A stop or a restart keeps them; only a remove forgets.
    with_store(|store| store.forget_person_paints(session, agent))?;
    // The v3 workspace entry (a symlink into the home, board #207) goes with it.
    crate::backends::kiro::remove_workspace_entry(std::path::Path::new(&project.path), agent);
    let home_removed = home.is_some_and(|h| std::fs::remove_dir_all(h).is_ok());
    Ok(json!({
        "session": session,
        "agent": agent,
        "slot_removed": slot_removed,
        "home_removed": home_removed,
    }))
}

/// Stop every process that holds `home` through a backend's
/// `home_worker_env` (board #26), and return once each has EXITED: SIGTERM,
/// up to 3 s, then SIGKILL, up to 1 s more. The environment only FINDS a
/// worker; from then on it is tracked by its identity, pid plus start time
/// (review P1-R1). Exit is only what `observe` CONFIRMS (`Seen::Gone`): a
/// worker that cannot be observed (`Seen::Unknown`) is kept through the
/// wait and then refuses, like one still alive; so does a process list that
/// cannot be read (review round 2: a failed read is not empty data).
/// Residuals: the pid may be reused between the last identity read and
/// `kill()` (checking first narrows that window, it does not close it); and
/// a worker whose environment is unreadable (non-dumpable) is not found
/// (`process_env`).
/// Linux only; elsewhere nothing is stopped.
fn stop_home_workers(home: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let keys: Vec<&str> = crate::backends::Backend::ALL.iter().filter_map(|b| b.home_worker_env()).collect();
        let mut wanted: Vec<String> = Vec::new();
        for path in [Some(home.to_path_buf()), std::fs::canonicalize(home).ok()].into_iter().flatten() {
            for k in &keys {
                wanted.push(format!("{k}={}", path.to_string_lossy()));
            }
        }
        let me = std::process::id() as libc::pid_t;
        let mut workers: Vec<(libc::pid_t, u64)> = Vec::new();
        for pid in all_pids().map_err(|e| format!("its home's processes could not be listed ({e})"))? {
            if pid <= 1 || pid == me {
                continue;
            }
            // Identity before and after the environment read: the match is
            // this instance's, not a pid reused in between.
            let before = observe(pid);
            if before == Seen::Gone {
                continue;
            }
            let Some(env) = process_env(pid).map_err(|e| format!("process {pid}'s environment could not be read ({e})"))? else { continue };
            if !env.iter().any(|kv| wanted.iter().any(|w| w.as_bytes() == kv.as_slice())) {
                continue;
            }
            match (before, observe(pid)) {
                (_, Seen::Gone) => continue,
                (Seen::Alive(a), Seen::Alive(b)) if a == b => workers.push((pid, a)),
                (_, Seen::Unknown(e)) | (Seen::Unknown(e), _) => return Err(format!("process {pid} holds its home and cannot be observed ({e})")),
                _ => return Err(format!("process {pid} holds its home and changed identity while it was read")),
            }
        }
        if workers.is_empty() {
            return Ok(());
        }
        let signal = |left: &[(libc::pid_t, u64)], sig: libc::c_int| {
            for &(pid, start) in left {
                if observe(pid) == Seen::Alive(start) {
                    // SAFETY: a plain syscall on a positive pid whose start
                    // time was just re-read as the worker's.
                    unsafe { libc::kill(pid, sig) };
                }
            }
        };
        // What is still not confirmed gone, with the reason when unobservable.
        let wait = |left: Vec<(libc::pid_t, u64)>, for_ms: u64| {
            let until = std::time::Instant::now() + std::time::Duration::from_millis(for_ms);
            loop {
                let still: Vec<(libc::pid_t, u64, Option<String>)> = left
                    .iter()
                    .filter_map(|&(pid, start)| match observe(pid) {
                        Seen::Alive(s) if s == start => Some((pid, start, None)),
                        Seen::Unknown(e) => Some((pid, start, Some(e))),
                        Seen::Alive(_) | Seen::Gone => None,
                    })
                    .collect();
                if still.is_empty() || std::time::Instant::now() >= until {
                    return still;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        signal(&workers, libc::SIGTERM);
        let left: Vec<(libc::pid_t, u64)> = wait(workers, 3000).into_iter().map(|(p, s, _)| (p, s)).collect();
        signal(&left, libc::SIGKILL);
        let left = wait(left, 1000);
        if !left.is_empty() {
            let why: Vec<String> = left
                .iter()
                .map(|(pid, _, e)| match e {
                    Some(e) => format!("{pid}: cannot be observed ({e})"),
                    None => format!("{pid}: still running"),
                })
                .collect();
            return Err(format!("a process holding its home is not known to have exited ({})", why.join("; ")));
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = home;
    Ok(())
}

/// What one look at a process shows (board #26 round 2): alive with its
/// start time; CONFIRMED gone (the pid does not exist, it is a zombie that
/// can write nothing more, or the read says so); or unknown, which is never
/// taken for gone.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
enum Seen {
    Alive(u64),
    Gone,
    Unknown(String),
}

/// One look at `pid` through `/proc/<pid>/stat`.
#[cfg(target_os = "linux")]
fn observe(pid: libc::pid_t) -> Seen {
    #[cfg(test)]
    if let Some(e) = fault::observe(pid) {
        return Seen::Unknown(e);
    }
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => parse_stat(&stat),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ESRCH) => Seen::Gone,
        Err(e) => Seen::Unknown(e.to_string()),
    }
}

/// `/proc/<pid>/stat`: the command name may hold spaces and parentheses, so
/// fields resume after the LAST ')'. Field 3 is the state, field 22 the
/// start time (clock ticks since boot). Anything unreadable is Unknown.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_stat(stat: &str) -> Seen {
    let Some((_, rest)) = stat.rsplit_once(')') else { return Seen::Unknown("no ')' in stat".into()) };
    let fields: Vec<&str> = rest.split_whitespace().collect();
    match fields.first() {
        Some(&"Z") | Some(&"X") => return Seen::Gone,
        None => return Seen::Unknown("no state in stat".into()),
        _ => {}
    }
    match fields.get(19).and_then(|f| f.parse().ok()) {
        Some(start) => Seen::Alive(start),
        None => Seen::Unknown("no start time in stat".into()),
    }
}

/// Every pid on the host, or why the list could not be read.
#[cfg(target_os = "linux")]
fn all_pids() -> Result<Vec<libc::pid_t>, String> {
    #[cfg(test)]
    if let Some(e) = fault::enumerate() {
        return Err(e);
    }
    let dir = std::fs::read_dir("/proc").map_err(|e| format!("/proc: {e}"))?;
    let mut pids = Vec::new();
    for entry in dir {
        let entry = entry.map_err(|e| format!("/proc: {e}"))?;
        if let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse().ok()) {
            pids.push(pid);
        }
    }
    Ok(pids)
}

/// One process's environment as `K=V` byte strings. `Ok(None)` when it has
/// exited, or when its environment is unreadable (`EACCES`/`EPERM`). That is
/// another user's process, OR one of ours that is non-dumpable (measured by
/// validator-2 on #26: ssh-agent reads that way), so it is skipped, not
/// proven foreign. Refusing on it would block every remove while such a
/// process runs. Residual: a worker that hid its environment before
/// discovery is not found; omp's text-predict worker (18.15.0, 18.16.0)
/// is readable. Any other failure is an `Err`, never "holds nothing".
#[cfg(target_os = "linux")]
fn process_env(pid: libc::pid_t) -> Result<Option<Vec<Vec<u8>>>, String> {
    match std::fs::read(format!("/proc/{pid}/environ")) {
        Ok(raw) => Ok(Some(raw.split(|b| *b == 0).filter(|kv| !kv.is_empty()).map(<[u8]>::to_vec).collect())),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied) => Ok(None),
        Err(e) if matches!(e.raw_os_error(), Some(libc::ESRCH) | Some(libc::EPERM) | Some(libc::EACCES)) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Test-only faults at the observation boundary (board #26 round 2): a pid
/// whose look answers Unknown, or a process list that cannot be read.
#[cfg(test)]
pub(super) mod fault {
    use std::cell::RefCell;
    thread_local! {
        static OBSERVE: RefCell<Option<(libc::pid_t, u32, String)>> = const { RefCell::new(None) };
        static ENUMERATE: RefCell<Option<String>> = const { RefCell::new(None) };
    }
    /// `pid`'s looks answer as the OS does `good` more times, then Unknown.
    pub fn set_observe(pid: libc::pid_t, good: u32, why: &str) { OBSERVE.with(|o| *o.borrow_mut() = Some((pid, good, why.into()))); }
    pub fn set_enumerate(why: &str) { ENUMERATE.with(|o| *o.borrow_mut() = Some(why.into())); }
    pub fn clear() { OBSERVE.with(|o| *o.borrow_mut() = None); ENUMERATE.with(|o| *o.borrow_mut() = None); }
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(super) fn observe(pid: libc::pid_t) -> Option<String> {
        OBSERVE.with(|o| match o.borrow_mut().as_mut() {
            Some((p, good, why)) if *p == pid => {
                if *good == 0 {
                    return Some(why.clone());
                }
                *good -= 1;
                None
            }
            _ => None,
        })
    }
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub(super) fn enumerate() -> Option<String> { ENUMERATE.with(|o| o.borrow().clone()) }
}

/// The team a managed window was spawned as part of, read off its launch
/// recipe — `None` for a solo agent or a pre-recipe home. The Hub groups
/// same-team cards on this.
pub fn team_of(workspace: Option<&str>, window_name: &str) -> Option<String> {
    let t = recipe_field(workspace, window_name, "team");
    (!t.is_empty()).then_some(t)
}

/// The team member a window was spawned as (`launch.json` `member`, board
/// #113); '' for a solo agent or a pre-#113 recipe.
pub fn member_of(workspace: Option<&str>, window_name: &str) -> String {
    recipe_field(workspace, window_name, "member")
}

/// The team a window JOINED at runtime (board #382): a team in its recipe and
/// no member, so the team's definition does not list it. `None` for a
/// member the definition placed, and for a solo agent. The ONE reading of a
/// join: `hub_agents.joined`, and the restart that keeps a joiner in its team.
/// (A pre-#113 member also named no member; it reads as joined, which is how
/// a team restart already treated it.)
pub fn joined_team(workspace: Option<&str>, window_name: &str) -> Option<String> {
    team_of(workspace, window_name).filter(|_| member_of(workspace, window_name).is_empty())
}

fn recipe_field(workspace: Option<&str>, window_name: &str, key: &str) -> String {
    let Some(recipe) = workspace.and_then(|w| agents::home_dir(w, window_name)).map(|h| h.join("launch.json")) else { return String::new() };
    std::fs::read_to_string(recipe)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.get(key).and_then(|x| x.as_str()).map(|s| s.trim().to_string()))
        .unwrap_or_default()
}

/// The isolated home of a MANAGED agent, or `None` when this window is not one.
///
/// This is THE definition of "an agent this app created", and it has to be one
/// function because three unrelated places gate on it and they must not drift:
/// `hub_agents` (who is a chat participant), `maybe_auto_post` (whose replies
/// get posted to the room) and `deliver_mentions` (whose pane we are allowed to
/// type into). The marker is the directory `spawn` materialized — a window the
/// user started by hand can share a name with a registry agent, but it has no
/// isolated home, and typing into it or publishing its replies would reach into
/// a session this app does not own.
///
/// The name goes through `agents::home_dir`, so a window called `..` (or any
/// other name that is not a plain word — see `agents::valid_name`) is never
/// managed: `<ws>/.tmm/agents/../..` IS a directory — the workspace — and this
/// function's answer is what authorises `agent_remove` to `remove_dir_all` it.
pub fn managed_home(session: &str, window_name: &str) -> Option<std::path::PathBuf> {
    let project = project_for_session(session).ok().flatten()?;
    let dir = agents::home_dir(&project.path, window_name)?;
    home_is_managed(&dir, window_name).then_some(dir)
}

/// Close what older builds left readable by other users (board #448 D3),
/// once per server start, for the copies no other path revisits: the legacy
/// team.db (never reopened after its import) and every managed home of every
/// stored project, a LIVE one included (`reconcile::create_or_keep` keeps a
/// running pane without `refresh_hooks`). Each home is walked by
/// `safe_fs::private_home` (ours, no link followed; `agents` and the home
/// 0700). A failure is logged as "NOT tightened — needs the owner", and the
/// exposure is not called closed. Running processes keep their argv until
/// they are restarted; this does not replace rotating an exposed key.
#[cfg(unix)]
pub fn tighten_existing() {
    let warn = |what: &str, why: &str| eprintln!("⚠  privacy: NOT tightened — needs the owner: {what} ({why})");
    super::rooms::tighten_legacy_db();
    let projects = match with_store(|s| s.list_projects(true)) {
        Ok(p) => p,
        Err(e) => return warn("the managed homes of every project", &format!("the project list cannot be read: {e}")),
    };
    for p in projects {
        let tmm = std::path::Path::new(&p.path).join(".tmm");
        // The workspace's own MCP file holds the definitions' values too (P1-C).
        if let Err(e) = super::spawn::tighten_owned(&tmm.join("mcp.json")) {
            warn(&tmm.join("mcp.json").display().to_string(), &e);
        }
        let agents = tmm.join("agents");
        let entries = match std::fs::read_dir(&agents) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => { warn(&agents.display().to_string(), &format!("cannot be listed: {e}")); continue; }
        };
        for e in entries {
            let e = match e {
                Ok(e) => e,
                Err(err) => { warn(&agents.display().to_string(), &format!("an entry cannot be read: {err}")); continue; }
            };
            let dir = e.path();
            let Some(name) = e.file_name().to_str().map(str::to_string) else {
                warn(&dir.display().to_string(), "the name is not UTF-8");
                continue;
            };
            match managed_state(&p.path, &name) {
                ManagedState::Managed => {}
                ManagedState::Plain => continue,
                ManagedState::Unknown(why) => { warn(&dir.display().to_string(), &format!("cannot tell whether it is a managed home: {why}")); continue; }
            }
            if let Err(err) = crate::safe_fs::private_home(&dir) {
                warn(&dir.display().to_string(), &err.to_string());
            }
        }
    }
}

/// Same question, when the caller already knows the workspace path (it is
/// listing every window of one session and must not hit the store per row).
pub fn is_managed_in(workspace: Option<&str>, window_name: &str) -> bool {
    workspace
        .and_then(|ws| agents::home_dir(ws, window_name))
        .is_some_and(|dir| home_is_managed(&dir, window_name))
}

/// The marker itself (board #112): the home is managed iff it carries what
/// SPAWN wrote — `launch.json` (every backend, written before the window
/// exists), or the pre-recipe kiro `agents/<name>.json` (refresh_hooks only
/// backfills the recipe at the next start, and a continuously-running old
/// agent must not be demoted meanwhile; no CLI ever re-creates either file).
/// The directory alone stopped being the marker on 2026-09-09: `agent_remove`
/// deletes the home while the kiro process keeps running with its KIRO_HOME
/// env, and its next write re-created the subtree (`settings/`, `sessions/`) —
/// the gate said "managed" again for a window the user had removed, so
/// stop-hook auto-post and `@all` delivery resumed for it (observed
/// 2026-08-19).
pub(super) fn home_is_managed(dir: &std::path::Path, window_name: &str) -> bool {
    // Fail-open by design for the readers (an unreadable marker reads as
    // "not managed", as `is_file` always did); a destructive door asks
    // `managed_state` instead.
    matches!(marker_state(dir, window_name), ManagedState::Managed)
}

/// Is `window` a managed agent of `workspace`, as a DESTRUCTIVE door must ask
/// it (board #422 review, F3 residual): `Managed` when a marker is there,
/// `Plain` when every marker is confirmed absent, `Unknown` when one could
/// not be read (permission, I/O) — never folded into "not managed". The same
/// markers as `home_is_managed`, which is this answer with Unknown read as no.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedState {
    Managed,
    Plain,
    Unknown(String),
}

pub fn managed_state(workspace: &str, window: &str) -> ManagedState {
    match agents::home_dir(workspace, window) {
        Some(dir) => marker_state(&dir, window),
        // A name that can never be a home is never managed.
        None => ManagedState::Plain,
    }
}

fn marker_state(dir: &std::path::Path, window_name: &str) -> ManagedState {
    let mut unknown = None;
    for marker in [dir.join("launch.json"), dir.join("agents").join(format!("{window_name}.json"))] {
        match std::fs::metadata(&marker) {
            Ok(m) if m.is_file() => return ManagedState::Managed,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.kind() == std::io::ErrorKind::NotADirectory => {}
            Err(e) => unknown = unknown.or(Some(format!("{}: {e}", marker.display()))),
        }
    }
    match unknown {
        Some(e) => ManagedState::Unknown(e),
        None => ManagedState::Plain,
    }
}

#[cfg(test)]
mod marker_tests {
    use super::*;

    /// The tri-state the close door reads: a marker is Managed, confirmed
    /// absence is Plain, an unreadable agents dir is Unknown — while the
    /// readers' bool keeps reading Unknown as "not managed".
    #[test]
    fn managed_state_tells_unreadable_from_absent() {
        use std::os::unix::fs::PermissionsExt;
        let ws = crate::config::test_scratch("tmm-mstate");
        let agents = ws.join(".tmm/agents");
        std::fs::create_dir_all(agents.join("dev")).unwrap();
        std::fs::write(agents.join("dev/launch.json"), "{}").unwrap();
        let path = ws.to_string_lossy().to_string();
        assert_eq!(managed_state(&path, "dev"), ManagedState::Managed);
        assert_eq!(managed_state(&path, "plain"), ManagedState::Plain, "no home: confirmed plain");
        assert_eq!(managed_state("/nonexistent-tmm-ws", "dev"), ManagedState::Plain);
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o000)).unwrap();
        let locked = managed_state(&path, "dev");
        let fail_open = is_managed_in(Some(&path), "dev");
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&ws);
        assert!(matches!(locked, ManagedState::Unknown(ref e) if e.contains("ermission")), "{locked:?}");
        assert!(!fail_open, "the readers' bool is unchanged: unknown reads as not managed");
    }
}

/// Who spawned this managed agent, read off its launch recipe. `None` means
/// the human did — or the recipe predates the field / the agent is not
/// managed — and in every one of those cases there is nobody to deliver a
/// done summary to, which is the only question this answers.
pub fn spawned_by(workspace: Option<&str>, window_name: &str) -> Option<String> {
    let recipe = agents::home_dir(workspace?, window_name)?.join("launch.json");
    let text = std::fs::read_to_string(recipe).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let by = v.get("spawned_by")?.as_str()?.trim().to_string();
    (!by.is_empty()).then_some(by)
}

/// Type ONE stamped chat line into ONE named agent's pane — the targeted
/// sibling of `deliver_mentions` (same gates: live window, managed, never a
/// shell; same `delivery::deliver` path, so a busy queue-mode agent gets it
/// combined at its turn's end (board #257), the agent's turn-start echo acks
/// it and the reply edge names the line's sender). Quiet on every miss:
/// a dead window or an unmanaged name simply has nobody to wake. Used by the
/// done-summary feedback edge, the board's review handoff, the `[reply]`
/// return and — since board #224 — a spawn whose backend takes its first
/// prompt TYPED (kimi): all DELIVERIES the server decides on, never mention
/// scans, so the record-only invariant of hook-sourced posts stays intact.
pub fn deliver_chat_line(session: &str, target_name: &str, line: &str) -> bool {
    deliver_chat_line_found(session, target_name, line).unwrap_or(false)
}

/// `deliver_chat_line`, keeping apart the two facts its `bool` merges (board
/// #507 review P1-D): `None` — no live managed pane was found for the name,
/// so nothing went to the delivery path; `Some(accepted)` — the line WAS
/// handed to the one delivery path, which typed or held it (`true`) or had
/// the pane refuse it (`false`, copy mode). A caller that reports what it
/// attempted reads the first fact, never the second as a delivery.
pub fn deliver_chat_line_found(session: &str, target_name: &str, line: &str) -> Option<bool> {
    // Any of the agent's names reaches it (board #20): the delivery row and
    // the pane lookup use the PHYSICAL window, which its echo will name.
    // The line names agents as the project shows them now (the one display):
    // its addresses, e.g. a team notice's `@dev moved …`, by current label.
    let names = super::names::names(session);
    let target_name = names.resolve(target_name);
    let line = &names.show_body(line);
    let target = crate::projects::delivery::agent_target(session, target_name)?;
    Some(crate::projects::delivery::deliver(session, target_name, &target, line, 0, ""))
}

/// Every agent this workspace DECLARES as managed, live or stopped, sorted
/// (board #507). The set `tmm board note --notify @all` expands to —
/// declaration, not liveness, so a stopped teammate is named and then
/// reported offline by the delivery path. No agents directory is an empty
/// list; one that cannot be listed is an error, because guessing the set
/// would announce to the wrong people.
///
/// Each directory passes the SAME identity entry every other reader uses
/// (`is_managed_in`: `agents::home_dir`'s `valid_name`, then the marker), so
/// an entry is an agent NAME before it is anything else (review P1-B: a
/// directory called `dev @all` carrying a marker would otherwise have been
/// expanded into two addresses, one of them a broadcast). A routing word
/// (`all`, `human`) is never an expansion result, whatever is on disk.
pub fn managed_names_in(workspace: &str) -> Result<Vec<String>, String> {
    let agents = std::path::Path::new(workspace).join(".tmm").join("agents");
    let entries = match std::fs::read_dir(&agents) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("the project's agents ({}) cannot be listed: {e}", agents.display())),
    };
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("the project's agents ({}) cannot be read: {e}", agents.display()))?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if !crate::address::is_routing_word(&name) && is_managed_in(Some(workspace), &name) {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::super::tests::use_test_store;
    use super::*;

    /// Board #507 review P1-B: `@all` expands over directories, so each one
    /// must be an agent NAME through the same identity entry every reader
    /// uses, and a routing word is never a result. Each sentinel carries the
    /// marker, so only the name check can keep it out.
    #[test]
    fn managed_names_in_names_only_valid_non_routing_managed_homes() {
        let ws = crate::config::test_scratch("tmm-managed-names");
        for name in ["dev", "lead", "dev @all", "all", "Human", "has.dot", "-dash", "plain"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            if name != "plain" {
                std::fs::write(home.join("launch.json"), "{}").unwrap();
            }
        }
        assert_eq!(managed_names_in(ws.to_str().unwrap()).unwrap(), vec!["dev".to_string(), "lead".to_string()]);
        let empty = crate::config::test_scratch("tmm-managed-names-none");
        assert_eq!(managed_names_in(empty.to_str().unwrap()).unwrap(), Vec::<String>::new(), "no agents directory is nobody");
    }

    /// Board #382: a join is a team in the recipe and no member; a member the
    /// definition placed, and a solo agent, are not joined.
    #[test]
    fn a_join_is_a_team_without_a_member() {
        let ws = crate::config::test_scratch("tmm-joined");
        for (name, recipe) in [("joiner", r#"{"team":"squad","member":""}"#), ("placed", r#"{"team":"squad","member":"dev"}"#), ("solo", r#"{"team":""}"#)] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), recipe).unwrap();
        }
        let w = ws.to_str();
        assert_eq!(joined_team(w, "joiner").as_deref(), Some("squad"));
        assert_eq!(joined_team(w, "placed"), None);
        assert_eq!(joined_team(w, "solo"), None);
        assert_eq!(joined_team(w, "nobody"), None);
        assert_eq!(team_of(w, "joiner").as_deref(), Some("squad"), "and it is in the team for everything that reads one");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn removing_an_agent_drops_its_slot_and_home() {
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rm");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();
        let made = create(&path, Some("rmtest"), None, None).unwrap();
        let id = made.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let session = made.get("session").and_then(|v| v.as_str()).unwrap().to_string();

        // A managed agent: a slot in the declaration plus the isolated home
        // that makes it "ours" — marked by the recipe spawn always writes
        // (board #112: the directory alone is not the marker).
        let home = dir.join(".tmm").join("agents").join("dev");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), "{}").unwrap();
        with_store(|store| {
            store.replace_slots(&id, &[store::Slot {
                id: None, ord: 0, window_name: "dev".into(), cwd: String::new(),
                kind: store::SlotKind::Agent, command: Some("kiro".into()),
                auto_run: true, agent_session_id: None,
                first_seen_at: now(), settled_at: Some(now()),
            }])
        })
        .unwrap();

        let r = agent_remove(&session, "dev").unwrap();
        assert_eq!(r.get("slot_removed").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(r.get("home_removed").and_then(|v| v.as_bool()), Some(true));
        assert!(!home.exists());
        // `up` must not bring it back: the slot is gone from the declaration.
        let slots = with_store(|store| store.slots(&id)).unwrap();
        assert!(!slots.iter().any(|s| s.window_name == "dev"), "slot is gone");
        // A name that was never ours is rejected rather than half-handled.
        assert!(agent_remove(&session, "nope").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #26 (measured on omp 18.15.0): omp's text-predict worker is a
    /// child of omp's global daemon broker, not of the pane. It holds
    /// `OMP_TEXT_PREDICT_AGENT_DIR=<home>`, survives the window kill, and
    /// persists `predict/ngram/` into the home up to 5 min after its last
    /// activity. The removed home came back and blocked the name. Here a
    /// stand-in worker, orphaned outside any window, writes 3 s later: after
    /// the remove and past that time, no home exists.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_removed_home_is_not_written_again_by_a_worker_outside_the_window() {
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rm-late");
        std::fs::create_dir_all(&dir).unwrap();
        let made = create(&dir.to_string_lossy(), Some("rmlate"), None, None).unwrap();
        let session = made["session"].as_str().unwrap().to_string();
        let home = dir.join(".tmm").join("agents").join("om");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), r#"{"backend":"omp"}"#).unwrap();
        // `( … ) &` inside a shell that exits at once: the writer is
        // re-parented away from this test, like the broker's worker.
        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(r#"(sleep 3; mkdir -p "$OMP_TEXT_PREDICT_AGENT_DIR/predict/ngram" && echo '{}' > "$OMP_TEXT_PREDICT_AGENT_DIR/predict/ngram/cursor.json") >/dev/null 2>&1 &"#)
            .env("OMP_TEXT_PREDICT_AGENT_DIR", &home)
            .status()
            .unwrap();
        assert!(status.success());
        std::thread::sleep(std::time::Duration::from_millis(200));

        let r = agent_remove(&session, "om").unwrap();
        assert_eq!(r["home_removed"].as_bool(), Some(true), "{r}");
        std::thread::sleep(std::time::Duration::from_millis(4000));
        assert!(!home.exists(), "the home came back: {:?}", std::fs::read_dir(&home).map(|d| d.flatten().map(|e| e.path()).collect::<Vec<_>>()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #26 review P1-R1: a worker is waited for until it EXITS, not
    /// until its environment stops matching. This stand-in, on SIGTERM,
    /// execs into a process with no environment (the same pid, alive, its
    /// `/proc/<pid>/environ` no longer naming the home) that writes into the
    /// home 1.5 s later and then exits. Re-scanning environments took the
    /// exec for an exit and deleted the home before the write.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_worker_is_waited_for_until_it_exits_not_until_its_environment_changes() {
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rm-exec");
        std::fs::create_dir_all(&dir).unwrap();
        let made = create(&dir.to_string_lossy(), Some("rmexec"), None, None).unwrap();
        let session = made["session"].as_str().unwrap().to_string();
        let home = dir.join(".tmm").join("agents").join("om");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), r#"{"backend":"omp"}"#).unwrap();
        let late = format!("sleep 1.5; mkdir -p '{}/predict'", home.display());
        let script = format!(r#"(trap 'exec env -i /bin/sh -c "{late}"' TERM; while :; do sleep 0.05; done) >/dev/null 2>&1 &"#);
        let status = std::process::Command::new("sh").arg("-c").arg(&script).env("OMP_TEXT_PREDICT_AGENT_DIR", &home).status().unwrap();
        assert!(status.success());
        std::thread::sleep(std::time::Duration::from_millis(300));

        let r = agent_remove(&session, "om").unwrap();
        assert_eq!(r["home_removed"].as_bool(), Some(true), "{r}");
        std::thread::sleep(std::time::Duration::from_millis(2500));
        assert!(!home.exists(), "the worker wrote after the remove: {:?}", std::fs::read_dir(&home).map(|d| d.flatten().map(|e| e.path()).collect::<Vec<_>>()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #26 review P1-R1: a process's identity is its pid plus its start
    /// time; a zombie has exited (it can write nothing more), and so has a
    /// reaped pid.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_process_identity_is_live_and_stable_and_a_zombie_has_none() {
        let me = std::process::id() as libc::pid_t;
        let Seen::Alive(start) = observe(me) else { panic!("this process is alive") };
        assert_eq!(observe(me), Seen::Alive(start), "the same instance reads the same start");
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(observe(pid), Seen::Gone, "exited, not yet reaped: a zombie writes nothing more");
        child.wait().unwrap();
        assert_eq!(observe(pid), Seen::Gone, "reaped: the pid does not exist");
    }

    /// Board #26 round 2: what a stat line says. A literal line of a process
    /// whose name holds spaces and parentheses; its state then start time.
    #[test]
    fn a_stat_line_is_alive_with_its_start_gone_as_a_zombie_and_otherwise_unknown() {
        let line = |state: &str| format!("4242 (omp (worker) x) {state} 1 4242 4242 0 -1 4194560 100 0 0 0 5 2 0 0 20 0 9 0 777123 1000 50");
        assert_eq!(parse_stat(&line("S")), Seen::Alive(777123));
        assert_eq!(parse_stat(&line("R")), Seen::Alive(777123));
        assert_eq!(parse_stat(&line("Z")), Seen::Gone, "a zombie writes nothing more");
        assert_eq!(parse_stat(&line("X")), Seen::Gone);
        assert!(matches!(parse_stat("4242 (omp) S 1 2 3"), Seen::Unknown(_)), "a short line is not an exit");
        assert!(matches!(parse_stat("garbage"), Seen::Unknown(_)), "an unparsable line is not an exit");
        assert!(matches!(parse_stat(&line("S").replace("777123", "x")), Seen::Unknown(_)));
    }

    /// Board #26 round 2 (reviewer, orchestrator 16:56): a worker found holding
    /// the home that then cannot be OBSERVED is not taken for exited. The
    /// remove waits out its bound and refuses with the reason, and the slot
    /// and the home are both kept. A process list that cannot be read refuses
    /// the same way. Both faults are injected at the observation boundary.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_worker_that_cannot_be_observed_or_a_list_that_cannot_be_read_refuses_the_remove() {
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rm-unknown");
        std::fs::create_dir_all(&dir).unwrap();
        let made = create(&dir.to_string_lossy(), Some("rmunknown"), None, None).unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        let session = made["session"].as_str().unwrap().to_string();
        let home = dir.join(".tmm").join("agents").join("om");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), r#"{"backend":"omp"}"#).unwrap();
        with_store(|store| {
            store.replace_slots(&id, &[store::Slot {
                id: None, ord: 0, window_name: "om".into(), cwd: String::new(),
                kind: store::SlotKind::Agent, command: Some("omp".into()),
                auto_run: true, agent_session_id: None,
                first_seen_at: now(), settled_at: Some(now()),
            }])
        })
        .unwrap();
        let declared = || with_store(|store| store.slots(&id)).unwrap().iter().any(|s| s.window_name == "om");

        fault::set_enumerate("injected: /proc unreadable");
        let err = agent_remove(&session, "om").unwrap_err();
        fault::clear();
        assert!(err.contains("not removed") && err.contains("could not be listed"), "{err}");
        assert!(declared() && home.join("launch.json").is_file(), "nothing was removed");

        let mut worker = std::process::Command::new("sleep").arg("30").env("OMP_TEXT_PREDICT_AGENT_DIR", &home).spawn().unwrap();
        let pid = worker.id() as libc::pid_t;
        std::thread::sleep(std::time::Duration::from_millis(200));
        // Unobservable while it is being found: refused at once.
        fault::set_observe(pid, 0, "injected: stat unreadable");
        let err = agent_remove(&session, "om").unwrap_err();
        fault::clear();
        assert!(err.contains("not removed") && err.contains(&pid.to_string()) && err.contains("cannot be observed"), "{err}");
        assert!(declared() && home.join("launch.json").is_file(), "nothing was removed");
        // Found alive (two good looks around the environment read), then
        // unobservable: never signalled, kept through the wait, then refused.
        fault::set_observe(pid, 2, "injected: stat unreadable");
        let t = std::time::Instant::now();
        let err = agent_remove(&session, "om").unwrap_err();
        fault::clear();
        assert!(t.elapsed() >= std::time::Duration::from_millis(3900), "it waited out the bound: {:?}", t.elapsed());
        assert!(err.contains("not removed") && err.contains(&format!("{pid}: cannot be observed")), "{err}");
        assert!(declared() && home.join("launch.json").is_file(), "the slot and the home are kept");
        assert!(worker.try_wait().unwrap().is_none(), "never signalled: no fresh Alive to signal");
        worker.kill().unwrap();
        worker.wait().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #362 c, the cleanup of accepted person-needed paints (the
    /// orchestrator's ruling on accepted-once, with the reviewer's boundary):
    /// they are forgotten ONLY when the identity is explicitly removed. A
    /// restart of the gateway, a `retain_windows` pass with the window
    /// briefly missing, or a stop or restart of the agent keep them; a remove
    /// forgets that agent's alone, not another agent's whose name starts with
    /// the same letters; a session rename carries them; deleting the project
    /// forgets the rest.
    #[test]
    fn accepted_paints_are_forgotten_only_when_their_identity_is_removed() {
        use crate::projects::telemetry as tm;
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rmpaint");
        std::fs::create_dir_all(&dir).unwrap();
        let made = create(&dir.to_string_lossy(), Some("rmpaint"), None, None).unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        let session = made["session"].as_str().unwrap().to_string();
        for name in ["dev", "dev-2"] {
            let home = dir.join(".tmm").join("agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), "{}").unwrap();
        }
        let sig = "auth_expired|23a04597-c6d8-4439-954f-2216f9c7d687";
        let set = |s: &str, w: &str| with_store(|st| st.meta_set(&store::person_paint_key(s, w, sig), "42")).unwrap();
        let has = |s: &str, w: &str| tm::accepted_paint(s, w, sig).unwrap() == Some(42);
        set(&session, "dev");
        set(&session, "dev-2");
        // A gateway restart, a window briefly missing from tmux, a stop or a
        // restart of the agent: none of them is a remove.
        tm::forget_process_state(&session);
        tm::retain_windows(&session, &[]);
        recovery_retain(&session);
        assert!(has(&session, "dev") && has(&session, "dev-2"), "kept through restart, absence and stop");
        // The remove forgets dev's, never dev-2's.
        agent_remove(&session, "dev").unwrap();
        assert!(!has(&session, "dev"), "removed: forgotten");
        assert!(has(&session, "dev-2"), "another agent's is kept");
        // A rename carries the rest; a project delete forgets them.
        let renamed = format!("{session}-r");
        with_store(|st| st.set_session(&id, &renamed, &session)).unwrap();
        assert!(!has(&session, "dev-2") && has(&renamed, "dev-2"), "moved with the session");
        with_store(|st| st.delete_project(&id)).unwrap();
        assert!(!has(&renamed, "dev-2"), "the project's identities are gone");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The recovery tracker's own housekeeping for a window set (a window
    /// gone from one listing), as the capture tick runs it.
    fn recovery_retain(session: &str) {
        crate::projects::recovery::retain_windows_for_test(session, &[]);
    }

    /// `agent_remove("../..")` used to resolve `<ws>/.tmm/agents/../..` — the
    /// workspace itself, which `is_dir()` — and hand it to `remove_dir_all`.
    /// The name rule (`agents::valid_name`) refuses before any lookup, and the
    /// two "is it managed" gates answer no for the same names.
    #[test]
    fn a_name_that_is_a_path_removes_nothing() {
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rmpath");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();
        let made = create(&path, Some("rmpath"), None, None).unwrap();
        let session = made["session"].as_str().unwrap().to_string();
        std::fs::write(dir.join("user-file.txt"), "precious").unwrap();
        let home = dir.join(".tmm").join("agents").join("dev");
        std::fs::create_dir_all(&home).unwrap();

        for bad in ["../..", "..", ".", "dev/../..", "a b", "-dev", "dev.json"] {
            let err = agent_remove(&session, bad).unwrap_err();
            assert!(err.contains("agent name"), "{bad:?} is refused by the name rule, got: {err}");
            assert!(managed_home(&session, bad).is_none(), "{bad:?} is never a managed home");
            assert!(!is_managed_in(Some(&path), bad), "{bad:?} is never managed");
        }
        assert!(dir.join("user-file.txt").exists(), "the workspace survived");
        assert!(home.exists(), "the real agent's home survived");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A STOPPED agent is the ordinary case: no window, no reason its home has
    /// to be intact, but a slot that keeps `up` recreating it. Requiring a
    /// managed home made those unremovable (owner, 2026-08-19).
    #[test]
    fn a_stopped_agent_can_be_removed_by_its_declaration_alone() {
        use_test_store();
        let dir = crate::config::test_scratch("tmm-rmstop");
        std::fs::create_dir_all(&dir).unwrap();
        let made = create(&dir.to_string_lossy(), Some("rmstop"), None, None).unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        let session = made["session"].as_str().unwrap().to_string();
        let slot = |name: &str| store::Slot {
            id: None, ord: 0, window_name: name.into(), cwd: String::new(),
            kind: store::SlotKind::Agent, command: Some("kiro".into()),
            auto_run: true, agent_session_id: None,
            first_seen_at: now(), settled_at: Some(now()),
        };
        // Declared, never started (or started and stopped): no home on disk.
        with_store(|store| store.replace_slots(&id, &[slot("ghost")])).unwrap();
        assert!(managed_home(&session, "ghost").is_none(), "no home — that is the point");
        // Its Stop (board #422) goes with it: nothing is left to suppress.
        with_store(|store| store.set_slot_stopped(&id, "ghost")).unwrap();

        let r = agent_remove(&session, "ghost").unwrap();
        assert_eq!(r["slot_removed"].as_bool(), Some(true), "the declaration is what we can remove");
        assert_eq!(r["home_removed"].as_bool(), Some(false), "there was nothing to delete");
        let slots = with_store(|store| store.slots(&id)).unwrap();
        assert!(slots.is_empty(), "`up` cannot bring it back");
        assert!(!with_store(|store| store.restore_intents()).unwrap().stopped.contains(&(id.clone(), "ghost".to_string())), "remove forgets the Stop");
        // Nothing left of it anywhere: now it IS an unknown name.
        assert!(agent_remove(&session, "ghost").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The one definition of "an agent this app created". Three gates share it
    /// (chat participants, stop-hook auto-post, pane delivery), so it is worth
    /// a test of its own: the marker is the isolated home `spawn` materialized,
    /// NOT the window name — a hand-started window may share the name.
    #[test]
    fn managed_is_the_recipe_not_the_directory() {
        let ws = crate::config::test_scratch("tmm-managed");
        let path = ws.to_string_lossy().to_string();
        // spawn writes launch.json for every backend before the window exists —
        // THAT is the marker, not the directory.
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        assert!(is_managed_in(Some(&path), "dev"), "spawn materialized this one");
        assert!(!is_managed_in(Some(&path), "byhand"), "same session, no isolated home");
        assert!(!is_managed_in(None, "dev"), "a session with no project owns nothing");
        // The board #112 re-arm: agent_remove deleted the home, but the still-
        // running kiro process re-creates its KIRO_HOME subtree (settings/,
        // sessions/) on its next write. A directory without a recipe is a
        // GHOST, never a managed agent (observed 2026-08-19).
        std::fs::create_dir_all(ws.join(".tmm/agents/removed/settings")).unwrap();
        std::fs::write(ws.join(".tmm/agents/removed/settings/cli.json"), "{}").unwrap();
        assert!(
            !is_managed_in(Some(&path), "removed"),
            "a CLI-recreated subtree must not re-arm the gate"
        );
        // Pre-recipe kiro homes (spawned before launch.json existed) keep their
        // agents/<name>.json config; refresh_hooks only backfills the recipe at
        // the NEXT start, so a continuously-running old agent must not be
        // demoted meanwhile.
        std::fs::create_dir_all(ws.join(".tmm/agents/old/agents")).unwrap();
        std::fs::write(ws.join(".tmm/agents/old/agents/old.json"), "{}").unwrap();
        assert!(is_managed_in(Some(&path), "old"), "pre-recipe kiro home stays managed");
        // A file where the directory should be is not a home either.
        std::fs::write(ws.join(".tmm/agents/file"), "x").unwrap();
        assert!(!is_managed_in(Some(&path), "file"));
        let _ = std::fs::remove_dir_all(&ws);
    }
}

#[cfg(all(test, unix))]
mod tighten_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Board #448 D3: a LIVE home an older build left 0755 (the pane runs, so
    /// `create_or_keep` never calls `refresh_hooks`) is closed by the startup
    /// step without a respawn; a directory under `.tmm/agents/` that is not a
    /// managed home is left as it is.
    #[test]
    fn a_wide_home_is_closed_at_startup_without_a_respawn_and_a_plain_dir_is_not() {
        super::super::tests::use_test_store();
        let ws = crate::config::test_scratch("tmm-tighten");
        let (home, plain) = (ws.join(".tmm/agents/dev"), ws.join(".tmm/agents/notes"));
        for d in [&home, &plain] { std::fs::create_dir_all(d).unwrap(); }
        std::fs::write(home.join("launch.json"), r#"{"backend":"codex"}"#).unwrap();
        std::fs::write(ws.join(".tmm/mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        std::fs::set_permissions(ws.join(".tmm/mcp.json"), std::fs::Permissions::from_mode(0o644)).unwrap();
        for d in [ws.join(".tmm/agents"), home.clone(), plain.clone()] {
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let id = format!("tighten-{}", uuid::Uuid::new_v4());
        with_store(|s| s.insert_project(&Project {
            id: id.clone(), name: id.clone(), path: ws.to_string_lossy().into(), icon: None,
            session: id.clone(), adopted: false, autostart: false, created_at: 1,
            last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        })).unwrap();
        tighten_existing();
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!((mode(&ws.join(".tmm/agents")), mode(&home)), (0o700, 0o700), "the managed home and its parent close");
        assert_eq!(mode(&plain), 0o755, "a directory that is not a managed home is not ours to change");
        assert_eq!(mode(&ws.join(".tmm/mcp.json")), 0o600, "the workspace's own MCP file closes too");
        with_store(|s| s.delete_project(&id)).ok();
        std::fs::remove_dir_all(&ws).ok();
    }
}
