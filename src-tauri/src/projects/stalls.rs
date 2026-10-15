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
//!   empty turns: a nudge that itself ends empty earns no second (that would be
//!   a retry loop), and only a turn that ends with something to say forgives
//!   it. Nothing here resumes arbitrary work, and nothing is persisted — a
//!   restart forgets a pending nudge, which is the right amount of memory for
//!   a safety net (tenet 7: the running state is a disposable projection).
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
    schedule(session, window, NUDGE_AFTER, |session, window, end_seq| fire(session, window, end_seq));
}

/// Claim the nudge and run `act` after `delay` on a thread of its own. The
/// claim is what makes it ONE per run of empty turns.
fn schedule(session: &str, window: &str, delay: Duration, act: impl FnOnce(&str, &str, u64) + Send + 'static) {
    let Some(end_seq) = super::telemetry::claim_nudge(session, window) else { return };
    let (session, window) = (session.to_string(), window.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        act(&session, &window, end_seq);
    });
}

fn fire(session: &str, window: &str, end_seq: u64) {
    fire_with(
        session,
        window,
        end_seq,
        &|| open_items(session, window),
        &|| waiting_on_purpose(session, window),
        &|line| {
            super::deliver_chat_line(session, window, line);
        },
    );
}

/// The decision and its one effect, with the three outside facts injected.
fn fire_with(
    session: &str,
    window: &str,
    end_seq: u64,
    open_items: &dyn Fn() -> Vec<(i64, String)>,
    waiting: &dyn Fn() -> bool,
    deliver: &dyn Fn(&str),
) {
    // Still at rest after THIS end: a new turn since, or anything that ended
    // since, and the agent has already moved on.
    if !super::telemetry::still_stalled(session, window, end_seq) {
        return;
    }
    let open = open_items();
    if open.is_empty() || waiting() {
        return;
    }
    let stamp = chrono::Local::now().format("%Y-%m-%d %H:%M").to_string();
    deliver(&nudge_line(&stamp, &open));
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
    wake_for_it
        || crate::tasks::list()
            .iter()
            .any(|t| t.session == session && matches!(t.state, crate::tasks::State::Running))
}

#[cfg(test)]
mod tests {
    use super::super::telemetry::{claim_nudge, record_end_quality, record_notification, record_prompt, still_stalled};
    use super::*;
    use std::sync::{Arc, Mutex};

    fn unique() -> String {
        format!("stall-{}", uuid::Uuid::new_v4())
    }

    /// An empty end, recorded the way the consumer does: the end, then how it ended.
    fn empty_end(session: &str, window: &str) {
        record_notification(session, window, "completed", super::super::now());
        record_end_quality(session, window, true);
    }

    #[test]
    fn the_line_names_the_open_items_and_cannot_address_anyone() {
        let line = nudge_line("2026-10-15 13:30", &[(12, "Fix the @all delivery".into()), (14, "Second".into())]);
        assert!(line.starts_with("[tmm chat 2026-10-15 13:30] tmm: [reply] your previous turn ended without a response"), "{line}");
        assert!(line.contains("Your open item: #12 Fix the ＠all delivery; #14 Second."), "{line}");
        assert!(crate::address::mention_names(&line).is_empty(), "a title's @ routes nowhere: {line}");
    }

    /// The run of empty turns is owed ONE nudge. A nudge that itself ends empty
    /// earns none (that is a retry loop); a turn that ends with something to say
    /// forgives it.
    #[test]
    fn one_nudge_per_run_of_empty_turns() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        assert_eq!(claim_nudge(&s, w), None, "no turn, nothing owed");
        empty_end(&s, w);
        let first = claim_nudge(&s, w);
        assert!(first.is_some(), "the first empty end is owed a nudge");
        assert_eq!(claim_nudge(&s, w), None, "and not twice");
        // The nudge starts a turn that ends empty AGAIN: no second nudge.
        record_prompt(&s, w, "[tmm chat 10:00] tmm: [reply] nudge");
        empty_end(&s, w);
        assert_eq!(claim_nudge(&s, w), None, "an empty answer to a nudge is not a reason for another");
        // A turn that says something forgives it.
        record_prompt(&s, w, "[tmm chat 10:05] human: continue");
        record_notification(&s, w, "completed", super::super::now());
        record_end_quality(&s, w, false);
        empty_end(&s, w);
        assert!(claim_nudge(&s, w).is_some(), "after the agent spoke, the next empty turn is owed one again");
    }

    #[test]
    fn it_is_still_a_stall_only_while_nothing_has_happened_since_that_end() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        let end = claim_nudge(&s, w).unwrap();
        assert!(still_stalled(&s, w, end));
        record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        assert!(!still_stalled(&s, w, end), "a new turn since: the agent moved on");
        record_notification(&s, w, "completed", super::super::now());
        record_end_quality(&s, w, false);
        assert!(!still_stalled(&s, w, end), "a later real end is not that empty end");
    }

    fn run(open: Vec<(i64, String)>, waiting: bool, moved_on: bool) -> Vec<String> {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        let end = claim_nudge(&s, w).unwrap();
        if moved_on {
            record_prompt(&s, w, "[tmm chat 10:00] human: continue");
        }
        let sent = Arc::new(Mutex::new(Vec::new()));
        let out = sent.clone();
        fire_with(&s, w, end, &|| open.clone(), &|| waiting, &|line| out.lock().unwrap().push(line.to_string()));
        let got = sent.lock().unwrap().clone();
        got
    }

    #[test]
    fn it_nudges_an_agent_that_is_still_at_rest_with_an_open_item() {
        let sent = run(vec![(12, "Fix it".into())], false, false);
        assert_eq!(sent.len(), 1, "{sent:?}");
        assert!(sent[0].contains("#12 Fix it"));
    }

    #[test]
    fn it_leaves_alone_an_agent_with_nothing_open_one_told_to_wait_and_one_that_moved_on() {
        assert!(run(vec![], false, false).is_empty(), "nothing in `doing`: nothing to resume");
        assert!(run(vec![(12, "Fix it".into())], true, false).is_empty(), "a pending wake or a running task: it was told to wait");
        assert!(run(vec![(12, "Fix it".into())], false, true).is_empty(), "it started a turn since: it needs nobody");
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

    #[test]
    fn the_nudge_is_scheduled_once_and_fires_after_its_delay() {
        crate::projects::tests::use_test_store();
        let (s, w) = (unique(), "dev");
        empty_end(&s, w);
        let (tx, rx) = std::sync::mpsc::channel();
        let tx2 = tx.clone();
        schedule(&s, w, Duration::from_millis(20), move |_, _, seq| { let _ = tx.send(seq); });
        schedule(&s, w, Duration::from_millis(20), move |_, _, seq| { let _ = tx2.send(seq); }); // a second claim: nothing
        let first = rx.recv_timeout(Duration::from_secs(5)).expect("the claimed nudge fires");
        assert!(first > 0);
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "and only once");
    }
}
