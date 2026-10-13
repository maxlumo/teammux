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
//!    means nothing. Before any retry the tracker asks whether a turn fact
//!    (accepted prompt, turn end, tool call — `telemetry::turn_fact_since`)
//!    arrived after the send; if one did the incident is CONFIRMED and goes
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
/// (validator / orchestrator 12:08, #280)? A shape belongs to the CLI that
/// paints it, and lives in that backend's file: kiro's prose uses the same
/// flush-left `●` bullet claude does, so a kiro pane showing claude's text
/// must never be typed into, and the reverse. An unknown or unmeasured
/// backend has no shape.
fn is_backend_error(backend: &str, glued: &str, spaced: &str) -> bool {
    crate::backends::Backend::parse(backend).is_some_and(|b| b.transient_error(glued, spaced))
}

fn signature_within(backend: &str, text: &str, window: usize) -> Option<String> {
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
    let mut hits = 0u32;
    let mut ids: Vec<String> = Vec::new();
    for (block, spaced) in &blocks {
        let c = crate::backends::canonical(block);
        // A block QUOTING the error (a chat delivery typed into the pane, or
        // its echo in the conversation) is not the agent having one — and a
        // quote's id must not pollute the signature either.
        if c.contains("tmmchat") {
            continue;
        }
        if !is_backend_error(backend, block, spaced) {
            continue;
        }
        hits += 1;
        if let Some(id) = extract_request_id(block) {
            ids.push(id);
        }
    }
    if hits == 0 {
        return None;
    }
    ids.sort();
    ids.dedup();
    Some(format!("{}|{}", hits, ids.join(",")))
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

#[derive(Default)]
struct Rec {
    /// Which error instance this incident is about (`error_signature`). A
    /// tick whose visible signature differs replaces the whole record: the
    /// SECOND error is a new incident with a full budget.
    sig: String,
    attempts: u32,
    /// Unix seconds before which no further attempt may run.
    next_at: u64,
    /// When the last `continue` was typed — the hook check measures from here.
    sent_at: u64,
    /// Hooks showed a turn fact after `sent_at`: the incident is OVER, even
    /// though the error text is still painted on the screen. Nothing more is
    /// sent until the error leaves the screen and a fresh one appears.
    confirmed: bool,
    /// The give-up warning is emitted once per incident, not once per tick.
    gave_up_reported: bool,
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
}

/// Pure bookkeeping, `now` and the hook check injected so every path is
/// testable without tmux or real hooks.
#[derive(Default)]
pub struct Tracker {
    map: HashMap<(String, String), Rec>,
}

impl Tracker {
    /// The error with signature `sig` is visible in (session, window) at
    /// `now` — what do we do? `verified(sent_at)` answers "did any turn fact
    /// arrive at/after that time" (see `telemetry::turn_fact_since`); it is
    /// consulted before any retry, so a `continue` that WORKED is never
    /// followed by another one just because the error text is still painted
    /// (owner, 2026-08-26). A DIFFERENT signature than the record's replaces
    /// it wholesale — confirmed, mid-backoff or given-up alike: whatever the
    /// old incident's state, a new error instance is a new incident (owner,
    /// 2026-08-26: "有可能还会出现二次报错并停止…就需要再次发送指令").
    pub fn decide(
        &mut self,
        session: &str,
        window: &str,
        now: u64,
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
            return Decision::Confirmed { first: false };
        }
        // A send exists: ask the hooks FIRST. Verification outranks both the
        // backoff ladder and the give-up — a 4th attempt that finally landed
        // is a success, not an exhausted budget.
        if rec.attempts > 0 && verified(rec.sent_at) {
            rec.confirmed = true;
            return Decision::Confirmed { first: true };
        }
        if rec.attempts >= MAX_ATTEMPTS {
            let first = !rec.gave_up_reported;
            rec.gave_up_reported = true;
            return Decision::GiveUp { first };
        }
        if now < rec.next_at {
            return Decision::Wait;
        }
        rec.attempts += 1;
        rec.sent_at = now;
        // 30s after the 1st attempt, 60s after the 2nd, 120s after the 3rd.
        rec.next_at = now + BASE_BACKOFF_SECS * (1 << (rec.attempts - 1));
        Decision::Send { attempt: rec.attempts }
    }

    /// A tool call from the window CONFIRMS an open incident — the model
    /// answered, so the `continue` (or something else) worked. It must never
    /// erase the record: the error text is still painted, and a wiped record
    /// made the next tick open a brand-new incident and type `continue` into
    /// the now-working agent — the repeat-send the owner reported
    /// (2026-08-26: "系统会反复发送好几次 auto recovery").
    pub fn confirm(&mut self, session: &str, window: &str) {
        if let Some(rec) = self.map.get_mut(&(session.to_string(), window.to_string())) {
            rec.confirmed = true;
        }
    }

    /// The error is no longer on the window's screen: the incident is over,
    /// whatever its state was. The record is dropped so a FRESH error later
    /// starts a fresh incident with a full budget.
    pub fn clear(&mut self, session: &str, window: &str) {
        self.map.remove(&(session.to_string(), window.to_string()));
    }

    /// Housekeeping: drop records for windows that no longer exist.
    pub fn retain_windows(&mut self, session: &str, live: &[String]) {
        self.map.retain(|(s, w), _| s != session || live.contains(w));
    }
}

fn tracker() -> &'static Mutex<Tracker> {
    static T: OnceLock<Mutex<Tracker>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Tracker::default()))
}

/// Called by telemetry on every observed tool call: work is proof the model
/// answered, so an open incident is CONFIRMED (never erased — see
/// `Tracker::confirm` for the repeat-send that erasing caused).
pub fn note_tool_activity(session: &str, window: &str) {
    tracker().lock().unwrap().confirm(session, window);
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
            let Ok(tail) = crate::tmux::capture_pane_plain(&target, Some(0)) else { continue };
            // The screen may open MID-BLOCK: a tall error paint plus the
            // prompt redraw pushes the block's header above a short pane's
            // fold, and a headless tail alone is never trusted. ONE deeper
            // capture brings the head back into view so it can be read
            // (2026-09-05: the kirocrew agent sat stalled under exactly such
            // a paint for half an hour).
            let sig = error_signature(backend, &tail).or_else(|| {
                if !headless_error_tail(&tail) {
                    return None;
                }
                crate::tmux::capture_pane_plain(&target, Some(DEEP_CAPTURE_LINES))
                    .ok()
                    .and_then(|deep| deep_error_signature(backend, &deep))
            });
            let Some(sig) = sig else {
                // The error left the screen: the incident (if any) is over.
                // Dropping the record here is what scopes "one incident" to
                // one CONTINUOUS sighting — a fresh error later starts fresh.
                tracker().lock().unwrap().clear(&project.session, &p.window_name);
                continue;
            };
            let decision = tracker().lock().unwrap().decide(
                &project.session,
                &p.window_name,
                now_secs(),
                &sig,
                |sent_at| super::telemetry::turn_fact_since(&project.session, &p.window_name, sent_at),
            );
            match decision {
                Decision::Send { attempt } => {
                    if crate::tmux::send_command(&target, CONTINUE_LINE).is_ok() {
                        super::telemetry::record_recovery(
                            &project.session,
                            &p.window_name,
                            &format!(
                                "auto-continue {attempt}/{MAX_ATTEMPTS} — transient model error in {}",
                                p.window_name
                            ),
                        );
                    }
                }
                Decision::Confirmed { first: true } => {
                    super::telemetry::record_recovery(
                        &project.session,
                        &p.window_name,
                        &format!("auto-continue took effect — {} resumed its turn", p.window_name),
                    );
                }
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
                Decision::Wait
                | Decision::Confirmed { first: false }
                | Decision::GiveUp { first: false } => {}
            }
        }
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
        assert_eq!(notes, vec!["auto-continue 1/4 — transient model error in cl".to_string()], "one send, one record, over two ticks");
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
        assert_eq!(t.decide("s", "w1", t0, "1|a", silent), Decision::Send { attempt: 1 });
        // Next tick, error still painted, but a turn fact arrived after the
        // send: confirmed ONCE, then silence for as long as the error shows.
        assert_eq!(
            t.decide("s", "w1", t0 + 20, "1|a", |sent| sent == t0),
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
        // telemetry::record_tool → note_tool_activity → confirm. The record
        // SURVIVES: erasing it here re-opened the incident on the next tick
        // (the error is still painted) and re-sent `continue` into a working
        // agent — the owner's repeat-send report (2026-08-26).
        t.confirm("s", "w1");
        assert_eq!(
            t.decide("s", "w1", t0 + 60, "1|a", silent),
            Decision::Confirmed { first: false }
        );
        // A tool call with no open incident is a no-op, not a new record.
        t.confirm("s", "w2");
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
            t.decide("s", "w1", t0 + 6_020, "2|a,b", |sent| sent == t0 + 6_000),
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
}
