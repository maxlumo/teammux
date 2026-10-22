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

/// codex models are the slugs of the catalog the user's own config points at
/// (`model_catalog_json`): the bedrock-runtime endpoint rejects any other
/// spelling with `validation_error: The provided model identifier is invalid`
/// (measured on codex-cli 0.154.0, board #231 — `gpt-5.6-sol` fails where
/// `global.openai.gpt-5.6-sol` answers), so the catalog is authoritative and
/// a bare slug is rejected at save time. `None` when the config names no
/// catalog — stock codex takes aliases nobody can enumerate, and validation
/// degrades to accept-all (models.rs module doc).
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    let config = std::fs::read_to_string(codex_user_home().join("config.toml")).ok()?;
    let catalog = std::fs::read_to_string(catalog_path(&config)?).ok()?;
    let slugs = catalog_slugs(&catalog);
    (!slugs.is_empty()).then_some(slugs)
}

/// The `model_catalog_json` path out of a codex `config.toml`, if any.
fn catalog_path(config: &str) -> Option<std::path::PathBuf> {
    let table = config.parse::<toml::Table>().ok()?;
    table.get("model_catalog_json").and_then(toml::Value::as_str).map(std::path::PathBuf::from)
}

/// The `models[].slug` values of a codex model catalog, in file order.
pub(crate) fn catalog_slugs(json: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    v.get("models")
        .and_then(serde_json::Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m.get("slug").and_then(serde_json::Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
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
            if let Some(pct) = codex_context_left(line) {
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
    super::Measured { shape: "auth_expired", version: "0.154.0", at_most: false },
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
    for seg in line.trim().split('\u{b7}').map(str::trim) {
        if seg.starts_with('/') || seg.starts_with('~') {
            cwd = true;
        } else if let Some(pct) = codex_context_item(seg) {
            context_pct = Some(pct);
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

/// `<model> [<effort>]`, in either spelling codex has painted:
///
/// * the catalog SLUG — `xai.grok-4.6`, `gpt-5.2-codex`, `openai.gpt-5.6-sol`
///   (0.148.0 … 0.154.0) — one lowercase token carrying a digit;
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
    // The slug form: one token, lowercase, carrying a digit.
    let mut toks = s.split_whitespace();
    let model = toks.next()?;
    if toks.next().is_some() {
        return None;
    }
    (looks_like_model(model) && model.chars().any(|c| c.is_ascii_digit())).then_some(model)
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
        "Stop": [ { "hooks": [ { "type": "command", "command": notify } ] } ]
    })
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
    let mut config_args: Vec<String> = vec![format!("--profile {}", shared::CODEX_PROFILE)];
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
    if let Some(key) = codex_trust_key(workspace) {
        config_args.push(shared::codex_config_override(&key, Value::String("trusted".into())));
    }
    config_args.push("--dangerously-bypass-approvals-and-sandbox".into());
    config_args.push("--dangerously-bypass-hook-trust".into());
    Ok(Rendered {
        env: vec![("CODEX_HOME".into(), codex_home.to_string_lossy().to_string())],
        cmd: format!("command codex {}", config_args.join(" ")),
        confirmation: Some(shared::StartupConfirmation {
            markers: shared::CODEX_FOLDER_TRUST_MARKERS.to_vec(),
            ready_markers: vec!["Starting MCP servers", "OpenAI Codex"],
            accept_keys: vec!["Enter"],
            timeout: std::time::Duration::from_secs(120),
        }),
    })
}


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

pub(crate) fn resume_command(cmd: &str, id: Option<&str>) -> String {
    let which = id.map(crate::shell::quote).unwrap_or_else(|| "--last".to_string());
    with_resume(cmd, &which).unwrap_or_else(|| cmd.to_string())
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

#[cfg(test)]
mod tests {
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
    /// on `models_fetch` directly: `models::list` caches per backend (600 s),
    /// and warming that cache here would couple test order.
    #[test]
    fn models_are_the_catalog_slugs_of_the_users_config() {
        let home = codex_user_home();
        assert!(models_fetch().is_none(), "no config yet — no authoritative list");

        // A config with no catalog is stock codex — aliases, accept-all.
        std::fs::write(home.join("config.toml"), "model = \"gpt-5.6-sol\"\n").unwrap();
        assert!(models_fetch().is_none());

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
            models_fetch(),
            Some(vec!["global.openai.gpt-6-astra".into(), "global.openai.gpt-5.6-sol".into()])
        );

        assert_eq!(catalog_slugs("not json"), Vec::<String>::new());
        assert_eq!(catalog_slugs(r#"{"models":"nope"}"#), Vec::<String>::new());

        // Leave the home catalog-less: sibling tests share the per-process
        // dir and must keep seeing "no authoritative list".
        std::fs::remove_file(home.join("config.toml")).unwrap();
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
}
