//! Per-backend knowledge for the agents-v2 spawn path (projects/spawn.rs).
//!
//! `shared` holds the backend-neutral launch helpers that used to live in
//! `team::backends_shared` (board #100): per-backend MCP rendering, the
//! launch-script pattern (the 2KB tty lesson) and startup-prompt confirmation.
//! Moved here so the spawn path owns its dependencies and the desktop Team
//! system can be deleted whole (docs/todo.md §A).

pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod dsh;
pub(crate) mod grok;
pub(crate) mod kimi;
pub(crate) mod kiro;
pub(crate) mod omp;
pub(crate) mod shared;

/// How a completed turn ended, as far as its reply tells (board #355).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndQuality {
    /// The reply is real text: the agent said something.
    Said,
    /// The reply is the CLI's own placeholder: the turn said nothing.
    Empty,
    /// No usable reply (none, blank, unreadable): nothing is known either way.
    Unknown,
}

/// The closed set of agent CLIs this app can spawn (board #101/#127). An enum
/// rather than a trait object on purpose: the set is closed, and every
/// per-concern method below is an EXHAUSTIVE match with one-line arms into
/// the backend's own file — so adding a backend is adding a variant, and the
/// compiler's error list is exactly the file the new backend must fill
/// (2026-09-07: adding omp missed registry_save; this makes that class of
/// omission a compile error). The `backend` field stays a STRING at rest
/// (state.db, recipes, the wire); `parse` runs once at each boundary
/// (tenet 8: validate at the door).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Kiro,
    Claude,
    Codex,
    Grok,
    Omp,
    Kimi,
    Dsh,
}

/// Where a spawn's first prompt goes — see `Backend::first_prompt`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstPrompt {
    /// Appended to the launch command as one quoted positional argument.
    LaunchLine,
    /// Typed into the pane by the startup waiter once the CLI's ready
    /// markers are on screen; the launch line carries no prompt.
    Typed,
}

impl Backend {
    /// Every backend, in the one canonical order (seeds, pickers, caps).
    pub const ALL: [Backend; 7] =
        [Backend::Kiro, Backend::Claude, Backend::Codex, Backend::Grok, Backend::Omp, Backend::Kimi, Backend::Dsh];

    /// `ALL` as the string names — kept literally beside it so a `const` can
    /// borrow it (`SPAWNABLE_BACKENDS`); the roundtrip test pins the two in
    /// sync.
    pub const NAMES: [&'static str; 7] = ["kiro", "claude", "codex", "grok", "omp", "kimi", "dsh"];

    /// The documented fallback where an absent backend means kiro (the
    /// registry dispatch's old inline `unwrap_or("kiro")`).
    pub const DEFAULT: Backend = Backend::Kiro;

    pub fn parse(name: &str) -> Option<Backend> {
        match name.trim() {
            "kiro" => Some(Backend::Kiro),
            "claude" => Some(Backend::Claude),
            "codex" => Some(Backend::Codex),
            "grok" => Some(Backend::Grok),
            "omp" => Some(Backend::Omp),
            "kimi" => Some(Backend::Kimi),
            "dsh" => Some(Backend::Dsh),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Backend::Kiro => "kiro",
            Backend::Claude => "claude",
            Backend::Codex => "codex",
            Backend::Grok => "grok",
            Backend::Omp => "omp",
            Backend::Kimi => "kimi",
            Backend::Dsh => "dsh",
        }
    }

    /// One backend as the CLIENT sees it (`backends_list`, board #130): the
    /// name, its avatar and colour-token RESOURCE NAMES, and the effort
    /// levels its editor offers. The two resource names are DERIVED from the
    /// name by convention (`/assets/<name>.svg`, `--backend-<name>`), never
    /// declared per backend — the test below pins that both files exist for
    /// every variant, so adding a backend without its avatar or token is a
    /// failing test, not a lettered fallback on the phone. Efforts ride along
    /// because the client kept a hand mirror of them and it had already
    /// drifted (omp's list existed here and nowhere on the client).
    pub fn describe(self) -> serde_json::Value {
        serde_json::json!({
            "name": self.name(),
            "icon": format!("/assets/{}.svg", self.name()),
            "color": format!("--backend-{}", self.name()),
            "efforts": self.effort_values(),
            "input_modes": self.switches_input_mode(),
            "default_input_mode": self.default_input_mode(),
            "input_mode_toggle": self.live_input_toggle().is_some(),
        })
    }

    /// `describe` over ALL, in the canonical order — the first entry is the
    /// client's default (`DEFAULT` is `ALL[0]`, pinned below).
    pub fn list_json() -> serde_json::Value {
        serde_json::Value::Array(Backend::ALL.iter().map(|b| b.describe()).collect())
    }

    /// The reasoning-effort levels this backend's CLI accepts — a FIXED enum
    /// per backend, measured per CLI, never guessed (each list's provenance
    /// is on the backend file).
    pub fn effort_values(self) -> &'static [&'static str] {
        match self {
            Backend::Kiro => kiro::effort_values(),
            Backend::Claude => claude::effort_values(),
            Backend::Codex => codex::effort_values(),
            Backend::Grok => grok::effort_values(),
            Backend::Omp => omp::effort_values(),
            Backend::Kimi => kimi::effort_values(),
            Backend::Dsh => dsh::effort_values(),
        }
    }

    /// Whether this backend's definition may choose `queue` | `steer` for a
    /// line typed while it is busy (board #245). True only where BOTH halves
    /// were measured on this host: the switch is a documented config door,
    /// and in queue mode the queued line comes back through the prompt hook
    /// as its own turn (ack + reply edge). Each backend file says why it is or
    /// is not one. A backend that cannot switch runs `queue` semantics or its
    /// CLI's own behaviour, and the editor does not offer the choice.
    /// The prompt-hook echo of the slash command `name args` on this CLI, or
    /// `None` when it reports none we can match (board #264). One shape per
    /// backend, declared in its own file; `hub_command` records a receipt row
    /// only when there is one.
    pub fn command_echo(self, name: &str, args: &str) -> Option<String> {
        match self {
            Backend::Kiro => kiro::command_echo(name, args),
            Backend::Claude => claude::command_echo(name, args),
            Backend::Codex => codex::command_echo(name, args),
            Backend::Grok => grok::command_echo(name, args),
            Backend::Omp => omp::command_echo(name, args),
            Backend::Kimi => kimi::command_echo(name, args),
            Backend::Dsh => dsh::command_echo(name, args),
        }
    }

    /// Does this reassembled pane paint block show one of THIS backend's own
    /// transient model errors (auto-continue, `projects/recovery.rs`)? Each
    /// backend owns its measured shapes in its own file (board #280): one
    /// CLI's text inside another's pane is never a hit. `false` where none
    /// was measured.
    pub fn transient_error(self, glued: &str, spaced: &str) -> bool {
        self.transient_shape(glued, spaced).is_some()
    }

    /// Which of this backend's transient-error shapes the block is, by the
    /// name its `recovery_shapes` row carries (board #362), or `None`.
    pub fn transient_shape(self, glued: &str, spaced: &str) -> Option<&'static str> {
        match self {
            Backend::Kiro => kiro::transient_shape(glued, spaced),
            Backend::Claude => claude::transient_shape(glued, spaced),
            // Capture first (board #362 d): no shape is guessed for a CLI
            // whose error paint was never captured on this host.
            _ => None,
        }
    }

    /// Every recovery shape this backend knows (transient ones and the ones
    /// that need a person), each with the CLI version it was MEASURED on
    /// (board #362): a detector tied to a CLI's painted text rots silently
    /// when the CLI repaints (#346, #361), so the version it was last seen on
    /// is part of the shape. Empty where none was measured.
    pub fn recovery_shapes(self) -> &'static [Measured] {
        match self {
            Backend::Kiro => kiro::RECOVERY_SHAPES,
            Backend::Claude => claude::RECOVERY_SHAPES,
            Backend::Codex => codex::RECOVERY_SHAPES,
            _ => &[],
        }
    }

    /// The NEWEST paint on this backend's screen, when it is one of its
    /// errors that only a person can clear (board #362 c): its shape (also
    /// the agent's status detail: `auth_expired`, `conversation_blocked`) and
    /// the block, de-wrapped. Never continued. Each backend reads its own
    /// screen grammar in its own file; `None` where none was measured.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn person_paint(self, pane: &str) -> Option<(&'static str, String)> {
        match self {
            Backend::Kiro => kiro::person_paint(pane),
            Backend::Codex => codex::person_paint(pane),
            _ => None,
        }
    }

    /// The NEWEST block on this backend's screen by its own measured
    /// grammar, `(glued, spaced)`, or `None` when it cannot tell (no grammar
    /// measured, a turn running, a half-drawn screen). Board #362: a capped
    /// recovery incident ends a turn only while its error is this block.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn newest_block(self, pane: &str) -> Option<(String, String)> {
        match self {
            Backend::Kiro => kiro::newest_block(pane),
            Backend::Codex => codex::newest_block(pane),
            _ => None,
        }
    }

    /// The program whose `--version` names the CLI version a pane of this
    /// backend runs, for the recovery drift guard; `None` where recovery
    /// has no shape to compare (board #362).
    pub fn version_program(self) -> Option<&'static str> {
        match self {
            Backend::Kiro => Some(kiro::VERSION_PROGRAM),
            Backend::Claude => Some(claude::VERSION_PROGRAM),
            Backend::Codex => Some(codex::VERSION_PROGRAM),
            _ => None,
        }
    }

    /// The named key that switches queue/steer in a RUNNING session (#271),
    /// where one was measured; `None` = the mode is fixed at launch (codex's
    /// keymap is a launch-line override) or does not exist.
    pub fn live_input_toggle(self) -> Option<&'static str> {
        match self {
            Backend::Kiro => kiro::LIVE_INPUT_TOGGLE,
            _ => None,
        }
    }

    /// The mode the pane RUNS now, from its screen (#271); `None` = the screen
    /// does not say (or the backend cannot switch live), and the launch
    /// recipe's start mode stands.
    pub fn live_input_mode(self, pane: &str) -> Option<&'static str> {
        match self {
            Backend::Kiro => kiro::live_input_mode(pane),
            _ => None,
        }
    }

    pub fn switches_input_mode(self) -> bool {
        match self {
            Backend::Kiro => kiro::SWITCHES_INPUT_MODE,
            Backend::Claude => claude::SWITCHES_INPUT_MODE,
            Backend::Codex => codex::SWITCHES_INPUT_MODE,
            Backend::Grok => grok::SWITCHES_INPUT_MODE,
            Backend::Omp => omp::SWITCHES_INPUT_MODE,
            Backend::Kimi => kimi::SWITCHES_INPUT_MODE,
            Backend::Dsh => dsh::SWITCHES_INPUT_MODE,
        }
    }

    /// Is a line typed while this CLI's turn runs LOST (board #404)? dsh's
    /// run owns the TTY in raw mode until it exits, so text typed into it
    /// never reaches a turn. Such a backend has no queue|steer choice, yet
    /// delivery still holds for it — a fixed queue the gate honours
    /// (`delivery::input_mode_seen`), never released early by the overdue
    /// rule (which assumes a CLI that queues typed text itself), and a line
    /// typed at rest that has not echoed yet already counts as the open
    /// turn (the run is cold-starting). Every other backend takes typed text
    /// at any time.
    pub fn loses_busy_input(self) -> bool {
        match self {
            Backend::Dsh => dsh::LOSES_BUSY_INPUT,
            _ => false,
        }
    }

    /// For a backend that loses typed text (`loses_busy_input`): is its pane
    /// ready for a typed line now, by the CLI side's own fact (dsh: the managed
    /// shell's ready file, written once ZLE owns the TTY and removed when a
    /// line runs)? `None` for every other backend, whose turn edges answer.
    /// `pane_pid` is the pane's own process (`#{pane_pid}`), the one input
    /// owner a readiness claim may name.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn input_ready(self, home: &std::path::Path, pane_pid: Option<u32>) -> Option<bool> {
        match self {
            Backend::Dsh => Some(dsh::input_ready(home, pane_pid)),
            _ => None,
        }
    }

    /// The input mode a NEW definition on this backend gets when it names
    /// none (board #336): the empty-registry seed, a `registry_save` /
    /// `teams_save` def without `input_mode`, and the Agents editor's new
    /// draft (through `backends_list.default_input_mode`). `queue` wherever
    /// the backend file says nothing; it is always a mode
    /// `models::validate_input_mode` accepts for this backend.
    pub fn default_input_mode(self) -> &'static str {
        match self {
            Backend::Kiro => kiro::DEFAULT_INPUT_MODE,
            _ => "queue",
        }
    }

    /// Where a backend's Stop payload carries no reply text, the backend may
    /// know another source: kiro --v3 reads the session store, the agent's
    /// ISOLATED home first and the global `~/.kiro` only as the legacy
    /// fallback (board #207, order fixed in #376 — a stale global copy of a
    /// live session id shadowed it and four agents' replies never reached
    /// the room); kimi reads the session wire inside `home`, the agent's
    /// managed home resolved by name at the call site (board #224) — `None`
    /// for a window this app did not spawn.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn reply_fallback(
        self,
        payload: &serde_json::Map<String, serde_json::Value>,
        home: Option<&std::path::Path>,
    ) -> Option<String> {
        match self {
            Backend::Kiro => kiro::reply_fallback(payload, home),
            Backend::Kimi => kimi::reply_fallback(payload, home?),
            _ => None,
        }
    }

    /// Is this reply text the CLI's own stand-in for a turn that said nothing
    /// (board #355)? Only kiro-cli v3 writes one; every other backend's reply
    /// is the agent's words or nothing.
    pub fn is_empty_reply(self, text: &str) -> bool {
        match self {
            Backend::Kiro => kiro::is_empty_turn_reply(text),
            _ => false,
        }
    }

    /// What a completed turn's reply says about how the turn ended (board #355).
    /// THREE answers, because "not the placeholder" is not "said something": a
    /// Stop with no body, a blank one, or a session file that could not be read
    /// all arrive here as no usable text, and none of them is evidence that the
    /// agent spoke (review P2-2: reading them as speech reopened the nudge
    /// allowance with nobody having said anything).
    pub fn reply_quality(self, reply: Option<&str>) -> EndQuality {
        match reply {
            Some(text) if self.is_empty_reply(text) => EndQuality::Empty,
            Some(text) if !text.trim().is_empty() => EndQuality::Said,
            _ => EndQuality::Unknown,
        }
    }

    /// The kind ("completed"/"failed"/"permission_required"/"input_required")
    /// carried by one hook payload, read with this backend's own key spelling
    /// and screening rules — each arm lives on the backend's file (board
    /// #129). Compiled on every target: the mobile shell consumes the same
    /// inbox envelopes.
    pub fn normalize_kind(
        self,
        payload: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<&'static str, String> {
        match self {
            Backend::Kiro => kiro::normalize_kind(payload),
            Backend::Claude => claude::normalize_kind(payload),
            Backend::Codex => codex::normalize_kind(payload),
            Backend::Grok => grok::normalize_kind(payload),
            Backend::Omp => omp::normalize_kind(payload),
            Backend::Kimi => kimi::normalize_kind(payload),
            Backend::Dsh => dsh::normalize_kind(payload),
        }
    }

    /// True when the payload marks the start of a new user turn (resets the
    /// auto-post dedup flag), in this backend's spelling.
    pub fn is_user_prompt_submit(self, payload: &serde_json::Value) -> bool {
        match self {
            Backend::Kiro => kiro::is_user_prompt_submit(payload),
            Backend::Claude => claude::is_user_prompt_submit(payload),
            Backend::Codex => codex::is_user_prompt_submit(payload),
            Backend::Grok => grok::is_user_prompt_submit(payload),
            Backend::Omp => omp::is_user_prompt_submit(payload),
            Backend::Kimi => kimi::is_user_prompt_submit(payload),
            Backend::Dsh => dsh::is_user_prompt_submit(payload),
        }
    }

    /// True when a tool event is the CLI's own HOUSEKEEPING rather than the
    /// agent's work — kiro v3's post-turn `memory` auto-capture (board #227).
    /// The consumer records such a call only inside an open turn; outside one
    /// it must not reopen the turn. Only kiro has one today.
    pub fn is_housekeeping_tool(self, payload: &serde_json::Value) -> bool {
        match self {
            Backend::Kiro => kiro::is_housekeeping_tool(payload),
            _ => false,
        }
    }

    /// The child thread id when a hook payload comes from a SUB-AGENT thread
    /// of this window's agent rather than the agent itself (board #169). Only
    /// codex spawns in-process sub-agents whose hooks fire on the parent's
    /// pane; the other backends never report one.
    pub fn subagent_thread<'a>(self, payload: &'a serde_json::Value) -> Option<&'a str> {
        match self {
            Backend::Codex => codex::subagent_thread(payload),
            _ => None,
        }
    }

    /// True for claude's idle reminder — an event that must never read as an
    /// ask (board #75). Only claude has one.
    pub fn is_idle_nudge(self, payload: &serde_json::Value) -> bool {
        match self {
            Backend::Claude => claude::is_idle_nudge(payload),
            _ => false,
        }
    }

    /// The backend's detection/relaunch row for the KNOWN table
    /// (projects/agents.rs assembles it from ALL, board #129).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn known(self) -> crate::projects::agents::KnownAgent {
        match self {
            Backend::Kiro => kiro::known(),
            Backend::Claude => claude::known(),
            Backend::Codex => codex::known(),
            Backend::Grok => grok::known(),
            Backend::Omp => omp::known(),
            Backend::Kimi => kimi::known(),
            Backend::Dsh => dsh::known(),
        }
    }

    /// Render an agent's isolated home from its definition — prompt, backend
    /// config, hooks, launch command (board #128). Each arm is the backend's
    /// own file; `workspace` is read by claude and codex (trust pre-seeding).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn render(
        self,
        def: &crate::projects::store::RegAgent,
        window_name: &str,
        home: &std::path::Path,
        workspace: &std::path::Path,
        system_prompt: &str,
        skills: &[crate::projects::skills::ResolvedSkill],
    ) -> Result<crate::projects::spawn::Rendered, String> {
        match self {
            Backend::Kiro => kiro::render_kiro(def, window_name, home, workspace, system_prompt, skills),
            Backend::Claude => claude::render_claude(def, window_name, home, workspace, system_prompt, skills),
            Backend::Codex => codex::render_codex(def, window_name, home, workspace, system_prompt, skills),
            Backend::Grok => grok::render_grok(def, window_name, home, system_prompt, skills),
            Backend::Omp => omp::render_omp(def, window_name, home, system_prompt, skills),
            Backend::Kimi => kimi::render_kimi(def, window_name, home, workspace, system_prompt, skills),
            Backend::Dsh => dsh::render_dsh(def, window_name, home, system_prompt, skills),
        }
    }

    /// How a spawn's first prompt (the stamped `--brief`) reaches the CLI.
    /// Five CLIs take it as a trailing positional argument on the launch line;
    /// Kimi Code 2.0.2 has no positional prompt (`kimi <text>` is "unknown
    /// command …" and the pane falls back to the shell — measured live by
    /// claude, board #224) and its `-p` is one-shot non-interactive, so the
    /// brief is TYPED into the pane once the composer is up — the same
    /// delivery primitive every later message uses (tenet 5). dsh's pane is a
    /// shell whose typed line IS the turn (board #404), so its brief is typed
    /// at the prompt the same way.
    pub fn first_prompt(self) -> FirstPrompt {
        match self {
            Backend::Kimi | Backend::Dsh => FirstPrompt::Typed,
            _ => FirstPrompt::LaunchLine,
        }
    }

    /// The backend's resume dialect on one persisted identity command. `home`
    /// is the agent's isolated home and `agent` its window name, which only
    /// kiro reads: its v3 store is that home, and an id the home does not hold
    /// for THIS agent must not be resumed (board #379).
    pub fn resume_command(self, cmd: &str, id: Option<&str>, home: Option<&std::path::Path>, agent: &str) -> String {
        match self {
            Backend::Kiro => kiro::resume_command(cmd, id, home, agent),
            Backend::Claude => claude::resume_command(cmd, id),
            Backend::Codex => codex::resume_command(cmd, id),
            Backend::Grok => grok::resume_command(cmd, id),
            Backend::Omp => omp::resume_command(cmd, id),
            Backend::Kimi => kimi::resume_command(cmd, id),
            Backend::Dsh => dsh::resume_command(cmd, id),
        }
    }

    /// Repair this backend's on-disk surface in a managed home (hooks,
    /// settings, channel keys, recipe backfill). Probes for its own files and
    /// no-ops when the home is not this backend's.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn refresh(
        self,
        home: &std::path::Path,
        window_name: &str,
        workspace: &std::path::Path,
        notifications: &crate::agent_notifications::AgentNotificationHub,
    ) -> bool {
        match self {
            Backend::Kiro => kiro::refresh(home, window_name, workspace, &notifications.helper_command("kiro")),
            Backend::Claude => claude::refresh(home, workspace, &notifications.helper_command("claude")),
            Backend::Codex => codex::refresh(home, &notifications.helper_command("codex")),
            Backend::Grok => grok::refresh(home, &notifications.helper_command("grok")),
            Backend::Omp => omp::refresh(home, &notifications.helper_command("omp")),
            Backend::Kimi => kimi::refresh(home, &notifications.helper_command("kimi")),
            Backend::Dsh => dsh::refresh(home, &notifications.helper_command("dsh")),
        }
    }

    /// Read the CLI's own status furniture from a pane capture — each
    /// backend paints its own dialect, and reading one CLI's screen with
    /// another's grammar yields confident nonsense (agent-status.md).
    /// `agent` anchors kiro's positional status line; the other dialects
    /// ignore it.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    pub fn sniff(self, pane: &str, agent: &str) -> crate::projects::vitals::Vitals {
        match self {
            Backend::Kiro => kiro::sniff_kiro(pane, agent),
            Backend::Claude => claude::sniff_claude(pane),
            Backend::Codex => codex::sniff_codex(pane),
            Backend::Grok => grok::sniff_grok(pane),
            Backend::Omp => omp::sniff_omp(pane),
            Backend::Kimi => kimi::sniff_kimi(pane),
            Backend::Dsh => dsh::sniff_dsh(pane),
        }
    }

    /// Ask the backend's own CLI for its model ids. `None` = no authoritative
    /// list exists (claude/codex/omp aliases) or the CLI is unavailable —
    /// validation then degrades to accept-all (models.rs module doc).
    pub fn models_fetch(self) -> Option<Vec<String>> {
        match self {
            Backend::Kiro => kiro::models_fetch(),
            Backend::Claude => claude::models_fetch(),
            Backend::Codex => codex::models_fetch(),
            Backend::Grok => grok::models_fetch(),
            Backend::Omp => omp::models_fetch(),
            Backend::Kimi => kimi::models_fetch(),
            Backend::Dsh => dsh::models_fetch(),
        }
    }
}

/// Lowercase alphanumerics only: the pane wraps the error blob at arbitrary
/// points (and pads with box furniture), so whitespace and punctuation carry
/// no signal.
/// `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, hex digits only: the Request ID
/// every measured error paint ends with (kiro, codex).
pub(crate) fn is_uuid(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

pub(crate) fn canonical(line: &str) -> String {
    line.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}


/// One recovery shape and the CLI version it was measured on (board #362).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Measured {
    /// The shape's name, as `transient_shape` answers it.
    pub shape: &'static str,
    /// The newest CLI version a real paint of it was captured on.
    pub version: &'static str,
    /// `true` when the capture's version was not recorded and only an upper
    /// bound is known (the two oldest kiro shapes: captured 2026-08-22/26,
    /// before versions were written down; the first version on record on
    /// this host is 2.18.1, 2026-09-03).
    pub at_most: bool,
}

impl Measured {
    /// `2.28.0`, or `≤ 2.18.1` for an upper bound.
    pub fn label(&self) -> String {
        if self.at_most { format!("≤ {}", self.version) } else { self.version.to_string() }
    }
}

/// The version `shape` of `backend` was measured on (board #362 a).
pub fn measured_version(backend: Backend, shape: &str) -> Option<&'static Measured> {
    backend.recovery_shapes().iter().find(|m| m.shape == shape)
}

/// The first dotted number in a `--version` answer: `kiro-cli 2.31.0`,
/// `2.1.288 (Claude Code)`, `codex-cli 0.162.1` → `[2, 31, 0]` … Pure.
pub fn parse_version(text: &str) -> Option<Vec<u64>> {
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .map(|t| t.trim_start_matches('v'))
        .find(|t| t.contains('.') && t.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())))
        .map(|t| t.split('.').map(|p| p.parse().unwrap_or(0)).collect())
}

/// Is `running` newer than what `m` was measured on? An upper bound counts
/// as its bound: anything after 2.18.1 is unmeasured for `≤ 2.18.1`. Pure.
pub fn newer_than_measured(running: &[u64], m: &Measured) -> bool {
    let Some(measured) = parse_version(m.version) else { return false };
    let n = running.len().max(measured.len());
    let at = |v: &[u64], i: usize| v.get(i).copied().unwrap_or(0);
    (0..n).map(|i| at(running, i).cmp(&at(&measured, i))).find(|o| o.is_ne()) == Some(std::cmp::Ordering::Greater)
}

#[cfg(test)]
mod tests {
    /// Board #362: the `--version` answers as each CLI prints them on this
    /// host (2026-10-15), and the comparison the drift guard makes.
    #[test]
    fn versions_are_read_from_each_clis_own_answer_and_compared_by_number() {
        use super::*;
        assert_eq!(parse_version("kiro-cli 2.31.0\n"), Some(vec![2, 31, 0]));
        assert_eq!(parse_version("kiro-cli-chat 2.28.0"), Some(vec![2, 28, 0]));
        assert_eq!(parse_version("2.1.288 (Claude Code)"), Some(vec![2, 1, 288]));
        assert_eq!(parse_version("codex-cli 0.162.1"), Some(vec![0, 162, 1]));
        assert_eq!(parse_version("v1.2"), Some(vec![1, 2]));
        assert_eq!(parse_version("no version here"), None);
        assert_eq!(parse_version("build 42"), None, "a lone number is not a version");
        let m = |v: &'static str, at_most| Measured { shape: "s", version: v, at_most };
        assert!(newer_than_measured(&[2, 31, 0], &m("2.28.0", false)));
        assert!(newer_than_measured(&[2, 28, 1], &m("2.28.0", false)));
        assert!(newer_than_measured(&[2, 100, 0], &m("2.28.0", false)), "by number, not by text");
        assert!(!newer_than_measured(&[2, 28, 0], &m("2.28.0", false)));
        assert!(!newer_than_measured(&[2, 28], &m("2.28.0", false)), "2.28 is 2.28.0");
        assert!(!newer_than_measured(&[2, 9, 9], &m("2.28.0", false)));
        assert!(newer_than_measured(&[2, 18, 2], &m("2.18.1", true)), "an upper bound counts as its bound");
        assert_eq!(m("2.18.1", true).label(), "≤ 2.18.1");
        assert_eq!(m("2.28.0", false).label(), "2.28.0");
    }

    /// Board #264, measured 2026-09-28: what each CLI's prompt hook reports
    /// after a slash command, one shape per backend file.
    #[test]
    fn each_backend_declares_its_command_echo() {
        assert_eq!(Backend::Kiro.command_echo("/goal", "do x").as_deref(), Some("goal do x"), "kiro strips the slash");
        assert_eq!(Backend::Claude.command_echo("/goal", "do x").as_deref(), Some("/goal do x"), "claude echoes verbatim");
        assert_eq!(Backend::Omp.command_echo("/goal", "do x").as_deref(), Some("do x"), "omp echoes the arguments");
        assert_eq!(Backend::Kimi.command_echo("/goal", "do x").as_deref(), Some("do x"), "kimi echoes the arguments");
        // Per command, only what was measured to fire a prompt hook (validator,
        // #264): every other /name has no receipt row on any backend.
        for b in Backend::ALL {
            for (name, args) in [("/effort", "medium"), ("/model", "k3"), ("/status", ""), ("/usage", ""), ("/goal", "")] {
                assert_eq!(b.command_echo(name, args), None, "{b:?} {name} {args}");
            }
        }
        assert_eq!(Backend::Codex.command_echo("/goal", "do x"), None, "codex fires no prompt hook for a command");
        assert_eq!(Backend::Grok.command_echo("/goal", "do x"), None, "grok submits its own planner text");
    }

    use super::{Backend, FirstPrompt};

    #[test]
    fn parse_and_name_roundtrip_and_names_mirror_all() {
        for (i, b) in Backend::ALL.into_iter().enumerate() {
            assert_eq!(Backend::parse(b.name()), Some(b));
            assert_eq!(Backend::NAMES[i], b.name(), "NAMES stays in ALL's order");
        }
        assert_eq!(Backend::parse(" kiro "), Some(Backend::Kiro), "boundary input is trimmed");
        // kimi is the one CLI without a positional prompt (board #224).
        for b in Backend::ALL {
            let expected = if matches!(b, Backend::Kimi | Backend::Dsh) { FirstPrompt::Typed } else { FirstPrompt::LaunchLine };
            assert_eq!(b.first_prompt(), expected, "{}", b.name());
        }
        assert_eq!(Backend::parse("openclaw"), None, "detection-only, never spawnable");
        assert_eq!(Backend::DEFAULT.name(), "kiro");
    }

    /// Backend names are spelled in `src/backends/` and nowhere else (board
    /// #101/#131; tenet 2: adding a backend touches one file). A quoted
    /// literal outside it is knowledge that has leaked — the class of drift
    /// that let omp miss `registry_save` (2026-09-07). The scan reads every
    /// `src/**/*.rs`, ignores comments, and skips exactly three things:
    /// tests (a file's column-0 `#[cfg(test)]` module and any `*test*` file),
    /// the store.rs seed region fenced by `// backend-seeds:begin/end` (a
    /// seed is registry data), and a statement whose preceding comment block
    /// carries `// backend-quirk(measured): …` — the marker for a measured,
    /// screen-triggered adaptation that generic code has to keep (tmux.rs's
    /// codex beat and kiro picker; the owner accepted those, 2026-09-09).
    /// Marker comments, never line numbers: the exemption moves with the
    /// code it explains.
    #[test]
    fn backend_literals_live_only_in_backends() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut files);
        files.sort();
        assert!(files.len() > 20, "the walk found only {} files", files.len());

        let literals: Vec<String> = Backend::NAMES.iter().map(|n| format!("\"{n}\"")).collect();
        let mut leaks: Vec<String> = Vec::new();
        let mut scanned = 0usize;
        for path in &files {
            let rel = path.strip_prefix(&root).unwrap().display().to_string();
            if rel.starts_with("backends/") || rel.contains("test") {
                continue;
            }
            scanned += 1;
            let src = std::fs::read_to_string(path).unwrap();
            let lines: Vec<&str> = src.lines().collect();
            let end = lines.iter().position(|l| l.starts_with("#[cfg(test)]")).unwrap_or(lines.len());
            let mut in_seeds = false;
            let mut quirk = false;
            for line in &lines[..end] {
                let t = line.trim_start();
                if t.starts_with("//") {
                    if t.contains("backend-seeds:begin") {
                        in_seeds = true;
                    } else if t.contains("backend-seeds:end") {
                        in_seeds = false;
                    } else if t.contains("backend-quirk(measured):") {
                        quirk = true;
                    }
                    continue;
                }
                // Code line: strip a trailing comment, then look for a literal.
                let code = match t.find("//") {
                    Some(k) if !t[..k].contains('"') => &t[..k],
                    _ => t,
                };
                let hit = literals.iter().any(|l| code.contains(l.as_str()));
                if hit && !in_seeds && !quirk {
                    leaks.push(format!("{rel}: {}", t.trim_end()));
                }
                // A quirk marker covers the statement it introduces; the first
                // code line after the comment block ends its reach.
                if !t.is_empty() {
                    quirk = false;
                }
            }
        }
        assert!(scanned >= 20, "scanned only {scanned} files");
        assert!(
            leaks.is_empty(),
            "backend names spelled outside src/backends/ (move the knowledge, or fence a seed / mark a measured quirk): {leaks:#?}"
        );
        // The fences must still be there for the exemption to mean anything —
        // in whichever store file holds the seeds (store/ split, board #147).
        let fenced = files.iter().any(|p| {
            let s = std::fs::read_to_string(p).unwrap();
            s.contains("backend-seeds:begin") && s.contains("backend-seeds:end")
        });
        assert!(fenced, "no file carries the backend-seeds fence");
        let tmux = std::fs::read_to_string(root.join("tmux.rs")).unwrap();
        assert!(tmux.matches("backend-quirk(measured):").count() >= 2, "tmux.rs lost its quirk markers");
    }

    /// `describe` derives resource names by convention; this is where the
    /// convention is enforced (board #130): every spawnable backend ships
    /// its avatar under public/assets and its colour token in app.css, and
    /// the list's first entry is the documented default.
    #[test]
    fn every_backend_has_its_avatar_and_colour_token() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let css = std::fs::read_to_string(root.join("src/app.css")).unwrap();
        for b in Backend::ALL {
            let icon = root.join("public/assets").join(format!("{}.svg", b.name()));
            assert!(icon.is_file(), "{} avatar missing: {}", b.name(), icon.display());
            assert!(css.contains(&format!("--backend-{}:", b.name())), "{} colour token missing from app.css", b.name());
        }
        let list = Backend::list_json();
        assert_eq!(list[0]["name"], Backend::DEFAULT.name());
        assert_eq!(list.as_array().unwrap().len(), Backend::ALL.len());
        assert_eq!(list[4]["efforts"].as_array().unwrap().len(), Backend::Omp.effort_values().len());
        assert_eq!(list[5]["efforts"].as_array().unwrap().len(), Backend::Kimi.effort_values().len());
    }
}
