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
/// The project's windows as tmux answers RIGHT NOW — the one read every decision
/// about who may start in a home is made from (board #383 review, P1-A).
///
/// "No windows" is an answer only when tmux GIVES it: an empty list, or tmux saying
/// the session does not exist (the project's session is not up yet, and the first
/// spawn creates it). Any other failure — a socket it may not open, tmux not run,
/// an error we do not recognise — is "cannot tell", which refuses; it is never
/// "nothing is running", because a running agent taken for a stopped one has its
/// home rewritten and a second window opened under its name.
fn panes_now(session: &str) -> Result<Vec<tmux::TmuxPane>, String> {
    panes_answer(tmux::list_panes(session))
}

/// `panes_now` over an answer already in hand (the seam the tests use).
fn panes_answer(answer: Result<Vec<tmux::TmuxPane>, String>) -> Result<Vec<tmux::TmuxPane>, String> {
    match answer {
        Ok(panes) => Ok(panes),
        Err(e) if tmux::session_confirmed_absent(&e) => Ok(Vec::new()),
        Err(e) => Err(format!("could not ask tmux which agents are running ({}); nothing was started, try again", e.trim())),
    }
}

/// The window names of `panes_now`.
fn window_names_now(session: &str) -> Result<Vec<String>, String> {
    Ok(panes_now(session)?.into_iter().map(|p| p.window_name).collect())
}

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
    /// A fork of a team member: the member whose definition it copies, without
    /// holding that member's slot (`LaunchRecipe::from_member`, board #383).
    pub from_member: &'a str,
    /// The team this spawn belongs to; recorded in the launch recipe so the
    /// Hub can group the cards. With no `member` it is a JOIN (board #382),
    /// whatever made the def: the agent goes into that running team at
    /// runtime, the team's definition untouched; `spawn` refuses a team with
    /// no member here, and the team must be named by its ROOT.
    pub team: Option<String>,
    /// Restart fallback for a managed home whose slot is not currently
    /// restorable. Normal hires start fresh; Start/Restart resumes this
    /// isolated home's newest cwd conversation.
    pub resume: bool,
    /// The identity claim a caller already made (a fork claims its home before it
    /// builds its definition): `spawn` uses its name and does not reserve one.
    pub claim: Option<&'a Claim>,
}

impl Default for SpawnRequest<'_> {
    fn default() -> Self {
        SpawnRequest {
            session: "", agent: "", brief: "", by: "", def: None,
            window_name: None, team: None, member: "", from_member: "", resume: false, claim: None,
        }
    }
}

/// Spawn `agent` into `session`. Returns `{ window_name, pane }`.
pub fn spawn(req: &SpawnRequest) -> Result<Value, String> {
    let def = resolve_def(req)?;
    check_def(&def)?;

    // No hiring gate: spawning is an ability every agent already has through
    // its shell and `tmm`, so a registry grant added no authority (owner,
    // 2026-09-26: "本身就是 agent 自己能够通过命令行获得的能力"). Fan-out is
    // bounded by the per-project cap below, for humans and agents alike.

    let project = super::project_for_session(req.session)?
        .ok_or_else(|| format!("no project for session '{}'", req.session))?;
    let workspace = project.path.clone();
    // A JOIN is any spawn that names a team with no member (board #382): a
    // registry agent, a fork's effective def (#383), the restart fallback of
    // an agent that joined. Each goes through the same check, whatever made
    // its def (reviewer P2 on 56a3ad44). A team member placed by its team's
    // definition names its member and is not a join.
    if let Some(team) = join_of(req.team.as_deref(), req.member) {
        check_join(&workspace, team)?;
    }

    let panes = panes_now(req.session)?;
    check_cap(&workspace, &panes)?;

    // Window name = agent name, uniquified if taken (lead, lead-2, …). The
    // Window name is the agent's identity for telemetry and tmm messages.
    //
    // A NEW identity is claimed here, in the ONE launcher, by every caller — a
    // hire, a team member, a join, a fork (board #383 review P1-A): two spawns
    // that reach for the same name cannot both get it, and a caller that already
    // holds a claim (a fork) hands it in. A restart's fallback (`resume`) reuses
    // its OWN home and is not a new identity.
    let taken: std::collections::HashSet<&str> = panes.iter().map(|p| p.window_name.as_str()).collect();
    // The allocation reads the windows AGAIN inside its own critical section
    // (`live_now`): the panes read above are only for the cap and for a restart's
    // fallback, and a snapshot taken before another request finished is no
    // licence to take what that request now runs (reviewer round 3).
    let live_now = || window_names_now(req.session);
    let starting = Starting { agent_def: if req.def.is_none() { def.name.as_str() } else { "" }, team: req.team.as_deref().unwrap_or(""), member: req.member };
    let _identity;
    let window_name = match (req.claim, req.resume) {
        (Some(claim), _) => {
            if req.window_name.as_deref().is_some_and(|w| w != claim.name()) {
                return Err("the window name is not the one this request claimed".to_string());
            }
            claim.name().to_string()
        }
        (None, true) => match &req.window_name {
            Some(w) => w.clone(),
            None => uniquify(&def.name, &taken)?,
        },
        (None, false) => {
            let claim = reserve_name(&workspace, &live_now, &starting, req.window_name.as_deref(), &def.name)?;
            let name = claim.name().to_string();
            _identity = claim;
            name
        }
    };
    // A def saved before names were validated, or an explicit window name
    // from a caller, still has to be a plain word here: it is about to be a
    // directory under `.tmm/agents/` and a tmux window name.
    super::agents::valid_name(&window_name)?;
    // The window's identity is decided and nothing has been written for it
    // yet: a hire, a team member or a fork is a START for its Stop intent
    // (board #422, validator F1), under ONE permit taken here.
    let permit = super::start_permit(req.session, &window_name)?;

    // Provenance for restarts (board #113): a registry-resolved spawn records
    // the DEF name (the window may be uniquified past it); a team member
    // records team+member instead and its def is re-derived on refresh.
    let agent_def = if req.def.is_none() { def.name.as_str() } else { "" };
    let m = {
        let section = super::recipe::recipe_section(&agent_home(&workspace, &window_name));
        materialize(&section, &def, &window_name, req.session, &workspace, req.brief, req.by, req.team.as_deref(), agent_def, req.member, req.from_member)?
    };
    let launched = launch_window(req, &workspace, &def, &window_name, m)?;
    if let Err(e) = permit.finish(true) {
        eprintln!("projects: {window_name} launched but its stop mark was not cleared: {e}");
    }
    Ok(launched)
}

/// The definition a request launches: the one handed in, else the registry's by name.
fn resolve_def(req: &SpawnRequest) -> Result<RegAgent, String> {
    match &req.def {
        Some(d) => Ok(d.clone()),
        None => super::registry_get(req.agent)?.ok_or_else(|| format!("no agent named '{}' in the registry", req.agent)),
    }
}

/// A model the backend does not know is not a runtime hiccup: kiro answers
/// the first turn with "not available, use /model" and the agent is alive but
/// mute — no reply, no auto-post, nothing for the app to notice. Registry
/// defs saved before validation existed can still carry one, so refuse here
/// too rather than open a window that cannot work.
fn check_def(def: &RegAgent) -> Result<(), String> {
    super::models::validate(&def.backend, &def.model)?;
    super::models::validate_effort(&def.backend, &def.effort)
}

/// The cap counts MANAGED agents only (board #126) — see managed_window_count.
fn check_cap(workspace: &str, panes: &[tmux::TmuxPane]) -> Result<(), String> {
    let agent_windows = managed_window_count(workspace, panes);
    if agent_windows >= SPAWN_CAP {
        return Err(format!("project already has {agent_windows} agents (cap {SPAWN_CAP}) — finish or close one first"));
    }
    Ok(())
}

/// Open the window and start the CLI in it: everything AFTER an agent has been
/// materialized (its recipe is written and its section released — the lock is
/// never held across the slow tmux launch). `spawn` and `respawn` both end here.
/// It never reads or clears a Stop intent: it runs under the permit of the
/// verb that called it (`spawn` takes its own; a restart's `respawn` runs
/// under the hub's, board #422).
fn launch_window(req: &SpawnRequest, workspace: &str, def: &RegAgent, window_name: &str, m: Materialized) -> Result<Value, String> {
    let home = m.home;
    let env = m.env;

    tmux::ensure_session(req.session, workspace)?;
    let pane = tmux::new_named_window(req.session, window_name, workspace)?;
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
    // A slot a restore still holds keeps its barrier through a respawn: a
    // new generation for this pane, named on the line (board #422).
    // Nothing is typed when that cannot be settled (review P1-B).
    let launch = match super::restore_hold::before_launch(req.session, window_name, &pane)? {
        super::restore_hold::Launch::NoHold => String::new(),
        super::restore_hold::Launch::Replaced(l) => format!("TMM_LAUNCH={l} "),
    };
    let full = format!("{launch}{} {}", prefix, launch_cmd);
    // NEVER send the full line via send-keys — see team/launch.rs: tty shims
    // swallow bursts ≳2KB. Source a script instead.
    let script = shared::write_launch_script(&home, window_name, &full)?;
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
        let (session, window) = (req.session.to_string(), window_name.to_string());
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
    // Inside the home's recipe section (`recipe::recipe_section`): its
    // recipe write goes through the one door.
    section: &super::recipe::RecipeSection,
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
    from_member: &str,
) -> Result<Materialized, String> {
    let home = agent_home(workspace, window_name);
    if !section.is_for(&home) {
        return Err(format!("internal: materialize '{window_name}' outside its recipe section"));
    }
    make_home_private(&home).map_err(|e| format!("create agent home: {e}"))?;
    ensure_gitignore(workspace);
    // A JOINED agent (board #382: a team and no member, however its def was
    // made) gets its team block HERE and only here, so its spawn, every
    // restart (`refresh_agent` reaches this with the same recipe fields) and a
    // fork (#383) carry exactly one block that names the team as it stands.
    let joined;
    let def = match team.filter(|_| member.is_empty()) {
        Some(root) => {
            joined = with_joined_block(def, workspace, root, window_name);
            &joined
        }
        None => def,
    };

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
    // The local socket this gateway actually bound (board #440), or '' when
    // it has none: the agent's tmm reaches THIS gateway outside the TCP
    // lockout, and an empty value masks a stale one in the tmux environment.
    env.push(("TMM_SOCKET".into(), crate::server::bound_local_socket().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()));
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
    LaunchRecipe { backend: &def.backend, env: &env, cmd: &prepared.cmd, spawned_by: by, team, agent_def, member, from_member, input_mode: &def.input_mode }.write_in(section)?;
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
/// `Ok(true)` re-materialized, `Ok(false)` nothing to re-materialize from (no
/// recipe, the definition ABSENT, an invalid model: the snapshot is kept), and
/// `Err` when re-materializing FAILED (a private write refused, board #448
/// P1-B) or when a recipe or definition that EXISTS cannot be read or parsed
/// (board #452 (a)): the start is refused, never replayed from the old recipe.
pub fn refresh_agent(project_path: &str, session: &str, window_name: &str) -> Result<bool, String> {
    let home = agent_home(project_path, window_name);
    // The recipe's section from this read to materialize's write: the whole
    // read-modify-write, registry/team resolution and the backend's render
    // included, so a team move cannot land in between and be undone.
    let section = super::recipe::recipe_section(&home);
    // ABSENT stays "nothing to refresh"; PRESENT but unreadable REFUSES (board
    // #452 (a)): a recipe that exists and cannot be read or parsed used to be
    // taken for "no recipe", so the start went ahead on the old materials
    // silently, skipping the render and everything it enforces.
    let recipe = match section.read() {
        Ok(Some(r)) => r,
        Ok(None) => return Ok(false),
        Err(e) => return Err(format!("{window_name}: {e}, so it is not started")),
    };
    let p = provenance_of(&recipe);
    // One resolution that keeps the cause (#452 (a), reviewer P1 on
    // cb80a7b7): only an ABSENT definition keeps the old materials; one that
    // exists and cannot be read, or does not make a definition, refuses.
    let resolved = resolve_provenance_def(project_path, window_name, &p, &mut MemberKind::Unresolved)
        .map_err(|e| format!("{window_name}: {e}, so it is not started"))?;
    let Some(def) = resolved else {
        // The def (or its team/base) is gone. Keep the spawn-time snapshot —
        // the agent keeps working — and say so once per window, not per start.
        static WARNED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
            std::sync::OnceLock::new();
        let key = format!("{project_path}/{window_name}");
        if WARNED.get_or_init(Default::default).lock().unwrap().insert(key) {
            eprintln!(
                "projects: definition behind agent '{window_name}' is gone (def '{}', team '{}'); restarts keep its spawn-time materials",
                p.agent_def, p.team
            );
        }
        return Ok(false);
    };
    // A def edited into an invalid model must not brick the restart: keep the
    // old materials rather than write a config the backend will refuse.
    if super::models::validate(&def.backend, &def.model).is_err()
        || super::models::validate_effort(&def.backend, &def.effort).is_err()
    {
        return Ok(false);
    }
    let team_opt = (!p.team.is_empty()).then_some(p.team.as_str());
    materialize(&section, &def, window_name, session, project_path, "", &p.by, team_opt, &p.agent_def, &p.member, &p.from_member)
        .map(|_| true)
        .map_err(|e| format!("{window_name}: its materials could not be brought up to date, so it is not started: {e}"))
}

/// Start a managed window again from scratch, in its own home (the restart's
/// fallback when the slot cannot be restored: a window younger than the capture
/// loop's settle rule is not in the declaration yet, board #389). WHAT it
/// starts comes from the window's own recipe and nowhere else — the same
/// provenance `refresh_agent` replays and `fork` copies (`effective_def`) — and
/// never from a registry lookup of the WINDOW name, which names a registry
/// definition only for the first agent of its kind: `kiro-2`, a fork, a
/// uniquified teammate and a team member are not in the registry under that
/// name, and asking it lost the agent a restart had just killed.
pub fn respawn(session: &str, window_name: &str) -> Result<Value, String> {
    let project = super::project_for_session(session)?
        .ok_or_else(|| format!("no project for session '{session}'"))?;
    let panes = panes_now(session)?;
    let (plan, def, m) = respawn_materialize(&project.path, session, window_name, &panes)?;
    launch_window(&plan.request(session), &project.path, &def, window_name, m)
}

/// `respawn` up to the end of the window's materialization — everything that reads
/// or writes its recipe, as ONE read-modify-write of the home's recipe section
/// (board #389, reviewer P1): the recipe is read INSIDE the section, the definition
/// is resolved from that read, and `materialize` writes under the same hold, so a
/// team move that commits meanwhile is waited for and kept, never overwritten by a
/// plan made before it (the read-before-lock class #384 closed for the writers).
/// The section is released here, before the window is opened: the lock is not held
/// across the slow tmux launch. A recipe that EXISTS but cannot be read is not a
/// missing one: it refuses before anything is rendered or written.
fn respawn_materialize(workspace: &str, session: &str, window_name: &str, panes: &[tmux::TmuxPane]) -> Result<(Respawn, RegAgent, Materialized), String> {
    check_cap(workspace, panes)?;
    let section = super::recipe::recipe_section(&agent_home(workspace, window_name));
    let recipe = section.read().map_err(|e| format!("'{window_name}' cannot be started again: {e}; nothing was changed"))?;
    let plan = plan_respawn(workspace, window_name, recipe.as_ref())?;
    let (def, m) = {
        let req = plan.request(session);
        let def = resolve_def(&req)?;
        check_def(&def)?;
        if let Some(team) = join_of(req.team.as_deref(), req.member) {
            check_join(workspace, team)?;
        }
        let agent_def = if req.def.is_none() { def.name.as_str() } else { "" };
        let m = materialize(&section, &def, window_name, session, workspace, req.brief, req.by, req.team.as_deref(), agent_def, req.member, req.from_member)?;
        (def, m)
    };
    Ok((plan, def, m))
}

/// What a respawn launches, decided before any window opens.
struct Respawn {
    /// The window and home it starts in: its own.
    name: String,
    /// Who started it, kept (a restart is not a new spawner).
    by: String,
    team: Option<String>,
    member: String,
    from_member: String,
    /// The registry definition to launch by name, for a solo agent (so the recipe
    /// keeps `agent_def` and a later restart follows the registry again).
    agent: String,
    /// The definition handed in, for a team member or a fork of one.
    def: Option<RegAgent>,
}

impl Respawn {
    fn request<'a>(&'a self, session: &'a str) -> SpawnRequest<'a> {
        SpawnRequest {
            session, agent: &self.agent, by: &self.by, def: self.def.clone(), window_name: Some(self.name.clone()),
            team: self.team.clone(), member: &self.member, from_member: &self.from_member, resume: true, ..Default::default()
        }
    }
}

/// `respawn`'s decision, from the recipe as read inside the section (`None` = there
/// is none): the window's recipe says what it is. A window with NO recipe has
/// nothing to follow and keeps the plain registry lookup by its name (what a
/// restart did before provenance existed); one whose definition is gone is
/// refused by name, its home kept. (A recipe that exists but cannot be read
/// never gets here: `respawn_materialize` refuses it.)
fn plan_respawn(workspace: &str, window_name: &str, recipe: Option<&Value>) -> Result<Respawn, String> {
    let Some(recipe) = recipe else {
        return Ok(Respawn { name: window_name.to_string(), by: String::new(), team: None, member: String::new(), from_member: String::new(), agent: window_name.to_string(), def: None });
    };
    let p = provenance_of(recipe);
    let def = effective_def(workspace, window_name, &p).ok_or_else(|| {
        format!("the definition behind '{window_name}' no longer exists (its agent or team was deleted) — it cannot be started again; its home is kept")
    })?;
    // A team member (or a fork of one) is started from the definition its team
    // gives it; every other agent by its registry definition's NAME, which is
    // the recipe's `agent_def`, or the window's own name for a pre-#113 recipe.
    let by_team = !p.member.is_empty() || !p.from_member.is_empty();
    let agent = if by_team { String::new() } else if p.agent_def.is_empty() { window_name.to_string() } else { p.agent_def.clone() };
    Ok(Respawn {
        name: window_name.to_string(),
        by: p.by,
        team: (!p.team.is_empty()).then_some(p.team),
        member: p.member,
        from_member: p.from_member,
        agent,
        def: by_team.then_some(def),
    })
}

/// Where a managed window's definition comes from: the provenance its launch
/// recipe records (board #113).
pub(super) struct Provenance {
    pub(super) by: String,
    pub(super) team: String,
    pub(super) member: String,
    pub(super) agent_def: String,
    /// Set on a fork of a team member (board #383): `<team path>/<member>`, the
    /// member whose definition it copies.
    pub(super) from_member: String,
}

/// The provenance a recipe value records.
pub(super) fn provenance_of(recipe: &Value) -> Provenance {
    let field = |k: &str| recipe.get(k).and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    Provenance { by: field("spawned_by"), team: field("team"), member: field("member"), agent_def: field("agent_def"), from_member: field("from_member") }
}

/// The window's recipe provenance, read WITHOUT the recipe section (a reader that
/// takes no section sees a whole recipe, the writer being atomic); `None` when it
/// has no readable recipe, which is also what "not one of ours" looks like.
pub(super) fn recipe_provenance(project_path: &str, window_name: &str) -> Option<Provenance> {
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(agent_home(project_path, window_name).join("launch.json")).ok()?).ok()?;
    Some(provenance_of(&recipe))
}

/// The window's EFFECTIVE definition: the one it would get on a restart, which is
/// the one definition function for "what is this running agent" (board #383:
/// `refresh_agent` replays it, `fork` copies it). Resolved through the recipe's
/// provenance (board #113): a team member re-derives its def from the current
/// team (`team` + `member`), a solo spawn follows `agent_def` (so a uniquified
/// `lead-2` still finds `lead`), and a pre-#113 recipe falls back to the window
/// name. `None` when the def (or its team/base) is gone.
pub(super) fn effective_def(project_path: &str, window_name: &str, p: &Provenance) -> Option<RegAgent> {
    effective_def_kind(project_path, window_name, p).0
}

/// `effective_def`, with where its model and effort came from (`MemberKind`),
/// taken from the one member the resolution found. The FAIL-SOFT form of
/// `resolve_provenance_def` for callers that only ask "is there a definition": a read
/// error is folded into `None` here and nowhere else.
pub(super) fn effective_def_kind(project_path: &str, window_name: &str, p: &Provenance) -> (Option<RegAgent>, MemberKind) {
    let mut kind = MemberKind::Unresolved;
    let def = resolve_provenance_def(project_path, window_name, p, &mut kind).ok().flatten();
    (def, kind)
}

/// THE effective-definition resolver (board #452 (a), reviewer P1 on
/// cb80a7b7): one pass over the recipe's provenance that keeps the cause.
/// `Ok(None)` only when something it needs is ABSENT (the registry row, the
/// root team, a sub-team on the member's path, the member, or its base);
/// `Err` when something PRESENT cannot be read or does not make a definition
/// (a store read error, a team that does not expand, a member with neither a
/// base nor an inline agent). `kind` is set as soon as the member is found.
pub(super) fn resolve_provenance_def(project_path: &str, window_name: &str, p: &Provenance, kind: &mut MemberKind) -> Result<Option<RegAgent>, String> {
    if !p.team.is_empty() && !p.member.is_empty() {
        team_member_def(project_path, &p.team, &p.member, window_name, kind, Assembly::Team)
    } else if let Some((team_path, member)) = p.from_member.rsplit_once('/') {
        // A joined fork of a team member: the member's CURRENT def, without
        // holding its slot and without a team section of its own (board #383).
        team_member_def(project_path, team_path, member, window_name, kind, Assembly::Fork)
    } else {
        // A solo spawn follows `agent_def`; a pre-#113 recipe names nothing,
        // and the window name IS the def name or nothing.
        *kind = MemberKind::NotTeam;
        let name = if p.agent_def.is_empty() { window_name } else { p.agent_def.as_str() };
        read_registry(name).map_err(|e| format!("definition '{name}' cannot be read: {e}"))
    }
}

/// A registry read, with a test seam that fails one read of `name`.
fn read_registry(name: &str) -> Result<Option<RegAgent>, String> {
    #[cfg(test)]
    if READ_FAULT.with(|f| f.borrow().as_deref() == Some(name)) {
        READ_FAULT.with(|f| *f.borrow_mut() = None);
        return Err("injected read error".into());
    }
    super::registry_get(name)
}

#[cfg(test)]
thread_local! {
    /// Test seam (#452 (a)): the next registry read of this name fails once.
    pub(crate) static READ_FAULT: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// How a team member's definition is assembled: as that member (a team
/// window, with its roster) or as a fork of it (no team section).
#[derive(Clone, Copy)]
enum Assembly { Team, Fork }

/// A team member's definition, with the cause kept (see `resolve_provenance_def`).
fn team_member_def(workspace: &str, team_path: &str, member: &str, window_name: &str, kind: &mut MemberKind, how: Assembly) -> Result<Option<RegAgent>, String> {
    let root = team_path.split('/').next().unwrap_or("");
    let cannot = |what: String| move |e: String| format!("{what} cannot be read: {e}");
    let Some(team) = super::team_get(root).map_err(cannot(format!("team '{root}'")))? else { return Ok(None) };
    // A sub-team on the member's own path that is gone means the member is
    // gone: ABSENT, asked by name before the expansion (which would only say
    // so in an error string).
    for sub in team_path.split('/').skip(1) {
        if super::team_get(sub).map_err(cannot(format!("team '{sub}'")))?.is_none() {
            return Ok(None);
        }
    }
    let flat = super::teams::expand(&team, &|n| super::team_get(n), SPAWN_CAP).map_err(cannot(format!("team '{root}'")))?;
    let Some(f) = flat.iter().find(|f| f.path == team_path && f.member.name.trim() == member) else { return Ok(None) };
    *kind = member_kind(f);
    let base = match f.member.base.trim() {
        "" => None,
        b => match read_registry(b).map_err(cannot(format!("base '{b}' of member '{member}'")))? {
            Some(base) => Some(base),
            None => return Ok(None),
        },
    };
    let made = match how {
        Assembly::Team => {
            let assigned = team_windows_from_recipes(workspace, root);
            let roster: Vec<super::teams::RosterEntry> = flat
                .iter()
                .map(|g| {
                    let key = (g.path.clone(), g.member.name.trim().to_string());
                    let w = assigned.get(&key).cloned().unwrap_or_else(|| g.member.name.trim().to_string());
                    (w, g.member.role.clone(), g.path.clone())
                })
                .collect();
            super::teams::effective_def(f, base.as_ref(), window_name, &roster)
        }
        Assembly::Fork => super::teams::forked_def(f, base.as_ref(), window_name),
    };
    made.map(Some).map_err(|e| format!("team '{root}', member '{member}' is not a definition: {e}"))
}

/// The team whose member's definition this window runs: the SAME two branches
/// `effective_def` takes (a team member, a joined fork of one), and nothing
/// else. A runtime-joined SOLO agent has a `team` too (board #113 membership)
/// but follows its own registry definition, so it is not team-defined.
pub(super) fn team_defining(p: &Provenance) -> Option<String> {
    if !p.team.is_empty() && !p.member.is_empty() {
        Some(p.team.clone())
    } else {
        p.from_member.rsplit_once('/').map(|(team_path, _)| team_path.to_string())
    }
}

/// Where a window's model and effort come from, as the SAME resolved member
/// `effective_def` read (board #411 review): never a second expansion, and a
/// failed lookup is `Unresolved`, which is not the same as "no base".
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MemberKind {
    /// Not team-defined: a solo agent follows its own registry definition.
    NotTeam,
    /// A team member (or a fork of one) with an inline definition: no registry base.
    Inline,
    /// A team member derived from a registry base, and which of model and effort it inherits rather than overrides.
    Based { base: String, model_inherited: bool, effort_inherited: bool },
    /// The team, its expansion or the member could not be resolved: what it derives from is not known.
    Unresolved,
}

fn member_kind(f: &super::teams::Flat) -> MemberKind {
    let base = f.member.base.trim();
    if base.is_empty() {
        MemberKind::Inline
    } else {
        MemberKind::Based { base: base.to_string(), model_inherited: f.member.model.trim().is_empty(), effort_inherited: f.member.effort.trim().is_empty() }
    }
}

/// Fork a RUNNING managed agent (board #383, owner #336 (b): "fork 当前已有的一个
/// 正在运行的 agent 的配置，不需要手动写其他参数了"): a NEW agent whose definition is
/// the source's EFFECTIVE definition (`effective_def`: what a restart of the
/// source would give it), launched through the one launcher, `spawn`.
///
/// What it copies is a DEFINITION and nothing else: backend, model, effort,
/// input mode, system prompt, skills and MCP come with the def; the new agent
/// gets a fresh isolated home and a fresh conversation (`resume: false`, no
/// session id — never another agent's session, #379), and nothing of the
/// source's home. A def that is gone refuses the fork rather than falling back
/// to the home, which holds a conversation and credentials, not a definition.
/// The source is only READ. A model or effort switched by hand inside the live
/// CLI is not declared anywhere, so it is not copied.
///
/// A fork of a team member JOINS the source's team (recipe `team`, empty
/// `member`, `from_member` naming the definition) instead of being a second
/// holder of the member's slot, which the team's roster and restart read as
/// THE member. The name is the source's, uniquified past every live window and
/// every existing home (a stopped agent's home must not be clobbered), or the
/// explicit `as_name`, which is refused when invalid or taken and never
/// silently changed.
pub fn fork(session: &str, source: &str, as_name: Option<&str>, by: &str) -> Result<Value, String> {
    let project = super::project_for_session(session)?
        .ok_or_else(|| format!("no project for session '{session}'"))?;
    let live_now = || window_names_now(session);
    let mut plan = plan_fork_with(&project.path, &live_now, source, as_name)?;
    let outcome = spawn(&plan.request(session, by));
    // The claim is kept only by a launch that worked; otherwise dropping the plan
    // gives back the empty home it made and the name it held.
    let mut result = outcome?;
    plan.claim.commit();
    result["forked_from"] = json!(source);
    result["team"] = json!(plan.team);
    Ok(result)
}

/// What a fork will launch, decided before any window opens (so the decision is
/// testable without starting a CLI).
struct ForkPlan {
    /// The claim on the new identity: its name is reserved against every other new
    /// spawn and its home directory exists, empty. Kept by `fork` once the launch
    /// worked; dropped (and, if still empty, removed) when it did not.
    claim: Claim,
    /// The new window's name, already unique.
    name: String,
    /// The definition, derived for `name`.
    def: RegAgent,
    /// The team to join: the source's team ROOT, which is what a join records
    /// (board #382); `None` for a solo agent.
    team: Option<String>,
    /// `<team path>/<member>` whose definition `def` is (a fork of a team member,
    /// or of such a fork); empty for a registry def, which is launched by name.
    from_member: String,
    /// The registry def to launch by name when `from_member` is empty.
    agent: String,
}

impl ForkPlan {
    fn request<'a>(&'a self, session: &'a str, by: &'a str) -> SpawnRequest<'a> {
        if self.from_member.is_empty() {
            // A registry def (solo, or a joined solo agent): launched by its name,
            // so the fork's recipe keeps `agent_def` and a restart follows the
            // registry def.
            SpawnRequest { session, agent: &self.agent, by, window_name: Some(self.name.clone()), team: self.team.clone(), claim: Some(&self.claim), ..Default::default() }
        } else {
            SpawnRequest { session, by, def: Some(self.def.clone()), window_name: Some(self.name.clone()), team: self.team.clone(), from_member: &self.from_member, claim: Some(&self.claim), ..Default::default() }
        }
    }
}

/// The checks and choices of a fork: `source` must be one of ours and RUNNING
/// (`live` = the project's window names), its definition must still exist, and
/// the new name must be free among live windows AND existing homes.
fn plan_fork(workspace: &str, live: &[String], source: &str, as_name: Option<&str>) -> Result<ForkPlan, String> {
    plan_fork_with(workspace, &|| Ok(live.to_vec()), source, as_name)
}

/// `plan_fork` with the live windows read through `live_now` (fresh, at the moment
/// of the check and again inside the claim's critical section).
fn plan_fork_with(workspace: &str, live_now: &dyn Fn() -> Result<Vec<String>, String>, source: &str, as_name: Option<&str>) -> Result<ForkPlan, String> {
    let live = live_now()?;
    if !super::is_managed_in(Some(workspace), source) {
        return Err(format!("'{source}' is not an agent this app started"));
    }
    if !live.iter().any(|w| w == source) {
        return Err(format!("'{source}' is not running — start it first; a fork copies a running agent"));
    }
    let prov = recipe_provenance(workspace, source)
        .ok_or_else(|| format!("'{source}' has no launch recipe, so there is no definition to fork"))?;

    // The source's definition, resolved by the SOURCE's identity: a pre-#113
    // recipe names its definition by its window name, which is the source's, not
    // the new agent's (reviewer P1-B). A team member (or a fork of one) yields the
    // member's definition and role WITHOUT a team section: the fork is a joined
    // agent, and its one team section is built by `materialize`.
    let member_ref: Option<(String, String)> = if !prov.member.is_empty() {
        Some((prov.team.clone(), prov.member.clone()))
    } else {
        prov.from_member.rsplit_once('/').map(|(t, m)| (t.to_string(), m.to_string()))
    };
    let mut def = match &member_ref {
        Some((team_path, member)) => fork_member_def(team_path, member, source),
        None => effective_def(workspace, source, &prov),
    }
    .ok_or_else(|| {
        format!("the definition behind '{source}' no longer exists (its agent or team was deleted) — there is nothing to fork, and its home is never copied instead")
    })?;
    // The new identity, claimed atomically; the prompt's identity is the NEW name.
    let claim = claim_home(workspace, live_now, as_name, source)?;
    let name = claim.name().to_string();
    def.name = name.clone();
    let from_member = member_ref.map(|(t, m)| format!("{t}/{m}")).unwrap_or_default();
    let agent = if prov.agent_def.is_empty() { source.to_string() } else { prov.agent_def.clone() };
    let root = prov.team.split('/').next().unwrap_or("").to_string();
    Ok(ForkPlan { claim, name, def, team: (!root.is_empty()).then_some(root), from_member, agent })
}

/// The (workspace, name) pairs some NEW spawn is creating right now. One set for
/// the whole process, because every hub request that creates an agent runs in
/// this process (connection.rs handles them concurrently): a name in it is taken
/// even though no window or home shows it yet.
fn in_flight() -> std::sync::MutexGuard<'static, std::collections::HashSet<(String, String)>> {
    static SET: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<(String, String)>>> = std::sync::OnceLock::new();
    SET.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner())
}

/// A claim on a NEW agent identity (board #383 review P1-A): its name is reserved
/// against every other new spawn in `in_flight` until the claim is dropped, so
/// the name check and the taking of the name are one step. A fork's claim also
/// made the home directory (exclusively, so a name whose home exists is never
/// reused) and gives it back if the launch did not work — but only by
/// `remove_dir`, which refuses a directory that is not empty: whatever another
/// request wrote there is never deleted on this one's behalf.
#[derive(Debug)]
pub struct Claim {
    workspace: String,
    name: String,
    made_home: bool,
    committed: bool,
}

impl Claim {
    pub fn name(&self) -> &str {
        &self.name
    }
    /// The launch worked: the home it made is a real slot now and stays.
    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        // The cleanup of a failed claim's own EMPTY home happens BEFORE the name
        // leaves the in-flight set, in the same critical section: otherwise another
        // request could reserve the name, reach the old empty directory, and have
        // it removed from under it (reviewer round 3, P2).
        let mut flight = in_flight();
        let key = (self.workspace.clone(), self.name.clone());
        let home = agent_home(&self.workspace, &self.name);
        let clean_up = self.made_home && !self.committed;
        give_back(&mut flight, &key, |_| {
            if clean_up {
                let _ = std::fs::remove_dir(&home);
            }
        });
    }
}

/// Give a claimed name back: `cleanup` runs FIRST, while the name is still in the
/// in-flight set (it is handed the set so a test can see that), and only then does
/// the name leave it — in the one critical section the caller holds.
fn give_back(
    flight: &mut std::collections::HashSet<(String, String)>,
    key: &(String, String),
    cleanup: impl FnOnce(&std::collections::HashSet<(String, String)>),
) {
    cleanup(flight);
    flight.remove(key);
}

/// What an ordinary spawn is starting, which decides whose a home with a given
/// name is: a registry agent by its definition name, a team member by its team
/// path and member name (board #383 review). Empty strings mean "not that kind".
struct Starting<'a> {
    agent_def: &'a str,
    team: &'a str,
    member: &'a str,
}

/// May this request start in the home named `name`? A name with NO home is free.
/// A home is the request's OWN stopped slot — and so reusable, which is how a hire
/// or `tmm spawn --team` starts a stopped slot again — only when its recipe names
/// the very agent or team member being started; anything else (another agent's
/// home, a fork's, a directory with no recipe yet) is someone else's. A home that
/// cannot be inspected is "cannot tell" and refuses.
fn may_start_in(workspace: &str, name: &str, who: &Starting) -> Result<bool, String> {
    match std::fs::metadata(agent_home(workspace, name)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("cannot tell whether the name '{name}' is free ({e}); nothing was started")),
        Ok(meta) if !meta.is_dir() => Ok(false),
        Ok(_) => Ok(recipe_provenance(workspace, name).is_some_and(|p| {
            if !who.member.is_empty() {
                p.member == who.member && p.team == who.team
            } else {
                !who.agent_def.is_empty() && p.agent_def == who.agent_def && p.member.is_empty()
            }
        })),
    }
}

/// The name for an ordinary NEW spawn (a hire, a team member, a join), reserved
/// against every other new spawn (reviewer rounds 2–3). The decision is made INSIDE
/// the allocation lock with a FRESH read of the windows (`live_now`), never from a
/// snapshot taken when the request began — a fork that finished in between is
/// live now, and a snapshot would hand its home to this request:
/// - an automatic name skips what is live, in flight, or a home that is not this
///   request's own stopped slot (`may_start_in`);
/// - an explicit name (a team member's planned window) is taken only if it is not
///   live, not in flight and not someone else's home; if it was taken meanwhile
///   the request is REFUSED — the team spawn reports that member — never written
///   over.
/// The reservation is held until the spawn returns, which is after the window
/// exists, so a completed request hands its name over to "live", never to "free".
fn reserve_name(workspace: &str, live_now: &dyn Fn() -> Result<Vec<String>, String>, who: &Starting, explicit: Option<&str>, base: &str) -> Result<Claim, String> {
    let mut flight = in_flight();
    // A read that failed refuses here, before anything is reserved or touched.
    let live = live_now()?;
    let key = |n: &str| (workspace.to_string(), n.to_string());
    let candidates: Vec<String> = match explicit {
        Some(n) => vec![n.to_string()],
        None => std::iter::once(base.to_string()).chain((2..10).map(|i| format!("{base}-{i}"))).collect(),
    };
    for name in &candidates {
        let busy = live.iter().any(|w| w == name);
        if busy || flight.contains(&key(name)) {
            if explicit.is_some() {
                return Err(if busy {
                    format!("the name '{name}' is already running — taken by another agent, not started")
                } else {
                    format!("the name '{name}' is being created by another request — try again, or pick another")
                });
            }
            continue;
        }
        if !may_start_in(workspace, name, who)? {
            if explicit.is_some() {
                return Err(format!("the name '{name}' is another agent's home — taken by it, not started"));
            }
            continue;
        }
        flight.insert(key(name));
        return Ok(Claim { workspace: workspace.to_string(), name: name.clone(), made_home: false, committed: true });
    }
    Err("too many windows with this agent's name".to_string())
}

/// Make a fork's identity: pick the name and create its home as ONE atomic step.
/// The home directory is created EXCLUSIVELY — `create_dir` fails if it exists —
/// under the same in-flight set every new spawn reserves in, so two requests that
/// reach the same candidate, a fork and a hire included, cannot both get it: an
/// auto-picked name that collides picks the next, an explicit name that collides
/// is refused, and a directory that cannot be inspected or created is "cannot
/// tell", which refuses and never reads as free. A refresh or a restart reuses
/// its OWN home and never comes through here.
fn claim_home(workspace: &str, live_now: &dyn Fn() -> Result<Vec<String>, String>, explicit: Option<&str>, base: &str) -> Result<Claim, String> {
    let candidates: Vec<String> = match explicit {
        Some(n) => vec![n.trim().to_string()],
        None => (2..10).map(|i| format!("{base}-{i}")).collect(),
    };
    claim_first(workspace, live_now, &candidates, explicit.is_some())
}

/// `claim_home` over candidates the caller fixed (the seam the deterministic
/// tests use to make two requests reach the same one).
fn claim_first(workspace: &str, live_now: &dyn Fn() -> Result<Vec<String>, String>, candidates: &[String], explicit: bool) -> Result<Claim, String> {
    let taken = |name: &str| format!("the name '{name}' is taken — a window, an agent home or another request already has it");
    let mut flight = in_flight();
    // Fresh, inside the allocation lock — and read BEFORE anything on disk is
    // touched: a read that failed refuses with nothing created.
    let live = live_now()?;
    let agents = Path::new(workspace).join(".tmm").join("agents");
    std::fs::create_dir_all(&agents).map_err(|e| format!("cannot tell which agent names are free ({}: {e}); nothing was created", agents.display()))?;
    for name in candidates {
        super::agents::valid_name(name)?;
        let key = (workspace.to_string(), name.clone());
        if live.iter().any(|w| w == name) || flight.contains(&key) {
            if explicit {
                return Err(taken(name));
            }
            continue;
        }
        match std::fs::create_dir(agent_home(workspace, name)) {
            Ok(()) => {
                flight.insert(key);
                return Ok(Claim { workspace: workspace.to_string(), name: name.clone(), made_home: true, committed: false });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if explicit {
                    return Err(taken(name));
                }
            }
            Err(e) => return Err(format!("cannot tell whether the name '{name}' is free ({e}); nothing was created")),
        }
    }
    Err("too many agents are already named like this one — pick a name with --as".to_string())
}

/// Re-derive a team member's effective def from the CURRENT team definition
/// (board #113). The roster is reconstructed from the sibling recipes in this
/// workspace — the recipes are the declaration of which window carries which
/// member — with the member's own name as the fallback for a sibling that has
/// no recipe here (removed, or spawned before provenance existed): that is
/// the name spawn itself would have used had the window not been taken.
/// Fail-soft (`None` for absent AND unreadable); `team_member_def` keeps the cause.
fn refresh_team_def(workspace: &str, team_path: &str, member: &str, window_name: &str) -> Option<RegAgent> {
    team_member_def(workspace, team_path, member, window_name, &mut MemberKind::Unresolved, Assembly::Team).ok().flatten()
}

/// A fork's definition of a team member (board #383): the member's CURRENT
/// definition and role from the team (`teams::forked_def`), with no team section
/// — the joined block is built once, by `materialize`. Fail-soft, like
/// `refresh_team_def`.
fn fork_member_def(team_path: &str, member: &str, window_name: &str) -> Option<RegAgent> {
    team_member_def("", team_path, member, window_name, &mut MemberKind::Unresolved, Assembly::Fork).ok().flatten()
}

/// (team path, member name) -> window name, read off every recipe under
/// `<ws>/.tmm/agents/` whose team path starts at `root`. Fail-soft: an
/// unreadable recipe simply contributes nothing.
fn team_windows_from_recipes(
    workspace: &str,
    root: &str,
) -> std::collections::HashMap<(String, String), String> {
    team_homes(workspace, root)
        .into_iter()
        .filter(|(_, _, member)| !member.is_empty())
        .map(|(window, team, member)| ((team, member), window))
        .collect()
}

/// Every home in `workspace` whose recipe puts it in the team rooted at
/// `root`: (window, team path, member). The ONE reader of team membership
/// off the recipes. A member of '' is an agent that JOINED the team at
/// runtime (board #382; or a pre-#113 member, which named none): the
/// definition does not list it, so a team restart leaves it alone.
fn team_homes(workspace: &str, root: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let dir = Path::new(workspace).join(".tmm").join("agents");
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let Ok(text) = std::fs::read_to_string(entry.path().join("launch.json")) else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
        let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let team = get("team");
        if team.split('/').next() != Some(root) || root.is_empty() {
            continue;
        }
        out.push((entry.file_name().to_string_lossy().into_owned(), team, get("member")));
    }
    out.sort();
    out
}

/// Move an EXISTING managed agent's runtime membership (board #384: the
/// Hub's drag of a card onto a team, "Move to team" / "Leave team", `tmm agent
/// team`): `team` = a team root to join, or "" to leave its team. The same
/// membership a join at spawn has (#382): the recipe's `team`, with `member`
/// empty; the team's DEFINITION is never edited. Only the recipe's `team`
/// field changes, so its prompt follows at its next start (`refresh_agent`
/// builds the joined block, or none after a leave) and nothing running is
/// rewritten or restarted. Refused by name: an agent the team's definition
/// places (its member is not empty; the Teams editor owns that), a team that
/// is not present in this project (`check_join`). Returns the team it left
/// ('' when it was standalone), whether anything changed, and the membership
/// REVISION the recipe now records (`recipe::team_rev`, +1 per change; P1-B):
/// only the announcement of the latest revision speaks.
///
/// On the agent's FIRST move it also seeds the announcer's ledger
/// (`recipe::Told`, P1-B residual) from the recipe as it stands before the
/// move: the agent was told its old team, and `seed(old team)` (that team's
/// live members) were told it is their teammate, by its prompt or a join
/// notice. An empty ledger is never read as "nobody was told", and a seed
/// that cannot be read refuses the move with the recipe unchanged (board
/// #388): an unread team is not an empty one, and a ledger seeded later
/// would describe the wrong team.
pub fn set_agent_team(workspace: &str, window_name: &str, team: &str, seed: &dyn Fn(&str) -> Result<Vec<String>, String>) -> Result<(String, bool, u64), String> {
    let team = team.trim();
    // Judged before the section (it reads OTHER homes' recipes, and a
    // section is a leaf): a team that is here now is here a moment later.
    if !team.is_empty() {
        check_join(workspace, team)?;
    }
    super::recipe::update_recipe(&agent_home(workspace, window_name), |slot| {
        let Some(recipe) = slot.as_mut() else { return Err(format!("'{window_name}' is not an agent this app started")) };
        let field = |k: &str| recipe.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let (old, member) = (field("team"), field("member"));
        let old_root = old.split('/').next().unwrap_or("").to_string();
        if !member.is_empty() {
            return Err(format!(
                "'{window_name}' is member '{member}' of team '{old_root}' by the team's definition — change it in Agents > Teams"
            ));
        }
        let rev = super::recipe::team_rev(recipe);
        if team == old_root {
            return Ok((old_root, false, rev));
        }
        if super::recipe::Told::of(recipe).is_none() {
            let members = if old_root.is_empty() { Vec::new() } else {
                seed(&old_root).map_err(|e| format!(
                    "could not read who is in team '{old_root}' to know who to tell ({e}); nothing was changed, try again"
                ))?
            };
            let told = super::recipe::Told { mover: old_root.clone(), members: members.into_iter().map(|m| (m, old_root.clone())).collect() };
            recipe["team_told"] = told.to_value();
        }
        recipe["team"] = json!(team);
        recipe["team_rev"] = json!(rev + 1);
        Ok((old_root, true, rev + 1))
    })?
}

/// The other members of team `root` in this workspace for the moved agent's
/// notice (board #384): every home whose recipe puts it in the team, other
/// than `window_name`, live or stopped, by window, with the role the CURRENT
/// definition gives it, read by (path, member) the way #382's team block
/// reads it (`teams::member_role`; reviewer P2-1: sub-teams may each have a
/// `dev`).
pub fn team_mates(workspace: &str, root: &str, window_name: &str) -> Vec<(String, String)> {
    let flat = super::team_get(root).ok().flatten()
        .and_then(|t| super::teams::expand(&t, &|n| super::team_get(n), SPAWN_CAP).ok())
        .unwrap_or_default();
    team_homes(workspace, root).into_iter()
        .filter(|(w, _, _)| w != window_name)
        .map(|(w, path, member)| { let role = super::teams::member_role(&flat, &path, &member); (w, role) })
        .collect()
}

/// The agents that joined `root` at runtime (board #382), by window: the
/// homes a team restart does not touch, which its room line names.
pub fn joined_windows(workspace: &str, root: &str) -> Vec<String> {
    team_homes(workspace, root).into_iter().filter(|(_, _, m)| m.is_empty()).map(|(w, _, _)| w).collect()
}

/// The team a spawn JOINS, if it is a join (board #382): it names a team and
/// no member. Pure; the one test `spawn` applies before anything opens.
fn join_of<'a>(team: Option<&'a str>, member: &str) -> Option<&'a str> {
    team.filter(|_| member.trim().is_empty())
}

/// A join is into a team that is HERE (board #382): a team name, with at
/// least one member home in this project. An unknown or foreign team is
/// refused by name rather than recorded as a team of one.
fn check_join(workspace: &str, root: &str) -> Result<(), String> {
    super::agents::valid_name(root).map_err(|e| e.replacen("agent name", "team name", 1))?;
    if team_homes(workspace, root).is_empty() {
        return Err(format!("team '{root}' has no member in this project — start the team first, or spawn the agent standalone"));
    }
    Ok(())
}

/// `def` with the joined team's block appended to its prompt (board #382):
/// the team as it stands now — its current definition, if any, and the
/// teammates the recipes in this workspace record.
fn with_joined_block(def: &RegAgent, workspace: &str, root: &str, window_name: &str) -> RegAgent {
    let team = super::team_get(root).ok().flatten();
    let flat = team.as_ref().and_then(|t| super::teams::expand(t, &|n| super::team_get(n), SPAWN_CAP).ok()).unwrap_or_default();
    let block = super::teams::joined_block(root, team.as_ref(), &flat, window_name, &team_homes(workspace, root));
    let mut out = def.clone();
    let system = out.system.trim();
    out.system = if system.is_empty() { block } else { format!("{system}\n\n{block}") };
    out
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
    let live = window_names_now(session)?;
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
    let panes = panes_now(session)?;
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
                from_member: "",
                resume: false,
                claim: None,
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
    /// A JOINED window's definition source (board #383): the team member whose
    /// effective definition a fork copied, as `<team path>/<member>` (the path
    /// of a nested team is part of finding the member). `team` + `member` would make the
    /// window a second holder of that member's slot, which the team's roster
    /// and restart read as THE member; `from_member` names the same definition
    /// without taking the slot, so a restart re-derives the member's current
    /// def for it and a team restart still leaves it alone. Written only when
    /// set, so every other recipe stays byte for byte as it was. '' = none.
    pub from_member: &'a str,
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
    ///
    /// A fresh recipe of these keys, through the one door (board #384): the
    /// keys it does not own (anything a later feature adds) are kept from the
    /// recipe it replaces.
    pub(crate) fn write_in(&self, section: &super::recipe::RecipeSection) -> Result<(), String> {
        let mut fresh = json!({
            "backend": self.backend,
            "env": self.env.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
            "cmd": self.cmd.trim_end(),
            "spawned_by": self.spawned_by,
            "team": self.team.unwrap_or(""),
            "agent_def": self.agent_def,
            "member": self.member,
            "input_mode": self.input_mode,
        });
        // A fork of a team member names the definition it copies (board #383);
        // written only when set, so every other recipe keeps its keys.
        if !self.from_member.is_empty() {
            fresh["from_member"] = json!(self.from_member);
        }
        super::recipe::update_in(section, |slot| {
            let mut next = fresh;
            if let (Some(Value::Object(old)), Value::Object(new)) = (slot.as_ref(), &mut next) {
                // A fresh recipe in another team (a home reused for a new
                // spawn) makes the announcer's ledger describe someone else's
                // past: it goes, and the next move seeds it again.
                let same_team = old.get("team") == new.get("team");
                for (k, v) in old {
                    if k == "team_told" && !same_team { continue; }
                    new.entry(k.clone()).or_insert_with(|| v.clone());
                }
            }
            *slot = Some(next);
        })
    }

    /// `write_in` from outside a section, for a fixture: enters `home`'s
    /// section for this one write.
    #[cfg(test)]
    pub(crate) fn write(&self, home: &Path) -> Result<(), String> {
        self.write_in(&super::recipe::recipe_section(home))
    }
}

/// Add the backend's exact or safe-recent resume dialect to one persisted
/// identity command (the dialects live on the backend files, board #128).
/// An unknown backend relaunches verbatim, as before.
fn resume_command(cmd: &str, backend: &str, session_id: Option<&str>, home: Option<&Path>, agent: &str) -> String {
    let exact = session_id.filter(|s| !s.is_empty());
    match crate::backends::Backend::parse(backend) {
        Some(b) => b.resume_command(cmd, exact, home, agent),
        None => cmd.to_string(),
    }
}

/// Replay the persisted identity (env + backend command), preferring an exact
/// conversation id and otherwise the isolated home's newest cwd conversation.
pub fn relaunch_line(project_path: &str, window_name: &str, session_id: Option<&str>) -> Result<Option<String>, String> {
    let Some((cmd, backend, env, home)) = recipe_parts(project_path, window_name)? else { return Ok(None) };
    let cmd = resume_command(&cmd, &backend, session_id, Some(&home), window_name);
    Ok(Some(with_env(&env, &cmd)))
}

/// The strict relaunch for a restore after a reboot (board #422): the
/// persisted identity with the EXACT conversation, or `Err` — a recipe that
/// cannot be read, an unknown backend, or a resume the backend cannot prove
/// is exact is refused, never relaunched recent or blank.
pub fn relaunch_line_exact(project_path: &str, window_name: &str, session_id: &str) -> Result<String, String> {
    let (cmd, backend, env, home) = recipe_parts(project_path, window_name)?.ok_or_else(|| format!("{window_name}: no readable launch recipe"))?;
    let b = crate::backends::Backend::parse(&backend).ok_or_else(|| format!("{window_name}: unknown backend '{backend}'"))?;
    let cmd = b
        .resume_exact(&cmd, session_id, Some(&home), window_name)
        .ok_or_else(|| format!("{window_name}: {backend} cannot resume exactly {session_id}"))?;
    Ok(with_env(&env, &cmd))
}

/// A recipe's command, backend, `K=V` env prefix and home — the ONE reader
/// both relaunch forms use.
/// `Err` when the recipe is a line that may not be replayed (board #448
/// P1-B: an older build's codex line carrying MCP values): the start is
/// refused, never typed. `Ok(None)` = no readable recipe.
fn recipe_parts(project_path: &str, window_name: &str) -> Result<Option<(String, String, String, PathBuf)>, String> {
    let home = agent_home(project_path, window_name);
    let Some(recipe) = std::fs::read_to_string(home.join("launch.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return Ok(None) };
    let Some(cmd) = recipe.get("cmd").and_then(|c| c.as_str()).map(str::to_string) else { return Ok(None) };
    let backend = recipe.get("backend").and_then(|b| b.as_str()).unwrap_or("").to_string();
    if crate::backends::Backend::parse(&backend).is_some_and(|b| !b.line_is_private(&cmd)) {
        return Err(format!("{window_name}: its saved launch line carries MCP values from before board #448; it is not replayed — restart it from its definition"));
    }
    let env = recipe.get("env").and_then(|e| e.as_array()).map(|arr| {
        arr.iter()
            .filter_map(|kv| Some((kv.get(0)?.as_str()?, kv.get(1)?.as_str()?)))
            .map(|(k, v)| format!("{}={}", k, crate::shell::quote(v)))
            .collect::<Vec<_>>()
            .join(" ")
    }).unwrap_or_default();
    Ok(Some((cmd, backend, env, home)))
}

fn with_env(env: &str, cmd: &str) -> String {
    let mut line = String::new();
    if !env.is_empty() {
        line.push_str(env);
        line.push(' ');
    }
    line.push_str(cmd);
    line
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
        resume_command(identity_cmd, backend, None, None, "")
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
            spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "",
        }
        .write(&home)
        .unwrap();
        let id = "sess_e58968b6-0000-4000-8000-000000000001";
        let plant = |mode: &str| {
            let dir = home.join("sessions").join("13c0722d7b097be1").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("session.json"), format!(r#"{{"id":"{id}","agentMode":"{mode}"}}"#)).unwrap();
        };
        let line = || relaunch_line(ws.to_str().unwrap(), "lead", Some(id)).unwrap().unwrap();

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

    /// Render a managed kiro agent named `window_name` through the REAL
    /// `render_kiro` (so `--agent` goes through `shell::quote` exactly as in
    /// production), persist its recipe, and plant a session of the given mode
    /// in its isolated home. Returns the workspace and the id.
    fn v3_agent_with_session(window_name: &str, def_name: &str, mode: &str) -> (std::path::PathBuf, String) {
        let ws = std::env::temp_dir().join(format!("tmm-relaunch-379-{}", uuid::Uuid::new_v4()));
        let home = agent_home(ws.to_str().unwrap(), window_name);
        std::fs::create_dir_all(&home).unwrap();
        // Central-asset resolution touches the process-global store: never the
        // user's real state.db (the same guard `tests::def` takes).
        super::super::tests::use_test_store();
        let d = RegAgent {
            name: def_name.into(),
            backend: "kiro".into(),
            model: String::new(),
            effort: String::new(),
            input_mode: "queue".into(),
            system: "Persona text.".into(),
            skills: "[]".into(),
            mcp: "[]".into(),
        };
        let r = render_kiro(&d, window_name, &home, &ws, "p", &[]).unwrap();
        // The same step spawn runs next: the v3 engine on the recorded line.
        let cmd = crate::backends::kiro::reconcile_engine_in(&r.cmd, " --agent-engine v3").unwrap_or(r.cmd.clone());
        // A solo spawn records the registry def's name beside the (possibly
        // uniquified) window name, exactly as `spawn` does — so a comparison
        // against the DEF name would genuinely differ from the window name here.
        LaunchRecipe { backend: "kiro", env: &r.env, cmd: &cmd, spawned_by: "", team: None, agent_def: def_name, member: "", from_member: "", input_mode: "" }
            .write(&home)
            .unwrap();
        let id = "sess_e58968b6-0000-4000-8000-000000000001".to_string();
        let dir = home.join("sessions").join("13c0722d7b097be1").join(&id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("session.json"), format!(r#"{{"id":"{id}","agentMode":"{mode}"}}"#)).unwrap();
        (ws, id)
    }

    /// Board #379 review P1 (reviewer, 10:37). `render_kiro` writes
    /// `--agent` through `shell::quote`, which wraps a valid non-ASCII name
    /// (`翻译` → `'翻译'`). The first cut compared that raw token with the
    /// `agentMode` kiro stored, so every restart of such an agent started
    /// fresh and threw away a good conversation. The fixture goes through the
    /// real renderer and asserts the line IS quoted — a fixture that never
    /// quoted would pass against the bug too — and the session must still
    /// resume, because the name is the caller's, not parsed out of the line.
    #[test]
    fn a_restart_resumes_a_quoted_non_ascii_agent_name() {
        let (ws, id) = v3_agent_with_session("翻译", "翻译", "翻译");
        let line = relaunch_line(ws.to_str().unwrap(), "翻译", Some(&id)).unwrap().unwrap();
        assert!(line.contains("--agent '翻译'"), "the fixture really is quoted: {line}");
        assert!(line.ends_with(&format!("--resume-id {id}")), "its own session resumes despite the quotes: {line}");
        // And a vibe session under the same quoted name is still the incident.
        let (ws2, id2) = v3_agent_with_session("翻译", "翻译", "vibe");
        let vibe = relaunch_line(ws2.to_str().unwrap(), "翻译", Some(&id2)).unwrap().unwrap();
        assert!(vibe.contains("--agent '翻译'") && !vibe.contains("--resume"), "vibe stays fresh: {vibe}");
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&ws2).ok();
    }

    /// Board #379, reviewer's precision (10:37): the name compared is the slot's
    /// final WINDOW name — `builder-2` — not the registry def's `builder`.
    /// A team member (or a second hire from the same def) runs `--agent
    /// builder-2`, and kiro stores that as `agentMode`; comparing against the
    /// def name would never match, and a session of the BASE agent sitting in
    /// the same home must not be resumed by its uniquified sibling either.
    #[test]
    fn the_name_compared_is_the_window_name_not_the_registry_def_name() {
        let (ws, id) = v3_agent_with_session("builder-2", "builder", "builder-2");
        let line = relaunch_line(ws.to_str().unwrap(), "builder-2", Some(&id)).unwrap().unwrap();
        assert!(line.contains("--agent builder-2"), "the window name is what --agent carries: {line}");
        assert!(line.ends_with(&format!("--resume-id {id}")), "agentMode builder-2 resumes as builder-2: {line}");
        // A session whose mode is the BASE def's name belongs to `builder`, not
        // to this window: fresh, even though the registry def is `builder`.
        let (ws2, id2) = v3_agent_with_session("builder-2", "builder", "builder");
        let other = relaunch_line(ws2.to_str().unwrap(), "builder-2", Some(&id2)).unwrap().unwrap();
        assert!(!other.contains("--resume"), "a session of the def name is not this window's: {other}");
        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&ws2).ok();
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
        LaunchRecipe { backend: "kiro", env: &[("KIRO_HOME".to_string(), home.to_string_lossy().to_string())], cmd: "command kiro-cli chat --agent lead --model m --trust-all-tools", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }
            .write(&home)
            .unwrap();
        let line = relaunch_line(ws.to_str().unwrap(), "lead", Some("id-1")).unwrap().unwrap();
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
        let recent = relaunch_line(ws.to_str().unwrap(), "lead", None).unwrap().unwrap();
        assert!(recent.ends_with("--resume"), "managed kiro resumes recent: {recent}");
        // A window with no recipe (hand-started) stays None — the caller falls
        // back to the generic backend line.
        assert!(relaunch_line(ws.to_str().unwrap(), "byhand", None).unwrap().is_none());

        for (name, backend, cmd, flag) in [
            ("cl", "claude", "command claude --settings /tmp/settings.json", "--continue"),
            ("gx", "grok", "command grok --always-approve --agent gx", "--continue"),
        ] {
            let ahome = agent_home(ws.to_str().unwrap(), name);
            std::fs::create_dir_all(&ahome).unwrap();
            LaunchRecipe { backend: backend, env: &[], cmd: cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&ahome).unwrap();
            let exact = relaunch_line(ws.to_str().unwrap(), name, Some("conv-1")).unwrap().unwrap();
            assert!(exact.ends_with("--resume conv-1"), "{backend} exact resume: {exact}");
            let recent = relaunch_line(ws.to_str().unwrap(), name, None).unwrap().unwrap();
            assert!(recent.ends_with(flag), "{backend} recent resume: {recent}");
        }

        // codex resumes via a SUBCOMMAND, so the id splices in after the
        // binary instead of appending (verified on codex-cli 0.148.0:
        // `codex resume <id>` accepts the recipe's own flags). Appending
        // would hand `resume` to the interactive CLI as a prompt.
        let chome = agent_home(ws.to_str().unwrap(), "cx");
        std::fs::create_dir_all(&chome).unwrap();
        LaunchRecipe { backend: "codex", env: &[("CODEX_HOME".to_string(), chome.to_string_lossy().to_string())], cmd: "command codex -c a=b --dangerously-bypass-approvals-and-sandbox", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }
            .write(&chome)
            .unwrap();
        let cx = relaunch_line(ws.to_str().unwrap(), "cx", Some("01a0-abc")).unwrap().unwrap();
        assert!(
            cx.contains("command codex resume 01a0-abc -c a=b --dangerously-bypass-approvals-and-sandbox"),
            "subcommand splice: {cx}"
        );
        let cx_recent = relaunch_line(ws.to_str().unwrap(), "cx", None).unwrap().unwrap();
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

/// A managed agent's home, created or kept and made PRIVATE (board #448): on
/// Unix the `safe_fs::private_home` walk — from the canonical project root,
/// `.tmm` (ours), `agents` and the home (each 0700, ours, no link followed).
/// Every file in it may carry a definition's MCP env or header value.
pub(crate) fn make_home_private(home: &Path) -> Result<(), String> {
    #[cfg(unix)]
    return crate::safe_fs::private_home(home).map(|_| ()).map_err(|e| format!("{}: {e}", home.display()));
    #[cfg(not(unix))]
    return std::fs::create_dir_all(home).map_err(|e| format!("{}: {e}", home.display()));
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
        "You are agent \"{name}\" in project \"{session}\" (a tmux session managed by Teammux).\n\
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
        shared::write_atomic(&path, &serde_json::to_string_pretty(&root).unwrap())
            .map_err(|e| format!("write mcp.json: {e}"))?;
    } else {
        // Unchanged content, still private (board #448 P1-C): a copy an
        // older build left 0644 is closed in place, its content untouched.
        tighten_owned(&path).map_err(|e| format!("mcp.json: {e}"))?;
    }
    Ok(path)
}

/// An existing owned file made private in place (mode only), Unix only.
pub(crate) fn tighten_owned(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    return crate::safe_fs::tighten_file(path);
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
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
pub fn refresh_hooks(project_path: &str, window_name: &str) -> Result<bool, String> {
    let Some(home) = super::agents::home_dir(project_path, window_name) else { return Ok(false) };
    if !home.is_dir() {
        return Ok(false); // not a managed agent
    }
    // Every start closes a home an older build left wide (board #448). A
    // failure REFUSES the start (P1-B): an agent is never launched from a
    // home that could not be made private.
    make_home_private(&home).map_err(|e| format!("{window_name}: its home could not be made private, so it is not started: {e}"))?;
    let notifications = crate::agent_notifications::AgentNotificationHub::load();
    if notifications.ensure_helper().is_err() {
        return Ok(false);
    }
    // Each backend repairs its own on-disk surface (board #128): every half
    // probes for its file(s) and no-ops otherwise, exactly as the inline
    // branches always did — refresh does not need to know which backend the
    // home belongs to.
    let mut changed = false;
    for b in crate::backends::Backend::ALL {
        changed |= b.refresh(&home, window_name, Path::new(project_path), &notifications)
            .map_err(|e| format!("{window_name}: its configuration could not be refreshed privately, so it is not started: {e}"))?;
    }
    Ok(changed)
}

/// Replace the `hooks` key of a JSON config, leaving everything else alone.
/// A no-op when the value already matches, so starting a project does not
/// rewrite files for nothing. `Ok(false)` when there is nothing to patch (no
/// file, not JSON); `Err` when the private write itself failed (board #448
/// P1-B), which refuses the start.
pub(crate) fn patch_hooks(path: &std::path::Path, hooks: Value) -> Result<bool, String> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(false) };
    let Ok(mut root) = serde_json::from_str::<Value>(&text) else { return Ok(false) };
    let Some(obj) = root.as_object_mut() else { return Ok(false) };
    if obj.get("hooks") == Some(&hooks) {
        return Ok(false);
    }
    obj.insert("hooks".into(), hooks);
    shared::write_atomic(path, &serde_json::to_string_pretty(&root).unwrap_or(text)).map(|_| true)
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

    /// Board #448 D4: a definition's MCP secrets, by VALUE (any name), never
    /// reach the launch line, the launch env, launch.json or the launch
    /// script, for every backend; every file that holds one is 0600 inside a
    /// 0700 home. Checked after the first render, after a re-render that
    /// revokes a server (it leaves no copy), and after a refresh (every
    /// start's rewrite of the backend's own files).
    #[test]
    #[cfg(unix)]
    fn no_backend_puts_an_mcp_secret_on_the_line_and_every_copy_is_private() {
        use std::os::unix::fs::PermissionsExt;
        const ENV: &str = "SENTINEL-ENV-7f3a";
        const HDR: &str = "SENTINEL-HDR-9c1e";
        fn holding(dir: &Path, needle: &str, out: &mut Vec<PathBuf>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                let m = std::fs::symlink_metadata(&p).unwrap();
                if m.is_dir() { holding(&p, needle, out); continue; }
                if m.is_file() && std::fs::read(&p).map(|b| String::from_utf8_lossy(&b).contains(needle)).unwrap_or(false) { out.push(p); }
            }
        }
        let mode = |p: &Path| std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777;
        let notifications = crate::agent_notifications::AgentNotificationHub::load();
        for b in crate::backends::Backend::ALL {
            let ws = std::env::temp_dir().join(format!("tmm-sentinel-{}-{}", b.name(), uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&ws).unwrap();
            let home = ws.join(".tmm/agents/sec");
            make_home_private(&home).unwrap();
            let mut d = def(b.name());
            d.mcp = json!([
                { "name": "local", "command": "mcp-local", "env": { "ANY_NAME": ENV } },
                { "name": "remote", "url": "https://mcp.example/x", "headers": { "Authorization": format!("Bearer {HDR}"), "X-Plain": HDR } },
            ]).to_string();
            let prompt = build_prompt(&d, "sec", "proj", "", "", "");
            let check = |stage: &str, r: &Rendered| {
                let line = format!("{} {}", r.cmd, r.env.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" "));
                for s in [ENV, HDR] {
                    assert!(!line.contains(s), "{} {stage}: a secret on the line or env: {line}", b.name());
                }
                LaunchRecipe { backend: b.name(), env: &r.env, cmd: &r.cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
                let script = shared::write_launch_script(&home, "sec", &format!("{} {}", r.env.iter().map(|(k, v)| format!("{k}={}", crate::shell::quote(v))).collect::<Vec<_>>().join(" "), r.cmd)).unwrap();
                for s in [ENV, HDR] {
                    for f in [home.join("launch.json"), script.clone()] {
                        assert!(!std::fs::read_to_string(&f).unwrap().contains(s), "{} {stage}: a secret in {}", b.name(), f.display());
                    }
                }
                let mut copies = Vec::new();
                for s in [ENV, HDR] { holding(&home, s, &mut copies); }
                for c in &copies {
                    assert_eq!(mode(c), 0o600, "{} {stage}: {} holds a secret and is not private", b.name(), c.display());
                }
                assert_eq!(mode(&home), 0o700, "{} {stage}", b.name());
                copies
            };
            let r = b.render(&d, "sec", &home, &ws, &prompt, &[]).unwrap();
            // The workspace's own MCP file (P1-C) holds the values too: private.
            let seeded = seed_mcp_config(&ws, &mcp_defs(&d)).unwrap();
            assert_eq!(mode(&seeded), 0o600, "{}: the workspace mcp.json", b.name());
            std::fs::set_permissions(&seeded, std::fs::Permissions::from_mode(0o644)).unwrap();
            seed_mcp_config(&ws, &mcp_defs(&d)).unwrap();
            assert_eq!(mode(&seeded), 0o600, "{}: an old wide copy closes on the no-change path", b.name());
            let first = check("first render", &r);
            assert!(!first.is_empty(), "{}: the servers are rendered somewhere (a file)", b.name());
            b.refresh(&home, "sec", &ws, &notifications).unwrap();
            check("refresh", &r);
            // Revoke both servers: the re-render leaves no copy of either value.
            d.mcp = "[]".into();
            let r = b.render(&d, "sec", &home, &ws, &prompt, &[]).unwrap();
            let left = check("revoked re-render", &r);
            assert!(left.is_empty(), "{}: a revoked secret survived in {left:?}", b.name());
            std::fs::remove_dir_all(&ws).ok();
        }
    }

    /// Board #448 P2 (reviewer on 44c15858): a copy into the home whose target
    /// is a link refuses the render, for grok's auth.json and omp's agent.db,
    /// and through the restart's re-materialize the start is refused; the
    /// link's target is untouched. The user homes are per-process temp dirs.
    #[test]
    #[cfg(unix)]
    fn a_copy_into_a_home_whose_target_is_a_link_refuses_the_render_and_the_start() {
        let ws = std::env::temp_dir().join(format!("tmm-copy-link-{}", uuid::Uuid::new_v4()));
        let outside = ws.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let sentinel = outside.join("theirs");
        std::fs::write(&sentinel, "the user's").unwrap();
        let cases: [(&str, PathBuf, &str); 2] = [
            ("grok", crate::backends::grok::grok_user_home(), "auth.json"),
            ("omp", crate::backends::omp::omp_user_agent_dir(), "agent.db"),
        ];
        for (backend, user, file) in &cases {
            std::fs::create_dir_all(user).unwrap();
            std::fs::write(user.join(file), format!("SENTINEL-{backend}")).unwrap();
            let name = format!("cp{backend}");
            let home = agent_home(&ws.to_string_lossy(), &name);
            make_home_private(&home).unwrap();
            std::os::unix::fs::symlink(&sentinel, home.join(file)).unwrap();
            let d = def(backend);
            let prompt = build_prompt(&d, &name, "proj", "", "", "");
            let r = match *backend {
                "grok" => crate::backends::grok::render_grok(&d, &name, &home, &prompt, &[]),
                _ => crate::backends::omp::render_omp(&d, &name, &home, &prompt, &[]),
            };
            assert!(r.is_err(), "{backend}: the render is refused");
            // The start door: a registry definition and its recipe, restarted.
            let def_name = format!("{name}-{}", &uuid::Uuid::new_v4().to_string()[..8]);
            super::super::registry_save(&json!({ "name": def_name, "backend": backend, "model": "", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
            std::fs::write(home.join("launch.json"), json!({ "backend": backend, "cmd": "true", "env": [], "agent_def": def_name }).to_string()).unwrap();
            let err = refresh_agent(&ws.to_string_lossy(), "proj", &name).unwrap_err();
            assert!(err.contains("not started"), "{backend}: {err}");
            super::super::registry_delete(&def_name).ok();
            std::fs::remove_file(user.join(file)).ok();
        }
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "the user's", "the links' target is untouched");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #448 P1-B: a home that cannot be made private (its `.tmm` is a
    /// link to another directory) fails refresh_hooks, never "no change".
    #[test]
    #[cfg(unix)]
    fn refresh_hooks_refuses_a_home_it_cannot_make_private() {
        let ws = std::env::temp_dir().join(format!("tmm-refresh-priv-{}", uuid::Uuid::new_v4()));
        let outside = ws.join("outside");
        std::fs::create_dir_all(outside.join("agents/dev")).unwrap();
        std::fs::write(outside.join("agents/dev/launch.json"), "{}").unwrap();
        std::fs::create_dir_all(&ws).unwrap();
        std::os::unix::fs::symlink(&outside, ws.join(".tmm")).unwrap();
        let err = refresh_hooks(&ws.to_string_lossy(), "dev").unwrap_err();
        assert!(err.contains("could not be made private"), "{err}");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #448 D4: the private writer is the ONE way a backend or the
    /// spawn/recipe/live-config code writes a file, so a new write entry
    /// cannot publish a definition's value wide. (The kiro git exclude file
    /// is the user's repo, not a home.) A PIN on the textual writers
    /// (`std::fs::write`, `fs::copy`, `File::create`, `OpenOptions::new`),
    /// not a proof: the sentinel test is the behaviour.
    #[test]
    fn production_code_writes_agent_files_only_through_the_private_writer() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files: Vec<PathBuf> = std::fs::read_dir(root.join("backends")).unwrap().flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "rs")).collect();
        for f in ["projects/spawn.rs", "projects/live_config.rs", "projects/recipe.rs"] { files.push(root.join(f)); }
        let mut raw = Vec::new();
        for f in &files {
            let src = std::fs::read_to_string(f).unwrap();
            // Production is everything before the first test module.
            let prod: String = src.split("\n#[cfg(test)]\nmod ").next().unwrap().split("\n#[cfg(test)]\npub(crate) mod ").next().unwrap().to_string();
            for (i, line) in prod.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("//") || !(t.contains("std::fs::write(") || t.contains("fs::copy(") || t.contains("File::create(") || t.contains("OpenOptions::new(")) { continue; }
                if t.contains("format!(\"{current}{sep}{mark}{line}\\n\")") { continue; } // kiro's .git/info/exclude
                // The non-Unix fallbacks of write_atomic and copy_private themselves.
                if f.ends_with("backends/shared.rs") && (t.starts_with("std::fs::write(&tmp, text)") || t.starts_with("return std::fs::write(to, bytes)")) { continue; }
                raw.push(format!("{}:{}: {t}", f.strip_prefix(&root).unwrap().display(), i + 1));
            }
        }
        assert!(raw.is_empty(), "a raw write outside the private writer: {raw:#?}");
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
        // Board #436: a kiro agent reads every delivered `@` as `＠`, and its
        // own config says so, as the last bullet of the collaboration flow.
        assert!(prompt.ends_with(&format!("for the remaining commands.\n{}", crate::backends::kiro::AT_TYPED_NOTE)), "{prompt}");
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
        LaunchRecipe { backend: "kiro", env: &r.env, cmd: &r.cmd, spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&dir).unwrap();
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

        assert!(refresh_hooks(&ws.to_string_lossy(), "dev").unwrap(), "a stale config is rewritten");
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
        assert!(!refresh_hooks(&ws.to_string_lossy(), "dev").unwrap(), "no needless writes");
        // A window with no isolated home is not ours to touch.
        assert!(!refresh_hooks(&ws.to_string_lossy(), "byhand").unwrap());
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
        assert!(refresh_hooks(&ws.to_string_lossy(), "dev").unwrap());
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
        assert!(ensure_kiro_settings(&home, "").unwrap(), "missing key is backfilled");
        let after = read();
        assert_eq!(after.get("chat.defaultInterruptBehavior").and_then(|v| v.as_str()), Some("queue"));
        assert_eq!(after.get("chat.editMode").and_then(|v| v.as_str()), Some("vi"), "foreign keys are not ours to drop");
        assert_eq!(after.get("chat.enableAutoAgentUpgrade").and_then(|v| v.as_bool()), Some(true), "#207: the v3 startup modal is answered in the settings");
        assert!(after.get("chat.defaultModel").is_none(), "#207: no model pinned → no key");

        // Case 3: already canonical — no write, so starting a project does not
        // churn mtimes.
        assert!(!ensure_kiro_settings(&home, "").unwrap(), "no needless writes");

        // Case 4 (#207): the v3 model mirror follows the profile's model —
        // written when pinned, DELETED when cleared (a stale pin must not
        // outlive the config), idempotent in between.
        assert!(ensure_kiro_settings(&home, "claude-sonnet-5").unwrap());
        assert_eq!(read().get("chat.defaultModel").and_then(|v| v.as_str()), Some("claude-sonnet-5"));
        assert!(!ensure_kiro_settings(&home, "claude-sonnet-5").unwrap(), "same model, no write");
        assert!(ensure_kiro_settings(&home, "").unwrap(), "cleared → the stale key goes");
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

        assert!(refresh_hooks(&ws.to_string_lossy(), "cc").unwrap());
        let read = || -> Value {
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap()
        };
        let after = read();
        assert_eq!(after["statusLine"], shared::claude_status_line_config());
        assert_eq!(after["env"]["ANTHROPIC_MODEL"], "agent-override");
        assert_eq!(after["theme"], "dark");
        assert!(!refresh_hooks(&ws.to_string_lossy(), "cc").unwrap(), "canonical home is a no-op");
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
        LaunchRecipe { backend: "kiro", env: &[("KIRO_HOME".to_string(), home.to_string_lossy().to_string())], cmd: "command kiro-cli chat --agent dev --model claude-haiku-4.5 --trust-all-tools", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }
            .write(&home)
            .unwrap();

        assert!(refresh_hooks(&ws.to_string_lossy(), "dev").unwrap(), "a stale config is rewritten");
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(after.get("model").and_then(|m| m.as_str()), Some("claude-haiku-4.5"));
        let recipe: Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        let cmd = recipe["cmd"].as_str().unwrap();
        assert!(!cmd.contains("--model"), "the line must not keep a second opinion: {cmd}");
        assert!(cmd.contains("--agent dev") && cmd.contains("--trust-all-tools"), "{cmd}");
        // Idempotent, and a model already in the config outranks the line.
        assert!(!refresh_hooks(&ws.to_string_lossy(), "dev").unwrap(), "no needless writes");
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
            "command kiro-cli chat --agent dev --model claude-sonnet-4-5 --trust-all-tools", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();

        refresh_hooks(&ws.to_string_lossy(), "dev").unwrap();
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
        // Board #457: a managed pane neither starts nor connects to codex's
        // app-server daemon. `--no-daemon` is codex's documented door (0.162.1
        // --help, codex and codex resume); `--profile` is the identity/MCP
        // door. A SOURCE pin on both: on 0.162.1 either one alone already
        // suppressed the daemon's start, so this test does not show two
        // independent behavioural causes; the rig rows on #457 do the measuring.
        let words: Vec<&str> = cmd.split_whitespace().collect();
        assert!(words.windows(2).any(|w| w == ["--profile", "tmm-agent"]), "the profile door: {cmd}");
        assert!(words.contains(&"--no-daemon"), "no shared background server, started or joined: {cmd}");
        let resumed = crate::backends::codex::resume_command(&cmd, Some("01a1656d-ae66-7b90-a5b0-6ba62708fd87"));
        assert!(resumed.starts_with("command codex resume ") && resumed.split_whitespace().any(|w| w == "--no-daemon"), "a resume keeps it: {resumed}");
        // Board #452: no shell snapshot, as a `-c` (beats a user's or a
        // trusted project's `true`), kept by both resume forms.
        let snap = crate::backends::shared::codex_config_override("features.shell_snapshot", serde_json::Value::Bool(false));
        assert!(cmd.contains(&snap), "no shell snapshot: {cmd}");
        for r in [resumed.clone(), crate::backends::codex::resume_command(&cmd, None)] {
            assert!(r.contains(&snap), "a resume keeps it: {r}");
        }
        // And a render removes the cache an earlier launch left in the home.
        let cache = dir.join("codex/shell_snapshots");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("old.1.sh"), "export SENTINEL_452=x").unwrap();
        render_codex(&d, "tester", &dir, Path::new("/srv/work/my-app"), &prompt, &[]).unwrap();
        assert!(!cache.exists(), "the render removed the old snapshots");
        // Board #446: a typed line's Enter submits instead of joining a
        // "paste" (codex's paste-burst heuristic; measured on 0.162.1). The
        // [tui] key exactly: it is the one that wins over an inherited
        // config (the legacy top-level key loses to a [tui] false).
        let tokens: Vec<&str> = cmd.split_whitespace().collect();
        assert!(tokens.windows(2).any(|w| w == ["-c", "tui.disable_paste_burst=true"]), "a typed delivery's Enter submits: {cmd}");
        assert!(!tokens.iter().any(|t| t.starts_with("disable_paste_burst=")), "not the legacy top-level key: {cmd}");
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
        assert!(!ensure_kiro_settings(&dir, "").unwrap(), "steer is kept, nothing to write");
        assert_eq!(cli()["chat.defaultInterruptBehavior"], "steer");
        let mut stale = cli();
        stale.as_object_mut().unwrap().remove("chat.defaultInterruptBehavior");
        std::fs::write(dir.join("settings/cli.json"), stale.to_string()).unwrap();
        assert!(ensure_kiro_settings(&dir, "").unwrap());
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

        // dsh (board #410): the mode is a file its plugin reads at the start
        // of each run; a restart re-renders it from the definition.
        let mut d = def("dsh");
        let mode = || std::fs::read_to_string(dir.join("dsh/tmm/input_mode")).unwrap();
        crate::backends::dsh::render_dsh(&d, "tester", &dir, &prompt, &[]).unwrap();
        assert_eq!(mode(), "queue\n", "the default");
        d.input_mode = "steer".into();
        crate::backends::dsh::render_dsh(&d, "tester", &dir, &prompt, &[]).unwrap();
        assert_eq!(mode(), "steer\n");
    }

    /// Board #245: `steer` is accepted only where the switch was measured;
    /// every backend accepts `queue`, and nothing else is a mode.
    #[test]
    fn steer_is_offered_only_where_it_was_measured() {
        use crate::backends::Backend;
        let switching: Vec<&str> = Backend::ALL.iter().filter(|b| b.switches_input_mode()).map(|b| b.name()).collect();
        assert_eq!(switching, ["kiro", "codex", "dsh"], "dsh: measured through the real dsh, board #410");
        for b in Backend::ALL {
            assert!(super::super::models::validate_input_mode(b.name(), "queue").is_ok());
            assert_eq!(super::super::models::validate_input_mode(b.name(), "steer").is_ok(), b.switches_input_mode(), "{}", b.name());
            assert!(super::super::models::validate_input_mode(b.name(), "").is_err());
            assert_eq!(b.describe()["input_modes"], b.switches_input_mode(), "the client reads the switch, never mirrors it");
            // Board #336: the default is always a mode this backend accepts,
            // and the client reads it from the same list.
            assert!(super::super::models::validate_input_mode(b.name(), b.default_input_mode()).is_ok(), "{}", b.name());
            assert_eq!(b.describe()["default_input_mode"], b.default_input_mode(), "{}", b.name());
        }
        let defaults: Vec<(&str, &str)> = Backend::ALL.iter().map(|b| (b.name(), b.default_input_mode())).collect();
        assert_eq!(defaults, [("kiro", "steer"), ("claude", "queue"), ("codex", "queue"), ("grok", "queue"), ("omp", "queue"), ("kimi", "queue"), ("dsh", "queue")],
            "owner #336: a new kiro steers; every other backend keeps queue");
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
            // codex's MCP is the managed profile, never the line (board #448).
            let profile = std::fs::read_to_string(dir.join("codex/tmm-agent.config.toml")).unwrap_or_default();
            assert!(dir.join("mcp.json").exists() || profile.contains("[mcp_servers.files]"), "registry MCP present");
            assert!(!r.cmd.contains("mcp_servers"), "no MCP override on the line: {}", r.cmd);
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
    /// grok (measured on each CLI); for codex, the managed profile's
    /// `model_reasoning_effort` with the model beside it, never the line
    /// (#455, non-negotiable 10). Empty = not set, nothing on the line.
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
        d.model = "gpt-6-luna".into();
        let cx = render_codex(&d, "t", &dir, &dir, &prompt, &[]).unwrap().cmd;
        assert!(!cx.contains("model_reasoning_effort") && !cx.contains("--model") && !cx.contains("gpt-6-luna"), "codex's identity is not on the line: {cx}");
        let profile = |dir: &std::path::Path| -> toml::Table {
            std::fs::read_to_string(dir.join("codex").join(shared::codex_profile_file())).unwrap().parse().unwrap()
        };
        let p = profile(&dir);
        assert_eq!((p["model"].as_str(), p["model_reasoning_effort"].as_str()), (Some("gpt-6-luna"), Some("high")), "{p:?}");
        // A cleared definition clears the file (a whole-document render), and a
        // `/model` default codex wrote into it does not survive the next render.
        std::fs::write(dir.join("codex").join(shared::codex_profile_file()), "model = \"picked-in-pane\"\n").unwrap();
        d.model = String::new();
        d.effort = String::new();
        let cx = render_codex(&d, "t", &dir, &dir, &prompt, &[]).unwrap().cmd;
        assert!(!cx.contains("model_reasoning_effort") && !cx.contains("--model"), "{cx}");
        let p = profile(&dir);
        assert!(!p.contains_key("model") && !p.contains_key("model_reasoning_effort"), "not set at this layer: {p:?}");
        // Empty effort leaves every line clean.
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
        LaunchRecipe { backend: "kiro", env: &[], cmd: "command kiro-cli chat --agent b", spawned_by: "lead", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&home).unwrap();
        let recipe: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        assert_eq!(recipe["spawned_by"], "lead");
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #382: a registry agent spawned INTO a running team. It is
    /// recorded in the team (the recipe's team, no member, its def name), so
    /// every team-reading surface counts it; its prompt names the team and
    /// its teammates, on the spawn and on every restart; a team restart's
    /// plan leaves it alone (it is not in the definition); and a join into a
    /// team that has nobody here is refused by name.
    #[test]
    fn a_joined_agent_is_in_the_team_but_not_in_its_definition() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-join-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() };
        let save = |name: &str, persona: &str| {
            super::super::registry_save(&json!({ "name": name, "backend": "kiro", "model": "", "effort": "", "system": persona, "skills": "[]", "mcp": "[]" })).unwrap()
        };
        save("jnbase", "Base.");
        save("jnhelper", "Helper persona.");
        super::super::teams_save(&json!({
            "name": "jnteam", "description": "Ships it.",
            "members": r#"[{"name":"lead","base":"jnbase","role":"splits the work"},{"name":"dev","base":"jnbase","role":"implements"}]"#
        })).unwrap();
        assert!(check_join(&ws_str, "jnteam").unwrap_err().contains("has no member in this project"), "nobody here yet");
        let team = super::super::team_get("jnteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![("lead".into(), "splits the work".into(), "jnteam".into()), ("dev".into(), "implements".into(), "jnteam".into())];
        let base = super::super::registry_get("jnbase").unwrap();
        for (f, w) in flat.iter().zip(["lead", "dev"]) {
            let d = super::super::teams::effective_def(f, base.as_ref(), w, &roster).unwrap();
            materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, w)), &d, w, "proj", &ws_str, "", "", Some("jnteam"), "", f.member.name.trim(), "").unwrap();
        }
        check_join(&ws_str, "jnteam").unwrap();
        assert!(check_join(&ws_str, "other").is_err(), "a team with nobody here");
        assert!(check_join(&ws_str, "jn/team").unwrap_err().contains("team name"), "a name, not a path");

        // The join: a registry def, the team, no member — what hub_spawn hands spawn.
        let helper = super::super::registry_get("jnhelper").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "jnhelper")), &helper, "jnhelper", "proj", &ws_str, "", "lead", Some("jnteam"), "jnhelper", "", "").unwrap();
        let recipe = read(&agent_home(&ws_str, "jnhelper").join("launch.json"));
        assert_eq!((recipe["team"].as_str(), recipe["member"].as_str(), recipe["agent_def"].as_str()), (Some("jnteam"), Some(""), Some("jnhelper")));
        assert_eq!(super::super::team_of(Some(&ws_str), "jnhelper").as_deref(), Some("jnteam"), "Hub's team tabs and team context read it as in the team");
        let prompt = || read(&agent_home(&ws_str, "jnhelper").join("agents").join("jnhelper.json"))["prompt"].as_str().unwrap().to_string();
        let p = prompt();
        assert!(p.contains("Helper persona.") && p.contains("## Your team: \"jnteam\"\nShips it."), "{p}");
        assert!(p.contains("- @lead — splits the work\n- @dev — implements"), "teammates with their roles: {p}");
        let lead = read(&agent_home(&ws_str, "lead").join("agents").join("lead.json"))["prompt"].as_str().unwrap().to_string();
        assert!(!lead.contains("jnhelper"), "an existing member is not re-materialized");

        // Team restart: the definition decides, so the joiner is in no row.
        let mut homes: Vec<(String, String, String)> = team_windows_from_recipes(&ws_str, "jnteam").into_iter().map(|((p, m), w)| (w, p, m)).collect();
        homes.sort();
        let current: Vec<(String, String)> = flat.iter().map(|f| (f.path.clone(), f.member.name.trim().to_string())).collect();
        let plan = team_plan(&homes, &current, &["lead".into(), "dev".into(), "jnhelper".into()]);
        assert_eq!(plan, TeamPlan { restart: vec!["dev".into(), "lead".into()], stop: vec![], spawn: vec![] }, "the joiner is neither restarted nor stopped");
        assert_eq!(joined_windows(&ws_str, "jnteam"), ["jnhelper"], "it is the one the restart's room line names");

        // A restart re-materializes it from its def, still in the team, and
        // its block follows the team as it stands now.
        super::super::teams_save(&json!({
            "name": "jnteam", "description": "Ships it.",
            "members": r#"[{"name":"lead","base":"jnbase","role":"owns merges"},{"name":"dev","base":"jnbase","role":"implements"}]"#
        })).unwrap();
        save("jnhelper", "Helper persona v2.");
        assert!(refresh_agent(&ws_str, "proj", "jnhelper").unwrap());
        let p = prompt();
        assert!(p.contains("Helper persona v2.") && p.contains("- @lead — owns merges"), "{p}");
        assert_eq!(p.matches("## Your team:").count(), 1, "one block, not one per restart");
        let recipe = read(&agent_home(&ws_str, "jnhelper").join("launch.json"));
        assert_eq!((recipe["team"].as_str(), recipe["member"].as_str()), (Some("jnteam"), Some("")), "a restart keeps the join");

        // Reviewer P2 on 56a3ad44 (#383's fork hands spawn a ready-made def):
        // the check is about the TEAM, not about how the def was made. A
        // request with its own def that names a team and no member is a
        // join, and is refused for a team that is not here, before any
        // window; a team member placed by its definition is not a join.
        let made = super::super::create(&ws_str, Some("jnproj"), None, None).unwrap();
        let session = made["session"].as_str().unwrap().to_string();
        let with_def = |team: &str, member: &'static str| spawn(&SpawnRequest {
            session: &session, agent: "fork", def: Some(helper.clone()), team: Some(team.into()), member, ..Default::default()
        });
        assert!(with_def("ghost", "").unwrap_err().contains("team 'ghost' has no member in this project"), "a def of its own is checked too");
        assert!(with_def("jnteam/sub", "").unwrap_err().contains("team name"), "joined by its root");
        // Which requests are joins, without opening anything: a placed member
        // (its definition names it) never is.
        assert_eq!(join_of(Some("jnteam"), ""), Some("jnteam"));
        assert_eq!(join_of(Some("jnteam"), "  "), Some("jnteam"));
        assert_eq!(join_of(Some("jnteam/review"), "r1"), None, "a team spawn's member");
        assert_eq!(join_of(None, ""), None, "standalone");

        super::super::teams_delete("jnteam").ok();
        for n in ["jnbase", "jnhelper"] { super::super::registry_delete(n).ok(); }
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #384: moving an existing agent's runtime membership edits the
    /// recipe's `team` and nothing else; joining checks the team like a join
    /// at spawn; a definition member cannot be moved; the restart then builds
    /// (or drops) the team block.
    #[test]
    fn an_agent_moves_in_and_out_of_a_team_by_its_recipe_alone() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-move-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() };
        super::super::registry_save(&json!({ "name": "mvbase", "backend": "kiro", "system": "Base.", "skills": "[]", "mcp": "[]" })).unwrap();
        super::super::registry_save(&json!({ "name": "mvsolo", "backend": "kiro", "system": "Solo persona.", "skills": "[]", "mcp": "[]" })).unwrap();
        super::super::teams_save(&json!({ "name": "mvteam", "description": "Moves.", "members": r#"[{"name":"lead","base":"mvbase","role":"leads"}]"#.to_string() })).unwrap();
        let team = super::super::team_get("mvteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let base = super::super::registry_get("mvbase").unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![("lead".into(), "leads".into(), "mvteam".into())];
        let d = super::super::teams::effective_def(&flat[0], base.as_ref(), "lead", &roster).unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "lead")), &d, "lead", "proj", &ws_str, "", "", Some("mvteam"), "", "lead", "").unwrap();
        let solo = super::super::registry_get("mvsolo").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "mvsolo")), &solo, "mvsolo", "proj", &ws_str, "", "human", None, "mvsolo", "", "").unwrap();
        let recipe = || read(&agent_home(&ws_str, "mvsolo").join("launch.json"));
        let before = recipe();
        // Board #440: the recipe carries TMM_SOCKET, the socket this gateway
        // bound ('' here, where none is bound), so a restart replays it and a
        // stale tmux-global value is masked.
        let socket: Vec<_> = before["env"].as_array().unwrap().iter().filter(|kv| kv[0] == "TMM_SOCKET").collect();
        assert_eq!(socket, vec![&json!(["TMM_SOCKET", crate::server::bound_local_socket().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()])], "{before}");

        assert!(set_agent_team(&ws_str, "mvsolo", "ghost", &|_| Ok(Vec::new())).unwrap_err().contains("team 'ghost' has no member in this project"));
        assert_eq!(recipe(), before, "a refused move writes nothing");
        assert_eq!(set_agent_team(&ws_str, "mvsolo", "", &|_| Ok(Vec::new())).unwrap(), (String::new(), false, 0), "standalone already");
        assert_eq!(set_agent_team(&ws_str, "mvsolo", "mvteam", &|_| Ok(Vec::new())).unwrap(), (String::new(), true, 1));
        let mut expected = before.clone();
        expected["team"] = json!("mvteam");
        expected["team_rev"] = json!(1);
        expected["team_told"] = json!({ "mover": "", "members": {} });
        assert_eq!(recipe(), expected, "only the team field, its revision and the seeded ledger (standalone: nobody was told) changed");
        assert!(!agent_home(&ws_str, "mvsolo").join("launch.json.tmp").exists(), "no temp file left");
        assert_eq!(super::super::joined_team(Some(&ws_str), "mvsolo").as_deref(), Some("mvteam"));
        assert_eq!(team_mates(&ws_str, "mvteam", "mvsolo"), [("lead".to_string(), "leads".to_string())]);
        let prompt = || read(&agent_home(&ws_str, "mvsolo").join("agents").join("mvsolo.json"))["prompt"].as_str().unwrap().to_string();
        assert!(!prompt().contains("## Your team"), "the running agent's config is not rewritten");
        assert!(refresh_agent(&ws_str, "proj", "mvsolo").unwrap());
        assert!(prompt().contains("## Your team: \"mvteam\"") && prompt().contains("- @lead — leads"), "its next start carries the block: {}", prompt());
        assert_eq!(set_agent_team(&ws_str, "mvsolo", "mvteam", &|_| Ok(Vec::new())).unwrap(), ("mvteam".to_string(), false, 1), "already there: no new revision");

        assert!(set_agent_team(&ws_str, "lead", "", &|_| Ok(Vec::new())).unwrap_err().contains("by the team's definition — change it in Agents > Teams"), "a definition member stays");
        assert_eq!(set_agent_team(&ws_str, "mvsolo", "", &|_| Ok(Vec::new())).unwrap(), ("mvteam".to_string(), true, 2));
        let mut left = before.clone();
        left["team_rev"] = json!(2);
        left["team_told"] = json!({ "mover": "", "members": {} });
        assert_eq!(recipe(), left, "left: the recipe is what it was, a revision on; the ledger is the announcer's, untouched by the move");
        // The first move seeds the ledger from the recipe as it stood: the
        // agent's old team, and that team's live members as `seed` reads them.
        let seeded_home = agent_home(&ws_str, "seeded");
        std::fs::create_dir_all(&seeded_home).unwrap();
        LaunchRecipe { backend: "kiro", env: &[], cmd: "x", spawned_by: "", team: Some("mvteam"), agent_def: "", member: "", from_member: "", input_mode: "" }.write(&seeded_home).unwrap();
        assert_eq!(set_agent_team(&ws_str, "seeded", "", &|t| Ok(if t == "mvteam" { vec!["lead".to_string()] } else { Vec::new() })).unwrap(), ("mvteam".to_string(), true, 1));
        assert_eq!(read(&seeded_home.join("launch.json"))["team_told"], json!({ "mover": "mvteam", "members": { "lead": "mvteam" } }));
        assert_eq!(set_agent_team(&ws_str, "seeded", "mvteam", &|_| Ok(vec!["nobody".to_string()])).unwrap().1, true);
        assert_eq!(read(&seeded_home.join("launch.json"))["team_told"]["members"], json!({ "lead": "mvteam" }), "seeded once; a later move does not reseed");
        // A seed that cannot be read refuses the first move, recipe unchanged
        // (board #388): an unread team is not an empty one.
        let unread_home = agent_home(&ws_str, "unread");
        std::fs::create_dir_all(&unread_home).unwrap();
        LaunchRecipe { backend: "kiro", env: &[], cmd: "x", spawned_by: "", team: Some("mvteam"), agent_def: "", member: "", from_member: "", input_mode: "" }.write(&unread_home).unwrap();
        let unread_before = read(&unread_home.join("launch.json"));
        let refused = set_agent_team(&ws_str, "unread", "", &|_| Err("tmux could not be asked".into())).unwrap_err();
        assert!(refused.contains("could not read who is in team 'mvteam'") && refused.contains("nothing was changed"), "{refused}");
        assert_eq!(read(&unread_home.join("launch.json")), unread_before, "the recipe is unchanged: no team, no revision, no ledger");
        // A fresh recipe in another team (a reused home) drops the ledger.
        LaunchRecipe { backend: "kiro", env: &[], cmd: "x", spawned_by: "", team: None, agent_def: "", member: "", from_member: "", input_mode: "" }.write(&seeded_home).unwrap();
        assert!(read(&seeded_home.join("launch.json")).get("team_told").is_none());
        assert_eq!(read(&seeded_home.join("launch.json"))["team_rev"], 2, "the revision stays");
        assert!(refresh_agent(&ws_str, "proj", "mvsolo").unwrap());
        assert!(!prompt().contains("## Your team"), "and its next start drops the block");
        assert!(set_agent_team(&ws_str, "nobody", "mvteam", &|_| Ok(Vec::new())).unwrap_err().contains("is not an agent this app started"));

        // Reviewer P2-1: two sub-teams of one root each have a `dev` with its
        // own role. The moved agent hears each dev's role by (path, member),
        // the reading #382's team block uses, never the first `dev` found.
        super::super::registry_save(&json!({ "name": "mvdev", "backend": "kiro", "system": "Dev.", "skills": "[]", "mcp": "[]" })).unwrap();
        super::super::teams_save(&json!({ "name": "mvbuild", "description": "", "members": r#"[{"name":"dev","base":"mvdev","role":"builds the parser"}]"#.to_string() })).unwrap();
        super::super::teams_save(&json!({ "name": "mvreview", "description": "", "members": r#"[{"name":"dev","base":"mvdev","role":"reviews every diff"}]"#.to_string() })).unwrap();
        super::super::teams_save(&json!({ "name": "mvroot", "description": "", "members": r#"[{"team":"mvbuild"},{"team":"mvreview"}]"#.to_string() })).unwrap();
        for (w, path) in [("dev", "mvroot/mvbuild"), ("dev-2", "mvroot/mvreview")] {
            let h = agent_home(&ws_str, w);
            std::fs::create_dir_all(&h).unwrap();
            LaunchRecipe { backend: "kiro", env: &[], cmd: "x", spawned_by: "", team: Some(path), agent_def: "", member: "dev", from_member: "", input_mode: "" }.write(&h).unwrap();
        }
        let mut mates = team_mates(&ws_str, "mvroot", "mvsolo");
        mates.sort();
        assert_eq!(mates, [("dev".to_string(), "builds the parser".to_string()), ("dev-2".to_string(), "reviews every diff".to_string())]);
        for t in ["mvroot", "mvbuild", "mvreview"] { super::super::teams_delete(t).ok(); }
        super::super::registry_delete("mvdev").ok();

        // One per-home section with a restart's read-and-rewrite: while it is
        // held, a move of THIS agent waits and lands after it; a restart
        // takes the same section; another agent's home is not held up.
        let held = super::super::recipe::recipe_section(&agent_home(&ws_str, "mvsolo"));
        let mover = { let ws = ws_str.clone(); std::thread::spawn(move || set_agent_team(&ws, "mvsolo", "mvteam", &|_| Ok(Vec::new()))) };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(recipe()["team"], "", "the move waits for the section");
        assert!(refresh_agent(&ws_str, "proj", "lead").unwrap(), "another home's restart is not held up");
        drop(held);
        assert_eq!(mover.join().unwrap().unwrap(), (String::new(), true, 3));
        assert_eq!(recipe()["team"], "mvteam");
        let held = super::super::recipe::recipe_section(&agent_home(&ws_str, "mvsolo"));
        let restart = { let ws = ws_str.clone(); std::thread::spawn(move || refresh_agent(&ws, "proj", "mvsolo").unwrap()) };
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert!(!restart.is_finished(), "a restart's refresh takes the same section");
        drop(held);
        assert!(restart.join().unwrap());
        assert_eq!(recipe()["team"], "mvteam", "and keeps the move");
        assert_eq!(recipe()["team_rev"], 3, "and its revision (materialize keeps what it does not own)");
        // A spawn-time rewrite of the recipe (materialize) keeps a key it does
        // not own: a later feature's field survives a restart.
        super::super::recipe::update_recipe(&agent_home(&ws_str, "mvsolo"), |r| r.as_mut().unwrap()["later"] = json!(7)).unwrap();
        assert!(refresh_agent(&ws_str, "proj", "mvsolo").unwrap());
        assert_eq!(recipe()["later"], 7, "materialize preserves what it does not own");

        super::super::teams_delete("mvteam").ok();
        for n in ["mvbase", "mvsolo"] { super::super::registry_delete(n).ok(); }
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
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, name)), &def, name, "proj", &ws_str, "fix the login bug", "lead", None, name, "", "").unwrap();
        let cfg = agent_home(&ws_str, name).join("agents").join(format!("{name}.json"));
        let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() };
        assert!(read(&cfg)["prompt"].as_str().unwrap().contains("Old persona."));
        // Board #448: materialize makes the home private, `.tmm/agents` included.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!((mode(&ws.join(".tmm/agents")), mode(&agent_home(&ws_str, name))), (0o700, 0o700));
            // A home an older build left wide closes on the next start's refresh_hooks.
            for p in [ws.join(".tmm/agents"), agent_home(&ws_str, name)] {
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            refresh_hooks(&ws_str, name).unwrap();
            assert_eq!((mode(&ws.join(".tmm/agents")), mode(&agent_home(&ws_str, name))), (0o700, 0o700), "refresh_hooks closed it");
        }

        // The def evolves after the spawn; restart must launch THIS text.
        save("New persona.");
        assert!(refresh_agent(&ws_str, "proj", name).unwrap(), "a registry-named agent refreshes");
        let prompt = read(&cfg)["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("New persona."), "current def text: {prompt}");
        assert!(!prompt.contains("Old persona."));
        assert!(!prompt.contains("fix the login bug"), "the spawn brief is history, not part of a refresh");
        let recipe = read(&agent_home(&ws_str, name).join("launch.json"));
        assert_eq!(recipe["spawned_by"], "lead", "spawner provenance survives");

        // No def / no recipe = no refresh — those windows replay verbatim.
        assert!(!refresh_agent(&ws_str, "proj", "no-such-def").unwrap());
        std::fs::remove_dir_all(agent_home(&ws_str, name)).unwrap();
        assert!(!refresh_agent(&ws_str, "proj", name).unwrap(), "a home without a recipe is not ours to rewrite");
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
                materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, w)), &d, w, "proj", &ws_str, "", "", Some("mmteam"), "", f.member.name.trim(), "").unwrap();
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
        assert!(refresh_agent(&ws_str, "proj", "st").unwrap() && refresh_agent(&ws_str, "proj", "in").unwrap());
        assert_eq!((mode("st").as_str(), mode("in").as_str()), ("queue", "steer"), "restart: the override, and the base's new mode");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #336: a NEW definition that names no input mode gets its
    /// backend's default at the door — a registry def and a team's bare
    /// member alike — and a kiro def saved that way spawns steering. A mode
    /// that IS named is kept, and team text with nothing to fill is stored
    /// byte for byte.
    #[test]
    fn a_def_that_names_no_input_mode_gets_its_backends_default() {
        super::super::tests::use_test_store();
        let save = |name: &str, backend: &str, mode: Option<Value>| {
            let mut def = json!({ "name": name, "backend": backend, "model": "", "effort": "", "system": "New.", "skills": "[]", "mcp": "[]" });
            if let Some(m) = mode { def["input_mode"] = m; }
            super::super::registry_save(&def).unwrap();
            super::super::registry_get(name).unwrap().unwrap().input_mode
        };
        assert_eq!(save("dmkiro", "kiro", None), "steer", "a new kiro steers");
        assert_eq!(save("dmnull", "kiro", Some(Value::Null)), "steer", "null is the CLI's 'no flag'");
        assert_eq!(save("dmclaude", "claude", None), "queue", "a backend without the switch queues");
        assert_eq!(save("dmcodex", "codex", None), "queue", "codex switches, but its default is queue");
        assert_eq!(save("dmkq", "kiro", Some(json!("queue"))), "queue", "a named mode is kept");
        assert!(super::super::registry_save(&json!({ "name": "dmempty", "backend": "kiro", "input_mode": "", "system": "", "skills": "[]", "mcp": "[]" })).is_err(),
            "an empty mode is still refused, not defaulted");

        let ws = std::env::temp_dir().join(format!("tmm-default-mode-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let d = super::super::registry_get("dmkiro").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "dmkiro")), &d, "dmkiro", "proj", &ws_str, "", "", None, "dmkiro", "", "").unwrap();
        let cli: Value = serde_json::from_str(&std::fs::read_to_string(agent_home(&ws_str, "dmkiro").join("settings/cli.json")).unwrap()).unwrap();
        assert_eq!(cli["chat.defaultInterruptBehavior"], "steer", "and it spawns steering");
        let _ = std::fs::remove_dir_all(&ws);

        let stored = |name: &str| super::super::team_get(name).unwrap().unwrap().members;
        let bare = |mode: &str| format!(r#"{{"name":"raw","base":"","role":"","agent":{{"name":"raw","backend":"kiro","model":"","effort":"",{mode}"system":"Bare.","skills":"[]","mcp":"[]"}}}}"#);
        super::super::teams_save(&json!({ "name": "dmteam", "description": "", "members": format!("[{}]", bare("")) })).unwrap();
        let members: Vec<Value> = serde_json::from_str(&stored("dmteam")).unwrap();
        assert_eq!(members[0]["agent"]["input_mode"], "steer", "a bare kiro member without a mode steers");
        let named = format!(r#"[{},{{"name":"der","base":"dmkiro","role":""}}]"#, bare(r#""input_mode":"queue","#));
        super::super::teams_save(&json!({ "name": "dmnamed", "description": "", "members": named.clone() })).unwrap();
        assert_eq!(stored("dmnamed"), named, "nothing to fill: the text is stored as it came");
    }

    /// Board #336 reviewer P1-B: registry_save and teams_save are UPSERTS, so
    /// "only a new definition gets the default" has to be decided against
    /// what is stored. An update that names no mode keeps the stored one —
    /// for a registry row, and for a team's existing bare member, including
    /// a member stored before #245 with no mode at all (which has always
    /// meant queue) — while a new bare member saved beside it gets the
    /// backend's default.
    #[test]
    fn an_update_that_names_no_input_mode_keeps_the_stored_one() {
        super::super::tests::use_test_store();
        let save = |name: &str, backend: &str, mode: Option<&str>, system: &str| {
            let mut def = json!({ "name": name, "backend": backend, "model": "", "effort": "", "system": system, "skills": "[]", "mcp": "[]" });
            if let Some(m) = mode { def["input_mode"] = json!(m); }
            super::super::registry_save(&def).unwrap();
            super::super::registry_get(name).unwrap().unwrap().input_mode
        };
        assert_eq!(save("upq", "kiro", Some("queue"), "v1"), "queue");
        assert_eq!(save("upq", "kiro", None, "v2"), "queue", "an existing queue kiro stays queue on an update without a mode");
        assert_eq!(save("ups", "codex", Some("steer"), "v1"), "steer");
        assert_eq!(save("ups", "codex", None, "v2"), "steer", "and an existing steer stays steer");
        assert_eq!(save("ups", "claude", None, "v3"), "queue", "a kept steer the new backend cannot carry falls to its default");

        // A team stored before #245: its bare kiro member carries no mode.
        let historic = r#"[{"name":"old","base":"","role":"Old","agent":{"name":"old","backend":"kiro","model":"","effort":"","system":"Old.","skills":"[]","mcp":"[]"}}]"#;
        super::super::with_store(|st| st.team_save(&super::super::store::RegTeam { name: "upteam".into(), description: "".into(), members: historic.into() }, 1)).unwrap();
        let members = |name: &str| super::super::teams::parse_members(&super::super::team_get(name).unwrap().unwrap()).unwrap();
        assert_eq!(members("upteam")[0].agent.as_ref().unwrap().input_mode, "queue", "it has always meant queue");
        // Only the description and the role change, the members go back as read.
        let edited = historic.replace(r#""role":"Old""#, r#""role":"Older""#);
        super::super::teams_save(&json!({ "name": "upteam", "description": "now described", "members": edited.clone() })).unwrap();
        assert_eq!(super::super::team_get("upteam").unwrap().unwrap().members, edited, "the existing member is stored as it came: no mode is filled in");
        assert_eq!(members("upteam")[0].agent.as_ref().unwrap().input_mode, "queue", "and it still restarts queued");
        // A new bare kiro member beside it: that one is new, so it steers.
        let grown = edited.replace("}}]", r#"}},{"name":"new","base":"","role":"","agent":{"name":"new","backend":"kiro","model":"","effort":"","system":"New.","skills":"[]","mcp":"[]"}}]"#);
        super::super::teams_save(&json!({ "name": "upteam", "description": "", "members": grown })).unwrap();
        let both: Vec<(String, String)> = members("upteam").iter().map(|m| (m.name.clone(), m.agent.as_ref().unwrap().input_mode.clone())).collect();
        assert_eq!(both, [("old".to_string(), "queue".to_string()), ("new".to_string(), "steer".to_string())]);
        // The new member is now stored with steer; an update naming no mode keeps it.
        let stripped = super::super::team_get("upteam").unwrap().unwrap().members.replace(r#","input_mode":"steer""#, "");
        assert!(!stripped.contains("steer"), "{stripped}");
        super::super::teams_save(&json!({ "name": "upteam", "description": "", "members": stripped })).unwrap();
        assert_eq!(members("upteam")[1].agent.as_ref().unwrap().input_mode, "steer", "an existing steer member stays steer");
    }

    /// Board #455: a codex definition's model and effort reach a restart
    /// through the managed profile, never the line. `refresh_agent` (every
    /// restart with a definition) rewrites the profile from the CURRENT
    /// definition and writes a recipe line without either flag. That codex
    /// then RESUMES with the profile's pair was measured on 0.162.1 (#455:
    /// `resume --last` and `resume <id>`), not here.
    #[test]
    fn a_codex_restart_takes_the_definitions_model_from_the_profile_not_the_line() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-cx455-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let name = format!("cx455-{}", &uuid::Uuid::new_v4().to_string()[..6]);
        let save = |model: &str, effort: &str| {
            super::super::registry_save(&json!({ "name": name, "backend": "codex", "model": model, "effort": effort,
                "system": "x", "skills": "[]", "mcp": json!([{ "name": "s", "command": "mcp-s" }]).to_string() })).unwrap();
        };
        save("gpt-6-luna", "high");
        let def = super::super::registry_get(&name).unwrap().expect("saved def");
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, &name)), &def, &name, "proj", &ws_str, "", "", None, &name, "", "").unwrap();
        let home = agent_home(&ws_str, &name);
        let profile = || -> toml::Table { std::fs::read_to_string(home.join("codex").join(shared::codex_profile_file())).unwrap().parse().unwrap() };
        let line = || -> String { serde_json::from_str::<Value>(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap()["cmd"].as_str().unwrap().to_string() };
        let p = profile();
        assert_eq!((p["model"].as_str(), p["model_reasoning_effort"].as_str()), (Some("gpt-6-luna"), Some("high")));
        assert!(p["mcp_servers"].get("s").is_some());
        let cmd = line();
        assert!(cmd.contains("--profile tmm-agent") && !cmd.contains("--model") && !cmd.contains("model_reasoning_effort"), "{cmd}");

        save("gpt-6-astra", "minimal");
        assert!(refresh_agent(&ws_str, "proj", &name).unwrap(), "a definition change is re-materialized at restart");
        let p = profile();
        assert_eq!((p["model"].as_str(), p["model_reasoning_effort"].as_str()), (Some("gpt-6-astra"), Some("minimal")), "the restart's profile is today's definition");
        assert!(p["mcp_servers"].get("s").is_some(), "and keeps the servers");
        let cmd = line();
        assert!(!cmd.contains("--model") && !cmd.contains("model_reasoning_effort") && !cmd.contains("gpt-6"), "no second opinion on the line: {cmd}");

        save("", "");
        assert!(refresh_agent(&ws_str, "proj", &name).unwrap());
        let p = profile();
        assert!(!p.contains_key("model") && !p.contains_key("model_reasoning_effort"), "cleared: not set at this layer: {p:?}");
        let _ = super::super::registry_delete(&name);
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #452 (a): only an ABSENT definition keeps the old materials
    /// (`Ok(false)`); a recipe or a definition that EXISTS but cannot be read
    /// or parsed refuses the start, so a restart never goes ahead silently on
    /// materials the render would have changed. In every branch nothing in
    /// the home is removed (the planted snapshot cache stays).
    #[test]
    fn refresh_agent_keeps_old_materials_only_when_the_definition_is_absent() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-rf452-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let tag = &uuid::Uuid::new_v4().to_string()[..8];
        let setup = |window: &str, recipe: &str| {
            let home = agent_home(&ws_str, window);
            std::fs::create_dir_all(home.join("codex/shell_snapshots")).unwrap();
            std::fs::write(home.join("codex/shell_snapshots/old.1.sh"), "export SENTINEL_452A=x").unwrap();
            std::fs::write(home.join("launch.json"), recipe).unwrap();
            home
        };
        let kept = |home: &Path| home.join("codex/shell_snapshots/old.1.sh").exists();

        // Absent: the recipe names a definition that is not in the registry.
        let absent = format!("rfa-{tag}");
        let h = setup(&absent, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "agent_def": absent }).to_string());
        assert_eq!(refresh_agent(&ws_str, "proj", &absent), Ok(false), "an absent definition keeps the old materials");
        assert!(kept(&h));

        // A recipe that exists and does not parse: refused, naming the file.
        let bad = format!("rfr-{tag}");
        let h = setup(&bad, "{ not json");
        let e = refresh_agent(&ws_str, "proj", &bad).unwrap_err();
        assert!(e.contains("launch recipe") && e.contains("launch.json") && e.contains("not started"), "{e}");
        assert!(kept(&h), "nothing removed");

        // A team definition that exists and does not expand: refused.
        let team = format!("rft-{tag}");
        crate::projects::restore_hold::with_store_for_test(|st| st.team_save(&super::super::store::RegTeam {
            name: team.clone(), description: String::new(), members: "not json".into() }, 1)).unwrap();
        let member = format!("rfm-{tag}");
        let h = setup(&member, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "team": team, "member": "dev" }).to_string());
        let e = refresh_agent(&ws_str, "proj", &member).unwrap_err();
        assert!(e.contains(&format!("team '{team}' cannot be read")) && e.contains("not started"), "{e}");
        assert!(kept(&h), "nothing removed");
        // The same team ABSENT: the old materials are kept.
        super::super::teams_delete(&team).ok();
        assert_eq!(refresh_agent(&ws_str, "proj", &member), Ok(false));
        assert!(kept(&h));

        // Reviewer P1 on cb80a7b7, the cases a second lookup missed. A team
        // that expands but whose target leaf has neither a base nor an inline
        // agent: present, not a definition → refused.
        let leaf = format!("rfl-{tag}");
        crate::projects::restore_hold::with_store_for_test(|st| st.team_save(&super::super::store::RegTeam {
            name: leaf.clone(), description: String::new(), members: r#"[{"name":"dev"}]"#.into() }, 1)).unwrap();
        let lw = format!("rflw-{tag}");
        let h = setup(&lw, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "team": leaf, "member": "dev" }).to_string());
        let e = refresh_agent(&ws_str, "proj", &lw).unwrap_err();
        assert!(e.contains("is not a definition") && e.contains("not started"), "{e}");
        assert!(kept(&h));
        // A member whose base exists but whose READ fails (injected once):
        // refused, never taken for "base gone".
        let base = format!("rfb-{tag}");
        super::super::registry_save(&json!({ "name": base, "backend": "codex", "model": "", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let bt = format!("rfbt-{tag}");
        crate::projects::restore_hold::with_store_for_test(|st| st.team_save(&super::super::store::RegTeam {
            name: bt.clone(), description: String::new(), members: json!([{ "name": "dev", "base": base }]).to_string() }, 1)).unwrap();
        let bw = format!("rfbw-{tag}");
        let h = setup(&bw, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "team": bt, "member": "dev" }).to_string());
        READ_FAULT.with(|f| *f.borrow_mut() = Some(base.clone()));
        let e = refresh_agent(&ws_str, "proj", &bw).unwrap_err();
        assert!(e.contains(&format!("base '{base}'")) && e.contains("cannot be read"), "{e}");
        assert!(kept(&h));
        // A solo definition whose FIRST read fails once while a second would
        // succeed: one resolution, so the failure refuses; it is not washed
        // into "absent" by a later successful read.
        let solo = format!("rfs-{tag}");
        super::super::registry_save(&json!({ "name": solo, "backend": "codex", "model": "", "effort": "", "system": "x", "skills": "[]", "mcp": "[]" })).unwrap();
        let h = setup(&solo, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "agent_def": solo }).to_string());
        READ_FAULT.with(|f| *f.borrow_mut() = Some(solo.clone()));
        let e = refresh_agent(&ws_str, "proj", &solo).unwrap_err();
        assert!(e.contains(&format!("definition '{solo}' cannot be read")), "{e}");
        assert!(kept(&h));
        // The absent cases keep the old materials: the member gone from an
        // existing team, the base gone, a sub-team on the path gone.
        let gone = format!("rfgw-{tag}");
        let h = setup(&gone, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "team": bt, "member": "nobody" }).to_string());
        assert_eq!(refresh_agent(&ws_str, "proj", &gone), Ok(false), "member gone");
        super::super::registry_delete(&base).ok();
        assert_eq!(refresh_agent(&ws_str, "proj", &bw), Ok(false), "base gone");
        let sub = format!("rfsub-{tag}");
        let subw = format!("rfsubw-{tag}");
        let h2 = setup(&subw, &json!({ "backend": "codex", "cmd": "command codex", "env": [], "team": format!("{bt}/{sub}"), "member": "dev" }).to_string());
        assert_eq!(refresh_agent(&ws_str, "proj", &subw), Ok(false), "a sub-team on the path gone");
        assert!(kept(&h) && kept(&h2));
        for t in [&leaf, &bt] { super::super::teams_delete(t).ok(); }
        super::super::registry_delete(&solo).ok();
        std::fs::remove_dir_all(&ws).ok();
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
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "rfuniq-2")), &def, "rfuniq-2", "proj", &ws_str, "", "", None, "rfuniq", "", "").unwrap();
        save("rfuniq", "Uniq new.");
        assert!(refresh_agent(&ws_str, "proj", "rfuniq-2").unwrap(), "the uniquified window refreshes via agent_def");
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
            materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, w)), &d, w, "proj", &ws_str, "", "lead", Some("rfteam"), "", f.member.name.trim(), "").unwrap();
        }
        save("rfbase", "Base new.");
        assert!(refresh_agent(&ws_str, "proj", "dev-2").unwrap(), "the team member refreshes via team+member");
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
        assert!(!refresh_agent(&ws_str, "proj", "rfuniq-2").unwrap(), "a gone def is a soft no");
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
            materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, &f.member.name)), &d, &f.member.name, &session, &ws_str, "", "", Some("tpteam"), "", &f.member.name, "").unwrap();
        }
        save_team(r#"[{"name":"dev","base":"tpbase","role":"implement"},{"name":"rev","base":"tpbase","role":"review"}]"#);

        assert!(in_current_team("tpteam", "dev") && in_current_team("tpteam", "rev"));
        assert!(!in_current_team("tpteam", "old"), "left the definition (#287)");
        assert!(!in_current_team("no-such-team", "dev"));
        let plan = team_plan_for(&session, "tpteam").unwrap();
        assert_eq!(plan, TeamPlan { restart: vec!["dev".into()], stop: vec![], spawn: vec![("tpteam".into(), "rev".into())] },
            "no window is live: old is already stopped, so nothing to stop");
        assert!(refresh_agent(&ws_str, &session, "dev").unwrap());
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

    // ── board #383: fork a running agent ────────────────────────────────

    fn fk_save(name: &str, persona: &str, mode: &str) {
        super::super::registry_save(&json!({
            "name": name, "backend": "kiro", "model": "", "effort": "", "input_mode": mode,
            "system": persona, "skills": "[]", "mcp": "[]"
        }))
        .unwrap();
    }

    /// What `spawn` records for a request, without opening a window: the same
    /// `materialize` call it makes (the recipe's `agent_def` is the def name for
    /// a registry launch and empty for a def handed in).
    fn fk_materialize(req: &SpawnRequest, ws: &str) -> Value {
        let def = match &req.def {
            Some(d) => d.clone(),
            None => super::super::registry_get(req.agent).unwrap().unwrap(),
        };
        let agent_def = if req.def.is_none() { def.name.as_str() } else { "" };
        let name = req.window_name.clone().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(ws, &name)), &def, &name, "proj", ws, req.brief, req.by, req.team.as_deref(), agent_def, req.member, req.from_member).unwrap();
        serde_json::from_str(&std::fs::read_to_string(agent_home(ws, &name).join("launch.json")).unwrap()).unwrap()
    }

    /// A fork of a SOLO agent: the registry def it runs, launched by name into a
    /// fresh home with a fresh conversation; the source is not touched.
    #[test]
    fn a_fork_of_a_solo_agent_launches_its_def_in_a_fresh_home() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-solo-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("fksolo", "Fork persona.", "steer");
        let def = super::super::registry_get("fksolo").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "fksolo")), &def, "fksolo", "proj", &ws_str, "", "lead", None, "fksolo", "", "").unwrap();
        // The source's own conversation and files: none of it may travel.
        let source_home = agent_home(&ws_str, "fksolo");
        std::fs::create_dir_all(source_home.join("sessions")).unwrap();
        std::fs::write(source_home.join("sessions").join("sess_secret.jsonl"), "the source conversation").unwrap();
        let recipe_before = std::fs::read(source_home.join("launch.json")).unwrap();

        let live = vec!["fksolo".to_string(), "shell".to_string()];
        let plan = plan_fork(&ws_str, &live, "fksolo", None).unwrap();
        assert_eq!(plan.name, "fksolo-2", "the source's name, uniquified");
        assert_eq!((plan.agent.as_str(), plan.from_member.as_str(), plan.team.clone()), ("fksolo", "", None));
        let req = plan.request("proj", "lead");
        assert!(req.def.is_none(), "a registry def is launched by name, so a restart follows it");
        assert_eq!((req.agent, req.brief, req.resume), ("fksolo", "", false), "no brief, no resume");

        let recipe = fk_materialize(&req, &ws_str);
        let new_home = agent_home(&ws_str, "fksolo-2");
        assert_ne!(new_home, source_home);
        assert_eq!((recipe["agent_def"].as_str(), recipe["input_mode"].as_str(), recipe["team"].as_str()), (Some("fksolo"), Some("steer"), Some("")));
        let cmd = recipe["cmd"].as_str().unwrap();
        assert!(!cmd.contains("--resume"), "a fork starts a fresh conversation, never another agent's session: {cmd}");
        let prompt = serde_json::from_str::<Value>(&std::fs::read_to_string(new_home.join("agents").join("fksolo-2.json")).unwrap()).unwrap()["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Fork persona."), "{prompt}");
        assert!(!new_home.join("sessions").exists(), "nothing of the source's home is copied");
        assert_eq!(std::fs::read(source_home.join("launch.json")).unwrap(), recipe_before, "the source is only read");
        assert!(source_home.join("sessions").join("sess_secret.jsonl").exists());
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// A fork of a TEAM MEMBER copies the member's effective def and JOINS the
    /// team; it does not become a second holder of the member's slot, so the
    /// roster the siblings are built from is unchanged, and it can be forked
    /// again and refreshed through `from_member`.
    #[test]
    fn a_fork_of_a_team_member_copies_its_def_and_joins_the_team_without_its_slot() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-team-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap() };
        fk_save("fkbase", "Base persona.", "steer");
        super::super::teams_save(&json!({
            "name": "fkteam", "description": "",
            "members": r#"[{"name":"dev","base":"fkbase","role":"implement the change"},{"name":"rev","base":"fkbase","role":"review the diff"}]"#
        }))
        .unwrap();
        let team = super::super::team_get("fkteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![
            ("dev".into(), "implement the change".into(), "fkteam".into()),
            ("rev".into(), "review the diff".into(), "fkteam".into()),
        ];
        let base = super::super::registry_get("fkbase").unwrap();
        for f in &flat {
            let w = f.member.name.trim();
            let d = super::super::teams::effective_def(f, base.as_ref(), w, &roster).unwrap();
            materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, w)), &d, w, "proj", &ws_str, "", "lead", Some("fkteam"), "", w, "").unwrap();
        }
        let roster_before = team_windows_from_recipes(&ws_str, "fkteam");

        let live: Vec<String> = ["dev", "rev"].iter().map(|s| s.to_string()).collect();
        let plan = plan_fork(&ws_str, &live, "dev", None).unwrap();
        assert_eq!(plan.name, "dev-2");
        assert_eq!((plan.from_member.as_str(), plan.team.as_deref()), ("fkteam/dev", Some("fkteam")));
        let source_def = effective_def(&ws_str, "dev", &recipe_provenance(&ws_str, "dev").unwrap()).unwrap();
        assert_eq!(
            (plan.def.backend.as_str(), plan.def.model.as_str(), plan.def.effort.as_str(), plan.def.input_mode.as_str(), plan.def.skills.as_str(), plan.def.mcp.as_str()),
            (source_def.backend.as_str(), source_def.model.as_str(), source_def.effort.as_str(), source_def.input_mode.as_str(), source_def.skills.as_str(), source_def.mcp.as_str()),
            "the same definition fields as the source"
        );
        assert_eq!(plan.def.input_mode, "steer");
        let req = plan.request("proj", "lead");
        assert!(req.def.is_some() && req.member.is_empty() && req.from_member == "fkteam/dev" && !req.resume);

        let recipe = fk_materialize(&req, &ws_str);
        assert_eq!((recipe["team"].as_str(), recipe["member"].as_str(), recipe["from_member"].as_str()), (Some("fkteam"), Some(""), Some("fkteam/dev")));
        assert!(!recipe["cmd"].as_str().unwrap().contains("--resume"));
        let prompt = read(&agent_home(&ws_str, "dev-2").join("agents").join("dev-2.json"))["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Base persona.") && prompt.contains("Your role: implement the change"), "{prompt}");
        assert_eq!(prompt.matches("## Your team:").count(), 1, "exactly ONE team section (the joined block, built once): {prompt}");
        assert!(prompt.contains("You are \"dev-2\".") && !prompt.contains("You are \"dev\"."), "written for its OWN window name, not the source's: {prompt}");
        assert!(prompt.contains("- @dev — implement the change") && prompt.contains("- @rev — review the diff"), "the source is one of its teammates, with its role: {prompt}");
        assert_eq!(team_windows_from_recipes(&ws_str, "fkteam"), roster_before, "the member slot still belongs to the original window");

        // It restarts on the member's CURRENT def, and can itself be forked.
        fk_save("fkbase", "Base newer.", "steer");
        assert!(refresh_agent(&ws_str, "proj", "dev-2").unwrap());
        let prompt = read(&agent_home(&ws_str, "dev-2").join("agents").join("dev-2.json"))["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Base newer.") && prompt.contains("Your role: implement the change"), "{prompt}");
        let live: Vec<String> = ["dev", "rev", "dev-2"].iter().map(|s| s.to_string()).collect();
        let again = plan_fork(&ws_str, &live, "dev-2", None).unwrap();
        assert_eq!((again.name.as_str(), again.from_member.as_str(), again.team.as_deref()), ("dev-2-2", "fkteam/dev", Some("fkteam")));
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// The refusals, by name; and the name rules.
    #[test]
    fn a_fork_is_refused_for_a_stopped_unknown_or_defless_source_and_names_are_never_clobbered() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-refuse-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("fkref", "Persona.", "queue");
        let def = super::super::registry_get("fkref").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "fkref")), &def, "fkref", "proj", &ws_str, "", "", None, "fkref", "", "").unwrap();
        let err = |live: &[&str], source: &str, as_name: Option<&str>| {
            let live: Vec<String> = live.iter().map(|s| s.to_string()).collect();
            plan_fork(&ws_str, &live, source, as_name).err().unwrap_or_else(|| "NO ERROR".into())
        };
        assert!(err(&["fkref"], "nobody", None).contains("is not an agent this app started"));
        assert!(err(&["shell"], "shell", None).contains("is not an agent this app started"), "a plain window is not ours");
        assert!(err(&[], "fkref", None).contains("is not running"), "a stopped agent is not forked");
        // Names: explicit is refused when taken (live window or an existing home) or invalid.
        assert!(err(&["fkref", "taken"], "fkref", Some("taken")).contains("is taken"));
        std::fs::create_dir_all(agent_home(&ws_str, "stopped-one")).unwrap();
        assert!(err(&["fkref"], "fkref", Some("stopped-one")).contains("is taken"), "a stopped agent's home is not reused");
        assert!(err(&["fkref"], "fkref", Some("bad name")).contains("cannot contain"));
        let ok = plan_fork(&ws_str, &["fkref".to_string()], "fkref", Some("  mine ")).unwrap();
        assert_eq!(ok.name, "mine", "an explicit name is used as given (trimmed)");
        // The default name steps past live windows AND existing homes.
        std::fs::create_dir_all(agent_home(&ws_str, "fkref-2")).unwrap();
        let plan = plan_fork(&ws_str, &["fkref".to_string(), "fkref-3".to_string()], "fkref", None).unwrap();
        assert_eq!(plan.name, "fkref-4");
        // The definition behind the source is gone: refused, never a home copy.
        super::super::registry_delete("fkref").unwrap();
        let gone = err(&["fkref"], "fkref", None);
        assert!(gone.contains("no longer exists") && gone.contains("never copied"), "{gone}");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// A fork of a member of a NESTED team joins the ROOT team (what a join
    /// records) yet still finds the member's definition on restart, because
    /// `from_member` carries the member's team path.
    #[test]
    fn a_fork_of_a_nested_team_member_joins_the_root_and_keeps_the_member_path() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-nested-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("fnbase", "Nested base.", "queue");
        super::super::teams_save(&json!({ "name": "fninner", "description": "", "members": r#"[{"name":"rev","base":"fnbase","role":"review the diff"}]"# })).unwrap();
        super::super::teams_save(&json!({ "name": "fnouter", "description": "", "members": r#"[{"team":"fninner"}]"# })).unwrap();
        let team = super::super::team_get("fnouter").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let f = flat.iter().find(|f| f.member.name.trim() == "rev").unwrap();
        assert_eq!(f.path, "fnouter/fninner");
        let roster: Vec<super::super::teams::RosterEntry> = vec![("rev".into(), "review the diff".into(), f.path.clone())];
        let base = super::super::registry_get("fnbase").unwrap();
        let d = super::super::teams::effective_def(f, base.as_ref(), "rev", &roster).unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "rev")), &d, "rev", "proj", &ws_str, "", "lead", Some(&f.path), "", "rev", "").unwrap();

        let plan = plan_fork(&ws_str, &["rev".to_string()], "rev", None).unwrap();
        assert_eq!((plan.team.as_deref(), plan.from_member.as_str()), (Some("fnouter"), "fnouter/fninner/rev"));
        let recipe = fk_materialize(&plan.request("proj", "lead"), &ws_str);
        assert_eq!((recipe["team"].as_str(), recipe["member"].as_str()), (Some("fnouter"), Some("")));
        fk_save("fnbase", "Nested newer.", "queue");
        assert!(refresh_agent(&ws_str, "proj", "rev-2").unwrap(), "the member is found through the recorded path");
        let prompt = serde_json::from_str::<Value>(&std::fs::read_to_string(agent_home(&ws_str, "rev-2").join("agents").join("rev-2.json")).unwrap()).unwrap()["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Nested newer.") && prompt.contains("Your role: review the diff"), "{prompt}");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-A: a NEW identity is an atomic claim. Two requests that
    /// reach the same candidate — here made to arrive together at a barrier, with
    /// the SAME candidate list — get different names and homes; an explicit name
    /// both ask for goes to exactly one.
    #[test]
    fn two_forks_that_reach_the_same_candidate_get_different_names_and_homes() {
        let ws = std::env::temp_dir().join(format!("tmm-fork-claim-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let race = |candidates: Vec<String>, explicit: bool| {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let handles: Vec<_> = (0..2)
                .map(|_| {
                    let (b, w, c) = (barrier.clone(), ws_str.clone(), candidates.clone());
                    std::thread::spawn(move || {
                        b.wait();
                        claim_first(&w, &|| Ok(vec!["dev".to_string()]), &c, explicit)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect::<Vec<_>>()
        };
        for round in 0..20 {
            let (a, b) = (format!("auto-a{round}-2"), format!("auto-a{round}-3"));
            let got = race(vec![a.clone(), b.clone()], false);
            let mut names: Vec<String> = got.iter().map(|r| r.as_ref().expect("an auto name that collides picks the next").name().to_string()).collect();
            names.sort();
            assert_eq!(names, vec![a.clone(), b.clone()], "round {round}: two different names");
            assert!(agent_home(&ws_str, &a).is_dir() && agent_home(&ws_str, &b).is_dir(), "and two different homes");
            drop(got);

            let mine = format!("explicit-{round}");
            let got = race(vec![mine.clone()], true);
            assert_eq!(got.iter().filter(|r| r.is_ok()).count(), 1, "round {round}: an explicit name goes to exactly one: {got:?}");
            assert!(got.iter().any(|r| r.as_ref().is_err_and(|e| e.contains("is taken"))), "{got:?}");
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-A, the shared entry: a fork's claim and an ORDINARY new
    /// spawn (a hire, a team member, a join) reaching for the same name — at a
    /// barrier, many rounds — never both get it. The fork's claim holds `dev-2`
    /// before any window exists; the hire is handed `dev-3`; an explicit `dev-2`
    /// (what a team spawn passes) is refused, not silently written over.
    #[test]
    fn a_fork_and_an_ordinary_spawn_reaching_for_the_same_name_never_share_it() {
        let ws = std::env::temp_dir().join(format!("tmm-fork-shared-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let live = vec!["dev".to_string()];

        // Deterministic: the fork's claim is HELD (its window is not open yet).
        let fork_claim = claim_home(&ws_str, &|| Ok(live.clone()), None, "dev").unwrap();
        assert_eq!(fork_claim.name(), "dev-2");
        let hire = reserve_name(&ws_str, &|| Ok(live.clone()), &Starting { agent_def: "dev", team: "", member: "" }, None, "dev").unwrap();
        assert_eq!(hire.name(), "dev-3", "an ordinary hire steps past the name a fork holds");
        assert!(reserve_name(&ws_str, &|| Ok(live.clone()), &Starting { agent_def: "dev", team: "", member: "" }, Some("dev-2"), "dev").unwrap_err().contains("being created by another request"), "an explicit team-spawn name is refused");
        assert!(agent_home(&ws_str, "dev-2").is_dir() && !agent_home(&ws_str, "dev-3").exists(), "the hire made no home of the fork's, and the fork wrote none of the hire's");
        // When the fork's launch fails and its (empty) claim is dropped, the name is free again.
        drop(fork_claim);
        assert!(!agent_home(&ws_str, "dev-2").exists(), "an empty claimed home is given back");
        drop(hire);
        let again = reserve_name(&ws_str, &|| Ok(live.clone()), &Starting { agent_def: "dev", team: "", member: "" }, Some("dev-2"), "dev").unwrap();
        assert_eq!(again.name(), "dev-2");
        drop(again);

        // At a barrier, both ways round.
        for round in 0..30 {
            let base = format!("race{round}");
            let live = vec![base.clone()];
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let (b1, w1, l1, n1) = (barrier.clone(), ws_str.clone(), live.clone(), base.clone());
            let (b2, w2, l2, n2) = (barrier, ws_str.clone(), live, base);
            let fork = std::thread::spawn(move || { b1.wait(); claim_home(&w1, &|| Ok(l1.clone()), None, &n1) });
            let hire = std::thread::spawn(move || { b2.wait(); reserve_name(&w2, &|| Ok(l2.clone()), &Starting { agent_def: "", team: "", member: "" }, None, &n2) });
            let (fork, hire) = (fork.join().unwrap().unwrap(), hire.join().unwrap().unwrap());
            assert_ne!(fork.name(), hire.name(), "round {round}: one name, one request");
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-A, cleanup: a failed request gives back only what is
    /// still its own and EMPTY. Material another request wrote into the claimed
    /// directory is never deleted on this one's behalf, and a launch that worked
    /// keeps its home.
    #[test]
    fn a_claim_that_is_dropped_removes_only_an_empty_home_it_made() {
        let ws = std::env::temp_dir().join(format!("tmm-fork-drop-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let live: Vec<String> = Vec::new();
        let written = claim_first(&ws_str, &|| Ok(live.clone()), &["w-2".to_string()], true).unwrap();
        std::fs::write(agent_home(&ws_str, "w-2").join("launch.json"), "{\"someone\":\"else\"}").unwrap();
        std::fs::write(agent_home(&ws_str, "w-2").join("half-written"), "x").unwrap();
        drop(written); // uncommitted, but not empty any more
        assert_eq!(std::fs::read_to_string(agent_home(&ws_str, "w-2").join("launch.json")).unwrap(), "{\"someone\":\"else\"}", "another request's material survives a failed one");
        assert!(agent_home(&ws_str, "w-2").join("half-written").exists());

        let empty = claim_first(&ws_str, &|| Ok(live.clone()), &["w-3".to_string()], true).unwrap();
        assert!(agent_home(&ws_str, "w-3").is_dir());
        drop(empty);
        assert!(!agent_home(&ws_str, "w-3").exists(), "an empty claimed home goes back");

        let mut kept = claim_first(&ws_str, &|| Ok(live.clone()), &["w-4".to_string()], true).unwrap();
        kept.commit();
        drop(kept);
        assert!(agent_home(&ws_str, "w-4").is_dir(), "a launch that worked keeps its home");
        assert!(claim_first(&ws_str, &|| Ok(live.clone()), &["w-4".to_string()], true).unwrap_err().contains("is taken"), "and the name stays taken");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-A: a home that appears AFTER the candidates were chosen is
    /// never overwritten (its bytes stay), and a homes directory that cannot be
    /// inspected is "cannot tell", which refuses — it is never read as free.
    #[test]
    fn a_home_that_appears_after_the_plan_survives_and_an_unreadable_homes_dir_refuses() {
        use std::os::unix::fs::PermissionsExt;
        let ws = std::env::temp_dir().join(format!("tmm-fork-late-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let candidates = vec!["late-2".to_string(), "late-3".to_string()];
        // Between choosing the candidates and claiming, somebody else made late-2.
        let theirs = agent_home(&ws_str, "late-2");
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(theirs.join("launch.json"), "{\"theirs\":true}").unwrap();
        let third = claim_first(&ws_str, &|| Ok(Vec::new()), &candidates, false).unwrap();
        assert_eq!(third.name(), "late-3", "an auto name steps past it");
        assert!(claim_first(&ws_str, &|| Ok(Vec::new()), &["late-2".to_string()], true).unwrap_err().contains("is taken"), "an explicit one is refused");
        assert_eq!(std::fs::read_to_string(theirs.join("launch.json")).unwrap(), "{\"theirs\":true}", "the other home is byte for byte as it was");

        // A homes directory nobody can look into: not free, refused, nothing created.
        let agents = ws.join(".tmm").join("agents");
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = claim_first(&ws_str, &|| Ok(Vec::new()), &["late-4".to_string()], true);
        let denied_auto = claim_first(&ws_str, &|| Ok(Vec::new()), &["late-5".to_string()], false);
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(denied.as_ref().is_err_and(|e| e.contains("cannot tell")), "{denied:?}");
        assert!(denied_auto.as_ref().is_err_and(|e| e.contains("cannot tell")), "an auto name does not read the failure as free either: {denied_auto:?}");
        assert!(!agent_home(&ws_str, "late-4").exists() && !agent_home(&ws_str, "late-5").exists(), "nothing was created");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-B: the source's definition is found by the SOURCE's
    /// identity, the new prompt is written for the NEW name. A pre-#113 recipe names
    /// its definition by its window name only; the registry holds `dev` and no
    /// `dev-2`, and the fork must still work.
    #[test]
    fn a_fork_of_a_pre_113_agent_finds_its_def_by_the_source_name_and_renders_the_new_one() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-old-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("fkold", "Old persona.", "queue");
        let def = super::super::registry_get("fkold").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "fkold")), &def, "fkold", "proj", &ws_str, "", "", None, "fkold", "", "").unwrap();
        // Strip the provenance the way a recipe from before #113 never had it.
        let recipe_path = agent_home(&ws_str, "fkold").join("launch.json");
        let mut recipe: Value = serde_json::from_str(&std::fs::read_to_string(&recipe_path).unwrap()).unwrap();
        for key in ["agent_def", "member", "from_member", "team"] {
            recipe.as_object_mut().unwrap().remove(key);
        }
        std::fs::write(&recipe_path, serde_json::to_string_pretty(&recipe).unwrap()).unwrap();
        assert!(super::super::registry_get("fkold-2").unwrap().is_none(), "the registry has fkold and no fkold-2");

        let plan = plan_fork(&ws_str, &["fkold".to_string()], "fkold", None).expect("a live agent with a valid definition forks");
        assert_eq!((plan.name.as_str(), plan.agent.as_str()), ("fkold-2", "fkold"));
        let recipe = fk_materialize(&plan.request("proj", "lead"), &ws_str);
        assert_eq!(recipe["agent_def"].as_str(), Some("fkold"), "the new recipe follows the registry def");
        let prompt = serde_json::from_str::<Value>(&std::fs::read_to_string(agent_home(&ws_str, "fkold-2").join("agents").join("fkold-2.json")).unwrap()).unwrap()["prompt"].as_str().unwrap().to_string();
        assert!(prompt.contains("Old persona.") && prompt.contains("fkold-2"), "written for its own name: {prompt}");

        super::super::registry_delete("fkold").unwrap();
        let err = plan_fork(&ws_str, &["fkold".to_string()], "fkold", None).err().unwrap();
        assert!(err.contains("no longer exists"), "only a deleted definition refuses: {err}");
        assert!(!agent_home(&ws_str, "fkold-3").exists(), "and a refusal claims nothing");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-C: a fork of a member of a SUB-team keeps the sub-team's
    /// own rules (its description), the enclosing team's brief and the member's role,
    /// while the new root membership is the ONE team section (with the ROOT's
    /// description); restart keeps all of it.
    #[test]
    fn a_nested_fork_keeps_the_sub_teams_rules_and_has_one_team_section() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-rules-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("fgbase", "Rules base.", "queue");
        super::super::teams_save(&json!({ "name": "fgchild", "description": "Review only: never edit files.", "members": r#"[{"name":"rev","base":"fgbase","role":"review the diff"}]"# })).unwrap();
        super::super::teams_save(&json!({ "name": "fgroot", "description": "Ship it quietly.", "members": r#"[{"team":"fgchild","role":"Report to lead."}]"# })).unwrap();
        let team = super::super::team_get("fgroot").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let f = flat.iter().find(|f| f.member.name.trim() == "rev").unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![("rev".into(), "review the diff".into(), f.path.clone())];
        let base = super::super::registry_get("fgbase").unwrap();
        let d = super::super::teams::effective_def(f, base.as_ref(), "rev", &roster).unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "rev")), &d, "rev", "proj", &ws_str, "", "lead", Some(&f.path), "", "rev", "").unwrap();
        let source_prompt = serde_json::from_str::<Value>(&std::fs::read_to_string(agent_home(&ws_str, "rev").join("agents").join("rev.json")).unwrap()).unwrap()["prompt"].as_str().unwrap().to_string();
        assert!(source_prompt.contains("Review only: never edit files."), "the source carries its sub-team rules: {source_prompt}");

        let plan = plan_fork(&ws_str, &["rev".to_string()], "rev", None).unwrap();
        let recipe = fk_materialize(&plan.request("proj", "lead"), &ws_str);
        assert_eq!(recipe["team"].as_str(), Some("fgroot"));
        let prompt_of = || serde_json::from_str::<Value>(&std::fs::read_to_string(agent_home(&ws_str, "rev-2").join("agents").join("rev-2.json")).unwrap()).unwrap()["prompt"].as_str().unwrap().to_string();
        let check = |prompt: &str| {
            assert!(prompt.contains("Review only: never edit files."), "the sub-team's rules survive the fork: {prompt}");
            assert!(prompt.contains("From the enclosing team: Report to lead.") && prompt.contains("Your role: review the diff"), "{prompt}");
            assert_eq!(prompt.matches("## Your team:").count(), 1, "one team section: {prompt}");
            assert_eq!(prompt.matches("Ship it quietly.").count(), 1, "the root's description once, from the new membership: {prompt}");
            assert_eq!(prompt.matches("Review only: never edit files.").count(), 1, "the child's once: {prompt}");
        };
        check(&prompt_of());
        assert!(refresh_agent(&ws_str, "proj", "rev-2").unwrap());
        check(&prompt_of());
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review P1-A: `spawn` cannot be driven without a real tmux and CLI,
    /// so the one thing the claim tests cannot see — that the launcher itself
    /// reserves the name of every NEW spawn, takes a caller's claim as is, and
    /// leaves only a restart's fallback (`resume`) to reuse its own home — is pinned
    /// at the source. Swapping `reserve_name` back for the live-panes `uniquify`
    /// would pass every other test.
    #[test]
    fn the_one_launcher_claims_every_new_identity() {
        let src = include_str!("spawn.rs");
        let spawn_fn = &src[src.find("pub fn spawn(req: &SpawnRequest)").unwrap()..];
        let spawn_fn = &spawn_fn[..spawn_fn.find("\n}\n").unwrap()];
        let names = &spawn_fn[spawn_fn.find("let _identity;").unwrap()..spawn_fn.find("super::agents::valid_name(&window_name)?;").unwrap()];
        assert!(names.contains("(Some(claim), _) =>") && names.contains("claim.name().to_string()"), "a caller's claim is used as is: {names}");
        assert!(names.contains("(None, true) =>") && names.contains("uniquify(&def.name, &taken)"), "only a restart's fallback reuses its own home: {names}");
        assert!(names.contains("(None, false) =>") && names.contains("reserve_name(&workspace, &live_now, &starting, req.window_name.as_deref(), &def.name)?"), "every other new spawn reserves its name: {names}");
        assert!(!names.contains("(None, false) => match"), "no new spawn picks a name by live panes alone");
    }

    /// The recipe as it is on disk, the way `respawn_materialize` reads it inside
    /// its section: `None` when there is none.
    fn on_disk(ws: &str, name: &str) -> Option<Value> {
        std::fs::read_to_string(agent_home(ws, name).join("launch.json")).ok().and_then(|t| serde_json::from_str(&t).ok())
    }

    fn write_recipe(ws: &str, name: &str, json: &str) {
        let home = agent_home(ws, name);
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), json).unwrap();
    }

    /// Board #383 round 3, timing 1: an ordinary spawn that had read the windows
    /// BEFORE a fork finished must not take the fork's home afterwards. The fork
    /// claimed `dev-2`, opened its window, committed and released its reservation;
    /// the late hire decides inside the allocation lock with a FRESH read of the
    /// windows and goes to `dev-3`. The fork's home is byte for byte as it was.
    /// (By its recipe the fork's home is the same agent's, so only liveness keeps
    /// it out of reach — the stale read shown at the end is what the old code did.)
    #[test]
    fn a_late_ordinary_spawn_skips_a_fork_that_has_completed_and_is_running() {
        let ws = std::env::temp_dir().join(format!("tmm-fork-late-hire-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let live = std::sync::Arc::new(std::sync::Mutex::new(vec!["dev".to_string()]));
        let fresh = { let live = live.clone(); move || Ok(live.lock().unwrap().clone()) };
        let hire = Starting { agent_def: "dev", team: "", member: "" };

        let mut fork = claim_home(&ws_str, &fresh, None, "dev").unwrap();
        assert_eq!(fork.name(), "dev-2");
        // The fork materializes, opens its window, and returns.
        write_recipe(&ws_str, "dev-2", r#"{"agent_def":"dev","member":"","team":""}"#);
        std::fs::write(agent_home(&ws_str, "dev-2").join("session.log"), "the fork's conversation").unwrap();
        let before = std::fs::read(agent_home(&ws_str, "dev-2").join("launch.json")).unwrap();
        live.lock().unwrap().push("dev-2".to_string());
        fork.commit();
        drop(fork); // its reservation is released: the name is now handed over to LIVE

        let late = reserve_name(&ws_str, &fresh, &hire, None, "dev").unwrap();
        assert_eq!(late.name(), "dev-3", "the late hire skips the running fork");
        assert_eq!(std::fs::read(agent_home(&ws_str, "dev-2").join("launch.json")).unwrap(), before, "the running fork's recipe is untouched");
        assert_eq!(std::fs::read_to_string(agent_home(&ws_str, "dev-2").join("session.log")).unwrap(), "the fork's conversation");
        // What a snapshot taken before the fork finished would have done:
        let stale = reserve_name(&ws_str, &|| Ok(vec!["dev".to_string()]), &hire, None, "dev").unwrap();
        assert_eq!(stale.name(), "dev-2", "the stale read is the bug: it reuses the running fork's home");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 round 3, timing 2: a team spawn planned `dev-2` for a member
    /// before a fork completed `dev-2`. When its turn comes the explicit name is
    /// REFUSED (the team spawn reports that member), the fork's home and window
    /// are untouched — while a member's OWN stopped slot, named by its recipe, is
    /// still started again.
    #[test]
    fn a_team_member_whose_planned_name_a_fork_took_is_refused_but_its_own_stopped_slot_is_started() {
        let ws = std::env::temp_dir().join(format!("tmm-fork-team-plan-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let member = Starting { agent_def: "", team: "squad", member: "dev" };
        // The fork of a squad member: a joined agent, team root, no member.
        write_recipe(&ws_str, "dev-2", r#"{"agent_def":"","member":"","team":"squad","from_member":"squad/dev"}"#);
        let fork_recipe = std::fs::read(agent_home(&ws_str, "dev-2").join("launch.json")).unwrap();
        let running = || Ok(vec!["lead".to_string(), "dev".to_string(), "dev-2".to_string()]);
        let err = reserve_name(&ws_str, &running, &member, Some("dev-2"), "dev").unwrap_err();
        assert!(err.contains("already running"), "{err}");
        // Even once it is no longer live, it is the fork's home, not this member's.
        let err = reserve_name(&ws_str, &|| Ok(vec!["lead".to_string()]), &member, Some("dev-2"), "dev").unwrap_err();
        assert!(err.contains("another agent's home"), "{err}");
        assert_eq!(std::fs::read(agent_home(&ws_str, "dev-2").join("launch.json")).unwrap(), fork_recipe, "the fork's home is untouched");
        // The member's own stopped slot (recipe: this team, this member) starts again.
        write_recipe(&ws_str, "dev", r#"{"agent_def":"","member":"dev","team":"squad"}"#);
        let own = reserve_name(&ws_str, &|| Ok(vec!["lead".to_string()]), &member, Some("dev"), "dev").unwrap();
        assert_eq!(own.name(), "dev", "a stopped slot named by its recipe is the request's own");
        drop(own);
        // Another team's member with the same name is not.
        let other = Starting { agent_def: "", team: "other", member: "dev" };
        assert!(reserve_name(&ws_str, &|| Ok(Vec::new()), &other, Some("dev"), "dev").unwrap_err().contains("another agent's home"));
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Whose home is it: none is free, the request's own stopped slot is reusable,
    /// everything else — another agent, a directory with no recipe, a plain file —
    /// is someone else's, and a directory that cannot be inspected is refused.
    #[test]
    fn a_home_is_the_requests_own_only_when_its_recipe_says_so() {
        use std::os::unix::fs::PermissionsExt;
        let ws = std::env::temp_dir().join(format!("tmm-own-slot-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let lead = Starting { agent_def: "lead", team: "", member: "" };
        assert_eq!(may_start_in(&ws_str, "lead", &lead), Ok(true), "no home: free");
        write_recipe(&ws_str, "lead", r#"{"agent_def":"lead"}"#);
        assert_eq!(may_start_in(&ws_str, "lead", &lead), Ok(true), "its own stopped slot");
        write_recipe(&ws_str, "other", r#"{"agent_def":"reviewer"}"#);
        assert_eq!(may_start_in(&ws_str, "other", &lead), Ok(false), "another agent's home");
        std::fs::create_dir_all(agent_home(&ws_str, "norecipe")).unwrap();
        assert_eq!(may_start_in(&ws_str, "norecipe", &lead), Ok(false), "a directory with no recipe yet is somebody's in-progress");
        std::fs::write(agent_home(&ws_str, "afile"), "x").unwrap();
        assert_eq!(may_start_in(&ws_str, "afile", &lead), Ok(false), "a plain file");
        let nobody = Starting { agent_def: "", team: "", member: "" };
        assert_eq!(may_start_in(&ws_str, "lead", &nobody), Ok(false), "a request that names nothing owns no slot");
        let agents = ws.join(".tmm").join("agents");
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o000)).unwrap();
        let denied = may_start_in(&ws_str, "lead", &lead);
        std::fs::set_permissions(&agents, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(denied.is_err_and(|e| e.contains("cannot tell")), "an uninspectable home is refused, not free");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 round 3, P2: a failed claim removes its own empty home BEFORE its name
    /// leaves the in-flight set. A second request that reserves the name the moment
    /// it is released must find no old directory about to be removed from under
    /// it: it makes its home and writes into it, and the write survives.
    #[test]
    fn an_old_claims_cleanup_finishes_before_a_new_claim_can_use_the_name() {
        let ws = std::env::temp_dir().join(format!("tmm-claim-order-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let nobody = || Starting { agent_def: "", team: "", member: "" };
        for round in 0..300 {
            let name = format!("order-{round}");
            let old = claim_first(&ws_str, &|| Ok(Vec::new()), &[name.clone()], true).unwrap(); // uncommitted, empty home
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let (b, w, n) = (barrier.clone(), ws_str.clone(), name.clone());
            let newer = std::thread::spawn(move || {
                b.wait();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                loop {
                    assert!(std::time::Instant::now() < deadline, "the claimed name never left the in-flight set");
                    // The same name, as an explicit team-spawn would ask for it.
                    if let Ok(claim) = reserve_name(&w, &|| Ok(Vec::new()), &Starting { agent_def: "", team: "", member: "" }, Some(&n), &n) {
                        let home = agent_home(&w, &n);
                        let made = std::fs::create_dir_all(&home);
                        let wrote = made.and_then(|_| std::fs::write(home.join("launch.json"), "{}"));
                        drop(claim);
                        return wrote;
                    }
                    std::thread::yield_now();
                }
            });
            barrier.wait();
            drop(old);
            newer.join().unwrap().unwrap_or_else(|e| panic!("round {round}: the new claim's home was removed from under it: {e}"));
            assert!(agent_home(&ws_str, &name).join("launch.json").exists(), "round {round}");
        }
        let _ = nobody;
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// The ordering the stress test above can only sample: `give_back` runs the
    /// cleanup while the name is STILL reserved, and releases it afterwards.
    #[test]
    fn a_claimed_name_is_given_back_only_after_its_cleanup() {
        let key = ("ws".to_string(), "dev-2".to_string());
        let mut flight: std::collections::HashSet<(String, String)> = [key.clone()].into_iter().collect();
        let mut seen_reserved = None;
        give_back(&mut flight, &key, |during| seen_reserved = Some(during.contains(&key)));
        assert_eq!(seen_reserved, Some(true), "the cleanup runs while the name is still reserved");
        assert!(!flight.contains(&key), "and the name is released after it");
    }

    /// The validator's live clash (board #383, 1 of 14 attempts): `tmm spawn --team clash`
    /// planned `kiro-2` for a member while `tmm agent fork kiro` reached for `kiro-2`
    /// too, and both got it. Here the same two requests meet at a barrier, many
    /// rounds: the team member's explicit name and the fork's automatic one never
    /// end up the same, whichever wins — the loser is refused (the member is
    /// reported) or steps to the next name, never writes over the other.
    #[test]
    fn a_team_spawn_planning_a_name_and_a_fork_reaching_for_it_never_both_get_it() {
        let ws = std::env::temp_dir().join(format!("tmm-fork-clash-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let (mut member_won, mut fork_won) = (0, 0);
        for round in 0..60 {
            let base = format!("kiro{round}");
            let planned = format!("{base}-2");
            let live = vec![base.clone()];
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let (b1, w1, l1, b_1) = (barrier.clone(), ws_str.clone(), live.clone(), base.clone());
            let (b2, w2, l2, p2) = (barrier, ws_str.clone(), live, planned.clone());
            let fork = std::thread::spawn(move || { b1.wait(); claim_home(&w1, &|| Ok(l1.clone()), None, &b_1) });
            let member = std::thread::spawn(move || {
                b2.wait();
                reserve_name(&w2, &|| Ok(l2.clone()), &Starting { agent_def: "", team: "clash", member: "m3" }, Some(&p2), "m3")
            });
            let (fork, member) = (fork.join().unwrap().unwrap(), member.join().unwrap());
            match member {
                Ok(member) => {
                    member_won += 1;
                    assert_ne!(member.name(), fork.name(), "round {round}: both got {}", fork.name());
                    assert_eq!(fork.name(), format!("{base}-3"), "round {round}: the fork steps past the member's planned name");
                }
                Err(e) => {
                    fork_won += 1;
                    assert_eq!(fork.name(), planned, "round {round}");
                    assert!(e.contains("being created") || e.contains("another agent's home"), "round {round}: {e}");
                }
            }
        }
        eprintln!("clash rounds: member won {member_won}, fork won {fork_won}");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// Board #383 review (P1-A residual): the windows are read inside the
    /// allocation lock, and a read that FAILED was taken for "no windows" — a running
    /// `dev` whose recipe is the request's own looked like a stopped slot, so its
    /// home was rewritten and a second window opened under its name. "No windows" is
    /// an answer only when tmux gives it: an empty list, or tmux saying the session
    /// does not exist. Everything else is "cannot tell".
    #[test]
    fn only_an_answer_from_tmux_is_a_list_of_windows_and_everything_else_is_cannot_tell() {
        assert!(panes_answer(Ok(Vec::new())).unwrap().is_empty(), "an empty list is an answer");
        // The session is not up yet: tmux SAYS so (measured wordings, tmux.rs
        // session_confirmed_absent), and the first spawn is what creates it.
        for absent in [
            "tmux error: can't find session: proj\n",
            "tmux error: no server running on /tmp/x/sock\n",
            "tmux error: error connecting to /tmp/x/sock (No such file or directory)\n",
        ] {
            assert!(panes_answer(Err(absent.to_string())).unwrap().is_empty(), "confirmed absent is empty: {absent}");
        }
        // tmux could not be asked, or answered in words we do not know.
        for unanswered in [
            "tmux error: error connecting to /tmp/x/sock (Permission denied)\n",
            "Failed to run tmux: No such file or directory (os error 2)",
            "tmux error: server exited unexpectedly\n",
            "",
        ] {
            let err = panes_answer(Err(unanswered.to_string())).unwrap_err();
            assert!(err.contains("could not ask tmux which agents are running") && err.contains("nothing was started"), "{unanswered:?}: {err}");
        }
    }

    /// The same, at the three allocation doors: with the read failing, `reserve_name`
    /// (automatic and explicit) and `claim_home` / `claim_first` (automatic and
    /// explicit) refuse with NOTHING reserved and NOTHING on disk — the running
    /// `dev`'s home is byte for byte as it was, no new home appears, and a
    /// workspace never touched is still not there. A read that succeeds and is
    /// empty starts as before.
    #[test]
    fn a_failed_live_read_refuses_every_allocation_and_touches_nothing() {
        let ws = std::env::temp_dir().join(format!("tmm-live-unknown-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        let untouched = std::env::temp_dir().join(format!("tmm-live-unknown-new-{}", uuid::Uuid::new_v4()));
        let untouched_str = untouched.to_string_lossy().to_string();
        // `dev` is running, and its recipe is the one a hire of `dev` would match.
        write_recipe(&ws_str, "dev", r#"{"agent_def":"dev","member":"","team":""}"#);
        std::fs::write(agent_home(&ws_str, "dev").join("session.log"), "the running conversation").unwrap();
        let before = (std::fs::read(agent_home(&ws_str, "dev").join("launch.json")).unwrap(), std::fs::read(agent_home(&ws_str, "dev").join("session.log")).unwrap());
        let homes = || { let mut v: Vec<String> = std::fs::read_dir(ws.join(".tmm").join("agents")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect(); v.sort(); v };

        let unanswered = || -> Result<Vec<String>, String> {
            panes_answer(Err("tmux error: error connecting to /tmp/x/sock (Permission denied)\n".to_string())).map(|_| Vec::new())
        };
        let hire = Starting { agent_def: "dev", team: "", member: "" };
        let refused = |r: Result<Claim, String>, what: &str| {
            let err = r.err().unwrap_or_else(|| format!("{what}: NO ERROR"));
            assert!(err.contains("could not ask tmux which agents are running"), "{what}: {err}");
        };
        refused(reserve_name(&ws_str, &unanswered, &hire, None, "dev"), "automatic hire");
        refused(reserve_name(&ws_str, &unanswered, &hire, Some("dev"), "dev"), "explicit hire of the running name");
        refused(claim_home(&ws_str, &unanswered, None, "dev"), "automatic fork");
        refused(claim_home(&ws_str, &unanswered, Some("dev-2"), "dev"), "explicit fork");
        refused(claim_home(&untouched_str, &unanswered, None, "dev"), "fork in a workspace never used");

        let flight = in_flight();
        for (w, n) in [(&ws_str, "dev"), (&ws_str, "dev-2"), (&untouched_str, "dev-2")] {
            assert!(!flight.contains(&(w.to_string(), n.to_string())), "{n} was reserved on a failed read");
        }
        drop(flight);
        assert_eq!(homes(), vec!["dev".to_string()], "no home was created");
        assert_eq!((std::fs::read(agent_home(&ws_str, "dev").join("launch.json")).unwrap(), std::fs::read(agent_home(&ws_str, "dev").join("session.log")).unwrap()), before, "the running agent's home is byte for byte as it was");
        assert!(!untouched.exists(), "a refused claim does not even create the workspace's .tmm");

        // tmux answered, with nothing running: the same requests start.
        let none = || -> Result<Vec<String>, String> { Ok(Vec::new()) };
        let own = reserve_name(&ws_str, &none, &hire, None, "dev").unwrap();
        assert_eq!(own.name(), "dev", "an empty answer is a stopped slot, its own recipe starts again");
        drop(own);
        let fork = claim_home(&untouched_str, &none, None, "dev").unwrap();
        assert_eq!(fork.name(), "dev-2", "and a fork claims its next name");
        drop(fork);
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&untouched);
    }

    /// A fork reads the windows twice: once to find its source running, again inside
    /// the claim. The second read failing claims nothing — the first one having
    /// answered is no licence for the allocation.
    #[test]
    fn a_fork_whose_allocation_read_fails_claims_nothing() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-fork-read-fails-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("fkread", "Fork persona.", "steer");
        let def = super::super::registry_get("fkread").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "fkread")), &def, "fkread", "proj", &ws_str, "", "lead", None, "fkread", "", "").unwrap();
        let calls = std::cell::Cell::new(0);
        let second_fails = || -> Result<Vec<String>, String> {
            calls.set(calls.get() + 1);
            if calls.get() == 1 { Ok(vec!["fkread".to_string()]) } else { panes_answer(Err("tmux error: error connecting to /tmp/x/sock (Permission denied)\n".to_string())).map(|_| Vec::new()) }
        };
        let err = plan_fork_with(&ws_str, &second_fails, "fkread", None).err().expect("a failed allocation read refuses the fork");
        assert!(err.contains("could not ask tmux which agents are running"), "{err}");
        assert_eq!(calls.get(), 2, "the source check read once, the claim read again");
        assert!(!agent_home(&ws_str, "fkread-2").exists(), "no home was made for the fork");
        assert!(!in_flight().contains(&(ws_str.clone(), "fkread-2".to_string())), "and no name is held");
        // The first read failing refuses the fork too (it cannot tell the source runs).
        let err = plan_fork_with(&ws_str, &|| panes_answer(Err("Failed to run tmux: nope".to_string())).map(|_| Vec::new()), "fkread", None).err().unwrap();
        assert!(err.contains("could not ask tmux"), "{err}");
        let _ = std::fs::remove_dir_all(&ws);
    }

    /// No decision in the launcher reads the windows by swallowing a failure: the
    /// only `list_panes` call in this file's production code is `panes_now`'s, so
    /// the cap, the allocation, a team's plan and a team spawn all go through the
    /// one answer-or-"cannot tell" read.
    #[test]
    fn the_launcher_reads_the_windows_only_through_the_one_honest_read() {
        let src = include_str!("spawn.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("a test module")];
        let calls: Vec<&str> = production.lines().filter(|l| l.contains("list_panes(") && !l.trim_start().starts_with("//")).collect();
        assert_eq!(calls.len(), 1, "one read of the windows: {calls:?}");
        assert!(calls[0].contains("panes_answer(tmux::list_panes(session))"), "{calls:?}");
    }

    /// Board #389 (validator, on #383's SHIP): restarting an agent within ~2 min
    /// of its creation FAILED with "no agent named 'kiro-2' in the registry" and the
    /// agent, whose window the restart had just killed, was gone. The slot is not
    /// in the declaration until the capture loop's 120 s settle rule has passed, so
    /// `up_agent` cannot restore it and the restart falls back to a fresh spawn —
    /// which looked the WINDOW name up in the registry. Only the first agent of a
    /// kind is named like its definition: a fork, a uniquified hire and a team
    /// member never are. The fallback now starts what the window's own recipe says.
    #[test]
    fn a_restart_before_the_slot_settles_starts_what_the_recipe_says_not_a_registry_name() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-respawn-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("rpsolo", "Respawn persona.", "steer");
        let def = super::super::registry_get("rpsolo").unwrap().unwrap();

        // A fork of a solo agent: window "rpsolo-2", definition "rpsolo", started by "lead".
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "rpsolo-2")), &def, "rpsolo-2", "proj", &ws_str, "", "lead", None, "rpsolo", "", "").unwrap();
        // What the fallback used to ask for: the window name, as a registry name.
        let old = spawn(&SpawnRequest { session: "proj", agent: "rpsolo-2", resume: true, ..Default::default() }).unwrap_err();
        assert!(old.contains("no agent named 'rpsolo-2' in the registry"), "the failure the validator saw: {old}");
        let plan = plan_respawn(&ws_str, "rpsolo-2", on_disk(&ws_str, "rpsolo-2").as_ref()).unwrap();
        let req = plan.request("proj");
        assert_eq!((req.agent, req.window_name.as_deref(), req.by, req.resume), ("rpsolo", Some("rpsolo-2"), "lead", true), "its own definition by name, its own window, its own spawner");
        assert!(req.def.is_none() && req.team.is_none() && req.member.is_empty() && req.from_member.is_empty(), "a solo agent stays a registry launch");

        // A solo agent that JOINED a team keeps it.
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "rpjoin")), &def, "rpjoin", "proj", &ws_str, "", "", Some("rpteam"), "rpsolo", "", "").unwrap();
        let plan = plan_respawn(&ws_str, "rpjoin", on_disk(&ws_str, "rpjoin").as_ref()).unwrap();
        assert_eq!((plan.agent.as_str(), plan.team.as_deref(), plan.member.as_str()), ("rpsolo", Some("rpteam"), ""));

        // A team member spawned as "dev-2": the team's definition for it, the member's slot.
        fk_save("rpbase", "Base.", "steer");
        super::super::teams_save(&json!({
            "name": "rpteam",
            "description": "",
            "members": r#"[{"name":"dev","base":"rpbase","role":"implement the change"},{"name":"rev","base":"rpbase","role":"review the diff"}]"#
        }))
        .unwrap();
        let team = super::super::team_get("rpteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![("dev-2".into(), "implement the change".into(), "rpteam".into()), ("rev".into(), "review the diff".into(), "rpteam".into())];
        let base = super::super::registry_get("rpbase").unwrap();
        for (f, w) in flat.iter().zip(["dev-2", "rev"]) {
            let d = super::super::teams::effective_def(f, base.as_ref(), w, &roster).unwrap();
            materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, w)), &d, w, "proj", &ws_str, "", "lead", Some("rpteam"), "", f.member.name.trim(), "").unwrap();
        }
        let plan = plan_respawn(&ws_str, "dev-2", on_disk(&ws_str, "dev-2").as_ref()).unwrap();
        let req = plan.request("proj");
        assert_eq!((req.team.as_deref(), req.member, req.from_member, req.window_name.as_deref(), req.by, req.resume), (Some("rpteam"), "dev", "", Some("dev-2"), "lead", true));
        let d = req.def.expect("a team member is started from its team's definition");
        assert!(d.system.contains("Your role: implement the change"), "the role is applied: {}", d.system);

        // A fork of that member: a joined agent in the team ROOT, the member's definition, no slot.
        let fork_def = fork_member_def("rpteam", "dev", "rpteam-fork").unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "dev-3")), &fork_def, "dev-3", "proj", &ws_str, "", "lead", Some("rpteam"), "", "", "rpteam/dev").unwrap();
        let plan = plan_respawn(&ws_str, "dev-3", on_disk(&ws_str, "dev-3").as_ref()).unwrap();
        let req = plan.request("proj");
        assert_eq!((req.team.as_deref(), req.member, req.from_member, req.window_name.as_deref()), (Some("rpteam"), "", "rpteam/dev", Some("dev-3")));
        assert!(req.def.is_some() && req.agent.is_empty(), "a fork of a member is started from the member's definition, not by a registry name");

        // A pre-#113 recipe names no definition: the window name IS the definition's. No recipe at
        // all has nothing to follow: the same plain lookup as before.
        write_recipe(&ws_str, "rpsolo", r#"{"backend":"kiro","cmd":"x"}"#);
        assert_eq!(plan_respawn(&ws_str, "rpsolo", on_disk(&ws_str, "rpsolo").as_ref()).unwrap().agent, "rpsolo");
        let bare = plan_respawn(&ws_str, "stranger", on_disk(&ws_str, "stranger").as_ref()).unwrap();
        assert_eq!((bare.agent.as_str(), bare.def.is_none(), bare.name.as_str()), ("stranger", true, "stranger"));

        // The definition behind it is gone: refused by name, the home kept, never a different agent.
        super::super::registry_delete("rpsolo").unwrap();
        let gone = plan_respawn(&ws_str, "rpsolo-2", on_disk(&ws_str, "rpsolo-2").as_ref()).err().expect("a deleted definition is not started again");
        assert!(gone.contains("'rpsolo-2'") && gone.contains("no longer exists"), "{gone}");
        assert!(agent_home(&ws_str, "rpsolo-2").join("launch.json").exists(), "its home is kept");

        super::super::registry_delete("rpbase").ok();
        super::super::teams_delete("rpteam").ok();
        std::fs::remove_dir_all(&ws).ok();
    }

    /// The restart's fallback is ONE route: `start_agent` hands the window to
    /// `spawn::respawn`, and nothing else builds a resuming request — in
    /// particular nothing that names a registry definition after a window.
    #[test]
    fn the_restart_fallback_has_one_route_through_the_recipe() {
        let spawn_src = include_str!("spawn.rs");
        let production = &spawn_src[..spawn_src.find("#[cfg(test)]").expect("a test module")];
        assert_eq!(production.matches("resume: true").count(), 1, "one place builds a resuming request (Respawn::request)");
        let hub_src = include_str!("../server/hub_rpc.rs");
        let hub = &hub_src[..hub_src.find("#[cfg(test)]").expect("a test module")];
        assert!(hub.contains("start_agent_with(session, agent, permit, resume_slot, crate::projects::spawn::respawn)"), "start_agent's fallback is respawn");
        assert!(!hub.contains("resume: true"), "the server builds no resuming request of its own");
        // The recipe is read, planned from and written inside ONE hold of its section
        // (#389 review): no section-less reader in between, and the hold ends before tmux.
        let body = &production[production.find("fn respawn_materialize").expect("respawn_materialize")..];
        let body = &body[body.find("{\n").expect("its body")..];
        let body = &body[..body.find("\n}\n").expect("its end")];
        assert!(body.contains("recipe_section(") && body.contains("section.read()") && body.contains("materialize(&section"), "{body}");
        assert!(!body.contains("recipe_provenance(") && !body.contains("launch_window(") && !body.contains("tmux::"), "no read outside the section, no launch inside it: {body}");
    }

    /// Board #389, reviewer P1 (read-before-lock): `respawn` planned from a recipe it
    /// read OUTSIDE the home's section and wrote those values back, so a team move
    /// that committed in between was undone — `team` back to the old team with
    /// `team_rev` / `team_told` still describing the new one. Now the read, the plan
    /// and the write are one hold of the section. Here a mover's commit lands after
    /// the respawn has started and while it waits for the section: the respawn must
    /// take the moved recipe, whichever of the two it would have been before.
    #[test]
    fn a_respawn_waits_for_a_move_that_holds_the_recipe_and_keeps_it() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-respawn-barrier-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("rbbase", "Base.", "steer");
        fk_save("rbsolo", "Solo persona.", "steer");
        super::super::teams_save(&json!({ "name": "rbteam", "description": "Moves.", "members": r#"[{"name":"lead","base":"rbbase","role":"leads"}]"#.to_string() })).unwrap();
        let team = super::super::team_get("rbteam").unwrap().unwrap();
        let flat = super::super::teams::expand(&team, &|n| super::super::team_get(n), SPAWN_CAP).unwrap();
        let base = super::super::registry_get("rbbase").unwrap();
        let roster: Vec<super::super::teams::RosterEntry> = vec![("lead".into(), "leads".into(), "rbteam".into())];
        let d = super::super::teams::effective_def(&flat[0], base.as_ref(), "lead", &roster).unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "lead")), &d, "lead", "proj", &ws_str, "", "", Some("rbteam"), "", "lead", "").unwrap();
        let solo = super::super::registry_get("rbsolo").unwrap().unwrap();
        materialize(&super::super::recipe::recipe_section(&agent_home(&ws_str, "rbsolo-2")), &solo, "rbsolo-2", "proj", &ws_str, "", "human", None, "rbsolo", "", "").unwrap();
        let home = agent_home(&ws_str, "rbsolo-2");

        let hold = super::super::recipe::recipe_section(&home);
        let released = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let respawn = {
            let (w, released) = (ws_str.clone(), released.clone());
            std::thread::spawn(move || {
                let out = respawn_materialize(&w, "proj", "rbsolo-2", &[]);
                (out, released.load(std::sync::atomic::Ordering::SeqCst))
            })
        };
        // The respawn is under way (it read nothing it may use: the section is held)...
        std::thread::sleep(std::time::Duration::from_millis(400));
        // ...and the move commits: the team, a revision, the seeded ledger (what set_agent_team writes).
        super::super::recipe::update_in(&hold, |slot| {
            let recipe = slot.as_mut().expect("a recipe");
            recipe["team"] = json!("rbteam");
            recipe["team_rev"] = json!(1);
            recipe["team_told"] = json!({ "mover": "", "members": {} });
        })
        .unwrap();
        released.store(true, std::sync::atomic::Ordering::SeqCst);
        drop(hold);

        let (out, after_release) = respawn.join().unwrap();
        let (plan, _def, _m) = out.expect("the respawn completes");
        assert!(after_release, "the respawn did not run inside the mover's hold");
        assert_eq!(plan.team.as_deref(), Some("rbteam"), "it planned from the moved recipe, not from one it read before");
        let recipe: Value = serde_json::from_str(&std::fs::read_to_string(home.join("launch.json")).unwrap()).unwrap();
        assert_eq!((recipe["team"].as_str(), recipe["team_rev"].as_u64()), (Some("rbteam"), Some(1)), "the move survives: {recipe}");
        assert_eq!(recipe["team_told"], json!({ "mover": "", "members": {} }), "and its ledger is the one that goes with that team");
        assert_eq!(recipe["spawned_by"], "human");
        super::super::registry_delete("rbsolo").ok();
        super::super::registry_delete("rbbase").ok();
        super::super::teams_delete("rbteam").ok();
        std::fs::remove_dir_all(&ws).ok();
    }

    /// Board #389, reviewer P1 (absent vs unreadable): only a home with NO recipe
    /// (a pre-#113 agent) may be started by its window name. A recipe that exists but
    /// cannot be read — malformed, or not a file we can read — is refused before
    /// anything is rendered or written, and the home is byte for byte as it was:
    /// asking the registry for the window name there would rebuild the agent from
    /// whatever other definition happens to carry that name.
    #[test]
    fn only_a_missing_recipe_falls_back_to_the_window_name_and_an_unreadable_one_refuses() {
        super::super::tests::use_test_store();
        let ws = std::env::temp_dir().join(format!("tmm-respawn-unreadable-{}", uuid::Uuid::new_v4()));
        let ws_str = ws.to_string_lossy().to_string();
        fk_save("ab1", "Legacy persona.", "steer");
        fk_save("bad1", "Another agent's persona.", "steer");
        fk_save("bad2", "Another agent's persona.", "steer");
        // A tree of the home: every path with its bytes, so "untouched" is exact.
        let tree = |name: &str| -> Vec<(String, Option<Vec<u8>>)> {
            fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, Option<Vec<u8>>)>) {
                let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().path()).collect();
                entries.sort();
                for p in entries {
                    let rel = p.strip_prefix(base).unwrap().to_string_lossy().to_string();
                    if p.is_dir() { out.push((rel, None)); walk(&p, base, out); } else { out.push((rel, Some(std::fs::read(&p).unwrap()))); }
                }
            }
            let home = agent_home(&ws_str, name);
            let mut out = Vec::new();
            walk(&home, &home, &mut out);
            out
        };

        // Absent: a pre-#113 home (no recipe at all) is started by its window name, as before.
        std::fs::create_dir_all(agent_home(&ws_str, "ab1")).unwrap();
        let (plan, def, _m) = respawn_materialize(&ws_str, "proj", "ab1", &[]).expect("a home with no recipe falls back to the window name");
        assert_eq!((plan.agent.as_str(), def.name.as_str()), ("ab1", "ab1"));
        assert!(agent_home(&ws_str, "ab1").join("launch.json").exists(), "and it now has a recipe");
        // Absent and no such definition: the plain registry refusal, nothing invented.
        std::fs::create_dir_all(agent_home(&ws_str, "ab2")).unwrap();
        let err = respawn_materialize(&ws_str, "proj", "ab2", &[]).err().expect("no recipe and no definition");
        assert!(err.contains("no agent named 'ab2'"), "{err}");
        assert!(!agent_home(&ws_str, "ab2").join("launch.json").exists());

        // Unreadable: malformed JSON, with a definition of the same name on file.
        write_recipe(&ws_str, "bad1", "{ this is not json");
        let before = tree("bad1");
        let err = respawn_materialize(&ws_str, "proj", "bad1", &[]).err().expect("a recipe that cannot be parsed is not a missing one");
        assert!(err.contains("cannot be started again") && err.contains("not readable") && err.contains("nothing was changed"), "{err}");
        assert_eq!(tree("bad1"), before, "the home is byte for byte as it was");
        // Unreadable: the recipe path is something that cannot be read as a file.
        std::fs::create_dir_all(agent_home(&ws_str, "bad2").join("launch.json")).unwrap();
        let before = tree("bad2");
        let err = respawn_materialize(&ws_str, "proj", "bad2", &[]).err().expect("an I/O error is not a missing recipe");
        assert!(err.contains("cannot be started again") && err.contains("nothing was changed"), "{err}");
        assert_eq!(tree("bad2"), before, "and so is this one");

        for n in ["ab1", "bad1", "bad2"] { super::super::registry_delete(n).ok(); }
        std::fs::remove_dir_all(&ws).ok();
    }
}
