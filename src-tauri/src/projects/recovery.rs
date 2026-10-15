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
/// (validator / orchestrator 12:08, #280)? A shape belongs to the CLI that
/// paints it, and lives in that backend's file: kiro's prose uses the same
/// flush-left `●` bullet claude does, so a kiro pane showing claude's text
/// must never be typed into, and the reverse. An unknown or unmeasured
/// backend has no shape.
fn is_backend_error(backend: &str, glued: &str, spaced: &str) -> bool {
    crate::backends::Backend::parse(backend).is_some_and(|b| b.transient_error(glued, spaced))
}

fn signature_within(backend: &str, text: &str, window: usize) -> Option<String> {
    let blocks = paint_blocks(text, window);
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
        let key = (session.to_string(), window.to_string());
        if let Some(rec) = self.map.get_mut(&key) {
            rec.confirmed = true;
        }
        // The agent works again: a later cap is a new stretch, said again.
        self.capped_said.remove(&key);
    }

    /// The error is no longer on the window's screen: the incident is over,
    /// whatever its state was. The record is dropped so a FRESH error later
    /// starts a fresh incident with a full budget.
    pub fn clear(&mut self, session: &str, window: &str) {
        self.map.remove(&(session.to_string(), window.to_string()));
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

/// Test-only: the tracker's window housekeeping, as `check_once` runs it.
#[cfg(test)]
pub(crate) fn retain_windows_for_test(session: &str, live: &[String]) {
    tracker().lock().unwrap().retain_windows(session, live);
}

fn tracker() -> &'static Mutex<Tracker> {
    static T: OnceLock<Mutex<Tracker>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Tracker::default()))
}

/// Called by telemetry on every observed tool call and every turn end with a
/// real reply (board #362: the reply resets a capped stretch too): either is
/// proof the model answered, so an open incident is CONFIRMED (never erased —
/// see `Tracker::confirm` for the repeat-send that erasing caused).
pub fn note_answered(session: &str, window: &str) {
    tracker().lock().unwrap().confirm(session, window);
}

/// Record the turn end the hooks missed for a person-needed PAINT (board
/// #362 c): `sig` is `<shape>|<Request ID>`, its global identity, `detail`
/// what the person must do, and `seen` the turn-fact version read BEFORE
/// the screen was captured. Telemetry keeps the once durably
/// (`Identity::Paint`): an accepted paint never ends a later turn. True
/// when accepted.
fn commit_person(session: &str, window: &str, sig: &str, detail: &str, seen: u64, ts: u64) -> bool {
    use super::telemetry::{record_missed_end, Identity, Missed};
    matches!(record_missed_end(session, window, detail, Identity::Paint(sig), seen, ts), Missed::Ended | Missed::Attached)
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
fn commit_exhausted(session: &str, window: &str, capped: bool, newest: bool, seen: u64, ts: u64) -> bool {
    use super::telemetry::{record_missed_end, Identity, Missed};
    // Once per incident: defence in depth under the attribution rule, which
    // already refuses a second commit after our own end (a fact).
    if !tracker().lock().unwrap().exhausted_new(session, window) {
        return false;
    }
    if capped && !tracker().lock().unwrap().exhausted_attributable(session, window, newest, seen) {
        return false;
    }
    let accepted = matches!(record_missed_end(session, window, EXHAUSTED, Identity::Incident, seen, ts), Missed::Ended | Missed::Attached);
    if accepted {
        tracker().lock().unwrap().exhausted_accept(session, window);
    }
    accepted
}

/// Is the error `sig` names the NEWEST block of `tail`, by `backend`'s own
/// measured grammar (`Backend::newest_block`) and its own transient shape?
/// `false` where no grammar was measured (claude): unattributable.
fn error_is_newest(backend: &str, tail: &str) -> bool {
    let Some(b) = crate::backends::Backend::parse(backend) else { return false };
    b.newest_block(tail).is_some_and(|(glued, spaced)| {
        !crate::backends::canonical(&glued).contains("tmmchat") && b.transient_shape(&glued, &spaced).is_some()
    })
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
            let Ok(tail) = crate::tmux::capture_pane_plain(&target, Some(0)) else { continue };
            // An error only a person can clear, as the NEWEST paint (board
            // #362 c): its turn end is recorded once, the hooks having missed
            // it, and it is never continued. It is read first, so a transient
            // error still painted above it types nothing either.
            if let Some((shape, block)) = crate::backends::Backend::parse(backend).and_then(|b| b.person_paint(&tail)) {
                // Its Request ID is its identity (every measured shape ends
                // with one); without it nothing is recorded.
                if let Some(id) = extract_request_id(&block) {
                    commit_person(&project.session, &p.window_name, &format!("{shape}|{id}"), shape, seen, now_secs());
                }
                continue;
            }
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
            // Recovery stopped for this incident (capped or given up): the
            // agent needs a person, and the turn end the hooks never sent is
            // recorded once for the incident (board #362 c).
            if matches!(decision, Decision::Capped { .. } | Decision::GiveUp { .. }) {
                let capped = matches!(decision, Decision::Capped { .. });
                let newest = capped && error_is_newest(backend, &tail);
                commit_exhausted(&project.session, &p.window_name, capped, newest, seen, now_secs());
            }
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
        let name = m.shape.replace('_', " ");
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
        assert_eq!(notes, vec!["auto-continue 1/4 — transient model error in cl".to_string()], "one send, one record, over two ticks");
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
            tm::record_notification_with(&session, w, "completed", now_secs(), crate::backends::EndQuality::Said);
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
        for w in ["ki", "kp", "kh", "cl", "kr", "kq"] {
            assert_eq!(paused(w), 1, "{w}: the cap is still said");
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
        assert!(!commit_exhausted(&session, "w", true, true, seen, now_secs()), "stale");
        assert!(tracker().lock().unwrap().exhausted_new(&session, "w"), "nothing spent");
        assert!(matches!(decide("1|x"), Decision::Capped { first: false }));
        assert!(!commit_exhausted(&session, "w", true, true, tm::turn_version(&session, "w"), now_secs()), "a fact since the first sighting");
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
        // telemetry::record_tool → note_answered → confirm. The record
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
        let decide = |at: u64| tracker().lock().unwrap().decide(&session, "w", at, &sig, |t| tm::turn_fact_since(&session, "w", t));
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
            assert!(commit_exhausted(&session, "w", false, false, tm::turn_version(&session, "w"), now_secs()), "incident {n}: its turn gets its end");
            let st = tm::derive(&session, "w", 0);
            assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", EXHAUSTED), "incident {n}");
            assert_eq!(decide(base + 320), Decision::GiveUp { first: false });
            assert!(!commit_exhausted(&session, "w", false, false, tm::turn_version(&session, "w"), now_secs()), "incident {n}: one continuous incident is written once (the once flag: a give-up has no attribution rule over it)");
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
            ("a tool call", &|s| tm::record_tool(s, "w", "Bash", "npm test")),
            ("an ask", &|s| tm::record_notification(s, "w", "permission_required", now_secs())),
            ("a real hook end", &|s| tm::record_notification_with(s, "w", "completed", now_secs(), crate::backends::EndQuality::Said)),
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
            assert_eq!(tm::record_missed_end(&session, "w", "auth_expired", tm::Identity::Paint("auth_expired|x"), seen, now_secs()), tm::Missed::Stale, "{what}");
            assert!(!commit_person(&session, "w", "auth_expired|x", "auth_expired", seen, now_secs()), "{what}: not accepted");
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
        assert!(commit_person(&session, "w", "auth_expired|x", "auth_expired", seen, now_secs()));
        assert_eq!(tm::derive(&session, "w", 0).detail, "auth_expired");
        assert!(tm::accepted_paint(&session, "w", "auth_expired|x").unwrap().is_some(), "accepted: marked");
        tm::record_prompt(&session, "w", "[tmm chat 2026-10-16 00:10] human: @w next");
        assert!(!commit_person(&session, "w", "auth_expired|x", "auth_expired", tm::turn_version(&session, "w"), now_secs()), "once: the newer turn is not ended");
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
        let verified = |at: u64| tm::turn_fact_since(&session, "w", at);
        for (n, at) in [(1, t0 + 10), (2, t0 + 40), (3, t0 + 100), (4, t0 + 220)] {
            assert_eq!(t.decide(&session, "w", at, "1|a", verified), Decision::Send { attempt: n });
        }
        assert_eq!(t.decide(&session, "w", t0 + 300, "1|a", verified), Decision::GiveUp { first: true });
        assert_eq!(tm::record_missed_end(&session, "w", EXHAUSTED, tm::Identity::Incident, tm::turn_version(&session, "w"), t0 + 301), tm::Missed::Ended);
        assert_eq!(t.decide(&session, "w", t0 + 320, "1|a", verified), Decision::GiveUp { first: false }, "our own end proves nothing");
        tm::record_notification_with(&session, "w", "completed", t0 + 330, crate::backends::EndQuality::Said);
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
            super::super::telemetry::record_notification_with(&session, "w", "completed", t0 + 4, quality);
            assert!(matches!(decide(&format!("1|{quality:?}"), t0 + 5), Decision::Capped { first: false }), "{quality:?} is no answer");
        }
        super::super::telemetry::record_notification_with(&session, "w", "completed", t0 + 6, EndQuality::Said);
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
        assert!(drift_warning(Backend::Claude, "2.1.288").unwrap().contains("measured on 2.1.284 (bedrock 5xx), installed 2.1.288 (used at the next launch)"));
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
        t.confirm("s", "w");
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
}
