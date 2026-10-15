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
//!   that ends with something to say forgives it. ONE timer per agent, so the
//!   sleepers are bounded by the windows. Nothing here resumes arbitrary work,
//!   and nothing is persisted — a restart forgets a pending nudge, which is the
//!   right amount of memory for a safety net (tenet 7: the running state is a
//!   disposable projection).
//!
//! "Waiting on purpose" is the false positive that matters: an agent that
//! started a `tmm task --wake` and ended its turn is ALSO a turn with no
//! message. A pending wake that addresses it, or any task still running in the
//! project, means it was told to wait, so it is left alone.

use std::time::Duration;

/// How long an agent may sit at rest after an empty turn before it is nudged.
/// Long enough that the agent that simply started something and stopped has
/// started again, short enough to save the half hour the incidents lost.
pub const NUDGE_AFTER: Duration = Duration::from_secs(300);

/// An empty end was just recorded for `window`: owe it at most one nudge.
pub fn on_empty_end(session: &str, window: &str) {
    watch(session, window, NUDGE_AFTER, fire);
}

/// Start the window's nudge timer unless one is already waiting. ONE per agent:
/// a second empty end before it fires does not start a second, it becomes the
/// end the same timer answers (see `telemetry::nudge_wait`), so the sleepers
/// are bounded by the number of windows and two empty turns before any nudge
/// send exactly one — for the latest. The allowance is spent only when a line
/// is delivered (`fire_with`), not when a timer is set.
///
/// This is a thread and not `wakes::schedule` on purpose: a wake is a persisted
/// room message that fires unconditionally, and what makes this nudge due is
/// memory only — which end was empty, whether the agent has moved on since. A
/// wake that outlived a restart could not re-check any of it, and one that
/// could not be cancelled would type "continue" into an agent that already had.
fn watch(session: &str, window: &str, after: Duration, act: impl Fn(&str, &str, u64) + Send + 'static) {
    if !super::telemetry::arm_nudge(session, window) {
        return;
    }
    let (session, window) = (session.to_string(), window.to_string());
    std::thread::spawn(move || {
        // The timer is released however it ends, a panic included.
        struct Release<'a>(&'a str, &'a str);
        impl Drop for Release<'_> {
            fn drop(&mut self) {
                super::telemetry::disarm_nudge(self.0, self.1);
            }
        }
        let _release = Release(&session, &window);
        let mut answered = 0;
        loop {
            match super::telemetry::nudge_wait(&session, &window, after.as_secs(), answered) {
                super::telemetry::NudgeWait::Wait(secs) => std::thread::sleep(Duration::from_secs(secs)),
                super::telemetry::NudgeWait::Due(end_seq) => {
                    act(&session, &window, end_seq);
                    answered = end_seq;
                }
                super::telemetry::NudgeWait::Gone => return,
            }
        }
    });
}

fn fire(session: &str, window: &str, end_seq: u64) {
    fire_with(
        session,
        window,
        end_seq,
        &|| open_items(session, window),
        &|| waiting_on_purpose(session, window),
        &|line| super::deliver_chat_line(session, window, line),
    );
}

/// The decision and its one effect, with the three outside facts injected.
/// The allowance is spent only by a line that was actually delivered.
fn fire_with(
    session: &str,
    window: &str,
    end_seq: u64,
    open_items: &dyn Fn() -> Vec<(i64, String)>,
    waiting: &dyn Fn() -> bool,
    deliver: &dyn Fn(&str) -> bool,
) {
    // Still at rest after THIS end: a new turn since, or anything that ended
    // since, and the agent has already moved on.
    if !super::telemetry::nudge_still_due(session, window, end_seq) {
        return;
    }
    let open = open_items();
    if open.is_empty() || waiting() {
        return;
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    if deliver(&nudge_line(&stamp, &open)) {
        super::telemetry::spend_nudge(session, window);
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

/// Was the agent told to wait? A pending wake addressed to it, or a task still
/// running in the project (a `Task` does not record who started it, so any
/// running task counts — fewer nudges is the safe error).
fn waiting_on_purpose(session: &str, window: &str) -> bool {
    let wake_for_it = super::wakes::pending(Some(session))
        .iter()
        .any(|w| crate::address::mention_names(&w.body).iter().any(|n| n == window));
    wake_for_it || task_running_in(session, &crate::tasks::list())
}

fn task_running_in(session: &str, tasks: &[crate::tasks::Task]) -> bool {
    tasks.iter().any(|t| t.session == session && matches!(t.state, crate::tasks::State::Running))
}

#[cfg(test)]
mod tests {
    use super::super::telemetry::{
        arm_nudge, disarm_nudge, nudge_still_due, nudge_wait, record_held, record_interrupt,
        record_notification_with, record_prompt, record_typed, spend_nudge, NudgeWait,
    };
    use super::*;
    use std::sync::{Arc, Mutex};

    fn unique() -> String {
        format!("stall-{}", uuid::Uuid::new_v4())
    }

    /// An empty end, recorded the way the consumer does: ONE write, the end
    /// and how it ended. Returns the arrival number of that end.
    fn empty_end(session: &str, window: &str) -> u64 {
        record_notification_with(session, window, "completed", super::super::now(), true);
        super::super::telemetry::turn_epoch(session, window)
    }

    /// An end with something to say.
    fn real_end(session: &str, window: &str) {
        record_notification_with(session, window, "completed", super::super::now(), false);
    }

    #[test]
    fn the_line_names_the_open_items_and_cannot_address_anyone() {
        let line = nudge_line("2026-10-15 13:30", &[(12, "Fix the @all delivery".into()), (14, "Second".into())]);
        assert!(line.starts_with("[tmm chat 2026-10-15 13:30] tmm: [reply] your previous turn ended without a response"), "{line}");
        assert!(line.contains("Your open item: #12 Fix the ＠all delivery; #14 Second."), "{line}");
        assert!(crate::address::mention_names(&line).is_empty(), "a title's @ routes nowhere: {line}");
    }

    /// The run of empty turns is owed ONE nudge, and the allowance is spent by a
    /// nudge DELIVERED — not by a timer set. A nudge that itself ends empty earns
    /// none (that is a retry loop); a turn that ends with something to say
    /// forgives it.
    #[test]
    fn one_nudge_per_run_of_empty_turns() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        assert!(!arm_nudge(&s, w), "no turn, nothing owed");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w), "the first empty end is owed a nudge");
        assert!(!arm_nudge(&s, w), "one timer, not two");
        // Cancelled before it sent anything (the timer is released): the
        // allowance is NOT spent, the next empty end is owed it still.
        disarm_nudge(&s, w);
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w), "a timer that never delivered spent nothing");
        disarm_nudge(&s, w);
        // Delivered: spent. The nudge starts a turn that ends empty AGAIN: no second.
        spend_nudge(&s, w);
        record_prompt(&s, w, "[tmm chat 10:05] tmm: [reply] nudge");
        empty_end(&s, w);
        assert!(!arm_nudge(&s, w), "an empty answer to a nudge is not a reason for another");
        // A turn that says something forgives it.
        record_prompt(&s, w, "[tmm chat 10:10] human: continue");
        real_end(&s, w);
        empty_end(&s, w);
        assert!(arm_nudge(&s, w), "after the agent spoke, the next empty turn is owed one again");
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
        watch(&s, w, Duration::from_secs(1), move |_, _, end| {
            log.lock().unwrap().push(end);
            // Delivering it spends the allowance, as `fire_with` does.
            spend_nudge(&s2, &w2);
        });
        // A second timer for the same window is refused while the first waits.
        watch(&s, w, Duration::from_secs(1), |_, _, _| panic!("a second timer for one agent"));
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        let second = empty_end(&s, w);
        assert!(second > first);
        std::thread::sleep(Duration::from_millis(3500));
        assert_eq!(*acted.lock().unwrap(), vec![second], "one nudge, for the end that is still the newest");
        assert!(!arm_nudge(&s, w), "and the allowance is spent");
    }

    /// A timer that finds the agent moved on says nothing and releases itself.
    #[test]
    fn a_timer_that_finds_the_agent_moved_on_releases_itself() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        assert_eq!(nudge_wait(&s, w, 0, end), NudgeWait::Gone, "an end it already answered is not looked at again");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w));
        assert!(matches!(nudge_wait(&s, w, 600, 0), NudgeWait::Wait(secs) if secs > 0 && secs <= 600), "a fresh end has not aged");
        assert!(matches!(nudge_wait(&s, w, 0, 0), NudgeWait::Due(seq) if seq > end), "aged: due, for the NEWEST end");
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        assert_eq!(nudge_wait(&s, w, 0, 0), NudgeWait::Gone);
        assert!(!arm_nudge(&s, w), "no empty end is newest any more");
        empty_end(&s, w);
        assert!(arm_nudge(&s, w), "released in the same step as Gone: a new empty end finds the timer free");
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
        assert!(!arm_nudge(&s, w), "and owes nobody a nudge");
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

    fn run(open: Vec<(i64, String)>, waiting: bool, moved_on: bool, delivered: bool) -> (Vec<String>, bool) {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        let end = empty_end(&s, w);
        if moved_on {
            record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        }
        let sent = Arc::new(Mutex::new(Vec::new()));
        let out = sent.clone();
        fire_with(&s, w, end, &|| open.clone(), &|| waiting, &|line| {
            out.lock().unwrap().push(line.to_string());
            delivered
        });
        let got = sent.lock().unwrap().clone();
        // Spent iff the run can no longer be owed a nudge: a fresh empty end after
        // a real end of the nudged turn would be owed one again, so ask the record.
        record_prompt(&s, w, "[tmm chat 10:30] tmm: [reply] x");
        empty_end(&s, w);
        (got, !arm_nudge(&s, w))
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

        assert!(!waiting_on_purpose(&s, "dev"), "nothing pending");
        let due = super::super::now() as i64 + 600;
        crate::projects::wakes::schedule(&s, "lead", "@dev check the build", due).unwrap();
        assert!(waiting_on_purpose(&s, "dev"), "a wake addressed to it: it was told to wait");
        assert!(!waiting_on_purpose(&s, "lead"), "a wake for someone else says nothing about this agent");
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
