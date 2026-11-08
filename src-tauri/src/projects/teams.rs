//! Agent TEAMS (owner, 2026-09-02, board #74): "除了定制 agent 之外，我们可以
//! 定义 agent team，可以看作是 agent 加上一个特定的角色补充设定，组成一个小组".
//!
//! A team is a named list of members. Each member has ONE source:
//! - a bare coding agent (`agent` = full inline backend/model/prompt/Skills/MCP);
//! - a custom registry agent inherited through `base`, plus a team role;
//! - another team inherited through `team`, plus an enclosing brief.
//!
//! A member may also be another TEAM (`team` = its name; owner, 2026-09-02:
//! "应该在 dev 里直接加 review 小组…设计成可以嵌套的"): `expand` flattens the
//! tree depth-first, refuses cycles, and every leaf remembers the PATH it came
//! in on (`dev/review`) so the roster can draw the nesting and each member's
//! prompt can say which team it sits in.
//!
//! Spawning a team spawns every member as an ordinary managed agent (same
//! isolated home, same hooks, same `tmm`), so nothing downstream learns a new
//! species: the ONLY additions are the role block in the prompt, a roster
//! block naming every teammate (so they can `@` each other on day one), and a
//! `team` field in the launch recipe that lets the Hub group the cards.
//! The pure parts live here and are tested without tmux.

use serde::{Deserialize, Serialize};

use super::store::{RegAgent, RegTeam};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    /// The member's name in the team — becomes its window name (uniquified
    /// against the project if taken) and its `@name`. Empty for a `team` ref.
    #[serde(default)]
    pub name: String,
    /// Custom registry agent inherited whole. Empty = `agent` carries a bare
    /// coding-agent definition (or `team` names a sub-team).
    #[serde(default)]
    pub base: String,
    /// Another team, included whole (nesting). Its members are spawned as if
    /// listed here; `role` then applies to every one of them as an extra
    /// brief. `name`/`base`/`agent` are ignored for this kind.
    #[serde(default)]
    pub team: String,
    /// Role supplement, appended to the base persona.
    #[serde(default)]
    pub role: String,
    /// Model / effort OVERRIDES for a derived member (owner, 2026-09-02: kiro
    /// offers many models with no quota, so one base agent can be the seed of
    /// four reviewers on four different models). Empty = the base's own.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// Input-mode OVERRIDE for a derived member (board #245/#254): `queue` or
    /// `steer`, empty = the base's own mode. Same contract as model/effort,
    /// and additive in the members JSON (absent reads as empty), so a saved
    /// team needs no migration.
    #[serde(default)]
    pub input_mode: String,
    /// Complete definition for a bare coding agent. Its `name` is ignored in
    /// favour of the member name. Registry and sub-team members leave it empty.
    #[serde(default)]
    pub agent: Option<RegAgent>,
}

pub fn parse_members(team: &RegTeam) -> Result<Vec<Member>, String> {
    serde_json::from_str::<Vec<Member>>(&team.members).map_err(|e| format!("team '{}': members must be a JSON array of member objects {}", team.name, super::mcp_mask::no_echo(&e)))
}

/// Everything `teams_save` refuses. `known` = registry agent names; `cap` =
/// the project spawn cap, because a team that can never fully start is a
/// trap, not a configuration.
pub fn validate(team: &RegTeam, known: &[String], known_teams: &[String], cap: usize) -> Result<Vec<Member>, String> {
    // A team name becomes a path segment in the roster and the `team` field
    // of every member's recipe; a member name becomes a window name, a home
    // directory and an @address. Same word rule as an agent, for the same
    // reasons (`agents::valid_name`).
    super::agents::valid_name(team.name.trim()).map_err(|e| e.replacen("agent name", "team name", 1))?;
    let members = parse_members(team)?;
    if members.is_empty() {
        return Err("a team needs at least one member".into());
    }
    if members.len() > cap {
        return Err(format!("a team may have at most {cap} members (the project spawn cap), got {}", members.len()));
    }
    let mut seen = std::collections::HashSet::new();
    for m in &members {
        if !m.team.trim().is_empty() {
            let t = m.team.trim();
            if t == team.name.trim() {
                return Err(format!("team '{t}' cannot include itself"));
            }
            if !known_teams.iter().any(|k| k == t) {
                return Err(format!("sub-team '{t}' does not exist"));
            }
            if !seen.insert(format!("team:{t}")) {
                return Err(format!("sub-team '{t}' is included twice"));
            }
            continue;
        }
        let n = m.name.trim();
        if n.is_empty() {
            return Err("every member needs a name".into());
        }
        super::agents::valid_name(n).map_err(|e| e.replacen("agent name", "member name", 1))?;
        if !seen.insert(n.to_string()) {
            return Err(format!("member name '{n}' is used twice"));
        }
        if m.base.trim().is_empty() {
            let a = m.agent.as_ref().ok_or_else(|| format!("member '{n}' has neither a base agent nor an inline definition"))?;
            if !super::agents::SPAWNABLE_BACKENDS.contains(&a.backend.as_str()) {
                return Err(format!(
                    "member '{n}': backend must be {}, got '{}'",
                    super::agents::SPAWNABLE_BACKENDS.join("|"),
                    a.backend
                ));
            }
        } else if !known.iter().any(|k| k == m.base.trim()) {
            return Err(format!("member '{n}' derives from '{}', which is not in the registry", m.base));
        }
    }
    Ok(members)
}

/// One spawnable leaf of a (possibly nested) team.
#[derive(Debug, Clone)]
pub struct Flat {
    pub member: Member,
    /// The team the member is DECLARED in (its block names this one).
    pub team: RegTeam,
    /// Nesting path from the root, `dev/review`; the root alone for a direct
    /// member. Recorded in the launch recipe; the roster groups on it.
    pub path: String,
    /// Extra briefs inherited from every enclosing `team` reference's `role`,
    /// outermost first.
    pub briefs: Vec<String>,
}

/// Flatten a team depth-first. `lookup` resolves a sub-team by name; a cycle
/// (a team reaching itself through any chain) is an error, as is a total
/// beyond `cap` — a team that can never fully start is a trap.
pub fn expand(root: &RegTeam, lookup: &dyn Fn(&str) -> Result<Option<RegTeam>, String>, cap: usize) -> Result<Vec<Flat>, String> {
    fn walk(team: &RegTeam, path: &str, briefs: &[String], stack: &mut Vec<String>, out: &mut Vec<Flat>, lookup: &dyn Fn(&str) -> Result<Option<RegTeam>, String>) -> Result<(), String> {
        if stack.iter().any(|s| s == &team.name) {
            return Err(format!("team nesting cycle: {} → {}", stack.join(" → "), team.name));
        }
        stack.push(team.name.clone());
        for m in parse_members(team)? {
            if !m.team.trim().is_empty() {
                let sub = lookup(m.team.trim())?.ok_or_else(|| format!("sub-team '{}' (in '{}') does not exist", m.team, team.name))?;
                let mut inner = briefs.to_vec();
                if !m.role.trim().is_empty() {
                    inner.push(m.role.trim().to_string());
                }
                walk(&sub, &format!("{path}/{}", sub.name), &inner, stack, out, lookup)?;
            } else {
                out.push(Flat { member: m, team: team.clone(), path: path.to_string(), briefs: briefs.to_vec() });
            }
        }
        stack.pop();
        Ok(())
    }
    let mut out = Vec::new();
    let mut stack = Vec::new();
    walk(root, &root.name, &[], &mut stack, &mut out, lookup)?;
    if out.is_empty() {
        return Err(format!("team '{}' has no members", root.name));
    }
    if out.len() > cap {
        return Err(format!("team '{}' expands to {} agents, more than the project spawn cap {cap}", root.name, out.len()));
    }
    Ok(out)
}

/// The first member of a flattened team whose harness the one availability
/// rule greys (board #7), as `{member, backend, reason, missing}`; None when
/// every member can run. `base_backend` resolves a base definition's backend,
/// and `grey` is the rule over the server's last readiness report. A member
/// whose base cannot be resolved is skipped: spawn names that error itself.
pub fn unavailable_member(flat: &[Flat], base_backend: &dyn Fn(&str) -> Option<String>, grey: &dyn Fn(&str) -> Option<serde_json::Value>) -> Option<serde_json::Value> {
    flat.iter().find_map(|f| {
        let m = &f.member;
        let backend = if m.base.trim().is_empty() { m.agent.as_ref().map(|a| a.backend.clone()) } else { base_backend(m.base.trim()) }?;
        let why = grey(&backend)?;
        Some(serde_json::json!({ "member": m.name.trim(), "backend": backend, "reason": why["reason"], "missing": why["missing"] }))
    })
}

/// One roster line's raw material: final window name, role, nesting path,
/// member name (board #80: what the team's own texts call it).
pub type RosterEntry = (String, String, String, String);

/// Every member's final window name, in `flat` order (board #74): the one
/// recorded in its home's recipe (`home`), else its member name uniquified
/// against `taken` (every window and home the project has) and each name
/// chosen before it. So a team started beside another, or twice, gets
/// `builder-2`, and every prompt's roster names the windows that will exist.
pub fn final_roster(flat: &[Flat], mut taken: std::collections::HashSet<String>, home: &dyn Fn(&Flat) -> Option<String>) -> Result<Vec<RosterEntry>, String> {
    let mut roster = Vec::new();
    for f in flat {
        let w = match home(f) {
            Some(w) => w,
            None => super::spawn::uniquify(f.member.name.trim(), &taken.iter().map(String::as_str).collect())?,
        };
        taken.insert(w.clone());
        roster.push((w, f.member.role.clone(), f.path.clone(), f.member.name.trim().to_string()));
    }
    Ok(roster)
}

/// A team text as a member started under `roster`'s final names reads it
/// (board #80): each `@<member>` of THIS team, read in the text's own
/// sub-team `path`, becomes that member's final name. A name declared once
/// in the team is found anywhere; one declared in several sub-teams only in
/// `path`. A team started alone (final = member names) reads unchanged.
fn readdressed(text: &str, path: &str, roster: &[RosterEntry]) -> String {
    let to = |name: &str| {
        let named: Vec<&RosterEntry> = roster.iter().filter(|e| e.3 == name).collect();
        let here = named.iter().find(|e| e.2 == path);
        here.or(if named.len() == 1 { named.first() } else { None }).filter(|e| e.0 != name).map(|e| e.0.clone())
    };
    crate::address::readdress(text, &to)
}

/// A team's description as instructions, if it has any: the ONE rule for what a
/// team's text is, shared by a member's own block, a fork's sub-team line and a
/// joiner's block.
fn description_of(team: &RegTeam) -> Option<&str> {
    let d = team.description.trim();
    (!d.is_empty()).then_some(d)
}

/// A member's definition before any team text: its base (or inline) agent, named
/// `window_name`, with the member's own model / effort / input-mode overrides.
fn member_def(flat: &Flat, base: Option<&RegAgent>, window_name: &str) -> Result<RegAgent, String> {
    let member = &flat.member;
    let mut def = match (member.base.trim().is_empty(), base, &member.agent) {
        (false, Some(b), _) => b.clone(),
        (false, None, _) => return Err(format!("member '{}' derives from '{}', which is not in the registry", member.name, member.base)),
        (true, _, Some(a)) => a.clone(),
        (true, _, None) => return Err(format!("member '{}' has neither a base agent nor an inline definition", member.name)),
    };
    def.name = window_name.to_string();
    if !member.model.trim().is_empty() {
        def.model = member.model.trim().to_string();
    }
    if !member.effort.trim().is_empty() {
        def.effort = member.effort.trim().to_string();
    }
    if !member.input_mode.trim().is_empty() {
        def.input_mode = member.input_mode.trim().to_string();
    }
    Ok(def)
}

/// A FORK of a team member (board #383): the member's definition — its base, its
/// overrides, its role and the briefs of the enclosing teams — WITHOUT a team
/// section. The fork is a joined agent, and the one team section (the team, its
/// teammates, "you joined") is built by `joined_block` when it is materialized
/// (board #382); `effective_def`'s own block would make a second one.
pub fn forked_def(flat: &Flat, base: Option<&RegAgent>, window_name: &str) -> Result<RegAgent, String> {
    let mut def = member_def(flat, base, window_name)?;
    let mut extra = Vec::new();
    // The member's OWN (sub-)team's rules travel with it. The root's description is
    // the new team section's (`joined_block`), so it is not repeated here.
    let root = flat.path.split('/').next().unwrap_or(&flat.team.name);
    if flat.team.name != root {
        if let Some(d) = description_of(&flat.team) {
            extra.push(format!("Your sub-team \"{}\" (within \"{root}\"): {d}", flat.team.name));
        }
    }
    if !flat.member.role.trim().is_empty() {
        extra.push(format!("Your role: {}", flat.member.role.trim()));
    }
    extra.extend(flat.briefs.iter().map(|b| format!("From the enclosing team: {b}")));
    if !extra.is_empty() {
        let system = def.system.trim();
        let extra = extra.join("\n");
        def.system = if system.is_empty() { extra } else { format!("{system}\n\n{extra}") };
    }
    Ok(def)
}

/// The definition a member actually spawns with: the base (or inline) def,
/// renamed to the member, with the role and the team roster appended to its
/// persona. `roster` is every member's FINAL window name + role, in order —
/// computed by the caller after uniquifying, so the names in the prompt are
/// the names that exist.
pub fn effective_def(flat: &Flat, base: Option<&RegAgent>, window_name: &str, roster: &[RosterEntry]) -> Result<RegAgent, String> {
    let team = &flat.team;
    let member = &flat.member;
    let mut def = member_def(flat, base, window_name)?;
    let mut system = def.system.trim().to_string();
    let mut block = format!("## Your team: \"{}\"", team.name);
    let root = flat.path.split('/').next().unwrap_or(&team.name);
    if root != team.name {
        block += &format!(" (a sub-team within \"{root}\": {})", flat.path);
    }
    // Board #80: the team's texts address members by MEMBER name; this copy's are its final names.
    let ours = |text: &str, path: &str| readdressed(text, path, roster);
    if let Some(d) = description_of(team) {
        block += &format!("\n{}", ours(d, &flat.path));
    }
    block += &format!("\n\nYou are \"{window_name}\".");
    if !member.role.trim().is_empty() {
        block += &format!(" Your role: {}", ours(member.role.trim(), &flat.path));
    }
    for b in &flat.briefs {
        block += &format!("\nFrom the enclosing team: {}", ours(b, &flat.path));
    }
    let mates: Vec<String> = roster
        .iter()
        .filter(|(n, _, _, _)| n != window_name)
        .map(|(n, r, p, _)| {
            let tag = if p != &flat.path { format!(" [{p}]") } else { String::new() };
            if r.trim().is_empty() { format!("@{n}{tag}") } else { format!("@{n}{tag} — {}", one_line(&ours(r, p))) }
        })
        .collect();
    if !mates.is_empty() {
        block += "\nYour teammates (address one with `tmm send \"@name …\"`; a [path] marks a different sub-team):\n";
        for m in mates {
            block += &format!("- {m}\n");
        }
    }
    if !system.is_empty() {
        system += "\n\n";
    }
    system += block.trim_end();
    def.system = system;
    Ok(def)
}

/// The team block of an agent that JOINED a running team (board #382): it
/// was spawned on its own and put in the team at runtime, so the team's
/// definition does not list it and `effective_def` never builds it a block.
/// A member that does not know its team is not in it (orchestrator's ruling):
/// it is told the team's name and description, its own name, and every
/// teammate this project has (`mates`: window, team path, member name off the
/// recipes; a member name of '' is another joiner), each with the role the
/// CURRENT definition gives that member, which is how a lead or orchestrator
/// is named, since a definition has no lead field. `team`/`flat` are absent
/// for a team whose definition is gone. Pure.
/// The role the definition gives the member at (`path`, `member`): the ONE
/// reading of a teammate's role off the recipes (board #382; #384's move
/// notice too). By path AND name, because sub-teams may each have a `dev`;
/// '' for a joiner (no member) or a member the definition no longer has.
pub fn member_role(flat: &[Flat], path: &str, member: &str) -> String {
    flat.iter()
        .find(|f| f.path == path && !member.is_empty() && f.member.name.trim() == member)
        .map(|f| f.member.role.trim().to_string())
        .unwrap_or_default()
}

/// A team block's own-name sentence (`You are "<window>".`, written by
/// `effective_def` and `joined_block`) as the project shows the agent (board
/// #20): its label. The one place that knows the sentence's shape maps it.
pub fn shown_self(system: &str, window_name: &str, shown: &str) -> String {
    if window_name == shown {
        return system.to_string();
    }
    system.replace(&format!("You are \"{window_name}\"."), &format!("You are \"{shown}\"."))
}

pub fn joined_block(root: &str, team: Option<&RegTeam>, flat: &[Flat], window_name: &str, mates: &[(String, String, String)]) -> String {
    let mut block = format!("## Your team: \"{root}\"");
    if let Some(d) = team.and_then(description_of) {
        block += &format!("\n{d}");
    }
    block += &format!("\n\nYou are \"{window_name}\". You joined this team when you were started; its definition does not list you.");
    let role = |path: &str, member: &str| member_role(flat, path, member);
    let order = |path: &str, member: &str| flat.iter()
        .position(|f| f.path == path && !member.is_empty() && f.member.name.trim() == member)
        .unwrap_or(usize::MAX);
    let mut others: Vec<&(String, String, String)> = mates.iter().filter(|(w, _, _)| w != window_name).collect();
    others.sort_by(|a, b| (order(&a.1, &a.2), &a.0).cmp(&(order(&b.1, &b.2), &b.0)));
    if !others.is_empty() {
        block += "\nYour teammates (address one with `tmm send \"@name …\"`; a [path] marks a different sub-team):\n";
        for (w, path, member) in others {
            let tag = if path != root { format!(" [{path}]") } else { String::new() };
            let r = role(path, member);
            block += &if r.is_empty() { format!("- @{w}{tag}\n") } else { format!("- @{w}{tag} — {}\n", one_line(&r)) };
        }
    }
    block.trim_end().to_string()
}

/// A role's first sentence-ish, for the roster line: one line, ≤120 chars.
fn one_line(role: &str) -> String {
    let flat = role.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 120 {
        let cut: String = flat.chars().take(119).collect();
        format!("{}…", cut.trim_end())
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, system: &str) -> RegAgent {
        RegAgent { name: name.into(), backend: "claude".into(), model: String::new(), effort: String::new(), input_mode: "queue".into(), omp_tools: false, system: system.into(), skills: "[]".into(), mcp: "[]".into() }
    }
    fn team(members: &str) -> RegTeam {
        RegTeam { name: "dev-squad".into(), description: "Ships features end to end.".into(), members: members.into() }
    }
    fn named(name: &str, members: &str) -> RegTeam {
        RegTeam { name: name.into(), description: String::new(), members: members.into() }
    }
    fn flat_of(t: &RegTeam, i: usize) -> Flat {
        Flat { member: parse_members(t).unwrap().remove(i), team: t.clone(), path: t.name.clone(), briefs: vec![] }
    }
    const NO_TEAMS: &[String] = &[];

    /// Board #7 (orchestrator 07:46): a team is unavailable when ANY member,
    /// nested ones included, runs on a harness the one rule greys: the first
    /// such member, with its backend and reason. A member resolves to its
    /// base definition's backend, or its inline agent's.
    #[test]
    fn a_team_is_unavailable_through_its_first_unavailable_member() {
        let grey = |b: &str| (b == "grok" || b == "dsh").then(|| serde_json::json!({ "reason": "not_found", "missing": [] }));
        let base = |n: &str| match n { "builder" => Some("kiro".to_string()), "scout" => Some("grok".to_string()), _ => None };
        let lookup = |n: &str| Ok(match n { "inner" => Some(named("inner", r#"[{"name":"d","agent":{"name":"d","backend":"dsh"}}]"#)), _ => None });
        let ok = team(r#"[{"name":"b","base":"builder"},{"name":"c","agent":{"name":"c","backend":"claude"}}]"#);
        assert_eq!(unavailable_member(&expand(&ok, &lookup, 8).unwrap(), &base, &grey), None);
        let by_base = team(r#"[{"name":"b","base":"builder"},{"name":"s","base":"scout"},{"name":"d2","agent":{"name":"d2","backend":"dsh"}}]"#);
        assert_eq!(unavailable_member(&expand(&by_base, &lookup, 8).unwrap(), &base, &grey),
            Some(serde_json::json!({ "member": "s", "backend": "grok", "reason": "not_found", "missing": [] })), "the first, by its base");
        let nested = team(r#"[{"name":"b","base":"builder"},{"team":"inner"}]"#);
        assert_eq!(unavailable_member(&expand(&nested, &lookup, 8).unwrap(), &base, &grey).unwrap()["member"], "d", "a nested inline member counts");
        let unresolved = team(r#"[{"name":"x","base":"gone"}]"#);
        assert_eq!(unavailable_member(&expand(&unresolved, &lookup, 8).unwrap(), &base, &grey), None, "an unresolved base is spawn's error to name, not availability's");
    }

    #[test]
    fn validate_pins_the_shape() {
        let known = vec!["claude".to_string(), "codex".to_string()];
        let ok = team(r#"[{"name":"dev","base":"claude","role":"implement"},{"name":"rev","base":"codex","role":"review"}]"#);
        assert_eq!(validate(&ok, &known, NO_TEAMS, 4).unwrap().len(), 2);
        assert!(validate(&team("[]"), &known, NO_TEAMS, 4).unwrap_err().contains("at least one"));
        assert!(validate(&team(r#"[{"name":"a","base":"nope"}]"#), &known, NO_TEAMS, 4).unwrap_err().contains("not in the registry"));
        assert!(validate(&team(r#"[{"name":"a","base":"claude"},{"name":"a","base":"codex"}]"#), &known, NO_TEAMS, 4).unwrap_err().contains("used twice"));
        // Member names obey the agent name rule — one word, a window name, a
        // home directory and an @address (`agents::valid_name`).
        assert!(validate(&team(r#"[{"name":"two words","base":"claude"}]"#), &known, NO_TEAMS, 4).unwrap_err().contains("member name"));
        assert!(validate(&team(r#"[{"name":"../..","base":"claude"}]"#), &known, NO_TEAMS, 4).unwrap_err().contains("member name"));
        assert!(validate(&team(r#"[{"name":"a","base":"claude"},{"name":"b","base":"claude"},{"name":"c","base":"claude"}]"#), &known, NO_TEAMS, 2).unwrap_err().contains("at most 2"));
        // inline, team-only member: needs a real backend
        assert!(validate(&team(r#"[{"name":"x","agent":{"name":"","backend":"gpt"}}]"#), &known, NO_TEAMS, 4).unwrap_err().contains("backend must be"));
        assert_eq!(validate(&team(r#"[{"name":"x","agent":{"name":"","backend":"grok"}}]"#), &known, NO_TEAMS, 4).unwrap().len(), 1);
        assert!(validate(&team(r#"[{"name":"x"}]"#), &known, NO_TEAMS, 4).unwrap_err().contains("neither"));
        // sub-team references (nesting)
        let teams = vec!["review".to_string()];
        assert_eq!(validate(&team(r#"[{"name":"lead","base":"claude"},{"team":"review"}]"#), &known, &teams, 4).unwrap().len(), 2, "a team ref needs no name");
        assert!(validate(&team(r#"[{"team":"nope"}]"#), &known, &teams, 4).unwrap_err().contains("does not exist"));
        assert!(validate(&team(r#"[{"team":"dev-squad"}]"#), &known, &teams, 4).unwrap_err().contains("include itself"));
        assert!(validate(&team(r#"[{"team":"review"},{"team":"review"}]"#), &known, &teams, 4).unwrap_err().contains("included twice"));
        assert!(validate(&named("a/b", r#"[{"team":"review"}]"#), &known, &teams, 4).unwrap_err().contains("team name"));
    }

    #[test]
    fn expand_flattens_nesting_with_paths_briefs_and_refuses_cycles() {
        let dev = named("dev", r#"[{"name":"lead","base":"claude","role":"lead"},{"team":"review","role":"Review what dev moves to review."}]"#);
        let review = named("review", r#"[{"name":"r1","base":"claude","role":"design"},{"name":"r2","base":"claude","role":"security"}]"#);
        let lookup = |n: &str| -> Result<Option<RegTeam>, String> { Ok(match n { "review" => Some(review.clone()), "dev" => Some(dev.clone()), _ => None }) };
        let flat = expand(&dev, &lookup, 8).unwrap();
        assert_eq!(flat.iter().map(|f| f.member.name.as_str()).collect::<Vec<_>>(), ["lead", "r1", "r2"]);
        assert_eq!(flat[0].path, "dev");
        assert_eq!(flat[1].path, "dev/review", "a nested leaf remembers the path it came in on");
        assert_eq!(flat[1].team.name, "review", "and the team whose block names it");
        assert_eq!(flat[1].briefs, vec!["Review what dev moves to review.".to_string()], "the ref's role becomes a brief for every sub-member");
        assert!(expand(&dev, &lookup, 2).unwrap_err().contains("expands to 3"), "the cap applies to the EXPANSION");
        // a cycle: review includes dev
        let review_cyc = named("review", r#"[{"team":"dev"}]"#);
        let lookup2 = |n: &str| -> Result<Option<RegTeam>, String> { Ok(match n { "review" => Some(review_cyc.clone()), "dev" => Some(dev.clone()), _ => None }) };
        assert!(expand(&dev, &lookup2, 8).unwrap_err().contains("cycle"));
        assert!(expand(&named("x", r#"[{"team":"ghost"}]"#), &lookup, 8).unwrap_err().contains("does not exist"));
    }

    #[test]
    fn effective_def_derives_renames_and_names_the_teammates() {
        let t = team(r#"[{"name":"dev","base":"claude","role":"implement the change"},{"name":"rev","base":"claude","role":"review every diff before it merges"}]"#);
        let base = agent("claude", "You are a 10x developer.");
        let roster: Vec<RosterEntry> = vec![("dev".into(), "implement the change".into(), "dev-squad".into(), "dev".into()), ("rev-2".into(), "review every diff before it merges".into(), "dev-squad".into(), "rev".into())];
        let d = effective_def(&flat_of(&t, 0), Some(&base), "dev", &roster).unwrap();
        assert_eq!(d.name, "dev", "the member name is the identity, not the base's");
        assert_eq!(d.backend, "claude", "everything else is inherited");
        assert!(d.system.starts_with("You are a 10x developer."), "base persona first");
        assert!(d.system.contains("## Your team: \"dev-squad\""));
        assert!(!d.system.contains("sub-team within"), "a root member is not told about nesting");
        assert!(d.system.contains("Ships features end to end."));
        assert!(d.system.contains("You are \"dev\". Your role: implement the change"));
        assert!(d.system.contains("- @rev-2 — review every diff"), "the roster uses the FINAL (uniquified) names");
        assert!(!d.system.contains("- @dev"), "never lists itself");
    }

    #[test]
    fn effective_def_nested_member_knows_its_path_briefs_and_tags_other_subteams() {
        let review = named("review", r#"[{"name":"r1","base":"claude","role":"design"}]"#);
        let f = Flat { member: parse_members(&review).unwrap().remove(0), team: review.clone(), path: "dev/review".into(), briefs: vec!["Review what dev moves to review.".into()] };
        let roster: Vec<RosterEntry> = vec![("lead".into(), "lead".into(), "dev".into(), "lead".into()), ("r1".into(), "design".into(), "dev/review".into(), "r1".into())];
        let d = effective_def(&f, Some(&agent("claude", "")), "r1", &roster).unwrap();
        assert!(d.system.contains("## Your team: \"review\" (a sub-team within \"dev\": dev/review)"));
        assert!(d.system.contains("From the enclosing team: Review what dev moves to review."));
        assert!(d.system.contains("- @lead [dev] — lead"), "a teammate in another sub-team is tagged with its path");
    }

    #[test]
    fn effective_def_inline_member_ignores_the_inline_name() {
        let t = team(r#"[{"name":"critic","role":"find holes","agent":{"name":"whatever","backend":"grok","system":"Be harsh.","skills":"[\"eli5\"]","mcp":"[\"search\"]"}}]"#);
        let d = effective_def(&flat_of(&t, 0), None, "critic", &[("critic".into(), "find holes".into(), "dev-squad".into(), "critic".into())]).unwrap();
        assert_eq!(d.name, "critic");
        assert_eq!(d.backend, "grok");
        assert!(d.system.starts_with("Be harsh."));
        assert_eq!(d.skills, r#"["eli5"]"#, "bare Skills reach the ordinary spawn path");
        assert_eq!(d.mcp, r#"["search"]"#, "bare MCP reaches the ordinary spawn path");
        assert!(!d.system.contains("teammates"), "a one-member team has no roster block");
        let gone = Flat { member: Member { name: "x".into(), base: "gone".into(), team: String::new(), role: String::new(), model: String::new(), effort: String::new(), input_mode: String::new(), agent: None }, team: t.clone(), path: t.name.clone(), briefs: vec![] };
        assert!(effective_def(&gone, None, "x", &[]).is_err());
    }

    #[test]
    fn effective_def_applies_model_and_effort_overrides() {
        let t = team(r#"[{"name":"a","base":"kiro","model":"claude-opus-5","effort":"high"},{"name":"b","base":"kiro"}]"#);
        let mut base = agent("kiro", "");
        base.backend = "kiro".into();
        base.model = "auto".into();
        let a = effective_def(&flat_of(&t, 0), Some(&base), "a", &[]).unwrap();
        assert_eq!((a.model.as_str(), a.effort.as_str()), ("claude-opus-5", "high"), "an override replaces the base's");
        let b = effective_def(&flat_of(&t, 1), Some(&base), "b", &[]).unwrap();
        assert_eq!((b.model.as_str(), b.effort.as_str()), ("auto", ""), "empty keeps the base's");
    }

    /// Board #254: a derived member may override the base's input mode like
    /// model/effort; empty inherits it.
    #[test]
    fn effective_def_applies_an_input_mode_override() {
        let t = team(r#"[{"name":"a","base":"kiro","input_mode":"steer"},{"name":"b","base":"kiro"}]"#);
        let mut base = agent("kiro", "");
        base.backend = "kiro".into();
        let a = effective_def(&flat_of(&t, 0), Some(&base), "a", &[]).unwrap();
        assert_eq!(a.input_mode, "steer", "the override replaces the base's");
        let b = effective_def(&flat_of(&t, 1), Some(&base), "b", &[]).unwrap();
        assert_eq!(b.input_mode, "queue", "empty keeps the base's");
        base.input_mode = "steer".into();
        let b2 = effective_def(&flat_of(&t, 1), Some(&base), "b", &[]).unwrap();
        assert_eq!(b2.input_mode, "steer", "…whatever the base says");
    }

    /// Board #382: an agent that joined a running team is told its team and
    /// every teammate this project has, with the role the CURRENT definition
    /// gives each member (in the definition's order, joiners after), never
    /// itself.
    #[test]
    fn a_joined_agent_is_told_its_team_and_its_teammates() {
        let mut dev = named("dev", r#"[{"name":"lead","base":"claude","role":"Splits the work, owns merges.\nNever writes code."},{"team":"review"}]"#);
        dev.description = "Ships the app.".into();
        let review = named("review", r#"[{"name":"r1","base":"claude","role":"design"}]"#);
        let lookup = |n: &str| -> Result<Option<RegTeam>, String> { Ok(match n { "review" => Some(review.clone()), "dev" => Some(dev.clone()), _ => None }) };
        let flat = expand(&dev, &lookup, 8).unwrap();
        let mates = vec![
            ("helper".to_string(), "dev".to_string(), String::new()),
            ("r1".to_string(), "dev/review".to_string(), "r1".to_string()),
            ("me".to_string(), "dev".to_string(), String::new()),
            ("lead-2".to_string(), "dev".to_string(), "lead".to_string()),
        ];
        let b = joined_block("dev", Some(&dev), &flat, "me", &mates);
        assert!(b.starts_with("## Your team: \"dev\"\nShips the app.\n\nYou are \"me\". You joined this team when you were started; its definition does not list you."), "{b}");
        let lines: Vec<&str> = b.lines().filter(|l| l.starts_with("- @")).collect();
        assert_eq!(lines, ["- @lead-2 — Splits the work, owns merges. Never writes code.", "- @r1 [dev/review] — design", "- @helper"],
            "definition order with roles (the lead by its role), a sub-team tagged, another joiner after, never itself");
        let gone = joined_block("dev", None, &[], "me", &mates[..1]);
        assert_eq!(gone, "## Your team: \"dev\"\n\nYou are \"me\". You joined this team when you were started; its definition does not list you.\nYour teammates (address one with `tmm send \"@name …\"`; a [path] marks a different sub-team):\n- @helper",
            "a deleted definition: names only");
    }

    /// Board #80: the same team expanded twice into one project. The second
    /// copy's members are uniquified (`orchestrator-2`, …), and every address
    /// of this team in the description, the roles and the roster's role lines
    /// reaches the second copy's own members; `@human` and code are kept. The
    /// first copy reads its texts byte for byte as declared.
    #[test]
    fn a_second_copy_of_a_team_addresses_only_its_own_members() {
        let mut t = team(r#"[
            {"name":"orchestrator","agent":{"name":"","backend":"claude"},"role":"Assign work; @builder builds."},
            {"name":"builder","agent":{"name":"","backend":"claude"},"role":"Build, then hand it to @validator."},
            {"name":"validator","agent":{"name":"","backend":"claude"},"role":"Verify; defects go back to @builder, SHIP goes to @orchestrator."}
        ]"#);
        t.description = "Flow: @orchestrator assigns, @builder builds, @validator says SHIP; ask @human. Address one with `tmm send \"@builder …\"`.".into();
        let flat = expand(&t, &|_| Ok(None), 8).unwrap();
        let first = final_roster(&flat, Default::default(), &|_| None).unwrap();
        assert_eq!(first.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), ["orchestrator", "builder", "validator"]);
        let taken = first.iter().map(|e| e.0.clone()).collect();
        let second = final_roster(&flat, taken, &|_| None).unwrap();
        assert_eq!(second.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(), ["orchestrator-2", "builder-2", "validator-2"]);

        let mine = ["orchestrator-2", "builder-2", "validator-2", "human"];
        for (f, (w, _, _, _)) in flat.iter().zip(&second) {
            let system = effective_def(f, None, w, &second).unwrap().system;
            // Every address outside the code span is this copy's member (or the human).
            let prose = system.split('`').step_by(2).collect::<Vec<_>>().join(" ");
            for m in crate::address::mention_names(&prose) {
                assert!(mine.contains(&m.as_str()), "{w} is told to address @{m}:\n{system}");
            }
            assert!(system.contains("`tmm send \"@builder …\"`"), "code is code: {system}");
        }
        let builder = effective_def(&flat[1], None, "builder-2", &second).unwrap().system;
        assert!(builder.contains("Flow: @orchestrator-2 assigns, @builder-2 builds, @validator-2 says SHIP; ask @human."), "{builder}");
        assert!(builder.contains("Your role: Build, then hand it to @validator-2."), "{builder}");
        assert!(builder.contains("- @validator-2 — Verify; defects go back to @builder-2, SHIP goes to @orchestrator-2."), "{builder}");

        // The first copy, started alone, reads its texts exactly as declared.
        let alone = effective_def(&flat[1], None, "builder", &first).unwrap().system;
        assert!(alone.contains(&format!("\n{}\n", t.description)) && alone.contains("Your role: Build, then hand it to @validator."), "{alone}");
        assert!(alone.contains("- @validator — Verify; defects go back to @builder, SHIP goes to @orchestrator."), "{alone}");
    }

    /// Board #80: in a nested team a name declared in two sub-teams is read
    /// in the text's own sub-team; one declared once is found anywhere.
    #[test]
    fn a_member_name_in_two_sub_teams_is_read_in_its_own() {
        let roster: Vec<RosterEntry> = vec![
            ("dev-2".into(), String::new(), "root/build".into(), "dev".into()),
            ("dev-3".into(), String::new(), "root/review".into(), "dev".into()),
            ("lead-2".into(), String::new(), "root".into(), "lead".into()),
        ];
        assert_eq!(readdressed("@dev then @lead", "root/review", &roster), "@dev-3 then @lead-2");
        assert_eq!(readdressed("@dev then @lead", "root/build", &roster), "@dev-2 then @lead-2");
        assert_eq!(readdressed("@dev", "root", &roster), "@dev", "two candidates and none here: kept");
    }

}
