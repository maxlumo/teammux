//! The lifetime boundary of the one delivery path (board #116; hub-composer.md
//! § A line is typed only into the lifetime it was meant for): the ONE
//! stamping function, the check at the write, the refusal words, and the
//! remove's purge. A line bound to an agent is typed only into that agent's
//! lifetime, its managed home's id (`asks::home_id`, #106).

use super::super::store::DeliveryRow;
use super::telemetry;
use super::Pending;

/// The window's LIFETIME now: its managed home's id, the one definition
/// `asks::home_id`. `Ok(None)`: no managed home (removed, or not an agent of
/// the project).
pub(super) fn lifetime_of(session: &str, window: &str) -> Result<Option<String>, String> {
    super::super::asks::home_id(session, window)
}

/// What a write aimed at another lifetime says, and the reason the feed's
/// `undelivered (…)` row gives: nothing was typed, and the line is NOT kept
/// for the window's new owner.
pub(crate) const REPLACED: &str = "the agent it was meant for was removed or replaced";
pub(super) const REPLACED_REASON: &str = REPLACED;
/// A lifetime that could not be read AT THE WRITE: nothing was typed, the
/// line is kept (`kept_at_write`).
pub(crate) const UNCHECKED_LIFETIME: &str = "held: the agent's lifetime cannot be read: ";
/// The reason a NEW line whose recipient's lifetime cannot be read is
/// refused (F1), in the feed's `undelivered (…)` row: the delivery's own
/// word for what could not be asked.
pub const UNCHECKED: &str = "unchecked: the agent's lifetime cannot be read";

/// Why a line could not be bound to a lifetime: the caller refuses it,
/// nothing held and nothing typed, and says why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unbound {
    /// The lifetime cannot be read (F1).
    Unchecked(String),
    /// No managed home answers for that name (round 2, reviewer R1): the
    /// agent was removed, or its project deleted.
    Gone,
}

impl Unbound {
    /// The reason in the feed's `undelivered (…)` row.
    pub fn reason(&self) -> &'static str {
        match self {
            Unbound::Unchecked(_) => UNCHECKED,
            Unbound::Gone => REPLACED,
        }
    }
    /// The one word a caller's own answer gives for it (an ask's
    /// `delivery`, `tmm send`'s list): `gone` or `unchecked`.
    pub fn word(&self) -> &'static str {
        match self {
            Unbound::Unchecked(_) => "unchecked",
            Unbound::Gone => "gone",
        }
    }
}

/// The ONE stamping function (F1): the lifetime a line is bound to, the
/// caller's when given, else the window's own now. A GIVEN lifetime is
/// verified against the name's current one exactly as a looked-up one is
/// (round 3, validator's P2 at the real ask door: an asker removed, or its
/// project deleted, after the close's check and before the bind, with no
/// replacement yet, was held for its dead home and said `found`); absent or
/// different is `Gone`. It yields an actual home id or refuses, with no
/// exception (round 2, reviewer R1 and its
/// clarification, leader's amended ruling): a recipient whose lifetime cannot
/// be read is `Unchecked`; one with no managed home is `Gone`, because every
/// caller found the window managed a moment earlier, and a remove or a
/// project delete that finished since would otherwise leave a line held with
/// no lifetime, for a same-name agent's flush to type. Nothing new is ever
/// held or typed unbound; a row has no lifetime only when it was written
/// before v40. A composer line is addressed to a NAME, so it is bound to
/// whoever holds the name when its recipient is resolved (leader, #116 note
/// 13); a held line and an ask's answer are bound to an EARLIER lifetime,
/// which is what this guards.
pub fn bind_lifetime(session: &str, window: &str, given: Option<&str>) -> Result<Option<String>, Unbound> {
    #[cfg(test)]
    if let Some(hook) = BEFORE_BIND.with(|h| h.borrow_mut().take()) {
        hook();
    }
    match lifetime_of(session, window) {
        Ok(Some(home)) if given.is_none_or(|g| g == home) => Ok(Some(home)),
        Ok(Some(_)) => Err(Unbound::Gone),
        // The unit fixtures that type through the faked pane have no homes
        // at all (`tests::fake`); that is the tests' seam, never production's.
        #[cfg(test)]
        Ok(None) if super::TYPED.with(|t| t.borrow().is_some()) => Ok(None),
        Ok(None) => Err(Unbound::Gone),
        Err(e) => Err(Unbound::Unchecked(e)),
    }
}

/// Is the window still the lifetime `expect` names? `None` asks nothing.
pub(super) fn lifetime_matches(session: &str, window: &str, expect: Option<&str>) -> Result<(), String> {
    let Some(expect) = expect else { return Ok(()) };
    match lifetime_of(session, window) {
        Ok(Some(now)) if now == expect => Ok(()),
        Ok(_) => Err(REPLACED.to_string()),
        Err(e) => Err(format!("{UNCHECKED_LIFETIME}{e}")),
    }
}

/// The ONE observation a write runs under (boards #116 F2, #117): the
/// restore gate, then the pane with its server and its process
/// (`final_pane`: `tmux::resolve_pane_checked`), then the lifetime. A `%id`
/// is unique only within one tmux server (a deleted project's last session
/// takes its server, and a new one hands the `%id` out again), so every write
/// of the line runs under this observation's native guard: tmux types only
/// into the server, pane and process that were checked, or nothing. A
/// restored window keeps its own bound guard, never replaced. A steer flush
/// takes it BEFORE retiring its rows and writes under the same one.
pub(super) struct Observed {
    pub(super) pane: String,
    pub(super) guard: Option<crate::tmux::WriteGuard>,
    pub(super) ordinary: bool,
}

pub(super) fn observe(session: &str, window: &str, target: &str, expect: Option<&str>) -> Result<Observed, String> {
    // A faked pane (the unit tests' typing seam) has no pane to observe.
    #[cfg(test)]
    if super::TYPED.with(|t| t.borrow().is_some()) {
        lifetime_matches(session, window, expect)?;
        return Ok(Observed { pane: target.to_string(), guard: None, ordinary: true });
    }
    let bound = super::gate(session, window, target, false)?;
    let (pane, seen) = super::final_pane(session, window, target)?;
    lifetime_matches(session, window, expect)?;
    let ordinary = bound.is_none();
    Ok(Observed { pane, guard: Some(bound.unwrap_or(seen)), ordinary })
}

/// The native guard of ONE observation of `pane` (a `%id` or a target): its
/// server, the pane and its process, in one tmux response.
pub(super) fn observed_guard(pane: &str) -> Result<crate::tmux::WriteGuard, String> {
    let unidentified = super::UNIDENTIFIED;
    let id = if pane.starts_with('%') { pane.to_string() } else { crate::tmux::pane_id_of(pane).ok_or_else(|| format!("{unidentified}'{pane}' does not resolve to a pane"))? };
    let observed = crate::tmux::resolve_pane_checked(&id).map_err(|e| format!("{unidentified}{e}"))?;
    observed.guard(&id).ok_or_else(|| format!("{unidentified}'{id}' is not a pane of the server that answered"))
}

/// The guard of a key (the Escape, the toggle: `send_key_into`): the restore
/// gate's bound one, else one observation of its target; and whether it is
/// an ordinary window's.
pub(super) fn key_guard(bound: Option<crate::tmux::WriteGuard>, target: &str) -> Result<(crate::tmux::WriteGuard, bool), String> {
    match bound {
        Some(g) => Ok((g, false)),
        None => Ok((observed_guard(target)?, true)),
    }
}

/// `type_text` under an observation already taken (a steer flush's).
#[cfg(not(test))]
pub(super) fn type_observed(session: &str, window: &str, observed: &Observed, text: &str) -> Result<(), String> {
    super::write_observed(session, window, observed, &super::typed_form(session, window, text))
}

/// `type_observed` behind the tests' typing seam.
#[cfg(test)]
pub(super) fn type_observed(session: &str, window: &str, observed: &Observed, text: &str) -> Result<(), String> {
    let text = &super::typed_form(session, window, text);
    if super::TYPED.with(|t| t.borrow().is_none()) {
        return super::write_observed(session, window, observed, text);
    }
    if let Some(e) = super::REFUSE.with(|r| r.borrow().clone()) {
        return Err(e);
    }
    super::TYPED.with(|t| t.borrow_mut().as_mut().unwrap().push(text.to_string()));
    Ok(())
}

/// What a write refused by the native guard of an ordinary window says: nothing
/// was written into a pane other than the one observed, and the line is kept
/// (`kept_at_write`), so the next bind or flush decides by its lifetime:
/// another one is refused and said, the same one (a restarted CLI) is typed
/// once. A restored window's own refusal keeps its own words.
pub(crate) const NOT_OBSERVED: &str = "held: the pane is not the one checked: ";

pub(super) fn refused_natively(written: Result<(), String>, ordinary: bool) -> Result<(), String> {
    match written {
        Err(e) if ordinary && e == crate::tmux::BOUND_REFUSED => Err(format!("{NOT_OBSERVED}its server, pane or process changed since the check")),
        other => other,
    }
}

/// A line the write kept (a restart, an unidentified pane, an unreadable
/// lifetime): held for its lifetime, bound by `bind_lifetime`; a lifetime
/// that cannot be read refuses it, said `unchecked`, never held unbound (F1).
pub(super) fn hold_bound(session: &str, window: &str, l: Pending<'_>) -> bool {
    match bind_or_refuse(session, window, l) {
        Some(bound) => telemetry::record_held_for(session, window, l.line, l.ask_at, l.msg_id, bound.as_deref()).is_ok(),
        None => false,
    }
}

/// The lifetime a line about to be HELD is bound to (`bind_lifetime`), or
/// `None` when it cannot be bound: the line is then refused and said
/// (`Unbound::reason`), never held unbound (F1, round 2).
pub(super) fn bind_or_refuse(session: &str, window: &str, l: Pending<'_>) -> Option<Option<String>> {
    match bind_lifetime(session, window, l.home) {
        Ok(bound) => Some(bound),
        Err(why) => {
            eprintln!("⚠️  {session}:{window}: {why:?}; nothing is held or typed");
            telemetry::record_undelivered(session, window, &crate::address::shown(l.line, l.ask_at), why.reason());
            None
        }
    }
}

/// A flush's rows that are still owed to the window, and the lifetime its
/// write must find: rows held for another lifetime (a removed agent's, under
/// a same-name replacement) are retired and said, never typed. `None`: the
/// lifetime cannot be read, nothing is typed and every row stays held. Rows
/// from before v40 carry none and are typed as before, so the lifetime is
/// read only when a row names one; the write re-checks it after the pane is
/// resolved.
pub(super) fn owed_rows(session: &str, window: &str, rows: Vec<DeliveryRow>) -> Option<(Vec<DeliveryRow>, Option<String>)> {
    let now = if rows.iter().any(|r| r.home.is_some()) { lifetime_of(session, window).ok()? } else { None };
    let (stale, rows): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| r.home.is_some() && r.home != now);
    telemetry::drop_held_rows(session, window, &stale, REPLACED_REASON);
    let expect = if rows.iter().any(|r| r.home.is_some()) { now } else { None };
    Some((rows, expect))
}

/// A released batch whose write met another lifetime: nothing was typed, and
/// the lines are not owed to it; each is said.
pub(super) fn not_owed(session: &str, window: &str, batch: &[DeliveryRow]) {
    for row in batch {
        telemetry::forget_delivery(row.id);
        telemetry::record_undelivered(session, window, &row.shown(), REPLACED_REASON);
    }
}

/// An agent was REMOVED: its held lines are dropped and said, and its typed
/// lines owe nothing, in the remove's own call, under the window lock so a
/// flush in progress finishes first (its keys went to the killed pane, or
/// were refused by the lifetime check).
pub fn forget_removed(session: &str, window: &str) {
    let lock = super::window_lock(session, window);
    let _guard = lock.lock().unwrap();
    telemetry::forget_removed_window(session, window);
}

#[cfg(test)]
thread_local! {
    /// Test seam: runs once between the lifetime check and the keys, the
    /// window a remove and a same-name spawn could fall into.
    pub(crate) static AFTER_LIFETIME: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
    /// Test seam (round 2): runs once as a line is bound, after its caller
    /// found the window managed: where a remove could finish first.
    pub(crate) static BEFORE_BIND: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

#[cfg(test)]
mod tests {
    use super::super::tests::{agent_with_recipe, busy, end, held, sql, warns};
    use super::super::{agent_target, deliver, deliver_for, flush, picker_hold, BEFORE_FINAL, HOLD_MAX_SECS, TYPED};
    use super::*;

    /// A real-tmux managed agent for the board #116 lifetime tests: a kiro
    /// queue home in a project, a window `dev` whose pane is a stand-in that
    /// prints what it reads, and a `keep` window holding the session (and the
    /// server) across a remove. Real typing: no TYPED capture.
    struct Lifetime {
        scratch: crate::tmux::Scratch,
        s: String,
    }
    const STAND_IN: &str = "bash -c 'exec -a kiro-cli cat'";
    impl Lifetime {
        fn new(tag: &str) -> Option<Self> {
            Self::with_mode(tag, "queue")
        }
        fn with_mode(tag: &str, mode: &str) -> Option<Self> {
            let mut scratch = crate::tmux::Scratch::new(tag);
            let s = scratch.session("s");
            agent_with_recipe(&scratch, &s, "dev", "kiro", mode);
            TYPED.with(|t| *t.borrow_mut() = None);
            crate::projects::exited::RUNNING_IN_TEST.with(|r| r.set(true));
            picker_hold::COMPOSER_IN_TEST.with(|c| c.set(true));
            let path = scratch.path();
            if !std::process::Command::new("tmux").args(["new-session", "-d", "-s", &s, "-n", "keep", "-c", &path, "cat"]).status().is_ok_and(|st| st.success()) {
                eprintln!("no tmux server — skipping");
                return None;
            }
            let me = Lifetime { scratch, s };
            me.window(None);
            Some(me)
        }
        /// A `dev` window (at `index` when given), its pane running the stand-in.
        fn window(&self, index: Option<&str>) {
            let at = index.map_or(format!("={}:", self.s), |i| format!("={}:{i}", self.s));
            crate::tmux::run_tmux(&["new-window", "-d", "-t", &at, "-n", "dev", "-c", &self.scratch.path(), STAND_IN]).expect("a dev window");
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        fn index(&self) -> String {
            crate::tmux::run_tmux(&["display-message", "-p", "-t", &format!("={}:dev", self.s), "#{window_index}"]).unwrap().trim().to_string()
        }
        fn home(&self) -> Option<String> {
            crate::projects::asks::home_id(&self.s, "dev").unwrap()
        }
        /// A same-name REPLACEMENT made without `agent_remove` (so nothing
        /// purges): the old window killed, its home deleted, a new home (a new
        /// lifetime) and a new window at the same index.
        fn replace(&self) {
            let index = self.index();
            crate::tmux::run_tmux(&["kill-window", "-t", &format!("={}:dev", self.s)]).unwrap();
            let home = std::path::Path::new(&self.scratch.path()).join(".tmm/agents/dev");
            std::fs::remove_dir_all(&home).unwrap();
            agent_with_recipe(&self.scratch, &self.s, "dev", "kiro", "queue");
            self.window(Some(&index));
        }
        fn shown(&self) -> String {
            crate::tmux::capture_pane_plain(&format!("={}:dev", self.s), Some(0)).unwrap_or_default()
        }
        fn target(&self) -> String {
            agent_target(&self.s, "dev").expect("a managed agent pane")
        }
        fn hold(&self, word: &str) {
            busy(&self.s, "dev");
            assert!(deliver(&self.s, "dev", &self.target(), &format!("[tmm chat 03:00] lead: @dev {word}"), 0, ""));
            assert_eq!(held(&self.s, "dev"), 1, "held behind the busy turn");
        }
        fn settle(&self) {
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
        fn home_dir(&self) -> std::path::PathBuf {
            std::path::Path::new(&self.scratch.path()).join(".tmm/agents/dev")
        }
        /// The home unreadable (validator's probes, #116 note 15): its id and
        /// recipe cannot be read, so the lifetime is not known.
        fn unreadable(&self, yes: bool) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(self.home_dir(), std::fs::Permissions::from_mode(if yes { 0o000 } else { 0o755 })).unwrap();
        }
    }

    /// Board #116, measured on main first (`temp/116/repro-main.log`): a
    /// line held for an agent belongs to THAT agent. Remove it and create the
    /// same name again, with no roster poll between: the new agent's pane is
    /// never typed the old line, and the remove said why at once.
    #[test]
    fn a_line_held_for_a_removed_agent_never_reaches_a_same_name_replacement() {
        let Some(t) = Lifetime::new("held-rm") else { return };
        t.hold("OLD-LINE-116");
        crate::projects::managed::agent_remove(&t.s, "dev").expect("removed");
        assert_eq!(held(&t.s, "dev"), 0, "dropped in the remove's own call");
        assert!(warns(&t.s).iter().any(|w| w.starts_with("undelivered (the agent was removed)") && w.contains("OLD-LINE-116")), "{:?}", warns(&t.s));
        agent_with_recipe(&t.scratch, &t.s, "dev", "kiro", "queue");
        t.window(None);
        end(&t.s, "dev");
        flush(&t.s, "dev");
        t.settle();
        assert!(!t.shown().contains("OLD-LINE-116"), "the replacement was typed the removed agent's line: {:?}", t.shown());
    }

    /// The lifetime check alone, with nothing purged: a held line stamped
    /// with its agent's home is retired, never typed, once the window's home
    /// is another one; a row held before v40 (no lifetime) is typed as before.
    #[test]
    fn a_held_line_is_typed_only_into_the_lifetime_it_was_held_for() {
        let Some(t) = Lifetime::new("held-life") else { return };
        let before = t.home().expect("a lifetime");
        t.hold("OLD-LIFE-116");
        assert_eq!(telemetry::held_rows(&t.s, "dev")[0].home.as_deref(), Some(before.as_str()), "stamped when held");
        crate::projects::with_store(|st| st.insert_held_delivery(&t.s, "dev", "[tmm chat 03:01] lead: @dev PRE-V40-116", 0, crate::projects::now(), "")).unwrap();
        t.replace();
        assert_ne!(t.home().unwrap(), before, "another lifetime");
        end(&t.s, "dev");
        flush(&t.s, "dev");
        t.settle();
        assert!(!t.shown().contains("OLD-LIFE-116"), "{:?}", t.shown());
        assert!(t.shown().contains("PRE-V40-116"), "a pre-v40 row is typed as today: {:?}", t.shown());
        assert_eq!(held(&t.s, "dev"), 0);
        assert!(warns(&t.s).iter().any(|w| w.starts_with(&format!("undelivered ({REPLACED_REASON})")) && w.contains("OLD-LIFE-116")), "{:?}", warns(&t.s));
    }

    /// An immediate delivery for a lifetime, paused BEFORE its pane is
    /// resolved while the agent is replaced (same name, same index): the new
    /// pane resolves, its lifetime does not match, nothing is typed, said.
    #[test]
    fn an_immediate_line_paused_across_a_replacement_reaches_nobody() {
        let Some(t) = Lifetime::new("imm-life") else { return };
        let home = t.home().unwrap();
        let target = t.target();
        let (s, scratch_path, index) = (t.s.clone(), t.scratch.path(), t.index());
        *BEFORE_FINAL.lock().unwrap() = Some(Box::new(move || {
            let _ = crate::tmux::run_tmux(&["kill-window", "-t", &format!("={s}:dev")]);
            let home = std::path::Path::new(&scratch_path).join(".tmm/agents/dev");
            let _ = std::fs::remove_dir_all(&home);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "input_mode": "queue", "cmd": "x" }).to_string()).unwrap();
            let _ = crate::tmux::run_tmux(&["new-window", "-d", "-t", &format!("={s}:{index}"), "-n", "dev", "-c", &scratch_path, STAND_IN]);
            std::thread::sleep(std::time::Duration::from_millis(200));
        }));
        let ok = deliver_for(&t.s, "dev", &target, "[tmm chat 03:02] human: @dev IMMEDIATE-116", 0, "", Some(&home));
        *BEFORE_FINAL.lock().unwrap() = None;
        t.settle();
        assert!(!ok, "not delivered");
        assert_ne!(t.home().unwrap(), home, "the pane resolved to another lifetime");
        assert!(!t.shown().contains("IMMEDIATE-116"), "{:?}", t.shown());
        assert!(warns(&t.s).iter().any(|w| w.starts_with(&format!("undelivered ({REPLACED_REASON})")) && w.contains("IMMEDIATE-116")), "{:?}", warns(&t.s));
    }

    /// A flush paused AFTER its lifetime check, while the agent is removed
    /// and created again: the keys go to the checked pane's %id, which died
    /// with the old window; the new pane gets nothing.
    #[test]
    fn a_flush_paused_after_its_check_never_types_into_the_replacement() {
        let Some(t) = Lifetime::new("flush-paused") else { return };
        t.hold("PAUSED-116");
        end(&t.s, "dev");
        let (s, scratch_path, index) = (t.s.clone(), t.scratch.path(), t.index());
        AFTER_LIFETIME.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            crate::tmux::run_tmux(&["kill-window", "-t", &format!("={s}:dev")]).unwrap();
            let home = std::path::Path::new(&scratch_path).join(".tmm/agents/dev");
            std::fs::remove_dir_all(&home).unwrap();
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "input_mode": "queue", "cmd": "x" }).to_string()).unwrap();
            crate::tmux::run_tmux(&["new-window", "-d", "-t", &format!("={s}:{index}"), "-n", "dev", "-c", &scratch_path, STAND_IN]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
        })));
        flush(&t.s, "dev");
        AFTER_LIFETIME.with(|h| *h.borrow_mut() = None);
        t.settle();
        assert!(!t.shown().contains("PAUSED-116"), "{:?}", t.shown());
        // Kept for the next trigger, where its lifetime retires it.
        flush(&t.s, "dev");
        t.settle();
        assert!(!t.shown().contains("PAUSED-116"), "{:?}", t.shown());
        assert_eq!(held(&t.s, "dev"), 0, "retired at the next flush");
    }

    /// #116 F1 (validator's probe `hold-error`): a NEW line whose recipient's
    /// lifetime cannot be read is refused at once, said `unchecked`, and never
    /// held unbound; a replacement made after the home is readable again gets
    /// nothing.
    #[test]
    fn a_line_for_an_unreadable_lifetime_is_refused_never_held_unbound() {
        let Some(t) = Lifetime::new("held-unchecked") else { return };
        busy(&t.s, "dev");
        let target = t.target();
        t.unreadable(true);
        assert!(crate::projects::asks::home_id(&t.s, "dev").is_err(), "the lifetime cannot be read");
        let ok = deliver(&t.s, "dev", &target, "[tmm chat 03:03] human: @dev UNBOUND-116", 0, "");
        t.unreadable(false);
        assert!(!ok, "refused");
        assert_eq!(held(&t.s, "dev"), 0, "no unbound row");
        assert!(warns(&t.s).iter().any(|w| w.starts_with(&format!("undelivered ({UNCHECKED})")) && w.contains("UNBOUND-116")), "{:?}", warns(&t.s));
        t.replace();
        end(&t.s, "dev");
        flush(&t.s, "dev");
        t.settle();
        assert!(!t.shown().contains("UNBOUND-116"), "{:?}", t.shown());
    }

    /// #116 F2 (validator's probe `late-steer-error`): a stamped row whose
    /// lifetime becomes unreadable between a STEER flush's read and its write
    /// is not typed and stays held, exactly that row; readable again, it is
    /// typed once. The queue control: the same through a queue flush.
    #[test]
    fn an_unreadable_lifetime_at_the_write_keeps_the_held_row_in_steer_and_queue() {
        for mode in ["steer", "queue"] {
            let Some(t) = Lifetime::with_mode(&format!("late-{mode}"), mode) else { return };
            let home = t.home().unwrap();
            busy(&t.s, "dev");
            telemetry::record_held_for(&t.s, "dev", "[tmm chat 03:04] human: @dev LATE-116", 0, "", Some(&home)).unwrap();
            let id = telemetry::held_rows(&t.s, "dev")[0].id;
            if mode == "steer" {
                // Overdue in a running steer turn: flushed by `flush_steered`.
                sql(&format!("UPDATE deliveries SET ts = ts - {HOLD_MAX_SECS} WHERE id = {id}"));
            } else {
                end(&t.s, "dev");
            }
            let dir = t.home_dir();
            *BEFORE_FINAL.lock().unwrap() = Some(Box::new(move || {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
            }));
            flush(&t.s, "dev");
            *BEFORE_FINAL.lock().unwrap() = None;
            t.unreadable(false);
            t.settle();
            assert!(!t.shown().contains("LATE-116"), "{mode}: typed while unreadable: {:?}", t.shown());
            let rows = telemetry::held_rows(&t.s, "dev");
            assert_eq!(rows.iter().map(|r| (r.id, r.home.clone())).collect::<Vec<_>>(), vec![(id, Some(home.clone()))], "{mode}: the same row, still held");
            flush(&t.s, "dev");
            t.settle();
            flush(&t.s, "dev");
            t.settle();
            assert_eq!(t.shown().matches("LATE-116").count(), 2, "{mode}: typed once when readable (cat echoes it): {:?}", t.shown());
            assert_eq!(held(&t.s, "dev"), 0);
        }
    }

    /// A steer flush writes under the ONE observation it took before the
    /// retire (#117 F1): a home that turns unreadable after it does not stop
    /// the line, because the guard still binds the write to the checked
    /// server, pane and process. Typed once; nothing kept; nothing said.
    #[test]
    fn a_steer_flush_writes_under_its_one_observation_once() {
        let Some(t) = Lifetime::with_mode("post-steer", "steer") else { return };
        let home = t.home().unwrap();
        busy(&t.s, "dev");
        telemetry::record_held_for(&t.s, "dev", "[tmm chat 03:05] human: @dev BOUND-116", 0, "", Some(&home)).unwrap();
        let id = telemetry::held_rows(&t.s, "dev")[0].id;
        sql(&format!("UPDATE deliveries SET ts = ts - {HOLD_MAX_SECS} WHERE id = {id}"));
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = calls.clone();
        *BEFORE_FINAL.lock().unwrap() = Some(Box::new(move || {
            seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }));
        let dir = t.home_dir();
        AFTER_LIFETIME.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        })));
        flush(&t.s, "dev");
        *BEFORE_FINAL.lock().unwrap() = None;
        AFTER_LIFETIME.with(|h| *h.borrow_mut() = None);
        t.unreadable(false);
        t.settle();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1, "one observation, before the retire");
        assert_eq!(t.shown().matches("BOUND-116").count(), 2, "typed once (cat echoes it): {:?}", t.shown());
        assert_eq!(held(&t.s, "dev"), 0);
        assert!(warns(&t.s).iter().all(|w| !w.contains("BOUND-116")), "{:?}", warns(&t.s));
    }

    /// Poll (with a deadline) until the pane's stand-in is in its read loop:
    /// its process has a `dd` child waiting for the next byte (the per-byte
    /// stand-ins of the #117 tests). A guessed sleep raced a slow host.
    fn reading(pane: &str) {
        let reads = || {
            let pid = crate::tmux::pane_format(pane, "#{pane_pid}").unwrap_or_default().trim().to_string();
            let out = std::process::Command::new("ps").args(["-e", "-o", "pid=,ppid=,comm="]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
            let procs: Vec<(String, String, String)> = out.lines().filter_map(|l| { let mut f = l.split_whitespace(); Some((f.next()?.to_string(), f.next()?.to_string(), f.next()?.to_string())) }).collect();
            // a `dd` whose ancestry reaches the pane's own process
            procs.iter().filter(|(_, _, c)| c == "dd").any(|(_, parent, _)| {
                let mut up = parent.clone();
                for _ in 0..8 {
                    if up == pid { return true; }
                    match procs.iter().find(|(p, _, _)| *p == up) { Some((_, pp, _)) => up = pp.clone(), None => return false }
                }
                false
            })
        };
        let ready = (0..200).any(|_| reads() || { std::thread::sleep(std::time::Duration::from_millis(25)); false });
        assert!(ready, "{pane}: the stand-in never started reading");
    }

    /// A pane whose process logs every byte it reads, with its pid, into one
    /// file across respawns: what a process received is read from the log.
    fn logging_stand_in(t: &Lifetime) -> (String, String, std::path::PathBuf) {
        let log = std::path::Path::new(&t.scratch.path()).join("keys.log");
        let keys = std::path::Path::new(&t.scratch.path()).join("keys-log.sh");
        std::fs::write(&keys, format!("stty raw -echo\nwhile :; do k=$(dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' '); printf '%s key:%s\\n' \"$$\" \"$k\" >> {}; done\n", log.display())).unwrap();
        let run = format!("bash -c 'exec -a kiro-cli bash {}'", keys.display());
        let pane = format!("={}:dev", t.s);
        crate::tmux::run_tmux(&["respawn-pane", "-k", "-t", &pane, &run]).unwrap();
        reading(&pane);
        (pane, run, log)
    }
    fn keys_of(log: &std::path::Path, pid: &str) -> Vec<String> {
        std::fs::read_to_string(log).unwrap_or_default().lines().filter(|l| l.starts_with(&format!("{pid} "))).map(|l| l.split_once(' ').unwrap().1.to_string()).collect()
    }

    /// #117 F1 (validator-2's probe on the retired path): a HELD steer line,
    /// flushed into a running steer turn (`flush_steered`, rows retired
    /// before the keys, #276), whose write tmux refuses AFTER the retire, the
    /// pane's process replaced inside the write before its text or between
    /// its text and its Enter. The stated bound: one report, and never typed
    /// again: not into the new process, not after the turn ends.
    #[test]
    fn a_held_steer_line_refused_after_its_retire_is_said_once_and_never_retyped() {
        for at in ["text", "enter"] {
            let Some(t) = Lifetime::with_mode(&format!("steer-retired-{at}"), "steer") else { return };
            let (pane, run, log) = logging_stand_in(&t);
            let home = t.home().unwrap();
            busy(&t.s, "dev");
            let line = format!("[tmm chat 18:00] human: @dev RETIRED-{at}-117");
            telemetry::record_held_for(&t.s, "dev", &line, 0, "", Some(&home)).unwrap();
            let id = telemetry::held_rows(&t.s, "dev")[0].id;
            sql(&format!("UPDATE deliveries SET ts = ts - {HOLD_MAX_SECS} WHERE id = {id}"));
            let old = crate::tmux::pane_format(&pane, "#{pane_pid}").unwrap();
            let respawn: Box<dyn FnOnce()> = Box::new(move || {
                crate::tmux::run_tmux(&["respawn-pane", "-k", "-t", &pane, &run]).unwrap();
                reading(&pane);
            });
            if at == "text" { AFTER_LIFETIME.with(|h| *h.borrow_mut() = Some(respawn)); } else { crate::tmux::BEFORE_ENTER.with(|h| *h.borrow_mut() = Some(respawn)); }
            flush(&t.s, "dev");
            AFTER_LIFETIME.with(|h| *h.borrow_mut() = None);
            crate::tmux::BEFORE_ENTER.with(|h| *h.borrow_mut() = None);
            let new = crate::tmux::pane_format(&format!("={}:dev", t.s), "#{pane_pid}").unwrap();
            assert_ne!(old, new, "{at}: a new process");
            assert_eq!(held(&t.s, "dev"), 0, "{at}: retired before the keys (#276), not re-held");
            end(&t.s, "dev");
            flush(&t.s, "dev");
            t.settle();
            let enters = |v: &[String]| v.iter().filter(|k| k.as_str() == "key:\\r").count();
            let (first, second) = (keys_of(&log, old.trim()), keys_of(&log, new.trim()));
            eprintln!("[DEBUG-117] steer retired, refused at {at}: old process {} keys {} Enter, new process {} keys", first.len(), enters(&first), second.len());
            assert_eq!(enters(&first), 0, "{at}: the old process never got the Enter");
            assert!(second.is_empty(), "{at}: the new process got nothing: {second:?}");
            let said: Vec<String> = warns(&t.s).into_iter().filter(|w| w.contains(&format!("RETIRED-{at}-117"))).collect();
            assert_eq!(said.len(), 1, "{at}: said once: {said:?}");
            assert!(said[0].starts_with("undelivered (the pane is not the one checked: "), "{at}: {said:?}");
        }
    }

    /// Board #117, measured first: a pane id is unique only within one tmux
    /// SERVER. The write is paused after its lifetime check (or between its
    /// text and its Enter); the project owning the server's last session is
    /// deleted, so the server exits; a same-name project and agent start a
    /// NEW server whose `dev` pane gets the same `%N`; the write resumes. The
    /// new pane runs a stand-in that prints every byte it reads
    /// (`key:<od -c>`), so even a lone Enter shows.
    fn replace_server(s: &str, path: &str) {
        let before = crate::tmux::server_incarnation().ok();
        let old_home = crate::projects::asks::home_id(s, "dev").ok().flatten();
        let old_pane = crate::tmux::run_tmux(&["display-message", "-p", "-t", &format!("={s}:dev"), "#{pane_id}"]).unwrap_or_default();
        crate::projects::delete(s).expect("the project deleted");
        assert!((0..100).any(|_| crate::tmux::server_incarnation().is_err() || { std::thread::sleep(std::time::Duration::from_millis(50)); false }), "the server exited with its last session");
        crate::projects::with_store(|st| st.insert_project(&crate::projects::Project {
            id: s.into(), name: s.into(), path: path.into(), icon: None,
            session: s.into(), adopted: false, autostart: false, created_at: 1,
            last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        })).unwrap();
        let home = std::path::Path::new(path).join(".tmm").join("agents").join("dev");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "input_mode": "queue", "cmd": "x" }).to_string()).unwrap();
        let keys = std::path::Path::new(path).join("keys117.sh");
        std::fs::write(&keys, "stty raw -echo\nwhile :; do k=$(dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' '); printf 'key:%s\\r\\n' \"$k\"; done\n").unwrap();
        assert!(std::process::Command::new("tmux").args(["new-session", "-d", "-s", s, "-n", "keep", "-c", path, "cat"]).status().is_ok_and(|st| st.success()));
        crate::tmux::run_tmux(&["new-window", "-d", "-t", &format!("={s}:"), "-n", "dev", "-c", path, &format!("bash -c 'exec -a kiro-cli bash {}'", keys.display())]).unwrap();
        reading(&format!("={s}:dev"));
        let after = crate::tmux::server_incarnation().ok();
        let new_pane = crate::tmux::run_tmux(&["display-message", "-p", "-t", &format!("={s}:dev"), "#{pane_id}"]).unwrap_or_default();
        let new_home = crate::projects::asks::home_id(s, "dev").ok().flatten();
        eprintln!("[DEBUG-117] server {before:?} -> {after:?}; pane {} -> {}; home {old_home:?} -> {new_home:?}", old_pane.trim(), new_pane.trim());
        assert_ne!(before, after, "a new server");
        assert_eq!(old_pane.trim(), new_pane.trim(), "the same %N in it");
        assert_ne!(old_home, new_home, "another lifetime");
    }
    fn keys_in(s: &str) -> Vec<String> {
        crate::tmux::capture_pane_plain(&format!("={s}:dev"), Some(0)).unwrap_or_default().lines().filter(|l| l.starts_with("key:")).map(|l| l.trim_end().to_string()).collect()
    }

    #[test]
    fn a_line_paused_after_its_check_never_reaches_a_new_servers_pane() {
        let mut typed_into = Vec::new();
        for case in ["immediate", "held", "enter"] {
            let Some(t) = Lifetime::new(&format!("srv-{case}")) else { return };
            let home = t.home().unwrap();
            let target = t.target();
            let (s, path) = (t.s.clone(), t.scratch.path());
            let replace: Box<dyn FnOnce()> = Box::new(move || replace_server(&s, &path));
            let line = format!("[tmm chat 16:50] human: @dev SERVER-{case}-117");
            match case {
                "immediate" => {
                    AFTER_LIFETIME.with(|h| *h.borrow_mut() = Some(replace));
                    deliver_for(&t.s, "dev", &target, &line, 0, "", Some(&home));
                }
                "held" => {
                    busy(&t.s, "dev");
                    assert!(deliver_for(&t.s, "dev", &target, &line, 0, "", Some(&home)));
                    assert_eq!(held(&t.s, "dev"), 1);
                    end(&t.s, "dev");
                    AFTER_LIFETIME.with(|h| *h.borrow_mut() = Some(replace));
                    flush(&t.s, "dev");
                }
                _ => {
                    crate::tmux::BEFORE_ENTER.with(|h| *h.borrow_mut() = Some(replace));
                    deliver_for(&t.s, "dev", &target, &line, 0, "", Some(&home));
                }
            }
            AFTER_LIFETIME.with(|h| *h.borrow_mut() = None);
            crate::tmux::BEFORE_ENTER.with(|h| *h.borrow_mut() = None);
            t.settle();
            let keys = keys_in(&t.s);
            eprintln!("[DEBUG-117] {case}: the new server's pane read {} keys: {:?}", keys.len(), keys.iter().take(6).collect::<Vec<_>>());
            if !keys.is_empty() {
                typed_into.push((case, keys));
            }
            // Refused natively, the line was kept and then judged by its
            // lifetime: no row is left for the new agent, and it was said.
            if case == "held" {
                flush(&t.s, "dev");
            }
            assert_eq!(held(&t.s, "dev"), 0, "{case}: nothing kept for another lifetime");
            assert!(warns(&t.s).iter().any(|w| w.starts_with(&format!("undelivered ({REPLACED_REASON})")) && w.contains(&format!("SERVER-{case}-117"))), "{case}: {:?}", warns(&t.s));
            let _ = crate::tmux::run_tmux(&["kill-session", "-t", &format!("={}", t.s)]);
        }
        assert!(typed_into.is_empty(), "a new server's pane was typed into: {typed_into:?}");
    }

    /// #117 (leader's point i): the guard binds the pane's PROCESS too. A
    /// pane respawned between a line's text and its Enter (same server, same
    /// %id, same home: a restarted CLI) refuses the Enter natively; the text
    /// reached only the old process, never submitted, and the kept line is
    /// typed once, whole, into the new one. Queue and steer alike: at most
    /// once into any one process.
    #[test]
    fn a_write_refused_between_text_and_enter_reaches_the_new_process_once() {
        for mode in ["queue", "steer"] {
            let Some(t) = Lifetime::with_mode(&format!("proc-{mode}"), mode) else { return };
            let (pane, run, log) = logging_stand_in(&t);
            let home = t.home().unwrap();
            let old = crate::tmux::pane_format(&pane, "#{pane_pid}").unwrap();
            let (p2, r2) = (pane.clone(), run.clone());
            crate::tmux::BEFORE_ENTER.with(|h| *h.borrow_mut() = Some(Box::new(move || {
                crate::tmux::run_tmux(&["respawn-pane", "-k", "-t", &p2, &r2]).unwrap();
                reading(&p2);
            })));
            if mode == "steer" {
                busy(&t.s, "dev");
            }
            let line = format!("[tmm chat 17:00] human: @dev PROC-{mode}-117");
            deliver(&t.s, "dev", &t.target(), &line, 0, "");
            crate::tmux::BEFORE_ENTER.with(|h| *h.borrow_mut() = None);
            let new = crate::tmux::pane_format(&pane, "#{pane_pid}").unwrap();
            assert_ne!(old, new, "{mode}: a new process in the same pane");
            assert_eq!(t.home().unwrap(), home, "{mode}: the same lifetime");
            assert_eq!(held(&t.s, "dev"), 1, "{mode}: the refused line is kept");
            if mode == "steer" {
                end(&t.s, "dev");
            }
            flush(&t.s, "dev");
            t.settle();
            let (first, second) = (keys_of(&log, old.trim()), keys_of(&log, new.trim()));
            let enters = |v: &[String]| v.iter().filter(|k| k.as_str() == "key:\\r").count();
            eprintln!("[DEBUG-117] {mode}: old process {} keys, {} Enter; new process {} keys, {} Enter", first.len(), enters(&first), second.len(), enters(&second));
            assert_eq!(enters(&first), 0, "{mode}: the old process never got the Enter");
            assert_eq!(enters(&second), 1, "{mode}: the new process got the line once");
            assert_eq!(second.len(), line.replace('@', "\u{ff20}").len() + 1, "{mode}: every byte of the typed line, then its Enter");
            assert_eq!(held(&t.s, "dev"), 0);
        }
    }

    /// A restart keeps the home, so the lifetime: a held line is typed into
    /// the restarted agent once (#77). A rename changes the label only: its
    /// held line is kept and typed once too.
    #[test]
    fn a_restart_and_a_rename_keep_the_lifetime_and_get_their_line_once() {
        let Some(t) = Lifetime::new("restart-life") else { return };
        let home = t.home().unwrap();
        t.hold("RESTARTED-116");
        let index = t.index();
        crate::tmux::run_tmux(&["kill-window", "-t", &format!("={}:dev", t.s)]).unwrap();
        t.window(Some(&index));
        assert_eq!(t.home().unwrap(), home, "the same home, the same lifetime");
        end(&t.s, "dev");
        flush(&t.s, "dev");
        t.settle();
        assert_eq!(t.shown().matches("RESTARTED-116").count(), 2, "typed once (cat echoes it): {:?}", t.shown());

        crate::projects::names::rename(&t.s, "dev", Some("robin")).expect("renamed");
        t.hold("RENAMED-116");
        assert_eq!(held(&t.s, "dev"), 1, "kept across the rename");
        end(&t.s, "dev");
        flush(&t.s, "dev");
        t.settle();
        assert_eq!(t.shown().matches("RENAMED-116").count(), 2, "typed once: {:?}", t.shown());
    }

}
