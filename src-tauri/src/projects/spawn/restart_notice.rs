//! What a restart tells the room about the conversation it resumes (board
//! #46 S3, #74): the room line, and why a CLI will not resume an agent's
//! chat. Kept out of `spawn.rs` and `hub_rpc.rs`, which are over the
//! 2000-line limit (code-quality.md).

#[cfg(not(any(target_os = "android", target_os = "ios")))]
/// A restart's room line (board #46 S3): the recipe's backend before the
/// start and after its re-render. A changed one starts FRESH (a conversation
/// id never crosses backends), and the room says so. So does a conversation
/// its CLI will not resume (`notice`, board #74: a codex chat from another
/// provider); otherwise as before.
pub(crate) fn restart_line(agent: &str, before: Option<crate::backends::Backend>, after: Option<crate::backends::Backend>, notice: Option<&str>) -> String {
    match (before, after, notice) {
        (Some(b), Some(a), _) if b != a => format!("[tmm] restarted {agent} on {}, fresh conversation", a.name()),
        (_, _, Some(why)) => format!("[tmm] restarted {agent}, fresh conversation: {why}"),
        _ => format!("[tmm] restarted {agent}"),
    }
}

/// Why `relaunch_line` for the same arguments starts fresh instead of
/// resuming (board #74), for the room; `None` when it resumes, when the
/// recipe cannot be read, or when a backend switch already starts it fresh
/// (`relaunch_line`'s `observed` rule, said by its own room line).
pub fn resume_notice(project_path: &str, window_name: &str, session_id: Option<&str>, observed: Option<&str>) -> Option<String> {
    let (_, backend, _, home) = super::recipe_parts(project_path, window_name).ok()??;
    if observed.is_some_and(|o| o != backend) {
        return None;
    }
    crate::backends::Backend::parse(&backend)?.resume_notice(session_id.filter(|s| !s.is_empty()), &home)
}

/// `resume_notice` for the managed agent `agent` in `session`, from its
/// slot's recorded conversation and backend; `None` when it resumes, or
/// when nothing can be read. Read before a start, which writes the new
/// thread (board #74).
pub fn resume_notice_for(session: &str, agent: &str) -> Option<String> {
    let project = crate::projects::project_for_session(session).ok()??;
    let (project, slots) = crate::projects::projects::load(&project.id).ok()?;
    let slot = slots.iter().find(|s| s.kind == crate::projects::store::SlotKind::Agent && s.window_name == agent)?;
    resume_notice(&project.path, agent, slot.agent_session_id.as_deref(), slot.command.as_deref())
}

#[cfg(test)]
mod tests {
    use crate::projects::spawn::{agent_home, relaunch_line, LaunchRecipe};
    use super::*;

    /// Board #46 S3: a restart that applied a new backend says so, because
    /// the conversation it had is not resumed (non-negotiable: an id never
    /// crosses backends); the same backend reads as before.
    #[test]
    fn a_restart_onto_another_backend_says_it_starts_a_fresh_conversation() {
        use crate::backends::Backend;
        assert_eq!(restart_line("val", Some(Backend::Omp), Some(Backend::Codex), None), "[tmm] restarted val on codex, fresh conversation");
        assert_eq!(restart_line("val", Some(Backend::Codex), Some(Backend::Codex), None), "[tmm] restarted val");
        assert_eq!(restart_line("val", None, Some(Backend::Codex), None), "[tmm] restarted val", "no recipe before: nothing to compare");
        // Board #74: a chat its CLI will not resume is said, with the reason.
        let why = "its chat was started on amazon-bedrock-runtime and codex is now on ust, which codex will not resume";
        assert_eq!(restart_line("val", Some(Backend::Codex), Some(Backend::Codex), Some(why)), format!("[tmm] restarted val, fresh conversation: {why}"));
    }

    /// Board #74, measured on codex-cli 0.166.0: codex refuses `resume <id>`
    /// when the chat's rollout was started under another provider than the
    /// current one (`thread/resume failed: This chat uses
    /// amazon-bedrock-runtime, but your current provider is ust`) and leaves
    /// the pane at the shell. The restart starts fresh instead; the same
    /// provider, an unreadable rollout or another codex version resume as
    /// before.
    #[test]
    fn a_codex_chat_from_another_provider_restarts_fresh() {
        let ws = crate::config::test_scratch("tmm-relaunch-codex-provider");
        let wss = ws.to_str().unwrap();
        let home = agent_home(wss, "cx");
        let codex = home.join("codex");
        let day = codex.join("sessions/2026/11/07");
        std::fs::create_dir_all(&day).unwrap();
        let cmd = "command codex -c a=b --dangerously-bypass-approvals-and-sandbox";
        LaunchRecipe { backend: "codex", env: &[], cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
        let line = |id: &str| relaunch_line(wss, "cx", Some(id), None).unwrap().unwrap();
        let resume = |id: &str| format!("command codex resume {id} -c a=b --dangerously-bypass-approvals-and-sandbox");
        let id = "01a1b6a1-7c52-7461-96ad-2b987988a3f6";
        let rollout = |first: &str| std::fs::write(day.join(format!("rollout-2026-11-07T15-29-58-{id}.jsonl")), format!("{first}\n{{\"type\":\"event_msg\"}}\n")).unwrap();
        let meta = |provider: &str| format!(r#"{{"timestamp":"2026-11-07T15:29:58.000Z","type":"session_meta","payload":{{"id":"{id}","cli_version":"0.166.0","model_provider":"{provider}","base_instructions":"..."}}}}"#);
        crate::backends::codex::set_test_version(Some("0.166.0"));
        std::fs::write(codex.join("config.toml"), "model = \"gpt-6.1-sol\"\nmodel_provider = \"ust\"\n").unwrap();

        rollout(&meta("ust"));
        assert_eq!(line(id), resume(id), "same provider: the chat resumes");
        assert_eq!(crate::backends::codex::resume_refusal(&home, id), None);
        assert_eq!(resume_notice(wss, "cx", Some(id), None), None);

        rollout(&meta("amazon-bedrock-runtime"));
        assert_eq!(line(id), cmd, "a chat from another provider: fresh, never a dead resume");
        let why = crate::backends::codex::resume_refusal(&home, id).expect("the reason");
        assert!(why.contains("amazon-bedrock-runtime") && why.contains("ust"), "{why}");
        // The room's reason comes from the same choice (board #74 AC1).
        assert_eq!(resume_notice(wss, "cx", Some(id), None), Some(why.clone()));
        assert_eq!(resume_notice(wss, "cx", Some(id), Some("omp")), None, "a backend switch says its own line");

        // The managed profile can name the provider; it wins over config.toml.
        std::fs::write(codex.join(crate::backends::shared::codex_profile_file()), "model_provider = \"amazon-bedrock-runtime\"\n").unwrap();
        assert_eq!(line(id), resume(id), "the profile's provider is the current one");
        std::fs::remove_file(codex.join(crate::backends::shared::codex_profile_file())).unwrap();

        // No provider named anywhere: codex's default, openai.
        std::fs::write(codex.join("config.toml"), "model = \"gpt-6.1-sol\"\n").unwrap();
        rollout(&meta("openai"));
        assert_eq!(line(id), resume(id), "both on the default provider");
        std::fs::write(codex.join("config.toml"), "model_provider = \"ust\"\n").unwrap();

        // Cannot tell: resume as today (AC2).
        rollout("not json");
        assert_eq!(line(id), resume(id), "an unreadable session_meta resumes as before");
        rollout(r#"{"type":"session_meta","payload":{"id":"x"}}"#);
        assert_eq!(line(id), resume(id), "a session_meta without a provider resumes as before");
        std::fs::write(codex.join("config.toml"), "not = [toml").unwrap();
        rollout(&meta("amazon-bedrock-runtime"));
        assert_eq!(line(id), resume(id), "an unreadable config resumes as before");
        std::fs::write(codex.join("config.toml"), "model_provider = \"ust\"\n").unwrap();

        // The rule is codex's, measured on one version only.
        crate::backends::codex::set_test_version(Some("0.167.0"));
        assert_eq!(line(id), resume(id), "an unmeasured codex resumes as before");
        crate::backends::codex::set_test_version(None);
        assert_eq!(line(id), resume(id), "an unknown codex version resumes as before");
        crate::backends::codex::set_test_version(Some("0.166.0"));
        assert_eq!(line(id), cmd);
        crate::backends::codex::set_test_version(None);
    }
}
