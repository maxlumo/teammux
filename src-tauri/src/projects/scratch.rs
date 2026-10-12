//! The scratch terminal's session (board #324, owner 2026-10-09: "这个
//! Terminal 只是临时用的，并且跟你的项目没有关系，我就是单纯想在系统上去运行个
//! Terminal").
//!
//! Every tmux session is a project (`auto_adopt_once`), except ONE: the
//! session the desktop's scratch panel opens. What makes a session that one
//! is OWNERSHIP, never the name alone — `owned` is the single predicate every
//! path asks (ensure, kill, auto-adopt):
//!
//! - the session `tmm-scratch` exists (exact target),
//! - it carries our mark, the tmux session option `@tmm-scratch` = `1`, set
//!   when we created it (a native tmux fact: no new store, gone with the
//!   session),
//! - and no project row declares that session (a project that is down still
//!   holds its name).
//!
//! A name held by anything else — a plain session the user made, or a
//! project — is `Taken`: we refuse with the reason and never kill, rename or
//! undeclare it. The session starts in `$HOME` with the default shell, runs
//! no agent and installs no hooks beyond its own keep-alive.
//!
//! Two things make it the owner's "hidden quick terminal" rather than just
//! another session (board #326, owner 2026-10-09: "不需要作为一个真实的
//! project 显示出来，就是一个隐藏的会话就好…退出这个隐藏会话时，也不要关掉"):
//!
//! - **Hidden from every listing.** `hidden_session()` — derived from the one
//!   `owned` predicate, never from the name — is the session the session/pane
//!   listings drop (`server/rpc.rs`). The panel is its only door.
//! - **Exiting the shell does not end it.** tmux's own mechanism, not a
//!   process manager of ours: `remain-on-exit` keeps the pane when its shell
//!   exits, and the session's `pane-died` hook respawns it IN PLACE, so the
//!   `session:window.pane` target the Terminal subscribes stays valid.

use crate::tmux;
// ONE refusal type, from the write that refuses to the socket that answers
// (board #337 review): a stale precondition and a failure stay apart without
// any caller translating between two copies of the same distinction.
use super::projects::Refused;

pub const SCRATCH_SESSION: &str = "tmm-scratch";
const MARK: &str = "@tmm-scratch";
/// The keep-alive hook's body. Plain `respawn-pane`, with no target and no
/// `-k`:
///
/// - no TARGET, because tmux runs a `pane-died` hook with the pane that died
///   as its target (measured on tmux 3.6a with two panes — only the dead pane
///   was respawned, the live pane kept its shell pid). The explicit
///   `respawn-pane -t "#{pane_id}"` form stores fine and never fires on 3.6a;
/// - no `-k`, so the hook cannot kill a shell either: if `ensure` repaired the
///   pane between the death and the hook, tmux refuses the hook's respawn
///   instead of killing the shell the reader is already typing into
///   (`tmux::respawn_pane`).
const RESPAWN_HOOK: &str = "respawn-pane";
/// Where a project that held the reserved name is renamed to when the reader
/// releases it: `<reserved>-recovered`, or — when something already holds
/// that — the same name `create` would pick, through the ONE suffixing rule
/// (`free_session_name`, board #337 review).
///
/// The base is shortened to `-rec` for the suffixed case on purpose:
/// `projects::rename` derives the session from this label through `slug`,
/// which bounds it at 24 characters, and `tmm-scratch-recovered-<digest>` is
/// 28 — it would be truncated to something neither this function nor
/// `free_session_name` chose. `tmm-scratch-rec-<digest>` is 22. Derived from
/// the reserved name, so a TEST run never writes a production session name
/// onto the shared tmux server (testing.md).
///
/// This answer can go stale — the name it picked is free under one lock and
/// taken under the rename's next one — and that direction is safe: `rename`
/// refuses a session name another project holds, so a lost race here is an
/// error and an unchanged store, never a release onto an occupied name. The
/// reader's retry picks the next free one.
fn recovered_name(project_id: &str) -> Result<String, String> {
    let pretty = bounded(&name(), "-recovered", 0);
    crate::projects::with_store(|store| {
        let free = super::projects::free_session_name(store, &pretty, project_id)?;
        if free == pretty {
            return Ok(free);
        }
        // Taken: the shortened base leaves room for the ONE suffixing rule's
        // `-<digest>` inside the same bound.
        super::projects::free_session_name(store, &bounded(&name(), "-rec", SUFFIX_ROOM), project_id)
    })
}

/// `free_session_name`'s suffix: `-` plus a six-character digest.
const SUFFIX_ROOM: usize = 7;

/// A candidate that survives `projects::slug` UNCHANGED, so the name chosen
/// here is the name `rename` writes. slug truncates at 24 characters, and a
/// truncated candidate is a name neither this policy nor `free_session_name`
/// picked — measured: with a long reserved name, `-recovered` and `-rec`
/// collapsed onto the SAME 24-character string and the rename refused itself.
/// `reserve` is room left for a suffix appended after.
fn bounded(reserved: &str, tag: &str, reserve: usize) -> String {
    const MAX: usize = 24;
    let head: String = reserved.chars().take(MAX.saturating_sub(tag.len() + reserve)).collect();
    format!("{head}{tag}")
}

/// The session name every path below uses. Production: `SCRATCH_SESSION`.
/// A test points it at a name its `tmux::Scratch` guard owns, so a test run
/// never touches the user's real scratch session (all cargo runs share one
/// tmux server — testing.md).
#[cfg(not(test))]
pub fn name() -> String {
    SCRATCH_SESSION.to_string()
}
#[cfg(test)]
thread_local! {
    static TEST_NAME: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub fn name() -> String {
    TEST_NAME.with(|n| n.borrow().clone()).unwrap_or_else(|| SCRATCH_SESSION.to_string())
}
#[cfg(test)]
pub(crate) fn use_test_name(name: &str) {
    TEST_NAME.with(|n| *n.borrow_mut() = Some(name.to_string()));
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ownership {
    Ours,
    Absent,
    Taken(String),
}

/// The pure verdict over the three facts (tested without tmux).
pub(crate) fn verdict(exists: bool, marked: bool, project: Option<&str>) -> Ownership {
    if let Some(name) = project {
        return Ownership::Taken(format!("the name '{}' belongs to project '{name}'", self::name()));
    }
    match (exists, marked) {
        (false, _) => Ownership::Absent,
        (true, true) => Ownership::Ours,
        (true, false) => Ownership::Taken(format!("a tmux session named '{}' already exists and is not the scratch terminal", name())),
    }
}

/// The project that holds the name RIGHT NOW, if any.
///
/// Deliberately not `projects::project_for_session`: that one also matches a
/// project's `prev_session`, which is a HISTORICAL alias kept so a renamed
/// project's old room and messages still resolve. A project that used to be
/// called `tmm-scratch` and has since been renamed does not occupy the name
/// any more, and treating it as an occupant would keep the scratch terminal
/// refused forever — including right after a release, which renames the
/// holder and therefore leaves exactly such an alias behind (board #337).
fn declaring_project() -> Result<Option<super::store::Project>, String> {
    crate::projects::with_store(|store| store.project_by_session(&name()))
}

fn declared_by() -> Result<Option<String>, String> {
    Ok(declaring_project()?.map(|p| p.name))
}

/// The project holding the reserved name, for a caller that must know WHICH
/// refusal it got without parsing the sentence (the `scratch_session` RPC
/// turns this into its own error code and sends this beside it, board #337).
/// A failed read is `None`: the panel then shows the refusal without an
/// action, which is the safe way round.
///
/// The three facts are what a release has to be ABOUT: the row's id and the
/// session it declares identify exactly what the reader approved, and the
/// name is what the confirmation shows them. Without them the action would
/// mean "rename whoever holds this name when I run", which is not what the
/// reader agreed to and can be a different project by then.
pub fn holder() -> Option<serde_json::Value> {
    let row = declaring_project().ok().flatten()?;
    Some(serde_json::json!({
        "projectId": row.id,
        "projectName": row.name,
        "session": row.session,
    }))
}

/// THE predicate.
pub fn owned() -> Result<Ownership, String> {
    let n = name();
    let exists = tmux::session_exists(&n);
    let marked = exists && tmux::session_option(&n, MARK).as_deref() == Some("1");
    Ok(verdict(exists, marked, declared_by()?.as_deref()))
}

/// True when `session` is our scratch session — the guard auto-adopt and
/// the other project paths share.
pub fn is_scratch(session: &str) -> bool {
    session == name() && matches!(owned(), Ok(Ownership::Ours))
}

/// The scratch session's name is RESERVED: no path that CLAIMS a session for
/// the projects store may take it, whoever currently holds it (board #337).
///
/// This amends #324's "recognised by ownership, never by name" for the
/// claiming paths only, and the two rules point in opposite directions rather
/// than conflicting: ownership-by-mark is what stops us STEALING a session
/// that is not ours (`ensure` and `kill` still refuse an unmarked same-name
/// session, unchanged), and the reservation is what stops us CLAIMING one.
/// Declining a name is always safe; claiming it is what broke.
///
/// The incident (owner, 2026-10-09: "完全用不了"): `auto_adopt_with` skipped a
/// session only when it was ours by MARK, so an UNMARKED `tmm-scratch` — left
/// by a build that predated the mark, created by hand, or left behind by an
/// `ensure` that failed between creating the session and marking it — was
/// adopted after the 120 s settle. A project row then declared the name, so
/// `owned()` answered `Taken` forever and the panel's only affordance, "Open
/// again", re-asked and got the same refusal. One stale session permanently
/// disabled the feature, with no way out through the UI.
pub fn reserved(session: &str) -> bool {
    session == name()
}

/// The session every listing HIDES (board #326) — `Some` only while it is
/// ours. A plain same-name session the user made, or a name a project holds,
/// is listed like anything else, and a failed read hides nothing: the name
/// alone is never enough to drop a row.
pub fn hidden_session() -> Option<String> {
    match owned() {
        Ok(Ownership::Ours) => Some(name()),
        _ => None,
    }
}

/// Exiting the shell must not end the session (owner: "退出这个隐藏会话时，
/// 也不要关掉"). Two native tmux facts, applied to the pane we are about to
/// hand out and re-applied by every `ensure` (declaration is truth: a session
/// created before this existed, or one whose hook was removed, self-heals):
///
/// - `remain-on-exit` (a WINDOW option, hence the pane target) keeps the pane
///   when its shell exits instead of closing the window — and the window is
///   the session's only one, so the session cannot end that way either;
/// - the session's `pane-died` hook respawns that pane in place, keeping its
///   `%id`, its `session:window.pane` target and its start directory
///   (measured, tmux 3.6a: a pane created with `-c /tmp/probe-cwd`, `cd /usr`,
///   then `exit`, came back in `/tmp/probe-cwd` — never `/`; our session is
///   created with `-c $HOME`).
///
/// Both are scoped to this window and this session; no global option or hook
/// is touched.
fn keep_alive(pane: &str) -> Result<(), String> {
    tmux::set_window_option(pane, "remain-on-exit", "on")?;
    tmux::set_hook(&name(), "pane-died", RESPAWN_HOOK)
}

/// Release the reserved name from the project that holds it, on an explicit
/// request from the reader (board #337, orchestrator's revised ruling).
///
/// NOT automatic. The first cut did this at server start for any row with
/// `adopted = 1`, which review refused and was right to: `adopt_in` sets that
/// flag for a session the USER asked us to track as well as for one the
/// capturer found, so the flag cannot tell our own hijacked row from someone's
/// workspace — and renaming a person's project under them while they are not
/// looking is not a repair. So the panel shows the refusal with an action, and
/// this runs only when the reader has confirmed it.
///
/// The row is RENAMED, not deleted and not archived: it keeps its id, path,
/// room and history, `projects::rename` carries the live tmux session with it
/// so a shell inside survives, and the scratch panel can create its own
/// session on the next open. Archiving would not have worked — an archived
/// project still holds its session name on purpose, since it can be restored
/// and brought up.
pub fn release(project_id: &str, session: &str) -> Result<serde_json::Value, Refused> {
    let n = name();
    let Some(row) = declaring_project().map_err(Refused::Failed)? else {
        return Err(Refused::Stale(format!("no project holds the name '{n}'")));
    };
    // The reader approved releasing ONE identified project (board #337
    // review). If the holder has changed since the refusal they saw — another
    // client renamed it, released it, or a different project took the name —
    // nothing is touched and the answer says so, rather than renaming a
    // project nobody agreed to.
    if row.id != project_id || row.session != session {
        return Err(Refused::Stale(format!(
            "'{n}' is no longer held by that project — it is held by '{}' now, so nothing was renamed",
            row.name
        )));
    }
    let recovered = recovered_name(&row.id).map_err(Refused::Failed)?;
    // The decision above is a fast, informative refusal; it is not what makes
    // this safe, because the store lock is released between it and the write.
    // The expectation travels INTO the rename, which re-reads the row under
    // the lock it writes with (review P1-a): if that row stopped declaring the
    // reserved name in between — another client renamed it, a release ran
    // twice — the rename refuses and the project the user has since named is
    // left wearing its own name.
    // Its refusal is CLASSIFIED, so this propagates it rather than renaming
    // it: an expectation that expired inside the write lock is the same
    // expired confirmation as the check above, and the panel recovers from
    // both (review, 19:23). One type end to end, so nothing is lost in a
    // translation step.
    let written = super::projects::rename_if_session(&row.id, Some(&n), &recovered)?;
    let holder = declaring_project().map_err(Refused::Failed)?.map(|p| p.name);
    let renamed_to = freed(&n, written["session"].as_str(), holder.as_deref()).map_err(Refused::Failed)?;
    eprintln!("scratch: project '{}' released the reserved session name '{n}' (board #337)", row.name);
    Ok(serde_json::json!({ "released": true, "project": row.name, "renamed_to": renamed_to }))
}

/// Was the name actually freed? DERIVED from what the rename wrote and from
/// who holds the name afterwards — never assumed from the rename returning
/// `Ok` (board #337 review: "verified, not assumed").
///
/// A rename can succeed WITHOUT moving the session. `projects::rename` moves
/// the tmux session and re-keys the row as one act, and when tmux refuses its
/// half — the reserved session was killed between the liveness check and the
/// rename, which is one tap away in the same panel — it leaves the
/// declaration where it is and still answers `Ok`. Reporting `released: true`
/// for that would send the reader back to a panel that refuses exactly as
/// before, with nothing left to confirm.
///
/// So the answer carries the session the rename WROTE, not the one we asked
/// for: `renamed_to` is then what the row really wears, and a write that
/// landed somewhere else cannot be reported as the name we chose. An
/// unreadable answer is its own refusal, because it is not evidence either.
///
/// Both facts are checked here rather than one: the row we renamed is the
/// only possible holder today (`session` is UNIQUE and every claiming path
/// declines the reserved name), but what the reader needs to know is the END
/// STATE of the name — the same reason `ensure` decides on the end state of
/// its pane instead of on its own earlier reading.
fn freed(reserved: &str, written: Option<&str>, holder: Option<&str>) -> Result<String, String> {
    let Some(written) = written.filter(|s| !s.is_empty()) else {
        return Err(format!("the rename did not say which session the project declares, so '{reserved}' is not released"));
    };
    if written == reserved {
        return Err(format!("the rename could not move '{reserved}', so the project still declares it"));
    }
    if let Some(name) = holder {
        return Err(format!("'{reserved}' is still held by project '{name}' after the rename"));
    }
    Ok(written.to_string())
}

/// Ensure the scratch session exists and answer `{session, target}`: the
/// concrete `session:window.pane` of its first window's first pane (base
/// index honoured), the target the Terminal subscribes, types and resizes
/// against. A concurrent ensure that created it first is the only create
/// failure accepted, and only once `owned` says it is ours.
///
/// The pane handed back is always LIVE: a pane that died before the keep-alive
/// existed (an older session, a hook that was removed, an exit between create
/// and hook) is repaired here. "Only a dead pane" is TMUX's decision, not a
/// check-then-act of ours (#326 review P1): `respawn_pane` carries no `-k`, so
/// tmux refuses it while a shell or a command is still running. That is what
/// makes a repeated ensure safe — our own `pane_live` reading is only a fast
/// path, and it is stale by the time the next line runs, because the
/// `pane-died` hook or another ensure may revive the pane in between. The END
/// STATE is therefore what decides: a refusal whose pane is now live is
/// success (someone else won the race), and only a pane that is still not live
/// is an error.
pub fn ensure() -> Result<serde_json::Value, String> {
    match owned()? {
        Ownership::Taken(why) => return Err(why),
        Ownership::Ours => {}
        Ownership::Absent => {
            if let Err(e) = tmux::new_session(&name(), None, None) {
                let raced = e.contains("already exists") || e.contains("duplicate session");
                if !raced || owned()? != Ownership::Ours {
                    // A raced create that is not ours yet may be the other
                    // ensure between create and mark: give it one beat.
                    std::thread::sleep(std::time::Duration::from_millis(150));
                    if !raced || owned()? != Ownership::Ours {
                        return Err(e);
                    }
                }
            } else {
                tmux::set_session_option(&name(), MARK, "1")?;
            }
        }
    }
    let target = first_pane()?;
    keep_alive(&target)?;
    // Everything from here on names the pane by its tmux `%id`, read once:
    // `session:window.pane` is a POSITION, and a window or pane created beside
    // ours renumbers it, so the check and the repair could otherwise land on
    // two different panes. The id is stable for the pane's whole life — it is
    // what `respawn-pane` keeps — while the client needs the positional target
    // for its subscription, which is what we answer with.
    let id = tmux::pane_format(&target, "#{pane_id}")
        .ok_or_else(|| format!("the scratch terminal's pane {target} cannot be read"))?;
    // Unless the pane is PROVEN live, offer it a shell: an unreadable answer
    // falls on the repair side, which costs nothing now that the repair cannot
    // kill anything.
    if tmux::pane_live(&id) != Some(true) {
        let attempt = tmux::respawn_pane(&id);
        if tmux::pane_live(&id) != Some(true) {
            return Err(attempt.err().unwrap_or_else(||
                format!("the scratch terminal's shell will not start in {target}")));
        }
    }
    // The answer is the position of the pane we actually verified, read from
    // its %id at the END (#326 review): the string `first_pane` gave us is a
    // POSITION, and a pane created or killed beside ours while we worked
    // renumbers it, so handing back the pre-repair string could name a pane
    // this call never checked. Reading it back from the id cannot — and the
    // read carries the pane's SESSION, which is checked too: a `move-pane`
    // into another session keeps the id valid, and an unchecked answer would
    // have paired `session: tmm-scratch` with another session's pane and sent
    // the client through the scratch door into it.
    let target = target_in_our_session(
        tmux::pane_format(&id, &format!("#{{session_name}}{SEP}#{{window_index}}.#{{pane_index}}")).as_deref(),
        &name(),
        &id,
    )?;
    // Two different facts, both checked at the end, neither standing in for
    // the other (#326 review): the one above is about THE PANE — a
    // `move-pane` can carry it into another session while its `%id` stays
    // valid — and this one is about THE SESSION: its mark can be unset, a
    // project declaration can claim its name, or it can be gone and
    // recreated by someone else while we work. Ownership was true at the top
    // of this call; handing out a target asserts it is still true now.
    still_ours(owned()?)?;
    Ok(serde_json::json!({ "session": name(), "target": target }))
}

/// The one separator between the two fields of that read: a session name can
/// contain spaces and colons-by-accident, so the target is REBUILT from the
/// verified parts instead of split out of a joined string.
const SEP: &str = "<TMM_SEP>";

/// The verdict over that end-of-call read (pure, so the three failures are
/// tested without tmux): the pane must still answer, and it must still be in
/// the session we own. Anything else is an error, never a target.
fn target_in_our_session(raw: Option<&str>, ours: &str, id: &str) -> Result<String, String> {
    let raw = raw.ok_or_else(|| format!("the scratch terminal's pane {id} vanished while it was being prepared"))?;
    let (session, pos) = raw
        .split_once(SEP)
        .filter(|(_, pos)| pos.contains('.'))
        .ok_or_else(|| format!("the scratch terminal's pane {id} answered '{raw}', which is not a pane position"))?;
    if session != ours {
        return Err(format!("the scratch terminal's pane {id} is in session '{session}', not '{ours}'"));
    }
    Ok(format!("{session}:{pos}"))
}

/// The end-of-call ownership verdict (pure, so each outcome is pinned without
/// racing a live call). A `Taken` session answers with the reason `owned`
/// already composed — the same sentence the reader would have got had the
/// refusal happened at the start.
fn still_ours(verdict: Ownership) -> Result<(), String> {
    match verdict {
        Ownership::Ours => Ok(()),
        Ownership::Taken(why) => Err(why),
        Ownership::Absent => Err(format!(
            "the scratch terminal's session '{}' disappeared while it was being prepared",
            name()
        )),
    }
}

fn first_pane() -> Result<String, String> {
    let n = name();
    let panes = tmux::list_panes(&n)?;
    let first = panes
        .iter()
        .min_by_key(|p| (p.window, p.pane))
        .ok_or_else(|| "the scratch session has no pane".to_string())?;
    Ok(format!("{}:{}.{}", n, first.window, first.pane))
}

/// Kill the scratch session — only when it is ours. The keep-alive cannot
/// fight this: `pane-died` is a SESSION option, so it goes with the session
/// (measured on tmux 3.6a: `kill-session` on a session carrying the hook
/// leaves no session behind, not a respawned one). Explicit Kill stays the
/// one way to end it.
pub fn kill() -> Result<serde_json::Value, String> {
    match owned()? {
        Ownership::Ours => {
            tmux::kill_session(&name())?;
            Ok(serde_json::json!({ "killed": true }))
        }
        Ownership::Absent => Ok(serde_json::json!({ "killed": false })),
        Ownership::Taken(why) => Err(why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The end-of-call answer is checked, not merely non-empty (#326 review):
    /// a `move-pane` into another session keeps the %id valid, so without the
    /// session check the RPC would pair `session: tmm-scratch` with a foreign
    /// pane and the client would act on another session through the scratch
    /// door. Pure, so every refusal is pinned without racing a live call.
    #[test]
    fn the_answered_target_must_be_a_position_inside_our_own_session() {
        let ok = target_in_our_session(Some("tmm-scratch<TMM_SEP>1.1"), "tmm-scratch", "%7");
        assert_eq!(ok.unwrap(), "tmm-scratch:1.1");
        // A session whose name contains a colon or a space still rebuilds
        // correctly, because the target is assembled from the two fields.
        assert_eq!(target_in_our_session(Some("my proj<TMM_SEP>2.3"), "my proj", "%7").unwrap(), "my proj:2.3");
        // Moved out from under us.
        let moved = target_in_our_session(Some("other<TMM_SEP>1.1"), "tmm-scratch", "%7").unwrap_err();
        assert!(moved.contains("is in session 'other'") && moved.contains("not 'tmm-scratch'"), "{moved}");
        // Gone, and malformed answers.
        assert!(target_in_our_session(None, "tmm-scratch", "%7").unwrap_err().contains("vanished"));
        for odd in ["", "tmm-scratch", "tmm-scratch<TMM_SEP>", "tmm-scratch<TMM_SEP>1", "1.1"] {
            let e = target_in_our_session(Some(odd), "tmm-scratch", "%7").unwrap_err();
            assert!(e.contains("not a pane position") || e.contains("is in session"), "{odd:?} -> {e}");
        }
    }

    /// Ownership is re-checked before a target is handed out, and each
    /// verdict has one answer (#326 review): the pane check cannot see a
    /// session that lost its mark or gained a project declaration mid-call,
    /// and this one cannot see a pane that was moved out — so both run.
    #[test]
    fn still_ours_refuses_a_session_that_stopped_being_ours() {
        assert!(still_ours(Ownership::Ours).is_ok());
        let taken = still_ours(Ownership::Taken("the name 'x' belongs to project 'p'".into())).unwrap_err();
        assert_eq!(taken, "the name 'x' belongs to project 'p'", "the reason owned() composed, verbatim");
        let gone = still_ours(Ownership::Absent).unwrap_err();
        assert!(gone.contains("disappeared while it was being prepared"), "{gone}");
        assert!(gone.contains(&name()), "and it names the session: {gone}");
    }

    #[test]
    fn ownership_is_existence_plus_our_mark_and_no_project() {
        assert_eq!(verdict(false, false, None), Ownership::Absent);
        assert_eq!(verdict(true, true, None), Ownership::Ours);
        assert!(matches!(verdict(true, false, None), Ownership::Taken(_)), "a plain session of that name is not ours");
        // A project that declares the name holds it even while it is down.
        assert!(matches!(verdict(false, false, Some("scratchpad")), Ownership::Taken(_)));
        assert!(matches!(verdict(true, true, Some("scratchpad")), Ownership::Taken(_)), "a declaration wins over a stale mark");
    }

    /// The state the #337 incident left: a row DECLARING the reserved session
    /// name. Written through the store because no public path will do it any
    /// more — which is the fix, and the reason the repair needs testing.
    fn hijacked_row(session: &str, path: &str, adopted: bool, ts: u64) -> String {
        let id = format!("{session}-row-{ts}");
        crate::projects::with_store(|store| {
            store.insert_project(&crate::projects::store::Project {
                id: id.clone(),
                name: session.to_string(),
                path: path.to_string(),
                icon: None,
                session: session.to_string(),
                adopted,
                autostart: false,
                created_at: ts,
                last_up_at: None,
                last_seen_at: None,
                archived: false,
                room: String::new(),
            })
        })
        .expect("the row the incident left");
        id
    }

    /// Poll a tmux fact that an asynchronous hook changes. The hook fires in
    /// milliseconds; the budget is for a loaded host, not for the mechanism.
    fn settles(mut done: impl FnMut() -> bool) -> bool {
        for _ in 0..120 {
            if done() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }
    fn pane_pid(target: &str) -> String {
        tmux::pane_format(target, "#{pane_pid}").unwrap_or_default()
    }
    /// Type into a shell that is READY to act on what is typed, and wait for
    /// the result. Bytes that reach a fresh pane before its line editor is up
    /// are echoed and then discarded (#325), so this goes through
    /// `tmux::wait_for_shell` — the SAME readiness mechanism production uses
    /// before typing into a pane it just made, not a second one — and retries
    /// a lost keystroke rather than reading it as a broken mechanism.
    ///
    /// EVERY site that types into the pane goes through here. This test went
    /// flaky only inside the full suite, where the host is loaded and a fresh
    /// shell takes longer to come up: `sleep 120` was typed straight at a pane
    /// `ensure` had just respawned, one line after the respawn, with no wait.
    fn typed(target: &str, line: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..3 {
            tmux::wait_for_shell(target, tmux::SHELL_READY);
            tmux::send_command(target, line).expect("typed");
            if settles(&mut done) {
                return;
            }
        }
        panic!("the shell in {target} never acted on `{line}`");
    }
    /// `exit`, and the pane it was typed into stops being that shell.
    fn exit_shell(target: &str, before: &str) {
        typed(target, "exit", || pane_pid(target) != before || tmux::pane_live(target) == Some(false));
    }

    /// The server's global `pane-died` hook, `None` when none is set — which
    /// is also the answer when no server exists yet (board #349: under the
    /// isolated `TMUX_TMPDIR` the suite now runs in, this test is the first
    /// to start one, and `show-options` on no server answered `None` while
    /// the same unset option on the server it had created answered `""`).
    fn global_hook() -> Option<String> {
        tmux::run_tmux(&["show-options", "-g", "-v", "pane-died"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    /// The hidden session stays alive across an exit, and `ensure` repairs a
    /// pane that died before the keep-alive existed (board #326, review P1-b).
    /// Under a guard-owned name: the production `tmm-scratch` and the global
    /// tmux options/hooks are never touched.
    #[test]
    fn the_shell_can_exit_without_ending_the_session_and_a_dead_pane_is_repaired() {
        crate::projects::tests::use_test_store();
        let real_before = tmux::session_exists(SCRATCH_SESSION);
        let real_hook_before = tmux::session_hook(SCRATCH_SESSION, "pane-died");
        let global_hook_before = global_hook();
        let mut guard = tmux::Scratch::new("ka");
        let n = guard.session("k");
        use_test_name(&n);
        if tmux::new_session(&guard.session("probe"), None, None).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        let first = ensure().expect("created");
        let target = first["target"].as_str().unwrap().to_string();
        // The keep-alive is tmux's own, scoped to this window and session.
        assert_eq!(tmux::window_option(&target, "remain-on-exit").as_deref(), Some("on"));
        // The body is asserted LITERALLY, not against RESPAWN_HOOK: comparing
        // the constant to itself would pass however it changed, and the two
        // things that must not come back — a `-k` and an explicit target —
        // are exactly a change to this string (#326 review P1).
        assert_eq!(tmux::session_hook(&n, "pane-died").as_deref(), Some("respawn-pane"));
        assert_eq!(RESPAWN_HOOK, "respawn-pane");
        // A repeated ensure re-applies it and never kills a running shell.
        let pid = pane_pid(&target);
        assert!(!pid.is_empty());
        for _ in 0..3 {
            assert_eq!(ensure().unwrap()["target"], target.as_str());
        }
        assert_eq!(pane_pid(&target), pid, "a healthy ensure leaves the shell alone");
        assert_eq!(tmux::pane_live(&target), Some(true));

        // Ctrl-D / `exit`: the pane comes back IN PLACE — same target, so the
        // Terminal's subscription stays valid — and the session survives.
        exit_shell(&target, &pid);
        assert!(settles(|| pane_pid(&target) != pid && tmux::pane_live(&target) == Some(true)),
            "the pane-died hook respawns the shell in place");
        assert!(tmux::session_exists(&n), "the hidden session does not end with its shell");
        assert_eq!(first_pane().unwrap(), target, "and keeps the same session:window.pane");
        let revived = pane_pid(&target);

        // A pane that died BEFORE the keep-alive existed (an old session, a
        // removed hook): ensure repairs it instead of handing out a dead pane.
        tmux::run_tmux(&["set-hook", "-u", "-t", &n, "pane-died"]).expect("hook removed");
        assert_eq!(tmux::session_hook(&n, "pane-died"), None);
        exit_shell(&target, &revived);
        assert!(settles(|| tmux::pane_live(&target) == Some(false)), "with no hook the pane stays dead");
        // The review's exact sequence: this path has OBSERVED the pane dead,
        // and another path (the hook, or a concurrent ensure) revives it
        // before the repair runs. The repair must kill nothing.
        assert_eq!(tmux::pane_live(&target), Some(false), "observed dead");
        tmux::respawn_pane(&target).expect("another path revives it first");
        let winner = pane_pid(&target);
        assert_eq!(tmux::pane_live(&target), Some(true));
        assert!(tmux::respawn_pane(&target).is_err(), "the late repair is refused, not applied");
        assert_eq!(pane_pid(&target), winner, "the winner's shell is untouched");
        // ensure over that same state is idempotent: same pane, still alive.
        let after_race = ensure().expect("idempotent over a revived pane");
        assert_eq!(after_race["target"], target.as_str());
        assert_eq!(pane_pid(&target), winner);
        // Back to dead, so the repair path itself is still exercised below.
        // (That last ensure re-installed the hook, as it is meant to.)
        tmux::run_tmux(&["set-hook", "-u", "-t", &n, "pane-died"]).expect("hook removed again");
        exit_shell(&target, &winner);
        assert!(settles(|| tmux::pane_live(&target) == Some(false)), "dead again, with no hook");
        let repaired = ensure().expect("ensure repairs a dead pane");
        assert_eq!(repaired["target"], target.as_str());
        assert_eq!(tmux::pane_live(&target), Some(true), "the target handed back is a LIVE pane");
        assert_ne!(pane_pid(&target), revived, "a new shell, in the same pane");
        assert_eq!(tmux::session_hook(&n, "pane-died").as_deref(), Some("respawn-pane"), "and the hook is back");

        // #326 review P1: the repair is TMUX's decision, not our
        // check-then-act. A respawn aimed at a pane whose shell is running —
        // which is what a stale `pane_live` reading, the pane-died hook or a
        // concurrent ensure would produce — is REFUSED, and the shell (and
        // anything it started) survives. Without this, the `-k` form would
        // have killed whatever won the race.
        let running = pane_pid(&target);
        typed(&target, "sleep 120", || tmux::pane_format(&target, "#{pane_current_command}").as_deref() == Some("sleep"));
        let refused = tmux::respawn_pane(&target);
        assert!(refused.is_err(), "tmux refuses to respawn a pane that is still active: {refused:?}");
        assert_eq!(pane_pid(&target), running, "the shell is untouched");
        assert_eq!(tmux::pane_format(&target, "#{pane_current_command}").as_deref(), Some("sleep"),
            "and so is the command it was running");
        // Which is also why a repeated ensure through this path is a no-op.
        assert_eq!(ensure().unwrap()["target"], target.as_str());
        assert_eq!(pane_pid(&target), running, "ensure did not restart a live shell");
        tmux::send_keys(&target, "C-c", false).ok();

        // The target ensure ANSWERS with is read back from that same %id at
        // the end, so the client can only ever be handed the position of the
        // pane this call verified.
        let answered = ensure().unwrap()["target"].as_str().unwrap().to_string();
        let answered_id = tmux::pane_format(&answered, "#{pane_id}");
        assert_eq!(answered_id, tmux::pane_format(&target, "#{pane_id}"), "the answer names the pane we checked");
        assert_eq!(tmux::pane_live(&answered), Some(true), "and it is live");

        // The check and the repair name the pane by its %id, so a window
        // created beside ours (which renumbers positions) cannot make them
        // land on two different panes.
        let id = tmux::pane_format(&target, "#{pane_id}").expect("a pane id");
        assert!(id.starts_with('%'));
        assert_eq!(tmux::pane_live(&id), tmux::pane_live(&target), "both names, one pane");
        // The three liveness states tmux can report, each distinguished —
        // 'unreadable' is its own answer and never passes for 'live'.
        assert_eq!(tmux::pane_live("tmm-no-such-session-326:9.9"), None, "a pane that is not there is unknown, not live");
        assert_eq!(tmux::pane_live("%999999"), None, "and so is an id that is not there");

        // Explicit Kill is still the one way to end it: the hook is a session
        // option, so it dies with the session instead of rebuilding the pane.
        assert_eq!(kill().unwrap()["killed"], true);
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(!tmux::session_exists(&n), "killed, not respawned by its own hook");
        assert_eq!(owned().unwrap(), Ownership::Absent);

        assert_eq!(tmux::session_exists(SCRATCH_SESSION), real_before, "the real scratch session was never touched");
        assert_eq!(tmux::session_hook(SCRATCH_SESSION, "pane-died"), real_hook_before, "nor its hooks");
        assert_eq!(global_hook(), global_hook_before, "and no global hook was set");
    }

    /// Why the repair names the pane by `%id` and not by its position
    /// (#326 review): a POSITION is reused. Measured here on real tmux, so
    /// the rule's reason cannot quietly expire.
    #[test]
    fn a_pane_position_is_reused_but_an_id_is_not() {
        let mut guard = tmux::Scratch::new("id");
        let s = guard.session("i");
        if tmux::new_session(&s, None, None).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        let panes = tmux::list_panes(&s).unwrap();
        let first = panes.iter().min_by_key(|p| (p.window, p.pane)).unwrap();
        let target = format!("{}:{}.{}", s, first.window, first.pane);
        let held = tmux::pane_format(&target, "#{pane_id}").expect("an id");
        // A second pane, then the FIRST one dies: the survivor inherits the
        // index the first one had.
        tmux::run_tmux(&["split-window", "-d", "-t", &target]).expect("split");
        tmux::run_tmux(&["kill-pane", "-t", &held]).expect("kill the first pane");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let now = tmux::pane_format(&target, "#{pane_id}").expect("the position still resolves");
        assert_ne!(now, held, "the position was handed to another pane");
        // Which is the whole point: the id we read answers honestly that ITS
        // pane is gone (so ensure errors), while the stale position answers
        // for a pane we never examined — the one a positional repair would
        // have respawned.
        assert_eq!(tmux::pane_live(&held), None, "our pane is gone, and we can tell");
        assert_eq!(tmux::pane_live(&target), Some(true), "the position reads as a live stranger");
    }

    /// Every recovered-name candidate stays inside `slug`'s 24 characters, so
    /// the name this policy picks is the name `rename` writes (board #337
    /// review: appending to a long reserved name truncated two different
    /// candidates onto the same string, and the rename refused itself).
    #[test]
    fn recovered_candidates_survive_the_slug_bound_unchanged() {
        assert_eq!(bounded("tmm-scratch", "-recovered", 0), "tmm-scratch-recovered");
        assert_eq!(bounded("tmm-scratch", "-rec", SUFFIX_ROOM), "tmm-scratch-rec");
        // A guarded test name is this long: bounded, distinct, with room left
        // for the suffixing rule's digest.
        let long = "tmm-test-rel-2242716-l";
        let pretty = bounded(long, "-recovered", 0);
        let base = bounded(long, "-rec", SUFFIX_ROOM);
        assert_eq!(pretty.chars().count(), 24);
        assert_eq!(base.chars().count() + SUFFIX_ROOM, 24, "a digest still fits");
        assert_ne!(pretty, base);
        for candidate in [&pretty, &base] {
            assert_eq!(&crate::projects::slug(candidate), candidate, "slug leaves it alone: {candidate}");
        }
    }

    /// The #337 incident, reproduced and then refused: an UNMARKED session
    /// with the scratch name used to be auto-adopted after the settle, and
    /// the row it created made `owned()` answer `Taken` forever — the panel
    /// dead with no way out. The reservation is by NAME, so it holds for a
    /// session we do not own; a session we DO own was already skipped.
    #[test]
    fn an_unmarked_session_with_the_reserved_name_is_never_auto_adopted() {
        crate::projects::tests::use_test_store();
        let mut guard = tmux::Scratch::new("resv");
        let n = guard.session("r");
        use_test_name(&n);
        let other = guard.session("plain");
        if tmux::new_session(&other, None, None).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        // An UNMARKED session with the reserved name: exactly what the
        // pre-mark binary adopted at 05:03 on 2026-10-09.
        tmux::new_session(&n, None, None).unwrap();
        assert!(matches!(owned().unwrap(), Ownership::Taken(_)), "not ours — the old guard would not have skipped it");
        assert!(!is_scratch(&n), "and `is_scratch` agrees, which is why the old guard let it through");
        assert!(reserved(&n));

        // Both sessions are old enough to settle. The plain one IS adopted,
        // which is what makes this a sharp test rather than a no-op; the
        // reserved one is not, whoever holds it.
        let ts = 10_000_000u64;
        let ages = [(n.clone(), 0u64), (other.clone(), 0u64)];
        let adopted = crate::projects::projects::auto_adopt_with(&ages, ts).unwrap();
        assert_eq!(adopted, vec![other.clone()], "the reserved name is declined, the ordinary session is claimed");
        assert!(crate::projects::project_for_session(&n).unwrap().is_none(), "nothing declares the reserved name");
        // A hand adoption is refused too, with the reservation as the reason.
        let by_hand = crate::projects::adopt(&n, None).unwrap_err();
        assert!(by_hand.contains("reserves"), "{by_hand}");
        // And `ensure` still refuses to TAKE a session that is not ours —
        // the #324 rule the reservation does not weaken.
        assert!(ensure().is_err(), "an unmarked same-name session is still never taken over");
        assert!(tmux::session_exists(&n), "and never killed");
        // create/rename cannot declare it either, live or not.
        let dir = guard.path();
        let made = crate::projects::create(&dir, Some("pad"), Some(&n), None).unwrap();
        assert_ne!(made["session"], n.as_str(), "create suffixes past the reserved name");
        assert!(crate::projects::rename(made["id"].as_str().unwrap(), &n).unwrap_err().contains("reserves"));
        tmux::kill_session(&n).unwrap();
        // Not live either: a DECLARATION on the name is what killed the panel.
        let made2 = crate::projects::create(&dir, Some("pad2"), Some(&n), None).unwrap();
        assert_ne!(made2["session"], n.as_str(), "still suffixed with no session running");
        for id in [made["id"].as_str().unwrap(), made2["id"].as_str().unwrap()] {
            crate::projects::delete(id).ok();
        }
    }

    /// `released: true` is EARNED, not assumed from a rename that returned
    /// `Ok` (board #337 review; validator: the end-state check had no failing
    /// control). Pure, so every refusal is pinned without racing a live call
    /// — and so the one state the live path cannot be driven into is still
    /// covered: `session` is UNIQUE and every claiming path declines the
    /// reserved name, so no second holder can be inserted, and
    /// `rename_if_session` keeps the declaration where it is only when TMUX
    /// refuses the session rename, which no test can inject between its
    /// liveness check and the call. What CAN be stated exactly is the
    /// decision, so it lives in one function and is stated here.
    #[test]
    fn a_release_is_only_released_when_the_name_really_moved() {
        // The release: the row declares something else now, and nobody holds
        // the reserved name. The answer carries what the rename WROTE.
        assert_eq!(freed("tmm-scratch", Some("tmm-scratch-recovered"), None).unwrap(), "tmm-scratch-recovered");
        // The rename answered Ok but could not move the session (tmux refused
        // its half): the panel would refuse exactly as before.
        let stuck = freed("tmm-scratch", Some("tmm-scratch"), Some("pad")).unwrap_err();
        assert!(stuck.contains("could not move 'tmm-scratch'"), "{stuck}");
        // Same, and nothing holds the name per the second read: the written
        // name alone already refuses, because it is about the row we renamed.
        assert!(freed("tmm-scratch", Some("tmm-scratch"), None).unwrap_err().contains("still declares it"));
        // It moved, but the name is held — by a row no path can create today,
        // which is why the END STATE is what decides rather than our own
        // earlier reading.
        let held = freed("tmm-scratch", Some("tmm-scratch-recovered"), Some("someone else")).unwrap_err();
        assert!(held.contains("still held by project 'someone else'"), "{held}");
        // An answer we cannot read is not evidence of a release either.
        for unreadable in [None, Some("")] {
            let e = freed("tmm-scratch", unreadable, None).unwrap_err();
            assert!(e.contains("did not say which session"), "{unreadable:?} -> {e}");
        }
    }

    /// The reader's way out of the dead end the incident left (board #337).
    /// Nothing automatic: this runs only because someone confirmed it.
    #[test]
    fn release_frees_the_reserved_name_on_request_and_verifies_it() {
        crate::projects::tests::use_test_store();
        let mut guard = tmux::Scratch::new("rel");
        let n = guard.session("l");
        use_test_name(&n);
        if tmux::new_session(&guard.session("probe"), None, None).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        let dir = guard.path();
        // Nothing to release yet: the refusal names that, rather than
        // pretending to have done something.
        let nothing = release("whatever", &n).unwrap_err();
        assert!(matches!(nothing, Refused::Stale(_)), "{nothing:?}");
        assert!(nothing.text().contains("no project holds"), "{nothing:?}");
        assert!(holder().is_none());
        // The state the incident left, written at the STORE level because no
        // public path can declare that name any more — which is the fix.
        tmux::new_session(&n, None, None).unwrap();
        let row_id = hijacked_row(&n, &dir, true, 10_000);
        assert!(matches!(owned().unwrap(), Ownership::Taken(_)), "the panel's dead end");
        assert!(ensure().is_err());

        // The refusal's snapshot is what the reader approves.
        let held = holder().expect("the holder travels with the refusal");
        assert_eq!(held["projectId"], row_id.as_str());
        assert_eq!(held["projectName"], n.as_str());
        assert_eq!(held["session"], n.as_str());
        // A release aimed at a DIFFERENT project touches nothing — the reader
        // approved one project, not "whoever holds the name when I run".
        let stale = release("some-other-row", &n).unwrap_err();
        // STALE, not a plain failure: nothing was touched, and the panel
        // recovers from this code instead of showing the sentence (#337).
        assert!(matches!(stale, Refused::Stale(_)), "{stale:?}");
        assert!(stale.text().contains("no longer held by that project"), "{stale:?}");
        assert!(declaring_project().unwrap().is_some(), "and the holder is untouched");
        let wrong_session = release(&row_id, "not-the-session").unwrap_err();
        assert!(matches!(wrong_session, Refused::Stale(_)), "{wrong_session:?}");
        assert!(wrong_session.text().contains("no longer held"), "{wrong_session:?}");

        let out = release(&row_id, &n).expect("released on request");
        assert_eq!(out["released"], true);
        // Not the exact string: `bounded` truncates a long guarded name, so
        // two test processes can want the same recovered name and a leftover
        // session from either decides which form is picked. The POLICY is
        // what matters, and the arithmetic is pinned by the pure test above.
        let first = out["renamed_to"].as_str().unwrap().to_string();
        assert_ne!(first, n, "never the reserved name itself");
        assert_eq!(crate::projects::slug(&first), first, "and it survives slug unchanged");
        assert!(declaring_project().unwrap().is_none(), "the name is free");
        let moved = crate::projects::with_store(|store| store.project(&row_id)).unwrap().expect("the row still exists");
        assert_eq!(moved.session, first, "renamed, not deleted and not archived — and `renamed_to` is the session the rename WROTE, so the answer and the row cannot disagree");
        assert!(!moved.archived);
        assert!(tmux::session_exists(&moved.session), "and the live shell came with it");
        assert!(!tmux::session_exists(&n), "so the reserved name is unoccupied");
        // Which is the point: the panel works again. (And the renamed row's
        // prev_session alias must not read as an occupant — that is why
        // `declaring_project` asks about the CURRENT session only.)
        let fresh = ensure().expect("the scratch terminal opens again");
        assert_eq!(fresh["session"], n.as_str());
        assert_eq!(owned().unwrap(), Ownership::Ours);
        // A second release has nothing to do and says so; ours is untouched.
        let again = release(&row_id, &n).unwrap_err();
        assert!(matches!(again, Refused::Stale(_)) && again.text().contains("no project holds"), "{again:?}");
        assert_eq!(owned().unwrap(), Ownership::Ours);
        // And when the readable name is already taken, the recovered name is
        // the one the ONE suffixing rule picks, inside slug's bound.
        let second = hijacked_row(&n, &dir, true, 10_001);
        let out2 = release(&second, &n).expect("released again, with the pretty name taken");
        let picked = out2["renamed_to"].as_str().unwrap();
        assert_ne!(picked, first, "the first row still has that name");
        assert_eq!(crate::projects::slug(picked), picked, "survives slug unchanged: {picked}");
        assert_eq!(crate::projects::with_store(|s| s.project(&second)).unwrap().unwrap().session,
            crate::projects::slug(picked), "and the row really wears it");
        crate::projects::delete(&second).ok();
        // The recovered names are OUTSIDE the guard's ownership (it owns `n`),
        // so this test kills what it created — a leftover one changes which
        // form the next run picks, which is how this test first went flaky.
        for leftover in [first.as_str(), picked] {
            tmux::kill_session(leftover).ok();
        }
        kill().unwrap();
        tmux::kill_session(&moved.session).ok();
        crate::projects::delete(&row_id).ok();
    }

    /// Hidden from the listings only while it is OURS (board #326).
    #[test]
    fn only_an_owned_scratch_session_is_hidden_from_the_listings() {
        crate::projects::tests::use_test_store();
        let mut guard = tmux::Scratch::new("hid");
        let n = guard.session("h");
        use_test_name(&n);
        if tmux::new_session(&guard.session("probe"), None, None).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        assert_eq!(hidden_session(), None, "nothing to hide while it does not exist");
        ensure().expect("created");
        assert_eq!(hidden_session().as_deref(), Some(n.as_str()));
        kill().unwrap();
        // A plain session the user made with that name is listed like any
        // other: the NAME alone never hides a row.
        tmux::new_session(&n, None, None).unwrap();
        assert!(matches!(owned().unwrap(), Ownership::Taken(_)));
        assert_eq!(hidden_session(), None, "a session that is not ours stays visible");
        tmux::kill_session(&n).unwrap();
        // And a name a project declares stays visible too.
        let p = crate::projects::create(&guard.path(), Some("held"), Some(&n), None).unwrap();
        assert_eq!(hidden_session(), None, "a project's session is a project, listed as one");
        crate::projects::delete(p["id"].as_str().unwrap()).ok();
    }

    /// Real tmux (test:rust runs with one), under a guard-owned name — the
    /// production `tmm-scratch` is never touched, so a run cannot end the
    /// user's own scratch shell. Create once, idempotent, a concrete pane
    /// target, kill only ours, a plain same-name session refused and left
    /// alone, a declared-but-down project still Taken, and every project
    /// path meeting it (auto-adopt, adopt, create, rename) keeps one owner.
    #[test]
    fn ensure_creates_once_marks_and_answers_a_pane_target() {
        crate::projects::tests::use_test_store();
        let real_before = tmux::session_exists(SCRATCH_SESSION);
        // Short: a project session name is slugged to 24 characters.
        let mut guard = tmux::Scratch::new("sc");
        let n = guard.session("s");
        use_test_name(&n);
        assert_ne!(name(), SCRATCH_SESSION);
        if tmux::new_session(&guard.session("probe"), None, None).is_err() {
            eprintln!("no tmux server — skipping");
            return;
        }
        let a = ensure().expect("created");
        let target = a["target"].as_str().unwrap().to_string();
        assert_eq!(a["session"], n.as_str());
        assert!(target.starts_with(&format!("{n}:")) && target.contains('.'), "a session:window.pane target: {target}");
        assert_eq!(owned().unwrap(), Ownership::Ours);
        assert!(is_scratch(&n));
        // Auto-adopt and a direct adopt both refuse it.
        let adopted = crate::projects::projects::auto_adopt_with(&[(n.clone(), 0)], 10_000).unwrap();
        assert!(adopted.is_empty(), "never auto-adopted: {adopted:?}");
        assert!(crate::projects::adopt(&n, None).is_err(), "never adopted by hand");
        assert!(crate::projects::project_for_session(&n).unwrap().is_none());
        // A project created with that session name while it is live is
        // suffixed away from it; a rename onto it is refused.
        let dir = guard.path();
        let made = crate::projects::create(&dir, Some("pad"), Some(&n), None).unwrap();
        assert_ne!(made["session"], n.as_str(), "create gives the new project another session name");
        assert!(crate::projects::rename(made["id"].as_str().unwrap(), &n).is_err(), "rename onto it is refused");
        assert_eq!(owned().unwrap(), Ownership::Ours, "still ours after both");
        crate::projects::delete(made["id"].as_str().unwrap()).ok();
        let b = ensure().expect("idempotent");
        assert_eq!(b["target"], a["target"]);
        assert_eq!(kill().unwrap()["killed"], true);
        assert_eq!(owned().unwrap(), Ownership::Absent);
        // A plain session the user made with that name.
        tmux::new_session(&n, None, None).unwrap();
        assert!(matches!(owned().unwrap(), Ownership::Taken(_)));
        assert!(ensure().is_err(), "never taken over");
        assert!(kill().is_err(), "never killed");
        assert!(tmux::session_exists(&n), "left alone");
        assert!(!is_scratch(&n), "so it is adoptable like any session");
        tmux::kill_session(&n).unwrap();
        // A PROJECT that declares the name holds it even while it is down.
        // Since #337 `create` suffixes past the reserved name whether or not a
        // session is live — that no public path can produce this state any
        // more IS the fix — so the declaration is written at the store level,
        // because the state still has to be handled where it already exists.
        let suffixed = crate::projects::create(&dir, Some("held"), Some(&n), None).unwrap();
        assert_ne!(suffixed["session"], n.as_str(), "create never declares the reserved name");
        crate::projects::delete(suffixed["id"].as_str().unwrap()).ok();
        let held = hijacked_row(&n, &dir, false, 10_000);
        assert!(!tmux::session_exists(&n), "declared, not up");
        assert!(matches!(owned().unwrap(), Ownership::Taken(_)), "a down project still owns its name");
        assert!(ensure().is_err(), "ensure refuses instead of creating over a declaration");
        assert!(!tmux::session_exists(&n));
        crate::projects::delete(&held).ok();
        assert_eq!(tmux::session_exists(SCRATCH_SESSION), real_before, "the real scratch session was never touched");
    }
}
