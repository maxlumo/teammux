//! The registry facade: agent, team and global-prompt definitions as the RPC layer and spawn see them, over store::registry.
//!
//! One family of `projects` (board #152): moved whole from mod.rs, which stays
//! the facade — every `projects::X` path is a re-export of this file.

use super::*;

pub fn registry_list() -> Result<Value, String> {
    with_store(|store| {
        store.reg_seed(now())?;
        let agents = store.reg_list()?;
        Ok(json!({ "agents": agents }))
    })
}

/// A def that names no input mode gets its backend's default (board #336:
/// kiro steers) — here, at the door, so only what is being SAVED is filled.
/// A stored row keeps the mode it was saved with, and stored team text that
/// predates the field keeps meaning `queue` (the serde default). Returns
/// whether it filled one. An unknown backend is left to the validation.
pub(crate) fn with_default_input_mode(def: &mut Value) -> bool {
    let Some(obj) = def.as_object_mut() else { return false };
    if obj.get("input_mode").is_some_and(|v| !v.is_null()) { return false; }
    let Some(backend) = obj.get("backend").and_then(Value::as_str).and_then(crate::backends::Backend::parse) else { return false };
    obj.insert("input_mode".into(), json!(backend.default_input_mode()));
    true
}

pub fn registry_save(def: &Value) -> Result<Value, String> {
    let mut def = def.clone();
    with_default_input_mode(&mut def);
    let agent: store::RegAgent =
        serde_json::from_value(def).map_err(|e| format!("invalid agent def: {e}"))?;
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
    serde_json::from_str::<Vec<String>>(&agent.skills).map_err(|e| format!("skills must be a JSON array of refs: {e}"))?;
    serde_json::from_str::<Vec<Value>>(&agent.mcp).map_err(|e| format!("mcp must be a JSON array of defs: {e}"))?;
    // Same rule for the model, and for a sharper reason: a backend that does
    // not know the id does not fail, it falls back to its default and says so
    // in a line nobody reads. See `models`.
    models::validate(&agent.backend, &agent.model)?;
    models::validate_effort(&agent.backend, &agent.effort)?;
    models::validate_input_mode(&agent.backend, &agent.input_mode)?;
    with_store(|store| {
        store.reg_save(&agent, now())?;
        Ok(json!({ "ok": true, "name": agent.name }))
    })
}

pub fn teams_list() -> Result<Value, String> {
    with_store(|store| Ok(json!({ "teams": store.teams_list()? })))
}

pub fn team_get(name: &str) -> Result<Option<store::RegTeam>, String> {
    with_store(|store| store.team_get(name))
}

/// Save a team. Validation happens here, not at spawn: a base that is not in
/// the registry, a duplicate member name, a bare member on an unknown
/// backend or with a model the backend rejects — each would otherwise be
/// discovered by the human the moment they try to start the team.
pub fn teams_save(def: &Value) -> Result<Value, String> {
    let mut team: store::RegTeam = serde_json::from_value(def.clone()).map_err(|e| format!("invalid team def: {e}"))?;
    // A bare member's inline agent is a NEW definition too: the same default
    // at the same door. Text that is not a JSON array is left as it came, for
    // `teams::validate` to name.
    if let Ok(mut members) = serde_json::from_str::<Vec<Value>>(&team.members) {
        let filled = members.iter_mut().filter_map(|m| m.get_mut("agent")).fold(false, |any, a| with_default_input_mode(a) | any);
        if filled { team.members = serde_json::to_string(&members).map_err(|e| e.to_string())?; }
    }
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
            serde_json::from_str::<Vec<String>>(&a.skills).map_err(|e| format!("member '{}': skills must be a JSON array: {e}", m.name))?;
            serde_json::from_str::<Vec<Value>>(&a.mcp).map_err(|e| format!("member '{}': mcp must be a JSON array: {e}", m.name))?;
        }
    }
    with_store(|store| {
        store.team_save(&team, now())?;
        Ok(json!({ "ok": true, "name": team.name, "members": members.len() }))
    })
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
