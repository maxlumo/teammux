//! A turn that ended without saying anything (board #355).
//!
//! kiro-cli v3 closes a turn that produced no assistant message with a
//! placeholder of its own, and its Stop hook hands that text over as the reply.
//! The room log holds 27 such lines between 2026-10-12 and 10-15, from eight
//! agents. The causes differ — a tool call that hit the CLI's 1 700 s limit, a
//! turn that ended at ~75% context, a status line reading `Midway: expired`
//! (hypotheses on the issue, not all measured) — and the effect is one: the
//! agent is at REST with its work half done, the delivery landed, the hooks
//! derived `idle` correctly, and nothing in our design tells it to resume.
//! Lost time: 30 minutes to three hours each, until a person happened to look.
//!
//! The smallest thing in our layer, in two parts:
//!
//! * **The fact is on the status** (`telemetry`): the idle the end derives
//!   carries the detail `last_turn_empty`, as a failed end carries
//!   `last_turn_failed` (#354) — readable on the card and in `tmm agent list`,
//!   not a state and not a colour.
//! * **One nudge**, here. [`NUDGE_AFTER`] later, if the agent is STILL at rest
//!   after that very end, holds an issue in `doing`, and is not waiting on
//!   purpose, it is typed one line naming its open item(s). One per run of
//!   empty turns, spent by a line DELIVERED and not by a timer set: a nudge
//!   that itself ends empty earns no second (that would be a retry loop), two
//!   empty turns before any nudge send one for the latest, and only a turn
//!   that ends with a REAL reply forgives it (a Stop with no usable text
//!   neither forgives nor nudges). ONE timer per agent, held by a lease only
//!   its holder can release, so the sleepers are bounded by the windows. Nothing here resumes arbitrary work,
//!   and nothing is persisted — a restart forgets a pending nudge, which is the
//!   right amount of memory for a safety net (tenet 7: the running state is a
//!   disposable projection).
//!
//! "Waiting on purpose" is the false positive that matters: an agent that
//! started a `tmm task --wake` and ended its turn is ALSO a turn with no
//! message. A pending wake that addresses it, or any task still running in the
//! project, means it was told to wait, so it is left alone.

use std::time::Duration;

use super::telemetry::{Due, NudgeWait};

/// How long an agent may sit at rest after an empty turn before it is nudged.
/// Long enough that the agent that simply started something and stopped has
/// started again, short enough to save the half hour the incidents lost.
pub const NUDGE_AFTER: Duration = Duration::from_secs(300);

/// An empty end was just recorded for `window`: owe it at most one nudge.
pub fn on_empty_end(session: &str, window: &str) {
    watch(session, window, NUDGE_AFTER, fire);
}

/// Start the window's nudge timer unless one already holds its lease. ONE per
/// agent: a second empty end before it fires does not start a second, it
/// becomes the end the same timer answers (see `telemetry::nudge_wait`), so the
/// sleepers are bounded by the number of windows and two empty turns before any
/// nudge send exactly one — for the latest. The allowance is spent only when a
/// line is delivered (`fire_with`), not when a timer is set.
///
/// The lease is a TOKEN, and only its holder releases it: the timer frees it
/// when it decides it is done (`NudgeWait::Gone`, so an empty end arriving at
/// once finds it free and is not lost) and again when its thread ends for any
/// reason — and that second release must not free a LATER timer's lease, which
/// a plain flag did (review P1-1).
///
/// This is a thread and not `wakes::schedule` on purpose: a wake is a persisted
/// room message that fires unconditionally, and what makes this nudge due is
/// memory only — which end was empty, whether the agent has moved on since. A
/// wake that outlived a restart could not re-check any of it, and one that
/// could not be cancelled would type "continue" into an agent that already had.
fn watch(session: &str, window: &str, after: Duration, act: impl Fn(&str, &str, Due) + Send + 'static) {
    let Some(token) = super::telemetry::arm_nudge(session, window) else { return };
    let (session, window) = (session.to_string(), window.to_string());
    std::thread::spawn(move || {
        // The lease is released however the thread ends, a panic included.
        struct Release<'a>(&'a str, &'a str, u64);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                super::telemetry::disarm_nudge(self.0, self.1, self.2);
            }
        }
        let _release = Release(&session, &window, token);
        let mut answered = 0;
        loop {
            match super::telemetry::nudge_wait(&session, &window, token, after.as_secs(), answered) {
                NudgeWait::Wait(secs) => std::thread::sleep(Duration::from_secs(secs)),
                NudgeWait::Due(due) => {
                    act(&session, &window, due);
                    answered = due.end_seq;
                }
                NudgeWait::Gone => return,
            }
        }
    });
}

fn fire(session: &str, window: &str, due: Due) {
    fire_with(
        session,
        window,
        due,
        &|| open_items(session, window),
        &|| waiting_on_purpose(session, window),
        &|line, still_due| match super::delivery::agent_target(session, window) {
            Some(target) => super::delivery::deliver_if(session, window, &target, line, still_due),
            None => false,
        },
    );
}

/// The decision and its one effect, with the outside facts injected. `waiting`
/// is `None` when it COULD NOT BE CHECKED, which is not "nothing is pending": an
/// input into someone's pane is made only on what was actually seen. (An
/// unreadable board needs no such third value — no open item is no nudge
/// either way.)
///
/// `deliver` gets the line and `still_due`, and must ask it in the same step as
/// the typing (`delivery::deliver_if` does, inside the window's lock). The check
/// below is only the cheap early exit before the queries; the queries take
/// time, and a prompt, an ask or an interrupt can arrive while they run. The
/// allowance is spent only by a line that was actually delivered, and against
/// the run the nudge was decided in.
fn fire_with(
    session: &str,
    window: &str,
    due: Due,
    open_items: &dyn Fn() -> Vec<(i64, String)>,
    waiting: &dyn Fn() -> Option<bool>,
    deliver: &dyn Fn(&str, &dyn Fn() -> bool) -> bool,
) {
    let still_due = || super::telemetry::nudge_still_due(session, window, due.end_seq);
    if !still_due() {
        return;
    }
    let open = open_items();
    if open.is_empty() || waiting() != Some(false) {
        return;
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    if deliver(&nudge_line(&stamp, &open), &still_due) {
        super::telemetry::spend_nudge(session, window, due.run);
    }
}

/// The one line. `[reply]` marks it as an answer-shaped notice, so replying to
/// it creates no edge back to a sender that is not an agent. The titles are
/// quoted text: de-addressed, so an `@` in one routes nowhere.
fn nudge_line(stamp: &str, open: &[(i64, String)]) -> String {
    let items = open
        .iter()
        .map(|(id, title)| format!("#{id} {}", crate::address::unaddressed(title)))
        .collect::<Vec<_>>()
        .join("; ");
    format!(
        "[tmm chat {stamp}] tmm: [reply] your previous turn ended without a response (the CLI closed it with its placeholder). \
         Your open item: {items}. Continue it — `tmm board show` has the thread — or say what blocks you."
    )
}

/// The issues assigned to `window` and in `doing`: what it was in the middle of.
fn open_items(session: &str, window: &str) -> Vec<(i64, String)> {
    let Ok(board) = super::board_list(session) else { return Vec::new() };
    board["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["assignee"].as_str() == Some(window) && i["status"].as_str() == Some("doing"))
        .filter_map(|i| {
            let id = i["id"].as_i64()?;
            Some((id, super::issue_ref(i["title"].as_str().unwrap_or(""), i["body"].as_str().unwrap_or(""), id)))
        })
        .collect()
}

/// Was the agent told to wait? `None` when that could not be checked.
fn waiting_on_purpose(session: &str, window: &str) -> Option<bool> {
    waiting_from(session, window, super::wakes::try_pending(Some(session)), crate::tasks::try_list())
}

/// The reading, with both sources handed in. A pending wake that addresses the
/// agent — by name or by `@all`, the one reading `wakes::addressed_to` gives
/// everyone — or a task still running in the project (a `Task` does not record
/// who started it, so any running task counts: fewer nudges is the safe error)
/// means it was told to wait. A source that failed is "could not check", never
/// "nothing is pending": `wakes::pending` and `tasks::list` read an error as an
/// empty list, which is right for a screen and wrong for a decision to type.
fn waiting_from(
    session: &str,
    window: &str,
    wakes: Result<Vec<super::store::Wake>, String>,
    tasks: Result<Vec<crate::tasks::Task>, String>,
) -> Option<bool> {
    let (wakes, tasks) = (wakes.ok()?, tasks.ok()?);
    Some(wakes.iter().any(|w| super::wakes::addressed_to(w, window)) || task_running_in(session, &tasks))
}

fn task_running_in(session: &str, tasks: &[crate::tasks::Task]) -> bool {
    tasks.iter().any(|t| t.session == session && matches!(t.state, crate::tasks::State::Running))
}

#[cfg(test)]
mod tests {
    use super::super::telemetry::{
        arm_nudge, disarm_nudge, nudge_still_due, nudge_wait, record_held, record_interrupt,
        record_notification_with, record_prompt, record_typed, spend_nudge,
    };
    use super::*;
    use crate::backends::EndQuality;
    use std::sync::{Arc, Mutex};

    fn unique() -> String {
        format!("stall-{}", uuid::Uuid::new_v4())
    }

    /// An empty end, recorded the way the consumer does: ONE write, the end
    /// and how it ended. Returns the arrival number of that end.
    fn empty_end(session: &str, window: &str) -> u64 {
        record_notification_with(session, window, "completed", super::super::now(), EndQuality::Empty);
        super::super::telemetry::turn_epoch(session, window)
    }

    /// An end with something to say.
    fn real_end(session: &str, window: &str) {
        record_notification_with(session, window, "completed", super::super::now(), EndQuality::Said);
    }

    /// An end whose reply was unavailable (no body, blank, unreadable).
    fn unknown_end(session: &str, window: &str) {
        record_notification_with(session, window, "completed", super::super::now(), EndQuality::Unknown);
    }

    /// The nudge the window is owed now, read the way a timer reads it.
    fn due_of(session: &str, window: &str) -> Due {
        let token = arm_nudge(session, window).expect("an empty end is owed a nudge");
        let due = match nudge_wait(session, window, token, 0, 0) {
            NudgeWait::Due(due) => due,
            other => panic!("expected Due, got {other:?}"),
        };
        disarm_nudge(session, window, token);
        due
    }

    #[test]
    fn the_line_names_the_open_items_and_cannot_address_anyone() {
        let line = nudge_line("2026-10-15 13:30", &[(12, "Fix the @all delivery".into()), (14, "Second".into())]);
        assert!(line.starts_with("[tmm chat 2026-10-15 13:30] tmm: [reply] your previous turn ended without a response"), "{line}");
        assert!(line.contains("Your open item: #12 Fix the ＠all delivery; #14 Second."), "{line}");
        assert!(crate::address::mention_names(&line).is_empty(), "a title's @ routes nowhere: {line}");
        // The line as the agent's turn will see it: no requester, so the turn it
        // starts has no edge to answer along — a reply to a nudge goes nowhere
        // new, and no reverse edge is created to `tmm`.
        assert_eq!(crate::address::requesters(&line), Vec::<String>::new(), "{line}");
    }

    /// The run of empty turns is owed ONE nudge, and the allowance is spent by a
    /// nudge DELIVERED — not by a timer set. A nudge that itself ends empty earns
    /// none (that is a retry loop); a turn that ends with a real reply forgives it.
    #[test]
    fn one_nudge_per_run_of_empty_turns() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        assert!(arm_nudge(&s, w).is_none(), "no turn, nothing owed");
        empty_end(&s, w);
        let token = arm_nudge(&s, w).expect("the first empty end is owed a nudge");
        assert!(arm_nudge(&s, w).is_none(), "one timer, not two");
        // Cancelled before it sent anything (the timer is released): the
        // allowance is NOT spent, the next empty end is owed it still.
        disarm_nudge(&s, w, token);
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        empty_end(&s, w);
        let due = due_of(&s, w);
        let token = arm_nudge(&s, w).expect("a timer that never delivered spent nothing");
        disarm_nudge(&s, w, token);
        // Delivered: spent. The nudge starts a turn that ends empty AGAIN: no second.
        spend_nudge(&s, w, due.run);
        record_prompt(&s, w, "[tmm chat 10:05] tmm: [reply] nudge");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w).is_none(), "an empty answer to a nudge is not a reason for another");
        // A turn that says something forgives it.
        record_prompt(&s, w, "[tmm chat 10:10] human: continue");
        real_end(&s, w);
        empty_end(&s, w);
        assert!(arm_nudge(&s, w).is_some(), "after the agent spoke, the next empty turn is owed one again");
    }

    /// Two empty turns before any nudge: exactly ONE nudge, for the latest, from
    /// ONE timer (reviewer P2: the first timer's claim used to spend the
    /// allowance and leave the second end unanswered).
    #[test]
    fn two_empty_turns_before_a_nudge_send_exactly_one_for_the_latest() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        let first = empty_end(&s, w);
        let acted = Arc::new(Mutex::new(Vec::new()));
        let (log, s2, w2) = (acted.clone(), s.clone(), w.to_string());
        watch(&s, w, Duration::from_secs(1), move |_, _, due| {
            log.lock().unwrap().push(due.end_seq);
            // Delivering it spends the allowance, as `fire_with` does.
            spend_nudge(&s2, &w2, due.run);
        });
        // A second timer for the same window is refused while the first holds the lease.
        let log2 = acted.clone();
        watch(&s, w, Duration::from_secs(1), move |_, _, _| log2.lock().unwrap().push(u64::MAX));
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        let second = empty_end(&s, w);
        assert!(second > first);
        std::thread::sleep(Duration::from_millis(3500));
        assert_eq!(*acted.lock().unwrap(), vec![second], "one timer, one nudge, for the end that is still the newest");
        assert!(arm_nudge(&s, w).is_none(), "and the allowance is spent");
    }

    /// A timer that finds the agent moved on says nothing and releases itself.
    #[test]
    fn a_timer_that_finds_the_agent_moved_on_releases_itself() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        let token = arm_nudge(&s, w).unwrap();
        assert_eq!(nudge_wait(&s, w, token, 0, end), NudgeWait::Gone, "an end it already answered is not looked at again");
        assert!(arm_nudge(&s, w).is_some(), "and the Gone step released the lease");
        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        let token = arm_nudge(&s, w).unwrap();
        empty_end(&s, w);
        assert!(matches!(nudge_wait(&s, w, token, 600, 0), NudgeWait::Wait(secs) if secs > 0 && secs <= 600), "a fresh end has not aged");
        assert!(matches!(nudge_wait(&s, w, token, 0, 0), NudgeWait::Due(due) if due.end_seq > end), "aged: due, for the NEWEST end");
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        assert_eq!(nudge_wait(&s, w, token, 0, 0), NudgeWait::Gone);
        assert!(arm_nudge(&s, w).is_none(), "no empty end is newest any more");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w).is_some(), "released in the same step as Gone: a new empty end finds the lease free");
    }

    /// Review P1-1, with no sleeps: the interleaving that broke the bool. The old
    /// timer reaches Gone and frees the lease; a new empty end arms a new timer;
    /// THEN the old thread ends and its drop guard releases. That release must be
    /// the old timer's own and find nothing to free — a third empty end must not
    /// get a second live timer. Dropping the Gone-step release instead would
    /// reopen the gap it closes, so the new end is also shown to find the lease
    /// free the moment the old timer decides.
    #[test]
    fn an_old_timers_release_cannot_free_a_newer_timers_lease() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        let old = arm_nudge(&s, w).expect("the first timer");
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        assert_eq!(nudge_wait(&s, w, old, 0, 0), NudgeWait::Gone, "the old timer finds the agent moved on and releases");

        empty_end(&s, w);
        let new = arm_nudge(&s, w).expect("a new empty end finds the lease free: not lost in the Gone-to-drop gap");
        assert_ne!(old, new);

        disarm_nudge(&s, w, old); // the old thread ends: its drop guard runs AFTER the new timer armed
        record_prompt(&s, w, "[tmm chat 10:05] human: more");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w).is_none(), "a third empty end gets no second timer: the new owner still holds the lease");
        assert_eq!(nudge_wait(&s, w, old, 0, 0), NudgeWait::Gone, "a stale timer is Gone and does not touch it either");
        assert!(arm_nudge(&s, w).is_none());

        disarm_nudge(&s, w, new);
        assert!(arm_nudge(&s, w).is_some(), "only the holder can release it");
    }

    /// Review P1-2 and P2: only a REAL reply forgives the spent allowance, and a
    /// spend lands on the run it was decided in.
    #[test]
    fn only_a_real_reply_reopens_the_allowance_and_a_late_spend_cannot_charge_a_newer_run() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        let first = due_of(&s, w);
        spend_nudge(&s, w, first.run);
        // Stops with no usable text neither mark the end empty nor reopen the allowance.
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        unknown_end(&s, w);
        empty_end(&s, w);
        assert!(arm_nudge(&s, w).is_none(), "spent -> unavailable -> placeholder: no second nudge");
        // A real reply does.
        record_prompt(&s, w, "[tmm chat 10:05] human: continue");
        real_end(&s, w);
        empty_end(&s, w);
        let second = due_of(&s, w);
        assert!(second.run > first.run, "a real reply starts a newer run");
        // The first nudge's spend arrives late: it must not charge the new run.
        spend_nudge(&s, w, first.run);
        assert!(arm_nudge(&s, w).is_some(), "spent -> real reply -> placeholder: one nudge");
    }

    /// Review P1-B(1): how a turn ended belongs to THAT end. A human's interrupt
    /// that lands right after an empty stop is its own end — it does not inherit
    /// the mark and is not nudged for it.
    #[test]
    fn an_interrupt_after_an_empty_stop_does_not_inherit_its_emptiness() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        assert_eq!(super::super::telemetry::derive(&s, w, 0).detail, super::super::telemetry::EMPTY_DETAIL);
        record_interrupt(&s, w);
        let after = super::super::telemetry::derive(&s, w, 0);
        assert_eq!((after.state.as_str(), after.detail.as_str()), ("idle", ""), "the interrupt is a plain rest");
        assert!(arm_nudge(&s, w).is_none(), "and owes nobody a nudge");
    }

    #[test]
    fn it_is_still_due_only_while_nothing_has_happened_since_that_end() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        assert!(nudge_still_due(&s, w, end));
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        assert!(!nudge_still_due(&s, w, end), "a new turn since: the agent moved on");
        real_end(&s, w);
        assert!(!nudge_still_due(&s, w, end), "a later real end is not that empty end");

        let end = empty_end(&s, w);
        assert!(nudge_still_due(&s, w, end));
        record_typed(&s, w, "[tmm chat 10:01] lead: @dev status?", 0, "m1");
        assert!(!nudge_still_due(&s, w, end), "a line typed to it and not yet echoed is newer input");

        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        record_held(&s, w, "[tmm chat 10:02] lead: @dev later", 0, "m2").unwrap();
        assert!(!nudge_still_due(&s, w, end), "a line held for it is newer input");

        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        record_interrupt(&s, w);
        assert!(!nudge_still_due(&s, w, end), "an interrupt since is a newer end");
    }

    /// `fire_with` on an empty end with the outside facts injected. `during` runs
    /// while the queries run (after the early check, before the delivery) — where
    /// a prompt, an ask or an interrupt can arrive. The stub delivery asks
    /// `still_due` the way `delivery::deliver_if` does, inside its own step.
    /// Returns what was typed and whether the run's allowance is spent.
    fn run_with(
        open: Vec<(i64, String)>,
        waiting: Option<bool>,
        delivered: bool,
        during: &dyn Fn(&str, &str),
    ) -> (Vec<String>, bool) {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        let due = due_of(&s, w);
        let sent = Arc::new(Mutex::new(Vec::new()));
        let out = sent.clone();
        fire_with(
            &s,
            w,
            due,
            &|| {
                during(&s, w);
                open.clone()
            },
            &|| waiting,
            &|line, still_due| {
                if !still_due() {
                    return false;
                }
                out.lock().unwrap().push(line.to_string());
                delivered
            },
        );
        let got = sent.lock().unwrap().clone();
        // Spent iff the run can no longer be owed a nudge: a fresh empty end after
        // the nudged turn would be owed one again, so ask the record.
        record_prompt(&s, w, "[tmm chat 10:30] tmm: [reply] x");
        empty_end(&s, w);
        (got, arm_nudge(&s, w).is_none())
    }

    fn run(open: Vec<(i64, String)>, waiting: bool, moved_on: bool, delivered: bool) -> (Vec<String>, bool) {
        let during = |s: &str, w: &str| {
            if moved_on {
                record_prompt(s, w, "[tmm chat 10:00] human: continue");
            }
        };
        run_with(open, Some(waiting), delivered, &during)
    }

    #[test]
    fn it_nudges_an_agent_that_is_still_at_rest_with_an_open_item() {
        let (sent, spent) = run(vec![(12, "Fix it".into())], false, false, true);
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(sent[0].contains("#12 Fix it"));
        assert!(spent, "a delivered nudge spends the run's allowance");
    }

    /// The pane refused the line (copy mode): nothing was delivered, so the
    /// allowance is still there.
    #[test]
    fn a_nudge_the_pane_refused_spends_nothing() {
        let (sent, spent) = run(vec![(12, "Fix it".into())], false, false, false);
        assert_eq!(sent.len(), 1);
        assert!(!spent, "not delivered, not spent");
    }

    #[test]
    fn it_leaves_alone_an_agent_with_nothing_open_one_told_to_wait_and_one_that_moved_on() {
        assert!(run(vec![], false, false, true).0.is_empty(), "nothing in `doing`: nothing to resume");
        assert!(run(vec![(12, "Fix it".into())], true, false, true).0.is_empty(), "a pending wake or a running task: it was told to wait");
        assert!(run(vec![(12, "Fix it".into())], false, true, true).0.is_empty(), "it started a turn since: it needs nobody");
    }

    /// The real readers behind the injected facts: the open items are the issues
    /// assigned to THIS window and in `doing`, and a pending wake that addresses
    /// the window means it was told to wait.
    #[test]
    fn the_real_readers_see_the_open_items_and_the_wakes() {
        crate::projects::tests::use_test_store();
        let s = unique();
        let save = |title: &str, status: &str, assignee: &str| {
            crate::projects::board_save(&s, None, Some(title), None, Some(status), Some(assignee), "human").unwrap()
        };
        let mine = save("Mine, doing", "doing", "dev");
        save("Mine, todo", "todo", "dev");
        save("Mine, review", "review", "dev");
        save("Theirs, doing", "doing", "lead");
        save("Nobody's, doing", "doing", "");
        assert_eq!(open_items(&s, "dev"), vec![(mine, "Mine, doing".to_string())], "only what it is in the middle of");
        assert!(open_items(&s, "ghost").is_empty());

        let wakes = |s: &str| crate::projects::wakes::try_pending(Some(s));
        let waiting = |s: &str, w: &str| waiting_from(s, w, wakes(s), Ok(vec![]));
        assert_eq!(waiting(&s, "dev"), Some(false), "nothing pending");
        let due = super::super::now() as i64 + 600;
        crate::projects::wakes::schedule(&s, "lead", "@dev check the build", due).unwrap();
        assert_eq!(waiting(&s, "dev"), Some(true), "a wake addressed to it: it was told to wait");
        assert_eq!(waiting(&s, "lead"), Some(false), "a wake for someone else says nothing about this agent");
        // The real task reader answers too (a tmux server may or may not be up here).
        assert!(matches!(waiting_on_purpose(&s, "dev"), Some(true) | None));
    }

    /// Review P1-C: a wake to `@all` is a reason to wait — `schedule` accepts it
    /// and a fired one reaches every agent — and a source that could not be read
    /// is "could not check", which types nothing.
    #[test]
    fn an_all_wake_is_waiting_and_an_unreadable_source_is_not_nothing() {
        crate::projects::tests::use_test_store();
        let s = unique();
        let due = super::super::now() as i64 + 600;
        let wake = |body: &str| crate::projects::wakes::schedule(&s, "lead", body, due).unwrap();
        let pending = || crate::projects::wakes::try_pending(Some(&s));
        let w_all = wake("@all stand-up in ten");
        assert_eq!(waiting_from(&s, "dev", pending(), Ok(vec![])), Some(true), "@all addresses everyone, dev included");
        assert_eq!(waiting_from(&s, "qa", pending(), Ok(vec![])), Some(true));
        crate::projects::wakes::cancel(&s, w_all.id, "lead").unwrap();
        wake("@qa only");
        assert_eq!(waiting_from(&s, "dev", pending(), Ok(vec![])), Some(false), "a named wake is not @all");

        assert_eq!(waiting_from(&s, "dev", Err("store busy".into()), Ok(vec![])), None, "wakes unreadable: could not check");
        assert_eq!(waiting_from(&s, "dev", pending(), Err("no server".into())), None, "tasks unreadable: could not check");
        assert_eq!(waiting_from(&s, "dev", Err("x".into()), Err("y".into())), None);
        let (sent, _) = run_with(vec![(12, "Fix it".into())], None, true, &|_, _| {});
        assert!(sent.is_empty(), "waiting could not be checked: nothing typed");
    }

    /// Review P1-B(2): the queries between the early check and the typing take
    /// time. A prompt, an ask, an interrupt or a line sent to the agent arriving
    /// in that gap drops the nudge — the delivery asks `still_due` again inside
    /// its own step. One positive control: the same run with nothing arriving
    /// types the line.
    #[test]
    fn a_newer_input_between_the_check_and_the_delivery_drops_the_nudge() {
        let open = || vec![(12, "Fix it".to_string())];
        let (sent, spent) = run_with(open(), Some(false), true, &|_, _| {});
        assert_eq!((sent.len(), spent), (1, true), "positive control: nothing arrived, one nudge");

        let arrive: [(&str, &dyn Fn(&str, &str)); 4] = [
            ("a new prompt", &|s, w| { record_prompt(s, w, "[tmm chat 10:00] human: continue"); }),
            ("an interrupt", &|s, w| record_interrupt(s, w)),
            ("a line typed to it", &|s, w| record_typed(s, w, "[tmm chat 10:01] lead: @dev status?", 0, "m1")),
            ("a line held for it", &|s, w| { record_held(s, w, "[tmm chat 10:02] lead: @dev later", 0, "m2").unwrap(); }),
        ];
        for (what, during) in arrive {
            let (sent, spent) = run_with(open(), Some(false), true, during);
            assert!(sent.is_empty(), "{what} arrived after the early check: the nudge is dropped, not typed over it");
            assert!(!spent, "{what}: a dropped nudge spends nothing");
        }
    }

    /// Review P2: the unit tests drive `fire_with` with a stub delivery, so the
    /// last line of defence — `fire` handing the gate to `delivery::deliver_if` —
    /// is not exercised by them (swapping in the ordinary `deliver` would pass).
    /// It cannot be driven without a real pane, so it is pinned at the source,
    /// the way this repo pins markup it cannot render: the production `fire`
    /// delivers through `deliver_if` and nothing else, and `fire_with` gives the
    /// delivery the same `still_due` it checked early. A live pane is what the
    /// validator's timing rows add on top.
    #[test]
    fn the_production_fire_path_delivers_through_the_gated_entry() {
        let src = include_str!("stalls.rs");
        let fire = &src[src.find("fn fire(session: &str, window: &str, due: Due) {").unwrap()..];
        let fire = &fire[..fire.find("/// The decision and its one effect").unwrap()];
        assert!(fire.contains("super::delivery::deliver_if(session, window, &target, line, still_due)"), "{fire}");
        for plain in ["deliver_chat_line", "delivery::deliver(", "deliver_as(", "deliver_with("] {
            assert!(!fire.contains(plain), "the nudge must not take the ungated path ({plain}): {fire}");
        }
        let with = &src[src.find("fn fire_with(").unwrap()..];
        let with = &with[..with.find("/// The one line.").unwrap()];
        assert!(with.contains("deliver(&nudge_line(&stamp, &open), &still_due)"), "fire_with must hand over the gate it checked early: {with}");
    }

    /// A `Task` does not record who started it, so a running task anywhere in the
    /// project is a reason to wait; another project's, or a finished one, is not.
    #[test]
    fn a_running_task_in_the_project_is_a_reason_to_wait() {
        use crate::tasks::State;
        let task = |session: &str, state: State| crate::tasks::Task {
            name: "t".into(),
            session: session.into(),
            window: "t".into(),
            pane: "%1".into(),
            cmd: "sleep 9".into(),
            state,
            pid: "1".into(),
            started: 0,
            dead_at: 0,
            wake_error: String::new(),
        };
        assert!(!task_running_in("p", &[]));
        assert!(task_running_in("p", &[task("p", State::Running)]));
        assert!(!task_running_in("p", &[task("q", State::Running)]), "another project's task says nothing");
        assert!(!task_running_in("p", &[task("p", State::Exited(0)), task("p", State::Killed("term".into()))]), "a finished task is not a reason to wait");
    }
}
