//! Typing a chat line into an agent's pane — the ONE path every delivery
//! takes (`@name` mentions, board notices, `[reply]` returns, typed briefs).
//!
//! Board #257 (owner, 2026-09-28: "kiro 有堆积未处理消息时，可以合并投递，保持
//! 效率高效"): a queue-mode agent that is mid-turn used to receive every line
//! as its own queued prompt — its own turn, its own full reply — so a burst of
//! 20 lines was 20 turns, and on 2026-09-27 builder's median delivery lag was
//! ~19.5 min (temp/stall-analysis.md). Now, while such a window's turn is open
//! (`telemetry::turn_busy`, derived from turn edges), a line is HELD: a row in
//! the one deliveries table, persisted, not typed. At the turn's end the held
//! lines are typed as ONE prompt — each line intact with its stamp, in order —
//! and the #249 echo match settles them all from that one submission.
//! Delivery is still typing into a pane (non-negotiable 12), later and
//! combined. An idle target, a steer-mode agent and every backend without a
//! queue/steer switch are typed at once, as before.
//!
//! Every decision and every typing for a window runs under one per-window
//! lock, so a line is never typed twice and a stop that lands between "is it
//! busy?" and "hold it" still finds the row.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use super::telemetry;

/// The most characters one combined prompt carries (board #257). Held lines
/// are packed whole, oldest first, until the next would pass it; the rest
/// stay held for the next turn's end, so an overflow becomes the fewest
/// prompts and later arrivals still join them. A single line longer than
/// this is typed alone, never cut: the echo match needs the whole line.
/// Measured on kiro-cli 2.22.1 (see hub-composer.md).
pub const FLUSH_MAX_CHARS: usize = 32 * 1024;

/// How long a line may be held before it is typed even though the window
/// still reads busy (board #257, measured on kiro-cli 2.22.1): an Escape
/// pressed IN the pane cancels the turn and fires no hook, so the window
/// keeps reading `running` until its next turn — and holding every line for
/// a turn that already ended would leave the agent deaf for good. Past this
/// age the held lines are typed at the next trigger anyway; a busy
/// queue-mode CLI queues them itself (what it did before #257), still as one
/// combined prompt, and an idle one starts the turn that corrects the state.
/// So a long turn gets at most one combined prompt per this interval.
pub const HOLD_MAX_SECS: u64 = 300;

/// What separates two held lines in the combined prompt: a blank line, the
/// same break a team context block already sits behind.
pub(super) const SEPARATOR: &str = "\n\n";

fn window_lock(session: &str, window: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let mut map = LOCKS.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap();
    if map.len() > 256 {
        map.retain(|_, lock| Arc::strong_count(lock) > 1);
    }
    map.entry(format!("{session}:{window}")).or_default().clone()
}

/// The launch recipe's backend and START mode (board #245): the mode the
/// session began in; a recipe from before the field reads `queue`, the v25
/// default. `None` for a window this app did not start.
fn recipe_mode(session: &str, window: &str) -> Option<(crate::backends::Backend, &'static str)> {
    let ws = super::project_for_session(session).ok().flatten()?.path;
    let home = super::agents::home_dir(&ws, window)?;
    let recipe: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).ok()?).ok()?;
    let backend = crate::backends::Backend::parse(recipe["backend"].as_str()?)?;
    Some((backend, if recipe["input_mode"].as_str() == Some("steer") { "steer" } else { "queue" }))
}

/// The last mode the SCREEN showed, per window, with the pane it was read
/// on: kiro paints nothing about the mode while idle, so a Ctrl+S whose
/// confirmation has scrolled away is remembered — but only for that pane. A
/// restart kills the window (a new pane id) and the session starts from the
/// recipe again, as kiro itself does.
fn seen_modes() -> &'static Mutex<HashMap<(String, String), (String, &'static str)>> {
    static SEEN: OnceLock<Mutex<HashMap<(String, String), (String, &'static str)>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The queue/steer mode a managed agent's session RUNS now (board #271;
/// orchestrator 03:58): what its screen says (`Backend::live_input_mode`,
/// the one reading, in the backend file), else what the screen said last in
/// this same pane, else the launch recipe's start mode. `pane` is the
/// window's pane id and `screen` a capture of it. `None` for a window this
/// app did not start or a backend without the choice.
pub fn input_mode_seen(session: &str, window: &str, pane: &str, screen: &str) -> Option<&'static str> {
    let (backend, start) = recipe_mode(session, window)?;
    if !backend.switches_input_mode() {
        return None;
    }
    let key = (session.to_string(), window.to_string());
    let mut seen = seen_modes().lock().unwrap();
    if seen.len() > 512 {
        seen.clear();
    }
    if let Some(now) = backend.live_input_mode(screen) {
        seen.insert(key, (pane.to_string(), now));
        return Some(now);
    }
    match seen.get(&key) {
        Some((p, m)) if p == pane => Some(*m),
        _ => {
            seen.remove(&key);
            Some(start)
        }
    }
}

/// The same, capturing the window's visible screen now.
pub fn input_mode(session: &str, window: &str) -> Option<&'static str> {
    let pane = crate::tmux::find_window_by_name(session, window).unwrap_or_default();
    let screen = if pane.is_empty() { String::new() } else { crate::tmux::capture_pane_plain(&pane, Some(0)).unwrap_or_default() };
    input_mode_seen(session, window, &pane, &screen)
}

/// Switch the session to `want` with the CLI's live toggle `key` (board
/// #271), as ONE step under the window's delivery lock and then the pane's
/// send lock — the order every delivery takes them in (window → pane), so
/// the two can never deadlock. The window lock is the one `deliver` reads
/// the mode under (validator 04:48): a line decides queue-or-type against
/// the mode before a switch or after it, never between the read and the
/// hold. The send lock keeps two clients asking for the same mode at once
/// from both reading the old mode and both pressing, toggling it back
/// (validator 04:31). Idempotent — nothing is typed when the pane already
/// runs `want` — and verified: after the one key the pane must show `want`
/// within `VERIFY`, else an error, never a second press. `Ok(true)` =
/// switched, `Ok(false)` = was already there.
pub fn switch_input_mode(session: &str, window: &str, target: &str, want: &'static str, key: &str) -> Result<bool, String> {
    // The pane id keys the remembered reading, as for every other caller.
    let pane = crate::tmux::find_window_by_name(session, window).unwrap_or_default();
    let read = || {
        let screen = crate::tmux::capture_pane_plain(target, Some(0)).unwrap_or_default();
        input_mode_seen(session, window, &pane, &screen)
    };
    switch_with(session, window, target, want, read, || crate::tmux::send_keys(target, key, false), SWITCH_VERIFY)
}

const SWITCH_VERIFY: std::time::Duration = std::time::Duration::from_secs(3);

/// The switch's logic with its screen and its key injected (tested).
fn switch_with(
    session: &str,
    window: &str,
    target: &str,
    want: &'static str,
    read: impl Fn() -> Option<&'static str>,
    press: impl FnOnce() -> Result<(), String>,
    verify: std::time::Duration,
) -> Result<bool, String> {
    let lock = window_lock(session, window);
    let _window = lock.lock().unwrap();
    crate::tmux::with_pane_send_lock(target, || {
        if read() == Some(want) {
            return Ok(false);
        }
        press()?;
        let deadline = std::time::Instant::now() + verify;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if read() == Some(want) {
                return Ok(true);
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!("the pane did not confirm {want} mode"));
            }
        }
    })
}

/// The live pane of a managed agent window, as a tmux target — `None` for a
/// dead window, a shell, or an agent this app did not start.
pub fn agent_target(session: &str, window: &str) -> Option<String> {
    let ws = super::project_for_session(session).ok().flatten().map(|p| p.path);
    let panes = crate::tmux::list_panes(session).ok()?;
    let p = panes.iter().find(|p| p.active && p.window_name == window)?;
    let is_agent = super::agents::detect_pane(ws.as_deref(), p).is_some();
    (is_agent && super::is_managed_in(ws.as_deref(), window)).then(|| format!("{}:{}.{}", session, p.window, p.pane))
}

/// Why a mentioned name could not be typed into (board #347). Two words for
/// what we know, because the sender can only act on two: the slot is there
/// and nothing is running it, or this project has no such agent at all — and
/// a third for what we do NOT know.
pub const OFFLINE_STOPPED: &str = "stopped";
pub const OFFLINE_UNKNOWN: &str = "unknown";
/// tmux could not be asked whether the agent is running (a permission or
/// connection failure, not a missing session): nothing was typed, but
/// "stopped" would be an assertion we cannot back (review P1, 02:30).
pub const OFFLINE_UNCHECKED: &str = "unchecked";

/// The `@mentions` of one message that matched NO live managed agent pane,
/// each with its word (board #347; owner: "当这个 agent 不在会话，或者停止什么
/// 的时候要返回一个 warning，提示 agent 不在线"). A delivery to nobody used to
/// be SILENT: the message was stored in the room, every mention of a stopped
/// or misspelled agent was dropped on the floor, and the sender — human or
/// agent — had no way to tell that from a delivery that landed.
///
/// `found` is who was FOUND, not who was typed to: a name that matched a
/// live managed pane is found whether the line was typed, held for a busy
/// queue-mode agent (#257), or refused by the pane (copy mode, #250). Those
/// three outcomes belong to `deliver` — the last has its own `undelivered`
/// warn — and deriving "offline" from "not accepted" reported a live agent
/// whose pane merely refused as `stopped`, a second and false report of one
/// event (review P1-A, 02:30).
///
/// `declared` is which of the mentions this project HAS a managed home for
/// (`is_managed_in`), which separates a stopped teammate from a name that was
/// never here; `None` means tmux could not be asked at all, so no name can be
/// called stopped. Three names are never missing recipients: `all` addresses
/// whoever is there, `human` reads the room instead of a pane, and the
/// sender's own name is deliberately never typed back into its own pane.
///
/// Order is the mention order and each name is reported once, so a body that
/// says `@dev @dev` warns once.
pub fn offline_mentions<'a>(
    mentions: &'a [String], found: &[String], declared: Option<&[String]>, from: &str,
) -> Vec<(&'a str, &'static str)> {
    let mut out: Vec<(&str, &'static str)> = Vec::new();
    for name in mentions {
        let n = name.as_str();
        if n == "all" || n == "human" || n == from || found.iter().any(|r| r == n) {
            continue;
        }
        if out.iter().any(|(seen, _)| *seen == n) {
            continue;
        }
        let why = match declared {
            None => OFFLINE_UNCHECKED,
            Some(d) if d.iter().any(|x| x == n) => OFFLINE_STOPPED,
            Some(_) => OFFLINE_UNKNOWN,
        };
        out.push((n, why));
    }
    out
}

/// A word as the sentence says it: `unchecked` carries its own meaning, the
/// other two stand alone.
fn why_text(why: &str) -> &str {
    if why == OFFLINE_UNCHECKED { "unchecked: tmux could not be asked" } else { why }
}

/// The room line one offline recipient leaves: the lifecycle grammar every
/// other `[tmm]` row speaks (`sysParts`: verb, subject, detail), so the feed
/// renders it with the atoms it already has. It says what did NOT happen and
/// that nothing is pending, because the one thing a sender must not do is
/// wait for an answer that cannot come — there is no retry and no queue (a
/// message to nobody is not stored for later; the message itself stays in
/// the room, where it was posted).
///
/// Posted under the sender's own name with no recipients (`rooms::post`):
/// addressing it to the sender would make it the sender's delivery cursor in
/// `team_context` and hide it from them (see hub-composer.md).
pub fn offline_line(name: &str, why: &str, from: &str) -> String {
    format!("[tmm] offline {name} — {from}'s message was not typed in ({}); nothing is queued for it", why_text(why))
}

/// The sender a server-authored notice wears in a pane.
pub const NOTICE_SENDER: &str = "tmm";

/// The ONE line the sender's own pane gets when its message reached nobody
/// (board #347 review P1-A). The room line is the record for the feed and
/// the log; this is what actually reaches an AGENT sender, because the team
/// context cannot carry it — `context_noise` drops every `[tmm]` row, and a
/// Team agent's delta excludes its own messages anyway. One line for all of
/// them, not one per name: a pane is a conversation, and a burst of
/// near-identical rows in it is noise.
///
/// It is typed in the stamped RESULT shape — `[tmm chat <stamp>] tmm:
/// [reply] …` — the one the reply edge already reads as "asks nothing"
/// (`address::requesters`). A BARE `[tmm] offline …` line is an unstamped
/// prompt, and `requesters` takes every unstamped typed prompt for a person
/// at the keyboard: the agent's reply to its own warning would have been
/// recorded as an answer to `human` (#289), and a notice that JOINS an open
/// turn would have added a requester that never asked (review P1-B, 02:30).
/// Pinned on the real output, not on a look-alike.
///
/// Quiet by construction for a human or a UI sender: `deliver_chat_line`
/// types only into a live managed pane and does nothing otherwise, which is
/// the right answer — the operator reads the feed. A sender pane that
/// REFUSES it (copy mode) gets the ordinary `undelivered` warn from the
/// delivery path, and nothing is retried.
pub fn offline_notice(offline: &[(&str, &'static str)], stamp: &str) -> String {
    let names: Vec<String> = offline.iter().map(|(name, why)| format!("@{name} ({})", why_text(why))).collect();
    let (pane, it) = if offline.len() == 1 { ("its", "it") } else { ("their", "them") };
    format!(
        "[tmm chat {stamp}] {NOTICE_SENDER}: [reply] offline — {}: your message is in the room but was not typed into {pane} pane; nothing is queued for {it}.",
        names.join(", "),
    )
}

/// What a team's CURRENT members are told when an agent JOINS their team at
/// runtime (board #382, reviewer P1-B on 56a3ad44). They are not
/// re-materialized (their prompts keep the roster they were started with),
/// and the room's `[tmm] spawned … — joined team` line never reaches them:
/// `context_noise` drops every `[tmm]` row from the team context. So the
/// join is TYPED to each of them, once, in the stamped RESULT shape the
/// offline notice uses (`[tmm chat <stamp>] tmm: [reply] …`, see
/// `offline_notice`): it asks nothing, so it opens no reply edge, and the
/// agent's answer to it is not taken for an answer to anyone. Names the
/// joiner, its backend, who started it, that the team's definition does not
/// list it, and how to address it; its brief, if any, on one line.
pub fn join_notice(joiner: &str, team: &str, backend: &str, by: &str, brief: &str, stamp: &str) -> String {
    let who = if by.trim().is_empty() { "human" } else { by.trim() };
    let mut line = format!(
        "[tmm chat {stamp}] {NOTICE_SENDER}: [reply] @{joiner} joined your team {team}: a {backend} agent started by {who}; the team's definition does not list it (a team restart leaves it running). Address it with tmm send \"@{joiner} …\"."
    );
    let flat = brief.split_whitespace().collect::<Vec<_>>().join(" ");
    if !flat.is_empty() {
        let cut: String = flat.chars().take(120).collect();
        let more = if flat.chars().count() > 120 { "…" } else { "" };
        line += &format!(" Its brief: {cut}{more}");
    }
    line
}

/// Deliver one line to one managed agent window whose pane is `target`.
/// True when it was typed or held; false when the pane refused it (said in
/// the feed as `undelivered`, board #250). `ask_at` is where the stamped
/// line starts in `line` — its producer typed a Team context before it
/// (board #279, `address::context_first`) — and 0 when nothing leads it.
pub fn deliver(session: &str, window: &str, target: &str, line: &str, ask_at: usize, msg_id: &str) -> bool {
    deliver_with(session, window, target, line, ask_at, msg_id, || input_mode(session, window))
}

/// `deliver` for a line that is only worth typing if something is STILL true
/// (board #355: the stall nudge, "this empty end is still the newest and the
/// agent is still at rest"). `still_due` runs INSIDE the window's lock and the
/// turn-fact lock, in the same step as the decision and the typing, so a prompt
/// or an interrupt cannot fall between the check and the line — a check made
/// before a slow query and a delivery made after it did exactly that (review
/// P1-B). False = dropped silently: nothing typed, held or recorded, and the
/// result is false.
pub fn deliver_if(session: &str, window: &str, target: &str, line: &str, still_due: &dyn Fn() -> bool) -> bool {
    deliver_gated(session, window, target, line, 0, "", || input_mode(session, window), still_due)
}

/// Tests' shorthand: deliver with the mode decided up front (`true` = a
/// queue-mode session, `false` = a backend without the choice).
#[cfg(test)]
fn deliver_as(session: &str, window: &str, target: &str, line: &str, msg_id: &str, coalesce: bool) -> bool {
    deliver_with(session, window, target, line, 0, msg_id, || coalesce.then_some("queue"))
}

/// `deliver` with the mode reading injected. The mode is read INSIDE the
/// window's lock — the lock `switch_input_mode` holds across its key and its
/// verify (validator 04:48) — so the line is decided against the mode before
/// a switch or after it, never between.
///
/// A steer window is also "open" while a line typed into it idle has not
/// echoed yet (#281): the turn has started in the CLI before its prompt
/// hook reached us, so a second line inside that span is steered.
///
/// Three outcomes for a window whose turn is open: QUEUE holds the line
/// (#257); STEER types it into the running turn and owes no echo (#276:
/// a steered line fires no `userPromptSubmit`, so a pending row could only
/// ever be swept `unconfirmed`); no choice types it as before.
fn deliver_with(session: &str, window: &str, target: &str, line: &str, ask_at: usize, msg_id: &str, mode: impl FnOnce() -> Option<&'static str>) -> bool {
    deliver_gated(session, window, target, line, ask_at, msg_id, mode, &|| true)
}

/// `deliver_with` plus a gate evaluated inside the critical section (see
/// `deliver_if`); every ordinary delivery passes the gate that is always open.
#[allow(clippy::too_many_arguments)]
fn deliver_gated(
    session: &str,
    window: &str,
    target: &str,
    line: &str,
    ask_at: usize,
    msg_id: &str,
    mode: impl FnOnce() -> Option<&'static str>,
    gate: &dyn Fn() -> bool,
) -> bool {
    let lock = window_lock(session, window);
    let _guard = lock.lock().unwrap();
    let held = telemetry::held_rows(session, window);
    let mode = mode();
    // The decision below and the typing and row it leads to are ONE step
    // against the prompt edge (validator 11:50): `record_prompt` deletes the
    // first line's row and then writes its prompt fact under this lock, so
    // `turn_busy` and `line_in_flight` are never read in between. Order:
    // window lock → this → pane send lock (typing).
    let _order = telemetry::delivery_decision();
    if !gate() {
        return false;
    }
    // A steer window whose last line was typed idle but has not echoed yet
    // is already IN that turn (board #281): kiro took the first line, so a
    // second one lands in the running turn — steered, no hook. The owed
    // row itself says so (`line_in_flight`); queue mode waits for the edge
    // as before (its lines echo on their own turn).
    let open = mode.is_some()
        && (telemetry::turn_busy(session, window) || (mode == Some("steer") && telemetry::line_in_flight(session, window)));
    let busy = open && mode == Some("queue");
    let steered = open && mode == Some("steer");
    if steered && held.is_empty() {
        return type_steered(session, window, target, line, ask_at, msg_id);
    }
    if !busy && held.is_empty() {
        return type_now(session, window, target, line, ask_at, msg_id);
    }
    // Held — for the busy turn's end, or (idle) BEHIND lines still held from a
    // copy-mode refusal or a restart, never ahead of them. A hold that could
    // not be written is today's behaviour, never a silent loss (orchestrator
    // 04:49): type it now, as an ordinary delivery; if that fails too, the
    // existing `undelivered` warn says so.
    if let Err(e) = telemetry::record_held(session, window, line, ask_at, msg_id) {
        eprintln!("⚠️  could not hold a delivery for {session}:{window} ({e}); typing it now");
        // Into a steer turn it is steered, owing no echo (validator, #276).
        return if steered { type_steered(session, window, target, line, ask_at, msg_id) } else { type_now(session, window, target, line, ask_at, msg_id) };
    }
    if !busy || overdue(&held) {
        flush_locked(session, window, target, steered);
    }
    true
}

/// A line typed into a BUSY steer-mode session's running turn (board #276):
/// typed, but no pending row — nothing can settle it, and the sweep would
/// report a line the model did receive. Recorded as a `steered` event naming
/// its message, so the feed draws no ring that promises a check. A refusal
/// is said at once, as for any line (#250).
fn type_steered(session: &str, window: &str, target: &str, line: &str, ask_at: usize, msg_id: &str) -> bool {
    match type_text(target, line) {
        Ok(()) => {
            telemetry::record_steered(session, window, &crate::address::shown(line, ask_at), &[msg_id]);
            super::vitals::sniff_window_soon(session, window);
            true
        }
        Err(e) => {
            telemetry::record_undelivered(session, window, &crate::address::shown(line, ask_at), e.trim());
            false
        }
    }
}

/// Has the oldest held line waited past `HOLD_MAX_SECS`?
fn overdue(held: &[super::store::DeliveryRow]) -> bool {
    held.first().is_some_and(|r| super::now().saturating_sub(r.ts) >= HOLD_MAX_SECS)
}

/// The pre-#257 path: type the line, then record the promise its echo will
/// settle; a refusal is said at once and records nothing (#250).
fn type_now(session: &str, window: &str, target: &str, line: &str, ask_at: usize, msg_id: &str) -> bool {
    match type_text(target, line) {
        Ok(()) => {
            telemetry::record_typed(session, window, line, ask_at, msg_id);
            // A line just landed in this pane: sniff its vitals once the TUI
            // has repainted (delayed + throttled inside).
            super::vitals::sniff_window_soon(session, window);
            true
        }
        Err(e) => {
            telemetry::record_undelivered(session, window, &crate::address::shown(line, ask_at), e.trim());
            false
        }
    }
}

/// Type the window's held lines if its turn is over. Triggers: the turn's
/// end edge (the stop hook), the next delivery, and the feed read — never a
/// timer. A busy window keeps them.
pub fn flush(session: &str, window: &str) {
    if telemetry::held_rows(session, window).is_empty() {
        return;
    }
    let Some(target) = agent_target(session, window) else { return };
    flush_at(session, window, &target);
}

/// `flush` for every window of a session that holds lines (the feed read:
/// it also picks up what a restart left held for an agent that went idle).
pub fn flush_idle(session: &str) {
    for window in telemetry::held_windows(session) {
        flush(session, &window);
    }
}

/// The fourth trigger (orchestrator, #257 decision 3): at server start, every
/// window that holds lines and is idle once its turn is RECOVERED is flushed
/// at once, so held lines never wait for a client to read the feed. The
/// recovery is `turn_busy`'s own first step (`recovery_mark` →
/// `recover_open_turns`), per session, before the question is asked; a window
/// still running keeps its lines for its stop.
pub fn flush_on_start() {
    for session in telemetry::held_sessions() {
        flush_idle(&session);
    }
}

fn flush_at(session: &str, window: &str, target: &str) {
    let lock = window_lock(session, window);
    let _guard = lock.lock().unwrap();
    let busy = telemetry::turn_busy(session, window);
    if busy && !overdue(&telemetry::held_rows(session, window)) {
        return;
    }
    // An overdue flush into a turn still open: steered if the session now
    // runs steer (#276), so its rows are owed no echo.
    let steered = busy && input_mode(session, window) == Some("steer");
    flush_locked(session, window, target, steered);
}

/// Type the first combined prompt of the held lines. The rows are marked
/// typed BEFORE the keys go in (an echo racing the Enter must find them) and
/// put back on a refusal: a pane in copy mode keeps them held, reported once,
/// retried at the next trigger (board #257 decision 2 — the sender was
/// already told the line is queued).
fn flush_locked(session: &str, window: &str, target: &str, steered: bool) {
    let rows = telemetry::held_rows(session, window);
    let take = first_prompt(&rows.iter().map(|r| r.line.as_str()).collect::<Vec<_>>(), FLUSH_MAX_CHARS);
    if take == 0 {
        return;
    }
    let batch = &rows[..take];
    let ids: Vec<i64> = batch.iter().map(|r| r.id).collect();
    let text = batch.iter().map(|r| r.line.as_str()).collect::<Vec<_>>().join(SEPARATOR);
    if steered {
        return flush_steered(session, window, target, batch, &ids, &text);
    }
    // The batch flips as ONE transaction; if it cannot, nothing is typed and
    // every row stays held for the next trigger (orchestrator 04:49).
    if let Err(e) = telemetry::release_held(&ids) {
        eprintln!("⚠️  could not release held deliveries for {session}:{window} ({e}); kept held");
        return;
    }
    match type_text(target, &text) {
        Ok(()) => super::vitals::sniff_window_soon(session, window),
        Err(e) => {
            if let Err(err) = telemetry::rehold(&ids) {
                eprintln!("⚠️  could not re-hold deliveries for {session}:{window} ({err})");
            }
            let reason = if e.trim() == crate::tmux::PANE_IN_MODE { "pane in copy mode".to_string() } else { e.trim().to_string() };
            telemetry::record_held_blocked(session, window, &rows, &reason);
        }
    }
}

/// Held lines flushed into a turn that runs steer (#276; orchestrator 09:28:
/// close the window by ORDER). They owe no echo, so their rows are RETIRED
/// in one transaction BEFORE the keys go in: no moment exists in which a
/// typed line has a pending row (a crash or restart after the retire leaves
/// nothing to sweep). The retire failing types nothing — the rows stay held,
/// typed at the turn's end like any queue line. Typing failing after it is a
/// line that did not land: the #250 `undelivered` warn, no row to point at.
fn flush_steered(session: &str, window: &str, target: &str, batch: &[super::store::DeliveryRow], ids: &[i64], text: &str) {
    if let Err(e) = telemetry::retire_held(ids) {
        eprintln!("⚠️  could not retire held deliveries for {session}:{window} ({e}); kept held for the turn's end");
        return;
    }
    let msgs: Vec<&str> = batch.iter().map(|r| r.msg_id.as_str()).collect();
    let shown = batch.iter().map(|r| r.shown()).collect::<Vec<_>>().join(SEPARATOR);
    match type_text(target, text) {
        Ok(()) => {
            telemetry::record_steered(session, window, &shown, &msgs);
            super::vitals::sniff_window_soon(session, window);
        }
        Err(e) => telemetry::record_undelivered(session, window, &shown, e.trim()),
    }
}

/// An interrupt ends the window's turn and DROPS its held lines (board #257
/// decision 1), under the window's lock so a delivery cannot flush them in
/// between. `end` records the turn's end (`telemetry::record_interrupt`).
pub fn interrupt(session: &str, window: &str, end: impl FnOnce()) {
    let lock = window_lock(session, window);
    let _guard = lock.lock().unwrap();
    end();
    telemetry::drop_held(session, window);
}

/// How many of `lines` (oldest first) the next combined prompt carries:
/// whole lines while the total, separators included, stays within `max`;
/// always at least one. Pure.
fn first_prompt(lines: &[&str], max: usize) -> usize {
    let mut chars = 0;
    for (i, line) in lines.iter().enumerate() {
        let cost = line.chars().count() + if i == 0 { 0 } else { SEPARATOR.len() };
        if i > 0 && chars + cost > max {
            return i;
        }
        chars += cost;
    }
    lines.len()
}

#[cfg(not(test))]
fn type_text(target: &str, text: &str) -> Result<(), String> {
    crate::tmux::send_command(target, text)
}

#[cfg(test)]
thread_local! {
    /// Test seam: when `Some`, typing is recorded here instead of reaching
    /// tmux, and `REFUSE` decides the outcome.
    static TYPED: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) };
    static REFUSE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn type_text(target: &str, text: &str) -> Result<(), String> {
    let faked = TYPED.with(|t| t.borrow().is_some());
    if !faked {
        return crate::tmux::send_command(target, text);
    }
    if let Some(e) = REFUSE.with(|r| r.borrow().clone()) {
        return Err(e);
    }
    TYPED.with(|t| t.borrow_mut().as_mut().unwrap().push(text.to_string()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projects::telemetry::{record_notification, record_prompt};

    fn fake() {
        TYPED.with(|t| *t.borrow_mut() = Some(Vec::new()));
        REFUSE.with(|r| *r.borrow_mut() = None);
    }
    fn typed() -> Vec<String> {
        TYPED.with(|t| t.borrow().clone().unwrap_or_default())
    }
    fn refuse(e: Option<&str>) {
        REFUSE.with(|r| *r.borrow_mut() = e.map(str::to_string));
    }
    fn pending(session: &str, window: &str) -> usize {
        crate::projects::with_store(|s| s.pending_deliveries(session, Some(window))).unwrap().len()
    }
    fn held(session: &str, window: &str) -> usize {
        telemetry::held_rows(session, window).len()
    }
    /// Board #347 (owner: "当这个 agent 不在会话，或者停止什么的时候要返回一个
    /// warning，提示 agent 不在线"). A mention nobody received used to be
    /// silent, and silence reads exactly like a delivery that landed.
    #[test]
    fn a_mention_no_pane_received_is_named_with_its_reason() {
        let names = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mentions = names(&["dev", "reviewer", "buildr", "all", "human", "lead"]);
        // `dev` was FOUND (a live managed pane matched it).
        let found = names(&["dev"]);
        // `reviewer` has a managed home in this project; `buildr` is a typo
        // and `lead` belongs to another project — both read as unknown from
        // here, which is the only thing this project can honestly say.
        let declared = names(&["dev", "reviewer"]);
        assert_eq!(
            offline_mentions(&mentions, &found, Some(&declared), "lead"),
            vec![("reviewer", OFFLINE_STOPPED), ("buildr", OFFLINE_UNKNOWN)],
            "the sender's own name, @all and @human are never missing recipients"
        );
        // Everyone found: nothing to say.
        assert!(offline_mentions(&mentions[..1], &found, Some(&declared), "lead").is_empty());
        // One warning per name, in mention order, however often it is said.
        assert_eq!(
            offline_mentions(&names(&["dev", "dev"]), &[], Some(&declared), "human"),
            vec![("dev", OFFLINE_STOPPED)]
        );
        // `@all` into an empty project is not a missing recipient: it names
        // whoever is there, and nobody is.
        assert!(offline_mentions(&names(&["all"]), &[], Some(&[]), "human").is_empty());

        // tmux could not be asked (review P1-A: a permission or connection
        // failure is not "the session is gone"): nothing is called stopped,
        // not even a name the project declares.
        assert_eq!(
            offline_mentions(&names(&["reviewer", "buildr"]), &[], None, "lead"),
            vec![("reviewer", OFFLINE_UNCHECKED), ("buildr", OFFLINE_UNCHECKED)]
        );

        // The line it leaves says what did NOT happen AND that nothing is
        // pending, in the grammar every other `[tmm]` row speaks.
        assert_eq!(
            offline_line("reviewer", OFFLINE_STOPPED, "orchestrator"),
            "[tmm] offline reviewer — orchestrator's message was not typed in (stopped); nothing is queued for it"
        );
        assert!(
            offline_line("reviewer", OFFLINE_UNCHECKED, "orchestrator").contains("(unchecked: tmux could not be asked)"),
            "the unknown is said as unknown"
        );
    }

    /// The sender's pane notice (review P1-A and P1-B, 02:30). It is typed in
    /// the stamped RESULT shape, because a BARE `[tmm] offline …` line is an
    /// unstamped prompt and `requesters` takes every unstamped typed prompt
    /// for a person at the keyboard: the agent's reply to its own warning was
    /// recorded as an answer to `human`, and a notice that joined an open
    /// turn added a requester that never asked. Asserted on the REAL output
    /// of `offline_notice`, never on a look-alike.
    #[test]
    fn the_senders_notice_asks_nothing_of_the_reply_edge() {
        let notice = offline_notice(&[("reviewer", OFFLINE_STOPPED), ("buildr", OFFLINE_UNKNOWN)], "2026-10-15 02:40");
        assert!(
            notice.starts_with("[tmm chat 2026-10-15 02:40] tmm: [reply] offline — @reviewer (stopped), @buildr (unknown):"),
            "{notice}"
        );
        assert!(notice.contains("is in the room"), "what DID happen: {notice}");
        assert!(notice.contains("their pane") && notice.contains("nothing is queued for them"), "{notice}");
        let one = offline_notice(&[("reviewer", OFFLINE_STOPPED)], "2026-10-15 02:40");
        assert!(one.contains("its pane") && one.contains("queued for it"), "{one}");

        // On its own it is nobody's request — and not a human's either.
        assert!(crate::address::requesters(&notice).is_empty(), "{notice}");
        // Joining a turn that already has a real request leaves exactly that
        // request: it neither adds a requester nor clears the edge.
        let asked = "[tmm chat 2026-10-15 02:39] lead: @dev please look";
        for prompt in [format!("{asked}\n\n{notice}"), format!("{notice}\n\n{asked}")] {
            assert_eq!(crate::address::requesters(&prompt), vec!["lead".to_string()], "{prompt}");
        }
        // The look-alike this replaced WOULD have been a human request: that
        // is the bug this test exists to keep out.
        let bare = "[tmm] offline — @reviewer (stopped): your message is in the room.";
        assert_eq!(crate::address::requesters(bare), vec!["human".to_string()]);
    }

    /// Board #382 reviewer P1-B: the join notice is typed to a team's members
    /// in the same result shape, so it asks nothing, alone or joining a turn
    /// that already has a real request. Asserted on the REAL output.
    #[test]
    fn the_join_notice_asks_nothing_of_the_reply_edge() {
        let notice = join_notice("helper", "squad", "kiro", "", "", "2026-10-15 16:00");
        assert_eq!(notice, "[tmm chat 2026-10-15 16:00] tmm: [reply] @helper joined your team squad: a kiro agent started by human; the team's definition does not list it (a team restart leaves it running). Address it with tmm send \"@helper …\".");
        assert!(crate::address::requesters(&notice).is_empty(), "{notice}");
        let asked = "[tmm chat 2026-10-15 15:59] lead: @dev please look";
        assert_eq!(crate::address::requesters(&format!("{asked}\n\n{notice}")), vec!["lead".to_string()]);
        let briefed = join_notice("helper", "squad", "codex", "lead", &format!("Port the\n  parser. {}", "x".repeat(200)), "2026-10-15 16:00");
        assert!(briefed.contains("a codex agent started by lead;"), "{briefed}");
        assert!(briefed.contains(" Its brief: Port the parser. xxx") && briefed.ends_with("x…") && !briefed.contains('\n'), "one line, clipped: {briefed}");
        assert!(crate::address::requesters(&briefed).is_empty(), "{briefed}");
    }

    fn warns(session: &str) -> Vec<String> {
        telemetry::recent_events(session, 0).into_iter().filter(|e| e.kind == "warn").map(|e| e.text).collect()
    }
    fn busy(session: &str, window: &str) {
        record_prompt(session, window, "[tmm chat 2026-09-28 03:00] human: @dev a long task");
        assert!(telemetry::turn_busy(session, window));
    }
    fn end(session: &str, window: &str) {
        record_notification(session, window, "completed", crate::projects::now());
    }
    fn setup(tag: &str) -> String {
        crate::projects::tests::use_test_store();
        fake();
        format!("coalesce-{tag}-{}", uuid::Uuid::new_v4())
    }

    /// A managed agent's home with a launch recipe, in a project the store
    /// knows — what `recipe_mode` reads.
    fn agent_with_recipe(scratch: &crate::tmux::Scratch, session: &str, window: &str, backend: &str, mode: &str) {
        crate::projects::tests::use_test_store();
        let path = scratch.path();
        if crate::projects::project_for_session(session).unwrap().is_none() { crate::projects::with_store(|s| s.insert_project(&crate::projects::Project {
            id: session.into(), name: session.into(), path: path.clone(), icon: None,
            session: session.into(), adopted: false, autostart: false, created_at: 1,
            last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        })).unwrap(); }
        let home = std::path::Path::new(&path).join(".tmm").join("agents").join(window);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": backend, "input_mode": mode, "cmd": "x" }).to_string()).unwrap();
    }

    /// Board #271 (validator 04:31): two concurrent switches to the same mode
    /// on one pane press ONE key; the second sees the switched pane and
    /// changes nothing. The fake pane repaints only after a delay, the
    /// window in which both would otherwise read the old mode.
    #[test]
    fn concurrent_switches_to_one_mode_press_one_key() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let target = format!("switch-test-{}", uuid::Uuid::new_v4());
        let presses = Arc::new(AtomicUsize::new(0));
        let mode = Arc::new(Mutex::new("queue"));
        let run = |target: String, presses: Arc<AtomicUsize>, mode: Arc<Mutex<&'static str>>| {
            std::thread::spawn(move || {
                let read = || Some(*mode.lock().unwrap());
                let press = || {
                    presses.fetch_add(1, Ordering::SeqCst);
                    let mode = mode.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(120));
                        let mut m = mode.lock().unwrap();
                        *m = if *m == "queue" { "steer" } else { "queue" };
                    });
                    Ok(())
                };
                switch_with("switch-s", &target, &target, "steer", read, press, std::time::Duration::from_secs(2))
            })
        };
        let a = run(target.clone(), presses.clone(), mode.clone());
        let b = run(target.clone(), presses.clone(), mode.clone());
        let mut results = vec![a.join().unwrap(), b.join().unwrap()];
        results.sort();
        assert_eq!(presses.load(Ordering::SeqCst), 1, "one key for two requests");
        assert_eq!(*mode.lock().unwrap(), "steer", "the pane ends in the asked mode");
        assert_eq!(results, vec![Ok(false), Ok(true)], "one switched, the other found it switched");
    }

    /// Board #346: the switch is confirmed by reading the pane through the
    /// backend's own matcher, so these two tell the two drifts apart — one
    /// pane answers only through the 2.28.0 footer (elapsed segment, no
    /// toast), the other only through the 2.28.0 toast (idle, where kiro
    /// paints no footer at all). Before the fix each timed out with "the
    /// pane did not confirm steer mode" while the pane had switched.
    #[test]
    fn a_switch_is_confirmed_by_the_live_footer_alone() {
        let target = format!("switch-test-{}", uuid::Uuid::new_v4());
        let screen = Arc::new(Mutex::new("›  Kiro is working · 2m 3s · Type to queue · Ctrl+S to steer\n".to_string()));
        let read = {
            let screen = screen.clone();
            move || crate::backends::Backend::Kiro.live_input_mode(&screen.lock().unwrap())
        };
        let press = {
            let screen = screen.clone();
            move || {
                *screen.lock().unwrap() = "›  Kiro is working · 2m 4s · Type to steer · Ctrl+S to queue\n".to_string();
                Ok(())
            }
        };
        assert_eq!(switch_with("switch-s", &target, &target, "steer", read, press, std::time::Duration::from_millis(500)), Ok(true));
    }

    #[test]
    fn a_switch_is_confirmed_by_the_live_toast_on_an_idle_pane() {
        let target = format!("switch-test-{}", uuid::Uuid::new_v4());
        let idle = "Default · claude-opus-5 · thinking · high · ◔ 2%    /tmp\n\n›  ask a question or describe a task ↵\n";
        let screen = Arc::new(Mutex::new(idle.to_string()));
        let read = {
            let screen = screen.clone();
            move || crate::backends::Backend::Kiro.live_input_mode(&screen.lock().unwrap())
        };
        assert_eq!(read(), None, "an idle pane says nothing until the toast");
        let press = {
            let screen = screen.clone();
            move || {
                *screen.lock().unwrap() = format!("• Switched to Steer mode\n{idle}");
                Ok(())
            }
        };
        assert_eq!(switch_with("switch-s", &target, &target, "steer", read, press, std::time::Duration::from_millis(500)), Ok(true));
    }

    #[test]
    fn a_switch_the_pane_never_confirms_is_an_error_after_one_key() {
        let target = format!("switch-test-{}", uuid::Uuid::new_v4());
        let presses = std::cell::Cell::new(0);
        let r = switch_with("switch-s", &target, &target, "steer", || Some("queue"), || { presses.set(presses.get() + 1); Ok(()) }, std::time::Duration::from_millis(200));
        assert_eq!(presses.get(), 1, "never a blind second press");
        assert!(r.unwrap_err().contains("did not confirm steer"));
        assert_eq!(switch_with("switch-s", &target, &target, "queue", || Some("queue"), || panic!("no key when already there"), std::time::Duration::from_millis(10)), Ok(false));
        assert!(switch_with("switch-s", &target, &target, "steer", || None, || Err("tmux says no".into()), std::time::Duration::from_millis(10)).is_err(),
            "a key tmux refused is an error, not a success");
    }

    /// A fake kiro pane for the switch: its mode, and a key that flips it
    /// only after `delay` — kiro repaints a beat after Ctrl+S.
    fn slow_pane(mode: &Arc<Mutex<&'static str>>, delay: u64) -> impl FnOnce() -> Result<(), String> {
        let mode = mode.clone();
        move || {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(delay));
                let mut m = mode.lock().unwrap();
                *m = if *m == "queue" { "steer" } else { "queue" };
            });
            Ok(())
        }
    }

    /// Board #271 (validator 04:48), switch first: a line for a busy kiro
    /// that arrives while a switch to steer is between its key and its
    /// verify waits for the switch and is decided against STEER — typed now,
    /// not held for a turn end a steered line never echoes. The negative
    /// control is the pre-fix shape (mode read before the window lock): the
    /// same interleaving reads the old queue and holds it.
    #[test]
    fn a_line_during_a_switch_to_steer_is_decided_after_it() {
        for read_inside_lock in [true, false] {
            let s = setup("switch-first");
            busy(&s, "dev");
            let mode = Arc::new(Mutex::new("queue"));
            let (pressed_tx, pressed) = std::sync::mpsc::channel();
            let switch = {
                let (s, mode) = (s.clone(), mode.clone());
                std::thread::spawn(move || {
                    let flip = slow_pane(&mode, 150);
                    let press = move || { pressed_tx.send(()).unwrap(); flip() };
                    switch_with(&s, "dev", "t-switch-first", "steer", || Some(*mode.lock().unwrap()), press, std::time::Duration::from_secs(2))
                })
            };
            pressed.recv().unwrap();
            let line = "[tmm chat 2026-09-29 05:00] lead: @dev during the switch";
            if read_inside_lock {
                assert!(deliver_with(&s, "dev", "t", line, 0, "", || Some(*mode.lock().unwrap())));
            } else {
                let stale = *mode.lock().unwrap() == "queue";
                assert!(deliver_as(&s, "dev", "t", line, "", stale));
            }
            assert_eq!(switch.join().unwrap(), Ok(true));
            if read_inside_lock {
                assert_eq!((typed().len(), held(&s, "dev")), (1, 0), "decided against steer: typed now");
            } else {
                assert_eq!((typed().len(), held(&s, "dev")), (0, 1), "control: a read outside the lock holds it as queue");
            }
        }
    }

    /// The other direction: a switch asked for while a delivery is between
    /// its mode read and its hold waits for the hold. The line was decided
    /// against queue and is held under it; the key goes in only after —
    /// never a queue decision with a steer pane. The control is the pre-fix
    /// switch (the pane send lock only), which presses during the pause.
    #[test]
    fn a_switch_during_a_delivery_waits_for_its_hold() {
        for switch_takes_window_lock in [true, false] {
            let s = setup("deliver-first");
            busy(&s, "dev");
            let mode = Arc::new(Mutex::new("queue"));
            let held_at_press = Arc::new(Mutex::new(None));
            let (read_tx, read) = std::sync::mpsc::channel::<()>();
            let switch = {
                let (s, mode, held_at_press) = (s.clone(), mode.clone(), held_at_press.clone());
                std::thread::spawn(move || {
                    read.recv().unwrap();
                    let flip = slow_pane(&mode, 50);
                    let press = {
                        let (s, held_at_press) = (s.clone(), held_at_press.clone());
                        move || { *held_at_press.lock().unwrap() = Some(held(&s, "dev")); flip() }
                    };
                    let current = || Some(*mode.lock().unwrap());
                    let verify = std::time::Duration::from_secs(2);
                    if switch_takes_window_lock {
                        switch_with(&s, "dev", "t-deliver-first", "steer", current, press, verify)
                    } else {
                        crate::tmux::with_pane_send_lock("t-deliver-first", || {
                            press().unwrap();
                            while current() != Some("steer") { std::thread::sleep(std::time::Duration::from_millis(20)); }
                            Ok(true)
                        })
                    }
                })
            };
            let line = "[tmm chat 2026-09-29 05:01] lead: @dev before the switch";
            assert!(deliver_with(&s, "dev", "t", line, 0, "", || {
                let now = *mode.lock().unwrap();
                read_tx.send(()).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(200));
                Some(now)
            }));
            assert_eq!(switch.join().unwrap(), Ok(true));
            assert_eq!(held(&s, "dev"), 1, "decided against queue: held");
            let at_press = held_at_press.lock().unwrap().unwrap();
            if switch_takes_window_lock {
                assert_eq!(at_press, 1, "the key went in only after the hold");
            } else {
                assert_eq!(at_press, 0, "control: without the window lock the key lands between read and hold");
            }
        }
    }

    /// Board #271: the running mode is the SCREEN's, then what the screen
    /// said last in the same pane, then the recipe's start mode — and #257
    /// holds lines only for a session that runs queue.
    #[test]
    fn the_running_input_mode_follows_the_pane_not_the_recipe() {
        let mut scratch = crate::tmux::Scratch::new("inputmode");
        let s = scratch.session("s");
        agent_with_recipe(&scratch, &s, "dev", "kiro", "queue");
        let idle = "kiro · Claude Opus 5.5 · high · ◔ 1%\n›  ask a question or describe a task ↵\n";
        let steer = "kiro · Claude Opus 5.5\n›  Kiro is working · Type to steer · Ctrl+S to queue\n";
        assert_eq!(input_mode_seen(&s, "dev", "%1", idle), Some("queue"), "nothing on screen: the start mode");
        assert_eq!(input_mode_seen(&s, "dev", "%1", steer), Some("steer"), "the screen outranks the recipe");
        assert_eq!(input_mode_seen(&s, "dev", "%1", idle), Some("steer"), "idle kiro paints nothing: the pane's last reading stands");
        assert_eq!(input_mode_seen(&s, "dev", "%2", idle), Some("queue"), "a new pane (restart) starts from the recipe again");
        assert_eq!(input_mode_seen(&s, "dev", "%2", "● Switched to Steer mode\n"), Some("steer"), "a Ctrl+S confirmation");
        // codex switches only at launch: its screen is never read for a mode.
        agent_with_recipe(&scratch, &s, "cx", "codex", "steer");
        assert_eq!(input_mode_seen(&s, "cx", "%3", "›  Kiro is working · Type to queue · Ctrl+S to steer\n"), Some("steer"));
        // A backend with no choice has no mode.
        agent_with_recipe(&scratch, &s, "cl", "claude", "queue");
        assert_eq!(input_mode_seen(&s, "cl", "%4", steer), None);
        assert_eq!(input_mode_seen(&s, "nobody", "%5", steer), None, "not an agent this app started");
    }

    /// Board #276: the three outcomes for an open turn, by the mode the
    /// session runs. Busy+steer: typed, NO pending row, one `steered` event
    /// naming the message, and the sweep reports nothing after the turn.
    /// Busy+queue: held as before. Idle+steer: an ordinary row, settled by
    /// the hook (the line starts a turn).
    #[test]
    fn a_line_steered_into_a_busy_turn_owes_no_echo() {
        let s = setup("steer");
        busy(&s, "dev");
        let steer = || Some("steer");
        for (i, msg) in ["m1", "m2", "m3"].iter().enumerate() {
            assert!(deliver_with(&s, "dev", "t", &format!("[tmm chat 03:0{i}] lead: @dev steer {i}"), 0, msg, steer));
        }
        assert_eq!(typed().len(), 3, "typed into the running turn at once");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 0), "no row: nothing can settle it");
        let steered: Vec<Vec<String>> = telemetry::recent_events(&s, 0)
            .into_iter()
            .filter(|e| e.kind == "steered")
            .map(|e| e.deliveries.into_iter().map(|d| d.msg).collect())
            .collect();
        assert_eq!(steered, vec![vec!["m1".to_string()], vec!["m2".to_string()], vec!["m3".to_string()]]);
        // The sweep reports only pending rows, so no row = no `unconfirmed`,
        // ever (the live check waits out the 45 s ack window for real).
        end(&s, "dev");
        telemetry::sweep_deliveries(&s);
        assert!(warns(&s).is_empty(), "{:?}", warns(&s));
        assert!(!telemetry::turn_busy(&s, "dev"), "a steered event is not a turn fact");

        // Busy + queue: held, exactly as #257.
        let q = setup("steer-queue");
        busy(&q, "dev");
        assert!(deliver_with(&q, "dev", "t", "[tmm chat 03:10] lead: @dev later", 0, "", || Some("queue")));
        assert_eq!((typed().len(), held(&q, "dev")), (0, 1));

        // Idle + steer: the line starts a turn, the hook fires: owed and settled.
        let i = setup("steer-idle");
        let line = "[tmm chat 03:20] lead: @dev start";
        assert!(deliver_with(&i, "dev", "t", line, 0, "m9", || Some("steer")));
        assert_eq!(pending(&i, "dev"), 1, "an idle window still owes the echo");
        assert!(record_prompt(&i, "dev", line));
        assert_eq!(pending(&i, "dev"), 0);
    }

    /// Mixed: one message to two agents, one busy in steer and one idle. The
    /// steered one owes nothing; the other still owes its echo.
    #[test]
    fn one_message_steered_into_one_agent_and_owed_by_another() {
        let s = setup("steer-mixed");
        busy(&s, "a");
        let line = "[tmm chat 03:30] lead: @a @b both";
        assert!(deliver_with(&s, "a", "ta", line, 0, "mx", || Some("steer")));
        assert!(deliver_with(&s, "b", "tb", line, 0, "mx", || Some("steer")));
        assert_eq!((pending(&s, "a"), pending(&s, "b")), (0, 1), "a owes nothing; b's echo is still owed (and swept if it never comes)");
        assert!(record_prompt(&s, "b", line), "b's hook settles its row");
        assert_eq!(pending(&s, "b"), 0);
    }

    /// Board #281 (live, lingting 10:14–11:00: five leaks): two lines reach
    /// one IDLE steer window inside the hook latency. The first starts the
    /// turn and owes its echo; the second lands in that turn before the
    /// prompt edge reaches us, so it is steered — no row. One echo settles
    /// the first; no warn after the turn. Queue is unchanged: its second
    /// line still owes (it gets its own turn). A row that never echoes stops
    /// counting as in flight after the ack window.
    #[test]
    fn a_second_line_before_the_first_echo_is_steered_in_steer_mode() {
        let s = setup("inflight");
        let first = "[tmm chat 10:14] data: [board #13 reply] first";
        let second = "[tmm chat 10:14] data: [board #12 reply] second";
        assert!(deliver_with(&s, "dev", "t", first, 0, "m1", || Some("steer")));
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(deliver_with(&s, "dev", "t", second, 0, "m2", || Some("steer")));
        assert_eq!(typed().len(), 2, "both typed at once");
        assert_eq!(pending(&s, "dev"), 1, "only the first owes an echo");
        let steered: Vec<String> = telemetry::recent_events(&s, 0).into_iter().filter(|e| e.kind == "steered").flat_map(|e| e.deliveries).map(|d| d.msg).collect();
        assert_eq!(steered, vec!["m2".to_string()], "the second is named steered");
        assert!(record_prompt(&s, "dev", first), "the one echo settles the first");
        assert_eq!(pending(&s, "dev"), 0);
        end(&s, "dev");
        telemetry::sweep_deliveries(&s);
        assert!(warns(&s).is_empty(), "{:?}", warns(&s));

        // Queue control: the second line owes too (it will be its own turn).
        let q = setup("inflight-queue");
        assert!(deliver_with(&q, "dev", "t", first, 0, "q1", || Some("queue")));
        assert!(deliver_with(&q, "dev", "t", second, 0, "q2", || Some("queue")));
        assert_eq!(pending(&q, "dev"), 2, "queue mode is unchanged");

        // A first line that never echoes (the CLI did not take it) stops
        // steering later lines once the sweep's clock would report it.
        let a = setup("inflight-aged");
        assert!(deliver_with(&a, "dev", "t", first, 0, "a1", || Some("steer")));
        crate::projects::with_store(|st| st.backdate_deliveries(&a, crate::projects::now() - 46)).unwrap();
        assert!(!telemetry::line_in_flight(&a, "dev"));
        assert!(deliver_with(&a, "dev", "t", second, 0, "a2", || Some("steer")));
        assert_eq!(pending(&a, "dev"), 2, "past the ack window the window reads idle again: the line owes");
    }

    /// Board #281 (validator 11:50): the gap INSIDE the prompt edge. The
    /// first line's echo is paused after its row is deleted and before its
    /// prompt fact is written; a second line arriving then must WAIT for the
    /// edge (the decision takes the same lock), and then find the turn open
    /// and steer. Negative control: a decision outside that lock reads idle
    /// with no row in flight and owes the second line an echo.
    #[test]
    fn a_line_during_the_prompt_edge_waits_for_it_and_steers() {
        let s = setup("edge-gap");
        let first = "[tmm chat 10:14] data: [board #13 reply] first";
        assert!(deliver_with(&s, "dev", "t", first, 0, "m1", || Some("steer")));
        assert_eq!(pending(&s, "dev"), 1);
        let (deleted_tx, deleted) = std::sync::mpsc::channel();
        *telemetry::IN_PROMPT_SETTLED_HOOK.lock().unwrap() = Some(Box::new(move || {
            deleted_tx.send(()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
        }));
        let echo = {
            let s = s.clone();
            std::thread::spawn(move || record_prompt(&s, "dev", first))
        };
        deleted.recv().unwrap();
        assert_eq!(pending(&s, "dev"), 0, "the first row is gone, the prompt fact not yet written");
        let second = {
            let s = s.clone();
            std::thread::spawn(move || {
                fake();
                let ok = deliver_with(&s, "dev", "t", "[tmm chat 10:14] data: [board #12 reply] second", 0, "m2", || Some("steer"));
                (ok, typed())
            })
        };
        assert!(echo.join().unwrap(), "the echo settled the first line");
        let (ok, typed_second) = second.join().unwrap();
        assert!(ok);
        assert_eq!(typed_second.len(), 1, "typed");
        assert_eq!(pending(&s, "dev"), 0, "waited for the edge, then steered: no row");
        assert!(telemetry::recent_events(&s, 0).iter().any(|e| e.kind == "steered" && e.deliveries.iter().any(|d| d.msg == "m2")));
        end(&s, "dev");
        telemetry::sweep_deliveries(&s);
        assert!(warns(&s).is_empty(), "{:?}", warns(&s));
    }

    /// Board #279 × #257 (orchestrator 13:24): a Team line typed alone, and
    /// three held and typed as one prompt. Typed, each context sits right
    /// BEFORE its own line; the one echo settles every row (one receipt each)
    /// and names the senders; stored, each line comes before its context, in
    /// typed order — from the offsets the producer recorded on the rows.
    #[test]
    fn team_lines_are_typed_context_first_and_stored_ask_first_alone_or_held() {
        let ctx = |n: u8| format!("[tmm team context — x]\n[09-29 10:4{n}] a -> b: row {n}\n[/tmm team context]");
        let line = |n: u8, who: &str| format!("[tmm chat 10:4{n}] {who}: @dev ask {n}");
        let stored = |s: &str| {
            let e = telemetry::recent_events(s, 0).into_iter().rfind(|e| e.kind == "prompt").unwrap();
            (e.text, e.requesters.map(|r| serde_json::to_string(&r).unwrap()))
        };
        // Alone: typed at once.
        let s = setup("team-one");
        let one = crate::address::context_first(&line(1, "lead"), Some(&ctx(1)));
        assert!(deliver_with(&s, "dev", "t", &one.text, one.ask_at, "m1", || Some("queue")));
        assert_eq!(typed(), vec![one.text.clone()]);
        assert!(record_prompt(&s, "dev", &one.text), "one echo, one receipt");
        assert_eq!(pending(&s, "dev"), 0);
        assert_eq!(stored(&s), (format!("{}\n\n{}", line(1, "lead"), ctx(1)), Some(r#"["lead"]"#.to_string())));
        // Held ×3: one combined prompt at the turn's end.
        let s = setup("team-held");
        busy(&s, "dev");
        let who = ["lead", "validator", "lead"];
        let parts: Vec<_> = (1..=3).map(|n| crate::address::context_first(&line(n, who[n as usize - 1]), Some(&ctx(n)))).collect();
        for (i, t) in parts.iter().enumerate() {
            assert!(deliver_with(&s, "dev", "t", &t.text, t.ask_at, &format!("m{i}"), || Some("queue")));
        }
        assert!(typed().is_empty(), "held while busy");
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        let prompts = typed();
        let want = [ctx(1), line(1, "lead"), ctx(2), line(2, "validator"), ctx(3), line(3, "lead")].join("\n\n");
        assert_eq!(prompts, vec![want.clone()], "each context right before its own line");
        assert!(record_prompt(&s, "dev", &want));
        assert_eq!(pending(&s, "dev"), 0, "one echo settles all three");
        let shown = [line(1, "lead"), ctx(1), line(2, "validator"), ctx(2), line(3, "lead"), ctx(3)].join("\n\n");
        assert_eq!(stored(&s), (shown, Some(r#"["lead","validator"]"#.to_string())), "ask first per row, typed order; each requester once");
        let receipt = telemetry::recent_events(&s, 0).into_iter().rfind(|e| e.kind == "prompt").unwrap();
        assert_eq!(receipt.deliveries.len(), 3, "the receipt names every row");
    }

    /// The owner's case: a burst of 10 to a busy queue-mode agent is ONE
    /// prompt at the turn's end, all 10 rows settled by its one echo.
    #[test]
    fn a_burst_to_a_busy_queue_agent_is_one_prompt_at_turn_end() {
        let s = setup("burst");
        busy(&s, "dev");
        let lines: Vec<String> = (0..10)
            .map(|i| format!("[tmm chat 2026-09-28 03:0{i}] {}: @dev item {i}\nsecond line {i}", if i % 2 == 0 { "lead" } else { "validator" }))
            .collect();
        for (i, line) in lines.iter().enumerate() {
            assert!(deliver_as(&s, "dev", "t", line, &format!("m{i}"), true));
        }
        assert!(typed().is_empty(), "nothing is typed while the turn is open");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (10, 0));
        assert!(warns(&s).is_empty());

        end(&s, "dev");
        flush_at(&s, "dev", "t");
        let prompts = typed();
        assert_eq!(prompts.len(), 1, "one prompt");
        assert_eq!(prompts[0], lines.join("\n\n"), "every line intact, in order");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 10));

        // The agent submits it (newlines glued, the tmux extended-keys shape):
        // the #249 matcher settles all ten from the one echo.
        assert!(record_prompt(&s, "dev", &prompts[0].replace('\n', "")));
        assert_eq!(pending(&s, "dev"), 0);
        let prompt = telemetry::recent_events(&s, 0).into_iter().rfind(|e| e.kind == "prompt").unwrap();
        assert_eq!(prompt.deliveries.len(), 10, "the echo names every row it settled");
        assert_eq!(prompt.deliveries.iter().map(|d| d.msg.clone()).collect::<Vec<_>>(), (0..10).map(|i| format!("m{i}")).collect::<Vec<_>>());
    }

    #[test]
    fn an_idle_target_a_steer_agent_and_a_non_switching_backend_are_typed_at_once() {
        let s = setup("direct");
        assert!(deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev idle", "", true));
        assert_eq!(typed().len(), 1, "idle: typed now");
        busy(&s, "dev");
        assert!(deliver_as(&s, "dev", "t", "[tmm chat 03:01] lead: @dev steer", "", false));
        assert_eq!(typed().len(), 2, "not coalescing (steer / claude): typed now, busy or not");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 2));
        // A stop with nothing held types nothing.
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 2);
    }

    /// A line for an idle agent that still has held lines goes behind them.
    #[test]
    fn a_new_line_joins_lines_still_held_in_order() {
        let s = setup("join");
        busy(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev one", "", true);
        end(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:01] lead: @dev two", "", true);
        assert_eq!(typed(), vec!["[tmm chat 03:00] lead: @dev one\n\n[tmm chat 03:01] lead: @dev two".to_string()]);
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 2));
    }

    /// Decision 1: an interrupt drops the held lines, one warn each, no retry.
    #[test]
    fn an_interrupt_drops_held_lines_with_one_warn_each() {
        let s = setup("intr");
        busy(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev a", "m1", true);
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev b", "m2", true);
        interrupt(&s, "dev", || telemetry::record_interrupt(&s, "dev"));
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 0));
        let w = warns(&s);
        assert_eq!(w.len(), 2, "{w:?}");
        assert!(w.iter().all(|t| t.starts_with("undelivered (interrupted): ")), "{w:?}");
        let rows = telemetry::recent_events(&s, 0);
        assert!(rows.iter().filter(|e| e.kind == "warn").all(|e| e.deliveries.is_empty()), "no row id: nothing to retract");
        flush_at(&s, "dev", "t");
        assert!(typed().is_empty(), "nothing retried");
    }

    /// Decision 2: copy mode at the flush keeps the lines held, says so ONCE,
    /// and the next trigger types them.
    #[test]
    fn copy_mode_at_flush_keeps_lines_held_warns_once_and_retries() {
        let s = setup("copy");
        busy(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev a", "", true);
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev b", "", true);
        end(&s, "dev");
        refuse(Some(crate::tmux::PANE_IN_MODE));
        flush_at(&s, "dev", "t");
        flush_at(&s, "dev", "t");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (2, 0), "still owed, not typed");
        assert_eq!(warns(&s), vec!["held (pane in copy mode): 2 lines will be typed when it clears".to_string()]);
        // A line arriving meanwhile queues behind them, still one warn.
        deliver_as(&s, "dev", "t", "[tmm chat 03:01] lead: @dev c", "", true);
        assert_eq!(held(&s, "dev"), 3);
        assert_eq!(warns(&s).len(), 2, "the new row gets its own single report");
        refuse(None);
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 1);
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 3));
        // Released rows start fresh: their ack clock and report are the
        // ordinary delivery's (the held-time report does not suppress it).
        assert!(crate::projects::with_store(|st| st.pending_deliveries(&s, Some("dev"))).unwrap().iter().all(|r| !r.warned));
    }

    /// A restart keeps held lines (they are rows): an idle agent gets them
    /// at the next trigger, a running one at its turn's end.
    #[test]
    fn held_lines_survive_a_restart() {
        let s = setup("restart");
        busy(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev a", "", true);
        telemetry::forget_process_state(&s);
        // The prompt row is not persisted in unit tests: after the "restart"
        // the window has no facts, so it reads idle and the next trigger types.
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 1);

        let s = setup("restart-busy");
        crate::projects::with_store(|st| st.insert_activity(&s, "dev", crate::projects::now() * 1000, "prompt", "long turn", "", "app", "", "")).unwrap();
        crate::projects::with_store(|st| st.insert_held_delivery(&s, "dev", "[tmm chat 03:00] lead: @dev a", 0, crate::projects::now(), "")).unwrap();
        telemetry::forget_process_state(&s);
        flush_at(&s, "dev", "t");
        assert!(typed().is_empty(), "the replayed turn is open: still held");
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 1);
    }

    /// Decision 3: the server-start trigger flushes every idle window with
    /// held lines after its turn is recovered, across sessions, and leaves a
    /// recovered running turn alone.
    #[test]
    fn the_server_start_flushes_recovered_idle_windows_only() {
        let s = setup("start-idle");
        let r = setup("start-running");
        crate::projects::with_store(|st| {
            st.insert_held_delivery(&s, "dev", "[tmm chat 03:00] lead: @dev idle one", 0, crate::projects::now(), "")?;
            st.insert_activity(&r, "dev", crate::projects::now() * 1000, "prompt", "long turn", "", "app", "", "")?;
            st.insert_held_delivery(&r, "dev", "[tmm chat 03:00] lead: @dev running one", 0, crate::projects::now(), "")
        })
        .unwrap();
        telemetry::forget_process_state(&s);
        telemetry::forget_process_state(&r);
        assert!(telemetry::held_sessions().contains(&s) && telemetry::held_sessions().contains(&r));
        // flush_on_start's per-window step, with the test's fake pane.
        for session in [&s, &r] {
            for w in telemetry::held_windows(session) {
                flush_at(session, &w, "t");
            }
        }
        assert_eq!(typed(), vec!["[tmm chat 03:00] lead: @dev idle one".to_string()]);
        assert_eq!((held(&s, "dev"), held(&r, "dev")), (0, 1), "the recovered running turn keeps its line");
    }

    /// kiro-cli 2.22.1 measured: an Escape typed IN the pane cancels the turn
    /// and fires no hook, so the window reads busy until its next turn. A
    /// line held past HOLD_MAX_SECS is typed at the next trigger anyway — the
    /// agent is never left deaf.
    #[test]
    fn a_line_held_too_long_is_typed_although_the_window_reads_busy() {
        let s = setup("overdue");
        busy(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev a", "", true);
        flush_at(&s, "dev", "t");
        assert!(typed().is_empty(), "fresh: held");
        crate::projects::with_store(|st| st.exec_test_sql(&format!(
            "UPDATE deliveries SET ts = ts - {} WHERE session = '{s}'", HOLD_MAX_SECS
        ))).unwrap();
        // The feed-read trigger types it, busy or not.
        flush_at(&s, "dev", "t");
        assert_eq!(typed(), vec!["[tmm chat 03:00] lead: @dev a".to_string()]);
        // So does the next delivery, which joins the overdue line.
        deliver_as(&s, "dev", "t", "[tmm chat 03:10] lead: @dev b", "", true);
        crate::projects::with_store(|st| st.exec_test_sql(&format!(
            "UPDATE deliveries SET ts = ts - {} WHERE session = '{s}' AND held = 1", HOLD_MAX_SECS
        ))).unwrap();
        deliver_as(&s, "dev", "t", "[tmm chat 03:11] lead: @dev c", "", true);
        assert_eq!(typed().len(), 2);
        assert_eq!(typed()[1], "[tmm chat 03:10] lead: @dev b\n\n[tmm chat 03:11] lead: @dev c");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 3));
    }

    fn sql(stmt: &str) {
        crate::projects::with_store(|st| st.exec_test_sql(stmt)).unwrap();
    }

    /// Review blocker 1 (real SQLite fault, a TEMP trigger as in #249): a
    /// hold that cannot be written is typed NOW as an ordinary delivery —
    /// never reported queued while stored nowhere; if typing fails too, the
    /// existing `undelivered` warn says so.
    #[test]
    fn a_hold_that_cannot_be_written_is_typed_now() {
        let s = setup("hold-fault");
        busy(&s, "dev");
        sql("CREATE TEMP TRIGGER hold_fault BEFORE INSERT ON deliveries
             WHEN NEW.held = 1 AND NEW.line LIKE '%hold-fault%'
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
        let line = "[tmm chat 03:00] lead: @dev hold-fault one";
        assert!(deliver_as(&s, "dev", "t", line, "m1", true));
        assert_eq!(typed(), vec![line.to_string()], "typed at once, today's behaviour");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 1), "an ordinary pending delivery its echo settles");

        refuse(Some(crate::tmux::PANE_IN_MODE));
        assert!(!deliver_as(&s, "dev", "t", "[tmm chat 03:01] lead: @dev hold-fault two", "", true));
        assert!(warns(&s).iter().any(|w| w.starts_with("undelivered (pane is in copy mode): ") && w.contains("hold-fault two")),
            "neither stored nor typed is SAID: {:?}", warns(&s));
        sql("DROP TRIGGER hold_fault;");
    }

    /// Review blocker 2: the release is ONE transaction. A failure on the
    /// second row's UPDATE leaves the WHOLE batch held and types nothing;
    /// after recovery the batch is typed exactly once.
    #[test]
    fn a_release_that_fails_mid_batch_types_nothing_and_keeps_all_held() {
        let s = setup("release-fault");
        busy(&s, "dev");
        for tag in ["a", "release-fault-b", "c"] {
            deliver_as(&s, "dev", "t", &format!("[tmm chat 03:00] lead: @dev {tag}"), "", true);
        }
        end(&s, "dev");
        sql("CREATE TEMP TRIGGER release_fault BEFORE UPDATE ON deliveries
             WHEN OLD.line LIKE '%release-fault-b%' AND NEW.held = 0
             BEGIN SELECT RAISE(ABORT, 'locked'); END;");
        flush_at(&s, "dev", "t");
        assert!(typed().is_empty(), "nothing is typed when the release fails");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (3, 0), "the first row's UPDATE was rolled back too");
        flush_at(&s, "dev", "t");
        assert!(typed().is_empty(), "still failing: still nothing");
        sql("DROP TRIGGER release_fault;");
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 1, "recovered: one prompt");
        assert!(typed()[0].contains("@dev a") && typed()[0].contains("release-fault-b") && typed()[0].contains("@dev c"));
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 3));
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 1, "exactly once");
    }

    /// Board #276 (validator 09:26, orchestrator 09:28): held lines flushed
    /// into a turn that now runs steer are RETIRED before typing. A retire
    /// that fails types nothing and keeps every row held (the queue path,
    /// typed at the turn's end); a retire that succeeded leaves no pending
    /// row even if the process dies before the keys — nothing to sweep.
    #[test]
    fn held_lines_steered_in_are_retired_before_typing_or_not_typed() {
        let s = setup("steer-retire");
        busy(&s, "dev");
        for tag in ["a", "retire-fault-b"] {
            deliver_as(&s, "dev", "t", &format!("[tmm chat 03:00] lead: @dev {tag}"), &format!("m-{tag}"), true);
        }
        assert_eq!(held(&s, "dev"), 2);
        // The session switched to steer mid-turn; the rows are overdue.
        crate::projects::with_store(|st| st.backdate_deliveries(&s, crate::projects::now() - HOLD_MAX_SECS - 1)).unwrap();
        sql("CREATE TEMP TRIGGER retire_fault BEFORE DELETE ON deliveries
             WHEN OLD.line LIKE '%retire-fault-b%'
             BEGIN SELECT RAISE(ABORT, 'locked'); END;");
        flush_locked(&s, "dev", "t", true);
        assert!(typed().is_empty(), "the retire failed: nothing typed");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (2, 0), "both rows still held (the first DELETE rolled back)");
        sql("DROP TRIGGER retire_fault;");

        // The retire succeeds, the "process dies" before typing: refuse the
        // keys to stand in for the lost moment. No row is left to sweep.
        refuse(Some("server gone"));
        flush_locked(&s, "dev", "t", true);
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 0), "retired before the keys: nothing pending, ever");
        let w = warns(&s);
        assert_eq!(w.len(), 1, "a line that did not land is SAID once (#250): {w:?}");
        assert!(w[0].starts_with("undelivered (server gone): "), "{w:?}");
        end(&s, "dev");
        telemetry::sweep_deliveries(&s);
        assert_eq!(warns(&s).len(), 1, "and never an `unconfirmed` on top");

        // Typed: one steered event names both messages.
        let t = setup("steer-retire-ok");
        busy(&t, "dev");
        for tag in ["x", "y"] {
            deliver_as(&t, "dev", "t", &format!("[tmm chat 03:05] lead: @dev {tag}"), &format!("m-{tag}"), true);
        }
        flush_locked(&t, "dev", "t", true);
        assert_eq!(typed().len(), 1);
        assert_eq!((held(&t, "dev"), pending(&t, "dev")), (0, 0));
        let named: Vec<String> = telemetry::recent_events(&t, 0).into_iter().filter(|e| e.kind == "steered").flat_map(|e| e.deliveries).map(|d| d.msg).collect();
        assert_eq!(named, vec!["m-x".to_string(), "m-y".to_string()]);
    }

    /// Board #276 (validator 09:26 finding 2): in a busy steer turn with
    /// lines already held, a hold that cannot be written falls back to the
    /// STEERED path — typed, owing no echo — not to an ordinary pending row.
    #[test]
    fn a_hold_that_fails_in_a_steer_turn_is_steered() {
        let s = setup("steer-hold-fault");
        busy(&s, "dev");
        deliver_as(&s, "dev", "t", "[tmm chat 03:00] lead: @dev earlier", "m0", true);
        assert_eq!(held(&s, "dev"), 1, "held while the session ran queue");
        sql("CREATE TEMP TRIGGER steer_hold_fault BEFORE INSERT ON deliveries
             WHEN NEW.held = 1 AND NEW.line LIKE '%steer-hold-fault%'
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
        let line = "[tmm chat 03:01] lead: @dev steer-hold-fault now";
        assert!(deliver_with(&s, "dev", "t", line, 0, "m1", || Some("steer")));
        sql("DROP TRIGGER steer_hold_fault;");
        assert_eq!(typed(), vec![line.to_string()], "typed at once");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (1, 0), "no pending row for a steered line; the earlier one stays held");
        assert!(telemetry::recent_events(&s, 0).iter().any(|e| e.kind == "steered" && e.deliveries.iter().any(|d| d.msg == "m1")));
    }

    /// Board #355 review P1-B(2). A delivery that is only worth making while
    /// something is still true asks it INSIDE the step that decides and types:
    /// a closed gate types, holds and records nothing; an open one types — and a
    /// prompt that arrives while the gate is being asked waits for the whole
    /// step (the turn-fact lock), so it cannot land between the check and the
    /// line. The check-then-deliver it replaces let it.
    #[test]
    fn a_gated_delivery_is_checked_and_typed_in_one_step_against_the_prompt_edge() {
        let s = setup("gate");
        crate::projects::telemetry::record_notification_with(&s, "dev", "completed", crate::projects::now(), crate::backends::EndQuality::Empty);
        let end_seq = telemetry::turn_epoch(&s, "dev");
        let nudge = "[tmm chat 10:00] tmm: [reply] your previous turn ended without a response";

        assert!(!deliver_if(&s, "dev", "t", nudge, &|| false), "a closed gate delivers nothing");
        assert!(typed().is_empty());
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (0, 0), "and records nothing");

        let racer = Mutex::new(None);
        let gate = || {
            *racer.lock().unwrap() = Some(std::thread::spawn({
                let s = s.clone();
                move || {
                    record_prompt(&s, "dev", "[tmm chat 10:01] human: continue");
                }
            }));
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert!(!telemetry::turn_busy(&s, "dev"), "the prompt edge waits while the gate is asked");
            telemetry::nudge_still_due(&s, "dev", end_seq)
        };
        assert!(deliver_if(&s, "dev", "t", nudge, &gate), "still due when asked, so typed in the same step");
        racer.lock().unwrap().take().unwrap().join().unwrap();
        assert_eq!(typed(), vec![nudge.to_string()]);
        assert!(telemetry::turn_busy(&s, "dev"), "the prompt landed after the line, as its own turn");
    }

    /// The gate does not change an ordinary delivery: the always-open one is what
    /// `deliver_with` passes.
    #[test]
    fn an_ordinary_delivery_passes_the_open_gate() {
        let s = setup("open-gate");
        assert!(deliver_with(&s, "dev", "t", "[tmm chat 10:00] lead: @dev hi", 0, "m1", || None));
        assert_eq!(typed().len(), 1);
    }

    /// The bound: whole lines, oldest first, the rest wait for the next end;
    /// an oversized line goes alone and is never cut.
    #[test]
    fn a_flush_packs_whole_lines_up_to_the_cap() {
        assert_eq!(first_prompt(&[], 10), 0);
        assert_eq!(first_prompt(&["aaaa", "bbbb", "cccc"], 10), 2, "4 + 2 + 4 = 10 fits, the third would not");
        assert_eq!(first_prompt(&["aaaa", "bbbb", "cccc"], 9), 1);
        assert_eq!(first_prompt(&["a".repeat(50).as_str(), "b"], 10), 1, "an oversized line alone");

        let s = setup("cap");
        busy(&s, "dev");
        let big = "x".repeat(FLUSH_MAX_CHARS / 2);
        for i in 0..3 {
            deliver_as(&s, "dev", "t", &format!("[tmm chat 03:0{i}] lead: @dev {big}"), "", true);
        }
        end(&s, "dev");
        flush_at(&s, "dev", "t");
        assert_eq!(typed().len(), 1, "one prompt per turn end");
        assert_eq!((held(&s, "dev"), pending(&s, "dev")), (2, 1), "the overflow waits for the next end");
        assert!(typed()[0].chars().count() <= FLUSH_MAX_CHARS + 64);
    }
}
