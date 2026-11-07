//! A model id the provider rejects is said WITH that id (board #65 item 2).
//!
//! The id is the one the agent was LAUNCHED with, read from what its render
//! wrote, so a later edit of its definition never relabels a CLI still
//! running on the old one (validator note 14, orchestrator 20:20): codex's
//! managed profile (`<home>/codex/tmm-agent.config.toml`, `model`), and for
//! every other backend the `--model` / `-m` its recipe's launch line carries
//! (claude, kimi, omp). Named none: the backend's default. Not readable:
//! unknown, never the default. A reader that knows
//! better, codex's `turn_context` of that very turn (it follows a `/model`),
//! has already put `model <id>: ` in front, and that is kept.

use std::path::Path;

/// `text` with the model named, when it says the provider rejects the model.
pub fn named(session: &str, window: &str, text: &str) -> String {
    if !crate::backends::shared::model_rejected(text) || text.starts_with("model ") {
        return text.to_string();
    }
    match super::managed_home(session, window).ok_or(()).and_then(|home| launched(&home)) {
        Ok(Some(m)) => format!("model {m}: {text}"),
        Ok(None) => format!("model (its backend's default): {text}"),
        Err(()) => format!("model unknown (its launch config could not be read): {text}"),
    }
}

/// The model `home`'s CLI was launched with: `Ok(None)` when what the render
/// wrote names none (its backend's default), `Err` when it cannot be READ
/// (validator note 26: a failed read is unknown, never the default).
fn launched(home: &Path) -> Result<Option<String>, ()> {
    let recipe = super::recipe::recipe_section(home).read().ok().flatten().ok_or(())?;
    if recipe.get("backend").and_then(|b| b.as_str()).and_then(crate::backends::Backend::parse) == Some(crate::backends::Backend::Codex) {
        return crate::backends::codex::profile_model(home);
    }
    Ok(flag_model(recipe.get("cmd").and_then(|c| c.as_str()).ok_or(())?))
}

/// The value of `--model` or `-m` on a launch line, unquoted.
fn flag_model(cmd: &str) -> Option<String> {
    let words: Vec<&str> = cmd.split_whitespace().collect();
    let at = words.iter().position(|w| *w == "--model" || *w == "-m")?;
    let value = words.get(at + 1)?.trim_matches('\'').trim_matches('"');
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The launched id, per backend, from what the render wrote; and the
    /// default when it named none.
    #[test]
    fn a_rejected_model_is_named_by_what_the_agent_was_launched_with() {
        let text = r#"{"error":{"message":"The provided model identifier is invalid."}}"#;
        let home = crate::config::test_scratch("tmm-model-refused");
        let recipe = |backend: &str, cmd: &str| {
            crate::projects::spawn::LaunchRecipe { backend, env: &[], cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
        };
        recipe("claude", "claude --dangerously-skip-permissions --model 'claude-opus-5-5' --settings x");
        assert_eq!(launched(&home), Ok(Some("claude-opus-5-5".to_string())));
        recipe("kimi", "command kimi --auto -m 'kimi-k3'");
        assert_eq!(launched(&home), Ok(Some("kimi-k3".to_string())));
        recipe("kimi", "command kimi --auto");
        assert_eq!(launched(&home), Ok(None), "no flag: the backend's default");
        recipe("codex", "codex --profile tmm-agent --no-daemon");
        std::fs::create_dir_all(home.join("codex")).unwrap();
        std::fs::write(home.join("codex/tmm-agent.config.toml"), "model = \"gpt-6.1-sol\"\nmodel_reasoning_effort = \"high\"\n").unwrap();
        assert_eq!(launched(&home), Ok(Some("gpt-6.1-sol".to_string())), "codex: its managed profile");
        std::fs::write(home.join("codex/tmm-agent.config.toml"), "model_reasoning_effort = \"high\"\n").unwrap();
        assert_eq!(launched(&home), Ok(None), "read, and it names none: the backend's default");
        // Validator note 26: a profile that cannot be read is UNKNOWN, never the default.
        std::fs::write(home.join("codex/tmm-agent.config.toml"), "model = [not toml").unwrap();
        assert!(launched(&home).is_err(), "unparsable: unknown");
        std::fs::remove_file(home.join("codex/tmm-agent.config.toml")).unwrap();
        assert!(launched(&home).is_err(), "missing: unknown");
        std::fs::remove_file(home.join("launch.json")).unwrap();
        assert!(launched(&home).is_err(), "no recipe: unknown");
        // Text that is not a model rejection, or already names the model, is kept.
        assert_eq!(named("no-such-session", "w", "invalid API key"), "invalid API key");
        assert_eq!(named("no-such-session", "w", &format!("model gpt-x: {text}")), format!("model gpt-x: {text}"));
        assert_eq!(named("no-such-session", "w", text), format!("model unknown (its launch config could not be read): {text}"), "no home known: unknown, never the default");
        let _ = std::fs::remove_dir_all(&home);
    }
}
