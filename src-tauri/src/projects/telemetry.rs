//! Agent telemetry: the passive half of the v2 dual channel.
//!
//! What an agent SAYS goes through `hub_post`; what we OBSERVE arrives here:
//! hook notifications (it stopped, it
//! wants permission), the prompts it accepted, and tmux window activity. Status
//! is DERIVED from those facts at read time — an agent never fills in a form,
//! and a backend with poor hook coverage (codex) degrades to pane-activity
//! granularity instead of lying. A finished turn (Stop) is REST, not distress:
//! "stuck" detection by stop-without-done was a Team-supervisor-era rule and
//! mislabeled every long-idle direct agent. A turn that FAILED is rest too
//! (board #354): the end is the end, and the failure is a detail on the idle
//! state rather than a state of its own. See docs/exec-plans/agents-v2.md
//! §4.1/§4.3.
//!
//! `userPromptSubmit` carries the INPUT half, which nothing else does: a prompt
//! typed at the keyboard exists nowhere in the room, and a line we typed into a
//! pane is only *sent*, never *confirmed*. Recording both closes the loop —
//! `record_delivery` remembers what we typed, the echo acknowledges it, and
//! `sweep_deliveries` reports the ones that never arrived.
//!
//! The store is a process-global map keyed by (session, window index) — the
//! same granularity as a project slot and a hook notification. Records are
//! small and bounded by the number of live windows; entries for windows that
//! no longer exist are dropped opportunistically on write. Observations are
//! process-local on purpose (the next hook re-establishes them), with ONE
//! exception: the queue of lines we typed into a pane lives ONLY in state.db,
//! because the agent that will echo them is a separate process that outlives our
//! restarts — see the delivery block below (board #249).

use crate::backends::EndQuality;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Tool activity within this window means "working".
const ACTIVE_SECS: u64 = 30;
/// How long a line we typed into a pane may wait for its `userPromptSubmit`
/// echo before we call the delivery unconfirmed. Typing is `send-keys`, which
/// succeeds as long as the pane exists — it says nothing about whether the CLI
/// accepted the text as a prompt (a shell would have executed it, a crashed pane
/// swallows it). The hook echo is the only end-to-end proof, so an unacked line
/// is reported rather than assumed. The clock does NOT run while a turn is open:
/// a busy agent QUEUES what we typed by design, so it is measured from the turn's
/// end (see `overdue_rows`).
const DELIVERY_ACK_SECS: u64 = 45;
/// Prompt text kept per event. Long enough for a real instruction, short
/// enough that 120 of them stay a cheap in-memory ring.
const MAX_PROMPT_CHARS: usize = 1024;
/// How long an outstanding line stays worth recovering across a restart. Beyond
/// this the agent that would have echoed it is long gone, so resurrecting the
/// record would only produce a stale warning.
const PENDING_MAX_AGE_SECS: u64 = 24 * 3600;
/// How close two identical tool events have to be to count as the same call.
/// `preToolUse` and `postToolUse` arrive milliseconds apart; an agent genuinely
/// running the same command twice takes longer than this.
const TOOL_DEDUPE_SECS: u64 = 5;

#[derive(Debug, Clone, Default)]
struct Rec {
    /// Turn START: the `userPromptSubmit` hook. The agent accepted a prompt, so
    /// a turn is open from here until an end arrives.
    prompt: Option<u64>,
    /// Turn END: ("completed" | "failed", ts) from the stop / StopFailure hook.
    /// Separate from `ask` because they are different questions — "is a turn
    /// running" vs "is it blocked on me" — and one Option cannot answer both
    /// once a permission prompt overwrites a stop.
    end: Option<(String, u64)>,
    /// The agent is blocked on the human: permission_required | input_required.
    ask: Option<(String, u64)>,
    /// Last hook tool event: (activity line, ts). Work observed inside a turn.
    tool: Option<(String, u64)>,
    /// When each fact above ARRIVED, in the order of the durable activity log
    /// (board #249; see `arrival`). Hook timestamps are whole seconds, so a
    /// stop and the next prompt often share one; the old `end >= start` tie
    /// read that turn as idle, and the sweep reported its queued lines
    /// mid-turn. The order breaks only that tie; seconds stay the ordering
    /// authority. 0 = never set.
    prompt_seq: u64,
    end_seq: u64,
    ask_seq: u64,
    tool_seq: u64,
    /// `end_seq` of a turn end whose whole reply was the CLI's placeholder
    /// (board #355): the turn said nothing. Written in the SAME step as that
    /// end, from the arrival number the end itself took — never read back as
    /// "the newest end" afterwards, which an interrupt landing in between would
    /// have inherited (review P1-B). Compared with the CURRENT `end_seq`, so a
    /// later end of any kind simply stops matching. 0 = no such end.
    empty_end_seq: u64,
    /// A turn end the HOOKS never reported, recorded from the screen (board
    /// #362 c): the CLI painted an error only a person can clear and sat at
    /// its prompt, so without it the turn stayed `running` for hours. `(seq,
    /// detail)`: the arrival number that end took, and what the person must
    /// do (`auth_expired`, `conversation_blocked`, `recovery_exhausted`).
    /// Like `empty_end_seq`, compared with the CURRENT `end_seq`, so a later
    /// end of any kind, or a turn starting, simply stops matching. When the
    /// paint is seen on a turn that had already ended (an interrupt, say), the
    /// detail is put on that end and no second end is written. (0, "") = none.
    person_end: (u64, String),
    /// The persisted activity row id of the current end (`end`), 0 when it
    /// has none (its INSERT failed, or a test that does not persist). The
    /// one identity of an end that a restart keeps (board #362 review P1-C
    /// on f998b599: two ends often share a second, and `end_seq` is an
    /// in-process counter a restart rebuilds), so an accepted paint is bound
    /// to it.
    end_row: i64,
    /// `end_seq` of an end recorded from the screen (`record_missed_end`),
    /// not reported by the CLI: never evidence that the model answered
    /// (board #362 review P2-1). 0 = none.
    missed_end_seq: u64,
    /// A nudge was DELIVERED in the current run of empty turns. A scheduled one
    /// that was cancelled does not count — the allowance is spent by the line
    /// typed, not by the timer set — and only a turn that ends with a real reply
    /// forgives it (a Stop with no usable text neither spends nor forgives).
    nudge_spent: bool,
    /// Which run of empty turns the allowance belongs to: bumped each time a
    /// real reply forgives it. A nudge records its spend against the run it was
    /// decided in, so a write that arrives late cannot charge a newer run.
    nudge_run: u64,
    /// The lease on this window's nudge timer: 0 = free, else the token of the
    /// ONE timer that holds it. At most one per agent, so the number of sleepers
    /// is bounded by the number of windows; and only the holder can release it,
    /// so an old timer finishing after a new one took over cannot free the new
    /// one's lease (review P1-1: a bool could not tell whose it was).
    nudge_owner: u64,
}

/// Source of timer lease tokens: never 0, never reused.
static NEXT_NUDGE_TOKEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

static NEXT_ARRIVAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);


/// The next arrival number, in the persisted activity log's id order (board
/// #249, validator): the counter starts above the newest activity row id this
/// process finds, so a fact observed now always sorts after every fact an
/// earlier process wrote — a process-local counter restarting at 1 would sort
/// a new stop BEFORE a turn edge recovered from the log. 0 means "no fact".
/// Live facts take their order through `order_of`; tests build records by
/// hand with this.
#[cfg(test)]
fn arrival() -> u64 {
    seed_arrival();
    NEXT_ARRIVAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// A LIVE turn fact's order (orchestrator 15:48): ONE monotonic process
/// counter, taken inside the serialized `turn_fact` right after the fact's
/// insert, so live order is insert order by construction, and a failed insert
/// only skips its row. Row ids are never a live order: two number spaces were
/// the fail-soft bug (validator 15:47). The counter is seeded above the
/// newest activity id this process finds, so every live fact sorts after
/// every fact an earlier process wrote; those are ordered by their own row
/// ids when replayed (`recovered_arrival`), all below the seed.
fn order_of() -> u64 {
    seed_arrival();
    NEXT_ARRIVAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// A fact recovered from the durable log keeps its own row id as its order,
/// and the counter moves past it, so anything observed later sorts after it.
fn recovered_arrival(row_id: i64) -> u64 {
    seed_arrival();
    let id = row_id.max(1) as u64;
    NEXT_ARRIVAL.fetch_max(id + 1, std::sync::atomic::Ordering::Relaxed);
    id
}

fn seed_arrival() {
    static SEEDED: OnceLock<()> = OnceLock::new();
    SEEDED.get_or_init(|| {
        let top = queue(|s| s.max_activity_id()).unwrap_or(0).max(0) as u64;
        NEXT_ARRIVAL.fetch_max(top + 1, std::sync::atomic::Ordering::Relaxed);
    });
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentStatus {
    /// Derived state, one of exactly four: `running` (a turn is open — the
    /// agent accepted a prompt and has not stopped), `waiting` (blocked on the
    /// human), `idle` (no turn open) or `failed`.
    pub state: String,
    /// Human line explaining the state (what it asked for or the last observed
    /// tool call).
    pub detail: String,
    /// When the state began — the turn's start for `running`, so a client can
    /// render "running 2m14s" without keeping its own clock.
    pub since: u64,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Event timestamps are MILLISECONDS, and they have to be real ones. They were
/// `now() * 1000`, so every event inside the same second carried an identical
/// timestamp while chat messages carried true millis — the client's sort then
/// had nothing to order them by and a turn's tool calls could land after the
/// reply they produced.
fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The activity FEED: recent observed events per session, newest last. This
/// is telemetry made visible in the chat timeline (owner ask: show tool
/// calls / status changes between the final replies) — an in-memory ring,
/// NOT chat history: it never touches the bus db and dies with the server.
const EVENTS_CAP: usize = 120;
/// NOTHING is pruned from the durable log. This is a stated goal, not an
/// oversight: the owner wants the trace COMPLETE so it can be analysed (board #9,
/// 2026-08-29: "我希望整个 trace 是非常完整的，以便我们后续去做一些分析").
///
/// It used to keep 2000 events per session, pruned every 256 inserts. Measured on
/// this host the day it was removed: the busiest session held 4046 rows, so the
/// cap stood to delete the older HALF of it, and the only reason it had not is
/// that the prune counter was per process and every restart postponed it — an
/// accident, not a policy. And a deleted row is indistinguishable from an event
/// that never happened, which is exactly what makes a trace unanalysable. The
/// whole log is ~1.2 MB of text for ten days of heavy use, so there was nothing to
/// buy by trimming it.
///
/// If a retention is ever wanted it belongs in `Config` with a documented key, not
/// in an env var of its own — `Store::prune_activity` is the primitive it would
/// call. What is bounded instead is the READ (see `events_page`): the cost of a
/// long history belongs where it can be limited without destroying anything.
/// Events one page returns when the caller does not say. The tail of the history,
/// which is what a client renders first.
pub const LOAD_EVENTS: usize = 600;
/// The most a single page may return however the caller asks. A hard ceiling, so
/// one RPC can never turn into a multi-megabyte frame: measured on this host, the
/// newest 600 events of the busiest session already serialize to ~277 KB. It is a
/// PAGE cap, not a history horizon — `before_ts`/`before_id` walk as far back as
/// the log goes.
pub const MAX_PAGE_EVENTS: usize = 1000;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ActivityEvent {
    /// The durable log's row id, and the second half of the paging cursor: a busy
    /// turn writes several events inside one millisecond, so `ts` alone cannot
    /// address a position in the log. 0 for an event read from the in-memory ring
    /// (no database), which is also why a client must treat it as opaque.
    #[serde(skip_serializing_if = "is_zero")]
    pub id: i64,
    /// Epoch MILLISECONDS to merge directly with bus message timestamps.
    pub ts: u64,
    pub window: String,
    /// tool | status | notif | prompt | warn | steered (#276: lines typed
    /// into a busy steer turn, owed no echo; `deliveries[].msg` names them)
    pub kind: String,
    pub text: String,
    /// `tool` events only: the tool's NAME, kept apart from its argument so the
    /// client can render the scannable half differently. `text` is the argument.
    #[serde(skip_serializing_if = "str::is_empty")]
    pub tool: String,
    /// Provenance, `prompt` events only: `app` when the text is the line this
    /// app typed into the pane (so the event doubles as the delivery receipt),
    /// `local` when it was typed at the keyboard. Empty for every other kind.
    #[serde(skip_serializing_if = "str::is_empty")]
    pub via: String,
    /// `status` events only: the state the agent DECLARED. Kept apart from the
    /// note for the same reason a tool's name is — the client renders the two
    /// halves differently, and a note is the half a human reads.
    #[serde(skip_serializing_if = "str::is_empty")]
    pub state: String,
    /// The delivery rows this event is about (board #249). The ONE
    /// correlation key is the delivery row id: a `prompt` echo lists the rows
    /// it settled, a `warn` the one row it reported. `msg` is the chat message
    /// that row carries, where one exists. A client marks those messages
    /// delivered whether or not it has them loaded, draws no INPUT row for a
    /// settling echo, and drops a warn whose row a later echo settled. Empty
    /// for every other event and for rows before v24.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deliveries: Vec<DeliveryRef>,
    /// `prompt` events only: who the FULL prompt asks (`address::requesters`,
    /// board #257), written in the same INSERT as the row. Server-side only.
    #[serde(skip)]
    pub requesters: Option<Vec<String>>,
}

/// One delivery row named by an event: its id, and the message it carries.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeliveryRef {
    pub id: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub msg: String,
}

impl DeliveryRef {
    fn of(row: &super::store::DeliveryRow) -> Self {
        DeliveryRef { id: row.id, msg: row.msg_id.clone() }
    }
}

fn is_zero(n: &i64) -> bool {
    *n == 0
}

fn events() -> &'static Mutex<HashMap<String, std::collections::VecDeque<ActivityEvent>>> {
    static EVENTS: OnceLock<Mutex<HashMap<String, std::collections::VecDeque<ActivityEvent>>>> = OnceLock::new();
    EVENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn push_event(session: &str, window: &str, kind: &str, text: String) {
    push_full(session, window, kind, text, String::new(), String::new(), Vec::new());
}

fn push_full(session: &str, window: &str, kind: &str, text: String, tool: String, via: String, deliveries: Vec<DeliveryRef>) {
    let _ = push_full_at(session, window, now_ms(), kind, text, tool, via, deliveries);
}

#[allow(clippy::too_many_arguments)]
fn push_full_at(session: &str, window: &str, ts_ms: u64, kind: &str, text: String, tool: String, via: String, deliveries: Vec<DeliveryRef>) -> Option<i64> {
    push_full_with(session, window, ts_ms, kind, text, tool, via, deliveries, None)
}

#[allow(clippy::too_many_arguments)]
fn push_full_with(session: &str, window: &str, ts_ms: u64, kind: &str, text: String, tool: String, via: String, deliveries: Vec<DeliveryRef>, requesters: Option<Vec<String>>) -> Option<i64> {
    push(
        session,
        ActivityEvent {
            id: 0,
            ts: ts_ms,
            window: window.to_string(),
            kind: kind.into(),
            text,
            tool,
            via,
            state: String::new(),
            deliveries,
            requesters,
        },
    )
}

/// The one place the ring is appended to and trimmed. The event also goes to
/// state.db, because a restart used to erase the whole feed while the messages
/// around it survived: a conversation with holes in it.
/// Returns the row id the event was written as, when it was written.
fn push(session: &str, ev: ActivityEvent) -> Option<i64> {
    let id = persist(session, &ev);
    ring_push(session, ev);
    id
}

/// The in-memory half of `push`, for a row already persisted by its caller.
fn ring_push(session: &str, ev: ActivityEvent) {
    let mut map = events().lock().unwrap();
    let q = map.entry(session.to_string()).or_default();
    q.push_back(ev);
    while q.len() > EVENTS_CAP {
        q.pop_front();
    }
}

/// Unit tests exercise the ring and the derive rules; the durable log is tested
/// directly in `store.rs`. Keeping the two apart is what stops `cargo test` from
/// writing rows for invented sessions into the developer's real state.db.
#[cfg(test)]
fn persist(session: &str, ev: &ActivityEvent) -> Option<i64> {
    // Off by default in tests; one test may opt in on its own thread after
    // pointing the process at a throwaway database (board #249: the fail-soft
    // order is tested against a REAL failed INSERT).
    if PERSIST_IN_TEST.with(|p| p.get()) {
        persist_now(session, ev)
    } else {
        None
    }
}

#[cfg(test)]
thread_local! {
    pub(crate) static PERSIST_IN_TEST: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
#[cfg(not(test))]
thread_local! {
    static PERSIST_IN_TEST: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Write one event to the durable log. FAIL-SOFT, always: telemetry may never
/// block or break the thing it observes, and the ring is still there for this
/// process's lifetime if the database is unavailable (a mobile build, a
/// read-only disk).
#[cfg(not(test))]
fn persist(session: &str, ev: &ActivityEvent) -> Option<i64> {
    persist_now(session, ev)
}

fn persist_now(session: &str, ev: &ActivityEvent) -> Option<i64> {
    let written = super::with_store(|s| {
        let refs = if ev.deliveries.is_empty() { String::new() } else { serde_json::to_string(&ev.deliveries).unwrap_or_default() };
        let requesters = ev.requesters.as_ref().map(|r| serde_json::to_string(r).unwrap_or_default());
        s.insert_activity_with(session, &ev.window, ev.ts, &ev.kind, &ev.text, &ev.tool, &ev.via, &ev.state, &refs, requesters.as_deref())
    });
    if let Err(e) = &written {
        // Fail-soft, but not SILENT: a lost write is a hole in the trace, and the
        // whole point of the log is that it is complete. Reported on the first
        // failure and every 100th after that, so a broken database is visible in
        // the server log without becoming the server log.
        static FAILURES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = FAILURES.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        if n == 1 || n % 100 == 0 {
            eprintln!("⚠️  activity log write failed ({n} so far): {e}");
        }
    }
    // And that is all: no prune. The trace is kept whole (see the note on
    // EVENTS_CAP / LOAD_EVENTS) and the READ is what is bounded.
    written.ok()
}

/// One page of the activity feed, oldest first, plus whether older events exist.
///
/// This is the read side of "keep everything": the log is complete, so the COST
/// of a long history has to live here, bounded — `limit` is clamped to
/// `MAX_PAGE_EVENTS`, and a client walks backwards with `before` instead of ever
/// asking for the whole thing (measured: the newest 600 events of the busiest
/// session are ~277 KB of JSON; the full log is ~1.2 MB of text, which is not
/// something to put through a phone's socket on every project switch).
///
/// Three shapes, exactly as `Store::activity_page`: no cursor = the newest page,
/// `since_ts` = the incremental tail, `before` = the page older than that cursor.
/// `since_ts` and `before` are independent, so a client may page backwards while
/// still polling the tail.
///
/// The ring is the fallback for a build with no database at all; it holds only
/// this process's newest events, so it answers a first page and reports no more.
pub fn events_page(
    session: &str,
    since_ts: u64,
    before: Option<(u64, i64)>,
    limit: usize,
) -> (Vec<ActivityEvent>, bool) {
    let limit = limit.clamp(1, MAX_PAGE_EVENTS);
    // The database is off under `cfg(test)` for the same reason the whole ring is:
    // a unit test must not write invented sessions into the developer's state.db.
    let paged = if cfg!(test) {
        Err(String::new())
    } else {
        super::with_store(|s| s.activity_page(session, since_ts, before, limit))
    };
    if let Ok((rows, has_more)) = paged {
        if !rows.is_empty() {
            let events = rows
                .into_iter()
                .map(|r| ActivityEvent {
                    id: r.id,
                    ts: r.ts,
                    window: r.window,
                    kind: r.kind,
                    text: r.text,
                    tool: r.tool,
                    via: r.via,
                    state: r.state,
                    deliveries: serde_json::from_str(&r.deliveries).unwrap_or_default(),
                    requesters: None,
                })
                .collect();
            return (events, has_more);
        }
    }
    let ring: Vec<ActivityEvent> = events()
        .lock()
        .unwrap()
        .get(session)
        .map(|q| {
            q.iter()
                .filter(|e| {
                    e.ts > since_ts && before.map(|(bts, _)| e.ts < bts).unwrap_or(true)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let skipped = ring.len().saturating_sub(limit);
    (ring.into_iter().skip(skipped).collect(), false)
}

/// Events newer than `since_ts` (ms, exclusive), oldest first — the newest page,
/// which is what a first load wants: the END of a conversation, not its
/// beginning. Kept as the plain read for callers that do not page.
pub fn recent_events(session: &str, since_ts: u64) -> Vec<ActivityEvent> {
    events_page(session, since_ts, None, LOAD_EVENTS).0
}

/// Is this window's turn open right now — `running` or `waiting` by
/// `derive_from`, the one turn rule (board #249), on the same record the
/// status reads? Asked by the reply edge (#256) and before typing at a
/// queue-mode agent (#257). Never pane activity, never a second query. Reads the
/// recovery mark first, so the first question after a restart is asked of
/// the turn the log replays (`recover_open_turns`), not an empty record. A
/// window whose turn is UNKNOWN (its log could not be read, `turn_known`)
/// is busy: its lines are held, never typed on a guess (board #394).
pub fn turn_busy(session: &str, window: &str) -> bool {
    if !turn_known(session, window) {
        return true;
    }
    matches!(derive(session, window, 0).state.as_str(), "running" | "waiting")
}

/// The window's turn EPOCH: the arrival order of its newest end fact
/// (`completed`/`failed`/`interrupted`) in the same record `derive_from`
/// reads, 0 before any. It changes exactly when a turn ends, so a reply-edge
/// memo stamped with it (#256) is known to belong to a turn that is over the
/// moment the window's epoch moves — an interrupt included, which takes no
/// edge. Recovery first, like `turn_busy`.
pub fn turn_epoch(session: &str, window: &str) -> u64 {
    recovery_mark(session);
    store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .map_or(0, |r| r.end_seq)
}

/// Visit every INPUT this window's turn has carried since its last end
/// (`completed`/`failed`/`interrupted` — the same end facts
/// `recover_open_turns` replays into `derive_from`), oldest first, streamed.
/// Returns how many. This answers "whose requests is this turn carrying?"
/// (the reply edge's MEMBERS), never "is the turn open?" — that is
/// `turn_busy` alone (orchestrator, #256 review 03:07). A tool-only turn is
/// open and carries no input here: it has no requester yet. Each input is
/// visited as its SENDERS: the row's stored `requesters` (parsed from the
/// full prompt at record time, #257), or — for a row from before v27, or
/// the in-memory ring — its text parsed by the same `address::requesters`.
/// Fail-soft: an unreadable store visits nothing.
pub fn for_each_turn_input(session: &str, window: &str, limit: Option<usize>, mut visit: impl FnMut(&[String])) -> usize {
    if !cfg!(test) || PERSIST_IN_TEST.with(|p| p.get()) {
        return super::with_store(|s| s.for_each_open_turn_prompt(session, window, limit, |text, stored| {
            let senders = stored
                .and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
                .unwrap_or_else(|| crate::address::requesters(text));
            visit(&senders);
        }))
        .unwrap_or(0);
    }
    let map = events().lock().unwrap();
    let Some(rows) = map.get(session) else { return 0 };
    let rows: Vec<&ActivityEvent> = rows.iter().filter(|event| event.window == window).collect();
    let start = rows
        .iter()
        .rposition(|e| e.kind == "notif" && matches!(e.text.as_str(), "completed" | "failed" | "interrupted"))
        .map_or(0, |i| i + 1);
    let mut seen = 0;
    for event in &rows[start..] {
        if event.kind == "prompt" && limit.is_none_or(|n| seen < n) {
            visit(&crate::address::requesters(&event.text));
            seen += 1;
        }
    }
    seen
}

/// How much trace this session has: (events, oldest ts, newest ts). For the
/// client's "N of M loaded" and for anyone auditing what we keep.
pub fn events_stats(session: &str) -> (usize, u64, u64) {
    if cfg!(test) {
        return (0, 0, 0);
    }
    super::with_store(|s| s.activity_stats(session)).unwrap_or((0, 0, 0))
}

fn store() -> &'static Mutex<HashMap<(String, String), Rec>> {
    static STORE: OnceLock<Mutex<HashMap<(String, String), Rec>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn with_rec(session: &str, window: &str, f: impl FnOnce(&mut Rec)) {
    let mut map = store().lock().unwrap();
    f(map.entry((session.to_string(), window.to_string())).or_default());
}

// ── Outstanding deliveries: ONE queue, in state.db (board #249) ─────────
//
// A pending delivery is a PROMISE made to a client ("this line was typed into
// the agent's pane; its receipt is coming"), kept by a SEPARATE process that
// our restart does not touch: the agent holds the line in its own input queue
// and submits it minutes later. The `deliveries` table is the only copy. It
// used to be mirrored in memory with a 16-line cap and folded back after a
// restart through an unordered map; the two copies disagreed — the memory
// evicted lines the table kept, the fold kept a random 16 — and every line
// memory had lost echoed back as keyboard input (`via: local`, an INPUT row,
// a hollow ring for ever; board #5, #249).

/// The delivery table, through the store. Tests point the process at a
/// throwaway database first, so a unit test never writes into the
/// developer's real state.db.
fn queue<T>(f: impl FnOnce(&mut super::store::Store) -> Result<T, String>) -> Result<T, String> {
    #[cfg(test)]
    crate::projects::tests::use_test_store();
    super::with_store(f)
}

/// Per session: the newest delivery row that existed when this process first
/// touched the session's queue, and when that was. Rows at or below it were
/// typed by an earlier process, and nothing was listening for their echoes
/// while it was down, so their ack clock starts at that moment rather than at
/// their typing time — or the first sweep after a restart reports them
/// unconfirmed seconds before the echo arrives. Rows above it were typed by
/// this process and keep their own clock.
fn recovery_marks() -> &'static Mutex<HashMap<String, (i64, u64)>> {
    static MARKS: OnceLock<Mutex<HashMap<String, (i64, u64)>>> = OnceLock::new();
    MARKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A session's recovery: its delivery mark, and whether its persisted turn
/// facts are in memory. Every lazy entry (a writer, `turn_busy`, the sweep, a
/// delivery question) and the server start take this one step.
fn recovery_mark(session: &str) -> (i64, u64) {
    recover(session).0
}

/// `recovery_mark` plus whether the session's turn facts were replayed
/// (board #394 review P1): the two are separate facts. The delivery mark is
/// set ONCE, whatever the replay did, so a retry never restarts the ack
/// grace of rows an earlier process typed. The replay is recorded only when
/// it succeeded (`replays`), so a session whose log could not be read is
/// asked again at its next entry, and nothing caches an unknown as "no
/// facts".
fn recover(session: &str) -> ((i64, u64), bool) {
    (delivery_mark(session), replay_turns(session))
}

fn delivery_mark(session: &str) -> (i64, u64) {
    if let Some(m) = recovery_marks().lock().unwrap().get(session) {
        return *m;
    }
    // Lines older than the recovery horizon are dropped once per process: an
    // echo that never came in a day is not coming.
    static PRUNED: OnceLock<()> = OnceLock::new();
    PRUNED.get_or_init(|| {
        let cutoff = now().saturating_sub(PENDING_MAX_AGE_SECS);
        let _ = queue(|s| s.prune_deliveries(cutoff));
    });
    let top = queue(|s| s.max_delivery_id(session)).unwrap_or(0);
    *recovery_marks().lock().unwrap().entry(session.to_string()).or_insert((top, now()))
}

/// Per session, the outcome of its last turn-fact replay: `Ok` once the log
/// is in memory (asked no more), the error otherwise (asked again at the
/// next entry; said once per distinct error). Absent: never asked.
fn replays() -> &'static Mutex<HashMap<String, Result<(), String>>> {
    static REPLAYS: OnceLock<Mutex<HashMap<String, Result<(), String>>>> = OnceLock::new();
    REPLAYS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Replay the session's turn facts unless that already succeeded. True when
/// they are in memory. A failure is said once per session and error, and its
/// recovery once; the lock is not held across the read, and two concurrent
/// replays of one session are harmless (a window already observed is left
/// alone).
fn replay_turns(session: &str) -> bool {
    if matches!(replays().lock().unwrap().get(session), Some(Ok(()))) {
        return true;
    }
    let result = recover_open_turns(session);
    let mut map = replays().lock().unwrap();
    match (&result, map.get(session)) {
        (Ok(()), Some(Err(_))) => eprintln!("turn facts of {session} replayed after an earlier failure"),
        (Err(e), before) if before != Some(&result) => {
            eprintln!("⚠  turn facts of {session} could not be replayed ({e}); its windows count as busy until a later touch replays them")
        }
        _ => {}
    }
    let ok = result.is_ok();
    map.insert(session.to_string(), result);
    ok
}

/// Has this process observed a turn fact of the window itself?
fn observed(r: &Rec) -> bool {
    r.prompt.is_some() || r.end.is_some() || r.tool.is_some() || r.ask.is_some()
}

/// Is this window's turn KNOWN (board #394 review P1)? Its session's log is
/// in memory, or this process observed a turn fact of the window itself,
/// which sorts after anything the log holds. An UNKNOWN window is never read
/// as idle by a decision that acts on it: `turn_busy` says busy (a queue-mode
/// line is held), the flush leaves its held lines alone however old, and the
/// sweep reports none of its lines. A status read (`derive`) still shows what
/// memory has; the diagnostic is in the server log.
pub fn turn_known(session: &str, window: &str) -> bool {
    let (_, replayed) = recover(session);
    replayed || store().lock().unwrap().get(&(session.to_string(), window.to_string())).is_some_and(observed)
}

/// Test-only: the error of the session's last failed replay, if any.
#[cfg(test)]
pub fn replay_error(session: &str) -> Option<String> {
    replays().lock().unwrap().get(session).and_then(|r| r.clone().err())
}

/// Recover EVERY session the activity log knows, once, at server start
/// (board #394). `recovery_mark` used to run only on a session's first
/// touch by a writer or a delivery question, and `derive` reads memory
/// alone, so the first `hub_agents` and `hub_rooms` after a restart showed
/// every agent idle with no detail (an open turn, a missed end's
/// `auth_expired`) until some other call happened to touch the session.
/// `server::start_with_socket_ready` awaits this (on the blocking pool)
/// before the hook inbox is read and before the first connection is
/// accepted, so no answer and no live fact comes before the replay. It is
/// the same per-session step the lazy calls take. A session whose log
/// cannot be read is said, stays unknown (`turn_known`) and is asked again
/// at its next entry; the others are replayed and the start goes on. A
/// session list that cannot be read is said too, and every session is then
/// recovered at its first touch.
pub fn recover_on_start() {
    match queue(|s| s.activity_sessions()) {
        Ok(sessions) => {
            for session in &sessions {
                recovery_mark(session);
            }
        }
        Err(e) => eprintln!("⚠  turn facts not replayed at start ({e}); each session is recovered when first touched"),
    }
}

/// A window's turn state survives OUR restart (board #249, validator): a
/// restart in the middle of a 20-minute turn left the window with no facts,
/// it derived idle, and 45 s later the sweep reported every line the running
/// CLI was still holding. The durable log holds the turn facts, so the newest
/// prompt, tool call, ask and end of each window are REPLAYED into a record
/// this process has no facts for, each keeping its row id as its order, and
/// `derive_from` — the one turn rule (tenet 8) — decides: open, waiting,
/// failed or idle. Never pane activity. An interrupt is an end
/// (`record_interrupt` logs it); a stop that fired while we were down is in
/// the hook inbox and ends the turn when it is read. A read that fails is
/// returned, never read as "no facts" (board #394 review P1).
fn recover_open_turns(session: &str) -> Result<(), String> {
    for facts in queue(|s| s.turn_facts(session))? {
        with_rec(session, &facts.window, |r| {
            if observed(r) {
                return; // this process already observed the window
            }
            replay_turn_facts(r, &facts);
        });
    }
    Ok(())
}

/// Put a window's persisted turn facts into a record, each ordered by its
/// log row id; `derive_from` then reads them as it reads live facts.
fn replay_turn_facts(r: &mut Rec, facts: &super::store::TurnFacts) {
    if let Some(f) = &facts.prompt {
        r.prompt = Some(f.ts / 1000);
        r.prompt_seq = recovered_arrival(f.id);
    }
    if let Some(f) = &facts.tool {
        let line = if f.text.is_empty() { f.tool.clone() } else { format!("{} {}", f.tool, f.text) };
        r.tool = Some((line, f.ts / 1000));
        r.tool_seq = recovered_arrival(f.id);
    }
    if let Some(f) = &facts.ask {
        r.ask = Some((f.text.clone(), f.ts / 1000));
        r.ask_seq = recovered_arrival(f.id);
    }
    if let Some(f) = &facts.end {
        // The same shape the live path stores: an interrupt ends a turn as
        // `completed` does (`record_interrupt`).
        let kind = if f.text == "failed" { "failed" } else { "completed" };
        r.end = Some((kind.to_string(), f.ts / 1000));
        r.end_seq = recovered_arrival(f.id);
        r.end_row = f.id;
        // An end the hooks missed carries its detail in the row's `tool`
        // column (`record_missed_end`); a hook's own end has none.
        if f.text == "failed" && !f.tool.is_empty() {
            r.person_end = (r.end_seq, f.tool.clone());
            r.missed_end_seq = r.end_seq;
        }
    }
}

fn forget_window_deliveries(session: &str, window: &str) {
    let _ = queue(|s| s.clear_deliveries(session, Some(window)));
}

/// The ONE entry for a turn fact (board #249, validator 15:07). A prompt,
/// tool call, ask, stop or interrupt is written to the activity log and
/// applied to the window's record under one lock, with one clock: the row's
/// ts is the record's second (plus this moment's milliseconds), and the
/// record's order is taken from the one live counter in the same critical
/// section, right after the insertion. So the log orders turn facts exactly as the live record does,
/// and a restart that replays the log (`replay_turn_facts`) derives the
/// state the live record had. Two unserialized paths used to take their
/// order and their row in opposite sequence (prompt: order then row; stop:
/// row then order), and a concurrent pair could land reversed. That entry is
/// `turn_fact_unless_row`, or `turn_fact_held` under the lock below.
///
/// The ONE lock turn facts are recorded under (board #249). A caller whose
/// step spans more than the fact — a prompt settling its delivery rows, an
/// end retiring a command (board #264, orchestrator 11:57) — takes it itself
/// and records through `turn_fact_held`, so no other turn fact of any window
/// can land between its read and its write.
static TURN_ORDER: Mutex<()> = Mutex::new(());

fn turn_order() -> std::sync::MutexGuard<'static, ()> {
    TURN_ORDER.lock().unwrap_or_else(|e| e.into_inner())
}

/// The turn-fact lock for a delivery decision (board #281, validator 11:50):
/// `delivery::deliver_with` reads `turn_busy` and `line_in_flight` and then
/// types and records the line, and `record_prompt` deletes the settled row
/// and then writes the prompt fact. Both run under THIS lock, so a decision
/// never falls in the gap between that delete and that fact. Lock order,
/// one for the whole app: window lock → this → pane send lock. No holder of
/// this lock takes a window lock (prompt settlement, end edge, interrupt,
/// command rows only touch the store; the #257 flush runs after the end
/// edge returns).
pub fn delivery_decision() -> std::sync::MutexGuard<'static, ()> {
    turn_order()
}

/// Test-only: runs once inside the next prompt's critical section, so a test
/// can race another turn fact against it and prove it waits (board #264).
#[cfg(test)]
static IN_PROMPT_HOOK: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);
/// Test-only: runs once inside the next prompt's critical section AFTER its
/// rows are settled (deleted) and BEFORE its prompt fact is written — the
/// gap a delivery decision must never fall into (board #281).
#[cfg(test)]
pub(crate) static IN_PROMPT_SETTLED_HOOK: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);
/// Test-only: runs once inside the next end edge's critical section, after
/// its had-prompt read and before its retirement.
#[cfg(test)]
static IN_END_HOOK: Mutex<Option<Box<dyn FnOnce() + Send>>> = Mutex::new(None);

/// `turn_fact`, skipped when `same` says the record already holds exactly
/// this fact as its newest one (read under the same lock). Returns whether it
/// was recorded.
fn turn_fact_unless(
    session: &str,
    window: &str,
    ts: u64,
    same: impl FnOnce(&Rec) -> bool,
    event: Option<(&str, String, String, String, Vec<DeliveryRef>)>,
    apply: impl FnOnce(&mut Rec, u64, u64),
) -> bool {
    turn_fact_unless_row(session, window, ts, same, event, apply, None)
}

fn turn_fact_unless_row(
    session: &str,
    window: &str,
    ts: u64,
    same: impl FnOnce(&Rec) -> bool,
    event: Option<(&str, String, String, String, Vec<DeliveryRef>)>,
    apply: impl FnOnce(&mut Rec, u64, u64),
    requesters: Option<Vec<String>>,
) -> bool {
    let order = turn_order();
    turn_fact_held(&order, session, window, ts, same, event, apply, requesters)
}

/// `turn_fact_unless_row` for a caller already holding `turn_order()`.
#[allow(clippy::too_many_arguments)]
fn turn_fact_held(
    _order: &std::sync::MutexGuard<'static, ()>,
    session: &str,
    window: &str,
    ts: u64,
    same: impl FnOnce(&Rec) -> bool,
    event: Option<(&str, String, String, String, Vec<DeliveryRef>)>,
    apply: impl FnOnce(&mut Rec, u64, u64),
    requesters: Option<Vec<String>>,
) -> bool {
    let held = store().lock().unwrap().get(&(session.to_string(), window.to_string())).cloned().unwrap_or_default();
    if same(&held) {
        return false;
    }
    let row = event.and_then(|(kind, text, tool, via, deliveries)| {
        push_full_with(session, window, ts * 1000 + now_ms() % 1000, kind, text, tool, via, deliveries, requesters)
    });
    // Tests widen the gap between the row and the order, so a lost lock
    // shows up as a reordering instead of a lucky pass.
    #[cfg(test)]
    std::thread::sleep(std::time::Duration::from_micros(30));
    // The order comes from the one counter, after the insert, under the lock.
    let seq = order_of();
    with_rec(session, window, |r| {
        apply(r, ts, seq);
        // An end fact takes this row as its durable identity (`end_row`).
        if r.end_seq == seq {
            r.end_row = row.unwrap_or(0);
        }
    });
    true
}

/// A hook notification consumed by the AgentNotificationHub. Two different
/// facts arrive here and they are stored apart: a stop ENDS the turn, a
/// permission/input prompt means the agent is blocked on the human while the
/// turn stays open.
pub fn record_notification(session: &str, window: &str, kind: &str, ts: u64) {
    record_notification_with(session, window, kind, ts, EndQuality::Unknown);
}

/// `record_notification` for a stop whose reply the caller has already read
/// (board #355): `Empty` = the whole reply was the CLI's placeholder, so the
/// turn said nothing. How a turn ended is part of THE END'S OWN WRITE — the
/// mark is the arrival number this very end takes, inside the one critical
/// section — so it can never land on a different end: a human's interrupt
/// written between a stop and a separate "and it was empty" step used to
/// inherit the mark and be nudged for it (review P1-B). Only a `Said` reply —
/// real text — forgives the nudge a run of empty turns had spent; an `Unknown`
/// one (no body, blank, unreadable session file) is no evidence that anyone
/// spoke, so it neither marks the end empty nor reopens the allowance (review
/// P1-2).
pub fn record_notification_with(session: &str, window: &str, kind: &str, ts: u64, quality: EndQuality) {
    let completed = kind == "completed";
    let kind_is_ask = matches!(kind, "permission_required" | "input_required");
    // ONE critical section (board #264, orchestrator 11:57): whether the
    // ending turn had a prompt is read, the end written and the window's
    // command rows stepped under the lock a prompt settles them under, so no
    // echo can land between the read and the retirement.
    let order = turn_order();
    let turn_had_prompt = store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .is_some_and(|r| r.prompt.is_some() && r.prompt_seq > r.end_seq);
    let event = ("notif", kind.to_string(), String::new(), String::new(), Vec::new());
    let kind = kind.to_string();
    turn_fact_held(&order, session, window, ts, |_| false, Some(event), |r, ts, seq| match kind.as_str() {
        "permission_required" | "input_required" => {
            r.ask = Some((kind, ts));
            r.ask_seq = seq;
        }
        _ => {
            r.end = Some((kind, ts));
            r.end_seq = seq;
            r.ask = None; // a finished turn cannot still be asking
            if completed {
                match quality {
                    EndQuality::Empty => r.empty_end_seq = seq,
                    EndQuality::Said => {
                        r.nudge_spent = false;
                        r.nudge_run += 1;
                    }
                    EndQuality::Unknown => {}
                }
            }
        }
    }, None);
    #[cfg(test)]
    if let Some(hook) = IN_END_HOOK.lock().unwrap().take() {
        hook();
    }
    if !kind_is_ask {
        end_commands(session, window, turn_had_prompt);
    }
    drop(order);
    // A real reply is proof the model answered, as a tool call is: an open
    // recovery incident is confirmed and a capped stretch is over (board
    // #362, orchestrator's ruling on the validator's P3).
    if completed && quality == EndQuality::Said {
        super::recovery::note_answered(session, window);
    }
}

/// Is the window owed a nudge right now: its newest end is an empty one, the
/// run's allowance is unspent, and the window is still at rest after it (no
/// turn started, nothing asked or ended since — `derive_from` is the one
/// definition of "at rest after that end").
fn nudge_owed(rec: &Rec) -> bool {
    !rec.nudge_spent
        && rec.empty_end_seq != 0
        && rec.empty_end_seq == rec.end_seq
        && derive_from(rec, 0, now()).detail == EMPTY_DETAIL
}

/// Take the window's ONE nudge timer lease (board #355): `Some(token)` when an
/// empty end is owed a nudge and no timer holds the lease. The holder passes its
/// token to `nudge_wait` and `disarm_nudge`; nobody else can release it. A timer
/// that is waiting re-reads the window when it wakes, so a second empty end
/// before it fires needs no second timer — it simply becomes the end that is
/// answered.
pub fn arm_nudge(session: &str, window: &str) -> Option<u64> {
    let mut map = store().lock().unwrap();
    let rec = map.get_mut(&(session.to_string(), window.to_string()))?;
    if rec.nudge_owner != 0 || !nudge_owed(rec) {
        return None;
    }
    let token = NEXT_NUDGE_TOKEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    rec.nudge_owner = token;
    Some(token)
}

/// What the window's timer should do next.
#[derive(Debug, PartialEq)]
pub enum NudgeWait {
    /// The owed end has not aged enough: sleep this many seconds, then ask again.
    Wait(u64),
    /// The newest end is empty, unanswered, and `after` seconds old: answer it.
    Due(Due),
    /// Nothing is owed, the end was already answered, or the lease is no longer
    /// this timer's: the timer is released IN THIS STEP (only if the lease is
    /// still its own), so an empty end that arrives right after finds it free.
    Gone,
}

/// The nudge a timer is to decide: the empty end it answers and the run of empty
/// turns the allowance belongs to (see `Rec::nudge_run`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Due {
    pub end_seq: u64,
    pub run: u64,
}

/// The timer holding lease `token` asks what to do. `answered` is the end it has
/// already looked at, so an end it declined (nothing open, told to wait) is not
/// looked at again. The decision and the release are one step under the record
/// lock. A timer whose lease was taken over by a later one is `Gone` without
/// touching it.
pub fn nudge_wait(session: &str, window: &str, token: u64, after: u64, answered: u64) -> NudgeWait {
    let mut map = store().lock().unwrap();
    let Some(rec) = map.get_mut(&(session.to_string(), window.to_string())) else { return NudgeWait::Gone };
    if rec.nudge_owner != token {
        return NudgeWait::Gone;
    }
    if !nudge_owed(rec) || rec.end_seq == answered {
        rec.nudge_owner = 0;
        return NudgeWait::Gone;
    }
    let age = now().saturating_sub(rec.end.as_ref().map(|(_, t)| *t).unwrap_or(0));
    if age >= after { NudgeWait::Due(Due { end_seq: rec.end_seq, run: rec.nudge_run }) } else { NudgeWait::Wait(after - age) }
}

/// Release the lease `token` holds (the timer's own exit, even a panicking one).
/// A no-op when the lease is free or another timer's: the Gone step has usually
/// released it already, and a new timer may hold it by now.
pub fn disarm_nudge(session: &str, window: &str, token: u64) {
    if let Some(rec) = store().lock().unwrap().get_mut(&(session.to_string(), window.to_string())) {
        if rec.nudge_owner == token {
            rec.nudge_owner = 0;
        }
    }
}

/// Is the nudge for the empty end `end_seq` STILL due: that end is the newest
/// fact, the window is still at rest after it, and nothing has been sent to it
/// since — no line typed and not yet echoed, none held. The last test is for
/// `delivery::deliver_if`, which asks it INSIDE the window's lock and the
/// turn-fact lock, in the same step as the typing (review P1-B): a check made
/// before a slow query and a delivery made after it can straddle a new prompt.
pub fn nudge_still_due(session: &str, window: &str, end_seq: u64) -> bool {
    let at_rest = store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .is_some_and(|rec| rec.end_seq == end_seq && nudge_owed(rec));
    at_rest && !line_in_flight(session, window) && held_rows(session, window).is_empty()
}

/// A nudge decided in `run` was delivered: that run of empty turns has had its
/// one. Conditional on the run — a real reply since has started a newer run, and
/// a write that arrives late must not charge it (review P2).
pub fn spend_nudge(session: &str, window: &str, run: u64) {
    if let Some(rec) = store().lock().unwrap().get_mut(&(session.to_string(), window.to_string())) {
        if rec.nudge_run == run {
            rec.nudge_spent = true;
        }
    }
}

/// A human interrupted the turn (`hub_agent_interrupt` / `tmm agent
/// interrupt`). We are ENDING the turn on the agent's behalf, before the Escape
/// is typed: the hooks report the edges of a turn the agent runs, and a turn
/// cancelled from outside has no edge of its own — the backend fires no stop for
/// a cancelled turn, so the newest fact would stay the `userPromptSubmit` that
/// opened it and the card would read `running` for as long as the agent stayed
/// alive. And the interrupted agent very often starts something else within
/// seconds, which would re-derive `running` from a NEW turn — indistinguishable
/// from the old one never having stopped, so the interrupt looked like it had
/// not landed (owner, 2026-08-29). Resetting first makes the effect visible in
/// the gap, and a real turn that starts afterwards is a fact of its own.
///
/// Same shape as a `completed` stop, with `ask` cleared because a cancelled
/// turn is not still asking. The end is also WRITTEN to the activity log as a
/// `notif` `interrupted` row (board #249, validator): turn recovery after a
/// restart reads the log, and without this row an interrupted turn came back
/// `running` and its queued lines' clock never started. It is only a turn
/// edge: the stop auto-post is driven by hook payloads, not by this log, and
/// the feed draws nothing for it because the room already carries
/// `[tmm] interrupted <name>`.
pub fn record_interrupt(session: &str, window: &str) {
    let order = turn_order(); // one critical section, as `record_notification`
    let turn_had_prompt = store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .is_some_and(|r| r.prompt.is_some() && r.prompt_seq > r.end_seq);
    let event = ("notif", "interrupted".to_string(), String::new(), String::new(), Vec::new());
    turn_fact_held(&order, session, window, now(), |_| false, Some(event), |r, ts, seq| {
        r.end = Some(("completed".to_string(), ts));
        r.end_seq = seq;
        r.ask = None;
    }, None);
    end_commands(session, window, turn_had_prompt);
}

/// A hook tool event (isolated-home agents only, Phase B+): `("Edit",
/// "foo.rs")`. The event keeps the two parts apart for rendering; the status
/// record keeps the joined line, which is what "working — Edit foo.rs" shows.
/// A tool call that is the CLI's housekeeping (kiro v3's post-turn `memory`
/// auto-capture, board #227): recorded as a tool ONLY while this window's
/// turn is open — then it is the agent using the tool mid-turn — and dropped
/// otherwise, so it never reopens a finished turn. Returns whether it counted.
pub fn record_housekeeping_tool(session: &str, window: &str, tool: &str, detail: &str) -> bool {
    let open = store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .is_some_and(|r| matches!(derive_from(r, 0, now()).state.as_str(), "running" | "waiting"));
    if open {
        record_tool(session, window, tool, detail);
    }
    open
}

pub fn record_tool(session: &str, window: &str, tool: &str, detail: &str) {
    // A tool call is proof the model answered: whatever transient-error retry
    // budget this window was burning refills (recovery rule 3).
    super::recovery::note_answered(session, window);
    let line = if detail.is_empty() { tool.to_string() } else { format!("{tool} {detail}") };
    let ts = now();
    // Pre and Post of one call are ONE fact (we subscribe to both because a
    // backend may send only one; an already-spawned agent keeps its old hook
    // config). Deduplication is a DISPLAY concern and must never drop a turn
    // fact (orchestrator 15:44): the Post half is skipped only when the Pre
    // half is still the window's NEWEST turn fact — same call, within
    // TOOL_DEDUPE_SECS, nothing (prompt, stop, ask) after it — because then
    // it adds nothing to the state, live or replayed. Any fact in between
    // makes it a fact of its own: a tool right after a stop reopens a
    // tool-only turn, a Post after an approved ask resumes the turn. Its row
    // is written too (the log must replay it); the feed collapses the
    // consecutive identical row (`feedBlocks`), so the lane still shows one.
    let event = ("tool", detail.to_string(), tool.to_string(), String::new(), Vec::new());
    let same_call = |r: &Rec| {
        let tool_k = r.tool.as_ref().map(|(_, t)| (*t, r.tool_seq));
        r.tool.as_ref().is_some_and(|(prev, at)| prev == &line && ts.saturating_sub(*at) <= TOOL_DEDUPE_SECS)
            && tool_k >= r.prompt.map(|t| (t, r.prompt_seq))
            && tool_k >= r.end.as_ref().map(|(_, t)| (*t, r.end_seq))
            && tool_k >= r.ask.as_ref().map(|(_, t)| (*t, r.ask_seq))
    };
    let line_for_rec = line.clone();
    turn_fact_unless(session, window, ts, same_call, Some(event), |r, ts, seq| {
        r.tool = Some((line_for_rec, ts));
        r.tool_seq = seq;
    });
}

/// A line this app typed into an agent's pane (`deliver_mentions`). Held as a
/// pending delivery until the agent's `userPromptSubmit` hook echoes it back.
/// Two deliveries of the SAME body are two rows (board #122): the pane really
/// was typed into twice, and each echo settles one. FAIL-SOFT like all
/// telemetry: without a database the line is simply untracked, and its echo
/// files as keyboard input.
/// `msg_id` is the chat message the line carries ('' for a line with none:
/// a board notice, a reply, a typed first prompt) — the echo names it, so a
/// client marks that message delivered without holding it (board #249).
pub fn record_delivery(session: &str, window: &str, line: &str, msg_id: &str) {
    record_typed(session, window, line, 0, msg_id);
}

/// `record_delivery` for a line whose stamped part starts at `ask_at`
/// (board #279: a Team context was typed before it). The row keeps where,
/// so its echo is SHOWN ask first without reading the text again.
pub fn record_typed(session: &str, window: &str, line: &str, ask_at: usize, msg_id: &str) {
    recovery_mark(session); // read BEFORE the insert: this row is ours
    // The window's record exists from its first delivery, so `retain_windows`
    // sees it and drops its queue when the window goes.
    with_rec(session, window, |_| {});
    let _ = queue(|s| s.insert_delivery(session, window, line, ask_at, now(), msg_id));
}

/// A slash command about to be typed whose backend declares what its
/// prompt hook will echo (board #264, `Backend::command_echo`): a row in the
/// ONE deliveries table, so that echo settles the command's bubble like any
/// delivery. It is never swept (a command is not a message someone waits on,
/// and "unconfirmed" would be a lie); a prompt takes at most one command row,
/// the window's oldest Idle one, and settles or drops it (`record_prompt`).
/// Typed into a running turn it is Queued, untouchable until that turn ends.
/// Returns the row id, `None` when it could not be written (fail-soft: the
/// bubble simply keeps no mark).
pub fn record_command_delivery(session: &str, window: &str, echo: &str, msg_id: &str) -> Option<i64> {
    recovery_mark(session);
    with_rec(session, window, |_| {});
    // Reading the turn state and inserting the row are ONE critical section
    // under the turn-fact lock (validator 12:07): else an end could read
    // "no prompt", this read "idle" and insert an Idle row, and that end
    // retire the brand-new command before it was even typed.
    let _order = turn_order();
    let running = store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .is_some_and(|r| matches!(derive_from(r, 0, now()).state.as_str(), "running" | "waiting"));
    let life = if running { super::store::CommandLife::Queued } else { super::store::CommandLife::Idle };
    queue(|s| s.insert_command_delivery(session, window, echo, now(), msg_id, life)).ok()
}

/// A turn end's effect on a window's command rows (board #264), one
/// transaction (`Store::end_command_turn`): retire the oldest Idle command,
/// THEN promote Queued to Idle, so a row promoted here is never retired by
/// the same end. The retirement applies only to an end that closes a turn
/// with NO prompt of its own — that proves the oldest Idle command echoed
/// nothing (the CLI ran or failed it without a hook; validator 11:50). An end
/// after a prompt retires nothing: that prompt was the PREVIOUS command's
/// turn, and the oldest Idle row is the next command, which runs now — two
/// /goal queued at one pane would otherwise lose the second at the first's
/// end (the FIFO regression).
fn end_commands(session: &str, window: &str, turn_had_prompt: bool) {
    let _ = queue(|s| s.end_command_turn(session, window, !turn_had_prompt));
}

/// The pane refused the command (copy mode, #250): nothing was typed, so
/// its row is no promise.
pub fn forget_delivery(id: i64) {
    let _ = queue(|s| s.delete_delivery_id(id));
}

/// A line for a busy queue-mode agent (board #257): a row in the ONE
/// deliveries table, persisted like every other, but not typed yet. It is
/// invisible to the echo match and the sweep until `release_held` marks it
/// typed at the turn's end.
/// `Err` when the row could not be written: the caller must not report the
/// line as queued (it falls back to typing it now, board #257 review).
pub fn record_held(session: &str, window: &str, line: &str, ask_at: usize, msg_id: &str) -> Result<(), String> {
    recovery_mark(session);
    with_rec(session, window, |_| {});
    queue(|s| s.insert_held_delivery(session, window, line, ask_at, now(), msg_id))
}

/// The window's held lines, oldest first.
pub fn held_rows(session: &str, window: &str) -> Vec<super::store::DeliveryRow> {
    queue(|s| s.held_deliveries(session, window)).unwrap_or_default()
}

/// Sessions with held lines.
pub fn held_sessions() -> Vec<String> {
    queue(|s| s.held_sessions()).unwrap_or_default()
}

/// Windows of a session with held lines.
pub fn held_windows(session: &str) -> Vec<String> {
    queue(|s| s.held_windows(session)).unwrap_or_default()
}

/// The rows are about to be typed: they become ordinary pending deliveries
/// whose ack clock starts now. Called BEFORE the typing, like
/// `record_delivery` is the record of a promise — an echo racing the end
/// of `send_command` must already find them. All or nothing (one
/// transaction); on `Err` nothing flipped and the caller must type nothing.
pub fn release_held(ids: &[i64]) -> Result<(), String> {
    queue(|s| s.set_deliveries_held(ids, false, now()))
}

/// The typing failed: the batch goes back to held, still owed. All or
/// nothing, like the release.
pub fn rehold(ids: &[i64]) -> Result<(), String> {
    queue(|s| s.set_deliveries_held(ids, true, now()))
}

/// Held lines could not be typed at the turn's end (board #257 decision 2:
/// the pane was in copy mode). They stay held and are retried at the next
/// trigger; this reports it ONCE per row — the `warned` mark — so a person
/// reading scrollback for ten minutes gets one line, not one per poll.
pub fn record_held_blocked(session: &str, window: &str, rows: &[super::store::DeliveryRow], reason: &str) {
    let fresh: Vec<i64> = rows
        .iter()
        .filter(|r| !r.warned)
        .map(|r| r.id)
        .filter(|id| queue(|s| s.mark_delivery_warned(*id)).unwrap_or(false))
        .collect();
    if !fresh.is_empty() {
        let n = rows.len();
        let noun = if n == 1 { "line" } else { "lines" };
        push_event(session, window, "warn", format!("held ({reason}): {n} {noun} will be typed when it clears"));
    }
}

/// An interrupt drops the window's held lines (board #257 decision 1: the
/// person asked the agent to stop, and kiro's own Escape clears its queue
/// the same way). Each is said once as `undelivered (interrupted)` — no row
/// id, no retry, exactly like a copy-mode refusal (#250): senders resend.
pub fn drop_held(session: &str, window: &str) {
    for row in held_rows(session, window) {
        if queue(|s| s.delete_delivery_id(row.id)).unwrap_or(false) {
            record_undelivered(session, window, &row.shown(), "interrupted");
        }
    }
}

/// A line `send_command` refused to type (board #250: the pane was in
/// copy-mode). It was never typed, so it is not a pending delivery and no echo
/// can ever settle it: no row, and so no `deliveries` reference — that field
/// names real rows only (#249). The sweep's own `warn` kind says so at once,
/// on the target window, with the reason and the line. Nothing retries it:
/// the person reading scrollback leaves the mode, and the sender resends.
/// Lines typed into a busy steer-mode session's running turn (board #276):
/// one `steered` event naming the chat messages they carry, instead of
/// pending rows no hook would ever settle. Not a turn fact (`turn_facts`
/// reads prompt/tool/notif only), and hidden in the feed except as the
/// reason a bubble shows no ring.
pub fn record_steered(session: &str, window: &str, line: &str, msgs: &[&str]) {
    recovery_mark(session);
    with_rec(session, window, |_| {});
    let refs = msgs.iter().filter(|m| !m.is_empty()).map(|m| DeliveryRef { id: 0, msg: m.to_string() }).collect();
    push_full(session, window, "steered", truncate_chars(line, 160), String::new(), String::new(), refs);
}

/// Retire held rows that will be steered into a running turn (#276): they
/// owe no echo. ONE transaction, all or nothing, and only rows still held —
/// the caller types nothing unless this succeeded.
pub fn retire_held(ids: &[i64]) -> Result<(), String> {
    queue(|s| s.delete_held_deliveries(ids))
}

pub fn record_undelivered(session: &str, window: &str, line: &str, reason: &str) {
    push_event(session, window, "warn", format!("undelivered ({reason}): {}", truncate_chars(line, 160)));
}

/// The `userPromptSubmit` hook: the agent accepted a prompt. This is BOTH the
/// input half of the transcript (what the agent was asked, which no other
/// channel carries) and the delivery receipt for a line we typed.
///
/// Returns true when it acknowledged a pending delivery. Matching is
/// containment, not equality: the CLI may submit the line with its own
/// decoration, and an agent that is mid-task receives our line appended to
/// whatever it was already typing.
pub fn record_prompt(session: &str, window: &str, prompt: &str) -> bool {
    let ts = now();
    recovery_mark(session);
    // The settlement and the prompt fact are ONE critical section under the
    // turn-fact lock (board #264): an end edge stepping the command rows
    // cannot interleave with this read-match-delete-record.
    let order = turn_order();
    #[cfg(test)]
    if let Some(hook) = IN_PROMPT_HOOK.lock().unwrap().take() {
        hook();
    }
    let rows = queue(|s| s.pending_deliveries(session, Some(window))).unwrap_or_default();
    // Chat lines and commands settle apart (board #264, orchestrator 11:31):
    // the chat rows by the #249 matcher as always; of the command rows only
    // the window's OLDEST IDLE one is a candidate — its CLI runs commands in
    // the order typed, so this prompt is that one's echo or none of theirs.
    let (chat, commands): (Vec<_>, Vec<_>) = rows.into_iter().partition(|r| r.command.is_none());
    let next_command = commands.iter().find(|r| r.command == Some(super::store::CommandLife::Idle));
    let mut settled = settled_by(&chat, prompt);
    // One prompt is ONE submission: a chat line of ours OR a command, never
    // both. A delivered line whose text merely contains a command's short
    // echo ("please do goal a") is that line's receipt, and the command is
    // still to run (validator, #264): it is neither settled nor dropped.
    // And a command's echo is the WHOLE submitted prompt (orchestrator 11:40):
    // equality under the same whitespace rule as the chat match, never
    // containment — "goal a then b" is not the echo of `/goal a`.
    let command_hit = settled.is_empty() && next_command.is_some_and(|row| strip_ws(&row.line) == strip_ws(prompt));
    if command_hit {
        settled.extend(next_command.map(|row| Settled { row, span: None }));
    }
    // A row counts only if THIS echo deleted it: two echoes racing for one
    // row cannot both call it theirs.
    let won: Vec<Settled> = settled
        .into_iter()
        .filter(|hit| queue(|s| s.delete_delivery_id(hit.row.id)).unwrap_or(false))
        .collect();
    let acked = !won.is_empty();
    #[cfg(test)]
    if let Some(hook) = IN_PROMPT_SETTLED_HOOK.lock().unwrap().take() {
        hook();
    }
    let refs: Vec<DeliveryRef> = won.iter().map(|hit| DeliveryRef::of(hit.row)).collect();
    let text = truncate_chars(&stored_prompt(&won, prompt), MAX_PROMPT_CHARS);
    // A prompt that carried neither the candidate command nor any chat line
    // of ours proves that command echoes nothing: that ONE row is dropped,
    // the rows behind it stay owed. A prompt that was a chat line of ours
    // (a held batch released at the turn's end, say) leaves it alone.
    // A prompt that only QUOTES the command ("please do goal a", typed by a
    // person) is not its echo and no proof it echoed nothing (orchestrator
    // 11:43): the command waits behind the turn that prompt opened.
    if let Some(row) = next_command.filter(|_| !command_hit && won.is_empty()) {
        if strip_ws(prompt).contains(&strip_ws(&row.line)) {
            let _ = queue(|s| s.requeue_command(row.id));
        } else {
            let _ = queue(|s| s.delete_delivery_id(row.id));
        }
    }
    // A turn just opened. This is the ONE honest "it started working" signal:
    // pane activity cannot be it, because an agent TUI repaints its prompt
    // (spinner, status line, cursor) long after it finished.
    let via = if acked { "app" } else { "local" };
    // Who this prompt asks, parsed ONCE from the FULL prompt (#257 review):
    // the row's text is cut at MAX_PROMPT_CHARS for display, and a combined
    // prompt of held lines can put its second requester past that cut.
    let requesters = crate::address::requesters(prompt);
    // Its requesters ride in the SAME activity INSERT as the row (#257).
    let event = ("prompt", text, String::new(), via.to_string(), refs);
    turn_fact_held(&order, session, window, ts, |_| false, Some(event), |r, ts, seq| {
        r.prompt = Some(ts);
        r.prompt_seq = seq;
    }, Some(requesters));
    acked
}

/// The prompt as the activity log stores it for DISPLAY (board #279,
/// orchestrator 13:24 and 14:03). Each settled Team row's span in the echo —
/// where the receipt matcher found it — is replaced IN PLACE by that row's
/// `DeliveryRow::shown` (its ask first, split where its producer recorded):
/// a Team agent is typed its context first, and a 1024-char cut of that would
/// keep only the context. Every byte outside those spans — a person's words
/// typed around our line, the break between held lines — stays as it was, in
/// order. Nothing is read out of the text: only text we produced, found by
/// the match the receipt already trusts, is replaced. An echo that settled
/// no row (a person typing, a pasted context block) is stored RAW, as is a
/// row with nothing leading its line (`ask_at` 0). Pure.
fn stored_prompt(won: &[Settled], prompt: &str) -> String {
    let mut spans: Vec<(&std::ops::Range<usize>, &super::store::DeliveryRow)> =
        won.iter().filter(|hit| hit.row.ask_at > 0).filter_map(|hit| hit.span.as_ref().map(|span| (span, hit.row))).collect();
    spans.sort_by_key(|(span, _)| span.start);
    let mut out = String::with_capacity(prompt.len());
    let mut at = 0;
    for (span, row) in spans {
        // Disjoint by construction (`settled_by`); checked, never assumed.
        let (Some(before), true) = (prompt.get(at..span.start), prompt.get(span.clone()).is_some()) else {
            return prompt.to_string();
        };
        out.push_str(before);
        out.push_str(&row.shown());
        at = span.end;
    }
    match prompt.get(at..) {
        Some(rest) => out + rest,
        None => prompt.to_string(),
    }
}

/// One row an echo settled, and WHERE in that echo it was found: the byte
/// range of the echo's own characters (its whitespace as it came back), or
/// `None` for a row settled without a place (an all-whitespace line, a
/// command, a line whose every occurrence another row already claimed).
struct Settled<'a> {
    row: &'a super::store::DeliveryRow,
    span: Option<std::ops::Range<usize>>,
}

/// Which outstanding rows this echo carries, in typed order. Pure.
///
/// Whitespace-BLIND matching: a delivered line travels through tmux
/// send-keys and an agent TUI's composer before it comes back in the
/// userPromptSubmit echo, and that round trip does not preserve whitespace.
/// A composer may render a newline as a space or its own wrap — and worse,
/// tmux in extended-keys mode DROPPED the raw \n byte outright, so the echo
/// came back with the lines GLUED ("AgenticAI\nAgentic" → "AgenticAIAgentic")
/// and a squash-to-one-space canon could never contain it (owner,
/// 2026-08-22 "发送内容有换行 好像就不会被confirm", again 2026-08-24 "多行内容
/// …没办法正确已读，匹配有问题"). Stripping ALL whitespace on BOTH sides
/// forgives every rendering of a break. The characters still have to match
/// in order, so this cannot ack the wrong line.
///
/// Any outstanding line may be the one this prompt carries — a queue is
/// submitted in order, but an agent can also be steered, so match on CONTENT.
/// One submitted prompt can carry several queued lines at once; a line the
/// prompt carries ONCE settles only ONE of its duplicates (board #122): each
/// occurrence in the echo is one receipt, spent oldest-first.
///
/// Each settled row also gets its SPAN (board #279, orchestrator 14:03): the
/// first occurrence of its line no earlier row claimed, so duplicates take
/// successive occurrences and spans never overlap. It is mapped from the
/// whitespace-free form back to the echo's own bytes, whitespace included.
/// The receipt itself is unchanged: occurrences are counted as before.
fn settled_by<'a>(rows: &'a [super::store::DeliveryRow], prompt: &str) -> Vec<Settled<'a>> {
    let (canon_prompt, origin) = canon_with_origin(prompt);
    let to_echo = |c: std::ops::Range<usize>| origin[c.start].0..origin[c.end - 1].1;
    let mut spent: HashMap<String, usize> = HashMap::new();
    let mut claimed: Vec<std::ops::Range<usize>> = Vec::new();
    let mut reverse_spent = false;
    let mut out = Vec::new();
    for row in rows {
        let canon_line = strip_ws(&row.line);
        if canon_line.is_empty() {
            // An all-whitespace line has no shape to match; settle it as
            // containment always did rather than pin it forever.
            out.push(Settled { row, span: None });
            continue;
        }
        let hits: Vec<std::ops::Range<usize>> = canon_prompt.match_indices(canon_line.as_str()).map(|(i, m)| i..i + m.len()).collect();
        let used = spent.entry(canon_line.clone()).or_insert(0);
        if *used < hits.len() {
            *used += 1;
            let free = hits.into_iter().find(|h| claimed.iter().all(|c| h.end <= c.start || c.end <= h.start));
            claimed.extend(free.clone());
            out.push(Settled { row, span: free.map(to_echo) });
            continue;
        }
        // The truncation-aware side: the stored echo may be cut while the full
        // line is longer (canon_line strictly longer, containing the whole
        // prompt). One such settle per echo — it is one submission, and the
        // whole echo is its span.
        if !reverse_spent && canon_line.len() > canon_prompt.len() && canon_line.contains(&canon_prompt) {
            reverse_spent = true;
            let whole = (!canon_prompt.is_empty() && claimed.is_empty()).then(|| 0..canon_prompt.len());
            claimed.extend(whole.clone());
            out.push(Settled { row, span: whole.map(to_echo) });
        }
    }
    out
}

/// `strip_ws(s)`, and for each of its bytes the byte range in `s` of the
/// character it came from — how a match in the whitespace-free form is
/// found again in the echo itself.
fn canon_with_origin(s: &str) -> (String, Vec<(usize, usize)>) {
    let mut canon = String::with_capacity(s.len());
    let mut origin = Vec::with_capacity(s.len());
    for (i, c) in s.char_indices().filter(|(_, c)| !c.is_whitespace()) {
        canon.push(c);
        origin.extend(std::iter::repeat_n((i, i + c.len_utf8()), c.len_utf8()));
    }
    (canon, origin)
}

/// ALL whitespace removed (space, tab, CR, LF). The delivery-receipt
/// containment match runs on THIS form — see `record_prompt` for why anything
/// gentler lost multi-line messages: byte-exact lost them to newline→space,
/// squash-to-one-space lost them to newline→NOTHING (tmux dropped the byte).
fn strip_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Is a typed line overdue for its echo? Pure, so the rule is testable.
///
/// A QUEUED line is not a lost line. An agent that is mid-turn holds what we
/// typed in its input queue — kiro says so on screen ("Type to queue") — and
/// submits it when the turn ends, which for a long turn is many minutes later.
/// Warning about that was warning about the system working: the owner saw
/// perfectly good messages marked unconfirmed ("有一些queue的指令，没办法马上
/// confirm，这个不用立刻就unconfirm", 2026-08-19).
///
/// So the ack clock does not run while a turn is OPEN — `running` (working) or
/// `waiting` (blocked on a permission answer) both mean the queue is holding it.
/// It starts at the turn's END, giving the CLI the same 45 s from the moment it
/// could actually submit the line. A line typed into an idle agent is unchanged:
/// its clock starts when we typed it.
/// Which outstanding rows are overdue, oldest first. Per ROW, because the
/// queue holds several typed at different times, and two identical bodies are
/// two promises. `mark` is the session's recovery mark (see
/// `recovery_mark`): a row at or below it has been waited for only since then.
fn overdue_rows(rec: &Rec, rows: &[super::store::DeliveryRow], mark: (i64, u64), now: u64) -> Vec<i64> {
    if rows.is_empty() {
        return Vec::new();
    }
    // activity_ts 0 on purpose: pane repaints must not keep a line pending
    // forever, and a window with no hook facts can never ack one anyway.
    if matches!(derive_from(rec, 0, now).state.as_str(), "running" | "waiting") {
        return Vec::new();
    }
    let turn_end = rec.end.as_ref().map(|(_, t)| *t).unwrap_or(0);
    rows.iter()
        .filter(|row| !row.warned && row.command.is_none())
        .filter(|row| {
            let listened = if row.id <= mark.0 { mark.1 } else { 0 };
            let reference = row.ts.max(listened).max(turn_end.min(now));
            now.saturating_sub(reference) >= DELIVERY_ACK_SECS
        })
        .map(|row| row.id)
        .collect()
}

/// Report deliveries that never came back as a prompt. Called before a client
/// reads the feed, which is exactly when the answer is wanted. A report does
/// NOT settle the row (board #249): the line may still be in the CLI's queue,
/// and a late real echo must still find it and settle it as ours, retracting
/// the warn by its row id. The persisted `warned` mark makes the report
/// happen once per row, across sweeps and restarts; the 24 h prune bounds the
/// rows that never echo. A window whose turn is unknown (board #394) reports
/// nothing: an unread log is not an idle window.
pub fn sweep_deliveries(session: &str) {
    let (mark, replayed) = recover(session);
    let rows = queue(|s| s.pending_deliveries(session, None)).unwrap_or_default();
    if rows.is_empty() {
        return;
    }
    let now = now();
    let mut by_window: std::collections::BTreeMap<String, Vec<super::store::DeliveryRow>> = Default::default();
    for row in rows {
        by_window.entry(row.window.clone()).or_default().push(row);
    }
    for (window, rows) in by_window {
        let rec = store()
            .lock()
            .unwrap()
            .get(&(session.to_string(), window.clone()))
            .cloned()
            .unwrap_or_default();
        if !replayed && !observed(&rec) {
            continue;
        }
        for id in overdue_rows(&rec, &rows, mark, now) {
            if !queue(|s| s.mark_delivery_warned(id)).unwrap_or(false) {
                continue; // settled, or reported by another sweep, meanwhile
            }
            let Some(row) = rows.iter().find(|r| r.id == id) else { continue };
            push_full(
                session,
                &window,
                "warn",
                format!("unconfirmed: {}", truncate_chars(&row.shown(), 160)),
                String::new(),
                String::new(),
                vec![DeliveryRef::of(row)],
            );
        }
    }
}

fn truncate_chars(input: &str, max: usize) -> String {
    let mut out: String = input.chars().take(max).collect();
    if input.chars().count() > max {
        out.push('…');
    }
    out
}

/// An auto-recovery action (`projects::recovery`) made visible: rendered as a
/// `warn` row because it is ABOUT a window that needed intervention, and warns
/// stay visible at every feed detail level.
pub fn record_recovery(session: &str, window: &str, text: &str) {
    push_event(session, window, "warn", text.to_string());
}

/// The window's turn-fact VERSION: the arrival number of its newest turn
/// fact of any kind (prompt, tool call, ask, end, interrupt), 0 before any.
/// It moves exactly when a turn fact lands, so a screen read after asking it
/// describes the turn at that version (board #362 review P1-A): an
/// observation is only ever committed against the version it was taken at.
/// Recovery first, like `turn_busy`.
pub fn turn_version(session: &str, window: &str) -> u64 {
    recovery_mark(session);
    store().lock().unwrap().get(&(session.to_string(), window.to_string())).map_or(0, rec_version)
}

fn rec_version(r: &Rec) -> u64 {
    r.prompt_seq.max(r.tool_seq).max(r.ask_seq).max(r.end_seq)
}

/// What `record_missed_end` did with one screen observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Missed {
    /// The open turn was ended: one `failed` row, the detail with it.
    Ended,
    /// The turn had already ended (a hook end, an interrupt, or the end this
    /// paint recorded): the detail is on that end, in memory, and no row was
    /// written.
    Attached,
    /// A turn fact landed after the screen was read: the observation is about
    /// an older turn and changes nothing (board #362 review P1-A).
    Stale,
    /// The window has no turn to end or describe.
    NoTurn,
    /// This paint was already accepted for an EARLIER turn of the window:
    /// it belongs to that turn alone and changes nothing now, after a
    /// restart too (review P1-C).
    Recorded,
    /// The acceptance record could not be read or written: unknown, so
    /// nothing is ended, attached, flushed or marked, and the next tick asks
    /// again (review P2 on 4cd26dc9: the record is a safety gate).
    Unknown,
}

/// The ONE acceptance identity of a screen observation (board #362 c, the
/// orchestrator's ruling on review P1-C and P1-D).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Identity<'a> {
    /// A paint that carries the CLI's Request ID (`<shape>|<id>`): a global
    /// identity. Once accepted, Ended or Attached, it belongs to that one
    /// turn, durably (`accepted_paint`), and never ends or describes a later
    /// turn of the window, across restarts.
    Paint(&'a str),
    /// No global identity: an exhausted recovery decision (Claude's 5xx has
    /// no Request ID, its signature is a hit count like `1|`). Scoped to its
    /// incident, which the caller dedupes (`recovery::Tracker`), and never
    /// deduped across the window's history: a later independent incident is
    /// its own.
    Incident,
}

/// The end row the person-needed paint `sig` of `window` was accepted for,
/// or `None` when it never was (board #362 c). Kept for GOOD, one fact per
/// paint (`store::person_paint_key`; the orchestrator's ruling on
/// accepted-once): a paint accepted once is never handled again, whatever
/// came in between, so no assumption about what a CLI repaints is needed.
/// `Err` = unknown, including a value that exists but does not parse
/// (review P2 on f998b599: it is not "absent", which would accept it again).
pub fn accepted_paint(session: &str, window: &str, sig: &str) -> Result<Option<i64>, String> {
    let Some(v) = super::with_store(|s| s.meta_get(&super::store::person_paint_key(session, window, sig)))? else { return Ok(None) };
    v.parse::<i64>().ok().filter(|r| *r > 0).map(Some).ok_or_else(|| format!("unreadable accepted paint {v:?}"))
}

/// The turn end the HOOKS missed, recorded from the screen (board #362 c,
/// orchestrator's ruling 2): `projects::recovery` saw the CLI's newest paint
/// be an error only a person can clear, and the CLI reports no end for that
/// turn (measured: codex-cli 0.154.0 on a 401, kiro-cli 2.28.0 on an
/// oversized image), so the turn stayed `running` and a queue-mode agent's
/// lines stayed held behind it, the person's own message after the fix
/// included. An END, not a wait (#354: a failed turn is an end): one
/// `failed` row with the `detail` in its `tool` column (so a restart replays
/// it, `replay_turn_facts`), the state idle with that detail, and the end
/// edge's flush.
///
/// The observation is BOUND to the turn it was taken in (board #362 review
/// P1-A): `seen` is `turn_version` read before the screen was captured, and
/// it is checked again here, inside the one turn-fact lock every prompt,
/// tool call, ask, end and interrupt is recorded under, so nothing can land
/// between the check and the write. Any newer fact makes the observation
/// `Stale`: it never ends a newer turn, never puts its detail on a newer
/// end, never flushes a newer turn's held lines. The capture itself runs
/// with no lock held.
///
/// Once is the observation's `Identity` (review P1-C, P1-D). A `Paint` is
/// accepted durably, one fact per paint kept for good (`accepted_paint`),
/// for the EXACT end it belongs to, named by that end's persisted activity
/// row id, not its second (review P1-C residual: ends share seconds). An end this
/// paint ENDS is written with its mark in one store transaction
/// (`Store::insert_missed_end`, review P1-E), and memory, the command rows
/// and the flush follow only its success; an end it is ATTACHED to is the
/// turn's own existing row, and the mark is written after it, naming it. A
/// later sighting of the same paint is `Recorded` unless that very end is
/// still the window's current one, when it just puts the detail back
/// (`Attached`, a restart having dropped it from memory). An `Incident` is
/// deduped by the caller, per incident. A record that cannot
/// be read or written is `Unknown` and changes nothing.
///
/// It carries NO reply: nothing is posted, nothing is returned as the
/// agent's answer, and the requesters' edge simply closes at this end (the
/// next turn's members start after it); they learn why from the status
/// detail. Nor is it evidence that the model answered: `turn_fact_since`
/// does not count it (review P2-1).
///
/// A turn that had ALREADY ended gets the detail on that end and no second
/// end row (`Attached`). That detail lives in memory only (review P2-2, the
/// contract): the end's own row is the hook's and stays as it was, so after
/// a gateway restart the replay restores the end without it, and the next
/// capture tick that still sees the paint as the newest attaches it again.
pub fn record_missed_end(session: &str, window: &str, detail: &str, identity: Identity, seen: u64, ts: u64) -> Missed {
    recovery_mark(session);
    let order = turn_order();
    let held = store().lock().unwrap().get(&(session.to_string(), window.to_string())).cloned();
    let Some(held) = held else { return Missed::NoTurn };
    if rec_version(&held) != seen {
        return Missed::Stale;
    }
    let open = matches!(derive_from(&held, 0, now()).state.as_str(), "running" | "waiting");
    let unknown = |what: &str, e: String| {
        eprintln!("projects: '{window}' in {session}: the paint record could not be {what} ({e}); nothing recorded, asked again next tick");
        Missed::Unknown
    };
    if let Identity::Paint(sig) = identity {
        match accepted_paint(session, window, sig) {
            Err(e) => return unknown("read", e),
            // Accepted for the EXACT end it belongs to, by that end's row id:
            // the same end, still current, gets its detail back (a restart
            // dropped it from memory); any other end, a newer one in the same
            // second included, is not this paint's (review P1-C).
            Ok(Some(row)) => {
                if !open && held.end_row == row {
                    with_rec(session, window, |r| r.person_end = (r.end_seq, detail.to_string()));
                    return Missed::Attached;
                }
                return Missed::Recorded;
            }
            Ok(None) => {}
        }
    }
    if !open {
        if held.end.is_none() {
            return Missed::NoTurn;
        }
        // Attached to the turn's own, existing end: no second end. The mark
        // names that end's row; an end with no durable row cannot be named,
        // so nothing is recorded for a paint.
        if let Identity::Paint(sig) = identity {
            if held.end_row == 0 {
                return unknown("bound", "the end has no persisted row".into());
            }
            if let Err(e) = super::with_store(|s| s.meta_set(&super::store::person_paint_key(session, window, sig), &held.end_row.to_string())) {
                return unknown("written", e);
            }
        }
        with_rec(session, window, |r| r.person_end = (r.end_seq, detail.to_string()));
        return Missed::Attached;
    }
    // Ended: the end row and the acceptance mark in ONE store transaction
    // (review P1-E); memory, the command rows and the flush only after it.
    let ts_ms = ts * 1000 + now_ms() % 1000;
    let key = match identity {
        Identity::Paint(sig) => Some(super::store::person_paint_key(session, window, sig)),
        Identity::Incident => None,
    };
    let row = match super::with_store(|s| s.insert_missed_end(session, window, ts_ms, detail, key.as_deref())) {
        Ok(row) => row,
        Err(e) => return unknown("written", e),
    };
    ring_push(session, ActivityEvent {
        id: 0,
        ts: ts_ms,
        window: window.to_string(),
        kind: "notif".into(),
        text: "failed".into(),
        tool: detail.to_string(),
        via: String::new(),
        state: String::new(),
        deliveries: Vec::new(),
        requesters: None,
    });
    let turn_had_prompt = held.prompt.is_some() && held.prompt_seq > held.end_seq;
    let seq = order_of();
    with_rec(session, window, |r| {
        r.end = Some(("failed".to_string(), ts));
        r.end_seq = seq;
        r.end_row = row;
        r.ask = None; // a finished turn cannot still be asking
        r.person_end = (seq, detail.to_string());
        r.missed_end_seq = seq;
    });
    // The end's effect on the window's command rows, as a hook end has it.
    end_commands(session, window, turn_had_prompt);
    drop(order);
    // The end edge's flush (board #257), as a hook end does it: lines held
    // for this busy queue-mode agent are typed now.
    super::delivery::flush(session, window);
    Missed::Ended
}

/// Did this window produce any turn fact (accepted prompt, turn end, tool
/// call) at or after `t`? `projects::recovery` asks this to verify that a
/// typed `continue` actually became a turn: the error text stays painted on
/// the screen long after the agent moved on, so the screen cannot answer it
/// (owner, 2026-08-26 — the visible error re-triggered sends into a working
/// agent). Seconds, same clock as the turn facts themselves.
pub fn turn_fact_since(session: &str, window: &str, t: u64) -> bool {
    let map = store().lock().unwrap();
    map.get(&(session.to_string(), window.to_string())).is_some_and(|r| {
        r.prompt.is_some_and(|p| p >= t)
            // An end WE recorded from the screen (`record_missed_end`) is our
            // own bookkeeping, not the CLI answering: it never proves that a
            // `continue` took effect (board #362 review P2-1).
            || r.end.as_ref().is_some_and(|(_, ts)| *ts >= t) && r.end_seq != r.missed_end_seq
            || r.tool.as_ref().is_some_and(|(_, ts)| *ts >= t)
    })
}

/// Drop records for windows that no longer exist (called opportunistically
/// with the live window set whenever someone lists a session's agents).
pub fn retain_windows(session: &str, live: &[String]) {
    let dead: Vec<String> = {
        let mut map = store().lock().unwrap();
        let dead = map
            .iter()
            .filter(|((s, w), _)| s == session && !live.contains(w))
            .map(|((_, w), _)| w.clone())
            .collect();
        map.retain(|(s, w), _| s != session || live.contains(w));
        dead
    };
    if dead.is_empty() {
        return;
    }
    // A window that is gone can never echo, so its queue is dead weight.
    // Windows this process never held a record for are left to the sweep,
    // which reports them once and settles them — this path costs nothing on the
    // roster poll that calls it several times a minute.
    for w in &dead {
        forget_window_deliveries(session, w);
    }
}

/// Is a line typed into this window still on its way to a turn (board
/// #281)? True while it owes an echo that has not come yet: a pending,
/// unreported chat-line row younger than the ack window. Derived from the
/// ONE deliveries table (tenet 8), no marker of its own: the prompt edge
/// settles the row, after which `turn_busy` answers; a line that never
/// echoes stops counting when the sweep's clock would report it.
pub fn line_in_flight(session: &str, window: &str) -> bool {
    let now = now();
    queue(|s| s.pending_deliveries(session, Some(window)))
        .unwrap_or_default()
        .iter()
        .any(|r| r.command.is_none() && !r.warned && now.saturating_sub(r.ts) < DELIVERY_ACK_SECS)
}

/// Test-only: a window's outstanding (typed, unsettled) rows, in typed order.
#[cfg(test)]
pub fn owed_rows(session: &str, window: &str) -> Vec<super::store::DeliveryRow> {
    queue(|s| s.pending_deliveries(session, Some(window))).unwrap_or_default()
}

/// Test-only: the message id each outstanding row carries, in typed order.
#[cfg(test)]
pub fn owed_message_ids(session: &str) -> Vec<String> {
    queue(|s| s.pending_deliveries(session, None)).unwrap_or_default().into_iter().map(|r| r.msg_id).collect()
}

/// Drop everything this PROCESS holds for a session — exactly what a restart
/// does to the derived records and the recovery mark, and nothing more: the
/// delivery queue in state.db is deliberately untouched, because its survival
/// is what board #5 is about. Test-only.
/// Test-only: a window's prompt rows as stored (text, requesters).
#[cfg(test)]
pub fn test_prompt_rows(session: &str, window: &str) -> Vec<(String, Option<String>)> {
    super::with_store(|s| s.prompt_rows(session, window)).unwrap()
}

/// Test-only: run SQL on the store's connection (fault triggers).
#[cfg(test)]
pub fn test_exec_sql(sql: &str) {
    super::with_store(|s| s.exec_test_sql(sql)).unwrap()
}

#[cfg(test)]
pub fn forget_process_state(session: &str) {
    store().lock().unwrap().retain(|(s, _), _| s != session);
    recovery_marks().lock().unwrap().remove(session);
    replays().lock().unwrap().remove(session);
}

/// Derive the current status for (session, window). `activity_ts` is tmux's
/// window_activity for the window — used ONLY when the window has produced no
/// hook facts at all. Pure given the record + clock.
pub fn derive(session: &str, window: &str, activity_ts: u64) -> AgentStatus {
    let rec = store()
        .lock()
        .unwrap()
        .get(&(session.to_string(), window.to_string()))
        .cloned()
        .unwrap_or_default();
    derive_from(&rec, activity_ts, now())
}

/// Every window with any hook facts, with its derived state — the sidebar's
/// one cheap read across ALL projects at once (owner, 2026-08-24: the project
/// list should show "当前几个 Agent 的简单 logo 状态"). Pure memory: no tmux
/// call, no pane sniff, so `hub_rooms` can afford it on every poll. Windows
/// that never produced a hook fact are simply absent — the client reads
/// absence as idle, which is what no-facts honestly means.
pub fn all_states() -> Vec<(String, String, String)> {
    let t = now();
    let map = store().lock().unwrap();
    map.iter()
        .map(|((s, w), rec)| (s.clone(), w.clone(), derive_from(rec, 0, t).state))
        .collect()
}

/// The detail an `idle` carries when the turn that ended FAILED (board #354).
/// Snake_case like the ask details (`permission_required`), because the UI
/// shows a detail verbatim and this is the same kind of word: a fact about
/// the last turn, readable in the hover row and in `tmm agent list`.
pub const FAILED_DETAIL: &str = "last_turn_failed";

/// The detail an `idle` carries when the turn that ended said NOTHING (board
/// #355): the CLI closed it with its own placeholder instead of a reply. Same
/// kind of word as `last_turn_failed` — a fact about the last turn, readable in
/// the hover row and in `tmm agent list` — and likewise not a state or a colour:
/// the agent is at rest, and `stalls` decides whether anyone needs telling.
pub const EMPTY_DETAIL: &str = "last_turn_empty";

/// The state machine, in one place. A turn is a bracket: `userPromptSubmit`
/// opens it, `stop` closes it, tool calls happen inside it, and a
/// permission prompt suspends it. So the rule is simply *which boundary is the
/// most recent fact*, and the three states fall out of that:
///
/// | newest fact                    | state   | since        |
/// |--------------------------------|---------|--------------|
/// | a turn end (stop), however it ended | idle | the end  |
/// | an ask (permission / input)    | waiting | the ask      |
/// | a turn start (prompt / tool)   | running | the START    |
///
/// `since` for `running` is the turn's start, not the newest event, so "running
/// 2m14s" means the turn has been open that long.
///
/// A FAILED end is still an end (board #354, 2026-10-15). It used to derive a
/// fourth state, `failed`, which wore the red dot until the next turn started
/// — and in practice the failure was a network timeout or a transient model
/// error the agent had already recovered from, so the card cried distress for
/// minutes about an agent that was simply resting (owner: 不用显示红点了). The
/// fact is not lost: the stop is in the activity log and the feed, and the
/// derived detail says `last_turn_failed` (so `tmm agent list` and the card's
/// hover row still name it) — it just is not a colour any more.
///
/// Pane activity is NOT a work signal for a window with hooks. It used to be,
/// and that was the bug: an agent TUI repaints after replying (spinner, status
/// line, blinking cursor), so `window_activity` was always newer than the stop
/// and every finished agent read as "working" forever. Windows with no hook
/// coverage at all (codex today, anything hand-started) still fall back to it,
/// because for them the alternative is no signal at all.
fn derive_from(rec: &Rec, activity_ts: u64, now: u64) -> AgentStatus {
    let (end_kind, end_ts) = rec.end.clone().unwrap_or_default();
    let ask_ts = rec.ask.as_ref().map(|(_, t)| *t).unwrap_or(0);
    let tool_ts = rec.tool.as_ref().map(|(_, t)| *t).unwrap_or(0);
    let prompt_ts = rec.prompt.unwrap_or(0);

    let turn_start = prompt_ts.max(tool_ts);
    let turn_end = end_ts;
    let newest = turn_start.max(turn_end).max(ask_ts);
    // Ordering keys: (second, arrival). Equal seconds are decided by which
    // fact arrived later (board #249); unequal seconds exactly as before.
    let prompt_k = (prompt_ts, rec.prompt_seq);
    let tool_k = (tool_ts, rec.tool_seq);
    let end_k = (end_ts, rec.end_seq);
    let ask_k = (ask_ts, rec.ask_seq);
    let start_k = prompt_k.max(tool_k);

    // No hook has ever spoken for this window: fall back to pane activity,
    // which is all a hookless backend gives us.
    if newest == 0 {
        let state = if now.saturating_sub(activity_ts) < ACTIVE_SECS { "running" } else { "idle" };
        return AgentStatus { state: state.into(), detail: String::new(), since: activity_ts };
    }

    // A turn that ended is REST, however it ended. A failed stop names
    // itself in the detail (board #354) and nowhere else: see the table
    // above for why it is not a state of its own.
    if end_k >= start_k && end_k >= ask_k {
        let detail = if rec.person_end.0 != 0 && rec.person_end.0 == rec.end_seq {
            rec.person_end.1.clone()
        } else if end_kind == "failed" {
            FAILED_DETAIL.to_string()
        } else if rec.empty_end_seq != 0 && rec.empty_end_seq == rec.end_seq {
            EMPTY_DETAIL.to_string()
        } else {
            String::new()
        };
        return AgentStatus { state: "idle".into(), detail, since: turn_end };
    }

    // Blocked on the human, and nothing has happened since.
    if ask_k > tool_k && ask_k >= prompt_k {
        let kind = rec.ask.as_ref().map(|(k, _)| k.clone()).unwrap_or_default();
        return AgentStatus { state: "waiting".into(), detail: kind, since: ask_ts };
    }

    // A turn is open. Its last observed tool explains what it is doing.
    let detail = rec
        .tool
        .as_ref()
        .filter(|_| tool_k >= prompt_k)
        .map(|(l, _)| l.clone())
        .unwrap_or_default();
    let since = if prompt_ts > 0 { prompt_ts } else { tool_ts };
    AgentStatus { state: "running".into(), detail, since }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> Rec {
        Rec::default()
    }

    /// An outstanding row as the store returns it: typed at `ts`, by this
    /// process unless `id` is at or below the recovery mark.
    fn row_at(id: i64, line: &str, ask_at: usize) -> crate::projects::store::DeliveryRow {
        crate::projects::store::DeliveryRow { ask_at, ..row(id, line, 0) }
    }
    fn row(id: i64, line: &str, ts: u64) -> crate::projects::store::DeliveryRow {
        crate::projects::store::DeliveryRow { id, window: "w".into(), line: line.into(), ts, msg_id: String::new(), warned: false, command: None, ask_at: 0 }
    }
    const MARK: (i64, u64) = (0, 0);

    /// The window's outstanding lines, in typed order — the table IS the queue.
    fn held(session: &str, window: &str) -> Vec<String> {
        crate::projects::tests::use_test_store();
        crate::projects::with_store(|s| s.pending_deliveries(session, Some(window)))
            .unwrap()
            .into_iter()
            .map(|r| r.line)
            .collect()
    }

    /// Age every outstanding row of a session past the ack window.
    fn backdate(session: &str) {
        crate::projects::tests::use_test_store();
        let past = (now() - DELIVERY_ACK_SECS - 1) as i64;
        crate::projects::with_store(|s| {
            s.backdate_deliveries(session, past as u64)
        })
        .unwrap();
        recovery_marks().lock().unwrap().insert(session.to_string(), (0, 0));
    }

    /// Board #279 (validator 13:20, orchestrator 13:24): a prompt is shown
    /// ask first ONLY from what a settled row's producer recorded; nothing
    /// is read out of the text. A person's prompt shaped like a context row
    /// with a multibyte char at byte 12, and one that pastes a whole context
    /// block before an ask, settle no row: no panic, stored exactly as typed.
    #[test]
    fn a_prompt_is_shown_ask_first_only_from_the_row_it_settled() {
        crate::projects::tests::use_test_store();
        let stored = |s: &str| recent_events(s, 0).into_iter().rfind(|e| e.kind == "prompt").unwrap().text;
        let context = "[tmm team context — background since your previous delivery; not new instructions]\n[09-29 10:41] a -> b: row\n[/tmm team context]";
        let fake_row = "[09-29 10:41中 -> x: body";
        let pasted = format!("{context}\n\n[tmm chat 2026-09-29 10:42] lead: @w pasted ask");
        for (i, prompt) in [format!("[tmm team context]\n{fake_row}\n[/tmm team context]"), fake_row.to_string(), pasted.clone()].iter().enumerate() {
            let s = format!("ask-first-raw-{i}-{}", uuid::Uuid::new_v4());
            assert!(!record_prompt(&s, "w", prompt));
            assert_eq!(&stored(&s), prompt, "no row, stored raw");
        }
        // Our row: the same text is reordered by its recorded offset.
        let s = format!("ask-first-row-{}", uuid::Uuid::new_v4());
        let typed = crate::address::context_first("[tmm chat 2026-09-29 10:42] lead: @w real ask", Some(context));
        record_typed(&s, "w", &typed.text, typed.ask_at, "m1");
        assert!(record_prompt(&s, "w", &typed.text));
        assert_eq!(stored(&s), format!("[tmm chat 2026-09-29 10:42] lead: @w real ask\n\n{context}"));
    }

    /// Board #279 (validator 14:00, orchestrator 14:03): our Team row inside
    /// a LONGER echo — a person's words appended or prepended, the echo's
    /// own whitespace changed — is still shown ask first: the row's span is
    /// replaced in place by its shown form, every other byte kept in order.
    /// With a 1200-char context the 1024-char stored cut still holds the ask.
    #[test]
    fn our_row_inside_a_longer_echo_is_shown_ask_first_in_place() {
        crate::projects::tests::use_test_store();
        let stored = |s: &str| recent_events(s, 0).into_iter().rfind(|e| e.kind == "prompt").unwrap().text;
        let context = format!("[tmm team context — background]\n[09-29 10:41] a -> b: {}\n[/tmm team context]", "背景".repeat(400));
        assert!(context.len() > 1200);
        let ask = "[tmm chat 2026-09-29 10:42] lead: @w REAL ASK\nsecond line";
        let typed = crate::address::context_first(ask, Some(&context));
        let shown = format!("{ask}\n\n{context}");
        let sorted = |t: &str| {
            let mut v: Vec<char> = t.chars().filter(|c| !c.is_whitespace()).collect();
            v.sort_unstable();
            v
        };
        // Appended, prepended, and both around an echo whose newlines came
        // back as spaces (the whitespace-blind match): the local text stays
        // verbatim where it was, our part reads ask first.
        let spaced = typed.text.replace('\n', " ");
        for (i, (before, echo_of_ours, after)) in [
            ("", typed.text.as_str(), " local addition"),
            ("my own line first\n", typed.text.as_str(), ""),
            ("pre ", spaced.as_str(), " post"),
        ]
        .into_iter()
        .enumerate()
        {
            let s = format!("ask-first-longer-{i}-{}", uuid::Uuid::new_v4());
            record_typed(&s, "w", &typed.text, typed.ask_at, "m1");
            let echo = format!("{before}{echo_of_ours}{after}");
            assert!(record_prompt(&s, "w", &echo), "acked: {i}");
            let full = stored_prompt(&settled_by(&[row_at(1, &typed.text, typed.ask_at)], &echo), &echo);
            assert_eq!(full, format!("{before}{shown}{after}"), "in place: {i}");
            assert_eq!(sorted(&full), sorted(&echo), "nothing dropped or duplicated: {i}");
            let cut = stored(&s);
            assert!(cut.starts_with(&format!("{before}{ask}")) && cut.chars().count() <= MAX_PROMPT_CHARS, "the stored cut shows the ask: {i} {cut}");
        }
        // Two held Team rows and a duplicate of the first: each occurrence
        // is replaced once, the break between them kept.
        let two = crate::address::context_first("[tmm chat 10:43] lead: @w two", Some("[ctx two]"));
        let rows = [row_at(1, &typed.text, typed.ask_at), row_at(2, &two.text, two.ask_at), row_at(3, &typed.text, typed.ask_at)];
        let echo = format!("{}\n\n{}\n\n{} tail", typed.text, two.text, typed.text);
        let hits = settled_by(&rows, &echo);
        assert_eq!(hits.len(), 3);
        let two_shown = "[tmm chat 10:43] lead: @w two\n\n[ctx two]";
        assert_eq!(stored_prompt(&hits, &echo), format!("{shown}\n\n{two_shown}\n\n{shown} tail"));
    }

    /// The sidebar's one cheap read: every window with hook facts, derived.
    /// Sessions are isolated keys, and a window nobody hooked is absent —
    /// which the client reads as idle.
    #[test]
    fn all_states_reports_every_hooked_window_with_its_derived_state() {
        record_prompt("allst-a", "w2", "do the thing");
        record_notification("allst-b", "w3", "completed", 12345);
        let states = all_states();
        let get = |s: &str, w: &str| {
            states.iter().find(|(ss, ww, _)| ss == s && ww == w).map(|(_, _, st)| st.clone())
        };
        assert_eq!(get("allst-a", "w2").as_deref(), Some("running"), "an open turn derives running");
        assert_eq!(get("allst-b", "w3").as_deref(), Some("idle"), "a closed turn derives idle");
        assert_eq!(get("allst-a", "w9"), None, "no hook facts, no row — absence means idle");
    }

    /// A human interrupt closes the turn itself, because nothing else will: the
    /// backend fires no stop hook for a turn cancelled from outside, so the
    /// newest fact would stay the `userPromptSubmit` and the agent would read
    /// `running` for ever.
    #[test]
    fn an_interrupt_closes_the_turn_it_cancelled() {
        record_prompt("int-a", "w1", "do the long thing");
        assert_eq!(derive("int-a", "w1", 0).state, "running");

        record_interrupt("int-a", "w1");
        let after = derive("int-a", "w1", 0);
        assert_eq!(after.state, "idle", "the cancelled turn is over");
        assert!(after.since > 0, "since moves to the interrupt");
        // Pane activity must not resurrect it either: a hooked window ignores
        // the repaint an interrupted TUI does on its way back to the prompt.
        assert_eq!(derive("int-a", "w1", now()).state, "idle");
        // And a REAL new turn afterwards is a fact of its own, so it reads
        // running again — which is the point of resetting FIRST. Checked on the
        // pure state machine because the record's clock is in seconds: an
        // interrupt and the prompt it enables share one second in a test.
        let mut r = rec();
        r.prompt = Some(2000);
        r.end = Some(("completed".into(), 2000)); // interrupted
        assert_eq!(derive_from(&r, 0, 2000).state, "idle");
        r.prompt = Some(2001); // the agent was given something else to do
        assert_eq!(derive_from(&r, 0, 2001).state, "running");
    }

    // ── Delivery acknowledgement: when is a typed line actually overdue?

    /// The owner's report: a line typed at a BUSY agent is queued by its CLI and
    /// submitted when the turn ends, so warning after 45 s was warning about the
    /// system working as designed.
    #[test]
    fn a_queued_line_is_not_an_unconfirmed_line() {
        let mut r = rec();
        r.prompt = Some(1000); // a turn is open — the agent is working
        let rows = [row(1, "@builder-2 do the thing", 1010)];
        // Ten minutes later the turn is STILL running. Nothing is overdue: the
        // line is sitting in the agent's input queue where we put it.
        assert!(overdue_rows(&r, &rows, MARK, 1010 + 600).is_empty());
        // Blocked on a permission answer is the same situation: the queue holds
        // the line until the human answers.
        let mut asking = r.clone();
        asking.ask = Some(("permission_required".into(), 1100));
        assert!(overdue_rows(&asking, &rows, MARK, 1100 + 600).is_empty());
    }

    /// The bug: `pending` was ONE slot, so a second message typed at a busy agent
    /// erased the first one's record. When the agent finally submitted the first
    /// queued line, nothing matched it — so it was reported as a prompt the user
    /// had typed locally (rendered as an "input" row) and the message it belonged
    /// to never got its delivered mark.
    /// Pre + Post for one call are one ROW. Both hooks are subscribed (a backend
    /// may only send one), they carry the same tool and argument, and they arrive
    /// milliseconds apart — so the lane used to show every call twice.
    #[test]
    fn a_pre_and_post_pair_is_one_row() {
        let session = format!("tool-dedupe-{}", std::process::id());
        let rows = |s: &str| {
            recent_events(s, 0).into_iter().filter(|e| e.kind == "tool").count()
        };
        record_tool(&session, "w4", "Read", "/w/src/lib.rs");
        record_tool(&session, "w4", "Read", "/w/src/lib.rs");   // the Post half
        assert_eq!(rows(&session), 1, "one call, one row");

        // A different argument is a different call.
        record_tool(&session, "w4", "Read", "/w/src/main.rs");
        assert_eq!(rows(&session), 2);
        // The same argument in ANOTHER window is that window's own call.
        record_tool(&session, "w9", "Read", "/w/src/main.rs");
        assert_eq!(rows(&session), 3);
        // And the status record still carries the newest line either way.
        let st = derive(&session, "w4", 0);
        assert!(st.detail.contains("main.rs"), "got {:?}", st.detail);
    }

    #[test]
    fn two_lines_queued_at_a_busy_agent_are_both_still_outstanding() {
        let session = format!("queue-test-{}", std::process::id());
        record_prompt(&session, "w1", "start working");      // a turn is open
        record_delivery(&session, "w1", "[tmm chat 00:05] human: first thing", "");
        record_delivery(&session, "w1", "[tmm chat 00:06] human: second thing", "");

        // Both are held, oldest first — the second no longer erases the first.
        assert_eq!(held(&session, "w1").len(), 2);
        assert!(held(&session, "w1")[0].contains("first thing"));

        // The agent works through the queue in order. Each echo acknowledges its
        // OWN line and leaves the other outstanding.
        assert!(record_prompt(&session, "w1", "[tmm chat 00:05] human: first thing"),
            "the first queued line is acknowledged, however late it arrives");
        assert_eq!(held(&session, "w1").len(), 1);
        assert!(held(&session, "w1")[0].contains("second thing"));
        assert!(record_prompt(&session, "w1", "[tmm chat 00:06] human: second thing"));
        assert!(held(&session, "w1").is_empty());

        // A prompt nobody typed for us is still local input.
        assert!(!record_prompt(&session, "w1", "something the user typed at the keyboard"));
    }

    #[test]
    fn one_submitted_prompt_can_carry_the_whole_queue() {
        // kiro submits queued lines together; the hook then reports ONE prompt
        // containing several of ours. Each must be acknowledged, or the earlier
        // messages keep their hollow ring for ever.
        let session = format!("queue-batch-{}", std::process::id());
        record_prompt(&session, "w2", "open the turn");
        record_delivery(&session, "w2", "line one", "");
        record_delivery(&session, "w2", "line two", "");
        assert!(record_prompt(&session, "w2", "line one\nline two\n"));
        assert!(held(&session, "w2").is_empty(), "both lines were in that prompt");
    }

    #[test]
    fn every_overdue_line_is_reported_not_just_the_first() {
        let mut r = rec();
        r.end = Some(("completed".into(), 1000));         // idle since 1000
        let rows = [row(1, "older", 900), row(2, "newer", 1000)];
        // Both past the window.
        assert_eq!(overdue_rows(&r, &rows, MARK, 1000 + DELIVERY_ACK_SECS), vec![1, 2]);
        // Only the older one is past it: the fresh line keeps its own clock.
        assert!(overdue_rows(&r, &rows, MARK, 900 + DELIVERY_ACK_SECS).is_empty(), "the clock runs from the turn end (1000)");
    }

    #[test]
    fn the_clock_starts_when_the_turn_ends() {
        let mut r = rec();
        r.prompt = Some(1000);
        let rows = [row(1, "@builder-2 do the thing", 1010)];
        r.end = Some(("completed".into(), 2000)); // the turn ended much later
        // The CLI gets the full window from the moment it could submit, not from
        // the moment we typed — 990 s after typing is still not overdue.
        assert!(overdue_rows(&r, &rows, MARK, 2000 + DELIVERY_ACK_SECS - 1).is_empty());
        assert_eq!(overdue_rows(&r, &rows, MARK, 2000 + DELIVERY_ACK_SECS), vec![1]);
    }

    #[test]
    fn a_line_typed_at_an_idle_agent_keeps_its_own_clock() {
        let mut r = rec();
        r.prompt = Some(500);
        r.end = Some(("completed".into(), 600)); // idle since 600
        let rows = [row(1, "@builder-2 hello", 1000)]; // typed later
        assert!(overdue_rows(&r, &rows, MARK, 1000 + DELIVERY_ACK_SECS - 1).is_empty());
        assert_eq!(overdue_rows(&r, &rows, MARK, 1000 + DELIVERY_ACK_SECS), vec![1], "an idle agent had its chance");
    }

    #[test]
    fn a_hookless_window_is_still_swept() {
        // No hook facts at all (a hand-started codex, a backend without hooks):
        // it can never ack, and pane repaints must not keep the line pending
        // forever — the warning is the only signal the owner would get.
        let rows = [row(1, "@codex hello", 1000)];
        assert!(overdue_rows(&rec(), &rows, MARK, 1000 + 10).is_empty());
        assert_eq!(overdue_rows(&rec(), &rows, MARK, 1000 + DELIVERY_ACK_SECS), vec![1]);
    }

    #[test]
    fn nothing_pending_is_never_overdue() {
        assert!(overdue_rows(&rec(), &[], MARK, 9999).is_empty());
    }

    /// The bug this machine replaced: an agent that had just answered kept
    /// reading "working" forever, because its TUI repaints the prompt after
    /// every reply and pane activity was treated as work.
    #[test]
    fn a_finished_turn_is_idle_no_matter_how_busy_the_pane_looks() {
        let mut r = rec();
        r.prompt = Some(1000);
        r.tool = Some(("Edit src/lib.rs".into(), 1010));
        r.end = Some(("completed".into(), 1020));
        // Pane activity 500s of it, all newer than the stop — a repainting TUI.
        let s = derive_from(&r, 1500, 1520);
        assert_eq!(s.state, "idle", "a repainting prompt is not work");
        assert_eq!(s.since, 1020, "idle since the turn ended");
    }

    #[test]
    fn a_turn_is_running_from_its_prompt_until_it_stops() {
        let mut r = rec();
        r.prompt = Some(1000);
        let s = derive_from(&r, 0, 1300);
        assert_eq!(s.state, "running");
        assert_eq!(s.since, 1000, "since = the turn's start, so elapsed is the TURN's age");
        // A long think with no tool calls stays running: only an end ends it.
        assert_eq!(derive_from(&r, 0, 1000 + 3600).state, "running");
        // Tools inside the turn keep it running and describe it.
        r.tool = Some(("Edit a.rs".into(), 1200));
        let s = derive_from(&r, 0, 1300);
        assert_eq!((s.state.as_str(), s.detail.as_str(), s.since), ("running", "Edit a.rs", 1000));
    }

    #[test]
    fn tools_without_a_prompt_still_mean_running() {
        // Claude/codex may deliver tool events without a turn-start hook.
        let mut r = rec();
        r.tool = Some(("Bash npm test".into(), 1000));
        let s = derive_from(&r, 0, 1005);
        assert_eq!((s.state.as_str(), s.since), ("running", 1000));
    }

    #[test]
    fn an_ask_suspends_the_turn_and_an_answer_resumes_it() {
        let mut r = rec();
        r.prompt = Some(1000);
        r.ask = Some(("permission_required".into(), 1100));
        let s = derive_from(&r, 0, 9000);
        assert_eq!(s.state, "waiting", "blocked on the human, however long it waits");
        assert_eq!(s.detail, "permission_required");
        // A tool call after the ask means it got answered.
        r.tool = Some(("Bash rm -rf build".into(), 1200));
        assert_eq!(derive_from(&r, 0, 1250).state, "running");
        // And a stop after the ask ends the turn, ask or no ask.
        r.tool = None;
        r.end = Some(("completed".into(), 1300));
        assert_eq!(derive_from(&r, 0, 1350).state, "idle");
    }

    /// Owner, board #354 (2026-10-15): "我发现在 Agent 的卡片上有时候会显示
    /// 红色的小点 … 大部分情况下我发现是网络连接超时或者它的一个状态响应 …
    /// 不用显示红点了". A failed stop is a turn END, so the agent is at REST;
    /// the failure is named in the detail and lives on in the activity log,
    /// but it is not a state and not a colour. Before this it derived
    /// `failed` and stood until the next turn started, so a card cried
    /// distress for minutes about an agent that had already recovered.
    #[test]
    fn a_failed_stop_ends_the_turn_and_names_itself_in_the_detail() {
        let mut r = rec();
        r.prompt = Some(900);
        r.end = Some(("failed".into(), 1000));
        let s = derive_from(&r, 5000, 5000);
        assert_eq!(s.state, "idle", "a failed end is an end — no red dot");
        assert_eq!(s.detail, FAILED_DETAIL, "and the fact is still readable");
        assert_eq!(s.since, 1000, "at rest since the end, not since the prompt");
        // A clean end is the same state with nothing to say.
        r.end = Some(("completed".into(), 1000));
        let ok = derive_from(&r, 5000, 5000);
        assert_eq!((ok.state.as_str(), ok.detail.as_str()), ("idle", ""));
        // A new turn is a new turn, and carries none of it.
        r.end = Some(("failed".into(), 1000));
        r.prompt = Some(1100);
        let next = derive_from(&r, 0, 1200);
        assert_eq!((next.state.as_str(), next.detail.as_str()), ("running", ""));
    }

    /// Board #355: a turn that ended with the CLI's placeholder instead of a
    /// reply is REST like any end, and names itself in the detail — the same
    /// kind of fact as `last_turn_failed`, no state and no colour. It names
    /// ITSELF only: a later real end stops matching, and a new turn carries
    /// nothing of it.
    #[test]
    fn an_empty_end_is_rest_and_names_itself_in_the_detail() {
        let mut r = rec();
        r.prompt = Some(900);
        r.end = Some(("completed".into(), 1000));
        r.end_seq = 7;
        r.empty_end_seq = 7;
        let s = derive_from(&r, 5000, 5000);
        assert_eq!((s.state.as_str(), s.detail.as_str(), s.since), ("idle", EMPTY_DETAIL, 1000));
        r.end_seq = 9; // a later end, which was not empty
        assert_eq!(derive_from(&r, 5000, 5000).detail, "");
        r.end_seq = 7; // …and the empty one again, then a new turn
        r.prompt = Some(1100);
        let next = derive_from(&r, 0, 1200);
        assert_eq!((next.state.as_str(), next.detail.as_str()), ("running", ""));
        // No end was ever marked: the zero never matches the zero.
        let mut fresh = rec();
        fresh.end = Some(("completed".into(), 1000));
        assert_eq!(derive_from(&fresh, 5000, 5000).detail, "");
    }

    /// kiro v3 runs its memory auto-capture as `memory` tool calls AFTER the
    /// Stop (board #227; measured on two agents, three calls 10–30 s after
    /// `completed`, no new prompt). Recorded as work they reopened the turn and
    /// the card said "working" until the next message. A housekeeping call
    /// counts only inside an open turn — there it is the agent's own use of
    /// the tool — and is dropped after the end.
    #[test]
    fn housekeeping_after_the_stop_does_not_reopen_the_turn() {
        let session = format!("hk-{}", uuid::Uuid::new_v4());
        record_prompt(&session, "w1", "[tmm chat 10:42] human: @aws-expert 1000 字也不用这么大");
        assert!(record_housekeeping_tool(&session, "w1", "memory", ""), "mid-turn the agent may use the tool");
        assert_eq!(derive(&session, "w1", 0).state, "running");
        record_tool(&session, "w1", "execute_bash", "python3 compile.py");
        record_notification(&session, "w1", "completed", now());
        assert_eq!(derive(&session, "w1", 0).state, "idle");
        let rows = recent_events(&session, 0).len();
        for _ in 0..3 {
            assert!(!record_housekeeping_tool(&session, "w1", "memory", ""), "the auto-capture is not work");
        }
        assert_eq!(derive(&session, "w1", 0).state, "idle", "three memory calls after the Stop leave the agent idle");
        assert_eq!(recent_events(&session, 0).len(), rows, "and leave no rows in the feed");
        // A window that never spoke has no open turn either.
        assert!(!record_housekeeping_tool(&session, "w2", "memory", ""));
        assert_eq!(recent_events(&session, 0).len(), rows);
    }

    #[test]
    fn a_window_with_no_hooks_at_all_falls_back_to_pane_activity() {
        let s = derive_from(&rec(), 1000, 1005);
        assert_eq!(s.state, "running", "a hookless backend has nothing else");
        assert_eq!(derive_from(&rec(), 1000, 1000 + ACTIVE_SECS + 1).state, "idle");
    }

    #[test]
    fn a_typed_line_is_acknowledged_by_the_prompt_hook_that_echoes_it() {
        let line = "[tmm chat] human: @dev ship it";
        record_delivery("ack-test", "w3", line, "");
        // The CLI submits our line (possibly with the agent's own leading text
        // when it was mid-typing) — containment, not equality.
        assert!(
            record_prompt("ack-test", "w3", &format!("{line}\n")),
            "the echo must acknowledge the pending delivery"
        );
        let evs = recent_events("ack-test", 0);
        assert_eq!(evs.last().unwrap().kind, "prompt");
        assert_eq!(evs.last().unwrap().via, "app", "an acked prompt came from this app");
        // Nothing pending any more, so the sweep stays silent.
        sweep_deliveries("ack-test");
        assert_eq!(recent_events("ack-test", 0).len(), 1, "no warning for a delivered line");
    }

    /// A multi-line message NEVER matched its echo. Two shapes, two owner
    /// reports: the composer renders a newline its own way (a space, a wrap —
    /// 2026-08-22 "发送内容有换行 好像就不会被confirm"), and tmux in
    /// extended-keys mode DROPPED the raw \n byte outright so the echo came
    /// back with the lines GLUED together (2026-08-24 "多行内容…没办法正确已
    /// 读，匹配有问题"). Matching is whitespace-BLIND now: every rendering of
    /// a break forgives — space, wrap, or nothing — while the characters
    /// still have to match in order.
    #[test]
    fn a_multi_line_delivery_is_acknowledged_despite_whitespace_drift() {
        let line = "[tmm chat] human: @dev line one\nline two\n  line three";
        record_delivery("ws-test", "w1", line, "");
        // The composer turned newlines into single spaces and doubled one.
        assert!(
            record_prompt("ws-test", "w1", "[tmm chat] human: @dev line one line two  line three"),
            "newline → space must still ack"
        );
        // CRLF and trailing whitespace on the echo side.
        record_delivery("ws-test", "w2", "[tmm chat] human: do\nthe thing", "");
        assert!(record_prompt("ws-test", "w2", "[tmm chat] human: do\r\nthe thing \n"));
        // tmux dropped the newline byte: the echo comes back GLUED — the
        // 2026-08-24 shape, measured live in the translator project
        // ("AgenticAI\nAgentic…" echoed as "AgenticAIAgentic…").
        record_delivery("ws-test", "w4", "[tmm chat] human: @dev AgenticAI\nAgentic AI 基础设施", "");
        assert!(
            record_prompt("ws-test", "w4", "[tmm chat] human: @dev AgenticAIAgentic AI 基础设施"),
            "newline → NOTHING must still ack"
        );
        // Different WORDS still refuse — tolerance must not become fuzz.
        record_delivery("ws-test", "w3", "[tmm chat] human: alpha beta", "");
        assert!(!record_prompt("ws-test", "w3", "[tmm chat] human: alpha gamma"));
    }

    // ── Board #5: an outstanding delivery survives OUR restart ─────────────
    //
    // The agent is a separate process: it holds the line we typed in its own
    // input queue and submits it whenever its turn ends. If the server restarts
    // in between, the echo used to arrive with nothing to match — filed as a
    // prompt the human typed at the keyboard (`via: local`, its own input row)
    // while the message it belonged to kept its hollow ring for ever (owner,
    // 2026-08-29). These tests are about the recovery, so they need the durable
    // half: `use_test_store` points the whole test process at a throwaway db.

    /// What the process loses when the binary restarts: every derived record and
    /// every hydration mark. state.db is untouched, which is the point.
    fn simulate_restart(session: &str) {
        forget_process_state(session);
    }

    #[test]
    fn a_pending_delivery_is_still_acknowledged_after_a_server_restart() {
        crate::projects::tests::use_test_store();
        let session = format!("restart-ack-{}", uuid::Uuid::new_v4());
        let line = "[tmm chat 2026-08-29 16:00] human: @dev 部署一下\n第二行";
        record_delivery(&session, "w1", line, "");

        simulate_restart(&session);
        assert_eq!(held(&session, "w1").len(), 1, "the table IS the queue: the restart took nothing");

        // The agent submits what it queued. Glued newlines (the tmux
        // extended-keys shape), so the whitespace-blind match is exercised on
        // the recovered line exactly as on a live one.
        assert!(
            record_prompt(&session, "w1", "[tmm chat 2026-08-29 16:00] human: @dev 部署一下第二行"),
            "the recovered delivery must still be acknowledged as ours"
        );
        let e = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!(
            (e.kind.as_str(), e.via.as_str()),
            ("prompt", "app"),
            "the receipt, not a separate line of keyboard input"
        );
        assert!(held(&session, "w1").is_empty(), "acked lines leave the queue");

        // Settled for good: another restart finds nothing to recover, so the
        // sweep cannot warn about a message that WAS delivered.
        simulate_restart(&session);
        sweep_deliveries(&session);
        assert_eq!(
            recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(),
            0,
            "a delivered line is never reported unconfirmed"
        );
    }

    #[test]
    fn a_restart_recovers_the_whole_queue_and_restarts_its_ack_clock() {
        crate::projects::tests::use_test_store();
        let session = format!("restart-queue-{}", uuid::Uuid::new_v4());
        record_prompt(&session, "w2", "open the turn");
        record_delivery(&session, "w2", "line one", "");
        record_delivery(&session, "w2", "line two", "");
        // A line typed LONG before the restart — the durable row keeps its real
        // typing time, which is what would make the first sweep after a restart
        // report it as unconfirmed seconds before its echo arrives.
        let long_ago = now().saturating_sub(DELIVERY_ACK_SECS * 20);
        crate::projects::with_store(|s| s.insert_delivery(&session, "w2", "stale line", 0, long_ago, "")).unwrap();

        simulate_restart(&session);

        // The sweep is the first thing that touches the session after a restart
        // (a client reading the feed). It recovers the queue and warns about
        // NOTHING: nobody was listening for these echoes while we were down, so
        // the ack clock starts here.
        sweep_deliveries(&session);
        assert_eq!(
            recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(),
            0,
            "a recovered line gets a real chance to come back"
        );
        assert_eq!(held(&session, "w2").len(), 3, "the whole queue is back, oldest first");

        // One submitted prompt carrying several of our lines still acks each of
        // them — the multi-message match is unchanged by the recovery.
        assert!(record_prompt(&session, "w2", "line one\nline two"));
        assert_eq!(held(&session, "w2"), vec!["stale line".to_string()]);
        assert!(record_prompt(&session, "w2", "stale line"));
        assert!(held(&session, "w2").is_empty());
    }

    #[test]
    fn a_reported_line_is_not_resurrected_and_a_dead_window_is_forgotten() {
        crate::projects::tests::use_test_store();
        let session = format!("restart-sweep-{}", uuid::Uuid::new_v4());
        record_delivery(&session, "w3", "@dev hello", "");
        // Past the ack window: the sweep reports it once and settles it.
        backdate(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 1);

        // A restart must not report it again: the row stays outstanding for a
        // late echo (board #249), but its warned mark is persisted.
        simulate_restart(&session);
        sweep_deliveries(&session);
        assert_eq!(
            recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(),
            1,
            "reported once, across a restart"
        );
        // And the late real echo still settles it as ours, naming the row the
        // warn named, so a client can retract exactly that warn.
        let warned_id = recent_events(&session, 0).into_iter().find(|e| e.kind == "warn").unwrap().deliveries[0].id;
        assert!(record_prompt(&session, "w3", "@dev hello"), "a warned row is still matchable");
        let echo = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt").last().unwrap();
        assert_eq!((echo.via.as_str(), echo.deliveries[0].id), ("app", warned_id));

        // And a window that no longer exists can never echo, so its queue goes
        // with the record instead of waiting for a recycled index to inherit it.
        record_delivery(&session, "w4", "@gone hello", "");
        retain_windows(&session, &[]);
        simulate_restart(&session);
        assert_eq!(
            crate::projects::with_store(|s| s.pending_deliveries(&session, None)).unwrap().len(),
            0,
            "a dead window's queue is dropped"
        );
    }

    // ── Board #9: the trace is COMPLETE, and the READ is what is bounded ────

    /// Nothing is thrown away, full stop. The old default deleted every event past
    /// 2000 per session, sporadically (the prune counter was per process, so a
    /// restart postponed it) — history lost that nobody asked to lose, and analysis
    /// cannot tell a deleted row from an event that never happened (owner, board
    /// #9: "我希望整个 trace 是非常完整的，以便我们后续去做一些分析"). A retention,
    /// if one is ever wanted, belongs in `Config` with a documented key; this test
    /// stands guard over the DEFAULT being "keep it all".
    #[test]
    fn the_durable_trace_is_never_pruned_behind_the_users_back() {
        // The write path holds no retention constant and no prune call any more:
        // the only pruning primitive left is `Store::prune_activity`, which nothing
        // in the recording path calls.
        let src = include_str!("telemetry.rs");
        let body = src.split("mod tests").next().unwrap();
        assert!(
            !body.contains("s.prune_activity("),
            "the recorder must not prune: a complete trace is the goal, not a side effect"
        );
        assert!(
            !body.contains("TMM_ACTIVITY_KEEP"),
            "no private env knob — a retention would go through Config, documented"
        );
        // And what IS bounded is the read, by a page cap.
        assert_eq!(MAX_PAGE_EVENTS, 1000);
        assert!(LOAD_EVENTS <= MAX_PAGE_EVENTS);
    }

    /// A page is bounded however loudly the caller asks, and it walks backwards.
    /// (The durable, indexed version is tested in `store.rs`; here the database is
    /// off, so this is the no-db fallback — which must still honour the cap rather
    /// than answering with everything it holds.)
    #[test]
    fn a_feed_page_is_capped_and_walks_back_from_its_own_cursor() {
        let session = format!("page-{}", uuid::Uuid::new_v4());
        for n in 0..10 {
            record_tool(&session, "w1", "Edit", &format!("f{n}.rs"));
        }
        let (newest, _) = events_page(&session, 0, None, 4);
        assert_eq!(newest.len(), 4, "the caller's limit is honoured");
        assert!(newest.last().unwrap().text.contains("f9"), "the page ENDS at the newest");
        assert!(newest.first().unwrap().text.contains("f6"), "oldest first within the page");

        // An absurd limit is clamped, not obeyed: one RPC may never turn into a
        // multi-megabyte frame.
        let (capped, _) = events_page(&session, 0, None, usize::MAX);
        assert!(capped.len() <= MAX_PAGE_EVENTS);

        // Walking back from the page's own oldest row yields older rows only.
        let cursor = (newest.first().unwrap().ts, newest.first().unwrap().id);
        let (older, _) = events_page(&session, 0, Some(cursor), 4);
        assert!(
            older.iter().all(|e| e.ts <= cursor.0),
            "a backwards page never returns anything newer than its cursor"
        );
        // And the plain read is still the newest page, unchanged for callers that
        // do not page.
        let plain = recent_events(&session, 0);
        assert!(plain.last().unwrap().text.contains("f9"));
    }

    #[test]
    fn a_prompt_typed_at_the_keyboard_is_recorded_as_local_input() {        assert!(!record_prompt("local-test", "w1", "fix the flaky test"), "nothing was pending");
        let e = recent_events("local-test", 1).into_iter().next().unwrap();
        assert_eq!((e.kind.as_str(), e.via.as_str()), ("prompt", "local"));
        assert_eq!(e.text, "fix the flaky test", "the input half of the transcript");
    }

    #[test]
    fn an_unacknowledged_delivery_is_reported_once() {
        // Backdate the pending line past the ack window.
        record_delivery("sweep-test", "w2", "[tmm chat] human: @dev hello", "");
        backdate("sweep-test");
        sweep_deliveries("sweep-test");
        let warns: Vec<String> = recent_events("sweep-test", 0)
            .iter()
            .filter(|e| e.kind == "warn")
            .map(|e| e.text.clone())
            .collect();
        assert_eq!(warns.len(), 1, "one report per unacked line");
        assert!(warns[0].contains("hello"), "the report names the line, got {:?}", warns[0]);
        sweep_deliveries("sweep-test");
        assert_eq!(
            recent_events("sweep-test", 0).iter().filter(|e| e.kind == "warn").count(),
            1,
            "sweeping again must not re-report"
        );
    }

    #[test]
    fn prompt_text_is_capped() {
        let long = "x".repeat(MAX_PROMPT_CHARS + 50);
        record_prompt("cap-test", "w1", &long);
        let e = recent_events("cap-test", 0).into_iter().next().unwrap();
        assert_eq!(e.text.chars().count(), MAX_PROMPT_CHARS + 1, "capped plus the ellipsis");
    }

    #[test]
    fn store_roundtrip_and_window_retention() {
        record_prompt("tsess", "w1", "one");
        record_prompt("tsess", "w2", "two");
        retain_windows("tsess", &["w2".to_string()]);
        let s1 = derive("tsess", "w1", 0);
        assert_eq!(s1.state, "idle", "dropped window's record must be gone");
        let s2 = derive("tsess", "w2", 0);
        assert_eq!(s2.state, "running", "the surviving record still answers");
        retain_windows("tsess", &[]);
    }
    /// Board #120, the reproduction that motivated the name key: with
    /// `renumber-windows on`, killing a lower window shifts every higher
    /// index and a NEWCOMER inherits the freed number. Keyed by index, dev's
    /// open turn painted rev's card and rev's history painted the newcomer's
    /// (measured 2026-09-09: @788 "dev" resolved 2 → 1 after the kill). Keyed
    /// by NAME, the same pane resolves to the same identity before and after
    /// the shift, and the newcomer starts with no facts.
    #[test]
    fn an_index_shift_cannot_move_turn_edges_between_agents() {
        let session = format!("tmm-idx-{}", std::process::id());
        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={session}")]).status();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "shell0", "sleep 60"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        let run = |args: &[&str]| { let _ = std::process::Command::new("tmux").args(args).status(); };
        run(&["new-window", "-d", "-t", &format!("={session}:"), "-n", "dev", "sleep 60"]);
        run(&["set-option", "-t", &format!("={session}:"), "renumber-windows", "on"]);
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &format!("={session}:dev"), "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        // Ingest exactly as the hook consumer does: resolve the pane, record.
        let (s1, w1, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane resolves");
        assert_eq!(w1, "dev", "the resolved key is the identity, not a number");
        record_prompt(&s1, &w1, "open a turn");
        assert_eq!(derive(&s1, "dev", 0).state, "running");

        // The shift: kill the lower window; a newcomer takes a freed index.
        run(&["kill-window", "-t", &format!("={session}:shell0")]);
        run(&["new-window", "-d", "-t", &format!("={session}:"), "-n", "newcomer", "sleep 60"]);

        // The SAME pane still resolves to the SAME key…
        let (_, w2, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane still resolves");
        assert_eq!(w2, "dev", "an index shift does not change the identity");
        assert_eq!(derive(&s1, "dev", 0).state, "running", "dev keeps its own open turn");
        // …and the newcomer inherits NOTHING (under index keys it inherited
        // whatever record sat at its number).
        assert_eq!(derive(&s1, "newcomer", 0).state, "idle", "no facts, honestly idle");

        run(&["kill-session", "-t", &format!("={session}")]);
    }

    /// Board #122 (1): two deliveries with the SAME body are two promises, and
    /// each echo settles exactly ONE of them, oldest first. The old upsert
    /// collapsed them into one entry, so the second echo found nothing and was
    /// filed as local keyboard input — the same hollow-ring symptom as the
    /// single-slot bug, from a third cause.
    #[test]
    fn identical_bodies_are_two_receipts_settled_one_per_echo() {
        let session = format!("dup-{}", uuid::Uuid::new_v4());
        let line = "[tmm chat 2026-09-09 06:30] human: @dev continue";
        record_delivery(&session, "dev", line, "");
        record_delivery(&session, "dev", line, "");
        let held = || held(&session, "dev").len();
        assert_eq!(held(), 2, "two deliveries of one body are two promises");

        // The CLI submits the queued lines one prompt at a time: each echo
        // settles exactly one entry, and both read as OUR delivery.
        assert!(record_prompt(&session, "dev", line), "first echo acks");
        assert_eq!(held(), 1, "one promise left");
        assert!(record_prompt(&session, "dev", line), "second echo acks the second, not via local");
        assert_eq!(held(), 0);

        // And ONE submission carrying the line TWICE settles both at once.
        record_delivery(&session, "dev", line, "");
        record_delivery(&session, "dev", line, "");
        let both = format!("{line}\n{line}");
        assert!(record_prompt(&session, "dev", &both));
        assert_eq!(held(), 0, "a double-carrying echo settles both");
    }

    // ── Board #249: the table is the ONE queue ────────────────────────────

    /// Validator's case: the server restarts in the middle of a long turn and
    /// no hook arrives for more than the ack window. The open turn is restored
    /// from the durable activity log, so the 30 lines the CLI still holds are
    /// not swept, and their echoes settle as ours.
    #[test]
    fn a_restart_mid_turn_keeps_the_turn_open_past_the_ack_window() {
        crate::projects::tests::use_test_store();
        let session = format!("midturn-{}", uuid::Uuid::new_v4());
        let opened = (now() - 600) * 1000;
        // The durable edges an earlier process wrote (persist() is off in tests).
        crate::projects::with_store(|s| {
            s.insert_activity(&session, "w1", opened - 5000, "notif", "completed", "", "", "", "")?;
            s.insert_activity(&session, "w1", opened, "prompt", "the 20-minute turn", "", "app", "", "")
        })
        .unwrap();
        let lines: Vec<String> = (0..30).map(|n| format!("[tmm chat 12:{n:02}] validator: @builder q{n}")).collect();
        for l in &lines {
            record_delivery(&session, "w1", l, "");
        }
        simulate_restart(&session);
        // The first touch after the restart recovers; then 46 s pass with no
        // hook from that window (lines and mark aged past the ack window).
        recovery_mark(&session);
        backdate(&session);
        recovery_marks().lock().unwrap().insert(session.clone(), (i64::MAX, now() - DELIVERY_ACK_SECS - 1));
        sweep_deliveries(&session);
        assert_eq!(derive(&session, "w1", 0).state, "running", "the open turn came back from the log");
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 0, "held lines are not swept");
        for l in &lines {
            assert!(record_prompt(&session, "w1", l), "{l} is still ours");
        }
        // A window whose last edge was a stop is NOT reopened.
        let closed = format!("closed-{}", uuid::Uuid::new_v4());
        crate::projects::with_store(|s| {
            s.insert_activity(&closed, "w1", opened, "prompt", "done turn", "", "app", "", "")?;
            s.insert_activity(&closed, "w1", opened + 1000, "notif", "completed", "", "", "", "")
        })
        .unwrap();
        recovery_mark(&closed);
        assert_eq!(derive(&closed, "w1", 0).state, "idle");
    }

    /// The echo names the messages it settled (board #249), so a client marks
    /// them delivered without holding them. A line without a message (a board
    /// notice) settles and names nothing; keyboard input names nothing.
    #[test]
    fn an_echo_names_the_messages_it_settled() {
        let session = format!("acks-{}", uuid::Uuid::new_v4());
        record_delivery(&session, "w1", "[tmm chat 12:41] validator: @builder one", "m-41");
        record_delivery(&session, "w1", "[tmm chat 12:42] validator: @builder two", "m-42");
        record_delivery(&session, "w1", "[board #241 reply] notice", "");
        assert!(record_prompt(&session, "w1", "[tmm chat 12:41] validator: @builder one\n[tmm chat 12:42] validator: @builder two"));
        assert!(record_prompt(&session, "w1", "[board #241 reply] notice"));
        record_prompt(&session, "w1", "typed at the keyboard");
        let msgs: Vec<Vec<String>> = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt")
            .map(|e| e.deliveries.into_iter().map(|d| d.msg).collect()).collect();
        assert_eq!(msgs, vec![vec!["m-41".to_string(), "m-42".to_string()], vec![String::new()], vec![]],
            "each settled ROW is named, with its message where it has one");
        let wire = serde_json::to_value(recent_events(&session, 0).remove(0)).unwrap();
        assert_eq!(wire["deliveries"][0]["msg"], "m-41");
        assert!(wire["deliveries"][0]["id"].as_i64().unwrap() > 0, "the row id is the key");
        let notice = serde_json::to_value(recent_events(&session, 0).remove(1)).unwrap();
        assert!(notice["deliveries"][0].get("msg").is_none(), "a notice row has no message");
        let local = serde_json::to_value(recent_events(&session, 0).pop().unwrap()).unwrap();
        assert!(local.get("deliveries").is_none(), "absent, not [], when it settled none");
    }

    /// 13:12:38 in the trace: a stop and the next queued prompt in the SAME
    /// second. `end >= start` on whole seconds read the new turn as idle, the
    /// ack clock started, and 45 s later the sweep reported the lines the
    /// running agent was still holding. Arrival order decides the tie.
    #[test]
    fn a_prompt_after_a_stop_in_the_same_second_opens_the_turn() {
        let session = format!("tie-{}", uuid::Uuid::new_v4());
        let t = now();
        record_prompt(&session, "w1", "turn one");
        record_notification(&session, "w1", "completed", t);
        record_prompt(&session, "w1", "turn two, queued"); // same second
        assert_eq!(derive(&session, "w1", 0).state, "running", "the later arrival wins the tie");
        record_delivery(&session, "w1", "@builder still queued", "");
        backdate(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 0, "a running turn is not swept");
        // And the reverse order in one second is a finished turn.
        record_notification(&session, "w1", "completed", now());
        assert_eq!(derive(&session, "w1", 0).state, "idle");
    }

    /// 20 lines typed at a busy window and echoed in order are all OUR
    /// deliveries. With the 16-line memory cap the oldest four echoed as
    /// keyboard input (INPUT rows) while their rows stayed in the table.
    #[test]
    fn twenty_lines_at_a_busy_window_all_echo_as_ours() {
        let session = format!("q20-{}", uuid::Uuid::new_v4());
        record_prompt(&session, "w1", "a long turn opens");
        let lines: Vec<String> = (0..20).map(|n| format!("[tmm chat 12:{n:02}] validator: @builder line {n}")).collect();
        for l in &lines {
            record_delivery(&session, "w1", l, "");
        }
        assert_eq!(held(&session, "w1").len(), 20, "no silent cap");
        for l in &lines {
            assert!(record_prompt(&session, "w1", l), "{l} is ours");
        }
        let vias: Vec<String> = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt").map(|e| e.via).skip(1).collect();
        assert_eq!(vias, vec!["app".to_string(); 20]);
        assert!(held(&session, "w1").is_empty());
    }

    /// 30 lines outstanding across a restart keep their typed order, and none
    /// is swept inside the grace the recovery gives them. The old fold kept a
    /// random 16 of them through an unordered map.
    #[test]
    fn thirty_pending_lines_survive_a_restart_in_order() {
        let session = format!("q30-{}", uuid::Uuid::new_v4());
        record_prompt(&session, "w1", "a long turn opens");
        let lines: Vec<String> = (0..30).map(|n| format!("[tmm chat 12:{n:02}] orchestrator: @builder item {n}")).collect();
        for l in &lines {
            record_delivery(&session, "w1", l, "");
        }
        simulate_restart(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 0, "the recovery grace holds");
        assert_eq!(held(&session, "w1"), lines, "typed order, all thirty");
        for l in &lines {
            assert!(record_prompt(&session, "w1", l));
        }
        let vias: Vec<String> = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt").map(|e| e.via).skip(1).collect();
        assert_eq!(vias, vec!["app".to_string(); 30], "not one of them reads as keyboard input");
    }

    /// Three identical bodies settle one per echo, and the sweep reports only
    /// the ones still owed — each promise once.
    #[test]
    fn duplicate_bodies_settle_one_by_one_and_sweep_by_row() {
        let session = format!("qdup-{}", uuid::Uuid::new_v4());
        let line = "[tmm chat 12:00] human: @dev again";
        for _ in 0..3 {
            record_delivery(&session, "dev", line, "");
        }
        assert!(record_prompt(&session, "dev", line));
        assert_eq!(held(&session, "dev").len(), 2);
        // That echo opened a turn, and a running agent is still holding the
        // other two; the sweep only speaks once the turn has ended.
        backdate(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 0, "queued, not lost");
        // The turn ended long enough ago for the clock: the stop arrived after
        // the prompt that opened it, both past the ack window.
        let ended = now() - DELIVERY_ACK_SECS - 1;
        with_rec(&session, "dev", |r| {
            r.prompt = Some(ended);
            r.prompt_seq = arrival();
            r.end = Some(("completed".into(), ended));
            r.end_seq = arrival();
        });
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 2, "each owed promise reported once");
        assert_eq!(held(&session, "dev").len(), 2, "reported, still outstanding for a late echo");
        sweep_deliveries(&session);
        simulate_restart(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 2, "twice more, across a restart: still once each");
    }

    /// Board #394 review P1: a replay that failed is asked again, and the
    /// retry never moves the delivery mark, so the ack grace of rows an
    /// earlier process typed starts once, at the first touch.
    #[test]
    fn a_failed_replay_is_retried_without_moving_the_delivery_mark() {
        crate::projects::tests::use_test_store();
        let session = format!("mark-{}", uuid::Uuid::new_v4());
        crate::projects::with_store(|s| s.insert_activity(&session, "w", now() * 1000, "prompt", "x", "", "app", "", "")).unwrap();
        test_exec_sql(&format!("UPDATE activity SET win = CAST(win AS BLOB) WHERE session = '{session}'"));
        let first = recovery_mark(&session);
        assert!(replay_error(&session).is_some());
        queue(|s| s.insert_delivery(&session, "w", "[tmm chat 03:00] lead: @w x", 0, now(), "")).unwrap();
        let second = recovery_mark(&session);
        assert!(replay_error(&session).is_some(), "asked again, still failing");
        assert_eq!(first, second, "a retry does not restart the ack grace");
        test_exec_sql(&format!("UPDATE activity SET win = CAST(win AS TEXT) WHERE session = '{session}'"));
        assert_eq!(recovery_mark(&session), first);
        assert_eq!(replay_error(&session), None, "repaired: replayed at the next touch");
        assert_eq!(derive(&session, "w", 0).state, "running");
    }

    /// A row typed by an earlier process waits from the recovery mark, a row
    /// typed by this one from its own typing time. Pure.
    #[test]
    fn a_recovered_row_waits_from_the_recovery_mark() {
        let r = rec();
        let rows = [row(5, "before the restart", 100), row(6, "after it", 1000)];
        let mark = (5, 1000); // rows <= 5 were typed before a restart at 1000
        assert_eq!(overdue_rows(&r, &rows, mark, 1000 + DELIVERY_ACK_SECS - 1), Vec::<i64>::new());
        assert_eq!(overdue_rows(&r, &rows, mark, 1000 + DELIVERY_ACK_SECS), vec![5, 6]);
        assert_eq!(overdue_rows(&r, &rows, MARK, 100 + DELIVERY_ACK_SECS), vec![5], "without a mark it keeps its typing time");
    }

    /// Orchestrator's key rule (#249): two identical notices with no message,
    /// both reported; one late echo settles exactly one row and names it, so
    /// exactly one warn is retracted and its sibling stays reported and owed.
    #[test]
    fn a_late_echo_settles_one_of_two_warned_identical_notices() {
        let session = format!("wdup-{}", uuid::Uuid::new_v4());
        let notice = "[board #241 reply] Release 1.0.0 — status review → doing";
        record_delivery(&session, "w1", notice, "");
        record_delivery(&session, "w1", notice, "");
        backdate(&session);
        sweep_deliveries(&session);
        let warns: Vec<i64> = recent_events(&session, 0).into_iter().filter(|e| e.kind == "warn").map(|e| e.deliveries[0].id).collect();
        assert_eq!(warns.len(), 2);
        assert_ne!(warns[0], warns[1], "each warn names its own row");
        assert!(record_prompt(&session, "w1", notice));
        let echo = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt").last().unwrap();
        assert_eq!(echo.deliveries.iter().map(|d| d.id).collect::<Vec<_>>(), vec![warns[0]], "the oldest row, and only it");
        assert_eq!(held(&session, "w1").len(), 1, "the sibling is still owed");
        assert!(record_prompt(&session, "w1", notice), "and its own late echo settles it too");
        let last = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt").last().unwrap();
        assert_eq!(last.deliveries[0].id, warns[1]);
    }

    /// Validator 14:54: an interrupt is an external end with no stop hook. It
    /// is written to the log, so after a restart the cancelled turn stays
    /// closed and a held line's clock runs.
    #[test]
    fn an_interrupted_turn_stays_closed_across_a_restart() {
        crate::projects::tests::use_test_store();
        let session = format!("intr-{}", uuid::Uuid::new_v4());
        let opened = (now() - 600) * 1000;
        crate::projects::with_store(|s| s.insert_activity(&session, "w1", opened, "prompt", "long turn", "", "app", "", "")).unwrap();
        // The live path: record_interrupt writes its end row (persist() is
        // off in unit tests, so the row it pushes is written here as persist
        // would write it).
        record_interrupt(&session, "w1");
        let end = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!((end.kind.as_str(), end.text.as_str()), ("notif", "interrupted"));
        // Written as persist would write it, dated as an interrupt made long
        // enough ago that a held line's clock has had its window since.
        crate::projects::with_store(|s| s.insert_activity(&session, "w1", opened + 1000, &end.kind, &end.text, "", "", "", "")).unwrap();
        record_delivery(&session, "w1", "[tmm chat 12:00] human: @dev queued", "");
        simulate_restart(&session);
        recovery_mark(&session);
        assert_eq!(derive(&session, "w1", 0).state, "idle", "the cancelled turn is not recovered as running");
        backdate(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 1, "the held line's clock ran");
        assert_eq!(for_each_turn_input(&session, "w1", None, |_: &[String]| {}), 0, "no reply edge recovered for a cancelled turn");
    }

    /// Orchestrator 15:44 (validator 15:42-15:43): tool dedupe may collapse a
    /// feed row, never drop a turn fact.
    /// (1) tool -> Stop -> the same tool within the dedupe window is a NEW
    /// tool-only turn: running, live and replayed.
    /// (2) Pre -> ask -> quick approval -> Post of the same call resumes the
    /// turn: running, live and replayed, and the feed lane shows ONE row.
    /// (3) A plain Pre/Post pair is still one row in the log.
    #[test]
    fn tool_dedupe_never_drops_a_turn_fact() {
        let replay_state = |session: &str| {
            let evs = events().lock().unwrap().get(session).cloned().unwrap_or_default();
            let fact = |pred: &dyn Fn(&ActivityEvent) -> bool| {
                evs.iter().enumerate().filter(|(_, e)| pred(e)).last().map(|(i, e)| crate::projects::store::TurnFact {
                    id: i as i64 + 1, ts: e.ts, text: e.text.clone(), tool: e.tool.clone(),
                })
            };
            let facts = crate::projects::store::TurnFacts {
                window: "w1".into(),
                prompt: fact(&|e| e.kind == "prompt"),
                tool: fact(&|e| e.kind == "tool"),
                ask: fact(&|e| e.kind == "notif" && matches!(e.text.as_str(), "permission_required" | "input_required")),
                end: fact(&|e| e.kind == "notif" && matches!(e.text.as_str(), "completed" | "failed" | "interrupted")),
            };
            let mut r = Rec::default();
            replay_turn_facts(&mut r, &facts);
            derive_from(&r, 0, now()).state
        };
        let tool_rows = |session: &str| recent_events(session, 0).into_iter().filter(|e| e.kind == "tool").count();

        let a = format!("dd-stop-{}", uuid::Uuid::new_v4());
        record_tool(&a, "w1", "Edit", "a.rs");
        record_notification(&a, "w1", "completed", now());
        assert_eq!(derive(&a, "w1", 0).state, "idle");
        record_tool(&a, "w1", "Edit", "a.rs"); // same call, < 3 s, after the stop
        assert_eq!(derive(&a, "w1", 0).state, "running", "a new tool-only turn");
        assert_eq!(replay_state(&a), "running", "and the log replays it");
        assert_eq!(tool_rows(&a), 2, "the fact is written");

        let b = format!("dd-ask-{}", uuid::Uuid::new_v4());
        record_prompt(&b, "w1", "run the tests");
        record_tool(&b, "w1", "Bash", "npm test"); // Pre
        record_notification(&b, "w1", "permission_required", now());
        assert_eq!(derive(&b, "w1", 0).state, "waiting");
        record_tool(&b, "w1", "Bash", "npm test"); // Post, right after approval
        assert_eq!(derive(&b, "w1", 0).state, "running", "the Post is the resume edge");
        assert_eq!(replay_state(&b), "running");
        let lane = feed_tool_rows(&b);
        assert_eq!(lane, 1, "the feed collapses the repeated call into one row");

        let c = format!("dd-pair-{}", uuid::Uuid::new_v4());
        record_tool(&c, "w1", "Read", "b.rs");
        record_tool(&c, "w1", "Read", "b.rs");
        assert_eq!(tool_rows(&c), 1, "a plain Pre/Post pair is still one row");
    }

    /// How many tool rows the client's feed would draw for a session: the
    /// same consecutive-per-window collapse `feedBlocks` applies (hub.ts).
    fn feed_tool_rows(session: &str) -> usize {
        let mut last: HashMap<String, String> = HashMap::new();
        recent_events(session, 0)
            .into_iter()
            .filter(|e| e.kind == "tool")
            .filter(|e| {
                let sig = format!("{}\u{0}{}", e.tool, e.text);
                last.insert(e.window.clone(), sig.clone()).as_deref() != Some(sig.as_str())
            })
            .count()
    }

    /// Orchestrator 15:48: live order is ONE counter, never a row id; it
    /// only increases, whether or not the fact's row was written.
    #[test]
    fn live_turn_facts_take_one_increasing_counter() {
        let orders: Vec<u64> = (0..10).map(|_| order_of()).collect();
        assert!(orders.windows(2).all(|w| w[0] < w[1]), "{orders:?}");
    }

    /// Validator 15:47/15:57, orchestrator 15:48/15:58: a REAL failed
    /// INSERT. SQLite consumes no id for it, so after a lost stop the next
    /// successful row gets exactly the id the stop would have had (max+1) —
    /// the case where row-id ordering tied the prompt with the lost stop and
    /// read idle. With one live counter the same-second prompt reads running.
    #[test]
    fn a_prompt_after_a_really_failed_stop_insert_reads_running() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("lost-{}", uuid::Uuid::new_v4());
        let t = now();
        record_prompt(&session, "w1", "turn one");
        let top = crate::projects::with_store(|s| s.max_activity_id()).unwrap();
        // The next notif INSERT really fails inside SQLite (a temp trigger on
        // this one connection), then the database "recovers".
        crate::projects::with_store(|s| s.exec_test_sql(&format!(
            "CREATE TEMP TRIGGER lost249 BEFORE INSERT ON activity WHEN NEW.session = '{session}' AND NEW.kind = 'notif'
             BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;"
        ))).unwrap();
        record_notification(&session, "w1", "completed", t);
        crate::projects::with_store(|s| s.exec_test_sql("DROP TRIGGER lost249;")).unwrap();
        record_prompt(&session, "w1", "turn two"); // same second
        PERSIST_IN_TEST.with(|p| p.set(false));
        let rows = crate::projects::with_store(|s| s.activity_since(&session, 0, 10)).unwrap();
        assert_eq!(rows.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), vec!["prompt", "prompt"], "the stop's row was lost");
        assert_eq!(rows[1].id, top + 1, "the failed INSERT consumed no id: the prompt got the id the stop would have had");
        assert_eq!(derive(&session, "w1", 0).state, "running", "the real prompt is not pressed under the lost stop");
    }

    /// Validator 15:07: the live record and the log must order turn facts the
    /// same way, or a restart derives a different state than the one the
    /// window had. Many threads interleave prompts, stops and interrupts on
    /// one window in the same second; afterwards the log (here the ring, in
    /// push order, standing in for the row ids) is replayed through the same
    /// replay + derive_from and must match the live record: same state, same
    /// newest fact of each kind.
    #[test]
    fn the_log_replays_to_the_live_state_under_concurrent_turn_facts() {
        for round in 0..60 {
            let session = format!("order-{round}-{}", uuid::Uuid::new_v4());
            let threads: Vec<_> = (0..4)
                .map(|t| {
                    let session = session.clone();
                    std::thread::spawn(move || {
                        for n in 0..25 {
                            match (t + n) % 3 {
                                0 => { record_prompt(&session, "w1", &format!("p{t}-{n}")); }
                                1 => record_notification(&session, "w1", "completed", now()),
                                _ => record_interrupt(&session, "w1"),
                            }
                        }
                    })
                })
                .collect();
            for th in threads {
                th.join().unwrap();
            }
            let live = store().lock().unwrap().get(&(session.clone(), "w1".to_string())).cloned().unwrap();
            let evs = events().lock().unwrap().get(&session).cloned().unwrap_or_default();
            let fact = |pred: &dyn Fn(&ActivityEvent) -> bool| {
                evs.iter().enumerate().filter(|(_, e)| pred(e)).last().map(|(i, e)| crate::projects::store::TurnFact {
                    id: i as i64 + 1, ts: e.ts, text: e.text.clone(), tool: e.tool.clone(),
                })
            };
            let facts = crate::projects::store::TurnFacts {
                window: "w1".into(),
                prompt: fact(&|e| e.kind == "prompt"),
                tool: None,
                ask: None,
                end: fact(&|e| e.kind == "notif" && matches!(e.text.as_str(), "completed" | "failed" | "interrupted")),
            };
            let mut replayed = Rec::default();
            replay_turn_facts(&mut replayed, &facts);
            let (a, b) = (derive_from(&live, 0, now()), derive_from(&replayed, 0, now()));
            assert_eq!((a.state.as_str(), a.since), (b.state.as_str(), b.since), "round {round}: log order = live order");
            assert_eq!(live.prompt, replayed.prompt, "round {round}: one clock for the record and the row");
            assert_eq!(live.end.as_ref().map(|e| e.1), replayed.end.as_ref().map(|e| e.1));
        }
    }

    /// Validator 14:53 / orchestrator 14:55: the replayed facts go through the
    /// one turn rule, so every shape `derive_from` knows survives a restart. A
    /// restart whose newest fact was a tool call (no prompt hook at all) or a
    /// permission ask, with no stop after it, keeps the held lines unswept past
    /// the ack window; a tool after a stop is not an open turn.
    /// Board #362 c (orchestrator's ruling 2, conditions b and c): the turn
    /// end the hooks missed ENDS the open turn, once per call, as one `failed`
    /// row carrying its detail and nothing else (no reply, no message); the
    /// state is idle with that detail, so the turn no longer holds a
    /// queue-mode agent's lines. A restart replays it. A turn that had
    /// already ended gets the detail on that end and no second row; a later
    /// prompt or hook end supersedes it.
    #[test]
    fn a_missed_end_ends_the_open_turn_with_its_detail_and_carries_no_reply() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("missed-{}", uuid::Uuid::new_v4());
        let rows = || crate::projects::with_store(|s| s.activity_since(&session, 0, 50)).unwrap();
        let ends = || rows().into_iter().filter(|r| r.kind == "notif").map(|r| (r.text, r.tool)).collect::<Vec<_>>();
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 12:32] maker: @critic G3 review");
        assert_eq!(derive(&session, "w1", 0).state, "running", "the hooks gave no end: running for hours, as measured");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|sig"), turn_version(&session, "w1"), now()), Missed::Ended);
        let st = derive(&session, "w1", 0);
        assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", "auth_expired"));
        assert!(!turn_busy(&session, "w1"), "an end: nothing is held behind it");
        assert_eq!(ends(), [("failed".to_string(), "auth_expired".to_string())], "one end row, the detail in it");
        assert_eq!(rows().iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), ["prompt", "notif"], "no reply and no message beside it");
        // A restart replays the end with its detail.
        simulate_restart(&session);
        recovery_mark(&session);
        let st = derive(&session, "w1", 0);
        assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", "auth_expired"));
        // The turn has ended: the detail goes on that end, no second row.
        assert_eq!(record_missed_end(&session, "w1", "recovery_exhausted", Identity::Paint("recovery_exhausted|sig"), turn_version(&session, "w1"), now()), Missed::Attached);
        assert_eq!(derive(&session, "w1", 0).detail, "recovery_exhausted");
        assert_eq!(ends().len(), 1, "no double end");
        // A later prompt supersedes it; so does that turn's own hook end.
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 23:10] human: @critic mwinit done");
        let st = derive(&session, "w1", 0);
        assert_eq!((st.state.as_str(), st.detail.as_str()), ("running", ""));
        record_notification_with(&session, "w1", "completed", now() + 1, EndQuality::Said);
        let st = derive(&session, "w1", 0);
        assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", ""));
        // A window with no turn at all gets nothing.
        assert_eq!(record_missed_end(&session, "w2", "auth_expired", Identity::Paint("auth_expired|sig"), turn_version(&session, "w2"), now()), Missed::NoTurn);
        assert_eq!(derive(&session, "w2", 0).detail, "");
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 review P2-2, the contract of a detail put on a turn that had
    /// ALREADY ended (an interrupt, a real hook end): it is written to memory
    /// only, and the end's own row stays the hook's. So a restart replays the
    /// end WITHOUT it, and no second end exists; the next capture tick that
    /// still sees the paint attaches it again (tested here as the same
    /// commit at the replayed version), still with no row.
    #[test]
    fn a_detail_on_an_ended_turn_is_memory_and_is_attached_again_after_a_restart() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        for (what, end) in [
            ("an interrupt", &(|s: &str| record_interrupt(s, "w1")) as &dyn Fn(&str)),
            ("a hook end", &|s: &str| record_notification_with(s, "w1", "completed", now(), EndQuality::Said)),
        ] {
            let session = format!("attached-{}", uuid::Uuid::new_v4());
            let ends = || crate::projects::with_store(|s| s.activity_since(&session, 0, 50)).unwrap().into_iter().filter(|r| r.kind == "notif").map(|r| (r.text, r.tool)).collect::<Vec<_>>();
            record_prompt(&session, "w1", "[tmm chat 2026-10-15 09:36] architect: @reviewer go");
            end(&session);
            let hook_end = ends();
            assert_eq!(hook_end.len(), 1, "{what}");
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|sig"), turn_version(&session, "w1"), now()), Missed::Attached, "{what}");
            assert_eq!(derive(&session, "w1", 0).detail, "auth_expired", "{what}");
            assert_eq!(ends(), hook_end, "{what}: the end's row is the hook's, unchanged; no second end");
            simulate_restart(&session);
            recovery_mark(&session);
            let st = derive(&session, "w1", 0);
            assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", ""), "{what}: memory only, by contract");
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|sig"), turn_version(&session, "w1"), now()), Missed::Attached, "{what}: the next tick");
            assert_eq!(derive(&session, "w1", 0).detail, "auth_expired", "{what}");
            assert_eq!(ends(), hook_end, "{what}: still one end");
        }
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 c, condition b across a gateway restart (found on the
    /// builder's live rig at 8fe5d522: a pane that had not repainted after a
    /// newer prompt still showed the old 401 as its newest paint, and the
    /// restarted gateway, its marks forgotten, ended the NEW turn). The paint
    /// that ended a turn is in the log, and the same paint never ends another
    /// turn of the window; a new paint (a new request id) does.
    #[test]
    fn a_paint_ends_one_turn_only_even_across_a_restart() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("once-{}", uuid::Uuid::new_v4());
        let ends = || crate::projects::with_store(|s| s.activity_since(&session, 0, 50)).unwrap().into_iter().filter(|r| r.kind == "notif").count();
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 12:32] maker: @cx go");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|a"), turn_version(&session, "w1"), now()), Missed::Ended);
        record_prompt(&session, "w1", "[tmm chat 2026-10-16 00:30] human: @cx mwinit done, carry on");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|a"), turn_version(&session, "w1"), now()), Missed::Recorded, "before a restart");
        simulate_restart(&session);
        recovery_mark(&session);
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|a"), turn_version(&session, "w1"), now()), Missed::Recorded, "after a restart");
        assert_eq!(derive(&session, "w1", 0).state, "running", "the newer turn is still open");
        assert_eq!(ends(), 1, "one end for one paint");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", Identity::Paint("auth_expired|b"), turn_version(&session, "w1"), now()), Missed::Ended, "a new paint ends the new turn");
        assert_eq!(ends(), 2);
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 review P1-C on 4cd26dc9: a paint ATTACHED to a turn that
    /// had already ended is accepted durably too. Turn A ends by an
    /// interrupt, the old 401 is attached to it, a new prompt opens turn B
    /// while the screen still shows that 401, and the gateway restarts: the
    /// same paint seen again ends nothing, B stays running, no row is
    /// written and B's held line stays held; when B then ends by its own
    /// hook, the paint is not put on B's end either.
    #[test]
    fn an_attached_paint_never_ends_a_later_turn_even_after_a_restart() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("p1c-{}", uuid::Uuid::new_v4());
        let ends = || crate::projects::with_store(|s| s.activity_since(&session, 0, 50)).unwrap().into_iter().filter(|r| r.kind == "notif").count();
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 09:36] architect: @reviewer go");
        record_interrupt(&session, "w1");
        let x = Identity::Paint("auth_expired|23a04597-c6d8-4439-954f-2216f9c7d687");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Attached);
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 23:10] human: @reviewer mwinit done");
        record_held(&session, "w1", "[tmm chat 2026-10-15 23:11] lead: @reviewer and this", 0, "m1").unwrap();
        let before = ends();
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Recorded, "before a restart");
        simulate_restart(&session);
        recovery_mark(&session);
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Recorded, "after a restart");
        let st = derive(&session, "w1", 0);
        assert_eq!((st.state.as_str(), st.detail.as_str()), ("running", ""), "turn B is untouched");
        assert_eq!(ends(), before, "no end written");
        assert_eq!(held_rows(&session, "w1").len(), 1, "B's held line is still held");
        // B then ends by its own hook, the screen still showing the old paint:
        // the paint is A's, and it is not put on B's end (the S2 race, across ticks).
        record_notification_with(&session, "w1", "completed", now() + 1, EndQuality::Said);
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Recorded);
        assert_eq!(derive(&session, "w1", 0).detail, "", "B's end keeps its own (empty) detail");
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 review P1-C residual on f998b599: a second is not an end's
    /// identity. A paint accepted for turn A's end never attaches to a NEWER
    /// end in the SAME second, before or after a restart, whether it was
    /// attached to A's hook end or ended A itself; A's own end, still
    /// current, takes its detail back after a restart.
    #[test]
    fn a_paint_is_bound_to_its_exact_end_not_to_a_second() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let x = Identity::Paint("auth_expired|23a04597-c6d8-4439-954f-2216f9c7d687");
        let t = now();
        for (what, a_ends) in [("attached to A's hook end", true), ("ended A itself", false)] {
            let session = format!("p1cr-{}", uuid::Uuid::new_v4());
            record_prompt(&session, "w1", "[tmm chat 2026-10-16 01:20] lead: @w1 A");
            if a_ends {
                record_notification_with(&session, "w1", "completed", t, EndQuality::Said);
                assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), t), Missed::Attached, "{what}");
            } else {
                assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), t), Missed::Ended, "{what}");
            }
            // A's own end, current, re-attaches after a restart.
            simulate_restart(&session);
            recovery_mark(&session);
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), t), Missed::Attached, "{what}: A's own end");
            assert_eq!(derive(&session, "w1", 0).detail, "auth_expired", "{what}");
            // Turn B opens and ends by its hook in the SAME second as A's end.
            record_prompt(&session, "w1", "[tmm chat 2026-10-16 01:20] lead: @w1 B");
            record_notification_with(&session, "w1", "completed", t, EndQuality::Said);
            for when in ["before a restart", "after a restart"] {
                if when == "after a restart" {
                    simulate_restart(&session);
                    recovery_mark(&session);
                }
                assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), t), Missed::Recorded, "{what}, {when}");
                let st = derive(&session, "w1", 0);
                assert_eq!((st.state.as_str(), st.detail.as_str()), ("idle", ""), "{what}, {when}: B's end keeps its own detail");
            }
        }
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362, the orchestrator's ruling on accepted-once: a paint with
    /// a Request ID, once accepted, stays accepted whatever came in between.
    /// X is accepted for turn A (ending it, or attached to A's hook end), a
    /// newer paint Y for turn B, and X then comes back as the newest paint on
    /// turn C, open or already ended by its own hook: X is Recorded, C keeps
    /// its state and its own detail, no end is written, C's held line stays
    /// held, before and after a restart. A paint never seen before (Z) is
    /// still handled.
    #[test]
    fn an_accepted_paint_stays_accepted_whatever_came_in_between() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let x = Identity::Paint("auth_expired|23a04597-c6d8-4439-954f-2216f9c7d687");
        let y = Identity::Paint("auth_expired|be7c7ada-a80d-4670-be53-11d245f535e7");
        let z = Identity::Paint("auth_expired|389cc17d-bf5d-409b-ba80-102270246c79");
        for (x_how, c_ended) in [("Ended", false), ("Ended", true), ("Attached", false), ("Attached", true)] {
            let what = format!("X {x_how}, C {}", if c_ended { "ended" } else { "open" });
            let session = format!("once-{}", uuid::Uuid::new_v4());
            let ends = || crate::projects::with_store(|s| s.activity_since(&session, 0, 50)).unwrap().into_iter().filter(|r| r.kind == "notif" && r.text == "failed").count();
            let version = || turn_version(&session, "w1");
            record_prompt(&session, "w1", "[tmm chat 2026-10-16 01:50] lead: @w1 A");
            if x_how == "Attached" {
                record_interrupt(&session, "w1");
                assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, version(), now()), Missed::Attached, "{what}");
            } else {
                assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, version(), now()), Missed::Ended, "{what}");
            }
            record_prompt(&session, "w1", "[tmm chat 2026-10-16 01:51] lead: @w1 B");
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", y, version(), now()), Missed::Ended, "{what}: Y");
            record_prompt(&session, "w1", "[tmm chat 2026-10-16 01:52] lead: @w1 C");
            record_held(&session, "w1", "[tmm chat 2026-10-16 01:52] human: @w1 held for C", 0, "m1").unwrap();
            if c_ended {
                record_notification_with(&session, "w1", "completed", now(), EndQuality::Said);
            }
            let before = (derive(&session, "w1", 0), ends(), held_rows(&session, "w1").len());
            for when in ["before a restart", "after a restart"] {
                if when == "after a restart" {
                    simulate_restart(&session);
                    recovery_mark(&session);
                }
                assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, version(), now()), Missed::Recorded, "{what}, {when}");
                let st = derive(&session, "w1", 0);
                assert_eq!((st.state.as_str(), st.detail.as_str()), (before.0.state.as_str(), before.0.detail.as_str()), "{what}, {when}: C untouched");
                assert_ne!(st.detail, "auth_expired", "{what}, {when}: no old detail on C");
                assert_eq!(ends(), before.1, "{what}, {when}: no extra end");
                if !c_ended {
                    assert_eq!(held_rows(&session, "w1").len(), before.2, "{what}, {when}: C's held line stays held");
                }
            }
            // A paint never accepted is still handled.
            assert!(matches!(record_missed_end(&session, "w1", "auth_expired", z, version(), now()), Missed::Ended | Missed::Attached), "{what}: Z");
        }
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 review P1-E on f998b599: the synthetic end and its
    /// acceptance mark commit together. The meta table is writable but the
    /// end's INSERT is refused (a real failed write): Unknown, no mark left
    /// to swallow later handling, the turn still running and its held line
    /// not flushed. The other way round, a refused mark leaves no end row
    /// (the transaction rolled back). After the database recovers and the
    /// gateway restarts, the turn gets exactly one end.
    #[test]
    fn the_missed_end_and_its_mark_commit_together_or_not_at_all() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let x = Identity::Paint("auth_expired|389cc17d-bf5d-409b-ba80-102270246c79");
        for refused in ["activity", "meta"] {
            let session = format!("p1e-{refused}-{}", uuid::Uuid::new_v4());
            let ends = || crate::projects::with_store(|s| s.activity_since(&session, 0, 50)).unwrap().into_iter().filter(|r| r.kind == "notif").count();
            record_prompt(&session, "w1", "[tmm chat 2026-10-15 12:32] maker: @critic go");
            record_held(&session, "w1", "[tmm chat 2026-10-15 12:33] human: @critic held", 0, "m1").unwrap();
            let guard = if refused == "activity" {
                format!("BEFORE INSERT ON activity WHEN NEW.session = '{session}' AND NEW.kind = 'notif'")
            } else {
                format!("BEFORE INSERT ON meta WHEN NEW.key = 'person_paint:{session}:w1:auth_expired|389cc17d-bf5d-409b-ba80-102270246c79'")
            };
            crate::projects::with_store(|s| s.exec_test_sql(&format!("CREATE TEMP TRIGGER p1e {guard} BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;"))).unwrap();
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Unknown, "{refused} refused");
            crate::projects::with_store(|s| s.exec_test_sql("DROP TRIGGER p1e;")).unwrap();
            assert_eq!(accepted_paint(&session, "w1", "auth_expired|389cc17d-bf5d-409b-ba80-102270246c79").unwrap(), None, "{refused} refused: no mark");
            assert_eq!(ends(), 0, "{refused} refused: no end row");
            assert_eq!(derive(&session, "w1", 0).state, "running", "{refused} refused: nothing ended in memory");
            assert_eq!(held_rows(&session, "w1").len(), 1, "{refused} refused: not flushed as a success");
            simulate_restart(&session);
            recovery_mark(&session);
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Ended, "{refused}: recovered");
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Attached, "{refused}: then its own end");
            assert_eq!(ends(), 1, "{refused}: exactly one end");
            assert_eq!(derive(&session, "w1", 0).detail, "auth_expired");
        }
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #362 review P2 on f998b599: a mark that exists but does not
    /// parse is UNKNOWN, not absent: nothing is recorded on it.
    #[test]
    fn an_unparseable_acceptance_mark_is_unknown_not_absent() {
        crate::projects::tests::use_test_store();
        let session = format!("p2p-{}", uuid::Uuid::new_v4());
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 12:32] maker: @critic go");
        let x = Identity::Paint("auth_expired|389cc17d-bf5d-409b-ba80-102270246c79");
        for bad in ["garbage", "0", "-3", "12 x", ""] {
            crate::projects::with_store(|s| s.meta_set(&crate::projects::store::person_paint_key(&session, "w1", "auth_expired|389cc17d-bf5d-409b-ba80-102270246c79"), bad)).unwrap();
            assert!(accepted_paint(&session, "w1", "auth_expired|389cc17d-bf5d-409b-ba80-102270246c79").is_err(), "{bad:?}");
            assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Unknown, "{bad:?}");
            assert_eq!(derive(&session, "w1", 0).state, "running", "{bad:?}");
        }
    }

    /// Board #362 review P2 on 4cd26dc9: the paint record is a safety gate,
    /// so a record that cannot be written is UNKNOWN. Nothing is ended,
    /// attached, flushed or marked (a real failed write, a temp trigger on
    /// this connection); once the database answers again the same
    /// observation is accepted.
    #[test]
    fn a_paint_record_that_cannot_be_written_records_nothing() {
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("p2u-{}", uuid::Uuid::new_v4());
        record_prompt(&session, "w1", "[tmm chat 2026-10-15 12:32] maker: @critic go");
        record_held(&session, "w1", "[tmm chat 2026-10-15 12:33] human: @critic held", 0, "m1").unwrap();
        crate::projects::with_store(|s| s.exec_test_sql(&format!(
            "CREATE TEMP TRIGGER p2u BEFORE INSERT ON meta WHEN NEW.key = 'person_paint:{session}:w1:auth_expired|389cc17d-bf5d-409b-ba80-102270246c79'
             BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;"
        ))).unwrap();
        let x = Identity::Paint("auth_expired|389cc17d-bf5d-409b-ba80-102270246c79");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Unknown);
        crate::projects::with_store(|s| s.exec_test_sql("DROP TRIGGER p2u;")).unwrap();
        assert_eq!(derive(&session, "w1", 0).state, "running", "nothing ended");
        assert_eq!(held_rows(&session, "w1").len(), 1, "nothing flushed");
        assert_eq!(accepted_paint(&session, "w1", "auth_expired|389cc17d-bf5d-409b-ba80-102270246c79").unwrap(), None, "nothing marked");
        assert_eq!(record_missed_end(&session, "w1", "auth_expired", x, turn_version(&session, "w1"), now()), Missed::Ended, "asked again, accepted");
        PERSIST_IN_TEST.with(|p| p.set(false));
    }

    #[test]
    fn a_restart_recovers_a_tool_only_or_asking_turn() {
        crate::projects::tests::use_test_store();
        let opened = (now() - 600) * 1000;
        for (label, facts, want, warns) in [
            ("tool-only", vec![("tool", "src/lib.rs", "Edit")], "running", 0),
            ("ask", vec![("prompt", "do it", ""), ("notif", "permission_required", "")], "waiting", 0),
            ("tool-after-ask", vec![("notif", "permission_required", ""), ("tool", "npm test", "Bash")], "running", 0),
            // An ended turn is ended, failure and all (#354): the held
            // line's clock ran from its end.
            ("failed", vec![("prompt", "do it", ""), ("notif", "failed", "")], "idle", 1),
        ] {
            let session = format!("rec-{label}-{}", uuid::Uuid::new_v4());
            crate::projects::with_store(|s| {
                for (n, (kind, text, tool)) in facts.iter().enumerate() {
                    s.insert_activity(&session, "w1", opened + n as u64, kind, text, tool, "", "", "")?;
                }
                Ok(())
            })
            .unwrap();
            record_delivery(&session, "w1", "[tmm chat 12:00] human: @dev held", "");
            simulate_restart(&session);
            recovery_mark(&session);
            backdate(&session);
            sweep_deliveries(&session);
            assert_eq!(derive(&session, "w1", 0).state, want, "{label}");
            assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), warns, "{label}: held line swept only when the turn ended");
        }
        // A tool call AFTER the stop is not an open turn (and kiro v3's
        // post-stop housekeeping is never written as a tool row, #227).
        let closed = format!("rec-closed-{}", uuid::Uuid::new_v4());
        crate::projects::with_store(|s| {
            s.insert_activity(&closed, "w1", opened, "tool", "a.rs", "Edit", "", "", "")?;
            s.insert_activity(&closed, "w1", opened + 1, "notif", "completed", "", "", "", "")
        })
        .unwrap();
        recovery_mark(&closed);
        assert_eq!(derive(&closed, "w1", 0).state, "idle");
    }

    /// Validator's restart tie (#249): a turn edge recovered from the log keeps
    /// the log's order, and a stop observed AFTER the restart in the same
    /// second still sorts after it — even when the recovered row id is larger
    /// than any number this process has handed out.
    #[test]
    fn a_stop_after_a_restart_sorts_after_a_recovered_prompt_in_the_same_second() {
        crate::projects::tests::use_test_store();
        let session = format!("rtie-{}", uuid::Uuid::new_v4());
        let t = now();
        crate::projects::with_store(|s| s.insert_activity(&session, "w1", t * 1000, "prompt", "long turn", "", "app", "", "")).unwrap();
        let row_id = crate::projects::with_store(|s| s.turn_facts(&session)).unwrap().remove(0).prompt.unwrap().id;
        // Simulate a log far ahead of this process's counter: the recovered
        // order must still move the counter past it.
        let far = row_id + 1_000_000_000;
        simulate_restart(&session);
        with_rec(&session, "w1", |r| {
            r.prompt = Some(t);
            r.prompt_seq = recovered_arrival(far);
        });
        assert_eq!(derive(&session, "w1", 0).state, "running", "the recovered turn is open");
        record_notification(&session, "w1", "completed", t); // same second, after the restart
        assert_eq!(derive(&session, "w1", 0).state, "idle", "the later stop wins the tie");
        record_prompt(&session, "w1", "next queued line"); // and the next prompt, same second
        assert_eq!(derive(&session, "w1", 0).state, "running");
        // A stop then a restart in the same second then a new prompt: the stop
        // is not recovered as open, and the new prompt opens the turn.
        let closed = format!("rtie2-{}", uuid::Uuid::new_v4());
        crate::projects::with_store(|s| {
            s.insert_activity(&closed, "w1", t * 1000, "prompt", "turn", "", "app", "", "")?;
            s.insert_activity(&closed, "w1", t * 1000, "notif", "completed", "", "", "", "")
        })
        .unwrap();
        recovery_mark(&closed);
        assert_eq!(derive(&closed, "w1", 0).state, "idle");
        record_prompt(&closed, "w1", "new prompt, same second");
        assert_eq!(derive(&closed, "w1", 0).state, "running");
    }

    /// Validator's variant (#249): of two identical msg-less deliveries only
    /// the FIRST is warned (the second was typed later and is still in its
    /// ack window). The first late echo settles and names the warned row; the
    /// second echo settles the unwarned sibling. Both read as ours.
    #[test]
    fn only_the_warned_twin_is_named_by_its_late_echo() {
        let session = format!("wone-{}", uuid::Uuid::new_v4());
        let notice = "[board #242 reply] status review → doing";
        record_delivery(&session, "w1", notice, "");
        backdate(&session); // only this row is past the window
        record_delivery(&session, "w1", notice, "");
        sweep_deliveries(&session);
        let warns: Vec<i64> = recent_events(&session, 0).into_iter().filter(|e| e.kind == "warn").map(|e| e.deliveries[0].id).collect();
        let rows: Vec<i64> = crate::projects::with_store(|s| s.pending_deliveries(&session, Some("w1"))).unwrap().iter().map(|r| r.id).collect();
        assert_eq!(warns, vec![rows[0]], "only the first is reported");
        assert!(record_prompt(&session, "w1", notice));
        assert!(record_prompt(&session, "w1", notice));
        let echoes: Vec<(String, i64)> = recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt")
            .map(|e| (e.via, e.deliveries[0].id)).collect();
        assert_eq!(echoes, vec![("app".to_string(), rows[0]), ("app".to_string(), rows[1])],
            "the first echo retracts the first warn; the second settles the unwarned twin");
        assert!(held(&session, "w1").is_empty());
    }

    /// Validator 14:40: the same-second restart order in a REAL fresh process.
    /// The parent writes an earlier process's turn edges into a scratch
    /// database, then runs this test binary again as a child (a new process,
    /// so a new counter) against it. Two cases, one second each:
    /// (1) stop, restart, new prompt -> running;
    /// (2) open prompt, restart (recovered from the log), stop -> idle, then
    ///     prompt -> running.
    #[test]
    fn same_second_order_survives_a_real_process_restart() {
        let dir = std::env::temp_dir().join(format!("tmm-fresh-proc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("state.db");
        let t = now();
        {
            let store = crate::projects::store::Store::open(&db).unwrap();
            // Enough earlier rows that recovered ids are well above a fresh
            // process's first counter values.
            for n in 0..50 {
                store.insert_activity("filler", "w9", n, "tool", "x", "Edit", "", "", "").unwrap();
            }
            store.insert_activity("fp-stop", "w1", t * 1000, "prompt", "turn", "", "app", "", "").unwrap();
            store.insert_activity("fp-stop", "w1", t * 1000, "notif", "completed", "", "", "", "").unwrap();
            store.insert_activity("fp-open", "w1", t * 1000, "prompt", "long turn", "", "app", "", "").unwrap();
        }
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "projects::telemetry::tests::fresh_process_child", "--ignored", "--test-threads=1", "--nocapture"])
            .env("TMM_TEST_CHILD_DB", &db)
            .env("TMM_FRESH_T", t.to_string())
            .output()
            .unwrap();
        let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(out.status.success(), "child failed:\n{log}");
        assert!(log.contains("1 passed"), "the child really ran:\n{log}");
    }

    /// The child half of `same_second_order_survives_a_real_process_restart`.
    /// Ignored on its own: it needs the parent's scratch database.
    #[test]
    #[ignore]
    fn fresh_process_child() {
        let t: u64 = std::env::var("TMM_FRESH_T").expect("run by the parent").parse().unwrap();
        // (1) stop -> restart -> prompt, one second: nothing is recovered as open.
        recovery_mark("fp-stop");
        assert_eq!(derive("fp-stop", "w1", 0).state, "idle", "a stopped turn is not reopened");
        with_rec("fp-stop", "w1", |r| {
            r.prompt = Some(t);
            r.prompt_seq = arrival();
        });
        assert_eq!(derive("fp-stop", "w1", 0).state, "running", "the new prompt opens the turn");
        // (2) the open prompt is recovered with its row id; a stop observed by
        // this new process in the same second must sort after it.
        recovery_mark("fp-open");
        assert_eq!(derive("fp-open", "w1", 0).state, "running", "recovered from the log");
        record_notification("fp-open", "w1", "completed", t);
        assert_eq!(derive("fp-open", "w1", 0).state, "idle", "the later stop wins the same-second tie");
        with_rec("fp-open", "w1", |r| {
            r.prompt = Some(t);
            r.prompt_seq = arrival();
        });
        assert_eq!(derive("fp-open", "w1", 0).state, "running");
    }

    /// The matcher over rows, pure: order, duplicates and truncation.
    #[test]
    fn settled_by_spends_one_receipt_per_occurrence() {
        let rows = [row(1, "a b", 0), row(2, "a b", 0), row(3, "other", 0), row(4, "a very long line cut short", 0)];
        let ids = |p: &str| settled_by(&rows, p).into_iter().map(|hit| hit.row.id).collect::<Vec<_>>();
        assert_eq!(ids("a\nb"), vec![1], "one occurrence settles the oldest duplicate");
        assert_eq!(ids("a b\na b"), vec![1, 2]);
        assert_eq!(ids("a very long line cut"), vec![4], "a truncated echo settles the longer line");
        assert_eq!(ids("nothing of ours"), Vec::<i64>::new());
    }

    // ── Board #264: a slash command's receipt row ──────────────────────────

    /// kiro 2.22.1 echoes `/goal <args>` as `goal <args>`: that echo settles
    /// the command's row by the one matcher, names the room message, and so
    /// is a receipt (`via: app`), not an INPUT row.
    #[test]
    fn a_kiro_goal_echo_settles_the_command_bubble() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-goal-{}", uuid::Uuid::new_v4());
        let echo = crate::backends::Backend::Kiro.command_echo("/goal", "看一下 ../eks 集群").unwrap();
        assert_eq!(echo, "goal 看一下 ../eks 集群");
        assert!(record_command_delivery(&session, "kiro", &echo, "m-goal").is_some());
        assert!(record_prompt(&session, "kiro", "goal 看一下 ../eks 集群"), "the echo is the command's receipt");
        let e = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!((e.kind.as_str(), e.via.as_str()), ("prompt", "app"));
        assert_eq!(e.deliveries.iter().map(|d| d.msg.as_str()).collect::<Vec<_>>(), vec!["m-goal"], "the bubble is named");
        assert!(held(&session, "kiro").is_empty());
    }

    /// Most commands fire no prompt hook (`/effort`), so no backend declares
    /// an echo for them and they get no receipt row at all (validator, #264).
    #[test]
    fn a_command_without_a_measured_hook_has_no_receipt() {
        for b in crate::backends::Backend::ALL {
            assert_eq!(b.command_echo("/effort", "medium"), None, "{b:?}");
        }
    }

    /// The window's next prompt is the command's echo or proof of none: a
    /// local prompt that does not carry it drops that row and renders as
    /// itself.
    #[test]
    fn a_non_matching_next_prompt_drops_the_command_row() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-miss-{}", uuid::Uuid::new_v4());
        record_command_delivery(&session, "claude", "/goal do x", "m-x").unwrap();
        assert!(!record_prompt(&session, "claude", "fix the flaky test"), "not ours");
        let e = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!((e.kind.as_str(), e.via.as_str(), e.text.as_str()), ("prompt", "local", "fix the flaky test"));
        assert!(held(&session, "claude").is_empty(), "the command row is gone");
        assert!(!record_prompt(&session, "claude", "/goal do x"), "and a later look-alike cannot claim it");
    }

    /// Validator 11:50: an idle /goal whose CLI emits no prompt hook but does
    /// end a turn (completed or failed) retires at that end — one row, the
    /// oldest Idle — so a later look-alike prompt cannot claim it; a row
    /// queued behind it stays and is promoted.
    #[test]
    fn an_end_without_a_prompt_retires_the_oldest_idle_command() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-end-{}", uuid::Uuid::new_v4());
        record_command_delivery(&session, "kiro", "goal a", "m-a").unwrap();
        record_notification(&session, "kiro", "failed", now());
        assert!(held(&session, "kiro").is_empty(), "no prompt in that turn: the command echoed nothing");
        assert!(!record_prompt(&session, "kiro", "goal a"), "a later look-alike is local input, not its receipt");
        // Only ONE row per end, and not one queued behind the ending turn.
        record_notification(&session, "kiro", "completed", now());
        record_command_delivery(&session, "kiro", "goal b", "m-b").unwrap();
        record_command_delivery(&session, "kiro", "goal c", "m-c").unwrap();
        record_notification(&session, "kiro", "completed", now());
        assert_eq!(held(&session, "kiro"), vec!["goal c"], "the oldest Idle retired, the next stays");
    }

    /// Validator 11:56 / orchestrator 11:57: an end edge cannot land inside a
    /// prompt's settlement. The end is released INSIDE the echo's critical
    /// section; it must wait, then see that the turn had a prompt, and so
    /// retire nothing — the second queued command stays owed.
    #[test]
    fn an_end_racing_an_echo_waits_and_keeps_the_next_command() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-race-{}", uuid::Uuid::new_v4());
        assert!(!record_prompt(&session, "kiro", "a long task"));
        record_command_delivery(&session, "kiro", "goal a", "m-a").unwrap();
        record_command_delivery(&session, "kiro", "goal b", "m-b").unwrap();
        record_notification(&session, "kiro", "completed", now()); // both Idle now
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_inside = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s2, d2, d3, seen) = (session.clone(), done.clone(), done.clone(), done_inside.clone());
        let racer: std::sync::Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Default::default();
        let slot = racer.clone();
        *IN_PROMPT_HOOK.lock().unwrap() = Some(Box::new(move || {
            *slot.lock().unwrap() = Some(std::thread::spawn(move || {
                record_notification(&s2, "kiro", "completed", now());
                d2.store(true, std::sync::atomic::Ordering::SeqCst);
            }));
            std::thread::sleep(std::time::Duration::from_millis(150));
            // Still INSIDE the echo's section, so the end cannot have finished.
            // Observed here, asserted below: see `a_command_recorded_during_an_end...`.
            seen.store(d3.load(std::sync::atomic::Ordering::SeqCst), std::sync::atomic::Ordering::SeqCst);
        }));
        assert!(record_prompt(&session, "kiro", "goal a"), "goal a's echo");
        assert!(!done_inside.load(std::sync::atomic::Ordering::SeqCst), "the end waited for the echo's section");
        racer.lock().unwrap().take().unwrap().join().unwrap();
        assert_eq!(held(&session, "kiro"), vec!["goal b"], "the end saw goal a's prompt and retired nothing");
        assert!(record_prompt(&session, "kiro", "goal b"), "and goal b's own echo settles it");
    }

    /// Validator 12:07: a command recorded while an end edge is inside its
    /// section waits for it, and so is never the "oldest Idle" that end
    /// retires — the new command stays owed.
    #[test]
    fn a_command_recorded_during_an_end_is_not_retired_by_it() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-end-race-{}", uuid::Uuid::new_v4());
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_inside = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s2, d2, d3, seen) = (session.clone(), done.clone(), done.clone(), done_inside.clone());
        let racer: std::sync::Arc<Mutex<Option<std::thread::JoinHandle<()>>>> = Default::default();
        let slot = racer.clone();
        *IN_END_HOOK.lock().unwrap() = Some(Box::new(move || {
            *slot.lock().unwrap() = Some(std::thread::spawn(move || {
                record_command_delivery(&s2, "kiro", "goal new", "m-new").unwrap();
                d2.store(true, std::sync::atomic::Ordering::SeqCst);
            }));
            std::thread::sleep(std::time::Duration::from_millis(150));
            // Still INSIDE the end's section, so the insert cannot have finished:
            // that is the only moment "it waited" is a fact. It is OBSERVED here
            // and asserted after the call. Asserting `done` after
            // `record_notification` returns (the first form of this test) read it
            // AFTER the section ended, when that very return has released the
            // racer: on an idle machine the asserting thread runs first, under
            // load the racer finishes its insert first and the test failed with
            // nothing wrong in the code (board #386: 21 of 320 runs at 2x CPU
            // oversubscription).
            seen.store(d3.load(std::sync::atomic::Ordering::SeqCst), std::sync::atomic::Ordering::SeqCst);
        }));
        // A prompt-less end: it WILL retire the oldest Idle command it sees.
        record_notification(&session, "kiro", "failed", now());
        assert!(!done_inside.load(std::sync::atomic::Ordering::SeqCst), "the insert waited for the end's section");
        racer.lock().unwrap().take().unwrap().join().unwrap();
        assert_eq!(held(&session, "kiro"), vec!["goal new"], "the new command was not retired by the end it raced");
        assert!(record_prompt(&session, "kiro", "goal new"), "and its echo settles it");
    }

    /// A command typed into a RUNNING turn is queued by the CLI: no prompt of
    /// that turn may take it, its end does not retire it, its echo settles it.
    #[test]
    fn a_queued_command_survives_the_running_turns_end() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-queued-{}", uuid::Uuid::new_v4());
        assert!(!record_prompt(&session, "kiro", "a long task"), "a turn opens");
        record_command_delivery(&session, "kiro", "goal next", "m-q").unwrap();
        assert!(!record_prompt(&session, "kiro", "steer: also check the logs"), "a mid-turn prompt is not its echo");
        assert_eq!(held(&session, "kiro"), vec!["goal next"], "and cannot drop it");
        record_notification(&session, "kiro", "completed", now());
        assert_eq!(held(&session, "kiro"), vec!["goal next"], "the end it waited for does not retire it");
        assert!(record_prompt(&session, "kiro", "goal next"), "then its echo settles it");
        assert!(held(&session, "kiro").is_empty());
    }

    /// Validator on #264: two /goal queued at one busy pane. Each echo
    /// settles its own row in order — the first does not take the second —
    /// and neither becomes an INPUT row.
    #[test]
    fn two_queued_commands_settle_in_order() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-fifo-{}", uuid::Uuid::new_v4());
        assert!(!record_prompt(&session, "kiro", "a long task"));
        record_command_delivery(&session, "kiro", "goal a", "m-a").unwrap();
        record_command_delivery(&session, "kiro", "goal a then b", "m-b").unwrap();
        record_notification(&session, "kiro", "completed", now());
        assert!(record_prompt(&session, "kiro", "goal a"), "the first echo");
        assert_eq!(held(&session, "kiro"), vec!["goal a then b"], "the second is still owed");
        record_notification(&session, "kiro", "completed", now());
        assert_eq!(held(&session, "kiro"), vec!["goal a then b"], "an end retires nothing");
        // The second echo CONTAINS the first command's text: only its own row
        // can be taken, one command row per prompt.
        assert!(record_prompt(&session, "kiro", "goal a then b"), "the second echo");
        assert!(held(&session, "kiro").is_empty());
        let prompts: Vec<(String, Vec<String>)> = recent_events(&session, 0)
            .into_iter()
            .filter(|e| e.kind == "prompt" && e.via == "app")
            .map(|e| (e.text.clone(), e.deliveries.iter().map(|d| d.msg.clone()).collect()))
            .collect();
        assert_eq!(
            prompts,
            vec![("goal a".into(), vec!["m-a".to_string()]), ("goal a then b".into(), vec!["m-b".to_string()])],
            "each echo names exactly its own bubble"
        );
    }

    /// A command's echo is the whole prompt: one that merely CONTAINS it is
    /// not its receipt (orchestrator, #264) — and, being nothing of ours,
    /// proves that command echoed nothing, so its row goes.
    #[test]
    fn a_command_echo_must_equal_the_prompt() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-eq-{}", uuid::Uuid::new_v4());
        record_command_delivery(&session, "kiro", "goal a", "m-a").unwrap();
        // Orchestrator 11:43: a local prompt that quotes it, with no chat line
        // owed, settles nothing; the command waits behind that turn…
        assert!(!record_prompt(&session, "kiro", "please do goal a"), "containment is not equality");
        let last = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!(last.via, "local", "the typed prompt renders as itself");
        assert!(last.deliveries.is_empty(), "no bubble is checked");
        assert_eq!(held(&session, "kiro"), vec!["goal a"], "still owed");
        // …and its real echo, after that turn, settles it: no INPUT row.
        record_notification(&session, "kiro", "completed", now());
        assert!(record_prompt(&session, "kiro", "goal a"));
        let last = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!((last.via.as_str(), last.deliveries.iter().map(|d| d.msg.as_str()).collect::<Vec<_>>()), ("app", vec!["m-a"]));
        assert!(held(&session, "kiro").is_empty());
        // Whitespace is forgiven the same way as for chat lines. (That prompt
        // opened a turn; end it, so the next command is typed at an idle pane.)
        record_notification(&session, "kiro", "completed", now());
        record_command_delivery(&session, "kiro", "goal do x", "m-x").unwrap();
        assert!(record_prompt(&session, "kiro", "goal  do\nx"));
    }

    /// A prompt that was one of OUR chat lines (a held batch released at the
    /// turn's end) is not the command's echo and must not drop it.
    #[test]
    fn a_chat_echo_leaves_the_command_row_owed() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-chat-{}", uuid::Uuid::new_v4());
        record_command_delivery(&session, "kiro", "goal a", "m-a").unwrap();
        record_delivery(&session, "kiro", "[tmm chat] lead: @kiro hi", "m-chat");
        assert!(record_prompt(&session, "kiro", "[tmm chat] lead: @kiro hi"));
        assert_eq!(held(&session, "kiro"), vec!["goal a"], "the command is still owed");
        // Validator on #264: a chat line that CONTAINS the command's echo is
        // that line's receipt only — the command has not run yet.
        record_delivery(&session, "kiro", "[tmm chat] lead: @kiro please do goal a", "m-chat2");
        assert!(record_prompt(&session, "kiro", "[tmm chat] lead: @kiro please do goal a"));
        let last = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!(last.deliveries.iter().map(|d| d.msg.as_str()).collect::<Vec<_>>(), vec!["m-chat2"], "only the chat bubble is checked");
        assert_eq!(held(&session, "kiro"), vec!["goal a"], "the command is still owed");
        // Then the command's own echo settles it, not as INPUT.
        assert!(record_prompt(&session, "kiro", "goal a"));
        let last = recent_events(&session, 0).into_iter().last().unwrap();
        assert_eq!((last.via.as_str(), last.deliveries.iter().map(|d| d.msg.as_str()).collect::<Vec<_>>()), ("app", vec!["m-a"]));
        assert!(held(&session, "kiro").is_empty());
    }

    /// A chat line keeps today's rules beside a command row: the sweep still
    /// reports it, and never the command.
    #[test]
    fn command_rows_leave_chat_lines_alone() {
        crate::projects::tests::use_test_store();
        let session = format!("cmd-mixed-{}", uuid::Uuid::new_v4());
        record_delivery(&session, "kiro", "[tmm chat] human: @kiro hello", "m-chat");
        // An end older than the ack window, so the chat line is overdue; the
        // command is typed after it, so that end does not concern it.
        record_notification(&session, "kiro", "completed", now() - DELIVERY_ACK_SECS - 5);
        record_command_delivery(&session, "kiro", "goal x", "m-cmd").unwrap();
        assert_eq!(held(&session, "kiro"), vec!["[tmm chat] human: @kiro hello", "goal x"]);
        backdate(&session);
        sweep_deliveries(&session);
        assert_eq!(recent_events(&session, 0).iter().filter(|e| e.kind == "warn").count(), 1, "the chat line is still swept");
    }
}
