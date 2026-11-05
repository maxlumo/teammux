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
        let (checked, grey) = availability_view();
        Ok(annotate(agents, checked, grey))
    })
}

/// The server's availability view (board #7): whether a readiness report
/// exists, and the one rule over it per backend. Never waits; with no report
/// one background Refresh starts (`readiness::availability`). A phone-hosted
/// server runs no readiness check, so nothing is known there.
pub(crate) fn availability_view() -> (bool, Box<dyn Fn(&str) -> Option<Value>>) {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let (checked, grey) = crate::backends::readiness::availability();
        (checked, Box::new(grey))
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        (false, Box::new(|_: &str| None))
    }
}

/// A team's availability (board #7): `unknown` with no readiness report,
/// `unavailable` with the first member the one rule greys (`teams::
/// unavailable_member`: its name, backend, reason, missing names), else
/// `available`. A team that cannot be expanded is spawn's error to name,
/// never availability's, so it reads `available` here.
pub(crate) fn team_availability(
    team: &store::RegTeam,
    agents: &[store::RegAgent],
    checked: bool,
    grey: &dyn Fn(&str) -> Option<Value>,
    lookup: &dyn Fn(&str) -> Result<Option<store::RegTeam>, String>,
) -> Value {
    if !checked {
        return json!({ "state": "unknown" });
    }
    let base = |n: &str| agents.iter().find(|a| a.name == n).map(|a| a.backend.clone());
    match super::teams::expand(team, lookup, usize::MAX).ok().and_then(|flat| super::teams::unavailable_member(&flat, &base, grey)) {
        Some(mut why) => {
            why["state"] = json!("unavailable");
            why
        }
        None => json!({ "state": "available" }),
    }
}

/// The refusal a team start gives when `availability` says unavailable, in
/// the words `tmm agent backends` uses; None otherwise (unknown never
/// refuses). The whole team is refused: no member starts.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn team_refusal(team: &str, availability: &Value) -> Option<String> {
    if availability["state"] != "unavailable" {
        return None;
    }
    let s = |k: &str| availability[k].as_str().unwrap_or("").to_string();
    let what = crate::backends::readiness::unusable_text(availability);
    Some(format!("team '{team}' cannot start on this server: member '{}' runs on {}, which is {what}. Nothing was started.", s("member"), s("backend")))
}

/// One agent's availability (board #7): `unknown` with no readiness report,
/// else `unavailable` with the reason and any missing names where the one
/// rule greys its BACKEND, else `available`.
fn agent_availability(backend: &str, checked: bool, grey: &dyn Fn(&str) -> Option<Value>) -> Value {
    if !checked {
        return json!({ "state": "unknown" });
    }
    match grey(backend) {
        Some(why) => json!({ "state": "unavailable", "reason": why["reason"], "missing": why["missing"] }),
        None => json!({ "state": "available" }),
    }
}

/// The refusal a single start gives (board #15: `hub_spawn`, so `tmm spawn
/// <agent>` and the UI's start alike) when the agent's availability is
/// unavailable, in the team refusal's words; None otherwise (unknown never
/// refuses).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn agent_refusal(def: &store::RegAgent, checked: bool, grey: &dyn Fn(&str) -> Option<Value>) -> Option<String> {
    let availability = agent_availability(&def.backend, checked, grey);
    if availability["state"] != "unavailable" {
        return None;
    }
    let what = crate::backends::readiness::unusable_text(&availability);
    Some(format!("agent '{}' cannot start on this server: it runs on {}, which is {what}. Nothing was started.", def.name, def.backend))
}

/// The listed shape (board #7): each definition with its `group` and its
/// `availability`, in the store's order. ONE place decides both, so the
/// Agents page, every spawn picker and `tmm registry list` agree.
/// - group `default`: named after a supported backend and on it (the seeds,
///   agents-overview.md § Registry defaults); everything else is `custom`.
/// - availability: `unknown` with no readiness report; otherwise
///   `unavailable` (with the reason and any missing names) where the one rule
///   (`readiness::unavailable`) says so, else `available`.
pub(crate) fn annotate(agents: Vec<crate::projects::store::RegAgent>, checked: bool, grey: impl Fn(&str) -> Option<Value>) -> Value {
    let rows: Vec<Value> = agents
        .into_iter()
        .map(|a| {
            let default = crate::backends::Backend::parse(&a.name).is_some() && a.backend == a.name;
            let availability = agent_availability(&a.backend, checked, &grey);
            let mut v = serde_json::to_value(&a).unwrap_or_else(|_| json!({}));
            if let Some(o) = v.as_object_mut() {
                o.insert("group".into(), json!(if default { "default" } else { "custom" }));
                o.insert("availability".into(), availability);
            }
            v
        })
        .collect();
    json!({ "agents": rows })
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
        // Board #7: each team's availability, through the one rule, read
        // before the masking (which changes no backend).
        let agents = store.reg_list()?;
        let (checked, grey) = availability_view();
        let all = teams.clone();
        let lookup = |n: &str| Ok(all.iter().find(|t| t.name == n).cloned());
        let availability: Vec<Value> = teams.iter().map(|t| team_availability(t, &agents, checked, &*grey, &lookup)).collect();
        // Every inline agent's MCP values masked (board #451).
        for t in &mut teams {
            t.members = mcp_mask::masked_team(&t.name, &t.members)?;
        }
        let rows: Vec<Value> = teams
            .iter()
            .zip(availability)
            .map(|(t, av)| {
                let mut v = serde_json::to_value(t).unwrap_or_else(|_| json!({}));
                if let Some(o) = v.as_object_mut() {
                    o.insert("availability".into(), av);
                }
                v
            })
            .collect();
        Ok(json!({ "teams": rows }))
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

#[cfg(test)]
mod listing_tests {
    use super::*;
    use crate::projects::store::RegAgent;

    fn a(name: &str, backend: &str) -> RegAgent {
        RegAgent { name: name.into(), backend: backend.into(), model: String::new(), effort: String::new(), input_mode: "queue".into(), system: String::new(), skills: "[]".into(), mcp: "[]".into() }
    }

    /// Board #7: each listed agent says its group and its availability. A
    /// harness default is a definition named after a supported backend AND
    /// on it; anything else, a renamed or rebased one included, is custom.
    /// Availability comes from the one rule over the server's last report;
    /// with none it is unknown and nothing greys.
    #[test]
    fn the_list_says_each_agents_group_and_availability() {
        let agents = vec![a("kiro", "kiro"), a("grok", "grok"), a("dsh", "dsh"), a("codex", "claude"), a("pentester", "kiro"), a("grokker", "grok")];
        let grey = |b: &str| (b == "grok" || b == "dsh").then(|| json!({ "reason": "not_found", "missing": [] }));
        let listed = annotate(agents.clone(), true, grey);
        let rows = listed["agents"].as_array().unwrap();
        let view: Vec<(&str, &str, &str)> = rows.iter().map(|r| (r["name"].as_str().unwrap(), r["group"].as_str().unwrap(), r["availability"]["state"].as_str().unwrap())).collect();
        assert_eq!(view, [
            ("kiro", "default", "available"),
            ("grok", "default", "unavailable"),
            ("dsh", "default", "unavailable"),
            ("codex", "custom", "available"),
            ("pentester", "custom", "available"),
            ("grokker", "custom", "unavailable"),
        ], "the list order is kept; the client partitions it");
        assert_eq!(rows[1]["availability"], json!({ "state": "unavailable", "reason": "not_found", "missing": [] }));
        assert_eq!(rows[0]["system"], "", "the definition's own fields are all still there");

        let unchecked = annotate(agents, false, grey);
        assert!(unchecked["agents"].as_array().unwrap().iter().all(|r| r["availability"] == json!({ "state": "unknown" })), "no report greys nothing");
    }

    /// Board #7 (orchestrator 07:46): a team with any unavailable member says
    /// which member and why; with no readiness report it is unknown; and the
    /// start refuses with the same reason, never starting part of the team.
    #[test]
    fn a_team_says_which_member_makes_it_unavailable_and_its_start_refuses() {
        use crate::projects::store::RegTeam;
        let agents = vec![a("builder", "kiro"), a("scout", "grok")];
        let grey = |b: &str| (b == "grok").then(|| json!({ "reason": "not_found", "missing": [] }));
        let lookup = |_: &str| Ok(None);
        let team = |m: &str| RegTeam { name: "squad".into(), description: String::new(), members: m.into() };
        let bad = team(r#"[{"name":"b","base":"builder"},{"name":"s","base":"scout"}]"#);
        let good = team(r#"[{"name":"b","base":"builder"}]"#);
        assert_eq!(team_availability(&bad, &agents, true, &grey, &lookup),
            json!({ "state": "unavailable", "member": "s", "backend": "grok", "reason": "not_found", "missing": [] }));
        assert_eq!(team_availability(&good, &agents, true, &grey, &lookup), json!({ "state": "available" }));
        assert_eq!(team_availability(&bad, &agents, false, &grey, &lookup), json!({ "state": "unknown" }), "no report greys nothing");
        assert_eq!(team_availability(&team("[]"), &agents, true, &grey, &lookup), json!({ "state": "available" }), "an unexpandable team is spawn's error, not availability's");
        assert_eq!(
            team_refusal("squad", &team_availability(&bad, &agents, true, &grey, &lookup)).as_deref(),
            Some("team 'squad' cannot start on this server: member 's' runs on grok, which is not on the managed PATH. Nothing was started.")
        );
        let dsh = json!({ "state": "unavailable", "member": "d", "backend": "dsh", "reason": "env_unset", "missing": ["DEEPSEEK_API_KEY"] });
        assert_eq!(team_refusal("t", &dsh).as_deref(), Some("team 't' cannot start on this server: member 'd' runs on dsh, which is missing DEEPSEEK_API_KEY (not set in the login shell's environment). Nothing was started."));
        assert_eq!(team_refusal("t", &json!({ "state": "unknown" })), None, "unknown never refuses");
        assert_eq!(team_refusal("t", &json!({ "state": "available" })), None);
    }

    /// Board #15: a single start refuses an agent whose harness the one rule
    /// greys, in the words the team refusal and `tmm registry list` use; the
    /// agent's BACKEND decides, so a custom agent on grok is refused too.
    /// No report (unknown) never refuses.
    #[test]
    fn a_single_start_refuses_an_unavailable_agent_in_the_team_refusals_words() {
        let grey = |b: &str| match b {
            "grok" => Some(json!({ "reason": "not_found", "missing": [] })),
            "dsh" => Some(json!({ "reason": "env_unset", "missing": ["DEEPSEEK_API_KEY"] })),
            _ => None,
        };
        assert_eq!(agent_refusal(&a("grok", "grok"), true, &grey).as_deref(),
            Some("agent 'grok' cannot start on this server: it runs on grok, which is not on the managed PATH. Nothing was started."));
        assert_eq!(agent_refusal(&a("grokker", "grok"), true, &grey).as_deref(),
            Some("agent 'grokker' cannot start on this server: it runs on grok, which is not on the managed PATH. Nothing was started."));
        assert_eq!(agent_refusal(&a("dsh", "dsh"), true, &grey).as_deref(),
            Some("agent 'dsh' cannot start on this server: it runs on dsh, which is missing DEEPSEEK_API_KEY (not set in the login shell's environment). Nothing was started."));
        assert_eq!(agent_refusal(&a("kiro", "kiro"), true, &grey), None);
        assert_eq!(agent_refusal(&a("grok", "grok"), false, &grey), None, "unknown never refuses");
    }
}
