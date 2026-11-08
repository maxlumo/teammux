//! The codex backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// queue|steer for codex (board #245, measured on codex-cli 0.154.0). Enter
/// while a task runs STEERS (`turn/steer`): the line's prompt hook fired
/// inside the running turn, its one Stop answered the second sender, and the
/// first sender never got a reply. Codex has no mode key; its documented
/// keymap is the door — `tui.keymap.composer.queue = "enter"` with
/// `composer.submit = "tab"` (one key may not be bound twice in a context, so
/// submit moves to Tab, which a person in the pane can still use to steer).
/// Measured: the line then waited for the turn, came back through the prompt
/// hook as its own turn and was answered to its own sender; an idle Enter
/// still submits at once, slash commands included.
pub(crate) const SWITCHES_INPUT_MODE: bool = true;

/// The keymap overrides that carry the definition's input mode (see
/// `SWITCHES_INPUT_MODE`). Launch-line `-c` like every other codex key:
/// `config.toml` in the isolated home is a symlink into the user's own and is
/// never written. BOTH modes pin BOTH bindings (validator, #245): steer is
/// codex's defaults (`submit = "enter"`, `queue = "tab"`), written out because
/// the user's own config.toml may remap them, and an agent set to steer must
/// not queue because of a key in a file the definition does not own.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn input_mode_keymap_overrides(steer: bool) -> [String; 2] {
    let (submit, queue) = if steer { ("enter", "tab") } else { ("tab", "enter") };
    [
        shared::codex_config_override("tui.keymap.composer.queue", Value::String(queue.into())),
        shared::codex_config_override("tui.keymap.composer.submit", Value::String(submit.into())),
    ]
}

/// codex `model_reasoning_effort` (its ReasoningEffort enum): minimal..xhigh
/// (measured 2026-08-22).
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["minimal", "low", "medium", "high", "xhigh"]
}

/// codex models, for the config the user runs (`~/.codex/config.toml`, which
/// every managed home links and whose provider the managed `--profile`
/// never overrides).
///
/// A config that names a catalog (`model_catalog_json`) is AUTHORITATIVE: the
/// bedrock-runtime endpoint rejects any other spelling with
/// `validation_error: The provided model identifier is invalid` (measured on
/// codex-cli 0.154.0, board #231 — `gpt-5.6-sol` fails where
/// `global.openai.gpt-5.6-sol` answers), so a bare slug is refused at save.
///
/// A config that names none (board #70) keeps the provider's catalog BUILT
/// IN (codex-cli 0.166.0: neither the UST nor the Bedrock config names a
/// file, and both used to answer "nothing to list"). Codex renders that
/// effective catalog itself, `codex debug models` (`debug_model_ids`); it is
/// offered as SUGGESTIONS, because a custom provider may serve ids codex
/// does not list (UST's `/v1/models` serves every listed id and many more,
/// measured 2026-11-07). A codex that cannot answer is `CliFailed`: the
/// picker says so and typed ids stay accepted.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn model_list() -> Result<(Vec<String>, super::ModelKind), super::ModelReason> {
    model_list_stamped().1
}

/// `model_list` with the stamp of the config text it was derived from
/// (board #70 review R1): ONE read of `config.toml` gives both, so the cache
/// never stores one config's list under another config's stamp.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn model_list_stamped() -> (Option<String>, Result<(Vec<String>, super::ModelKind), super::ModelReason>) {
    match super::read_model_source(&codex_user_home().join("config.toml")) {
        Err(r) => (None, Err(r)),
        Ok(None) => (None, Err(super::ModelReason::NotListed)),
        Ok(Some(config)) => (Some(stamp_of(&config)), list_of(&config)),
    }
}

/// The list one config text declares (`model_list`'s rules).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn list_of(config: &str) -> Result<(Vec<String>, super::ModelKind), super::ModelReason> {
    use super::ModelReason::{Invalid, Unreadable};
    config.parse::<toml::Table>().map_err(|_| Invalid)?;
    let Some(path) = catalog_path(config) else {
        return listed_by_codex(config).map(|ids| (ids, super::ModelKind::Suggestions));
    };
    // A catalogue that IS named but cannot be read is a failure, not stock.
    let catalog = super::read_model_source(&path)?.ok_or(Unreadable)?;
    let slugs = catalog_slugs_whole(&catalog).ok_or(Invalid)?;
    Ok((slugs, super::ModelKind::Authoritative))
}

/// What the model cache keys a codex list on (board #70): the SHA-256 of
/// the config's text, so a provider switch is a new list at the next ask,
/// not after the cache period. A digest, never the text (validator S1): a
/// config can carry credentials, and no config enters the cache. `None`
/// when it cannot be read (nothing is cached apart).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn model_list_stamp() -> Option<String> {
    super::read_model_source(&codex_user_home().join("config.toml")).ok().flatten().map(|c| stamp_of(&c))
}

/// The stamp of one config text.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn stamp_of(config: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(config.as_bytes()))
}

/// `codex debug models` for `config`, in the environment a pane gets
/// (`readiness::codex_models`: the baseline login shell, a private scratch
/// `CODEX_HOME` holding a copy of the config, removed after the run, since
/// codex writes into its home).
#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
fn listed_by_codex(config: &str) -> Result<Vec<String>, super::ModelReason> {
    let deadline = std::time::Instant::now() + super::readiness::MODELS_BUDGET;
    super::readiness::codex_models(config, deadline).map_err(|_| super::ModelReason::CliFailed)
}

/// Under test the host codex is never run: a stand-in answers what the test
/// staged (default: a failure, which refuses nothing) and records the
/// config it was asked about.
#[cfg(test)]
fn listed_by_codex(config: &str) -> Result<Vec<String>, super::ModelReason> {
    cli_stand_in::ask(config)
}

#[cfg(test)]
pub(crate) mod cli_stand_in {
    use std::sync::Mutex;
    type Staged = Option<Result<Vec<String>, crate::backends::ModelReason>>;
    static ANSWER: Mutex<Staged> = Mutex::new(None);
    static ASKED: Mutex<Option<String>> = Mutex::new(None);
    static REWRITE: Mutex<Option<String>> = Mutex::new(None);
    /// While the next ask runs, the user's config.toml becomes `text`: a
    /// config changed between the read and the answer (review R1).
    pub(crate) fn rewrite_during_ask(text: &str) {
        *REWRITE.lock().unwrap() = Some(text.to_string());
    }
    pub(crate) fn answer(a: Result<Vec<String>, crate::backends::ModelReason>) {
        *ANSWER.lock().unwrap() = Some(a);
    }
    /// The config of the last ask, cleared by reading it.
    pub(crate) fn asked() -> Option<String> {
        ASKED.lock().unwrap().take()
    }
    pub(super) fn ask(config: &str) -> Result<Vec<String>, crate::backends::ModelReason> {
        *ASKED.lock().unwrap() = Some(config.to_string());
        if let Some(text) = REWRITE.lock().unwrap().take() {
            std::fs::write(super::codex_user_home().join("config.toml"), text).unwrap();
        }
        ANSWER.lock().unwrap().clone().unwrap_or(Err(crate::backends::ModelReason::CliFailed))
    }
}

/// The ids `codex debug models` OFFERS (board #70, shape measured on
/// codex-cli 0.166.0, a debug subcommand, so bound to that version): every
/// `models[]` entry has a string `slug` and `visibility`; `"list"` is what
/// codex's own picker shows, `"hide"` (internal reviewers, experiments) is
/// not. Read whole: an entry outside that shape means an answer this parser
/// does not know, so `None`, never a shorter list.
pub(crate) fn debug_model_ids(stdout: &[u8]) -> Option<Vec<String>> {
    let v: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    let mut ids = Vec::new();
    for m in v.get("models")?.as_array()? {
        let slug = m.get("slug")?.as_str()?;
        if m.get("visibility")?.as_str()? == "list" {
            ids.push(slug.to_string());
        }
    }
    (!ids.is_empty()).then_some(ids)
}

/// The baseline default: the user's `config.toml` `model` — the file the
/// isolated home links, whose model applies when the profile names none
/// (`codex_profile` omits it for an empty definition).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn baseline_model() -> Result<Option<String>, super::ModelReason> {
    let Some(config) = super::read_model_source(&codex_user_home().join("config.toml"))? else { return Ok(None) };
    let table = config.parse::<toml::Table>().map_err(|_| super::ModelReason::Invalid)?;
    Ok(codex_user_model(&table))
}

/// The pure half of the baseline: the top-level `model` string.
pub(crate) fn codex_user_model(config: &toml::Table) -> Option<String> {
    config.get("model").and_then(toml::Value::as_str).map(str::to_string)
}

/// The catalogue's slugs, ALL of them or `None` (board #511): it is
/// authoritative, so an entry without a string slug makes it unusable rather
/// than a shorter whitelist.
pub(crate) fn catalog_slugs_whole(json: &str) -> Option<Vec<String>> {
    let v = serde_json::from_str::<serde_json::Value>(json).ok()?;
    let slugs = v
        .get("models")?
        .as_array()?
        .iter()
        .map(|m| m.get("slug").and_then(serde_json::Value::as_str).map(str::to_string))
        .collect::<Option<Vec<_>>>()?;
    (!slugs.is_empty()).then_some(slugs)
}

/// The `model_catalog_json` path out of a codex `config.toml`, if any.
fn catalog_path(config: &str) -> Option<std::path::PathBuf> {
    let table = config.parse::<toml::Table>().ok()?;
    table.get("model_catalog_json").and_then(toml::Value::as_str).map(std::path::PathBuf::from)
}


/// Where the user's own codex lives — `CODEX_HOME` when the user set it,
/// else `~/.codex`. Only read, never written.
#[cfg(not(test))]
pub(crate) fn codex_user_home() -> std::path::PathBuf {
    if let Some(h) = std::env::var_os("CODEX_HOME").filter(|h| !h.is_empty()) {
        return std::path::PathBuf::from(h);
    }
    std::env::var_os("HOME").map(std::path::PathBuf::from).unwrap_or_default().join(".codex")
}

/// Under test the user's home is a per-process temp dir (kimi's pattern,
/// board #216): a test that validates a model must never read — or depend
/// on — the developer's real `~/.codex`.
#[cfg(test)]
pub(crate) fn codex_user_home() -> std::path::PathBuf {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    // Earlier runs' homes are reclaimed at the door (board #268).
    DIR.get_or_init(|| crate::config::fresh_process_dir("tmm-codex-user-home")).clone()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::{looks_like_model, Vitals};

/// codex's status furniture, measured on codex-cli 0.148.0 (2026-08-22,
/// re-measured 2026-09-03).
///
/// The persistent footer under the composer is the configurable
/// `tui.status_line`: `·`-joined items in the order the config lists them.
/// The inherited `~/.codex/config.toml` sets `["model", "context-used",
/// "current-dir"]`, which paints
/// `openai.gpt-5.6-sol · Context 5% used · /tmp/x` — and, at 44 columns,
/// `openai.gpt-5.6-sol · Context 5% used · /t…` (codex TRUNCATES the line with
/// `…`, it never wraps). The default footer (no `[tui]` section) is
/// `<model> [<effort>] · <cwd>`, and `context-remaining` spells
/// `Context 99% left`, so every item is found BY SHAPE, not by position:
/// a `Context NN% used|left` segment is the context, a segment starting
/// `/`/`~` is the cwd, and the rest is `<model> [<effort>]`.
///
/// WHICH LINE is the footer is a separate question from what its items say,
/// and the answer is a POSITION, not a pattern (board #373 review P1,
/// reviewer and validator 01:01–01:06, orchestrator ruling 01:06). A
/// `·`-joined item is not rare enough to authenticate a line: the validator
/// reproduced three readings off ordinary content — an indented quote of a
/// footer, a sentence containing `· Context 42% used ·`, and a `[tmm chat]`
/// line we had typed ourselves (this project's own room messages quote
/// footers verbatim). So only `footer_zone` may be read for items.
///
/// Context is also spelled `NN% context left` (codex's right-footer format
/// string; `100% context left` is its zero-use rendering) and, in the
/// `/status` card, `NN% left (21.5K used / 258K)` — both say LEFT where kiro
/// says USED, so those readings are `100 - NN`. Those two scan the WHOLE
/// pane, because the card is in the scrollback and their anchors do
/// authenticate themselves (the literal `% context left`, or `% left (`
/// together with `used /`); they take the same line guard below.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_codex(pane: &str) -> Vitals {
    let mut v = Vitals::default();
    // The status-line ITEMS come only from where codex paints them.
    for line in footer_zone(pane) {
        if let Some(f) = codex_footer(line) {
            if v.model.is_none() {
                if let Some(m) = f.model {
                    v.model = Some(m);
                    v.effort = f.effort;
                }
            }
            if v.context_pct.is_none() {
                v.context_pct = f.context_pct;
            }
        }
    }
    // The self-anchored spellings read from the whole pane, because the
    // `/status` card is in the scrollback — but never off a line that is
    // somebody's content.
    if v.context_pct.is_none() {
        for line in pane.lines().rev().filter(|l| !codex_content_line(l)) {
            if let Some(pct) = codex_context_left(before_thread_title(line)) {
                v.context_pct = Some(pct);
                break;
            }
        }
    }
    v
}

/// The lines of a capture that MAY be the status line, newest first.
///
/// The footer is a POSITION: codex paints it at the bottom of its TUI, under
/// the COMPOSER — `›` (or `>`) at column zero, the one line nothing else can
/// be — as the LAST TWO non-empty lines of the capture. Measured on
/// codex-cli 0.162.1 (2026-10-15) in every state we could produce — idle,
/// mid-turn (`• Working (7s • esc to interrupt)`), just after a turn, with
/// the `/status` card open, at 20/28/36/44/100 columns, and on the live
/// reviewer pane — those two are always the status line and then
/// `? for shortcuts … ⚠ N warnings`. The status line never wraps (codex
/// truncates it with `…`), so there is no third; the second candidate is
/// there only for a build that drops the hints row, and the hints row
/// itself carries no item, so offering both costs nothing.
///
/// Two boundaries this had to learn the hard way (board #373 P1, reviewer
/// 01:01 and 01:21):
///
/// * the window is counted in RAW lines and the content markers reject
///   AFTERWARDS. Filtering first and then taking N reaches N *surviving*
///   lines up the screen, which is further than N lines — the reviewer's
///   second case, where a one-line slack let a quoted footer in the
///   composer's own input supply a context percentage to a real default
///   footer that had none. A wrong number beside a right model is the worst
///   shape this code can produce;
/// * the composer may be MANY lines (everything typed into it wraps under
///   its `›` line), and those lines sit between the composer and the footer.
///   Counting from the BOTTOM is what makes their number irrelevant.
///
/// What this keeps out is the whole class the reviewer and the validator
/// found: everything above those two lines — prose, a tool's output, an
/// indented quote of a footer, a `[tmm chat]` line we typed ourselves, the
/// composer's own input — is not the footer, whatever it contains. A capture
/// with no composer line (a startup screen, a modal) has no zone and yields
/// no items; a missed reading is covered by `sniff_remembered`'s memory, and
/// is always better than a confident wrong one.
///
/// The residuals, named as narrowly as they are true (reviewer's P2, #373):
/// this excludes everything above the last two non-empty lines, not every
/// quotation. Still readable: a capture with a composer and NO footer whose
/// last two lines are unmarked content (live, only a pane mid-paint); and a
/// footer with NO hints row under it, where the second candidate is then the
/// content directly above the footer, so an unmarked quote there can lend an
/// item the real footer does not paint. `codex_context_left`'s whole-pane
/// scan has its own, wider exposure, bounded by its anchors and the marker
/// guard alone. All of them would need a text pattern for codex's own
/// furniture to close, which is what rotted in #346 and #361.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn footer_zone(pane: &str) -> Vec<&str> {
    let lines: Vec<&str> = pane.lines().map(str::trim_end).collect();
    // The LAST composer line: a resumed pane holds older ones in scrollback.
    let Some(composer) = lines.iter().rposition(|l| is_composer_line(l)) else {
        return Vec::new();
    };
    let mut zone: Vec<&str> = lines[composer + 1..]
        .iter()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(FOOTER_ZONE_LINES)
        .copied()
        .collect();
    // Rejection AFTER selection, never as part of it (see above).
    zone.retain(|l| !codex_content_line(l));
    zone
}

/// How many non-empty lines at the BOTTOM of a capture may be the footer:
/// the status line and the hints row under it, as measured (`footer_zone`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const FOOTER_ZONE_LINES: usize = 2;

/// codex's composer prompt at COLUMN ZERO — `› Ask Codex to do anything`,
/// `› /status`, `› ` with whatever is being typed (measured 0.162.1; `>` is
/// the ascii fallback). Column zero is the point: an indented `›` is a quote
/// inside somebody's content, and the footer and the hints row are both
/// indented by two spaces.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_composer_line(line: &str) -> bool {
    line.starts_with('\u{203a}') || line.starts_with('>')
}

/// True when the line is somebody's CONTENT rather than codex's own
/// furniture, so no reading may come off it (board #373 review P1; kiro's
/// identical rule is #346). Measured markers on this host: a line beginning
/// with one of codex's block glyphs — `›` the composer stamp, `•` its
/// message and progress bullet (`• PONG`, `• Working (7s • esc to
/// interrupt)`), `■` an error block (0.154.0, board #362: `■ unexpected
/// status 401 Unauthorized …`), `>` the ascii fallback — or a line carrying
/// a `[tmm …]` stamp, which is a line WE typed into the pane and whose body
/// may quote a footer verbatim. The zone's position does the rest: a wrapped
/// continuation of such a block carries no marker of its own.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn codex_content_line(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with(['\u{203a}', '\u{2022}', '\u{25a0}', '>'])
        || line.contains("[tmm chat ")
        || line.contains("[tmm status ")
        || line.contains("[tmm done]")
}

/// The CLI version each of codex's recovery shapes was MEASURED on (board
/// #362): codex has no TRANSIENT shape (capture first, #362 d), only the
/// one error that needs a person, `auth_expired` (`person_paint`), painted
/// by codex-cli 0.154.0 in lingting:reviewer and video-factory:critic
/// (10-14 and 10-15; the version asked of the running binary, which the
/// installed 0.162.1 had replaced on disk).
pub(crate) const RECOVERY_SHAPES: &[super::Measured] = &[
    super::Measured { shape: "auth_expired", version: "0.154.0", at_most: false, screen_grammar: true, words: "auth expired" },
];

/// The program whose `--version` names the codex-cli a pane runs.
pub(crate) const VERSION_PROGRAM: &str = "codex";

/// The NEWEST paint on a codex screen, when it is the error that needs a
/// person (board #362 c): `(shape, block)`, the block de-wrapped (lines
/// trimmed, joined without a separator). codex-cli 0.154.0, measured at 80
/// columns, paints a failed request's 401 as one column-zero block under its
/// error glyph, hard-wrapped at column zero with no indent, and then sits at
/// its composer (the hooks report no end for that turn, so the derived state
/// stayed `running` for hours):
/// `■ unexpected status 401 Unauthorized: Authentication failed: Please make sure` /
/// `your API Key is valid., url:` /
/// `https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses, request id:` /
/// `<uuid>`. The Bedrock credentials expired (Midway); no `continue` can
/// fix it, `mwinit` and a restart do. A hit is the block that opens with
/// `■` and those words, names `bedrock-runtime` and ends with a request id.
/// Newest is positional, as `footer_zone` is: the block is above the LAST
/// composer line and no content line (`codex_content_line`: a message, a
/// tool call, a submitted prompt, a `Working` row, another error) sits
/// between them. The same paint above later work is history (condition a);
/// a screen with no composer, or whose last `›` is a prompt we typed with
/// its continuation under it, is a screen mid-paint and says nothing.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn person_paint(pane: &str) -> Option<(&'static str, String)> {
    let (block, _) = newest_block(pane)?;
    bedrock_401(&block).then_some(("auth_expired", block))
}

/// The NEWEST content block on a codex screen, by the positional reading
/// above (`person_paint`'s grammar, generalised for board #362: the
/// orchestrator's ruling on the builder's 02:30 finding), as `(glued,
/// spaced)`. codex has no transient shape (capture first, #362 d), so today
/// only the person paint reads it; a transient shape added later is newest
/// by this same reading.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn newest_block(pane: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = pane.lines().map(str::trim_end).collect();
    let composer = lines.iter().rposition(|l| is_composer_line(l))?;
    // The composer is codex's own furniture only at the BOTTOM, with at most
    // the footer zone under it, and never a line we typed: a submitted prompt
    // is also `›` at column zero, and on a half-drawn screen (the real
    // composer not painted yet) the last `›` would be that prompt.
    if lines[composer].contains("[tmm ") || lines[composer + 1..].iter().filter(|l| !l.trim().is_empty()).count() > FOOTER_ZONE_LINES {
        return None;
    }
    let head = lines[..composer].iter().rposition(|l| codex_content_line(l))?;
    let block: Vec<&str> = lines[head..composer].iter().take_while(|l| !l.trim().is_empty()).map(|l| l.trim()).collect();
    Some((block.concat(), block.join(" ")))
}

/// Is this de-wrapped codex block exactly the expired-credential error: the
/// `■` glyph, `unexpected status 401 Unauthorized`, a `bedrock-runtime` url,
/// and a request id uuid at its end? The SENTENCE alone; `person_paint` is
/// what decides it is the newest paint (review P1-B: kept apart).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn bedrock_401(block: &str) -> bool {
    let c = super::canonical(block);
    block.starts_with('\u{25a0}')
        && c.starts_with("unexpectedstatus401unauthorized")
        && c.contains("bedrockruntime")
        && block.rsplit_once("request id:").map(|(_, id)| id.trim()).is_some_and(super::is_uuid)
}

pub(crate) struct CodexFooter {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) context_pct: Option<u8>,
}

/// One `tui.status_line` paint → its readings, or `None` when the line does
/// not have the footer's anchors (see `sniff_codex`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn codex_footer(line: &str) -> Option<CodexFooter> {
    let mut model: Option<(String, Option<String>)> = None;
    let mut context_pct = None;
    let mut cwd = false;
    for seg in before_thread_title(line).split('\u{b7}').map(str::trim) {
        if seg.starts_with('/') || seg.starts_with('~') {
            cwd = true;
        } else if let Some(pct) = codex_context_item(seg) {
            context_pct = context_pct.or(Some(pct));
        } else if model.is_none() {
            model = codex_model_item(seg);
        }
    }
    let (model, effort) = match model {
        Some((m, e)) => (Some(m), e),
        None => (None, None),
    };
    // The readings are INDEPENDENT (board #373, codex-cli 0.162.1): a
    // `Context NN% used|left` segment is anchor enough on its own — the
    // literal word, a percentage and `used`/`left` do not line up by
    // accident — so an unreadable model item costs the model and nothing
    // else. It used to gate the whole footer, and when 0.162.1 renamed the
    // item (slug → `GPT-6 Astra (Global)`) the context percentage went null
    // with it. A cwd segment alone is NOT an anchor: `/`-leading words
    // occur in ordinary output, so that half still needs the model.
    (context_pct.is_some() || (model.is_some() && cwd)).then_some(CodexFooter {
        model,
        effort,
        context_pct,
    })
}

/// The part of a status line that may carry items: everything up to and
/// including the first cwd segment. codex-cli 0.166.0 paints the thread title
/// AFTER the cwd, in its default footer and in the managed launch's
/// `tui.status_line` alike (board #5, measured 2026-11-05), and the title is
/// free text: codex names the thread from its first message, which for a
/// managed agent is a room message that may quote a footer. So nothing after
/// the cwd is read. A line with no cwd segment is returned whole.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn before_thread_title(line: &str) -> &str {
    let line = line.trim();
    let mut end = 0;
    for seg in line.split('\u{b7}') {
        end += seg.len();
        let t = seg.trim();
        if t.starts_with('/') || t.starts_with('~') {
            return &line[..end];
        }
        end += '\u{b7}'.len_utf8();
    }
    line
}

/// `<model> [<effort>]`, in either spelling codex has painted:
///
/// * the catalog SLUG — `xai.grok-4.6`, `gpt-5.2-codex`, `openai.gpt-5.6-sol`
///   (0.148.0 … 0.154.0) — one lowercase token carrying a digit;
/// * a one-token `display_name` — `GPT-6-Astra` (0.166.0, measured
///   2026-11-05, board #5) — letters, digits, `.` and `-`, carrying both a
///   letter and a digit;
/// * the catalog `display_name` — `GPT-6 Astra (Global)`,
///   `GPT-6 Astra (US cross-region)` (0.162.1, measured 2026-10-15, board
///   #373) — up to three name words then a parenthesised route.
///
/// The effort, when present, is one plain lowercase word after either form
/// (`GPT-6.1 Sol (Global) medium`, the default footer on 0.162.1); a
/// `…`-truncated word (`defa…`) is not an effort.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn codex_model_item(seg: &str) -> Option<(String, Option<String>)> {
    let seg = seg.trim();
    // The whole item may be the model (no effort painted).
    if let Some(model) = codex_model_name(seg) {
        return Some((model.to_string(), None));
    }
    // Otherwise the LAST word is the effort and the head is the model. The
    // effort is split off by position rather than looked up by word, so a
    // `…`-cut one (`defa…`) still leaves the model readable — it just is
    // not an effort.
    let (head, last) = seg.rsplit_once(char::is_whitespace)?;
    let model = codex_model_name(head.trim_end())?;
    Some((model.to_string(), is_effort_word(last).then(|| last.to_string())))
}

/// One plain lowercase word — codex's own effort levels are spelled that way,
/// and a `…`-cut word is not one.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn is_effort_word(w: &str) -> bool {
    !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase())
}

/// The model half of a footer item, with no effort on it: the slug form or
/// the 0.162.1 `display_name` form (see `codex_model_item`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn codex_model_name(s: &str) -> Option<&str> {
    if let Some(named) = s.strip_suffix(')') {
        // `<Name words> (<route>)`. The route is what tells this apart from
        // prose: a sentence does not end in a parenthesis whose opener sits
        // after one to three version-bearing name words. A path or a kiro
        // branch segment (`(feat/x)`) has no name part and no route words.
        let (name, route) = named.rsplit_once('(')?;
        let name = name.trim_end();
        let route = route.trim();
        let route_ok = !route.is_empty()
            && route.split_whitespace().count() <= 4
            && !route.contains('/')
            && route.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '.');
        let words: Vec<&str> = name.split_whitespace().collect();
        let name_ok = (1..=3).contains(&words.len())
            && words.iter().all(|w| looks_like_model_word(w))
            && words.iter().any(|w| w.chars().any(|c| c.is_ascii_digit()));
        return (route_ok && name_ok).then_some(s);
    }
    // One token: the lowercase slug, or (0.166.0) a one-token display name.
    let mut toks = s.split_whitespace();
    let model = toks.next()?;
    if toks.next().is_some() {
        return None;
    }
    let one_token = looks_like_model(model) || looks_like_model_word(model);
    (one_token && model.chars().any(|c| c.is_ascii_digit())).then_some(model)
}

/// A word a model's display name may be made of: letters, digits, `.`, `-`,
/// starting with a letter or a digit. `GPT-6.1`, `Sol`, `Astra` — but not a
/// count (`2`, no letter) and not a lowercase connective (`is`, no digit; the
/// digit is required of the name as a whole, not of each word).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn looks_like_model_word(w: &str) -> bool {
    !w.is_empty()
        && w.len() <= 24
        && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && w.chars().any(|c| c.is_ascii_alphabetic())
        && w.starts_with(|c: char| c.is_ascii_alphanumeric())
}

/// `Context 5% used` (`context-used`) → 5; `Context 99% left`
/// (`context-remaining`) → 1. The literal `Context` word is the anchor: a
/// bare `5%` is never accepted.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn codex_context_item(seg: &str) -> Option<u8> {
    let rest = seg.strip_prefix("Context")?.trim_start();
    let (num, tail) = rest.split_once('%')?;
    let n = num.trim().parse::<u16>().ok().filter(|n| *n <= 100)?;
    match tail.trim() {
        "used" => Some(n as u8),
        "left" => Some((100 - n) as u8),
        _ => None,
    }
}

/// `NN% context left` (right footer) or `NN% left (… used / …)` (/status
/// card) → share of the context USED (`100 - NN`), matching kiro's own
/// wording for `Vitals::context_pct`. The trailing words are the anchor: a
/// bare `NN%` is never accepted (same rule as kiro's pie-glyph requirement).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn codex_context_left(line: &str) -> Option<u8> {
    let s = line.trim().trim_matches('\u{2502}').trim();
    let idx = s.find("% context left").or_else(|| {
        let i = s.find("% left (")?;
        // The /status shape must really be the context card, not prose.
        s.contains("used /").then_some(i)
    })?;
    let digits: String = s[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let left = digits.parse::<u16>().ok().filter(|n| *n <= 100)?;
    Some((100 - left) as u8)
}


use serde_json::{json, Value};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::{patch_hooks, Rendered};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn codex_hooks(notify: &str) -> Value {
    json!({
        "PreToolUse":  [ { "matcher": "*", "hooks": [ { "type": "command", "command": notify } ] } ],
        "PostToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": notify } ] } ],
        // Same turn-start contract as claude's (measured, codex-cli 0.148.0:
        // payload {hook_event_name:"UserPromptSubmit", prompt, session_id} on
        // hook stdin). Codex has NO StopFailure event (binary strings checked),
        // so `failed` cannot be derived for it.
        "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "PermissionRequest": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        // Board #28 (0.166.0): fires at a new session's first prompt with its
        // id, so the hub records the conversation a restart resumes.
        "SessionStart": [ { "hooks": [ { "type": "command", "command": notify } ] } ],
        "Stop": [ { "hooks": [ { "type": "command", "command": notify } ] } ]
    })
}

/// codex 0.166.0's composer completes a trailing `@word` into a file path,
/// dropping the `@` too, on the Enter that should submit the line, and does
/// not submit it (board #36, measured 2026-11-05 on a scratch gateway with real managed agents; a workspace holding `README.md` and `src/lib/files/FilePreview.render.ts`): a trailing `@reviewer` became
/// `src/lib/files/FilePreview.render.ts`, unsent. Typed as `＠`, the line
/// submitted unchanged. So a delivery types every `@` as `＠`, as for kiro.
pub(crate) const AT_OPENS_FILE_PICKER: bool = true;

/// A managed codex compacts its conversation once a request's input reaches
/// this many tokens (board #66 item 2): `model_auto_compact_token_limit` in
/// the managed profile (`shared::codex_profile`), so a long chat compacts
/// before the provider refuses its body. Derived from the provider's
/// measured limit (orchestrator, #66 note 5): the UST gateway refuses a body
/// over 10 MB (10,467,328 bytes taken, 10,531,840 refused, `live-check
/// codex-limit`); the team's codex rollouts ran at most 8.7 bytes per input
/// token, so 10,467,328 / 8.7 = 1,203,141 tokens, x 0.6 margin = 721,885,
/// rounded down. Below codex's own threshold for the window (1,050,000
/// configured, clamped to the catalogue's 872,000), so it takes effect.
/// Measured on 0.166.0 in the same check: a profile file's limit is taken
/// (2000: one compaction over two turns; none: no compaction). It does not
/// address `max_output_tokens` stops: requests succeeded up to 807,802
/// input tokens, so input size is not shown to cause them.
pub(crate) const AUTO_COMPACT_TOKENS: i64 = 700_000;

/// Is one of codex's own pickers or menus open on `screen` (board #66,
/// measured on codex-cli 0.166.0 in the live rig, `live-check
/// codex-picker`)? While one is open the composer is gone and a typed key
/// answers it: a delivery typed into `/new`'s "Where should the new
/// conversation run?" had its `2` (of `2026`) pick "Create new Git
/// worktree", and the rest of the line became the prompt. By place and
/// shape, never by a phrase anywhere: codex paints a menu's key hints as the
/// screen's bottom furniture, a row of `<key> <action>` pairs (joined by
/// ` · ` or by runs of spaces) one of which is an `esc` action: `enter
/// select · esc back` (`/new`, `/model`), `space toggle · enter save · esc
/// save/close` (`/experimental`, round 1: validator's note 10 — a reading by
/// the first key missed it), `enter resume   esc exit   ^c exit …` above
/// one more hint line (`/resume`). An open composer ends with `? for
/// shortcuts`, its status line (pairs, none an `esc` action) or the single
/// `esc again to edit previous message` (one pair); a running turn's `esc to
/// interrupt` sits above the composer, never at the bottom.
pub fn picker_open(screen: &str) -> bool {
    let hints = |line: &str| {
        let pairs: Vec<&str> = line.split(" \u{b7} ").flat_map(|p| p.split("   ")).map(str::trim).filter(|p| !p.is_empty()).collect();
        pairs.len() >= 2 && pairs.iter().any(|p| p.starts_with("esc "))
    };
    screen.lines().rev().filter(|l| !l.trim().is_empty()).take(2).any(hints)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_codex(
    def: &RegAgent, _name: &str, home: &Path, workspace: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {

    let codex_home = home.join("codex");
    // No create_dir_all by pathname: the inheritance holds the codex home
    // through the private walk, creating it, before anything in it changes.
    shared::inherit_codex_system_files(&codex_home)?;
    // Board #452: a launch before this build had codex write its shell-state
    // cache here, a copy of the pane shell's whole exported environment
    // (secrets included). The line below turns the cache off; this removes
    // what earlier launches left, through the held codex home (refused, and
    // the render with it, for anything that is not our own regular file).
    crate::safe_fs::remove_codex_snapshots(&codex_home)?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    let notify = notifications.helper_command("codex");

    // The definition's identity and MCP servers are a FILE, like every other
    // backend's (board #448; model and effort since #455, non-negotiable 10):
    // the managed profile, written whole and privately on every render, and
    // selected with --profile. Neither a value nor the model is on the line.
    // Measured on 0.162.1 (#455): a fresh launch, `resume --last` and
    // `resume <id>` all take the profile's model and effort; a TRUSTED project
    // config is above the profile (the #448 boundary), and a person's
    // `/model` default lands in this file until the next render.
    shared::write_atomic(
        &codex_home.join(shared::codex_profile_file()),
        &shared::codex_profile(&crate::projects::spawn::mcp_defs(def), &def.model, &def.effort),
    )?;
    // The line answers the startup screens and the shared background server
    // (board #457), so a managed pane neither starts nor connects to codex's
    // app-server daemon: `--no-daemon` is codex's own documented door ("Run
    // without the shared background server, even if it is already running",
    // `codex --help` and `codex resume --help`, 0.162.1). Measured on 0.162.1:
    // a plain launch starts a daemon that copies the release into the home,
    // outlives the pane and updates itself (it had fetched 0.163.0 within the
    // hour), and a plain launch CONNECTS to a daemon already running there;
    // with this flag, fresh, `resume --last` and `resume <id>` start none, and
    // none connects to a daemon another entry started, which is left alone
    // (fresh against a 0.163.0 daemon: kiro's X1; both resumes against a
    // 0.162.1 daemon: the validator's R3/R4, both on #457).
    let mut config_args: Vec<String> = vec![format!("--profile {}", shared::CODEX_PROFILE), "--no-daemon".to_string()];
    let full_prompt = if skills.is_empty() {
        system_prompt.to_string()
    } else {
        format!("{}\n\n{}", system_prompt, crate::projects::skills::skills_index_text(skills))
    };
    // The prompt is a FILE, not a launch argument (owner, 2026-09-08: "能类似
    // 通过 kiro 那样一个文件注入进去吗…这样更优雅一些"). codex reads the
    // global `AGENTS.md` from CODEX_HOME on every start, and this home is
    // ISOLATED — ours to write, never the user's (config.toml here is a
    // symlink into the user's real home; AGENTS.md is deliberately not
    // inherited). The old `-c developer_instructions=…` override put ~6 KB on
    // the launch line, which spawn survives (it sources a script) but the
    // restart replay typed into the pane — and a tty burst ≳2KB is exactly
    // what send-keys mangles (team/launch.rs). A restart also re-materializes
    // this file (refresh_agent), so the text stays current.
    shared::write_atomic(&codex_home.join("AGENTS.md"), &full_prompt)?;
    shared::write_atomic(
        &codex_home.join("hooks.json"),
        &serde_json::to_string_pretty(&json!({
            "hooks": codex_hooks(&notify)
        }))
        .unwrap(),
    )?;

    // A managed pane is UNATTENDED (board #184, owner 2026-09-12: "codex 启动会
    // 有提示是否升级，这个也要屏蔽掉，以及…是否信任当前文件夹目录"): codex's two
    // startup screens are answered here, as config overrides on the launch
    // line — never by editing config.toml, which in this home is a symlink
    // into the user's own. (1) `check_for_update_on_startup` (documented:
    // "Check for Codex updates on startup") switches the "Update available!
    // … Update now" screen off. (2) The folder-trust screen reads
    // `projects.<path>.trust_level`; measured on codex-cli 0.154.0 with an
    // isolated CODEX_HOME in an untrusted git dir: the override with the
    // path UNQUOTED removes the screen and writes nothing back, while a
    // quoted segment is not honoured (`-c` keys are split on dots and quotes
    // stay literal) — so a path containing a dot cannot be expressed here and
    // keeps the pane watcher below (StartupConfirmation) as its answer.
    // The definition's input mode (board #245): queue unless it says steer.
    config_args.extend(input_mode_keymap_overrides(def.input_mode == "steer"));
    config_args.push(shared::codex_config_override("check_for_update_on_startup", Value::Bool(false)));
    // Board #452: no shell snapshot. codex 0.162.1 otherwise writes
    // `shell_snapshots/<session>.sh` at session start, the pane shell's whole
    // `export` list (its secrets included) plus its functions and aliases,
    // and keeps every one. `features.shell_snapshot` is codex's documented
    // switch ("Snapshot shell environment to speed up repeated commands"). A
    // `-c` like the other startup answers, so no project config turns it
    // back on. Measured with real model turns (#452): the shell tool still
    // runs, and the checked names/counts and tools passed; but its PATH is
    // now built from the recipe's (R1: 10 entries against its 9, the extra one
    // unidentified), not the rc-built PATH the snapshot carried (17 more
    // directories) — a narrowing accepted as ruling (a) on #452: the
    // snapshot widened the declared recipe environment.
    config_args.push(shared::codex_config_override("features.shell_snapshot", Value::Bool(false)));
    // A delivery is TYPED (non-negotiable 12): a single line rides one
    // `send-keys -l`, a burst of un-bracketed keystrokes. codex's paste-burst
    // heuristic (for terminals without bracketed paste) takes such a burst
    // for a paste and inserts an Enter that arrives while it is open as a
    // NEWLINE, so the line sat unsubmitted (board #446: twice, once for ten
    // hours). Measured on codex-cli 0.162.1, the real stored lines, Enter
    // 200 ms after the text: 0/10 and 2/10 submitted. The key is the [tui]
    // one, `tui.disable_paste_burst`, which codex's config reference says
    // takes precedence over the legacy top-level `disable_paste_burst`
    // (reviewer P1). Measured on 0.162.1 against an inherited config.toml
    // that sets the setting false (the home's config is the user's):
    // `-c tui.disable_paste_burst=true` submits 10/10 whether the user's
    // false is the [tui] key, the top-level key or both, while
    // `-c disable_paste_burst=true` submits 0/10 under a [tui] false. With
    // no user setting the tui key alone submits 10/10, so the legacy key is
    // not set as well. A person's own paste arrives bracketed from the
    // terminal, the path the heuristic does not handle.
    config_args.push(shared::codex_config_override("tui.disable_paste_burst", Value::Bool(true)));
    // Board #5: the card's context reading needs a context ITEM, and
    // codex-cli 0.166.0's default footer paints none (`GPT-6-Astra high ·
    // <cwd> · <thread title>`). `tui.status_line` is codex's documented door
    // for the footer; this keeps the default's items and adds `context-used`
    // BEFORE the cwd, because codex truncates the line with `…` and the cwd
    // is the long one (45 columns, measured: `GPT-6-Astra high · Context 0%
    // used · /tmp/…`). Display items only, never the model or effort
    // (non-negotiable 10). In a managed pane it replaces a status line the
    // user set in config.toml; their own codex is untouched.
    config_args.push(shared::codex_config_override("tui.status_line", json!(CODEX_STATUS_LINE)));
    if let Some(key) = codex_trust_key(workspace) {
        config_args.push(shared::codex_config_override(&key, Value::String("trusted".into())));
    }
    config_args.push("--dangerously-bypass-approvals-and-sandbox".into());
    config_args.push("--dangerously-bypass-hook-trust".into());
    Ok(Rendered {
        env: vec![("CODEX_HOME".into(), codex_home.to_string_lossy().to_string())],
        cmd: format!("command codex {}", config_args.join(" ")),
        confirmation: startup_confirmation(),
    })
}

/// A resuming codex's NATIVE loading block (board #47 round 1), read by
/// structure, measured on 0.166.0 in every frame of two resumes: the last
/// composer line (`› ` at column 0) has directly above it, blank lines
/// aside, `Resuming session…`, the header's second line (`loading` or the
/// folder) and the `>_ OpenAI Codex (v…)` header; and directly below it, no
/// status line: the next line with text is `? for shortcuts`. A loaded
/// composer has its status line (`<model> · <folder>…`) there, so even a
/// reply that reproduces the whole block is not read as loading, and the
/// phrase quoted anywhere else is just transcript (the reviewer's P1-R1,
/// reproduced live by validator: a substring held a loaded codex forever).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn resuming(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().collect();
    let Some(composer) = lines.iter().rposition(|l| l.starts_with("\u{203a} ")) else { return false };
    let mut above = lines[..composer].iter().rev().filter(|l| !l.trim().is_empty());
    let block = (above.next(), above.next(), above.next());
    let native = matches!(block, (Some(resume), Some(second), Some(header))
        if resume.trim() == "Resuming session\u{2026}"
            && second.starts_with("     ") && !second.trim().is_empty()
            && header.trim_start().starts_with(">_ OpenAI Codex (v"));
    let below = lines[composer + 1..].iter().find(|l| !l.trim().is_empty());
    native && below.is_some_and(|l| l.trim_start().starts_with("? for shortcuts"))
}

/// codex's first-use trust dialog and its ready furniture: what a spawn's
/// waiter and a restart's ready edge (board #38) read. The ready mark is the
/// empty composer's own placeholder, on a FRESH codex and on a RESUMED one
/// (`codex resume <id>`, #29), measured on 0.166.0. The banner a fresh start
/// paints (`OpenAI Codex`, `Starting MCP servers`) is NOT on a resumed screen,
/// so a restart's ready edge never fired on it (round 1, validator P1-a).
/// Board #47: a resuming codex paints that placeholder while still
/// `Resuming session…` and drops an Enter typed then (7/7 saved failures).
/// Not ready while its native loading block shows (`resuming`): typing only
/// once it is gone submitted 15/15 mid-turn resumes, 6/6 idle resumes and a
/// fresh start.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn startup_confirmation() -> Option<shared::StartupConfirmation> {
    Some(shared::StartupConfirmation {
        markers: shared::CODEX_FOLDER_TRUST_MARKERS.to_vec(),
        ready_markers: vec!["Ask Codex to do anything"],
        loading: Some(resuming),
        accept_keys: vec!["Enter"],
        timeout: std::time::Duration::from_secs(120),
    })
}


/// The managed codex footer's items, in paint order (board #5, ids from
/// codex-cli 0.166.0). `sniff_codex` reads nothing after the cwd, which is
/// where the thread title goes.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const CODEX_STATUS_LINE: [&str; 4] = ["model-with-reasoning", "context-used", "current-dir", "thread-title"];

/// The `-c` key that pre-answers codex's folder-trust screen for `workspace`,
/// or None when the path holds a dot (codex splits the key on dots and keeps
/// quotes literal — measured on 0.154.0 — so such a path has no key form).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn codex_trust_key(workspace: &Path) -> Option<String> {
    let path = workspace.to_str()?;
    if path.is_empty() || path.contains('.') || path.contains('=') || path.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("projects.{path}.trust_level"))
}

/// The codex half of `refresh_hooks`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, notify: &str) -> Result<bool, String> {
    let hooks = home.join("codex").join("hooks.json");
    if !hooks.is_file() { return Ok(false); }
    patch_hooks(&hooks, codex_hooks(notify))
}

/// codex's resume is a SUBCOMMAND, so it splices in after the binary instead
/// of appending: `codex resume <id> <flags>`. The managed CODEX_HOME belongs
/// to this one agent and `--last` is cwd-filtered, so the recent fallback
/// cannot cross into another project/session. An unexpected recipe shape
/// relaunches without resume rather than guessing where the subcommand goes.
/// A saved codex line from before board #448 put the definition's MCP
/// servers on it (`-c mcp_servers.<n>.env.<K>=<value>`); such a line is not
/// private and is never replayed. Since #448 codex's MCP is the profile.
pub(crate) fn line_is_private(cmd: &str) -> bool {
    !cmd.contains("mcp_servers.")
}

pub(crate) fn resume_command(cmd: &str, id: Option<&str>, home: Option<&std::path::Path>) -> String {
    let resume = |which: &str| with_resume(cmd, which).unwrap_or_else(|| cmd.to_string());
    match resume_target(id, home) {
        // Board #74: a chat codex will not reopen starts fresh instead.
        Target::Thread(t) if home.and_then(|h| resume_refusal(h, &t)).is_some() => cmd.to_string(),
        Target::Thread(t) => resume(&crate::shell::quote(&t)),
        Target::Last => resume("--last"),
        Target::Fresh => cmd.to_string(),
    }
}

/// Why the restart `resume_command` builds for (`id`, `home`) starts fresh
/// instead of resuming its thread (board #74), for the room; `None` when it
/// resumes, or starts fresh for a reason of its own (#29's cleared thread).
pub(crate) fn resume_notice(id: Option<&str>, home: &std::path::Path) -> Option<String> {
    match resume_target(id, Some(home)) {
        Target::Thread(t) => resume_refusal(home, &t),
        _ => None,
    }
}

/// What a codex restart reopens.
enum Target {
    /// This thread, by id.
    Thread(String),
    /// codex's own `--last` (no id recorded and no pane thread read).
    Last,
    /// Nothing: a fresh conversation.
    Fresh,
}

/// The ONE choice of what a restart reopens, for the line and the notice.
fn resume_target(id: Option<&str>, home: Option<&std::path::Path>) -> Target {
    let recorded = || id.map(|t| Target::Thread(t.to_string())).unwrap_or(Target::Last);
    let Some(current) = home.and_then(pane_thread) else { return recorded() };
    // Nothing to change: the pane's thread is the one recorded.
    if current.has_rollout && Some(current.id.as_str()) == id {
        return recorded();
    }
    match codex_version() {
        Some(v) if v == NEW_THREAD_MEASURED => {
            if current.has_rollout {
                // Review P1 (#29 round 0): the slot's id lags a capture tick
                // behind a new thread's first turn; the lock is the pane's own.
                Target::Thread(current.id)
            } else {
                Target::Fresh
            }
        }
        v => {
            eprintln!(
                "codex {}: the pane's newest thread is not the recorded one, but that reading of codex's thread locks is measured on {NEW_THREAD_MEASURED} only; resuming as before (board #29)",
                v.as_deref().unwrap_or("of unknown version")
            );
            recorded()
        }
    }
}

/// The codex version the provider-mismatch refusal was measured on (board
/// #74): `thread/resume failed: This chat uses amazon-bedrock-runtime, but
/// your current provider is ust` (modelProviderMismatch), codex then exits
/// to the shell.
pub(crate) const PROVIDER_REFUSAL_MEASURED: &str = "0.166.0";

/// Why codex will not resume thread `id` in `home`, or `None` (board #74).
/// Codex records the chat's provider in its rollout's first line
/// (`session_meta.payload.model_provider`) and refuses a resume under any
/// other: its error names exactly those two values. The current provider is
/// the managed profile's `model_provider` when it names one, else the
/// linked `config.toml`'s, else codex's default `openai`. Codex's rule,
/// predicted on the measured version ONLY: another version, or anything
/// that cannot be read, is `None`, and the restart resumes as before, so a
/// changed rule can never silently drop a chat codex would reopen.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn resume_refusal(home: &std::path::Path, id: &str) -> Option<String> {
    if codex_version().as_deref() != Some(PROVIDER_REFUSAL_MEASURED) {
        return None;
    }
    let codex = home.join("codex");
    let (was, cwd) = rollout_meta(&rollout_path(&codex.join("sessions"), id)?)?;
    let now = current_provider(&codex)?;
    // Review R2: a project `.codex/config.toml` can sit above the home's
    // layers (a trusted one does, #448). One that names ANOTHER provider, or
    // cannot be read, makes the effective one unknown here, and unknown keeps
    // today's resume (AC2). One that agrees, or names none, leaves the home's
    // decision standing (orchestrator, #74 note 27).
    if project_disagrees(&cwd, &codex.join("config.toml"), &now) {
        return None;
    }
    (was != now).then(|| format!("its chat was started on {was} and codex is now on {now}, which codex will not resume"))
}

/// No managed codex runs on the phone: nothing is refused there.
#[cfg(any(target_os = "android", target_os = "ios"))]
pub(crate) fn resume_refusal(_home: &std::path::Path, _id: &str) -> Option<String> {
    None
}

/// The most of a rollout's first line that is read: `session_meta` carries
/// the model's base instructions (tens of KB measured).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const SESSION_META_CAP: u64 = 1024 * 1024;

/// `session_meta.payload.model_provider` and `.cwd` from a rollout's first
/// line.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn rollout_meta(rollout: &std::path::Path) -> Option<(String, std::path::PathBuf)> {
    use std::io::{BufRead, Read};
    let f = std::fs::File::open(rollout).ok()?;
    let mut first = String::new();
    std::io::BufReader::new(f.take(SESSION_META_CAP)).read_line(&mut first).ok()?;
    let v: serde_json::Value = serde_json::from_str(first.trim_end()).ok()?;
    (v.get("type")?.as_str()? == "session_meta").then_some(())?;
    let payload = v.get("payload")?;
    let provider = payload.get("model_provider")?.as_str()?.to_string();
    let cwd = std::path::PathBuf::from(payload.get("cwd")?.as_str()?);
    Some((provider, cwd))
}

/// Whether a `.codex/config.toml` in the chat's cwd or any ancestor may
/// choose a provider other than `home_provider` (review R2, round 3): it
/// names a different `model_provider`, a non-string one, or cannot be read
/// or parsed. Trust is not judged here. A file naming the same provider, or
/// none, cannot change the outcome whichever layer wins. The home's own config, reached as a project
/// file (the user's `~/.codex/config.toml` is an ancestor's `.codex` of every
/// workspace under HOME, and the managed home links it), is the layer
/// already read, so it is skipped by identity.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn project_disagrees(cwd: &std::path::Path, home_config: &std::path::Path, home_provider: &str) -> bool {
    let home_real = std::fs::canonicalize(home_config).ok();
    for dir in cwd.ancestors() {
        let file = dir.join(".codex").join("config.toml");
        match std::fs::symlink_metadata(&file) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return true,
            Ok(_) => {}
        }
        if home_real.is_some() && std::fs::canonicalize(&file).ok() == home_real {
            continue;
        }
        let Some(table) = super::read_model_source(&file).ok().flatten().and_then(|t| t.parse::<toml::Table>().ok()) else { return true };
        match table.get("model_provider") {
            None => {}
            Some(v) if v.as_str() == Some(home_provider) => {}
            Some(_) => return true,
        }
    }
    false
}

/// The provider a managed codex in `codex` (its CODEX_HOME) runs: the
/// profile's, else config.toml's, else `openai`. `None` when a file that
/// exists cannot be read or parsed, or names a `model_provider` that is not
/// a string (validator P1: codex refuses that config, so the current
/// provider cannot be told and the restart resumes as before).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn current_provider(codex: &std::path::Path) -> Option<String> {
    let named = |file: &str| -> Option<Option<String>> {
        let text = super::read_model_source(&codex.join(file)).ok()?;
        let Some(text) = text else { return Some(None) };
        let table = text.parse::<toml::Table>().ok()?;
        match table.get("model_provider") {
            None => Some(None),
            Some(v) => v.as_str().map(|p| Some(p.to_string())),
        }
    };
    let profile = named(&shared::codex_profile_file())?;
    let config = named("config.toml")?;
    Some(profile.or(config).unwrap_or_else(|| "openai".to_string()))
}

/// How much of a rollout's END is read for its newest turn end (board #39,
/// orchestrator's condition 1): rollouts grow to tens of MB, and the newest
/// `task_started` / `task_complete` pair is near the end.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const ROLLOUT_TAIL_BYTES: u64 = 256 * 1024;

/// The open turn's failed end, from the pane's own rollout (board #39 slice
/// 2, #52): `(turn_id, provider)`. codex 0.166.0 sends no end hook on a
/// failed turn (builder-2's AC1; reviewer's max_output_tokens stop of
/// 2026-11-06); its rollout's `task_complete` carries the error. `provider`
/// is the redacted text of a failure only a person can clear, `None` for an
/// ordinary one. `open` is the id codex's `UserPromptSubmit` gave the open
/// prompt (`telemetry::cli_turn`): only that turn's end counts. `None` when
/// the pane's thread or its rollout cannot be found or read: nothing is
/// recorded, and the screen reader still applies (condition 2).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn failed_end(home: &std::path::Path, open: &str) -> Option<(String, Option<String>)> {
    let thread = pane_thread(home)?;
    let path = rollout_path(&home.join("codex").join("sessions"), &thread.id)?;
    rollout_failed_end(&shared::read_tail(&path, ROLLOUT_TAIL_BYTES)?, open)
}

/// The rollout's NEWEST turn record, when it is the FAILED end of the OPEN
/// turn (`open`, the prompt hook's `turn_id`): a `task_complete` whose
/// `turn_id` is `open` and that carries an `error` object (an ordinary end
/// has none, and its Stop hook ends the turn). The provider text is set
/// when the slice-1 predicate keeps the error as one a person must clear
/// (`shared::provider_failure`, redacted); any other error (#52:
/// max_output_tokens, a 429, a 5xx) is an ordinary failed end. Bound by
/// identity, so an older turn's error is never the open prompt's, whatever
/// codex has written of the new turn yet (#39 reviewer's P1). A newest
/// `task_started` means the turn runs. A line that does not parse (a
/// half-written newest line) means UNKNOWN: the scan stops, never reading
/// past it to an older end. Measured on codex 0.166.0: the prompt hook's
/// `turn_id` is the `task_complete`'s.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn rollout_failed_end(rollout: &str, open: &str) -> Option<(String, Option<String>)> {
    if open.is_empty() {
        return None;
    }
    for line in rollout.lines().rev().filter(|l| !l.trim().is_empty()) {
        let row = serde_json::from_str::<Value>(line).ok()?;
        let payload = &row["payload"];
        match payload["type"].as_str() {
            Some("task_started") => return None,
            Some("task_complete") => {
                if payload["turn_id"].as_str() != Some(open) {
                    return None;
                }
                let error = payload.get("error").filter(|e| e.is_object())?;
                let status = error["codex_error_info"]["http_connection_failed"]["http_status_code"].as_u64().and_then(|s| u16::try_from(s).ok());
                let message = error["message"].as_str().unwrap_or_default();
                let provider = shared::provider_failure(status, None, message);
                // A rejected model id names the model (#65 item 2): the one the
                // turn's own `turn_context` says it ran, when the tail holds it.
                let model = shared::model_rejected(message).then(|| turn_model(rollout, open)).flatten();
                return Some((open.to_string(), match (provider, model) {
                    (Some(text), Some(model)) => Some(format!("model {model}: {text}")),
                    (provider, _) => provider,
                }));
            }
            _ => {}
        }
    }
    None
}

/// The model a managed codex was LAUNCHED with (board #65 item 2): its
/// managed profile's `model`, written whole on every render. `Ok(None)` when
/// the render named none (the user's own default); `Err` when the file
/// cannot be read or parsed: unknown, never the default (validator note 26).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn profile_model(home: &std::path::Path) -> Result<Option<String>, ()> {
    let table: toml::Table = std::fs::read_to_string(home.join("codex").join(shared::codex_profile_file())).map_err(|_| ())?.parse().map_err(|_| ())?;
    // Key missing: none named. Present but not a string: unknown (note 31).
    match table.get("model") {
        None => Ok(None),
        Some(m) => Ok(Some(m.as_str().ok_or(())?.trim()).filter(|m| !m.is_empty()).map(str::to_string)),
    }
}

/// The model the turn `turn` ran, from its `turn_context` line (codex
/// 0.166.0 writes one per turn with `turn_id` and `model`; measured on
/// validator's rollout of 2026-11-07). `None` when the tail does not hold it.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn turn_model(rollout: &str, turn: &str) -> Option<String> {
    rollout.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find_map(|row| {
        let p = &row["payload"];
        (row["type"] == "turn_context" && p["turn_id"].as_str() == Some(turn)).then(|| p["model"].as_str().map(str::to_string)).flatten()
    })
}

/// The thread a killed codex pane was in, read from codex's own files.
struct PaneThread {
    id: String,
    /// PROVEN to have a rollout; `false` is proven to have none. A rollout
    /// that cannot be checked makes `pane_thread` answer `None` (review
    /// round 1: "cannot tell" must never resume a specific id).
    has_rollout: bool,
}

/// Board #29, measured on codex-cli 0.166.0 (scratch CODEX_HOME): `/new`
/// creates `thread-writer-locks/<new thread id>.lock` at once, and the new
/// thread's rollout (`sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`) only at its
/// first prompt; no hook fires and no session index entry is written
/// before that (codex's database was not compared: the dumps were empty). A window kill leaves the locks; the next codex start
/// removes those of threads it does not run (a fresh start keeps only its
/// own, `resume <id>` only that id's). So the NEWEST lock (mtime) names the
/// thread the pane was in. Without a rollout it is an empty new
/// conversation: a restart starts fresh instead of reviving the cleared
/// one. With a rollout it is the pane's current conversation, which the
/// slot's recorded id may not name yet (it lags a capture tick, review P1),
/// so that thread is resumed. The locks are codex's internal concurrency
/// state, not a documented door, so either reading holds only on the
/// measured version (`NEW_THREAD_MEASURED`). A thread the hub saw as a
/// sub-agent child (`CHILD_THREADS`) is never taken for the pane's own: a
/// wrong fresh start loses a live conversation, which is worse than
/// reviving a cleared one. `None` when none qualifies, or when anything
/// the choice rests on cannot be read (the child record, a lock entry or its
/// mtime, a sessions directory): "cannot tell" never resumes a lock's id
/// (review rounds 1 and 2).
fn pane_thread(home: &std::path::Path) -> Option<PaneThread> {
    let codex = home.join("codex");
    let children = read_child_threads(home).ok()?;
    let mut newest: Option<(std::time::SystemTime, String)> = None;
    for e in std::fs::read_dir(codex.join("thread-writer-locks")).ok()? {
        let e = e.ok()?;
        let Some(id) = e.file_name().to_str().and_then(|n| n.strip_suffix(".lock")).map(str::to_string) else { continue };
        if !is_thread_id(&id) || children.lines().any(|c| c == id) {
            continue;
        }
        let when = e.metadata().ok()?.modified().ok()?;
        if newest.as_ref().is_none_or(|n| (when, &id) > (n.0, &n.1)) {
            newest = Some((when, id));
        }
    }
    let (_, id) = newest?;
    let has_rollout = has_rollout(&codex.join("sessions"), &id)?;
    Some(PaneThread { id, has_rollout })
}

/// codex's thread ids are UUIDs (measured: `01a1acf2-ff8a-7071-8a17-
/// 722f5c7fa5ed`, UUIDv7). Its own `.coordination.lock` shares the
/// directory, with the same mtime as the thread lock at start (validator,
/// round 1), and is no thread.
fn is_thread_id(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Whether `sessions/YYYY/MM/DD/` holds the rollout of thread `id`:
/// `Some(true)` proven, `Some(false)` proven absent (a `sessions/` that does
/// not exist yet, as before a fresh agent's first turn, holds none), `None`
/// when a directory cannot be read: cannot tell.
fn has_rollout(sessions: &std::path::Path, id: &str) -> Option<bool> {
    find_rollout(sessions, id).map(|p| p.is_some())
}

/// The rollout file of thread `id`, `None` when it is absent or cannot be
/// looked for.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn rollout_path(sessions: &std::path::Path, id: &str) -> Option<std::path::PathBuf> {
    find_rollout(sessions, id).flatten()
}

/// `has_rollout`'s walk, naming the file: `Some(Some(path))` found,
/// `Some(None)` proven absent, `None` cannot tell.
fn find_rollout(sessions: &std::path::Path, id: &str) -> Option<Option<std::path::PathBuf>> {
    let suffix = format!("-{id}.jsonl");
    let dirs = |p: &std::path::Path| -> Option<Vec<std::path::PathBuf>> {
        match std::fs::read_dir(p) {
            Ok(d) => {
                let mut out = Vec::new();
                for e in d {
                    let e = e.ok()?;
                    if std::fs::metadata(e.path()).ok()?.is_dir() {
                        out.push(e.path());
                    }
                }
                Some(out)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
            Err(_) => None,
        }
    };
    for y in dirs(sessions)? {
        for m in dirs(&y)? {
            for d in dirs(&m)? {
                for f in std::fs::read_dir(&d).ok()? {
                    let f = f.ok()?;
                    if f.file_name().to_str().is_some_and(|n| n.starts_with("rollout-") && n.ends_with(&suffix)) {
                        return Some(Some(f.path()));
                    }
                }
            }
        }
    }
    Some(None)
}

/// The codex version the thread-lock reading of `/new` was measured on.
pub(crate) const NEW_THREAD_MEASURED: &str = "0.166.0";

/// Our record, in the agent's home, of the thread ids the hub saw as codex
/// sub-agent children (hook payloads carry `agent_id`, board #169).
pub(crate) const CHILD_THREADS: &str = "codex-child-threads";

/// The child record's text. A record that does not exist yet holds no
/// children; one that exists but cannot be read is an error, never empty
/// (review round 2 P1-R1: read as empty, it let a known child's lock pass
/// for the pane's own thread, and the writer replaced the whole list).
fn read_child_threads(home: &std::path::Path) -> std::io::Result<String> {
    match std::fs::read_to_string(home.join(CHILD_THREADS)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        r => r,
    }
}

/// Record `id` as a sub-agent child thread of this home (once). An
/// unreadable record is left as it is and reported.
pub(crate) fn note_child_thread(home: &std::path::Path, id: &str) -> Result<(), String> {
    if !super::shared::exact_id_ok(id) {
        return Ok(());
    }
    let path = home.join(CHILD_THREADS);
    let mut known = read_child_threads(home).map_err(|e| format!("{}: {e}; left as it is", path.display()))?;
    if known.lines().any(|l| l == id) {
        return Ok(());
    }
    known.push_str(id);
    known.push('\n');
    super::shared::write_atomic(&path, &known)
}

/// The installed codex version a restart will run, or `None` when unknown.
#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
fn codex_version() -> Option<String> {
    crate::projects::recovery::installed_version(super::Backend::Codex)
}

#[cfg(all(not(test), any(target_os = "android", target_os = "ios")))]
fn codex_version() -> Option<String> {
    None
}

#[cfg(test)]
thread_local! {
    static TEST_VERSION: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn codex_version() -> Option<String> {
    TEST_VERSION.with(|v| v.borrow().clone())
}

/// Tests choose the version `codex_version` answers.
#[cfg(test)]
pub(crate) fn set_test_version(v: Option<&str>) {
    TEST_VERSION.with(|t| *t.borrow_mut() = v.map(str::to_string));
}

/// `resume <which>` inserted into the canonical recipe shape, or `None` when
/// the recipe is not that shape — the ONE construction both forms share.
fn with_resume(cmd: &str, which: &str) -> Option<String> {
    cmd.strip_prefix("command codex ").map(|rest| format!("command codex resume {which} {rest}"))
}

/// The strict form for a restore after a reboot (board #422): `Some` only for
/// the canonical `command codex …` recipe with a non-empty id. Any other
/// shape is `None` — never the verbatim command, which would start a NEW
/// conversation (review P1-C).
pub(crate) fn resume_exact(cmd: &str, id: &str) -> Option<String> {
    if !super::shared::exact_id_ok(id) {
        return None;
    }
    with_resume(cmd, &crate::shell::quote(id))
}

/// This backend's detection/relaunch row (board #129). `codex resume <id>`
/// exact only: `--last` is machine-wide for a SHARED ~/.codex, so restoring
/// project A could reopen project B's conversation — deliberately None here.
/// The managed-home dialect (`resume_command` above) DOES use `--last`:
/// an isolated CODEX_HOME is this one agent's and codex cwd-filters it.
/// One file, both halves of the same fact (todo §D2).
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on codex-cli
/// 0.154.0: none. Even `/goal`, which runs a turn, fires no `UserPromptSubmit`
/// (only its tool and stop), and `/status` fires nothing — so a command gets
/// no receipt row at all.
pub(crate) fn command_echo(_name: &str, _args: &str) -> Option<String> {
    None
}

/// The fact that shows the reset command `name` took effect (board #45),
/// measured 2026-11-06 on codex-cli 0.166.0 (scratch gateway, a hook spy):
/// `/clear` writes a new thread-writer lock ~0.3 s after its Enter and fires
/// no hook until the next prompt; `/new` is the same rule, but opens a picker
/// first, so no lock appears until a person answers it; `/compact` keeps the
/// thread and fires `SessionStart {source: compact}` when compaction ends.
pub(crate) fn command_effect(name: &str) -> Option<super::CommandEffect> {
    match name {
        "/clear" | "/new" => Some(super::CommandEffect::NewThread),
        "/compact" => Some(super::CommandEffect::SessionStart("compact")),
        _ => None,
    }
}

/// The thread the pane runs now, by its newest lock (`pane_thread`, board
/// #29): what a `NewThread` effect compares against the one before.
pub(crate) fn current_thread(home: &std::path::Path) -> Option<String> {
    pane_thread(home).map(|t| t.id)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "codex",
        programs: &["codex"],
        launch: "codex",
        resume_recent: None,
        resume_id: Some("codex resume {id}"),
        versioned_binary_dir: None,
    }
}

/// codex's hook payload dialect (board #129): claude's key spelling,
/// `PermissionRequest` for the ask, `Stop` for a turn's end.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    match event.as_deref() {
        Some("PermissionRequest") => Ok("permission_required"),
        Some("Stop") => Ok("completed"),
        _ => Err("unsupported Codex event".into()),
    }
}

/// Sub-agent threads (board #169). codex 0.153.4 runs `spawn_agent` children
/// as threads INSIDE the same process, and the managed hooks.json fires for
/// every thread. Measured with a scratch CODEX_HOME whose hooks dumped every
/// stdin payload (parent asked to spawn one child, wait, close — 13 hooks):
///
/// * every event, parent and child alike, carries `session_id` = the ROOT
///   thread id and the parent's `turn_id`; the child's own id never appears
///   as `session_id`, so the conversation map was never corrupted;
/// * child events carry `agent_id` (the child thread id) and `agent_type`
///   ("default"); parent events carry NEITHER — that pair is the discriminator;
/// * the child's brief arrives as `UserPromptSubmit` {agent_id, agent_type,
///   prompt} — the event this consumer used to read as keyboard input;
/// * the child's end arrives as `SubagentStop` {agent_id, agent_transcript_path,
///   stop_hook_active} (which the managed hooks do not subscribe to), never as
///   `Stop`; `SubagentStart` {agent_id, agent_type} precedes the brief;
/// * the parent's `Stop` DOES carry `last_assistant_message` (the final
///   answer), so a lost codex reply edge is the child's prompt having reset
///   the turn, not a bodiless Stop;
/// * the parent's own `PreToolUse`/`PostToolUse` name the delegation tools:
///   `spawn_agent` {message}, `multi_agent_v1wait_agent` {targets, timeout_ms},
///   `multi_agent_v1close_agent` {target};
/// * a child's approval (board #170; `-a on-request -s read-only`, child told
///   to write a file) arrives as `PermissionRequest` {agent_id, agent_type,
///   tool_name: "Bash", tool_input: {command, description}} and is SHOWN in
///   the parent's TUI as a blocking modal ("Would you like to run the
///   following command? Thread: Agent (01a08eab)…") until the human answers
///   — so, unlike the child's prompt and stop, it IS the window's ask.
///
/// Returns the child thread id when the payload comes from a sub-agent
/// thread. A sub-agent event is the agent's OWN work — like a tool call — and
/// must never open or close the window's turn.
pub(crate) fn subagent_thread(payload: &Value) -> Option<&str> {
    payload.get("agent_id").and_then(Value::as_str).filter(|id| !id.is_empty())
}

/// codex speaks kiro's spelling here (measured on codex-cli 0.148.0 — the
/// payload also carries `prompt` + `session_id`, same as kiro/claude). Same
/// sticky-dedup incident as claude's when this arm was missing.
pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("userpromptsubmit"))

}

/// What a NEW managed codex needs set up (board #492), read from the files
/// render links into its home (`config.toml`, `auth.json`, `.env`). The
/// managed `--profile` names no provider, so the top-level `model_provider`
/// decides (absent = openai). `codex login status` is NOT asked: it says
/// "Not logged in" on a host whose codex runs on a custom provider (measured
/// 2026-11-01, amazon-bedrock-runtime).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn set_up_need() -> super::readiness::Need {
    set_up_need_in(&codex_user_home())
}

/// `set_up_need` against a given codex home.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn set_up_need_in(home: &std::path::Path) -> super::readiness::Need {
    use super::readiness::{dotenv_names, read_toml, Need, SetUp};
    let config = match read_toml(&home.join("config.toml")) {
        Ok(c) => c,
        Err(r) => return Need::Found(SetUp::unknown(r)),
    };
    let dotenv = match dotenv_names(&home.join(".env")) {
        Ok(n) => n,
        Err(r) => return Need::Found(SetUp::unknown(r)),
    };
    let key = |k: &str| {
        if dotenv.iter().any(|n| n == k) {
            Need::Found(SetUp::present(format!(".env {k}")))
        } else {
            Need::env(vec![k.to_string()])
        }
    };
    let provider = config.as_ref().and_then(|c| c.get("model_provider")).and_then(toml::Value::as_str).unwrap_or("openai");
    if provider == "openai" {
        if home.join("auth.json").is_file() {
            return Need::Found(SetUp::present("auth.json"));
        }
        return key("OPENAI_API_KEY");
    }
    let table = config.as_ref().and_then(|c| c.get("model_providers")).and_then(|p| p.get(provider)).and_then(toml::Value::as_table);
    match table {
        // The provider's id rides `via` only in a plain shape: it is the
        // user's config text, and a reply carries words (reviewer P2-F).
        Some(t) if t.contains_key("aws") => {
            let plain = provider.len() <= 64 && provider.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
            let unknown = SetUp::unknown("aws_chain");
            Need::Found(if plain { unknown.with_via(format!("provider {provider}")) } else { unknown })
        }
        Some(t) => match t.get("env_key").and_then(toml::Value::as_str) {
            Some(k) => key(k),
            None => Need::Found(SetUp::unknown("unrecognised_provider")),
        },
        None => Need::Found(SetUp::unknown("unrecognised_provider")),
    }
}

#[cfg(test)]
mod tests {

    /// Board #39 slice 2, orchestrator's condition 2: a rollout that exists
    /// but cannot be read, or a home with no thread, records nothing (the
    /// turn stays open for the screen reader); the readable one is read.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn a_rollout_that_cannot_be_read_names_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let home = crate::config::test_scratch("codex-provider-end");
        let thread = "01a1aaeb-dde5-7df0-b10b-52bc2e068818";
        assert_eq!(super::failed_end(&home, "t1"), None, "no thread");
        std::fs::create_dir_all(home.join("codex/thread-writer-locks")).unwrap();
        std::fs::write(home.join(format!("codex/thread-writer-locks/{thread}.lock")), "").unwrap();
        std::fs::create_dir_all(home.join("codex/sessions/2026/11/05")).unwrap();
        let f = home.join(format!("codex/sessions/2026/11/05/rollout-x-{thread}.jsonl"));
        let end = serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","error":{"message":"unexpected status 402 Payment Required: insufficient credit"}}});
        std::fs::write(&f, end.to_string()).unwrap();
        assert_eq!(super::failed_end(&home, "t1").map(|(t, _)| t).as_deref(), Some("t1"), "readable: read");
        assert_eq!(super::failed_end(&home, "t2"), None, "readable, another turn's end: nothing");
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&f).is_err() {
            assert_eq!(super::failed_end(&home, "t1"), None, "unreadable: nothing");
        }
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600)).unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Board #39 slice 2: codex 0.166.0 sends no end hook on a provider error;
    /// its rollout's `task_complete` carries it. The 413 line is reviewer's
    /// real one of 2026-11-05 15:59 (url host shortened); the 401 is
    /// builder-2's AC1 measurement on an invalid key. Round 1 (reviewer's
    /// P1, orchestrator's rule): the end must be the OPEN prompt's own turn,
    /// by the id codex's prompt hook carried, and a line that does not parse
    /// means unknown, never an older line.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn a_rollouts_newest_end_names_the_open_turns_failed_end() {
        let t413 = "01a1ac6d-ebed-78b2-ad24-34c670a9c990";
        let end = |turn: &str, error: serde_json::Value| serde_json::json!({"timestamp":"2026-11-05T15:59:21.324Z","type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":serde_json::Value::Null,"error":error}}).to_string();
        let ok = |turn: &str| serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":turn,"last_agent_message":"done"}}).to_string();
        let other = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant"}}).to_string();
        let e413 = end(t413, serde_json::json!({"message":"unexpected status 413 Payload Too Large: Failed to buffer the request body: length limit exceeded, url: https://gw.example/v1/responses","codex_error_info":{"http_connection_failed":{"http_status_code":413}}}));
        let e401 = end("t-401", serde_json::json!({"message":"unexpected status 401 Unauthorized: invalid API key, url: https://gw.example/v1/responses?key=SECRET, request id: req_0a1b","codex_error_info":{"http_connection_failed":{"http_status_code":401}}}));
        let e429 = end("t-429", serde_json::json!({"message":"unexpected status 429 Too Many Requests","codex_error_info":{"http_connection_failed":{"http_status_code":429}}}));
        // codex 0.166.0 writes a start's id under `turn_attribution` (measured).
        let start = |turn: &str| serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_attribution":{"turn_id":turn,"turn_trigger":"user"}}}).to_string();
        let read = |open: &str, lines: &[&str]| super::rollout_failed_end(&lines.join("\n"), open);
        let text413 = "unexpected status 413 Payload Too Large: Failed to buffer the request body: length limit exceeded, url: https://gw.example/v1/responses";
        assert_eq!(read(t413, &[&start(t413), &e413]), Some((t413.to_string(), Some(text413.to_string()))), "the open turn's own end");
        assert_eq!(read(t413, &[&ok("t-old"), &e413, &other]).map(|(t, _)| t).as_deref(), Some(t413), "the newest end, records after it notwithstanding");
        assert_eq!(read("t-401", &[&e401]).and_then(|(_, t)| t).as_deref(), Some("unexpected status 401 Unauthorized: invalid API key, url: https://gw.example/v1/responses, request id: req_0a1b"), "redacted");
        // An older turn's error never ends the open prompt.
        assert_eq!(read("t-next", &[&start(t413), &e413]), None, "the new prompt's start is not written yet: the old error is not its own");
        assert_eq!(read("t-next", &[&start(t413), &e413, &start("t-next")]), None, "the new turn is open");
        assert_eq!(read("t-next", &[&e413, &format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_sta")]), None, "a half-written newest line is unknown: never read past it");
        assert_eq!(read(t413, &[&e413, "{\"type\":\"event_msg\",\"payl"]), None, "unknown, even when the line behind it is the open turn's own end");
        assert_eq!(read(t413, &[&e413, "not json", &other]), None, "any line that does not parse before the newest end: unknown");
        assert_eq!(read(t413, &[&e413, &ok(t413)]), None, "a later good end: nothing to say");
        // Board #52: an ORDINARY error on the open turn's own end is still its
        // end, with no provider text (reviewer's real max_output_tokens line).
        assert_eq!(read("t-429", &[&e429]), Some(("t-429".to_string(), None)), "an ordinary failure ends the turn, no person needed");
        let tokens = serde_json::json!({"timestamp":"2026-11-06T01:29:23.149Z","ordinal":1289,"type":"event_msg","payload":{"type":"task_complete","root_turn_id":"t-tok","turn_id":"t-tok","last_agent_message":null,"error":{"message":"Incomplete response returned, reason: max_output_tokens","codex_error_info":"other"},"started_at":1793928323,"completed_at":1793928563,"duration_ms":240062,"time_to_first_token_ms":6424}}).to_string();
        assert_eq!(read("t-tok", &[&start("t-tok"), &tokens]), Some(("t-tok".to_string(), None)), "max_output_tokens ends it");
        assert_eq!(read("t-other", &[&start("t-tok"), &tokens]), None, "another turn's ordinary error: nothing");
        // codex 0.166.0's own 429 after its retries (#52 live, a fake provider
        // answering 429 with request/stream retries at 0): the status sits
        // under another key, and the message says it.
        let retried = end("t-ret", serde_json::json!({"message":"exceeded retry limit, last status: 429 Too Many Requests","codex_error_info":{"response_too_many_failed_attempts":{"http_status_code":429}}}));
        assert_eq!(read("t-ret", &[&retried]), Some(("t-ret".to_string(), None)), "codex's real 429 after its retries is ordinary");
        let blank = end("t-blank", serde_json::json!({}));
        assert_eq!(read("t-blank", &[&blank]), Some(("t-blank".to_string(), None)), "an error object with no message is still an error");
        assert_eq!(read(t413, &[&other]), None, "no end yet");
        assert_eq!(read("", &[&end("", serde_json::json!({"message":"401 Unauthorized"}))]), None, "no turn id: no identity, nothing recorded");
        assert_eq!(read("t-null", &[&end("t-null", serde_json::Value::Null)]), None, "error null: an ordinary end, the Stop hook's");
    }

    /// Board #65 item 2, validator's real rollout of 2026-11-07 01:46 (codex
    /// 0.166.0, after the provider switch): the refused turn's `task_complete`
    /// error and the `turn_context` that names its model. The end is a
    /// person's, and its text names the model the provider rejected.
    #[test]
    fn a_rejected_model_id_ends_the_turn_and_names_the_model() {
        let turn = "01a1b3af-8f7e-7820-9bc1-e3c626f65be3";
        let context = serde_json::json!({"type":"turn_context","payload":{"turn_id":turn,"model":"gpt-6.1-sol","effort":"high"}}).to_string();
        let start = serde_json::json!({"type":"event_msg","payload":{"type":"task_started","turn_attribution":{"turn_id":turn,"turn_trigger":"user"}}}).to_string();
        let message = r#"{"error":{"message":"The provided model identifier is invalid.","type":"invalid_request_error","param":null,"code":"validation_error"}}"#;
        let end = serde_json::json!({"type":"event_msg","payload":{"type":"task_complete","root_turn_id":turn,"turn_id":turn,"last_agent_message":null,"error":{"message":message,"codex_error_info":"other"},"started_at":1794015989,"completed_at":1794015990,"duration_ms":824}}).to_string();
        let older = serde_json::json!({"type":"turn_context","payload":{"turn_id":"t-old","model":"gpt-old"}}).to_string();
        let read = |lines: &[&str]| super::rollout_failed_end(&lines.join("\n"), turn);
        assert_eq!(read(&[&older, &context, &start, &end]), Some((turn.to_string(), Some(format!("model gpt-6.1-sol: {message}")))));
        assert_eq!(read(&[&start, &end]), Some((turn.to_string(), Some(message.to_string()))), "no turn_context: the provider's words alone");
    }

    /// Board #47, frames captured on codex-cli 0.166.0 (scratch tmux, 120x40,
    /// 2026-11-06 08:2x, every distinct frame of two resumes). Blank runs are
    /// cut to one line; nothing else is changed.
    const RESUMING_LOADING: &str = "\n  >_ OpenAI Codex (v0.166.0)\n     loading\n  Resuming session\u{2026}\n\n\u{203a} Ask Codex to do anything\n\n  ? for shortcuts\n";
    const RESUMING_DIR: &str = "\n  >_ OpenAI Codex (v0.166.0)\n     ~/b47r1-ws\n  Resuming session\u{2026}\n\n\u{203a} Ask Codex to do anything\n\n  ? for shortcuts\n";
    /// The same resume once loaded: the restored transcript quotes the phrase
    /// in a user prompt, in a reply's first line, and as a reply line
    /// byte-identical to the native one (`  Resuming session…`).
    const RESUMED_QUOTING: &str = "\n  >_ OpenAI Codex (v0.166.0)\n     ~/b47r1-ws\n\n  To get started, describe a task or try one of these commands:\n\n  /init - create an AGENTS.md file with instructions for Codex\n  /status - show current session configuration\n  /permissions - choose what Codex is allowed to do\n  /model - choose what model and reasoning effort to use\n  /review - review any changes and find issues\n\n\n\u{203a} Reply with these three lines exactly, nothing else: line 1 \"Resuming session is just a phrase here\", line 2 \"Resuming\n  session\u{2026}\", line 3 \"  Resuming session\u{2026}\" with two leading spaces\n\n\n\u{2022} Resuming session is just a phrase here\n  Resuming session\u{2026}\n  Resuming session\u{2026}\n\n  Worked for 3s \u{2022} 8:24 AM\n\n\n\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol medium \u{b7} ~/b47r1-ws \u{b7} Return three exact lines\n  ? for shortcuts                                                                             \u{26a0} 2 warnings \u{b7} f2 to view\n";
    /// A resume of a turn killed mid-run (validator's sequence), once loaded.
    const RESUMED_MIDTURN_TAIL: &str = "\u{2022} Resuming session is just a phrase here\n  Resuming session\u{2026}\n  Resuming session\u{2026}\n\n  Worked for 3s \u{2022} 8:24 AM\n\n\n\u{203a} Run the shell command `sleep 60` and then say DONE.\n\n\n\u{2022} I\u{2019}ll run sleep 60, then say DONE.\n\n\u{25a0} Conversation interrupted - use /feedback if something went wrong\n\n\n\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol medium \u{b7} ~/b47r1-ws \u{b7} Return three exact lines\n  ? for shortcuts                                                                             \u{26a0} 2 warnings \u{b7} f2 to view\n";

    /// Board #47: a RESUMED codex paints its composer placeholder while it is
    /// still loading, and an Enter typed then is dropped (7/7 saved failures).
    /// It is not ready while its NATIVE loading block shows, matched by
    /// structure: the header, one line, `Resuming session…`, then the
    /// composer, with no status line under it. Words anywhere else never
    /// hold it (reviewer P1-R1 round 1, reproduced live by validator: a
    /// transcript quoting the phrase held every delivery).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn a_resuming_codex_is_not_ready_only_while_its_native_loading_block_shows() {
        let c = super::startup_confirmation().unwrap();
        let ready = |screen: &str| crate::backends::shared::startup_already_ready(screen, &c);
        assert!(!ready(RESUMING_LOADING), "the placeholder while loading is not ready");
        assert!(!ready(RESUMING_DIR), "nor once the header shows the folder");
        let after_shell = format!("ubuntu in ~/b47r1-ws\n\u{276f} codex resume 01a1\n{RESUMING_LOADING}");
        assert!(!ready(&after_shell), "the capture's history above it changes nothing");
        assert!(ready(RESUMED_QUOTING), "a transcript that quotes the phrase, even byte for byte, is loaded");
        assert!(ready(&format!("{RESUMED_QUOTING}{RESUMED_MIDTURN_TAIL}")), "the mid-turn resume, loaded");
        // A reply that reproduces the whole native block above the composer
        // is still loaded: a loaded composer has its status line under it.
        let replayed = "\u{2022} here it is:\n  >_ OpenAI Codex (v0.166.0)\n     loading\n  Resuming session\u{2026}\n\n\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol medium \u{b7} ~/b47r1-ws\n  ? for shortcuts\n";
        assert!(ready(replayed), "a quoted block over a loaded composer");
        // The block must be whole and directly over the LAST composer.
        assert!(ready(&RESUMING_LOADING.replace("     loading\n", "")), "no header line: not the native block");
        assert!(ready(&format!("{RESUMING_LOADING}\u{2022} later work\n\n\u{203a} Ask Codex to do anything\n  GPT-6.1-Sol medium \u{b7} ~/w\n  ? for shortcuts\n")), "an older block above later work");
        assert!(!ready("  >_ OpenAI Codex (v0.166.0)\n     loading\n  Resuming session\u{2026}\n"), "no composer yet: not ready either way");
    }

    /// Board #28, measured on codex-cli 0.166.0: `/new` fires no hook and
    /// writes no rollout; the new session opens at its first prompt, which
    /// fires SessionStart {source: "startup"} with the NEW session_id before
    /// UserPromptSubmit. Registering it moves the recorded id at that first
    /// prompt rather than at its Stop.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn the_new_sessions_start_is_registered() {
        assert!(codex_hooks("n")["SessionStart"].is_array());
    }
    /// Board #362 c, the SENTENCE alone (review P1-B: kept apart from the
    /// whole-screen evidence): codex-cli 0.154.0's expired-credential block,
    /// de-wrapped as `person_paint` joins it. Another status, another host,
    /// no request id, a message bullet or a stamp is not it.
    #[test]
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    fn the_401_is_exactly_codexs_bedrock_auth_block() {
        let real = "■ unexpected status 401 Unauthorized: Authentication failed: Please make sureyour API Key is valid., url:https://bedrock-runtime.us-west-2.amazonaws.com/openai/v1/responses, request id:389cc17d-bf5d-409b-ba80-102270246c79";
        assert!(super::bedrock_401(real));
        for bad in [
            real.replace("401 Unauthorized", "403 Forbidden"),
            real.replace("bedrock-runtime", "api.example"),
            real.replace("389cc17d-bf5d-409b-ba80-102270246c79", "pending"),
            real.replace('■', "•"),
            format!("[tmm chat 2026-10-14 11:27] orchestrator: {real}"),
        ] {
            assert!(!super::bedrock_401(&bad), "{bad}");
        }
    }

    use super::*;

    /// The catalog the user's config points at is the authoritative model
    /// list (board #231): its slugs are the list, any other spelling — the
    /// exact class the runtime endpoint rejects — fails at save time, and a
    /// home with no catalog degrades to accept-all. The home is the
    /// per-process test dir, never the developer's real `~/.codex`. Asserted
    /// on `model_list` directly: `models::list` caches per backend (600 s),
    /// and warming that cache here would couple test order.
    #[test]
    fn models_are_the_catalog_slugs_of_the_users_config() {
        let home = codex_user_home();
        assert_eq!(model_list(), Err(super::super::ModelReason::NotListed), "no config yet — no list");

        // A config with no catalog (board #70): codex's own catalogue for the
        // config (`codex debug models`) is offered as SUGGESTIONS — a custom
        // provider may serve more than codex lists, so it never refuses.
        std::fs::write(home.join("config.toml"), "model = \"gpt-6.1-sol\"\nmodel_provider = \"ust\"\n").unwrap();
        cli_stand_in::answer(Ok(vec!["gpt-6-astra".into(), "gpt-6.1-sol".into()]));
        assert_eq!(model_list(), Ok((vec!["gpt-6-astra".into(), "gpt-6.1-sol".into()], super::super::ModelKind::Suggestions)));
        assert_eq!(cli_stand_in::asked(), Some("model = \"gpt-6.1-sol\"\nmodel_provider = \"ust\"\n".to_string()), "codex is asked about the config as it is");
        // A CLI that cannot answer is a FAILURE the picker shows, never a
        // catalogue: typed ids stay accepted (AC3).
        cli_stand_in::answer(Err(super::super::ModelReason::CliFailed));
        assert_eq!(model_list(), Err(super::super::ModelReason::CliFailed));
        cli_stand_in::asked();
        // ...and its model IS the baseline default (board #511).
        assert_eq!(baseline_model(), Ok(Some("gpt-6.1-sol".to_string())));

        let catalog = home.join("models.json");
        std::fs::write(
            &catalog,
            r#"{"models":[{"slug":"global.openai.gpt-6-astra"},{"slug":"global.openai.gpt-5.6-sol"}]}"#,
        )
        .unwrap();
        std::fs::write(
            home.join("config.toml"),
            format!("model = \"global.openai.gpt-6-astra\"\nmodel_catalog_json = {:?}\n", catalog),
        )
        .unwrap();
        assert_eq!(
            model_list(),
            Ok((vec!["global.openai.gpt-6-astra".into(), "global.openai.gpt-5.6-sol".into()], super::super::ModelKind::Authoritative))
        );
        // A catalogue named but missing is a FAILURE, not stock codex.
        std::fs::write(home.join("config.toml"), format!("model_catalog_json = {:?}\n", home.join("gone.json"))).unwrap();
        assert_eq!(model_list(), Err(super::super::ModelReason::Unreadable));

        assert_eq!(cli_stand_in::asked(), None, "a named catalogue is read, codex is not run");

        // Authoritative, so read whole or not at all (board #511).
        assert_eq!(catalog_slugs_whole("not json"), None);
        assert_eq!(catalog_slugs_whole(r#"{"models":"nope"}"#), None);
        assert_eq!(catalog_slugs_whole(r#"{"models":[{"slug":"a"},{"name":"no slug"}]}"#), None, "one bad entry, no list");

        // Leave the home catalog-less: sibling tests share the per-process
        // dir and must keep seeing "no authoritative list".
        std::fs::remove_file(home.join("config.toml")).unwrap();
    }

    /// Board #70 S1 (validator): the cache keys a codex list on a DIGEST of
    /// the config, never its text: a config can carry credentials, and no
    /// config enters the cache (agents-overview.md § Model catalogue). The
    /// same text is the same stamp; any change is another.
    #[test]
    fn the_list_stamp_is_a_digest_never_the_config() {
        let home = codex_user_home();
        let a = "model_provider = \"ust\"\n# SENTINEL-c0ffee-secret\n";
        std::fs::write(home.join("config.toml"), a).unwrap();
        let stamp = model_list_stamp().expect("a readable config has a stamp");
        assert!(!stamp.contains("SENTINEL") && !stamp.contains("ust"), "the stamp holds no config text: {stamp}");
        assert_eq!(stamp.len(), 64, "a sha-256 hex digest");
        assert_eq!(model_list_stamp(), Some(stamp.clone()), "same text, same stamp");
        std::fs::write(home.join("config.toml"), "model_provider = \"amazon-bedrock-runtime\"\n").unwrap();
        assert_ne!(model_list_stamp(), Some(stamp), "a provider switch is another stamp");
        std::fs::remove_file(home.join("config.toml")).unwrap();
        assert_eq!(model_list_stamp(), None, "no config, no stamp");
    }

    /// Board #70 review R1, through the real config file: the stamp a list
    /// is stored under is the one of the text it was derived from. The
    /// config changes from UST to Bedrock WHILE codex is being asked; the
    /// answer is UST's and says so, and the Bedrock config now on disk has
    /// another stamp, so the cache cannot hand UST's list to it.
    #[test]
    fn the_stamp_and_the_list_come_from_one_read() {
        let home = codex_user_home();
        let ust = "model_provider = \"ust\"\n";
        let bedrock = "model_provider = \"amazon-bedrock-runtime\"\n";
        std::fs::write(home.join("config.toml"), ust).unwrap();
        cli_stand_in::answer(Ok(vec!["gpt-6.1-sol".into()]));
        cli_stand_in::rewrite_during_ask(bedrock);
        let (stamp, list) = model_list_stamped();
        assert_eq!(cli_stand_in::asked().as_deref(), Some(ust), "codex was asked about the text that was read");
        assert_eq!(std::fs::read_to_string(home.join("config.toml")).unwrap(), bedrock, "the file changed during the ask");
        assert_eq!(list, Ok((vec!["gpt-6.1-sol".to_string()], super::super::ModelKind::Suggestions)));
        assert_eq!(stamp, Some(stamp_of(ust)), "stored under the config it came from");
        assert_ne!(model_list_stamp(), stamp, "the config on disk now looks up another entry");
        cli_stand_in::answer(Err(super::super::ModelReason::CliFailed));
        std::fs::remove_file(home.join("config.toml")).unwrap();
    }

    /// `codex debug models` on codex-cli 0.166.0 (board #70): the ids codex
    /// offers are the `visibility: "list"` slugs, in its order; `hide` ones
    /// (internal reviewers, experiments) are not offered. Read whole: an
    /// entry without a string slug or visibility is an answer this parser
    /// does not know, so there is no list rather than a shorter one.
    #[test]
    fn debug_models_offers_the_listed_slugs_whole_or_nothing() {
        let measured = br#"{"models":[{"slug":"gpt-6-astra","visibility":"list","base_instructions":"..."},{"slug":"gpt-6.1-sol","visibility":"list"},{"slug":"codex-auto-review","visibility":"hide"},{"slug":"gpt-5.5","visibility":"list"}]}"#;
        assert_eq!(debug_model_ids(measured), Some(vec!["gpt-6-astra".to_string(), "gpt-6.1-sol".to_string(), "gpt-5.5".to_string()]));
        assert_eq!(debug_model_ids(b"not json"), None);
        assert_eq!(debug_model_ids(br#"{"models":[]}"#), None, "nothing to offer");
        assert_eq!(debug_model_ids(br#"{"models":[{"slug":"a","visibility":"hide"}]}"#), None, "nothing listed");
        assert_eq!(debug_model_ids(br#"{"models":[{"slug":"a","visibility":"list"},{"visibility":"list"}]}"#), None, "one entry without a slug");
        assert_eq!(debug_model_ids(br#"{"models":[{"slug":"a","visibility":"list"},{"slug":"b"}]}"#), None, "one entry without a visibility");
    }

    /// The measured 0.153.4 sub-agent shapes (board #169): a child's event is
    /// told apart by `agent_id`; the parent's identical-looking prompt has no
    /// such field; a child's end is `SubagentStop`, which is NOT a completion
    /// of the window's turn; the parent's `Stop` carries the reply body.
    #[test]
    fn subagent_threads_are_recognised_by_agent_id_and_never_end_the_turn() {
        let child = serde_json::json!({
            "session_id": "01a08e9b-b7d8-root", "turn_id": "01a08e9b-c9d1",
            "hook_event_name": "UserPromptSubmit",
            "agent_id": "01a08e9b-c9b0-7aa0-b09d-74139bb08191", "agent_type": "default",
            "prompt": "Reply with exactly the word PONG and nothing else."
        });
        assert_eq!(subagent_thread(&child), Some("01a08e9b-c9b0-7aa0-b09d-74139bb08191"));
        assert!(is_user_prompt_submit(&child), "still a prompt event — the door decides what to do with it");

        let parent = serde_json::json!({
            "session_id": "01a08e9b-b7d8-root", "turn_id": "01a08e9b-b801",
            "hook_event_name": "UserPromptSubmit",
            "prompt": "Use the spawn_agent tool …"
        });
        assert_eq!(subagent_thread(&parent), None);

        let stop = serde_json::json!({
            "session_id": "01a08e9b-b7d8-root", "hook_event_name": "SubagentStop",
            "agent_id": "01a08e9b-c9b0-7aa0-b09d-74139bb08191", "agent_type": "default",
            "agent_transcript_path": "/x/sessions/…/rollout-…-c9b0….jsonl", "stop_hook_active": false
        });
        assert_eq!(subagent_thread(&stop), Some("01a08e9b-c9b0-7aa0-b09d-74139bb08191"));
        assert!(normalize_kind(stop.as_object().unwrap()).is_err(), "a child's stop is not the window's turn end");

        let parent_stop = serde_json::json!({
            "session_id": "01a08e9b-b7d8-root", "hook_event_name": "Stop",
            "stop_hook_active": false, "last_assistant_message": "PONG"
        });
        assert_eq!(subagent_thread(&parent_stop), None);
        assert_eq!(normalize_kind(parent_stop.as_object().unwrap()), Ok("completed"));
    }
    #[test]
    fn a_picker_is_read_by_its_bottom_key_hints_and_a_composer_is_not() {
        // Screens captured on codex-cli 0.166.0 (live-check codex-picker, #66).
        let new = "  Worked for 2s • 23:43\n\n  Where should the new conversation run?\n\n\u{203a} 1. Use current Git worktree  Keep using the current working directory\n  2. Create new Git worktree   Create a separate checkout of this repository in\n                               another directory\n\n  enter select · esc back\n\n";
        let model = "  Select Model and Effort\n\u{203a} 1. GPT-6.1-Sol (current)  Latest workhorse model for coding and everyday work.\n\u{2193}\n  enter select · esc back\n";
        let resume = " Resume a previous session\n No sessions yet\n\u{2500}\u{2500}\u{2500}\n enter resume   esc exit   ^c exit   tab focus   \u{2190}/\u{2192} option\n ^o comfy   ^t preview   ^e exp   \u{2191}/\u{2193} browse\n";
        // Round 1 (validator's note 10): /experimental's footer leads with `space`.
        let experimental = "  Experimental features\n  Loading server experiments\u{2026}\n\n\n  space toggle \u{b7} enter save \u{b7} esc save/close\n";
        assert!(picker_open(new) && picker_open(model) && picker_open(resume) && picker_open(experimental));
        let idle = "\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol high · Context 0% used · /work/live · 01a1\u{2026}\n  ? for shortcuts                                      \u{26a0} 1 warning · f2 to view\n";
        let after_escape = "\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol high · Context 0% used · /work/live · Reply with picked\n  esc again to edit previous message\n";
        // The picker's own words quoted in the transcript, above a composer.
        let quoted = "\u{2022} codex paints `enter select · esc back` under a picker\n\n\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol high · Context 0% used · /work/live\n  ? for shortcuts\n";
        // A running turn, with a queued line (validator's menu-guard capture).
        let busy = "\u{2022} Working (1s \u{2022} esc to interrupt)\n\n\u{2022} Queued follow-up inputs\n  \u{21b3} /auditguard @probe\n    shift+\u{2190} edit last queued message\n\n\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol high \u{b7} Context 3% used \u{b7} /work/live\n  ? for shortcuts\n";
        let quoted_shape = "\u{2022} the footer reads: space toggle \u{b7} enter save \u{b7} esc save/close\n\n\u{203a} Ask Codex to do anything\n\n  GPT-6.1-Sol high \u{b7} Context 0% used \u{b7} /work/live\n  ? for shortcuts                                      \u{26a0} 1 warning \u{b7} f2 to view\n";
        assert!(!picker_open(idle) && !picker_open(after_escape) && !picker_open(quoted) && !picker_open(busy) && !picker_open(quoted_shape));
    }

}
