//! tmux → declaration. The reverse direction of `reconcile`.
//!
//! Nobody hand-writes a project: we watch the sessions we already know about
//! and fold what we see back into the declaration, which is therefore always
//! the LAST OBSERVED state — that is what makes "close it and reopen it later"
//! and "survive a reboot" work, with no history to keep.
//!
//! One rule keeps the declaration honest (exec plan §3): a window must survive
//! `SETTLE_SECS` before it is worth restoring, so the window you opened to grep
//! something and closed again does not come back on every future `up`. A window
//! that disappears simply leaves the declaration.

use super::agents;
use super::{agent_sessions, auto_adopt_once, is_managed_in, now, recovery, restore, seed_builtin_skills, store, with_store};
use std::time::Duration;
use super::store::{Slot, SlotKind};
use crate::tmux::{self, TmuxPane};

/// How long a window must exist before it enters the declaration.
pub const SETTLE_SECS: u64 = 120;

/// What a live window looks like right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    /// tmux window index, used to ask the notification hub which conversation
    /// this window's agent is in.
    pub window: usize,
    pub window_name: String,
    /// Relative to the project path; empty means the project root.
    pub cwd: String,
    pub kind: SlotKind,
    pub command: Option<String>,
    /// The agent's own conversation id, when a hook has reported one.
    pub agent_session_id: Option<String>,
}

/// Where the agent conversation ids come from. Implemented by
/// `AgentNotificationHub` (the hooks already carry `session_id`); the tests
/// pass a stub. A trait keeps `projects` from naming the notification types.
pub trait AgentSessions {
    fn agent_session_for(&self, session: &str, window: &str) -> Option<String>;
}

/// No hub available (tests, or a capture that does not care).
pub struct NoSessions;
impl AgentSessions for NoSessions {
    fn agent_session_for(&self, _session: &str, _window: &str) -> Option<String> {
        None
    }
}

/// Result of folding observation into the declaration.
pub struct Merge {
    pub slots: Vec<Slot>,
    /// Something changed, so the declaration must be written back.
    pub dirty: bool,
}

/// Read the live windows of `session` as project-relative observations.
///
/// One entry per window, taken from its ACTIVE pane: a window is a workspace
/// slot, and the active pane is what the user considers "that window".
pub fn observe(session: &str, project_path: &str, sessions: &dyn AgentSessions) -> Result<Vec<Observed>, String> {
    let panes = tmux::list_panes(session)?;
    let mut out: Vec<(usize, Observed)> = Vec::new();
    for pane in &panes {
        if !pane.active && panes.iter().any(|p| p.window == pane.window && p.active) {
            continue;
        }
        if out.iter().any(|(w, _)| *w == pane.window) {
            continue;
        }
        let mut observed = observed_from(pane, project_path);
        if observed.kind == SlotKind::Agent {
            observed.agent_session_id = sessions.agent_session_for(session, &pane.window_name);
        }
        out.push((pane.window, observed));
    }
    out.sort_by_key(|(w, _)| *w);
    Ok(out.into_iter().map(|(_, o)| o).collect())
}

fn observed_from(pane: &TmuxPane, project_path: &str) -> Observed {
    // The same question the roster, delivery, vitals and recovery ask, by the
    // same clues in the same order — so the declaration never disagrees with
    // them about which windows are agents.
    match agents::detect_pane(Some(project_path), pane) {
        Some(agent) => Observed {
            window: pane.window,
            window_name: pane.window_name.clone(),
            cwd: relative_cwd(&pane.current_path, project_path),
            kind: SlotKind::Agent,
            command: Some(agent.backend.to_string()),
            agent_session_id: None,
        },
        None => Observed {
            window: pane.window,
            window_name: pane.window_name.clone(),
            cwd: relative_cwd(&pane.current_path, project_path),
            kind: SlotKind::Shell,
            // Observed only — never replayed by `up` (decision 5).
            command: (!pane.child_cmd.is_empty()).then(|| pane.child_cmd.clone()),
            agent_session_id: None,
        },
    }
}

/// `cwd` expressed relative to the project path, so moving the workspace keeps
/// the declaration valid. Paths outside the project stay absolute.
pub fn relative_cwd(cwd: &str, project_path: &str) -> String {
    if cwd.is_empty() || cwd == project_path {
        return String::new();
    }
    let prefix = format!("{}/", project_path.trim_end_matches('/'));
    match cwd.strip_prefix(&prefix) {
        Some(rest) => rest.to_string(),
        None => cwd.to_string(),
    }
}

/// Fold `observed` into `existing`, applying the settle and removal rules.
///
/// Pure on purpose: every rule that decides what gets remembered is testable
/// without a tmux server.
pub fn merge(existing: &[Slot], observed: &[Observed], now: u64, settle_secs: u64) -> Merge {
    merge_preserving(existing, observed, now, settle_secs, &std::collections::HashSet::new())
}

/// Fold while retaining named slots that deliberately outlive their window.
/// The production caller supplies managed-agent names (their isolated homes
/// are durable membership); ordinary shells and hand-started agents still
/// obey the disappearance rule.
pub fn merge_preserving(
    existing: &[Slot],
    observed: &[Observed],
    now: u64,
    settle_secs: u64,
    keep_missing: &std::collections::HashSet<String>,
) -> Merge {
    let mut slots = Vec::with_capacity(observed.len() + keep_missing.len());
    let mut dirty = false;

    // A window's identity in the declaration IS its name (`up` matches by
    // name), so two live windows with the same name are indistinguishable —
    // and writing both would violate UNIQUE(project_id, window_name). Keep the
    // first observation of each name; the projection honestly recreates ONE
    // window of that name.
    let mut seen_names = std::collections::HashSet::new();
    let observed: Vec<&Observed> = observed
        .iter()
        .filter(|o| seen_names.insert(o.window_name.clone()))
        .collect();

    for (ord, obs) in observed.iter().enumerate() {
        let ord = ord as i64;
        match existing.iter().find(|s| s.window_name == obs.window_name) {
            Some(prev) => {
                // Sticky: a hook only reports the conversation id now and then,
                // so an observation without one must not erase what we know.
                let agent_session_id = obs
                    .agent_session_id
                    .clone()
                    .or_else(|| prev.agent_session_id.clone())
                    .filter(|_| obs.kind == SlotKind::Agent);
                let changed = prev.ord != ord
                    || prev.cwd != obs.cwd
                    || prev.kind != obs.kind
                    || prev.command != obs.command
                    || prev.agent_session_id != agent_session_id;
                let settles_now = prev.settled_at.is_none() && now - prev.first_seen_at >= settle_secs;
                if changed || settles_now {
                    dirty = true;
                }
                slots.push(Slot {
                    id: prev.id,
                    ord,
                    window_name: obs.window_name.clone(),
                    cwd: obs.cwd.clone(),
                    kind: obs.kind,
                    command: obs.command.clone(),
                    auto_run: obs.kind == SlotKind::Agent,
                    agent_session_id,
                    first_seen_at: prev.first_seen_at,
                    settled_at: prev.settled_at.or(settles_now.then_some(now)),
                });
            }
            None => {
                dirty = true;
                // A brand-new window is remembered so its age survives a server
                // restart, but it is not restorable until it settles.
                slots.push(Slot {
                    id: None,
                    ord,
                    window_name: obs.window_name.clone(),
                    cwd: obs.cwd.clone(),
                    kind: obs.kind,
                    command: obs.command.clone(),
                    auto_run: obs.kind == SlotKind::Agent,
                    agent_session_id: obs.agent_session_id.clone(),
                    first_seen_at: now,
                    settled_at: None,
                });
            }
        }
    }

    for prev in existing {
        if !observed.iter().any(|o| o.window_name == prev.window_name) {
            if keep_missing.contains(&prev.window_name) {
                let mut kept = prev.clone();
                let ord = slots.len() as i64;
                if kept.ord != ord {
                    kept.ord = ord;
                    dirty = true;
                }
                slots.push(kept);
            } else {
                // An ordinary window that is gone simply leaves the
                // declaration. Managed agents are the exception above: Stop
                // pauses them, and Remove explicitly drops slot + home.
                dirty = true;
            }
        }
    }

    Merge { slots, dirty }
}


// ---- the 20-second tick: auto-adopt, fold tmux back into the declarations, recovery scan (moved from projects/mod.rs, board #152) ----

/// How often the capturer folds live tmux state back into the declaration.
pub(super) const CAPTURE_INTERVAL: Duration = Duration::from_secs(20);

/// How long a tmux session must have existed before it becomes a project on its
/// own. Same reasoning as `SETTLE_SECS` one level up: a workspace is
/// something you come back to, a two-minute shell is not.
pub const SESSION_SETTLE_SECS: u64 = 120;

/// Fold live tmux state into every live project's declaration once.
/// Returns the ids that were written.
///
/// Two phases, and the store lock is held only in the second. Observing is
/// tmux work — `has-session`, `list-panes` (which runs `ps` for the child
/// commands), a `launch.json` read per window — tens to hundreds of
/// milliseconds per project; every RPC in the server goes through
/// `with_store`, so doing that under the lock stalled each of them behind the
/// tick. Folding is a few SQLite statements per project and is all the lock
/// protects.
///
/// The same tick publishes the restore checkpoint for its tmux socket (board
/// #422), but only from a complete observation — see `restore::checkpoint_from`.
pub fn capture_once() -> Result<Vec<String>, String> {
    let ts = now();
    let sessions = agent_sessions();
    let socket = restore::socket_key();
    // The restore batches of this socket (board #422), read before tmux is:
    // an OPEN batch holds its projects' sessions, a closed one may have left
    // windows it owns and never restored. Both come from ONE read with the
    // revision the commit re-checks, so they are of one snapshot.
    let (projects, scan) = with_store(|store| Ok((store.list_projects(false)?, store.batch_scan(&socket)?)))?;
    let store::BatchScan { open: open_batch, last: last_batch, revision } = scan;

    // Phase 1 — no lock: which declared sessions are live, and what tmux shows.
    // ONE listing answers "which sessions are live" for every project, and it
    // is the first half of the restore checkpoint's server identity (board
    // #422); a listing that failed sees no session, as `has-session` did.
    let before = restore::tmux_now();
    tick_hook(TickPhase::Listed);
    let live = before.session_names();
    let mut seen: Vec<String> = Vec::new();
    // (id, session, path, observed windows, managed agent windows)
    let mut observed: Vec<(String, String, String, Vec<Observed>, std::collections::HashSet<String>)> = Vec::new();
    let mut incomplete: Option<String> = match &open_batch {
        Ok(None) => None,
        Ok(Some(_)) => Some("a restore is in progress".to_string()),
        Err(e) => Some(format!("the restore batch is unreadable: {e}")),
    };
    // Projects this tick must not fold: the open batch's, or — when a batch
    // cannot be read — any whose session carries a restore's env.
    let mut held: std::collections::HashSet<String> = std::collections::HashSet::new();
    for project in projects {
        if !live.contains(&project.session) {
            continue;
        }
        seen.push(project.id.clone());
        let in_open = match &open_batch {
            Ok(Some(b)) => b.projects.iter().any(|p| p.id == project.id),
            Ok(None) => false,
            Err(_) => restore_env(&project.session),
        };
        let unreadable_last = last_batch.is_err() && restore_env(&project.session);
        if in_open || unreadable_last {
            held.insert(project.id.clone());
            continue;
        }
        // Windows a closed batch owns and never restored (a launch_unknown
        // start, a kill left in place, its holder) — by ownership, never by
        // name (review P1-A).
        let unrestored = match &last_batch {
            Ok(Some(b)) => match super::restore_run::unrestored_windows(b, &project.id) {
                Ok(set) => set,
                Err(e) => {
                    held.insert(project.id.clone());
                    incomplete = incomplete.or(Some(format!("{}: {e}", project.session)));
                    continue;
                }
            },
            _ => Default::default(),
        };
        match observe(&project.session, &project.path, sessions) {
            Ok(mut o) => {
                o.retain(|w| !unrestored.contains(&(w.window, w.window_name.clone())));
                // Provenance is a file read: done here, outside the lock.
                let managed = o
                    .iter()
                    .filter(|w| w.kind == store::SlotKind::Agent && is_managed_in(Some(&project.path), &w.window_name))
                    .map(|w| w.window_name.clone())
                    .collect();
                observed.push((project.id, project.session, project.path, o, managed));
            }
            // Session vanished mid-scan; next tick retries — and this tick's
            // observation is incomplete, so it publishes no checkpoint.
            Err(e) => incomplete = incomplete.or(Some(format!("{}: {e}", project.session))),
        }
    }
    // The second half: the same server must still be the one answering.
    tick_hook(TickPhase::Observed);
    let after = restore::tmux_now();
    let boot_id = restore::tick_boot();

    // Phase 2 — one short lock: fold the observations into the declarations,
    // and publish the checkpoint IN THE SAME TRANSACTION as the folds it
    // describes (review P1-B): the checkpoint's windows are the very slots
    // this tick writes, and a refused fold rolls both back.
    with_store(|store| {
        for id in &seen {
            store.mark_seen(id, ts)?;
        }
        // Held projects were never observed (above): an OPEN batch owns its
        // projects' sessions until it closes — a half-built session must not
        // prune the slots it is about to recreate — and no checkpoint is
        // published while a restore is in progress or a batch is unreadable.
        let mut folds = Vec::new();
        let mut checkpoint_projects = Vec::new();
        for (id, session, path, observed, managed) in observed {
            // Deleted between the phases: nothing to fold into, and inserting
            // slots for a vanished project would fail the whole tick. Nothing
            // to restore either, so it is not in the checkpoint.
            if store.project(&id)?.is_none() {
                continue;
            }
            let existing = store.slots(&id)?;
            // Stop is a pause for managed agents: their isolated home is the
            // durable membership record, so a missing window keeps its slot
            // and exact conversation id. Remove deletes both explicitly.
            let keep_missing = existing
                .iter()
                .filter(|s| s.kind == store::SlotKind::Agent)
                .filter(|s| is_managed_in(Some(&path), &s.window_name))
                .map(|s| s.window_name.clone())
                .collect();
            let merged = merge_preserving(
                &existing,
                &observed,
                ts,
                SETTLE_SECS,
                &keep_missing,
            );
            checkpoint_projects.push(store::CheckpointProject {
                id: id.clone(),
                session,
                windows: restore::checkpoint_windows(&observed, &merged.slots, &managed),
            });
            if merged.dirty {
                folds.push((id, merged.slots));
            }
        }
        // An incomplete tick folds and advances no evidence: the previous
        // checkpoint stays.
        let incomplete = incomplete.or_else(|| (!held.is_empty()).then(|| "a restore holds a project".to_string()));
        let checkpoint = restore::checkpoint_from(&before, &after, incomplete, checkpoint_projects, boot_id.clone(), ts).ok();
        // Committed only if the batches are still what this tick scanned
        // under; a restore that began (or moved on) meanwhile voids the tick.
        // And only once a prepare has decided for this boot while another
        // boot's evidence is stored (board #422 round 3): the decision reads
        // that evidence and the slots it is compared with.
        match store.commit_scanned(&folds, checkpoint.map(|cp| (socket.as_str(), cp)), Some((socket.as_str(), &revision, boot_id.as_deref())))? {
            Some(_) => Ok(folds.into_iter().map(|(id, _)| id).collect()),
            None => Ok(Vec::new()),
        }
    })
}

/// Does `session` carry a restore batch in its environment? Asked only when
/// a batch cannot be read (validator P2): such a session is held unfolded,
/// every other project folds as usual. An unreadable answer holds it too.
fn restore_env(session: &str) -> bool {
    match tmux::run_tmux(&["display", "-p", "-t", &format!("={session}:"), "#{TMM_RESTORE_BATCH}"]) {
        Ok(v) => !v.trim().is_empty(),
        Err(_) => true,
    }
}

/// Where a test may act inside one capture tick (board #422): after the first
/// listing, and after the observation, before the second listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TickPhase {
    Listed,
    Observed,
}

#[cfg(test)]
pub(crate) static TICK_HOOK: std::sync::Mutex<Option<Box<dyn FnMut(TickPhase) + Send>>> = std::sync::Mutex::new(None);

fn tick_hook(_phase: TickPhase) {
    #[cfg(test)]
    if let Some(hook) = TICK_HOOK.lock().unwrap().as_mut() {
        hook(_phase);
    }
}

/// Background capturer, spawned once by the server.
///
/// The tick is tmux subprocesses, `ps`, SQLite and file reads — all blocking —
/// so it runs on the blocking pool, never inline on a runtime worker where it
/// would hold up every WebSocket connection's tasks for its duration.
pub async fn capture_loop() {
    // Built-ins materialize once per server start, before the first tick.
    seed_builtin_skills();
    loop {
        tokio::time::sleep(CAPTURE_INTERVAL).await;
        // One process-table snapshot for the whole tick (board #145): observe
        // and the recovery scan list the same sessions back to back, and each
        // `list_panes` used to run its own `ps` — 2 × live projects per tick.
        let tick = tokio::task::spawn_blocking(|| {
            tmux::with_process_snapshot(|| {
                if let Err(e) = auto_adopt_once() {
                    eprintln!("projects: auto-track failed: {e}");
                }
                // A boot no prepare has decided for yet (it became readable,
                // or a decision write failed) is decided before the tick,
                // which otherwise commits nothing over the old evidence.
                super::restore_run::decide_if_needed();
                if let Err(e) = capture_once() {
                    eprintln!("projects: capture failed: {e}");
                }
                // Restore holds: released on their measured evidence, and
                // retired when their pane is confirmed gone (board #422).
                super::restore_hold::release_ready();
                super::restore_hold::prune();
                super::restore_hold::tick_not_ready();
                // Piggybacks on the capture cadence: a transient model error is
                // noticed within one tick, and the backoff ladder is measured in
                // tens of seconds, so 20s granularity costs nothing.
                recovery::check_once();
            })
        })
        .await;
        if let Err(e) = tick {
            eprintln!("projects: capture tick panicked: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #422 (validator P5/P6): the capture tick's OWN completeness
    /// wiring, on a real private server. A live project whose session
    /// vanishes between the listing and its observation makes the tick
    /// incomplete; a server replaced between the observation and the second
    /// listing makes it name two servers. Neither publishes a checkpoint; an
    /// undisturbed tick does (control).
    #[test]
    fn a_tick_disturbed_between_its_listings_publishes_no_checkpoint() {
        super::super::tests::use_test_store();
        let scope = tmux::test_support::GlobalSocket::hold();
        let server = tmux::test_support::PrivateTmux::start(&scope, "tick");
        let socket = server.socket().to_string();
        let ws = std::env::temp_dir().join(format!("tmm-tick-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws).unwrap();
        let cwd = ws.to_string_lossy().to_string();
        let start = |s: &str| server.run(&["new-session", "-d", "-s", s, "-c", &cwd]).unwrap();
        start("anchor");
        let session = format!("tick{}", std::process::id());
        start(&session);
        super::super::adopt(&session, None).unwrap();
        let gen = || with_store(|s| s.checkpoint(&socket)).unwrap().map(|c| c.gen);
        let set_hook = |h: Option<Box<dyn FnMut(TickPhase) + Send>>| *TICK_HOOK.lock().unwrap() = h;

        capture_once().unwrap();
        let first = gen().expect("control: an undisturbed tick publishes");

        // P5: the project's session vanishes after the listing.
        let (sock, name) = (socket.clone(), session.clone());
        set_hook(Some(Box::new(move |phase| {
            if phase == TickPhase::Listed {
                let _ = tmux::run_tmux_on(Some(&sock), &["kill-session", "-t", &format!("={name}:")]);
            }
        })));
        let _ = capture_once();
        set_hook(None);
        assert_eq!(gen(), Some(first), "a vanished live project makes the tick incomplete");

        // P6: the server is replaced between the observation and the second listing.
        start(&session);
        capture_once().unwrap();
        let second = gen().unwrap();
        assert_eq!(second, first + 1, "control: undisturbed again, it publishes");
        let (sock, cwd2) = (socket.clone(), cwd.clone());
        set_hook(Some(Box::new(move |phase| {
            if phase == TickPhase::Observed {
                tmux::test_support::destroy_private_server(&sock).unwrap();
                // kill-server returns before the server is gone: wait until
                // the socket answers "no server", so the new one is new.
                let gone = (0..200).any(|_| {
                    let absent = tmux::run_tmux_on(Some(&sock), &["list-sessions"]).is_err_and(|e| tmux::session_confirmed_absent(&e));
                    if !absent {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    absent
                });
                assert!(gone, "the old server exited");
                tmux::run_tmux_on(Some(&sock), &["new-session", "-d", "-s", "reborn", "-c", &cwd2]).unwrap();
            }
        })));
        let _ = capture_once();
        set_hook(None);
        assert_eq!(gen(), Some(second), "a tick that saw two servers publishes nothing");

        let _ = super::super::delete(&with_store(|s| s.project_by_session(&session)).unwrap().unwrap().id);
        drop(server);
        let _ = std::fs::remove_dir_all(&ws);
    }

    fn obs(name: &str, cwd: &str) -> Observed {
        Observed {
            window: 0,
            window_name: name.into(),
            cwd: cwd.into(),
            kind: SlotKind::Shell,
            command: None,
            agent_session_id: None,
        }
    }

    fn slot(name: &str, ord: i64, first_seen: u64, settled: Option<u64>) -> Slot {
        Slot {
            id: Some(ord + 1),
            ord,
            window_name: name.into(),
            cwd: String::new(),
            kind: SlotKind::Shell,
            command: None,
            auto_run: false,
            agent_session_id: None,
            first_seen_at: first_seen,
            settled_at: settled,
        }
    }

    fn agent_obs(name: &str, id: Option<&str>) -> Observed {
        Observed {
            window: 1,
            window_name: name.into(),
            cwd: String::new(),
            kind: SlotKind::Agent,
            command: Some("kiro".into()),
            agent_session_id: id.map(str::to_string),
        }
    }

    #[test]
    fn a_learned_conversation_id_is_recorded_and_then_kept() {
        let first = merge(&[], &[agent_obs("kiro", Some("conv-1"))], 1_000, 120);
        assert_eq!(first.slots[0].agent_session_id.as_deref(), Some("conv-1"));
        assert!(first.dirty);

        // Hooks only report now and then: a quiet cycle must not erase it.
        let quiet = merge(&first.slots, &[agent_obs("kiro", None)], 1_200, 120);
        assert_eq!(quiet.slots[0].agent_session_id.as_deref(), Some("conv-1"));

        // A different conversation in the same window replaces it.
        let moved_on = merge(&quiet.slots, &[agent_obs("kiro", Some("conv-2"))], 1_400, 120);
        assert_eq!(moved_on.slots[0].agent_session_id.as_deref(), Some("conv-2"));
        assert!(moved_on.dirty, "the new id has to reach the database");

        // The window stopped being an agent: the stale conversation goes.
        let now_shell = merge(&moved_on.slots, &[obs("kiro", "")], 1_600, 120);
        assert_eq!(now_shell.slots[0].agent_session_id, None);
    }

    #[test]
    fn a_new_window_is_remembered_but_not_restorable_yet() {
        let m = merge(&[], &[obs("shell", "")], 1_000, 120);
        assert_eq!(m.slots.len(), 1);
        assert_eq!(m.slots[0].first_seen_at, 1_000);
        assert!(!m.slots[0].is_settled(), "not restorable yet");
        assert!(m.dirty, "must be persisted so first_seen_at survives a restart");
    }

    #[test]
    fn a_window_settles_once_it_has_survived_the_threshold() {
        let existing = vec![slot("shell", 0, 1_000, None)];
        let early = merge(&existing, &[obs("shell", "")], 1_100, 120);
        assert!(!early.slots[0].is_settled());
        assert!(!early.dirty, "nothing to write yet");

        let late = merge(&existing, &[obs("shell", "")], 1_120, 120);
        assert_eq!(late.slots[0].settled_at, Some(1_120));
        assert!(late.dirty);
    }

    #[test]
    fn a_window_that_is_gone_leaves_the_declaration() {
        for existing in [
            vec![slot("shell", 0, 1_000, None)],          // never settled
            vec![slot("shell", 0, 1_000, Some(1_120))],   // was restorable
        ] {
            let gone = merge(&existing, &[], 1_300, 120);
            assert!(gone.slots.is_empty(), "up must not recreate a window you closed");
            assert!(gone.dirty);
        }
    }

    #[test]
    fn a_stopped_managed_agent_keeps_its_slot_and_conversation() {
        let mut agent = slot("claude", 2, 1_000, Some(1_120));
        agent.kind = SlotKind::Agent;
        agent.command = Some("claude".into());
        agent.auto_run = true;
        agent.agent_session_id = Some("conv-1".into());
        let keep = std::collections::HashSet::from(["claude".to_string()]);

        let stopped = merge_preserving(&[agent], &[], 1_300, 120, &keep);
        assert_eq!(stopped.slots.len(), 1, "Stop pauses; only Remove ejects");
        assert_eq!(stopped.slots[0].agent_session_id.as_deref(), Some("conv-1"));
        assert_eq!(stopped.slots[0].ord, 0, "kept slots follow live windows");
        assert!(stopped.dirty, "the normalized order must be persisted");
    }

    #[test]
    fn reordering_and_moving_cwd_are_written_back() {
        let existing = vec![slot("a", 0, 1_000, Some(1_120)), slot("b", 1, 1_000, Some(1_120))];
        let same = merge(&existing, &[obs("a", ""), obs("b", "")], 1_400, 120);
        assert!(!same.dirty, "an unchanged capture writes nothing");

        let swapped = merge(&existing, &[obs("b", ""), obs("a", "")], 1_400, 120);
        assert!(swapped.dirty);
        assert_eq!(swapped.slots[0].window_name, "b");
        assert_eq!(swapped.slots[0].ord, 0);

        let moved = merge(&existing, &[obs("a", "src"), obs("b", "")], 1_400, 120);
        assert!(moved.dirty);
        assert_eq!(moved.slots[0].cwd, "src");
    }

    #[test]
    fn becoming_an_agent_window_flips_auto_run_and_keeps_first_seen() {
        let existing = vec![slot("work", 0, 1_000, Some(1_120))];
        let observed = vec![Observed {
            window: 0,
            window_name: "work".into(),
            cwd: String::new(),
            kind: SlotKind::Agent,
            command: Some("kiro".into()),
            agent_session_id: None,
        }];
        let m = merge(&existing, &observed, 1_500, 120);
        assert!(m.dirty);
        assert_eq!(m.slots[0].kind, SlotKind::Agent);
        assert!(m.slots[0].auto_run, "agents are relaunched, shells are not");
        assert_eq!(m.slots[0].first_seen_at, 1_000, "age is not reset by a change");
        assert_eq!(m.slots[0].settled_at, Some(1_120));
    }

    #[test]
    fn cwd_is_stored_relative_to_the_project() {
        assert_eq!(relative_cwd("/w/app", "/w/app"), "");
        assert_eq!(relative_cwd("/w/app/src/api", "/w/app"), "src/api");
        assert_eq!(relative_cwd("/w/app/src", "/w/app/"), "src");
        assert_eq!(relative_cwd("/elsewhere", "/w/app"), "/elsewhere");
        assert_eq!(relative_cwd("", "/w/app"), "");
    }

    #[test]
    fn duplicate_window_names_collapse_to_one_slot() {
        // Two live windows named "zsh" are indistinguishable to a by-name
        // declaration; writing both violated UNIQUE(project_id, window_name)
        // and made every capture tick fail for the whole project.
        let observed = vec![obs("zsh", ""), obs("zsh", "/elsewhere")];
        let m = merge(&[], &observed, 100, SETTLE_SECS);
        assert_eq!(m.slots.len(), 1);
        assert_eq!(m.slots[0].window_name, "zsh");
    }
}