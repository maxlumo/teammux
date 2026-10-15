use crate::{config, tmux};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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
    fn post_final(&self, session: &str, agent: &str, body: &str, reply_to: &[String]);
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
        for path in inbox_files(&self.root.join("inbox")) {
            if let Err(error) = self.consume_file(&path) {
                eprintln!(
                    "⚠️  agent notification ignored ({}): {}",
                    path.display(),
                    error
                );
            }
            let _ = std::fs::remove_file(path);
        }
    }

    fn consume_file(&self, path: &Path) -> Result<(), String> {
        let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if metadata.len() > MAX_INBOX_BYTES {
            return Err("payload too large".into());
        }
        let envelope: InboxEnvelope =
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("invalid envelope: {e}"))?;
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
        let timestamp = unix_seconds();
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
            // placeholder) is written WITH the end, in one step: a separate
            // "and it was empty" write could land on a different end.
            crate::projects::telemetry::record_notification_with(&session, &window, &normalized.kind, timestamp, normalized.empty);
            // A turn edge (stop, ask) means the CLI just repainted its footer —
            // the context-usage number is at its freshest right here.
            crate::projects::vitals::sniff_window_soon(&session, &window);
        }

        // A completion that said nothing may leave the agent in the middle of its
        // work; `stalls` answers it once (see there).
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if normalized.kind == "completed" && normalized.empty {
            crate::projects::stalls::on_empty_end(&session, &window);
        }

        // Stop hook final: record the answer and deliver it to every sender
        // whose addressed request this turn carried:
        //   1. Only managed windows (constraint 3): a .tmm/agents/<name> dir
        //      must exist, so direct or adopted agents never auto-post.
        //   2. There must be a reply body worth posting.
        //   3. `[reply]` inputs create no reverse edge, so delivery is one hop.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if normalized.kind == "completed" {
            self.maybe_auto_post(&session, &window, &normalized, &reply_to);
        }
        // The turn's end edge is the first flush trigger (board #257): lines
        // held for this busy queue-mode agent are typed now, as one prompt.
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        if matches!(normalized.kind.as_str(), "completed" | "failed") {
            crate::projects::delivery::flush(&session, &window);
        }

        // Remember the agent's own conversation id (even across duplicate
        // events): this map is how a restored window resumes the exact
        // conversation instead of starting a blank one. The unread-inbox UI
        // that used to be recorded here retired 2026-09-01 (owner: "原来我用的
        // 感觉不是很好用") — the project room's auto-post + read cursor and the
        // derived status dots are the one notification language now.
        let _ = pane;
        if let Some(id) = normalized.agent_session_id {
            self.state
                .lock()
                .unwrap()
                .sessions
                .insert(window_key(&session, &window), id);
        }
        Ok(())
    }

    /// Record a managed agent's final reply and deliver it along this turn's
    /// reply edge.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn maybe_auto_post(
        &self,
        session: &str,
        window: &str,
        normalized: &Normalized,
        reply_to: &[String],
    ) {
        // Nothing to post — skip.
        let reply = normalized.full_reply.as_deref().unwrap_or_default();
        if reply.is_empty() {
            return;
        }
        // Constraint 3: managed-only gate. `projects::managed_home` is the ONE
        // definition of "an agent this app created" — shared with hub_agents'
        // participant list and with delivery, so the three cannot drift apart.
        // The resolved window IS the name now (board #120), so the old
        // index → list_panes → name round-trip (which lost the post when a
        // rename landed between hook fire and consume) is gone.
        let window_name = window;
        if crate::projects::managed_home(session, window_name).is_none() {
            return;
        }
        // Truncate at the chat-path budget.
        let body = truncate(reply, MAX_REPLY_CHARS);
        let poster = self.state.lock().unwrap().poster.clone();
        if let Some(p) = poster {
            p.post_final(session, &window_name, &body, reply_to);
        }
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
backend="${{1:-}}"
case "$backend" in {backends}) ;; *) exit 0 ;; esac
pane="${{TMUX_PANE:-}}"
case "$pane" in %*[!0-9]*|%|"") exit 0 ;; esac
inbox={inbox}
mkdir -p "$inbox" || exit 0
tmp=$(mktemp "$inbox/.tmp.XXXXXX") || exit 0
trap 'rm -f "$tmp"' EXIT
payload=
IFS= read -r payload || true
[ -n "$payload" ] || exit 0
printf '{{"backend":"%s","pane_id":"%s","payload":%s}}\n' "$backend" "$pane" "$payload" > "$tmp" || exit 0
mv "$tmp" "$inbox/$(date +%s)-$$.json" || exit 0
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
    files.sort_by_key(|p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let secs = name.split('-').next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
        (secs, name)
    });
    files
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
    /// The turn ended and its whole reply is the CLI's own placeholder for "no
    /// assistant message" (board #355): a completion that said nothing. Read by
    /// the desktop consumer only; the phone never consumes the inbox.
    #[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
    empty: bool,
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
    let empty = full_reply.as_deref().is_some_and(|r| backend.is_empty_reply(r));
    Ok(Normalized {
        kind: kind.into(),
        agent_session_id: string_field(payload, &["session_id", "sessionId"]),
        full_reply,
        empty,
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
fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
        let stop = |backend: &str, text: &str| {
            let event = if backend == "claude" { "Stop" } else { "stop" };
            normalize(&envelope(backend, json!({"hook_event_name":event,"assistant_response":text}))).unwrap()
        };
        assert!(stop("kiro", placeholder).empty, "the CLI's stand-in is an empty turn");
        assert!(stop("kiro", &format!("  {placeholder}")).empty);
        assert!(!stop("kiro", "Done: the gate is green.").empty);
        assert!(!stop("kiro", &format!("I saw this line in the log: {placeholder}")).empty, "a real reply that quotes it is a reply");
        assert!(!stop("kiro", &format!("{placeholder} Then the result: green.")).empty, "the placeholder followed by real text is a reply");
        assert!(!stop("kiro", "(No assistant response was recorded for the preceding turn").empty, "half the sentence is not the CLI's text");
        assert!(!stop("claude", placeholder).empty, "only kiro-cli writes it");
        assert!(!normalize(&envelope("kiro", json!({"hook_event_name":"stop"}))).unwrap().empty, "no reply at all is not the placeholder");
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
            fn post_final(&self, session: &str, agent: &str, body: &str, reply_to: &[String]) {
                self.0.lock().unwrap().push((
                    session.into(), agent.into(), body.into(), reply_to.to_vec()
                ));
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
            fn post_final(&self, _s: &str, _a: &str, _b: &str, reply_to: &[String]) {
                self.0.lock().unwrap().push(reply_to.to_vec());
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
        assert!(!crate::projects::telemetry::arm_nudge(&session, &win), "the consumer already armed the one timer this empty end is owed");

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
            fn post_final(&self, _session: &str, agent: &str, body: &str, reply_to: &[String]) {
                self.0.lock().unwrap().push((agent.into(), body.into(), reply_to.to_vec()));
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
        record_notification(&session, "v", "completed", unix_seconds());

        // The next turn opens fresh: nobody from the closed turn rides along.
        input(&hub, "[tmm chat 2026-09-27 20:52] builder: [reply] thanks");
        assert!(hub.take_reply_targets(&session, "v").is_empty());
        record_notification(&session, "v", "completed", unix_seconds());

        // An interrupt closes the turn too (it takes no edge: no reply).
        input(&hub, "[tmm chat 2026-09-27 21:00] orchestrator: @validator start X");
        record_interrupt(&session, "v");
        input(&hub, "[tmm chat 2026-09-27 21:01] builder: [reply] fyi");
        assert!(hub.take_reply_targets(&session, "v").is_empty(), "the interrupted turn's requester does not leak");
        record_notification(&session, "v", "completed", unix_seconds());

        // A restart mid-turn: the new process's first input joins the inputs
        // the turn already recorded instead of starting over.
        input(&hub, "[tmm chat 2026-09-27 22:00] orchestrator: @validator review #255");
        let restarted = AgentNotificationHub::load_at(root.clone());
        input(&restarted, "[tmm chat 2026-09-27 22:01] builder: [reply] pushed a fix");
        assert_eq!(restarted.take_reply_targets(&session, "v"), vec!["orchestrator"]);
        record_notification(&session, "v", "completed", unix_seconds());

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
        record_notification(&session, "v", "completed", unix_seconds());

        // Tool-only turns (validator, orchestrator 03:07): the turn is OPEN
        // by derive_from, but it carries no requester yet, so the next input
        // starts the edge — even after an interrupt, whose memo nobody took.
        use crate::projects::telemetry::{derive, record_tool, turn_busy};
        input(&hub, "[tmm chat 2026-09-28 00:00] orchestrator: @validator start Y");
        record_interrupt(&session, "v");
        record_tool(&session, "v", "memory", "capture");
        input(&hub, "[tmm chat 2026-09-28 00:01] builder: [reply] fyi");
        assert!(hub.take_reply_targets(&session, "v").is_empty(), "no leak through a tool-only stretch");
        record_notification(&session, "v", "completed", unix_seconds());
        record_tool(&session, "v", "memory", "capture");
        input(&hub, "[tmm chat 2026-09-28 00:02] lead: @validator go");
        assert_eq!(hub.take_reply_targets(&session, "v"), vec!["lead"]);
        record_notification(&session, "v", "completed", unix_seconds());

        // Orchestrator's regression: completed → tool (same second; a
        // tool-only turn, derive = running) → orchestrator input → [reply] →
        // Stop ⇒ the reply reaches orchestrator. `turn_busy` IS derive.
        record_tool(&session, "v", "memory", "capture");
        assert_eq!(derive(&session, "v", 0).state, "running");
        assert!(turn_busy(&session, "v"));
        input(&hub, "[tmm chat 2026-09-28 00:02] orchestrator: @validator review");
        input(&hub, "[tmm chat 2026-09-28 00:02] builder: [reply] fixed");
        assert_eq!(hub.take_reply_targets(&session, "v"), vec!["orchestrator"]);
        record_notification(&session, "v", "completed", unix_seconds());
        // ... and completed → a new input with no later tool: idle, fresh.
        assert!(!turn_busy(&session, "v"));
        input(&hub, "[tmm chat 2026-09-28 00:03] lead: @validator next");
        assert_eq!(hub.take_reply_targets(&session, "v"), vec!["lead"]);
        record_notification(&session, "v", "completed", unix_seconds());
        // A restart in a tool-only turn: whatever the recovered record says,
        // turn_busy is derive's verdict, and the first input starts the edge
        // (the durable replay itself is pinned in telemetry's #249 tests).
        record_tool(&session, "v", "memory", "capture");
        crate::projects::telemetry::forget_process_state(&session);
        assert_eq!(turn_busy(&session, "v"), matches!(derive(&session, "v", 0).state.as_str(), "running" | "waiting"));
        let restarted = AgentNotificationHub::load_at(root.clone());
        input(&restarted, "[tmm chat 2026-09-28 00:04] orchestrator: @validator after restart");
        assert_eq!(restarted.take_reply_targets(&session, "v"), vec!["orchestrator"]);
        record_notification(&session, "v", "completed", unix_seconds());

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
