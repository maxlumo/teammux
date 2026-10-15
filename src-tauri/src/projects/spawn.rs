//! Spawn a registry agent into a project: materialize its ISOLATED home from
//! the registry definition, open a tmux window in the project's session, and
//! launch the backend CLI wired to `tmm`.
//!
//! Two agents-v2 principles land here (docs/exec-plans/agents-v2.md §1):
//!
//! - **Home isolation** (principle 5): everything the agent runs with —
//!   persona, skills, MCP servers, hooks — is rendered into
//!   `<workspace>/.tmm/agents/<name>/` and selected via the backend's home
//!   env var (`KIRO_HOME` / `CODEX_HOME`) or config flags (claude). The
//!   user's global CLI config never leaks in, so the same registry definition
//!   behaves identically in every project.
//! - **CLI-only substrate** (principle 2): NO team MCP server, NO heartbeat
//!   machinery. The agent talks through `tmm` (one paragraph in its system
//!   prompt) and we observe it through the notify/telemetry hooks that are
//!   part of the rendered home.
//!
//! The per-backend rendering deliberately mirrors `team/backends.rs` (same
//! file formats, same flags, same 2KB-launch-line lesson via
//! `write_launch_script`) minus the team plumbing. Team stays untouched and
//! becomes legacy in Phase C.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::backends::shared;
use crate::tmux;

use super::store::RegAgent;

/// Max agents per project for `spawn` — a lead that needs more than this is
/// fanning out instead of thinking (and each window burns real tokens).
/// Agent windows per project. 4 until 2026-09-02; raised for NESTED teams
/// (owner: the dev squad includes the four-reviewer board), so 8 = a squad of
/// four plus its review board. Still counts every agent-looking window.
pub const SPAWN_CAP: usize = 8;

/// How many of the project's windows count against the spawn cap: MANAGED
/// agents only (board #126). The cap is fan-out control — how many agents
/// this app will run at once for one project (tmm-cli.md: "a resource gate
/// on spawn — about fan-out control, not security") — so hand-started shells
/// and adopted agents are none of its business: a project with six plain
/// windows and two managed agents has room for six more hires. "Ours" is the
/// ONE definition, `home_is_managed` via `is_managed_in` (#112), not the
/// pane sniff, which counted anything that LOOKED like an agent.
fn managed_window_count(workspace: &str, panes: &[tmux::TmuxPane]) -> usize {
    let mut seen = std::collections::HashSet::new();
    panes
        .iter()
        .filter(|p| seen.insert(p.window))
        .filter(|p| super::is_managed_in(Some(workspace), &p.window_name))
        .count()
}

pub struct SpawnRequest<'a> {
    pub session: &'a str,
    /// Registry definition name to spawn (ignored when `def` is given).
    pub agent: &'a str,
    /// Opening brief posted into the hub chat and injected into the prompt.
    pub brief: &'a str,
    /// Who asked (agent name from $TMM_AGENT, or empty = the human).
    pub by: &'a str,
    /// A ready-made definition instead of a registry lookup — how a TEAM
    /// member spawns (board #74): its base def with the role block appended.
    pub def: Option<RegAgent>,
    /// The exact window name to use; the caller has already uniquified it.
    /// `None` = the def's name, uniquified here.
    pub window_name: Option<String>,
    /// The member NAME inside the team definition (board #113) — with `team`,
    /// the provenance a restart uses to re-resolve the CURRENT def for a
    /// uniquified window. Empty for solo spawns.
    pub member: &'a str,
    /// The team this spawn belongs to; recorded in the launch recipe so the
    /// Hub can group the cards.
    pub team: Option<String>,
    /// Restart fallback for a managed home whose slot is not currently
    /// restorable. Normal hires start fresh; Start/Restart resumes this
    /// isolated home's newest cwd conversation.
    pub resume: bool,
}

impl Default for SpawnRequest<'_> {
    fn default() -> Self {
        SpawnRequest {
            session: "", agent: "", brief: "", by: "", def: None,
            window_name: None, team: None, member: "", resume: false,
        }
    }
}

/// Spawn `agent` into `session`. Returns `{ window_name, pane }`.
pub fn spawn(req: &SpawnRequest) -> Result<Value, String> {
    let def = match &req.def {
        Some(d) => d.clone(),
        None => super::registry_get(req.agent)?
            .ok_or_else(|| format!("no agent named '{}' in the registry", req.agent))?,
    };
    // A model the backend does not know is not a runtime hiccup: kiro answers
    // the first turn with "not available, use /model" and the agent is alive but
    // mute — no reply, no auto-post, nothing for the app to notice. Registry
    // defs saved before validation existed can still carry one, so refuse here
    // too rather than open a window that cannot work.
    super::models::validate(&def.backend, &def.model)?;
    super::models::validate_effort(&def.backend, &def.effort)?;

    // No hiring gate: spawning is an ability every agent already has through
    // its shell and `tmm`, so a registry grant added no authority (owner,
    // 2026-09-26: "本身就是 agent 自己能够通过命令行获得的能力"). Fan-out is
    // bounded by the per-project cap below, for humans and agents alike.

    let project = super::project_for_session(req.session)?
        .ok_or_else(|| format!("no project for session '{}'", req.session))?;
    let workspace = project.path.clone();

    // The cap counts MANAGED agents only (board #126) — see managed_window_count.
    let panes = tmux::list_panes(req.session).unwrap_or_default();
    let agent_windows = managed_window_count(&workspace, &panes);
    if agent_windows >= SPAWN_CAP {
        return Err(format!("project already has {agent_windows} agents (cap {SPAWN_CAP}) — finish or close one first"));
    }

    // Window name = agent name, uniquified if taken (lead, lead-2, …). The
    // Window name is the agent's identity for telemetry and tmm messages.
    let taken: std::collections::HashSet<&str> = panes.iter().map(|p| p.window_name.as_str()).collect();
    let window_name = match &req.window_name {
        Some(w) => w.clone(),
        None => uniquify(&def.name, &taken)?,
    };
    // A def saved before names were validated, or an explicit window name
    // from a caller, still has to be a plain word here: it is about to be a
    // directory under `.tmm/agents/` and a tmux window name.
    super::agents::valid_name(&window_name)?;

    // Provenance for restarts (board #113): a registry-resolved spawn records
    // the DEF name (the window may be uniquified past it); a team member
    // records team+member instead and its def is re-derived on refresh.
    let agent_def = if req.def.is_none() { def.name.as_str() } else { "" };
    let m = materialize(&def, &window_name, req.session, &workspace, req.brief, req.by, req.team.as_deref(), agent_def, req.member)?;
    let home = m.home;
    let env = m.env;

    tmux::ensure_session(req.session, &workspace)?;
    let pane = tmux::new_named_window(req.session, &window_name, &workspace)?;
    // Type only once the shell shows its prompt (board #325), never on a timer.
    tmux::wait_for_shell(&pane, tmux::SHELL_READY);

    let prefix = env
        .iter()
        .map(|(k, v)| format!("{}={}", k, crate::shell::quote(v)))
        .collect::<Vec<_>>()
        .join(" ");
    // The launch line ends with the first prompt ONLY when a brief gave us
    // something for the agent to act on; otherwise the CLI opens and waits.
    // Restart fallback is different from a new hire: its isolated home already
    // owns the conversation, so resume recent even when the slot/exact id raced
    // the capture tick.
    let launch_cmd = launch_command(&m.cmd, &def.backend, req.brief, req.by, req.resume);
    let full = format!("{} {}", prefix, launch_cmd);
    // NEVER send the full line via send-keys — see team/launch.rs: tty shims
    // swallow bursts ≳2KB. Source a script instead.
    let script = shared::write_launch_script(&home, &window_name, &full)?;
    tmux::send_command(&pane, &format!(". {}", crate::shell::quote(&script.to_string_lossy())))?;
    // A backend without a positional prompt (kimi, board #224) gets its brief
    // TYPED once the composer is up — through `deliver_chat_line`, the same
    // door every later message takes, so the delivery is recorded, the
    // turn-start echo acks it and the reply edge names the briefer.
    let backend = crate::backends::Backend::parse(&def.backend)
        .ok_or_else(|| format!("unknown backend '{}'", def.backend))?;
    let typed_brief = match backend.first_prompt() {
        crate::backends::FirstPrompt::Typed => first_prompt(req.brief, req.by),
        crate::backends::FirstPrompt::LaunchLine => None,
    };
    let on_ready: Option<Box<dyn FnOnce() + Send + 'static>> = typed_brief.map(|line| {
        let (session, window) = (req.session.to_string(), window_name.clone());
        Box::new(move || {
            if !super::deliver_chat_line(&session, &window, &line) {
                eprintln!("projects: the brief for {session}:{window} could not be typed into its pane");
            }
        }) as Box<dyn FnOnce() + Send + 'static>
    });
    match (m.confirmation, on_ready) {
        (Some(confirmation), on_ready) => shared::confirm_startup_prompt(pane.clone(), confirmation, on_ready),
        // A Typed backend always renders ready markers (its own test pins
        // it); this arm is the closed enum's honesty, not a path in use.
        (None, Some(f)) => f(),
        (None, None) => {}
    }

    Ok(json!({ "window_name": window_name, "pane": pane, "backend": def.backend }))
}

/// Everything an agent IS on disk: its isolated home, rendered backend
/// config, launch command, environment, and the recipe that replays them.
struct Materialized {
    home: PathBuf,
    cmd: String,
    env: Vec<(String, String)>,
    confirmation: Option<shared::StartupConfirmation>,
}

/// Materialize (or RE-materialize) an agent's home from its definition:
/// prompt, backend config, skills, MCP seed, hooks, and the launch recipe —
/// everything but the tmux window. `spawn` calls it before opening the
/// window; `refresh_agent` calls it again at restart, so a replayed recipe
/// launches the CURRENT definition and app-wide instructions instead of the
/// spawn-time snapshot.
fn materialize(
    def: &RegAgent,
    window_name: &str,
    session: &str,
    workspace: &str,
    brief: &str,
    by: &str,
    team: Option<&str>,
    // Def provenance (board #113): the registry def name for a solo spawn
    // (the window may be uniquified past it), or the member name inside the
    // team definition for a team spawn. Both empty for pre-#113 recipes.
    agent_def: &str,
    member: &str,
) -> Result<Materialized, String> {
    let home = agent_home(workspace, window_name);
    std::fs::create_dir_all(&home).map_err(|e| format!("create agent home: {e}"))?;
    ensure_gitignore(workspace);

    // The software-wide instructions (`<config>/AGENTS.md`) lead every prompt,
    // on every backend — read now, so a spawn always carries the current text.
    let system_prompt = build_prompt(def, window_name, session, brief, by, &super::global_prompt::read());
    let skills = resolve_skill_refs(def, &home);
    // MCP is ONE door now (owner, 2026-08-28): registry defs seed the shared
    // workspace config that `tmm mcp` reads per call — never a backend's
    // native config, which loads once at CLI start and made every server
    // change a restart.
    let mcp_config = seed_mcp_config(Path::new(workspace), &mcp_defs(def))?;

    let backend = crate::backends::Backend::parse(&def.backend)
        .ok_or_else(|| format!("unknown backend '{}'", def.backend))?;
    let prepared = backend.render(def, window_name, &home, Path::new(workspace), &system_prompt, &skills)?;

    // Env every spawned agent gets: its identity for tmm.
    let mut env = prepared.env;
    env.push(("TMM_PROJECT".into(), session.to_string()));
    env.push(("TMM_AGENT".into(), window_name.to_string()));
    // The MCP config is findable from ANY cwd, not just under the workspace.
    env.push(("TMM_MCP_CONFIG".into(), mcp_config.to_string_lossy().to_string()));
    // tmm sits next to the server binary, while user-installed backends and
    // MCP runners commonly sit in ~/.local/bin or ~/.cargo/bin. The server is
    // often supervised with a minimal PATH, so make the recipe self-sufficient
    // instead of relying on the interactive shell to repair it later.
    let inherited_path = env
        .iter()
        .rev()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.clone())
        .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    env.retain(|(key, _)| key != "PATH");
    env.push((
        "PATH".into(),
        shared::agent_launch_path(tmm_dir().as_deref(), &inherited_path),
    ));

    // Record before acting: the recipe is what makes this window OURS on
    // restart (`agents::detect_pane` reads the backend off it, `relaunch_line`
    // replays it). Written here, before the window exists, so a write failure
    // is a spawn failure with nothing left running — not a live agent that
    // restarts deaf on the generic launch path.
    LaunchRecipe { backend: &def.backend, env: &env, cmd: &prepared.cmd, spawned_by: by, team, agent_def, member, input_mode: &def.input_mode }.write(&home)?;
    Ok(Materialized { home, cmd: prepared.cmd, env, confirmation: prepared.confirmation })
}

/// Re-materialize a managed agent's home from its CURRENT definition, so a
/// restart launches today's registry text instead of the spawn-time snapshot
/// (owner, 2026-09-08). The def is resolved through the recipe's PROVENANCE
/// (board #113): a team member re-derives its effective def from the current
/// team (`team` + `member`), a solo spawn follows `agent_def` (so a
/// uniquified `lead-2` still finds `lead`), and a pre-#113 recipe falls back
/// to the window name, exactly as before. `false` when the window is not one
/// we can refresh — no recipe on disk, a def that was deleted after the spawn
/// (degrades soft: the spawn-time materials keep working, logged once per
/// window), or a def edited into an invalid model (a config the backend
/// would refuse must not brick the restart).
pub fn refresh_agent(project_path: &str, session: &str, window_name: &str) -> bool {
    let home = agent_home(project_path, window_name);
    let Ok(recipe) = std::fs::read_to_string(home.join("launch.json")) else { return false };
    let recipe: Value = match serde_json::from_str(&recipe) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let field = |k: &str| recipe.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let by = field("spawned_by");
    let team = field("team");
    let member = field("member");
    let agent_def = field("agent_def");

    let resolved = if !team.is_empty() && !member.is_empty() {
        refresh_team_def(project_path, &team, &member, window_name)
    } else if !agent_def.is_empty() {
        super::registry_get(&agent_def).ok().flatten()
    } else {
        // Pre-#113 recipe: the window name IS the def name or nothing.
        super::registry_get(window_name).ok().flatten()
    };
    let Some(def) = resolved else {
        // The def (or its team/base) is gone. Keep the spawn-time snapshot —
        // the agent keeps working — and say so once per window, not per start.
        static WARNED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
            std::sync::OnceLock::new();
        let key = format!("{project_path}/{window_name}");
        if WARNED.get_or_init(Default::default).lock().unwrap().insert(key) {
            eprintln!(
                "projects: definition behind agent '{window_name}' is gone (def '{agent_def}', team '{team}'); restarts keep its spawn-time materials"
            );
        }
        return false;
    };
    // A def edited into an invalid model must not brick the restart: keep the
    // old materials rather than write a config the backend will refuse.
    if super::models::validate(&def.backend, &def.model).is_err()
        || super::models::validate_effort(&def.backend, &def.effort).is_err()
    {
        return false;
    }
    let team_opt = (!team.is_empty()).then_some(team.as_str());
    materialize(&def, window_name, session, project_path, "", &by, team_opt, &agent_def, &member).is_ok()
}

/// Re-derive a team member's effective def from the CURRENT team definition
/// (board #113). The roster is reconstructed from the sibling recipes in this
/// workspace — the recipes are the declaration of which window carries which
/// member — with the member's own name as the fallback for a sibling that has
/// no recipe here (removed, or spawned before provenance existed): that is
/// the name spawn itself would have used had the window not been taken.
fn refresh_team_def(workspace: &str, team_path: &str, member: &str, window_name: &str) -> Option<RegAgent> {
    let root = team_path.split('/').next()?;
    let team = super::team_get(root).ok().flatten()?;
    let flat = super::teams::expand(&team, &|n| super::team_get(n), SPAWN_CAP).ok()?;
    let f = flat
        .iter()
        .find(|f| f.path == team_path && f.member.name.trim() == member)?;
    let assigned = team_windows_from_recipes(workspace, root);
    let roster: Vec<super::teams::RosterEntry> = flat
        .iter()
        .map(|g| {
            let key = (g.path.clone(), g.member.name.trim().to_string());
            let w = assigned.get(&key).cloned().unwrap_or_else(|| g.member.name.trim().to_string());
            (w, g.member.role.clone(), g.path.clone())
        })
        .collect();
    let base = if f.member.base.trim().is_empty() {
        None
    } else {
        super::registry_get(f.member.base.trim()).ok().flatten()
    };
    super::teams::effective_def(f, base.as_ref(), window_name, &roster).ok()
}

/// (team path, member name) -> window name, read off every recipe under
/// `<ws>/.tmm/agents/` whose team path starts at `root`. Fail-soft: an
/// unreadable recipe simply contributes nothing.
fn team_windows_from_recipes(
    workspace: &str,
    root: &str,
) -> std::collections::HashMap<(String, String), String> {
    let mut map = std::collections::HashMap::new();
    let dir = Path::new(workspace).join(".tmm").join("agents");
    let Ok(entries) = std::fs::read_dir(dir) else { return map };
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("launch.json")) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let (team, member) = (get("team"), get("member"));
        if member.is_empty() || team.split('/').next() != Some(root) {
            continue;
        }
        map.insert((team, member), entry.file_name().to_string_lossy().into_owned());
    }
    map
}

/// Window name = agent name, uniquified if taken (lead, lead-2, …). The window
/// name is the agent's identity for telemetry and tmm messages.
fn uniquify(name: &str, taken: &std::collections::HashSet<&str>) -> Result<String, String> {
    if !taken.contains(name) {
        return Ok(name.to_string());
    }
    (2..10)
        .map(|i| format!("{name}-{i}"))
        .find(|c| !taken.contains(c.as_str()))
        .ok_or_else(|| "too many windows with this agent's name".to_string())
}

/// Spawn every member of a configured TEAM into `session` (board #74). Names
/// are uniquified up front so the roster block each member receives names the
/// windows that will actually exist; members spawn in order; one failure does
/// not stop the others and is reported in `errors`. Returns
/// `{ team, spawned: [{name, window_name, pane}], errors: [..] }`.
pub fn spawn_team(session: &str, team_name: &str, brief: &str, by: &str) -> Result<Value, String> {
    spawn_team_members(session, team_name, brief, by, false, None)
}

/// What a team restart does to this workspace's members (board #286): the
/// CURRENT definition decides. A member with a home here (its recipe names
/// the team) that the definition still has is restarted (a stopped one is
/// started, as `hub_agent_restart` does); one it no longer has is stopped
/// if live, its home kept; a member the definition has and no home here
/// is spawned. Pure: `homes` are (window, team path, member) off the
/// recipes, `current` the definition's (path, member), `live` the windows
/// running now.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct TeamPlan {
    pub restart: Vec<String>,
    pub stop: Vec<String>,
    pub spawn: Vec<(String, String)>,
}

/// A retry's plan (validator 06:53): only the names the previous run
/// reported failed — a restart or stop by window, a spawn by member name.
/// Pure.
pub fn only_names(plan: TeamPlan, names: &[String]) -> TeamPlan {
    TeamPlan {
        restart: plan.restart.into_iter().filter(|w| names.contains(w)).collect(),
        stop: plan.stop.into_iter().filter(|w| names.contains(w)).collect(),
        spawn: plan.spawn.into_iter().filter(|(_, m)| names.contains(m)).collect(),
    }
}

pub fn team_plan(homes: &[(String, String, String)], current: &[(String, String)], live: &[String]) -> TeamPlan {
    let mut plan = TeamPlan::default();
    for (window, path, member) in homes {
        if current.iter().any(|(p, m)| p == path && m == member) {
            plan.restart.push(window.clone());
        } else if live.contains(window) {
            plan.stop.push(window.clone());
        }
    }
    for (path, member) in current {
        if !homes.iter().any(|(_, p, m)| p == path && m == member) {
            plan.spawn.push((path.clone(), member.clone()));
        }
    }
    plan
}

/// Does the CURRENT definition of the team at `team_path`'s root still have
/// `member` at that path (board #287)? False for a deleted team.
pub fn in_current_team(team_path: &str, member: &str) -> bool {
    let Some(root) = team_path.split('/').next() else { return false };
    let Ok(Some(team)) = super::team_get(root) else { return false };
    super::teams::expand(&team, &|n| super::team_get(n), SPAWN_CAP)
        .map(|flat| flat.iter().any(|f| f.path == team_path && f.member.name.trim() == member))
        .unwrap_or(false)
}

/// The inputs of `team_plan` for `team_name` in `session`, read from the
/// registry, the recipes and tmux.
pub fn team_plan_for(session: &str, team_name: &str) -> Result<TeamPlan, String> {
    let team = super::team_get(team_name)?.ok_or_else(|| format!("no team named '{team_name}'"))?;
    let flat = super::teams::expand(&team, &|n| super::team_get(n), SPAWN_CAP)?;
    let project = super::project_for_session(session)?.ok_or_else(|| format!("no project for session '{session}'"))?;
    let mut homes: Vec<(String, String, String)> = team_windows_from_recipes(&project.path, &team.name)
        .into_iter()
        .map(|((path, member), window)| (window, path, member))
        .collect();
    homes.sort();
    let current: Vec<(String, String)> = flat.iter().map(|f| (f.path.clone(), f.member.name.trim().to_string())).collect();
    let live: Vec<String> = tmux::list_panes(session).unwrap_or_default().into_iter().map(|p| p.window_name).collect();
    Ok(team_plan(&homes, &current, &live))
}

/// Spawn a team's members. `only_new` (a team restart, board #286) spawns
/// only the members with no home in this workspace yet, and names the
/// others by the windows their recipes record, so every prompt's roster is
/// the team as it will stand.
/// `only` narrows the members spawned to those names (a retry).
pub fn spawn_team_members(session: &str, team_name: &str, brief: &str, by: &str, only_new: bool, only: Option<&[String]>) -> Result<Value, String> {
    let team = super::team_get(team_name)?
        .ok_or_else(|| format!("no team named '{team_name}'"))?;
    // Nested teams flatten here (board #74 follow-up): every leaf remembers
    // the path it came in on, which is what the recipe records and the
    // roster groups on.
    let flat = super::teams::expand(&team, &|n| super::team_get(n), SPAWN_CAP)?;
    let project = super::project_for_session(session)?
        .ok_or_else(|| format!("no project for session '{session}'"))?;
    let panes = tmux::list_panes(session).unwrap_or_default();
    let homes = if only_new { team_windows_from_recipes(&project.path, &team.name) } else { Default::default() };
    let has_home = |f: &super::teams::Flat| homes.get(&(f.path.clone(), f.member.name.trim().to_string())).cloned();
    let wanted = |f: &super::teams::Flat| has_home(f).is_none() && only.is_none_or(|o| o.iter().any(|n| n == f.member.name.trim()));
    let new = flat.iter().filter(|f| wanted(f)).count();
    // Team expansion counts its LEAVES against the same cap, as before.
    let existing = managed_window_count(&project.path, &panes);
    if existing + new > SPAWN_CAP {
        return Err(format!(
            "team '{team_name}' expands to {new} agents and the project already has {existing} (cap {SPAWN_CAP}) — stop some first",
        ));
    }
    // Final names first, so every member's prompt can name its teammates.
    let mut taken: std::collections::HashSet<String> = panes.iter().map(|p| p.window_name.clone()).collect();
    taken.extend(homes.values().cloned());
    let mut roster: Vec<super::teams::RosterEntry> = Vec::new();
    for f in &flat {
        let w = match has_home(f) {
            Some(w) => w,
            None => {
                let borrowed: std::collections::HashSet<&str> = taken.iter().map(String::as_str).collect();
                uniquify(f.member.name.trim(), &borrowed)?
            }
        };
        taken.insert(w.clone());
        roster.push((w, f.member.role.clone(), f.path.clone()));
    }
    let mut spawned = Vec::new();
    let mut errors = Vec::new();
    for (f, (w, _, path)) in flat.iter().zip(roster.iter()) {
        if !wanted(f) {
            continue;
        }
        let m = &f.member;
        let base = if m.base.trim().is_empty() { None } else { super::registry_get(m.base.trim())? };
        let result = super::teams::effective_def(f, base.as_ref(), w, &roster).and_then(|def| {
            spawn(&SpawnRequest {
                session,
                agent: w,
                brief,
                by,
                def: Some(def),
                window_name: Some(w.clone()),
                team: Some(path.clone()),
                member: m.name.trim(),
                resume: false,
            })
        });
        match result {
            Ok(r) => spawned.push(json!({ "name": m.name, "window_name": w, "team": path, "pane": r.get("pane").cloned().unwrap_or(Value::Null), "backend": r.get("backend").cloned().unwrap_or(Value::Null) })),
            Err(e) => errors.push(json!({ "name": m.name, "team": path, "error": e })),
        }
    }
    Ok(json!({ "team": team.name, "spawned": spawned, "errors": errors }))
}

/// The launch recipe — how this agent is STARTED, persisted as
/// `<home>/launch.json` so a restart can replay the full identity. Its fields
/// ARE the file's keys (board #153): one struct, one writer, and the call
/// sites name what they set instead of lining up nine positionals.
///
/// Without the recipe the resume path fell back to the plain backend launch
/// line ("kiro-cli chat --resume-id …" — no KIRO_HOME, no --agent), which
/// runs the USER-SPACE config whose hooks never fire (measured, kiro-cli
/// 2.16.2): the restarted agent went observably deaf — no tool rows, no
/// auto-post, every delivery "unconfirmed" (owner report, 2026-08-18). The
/// kick is NOT part of the recipe: it belongs to the first launch only; a
/// restart resumes a conversation instead.
pub(crate) struct LaunchRecipe<'a> {
    pub backend: &'a str,
    pub env: &'a [(String, String)],
    /// The identity command with NO first prompt appended (spawn adds that
    /// separately), stored verbatim. It used to strip a trailing quoted
    /// argument to remove the kick — a guess that would have eaten a
    /// legitimate quoted flag the day a backend ended with one.
    pub cmd: &'a str,
    /// Who created the slot; the first stamped brief carries the live reply
    /// edge. Empty = the human.
    pub spawned_by: &'a str,
    /// The configured team this window was spawned as part of (board #74), so
    /// the Hub can group the cards; `None` for a solo spawn.
    pub team: Option<&'a str>,
    /// With `member`: the def PROVENANCE (board #113), so a restart can
    /// re-resolve the CURRENT definition for a window whose name is not the
    /// def's (uniquified `lead-2`, a team member). In the recipe, not a slots
    /// column — the recipe is the declaration, one place (tenet 7).
    pub agent_def: &'a str,
    pub member: &'a str,
    /// `queue` | `steer` — the input mode THIS process was started with
    /// (board #257: whether a line for it is held while it is busy). ''
    /// for a backfilled recipe, which the reader takes as `queue`.
    pub input_mode: &'a str,
}

impl LaunchRecipe<'_> {
    /// Write `<home>/launch.json`. Byte-for-byte what the nine-argument
    /// `write_launch_recipe` produced (same keys, same order, same pretty
    /// printer) — proven by diff on a solo spawn, a team member and the
    /// pre-recipe backfill (board #153).
    pub(crate) fn write(&self, home: &Path) -> Result<(), String> {
        let recipe = json!({
            "backend": self.backend,
            "env": self.env.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
            "cmd": self.cmd.trim_end(),
            "spawned_by": self.spawned_by,
            "team": self.team.unwrap_or(""),
            "agent_def": self.agent_def,
            "member": self.member,
            "input_mode": self.input_mode,
        });
        std::fs::write(
            home.join("launch.json"),
            serde_json::to_string_pretty(&recipe).unwrap(),
        )
        .map_err(|e| format!("write launch recipe {}: {e}", home.join("launch.json").display()))
    }
}

/// Add the backend's exact or safe-recent resume dialect to one persisted
/// identity command (the dialects live on the backend files, board #128).
/// An unknown backend relaunches verbatim, as before.
fn resume_command(cmd: &str, backend: &str, session_id: Option<&str>, home: Option<&Path>) -> String {
    let exact = session_id.filter(|s| !s.is_empty());
    match crate::backends::Backend::parse(backend) {
        Some(b) => b.resume_command(cmd, exact, home),
        None => cmd.to_string(),
    }
}

/// Replay the persisted identity (env + backend command), preferring an exact
/// conversation id and otherwise the isolated home's newest cwd conversation.
pub fn relaunch_line(project_path: &str, window_name: &str, session_id: Option<&str>) -> Option<String> {
    let home = agent_home(project_path, window_name);
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).ok()?).ok()?;
    let cmd = recipe.get("cmd")?.as_str()?;
    let backend = recipe.get("backend").and_then(|b| b.as_str()).unwrap_or("");
    let cmd = resume_command(cmd, backend, session_id, Some(&home));
    let env = recipe.get("env").and_then(|e| e.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|kv| Some((kv.get(0)?.as_str()?, kv.get(1)?.as_str()?)))
            .map(|(k, v)| format!("{}={}", k, crate::shell::quote(v)))
            .collect::<Vec<_>>()
            .join(" ")
    }).unwrap_or_default();
    let mut line = String::new();
    if !env.is_empty() {
        line.push_str(&env);
        line.push(' ');
    }
    line.push_str(&cmd);
    Some(line)
}

/// The first prompt, if there is one AT ALL. A spawned agent used to receive a
/// synthetic starter (an instruction, then a `(session start)` marker) purely
/// because an interactive CLI sits idle until spoken to. Both were wrong for
/// the same reason: that channel is where the OPERATOR's words arrive, so
/// anything we invent there is a message the user never wrote — and an agent
/// handed a contentless prompt starts reasoning about nothing ("多此一举",
/// owner 2026-08-18). So: no brief, no prompt. The agent waits at its prompt,
/// costing nothing, until a real message arrives via `deliver_mentions` (which
/// stamps its own time — the only reason the marker carried one).
///
/// A brief IS something to consume: `tmm spawn <agent> --brief "…"` is a task
/// assignment from the operator or a teammate, so it is delivered as the first
/// message, stamped like every later one.

fn first_prompt(brief: &str, by: &str) -> Option<String> {
    let brief = brief.trim();
    if brief.is_empty() {
        return None;
    }
    let sender = if by.trim().is_empty() { "human" } else { by.trim() };
    Some(format!(
        "[tmm chat {}] {sender}: {brief}",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    ))
}

/// The launch line: identity (+ resume) and, for a backend that takes it
/// there, the first prompt as one quoted positional. A `Typed` backend
/// (`Backend::first_prompt`) gets NO positional — kimi 2.0.2 read the brief
/// as a subcommand and exited — its brief is typed by `spawn` once the pane
/// is ready.
fn launch_command(identity_cmd: &str, backend: &str, brief: &str, by: &str, resume: bool) -> String {
    let identity_cmd = if resume {
        // No recorded id here, so there is nothing for a home to vouch for.
        resume_command(identity_cmd, backend, None, None)
    } else {
        identity_cmd.to_string()
    };
    let positional = crate::backends::Backend::parse(backend)
        .is_none_or(|b| b.first_prompt() == crate::backends::FirstPrompt::LaunchLine);
    match first_prompt(brief, by) {
        Some(p) if positional => format!("{} {}", identity_cmd, crate::shell::quote(&p)),
        _ => identity_cmd,
    }
}

#[cfg(test)]
mod relaunch_tests {
    use super::*;

    /// Board #379, through the REAL restart path: `relaunch_line` is what a
    /// restart runs, and it must hand the kiro helper the agent's own home. A
    /// helper test cannot see a caller that passes the wrong one (or none),
    /// and then every restarted team member silently comes back as the
    /// hookless Default agent again. Real layout: `agent_home` is
    /// `<ws>/.tmm/agents/<name>` and kiro keeps its sessions in
    /// `<home>/sessions/<cwd-hash>/<id>/session.json`.
    #[test]
    fn a_restart_resumes_a_v3_session_only_if_the_agents_own_home_holds_it() {
        let ws = std::env::temp_dir().join(format!("tmm-relaunch-379-{}", uuid::Uuid::new_v4()));
        let home = agent_home(ws.to_str().unwrap(), "lead");
        std::fs::create_dir_all(&home).unwrap();
        LaunchRecipe {
            backend: "kiro",
            env: &[("KIRO_HOME".to_string(), home.to_string_lossy().to_string())],
            cmd: "command kiro-cli chat --agent lead --trust-all-tools --agent-engine v3",
            spawned_by: "", team: None, agent_def: "", member: "", input_mode: "",
        }
        .write(&home)
        .unwrap();
        let id = "sess_e58968b6-0000-4000-8000-000000000001";
        let plant = |mode: &str| {
            let dir = home.join("sessions").join("13c0722d7b097be1").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session.json"), format!(r#"{{"id":"{id}","agentMode":"{mode}"}}"#)).unwrap();
        };
        let line = || relaunch_line(ws.to_str().unwrap(), "lead", Some(id)).unwrap();

        // Recorded id, nothing in the home (the id lives only in ~/.kiro): fresh.
        assert!(!line().contains("--resume"), "global-only id must not resume: {}", line());
        assert!(line().contains("--agent lead"), "and it is still the full identity: {}", line());
        // The home holds a session kiro made up when it could not find the
        // real one: fresh.
        plant("vibe");
        assert!(!line().contains("--resume"), "a vibe session must not resume: {}", line());
        // The agent's own session: resumes, with the isolated home first.
        plant("lead");
        let ok = line();
        assert!(ok.starts_with("KIRO_HOME="), "isolated home first: {ok}");
        assert!(ok.ends_with(&format!("--resume-id {id}")), "its own session resumes: {ok}");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn restart_spawn_resumes_but_a_new_hire_starts_fresh() {
        let cmd = "command claude --settings /tmp/settings.json";
        assert_eq!(launch_command(cmd, "claude", "", "", false), cmd);
        assert_eq!(
            launch_command(cmd, "claude", "", "", true),
            "command claude --settings /tmp/settings.json --continue"
        );
        assert_eq!(
            launch_command("command codex -c a=b", "codex", "", "", true),
            "command codex resume --last -c a=b"
        );
    }

    /// A brief rides the launch line as one positional for the five CLIs that
    /// take it there; kimi has no such form (`kimi <text>` → "unknown
    /// command", measured live, board #224), so its line carries none and the
    /// brief is typed into the ready pane instead.
    #[test]
    fn a_brief_is_positional_except_for_kimi() {
        let line = launch_command("command claude --settings s.json", "claude", "fix it", "lead", false);
        assert!(line.starts_with("command claude --settings s.json '[tmm chat "), "{line}");
        assert!(line.ends_with("] lead: fix it'"), "{line}");
        assert_eq!(launch_command("command kimi --auto", "kimi", "fix it", "lead", false), "command kimi --auto");
        assert_eq!(launch_command("command kimi --auto", "kimi", "fix it", "lead", true), "command kimi --auto -c");
    }

    #[test]
    fn relaunch_line_replays_env_identity_and_resume() {
        let ws = std::env::temp_dir().join(format!("tmm-relaunch-{}", uuid::Uuid::new_v4()));
        let home = agent_home(ws.to_str().unwrap(), "lead");
        std::fs::create_dir_all(&home).unwrap();
        LaunchRecipe { backend: "kiro", env: &[("KIRO_HOME".to_string(), home.to_string_lossy().to_string())], cmd: "command kiro-cli chat --agent lead --model m --trust-all-tools", spawned_by: "", team: None, agent_def: "", member: "", input_mode: "" }
            .write(&home)
            .unwrap();
        let line = relaunch_line(ws.to_str().unwrap(), "lead", Some("id-1")).unwrap();
        assert!(line.starts_with("KIRO_HOME="), "isolated home first: {line}");
        assert!(line.contains("--agent lead"), "identity: {line}");
        assert!(line.ends_with("--resume-id id-1"), "conversation resumes: {line}");
        // The recipe stores the identity command VERBATIM: a first prompt is
        // never part of it (spawn appends that separately, only for a brief),
        // so nothing has to be guessed off the end of the line.
        let stored: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        assert_eq!(
            stored.get("cmd").and_then(|c| c.as_str()).unwrap(),
            "command kiro-cli chat --agent lead --model m --trust-all-tools",
            "",
        );
        // No recorded conversation yet: the managed home is isolated to this
        // one agent, so relaunch the newest conversation instead of opening a
        // blank prompt while the 20s capture tick catches up.
        let recent = relaunch_line(ws.to_str().unwrap(), "lead", None).unwrap();
        assert!(recent.ends_with("--resume"), "managed kiro resumes recent: {recent}");
        // A window with no recipe (hand-started) stays None — the caller falls
        // back to the generic backend line.
        assert!(relaunch_line(ws.to_str().unwrap(), "byhand", None).is_none());

        for (name, backend, cmd, flag) in [
            ("cl", "claude", "command claude --settings /tmp/settings.json", "--continue"),
            ("gx", "grok", "command grok --always-approve --agent gx", "--continue"),
        ] {
            let ahome = agent_home(ws.to_str().unwrap(), name);
            std::fs::create_dir_all(&ahome).unwrap();
            LaunchRecipe { backend: backend, env: &[], cmd: cmd, spawned_by: "", team: None, agent_def: "", member: "", input_mode: "" }.write(&ahome).unwrap();
            let exact = relaunch_line(ws.to_str().unwrap(), name, Some("conv-1")).unwrap();
            assert!(exact.ends_with("--resume conv-1"), "{backend} exact resume: {exact}");
            let recent = relaunch_line(ws.to_str().unwrap(), name, None).unwrap();
            assert!(recent.ends_with(flag), "{backend} recent resume: {recent}");
        }

        // codex resumes via a SUBCOMMAND, so the id splices in after the
        // binary instead of appending (verified on codex-cli 0.148.0:
        // `codex resume <id>` accepts the recipe's own flags). Appending
        // would hand `resume` to the interactive CLI as a prompt.
        let chome = agent_home(ws.to_str().unwrap(), "cx");
        std::fs::create_dir_all(&chome).unwrap();
        LaunchRecipe { backend: "codex", env: &[("CODEX_HOME".to_string(), chome.to_string_lossy().to_string())], cmd: "command codex -c a=b --dangerously-bypass-approvals-and-sandbox", spawned_by: "", team: None, agent_def: "", member: "", input_mode: "" }
            .write(&chome)
            .unwrap();
        let cx = relaunch_line(ws.to_str().unwrap(), "cx", Some("01a0-abc")).unwrap();
        assert!(
            cx.contains("command codex resume 01a0-abc -c a=b --dangerously-bypass-approvals-and-sandbox"),
            "subcommand splice: {cx}"
        );
        let cx_recent = relaunch_line(ws.to_str().unwrap(), "cx", None).unwrap();
        assert!(
            cx_recent.contains("command codex resume --last -c a=b --dangerously-bypass-approvals-and-sandbox"),
            "isolated CODEX_HOME can safely resume its last cwd session: {cx_recent}"
        );
        std::fs::remove_dir_all(&ws).ok();
    }
}

// The per-backend render family lives on the backend files (board #128);
// production code reaches it only through Backend's methods, so these
// re-exports exist for the test module's `use super::*` alone.
/// Board #286: the team restart plan. The owner's edit (archivist out,
/// reviewer in) against a workspace where orchestrator runs, validator is
/// stopped and archivist runs: orchestrator and validator restart (the
/// stopped one starts), archivist stops, reviewer spawns. A home whose
/// member left and is already stopped is left alone; a nested member is
/// matched by path AND name.
#[cfg(test)]
mod team_plan_tests {
    use super::{team_plan, TeamPlan};
    #[test]
    fn a_team_restart_aligns_with_the_current_definition() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let home = |w: &str, p: &str, m: &str| (w.to_string(), p.to_string(), m.to_string());
        let homes = [
            home("orchestrator", "dev-squad", "orchestrator"),
            home("validator", "dev-squad", "validator"),
            home("archivist", "dev-squad", "archivist"),
            home("old", "dev-squad", "old"),
            home("rev-2", "dev-squad/review", "rev"),
        ];
        let current = [("dev-squad", "orchestrator"), ("dev-squad", "validator"), ("dev-squad", "reviewer"), ("dev-squad", "rev"), ("dev-squad/review", "rev")]
            .map(|(p, m)| (p.to_string(), m.to_string()));
        let plan = team_plan(&homes, &current, &s(&["orchestrator", "archivist", "rev-2", "shell"]));
        assert_eq!(plan, TeamPlan {
            restart: s(&["orchestrator", "validator", "rev-2"]),
            stop: s(&["archivist"]),
            spawn: vec![("dev-squad".into(), "reviewer".into()), ("dev-squad".into(), "rev".into())],
        });
        assert_eq!(team_plan(&[], &[], &[]), TeamPlan::default());
        // A retry keeps only what failed (validator 06:53).
        assert_eq!(super::only_names(plan, &s(&["validator", "reviewer"])), TeamPlan {
            restart: s(&["validator"]),
            stop: vec![],
            spawn: vec![("dev-squad".into(), "reviewer".into())],
        });
    }
}

#[cfg(test)]
pub(crate) use crate::backends::claude::{claude_hooks, ensure_claude_state, merge_missing_claude_env, render_claude};
#[cfg(test)]
pub(crate) use crate::backends::codex::{codex_hooks, render_codex};
#[cfg(test)]
pub(crate) use crate::backends::grok::{grok_config_toml_from, grok_hooks, render_grok};
#[cfg(test)]
pub(crate) use crate::backends::kiro::{ensure_kiro_settings, kiro_hooks, render_kiro};
#[cfg(test)]
pub(crate) use crate::backends::omp::render_omp;

pub(crate) struct Rendered {
    pub(crate) env: Vec<(String, String)>,
    pub(crate) cmd: String,
    pub(crate) confirmation: Option<shared::StartupConfirmation>,
}

/// The isolated home for `name`. Callers reach this only with a name that
/// passed `agents::valid_name` (spawn checks the window name up front, and
/// every other name comes off a slot or a tmux window that `is_managed_in`
/// already accepted), so a rejection here is a programming error, not a
/// user-facing one — it falls back to a path that cannot exist rather than
/// escape the agents directory.
pub(crate) fn agent_home(workspace: &str, name: &str) -> PathBuf {
    super::agents::home_dir(workspace, name).unwrap_or_else(|| {
        Path::new(workspace).join(".tmm").join("agents").join("__invalid-name__")
    })
}

/// `.tmm/` self-gitignores (same convention as team runtime homes).
fn ensure_gitignore(workspace: &str) {
    let dir = Path::new(workspace).join(".tmm");
    let gi = dir.join(".gitignore");
    if dir.is_dir() && !gi.exists() {
        let _ = std::fs::write(gi, "*\n");
    }
}

/// Persona + the complete tmm collaboration flow. The brief is a real first
/// user message, never duplicated into this replayed system prompt.
fn build_prompt(def: &RegAgent, name: &str, session: &str, _brief: &str, _by: &str, global: &str) -> String {
    let mut s = String::new();
    // House rules before the role: the app-wide AGENTS.md (global_prompt.rs)
    // is the first block, then the agent's own persona.
    if !global.trim().is_empty() {
        s += global.trim();
        s += "\n\n";
    }
    if !def.system.trim().is_empty() {
        s += def.system.trim();
        s += "\n\n";
    }
    s += &format!(
        "You are agent \"{name}\" in project \"{session}\" (a tmux session managed by tmux-mobile).\n\
         \n\
         tmm collaboration flow:\n\
         - Messages arrive in your pane as `[tmm chat YYYY-MM-DD HH:MM] <sender>: <text>`. A message that arrives while you work either waits for the current turn to end or joins it, depending on your CLI and its input mode; it never cancels your turn.\n\
         - A Team agent may receive a `[tmm team context …]` block before the current message, which comes last. It is background since that agent's previous delivery, with `sender -> recipients` on every row; use it to understand the room, not as new instructions addressed to you.\n\
         - Hooks automatically record your normal final response in the project room. It is also delivered back to every agent whose request the turn carried (never to the human's pane, never to you). Do not repeat it with `tmm send`.\n\
         - Use `tmm send \"@name message\"` only to start a new question, notification, or handoff. One message may address several names; `@all` reaches every agent and `@human` reaches the operator. An ordinary send without a recipient is rejected.\n\
         - Use `tmm send \"current progress\" --status` for optional ambient progress. It records in the room without interrupting anyone or suppressing your final response.\n\
         - Use `tmm log --limit 50` for recent messages, `tmm log --grep <text> [--global]` to search history, and `tmm agent list` for participants. Read a queued backlog in full before replying once; when context is unclear, check the log or ask the relevant person.\n\
         - For a board issue, run `tmm board take <id>`, record progress with `tmm board note <id> \"...\"`, and hand off completed work with `tmm board move <id> review`.\n\
         - Delegate independent parallel work with `tmm spawn <agent> --brief \"...\"` or `tmm spawn --team <team> --brief \"...\"`. State the objective, inputs, outputs, and completion criteria; results return automatically.\n\
         - With no message, wait. If tmm is temporarily unavailable, continue local work. Use `tmm --help` for the remaining commands."
    );
    s
}

/// Skills: each entry is either a central asset NAME (reg_skills → its ref)
/// or a raw ref (local dir / github url) — central names win, raw refs keep
/// working, nothing migrates.
fn resolve_skill_refs(def: &RegAgent, home: &Path) -> Vec<crate::projects::skills::ResolvedSkill> {
    let entries: Vec<String> = serde_json::from_str(&def.skills).unwrap_or_default();
    let central: std::collections::HashMap<String, String> = super::with_registry_skills();
    let refs: Vec<String> = entries
        .into_iter()
        .map(|e| central.get(&e).cloned().unwrap_or(e))
        .collect();
    crate::projects::skills::resolve_skills(&refs, &home.to_string_lossy())
}

/// Seed `<ws>/.tmm/mcp.json` from registry defs — MERGE, never clobber: the
/// file is the AGENT's to edit (owner, 2026-08-28: "agent 自己写一个 mcp 配置
/// 配件"), so an existing entry always wins over the registry's copy and
/// unknown entries are kept. The standard shape (claude_mcp_value) is what
/// the MCP Inspector CLI reads. Returns the config path.
pub(crate) fn seed_mcp_config(
    workspace: &Path,
    defs: &[shared::McpDef],
) -> Result<std::path::PathBuf, String> {
    let dir = workspace.join(".tmm");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .tmm: {e}"))?;
    let path = dir.join("mcp.json");
    let mut root: Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    if !root.get("mcpServers").map(|v| v.is_object()).unwrap_or(false) {
        root["mcpServers"] = json!({});
    }
    let servers = root["mcpServers"].as_object_mut().unwrap();
    let mut changed = false;
    for m in defs {
        if !m.name.is_empty() && !servers.contains_key(&m.name) {
            servers.insert(m.name.clone(), shared::claude_mcp_value(m));
            changed = true;
        }
    }
    if changed || !path.is_file() {
        std::fs::write(&path, serde_json::to_string_pretty(&root).unwrap())
            .map_err(|e| format!("write mcp.json: {e}"))?;
    }
    Ok(path)
}

/// MCP: an array entry that is a STRING names a central server (reg_mcp);
/// an inline object is used as-is.
pub(crate) fn mcp_defs(def: &RegAgent) -> Vec<shared::McpDef> {
    let entries: Vec<serde_json::Value> = serde_json::from_str(&def.mcp).unwrap_or_default();
    let central = super::with_registry_mcp();
    entries
        .into_iter()
        .filter_map(|e| match e {
            serde_json::Value::String(name) => {
                let def_json = central.get(&name)?;
                let mut parsed: shared::McpDef = serde_json::from_str(def_json).ok()?;
                if parsed.name.is_empty() {
                    parsed.name = name;
                }
                Some(parsed)
            }
            obj => serde_json::from_value(obj).ok(),
        })
        .collect()
}

/// Bring a managed agent's config up to date with this build, in place. Returns
/// true when a file changed. Two things are ours to rewrite — the `hooks` key
/// and a `--model` an older build left on the launch line; the prompt is not,
/// because it carries the agent's brief, which was given once at spawn and
/// cannot be rebuilt here.
///
/// Called on every start (`hub_agent_restart`, and `reconcile` when a project
/// comes up), so the app owns these configs rather than trusting whatever an
/// older version wrote.
pub fn refresh_hooks(project_path: &str, window_name: &str) -> bool {
    let Some(home) = super::agents::home_dir(project_path, window_name) else { return false };
    if !home.is_dir() {
        return false; // not a managed agent
    }
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    if notifications.ensure_helper().is_err() {
        return false;
    }
    // Each backend repairs its own on-disk surface (board #128): every half
    // probes for its file(s) and no-ops otherwise, exactly as the inline
    // branches always did — refresh does not need to know which backend the
    // home belongs to.
    let mut changed = false;
    for b in crate::backends::Backend::ALL {
        changed |= b.refresh(&home, window_name, Path::new(project_path), &notifications);
    }
    changed
}

/// Replace the `hooks` key of a JSON config, leaving everything else alone.
/// A no-op when the value already matches, so starting a project does not
/// rewrite files for nothing.
pub(crate) fn patch_hooks(path: &std::path::Path, hooks: Value) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else { return false };
    let Some(obj) = root.as_object_mut() else { return false };
    if obj.get("hooks") == Some(&hooks) {
        return false;
    }
    obj.insert("hooks".into(), hooks);
    std::fs::write(path, serde_json::to_string_pretty(&root).unwrap_or(text)).is_ok()
}

/// ` --effort <level>` for the backends whose CLI takes the flag (kiro,
/// claude, grok — measured; codex takes a config override instead), or the
/// empty string. The value was validated against `models::effort_values` at
/// save time, so a typo cannot reach a launch line. Empty = backend default,
/// same contract as the model.
pub(crate) fn effort_flag(def: &RegAgent) -> String {
    let effort = def.effort.trim();
    if effort.is_empty() {
        String::new()
    } else {
        format!(" --effort {}", crate::shell::quote(effort))
    }
}

fn tmm_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(backend: &str) -> RegAgent {
        // Central-asset resolution in mcp_defs/resolve_skill_refs touches the
        // process-global store — it must NEVER be the user's real state.db.
        super::super::tests::use_test_store();
        RegAgent {
            name: "tester".into(),
            backend: backend.into(),
            model: String::new(),
            effort: String::new(),
            input_mode: "queue".into(),
            system: "Persona text.".into(),
            skills: "[]".into(),
            mcp: r#"[{"name":"files","command":"mcp-files","args":["--root","/tmp"]}]"#.into(),
        }
    }

    #[test]
    fn kiro_home_is_isolated_and_wired_to_tmm() {
        let dir = std::env::temp_dir().join(format!("tmm-spawn-kiro-{}", uuid::Uuid::new_v4()));
        let mut d = def("kiro");
        d.model = "claude-haiku-4.5".into();
        let r = render_kiro(&d, "tester", &dir, &dir, &build_prompt(&d, "tester", "proj", "fix the bug", "lead", ""), &[]).unwrap();
        assert!(r.env.iter().any(|(k, v)| k == "KIRO_HOME" && v.contains("tmm-spawn-kiro")), "home must be the isolated dir");
        // Board #183: a managed pane is unattended — kiro-cli's launch-time
        // "Refresh it now with mwinit? [y/N]" would park the agent until a
        // human types. kiro-cli 2.21.4 reads this switch beside that prompt.
        assert!(r.env.iter().any(|(k, v)| k == "KIRO_SKIP_MIDWAY_CHECK" && v == "1"), "no y/N gate at an unattended launch: {:?}", r.env);
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("agents/tester.json")).unwrap()).unwrap();
        // The model lives in the CONFIG, not on the launch line: kiro's TUI
        // treats an unknown `--model` as a warning and runs its default, so a
        // flag made a wrong id invisible (owner report, 2026-08-19).
        assert_eq!(conf.get("model").and_then(|m| m.as_str()), Some("claude-haiku-4.5"));
        assert!(!r.cmd.contains("--model"), "no model on the launch line: {}", r.cmd);
        // Board #207 (kiro-cli 2.22.1): the 3.0 profile shape for both engines —
        // hooks as a named ARRAY, permissions.rules allowing all — so the CLI's
        // "still in the 2.0 format" upgrade (and its .bak) never runs on our
        // homes; the v3 engine reads the model from the home settings.
        let hooks = conf.get("hooks").and_then(|h| h.as_array()).expect("3.0 hooks are an array");
        let triggers: Vec<&str> = hooks.iter().map(|h| h["trigger"].as_str().unwrap()).collect();
        assert_eq!(triggers, ["preToolUse", "postToolUse", "userPromptSubmit", "stop"]);
        assert!(hooks.iter().all(|h| h["action"]["type"] == "command" && h["name"].as_str().unwrap().starts_with("tmm-")));
        assert!(hooks.iter().all(|h| h.get("matcher").is_none()), "no matcher key on any hook — \"*\" invalidates a 3.0 profile: {hooks:?}");
        assert_eq!(conf["permissions"]["rules"][0]["capability"], "all");
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("settings/cli.json")).unwrap()).unwrap();
        assert_eq!(settings.get("chat.defaultModel").and_then(|m| m.as_str()), Some("claude-haiku-4.5"), "v3 reads the model here");
        assert_eq!(settings.get("chat.enableAutoAgentUpgrade").and_then(|m| m.as_bool()), Some(true));
        // The engine door is closed by default: the launch line is what it was.
        assert!(!r.cmd.contains("--agent-engine"), "v2 default leaves no trace: {}", r.cmd);
        let prompt = conf.get("prompt").and_then(|p| p.as_str()).unwrap();
        assert!(prompt.contains("tmm send"), "the tmm paragraph IS the integration");
        assert!(!prompt.contains("fix the bug"), "brief is delivered as the first user message");
        // The prompt must NOT carry a date: it is replayed every time the window
        // is restored, so a baked-in "today" becomes a lie. The KICK carries it.
        let year = chrono::Local::now().format("%Y").to_string();
        assert!(!prompt.contains(&year), "no wall-clock date in a replayed prompt");
        // NOTHING is sent to an agent that was spawned without a brief: an
        // invented first prompt is a message the user never wrote, and it made
        // agents reason about nothing (owner, 2026-08-18).
        assert!(first_prompt("", "").is_none(), "no brief, no prompt");
        assert!(first_prompt("   ", "").is_none(), "whitespace is not a brief");
        // A brief IS something to consume: delivered as the first message,
        // stamped like every later one.
        let p = first_prompt("fix the flaky test", "lead").unwrap();
        assert!(p.starts_with(&format!("[tmm chat {year}-")), "a delivered brief is stamped: {p}");
        assert!(p.contains("] lead: "), "the reply edge names the briefer: {p}");
        assert!(p.ends_with("fix the flaky test"), "the brief is the message: {p}");
        assert!(conf.get("mcpServers").and_then(|m| m.get("files")).is_some(), "registry MCP def must materialize");
        // Tool hooks feed telemetry (3.0 array since #207: find by trigger).
        assert!(conf["hooks"].as_array().unwrap().iter().any(|h| h["trigger"] == "preToolUse"));
        // The CLI settings ship with the home: queue mode is the DEFAULT for
        // every managed kiro agent (owner, 2026-08-20 — a line typed at a busy
        // agent waits for the turn to end instead of steering it mid-flight),
        // and the trust-all confirmation stays off.
        let cli: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("settings/cli.json")).unwrap()).unwrap();
        assert_eq!(cli.get("chat.defaultInterruptBehavior").and_then(|v| v.as_str()), Some("queue"));
        assert_eq!(cli.get("chat.disableTrustAllConfirmation").and_then(|v| v.as_bool()), Some(true));
        // MCP schemas defer into kiro's own tool_search — always (0/0), so a
        // big tool set never floods the context (owner, 2026-08-28).
        assert_eq!(cli.get("toolSearch.enabled").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(cli.get("toolSearch.minPct").and_then(|v| v.as_u64()), Some(0));
        assert_eq!(cli.get("toolSearch.minTokens").and_then(|v| v.as_u64()), Some(0));
        // A restart must replay the FULL identity, not the bare backend line:
        // the user-space config's hooks never fire (measured), so losing
        // KIRO_HOME/--agent makes a restarted agent observably deaf.
        LaunchRecipe { backend: "kiro", env: &r.env, cmd: &r.cmd, spawned_by: "", team: None, agent_def: "", member: "", input_mode: "" }.write(&dir).unwrap();
        let line = relaunch_line(
            dir.parent().unwrap().parent().unwrap().to_str().unwrap(),
            "tester", Some("abc-123"),
        );
        // agent_home(workspace, name) = <ws>/.tmm/agents/<name>; our temp dir is
        // not that shape, so call the parts directly instead:
        let recipe: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("launch.json")).unwrap()).unwrap();
        assert_eq!(recipe["backend"], "kiro");
        let cmd = recipe["cmd"].as_str().unwrap();
        assert!(cmd.contains("--agent tester"), "identity survives: {cmd}");
        assert!(!cmd.contains("session start"), "no synthetic kick anywhere: {cmd}");
        let _ = line; // shape of the ws path differs in this fixture; covered below
        // Turn start resets the same-turn dedup flag. Without it a managed
        // agent that calls `tmm send` once never auto-posts again.
        let turn: Vec<&serde_json::Value> = conf["hooks"].as_array().unwrap().iter().filter(|h| h["trigger"] == "userPromptSubmit").collect();
        assert_eq!(turn.len(), 1, "managed kiro must carry the turn-start hook");
        assert!(
            turn[0]["action"]["command"].as_str().is_some_and(|c| c.contains("tmux-mobile")),
            "turn-start hook must run the notify helper, got {turn:?}"
        );
        assert!(!r.cmd.contains("@team"), "no team plumbing in registry agents");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A config written by an older build must not stay that way: agents
    /// spawned before `userPromptSubmit` existed kept a three-hook set, and
    /// that hook is the only reset of the same-turn dedup flag — so their first
    /// `tmm send` killed the stop-hook auto-post for good. Every start now
    /// re-materializes the hooks in place, and nothing else.
    #[test]
    fn refresh_hooks_repairs_a_stale_config_without_touching_the_prompt() {
        let ws = std::env::temp_dir().join(format!("tmm-refresh-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/dev/agents");
        std::fs::create_dir_all(&home).unwrap();
        let cfg = home.join("dev.json");
        // What the old renderer wrote: no turn-start hook, and a brief baked
        // into the prompt that cannot be rebuilt from anywhere.
        std::fs::write(&cfg, serde_json::to_string_pretty(&json!({
            "name": "dev",
            "prompt": "You are dev. Brief: fix the flaky test.",
            "hooks": { "stop": [ { "command": "old-helper kiro" } ] }
        })).unwrap()).unwrap();

        assert!(refresh_hooks(&ws.to_string_lossy(), "dev"), "a stale config is rewritten");
        let after: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        // The 2.0 object gives way to the 3.0 array (board #207), permissions are added.
        let hooks = after.get("hooks").and_then(|h| h.as_array()).unwrap();
        let mut keys: Vec<&str> = hooks.iter().map(|h| h["trigger"].as_str().unwrap()).collect();
        keys.sort();
        assert_eq!(keys, ["postToolUse", "preToolUse", "stop", "userPromptSubmit"]);
        assert_eq!(after["permissions"]["rules"][0]["effect"], "allow");
        assert_eq!(
            after.get("prompt").and_then(|p| p.as_str()),
            Some("You are dev. Brief: fix the flaky test."),
            "the brief survives — only hooks are ours to rewrite"
        );
        // Idempotent: a config already current is not rewritten.
        assert!(!refresh_hooks(&ws.to_string_lossy(), "dev"), "no needless writes");
        // A window with no isolated home is not ours to touch.
        assert!(!refresh_hooks(&ws.to_string_lossy(), "byhand"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Agents spawned before queue mode (or before settings existed at all)
    /// pick it up on their next start: `refresh_hooks` treats settings drift
    /// as config drift. Owner decision, 2026-08-20: every managed kiro agent
    /// runs with `chat.defaultInterruptBehavior = "queue"` — a message typed
    /// at a busy agent is read whole when the turn ends, never steered into
    /// the middle of it.
    #[test]
    fn refresh_hooks_backfills_queue_mode_settings() {
        let ws = std::env::temp_dir().join(format!("tmm-qmode-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        std::fs::write(home.join("agents/dev.json"), serde_json::to_string_pretty(&json!({
            "name": "dev", "prompt": "You are dev.", "hooks": {}
        })).unwrap()).unwrap();
        let cli = home.join("settings/cli.json");

        // Case 1: a pre-settings home has NO cli.json — it is created whole.
        assert!(refresh_hooks(&ws.to_string_lossy(), "dev"));
        let read = || -> serde_json::Value {
            serde_json::from_str(&std::fs::read_to_string(&cli).unwrap()).unwrap()
        };
        assert_eq!(read().get("chat.defaultInterruptBehavior").and_then(|v| v.as_str()), Some("queue"));

        // Case 2: an older file missing the key gains it, and a key the app
        // does not own survives untouched.
        std::fs::write(&cli, serde_json::to_string_pretty(&json!({
            "chat.disableTrustAllConfirmation": true,
            "chat.editMode": "vi"
        })).unwrap()).unwrap();
        assert!(ensure_kiro_settings(&home, ""), "missing key is backfilled");
        let after = read();
        assert_eq!(after.get("chat.defaultInterruptBehavior").and_then(|v| v.as_str()), Some("queue"));
        assert_eq!(after.get("chat.editMode").and_then(|v| v.as_str()), Some("vi"), "foreign keys are not ours to drop");
        assert_eq!(after.get("chat.enableAutoAgentUpgrade").and_then(|v| v.as_bool()), Some(true), "#207: the v3 startup modal is answered in the settings");
        assert!(after.get("chat.defaultModel").is_none(), "#207: no model pinned → no key");

        // Case 3: already canonical — no write, so starting a project does not
        // churn mtimes.
        assert!(!ensure_kiro_settings(&home, ""), "no needless writes");

        // Case 4 (#207): the v3 model mirror follows the profile's model —
        // written when pinned, DELETED when cleared (a stale pin must not
        // outlive the config), idempotent in between.
        assert!(ensure_kiro_settings(&home, "claude-sonnet-5"));
        assert_eq!(read().get("chat.defaultModel").and_then(|v| v.as_str()), Some("claude-sonnet-5"));
        assert!(!ensure_kiro_settings(&home, "claude-sonnet-5"), "same model, no write");
        assert!(ensure_kiro_settings(&home, ""), "cleared → the stale key goes");
        assert!(read().get("chat.defaultModel").is_none());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn refresh_hooks_backfills_claude_status_line() {
        let ws = std::env::temp_dir().join(format!("tmm-cc-status-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/cc");
        std::fs::create_dir_all(&home).unwrap();
        let settings = home.join("settings.json");
        std::fs::write(&settings, serde_json::to_string_pretty(&json!({
            "env": { "ANTHROPIC_MODEL": "agent-override" },
            "hooks": {},
            "theme": "dark"
        })).unwrap()).unwrap();

        assert!(refresh_hooks(&ws.to_string_lossy(), "cc"));
        let read = || -> Value {
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap()
        };
        let after = read();
        assert_eq!(after["statusLine"], shared::claude_status_line_config());
        assert_eq!(after["env"]["ANTHROPIC_MODEL"], "agent-override");
        assert_eq!(after["theme"], "dark");
        assert!(!refresh_hooks(&ws.to_string_lossy(), "cc"), "canonical home is a no-op");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// The grok backend, aligned with kiro (owner, 2026-08-21): isolated
    /// GROK_HOME, identity via `--agent`, MODEL in the definition not on the
    /// line, telemetry hooks in the home's always-trusted hooks dir, MCP +
    /// folder-trust-off in config.toml. All shapes verified live on grok 1.0.5
    /// (an isolated home loaded the agent + hooks and answered a real turn).
    #[test]
    fn grok_home_is_isolated_and_wired_to_tmm() {
        let dir = std::env::temp_dir().join(format!("tmm-spawn-grok-{}", uuid::Uuid::new_v4()));
        let mut d = def("grok");
        d.model = "grok-4.6".into();
        let r = render_grok(&d, "tester", &dir, &build_prompt(&d, "tester", "proj", "fix the bug", "lead", ""), &[]).unwrap();
        assert!(r.env.iter().any(|(k, v)| k == "GROK_HOME" && v.contains("tmm-spawn-grok")), "home must be the isolated dir");
        assert!(r.cmd.contains("--agent tester"), "identity via --agent: {}", r.cmd);
        assert!(r.cmd.contains("--always-approve"), "no interactive permission prompts: {}", r.cmd);
        assert!(!r.cmd.contains("--model"), "the model lives in the definition, not the line: {}", r.cmd);

        let agent_md = std::fs::read_to_string(dir.join("agents/tester.md")).unwrap();
        assert!(agent_md.starts_with("---\nname: tester\n"), "frontmatter first: {agent_md}");
        assert!(agent_md.contains("model: grok-4.6"), "model pinned in frontmatter");
        assert!(agent_md.contains("tmm send"), "the tmm paragraph IS the integration");
        assert!(!agent_md.contains("fix the bug"), "brief is delivered as the first user message");

        let hooks: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("hooks/tmux-mobile.json")).unwrap()).unwrap();
        let h = hooks.get("hooks").unwrap();
        for ev in ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "StopFailure"] {
            assert!(h.get(ev).is_some(), "grok hook set must carry {ev}");
        }

        let cfg = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(cfg.contains("[folder_trust]") && cfg.contains("enabled = false"),
            "trust gate off so the TUI never parks at a prompt nobody sees: {cfg}");
        assert!(cfg.contains("[mcp_servers.files]") && cfg.contains("mcp-files"),
            "registry MCP def must materialize in grok's dialect: {cfg}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn omp_home_is_isolated_and_wired_to_tmm() {
        let dir = std::env::temp_dir().join(format!("tmm-spawn-omp-{}", uuid::Uuid::new_v4()));
        let mut d = def("omp");
        d.model = "anthropic/claude-opus-4-6".into();
        d.effort = "high".into();
        let r = render_omp(&d, "tester", &dir, &build_prompt(&d, "tester", "proj", "fix the bug", "lead", ""), &[]).unwrap();
        assert!(
            r.env.iter().any(|(k, v)| k == "PI_CODING_AGENT_DIR" && v.contains("tmm-spawn-omp")),
            "the agent dir must be the isolated home"
        );
        assert!(r.env.iter().any(|(k, v)| k == "OMP_SKIP_SETUP" && v == "1"),
            "a fresh home must not park the pane in omp's setup wizard (#243)");
        assert!(r.cmd.contains("--auto-approve"), "no interactive approval prompts: {}", r.cmd);
        assert!(r.cmd.contains("--append-system-prompt"), "prompt rides a file, APPENDED: {}", r.cmd);
        assert!(r.cmd.contains("--thinking high"), "effort is omp's own knob: {}", r.cmd);
        assert!(!r.cmd.contains("--model"), "the model lives in config.yml, not the line: {}", r.cmd);
        assert!(!r.cmd.contains("--system-prompt "), "never REPLACE omp's builtin prompt: {}", r.cmd);

        let prompt = std::fs::read_to_string(dir.join("system-prompt.md")).unwrap();
        assert!(prompt.contains("tmm send"), "the tmm paragraph IS the integration");
        assert!(!prompt.contains("fix the bug"), "brief is delivered as the first user message");

        let cfg = std::fs::read_to_string(dir.join("config.yml")).unwrap();
        assert!(cfg.contains("default: anthropic/claude-opus-4-6"), "model pinned in modelRoles: {cfg}");

        let mcp: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("mcp.json")).unwrap()).unwrap();
        assert!(mcp["mcpServers"]["files"]["command"].as_str() == Some("mcp-files"),
            "registry MCP def must materialize in omp's mcp.json: {mcp}");

        let ext = std::fs::read_to_string(dir.join("extensions/tmm-telemetry.ts")).unwrap();
        for needle in ["export default function hook", "UserPromptSubmit", "Stop", "PreToolUse", "PostToolUse", "willContinue"] {
            assert!(ext.contains(needle), "telemetry extension must carry {needle}");
        }
        assert!(ext.contains(" omp #"), "the helper is called with the omp backend tag");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// No model, no effort: the config stays absent (omp default) and the
    /// launch line carries no --thinking.
    #[test]
    fn omp_defaults_leave_config_and_thinking_off() {
        let dir = std::env::temp_dir().join(format!("tmm-spawn-omp-def-{}", uuid::Uuid::new_v4()));
        let d = def("omp");
        let r = render_omp(&d, "t2", &dir, "prompt", &[]).unwrap();
        assert!(!r.cmd.contains("--thinking"), "{}", r.cmd);
        assert!(!dir.join("config.yml").exists(), "empty model writes no config.yml");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Re-rendering the SAME home after the definition drops its model and
    /// its MCP servers leaves neither behind: omp would otherwise keep the old
    /// pinned model and keep loading a revoked server (#241, validator).
    #[test]
    fn omp_rerender_removes_an_unpinned_model_and_revoked_mcp() {
        let dir = std::env::temp_dir().join(format!("tmm-spawn-omp-rr-{}", uuid::Uuid::new_v4()));
        let mut d = def("omp");
        d.model = "anthropic/claude-opus-4-6".into();
        render_omp(&d, "t3", &dir, "prompt", &[]).unwrap();
        assert!(dir.join("config.yml").is_file() && dir.join("mcp.json").is_file(), "first render declares both");
        d.model = String::new();
        d.mcp = "[]".into();
        render_omp(&d, "t3", &dir, "prompt", &[]).unwrap();
        assert!(!dir.join("config.yml").exists(), "an unpinned model falls back to omp's default");
        assert!(!dir.join("mcp.json").exists(), "a revoked MCP server is gone");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The model catalog is what makes an ISOLATED grok home able to answer at
    /// all: grok auth is home-scoped, and custom [model.*] entries carry the
    /// api key wiring (env_key). The first cut parsed the user config with
    /// `toml::Value::from_str`, which parses a single VALUE — every real
    /// config failed with "expected nothing" and the catalog silently
    /// vanished, leaving the spawned agent at a login screen (live, 2026-08-21).
    #[test]
    fn grok_config_carries_the_user_model_catalog() {
        let user = r#"
[models]
default = "bedrock-x"

[model.bedrock-x]
model = "us.xai.grok-4.6"
base_url = "https://example.com/v1"
env_key = "SOME_TOKEN_VAR"

[ui]
yolo = false

[[hooks.PreToolUse]]
matcher = "Bash"
hooks = [ { type = "command", command = "/opt/guard.sh" } ]
"#;
        let cfg = grok_config_toml_from(&[], Some(user));
        assert!(cfg.contains("[models]") && cfg.contains("default = \"bedrock-x\""), "catalog default: {cfg}");
        assert!(cfg.contains("[model.bedrock-x]") && cfg.contains("env_key"), "custom model with key wiring: {cfg}");
        // Isolation is the point: user hooks/UI prefs must NOT leak in.
        assert!(!cfg.contains("guard.sh") && !cfg.contains("[ui]"), "only the catalog carries: {cfg}");
        assert!(cfg.contains("enabled = false"), "folder trust off");
        // No user config at all still renders a valid file.
        let bare = grok_config_toml_from(&[], None);
        assert!(bare.contains("[folder_trust]"));
    }

    /// An empty model means the BACKEND's default — which is what the agent
    /// editor's placeholder promises. The key is omitted rather than pinned to
    /// a hardcoded id (the launch line used to force `claude-sonnet-4.6`).
    #[test]
    fn no_model_configured_leaves_the_backend_default_alone() {
        let dir = std::env::temp_dir().join(format!("tmm-spawn-nomodel-{}", uuid::Uuid::new_v4()));
        let mut d = def("kiro");
        d.model = "   ".into();
        let r = render_kiro(&d, "tester", &dir, &dir, "p", &[]).unwrap();
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("agents/tester.json")).unwrap()).unwrap();
        assert!(conf.get("model").is_none(), "no key at all, not \"\" (kiro rejects that): {conf}");
        assert!(!r.cmd.contains("--model"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Agents spawned by an older build carry their model on the launch line,
    /// where kiro downgrades a wrong id silently — and where the recipe backfill
    /// drops it entirely on restart. Every start moves it into the config once.
    #[test]
    fn a_launch_line_model_migrates_into_the_config() {
        let ws = std::env::temp_dir().join(format!("tmm-modelmig-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        let cfg = home.join("agents").join("dev.json");
        std::fs::write(&cfg, serde_json::to_string_pretty(&json!({
            "name": "dev",
            "prompt": "You are dev.",
            "hooks": {}
        })).unwrap()).unwrap();
        LaunchRecipe { backend: "kiro", env: &[("KIRO_HOME".to_string(), home.to_string_lossy().to_string())], cmd: "command kiro-cli chat --agent dev --model claude-haiku-4.5 --trust-all-tools", spawned_by: "", team: None, agent_def: "", member: "", input_mode: "" }
            .write(&home)
            .unwrap();

        assert!(refresh_hooks(&ws.to_string_lossy(), "dev"), "a stale config is rewritten");
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(after.get("model").and_then(|m| m.as_str()), Some("claude-haiku-4.5"));
        let recipe: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        let cmd = recipe["cmd"].as_str().unwrap();
        assert!(!cmd.contains("--model"), "the line must not keep a second opinion: {cmd}");
        assert!(cmd.contains("--agent dev") && cmd.contains("--trust-all-tools"), "{cmd}");
        // Idempotent, and a model already in the config outranks the line.
        assert!(!refresh_hooks(&ws.to_string_lossy(), "dev"), "no needless writes");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// The migration must preserve what was really RUNNING, and an id the
    /// backend rejects was never that: kiro fell back to its default. Carrying
    /// such a typo into the config would turn a working agent into a mute one
    /// on its next restart, so it is dropped — the line is still cleaned up.
    #[test]
    fn a_launch_line_model_the_backend_rejects_is_dropped_not_migrated() {
        if super::super::models::list("kiro").is_none() {
            eprintln!("kiro-cli unavailable — nothing can be rejected, skipping");
            return;
        }
        let ws = std::env::temp_dir().join(format!("tmm-modelbad-{}", uuid::Uuid::new_v4()));
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(home.join("agents")).unwrap();
        let cfg = home.join("agents").join("dev.json");
        std::fs::write(&cfg, serde_json::to_string_pretty(&json!({ "name": "dev", "hooks": {} })).unwrap()).unwrap();
        LaunchRecipe { backend: "kiro", env: &[], cmd: // The owner's real value: one character off `claude-sonnet-4.5`.
            "command kiro-cli chat --agent dev --model claude-sonnet-4-5 --trust-all-tools", spawned_by: "", team: None, agent_def: "", member: "", input_mode: "" }.write(&home).unwrap();

        refresh_hooks(&ws.to_string_lossy(), "dev");
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert!(after.get("model").is_none(), "a rejected id must not reach the config: {after}");
        let recipe: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        assert!(!recipe["cmd"].as_str().unwrap().contains("--model"), "the line is cleaned up either way");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// The workspace mcp.json is the AGENT's file: the registry seeds missing
    /// servers, an existing entry always wins (an agent-edited command must
    /// survive every respawn), and unknown entries are kept.
    #[test]
    fn mcp_config_seeds_and_never_clobbers() {
        let ws = std::env::temp_dir().join(format!("tmm-mcpseed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&ws).unwrap();
        let mk = |name: &str, cmd: &str| -> shared::McpDef {
            serde_json::from_value(json!({ "name": name, "command": cmd })).unwrap()
        };
        // First spawn seeds.
        let path = seed_mcp_config(&ws, &[mk("files", "mcp-files")]).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["files"]["command"], json!("mcp-files"));
        // The agent edits the entry and adds its own server.
        std::fs::write(&path, serde_json::to_string(&json!({ "mcpServers": {
            "files": { "command": "my-forked-files" },
            "mine":  { "command": "hand-added" },
        }})).unwrap()).unwrap();
        // A later spawn adds the new def but touches NOTHING the agent wrote.
        seed_mcp_config(&ws, &[mk("files", "mcp-files"), mk("web", "mcp-web")]).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["files"]["command"], json!("my-forked-files"), "agent edit survives");
        assert_eq!(v["mcpServers"]["mine"]["command"], json!("hand-added"), "agent's own server kept");
        assert_eq!(v["mcpServers"]["web"]["command"], json!("mcp-web"), "new def seeded");
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn claude_channel_backfill_adds_new_keys_without_stomping_overrides() {
        let mut managed = json!({
            "env": {
                "CLAUDE_CODE_USE_BEDROCK": "1",
                "ANTHROPIC_MODEL": "agent-specific-model"
            },
            "hooks": {}
        });
        let global = json!({
            "CLAUDE_CODE_USE_BEDROCK": "1",
            "ANTHROPIC_MODEL": "global-model",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "global-haiku"
        });
        assert!(merge_missing_claude_env(&mut managed, &global));
        assert_eq!(managed["env"]["ANTHROPIC_MODEL"], "agent-specific-model");
        assert_eq!(managed["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"], "global-haiku");
        assert!(!merge_missing_claude_env(&mut managed, &global), "second refresh is a no-op");
    }

    #[test]
    fn claude_state_pretrusts_the_git_root_without_clobbering_session_data() {
        let root = std::env::temp_dir().join(format!("tmm-cc-trust-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("repo/subdir");
        let home = root.join("home");
        std::fs::create_dir_all(root.join("repo/.git")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let state = home.join(".claude.json");
        std::fs::write(&state, r#"{"userID":"keep","projects":{"/other":{"lastSessionId":"abc"}}}"#).unwrap();

        assert!(ensure_claude_state(&home, &workspace).unwrap());
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        let repo = std::fs::canonicalize(root.join("repo")).unwrap().to_string_lossy().into_owned();
        assert_eq!(after["projects"][repo]["hasTrustDialogAccepted"], json!(true));
        assert_eq!(after["projects"]["/other"]["lastSessionId"], "abc");
        assert_eq!(after["userID"], "keep");
        assert_eq!(after["hasCompletedOnboarding"], json!(true));
        assert!(!ensure_claude_state(&home, &workspace).unwrap(), "canonical state is a no-op");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&state).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn codex_launch_line_pre_answers_its_startup_prompts() {
        // Board #184 (owner 2026-09-12: "codex 启动会有提示是否升级，这个也要屏蔽掉，
        // 以及…是否信任当前文件夹目录"). A managed pane is unattended: the two
        // startup screens are answered on the launch line, as config
        // overrides — never by editing the user's config.toml (the isolated
        // home's config.toml is a symlink into it).
        // Removed on drop (board #269: this one leaked per run).
        let scratch = crate::tmux::Scratch::new("spawn-codex");
        let dir = std::path::PathBuf::from(scratch.path());
        let d = def("codex");
        let prompt = build_prompt(&d, "tester", "proj", "", "", "");
        let cmd = render_codex(&d, "tester", &dir, Path::new("/srv/work/my-app"), &prompt, &[]).unwrap().cmd;
        assert!(cmd.contains("check_for_update_on_startup=false"), "no update prompt: {cmd}");
        // Measured on codex-cli 0.154.0: the `-c` key is split on dots and a
        // quoted segment is NOT honoured, so the path rides unquoted.
        assert!(cmd.contains("projects./srv/work/my-app.trust_level="), "trust pre-answered for the workspace: {cmd}");
        assert!(!cmd.contains("projects.\"") && !cmd.contains("projects.\\\""), "no quoted segment: {cmd}");
        // A path with a dot cannot be expressed as a `-c` key; the pane
        // watcher (StartupConfirmation) still answers that screen.
        let dotted = render_codex(&d, "tester", &dir, Path::new("/srv/work/my.app"), &prompt, &[]).unwrap();
        assert!(!dotted.cmd.contains("trust_level"), "a dotted path is left to the watcher: {}", dotted.cmd);
        assert!(dotted.confirmation.is_some(), "the watcher stays as the fallback");
        assert!(dotted.cmd.contains("check_for_update_on_startup=false"));
    }

    /// Board #245: the definition's input mode, rendered by each switching
    /// backend into its own config — kiro's `settings/cli.json` key, codex's
    /// keymap overrides (measured doors; see the backend files). Queue is the
    /// default; codex pins both keymap bindings for either mode, because the
    /// user's own config.toml (symlinked into the home) may remap them.
    #[test]
    fn the_input_mode_renders_into_each_switching_backend() {
        // Removed on drop, also on failure (board #269).
        let scratch = crate::tmux::Scratch::new("spawn-mode");
        let dir = std::path::PathBuf::from(scratch.path());
        let cli = || -> serde_json::Value {
            serde_json::from_str(&std::fs::read_to_string(dir.join("settings/cli.json")).unwrap()).unwrap()
        };
        let mut d = def("kiro");
        let prompt = build_prompt(&d, "tester", "proj", "", "", "");
        render_kiro(&d, "tester", &dir, &dir, &prompt, &[]).unwrap();
        assert_eq!(cli()["chat.defaultInterruptBehavior"], "queue");
        d.input_mode = "steer".into();
        render_kiro(&d, "tester", &dir, &dir, &prompt, &[]).unwrap();
        assert_eq!(cli()["chat.defaultInterruptBehavior"], "steer", "a restart re-renders the def's mode");
        // The repair path (project up, no def) keeps a valid mode and only
        // backfills a home that predates the key.
        assert!(!ensure_kiro_settings(&dir, ""), "steer is kept, nothing to write");
        assert_eq!(cli()["chat.defaultInterruptBehavior"], "steer");
        let mut stale = cli();
        stale.as_object_mut().unwrap().remove("chat.defaultInterruptBehavior");
        std::fs::write(dir.join("settings/cli.json"), stale.to_string()).unwrap();
        assert!(ensure_kiro_settings(&dir, ""));
        assert_eq!(cli()["chat.defaultInterruptBehavior"], "queue", "a pre-key home backfills queue");

        let mut c = def("codex");
        let queue = render_codex(&c, "tester", &dir, &dir, &prompt, &[]).unwrap().cmd;
        assert!(queue.contains(r#"-c 'tui.keymap.composer.queue="enter"'"#), "{queue}");
        assert!(queue.contains(r#"-c 'tui.keymap.composer.submit="tab"'"#), "{queue}");
        c.input_mode = "steer".into();
        let steer = render_codex(&c, "tester", &dir, &dir, &prompt, &[]).unwrap().cmd;
        // Steer pins codex's own defaults, so a queue keymap in the user's
        // config.toml (symlinked into the home) cannot make it queue.
        assert!(steer.contains(r#"-c 'tui.keymap.composer.submit="enter"'"#), "{steer}");
        assert!(steer.contains(r#"-c 'tui.keymap.composer.queue="tab"'"#), "{steer}");
    }

    /// Board #245: `steer` is accepted only where the switch was measured;
    /// every backend accepts `queue`, and nothing else is a mode.
    #[test]
    fn steer_is_offered_only_where_it_was_measured() {
        use crate::backends::Backend;
        let switching: Vec<&str> = Backend::ALL.iter().filter(|b| b.switches_input_mode()).map(|b| b.name()).collect();
        assert_eq!(switching, ["kiro", "codex"]);
        for b in Backend::ALL {
            assert!(super::super::models::validate_input_mode(b.name(), "queue").is_ok());
            assert_eq!(super::super::models::validate_input_mode(b.name(), "steer").is_ok(), b.switches_input_mode(), "{}", b.name());
            assert!(super::super::models::validate_input_mode(b.name(), "").is_err());
            assert_eq!(b.describe()["input_modes"], b.switches_input_mode(), "the client reads the switch, never mirrors it");
        }
        assert!(super::super::models::validate_input_mode("kiro", "interrupt").is_err());
    }

    #[test]
    fn claude_and_codex_render_without_team_plumbing() {
        for backend in ["claude", "codex"] {
            let dir = std::env::temp_dir().join(format!("tmm-spawn-{backend}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let d = def(backend);
            let prompt = build_prompt(&d, "tester", "proj", "", "", "");
            let r = match backend {
                "claude" => render_claude(&d, "tester", &dir, &dir, &prompt, &[]).unwrap(),
                _ => render_codex(&d, "tester", &dir, &dir, &prompt, &[]).unwrap(),
            };
            assert!(!r.cmd.contains("x-room"), "no team room headers");
            assert!(r.cmd.contains("files") || dir.join("mcp.json").exists(), "registry MCP present");
            // The prompt does NOT teach `tmm mcp` — the CLI door is a SKILL
            // an agent opts into, never the native path (owner, 2026-08-28).
            assert!(!prompt.contains("tmm mcp"), "prompt must not teach the MCP CLI");
            if backend == "codex" {
                // The prompt is a FILE in the isolated CODEX_HOME (owner,
                // 2026-09-08), not a launch argument: the ~6 KB
                // developer_instructions override made the recipe line bigger
                // than a tty can take in one send-keys burst (≳2KB), which is
                // exactly how the restart replay mangled it. The launch line
                // must stay under that budget.
                let agents_md = std::fs::read_to_string(dir.join("codex").join("AGENTS.md")).unwrap();
                assert_eq!(agents_md, prompt, "the whole prompt lands in AGENTS.md");
                assert!(!r.cmd.contains("developer_instructions"), "{}", r.cmd);
                assert!(r.cmd.len() < 2000, "launch line must fit one send-keys burst: {} bytes", r.cmd.len());
            }
            if backend == "claude" {
                // The isolated home is claude's KIRO_HOME (measured on claude
                // 2.1.239: CLAUDE_CONFIG_DIR relocates state AND the user
                // settings layer, so the channel env is inherited into the
                // isolated settings.json instead).
                assert!(
                    r.env.iter().any(|(k, v)| k == "CLAUDE_CONFIG_DIR" && v == &dir.to_string_lossy()),
                    "isolated config dir: {:?}", r.env
                );
                let settings: Value = serde_json::from_str(
                    &std::fs::read_to_string(dir.join("settings.json")).unwrap()
                ).unwrap();
                assert!(settings.get("env").is_some_and(Value::is_object), "inherited channel env");
                assert_eq!(settings["statusLine"], shared::claude_status_line_config());
                assert_eq!(settings["skipDangerousModePermissionPrompt"], json!(true));
                // A fresh config dir parks at the theme onboarding without this.
                let state: Value = serde_json::from_str(
                    &std::fs::read_to_string(dir.join(".claude.json")).unwrap()
                ).unwrap();
                assert_eq!(state["hasCompletedOnboarding"], json!(true));
                let trust_key = std::fs::canonicalize(&dir).unwrap().to_string_lossy().into_owned();
                assert_eq!(state["projects"][trust_key]["hasTrustDialogAccepted"], json!(true));
                // def() has no model → the BACKEND default (the inherited
                // env's ANTHROPIC_MODEL) decides; the old `--model sonnet`
                // alias overrode it and does not resolve on Bedrock.
                assert!(!r.cmd.contains("--model"), "{}", r.cmd);
                // The prompt is a FILE (owner, 2026-09-08): CLAUDE.md in the
                // isolated CLAUDE_CONFIG_DIR — verified live that a relocated
                // dir's CLAUDE.md is read and obeyed. The launch line was the
                // last one bigger than a send-keys burst; keep it under.
                let claude_md = std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap();
                assert_eq!(claude_md, prompt, "the whole prompt lands in CLAUDE.md");
                assert!(!r.cmd.contains("--append-system-prompt"), "{}", r.cmd);
                assert!(r.cmd.len() < 2000, "launch line must fit one send-keys burst: {} bytes", r.cmd.len());
            }
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// Effort rides each backend's own knob (owner, 2026-08-22: "agent配置里
    /// 应该有thinking effort的配置选项"): a `--effort` flag for kiro/claude/
    /// grok (measured on each CLI), a `-c model_reasoning_effort=…` config
    /// override for codex. Empty = the backend default, nothing on the line.
    #[test]
    fn effort_reaches_each_backend_in_its_own_dialect() {
        let dir = std::env::temp_dir().join(format!("tmm-effort-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut d = def("kiro");
        d.effort = "high".into();
        let prompt = build_prompt(&d, "t", "p", "", "", "");
        assert!(render_kiro(&d, "t", &dir, &dir, &prompt, &[]).unwrap().cmd.ends_with("--effort high"));
        d.backend = "claude".into();
        assert!(render_claude(&d, "t", &dir, &dir, &prompt, &[]).unwrap().cmd.contains(" --effort high "));
        d.backend = "grok".into();
        assert!(render_grok(&d, "t", &dir, &prompt, &[]).unwrap().cmd.ends_with("--effort high"));
        d.backend = "codex".into();
        let cx = render_codex(&d, "t", &dir, &dir, &prompt, &[]).unwrap().cmd;
        assert!(cx.contains("model_reasoning_effort=\\\"high\\\"") || cx.contains("model_reasoning_effort=\"high\""), "{cx}");
        // Empty effort leaves every line clean.
        d.effort = String::new();
        d.backend = "kiro".into();
        assert!(!render_kiro(&d, "t", &dir, &dir, &prompt, &[]).unwrap().cmd.contains("--effort"));
        // Validation is a fixed enum per backend; empty always passes.
        assert!(super::super::models::validate_effort("kiro", "xhigh").is_ok());
        assert!(super::super::models::validate_effort("codex", "minimal").is_ok());
        assert!(super::super::models::validate_effort("grok", "max").is_err(), "grok has no max");
        assert!(super::super::models::validate_effort("claude", "ultra").is_err());
        assert!(super::super::models::validate_effort("claude", "").is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The turn-start hook is the ONLY reset of the same-turn dedup flag and
    /// the only carrier of the submitted prompt (the delivery receipt), so it
    /// must be registered in EVERY backend's hook set. Claude and codex
    /// shipped without it: their agents lost the stop-hook auto-post forever
    /// after their first `tmm send`, and every delivered line stayed
    /// "unconfirmed" (owner, 2026-08-22: 特性对齐). Codex payload measured on
    /// codex-cli 0.148.0; claude's documented schema is the same family.
    #[test]
    fn every_backend_hook_set_registers_the_turn_start_hook() {
        // kiro writes the 3.0 ARRAY shape (board #207): trigger names carry the events.
        let kiro_triggers: Vec<String> = kiro_hooks("n").as_array().unwrap().iter()
            .map(|h| h["trigger"].as_str().unwrap().to_string()).collect();
        assert!(kiro_triggers.iter().any(|t| t == "userPromptSubmit"), "kiro");
        assert!(claude_hooks("n")["UserPromptSubmit"].is_array(), "claude");
        assert!(codex_hooks("n")["UserPromptSubmit"].is_array(), "codex");
        assert!(grok_hooks("n")["UserPromptSubmit"].is_array(), "grok");
        // And every set still ends turns: a stop hook.
        assert!(kiro_triggers.iter().any(|t| t == "stop"));
        for f in [claude_hooks, codex_hooks, grok_hooks] {
            assert!(f("n")["Stop"].is_array());
        }
    }

    #[test]
    fn central_mcp_and_skill_names_resolve_at_spawn() {
        super::super::tests::use_test_store();
        // Define central assets, then reference them by NAME from an agent.
        super::super::mcp_save(&serde_json::json!({
            "name": "central-files",
            "def": "{\"command\":\"mcp-files\",\"args\":[\"--root\",\"/tmp\"]}"
        })).unwrap();
        // Skills are imported (files copied into the managed store) — build
        // a real local source so the import path runs for real.
        let src = std::env::temp_dir().join(format!("tmm-central-skill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: central-skill\n---\nbody").unwrap();
        super::super::skill_save(&serde_json::json!({
            "name": "central-skill",
            "source": src.to_string_lossy()
        })).unwrap();
        std::fs::remove_dir_all(&src).ok();
        let mut d = def("kiro");
        d.mcp = r#"["central-files", {"name":"inline","command":"inline-cmd"}]"#.into();
        let resolved = mcp_defs(&d);
        let names: Vec<&str> = resolved.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(resolved.len(), 2, "name entry + inline entry both resolve; got {names:?}");
        assert!(resolved.iter().any(|m| m.name == "central-files" && m.command.as_deref() == Some("mcp-files")),
            "string entry resolves through reg_mcp");
        assert!(resolved.iter().any(|m| m.name == "inline" && m.command.as_deref() == Some("inline-cmd")),
            "inline object keeps working");
        // Unknown names drop silently rather than breaking the spawn.
        d.mcp = r#"["no-such-server"]"#.into();
        assert!(mcp_defs(&d).is_empty());
    }

    #[test]
    fn global_instructions_lead_the_prompt_on_every_backend() {
        let d = def("kiro");
        let p = build_prompt(&d, "b", "proj", "", "", "# House rules\nAnswer in Chinese.\n");
        assert!(p.starts_with("# House rules\nAnswer in Chinese.\n\nPersona text."), "global block first, then the persona: {p}");
        assert!(p.contains("agent \"b\" in project \"proj\""));
        // Absent → the prompt is exactly what it was before the feature.
        assert_eq!(build_prompt(&d, "b", "proj", "", "", "  "), build_prompt(&d, "b", "proj", "", "", ""));
        assert!(build_prompt(&d, "b", "proj", "", "", "").starts_with("Persona text."));
    }

    #[test]
    fn prompt_carries_identity_project_and_rules() {
        let d = def("kiro");
        let p = build_prompt(&d, "rev-2", "blog", "review the branch", "lead", "");
        assert!(p.starts_with("Persona text."));
        assert!(p.contains("agent \"rev-2\" in project \"blog\""));
        assert!(!p.contains("tmm done"));
        assert!(!p.contains("tmm status"));
        assert!(!p.contains("review the branch"), "brief is a real first message: {p}");
        assert!(p.contains("[tmm chat YYYY-MM-DD HH:MM]"), "prompt explains message stamps: {p}");
        assert!(p.contains("final response"), "explains automatic replies: {p}");
        assert!(p.contains("delivered back to every agent whose request the turn carried"), "explains the reply edge (#256): {p}");
        assert!(p.contains("it never cancels your turn"), "a line never interrupts (#279): {p}");
        assert!(p.contains("[tmm team context"), "explains Team catch-up context: {p}");
        assert!(p.contains("sender -> recipients"), "context names who spoke to whom: {p}");
        assert!(p.contains("--status"), "explains ambient progress: {p}");
        assert!(p.contains("@human"), "names the operator address: {p}");
        assert!(p.contains("tmm log --limit 50"), "points at the history: {p}");
        assert!(p.contains("Read a queued backlog in full"), "consolidates backlog answers: {p}");
        assert!(p.contains("tmm board move <id> review"), "explains board handoff: {p}");
    }

    #[test]
    fn first_prompt_names_the_briefer_and_recipe_keeps_provenance() {
        let d = def("kiro");
        let p = build_prompt(&d, "b", "proj", "fix it", "lead", "");
        assert!(!p.contains("fix it"), "brief is not duplicated into the system prompt");
        let first = first_prompt("fix it", "lead").unwrap();
        assert!(first.contains("] lead: fix it"), "the hook can recover the reply edge: {first}");

        // The recipe retains who created the slot as provenance across refresh.
        let ws = std::env::temp_dir().join(format!("tmm-spawnedby-{}", std::process::id()));
        let home = ws.join(".tmm").join("agents").join("b");
        std::fs::create_dir_all(&home).unwrap();
        LaunchRecipe { backend: "kiro", env: &[], cmd: "command kiro-cli chat --agent b", spawned_by: "lead", team: None, agent_def: "", member: "", input_mode: "" }.write(&home).unwrap();
        let recipe: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        assert_eq!(recipe["spawned_by"], "lead");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Restart means "come back up to date": the recipe replay is verbatim, so
    /// `refresh_agent` re-materializes the home from the CURRENT def first
    /// (owner, 2026-09-08: restarting an agent did NOT pick up new prompt
    /// text — global_prompt.rs promised it would). Spawner provenance survives,
    /// while the original brief does not (the conversation is resumed).
    #[test]
    fn refresh_agent_rematerializes_from_the_current_def_and_keeps_the_spawner() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-refresh-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let name = "rfagent";
        let save = |persona: &str| {
            super::super::registry_save(&json!({
                "name": name, "backend": "kiro", "model": "", "effort": "",
                "system": persona, "skills": "[]", "mcp": "[]"
            }))
            .unwrap()
        };
        save("Old persona.");
        let def = super::super::registry_get(name).unwrap().expect("saved def");
        materialize(&def, name, "proj", &ws_str, "fix the login bug", "lead", None, name, "").unwrap();
        let cfg = agent_home(&ws_str, name).join("agents").join(format!("{name}.json"));
        let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() };
        assert!(read(&cfg)["prompt"].as_str().unwrap().contains("Old persona."));

        // The def evolves after the spawn; restart must launch THIS text.
        save("New persona.");
        assert!(refresh_agent(&ws_str, "proj", name), "a registry-named agent refreshes");
        let prompt = read(&cfg)["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("New persona."), "current def text: {prompt}");
        assert!(!prompt.contains("Old persona."));
        assert!(!prompt.contains("fix the login bug"), "the spawn brief is history, not part of a refresh");
        let recipe = read(&agent_home(&ws_str, name).join("launch.json"));
        assert_eq!(recipe["spawned_by"], "lead", "spawner provenance survives");

        // No def / no recipe = no refresh — those windows replay verbatim.
        assert!(!refresh_agent(&ws_str, "proj", "no-such-def"));
        std::fs::remove_dir_all(agent_home(&ws_str, name)).unwrap();
        assert!(!refresh_agent(&ws_str, "proj", name), "a home without a recipe is not ours to rewrite");
        super::super::registry_delete(name).ok();
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #113: a def edit must reach a window whose NAME is not the def's.
    /// Board #254: a member derived from a registry agent overrides the
    /// base's input mode like model/effort. teams_save validates it against
    /// the base's backend, a restart (refresh_agent) renders the effective
    /// mode into the member's own config, and an empty override follows the
    /// base — including a later change of the base.
    #[test]
    fn a_team_member_input_mode_override_renders_on_restart_and_empty_inherits() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-member-mode-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let save = |name: &str, backend: &str, mode: &str| {
            super::super::registry_save(&json!({
                "name": name, "backend": backend, "model": "", "effort": "", "input_mode": mode,
                "system": "Base.", "skills": "[]", "mcp": "[]"
            }))
            .unwrap()
        };
        save("mmbase", "kiro", "queue");
        save("mmclaude", "claude", "queue");
        let team = |members: &str| super::super::teams_save(&json!({ "name": "mmteam", "description": "", "members": members }));
        let err = team(r#"[{"name":"cc","base":"mmclaude","input_mode":"steer"}]"#).unwrap_err();
        assert!(err.contains("member 'cc'") && err.contains("steer is not offered for claude"), "{err}");
        assert!(team(r#"[{"name":"x","base":"mmbase","input_mode":"interrupt"}]"#).is_err(), "only queue|steer");
        team(r#"[{"name":"st","base":"mmbase","input_mode":"steer"},{"name":"in","base":"mmbase"}]"#).unwrap();

        let spawn_all = || {
            let t = super::super::team_get("mmteam").unwrap().unwrap();
            let flat = super::super::teams::expand(&t, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
            let base = super::super::registry_get("mmbase").unwrap();
            let roster: Vec<super::super::teams::RosterEntry> = vec![
                ("st".into(), String::new(), "mmteam".into()),
                ("in".into(), String::new(), "mmteam".into()),
            ];
            for (f, w) in flat.iter().zip(["st", "in"]) {
                let d = super::super::teams::effective_def(f, base.as_ref(), w, &roster).unwrap();
                materialize(&d, w, "proj", &ws_str, "", "", Some("mmteam"), "", f.member.name.trim()).unwrap();
            }
        };
        let mode = |w: &str| -> String {
            let cli: Value = serde_json::from_str(&std::fs::read_to_string(agent_home(&ws_str, w).join("settings/cli.json")).unwrap()).unwrap();
            cli["chat.defaultInterruptBehavior"].as_str().unwrap().to_string()
        };
        spawn_all();
        assert_eq!((mode("st").as_str(), mode("in").as_str()), ("steer", "queue"), "spawn: override, then inherit");
        // The base moves to steer: the inheriting member follows on restart;
        // the member's own override is untouched.
        save("mmbase", "kiro", "steer");
        team(r#"[{"name":"st","base":"mmbase","input_mode":"queue"},{"name":"in","base":"mmbase"}]"#).unwrap();
        assert!(refresh_agent(&ws_str, "proj", "st") && refresh_agent(&ws_str, "proj", "in"));
        assert_eq!((mode("st").as_str(), mode("in").as_str()), ("queue", "steer"), "restart: the override, and the base's new mode");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// The recipe's provenance (`agent_def`, or `team`+`member`) is what the
    /// restart resolves through; a def deleted after the spawn degrades soft.
    #[test]
    fn refresh_agent_follows_the_recipes_provenance_not_the_window_name() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-refresh-prov-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() };
        let save = |name: &str, persona: &str| {
            super::super::registry_save(&json!({
                "name": name, "backend": "kiro", "model": "", "effort": "",
                "system": persona, "skills": "[]", "mcp": "[]"
            }))
            .unwrap()
        };

        // A UNIQUIFIED solo window: def "rfuniq" spawned as window "rfuniq-2"
        // (the name was taken). The window name resolves to no def; the
        // recipe's agent_def is what finds it.
        save("rfuniq", "Uniq old.");
        let def = super::super::registry_get("rfuniq").unwrap().unwrap();
        materialize(&def, "rfuniq-2", "proj", &ws_str, "", "", None, "rfuniq", "").unwrap();
        save("rfuniq", "Uniq new.");
        assert!(refresh_agent(&ws_str, "proj", "rfuniq-2"), "the uniquified window refreshes via agent_def");
        let cfg = agent_home(&ws_str, "rfuniq-2").join("agents").join("rfuniq-2.json");
        let prompt = read(&cfg)["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Uniq new.") && !prompt.contains("Uniq old."), "{prompt}");

        // A TEAM MEMBER: base def + role, spawned as window "dev-2" (member
        // name "dev" was taken). The refresh re-derives the effective def from
        // the CURRENT team, and the roster comes from the sibling recipes.
        save("rfbase", "Base old.");
        super::super::teams_save(&json!({
            "name": "rfteam",
            "description": "",
            "members": r#"[{"name":"dev","base":"rfbase","role":"implement the change"},{"name":"rev","base":"rfbase","role":"review the diff"}]"#
        }))
        .unwrap();
        let team = super::super::team_get("rfteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![
            ("dev-2".into(), "implement the change".into(), "rfteam".into()),
            ("rev".into(), "review the diff".into(), "rfteam".into()),
        ];
        let base = super::super::registry_get("rfbase").unwrap();
        for (f, w) in flat.iter().zip(["dev-2", "rev"]) {
            let d = super::super::teams::effective_def(f, base.as_ref(), w, &roster).unwrap();
            materialize(&d, w, "proj", &ws_str, "", "lead", Some("rfteam"), "", f.member.name.trim()).unwrap();
        }
        save("rfbase", "Base new.");
        assert!(refresh_agent(&ws_str, "proj", "dev-2"), "the team member refreshes via team+member");
        let cfg = agent_home(&ws_str, "dev-2").join("agents").join("dev-2.json");
        let prompt = read(&cfg)["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Base new.") && !prompt.contains("Base old."), "{prompt}");
        assert!(prompt.contains("Your role: implement the change"), "the role block is re-applied: {prompt}");
        assert!(prompt.contains("@rev"), "the roster is reconstructed from sibling recipes: {prompt}");
        let recipe = read(&agent_home(&ws_str, "dev-2").join("launch.json"));
        assert_eq!(recipe["spawned_by"], "lead", "spawner provenance survives the refresh");
        assert_eq!(recipe["team"], "rfteam");
        assert_eq!(recipe["member"], "dev", "def provenance survives the refresh");

        // A def deleted after the spawn: the refresh degrades soft — the
        // spawn-time materials stay, nothing is rewritten.
        super::super::registry_delete("rfuniq").unwrap();
        let before = read(&agent_home(&ws_str, "rfuniq-2").join("agents").join("rfuniq-2.json"));
        assert!(!refresh_agent(&ws_str, "proj", "rfuniq-2"), "a gone def is a soft no");
        let after = read(&agent_home(&ws_str, "rfuniq-2").join("agents").join("rfuniq-2.json"));
        assert_eq!(before, after, "the snapshot keeps working untouched");

        super::super::registry_delete("rfbase").ok();
        super::super::teams_delete("rfteam").ok();
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #286 (owner 2026-09-30: an edited dev-squad kept its old roster):
    /// a team spawned as {dev, old}, then edited to {dev, rev}. The plan,
    /// read from the registry, the recipes and tmux, restarts dev, leaves
    /// the stopped old alone, and spawns rev; and dev's refreshed prompt
    /// already names @rev and no longer @old — the restart takes the edit.
    #[test]
    fn a_team_restart_plans_from_the_edited_definition_and_its_prompts_follow() {
        super::super::tests::use_test_store();
        let scratch = crate::tmux::Scratch::new("team-plan");
        let ws_str = scratch.path();
        let session = format!("tmm-test-team-plan-{}", std::process::id());
        super::super::with_store(|st| st.insert_project(&super::super::Project {
            id: session.clone(), name: session.clone(), path: ws_str.clone(), icon: None,
            session: session.clone(), adopted: false, autostart: false, created_at: 1,
            last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        })).unwrap();
        super::super::registry_save(&json!({
            "name": "tpbase", "backend": "kiro", "model": "", "effort": "",
            "system": "Base.", "skills": "[]", "mcp": "[]"
        })).unwrap();
        let save_team = |members: &str| super::super::teams_save(&json!({ "name": "tpteam", "description": "", "members": members })).unwrap();
        save_team(r#"[{"name":"dev","base":"tpbase","role":"implement"},{"name":"old","base":"tpbase","role":"archive"}]"#);
        let team = super::super::team_get("tpteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = flat.iter().map(|f| (f.member.name.clone(), f.member.role.clone(), f.path.clone())).collect();
        let base = super::super::registry_get("tpbase").unwrap();
        for f in &flat {
            let d = super::super::teams::effective_def(f, base.as_ref(), &f.member.name, &roster).unwrap();
            materialize(&d, &f.member.name, &session, &ws_str, "", "", Some("tpteam"), "", &f.member.name).unwrap();
        }
        save_team(r#"[{"name":"dev","base":"tpbase","role":"implement"},{"name":"rev","base":"tpbase","role":"review"}]"#);

        assert!(in_current_team("tpteam", "dev") && in_current_team("tpteam", "rev"));
        assert!(!in_current_team("tpteam", "old"), "left the definition (#287)");
        assert!(!in_current_team("no-such-team", "dev"));
        let plan = team_plan_for(&session, "tpteam").unwrap();
        assert_eq!(plan, TeamPlan { restart: vec!["dev".into()], stop: vec![], spawn: vec![("tpteam".into(), "rev".into())] },
            "no window is live: old is already stopped, so nothing to stop");
        assert!(refresh_agent(&ws_str, &session, "dev"));
        let prompt: Value = serde_json::from_str(&std::fs::read_to_string(agent_home(&ws_str, "dev").join("agents").join("dev.json")).unwrap()).unwrap();
        let prompt = prompt["prompt"].as_str().unwrap();
        assert!(prompt.contains("@rev") && !prompt.contains("@old"), "the restarted member's roster is the edited team: {prompt}");

        super::super::registry_delete("tpbase").ok();
        super::super::teams_delete("tpteam").ok();
    }
    /// Board #126: the cap counts MANAGED agents only. A project with a few
    /// plain windows (shells, hand-started agents) must not refuse a hire it
    /// has room for; a project at the cap in managed agents must refuse.
    #[test]
    fn spawn_cap_counts_only_managed_windows() {
        let ws = std::env::temp_dir().join(format!("tmm-cap-{}", uuid::Uuid::new_v4()));
        let pane = |w: usize, name: &str| crate::tmux::TmuxPane {
            session: "s".into(), window: w, pane: 0, width: 80, height: 24,
            current_command: "kiro-cli".into(), window_name: name.into(),
            pane_title: String::new(), current_path: String::new(),
            active: true, child_cmd: String::new(), agent: Some("kiro"),
        };
        let managed = |name: &str| {
            let home = ws.join(".tmm/agents").join(name);
            std::fs::create_dir_all(&home).unwrap();
            std::fs::write(home.join("launch.json"), "{}").unwrap();
        };
        // 2 managed + 6 plain windows: the plain ones (no recipe on disk —
        // shells and hand-started agents alike) do not count, so there is
        // still room to hire.
        managed("dev");
        managed("rev");
        let mut panes: Vec<crate::tmux::TmuxPane> = vec![pane(1, "dev"), pane(2, "rev")];
        for n in 3..9 {
            panes.push(pane(n, &format!("shell{n}")));
        }
        let ws_str = ws.to_string_lossy().to_string();
        assert_eq!(managed_window_count(&ws_str, &panes), 2, "six plain windows are not ours");
        assert!(managed_window_count(&ws_str, &panes) < SPAWN_CAP, "room to hire remains");

        // At the cap in MANAGED agents, the count says so.
        for n in 0..6 {
            let name = format!("m{n}");
            managed(&name);
            panes.push(pane(20 + n, &name));
        }
        assert_eq!(managed_window_count(&ws_str, &panes), 8, "eight managed agents");
        assert!(managed_window_count(&ws_str, &panes) >= SPAWN_CAP, "the cap refuses here");
        let _ = std::fs::remove_dir_all(&ws);
    }

}
