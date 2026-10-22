//! The registry facade: agent, team and global-prompt definitions as the RPC layer and spawn see them, over store::registry.
//!
//! One family of `projects` (board #152): moved whole from mod.rs, which stays
//! the facade — every `projects::X` path is a re-export of this file.

use super::*;

pub fn registry_list() -> Result<Value, String> {
    with_store(|store| {
        store.reg_seed(now())?;
        let mut agents = store.reg_list()?;
        // Every inline MCP value masked (board #451); one unreadable row
        // fails the whole answer rather than listing a half definition.
        for a in &mut agents {
            a.mcp = mcp_mask::masked_agent(&a.name, &a.mcp)?;
        }
        Ok(json!({ "agents": agents }))
    })
}

/// Whether a def NAMES an input mode. Absent and null both mean "not named"
/// (board #336): the mode is then resolved by `unnamed_input_mode`.
fn names_input_mode(def: &Value) -> bool {
    def.get("input_mode").is_some_and(|v| !v.is_null())
}

/// The mode for a def that names none (board #336, reviewer P1-B on
/// 99e233c3). A definition that ALREADY EXISTS keeps the mode it was stored
/// with, so an update that does not mention the mode never changes it; only
/// a NEW definition gets its backend's default (kiro steers). A kept mode the
/// def's backend can no longer carry (a steer row moved to claude) falls to
/// the new backend's default, the same thing the editor does. An unknown
/// backend is left to the validation (`queue`, which it then refuses by name).
fn unnamed_input_mode(backend: &str, stored: Option<&str>) -> String {
    if let Some(mode) = stored.filter(|m| models::validate_input_mode(backend, m).is_ok()) {
        return mode.to_string();
    }
    crate::backends::Backend::parse(backend).map_or("queue", |b| b.default_input_mode()).to_string()
}

pub fn registry_save(def: &Value) -> Result<Value, String> {
    let named = names_input_mode(def);
    let mut def = def.clone();
    if !named {
        // A null is not a value serde's default covers; the mode is resolved
        // below, against the stored row.
        if let Some(obj) = def.as_object_mut() { obj.remove("input_mode"); }
    }
    let mut agent: store::RegAgent =
        serde_json::from_value(def).map_err(|e| format!("invalid agent def {}", mcp_mask::no_echo(&e)))?;
    // The registry name becomes the window name and the isolated home's
    // directory — one rule for both (`agents::valid_name`).
    agents::valid_name(&agent.name)?;
    if !agents::SPAWNABLE_BACKENDS.contains(&agent.backend.as_str()) {
        return Err(format!(
            "backend must be {}, got '{}'",
            agents::SPAWNABLE_BACKENDS.join("|"),
            agent.backend
        ));
    }
    // Validate the JSON columns now, not at spawn time.
    serde_json::from_str::<Vec<String>>(&agent.skills).map_err(|e| format!("skills must be a JSON array of refs {}", mcp_mask::no_echo(&e)))?;
    mcp_mask::check_agent(&format!("agent '{}'", agent.name), &agent.mcp)?;
    // Same rule for the model, and for a sharper reason: a backend that does
    // not know the id does not fail, it falls back to its default and says so
    // in a line nobody reads. See `models`.
    models::validate(&agent.backend, &agent.model)?;
    models::validate_effort(&agent.backend, &agent.effort)?;
    // Whether the row exists is read in the SAME store section that writes
    // it: two separate sections would let a concurrent save decide "new"
    // about a row that is no longer new.
    with_store(|store| {
        let stored = store.reg_get(&agent.name)?;
        if !named {
            agent.input_mode = unnamed_input_mode(&agent.backend, stored.as_ref().map(|a| a.input_mode.as_str()));
        }
        // A `"<set>"` MCP value keeps the value of the row as stored NOW, by
        // server name and key (board #451) — never a list-time snapshot.
        agent.mcp = mcp_mask::restore_agent(&format!("agent '{}'", agent.name), &agent.mcp, stored.as_ref().map(|a| a.mcp.as_str()))?;
        models::validate_input_mode(&agent.backend, &agent.input_mode)?;
        store.reg_save(&agent, now())?;
        Ok(json!({ "ok": true, "name": agent.name }))
    })
    // A whole-definition save concerns every home that inherits ANY field the
    // live writer publishes from it — the MCP list too (board #412): a member
    // that overrides model and effort still takes its base's MCP rows.
    .map(|saved| with_unapplied(saved, project_live_config(&agent.backend, live_config::Change::Definition { name: &agent.name, model: true, effort: true, mcp: true })))
}

/// A saved definition reaches a RUNNING agent of a backend that reads its
/// config every turn (dsh, board #411) by being projected into its home, with
/// no restart; the other backends apply it at restart. Called outside the
/// store section (the projection reads the registry itself). What could not be
/// brought to it is returned, never swallowed, and scoped by ONE rule
/// (`live_config::affected`): the windows that follow the saved definition, the
/// team members that inherit from it, and what could not be placed at all; a
/// failed home of an UNRELATED definition or team is not this change's.
fn project_live_config(backend: &str, change: live_config::Change) -> Vec<live_config::Unapplied> {
    if !crate::backends::Backend::parse(backend).is_some_and(crate::backends::Backend::config_read_every_turn) {
        return Vec::new();
    }
    live_config::rerender_all().into_iter().filter(|u| live_config::affected(u, &change)).collect()
}

/// The save's answer, with the homes its definition could not be applied to
/// (`unapplied`: `[{project, window, definition, error}]`, absent when there are
/// none). The definition IS saved either way; this is the difference between
/// "saved" and "the next turn uses it".
fn with_unapplied(mut saved: Value, unapplied: Vec<live_config::Unapplied>) -> Value {
    if !unapplied.is_empty() {
        saved["unapplied"] = Value::Array(
            unapplied.into_iter().map(|u| { let definition = u.definition();
                let (team, bases) = u.lineage.as_ref().map(|l| (l.team.clone(), l.bases.iter().map(|b| b.name.clone()).collect::<Vec<_>>())).unwrap_or_default();
                json!({ "project": u.project, "window": u.window, "definition": definition, "team": team, "bases": bases, "kind": u.kind, "error": u.error }) }).collect(),
        );
    }
    saved
}

/// Set the model and/or the effort of a stored definition, and nothing else:
/// the CURRENT row is read in the same store section that writes it, so a
/// concurrent edit of another field (an editor save of the skills, MCP or
/// system text, another command's field) is kept, never restored from an
/// earlier snapshot (board #411 review). The same validation as `registry_save`
/// (`models::validate`, `validate_effort`), then the same live projection.
pub fn registry_set_model_effort(name: &str, model: Option<&str>, effort: Option<&str>) -> Result<Value, String> {
    let agent = with_store(|store| {
        let mut agent = store.reg_get(name)?.ok_or_else(|| format!("no agent definition '{name}'"))?;
        if let Some(m) = model { agent.model = m.trim().to_string(); }
        if let Some(e) = effort { agent.effort = e.trim().to_string(); }
        #[cfg(test)]
        after_field_read();
        // Validation under the store section is cheap for the one backend that
        // uses this (a syntax rule and a fixed list; no CLI is asked).
        models::validate(&agent.backend, &agent.model)?;
        models::validate_effort(&agent.backend, &agent.effort)?;
        store.reg_save(&agent, now())?;
        Ok(agent)
    })?;
    let change = live_config::Change::Definition { name: &agent.name, model: model.is_some(), effort: effort.is_some(), mcp: false };
    Ok(with_unapplied(json!({ "ok": true, "name": agent.name }), project_live_config(&agent.backend, change)))
}

/// Test seam: runs inside the store section of `registry_set_model_effort`,
/// after the row was read and before it is written, so a test can hold a field
/// update exactly there and observe that no other writer gets in.
#[cfg(test)]
pub(crate) static FIELD_UPDATE_PAUSE: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> = std::sync::Mutex::new(None);

#[cfg(test)]
fn after_field_read() {
    let hook = FIELD_UPDATE_PAUSE.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(hook) = hook { hook(); }
}

/// A team's bare members that name no input mode (board #336, reviewer P1-B):
/// a member the STORED team already has (same name, bare) keeps the mode it
/// was stored with — including none, which has always meant `queue` (the
/// serde default) and so is left absent; only a NEW bare member gets its
/// backend's default. Returns the members text to store: the incoming text,
/// byte for byte, unless a mode was filled. Text that is not a JSON array is
/// returned as it came, for `teams::validate` to name.
fn fill_member_input_modes(members: &str, stored: Option<&store::RegTeam>) -> Result<String, String> {
    let Ok(mut incoming) = serde_json::from_str::<Vec<Value>>(members) else { return Ok(members.to_string()) };
    let before: Vec<Value> = stored.and_then(|t| serde_json::from_str(&t.members).ok()).unwrap_or_default();
    let bare = |m: &Value| m.get("base").and_then(Value::as_str).unwrap_or("").trim().is_empty()
        && m.get("team").and_then(Value::as_str).unwrap_or("").trim().is_empty()
        && m.get("agent").is_some_and(Value::is_object);
    let mut filled = false;
    for m in incoming.iter_mut().filter(|m| bare(m)) {
        let name = m.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let agent = m.get_mut("agent").expect("bare");
        if names_input_mode(agent) { continue; }
        let backend = agent.get("backend").and_then(Value::as_str).unwrap_or("").to_string();
        let old = before.iter().find(|o| bare(o) && o.get("name").and_then(Value::as_str).unwrap_or("").trim() == name);
        let mode = match old {
            // Existing, and stored without a mode: leave it so (queue).
            Some(o) if !names_input_mode(&o["agent"]) => continue,
            Some(o) => unnamed_input_mode(&backend, o["agent"]["input_mode"].as_str()),
            None => unnamed_input_mode(&backend, None),
        };
        agent["input_mode"] = json!(mode);
        filled = true;
    }
    if !filled { return Ok(members.to_string()); }
    serde_json::to_string(&incoming).map_err(|e| e.to_string())
}

pub fn teams_list() -> Result<Value, String> {
    with_store(|store| {
        let mut teams = store.teams_list()?;
        // Every inline agent's MCP values masked (board #451).
        for t in &mut teams {
            t.members = mcp_mask::masked_team(&t.name, &t.members)?;
        }
        Ok(json!({ "teams": teams }))
    })
}

pub fn team_get(name: &str) -> Result<Option<store::RegTeam>, String> {
    with_store(|store| store.team_get(name))
}

/// Save a team. Validation happens here, not at spawn: a base that is not in
/// the registry, a duplicate member name, a bare member on an unknown
/// backend or with a model the backend rejects — each would otherwise be
/// discovered by the human the moment they try to start the team.
pub fn teams_save(def: &Value) -> Result<Value, String> {
    let mut team: store::RegTeam = serde_json::from_value(def.clone()).map_err(|e| format!("invalid team def {}", mcp_mask::no_echo(&e)))?;
    mcp_mask::check_team(&team.name, &team.members)?;
    let (known, known_teams): (Vec<String>, Vec<String>) = with_store(|store| {
        store.reg_seed(now())?;
        Ok((
            store.reg_list()?.into_iter().map(|a| a.name).collect(),
            store.teams_list()?.into_iter().map(|t| t.name).collect(),
        ))
    })?;
    let members = teams::validate(&team, &known, &known_teams, spawn::SPAWN_CAP)?;
    // Nesting: the EXPANSION must be acyclic and fit the cap — including the
    // saved team itself, so a team cannot be made to reach itself by editing
    // a sub-team later either (the sub-team's save runs this same check with
    // its parents already stored).
    let saved = team.clone();
    let lookup = |n: &str| -> Result<Option<store::RegTeam>, String> {
        if n == saved.name { return Ok(Some(saved.clone())); }
        team_get(n)
    };
    teams::expand(&team, &lookup, spawn::SPAWN_CAP)?;
    for t in with_store(|store| store.teams_list())? {
        if t.name != team.name && teams::parse_members(&t).map(|ms| ms.iter().any(|m| m.team.trim() == team.name)).unwrap_or(false) {
            teams::expand(&t, &lookup, spawn::SPAWN_CAP).map_err(|e| format!("saving would break team '{}': {e}", t.name))?;
        }
    }
    for m in &members {
        if !m.team.trim().is_empty() { continue; }
        // A custom-agent member's model/effort override is checked against the
        // BASE's backend — the same rule registry_save applies, for the same
        // reason (a bad id runs the default model and says so in a line
        // nobody reads).
        if !m.base.trim().is_empty()
            && (!m.model.trim().is_empty() || !m.effort.trim().is_empty() || !m.input_mode.trim().is_empty())
        {
            if let Some(base) = registry_get(m.base.trim())? {
                models::validate(&base.backend, m.model.trim()).map_err(|e| format!("member '{}': {e}", m.name))?;
                models::validate_effort(&base.backend, m.effort.trim()).map_err(|e| format!("member '{}': {e}", m.name))?;
                // Board #254: the input-mode override, against the base's
                // backend, by the one rule registry_save uses.
                if !m.input_mode.trim().is_empty() {
                    models::validate_input_mode(&base.backend, m.input_mode.trim()).map_err(|e| format!("member '{}': {e}", m.name))?;
                }
            }
        }
        if let Some(a) = m.agent.as_ref().filter(|_| m.base.trim().is_empty()) {
            models::validate(&a.backend, &a.model).map_err(|e| format!("member '{}': {e}", m.name))?;
            models::validate_effort(&a.backend, &a.effort).map_err(|e| format!("member '{}': {e}", m.name))?;
            models::validate_input_mode(&a.backend, &a.input_mode).map_err(|e| format!("member '{}': {e}", m.name))?;
            serde_json::from_str::<Vec<String>>(&a.skills).map_err(|e| format!("member '{}': skills must be a JSON array {}", m.name, mcp_mask::no_echo(&e)))?;
            serde_json::from_str::<Vec<Value>>(&a.mcp).map_err(|e| format!("member '{}': mcp must be a JSON array {}", m.name, mcp_mask::no_echo(&e)))?;
        }
    }
    // A NEW bare member gets its backend's input mode (#336); an existing
    // one keeps its stored mode. Decided in the section that writes, against
    // the team as it is stored now. Every mode filled is valid for its
    // backend by construction (`unnamed_input_mode`), so the validation
    // above still holds for the text stored.
    with_store(|store| {
        let stored = store.team_get(&team.name)?;
        // A `"<set>"` MCP value of an inline agent keeps the SAME member's
        // value as stored now (board #451).
        team.members = mcp_mask::restore_team(&team.name, &team.members, stored.as_ref().map(|t| t.members.as_str()))?;
        team.members = fill_member_input_modes(&team.members, stored.as_ref())?;
        store.team_save(&team, now())?;
        Ok(json!({ "ok": true, "name": team.name, "members": members.len() }))
    })
    // A team's member model/effort is what its running windows follow, so a
    // team save is projected into them like a definition save (board #411).
    .map(|saved| with_unapplied(saved, live_config::rerender_all().into_iter().filter(|u| live_config::affected(u, &live_config::Change::Team(&team.name))).collect()))
}

pub fn teams_delete(name: &str) -> Result<Value, String> {
    // A team another team includes cannot vanish under it.
    let users: Vec<String> = with_store(|store| store.teams_list())?
        .into_iter()
        .filter(|t| teams::parse_members(t).map(|ms| ms.iter().any(|m| m.team.trim() == name)).unwrap_or(false))
        .map(|t| t.name)
        .collect();
    if !users.is_empty() {
        return Err(format!("team '{name}' is included by {} — remove it there first", users.join(", ")));
    }
    with_store(|store| Ok(json!({ "ok": store.team_delete(name)? })))
}

/// The app-wide agent instructions (`<config>/AGENTS.md`, projects::global_prompt).
pub fn global_prompt_get() -> Result<Value, String> {
    Ok(json!({ "text": global_prompt::read(), "path": global_prompt::path().to_string_lossy(), "max_bytes": global_prompt::MAX_BYTES }))
}

pub fn global_prompt_set(text: &str) -> Result<Value, String> {
    global_prompt::write(text)?;
    Ok(json!({ "ok": true, "bytes": text.trim().len() }))
}

pub fn registry_delete(name: &str) -> Result<Value, String> {
    with_store(|store| {
        let deleted = store.reg_delete(name)?;
        Ok(json!({ "ok": deleted }))
    })
}

/// Central skills as name→ref (spawn-time resolution; empty on store errors —
/// a raw ref in the agent def still works).
pub(crate) fn with_registry_skills() -> std::collections::HashMap<String, String> {
    let root = managed_skills_dir();
    with_store(|store| {
        Ok(store
            .skills_list()?
            .into_iter()
            .map(|s| {
                let managed = root.join(&s.name);
                let target = if managed.is_dir() {
                    managed.to_string_lossy().to_string()
                } else {
                    // Files missing (deleted by hand?) — fall back to the
                    // source so the spawn still works, degraded not broken.
                    s.source
                };
                (s.name, target)
            })
            .collect())
    })
    .unwrap_or_default()
}

/// Central MCP defs as name→def-json.
pub(crate) fn with_registry_mcp() -> std::collections::HashMap<String, String> {
    with_store(|store| Ok(store.mcp_list()?.into_iter().map(|m| (m.name, m.def)).collect()))
        .unwrap_or_default()
}

pub fn registry_get(name: &str) -> Result<Option<store::RegAgent>, String> {
    with_store(|store| {
        store.reg_seed(now())?;
        store.reg_get(name)
    })
}
