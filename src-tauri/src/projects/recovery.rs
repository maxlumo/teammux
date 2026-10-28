//! Auto-recovery from TRANSIENT model errors (owner, 2026-08-22: "自动帮我处理
//! 异常。如果检查到类似的错误，自动帮我发送 continue 指令").
//!
//! A backend occasionally aborts a turn with a load-shedding error — kiro
//! paints `An unexpected error occurred during the response stream …
//! ModelTemporarilyUnavailable … please try again` (or, on kiro v3, `● <model>
//! is experiencing high traffic …`), Claude Code on Bedrock paints `● API
//! Error: 503 Bedrock is unable to process your request …` (#280), and then
//! it sits at its prompt.
//! The agent is fine, the turn is lost, and until a human types something the
//! window is dead weight. This module watches managed agent panes from the
//! capture tick and types `continue` at one that shows such an error.
//!
//! The owner's rules ARE the design, in code not prose (2026-08-22 original,
//! tightened 2026-08-26: "针对同一个 error，只发送一次 … 发送后等一会儿，通过
//! hooks 查看之前发送的指令是否正确生效"):
//! 1. An INCIDENT is one error INSTANCE, continuously visible. Within it, ONE
//!    `continue` is the intent; retries exist only for a send the hooks never
//!    saw land. The record lives exactly as long as ITS error stays on the
//!    screen — the tick that no longer sees any error drops the record, and a
//!    DIFFERENT error appearing (a new `request_id` — the resumed turn died
//!    again, owner 2026-08-26: "有可能还会出现二次报错并停止…就需要再次发送
//!    指令") replaces the record with a fresh incident and a full budget,
//!    because "an error is visible" cannot distinguish the second failure
//!    from the first one's still-painted text. The signature is the set of
//!    request_ids read off the visible error lines (hit count as fallback
//!    when an id is not on screen).
//! 2. A send is VERIFIED through the hooks, not the screen: the error text
//!    stays painted long after the agent moved on, so "error still visible"
//!    means nothing. Before any retry the tracker asks whether the agent
//!    PROGRESSED (a tool call or a CLI-sent turn end, never the continue's
//!    own prompt — `telemetry::progress_since`, board #473) after the send;
//!    if it did the incident is CONFIRMED and goes
//!    silent. A tool call observed by telemetry confirms it directly too —
//!    and must never erase the record, because an erased record plus the
//!    still-painted error re-opened the incident every tick and typed
//!    `continue` into a working agent (the owner's repeat-send report).
//! 3. Unverified retries back off EXPONENTIALLY (`BASE_BACKOFF_SECS * 2^(n-1)`)
//!    and run out after `MAX_ATTEMPTS`, with one `warn` event — an error that
//!    survives four spaced, never-landing sends is not transient, and an
//!    unattended loop typing into a broken pane is worse than silence.
//!
//! Detection is deliberately narrow. A pane is full of text ABOUT errors —
//! the owner pasted this very error into the chat, which typed it into an
//! agent's pane — so detection reads kiro's PAINT BLOCKS (a column-zero head
//! line plus the indented continuation lines under it; kiro paints its own
//! errors flush-left and hard-wraps the rest, board #24 2026-08-31, while
//! everything QUOTED — chat deliveries, tool output, the agent's own prose —
//! paints indented under a stamp or a `●` bullet head): a hit is a block that
//! OPENS with the error's own header and carries a transient marker, a block
//! containing the `[tmm chat …]` stamp is never a hit (that is somebody
//! QUOTING an error, not having one), and an indented tail whose head sits
//! above the capture is never guessed at — when that tail carries a transient
//! marker it earns ONE deeper capture (`DEEP_CAPTURE_LINES` of scrollback) so
//! the head is READ: a tall error paint plus the prompt redraw pushes the
//! header off a short pane's fold with the agent stalled right under it
//! (2026-09-05, the kirocrew miss), while a quote's or tool dump's recovered
//! head still disqualifies its block. A missed real error
//! costs one manual `continue`; a false positive types into a working agent's
//! conversation.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Retry budget per incident (rule 2).
pub const MAX_ATTEMPTS: u32 = 4;
/// First retry is immediate on detection; attempt n+1 waits
/// `BASE_BACKOFF_SECS * 2^(n-1)` after attempt n (rule 1): 30s, 60s, 120s.
pub const BASE_BACKOFF_SECS: u64 = 30;

/// At most this many NEW incidents START a ladder per agent in any rolling
/// `INCIDENT_WINDOW_SECS` (board #362 e, orchestrator's ruling). The ladder
/// bounds ONE error (`MAX_ATTEMPTS` sends); what was unbounded live (#361
/// deploy, 10-14 02:3x) was a fresh error every ~20 s, a new Request ID
/// each, every one a new incident with a full ladder: under a sustained
/// overload, one `continue` per ~20 s per agent forever. This cap bounds the
/// incidents, each with its own ladder of at most `MAX_ATTEMPTS` sends; it is
/// NOT a hard send-rate ceiling (reviewer P2-1): an older incident's ladder
/// can still finish inside a later window, so a 30-minute span can hold a
/// few more sends than 3 × 4. The next fresh incident in the window is not
/// continued, and the agent needs a person. Incidents are counted, not
/// sends: counting every send would quietly retire the ladder's last step.
/// The window lives in the gateway's memory and starts empty after a restart.
pub const MAX_INCIDENTS: usize = 3;
pub const INCIDENT_WINDOW_SECS: u64 = 30 * 60;

/// The status detail of an agent whose recovery stopped (capped or given up,
/// board #362 c): it needs a person.
pub const EXHAUSTED: &str = "recovery_exhausted";

/// What a person does about an agent whose status detail says it needs one
/// (board #362 c), in the words `tmm agent list` prints after the detail;
/// `None` for every other detail. The UI has the same remedies in its own
/// strings (`hubDetail_<detail>`).
pub fn person_remedy(detail: &str) -> Option<&'static str> {
    match detail {
        "auth_expired" => Some("run mwinit, then restart it"),
        "conversation_blocked" => Some("save its state, then clear the conversation"),
        EXHAUSTED => Some("auto-continue stopped; needs a person"),
        // A reboot restore started it and has not seen it ready (board #422).
        super::telemetry::RESTORE_NOT_READY_DETAIL => Some("restored, not ready; type a prompt into it"),
        _ => None,
    }
}

/// What is typed into the pane. Plain — an invented stamp would read as a
/// message the user never wrote.
const CONTINUE_LINE: &str = "continue";

/// Does this pane tail show a transient model error? Pure, per logical line.
pub fn scan_tail(backend: &str, text: &str) -> bool {
    error_signature(backend, text).is_some()
}

/// How far past the visible screen the ONE follow-up capture reaches when the
/// screen opens mid-block (see `headless_error_tail`). kiro's tallest observed
/// error paint is ~25 physical lines; 200 keeps the head in reach even after
/// several prompt redraws without trawling ancient history.
pub const DEEP_CAPTURE_LINES: usize = 200;

/// The IDENTITY of what is on the screen: `None` when no transient error is
/// visible, else `"<hits>|<sorted request_ids>"`. Two ticks that see the SAME
/// painted error produce the same signature; a SECOND error (the resumed turn
/// died again) changes it — new hit, new request_id — which is what re-arms a
/// confirmed incident. Ids are read from the hit's whole paint block, because
/// kiro hard-wraps and the `(request_id: …)` tail lands up to ~20 continuation
/// lines below the header (board #24's paint) — even split mid-id, which is
/// why the block is de-wrapped (joined without separators) before the scan.
pub fn error_signature(backend: &str, text: &str) -> Option<String> {
    signature_within(backend, text, 40)
}

/// The same scan over a DEEP capture (visible screen + scrollback): the
/// window covers everything the follow-up capture brought back, so a block
/// head that sits above the viewport is read rather than guessed at.
pub fn deep_error_signature(backend: &str, text: &str) -> Option<String> {
    signature_within(backend, text, DEEP_CAPTURE_LINES + 120)
}

/// Is this reassembled paint block one of `backend`'s OWN error shapes
/// (validator / orchestrator 12:08, #280), and which? A shape belongs to the
/// CLI that paints it, and lives in that backend's file: kiro's prose uses
/// the same flush-left `●` bullet claude does, so a kiro pane showing
/// claude's text must never be typed into, and the reverse. An unknown or
/// unmeasured backend has no shape.
fn backend_shape(backend: &str, glued: &str, spaced: &str) -> Option<&'static str> {
    crate::backends::Backend::parse(backend).and_then(|b| b.transient_shape(glued, spaced))
}

/// What ONE capture shows (board #473): the incident's signature, and the
/// shape of every hit in screen order. Signature, shapes and send
/// eligibility are all read from the same capture.
#[derive(Debug, PartialEq)]
struct Reading {
    sig: String,
    shapes: Vec<&'static str>,
    /// The Request IDs read off the hits, sorted, deduplicated.
    ids: Vec<String>,
}

fn signature_within(backend: &str, text: &str, window: usize) -> Option<String> {
    reading_within(backend, text, window).map(|r| r.sig)
}

fn reading_within(backend: &str, text: &str, window: usize) -> Option<Reading> {
    let blocks = paint_blocks(text, window);
    let mut shapes: Vec<&'static str> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    for (block, spaced) in &blocks {
        let c = crate::backends::canonical(block);
        // A block QUOTING the error (a chat delivery typed into the pane, or
        // its echo in the conversation) is not the agent having one — and a
        // quote's id must not pollute the signature either.
        if c.contains("tmmchat") {
            continue;
        }
        let Some(shape) = backend_shape(backend, block, spaced) else { continue };
        shapes.push(shape);
        if let Some(id) = extract_request_id(block) {
            ids.push(id);
        }
    }
    if shapes.is_empty() {
        return None;
    }
    ids.sort();
    ids.dedup();
    Some(Reading { sig: format!("{}|{}", shapes.len(), ids.join(",")), shapes, ids })
}

/// What the screen `tail` shows, and the deep capture it was read from when
/// one was needed (`deep` is asked at most once, only for a headless tail;
/// board #473: the reading and the send eligibility come from that same
/// capture).
fn read_capture(backend: &str, tail: &str, deep: impl FnOnce() -> Option<String>) -> Option<(Reading, Option<String>)> {
    if let Some(r) = reading_within(backend, tail, 40) {
        return Some((r, None));
    }
    if !headless_error_tail(tail) {
        return None;
    }
    let deep = deep()?;
    reading_within(backend, &deep, DEEP_CAPTURE_LINES + 120).map(|r| (r, Some(deep)))
}

/// May `continue` be typed for what `capture` shows (board #473: detection
/// is not eligibility)? A shape whose whole screen is read by a measured
/// grammar (`Measured::screen_grammar`) is continued only while an error is
/// the NEWEST block of this same capture — the idle composer under it and
/// nothing but the CLI's furniture between — so nothing is typed into a pane
/// that has moved on (a submitted prompt, a working turn, a tool call, a
/// typed composer). A hit of a shape whose screens were never measured
/// (kiro's two ≤ 2.18.1 shapes, claude's 5xx) keeps the ungated send it
/// always had, also beside a gated one: that is the explicit compatibility
/// boundary, not an oversight.
fn send_eligible(backend: &str, capture: &str, shapes: &[&'static str]) -> bool {
    let Some(b) = crate::backends::Backend::parse(backend) else { return false };
    let gated = |s: &str| crate::backends::measured_version(b, s).is_some_and(|m| m.screen_grammar);
    shapes.iter().any(|s| !gated(s)) || error_is_newest(backend, capture)
}

/// The reason a feed row gives for `capture` (board #473, P-1): the newest
/// block's shape when an error is the newest block, else the shape of the
/// capture's only hit, else the generic word — an older error painted above
/// a newer one is never named as this one's cause.
fn reason(backend: &str, capture: &str, shapes: &[&'static str]) -> &'static str {
    let Some(b) = crate::backends::Backend::parse(backend) else { return GENERIC_REASON };
    let shape = newest_shape(backend, capture).or(match shapes {
        [only] => Some(*only),
        _ => None,
    });
    shape.and_then(|s| crate::backends::measured_version(b, s)).map_or(GENERIC_REASON, |m| m.words)
}

/// The reason when the capture cannot say which error this is.
const GENERIC_REASON: &str = "transient error";

/// The last `window` lines of `text` reassembled into paint blocks, each as
/// (glued, spaced).
fn paint_blocks(text: &str, window: usize) -> Vec<(String, String)> {
    let lines: Vec<&str> = {
        let mut v: Vec<&str> = text.lines().rev().take(window).collect();
        v.reverse();
        v
    };
    // Reassemble kiro's PAINT BLOCKS: a column-zero head line owns every
    // indented line under it, and a blank line ends the paint. Each block is
    // de-wrapped into one string (lines trimmed, joined WITHOUT a separator —
    // canonical() drops spaces anyway, and only gluing lets a request_id that
    // wrapped mid-token be read back whole). An indented line with no open
    // block above it — the head scrolled off the capture, or a blank sat
    // between them — is dropped, never guessed at: the invisible head is a
    // `[tmm chat …]` stamp as easily as a real error header.
    // Each block is also kept with its lines joined by a space: the
    // high-traffic shape reads its model name as words (#267).
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut open = false;
    for line in &lines {
        if line.trim().is_empty() {
            open = false;
            continue;
        }
        if line.starts_with(' ') {
            if open {
                let (glued, spaced) = blocks.last_mut().expect("open implies a block");
                glued.push_str(line.trim());
                spaced.push(' ');
                spaced.push_str(line.trim());
            }
        } else {
            blocks.push((line.trim_end().to_string(), line.trim_end().to_string()));
            open = true;
        }
    }
    blocks
}

/// `… (request_id: 30010907-33c4-…)` or v3's `(Request ID: …)` → the id token.
fn extract_request_id(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase(); // same byte offsets as `line`
    let (idx, key) = ["request_id", "request id"]
        .iter()
        .find_map(|k| lower.find(k).map(|i| (i, k.len())))?;
    let rest = &line[idx + key..];
    let id: String = rest
        .chars()
        .skip_while(|c| !c.is_ascii_alphanumeric())
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    (!id.is_empty()).then_some(id)
}

/// Does the capture OPEN mid-block — its first paint an indented continuation
/// whose head sits above the viewport — and does that orphan run look like a
/// transient error's tail? kiro's error paint is ~25 physical lines; on a
/// short pane the prompt redraw pushes the HEADER off the screen while the
/// agent sits stalled right under the block (the 2026-09-05 kirocrew miss:
/// 57×36 pane, header one line above the fold, incident invisible). A `true`
/// here earns ONE deeper capture so the head is READ — never guessed: the
/// deep rescan still drops a block whose recovered head is a `[tmm chat …]`
/// stamp or a `●` tool bullet.
pub fn headless_error_tail(text: &str) -> bool {
    let mut orphan = String::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            // Leading blanks before any content are the fold itself; a blank
            // AFTER the orphan run ends the paint block.
            if orphan.is_empty() {
                continue;
            }
            break;
        }
        if !line.starts_with(' ') {
            break; // a column-zero line: the screen opens with a whole block
        }
        orphan.push_str(line.trim());
    }
    if orphan.is_empty() {
        return false;
    }
    let c = crate::backends::canonical(&orphan);
    // A stamp INSIDE the orphan is already a quote; the deep rescan handles
    // the stamp-above-the-fold case by reading the real head.
    if c.contains("tmmchat") {
        return false;
    }
    // `requestid` covers both `request_id` and v3's `Request ID` (#267).
    crate::backends::kiro::TRANSIENT.iter().any(|m| c.contains(m)) || c.contains("requestid")
}

/// An incident's attempts and timing before a decision (`Tracker::send_mark`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SendMark {
    attempts: u32,
    sent_at: u64,
    sent_seq: u64,
    next_at: u64,
}

#[cfg(test)]
impl SendMark {
    fn attempts_for_test(&self) -> u32 {
        self.attempts
    }
}

#[derive(Default)]
struct Rec {
    /// Which error instance this incident is about (`error_signature`). A
    /// tick whose visible signature differs replaces the whole record: the
    /// SECOND error is a new incident with a full budget.
    sig: String,
    attempts: u32,
    /// Unix seconds before which no further attempt may run.
    next_at: u64,
    /// When the last `continue` was typed (the backoff measures from here).
    sent_at: u64,
    /// The window's fact sequence when it was decided (board #473): the
    /// progress check counts only facts that arrived after it.
    sent_seq: u64,
    /// Hooks showed a turn fact after `sent_at`: the incident is OVER, even
    /// though the error text is still painted on the screen. Nothing more is
    /// sent until the error leaves the screen and a fresh one appears.
    confirmed: bool,
    /// A SENT incident was confirmed by `note_answered` (a tool call or a
    /// real reply) and "took effect" has not been said yet (board #473): the
    /// next tick that sees the incident, or the one that clears it, says it.
    effect_unsaid: bool,
    /// A turn version newer than this incident's own, seen once with its
    /// error still the newest block (board #473, `Tracker::bind`); the next
    /// tick that sees the same version settles it as a new failure.
    settling: Option<u64>,
    /// The newest error block's own Request ID when this incident was bound
    /// (`bind`); `None` until bound, `Some(None)` for an id-less error.
    bound: Option<Option<String>>,
    /// The arrival number of the progress fact that CONFIRMED this incident
    /// (board #473, orchestrator's ruling 20:02; review P2-A on 0126b589):
    /// progress after it is the resumed turn working on, so an error the
    /// newest block afterwards is a new failure. `None` until confirmed.
    conf_seq: Option<u64>,
    /// The give-up warning is emitted once per incident, not once per tick.
    gave_up_reported: bool,
    /// This incident arrived with the window's cross-incident cap reached
    /// (board #362 e): it is never continued, even after older ladders age
    /// out of the window while it is still on the screen.
    capped: bool,
    /// This incident's exhausted decision has been recorded as the turn's
    /// end (board #362 c). Its identity is the INCIDENT (review P1-D: a
    /// Claude 5xx has no Request ID, so its signature `1|` is no paint id),
    /// so it lives and dies with this record: once per continuous incident,
    /// and a later independent incident is recorded again.
    exhausted_recorded: bool,
    /// The turn-fact version (`telemetry::turn_version`) at the tick this
    /// incident's error was FIRST seen as the newest block on the screen
    /// (board #362, the builder's 02:30 finding): its attribution point. A
    /// capped decision ends a turn only while no turn fact has landed since:
    /// a prompt accepted after it, painted or not, makes the error another
    /// turn's past. `None` until it is seen as the newest block.
    newest_at: Option<u64>,
}

/// What the tracker decided for one (window, tick) with the error visible.
#[derive(Debug, PartialEq)]
pub enum Decision {
    /// Type `continue` now; this is attempt `n` of `MAX_ATTEMPTS`.
    Send { attempt: u32 },
    /// A sent attempt has not been verified yet and its backoff has not
    /// elapsed — do nothing this tick.
    Wait,
    /// The hooks JUST verified the last send (a turn fact arrived after it).
    /// `true` exactly once, for the log line.
    Confirmed { first: bool },
    /// The budget is spent with nothing verified. `true` exactly once.
    GiveUp { first: bool },
    /// A fresh incident with `MAX_INCIDENTS` ladders already started in the
    /// window (board #362 e): not continued; the agent needs a person.
    /// `true` once per capped STRETCH of the window, not per incident
    /// (validator P3): the stretch ends when a ladder can start again or the
    /// agent works again.
    Capped { first: bool },
}

/// Pure bookkeeping, `now` and the hook check injected so every path is
/// testable without tmux or real hooks.
#[derive(Default)]
pub struct Tracker {
    map: HashMap<(String, String), Rec>,
    /// When each recent incident STARTED a ladder (its first send), per
    /// window: the cross-incident cap reads it. It outlives the incident
    /// records, which go when their error leaves the screen.
    starts: HashMap<(String, String), Vec<u64>>,
    /// The windows whose cap has been SAID (validator P3, #362): once per
    /// capped stretch, not once per fresh incident, which under a fresh error
    /// every ~20 s floods the feed. The stretch ends when the window has room
    /// again (a ladder starts) or the agent works again (a tool call).
    capped_said: std::collections::HashSet<(String, String)>,
}

impl Tracker {
    /// The error with signature `sig` is visible in (session, window) at
    /// `now` — what do we do? `verified(sent_at)` answers "did the agent
    /// progress at/after that time" (see `telemetry::progress_since`); it is
    /// consulted before any retry, so a `continue` that WORKED is never
    /// followed by another one just because the error text is still painted
    /// (owner, 2026-08-26). A DIFFERENT signature than the record's replaces
    /// it wholesale — confirmed, mid-backoff or given-up alike: whatever the
    /// old incident's state, a new error instance is a new incident (owner,
    /// 2026-08-26: "有可能还会出现二次报错并停止…就需要再次发送指令").
    #[cfg(test)]
    pub fn decide(&mut self, session: &str, window: &str, now: u64, sig: &str, verified: impl FnOnce(u64) -> bool) -> Decision {
        self.decide_seq(session, window, now, 0, sig, verified)
    }

    /// `decide` at the window's fact sequence `seq` (`telemetry::turn_version`
    /// read before the capture, board #473): a send records it, and
    /// `verified(sent_seq)` asks whether the agent progressed AFTER it in
    /// arrival order, never by whole seconds.
    pub fn decide_seq(
        &mut self,
        session: &str,
        window: &str,
        now: u64,
        seq: u64,
        sig: &str,
        verified: impl FnOnce(u64) -> bool,
    ) -> Decision {
        let key = (session.to_string(), window.to_string());
        if self.map.get(&key).is_some_and(|r| r.sig != sig) {
            self.map.remove(&key);
        }
        let rec = self.map.entry(key).or_default();
        rec.sig = sig.to_string();
        if rec.confirmed {
            let first = std::mem::take(&mut rec.effect_unsaid);
            return Decision::Confirmed { first };
        }
        // A send exists: ask the hooks FIRST. Verification outranks both the
        // backoff ladder and the give-up — a 4th attempt that finally landed
        // is a success, not an exhausted budget.
        if rec.attempts > 0 && verified(rec.sent_seq) {
            rec.confirmed = true;
            return Decision::Confirmed { first: true };
        }
        if rec.attempts >= MAX_ATTEMPTS {
            let first = !rec.gave_up_reported;
            rec.gave_up_reported = true;
            return Decision::GiveUp { first };
        }
        if rec.capped {
            return Decision::Capped { first: false };
        }
        if now < rec.next_at {
            return Decision::Wait;
        }
        if rec.attempts == 0 {
            // A ladder would START: the cross-incident cap decides.
            let starts = self.starts.entry((session.to_string(), window.to_string())).or_default();
            starts.retain(|&t| t + INCIDENT_WINDOW_SECS > now);
            if starts.len() >= MAX_INCIDENTS {
                rec.capped = true;
                let first = self.capped_said.insert((session.to_string(), window.to_string()));
                return Decision::Capped { first };
            }
            starts.push(now);
            // The window has room again: a later cap is a new stretch, said again.
            self.capped_said.remove(&(session.to_string(), window.to_string()));
        }
        rec.attempts += 1;
        rec.sent_at = now;
        rec.sent_seq = seq;
        // 30s after the 1st attempt, 60s after the 2nd, 120s after the 3rd.
        rec.next_at = now + BASE_BACKOFF_SECS * (1 << (rec.attempts - 1));
        Decision::Send { attempt: rec.attempts }
    }

    /// A screen showing the window's error is NOT eligible for a send (board
    /// #473): nothing is decided, spent or cleared, but a send already made
    /// is still verified, so "took effect" is said when the agent PROGRESSED
    /// even while the pane is busy with the resumed turn. It asks the
    /// window's incident whatever the screen's signature: an ineligible
    /// screen carries no turn binding. `true` exactly once per incident.
    pub fn verify_pending(&mut self, session: &str, window: &str, verified: impl FnOnce(u64) -> bool) -> bool {
        match self.map.get_mut(&(session.to_string(), window.to_string())) {
            Some(r) if r.confirmed => std::mem::take(&mut r.effect_unsaid),
            Some(r) if r.attempts > 0 && verified(r.sent_seq) => {
                r.confirmed = true;
                true
            }
            _ => false,
        }
    }

    /// The key of a GATED error seen as the newest block (board #473): the
    /// turn it ended, `turn:<prompt>`, the arrival number of the window's
    /// newest accepted PROMPT (`telemetry::prompt_seq`). kiro v3 ends an
    /// errored turn with no hook, so a new failure needs a new prompt, while a
    /// tool call, an end (our own missed end included), an ask, an interrupt,
    /// a redraw, a resize or a scroll never moves it (review P1-A on f6c6b048:
    /// the all-facts version moved with our own give-up and reopened the
    /// ladder). A moved prompt is a NEW incident only when
    /// - it is SETTLED: seen at two eligible ticks in a row (`unsettle` drops
    ///   the candidate on any ineligible tick, never the incident). kiro paints
    ///   a submitted prompt within a second (#362: 154-533 ms), so an error
    ///   still the newest block a tick later is a new failure, not a prompt
    ///   about to paint; and
    /// - there is evidence of a new FAILURE (orchestrator's ruling 20:02):
    ///   - our own send went unanswered (sent, never confirmed): the row A
    ///     outage, where each accepted `continue` failed again and the
    ///     screen could repeat byte for byte;
    ///   - the incident is CONFIRMED and the agent PROGRESSED after the
    ///     confirmation (`progressed(conf_seq)`: a later tool call or valid
    ///     CLI end). The resumed turn worked on, so its output lies below the
    ///     old error, and an error the newest block now is the resumed turn
    ///     dying again (orchestrator's ruling 19:29). No progress since the
    ///     confirmation: the same incident, whatever the display does (the
    ///     Midway segment, a gauge, a reflow, a taller window re-exposing
    ///     older errors and their Request IDs; review P1 on e2ba9948: no text
    ///     of the screen is identity);
    ///   - an incident never sent to (capped): a newest block with another
    ///     Request ID than the one it was bound on.
    ///   When both newest blocks carry a Request ID, the same ID is the same
    ///   error whatever else holds, in every branch (review P2-B on 0126b589:
    ///   an unanswered incident keeps its backoff retries then, it does not
    ///   start a new ladder).
    /// `None` while it settles: that tick decides nothing.
    pub fn bind(&mut self, session: &str, window: &str, prompt: u64, newest_id: Option<String>, progressed: impl FnOnce(u64) -> bool) -> Option<String> {
        let own = format!("turn:{prompt}");
        let Some(r) = self.map.get_mut(&(session.to_string(), window.to_string())) else { return Some(own) };
        if !r.sig.starts_with("turn:") || r.sig == own {
            r.settling = None;
            return Some(own);
        }
        let bound_id = r.bound.clone().flatten();
        let same_id = matches!((&bound_id, &newest_id), (Some(a), Some(b)) if a == b);
        let new_failure = if same_id {
            false
        } else if r.attempts > 0 && !r.confirmed {
            true
        } else if r.confirmed {
            r.conf_seq.is_some_and(progressed)
        } else {
            matches!((&bound_id, &newest_id), (Some(a), Some(b)) if a != b)
        };
        if !new_failure {
            r.settling = None;
            return Some(r.sig.clone());
        }
        if r.settling == Some(prompt) {
            return Some(own);
        }
        r.settling = Some(prompt);
        None
    }

    /// A confirmation the TICK made (no `note_answered` behind it, e.g. a
    /// valid end with no usable reply) is bound to the earliest progress fact
    /// after the send that is still known (`first(sent_seq)`,
    /// `telemetry::progress_seq_since`), never to the tick's own snapshot
    /// (review P2-A on 0126b589).
    pub fn settle_conf(&mut self, session: &str, window: &str, first: impl FnOnce(u64) -> Option<u64>) {
        if let Some(r) = self.map.get_mut(&(session.to_string(), window.to_string())) {
            if r.confirmed && r.conf_seq.is_none() && r.attempts > 0 {
                r.conf_seq = Some(first(r.sent_seq).unwrap_or(r.sent_seq));
            }
        }
    }

    /// An ineligible tick: a settling candidate is dropped (review P2-C on
    /// f6c6b048), the incident, its budget and its confirmation are not.
    pub fn unsettle(&mut self, session: &str, window: &str) {
        if let Some(r) = self.map.get_mut(&(session.to_string(), window.to_string())) {
            r.settling = None;
        }
    }

    /// Remember the newest error's Request ID an incident was first bound on
    /// (`bind`); later captures do not move it.
    pub fn remember_newest(&mut self, session: &str, window: &str, newest_id: Option<String>) {
        if let Some(r) = self.map.get_mut(&(session.to_string(), window.to_string())) {
            r.bound.get_or_insert(newest_id);
        }
    }

    /// Where the window's incident about `sig` stood before a decision (its
    /// attempts and timing), so a send the restore barrier refused can be
    /// taken back. Another signature's record is replaced by `decide`, so it
    /// marks a fresh incident.
    pub fn send_mark(&self, session: &str, window: &str, sig: &str) -> SendMark {
        match self.map.get(&(session.to_string(), window.to_string())) {
            Some(r) if r.sig == sig => SendMark { attempts: r.attempts, sent_at: r.sent_at, sent_seq: r.sent_seq, next_at: r.next_at },
            _ => SendMark::default(),
        }
    }

    /// Take back the `Send` decided at `now` whose `continue` the restore
    /// barrier refused (board #422 round 3): nothing was typed, so no
    /// attempt is spent and, for a first attempt, no ladder was started.
    /// (The said cap the start cleared stays cleared: no cap can follow
    /// without another start, which clears it again.)
    pub fn undo_send(&mut self, session: &str, window: &str, mark: SendMark, now: u64) {
        let key = (session.to_string(), window.to_string());
        if let Some(rec) = self.map.get_mut(&key) {
            rec.attempts = mark.attempts;
            rec.sent_at = mark.sent_at;
            rec.sent_seq = mark.sent_seq;
            rec.next_at = mark.next_at;
        }
        if mark.attempts == 0 {
            if let Some(starts) = self.starts.get_mut(&key) {
                if let Some(i) = starts.iter().rposition(|&t| t == now) {
                    starts.remove(i);
                }
            }
        }
    }

    /// A tool call from the window CONFIRMS an open incident — the model
    /// answered, so the `continue` (or something else) worked. It must never
    /// erase the record: the error text is still painted, and a wiped record
    /// made the next tick open a brand-new incident and type `continue` into
    /// the now-working agent — the repeat-send the owner reported
    /// (2026-08-26: "系统会反复发送好几次 auto recovery").
    pub fn confirm(&mut self, session: &str, window: &str, seq: u64) {
        let key = (session.to_string(), window.to_string());
        if let Some(rec) = self.map.get_mut(&key) {
            // A fact that ARRIVED before our send answers nothing we typed
            // (board #473, review P2 on fd866766): a Post half folded into its
            // Pre carries the Pre's number, which can predate the send.
            if rec.attempts > 0 && seq <= rec.sent_seq {
                return;
            }
            // A send of ours that this progress answers is said once, by the
            // tick (board #473): telemetry is recording here, not narrating.
            rec.effect_unsaid |= rec.attempts > 0 && !rec.confirmed;
            if !rec.confirmed {
                rec.conf_seq = Some(seq);
            }
            rec.confirmed = true;
        }
        // The agent works again: a later cap is a new stretch, said again.
        self.capped_said.remove(&key);
    }

    /// The error is no longer on the window's screen: the incident is over,
    /// whatever its state was. The record is dropped so a FRESH error later
    /// starts a fresh incident with a full budget. `true` when the incident
    /// had taken effect and that was not said yet (board #473).
    pub fn clear(&mut self, session: &str, window: &str) -> bool {
        self.map.remove(&(session.to_string(), window.to_string())).is_some_and(|r| r.effect_unsaid)
    }

    /// Has the window's current incident NOT had its exhausted decision
    /// recorded yet? Asking marks nothing (`exhausted_accept` does, only once
    /// telemetry accepted it, review P1-A).
    pub fn exhausted_new(&self, session: &str, window: &str) -> bool {
        self.map.get(&(session.to_string(), window.to_string())).is_some_and(|r| !r.exhausted_recorded)
    }

    /// May the window's current incident record its exhausted decision as
    /// the end of the turn at version `now_version`? Only when its error is
    /// the newest block NOW (`newest`, by the backend's own grammar) and was
    /// first seen so at this very version: nothing landed since (board
    /// #362, the builder's 02:30 finding). Records the first sighting.
    pub fn exhausted_attributable(&mut self, session: &str, window: &str, newest: bool, now_version: u64) -> bool {
        let Some(r) = self.map.get_mut(&(session.to_string(), window.to_string())) else { return false };
        if !newest {
            return false;
        }
        *r.newest_at.get_or_insert(now_version) == now_version
    }

    /// The current incident's exhausted decision was recorded.
    pub fn exhausted_accept(&mut self, session: &str, window: &str) {
        if let Some(r) = self.map.get_mut(&(session.to_string(), window.to_string())) {
            r.exhausted_recorded = true;
        }
    }

    /// Housekeeping: drop records for windows that no longer exist.
    pub fn retain_windows(&mut self, session: &str, live: &[String]) {
        self.map.retain(|(s, w), _| s != session || live.contains(w));
        self.starts.retain(|(s, w), _| s != session || live.contains(w));
        self.capped_said.retain(|(s, w)| s != session || live.contains(w));
    }
}

/// Test seam (board #473): run once between a tick's decision and its send,
/// so a test can land a turn fact exactly where the stale-screen check looks.
#[cfg(test)]
thread_local! {
    static AFTER_DECIDE: std::cell::RefCell<Option<Box<dyn FnOnce(&str, &str)>>> = std::cell::RefCell::new(None);
}

/// Test-only: the tracker's window housekeeping, as `check_once` runs it.
#[cfg(test)]
pub(crate) fn retain_windows_for_test(session: &str, live: &[String]) {
    tracker().lock().unwrap().retain_windows(session, live);
}

fn tracker() -> &'static Mutex<Tracker> {
    static T: OnceLock<Mutex<Tracker>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Tracker::default()))
}

/// Test seam: open an unconfirmed incident on a window.
#[cfg(test)]
pub(crate) fn open_incident_for_test(session: &str, window: &str) {
    tracker().lock().unwrap().map.insert((session.to_string(), window.to_string()), Rec { sig: "test".into(), ..Rec::default() });
}

/// Test seam: is the window's incident confirmed (`None`: no incident)?
#[cfg(test)]
pub(crate) fn incident_confirmed_for_test(session: &str, window: &str) -> Option<bool> {
    tracker().lock().unwrap().map.get(&(session.to_string(), window.to_string())).map(|r| r.confirmed)
}

/// Called by telemetry on every observed tool call and every turn end with a
/// real reply (board #362: the reply resets a capped stretch too): either is
/// proof the model answered, so an open incident is CONFIRMED (never erased —
/// see `Tracker::confirm` for the repeat-send that erasing caused).
/// `seq` is the arrival number of the fact that answered (board #473 review
/// P2-A on 0126b589): the confirmation is bound to it, never to a later
/// snapshot of every fact.
pub fn note_answered(session: &str, window: &str, seq: u64) {
    tracker().lock().unwrap().confirm(session, window, seq);
}

/// Record the turn end the hooks missed for a person-needed PAINT (board
/// #362 c): `sig` is `<shape>|<Request ID>`, its global identity, `detail`
/// what the person must do, and `seen` the turn-fact version read BEFORE
/// the screen was captured. Telemetry keeps the once durably
/// (`Identity::Paint`): an accepted paint never ends a later turn. True
/// when accepted.
fn commit_person(session: &str, window: &str, sig: &str, detail: &str, seen: u64) -> bool {
    use super::telemetry::{record_missed_end, Identity, Missed};
    matches!(record_missed_end(session, window, detail, Identity::Paint(sig), seen), Missed::Ended | Missed::Attached)
}

/// Record the turn end the hooks missed for an EXHAUSTED recovery decision
/// (capped or given up): once per incident (`Identity::Incident`, review
/// P1-D), the mark committed only when telemetry accepted it. `seen` is the
/// turn version read before the capture. A GIVE-UP is not a recovery: each
/// of its sends was checked against the hooks and none was confirmed, so its
/// open turn is the one the sends went to. A CAPPED
/// incident sent nothing, so its error is attributed by the screen and the
/// hooks together (board #362, the builder's 02:30 finding): `newest` says
/// its error is the newest block by the backend's own grammar, and nothing
/// may have landed since it was first seen so (`exhausted_attributable`);
/// otherwise nothing is recorded. True when accepted.
fn commit_exhausted(session: &str, window: &str, capped: bool, newest: bool, seen: u64) -> bool {
    use super::telemetry::{record_missed_end, Identity, Missed};
    // Once per incident: defence in depth under the attribution rule, which
    // already refuses a second commit after our own end (a fact).
    if !tracker().lock().unwrap().exhausted_new(session, window) {
        return false;
    }
    if capped && !tracker().lock().unwrap().exhausted_attributable(session, window, newest, seen) {
        return false;
    }
    let accepted = matches!(record_missed_end(session, window, EXHAUSTED, Identity::Incident, seen), Missed::Ended | Missed::Attached);
    if accepted {
        tracker().lock().unwrap().exhausted_accept(session, window);
    }
    accepted
}

/// Is the error `sig` names the NEWEST block of `tail`, by `backend`'s own
/// measured grammar (`Backend::newest_block`) and its own transient shape?
/// `false` where no grammar was measured (claude): unattributable.
fn error_is_newest(backend: &str, tail: &str) -> bool {
    newest_shape(backend, tail).is_some()
}

/// The transient shape of `tail`'s newest block, by the backend's own
/// measured grammar; `None` when the newest block is not one of its errors
/// or no grammar was measured.
fn newest_shape(backend: &str, tail: &str) -> Option<&'static str> {
    let b = crate::backends::Backend::parse(backend)?;
    let (glued, spaced) = b.newest_block(tail)?;
    if crate::backends::canonical(&glued).contains("tmmchat") {
        return None;
    }
    b.transient_shape(&glued, &spaced)
}

/// Is `capture`'s newest block a GATED error (board #473)? Such an incident
/// is identified by the turn it ended (`Tracker::bind`), not by the screen:
/// a short pane shows only the last errors, so their count and ids are not
/// identity, and a resize changes both.
fn turn_bound(backend: &str, capture: &str) -> bool {
    crate::backends::Backend::parse(backend).is_some_and(|b| {
        newest_shape(backend, capture).and_then(|s| crate::backends::measured_version(b, s)).is_some_and(|m| m.screen_grammar)
    })
}

/// The newest error block's own Request ID on `capture`, by the backend's
/// grammar (board #473): `Tracker::bind`'s equality check, never a reading
/// of the rest of the screen.
fn newest_request_id(backend: &str, capture: &str) -> Option<String> {
    let b = crate::backends::Backend::parse(backend)?;
    let (glued, _) = b.newest_block(capture)?;
    extract_request_id(&glued)
}

/// The one "took effect" row: said when the agent PROGRESSED after our send
/// (a tool call or a turn end the CLI sent, board #473), never on the
/// continue's own prompt.
fn say_took_effect(session: &str, window: &str) {
    super::telemetry::record_recovery(session, window, &format!("auto-continue took effect — {window} is working again"));
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One pass over every managed agent window of every live project, from the
/// capture tick. Reads the VISIBLE screen only (an error deep in scrollback is
/// an error somebody already moved past) and stays fail-soft throughout: this
/// is a convenience, and a convenience that can error a capture tick away is
/// too expensive.
pub fn check_once() {
    let projects = match super::with_store(|s| s.list_projects(false)) {
        Ok(list) => list,
        Err(_) => return,
    };
    for project in &projects {
        if !crate::tmux::session_exists(&project.session) {
            continue;
        }
        let Ok(panes) = crate::tmux::list_panes(&project.session) else { continue };
        let live: Vec<String> = panes.iter().map(|p| p.window_name.clone()).collect();
        tracker().lock().unwrap().retain_windows(&project.session, &live);
        let mut seen = std::collections::HashSet::new();
        for p in &panes {
            if !seen.insert(p.window) || !p.active {
                continue;
            }
            // The backend decides which error shapes can be this pane's own
            // (#280): the #260 detect path, the launch recipe then argv.
            let Some(agent) = super::agents::detect_pane(Some(project.path.as_str()), p) else { continue };
            if !super::is_managed_in(Some(project.path.as_str()), &p.window_name) {
                continue;
            }
            let backend = agent.backend;
            let target = format!("{}:{}.{}", project.session, p.window, p.pane);
            // The turn this screen is about: read BEFORE the capture, so a
            // fact that lands while it runs makes the observation stale
            // (board #362 review P1-A). No lock is held across the capture.
            let seen = super::telemetry::turn_version(&project.session, &p.window_name);
            // The turn identity (board #473): the newest accepted prompt.
            let prompt = super::telemetry::prompt_seq(&project.session, &p.window_name);
            let Ok(tail) = crate::tmux::capture_pane_plain(&target, Some(0)) else { continue };
            // An error only a person can clear, as the NEWEST paint (board
            // #362 c): its turn end is recorded once, the hooks having missed
            // it, and it is never continued. It is read first, so a transient
            // error still painted above it types nothing either.
            if let Some((shape, block)) = crate::backends::Backend::parse(backend).and_then(|b| b.person_paint(&tail)) {
                // Its Request ID is its identity (every measured shape ends
                // with one); without it nothing is recorded.
                if let Some(id) = extract_request_id(&block) {
                    commit_person(&project.session, &p.window_name, &format!("{shape}|{id}"), shape, seen);
                }
                continue;
            }
            // The screen may open MID-BLOCK: a tall error paint plus the
            // prompt redraw pushes the block's header above a short pane's
            // fold, and a headless tail alone is never trusted. ONE deeper
            // capture brings the head back into view so it can be read
            // (2026-09-05: the kirocrew agent sat stalled under exactly such
            // a paint for half an hour).
            let found = read_capture(backend, &tail, || crate::tmux::capture_pane_plain(&target, Some(DEEP_CAPTURE_LINES)).ok());
            let Some((reading, deep)) = found else {
                // The error left the screen: the incident (if any) is over.
                // Dropping the record here is what scopes "one incident" to
                // one CONTINUOUS sighting — a fresh error later starts fresh.
                if tracker().lock().unwrap().clear(&project.session, &p.window_name) {
                    say_took_effect(&project.session, &p.window_name);
                }
                continue;
            };
            // Eligibility, shape and signature from the SAME capture (board
            // #473): the deep one when it was taken, which holds the real
            // head and the current composer at its bottom.
            let capture = deep.as_deref().unwrap_or(&tail);
            // A gated error that is the newest block is identified by the
            // turn it ended (board #473, `Tracker::bind`); `None` while a
            // moved turn version is still settling. Every other capture keeps
            // the screen's `hits|ids`.
            let key = if !send_eligible(backend, capture, &reading.shapes) {
                tracker().lock().unwrap().unsettle(&project.session, &p.window_name);
                None
            } else if turn_bound(backend, capture) {
                tracker().lock().unwrap().bind(&project.session, &p.window_name, prompt, newest_request_id(backend, capture), |after| {
                    super::telemetry::progress_since(&project.session, &p.window_name, after)
                })
            } else {
                Some(reading.sig.clone())
            };
            let Some(sig) = key else {
                // The error is still painted but the pane moved on (or its
                // turn version is settling): nothing is typed, and nothing is
                // decided, spent or cleared. A send already made is still
                // verified against the hooks.
                let confirmed = {
                    let mut t = tracker().lock().unwrap();
                    let said = t.verify_pending(&project.session, &p.window_name, |sent_seq| {
                        super::telemetry::progress_since(&project.session, &p.window_name, sent_seq)
                    });
                    t.settle_conf(&project.session, &p.window_name, |after| super::telemetry::progress_seq_since(&project.session, &p.window_name, after));
                    said
                };
                if confirmed {
                    say_took_effect(&project.session, &p.window_name);
                }
                continue;
            };
            let why = reason(backend, capture, &reading.shapes);
            // The mark and the decision under one lock, at one `now`: a send
            // the barrier refuses is taken back exactly.
            let now = now_secs();
            let (mark, decision) = {
                let mut t = tracker().lock().unwrap();
                let mark = t.send_mark(&project.session, &p.window_name, &sig);
                let decision = t.decide_seq(&project.session, &p.window_name, now, seen, &sig, |sent_seq| {
                    super::telemetry::progress_since(&project.session, &p.window_name, sent_seq)
                });
                t.remember_newest(&project.session, &p.window_name, newest_request_id(backend, capture));
                t.settle_conf(&project.session, &p.window_name, |after| super::telemetry::progress_seq_since(&project.session, &p.window_name, after));
                (mark, decision)
            };
            // Recovery stopped for this incident (capped or given up): the
            // agent needs a person, and the turn end the hooks never sent is
            // recorded once for the incident (board #362 c).
            if matches!(decision, Decision::Capped { .. } | Decision::GiveUp { .. }) {
                let capped = matches!(decision, Decision::Capped { .. });
                let newest = capped && error_is_newest(backend, capture);
                commit_exhausted(&project.session, &p.window_name, capped, newest, seen);
            }
            #[cfg(test)]
            AFTER_DECIDE.with(|f| {
                if let Some(f) = f.borrow_mut().take() {
                    f(&project.session, &p.window_name);
                }
            });
            match decision {
                // Automated input: through the one send door (board #422
                // round 3). A restore barrier's refusal wrote nothing, so it
                // spends nothing of the incident's budget. Nor does a turn
                // fact that landed since the capture (board #473): the pane
                // moved on, the screen this send was decided on is stale, and
                // the send is taken back the same way. The check and the
                // keystrokes are not atomic: a key typed in between is not
                // caught.
                Decision::Send { .. } if super::telemetry::turn_version(&project.session, &p.window_name) != seen => {
                    tracker().lock().unwrap().undo_send(&project.session, &p.window_name, mark, now)
                }
                Decision::Send { attempt } => match super::delivery::send_into(&project.session, &p.window_name, &target, CONTINUE_LINE) {
                    Ok(()) => super::telemetry::record_recovery(
                        &project.session,
                        &p.window_name,
                        &format!("auto-continue {attempt}/{MAX_ATTEMPTS} — {why} in {}", p.window_name),
                    ),
                    Err(e) if super::delivery::barred(&e) => tracker().lock().unwrap().undo_send(&project.session, &p.window_name, mark, now),
                    Err(_) => {}
                },
                Decision::Confirmed { first: true } => say_took_effect(&project.session, &p.window_name),
                Decision::GiveUp { first: true } => {
                    super::telemetry::record_recovery(
                        &project.session,
                        &p.window_name,
                        &format!(
                            "auto-continue gave up after {MAX_ATTEMPTS} attempts — {} needs a person",
                            p.window_name
                        ),
                    );
                }
                Decision::Capped { first: true } => {
                    super::telemetry::record_recovery(
                        &project.session,
                        &p.window_name,
                        &format!(
                            "auto-continue paused — {MAX_INCIDENTS} errors in {} min were already continued; {} needs a person",
                            INCIDENT_WINDOW_SECS / 60,
                            p.window_name
                        ),
                    );
                }
                Decision::Wait
                | Decision::Confirmed { first: false }
                | Decision::GiveUp { first: false }
                | Decision::Capped { first: false } => {}
            }
        }
    }
}

/// The recovery drift warning for `backend` with `installed` installed
/// (board #362 b), or `None` when every shape it knows was measured on that
/// version or a newer one. "Installed", not "running": a pane started before
/// an upgrade still runs the old binary (reviewer P2-3). A detector tied to a CLI's painted text rots silently when the
/// CLI repaints (#346, #361 were found by the owner noticing a stalled
/// agent), so a newer CLI than the one a shape was measured on is said out
/// loud. No action follows from it. Pure.
pub fn drift_warning(backend: crate::backends::Backend, installed: &str) -> Option<String> {
    let version = crate::backends::parse_version(installed)?;
    let mut by_label: Vec<(String, Vec<String>)> = Vec::new();
    for m in backend.recovery_shapes().iter().filter(|m| crate::backends::newer_than_measured(&version, m)) {
        let name = m.words.to_string();
        match by_label.iter_mut().find(|(l, _)| *l == m.label()) {
            Some((_, names)) => names.push(name),
            None => by_label.push((m.label(), vec![name])),
        }
    }
    if by_label.is_empty() {
        return None;
    }
    let measured = by_label.iter().map(|(l, n)| format!("{l} ({})", n.join(", "))).collect::<Vec<_>>().join(" and ");
    Some(format!(
        "recovery shapes for {} were measured on {measured}, installed {installed} (used at the next launch) — re-measure when one of them is next seen",
        backend.name()
    ))
}

/// The version of `backend`'s CLI a NEW pane would run: its `--version`
/// answer, with the PATH managed agents launch with (`agent_launch_path`). A
/// pane started before an upgrade may still run the old binary; this is the
/// one the next start gets, so it is said as "installed".
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn installed_version(backend: crate::backends::Backend) -> Option<String> {
    let program = backend.version_program()?;
    let path = crate::backends::shared::agent_launch_path(None, &std::env::var("PATH").unwrap_or_default());
    let mut cmd = std::process::Command::new(program);
    cmd.arg("--version").env("PATH", path);
    let out = version_output(cmd, std::time::Duration::from_secs(10))?;
    let v = crate::backends::parse_version(&out)?;
    Some(v.iter().map(u64::to_string).collect::<Vec<_>>().join("."))
}

/// The most of a `--version` answer that is read. The answer is one line; a
/// probe that keeps writing must not grow the gateway's memory (reviewer
/// round 2, #362).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const VERSION_READ_CAP: u64 = 64 * 1024;

/// Run `cmd` and return its stdout, within ONE total `limit` for the start,
/// the exit and the read (reviewer P2-2, #362): a wrapper that exits while a
/// child it forked keeps stdout open would otherwise block the read, and the
/// drift loop with it, forever. stdout is read on its own thread, and the
/// thread STOPS reading after `VERSION_READ_CAP` bytes and drops the pipe;
/// the caller waits for the exit and then for that thread, both against the
/// same deadline. Only a SUCCESSFUL exit's output is used.
///
/// The probe runs in a process group of its own, and the group is killed on
/// every way out (reviewer round 2, #362): a child holding stdout, or one
/// still writing, ends with the probe, and its pipe closing ends the reader
/// thread. The signal can reach this probe's processes and nothing else: the
/// group is a NEW one (`process_group(0)`, its id the leader's pid, never the
/// gateway's group), and it is signalled while the leader is NOT yet reaped
/// (its exit is watched with `waitid(WNOWAIT)`, which leaves it a zombie), so
/// the kernel still holds that pid and no other process can own a group of
/// that id. A leader that something else reaped is not signalled at all.
/// Anything that `setsid`s itself away is its own choice, as for
/// `tasks::stop`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn version_output(mut cmd: std::process::Command, limit: std::time::Duration) -> Option<String> {
    use std::io::Read;
    use std::os::unix::process::CommandExt;
    let deadline = std::time::Instant::now() + limit;
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    let pid = child.id() as libc::pid_t;
    // Kill the probe's group, then reap its leader. Called only while the
    // leader is unreaped (see above).
    let end = |child: &mut std::process::Child| {
        // SAFETY: a plain syscall; `pid` is this probe's unreaped leader, so
        // the group of that id is the one `spawn` created.
        unsafe { libc::killpg(pid, libc::SIGKILL) };
        child.wait().ok()
    };
    let Some(stdout) = child.stdout.take() else {
        end(&mut child);
        return None;
    };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = tx.send(stdout.take(VERSION_READ_CAP).read_to_string(&mut out).ok().map(|_| out));
    });
    let exited = match wait_until(deadline, || leader_wait(pid)) {
        LeaderWait::Exited => true,
        LeaderWait::Running | LeaderWait::Interrupted => false,
        // Reaped by someone else (ECHILD): its pid, and so its group id,
        // may already be another process's. Nothing is signalled.
        LeaderWait::ReapedElsewhere => {
            eprintln!("projects: version probe {pid}: its leader was reaped elsewhere; its group is not signalled");
            return None;
        }
        // The kernel would not say. The leader is still this probe's own
        // unreaped child, so it alone is ended by its pid; the group is not
        // signalled on a guess (review P2-3).
        LeaderWait::Failed(errno) => {
            eprintln!("projects: version probe {pid}: waitid failed (errno {errno}); only the leader is ended");
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    // The leader stays unreaped while the read runs, so the group id stays
    // this probe's until `end` below.
    let out = if exited {
        rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).ok().flatten()
    } else {
        None
    };
    let status = end(&mut child);
    out.filter(|_| status.is_some_and(|s| s.success()))
}

/// What waiting on the probe's leader said (review P2-3 on 6111d25b: every
/// waitid failure used to read as "reaped elsewhere", EINTR included, which
/// skipped the group cleanup).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, PartialEq)]
enum LeaderWait {
    Exited,
    Running,
    /// EINTR: ask again.
    Interrupted,
    /// ECHILD: it is no longer our child to wait for, so its pid may be reused.
    ReapedElsewhere,
    /// Any other failure, with its errno: the leader's state is unknown.
    Failed(i32),
}

/// Has the leader `pid` exited? Asked WITHOUT reaping it (`WNOWAIT`), so its
/// pid stays held and its group id stays this probe's.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn leader_wait(pid: libc::pid_t) -> LeaderWait {
    // SAFETY: `info` is a zeroed out-parameter the call fills; si_pid is read
    // after it, as waitid(2) says to tell "exited" from "nothing yet" under
    // WNOHANG.
    let (r, errno, si_pid) = unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        let r = libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT);
        (r, std::io::Error::last_os_error().raw_os_error().unwrap_or(0), info.si_pid())
    };
    classify_wait(r, errno, si_pid, pid)
}

/// Ask `wait` until it says something final or `deadline` passes: a
/// leader still running is asked again after 20 ms, an interrupted wait at
/// once, and BOTH only while the deadline holds (review P2 on 4cd26dc9: a
/// steady stream of EINTR must not outlast the probe's one total limit).
/// Returns the last answer: `Running` or `Interrupted` means out of time.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn wait_until(deadline: std::time::Instant, mut wait: impl FnMut() -> LeaderWait) -> LeaderWait {
    loop {
        let answer = wait();
        let in_time = std::time::Instant::now() < deadline;
        match answer {
            LeaderWait::Running if in_time => std::thread::sleep(std::time::Duration::from_millis(20)),
            LeaderWait::Interrupted if in_time => {}
            done => return done,
        }
    }
}

/// `leader_wait`'s reading of one waitid answer. Pure.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn classify_wait(r: i32, errno: i32, si_pid: i32, pid: i32) -> LeaderWait {
    match (r, errno) {
        (0, _) if si_pid == pid => LeaderWait::Exited,
        (0, _) => LeaderWait::Running,
        (_, libc::EINTR) => LeaderWait::Interrupted,
        (_, libc::ECHILD) => LeaderWait::ReapedElsewhere,
        (_, e) => LeaderWait::Failed(e),
    }
}

/// The drift guard (board #362 b): for each backend recovery has shapes for,
/// compare the installed CLI with the versions its shapes were measured on,
/// and when it is newer post ONE `[tmm]` line in the room of every live
/// project that runs a managed agent of that backend — once per room per
/// change of installed version (`meta` `recovery_drift:<backend>:<room>`
/// holds the last version told, set only on a successful post; a downgrade
/// back to an older version is a change and is said again), so neither a
/// gateway restart nor the daily check repeats it, and a room missed once is
/// told at the next pass. Nothing else
/// follows: no auto-action, no retry loop. Fail-soft throughout.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn check_drift() {
    check_drift_with(&installed_version, &|project, backend| {
        let Ok(panes) = crate::tmux::list_panes(&project.session) else { return false };
        panes.iter().any(|p| {
            super::is_managed_in(Some(project.path.as_str()), &p.window_name)
                && super::agents::detect_pane(Some(project.path.as_str()), p).is_some_and(|a| a.backend == backend.name())
        })
    }, &|room, line| super::rooms::post(room, "tmm", line).is_ok());
}

/// `check_drift` with what it asks of the machine injected: the installed
/// version, whether a project runs a managed agent of a backend, and the post
/// into a room (true = posted). Returns how many rooms were told.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn check_drift_with(
    installed: &dyn Fn(crate::backends::Backend) -> Option<String>,
    runs: &dyn Fn(&super::Project, crate::backends::Backend) -> bool,
    post: &dyn Fn(&str, &str) -> bool,
) -> usize {
    let projects = match super::with_store(|s| s.list_projects(false)) {
        Ok(list) => list,
        Err(_) => return 0,
    };
    let mut total = 0;
    for backend in crate::backends::Backend::ALL {
        if backend.recovery_shapes().is_empty() {
            continue;
        }
        let Some(installed) = installed(backend) else { continue };
        let Some(warning) = drift_warning(backend, &installed) else { continue };
        let mut told = 0;
        for project in &projects {
            // Per ROOM (reviewer P1): the record is "this room was told this
            // version", set only when its post succeeded, so a room whose post
            // failed or whose panes could not be read, and a room that starts
            // running the backend later, are told at the next pass, and a
            // room already told is never told again. The room is the
            // project's stable identity (a session rename keeps it).
            let room = if project.room.is_empty() { format!("proj:{}", project.session) } else { project.room.clone() };
            let key = format!("recovery_drift:{}:{room}", backend.name());
            if super::with_store(|s| s.meta_get(&key)).ok().flatten().as_deref() == Some(installed.as_str()) {
                continue;
            }
            if !runs(project, backend) {
                continue;
            }
            if post(&room, &format!("[tmm] {warning}")) && super::with_store(|s| s.meta_set(&key, &installed)).is_ok() {
                told += 1;
            }
        }
        if told > 0 {
            eprintln!("projects: {warning} (told {told} project room(s))");
        }
        total += told;
    }
    total
}

/// At gateway start (after the first capture ticks have adopted the live
/// sessions) and then once a day.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub async fn drift_loop() {
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
        let _ = tokio::task::spawn_blocking(check_drift).await;
        tokio::time::sleep(std::time::Duration::from_secs(24 * 60 * 60)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The owner's real error, as kiro painted it (2026-08-21, wrapped by the
    /// pane; capture -J re-joins it, so the test keeps it on one line).
    const REAL: &str = "An unexpected error occurred during the response stream: CodewhispererChatResponseStream(ServiceError(ServiceError { source: InternalServerError(InternalServerError { message: \"Encountered unexpectedly high load when processing the request, please try again.\", reason: Some(ModelTemporarilyUnavailable), … }) })) (request_id: 30010907-33c4-483a-b024-2ed61321e233)";

    #[test]
    fn the_real_error_is_detected() {
        assert!(scan_tail("kiro", REAL));
        assert!(scan_tail("kiro", &format!("some output\n{REAL}\n\n╭───╮\n│ ❯ │\n╰───╯\n")));
    }

    /// The second shape, exactly as kiro painted it (2026-08-26): its own
    /// hard-wrapped lines, first sentence whole on the first line.
    const MODEL_ERR: &str = "The model you've selected is temporarily unavailable.\n  Please use '/model' to select a different model and try\n  again. (request_id: db05d310-a189-497d-a6f2-b53410863243)";

    /// The third shape, verbatim from the owner's stuck pane (#267:
    /// lingting:kiro, 55×38, kiro-cli 2.22.1 `--agent-engine v3`, captured
    /// with `capture-pane -p -J` as `check_once` reads it, 2026-09-28): the
    /// chat delivery above it, the blank lines are a single space, and the
    /// prompt furniture below.
    const HIGH_TRAFFIC_SCREEN: &str = "  › [tmm chat 2026-09-28 13:55] human: @kiro\n    你现在什么阶段 在处理数据吗还是在训练了\n \n● Claude Opus 5.5 is experiencing high traffic. Try\n  again, or select another model. (Request ID:\n  ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146)\n \n▸ Credits: 121.98 • Time: 129m 30s\n\n ◐ 7 tasks remaining · ctrl+x expand\n───────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit\n to exit\n───────────────────────────────────────────────────────\nkiro · Claude Opus 5.5 · high · ◑ 35% · Midway: 10h 53m\n/local/home/cfu/work/projects/lingting · (main)\n\n›  ask a question or describe a task ↵\n              /sessions to resume · /copy to clipboard\n";

    /// The head glyphs a high-traffic block has been painted under: `●` on
    /// kiro-cli 2.22.1, `•` on 2.28.0 (#361). Spelled out here, not read from
    /// `HEAD_GLYPHS`, so dropping one from the const fails the tests instead
    /// of silently shrinking what they loop over.
    const HEADS: [char; 2] = ['●', '•'];

    /// #361, kiro-cli 2.28.0 — three REAL blocks, verbatim from this host's
    /// pane scrollbacks on 2026-10-14, read with `capture-pane -p -J` exactly
    /// as `check_once` reads a pane (a blank line is a single space; 49 of 49
    /// blocks found there open with `•`). A wide pane (80 columns): the
    /// sentence wraps once, and the `•` in the credits line below is not a head.
    const KIRO_228_WIDE: &str = "\n• claude-fable-5.1 is experiencing high traffic. Try again, or select another\n  model. (Request ID: b9b4f1e3-b712-42d8-8fa7-c85cafbd6085)\n \n▸ Credits: turn 4.58 • session 1474.07 | Time: 34s\n────────────────────────────────────────────────────────────────────────────────\n  › [tmm chat 2026-10-12 16:06] orchestrator: @reviewer @validator #352 tip\n";
    /// A narrow pane (52 columns): the sentence wraps twice and the id sits
    /// alone on the last line.
    const KIRO_228_NARROW: &str = " \n• claude-fable-5.1 is experiencing high traffic. Try\n  again, or select another model. (Request ID:\n  3b94a118-d7bb-4c58-b1a7-d64e408bc98b)\n \n▸ Time: 9s\n────────────────────────────────────────────────────\n";
    /// Another model, with the whole prompt furniture and status line below.
    const KIRO_228_OPUS: &str = " \n• claude-opus-5.5 is experiencing high traffic. Try again, or select another\n  model. (Request ID: 9e61a315-74f8-4e7b-9e7b-1761efc0845b)\n \n▸ Time: 36s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nengineer · claude-opus-5.5 · high · ◔ 24% · Midway: 3h 32m\n/local/home/cfu/work/projects/lingting · (main)\n\n";

    /// Board #280: Claude Code 2.1.284's real paint, captured from a scratch
    /// claude against a local endpoint answering 503, at 100 and 57 columns.
    const CLAUDE_503_WIDE: &str = "❯ say hi\n\n● API Error: 503 Bedrock is unable to process your request. This is a server-side issue,\n  usually temporary — try again in a moment. If it persists, check your Amazon Bedrock\n  service status.\n\n✻ Crunched for 0s · done 11:52 AM\n\n\n\n────────────────────────────────────────────────────────────────────────────────────────────────────\n❯\n────────────────────────────────────────────────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n";
    const CLAUDE_503_NARROW: &str = "❯ again\n\n● API Error: 503 Bedrock is unable to process\n  your request. This is a server-side issue,\n  usually temporary — try again in a moment. If\n  it persists, check your Amazon Bedrock service\n  status.\n\n✻ Worked for 0s · done 11:52 AM\n\n─────────────────────────────────────────────────────────\n❯\n─────────────────────────────────────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← fo…\n";

    #[test]
    fn claude_codes_bedrock_503_is_detected() {
        assert!(scan_tail("claude", CLAUDE_503_WIDE), "100 columns");
        assert!(scan_tail("claude", CLAUDE_503_NARROW), "57 columns");
        assert_eq!(error_signature("claude", CLAUDE_503_NARROW).as_deref(), Some("1|"), "no request id: the hit count is the signature");
        assert!(scan_tail("claude", "● API Error: 500 Bedrock is unable to process your request. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your Amazon Bedrock service status.\n"),
            "any 5xx with the same text");
    }

    /// The same text QUOTED, reworded or cut is not having the error: a
    /// false hit types `continue` into a working claude.
    #[test]
    fn quoting_claude_codes_503_is_not_having_it() {
        let paint = "● API Error: 503 Bedrock is unable to process your request. This is a server-side issue,\n  usually temporary — try again in a moment. If it persists, check your Amazon Bedrock\n  service status.";
        // The owner's own board issue, typed into an agent's pane as a chat line.
        assert!(!scan_tail("claude", &format!("[tmm chat 2026-09-29 11:28] human: [board #280] {paint}\n")), "quoted under a stamp");
        assert!(!scan_tail("claude", &format!("● Bash(tmm board show 280)\n  ⎿ {paint}\n")), "tool output under a bullet head");
        let text = "Bedrock is unable to process your request. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your Amazon Bedrock service status.";
        for (bad, why) in [
            (format!("● API Error: 429 {text}"), "not a 5xx"),
            (format!("● API Error: 5030 {text}"), "not a status code"),
            (format!("● The pane showed API Error: 503 {text}"), "prose about it"),
            (format!("● API Error: 503 {text} I will retry."), "text after it"),
            ("● API Error: 503 Bedrock is unable to process your request.".to_string(), "cut short"),
            (format!("● API Error: 503 {}", text.replace("usually temporary — try again", "try again")), "no transient words"),
        ] {
            assert!(!scan_tail("claude", &format!("{bad}\n")), "{why}: {bad}");
        }
    }

    /// A shape belongs to its backend (validator / orchestrator 12:08): the
    /// claude block in a kiro pane, and kiro's three in a claude pane, are
    /// never hits; an unmeasured backend has no shape at all.
    #[test]
    fn an_error_shape_matches_only_its_own_backend() {
        assert!(scan_tail("claude", CLAUDE_503_NARROW));
        assert!(!scan_tail("kiro", CLAUDE_503_NARROW), "kiro paints ● too: the claude block is not kiro's");
        assert!(scan_tail("kiro", HIGH_TRAFFIC_SCREEN));
        assert!(!scan_tail("claude", HIGH_TRAFFIC_SCREEN), "kiro's high traffic is not claude's");
        for b in ["codex", "grok", "omp", "kimi", ""] {
            assert!(!scan_tail(b, CLAUDE_503_NARROW) && !scan_tail(b, HIGH_TRAFFIC_SCREEN), "{b}: no measured shape");
        }
    }

    /// Board #280, end to end on real managed panes: a CLAUDE pane showing
    /// the 503 gets ONE `continue` over two ticks; a claude pane that only
    /// QUOTES it and a managed KIRO pane painting the very same block get
    /// nothing. Cleanup is a `tmux::Scratch` taken before anything exists.
    #[test]
    fn a_managed_claude_pane_showing_the_503_gets_one_continue() {
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-claude");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        for (name, backend) in [("cl", "claude"), ("quoted", "claude"), ("ki", "kiro")] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": backend, "cmd": backend, "team": "" }).to_string()).unwrap();
        }
        let paint = ws.join("paint.txt");
        std::fs::write(&paint, CLAUDE_503_NARROW).unwrap();
        let quoted = ws.join("quoted.txt");
        std::fs::write(&quoted, "[tmm chat 2026-09-29 11:28] human: [board #280] ● API Error: 503 Bedrock is unable to process your request. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your Amazon Bedrock service status.\n").unwrap();
        // The pane prints the capture, then reads its input (what `continue` lands in).
        let show = |f: &std::path::Path| format!("cat {}; cat", f.display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "57", "-y", "36", "-s", &session, "-n", "cl", "-c", &ws.to_string_lossy(), &show(&paint)])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        for (name, file) in [("quoted", &quoted), ("ki", &paint)] {
            std::process::Command::new("tmux").args(["new-window", "-d", "-t", &session, "-n", name, "-c", &ws.to_string_lossy(), &show(file)]).status().unwrap();
        }
        super::super::adopt(&session, Some("rec-claude-test")).expect("adopt");
        std::thread::sleep(std::time::Duration::from_millis(300));
        check_once();
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let pane = |w: &str| crate::tmux::capture_pane_plain(&format!("{session}:{w}"), Some(0)).unwrap_or_default();
        let (cl, q, ki) = (pane("cl"), pane("quoted"), pane("ki"));
        let notes: Vec<String> = super::super::telemetry::recent_events(&session, 0).into_iter().map(|e| e.text).filter(|t| t.starts_with("auto-continue")).collect();
        assert!(cl.contains("\ncontinue"), "the claude pane got the key: {cl:?}");
        assert!(!q.contains("\ncontinue"), "a quote gets nothing: {q:?}");
        assert!(!ki.contains("\ncontinue"), "a kiro pane painting claude's block gets nothing: {ki:?}");
        assert_eq!(notes, vec!["auto-continue 1/4 — Bedrock 5xx in cl".to_string()], "one send, one record, over two ticks");
    }

    /// Board #422 round 3 (validator, orchestrator 14:56): the auto-continue
    /// is AUTOMATED input and goes through the one send door. A restoring
    /// (ARMED) window painting a transient error gets no `continue`; a
    /// RELEASED one whose pane is respawned between the door's resolve and
    /// its write gets none either (the in-server guard refuses), nor does it
    /// once its identity no longer reads. A refusal spends nothing of the
    /// incident's budget: once the hold is gone, the very next tick types
    /// the FIRST attempt (a spent attempt would wait out its 30 s backoff).
    #[test]
    fn a_restoring_window_painting_a_transient_error_gets_no_continue_and_keeps_its_budget() {
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-hold");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/cl");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "claude", "cmd": "claude", "team": "" }).to_string()).unwrap();
        let paint = ws.join("paint.txt");
        std::fs::write(&paint, CLAUDE_503_NARROW).unwrap();
        let show = format!("cat {}; cat", paint.display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "57", "-y", "36", "-s", &session, "-n", "cl", "-c", &ws.to_string_lossy(), &show])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-hold-test")).expect("adopt");
        let id = super::super::project_for_session(&session).unwrap().unwrap().id;
        let socket = super::super::restore::socket_key();
        let identity = || -> super::super::store::HoldPane {
            let f: Vec<String> = crate::tmux::run_tmux(&["display-message", "-p", "-t", &format!("={session}:cl"), "#{pane_id}\t#{pane_pid}\t#{window_id}\t#{session_id}\t#{pid}\t#{start_time}"])
                .unwrap().trim().split('\t').map(str::to_string).collect();
            super::super::store::HoldPane {
                instance: super::super::store::TmuxInstance { socket: socket.clone(), pid: f[4].parse().unwrap(), start_time: f[5].parse().unwrap() },
                session_id: f[3].clone(),
                window_id: f[2].clone(),
                pane_id: f[0].clone(),
                pane_pid: f[1].parse().unwrap(),
            }
        };
        let pane = identity().pane_id;
        let hold = super::super::store::Hold {
            socket: socket.clone(),
            project_id: id.clone(),
            batch: "b-rec".into(),
            ord: 0,
            slot: "cl".into(),
            launch: uuid::Uuid::new_v4().to_string(),
            stage: super::super::store::HoldStage::Armed,
            pane: Some(identity()),
            since: 1,
            accepted_seq: None,
            not_ready: false,
            reported: false,
            merging: false,
        };
        let batch = super::super::store::Batch {
            batch: "b-rec".into(),
            socket: format!("{socket}-unrelated"),
            boot_id: None,
            owner_pid: 0, attempt: 0,
            instance: None,
            source: super::super::store::Checkpoint { gen: 0, at: 0, boot_id: None, tmux: None, projects: vec![] },
            closed: None,
            projects: vec![],
        };
        super::super::restore_hold::with_store_for_test(|s| s.open_batch(&batch, &[hold], "x")).unwrap();
        let current = || super::super::restore_hold::with_store_for_test(|s| s.project_holds(&socket, &id)).unwrap().pop().unwrap();
        let screen = || crate::tmux::capture_pane_plain(&pane, Some(0)).unwrap_or_default();
        let notes = || -> Vec<String> { super::super::telemetry::recent_events(&session, 0).into_iter().map(|e| e.text).filter(|t| t.starts_with("auto-continue")).collect() };
        std::thread::sleep(std::time::Duration::from_millis(300));
        // ARMED: the door refuses, twice over two ticks.
        check_once();
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!screen().contains("\ncontinue"), "a restoring window gets nothing: {:?}", screen());
        assert!(notes().is_empty(), "{:?}", notes());
        // RELEASED, respawned between the door's resolve and its write.
        let armed = current();
        assert!(super::super::restore_hold::with_store_for_test(|s| s.install_hold(&armed, &uuid::Uuid::new_v4().to_string(), super::super::store::HoldStage::Released, armed.pane.as_ref().unwrap(), 1)).unwrap());
        let (p2, cmd) = (pane.clone(), show.clone());
        crate::tmux::BEFORE_GUARDED_WRITE.with(|h| {
            *h.borrow_mut() = Some(Box::new(move || {
                crate::tmux::run_tmux(&["respawn-pane", "-k", "-t", &p2, &cmd]).unwrap();
            }))
        });
        check_once();
        assert!(crate::tmux::BEFORE_GUARDED_WRITE.with(|h| h.borrow().is_none()), "the write was guarded");
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!screen().contains("\ncontinue"), "the respawned process got neither the text nor the Enter: {:?}", screen());
        // Its identity no longer reads (same %id, another process): refused.
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!screen().contains("\ncontinue"), "{:?}", screen());
        assert!(notes().is_empty(), "{:?}", notes());
        // No hold: the ordinary path, with the whole budget intact.
        let gone = current().launch;
        assert!(super::super::restore_hold::with_store_for_test(|s| s.retire_hold_if(&gone)).unwrap());
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(screen().contains("\ncontinue"), "the window is ordinary again: {:?}", screen());
        assert_eq!(notes(), vec!["auto-continue 1/4 — Bedrock 5xx in cl".to_string()], "the refusals spent nothing");
    }

    /// The take-back itself (board #422 round 3): a refused send restores the
    /// incident's attempts, timing and ladder start exactly — and a mark
    /// taken for another signature marks a fresh incident.
    #[test]
    fn undo_send_takes_back_exactly_what_the_refused_send_spent() {
        let mut t = Tracker::default();
        let never = |_| false;
        let m0 = t.send_mark("s", "w", "a");
        assert_eq!(t.decide("s", "w", 100, "a", never), Decision::Send { attempt: 1 });
        t.undo_send("s", "w", m0, 100);
        assert_eq!(t.decide("s", "w", 100, "a", never), Decision::Send { attempt: 1 }, "no backoff was started");
        assert_eq!(t.starts[&("s".to_string(), "w".to_string())], vec![100], "one ladder start, not two");
        let m1 = t.send_mark("s", "w", "a");
        assert_eq!(t.decide("s", "w", 200, "a", never), Decision::Send { attempt: 2 });
        t.undo_send("s", "w", m1, 200);
        assert_eq!(t.decide("s", "w", 129, "a", never), Decision::Wait, "the first attempt's backoff stands");
        assert_eq!(t.decide("s", "w", 200, "a", never), Decision::Send { attempt: 2 });
        // Another error instance: decide replaces the record, the mark is fresh.
        let m2 = t.send_mark("s", "w", "b");
        assert_eq!(t.decide("s", "w", 300, "b", never), Decision::Send { attempt: 1 });
        t.undo_send("s", "w", m2, 300);
        assert_eq!(t.decide("s", "w", 300, "b", never), Decision::Send { attempt: 1 }, "not the old incident's 2 attempts");
    }

    /// Board #362 c, end to end on real managed panes painting the real
    /// captures: a codex pane whose newest paint is the 401 and a kiro pane
    /// whose newest paint is the image refusal, both with a turn open (a
    /// prompt and no end, as measured), get their missed end ONCE over two
    /// ticks: idle with `auth_expired` / `conversation_blocked`, one `failed`
    /// row each, and NOTHING typed into either pane. A codex pane showing the
    /// same 401 above the next prompt (history) keeps its open turn.
    #[test]
    fn a_managed_pane_whose_newest_paint_needs_a_person_ends_its_turn_once_and_gets_nothing_typed() {
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-person");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let screens = [
            ("cx", "codex", CODEX_0154_401.to_string()),
            ("ki", "kiro", format!("{KIRO_228_IMAGE}{KIRO_228_IDLE}")),
            ("old", "codex", CODEX_0154_401_THEN_PROMPT.to_string()),
        ];
        for (name, backend, screen) in &screens {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": backend, "cmd": backend, "team": "" }).to_string()).unwrap();
            std::fs::write(ws.join(format!("{name}.txt")), screen).unwrap();
        }
        // The pane prints its capture, then reads its input (where a typed line would land).
        let show = |name: &str| format!("cat {}; cat", ws.join(format!("{name}.txt")).display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "cx", "-c", &ws.to_string_lossy(), &show("cx")])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        for name in ["ki", "old"] {
            std::process::Command::new("tmux").args(["new-window", "-d", "-t", &session, "-n", name, "-c", &ws.to_string_lossy(), &show(name)]).status().unwrap();
        }
        super::super::adopt(&session, Some("rec-person-test")).expect("adopt");
        for (name, _, _) in &screens {
            super::super::telemetry::record_prompt(&session, name, &format!("[tmm chat 2026-10-15 12:32] maker: @{name} go"));
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        let typed_before: Vec<String> = screens.iter().map(|(n, _, _)| crate::tmux::capture_pane_plain(&format!("{session}:{n}"), Some(0)).unwrap_or_default()).collect();
        check_once();
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let st = |w: &str| { let s = super::super::telemetry::derive(&session, w, 0); (s.state, s.detail) };
        assert_eq!(st("cx"), ("idle".to_string(), "auth_expired".to_string()));
        assert_eq!(st("ki"), ("idle".to_string(), "conversation_blocked".to_string()));
        assert_eq!(st("old"), ("running".to_string(), String::new()), "a 401 above the next prompt is history");
        let ends: Vec<(String, String)> = super::super::telemetry::recent_events(&session, 0).into_iter()
            .filter(|e| e.kind == "notif").map(|e| (e.window, e.tool)).collect();
        assert_eq!(ends, [("cx".to_string(), "auth_expired".to_string()), ("ki".to_string(), "conversation_blocked".to_string())], "one end each over two ticks");
        for ((name, _, _), before) in screens.iter().zip(&typed_before) {
            let now = crate::tmux::capture_pane_plain(&format!("{session}:{name}"), Some(0)).unwrap_or_default();
            assert_eq!(&now, before, "{name}: nothing typed");
        }
        assert!(super::super::telemetry::recent_events(&session, 0).iter().all(|e| !e.text.starts_with("auto-continue")), "never continued");
    }

    /// Board #362, the builder's 02:30 finding (the orchestrator's ruling,
    /// cases A-E), through the PRODUCTION path: real managed panes painting
    /// real kiro and claude captures, the window's cap reached, `check_once`
    /// deciding Capped and committing. A capped incident sent nothing, so
    /// its error is attributed by the screen (the newest block by the
    /// backend's own grammar) and the hooks (nothing landed since it was
    /// first seen so).
    /// D: the error is the newest block on an open turn: one end, once.
    /// A: a new prompt B with the screen unchanged (no repaint): B runs, no
    ///    second end (the attribution rule, with the once flag under it).
    /// B: a newer prompt already painted under the error (the turn running,
    ///    as kiro 2.31.0 paints it): no end. B': a later turn's work painted
    ///    under it and that turn ended by its hook: its end keeps its own
    ///    detail (the newest block must be the error's own shape). B'': the
    ///    newest block is the agent's reply QUOTING the error with a chat
    ///    stamp: not the agent having it, no detail on its end.
    /// E: no measured grammar (claude) or a half-drawn kiro screen: no end;
    ///    the paused row is still said. D again: a later independent
    ///    incident on a new turn is its own.
    #[test]
    fn a_capped_incident_ends_a_turn_only_while_its_error_is_attributable() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-capped");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        // kiro-cli 2.31.0's busy footer, measured on this host (2026-10-16).
        let busy = "›  Kiro is working · 0s · Type to steer · Ctrl+S to queue";
        let painted_after = HIGH_TRAFFIC_SCREEN.replace("\n \n▸ Credits", &format!("\n \n{KIRO_228_SUBMITTED}{KIRO_228_RULE}▸ Credits"))
            .replace("›  ask a question or describe a task ↵", busy);
        let half = HIGH_TRAFFIC_SCREEN.split("›  ask").next().unwrap().to_string();
        // A later turn's work painted under the error (the real blocks of
        // video-factory:checker's next turn), its turn ended by its hook: the
        // newest block is not the error.
        let later = HIGH_TRAFFIC_SCREEN.replace("\n \n▸ Credits", &format!("\n \n{}\n▸ Credits", KIRO_228_LATER.trim_end()));
        // The agent's own reply as the newest block, opening with the stream
        // error's header and quoting a chat stamp (the owner pasted the error
        // into the chat): the stream-error shape is matched by its header, so
        // only the quote exclusion says this block is not the agent having it.
        let quoted = HIGH_TRAFFIC_SCREEN.replace("\n \n▸ Credits", "\n \n• An unexpected error occurred during the response stream (ModelTemporarilyUnavailable),\n  as [tmm chat 2026-10-16 02:50] human: @kq pasted it\n▸ Credits");
        let screens = [
            ("ki", "kiro", HIGH_TRAFFIC_SCREEN.to_string()),
            ("kp", "kiro", painted_after),
            ("kh", "kiro", half),
            ("cl", "claude", CLAUDE_503_NARROW.to_string()),
            ("kr", "kiro", later),
            ("kq", "kiro", quoted),
        ];
        for (name, backend, screen) in &screens {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": backend, "cmd": backend, "team": "" }).to_string()).unwrap();
            std::fs::write(ws.join(format!("{name}.txt")), screen).unwrap();
        }
        let show = |name: &str| format!("cat {}; cat", ws.join(format!("{name}.txt")).display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "ki", "-c", &ws.to_string_lossy(), &show("ki")])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        for name in ["kp", "kh", "cl", "kr", "kq"] {
            std::process::Command::new("tmux").args(["new-window", "-d", "-t", &session, "-n", name, "-c", &ws.to_string_lossy(), &show(name)]).status().unwrap();
        }
        super::super::adopt(&session, Some("rec-capped-test")).expect("adopt");
        // Each window has an open turn and its cap reached (three ladders).
        for (name, _, _) in &screens {
            tm::record_prompt(&session, name, &format!("[tmm chat 2026-10-16 02:40] lead: @{name} A"));
            for sig in ["0|a", "0|b", "0|c"] {
                assert!(matches!(tracker().lock().unwrap().decide(&session, name, now_secs(), sig, |_| false), Decision::Send { .. }));
            }
        }
        for w in ["kr", "kq"] {
            tm::record_notification_with(&session, w, "completed", crate::backends::EndQuality::Said);
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        let st = |w: &str| { let s = tm::derive(&session, w, 0); (s.state, s.detail) };
        let ends = |w: &str| tm::recent_events(&session, 0).into_iter().filter(|e| e.window == w && e.kind == "notif" && e.text == "failed").count();
        let paused = |w: &str| tm::recent_events(&session, 0).into_iter().filter(|e| e.window == w && e.text.starts_with("auto-continue paused")).count();
        check_once();
        // D: attributable, one end.
        assert_eq!(st("ki"), ("idle".to_string(), EXHAUSTED.to_string()), "D");
        assert_eq!(ends("ki"), 1, "D");
        // B: a newer prompt painted under the error: no end.
        assert_eq!(st("kp"), ("running".to_string(), String::new()), "B");
        assert_eq!(ends("kp"), 0, "B");
        // E: half-drawn, and no grammar: no end, the paused row still said.
        assert_eq!((st("kh").0.as_str(), ends("kh")), ("running", 0), "E half-drawn");
        assert_eq!((st("cl").0.as_str(), ends("cl")), ("running", 0), "E claude");
        // B': the newest block is a later turn's own work: its hook end keeps
        // its own (empty) detail, no end is written.
        assert_eq!(st("kr"), ("idle".to_string(), String::new()), "B': a later turn's end is not the error's");
        assert_eq!(ends("kr"), 0, "B'");
        // B'': the newest block QUOTES the error: not the agent having it.
        assert_eq!(st("kq"), ("idle".to_string(), String::new()), "B'': a quote is not the error's turn");
        assert_eq!(ends("kq"), 0, "B''");
        // The cap is said where a send could have gone (board #473): the
        // error as the newest block (ki) or an ungated shape (claude). A
        // gated kiro error under a newer prompt, a half-drawn screen, a later
        // turn's work or a quote is history: nothing is decided there, so no
        // "needs a person" either.
        for w in ["ki", "cl"] {
            assert_eq!(paused(w), 1, "{w}: the cap is still said");
        }
        for w in ["kp", "kh", "kr", "kq"] {
            assert_eq!(paused(w), 0, "{w}: an ineligible screen decides nothing");
        }
        // A: a new prompt to ki, the screen unchanged (a cat pane never repaints).
        tm::record_prompt(&session, "ki", "[tmm chat 2026-10-16 02:41] human: @ki B");
        tm::record_held(&session, "ki", "[tmm chat 2026-10-16 02:41] lead: @ki held for B", 0, "m1").unwrap();
        check_once();
        check_once();
        assert_eq!(st("ki"), ("running".to_string(), String::new()), "A: B runs");
        assert_eq!(ends("ki"), 1, "A: no second end");
        assert_eq!(tm::held_rows(&session, "ki").len(), 1, "A: B's held line stays held");
        // D again: a later independent incident (a new Request ID) on a new turn.
        tm::record_prompt(&session, "ki", "[tmm chat 2026-10-16 02:42] human: @ki C");
        std::fs::write(ws.join("ki2.txt"), HIGH_TRAFFIC_SCREEN.replace("ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146", "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9")).unwrap();
        std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:ki"), &format!("cat {}; cat", ws.join("ki2.txt").display())]).status().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        // The moved version settles over one tick first (board #473,
        // `Tracker::bind`): a new failure is read on the second.
        check_once();
        assert_eq!(ends("ki"), 1, "settling: nothing decided yet");
        check_once();
        assert_eq!(st("ki"), ("idle".to_string(), EXHAUSTED.to_string()), "D again: its own end");
        assert_eq!(ends("ki"), 2);
        for w in ["ki", "kp", "kh", "cl", "kr", "kq"] {
            tracker().lock().unwrap().retain_windows(&session, &[w.to_string()]);
        }
    }

    /// Board #362, case C, through the commit the capture tick makes: a turn
    /// fact lands between the capture and the commit. The observation is
    /// Stale and nothing is spent; and as that fact came after the error was
    /// first seen as the newest block, the incident is never attributed
    /// again (the fact may be an unrepainted prompt).
    #[test]
    fn a_capped_incident_overtaken_during_its_capture_is_never_attributed() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let session = format!("capc-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 02:40] lead: @w A");
        let decide = |sig: &str| tracker().lock().unwrap().decide(&session, "w", now_secs(), sig, |_| false);
        for sig in ["0|a", "0|b", "0|c"] {
            assert!(matches!(decide(sig), Decision::Send { .. }));
        }
        assert!(matches!(decide("1|x"), Decision::Capped { .. }));
        let seen = tm::turn_version(&session, "w");
        tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 02:41] human: @w B");
        assert!(!commit_exhausted(&session, "w", true, true, seen), "stale");
        assert!(tracker().lock().unwrap().exhausted_new(&session, "w"), "nothing spent");
        assert!(matches!(decide("1|x"), Decision::Capped { first: false }));
        assert!(!commit_exhausted(&session, "w", true, true, tm::turn_version(&session, "w")), "a fact since the first sighting");
        assert_eq!(tm::derive(&session, "w", 0).state, "running");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    #[test]
    fn the_high_traffic_error_is_detected() {
        assert_eq!(
            error_signature("kiro", HIGH_TRAFFIC_SCREEN),
            Some("1|ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146".into()),
            "the v3 high-traffic paint is an incident, identified by its Request ID"
        );
        for head in HEADS {
            // Another model, and a narrow pane that wraps inside the name.
            assert!(scan_tail("kiro", &format!("{head} Claude Sonnet 4.6 is\n  experiencing high traffic. Try again, or select\n  another model. (Request ID: 0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9)\n")), "{head}");
            // Unwrapped, as a wide pane paints it.
            assert!(scan_tail("kiro", &format!("{head} Auto is experiencing high traffic. Try again, or select another model. (Request ID: deadbeef-0001-4abc-8def-0123456789ab)\n")), "{head}");
        }
    }

    /// #361: kiro-cli 2.28 paints the error under `•`; the detector wanted
    /// `●` and auto-recovery sat silent while 49 blocks went by. The three
    /// screens are the real paints (see the consts), as `check_once` sees them.
    #[test]
    fn kiro_2_28_high_traffic_blocks_as_painted_are_detected() {
        for (name, screen, id) in [
            ("wide, claude-fable-5.1", KIRO_228_WIDE, "b9b4f1e3-b712-42d8-8fa7-c85cafbd6085"),
            ("narrow, claude-fable-5.1", KIRO_228_NARROW, "3b94a118-d7bb-4c58-b1a7-d64e408bc98b"),
            ("wide + status line, claude-opus-5.5", KIRO_228_OPUS, "9e61a315-74f8-4e7b-9e7b-1761efc0845b"),
        ] {
            assert!(scan_tail("kiro", screen), "{name}");
            // Identified by its Request ID, and hits=1: the credits line's
            // own `•` and the rest of the chrome add no second block.
            assert_eq!(error_signature("kiro", screen), Some(format!("1|{id}")), "{name}");
        }
        // The same screen under the 2.22.1 head is the same incident.
        assert_eq!(error_signature("kiro", &KIRO_228_NARROW.replace('•', "●")), error_signature("kiro", KIRO_228_NARROW));
        // A second error (a new Request ID) is a new incident, whichever head.
        assert_ne!(error_signature("kiro", KIRO_228_WIDE), error_signature("kiro", KIRO_228_NARROW));
    }

    /// Every negative holds for BOTH head glyphs (#361): the closed set grows
    /// what is accepted at the head and nothing else.
    #[test]
    fn quoting_the_high_traffic_error_is_not_having_it() {
        let id = "ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146";
        for head in HEADS {
            let paint = format!("{head} Claude Opus 5.5 is experiencing high traffic. Try\n  again, or select another model. (Request ID:\n  {id})");
            // A chat delivery quoting it: indented under the `›` stamp line.
            let chat = format!("  › [tmm chat 2026-09-28 14:37] human: @orchestrator 有报这个错误\n{}\n", paint.lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"));
            assert!(!scan_tail("kiro", &chat), "{head}: a stamped quote must not trigger");
            // The same with the stamp on the pane's column zero (v2 paint).
            assert!(!scan_tail("kiro", &format!("[tmm chat 2026-09-28 14:37] human: @kiro {}", paint.replace('\n', " "))), "{head}");
            // Tool output reading it (board show, capture-pane): under a Shell head.
            let tool = format!("{head} Shell tmm board show 267\n    ╰ output:\n{}\n", paint.lines().map(|l| format!("        {l}")).collect::<Vec<_>>().join("\n"));
            assert!(!scan_tail("kiro", &tool), "{head}: tool output must not trigger");
            // The agent's own prose about it: words around the sentence.
            assert!(!scan_tail("kiro", &format!("{head} The pane shows Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: {id})\n")),
                "{head}: a long lead-in is not a model name");
            assert!(!scan_tail("kiro", &format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: {id}) — I will retry.\n")),
                "{head}: text after the id is prose");
            assert!(!scan_tail("kiro", &format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model.\n")),
                "{head}: without its Request ID the sentence is a mention");
            // Validator 15:04: letters right, punctuation wrong — each is prose,
            // not kiro's paint, and each used to hit.
            for (text, why) in [
                (format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: {id}"), "no closing paren"),
                (format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. Request ID {id}"), "no parenthesis or colon"),
                (format!("{head} Claude Opus 5.5 is experiencing high traffic Try again or select another model (Request ID: {id})"), "no period or comma"),
                (format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID {id})"), "no colon"),
                (format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: {id}))"), "extra text after the close"),
                (format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: ef8dd12f)"), "not a uuid"),
                (format!("{head} Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: {}x)", &id[..35]), "non-hex in the uuid"),
            ] {
                assert!(!scan_tail("kiro", &format!("{text}\n")), "{head}: {why}");
            }
        }
    }

    /// #361, validator-facing: the closed set is a SET. Any other head — a
    /// quote marker, kiro's own stamp, a different bullet, no head at all, or
    /// the glyph glued to the name — is not a high-traffic paint.
    #[test]
    fn only_the_two_measured_head_glyphs_open_a_high_traffic_block() {
        let tail = "Claude Opus 5.5 is experiencing high traffic. Try again, or select another model. (Request ID: ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146)";
        for head in HEADS {
            assert!(scan_tail("kiro", &format!("{head} {tail}\n")), "{head} is accepted");
        }
        for head in ['›', '▸', '○', '◦', '◆', '◇', '·', '▪', '■', '◉', '⏺', '-', '>', '*', '#', '+'] {
            assert!(!scan_tail("kiro", &format!("{head} {tail}\n")), "{head:?} is not a head kiro paints its errors under");
        }
        assert!(!scan_tail("kiro", &format!("{tail}\n")), "no head");
        for head in HEADS {
            assert!(!scan_tail("kiro", &format!("{head}{tail}\n")), "{head}: glued to the name");
            assert!(!scan_tail("kiro", &format!(" {head} {tail}\n")), "{head}: indented is a continuation, never a head");
            assert!(!scan_tail("kiro", &format!("{head}  {head} {tail}\n")), "{head}: a second head is not a name");
        }
    }

    /// #370, kiro-cli 2.28.0 — the RATE-LIMIT block, FOUR real instances verbatim
    /// from this host's pane scrollbacks on 2026-10-14, read with
    /// `capture-pane -p -J` exactly as `check_once` reads a pane (each pane's
    /// binary was asked: `kiro-cli-chat 2.28.0`; the installed 2.31.0 came
    /// later and has no sample): the blank line above, the `•` head, the
    /// sentence wrapped after `(Request ID:`, the id alone on a continuation
    /// line, a lone-space line, then the `▸` status line and the ruler. The
    /// last is the block that left this very agent idle for 8 minutes.
    const TMR_RESEARCHER: &str = "\n• Too many requests, please wait before trying again. (Request ID:\n  5b7cc714-59a6-4ada-83e8-b56977929ca8)\n \n▸ Credits: turn 5.76 • session 667.51 | Time: 1m 1s\n────────────────────────────────────────────────────────────────────────────────\n";
    const TMR_WRITER_SHORT: &str = " \n• Too many requests, please wait before trying again. (Request ID:\n  7ecb7a2a-c58c-4cc5-892f-584b74ad361b)\n \n▸ Time: 7s\n────────────────────────────────────────────────────────────────────────────────\n";
    const TMR_WRITER_CREDITS: &str = "\n• Too many requests, please wait before trying again. (Request ID:\n  538e07dc-427f-49c9-a911-c353c740c58a)\n \n▸ Credits: turn 7.85 • session 841.56 | Time: 29s\n────────────────────────────────────────────────────────────────────────────────\n";
    const TMR_BUILDER: &str = "\n• Too many requests, please wait before trying again. (Request ID:\n  319ae15c-f2d3-4ada-bafc-9b9b20927ea8)\n \n▸ Credits: turn 31.76 • session 597.47 | Time: 8m 37s\n────────────────────────────────────────────────────────────────────────────────\n";
    /// The same error in a NARROWER pane (the orchestrator's capture of the
    /// builder's pane, as filed on #370): the sentence wraps twice.
    const TMR_NARROW: &str = "• Too many requests, please wait before trying\n  again. (Request ID:\n  319ae15c-f2d3-4ada-bafc-9b9b20927ea8)\n";

    #[test]
    fn kiro_2_28_rate_limit_blocks_as_painted_are_detected() {
        for (name, screen, id) in [
            ("researcher, Credits + Time", TMR_RESEARCHER, "5b7cc714-59a6-4ada-83e8-b56977929ca8"),
            ("writer, Time only", TMR_WRITER_SHORT, "7ecb7a2a-c58c-4cc5-892f-584b74ad361b"),
            ("writer, Credits + Time", TMR_WRITER_CREDITS, "538e07dc-427f-49c9-a911-c353c740c58a"),
            ("builder, the 8-minute stall", TMR_BUILDER, "319ae15c-f2d3-4ada-bafc-9b9b20927ea8"),
            ("narrow pane, wrapped twice", TMR_NARROW, "319ae15c-f2d3-4ada-bafc-9b9b20927ea8"),
        ] {
            assert!(scan_tail("kiro", screen), "{name}");
            // Identified by its Request ID, hits=1: the `•` inside the credits
            // line and the `▸` status line are not heads of a second block.
            assert_eq!(error_signature("kiro", screen), Some(format!("1|{id}")), "{name}");
        }
        // The same screen under the other measured head is the same incident.
        assert_eq!(error_signature("kiro", &TMR_BUILDER.replace('•', "●")), error_signature("kiro", TMR_BUILDER));
        // Two different errors are two incidents: a new Request ID re-arms.
        assert_ne!(error_signature("kiro", TMR_RESEARCHER), error_signature("kiro", TMR_WRITER_SHORT));
        // A rate limit is kiro's: no other backend's reader takes it, and it
        // is not the high-traffic shape either (different sentence, no model).
        assert!(!scan_tail("claude", TMR_BUILDER), "kiro's rate limit is not claude's");
        for b in ["codex", "grok", "omp", "kimi"] {
            assert!(!scan_tail(b, TMR_BUILDER), "{b}: no measured shape");
        }
    }

    /// Every negative holds for BOTH head glyphs, exactly as for high traffic
    /// (#361): the sentence is the whole block, nothing quoted, nothing after.
    #[test]
    fn quoting_the_rate_limit_error_is_not_having_it() {
        let id = "319ae15c-f2d3-4ada-bafc-9b9b20927ea8";
        for head in HEADS {
            let paint = format!("{head} Too many requests, please wait before trying again. (Request ID:\n  {id})");
            let chat = format!("  › [tmm chat 2026-10-14 20:42] orchestrator: @builder look\n{}\n", paint.lines().map(|l| format!("    {l}")).collect::<Vec<_>>().join("\n"));
            assert!(!scan_tail("kiro", &chat), "{head}: a stamped quote must not trigger");
            assert!(!scan_tail("kiro", &format!("[tmm chat 2026-10-14 20:42] orchestrator: @builder {}", paint.replace('\n', " "))), "{head}: a stamp on column zero");
            let tool = format!("{head} Shell tmux capture-pane -p -J -t 2\n    ╰ output:\n{}\n", paint.lines().map(|l| format!("        {l}")).collect::<Vec<_>>().join("\n"));
            assert!(!scan_tail("kiro", &tool), "{head}: tool output must not trigger");
            // The shell command that greps for it, painted under the tool head.
            assert!(!scan_tail("kiro", &format!("{head} Shell grep -c \"Too many requests, please wait before trying again. (Request ID: {id})\" log\n")), "{head}: a command line");
            for (text, why) in [
                (format!("{head} I saw: Too many requests, please wait before trying again. (Request ID: {id})"), "a lead-in"),
                (format!("{head} Too many requests, please wait before trying again. (Request ID: {id}) — retrying."), "text after the close"),
                (format!("{head} Too many requests, please wait before trying again."), "no Request ID: a mention"),
                (format!("{head} Too many requests, please wait before trying again. (Request ID: {id}"), "no closing paren"),
                (format!("{head} Too many requests, please wait before trying again. Request ID {id}"), "no parenthesis or colon"),
                (format!("{head} Too many requests please wait before trying again (Request ID: {id})"), "no comma or period"),
                (format!("{head} Too many requests, please wait before trying again. (Request ID {id})"), "no colon"),
                (format!("{head} Too many requests, please wait before trying again. (Request ID: {id}))"), "extra paren after the close"),
                (format!("{head} Too many requests, please wait before trying again. (Request ID: 319ae15c)"), "not a uuid"),
                (format!("{head} Too many requests, please wait before trying again. (Request ID: {}x)", &id[..35]), "non-hex in the uuid"),
                (format!("{head} too many requests, please wait before trying again. (Request ID: {id})"), "lower-case: not the sentence kiro paints"),
                (format!("{head} Too many requests; please wait before trying again. (Request ID: {id})"), "a semicolon for the comma"),
                (format!("{head} claude-opus-5.5 Too many requests, please wait before trying again. (Request ID: {id})"), "a model name before it: that is another sentence"),
            ] {
                assert!(!scan_tail("kiro", &format!("{text}\n")), "{head}: {why}");
            }
        }
    }

    /// #370: the closed set of head glyphs is `HEAD_GLYPHS`, the same two the
    /// high-traffic block takes (#361) — no head, another bullet, a glyph
    /// glued to the sentence or an indented one is not a rate-limit paint.
    #[test]
    fn only_the_two_measured_head_glyphs_open_a_rate_limit_block() {
        let tail = "Too many requests, please wait before trying again. (Request ID: 319ae15c-f2d3-4ada-bafc-9b9b20927ea8)";
        for head in HEADS {
            assert!(scan_tail("kiro", &format!("{head} {tail}\n")), "{head} is accepted");
        }
        for head in ['›', '▸', '○', '◦', '◆', '◇', '·', '▪', '■', '◉', '⏺', '-', '>', '*', '#', '+'] {
            assert!(!scan_tail("kiro", &format!("{head} {tail}\n")), "{head:?} is not a head kiro paints its errors under");
        }
        assert!(!scan_tail("kiro", &format!("{tail}\n")), "no head");
        for head in HEADS {
            assert!(!scan_tail("kiro", &format!("{head}{tail}\n")), "{head}: glued to the sentence");
            assert!(!scan_tail("kiro", &format!(" {head} {tail}\n")), "{head}: indented is a continuation, never a head");
            assert!(!scan_tail("kiro", &format!("{head}  {head} {tail}\n")), "{head}: a second head is not part of the sentence");
        }
    }

    /// #370: a rate-limit block whose head sits above the fold is an orphan
    /// that earns the one deep capture (the tail ends in `Request ID:`/uuid),
    /// and the deep rescan reads the head and hits — and the narrow block is
    /// only found inside the 40-line window until the deep one reaches it.
    #[test]
    fn a_rate_limit_block_whose_head_is_above_the_fold_is_read_on_the_deep_capture() {
        let headless: String = TMR_NARROW.lines().skip(1).map(|l| format!("{l}\n")).collect();
        assert!(headless.starts_with("  again. (Request ID:"), "{headless:?}");
        assert_eq!(error_signature("kiro", &headless), None, "an orphan tail is never a hit");
        assert!(headless_error_tail(&headless), "but it earns the deeper capture");
        let deep = format!("earlier output\n{TMR_NARROW}");
        assert_eq!(
            deep_error_signature("kiro", &deep),
            Some("1|319ae15c-f2d3-4ada-bafc-9b9b20927ea8".into()),
            "the recovered `•` head opens the block"
        );
        let buried = format!("{deep}{}", "newer line\n".repeat(60));
        assert_eq!(error_signature("kiro", &buried), None, "outside the 40-line window");
        assert_eq!(deep_error_signature("kiro", &buried), Some("1|319ae15c-f2d3-4ada-bafc-9b9b20927ea8".into()), "inside the deep window");
    }

    #[test]
    fn a_headless_high_traffic_tail_asks_for_the_deep_look() {
        let tail = "  again, or select another model. (Request ID:\n  ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146)\n \n▸ Credits: 1\n";
        assert_eq!(error_signature("kiro", tail), None);
        assert!(headless_error_tail(tail), "v3's `Request ID` earns the deeper capture like `request_id`");
        for head in HEADS {
            assert!(deep_error_signature("kiro", &format!("{head} Claude Opus 5.5 is experiencing high traffic. Try\n{tail}")).is_some(), "{head}");
        }
    }

    /// #361, the block grouping on the REAL 2.28 paint: the narrow block with
    /// its `•` head scrolled off the fold is an orphan that earns the one deep
    /// capture, and the deep rescan reads the head and hits.
    #[test]
    fn a_kiro_2_28_block_whose_head_is_above_the_fold_is_read_on_the_deep_capture() {
        let headless: String = KIRO_228_NARROW.lines().skip(2).map(|l| format!("{l}\n")).collect();
        assert!(headless.starts_with("  again, or select another model."), "{headless:?}");
        assert_eq!(error_signature("kiro", &headless), None, "an orphan tail is never a hit");
        assert!(headless_error_tail(&headless), "but it earns the deeper capture");
        let deep = format!("earlier output\n{KIRO_228_NARROW}");
        assert_eq!(
            deep_error_signature("kiro", &deep),
            Some("1|3b94a118-d7bb-4c58-b1a7-d64e408bc98b".into()),
            "the recovered `•` head opens the block"
        );
        // The block sits more than 40 lines above the bottom (filler AFTER it:
        // `signature_within` counts from the tail): the ordinary window no
        // longer sees it, the deep window still does.
        let buried = format!("{deep}{}", "newer line\n".repeat(60));
        assert_eq!(error_signature("kiro", &buried), None, "outside the 40-line window");
        assert_eq!(
            deep_error_signature("kiro", &buried),
            Some("1|3b94a118-d7bb-4c58-b1a7-d64e408bc98b".into()),
            "inside the deep window"
        );
    }

    #[test]
    fn the_model_unavailable_error_is_detected() {
        assert!(scan_tail("kiro", MODEL_ERR));
        assert!(scan_tail("kiro", &format!("some output\n{MODEL_ERR}\n\n╭───╮\n│ ❯ │\n╰───╯\n")));
        // capture -J re-joins a soft-wrapped paint into one logical line.
        assert!(scan_tail("kiro", &MODEL_ERR.replace('\n', " ")));
    }

    /// The SAME error as kiro paints it since ~2026-08-31 (board #24, the
    /// owner's copy verbatim): HARD-wrapped — header at column zero, every
    /// continuation line indented two spaces, real newlines that capture -J
    /// cannot rejoin. The old same-logical-line rule missed this shape
    /// entirely: the header and the transient markers never share a line.
    const REAL_WRAPPED: &str = "An unexpected error occurred during the response stream:\n  CodewhispererChatResponseStream(ServiceError(ServiceError\n  { source: InternalServerError(InternalServerError {\n  message: \"Encountered unexpectedly high load when\n  processing the request, please try again.\", reason:\n  Some(ModelTemporarilyUnavailable), meta: ErrorMetadata {\n  code: None, message: Some(\"Encountered unexpectedly high\n  load when processing the request, please try again.\"),\n  extras: None } }), raw: Decoded(Message { headers:\n  [Header { name: StrBytes { bytes: b\":exception-type\" },\n  value: String(StrBytes { bytes: b\"error\" }) }, Header {\n  name: StrBytes { bytes: b\":content-type\" }, value:\n  String(StrBytes { bytes: b\"application/json\" }) }, Header\n  { name: StrBytes { bytes: b\":message-type\" }, value:\n  String(StrBytes { bytes: b\"exception\" }) }], payload:\n  b\"{\\\"message\\\":\\\"Encountered unexpectedly high load when\n  processing the request, please try\n  again.\\\",\\\"reason\\\":\\\"MODEL_TEMPORARILY_UNAVAILABLE\\\"}\"\n  }) })) (request_id: c25ab1c3-0214-49c3-9ff7-798665a0bb27)";

    #[test]
    fn the_hard_wrapped_stream_error_is_detected() {
        assert!(scan_tail("kiro", REAL_WRAPPED), "the 2026-08-31 hard-wrapped paint must hit");
        // As it actually sits on screen: output above, prompt box below.
        assert!(scan_tail("kiro", &format!(
            "some earlier output\n{REAL_WRAPPED}\n\n╭───╮\n│ ❯ │\n╰───╯\nbuilder-2 · model · ◔ 9%\n"
        )));
        // The request_id sits ~20 continuation lines below the header — the
        // whole block is its home, not "the next few lines".
        assert_eq!(
            error_signature("kiro", REAL_WRAPPED),
            Some("1|c25ab1c3-0214-49c3-9ff7-798665a0bb27".into())
        );
    }

    #[test]
    fn a_narrow_pane_wrapping_the_header_itself_still_hits() {
        // On a narrow pane even the header sentence hard-wraps; the block
        // still OPENS with it, which is what the detection reads.
        let narrow = "An unexpected error\n  occurred during the response stream:\n  … reason: Some(ModelTemporarilyUnavailable) …\n  (request_id: aa11)\n";
        assert!(scan_tail("kiro", narrow));
        assert_eq!(error_signature("kiro", narrow), Some("1|aa11".into()));
    }

    #[test]
    fn the_wrapped_error_delivered_as_chat_is_not_a_hit() {
        // Measured in a live pane (2026-08-31): a chat delivery QUOTING the
        // wrapped error paints under its `[tmm chat …]` stamp — the stamp is
        // only on the FIRST line, the error lines are indented continuations,
        // and a blank line can sit inside the paint. None of it may hit.
        let quoted = "────────────────\n  [tmm chat 2026-08-31 05:33] human: @builder-2 [board #24]\n  assigned to you: auto recovery 优化 — 对于 Kiro\n  这个报错，要自动恢复\n  An unexpected error occurred during the response stream:\n  \n  CodewhispererChatResponseStream(ServiceError(ServiceError\n    { source: InternalServerError(InternalServerError {\n    message: \"Encountered unexpectedly high load when\n    processing the request, please try again.\", reason:\n    Some(ModelTemporarilyUnavailable), meta: ErrorMetadata\n  {\n    code: None, message: Some(\"Encountered une…. `tmm board\n  take 24` to start, note findings on it.\n";
        assert!(!scan_tail("kiro", quoted), "a stamped delivery quoting the error must not trigger");
    }

    #[test]
    fn the_error_inside_tool_output_is_not_a_hit() {
        // An agent reading the error (board show, grep, cat) paints it as
        // INDENTED tool output under a `●` bullet head — no stamp anywhere,
        // so only the block's own head can tell it apart from a real paint.
        let tooled = "● Shell tmm board show 24\n  #24 [doing] auto recovery 优化\n  An unexpected error occurred during the response stream:\n    CodewhispererChatResponseStream(ServiceError(ServiceError\n    reason: Some(ModelTemporarilyUnavailable), please try again\n    (request_id: c25ab1c3-0214-49c3-9ff7-798665a0bb27)\n";
        assert!(!scan_tail("kiro", tooled), "quoted error in tool output must not trigger");
    }

    /// The 2026-09-05 kirocrew miss: on a 57×36 pane the ~25-line error paint
    /// plus the prompt redraw pushed the HEADER above the fold — the visible
    /// screen opened mid-block, the orphan was dropped, the incident became
    /// invisible and the agent sat stalled for half an hour.
    fn visible_mid_block() -> String {
        // REAL_WRAPPED without its first (header) line, as the fold cut it.
        let headless: String = REAL_WRAPPED
            .lines()
            .skip(1)
            .map(|l| format!("{l}\n"))
            .collect();
        format!("{headless}\n╭───╮\n│ ❯ │\n╰───╯\nkiro · model · ◑ 38%\n")
    }

    #[test]
    fn a_header_above_the_fold_is_invisible_to_the_visible_scan() {
        let visible = visible_mid_block();
        assert_eq!(error_signature("kiro", &visible), None, "the orphan tail alone is never a hit");
        assert!(headless_error_tail(&visible), "but it earns the one deeper capture");
    }

    #[test]
    fn the_deep_capture_reads_the_head_and_detects_the_incident() {
        let deep = format!("agent output above\n{REAL_WRAPPED}\n\n╭───╮\n│ ❯ │\n╰───╯\nkiro · model · ◑ 38%\n");
        assert_eq!(
            deep_error_signature("kiro", &deep),
            Some("1|c25ab1c3-0214-49c3-9ff7-798665a0bb27".into()),
            "the recovered head opens the block, so the deep scan hits"
        );
        // Deeper than error_signature's 40-line staleness window: pad the
        // history ABOVE the block past 40 lines and the deep scan still hits.
        let padded = format!("{}{deep}", "old line\n".repeat(120));
        assert!(deep_error_signature("kiro", &padded).is_some(), "the deep window covers the whole follow-up capture");
    }

    #[test]
    fn a_headless_quote_or_tool_tail_resolves_to_its_real_head_and_stays_silent() {
        // The fold hides a `[tmm chat …]` stamp (or a bullet tool head): the
        // orphan may look like an error tail, but the deep capture recovers
        // the real head and the block is disqualified — read, not guessed.
        let quote_tail = "  An unexpected error occurred during the response stream:\n  reason: Some(ModelTemporarilyUnavailable), please try\n  again. (request_id: aa22)\n\n╭───╮\n│ ❯ │\n╰───╯\n";
        assert!(headless_error_tail(quote_tail), "the tail alone cannot tell — it asks for the deep look");
        let deep_quote = format!("────────\n  [tmm chat 2026-09-05 11:40] human: @kiro look at this\n{quote_tail}");
        assert_eq!(deep_error_signature("kiro", &deep_quote), None, "the recovered stamp head disqualifies the block");
        for head in HEADS {
            let deep_tool = format!("{head} Shell tmm board show 24\n{quote_tail}");
            assert_eq!(deep_error_signature("kiro", &deep_tool), None, "{head}: the recovered tool head disqualifies the block");
        }
        // The same for the high-traffic shape: its paint under a tool head,
        // recovered by the deep capture, is the tool's output and no hit.
        let hidden = "  again, or select another model. (Request ID:\n  ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146)\n";
        for head in HEADS {
            assert_eq!(deep_error_signature("kiro", &format!("{head} Shell tmm board show 267\n    ╰ output: Claude Opus 5.5 is experiencing high traffic. Try\n{hidden}")), None, "{head}");
        }
    }

    #[test]
    fn an_ordinary_mid_block_screen_never_asks_for_the_deep_capture() {
        // Indented continuations with no transient marker (prose, tool
        // output) stay below the gate; so does a screen opening on a
        // column-zero line, a stamped quote, or plain blank space.
        assert!(!headless_error_tail("  plain wrapped prose\n  more prose\n"));
        assert!(!headless_error_tail("column-zero output\n  indented under it\n"));
        assert!(!headless_error_tail("  [tmm chat 2026-09-05 11:40] human: try again please\n"));
        assert!(!headless_error_tail("\n\n"));
        assert!(!headless_error_tail(""));
    }

    #[test]
    fn a_headless_tail_of_indented_error_lines_is_not_a_hit() {
        // The capture can start mid-block (the head scrolled off the top).
        // Those orphan continuations are unverifiable — the invisible head is
        // a `[tmm chat …]` stamp as easily as a real error header — so they
        // are dropped, never guessed at.
        let orphan = "  processing the request, please try again.\", reason:\n  Some(ModelTemporarilyUnavailable), meta: ErrorMetadata {\n  }) })) (request_id: c25ab1c3-0214-49c3-9ff7-798665a0bb27)\n";
        assert!(!scan_tail("kiro", orphan));
    }

    #[test]
    fn quoting_the_model_error_is_not_having_it() {
        // The owner pasted this error into the chat (2026-08-26) — the
        // delivery lands in an agent's pane stamped, wrapping after it.
        let quoted = format!("[tmm chat 2026-08-26 15:42] human: @builder-2 {MODEL_ERR} 遇到这个异常，麻烦你也给我处理一下");
        assert!(!scan_tail("kiro", &quoted), "a chat quote must not trigger a retry");
        // The continuation lines alone (stamp scrolled onto the line above)
        // never carry the full header sentence, so they cannot hit either.
        assert!(!scan_tail("kiro", "Please use '/model' to select a different model and try\n  again. (request_id: x)\n"));
        // Prose that names the reason without the sentence.
        assert!(!scan_tail("kiro", "the model may be temporarily unavailable, retry later\n"));
    }

    #[test]
    fn talking_about_the_error_is_not_having_it() {
        // The owner pasted the error into the chat — that line was TYPED into
        // an agent's pane, stamped like every delivery.
        let quoted = format!("[tmm chat 2026-08-21 17:57] human: @builder {REAL} 自动帮我处理异常");
        assert!(!scan_tail("kiro", &quoted), "a chat quote must not trigger a retry");
        // Prose that names the reason without the error's own header.
        assert!(!scan_tail("kiro", "we should detect ModelTemporarilyUnavailable and unexpectedly high load\n"));
        // The header alone (a non-transient stream error) is not retried.
        assert!(!scan_tail("kiro", "An unexpected error occurred during the response stream: context overflow\n"));
        assert!(!scan_tail("kiro", ""));
    }

    /// A hook check that never sees anything land.
    fn silent(_: u64) -> bool {
        false
    }

    #[test]
    fn a_verified_send_is_never_repeated() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        // Sent at fact sequence 7 (board #473: progress is ordered by it).
        assert_eq!(t.decide_seq("s", "w1", t0, 7, "1|a", silent), Decision::Send { attempt: 1 });
        // Next tick, error still painted, but the agent progressed after the
        // send: confirmed ONCE, then silence for as long as the error shows.
        assert_eq!(
            t.decide("s", "w1", t0 + 20, "1|a", |sent| sent == 7),
            Decision::Confirmed { first: true }
        );
        assert_eq!(
            t.decide("s", "w1", t0 + 40, "1|a", |_| true),
            Decision::Confirmed { first: false }
        );
        // Even hours later, the painted error must not re-trigger a send.
        assert_eq!(
            t.decide("s", "w1", t0 + 10_000, "1|a", |_| true),
            Decision::Confirmed { first: false }
        );
    }

    #[test]
    fn verification_outranks_backoff_and_the_spent_budget() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        for i in 0..MAX_ATTEMPTS as u64 {
            t.decide("s", "w1", t0 + i * 10_000, "1|a", silent);
        }
        // The budget is spent — but the 4th send finally landed: that is a
        // success, not a give-up.
        assert_eq!(
            t.decide("s", "w1", t0 + 40_000, "1|a", |_| true),
            Decision::Confirmed { first: true }
        );
    }

    #[test]
    fn unverified_retries_back_off_exponentially_and_run_out() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        // Attempt 1 is immediate.
        assert_eq!(t.decide("s", "w1", t0, "1|a", silent), Decision::Send { attempt: 1 });
        // Still inside the 30s backoff: wait.
        assert_eq!(t.decide("s", "w1", t0 + 29, "1|a", silent), Decision::Wait);
        assert_eq!(t.decide("s", "w1", t0 + 30, "1|a", silent), Decision::Send { attempt: 2 });
        // The ladder doubles: 60s after attempt 2, 120s after attempt 3.
        assert_eq!(t.decide("s", "w1", t0 + 89, "1|a", silent), Decision::Wait);
        assert_eq!(t.decide("s", "w1", t0 + 90, "1|a", silent), Decision::Send { attempt: 3 });
        assert_eq!(t.decide("s", "w1", t0 + 209, "1|a", silent), Decision::Wait);
        assert_eq!(t.decide("s", "w1", t0 + 210, "1|a", silent), Decision::Send { attempt: 4 });
        // The budget is spent with nothing verified — warned ONCE, then silence.
        assert_eq!(t.decide("s", "w1", t0 + 10_000, "1|a", silent), Decision::GiveUp { first: true });
        assert_eq!(t.decide("s", "w1", t0 + 20_000, "1|a", silent), Decision::GiveUp { first: false });
    }

    #[test]
    fn a_tool_call_confirms_the_incident_without_erasing_it() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        assert_eq!(t.decide("s", "w1", t0, "1|a", silent), Decision::Send { attempt: 1 });
        // telemetry::record_tool → note_answered → confirm. The record
        // SURVIVES: erasing it here re-opened the incident on the next tick
        // (the error is still painted) and re-sent `continue` into a working
        // agent — the owner's repeat-send report (2026-08-26).
        t.confirm("s", "w1", 1);
        // Said once, by the tick (board #473), then silent.
        assert_eq!(t.decide("s", "w1", t0 + 60, "1|a", silent), Decision::Confirmed { first: true });
        assert_eq!(
            t.decide("s", "w1", t0 + 80, "1|a", silent),
            Decision::Confirmed { first: false }
        );
        // A tool call with no open incident is a no-op, not a new record.
        t.confirm("s", "w2", 0);
        assert_eq!(t.decide("s", "w2", t0, "1|a", silent), Decision::Send { attempt: 1 });
    }

    #[test]
    fn a_vanished_error_ends_the_incident_and_a_fresh_one_starts_over() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        for i in 0..MAX_ATTEMPTS as u64 {
            t.decide("s", "w1", t0 + i * 10_000, "1|a", silent);
        }
        assert_eq!(t.decide("s", "w1", t0 + 99_000, "1|a", silent), Decision::GiveUp { first: true });
        // The screen moved on (check_once calls clear when scan_tail misses):
        // whatever the incident's state, it is over.
        t.clear("s", "w1");
        // A NEW error later opens a fresh incident with a full budget.
        assert_eq!(t.decide("s", "w1", t0 + 100_000, "1|a", silent), Decision::Send { attempt: 1 });
    }

    #[test]
    fn a_second_error_reopens_a_confirmed_incident() {
        // Owner, 2026-08-26: the continue LANDED (hooks saw the turn), the
        // agent ran — and died again. The first error is still painted, so
        // "error visible" never went false and clear() never ran; only the
        // NEW request_id says this is a new failure.
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        assert_eq!(t.decide("s", "w1", t0, "1|a", silent), Decision::Send { attempt: 1 });
        assert_eq!(
            t.decide("s", "w1", t0 + 20, "1|a", |_| true),
            Decision::Confirmed { first: true }
        );
        // Same painted error, hours later: still silent.
        assert_eq!(
            t.decide("s", "w1", t0 + 5_000, "1|a", |_| true),
            Decision::Confirmed { first: false }
        );
        // The resumed turn dies again — both errors on screen: new signature,
        // fresh incident, immediate send with a full budget.
        assert_eq!(
            t.decide("s", "w1", t0 + 6_000, "2|a,b", silent),
            Decision::Send { attempt: 1 }
        );
        // And the new incident verifies independently.
        assert_eq!(
            t.decide("s", "w1", t0 + 6_020, "2|a,b", |sent| sent == 0),
            Decision::Confirmed { first: true }
        );
    }

    #[test]
    fn a_second_error_also_resets_a_spent_or_waiting_budget() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        // Mid-backoff: a new instance replaces the wait.
        assert_eq!(t.decide("s", "w1", t0, "1|a", silent), Decision::Send { attempt: 1 });
        assert_eq!(t.decide("s", "w1", t0 + 10, "1|a", silent), Decision::Wait);
        assert_eq!(t.decide("s", "w1", t0 + 20, "1|b", silent), Decision::Send { attempt: 1 });
        // Spent budget: a new instance starts a fresh one.
        let mut t = Tracker::default();
        for i in 0..MAX_ATTEMPTS as u64 {
            t.decide("s", "w1", t0 + i * 10_000, "1|a", silent);
        }
        assert_eq!(t.decide("s", "w1", t0 + 90_000, "1|a", silent), Decision::GiveUp { first: true });
        assert_eq!(t.decide("s", "w1", t0 + 91_000, "1|c", silent), Decision::Send { attempt: 1 });
    }

    #[test]
    fn signatures_identify_error_instances() {
        // One error, id on the hit line (capture -J joined it).
        assert_eq!(error_signature("kiro", REAL), Some("1|30010907-33c4-483a-b024-2ed61321e233".into()));
        // Hard-wrapped shape: the id sits on a continuation line below the hit.
        assert_eq!(
            error_signature("kiro", MODEL_ERR),
            Some("1|db05d310-a189-497d-a6f2-b53410863243".into())
        );
        // Two errors visible at once → both ids, either order of appearance.
        let both = format!("{REAL}\nsome output\n{MODEL_ERR}\n");
        assert_eq!(
            error_signature("kiro", &both),
            Some("2|30010907-33c4-483a-b024-2ed61321e233,db05d310-a189-497d-a6f2-b53410863243".into())
        );
        // No error, no signature (scan_tail's contract).
        assert_eq!(error_signature("kiro", "all quiet\n"), None);
        // A quoted error contributes neither a hit nor an id.
        let quoted = format!("[tmm chat 2026-08-26 15:42] human: @b {MODEL_ERR}");
        assert_eq!(error_signature("kiro", &quoted.replace('\n', " ")), None);
    }

    #[test]
    fn dead_windows_are_forgotten() {
        let mut t = Tracker::default();
        t.decide("s", "w1", 1_000, "1|a", silent);
        t.decide("s", "w7", 1_000, "1|a", silent);
        t.decide("other", "w1", 1_000, "1|a", silent);
        t.retain_windows("s", &["w7".to_string()]);
        // Window 1 was dropped: a new agent at the same index starts fresh.
        assert_eq!(t.decide("s", "w1", 1_001, "1|a", silent), Decision::Send { attempt: 1 });
        // Window 7 and the other session were untouched.
        assert_eq!(t.decide("s", "w7", 1_001, "1|a", silent), Decision::Wait);
        assert_eq!(t.decide("other", "w1", 1_001, "1|a", silent), Decision::Wait);
    }

    // ---- board #362: version-stamped fixtures, the drift guard, the cap ----

    /// Every recovery fixture above, with the backend that paints it, the
    /// shape it is, and the CLI version it was captured on (board #362 a).
    /// "≤ 2.18.1" = captured before versions were written down.
    /// Board #362 c, the person-needed shapes, as painted. kiro-cli 2.28.0,
    /// video-factory:checker, 10-13 (59 columns; the version asked of the
    /// pane's running binary): the image-size error as the newest block, the
    /// tool call above it and the credits line and rule under it, from the
    /// pane's scrollback (read-only, 10-15). The 3000-px paint of 10-15
    /// (builder) is no longer in any scrollback; kiro's own log has its
    /// sentence, `KIRO_IMAGE_3000_LOG`.
    const KIRO_228_IMAGE: &str = "• Read /local/home/cfu/work/projects/video-factory/producti\n  ons/261013-jpeg-explainer/02_preprod/style-frames/sf_t13.\n  20.png\n    ╰ output:\n      ...+2 lines above\n            ductions/261013-jpeg-explainer/02_preprod/style\n            -frames/sf_t13.20.png\n         2  Format: png\n         3  Size: 170344 bytes\n         4  MediaType: image/png\n    (ctrl+o to toggle)\n\n• At least one of the image dimensions exceed max allowed\n  size for many-image requests: 2000 pixels (Request ID:\n  1336b8d6-2439-48cc-baa1-958338597643)\n\n▸ Credits: turn 19.11 • session 282.96 | Time: 2m 49s\n───────────────────────────────────────────────────────────\n";
    /// The same pane's later work (the next turn's first blocks, real).
    const KIRO_228_LATER: &str = "  （用 1280 宽副本、一次一两张）。报告写同目录 check.md。\n\n• Thought for 1s...\n    ╰ I've already got most of what I need, but I should\n      still check the remaining frames at a smaller size\n      and read the end of the manifest first.\n• Shell cd\n  /local/home/cfu/work/projects/video-factory/productions/2\n  61013-jpeg-explainer; tail -12\n  review/g3-v001/manifest.md; ls review/g3-v001\n  review/g3-v001/*/ ; ls -la --time-style=+%m-%d_%H:%M\n";
    /// The same pane's idle furniture under its newest block (real, 10-15),
    /// from just after the credits line's rule (`KIRO_228_IMAGE` ends with
    /// it, so the two together are one screen: credits, rule, banner, rule,
    /// status lines, idle composer).
    const KIRO_228_IDLE: &str = " Trust All Tools active, confirmations are off · /quit to\n exit\n───────────────────────────────────────────────────────────\nchecker · claude-opus-5.5 · high · ◑ 58% · Midway: 9h 16m\n/local/home/cfu/work/projects/video-factory\n\n›  ask a question or describe a task ↵\n                  /sessions to resume · /copy to clipboard\n";
    /// The whole screen: the image refusal as the newest block over the idle
    /// furniture, as `check_once` reads it (the FIXTURES row).
    // `concat!` takes literals only, so the screen is spelled once here and
    // checked against its two halves below.
    const KIRO_228_IMAGE_SCREEN: &str = concat!("• Read /local/home/cfu/work/projects/video-factory/producti\n  ons/261013-jpeg-explainer/02_preprod/style-frames/sf_t13.\n  20.png\n    ╰ output:\n      ...+2 lines above\n            ductions/261013-jpeg-explainer/02_preprod/style\n            -frames/sf_t13.20.png\n         2  Format: png\n         3  Size: 170344 bytes\n         4  MediaType: image/png\n    (ctrl+o to toggle)\n\n• At least one of the image dimensions exceed max allowed\n  size for many-image requests: 2000 pixels (Request ID:\n  1336b8d6-2439-48cc-baa1-958338597643)\n\n▸ Credits: turn 19.11 • session 282.96 | Time: 2m 49s\n───────────────────────────────────────────────────────────\n", " Trust All Tools active, confirmations are off · /quit to\n exit\n───────────────────────────────────────────────────────────\nchecker · claude-opus-5.5 · high · ◑ 58% · Midway: 9h 16m\n/local/home/cfu/work/projects/video-factory\n\n›  ask a question or describe a task ↵\n                  /sessions to resume · /copy to clipboard\n");
    /// The same pane's NEXT paint after the image refusal (real, 10-13): the
    /// submitted prompt kiro painted under the rule, indented, before any
    /// tool call or reply (review P1-B).
    const KIRO_228_SUBMITTED: &str = "  ›\n  [tmm team context — background since your previous\n  delivery; not new instructions]\n  [10-13 14:33] maker -> @maker: [wake] @maker task\n";
    /// The rule that closes the submitted prompt, and the rest of the screen
    /// as an idle kiro paints it (the same pane's furniture).
    const KIRO_228_RULE: &str = "───────────────────────────────────────────────────────────\n";
    /// kiro-cli 2.31.0, a real idle screen after one finished reply (own
    /// tmux, scratch workspace, 80 columns, 2026-10-16; /tmp/gw362 kiro-idle.sh):
    /// the newest block `• pong`, then the same furniture as 2.28.0 with the
    /// Trust banner on one line. Pins that `newest_block` still reads this
    /// recorded 2.31.0 screen, so a parser change that stops reading it fails
    /// here. It cannot see a future CLI's repaint: that is the drift warning's
    /// job, and a new capture beside it.
    const KIRO_231_IDLE_REPLY: &str = "  › Reply with exactly the word: pong\n\n• pong\n\n▸ Credits: turn 0.59 • session 0.59 | Time: 3s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nDefault · claude-opus-5.5 · medium · ◔ 5% · Midway: 5h 31m      /tmp/gw362/latws\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
    /// kiro-cli 2.28.0's own log of the 3000-px refusal (10-15 03:55 UTC,
    /// /tmp/kiro-log/kiro-tui.log): the sentence, not a paint.
    const KIRO_IMAGE_3000_LOG: &str = "At least one of the image dimensions exceed max allowed size for many-image requests: 3000 pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433)";
    /// codex-cli 0.154.0, lingting:reviewer, 10-15 22:59 (80×24, the visible
    /// screen as `check_once` reads it): the 401 as the newest paint, the
    /// composer and the footer under it.
    const CODEX_0154_401: &str = "■ unexpected status 401 Unauthorized: Authentication failed: Please make sure\nyour API Key is valid., url:\nhttps://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses, request id:\n389cc17d-bf5d-409b-ba80-102270246c79\n\n\n› Ask Codex to do anything\n\n  global.openai.gpt-6-astra · Context 45% used · /local/home/cfu/work/projects/…\n";
    /// The same pane's scrollback, 10-14: an earlier 401 with the next
    /// delivered prompt painted under it (real), and the composer of the
    /// same pane under that (real, from the screen above).
    const CODEX_0154_401_THEN_PROMPT: &str = "■ unexpected status 401 Unauthorized: Authentication failed: Please make sure\nyour API Key is valid., url:\nhttps://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses, request id:\n23a04597-c6d8-4439-954f-2216f9c7d687\n\n\n› [tmm team context — background since your previous delivery; not new\n  instructions]\n  [10-14 11:46] evaluator -> @engineer: The KL-only run (abl-b1-klonly)\n  finished with clean checks. Removing the CE loss lowered training KL by about\n  17% over the first 2,500 steps. The readout is §8.35 in `docs/q35-eval-\n  plan.md` (main `8c70ac7`), with a pointer on #35, and I've sent it to\n\n› Ask Codex to do anything\n\n  global.openai.gpt-6-astra · Context 45% used · /local/home/cfu/work/projects/…\n";

    /// Board #473, kiro-cli 2.34.0 `--agent-engine v3`: the two network
    /// failures, each a REAL visible screen read with `capture-pane -p -J`
    /// as `check_once` reads it, from the 2026-10-27 rig (a scratch kiro-cli
    /// whose upstream ran through a local CONNECT proxy). R2, 80 columns: a
    /// reset mid-stream with the reconnect refused, the partial essay above
    /// the error, kiro's idle furniture and composer under it.
    const KIRO_234_CONN_SCREEN: &str = "  years or decades, continued burial squeezes out most of the air, and the firn\n  becomes dense glacial ice, often with a faint blue tint because the compact\n  ice absorbs red light and scatters blue.\n  \n  Once the mass of ice becomes thick enough, usually several tens of meters,\n  gravity makes it move. A glacier is not simply a frozen block. It flows. Ice\n  deforms internally, its crystals slowly sliding past one another, and in many\n  glaciers the whole mass also slides over its bed on a thin film of meltwater.\n  Speeds vary widely. Some glaciers move only a few meters per year, while fast\n  ones, especially those that surge, can advance many meters in a single day.\n  \n  Accumulation, Ablation, and Balance\n  \n  The life of a glacier can be understood as a budget. The upper part, the\n  accumulation zone, is where snow gains exceed losses. The lower part, the\n  ablation zone, is where melting, evaporation, and calving remove more than\n  falls. Between them lies the equilibrium line, where gains and losses balance\n  over a year. Ice flows from the accumulation zone toward the ablation zone,\n  carrying mass downhill to replace what is lost.\n  \n  If accumulation and ablation balance over many years, the glacier's terminus,\n  or snout, stays roughly in place, even though the ice itself is constantly\n  moving. If snowfall increases or temperatures drop, the glacier gains mass and\n  advances. If melting outpaces accumulation, it loses mass and retreats.\n  Because glaciers respond to long-term averages rather than daily weather, they\n  act as natural thermometers, smoothing out short\n\n• Your connection was interrupted. Please try again in a moment.\n \n▸ Time: 10s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nrig · auto · ◔ 3% · Midway: expired                            /tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
    /// R9, 44 columns: the same failure, the sentence hard-wrapped once.
    const KIRO_234_CONN_NARROW: &str = "  ship, and the first lighthouse there,\n  finished in 1698, was swept away in a\n  storm only a few years later. Later\n  versions of wood also failed, burning or\n  washing off. In 1759 John Smeaton designed\n  a tower modeled on the shape of an oak\n  trunk, with interlocking granite blocks\n  that resisted the waves. His method\n  influenced builders for generations.\n  Robert Stevenson's Bell Rock Lighthouse in\n  Scotland, completed in 1810, was built on\n  a reef that was submerged at high tide, so\n  workers could labor only for brief periods\n  between the tides.\n\n  The Light Itself\n\n  Early lamps burned candles, then oil, and\n  gave weak, flickering beams. Improvements\n  came with Argand lamps, which drew air\n  through a hollow wick for a brighter\n  flame, and with polished reflectors. The\n  great breakthrough was the Fresnel lens,\n\n• Your connection was interrupted. Please\n  try again in a moment.\n\n▸ Time: 10s\n\n────────────────────────────────────────────\n Trust All Tools active, confirmations are\n off · /quit to exit\n────────────────────────────────────────────\nrig · auto · ◔ 4% · Midway: expired\n/tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n   /sessions to resume · /copy to clipboard\n";
    /// The live incident (sound-factory:kiro-2, 2026-10-27 13:40, 52
    /// columns), from its scrollback: the error block and the turn's credits
    /// line and rule under it. Detection only: its furniture was repainted
    /// by the turn a person's `continue` started.
    const KIRO_234_CONN_LIVE: &str = "• Your connection was interrupted. Please try again\n  in a moment.\n \n▸ Credits: turn 267.16 • session 2416.53 | Time:\n  123m 39s\n────────────────────────────────────────────────────\n";
    /// R8, 44 columns: the connection refused (`ClientNetworkError`), after
    /// an earlier successful turn and its submitted prompt.
    const KIRO_234_NET_NARROW: &str = "  visitors seeking solitude and scale.\n  Balancing access with protection of\n  fragile habitats is a continuing\n  challenge.\n\n  Patterns in Motion\n\n  What makes dunes so compelling is their\n  combination of order and change. A dune\n  field is a pattern emerging from countless\n  individual collisions, with regular\n  spacing and recurring shapes, yet no two\n  dunes are identical, and none stays put\n  forever. They are an enduring reminder\n  that even the solid-seeming ground is\n  sometimes a slow river of grains, governed\n  by wind and gravity, writing and rewriting\n  the shape of the land.\n\n▸ Credits: turn 0.65 • session 1.24 | Time:\n  46s\n────────────────────────────────────────────\n  › Say hello in one word.\n\n• A network error occurred. Please check\n  your connection and try again.\n\n▸ Time: 0s\n\n────────────────────────────────────────────\n Trust All Tools active, confirmations are\n off · /quit to exit\n────────────────────────────────────────────\nrig · auto · ◔ 4% · Midway: expired\n/tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n   /sessions to resume · /copy to clipboard\n";
    /// R5, 80 columns: R4's connection error, then R5's network error as the
    /// newest block — two errors on one real screen.
    const KIRO_234_BOTH_SCREEN: &str = "  \n  Looking Ahead\n  \n  How much ice survives will depend on choices made in the coming decades.\n  Studies suggest that limiting warming to about 1.5 degrees Celsius could\n  preserve roughly half of the world's glacier mass outside the ice sheets,\n  while higher warming would remove far more. Adaptation, such as improved water\n  storage, flood early-warning systems, and careful land-use planning, can\n  reduce harm, but it cannot replace the ice itself.\n  \n  Mountain glaciers are slow-moving yet sensitive, grand yet fragile. They carve\n  the peaks we admire, store the water we drink, and keep a frozen archive of\n  past climates. Watching them recede is a reminder that even the most enduring\n  features of the natural world respond to the changing atmosphere above them.\n  Whether they remain as rivers of ice for future generations is a question we\n  are answering now.\n \n▸ Credits: turn 0.31 • session 0.59 | Time: 20s\n────────────────────────────────────────────────────────────────────────────────\n  › Write a 1200-word essay about river deltas, in plain prose, no tools.\n \n• Your connection was interrupted. Please try again in a moment.\n \n▸ Time: 1s\n────────────────────────────────────────────────────────────────────────────────\n  › Write a 1200-word essay about sand dunes, in plain prose, no tools.\n \n• A network error occurred. Please check your connection and try again.\n \n▸ Time: 0s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nrig · auto · ◔ 3% · Midway: expired                            /tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";

    /// COMPOSED, two real 2.28.0 captures joined (board #473): the builder's
    /// rate-limit block (TMR_BUILDER, 80 columns) and video-factory:checker's
    /// idle furniture and composer (KIRO_228_IDLE, 59 columns). No single
    /// capture of a rate-limit screen with its composer was kept; this is the
    /// whole-screen fixture its `screen_grammar` row stands on.
    const KIRO_228_TMR_SCREEN_COMPOSED: &str = concat!("\n• Too many requests, please wait before trying again. (Request ID:\n  319ae15c-f2d3-4ada-bafc-9b9b20927ea8)\n \n▸ Credits: turn 31.76 • session 597.47 | Time: 8m 37s\n────────────────────────────────────────────────────────────────────────────────\n", " Trust All Tools active, confirmations are off · /quit to\n exit\n───────────────────────────────────────────────────────────\nchecker · claude-opus-5.5 · high · ◑ 58% · Midway: 9h 16m\n/local/home/cfu/work/projects/video-factory\n\n›  ask a question or describe a task ↵\n                  /sessions to resume · /copy to clipboard\n");
    /// R10, 44 columns (board #473, reviewer P1-A): a turn whose first
    /// request completed (a tool ran) and whose next one hit the refused
    /// reconnect. Its turn line carries credits and kiro HARD-WRAPS it,
    /// `| Time:` with `  23s` on the next line — the live incident's form —
    /// above the idle furniture and composer. A real whole screen.
    const KIRO_234_CONN_WRAPPED_TURN: &str = "\n────────────────────────────────────────────\n\n ▸ Kiro CLI 3.0 launches at the end of\n   October. If you have auto-updates on,\n   you'll be upgraded to 3.0 automatically.\n   It brings cloud sessions, memory,\n   workflows, an improved trust model,\n   expanded hooks and specs.\n   Note: 3.0 doesn't support the legacy\n   --classic experience or the legacy\n   desktop app.\n────────────────────────────────────────────\n  ›Use the shell tool to run exactly: sleep\n   20; echo done. Then write a 300-word note\n   about tides.\n \n• Shell sleep 20; echo done\n    ╰ description=Run sleep then echo done,\n      run_in_background=false\n    ╰ output:\n        done\n\n• Your connection was interrupted. Please\n  try again in a moment.\n \n▸ Credits: turn 0.08 • session 0.08 | Time:\n  23s\n\n────────────────────────────────────────────\n Trust All Tools active, confirmations are\n off · /quit to exit\n────────────────────────────────────────────\nrig · auto · ◔ 3% · Midway: expired\n/tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n   /sessions to resume · /copy to clipboard\n";
    /// COMPOSED, two real 2.34.0 captures joined (board #473, P1-A): the live
    /// incident's error block and wrapped turn line (KIRO_234_CONN_LIVE, 52
    /// columns) and R9's idle furniture below its first rule (44 columns).
    /// The live pane's own furniture was repainted by the person's
    /// `continue` before it could be captured.
    const KIRO_234_CONN_LIVE_SCREEN_COMPOSED: &str = concat!("• Your connection was interrupted. Please try again\n  in a moment.\n \n▸ Credits: turn 267.16 • session 2416.53 | Time:\n  123m 39s\n────────────────────────────────────────────────────\n", " Trust All Tools active, confirmations are\n off · /quit to exit\n────────────────────────────────────────────\nrig · auto · ◔ 4% · Midway: expired\n/tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n   /sessions to resume · /copy to clipboard\n");
    /// Board #473, the validator's row A (its own rig, 2026-10-27 17:24-17:25,
    /// a managed kiro-cli 2.34.0 `kr` at 80x24 behind a proxy resetting every
    /// connection): three REAL visible screens. The first error; the second
    /// under our `continue`; the third, whose visible 24 rows are byte for
    /// byte the second's (the first error scrolled off), which is why a hit
    /// count is no identity.
    const ROWA_1: &str = "\n ▸ Kiro CLI 3.0 launches at the end of October. If you have auto-updates on,\n   you'll be upgraded to 3.0 automatically.\n   It brings cloud sessions, memory, workflows, an improved trust model,\n   expanded hooks and specs.\n   Note: 3.0 doesn't support the legacy --classic experience or the legacy\n   desktop app.\n────────────────────────────────────────────────────────────────────────────────\n  › [tmm chat 2026-10-27 17:24] human: ＠kr reply with the word ok\n\n• Your connection was interrupted. Please try again in a moment.\n\n▸ Time: 0s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nkr · claude-haiku-5.5 · thinking · medium · ◔ 1% · Midway: expired\n/tmp/val473/rig/ws\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
    const ROWA_2: &str = "   desktop app.\n────────────────────────────────────────────────────────────────────────────────\n  › [tmm chat 2026-10-27 17:24] human: ＠kr reply with the word ok\n\n• Your connection was interrupted. Please try again in a moment.\n\n▸ Time: 0s\n────────────────────────────────────────────────────────────────────────────────\n  › continue\n\n• Your connection was interrupted. Please try again in a moment.\n\n▸ Time: 0s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nkr · claude-haiku-5.5 · thinking · medium · ◔ 1% · Midway: expired\n/tmp/val473/rig/ws\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
    const ROWA_3: &str = "▸ Time: 0s\n────────────────────────────────────────────────────────────────────────────────\n  › continue\n\n• Your connection was interrupted. Please try again in a moment.\n\n▸ Time: 0s\n────────────────────────────────────────────────────────────────────────────────\n  › continue\n\n• Your connection was interrupted. Please try again in a moment.\n\n▸ Time: 0s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nkr · claude-haiku-5.5 · thinking · medium · ◔ 1% · Midway: expired\n/tmp/val473/rig/ws\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";

    /// Board #473, reviewer/validator P1-2: kiro-cli 2.34.0's status line after
    /// a RESIZE, real visible screens. Row B (the validator's rig, `kn` born at
    /// 80 columns and resized to 52, the port closed): the status fills the
    /// width and the rest of `Midway: expired` spills one character per line
    /// down column 51, the first beside the cwd.
    const KIRO_234_NET_SPILL_ROWB: &str = "\n ▸ Kiro CLI 3.0 launches at the end of October. If\n   you have auto-updates on, you'll be upgraded to\n   3.0 automatically.\n   It brings cloud sessions, memory, workflows, an\n   improved trust model, expanded hooks and specs.\n   Note: 3.0 doesn't support the legacy --classic\n   experience or the legacy desktop app.\n────────────────────────────────────────────────────\n  ›\n  [tmm chat 2026-10-27 17:30] human: ＠kn reply with\n  the word ok\n\n• A network error occurred. Please check your\n  connection and try again.\n\n▸ Time: 0s\n\n────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off ·\n /quit to exit\n────────────────────────────────────────────────────\nkn · claude-haiku-5.5 · thinking · medium · ◔ 1% · M\n/tmp/val473/rig/ws                                 i\n                                                   d\n                                                   w\n                                                   a\n                                                   y\n                                                   :\n\n                                                   e\n                                                   x\n                                                   p\n                                                   i\n                                                   r\n                                                   e\n                                                   d\n\n›  ask a question or describe a task ↵\n           /sessions to resume · /copy to clipboard\n";
    /// R12 (kiro's rig, the same layout in another session: `kn` born at 80,
    /// resized to 52, the port closed).
    const KIRO_234_NET_SPILL_R12: &str = "\n────────────────────────────────────────────────────\n\n ▸ Kiro CLI 3.0 launches at the end of October. If\n   you have auto-updates on, you'll be upgraded to\n   3.0 automatically.\n   It brings cloud sessions, memory, workflows, an\n   improved trust model, expanded hooks and specs.\n   Note: 3.0 doesn't support the legacy --classic\n   experience or the legacy desktop app.\n────────────────────────────────────────────────────\n  › Say ok.\n \n• A network error occurred. Please check your\n  connection and try again.\n \n▸ Time: 1s\n\n────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off ·\n /quit to exit\n────────────────────────────────────────────────────\nkn · claude-haiku-5.5 · thinking · medium · ◔ 1% · M\n/tmp/kiro473/work                                  i\n                                                   d\n                                                   w\n                                                   a\n                                                   y\n                                                   :\n                                                   \n                                                   e\n                                                   x\n                                                   p\n                                                   i\n                                                   r\n                                                   e\n                                                   d\n\n›  ask a question or describe a task ↵\n           /sessions to resume · /copy to clipboard\n";
    /// R12 resized back to 80: the status repaints whole on one line.
    const KIRO_234_NET_BACK_WIDE_R12: &str = "        ⢸⣿⠀⠀⠀⠀⠀⣠⡀⠀⠀ ⠹⣷⡄    ⢸⣿⠀⠀⠀⠀⣿⡇⠀⢸⣿⠀⠀⠀⠀⣤⣄  ⠀⠀⠹⣿⡅   ⠸⣿⠀⠀ ⠸⣿⠀⠀⠀⠀ ⣿⠇⠀  ⣿⠇\n        ⢸⣿⠀⠀⠀⠀⣾⡟⣷⡀⠀⠀ ⠘⣿⣆   ⢸⣿⠀⠀⠀⠀⣿⡇ ⢸⣿⠀⠀⠀⠀⣿⡟⣷⡀⠀⠀ ⠘⣿⣆   ⢻⣧⠀⠀ ⠹⣷⣦⣤⣤⣾⠏⠀⠀⠀⣼⡟\n        ⢸⣿⠀⠀⠀⠀⣿⡇⠹⣷⡀  ⠀⠈⢻⡇  ⢸⣿⠀⠀⠀⠀⣿⡇ ⢸⣿⠀⠀⠀⠀⣿⡇⠹⣷⡀  ⠀⠈⢻⡇   ⢻⣧⠀⠀⠀ ⠉⠉⠉    ⣼⡟\n        ⠸⣿⣄⡀⢀⣠⣿⠇⠀⠙⣷⡀  ⢀⣼⠇  ⠸⣿⣄⡀⢀⣠⣿⠇ ⠸⣿⣄⡀⢀⣠⣿⠇⠀⠙⣷⡀  ⢀⣼⠇    ⠻⣷⣦⣄⡀   ⢀⣠⣴⣾⠟\n         ⠈⠻⠿⠿⠟⠁⠀⠀⠀⠈⠻⠿⠿⠟⠁    ⠈⠻⠿⠿⠟⠁   ⠈⠻⠿⠿⠟⠁⠀⠀⠀⠈⠻⠿⠿⠟⠁     ⠀⠀⠈⠙⠻⠿⠿⠿⠿⠟⠋⠁\n\n                            Welcome to Kiro CLI V3!\n         Upgrade your V2 agent configurations to V3 with /upgrade-agent\n                         https://kiro.dev/docs/cli/v3/\n           Prefer the previous experience? Launch with kiro-cli --v2\n                                        \n     Tip: Use /tangent to explore a side quest in a separate conversation —\n     /tangent ls lists and switches between them.\n\n\n────────────────────────────────────────────────────────────────────────────────\n\n ▸ Kiro CLI 3.0 launches at the end of October. If you have auto-updates on,\n   you'll be upgraded to 3.0 automatically.\n   It brings cloud sessions, memory, workflows, an improved trust model,\n   expanded hooks and specs.\n   Note: 3.0 doesn't support the legacy --classic experience or the legacy\n   desktop app.\n────────────────────────────────────────────────────────────────────────────────\n  › Say ok.\n \n• A network error occurred. Please check your connection and try again.\n \n▸ Time: 1s\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nkn · claude-haiku-5.5 · thinking · medium · ◔ 1% · Midway: expired\n/tmp/kiro473/work\n\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
    /// The validator's row C: `kw` BORN at 44 columns, its status cut to one
    /// line, the wrapped credits turn line above the furniture.
    const KIRO_234_CONN_BORN44_ROWC: &str = "\n▸ Time: 3m 49s\n• Cancelled\n────────────────────────────────────────────\n  ›[tmm chat 2026-10-27 17:38] human: ＠kw\n   Use the shell tool to run exactly: sleep\n   15; echo done. Then reply with the single\n   word ok.\n\n• Thought for 1s...\n    ╰ This is just a benign sleep and echo\n      command, shown twice in the message\n      with what looks like pasted output\n      already claiming success. I'll go\n      ahead and run it once myself rather\n      than trust the pasted output, treating\n      the duplicate as a retry.\n• Shell sleep 15; echo done\n    ╰ description=Sleep 15 seconds then\n      echo done, run_in_background=false\n    ╰ output:\n        done\n\n• Your connection was interrupted. Please\n  try again in a moment.\n\n▸ Credits: turn 0.02 • session 0.02 | Time:\n  20s\n\n────────────────────────────────────────────\n Trust All Tools active, confirmations are\n off · /quit to exit\n────────────────────────────────────────────\nkw · claude-haiku-5.5 · thinking · medium ·\n/tmp/val473/rig/ws\n\n›  ask a question or describe a task ↵\n   /sessions to resume · /copy to clipboard\n";

    const FIXTURES: &[(&str, &str, &str, &str)] = &[
        ("kiro", "stream_error", "≤ 2.18.1", REAL),
        ("kiro", "stream_error", "≤ 2.18.1", REAL_WRAPPED),
        ("kiro", "model_unavailable", "≤ 2.18.1", MODEL_ERR),
        ("kiro", "high_traffic", "2.22.1", HIGH_TRAFFIC_SCREEN),
        ("kiro", "high_traffic", "2.28.0", KIRO_228_WIDE),
        ("kiro", "high_traffic", "2.28.0", KIRO_228_NARROW),
        ("kiro", "high_traffic", "2.28.0", KIRO_228_OPUS),
        ("kiro", "too_many_requests", "2.28.0", TMR_RESEARCHER),
        ("kiro", "too_many_requests", "2.28.0", TMR_WRITER_SHORT),
        ("kiro", "too_many_requests", "2.28.0", TMR_WRITER_CREDITS),
        ("kiro", "too_many_requests", "2.28.0", TMR_BUILDER),
        ("kiro", "too_many_requests", "2.28.0", TMR_NARROW),
        ("kiro", "connection_interrupted", "2.34.0", KIRO_234_CONN_SCREEN),
        ("kiro", "connection_interrupted", "2.34.0", KIRO_234_CONN_NARROW),
        ("kiro", "connection_interrupted", "2.34.0", KIRO_234_CONN_LIVE),
        ("kiro", "connection_interrupted", "2.34.0", KIRO_234_CONN_WRAPPED_TURN),
        ("kiro", "connection_interrupted", "2.34.0", KIRO_234_CONN_LIVE_SCREEN_COMPOSED),
        ("kiro", "network_error", "2.34.0", KIRO_234_NET_NARROW),
        ("kiro", "network_error", "2.34.0", KIRO_234_NET_SPILL_ROWB),
        ("kiro", "network_error", "2.34.0", KIRO_234_NET_SPILL_R12),
        ("kiro", "network_error", "2.34.0", KIRO_234_NET_BACK_WIDE_R12),
        ("kiro", "connection_interrupted", "2.34.0", KIRO_234_CONN_BORN44_ROWC),
        ("kiro", "too_many_requests", "2.28.0", KIRO_228_TMR_SCREEN_COMPOSED),
        ("claude", "bedrock_5xx", "2.1.284", CLAUDE_503_WIDE),
        ("claude", "bedrock_5xx", "2.1.284", CLAUDE_503_NARROW),
        ("kiro", "conversation_blocked", "2.28.0", KIRO_228_IMAGE_SCREEN),
        ("codex", "auth_expired", "0.154.0", CODEX_0154_401),
    ];

    /// The shapes `backend` sees in `text`: its transient ones block by
    /// block, and the person-needed one its newest paint is (#362 c).
    fn shapes_in(backend: &str, text: &str) -> Vec<&'static str> {
        let b = crate::backends::Backend::parse(backend).unwrap();
        paint_blocks(text, DEEP_CAPTURE_LINES + 120).iter()
            .filter(|(glued, _)| !crate::backends::canonical(glued).contains("tmmchat"))
            .filter_map(|(glued, spaced)| b.transient_shape(glued, spaced))
            .chain(b.person_paint(text).map(|(shape, _)| shape))
            .collect()
    }

    /// Board #362 a: every fixture is exactly its shape; every shape has a
    /// fixture; and the version a shape says it was measured on is the newest
    /// of its fixtures' stamps, an upper bound exactly when they all are. A
    /// shape's version can only move with a captured fixture beside it.
    #[test]
    fn every_shape_is_stamped_with_the_version_its_fixtures_were_captured_on() {
        for (backend, shape, stamp, text) in FIXTURES {
            assert_eq!(shapes_in(backend, text), [*shape], "{backend} {shape} ({stamp})");
        }
        for backend in crate::backends::Backend::ALL {
            for m in backend.recovery_shapes() {
                let stamps: Vec<&str> = FIXTURES.iter().filter(|f| f.0 == backend.name() && f.1 == m.shape).map(|f| f.2).collect();
                assert!(!stamps.is_empty(), "{} {} has no captured fixture", backend.name(), m.shape);
                let newest = stamps.iter().max_by_key(|s| crate::backends::parse_version(s)).unwrap();
                assert_eq!(m.label(), *newest, "{} {}: measured on the newest capture", backend.name(), m.shape);
                assert_eq!(m.at_most, stamps.iter().all(|s| s.starts_with('≤')), "{} {}", backend.name(), m.shape);
                assert_eq!(crate::backends::measured_version(backend, m.shape), Some(m));
            }
        }
        // And the other way round: every shape a fixture shows is in its
        // backend's table, so a shape dropped from the table fails here.
        for (backend, shape, _, _) in FIXTURES {
            let b = crate::backends::Backend::parse(backend).unwrap();
            assert!(crate::backends::measured_version(b, shape).is_some(), "{backend} {shape} is not in RECOVERY_SHAPES");
        }
        assert_eq!(crate::backends::measured_version(crate::backends::Backend::Kiro, "nope"), None);
        for b in [crate::backends::Backend::Grok, crate::backends::Backend::Omp, crate::backends::Backend::Kimi] {
            assert!(b.recovery_shapes().is_empty(), "{}: capture first, no guessed shape (board #362 d)", b.name());
        }
        // codex has only the person-needed shape: no transient one is guessed (d).
        let codex = crate::backends::Backend::Codex;
        assert_eq!(codex.recovery_shapes().iter().map(|m| m.shape).collect::<Vec<_>>(), ["auth_expired"]);
        for (_, _, _, text) in FIXTURES {
            assert!(paint_blocks(text, 400).iter().all(|(g, sp)| codex.transient_shape(g, sp).is_none()), "codex continues nothing");
        }
    }

    /// Board #362 c, condition a, the WHOLE SCREEN as evidence (the sentences
    /// alone are tested in each backend's file, review P1-B): a person-needed
    /// paint counts only as the newest block, the turn having ended with it,
    /// by each CLI's own measured grammar. The real paints, as `check_once`
    /// reads them, are hits with kiro's idle furniture or codex's composer
    /// under them. History, a running turn, a half-drawn screen or anything
    /// unrecognised under the block is nothing: when in doubt, no end.
    #[test]
    fn a_person_needed_paint_counts_only_as_the_newest_block() {
        use crate::backends::Backend::{Codex, Kiro};
        let id = |b: crate::backends::Backend, text: &str| b.person_paint(text).and_then(|(shape, block)| extract_request_id(&block).map(|id| format!("{shape}|{id}")));
        let screen = format!("{KIRO_228_IMAGE}{KIRO_228_IDLE}");
        assert_eq!(screen, KIRO_228_IMAGE_SCREEN, "the FIXTURES screen is these two halves");
        // kiro: the real screen, the error as its newest block.
        assert_eq!(id(Kiro, &screen).as_deref(), Some("conversation_blocked|1336b8d6-2439-48cc-baa1-958338597643"));
        // The 3000-px sentence (kiro's own log) under the same furniture.
        let log = KIRO_228_IMAGE.replace("• At least one of the image dimensions exceed max allowed\n  size for many-image requests: 2000 pixels (Request ID:\n  1336b8d6-2439-48cc-baa1-958338597643)", &format!("• {KIRO_IMAGE_3000_LOG}"));
        assert_eq!(id(Kiro, &format!("{log}{KIRO_228_IDLE}")).as_deref(), Some("conversation_blocked|3c60ad4b-3654-47c8-aeb0-146c2a910433"));
        // History: a submitted prompt after it (no tool call or reply yet),
        // the next turn's blocks after it, both with the idle composer under.
        assert_eq!(Kiro.person_paint(&format!("{KIRO_228_IMAGE}{KIRO_228_SUBMITTED}{KIRO_228_RULE}{KIRO_228_IDLE}")), None, "a submitted prompt is newer");
        assert_eq!(Kiro.person_paint(&format!("{KIRO_228_IMAGE}  › [tmm chat 2026-10-15 23:50] human: @checker continue\n{KIRO_228_RULE}{KIRO_228_IDLE}")), None, "a one-line delivered prompt is newer");
        assert_eq!(Kiro.person_paint(&format!("{KIRO_228_IMAGE}{KIRO_228_LATER}{KIRO_228_IDLE}")), None, "the next turn's blocks are under it");
        // A running turn: either spelling of the working footer.
        let busy = screen.replace("›  ask a question or describe a task ↵", "›  Kiro is working · 4s · Type to steer · Ctrl+S to queue");
        assert_eq!(Kiro.person_paint(&busy), None, "a turn runs");
        for (at, what) in [
            ("\n\n›  ask a question", "above the composer"),
            ("\n───────────────────────────────────────────────────────────\nchecker", "between the rules"),
            ("\n exit\n", "inside the banner"),
        ] {
            let old_busy = screen.replacen(at, &format!("\n Kiro is working · Type to queue · Ctrl+S to steer{at}"), 1);
            assert_ne!(old_busy, screen, "{what}");
            assert_eq!(Kiro.person_paint(&old_busy), None, "the no-› working footer, {what}");
        }
        // The banner is kiro's exact text, wrapped or not; the status region
        // opens with kiro's segments.
        assert!(Kiro.person_paint(&screen.replace(" Trust All Tools active, confirmations are off · /quit to\n exit\n", " Trust All Tools active, confirmations are off · /quit to exit\n")).is_some(), "the banner on one line");
        assert_eq!(Kiro.person_paint(&screen.replace(" exit\n", " exit\n another line\n")), None, "a banner that is not kiro's");
        assert_eq!(Kiro.person_paint(&screen.replace("checker · claude-opus-5.5", "[tmm chat 2026-10-15 23:50] human: continue\nchecker · claude-opus-5.5")), None, "a status region that does not open with kiro's segments");
        // Half-drawn or not idle: no composer, a typed composer, the
        // furniture cut short, the error alone on the screen.
        assert_eq!(Kiro.person_paint(screen.split("›  ask").next().unwrap()), None, "no composer yet");
        assert_eq!(Kiro.person_paint(&screen.replace("›  ask a question or describe a task ↵", "›  mwinit done, carry on")), None, "something is being typed");
        assert_eq!(Kiro.person_paint(&format!("{KIRO_228_IMAGE}›  ask a question or describe a task ↵\n")), None, "the furniture is not all there");
        assert_eq!(Kiro.person_paint(KIRO_228_IMAGE), None, "no composer at all");
        // Not the sentence (each one tested in kiro.rs): a quote of it.
        assert_eq!(Kiro.person_paint(&screen.replace("• At least one", "• Shell cat log\n  [tmm chat 2026-10-15 14:15] orchestrator: • At least one")), None);
        // codex: newest above its composer.
        assert_eq!(id(Codex, CODEX_0154_401).as_deref(), Some("auth_expired|389cc17d-bf5d-409b-ba80-102270246c79"));
        // Above the next delivered prompt: history. No composer (mid-paint): nothing.
        assert_eq!(Codex.person_paint(CODEX_0154_401_THEN_PROMPT), None);
        let no_composer = CODEX_0154_401.split("› Ask Codex").next().unwrap();
        assert_eq!(Codex.person_paint(no_composer), None);
        // Half-drawn: the submitted prompt is the last `›`, its lines under it.
        let half = CODEX_0154_401_THEN_PROMPT.split("\n\n› Ask Codex").next().unwrap();
        assert_eq!(Codex.person_paint(half), None, "the last › is a prompt we typed");
        // A turn running under it ("• Working …"), another status, another host, a quote.
        let working = CODEX_0154_401.replace("\n\n\n› Ask", "\n\n• Working (3s • esc to interrupt)\n\n› Ask");
        assert_eq!(Codex.person_paint(&working), None);
        assert_eq!(Codex.person_paint(&CODEX_0154_401.replace("401 Unauthorized", "403 Forbidden")), None);
        assert_eq!(Codex.person_paint(&CODEX_0154_401.replace("■ unexpected", "› [tmm chat 2026-10-14 11:27] orchestrator: ■ unexpected")), None);
        // kiro-cli 2.31.0 (installed today) is read by the same grammar: its
        // real idle screen's newest block is the reply, and the image refusal
        // put in that place is read as the newest paint.
        assert_eq!(Kiro.newest_block(KIRO_231_IDLE_REPLY).map(|(g, _)| g).as_deref(), Some("• pong"));
        let refusal_231 = KIRO_231_IDLE_REPLY.replace("• pong", &format!("• {KIRO_IMAGE_3000_LOG}"));
        assert_eq!(id(Kiro, &refusal_231).as_deref(), Some("conversation_blocked|3c60ad4b-3654-47c8-aeb0-146c2a910433"), "2.31.0");
        // A shape is its own backend's.
        assert_eq!(Kiro.person_paint(CODEX_0154_401), None);
        assert_eq!(Codex.person_paint(&screen), None);
        assert_eq!(crate::backends::Backend::Claude.person_paint(CODEX_0154_401), None);
        // And no transient shape reads the person-needed paints.
        assert_eq!(error_signature("kiro", KIRO_228_IMAGE), None);
        assert_eq!(error_signature("codex", CODEX_0154_401), None);
    }

    /// Board #362 c, condition b, the INCIDENT identity (review P1-D on
    /// 4cd26dc9), with the real Claude Code 2.1.284 503 paint, which carries
    /// no Request ID (its signature is the hit count `1|`). Incident 1
    /// exhausts its ladder and its turn gets one recovery_exhausted end; the
    /// same continuous incident is never written twice. The screen clears, a
    /// real new turn hits a second, independent `1|` incident that exhausts
    /// too: that turn gets its own end and detail. Each incident sends its
    /// own ladder and not one continue more.
    #[test]
    fn an_exhausted_incident_ends_its_own_turn_once_and_a_later_one_is_its_own() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let session = format!("p1d-{}", uuid::Uuid::new_v4());
        let sig = error_signature("claude", CLAUDE_503_NARROW).unwrap();
        assert_eq!(sig, "1|", "no Request ID: a hit count, no paint identity");
        let ends = || tm::recent_events(&session, 0).into_iter().filter(|e| e.kind == "notif" && e.text == "failed").count();
        let decide = |at: u64| tracker().lock().unwrap().decide(&session, "w", at, &sig, |t| tm::progress_since(&session, "w", t));
        // The tracker's clock is simulated; every turn fact uses the real one.
        let mut sends = 0;
        let t0 = now_secs();
        for (n, base) in [(1, t0 + 10), (2, t0 + 1000)] {
            tm::record_prompt(&session, "w", &format!("[tmm chat 2026-10-16 01:0{n}] human: @w turn {n}"));
            for at in [base, base + 30, base + 90, base + 210] {
                assert!(matches!(decide(at), Decision::Send { .. }), "incident {n}");
                sends += 1;
            }
            assert_eq!(decide(base + 300), Decision::GiveUp { first: true }, "incident {n}");
            assert!(commit_exhausted(&session, "w", false, false, tm::turn_version(&session, "w")), "incident {n}: its turn gets its end");
            let st = tm::derive(&session, "w", 0);
            assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", EXHAUSTED), "incident {n}");
            assert_eq!(decide(base + 320), Decision::GiveUp { first: false });
            assert!(!commit_exhausted(&session, "w", false, false, tm::turn_version(&session, "w")), "incident {n}: one continuous incident is written once (the once flag: a give-up has no attribution rule over it)");
            assert_eq!(ends(), n, "incident {n}");
            // The error leaves the screen: the incident is over.
            tracker().lock().unwrap().clear(&session, "w");
        }
        assert_eq!(sends, 2 * MAX_ATTEMPTS as usize, "each incident its own ladder, not one continue more");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// Board #362 review P1-A, the two barriers, through the commit path the
    /// capture tick takes: the screen is read at a version, then a turn fact
    /// lands, then the observation is committed. A newer prompt, tool call,
    /// ask, hook end or interrupt makes it stale: the newer turn keeps its
    /// state and its end keeps its own detail, nothing is written or
    /// flushed, a held queue-mode line stays held, and the once mark is not
    /// spent (the next tick looks again, at the new version). Without a
    /// barrier the same observation is accepted.
    #[test]
    fn an_observation_overtaken_by_a_newer_turn_fact_changes_nothing() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        // Persisted, so every end has its row id: a missed check would then
        // ATTACH to the newer end (the bug), not fail for want of a row.
        tm::PERSIST_IN_TEST.with(|p| p.set(true));
        let barriers: [(&str, &dyn Fn(&str)); 5] = [
            ("a new prompt", &|s| { tm::record_prompt(s, "w", "[tmm chat 2026-10-16 00:10] human: @w next"); }),
            ("a tool call", &|s| { tm::record_tool(s, "w", "Bash", "npm test"); }),
            ("an ask", &|s| tm::record_notification(s, "w", "permission_required")),
            ("a real hook end", &|s| { tm::record_notification_with(s, "w", "completed", crate::backends::EndQuality::Said); }),
            ("an interrupt", &|s| tm::record_interrupt(s, "w")),
        ];
        for (what, barrier) in barriers {
            let session = format!("p1a-{}", uuid::Uuid::new_v4());
            tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 00:09] maker: @w go");
            tm::record_held(&session, "w", "[tmm chat 2026-10-16 00:09] human: @w held", 0, "m1").unwrap();
            let seen = tm::turn_version(&session, "w");
            barrier(&session);
            let before = tm::derive(&session, "w", 0);
            let rows = || tm::recent_events(&session, 0).into_iter().filter(|e| e.kind == "notif").count();
            let ends = rows();
            assert_eq!(tm::record_missed_end(&session, "w", "auth_expired", tm::Identity::Paint("auth_expired|x"), seen), tm::Missed::Stale, "{what}");
            assert!(!commit_person(&session, "w", "auth_expired|x", "auth_expired", seen), "{what}: not accepted");
            let after = tm::derive(&session, "w", 0);
            assert_eq!((after.state.as_str(), after.detail.as_str()), (before.state.as_str(), before.detail.as_str()), "{what}: the newer turn is untouched");
            assert_ne!(after.detail, "auth_expired", "{what}");
            assert_eq!(rows(), ends, "{what}: no end written");
            assert_eq!(tm::held_rows(&session, "w").len(), 1, "{what}: the held line is not flushed by a stale observation");
            assert_eq!(tm::accepted_paint(&session, "w", "auth_expired|x").unwrap(), None, "{what}: the paint is not marked accepted");
        }
        // Control: the same observation with no fact after it is accepted.
        let session = format!("p1a-ok-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 00:09] maker: @w go");
        let seen = tm::turn_version(&session, "w");
        assert!(commit_person(&session, "w", "auth_expired|x", "auth_expired", seen));
        assert_eq!(tm::derive(&session, "w", 0).detail, "auth_expired");
        assert!(tm::accepted_paint(&session, "w", "auth_expired|x").unwrap().is_some(), "accepted: marked");
        tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 00:10] human: @w next");
        assert!(!commit_person(&session, "w", "auth_expired|x", "auth_expired", tm::turn_version(&session, "w")), "once: the newer turn is not ended");
        assert_eq!(tm::derive(&session, "w", 0).state, "running");
        tm::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 review P2-1: an end recorded from the screen is our own
    /// bookkeeping, never proof that a `continue` took effect. Four unverified
    /// sends give up, the missed end is recorded (recovery_exhausted), and the
    /// next tick still gives up, it does not report "took effect". A real
    /// hook end afterwards is evidence again.
    #[test]
    fn a_missed_end_is_not_evidence_that_a_continue_took_effect() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let session = format!("p21-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 00:09] maker: @w go");
        let t0 = now_secs();
        let mut t = Tracker::default();
        let verified = |at: u64| tm::progress_since(&session, "w", at);
        for (n, at) in [(1, t0 + 10), (2, t0 + 40), (3, t0 + 100), (4, t0 + 220)] {
            assert_eq!(t.decide(&session, "w", at, "1|a", verified), Decision::Send { attempt: n });
        }
        assert_eq!(t.decide(&session, "w", t0 + 300, "1|a", verified), Decision::GiveUp { first: true });
        assert_eq!(tm::record_missed_end_at(&session, "w", EXHAUSTED, tm::Identity::Incident, tm::turn_version(&session, "w"), t0 + 301), tm::Missed::Ended);
        assert_eq!(t.decide(&session, "w", t0 + 320, "1|a", verified), Decision::GiveUp { first: false }, "our own end proves nothing");
        tm::record_notification_with_at(&session, "w", "completed", t0 + 330, crate::backends::EndQuality::Said);
        assert_eq!(t.decide(&session, "w", t0 + 340, "1|a", verified), Decision::Confirmed { first: true }, "the CLI's own end is evidence");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// Board #362 (orchestrator's ruling on the validator's P3): a REAL reply
    /// ends a capped stretch as a tool call does, so the next cap is said
    /// again. A turn end with no usable text, or the CLI's placeholder, is no
    /// evidence the model answered and changes nothing.
    #[test]
    fn a_real_reply_ends_a_capped_stretch_and_an_empty_one_does_not() {
        use crate::backends::EndQuality;
        let session = format!("cap-said-{}", uuid::Uuid::new_v4());
        let t0 = now_secs();
        let decide = |sig: &str, at: u64| tracker().lock().unwrap().decide(&session, "w", at, sig, |_| false);
        for (i, sig) in ["1|a", "1|b", "1|c"].iter().enumerate() {
            assert_eq!(decide(sig, t0 + i as u64), Decision::Send { attempt: 1 });
        }
        assert_eq!(decide("1|d", t0 + 3), Decision::Capped { first: true });
        for quality in [EndQuality::Unknown, EndQuality::Empty] {
            super::super::telemetry::record_notification_with_at(&session, "w", "completed", t0 + 4, quality);
            assert!(matches!(decide(&format!("1|{quality:?}"), t0 + 5), Decision::Capped { first: false }), "{quality:?} is no answer");
        }
        super::super::telemetry::record_notification_with_at(&session, "w", "completed", t0 + 6, EndQuality::Said);
        assert_eq!(decide("1|e", t0 + 7), Decision::Capped { first: true }, "a real reply: the next cap is a new stretch");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// Board #362 b: the warning names every shape measured on an older CLI
    /// than the one running, grouped by version, and nothing when none is.
    #[test]
    fn a_newer_cli_than_the_shapes_were_measured_on_is_said_once_in_words() {
        use crate::backends::Backend;
        assert_eq!(drift_warning(Backend::Kiro, "2.31.0").as_deref(), Some(
            "recovery shapes for kiro were measured on ≤ 2.18.1 (stream error, model unavailable) and 2.28.0 (high traffic, too many requests, conversation blocked), installed 2.31.0 (used at the next launch) — re-measure when one of them is next seen"));
        assert_eq!(drift_warning(Backend::Kiro, "2.28.0").as_deref(), Some(
            "recovery shapes for kiro were measured on ≤ 2.18.1 (stream error, model unavailable), installed 2.28.0 (used at the next launch) — re-measure when one of them is next seen"),
            "the upper-bound shapes are unmeasured on any kiro after 2.18.1");
        assert_eq!(drift_warning(Backend::Kiro, "2.18.1"), None);
        assert_eq!(drift_warning(Backend::Claude, "2.1.284"), None, "running what was measured");
        assert_eq!(drift_warning(Backend::Claude, "2.1.200"), None, "older than measured is not drift");
        assert!(drift_warning(Backend::Claude, "2.1.288").unwrap().contains("measured on 2.1.284 (Bedrock 5xx), installed 2.1.288 (used at the next launch)"));
        assert_eq!(drift_warning(Backend::Codex, "0.162.1").as_deref(), Some(
            "recovery shapes for codex were measured on 0.154.0 (auth expired), installed 0.162.1 (used at the next launch) — re-measure when one of them is next seen"),
            "codex joins the guard with its one person-needed shape");
        assert_eq!(drift_warning(Backend::Codex, "0.154.0"), None);
        assert_eq!(drift_warning(Backend::Grok, "1.0.5"), None, "no shape, nothing to drift");
        assert_eq!(drift_warning(Backend::Kiro, "garbage"), None);
    }

    /// Board #362 b, the posting, once per ROOM per change of installed
    /// version (reviewer P1; round 2): each room running the backend gets one line; a room
    /// whose post fails is told at the next pass and the room already told
    /// gets nothing extra; a room that starts running the backend later is
    /// told at the next pass; a restart (another pass) repeats nothing; a
    /// newer version is said again in every room, and so is a downgrade back; a project that does not run
    /// it hears nothing; a CLI that cannot be asked says nothing. The posts
    /// are recorded, not written to the shared test room log (a real post
    /// there took seq 1 from the legacy-import test running beside it).
    #[test]
    fn the_drift_warning_is_posted_once_per_room_and_version_and_a_missed_room_is_told_later() {
        use crate::backends::Backend;
        use std::cell::RefCell;
        super::super::tests::use_test_store();
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let mk = |name: &str| super::super::Project {
            id: format!("{name}-{tag}"), name: format!("{name}-{tag}"), path: format!("/tmp/drift-{name}-{tag}"), icon: None,
            session: format!("drift-{name}-{tag}"), adopted: false, autostart: false, created_at: 1_000,
            last_up_at: None, last_seen_at: None, archived: false, room: format!("room:{name}-{tag}"),
        };
        let (a, b, later, none) = (mk("a"), mk("b"), mk("later"), mk("none"));
        for p in [&a, &b, &later, &none] { super::super::with_store(|s| s.insert_project(p)).unwrap(); }
        let posted = RefCell::new(Vec::<(String, String)>::new());
        let failing = RefCell::new(vec![b.room.clone()]);
        let post = |room: &str, line: &str| {
            if failing.borrow().iter().any(|r| r == room) { return false; }
            posted.borrow_mut().push((room.to_string(), line.to_string()));
            true
        };
        let lines = |p: &super::super::Project| posted.borrow().iter().filter(|(r, _)| *r == p.room).map(|(_, l)| l.clone()).collect::<Vec<_>>();
        let version = RefCell::new(None::<&str>);
        let installed = |k: Backend| (k == Backend::Kiro).then(|| version.borrow().map(str::to_string)).flatten();
        let running = RefCell::new(vec![a.id.clone(), b.id.clone()]);
        let runs = |p: &super::super::Project, k: Backend| k == Backend::Kiro && running.borrow().contains(&p.id);
        assert_eq!(check_drift_with(&installed, &runs, &post), 0, "kiro cannot be asked: nothing said");
        *version.borrow_mut() = Some("2.31.0");
        assert_eq!(check_drift_with(&installed, &runs, &post), 1, "a is told; b's post fails");
        assert_eq!((lines(&a).len(), lines(&b).len()), (1, 0));
        assert!(lines(&a)[0].starts_with("[tmm] recovery shapes for kiro") && lines(&a)[0].contains("installed 2.31.0 (used at the next launch)"));
        // b recovers, and `later` starts running kiro: both are told at the next pass; a is not told again.
        failing.borrow_mut().clear();
        running.borrow_mut().push(later.id.clone());
        assert_eq!(check_drift_with(&installed, &runs, &post), 2);
        assert_eq!((lines(&a).len(), lines(&b).len(), lines(&later).len()), (1, 1, 1));
        assert!(lines(&none).is_empty(), "a project that does not run kiro hears nothing");
        assert_eq!(check_drift_with(&installed, &runs, &post), 0, "a restart or the daily check repeats nothing");
        *version.borrow_mut() = Some("2.32.1");
        assert_eq!(check_drift_with(&installed, &runs, &post), 3, "a newer CLI is said again in every room that runs it");
        // A downgrade is a change too (orchestrator, round 2): the room keeps the LAST version told.
        *version.borrow_mut() = Some("2.31.0");
        assert_eq!(check_drift_with(&installed, &runs, &post), 3, "back to 2.31.0 is said again");
        assert_eq!(check_drift_with(&installed, &runs, &post), 0);
        for p in [&a, &b, &later, &none] { let _ = super::super::with_store(|s| s.delete_project(&p.id)); }
    }

    /// Board #362, reviewer P2-2: ONE deadline for the start, the exit and
    /// the read. Controllable wrappers, never a real CLI: a plain answer is
    /// read; the caller returns at the limit on a hang, and on a wrapper that
    /// exits at once while a child it forked keeps stdout open (the read
    /// alone would wait for the child); a failing exit is not read.
    #[test]
    fn the_version_probe_is_bounded_end_to_end_and_reads_only_a_success() {
        let sh = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let limit = std::time::Duration::from_millis(800);
        assert_eq!(version_output(sh("echo 'kiro-cli 2.31.0'"), limit).as_deref(), Some("kiro-cli 2.31.0\n"));
        for (what, script) in [("a hang", "sleep 30"), ("a parent that exits while its child holds stdout", "(sleep 30; echo late) & echo early")] {
            let t0 = std::time::Instant::now();
            assert_eq!(version_output(sh(script), limit), None, "{what}");
            assert!(t0.elapsed() < limit + std::time::Duration::from_millis(700), "{what}: cut at the limit, took {:?}", t0.elapsed());
        }
        assert_eq!(version_output(sh("echo 'kiro-cli 2.31.0'; exit 3"), limit), None, "a failing exit is not read");
        assert_eq!(version_output(std::process::Command::new("/nonexistent/tmm-no-such-cli"), limit), None, "not installed");
    }

    /// Board #362, reviewer round 2: the caller returning at its deadline is
    /// not enough; the probe's own processes end with it, and ONLY its own.
    /// Each wrapper forks a child that writes its pid to a file, and after the
    /// probe returns that child is gone: under a leader that hangs, and
    /// holding stdout after its leader exited 0. A process outside the probe
    /// (in this test's own group, as the gateway's tmux and agents are in
    /// theirs) is alive after every probe. The cap STOPS the read: a child
    /// that keeps writing is read only up to the cap, and a LEADER that writes
    /// forever dies of SIGPIPE once the reader lets go of the pipe, long
    /// before the deadline (a read that ran on and only cut the answer would
    /// keep it alive until the deadline).
    #[test]
    fn the_version_probe_leaves_none_of_its_processes_and_reads_at_most_its_cap() {
        let limit = std::time::Duration::from_millis(1500);
        let alive = |pid: libc::pid_t| unsafe { libc::kill(pid, 0) } == 0;
        fn poll(what: &str, mut ok: impl FnMut() -> bool) {
            for _ in 0..100 {
                if ok() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("{what}");
        }
        let mut outside = std::process::Command::new("sleep").arg("30").spawn().expect("a process outside the probe");
        let outside_pid = outside.id() as libc::pid_t;
        let child = r#"sh -c 'echo $$ > "$PIDF"; exec sleep 30'"#;
        for (i, (what, script)) in
            [("a hang", format!("{child} & wait")), ("a child holding stdout after its leader exited 0", format!("{child} & echo early"))]
                .into_iter()
                .enumerate()
        {
            let pidf = std::env::temp_dir().join(format!("tmm-probe-{}-{i}", std::process::id()));
            let _ = std::fs::remove_file(&pidf);
            let mut cmd = std::process::Command::new("sh");
            cmd.args(["-c", &script]).env("PIDF", &pidf);
            let t0 = std::time::Instant::now();
            assert_eq!(version_output(cmd, limit), None, "{what}");
            assert!(t0.elapsed() < limit + std::time::Duration::from_millis(700), "{what}: returned at the limit, took {:?}", t0.elapsed());
            let mut pid: libc::pid_t = 0;
            poll(&format!("{what}: the child wrote its pid"), || {
                pid = std::fs::read_to_string(&pidf).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                pid > 1
            });
            poll(&format!("{what}: child {pid} outlived the probe"), || !alive(pid));
            let _ = std::fs::remove_file(&pidf);
            assert!(alive(outside_pid), "{what}: the probe signalled a process that is not its own");
        }
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sh -c 'while :; do echo 2.31.0; done' & sleep 0.3"]);
        let out = version_output(cmd, limit).expect("an endless writer is read up to the cap, not to the deadline");
        assert_eq!(out.len() as u64, VERSION_READ_CAP);
        assert!(out.starts_with("2.31.0\n"));
        let long = std::time::Duration::from_secs(5);
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "while :; do echo 2.31.0; done"]);
        let t0 = std::time::Instant::now();
        assert_eq!(version_output(cmd, long), None, "a leader killed by SIGPIPE did not succeed");
        assert!(t0.elapsed() < long / 2, "the read stopped at the cap and let go of the pipe: took {:?}", t0.elapsed());
        assert!(alive(outside_pid), "the probe signalled a process that is not its own");
        let _ = outside.kill();
        let _ = outside.wait();
    }

    /// Board #362 review P2-3: the probe's wait tells its failures apart.
    /// EINTR is asked again; ECHILD (the leader was reaped by someone else,
    /// shown here for real) means its pid may be reused, so nothing is
    /// signalled; any other failure leaves the leader's state unknown.
    #[test]
    fn the_probe_wait_tells_an_interrupt_from_a_reaped_leader_from_a_failure() {
        assert_eq!(classify_wait(0, 0, 42, 42), LeaderWait::Exited);
        assert_eq!(classify_wait(0, 0, 0, 42), LeaderWait::Running, "WNOHANG, nothing yet");
        assert_eq!(classify_wait(-1, libc::EINTR, 0, 42), LeaderWait::Interrupted);
        assert_eq!(classify_wait(-1, libc::ECHILD, 0, 42), LeaderWait::ReapedElsewhere);
        assert_eq!(classify_wait(-1, libc::EINVAL, 0, 42), LeaderWait::Failed(libc::EINVAL));
        // EINTR is retried, but only inside the one total deadline.
        let limit = std::time::Duration::from_millis(300);
        let t0 = std::time::Instant::now();
        assert_eq!(wait_until(t0 + limit, || LeaderWait::Interrupted), LeaderWait::Interrupted, "out of time");
        assert!(t0.elapsed() < limit + std::time::Duration::from_millis(200), "a stream of EINTR stops at the deadline: {:?}", t0.elapsed());
        let mut n = 0;
        assert_eq!(wait_until(t0 + std::time::Duration::from_secs(5), || { n += 1; if n < 3 { LeaderWait::Interrupted } else { LeaderWait::Exited } }), LeaderWait::Exited, "retried, then answered");
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        assert_eq!(leader_wait(pid), LeaderWait::Running);
        let _ = child.kill();
        let mut exited = false;
        for _ in 0..100 {
            if leader_wait(pid) == LeaderWait::Exited { exited = true; break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(exited, "an exited leader is seen, and not reaped by the asking");
        // Reaped by someone else: ECHILD.
        let mut status = 0;
        // SAFETY: reaping this test's own child, standing in for "someone else".
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert_eq!(leader_wait(pid), LeaderWait::ReapedElsewhere);
        drop(child); // std's Child never waits or kills on drop
    }

    /// Board #362, validator P3: once capped, the "paused" row is said ONCE
    /// for the stretch, however many fresh incidents follow; it is said again
    /// only after the cap cleared, by a ladder starting again (the window
    /// freed) or by the agent working again (a tool call).
    #[test]
    fn a_capped_agent_is_said_once_until_the_cap_clears() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        for (i, sig) in ["1|a", "1|b", "1|c"].iter().enumerate() {
            assert_eq!(t.decide("s", "w", t0 + i as u64 * 20, sig, silent), Decision::Send { attempt: 1 });
        }
        let said = |d: &Decision| matches!(d, Decision::Capped { first: true });
        let mut rows = 0;
        for i in 0..5u64 {
            let d = t.decide("s", "w", t0 + 60 + i * 20, &format!("1|x{i}"), silent);
            assert!(matches!(d, Decision::Capped { .. }), "{d:?}");
            rows += said(&d) as usize;
        }
        assert_eq!(rows, 1, "cap reached, 5 more fresh incidents: exactly one row");
        // The agent works again (a tool call): the stretch is over; the next cap is said.
        t.confirm("s", "w", 1);
        assert_eq!(t.decide("s", "w", t0 + 200, "1|y", silent), Decision::Capped { first: true });
        assert_eq!(t.decide("s", "w", t0 + 220, "1|z", silent), Decision::Capped { first: false });
        // The window frees: a ladder starts; capped again later, it is said again.
        assert_eq!(t.decide("s", "w", t0 + INCIDENT_WINDOW_SECS + 1, "1|m", silent), Decision::Send { attempt: 1 });
        assert_eq!(t.decide("s", "w", t0 + INCIDENT_WINDOW_SECS + 21, "1|n", silent), Decision::Send { attempt: 1 });
        assert_eq!(t.decide("s", "w", t0 + INCIDENT_WINDOW_SECS + 41, "1|o", silent), Decision::Send { attempt: 1 });
        assert_eq!(t.decide("s", "w", t0 + INCIDENT_WINDOW_SECS + 61, "1|p", silent), Decision::Capped { first: true });
        // Another window has its own stretch.
        for (i, sig) in ["2|a", "2|b", "2|c"].iter().enumerate() {
            t.decide("s", "v", t0 + i as u64, sig, silent);
        }
        assert_eq!(t.decide("s", "v", t0 + 10, "2|d", silent), Decision::Capped { first: true });
    }

    /// Board #362 e: at most `MAX_INCIDENTS` incidents START a ladder per
    /// window in `INCIDENT_WINDOW_SECS`. One incident's own retries are not
    /// incidents; the next fresh one in the window is not continued (said
    /// once) and stays so while it shows; a fresh one after the window is.
    #[test]
    fn fresh_incidents_are_capped_per_window_and_one_incidents_retries_are_not() {
        let mut t = Tracker::default();
        let t0 = 1_000_000;
        // Incident 1 runs its whole ladder: four sends, one incident.
        assert_eq!(t.decide("s", "w", t0, "1|a", silent), Decision::Send { attempt: 1 });
        assert_eq!(t.decide("s", "w", t0 + 30, "1|a", silent), Decision::Send { attempt: 2 });
        assert_eq!(t.decide("s", "w", t0 + 90, "1|a", silent), Decision::Send { attempt: 3 });
        assert_eq!(t.decide("s", "w", t0 + 210, "1|a", silent), Decision::Send { attempt: 4 });
        // Incidents 2 and 3: a fresh Request ID each, ~20 s apart (the live loop).
        assert_eq!(t.decide("s", "w", t0 + 230, "1|b", silent), Decision::Send { attempt: 1 });
        assert_eq!(t.decide("s", "w", t0 + 250, "1|c", |_| true), Decision::Send { attempt: 1 });
        // The 4th fresh incident in the window is not continued.
        assert_eq!(t.decide("s", "w", t0 + 270, "1|d", silent), Decision::Capped { first: true });
        assert_eq!(t.decide("s", "w", t0 + 290, "1|d", silent), Decision::Capped { first: false }, "said once");
        // Still showing after the window frees: still a person's.
        assert_eq!(t.decide("s", "w", t0 + INCIDENT_WINDOW_SECS + 300, "1|d", silent), Decision::Capped { first: false });
        // Leaving the screen does not reset the window's count.
        t.clear("s", "w");
        assert_eq!(t.decide("s", "w", t0 + 300, "1|e", silent), Decision::Capped { first: false }, "the count outlives the record, and the cap was already said");
        // A fresh incident once the oldest ladder has aged out is continued.
        assert_eq!(t.decide("s", "w", t0 + INCIDENT_WINDOW_SECS + 1, "1|f", silent), Decision::Send { attempt: 1 });
        // Another window has its own count.
        assert_eq!(t.decide("s", "other", t0 + 300, "1|z", silent), Decision::Send { attempt: 1 });
        // A window that goes away takes its count with it.
        t.retain_windows("s", &["other".to_string()]);
        assert_eq!(t.decide("s", "w", t0 + 301, "1|g", silent), Decision::Send { attempt: 1 });
    }


    /// Board #473, R1 (80 columns, 15 s after one reset with the reconnect
    /// allowed): kiro retried by itself (`streamErrorRetry`) and is streaming
    /// again under its working footer. No error is painted, so nothing at all
    /// is read, let alone typed.
    const KIRO_234_SELF_RETRY: &str = "  zone, the strip of shore alternately covered and uncovered by the sea.\n  Organisms living there must endure crashing waves, wide swings in temperature,\n  drying air, and changes in salinity as rain or evaporation alters the water\n  left in tide pools. Barnacles clamp shut to hold moisture. Mussels attach\n  themselves with strong threads. Sea stars, crabs, anemones, and snails each\n  occupy different heights on the shore, creating bands of life that reflect how\n  long each species can tolerate exposure.\n  \n  Tides also deliver food and oxygen, flush wastes, and move larvae and\n  nutrients. Salt marshes and mangrove forests depend on tidal flooding to\n  distribute sediment and sustain the nurseries that support fisheries. Many\n  shorebirds time their feeding to the falling tide, when mudflats reveal worms\n  and mollusks. Some animals go further: certain fish and crabs time their\n  spawning to particular tides, releasing eggs when currents will carry them\n  safely out to sea.\n  \n  Human Uses and Challenges\n  \n  People have always organized their lives around the tides. Fishermen and\n  sailors learned to read them long before anyone could explain them. Harbors\n  with shallow entrances can be used only at high water, and strong tidal\n  currents can help or hinder a vessel by several knots. Early tide tables,\n  compiled from careful observation, were treasured navigational tools. Today,\n  tidal predictions rely on harmonic analysis, which breaks the observed tide\n  into dozens of components, each corresponding to a periodic astronomical\n  influence, and then recombines them to forecast future water levels with\n  remarkable accuracy.\n  \n  Tides are also a source of energy. Unlike wind or sunlight, they are\n  predictable years\n\n────────────────────────────────────────────────────────────────────────────────\n Trust All Tools active, confirmations are off · /quit to exit\n────────────────────────────────────────────────────────────────────────────────\nrig · auto · ◔ 1% · Midway: expired                            /tmp/kiro473/work\n\n›  Kiro is working · 23s · Type to steer · Ctrl+S to queue\n";
    /// kiro-cli 2.34.0's working footer, as R1 painted it during the turn.
    const KIRO_234_WORKING: &str = "›  Kiro is working · 8s · Type to steer · Ctrl+S to queue";
    /// kiro's idle composer line, as every 2.28+ capture above paints it.
    const KIRO_IDLE_LINE: &str = "›  ask a question or describe a task ↵";

    /// Board #473: the two network failures are kiro's own shapes on every
    /// capture (wide, narrow, live). They carry no Request ID, so the hit
    /// count is the signature, as for claude's 5xx; two errors are two hits.
    #[test]
    fn kiro_2_34_network_errors_are_detected() {
        for (what, text, shape) in [
            ("R2, 80 columns", KIRO_234_CONN_SCREEN, "connection_interrupted"),
            ("R9, 44 columns", KIRO_234_CONN_NARROW, "connection_interrupted"),
            ("the live incident, 52 columns", KIRO_234_CONN_LIVE, "connection_interrupted"),
            ("R8, 44 columns", KIRO_234_NET_NARROW, "network_error"),
        ] {
            assert_eq!(reading_within("kiro", text, 40), Some(Reading { sig: "1|".into(), shapes: vec![shape], ids: vec![] }), "{what}");
        }
        let both = reading_within("kiro", KIRO_234_BOTH_SCREEN, 40).unwrap();
        assert_eq!(both, Reading { sig: "2|".into(), shapes: vec!["connection_interrupted", "network_error"], ids: vec![] }, "screen order");
        for glyph in HEADS {
            assert!(scan_tail("kiro", &KIRO_234_CONN_LIVE.replace('•', &glyph.to_string())), "{glyph}");
        }
        assert_eq!(read_capture("kiro", KIRO_234_SELF_RETRY, || panic!("no deep capture")), None, "kiro's own retry worked: nothing");
    }

    /// The same sentences QUOTED, reworded, cut or under another head are
    /// not having the error: a false hit types `continue` into a working kiro.
    #[test]
    fn quoting_the_network_errors_is_not_having_it() {
        for sentence in [
            "Your connection was interrupted. Please try again in a moment.",
            "A network error occurred. Please check your connection and try again.",
        ] {
            assert!(scan_tail("kiro", &format!("• {sentence}\n")), "the control: {sentence}");
            for (bad, why) in [
                (format!("  › [tmm chat 2026-10-27 15:48] orchestrator: • {sentence}\n"), "a delivered quote"),
                (format!("[tmm chat 2026-10-27 15:48] human: • {sentence}\n"), "a stamped quote"),
                (format!("• Shell tmm board show 473\n  ╰ output:\n    • {sentence}\n"), "tool output under a tool head"),
                (format!("• kiro painted \"{sentence}\" at 13:40\n"), "prose about it"),
                (format!("• {sentence} I will retry.\n"), "text after it"),
                (format!("• {}\n", &sentence[..sentence.len() - 1]), "cut short"),
                (format!("• {}\n", sentence.replace("Please", "please")), "reworded"),
                (format!("■ {sentence}\n"), "an unmeasured head glyph"),
                (format!("{sentence}\n"), "no head at all"),
            ] {
                assert!(!scan_tail("kiro", &bad), "{why}: {bad}");
            }
            for b in ["claude", "codex", "grok", "omp", "kimi"] {
                assert!(!scan_tail(b, &format!("● {sentence}\n")) && !scan_tail(b, &format!("• {sentence}\n")), "{b}: kiro's shape alone");
            }
        }
    }

    /// `screen` with `insert` painted under its newest error, before the
    /// turn's `▸` line: what kiro shows once the pane moved on.
    fn under_error(screen: &str, insert: &str) -> String {
        let mut s = screen.to_string();
        let at = s.rfind("\n▸ ").expect("a turn line under the error") + 1;
        s.insert_str(at, insert);
        s
    }

    /// Board #473, the shape × screen grammar × eligibility table, WHOLE
    /// screens. A gated shape (its `screen_grammar` measured) may be
    /// continued only while an error is the newest block of the same
    /// capture; the pane having moved on (a submitted prompt, the working
    /// footer, a tool call, a typed composer) types nothing, though the error
    /// is still DETECTED. kiro's two ≤ 2.18.1 shapes and claude's 5xx were
    /// never measured that way and keep the ungated send, also beside a gated
    /// hit: the explicit compatibility boundary.
    #[test]
    fn send_eligibility_follows_the_shape_table() {
        use crate::backends::{measured_version, Backend::{Claude, Kiro}};
        let gated = |b, s| measured_version(b, s).unwrap().screen_grammar;
        for s in ["connection_interrupted", "network_error", "high_traffic", "too_many_requests"] {
            assert!(gated(Kiro, s), "{s} is gated");
        }
        for s in ["stream_error", "model_unavailable"] {
            assert!(!gated(Kiro, s), "{s}: grammar unmeasured, ungated");
        }
        assert!(!gated(Claude, "bedrock_5xx"), "claude: no newest-block grammar, ungated");
        // Composed screens are two REAL captures joined, labelled as such:
        // a 2.28.0 error block with the 2.28.0 idle composer line, and a
        // 2.28.0 rate-limit block with checker's 2.28.0 idle furniture.
        let opus = format!("{KIRO_228_OPUS}{KIRO_IDLE_LINE}\n");
        let tmr = format!("{TMR_BUILDER}{KIRO_228_IDLE}");
        for (what, screen, shape) in [
            ("R2 connection, 80 columns", KIRO_234_CONN_SCREEN, "connection_interrupted"),
            ("R9 connection, 44 columns", KIRO_234_CONN_NARROW, "connection_interrupted"),
            ("R8 network, 44 columns", KIRO_234_NET_NARROW, "network_error"),
            ("R10 connection, a wrapped credits turn line, 44 columns", KIRO_234_CONN_WRAPPED_TURN, "connection_interrupted"),
            ("composed live incident, 52 columns", KIRO_234_CONN_LIVE_SCREEN_COMPOSED, "connection_interrupted"),
            ("row B: resized 80 to 52, the status spilled down a column", KIRO_234_NET_SPILL_ROWB, "network_error"),
            ("R12: the same spill in another session", KIRO_234_NET_SPILL_R12, "network_error"),
            ("R12 back at 80 columns", KIRO_234_NET_BACK_WIDE_R12, "network_error"),
            ("row C: born at 44, the status cut to one line", KIRO_234_CONN_BORN44_ROWC, "connection_interrupted"),
            ("R5, two errors, the network one newest", KIRO_234_BOTH_SCREEN, "network_error"),
            ("2.22.1 high traffic, a real whole screen", HIGH_TRAFFIC_SCREEN, "high_traffic"),
            ("composed 2.28.0 high traffic", opus.as_str(), "high_traffic"),
            ("composed 2.28.0 too many requests", tmr.as_str(), "too_many_requests"),
        ] {
            let (r, deep) = read_capture("kiro", screen, || panic!("{what}: no deep capture")).unwrap_or_else(|| panic!("{what}: detected"));
            assert_eq!(deep, None, "{what}");
            assert_eq!(newest_shape("kiro", screen), Some(shape), "{what}");
            assert!(send_eligible("kiro", screen, &r.shapes), "{what}: eligible");
            for (moved, why) in [
                (screen.replace(KIRO_IDLE_LINE, KIRO_234_WORKING), "the working footer"),
                (screen.replace(KIRO_IDLE_LINE, "›  continue"), "a typed composer"),
                (under_error(screen, "  › continue\n\n"), "a submitted prompt"),
                (under_error(screen, "• Shell ls\n  ╰ output:\n    a.txt\n\n"), "a tool call"),
            ] {
                let r = reading_within("kiro", &moved, 40).unwrap_or_else(|| panic!("{what}, {why}: still detected"));
                assert!(!send_eligible("kiro", &moved, &r.shapes), "{what}, {why}: nothing is typed");
            }
        }
        // Ungated stays ungated: never the newest block by the 2.28+ grammar,
        // continued as before.
        for (what, b, screen) in [
            ("stream error", "kiro", REAL),
            ("stream error, wrapped, old box composer", "kiro", REAL_WRAPPED),
            ("model unavailable", "kiro", MODEL_ERR),
            ("claude 503, 100 columns", "claude", CLAUDE_503_WIDE),
            ("claude 503, 57 columns", "claude", CLAUDE_503_NARROW),
        ] {
            let r = reading_within(b, screen, 40).unwrap_or_else(|| panic!("{what}"));
            assert!(!error_is_newest(b, screen), "{what}: no measured grammar reads it");
            assert!(send_eligible(b, screen, &r.shapes), "{what}: the ungated send it always had");
        }
        // A legacy ungated hit beside a gated history hit keeps the send.
        let mixed = format!("{REAL}\n\n{tmr}").replace(KIRO_IDLE_LINE, KIRO_234_WORKING);
        let r = reading_within("kiro", &mixed, 400).unwrap();
        assert_eq!(r.shapes, ["stream_error", "too_many_requests"]);
        assert!(send_eligible("kiro", &mixed, &r.shapes), "any ungated hit: today's behaviour");
        let gated_only = tmr.replace(KIRO_IDLE_LINE, KIRO_234_WORKING);
        assert!(!send_eligible("kiro", &gated_only, &reading_within("kiro", &gated_only, 40).unwrap().shapes), "the gated hit alone types nothing");
    }

    /// The deep path (board #473): a headless visible screen is never judged
    /// on its own; the reading AND the eligibility come from the deep
    /// capture, which holds the real head and the current composer.
    #[test]
    fn a_deep_capture_decides_both_the_reading_and_the_eligibility() {
        let below = format!(" \n▸ Time: 9s\n{}\n{KIRO_228_IDLE}", "─".repeat(52));
        let headless: String = TMR_NARROW.lines().skip(1).map(|l| format!("{l}\n")).collect();
        let visible = format!("{headless}{below}");
        let deep = format!("earlier output\n\n{TMR_NARROW}{below}");
        assert!(headless_error_tail(&visible));
        assert!(!send_eligible("kiro", &visible, &["too_many_requests"]), "the visible screen alone has no head");
        let (r, got) = read_capture("kiro", &visible, || Some(deep.clone())).unwrap();
        assert_eq!(got.as_deref(), Some(deep.as_str()), "read from the deep capture");
        assert_eq!(r.shapes, ["too_many_requests"]);
        assert!(send_eligible("kiro", got.as_deref().unwrap(), &r.shapes), "head and idle composer: eligible");
        let busy = deep.replace(KIRO_IDLE_LINE, KIRO_234_WORKING);
        let (r, got) = read_capture("kiro", &visible.replace(KIRO_IDLE_LINE, KIRO_234_WORKING), || Some(busy.clone())).unwrap();
        assert!(!send_eligible("kiro", got.as_deref().unwrap(), &r.shapes), "head found, but a turn runs: nothing");
        assert_eq!(read_capture("kiro", &visible, || None), None, "no deep capture: nothing guessed");
    }

    /// P-1: the feed row's reason is the newest error's, else the only
    /// hit's, else the generic word; an older error never names a newer one.
    #[test]
    fn the_feed_row_names_the_newest_error() {
        let r = |b: &str, s: &str| reason(b, s, &reading_within(b, s, 400).unwrap().shapes);
        assert_eq!(r("kiro", KIRO_234_CONN_SCREEN), "connection interrupted");
        assert_eq!(r("kiro", KIRO_234_NET_NARROW), "network error");
        assert_eq!(r("kiro", KIRO_234_BOTH_SCREEN), "network error", "the newest of two");
        assert_eq!(r("kiro", &KIRO_234_BOTH_SCREEN.replace(KIRO_IDLE_LINE, KIRO_234_WORKING)), "transient error", "two hits, none the newest");
        assert_eq!(r("kiro", HIGH_TRAFFIC_SCREEN), "high traffic");
        assert_eq!(r("kiro", REAL), "stream error", "the only hit, ungated");
        assert_eq!(r("claude", CLAUDE_503_NARROW), "Bedrock 5xx");
    }

    /// An ineligible screen decides nothing (board #473), but a send already
    /// made is verified there, once. "Took effect" is said once per incident
    /// whichever door saw the progress first: the tick's check, or
    /// `note_answered` (a tool call, a real reply), which only records it.
    #[test]
    fn a_pending_send_is_verified_on_an_ineligible_screen_and_nothing_else_moves() {
        let mut t = Tracker::default();
        assert!(!t.verify_pending("s", "w", |_| true), "no incident");
        assert_eq!(t.decide("s", "w", 100, "turn:1", |_| false), Decision::Send { attempt: 1 });
        let before = t.send_mark("s", "w", "turn:1");
        assert!(!t.verify_pending("s", "w", |_| false), "no progress yet");
        assert_eq!(t.send_mark("s", "w", "turn:1"), before, "nothing spent or moved");
        assert!(t.verify_pending("s", "w", |sent| sent == 0), "it progressed after the send (the test wrapper sends at sequence 0)");
        assert!(!t.verify_pending("s", "w", |_| true), "said once");
        assert_eq!(t.decide("s", "w", 400, "turn:1", |_| true), Decision::Confirmed { first: false }, "a confirmed incident stays silent");
        // The progress seen by telemetry first: said by the next tick, once,
        // through whichever path it takes; and when the record clears unsaid.
        let mut t = Tracker::default();
        assert_eq!(t.decide("s", "w", 100, "turn:1", |_| false), Decision::Send { attempt: 1 });
        t.confirm("s", "w", 1);
        assert_eq!(t.decide("s", "w", 120, "turn:1", |_| false), Decision::Confirmed { first: true });
        assert_eq!(t.decide("s", "w", 140, "turn:1", |_| false), Decision::Confirmed { first: false });
        assert!(!t.verify_pending("s", "w", |_| true), "already said");
        let mut t = Tracker::default();
        assert_eq!(t.decide("s", "w", 100, "turn:1", |_| false), Decision::Send { attempt: 1 });
        t.confirm("s", "w", 1);
        assert!(t.verify_pending("s", "w", |_| false), "the busy screen says it");
        assert!(!t.clear("s", "w"), "said already");
        let mut t = Tracker::default();
        assert_eq!(t.decide("s", "w", 100, "turn:1", |_| false), Decision::Send { attempt: 1 });
        t.confirm("s", "w", 1);
        assert!(t.clear("s", "w"), "the error left the screen before any tick said it");
        // A progress with no send of ours to answer is nothing to say.
        let mut t = Tracker::default();
        t.confirm("s", "w", 1);
        assert!(!t.clear("s", "w"), "no send, no effect");
    }

    /// Board #473 end to end on real managed kiro panes: the R2 screen gets
    /// ONE `continue` over two ticks, named by its error; the same screen
    /// with a working turn under it gets none over two ticks and keeps its
    /// whole budget, so once it is idle the first attempt goes at once.
    #[test]
    fn a_managed_kiro_pane_painting_a_network_error_gets_one_continue_and_a_busy_one_none() {
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        for name in ["conn", "flip", "live", "wrap", "spill"] {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        }
        let idle = ws.join("idle.txt");
        std::fs::write(&idle, KIRO_234_CONN_SCREEN).unwrap();
        let busy = ws.join("busy.txt");
        std::fs::write(&busy, KIRO_234_CONN_SCREEN.replace(KIRO_IDLE_LINE, KIRO_234_WORKING)).unwrap();
        let show = |f: &std::path::Path| format!("cat {}; cat", f.display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "conn", "-c", &ws.to_string_lossy(), &show(&idle)])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        std::process::Command::new("tmux").args(["new-window", "-d", "-t", &session, "-n", "flip", "-c", &ws.to_string_lossy(), &show(&busy)]).status().unwrap();
        // The live incident's screen and R10: the turn line hard-wrapped
        // (reviewer P1-A), each eligible.
        for (name, text) in [("live", KIRO_234_CONN_LIVE_SCREEN_COMPOSED), ("wrap", KIRO_234_CONN_WRAPPED_TURN), ("spill", KIRO_234_NET_SPILL_R12)] {
            let f = ws.join(format!("{name}.txt"));
            std::fs::write(&f, text).unwrap();
            std::process::Command::new("tmux").args(["new-window", "-d", "-t", &session, "-n", name, "-c", &ws.to_string_lossy(), &show(&f)]).status().unwrap();
        }
        super::super::adopt(&session, Some("rec-473-test")).expect("adopt");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let notes = || -> Vec<String> {
            super::super::telemetry::recent_events(&session, 0).into_iter().map(|e| e.text).filter(|t| t.starts_with("auto-continue")).collect()
        };
        check_once();
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(500));
        let pane = |w: &str| crate::tmux::capture_pane_plain(&format!("{session}:{w}"), Some(0)).unwrap_or_default();
        assert!(pane("conn").contains("\ncontinue"), "the idle pane got the key: {:?}", pane("conn"));
        assert!(!pane("flip").contains("\ncontinue"), "a busy pane gets nothing");
        for w in ["live", "wrap", "spill"] {
            assert!(pane(w).contains("\ncontinue"), "{w}: the wrapped turn line and the resize spill are furniture: {:?}", pane(w));
        }
        let mut got = notes();
        got.sort();
        assert_eq!(got, ["auto-continue 1/4 — connection interrupted in conn", "auto-continue 1/4 — connection interrupted in live", "auto-continue 1/4 — connection interrupted in wrap", "auto-continue 1/4 — network error in spill"], "one send each over two ticks, named");
        // The busy pane's turn ends: the same error is now the newest block.
        std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:flip"), &show(&idle)]).status().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(pane("flip").contains("\ncontinue"), "now it gets the key: {:?}", pane("flip"));
        assert_eq!(notes().iter().filter(|n| n.ends_with(" in flip")).collect::<Vec<_>>(), ["auto-continue 1/4 — connection interrupted in flip"], "its first attempt, at once: the busy ticks spent nothing");
    }

    /// Board #473: a turn fact that lands between the decision and the
    /// keystrokes makes the screen stale. Nothing is typed, the send is taken
    /// back (no attempt, no backoff, no cap slot), and the next tick types
    /// the FIRST attempt at once.
    #[test]
    fn a_turn_fact_between_the_decision_and_the_send_cancels_it_at_no_cost() {
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473s");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/st");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let idle = ws.join("idle.txt");
        std::fs::write(&idle, KIRO_234_CONN_SCREEN).unwrap();
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "st", "-c", &ws.to_string_lossy(), &format!("cat {}; cat", idle.display())])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473s-test")).expect("adopt");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let notes = || -> Vec<String> {
            super::super::telemetry::recent_events(&session, 0).into_iter().map(|e| e.text).filter(|t| t.starts_with("auto-continue")).collect()
        };
        let pane = || crate::tmux::capture_pane_plain(&format!("{session}:st"), Some(0)).unwrap_or_default();
        AFTER_DECIDE.with(|f| {
            *f.borrow_mut() = Some(Box::new(|s: &str, w: &str| {
                super::super::telemetry::record_prompt(s, w, "a person typed this");
            }))
        });
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert!(AFTER_DECIDE.with(|f| f.borrow().is_none()), "the seam ran");
        assert!(!pane().contains("\ncontinue"), "a stale screen types nothing");
        assert!(notes().is_empty(), "nothing recorded");
        assert_eq!(tracker().lock().unwrap().send_mark(&session, "st", "1|"), SendMark::default(), "the send was taken back whole");
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert!(pane().contains("\ncontinue"), "the next tick types: {:?}", pane());
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in st"], "the FIRST attempt, at once");
    }

    /// Board #473: a shape's `screen_grammar` is a measured fact, held by its
    /// fixtures. Every row that says true has a whole-screen fixture the
    /// backend's grammar reads as that very shape (a transient one as the
    /// newest block, a person-needed one as its paint); no fixture of a row
    /// that says false is read that way, which is why it keeps the ungated
    /// send.
    #[test]
    fn a_shapes_screen_grammar_flag_is_held_by_its_fixtures() {
        for backend in crate::backends::Backend::ALL {
            for m in backend.recovery_shapes() {
                let read = |text: &str| {
                    newest_shape(backend.name(), text) == Some(m.shape) || backend.person_paint(text).is_some_and(|(s, _)| s == m.shape)
                };
                let whole = FIXTURES.iter().filter(|f| f.0 == backend.name() && f.1 == m.shape).any(|f| read(f.3));
                assert_eq!(whole, m.screen_grammar, "{} {}: screen_grammar says {}", backend.name(), m.shape, m.screen_grammar);
            }
        }
        // The legacy kiro screens with the old box composer are read by no grammar.
        for text in [REAL, REAL_WRAPPED, MODEL_ERR] {
            assert_eq!(newest_shape("kiro", text), None);
        }
    }

    /// Reviewer P1-A: kiro's hard-wrapped turn line is furniture only in its
    /// measured forms; anything else in the continuation's place means the
    /// pane moved on, and the error, still detected, is not the newest block.
    #[test]
    fn a_wrapped_turn_line_is_furniture_and_nothing_else_in_its_place_is() {
        for screen in [KIRO_234_CONN_WRAPPED_TURN, KIRO_234_CONN_LIVE_SCREEN_COMPOSED] {
            assert_eq!(newest_shape("kiro", screen), Some("connection_interrupted"));
        }
        let (cont, at) = ("  23s\n", KIRO_234_CONN_WRAPPED_TURN);
        assert_eq!(at.matches(cont).count(), 1);
        for (bad, why) in [
            ("  23s\n  › continue\n", "a submitted prompt under the wrap"),
            ("  23s\n  ╰ output:\n", "tool output under the wrap"),
            ("  23s and more\n", "text after the duration"),
            ("  soon\n", "not a duration"),
            ("\n  23s\n", "a blank between the line and its wrap"),
        ] {
            let moved = at.replace(cont, bad);
            assert!(reading_within("kiro", &moved, 40).is_some(), "{why}: still detected");
            assert_eq!(newest_shape("kiro", &moved), None, "{why}");
            assert!(!send_eligible("kiro", &moved, &["connection_interrupted"]), "{why}: nothing typed");
        }
    }

    /// Reviewer P2-B, through `check_once`: busy (ineligible) screens decide,
    /// spend and clear nothing. A send that got no hook keeps its ladder
    /// through busy ticks: back on the same idle screen it waits out its
    /// backoff instead of sending attempt 1 again. Then real progress (a
    /// tool call) is said once as "took effect", from a busy screen.
    #[test]
    fn a_confirmed_incident_through_a_busy_screen_and_back_types_nothing_more() {
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473c");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/cf");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let idle = ws.join("idle.txt");
        std::fs::write(&idle, KIRO_234_CONN_SCREEN).unwrap();
        let busy = ws.join("busy.txt");
        std::fs::write(&busy, KIRO_234_CONN_SCREEN.replace(KIRO_IDLE_LINE, KIRO_234_WORKING)).unwrap();
        let show = |f: &std::path::Path| format!("cat {}; cat", f.display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "cf", "-c", &ws.to_string_lossy(), &show(&idle)])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473c-test")).expect("adopt");
        let respawn = |f: &std::path::Path| {
            std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:cf"), &show(f)]).status().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        let notes = || -> Vec<String> {
            super::super::telemetry::recent_events(&session, 0).into_iter().map(|e| e.text).filter(|t| t.starts_with("auto-continue")).collect()
        };
        let attempts = || tracker().lock().unwrap().map.get(&(session.clone(), "cf".to_string())).map(|r| r.attempts);
        std::thread::sleep(std::time::Duration::from_millis(300));
        check_once();
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in cf"]);
        // No hook followed the keystrokes. The pane goes busy for two ticks.
        respawn(&busy);
        check_once();
        check_once();
        assert_eq!(attempts(), Some(1), "busy ticks keep the record and spend nothing");
        // The same idle screen again: the same incident, inside its backoff.
        respawn(&idle);
        check_once();
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert_eq!(notes().len(), 1, "no second send: attempt 2 waits out its 30 s");
        assert_eq!(attempts(), Some(1));
        assert!(!crate::tmux::capture_pane_plain(&format!("{session}:cf"), Some(0)).unwrap_or_default().contains("\ncontinue"), "the respawned idle pane got no key");
        // Real progress after the send, seen from a busy screen: said once.
        super::super::telemetry::record_tool(&session, "cf", "execute_bash", "ls");
        respawn(&busy);
        check_once();
        check_once();
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in cf", "auto-continue took effect — cf is working again"]);
    }

    /// The validator's row A, through `check_once` (board #473, P1-1): a
    /// persistent outage, driven as kiro drives it — each `continue` of ours
    /// is accepted (its prompt hook) and the resumed turn fails again with no
    /// hook. In a 24-row pane (row A's REAL screens, the third and fourth
    /// identical) and a 40-row one (COMPOSED from row A's own lines, the hit
    /// count growing), the agent gets three `continue`s, one per new failure,
    /// then "paused … needs a person" and the recovery_exhausted end; "took
    /// effect" is never said, because nothing progressed.
    #[test]
    fn a_persistent_outage_reaches_needs_a_person_in_a_short_and_a_tall_pane() {
        use super::super::telemetry as tm;
        let first = ROWA_2.find("▸ Time: 0s\n─").unwrap();
        let second = first + '▸'.len_utf8() + ROWA_2[first + '▸'.len_utf8()..].find("▸ Time: 0s").unwrap();
        let unit = &ROWA_2[first..second];
        let tall = |n: usize| format!("{}{}{}", &ROWA_2[..first], unit.repeat(n - 1), &ROWA_2[second..]);
        assert_eq!(tall(2), ROWA_2, "the composition rebuilds the real screen");
        for (rows, screens) in [
            (24, vec![ROWA_1.to_string(), ROWA_2.to_string(), ROWA_3.to_string(), ROWA_3.to_string()]),
            (40, (1..=4).map(tall).collect::<Vec<_>>()),
        ] {
            super::super::tests::use_test_store();
            let mut scratch = crate::tmux::Scratch::new(&format!("rec-473o{rows}"));
            let session = scratch.session("s");
            let ws = std::path::PathBuf::from(scratch.path());
            let home = ws.join(".tmm/agents/kr");
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
            let file = |n: usize| {
                let f = ws.join(format!("s{n}.txt"));
                std::fs::write(&f, &screens[n]).unwrap();
                format!("cat {}; cat", f.display())
            };
            let ok = std::process::Command::new("tmux")
                .args(["new-session", "-d", "-x", "80", "-y", &rows.to_string(), "-s", &session, "-n", "kr", "-c", &ws.to_string_lossy(), &file(0)])
                .status().map(|s| s.success()).unwrap_or(false);
            if !ok {
                eprintln!("no tmux server — skipping");
                return;
            }
            super::super::adopt(&session, Some(&format!("rec-473o{rows}-test"))).expect("adopt");
            let notes = || -> Vec<String> {
                tm::recent_events(&session, 0).into_iter().map(|e| e.text).filter(|t| t.starts_with("auto-continue")).collect()
            };
            tm::record_prompt(&session, "kr", "[tmm chat 2026-10-27 17:24] human: @kr reply with the word ok");
            std::thread::sleep(std::time::Duration::from_millis(300));
            check_once();
            assert_eq!(notes().len(), 1, "{rows} rows: the first failure");
            for n in 1..4 {
                // kiro accepts our continue; the resumed turn fails again.
                tm::record_prompt(&session, "kr", "continue");
                std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:kr"), &file(n)]).status().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(300));
                check_once();
                assert_eq!(notes().len(), n, "{rows} rows, failure {}: the moved turn settles first", n + 1);
                check_once();
                assert_eq!(notes().len(), n + 1, "{rows} rows, failure {}: read as a new failure", n + 1);
            }
            let got = notes();
            assert_eq!(got.iter().filter(|t| t.as_str() == "auto-continue 1/4 — connection interrupted in kr").count(), 3, "{rows} rows: three sends: {got:?}");
            assert_eq!(got[3], format!("auto-continue paused — {MAX_INCIDENTS} errors in 30 min were already continued; kr needs a person"), "{rows} rows");
            assert!(got.iter().all(|t| !t.contains("took effect")), "{rows} rows: nothing progressed: {got:?}");
            let st = tm::derive(&session, "kr", 0);
            assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", EXHAUSTED), "{rows} rows: the person is told");
            check_once();
            check_once();
            assert_eq!(notes().len(), 4, "{rows} rows: and nothing more");
            tracker().lock().unwrap().retain_windows(&session, &[]);
        }
    }

    /// Zero false sends (board #473, P1-1): a redraw or resize of the same
    /// error, with no turn fact, is the same incident, however many errors
    /// the new paint shows; it waits out its backoff.
    #[test]
    fn a_redrawn_error_with_no_turn_fact_is_the_same_incident() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473r");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/kr");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let file = |name: &str, text: &str| {
            let f = ws.join(name);
            std::fs::write(&f, text).unwrap();
            format!("cat {}; cat", f.display())
        };
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "kr", "-c", &ws.to_string_lossy(), &file("a.txt", ROWA_2)])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473r-test")).expect("adopt");
        let notes = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.starts_with("auto-continue")).count();
        std::thread::sleep(std::time::Duration::from_millis(300));
        check_once();
        assert_eq!(notes(), 1);
        for (name, text, rows) in [("b.txt", ROWA_1, "24"), ("c.txt", ROWA_3, "52"), ("d.txt", ROWA_2, "40")] {
            std::process::Command::new("tmux").args(["resize-window", "-t", &format!("{session}:kr"), "-y", rows]).status().unwrap();
            std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:kr"), &file(name, text)]).status().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
            check_once();
            check_once();
            assert_eq!(notes(), 1, "{name}: a repaint is no failure");
        }
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// P1-2 (board #473): the resize spill is furniture only in its measured
    /// layout; a prompt, tool output or typed text in the status region, or
    /// a character out of its column, still means nothing is typed.
    #[test]
    fn a_resized_status_spill_is_furniture_and_nothing_else_there_is() {
        for screen in [KIRO_234_NET_SPILL_ROWB, KIRO_234_NET_SPILL_R12] {
            assert_eq!(newest_shape("kiro", screen), Some("network_error"));
        }
        let at = KIRO_234_NET_SPILL_R12;
        let spill = "\n                                                   w\n";
        assert_eq!(at.matches(spill).count(), 1);
        for (bad, why) in [
            ("\n                                                  w\n", "a character one column in"),
            ("\n                                                    w\n", "a character one column out"),
            ("\n  › continue                                       w\n", "a prompt in the spill"),
            ("\n  ╰ output:\n                                                   w\n", "tool output in the region"),
            ("\nxx                                                 w\n", "text before the column"),
        ] {
            let moved = at.replace(spill, bad);
            assert!(reading_within("kiro", &moved, 40).is_some(), "{why}: still detected");
            assert_eq!(newest_shape("kiro", &moved), None, "{why}");
        }
        assert_eq!(newest_shape("kiro", &at.replace("/tmp/kiro473/work                                  i", "/tmp/kiro473/work")), None, "a cwd line with no spilled character");
        assert_eq!(newest_shape("kiro", &at.replace(KIRO_IDLE_LINE, "›  continue")), None, "a typed composer");
        assert_eq!(newest_shape("kiro", &at.replace(KIRO_IDLE_LINE, KIRO_234_WORKING)), None, "a working turn");
    }

    /// Review P1-B on f6c6b048: progress is a real tool call AFTER the send,
    /// or a VALID end the CLI sent after it, in arrival order. A person's
    /// interrupt (stored as a `completed` end), a `failed` end, an end we
    /// recorded from the screen, an accepted prompt, and a tool call in the
    /// same second but before the send are none of it.
    #[test]
    fn progress_is_a_real_tool_or_cli_end_after_the_send_in_fact_order() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let session = format!("prog-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session, "w", "go");
        tm::record_tool(&session, "w", "execute_bash", "before the send");
        let sent = tm::turn_version(&session, "w");
        assert!(!tm::progress_since(&session, "w", sent), "a tool call before the send, the same second");
        tm::record_prompt(&session, "w", "continue");
        assert!(!tm::progress_since(&session, "w", sent), "our continue accepted");
        tm::record_interrupt(&session, "w");
        assert!(!tm::progress_since(&session, "w", sent), "a person's Escape");
        tm::record_notification_with(&session, "w", "failed", crate::backends::EndQuality::Said);
        assert!(!tm::progress_since(&session, "w", sent), "a failed end");
        tm::record_prompt(&session, "w", "again");
        let open = tm::turn_version(&session, "w");
        assert_eq!(tm::record_missed_end_at(&session, "w", EXHAUSTED, tm::Identity::Incident, open, now_secs()), tm::Missed::Ended);
        assert!(!tm::progress_since(&session, "w", sent), "our own missed end");
        tm::record_tool(&session, "w", "execute_bash", "after the send");
        assert!(tm::progress_since(&session, "w", sent), "a tool call after the send");
        let later = tm::turn_version(&session, "w");
        assert!(!tm::progress_since(&session, "w", later));
        tm::record_notification_with(&session, "w", "completed", crate::backends::EndQuality::Said);
        assert!(tm::progress_since(&session, "w", later), "a CLI-sent end after the send");
    }

    /// Review P2-C on f6c6b048: a moved prompt settles only over two
    /// CONSECUTIVE eligible ticks; an ineligible tick between drops the
    /// candidate, never the incident or its budget.
    #[test]
    fn a_settling_prompt_needs_two_eligible_ticks_in_a_row() {
        let mut t = Tracker::default();
        assert_eq!(t.bind("s", "w", 1, None, |_| false), Some("turn:1".to_string()));
        assert_eq!(t.decide("s", "w", 100, "turn:1", |_| false), Decision::Send { attempt: 1 });
        t.remember_newest("s", "w", None);
        assert_eq!(t.bind("s", "w", 2, None, |_| false), None, "seen once");
        t.unsettle("s", "w");
        assert_eq!(t.bind("s", "w", 2, None, |_| false), None, "the busy tick broke the run: seen once again");
        assert_eq!(t.bind("s", "w", 2, None, |_| false), Some("turn:2".to_string()), "twice in a row");
        assert_eq!(t.send_mark("s", "w", "turn:1").attempts_for_test(), 1, "the incident kept its budget");
    }

    /// Review P1-A on f6c6b048, through `check_once`: a gated incident whose
    /// four sends got no answer gives up, records its turn end (which moves
    /// the all-facts version, never the prompt), and then stays silent: no
    /// new ladder, tick after tick.
    #[test]
    fn an_exhausted_gated_incident_stays_silent_after_its_end() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473x");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/kx");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let idle = ws.join("idle.txt");
        std::fs::write(&idle, KIRO_234_CONN_SCREEN).unwrap();
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "kx", "-c", &ws.to_string_lossy(), &format!("cat {}; cat", idle.display())])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473x-test")).expect("adopt");
        tm::record_prompt(&session, "kx", "[tmm chat 2026-10-27 17:24] human: @kx go");
        let key = format!("turn:{}", tm::prompt_seq(&session, "kx"));
        // Four unanswered sends, long ago (the tracker's clock is injected).
        let t0 = now_secs() - 10_000;
        for (n, at) in [(1, t0), (2, t0 + 30), (3, t0 + 90), (4, t0 + 210)] {
            assert_eq!(tracker().lock().unwrap().decide(&session, "kx", at, &key, |_| false), Decision::Send { attempt: n });
        }
        let ends = || tm::recent_events(&session, 0).into_iter().filter(|e| e.kind == "notif" && e.text == "failed").count();
        let notes = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.starts_with("auto-continue")).map(|e| e.text).collect::<Vec<_>>();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let before = tm::turn_version(&session, "kx");
        check_once();
        assert_eq!(ends(), 1, "the give-up records its end");
        assert!(tm::turn_version(&session, "kx") > before, "which moves the all-facts version");
        assert_eq!(notes(), ["auto-continue gave up after 4 attempts — kx needs a person"]);
        for _ in 0..4 {
            check_once();
        }
        assert_eq!(notes().len(), 1, "no new ladder: {:?}", notes());
        assert_eq!(ends(), 1);
        assert!(!crate::tmux::capture_pane_plain(&format!("{session}:kx"), Some(0)).unwrap_or_default().contains("\ncontinue"), "nothing typed");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// Review P1-A on f6c6b048, the return leg through `check_once`: our
    /// `continue` is accepted and the agent PROGRESSES (a tool call), the pane
    /// is busy, and then the same old error screen is idle again. The
    /// confirmed incident stays confirmed: nothing is typed, nothing more is
    /// said.
    #[test]
    fn a_progressed_incident_through_busy_and_back_types_nothing() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473p");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/kp");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let idle = ws.join("idle.txt");
        std::fs::write(&idle, KIRO_234_CONN_SCREEN).unwrap();
        let busy = ws.join("busy.txt");
        std::fs::write(&busy, KIRO_234_CONN_SCREEN.replace(KIRO_IDLE_LINE, KIRO_234_WORKING)).unwrap();
        let show = |f: &std::path::Path| format!("cat {}; cat", f.display());
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "kp", "-c", &ws.to_string_lossy(), &show(&idle)])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473p-test")).expect("adopt");
        let respawn = |f: &std::path::Path| {
            std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:kp"), &show(f)]).status().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        let notes = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.starts_with("auto-continue")).map(|e| e.text).collect::<Vec<_>>();
        std::thread::sleep(std::time::Duration::from_millis(300));
        check_once();
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in kp"]);
        tm::record_prompt(&session, "kp", "continue");
        tm::record_tool(&session, "kp", "execute_bash", "ls");
        respawn(&busy);
        check_once();
        assert_eq!(notes().len(), 2, "took effect, from the busy screen");
        respawn(&idle);
        for _ in 0..3 {
            check_once();
        }
        std::thread::sleep(std::time::Duration::from_millis(400));
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in kp", "auto-continue took effect — kp is working again"], "nothing more");
        assert_eq!(incident_confirmed_for_test(&session, "kp"), Some(true), "the confirmed record kept");
        assert!(!crate::tmux::capture_pane_plain(&format!("{session}:kp"), Some(0)).unwrap_or_default().contains("\ncontinue"), "nothing typed");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// Review P2-D on f6c6b048: the spill is read by its TEXT too. The same
    /// geometry whose rejoined line is not a status line, or whose cwd is not
    /// a path, is not furniture.
    #[test]
    fn a_resized_spill_must_rejoin_to_a_status_line() {
        let at = KIRO_234_NET_SPILL_R12;
        assert_eq!(newest_shape("kiro", at), Some("network_error"));
        let w = "\n                                                   w\n";
        assert_eq!(at.matches(w).count(), 1);
        for (bad, why) in [
            (at.replace(w, "\n                                                   q\n"), "rejoins to `Midqay: expired`"),
            (at.replace("/tmp/kiro473/work", "xtmp/kiro473/work"), "a cwd that is not a path"),
            (at.replace("kn · claude-haiku-5.5", "kn ! claude-haiku-5.5"), "segments that are not kiro's"),
            (at.replace("◔ 1%", "◔ 1x"), "no context gauge"),
        ] {
            assert!(reading_within("kiro", &bad, 40).is_some(), "{why}: still detected");
            assert_eq!(newest_shape("kiro", &bad), None, "{why}");
        }
    }

    /// COMPOSED from R2 and R9 (board #473): R2's screen as a 44-column pane
    /// shows it, its last paragraph re-wrapped greedily at 44 columns under
    /// kiro's two-space indent and R9's 44-column furniture under the error.
    fn reflow_44(screen: &str) -> String {
        let start = screen.find("  If accumulation and ablation").expect("R2's last paragraph");
        let end = screen.find("\n\n• Your connection").expect("R2's error");
        let mut out = String::new();
        let mut line = String::from(" ");
        for word in screen[start..end].split_whitespace() {
            if line.chars().count() + 1 + word.chars().count() > 44 {
                out.push_str(&line);
                out.push('\n');
                line = String::from(" ");
            }
            line.push(' ');
            line.push_str(word);
        }
        out.push_str(&line);
        let tail = &KIRO_234_CONN_NARROW[KIRO_234_CONN_NARROW.find("\n▸ Time").expect("R9's furniture")..];
        format!("{}{}\n\n• Your connection was interrupted. Please\n  try again in a moment.\n{}", &screen[..start], out, tail)
    }

    /// Review P1 on a2c33e52 and its 19:30 check points, through
    /// `check_once`: once our `continue` is accepted and the agent
    /// PROGRESSES, the same old error idle again with only the display
    /// changed (the Midway segment, the context gauge, a reflow to 44
    /// columns) and NO progress since the confirmation, tick after tick, is
    /// the same confirmed incident: one send in all. The resumed turn working
    /// on and dying again (the orchestrator's rulings 19:29 and 20:02) and a
    /// later prompt's failure are new incidents, one send each.
    #[test]
    fn a_confirmed_incident_survives_display_only_changes_and_a_new_failure_is_its_own() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473d");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/kd");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let file = |name: &str, text: &str| {
            let f = ws.join(name);
            std::fs::write(&f, text).unwrap();
            format!("cat {}; cat", f.display())
        };
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "kd", "-c", &ws.to_string_lossy(), &file("idle.txt", KIRO_234_CONN_SCREEN)])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473d-test")).expect("adopt");
        let respawn = |cmd: String| {
            std::process::Command::new("tmux").args(["respawn-pane", "-k", "-t", &format!("{session}:kd"), &cmd]).status().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        let sends = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.starts_with("auto-continue 1/4")).count();
        let said = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.contains("took effect")).count();
        std::thread::sleep(std::time::Duration::from_millis(300));
        tm::record_prompt(&session, "kd", "[tmm chat 2026-10-27 13:00] human: @kd go");
        check_once();
        assert_eq!(sends(), 1);
        // Accepted, and the agent works: progress after the send.
        tm::record_prompt(&session, "kd", "continue");
        tm::record_tool(&session, "kd", "execute_bash", "ls");
        respawn(file("busy.txt", &KIRO_234_CONN_SCREEN.replace(KIRO_IDLE_LINE, KIRO_234_WORKING)));
        check_once();
        assert_eq!(said(), 1);
        for (name, text, what) in [
            ("midway.txt", KIRO_234_CONN_SCREEN.replace("Midway: expired", "Midway: 3h 2m"), "the Midway segment"),
            ("gauge.txt", KIRO_234_CONN_SCREEN.replace("◔ 3%", "◔ 5%"), "the context gauge"),
            ("reflow.txt", reflow_44(KIRO_234_CONN_SCREEN), "the same screen reflowed to 44 columns"),
        ] {
            respawn(file(name, &text));
            let r = reading_within("kiro", &text, 400).unwrap();
            assert!(send_eligible("kiro", &text, &r.shapes), "{what}: an eligible screen, so the rule is what holds the send");
            for _ in 0..3 {
                check_once();
            }
            assert_eq!(sends(), 1, "{what}: no send");
            assert_eq!(incident_confirmed_for_test(&session, "kd"), Some(true), "{what}: still confirmed");
        }
        // The resumed turn works on (a later tool call) and dies again,
        // under the prompt of the continue that worked (the orchestrator's
        // rulings 19:29 and 20:02): progress after the confirmation and an
        // error the newest block is a new failure, one new incident and one
        // send.
        tm::record_tool(&session, "kd", "execute_bash", "cargo test");
        let same_turn = under_error(KIRO_234_CONN_SCREEN, "• Shell ls\n\n• Your connection was interrupted. Please try again in a moment.\n \n");
        respawn(file("same-turn.txt", &same_turn));
        check_once();
        assert_eq!(sends(), 1, "settling");
        check_once();
        assert_eq!(sends(), 2, "the second failure is its own incident");
        for _ in 0..3 {
            check_once();
        }
        assert_eq!(sends(), 2, "and gets one send");
        // A person's prompt and a third error under it: a new incident too.
        tm::record_prompt(&session, "kd", "[tmm chat 2026-10-27 13:10] human: @kd next");
        respawn(file("again.txt", &under_error(&same_turn, "  › next\n\n• Your connection was interrupted. Please try again in a moment.\n \n")));
        check_once();
        assert_eq!(sends(), 2, "settling");
        check_once();
        assert_eq!(sends(), 3, "a new failure is its own incident");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// Review P2 on e2ba9948, a REAL taller window through `check_once`: the
    /// pane is resized, tmux pulls history back into the visible screen, and
    /// the capture `check_once` reads really shows an OLDER error and its
    /// Request ID above the confirmed one. With no progress since the
    /// confirmation it is the same incident: zero further sends.
    #[test]
    fn a_taller_window_re_exposing_an_older_error_is_no_new_failure() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473g");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/kg");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        // An older high-traffic error with its Request ID, then the R2 screen.
        let f = ws.join("screen.txt");
        std::fs::write(&f, format!("{KIRO_228_WIDE}\n{KIRO_234_CONN_SCREEN}")).unwrap();
        let ok = std::process::Command::new("tmux")
            // No echo: our `continue` must not repaint the screen, so the same
            // old error stays the newest block once the window grows.
            .args(["new-session", "-d", "-x", "80", "-y", "30", "-s", &session, "-n", "kg", "-c", &ws.to_string_lossy(), &format!("stty -echo; cat {}; sleep 100000", f.display())])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473g-test")).expect("adopt");
        let target = format!("{session}:kg");
        let visible = || crate::tmux::capture_pane_plain(&target, Some(0)).unwrap_or_default();
        let sends = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.starts_with("auto-continue 1/4")).count();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let older = "b9b4f1e3-b712-42d8-8fa7-c85cafbd6085";
        assert!(!visible().contains(older), "at 30 rows the older error is above the screen");
        tm::record_prompt(&session, "kg", "[tmm chat 2026-10-27 13:00] human: @kg go");
        check_once();
        assert_eq!(sends(), 1);
        tm::record_prompt(&session, "kg", "continue");
        tm::record_tool(&session, "kg", "execute_bash", "ls");
        check_once();
        assert_eq!(incident_confirmed_for_test(&session, "kg"), Some(true));
        std::process::Command::new("tmux").args(["resize-window", "-t", &target, "-y", "60"]).status().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(400));
        let grown = visible();
        let reading = reading_within("kiro", &grown, 400).expect("still an error screen");
        assert!(reading.ids.iter().any(|i| i == older), "the taller capture re-exposes the older Request ID: {:?}", reading.ids);
        assert_eq!(reading.shapes.len(), 2, "two errors in the visible reading now");
        assert_eq!(newest_shape("kiro", &grown), Some("connection_interrupted"), "the newest error is still the confirmed one");
        assert_eq!(newest_request_id("kiro", &grown), None);
        assert!(send_eligible("kiro", &grown, &reading.shapes), "eligible, so the rule is what holds the send");
        for _ in 0..3 {
            check_once();
        }
        assert_eq!(sends(), 1, "a re-exposed older error is no new failure");
        assert_eq!(incident_confirmed_for_test(&session, "kg"), Some(true));
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// The orchestrator's ruling 20:02, at the tracker: a confirmed incident
    /// rebinds only after progress SINCE the confirmation, and a Request ID
    /// on both newest blocks is an extra equality check (the same ID is the
    /// same error whatever else holds). An incident never sent to rebinds
    /// only on another Request ID.
    #[test]
    fn a_confirmed_incident_rebinds_only_on_progress_since_and_never_on_its_own_id() {
        let id = |s: &str| Some(s.to_string());
        let confirmed = |bound: Option<String>| {
            let mut t = Tracker::default();
            assert_eq!(t.decide_seq("s", "w", 100, 5, "turn:1", |_| false), Decision::Send { attempt: 1 });
            t.remember_newest("s", "w", bound);
            t.confirm("s", "w", 9);
            t
        };
        // No progress since the confirmation: the same incident, twice in a row.
        let mut t = confirmed(None);
        for _ in 0..2 {
            assert_eq!(t.bind("s", "w", 2, None, |after| after < 9), Some("turn:1".to_string()));
        }
        // Progress after it (seq 10 > 9): a new failure, once settled.
        let mut t = confirmed(None);
        assert_eq!(t.bind("s", "w", 2, None, |after| after == 9), None, "settling");
        assert_eq!(t.bind("s", "w", 2, None, |after| after == 9), Some("turn:2".to_string()));
        // The same Request ID on both is the same error, progress or not.
        let mut t = confirmed(id("aaaa"));
        for _ in 0..2 {
            assert_eq!(t.bind("s", "w", 2, id("aaaa"), |_| true), Some("turn:1".to_string()));
        }
        // Another ID with progress: new.
        let mut t = confirmed(id("aaaa"));
        assert_eq!(t.bind("s", "w", 2, id("bbbb"), |_| true), None);
        assert_eq!(t.bind("s", "w", 2, id("bbbb"), |_| true), Some("turn:2".to_string()));
        // Never sent to (capped): only another Request ID.
        let mut t = Tracker::default();
        t.decide_seq("s", "w", 100, 5, "turn:1", |_| false);
        t.undo_send("s", "w", SendMark::default(), 100);
        t.remember_newest("s", "w", id("aaaa"));
        for _ in 0..2 {
            assert_eq!(t.bind("s", "w", 2, id("aaaa"), |_| true), Some("turn:1".to_string()), "its own ID");
            assert_eq!(t.bind("s", "w", 2, None, |_| true), Some("turn:1".to_string()), "no ID: no evidence");
        }
        assert_eq!(t.bind("s", "w", 2, id("bbbb"), |_| true), None);
        assert_eq!(t.bind("s", "w", 2, id("bbbb"), |_| true), Some("turn:2".to_string()));
    }

    /// Review P2-A on 0126b589: a confirmation is bound to the progress fact
    /// that made it, never to a later snapshot of every fact. A tool call
    /// confirms through `note_answered` with its own number; a valid end
    /// with no usable reply is confirmed by the tick, bound to the earliest
    /// progress after the send even when a prompt and an ask arrived before
    /// that tick. Progress after the binding is then still seen.
    #[test]
    fn a_confirmation_is_bound_to_its_progress_fact_not_a_later_snapshot() {
        use super::super::telemetry as tm;
        use crate::backends::EndQuality;
        super::super::tests::use_test_store();
        let session = format!("conf-{}", uuid::Uuid::new_v4());
        let conf = |t: &Tracker| t.map.get(&(session.clone(), "w".to_string())).and_then(|r| r.conf_seq);
        // The tick path.
        tm::record_prompt(&session, "w", "go");
        let mut t = Tracker::default();
        assert_eq!(t.decide_seq(&session, "w", 100, tm::turn_version(&session, "w"), "turn:1", |_| false), Decision::Send { attempt: 1 });
        tm::record_notification_with(&session, "w", "completed", EndQuality::Empty);
        let end = tm::turn_version(&session, "w");
        tm::record_prompt(&session, "w", "a person's next line");
        tm::record_notification_with(&session, "w", "input_required", EndQuality::Unknown);
        tm::record_tool(&session, "w", "execute_bash", "work before the tick");
        assert!(tm::turn_version(&session, "w") > end, "later facts landed before the tick");
        assert!(t.verify_pending(&session, "w", |after| tm::progress_since(&session, "w", after)));
        t.settle_conf(&session, "w", |after| tm::progress_seq_since(&session, "w", after));
        assert_eq!(conf(&t), Some(end), "bound to the end that confirmed it, the earliest progress after the send");
        tm::record_tool(&session, "w", "execute_bash", "later work");
        assert!(conf(&t).is_some_and(|c| tm::progress_since(&session, "w", c)), "later progress is seen");
        // The note_answered path: the tool call's own number.
        let session2 = format!("conf2-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session2, "w", "go");
        let sent = tm::turn_version(&session2, "w");
        assert_eq!(tracker().lock().unwrap().decide_seq(&session2, "w", 100, sent, "turn:1", |_| false), Decision::Send { attempt: 1 });
        tm::record_tool(&session2, "w", "execute_bash", "ls");
        let tool = tm::turn_version(&session2, "w");
        tm::record_prompt(&session2, "w", "a person's next line");
        let got = tracker().lock().unwrap().map.get(&(session2.clone(), "w".to_string())).and_then(|r| r.conf_seq);
        assert_eq!(got, Some(tool), "bound to the tool call that confirmed it");
        tracker().lock().unwrap().retain_windows(&session2, &[]);
    }

    /// Review P2-B on 0126b589: the same Request ID on both newest blocks is
    /// the same error in EVERY branch. An unanswered incident whose newest
    /// error keeps its ID under a moved prompt keeps its ladder (its backoff
    /// retries), it does not start a new one; another ID does, once settled.
    #[test]
    fn the_same_request_id_keeps_an_unanswered_incident_and_its_ladder() {
        let id = |s: &str| Some(s.to_string());
        let mut t = Tracker::default();
        assert_eq!(t.bind("s", "w", 1, id("aaaa"), |_| false), Some("turn:1".to_string()));
        assert_eq!(t.decide_seq("s", "w", 100, 5, "turn:1", |_| false), Decision::Send { attempt: 1 });
        t.remember_newest("s", "w", id("aaaa"));
        for at in [110, 120] {
            assert_eq!(t.bind("s", "w", 2, id("aaaa"), |_| false), Some("turn:1".to_string()), "the same ID: the same incident");
            assert_eq!(t.decide_seq("s", "w", at, 6, "turn:1", |_| false), Decision::Wait, "inside its backoff");
        }
        assert_eq!(t.decide_seq("s", "w", 130, 6, "turn:1", |_| false), Decision::Send { attempt: 2 }, "its own retry");
        assert_eq!(t.bind("s", "w", 2, id("bbbb"), |_| false), None);
        assert_eq!(t.bind("s", "w", 2, id("bbbb"), |_| false), Some("turn:2".to_string()), "another ID: a new incident");
        // Row A, id-less, is unchanged: our unanswered send, a settled moved prompt.
        let mut t = Tracker::default();
        assert_eq!(t.decide_seq("s", "w", 100, 5, "turn:1", |_| false), Decision::Send { attempt: 1 });
        t.remember_newest("s", "w", None);
        assert_eq!(t.bind("s", "w", 2, None, |_| false), None);
        assert_eq!(t.bind("s", "w", 2, None, |_| false), Some("turn:2".to_string()));
    }

    /// Review P2 on fd866766: a fact that arrived BEFORE our send confirms
    /// nothing. kiro's Pre tool hook lands, we type `continue`, and the
    /// same call's Post half is folded into the Pre (no fact of its own), so
    /// `note_answered` carries the Pre's number: the incident stays
    /// unconfirmed. A later real tool call confirms it.
    #[test]
    fn a_post_half_folded_into_a_pre_from_before_the_send_confirms_nothing() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let session = format!("fold-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session, "w", "go");
        tm::record_tool(&session, "w", "execute_bash", "sleep 15");
        let sent = tm::turn_version(&session, "w");
        assert_eq!(tracker().lock().unwrap().decide_seq(&session, "w", 100, sent, "turn:1", |_| false), Decision::Send { attempt: 1 });
        tm::record_tool(&session, "w", "execute_bash", "sleep 15");
        assert_eq!(tm::turn_version(&session, "w"), sent, "the Post half was folded: no fact of its own");
        assert_eq!(incident_confirmed_for_test(&session, "w"), Some(false), "the Pre predates the send");
        tm::record_tool(&session, "w", "execute_bash", "echo done");
        assert_eq!(incident_confirmed_for_test(&session, "w"), Some(true), "a tool call after the send confirms it");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }

    /// The same through `check_once` (board #473, review P2 on fd866766): a
    /// tool call whose Pre hook landed before our `continue` and whose Post
    /// half is folded in after it confirms nothing, so no "took effect" is
    /// said; a tool call after the send confirms it, said once.
    #[test]
    fn a_pre_send_tool_fact_confirms_nothing_through_check_once() {
        use super::super::telemetry as tm;
        super::super::tests::use_test_store();
        let mut scratch = crate::tmux::Scratch::new("rec-473f");
        let session = scratch.session("s");
        let ws = std::path::PathBuf::from(scratch.path());
        let home = ws.join(".tmm/agents/kf");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), serde_json::json!({ "backend": "kiro", "cmd": "kiro", "team": "" }).to_string()).unwrap();
        let idle = ws.join("idle.txt");
        std::fs::write(&idle, KIRO_234_CONN_SCREEN).unwrap();
        let ok = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-x", "80", "-y", "40", "-s", &session, "-n", "kf", "-c", &ws.to_string_lossy(), &format!("cat {}; cat", idle.display())])
            .status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("no tmux server — skipping");
            return;
        }
        super::super::adopt(&session, Some("rec-473f-test")).expect("adopt");
        let notes = || tm::recent_events(&session, 0).into_iter().filter(|e| e.text.starts_with("auto-continue")).map(|e| e.text).collect::<Vec<_>>();
        std::thread::sleep(std::time::Duration::from_millis(300));
        tm::record_prompt(&session, "kf", "[tmm chat 2026-10-28 15:00] human: @kf go");
        tm::record_tool(&session, "kf", "execute_bash", "sleep 15");
        check_once();
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in kf"]);
        // The same call's Post half, after the send: folded into the Pre.
        let before = tm::turn_version(&session, "kf");
        tm::record_tool(&session, "kf", "execute_bash", "sleep 15");
        assert_eq!(tm::turn_version(&session, "kf"), before, "folded: no fact of its own");
        for _ in 0..2 {
            check_once();
        }
        assert_eq!(incident_confirmed_for_test(&session, "kf"), Some(false), "a pre-send fact confirms nothing");
        assert_eq!(notes().len(), 1, "no took effect");
        // A tool call after the send.
        tm::record_tool(&session, "kf", "execute_bash", "echo done");
        check_once();
        check_once();
        assert_eq!(incident_confirmed_for_test(&session, "kf"), Some(true));
        assert_eq!(notes(), ["auto-continue 1/4 — connection interrupted in kf", "auto-continue took effect — kf is working again"], "said once");
        tracker().lock().unwrap().retain_windows(&session, &[]);
    }
}
