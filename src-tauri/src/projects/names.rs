//! An agent's logical names (board #20): the facade over the store's
//! `agent_names` family and the one resolution/display (`address::Names`).
//!
//! Owner, 2026-11-05 13:25: "文件存储的是实际的路径，在前端页面展示以及聊天会
//! 话里的是逻辑上的名字，两者不冲突，可以有一个 metadata 来映射两者". The
//! PHYSICAL name (window, home, `TMM_AGENT`, recipe, every store key) is set
//! at spawn and never changed here; a rename changes only the label.

use super::*;
pub use crate::address::{Label, Names};

/// The names of `session`'s project. A store that cannot be read gives no
/// labels (every name is then its own), logged: an addressing door must not
/// fail because the display metadata is unreadable.
pub fn names(session: &str) -> Names {
    let read = || -> Result<Names, String> {
        let Some(project) = project_for_session(session)? else { return Ok(Names::default()) };
        Ok(Names::new(with_store(|s| s.agent_names(&project.id))?))
    };
    read().unwrap_or_else(|e| {
        eprintln!("names: {session}: agent labels unreadable, names shown as they are: {e}");
        Names::default()
    })
}

/// The physical name `name` addresses in `session`'s project (the ONE
/// resolution, at every door): itself unless it is a label or previous label.
pub fn resolve(session: &str, name: &str) -> String {
    names(session).resolve(name).to_string()
}

/// Every PHYSICAL agent name in the project: its managed homes, its slots
/// and its live windows. A label may be none of them but its own agent's.
fn physical_names(session: &str, project: &store::Project) -> Result<Vec<String>, String> {
    let mut out = managed_names_in(&project.path)?;
    out.extend(with_store(|s| s.slots(&project.id))?.into_iter().map(|s| s.window_name));
    out.extend(crate::tmux::list_panes(session).unwrap_or_default().into_iter().map(|p| p.window_name));
    Ok(out)
}

/// Rename `agent` (any of its names) in `session`'s project to `label`, or
/// back to its physical name with None. Nothing is re-keyed, moved or
/// restarted. Returns its names after the change and tells every open client
/// (`agent_renamed`).
pub fn rename(session: &str, agent: &str, label: Option<&str>) -> Result<Label, String> {
    let project = project_for_session(session)?.ok_or_else(|| format!("no project for session '{session}'"))?;
    let agent = names(session).resolve(agent).to_string();
    if !is_managed_in(Some(&project.path), &agent) {
        return Err(format!("'{agent}' is not an agent of project '{}'", project.name));
    }
    if let Some(l) = label.filter(|l| *l != agent) {
        agents::valid_name(l)?;
        if crate::address::is_routing_word(l) {
            return Err(format!("'{l}' is reserved: it addresses everyone or the person, not an agent"));
        }
        // The system's own sender (`[tmm chat …] tmm: …`, the room's notices;
        // round 1 P2): a label equal to it would make the agent's lines read
        // as the system's.
        if l.eq_ignore_ascii_case("tmm") {
            return Err(format!("'{l}' is reserved: it is the system's sender, and an agent shown as it would read as the system"));
        }
        if physical_names(session, &project)?.iter().any(|p| p == l) {
            return Err(format!("'{l}' is the name of agent '{l}' in this project"));
        }
    }
    with_store(|s| s.set_agent_label(&project.id, &agent, label, now()))?;
    let after = with_store(|s| s.agent_names(&project.id))?
        .into_iter()
        .find(|l| l.agent == agent)
        .unwrap_or_else(|| Label { agent: agent.clone(), label: agent.clone(), aliases: Vec::new() });
    let _ = events().send(serde_json::json!({ "session": project.session, "agent": after.agent, "label": after.label, "aliases": after.aliases }).to_string());
    Ok(after)
}

/// The `agent_renamed` fan-out for the WS push path, like the room's
/// (`rooms::subscribe`): one pre-serialized `{session, agent, label,
/// aliases}` per rename.
fn events() -> &'static tokio::sync::broadcast::Sender<String> {
    static TX: std::sync::OnceLock<tokio::sync::broadcast::Sender<String>> = std::sync::OnceLock::new();
    TX.get_or_init(|| tokio::sync::broadcast::channel(64).0)
}

pub fn subscribe() -> tokio::sync::broadcast::Receiver<String> {
    events().subscribe()
}

#[cfg(test)]
mod tests {
    use super::super::tests::use_test_store;
    use super::*;

    /// A project in the test store whose workspace holds managed homes for
    /// `agents` (the launch.json marker), on a session no tmux has.
    fn project_with(tag: &str, agents: &[&str]) -> String {
        use_test_store();
        let ws = crate::config::test_scratch(&format!("tmm-names-{tag}"));
        for a in agents {
            let home = ws.join(".tmm/agents").join(a);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), "{}").unwrap();
        }
        let session = format!("names-{tag}-{}", std::process::id());
        let p = store::Project {
            id: session.clone(), name: session.clone(), path: ws.to_string_lossy().into_owned(), icon: None, session: session.clone(),
            adopted: false, autostart: false, created_at: 1, last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        };
        with_store(|s| s.insert_project(&p)).unwrap();
        session
    }

    /// Board #20: rename, rename again, reset; the agent may be named by any
    /// of its names; every old name keeps resolving.
    #[test]
    fn a_rename_and_a_reset_and_every_name_resolves() {
        let s = project_with("rename", &["builder", "validator"]);
        let l = rename(&s, "builder", Some("bob")).unwrap();
        assert_eq!((l.agent.as_str(), l.label.as_str()), ("builder", "bob"));
        let l = rename(&s, "bob", Some("robert")).unwrap();
        assert_eq!(l, Label { agent: "builder".into(), label: "robert".into(), aliases: vec!["bob".into()] }, "named by its current label");
        for n in ["builder", "bob", "robert"] {
            assert_eq!(resolve(&s, n), "builder", "{n}");
        }
        let l = rename(&s, "robert", None).unwrap();
        assert_eq!(l, Label { agent: "builder".into(), label: "builder".into(), aliases: vec!["bob".into(), "robert".into()] });
        assert_eq!(names(&s).shown("bob"), "builder", "after a reset an old label shows the physical name");
        assert_eq!(resolve(&s, "validator"), "validator");
    }

    /// Board #20 (orchestrator 13:35): removing an agent frees its labels. A
    /// later agent spawned with the same physical name inherits none: its
    /// old label no longer resolves to it, and it is shown by its own name.
    #[test]
    fn a_removed_agents_labels_do_not_follow_its_physical_name() {
        let s = project_with("removed", &["builder"]);
        rename(&s, "builder", Some("coder")).unwrap();
        assert_eq!(resolve(&s, "coder"), "builder");
        agent_remove(&s, "builder").expect("removed");
        let ws = project_for_session(&s).unwrap().unwrap().path;
        let home = std::path::Path::new(&ws).join(".tmm/agents/builder");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), "{}").unwrap();
        assert_eq!(resolve(&s, "coder"), "coder", "the old label reaches nobody");
        assert_eq!(names(&s).shown("builder"), "builder");
        rename(&s, "builder", Some("coder")).expect("the label is free again");
    }

    /// Board #20: a label is refused when it is not a valid name, a reserved
    /// word, another agent's physical name, current label or previous label;
    /// and the agent must be one of this project's. Each says why and
    /// writes nothing.
    #[test]
    fn a_colliding_or_invalid_label_is_refused_with_its_reason() {
        let s = project_with("collide", &["builder", "validator"]);
        rename(&s, "validator", Some("val")).unwrap();
        rename(&s, "validator", Some("vera")).unwrap();
        let refused = |label: &str| rename(&s, "builder", Some(label)).unwrap_err();
        assert_eq!(refused("validator"), "'validator' is the name of agent 'validator' in this project");
        assert_eq!(refused("vera"), "'vera' is already a name of agent 'validator' in this project");
        assert_eq!(refused("val"), "'val' is already a name of agent 'validator' in this project", "a previous label stays reserved");
        for reserved in ["all", "human", "ALL", "Human"] {
            assert_eq!(refused(reserved), format!("'{reserved}' is reserved: it addresses everyone or the person, not an agent"));
        }
        for system in ["tmm", "TMM"] {
            assert_eq!(refused(system), format!("'{system}' is reserved: it is the system's sender, and an agent shown as it would read as the system"));
        }
        assert!(refused("has space").contains("agent name"), "the agent-name validation: {}", refused("has space"));
        assert!(refused("").contains("must not be empty"));
        assert_eq!(rename(&s, "ghost", Some("g")).unwrap_err(), format!("'ghost' is not an agent of project '{s}'"));
        assert_eq!(names(&s).shown("builder"), "builder", "nothing was written for builder");
    }
}
