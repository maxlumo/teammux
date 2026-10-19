//! Project verbs: create / adopt / up / down / rename / archive / delete and the session-workspace lookups — a project is a declaration, the tmux session its disposable projection.
//!
//! One family of `projects` (board #152): moved whole from mod.rs, which stays
//! the facade — every `projects::X` path is a re-export of this file.

use super::*;

/// Every project, each with its slots and whether its session is live.
///
/// The client derives "untracked sessions" by subtracting these from
/// `list_sessions`, so there is exactly one place that decides what a session
/// is: tracked sessions live in the Projects section, everything else stays in
/// the session list.
pub fn list(include_archived: bool) -> Result<Value, String> {
    // Rows under the lock, tmux outside it (board #149): `has-session` is a
    // subprocess (~9 ms here) and this ran it per project while every other
    // store caller queued — 7 live projects = ~60 ms of lock per list.
    let rows = with_store(|store| {
        let projects = store.list_projects(include_archived)?;
        let mut out = Vec::with_capacity(projects.len());
        for p in projects {
            let slots = store.slots(&p.id)?;
            out.push((p, slots));
        }
        Ok(out)
    })?;
    let projects: Vec<Value> = rows
        .into_iter()
        .map(|(p, slots)| {
            let live = tmux::session_exists(&p.session);
            json!({ "project": p, "slots": slots, "live": live })
        })
        .collect();
    Ok(json!({ "projects": projects }))
}

/// Create a project for a directory. Idempotent by SESSION, not by path:
/// identity is the tmux session (several projects parked in the same
/// directory — typically `$HOME` — are separate workspaces), so only the
/// literal same request (same wanted session AND same canonical path) returns
/// the existing project (un-archived). A new project at a path some other
/// project already uses is a NEW project — merging on path silently swallowed
/// it (owner report, 2026-08-19).
///
/// `session` is the tmux session name the user asked for (falling back to the
/// directory basename); `agent` seeds the workspace with one agent window, which
/// is how the create form's Kiro/Claude presets survive the move from
/// "new session" to "new project".
pub fn create(
    path: &str,
    name: Option<&str>,
    session: Option<&str>,
    agent: Option<&str>,
) -> Result<Value, String> {
    let path = canonical(path)?;
    let label = name
        .or(session)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| basename(&path))
        .to_string();
    let ts = now();
    with_store(|store| {
        // The session follows the NAME when one was given: a project called
        // "closetest" living in /tmp must not become the session "tmp" (owner
        // report — the same folder-name-wins bug the Hub dialog hit). An
        // explicit `session` still overrides; basename is the last resort.
        let wanted = session
            .filter(|s| !s.trim().is_empty())
            .or(name.filter(|s| !s.trim().is_empty()))
            .map(slug)
            .unwrap_or_else(|| slug(basename(&path)));
        // Same session + same directory IS the same request: return the row
        // instead of a duplicate. A session-name clash with a DIFFERENT
        // directory falls through — free_session_name suffixes the new one.
        if let Some(existing) = store.project_by_session(&wanted)? {
            if existing.path == path {
                if existing.archived {
                    store.set_archived(&existing.id, false, ts)?;
                }
                return Ok(json!(existing));
            }
        }
        // Two projects may now legitimately share label + path, so the id
        // must be salted past a collision rather than assumed unique.
        let mut id = format!("{}-{}", slug(&label), digest(&path));
        let mut salt: u32 = 1;
        while store.project(&id)?.is_some() {
            salt += 1;
            id = format!("{}-{}", slug(&label), digest(&format!("{path}#{salt}")));
        }
        let session = free_session_name(store, &wanted, &id)?;
        let project = Project {
            id: id.clone(),
            name: label,
            path,
            icon: None,
            session,
            adopted: false,
            autostart: false,
            created_at: ts,
            last_up_at: None,
            last_seen_at: None,
            archived: false,
            room: String::new(),   // insert_project freezes it as proj:<session>
        };
        store.insert_project(&project)?;
        // A seeded agent slot is settled straight away: the user asked for that
        // agent, so `up` must create its window on the first run instead of
        // waiting for the capturer to notice it.
        if let Some(backend) = agent.filter(|b| agents::launch_for(b).is_some()) {
            store.replace_slots(
                &id,
                &[Slot {
                    id: None,
                    ord: 0,
                    window_name: backend.to_string(),
                    cwd: String::new(),
                    kind: store::SlotKind::Agent,
                    command: Some(backend.to_string()),
                    auto_run: true,
                    agent_session_id: None,
                    first_seen_at: ts,
                    settled_at: Some(ts),
                }],
            )?;
        }
        Ok(json!(project))
    })
}

/// Adopt a live tmux session: the user created it, so we keep its name and take
/// its current windows as the declaration straight away — an adopted project
/// must be restorable even if the machine reboots one minute later.
///
/// Identity is the SESSION, not the directory: several sessions parked in the
/// same directory (typically `$HOME`) are still separate workspaces.
pub fn adopt(session: &str, name: Option<&str>) -> Result<Value, String> {
    if !tmux::session_exists(session) {
        return Err(format!("no such tmux session: {session}"));
    }
    // The scratch terminal's session is not a project (board #324), and its
    // NAME is reserved (board #337) — so this refuses even when the session
    // is not (yet) ours, instead of letting a hand adoption recreate the dead
    // end the reservation exists to prevent. The reason says which it is.
    if super::scratch::reserved(session) {
        return Err(if super::scratch::is_scratch(session) {
            format!("'{session}' is the scratch terminal's session, not a project")
        } else {
            format!("'{session}' is the name the scratch terminal reserves — rename that session to adopt it as a project")
        });
    }
    let ts = now();
    let facts = adopt_facts(session)?;
    with_store(|store| adopt_in(store, session, name, ts, &facts))
}

/// The tmux half of an adoption, read OUTSIDE the store lock (board #149):
/// the session's workspace and its windows. Two pane listings ≈ 90 ms on this
/// host, during which every other store caller used to queue.
pub(super) struct AdoptFacts {
    path: String,
    observed: Vec<capture::Observed>,
}

pub(super) fn adopt_facts(session: &str) -> Result<AdoptFacts, String> {
    let path = canonical(&session_workspace(session)?)?;
    let observed = capture::observe(session, &path, agent_sessions())?;
    Ok(AdoptFacts { path, observed })
}

/// The row half of an adoption: only SQLite inside. The already-tracked check
/// runs here, under the lock, so two adopters racing on one session still get
/// the same answer they always did.
pub(super) fn adopt_in(
    store: &mut Store,
    session: &str,
    name: Option<&str>,
    ts: u64,
    facts: &AdoptFacts,
) -> Result<Value, String> {
    let path = facts.path.clone();
    if let Some(existing) = store.project_by_session(session)? {
        return Err(format!(
            "session {session} is already tracked as project '{}'",
            existing.name
        ));
    }
    let id = format!("{}-{}", slug(session), digest(session));
    let project = Project {
        id: id.clone(),
        name: name.unwrap_or(session).to_string(),
        path: path.clone(),
        icon: None,
        session: session.to_string(),
        adopted: true,
        autostart: false,
        created_at: ts,
        last_up_at: Some(ts),
        last_seen_at: Some(ts),
        archived: false,
        room: String::new(),   // insert_project freezes it as proj:<session>
    };
    store.insert_project(&project)?;
    let merged = capture::merge(&[], &facts.observed, ts, capture::SETTLE_SECS);
    // Settle immediately: these windows already exist and are the reason
    // the user is adopting the session.
    let slots: Vec<Slot> = merged
        .slots
        .into_iter()
        .map(|mut s| {
            s.settled_at = Some(ts);
            s
        })
        .collect();
    store.replace_slots(&id, &slots)?;
    Ok(json!({ "project": project, "slots": slots }))
}

/// Adopt every tmux session that isn't a project yet, so a session made outside
/// the app (`tmux new -s foo`) still survives a reboot. This is also the
/// migration path: on first run it picks up everything that already existed.
///
/// Three guards keep it from becoming a new source of entropy:
///
/// * a session must have existed for `SESSION_SETTLE_SECS` — a `tmux new` for a
///   30-second job must not leave a permanent declaration behind;
/// * team sessions are never adopted (Team owns their lifecycle);
/// * a session whose project was ARCHIVED is never re-adopted, or "remove from
///   projects" would undo itself on the next tick.
pub fn auto_adopt_once() -> Result<Vec<String>, String> {
    auto_adopt_with(&tmux::session_created_times(), now())
}

/// The decision half of `auto_adopt_once`, taking the session ages as data so
/// the guards are testable without waiting two minutes.
pub(super) fn auto_adopt_with(created: &[(String, u64)], ts: u64) -> Result<Vec<String>, String> {
    // Lock once to learn what is known, read tmux with no lock held, then
    // lock once more for the row writes (board #149). `adopt_in` re-checks
    // "already tracked" under the lock, so a session adopted by hand between
    // the two locks is refused exactly as before.
    let known: Vec<String> =
        with_store(|store| Ok(store.list_projects(true)?.into_iter().map(|p| p.session).collect()))?;
    let mut candidates: Vec<(&String, AdoptFacts)> = Vec::new();
    for (session, created_at) in created {
        if known.contains(session) || ts.saturating_sub(*created_at) < SESSION_SETTLE_SECS {
            continue;
        }
        // The scratch terminal's session is the one tmux session that is not
        // a project (board #324). By NAME here, not by ownership (board #337):
        // an UNMARKED session with that name used to be adopted after the
        // settle, and the row it created made `owned()` answer `Taken` for
        // good — the panel dead with no way out. The automatic claim declines
        // the reserved name whoever holds it; `ensure`/`kill` still refuse a
        // session that is not ours, which is the rule that protects the user's.
        if super::scratch::reserved(session) {
            continue;
        }
        match adopt_facts(session) {
            Ok(facts) => candidates.push((session, facts)),
            Err(e) => eprintln!("projects: cannot track session {session}: {e}"),
        }
    }
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    with_store(|store| {
        let mut adopted = Vec::new();
        for (session, facts) in &candidates {
            match adopt_in(store, session, None, ts, facts) {
                Ok(_) => adopted.push((*session).clone()),
                Err(e) => eprintln!("projects: cannot track session {session}: {e}"),
            }
        }
        Ok(adopted)
    })
}

pub fn up(id: &str) -> Result<Value, String> {
    up_with(id, reconcile::up)
}

/// `up`, with the reconcile as a seam for the tests. A successful up is the
/// one way out of a person's down, and of the Stop of every agent it started
/// (board #422) — but only of the intents that stood when it BEGAN: their
/// versions are read first and cleared conditionally at the end, so a down
/// or Stop issued while this up ran survives it (review P1-A). Success is per
/// unit: the down mark goes only when no slot reported an error; a window's
/// Stop mark only when that window came up created/existing with no error.
fn up_with(id: &str, reconcile: impl FnOnce(&store::Project, &[store::Slot]) -> Result<reconcile::UpReport, String>) -> Result<Value, String> {
    let (project, slots) = load(id)?;
    let (down, stopped) = with_store(|store| {
        let down = store.project_down_version(id)?;
        let mut stopped = Vec::new();
        for slot in &slots {
            if let Some(v) = store.slot_stopped_version(id, &slot.window_name)? {
                stopped.push((slot.window_name.clone(), v));
            }
        }
        Ok((down, stopped))
    })?;
    let report = reconcile(&project, &slots)?;
    let clean = |r: &reconcile::SlotResult| (r.status == "created" || r.status == "existing") && r.error.is_none();
    with_store(|store| {
        store.mark_up(id, now())?;
        if let Some(v) = &down {
            if report.slots.iter().all(|r| r.error.is_none()) {
                store.clear_project_down_if(id, v)?;
            }
        }
        for (window, v) in &stopped {
            if report.slots.iter().any(|r| r.window_name == *window && clean(r)) {
                store.clear_slot_stopped_if(id, window, v)?;
            }
        }
        Ok(())
    })?;
    Ok(json!(report))
}

/// Restart ONE agent slot of a project (board #210): the window returns with
/// its full recipe and exact conversation id; no other slot is touched and
/// the project's `last_up_at` is not a project-level `up`, so it is left
/// alone. `Ok(None)` = no such agent slot yet (the capture loop has not
/// recorded it). The caller judges the result, and clears a Stop only
/// through `starting` (board #422).
pub fn up_agent(id: &str, window_name: &str) -> Result<Option<reconcile::SlotResult>, String> {
    let (project, slots) = load(id)?;
    Ok(reconcile::up_agent(&project, &slots, window_name))
}

/// Record that a person STOPPED one managed agent (board #422): written
/// before the window is killed, so a restore after a reboot never starts what
/// a person paused. A session that is no project has nothing to restore, and
/// nothing to record.
pub fn mark_agent_stopped(session: &str, agent: &str) -> Result<(), String> {
    let Some(project) = project_for_session(session)? else { return Ok(()) };
    with_store(|store| store.set_slot_stopped(&project.id, agent)).map(|_| ())
}

/// The ONE licence a top-level start verb holds to clear an agent's Stop
/// (board #422, review P1-A residual). The verb — the hub's Start/Restart
/// (taken before its kill), a team restart, a spawn or fork once its window
/// name is decided — takes it BEFORE any side effect; it records the Stop
/// version that stood then. Nested launches (`respawn`, `launch_window`)
/// never read the mark: they run under the verb's permit. `finish(true)`
/// clears exactly that version, once, at the verb's end; a failed start
/// drops the permit and clears nothing; a Stop written meanwhile stands.
#[must_use = "a start permit is finished by the verb that took it"]
pub struct StartPermit {
    stood: Option<(String, String, String)>,
    /// The slot's restore hold as it stood when the verb began (board #422
    /// round 3, review P1-B): the verb's launch door installs the next
    /// generation of THAT hold even if a prune retired its row after the
    /// verb's kill. A hold that cannot be read refuses the verb here.
    _intent: super::restore_hold::Intent,
}

pub fn start_permit(session: &str, agent: &str) -> Result<StartPermit, String> {
    let stood = match project_for_session(session)? {
        Some(project) => with_store(|store| store.slot_stopped_version(&project.id, agent))?.map(|v| (project.id, agent.to_string(), v)),
        None => None,
    };
    let _intent = super::restore_hold::intent(session, agent)?;
    Ok(StartPermit { stood, _intent })
}

impl StartPermit {
    /// End the verb: on a clean success, clear the version this permit read.
    pub fn finish(self, clean: bool) -> Result<(), String> {
        match (clean, &self.stood) {
            (true, Some((id, window, v))) => with_store(|store| store.clear_slot_stopped_if(&id, &window, &v)).map(|_| ()),
            _ => Ok(()),
        }
    }
}

/// A kill through the Sessions page is a person's down (board #422,
/// validator F3): recorded before `kill_session`, like `down`'s, for a
/// session that is a project.
pub fn record_session_kill(session: &str) -> Result<(), String> {
    match with_store(|store| store.project_by_session(session))? {
        Some(project) => with_store(|store| store.set_project_down(&project.id)).map(|_| ()),
        None => Ok(()),
    }
}

/// Close one window for the Sessions page (board #422, validator F3, review
/// P1): ONE operation, resolve → mark → kill. The target is resolved to its
/// session, name and native `@id` on this server; a managed agent's window
/// gets its Stop mark; the kill goes to the `@id`, after the same server
/// still shows that id under that session and name — never to the original
/// string, which a renumber can point at another window. A target that is
/// confirmed gone is done (`Ok`); one that cannot be resolved, or whose
/// managed-ness cannot be read, is an `Err` and nothing is killed.
pub fn close_window(target: &str) -> Result<(), String> {
    close_window_with(target, || {}, || {})
}

fn close_window_with(target: &str, after_resolve: impl FnOnce(), before_kill: impl FnOnce()) -> Result<(), String> {
    let Some(w) = tmux::resolve_window(target)? else { return Ok(()) };
    // The project that declares this PHYSICAL session (no previous-name
    // alias), and the window's managed-ness as a three-way answer: a marker
    // that cannot be read is not "plain" (review, F3 residual).
    let project = with_store(|store| store.project_by_session(&w.session))?;
    let owner = match &project {
        Some(p) => match super::managed::managed_state(&p.path, &w.name) {
            super::managed::ManagedState::Managed => Some(p.id.clone()),
            super::managed::ManagedState::Plain => None,
            super::managed::ManagedState::Unknown(e) => {
                return Err(format!("'{target}' was not closed — whether it is a managed agent cannot be read: {e}"));
            }
        },
        None => None,
    };
    after_resolve();
    if let Some(id) = owner {
        // The Stop goes to the project resolved above, and only while it
        // still declares this session: one object for the check, the intent
        // key and the window that is killed.
        with_store(|store| {
            match store.project(&id)? {
                Some(p) if p.session == w.session => store.set_slot_stopped(&id, &w.name).map(|_| ()),
                _ => Err(format!("'{target}' was not closed — its project changed while it was being closed")),
            }
        })?;
    }
    before_kill();
    match tmux::resolve_window(&w.id)? {
        None => return Ok(()),
        Some(now) if !now.same_server(&w) || now.session != w.session || now.name != w.name => {
            return Err(format!("'{target}' changed before it could be closed — nothing was killed"));
        }
        Some(_) => {}
    }
    match tmux::kill_window(&w.id) {
        Err(e) if e.contains("can't find window") => Ok(()),
        other => other,
    }
}

pub fn down(id: &str) -> Result<Value, String> {
    down_with(id, reconcile::down)
}

/// `down`, with the close as a seam for the tests. The intent is durable
/// BEFORE the kill (board #422): a crash between the two, or a kill that
/// fails, must still leave "a person took this down" on record — and it
/// stays until a successful `up`, whatever later ticks observe.
fn down_with(id: &str, close: impl FnOnce(&store::Project) -> Result<(), String>) -> Result<Value, String> {
    let (project, _) = load(id)?;
    with_store(|store| store.set_project_down(id))?;
    close(&project).map_err(|e| {
        format!("'{}' is marked down and will not come back after a reboot, but its session did not close: {e}", project.name)
    })?;
    Ok(json!({ "session": project.session, "live": false }))
}

/// Rename a project — the LABEL only.
///
/// A project is named by its name and identified by its session (see
/// `create`), and three things are keyed on that session: the row's UNIQUE
/// column, the tmux session the declaration projects onto, and the chat room
/// `proj:<session>`. So renaming the session would silently orphan the
/// conversation and leave a live session no project claims; the name is the
/// part a user actually reads, and it is the part that moves.
pub fn rename(id: &str, name: &str) -> Result<Value, String> {
    // No expectation travels in, so `Stale` cannot come back: one
    // implementation, and only a caller that carries an expectation can have
    // it expire.
    rename_if_session(id, None, name).map_err(|e| e.text().to_string())
}

/// Why a write refused, when one of the answers is not a failure at all
/// (board #337 and its review).
///
/// `Stale` means the caller's PRECONDITION no longer holds and nothing was
/// written: the state it decided from has moved on. That is a different thing
/// from an operation that tried and could not finish, because the way out of
/// it is to look again rather than to read a sentence — the scratch panel
/// drops its snapshot and re-asks, and the server gives it its own wire code
/// so no client has to parse the message to tell the two apart.
///
/// One type from the write that refuses to the socket that answers: the
/// classification cannot be lost in a translation step, because there is
/// none.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    Stale(String),
    Failed(String),
}

impl Refused {
    /// The sentence, for a caller that only shows it.
    pub(crate) fn text(&self) -> &str {
        match self {
            Refused::Stale(m) | Refused::Failed(m) => m,
        }
    }
}

/// `rename`, plus the caller's precondition about WHICH session the row must
/// still declare — checked inside the same store lock that writes, so the two
/// are one critical section.
///
/// A caller that reads a project, decides from what it read, and then renames
/// has a window between the two in which someone else renames the same row:
/// the decision was about a project that no longer exists in that shape, and
/// the write lands on it anyway (board #337 review P1-a — the scratch release
/// checked that a project still held the reserved name, and by the time it
/// renamed, that project could be wearing a name the user had just chosen).
/// Re-reading the row here is not enough on its own: `id` still exists, so
/// the only thing that can refuse is the expectation the caller carried in.
///
/// An expectation that no longer holds is `Refused::Stale` with NOTHING
/// written — the same answer as the caller's own earlier check, and the panel
/// recovers from it rather than showing it (review, 19:23: classifying it as
/// a failure left the reader with the stale confirmation and an error).
pub(crate) fn rename_if_session(id: &str, expect_session: Option<&str>, name: &str) -> Result<Value, Refused> {
    let name = name.trim();
    if name.is_empty() {
        return Err(Refused::Failed("project name must not be empty".into()));
    }
    let ts = now();
    // The expired precondition leaves the closure as a VALUE, not as an
    // error: `with_store`'s own errors are store failures, and folding the
    // two into one string is exactly what would make the wire code guesswork.
    with_store(|store| {
        let Some(project) = store.project(id)? else {
            // Gone under a caller that carried an expectation is that
            // expectation expiring too — the row was deleted between the
            // decision and here, and nothing was written. With no
            // expectation it is a plain failure.
            let gone = format!("no project with id '{id}'");
            return Ok(Err(match expect_session {
                Some(_) => Refused::Stale(gone),
                None => Refused::Failed(gone),
            }));
        };
        if let Some(expect) = expect_session {
            if project.session != expect {
                return Ok(Err(Refused::Stale(format!(
                    "project '{}' no longer declares session '{expect}' — nothing was renamed",
                    project.name
                ))));
            }
        }
        // The tmux SESSION follows the name, because it is the name the Terminal
        // and `tmux ls` show — leaving it behind made one project wear two names
        // (owner, 2026-08-19: "没有改tmux session的名字 所以在terminal显示不对").
        //
        // No exception for ADOPTED projects: `auto_adopt_once` adopts every
        // untracked session automatically, so `adopted` mostly means "the app
        // found it before it was declared", not "a human chose this name". The
        // first cut skipped them and thereby disabled the feature on 2 of the
        // owner's 4 projects, including the one they were renaming.
        let wanted = slug(name);
        // Everything that can REFUSE happens before anything is written: a rename
        // that moved the label and then failed on the session left the project
        // wearing two names again — the exact bug this feature exists to fix.
        if wanted != project.session {
            // The scratch terminal's name is reserved (board #337): a project
            // that declares it makes `owned()` answer `Taken` forever, which
            // is the dead end the reservation exists to prevent — and a
            // rename REFUSES a taken name rather than decorating one.
            if super::scratch::reserved(&wanted) {
                return Err(format!("'{wanted}' is the name the scratch terminal reserves — choose another"));
            }
            if tmux::session_exists(&wanted) {
                return Err(format!("a tmux session named '{wanted}' already exists"));
            }
            if store.session_taken_by_other(&wanted, id)? {
                let owner = store.project_by_session(&wanted)?;
                let label = owner.as_ref().map(|p| p.name.clone()).unwrap_or_default();
                let archived = owner.as_ref().is_some_and(|p| p.archived);
                // A rename REFUSES a taken name; it does not decorate one.
                // `create` suffixes with a digest because there the alternative is
                // failing to make the project at all, but here the user typed a
                // name and `closetest-e110d2` is not an answer to that — measured
                // on the owner's own data, where an ARCHIVED (invisible) project
                // was holding the name.
                return Err(format!(
                    "session '{wanted}' belongs to {}project '{label}' — rename or delete that one first",
                    if archived { "the archived " } else { "" },
                ));
            }
        }

        if !store.set_name(id, name)? {
            return Err(format!("no project with id '{id}'"));
        }
        let mut session = project.session.clone();
        let mut renamed_session = false;
        if wanted != project.session {
            // store-lock(tmux-ok): the ONE place tmux is touched under the store
            // lock on purpose — the session rename and the row re-key must not
            // drift apart (below), and the has-session check above is the
            // refuse-before-write precondition of the same act. One rename, a
            // handful of milliseconds, user-initiated (board #149 kept it).
            // tmux first: if it refuses anyway (a session created between the
            // check and here), the declaration must not drift away from it.
            let live = tmux::session_exists(&project.session);
            if !live || tmux::rename_session(&project.session, &wanted).is_ok() {
                store.set_session(id, &wanted, &project.session)?;
                session = wanted;
                renamed_session = true;
            }
        }
        store.mark_seen(id, ts)?;
        Ok(Ok(json!({
            "id": id,
            "name": name,
            "session": session,
            "session_renamed": renamed_session,
        })))
    })
    .map_err(Refused::Failed)?
}

pub fn set_archived(id: &str, archived: bool) -> Result<Value, String> {
    with_store(|store| {
        store.set_archived(id, archived, now())?;
        Ok(json!({ "id": id, "archived": archived }))
    })
}

/// Delete a project for good: close its session, then — in one store section
/// — check it is still the project that was closed, forget the row (slots
/// cascade) and stage its agents' homes, and finally remove the staged homes
/// outside the lock. The homes are kept when another project declares the
/// same directory: they are its too. Archive is the reversible verb — "hide
/// this from the list, I might come back"; this one is for a project that
/// should stop existing (owner: "除了关闭之外，还要可以删除").
///
/// What it does NOT touch: the workspace directory and anything in it that is
/// not ours. We delete `<path>/.tmm/agents/<name>/` — configs and launch
/// recipes this app wrote — and never the user's files. The chat room is kept
/// too: it is the record of what happened, and rooms are addressed by session
/// name, so a later project with the same name inherits its history rather
/// than losing it. The Board is project task state, not the room record: its
/// issues and note threads are deleted before the session name is released,
/// so another project can never inherit them (board #41).
pub fn delete(id: &str) -> Result<Value, String> {
    delete_with(id, reconcile::down, |_| {}, |store, id| store.delete_project(id))
}

/// Where `delete_with`'s `in_section` seam is called: both inside the one
/// store section, after the owner decision and after the claim.
#[derive(Clone, Copy, Debug, PartialEq)]
enum DeletePhase {
    Decided,
    Claimed,
}

/// `delete`, with its seams named for the tests: `close` brings the session
/// down (`reconcile::down`); `in_section` runs inside the one store section,
/// once after the owner decision and once after the claim (a test barrier;
/// `|_| {}` in production); `forget` deletes the row (`Store::delete_project`).
fn delete_with(
    id: &str,
    close: impl FnOnce(&store::Project) -> Result<(), String>,
    mut in_section: impl FnMut(DeletePhase),
    forget: impl FnOnce(&mut Store, &str) -> Result<bool, String>,
) -> Result<Value, String> {
    let project = with_store(|store| store.project(id))?
        .ok_or_else(|| format!("no project with id '{id}'"))?;
    // Down FIRST: killing the session while its declaration still exists is
    // what `down` is for, and it keeps the reconciler from re-creating windows
    // for a project that is about to vanish. And down MUST succeed before
    // anything is forgotten: a session that survives with its homes deleted
    // and its row gone is an untracked session full of windows nobody owns,
    // which `auto_adopt_once` re-adopts as a NEW project within 120 s —
    // delete would resurrect what it was asked to forget. (`down` is Ok when
    // the session is already gone.) Outside the store lock: it is tmux.
    close(&project).map_err(|e| format!("'{}' was not deleted — its session did not go down: {e}", project.name))?;
    // The homes live in the DIRECTORY (`<path>/.tmm/agents/`), and several
    // projects may declare one directory (`create` keeps them separate). While
    // another project — archived ones included, they are still declared —
    // names the same directory, or its path cannot be resolved, the homes are
    // (or may be) its too: they are kept and the answer says for whom (board
    // #415: a stale probe project on this repo's own path would have deleted
    // every live agent's home here).
    //
    // ONE store section checks, decides and claims (board #415 review P1-B):
    // it rereads the target, reads the other declarations, forgets the row,
    // and — with no other owner — RENAMES the agents dir to a staging name.
    // Every declaration writer (create, adopt, rename) takes the same lock,
    // so one that committed before the section is seen, and one that commits
    // after it finds no agents dir: nothing it declares can be removed below.
    // The recursive delete of the staging dir runs after the lock.
    let agents_root = std::path::Path::new(&project.path).join(".tmm").join("agents");
    let (deleted, kept, staged, mut error) = with_store(|store| {
        // What was closed must still be what is deleted (review round 2,
        // P1): a rename between the read and here moved the session, so the
        // close above closed a name the project no longer has — its renamed
        // session may be running. Changed or gone: nothing is removed.
        match store.project(id)? {
            None => return Err(format!("'{}' was deleted by someone else while this delete ran; nothing removed", project.name)),
            Some(now) if now.session != project.session || now.path != project.path => {
                return Err(format!(
                    "'{}' changed while it was being deleted (session {} → {}, path {} → {}); nothing removed — run delete again",
                    project.name, project.session, now.session, project.path, now.path
                ))
            }
            Some(_) => {}
        }
        let kept: Vec<Value> = store
            .list_projects(true)?
            .into_iter()
            .filter(|p| p.id != project.id)
            .filter_map(|p| match same_dir(&p.path, &project.path) {
                Some(true) => Some(json!({ "project": p.name, "reason": "declared" })),
                Some(false) => None,
                None => Some(json!({ "project": p.name, "reason": "unresolved" })),
            })
            .collect();
        in_section(DeletePhase::Decided);
        // The row first: a failed forget stages nothing.
        let deleted = forget(store, id)?;
        let (mut staged, mut error) = (None, None);
        if kept.is_empty() {
            let staging = agents_root.with_file_name(format!("agents.deleting-{id}-{}", now()));
            match std::fs::rename(&agents_root, &staging) {
                Ok(()) => staged = Some(staging),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                // The row is gone and the homes stay where they were: an
                // orphan home is harmless, a lost one is not.
                Err(e) => error = Some(format!("homes kept in {}: {e}", agents_root.display())),
            }
        }
        in_section(DeletePhase::Claimed);
        Ok((deleted, kept, staged, error))
    })?;
    // Outside the lock: remove each staged home, counting only what is gone.
    let mut homes_removed = 0usize;
    let mut left_in = None;
    if let Some(staging) = staged {
        let mut failures = Vec::new();
        match std::fs::read_dir(&staging) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let home = entry.file_type().is_ok_and(|t| t.is_dir());
                    let gone = if home { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                    match gone {
                        Ok(()) => homes_removed += usize::from(home),
                        Err(e) => failures.push(format!("{}: {e}", path.display())),
                    }
                }
            }
            Err(e) => failures.push(format!("{}: {e}", staging.display())),
        }
        if failures.is_empty() {
            if let Err(e) = std::fs::remove_dir(&staging) {
                failures.push(format!("{}: {e}", staging.display()));
            }
        }
        if !failures.is_empty() {
            error = Some(format!("not everything was removed; what is left is in {}: {}", staging.display(), failures.join("; ")));
            left_in = Some(staging.to_string_lossy().into_owned());
        }
    }
    let mut answer = json!({ "id": id, "deleted": deleted, "agent_homes_removed": homes_removed, "agent_homes_kept_for": kept });
    if let Some(e) = error {
        answer["agent_homes_error"] = json!(e);
    }
    if let Some(dir) = left_in {
        answer["agent_homes_left_in"] = json!(dir);
    }
    Ok(answer)
}

/// Do two declared paths name one directory? `Some` when both resolve:
/// canonical paths (symlinks, `.`/`..`, a relative spelling all resolved),
/// and a path that does not exist (`NotFound`, or a component that is a file)
/// compares as written, minus a
/// trailing `/` — it has no reachable homes to lose. `None` when either
/// path's resolution FAILED otherwise (permission, a symlink loop, I/O):
/// unknown, which the caller treats as "may be the same" and keeps the homes
/// (board #415 review P2-C).
fn same_dir(a: &str, b: &str) -> Option<bool> {
    fn norm(p: &str) -> Option<String> {
        match std::fs::canonicalize(p) {
            Ok(c) => Some(c.to_string_lossy().into_owned()),
            // A component that is not there, or is a file: the path cannot exist.
            Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => Some(p.trim_end_matches('/').to_string()),
            Err(_) => None,
        }
    }
    Some(norm(a)? == norm(b)?)
}

pub fn set_autostart(id: &str, autostart: bool) -> Result<Value, String> {
    with_store(|store| {
        store.set_autostart(id, autostart)?;
        Ok(json!({ "id": id, "autostart": autostart }))
    })
}

/// Project row for a session (used by spawn to find the workspace).
/// The project a session name refers to. Falls back to the name the session
/// used to have, because a running agent carries `TMM_PROJECT` from the moment
/// it started: after a rename its `tmm send/status/done` would otherwise fail
/// until someone restarted it, which is not a thing a rename should cost.
pub fn project_for_session(session: &str) -> Result<Option<store::Project>, String> {
    with_store(|store| {
        if let Some(p) = store.project_by_session(session)? {
            return Ok(Some(p));
        }
        store.project_by_prev_session(session)
    })
}

/// Which row `project_for_session` answers with, and by which column (board
/// #421: a rig's project read `/tmp`; this tells its own row from another
/// test's row reached by a session or a previous-session name).
#[cfg(test)]
pub fn project_match(session: &str) -> Result<String, String> {
    with_store(|store| {
        let (how, found) = match store.project_by_session(session)? {
            Some(p) => ("session", Some(p)),
            None => ("prev_session", store.project_by_prev_session(session)?),
        };
        Ok(match found {
            None => "none".to_string(),
            Some(p) => format!(
                "by {how}: id={} name={} session={} prev_session={:?} path={} created_at={}",
                p.id,
                p.name,
                p.session,
                store.prev_session(&p.id)?,
                p.path,
                p.created_at
            ),
        })
    })
}

pub(super) fn load(id: &str) -> Result<(Project, Vec<Slot>), String> {
    with_store(|store| {
        let project = store
            .project(id)?
            .ok_or_else(|| format!("no such project: {id}"))?;
        let slots = store.slots(id)?;
        Ok((project, slots))
    })
}

/// A session name that is free both in tmux and in the store.
pub(super) fn free_session_name(store: &Store, base: &str, id: &str) -> Result<String, String> {
    // The scratch terminal's name is taken whether or not a session is running
    // under it (board #337): a DECLARATION on that name is what made `owned()`
    // answer `Taken` forever, so `create` must suffix past it even when
    // nothing is live. This is the one place create/rename ask.
    if !super::scratch::reserved(base) && !tmux::session_exists(base) && !store.session_taken_by_other(base, id)? {
        return Ok(base.to_string());
    }
    let suffixed = format!("{base}-{}", digest(id));
    Ok(suffixed)
}

/// The working directory a session represents.
///
/// NOT simply the active pane's cwd: the window that happens to be focused is
/// often a shell parked in `$HOME`, which says nothing about the workspace (a
/// real case: a session whose second window ran an agent in
/// `~/work/poc/260728-ds160` while the focused first window sat in `$HOME`).
///
/// The session's own `#{session_path}` comes first (board #421): it is the
/// directory the session was made in, while a pane's cwd is its foreground
/// process's at the instant of the read — a dsh rig adopted right after its
/// `new-session -c <ws>` got a project at `<ws>/.tmm/agents/d1/dsh` once and
/// at `/tmp` once. A session made in `$HOME` (`tmux new` from a fresh terminal) says
/// nothing about its workspace either, so then every window is asked and
/// `pick_workspace` decides.
pub(super) fn session_workspace(session: &str) -> Result<String, String> {
    let declared = tmux::session_path(session)?;
    let panes = tmux::list_panes(session)?;
    let mut cwds: Vec<(usize, String)> = Vec::new();
    for pane in &panes {
        if pane.current_path.is_empty() || cwds.iter().any(|(w, _)| *w == pane.window) {
            continue;
        }
        // One vote per window, from its active pane where there is one.
        if !pane.active && panes.iter().any(|p| p.window == pane.window && p.active) {
            continue;
        }
        cwds.push((pane.window, pane.current_path.clone()));
    }
    cwds.sort_by_key(|(w, _)| *w);
    let ordered: Vec<String> = cwds.into_iter().map(|(_, p)| p).collect();
    choose_workspace(&declared, &ordered, &tmux::home_dir())
        .ok_or_else(|| format!("cannot determine a directory for session {session}"))
}

/// The session's own path when it declares a workspace, else the windows'
/// verdict (`pick_workspace`).
pub(super) fn choose_workspace(declared: &str, cwds: &[String], home: &str) -> Option<String> {
    if declares_workspace(declared, home) {
        return Some(declared.to_string());
    }
    pick_workspace(cwds, home)
}

/// Whether a session's `#{session_path}` names its workspace: an existing
/// directory that is known NOT to be `$HOME` (a parked start says nothing, as
/// in `pick_workspace`).
pub(super) fn declares_workspace(declared: &str, home: &str) -> bool {
    !declared.is_empty() && std::path::Path::new(declared).is_dir() && known_not_home(declared, home)
}

/// The one test of "this directory is not `$HOME`", for a session's path and
/// for every window's cwd alike: by directory identity (`same_dir`), never by
/// spelling. On this host `$HOME` is `/home/cfu` and its canonical path
/// `/local/home/cfu`, which is what a pane's cwd reads (#421 review P1-A,
/// #427). A comparison that cannot be resolved is not known to be anything
/// else, so it counts as `$HOME`: it never outranks a real workspace.
fn known_not_home(path: &str, home: &str) -> bool {
    same_dir(path, home) == Some(false)
}

/// Choose the directory that best represents a set of window cwds.
///
/// Most frequent wins; `$HOME` only wins when nothing else is on offer (a
/// parked shell is not a workspace), and is recognised by directory identity
/// under any spelling (`known_not_home`, #427); ties break toward the shortest path, which
/// is the one closest to a project root when windows sit in sibling subdirs.
pub(super) fn pick_workspace(cwds: &[String], home: &str) -> Option<String> {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for cwd in cwds {
        match counts.iter_mut().find(|(p, _)| *p == cwd.as_str()) {
            Some((_, n)) => *n += 1,
            None => counts.push((cwd.as_str(), 1)),
        }
    }
    let best = |only_non_home: bool| -> Option<&str> {
        counts
            .iter()
            .filter(|(p, _)| !only_non_home || known_not_home(p, home))
            .copied()
            .reduce(|a, b| {
                if b.1 > a.1 || (b.1 == a.1 && b.0.len() < a.0.len()) {
                    b
                } else {
                    a
                }
            })
            .map(|(p, _)| p)
    };
    best(true).or_else(|| best(false)).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::super::tests::use_test_store;
    use super::*;

    #[test]
    fn the_session_follows_the_project_name_not_the_folder() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-name-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        // A name given, no session: BOTH follow the name. The folder name is a
        // fallback, never a winner — it produced projects called "src-tauri"
        // and sessions called "tmp" (owner reports).
        let made = create(&path, Some("Close Test"), None, None).unwrap();
        assert_eq!(made.get("name").and_then(|v| v.as_str()), Some("Close Test"));
        // slug() lowercases and hyphenates — a tmux session name, not a label.
        assert_eq!(made.get("session").and_then(|v| v.as_str()), Some("close-test"));

        // An explicit session still wins over the name.
        let other = std::env::temp_dir().join(format!("tmm-name-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&other).unwrap();
        let made2 = create(&other.to_string_lossy(), Some("Label"), Some("chosen"), None).unwrap();
        assert_eq!(made2.get("session").and_then(|v| v.as_str()), Some("chosen"));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// Renaming moves the label AND the tmux session, because the session name
    /// is what the Terminal and `tmux ls` show — leaving it behind made one
    /// project wear two names (owner, 2026-08-19). Two things must NOT move with
    /// it: the chat room (the conversation would be orphaned) and the old
    /// session's resolvability (a running agent carries `TMM_PROJECT` from the
    /// moment it started).
    #[test]
    fn renaming_a_project_moves_its_session_but_never_its_room() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-rename-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let made = create(&dir.to_string_lossy(), Some("Old Name"), None, None).unwrap();
        let id = made["id"].as_str().unwrap().to_string();
        let born_session = made["session"].as_str().unwrap().to_string();
        assert_eq!(born_session, "old-name");
        let room = with_store(|s| s.project(&id)).unwrap().unwrap().room;
        assert_eq!(room, format!("proj:{born_session}"), "the room is frozen at birth");

        let out = rename(&id, "  New Name  ").unwrap();
        assert_eq!(out["name"].as_str(), Some("New Name"), "trimmed");
        assert_eq!(out["session"].as_str(), Some("new-name"), "the session follows the name");
        let after = with_store(|store| store.project(&id)).unwrap().unwrap();
        assert_eq!(after.name, "New Name");
        assert_eq!(after.session, "new-name");
        assert_eq!(after.path, made["path"].as_str().unwrap());
        // The conversation stays where it is. This is the whole reason the room
        // is a column instead of `proj:<session>`.
        assert_eq!(after.room, room, "the chat must not move with the name");

        // A name another project holds is REFUSED, not decorated — including when
        // that project is archived and therefore invisible in the list.
        let other = std::env::temp_dir().join(format!("tmm-rename-other-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&other).unwrap();
        let taken = create(&other.to_string_lossy(), Some("Taken Name"), None, None).unwrap();
        set_archived(taken["id"].as_str().unwrap(), true).unwrap();
        let err = rename(&id, "Taken Name").expect_err("a taken session must not be decorated");
        assert!(err.contains("archived"), "the message must explain WHY: {err}");
        assert!(err.contains("taken-name"), "and name the session: {err}");
        let untouched = with_store(|s| s.project(&id)).unwrap().unwrap();
        assert_eq!(untouched.session, "new-name", "a refused rename changes nothing");
        assert_eq!(untouched.name, "New Name", "…including the label: no half-applied rename");
        let _ = std::fs::remove_dir_all(&other);

        // A caller that DECIDED from an earlier read carries the session it
        // decided about, and the rename refuses once the row has moved on
        // since — the previous name still RESOLVES through the alias below,
        // and must not satisfy the expectation (board #337 review P1-a).
        // Without this precondition the rename succeeds, which is how the
        // scratch release could rename a project the reader had just named.
        let stale = rename_if_session(&id, Some(&born_session), "Decided Elsewhere")
            .expect_err("the row no longer declares the session the caller decided about");
        // STALE, not a failure: nothing was written, and the caller's
        // confirmation has simply expired — which is what earns the panel's
        // re-ask and its own wire code instead of an error sentence (review,
        // 19:23: this refusal used to arrive as a plain internal error).
        assert!(matches!(stale, Refused::Stale(_)), "{stale:?}");
        assert!(stale.text().contains(&born_session), "the message names the session: {stale:?}");
        let intact = with_store(|s| s.project(&id)).unwrap().unwrap();
        assert_eq!(intact.name, "New Name", "nothing was renamed");
        assert_eq!(intact.session, "new-name");
        // A row that VANISHED under an expectation is the same expired
        // confirmation (deleted between the decision and the write); with no
        // expectation carried in, a missing id is a plain failure.
        let deleted = rename_if_session("no-such-row", Some("whatever"), "Name").expect_err("no row");
        assert!(matches!(deleted, Refused::Stale(_)), "{deleted:?}");
        let plain = rename_if_session("no-such-row", None, "Name").expect_err("no row");
        assert!(matches!(plain, Refused::Failed(_)), "{plain:?}");
        assert_eq!(rename("no-such-row", "Name").unwrap_err(), plain.text(), "and `rename` shows the same sentence");
        // The same expectation, met, renames exactly as `rename` does.
        let kept = rename_if_session(&id, Some("new-name"), "New Name").expect("the expectation holds");
        assert_eq!(kept["session"].as_str(), Some("new-name"));

        // The old name still resolves, so an agent started before the rename can
        // keep using the TMM_PROJECT it was launched with.
        let via_old = project_for_session(&born_session).unwrap();
        assert_eq!(via_old.map(|p| p.id), Some(id.clone()), "previous session name resolves");
        assert_eq!(project_for_session("new-name").unwrap().map(|p| p.id), Some(id.clone()));

        // An empty name is a mistake, not a way to clear the label.
        assert!(rename(&id, "   ").is_err());
        assert_eq!(with_store(|store| store.project(&id)).unwrap().unwrap().name, "New Name");
        assert!(rename("no-such-project", "x").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An ADOPTED project is renamed like any other. `adopted` is set by
    /// `auto_adopt_once` for every session the app finds untracked, so treating
    /// it as "a human named this" made the rename a no-op on most real projects.
    #[test]
    fn an_adopted_project_is_renamed_like_any_other() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-rename-adopted-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ts = now();
        let project = Project {
            id: "adopted-1".into(),
            name: "mine".into(),
            path: dir.to_string_lossy().to_string(),
            icon: None,
            session: "hand-made".into(),
            adopted: true,
            autostart: false,
            created_at: ts,
            last_up_at: None,
            last_seen_at: None,
            archived: false,
            room: String::new(),
        };
        with_store(|store| store.insert_project(&project)).unwrap();
        let issue = board_save(
            "hand-made",
            None,
            Some("board follows rename"),
            Some("private to this project"),
            None,
            None,
            "human",
        ).unwrap();
        board_note("hand-made", issue, "human", "keep the thread").unwrap();

        let out = rename("adopted-1", "A Better Label").unwrap();
        assert_eq!(out["name"].as_str(), Some("A Better Label"));
        assert_eq!(out["session"].as_str(), Some("a-better-label"), "adopted renames too");
        assert_eq!(out["session_renamed"].as_bool(), Some(true));
        let after = with_store(|store| store.project("adopted-1")).unwrap().unwrap();
        assert_eq!(after.session, "a-better-label");
        assert_eq!(after.name, "A Better Label");
        // The old name still resolves, and the room never moved.
        assert_eq!(
            project_for_session("hand-made").unwrap().map(|p| p.id).as_deref(),
            Some("adopted-1"),
        );
        assert_eq!(after.room, "proj:hand-made");
        let moved = board_get("a-better-label", issue).expect("the Board follows the current session name");
        assert_eq!(moved["title"], "board follows rename");
        assert_eq!(moved["notes"].as_array().unwrap().len(), 1);
        assert!(board_get("hand-made", issue).is_err(), "the raw old Board key no longer owns rows");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_projects_can_share_one_directory() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-share-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        // Identity is the SESSION, not the path: a second create at the same
        // directory with a different name is a NEW project, not a merge into
        // the first (owner report, 2026-08-19).
        let a = create(&path, Some("alpha-proj"), None, None).unwrap();
        let b = create(&path, Some("beta-proj"), None, None).unwrap();
        assert_ne!(
            a.get("id").and_then(|v| v.as_str()),
            b.get("id").and_then(|v| v.as_str()),
            "same path, different name → two projects"
        );
        assert_eq!(b.get("name").and_then(|v| v.as_str()), Some("beta-proj"));
        assert_eq!(b.get("session").and_then(|v| v.as_str()), Some("beta-proj"));

        // The literal same request IS idempotent: same wanted session + same
        // path returns the existing row instead of a duplicate.
        let a2 = create(&path, Some("alpha-proj"), None, None).unwrap();
        assert_eq!(
            a.get("id").and_then(|v| v.as_str()),
            a2.get("id").and_then(|v| v.as_str()),
            "same session + same path → the same project"
        );

        // Same name + same path a THIRD way: even when the id seed collides,
        // the salt keeps ids unique — session name gets suffixed, not merged.
        let other = std::env::temp_dir().join(format!("tmm-share-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&other).unwrap();
        let c = create(&path, Some("alpha-proj"), Some("alpha-two"), None).unwrap();
        assert_ne!(
            a.get("id").and_then(|v| v.as_str()),
            c.get("id").and_then(|v| v.as_str()),
            "explicit different session at the same path → a third project"
        );
        assert_eq!(c.get("session").and_then(|v| v.as_str()), Some("alpha-two"));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn delete_forgets_the_project_and_its_agent_homes_but_not_your_files() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-del-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // A file of the user's, and an agent home of ours.
        std::fs::write(dir.join("keep-me.txt"), "mine").unwrap();
        let home = dir.join(".tmm").join("agents").join("lead");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), "{}").unwrap();

        let path = dir.to_string_lossy().to_string();
        let made = create(&path, Some("deltest"), None, None).unwrap();
        let id = made.get("id").and_then(|v| v.as_str()).unwrap().to_string();
        let session = made.get("session").and_then(|v| v.as_str()).unwrap().to_string();
        let issue = board_save(&session, None, Some("delete with project"), None, None, None, "human").unwrap();
        board_note(&session, issue, "human", "this task is project state").unwrap();

        let r = delete(&id).unwrap();
        assert_eq!(r.get("deleted").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(r.get("agent_homes_removed").and_then(|v| v.as_u64()), Some(1));
        assert!(!home.exists(), "the agent's isolated home is gone");
        assert!(dir.join("keep-me.txt").is_file(), "the user's files are untouched");
        // Gone from the store even with archived rows included: delete is not
        // archive.
        let listed = list(true).unwrap();
        let ids: Vec<String> = listed
            .get("projects").and_then(|v| v.as_array()).unwrap()
            .iter()
            .filter_map(|p| p.get("id").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        assert!(!ids.contains(&id), "delete removes the row: {ids:?}");
        assert!(board_get(&session, issue).is_err(), "permanent delete releases the session with no old Board to inherit");
        // Deleting twice is an error, not a silent success — the caller asked
        // about a project that no longer exists.
        assert!(delete(&id).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory holding one agent home, `builder`, for the #415 tests.
    fn dir_with_a_home(tag: &str) -> (std::path::PathBuf, std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("tmm-del-{tag}-{}", uuid::Uuid::new_v4()));
        let home = dir.join(".tmm").join("agents").join("builder");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), "{}").unwrap();
        let path = dir.canonicalize().unwrap().to_string_lossy().to_string();
        (dir, home, path)
    }

    fn id_of(v: &Value) -> String {
        v.get("id").and_then(|v| v.as_str()).unwrap().to_string()
    }

    /// Board #415: agent homes belong to the DIRECTORY, so deleting one of two
    /// projects declared on it (the other archived, which is still declared)
    /// forgets only its row and keeps every home, naming who keeps them; the
    /// last project on the directory takes them with it.
    #[test]
    fn delete_keeps_the_homes_while_another_project_declares_the_directory() {
        use_test_store();
        let (dir, home, path) = dir_with_a_home("shared");
        let live = id_of(&create(&path, Some("realproj"), Some("realproj"), None).unwrap());
        let stale = id_of(&create(&path, Some("stale probe"), Some("staleprobe"), None).unwrap());
        assert_ne!(live, stale, "two projects on one path are two projects");
        set_archived(&live, true).unwrap();

        let r = delete(&stale).unwrap();
        assert_eq!(r.get("deleted").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(r.get("agent_homes_removed").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(r["agent_homes_kept_for"], json!([{ "project": "realproj", "reason": "declared" }]), "the answer names who keeps them");
        assert!(home.join("launch.json").is_file(), "the other project's agent home is intact");

        let r = delete(&live).unwrap();
        assert_eq!(r.get("agent_homes_removed").and_then(|v| v.as_u64()), Some(1), "the last one takes them");
        assert_eq!(r["agent_homes_kept_for"], json!([]));
        assert!(!home.exists());
        let leftovers: Vec<_> = std::fs::read_dir(dir.join(".tmm")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert!(leftovers.is_empty(), "the staging dir is removed too: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review P1-A: the session goes down FIRST, for real, and a close that is
    /// refused deletes nothing — not the homes, not the row.
    #[test]
    fn delete_closes_the_real_session_first_and_a_refused_close_deletes_nothing() {
        // The session is the one `create` answers (it slugs to 24
        // characters), killed on drop, also on a panic.
        struct Kill(String);
        impl Drop for Kill {
            fn drop(&mut self) {
                let _ = tmux::kill_session(&self.0);
            }
        }
        use_test_store();
        let (dir, home, path) = dir_with_a_home("close");
        let made = create(&path, Some("delclose"), Some(&format!("dc{}", std::process::id())), None).unwrap();
        let id = id_of(&made);
        let session = made["session"].as_str().unwrap().to_string();
        let _kill = Kill(session.clone());
        tmux::ensure_session(&session, &path).unwrap();
        assert!(tmux::session_exists(&session));

        let refused = delete_with(&id, |_| Err("tmux said no".into()), |_| {}, |st: &mut Store, id: &str| st.delete_project(id));
        assert!(refused.as_ref().is_err_and(|e| e.contains("its session did not go down: tmux said no")), "{refused:?}");
        assert!(home.join("launch.json").is_file(), "a refused close removes no home");
        assert!(with_store(|st| st.project(&id)).unwrap().is_some(), "and forgets no row");
        assert!(tmux::session_exists(&session));

        let r = delete(&id).unwrap();
        assert_eq!(r.get("deleted").and_then(|v| v.as_bool()), Some(true));
        assert!(!tmux::session_exists(&session), "delete brought the real session down");
        assert!(!home.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review P1-B: the owner decision and the claim are one store section.
    /// A project declared on the same directory BEFORE it (here, while the
    /// session goes down) is an owner and keeps the homes. A create started
    /// between the decision and the claim must WAIT for the claim: it returns
    /// only once the homes are moved away, so it starts with no agents dir
    /// and declares nothing that was removed. A delete whose decision were a
    /// snapshot would let that create finish in between — it would see the
    /// homes, and then lose them.
    #[test]
    fn a_declaration_racing_a_delete_is_counted_or_finds_no_homes_to_lose() {
        use_test_store();
        // Before the section: counted.
        let (dir, home, path) = dir_with_a_home("race-before");
        let id = id_of(&create(&path, Some("first"), Some("racefirst"), None).unwrap());
        let r = delete_with(&id, |_| create(&path, Some("early"), Some("raceearly"), None).map(|_| ()), |_| {}, |st: &mut Store, id: &str| st.delete_project(id)).unwrap();
        assert_eq!(r["agent_homes_kept_for"], json!([{ "project": "early", "reason": "declared" }]), "{r}");
        assert!(home.join("launch.json").is_file());
        let _ = std::fs::remove_dir_all(&dir);

        // Waiting on the store while the section runs: after it.
        let (dir, home, path) = dir_with_a_home("race-during");
        let id = id_of(&create(&path, Some("second"), Some("racesecond"), None).unwrap());
        let late = std::sync::Mutex::new(None);
        let returned = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let section = std::cell::Cell::new(None);
        let r = delete_with(&id, |_| Ok(()), |phase| match phase {
            // Round 4 (validator on a662aca0: the old barrier let a split
            // section through 2 times in 5). Observable, not timed: the
            // decision runs INSIDE a store section; the create announces
            // itself before it asks for the store; and after the claim, still
            // in the SAME section, the create has not returned. A claim in a
            // second section fails the first assertion every time.
            DeletePhase::Decided => {
                let s = super::super::tests::current_section();
                assert!(s.is_some(), "the owner decision runs inside a store section");
                section.set(s);
                let (tx, rx) = std::sync::mpsc::channel();
                let (p, h, done) = (path.clone(), home.clone(), returned.clone());
                let t = std::thread::spawn(move || {
                    tx.send(()).unwrap();
                    let made = create(&p, Some("late"), Some("racelate"), None);
                    done.store(true, std::sync::atomic::Ordering::SeqCst);
                    (made, h.exists())
                });
                rx.recv_timeout(std::time::Duration::from_secs(10)).expect("the late create announced itself within 10 s");
                *late.lock().unwrap() = Some(t);
            }
            DeletePhase::Claimed => {
                assert_eq!(super::super::tests::current_section(), section.get(), "the claim is in the same section as the decision");
                assert!(!returned.load(std::sync::atomic::Ordering::SeqCst), "the create has not returned before the claim is done");
            }
        }, |st: &mut Store, id: &str| st.delete_project(id))
        .unwrap();
        let (late, saw_homes) = late.lock().unwrap().take().unwrap().join().unwrap();
        let late = late.unwrap();
        assert!(!saw_homes, "the create waited for the claim: it never saw the homes it would lose");
        assert_eq!(r["agent_homes_kept_for"], json!([]), "it was not declared when the section decided: {r}");
        assert_eq!(r.get("agent_homes_removed").and_then(|v| v.as_u64()), Some(1));
        assert!(!home.exists());
        assert!(!dir.join(".tmm/agents").exists(), "the late project starts with no agents dir");
        assert!(with_store(|st| st.project(&id_of(&late))).unwrap().is_some(), "and its declaration stands");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A session name from `create`'s answer, killed on drop (also on a panic).
    struct KillSession(String);
    impl Drop for KillSession {
        fn drop(&mut self) {
            let _ = tmux::kill_session(&self.0);
        }
    }

    /// Review round 2, P1: what was closed must be what is deleted. A rename
    /// between the read and the section moves the session, so the close
    /// closed a name the project no longer has: the delete refuses, and the
    /// renamed live session keeps its row and its homes. A target that
    /// vanished meanwhile stages nothing.
    #[test]
    fn a_project_renamed_or_gone_while_it_is_deleted_loses_nothing() {
        use_test_store();
        let (dir, home, path) = dir_with_a_home("renamed");
        let made = create(&path, Some("before"), Some(&format!("rb{}", std::process::id())), None).unwrap();
        let id = id_of(&made);
        let old = made["session"].as_str().unwrap().to_string();
        let _k_old = KillSession(old.clone());
        tmux::ensure_session(&old, &path).unwrap();
        let renamed = std::sync::Mutex::new(String::new());
        let refused = delete_with(
            &id,
            |p| {
                rename(&id, &format!("after{}", std::process::id())).unwrap();
                *renamed.lock().unwrap() = with_store(|st| st.project(&id)).unwrap().unwrap().session;
                reconcile::down(p)
            },
            |_| {},
            |st: &mut Store, id: &str| st.delete_project(id),
        );
        let new = renamed.lock().unwrap().clone();
        let _k_new = KillSession(new.clone());
        assert_ne!(new, old, "the rename moved the session");
        assert!(refused.as_ref().is_err_and(|e| e.contains("changed while it was being deleted") && e.contains("nothing removed")), "{refused:?}");
        assert!(tmux::session_exists(&new), "the renamed session is still running");
        assert_eq!(with_store(|st| st.project(&id)).unwrap().map(|p| p.session), Some(new.clone()), "with its row");
        assert!(home.join("launch.json").is_file(), "and its homes");
        let _ = delete(&id);
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, home, path) = dir_with_a_home("gone");
        let id = id_of(&create(&path, Some("gone"), Some("gonebefore"), None).unwrap());
        let refused = delete_with(&id, |_| with_store(|st| st.delete_project(&id)).map(|_| ()), |_| {}, |st: &mut Store, id: &str| st.delete_project(id));
        assert!(refused.as_ref().is_err_and(|e| e.contains("deleted by someone else")), "{refused:?}");
        assert!(home.join("launch.json").is_file(), "nothing staged");
        assert!(!std::fs::read_dir(dir.join(".tmm")).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("agents.deleting")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review round 2, P2-A: each failure says what it left. A forget that
    /// fails stages nothing; a rename that fails keeps the homes where they
    /// were; a staged home that cannot be removed is named, with only what
    /// is really gone counted as removed.
    #[test]
    fn a_delete_that_cannot_finish_says_what_it_left_and_never_overstates() {
        use std::os::unix::fs::PermissionsExt;
        use_test_store();
        let mode = |p: &std::path::Path, m: u32| std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).unwrap();

        let (dir, home, path) = dir_with_a_home("forget");
        let id = id_of(&create(&path, Some("forget"), Some("forgetfails"), None).unwrap());
        let failed = delete_with(&id, |_| Ok(()), |_| {}, |_: &mut Store, _: &str| Err("disk full".to_string()));
        assert!(failed.as_ref().is_err_and(|e| e.contains("disk full")), "{failed:?}");
        assert!(home.join("launch.json").is_file(), "no rename after a failed forget");
        assert!(with_store(|st| st.project(&id)).unwrap().is_some());
        let _ = delete(&id);
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, home, path) = dir_with_a_home("rename");
        let id = id_of(&create(&path, Some("rename"), Some("renamefails"), None).unwrap());
        mode(&dir.join(".tmm"), 0o555);
        let r = delete(&id).unwrap();
        mode(&dir.join(".tmm"), 0o755);
        assert_eq!(r.get("deleted").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(r.get("agent_homes_removed").and_then(|v| v.as_u64()), Some(0));
        assert!(r["agent_homes_error"].as_str().is_some_and(|e| e.contains("homes kept in")), "{r}");
        assert!(home.join("launch.json").is_file(), "the homes stay where they were");
        let _ = std::fs::remove_dir_all(&dir);

        let (dir, _home, path) = dir_with_a_home("cleanup");
        let stuck = dir.join(".tmm/agents/stuck");
        std::fs::create_dir_all(&stuck).unwrap();
        std::fs::write(stuck.join("f"), "x").unwrap();
        mode(&stuck, 0o555);
        let id = id_of(&create(&path, Some("cleanup"), Some("cleanupfails"), None).unwrap());
        let r = delete(&id).unwrap();
        assert_eq!(r.get("agent_homes_removed").and_then(|v| v.as_u64()), Some(1), "only builder is gone: {r}");
        let left = r["agent_homes_left_in"].as_str().unwrap().to_string();
        assert!(r["agent_homes_error"].as_str().is_some_and(|e| e.contains(&left)), "{r}");
        let staged_stuck = std::path::Path::new(&left).join("stuck");
        assert!(staged_stuck.join("f").is_file(), "what is left is where the answer says");
        mode(&staged_stuck, 0o755);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review P2-C: canonical comparison — a symlink alias, a relative
    /// spelling and `..` are the same directory; a missing path compares as
    /// written; a resolution that FAILS (here a symlink loop) is unknown, and
    /// a delete next to such a project keeps the homes, saying why.
    #[test]
    fn same_dir_compares_canonical_paths_and_a_failed_resolution_is_unknown() {
        let dir = std::env::temp_dir().join(format!("tmm-same-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("a")).unwrap();
        let p = dir.join("a").canonicalize().unwrap().to_string_lossy().to_string();
        std::os::unix::fs::symlink(&p, dir.join("alias")).unwrap();
        assert_eq!(same_dir(&p, &dir.join("alias").to_string_lossy()), Some(true), "a symlink alias");
        assert_eq!(same_dir(&p, &format!("{p}/")), Some(true));
        assert_eq!(same_dir(&p, &dir.join("a/../a").to_string_lossy()), Some(true));
        let cwd = std::env::current_dir().unwrap();
        let up = "../".repeat(cwd.components().count().saturating_sub(1));
        let relative = format!("{up}{}", p.trim_start_matches('/'));
        assert!(!relative.starts_with('/'));
        assert_eq!(same_dir(&p, &relative), Some(true), "a relative spelling: {relative}");
        assert_eq!(same_dir(&p, &dir.to_string_lossy()), Some(false));
        assert_eq!(same_dir("/gone/x/", "/gone/x"), Some(true), "a missing path compares as written");
        assert_eq!(same_dir("/gone/x", "/gone/y"), Some(false));
        std::fs::write(dir.join("file"), "").unwrap();
        let under_a_file = dir.join("file/x").to_string_lossy().to_string();
        assert_eq!(same_dir(&under_a_file, &p), Some(false), "under a file is missing, not unknown");
        std::os::unix::fs::symlink(dir.join("loop"), dir.join("loop")).unwrap();
        let looped = dir.join("loop").to_string_lossy().to_string();
        assert!(std::fs::canonicalize(&looped).is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound), "a real failure, not a missing path");
        assert_eq!(same_dir(&p, &looped), None, "a failed resolution is unknown");
        assert_eq!(same_dir(&looped, &p), None);

        use_test_store();
        let (home_dir, home, path) = dir_with_a_home("unresolved");
        let id = id_of(&create(&path, Some("victim"), Some("unresolvedvictim"), None).unwrap());
        // A declared project whose path no longer resolves (create would
        // refuse it now, so the row is written directly).
        let odd = uuid::Uuid::new_v4().to_string();
        with_store(|st| {
            let mut row = st.project(&id)?.unwrap();
            row.id = odd.clone();
            row.name = "odd".into();
            row.session = format!("unresolvedodd-{}", &odd[..8]);
            row.room = String::new();
            row.path = looped.clone();
            st.insert_project(&row)
        })
        .unwrap();
        let r = delete(&id).unwrap();
        assert_eq!(r["agent_homes_kept_for"], json!([{ "project": "odd", "reason": "unresolved" }]));
        assert!(home.join("launch.json").is_file(), "unknown ownership keeps the homes");
        let _ = delete(&odd);
        let _ = std::fs::remove_dir_all(&home_dir);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workspace_is_the_directory_the_windows_agree_on() {
        let home = "/Users/me";
        // The focused window sits in $HOME, the work happens elsewhere: the
        // real session that exposed this bug.
        assert_eq!(
            pick_workspace(&["/Users/me".into(), "/Users/me/work/poc/ds160".into()], home).as_deref(),
            Some("/Users/me/work/poc/ds160"),
        );
        // Nothing but $HOME on offer — then $HOME is the honest answer.
        assert_eq!(
            pick_workspace(&["/Users/me".into(), "/Users/me".into()], home).as_deref(),
            Some("/Users/me"),
        );
        // Majority wins over a single deeper window.
        assert_eq!(
            pick_workspace(
                &["/w/app".into(), "/w/app".into(), "/w/app/packages/api".into()],
                home
            )
            .as_deref(),
            Some("/w/app"),
        );
        // All different: the shortest is the one closest to a project root.
        assert_eq!(
            pick_workspace(&["/w/app/api".into(), "/w/app".into(), "/w/app/web".into()], home)
                .as_deref(),
            Some("/w/app"),
        );
        assert_eq!(pick_workspace(&[], home), None);
    }

    /// Board #427: a window parked in `$HOME` is `$HOME` under any spelling.
    /// A pane's cwd is the physical path (`/proc/<pid>/cwd`), while `$HOME`
    /// may be a symlink to it (this host: `/home/cfu` → `/local/home/cfu`):
    /// compared as strings, the parked window tied the project window 1:1
    /// and won the tie by coming first. Real directories here.
    #[test]
    fn a_parked_window_is_home_under_any_spelling() {
        let fx = std::env::temp_dir().join(format!("tmm-427-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(fx.join("home")).unwrap();
        std::fs::create_dir_all(fx.join("proj")).unwrap();
        let fx = fx.canonicalize().unwrap();
        std::os::unix::fs::symlink(fx.join("home"), fx.join("home-alias")).unwrap();
        std::os::unix::fs::symlink(fx.join("loop"), fx.join("loop")).unwrap();
        let s = |p: &str| fx.join(p).to_string_lossy().to_string();
        let (home, alias, proj, looped) = (s("home"), s("home-alias"), s("proj"), s("loop"));
        assert_eq!(pick_workspace(&[home.clone(), proj.clone()], &alias).as_deref(), Some(proj.as_str()), "the physical cwd of a symlinked $HOME");
        assert_eq!(pick_workspace(&[alias.clone(), proj.clone()], &home).as_deref(), Some(proj.as_str()), "a cwd spelled by the alias");
        assert_eq!(pick_workspace(&[format!("{home}/"), proj.clone()], &alias).as_deref(), Some(proj.as_str()));
        assert_eq!(pick_workspace(&[home.clone(), home.clone()], &alias).as_deref(), Some(home.as_str()), "nothing else on offer: $HOME is the answer");
        assert_eq!(same_dir(&looped, &home), None, "the fixture's comparison is unresolvable");
        assert_eq!(pick_workspace(&[looped.clone(), proj.clone()], &home).as_deref(), Some(proj.as_str()), "an unresolvable cwd never outranks a workspace");
        let _ = std::fs::remove_dir_all(&fx);
    }

    /// Board #421: a session is adopted at the directory it was made in,
    /// whatever directory its pane's foreground process is in at the instant
    /// of the read. The pane here has gone into its agent's home (where a
    /// dsh rig's project once landed); the project is still the session's
    /// path. A start in `$HOME` (by directory identity, any spelling), an
    /// empty answer or a gone directory says nothing, and the windows are
    /// asked as before.
    #[test]
    fn a_session_is_adopted_at_the_directory_it_was_made_in() {
        // `$HOME` by directory identity, on real directories (review P1-A):
        // a real home, a symlink alias of it, and a project elsewhere.
        let fx = std::env::temp_dir().join(format!("tmm-421-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(fx.join("home")).unwrap();
        std::fs::create_dir_all(fx.join("proj")).unwrap();
        let fx = fx.canonicalize().unwrap();
        std::os::unix::fs::symlink(fx.join("home"), fx.join("home-alias")).unwrap();
        let s = |p: &str| fx.join(p).to_string_lossy().to_string();
        let (home, alias, proj) = (s("home"), s("home-alias"), s("proj"));
        assert!(!declares_workspace(&home, &home), "an existing $HOME");
        assert!(!declares_workspace(&format!("{home}/"), &home));
        assert!(!declares_workspace(&alias, &home), "$HOME under a symlink alias");
        assert!(!declares_workspace(&home, &alias), "$HOME spelled by its alias, the session at its canonical path");
        assert!(!declares_workspace("", &home));
        assert!(!declares_workspace(&s("gone"), &home), "a directory that no longer exists");
        assert!(declares_workspace(&proj, &home));
        assert_eq!(
            choose_workspace(&alias, &[proj.clone()], &home).as_deref(),
            Some(proj.as_str()),
            "a session made in $HOME's alias: the pane in the project decides"
        );
        assert_eq!(choose_workspace(&proj, &[home.clone()], &home).as_deref(), Some(proj.as_str()), "the declaration over a parked pane");
        // Fail closed (validator C2b): a comparison with `$HOME` that cannot
        // be resolved (a symlink loop: same_dir is None) is no declaration,
        // and the pane decides.
        std::os::unix::fs::symlink(fx.join("loop"), fx.join("loop")).unwrap();
        let looped = s("loop");
        assert_eq!(same_dir(&proj, &looped), None, "the fixture's comparison is unresolvable");
        assert!(!declares_workspace(&proj, &looped), "an unresolvable comparison is not a declaration");
        let other = s("other");
        std::fs::create_dir_all(&other).unwrap();
        assert_eq!(choose_workspace(&proj, &[other.clone()], &looped).as_deref(), Some(other.as_str()), "the pane cwd wins");
        let _ = std::fs::remove_dir_all(&fx);

        let home = &tmux::home_dir();
        let mut scratch = tmux::Scratch::new("made-in");
        use_test_store();
        let path = scratch.path();
        assert!(declares_workspace(&path, home));
        let sub = format!("{path}/.tmm/agents/d1/dsh");
        std::fs::create_dir_all(&sub).unwrap();
        let session = &scratch.session("s");
        tmux::ensure_session(session, &path).unwrap();
        tmux::send_command(session, &format!("cd {}", crate::shell::quote_always(&sub))).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while tmux::list_panes(session).unwrap()[0].current_path != sub {
            assert!(std::time::Instant::now() < deadline, "the pane went into {sub}: {:?}", tmux::list_panes(session));
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let adopted = adopt(session, None).unwrap();
        let id = adopted["project"]["id"].as_str().unwrap().to_string();
        assert_eq!(adopted["project"]["path"], path.as_str(), "the session's path, not the pane's cwd");
        delete(&id).unwrap();
    }

    /// Auto-tracking is what makes "every session is a project" true, including
    /// for sessions made outside the app — and it is the migration path for the
    /// ones that already existed. The guards are the interesting part.
    #[test]
    fn auto_track_picks_up_outside_sessions_but_respects_the_guards() {
        let mut scratch = tmux::Scratch::new("auto");
        use_test_store();
        let path = scratch.path();
        let old = &scratch.session("old");
        let fresh = &scratch.session("fresh");
        for s in [old, fresh] {
            tmux::ensure_session(s, &path).unwrap();
        }

        // Pretend `old` has been around long enough; the other was just made.
        // (The tmm-team-* exclusion died with the Team system, board #100 —
        // a leftover session with that name is an ordinary session now.)
        let ts = now();
        let ages: Vec<(String, u64)> = vec![
            (old.to_string(), ts - SESSION_SETTLE_SECS - 1),
            (fresh.to_string(), ts),
        ];
        let adopted = auto_adopt_with(&ages, ts).unwrap();
        assert_eq!(adopted, vec![old.to_string()], "only the settled session");

        // Running again must not duplicate it.
        assert!(auto_adopt_with(&ages, ts).unwrap().is_empty());

        // Removing a project from the list must stick: no re-tracking.
        let id = with_store(|s| Ok(s.project_by_session(old)?.unwrap().id)).unwrap();
        set_archived(&id, true).unwrap();
        assert!(
            auto_adopt_with(&ages, ts).unwrap().is_empty(),
            "an archived project must not come back on the next tick"
        );
    }

    #[test]
    fn two_sessions_in_the_same_directory_are_two_projects() {
        let mut scratch = tmux::Scratch::new("share");
        use_test_store();
        let path = scratch.path();
        let (a, b) = (scratch.session("a"), scratch.session("b"));
        for s in [&a, &b] {
            tmux::ensure_session(s, &path).unwrap();
        }

        let first = adopt(&a, None).unwrap();
        // Used to fail with "<path> is already project ..." — several sessions
        // parked in one directory (typically $HOME) is the normal case.
        let second = adopt(&b, None).unwrap();
        assert_eq!(first["project"]["path"], second["project"]["path"]);
        assert_ne!(first["project"]["id"], second["project"]["id"]);

        let again = adopt(&a, None);
        assert!(
            again.is_err_and(|e| e.contains("already tracked")),
            "the same session twice is the real conflict"
        );
    }

    /// The P0 acceptance criterion, end to end against a real tmux server:
    /// adopt a session the user made, kill it, and get it back.
    ///
    #[test]
    fn adopt_then_down_then_up_restores_the_workspace() {
        let mut scratch = tmux::Scratch::new("e2e");
        use_test_store();
        let path = scratch.path();
        std::fs::create_dir_all(format!("{path}/api")).unwrap();
        let session = &scratch.session("s");

        tmux::ensure_session(session, &path).unwrap();
        tmux::rename_window(&format!("{session}:^"), "editor").unwrap();
        tmux::new_named_window(session, "api", &format!("{path}/api")).unwrap();

        let adopted = adopt(session, None).unwrap();
        let id = adopted["project"]["id"].as_str().unwrap().to_string();
        let slots = adopted["slots"].as_array().unwrap();
        assert_eq!(slots.len(), 2, "both live windows became slots: {slots:?}");
        assert!(
            slots.iter().all(|s| s["settled_at"].is_number()),
            "adopted windows are restorable immediately: {slots:?}"
        );
        let api = slots
            .iter()
            .find(|s| s["window_name"] == "api")
            .expect("api slot");
        assert_eq!(api["cwd"], "api", "cwd is stored relative to the project");

        // The board lists it as a project, which is what removes it from the
        // client's session list.
        let listed = list(false).unwrap();
        assert_eq!(
            listed["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["project"]["id"] == id.as_str())
                .map(|e| e["live"].as_bool().unwrap()),
            Some(true)
        );

        down(&id).unwrap();
        assert!(!tmux::session_exists(session), "down kills the session");
        // Board #422: the down is a durable intent, kept until a successful up.
        assert!(with_store(|s| s.restore_intents()).unwrap().down.contains(&id), "down records the intent");
        with_store(|s| s.set_slot_stopped(&id, "editor")).unwrap();
        with_store(|s| s.set_slot_stopped(&id, "ghost")).unwrap();

        let report = up(&id).unwrap();
        assert_eq!(report["created_session"], true);
        let intents = with_store(|s| s.restore_intents()).unwrap();
        assert!(!intents.down.contains(&id), "a successful up clears it");
        assert!(!intents.stopped.contains(&(id.clone(), "editor".into())), "and the stop of every window it started");
        assert!(intents.stopped.contains(&(id.clone(), "ghost".into())), "control: a window it did not start keeps its mark");
        let windows: Vec<String> = tmux::list_named_windows(session)
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(windows.len(), 2, "declaration rebuilt the topology: {windows:?}");
        assert!(windows.contains(&"editor".to_string()));
        assert!(windows.contains(&"api".to_string()));

        // Capturing a live project must not disturb a settled declaration.
        capture_once().unwrap();
        assert_eq!(with_store(|s| s.slots(&id)).unwrap().len(), 2);

        // …and it publishes the restore checkpoint for this socket (board
        // #422): the server it saw, and this project with its live windows.
        let cp = with_store(|s| s.checkpoint(&super::super::restore::socket_key())).unwrap().expect("a complete tick publishes");
        assert_eq!(cp.boot_id, super::super::restore::tick_boot());
        let super::super::restore::TmuxNow::Present { instance, .. } = super::super::restore::tmux_now() else { panic!("tmux is up") };
        assert_eq!(cp.tmux.as_ref(), Some(&instance), "the server identity the tick saw");
        let seen = cp.projects.iter().find(|p| p.id == id).expect("the live project is in the checkpoint");
        let mut names: Vec<&str> = seen.windows.iter().map(|w| w.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["api", "editor"]);
        // The next complete tick replaces it with a higher number.
        capture_once().unwrap();
        let next = with_store(|s| s.checkpoint(&super::super::restore::socket_key())).unwrap().unwrap();
        assert_eq!(next.gen, cp.gen + 1);
    }

    /// Board #422 review P1-A: an up clears only the intents that stood when it
    /// BEGAN, and only on success per unit. Through the `up_with` seam (the
    /// reconcile is the barrier): a down and a Stop written while the up runs
    /// survive it; a slot that came up with an error keeps both the project's
    /// down and its own Stop; a clean up clears exactly what it read.
    #[test]
    fn an_up_clears_only_the_intents_it_read_and_only_on_success() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-upv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = id_of(&create(&dir.to_string_lossy(), Some("upv"), Some(&format!("upv{}", std::process::id())), None).unwrap());
        let a = store::Slot { id: None, ord: 0, window_name: "a".into(), cwd: String::new(), kind: store::SlotKind::Agent, command: Some("kiro".into()), auto_run: true, agent_session_id: None, first_seen_at: 1, settled_at: Some(2) };
        let b = store::Slot { window_name: "b".into(), ord: 1, ..a.clone() };
        with_store(|s| s.replace_slots(&id, &[a, b])).unwrap();
        let result = |name: &str, status: &'static str, error: Option<&str>| reconcile::SlotResult { window_name: name.into(), status, error: error.map(str::to_string) };
        let report = |slots: Vec<reconcile::SlotResult>| reconcile::UpReport { session: "s".into(), created_session: true, slots };
        let intents = || with_store(|s| s.restore_intents()).unwrap();
        let stopped = |w: &str| intents().stopped.contains(&(id.clone(), w.to_string()));

        // 1. Nothing stood at the start; a down and a Stop land mid-up: both stand.
        up_with(&id, |_, _| {
            with_store(|s| s.set_project_down(&id)).unwrap();
            with_store(|s| s.set_slot_stopped(&id, "a")).unwrap();
            Ok(report(vec![result("a", "created", None), result("b", "created", None)]))
        })
        .unwrap();
        assert!(intents().down.contains(&id), "a down issued during the up survives it");
        assert!(stopped("a"), "a Stop issued during the up survives it");

        // 2. Both stood at the start, but NEWER versions replace them mid-up: both stand.
        up_with(&id, |_, _| {
            with_store(|s| s.set_project_down(&id)).unwrap();
            with_store(|s| s.set_slot_stopped(&id, "a")).unwrap();
            Ok(report(vec![result("a", "created", None), result("b", "created", None)]))
        })
        .unwrap();
        assert!(intents().down.contains(&id) && stopped("a"), "only the versions read at the start may be cleared");

        // 3. A window created WITH an error: the down and its Stop are kept;
        //    the clean window's Stop goes.
        with_store(|s| s.set_slot_stopped(&id, "b")).unwrap();
        up_with(&id, |_, _| Ok(report(vec![result("a", "created", Some("launch failed")), result("b", "created", None)]))).unwrap();
        assert!(intents().down.contains(&id), "a slot error keeps the project's down");
        assert!(stopped("a"), "created-with-error is not a start");
        assert!(!stopped("b"), "control: the clean window's Stop is cleared");

        // 4. A clean up clears exactly what it read.
        up_with(&id, |_, _| Ok(report(vec![result("a", "existing", None), result("b", "created", None)]))).unwrap();
        assert!(!intents().down.contains(&id) && !stopped("a"));

        let _ = delete(&id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Board #422 review P1 on F3: closing a window from the Sessions page is
    /// ONE operation on ONE window. A lookup tmux cannot answer kills nothing;
    /// a renumber between the lookup and the kill still kills the window whose
    /// Stop was recorded (by its native @id), never the one that now holds the
    /// index; a target already gone is done.
    #[test]
    fn closing_a_window_marks_and_kills_the_same_native_window() {
        let mut scratch = tmux::Scratch::new("close");
        use_test_store();
        let path = scratch.path();
        let session = scratch.session("s");
        std::fs::create_dir_all(format!("{path}/.tmm/agents/dev")).unwrap();
        std::fs::write(format!("{path}/.tmm/agents/dev/launch.json"), "{}").unwrap();
        tmux::ensure_session(&session, &path).unwrap();
        tmux::rename_window(&format!("{session}:^"), "keep").unwrap();
        tmux::new_named_window(&session, "dev", &path).unwrap();
        tmux::new_named_window(&session, "other", &path).unwrap();
        let id = adopt(&session, None).unwrap()["project"]["id"].as_str().unwrap().to_string();
        let stopped = |w: &str| with_store(|s| s.restore_intents()).unwrap().stopped.contains(&(id.clone(), w.to_string()));
        let index_of = |name: &str| tmux::resolve_window(&format!("{session}:{name}")).unwrap().unwrap().index;

        // Renumber between lookup and kill: dev moves away and `other` takes its index.
        let dev_index = index_of("dev");
        let target = format!("{session}:{dev_index}");
        close_window_with(&target, || {}, || {
            tmux::run_tmux(&["move-window", "-s", &format!("={session}:dev"), "-t", &format!("={session}:90")]).unwrap();
            tmux::run_tmux(&["move-window", "-s", &format!("={session}:other"), "-t", &format!("={session}:{dev_index}")]).unwrap();
        })
        .unwrap();
        assert!(stopped("dev"), "the managed window's Stop is recorded");
        assert!(tmux::find_window_by_name(&session, "dev").is_none(), "the recorded window is the one killed");
        assert!(tmux::find_window_by_name(&session, "other").is_some(), "the window now at its index survives");
        assert!(!stopped("other"));

        // Already gone: done, nothing recorded.
        close_window(&format!("{session}:77")).unwrap();
        close_window("@999999").unwrap();
        // A plain window: killed, no Stop (control).
        close_window(&format!("{session}:other")).unwrap();
        assert!(tmux::find_window_by_name(&session, "other").is_none());
        assert!(!stopped("other"));

        // F3 residual: a managed-ness that cannot be READ is not "plain". An
        // unreadable agents dir refuses the close: no kill, no mark.
        use std::os::unix::fs::PermissionsExt;
        tmux::new_named_window(&session, "dev", &path).unwrap();
        let agents = std::path::PathBuf::from(&path).join(".tmm/agents");
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o000)).unwrap();
        let refused = close_window(&format!("{session}:dev"));
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(refused.as_ref().is_err_and(|e| e.contains("cannot be read")), "{refused:?}");
        assert!(tmux::find_window_by_name(&session, "dev").is_some(), "nothing was killed");
        with_store(|s| s.forget_slot_stopped(&id, "dev")).unwrap();
        // The project resolved for the window is the one the Stop is written
        // to: if it no longer declares the session by the time the mark is
        // written, the close is refused — no Stop under another project's key.
        let refused = close_window_with(&format!("{session}:dev"), || {
            with_store(|s| s.set_session(&id, "elsewhere-422", &session)).unwrap();
        }, || {});
        assert!(refused.as_ref().is_err_and(|e| e.contains("project changed")), "{refused:?}");
        assert!(tmux::find_window_by_name(&session, "dev").is_some(), "nothing was killed");
        assert!(!stopped("dev"), "no Stop was written");
        with_store(|s| s.set_session(&id, &session, "elsewhere-422")).unwrap();

        // K4: the window is re-identified just before the kill. Renamed under
        // the close (same @id, another name), it is not the window that was
        // resolved and marked: refused, and it survives.
        let refused = close_window_with(&format!("{session}:dev"), || {}, || {
            tmux::run_tmux(&["rename-window", "-t", &format!("={session}:dev"), "renamed-422"]).unwrap();
        });
        assert!(refused.as_ref().is_err_and(|e| e.contains("changed before it could be closed")), "{refused:?}");
        assert!(tmux::find_window_by_name(&session, "renamed-422").is_some(), "nothing was killed");
        let _ = down(&id);
    }

    /// The other half: a lookup that fails for any reason but "not there" is
    /// an error, and nothing is killed or recorded.
    #[test]
    fn a_window_lookup_tmux_cannot_answer_kills_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let scope = tmux::test_support::GlobalSocket::hold();
        let server = tmux::test_support::PrivateTmux::start(&scope, "close-locked");
        server.run(&["new-session", "-d", "-s", "lock", "-n", "w"]).unwrap();
        let dir = std::env::temp_dir().join(format!("tmm-test-close-locked-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        scope.set(Some(dir.join("x.sock").to_string_lossy().to_string()));
        let got = close_window("lock:w");
        scope.set(Some(server.socket().to_string()));
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(got.as_ref().is_err_and(|e| e.contains("Permission denied")), "{got:?}");
        assert!(server.run(&["has-session", "-t", "=lock:"]).is_ok(), "nothing was killed");
        // A target that names no window is refused before anything runs —
        // a bare `kill-window -t lock` would have killed lock's current window.
        assert!(close_window("lock").is_err());
        assert!(server.run(&["has-session", "-t", "=lock:"]).is_ok(), "the session's window is still there");
        drop(server);
    }

    /// Board #422 (T3): the down intent is written BEFORE the kill, so a kill
    /// that fails leaves the session alive AND marked — the error says so —
    /// and nothing but a successful up removes the mark.
    #[test]
    fn a_down_whose_kill_fails_stays_on_record() {
        use_test_store();
        let dir = std::env::temp_dir().join(format!("tmm-down-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = id_of(&create(&dir.to_string_lossy(), Some("downfail"), Some(&format!("downfail{}", std::process::id())), None).unwrap());
        let marked_before_close = std::cell::Cell::new(false);
        let err = down_with(&id, |_| {
            marked_before_close.set(with_store(|s| s.restore_intents()).unwrap().down.contains(&id));
            Err("tmux error: refused".into())
        })
        .unwrap_err();
        assert!(marked_before_close.get(), "the intent is durable before the kill runs");
        assert!(err.contains("marked down") && err.contains("refused"), "{err}");
        assert!(with_store(|s| s.restore_intents()).unwrap().down.contains(&id), "a failed kill does not undo the intent");
        // Control: a successful close keeps it too; only up clears (pinned in the e2e test).
        down_with(&id, |_| Ok(())).unwrap();
        assert!(with_store(|s| s.restore_intents()).unwrap().down.contains(&id));
        let _ = delete(&id);
        assert!(!with_store(|s| s.restore_intents()).unwrap().down.contains(&id), "delete forgets it");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
