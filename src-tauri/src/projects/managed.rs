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
        let ws = std::env::temp_dir().join(format!("tmm-mstate-{}", uuid::Uuid::new_v4()));
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
    match crate::projects::delivery::agent_target(session, target_name) {
        Some(target) => crate::projects::delivery::deliver(session, target_name, &target, line, 0, ""),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::use_test_store;
    use super::*;

    /// Board #382: a join is a team in the recipe and no member; a member the
    /// definition placed, and a solo agent, are not joined.
    #[test]
    fn a_join_is_a_team_without_a_member() {
        let ws = std::env::temp_dir().join(format!("tmm-joined-{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("tmm-rm-{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("tmm-rmpaint-{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("tmm-rmpath-{}", uuid::Uuid::new_v4()));
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
        let dir = std::env::temp_dir().join(format!("tmm-rmstop-{}", uuid::Uuid::new_v4()));
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
        let ws = std::env::temp_dir().join(format!("tmm-managed-{}", uuid::Uuid::new_v4()));
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
