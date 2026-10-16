//! A running agent's model, effort and conversation, changed without a restart
//! (board #411, owner 2026-10-17: "应该支持一些slash command 比如切换模型之类的").
//!
//! This is the backend-neutral half. A backend that reads its config at the
//! start of EVERY turn (`Backend::config_read_every_turn`: dsh, whose turns are
//! fresh processes) takes a saved model or effort with no restart, where the
//! other CLIs read their config once and `refresh_agent` applies a saved model
//! on restart. What a backend does with the values (`write_live_config`), which
//! slash commands the app runs for it and how it parses their arguments
//! (`app_command`), and how it leaves a conversation (`new_conversation`) are
//! its own file's; this module resolves WHICH definition a window follows,
//! saves it through the registry's door, and projects it into the homes.
//!
//! The projection happens in `registry_save` and `teams_save` themselves, so the
//! Agents editor, `tmm registry save` and the commands are one path. It is
//! reported, never assumed: a home that could not be updated is returned with
//! its error, the definition stays saved, and the caller says which is which.

use serde_json::Value;
use std::path::Path;

use super::recipe::recipe_section;
use super::spawn::{agent_home, effective_def_kind, provenance_of, recipe_provenance, team_defining, MemberKind};
use crate::backends::{AppCommand, Backend, LiveWrite};

/// What a window's LIVE-published fields derive from — the fields the live
/// writer projects into a running home: the model, the effort and (board #412)
/// the MCP servers. The registry definitions it reads them from (with which it
/// inherits rather than overrides), and the team path when a team defines it.
/// This is provenance, not a display label: it decides whether a failed home
/// belongs to a given change. Skills are not live-published (their links are
/// the render's, applied at restart), so no change of them is attributed here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lineage {
    pub bases: Vec<Base>,
    /// `false`: the team or member could not be resolved, so what the window
    /// derives from is NOT known (distinct from a member with no base). An
    /// unresolved lineage is never ruled out of a definition change.
    pub resolved: bool,
    /// The team path (`crew`, `crew/review`) of a team member or a fork of one;
    /// empty for a solo agent.
    pub team: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Base {
    pub name: String,
    pub model: bool,
    pub effort: bool,
    /// The MCP list: a member derived from a base always takes the base's
    /// (`teams::member_def` has no MCP override), a solo agent its own.
    pub mcp: bool,
}

/// What was saved, for deciding which failed homes it concerns.
pub enum Change<'a> {
    /// A registry definition, and which of its live-published fields the save
    /// may have changed: a whole-definition save all of them, a field update
    /// (`/model`, `/effort`) only its own.
    Definition { name: &'a str, model: bool, effort: bool, mcp: bool },
    /// A team (its members, their overrides and bases).
    Team(&'a str),
}

impl Lineage {
    /// The name that scopes reporting: `team <path>` for a team member or a
    /// fork, else the registry definition the window follows.
    fn label(&self, window: &str) -> String {
        match (self.team.is_empty(), self.bases.first()) {
            (false, _) => format!("team {}", self.team),
            (true, Some(base)) => base.name.clone(),
            (true, None) => window.to_string(),
        }
    }

    fn affected_by(&self, change: &Change) -> bool {
        match change {
            Change::Definition { name, model, effort, mcp } => !self.resolved || self.bases.iter().any(|b| b.name == *name && ((*model && b.model) || (*effort && b.effort) || (*mcp && b.mcp))),
            Change::Team(team) => self.team.split('/').any(|segment| segment == *team),
        }
    }
}

/// A home that could not be brought to the saved definition, or whose state
/// could not be confirmed, with the identity that scopes it: the PROJECT (two
/// projects may both have a window of the same name), the window, and its
/// lineage. `window` is empty for a failure of discovery (a project's agents
/// could not be listed, the projects could not be listed), which belongs to no
/// one window.
#[derive(Debug, Clone)]
pub struct Unapplied {
    pub project: String,
    pub window: String,
    /// `failed`: the write was attempted or the definition is invalid.
    /// `unknown`: what the home runs could not be confirmed.
    pub kind: &'static str,
    /// `None`: the recipe could not be read, so what the window follows is not
    /// known; no change can be ruled out.
    pub lineage: Option<Lineage>,
    pub error: String,
}

impl Unapplied {
    /// The lineage's label; empty when unknown.
    pub fn definition(&self) -> String {
        self.lineage.as_ref().map(|l| l.label(&self.window)).unwrap_or_default()
    }
}

/// The ONE rule for which failed homes a change concerns, shared by definition
/// saves, team saves and the slash commands: a home whose lineage depends on the
/// change, and what cannot be placed at all (an unreadable recipe, a failed
/// discovery): those cannot be ruled out, so they are said.
pub fn affected(u: &Unapplied, change: &Change) -> bool {
    u.lineage.as_ref().is_none_or(|l| l.affected_by(change))
}

/// What projecting one window came to. Nothing here is inferred from the
/// absence of an error: a home that could not be inspected is `Unknown`, not
/// applied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The home's config was rewritten.
    Applied,
    /// Already the saved definition's text.
    AlreadyCurrent,
    /// Not a window this concerns: another backend, no dsh home.
    NotApplicable,
    /// A dsh home that could not be inspected or has no config to update: its
    /// recipe is unreadable, its definition cannot be resolved, it was never
    /// rendered. What it runs is not known.
    Unknown(String),
    /// The write was attempted and failed, or its definition is invalid.
    Failed(String),
}

/// What the window's model and effort derive from (see `Lineage`), from the
/// member the effective definition itself resolved (`MemberKind`): a solo agent
/// from its own registry definition; a team member or a fork of one from its
/// team and the registry base it inherits, if any; a member whose team could not
/// be resolved from nothing known.
fn lineage_of(p: &super::spawn::Provenance, kind: MemberKind, window_name: &str) -> Lineage {
    let team = team_defining(p).unwrap_or_default();
    match kind {
        MemberKind::NotTeam => {
            let name = if p.agent_def.is_empty() { window_name.to_string() } else { p.agent_def.clone() };
            Lineage { team, resolved: true, bases: vec![Base { name, model: true, effort: true, mcp: true }] }
        }
        MemberKind::Inline => Lineage { team, resolved: true, bases: Vec::new() },
        MemberKind::Based { base, model_inherited, effort_inherited } => Lineage { team, resolved: true, bases: vec![Base { name: base, model: model_inherited, effort: effort_inherited, mcp: true }] },
        MemberKind::Unresolved => Lineage { team, resolved: false, bases: Vec::new() },
    }
}

/// Project one managed window's EFFECTIVE definition (the one a restart would
/// give it: a solo definition, a team member, a fork) into its home, and say
/// what came of it. The recipe section is held from the read of the recipe
/// through the resolution of the definition to the write, exactly as
/// `refresh_agent` holds it: a restart or a spawn that renders the same home is
/// waited for and kept, and an older projection cannot finish after a newer
/// one. The file is replaced whole (`write_atomic`), so a turn starting
/// meanwhile reads the old or the new document, never half of one.
pub(crate) fn project_window(project_path: &str, window_name: &str) -> (Outcome, Option<Lineage>) {
    let home = agent_home(project_path, window_name);
    let section = recipe_section(&home);
    // A home with a live backend's rendered files belongs to it even when its recipe cannot say
    // so: that one is Unknown, any other is not ours to report on.
    let dsh_home = Backend::ALL.iter().any(|b| b.config_read_every_turn() && b.has_rendered_files(&home));
    let recipe = match section.read() {
        Ok(Some(recipe)) => recipe,
        Ok(None) => return (if dsh_home { Outcome::Unknown("it has no launch recipe".into()) } else { Outcome::NotApplicable }, None),
        Err(e) => return (if dsh_home { Outcome::Unknown(e) } else { Outcome::NotApplicable }, None),
    };
    let Some(backend) = recipe.get("backend").and_then(Value::as_str).and_then(Backend::parse).filter(|b| b.config_read_every_turn()) else {
        return (Outcome::NotApplicable, None);
    };
    let p = provenance_of(&recipe);
    let (resolved_def, member) = effective_def_kind(project_path, window_name, &p);
    let lineage = Some(lineage_of(&p, member, window_name));
    let Some(def) = resolved_def else {
        return (Outcome::Unknown("its definition could not be resolved (deleted, or its team is gone)".into()), lineage);
    };
    if Backend::parse(&def.backend) != Some(backend) {
        return (Outcome::NotApplicable, lineage);
    }
    if let Err(e) = super::models::validate(&def.backend, &def.model).and_then(|_| super::models::validate_effort(&def.backend, &def.effort)) {
        return (Outcome::Failed(format!("its definition is not valid: {e}")), lineage);
    }
    let outcome = match backend.write_live_config(&home, &def) {
        Some(Ok(LiveWrite::Written)) => Outcome::Applied,
        Some(Ok(LiveWrite::AlreadyCurrent)) => Outcome::AlreadyCurrent,
        Some(Ok(LiveWrite::NoConfig)) => Outcome::Unknown("it has no profile yet (never rendered), so nothing is known about what it runs".into()),
        Some(Err(e)) => Outcome::Failed(e),
        None => Outcome::NotApplicable,
    };
    (outcome, lineage)
}

/// Project every managed window of every project (a save of a definition, or
/// of a team that has such members, may change any of them), and return what
/// could not be brought to it: failed writes, homes that could not be
/// inspected, and the failures of discovery itself. A listing that fails is a
/// failure, not an empty list.
pub fn rerender_all() -> Vec<Unapplied> {
    let projects = match super::with_store(|store| store.list_projects(true)) {
        Ok(p) => p,
        Err(e) => return vec![Unapplied { project: String::new(), window: String::new(), kind: "unknown", lineage: None, error: format!("the projects could not be listed: {e}") }],
    };
    let mut unapplied = Vec::new();
    for project in projects {
        let agents = Path::new(&project.path).join(".tmm").join("agents");
        let entries = match std::fs::read_dir(&agents) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                unapplied.push(Unapplied { project: project.path.clone(), window: String::new(), kind: "unknown", lineage: None, error: format!("{}: {e}", agents.display()) });
                continue;
            }
        };
        for entry in entries.flatten() {
            let Some(window) = entry.file_name().to_str().map(str::to_string) else { continue };
            let (outcome, lineage) = project_window(&project.path, &window);
            match outcome {
                Outcome::Failed(error) => unapplied.push(Unapplied { project: project.path.clone(), window, kind: "failed", lineage, error }),
                Outcome::Unknown(error) => unapplied.push(Unapplied { project: project.path.clone(), window, kind: "unknown", lineage, error }),
                Outcome::Applied | Outcome::AlreadyCurrent | Outcome::NotApplicable => {}
            }
        }
    }
    unapplied
}

/// The backend a window's launch recipe records.
fn recipe_backend(project_path: &str, window_name: &str) -> Option<Backend> {
    let text = std::fs::read_to_string(agent_home(project_path, window_name).join("launch.json")).ok()?;
    Backend::parse(serde_json::from_str::<Value>(&text).ok()?.get("backend")?.as_str()?)
}

/// What a command came to, for the room line.
pub struct Done {
    /// What the window will do from its next turn.
    pub message: String,
    /// OTHER windows of the same definition that could not be updated
    /// (`window: error`); the definition is saved for them all. Windows of other
    /// definitions, other projects' unrelated failures and discovery failures
    /// are not this command's and are not here.
    pub others_unapplied: Vec<String>,
}

/// Run an app command for the managed window `window_name`. A model or effort
/// change is saved on the definition the window follows (field-specific, so
/// nothing else of it is touched) and then CONFIRMED on this very home
/// (`project_window`, not "no failure was listed"): anything but applied or
/// already-current fails the command, naming what is saved and how to retry.
pub fn run(project_path: &str, window_name: &str, backend: Backend, command: AppCommand) -> Result<Done, String> {
    if recipe_backend(project_path, window_name) != Some(backend) {
        return Err(format!("'{window_name}' is not a {} agent of this app", backend.name()));
    }
    let home = agent_home(project_path, window_name);
    let (field_model, field_effort, what) = match &command {
        AppCommand::Model(v) => (Some(v.as_str()), None, format!("model {v}")),
        AppCommand::Effort(v) => (None, Some(v.as_str()), format!("effort {v}")),
        AppCommand::NewConversation => {
            let had = backend.new_conversation(&home)?;
            let message = if had { "the next line starts a new conversation" } else { "no conversation to leave: the next line starts a new one" };
            return Ok(Done { message: message.into(), others_unapplied: Vec::new() });
        }
    };
    let p = recipe_provenance(project_path, window_name).ok_or_else(|| format!("'{window_name}' has no readable launch recipe"))?;
    if let Some(team) = team_defining(&p) {
        return Err(format!("'{window_name}' belongs to team '{team}': its model and effort come from the team's member, change them there"));
    }
    let def_name = if p.agent_def.is_empty() { window_name } else { p.agent_def.as_str() };
    if super::registry_get(def_name)?.is_none() {
        return Err(format!("the definition '{def_name}' behind '{window_name}' is gone"));
    }
    let saved = super::registry_set_model_effort(def_name, field_model, field_effort)?;
    // This home, confirmed on its own: the save's list proves nothing about a
    // home it never reached.
    match project_window(project_path, window_name).0 {
        Outcome::Applied | Outcome::AlreadyCurrent => {}
        Outcome::Failed(error) => {
            return Err(format!(
                "{what} is saved on the definition '{def_name}', but '{window_name}' still runs the old one: its profile could not be updated ({error}); send the command again to retry, or restart the agent"
            ));
        }
        // What this home runs is not known (an unreadable recipe, never rendered): no claim of an old model.
        Outcome::Unknown(error) => {
            return Err(format!(
                "{what} is saved on the definition '{def_name}'; application not confirmed for '{window_name}' ({error}); send the command again to retry, or restart the agent"
            ));
        }
        Outcome::NotApplicable => return Err(format!("'{window_name}' is not a {} agent of this app", backend.name())),
    }
    // Every other home this change concerns (`registry::project_live_config`
    // applied the one `affected` rule: the same definition, a team member that
    // inherits from it, and what cannot be placed), never the target itself.
    let others = saved.get("unapplied").and_then(Value::as_array).into_iter().flatten()
        .filter(|u| !(u["project"].as_str() == Some(project_path) && u["window"].as_str() == Some(window_name)))
        .map(|u| {
            let (window, project, error) = (u["window"].as_str().unwrap_or(""), u["project"].as_str().unwrap_or(""), u["error"].as_str().unwrap_or(""));
            let window = if window.is_empty() { "(discovery)" } else { window };
            let kind = if u["kind"] == "unknown" { " (not confirmed)" } else { "" };
            if project == project_path { format!("{window}{kind}: {error}") } else { format!("{window}{kind} in {project}: {error}") }
        })
        .collect();
    Ok(Done { message: format!("{what} from the next turn"), others_unapplied: others })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A workspace with one project row and managed dsh homes in it: a window is
    /// a rendered home plus the recipe `spawn` writes (`backend`, `agent_def`,
    /// the team fields), which is all `rerender_profile` and `command` read.
    struct Ws {
        path: String,
    }

    impl Ws {
        fn new(tag: &str) -> Ws {
            super::super::tests::use_test_store();
            let dir = std::env::temp_dir().join(format!("tmm-dshlive-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let id = format!("p-{}", uuid::Uuid::new_v4());
            super::super::with_store(|s| {
                s.insert_project(&super::super::Project {
                    id: id.clone(), name: id.clone(), path: dir.to_string_lossy().to_string(), icon: None, session: id.clone(),
                    adopted: false, autostart: false, created_at: 1, last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
                })
            })
            .unwrap();
            Ws { path: dir.to_string_lossy().to_string() }
        }

        fn def(&self, name: &str, model: &str, effort: &str) {
            super::super::registry_save(&json!({ "name": name, "backend": "dsh", "model": model, "effort": effort, "system": "Persona.", "skills": "[]", "mcp": "[]" })).unwrap();
        }

        /// A running window of definition `def`, rendered from its current text.
        fn window(&self, window: &str, backend: &str, def: &str, team: &str) {
            let home = agent_home(&self.path, window);
            std::fs::create_dir_all(&home).unwrap();
            if backend == "dsh" {
                let reg = super::super::registry_get(def).unwrap().expect("saved def");
                crate::backends::dsh::render_dsh(&reg, window, &home, "Persona.", &[]).unwrap();
            }
            std::fs::write(home.join("launch.json"), json!({ "backend": backend, "agent_def": def, "team": team, "member": if team.is_empty() { "" } else { "m" } }).to_string()).unwrap();
        }

        fn patch(&self, window: &str) -> String {
            std::fs::read_to_string(agent_home(&self.path, window).join("dsh/profiles/tmm/cordis.patch.yml")).unwrap_or_default()
        }
    }

    impl Drop for Ws {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn model_of(patch: &str) -> String {
        patch.lines().find_map(|l| l.trim().strip_prefix("model: ")).unwrap_or("").trim_matches('"').to_string()
    }

    fn command(ws: &Ws, window: &str, name: &str, args: &str) -> Result<Done, String> {
        let b = Backend::Dsh;
        b.app_command(name, args).ok_or_else(|| format!("{name} is not a dsh command"))?.and_then(|c| run(&ws.path, window, b, c))
    }

    fn running_as_root() -> bool {
        unsafe { libc::geteuid() == 0 }
    }

    /// Board #411: saving a dsh definition re-renders the profile of every
    /// running window it defines, with no restart — the editor and `tmm registry
    /// save` take this door as `/model` does. Other windows are left alone.
    #[test]
    fn saving_a_dsh_definition_rerenders_its_running_windows_and_no_others() {
        let ws = Ws::new("save");
        let (a, other) = ("dl-save-a", "dl-save-other");
        ws.def(a, "deepseek-flash", "");
        ws.def(other, "deepseek-flash", "");
        ws.window("one", "dsh", a, "");
        ws.window("two", "dsh", a, "");                    // a second window of the same def (a uniquified spawn)
        ws.window("else", "dsh", other, "");
        ws.window("kiro-w", "kiro", a, "");                 // not a dsh window: no profile, never written
        ws.window("member", "dsh", a, "ghost-team");        // a team member: its def comes from the team (gone here)
        let member_before = ws.patch("member");

        ws.def(a, "deepseek-v4-pro", "max");
        for w in ["one", "two"] {
            assert_eq!(model_of(&ws.patch(w)), "deepseek-v4-pro", "{w}");
            assert!(ws.patch(w).contains("reasoningEffort: \"max\""), "{w}");
        }
        assert_eq!(model_of(&ws.patch("else")), "deepseek-flash", "another definition's window is untouched");
        assert_eq!(ws.patch("member"), member_before, "a team member follows its team, not this save");
        assert!(!agent_home(&ws.path, "kiro-w").join("dsh").exists(), "a kiro window gets no dsh files");

        // The definition goes back; the windows follow, with no other file touched.
        let agents_md = agent_home(&ws.path, "one").join("dsh/AGENTS.md");
        std::fs::write(&agents_md, "edited under the running agent").unwrap();
        ws.def(a, "deepseek-flash", "");
        assert_eq!(model_of(&ws.patch("one")), "deepseek-flash");
        assert!(!ws.patch("one").contains("reasoningEffort"));
        assert_eq!(std::fs::read_to_string(&agents_md).unwrap(), "edited under the running agent", "only the patch layer is re-rendered");

        // The plugin and the privacy settings of the patch are kept by every projection.
        for needle in ["tmm-telemetry", "session-title-llm", "session-log-deepseek", "plugin-package-inventory-deepseek"] {
            assert!(ws.patch("one").contains(needle), "{needle}");
        }

        // An invalid effort is refused by the same validation as the editor, and nothing is written.
        let before = ws.patch("one");
        let err = super::super::registry_save(&json!({ "name": a, "backend": "dsh", "model": "", "effort": "medium", "system": "", "skills": "[]", "mcp": "[]" })).unwrap_err();
        assert!(err.contains("effort"), "{err}");
        // So is a model id with the wrong syntax, by the shared door the command uses.
        let err = super::super::registry_save(&json!({ "name": a, "backend": "dsh", "model": "x;y", "effort": "", "system": "", "skills": "[]", "mcp": "[]" })).unwrap_err();
        assert!(err.contains("not a dsh model id"), "{err}");
        assert_eq!(ws.patch("one"), before);
        for n in [a, other] { super::super::registry_delete(n).ok(); }
    }

    /// The commands change the definition and the next turn's profile; the
    /// refusals say what to do and change nothing.
    #[test]
    fn the_commands_change_the_definition_and_the_next_turns_profile() {
        let ws = Ws::new("cmd");
        let a = "dl-cmd-a";
        ws.def(a, "", "");
        ws.window("d1", "dsh", a, "");
        ws.window("t1", "dsh", a, "some-team");           // a member of a team: team + member
        ws.window("k1", "kiro", a, "");
        let get = || super::super::registry_get(a).unwrap().unwrap();

        assert!(command(&ws, "d1", "/model", "deepseek-v4-pro").unwrap().message.contains("from the next turn"));
        assert_eq!(model_of(&ws.patch("d1")), "deepseek-v4-pro");
        assert_eq!(get().model, "deepseek-v4-pro", "the definition is the declaration");
        command(&ws, "d1", "/effort", "low").unwrap();
        assert!(ws.patch("d1").contains("reasoningEffort: \"low\""));
        assert_eq!((get().model.as_str(), get().effort.as_str()), ("deepseek-v4-pro", "low"), "each command keeps the other field");

        for (n, args, needle) in [
            ("/effort", "medium", "effort"), ("/effort", "", "usage"), ("/model", "", "usage"), ("/model", "a b", "usage"),
            ("/model", "x;y", "not a dsh model id"), ("/new", "now", "usage"), ("/compact", "", "not a dsh command"),
        ] {
            let err = command(&ws, "d1", n, args).err().unwrap();
            assert!(err.contains(needle), "{n} {args}: {err}");
        }
        assert_eq!(model_of(&ws.patch("d1")), "deepseek-v4-pro", "a refusal changes nothing");
        assert!(command(&ws, "t1", "/model", "deepseek-flash").err().unwrap().contains("belongs to team"), "a team member's model is the team's");
        assert!(command(&ws, "k1", "/model", "x").err().unwrap().contains("not a dsh agent"));
        assert!(command(&ws, "nope", "/model", "x").err().unwrap().contains("not a dsh agent"));

        // /new: the request outlives a deletion; saying it twice is harmless.
        let state = agent_home(&ws.path, "d1").join("dsh/tmm");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("session"), "session-abc").unwrap();
        assert!(command(&ws, "d1", "/new", "").unwrap().message.contains("new conversation"));
        assert!(state.join("session").exists() && state.join("new").exists(), "the command writes only the marker; the shell owns the session cleanup");
        assert!(command(&ws, "d1", "/new", "").is_ok());
        // While a turn runs (the shell's `open` marker) /new is refused and writes nothing.
        std::fs::remove_file(state.join("new")).unwrap();
        std::fs::write(state.join("open"), "").unwrap();
        assert!(command(&ws, "d1", "/new", "").err().unwrap().contains("wait for it to end"));
        assert!(!state.join("new").exists());
        super::super::registry_delete(a).ok();
    }

    /// Review P2-E: a runtime-JOINED solo agent has a `team` (membership,
    /// board #113) but no `member`: it follows its own definition, exactly as
    /// `effective_def` resolves it, so the command applies; only a window
    /// whose definition IS a team member's (or a fork of one) is refused.
    #[test]
    fn a_joined_solo_agent_follows_its_own_definition_a_team_member_does_not() {
        let ws = Ws::new("joined");
        let a = "dl-joined-a";
        ws.def(a, "", "");
        ws.window("solo", "dsh", a, "");
        let home = agent_home(&ws.path, "solo");
        std::fs::write(home.join("launch.json"), json!({ "backend": "dsh", "agent_def": a, "team": "crew", "member": "" }).to_string()).unwrap();   // joined crew, still solo
        ws.window("fork", "dsh", a, "");
        std::fs::write(agent_home(&ws.path, "fork").join("launch.json"), json!({ "backend": "dsh", "agent_def": "", "from_member": "team/path/m" }).to_string()).unwrap();
        command(&ws, "solo", "/model", "deepseek-v4-pro").unwrap();
        assert_eq!(model_of(&ws.patch("solo")), "deepseek-v4-pro");
        assert!(command(&ws, "fork", "/model", "x").err().unwrap().contains("belongs to team 'team/path'"));
        super::super::registry_delete(a).ok();
    }

    /// Review P1-A: a projection that fails is REPORTED. The definition stays
    /// saved; the save's answer names the windows that still run the old one
    /// and why; a command for such a window fails (saying what is saved and how
    /// to retry) instead of recording success; the windows that could be
    /// updated were. Partial application across homes.
    #[test]
    fn a_failed_projection_is_reported_and_partial_application_is_visible() {
        if running_as_root() {
            eprintln!("skipped: root writes through a read-only directory");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let ws = Ws::new("fail");
        let a = "dl-fail-a";
        ws.def(a, "deepseek-flash", "");
        for w in ["good", "bad"] { ws.window(w, "dsh", a, ""); }
        let bad_profile = agent_home(&ws.path, "bad").join("dsh/profiles/tmm");
        std::fs::set_permissions(&bad_profile, std::fs::Permissions::from_mode(0o555)).unwrap();   // the rename into it fails

        let saved = super::super::registry_save(&json!({ "name": a, "backend": "dsh", "model": "deepseek-v4-pro", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let unapplied = saved["unapplied"].as_array().expect("the failure is in the answer");
        assert_eq!(unapplied.len(), 1, "{saved}");
        assert_eq!((unapplied[0]["window"].as_str(), unapplied[0]["definition"].as_str(), unapplied[0]["project"].as_str()), (Some("bad"), Some(a), Some(ws.path.as_str())), "the entry names project, window and definition: {saved}");
        assert!(unapplied[0]["error"].as_str().unwrap().contains("cordis.patch.yml"), "{saved}");
        assert_eq!(super::super::registry_get(a).unwrap().unwrap().model, "deepseek-v4-pro", "the declaration is saved");
        assert_eq!(model_of(&ws.patch("good")), "deepseek-v4-pro", "the home that could be updated was");
        assert_eq!(model_of(&ws.patch("bad")), "deepseek-flash", "the other still runs the old one, and the answer says so");

        // The command for the failing window fails honestly; for the good one it succeeds and says the other is not updated.
        let err = command(&ws, "bad", "/model", "deepseek-next").err().expect("no success for a window that still runs the old model");
        assert!(err.contains("is saved on the definition") && err.contains("send the command again") && err.contains("could not be updated"), "{err}");
        let done = command(&ws, "good", "/effort", "high").unwrap();
        assert_eq!(done.others_unapplied.len(), 1, "{}", done.message);
        assert!(done.others_unapplied[0].starts_with("bad: "));

        // Retry after the cause is gone: the next save reaches it.
        std::fs::set_permissions(&bad_profile, std::fs::Permissions::from_mode(0o755)).unwrap();
        let saved = super::super::registry_save(&json!({ "name": a, "backend": "dsh", "model": "deepseek-v4-pro", "effort": "high", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        assert!(saved.get("unapplied").is_none(), "{saved}");
        assert_eq!(model_of(&ws.patch("bad")), "deepseek-v4-pro");
        super::super::registry_delete(a).ok();
    }

    /// Review P1-B: the projection takes the home's recipe section, the one a
    /// restart's `refresh_agent` holds over resolve + render. While another
    /// holder has it the projection WAITS (so an older one cannot finish after a
    /// newer), then reads the definition as it is NOW.
    #[test]
    fn a_projection_waits_for_the_homes_recipe_section_and_then_reads_the_current_definition() {
        let ws = Ws::new("section");
        let a = "dl-section-a";
        ws.def(a, "deepseek-flash", "");
        ws.window("w", "dsh", a, "");
        let home = agent_home(&ws.path, "w");
        let held = recipe_section(&home);                                    // a restart rendering this home
        let (tx, rx) = std::sync::mpsc::channel();
        let saver = std::thread::spawn(move || {
            let r = super::super::registry_save(&json!({ "name": "dl-section-a", "backend": "dsh", "model": "deepseek-v4-pro", "effort": "", "system": "Persona.", "skills": "[]", "mcp": "[]" }));
            tx.send(r.is_ok()).unwrap();
        });
        // Observed, not slept for: the projection is registered as blocked on THIS home's section.
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while super::super::recipe::recipe_waiters(&home) == 0 {
            assert!(std::time::Instant::now() < until, "the projection never reached the held section");
            std::thread::yield_now();
        }
        assert!(rx.try_recv().is_err(), "the projection is waiting for the section");
        assert_eq!(model_of(&ws.patch("w")), "deepseek-flash", "and has written nothing");
        // While it waits, the definition moves on again (written straight to the store: a save
        // would itself project, and wait for the section this test holds): the projection must
        // use the latest, not the text it was started with.
        let mut newer = super::super::registry_get(a).unwrap().unwrap();
        newer.model = "deepseek-flash".into();
        newer.effort = "low".into();
        super::super::with_store(|s| s.reg_save(&newer, 2)).unwrap();
        drop(held);
        assert!(rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap());
        saver.join().unwrap();
        let patch = ws.patch("w");
        let def = super::super::registry_get(a).unwrap().unwrap();
        assert_eq!((model_of(&patch).as_str(), def.model.as_str()), ("deepseek-flash", "deepseek-flash"), "the patch is the definition as it is now, not the one the save started with: {patch}");
        assert!(patch.contains("reasoningEffort: \"low\""), "{patch}");
        super::super::registry_delete(a).ok();
    }

    /// Review P1-C: a field update reads the CURRENT row in the section that
    /// writes it, so /model and /effort racing each other keep BOTH changes.
    /// Deterministic: the /model update is held inside its store section, after
    /// its read and before its write; the /effort update is observed blocked on
    /// the store (it cannot read an old row, nor write between), and only then
    /// is the first released. A read and a write in separate sections would let
    /// the second finish while the first is held and fail the wait.
    #[test]
    fn field_updates_never_restore_an_earlier_snapshot() {
        use std::sync::atomic::Ordering::SeqCst;
        let ws = Ws::new("race");
        let a = "dl-race-a";
        ws.def(a, "", "");
        let (paused_tx, paused_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        *super::super::registry::FIELD_UPDATE_PAUSE.lock().unwrap() = Some(Box::new(move || {
            paused_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        }));
        let t_model = std::thread::spawn(move || super::super::registry_set_model_effort(a, Some("deepseek-v4-pro"), None).unwrap());
        paused_rx.recv_timeout(std::time::Duration::from_secs(10)).expect("the model update reached its pause inside the store section");
        let t_effort = std::thread::spawn(move || super::super::registry_set_model_effort(a, None, Some("low")).unwrap());
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while super::super::tests::STORE_WAITING.load(SeqCst) == 0 {
            assert!(!t_effort.is_finished(), "the effort update finished while the model update was held inside its section");
            assert!(std::time::Instant::now() < until, "the effort update never waited on the store");
            std::thread::yield_now();
        }
        release_tx.send(()).unwrap();
        t_model.join().unwrap();
        t_effort.join().unwrap();
        let end = super::super::registry_get(a).unwrap().unwrap();
        assert_eq!((end.model.as_str(), end.effort.as_str()), ("deepseek-v4-pro", "low"), "each update kept the other's field");

        // An editor save of skills, MCP and the system text between a command's snapshot and its write cannot be undone:
        // the command reads the row in the section that writes.
        let stale = super::super::registry_get(a).unwrap().unwrap();
        let mut v = serde_json::to_value(&stale).unwrap();
        v["system"] = json!("edited in the editor");
        v["skills"] = json!("[\"a-skill\"]");
        super::super::registry_save(&v).unwrap();
        ws.window("w", "dsh", a, "");
        command(&ws, "w", "/model", "deepseek-flash").unwrap();
        let end = super::super::registry_get(a).unwrap().unwrap();
        assert_eq!((end.system.as_str(), end.skills.as_str()), ("edited in the editor", "[\"a-skill\"]"), "the editor's save is kept");
        assert_eq!(end.model, "deepseek-flash");
        super::super::registry_delete(a).ok();
    }
    /// Review P1-A2: nothing is inferred from the absence of an error. A dsh home
    /// that was never rendered, or whose recipe cannot be read, is UNKNOWN: a
    /// command for it fails (the definition is saved, the home is not known to
    /// run it) and a save lists it.
    #[test]
    fn a_home_that_cannot_be_confirmed_is_not_reported_applied() {
        let ws = Ws::new("unknown");
        let a = "dl-unknown-a";
        ws.def(a, "deepseek-flash", "");
        ws.window("fresh", "dsh", a, "");
        ws.window("garbled", "dsh", a, "");
        std::fs::remove_dir_all(agent_home(&ws.path, "fresh").join("dsh/profiles")).unwrap();   // never rendered
        std::fs::write(agent_home(&ws.path, "garbled").join("launch.json"), "{ not json").unwrap();

        assert!(matches!(project_window(&ws.path, "fresh").0, Outcome::Unknown(_)), "a missing profile is unknown, not applied");
        assert!(matches!(project_window(&ws.path, "garbled").0, Outcome::Unknown(_)), "an unreadable recipe of a dsh home is unknown");
        assert_eq!(project_window(&ws.path, "nowhere").0, Outcome::NotApplicable);

        let err = command(&ws, "fresh", "/model", "deepseek-v4-pro").err().expect("a home that was not updated is not a success");
        assert!(err.contains("is saved on the definition") && err.contains("application not confirmed") && err.contains("send the command again"), "{err}");
        assert_eq!(super::super::registry_get(a).unwrap().unwrap().model, "deepseek-v4-pro", "the definition is saved and never rolled back");

        let saved = super::super::registry_save(&json!({ "name": a, "backend": "dsh", "model": "deepseek-flash", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let windows: Vec<&str> = saved["unapplied"].as_array().expect("unknown homes are listed").iter().filter(|u| u["project"] == ws.path.as_str()).filter_map(|u| u["window"].as_str()).collect();
        assert!(windows.contains(&"fresh") && windows.contains(&"garbled"), "{saved}");

        // A window that IS confirmed says so, and the unchanged text is already-current, not rewritten.
        ws.window("ok", "dsh", a, "");
        assert_eq!(project_window(&ws.path, "ok").0, Outcome::AlreadyCurrent);
        super::super::registry_delete(a).ok();
    }

    /// Review P1-A2: a listing that fails is a failure, not an empty list.
    #[test]
    fn a_failed_discovery_is_reported_as_a_failure() {
        let ws = Ws::new("discovery");
        std::fs::create_dir_all(Path::new(&ws.path).join(".tmm")).unwrap();
        std::fs::write(Path::new(&ws.path).join(".tmm/agents"), "a file where the agents directory should be").unwrap();
        let failures = rerender_all();
        let mine: Vec<&Unapplied> = failures.iter().filter(|u| u.project == ws.path).collect();
        assert_eq!(mine.len(), 1, "{failures:?}");
        assert!(mine[0].window.is_empty() && mine[0].error.contains("agents"), "{:?}", mine[0]);
    }

    /// Review P1-A2, scope: two projects may both have a window of the same name,
    /// and an unrelated failed home must not fail a correct command. The command
    /// is judged by ITS home; the others it reports are of the same definition,
    /// named with their project.
    #[test]
    fn a_command_is_judged_by_its_own_home_and_definition_not_by_unrelated_failures() {
        if running_as_root() {
            eprintln!("skipped: root writes through a read-only directory");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (a, other) = ("dl-scope-a", "dl-scope-other");
        let (p1, p2, p3) = (Ws::new("scope1"), Ws::new("scope2"), Ws::new("scope3"));
        p1.def(a, "deepseek-flash", "");
        p1.def(other, "deepseek-flash", "");
        p1.window("w", "dsh", a, "");
        p2.window("w", "dsh", a, "");            // same window name, same definition, will fail
        p3.window("w", "dsh", other, "");        // same window name, UNRELATED definition, will fail
        p1.window("garbled", "dsh", a, "");      // a dsh home nobody can read: unknown, belongs to no definition
        std::fs::write(agent_home(&p1.path, "garbled").join("launch.json"), "{ not json").unwrap();
        // The unrelated definition moved on without a projection, so the next one has a write to attempt (and fail).
        let mut moved = super::super::registry_get(other).unwrap().unwrap();
        moved.model = "deepseek-v4-pro".into();
        super::super::with_store(|st| st.reg_save(&moved, 3)).unwrap();
        let lock = |ws: &Ws| std::fs::set_permissions(agent_home(&ws.path, "w").join("dsh/profiles/tmm"), std::fs::Permissions::from_mode(0o555)).unwrap();
        let unlock = |ws: &Ws| std::fs::set_permissions(agent_home(&ws.path, "w").join("dsh/profiles/tmm"), std::fs::Permissions::from_mode(0o755)).unwrap();
        lock(&p2);
        lock(&p3);

        let done = command(&p1, "w", "/model", "deepseek-v4-pro").expect("a correct command is not failed by other homes");
        assert_eq!(model_of(&p1.patch("w")), "deepseek-v4-pro");
        // One rule for the save and the command: the same definition's other home (told apart by
        // its project) and the home nobody can read (it cannot be ruled out, and says it was not
        // confirmed); never the unrelated definition's failed home.
        assert_eq!(done.others_unapplied.len(), 2, "{:?}", done.others_unapplied);
        assert!(done.others_unapplied.iter().any(|o| o.starts_with("w in ") && o.contains(&p2.path)), "{:?}", done.others_unapplied);
        assert!(done.others_unapplied.iter().any(|o| o.starts_with("garbled (not confirmed): ")), "{:?}", done.others_unapplied);
        assert!(!done.others_unapplied.iter().any(|o| o.contains(&p3.path)), "{:?}", done.others_unapplied);

        // The failing home itself is judged by itself: its command fails.
        assert!(command(&p2, "w", "/effort", "low").err().unwrap().contains("still runs the old one"));
        // A save of `a` lists its own failure and not the unrelated definition's.
        let saved = super::super::registry_save(&json!({ "name": a, "backend": "dsh", "model": "deepseek-v4-pro", "effort": "low", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let listed: Vec<(&str, &str)> = saved["unapplied"].as_array().unwrap().iter().filter_map(|u| Some((u["project"].as_str()?, u["definition"].as_str()?))).collect();
        assert!(listed.contains(&(p2.path.as_str(), a)), "{saved}");
        assert!(!listed.iter().any(|(project, _)| *project == p3.path), "an unrelated definition's failed home is not this save's: {saved}");
        assert!(saved["unapplied"].as_array().unwrap().iter().any(|u| u["window"] == "garbled" && u["definition"] == ""), "a home that cannot be read belongs to no definition, so every save lists it: {saved}");
        unlock(&p2);
        unlock(&p3);
        for n in [a, other] { super::super::registry_delete(n).ok(); }
    }

    /// Review P2: the team-save path, with a valid inherited and overridden
    /// member. A base save reaches the member that inherits, not the one that
    /// overrides; a team save reaches both; a command is refused for a member.
    #[test]
    fn a_base_save_and_a_team_save_reach_a_team_members_window() {
        let ws = Ws::new("team");
        let (base, team) = ("dl-team-base", "dl-team-crew");
        ws.def(base, "deepseek-flash", "");
        super::super::teams_save(&json!({
            "name": team, "description": "",
            "members": json!([{ "name": "inherits", "base": base }, { "name": "overrides", "base": base, "model": "deepseek-flash", "effort": "max" }]).to_string(),
        })).unwrap();
        for m in ["inherits", "overrides"] {
            ws.window(m, "dsh", base, "");
            std::fs::write(agent_home(&ws.path, m).join("launch.json"), json!({ "backend": "dsh", "agent_def": "", "team": team, "member": m }).to_string()).unwrap();
        }
        assert_eq!(project_window(&ws.path, "inherits").0, Outcome::AlreadyCurrent, "the member that inherits is the base's text already");
        assert_eq!(project_window(&ws.path, "overrides").0, Outcome::Applied, "the override is written as the team gives it");
        assert_eq!(model_of(&ws.patch("overrides")), "deepseek-flash");

        let saved = super::super::registry_save(&json!({ "name": base, "backend": "dsh", "model": "deepseek-v4-pro", "effort": "low", "system": "Persona.", "skills": "[]", "mcp": "[]" })).unwrap();
        assert!(saved.get("unapplied").is_none(), "{saved}");
        assert_eq!((model_of(&ws.patch("inherits")).as_str(), ws.patch("inherits").contains("reasoningEffort: \"low\"")), ("deepseek-v4-pro", true), "the member that inherits follows its base");
        assert!(model_of(&ws.patch("overrides")) == "deepseek-flash" && ws.patch("overrides").contains("reasoningEffort: \"max\""), "the member that overrides keeps its override");

        let saved = super::super::teams_save(&json!({
            "name": team, "description": "",
            "members": json!([{ "name": "inherits", "base": base, "model": "deepseek-flash" }, { "name": "overrides", "base": base, "model": "deepseek-v4-pro", "effort": "off" }]).to_string(),
        })).unwrap();
        assert!(saved.get("unapplied").is_none(), "{saved}");
        assert_eq!(model_of(&ws.patch("inherits")), "deepseek-flash", "a team save reaches its members' windows");
        assert_eq!(model_of(&ws.patch("overrides")), "deepseek-v4-pro");
        assert!(command(&ws, "inherits", "/model", "deepseek-v4-pro").err().unwrap().contains("belongs to team"));
        super::super::teams_delete(team).ok();
        super::super::registry_delete(base).ok();
    }
    /// Review round 3: the report follows PROVENANCE, not the display label. A
    /// change of base A reaches a standalone window of A, and a team member that
    /// inherits from A must never disappear from the report when it cannot be
    /// written; an unrelated team or home must not be attributed to the change;
    /// and the same rule serves the slash command, the definition save and the
    /// team save.
    #[test]
    fn a_failed_inheriting_member_is_reported_by_its_base_and_an_unrelated_team_is_not() {
        if running_as_root() {
            eprintln!("skipped: root writes through a read-only directory");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let ws = Ws::new("lineage");
        let (base, other, crew, others) = ("dl-lin-base", "dl-lin-other", "dl-lin-crew", "dl-lin-others");
        ws.def(base, "deepseek-flash", "");
        ws.def(other, "deepseek-flash", "");
        let team = |name: &str, members: serde_json::Value| super::super::teams_save(&json!({ "name": name, "description": "", "members": members.to_string() })).unwrap();
        team(crew, json!([{ "name": "inherits", "base": base }, { "name": "overrides", "base": base, "model": "deepseek-flash", "effort": "max" }]));
        team(others, json!([{ "name": "strange", "base": other }]));
        ws.window("solo", "dsh", base, "");
        for (m, def, t) in [("inherits", base, crew), ("overrides", base, crew), ("strange", other, others)] {
            ws.window(m, "dsh", def, "");
            std::fs::write(agent_home(&ws.path, m).join("launch.json"), json!({ "backend": "dsh", "agent_def": "", "team": t, "member": m }).to_string()).unwrap();
        }
        // The overriding member carries its override from the start; the unrelated team's definition moved
        // on without a projection, so its next projection has a write to attempt (and fail).
        assert_eq!(project_window(&ws.path, "overrides").0, Outcome::Applied);
        let mut moved = super::super::registry_get(other).unwrap().unwrap();
        moved.model = "deepseek-v4-pro".into();
        super::super::with_store(|st| st.reg_save(&moved, 3)).unwrap();
        let profile = |w: &str| agent_home(&ws.path, w).join("dsh/profiles/tmm");
        let set = |mode: u32| for w in ["inherits", "overrides", "strange"] { std::fs::set_permissions(profile(w), std::fs::Permissions::from_mode(mode)).unwrap(); };
        set(0o555);

        // The lineage itself: where each window's model and effort come from.
        let lineage = |w: &str| project_window(&ws.path, w).1.unwrap();
        assert_eq!((lineage("solo").team.as_str(), lineage("solo").bases.len()), ("", 1));
        assert_eq!((lineage("inherits").team.as_str(), lineage("inherits").bases[0].name.as_str()), (crew, base));
        assert!(lineage("inherits").bases[0].model && lineage("inherits").bases[0].effort);
        assert!(!lineage("overrides").bases[0].model && !lineage("overrides").bases[0].effort, "both fields are the member's own");

        // /model on the standalone window of the base: it succeeds, and the inheriting member is reported with
        // project and window; the overriding member and the unrelated team are not this change's.
        let done = command(&ws, "solo", "/model", "deepseek-v4-pro").expect("the standalone window itself was applied");
        assert_eq!(model_of(&ws.patch("solo")), "deepseek-v4-pro");
        assert_eq!(done.others_unapplied.len(), 1, "{:?}", done.others_unapplied);
        assert!(done.others_unapplied[0].starts_with("inherits: "), "same project: no project suffix: {:?}", done.others_unapplied);
        assert!(done.others_unapplied[0].contains("Permission denied"), "{:?}", done.others_unapplied);

        // A save of the base lists the same member (with project and window), and nothing of the unrelated team.
        let saved = super::super::registry_save(&json!({ "name": base, "backend": "dsh", "model": "deepseek-v4-pro", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let mine: Vec<(&str, &str)> = saved["unapplied"].as_array().unwrap().iter().filter(|u| u["project"] == ws.path.as_str()).filter_map(|u| Some((u["window"].as_str()?, u["definition"].as_str()?))).collect();
        assert_eq!(mine, vec![("inherits", format!("team {crew}").as_str())], "{saved}");
        let row = saved["unapplied"].as_array().unwrap().iter().find(|u| u["window"] == "inherits").unwrap();
        assert_eq!((row["team"].as_str(), row["bases"].clone(), row["kind"].as_str()), (Some(crew), json!([base]), Some("failed")), "the row keeps the owning team and the inherited base: {row}");

        // A team save reports its own subtree: the crew's inheriting member, not the other team's, not the base's solo window.
        let saved = team(crew, json!([{ "name": "inherits", "base": base }, { "name": "overrides", "base": base, "model": "deepseek-flash", "effort": "max" }]));
        let mine: Vec<&str> = saved["unapplied"].as_array().unwrap().iter().filter(|u| u["project"] == ws.path.as_str()).filter_map(|u| u["window"].as_str()).collect();
        assert_eq!(mine, vec!["inherits"], "{saved}");
        // The other team's own save does list its member.
        let saved = team(others, json!([{ "name": "strange", "base": other }]));
        let mine: Vec<&str> = saved["unapplied"].as_array().unwrap().iter().filter(|u| u["project"] == ws.path.as_str()).filter_map(|u| u["window"].as_str()).collect();
        assert_eq!(mine, vec!["strange"], "{saved}");
        set(0o755);
        super::super::teams_delete(crew).ok();
        super::super::teams_delete(others).ok();
        for n in [base, other] { super::super::registry_delete(n).ok(); }
    }

    /// Boards #411 x #412: the live writer publishes the WHOLE patch, the
    /// definition's MCP rows included, so a save that changes ONLY the MCP list
    /// concerns every home that inherits it — a team member that overrides both
    /// model and effort still takes its base's MCP list. Four homes: the base's
    /// own window (applied), a read-only member of the base overriding model and
    /// effort (reported, with project and window), a read-only member of an
    /// unrelated base whose projection also fails (not this change's), and a
    /// writable member of the base (applied). Once the read-only member can be
    /// written, the next projection brings the rows to it.
    #[test]
    fn an_mcp_only_save_reports_a_failed_member_that_overrides_model_and_effort() {
        if running_as_root() {
            eprintln!("skipped: root writes through a read-only directory");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let ws = Ws::new("mcp412");
        let (base, other, crew, others) = ("dl-mcp-base", "dl-mcp-other", "dl-mcp-crew", "dl-mcp-others");
        ws.def(base, "deepseek-flash", "");
        ws.def(other, "deepseek-flash", "");
        let team = |name: &str, members: serde_json::Value| super::super::teams_save(&json!({ "name": name, "description": "", "members": members.to_string() })).unwrap();
        team(crew, json!([{ "name": "overrides", "base": base, "model": "deepseek-v4-pro", "effort": "max" }, { "name": "plain", "base": base }]));
        team(others, json!([{ "name": "strange", "base": other }]));
        ws.window("solo", "dsh", base, "");
        for (m, def, t) in [("overrides", base, crew), ("plain", base, crew), ("strange", other, others)] {
            ws.window(m, "dsh", def, "");
            std::fs::write(agent_home(&ws.path, m).join("launch.json"), json!({ "backend": "dsh", "agent_def": "", "team": t, "member": m }).to_string()).unwrap();
            assert!(matches!(project_window(&ws.path, m).0, Outcome::Applied | Outcome::AlreadyCurrent), "{m}");
        }
        let lineage = project_window(&ws.path, "overrides").1.unwrap();
        assert!(!lineage.bases[0].model && !lineage.bases[0].effort && lineage.bases[0].mcp, "model and effort are its own, the MCP list is its base's");
        // The unrelated definition moved on, so its member has a write to attempt (and fail).
        let mut moved = super::super::registry_get(other).unwrap().unwrap();
        moved.model = "deepseek-v4-pro".into();
        super::super::with_store(|st| st.reg_save(&moved, 3)).unwrap();
        let profile = |w: &str| agent_home(&ws.path, w).join("dsh/profiles/tmm");
        let set = |mode: u32| for w in ["overrides", "strange"] { std::fs::set_permissions(profile(w), std::fs::Permissions::from_mode(mode)).unwrap(); };
        set(0o555);
        let mcp = json!([{ "name": "echo", "command": "node", "args": ["srv.mjs"] }]).to_string();
        let saved = super::super::registry_save(&json!({ "name": base, "backend": "dsh", "model": "deepseek-flash", "effort": "", "system": "Persona.", "skills": "[]", "mcp": mcp })).unwrap();
        let mine: Vec<(&str, &str, &str)> = saved["unapplied"].as_array().map(|a| a.iter().filter(|u| u["project"] == ws.path.as_str()).filter_map(|u| Some((u["window"].as_str()?, u["definition"].as_str()?, u["kind"].as_str()?))).collect()).unwrap_or_default();
        assert_eq!(mine, vec![("overrides", format!("team {crew}").as_str(), "failed")], "the MCP-inheriting member is reported, the unrelated failure is not: {saved}");
        for w in ["solo", "plain"] {
            assert!(ws.patch(w).contains("- id: tmm-mcp-echo\n"), "{w}: {}", ws.patch(w));
        }
        assert!(!ws.patch("overrides").contains("tmm-mcp-echo"), "it could not be written");
        // A model-only command on the base still does not attribute the overriding member.
        let done = command(&ws, "solo", "/model", "deepseek-v4-pro").expect("the standalone window itself was applied");
        assert!(done.others_unapplied.iter().all(|u| !u.starts_with("overrides")), "{:?}", done.others_unapplied);
        set(0o755);
        assert_eq!(project_window(&ws.path, "overrides").0, Outcome::Applied);
        let patch = ws.patch("overrides");
        assert!(patch.contains("- id: tmm-mcp-echo\n") && patch.contains("model: \"deepseek-v4-pro\"") && patch.contains("reasoningEffort: \"max\""), "the rows reached it, its own model and effort kept: {patch}");
        super::super::teams_delete(crew).ok();
        super::super::teams_delete(others).ok();
        for n in [base, other] { super::super::registry_delete(n).ok(); }
    }

    /// The rule on constructed lineages: a field the member overrides is not
    /// inherited from the base, a sub-team's save concerns the members under it.
    #[test]
    fn the_scope_rule_follows_overrides_and_team_nesting() {
        let base = |model, effort| Base { name: "a".into(), model, effort, mcp: true };
        let member = |model, effort, team: &str| Unapplied { project: "/p".into(), window: "m".into(), kind: "failed", error: "e".into(), lineage: Some(Lineage { team: team.into(), resolved: true, bases: vec![base(model, effort)] }) };
        let (model, effort) = (Change::Definition { name: "a", model: true, effort: false, mcp: false }, Change::Definition { name: "a", model: false, effort: true, mcp: false });
        assert!(affected(&member(true, true, "crew"), &model) && affected(&member(true, true, "crew"), &effort));
        assert!(!affected(&member(false, true, "crew"), &model), "the model is the member's own");
        assert!(affected(&member(false, true, "crew"), &effort));
        assert!(!affected(&member(false, false, "crew"), &Change::Definition { name: "a", model: true, effort: true, mcp: false }));
        assert!(!affected(&member(true, true, "crew"), &Change::Definition { name: "b", model: true, effort: true, mcp: true }), "another definition");
        // Board #412: the MCP list is inherited even when both model and effort are overridden.
        let mcp = Change::Definition { name: "a", model: false, effort: false, mcp: true };
        assert!(affected(&member(false, false, "crew"), &mcp), "an MCP change reaches a member that overrides model and effort");
        assert!(!affected(&member(false, false, "crew"), &model), "a model-only change still does not");
        assert!(affected(&member(true, true, "crew/review"), &Change::Team("review")) && affected(&member(true, true, "crew/review"), &Change::Team("crew")));
        assert!(!affected(&member(true, true, "crew/review"), &Change::Team("others")));
        // A member with no base is KNOWN to derive from none; one that could not be resolved is not known at all.
        let lineage = |resolved, team: &str| Unapplied { project: "/p".into(), window: "m".into(), kind: "unknown", error: "e".into(), lineage: Some(Lineage { team: team.into(), resolved, bases: Vec::new() }) };
        assert!(!affected(&lineage(true, "crew"), &model), "an inline member derives from no registry definition");
        assert!(affected(&lineage(true, "crew"), &Change::Team("crew")));
        assert!(affected(&lineage(false, "crew"), &model) && affected(&lineage(false, "crew"), &effort), "an unresolved lineage is never ruled out of a definition change");
        assert!(!affected(&lineage(false, "crew"), &Change::Team("others")), "its team path is still known");
        let unplaced = Unapplied { project: "/p".into(), window: String::new(), kind: "unknown", error: "e".into(), lineage: None };
        assert!(affected(&unplaced, &model) && affected(&unplaced, &Change::Team("x")), "what cannot be placed cannot be ruled out");
    }
    /// Review round 4 (P2-A, P2-B): the lineage comes from the member the
    /// effective definition resolved. An inline member (no registry base) is
    /// known to derive from none, so a definition change does not concern it; a
    /// window whose team cannot be resolved is not known to derive from anything,
    /// so it is never ruled out; and the command for a home that cannot be
    /// confirmed says "application not confirmed", not "still runs the old one".
    #[test]
    fn an_unresolved_lineage_stays_unknown_and_an_inline_member_is_known_to_have_no_base() {
        let ws = Ws::new("unresolved");
        let (base, crew) = ("dl-unres-base", "dl-unres-crew");
        ws.def(base, "deepseek-flash", "");
        super::super::teams_save(&json!({ "name": crew, "description": "", "members": json!([
            { "name": "inl", "agent": { "name": "", "backend": "dsh", "model": "deepseek-flash", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" } },
        ]).to_string() })).unwrap();
        let team_window = |window: &str, team: &str| {
            ws.window(window, "dsh", base, "");
            std::fs::write(agent_home(&ws.path, window).join("launch.json"), json!({ "backend": "dsh", "agent_def": "", "team": team, "member": window }).to_string()).unwrap();
        };
        team_window("inl", crew);
        team_window("lost", "dl-unres-gone");          // its team no longer exists
        let inline = project_window(&ws.path, "inl");
        assert_eq!(inline.1, Some(Lineage { team: crew.into(), resolved: true, bases: Vec::new() }), "known: derives from no registry definition");
        let lost = project_window(&ws.path, "lost");
        assert!(matches!(lost.0, Outcome::Unknown(_)), "{:?}", lost.0);
        assert_eq!(lost.1, Some(Lineage { team: "dl-unres-gone".into(), resolved: false, bases: Vec::new() }), "unknown, not 'no base'");

        // A change of the base: the unresolved window is listed (never excluded), the inline one is not.
        let saved = super::super::registry_save(&json!({ "name": base, "backend": "dsh", "model": "deepseek-v4-pro", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let mine: Vec<&str> = saved["unapplied"].as_array().map(|l| l.iter().filter(|u| u["project"] == ws.path.as_str()).filter_map(|u| u["window"].as_str()).collect()).unwrap_or_default();
        assert_eq!(mine, vec!["lost"], "{saved}");

        // A command for a home that cannot be confirmed says so, and still refuses.
        ws.window("fresh", "dsh", base, "");
        std::fs::remove_dir_all(agent_home(&ws.path, "fresh").join("dsh/profiles")).unwrap();
        let err = command(&ws, "fresh", "/model", "deepseek-flash").err().expect("a home that was not updated is not a success");
        assert!(err.contains("application not confirmed for 'fresh'") && !err.contains("still runs the old one"), "{err}");
        super::super::teams_delete(crew).ok();
        super::super::registry_delete(base).ok();
    }
}
