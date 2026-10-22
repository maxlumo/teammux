//! The kiro backend's own knowledge (board #101/#127): every fact about how
//! this CLI is driven lives here — one file to touch when it changes.

/// queue|steer is kiro's own setting, `chat.defaultInterruptBehavior` in
/// `settings/cli.json` (board #245, measured on kiro-cli 2.22.1): `queue` makes
/// a line typed at a busy agent its own prompt after the turn (hook ack, reply
/// to its sender); `steer` injects it into the running turn with NO
/// `userPromptSubmit`, so the line is swept `unconfirmed` after the turn and
/// its sender enters no reply edge.
pub(crate) const SWITCHES_INPUT_MODE: bool = true;

/// The mode a NEW kiro definition starts in when it names none (board #336,
/// owner 2026-10-15: "在启动 Agent 的时候如果是 kiro 默认就给我使用 steer 模式吧
/// 不要用 queue 模式"). A definition that is already stored keeps what it was
/// saved with; Ctrl+S still toggles a running session.
pub(crate) const DEFAULT_INPUT_MODE: &str = "steer";

/// The cli.json key that carries the definition's input mode.
const INTERRUPT_KEY: &str = "chat.defaultInterruptBehavior";

/// The session can switch the mode LIVE: Ctrl+S (a named key) toggles it,
/// idle or mid-turn, for this session only — `settings/cli.json` is never
/// rewritten and a restart starts from it again (board #271, measured on
/// kiro-cli 2.22.1 `--agent-engine v3`).
pub(crate) const LIVE_INPUT_TOGGLE: Option<&str> = Some("C-s");

/// The mode this pane RUNS now, read off its screen (board #271) — `None`
/// when the screen does not say, and the caller falls back to the launch
/// recipe's start mode. kiro paints it in two measured shapes, both matched
/// by the shape of the LINE so a quoted copy (a chat delivery under its `›`
/// stamp, tool output under a `●` head) never counts:
/// - the confirmation of a Ctrl+S, a column-zero line that is only
///   `<bullet> Switched to Steer mode` / `… Queue mode`; kiro keeps only the
///   newest one, so the bottom-most is the current mode;
/// - while a turn runs, the prompt line `›  Kiro is working · 19m 10s · Type
///   to steer · Ctrl+S to queue`. Idle, kiro paints no mode at all.
/// The confirmation outranks the footer (orchestrator, #271): both follow the
/// latest toggle, and the confirmation is also there while idle.
///
/// Board #346: BOTH shapes had drifted and the toggle could no longer be
/// confirmed in either state — the bullet became `•` (U+2022) where 2.22.1
/// painted `●` (U+25CF), and the footer gained an elapsed segment between
/// the label and the hints. Measured on kiro-cli 2.28.0 on this host
/// (`capture-pane -p -J -S -0 | cat -A`): `• Switched to Steer mode`,
/// `›  Kiro is working · 1m 27s · Type to steer · Ctrl+S to queue`,
/// `›  Kiro is working · 19s · Type to queue · Ctrl+S to steer`. So neither
/// shape is matched by one fixed prefix any more: the toast's bullet is one
/// of a NAMED set of glyphs (`TOAST_BULLETS`) and the footer's hints are read
/// as segments. The 2.22.1 forms still match. A bullet outside the set is a
/// miss we can see and name — add the glyph there with the version that
/// painted it; "any glyph" would instead accept a line a person or a delivery
/// can write.
pub(crate) fn live_input_mode(pane: &str) -> Option<&'static str> {
    let lines: Vec<&str> = pane.lines().collect();
    for line in lines.iter().rev() {
        if let Some(m) = toast_mode(line.trim_end()) {
            return Some(m);
        }
    }
    for line in lines.iter().rev() {
        if let Some(m) = footer_mode(line.trim_end()) {
            return Some(m);
        }
    }
    None
}

/// The one word kiro uses for each mode, in either case.
fn mode_word(word: &str) -> Option<&'static str> {
    match word {
        "queue" | "Queue" => Some("queue"),
        "steer" | "Steer" => Some("steer"),
        _ => None,
    }
}

/// The glyphs kiro has been seen to paint a toast with: `●` on kiro-cli
/// 2.22.1 and `•` on 2.28.0 are MEASURED on this host; the other four are
/// the same bullet family kiro uses elsewhere in its chrome, listed so a
/// minor repaint is not another outage (#346). Deliberately a closed set and
/// not "any glyph": a toast is otherwise an ordinary sentence, and anything
/// a person or a delivery can put at the start of a line — kiro's own input
/// stamp `›`, a quote marker, a dash — would become a mode switch.
const TOAST_BULLETS: [char; 6] = ['●', '•', '○', '◦', '◆', '◇'];

/// The glyphs kiro paints a column-zero block under: its prose, its tool
/// calls and its ERRORS. `●` on kiro-cli 2.22.1 and `•` on 2.28.0 — the same
/// move that broke the steer toast (#346) broke the high-traffic recovery
/// (#361): measured 2026-10-14 on this host's pane scrollbacks (read with
/// `capture-pane -p -J`, as `check_once` reads them), 49 of 49 blocks open
/// with `•` and none with `●`, and auto-recovery had been silent since the
/// upgrade. A CLOSED set of exactly the two measured glyphs, not "any glyph"
/// (that was the #346 P1) and not `TOAST_BULLETS`: that one is wider on
/// purpose for a line whose whole text is fixed, while here the line is the
/// START of free text, and a false hit types `continue` into a working agent.
pub(crate) const HEAD_GLYPHS: [char; 2] = ['●', '•'];

/// kiro's own confirmation of a Ctrl+S: at column zero, one bullet from
/// `TOAST_BULLETS`, a space, and EXACTLY `Switched to <Mode> mode`. The
/// bullet is read as a glyph rather than as part of a fixed prefix because it
/// changed between builds and broke the toggle (#346); a leading space (tool
/// output, the queued-count line) and anything outside the set are not
/// confirmations.
fn toast_mode(line: &str) -> Option<&'static str> {
    let bullet = line.chars().next()?;
    if !TOAST_BULLETS.contains(&bullet) {
        return None;
    }
    let rest = line[bullet.len_utf8()..].strip_prefix(' ')?.trim_start();
    let rest = rest.strip_prefix("Switched to ")?;
    rest.strip_suffix(" mode").and_then(mode_word)
}

/// The footer kiro paints while a turn runs. The line must BE that footer —
/// the label at column zero, after kiro's stamp and its two spaces or (older
/// builds) one optional space — and the two hints are then read as SEGMENTS
/// of it: the word after `· Type to ` is the mode it is in, the word after
/// `· Ctrl+S to ` the other one. Reading segments instead of one fixed
/// prefix is what survives 2.28.0's elapsed time (`· 19m 10s ·`) between
/// them, and reading them as whole words is what keeps "the line mentions
/// steer" from being an answer.
fn footer_mode(line: &str) -> Option<&'static str> {
    let body = match line.strip_prefix('›') {
        Some(after) if after.starts_with(' ') => after.trim_start(),
        Some(_) => return None,
        None => line.strip_prefix(' ').unwrap_or(line),
    };
    let rest = body.strip_prefix("Kiro is working")?;
    let now = mode_word(segment_after(rest, " · Type to ")?)?;
    let other = mode_word(segment_after(rest, " · Ctrl+S to ")?)?;
    // A footer that offers the mode it is already in says nothing.
    (now != other).then_some(now)
}

/// What follows `marker` up to the next ` · ` — one segment of the footer.
fn segment_after<'a>(line: &'a str, marker: &str) -> Option<&'a str> {
    let at = line.find(marker)? + marker.len();
    let tail = &line[at..];
    Some(tail.split(" · ").next().unwrap_or(tail).trim_end())
}

/// Reasoning-effort levels kiro-cli accepts (`kiro-cli chat --effort`,
/// measured 2026-08-22: "e.g. low, medium, high, xhigh, max").
pub(crate) fn effort_values() -> &'static [&'static str] {
    &["low", "medium", "high", "xhigh", "max"]
}

/// `kiro-cli chat --list-models -f json` enumerates real model ids.
pub(crate) fn models_fetch() -> Option<Vec<String>> {
    let out = std::process::Command::new("kiro-cli")
        .args(["chat", "--list-models", "-f", "json"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let models: Vec<String> = parsed
        .get("models")?
        .as_array()?
        .iter()
        .filter_map(|m| m.get("model_id")?.as_str().map(str::to_string))
        .collect();
    (!models.is_empty()).then_some(models)
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::vitals::{branch, context_pct, looks_like_model, Vitals, EFFORTS};

/// Read what the last lines of a pane say about the agent's current state.
///
/// `agent` is normally the first status segment (the managed window name).
/// Resumed legacy conversations may retain the exact built-in `kiro_default`
/// identity, which is accepted as the one narrow fallback. The anchor is not a
/// filter: fields that identify themselves by shape (context and branch) are
/// read even when it never appears, because narrow panes wrap later segments.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn sniff_kiro(pane: &str, agent: &str) -> Vitals {
    let mut v = Vitals::default();
    // Bottom-up: the newest paint of the status line is the last one.
    for line in pane.lines().rev().take(12) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A WIDE pane keeps `location · branch` right-aligned on the SAME line
        // as the left segments, joined not by `·` but by the padding run of
        // spaces — so the last left segment arrives glued to the location
        // (`◔ 5%       /local/home/cfu/temp`) and its parser refuses it
        // (owner, 2026-08-26: context missing on the chat project). A run of
        // two or more spaces is that gap and never occurs INSIDE a segment
        // (`◔ 5%` is single-spaced), so it is a segment boundary too. Narrow
        // panes wrap the right side onto its own line and are unaffected.
        let segs: Vec<&str> = line
            .split('·')
            .flat_map(|s| s.split("  "))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();

        // The activity line ("Kiro is working · Type to queue · …") shares the
        // dot separator with the status line, and its words are not segments.
        if segs.iter().any(|s| s.starts_with("Kiro is ") || *s == "Type to queue") {
            continue;
        }

        // Is this the status line proper? Usually kiro's left side starts with
        // the managed window/registry name. A resumed conversation can retain
        // Kiro's exact built-in identity `kiro_default` even though the app
        // window was later named `chat`; that line is still the TUI's own
        // status and therefore the runtime-model authority. Keep the exception
        // exact — arbitrary first segments remain ordinary output.
        // Effort has no identifying glyph, so it is read ONLY on this anchored
        // line and only as the segment immediately before the context segment.
        // Matching bare low/medium/high words elsewhere made ordinary output
        // look like a runtime setting.
        let anchored = segs.first().is_some_and(|s| *s == agent || *s == "kiro_default");
        if anchored && v.effort.is_none() && !v.effort_definitive {
            if let Some(ci) = segs.iter().position(|s| context_pct(s).is_some()) {
                let word = segs[ci.saturating_sub(1)].to_ascii_lowercase();
                if ci > 0 && EFFORTS.contains(&word.as_str()) {
                    v.effort = Some(word);
                }
            }
        }

        for (i, seg) in segs.iter().enumerate() {
            if v.context_pct.is_none() {
                if let Some(pct) = context_pct(seg) {
                    v.context_pct = Some(pct);
                    continue;
                }
            }
            if v.branch.is_none() {
                if let Some(b) = branch(seg) {
                    v.branch = Some(b.to_string());
                    continue;
                }
            }
            // The model is positional — it is whatever follows the agent name
            // (and the optional `Autonomous` flag). Anchoring on the name the
            // caller gave us is what keeps a cwd or a tangent from being read as
            // a model id.
            if v.model.is_none() && i == 0 && anchored {
                let next = segs
                    .iter()
                    .skip(1)
                    .find(|s| !s.eq_ignore_ascii_case("Autonomous"));
                // v2 prints the slug (`claude-sonnet-5`), the v3 engine the
                // DISPLAY name (`Claude Sonnet 5`, board #207) — both are the
                // model, and only here, right after the anchor, is a name
                // with spaces one.
                if let Some(m) = next.filter(|m| looks_like_model(m) || looks_like_model_name(m)) {
                    v.model = Some((*m).to_string());
                }
            }
        }
        // The anchored line carrying its context segment is the FULL left side
        // (`agent · [autonomous] · model · [effort] · context`): whatever it
        // says about effort — including "nothing" — is the verdict. kiro omits
        // the segment when the effort is the backend default, so absence here
        // is a reading, not a miss, and backfill must not overwrite it.
        if anchored && v.context_pct.is_some() {
            v.effort_definitive = true;
        }
    }
    v
}


use serde_json::{json, Value};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use std::path::Path;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::spawn::{effort_flag, Rendered};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use crate::projects::store::RegAgent;

#[cfg(not(any(target_os = "android", target_os = "ios")))]
use super::shared;

/// The hook set for each backend, in ONE place. `render_*` writes it at spawn
/// and `refresh_hooks` rewrites it on every start, so a config on disk can
/// never be older than the app that reads its events. (It was: agents spawned
/// before `userPromptSubmit` existed kept a three-hook config, and since that
/// hook is the only reset of the same-turn dedup flag, their first `tmm send`
/// silently killed the stop-hook auto-post for the rest of the window's life.)
#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// A model DISPLAY name as kiro-cli --v3's status line prints it: words of
/// letters/digits/dots/dashes separated by single spaces, at least one letter,
/// ≤ 48 chars ("Claude Sonnet 5", "GPT 5.1 Codex"). Read only right after the
/// anchor — the position is what makes a name with spaces a model and not a
/// path, a branch, a "Midway: 19h 19m" segment (the colon fails) or a "◔ 4%".
pub(crate) fn looks_like_model_name(s: &str) -> bool {
    let word_ok = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    !s.is_empty()
        && s.len() <= 48
        && s.chars().any(|c| c.is_ascii_alphabetic())
        && !s.contains("  ")
        && s.split(' ').all(word_ok)
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

pub(crate) fn kiro_hooks(notify: &str) -> Value {
    // The 3.0 profile shape (kiro-cli 2.22.1, board #207): an ARRAY of named
    // hooks. The v2 engine accepts it and fires all four (measured,
    // hooks-v2b.log); v3 fires prompt/stop and gates the tool hooks behind
    // its featureFlags.v2Hooks. Writing this shape means the CLI's
    // "agent configs are still in the 2.0 format" upgrade never runs on our
    // homes — no startup modal, no `.bak`, no rewrite churn against refresh.
    // No `matcher` on any hook: in 3.0 the matcher is a regex and the 2.0
    // glob "*" makes the whole profile invalid ("agent … not found, using
    // default" — measured); a hook without a matcher fires for every tool.
    let hook = |name: &str, trigger: &str| {
        json!({
            "name": name,
            "trigger": trigger,
            "action": { "type": "command", "command": notify },
            "timeout": 10,
        })
    };
    json!([
        // The notify helper feeds notifications AND telemetry (tool events are
        // recognized by hook_event_name and routed to telemetry only).
        hook("tmm-pre-tool", "preToolUse"),
        hook("tmm-post-tool", "postToolUse"),
        // Turn start — the ONLY reset of the same-turn dedup flag, and the
        // event that carries the submitted prompt.
        hook("tmm-prompt", "userPromptSubmit"),
        hook("tmm-stop", "stop"),
    ])
}

/// The 3.0 profile's permission block, the equivalent of `--trust-all-tools`
/// spelled in the config (the CLI's own upgrade writes exactly this).
pub(crate) fn kiro_permissions() -> Value {
    json!({ "rules": [ { "capability": "all", "effect": "allow" } ] })
}

/// Bring a managed profile to the 3.0 shape without churn: hooks replaced
/// only when they differ (either old shape), `permissions` added only when
/// absent (a block the user or the CLI wrote is theirs). Returns true on
/// change.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn patch_profile(path: &Path, hooks: Value) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(false) };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else { return Ok(false) };
    let Some(obj) = root.as_object_mut() else { return Ok(false) };
    let mut changed = false;
    if obj.get("hooks") != Some(&hooks) {
        obj.insert("hooks".into(), hooks);
        changed = true;
    }
    if !obj.contains_key("permissions") {
        obj.insert("permissions".into(), kiro_permissions());
        changed = true;
    }
    if !changed {
        return Ok(false);
    }
    shared::write_atomic(path, &serde_json::to_string_pretty(&root).unwrap_or(text)).map(|_| true)
}

/// The CLI settings every managed kiro agent runs with (`<home>/settings/
/// cli.json`, read because the pane launches with `KIRO_HOME=<home>`).
///
/// `chat.defaultInterruptBehavior` is NOT in this list: it is the
/// definition's input mode (board #245), written by `render_kiro` from the def
/// and only backfilled by `ensure_kiro_settings`. Queue is the default (owner,
/// 2026-08-20: "所有 Agent 在 kiro 里边发送指令的模式 默认给我设计成 Queue 队列模式吧
/// 不要 steer 模式"): a line typed at a BUSY agent waits for the turn to end
/// and is read whole, as its own prompt — the contract the delivery pipeline
/// assumes (`overdue_rows` pauses the ack clock while a turn is open). The
/// setting is only the START mode: kiro 2.22.1 v3 toggles it per session on
/// Ctrl+S or from its settings menu, and a STEERED line fires no
/// `userPromptSubmit`, so it can never be acknowledged (board #249).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn kiro_cli_settings() -> Vec<(&'static str, Value)> {
    vec![
        ("chat.disableTrustAllConfirmation", json!(true)),
        // MCP tool schemas are DEFERRED into a compact list and loaded on
        // demand via kiro's own tool_search (owner, 2026-08-28: "给 kiro 的
        // mcp 工具开启 toolsearch"). Thresholds 0/0 = defer whenever any MCP
        // tools are present, which is the progressive behavior asked for.
        ("toolSearch.enabled", json!(true)),
        ("toolSearch.minPct", json!(0)),
        ("toolSearch.minTokens", json!(0)),
        // kiro-cli 2.22.1 --v3 (board #207): without this the CLI parks an
        // unattended pane on "Your agent configs are still in the 2.0 format.
        // Upgrade?". Our profiles are already 3.0-shaped, so with it set the
        // upgrade is a no-op — no `.bak`, no rewrite.
        ("chat.enableAutoAgentUpgrade", json!(true)),
    ]
}

/// The one per-agent setting: v3 IGNORES the profile's `model` and reads
/// `chat.defaultModel` from the home settings (board #207). The profile keeps
/// `model` for v2; both come from the same definition, so they cannot
/// disagree. An empty model means the backend default: the key is OMITTED,
/// and a stale key is DELETED when the model is cleared — otherwise an old
/// pin outlives the config.
pub(crate) const DEFAULT_MODEL_KEY: &str = "chat.defaultModel";

/// Force the canonical CLI settings into a managed kiro home, leaving any
/// other keys alone. Creates the file when it is missing (pre-settings homes),
/// no-op write when everything already matches — the same contract as
/// `patch_hooks`, because the app owns these configs. Returns true on change.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_kiro_settings(home: &Path, model: &str) -> Result<bool, String> {
    let dir = home.join("settings");
    let path = dir.join("cli.json");
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let obj = root.as_object_mut().expect("filtered to object above");
    let mut changed = !path.is_file();
    for (key, value) in kiro_cli_settings() {
        if obj.get(key) != Some(&value) {
            obj.insert(key.to_string(), value);
            changed = true;
        }
    }
    // The input mode is the DEFINITION's (render_kiro writes it at spawn and
    // restart); this repair path has no def, so it keeps a valid value and
    // only backfills a home that predates the key (board #245).
    if !matches!(obj.get(INTERRUPT_KEY).and_then(Value::as_str), Some("queue" | "steer")) {
        obj.insert(INTERRUPT_KEY.into(), json!("queue"));
        changed = true;
    }
    let model = model.trim();
    if model.is_empty() {
        changed |= obj.remove(DEFAULT_MODEL_KEY).is_some();
    } else if obj.get(DEFAULT_MODEL_KEY).and_then(Value::as_str) != Some(model) {
        obj.insert(DEFAULT_MODEL_KEY.into(), json!(model));
        changed = true;
    }
    if !changed {
        return Ok(false);
    }
    shared::write_atomic(&path, &serde_json::to_string_pretty(&root).unwrap()).map(|_| true)
}

/// The model a managed profile pins (its `model` key), or "" — what refresh
/// mirrors into `chat.defaultModel` so the v3 engine reads the same id v2 does.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn profile_model(config: &Path) -> String {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default()
}

/// ` --agent-engine v3` when the app-wide engine door is open, else nothing
/// — the v2 launch line is byte-for-byte what it was, so flipping the door
/// back leaves no trace (board #207). The door is `kiro_engine` in
/// config.toml (`KIRO_ENGINE` overrides), read at spawn and at refresh: an
/// agent takes the new engine at its next restart, so one scratch agent can be
/// flipped alone before the owner restarts the real ones.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn engine_flag() -> String {
    match crate::config::kiro_engine().as_str() {
        "v3" => " --agent-engine v3".into(),
        _ => String::new(),
    }
}

/// Bring a launch recipe's engine segment in line with the door: add
/// ` --agent-engine v3` after `--trust-all-tools` when the door is open and
/// the line lacks it, drop any ` --agent-engine <x>` when it is closed. Exact
/// token surgery on the recorded line, like `migrate_launch_model`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn reconcile_recipe_engine(home: &Path) -> Result<bool, String> {
    // Through the recipe's one door (board #384): the read is inside the
    // home's section and only `cmd` changes, so a team move is never undone.
    let flag = engine_flag();
    crate::projects::recipe::update_recipe(home, |slot| {
        let Some(recipe) = slot.as_mut() else { return false };
        let Some(cmd) = recipe.get("cmd").and_then(Value::as_str) else { return false };
        let Some(next) = reconcile_engine_in(cmd, &flag) else { return false };
        recipe["cmd"] = json!(next);
        true
    })
}

/// The pure half: `Some(new line)` when the engine segment has to change.
pub(crate) fn reconcile_engine_in(cmd: &str, flag: &str) -> Option<String> {
    let mut tokens: Vec<&str> = cmd.split_whitespace().collect();
    let has = tokens.iter().position(|t| *t == "--agent-engine");
    let want: Vec<&str> = flag.split_whitespace().collect();
    match (has, want.is_empty()) {
        (Some(at), true) => {
            tokens.drain(at..(at + 2).min(tokens.len()));
            Some(tokens.join(" "))
        }
        (Some(at), false) => {
            if tokens.get(at + 1) == want.get(1) {
                return None;
            }
            if at + 1 < tokens.len() {
                tokens[at + 1] = want[1];
            } else {
                tokens.push(want[1]);
            }
            Some(tokens.join(" "))
        }
        (None, true) => None,
        (None, false) => Some(format!("{cmd}{flag}")),
    }
}

/// The v3 engine's Stop payload carries no reply text; the final response of
/// the turn is the last `assistant` entry of the GLOBAL session file
/// `~/.kiro/sessions/<cwd-hash>/sess_<id>/messages.jsonl` (board #207; the
/// hook's `session_id` names the directory). Each line is
/// `{id, timestamp, payload: {type, content, …}}`; a turn is `turn_start` …
/// `turn_end` and may hold several `assistant` entries (text between tool
/// calls, then the final text) — the reply is the LAST assistant entry after
/// the LAST `turn_start`. Bad lines are skipped, never fatal.
pub(crate) fn kiro_reply_from_session(jsonl: &str) -> Option<String> {
    let mut reply: Option<String> = None;
    for line in jsonl.lines() {
        let Ok(row) = serde_json::from_str::<Value>(line) else { continue };
        let payload = row.get("payload").unwrap_or(&row);
        match payload.get("type").and_then(Value::as_str) {
            Some("turn_start") => reply = None,
            Some("assistant") => {
                if let Some(text) = payload.get("content").and_then(Value::as_str) {
                    let text = text.trim();
                    // KAS closes a turn with a placeholder assistant row
                    // (`"..."`, measured 2.22.1 through a managed spawn) after
                    // the real text; a row without one letter or digit is
                    // not the reply (board #213: it posted "..." to the room).
                    if text.chars().any(char::is_alphanumeric) {
                        reply = Some(text.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    reply
}

/// kiro-cli v3 closes a turn that produced NO assistant message with a
/// placeholder row so message alternation holds, and the Stop hook hands that
/// text over as the turn's reply (board #355; measured on the room log: 27
/// such lines between 2026-10-12 and 10-15 across eight agents). It is the
/// CLI's own sentence, not the agent's: a turn whose whole reply is this
/// ended without saying anything, whatever it was in the middle of.
///
/// The text, whole. Measured: 31 `assistant` rows, `operationType: "Say"`, in
/// `~/.kiro/sessions/*/messages.jsonl` written between 2026-10-12 and
/// 2026-10-14 by kiro-cli 2.28 through 2.31 (the host runs 2.31.0; the store
/// does not record which CLI wrote a row) — all 31 byte-identical, em dash and
/// all. Nothing else is accepted: this line decides whether an agent is TYPED
/// into, so a prefix, the sentence followed by real text, or a reply that
/// merely quotes it is a reply, never the CLI's stand-in.
const EMPTY_TURN_PLACEHOLDER: &str = "(No assistant response was recorded for the preceding turn. This placeholder was inserted automatically to preserve message alternation — it is not a reply the assistant produced.)";

/// Is `text` that placeholder and nothing else? Whitespace is normalised (a
/// hook may hand the reply over wrapped or padded); no word is.
pub(crate) fn is_empty_turn_reply(text: &str) -> bool {
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    words(text) == words(EMPTY_TURN_PLACEHOLDER)
}

/// A session id is one path component: never empty, never a path, never a
/// dotfile. The ONE guard for every place an id from outside becomes part of a
/// path under a sessions root (the reply lookup, board #376, and the resume
/// check, board #379).
fn valid_session_id(id: &str) -> bool {
    !(id.is_empty() || id.contains(['/', '\\']) || id.starts_with('.'))
}

/// What a sessions root can tell us about one session (board #376 review
/// P1, both rounds). THREE outcomes, because two of them used to be one:
///
/// * `Missing` — this root does not hold the session. The only outcome that
///   may send the caller to another root.
/// * `Found(reply)` — it holds it; `reply` is the latest turn's text, or
///   `None` when that turn has none (kiro's `"..."` placeholder, #213) or
///   its file cannot be read yet. An answer, not a miss: taking another
///   root's copy of the same id would post a different conversation's older
///   sentence as this turn's reply.
/// * `Unreadable` — we could not TELL. A permission error, an I/O error, a
///   root that is not a directory, an entry we could not enumerate. "I could
///   not ask" is not "there is nobody" (the same rule the roster learned in
///   the vitals work), so this is never a reason to read a stale copy.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[derive(Debug, PartialEq)]
pub(crate) enum SessionSource {
    Missing,
    Found(Option<String>),
    Unreadable,
}

/// Locate the session under `sessions_root` and read what it says.
///
/// `sessions_root` is `<KIRO_HOME>/sessions` for a managed agent,
/// `~/.kiro/sessions` for the legacy store, and a temp dir in tests. Desktop
/// only, like the rest of the spawn/observe surface: the mobile shell never
/// reads an agent's session store (the Android build broke on the
/// desktop-only `Path` import, 2026-09-20, the first APK after #207).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn session_lookup(sessions_root: &Path, session_id: &str) -> SessionSource {
    if !valid_session_id(session_id) {
        // Not a session id at all: no root can hold it, and nothing is
        // uncertain about that.
        return SessionSource::Missing;
    }
    let dirs = match std::fs::read_dir(sessions_root) {
        Ok(dirs) => dirs,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SessionSource::Missing,
        // A root we cannot read is not an empty root.
        Err(_) => return SessionSource::Unreadable,
    };
    let mut unreadable = false;
    for entry in dirs {
        let Ok(entry) = entry else {
            // One bucket we could not enumerate: we can still FIND the
            // session in another, but we may not conclude it is absent.
            unreadable = true;
            continue;
        };
        let dir = entry.path().join(session_id);
        match std::fs::metadata(&dir) {
            Ok(meta) if meta.is_dir() => {
                return SessionSource::Found(
                    std::fs::read_to_string(dir.join("messages.jsonl"))
                        .ok()
                        .and_then(|text| kiro_reply_from_session(&text)),
                )
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => unreadable = true,
        }
    }
    if unreadable {
        SessionSource::Unreadable
    } else {
        SessionSource::Missing
    }
}

/// The reply this root has for the session, for the callers that only want
/// the text: every outcome but a found reply is `None`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn session_reply(sessions_root: &Path, session_id: &str) -> Option<String> {
    match session_lookup(sessions_root, session_id) {
        SessionSource::Found(reply) => reply,
        _ => None,
    }
}

/// The v3 fallback wired into the notify helper: the kiro Stop payload has no
/// text, the session file has.
///
/// `home` is the agent's ISOLATED home (`<ws>/.tmm/agents/<name>`, the
/// `KIRO_HOME` it runs with), and it is searched FIRST — because that is
/// where the running agent writes (board #376, 2026-10-15). The global
/// `~/.kiro/sessions` is only the legacy fallback, for a window spawned
/// before homes were isolated and for an unmanaged one we have no home for.
///
/// The incident, laminar-log (owner 01:35: "为啥 agent 返回的结果界面上都看
/// 不到"): the room had ZERO replies from four kiro agents while their panes
/// finished turns normally. This helper ignored the `home` it was handed and
/// read the global store, where a STALE COPY of the same session id survived
/// from before that agent's home was isolated (mtime 00:03 against the live
/// file's 01:39, 414 assistant rows). Every Stop found the stale file first,
/// returned the same old sentence, and nothing new was recorded — no room
/// line and no reply edge, so every `@editor` request from the owner was a
/// dead end for the team too. Order, not existence, is what was wrong: both
/// files were there, and the wrong one answered.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn reply_fallback(
    payload: &serde_json::Map<String, Value>, home: Option<&Path>,
) -> Option<String> {
    let id = crate::agent_notifications::string_field(payload, &["session_id", "sessionId"])?;
    // The isolated home first. `sessions/` sits directly in KIRO_HOME, the
    // same layout the global store has under `~/.kiro`. Its ANSWER stands,
    // text or none: the legacy store is consulted only when the isolated
    // home does not hold this session at all (board #376 review P1 — "no
    // reply this turn" is an answer, and falling through on it would hand
    // back an old sentence from a stale copy and spend the turn's reply edge
    // on it).
    if let Some(home) = home {
        match session_lookup(&home.join("sessions"), &id) {
            SessionSource::Found(reply) => return reply,
            // We could not tell whether the live session is there, so we do
            // not guess from a copy that may be another conversation's.
            SessionSource::Unreadable => return None,
            SessionSource::Missing => {}
        }
    }
    match session_lookup(&legacy_sessions_root()?, &id) {
        SessionSource::Found(reply) => reply,
        _ => None,
    }
}

/// kiro's GLOBAL session store, `~/.kiro/sessions` — the legacy half of
/// `reply_fallback`.
#[cfg(all(not(test), not(any(target_os = "android", target_os = "ios"))))]
fn legacy_sessions_root() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    Some(home.join(".kiro").join("sessions"))
}

/// Under test the global store is a per-process temp dir, like codex's user
/// home (board #216): the isolation door belongs where the path is resolved,
/// so no test can read the developer's own `~/.kiro` — and #376's test writes
/// a STALE session copy into this one on purpose.
#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
fn legacy_sessions_root() -> Option<std::path::PathBuf> {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    Some(DIR.get_or_init(|| crate::config::fresh_process_dir("tmm-kiro-global")).join("sessions"))
}

/// Move a `--model <id>` an older build put on the launch line into the agent
/// config, where kiro actually honours it, and drop it from the recipe so the
/// two cannot disagree. Exact information, so nothing is guessed: the id is
/// read off the line that was really used.
///
/// Why it matters beyond tidiness: `refresh_hooks` also BACKFILLS recipes for
/// pre-recipe agents, and that backfilled line has no `--model` at all — so an
/// agent restarted through that path silently lost its model. Once the id is in
/// the config it survives every start (`up`, restart, resume) because they all
/// pass `--agent`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn migrate_launch_model(home: &Path, config: &Path) -> Result<bool, String> {
    // Through the recipe's one door (board #384): the read is inside the
    // home's section and only `cmd` changes, so a team move is never undone.
    // `None` = nothing to migrate; `Some(model)` = the line was rewritten.
    let migrated = crate::projects::recipe::update_recipe(home, |slot| {
        let recipe = slot.as_mut()?;
        let cmd = recipe.get("cmd").and_then(Value::as_str)?.to_string();
        // Model ids never contain whitespace, so token splitting is exact here.
        let mut tokens: Vec<&str> = cmd.split_whitespace().collect();
        let at = tokens.iter().position(|t| *t == "--model")?;
        let model = tokens
            .get(at + 1)
            .map(|m| m.trim_matches('\'').trim_matches('"').to_string())
            .filter(|m| !m.is_empty() && !m.starts_with('-'));
        tokens.drain(at..(at + 2).min(tokens.len()));
        recipe["cmd"] = json!(tokens.join(" "));
        Some(model)
    });
    let Some(model) = migrated? else { return Ok(false) };
    let recipe_written = true;
    // Only fill a config that has no model of its own: a value already there
    // came from a newer spawn (or the user) and outranks the old launch line.
    let Some(model) = model else { return Ok(recipe_written) };
    // And only if the backend actually accepts it. An id it rejects was never
    // the agent's model — kiro fell back to its default and said so above the
    // splash — so carrying the typo into the config would turn a working agent
    // into a mute one on its next restart. Dropping it preserves what was
    // really running.
    if let Err(e) = crate::projects::models::validate("kiro", &model) {
        eprintln!("projects: dropping the launch line's model for a managed agent — {e}");
        return Ok(recipe_written);
    }
    let config_written = std::fs::read_to_string(config)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|mut root| {
            let obj = root.as_object_mut()?;
            if obj.contains_key("model") {
                return None;
            }
            obj.insert("model".into(), json!(model));
            Some(shared::write_atomic(config, &serde_json::to_string_pretty(&root).unwrap()).map(|_| true))
        })
        .unwrap_or(Ok(false))?;
    Ok(recipe_written || config_written)
}

/// The environment a managed kiro pane launches with — ONE definition for
/// the spawn recipe and the launch.json backfill.
///
/// `KIRO_HOME` is the isolated home (the agent's identity). `KIRO_SKIP_MIDWAY_CHECK`
/// (board #183, owner 2026-09-12: "跳过这个提示，避免启动被阻塞住"): a managed
/// pane is unattended, and kiro-cli's launch-time "Your Midway session has
/// expired or is missing. Refresh it now with mwinit? [y/N]" parks the agent
/// until a human types. kiro-cli 2.21.4 reads this switch right beside that
/// prompt (`crates/chat-cli/src/launch/midway.rs`); there is no flag or
/// setting for it. Skipping the CHECK changes nothing about kiro's own login —
/// Midway only gates internal endpoints, and an expired session fails those
/// calls instead of freezing the launch.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn kiro_launch_env(home: &Path) -> Vec<(String, String)> {
    vec![
        ("KIRO_HOME".into(), home.to_string_lossy().to_string()),
        ("KIRO_SKIP_MIDWAY_CHECK".into(), "1".into()),
    ]
}

/// The v3 engine's door to an agent's identity is the WORKSPACE, not
/// `KIRO_HOME` (board #207, measured on kiro-cli 2.22.1 with a private home:
/// the same profile is "not found" under any other name or from any other
/// cwd, and found the moment it sits in `<ws>/.kiro/agents/`). So, only while
/// the engine door is open, the workspace carries ONE entry per managed agent:
/// `<ws>/.kiro/agents/<name>.json` → symlink → the isolated home's profile.
/// The truth does not fork — v3 reads THROUGH the link, the CLI's own
/// upgrade writes through it — and v2 sees no change at all.
///
/// Rules: idempotent on every start; an existing file that is NOT our symlink
/// is never clobbered (fail loud, naming it); the path goes into
/// `.git/info/exclude` when the workspace is a git checkout, so an agent's
/// `git add -A` cannot commit it; removed with the agent.
pub(crate) const WS_AGENTS_DIR: &str = ".kiro/agents";
const GIT_EXCLUDE_MARK: &str = "# tmux-mobile managed kiro entries (board #207)";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn workspace_entry_path(workspace: &Path, name: &str) -> std::path::PathBuf {
    workspace.join(WS_AGENTS_DIR).join(format!("{name}.json"))
}

/// Ensure (engine v3) or retire (engine v2) the workspace entry. Returns true
/// when the workspace changed; an error names the file that stands in the way.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn ensure_workspace_entry(workspace: &Path, home: &Path, name: &str) -> Result<bool, String> {
    let open = crate::config::kiro_engine() == "v3";
    let link = workspace_entry_path(workspace, name);
    let target = home.join("agents").join(format!("{name}.json"));
    let meta = std::fs::symlink_metadata(&link).ok();
    if !open {
        // Door closed: our link goes; anything else there is not ours.
        return Ok(meta.is_some_and(|m| m.file_type().is_symlink()
            && std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()))
            && std::fs::remove_file(&link).is_ok());
    }
    if let Some(m) = meta {
        if m.file_type().is_symlink() {
            if std::fs::read_link(&link).ok().as_deref() == Some(target.as_path()) {
                return Ok(false); // already ours, pointing right
            }
            std::fs::remove_file(&link).map_err(|e| format!("replace stale link {}: {e}", link.display()))?;
        } else {
            return Err(format!(
                "{} exists and is not a tmux-mobile link — the v3 engine would read it as '{name}'; move it aside or rename the agent",
                link.display()
            ));
        }
    }
    std::fs::create_dir_all(link.parent().unwrap()).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink(&target, &link).map_err(|e| format!("link {}: {e}", link.display()))?;
    exclude_from_git(workspace, name);
    Ok(true)
}

/// Remove the entry an agent left in the workspace (agent removal). Only a
/// symlink into `.tmm/agents/` is ours to remove.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn remove_workspace_entry(workspace: &Path, name: &str) -> bool {
    let link = workspace_entry_path(workspace, name);
    let ours = std::fs::symlink_metadata(&link).is_ok_and(|m| m.file_type().is_symlink())
        && std::fs::read_link(&link).is_ok_and(|t| t.to_string_lossy().contains("/.tmm/agents/"));
    ours && std::fs::remove_file(&link).is_ok()
}

/// `.git/info/exclude` — local, untracked, idempotent: the workspace's own
/// `.gitignore` is the project's, not ours to edit. ONE line per agent, our
/// file only: hiding the whole `.kiro/agents/` would hide the agents the user
/// wrote there from their own `git status`.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn exclude_from_git(workspace: &Path, name: &str) {
    let git = workspace.join(".git");
    if !git.is_dir() {
        return;
    }
    let path = git.join("info").join("exclude");
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let line = format!("/{WS_AGENTS_DIR}/{name}.json");
    if current.lines().any(|l| l.trim() == line) {
        return;
    }
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    let mark = if current.contains(GIT_EXCLUDE_MARK) { String::new() } else { format!("{GIT_EXCLUDE_MARK}\n") };
    let _ = std::fs::write(&path, format!("{current}{sep}{mark}{line}\n"));
}

/// kiro-cli's composer opens its `@` FILE PICKER for any `@` anywhere before
/// the cursor, and an Enter while the picker has results SELECTS a file
/// instead of submitting (board #436, kiro-cli 2.32.0 `--agent-engine v3`;
/// the same picker bit on 2.18.1, board #10 in kirocrew). Read from 2.32.0's
/// tui.js: the triggers are hard-coded (`[{key:"/",type:"start"},{key:"@",
/// type:"inline"}]`), an inline trigger is `lastIndexOf("@")` in the text
/// before the cursor, Enter goes to the picker when `activeTrigger.key ===
/// "@" && filePickerHasResults`, and that flag is set by an async file
/// search; no `chat.*` setting turns it off. Measured: the picker's footer
/// first painted 170-205 ms after the typing in a one-file workspace and
/// 239-316 ms in one shaped like lingting (559 files), so a screen check at
/// the 200 ms beat raced it. The owner's case: `[wake] @engineer …` became
/// the chip `m3-g2-engineering-appendix.md 114 lines`, never submitted.
///
/// So a delivery never types `@` into kiro: `delivery::type_text` types
/// `address::unaddressed(text)` (every `@` as `＠`), which nothing in the CLI
/// treats as a trigger. The room, the feed and the delivery rows keep `@`;
/// the receipt reads `＠` as `@` (`telemetry::canon_char`). A `/command` is
/// typed verbatim (`hub_command`), so it does not pass through here.
pub(crate) const AT_OPENS_FILE_PICKER: bool = true;

/// Is kiro-cli's `@` file picker on this screen? Recognised by its own
/// footer, BOTH halves: `esc to cancel · ↵ to select` (2.18.1, and 2.32.0
/// `--agent-engine v3`, captured on the #436 rig). A running turn paints
/// `(esc to cancel)` alone with nothing to select, and Escape there would
/// cancel the turn.
///
/// Used ONLY for a verbatim `/command` (`delivery::send_into`, validator P1
/// on #436): a delivery never types `@` (`AT_OPENS_FILE_PICKER`), but a
/// command is the person's own text and keeps its `@`, so before its Enter
/// the screen is read once and Escape closes an open picker (it reaches only
/// the picker and leaves the line intact: measured on 2.18.1 over a running
/// turn, and on 2.32.0 on the #436 rig). Its limit, measured on #436: the
/// picker opens after an async file search, 170-316 ms after the typing, so
/// one read at the 200 ms beat can come before it; main's guard submitted 5/5
/// such commands on the validator's rig, and without it 1/5.
pub(crate) fn picker_open(screen: &str) -> bool {
    screen.lines().any(|l| l.contains("esc to cancel") && l.contains("to select"))
}

/// What a kiro agent is told about the `＠` it reads (board #436): the one
/// cost of `AT_OPENS_FILE_PICKER`, said where it is paid. Appended to the
/// collaboration flow's bullets in the agent's own config.
pub(crate) const AT_TYPED_NOTE: &str = "- A `＠` in a message delivered to you stands for `@`: it is typed that way so kiro-cli's file picker does not open. Restore `@` when you quote code, and write `@name` yourself when you address someone.";

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn render_kiro(
    def: &RegAgent, name: &str, home: &Path, workspace: &Path, system_prompt: &str,
    skills: &[crate::projects::skills::ResolvedSkill],
) -> Result<Rendered, String> {
    std::fs::create_dir_all(home.join("agents")).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(home.join("settings")).map_err(|e| e.to_string())?;
    // Fail-loud at spawn (a home without settings/cli.json would re-enable the
    // trust-all confirmation, which nobody is there to answer); refresh_hooks
    // reuses the same canonical list fail-soft via ensure_kiro_settings.
    let mut settings: serde_json::Map<String, Value> =
        kiro_cli_settings().into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    settings.insert(INTERRUPT_KEY.into(), json!(if def.input_mode == "steer" { "steer" } else { "queue" }));
    if !def.model.trim().is_empty() {
        settings.insert(DEFAULT_MODEL_KEY.into(), json!(def.model.trim()));
    }
    shared::write_atomic(
        &home.join("settings").join("cli.json"),
        &serde_json::to_string_pretty(&Value::Object(settings)).unwrap(),
    )?;

    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    notifications.ensure_helper()?;
    let notify = notifications.helper_command("kiro");

    let resources: Vec<String> = skills
        .iter()
        .map(|sk| format!("skill://{}/SKILL.md", sk.dir.to_string_lossy()))
        .collect();
    let mut mcp_servers = json!({});
    for m in &crate::projects::spawn::mcp_defs(def) {
        if !m.name.is_empty() {
            mcp_servers.as_object_mut().unwrap().insert(m.name.clone(), shared::kiro_mcp_value(m));
        }
    }
    let mut conf = json!({
        "name": name,
        "description": format!("{} (registry agent)", def.name),
        "prompt": format!("{system_prompt}\n{AT_TYPED_NOTE}"),
        "tools": ["*"],
        "allowedTools": ["*"],
        "resources": resources,
        // Native MCP again (owner, 2026-08-28: "mcp 工具还是用原生的方式调用
        // 吧") — the context cost is handled by toolSearch instead
        // (kiro_cli_settings enables it): schemas are DEFERRED into a compact
        // list and loaded on demand via kiro's own tool_search. The `tmm mcp`
        // CLI stays available as a SKILL, never taught in the prompt.
        "mcpServers": mcp_servers,
        "hooks": kiro_hooks(&notify),
        "permissions": kiro_permissions(),
    });
    // The model belongs to the agent's IDENTITY, not to one launch of it. It
    // used to ride on `--model`, which had two costs: it was invisible in the
    // config the owner reads (`.tmm/agents/<name>/agents/<name>.json`), and
    // kiro-cli's TUI answers an unknown id with a warning above the splash and
    // then runs its DEFAULT model — so a typo'd id was a silent downgrade. In
    // the config, kiro reports it as a real error on the first turn instead,
    // and every later start (resume, restart, `up`) reads the same field.
    // `registry_save` rejects unknown ids up front.
    //
    // An empty model means what the editor's placeholder says — the BACKEND's
    // default — so the key is omitted rather than set to a hardcoded id (the
    // old launch line pinned `claude-sonnet-4.6`, which silently contradicted
    // the UI and would have outlived that model).
    let model = def.model.trim();
    if !model.is_empty() {
        conf["model"] = json!(model);
    }
    shared::write_atomic(&home.join("agents").join(format!("{name}.json")), &serde_json::to_string_pretty(&conf).unwrap())?;
    // v3 finds the identity through the workspace (fail loud: a foreign file
    // there would be read as this agent).
    ensure_workspace_entry(workspace, home, name)?;

    Ok(Rendered {
        env: kiro_launch_env(home),
        cmd: format!(
            "command kiro-cli chat --agent {} --trust-all-tools{}{}",
            crate::shell::quote(name),
            effort_flag(def),
            engine_flag(),
        ),
        confirmation: None,
    })
}


/// The kiro half of `refresh_hooks` (board #128): hooks, launch-model
/// migration, canonical settings, and the pre-recipe backfill — a home whose
/// `agents/<name>.json` exists but whose recipe does not is an old spawn
/// whose restart identity is reconstructible from the isolated home itself.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn refresh(home: &Path, window_name: &str, workspace: &Path, notify: &str) -> Result<bool, String> {
    let mut changed = false;
    let config = home.join("agents").join(format!("{window_name}.json"));
    if config.is_file() {
        // The workspace entry follows the engine door at every start (#207);
        // refresh is fail-soft, so a foreign file only logs.
        match ensure_workspace_entry(workspace, home, window_name) {
            Ok(c) => changed |= c,
            Err(e) => eprintln!("projects: kiro v3 workspace entry for '{window_name}': {e}"),
        }
        changed |= patch_profile(&config, kiro_hooks(notify))?;
        changed |= migrate_launch_model(home, &config)?;
        // Settings drift is config drift: agents spawned before queue-mode
        // (or before settings existed at all) get the canonical file on their
        // next start, same as hooks; the v3 model mirror follows the profile.
        changed |= ensure_kiro_settings(home, &profile_model(&config))?;
        // The engine door is read at every start (board #207).
        changed |= reconcile_recipe_engine(home)?;
        // The pre-recipe backfill, decided INSIDE the home's recipe section
        // (board #384): "no recipe yet" is read and acted on in one step, so
        // a spawn writing one meanwhile is never overwritten.
        let section = crate::projects::recipe::recipe_section(home);
        if matches!(section.read(), Ok(None)) {
            // A backfill is a private write too: its failure refuses the
            // start (board #448 P1-B), it is never taken for "no change".
            crate::projects::spawn::LaunchRecipe {
                backend: "kiro",
                env: &kiro_launch_env(home),
                cmd: &format!(
                    "command kiro-cli chat --agent {} --trust-all-tools{} kick",
                    crate::shell::quote(window_name),
                    engine_flag(),
                ),
                // A backfilled recipe cannot know who spawned the agent — the
                // provenance does not exist for pre-recipe spawns; refresh
                // falls back to the window name.
                spawned_by: "",
                team: None,
                agent_def: "",
                member: "",
                from_member: "",
                input_mode: "",
            }
            .write_in(&section)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// kiro resume dialect, per engine (the engine is read off the launch line —
/// `reconcile_recipe_engine` has already brought it in line with the door).
///
/// v2: `--resume-id <id>` exact, `--resume` recent (the isolated KIRO_HOME
/// scopes the store to this one agent, so "recent" is safe).
///
/// v3 (board #213, corrected by #379): an exact `sess_<uuid>` id resumes ONLY
/// when this agent's own isolated home holds that session AND it belongs to
/// this agent (`v3_session_resumable`); anything else starts fresh.
///
/// The incident behind the second condition (owner, 2026-10-15, learn-english
/// and laminar-log): with `KIRO_HOME` set, kiro-cli reads sessions ONLY from
/// that home, but the ids a slot had recorded were minted when sessions lived
/// in the global `~/.kiro/sessions`. Handed one it could not find, kiro-cli
/// v3 does not fail — `ACP session/load … messages=0` silently CREATES an
/// empty session under that id with `agentMode: "vibe"` (the Default agent),
/// IGNORING `--agent`. The footer then reads `Default · auto`, and the Default
/// agent carries none of our hooks (they live in `agents/<name>.json`): no
/// prompt, tool or stop row is ever written, so no reply reaches the room, no
/// reply edge forms and the status freezes. Every later restart resumed that
/// same vibe session again, so the agent stayed broken for good. Fresh spawns
/// have no resume id, which is why solo agents worked and restarted team
/// members did not. A fresh agent with its hooks beats a resumed one without.
///
/// Never `--resume` (recent) under v3: it takes the newest session of the
/// DIRECTORY, which may be the vibe one, a teammate's or the human's. And a v2
/// id is never handed to v3 (#213: it loaded a rootless "Default · Auto"
/// session) — the rule is symmetric, an id goes only to the engine that minted
/// it; v2 given a v3 id (the rollback case) falls back to `--resume`, which is
/// the pre-switch v2 thread of this home.
///
/// `agent` is the managed window's own name and `home` its isolated home
/// (`<ws>/.tmm/agents/<agent>`): the identity the caller already holds. It is
/// NOT read back out of the launch line. `render_kiro` writes `--agent` through
/// `shell::quote`, which wraps any valid non-ASCII name (`翻译` → `'翻译'`), so
/// the raw token never equals the `agentMode` kiro stored — every restart of
/// such an agent compared a quoted string with a plain one and started fresh,
/// losing a perfectly good conversation (board #379 review P1). The name is the
/// slot's final WINDOW name, the one `--agent` was rendered from — `builder-2`,
/// not the registry def's `builder`. Without a home or a name there is nothing
/// to vouch for the id, so it starts fresh.
pub(crate) fn resume_command(cmd: &str, id: Option<&str>, home: Option<&std::path::Path>, agent: &str) -> String {
    let v3_id = id.is_some_and(|i| i.starts_with(V3_SESSION_PREFIX));
    if launch_engine_is_v3(cmd) {
        let resumable = match (id, home) {
            (Some(id), Some(home)) if v3_id => v3_session_resumable(home, agent, id),
            _ => false,
        };
        return match id {
            Some(id) if resumable => format!("{cmd} --resume-id {}", crate::shell::quote(id)),
            _ => cmd.to_string(),
        };
    }
    match id {
        Some(id) if !v3_id => exact_line(cmd, id),
        _ => format!("{cmd} --resume"),
    }
}

/// The exact-resume line, shared by `resume_command` and `resume_exact`.
fn exact_line(cmd: &str, id: &str) -> String {
    format!("{cmd} --resume-id {}", crate::shell::quote(id))
}

/// The strict form for a restore after a reboot (board #422): `Some` only
/// when kiro's OWN store in this agent's isolated home holds that
/// conversation for this agent — v3: `v3_session_resumable`; v2: its
/// `sessions/cli/<id>.json` naming the id and the agent. Anything else is
/// `None`, never `--resume` (recent) or a blank start. `resume_command` keeps
/// its looser manual behaviour unchanged.
pub(crate) fn resume_exact(cmd: &str, id: &str, home: Option<&std::path::Path>, agent: &str) -> Option<String> {
    let home = home?;
    if cmd.trim().is_empty() || !super::shared::exact_id_ok(id) {
        return None;
    }
    let v3_id = id.starts_with(V3_SESSION_PREFIX);
    let held = if launch_engine_is_v3(cmd) { v3_id && v3_session_resumable(home, agent, id) } else { !v3_id && v2_session_held(home, agent, id) };
    held.then(|| exact_line(cmd, id))
}

/// Whether the v2 engine's store in `home` holds conversation `id` for
/// `agent`: `<home>/sessions/cli/<id>.json` with `session_id == id` and
/// `session_state.agent_name == agent` (layout read off a live v2 managed
/// home, kiro-cli 2.31.0, 2026-10-18). Anything short of that is `false`.
pub(crate) fn v2_session_held(home: &std::path::Path, agent: &str, id: &str) -> bool {
    if agent.is_empty() || !valid_session_id(id) {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(home.join("sessions").join("cli").join(format!("{id}.json"))) else { return false };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return false };
    v.get("session_id").and_then(Value::as_str) == Some(id)
        && v.get("session_state").and_then(|s| s.get("agent_name")).and_then(Value::as_str) == Some(agent)
}

/// Whether `<home>/sessions/<cwd-hash>/<id>/session.json` exists and says the
/// session belongs to `agent` (`agentMode`). Anything short of a positive
/// answer is `false` — a missing session, an unreadable store or file,
/// malformed JSON, a session of another mode. The last is the incident above:
/// `agentMode: "vibe"` is a session kiro-cli made up when it could not find
/// the real one, and resuming it is what loses the hooks.
///
/// Read from the layout of a live managed agent's session.json (kiro-cli
/// 2.31.0 installed on this host; the incident was measured on 2.28): `{id,
/// agentMode, createdAt, …}` under `<home>/sessions/<cwd-hash>/<id>/`.
pub(crate) fn v3_session_resumable(home: &std::path::Path, agent: &str, id: &str) -> bool {
    if agent.is_empty() || !valid_session_id(id) {
        return false;
    }
    let Ok(buckets) = std::fs::read_dir(home.join("sessions")) else { return false };
    for bucket in buckets {
        let Ok(bucket) = bucket else { return false };
        match std::fs::read_to_string(bucket.path().join(id).join("session.json")) {
            Ok(text) => {
                return serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v.get("agentMode").and_then(Value::as_str).map(|m| m == agent))
                    .unwrap_or(false);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            // A file we cannot read is not a session we can vouch for.
            Err(_) => return false,
        }
    }
    false
}

/// v3 session ids as the hook and the global store spell them.
const V3_SESSION_PREFIX: &str = "sess_";

/// Whether a recorded launch line runs the v3 engine (`--agent-engine v3` or
/// the CLI's `--v3` alias).
pub(crate) fn launch_engine_is_v3(cmd: &str) -> bool {
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    tokens.iter().any(|t| *t == "--v3")
        || tokens.windows(2).any(|w| w[0] == "--agent-engine" && w[1] == "v3")
}

/// This backend's detection/relaunch row (board #129). Resume flags from
/// `kiro-cli chat --help`: `-r/--resume` — "Resume the most recent
/// conversation from this directory"; `--resume-id <SESSION_ID>` exact.
/// The recipe-based resume dialect lives in `resume_command` above — same
/// knowledge, the template form serves adopted/hand-started windows.
/// What this CLI's prompt hook reports after the slash command `name` (with
/// `args`, may be empty) — measured 2026-09-28 (board #264) on kiro-cli 2.22.1
/// v3: `/goal <args>` is echoed WITHOUT its slash, `goal <args>`. Declared per
/// command, only where a prompt hook was measured: `/effort` and the other
/// settings commands fire none, so they get no receipt row (validator, #264).
pub(crate) fn command_echo(name: &str, args: &str) -> Option<String> {
    (name == "/goal" && !args.is_empty()).then(|| format!("goal {args}"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn known() -> crate::projects::agents::KnownAgent {
    crate::projects::agents::KnownAgent {
        backend: "kiro",
        programs: &["kiro-cli", "kiro-cli-chat"],
        launch: "kiro-cli chat",
        resume_recent: Some("kiro-cli chat --resume"),
        resume_id: Some("kiro-cli chat --resume-id {id}"),
        versioned_binary_dir: None,
    }
}

/// kiro's hook payload dialect (board #129): snake_case `hook_event_name`,
/// a turn's end is `stop`/`Stop`.
pub(crate) fn normalize_kind(
    payload: &serde_json::Map<String, Value>,
) -> Result<&'static str, String> {
    let event = crate::agent_notifications::string_field(payload, &["hook_event_name"]);
    if !matches!(event.as_deref(), Some("stop" | "Stop")) {
        return Err("unsupported Kiro event".into());
    }
    Ok("completed")
}

/// kiro marks a new user turn with `hook_event_name: userPromptSubmit`
/// (case-insensitive) — resets the auto-post dedup flag.
/// kiro-cli v3 (KAS) runs its memory auto-capture as `memory` TOOL calls AFTER
/// the turn's Stop — measured 2026-09-20 in state.db on two agents
/// (kiro-v3-roll:kiro 03:58, kirocrew-ppt:aws-expert 10:42): prompt → tools →
/// `completed` → three `memory` calls 10–30 s apart with no new prompt. Read
/// as work, the newest tool reopened the turn and the card said "working"
/// until the next message (board #227; the owner: "结束了还一直显示在工作").
/// The agent also calls `memory` INSIDE a turn (`memory list/add`), so the
/// name alone is not the verdict — the consumer records it only while a turn
/// is open. This names the tool whose calls are the harness's housekeeping.
pub(crate) fn is_housekeeping_tool(payload: &Value) -> bool {
    payload
        .get("tool_name")
        .or_else(|| payload.get("toolName"))
        .and_then(Value::as_str)
        .is_some_and(|t| t == "memory")
}

pub(crate) fn is_user_prompt_submit(payload: &Value) -> bool {
    payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .is_some_and(|e| e.eq_ignore_ascii_case("userpromptsubmit"))
}

// ---- transient model errors: the auto-continue shapes (projects/recovery.rs, board #280) ----

/// The error's own header, canonicalized. Everything kiro streams out of a
/// dead turn starts with this sentence — and since ~2026-08-31 (board #24)
/// kiro HARD-wraps the paint: header flush-left, the struct dump indented on
/// real newlines that capture -J cannot rejoin, so the transient markers sit
/// many physical lines below the header. Detection therefore matches the
/// reassembled paint BLOCK, and the header must OPEN it (`starts_with`, not
/// `contains`) — quoted copies always paint under a stamp or bullet head.
const HEADER: &str = "anunexpectederroroccurred";
/// Transient markers — the reasons that mean "try again later", canonicalized.
pub(crate) const TRANSIENT: [&str; 3] = [
    "unexpectedlyhighload",
    "modeltemporarilyunavailable",
    "pleasetryagain",
];
/// Second kiro shape (owner, 2026-08-26): `The model you've selected is
/// temporarily unavailable. Please use '/model' to select a different model
/// and try again. (request_id: …)`. No "unexpected error" header — the whole
/// first sentence IS the header, and it is specific enough on its own: it
/// self-contains the transient reason ("temporarily unavailable"), so a block
/// opening with it needs no second marker.
const MODEL_UNAVAILABLE: &str = "themodelyouveselectedistemporarilyunavailable";
/// Third kiro shape (kiro-cli 2.22.1, `--agent-engine v3`, board #267,
/// 2026-09-28): `● <model> is experiencing high traffic. Try again, or select
/// another model. (Request ID: <uuid>)`, hard-wrapped under the bullet head
/// that v3 also gives its prose and tool calls — `●` on 2.22.1, `•` on 2.28.0
/// (`HEAD_GLYPHS`, #361). It has no header of its own, so the block must be
/// EXACTLY the error, punctuation included, with only whitespace collapsed (a
/// hard wrap is a space): the bullet, a short model name, this sentence, a
/// canonical 8-4-4-4-12 uuid and the closing `)` at block end. Letters alone
/// are not enough (validator 15:04): a rewording without the parenthesis, the
/// colon or the close paren is prose ABOUT the error, and a false hit types
/// `continue` into a working agent.
const HIGH_TRAFFIC: &str = " is experiencing high traffic. Try again, or select another model. (Request ID: ";
/// "Claude Opus 4.1 (1M context)" is five.
const MODEL_NAME_WORDS: usize = 5;
/// Fourth kiro shape (kiro-cli 2.28.0, `--agent-engine v3`, #370, measured
/// 2026-10-14 in four real blocks across three panes): the rate limit —
/// `• Too many requests, please wait before trying again. (Request ID:
/// <uuid>)`, hard-wrapped under the same bullet head as the high-traffic error
/// (`HEAD_GLYPHS`). It names no model, so the block is EXACTLY this sentence:
/// a head glyph, the words below, a canonical 8-4-4-4-12 uuid and the closing
/// `)` at block end, with only whitespace collapsed (a hard wrap is a space).
/// The same strictness as `HIGH_TRAFFIC` and for the same reason: letters
/// alone are prose ABOUT the error, and a false hit types `continue` into a
/// working agent. A 429 means "slow down": it rides the same ladder as every
/// other shape (the first `continue` at once, an UNCONFIRMED one retried after
/// `BASE_BACKOFF_SECS` and doubling); it does not get a shorter one. The
/// ladder bounds one Request ID only: a fresh id is a fresh incident.
const TOO_MANY_REQUESTS: &str = "Too many requests, please wait before trying again. (Request ID: ";

use super::is_uuid;

/// Is this block, its lines joined with spaces, exactly the rate-limit error?
fn too_many_requests(spaced: &str) -> bool {
    let flat = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.strip_prefix(|c: char| HEAD_GLYPHS.contains(&c))
        .and_then(|rest| rest.strip_prefix(' '))
        .and_then(|body| body.strip_prefix(TOO_MANY_REQUESTS))
        .and_then(|rest| rest.strip_suffix(')'))
        .is_some_and(is_uuid)
}

/// Is this block, its lines joined with spaces, exactly the high-traffic error?
fn high_traffic(spaced: &str) -> bool {
    let flat = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(body) = flat
        .strip_prefix(|c: char| HEAD_GLYPHS.contains(&c))
        .and_then(|rest| rest.strip_prefix(' '))
    else {
        return false;
    };
    let Some(at) = body.find(HIGH_TRAFFIC) else { return false };
    let name = &body[..at];
    let words = name.split(' ').count();
    if name.is_empty()
        || words > MODEL_NAME_WORDS
        || !name.chars().all(|c| c.is_ascii_alphanumeric() || " .-()".contains(c))
    {
        return false;
    }
    body[at + HIGH_TRAFFIC.len()..].strip_suffix(')').is_some_and(is_uuid)
}


/// Which of kiro's OWN transient-error shapes this reassembled paint block is
/// (board #280: each backend owns its shapes; #362: by name), or `None`.
/// `glued` is the block with its lines joined without separators, `spaced`
/// with spaces.
pub(crate) fn transient_shape(glued: &str, spaced: &str) -> Option<&'static str> {
    let c = super::canonical(glued);
    if c.starts_with(HEADER) && TRANSIENT.iter().any(|m| c.contains(m)) {
        Some("stream_error")
    } else if c.starts_with(MODEL_UNAVAILABLE) {
        Some("model_unavailable")
    } else if high_traffic(spaced) {
        Some("high_traffic")
    } else if too_many_requests(spaced) {
        Some("too_many_requests")
    } else {
        None
    }
}

/// The CLI version each shape above was MEASURED on (board #362): the newest
/// kiro-cli a real paint of it was captured on. `stream_error` and
/// `model_unavailable` were captured 2026-08-22 and 08-26, before a version
/// was written down; the first kiro-cli on record on this host is 2.18.1
/// (2026-09-03), so both are an upper bound, and neither has been seen since.
/// `high_traffic` was captured on 2.22.1 (`●`, #267) and 2.28.0 (`•`, #361),
/// `too_many_requests` on 2.28.0 (#370). `conversation_blocked` (a person's
/// error, `person_paint`) on 2.28.0 (#362, video-factory:checker 10-13).
/// Raise a version only with a new capture as its fixture
/// (`recovery::tests::FIXTURES`).
pub(crate) const RECOVERY_SHAPES: &[super::Measured] = &[
    super::Measured { shape: "stream_error", version: "2.18.1", at_most: true },
    super::Measured { shape: "model_unavailable", version: "2.18.1", at_most: true },
    super::Measured { shape: "high_traffic", version: "2.28.0", at_most: false },
    super::Measured { shape: "too_many_requests", version: "2.28.0", at_most: false },
    super::Measured { shape: "conversation_blocked", version: "2.28.0", at_most: false },
];

/// A kiro error no `continue` can fix (board #362 c): the conversation holds
/// an image Bedrock refuses, so EVERY later turn, and `/compact`, fails the
/// same way in seconds (builder, 10-15 11:55 -> 14:13: a 3860-px screenshot
/// read into the conversation). Only a person clearing the conversation
/// (after saving its state) ends it. Measured on kiro-cli 2.28.0, at 59
/// columns: `• At least one of the image dimensions exceed max allowed` /
/// `  size for many-image requests: 2000 pixels (Request ID:` / `  <uuid>)`.
/// The limit is 2000 px when a request carries many images and 3000 px
/// otherwise (kiro's own log, /tmp/kiro-log/kiro-tui.log, has both), so the
/// number is read as digits, not matched. As strict as `TOO_MANY_REQUESTS`
/// and for the same reason: letters alone are prose ABOUT the error.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const IMAGE_TOO_LARGE: &str = "At least one of the image dimensions exceed max allowed size for many-image requests: ";

/// Is this block, its lines joined with spaces, exactly the image-size error?
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn image_too_large(spaced: &str) -> bool {
    let flat = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let Some(rest) = flat
        .strip_prefix(|c: char| HEAD_GLYPHS.contains(&c))
        .and_then(|rest| rest.strip_prefix(' '))
        .and_then(|body| body.strip_prefix(IMAGE_TOO_LARGE))
    else {
        return false;
    };
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    digits > 0
        && rest[digits..]
            .strip_prefix(" pixels (Request ID: ")
            .and_then(|r| r.strip_suffix(')'))
            .is_some_and(is_uuid)
}

/// kiro's composer with nothing typed and no turn running (kiro-cli 2.28.0,
/// measured on video-factory:checker and builder: `›  ask a question or
/// describe a task ↵`, at column zero).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const IDLE_COMPOSER: &str = "›  ask a question or describe a task";

/// The NEWEST block on a kiro screen, by kiro's own measured grammar, as
/// `(glued, spaced)`: its lines trimmed and joined without a separator, and
/// with spaces (board #362 c). One reading for the person-needed paints
/// (`person_paint`) and for a capped recovery incident (`recovery`,
/// orchestrator's ruling on the builder's 02:30 finding: an error that is
/// not the newest paint is about an older turn).
///
/// Newest means the turn ended with it, and that is read by kiro's own
/// measured screen grammar, not by "the last bullet" (review P1-B on
/// 6111d25b: an image error, then a newly submitted prompt, then the idle
/// composer was still read as the newest). Bottom up: the LAST column-zero
/// `›` line must be the IDLE composer (`IDLE_COMPOSER`; a typed composer, a
/// `›  Kiro is working …` footer or no composer at all, a half-drawn screen,
/// is not); the block is the last column-zero `HEAD_GLYPHS` block above it;
/// and everything between them is kiro's idle furniture and nothing else
/// (`idle_furniture`): a submitted prompt (kiro paints it indented, `  ›`
/// or `  [tmm chat …]`), a tool call, prose, the older ` Kiro is working`
/// footer or a third rule means a newer turn has painted, and the block is
/// history. When in doubt, nothing: a missed stall costs a person one look,
/// a false one ends a working turn.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn newest_block(pane: &str) -> Option<(String, String)> {
    let lines: Vec<&str> = pane.lines().map(str::trim_end).collect();
    let composer = lines.iter().rposition(|l| l.starts_with('›'))?;
    if !lines[composer].starts_with(IDLE_COMPOSER) {
        return None;
    }
    let head = lines[..composer].iter().rposition(|l| l.starts_with(HEAD_GLYPHS))?;
    let end = head + 1 + lines[head + 1..composer].iter().take_while(|l| l.starts_with(' ') && !l.trim().is_empty()).count();
    if !idle_furniture(&lines[end..composer])
        || !lines[composer + 1..].iter().all(|l| l.trim().is_empty() || (l.starts_with(' ') && !l.contains("[tmm ")))
    {
        return None;
    }
    let block = &lines[head..end];
    Some((block.iter().map(|l| l.trim()).collect(), block.iter().map(|l| l.trim()).collect::<Vec<_>>().join(" ")))
}

/// The NEWEST paint on a kiro screen (`newest_block`), when it is one of
/// kiro's errors that needs a person (board #362 c): `(shape, block)`, the
/// block de-wrapped.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn person_paint(pane: &str) -> Option<(&'static str, String)> {
    let (glued, spaced) = newest_block(pane)?;
    image_too_large(&spaced).then_some(("conversation_blocked", glued))
}

/// kiro's Trust banner, whitespace collapsed: one line on a wide pane, two
/// or three when it wraps (all three measured on kiro-cli 2.28.0 and 2.22.1;
/// managed agents always run with `--trust-all-tools`).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
const TRUST_BANNER: &str = "Trust All Tools active, confirmations are off · /quit to exit";

/// What kiro paints between its newest block and the idle composer once a
/// turn has ended, top to bottom, read by its measured TEXT (kiro-cli 2.28.0
/// on video-factory:checker and builder; 2.22.1 adds the tasks line,
/// lingting:kiro): the turn's `▸ Credits … | Time …` (or `▸ Time …`) line
/// and ` ◐ N tasks remaining · ctrl+x expand`; a rule; the one-space Trust
/// banner, exactly `TRUST_BANNER` however it wraps; a rule; then one to
/// three column-zero status lines, the first with kiro's ` · ` segments
/// (`<agent> · <model> · …`), the rest its wrap or the cwd. Blank lines
/// anywhere. Anything else (a two-space-indented line such as a submitted
/// prompt or tool output, the older ` Kiro is working` footer, a third rule,
/// a status line with no segments) is not furniture.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn idle_furniture(region: &[&str]) -> bool {
    let mut rules = 0;
    let mut banner = String::new();
    let mut status: Vec<&str> = Vec::new();
    let one_space = |l: &str| l.starts_with(' ') && !l.starts_with("  ");
    for line in region {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.chars().all(|c| c == '─') {
            rules += 1;
            if rules > 2 {
                return false;
            }
            continue;
        }
        let fits = match rules {
            0 => line.starts_with("▸ ") || (one_space(line) && t.contains(" tasks remaining")),
            // The banner is checked by its whole text below, which no other
            // line between the rules can pass.
            1 => {
                banner.push(' ');
                banner.push_str(t);
                true
            }
            _ => {
                status.push(line);
                !line.starts_with(' ')
            }
        };
        if !fits {
            return false;
        }
    }
    rules == 2
        && banner.split_whitespace().collect::<Vec<_>>().join(" ") == TRUST_BANNER
        && (1..=3).contains(&status.len())
        && status[0].contains(" · ")
}

/// The program whose `--version` names the kiro-cli a pane runs.
pub(crate) const VERSION_PROGRAM: &str = "kiro-cli";

#[cfg(test)]
mod tests {
    /// kiro-cli screens as captured live: 2.18.1 (2026-09-03, board #10 in
    /// kirocrew) and 2.32.0 `--agent-engine v3` (the #436 rig,
    /// `capture-pane -p -J -S -8` 200 ms after the paste). The picker is
    /// recognised by its own footer, never by a running turn's "esc to
    /// cancel".
    #[test]
    fn the_picker_is_recognised_by_its_footer_only() {
        let v2_18 = "[tmm chat] human: @kiro [board #10] hello there\n\
                     @runtime/kirocrew-artifact.json\n\
                     ────────────────\n\
                      esc to cancel · ↵ to select\n";
        assert!(super::picker_open(v2_18));
        let v2_32 = "  post the result. \n\
                     @docs/m3-g2-engineering-appendix.md\n\
                     ──────────────────────────────────────────────────────────────\n \
                     esc to cancel · ↵ to select\n";
        assert!(super::picker_open(v2_32));
        let streaming = "⠹ Thinking... (esc to cancel)\n\
                         ● 8 MCP failures — see /mcp\n\
                          Kiro is working · Type to steer · Ctrl+S to queue\n";
        assert!(!super::picker_open(streaming), "a running turn is not a picker");
        assert!(!super::picker_open("[tmm chat] human: @zzqx hello there\n"), "no match, no picker");
        assert!(!super::picker_open(""));
    }
    use super::*;

    /// Board #362 c, the SENTENCE alone (review P1-B: kept apart from the
    /// whole-screen evidence, `recovery::tests`): the image refusal is exactly
    /// kiro's sentence under a measured head glyph, the pixel limit as digits
    /// (2000 in the real paint, 3000 in kiro's own log), a Request ID uuid and
    /// the closing paren; a hard wrap is a space. A rewording, no id, a word
    /// for the number, prose around it or a quote stamp is not it.
    #[test]
    fn the_image_refusal_is_exactly_kiros_sentence() {
        let s = "At least one of the image dimensions exceed max allowed size for many-image requests";
        assert!(image_too_large(&format!("• {s}: 2000 pixels (Request ID: 1336b8d6-2439-48cc-baa1-958338597643)")));
        assert!(image_too_large(&format!("• {s}: 3000 pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433)")));
        assert!(image_too_large(&format!("● {s}:\n  3000 pixels (Request ID:\n  3c60ad4b-3654-47c8-aeb0-146c2a910433)")), "the 2.22.1 glyph, wrapped");
        for bad in [
            format!("• {s}: 3000 pixels."),
            format!("• {s}: many pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433)"),
            format!("• {s}: 3000 pixels (Request ID: not-a-uuid)"),
            format!("• {s}: 3000 pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433) and more"),
            format!("• I saw: {s}: 3000 pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433)"),
            format!("› [tmm chat 2026-10-15 14:15] orchestrator: {s}: 3000 pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433)"),
            format!("{s}: 3000 pixels (Request ID: 3c60ad4b-3654-47c8-aeb0-146c2a910433)"),
        ] {
            assert!(!image_too_large(&bad), "{bad}");
        }
    }

    /// Board #384 (reviewer P1-C): kiro's two recipe migrations go through
    /// the recipe's one door, the read INSIDE the home's section. Each starts
    /// while a team move holds the section; the move lands; the migration's
    /// own change lands after it, and the move survives (a migration that read
    /// the recipe before the section would write the old team back).
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn a_recipe_migration_waits_for_a_team_move_and_keeps_it() {
        use crate::projects::recipe::{recipe_section, update_in};
        let home = std::env::temp_dir().join(format!("tmm-kiro-mig-{}", uuid::Uuid::new_v4())).join(".tmm/agents/dev");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        let cfg = home.join("agents").join("dev.json");
        std::fs::write(&cfg, r#"{"name":"dev","prompt":"p","hooks":{}}"#).unwrap();
        let read = || -> Value { serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap() };
        let race = |cmd: &str, migrate: fn(&Path, &Path) -> bool| {
            std::fs::write(home.join("launch.json"), json!({ "backend": "kiro", "cmd": cmd, "team": "" }).to_string()).unwrap();
            let held = recipe_section(&home);
            let worker = { let (h, c) = (home.clone(), cfg.clone()); std::thread::spawn(move || migrate(&h, &c)) };
            std::thread::sleep(std::time::Duration::from_millis(150));
            assert!(!worker.is_finished(), "the migration waits for the section");
            update_in(&held, |r| r.as_mut().unwrap()["team"] = json!("squad")).unwrap();
            drop(held);
            assert!(worker.join().unwrap(), "and then migrates");
            read()
        };
        let after = race("command kiro-cli chat --agent dev --model claude-haiku-4.5 --trust-all-tools", |h, c| migrate_launch_model(h, c).unwrap());
        assert_eq!(after["team"], "squad", "the move survives the model migration");
        assert!(!after["cmd"].as_str().unwrap().contains("--model"), "{after}");
        // The engine line: whichever way the door is set, make it change.
        let flag = engine_flag();
        let start = if flag.is_empty() { "command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3" } else { "command kiro-cli chat --agent dev --trust-all-tools" };
        let after = race(start, |h, _| reconcile_recipe_engine(h).unwrap());
        assert_eq!(after["team"], "squad", "the move survives the engine reconcile");
        assert_eq!(after["cmd"].as_str(), reconcile_engine_in(start, &flag).as_deref());
        let _ = std::fs::remove_dir_all(home.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// Board #271: panes captured on kiro-cli 2.22.1 v3 (capture-pane -p).
    #[test]
    fn the_live_input_mode_is_read_off_the_screen() {
        let busy_queue = "● Shell sleep 40\n────\nkiro · Claude Opus 5.5 · high · ◔ 1% · Midway: expired   /tmp/steer/ws\n›  Kiro is working · Type to queue · Ctrl+S to steer\n";
        let busy_steer = "kiro · Claude Opus 5.5 · high · ◑ 35%\n›  Kiro is working · Type to steer · Ctrl+S to queue\n";
        let idle = "────\nkiro · Claude Opus 5.5 · high · ◔ 1%\n›  ask a question or describe a task ↵\n                                       /sessions to resume · /copy to clipboard\n";
        assert_eq!(live_input_mode(busy_queue), Some("queue"));
        assert_eq!(live_input_mode(busy_steer), Some("steer"));
        assert_eq!(live_input_mode(idle), None, "idle kiro paints no mode");
        // Older build (vitals.rs fixture): no `›`, one leading space.
        assert_eq!(live_input_mode(" Kiro is working · Type to queue · Ctrl+S to steer\n"), Some("queue"));
        // A Ctrl+S confirmation, idle; it outranks the footer.
        let switched = format!("● Switched to Steer mode\n\n{idle}");
        assert_eq!(live_input_mode(&switched), Some("steer"));
        assert_eq!(live_input_mode(&format!("● Switched to Queue mode\n{busy_steer}")), Some("queue"),
            "the confirmation is read first (orchestrator, #271)");
        // Only the bottom-most confirmation counts.
        assert_eq!(live_input_mode("● Switched to Steer mode\nx\n● Switched to Queue mode\n"), Some("queue"));
    }

    /// Board #346: the same screens on kiro-cli 2.28.0, captured on this host
    /// with `tmux capture-pane -p -J -S -0 | cat -A` (builder, 2026-10-12).
    /// The toast's bullet is U+2022 where 2.22.1 painted U+25CF, and the
    /// footer carries an elapsed segment the old prefix never allowed for —
    /// each one alone was enough to make `switch_input_mode` time out with
    /// "the pane did not confirm <mode> mode" while the pane had switched.
    #[test]
    fn kiro_2_28_toast_and_footer_are_read() {
        // Idle, the toast is the only evidence there is.
        let idle = "Default · claude-opus-5 · thinking · high · ◔ 2% · Midway: 6h 10m    /tmp\n\n›  ask a question or describe a task ↵\n                       /sessions to resume · /copy to clipboard\n";
        assert_eq!(live_input_mode(idle), None, "idle kiro still paints no mode");
        assert_eq!(live_input_mode(&format!("• Switched to Steer mode\n{idle}")), Some("steer"));
        assert_eq!(live_input_mode(&format!("• Switched to Queue mode\n{idle}")), Some("queue"));
        // Busy, the footer is — with the elapsed time between label and hints.
        assert_eq!(live_input_mode("›  Kiro is working · 1m 27s · Type to steer · Ctrl+S to queue\n"), Some("steer"));
        assert_eq!(live_input_mode("›  Kiro is working · 19s · Type to queue · Ctrl+S to steer\n"), Some("queue"));
        // The queued-count line kiro paints above that footer in queue mode
        // is not a mode: it counts messages, and its own word is "queued".
        assert_eq!(live_input_mode(" ◇ 1 message queued · ctrl+x expand\n"), None);
        assert_eq!(live_input_mode("◇ 2 messages queued · ctrl+x expand\n"), None);
        let queued = " ◇ 1 message queued · ctrl+x expand\n›  Kiro is working · 32s · Type to queue · Ctrl+S to steer\n";
        assert_eq!(live_input_mode(queued), Some("queue"), "the footer still answers");
        // The bullet set is closed (reviewer's P1 on the first tip): the two
        // measured glyphs and the four of kiro's own family, nothing else.
        assert_eq!(TOAST_BULLETS, ['●', '•', '○', '◦', '◆', '◇']);
        for bullet in TOAST_BULLETS {
            assert_eq!(live_input_mode(&format!("{bullet} Switched to Steer mode\n")), Some("steer"), "{bullet}");
        }
        for other in ['*', '-', '+', '#', '>', '›', '|', '"'] {
            assert_eq!(live_input_mode(&format!("{other} Switched to Queue mode\n")), None, "{other} is not a kiro bullet");
        }
    }

    #[test]
    fn a_quoted_mode_line_is_not_the_pane_mode() {
        // The owner's own words, delivered as chat, and tool output reading a pane.
        let chat = "  › [tmm chat 2026-09-29 03:47] human: @builder Switched to Steer mode 我观察到\n    ● Switched to Steer mode\n    Kiro is working · Type to steer · Ctrl+S to queue\n";
        assert_eq!(live_input_mode(chat), None);
        let tool = "● Shell tmux capture-pane -p -t x\n    ╰ output:\n        ● Switched to Queue mode\n        ›  Kiro is working · Type to queue · Ctrl+S to steer\n";
        assert_eq!(live_input_mode(tool), None);
        assert_eq!(live_input_mode("● Switched to Steer mode, then I pressed it again\n"), None, "prose around it");
        assert_eq!(live_input_mode("›  Kiro is working · Type to queue · Ctrl+S to queue\n"), None, "a self-contradiction");
        assert_eq!(live_input_mode("›Kiro is working · Type to steer · Ctrl+S to queue\n"), None);
        assert_eq!(live_input_mode(""), None);
        // Board #346: a bullet is matched by shape, so the two glyphs that
        // carry what was TYPED must stay out — otherwise a person or a
        // delivery saying the sentence would switch the mode by saying it.
        assert_eq!(live_input_mode("›  Switched to Steer mode\n"), None, "kiro's input stamp");
        assert_eq!(live_input_mode("> Switched to Queue mode\n"), None);
        assert_eq!(live_input_mode("  • Switched to Steer mode\n"), None, "indented: not column zero");
        // And the footer is still the footer, not any line that says the word.
        assert_eq!(live_input_mode("›  Type to steer · Ctrl+S to queue\n"), None, "no label");
        assert_eq!(live_input_mode("›  Kiro is working · 19s · press Ctrl+S to steer\n"), None, "one hint only");
    }

    /// v3's post-turn `memory` auto-capture is the housekeeping tool (board
    /// #227); every other tool, in either key spelling, is the agent's work.
    /// #361: the head glyph is a closed set of the two measured glyphs, and
    /// the model name is whatever kiro prints — never a list of models.
    #[test]
    fn high_traffic_takes_a_closed_set_of_head_glyphs_and_any_model_name() {
        assert_eq!(HEAD_GLYPHS, ['●', '•'], "a new glyph is added here ON A MEASUREMENT, with a fixture");
        let id = "ef8dd12f-668e-4cdb-a8a7-7ecc7baa4146";
        let sentence = |name: &str| format!("{name} is experiencing high traffic. Try again, or select another model. (Request ID: {id})");
        for name in ["claude-fable-5.1", "claude-opus-5.5", "Auto", "Claude Sonnet 4.6", "global.openai.gpt-6-astra", "Claude Opus 4.1 (1M context)"] {
            for head in ['●', '•'] {
                assert!(high_traffic(&format!("{head} {}", sentence(name))), "{head} {name}");
            }
        }
        // Names that are not a model name: six words, and a pipe or a slash
        // (a path or a shell line, not a model).
        for name in ["one two three four five six", "claude|opus", "anthropic/claude-opus-5.5", ""] {
            for head in ['●', '•'] {
                assert!(!high_traffic(&format!("{head} {}", sentence(name))), "{head} {name:?}");
            }
        }
        // Any glyph outside the set, no glyph, a glyph glued to the name.
        for head in ['›', '▸', '○', '◦', '◆', '◇', '·', '▪', '◉', '-', '>', '*'] {
            assert!(!high_traffic(&format!("{head} {}", sentence("Auto"))), "{head:?}");
        }
        assert!(!high_traffic(&sentence("Auto")));
        assert!(!high_traffic(&format!("•{}", sentence("Auto"))));
    }

    /// #370: the rate-limit shape is the sentence and nothing else, under the
    /// closed head set — no model name, no lead-in, no tail, a canonical uuid.
    #[test]
    fn too_many_requests_is_exactly_the_sentence_under_a_closed_head() {
        assert_eq!(HEAD_GLYPHS, ['●', '•']);
        let id = "319ae15c-f2d3-4ada-bafc-9b9b20927ea8";
        let sentence = format!("Too many requests, please wait before trying again. (Request ID: {id})");
        for head in HEAD_GLYPHS {
            assert!(too_many_requests(&format!("{head} {sentence}")), "{head}");
            // A hard wrap is a space: the block arrives joined with spaces.
            assert!(too_many_requests(&format!("{head} Too many requests, please wait before trying\n  again. (Request ID:\n  {id})")), "{head}: wrapped");
            for bad in [
                format!("{head} {sentence} "), // trailing space is whitespace: still the block
            ] {
                assert!(too_many_requests(&bad), "{head}: surrounding whitespace is collapsed");
            }
            for (bad, why) in [
                (format!("{head} Note: {sentence}"), "a lead-in"),
                (format!("{head} {sentence}."), "text after"),
                (format!("{head} {}", sentence.replace("Too many", "Too Many")), "capitalised differently"),
                (format!("{head} {}", sentence.replace(',', "")), "no comma"),
                (format!("{head} {}", sentence.replace("(Request ID: ", "(request_id: ")), "the other shape's id key"),
                (format!("{head} {}", sentence.replace(id, "not-a-uuid")), "not a uuid"),
                (format!("{head} {}", sentence.strip_suffix(')').unwrap()), "no close paren"),
                (format!("{head}{sentence}"), "glued to the head"),
            ] {
                assert!(!too_many_requests(&bad), "{head}: {why}");
            }
        }
        assert!(!too_many_requests(&sentence), "no head");
        for head in ['›', '▸', '○', '◦', '◆', '◇', '·', '-', '>'] {
            assert!(!too_many_requests(&format!("{head} {sentence}")), "{head:?}");
        }
        // It is not the high-traffic sentence, and that one is not this.
        assert!(!high_traffic(&format!("• {sentence}")));
        assert!(!too_many_requests(&format!("• Auto is experiencing high traffic. Try again, or select another model. (Request ID: {id})")));
        // transient_error is the one door: the glued form is canonicalised for
        // the older shapes, and this one reads the spaced form.
        assert_eq!(transient_shape(&format!("• {sentence}").replace(" ", ""), &format!("• {sentence}")), Some("too_many_requests"));
    }

    #[test]
    fn memory_is_the_housekeeping_tool() {
        assert!(is_housekeeping_tool(&json!({"hook_event_name":"postToolUse","tool_name":"memory","tool_input":{}})));
        assert!(is_housekeeping_tool(&json!({"hookEventName":"postToolUse","toolName":"memory"})));
        assert!(!is_housekeeping_tool(&json!({"hook_event_name":"postToolUse","tool_name":"execute_bash","tool_input":{"command":"ls"}})));
        assert!(!is_housekeeping_tool(&json!({"hook_event_name":"stop"})));
    }

    /// Board #207: the engine door edits the recorded launch line exactly.
    #[test]
    fn engine_segment_is_added_replaced_or_removed_exactly() {
        let base = "command kiro-cli chat --agent dev --trust-all-tools";
        assert_eq!(reconcile_engine_in(base, ""), None, "closed door, no segment: nothing to do");
        assert_eq!(reconcile_engine_in(base, " --agent-engine v3").as_deref(), Some("command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3"));
        let v3 = "command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3";
        assert_eq!(reconcile_engine_in(v3, " --agent-engine v3"), None, "already open: idempotent");
        assert_eq!(reconcile_engine_in(v3, "").as_deref(), Some(base), "door closed: the segment goes, the line is what it was");
        let kick = "command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3 kick";
        assert_eq!(reconcile_engine_in(kick, "").as_deref(), Some("command kiro-cli chat --agent dev --trust-all-tools kick"));
        assert_eq!(reconcile_engine_in("x --agent-engine v2", " --agent-engine v3").as_deref(), Some("x --agent-engine v3"));
    }

    /// Board #207: v3 keeps the reply in the global session file. Real row
    /// shape from ~/.kiro/sessions/…/messages.jsonl (kiro-cli 2.22.1):
    /// {id, timestamp, payload:{type, content, …}}.
    #[test]
    fn v3_reply_is_the_last_assistant_entry_of_the_last_turn() {
        let row = |t: &str, extra: &str| format!(r#"{{"id":"x","timestamp":"2026-09-20T02:00:00Z","payload":{{"type":"{t}"{extra}}}}}"#);
        let jsonl = [
            row("user", r#","content":"first question""#),
            row("turn_start", r#","executionId":"e1""#),
            row("assistant", r#","content":"old answer""#),
            row("turn_end", r#","stopReason":"end_turn""#),
            row("user", r#","content":"Run the shell command: echo debug-probe""#),
            row("turn_start", r#","executionId":"e2""#),
            row("tool_call", r#","toolName":"execute_bash""#),
            row("assistant", r#","content":"Running it.""#),
            row("tool_result", r#","content":"Output:\ndebug-probe""#),
            "this line is not json".to_string(),
            row("assistant", r#","content":"```\ndebug-probe\n```\nExit code: 0""#),
            row("turn_end", r#","stopReason":"end_turn""#),
            row("session_start", r#","content":"You are a probe.""#),
        ].join("\n");
        assert_eq!(kiro_reply_from_session(&jsonl).as_deref(), Some("```\ndebug-probe\n```\nExit code: 0"));
        assert_eq!(kiro_reply_from_session(&row("user", r#","content":"q""#)), None, "no assistant yet");
        assert_eq!(kiro_reply_from_session(""), None);
        // Bare rows (no payload wrapper) are read too.
        assert_eq!(kiro_reply_from_session(r#"{"type":"assistant","content":"bare"}"#).as_deref(), Some("bare"));
    }

    #[test]
    fn session_reply_finds_the_session_under_any_cwd_hash() {
        let root = std::env::temp_dir().join(format!("tmm-kiro-sessions-{}", std::process::id()));
        let sess = root.join("1f1f982434702399").join("sess_abc");
        std::fs::create_dir_all(&sess).unwrap();
        std::fs::write(sess.join("messages.jsonl"), "{\"payload\":{\"type\":\"turn_start\"}}\n{\"payload\":{\"type\":\"assistant\",\"content\":\"done and verified\"}}\n{\"payload\":{\"type\":\"turn_end\"}}").unwrap();
        assert_eq!(session_reply(&root, "sess_abc").as_deref(), Some("done and verified"));
        assert_eq!(session_reply(&root, "sess_nope"), None);
        assert_eq!(session_reply(&root, "../etc"), None, "a path is not a session id");
        assert_eq!(session_reply(&root, ""), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Board #376 (owner, 2026-10-15: "luminar-log 这个项目，为啥 agent 返回
    /// 的结果界面上都看不到"). Four managed kiro agents finished turns in
    /// their panes while the room showed none of their replies, because this
    /// fallback ignored the isolated home it was handed and read the GLOBAL
    /// store — where a STALE copy of the same session id still sat from
    /// before that agent's home was isolated. Both files existed; the wrong
    /// one answered, every time, so no room line and no reply edge ever
    /// appeared and every `@editor` request was a dead end.
    ///
    /// The two texts are the real last assistant rows of that incident,
    /// trimmed: the live file under `KIRO_HOME` (mtime 01:39) and the stale
    /// global copy (mtime 00:03).
    #[test]
    fn the_isolated_home_answers_before_a_stale_global_copy() {
        let id = "sess_e2c9";
        let write = |root: &std::path::Path, text: &str| {
            let dir = root.join("297005da4b9f6bd1").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("messages.jsonl"),
                format!(
                    "{{\"payload\":{{\"type\":\"turn_start\"}}}}\n{{\"payload\":{{\"type\":\"assistant\",\"content\":{}}}}}\n{{\"payload\":{{\"type\":\"turn_end\"}}}}",
                    serde_json::to_string(text).unwrap()
                ),
            )
            .unwrap();
        };
        let live = "Done. 用 Gemini 生成了封面。";
        let stale = "Team already saved; now restart…";
        // ONE call: `fresh_process_dir` clears its directory on every call,
        // so a second one would wipe the roots built above it.
        let root = crate::config::fresh_process_dir("tmm-kiro-376");
        let home = root.join("editor");
        write(&home.join("sessions"), live);
        // The global store under test is this process's own temp dir
        // (`legacy_sessions_root`), so the developer's `~/.kiro` is never
        // read and never written.
        let global = legacy_sessions_root().unwrap();
        write(&global, stale);

        let payload = serde_json::json!({ "session_id": id, "hook_event_name": "Stop" });
        let payload = payload.as_object().unwrap();
        assert_eq!(
            reply_fallback(payload, Some(home.as_path())).as_deref(),
            Some(live),
            "the running agent writes in its isolated home; the global copy is history"
        );
        // An agent we have no home for (unmanaged, or spawned before homes
        // were isolated) still gets the legacy answer — that is the only
        // source it has.
        assert_eq!(reply_fallback(payload, None).as_deref(), Some(stale));
        // A home that does not HOLD this session falls back rather than
        // going mute: the legacy store may be the only place it exists.
        let empty = root.join("fresh");
        std::fs::create_dir_all(empty.join("sessions")).unwrap();
        assert_eq!(reply_fallback(payload, Some(empty.as_path())).as_deref(), Some(stale));

        // But a home that DOES hold it and has nothing to say for this turn
        // is an ANSWER, not a miss (board #376 review P1). kiro's `"..."`
        // placeholder row is exactly that case (#213), and falling through
        // here would post the stale copy's old sentence as this turn's reply
        // and spend the turn's reply edge on it.
        let placeholder = root.join("quiet");
        let dir = placeholder.join("sessions").join("297005da4b9f6bd1").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("messages.jsonl"),
            "{\"payload\":{\"type\":\"assistant\",\"content\":\"earlier turn\"}}\n             {\"payload\":{\"type\":\"turn_end\"}}\n             {\"payload\":{\"type\":\"turn_start\"}}\n             {\"payload\":{\"type\":\"assistant\",\"content\":\"...\"}}",
        )
        .unwrap();
        assert_eq!(
            reply_fallback(payload, Some(placeholder.as_path())),
            None,
            "the authoritative source said nothing this turn: that is the answer"
        );
        // Same for a session directory whose file is not there yet (the turn
        // has only just started) or cannot be read.
        let unwritten = root.join("unwritten");
        std::fs::create_dir_all(unwritten.join("sessions").join("297005da4b9f6bd1").join(id)).unwrap();
        assert_eq!(reply_fallback(payload, Some(unwritten.as_path())), None);
        // The three outcomes are visible in `session_lookup` itself, which
        // is where the distinction is made.
        assert_eq!(session_lookup(&unwritten.join("sessions"), id), SessionSource::Found(None));
        assert_eq!(session_lookup(&empty.join("sessions"), id), SessionSource::Missing);
        assert_eq!(
            session_lookup(&home.join("sessions"), id),
            SessionSource::Found(Some(live.to_string()))
        );
        // A root we cannot READ is not an empty root (review P1 round 2): a
        // regular file where the sessions directory should be, a path whose
        // parent is a file, an unreadable directory. None of them may send
        // the hook to a stale copy — the reply goes missing instead, which
        // `sniff`-style memory does not paper over and a person can see.
        let not_a_dir = root.join("file-root");
        std::fs::write(&not_a_dir, b"not a directory").unwrap();
        assert_eq!(session_lookup(&not_a_dir, id), SessionSource::Unreadable);
        assert_eq!(reply_fallback(payload, Some(root.join("file-root").as_path())), None,
            "an unreadable isolated home must not fall through to the global copy");
        // A bucket we cannot enumerate: the session is NOT found, and we may
        // not conclude it is absent.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let locked = root.join("locked").join("sessions");
            std::fs::create_dir_all(locked.join("bucket")).unwrap();
            std::fs::set_permissions(locked.join("bucket"), std::fs::Permissions::from_mode(0o000)).unwrap();
            // Running as root defeats the permission bits; then there is
            // simply nothing to assert here.
            if std::fs::metadata(locked.join("bucket").join(id)).is_err()
                && std::fs::read_dir(locked.join("bucket")).is_err()
            {
                assert_eq!(session_lookup(&locked, id), SessionSource::Unreadable);
                assert_eq!(reply_fallback(payload, Some(root.join("locked").as_path())), None);
            }
            let _ = std::fs::set_permissions(locked.join("bucket"), std::fs::Permissions::from_mode(0o755));
        }
        // A path that is not a session id is Missing, not uncertain.
        assert_eq!(session_lookup(&home.join("sessions"), "../etc"), SessionSource::Missing);
        // And a payload with no session id reads nothing at all.
        let bare = serde_json::json!({ "hook_event_name": "Stop" });
        assert_eq!(reply_fallback(bare.as_object().unwrap(), Some(home.as_path())), None);
    }

    /// Board #207: the v3 status line prints the model's DISPLAY name.
    #[test]
    fn display_name_models_are_read_only_after_the_anchor() {
        assert!(looks_like_model_name("Claude Sonnet 5"));
        assert!(looks_like_model_name("GPT 5.1 Codex"));
        assert!(!looks_like_model_name("Midway: 19h 19m"), "a colon is not a model");
        assert!(!looks_like_model_name("◔ 4%"));
        assert!(!looks_like_model_name("/local/home/cfu/temp/kiro-v3-test/ws"));
        assert!(!looks_like_model_name("(probe-branch)"));
        let v3 = "probe · Claude Sonnet 5 · high · ◔ 4% · Midway: 19h 19m   /local/home/cfu/temp/kiro-v3-test/ws · (probe-branch)\n";
        let v = sniff_kiro(v3, "probe");
        assert_eq!(v.model.as_deref(), Some("Claude Sonnet 5"));
        assert_eq!(v.effort.as_deref(), Some("high"));
        assert_eq!(v.context_pct, Some(4));
        assert_eq!(v.branch.as_deref(), Some("probe-branch"));
        let v2 = "probe · claude-sonnet-5 · high · ◔ 1% · Midway: 19h 19m   /local/home/cfu/temp/kiro-v3-test/ws · (probe-branch)\n";
        let v = sniff_kiro(v2, "probe");
        assert_eq!(v.model.as_deref(), Some("claude-sonnet-5"));
        // Negative control: the same words on an UNANCHORED line are prose.
        let prose = "I switched to Claude Sonnet 5 · high · ◔ 4%\n";
        assert_eq!(sniff_kiro(prose, "probe").model, None);
    }

    /// Board #213, measured on a managed v3 spawn: the turn's last assistant
    /// row is a `"..."` placeholder AFTER the real text; a second turn after a
    /// `session_start` row must not fall back to the first turn's text.
    #[test]
    fn session_reply_skips_the_placeholder_row_and_stays_in_the_last_turn() {
        let rows = [
            r#"{"id":1,"timestamp":1,"payload":{"type":"user","content":"[tmm chat] human: say hi"}}"#,
            r#"{"id":2,"timestamp":2,"payload":{"type":"turn_start"}}"#,
            r#"{"id":3,"timestamp":3,"payload":{"type":"assistant","content":"v3 ready."}}"#,
            r#"{"id":4,"timestamp":4,"payload":{"type":"assistant","content":"..."}}"#,
            r#"{"id":5,"timestamp":5,"payload":{"type":"turn_end"}}"#,
        ];
        assert_eq!(kiro_reply_from_session(&rows.join("\n")).as_deref(), Some("v3 ready."));
        let second = [
            r#"{"id":6,"timestamp":6,"payload":{"type":"session_start","content":"prompt"}}"#,
            r#"{"id":7,"timestamp":7,"payload":{"type":"turn_start"}}"#,
            r#"{"id":8,"timestamp":8,"payload":{"type":"assistant","content":"…"}}"#,
            r#"{"id":9,"timestamp":9,"payload":{"type":"turn_end"}}"#,
        ];
        let all = format!("{}\n{}", rows.join("\n"), second.join("\n"));
        assert_eq!(kiro_reply_from_session(&all), None, "a turn with only placeholders has no reply");
    }

    /// Board #355. The placeholder is the CLI's whole sentence or it is not the
    /// placeholder: the decision types into an agent's pane, so a looser match
    /// would nudge an agent that had answered (reviewer P1-A).
    #[test]
    fn only_the_whole_placeholder_is_an_empty_turn() {
        let whole = EMPTY_TURN_PLACEHOLDER;
        assert!(is_empty_turn_reply(whole));
        assert!(is_empty_turn_reply(&format!("\n  {whole}\n")), "padding is not text");
        assert!(is_empty_turn_reply(&whole.replace(". This", ".\nThis")), "a wrapped line is the same words");
        // What it is NOT: each of these has been, or could be, a real reply.
        let cut = &whole[..whole.find(" This placeholder").unwrap()];
        assert!(!is_empty_turn_reply("(No assistant response was recorded for the preceding turn"), "half a sentence");
        assert!(!is_empty_turn_reply(cut), "the first sentence alone");
        assert!(!is_empty_turn_reply(&format!("{whole} Then the gate went green: 673 passed.")), "the placeholder followed by the real result");
        assert!(!is_empty_turn_reply(&format!("Result first. {whole}")), "text before it");
        assert!(!is_empty_turn_reply(&format!("The log says: \"{whole}\" — that was the validator's turn.")), "a reply that quotes it");
        assert!(!is_empty_turn_reply(&whole.replace("preceding", "previous")), "one word different is not the CLI's text");
        assert!(!is_empty_turn_reply(&whole.replace("No assistant", "no assistant")), "nor is a different case");
        assert!(!is_empty_turn_reply(""));
        assert!(!is_empty_turn_reply("Done."));
    }

    /// Board #355: the captured shape, replayed. Rows are the real ones of a
    /// stalled turn (kiro-cli v3 session store, `sess_aea970de…`, written
    /// 2026-10-13 23:58 UTC; ids shortened, the project's text dropped): a tool
    /// call and its result, then the CLI's own `Say` row, then the `steer` line
    /// that arrived after. The Stop hook for that turn carries NO text, so the
    /// reply comes from the isolated home's session file — the same lookup the
    /// live consumer runs. The store does not record the CLI version that wrote
    /// the row; the host's was 2.31.0.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    #[test]
    fn a_captured_stalled_turn_is_read_back_as_the_placeholder() {
        let rows = [
            r#"{"id":"b97e","timestamp":"2026-10-13T23:58:32.723Z","payload":{"type":"session_metadata","key":"contextUsage","value":{"usagePercentage":48.8},"executionId":"4a87"}}"#,
            r#"{"id":"run_command_toolu-call","timestamp":"2026-10-13T23:58:33.802Z","payload":{"type":"tool_call","toolCallId":"run_command_toolu","toolName":"execute_bash","args":{"command":"tmm board note 48 \"...\""}}}"#,
            r#"{"id":"run_command_toolu-result","timestamp":"2026-10-13T23:58:33.802Z","payload":{"type":"tool_result","toolCallId":"run_command_toolu","content":"Output:\n✓ #48\n✓ sent\n\n\nExit Code: 0","success":true,"executionId":"4a87"}}"#,
            r#"{"id":"515c-say","timestamp":"2026-10-13T23:58:45.402Z","payload":{"type":"assistant","content":"(No assistant response was recorded for the preceding turn. This placeholder was inserted automatically to preserve message alternation — it is not a reply the assistant produced.)","operationType":"Say","executionId":"4a87","_meta":{"kiro":{"agentMode":"writer"}}}}"#,
            r#"{"id":"steer-58ec","timestamp":"2026-10-13T23:58:45.427Z","payload":{"type":"user","content":"[tmm chat 2026-10-14 07:58] editor: [reply] ok","source":"steer"}}"#,
        ];
        let home = std::env::temp_dir().join(format!("tmm-kiro-empty-{}", uuid::Uuid::new_v4()));
        let dir = home.join("sessions").join("297005da4b9f6bd1").join("sess_aea9");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("messages.jsonl"), rows.join("\n")).unwrap();
        let stop = serde_json::json!({"hook_event_name": "stop", "session_id": "sess_aea9"});
        let reply = reply_fallback(stop.as_object().unwrap(), Some(&home)).expect("the Stop hook has no body: the session file answers");
        assert_eq!(reply, EMPTY_TURN_PLACEHOLDER, "the captured row is byte-for-byte the constant");
        assert!(is_empty_turn_reply(&reply));

        // The same turn when the agent DID say something after the tool call.
        let said = [rows[2], r#"{"id":"1","timestamp":"2026-10-13T23:59:00.000Z","payload":{"type":"assistant","content":"Posted #48; waiting on the critic.","operationType":"Say"}}"#];
        std::fs::write(dir.join("messages.jsonl"), said.join("\n")).unwrap();
        let reply = reply_fallback(stop.as_object().unwrap(), Some(&home)).unwrap();
        assert!(!is_empty_turn_reply(&reply), "{reply}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Board #213: resume follows the engine on the launch line.
    #[test]
    fn resume_dialect_follows_the_engine_on_the_launch_line() {
        let v2 = "command kiro-cli chat --agent dev --trust-all-tools";
        assert_eq!(resume_command(v2, Some("0d1b8e2a-1111"), None, "dev"), format!("{v2} --resume-id 0d1b8e2a-1111"));
        assert_eq!(resume_command(v2, Some("sess_abc"), None, "dev"), format!("{v2} --resume"), "a v3 id never reaches the v2 engine: its own recent thread");
        assert_eq!(resume_command(v2, None, None, "dev"), format!("{v2} --resume"));

        let v3 = format!("{v2} --agent-engine v3");
        // An exact v3 id used to resume on its own. It resumes only when the
        // agent's OWN home holds it (board #379, `v3_session_resumable`, tested
        // below with real fixture homes); with no home to check, or nothing in
        // it, the answer is fresh.
        assert_eq!(resume_command(&v3, Some("sess_abc"), None, "dev"), v3, "no home to vouch for the id: fresh");
        assert_eq!(resume_command(&v3, Some("0d1b8e2a-1111"), None, "dev"), v3, "a v2 id never reaches the v3 engine: fresh");
        assert_eq!(resume_command(&v3, None, None, "dev"), v3, "no --resume under v3: the store is per directory, not per agent");
        assert!(launch_engine_is_v3("kiro-cli chat --v3"));
        assert!(!launch_engine_is_v3("kiro-cli chat --agent-engine v2"));
        // Flipping the door back (reconcile drops the segment) restores the v2 dialect untouched.
        let back = reconcile_engine_in(&v3, "").unwrap();
        assert_eq!(resume_command(&back, Some("0d1b8e2a-1111"), None, "dev"), format!("{v2} --resume-id 0d1b8e2a-1111"));
    }

    /// Board #379 (owner, 2026-10-15, learn-english and laminar-log: "agent 的
    /// 回复没有正确 hook，单独的 agent 好着，team 里的不行"). A restart handed
    /// kiro-cli v3 a recorded session id the agent's isolated home did not
    /// hold; v3 does not fail on that — it silently CREATES an empty session
    /// under the id with `agentMode: "vibe"` (the Default agent), ignoring
    /// `--agent`, and the Default agent carries none of our hooks. Solo agents
    /// worked (a fresh spawn has no id) and restarted team members did not.
    ///
    /// Real fixture homes, in kiro's own layout `<home>/sessions/<cwd-hash>/
    /// <id>/session.json`. Each case is a way the id can fail to be this
    /// agent's own session, and the answer must be FRESH (the bare launch line,
    /// no resume flag of any kind).
    #[test]
    fn a_v3_id_resumes_only_when_the_agents_own_home_holds_it() {
        let root = crate::config::fresh_process_dir("tmm-kiro-379");
        let v3 = "command kiro-cli chat --agent dev --trust-all-tools --agent-engine v3";
        let id = "sess_e58968b6-0000-4000-8000-000000000001";
        let resume = format!("{v3} --resume-id {id}");
        let session = |home: &std::path::Path, bucket: &str, id: &str, body: &str| {
            let dir = home.join("sessions").join(bucket).join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session.json"), body).unwrap();
        };
        let mode = |m: &str| format!(r#"{{"schemaVersion":"1.0.0","id":"{id}","agentMode":"{m}","createdAt":"2026-10-15T02:06:53Z"}}"#);

        // The session is in the agent's own home and is this agent's: resumes.
        let own = root.join("own");
        session(&own, "13c0722d7b097be1", id, &mode("dev"));
        assert_eq!(resume_command(v3, Some(id), Some(&own), "dev"), resume, "the agent's own session resumes");

        // The id lives ONLY in the global store (what the slots recorded): the
        // agent's home holds nothing, so FRESH. This is the incident.
        let empty = root.join("empty");
        std::fs::create_dir_all(empty.join("sessions")).unwrap();
        assert_eq!(resume_command(v3, Some(id), Some(&empty), "dev"), v3, "global-only copy: fresh, never ~/.kiro");

        // The home holds the id but kiro made the session up (`vibe`, the
        // Default agent): every later restart would resume it and stay
        // hookless for good. FRESH.
        let vibe = root.join("vibe");
        session(&vibe, "13c0722d7b097be1", id, &mode("vibe"));
        assert_eq!(resume_command(v3, Some(id), Some(&vibe), "dev"), v3, "a vibe session is the incident, not a conversation");

        // Another agent's session under the same id is not this agent's.
        let other = root.join("other");
        session(&other, "13c0722d7b097be1", id, &mode("reviewer"));
        assert_eq!(resume_command(v3, Some(id), Some(&other), "dev"), v3, "agentMode must equal the agent's window name");

        // Anything unreadable is "cannot vouch for it": fresh. A fresh agent
        // with hooks beats a resumed one without.
        let bad = root.join("bad");
        session(&bad, "13c0722d7b097be1", id, "{ this is not json");
        assert_eq!(resume_command(v3, Some(id), Some(&bad), "dev"), v3, "malformed session.json");
        let noagent = root.join("noagent");
        session(&noagent, "13c0722d7b097be1", id, r#"{"id":"x"}"#);
        assert_eq!(resume_command(v3, Some(id), Some(&noagent), "dev"), v3, "no agentMode at all");
        let notdir = root.join("notdir");
        std::fs::write(&notdir, "a file where the home should be").unwrap();
        assert_eq!(resume_command(v3, Some(id), Some(&notdir), "dev"), v3, "an unreadable store");
        assert_eq!(resume_command(v3, Some(id), None, "dev"), v3, "no home to check against");

        // (Which bucket holds the id, and an id that is a path, have their own
        // tests below: they need fixtures that cannot pass by luck.)
        // The name comes from the CALLER, not from the launch line: an empty
        // name vouches for nothing, and the line's own `--agent` is never read.
        assert_eq!(resume_command(v3, Some(id), Some(&own), ""), v3, "no agent name: fresh");
        assert_eq!(
            resume_command("command kiro-cli chat --agent-engine v3", Some(id), Some(&own), "dev"),
            "command kiro-cli chat --agent-engine v3 --resume-id sess_e58968b6-0000-4000-8000-000000000001",
            "a line with no --agent still resumes: the name is not parsed from it"
        );
        // And v2 is untouched by all of this: its store is per-home and its
        // ids are not `sess_…`.
        let v2 = "command kiro-cli chat --agent dev --trust-all-tools";
        assert_eq!(resume_command(v2, Some("0d1b8e2a-1111"), Some(&vibe), "dev"), format!("{v2} --resume-id 0d1b8e2a-1111"));
    }

    /// Board #379 (validator, negative control 5). The id is found under
    /// whichever cwd-hash bucket holds it, and a bucket that does not is
    /// skipped rather than ending the search. A real home always has a second
    /// bucket beside the hash one (`sessions/cli/`), so an empty bucket in
    /// front of the real one is the common case, not an edge.
    ///
    /// `read_dir` order belongs to the filesystem (tmpfs lists the newest
    /// entry first, ext4 by name hash), so ONE real bucket among empties
    /// proves nothing when it happens to list first: the first cut of this
    /// test passed with `continue` changed to `return false`. Every bucket
    /// therefore takes a turn as the real one, in homes created identically;
    /// whatever order the filesystem lists them in, all but one turn put an
    /// empty bucket in front.
    #[test]
    fn the_resume_search_goes_past_an_empty_bucket_in_any_listing_order() {
        let root = crate::config::fresh_process_dir("tmm-kiro-379-buckets");
        let id = "sess_e58968b6-0000-4000-8000-000000000001";
        let body = format!(r#"{{"id":"{id}","agentMode":"dev"}}"#);
        let buckets = ["cli", "13c0722d7b097be1", "aaaa", "mmmm", "zzzz"];
        for real in buckets {
            let home = root.join(format!("real-{real}"));
            for bucket in buckets {
                std::fs::create_dir_all(home.join("sessions").join(bucket)).unwrap();
            }
            let dir = home.join("sessions").join(real).join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session.json"), &body).unwrap();
            assert!(v3_session_resumable(&home, "dev", id), "the session is in `{real}`, past the empty buckets");
        }
    }

    /// Ids that are paths, planted so that each WOULD resolve to a readable
    /// session if nothing refused it: `../planted` out of a bucket into a
    /// sibling, `a/b` and `a\b` below it, a dot directory, and `""`, which
    /// makes the bucket itself the session. Board #379 (validator, negative
    /// control 6): the first cut asserted refusals for ids that resolved to
    /// nothing, so it passed with the guard removed. Returns the home and the
    /// ids; the fixture checks its own claim that every one resolves.
    fn plant_path_shaped_sessions(prefix: &str) -> (std::path::PathBuf, [&'static str; 5]) {
        let home = crate::config::fresh_process_dir(prefix);
        let sessions = home.join("sessions");
        let bucket = sessions.join("13c0722d7b097be1");
        let body = r#"{"id":"planted","agentMode":"dev"}"#;
        let ids = ["../planted", "a/b", "a\\b", ".hidden", ""];
        let plant = |dir: std::path::PathBuf| {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session.json"), body).unwrap();
        };
        plant(sessions.join("planted"));
        plant(bucket.join("a").join("b"));
        plant(bucket.join("a\\b"));
        plant(bucket.join(".hidden"));
        plant(bucket.clone());
        for id in ids {
            assert!(bucket.join(id).join("session.json").is_file(), "{id:?} must resolve for this test to mean anything");
        }
        (home, ids)
    }

    #[test]
    fn a_path_shaped_id_never_resumes_even_where_it_would_resolve() {
        let (home, ids) = plant_path_shaped_sessions("tmm-kiro-379-guard-resume");
        for id in ids {
            assert!(!v3_session_resumable(&home, "dev", id), "{id:?} is a path, not a session id");
        }
    }

    /// The same guard in front of the #376 reply lookup.
    #[test]
    fn a_path_shaped_id_is_missing_to_the_reply_lookup_even_where_it_would_resolve() {
        let (home, ids) = plant_path_shaped_sessions("tmm-kiro-379-guard-lookup");
        for id in ids {
            assert_eq!(session_lookup(&home.join("sessions"), id), SessionSource::Missing, "{id:?} is a path, not a session id");
        }
    }

    /// Board #207: the exact 3.0 hooks we write — no `matcher` anywhere (the
    /// 2.0 glob "*" invalidates a 3.0 profile, measured), four named hooks.
    #[test]
    fn hooks_shape_is_the_3_0_array_without_matchers() {
        let hooks = kiro_hooks("/usr/bin/tmm-notify kiro");
        let list = hooks.as_array().expect("an array");
        assert_eq!(list.len(), 4);
        assert!(list.iter().all(|h| h.get("matcher").is_none()), "no matcher: {hooks}");
        assert!(list.iter().all(|h| h["action"]["type"] == "command" && h["action"]["command"] == "/usr/bin/tmm-notify kiro" && h["timeout"] == 10));
        let names: Vec<&str> = list.iter().map(|h| h["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["tmm-pre-tool", "tmm-post-tool", "tmm-prompt", "tmm-stop"]);
    }

    /// Board #207 option A: the v3 engine finds the agent through the
    /// WORKSPACE, so the door being open puts a symlink there and closing it
    /// takes the link away; a foreign file is never clobbered.
    #[test]
    fn workspace_entry_follows_the_engine_door_and_never_clobbers() {
        let root = std::env::temp_dir().join(format!("tmm-kiro-wsentry-{}", std::process::id()));
        let ws = root.join("ws");
        let home = ws.join(".tmm").join("agents").join("dev");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        std::fs::create_dir_all(ws.join(".git").join("info")).unwrap();
        std::fs::write(home.join("agents").join("dev.json"), "{}").unwrap();
        let link = workspace_entry_path(&ws, "dev");

        // Door closed (default): zero change to the workspace.
        std::env::remove_var("KIRO_ENGINE");
        assert!(!ensure_workspace_entry(&ws, &home, "dev").unwrap());
        assert!(!link.exists() && !ws.join(".kiro").exists(), "v2 leaves no trace");

        // Door open: the link, idempotent, and the git exclude.
        std::env::set_var("KIRO_ENGINE", "v3");
        assert!(ensure_workspace_entry(&ws, &home, "dev").unwrap());
        assert_eq!(std::fs::read_link(&link).unwrap(), home.join("agents").join("dev.json"));
        assert!(!ensure_workspace_entry(&ws, &home, "dev").unwrap(), "second start: nothing to do");
        let exclude = std::fs::read_to_string(ws.join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l == "/.kiro/agents/dev.json"), "our file only, not the directory: {exclude}");
        assert!(!exclude.contains("/.kiro/agents/\n"), "the user's own agents stay visible to their git status");
        ensure_workspace_entry(&ws, &home, "dev").unwrap();
        assert_eq!(std::fs::read_to_string(ws.join(".git/info/exclude")).unwrap(), exclude, "exclude is written once");
        // A second agent adds its own line under the one mark.
        let home2 = ws.join(".tmm").join("agents").join("ops2");
        std::fs::create_dir_all(home2.join("agents")).unwrap();
        std::fs::write(home2.join("agents").join("ops2.json"), "{}").unwrap();
        ensure_workspace_entry(&ws, &home2, "ops2").unwrap();
        let exclude2 = std::fs::read_to_string(ws.join(".git/info/exclude")).unwrap();
        assert!(exclude2.lines().any(|l| l == "/.kiro/agents/ops2.json"));
        assert_eq!(exclude2.matches(GIT_EXCLUDE_MARK).count(), 1, "one mark: {exclude2}");
        remove_workspace_entry(&ws, "ops2");
        // Writing THROUGH the link lands in the home (what the CLI's upgrade does).
        std::fs::write(&link, "{\"name\":\"dev\"}").unwrap();
        assert_eq!(std::fs::read_to_string(home.join("agents/dev.json")).unwrap(), "{\"name\":\"dev\"}");
        assert!(std::fs::symlink_metadata(&link).unwrap().file_type().is_symlink(), "still a link, no copy");

        // A foreign file in the way: fail loud, naming it, leave it alone.
        let other = workspace_entry_path(&ws, "ops");
        std::fs::write(&other, "{\"name\":\"ops\",\"mine\":true}").unwrap();
        let err = ensure_workspace_entry(&ws, &home, "ops").unwrap_err();
        assert!(err.contains("ops.json") && err.contains("not a tmux-mobile link"), "{err}");
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "{\"name\":\"ops\",\"mine\":true}");
        assert!(!remove_workspace_entry(&ws, "ops"), "not ours to remove");

        // Door closed again: our link goes, the foreign file stays.
        std::env::set_var("KIRO_ENGINE", "v2");
        assert!(ensure_workspace_entry(&ws, &home, "dev").unwrap());
        assert!(!link.exists() && other.exists());
        // Removal helper: ours only.
        std::env::set_var("KIRO_ENGINE", "v3");
        ensure_workspace_entry(&ws, &home, "dev").unwrap();
        assert!(remove_workspace_entry(&ws, "dev") && !link.exists());
        std::env::remove_var("KIRO_ENGINE");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Board #207: the 3.0 profile is written once and never churned — a home
    /// the CLI already upgraded (array + permissions) is left byte-identical.
    #[test]
    fn patch_profile_is_idempotent_on_both_shapes() {
        let dir = std::env::temp_dir().join(format!("tmm-kiro-profile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.json");
        std::fs::write(&path, serde_json::to_string_pretty(&json!({
            "name": "a", "prompt": "p", "hooks": { "stop": [ { "command": "old" } ] }
        })).unwrap()).unwrap();
        assert!(patch_profile(&path, kiro_hooks("n")).unwrap(), "2.0 object → 3.0 array + permissions");
        let once = std::fs::read_to_string(&path).unwrap();
        assert!(!patch_profile(&path, kiro_hooks("n")).unwrap(), "already 3.0: no write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), once);
        let v: Value = serde_json::from_str(&once).unwrap();
        assert!(v["hooks"].is_array());
        assert_eq!(v["permissions"]["rules"][0]["capability"], "all");
        // A permissions block someone else wrote is theirs.
        std::fs::write(&path, serde_json::to_string_pretty(&json!({
            "name": "a", "hooks": kiro_hooks("n"), "permissions": { "rules": [ { "capability": "shell", "effect": "ask" } ] }
        })).unwrap()).unwrap();
        assert!(!patch_profile(&path, kiro_hooks("n")).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
