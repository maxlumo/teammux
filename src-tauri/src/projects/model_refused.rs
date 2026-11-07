//! A model id the provider rejects is said WITH that id (board #65 item 2).
//!
//! The id is the one the agent was LAUNCHED with, read from what its render
//! wrote, so a later edit of its definition never relabels a CLI still
//! running on the old one (validator note 14, orchestrator 20:20): codex's
//! managed profile (`<home>/codex/tmm-agent.config.toml`, `model`), and for
//! every other backend the `--model` / `-m` its recipe's launch line carries
//! (claude, kimi, omp). None means the backend's default. A reader that knows
//! better, codex's `turn_context` of that very turn (it follows a `/model`),
//! has already put `model <id>: ` in front, and that is kept.

use std::path::Path;

/// `text` with the model named, when it says the provider rejects the model.
pub fn named(session: &str, window: &str, text: &str) -> String {
    if !crate::backends::shared::model_rejected(text) || text.starts_with("model ") {
        return text.to_string();
    }
    let model = super::managed_home(session, window).and_then(|home| launched(&home));
    match model {
        Some(m) => format!("model {m}: {text}"),
        None => format!("model (its backend's default): {text}"),
    }
}

/// The model `home`'s CLI was launched with; `None` for its backend's default.
fn launched(home: &Path) -> Option<String> {
    let recipe = super::recipe::recipe_section(home).read().ok().flatten()?;
    if recipe.get("backend").and_then(|b| b.as_str()) == Some("codex") {
        let profile = std::fs::read_to_string(home.join("codex").join(crate::backends::shared::codex_profile_file())).ok()?;
        let table: toml::Table = profile.parse().ok()?;
        return table.get("model").and_then(|m| m.as_str()).map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    }
    flag_model(recipe.get("cmd").and_then(|c| c.as_str())?)
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
        assert_eq!(launched(&home).as_deref(), Some("claude-opus-5-5"));
        recipe("kimi", "command kimi --auto -m 'kimi-k3'");
        assert_eq!(launched(&home).as_deref(), Some("kimi-k3"));
        recipe("kimi", "command kimi --auto");
        assert_eq!(launched(&home), None, "no flag: the backend's default");
        recipe("codex", "codex --profile tmm-agent --no-daemon");
        std::fs::create_dir_all(home.join("codex")).unwrap();
        std::fs::write(home.join("codex/tmm-agent.config.toml"), "model = \"gpt-6.1-sol\"\nmodel_reasoning_effort = \"high\"\n").unwrap();
        assert_eq!(launched(&home).as_deref(), Some("gpt-6.1-sol"), "codex: its managed profile");
        std::fs::write(home.join("codex/tmm-agent.config.toml"), "model_reasoning_effort = \"high\"\n").unwrap();
        assert_eq!(launched(&home), None);
        // Text that is not a model rejection, or already names the model, is kept.
        assert_eq!(named("no-such-session", "w", "invalid API key"), "invalid API key");
        assert_eq!(named("no-such-session", "w", &format!("model gpt-x: {text}")), format!("model gpt-x: {text}"));
        assert_eq!(named("no-such-session", "w", text), format!("model (its backend's default): {text}"), "no home known: the default");
        let _ = std::fs::remove_dir_all(&home);
    }
}
