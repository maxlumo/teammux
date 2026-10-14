//! What the agent's own status line already says.
//!
//! An agent CLI paints a status line at the bottom of its pane — the model it is
//! on, how much of the context it has used, its reasoning effort, its cwd and
//! branch. We were showing none of it, while asking the owner to read it in the
//! terminal ("从输出的最后几行原始文本内容 加一下当前状态的嗅探，比如模型名 上下文
//! 长度 effort 之类的", 2026-08-19).
//!
//! Most CLIs expose no live-state API: their own process owns the footer, so we
//! read the LAST FEW LINES of the pane. Claude is the useful exception in the
//! input half: its official `statusLine` command receives exact JSON, which our
//! local `tmm claude-statusline` renders back into one uniquely anchored pane
//! row; the server still observes that row through the same sniffer pipeline.
//! Every field remains optional, an unreadable line yields `Vitals::default()`
//! and NEVER an error, and nothing downstream may assume a value is present.
//!
//! kiro's layout is documented by its own source: the status line is a fixed
//! order of segments joined by `·` —
//! `agent · autonomous · model · effort · context · tangent · codeIntel · goal`
//! on the left, `location · branch` on the right — and the context segment is
//! "Share of the context used" (a pie glyph plus `N%`, or `N% ctx` in lite mode).
//! We anchor on the AGENT NAME, which the caller already knows (a managed agent's
//! window name is its `--agent` name), and read the segments that follow it. When
//! the pane is too narrow the right-hand segments wrap onto their own lines, so
//! every line of the tail is parsed and the first reading of each field wins.

/// A reading of an agent's status line. Every field is a maybe: this is sniffed.
#[derive(Debug, Default, Clone, PartialEq, serde::Serialize)]
pub struct Vitals {
    /// The model the CLI says it is using, e.g. `claude-opus-5`.
    pub model: Option<String>,
    /// Share of the context window USED, 0–100 (kiro's own wording).
    pub context_pct: Option<u8>,
    /// Reasoning effort, when the backend reports one: low|medium|high|xhigh|max.
    pub effort: Option<String>,
    /// Checked-out branch, as the status line shows it.
    pub branch: Option<String>,
    /// True when the FULL status line was seen this capture (kiro: the anchored
    /// line with its context segment), so an absent effort is a VERDICT — kiro
    /// omits the effort segment entirely when it is the backend default (owner,
    /// 2026-08-26: "effort 这个参数不是百分之百都会显示的"), and without this
    /// flag a once-misread effort could never clear: backfill re-inserted it
    /// with a fresh timestamp on every poll, a permanent ghost.
    #[serde(skip)]
    pub effort_definitive: bool,
}

impl Vitals {
    /// True when nothing at all could be read — the caller can omit the object.
    pub fn is_empty(&self) -> bool {
        self.model.is_none()
            && self.context_pct.is_none()
            && self.effort.is_none()
            && self.branch.is_none()
    }
}

/// How long a remembered reading may stand in for a fresh one. A model or a branch
/// does not change between polls, and a context percentage that is a minute old is
/// far better than a card that blinks empty. An hour, not five minutes: readings
/// are now REFRESHED by events (hooks, deliveries — `sniff_window_soon`), so age
/// means "nothing has happened", and showing the last known state through a long
/// quiet spell is exactly what the owner asked of the record (2026-08-25:
/// "服务端记录这个状态，客户端随时能获取到"). Past this the reading is dropped
/// rather than aged.
const VITALS_TTL_SECS: u64 = 3600;

/// Last good reading per (session, window). Sniffing reads somebody else's screen
/// at an arbitrary instant, so a miss is normal: the pane may be mid-repaint, a
/// tool's output may have pushed the status line up, a panel may be open. Treating
/// each miss as "no information" is what made the card flicker (owner, 2026-08-19:
/// "context window 和模型状态信息，有时候会闪没了 … 可以多维持缓存一会儿").
fn cache() -> &'static std::sync::Mutex<
    std::collections::HashMap<(String, String), (Vitals, u64)>,
> {
    static C: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<(String, String), (Vitals, u64)>>,
    > = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Vitals {
    /// Fill the fields this reading did not get from a previous one. FIELD BY
    /// FIELD, not all-or-nothing: a pane commonly shows the wrapped branch line
    /// while the status line itself has scrolled off, and half a reading is still
    /// half a reading.
    pub fn backfill(&mut self, prev: &Vitals) {
        if self.model.is_none() {
            self.model = prev.model.clone();
        }
        if self.context_pct.is_none() {
            self.context_pct = prev.context_pct;
        }
        // An effort verdict stands: when the full status line was read and
        // carried no effort segment, the effort IS "backend default" — filling
        // it from memory would resurrect a stale (or once-misread) value that
        // kiro will never repaint to contradict.
        if self.effort.is_none() && !self.effort_definitive {
            self.effort = prev.effort.clone();
        }
        if self.branch.is_none() {
            self.branch = prev.branch.clone();
        }
    }
}

/// Sniff a pane and remember what was read, filling gaps from the last reading.
///
/// This is what `hub_agents` calls. The sniffers stay pure (and tested) — the
/// memory lives here, keyed by session and window, expiring after
/// `VITALS_TTL_SECS` so a long-dead reading cannot follow an agent around.
/// `backend` picks the dialect: every CLI paints its own status furniture
/// (kiro a `·`-joined status line, claude our official-statusLine `[CC]` row,
/// grok a header ratio + boxed footer), and reading one CLI's screen with
/// another CLI's grammar yields confident nonsense, which is worse than nothing.
pub fn sniff_remembered(
    session: &str,
    window: &str,
    pane: &str,
    agent: &str,
    backend: &str,
) -> Vitals {
    // The dialect dispatch is the Backend's (board #127); an unknown or
    // absent backend reads with kiro's grammar, exactly as before.
    let mut v = crate::backends::Backend::parse(backend)
        .map(|b| b.sniff(pane, agent))
        .unwrap_or_else(|| sniff_kiro(pane, agent));
    let now = now_secs();
    let key = (session.to_string(), window.to_string());
    let mut map = cache().lock().unwrap();
    if let Some((prev, at)) = map.get(&key) {
        if now.saturating_sub(*at) <= VITALS_TTL_SECS {
            v.backfill(prev);
        }
    }
    if v.is_empty() {
        // Nothing known at all: do not store an empty reading over a good one.
        map.remove(&key);
        return v;
    }
    map.insert(key, (v.clone(), now));
    v
}

/// Forget readings for windows that no longer exist — the same housekeeping
/// telemetry does, called from the same place.
pub fn retain_windows(session: &str, live: &[String]) {
    cache().lock().unwrap().retain(|(s, w), _| s != session || live.contains(w));
}

/// When each (session, window) was last SCHEDULED for an event sniff, for the
/// throttle below. Separate from the reading cache: a throttled request is not
/// a reading.
fn sniff_times() -> &'static std::sync::Mutex<std::collections::HashMap<(String, String), u64>> {
    static TIMES: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<(String, String), u64>>,
    > = std::sync::OnceLock::new();
    TIMES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Sniff one managed window shortly AFTER an event that makes its pane fresh —
/// a hook fired (a turn opened or closed, a tool ran) or a chat line was just
/// typed into it. `hub_agents` only sniffed when the client happened to poll,
/// so a fresh page often showed nothing until a later poll caught the status
/// line (owner, 2026-08-25: "经常看到没有信息，过了一会儿才出来"); sniffing at
/// the moments the CLI repaints its footer keeps the memory warm, and the poll
/// answers from the memory. Runs on a throwaway thread after ~1.2 s (the TUI
/// needs a beat to repaint; telemetry may never block what it observes), and
/// is throttled per window so a burst of tool hooks costs one capture, not
/// thirty. Fail-soft everywhere: an unresolvable window is a no-op.
pub fn sniff_window_soon(session: &str, window: &str) {
    if cfg!(test) {
        // Tests must not reach for a real tmux or spawn sniffer threads.
        return;
    }
    let now = now_secs();
    {
        let mut times = sniff_times().lock().unwrap();
        let key = (session.to_string(), window.to_string());
        if let Some(at) = times.get(&key) {
            if now.saturating_sub(*at) < 3 {
                return;
            }
        }
        times.insert(key, now);
        times.retain(|_, at| now.saturating_sub(*at) < 600);
    }
    let session = session.to_string();
    let window = window.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        sniff_window_now(&session, &window);
    });
}

/// The synchronous half: resolve the window, apply the same managed-only gate
/// as `hub_agents` (we only know OUR agents' status-line shapes), capture, and
/// remember. The reading lands in the same cache `hub_agents` reads.
fn sniff_window_now(session: &str, window: &str) {
    let ws = crate::projects::project_for_session(session)
        .ok()
        .flatten()
        .map(|p| p.path);
    let Ok(panes) = crate::tmux::list_panes(session) else { return };
    // The name is the key (board #120); the capture target still uses the
    // window's CURRENT index, read fresh off list_panes — transient use of an
    // index is fine, storing under it was the bug.
    let Some(p) = panes.iter().find(|p| p.window_name == window && p.active) else { return };
    if !crate::projects::is_managed_in(ws.as_deref(), &p.window_name) {
        return;
    }
    let Some(agent) = crate::projects::agents::detect_pane(ws.as_deref(), p) else {
        return;
    };
    let Ok(text) = crate::tmux::capture_pane_plain(&format!("{session}:{}", p.window), Some(0)) else {
        return;
    };
    sniff_remembered(session, window, &text, &p.window_name, agent.backend);
}

// The per-CLI dialects live on the backend files (board #127); these
// re-exports keep the one import path (and the test module's `use super::*`)
// stable. The SHARED parsing helpers (EFFORTS, PIE, context_pct, branch,
// looks_like_model, the Vitals struct) stay here — more than one dialect
// reads them.
pub use crate::backends::claude::{claude_status_line, sniff_claude};
#[cfg(test)]
pub(crate) use crate::backends::codex::sniff_codex;
#[cfg(test)]
pub(crate) use crate::backends::codex::{codex_context_item, codex_context_left, codex_footer};
#[cfg(test)]
pub(crate) use crate::backends::grok::sniff_grok;
#[cfg(test)]
pub(crate) use crate::backends::grok::{grok_context_ratio, grok_tokens};
pub(crate) use crate::backends::kiro::sniff_kiro;
#[cfg(test)]
pub(crate) use crate::backends::omp::sniff_omp;

/// The effort words kiro accepts. A segment matching one of these IS the effort
/// segment, wherever it sits — matching by position alone would mistake a model
/// id for it whenever the effort segment is absent (it usually is).
pub(crate) const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// The pie glyphs kiro ramps through for context usage. They are the marker that
/// a bare `N%` is the context segment and not, say, a percentage in a diff.
pub(crate) const PIE: [char; 6] = ['○', '◔', '◑', '◕', '●', '◯'];

/// `◕ 69%` (TUI) or `69% ctx` (lite) — a percentage that is about the context.
/// A bare `69%` is deliberately NOT accepted: percentages are everywhere in a
/// terminal, and a wrong reading here is worse than a missing one.
pub(crate) fn context_pct(seg: &str) -> Option<u8> {
    let s = seg.trim();
    let digits = if let Some(rest) = s.strip_prefix(|c| PIE.contains(&c)) {
        rest.trim_start()
    } else if let Some(rest) = s.strip_suffix("ctx") {
        rest.trim_end()
    } else {
        return None;
    };
    let n = digits.trim().strip_suffix('%')?;
    n.parse::<u16>().ok().filter(|n| *n <= 100).map(|n| n as u8)
}

/// `(feat/projects-and-tasks)` — kiro wraps the branch in parentheses, which is
/// what tells it apart from the cwd segment next to it.
pub(crate) fn branch(seg: &str) -> Option<&str> {
    let inner = seg.strip_prefix('(')?.strip_suffix(')')?.trim();
    // A branch name, not a sentence: no spaces, and something in it.
    if inner.is_empty() || inner.contains(' ') {
        return None;
    }
    Some(inner)
}

/// A model id is a lowercase slug: letters, digits, `-` and `.`, with at least
/// one separator (`claude-opus-5`, `gpt-5.1`, `auto` is the exception we allow by
/// name). Rejecting anything else is what keeps a path or a stray word out.
pub(crate) fn looks_like_model(s: &str) -> bool {
    if s == "auto" {
        return true;
    }
    let ok = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '.';
    !s.is_empty()
        && s.len() <= 48
        && s.chars().all(ok)
        && s.contains('-')
        && s.starts_with(|c: char| c.is_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real capture of a managed kiro pane (tmux capture-pane -p, this repo,
    /// 2026-08-19). Everything below is measured, not imagined.
    const REAL: &str = "  the same blink sourced from the\n\
        \x20 text instead of from a clip.\n\
        \x20/quit to exit\n\
        ────────────────────────────────────────────────────\n\
        builder-2 · claude-opus-5 · ◔ 9%\n\
        /local/home/cfu/work/projects/tmux-mobile ·\n\
        (feat/projects-and-tasks)\n\
        \x20Kiro is working · Type to queue · Ctrl+S to steer\n";

    #[test]
    fn reads_a_real_kiro_status_line() {
        let v = sniff_kiro(REAL, "builder-2");
        assert_eq!(v.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(v.context_pct, Some(9));
        assert_eq!(v.branch.as_deref(), Some("feat/projects-and-tasks"));
        assert_eq!(v.effort, None, "kiro only shows effort when the backend reports one");
        assert!(!v.is_empty());
    }

    /// A real capture of a WIDE managed kiro pane (chat:2, 2026-08-26). With
    /// room to spare, kiro right-aligns `location · branch` on the SAME line as
    /// the left segments, joined by a padding run of spaces — so the context
    /// segment arrived glued to the cwd and the percent was never read (owner:
    /// "上下文长度也没嗅探出来").
    #[test]
    fn a_wide_pane_glues_the_right_side_onto_the_status_line() {
        let real = "─────────────────────────────────────────────\n\
            chat · gpt-5.6-sol · medium · ◔ 5%       /local/home/cfu/temp\n\
            \x20ask a question or describe a task ↵\n\
            \x20                                 /copy to clipboard\n";
        let v = sniff_kiro(real, "chat");
        assert_eq!(v.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(v.effort.as_deref(), Some("medium"));
        assert_eq!(v.context_pct, Some(5), "the glued cwd must not eat the percent");
        assert_eq!(v.branch, None, "no branch painted in a non-repo cwd");
        // And with a branch, the right side is `location · branch`:
        let with_branch =
            "bot · claude-opus-5 · ◕ 71%       /local/home/cfu/work · (feat/x)\n";
        let b = sniff_kiro(with_branch, "bot");
        assert_eq!(b.context_pct, Some(71));
        assert_eq!(b.branch.as_deref(), Some("feat/x"));
        assert_eq!(b.model.as_deref(), Some("claude-opus-5"));
    }

    #[test]
    fn the_activity_line_is_not_a_status_line() {
        // It uses the same `·` separator, so it has to be skipped by name or
        // "working" and "queue" become segments to interpret.
        let v = sniff_kiro(" Kiro is working · Type to queue · Ctrl+S to steer\n", "builder-2");
        assert_eq!(v, Vitals::default());
    }

    #[test]
    fn effort_is_matched_by_the_status_line_pattern() {
        // `… · model · effort · ◔ N%` — the effort is the segment immediately
        // BEFORE the context segment on the anchored line (owner, 2026-08-26:
        // "你要按照这样的模式去匹配 不要直接全文匹配").
        let v = sniff_kiro("worker · gpt-5.1 · high · ◑ 42%\n", "worker");
        assert_eq!(v.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(v.effort.as_deref(), Some("high"));
        assert_eq!(v.context_pct, Some(42));
        // Position alone would have read `high` as the model.
        let no_effort = sniff_kiro("worker · gpt-5.1 · ◑ 42%\n", "worker");
        assert_eq!(no_effort.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(no_effort.effort, None);
        // A bare effort word ANYWHERE else is not a reading — not in ordinary
        // output, and not even elsewhere on the anchored line (a tangent or
        // goal segment could be named `high`).
        for text in [
            "priority  high  assigned to worker\n",
            "medium\n",
            "risk: low · impact: high\n",
            "worker · gpt-5.1 · ◑ 42% · high\n",
        ] {
            assert_eq!(sniff_kiro(text, "worker").effort, None, "{text:?}");
        }
    }

    #[test]
    fn an_absent_effort_on_the_full_status_line_is_a_verdict() {
        // kiro omits the effort segment when it is the backend default, so the
        // anchored line WITH its context segment and WITHOUT an effort says
        // "no effort" — and backfill must not resurrect a remembered one, or a
        // stale/misread value becomes a permanent ghost (re-inserted with a
        // fresh timestamp on every poll).
        let mut fresh = sniff_kiro("worker · gpt-5.1 · ◑ 42%\n", "worker");
        assert!(fresh.effort_definitive);
        let prev = Vitals { effort: Some("high".into()), ..Default::default() };
        fresh.backfill(&prev);
        assert_eq!(fresh.effort, None, "verdict beats memory");
        // Without the verdict (status line not on screen), memory still fills
        // the gap — that is the whole point of remembering.
        let mut miss = sniff_kiro("$ ls\n", "worker");
        assert!(!miss.effort_definitive);
        miss.backfill(&prev);
        assert_eq!(miss.effort.as_deref(), Some("high"));
        // And an OLDER status line in scrollback cannot re-fill it either: the
        // newest paint's verdict wins over anything above it.
        let two = "worker · gpt-5.1 · high · ◑ 40%\nworker · gpt-5.1 · ◑ 42%\n";
        assert_eq!(sniff_kiro(two, "worker").effort, None);
    }

    #[test]
    fn the_autonomous_flag_does_not_hide_the_model() {
        let v = sniff_kiro("bot · Autonomous · claude-sonnet-4.5 · ● 88%\n", "bot");
        assert_eq!(v.model.as_deref(), Some("claude-sonnet-4.5"));
        assert_eq!(v.context_pct, Some(88));
    }

    #[test]
    fn lite_mode_writes_the_percent_the_other_way_round() {
        let v = sniff_kiro("bot · auto · 7% ctx\n", "bot");
        assert_eq!(v.model.as_deref(), Some("auto"));
        assert_eq!(v.context_pct, Some(7));
    }

    #[test]
    fn a_bare_percentage_is_never_the_context() {
        // A terminal is full of percentages; reading one as the context usage
        // would put a confident wrong number on the card.
        for text in ["bot · claude-opus-5 · 69%\n", "Compacting… 42%\n", "[####  ] 60%\n"] {
            assert_eq!(sniff_kiro(text, "bot").context_pct, None, "{text}");
        }
    }

    #[test]
    fn a_model_is_only_read_next_to_the_agents_own_name() {
        // The anchor is what keeps a path, a tangent name or a stray word from
        // being reported as the model the agent is running.
        let v = sniff_kiro("somebody-else · claude-opus-5 · ◔ 9%\n", "builder-2");
        assert_eq!(v.model, None, "not our line");
        assert_eq!(v.context_pct, Some(9), "shape-identified fields still read");
        // A cwd is not a model even in the model's position.
        let path = sniff_kiro("bot · /local/home/cfu/work · ◔ 9%\n", "bot");
        assert_eq!(path.model, None);
    }

    #[test]
    fn resumed_builtin_kiro_identity_still_reports_the_runtime_model() {
        // Real test:chat capture, 52 columns (2026-09-02): the app window is
        // `chat`, but the resumed Kiro conversation retained its built-in
        // status identity and actual running model.
        let pane = "kiro_default · gpt-5.6-sol · ◔ 6%\n\
/local/home/cfu/work/projects/tmux-mobile/src-tauri\n\
(feat/projects-and-tasks)\n";
        let v = sniff_kiro(pane, "chat");
        assert_eq!(v.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(v.context_pct, Some(6));
        assert_eq!(v.branch.as_deref(), Some("feat/projects-and-tasks"));
    }

    #[test]
    fn the_newest_paint_wins() {
        // A pane holds every earlier status line in its scrollback; the last one
        // is the current state.
        let two = "bot · claude-opus-5 · ◔ 9%\nbot · gpt-5.1 · ● 90%\n";
        let v = sniff_kiro(two, "bot");
        assert_eq!(v.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(v.context_pct, Some(90));
    }

    #[test]
    fn nothing_readable_is_not_an_error() {
        for text in ["", "\n\n", "$ ls -la\ntotal 48\n", "no dots here at all"] {
            let v = sniff_kiro(text, "bot");
            assert!(v.is_empty(), "{text:?}");
        }
    }

    #[test]
    fn a_branch_is_parenthesised_and_a_sentence_is_not() {
        assert_eq!(branch("(main)"), Some("main"));
        assert_eq!(branch("(feat/x-y)"), Some("feat/x-y"));
        assert_eq!(branch("()"), None);
        assert_eq!(branch("(no branch here)"), None);
        assert_eq!(branch("main"), None);
    }

    #[test]
    fn percentages_out_of_range_are_refused() {
        assert_eq!(context_pct("◔ 101%"), None);
        assert_eq!(context_pct("◔ 100%"), Some(100));
        assert_eq!(context_pct("◔ 0%"), Some(0));
        assert_eq!(context_pct("◔ abc%"), None);
    }

    /// A real capture of a managed grok pane (tmux capture-pane -p, grok 1.0.5,
    /// 2026-08-21). Header carries cwd + context ratio, the input box's bottom
    /// border carries the model and the approval mode.
    const GROK: &str = "\n\
        \x20 /local/home/cfu/work/reports          47K / 500K\n\
        \n\
        \x20    Worked for 2m8s            stop  [hooks: 1]\n\
        \n\
        \x20 ╭──────────────────────────────────────────────╮\n\
        \x20 │ ❯                                            │\n\
        \x20 ╰──────── Grok 4.6 (Bedrock) · always-approve ─╯\n\
        \n\
        \x20 Shift+Tab:mode  │  Ctrl+x:shortcuts\n";

    #[test]
    fn reads_a_real_grok_pane() {
        let v = sniff_grok(GROK);
        assert_eq!(v.model.as_deref(), Some("Grok 4.6 (Bedrock)"));
        assert_eq!(v.context_pct, Some(9), "47K of 500K rounds to 9%");
        assert_eq!(v.effort, None);
        assert_eq!(v.branch, None, "grok paints no branch");
    }

    #[test]
    fn a_grok_footer_without_the_mode_still_names_the_model() {
        // Wide pane, no `· always-approve` segment (measured, test-grok:2).
        let v = sniff_grok(
            "  /local/home/cfu                        13K / 500K\n\
             \x20 ╰───────────────────────── Grok 4.6 (Bedrock) ─╯\n",
        );
        assert_eq!(v.model.as_deref(), Some("Grok 4.6 (Bedrock)"));
        assert_eq!(v.context_pct, Some(3));
    }

    #[test]
    fn grok_ratios_in_ordinary_output_are_not_context() {
        // Fractions and paths are everywhere; only `N[K|M] / N[K|M]` with a
        // suffixed total at the end of a line is the header ratio.
        for text in [
            "passed 3 / 5 tests\n",
            "progress: 47 / 500\n",
            "  a/b\n",
            "download 900K / 1G\n", // G is not a context magnitude grok paints
        ] {
            assert_eq!(sniff_grok(text).context_pct, None, "{text:?}");
        }
        // An empty box border is not a model.
        assert_eq!(sniff_grok("  ╰────────╯\n").model, None);
        // Used above total is a misread, not a reading.
        assert_eq!(sniff_grok("  /w  600K / 500K\n").context_pct, None);
    }

    #[test]
    fn grok_token_shapes_parse() {
        assert_eq!(grok_tokens("47K"), Some(47_000.0));
        assert_eq!(grok_tokens("1.2M"), Some(1_200_000.0));
        assert_eq!(grok_tokens("800"), Some(800.0));
        assert_eq!(grok_tokens("abcK"), None);
        // Full window reads 100, empty reads 0.
        assert_eq!(grok_context_ratio("  /w  500K / 500K"), Some(100));
        assert_eq!(grok_context_ratio("  /w  0K / 500K"), Some(0));
    }

    #[test]
    fn a_reading_fills_its_gaps_from_the_last_one() {
        // The flicker: this capture caught the pane between paints, so only the
        // wrapped branch line was there.
        let mut half = sniff_kiro("(feat/x)\n", "bot");
        assert_eq!(half.model, None);
        assert_eq!(half.context_pct, None);

        let good = sniff_kiro("bot · claude-opus-5 · high · ◔ 12%\n(feat/x)\n", "bot");
        assert_eq!(good.model.as_deref(), Some("claude-opus-5"));

        half.backfill(&good);
        assert_eq!(half.model.as_deref(), Some("claude-opus-5"), "gap filled");
        assert_eq!(half.context_pct, Some(12));
        assert_eq!(half.effort.as_deref(), Some("high"));
        assert_eq!(half.branch.as_deref(), Some("feat/x"), "its own value, unchanged");
    }

    #[test]
    fn a_fresh_value_always_wins_over_a_remembered_one() {
        // Backfill must never overwrite: a `/model` swap has to show up at once.
        let mut fresh = sniff_kiro("bot · gpt-5.1 · ● 90%\n", "bot");
        let old = sniff_kiro("bot · claude-opus-5 · ○ 3%\n(main)\n", "bot");
        fresh.backfill(&old);
        assert_eq!(fresh.model.as_deref(), Some("gpt-5.1"));
        assert_eq!(fresh.context_pct, Some(90));
        // The field it never had is the only one that comes from memory.
        assert_eq!(fresh.branch.as_deref(), Some("main"));
    }

    #[test]
    fn backfilling_from_nothing_changes_nothing() {
        let mut v = sniff_kiro("bot · gpt-5.1 · ● 90%\n", "bot");
        let before = v.clone();
        v.backfill(&Vitals::default());
        assert_eq!(v, before);
    }

    /// The flicker itself, end to end: a good capture, then one that caught the
    /// pane between paints. The second must still report what we know.
    #[test]
    fn a_missed_capture_keeps_the_last_reading() {
        let session = format!("vitals-test-{}", std::process::id());
        let good = "bot · claude-opus-5 · ◔ 12%\n/w/x ·\n(main)\n";
        let first = sniff_remembered(&session, "w7", good, "bot", "kiro");
        assert_eq!(first.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(first.context_pct, Some(12));

        // A capture with nothing in it — a repaint, a tool's output, a panel.
        let blind = sniff_remembered(&session, "w7", "\n\n$ ls\n", "bot", "kiro");
        assert_eq!(blind.model.as_deref(), Some("claude-opus-5"), "remembered, not blank");
        assert_eq!(blind.context_pct, Some(12));
        assert_eq!(blind.branch.as_deref(), Some("main"));

        // A fresh number replaces the remembered one immediately.
        let moved = sniff_remembered(&session, "w7", "bot · claude-opus-5 · ◑ 44%\n", "bot", "kiro");
        assert_eq!(moved.context_pct, Some(44));

        // Another window's reading is its own.
        let other = sniff_remembered(&session, "w9", "\n", "bot", "kiro");
        assert!(other.is_empty(), "window 9 was never read");

        // A window that goes away is forgotten, so a new agent in the same index
        // cannot inherit its numbers.
        retain_windows(&session, &["w9".to_string()]);
        let after = sniff_remembered(&session, "w7", "\n", "bot", "kiro");
        assert!(after.is_empty());
    }

    /// The measured SHAPE of a codex capture (0.162.1, 2026-10-15): content,
    /// the composer prompt at column zero, then the status line and the
    /// hints row under it. Every footer fixture below is a footer line
    /// inside this shape, because a footer outside it is not a footer —
    /// `footer_zone` only reads under the composer (board #373 review P1).
    fn codex_pane(footer: &str) -> String {
        format!(
            "\u{2022} ok\n\u{203a} Ask Codex to do anything\n\n{footer}\n  ? for shortcuts                 \u{26a0} 1 warning \u{b7} f2 to view\n"
        )
    }

    /// codex-cli 0.148.0, real pane capture (2026-08-22): the DEFAULT
    /// footer (no `[tui]` section) under the composer.
    #[test]
    fn codex_default_footer_reads_model_effort_and_nothing_else() {
        let pane = "\u{2022} ok\n\u{203a} Ask Codex to do anything\n  xai.grok-4.6 default \u{b7} /local/home/cfu/work/projects/tmux-mobile\n";
        let v = sniff_codex(pane);
        assert_eq!(v.model.as_deref(), Some("xai.grok-4.6"));
        assert_eq!(v.effort.as_deref(), Some("default"));
        assert_eq!(v.context_pct, None, "no context painted in this capture");
        assert_eq!(v.branch, None);
    }

    /// codex-cli 0.148.0, real captures (2026-09-03) with the inherited
    /// `tui.status_line = ["model", "context-used", "current-dir"]`: the
    /// 80-column paint, and the same footer in a 44-column pane, where codex
    /// truncates the cwd with `…` rather than wrapping.
    #[test]
    fn codex_status_line_reads_model_and_context_wide_and_narrow() {
        let wide = "\u{2022} ok\n\u{203a} Ask Codex to do anything\n  openai.gpt-5.6-sol \u{b7} Context 5% used \u{b7} /tmp/tmm-codex-ctx\n";
        let v = sniff_codex(wide);
        assert_eq!(v.model.as_deref(), Some("openai.gpt-5.6-sol"));
        assert_eq!(v.effort, None, "the `model` item carries no effort");
        assert_eq!(v.context_pct, Some(5));

        let narrow = "\u{203a} Ask Codex to do anything\n  openai.gpt-5.6-sol \u{b7} Context 5% used \u{b7} /t\u{2026}\n";
        let v = sniff_codex(narrow);
        assert_eq!(v.model.as_deref(), Some("openai.gpt-5.6-sol"));
        assert_eq!(v.context_pct, Some(5));
    }

    /// Other item orders the owner may configure (measured 2026-09-03):
    /// context first with `model-with-reasoning`, and `context-remaining`,
    /// which says LEFT. Every item is found by shape, so the order is free.
    #[test]
    fn codex_status_line_items_are_found_by_shape() {
        let v = sniff_codex(&codex_pane("  Context 1% used \u{b7} openai.gpt-5.6-sol default \u{b7} /tmp/tmm-codex-ctx"));
        assert_eq!(v.model.as_deref(), Some("openai.gpt-5.6-sol"));
        assert_eq!(v.effort.as_deref(), Some("default"));
        assert_eq!(v.context_pct, Some(1));

        let v = sniff_codex(&codex_pane("  openai.gpt-5.6-sol \u{b7} Context 99% left \u{b7} 13.8K used \u{b7} /tmp/tmm-codex-ctx"));
        assert_eq!(v.model.as_deref(), Some("openai.gpt-5.6-sol"));
        assert_eq!(v.context_pct, Some(1));

        // Narrow: the effort word is cut — a `…` word is not an effort, and
        // the model + context still read.
        let v = sniff_codex(&codex_pane("  Context 1% used \u{b7} openai.gpt-5.6-sol defa\u{2026}"));
        assert_eq!(v.model.as_deref(), Some("openai.gpt-5.6-sol"));
        assert_eq!(v.effort, None);
        assert_eq!(v.context_pct, Some(1));
    }

    /// The context spellings outside the status line: the binary's own
    /// right-footer format string renders `100% context left` at zero use,
    /// and the /status card (captured live) says `96% left (21.5K used / 258K)`.
    /// Both are LEFT; the vital is USED.
    #[test]
    fn codex_context_left_becomes_used() {
        assert_eq!(codex_context_left("  97% context left"), Some(3));
        assert_eq!(codex_context_left("100% context left"), Some(0));
        assert_eq!(
            codex_context_left("\u{2502}  Context window:       96% left (21.5K used / 258K)  \u{2502}"),
            Some(4)
        );
        // A bare percentage, or "left" prose without the context anchors,
        // is never a reading.
        assert_eq!(codex_context_left("97%"), None);
        assert_eq!(codex_context_left("3 tries left (2 used / x)"), None);
        assert_eq!(codex_context_left("101% context left"), None);
        assert_eq!(codex_context_item("Context 101% used"), None);
        assert_eq!(codex_context_item("Context 5%"), None);
        assert_eq!(codex_context_item("5% used"), None);
    }

    /// codex-cli **0.162.1**, real captures (2026-10-15, board #373). The
    /// `model` status-line item stopped painting the catalog SLUG and now
    /// paints its `display_name` — `GPT-6 Astra (Global)`, three
    /// whitespace tokens with a parenthesised route. The owner noticed the
    /// context percentage, not the model: the model segment gated the whole
    /// footer, so one renamed item took the context reading with it and the
    /// reviewer's card showed `vitals: null`.
    ///
    /// First fixture: the live `reviewer` pane (`tmux capture-pane -p -t
    /// tmux-mobile:4`, inherited `tui.status_line = ["model",
    /// "context-used", "current-dir"]`). The rest: an isolated socket with a
    /// scratch CODEX_HOME symlinking the same config.
    #[test]
    fn codex_0_162_paints_the_models_display_name_with_a_route() {
        let live = "\u{203a} Ask Codex to do anything\n\n  GPT-6 Astra (Global) \u{b7} Context 56% used \u{b7} /local/home/cfu/work/projects/tmux-\u{2026}\n  ? for shortcuts                                     \u{26a0}  6 warnings \u{b7} f2 to view\n";
        let v = sniff_codex(live);
        assert_eq!(v.model.as_deref(), Some("GPT-6 Astra (Global)"));
        assert_eq!(v.context_pct, Some(56), "`Context NN% used` is USED, as painted");
        assert_eq!(v.effort, None, "the `model` item carries no effort");

        // The same footer at 100 columns, from the isolated measurement.
        let v = sniff_codex("\u{203a} Ask Codex to do anything\n\n  GPT-6.1 Sol (Global) \u{b7} Context 3% used \u{b7} /tmp/tmm-373-measure/cwd\n");
        assert_eq!(v.model.as_deref(), Some("GPT-6.1 Sol (Global)"));
        assert_eq!(v.context_pct, Some(3));

        // The DEFAULT footer (no `[tui]` section) still appends the effort,
        // now after the route: `<display name> [<effort>] · <cwd>`.
        let v = sniff_codex(&codex_pane("  GPT-6.1 Sol (Global) medium \u{b7} /tmp/tmm-373-measure/cwd"));
        assert_eq!(v.model.as_deref(), Some("GPT-6.1 Sol (Global)"));
        assert_eq!(v.effort.as_deref(), Some("medium"));
        assert_eq!(v.context_pct, None);

        // A route with spaces in it (`us.openai.gpt-6-astra` →
        // `GPT-6 Astra (US cross-region)`) is the same shape.
        let v = sniff_codex(&codex_pane("  GPT-6 Astra (US cross-region) \u{b7} Context 7% used \u{b7} ~/x"));
        assert_eq!(v.model.as_deref(), Some("GPT-6 Astra (US cross-region)"));
        assert_eq!(v.context_pct, Some(7));

        // The older slug form keeps reading — a CLI downgrade is one `npm
        // install` away, and other hosts are on 0.154.x.
        let v = sniff_codex(&codex_pane("  openai.gpt-5.6-sol \u{b7} Context 5% used \u{b7} /tmp/x"));
        assert_eq!(v.model.as_deref(), Some("openai.gpt-5.6-sol"));
        assert_eq!(v.context_pct, Some(5));

        // 20 columns (measured): codex truncates the display name itself and
        // the line loses every `·`, so it is no longer a footer — one
        // missing reading, never a wrong one.
        assert!(codex_footer("GPT-6.1 Sol (Glob\u{2026}").is_none());
    }

    /// Which LINE may be the footer (board #373 review P1, reviewer 01:01:
    /// "context独立可读不等于任意行中的context段都能认证footer"). A
    /// `·`-joined item is not rare enough to authenticate a line, and this
    /// very project types room messages that QUOTE a footer verbatim. So the
    /// footer is where codex paints it — the bottom of the TUI, measured as
    /// the second non-empty line from the bottom on 0.162.1 in every state —
    /// and never a line that wears one of codex's content markers or a
    /// `[tmm …]` stamp.
    #[test]
    fn only_the_bottom_of_the_pane_can_be_the_footer() {
        // The validator's three reproductions, verbatim (01:06). Each line
        // carries a LEGITIMATE context item; none of them is a footer.
        let chat = "\u{203a} [tmm chat 2026-10-15 00:32] human: example \u{b7} Context 3% used \u{b7} /tmp/x\n";
        assert_eq!(sniff_codex(chat), Vitals::default(), "a line we typed is not a reading");
        let prose = "\u{2022} Explanation of footer \u{b7} Context 42% used \u{b7} /tmp/x\n";
        assert_eq!(sniff_codex(prose), Vitals::default(), "codex's own bullet is content");
        let quoted = [
            "\u{2022} the reviewer pane says",
            "    openai.gpt-5.6-sol \u{b7} Context 3% used \u{b7} /tmp/quoted",
            "\u{203a} Ask Codex to do anything",
        ]
        .join("\n");
        assert_eq!(sniff_codex(&quoted), Vitals::default(), "an indented quote ABOVE the composer is not the footer");

        // The real paint, in the shape measured in every state: the composer
        // at column zero, the status line under it, the hints row last.
        let real = [
            "\u{2022} Working (7s \u{2022} esc to interrupt)",
            "\u{203a} Ask Codex to do anything",
            "",
            "  GPT-6.1 Sol (Global) \u{b7} Context 3% used \u{b7} /tmp/x",
            "  ? for shortcuts                      \u{26a0} 1 warning \u{b7} f2 to view",
        ]
        .join("\n");
        let v = sniff_codex(&real);
        assert_eq!(v.model.as_deref(), Some("GPT-6.1 Sol (Global)"));
        assert_eq!(v.context_pct, Some(3));

        // No composer in the capture (a startup screen, a modal): no zone,
        // so no items — a missed reading, never a wrong one. Both the bare
        // line and a capture whose BOTTOM line looks like a footer: without
        // the composer there is nothing to measure the position against.
        assert_eq!(sniff_codex("  GPT-6.1 Sol (Global) \u{b7} Context 3% used \u{b7} /tmp/x\n"), Vitals::default());
        let no_composer = [
            "\u{2022} ok",
            "  GPT-6.1 Sol (Global) \u{b7} Context 3% used \u{b7} /tmp/x",
        ]
        .join("\n");
        assert_eq!(sniff_codex(&no_composer), Vitals::default());

        // The `/status` card is in the SCROLLBACK on purpose: its own anchor
        // authenticates it, so THAT reading keeps the whole pane…
        let card = [
            "  Context window:      97% left (42.9K used / 998K)",
            "\u{203a} Ask Codex to do anything",
            "  ? for shortcuts",
        ]
        .join("\n");
        assert_eq!(sniff_codex(&card).context_pct, Some(3));
        // …but not off a line we typed that quotes it.
        let quoted_card = [
            "\u{203a} [tmm chat 2026-10-15 00:32] human: it said Context window: 97% left (42.9K used / 998K)",
            "\u{203a} Ask Codex to do anything",
            "  ? for shortcuts",
        ]
        .join("\n");
        assert_eq!(sniff_codex(&quoted_card).context_pct, None);
    }

    /// The model item and the context item are read INDEPENDENTLY (board
    /// #373): a `Context NN% used|left` segment anchors the footer on its
    /// own, so the next time codex renames the model item the context
    /// percentage survives. Before this, `codex_footer` returned `None`
    /// without a model and the owner lost both readings at once.
    #[test]
    fn a_context_segment_anchors_the_footer_without_any_model() {
        // A model item in some shape we do not know yet — the next rename —
        // painted where the footer is painted.
        let v = sniff_codex(&codex_pane("  Sol-7 Nova [global tier] \u{b7} Context 42% used \u{b7} /tmp/x"));
        assert_eq!(v.model, None, "unreadable — and that is all that is lost");
        assert_eq!(v.context_pct, Some(42));

        let v = sniff_codex(&codex_pane("  Sol-7 Nova [global tier] \u{b7} Context 42% used"));
        assert_eq!(v.context_pct, Some(42), "the context item needs no cwd beside it");
        assert_eq!(v.model, None);
    }

    /// The /status card on 0.162.1 (captured 2026-10-15 after one real turn
    /// — at zero use codex prints no `Context window` row at all): the LEFT
    /// spelling is unchanged, so the older reading still holds on the
    /// installed CLI.
    #[test]
    fn codex_0_162_status_card_still_says_left() {
        assert_eq!(codex_context_left("  Context window:      97% left (42.9K used / 998K)"), Some(3));
    }

    /// The footer anchors: a model segment (digit-bearing slug, at most one
    /// effort word) plus a cwd or a context segment; prose with a
    /// mid-sentence `·` has neither.
    #[test]
    fn codex_footer_rejects_prose_with_middots() {
        assert!(codex_footer("word \u{b7} another word").is_none(), "no anchor");
        assert!(codex_footer("plainmodel \u{b7} /tmp").is_none(), "no digit");
        assert!(codex_footer("a b c 4 \u{b7} /tmp").is_none(), "too many tokens");
        assert!(codex_footer("gpt-5.2 is fast \u{b7} said nobody").is_none(), "no cwd, no context");
        assert!(
            codex_footer("2 files \u{b7} /tmp/x").is_none(),
            "a bare count is not a model slug"
        );
        let f = codex_footer("gpt-5.2-codex medium \u{b7} ~/my-project").unwrap();
        assert_eq!((f.model.as_deref(), f.effort.as_deref(), f.context_pct), (Some("gpt-5.2-codex"), Some("medium"), None));
    }

    #[test]
    fn claude_official_status_json_becomes_the_canonical_pane_row() {
        let input = r#"{
          "model":{"id":"global.anthropic.claude-fable-5-1","display_name":"Fable 5.1"},
          "context_window":{"total_input_tokens":108450,"context_window_size":200000,"used_percentage":54.2},
          "effort":{"level":"high"}
        }"#;
        assert_eq!(
            claude_status_line(input).as_deref(),
            Some("[CC] · Fable 5.1 · 54% ctx · 108.5K/200K · effort high")
        );
    }

    #[test]
    fn claude_1m_display_name_drops_the_context_suffix() {
        let input = r#"{
          "model":{"id":"global.anthropic.claude-fable-5-1[1m]","display_name":"Fable 5.1 (1M context)"},
          "context_window":{"total_input_tokens":108450,"context_window_size":1000000,"used_percentage":10.8}
        }"#;
        assert_eq!(
            claude_status_line(input).as_deref(),
            Some("[CC] · Fable 5.1 · 11% ctx · 108.5K/1M")
        );
    }

    #[test]
    fn claude_null_context_is_absent_not_a_fake_zero() {
        let input = r#"{
          "model":{"id":"global.anthropic.claude-fable-5-1","display_name":"Fable 5.1"},
          "context_window":{"total_input_tokens":0,"context_window_size":200000,"used_percentage":null}
        }"#;
        assert_eq!(claude_status_line(input).as_deref(), Some("[CC] · Fable 5.1"));
    }

    #[test]
    fn claude_canonical_row_reads_model_context_and_effort() {
        let pane = "● done\n[CC] · Fable 5.1 · 54% ctx · 108.5K/200K · effort high\n❯ ";
        let v = sniff_claude(pane);
        assert_eq!(v.model.as_deref(), Some("Fable 5.1"));
        assert_eq!(v.context_pct, Some(54));
        assert_eq!(v.effort.as_deref(), Some("high"));
        assert!(v.effort_definitive);
    }

    #[test]
    fn claude_narrow_real_capture_keeps_model_and_context_before_truncation() {
        // test:cc_builder resized to 44 columns, Claude Code 2.1.258/Fable 5.1.
        // The rightmost counts are truncated by Claude, but the two card fields
        // lead the row and remain complete.
        let pane = "────────────────────────────────────────────\n❯ \n────────────────────────────────────────────\n  [CC] · Fable 5.1 · 32% ctx · 64.0K/200K…\n  ⏵⏵ bypass permissions on (shift+tab   ·\n";
        let v = sniff_claude(pane);
        assert_eq!(v.model.as_deref(), Some("Fable 5.1"));
        assert_eq!(v.context_pct, Some(32));
    }

    #[test]
    fn claude_sniffer_requires_its_unique_anchor_and_remembers_misses() {
        let session = format!("vitals-claude-{}", std::process::id());
        let fake = "bot · claude-opus-5 · ◑ 44%\n[CC] appears in prose · 90% ctx";
        assert!(sniff_claude(fake).is_empty(), "ordinary output is inert");

        let good = "[CC] · Fable 5.1 · 12% ctx · 24K/200K\n";
        let first = sniff_remembered(&session, "w3", good, "bot", "claude");
        assert_eq!(first.model.as_deref(), Some("Fable 5.1"));
        assert_eq!(first.context_pct, Some(12));
        let missed = sniff_remembered(&session, "w3", "\n❯ ", "bot", "claude");
        assert_eq!(missed.model.as_deref(), Some("Fable 5.1"));
        assert_eq!(missed.context_pct, Some(12));
        retain_windows(&session, &[]);
    }

    /// The wide footer, exactly as captured live (omp 18.0.6, 2026-09-07):
    /// model, thinking level, cwd, cost and the context gauge on one border.
    #[test]
    fn omp_footer_reads_model_effort_and_context() {
        let pane = "some scrollback\n╭── π  > ⬢ Fable 5.1 (Bedrock, 1M) · ◒ high > 📁 /local/home/cfu/work > $0.45 ▶─3%─┃1M───╮\n╰─                            ─╯\n";
        let v = sniff_omp(pane);
        assert_eq!(v.model.as_deref(), Some("Fable 5.1 (Bedrock, 1M)"));
        assert_eq!(v.effort.as_deref(), Some("high"));
        assert_eq!(v.context_pct, Some(3));
        assert!(v.effort_definitive, "the model segment carries the level — seeing it is a verdict");

        // The pre-fix incident's own footer (a second measured spelling).
        let opus = sniff_omp("╭── π  > ⬢ Opus 4.8 (US) · ◒ high > 📁 /local/home/cfu/work > $0.24 ▶─3%─┃1M───╮");
        assert_eq!(opus.model.as_deref(), Some("Opus 4.8 (US)"));
    }

    /// A fresh session has no gauge yet; a narrow pane drops the model and
    /// level segments entirely (both captured live) — every field stands
    /// alone, and `backfill` carries the wide reading over the narrow one.
    #[test]
    fn omp_footer_survives_its_responsive_forms() {
        let fresh = sniff_omp("╭── π  > ⬢ Fable 5.1 (Bedrock, 1M) · ◒ high > 📁 /local/home/cfu/work ▶────────╮");
        assert_eq!(fresh.model.as_deref(), Some("Fable 5.1 (Bedrock, 1M)"));
        assert_eq!(fresh.effort.as_deref(), Some("high"));
        assert_eq!(fresh.context_pct, None, "no gauge yet on a fresh session");

        let narrow = sniff_omp("╭── π  > 📁 …work ▶────13%────────────────────┃────1M───╮");
        assert_eq!(narrow.model, None);
        assert_eq!(narrow.effort, None);
        assert!(!narrow.effort_definitive, "no model segment, no verdict");
        assert_eq!(narrow.context_pct, Some(13));
    }

    /// Boxes without the π mark — tool cards, plain output, the box the
    /// composer draws — are somebody else's furniture; and a percentage
    /// outside the ▶ gauge is never context.
    #[test]
    fn omp_sniffer_ignores_foreign_boxes_and_stray_percents() {
        assert!(sniff_omp("╭───────────╮\n│ tool card │\n╰───────────╯").is_empty());
        assert!(sniff_omp("π appears in prose · 90% off\nplain ❯ prompt").is_empty());
        // A π border whose cwd carries a % stays out of the gauge reading.
        let v = sniff_omp("╭── π  > 📁 /tmp/50%-done ▶──────╮");
        assert_eq!(v.context_pct, None, "the gauge starts at ▶");
        assert!(sniff_omp("").is_empty());
    }
}
