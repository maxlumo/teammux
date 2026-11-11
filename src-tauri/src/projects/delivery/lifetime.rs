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

/// The write's own checks with nothing written (F2): the restore gate, the
/// pane, then the lifetime, as `send_into_locked` runs them. A steer flush
/// asks this before it retires its rows.
#[cfg(not(test))]
pub(super) fn check_write(session: &str, window: &str, target: &str, expect: Option<&str>) -> Result<(), String> {
    super::gate(session, window, target, false)?;
    super::final_pane(session, window, target)?;
    lifetime_matches(session, window, expect)
}

/// `check_write` behind the tests' typing seam: a faked pane has no pane to
/// resolve, so only the lifetime is asked, as the faked write does.
#[cfg(test)]
pub(super) fn check_write(session: &str, window: &str, target: &str, expect: Option<&str>) -> Result<(), String> {
    if super::TYPED.with(|t| t.borrow().is_some()) {
        return lifetime_matches(session, window, expect);
    }
    super::gate(session, window, target, false)?;
    super::final_pane(session, window, target)?;
    lifetime_matches(session, window, expect)
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

    /// The stated bound of a steer flush (leader's ruling C): a lifetime that
    /// turns unreadable AFTER the pre-check, between the retire and the
    /// write, loses the line with ONE report in F1's own words, and it is
    /// never typed, then or after the repair.
    #[test]
    fn a_steer_line_lost_after_its_pre_check_is_said_unchecked_once_and_never_typed() {
        let Some(t) = Lifetime::with_mode("post-steer", "steer") else { return };
        let home = t.home().unwrap();
        busy(&t.s, "dev");
        telemetry::record_held_for(&t.s, "dev", "[tmm chat 03:05] human: @dev BOUND-116", 0, "", Some(&home)).unwrap();
        let id = telemetry::held_rows(&t.s, "dev")[0].id;
        sql(&format!("UPDATE deliveries SET ts = ts - {HOLD_MAX_SECS} WHERE id = {id}"));
        // The pane is resolved twice: the pre-check, then the write. Only the
        // second makes the home unreadable.
        let (dir, calls) = (t.home_dir(), std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)));
        let seen = calls.clone();
        *BEFORE_FINAL.lock().unwrap() = Some(Box::new(move || {
            use std::os::unix::fs::PermissionsExt;
            if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
            }
        }));
        flush(&t.s, "dev");
        *BEFORE_FINAL.lock().unwrap() = None;
        t.unreadable(false);
        t.settle();
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "pre-check, then the write");
        assert!(!t.shown().contains("BOUND-116"), "{:?}", t.shown());
        assert_eq!(held(&t.s, "dev"), 0, "retired before the keys (#276)");
        let said: Vec<String> = warns(&t.s).into_iter().filter(|w| w.contains("BOUND-116")).collect();
        assert_eq!(said, vec![format!("undelivered ({UNCHECKED}): [tmm chat 03:05] human: @dev BOUND-116")], "one report, F1's words");
        end(&t.s, "dev");
        flush(&t.s, "dev");
        t.settle();
        assert!(!t.shown().contains("BOUND-116"), "never typed after the repair: {:?}", t.shown());
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
