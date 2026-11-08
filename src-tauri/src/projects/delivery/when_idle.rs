//! A `/command` held for its agent's next idle edge (`tmm send "@x /clear"
//! --when-idle`, board #45): the decision, the typing, the wait for a reset's
//! effect, and what a stop or restart does to one. It lives in the ONE
//! deliveries queue (`super`): `flush_locked` hands it a waiting command first
//! in line, and `stop_cli` / `replace_cli` hand it the window's ending. The
//! rules and their reasons are in hub-composer.md § `--when-idle`.

use super::*;

/// May a held `/command` be typed into `window` now (board #45)? Only at its
/// idle edge, by turn facts and #38's readiness, never by the pane and never
/// by `HOLD_MAX_SECS` (a reset typed into a running turn is the 07:38
/// incident): the turn is KNOWN and not busy, no line typed into it still
/// owes its echo (#281: a delivery just typed has started a turn the hooks
/// have not reported yet, the 06:25 incident), the window is not starting
/// (#38) or held by a restore (#422), and a CLI that loses typed text is
/// ready (#404). Asked under the window lock.
fn command_idle(session: &str, window: &str) -> bool {
    telemetry::turn_known(session, window)
        && strict_occupied(session, window) != Some(true)
        && !telemetry::turn_busy(session, window)
        && telemetry::in_flight_row(session, window).is_none()
        && !super::super::restore_hold::held(session, window)
        && !starting(session, window)
}

/// What `command_when_idle` did with one window's command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhenIdle {
    /// The window was at its idle edge: typed now.
    Typed,
    /// Held for the idle edge: the row id, what `tmm send --cancel` names.
    Waiting(i64),
}

/// `tmm send "@x /cmd" --when-idle` for one window (board #45): the command
/// becomes a held row in the ONE deliveries queue, behind every line already
/// held and ahead of every line sent later, and is typed alone and verbatim
/// at the window's idle edge (`release_command`). The decision is made under
/// the window lock and the turn-fact lock, in the same step as the typing, so
/// no delivery can start a turn between "is it idle?" and the keys. `msg_id`
/// is its room line's id: its sender is read from that line. `Err`: the row
/// could not be written; nothing is typed.
pub fn command_when_idle(session: &str, window: &str, target: &str, command: &str, msg_id: &str) -> Result<WhenIdle, String> {
    let lock = window_lock(session, window);
    let _guard = lock.lock().unwrap();
    let _order = telemetry::delivery_decision();
    let first = telemetry::held_rows(session, window).is_empty();
    let id = telemetry::record_held_command(session, window, command, msg_id)?;
    if let Some(row) = first.then(|| telemetry::held_rows(session, window).into_iter().find(|r| r.id == id)).flatten() {
        // Typed now, it is said by the caller's own line (`hub_command`).
        release_command(session, window, target, &row, false, Some(&_order));
    }
    let waiting = telemetry::held_rows(session, window).iter().any(|r| r.id == id && r.verbatim == Some(super::super::store::CommandHold::Waiting));
    Ok(if waiting { WhenIdle::Waiting(id) } else { WhenIdle::Typed })
}

/// When each typed command was typed, in nanoseconds since the epoch, by row
/// id (board #45 round 2): a `SessionStart` is its effect only if PRODUCED
/// strictly after this (reviewer 16:16: whole seconds let an earlier
/// same-source hook of that second count for a later command). Taken just
/// before the keys go in. In memory: after a gateway restart a typed command
/// has none, so no event can be ordered after it, and its lines wait for the
/// notice and a cancel.
fn typed_at() -> &'static Mutex<HashMap<i64, u128>> {
    static AT: OnceLock<Mutex<HashMap<i64, u128>>> = OnceLock::new();
    AT.get_or_init(Default::default)
}

/// Now, in nanoseconds since the epoch: the clock the notify helper's
/// `date +%s.%N` reads on the same host.
fn now_ns() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// Test seam: record a typed command's typing time, for a test that marks a
/// row typed without `release_command` (the real-inbox test).
#[cfg(test)]
pub(crate) fn note_typed_at(id: i64, ns: u128) {
    typed_at().lock().unwrap().insert(id, ns);
}

/// Test seam: a typed command's recorded typing time.
#[cfg(test)]
pub(crate) fn typed_at_ns(id: i64) -> Option<u128> {
    typed_at().lock().unwrap().get(&id).copied()
}

/// The thread a window ran before its `NewThread` command was typed (board
/// #45), by row id: only a KNOWN one (reviewer 16:05: `pane_thread` answers
/// `None` for unreadable as for absent, and an unknown baseline would let any
/// thread readable later pass for a reset). In memory: after a gateway restart
/// a typed command has none either. With none, its effect cannot be proven,
/// and its lines wait for the notice and a cancel.
fn threads_before() -> &'static Mutex<HashMap<i64, String>> {
    static BEFORE: OnceLock<Mutex<HashMap<i64, String>>> = OnceLock::new();
    BEFORE.get_or_init(Default::default)
}

/// Type a waiting `/command` that is first in line, if the window is at its
/// idle edge (board #45): ALONE, verbatim (no stamp, no `＠`), through the one
/// send door, never in the same flush as a line behind it. Its row is marked
/// typed BEFORE the keys go in (an effect racing the Enter finds it) and put
/// back to waiting if the pane refuses them. A command whose backend declares
/// an effect (`Backend::command_effect`) keeps its row until that effect is
/// seen, holding every line behind it; one with none is retired once typed,
/// and the lines behind it go at the next trigger. The receipt rides the
/// command's own room line, as `hub_command`'s does. `later`: it waited, so
/// its typing is said in the room under its sender.
///
/// The idle decision and the keys are ONE step under the window lock AND the
/// turn-fact lock (validator-2's 15:27 finding: a flush trigger released it
/// under the window lock alone, so a prompt edge could land between "idle"
/// and the keys). A caller that holds the turn-fact lock passes it (`order`,
/// the delivery decision); otherwise it is taken here. It is not reentrant,
/// so the receipt is recorded under the same guard (15:25: a second take of
/// it deadlocked claude's `/goal`).
pub(super) fn release_command(session: &str, window: &str, target: &str, row: &super::super::store::DeliveryRow, later: bool, order: Option<&std::sync::MutexGuard<'static, ()>>) {
    let own;
    let order = match order {
        Some(order) => order,
        None => {
            own = telemetry::delivery_decision();
            &own
        }
    };
    if !command_idle(session, window) {
        return;
    }
    let backend = recipe_backend(session, window);
    let (name, args) = row.line.split_once(char::is_whitespace).map_or((row.line.as_str(), ""), |(n, a)| (n, a.trim()));
    let effect = backend.and_then(|b| b.command_effect(name));
    let before = (effect == Some(crate::backends::CommandEffect::NewThread))
        .then(|| backend.zip(super::super::managed_home(session, window)).and_then(|(b, home)| b.current_thread(&home)));
    typed_at().lock().unwrap().insert(row.id, now_ns());
    if !matches!(telemetry::set_command_typed(row.id, true), Ok(true)) {
        typed_at().lock().unwrap().remove(&row.id);
        return;
    }
    let receipt = backend.and_then(|b| b.command_echo(name, args)).and_then(|echo| telemetry::record_command_delivery_held(order, session, window, &echo, &row.msg_id));
    match type_verbatim(session, window, target, &row.line) {
        Ok(()) => {
            match effect {
                None => {
                    telemetry::forget_delivery(row.id);
                    typed_at().lock().unwrap().remove(&row.id);
                }
                Some(_) => {
                    if let Some(before) = before.flatten() {
                        threads_before().lock().unwrap().insert(row.id, before);
                    }
                }
            }
            if later {
                say_command(session, row, &format!("[tmm] {} → {window} (its turn ended)", row.line));
            }
            super::super::vitals::sniff_window_soon(session, window);
        }
        Err(e) => {
            if let Some(id) = receipt {
                telemetry::forget_delivery(id);
            }
            let _ = telemetry::set_command_typed(row.id, false);
            typed_at().lock().unwrap().remove(&row.id);
            if !kept_at_write(&e) {
                telemetry::record_held_blocked(session, window, std::slice::from_ref(row), e.trim());
            }
        }
    }
}

/// A room line about a held command, under the sender of the line it was
/// accepted under (its `msg_id`), `tmm` when that line cannot be found.
fn say_command(session: &str, row: &super::super::store::DeliveryRow, body: &str) {
    let room = super::super::rooms::session_room(session);
    let from = super::super::rooms::message_by_ref(&room, &row.msg_id).and_then(|m| m["from"].as_str().map(str::to_string)).unwrap_or_else(|| NOTICE_SENDER.to_string());
    if let Err(e) = super::super::rooms::post(&room, &from, body) {
        eprintln!("delivery: '{body}' was not written to the room: {e}");
    }
}

/// The typed command first in `window`'s line has taken effect: its row is
/// retired and the lines behind it are offered at once (board #45). Under
/// the window lock; true when it retired one.
fn command_took_effect(session: &str, window: &str, seen: impl Fn(crate::backends::CommandEffect, &super::super::store::DeliveryRow) -> bool) -> bool {
    let lock = window_lock(session, window);
    let _guard = lock.lock().unwrap();
    let Some(row) = telemetry::held_rows(session, window).into_iter().next() else { return false };
    if row.verbatim != Some(super::super::store::CommandHold::Typed) {
        return false;
    }
    let name = row.line.split_whitespace().next().unwrap_or_default();
    match recipe_backend(session, window).and_then(|b| b.command_effect(name)) {
        Some(effect) if seen(effect, &row) => {}
        _ => return false,
    }
    telemetry::forget_delivery(row.id);
    threads_before().lock().unwrap().remove(&row.id);
    typed_at().lock().unwrap().remove(&row.id);
    true
}

/// The CLI in `window` reported a `SessionStart` (board #45): the effect of a
/// typed `/clear` or `/compact` that declares it (claude; codex `/compact`).
/// Called by the hook path for every `SessionStart`; a window with no typed
/// command first in line changes nothing.
///
/// Only THIS command's effect counts (reviewer 16:04, orchestrator's round 2
/// rule): the source the reset produces (`startup`, `resume`, the other
/// reset's source or none leave the gate intact), PRODUCED strictly after the
/// command was typed, both to the nanosecond (`produced`, the helper's publish
/// time from the inbox file name, never the time it was consumed: a new CLI's
/// event consumed late is still old; `typed_at`). Reviewer 16:16: whole
/// seconds let an earlier same-source hook of the same second count. An
/// unknown time on either side (an old-format name, a gateway restarted since
/// the typing) never counts.
pub fn command_session_started(session: &str, window: &str, source: Option<&str>, produced: Option<u128>) {
    let ours = |effect, row: &super::super::store::DeliveryRow| {
        let after = produced.zip(typed_at().lock().unwrap().get(&row.id).copied()).is_some_and(|(p, t)| p > t);
        matches!(effect, crate::backends::CommandEffect::SessionStart(want) if source == Some(want)) && after
    };
    if command_took_effect(session, window, ours) {
        flush(session, window);
    }
}

/// The capture tick's pass over typed commands (board #45): a `NewThread`
/// effect (codex `/clear`, `/new`) is seen when the pane's thread is no
/// longer the one it ran before the command; a command whose effect has not
/// come within its backend's start timeout (#38's) is said ONCE, and its
/// lines stay held (never typed on a timeout); `tmm send --cancel <id>`
/// releases them.
pub fn check_command_effects() {
    for session in telemetry::held_sessions() {
        for window in telemetry::held_windows(&session) {
            let Some(row) = telemetry::held_rows(&session, &window).into_iter().next() else { continue };
            if row.verbatim != Some(super::super::store::CommandHold::Typed) {
                continue;
            }
            let backend = recipe_backend(&session, &window);
            // A KNOWN thread before and a different KNOWN thread now; anything
            // unknown proves nothing (reviewer 16:05).
            let changed = |effect, row: &super::super::store::DeliveryRow| {
                if effect != crate::backends::CommandEffect::NewThread {
                    return false;
                }
                let Some(before) = threads_before().lock().unwrap().get(&row.id).cloned() else { return false };
                let now = backend.zip(super::super::managed_home(&session, &window)).and_then(|(b, home)| b.current_thread(&home));
                now.is_some_and(|now| now != before)
            };
            if command_took_effect(&session, &window, changed) {
                flush(&session, &window);
                continue;
            }
            let wait = command_effect_timeout(backend);
            if super::super::now().saturating_sub(row.ts) >= wait.as_secs() && telemetry::warn_command_once(row.id) {
                say_command(&session, &row, &format!(
                    "[tmm] {} → {window} has not taken effect after {} s; the lines behind it stay held — cancel: tmm send --cancel {}",
                    row.line, wait.as_secs(), row.id
                ));
            }
        }
    }
}

/// How long a typed command may wait for its effect before it is said: the
/// backend's own start timeout (#38), else `HOLD_MAX_SECS`.
fn command_effect_timeout(backend: Option<crate::backends::Backend>) -> std::time::Duration {
    #[cfg(test)]
    if let Some(t) = *START_TIMEOUT_IN_TEST.lock().unwrap() {
        return t;
    }
    backend.and_then(|b| b.startup_confirmation()).map_or(std::time::Duration::from_secs(HOLD_MAX_SECS), |c| c.timeout)
}

/// What ended a window's CLI, for its held `/command`s (board #45).
#[derive(Clone, Copy)]
pub(super) enum Ending {
    Stop,
    Restart,
}

/// The held `/command`s a stop or a restart ends (board #45), under the
/// window lock, each said once in the room under its sender. A STOP ends
/// every one: a reset left waiting must never fire into whatever the agent
/// is next given (reviewer's retro on #45). A RESTART ends only a typed one
/// whose effect has not come: the CLI it was typed into is gone, so its effect
/// never will, and it is not typed again; one still waiting stays and is
/// typed at the new CLI's idle edge (#38's ready edge comes first). The lines
/// behind an ended one are no longer held by it.
pub(super) fn end_held_commands(session: &str, window: &str, ending: Ending) {
    use super::super::store::CommandHold::{Typed, Waiting};
    for row in telemetry::held_rows(session, window) {
        let said = match (ending, row.verbatim) {
            (Ending::Stop, Some(Waiting)) => format!("[tmm] {} → {window} was not typed: {window} was stopped", row.line),
            (Ending::Stop, Some(Typed)) => format!("[tmm] {} → {window}: {window} was stopped before it took effect", row.line),
            (Ending::Restart, Some(Typed)) => format!("[tmm] {} → {window}: {window} was restarted before it took effect; it is not typed again", row.line),
            _ => continue,
        };
        if telemetry::cancel_held_command(session, row.id, |_| Ok(())).is_ok() {
            threads_before().lock().unwrap().remove(&row.id);
    typed_at().lock().unwrap().remove(&row.id);
            say_command(session, &row, &said);
        }
    }
}

/// Cancel a held `/command` by its id (board #45, `tmm send --cancel <id>`,
/// `hub_command_cancel`), waiting or typed. Only its sender or the human may:
/// the wakes' courtesy rule against a teammate's mistake, not a security
/// boundary (tmm-cli.md § wakes); its sender is the room line it was accepted
/// under, whose id the row carries. Said in the room under `from`; the lines
/// held behind it are offered to the window again at once (typed now if its
/// turn is over, else at its end). `Err` names why not.
pub fn cancel_command(session: &str, id: i64, from: &str) -> Result<serde_json::Value, String> {
    let room = super::super::rooms::session_room(session);
    let row = telemetry::cancel_held_command(session, id, |row| {
        let sender = super::super::rooms::message_by_ref(&room, &row.msg_id).and_then(|m| m["from"].as_str().map(str::to_string));
        match sender {
            Some(by) if by != from && from != "human" => Err(format!("command #{id} was sent by {by}; only they or the human can cancel it")),
            _ => Ok(()),
        }
    })?;
    threads_before().lock().unwrap().remove(&row.id);
    typed_at().lock().unwrap().remove(&row.id);
    let said = match row.verbatim {
        // Typed, its effect not seen yet: the lines behind it stop waiting.
        Some(super::super::store::CommandHold::Typed) => format!("[tmm] {} → {}: no longer waiting for it to take effect", row.line, row.window),
        _ => format!("[tmm] {} → {} cancelled before its turn ended", row.line, row.window),
    };
    if let Err(e) = super::super::rooms::post(&room, from, &said) {
        eprintln!("delivery: '{said}' was not written to the room: {e}");
    }
    flush(session, &row.window);
    Ok(serde_json::json!({ "id": id, "agent": row.window, "command": row.line, "cancelled": true }))
}

/// The one room line `hub_command` writes when it accepts a command (board
/// #45), under its sender: the windows it typed into now, then those that
/// hold it for their turn's end (`a, b wait for their turns to end`).
/// `tail` is `hub_command`'s own note (an app-run command's other windows).
pub fn accepted_line(text: &str, sent: &[String], waiting: &[(String, i64)], tail: &str) -> String {
    let names: Vec<&str> = waiting.iter().map(|(w, _)| w.as_str()).collect();
    let held = match names.len() {
        0 => String::new(),
        1 => format!("{} waits for its turn to end", names[0]),
        _ => format!("{} wait for their turns to end", names.join(", ")),
    };
    let to = [sent.join(", "), held].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("; ");
    format!("[tmm] {text} → {to}{tail}")
}

#[cfg(test)]
mod tests {
    use super::super::tests::{agent_with_recipe, busy, end, fake, setup, typed};
    use super::*;
    use crate::projects::telemetry::record_prompt;

    fn waiting(r: Result<WhenIdle, String>) -> i64 {
        match r {
            Ok(WhenIdle::Waiting(id)) => id,
            other => panic!("expected Waiting, got {other:?}"),
        }
    }
    fn held_lines(session: &str, window: &str) -> Vec<(String, Option<crate::projects::store::CommandHold>)> {
        telemetry::held_rows(session, window).into_iter().map(|r| (r.line, r.verbatim)).collect()
    }
    fn age_rows(session: &str, secs: u64) {
        crate::projects::with_store(|s| s.conn_for_test().execute("UPDATE deliveries SET ts = ts - ?2 WHERE session = ?1", rusqlite::params![session, secs as i64]).map_err(|e| e.to_string())).unwrap();
    }

    /// Board #45, the 07:38 incident (2026-11-05): a `/clear` for a BUSY agent
    /// landed queued in its composer and an assignment started work before it.
    /// Held instead: nothing typed into the running turn, not by the overdue
    /// rule either; the assignment sent later waits behind it; at the turn's
    /// end the command is typed ALONE, and the assignment only at the next
    /// trigger (no effect is declared for this window).
    #[test]
    fn a_command_for_a_busy_agent_waits_for_its_turn_end_and_goes_alone_before_later_lines() {
        let s = setup("idle-0738");
        busy(&s, "dev");
        waiting(command_when_idle(&s, "dev", "t", "/clear", "m1"));
        assert!(deliver_as(&s, "dev", "t", "[tmm chat 2026-11-05 07:38] orchestrator: @dev the #47 brief", "m2", false));
        assert!(typed().is_empty(), "nothing enters the running turn: {:?}", typed());
        age_rows(&s, HOLD_MAX_SECS + 60);
        flush_at(&s, "dev", "t");
        assert!(typed().is_empty(), "never by the overdue rule: {:?}", typed());
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), ["/clear"], "alone, verbatim, at the turn's end");
        // validator-2's 15:27 finding: a flush trigger holds no turn-fact lock,
        // so the release takes it, and the keys go in under it.
        assert_eq!(VERBATIM_UNDER_TURN_LOCK.with(|v| v.borrow().clone()), [true], "typed under the turn-fact lock");
        assert_eq!(held_lines(&s, "dev").len(), 1, "the brief waits for the next trigger");
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), ["/clear", "[tmm chat 2026-11-05 07:38] orchestrator: @dev the #47 brief"]);
    }

    /// Board #45, the 06:25 incident (2026-11-06): the agent read idle, but an
    /// automatic delivery had just been typed and started a turn the hooks had
    /// not reported yet; the `/clear` then queued behind the next brief. The
    /// typed line owes its echo (#281), so the command waits for THAT turn's
    /// end, and the brief sent after it waits behind it: it never enters the
    /// conversation the reset discards.
    #[test]
    fn a_command_waits_out_a_turn_a_delivery_just_started_and_the_next_brief_waits_behind_it() {
        let s = setup("idle-0625");
        let reply = "[tmm chat 2026-11-06 06:25] tmm: [board #47 reply] @dev CLEAR";
        assert!(deliver_as(&s, "dev", "t", reply, "m0", false));
        assert_eq!(typed(), [reply], "typed at once: the window was idle");
        waiting(command_when_idle(&s, "dev", "t", "/clear", "m1"));
        assert!(deliver_as(&s, "dev", "t", "[tmm chat 2026-11-06 06:26] orchestrator: @dev the next brief", "m2", false));
        assert_eq!(typed(), [reply], "neither the command nor the brief: the reply's turn is under way");
        record_prompt(&s, "dev", reply);
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), [reply], "its turn runs");
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), [reply, "/clear"]);
        flush_at(&s, "dev", "t");
        assert_eq!(typed().last().map(String::as_str), Some("[tmm chat 2026-11-06 06:26] orchestrator: @dev the next brief"));
    }

    /// Board #45: an idle agent with nothing in flight gets the command at
    /// once, in the same locked step as the decision; nothing stays held.
    #[test]
    fn a_command_for_an_idle_agent_is_typed_at_once() {
        let s = setup("idle-now");
        assert_eq!(command_when_idle(&s, "dev", "t", "/compact", "m1"), Ok(WhenIdle::Typed));
        assert_eq!(typed(), ["/compact"]);
        assert!(held_lines(&s, "dev").is_empty());
    }

    /// Board #45: in a queue-mode agent the command takes its place among the
    /// held lines: the lines before it are one combined prompt WITHOUT it,
    /// typed at the turn's end; it is typed alone at the end of the turn they
    /// open; the lines after it come last.
    #[test]
    fn a_command_keeps_its_place_among_held_lines_and_is_never_combined() {
        let s = setup("idle-queue");
        busy(&s, "dev");
        let a = "[tmm chat 2026-11-06 08:00] lead: @dev before";
        let b = "[tmm chat 2026-11-06 08:02] lead: @dev after";
        assert!(deliver_as(&s, "dev", "t", a, "m1", true));
        waiting(command_when_idle(&s, "dev", "t", "/clear", "m2"));
        assert!(deliver_as(&s, "dev", "t", b, "m3", true));
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), [a], "the lines before it, without it");
        record_prompt(&s, "dev", a);
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), [a], "their turn runs");
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), [a, "/clear"]);
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), [a, "/clear", b]);
    }

    /// Board #45 (orchestrator's ruling on Q1): the lines behind a reset wait
    /// for its EFFECT, never a timer. claude's `/clear` is seen by its
    /// SessionStart; until then a typed command holds them, and past the start
    /// timeout it is said ONCE in the room, the lines still held.
    #[test]
    fn the_lines_behind_a_reset_wait_for_its_effect_and_a_missing_one_is_said_once() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-effect");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "cl", "claude", "");
        fake();
        let brief = "[tmm chat 2026-11-06 09:00] lead: @cl the brief";
        busy(&s, "cl");
        let id = waiting(command_when_idle(&s, "cl", "t", "/clear", "m1"));
        assert!(deliver_as(&s, "cl", "t", brief, "m2", false));
        end(&s, "cl");
        flush_at(&s, "cl", "t");
        assert_eq!(typed(), ["/clear"]);
        flush_at(&s, "cl", "t");
        assert_eq!(typed(), ["/clear"], "the brief waits for the reset to take effect");
        assert_eq!(held_lines(&s, "cl")[0], ("/clear".to_string(), Some(crate::projects::store::CommandHold::Typed)));
        // No effect within the timeout: said once, nothing typed.
        let room = crate::projects::rooms::session_room(&s);
        let said = || crate::projects::rooms::history_page(&room, None, 100)["messages"].as_array().unwrap().iter()
            .filter(|m| m["body"].as_str().is_some_and(|b| b.contains("has not taken effect"))).count();
        *START_TIMEOUT_IN_TEST.lock().unwrap() = Some(std::time::Duration::ZERO);
        check_command_effects();
        check_command_effects();
        *START_TIMEOUT_IN_TEST.lock().unwrap() = None;
        assert_eq!(said(), 1, "said once");
        assert!(crate::projects::rooms::history_page(&room, None, 100)["messages"].as_array().unwrap().iter()
            .any(|m| m["body"].as_str().is_some_and(|b| b.contains(&format!("cancel: tmm send --cancel {id}")))));
        assert_eq!(typed(), ["/clear"], "never typed on a timeout");
        // reviewer 16:04: a SessionStart of another source (a new CLI's
        // startup consumed late, the other reset's) is no evidence of THIS
        // reset: the gate stays.
        let t = typed_at_ns(telemetry::held_rows(&s, "cl")[0].id).expect("its typing time is recorded");
        command_session_started(&s, "cl", Some("startup"), Some(t + 1));
        command_session_started(&s, "cl", Some("compact"), Some(t + 1));
        command_session_started(&s, "cl", None, Some(t + 1));
        assert_eq!(held_lines(&s, "cl").len(), 2, "only /clear's own source releases it");
        // Its own source, but produced before or AT the typing (consumed late),
        // or at an unknown time: not this command's effect. reviewer 16:16: a
        // prior /clear's hook at S+0.1, this one typed at S+0.5, the same second.
        command_session_started(&s, "cl", Some("clear"), Some(t - 400_000_000));
        command_session_started(&s, "cl", Some("clear"), Some(t));
        command_session_started(&s, "cl", Some("clear"), None);
        assert_eq!(held_lines(&s, "cl").len(), 2, "an earlier, simultaneous or undated clear is not this one's");
        // Its SessionStart{clear}, produced after the typing: the reset took
        // effect; the brief is next.
        command_session_started(&s, "cl", Some("clear"), Some(t + 300_000_000));
        assert_eq!(held_lines(&s, "cl"), [(brief.to_string(), None)]);
        flush_at(&s, "cl", "t");
        assert_eq!(typed(), ["/clear", brief]);
    }

    /// Board #45: codex reports no hook on `/clear`; its effect is a new
    /// newest thread lock, unlike the one before the command (measured on
    /// 0.166.0). The capture tick compares; an unchanged thread holds the lines.
    #[test]
    fn a_codex_reset_takes_effect_when_its_thread_changes() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-codex");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "cx", "codex", "queue");
        fake();
        let home = std::path::Path::new(&scratch.path()).join(".tmm/agents/cx");
        let locks = home.join("codex/thread-writer-locks");
        std::fs::create_dir_all(&locks).unwrap();
        std::fs::create_dir_all(home.join("codex/sessions")).unwrap();
        std::fs::write(locks.join("01a1b0c7-0000-7000-8000-00000000000a.lock"), "").unwrap();
        assert!(crate::backends::Backend::Codex.current_thread(&home).is_some(), "the fixture names a thread");
        let brief = "[tmm chat 2026-11-06 09:10] lead: @cx the brief";
        assert_eq!(command_when_idle(&s, "cx", "t", "/clear", "m1"), Ok(WhenIdle::Typed), "idle: typed at once");
        assert!(deliver_as(&s, "cx", "t", brief, "m2", true));
        check_command_effects();
        assert_eq!(held_lines(&s, "cx").len(), 2, "the same thread: no effect yet");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(locks.join("01a1b0cc-0000-7000-8000-00000000000b.lock"), "").unwrap();
        check_command_effects();
        assert_eq!(held_lines(&s, "cx"), [(brief.to_string(), None)], "a new thread: the reset took effect");
    }

    /// Board #66 (orchestrator at integration): a codex reset is gated by the
    /// one picker hold too. With the harness's composer stub off, the fake
    /// typing's screen cannot be read, which holds a codex line exactly as an
    /// open menu does: the reset waits and nothing reaches the pane.
    #[test]
    fn a_codex_reset_waits_while_its_screen_is_not_the_composer() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-codex-menu");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "cx", "codex", "queue");
        fake();
        crate::projects::delivery::picker_hold::COMPOSER_IN_TEST.with(|c| c.set(false));
        assert!(matches!(command_when_idle(&s, "cx", "t", "/clear", "m1"), Ok(WhenIdle::Waiting(_))), "a screen that is not the composer: the reset waits");
        assert!(typed().is_empty(), "nothing is typed while it waits");
    }

    /// Board #45 AC2: what a restart, a stop and an interrupt do to a held
    /// command. A RESTART keeps a waiting one (typed at the new CLI's idle
    /// edge) and ends a typed one whose effect has not come (its CLI is gone;
    /// never typed again); a STOP ends every one, so no reset left waiting can
    /// erase what the agent is given next; an INTERRUPT drops it with the held
    /// lines (#257 decision 1). Each end is said once in the room; the lines
    /// behind are kept.
    #[test]
    fn a_restart_keeps_a_waiting_command_and_a_stop_or_interrupt_ends_it() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-life");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "cl", "claude", "");
        fake();
        use crate::projects::store::CommandHold::{Typed, Waiting};
        let brief = "[tmm chat 2026-11-06 10:00] lead: @cl the brief";
        let room = crate::projects::rooms::session_room(&s);
        let said = || -> Vec<String> {
            crate::projects::rooms::history_page(&room, None, 100)["messages"].as_array().unwrap().iter()
                .filter_map(|m| m["body"].as_str().map(str::to_string)).filter(|b| b.starts_with("[tmm] /")).collect()
        };
        busy(&s, "cl");
        waiting(command_when_idle(&s, "cl", "t", "/clear", "m1"));
        assert!(deliver_as(&s, "cl", "t", brief, "m2", false));
        replace_cli(&s, "cl", None, || Ok(())).unwrap();
        assert_eq!(held_lines(&s, "cl"), [("/clear".to_string(), Some(Waiting)), (brief.to_string(), None)], "a restart keeps a waiting command");
        end(&s, "cl");
        flush_at(&s, "cl", "t");
        assert_eq!(typed(), ["/clear"]);
        assert_eq!(held_lines(&s, "cl")[0].1, Some(Typed));
        replace_cli(&s, "cl", None, || Ok(())).unwrap();
        assert_eq!(held_lines(&s, "cl"), [(brief.to_string(), None)], "a typed one ends: its CLI is gone");
        assert_eq!(said(), ["[tmm] /clear → cl (its turn ended)", "[tmm] /clear → cl: cl was restarted before it took effect; it is not typed again"]);
        busy(&s, "cl");
        waiting(command_when_idle(&s, "cl", "t", "/compact", "m3"));
        stop_cli(&s, "cl", || Ok(())).unwrap();
        assert_eq!(held_lines(&s, "cl"), [(brief.to_string(), None)], "a stop ends a waiting one; the line stays");
        assert_eq!(said().last().map(String::as_str), Some("[tmm] /compact → cl was not typed: cl was stopped"));
        waiting(command_when_idle(&s, "cl", "t", "/clear", "m4"));
        interrupt(&s, "cl", || telemetry::record_interrupt(&s, "cl"));
        assert!(held_lines(&s, "cl").is_empty(), "an interrupt drops it with the held lines");
        assert_eq!(typed(), ["/clear"], "none of them was typed");
    }

    /// Board #45, validator-2's 15:25 finding (measured by it at 15:29 on
    /// claude, kiro, kimi and omp): `/goal <args>` has a declared echo, so
    /// typing it records a receipt, and that took the turn-fact lock
    /// `command_when_idle` already held: a deadlock of the window and every
    /// hook. Each backend on a thread with a deadline, so a hang is a failure;
    /// typed once, its receipt owed, nothing left held.
    #[test]
    fn an_idle_goal_with_a_receipt_is_typed_without_a_deadlock() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-goal");
        let s = scratch.session("s");
        for backend in ["claude", "kiro", "kimi", "omp"] {
            agent_with_recipe(&scratch, &s, backend, backend, "");
            assert!(crate::backends::Backend::parse(backend).unwrap().command_echo("/goal", "ship it").is_some(), "{backend} echoes /goal");
            let (tx, rx) = std::sync::mpsc::channel();
            let (s2, w) = (s.clone(), backend.to_string());
            std::thread::spawn(move || {
                fake();
                let got = command_when_idle(&s2, &w, "t", "/goal ship it", "m1");
                let _ = tx.send((got, typed()));
            });
            let (got, typed) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap_or_else(|_| panic!("{backend}: command_when_idle hung"));
            assert_eq!(got, Ok(WhenIdle::Typed), "{backend}");
            assert_eq!(typed, ["/goal ship it"], "{backend}");
            assert!(held_lines(&s, backend).is_empty(), "{backend}");
            let owed = crate::projects::with_store(|st| st.pending_deliveries(&s, Some(backend))).unwrap().into_iter().filter(|r| r.command.is_some()).count();
            assert_eq!(owed, 1, "{backend}: its receipt is owed, as hub_command's is");
        }
    }

    /// Board #45: a held command is cancelled
    /// by its id, by its sender (a teammate is refused, as for a wake). The
    /// row goes, the room says so under the canceller, the
    /// lines held behind it stay held for the next trigger, and a second
    /// cancel (or a chat line's id, or another project's) is refused.
    #[test]
    fn a_held_command_is_cancelled_once_and_said() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-cancel-{}", uuid::Uuid::new_v4());
        let tm = crate::projects::telemetry::record_held_command;
        let id = tm(&session, "dev", "/clear", "m1").unwrap();
        crate::projects::rooms::post_routed_as(&crate::projects::rooms::session_room(&session), "m1", "lead", "[tmm] /clear → dev waits for its turn to end", &[]).unwrap();
        crate::projects::telemetry::record_held(&session, "dev", "[tmm chat] the brief", 0, "m2").unwrap();
        let line = crate::projects::telemetry::held_rows(&session, "dev")[1].id;
        let other = cancel_command("elsewhere", id, "lead");
        assert!(other.is_err(), "another project's id cancels nothing");
        let chat = cancel_command(&session, line, "lead");
        assert!(chat.is_err(), "a chat line is not a waiting command");
        let mate = cancel_command(&session, id, "reviewer");
        assert!(mate.as_ref().is_err_and(|e| e.contains("was sent by lead; only they or the human")), "{mate:?}");
        let r = cancel_command(&session, id, "lead");
        assert_eq!(r, Ok(serde_json::json!({ "id": id, "agent": "dev", "command": "/clear", "cancelled": true })));
        let again = cancel_command(&session, id, "lead");
        assert!(again.as_ref().is_err_and(|e| e.contains(&format!("no command #{id} is waiting"))), "{again:?}");
        let held: Vec<String> = crate::projects::telemetry::held_rows(&session, "dev").into_iter().map(|r| r.line).collect();
        assert_eq!(held, ["[tmm chat] the brief"], "the line behind it is kept");
        // A TYPED command still waiting for its effect is cancelled too: the
        // lines behind it stop waiting for it.
        let typed = tm(&session, "dev", "/compact", "m1").unwrap();
        assert!(crate::projects::telemetry::set_command_typed(typed, true).unwrap());
        assert!(cancel_command(&session, typed, "human").is_ok(), "the human may cancel any");
        let room: Vec<(String, String)> = crate::projects::rooms::history_page(&crate::projects::rooms::session_room(&session), None, 100)["messages"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|m| Some((m.get("from")?.as_str()?.to_string(), m.get("body")?.as_str()?.to_string())))
            .collect();
        assert_eq!(room, vec![
            ("lead".to_string(), "[tmm] /clear → dev waits for its turn to end".to_string()),
            ("lead".to_string(), "[tmm] /clear → dev cancelled before its turn ended".to_string()),
            ("human".to_string(), "[tmm] /compact → dev: no longer waiting for it to take effect".to_string()),
        ]);
    }

    /// reviewer 16:05: an UNKNOWN baseline never proves a reset. A codex
    /// pane whose thread cannot be read when `/new` is typed (`pane_thread`
    /// answers `None` for unreadable as for absent) keeps its gate when a
    /// thread later becomes readable; only the notice and a cancel end it.
    #[test]
    fn a_codex_reset_with_no_known_thread_before_never_takes_effect() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-codex-unknown");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "cx", "codex", "queue");
        fake();
        let home = std::path::Path::new(&scratch.path()).join(".tmm/agents/cx");
        assert!(crate::backends::Backend::Codex.current_thread(&home).is_none(), "no thread can be read yet");
        let brief = "[tmm chat 2026-11-06 16:05] lead: @cx the brief";
        assert_eq!(command_when_idle(&s, "cx", "t", "/new", "m1"), Ok(WhenIdle::Typed));
        assert!(deliver_as(&s, "cx", "t", brief, "m2", true));
        let locks = home.join("codex/thread-writer-locks");
        std::fs::create_dir_all(&locks).unwrap();
        std::fs::create_dir_all(home.join("codex/sessions")).unwrap();
        std::fs::write(locks.join("01a1b0c7-0000-7000-8000-00000000000a.lock"), "").unwrap();
        assert!(crate::backends::Backend::Codex.current_thread(&home).is_some(), "a thread is readable now");
        check_command_effects();
        assert_eq!(held_lines(&s, "cx").len(), 2, "no known thread before: no proof of a reset");
    }

    /// reviewer 16:04's ordering (orchestrator's round 2 pin): a `/compact`
    /// waiting across a RESTART is typed at the new CLI's idle edge; that CLI's
    /// own `SessionStart{startup}`, published at its start but consumed only
    /// after the release, must not retire it. Compaction's own
    /// `SessionStart{compact}`, published after the typing, does.
    #[test]
    fn a_delayed_startup_after_a_restart_does_not_release_a_compact() {
        let mut scratch = crate::tmux::Scratch::new("when-idle-restart-compact");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "cl", "claude", "");
        fake();
        let brief = "[tmm chat 2026-11-06 16:10] lead: @cl the brief";
        busy(&s, "cl");
        waiting(command_when_idle(&s, "cl", "t", "/compact", "m1"));
        assert!(deliver_as(&s, "cl", "t", brief, "m2", false));
        replace_cli(&s, "cl", None, || Ok(())).unwrap();
        let started = now_ns();
        end(&s, "cl");
        flush_at(&s, "cl", "t");
        assert_eq!(typed(), ["/compact"], "typed at the new CLI's idle edge");
        let t = typed_at_ns(telemetry::held_rows(&s, "cl")[0].id).unwrap();
        command_session_started(&s, "cl", Some("startup"), Some(started));
        assert_eq!(held_lines(&s, "cl").len(), 2, "the new CLI's startup is no compaction");
        command_session_started(&s, "cl", Some("compact"), Some(t + 1));
        assert_eq!(held_lines(&s, "cl"), [(brief.to_string(), None)], "compaction's own SessionStart releases it");
    }
}
