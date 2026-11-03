//! Which model ids a backend actually accepts.
//!
//! Reason this exists: a registry def's `model` used to be free text that was
//! pasted straight onto the launch line, and kiro-cli's TUI treats an unknown
//! `--model` as a warning it prints above the splash screen before starting on
//! the DEFAULT model. So `claude-sonnet-4-5` (dashes, one character off the
//! real `claude-sonnet-4.5`) produced an agent that ran happily on the wrong
//! model with nothing in the UI to say so — the owner's report, 2026-08-19.
//!
//! The list is asked of the CLI itself (`kiro-cli chat --list-models`), never
//! hardcoded: model ids come and go weekly, and a stale table in this repo
//! would reject a model the backend has just shipped. Everything degrades
//! soft — no CLI, no auth, unparsable output all mean "we cannot know", and an
//! unknown-to-us model is then accepted rather than blocking a save.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub use crate::backends::{ModelKind, ModelReason};

/// A bounded, de-addressed model list (board #511): the ids, whether they are
/// the backend's whole catalogue, and whether this answer holds all of them.
#[derive(Debug, Clone, PartialEq)]
pub struct List {
    pub ids: Vec<String>,
    pub kind: ModelKind,
    pub complete: bool,
}

/// The discovery answer's budget: at most this many ids, each at most this
/// many characters, with no control characters. It bounds what DISCOVERY
/// returns and never what a renderer inherits.
pub const MAX_IDS: usize = 1024;
pub const MAX_ID_CHARS: usize = 256;

fn id_ok(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_CHARS && !id.chars().any(char::is_control)
}

/// Apply the budget (board #511 review P1-A). An AUTHORITATIVE list that
/// breaks it ANYWHERE is unusable WHOLE — never a shorter whitelist, which
/// would refuse a legal id that only fell off the end. Suggestions keep what
/// fits and say they are incomplete.
pub fn bounded(ids: Vec<String>, kind: ModelKind) -> Result<List, ModelReason> {
    match kind {
        ModelKind::Authoritative => {
            if ids.len() > MAX_IDS || !ids.iter().all(|id| id_ok(id)) {
                return Err(ModelReason::Overflow);
            }
            Ok(List { ids, kind, complete: true })
        }
        ModelKind::Suggestions => {
            let total = ids.len();
            let kept: Vec<String> = ids.into_iter().filter(|id| id_ok(id)).take(MAX_IDS).collect();
            let complete = kept.len() == total;
            Ok(List { ids: kept, kind, complete })
        }
    }
}

/// How long a fetched list is reused. `--list-models` is a network round trip
/// (~3s measured), which is fine once per app run and much too slow per save.
const TTL: Duration = Duration::from_secs(600);

type Cache = Mutex<Vec<(String, Instant, List)>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// The model list `backend` has, bounded, or why there is none.
///
/// The cache lock is held for the lookup and for the insert, never across
/// the fetch: that is a ~3 s CLI round trip, and every registry save
/// validates through here, so one hung `--list-models` used to serialise
/// every save behind it. Two concurrent misses may both fetch — a rare 3 s,
/// not a bug. Only an `Ok` list is cached (board #511): a failure is never
/// remembered as an empty catalogue, so the next request asks again.
pub fn list_fact(backend: &str) -> Result<List, ModelReason> {
    if let Ok(c) = cache().lock() {
        if let Some((_, at, list)) = c.iter().find(|(b, ..)| b == backend) {
            if at.elapsed() < TTL {
                return Ok(list.clone());
            }
        }
    }
    let fetched = fetch(backend)?;
    if let Ok(mut c) = cache().lock() {
        c.retain(|(b, ..)| b != backend);
        c.push((backend.to_string(), Instant::now(), fetched.clone()));
    }
    Ok(fetched)
}

/// Drop one backend's cached list, so a test can stage a fresh read.
#[cfg(test)]
pub(crate) fn forget(backend: &str) {
    if let Ok(mut c) = cache().lock() {
        c.retain(|(b, ..)| b != backend);
    }
}

/// The ids alone, or `None` when there is no list.
pub fn list(backend: &str) -> Option<Vec<String>> {
    list_fact(backend).ok().map(|l| l.ids)
}

/// The backend's baseline default (`Backend::baseline_model`), read FRESH on
/// every call and never cached: a changed config shows at once, and nothing
/// here can feed a launch. Shown under the same rule as a listed id.
pub fn default_fact(backend: &str) -> Result<Option<String>, ModelReason> {
    let Some(b) = crate::backends::Backend::parse(backend) else { return Err(ModelReason::NotDerivable) };
    match b.baseline_model()? {
        Some(id) if id_ok(&id) => Ok(Some(id)),
        Some(_) => Err(ModelReason::Overflow),
        None => Ok(None),
    }
}

/// `models_list`'s answer (board #511): two independent facts and why each
/// is absent. `models` keeps its old meaning for an older client: the ids,
/// or `null` when there is no list. A field missing altogether means an
/// older server; `null` means this server has nothing to say.
pub fn answer(backend: &str) -> serde_json::Value {
    answer_of(backend, list_fact(backend), default_fact(backend))
}

/// The pure half of `answer`: the two facts, serialized.
fn answer_of(backend: &str, list: Result<List, ModelReason>, default: Result<Option<String>, ModelReason>) -> serde_json::Value {
    let (models, kind, complete, list_reason) = match list {
        // A trimmed suggestions list says why it is short (P2 review P2-C).
        Ok(l) => {
            let reason = if l.complete { serde_json::Value::Null } else { serde_json::json!(ModelReason::Overflow.word()) };
            (serde_json::json!(l.ids), serde_json::json!(l.kind.word()), l.complete, reason)
        }
        Err(r) => (serde_json::Value::Null, serde_json::Value::Null, false, serde_json::json!(r.word())),
    };
    let (default, default_reason) = match default {
        Ok(id) => (serde_json::json!(id), serde_json::Value::Null),
        Err(r) => (serde_json::Value::Null, serde_json::json!(r.word())),
    };
    serde_json::json!({
        "backend": backend,
        "models": models,
        "kind": kind,
        "complete": complete,
        "list_reason": list_reason,
        "default": default,
        "default_reason": default_reason,
    })
}

/// Reject a model the backend would silently ignore. An empty model means
/// "backend default" and is always fine.
/// The reasoning-effort levels each backend's CLI accepts (provenance on the
/// backend files, board #127).
pub fn effort_values(backend: &str) -> &'static [&'static str] {
    // The knowledge lives on the backend's own file (board #127); an unknown
    // backend has no levels, exactly as before.
    crate::backends::Backend::parse(backend).map(|b| b.effort_values()).unwrap_or(&[])
}

/// Effort validation mirrors model validation: empty = the backend default and
/// always passes; a non-empty value must be one the CLI accepts, because a
/// wrong one is a warning above the splash and a silent fallback (claude), or
/// a config error nobody reads (codex).
pub fn validate_effort(backend: &str, effort: &str) -> Result<(), String> {
    let effort = effort.trim();
    if effort.is_empty() {
        return Ok(());
    }
    let known = effort_values(backend);
    if known.contains(&effort) {
        return Ok(());
    }
    Err(format!(
        "'{effort}' is not a {backend} effort level. Available: {}",
        known.join(", ")
    ))
}

/// The input mode (board #245) at the door: `queue` everywhere, `steer` only
/// on a backend whose switch is measured (`Backend::switches_input_mode`) —
/// elsewhere `steer` would be a value no config carries, i.e. a lie in the
/// editor.
pub fn validate_input_mode(backend: &str, mode: &str) -> Result<(), String> {
    match mode {
        "queue" => Ok(()),
        "steer" if crate::backends::Backend::parse(backend).is_some_and(|b| b.switches_input_mode()) => Ok(()),
        "steer" => Err(format!("steer is not offered for {backend}: no queue/steer switch was measured for it, so its CLI's own behaviour applies; save it as queue")),
        other => Err(format!("input mode must be queue|steer, got '{other}'")),
    }
}

pub fn validate(backend: &str, model: &str) -> Result<(), String> {
    let model = model.trim();
    if model.is_empty() {
        return Ok(());
    }
    // The syntax a backend demands of an id even when no list can be asked
    // (dsh: the id goes to the wire unparsed; board #411).
    if let Some(error) = crate::backends::Backend::parse(backend).and_then(|b| b.model_id_error(model)) {
        return Err(error);
    }
    member(backend, &list_fact(backend), model)
}

/// The membership rule, pure (board #511 review P1-A): checked ONLY against
/// a COMPLETE authoritative list. Suggestions never refuse, and a list that
/// is missing, failed or over budget accepts — so this only ever turns a
/// refusal into an accept, and nothing that saved before starts failing.
pub fn member(backend: &str, fact: &Result<List, ModelReason>, model: &str) -> Result<(), String> {
    let known = match fact {
        Ok(List { ids, kind: ModelKind::Authoritative, complete: true }) if !ids.is_empty() => ids,
        _ => return Ok(()),
    };
    if known.iter().any(|m| m == model) {
        return Ok(());
    }
    Err(format!(
        "'{model}' is not a {backend} model. Available: {}",
        known.join(", ")
    ))
}

/// Ask the backend (the sources live on the backend files, board #127) and
/// apply the budget.
fn fetch(backend: &str) -> Result<List, ModelReason> {
    let b = crate::backends::Backend::parse(backend).ok_or(ModelReason::NotListed)?;
    let (ids, kind) = b.model_list()?;
    bounded(ids, kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything about this must degrade soft: a machine with no kiro-cli, an
    /// expired login, or a future output format must not make saving an agent
    /// impossible.
    #[test]
    fn an_unknowable_list_validates_everything() {
        // claude's list (if this host declares one) is SUGGESTIONS, so any id
        // validates whatever the host has (board #511); codex has no
        // catalogue in the test home.
        assert!(list("codex").is_none());
        assert!(validate("claude", "sonnet").is_ok());
        assert!(validate("claude", "an-id-no-host-declares").is_ok());
        assert!(validate("codex", "gpt-5.6-terra").is_ok());
        // An empty model is "backend default" for every backend.
        assert!(validate("kiro", "").is_ok());
        assert!(validate("kiro", "   ").is_ok());
    }

    /// The budget never makes a partial whitelist (board #511 review P1-A):
    /// an authoritative list that breaks it ANYWHERE is unusable whole, so a
    /// legal id that would only have fallen off the end still saves.
    #[test]
    fn an_authoritative_list_over_budget_is_unknown_whole_and_refuses_nothing() {
        let ids = |n: usize| (0..n).map(|i| format!("m{i}")).collect::<Vec<_>>();
        let auth = ModelKind::Authoritative;
        assert_eq!(bounded(ids(MAX_IDS), auth).map(|l| l.complete), Ok(true), "exactly at the budget is whole");
        let over = bounded(ids(MAX_IDS + 1), auth);
        assert_eq!(over, Err(ModelReason::Overflow), "a 1025th id: the WHOLE list is unknown");
        assert!(member("codex", &over, &format!("m{MAX_IDS}")).is_ok(), "the 1025th legal id saves");
        assert!(member("codex", &over, "anything").is_ok(), "an unknown list refuses nothing");
        let long = "x".repeat(300);
        let with_long = bounded(vec!["a".into(), long.clone()], auth);
        assert_eq!(with_long, Err(ModelReason::Overflow));
        assert!(member("codex", &with_long, &long).is_ok(), "a 300-char legal id saves");
        assert_eq!(bounded(vec!["a".into(), "b\u{7}".into()], auth), Err(ModelReason::Overflow), "a control character");
        // Failures and facts alike accept.
        for r in [ModelReason::NotListed, ModelReason::Invalid, ModelReason::TooLarge, ModelReason::Unreadable, ModelReason::CliFailed] {
            assert!(member("kiro", &Err(r), "claude-sonnet-4-5").is_ok(), "{r:?}");
        }

        // Suggestions keep what fits and SAY they are incomplete.
        let s = bounded([ids(MAX_IDS), vec!["late".into()]].concat(), ModelKind::Suggestions).unwrap();
        assert_eq!((s.ids.len(), s.complete), (MAX_IDS, false));
        let s = bounded(vec!["ok".into(), "x".repeat(300), "bad\n".into()], ModelKind::Suggestions).unwrap();
        assert_eq!((s.ids, s.complete), (vec!["ok".to_string()], false));
        // ...and never refuse: an id outside them is still legal.
        let sugg = Ok(List { ids: vec!["opus".into()], kind: ModelKind::Suggestions, complete: true });
        assert!(member("claude", &sugg, "sonnet").is_ok(), "a legal claude id outside the suggestions passes");
        assert!(member("omp", &sugg, "amazon-bedrock/anthropic.claude-x").is_ok(), "an omp native selector passes");
    }

    /// A failure is never remembered as an empty catalogue (board #511
    /// P2-D): the next request reads again and sees the repaired file.
    #[test]
    fn a_failed_read_is_never_cached() {
        let cfg = crate::backends::kimi::kimi_user_home().join("config.toml");
        forget("kimi");
        std::fs::write(&cfg, "not = [toml").unwrap();
        assert_eq!(list_fact("kimi"), Err(ModelReason::Invalid));
        std::fs::write(&cfg, "[models.k3]\nprovider = \"p\"\n").unwrap();
        assert_eq!(list_fact("kimi").map(|l| l.ids), Ok(vec!["k3".to_string()]), "the next request read again");
        std::fs::remove_file(&cfg).ok();
        forget("kimi");
    }

    /// The CLI-listed catalogues are read WHOLE or not at all (board #511):
    /// one entry without an id makes the answer unusable, never shorter.
    #[test]
    fn a_cli_catalogue_with_a_bad_entry_is_no_list() {
        use crate::backends::kiro;
        let ok = br#"{"default_model":"auto","models":[{"model_id":"auto"},{"model_id":"claude-sonnet-4.5"}]}"#;
        assert_eq!(kiro::model_list_from(ok), Ok((vec!["auto".into(), "claude-sonnet-4.5".into()], ModelKind::Authoritative)));
        let bad = br#"{"models":[{"model_id":"auto"},{"name":"no id"}]}"#;
        assert_eq!(kiro::model_list_from(bad), Err(ModelReason::CliFailed));
        assert_eq!(kiro::model_list_from(b"not json"), Err(ModelReason::CliFailed));
        assert_eq!(kiro::model_list_from(br#"{"models":[]}"#), Err(ModelReason::CliFailed));
    }

    /// grok's catalogue is read in its measured format, WHOLE or not at all
    /// (board #511 P2 review P1-B): a line in the section that is not
    /// exactly an entry, or stdout that is not UTF-8, is no list — never a
    /// shorter authoritative one that refuses the id it dropped.
    fn grok_ok(ids: &[&str]) -> Result<(Vec<String>, ModelKind), ModelReason> {
        Ok((ids.iter().map(|s| s.to_string()).collect(), ModelKind::Authoritative))
    }

    #[test]
    fn grok_measured_output_with_its_default_is_the_whole_catalogue() {
        use crate::backends::grok::model_list_from;
        // Lines before the header are not entries; the default carries ` (default)`.
        let measured = b"You are not authenticated.\n\nDefault model: bedrock-grok46\n\nAvailable models:\n  - grok-4.6\n  - grok-4.5\n  * bedrock-grok46 (default)\n";
        assert_eq!(model_list_from(measured), grok_ok(&["grok-4.6", "grok-4.5", "bedrock-grok46"]));
        assert_eq!(model_list_from(b"Available models:\n  * g (default)\n\n"), grok_ok(&["g"]), "trailing blank");
    }

    #[test]
    fn grok_a_good_entry_beside_a_broken_one_is_no_list() {
        use crate::backends::grok::model_list_from;
        for broken in ["  - ", "  - two words", "  * g (default) extra", "  -grok-4.6", "  + grok-4.6", "  Use --all to see more"] {
            let text = format!("Available models:\n  - grok-4.6\n{broken}\n");
            assert_eq!(model_list_from(text.as_bytes()), Err(ModelReason::CliFailed), "{broken:?}");
        }
    }

    #[test]
    fn grok_only_broken_entries_no_header_or_an_empty_section_is_no_list() {
        use crate::backends::grok::model_list_from;
        assert_eq!(model_list_from(b"Available models:\n  - \n  *\n"), Err(ModelReason::CliFailed));
        assert_eq!(model_list_from(b"  - grok-4.6\n"), Err(ModelReason::CliFailed), "no header");
        assert_eq!(model_list_from(b"Available models:\n\n"), Err(ModelReason::CliFailed), "empty");
    }

    #[test]
    fn grok_stdout_that_is_not_utf8_is_no_list() {
        use crate::backends::grok::model_list_from;
        assert_eq!(model_list_from(b"Available models:\n  - grok-\xff4.6\n"), Err(ModelReason::CliFailed));
    }

    /// The #127 incident still refuses against a NORMAL complete catalogue:
    /// the dashed spelling of a real id.
    #[test]
    fn a_complete_authoritative_list_still_refuses_the_typo_it_exists_for() {
        let kiro = Ok(List { ids: vec!["auto".into(), "claude-sonnet-4.5".into()], kind: ModelKind::Authoritative, complete: true });
        let err = member("kiro", &kiro, "claude-sonnet-4-5").unwrap_err();
        assert!(err.contains("claude-sonnet-4.5"), "the error names the real ids: {err}");
        assert!(member("kiro", &kiro, "claude-sonnet-4.5").is_ok());
        let codex = Ok(List { ids: vec!["global.openai.gpt-6-astra".into()], kind: ModelKind::Authoritative, complete: true });
        assert!(member("codex", &codex, "gpt-6-astra").is_err(), "an out-of-catalogue slug is still refused");
    }

    /// dsh has no list but a baseline default; the answer carries both facts
    /// separately, and a missing field is told apart from null (board #511).
    #[test]
    fn the_answer_carries_the_list_and_the_default_as_separate_facts() {
        assert_eq!(list_fact("dsh"), Err(ModelReason::NotListed));
        assert_eq!(default_fact("dsh"), Ok(Some(crate::backends::dsh_default_model().to_string())));
        let a = answer("dsh");
        assert_eq!(a["models"], serde_json::Value::Null);
        assert_eq!(a["kind"], serde_json::Value::Null, "present and null: a new server with no list");
        assert_eq!(a["list_reason"], "not_listed");
        assert_eq!(a["default"], crate::backends::dsh_default_model());
        assert_eq!(a["default_reason"], serde_json::Value::Null);
        for key in ["backend", "models", "kind", "complete", "list_reason", "default", "default_reason"] {
            assert!(a.get(key).is_some(), "{key} is always present on this server");
        }
        assert!(!ModelReason::NotListed.is_failure() && !ModelReason::NotDerivable.is_failure());

        // A trimmed suggestions list is incomplete AND says why (P2 review
        // P2-C); a whole one carries no reason.
        let ids = (0..=MAX_IDS).map(|i| format!("m{i}")).collect::<Vec<_>>();
        let cut = answer_of("claude", bounded(ids, ModelKind::Suggestions), Ok(None));
        assert_eq!((cut["kind"].clone(), cut["complete"].clone(), cut["list_reason"].clone()), (serde_json::json!("suggestions"), serde_json::json!(false), serde_json::json!("overflow")));
        assert_eq!(cut["models"].as_array().map(Vec::len), Some(MAX_IDS));
        let whole = answer_of("claude", bounded(vec!["opus".into()], ModelKind::Suggestions), Ok(None));
        assert_eq!((whole["complete"].clone(), whole["list_reason"].clone()), (serde_json::json!(true), serde_json::Value::Null));
        assert!(ModelReason::Unreadable.is_failure() && ModelReason::Overflow.is_failure() && ModelReason::CliFailed.is_failure());
    }

    /// When the CLI IS there, the exact typo class this module exists for must
    /// be rejected — and the real id it was a typo OF must be accepted.
    #[test]
    fn a_one_character_typo_is_rejected_when_the_cli_can_tell_us() {
        let Some(models) = list("kiro") else {
            eprintln!("kiro-cli unavailable — validation degrades to accept-all, covered above");
            return;
        };
        assert!(models.iter().any(|m| m == "auto"), "got {models:?}");
        let real = models
            .iter()
            .find(|m| m.contains("sonnet"))
            .expect("a sonnet model exists")
            .clone();
        assert!(validate("kiro", &real).is_ok());
        let typo = real.replace('.', "-");
        if typo != real {
            let err = validate("kiro", &typo).expect_err("dashed version must not pass");
            assert!(err.contains(&real), "the error must name the real ids: {err}");
        }
        // The second call comes from the cache, so a save never pays for a
        // second round trip.
        let before = Instant::now();
        assert!(validate("kiro", &real).is_ok());
        assert!(before.elapsed() < Duration::from_millis(200), "cached");
    }
}
