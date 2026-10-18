use crate::{config, tmux};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const MAX_INBOX_BYTES: u64 = 256 * 1024;
/// Chat-path budget for hook-sourced auto-replies: a final reply carries full
/// content.
const MAX_REPLY_CHARS: usize = 6 * 1024;
/// How much of a tool's argument is kept. It was 80 characters, which is shorter
/// than the paths this app's own agents work with: every row in the lane ended in
/// `…` after a third of a line, with the rest of a wide screen blank next to it —
/// and the argument is the half of a tool call worth reading (owner, 2026-08-20:
/// "工具调用的参数没有显示全，后边被压缩成 ... 了，屏幕的宽度没有有效利用"). 2 KB
/// covers every real path and command; beyond that it is a script, and its first
/// two thousand characters identify it. The lane pans, so length costs no layout,
/// and the durable log is capped by ROW COUNT, so it costs no unbounded storage.
const MAX_TOOL_DETAIL_CHARS: usize = 2048;
const OWNER_MARKER: &str = "tmux-mobile-agent-notify";

// ── Room poster ──────────────────────────────────────────────────────────────

/// Minimal posting interface injected into the hook consumer so final replies
/// can be recorded and delivered without naming the hub's message store.
pub trait RoomPoster: Send + Sync {
    /// Record `body` in the room, then deliver it once to each reply target.
    /// `[reply]` deliveries create no reverse edge, preventing ping-pong.
    /// `Err` = the room row was not written (board #404 round 6): a numbered
    /// consumer retries the post; everyone else logs it.
    fn post_final(&self, session: &str, agent: &str, body: &str, reply_to: &[String]) -> Result<(), String>;
}

#[derive(Debug, Deserialize)]
struct InboxEnvelope {
    backend: String,
    pane_id: String,
    payload: Value,
}

#[derive(Default)]
struct State {
    /// window key → the agent's own conversation id, from the last hook that
    /// carried one. In memory only: the durable copy is the project slot that
    /// the capturer stamps with it (`src-tauri/src/projects`), because that is
    /// what has to survive the reboot which loses tmux in the first place.
    sessions: HashMap<String, String>,
    /// window key → senders of every addressed request the current turn
    /// carries, in arrival order (#256: a later input JOINS the edge, it
    /// never replaces it). Parsed from the stamped input at
    /// `userPromptSubmit`; `[reply]` and legacy `[done]` envelopes
    /// deliberately create no reverse edge. Stamped with the turn EPOCH it
    /// was built in (`telemetry::turn_epoch`, the window's last end fact):
    /// a memo from an earlier epoch belongs to a turn that has ended.
    reply_targets: HashMap<String, (u64, Vec<String>)>,
    /// window key → the highest `tmm_seq` ACCEPTED (board #404 P1-C), a
    /// cache of the durable mark (`telemetry::hook_mark`) that never runs
    /// ahead of it. A producer that numbers its envelopes (dsh's plugin and
    /// shell) can have one published late — a notifier that outlived its
    /// run, a helper past its bound; anything not above this mark belongs to
    /// a turn already ended and is dropped instead of reopening it.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    seq_marks: HashMap<String, u64>,
    /// Inbox files whose fact and effects all succeeded but whose durable
    /// mark could not be written (review round 5 P1-A): kept, and retried
    /// for the mark ALONE — a known failure never repeats a visible effect.
    /// In memory: a restart re-reads such a file whole, like a crash.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    effects_done: std::collections::HashSet<PathBuf>,
    /// Inbox files whose end fact is written but whose room post failed
    /// (board #404 round 6): kept, and the next pass retries the end's TAIL
    /// alone — the post, then the flush — never the end fact again. In
    /// memory: a restart re-reads such a file whole, like a crash.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    owed: HashMap<PathBuf, Box<EndTail>>,
    /// Injected by the server after the team bus is ready. `None` on mobile.
    /// Box'd pointer stored here so it shares the Mutex with the rest of state.
    poster: Option<Arc<dyn RoomPoster>>,
}

#[derive(Clone)]
pub struct AgentNotificationHub {
    root: PathBuf,
    state: Arc<Mutex<State>>,
}

impl AgentNotificationHub {
    pub fn load() -> Self {
        Self::load_at(config::config_dir().join("agent-notifications"))
    }

    fn load_at(root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(root.join("inbox"));
        // The unread-inbox UI retired 2026-09-01; nothing reads unread.json
        // any more, so a file left by an older build would sit on disk for
        // ever carrying stale reply summaries. Best-effort: a failure to
        // remove is not a failure to start.
        let _ = std::fs::remove_file(root.join("unread.json"));
        Self { root, state: Arc::new(Mutex::new(State::default())) }
    }

    /// Inject the room poster. Called once by the server after the team bus is
    /// ready. Desktop-only; mobile leaves this as `None`.
    pub fn set_room_poster(&self, poster: Arc<dyn RoomPoster>) {
        self.state.lock().unwrap().poster = Some(poster);
    }

    /// Record who should receive this turn's final reply. Human requests need
    /// no pane delivery; the Hub already shows the room.
    ///
    /// Called BEFORE the prompt is recorded, so the turn log answers whether
    /// this input opens a turn or joins an open one (codex steer, an input
    /// typed mid-turn). Joining ADDS its senders (#256): the edge used to be
    /// replaced by the newest input, so a `[reply]` landing mid-turn erased
    /// the real requester — 27 of 404 turns on 2026-09-27, among them the
    /// #248 SHIP orchestrator had asked for, which then reached nobody for
    /// 3h27m (temp/stall-analysis.md).
    ///
    /// Two questions, two sources (orchestrator, #256 review 03:07/03:14).
    /// Whether this input JOINS the previous edge has one answer:
    /// `telemetry::turn_busy` — `derive_from` running or waiting, the status
    /// rule — and nothing else. WHO the edge holds is the senders of the
    /// prompts since the last end edge. The in-memory edge memoises that fold
    /// (parsed from the FULL prompt; the log keeps a 1024-char copy) and is
    /// stamped with the turn epoch (`telemetry::turn_epoch`, the last end
    /// fact of the same record): a memo from an earlier epoch belongs to a
    /// turn that ended — e.g. one an interrupt closed, which takes no edge —
    /// so it is dropped and the members are re-folded from the log (a
    /// tool-only turn has none yet).
    fn start_turn(&self, session: &str, window: &str, prompt: &str) {
        let open = turn_is_open(session, window);
        let epoch = turn_epoch(session, window);
        let mut targets = if open { self.current_members(session, window, epoch) } else { Vec::new() };
        join_targets(&mut targets, reply_targets(prompt));
        self.state.lock().unwrap().reply_targets.insert(window_key(session, window), (epoch, targets));
    }

    /// A turn ENDED without a stop hook (an interrupt, #256 orchestrator
    /// 03:50): its reply edge is dropped at the end edge itself, in the same
    /// place the end is recorded. The epoch stamp stays as the second line of
    /// defence for an end this call does not see (a persisted end replayed
    /// after a restart).
    pub fn end_turn(&self, session: &str, window: &str) {
        self.state.lock().unwrap().reply_targets.remove(&window_key(session, window));
    }

    /// Test-only: a hub in a scratch directory whose current turn on `window`
    /// was opened by `prompt` (the call-site test in hub_rpc).
    #[cfg(test)]
    pub(crate) fn scratch_with_turn(session: &str, window: &str, prompt: &str) -> (Self, PathBuf) {
        let root = std::env::temp_dir().join(format!("tmm-scratch-hub-{}", uuid::Uuid::new_v4()));
        let hub = Self::load_at(root.clone());
        hub.start_turn(session, window, prompt);
        (hub, root)
    }

    #[cfg(test)]
    pub(crate) fn holds_edge(&self, session: &str, window: &str) -> bool {
        self.state.lock().unwrap().reply_targets.contains_key(&window_key(session, window))
    }

    /// The reply edge's targets at the turn's end — never the agent itself
    /// (board #275): a self-wake's prompt names the agent as its own sender,
    /// and replying to it would type the answer back into the same pane, a
    /// loop. True in general, not a wake special case.
    fn take_reply_targets(&self, session: &str, window: &str) -> Vec<String> {
        let epoch = turn_epoch(session, window);
        let mut targets = self.current_members(session, window, epoch);
        targets.retain(|t| t != window);
        targets
    }

    /// The open turn's members: the memo when it was built in THIS epoch,
    /// else the fold of the prompts since the last end (a restart lost the
    /// memo, or the memo's turn ended). Consumes the memo.
    fn current_members(&self, session: &str, window: &str, epoch: u64) -> Vec<String> {
        match self.state.lock().unwrap().reply_targets.remove(&window_key(session, window)) {
            Some((built, targets)) if built == epoch => targets,
            _ => recovered_targets(session, window),
        }
    }

    /// The agent conversation id last reported by a hook in this tmux window,
    /// if any. Used by the project capturer to stamp the slot, so `up` can
    /// resume that conversation rather than open a fresh one.
    pub fn agent_session_for(&self, session: &str, window: &str) -> Option<String> {
        self.state
            .lock()
            .ok()?
            .sessions
            .get(&window_key(session, window))
            .cloned()
    }

    pub async fn run(self: Arc<Self>) {
        loop {
            // consume_inbox is synchronous end to end: directory scan, file
            // reads, tmux subprocesses, bus posts. On the runtime it would
            // stall every RPC sharing that worker for the duration.
            let hub = self.clone();
            let _ = tokio::task::spawn_blocking(move || hub.consume_inbox()).await;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    fn consume_inbox(&self) {
        // Producers (panes) with an envelope not yet accepted in this pass:
        // their later envelopes wait behind it (review round 5 P1-B).
        let mut blocked = std::collections::HashSet::new();
        for path in inbox_files(&self.root.join("inbox")) {
            match self.consume_file(&path, &mut blocked) {
                Ok(()) => {}
                // A numbered envelope that is not yet ACCEPTED stays in the
                // inbox and is consumed again at the next pass (board #404).
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                Err(Consume::Retain(why)) => {
                    retain_note(&path, &why);
                    continue;
                }
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                Err(Consume::Defer) => continue,
                // Only a numbered consumption owes a tail, and it keeps it
                // (`consume_numbered`); never reached, kept all the same.
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                Err(Consume::Owed(_, why)) => {
                    retain_note(&path, &why);
                    continue;
                }
                Err(Consume::Drop(error)) => eprintln!(
                    "⚠️  agent notification ignored ({}): {}",
                    path.display(),
                    error
                ),
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let mut state = self.state.lock().unwrap();
                state.effects_done.remove(&path);
                state.owed.remove(&path);
            }
            let _ = std::fs::remove_file(path);
        }
    }

    fn consume_file(&self, path: &Path, blocked: &mut std::collections::HashSet<String>) -> Result<(), Consume> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if metadata.len() > MAX_INBOX_BYTES {
            return Err("payload too large".into());
        }
        let envelope: InboxEnvelope =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("invalid envelope: {e}"))?;
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let Some(seq) = envelope.payload.get("tmm_seq").and_then(Value::as_u64) {
            let pane = envelope.pane_id.clone();
            if blocked.contains(&pane) {
                return Err(Consume::Defer);
            }
            let out = self.consume_numbered(path, envelope, seq);
            if matches!(out, Err(Consume::Retain(_))) {
                blocked.insert(pane);
            }
            return out;
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let _ = blocked;
        self.consume_envelope(envelope)
    }

    /// A numbered envelope (board #404: dsh's plugin and shell) is ACCEPTED,
    /// and leaves the inbox, only once its turn fact, its effects and its
    /// durable mark have all succeeded (orchestrator, round 5). Anything
    /// short of that keeps it (`Retain`), and the producer's later envelopes
    /// wait behind it (`consume_inbox`), so the fence never passes it:
    /// * the mark cannot be read (or holds no number) → nothing guessed;
    /// * a turn fact of its window did not reach the log → stopped BEFORE
    ///   the room post, the flush and the mark (`consume_envelope`), so a
    ///   retry repeats no visible effect;
    /// * the mark cannot be written → its effects are done
    ///   (`effects_done`): the retry writes the mark alone.
    /// Only a crash re-reads a file whose effects ran — the at-least-once
    /// window every backend has (agent-notifications.md).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn consume_numbered(&self, path: &Path, envelope: InboxEnvelope, seq: u64) -> Result<(), Consume> {
        let (session, window, _) = tmux::resolve_pane_id(&envelope.pane_id).map_err(Consume::Drop)?;
        let key = window_key(&session, &window);
        let cached = self.state.lock().unwrap().seq_marks.get(&key).copied();
        let mark = match cached {
            Some(m) => m,
            None => {
                let m = crate::projects::telemetry::hook_mark(&session, &window).map_err(|e| Consume::Retain(format!("its window's mark cannot be read ({e})")))?;
                self.state.lock().unwrap().seq_marks.insert(key.clone(), m);
                m
            }
        };
        if seq <= mark {
            eprintln!("agent notification dropped: {} came after the edge it precedes (tmm_seq {seq} <= {mark})", path.display());
            return Ok(());
        }
        if !self.state.lock().unwrap().effects_done.contains(path) {
            // A turn fact that does not reach the log stops consume_envelope
            // itself, before any visible effect (`numbered_write_failed`); a
            // room post that fails leaves the end's tail owed, retried alone.
            let owed = self.state.lock().unwrap().owed.remove(path);
            let done = crate::projects::telemetry::with_numbered(Some((&session, &window)), || match owed {
                Some(tail) => self.finish_end(*tail),
                None => self.consume_envelope(envelope),
            });
            if let Err(Consume::Owed(tail, why)) = done {
                self.state.lock().unwrap().owed.insert(path.to_path_buf(), tail);
                return Err(Consume::Retain(format!("its reply could not be posted ({why})")));
            }
            done?;
            self.state.lock().unwrap().effects_done.insert(path.to_path_buf());
            #[cfg(test)]
            if crash_at("before_mark") {
                return Err(Consume::Retain("test: the gateway died before the mark".into()));
            }
        }
        crate::projects::telemetry::set_hook_mark(&session, &window, seq).map_err(|e| Consume::Retain(format!("its mark could not be written ({e})")))?;
        let mut state = self.state.lock().unwrap();
        state.effects_done.remove(path);
        state.seq_marks.insert(key, seq);
        Ok(())
    }

    fn consume_envelope(&self, envelope: InboxEnvelope) -> Result<(), Consume> {
        // A SUB-AGENT thread's event is the agent's own work, like a tool call
        // (board #169; codex 0.153.4 runs spawn_agent children in-process and
        // the managed hooks fire for every thread — see backends/codex.rs for
        // the measured payloads). Classified here, at the door: the child's
        // brief becomes a `Subagent` step in the tool lane; nothing from a
        // child ever opens or closes the WINDOW's turn, becomes its prompt,
        // auto-posts, or writes its conversation id. Read as keyboard input,
        // the brief rendered as an INPUT row nobody typed and — worse —
        // start_turn replaced the reply edge with nobody, so codex's real
        // final reply reached no one (owner 2026-09-11 03:46; `tmm log` held
        // not one codex `[reply]` line).
        if let Some((backend, _child)) = crate::backends::Backend::parse(&envelope.backend)
            .and_then(|b| b.subagent_thread(&envelope.payload).map(|c| (b, c)))
        {
            // A child's ASK is the exception (board #170, measured on 0.153.4):
            // codex surfaces the child's approval modal in the PARENT's TUI
            // ("Would you like to run the following command? Thread: Agent
            // (…)") and blocks the pane until the human answers — so it is
            // this window's ask, and it falls through to the normal path
            // that derives `permission_required`. Everything else a child
            // sends is classified here.
            let child_ask = envelope
                .payload
                .as_object()
                .and_then(|p| backend.normalize_kind(p).ok())
                .is_some_and(|k| k == "permission_required");
            if tool_event_parts(&envelope).is_none() && !child_ask {
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                if is_user_prompt_submit(&envelope) {
                    if let Some(brief) = prompt_text(&envelope.payload) {
                        if !brief.trim().is_empty() {
                            let (session, window, _) = tmux::resolve_pane_id(&envelope.pane_id)?;
                            crate::projects::telemetry::record_tool(
                                &session,
                                &window,
                                "Subagent",
                                &truncate(&brief, MAX_TOOL_DETAIL_CHARS),
                            );
                        }
                    }
                }
                // SubagentStart/SubagentStop and any other child lifecycle
                // event: not a turn edge of this window — dropped.
                return Ok(());
            }
            // A child's own tool calls fall through to the tool lane below.
        }
        // Tool events (pre/postToolUse from isolated-home agents, Phase B+)
        // are TELEMETRY, not notifications: record the live activity line and
        // stop — no unread dot, no dedupe, no persistence.
        if let Some((tool, detail)) = tool_event_parts(&envelope) {
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                let (session, window, _) = tmux::resolve_pane_id(&envelope.pane_id)?;
                // The CLI's own housekeeping (kiro v3's post-turn `memory`
                // auto-capture, board #227) counts as work only inside an
                // open turn; after the Stop it is dropped, or the finished
                // agent reads "working" until its next message.
                let housekeeping = crate::backends::Backend::parse(&envelope.backend)
                    .is_some_and(|b| b.is_housekeeping_tool(&envelope.payload));
                if housekeeping {
                    if !crate::projects::telemetry::record_housekeeping_tool(&session, &window, &tool, &detail) {
                        return Ok(());
                    }
                } else {
                    crate::projects::telemetry::record_tool(&session, &window, &tool, &detail);
                }
                // The pane just painted a tool row — the freshest moment to
                // read its status furniture. Throttled + async inside.
                crate::projects::vitals::sniff_window_soon(&session, &window);
            }
            return Ok(());
        }
        // userPromptSubmit marks the start of a turn. Its stamped envelope
        // identifies who should receive the final reply; the prompt itself is
        // also the input half of the transcript and the delivery receipt.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if is_user_prompt_submit(&envelope) {
            let (session, window, _) = tmux::resolve_pane_id(&envelope.pane_id)?;
            if let Some(prompt) = prompt_text(&envelope.payload) {
                if !prompt.trim().is_empty() {
                    self.start_turn(&session, &window, &prompt);
                    crate::projects::telemetry::record_prompt(&session, &window, &prompt);
                    // A numbered producer's prompt that did not reach the log
                    // stops here: not accepted, retried (round 5 P1-C).
                    if crate::projects::telemetry::numbered_write_failed() {
                        return Err(Consume::Retain("its prompt did not reach the log".into()));
                    }
                    // A prompt settled: for a CLI that loses typed text (dsh,
                    // board #410), its run is up, and a steer-mode reader may
                    // now claim the pane — lines held through the cold start
                    // (or behind the previous steer's echo) are typed now,
                    // by the one readiness predicate, outside the turn-fact
                    // lock. In queue mode the shell is not ready: nothing.
                    if crate::backends::Backend::parse(&envelope.backend).is_some_and(|b| b.loses_busy_input()) {
                        crate::projects::delivery::flush(&session, &window);
                    }
                }
            }
            // A turn just opened: sniff while the pane is fresh.
            crate::projects::vitals::sniff_window_soon(&session, &window);
            return Ok(());
        }
        // Claude's `idle_prompt` is a NUDGE, not an ask (board #75, measured
        // 2026-09-02: every one of the 7 `input_required` rows in state.db sat
        // exactly 60 s after that window's `completed`, nothing in between —
        // it is Claude Code's "you have been idle for a minute" reminder,
        // fired AFTER the turn ended). Read as an ask it flipped every
        // finished Claude agent from `idle` to amber `waiting for you` a
        // minute later and left a "waiting for input" row in the feed. It is
        // dropped here — silently, not as an error, so already-spawned agents
        // whose hooks still match it do not spam the log — and the matchers
        // no longer subscribe to it. `agent_needs_input` stays a real ask.
        if is_idle_nudge(&envelope) {
            return Ok(());
        }
        let (session, window, pane) = tmux::resolve_pane_id(&envelope.pane_id)?;
        // The agent's managed home, by NAME (pane → window → `managed_home`),
        // for a backend whose reply lives in its own session store: never
        // searched for by workspace, so two agents of one backend in one
        // project cannot read each other's turn (board #224).
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let home = crate::projects::managed_home(&session, &window);
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let home: Option<PathBuf> = None;
        let normalized = normalize_in(&envelope, home.as_deref())?;
        // Resolve the reply edge BEFORE recording this stop. On a server
        // restart the in-memory edge is gone, so the durable activity log
        // recovers the prompt newer than the previous turn end.
        let reply_to = if normalized.kind == "completed" {
            self.take_reply_targets(&session, &window)
        } else {
            Vec::new()
        };
        // Feed the telemetry channel BEFORE dedupe: dedupe is a notification-UI
        // concern; status derivation wants every observed fact.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            // How a completion ended (board #355: its whole reply was the CLI's
            // placeholder, real text, or nothing usable) is written WITH the
            // end, in one step: a separate "and it was empty" write could land
            // on a different end.
            crate::projects::telemetry::record_notification_with(&session, &window, &normalized.kind, normalized.quality);
            // A turn edge (stop, ask) means the CLI just repainted its footer —
            // the context-usage number is at its freshest right here.
            crate::projects::vitals::sniff_window_soon(&session, &window);
        }

        // A numbered producer's end fact that did not reach the log stops
        // BEFORE the room post and the flush (round 5 P1-C): retrying a known
        // failure repeats no visible effect; only a crash may.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if crate::projects::telemetry::numbered_write_failed() {
            return Err(Consume::Retain("its end fact did not reach the log".into()));
        }
        #[cfg(test)]
        if crash_at("after_end") {
            return Err(Consume::Retain("test: the gateway died between the end row and the reply".into()));
        }

        // A completion that said nothing may leave the agent in the middle of its
        // work; `stalls` answers it once (see there).
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if normalized.kind == "completed" && normalized.quality == crate::backends::EndQuality::Empty {
            crate::projects::stalls::on_empty_end(&session, &window);
        }

        let _ = pane;
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        let post = if normalized.kind == "completed" { self.auto_post_body(&session, &window, &normalized) } else { None };
        #[cfg(any(target_os = "android", target_os = "ios"))]
        let post = None;
        self.finish_end(EndTail {
            session,
            window,
            post,
            reply_to,
            flush: matches!(normalized.kind.as_str(), "completed" | "failed"),
            agent_session_id: normalized.agent_session_id,
        })
    }

    /// What an end does after its fact is written, in order, as ONE step a
    /// numbered consumer can retry alone (board #404 round 6):
    /// * Stop hook final: record the answer in the room and deliver it to
    ///   every sender whose addressed request this turn carried (`[reply]`
    ///   inputs create no reverse edge, so delivery is one hop). A room row
    ///   that was not written is a failed effect for a numbered producer:
    ///   `Consume::Owed`, nothing after it runs, and the next pass retries
    ///   from here. Anyone else logs it and goes on, as before.
    /// * the turn's end edge is the first flush trigger (board #257): lines
    ///   held for this busy queue-mode agent are typed now, as one prompt.
    /// * the agent's own conversation id is remembered (even across
    ///   duplicate events): this map is how a restored window resumes the
    ///   exact conversation instead of starting a blank one.
    fn finish_end(&self, tail: EndTail) -> Result<(), Consume> {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if let Some(body) = &tail.post {
            let poster = self.state.lock().unwrap().poster.clone();
            if let Some(p) = poster {
                if let Err(e) = p.post_final(&tail.session, &tail.window, body, &tail.reply_to) {
                    if crate::projects::telemetry::numbered_active() {
                        return Err(Consume::Owed(Box::new(tail), e));
                    }
                    eprintln!("⚠  the final reply of {}:{} was not recorded in the room: {e}", tail.session, tail.window);
                }
            }
        }
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if tail.flush {
            crate::projects::delivery::flush(&tail.session, &tail.window);
        }
        let EndTail { session, window, agent_session_id, .. } = tail;
        if let Some(id) = agent_session_id {
            self.state.lock().unwrap().sessions.insert(window_key(&session, &window), id);
        }
        Ok(())
    }

    /// The body a managed agent's final reply is posted with, if any: only
    /// managed windows (constraint 3: a .tmm/agents/<name> dir must exist,
    /// so direct or adopted agents never auto-post) and a reply worth
    /// posting, truncated at the chat-path budget.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn auto_post_body(&self, session: &str, window: &str, normalized: &Normalized) -> Option<String> {
        // Nothing to post — skip.
        let reply = normalized.full_reply.as_deref().unwrap_or_default();
        if reply.is_empty() {
            return None;
        }
        // Constraint 3: managed-only gate. `projects::managed_home` is the ONE
        // definition of "an agent this app created" — shared with hub_agents'
        // participant list and with delivery, so the three cannot drift apart.
        // The resolved window IS the name now (board #120), so the old
        // index → list_panes → name round-trip (which lost the post when a
        // rename landed between hook fire and consume) is gone.
        crate::projects::managed_home(session, window)?;
        Some(truncate(reply, MAX_REPLY_CHARS))
    }

    pub fn helper_command(&self, backend: &str) -> String {
        format!(
            "/bin/sh {} {} # {}",
            crate::shell::quote_always(&self.helper_path().to_string_lossy()),
            backend,
            OWNER_MARKER
        )
    }

    pub fn ensure_helper(&self) -> Result<(), String> {
        self.write_helper()
    }

    fn helper_path(&self) -> PathBuf {
        self.root.join(OWNER_MARKER)
    }

    fn write_helper(&self) -> Result<(), String> {
        std::fs::create_dir_all(self.root.join("inbox")).map_err(|e| e.to_string())?;
        let inbox = crate::shell::quote_always(&self.root.join("inbox").to_string_lossy());
        // The helper accepts exactly the spawnable backends — derived from the
        // enum, not spelled here: a hand list silently dropped every event of
        // a new backend (kimi, 2026-09-20 — the literal guard cannot see a
        // name inside a shell `case` pattern).
        let backends = crate::backends::Backend::NAMES.join("|");
        let script = format!(
            r#"#!/bin/sh
umask 077
exec 2>/dev/null
# A producer that numbers its envelopes (board #404: TMM_HOOK_SEQ, digits)
# gets a RECEIPT: exit 0 only once the envelope is in the inbox, 1 if it is
# not, so it can keep and resend it. Every other caller keeps the fail-soft
# contract: always 0, a hook never fails its CLI.
case "${{TMM_HOOK_SEQ:-}}" in ''|*[!0-9]*) fail=0 ;; *) fail=1 ;; esac
backend="${{1:-}}"
case "$backend" in {backends}) ;; *) exit $fail ;; esac
pane="${{TMUX_PANE:-}}"
case "$pane" in %*[!0-9]*|%|"") exit $fail ;; esac
inbox={inbox}
mkdir -p "$inbox" || exit $fail
tmp=$(mktemp "$inbox/.tmp.XXXXXX") || exit $fail
trap 'rm -f "$tmp"' EXIT
payload=
IFS= read -r payload || true
[ -n "$payload" ] || exit $fail
printf '{{"backend":"%s","pane_id":"%s","payload":%s}}\n' "$backend" "$pane" "$payload" > "$tmp" || exit $fail
# The number also rides the file name, zero-padded, so two envelopes of one
# pane written in the same second are consumed in the order they were made.
# Without one the name keeps its old `<secs>-<pid>` shape.
case "${{TMM_HOOK_SEQ:-}}" in
  ''|*[!0-9]*) name="$(date +%s)-$$" ;;
  *) name="$(date +%s)-$(printf '%020d' "$TMM_HOOK_SEQ")-$$" ;;
esac
mv "$tmp" "$inbox/$name.json" || exit $fail
trap - EXIT
exit 0
"#
        );
        std::fs::write(self.helper_path(), script).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(self.helper_path(), std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

/// Why an inbox file was not consumed: `Drop` = it never will be (invalid,
/// unknown pane) and the file goes; `Retain` = a numbered envelope not yet
/// accepted (its mark unreadable or unwritten, a fact not persisted) — the
/// file stays, is retried at the next pass, and its producer's later
/// envelopes wait behind it (board #404).
enum Consume {
    Drop(String),
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Retain(String),
    /// Kept, silently: an earlier envelope of the same producer is not yet
    /// accepted, and this one waits behind it (round 5 P1-B).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Defer,
    /// A numbered end whose room post failed: its tail is owed and retried
    /// alone (round 6); turned into `Retain` by `consume_numbered`.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    Owed(Box<EndTail>, String),
}

/// The part of an end that runs after its fact (`finish_end`). Mobile
/// builds post and flush nothing.
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
struct EndTail {
    session: String,
    window: String,
    post: Option<String>,
    reply_to: Vec<String>,
    flush: bool,
    agent_session_id: Option<String>,
}

impl From<String> for Consume {
    fn from(e: String) -> Self {
        Consume::Drop(e)
    }
}

impl From<&str> for Consume {
    fn from(e: &str) -> Self {
        Consume::Drop(e.to_string())
    }
}


/// Say once per file that it is being kept for a retry, not at every poll.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn retain_note(path: &Path, why: &str) {
    static SEEN: std::sync::OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = std::sync::OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let mut seen = seen.lock().unwrap();
    if seen.len() > 1024 {
        seen.clear();
    }
    if seen.insert(path.to_path_buf()) {
        eprintln!("⚠  agent notification kept for a retry ({}): {why}", path.display());
    }
}

#[cfg(test)]
thread_local! {
    /// Test seam: the named point at which consumption "crashes" once.
    static CRASH: std::cell::RefCell<Option<&'static str>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn crash_at(point: &str) -> bool {
    CRASH.with(|c| {
        let hit = c.borrow().is_some_and(|p| p == point);
        if hit {
            *c.borrow_mut() = None;
        }
        hit
    })
}

/// Bridge to the project capturer, which asks by (session, window) because that
/// is the granularity of a project slot. Implemented here so `projects` never
/// names the notification types — it only knows its own trait.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl crate::projects::capture::AgentSessions for AgentNotificationHub {
    fn agent_session_for(&self, session: &str, window: &str) -> Option<String> {
        AgentNotificationHub::agent_session_for(self, session, window)
    }
}

/// Inbox files in the order the hooks WROTE them.
///
/// `read_dir` yields filesystem order, which is arbitrary. That mattered: every
/// event is timestamped when it is CONSUMED, so consuming a turn's `stop` before
/// its tool calls stamped the agent's reply earlier than the work that produced
/// it, and the chat rendered the tool calls after the answer (owner report,
/// 2026-08-16). The helper names files `<epoch_secs>-<pid>.json`, so the leading
/// number is the ordering key, with the whole name as the tie-break.
fn inbox_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    files.sort_by_key(|p| inbox_order(p));
    files
}

/// The consume order of one inbox file (board #404): the second it was
/// published, then the producer's own sequence (`<secs>-<seq>-<pid>`; an
/// envelope without one — every other backend, and any written by an older
/// helper — counts as 0), then the name, exactly as before. One rule for a
/// directory that mixes both shapes; a backend that names no sequence keeps
/// today's order (`inbox_is_consumed_in_the_order_the_hooks_wrote_it`).
fn inbox_order(path: &Path) -> (u64, u64, String) {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let stem = name.strip_suffix(".json").unwrap_or(&name);
    let parts: Vec<&str> = stem.split('-').collect();
    let secs = parts.first().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let seq = if parts.len() == 3 { parts[1].parse::<u64>().unwrap_or(0) } else { 0 };
    (secs, seq, name)
}

/// PreToolUse/PostToolUse across backends → `(tool name, detail)`
/// (`("Edit", "src/lib.rs")`), or None when this is a lifecycle notification.
/// The two parts stay SEPARATE all the way to the client: the tool name is the
/// scannable part of a step row, so it is rendered differently from its
/// argument, and joining them here would force the client to re-split a string
/// on a space that a Windows path or a shell command can contain.
fn tool_event_parts(envelope: &InboxEnvelope) -> Option<(String, String)> {
    let payload = envelope.payload.as_object()?;
    // kiro/claude/codex spell the key snake_case; grok camelCase with
    // snake_case VALUES ("pre_tool_use") — measured on grok 1.0.5.
    let event = payload
        .get("hook_event_name")
        .or_else(|| payload.get("hookEventName"))
        .and_then(Value::as_str)?;
    if !matches!(
        event,
        "PreToolUse" | "PostToolUse" | "preToolUse" | "postToolUse" | "pre_tool_use" | "post_tool_use"
    ) {
        return None;
    }
    let tool = payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .or_else(|| payload.get("tool"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    // Best-effort one-arg detail: the file for edits, the command for shells.
    let detail = payload
        .get("tool_input")
        .or_else(|| payload.get("toolInput"))
        .and_then(Value::as_object)
        .and_then(|i| {
            i.get("file_path")
                .or_else(|| i.get("path"))
                .or_else(|| i.get("command"))
                .and_then(Value::as_str)
        })
        .unwrap_or("");
    Some((tool.to_string(), truncate(detail, MAX_TOOL_DETAIL_CHARS)))
}

struct Normalized {
    kind: String,
    agent_session_id: Option<String>,
    /// The full reply text from a stop event, before any truncation. `None`
    /// for non-stop events. Used by the auto-post path, which applies the
    /// larger `MAX_REPLY_CHARS` budget instead of the notification summary cap.
    full_reply: Option<String>,
    /// How a completion ended (board #355): its whole reply was the CLI's own
    /// placeholder (`Empty`), real text (`Said`), or nothing usable (`Unknown`:
    /// no body, blank, session file unreadable). Read by the desktop consumer
    /// only; the phone never consumes the inbox.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    quality: crate::backends::EndQuality,
}

/// `normalize_in` without a managed home — the shape every test and the
/// mobile path use; a backend that needs its home gets no fallback reply.
#[cfg(test)]
fn normalize(envelope: &InboxEnvelope) -> Result<Normalized, String> {
    normalize_in(envelope, None)
}

fn normalize_in(envelope: &InboxEnvelope, home: Option<&Path>) -> Result<Normalized, String> {
    let payload = envelope
        .payload
        .as_object()
        .ok_or("payload must be an object")?;
    // The kind decision is the backend's own dialect — each arm lives on the
    // backend's file (board #129); an unknown backend is rejected at the door
    // exactly as the old inline match did.
    let backend = crate::backends::Backend::parse(&envelope.backend)
        .ok_or_else(|| String::from("unsupported backend"))?;
    let kind = backend.normalize_kind(payload)?;
    // The raw reply text for the auto-post path (truncated to MAX_REPLY_CHARS
    // at the call site). A completion without text asks the backend for its
    // other source (kiro --v3 reads the session file, board #207).
    let raw_reply = string_field(
        payload,
        &[
            "message",
            "last_assistant_message",
            "lastAssistantMessage",
            "assistant_response",
            "task_subject",
        ],
    );
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let raw_reply = if kind == "completed" && raw_reply.is_none() { backend.reply_fallback(payload, home) } else { raw_reply };
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let _ = home;
    // Preserve the untruncated text for the auto-post path only when this is
    // a stop/completion event — other events have no reply body worth posting.
    let full_reply = if kind == "completed" { raw_reply } else { None };
    let quality = if kind == "completed" {
        backend.reply_quality(full_reply.as_deref())
    } else {
        crate::backends::EndQuality::Unknown
    };
    Ok(Normalized {
        kind: kind.into(),
        agent_session_id: string_field(payload, &["session_id", "sessionId"]),
        full_reply,
        quality,
    })
}

/// Claude Code's idle reminder (`Notification` / `idle_prompt`): fires ~60 s
/// after a turn ended with nobody typing. Not an ask — see `consume_file`.
fn is_idle_nudge(envelope: &InboxEnvelope) -> bool {
    crate::backends::Backend::parse(&envelope.backend)
        .is_some_and(|b| b.is_idle_nudge(&envelope.payload))
}

/// Returns true when the envelope carries a `userPromptSubmit` event (kiro),
/// which marks the beginning of a new user turn. Used to reset the
/// `sent_this_turn` flag so the next stop can auto-post.
fn is_user_prompt_submit(envelope: &InboxEnvelope) -> bool {
    crate::backends::Backend::parse(&envelope.backend)
        .is_some_and(|b| b.is_user_prompt_submit(&envelope.payload))
}

/// The submitted prompt of a turn-start payload. Two shapes exist: a plain
/// string (kiro, claude, codex, grok, omp) and an array of content parts
/// (kimi 2.0.2: `[{type:"text",text}]`, the message shape its wire uses too).
/// Both are the same fact, so one reader; a payload with neither is `None`.
pub(crate) fn prompt_text(payload: &Value) -> Option<String> {
    let prompt = payload.get("prompt")?;
    match prompt {
        Value::String(s) => Some(s.clone()),
        Value::Array(_) => Some(content_text(prompt)).filter(|s| !s.is_empty()),
        _ => None,
    }
}

/// The text of a message `content`: a string as is, an array of parts as its
/// `text` parts joined by newlines (think/image parts contribute nothing).
pub(crate) fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str).is_none_or(|t| t == "text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn string_field(
    map: &serde_json::Map<String, Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter().find_map(|key| {
        map.get(*key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    })
}

/// Is this window's turn open (`telemetry::turn_busy`, the one turn rule)?
/// Mobile has no telemetry store: every input opens a fresh edge there.
fn turn_is_open(session: &str, window: &str) -> bool {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        crate::projects::telemetry::turn_busy(session, window)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (session, window);
        false
    }
}

/// The window's turn epoch (`telemetry::turn_epoch`); 0 on mobile.
fn turn_epoch(session: &str, window: &str) -> u64 {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        crate::projects::telemetry::turn_epoch(session, window)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (session, window);
        0
    }
}

/// The turn's recorded inputs since its last end (see
/// `telemetry::for_each_turn_input`). Desktop-gated like every
/// `crate::projects` reader: mobile has no telemetry store, so every input
/// opens a fresh edge and a missing edge is empty — the same fail-soft
/// answer a missing turn gives on desktop.
fn turn_inputs(session: &str, window: &str, limit: Option<usize>, visit: impl FnMut(&[String])) -> usize {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        crate::projects::telemetry::for_each_turn_input(session, window, limit, visit)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (session, window, limit, visit);
        0
    }
}

/// The reply edge rebuilt from the log: every addressed sender of every
/// input of the open turn, once, in order. Memory is the distinct senders,
/// never the turn's inputs.
fn recovered_targets(session: &str, window: &str) -> Vec<String> {
    let mut targets = Vec::new();
    turn_inputs(session, window, None, |senders| join_targets(&mut targets, senders.to_vec()));
    targets
}

/// The most distinct requesters one turn's reply edge holds. Memory is
/// bounded by PEOPLE, never by inputs (orchestrator, #256 review: cap the
/// deduplicated requesters, not the prompts). A turn keeps its EARLIEST
/// requesters when it hits the cap, so the one who opened it is never the
/// one dropped; a project has at most `SPAWN_CAP` agents, so real turns sit
/// far below it.
const MAX_REPLY_TARGETS: usize = 32;

fn join_targets(targets: &mut Vec<String>, more: Vec<String>) {
    for sender in more {
        if targets.len() >= MAX_REPLY_TARGETS {
            return;
        }
        if !targets.contains(&sender) {
            targets.push(sender);
        }
    }
}

/// Senders of stamped chat requests in a submitted prompt: the one parser,
/// `address::requesters`, shared with the activity log's stored column.
fn reply_targets(prompt: &str) -> Vec<String> {
    crate::address::requesters(prompt)
}

fn truncate(input: &str, max: usize) -> String {
    let mut out: String = input.chars().take(max).collect();
    if input.chars().count() > max {
        out.push('…');
    }
    out
}

fn window_key(session: &str, window: &str) -> String {
    format!("{session}:{window}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Board #275: an agent is never its own reply target. A self-wake's
    /// prompt names the agent as its sender; replying would type the answer
    /// back into the same pane, a loop. Control: the same prompt from a
    /// teammate still returns the reply to it.
    #[test]
    fn an_agent_is_never_its_own_reply_target() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-self-reply-{}", uuid::Uuid::new_v4());
        let own = "[tmm chat 2026-09-29 08:50] dev: [wake] @dev check the build";
        let (hub, root) = AgentNotificationHub::scratch_with_turn(&session, "dev", own);
        assert!(hub.take_reply_targets(&session, "dev").is_empty(), "no edge back into itself");
        let _ = std::fs::remove_dir_all(root);
        let mixed = format!("{own}\n\n[tmm chat 2026-09-29 08:51] lead: @dev and then this");
        let (hub, root) = AgentNotificationHub::scratch_with_turn(&session, "dev", &mixed);
        assert_eq!(hub.take_reply_targets(&session, "dev"), vec!["lead".to_string()], "a teammate in the same turn still gets it");
        let _ = std::fs::remove_dir_all(root);
    }

    /// Board #362 c, condition c: a turn end the hooks missed (recorded from
    /// the screen) closes the requester's reply edge and returns NOTHING to
    /// it: no reply is posted, and the edge of the next turn starts after it,
    /// so a later real end cannot deliver the stale request's answer twice.
    #[test]
    fn a_missed_end_closes_the_reply_edge_with_no_reply() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-missed-edge-{}", uuid::Uuid::new_v4());
        let ask = "[tmm chat 2026-10-15 12:32] maker: @critic G3 review";
        crate::projects::telemetry::record_prompt(&session, "critic", ask);
        let (hub, root) = AgentNotificationHub::scratch_with_turn(&session, "critic", ask);
        use crate::projects::telemetry as tm;
        assert_eq!(tm::record_missed_end(&session, "critic", "auth_expired", tm::Identity::Paint("auth_expired|x"), tm::turn_version(&session, "critic")), tm::Missed::Ended);
        assert!(hub.take_reply_targets(&session, "critic").is_empty(), "the edge closed at the missed end");
        let posted: Vec<_> = tm::recent_events(&session, 0).into_iter().filter(|e| e.kind == "msg" || e.text.contains("[reply]")).collect();
        assert!(posted.is_empty(), "nothing was returned as the agent's answer: {posted:?}");
        let _ = std::fs::remove_dir_all(root);
        // Review P1-A: a paint read BEFORE a newer request's prompt is stale.
        // That request's edge, and its turn, are not touched by it.
        let session = format!("tmm-missed-stale-{}", uuid::Uuid::new_v4());
        tm::record_prompt(&session, "critic", ask);
        let seen = tm::turn_version(&session, "critic");
        let next = "[tmm chat 2026-10-15 23:10] human: @critic mwinit done, carry on";
        tm::record_prompt(&session, "critic", next);
        let (hub, root) = AgentNotificationHub::scratch_with_turn(&session, "critic", next);
        assert_eq!(tm::record_missed_end(&session, "critic", "auth_expired", tm::Identity::Paint("auth_expired|x"), seen), tm::Missed::Stale);
        assert_eq!(tm::derive(&session, "critic", 0).state, "running", "the newer turn is still open");
        assert_eq!(hub.take_reply_targets(&session, "critic"), vec!["maker".to_string(), "human".to_string()],
            "the open turn's edge is intact: both requests it carries, none closed by the stale paint");
        let _ = std::fs::remove_dir_all(root);
    }

    /// A legacy build's unread.json is REMOVED at load (the retired unread
    /// inbox must not leave stale reply summaries on disk for ever), and the
    /// hub stays functional: the inbox dir exists for the helper to write into.
    #[test]
    fn load_removes_the_legacy_unread_file_and_keeps_the_inbox() {
        let root = std::env::temp_dir().join(format!("tmm-legacy-unread-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("unread.json"), r#"[{"summary":"stale"}]"#).unwrap();
        let hub = AgentNotificationHub::load_at(root.clone());
        assert!(!root.join("unread.json").exists(), "legacy file removed at load");
        assert!(root.join("inbox").is_dir(), "the hook inbox is still provisioned");
        // The surviving surfaces still answer.
        assert!(hub.agent_session_for("none", "w0").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    /// Consume order IS render order, because an event is stamped when it is
    /// consumed. Filesystem order is arbitrary, so the listing sorts by the
    /// epoch prefix the helper writes.
    #[test]
    fn inbox_is_consumed_in_the_order_the_hooks_wrote_it() {
        let dir = std::env::temp_dir().join(format!("tmm-inbox-order-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // Written out of order on purpose, including a second-boundary pair.
        for name in ["1755300010-42.json", "1755300002-7.json", "1755300002-3.json", "notes.txt"] {
            std::fs::write(dir.join(name), "{}").unwrap();
        }
        let got: Vec<String> = inbox_files(&dir)
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            got,
            vec!["1755300002-3.json", "1755300002-7.json", "1755300010-42.json"],
            "oldest first, non-json ignored"
        );
        assert!(inbox_files(&dir.join("missing")).is_empty(), "no inbox yet is not an error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn normalizes_backend_events() {
        let envelope = |backend: &str, payload: Value| InboxEnvelope {
            backend: backend.into(),
            pane_id: "%1".into(),
            payload,
        };
        assert_eq!(
            normalize(&envelope(
                "claude",
                json!({"hook_event_name":"Notification","notification_type":"permission_prompt"})
            ))
            .unwrap()
            .kind,
            "permission_required"
        );
        // board #75: a real question is an ask; the 60 s idle reminder is not
        // an event at all (consume_file drops it before normalize).
        assert_eq!(
            normalize(&envelope(
                "claude",
                json!({"hook_event_name":"Notification","notification_type":"agent_needs_input"})
            ))
            .unwrap()
            .kind,
            "input_required"
        );
        let nudge = envelope(
            "claude",
            json!({"hook_event_name":"Notification","notification_type":"idle_prompt"}),
        );
        assert!(is_idle_nudge(&nudge));
        assert!(normalize(&nudge).is_err(), "no ask kind is ever derived from the idle nudge");
        assert!(!is_idle_nudge(&envelope("claude", json!({"hook_event_name":"Notification","notification_type":"permission_prompt"}))));
        assert_eq!(
            normalize(&envelope("codex", json!({"hook_event_name":"Stop"})))
                .unwrap()
                .kind,
            "completed"
        );
        assert_eq!(
            normalize(&envelope("kiro", json!({"hook_event_name":"stop"})))
                .unwrap()
                .kind,
            "completed"
        );
        // A kiro completion whose WHOLE reply is the CLI's own placeholder (board
        // #355) said nothing: `empty`. The same words from another backend, or
        // inside a real reply, are not the CLI talking.
        let placeholder = "(No assistant response was recorded for the preceding turn. This placeholder was inserted automatically to preserve message alternation — it is not a reply the assistant produced.)";
        use crate::backends::EndQuality as Q;
        let stop = |backend: &str, text: &str| {
            let event = if backend == "claude" { "Stop" } else { "stop" };
            normalize(&envelope(backend, json!({"hook_event_name":event,"assistant_response":text}))).unwrap()
        };
        assert_eq!(stop("kiro", placeholder).quality, Q::Empty, "the CLI's stand-in is an empty turn");
        assert_eq!(stop("kiro", &format!("  {placeholder}")).quality, Q::Empty);
        assert_eq!(stop("kiro", "Done: the gate is green.").quality, Q::Said);
        assert_eq!(stop("kiro", &format!("I saw this line in the log: {placeholder}")).quality, Q::Said, "a real reply that quotes it is a reply");
        assert_eq!(stop("kiro", &format!("{placeholder} Then the result: green.")).quality, Q::Said, "the placeholder followed by real text is a reply");
        assert_eq!(stop("kiro", "(No assistant response was recorded for the preceding turn").quality, Q::Said, "half the sentence is not the CLI's text");
        assert_eq!(stop("claude", placeholder).quality, Q::Said, "only kiro-cli writes it");
        assert_eq!(normalize(&envelope("kiro", json!({"hook_event_name":"stop"}))).unwrap().quality, Q::Unknown, "no reply at all is neither the placeholder nor speech");
        assert_eq!(stop("kiro", "  \n ").quality, Q::Unknown, "a blank reply is not speech either");
        // grok (1.0.5, payloads measured live): camelCase keys, snake_case
        // event values. A turn's true end is stop + reason end_turn, and it
        // carries the reply in lastAssistantMessage.
        let done = normalize(&envelope(
            "grok",
            json!({"hookEventName":"stop","reason":"end_turn","lastAssistantMessage":"OK","sessionId":"01a0-abc"}),
        ))
        .unwrap();
        assert_eq!(done.kind, "completed");
        assert_eq!(done.full_reply.as_deref(), Some("OK"));
        assert_eq!(done.agent_session_id.as_deref(), Some("01a0-abc"));
        // The session-teardown stop ("shutdown"/"channel_closed") fires too and
        // must NOT read as a completion — it would double-post every reply.
        assert!(normalize(&envelope("grok", json!({"hookEventName":"stop","reason":"shutdown"}))).is_err());
        assert_eq!(
            normalize(&envelope("grok", json!({"hookEventName":"stop_failure","error":"rate_limit"})))
                .unwrap()
                .kind,
            "failed"
        );
        // The turn-start reset + tool telemetry recognize grok's spellings.
        assert!(is_user_prompt_submit(&envelope(
            "grok",
            json!({"hookEventName":"user_prompt_submit","prompt":"<user_query>\nhi\n</user_query>"})
        )));
        let (tool, detail) = tool_event_parts(&envelope(
            "grok",
            json!({"hookEventName":"pre_tool_use","toolName":"run_terminal_command","toolInput":{"command":"npm test"}}),
        ))
        .unwrap();
        assert_eq!((tool.as_str(), detail.as_str()), ("run_terminal_command", "npm test"));
    }

    /// claude and codex spell the turn start snake-key/Pascal-value
    /// ("hook_event_name":"UserPromptSubmit"). Codex measured on codex-cli
    /// 0.148.0 (payload carries prompt + session_id, arrives on hook stdin);
    /// claude's documented schema is the same family. Without these arms the
    /// dedup flag never reset for their windows — the first `tmm send`
    /// suppressed every later auto-post, and delivered lines were never acked.
    #[test]
    fn claude_and_codex_turn_starts_are_recognized() {
        let envelope = |backend: &str, payload: Value| InboxEnvelope {
            backend: backend.into(),
            pane_id: "%1".into(),
            payload,
        };
        for backend in ["claude", "codex"] {
            assert!(
                is_user_prompt_submit(&envelope(
                    backend,
                    json!({"hook_event_name":"UserPromptSubmit","prompt":"hi","session_id":"01a0-abc"})
                )),
                "{backend} turn start must be recognized"
            );
            // Tool events keep routing to telemetry, never to the reset path.
            assert!(!is_user_prompt_submit(&envelope(
                backend,
                json!({"hook_event_name":"PreToolUse","tool_name":"Read"})
            )));
        }
    }

    /// omp payloads come from our OWN telemetry extension
    /// (backends::omp::omp_telemetry_extension), which speaks claude's dialect by
    /// construction: UserPromptSubmit resets the turn flag, Stop is the
    /// completion carrying the reply and the session id.
    #[test]
    fn omp_events_ride_the_claude_dialect() {
        let envelope = |payload: Value| InboxEnvelope {
            backend: "omp".into(),
            pane_id: "%1".into(),
            payload,
        };
        assert!(is_user_prompt_submit(&envelope(
            json!({"hook_event_name":"UserPromptSubmit","prompt":"hi","session_id":"0199-abc"})
        )));
        let n = normalize(&envelope(
            json!({"hook_event_name":"Stop","last_assistant_message":"done and verified","session_id":"0199-abc"}),
        ))
        .unwrap();
        assert_eq!(n.kind, "completed");
        assert_eq!(n.full_reply.as_deref(), Some("done and verified"));
        assert_eq!(n.agent_session_id.as_deref(), Some("0199-abc"));
        // Tool events route to telemetry, and unknown events are errors.
        let (tool, detail) = tool_event_parts(&envelope(
            json!({"hook_event_name":"PreToolUse","tool_name":"bash","tool_input":{"command":"npm test"}}),
        ))
        .unwrap();
        assert_eq!((tool.as_str(), detail.as_str()), ("bash", "npm test"));
        assert!(normalize(&envelope(json!({"hook_event_name":"SessionStart"}))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn helper_is_tmux_scoped_and_best_effort_without_server() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let root = std::env::temp_dir().join(format!("tmm-agent-helper-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.write_helper().unwrap();
        let helper = hub.helper_path();

        let run = |pane: Option<&str>| {
            let mut command = Command::new(&helper);
            command
                .arg("codex")
                .env_remove("TMUX_PANE")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(pane) = pane {
                command.env("TMUX_PANE", pane);
            }
            let mut child = command.spawn().unwrap();
            let write = child
                .stdin
                .take()
                .unwrap()
                .write_all(br#"{"hook_event_name":"Stop"}"#);
            // With no TMUX_PANE the helper is REQUIRED to exit immediately,
            // before reading stdin. It may therefore close the pipe before
            // this parent write wins the race; BrokenPipe is the expected
            // shape of that successful early exit. With a pane, the payload
            // is load-bearing and must be accepted.
            if pane.is_some() {
                write.unwrap();
            }
            child.wait_with_output().unwrap()
        };

        let outside_tmux = run(None);
        assert!(outside_tmux.status.success());
        assert!(std::fs::read_dir(root.join("inbox"))
            .unwrap()
            .next()
            .is_none());

        // No server or inbox consumer is running for this isolated root. Keep
        // stdin open after one JSON line to model CLIs that wait for the hook
        // before closing their pipe; the helper must still exit promptly.
        let mut command = Command::new(&helper);
        command
            .arg("codex")
            .env("TMUX_PANE", "%42")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(b"{\"hook_event_name\":\"Stop\"}\n")
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "helper waited for stdin EOF"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert!(status.success());
        drop(stdin);

        let event = std::fs::read_dir(root.join("inbox"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let envelope: InboxEnvelope =
            serde_json::from_slice(&std::fs::read(event).unwrap()).unwrap();
        assert_eq!(envelope.backend, "codex");
        assert_eq!(envelope.pane_id, "%42");

        // Even a local delivery failure must never surface as an Agent hook
        // failure; notifications are advisory.
        std::fs::remove_dir_all(root.join("inbox")).unwrap();
        std::fs::write(root.join("inbox"), "not a directory").unwrap();
        let unavailable_inbox = run(Some("%42"));
        assert!(unavailable_inbox.status.success());
        assert!(unavailable_inbox.stderr.is_empty());

        let _ = std::fs::remove_dir_all(root);
    }

    /// End-to-end over the real inbox and a real tmux pane: a
    /// `userPromptSubmit` envelope must land in telemetry as the input half of
    /// the transcript AND acknowledge a line we typed. The payload shape here
    /// is the one measured from kiro-cli 2.16.2 — `{hook_event_name, cwd,
    /// prompt}` — so the field name this depends on is pinned by a test rather
    /// than by a comment.
    #[test]
    fn a_prompt_envelope_becomes_input_telemetry_and_a_delivery_receipt() {
        let session = format!("tmm-prompt-{}", std::process::id());
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "sleep 30"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        let panes = crate::tmux::list_panes(&session).unwrap_or_default();
        let pane = panes.first().expect("the new session has a pane").clone();
        // resolve_pane_id wants tmux's own `%N` id, which TmuxPane doesn't carry.
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let root = std::env::temp_dir().join(format!("tmm-prompt-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        // What deliver_mentions types into the pane.
        let line = "[tmm chat] human: @dev ship it";
        crate::projects::telemetry::record_delivery(&session, &pane.window_name, line, "");

        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let envelope = json!({
            "backend": "kiro",
            "pane_id": pane_id,
            "payload": {
                "hook_event_name": "userPromptSubmit",
                "cwd": "/tmp",
                "prompt": line,
            }
        });
        std::fs::write(
            root.join("inbox").join("1-prompt.json"),
            serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
        hub.consume_inbox();

        let events = crate::projects::telemetry::recent_events(&session, 0);
        let prompt = events.iter().find(|e| e.kind == "prompt").expect("prompt recorded");
        assert_eq!(prompt.text, line, "the input half of the transcript");
        assert_eq!(prompt.via, "app", "and the receipt for the line we typed");
        // A consumed envelope is removed.
        assert!(!root.join("inbox").join("1-prompt.json").exists(), "envelope consumed");

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(root);
    }

    /// A codex SUB-AGENT's brief is the agent's own work, not keyboard input
    /// (board #169; owner 2026-09-11: the feed showed codex INPUT rows nobody
    /// typed — the parent's briefs to its children). Measured on codex-cli
    /// 0.153.4: the child's `UserPromptSubmit` carries `agent_id`/`agent_type`
    /// and the PARENT's `session_id`. Such an event must (1) not open a turn —
    /// the reply edge the requester's delivery set stays, so the parent's final
    /// reply still reaches its sender; (2) not become the window's prompt;
    /// (3) land in the tool lane as a `Subagent` step carrying the brief.
    #[test]
    fn a_subagent_brief_is_a_tool_row_and_leaves_the_turn_alone() {
        let session = format!("tmm-subagent-{}", std::process::id());
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "sleep 30"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        let panes = crate::tmux::list_panes(&session).unwrap_or_default();
        let pane = panes.first().expect("the new session has a pane").clone();
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        let root = std::env::temp_dir().join(format!("tmm-subagent-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let write = |name: &str, payload: Value| {
            let envelope = json!({ "backend": "codex", "pane_id": pane_id, "payload": payload });
            std::fs::write(root.join("inbox").join(name), serde_json::to_vec(&envelope).unwrap()).unwrap();
        };

        // Another agent opens the parent's turn with an addressed line (a human
        // sender carries no reply edge by design — the Hub shows the room).
        let line = "[tmm chat] claude: @codex review #164";
        crate::projects::telemetry::record_delivery(&session, &pane.window_name, line, "");
        write("1-parent.json", json!({
            "hook_event_name": "UserPromptSubmit", "session_id": "01a08e9b-root", "turn_id": "t1",
            "prompt": line,
        }));
        hub.consume_inbox();
        assert_eq!(hub.state.lock().unwrap().reply_targets.get(&window_key(&session, &pane.window_name)).map(|m| m.1.clone()), Some(vec!["claude".to_string()]));

        // The parent briefs a child: the child's UserPromptSubmit fires on the
        // same pane, with the measured discriminator fields.
        let brief = "Please adversarial-review the in-progress #164 diff";
        write("2-child.json", json!({
            "hook_event_name": "UserPromptSubmit", "session_id": "01a08e9b-root", "turn_id": "t1",
            "agent_id": "01a08e9b-c9b0-child", "agent_type": "default",
            "prompt": brief,
        }));
        hub.consume_inbox();

        let st = hub.state.lock().unwrap();
        assert_eq!(
            st.reply_targets.get(&window_key(&session, &pane.window_name)).map(|m| m.1.clone()),
            Some(vec!["claude".to_string()]),
            "the child's brief must not replace the parent's reply edge"
        );
        assert!(!st.sessions.contains_key(&window_key(&session, &pane.window_name)) || st.sessions[&window_key(&session, &pane.window_name)] == "01a08e9b-root");
        drop(st);
        let events = crate::projects::telemetry::recent_events(&session, 0);
        let prompts: Vec<_> = events.iter().filter(|e| e.kind == "prompt").collect();
        assert_eq!(prompts.len(), 1, "one keyboard/delivery prompt, not two: {events:?}");
        assert_eq!(prompts[0].text, line);
        let mut inputs = Vec::new();
        crate::projects::telemetry::for_each_turn_input(&session, &pane.window_name, None, |senders| inputs.push(senders.to_vec()));
        assert_eq!(inputs, vec![vec!["claude".to_string()]], "the window's one input is still that line, from claude");
        let tool = events.iter().find(|e| e.kind == "tool" && e.tool == "Subagent").expect("the brief lands in the tool lane");
        assert!(tool.text.contains("adversarial-review"), "{}", tool.text);

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(root);
    }

    /// A codex sub-agent's PermissionRequest IS the window's ask (board #170).
    /// Measured on codex-cli 0.153.4 (scratch CODEX_HOME, -a on-request
    /// -s read-only, child told to write a file): the parent TUI shows the
    /// modal "Would you like to run the following command? Thread: Agent
    /// (01a08eab)…" and blocks the pane until the human answers, and the hook
    /// payload is PermissionRequest {agent_id, agent_type, tool_name: "Bash",
    /// tool_input: {command, description}}. So it must derive
    /// permission_required exactly like the parent's own ask — the door must
    /// not drop it with the other child lifecycle events.
    #[test]
    fn a_subagent_permission_request_is_the_windows_ask() {
        let session = format!("tmm-subask-{}", std::process::id());
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "sleep 30"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        // resolve_pane_id wants tmux's own `%N` id, which TmuxPane doesn't carry.
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();
        let root = std::env::temp_dir().join(format!("tmm-subask-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let envelope = json!({ "backend": "codex", "pane_id": pane_id, "payload": {
            "session_id": "01a08eaa-6d19-root", "turn_id": "01a08eab-3cdc",
            "agent_id": "01a08eab-3cb8-7753-a4fc-a98a33e39728", "agent_type": "default",
            "hook_event_name": "PermissionRequest", "permission_mode": "default",
            "tool_name": "Bash",
            "tool_input": { "command": "echo child-wrote > /tmp/x/child.txt",
                            "description": "Do you approve running the exact command outside the read-only sandbox to write child.txt?" }
        }});
        std::fs::write(root.join("inbox").join("1-ask.json"), serde_json::to_vec(&envelope).unwrap()).unwrap();
        hub.consume_inbox();

        let events = crate::projects::telemetry::recent_events(&session, 0);
        assert!(
            events.iter().any(|e| e.kind == "notif" && e.text == "permission_required"),
            "the child's ask blocks the parent's pane, so it is the window's ask: {events:?}"
        );

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(root);
    }

    /// The same path with a SERVER RESTART in the middle — board #5. The agent
    /// is a separate process: it queued our line and submits it when its turn
    /// ends, which can be after we came back. The receipt used to die with the
    /// old process, so the recovered echo was filed as keyboard input (`via:
    /// local`) and the message stayed unconfirmed (owner, 2026-08-29: "后端的服务
    /// 有重启了，然后agent又收到指令确认hooks，这个hooks没有正确把之前的未确认的
    /// 消息变成已读状态，被单独写出来了"). Now the queue is in state.db, so the
    /// hook still recognises the prompt as ours.
    #[test]
    fn a_prompt_envelope_after_a_restart_is_still_a_delivery_receipt() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-restart-{}", std::process::id());
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "sleep 30"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        let panes = crate::tmux::list_panes(&session).unwrap_or_default();
        let pane = panes.first().expect("the new session has a pane").clone();
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_string();

        let root = std::env::temp_dir().join(format!("tmm-restart-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        let line = "[tmm chat] human: @dev restart proof";
        crate::projects::telemetry::record_delivery(&session, &pane.window_name, line, "");
        // ── the restart: a fresh process has no telemetry records at all.
        crate::projects::telemetry::forget_process_state(&session);

        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let envelope = json!({
            "backend": "kiro",
            "pane_id": pane_id,
            "payload": {
                "hook_event_name": "userPromptSubmit",
                "cwd": "/tmp",
                "prompt": line,
            }
        });
        std::fs::write(
            root.join("inbox").join("1-prompt.json"),
            serde_json::to_vec(&envelope).unwrap(),
        )
        .unwrap();
        hub.consume_inbox();

        let events = crate::projects::telemetry::recent_events(&session, 0);
        let prompt = events.iter().find(|e| e.kind == "prompt").expect("prompt recorded");
        assert_eq!(
            prompt.via, "app",
            "the echo of a line typed before the restart is still OUR delivery"
        );

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(root);
    }

    /// The whole auto-post path, end to end: a real tmux window, a real managed
    /// home, a real inbox file carrying a real kiro `stop` payload — and the
    /// agent's final answer must land in the room and carry the turn's reply
    /// edge.
    #[test]
    fn a_stop_payload_posts_the_agents_final_answer_to_the_room() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-auto-{}", std::process::id());
        let ws = std::env::temp_dir().join(format!("tmm-auto-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".tmm/agents/dev")).unwrap();
        std::fs::write(ws.join(".tmm/agents/dev/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "dev", "-c",
                   &ws.to_string_lossy(), "sleep 60"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        let adopted = crate::projects::adopt(&session, Some("auto-test")).is_ok();
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output().unwrap().stdout,
        ).unwrap().trim().to_string();

        // A poster that records what it was asked to post.
        struct Spy(std::sync::Mutex<Vec<(String, String, String, Vec<String>)>>);
        impl RoomPoster for Spy {
            fn post_final(&self, session: &str, agent: &str, body: &str, reply_to: &[String]) -> Result<(), String> {
                self.0.lock().unwrap().push((
                    session.into(), agent.into(), body.into(), reply_to.to_vec()
                ));
                Ok(())
            }
        }
        let spy = std::sync::Arc::new(Spy(std::sync::Mutex::new(Vec::new())));

        let root = std::env::temp_dir().join(format!("tmm-auto-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.set_room_poster(spy.clone());
        let (_, win, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane resolves");
        // Board #289: the human asks in the same turn (one combined prompt).
        hub.start_turn(&session, &win, "[tmm chat 2026-09-08 08:00] lead: @dev fix it\n\n[tmm chat 2026-09-08 08:00] human: @dev and add a test");
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        // Exactly the payload measured from kiro-cli 2.16.2.
        std::fs::write(
            root.join("inbox").join("1-stop.json"),
            serde_json::to_vec(&json!({
                "backend": "kiro",
                "pane_id": pane_id,
                "payload": {
                    "hook_event_name": "stop",
                    "cwd": ws.to_string_lossy(),
                    "session_id": "conv-1",
                    "assistant_response": "Fixed the flaky test: it assumed a 4 MB read is slow."
                }
            })).unwrap(),
        ).unwrap();
        hub.consume_inbox();

        if adopted {
            let posts = spy.0.lock().unwrap();
            assert_eq!(posts.len(), 1, "the final answer is posted exactly once");
            let (s, agent, body, reply_to) = &posts[0];
            assert_eq!(s, &session);
            assert_eq!(agent, "dev", "posted as the agent, by window name");
            assert!(body.contains("Fixed the flaky test"), "the answer itself: {body:?}");
            assert_eq!(reply_to, &vec!["lead".to_string(), "human".to_string()], "recorded to both (#289)");
        } else {
            eprintln!("could not adopt a project — skipped the assertions");
        }

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(root);
    }

    /// #256 review (validator 03:11, orchestrator 03:05/03:07): the FULL hook
    /// chain, through the inbox, with a real stop payload. completed → a
    /// tool-only turn (derive_from: running) → orchestrator's input → a
    /// `[reply]` mid-turn → Stop ⇒ the final answer is posted to
    /// orchestrator. Then an interrupt's memo never leaks, on two separate
    /// paths: (a) orchestrator 03:52 — orchestrator asks, the turn is
    /// interrupted from outside, a tool-only turn runs and Stops with NO input
    /// in between ⇒ reply_to [] and nothing is typed to orchestrator (the
    /// epoch alone invalidates the memo; no start_turn runs to clear it);
    /// (b) the same with a `[reply]` before the Stop (start_turn's path).
    #[test]
    fn a_tool_only_turn_then_a_request_then_a_reply_posts_to_the_requester() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-tool-turn-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-tool-turn-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".tmm/agents/v")).unwrap();
        std::fs::write(ws.join(".tmm/agents/v/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "v", "-c", &ws.to_string_lossy(), "sleep 60"])
            .status().map(|s| s.success()).unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        // Cleanup from here on, even when an assertion (or a negative control)
        // panics: a live session left behind is adopted as a project by the
        // server on the same tmux (#251).
        struct KillOnDrop(String, std::path::PathBuf);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        let adopted = crate::projects::adopt(&session, Some("tool-turn-test")).is_ok();
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux").args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output().unwrap().stdout,
        ).unwrap().trim().to_string();
        struct Spy(std::sync::Mutex<Vec<Vec<String>>>);
        impl RoomPoster for Spy {
            fn post_final(&self, _s: &str, _a: &str, _b: &str, reply_to: &[String]) -> Result<(), String> {
                self.0.lock().unwrap().push(reply_to.to_vec());
                Ok(())
            }
        }
        let spy = std::sync::Arc::new(Spy(std::sync::Mutex::new(Vec::new())));
        let root = std::env::temp_dir().join(format!("tmm-tool-turn-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.set_room_poster(spy.clone());
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let mut seq = 0;
        let mut feed = |payload: Value| {
            seq += 1;
            let envelope = json!({ "backend": "kiro", "pane_id": pane_id, "payload": payload });
            std::fs::write(root.join("inbox").join(format!("{seq:03}.json")), serde_json::to_vec(&envelope).unwrap()).unwrap();
            hub.consume_inbox();
        };
        let prompt = |text: &str| json!({ "hook_event_name": "userPromptSubmit", "cwd": ws.to_string_lossy(), "session_id": "c", "prompt": text });
        let tool = || json!({ "hook_event_name": "preToolUse", "cwd": ws.to_string_lossy(), "session_id": "c",
                             "tool_name": "execute_bash", "tool_input": { "command": "ls" } });
        let stop = |text: &str| json!({ "hook_event_name": "stop", "cwd": ws.to_string_lossy(), "session_id": "c", "assistant_response": text });
        let (_, win, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane resolves");

        feed(prompt("[tmm chat 2026-09-28 03:00] lead: @v warm up"));
        feed(stop("warmed"));
        feed(tool());
        assert_eq!(crate::projects::telemetry::derive(&session, &win, 0).state, "running", "a tool-only turn is open");
        feed(prompt("[tmm chat 2026-09-28 03:01] orchestrator: @v final review please"));
        feed(prompt("[tmm chat 2026-09-28 03:01] builder: [reply] fixed at HEAD"));
        feed(stop("SHIP"));

        // (a) NO input between the interrupt and the Stop. The interrupt is
        // what hub_agent_interrupt does: record the end, then drop the edge.
        feed(prompt("[tmm chat 2026-09-28 03:02] orchestrator: @v start X"));
        crate::projects::telemetry::record_interrupt(&session, &win);
        hub.end_turn(&session, &win);
        assert!(!hub.state.lock().unwrap().reply_targets.contains_key(&window_key(&session, &win)),
            "the end edge cleared the interrupted turn's edge");
        feed(tool());
        feed(stop("stopped after the interrupt"));

        // (a') the same, when an end is recorded but nobody called end_turn
        // (a persisted interrupt replayed after a restart): the epoch still
        // keeps the memo from answering the old requester.
        feed(prompt("[tmm chat 2026-09-28 03:03] orchestrator: @v start W"));
        crate::projects::telemetry::record_interrupt(&session, &win);
        feed(tool());
        feed(stop("stopped after an unseen interrupt"));

        // (b) a [reply] before the Stop.
        feed(prompt("[tmm chat 2026-09-28 03:04] orchestrator: @v start Y"));
        crate::projects::telemetry::record_interrupt(&session, &win);
        feed(tool());
        feed(prompt("[tmm chat 2026-09-28 03:05] builder: [reply] fyi"));
        feed(stop("noted"));

        if adopted {
            let posts = spy.0.lock().unwrap();
            assert_eq!(posts.len(), 5, "{posts:?}");
            assert_eq!(posts[0], vec!["lead".to_string()]);
            assert_eq!(posts[1], vec!["orchestrator".to_string()], "the requester of the tool-only turn gets the final answer");
            assert!(posts[2].is_empty(), "(a) interrupt → tool-only → Stop with no input: nobody, not the interrupted requester: {:?}", posts[2]);
            assert!(posts[3].is_empty(), "(a') an end end_turn never saw: the epoch still answers nobody: {:?}", posts[3]);
            assert!(posts[4].is_empty(), "(b) interrupt → tool → [reply] → Stop: nobody: {:?}", posts[4]);
        } else {
            eprintln!("could not adopt a project — skipped the assertions");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    /// Board #355 review P1-2, through the REAL normalize and no-body fallback:
    /// only a real reply reopens the nudge allowance. A Stop whose reply could not
    /// be had — no session file, a blank body, a session whose file is unreadable
    /// — is no evidence that the agent spoke, so after a nudge was spent it
    /// neither reopens the allowance nor owes a nudge itself; a Stop with real text
    /// does reopen it. Each Stop is read exactly as the consumer reads one
    /// (`normalize_in` over the agent's isolated home, then
    /// `record_notification_with` with the quality it returned).
    #[test]
    fn only_a_real_reply_reopens_a_spent_nudge_through_the_real_fallback() {
        crate::projects::tests::use_test_store();
        use crate::projects::telemetry::{arm_nudge, disarm_nudge, nudge_wait, record_notification_with, record_prompt, NudgeWait};
        let home = std::env::temp_dir().join(format!("tmm-quality-home-{}", uuid::Uuid::new_v4()));
        let session_file = |id: &str, rows: Option<&str>| {
            let dir = home.join("sessions").join("297005da4b9f6bd1").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(rows) = rows {
                std::fs::write(dir.join("messages.jsonl"), rows).unwrap();
            }
        };
        session_file("sess_empty", Some(r#"{"id":"1","payload":{"type":"assistant","content":"(No assistant response was recorded for the preceding turn. This placeholder was inserted automatically to preserve message alternation — it is not a reply the assistant produced.)","operationType":"Say"}}"#));
        session_file("sess_real", Some(r#"{"id":"2","payload":{"type":"assistant","content":"Posted #48; waiting on the critic.","operationType":"Say"}}"#));
        session_file("sess_unreadable", None); // the directory is there, its messages.jsonl is not
        let (s, w) = (format!("quality-{}", uuid::Uuid::new_v4()), "dev");
        let stop = |payload: Value| {
            record_prompt(&s, w, "[tmm chat 2026-10-15 14:00] lead: @dev go on");
            let envelope = InboxEnvelope { backend: "kiro".into(), pane_id: "%1".into(), payload };
            let n = normalize_in(&envelope, Some(&home)).unwrap();
            record_notification_with(&s, w, &n.kind, n.quality);
            n.quality
        };
        let body_less = |id: &str| json!({"hook_event_name": "stop", "session_id": id});
        use crate::backends::EndQuality as Q;

        // A nudge was owed, delivered, and spent.
        assert_eq!(stop(body_less("sess_empty")), Q::Empty);
        let token = arm_nudge(&s, w).expect("the first empty end is owed a nudge");
        let NudgeWait::Due(due) = nudge_wait(&s, w, token, 0, 0) else { panic!("due") };
        crate::projects::telemetry::spend_nudge(&s, w, due.run);
        disarm_nudge(&s, w, token);

        // Stops with nothing usable in between: they do not forgive it.
        assert_eq!(stop(body_less("sess_not_there")), Q::Unknown, "no session file at all");
        assert_eq!(stop(json!({"hook_event_name": "stop", "assistant_response": " \n "})), Q::Unknown, "a blank body");
        assert_eq!(stop(body_less("sess_unreadable")), Q::Unknown, "a session whose file cannot be read");
        assert_eq!(stop(body_less("sess_empty")), Q::Empty);
        assert!(arm_nudge(&s, w).is_none(), "spent -> unavailable -> placeholder: no second nudge");

        // A real reply forgives it.
        assert_eq!(stop(body_less("sess_real")), Q::Said);
        assert_eq!(stop(body_less("sess_empty")), Q::Empty);
        assert!(arm_nudge(&s, w).is_some(), "spent -> real reply -> placeholder: one nudge");
        let _ = std::fs::remove_dir_all(home);
    }

    /// Board #355, end to end through the consumer: a kiro Stop whose whole reply
    /// is the CLI's placeholder is recorded on the status (`last_turn_empty`) and
    /// arms the one timer it is owed — that is how the test sees the consumer
    /// reached `stalls`, since an empty end nobody armed would still be armable —
    /// and a Stop with something to say names nothing.
    #[test]
    fn an_empty_stop_reaches_the_status_and_owes_one_nudge() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-empty-turn-{}", uuid::Uuid::new_v4());
        let ws = std::env::temp_dir().join(format!("tmm-empty-turn-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(ws.join(".tmm/agents/v")).unwrap();
        std::fs::write(ws.join(".tmm/agents/v/launch.json"), "{}").unwrap();
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "v", "-c", &ws.to_string_lossy(), "sleep 60"])
            .status().map(|s| s.success()).unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        struct KillOnDrop(String, std::path::PathBuf);
        impl Drop for KillOnDrop {
            fn drop(&mut self) {
                let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &format!("={}", self.0)]).stderr(std::process::Stdio::null()).status();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let _cleanup = KillOnDrop(session.clone(), ws.clone());
        let _ = crate::projects::adopt(&session, Some("empty-turn-test"));
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux").args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output().unwrap().stdout,
        ).unwrap().trim().to_string();
        let root = std::env::temp_dir().join(format!("tmm-empty-turn-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let mut seq = 0;
        let mut feed = |payload: Value| {
            seq += 1;
            let envelope = json!({ "backend": "kiro", "pane_id": pane_id, "payload": payload });
            std::fs::write(root.join("inbox").join(format!("{seq:03}.json")), serde_json::to_vec(&envelope).unwrap()).unwrap();
            hub.consume_inbox();
        };
        let prompt = |text: &str| json!({ "hook_event_name": "userPromptSubmit", "cwd": ws.to_string_lossy(), "session_id": "c", "prompt": text });
        let stop = |text: &str| json!({ "hook_event_name": "stop", "cwd": ws.to_string_lossy(), "session_id": "c", "assistant_response": text });
        let (_, win, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane resolves");
        let placeholder = "(No assistant response was recorded for the preceding turn. This placeholder was inserted automatically to preserve message alternation — it is not a reply the assistant produced.)";
        let status = || crate::projects::telemetry::derive(&session, &win, 0);

        feed(prompt("[tmm chat 2026-10-15 13:00] lead: @v keep going"));
        feed(stop(placeholder));
        let empty = status();
        assert_eq!((empty.state.as_str(), empty.detail.as_str()), ("idle", crate::projects::telemetry::EMPTY_DETAIL), "at rest, and it says the turn said nothing");
        assert!(crate::projects::telemetry::arm_nudge(&session, &win).is_none(), "the consumer already armed the one timer this empty end is owed");

        feed(prompt("[tmm chat 2026-10-15 13:10] lead: @v ok?"));
        feed(stop("Done: the gate is green."));
        let said = status();
        assert_eq!((said.state.as_str(), said.detail.as_str()), ("idle", ""), "a turn with something to say names nothing");
        let _ = std::fs::remove_dir_all(root);
    }

    /// kimi end to end (board #224), the three edges claude's review asked
    /// to see pinned rather than described: (1) a turn-start whose `prompt`
    /// is an ARRAY of parts opens the same turn — the same reply targets — as
    /// the string shape; (2) a bodiless `Stop` posts the reply read from THIS
    /// agent's wire (`managed_home` by name — a sibling kimi home holding the
    /// same session id is never read); (3) an `Interrupt` with no text in the
    /// turn CLOSES the turn — the edge is consumed, telemetry records the end,
    /// nothing is posted — instead of pinning the agent at `working`.
    #[test]
    fn kimi_array_prompt_bodiless_stop_and_interrupt_are_turn_edges() {
        crate::projects::tests::use_test_store();
        let session = format!("tmm-kimi-{}", std::process::id());
        let ws = std::env::temp_dir().join(format!("tmm-kimi-ws-{}", uuid::Uuid::new_v4()));
        let seed_home = |name: &str, reply: &str| {
            let home = ws.join(".tmm/agents").join(name);
            let kimi = home.join("kimi");
            let sdir = kimi.join("sessions/wd_x_000000000000/session_abc");
            std::fs::create_dir_all(sdir.join("agents/main")).unwrap();
            std::fs::write(home.join("launch.json"), "{}").unwrap();
            std::fs::write(
                kimi.join("session_index.jsonl"),
                format!("{}\n", json!({"sessionId":"session_abc","sessionDir":sdir.to_string_lossy(),"workDir":ws.to_string_lossy()})),
            )
            .unwrap();
            std::fs::write(
                sdir.join("agents/main/wire.jsonl"),
                format!(
                    "{}\n{}\n",
                    r#"{"type":"turn.prompt","input":[{"type":"text","text":"fix it"}]}"#,
                    json!({"message":{"message":{"role":"assistant","content":[{"type":"think","think":"…"},{"type":"text","text":reply}]}},"type":"agent.message.appended"})
                ),
            )
            .unwrap();
            sdir.join("agents/main/wire.jsonl")
        };
        let k1_wire = seed_home("k1", "Fixed it: the test assumed a fast disk.");
        seed_home("k2", "DECOY — k2's answer must never be read for k1.");
        let created = std::process::Command::new("tmux")
            .args(["new-session", "-d", "-s", &session, "-n", "k1", "-c", &ws.to_string_lossy(), "sleep 60"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !created {
            eprintln!("no tmux server — skipping");
            return;
        }
        let adopted = crate::projects::adopt(&session, Some("kimi-test")).is_ok();
        let pane_id = String::from_utf8(
            std::process::Command::new("tmux")
                .args(["display-message", "-p", "-t", &session, "#{pane_id}"])
                .output().unwrap().stdout,
        ).unwrap().trim().to_string();

        struct Spy(std::sync::Mutex<Vec<(String, String, Vec<String>)>>);
        impl RoomPoster for Spy {
            fn post_final(&self, _session: &str, agent: &str, body: &str, reply_to: &[String]) -> Result<(), String> {
                self.0.lock().unwrap().push((agent.into(), body.into(), reply_to.to_vec()));
                Ok(())
            }
        }
        let spy = std::sync::Arc::new(Spy(std::sync::Mutex::new(Vec::new())));
        let root = std::env::temp_dir().join(format!("tmm-kimi-hub-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.set_room_poster(spy.clone());
        std::fs::create_dir_all(root.join("inbox")).unwrap();
        let drop = |name: &str, payload: Value| {
            std::fs::write(
                root.join("inbox").join(name),
                serde_json::to_vec(&json!({"backend": "kimi", "pane_id": pane_id, "payload": payload})).unwrap(),
            )
            .unwrap();
        };
        // The measured 2.0.2 shapes: the prompt as parts, the Stop without text.
        let line = "[tmm chat 2026-09-20 14:00] lead: @k1 fix it";
        drop("1-prompt.json", json!({"hook_event_name":"UserPromptSubmit","session_id":"session_abc","cwd":ws.to_string_lossy(),
            "client_type":"kimi_code_cli","prompt":[{"type":"text","text":line}],"is_steer":false}));
        drop("2-stop.json", json!({"hook_event_name":"Stop","session_id":"session_abc","cwd":ws.to_string_lossy(),
            "client_type":"kimi_code_cli","stop_hook_active":false}));
        hub.consume_inbox();

        if adopted {
            let (_, win, _) = crate::tmux::resolve_pane_id(&pane_id).expect("pane resolves");
            assert_eq!(win, "k1");
            {
                let posts = spy.0.lock().unwrap();
                assert_eq!(posts.len(), 1, "one final answer: {posts:?}");
                let (agent, body, reply_to) = &posts[0];
                assert_eq!(agent, "k1");
                assert_eq!(body, "Fixed it: the test assumed a fast disk.", "read from k1's wire, not k2's");
                assert_eq!(reply_to, &vec!["lead".to_string()], "the array prompt routed exactly like the string shape");
            }
            assert_eq!(reply_targets(line), vec!["lead"], "the string shape, for comparison");
            let prompt = crate::projects::telemetry::recent_events(&session, 0)
                .into_iter()
                .find(|e| e.kind == "prompt")
                .expect("the flattened prompt is the transcript's input half");
            assert_eq!(prompt.text, line);

            // A second turn, interrupted before any text: the wire gains only
            // the prompt row; Escape fires `Interrupt` in place of `Stop`.
            let mut wire = std::fs::OpenOptions::new().append(true).open(&k1_wire).unwrap();
            use std::io::Write;
            writeln!(wire, r#"{{"type":"turn.prompt","input":[{{"type":"text","text":"sleep 40"}}]}}"#).unwrap();
            drop("3-prompt.json", json!({"hook_event_name":"UserPromptSubmit","session_id":"session_abc","cwd":ws.to_string_lossy(),
                "prompt":[{"type":"text","text":"[tmm chat 2026-09-20 14:01] lead: @k1 run sleep 40"}]}));
            drop("4-interrupt.json", json!({"hook_event_name":"Interrupt","session_id":"session_abc","cwd":ws.to_string_lossy(),
                "turn_id":2,"reason":"cancelled"}));
            hub.consume_inbox();
            assert_eq!(spy.0.lock().unwrap().len(), 1, "an interrupted turn with no text posts nothing — and never an older answer");
            assert!(hub.take_reply_targets(&session, "k1").is_empty(), "the edge was consumed: the turn is closed, not left running");
            let last_notif = crate::projects::telemetry::recent_events(&session, 0)
                .into_iter()
                .rev()
                .find(|e| e.kind == "notif")
                .expect("the turn end is recorded");
            assert_eq!(last_notif.text, "completed", "Interrupt closes the turn like Stop");
        } else {
            eprintln!("could not adopt a project — skipped the assertions");
        }

        let _ = std::process::Command::new("tmux").args(["kill-session", "-t", &session]).status();
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(root);
    }

    /// A managed dsh agent for real, minus the model (board #404): a pane
    /// running the rendered dsh shell; the generated plugin under node as a
    /// stand-in dsh that replays one ROOT turn whose prompt is its task and
    /// waits for `release-<n>`; the REAL notify helper behind a gate whose
    /// behaviour for the next envelopes of a kind is the file `mode-prompt` /
    /// `mode-stop`, one mode per line, each line consumed by one envelope:
    /// `fail` (exit 1, nothing published),
    /// `hold` (1.5 s, inside the plugin's 3 s bound), `hang` (10 s, past every
    /// bound), `late` (fail now, publish 4 s later from a child that outlives
    /// the invoker); this inbox and its hub; `deliver_chat_line`. Like dsh,
    /// the stand-in AWAITS the plugin's `apply` before the turn opens
    /// (`applied-<n>` once it returned); `factory-hold` keeps the fake
    /// message factory loading until `factory-go` (board #410).
    struct DshRig {
        ws: PathBuf,
        root: PathBuf,
        hub: AgentNotificationHub,
        spy: std::sync::Arc<RigSpy>,
        session: String,
        target: String,
    }

    /// The rig's room: records each post; `fail` posts are refused first
    /// (a room write that failed), one per call.
    struct RigSpy(std::sync::Mutex<Vec<(String, String, Vec<String>)>>, std::sync::atomic::AtomicUsize);
    impl RoomPoster for RigSpy {
        fn post_final(&self, _session: &str, agent: &str, body: &str, reply_to: &[String]) -> Result<(), String> {
            use std::sync::atomic::Ordering;
            if self.1.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_ok() {
                return Err("room write failed".into());
            }
            self.0.lock().unwrap().push((agent.into(), body.into(), reply_to.to_vec()));
            Ok(())
        }
    }

    impl DshRig {
        fn start() -> Option<DshRig> {
            Self::start_in("queue")
        }
        /// The rig with the given input mode (board #410) rendered into the
        /// agent's recipe and home, as spawn does.
        fn start_in(mode: &str) -> Option<DshRig> {
            use crate::backends::dsh::tests::{pane_id, wait_for, which};
            crate::projects::tests::use_test_store();
            let (zsh, node) = (which("zsh")?, which("node")?);
            let ws_raw = std::env::temp_dir().join(format!("tmm-dsh-e2e-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&ws_raw).unwrap();
            let ws = ws_raw.canonicalize().unwrap();
            let home = ws.join(".tmm/agents/d1");
            let (dsh_home, zdot, bin) = (home.join("dsh"), home.join("zsh"), ws.join("bin"));
            for d in [&dsh_home, &zdot, &bin] {
                std::fs::create_dir_all(d).unwrap();
            }
            std::fs::write(home.join("launch.json"), json!({"backend": "dsh", "input_mode": mode, "cmd": "x"}).to_string()).unwrap();
            std::fs::create_dir_all(dsh_home.join("tmm")).unwrap();
            std::fs::write(dsh_home.join("tmm/input_mode"), format!("{mode}\n")).unwrap();
            // dsh's message factory where the plugin looks for it: next to
            // the program it runs as (`realpath(argv[1])`, here driver.mjs).
            // Same contract as @deepseek-ai/dsh-llm's createUserMessage: a
            // fresh id, role user, frozen. With `factory-hold` its module
            // finishes loading only once `factory-go` exists (review P1-C).
            let llm = ws.join("node_modules/@deepseek-ai/dsh-llm");
            std::fs::create_dir_all(llm.join("lib")).unwrap();
            std::fs::write(llm.join("package.json"), r#"{"name":"@deepseek-ai/dsh-llm","version":"0.0.0-fake","type":"module","exports":{".":{"default":"./lib/index.js"}}}"#).unwrap();
            std::fs::write(
                llm.join("lib/index.js"),
                format!(
                    "import {{ randomUUID }} from 'node:crypto'\nimport fs from 'node:fs'\nconst dir = {dir}\n\
                     if (fs.existsSync(`${{dir}}/factory-hold`)) while (!fs.existsSync(`${{dir}}/factory-go`)) await new Promise((r) => setTimeout(r, 30))\n\
                     export function createUserMessage(input) {{ return Object.freeze({{ ...input, id: randomUUID(), role: 'user' }}) }}\n",
                    dir = serde_json::to_string(&ws.to_string_lossy()).unwrap(),
                ),
            )
            .unwrap();
            let root = std::env::temp_dir().join(format!("tmm-dsh-hub-{}", uuid::Uuid::new_v4()));
            let hub = AgentNotificationHub::load_at(root.clone());
            hub.ensure_helper().unwrap();
            let spy = std::sync::Arc::new(RigSpy(std::sync::Mutex::new(Vec::new()), std::sync::atomic::AtomicUsize::new(0)));
            hub.set_room_poster(spy.clone());
            let q = |p: &Path| crate::shell::quote_always(&p.to_string_lossy());
            // Without its trailing `# marker` comment, which would swallow the
            // rest of a line it is embedded in.
            let full = hub.helper_command("dsh");
            let helper = full.split(" # ").next().unwrap().to_string();
            std::fs::write(
                ws.join("notify.sh"),
                format!(
                    "p=$(cat)\nkind=other\ncase \"$p\" in *UserPromptSubmit*) kind=prompt ;; *'\"Stop\"'*) kind=stop ;; esac\n\
                     f={ws}/mode-$kind\nm=$(head -n 1 $f 2>/dev/null)\n[ -e $f ] && {{ tail -n +2 $f > $f.n; mv $f.n $f; [ -s $f ] || rm -f $f; }}\n\
                     case \"$m\" in\n  hold) sleep 1.5 ;;\n  hang) sleep 10 ;;\n  fail) exit 1 ;;\n  late) ( sleep 4; printf '%s\\n' \"$p\" | {helper} ) >/dev/null 2>&1 & exit 1 ;;\nesac\n\
                     printf '%s\\n' \"$p\" | {helper}\n",
                    ws = q(&ws),
                ),
            )
            .unwrap();
            let notify = format!("/bin/sh {}", q(&ws.join("notify.sh")));
            let plugin = dsh_home.join("plugins/tmm-telemetry/index.mjs");
            std::fs::create_dir_all(plugin.parent().unwrap()).unwrap();
            std::fs::write(&plugin, crate::backends::dsh::plugin_js(&notify)).unwrap();
            std::fs::write(zdot.join(".zshenv"), crate::backends::dsh::zshenv()).unwrap();
            std::fs::write(zdot.join(".zshrc"), crate::backends::dsh::zshrc(&notify)).unwrap();
            std::fs::write(
                ws.join("driver.mjs"),
                format!(
                    "import * as p from {plugin}\nimport fs from 'node:fs'\nconst dir = {dir}\n\
                     const task = process.argv[process.argv.indexOf('--') + 1]\n\
                     const n = fs.readdirSync(dir).filter((f) => f.startsWith('task-')).length + 1\n\
                     fs.writeFileSync(`${{dir}}/.task-${{n}}`, task); fs.renameSync(`${{dir}}/.task-${{n}}`, `${{dir}}/task-${{n}}`)\n\
                     let h\nconst root = {{ header: {{ id: 'session-e2e-1' }} }}\n\
                     process.on('SIGINT', () => process.exit(130))\n\
                     const queued = [], seen = new Set(), steered = []\n\
                     const agent = {{ session: root, steer(m) {{ if (m?.role !== 'user' || typeof m.id !== 'string' || m.source?.kind !== 'user' || seen.has(m.id) || !Object.isFrozen(m)) throw new Error('not a UserMessage'); seen.add(m.id); queued.push(m) }} }}\n\
                     await p.apply({{ on: (e, f) => {{ if (e === 'session/event') h = f }}, get: (k) => (k === 'agents' ? {{ roots: () => [agent] }} : undefined) }}, {{}})\n\
                     fs.writeFileSync(`${{dir}}/applied-${{n}}`, '')\n\
                     while (fs.existsSync(`${{dir}}/coldstart`) && !fs.existsSync(`${{dir}}/started-${{n}}`)) await new Promise((r) => setTimeout(r, 30))\n\
                     h(root, {{ type: 'turn/start', data: {{ turn: n }} }})\n\
                     h(root, {{ type: 'user/message', data: {{ role: 'user', source: {{ kind: 'user' }}, content: [{{ type: 'text', text: task }}] }} }})\n\
                     const t = setInterval(() => {{ while (queued.length) {{ const m = queued.shift(); steered.push(m.content[0].text); fs.writeFileSync(`${{dir}}/.steer-${{n}}`, m.content[0].text); fs.renameSync(`${{dir}}/.steer-${{n}}`, `${{dir}}/steer-${{n}}-${{steered.length}}`); h(root, {{ type: 'user/message', data: m }}) }}\n\
                     if (fs.existsSync(`${{dir}}/release-${{n}}`)) {{ clearInterval(t)\n\
                     h(root, {{ type: 'assistant/message', data: {{ message: {{ role: 'assistant', content: [{{ type: 'text', text: steered.length ? `done ${{n}} +${{steered.join(' | ')}}` : `done ${{n}}` }}] }} }} }})\n\
                     h(root, {{ type: 'turn/end', data: {{ turn: n, reason: {{ kind: 'completed' }} }} }})\n\
                     fs.writeFileSync(`${{dir}}/ended-${{n}}`, String(process.pid))\n\
                     const bye = setInterval(() => {{ if (!fs.existsSync(`${{dir}}/linger`) || fs.existsSync(`${{dir}}/exit-${{n}}`)) {{ clearInterval(bye); process.exit(0) }} }}, 30) }} }}, 30)\n",
                    plugin = serde_json::to_string(&plugin.to_string_lossy()).unwrap(),
                    dir = serde_json::to_string(&ws.to_string_lossy()).unwrap(),
                ),
            )
            .unwrap();
            std::fs::write(bin.join("dsh"), format!("#!/bin/sh\nexec {} {} \"$@\"\n", q(&node), q(&ws.join("driver.mjs")))).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(bin.join("dsh"), std::fs::Permissions::from_mode(0o755)).unwrap();
            let session = format!("tmm-dsh-e2e-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            let cmd = format!(
                "env -i HOME={} TERM=xterm-256color LANG=C.UTF-8 TMUX_PANE=\"$TMUX_PANE\" PATH={}:/usr/bin:/bin ZDOTDIR={} DSH_HOME={} {} -i",
                q(&ws), q(&bin), q(&zdot), q(&dsh_home), q(&zsh)
            );
            if crate::tmux::run_tmux(&["new-session", "-d", "-s", &session, "-n", "d1", "-c", &ws.to_string_lossy(), &cmd]).is_err() {
                let _ = std::fs::remove_dir_all(&ws);
                return None;
            }
            crate::projects::adopt(&session, Some(&session)).expect("adopt the scratch session as a project");
            let target = pane_id(&session);
            let rig = DshRig { ws, root, hub, spy, session, target };
            wait_for("the dsh prompt", 15, || rig.ready());
            Some(rig)
        }
        fn ready(&self) -> bool {
            crate::tmux::capture_pane_plain(&self.target, Some(20)).unwrap_or_default().contains(crate::backends::dsh::READY_MARKER)
        }
        /// What a gateway restart does to the hub: a new one over the same
        /// inbox, its memory empty.
        fn restart_gateway(&mut self) {
            self.hub = AgentNotificationHub::load_at(self.root.clone());
            self.hub.set_room_poster(self.spy.clone());
        }
        fn mode(&self, kind: &str, mode: Option<&str>) {
            let f = self.ws.join(format!("mode-{kind}"));
            match mode {
                Some(m) => std::fs::write(f, m).unwrap(),
                None => {
                    let _ = std::fs::remove_file(f);
                }
            }
        }
        fn release(&self, n: usize) {
            std::fs::write(self.ws.join(format!("release-{n}")), "").unwrap();
        }
        /// The runs started so far. The stand-in writes each `task-<n>` (and
        /// each `steer-<n>-<k>`) under a dot name and renames it into place
        /// (board #421: a count was observed and the file read empty), so a
        /// wait on this count observes the same fact `task(n)` reads.
        fn tasks(&self) -> usize {
            std::fs::read_dir(&self.ws).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("task-")).count()
        }
        fn task(&self, n: usize) -> String {
            std::fs::read_to_string(self.ws.join(format!("task-{n}"))).unwrap()
        }
        fn inbox(&self) -> Vec<Value> {
            inbox_files(&self.root.join("inbox"))
                .iter()
                .map(|f| serde_json::from_str::<Value>(&std::fs::read_to_string(f).unwrap()).unwrap()["payload"].clone())
                .collect()
        }
        /// Every inbox file is named by its own payload's sequence
        /// (`<secs>-<seq, 20 digits>-<pid>.json`): a publisher that lost the
        /// number (a record it could not parse) writes an unsequenced name,
        /// whose ORDER is only wrong when no second boundary falls between
        /// two writes — so the order alone pins it only sometimes. The name
        /// pins it on every run.
        fn assert_numbered_names(&self) {
            for f in inbox_files(&self.root.join("inbox")) {
                let name = f.file_stem().unwrap().to_string_lossy().to_string();
                let payload = serde_json::from_str::<Value>(&std::fs::read_to_string(&f).unwrap()).unwrap()["payload"].clone();
                let seq = payload["tmm_seq"].as_u64().unwrap_or_else(|| panic!("{name}: no tmm_seq in {payload}"));
                let parts: Vec<&str> = name.split('-').collect();
                assert_eq!(parts.len(), 3, "{name}: an unsequenced name for tmm_seq {seq}");
                assert_eq!(parts[1], format!("{seq:020}"), "{name}: named by another number than its tmm_seq {seq}");
            }
        }
        /// Type into the pane as a person does (no delivery, no receipt).
        fn type_keys(&self, text: &str, enter: bool) {
            crate::tmux::run_tmux(&["send-keys", "-t", &self.target, "-l", text]).unwrap();
            if enter {
                crate::tmux::send_keys(&self.target, "Enter", false).unwrap();
            }
        }
        fn screen(&self) -> String {
            crate::tmux::capture_pane_plain(&self.target, Some(200)).unwrap_or_default()
        }
        fn steer_ready(&self) -> bool {
            self.ws.join(".tmm/agents/d1/dsh/tmm/steer-ready").is_file()
        }
        fn steers(&self, n: usize) -> Vec<String> {
            (1..)
                .map(|k| self.ws.join(format!("steer-{n}-{k}")))
                .take_while(|f| f.is_file())
                .map(|f| std::fs::read_to_string(f).unwrap())
                .collect()
        }
        fn inbox_has(&self, event: &str) -> bool {
            self.inbox().iter().any(|p| p["hook_event_name"] == event)
        }
        fn held(&self) -> usize {
            crate::projects::telemetry::held_rows(&self.session, "d1").len()
        }
        fn busy(&self) -> bool {
            crate::projects::telemetry::turn_busy(&self.session, "d1")
        }
        fn posts(&self) -> Vec<(String, String, Vec<String>)> {
            self.spy.0.lock().unwrap().clone()
        }
        /// `deliver_chat_line`, which every test asserts succeeded: on a
        /// refusal it panics with WHY (board #421), so the next flake is
        /// diagnosable — `diagnose` names the target, the panes, the warn
        /// rows (an `undelivered` reason lands there), the readiness files
        /// and the screen.
        fn deliver(&self, line: &str) -> bool {
            if crate::projects::deliver_chat_line(&self.session, "d1", line) {
                return true;
            }
            panic!("rig.deliver refused {line:?}: {}", self.diagnose());
        }
        /// Everything a failed rig step needs to be read later (board #421:
        /// two flakes left only a bare assert behind).
        fn diagnose(&self) -> String {
            // Never panics itself (review P2): a field that cannot be read
            // says `unreadable: …`, so the failure it reports is not lost
            // behind a second panic. Each read is guarded on its own.
            fn field<T: std::fmt::Debug>(f: impl FnOnce() -> Result<T, String>) -> String {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
                    Ok(Ok(v)) => format!("{v:?}"),
                    Ok(Err(e)) => format!("unreadable: {e}"),
                    Err(p) => format!("unreadable: {}", p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()),
                }
            }
            let state = self.ws.join(".tmm/agents/d1/dsh/tmm");
            let file = |n: &'static str| {
                let path = state.join(n);
                field(move || match std::fs::read_to_string(&path) {
                    Ok(t) => Ok(t.trim().to_string()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("-".into()),
                    Err(e) => Err(format!("{}: {e}", path.display())),
                })
            };
            let ws = self.ws.clone();
            let inbox_dir = self.root.join("inbox");
            // `agent_target`'s three inputs, each read on its own (board
            // #421: it answered None on a live, active d1 pane with its ready
            // file present): the project's workspace, the pane detection and
            // the managed-home check.
            let project = crate::projects::project_for_session(&self.session);
            let workspace = project.as_ref().ok().cloned().flatten().map(|p| p.path);
            let inputs = format!(
                "project={} detect={} managed={}",
                field(|| project.clone().map(|p| p.map(|p| p.path))),
                field(|| {
                    let panes = crate::tmux::list_panes(&self.session)?;
                    Ok::<_, String>(
                        panes
                            .iter()
                            .find(|p| p.active && p.window_name == "d1")
                            .map(|p| crate::projects::agents::detect_pane(workspace.as_deref(), p).map(|a| a.backend)),
                    )
                }),
                field(|| Ok::<_, String>(crate::projects::is_managed_in(workspace.as_deref(), "d1"))),
            );
            format!(
                "target={} {inputs} panes={} warns={} ready={} steer-ready={} run={} open={} handoff={} held={} busy={} tasks={} inbox={} screen tail={}",
                field(|| Ok::<_, String>(crate::projects::delivery::agent_target(&self.session, "d1"))),
                field(|| crate::tmux::list_panes(&self.session).map(|ps| ps.iter().map(|p| format!("{}:{} active={} cmd={}", p.window, p.window_name, p.active, p.current_command)).collect::<Vec<_>>())),
                field(|| Ok::<_, String>(crate::projects::telemetry::recent_events(&self.session, 0).into_iter().filter(|e| e.kind == "warn").map(|e| e.text).collect::<Vec<_>>())),
                file("ready"), file("steer-ready"), file("run"),
                field(|| Ok::<_, String>(state.join("open").exists())),
                field(|| Ok::<_, String>(state.join("handoff").exists())),
                field(|| Ok::<_, String>(self.held())),
                field(|| Ok::<_, String>(self.busy())),
                field(move || {
                    let entries = std::fs::read_dir(&ws).map_err(|e| format!("{}: {e}", ws.display()))?;
                    Ok::<_, String>(entries.flatten().filter(|e| e.file_name().to_string_lossy().starts_with("task-")).count())
                }),
                field(move || {
                    inbox_files(&inbox_dir)
                        .iter()
                        .map(|f| {
                            let text = std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()))?;
                            let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", f.display()))?;
                            Ok(v["payload"]["hook_event_name"].as_str().unwrap_or("?").to_string())
                        })
                        .collect::<Result<Vec<_>, String>>()
                }),
                field(|| Ok::<_, String>(self.screen().lines().rev().filter(|l| !l.trim().is_empty()).take(8).map(str::to_string).collect::<Vec<_>>())),
            )
        }
        /// `dsh::tests::wait_for` that says, on a timeout, what the rig
        /// looked like (`diagnose`).
        fn wait_for(&self, what: &str, secs: u64, mut f: impl FnMut() -> bool) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
            while std::time::Instant::now() < deadline {
                if f() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            panic!("timed out waiting for {what}: {}", self.diagnose());
        }
        /// What `hub_agent_interrupt` does, in its order: the turn is ended and
        /// its held lines dropped app-side FIRST, then Escape goes in.
        fn hub_interrupt(&self) {
            crate::projects::delivery::interrupt(&self.session, "d1", || crate::projects::telemetry::record_interrupt(&self.session, "d1"));
            self.hub.end_turn(&self.session, "d1");
            crate::tmux::send_keys(&self.target, "Escape", false).unwrap();
        }
    }

    impl Drop for DshRig {
        fn drop(&mut self) {
            let _ = crate::tmux::run_tmux(&["kill-session", "-t", &self.session]);
            let _ = std::fs::remove_dir_all(&self.ws);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Board #404 P1-A and P1-C, end to end through production code.
    ///
    /// * P1-A: a line delivered while run 1 is cold-starting and one while
    ///   its turn is open are HELD — a feed-read flush in between types
    ///   nothing — then typed after its Stop as ONE combined prompt, one run;
    ///   the reply goes to the first sender.
    /// * the ACTUAL hub interrupt path, while run 2's prompt envelope is still
    ///   in its notifier: the app ends the turn first; a line delivered
    ///   before the shell is back is held (not typed into the raw TTY), and
    ///   typed once it is; the prompt published before the shell's Stop never
    ///   reopens the ended turn.
    #[test]
    fn a_busy_dsh_turn_holds_lines_and_ends_in_order() {
        use crate::backends::dsh::tests::wait_for;
        let Some(rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let l1 = "[tmm chat 2026-10-16 12:00] lead: @d1 first";
        let l2 = "[tmm chat 2026-10-16 12:00] reviewer: @d1 during the cold start";
        let l3 = "[tmm chat 2026-10-16 12:01] lead: @d1 during the turn\nwith a second line";
        assert!(rig.deliver(l1));
        assert!(rig.deliver(l2));
        assert_eq!(rig.held(), 1, "the run owns the TTY from its Enter on");
        crate::projects::delivery::flush_idle(&rig.session);
        assert_eq!(rig.held(), 1, "a feed-read flush before the prompt edge types nothing");
        wait_for("run 1's prompt envelope", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        assert!(rig.busy());
        assert!(rig.deliver(l3));
        assert_eq!(rig.held(), 2);
        crate::projects::delivery::flush_idle(&rig.session);
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert_eq!(rig.tasks(), 1, "nothing was typed into the running turn");
        assert_eq!(rig.task(1), l1);

        rig.mode("prompt", Some("hold"));
        rig.release(1);
        wait_for("run 1's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts(), vec![("d1".to_string(), "done 1".to_string(), vec!["lead".to_string()])]);
        assert_eq!(rig.held(), 0);
        wait_for("run 2", 10, || rig.tasks() == 2);
        assert_eq!(rig.task(2), format!("{l2}\n\n{l3}"), "the held lines, whole, in order, as one prompt");

        // The hub interrupt while run 2's prompt envelope is held 1.5 s in its
        // notifier (Escape is read after it, never inside a publish).
        std::thread::sleep(std::time::Duration::from_millis(300));
        rig.hub_interrupt();
        assert!(!rig.busy(), "the app ended the turn");
        let l4 = "[tmm chat 2026-10-16 12:02] validator: @d1 right after the interrupt";
        assert!(rig.deliver(l4));
        assert_eq!(rig.held(), 1, "the shell is not back yet: held, not typed into the raw TTY");
        wait_for("run 2's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        rig.mode("prompt", None);
        assert_eq!(rig.held(), 0);
        wait_for("run 3, typed once the shell was back", 10, || rig.tasks() == 3);
        assert_eq!(rig.task(3), l4);
        assert_eq!(rig.posts().len(), 1, "an interrupted turn posts nothing");
        wait_for("run 3's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.release(3);
        wait_for("run 3's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 3".to_string(), vec!["validator".to_string()])));
        assert!(!rig.busy());
    }

    /// Board #404 P1-C, the failure outcomes of publication, each consumed
    /// BEFORE and AFTER the late event:
    /// * a prompt publish that FAILS now and is published 4 s later by a child
    ///   that outlived it: the shell reports the prompt itself (the plugin
    ///   only marks a publish that succeeded), the turn ends and replies to
    ///   its sender, and the late copy is dropped (tmm_seq at or below the
    ///   window's mark): the turn stays ended, no second reply;
    /// * a prompt notifier that HANGS past the plugin's 3 s bound: killed, the
    ///   run goes on, the shell reports the prompt;
    /// * a shell Stop whose notifier hangs: killed after 3 s, the prompt is
    ///   usable at once; the Stop is kept and published first by the next
    ///   run, so that turn still ends and answers its sender, in order.
    #[test]
    fn dsh_publication_failures_never_reopen_a_turn_or_hang_the_shell() {
        use crate::backends::dsh::tests::wait_for;
        // The durable log is written (to the throwaway test store): the fence
        // a gateway restart must keep is read back from it.
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(mut rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let events = || {
            crate::projects::telemetry::recent_events(&session, 0)
                .into_iter()
                .filter(|e| e.kind == "prompt" || e.kind == "notif")
                .map(|e| e.kind)
                .collect::<Vec<_>>()
        };

        rig.mode("prompt", Some("late"));
        assert!(rig.deliver("[tmm chat 2026-10-16 12:10] lead: @d1 late prompt"));
        wait_for("run 1", 10, || rig.tasks() == 1);
        rig.release(1);
        wait_for("the shell's prompt and Stop", 10, || rig.inbox_has("Stop"));
        assert_eq!(rig.inbox().iter().map(|p| p["hook_event_name"].as_str().unwrap().to_string()).collect::<Vec<_>>(), ["UserPromptSubmit", "Stop"]);
        rig.hub.consume_inbox();
        assert_eq!(rig.posts(), vec![("d1".to_string(), "done 1".to_string(), vec!["lead".to_string()])]);
        assert!(!rig.busy());
        // P1-C1: the gateway restarts before the late copy lands — the fence
        // is durable (meta, written once the Stop was wholly consumed), not
        // the hub's memory.
        assert!(crate::projects::telemetry::hook_mark(&rig.session, "d1").unwrap() > 0, "written after the envelope's consumption");
        rig.restart_gateway();
        wait_for("the late copy", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        assert!(!rig.busy(), "the late prompt did not reopen the ended turn across a gateway restart");
        assert_eq!(events(), ["prompt", "notif"]);
        rig.mode("prompt", None);

        rig.mode("prompt", Some("hang"));
        assert!(rig.deliver("[tmm chat 2026-10-16 12:11] reviewer: @d1 hanging notifier"));
        wait_for("run 2", 10, || rig.tasks() == 2);
        rig.release(2);
        wait_for("run 2's Stop", 15, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 2".to_string(), vec!["reviewer".to_string()])));
        assert!(!rig.busy());
        rig.mode("prompt", None);

        rig.mode("stop", Some("hang"));
        assert!(rig.deliver("[tmm chat 2026-10-16 12:12] lead: @d1 hanging Stop"));
        wait_for("run 3", 10, || rig.tasks() == 3);
        wait_for("run 3's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        let at = std::time::Instant::now();
        rig.release(3);
        wait_for("the shell's ready file", 8, || rig.ws.join(".tmm/agents/d1/dsh/tmm/ready").is_file());
        assert!(rig.busy(), "run 3's Stop has not been published: its turn has not ended yet");
        // The shell must be READING again within the bound: a line typed now
        // starts its run at once, not when the hung notifier lets go (10 s).
        assert!(rig.deliver("[tmm chat 2026-10-16 12:13] validator: @d1 after it"));
        wait_for("run 4", 15, || rig.tasks() == 4);
        assert!(at.elapsed() < std::time::Duration::from_secs(7), "the hung Stop publish was bounded: {:?}", at.elapsed());
        // The killed Stop is kept (tmm/unsent) and published FIRST by the next
        // run, under its own number: run 3 ends and answers its sender before
        // run 4's prompt opens the next turn.
        wait_for("run 4's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        let kinds: Vec<String> = rig.inbox().iter().map(|p| p["hook_event_name"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["Stop", "UserPromptSubmit"], "run 3's Stop before run 4's prompt");
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 3".to_string(), vec!["lead".to_string()])));
        assert!(rig.busy(), "run 4 is running");
        rig.release(4);
        wait_for("run 4's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 4".to_string(), vec!["validator".to_string()])));
        assert!(!rig.busy());
        assert_eq!(events(), ["prompt", "notif", "prompt", "notif", "prompt", "notif", "prompt", "notif"]);
    }

    /// Board #404 P1-C2: a publication is believed only on a RECEIPT (the
    /// helper's exit 0 once the envelope is in the inbox), and every terminal
    /// fact that was not published is kept and published once, in order:
    /// * the shell's Stop fails at once → kept; the next run's plugin sends
    ///   it before its own prompt: turn 1 ends and answers its sender once;
    /// * that resend fails again → the plugin's own prompt queues BEHIND it
    ///   (a plugin-written unsent record), and the shell, at run 2's end,
    ///   retries both, oldest first, then its Stop;
    /// * the REAL helper cannot write (inbox not writable) → exit 1, kept;
    ///   once it can, the next publisher sends it first.
    ///
    /// Every retried record keeps its own number, checked on the inbox NAME
    /// (`assert_numbered_names`), not only on the order: a record the shell
    /// could not read the number from (the plugin wrote `tmm_seq` last) is
    /// published unsequenced, and that reorders only within one second —
    /// the order alone caught it on some runs (the 66-control run, 20:29).
    #[test]
    fn dsh_publication_receipts_keep_every_terminal_fact() {
        use crate::backends::dsh::tests::wait_for;
        let Some(rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let kinds = || rig.inbox().iter().map(|p| p["hook_event_name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let unsent = rig.ws.join(".tmm/agents/d1/dsh/tmm/unsent");
        let ready_file = rig.ws.join(".tmm/agents/d1/dsh/tmm/ready");

        // Stop fails at once.
        assert!(rig.deliver("[tmm chat 2026-10-16 13:50] lead: @d1 one"));
        wait_for("run 1's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        rig.mode("stop", Some("fail\nfail"));
        rig.release(1);
        wait_for("the failed Stop kept", 10, || std::fs::read_to_string(&unsent).unwrap_or_default().contains("\"Stop\""));
        wait_for("the shell back", 10, || ready_file.is_file());
        assert!(rig.inbox().is_empty() && rig.busy(), "nothing published: turn 1 has not ended");
        // Run 2: its plugin's resend fails too (second `fail`) → its prompt
        // queues behind; the shell retries both at the end, then its Stop.
        assert!(rig.deliver("[tmm chat 2026-10-16 13:51] reviewer: @d1 two"));
        wait_for("run 2", 10, || rig.tasks() == 2);
        wait_for("the plugin's queued prompt", 10, || std::fs::read_to_string(&unsent).unwrap_or_default().contains("UserPromptSubmit"));
        assert!(rig.inbox().is_empty(), "nothing overtook the unsent Stop");
        rig.release(2);
        wait_for("run 2's Stop", 10, || rig.inbox_has("Stop") && kinds().len() == 3);
        rig.assert_numbered_names();
        assert_eq!(kinds(), ["Stop", "UserPromptSubmit", "Stop"], "turn 1's Stop, then turn 2 — the plugin's own record retried by the shell");
        assert!(!unsent.exists());
        rig.hub.consume_inbox();
        assert_eq!(
            rig.posts(),
            vec![
                ("d1".to_string(), "done 1".to_string(), vec!["lead".to_string()]),
                ("d1".to_string(), "done 2".to_string(), vec!["reviewer".to_string()]),
            ],
            "each turn answered once, its own sender"
        );
        assert!(!rig.busy());

        // The real helper cannot write.
        assert!(rig.deliver("[tmm chat 2026-10-16 13:52] validator: @d1 three"));
        wait_for("run 3's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        use std::os::unix::fs::PermissionsExt;
        let inbox = rig.root.join("inbox");
        std::fs::set_permissions(&inbox, std::fs::Permissions::from_mode(0o500)).unwrap();
        rig.release(3);
        wait_for("the unwritten Stop kept", 10, || std::fs::read_to_string(&unsent).unwrap_or_default().contains("\"Stop\""));
        std::fs::set_permissions(&inbox, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(rig.busy());
        wait_for("the shell back", 10, || ready_file.is_file());
        assert!(rig.deliver("[tmm chat 2026-10-16 13:53] lead: @d1 four"));
        wait_for("run 4's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        assert_eq!(kinds(), ["Stop", "UserPromptSubmit"]);
        rig.assert_numbered_names();
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 3".to_string(), vec!["validator".to_string()])));
        rig.release(4);
        wait_for("run 4's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 4".to_string(), vec!["lead".to_string()])));
        assert_eq!(rig.posts().len(), 4, "every turn answered exactly once");
        assert!(!rig.busy());
    }

    /// Board #404 review round 5 (orchestrator 16:00, option 2): consumption
    /// is AT LEAST ONCE, the window every backend has — a numbered envelope's
    /// fence is durable only after its whole consumption, and nothing is
    /// accepted on a guess:
    /// * the gateway dies between the end row and the reply → the Stop is
    ///   still in the inbox; the next gateway posts the reply (never zero);
    /// * it dies after the reply, before the mark → read again: the reply may
    ///   be posted twice, never lost;
    /// * the end fact's INSERT fails → not accepted, kept, retried: the turn
    ///   is ended exactly once in the log;
    /// * a fresh gateway cannot read the window's mark → kept, not consumed
    ///   past an unknown fence; consumed once the mark reads.
    #[test]
    fn dsh_consumption_is_at_least_once_and_never_guesses_a_fence() {
        use crate::backends::dsh::tests::wait_for;
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(mut rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let crash = |point: &'static str| CRASH.with(|c| *c.borrow_mut() = Some(point));
        let session = rig.session.clone();
        let kinds = || crate::projects::telemetry::durable_kinds(&session).into_iter().filter(|k| k == "prompt" || k == "notif").collect::<Vec<_>>();
        let replies = |rig: &DshRig, body: &str| rig.posts().iter().filter(|p| p.1 == body).count();
        let run = |rig: &DshRig, n: usize, line: &str| {
            assert!(rig.deliver(line));
            wait_for("the run's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
            rig.hub.consume_inbox();
            assert!(rig.busy());
            rig.release(n);
            wait_for("the run's Stop", 10, || rig.inbox_has("Stop"));
        };

        // Dies between the end row and the reply.
        run(&rig, 1, "[tmm chat 2026-10-16 16:10] lead: @d1 one");
        crash("after_end");
        rig.hub.consume_inbox();
        assert_eq!(replies(&rig, "done 1"), 0);
        assert!(rig.inbox_has("Stop"), "not accepted: the Stop is still in the inbox");
        rig.restart_gateway();
        rig.hub.consume_inbox();
        assert_eq!(replies(&rig, "done 1"), 1, "the reply is posted, never zero times");
        assert!(rig.inbox().is_empty() && !rig.busy());

        // Dies after the reply, before the mark.
        run(&rig, 2, "[tmm chat 2026-10-16 16:11] reviewer: @d1 two");
        crash("before_mark");
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 2".to_string(), vec!["reviewer".to_string()])));
        assert!(rig.inbox_has("Stop"), "the fence never precedes the whole consumption");
        rig.restart_gateway();
        rig.hub.consume_inbox();
        assert!(replies(&rig, "done 2") >= 1, "at least once");
        assert!(rig.inbox().is_empty() && !rig.busy());

        // The end fact's INSERT fails.
        run(&rig, 3, "[tmm chat 2026-10-16 16:12] validator: @d1 three");
        crate::projects::telemetry::exec_test_sql(&format!(
            "CREATE TEMP TRIGGER end404 BEFORE INSERT ON activity WHEN NEW.session = '{session}' AND NEW.kind = 'notif'
             BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
        ));
        rig.hub.consume_inbox();
        assert!(rig.inbox_has("Stop"), "a turn fact that did not reach the log does not accept its envelope");
        assert_eq!(replies(&rig, "done 3"), 0, "a known failure posts nothing");
        crate::projects::telemetry::exec_test_sql("DROP TRIGGER end404;");
        rig.hub.consume_inbox();
        assert!(rig.inbox().is_empty() && !rig.busy());
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 3".to_string(), vec!["validator".to_string()])));
        assert_eq!(replies(&rig, "done 3"), 1);
        let k = kinds();
        assert_eq!(&k[k.len() - 2..], ["prompt", "notif"], "retried, and turn 3 ended exactly once in the log: {k:?}");

        // A fresh gateway cannot read the mark (a temp table shadows meta).
        rig.restart_gateway();
        assert!(rig.deliver("[tmm chat 2026-10-16 16:13] lead: @d1 four"));
        wait_for("run 4's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        crate::projects::telemetry::exec_test_sql("CREATE TEMP TABLE meta (shadow INTEGER);");
        rig.hub.consume_inbox();
        crate::projects::telemetry::exec_test_sql("DROP TABLE temp.meta;");
        assert!(rig.inbox_has("UserPromptSubmit"), "kept: never consumed past a fence it could not read");
        assert!(!rig.busy());
        rig.hub.consume_inbox();
        assert!(rig.inbox().is_empty() && rig.busy());
        rig.release(4);
        wait_for("run 4's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 4".to_string(), vec!["lead".to_string()])));
        assert!(!rig.busy());
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #404 round 5, the reviewer's combinations (orchestrator 17:30:
    /// a numbered envelope leaves the inbox only once its fact, its effects
    /// and its durable mark all succeeded; the producer's later envelopes
    /// wait behind it).
    ///
    /// A failed fact with repeated polling, a held line, and N+1 queued
    /// behind N: run 1's Stop (N) cannot write its end row. Polls post
    /// nothing, type nothing and change no live state; a feed-read flush
    /// (the shell IS back) types the held line, whose prompt (N+1) then waits
    /// behind N, never accepted past it. Repaired and restarted, both land in
    /// order, each answered once, the prompt with its delivery receipt. Then
    /// a prompt whose row cannot be written keeps the receipt it settled.
    #[test]
    fn a_numbered_window_waits_behind_its_unaccepted_envelope() {
        use crate::backends::dsh::tests::wait_for;
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(mut rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let rows = || crate::projects::telemetry::durable_turn_rows(&session);
        let kinds = || rig.inbox().iter().map(|p| p["hook_event_name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        let sql = crate::projects::telemetry::exec_test_sql;
        let fail = |kind: &str| {
            sql(&format!(
                "CREATE TEMP TRIGGER fail404 BEFORE INSERT ON activity WHEN NEW.session = '{session}' AND NEW.kind = '{kind}'
                 BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
            ))
        };

        assert!(rig.deliver("[tmm chat 2026-10-16 17:40] lead: @d1 one"));
        wait_for("run 1's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        assert!(rig.deliver("[tmm chat 2026-10-16 17:40] reviewer: @d1 two"));
        assert_eq!(rig.held(), 1);
        rig.release(1);
        wait_for("run 1's Stop", 10, || rig.inbox_has("Stop"));
        fail("notif");
        for _ in 0..3 {
            rig.hub.consume_inbox();
        }
        assert!(rig.posts().is_empty(), "no reply while its end fact is unwritten");
        assert_eq!((rig.held(), rig.tasks()), (1, 1), "the hub flushed nothing");
        assert!(rig.busy(), "a fact that did not reach the log changes no live state");
        assert_eq!(rows(), [("prompt".to_string(), "app".to_string())]);
        crate::projects::delivery::flush_idle(&rig.session);
        wait_for("run 2", 10, || rig.tasks() == 2);
        wait_for("run 2's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        for _ in 0..3 {
            rig.hub.consume_inbox();
        }
        assert_eq!(kinds(), ["Stop", "UserPromptSubmit"], "N+1 waits behind N; N is never dropped as old");
        assert!(rig.posts().is_empty());
        assert_eq!(rows().len(), 1, "nothing accepted past N");
        sql("DROP TRIGGER fail404;");
        rig.restart_gateway();
        rig.hub.consume_inbox();
        assert!(rig.inbox().is_empty());
        assert_eq!(rig.posts(), vec![("d1".to_string(), "done 1".to_string(), vec!["lead".to_string()])]);
        assert_eq!(rows().iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["prompt", "notif", "prompt"], "both landed, in order");
        assert_eq!(rows()[2].1, "app", "run 2's prompt took its delivery receipt");
        assert!(rig.busy());
        rig.release(2);
        wait_for("run 2's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 2".to_string(), vec!["reviewer".to_string()])));
        assert_eq!(rig.posts().len(), 2);

        // A prompt whose row cannot be written, while any write back into
        // deliveries fails too (a best-effort restore would lose the receipt
        // there): the settlement and the row are one transaction, so the
        // receipt stays pending through every retry and a restart, and the
        // prompt that finally lands acknowledges it — never local input.
        assert!(rig.deliver("[tmm chat 2026-10-16 17:41] validator: @d1 three"));
        wait_for("run 3's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        let receipts = crate::projects::telemetry::pending_receipts(&session, "d1");
        assert_eq!(receipts.len(), 1);
        fail("prompt");
        sql(&format!("CREATE TEMP TRIGGER nodel404 BEFORE INSERT ON deliveries WHEN NEW.session = '{session}' BEGIN SELECT RAISE(ABORT, 'disk full'); END;"));
        for _ in 0..3 {
            rig.hub.consume_inbox();
            assert_eq!(crate::projects::telemetry::pending_receipts(&session, "d1"), receipts, "the receipt is still pending, its id and message");
        }
        assert!(rig.inbox_has("UserPromptSubmit") && !rig.busy());
        sql("DROP TRIGGER fail404; DROP TRIGGER nodel404;");
        rig.restart_gateway();
        rig.hub.consume_inbox();
        assert!(rig.busy());
        assert!(crate::projects::telemetry::pending_receipts(&session, "d1").is_empty());
        let (via, refs) = crate::projects::telemetry::durable_prompts(&session).pop().unwrap();
        assert_eq!(via, "app", "never converted to local input");
        assert!(refs.contains(&format!("\"id\":{}", receipts[0].0)), "the prompt names the receipt it settled: {refs}");
        assert_eq!(crate::projects::telemetry::durable_prompts(&session).len(), 3, "one row per prompt");
        rig.release(3);
        wait_for("run 3's Stop", 10, || rig.inbox_has("Stop"));
        rig.hub.consume_inbox();
        assert_eq!(rig.posts().last().cloned(), Some(("d1".to_string(), "done 3".to_string(), vec!["validator".to_string()])));
        assert_eq!(rig.posts().len(), 3);
        assert_eq!(rows().iter().filter(|r| r.0 == "notif").count(), 3, "every turn ended exactly once in the log");
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #404 round 6 (orchestrator 21:20, the P2): the room row is an
    /// effect, so a post the room refused is a failed effect. The Stop is
    /// kept, its mark is not written, the held line is not typed (the flush
    /// comes after the post), and the next pass retries the post ALONE —
    /// the end row is written once. When the room takes it: exactly one
    /// post, then the flush, then the mark.
    #[test]
    fn a_room_post_that_failed_is_retried_alone() {
        use crate::backends::dsh::tests::wait_for;
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let notifs = || crate::projects::telemetry::durable_kinds(&session).iter().filter(|k| *k == "notif").count();
        assert!(rig.deliver("[tmm chat 2026-10-16 21:40] lead: @d1 one"));
        wait_for("run 1's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        rig.hub.consume_inbox();
        let mark = crate::projects::telemetry::hook_mark(&session, "d1").unwrap();
        assert!(rig.deliver("[tmm chat 2026-10-16 21:40] reviewer: @d1 two"));
        assert_eq!(rig.held(), 1);
        rig.release(1);
        wait_for("run 1's Stop", 10, || rig.inbox_has("Stop"));
        rig.spy.1.store(3, std::sync::atomic::Ordering::SeqCst);
        for _ in 0..3 {
            rig.hub.consume_inbox();
            assert!(rig.posts().is_empty(), "the room refused it");
            assert!(rig.inbox_has("Stop"), "kept");
            assert_eq!(crate::projects::telemetry::hook_mark(&session, "d1").unwrap(), mark, "no mark before the post");
            assert_eq!((rig.held(), rig.tasks()), (1, 1), "nothing flushed before the post");
            assert_eq!(notifs(), 1, "the end fact is written once");
        }
        rig.hub.consume_inbox();
        assert_eq!(rig.posts(), vec![("d1".to_string(), "done 1".to_string(), vec!["lead".to_string()])], "exactly one post");
        assert!(rig.inbox().is_empty());
        assert!(crate::projects::telemetry::hook_mark(&session, "d1").unwrap() > mark);
        assert_eq!(notifs(), 1);
        wait_for("the held line typed on the flush", 10, || rig.tasks() == 2);
        assert_eq!(rig.held(), 0);
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// The reviewer's combination A: the durable mark cannot be WRITTEN,
    /// the gateway restarts, then an old prompt (a late copy, numbered below
    /// the run's own envelopes) arrives. The envelope whose mark failed stays
    /// in the inbox, its later envelopes wait behind it, and polling retries
    /// the mark alone (no effect repeats); after the restart the old prompt
    /// is never accepted, and once the mark can be written everything lands,
    /// the old prompt dropped.
    #[test]
    fn a_failed_mark_write_keeps_its_envelope_across_a_restart() {
        use crate::backends::dsh::tests::wait_for;
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(mut rig) = DshRig::start() else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let rows = || crate::projects::telemetry::durable_turn_rows(&session);
        let sql = crate::projects::telemetry::exec_test_sql;
        let prompts = |rig: &DshRig| rig.inbox().iter().filter(|p| p["hook_event_name"] == "UserPromptSubmit").count();

        rig.mode("prompt", Some("late"));
        assert!(rig.deliver("[tmm chat 2026-10-16 17:42] lead: @d1 one"));
        wait_for("run 1", 10, || rig.tasks() == 1);
        rig.release(1);
        wait_for("the shell's prompt and Stop", 10, || rig.inbox_has("Stop"));
        sql(&format!(
            "CREATE TEMP TRIGGER mark404i BEFORE INSERT ON meta WHEN NEW.key LIKE 'hook_seq:{session}:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;
             CREATE TEMP TRIGGER mark404u BEFORE UPDATE ON meta WHEN NEW.key LIKE 'hook_seq:{session}:%' BEGIN SELECT RAISE(ABORT, 'disk full'); END;"
        ));
        for _ in 0..3 {
            rig.hub.consume_inbox();
        }
        assert_eq!(rig.inbox().len(), 2, "the prompt whose mark failed is kept; the Stop waits behind it");
        assert_eq!(rows().len(), 1, "polling retried the mark alone");
        assert!(rig.posts().is_empty());
        rig.restart_gateway();
        rig.hub.consume_inbox();
        wait_for("the late copy", 10, || prompts(&rig) == 2);
        for _ in 0..3 {
            rig.hub.consume_inbox();
        }
        assert_eq!(prompts(&rig), 2, "the old prompt is never accepted while the fence is unwritten");
        assert!(rig.posts().is_empty());
        sql("DROP TRIGGER mark404i; DROP TRIGGER mark404u;");
        rig.hub.consume_inbox();
        assert!(rig.inbox().is_empty(), "repaired: kept envelopes land, the old prompt is dropped");
        assert_eq!(rig.posts(), vec![("d1".to_string(), "done 1".to_string(), vec!["lead".to_string()])]);
        assert!(!rig.busy());
        rig.restart_gateway();
        rig.hub.consume_inbox();
        assert!(!rig.busy());
        assert_eq!(rows().last().map(|r| r.0.clone()), Some("notif".to_string()), "nothing reopened the turn");
        rig.mode("prompt", None);
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #421: a refused rig delivery says WHY. Its window gone, the
    /// rig's `deliver` panics naming the missing target and what tmux
    /// listed, never a bare `assertion failed`.
    #[test]
    fn a_refused_rig_delivery_says_why() {
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        crate::tmux::run_tmux(&["new-window", "-d", "-t", &format!("={}:", rig.session), "-n", "spare", "sleep 60"]).unwrap();
        crate::tmux::run_tmux(&["kill-window", "-t", &rig.target]).unwrap();
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rig.deliver("[tmm chat 2026-10-18 03:00] lead: @d1 into nothing")));
        let msg = refused.expect_err("a delivery to a gone window is refused");
        let msg = msg.downcast_ref::<String>().cloned().unwrap_or_default();
        assert!(msg.starts_with("rig.deliver refused") && msg.contains("target=None") && msg.contains("spare"), "{msg}");
    }

    /// Review P2 on fac0989b: `diagnose` never panics itself. A corrupt
    /// inbox file reads as `inbox=unreadable: <path>: <error>` while every
    /// other field is still there.
    #[test]
    fn the_rig_diagnosis_survives_what_it_cannot_read() {
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let dir = rig.root.join("inbox");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("0-00000000000000000001-1.json"), "{ not json").unwrap();
        let d = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rig.diagnose())).expect("diagnose never panics");
        assert!(d.contains("inbox=unreadable: ") && d.contains("0-00000000000000000001-1.json"), "{d}");
        assert!(d.contains("target=Some(") && d.contains("tasks=0") && d.contains("ready="), "the other fields are still read: {d}");
    }

    /// Board #410, steer mode end to end — the generated plugin under the
    /// real pane, production delivery, the real helper and inbox, a fake
    /// dsh loop that claims steered input at its next step:
    /// * a line delivered while run 1's root turn is open is TYPED (the
    ///   reader's claim is the one readiness predicate), taken by
    ///   `Agent.steer` as a real UserMessage, echoed as a prompt; its sender
    ///   joins the turn's reply edge, its receipt is settled;
    /// * the next one is held while the previous steer has not echoed
    ///   (one in flight), then typed by the prompt-settled flush;
    /// * the Stop answers ALL three senders once, in one run (one dsh
    ///   process), and the reply reflects the steered lines;
    /// * in a second run, a line delivered during the cold start (before the
    ///   reader claims the pane) is HELD, then steered once the run's own
    ///   prompt settled; a multi-line message arrives as ONE line (bracketed
    ///   paste).
    #[test]
    fn steered_lines_join_the_running_turn_and_every_sender_gets_the_reply() {
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}: {}", rig.diagnose());
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        assert!(rig.deliver("[tmm chat 2026-10-17 05:00] lead: @d1 one"));
        consume_until("run 1's prompt", &|| rig.busy());
        rig.wait_for("the steer reader's claim", 10, || rig.steer_ready());
        assert!(rig.deliver("[tmm chat 2026-10-17 05:01] reviewer: @d1 steer two"));
        assert!(rig.deliver("[tmm chat 2026-10-17 05:01] validator: @d1 steer three"));
        consume_until("both steers", &|| rig.steers(1).len() == 2 && crate::projects::telemetry::pending_receipts(&session, "d1").is_empty() && rig.held() == 0);
        assert_eq!(rig.steers(1), ["[tmm chat 2026-10-17 05:01] reviewer: @d1 steer two", "[tmm chat 2026-10-17 05:01] validator: @d1 steer three"]);
        assert_eq!(rig.tasks(), 1, "one run: nothing became a new dsh process");
        rig.release(1);
        consume_until("run 1's reply", &|| !rig.posts().is_empty());
        let (agent, body, to) = rig.posts()[0].clone();
        assert_eq!(agent, "d1");
        assert!(body.starts_with("done 1 +") && body.contains("steer two") && body.contains("steer three"), "{body}");
        assert_eq!(to, ["lead", "reviewer", "validator"], "every sender of the turn, once");
        let prompts = crate::projects::telemetry::durable_prompts(&session);
        assert_eq!(prompts.len(), 3);
        assert!(prompts.iter().all(|(via, _)| via == "app"), "each echo settled its own receipt: {prompts:?}");
        consume_until("the shell back", &|| rig.ready() && !rig.busy());

        // Run 2: a line during the cold start (the fake waits for
        // `started-2` before its turn opens) is held, then steered.
        std::fs::write(rig.ws.join("coldstart"), "").unwrap();
        assert!(rig.deliver("[tmm chat 2026-10-17 05:02] lead: @d1 two"));
        rig.wait_for("run 2", 10, || rig.tasks() == 2);
        assert!(!rig.steer_ready(), "no claim before the root turn opens");
        assert!(rig.deliver("[tmm chat 2026-10-17 05:02] reviewer: @d1 a long one\nwith a second line"));
        assert_eq!(rig.held(), 1, "nothing is typed into a TTY nobody reads");
        rig.hub.consume_inbox();
        assert_eq!(rig.held(), 1);
        std::fs::write(rig.ws.join("started-2"), "").unwrap();
        consume_until("the held line steered", &|| rig.steers(2).len() == 1);
        assert_eq!(rig.steers(2), ["[tmm chat 2026-10-17 05:02] reviewer: @d1 a long one\nwith a second line"], "one line, newline kept");
        rig.release(2);
        consume_until("run 2's reply", &|| rig.posts().len() == 2);
        assert_eq!(rig.posts()[1].2, ["lead", "reviewer"]);
        assert_eq!(rig.tasks(), 2);
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #410 P1-C, the hand-off between the run and the shell, in the
    /// gap between the root turn's end and the process's exit (the fake
    /// lingers there until `exit-N`), with the real plugin and shell:
    /// * two complete lines and a draft typed in the gap: the shell sends run
    ///   1's Stop FIRST, then runs each line, one per prompt, through its own
    ///   accept-line (a canary `$(touch …)` reaches dsh's argv, nothing
    ///   runs), then gives the draft back to the buffer;
    /// * a delivery that passed the gate and typed as the turn ended (its
    ///   receipt recorded, its text landing after the end): it becomes the
    ///   next run, and its receipt settles on that run's prompt;
    /// * half a paste typed in the gap, then the exit: unclean, shown as not
    ///   sent, nothing runs;
    /// * a reader killed with SIGKILL after a line in the gap: its record is
    ///   not final, shown as not sent, nothing runs.
    #[test]
    fn a_line_typed_after_the_turn_ended_runs_next_only_from_a_clean_hand_off() {
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}: {}", rig.diagnose());
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        let canary = rig.ws.join("canary-410");
        std::fs::write(rig.ws.join("linger"), "").unwrap();
        // Two complete lines and a draft in the gap.
        assert!(rig.deliver("[tmm chat 2026-10-17 05:10] lead: @d1 one"));
        consume_until("run 1's prompt", &|| rig.busy());
        rig.release(1);
        rig.wait_for("run 1's turn end", 10, || rig.ws.join("ended-1").is_file());
        assert!(!rig.steer_ready(), "no claim after the root turn ended");
        rig.type_keys(&format!("late $(touch {})", canary.display()), true);
        rig.type_keys("late two", true);
        rig.type_keys("a draft", false);
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(rig.ws.join("exit-1"), "").unwrap();
        rig.wait_for("run 2 from the hand-off", 10, || rig.tasks() == 2);
        assert_eq!(rig.task(2), format!("late $(touch {})", canary.display()), "byte for byte, through the accept-line quoting");
        assert!(!canary.exists(), "nothing ran as shell code");
        rig.wait_for("run 2's prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        let kinds: Vec<String> = rig.inbox().iter().map(|p| p["hook_event_name"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, ["Stop", "UserPromptSubmit"], "run 1's Stop before the handed-off run's prompt");
        consume_until("run 1's reply", &|| rig.posts().len() == 1);
        rig.release(2);
        std::fs::write(rig.ws.join("exit-2"), "").unwrap();
        rig.wait_for("run 3 from the hand-off", 10, || rig.tasks() == 3);
        assert_eq!(rig.task(3), "late two");
        rig.release(3);
        std::fs::write(rig.ws.join("exit-3"), "").unwrap();
        consume_until("the shell back with the draft", &|| rig.ready() && rig.screen().lines().any(|l| l.contains("dsh › a draft")));
        assert_eq!(rig.tasks(), 3, "the draft is not run");
        consume_until("runs 2 and 3 answered", &|| rig.posts().len() == 3);
        crate::tmux::send_keys(&rig.target, "C-u", false).unwrap();

        // A delivery that passed the gate as the turn ended.
        assert!(rig.deliver("[tmm chat 2026-10-17 05:11] lead: @d1 four"));
        consume_until("run 4's prompt", &|| rig.busy() && rig.tasks() == 4);
        rig.release(4);
        rig.wait_for("run 4's turn end", 10, || rig.ws.join("ended-4").is_file());
        let raced = "[tmm chat 2026-10-17 05:11] reviewer: @d1 raced the end";
        crate::projects::telemetry::record_delivery(&session, "d1", raced, "");
        crate::tmux::send_command(&rig.target, raced).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(rig.ws.join("exit-4"), "").unwrap();
        rig.wait_for("run 5 from the hand-off", 10, || rig.tasks() == 5);
        assert_eq!(rig.task(5), raced);
        consume_until("its receipt settled by run 5's prompt", &|| crate::projects::telemetry::pending_receipts(&session, "d1").is_empty() && rig.busy());
        assert_eq!(crate::projects::telemetry::durable_prompts(&session).last().unwrap().0, "app");
        rig.release(5);
        std::fs::write(rig.ws.join("exit-5"), "").unwrap();
        consume_until("run 5 answered", &|| rig.posts().len() == 5 && rig.ready());

        // Half a paste in the gap: unclean.
        assert!(rig.deliver("[tmm chat 2026-10-17 05:12] lead: @d1 six"));
        consume_until("run 6's prompt", &|| rig.busy() && rig.tasks() == 6);
        rig.release(6);
        rig.wait_for("run 6's turn end", 10, || rig.ws.join("ended-6").is_file());
        rig.type_keys("\x1b[200~half a paste", false);
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(rig.ws.join("exit-6"), "").unwrap();
        consume_until("the shell back", &|| rig.ready() && rig.posts().len() == 6);
        assert!(rig.screen().contains("not sent: half a paste"), "{}", rig.screen());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(rig.tasks(), 6, "nothing of an unclean hand-off runs");

        // SIGKILL after a line in the gap: not final.
        assert!(rig.deliver("[tmm chat 2026-10-17 05:13] lead: @d1 seven"));
        consume_until("run 7's prompt", &|| rig.busy() && rig.tasks() == 7);
        rig.release(7);
        rig.wait_for("run 7's turn end", 10, || rig.ws.join("ended-7").is_file());
        rig.type_keys("killed with its reader", true);
        std::thread::sleep(std::time::Duration::from_millis(300));
        let pid: i32 = std::fs::read_to_string(rig.ws.join("ended-7")).unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, libc::SIGKILL) }, 0);
        consume_until("the shell back", &|| rig.ready() && !rig.busy());
        assert!(rig.screen().contains("not sent: killed with its reader"), "{}", rig.screen());
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(rig.tasks(), 7);
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #410, the interrupt in steer mode through the ACTUAL hub path
    /// (the turn ended app-side first, then Escape): the reader decodes the
    /// lone ESC (after Node's escape-code timeout, ~500 ms) and ends the run
    /// through dsh's SIGINT exit; its claim is gone at once; a draft typed
    /// before it comes back into the shell's buffer from a clean, final
    /// hand-off, and nothing runs. And a lone `-` is refused by the shell: it
    /// would make dsh read its task from the pane the reader owns.
    #[test]
    fn a_steer_run_is_interrupted_by_escape_and_a_lone_hyphen_is_refused() {
        use crate::backends::dsh::tests::wait_for;
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        assert!(rig.deliver("[tmm chat 2026-10-17 05:20] lead: @d1 long task"));
        consume_until("run 1's prompt", &|| rig.busy());
        wait_for("the claim", 10, || rig.steer_ready());
        // Bytes the decoder holds without a key (half a character here; a
        // lone ESC that may be the hub's interrupt is the same case) withdraw
        // the claim at once, until they are decoded — and the decoded
        // character is a draft, which admits nothing until the line is empty.
        crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "-H", "e4"]).unwrap();
        wait_for("the claim withdrawn while a byte is undecoded", 5, || !rig.steer_ready());
        assert!(rig.busy(), "the run goes on");
        crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "-H", "b8", "ad"]).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(!rig.steer_ready(), "the decoded character is a draft in the line: it admits nothing");
        crate::tmux::send_keys(&rig.target, "BSpace", false).unwrap();
        wait_for("the claim back with the line empty", 5, || rig.steer_ready());
        rig.type_keys("a draft", false);
        std::thread::sleep(std::time::Duration::from_millis(200));
        let at = std::time::Instant::now();
        rig.hub_interrupt();
        assert!(!rig.busy(), "the hub ended the turn app-side first");
        wait_for("the claim gone", 5, || !rig.steer_ready());
        consume_until("the shell back", &|| rig.ready());
        assert!(at.elapsed() < std::time::Duration::from_secs(3), "{:?}", at.elapsed());
        consume_until("the run's Stop consumed", &|| rig.inbox().is_empty());
        consume_until("the draft back in the buffer", &|| rig.screen().lines().any(|l| l.contains("dsh › a draft")));
        assert_eq!(rig.tasks(), 1, "nothing ran");
        assert!(rig.posts().is_empty(), "an interrupted turn posts nothing");
        crate::tmux::send_keys(&rig.target, "C-u", false).unwrap();
        // A lone `-`.
        rig.type_keys("-", true);
        wait_for("the refusal", 5, || rig.screen().contains("not sent: a lone '-' is not a message"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(rig.tasks(), 1, "no run for a lone '-'");
        assert!(rig.ready());
    }

    /// Board #410 review P1-A, through the real plugin → hand-off → zsh
    /// path: a NUL in a line refuses it whole — in the turn (never steered)
    /// and in the gap (never split into two lines); a handed-off line and a
    /// given-back draft are MESSAGES, so a leading `!` is never the shell
    /// escape and shell metacharacters reach dsh's argv as text; a draft
    /// with a NUL is shown as not sent and nothing runs. No canary, no extra
    /// run.
    #[test]
    fn a_nul_or_a_bang_in_a_typed_line_never_runs_as_shell_code() {
        use crate::backends::dsh::tests::wait_for;
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        let canary = |k: usize| rig.ws.join(format!("canary-{k}"));
        let nul = || crate::tmux::run_tmux(&["send-keys", "-t", &rig.target, "-H", "00"]).unwrap();
        std::fs::write(rig.ws.join("linger"), "").unwrap();
        assert!(rig.deliver("[tmm chat 2026-10-17 08:00] lead: @d1 one"));
        consume_until("run 1's prompt", &|| rig.busy());
        wait_for("the claim", 10, || rig.steer_ready());
        // In the turn: `safe<NUL>!touch …` pasted.
        rig.type_keys("\x1b[200~safe", false);
        nul();
        rig.type_keys(&format!("!touch {}\x1b[201~", canary(1).display()), true);
        wait_for("the refusal", 5, || rig.screen().contains("not sent: unsupported control byte"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(rig.steers(1).is_empty(), "no half of it is steered");
        rig.release(1);
        wait_for("run 1's turn end", 10, || rig.ws.join("ended-1").is_file());
        // In the gap: the same paste, a `!` line, metacharacters, a `!` draft.
        rig.type_keys("\x1b[200~safe", false);
        nul();
        rig.type_keys(&format!("!touch {}\x1b[201~", canary(2).display()), true);
        rig.type_keys(&format!("!touch {}", canary(3).display()), true);
        let meta = format!("x; touch {c4} && `touch {c5}` | touch {c5} > {c5}", c4 = canary(4).display(), c5 = canary(5).display());
        rig.type_keys(&meta, true);
        rig.type_keys(&format!("!touch {}", canary(6).display()), false);
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(rig.ws.join("exit-1"), "").unwrap();
        wait_for("run 2 from the hand-off", 10, || rig.tasks() == 2);
        assert_eq!(rig.task(2), format!("!touch {}", canary(3).display()), "a handed-off `!` line is a message");
        rig.release(2);
        std::fs::write(rig.ws.join("exit-2"), "").unwrap();
        wait_for("run 3 from the hand-off", 10, || rig.tasks() == 3);
        assert_eq!(rig.task(3), meta, "metacharacters are text");
        rig.release(3);
        std::fs::write(rig.ws.join("exit-3"), "").unwrap();
        wait_for("the draft back", 10, || rig.screen().lines().any(|l| l.contains("dsh › !touch")));
        crate::tmux::send_keys(&rig.target, "Enter", false).unwrap();
        wait_for("the draft as run 4", 10, || rig.tasks() == 4);
        assert_eq!(rig.task(4), format!("!touch {}", canary(6).display()), "a given-back `!` draft is a message");
        wait_for("run 4's claim", 10, || rig.steer_ready());
        rig.release(4);
        wait_for("run 4's turn end", 10, || rig.ws.join("ended-4").is_file());
        // A draft with a NUL in the gap: shown, nothing runs.
        rig.type_keys("\x1b[200~d", false);
        nul();
        rig.type_keys(&format!("!touch {}\x1b[201~", canary(7).display()), false);
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(rig.ws.join("exit-4"), "").unwrap();
        wait_for("the shell back", 10, || rig.screen().contains("not sent: d␀!touch"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(rig.tasks(), 4, "no extra run");
        for k in 1..=7 {
            assert!(!canary(k).exists(), "canary {k} ran as shell code");
        }
    }

    /// Board #410 review P1-B: the pane is admitted only from a complete
    /// admission state.
    /// * A person's half paste in the turn (no byte pending, the paste
    ///   open) withdraws the claim: a hub send is HELD, never typed inside
    ///   it; once the person's line is entered and steered, its prompt's
    ///   flush types the held line, which is steered on its own.
    /// * A draft given back after the turn: the shell is not ready while it
    ///   is in the buffer — not while the Stop's publication is held, not at
    ///   the Stop's flush, not at a later flush. Submitted, it is its own run
    ///   and the held line steers into that run, never joined to the draft.
    #[test]
    fn a_half_paste_or_a_given_back_draft_keeps_a_delivery_out() {
        use crate::backends::dsh::tests::wait_for;
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        let shell_ready = || rig.ws.join(".tmm/agents/d1/dsh/tmm/ready").is_file();
        std::fs::write(rig.ws.join("linger"), "").unwrap();
        assert!(rig.deliver("[tmm chat 2026-10-17 08:10] lead: @d1 one"));
        consume_until("run 1's prompt", &|| rig.busy());
        wait_for("the claim", 10, || rig.steer_ready());
        rig.type_keys("\x1b[200~half", false);
        wait_for("the claim withdrawn while the paste is open", 5, || !rig.steer_ready());
        let hub = "[tmm chat 2026-10-17 08:11] reviewer: @d1 from the hub";
        assert!(rig.deliver(hub));
        assert_eq!(rig.held(), 1, "held, never typed into the open paste");
        rig.hub.consume_inbox();
        crate::projects::delivery::flush(&session, "d1");
        assert_eq!(rig.held(), 1);
        rig.type_keys(" paste\x1b[201~", true);
        consume_until("both steered", &|| rig.steers(1).len() == 2 && rig.held() == 0);
        assert_eq!(rig.steers(1), ["half paste", hub], "each line on its own");
        rig.release(1);
        wait_for("run 1's turn end", 10, || rig.ws.join("ended-1").is_file());
        // A draft in the gap, a delivery held behind it, the Stop held.
        rig.type_keys("my draft", false);
        let two = "[tmm chat 2026-10-17 08:12] validator: @d1 held two";
        assert!(rig.deliver(two));
        assert_eq!(rig.held(), 1);
        rig.mode("stop", Some("hold"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        std::fs::write(rig.ws.join("exit-1"), "").unwrap();
        // The shell is inside the Stop's publication once it has closed the
        // run (`open` gone); ZLE paints the buffer only after that handler.
        wait_for("the Stop being published", 10, || !rig.ws.join(".tmm/agents/d1/dsh/tmm/open").exists());
        assert!(!rig.inbox_has("Stop"), "the Stop's publication is still held");
        crate::projects::delivery::flush(&session, "d1");
        assert_eq!(rig.held(), 1, "no release while the Stop is held");
        consume_until("run 1's reply (the Stop's flush)", &|| rig.posts().len() == 1);
        wait_for("the draft back", 10, || rig.screen().lines().any(|l| l.contains("dsh › my draft")));
        crate::projects::delivery::flush(&session, "d1");
        assert_eq!(rig.held(), 1, "no release while the draft is in the buffer");
        assert!(!shell_ready(), "a buffer with a draft is not ready");
        assert_eq!(rig.tasks(), 1);
        crate::tmux::send_keys(&rig.target, "Enter", false).unwrap();
        consume_until("the held line steered into the draft's run", &|| rig.steers(2).len() == 1 && rig.held() == 0);
        assert_eq!(rig.task(2), "my draft", "the draft alone");
        assert_eq!(rig.steers(2), [two]);
        rig.release(2);
        std::fs::write(rig.ws.join("exit-2"), "").unwrap();
        consume_until("the shell back and ready", &|| rig.posts().len() == 2 && shell_ready());
        assert_eq!(rig.tasks(), 2);
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #410 review P1-C: the run's first prompt is published only once
    /// its reader is whole (dsh awaits the plugin's `apply`, which awaits the
    /// message factory). With the factory held: no prompt, no claim, a hub
    /// line held; once it loads, the claim is on file when the prompt is in
    /// the inbox, and consuming that prompt alone — no feed read, no new
    /// delivery, no turn end — steers the held line into this run, whose
    /// reply then answers both senders.
    #[test]
    fn a_line_held_through_a_slow_factory_steers_the_run_once_its_reader_is_whole() {
        use crate::backends::dsh::tests::wait_for;
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        std::fs::write(rig.ws.join("factory-hold"), "").unwrap();
        assert!(rig.deliver("[tmm chat 2026-10-17 08:20] lead: @d1 one"));
        wait_for("run 1", 10, || rig.tasks() == 1);
        let two = "[tmm chat 2026-10-17 08:20] reviewer: @d1 two";
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(rig.deliver(two));
        assert_eq!(rig.held(), 1);
        rig.hub.consume_inbox();
        assert!(!rig.inbox_has("UserPromptSubmit") && !rig.busy(), "no prompt before the reader is whole");
        assert!(!rig.steer_ready() && !rig.ws.join("applied-1").exists());
        assert_eq!(rig.held(), 1);
        std::fs::write(rig.ws.join("factory-go"), "").unwrap();
        wait_for("the first prompt", 10, || rig.inbox_has("UserPromptSubmit"));
        assert!(rig.steer_ready(), "the claim is on file before the prompt is consumed");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while rig.steers(1).is_empty() {
            assert!(std::time::Instant::now() < deadline, "the held line was not steered by the prompt's own flush");
            rig.hub.consume_inbox();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(rig.steers(1), [two]);
        rig.release(1);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while rig.posts().is_empty() {
            assert!(std::time::Instant::now() < deadline, "no reply");
            rig.hub.consume_inbox();
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert_eq!(rig.posts()[0].2, ["lead", "reviewer"]);
        assert_eq!(rig.tasks(), 1);
    }

    /// Board #410 review round 2, P1-B residual: a person's draft in the
    /// running turn — typed, or a paste closed before its Enter — admits no
    /// delivery. The hub line is held (through a consume and a flush), the
    /// person's Enter steers their exact line, and that prompt's own flush
    /// steers the hub line on its own, with its receipt and its requester.
    #[test]
    fn a_persons_draft_in_the_turn_keeps_a_delivery_out_until_it_is_entered() {
        use crate::backends::dsh::tests::wait_for;
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(true));
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let session = rig.session.clone();
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        assert!(rig.deliver("[tmm chat 2026-10-17 10:00] lead: @d1 one"));
        consume_until("run 1's prompt", &|| rig.busy());
        wait_for("the claim", 10, || rig.steer_ready());
        let hubs = ["[tmm chat 2026-10-17 10:01] reviewer: @d1 after a typed draft", "[tmm chat 2026-10-17 10:02] validator: @d1 after a closed paste"];
        for (draft, hub) in [("human draft", hubs[0]), ("\x1b[200~pasted\x1b[201~", hubs[1])] {
            rig.type_keys(draft, false);
            wait_for("the claim withdrawn by the draft", 5, || !rig.steer_ready());
            assert!(rig.deliver(hub));
            assert_eq!(rig.held(), 1, "held, never joined to the draft");
            rig.hub.consume_inbox();
            crate::projects::delivery::flush(&session, "d1");
            assert_eq!(rig.held(), 1);
            let n = rig.steers(1).len();
            crate::tmux::send_keys(&rig.target, "Enter", false).unwrap();
            consume_until("the draft, then the hub line, steered", &|| rig.steers(1).len() == n + 2 && rig.held() == 0);
        }
        assert_eq!(rig.steers(1), ["human draft", hubs[0], "pasted", hubs[1]], "each line exactly, on its own");
        consume_until("every receipt settled", &|| crate::projects::telemetry::pending_receipts(&session, "d1").is_empty());
        rig.release(1);
        consume_until("run 1's reply", &|| !rig.posts().is_empty());
        assert_eq!(rig.posts()[0].2, ["lead", "human", "reviewer", "validator"], "the person's own lines join as the human");
        assert_eq!(rig.tasks(), 1);
        crate::projects::telemetry::PERSIST_IN_TEST.with(|p| p.set(false));
    }

    /// Board #410 review round 2, P1-C: the interrupt keys keep their
    /// meaning inside an unfinished paste. The ACTUAL hub interrupt
    /// (Escape, decoded as a lone ESC) and ^C, each with a paste open: the
    /// claim is withdrawn, the dsh process ends, no reply is posted, and the
    /// unclean draft is shown as not sent, never run.
    #[test]
    fn an_interrupt_ends_a_steer_run_from_inside_an_open_paste() {
        use crate::backends::dsh::tests::wait_for;
        let Some(rig) = DshRig::start_in("steer") else {
            eprintln!("skipped: no zsh, node or tmux server");
            return;
        };
        let consume_until = |what: &str, f: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !f() {
                assert!(std::time::Instant::now() < deadline, "timed out waiting for {what}");
                rig.hub.consume_inbox();
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        };
        let claim = rig.ws.join(".tmm/agents/d1/dsh/tmm/steer-ready");
        for (n, text, hub) in [(1usize, "half by escape", true), (2, "half by ctrl-c", false)] {
            assert!(rig.deliver(&format!("[tmm chat 2026-10-17 10:1{n}] lead: @d1 run {n}")));
            consume_until("the run's prompt", &|| rig.busy() && rig.tasks() == n);
            wait_for("the claim", 10, || rig.steer_ready());
            let pid: i32 = std::fs::read_to_string(&claim).unwrap().split(' ').next().unwrap().parse().unwrap();
            rig.type_keys(&format!("\x1b[200~{text}"), false);
            wait_for("the claim withdrawn by the open paste", 5, || !rig.steer_ready());
            if hub {
                rig.hub_interrupt();
                assert!(!rig.busy(), "the hub ended the turn app-side");
            } else {
                crate::tmux::send_keys(&rig.target, "C-c", false).unwrap();
            }
            wait_for("the dsh process gone", 5, || unsafe { libc::kill(pid, 0) } != 0);
            consume_until("the shell back with the draft not sent", &|| rig.screen().contains(&format!("not sent: {text}")) && rig.inbox().is_empty() && !rig.busy());
            assert!(!rig.steer_ready());
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert_eq!(rig.tasks(), 2, "no draft ran");
        assert!(rig.posts().is_empty(), "an aborted run posts nothing");
        assert!(rig.steers(1).is_empty() && rig.steers(2).is_empty());
    }

    /// Board #404 P1-C2, the helper contract itself: with `TMM_HOOK_SEQ` its
    /// exit status is a receipt (1 when the envelope did not reach the
    /// inbox); without one it stays fail-soft (0 always), as every other
    /// backend's hooks rely on.
    #[test]
    fn the_helpers_exit_is_a_receipt_only_for_a_numbered_producer() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("tmm-receipt-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.ensure_helper().unwrap();
        let run = |seq: Option<&str>, pane: Option<&str>| {
            let mut cmd = std::process::Command::new("/bin/sh");
            cmd.arg("-c").arg(hub.helper_command("dsh")).env_remove("TMM_HOOK_SEQ").env_remove("TMUX_PANE");
            if let Some(seq) = seq {
                cmd.env("TMM_HOOK_SEQ", seq);
            }
            if let Some(pane) = pane {
                cmd.env("TMUX_PANE", pane);
            }
            let mut child = cmd.stdin(std::process::Stdio::piped()).spawn().unwrap();
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"{\"hook_event_name\":\"Stop\"}\n").unwrap();
            child.wait().unwrap().code()
        };
        assert_eq!(run(Some("5"), Some("%7")), Some(0), "published");
        assert_eq!(run(Some("6"), None), Some(1), "no pane: nothing published, and it says so");
        assert_eq!(run(None, None), Some(0), "an unnumbered caller is never failed");
        std::fs::set_permissions(root.join("inbox"), std::fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(run(Some("7"), Some("%7")), Some(1), "the write failed: no receipt");
        assert_eq!(run(None, Some("%7")), Some(0), "fail-soft for every other backend");
        std::fs::set_permissions(root.join("inbox"), std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Board #404 P1-C / P2-E: a producer's `TMM_HOOK_SEQ` names the inbox
    /// file (digits only, zero-padded); without one the name keeps its old
    /// `<secs>-<pid>` shape. One order for a mixed directory: the second,
    /// then the sequence (missing = 0), then arrival.
    #[test]
    fn the_helper_names_a_producers_sequence_and_the_inbox_honours_it() {
        let root = std::env::temp_dir().join(format!("tmm-seq-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.ensure_helper().unwrap();
        let run = |seq: Option<&str>| {
            let mut cmd = std::process::Command::new("/bin/sh");
            cmd.arg("-c").arg(hub.helper_command("dsh")).env("TMUX_PANE", "%7").env_remove("TMM_HOOK_SEQ");
            if let Some(seq) = seq {
                cmd.env("TMM_HOOK_SEQ", seq);
            }
            let mut child = cmd.stdin(std::process::Stdio::piped()).spawn().unwrap();
            use std::io::Write;
            child.stdin.take().unwrap().write_all(b"{\"hook_event_name\":\"Stop\"}\n").unwrap();
            child.wait().unwrap();
        };
        run(Some("1792123456789012"));
        run(Some("12; rm -rf x"));
        run(None);
        let names: Vec<String> = std::fs::read_dir(root.join("inbox")).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".json"))
            .collect();
        let shapes: Vec<usize> = { let mut v: Vec<usize> = names.iter().map(|n| n.split('-').count()).collect(); v.sort(); v };
        assert_eq!(shapes, [2, 2, 3], "only a valid sequence changes the name: {names:?}");
        assert!(names.iter().any(|n| n.split('-').nth(1) == Some("00001792123456789012")), "{names:?}");

        // A mixed directory within one second: two unsequenced names (an older
        // helper's, or another backend's) and two sequenced ones whose pids
        // run against their sequence.
        let dir = root.join("order");
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["100-900.json", "100-00000000000000000002-1.json", "100-100.json", "100-00000000000000000001-9.json", "99-00000000000000000009-5.json"] {
            std::fs::write(dir.join(name), "{}").unwrap();
        }
        let order: Vec<String> = inbox_files(&dir).iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(
            order,
            ["99-00000000000000000009-5.json", "100-100.json", "100-900.json", "100-00000000000000000001-9.json", "100-00000000000000000002-1.json"],
            "the second; then the sequence, none = 0 (an unsequenced pair keeps today's order); then the name"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reply_targets_are_addressed_once_and_replies_do_not_loop() {
        assert_eq!(
            reply_targets(
                "[tmm chat 2026-09-08 08:00] lead: @dev fix it\n\
                 [tmm chat 2026-09-08 08:01] reviewer: @dev check it\n\
                 [tmm chat 2026-09-08 08:02] lead: @dev one more thing"
            ),
            vec!["lead", "reviewer"]
        );
        assert_eq!(reply_targets("[tmm chat 2026-09-08 08:03] human: @dev ship it"), vec!["human"], "recorded to the human (#289)");
        assert!(reply_targets("[tmm chat 2026-09-08 08:04] lead: [reply] looks good").is_empty());
        assert!(reply_targets("[tmm chat 2026-09-08 08:05] worker: [done] old completion").is_empty());
    }

    /// Board #257: one combined prompt of held lines replies to each distinct
    /// requester once; `[reply]` lines in it add nobody.
    #[test]
    fn a_combined_prompt_replies_once_to_each_requester() {
        let combined = [
            "[tmm chat 2026-09-28 03:00] lead: @dev one",
            "[tmm chat 2026-09-28 03:01] validator: @dev two\nwith a second line",
            "[tmm chat 2026-09-28 03:02] lead: @dev three",
            "[tmm chat 2026-09-28 03:03] builder: [reply] fyi",
        ]
        .join("\n\n");
        assert_eq!(reply_targets(&combined), vec!["lead", "validator"]);
    }

    /// #257 review (validator 04:48, orchestrator 04:49 item 4): a combined
    /// prompt of held lines whose FIRST line carries a multi-KB team context
    /// puts the second requester past the activity text's 1024-char cut.
    /// Held → one combined prompt → submitted → server restart before Stop
    /// → Stop: BOTH requesters get the reply, once each, because the row
    /// stores its requesters parsed from the full prompt. Through the real
    /// database (PERSIST_IN_TEST), the path a restart actually reads.
    #[test]
    fn a_restart_after_a_long_combined_prompt_still_replies_to_every_requester() {
        use crate::projects::telemetry::{record_prompt, PERSIST_IN_TEST};
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("combined-restart-{}", uuid::Uuid::new_v4());
        let context = format!("[tmm team context — background]\n{}\n[/tmm team context]", "room row ".repeat(400));
        let combined = [
            format!("[tmm chat 2026-09-28 04:40] lead: @v first ask\n\n{context}"),
            "[tmm chat 2026-09-28 04:41] validator: @v second ask".to_string(),
        ]
        .join("\n\n");
        assert!(combined.find("validator:").unwrap() > 1024, "the second requester sits past the text cut");
        let root = std::env::temp_dir().join(format!("tmm-combined-{}", uuid::Uuid::new_v4()));
        let hub = AgentNotificationHub::load_at(root.clone());
        hub.start_turn(&session, "v", &combined);
        record_prompt(&session, "v", &combined);
        // validator 05:04 / orchestrator 05:05: the row carries its senders
        // the moment record_prompt returns — one INSERT, no second write.
        let rows = crate::projects::telemetry::test_prompt_rows(&session, "v");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].1.as_deref(), Some(r#"["lead","validator"]"#), "text and requesters in the same row: {rows:?}");
        let mut texts = Vec::new();
        crate::projects::telemetry::recent_events(&session, 0).into_iter().filter(|e| e.kind == "prompt").for_each(|e| texts.push(e.text));
        assert!(!texts[0].contains("validator:"), "the stored display text really is cut before the second sender");

        // Restart before the Stop: a fresh hub, and a fresh turn record.
        crate::projects::telemetry::forget_process_state(&session);
        let restarted = AgentNotificationHub::load_at(root.clone());
        let got = restarted.take_reply_targets(&session, "v");
        PERSIST_IN_TEST.with(|p| p.set(false));
        assert_eq!(got, vec!["lead".to_string(), "validator".to_string()], "both, once each, in order");
        let _ = std::fs::remove_dir_all(root);
    }

    /// validator 05:04: a failed write can never leave a durable prompt row
    /// without its senders. The one INSERT carries both, so an injected
    /// failure (TEMP trigger) leaves NO row at all — never a truncated text
    /// with NULL requesters — and nothing reads a half-written edge.
    #[test]
    fn a_failed_prompt_write_leaves_no_row_without_its_requesters() {
        use crate::projects::telemetry::{record_prompt, test_exec_sql, test_prompt_rows, PERSIST_IN_TEST};
        crate::projects::tests::use_test_store();
        PERSIST_IN_TEST.with(|p| p.set(true));
        let session = format!("prompt-fault-{}", uuid::Uuid::new_v4());
        test_exec_sql(&format!(
            "CREATE TEMP TRIGGER prompt_fault BEFORE INSERT ON activity WHEN NEW.session = '{session}' AND NEW.kind = 'prompt'
             BEGIN SELECT RAISE(ABORT, 'injected'); END;"
        ));
        record_prompt(&session, "v", "[tmm chat 2026-09-28 05:05] lead: @v ask");
        test_exec_sql("DROP TRIGGER prompt_fault;");
        let after_fault = test_prompt_rows(&session, "v");
        record_prompt(&session, "v", "[tmm chat 2026-09-28 05:06] validator: @v ask");
        let after = test_prompt_rows(&session, "v");
        PERSIST_IN_TEST.with(|p| p.set(false));
        assert!(after_fault.is_empty(), "the failed INSERT wrote nothing: {after_fault:?}");
        assert!(after.iter().all(|(_, r)| r.is_some()), "every durable prompt row has its requesters: {after:?}");
        assert_eq!(after.len(), 1);
    }

    #[test]
    fn a_restart_recovers_the_reply_edge_from_prompt_activity() {
        let session = format!("reply-restart-{}", uuid::Uuid::new_v4());
        crate::projects::telemetry::record_prompt(
            &session,
            "w2",
            "[tmm chat 2026-09-08 08:06] lead: @worker finish it",
        );
        let root = std::env::temp_dir().join(format!("tmm-reply-edge-{}", uuid::Uuid::new_v4()));
        let restarted = AgentNotificationHub::load_at(root.clone());
        assert_eq!(restarted.take_reply_targets(&session, "w2"), vec!["lead"]);
        let _ = std::fs::remove_dir_all(root);
    }

    /// #256 (temp/stall-analysis.md, #248 20:47–20:51): orchestrator asked
    /// validator for the final review, builder's `[reply]` landed in the SAME
    /// turn and replaced the edge, and the SHIP reached nobody for 3h27m.
    /// A later input in an open turn joins the edge; a closed turn (stop or
    /// interrupt) never leaks its requesters into the next one; a restart
    /// mid-turn rebuilds the edge from every input the turn recorded.
    #[test]
    fn a_later_input_in_the_same_turn_joins_the_reply_edge() {
        use crate::projects::telemetry::{record_interrupt, record_notification, record_prompt};
        crate::projects::tests::use_test_store();
        let session = format!("reply-join-{}", uuid::Uuid::new_v4());
        // Removed on drop, also when an assertion fails (board #269: failed
        // runs had left seven of these behind).
        let scratch = crate::tmux::Scratch::new("reply-join");
        let root = std::path::PathBuf::from(scratch.path());
        let hub = AgentNotificationHub::load_at(root.clone());
        // The live order: start_turn, then the prompt is recorded.
        let input = |hub: &AgentNotificationHub, line: &str| {
            hub.start_turn(&session, "v", line);
            record_prompt(&session, "v", line);
        };

        input(&hub, "[tmm chat 2026-09-27 20:47] orchestrator: @validator final review of #248 please");
        input(&hub, "[tmm chat 2026-09-27 20:47] builder: [reply] ready for final review");
        input(&hub, "[tmm chat 2026-09-27 20:48] lead: @validator also check the docs");
        input(&hub, "[tmm chat 2026-09-27 20:48] orchestrator: @validator and the tests");
        input(&hub, "[tmm chat 2026-09-27 20:49] human: @validator thanks");
        assert_eq!(
            hub.take_reply_targets(&session, "v"),
            vec!["orchestrator", "lead", "human"],
            "every requester once, in order; [reply] adds nobody; the human is recorded (#289)"
        );
        record_notification(&session, "v", "completed");

        // The next turn opens fresh: nobody from the closed turn rides along.
        input(&hub, "[tmm chat 2026-09-27 20:52] builder: [reply] thanks");
        assert!(hub.take_reply_targets(&session, "v").is_empty());
        record_notification(&session, "v", "completed");

        // An interrupt closes the turn too (it takes no edge: no reply).
        input(&hub, "[tmm chat 2026-09-27 21:00] orchestrator: @validator start X");
        record_interrupt(&session, "v");
        input(&hub, "[tmm chat 2026-09-27 21:01] builder: [reply] fyi");
        assert!(hub.take_reply_targets(&session, "v").is_empty(), "the interrupted turn's requester does not leak");
        record_notification(&session, "v", "completed");

        // A restart mid-turn: the new process's first input joins the inputs
        // the turn already recorded instead of starting over.
        input(&hub, "[tmm chat 2026-09-27 22:00] orchestrator: @validator review #255");
        let restarted = AgentNotificationHub::load_at(root.clone());
        input(&restarted, "[tmm chat 2026-09-27 22:01] builder: [reply] pushed a fix");
        assert_eq!(restarted.take_reply_targets(&session, "v"), vec!["orchestrator"]);
        record_notification(&session, "v", "completed");

        // Validator's review repro: the requester is the FIRST of more than
        // 64 inputs in one open turn, and the server restarts right before
        // the Stop. Recovery reads the whole open turn, not a newest-N page.
        // 71 inputs: past the old 64 bound, inside the test ring's 120 events
        // (the durable SQL read is pinned in store/activity.rs).
        input(&hub, "[tmm chat 2026-09-27 23:00] orchestrator: @validator request");
        for i in 0..35 {
            input(&hub, &format!("[tmm chat 2026-09-27 23:01] builder: [reply] update {i}"));
            input(&hub, &format!("[tmm chat 2026-09-27 23:01] human: @validator note {i}"));
        }
        let restarted = AgentNotificationHub::load_at(root.clone());
        // Recovery agrees with the live edge: the human's notes count (#289).
        assert_eq!(restarted.take_reply_targets(&session, "v"), vec!["orchestrator", "human"], "recovered at the stop");
        let restarted = AgentNotificationHub::load_at(root.clone());
        input(&restarted, "[tmm chat 2026-09-27 23:02] lead: @validator one more");
        assert_eq!(restarted.take_reply_targets(&session, "v"), vec!["orchestrator", "human", "lead"], "recovered at the next input");
        record_notification(&session, "v", "completed");

        // Tool-only turns (validator, orchestrator 03:07): the turn is OPEN
        // by derive_from, but it carries no requester yet, so the next input
        // starts the edge — even after an interrupt, whose memo nobody took.
        use crate::projects::telemetry::{derive, record_tool, turn_busy};
        input(&hub, "[tmm chat 2026-09-28 00:00] orchestrator: @validator start Y");
        record_interrupt(&session, "v");
        record_tool(&session, "v", "memory", "capture");
        input(&hub, "[tmm chat 2026-09-28 00:01] builder: [reply] fyi");
        assert!(hub.take_reply_targets(&session, "v").is_empty(), "no leak through a tool-only stretch");
        record_notification(&session, "v", "completed");
        record_tool(&session, "v", "memory", "capture");
        input(&hub, "[tmm chat 2026-09-28 00:02] lead: @validator go");
        assert_eq!(hub.take_reply_targets(&session, "v"), vec!["lead"]);
        record_notification(&session, "v", "completed");

        // Orchestrator's regression: completed → tool (same second; a
        // tool-only turn, derive = running) → orchestrator input → [reply] →
        // Stop ⇒ the reply reaches orchestrator. `turn_busy` IS derive.
        record_tool(&session, "v", "memory", "capture");
        assert_eq!(derive(&session, "v", 0).state, "running");
        assert!(turn_busy(&session, "v"));
        input(&hub, "[tmm chat 2026-09-28 00:02] orchestrator: @validator review");
        input(&hub, "[tmm chat 2026-09-28 00:02] builder: [reply] fixed");
        assert_eq!(hub.take_reply_targets(&session, "v"), vec!["orchestrator"]);
        record_notification(&session, "v", "completed");
        // ... and completed → a new input with no later tool: idle, fresh.
        assert!(!turn_busy(&session, "v"));
        input(&hub, "[tmm chat 2026-09-28 00:03] lead: @validator next");
        assert_eq!(hub.take_reply_targets(&session, "v"), vec!["lead"]);
        record_notification(&session, "v", "completed");
        // A restart in a tool-only turn: whatever the recovered record says,
        // turn_busy is derive's verdict, and the first input starts the edge
        // (the durable replay itself is pinned in telemetry's #249 tests).
        record_tool(&session, "v", "memory", "capture");
        crate::projects::telemetry::forget_process_state(&session);
        assert_eq!(turn_busy(&session, "v"), matches!(derive(&session, "v", 0).state.as_str(), "running" | "waiting"));
        let restarted = AgentNotificationHub::load_at(root.clone());
        input(&restarted, "[tmm chat 2026-09-28 00:04] orchestrator: @validator after restart");
        assert_eq!(restarted.take_reply_targets(&session, "v"), vec!["orchestrator"]);
        record_notification(&session, "v", "completed");

        // The cap counts distinct requesters and keeps the earliest — live
        // and after a restart alike.
        input(&hub, "[tmm chat 2026-09-28 00:03] orchestrator: @validator first");
        for i in 0..40 {
            input(&hub, &format!("[tmm chat 2026-09-28 00:04] a{i}: @validator ask {i}"));
        }
        let live = hub.state.lock().unwrap().reply_targets.get(&window_key(&session, "v")).map(|m| m.1.clone()).unwrap();
        assert_eq!(live.len(), MAX_REPLY_TARGETS);
        assert_eq!(live[0], "orchestrator");
        let restarted = AgentNotificationHub::load_at(root.clone());
        assert_eq!(restarted.take_reply_targets(&session, "v"), live, "recovery folds to the same capped edge");
    }
}
