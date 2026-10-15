//! tmm — the agent's hands, and the geek's. CLI front for the tmux-mobile
//! project hub (agents-v2): send/read project chat, report progress, list
//! agents and projects. See docs/exec-plans/agents-v2.md §4.4 and
//! docs/design-docs/features/tmm-cli.md.
//!
//! Design contract (owner-set, load-bearing):
//! - FAIL SOFT, NEVER BLOCK: the server is optional. Connection failures are
//!   one line on stderr and exit code 2 within ~2s. No retries, no hangs — an
//!   agent calling `tmm send` inside a hook or a prompt must never stall.
//! - Tiered exit codes (multica convention): 0 ok, 1 local/tmux failure,
//!   2 network, 3 auth, 4 not found, 5 invalid params / usage.
//! - `--output json` on every read so agents and scripts consume reliably.
//! - Context from env: TMM_PROJECT (tmux session = project id), TMM_AGENT
//!   (window/agent name). Exported by the launcher; overridable by flags.
//! - `tmm task *` is the one subtree that is purely LOCAL (tmux only). It must
//!   keep working when no server is running, because what an agent most often
//!   wants to background is the server itself. It can never exit 2.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::io::Read;
use std::time::Duration;
use tmux_mobile::tasks;
use tokio_tungstenite::tungstenite::Message;

const EXIT_OK: i32 = 0;
const EXIT_ERR: i32 = 1;
const EXIT_NET: i32 = 2;
const EXIT_AUTH: i32 = 3;
const EXIT_NOT_FOUND: i32 = 4;
const EXIT_USAGE: i32 = 5;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const RPC_TIMEOUT: Duration = Duration::from_secs(10);

const USAGE: &str = r#"tmm — talk to the tmux-mobile project hub

USAGE (agent):
  tmm send "@name message"            send a message to one or more recipients
                                      a line to yourself reaches you only from a script whose
                                      shell has exited (nohup/setsid/cron) — never from your
                                      turn or your CLI's own background run (use task --wake)
  tmm send "@name /command [args]"    type a CLI command (e.g. /compact) into a teammate's
                                      pane verbatim, like the composer (@all = everyone else)
  tmm send "@name text" --re <seq|id>  reply quoting a room message: the line carries
                                      [re sender HH:MM: 「its first line」] (tmm log --output json
                                      shows each message's seq and id)
  tmm send <text> --status            record ambient progress in the project room
                    [--image <path|url>]   attach an image by REFERENCE (repeatable);
                                      a local path is resolved by the client
  tmm send "@name text" --in 10m | --at 14:30   schedule it: delivered then as a
                                      "[wake] …" line, like one sent now (you may wake
                                      yourself); prints the resolved time and wake id
  tmm wake list [--all]               pending wakes (this project, or every project)
  tmm wake cancel <id>                cancel one you set (the human may cancel any)
  tmm log [--since <ts>] [--limit N] [-f]   read chat; --since is exclusive, -f follows
                    [--grep <text>]   search the FULL history instead (repeatable = any-match)
                    [--global]        …across EVERY project's room, hits name their room
  tmm spawn <agent> [--brief <text>]  spawn a registry agent into this project
  tmm spawn --team <team> [--brief <text>]  start a configured agent team (all members)
  tmm board [list]                    the project task board (kanban)
  tmm board add "title" [--body <text>] [--image <path|url>] [--assignee <name>]
  tmm board show <id>                 one issue with its note thread
  tmm board take <id>                 claim it: assignee = you, status = doing
  tmm board assign <id> <name|->      hand it to someone else; `-` clears the assignee
  tmm board move <id> <todo|doing|review|done>
  tmm board note <id> <text> [--image <path|url>]  progress/decisions ON the issue

USAGE (local helpers — no server/config access):
  tmm claude-statusline                render Claude Code official statusLine JSON from stdin

USAGE (background tasks — LOCAL tmux only, no server needed, never exits 2):
  tmm task start <name> -- <cmd...>   run <cmd> detached in its own tmux window
                    [--session <s>]   where to put it (default: the session you
                                      are in, else "tmm-tasks")
                    [--replace]       take over a name a live task holds
                    [--wake [@who]]   when it ends by itself, wake @who (default: you)
                                      with its exit code and last lines (not on stop)
  tmm task list                       every task, in every session, + state
  tmm task status <name>              running | exited:<code>  (exit 4 if gone)
  tmm task logs <name> [--limit N] [--grep <text>]   default 50 lines, from the end
  tmm task stop <name> [--keep]       C-c, then TERM, then KILL; prints the last 20 lines
                                      and closes the window (--keep leaves it)
  tmm task rm <name>                  close a finished task's window now
                                      (finished windows are reaped 30 min after they end;
                                      TMM_TASK_TTL_SECS overrides)

USAGE (human or agent — self-management):
  tmm scratch [--kill]                the desktop's scratch terminal session (no project):
                                      ensure it and print its pane target, or kill it
  tmm setup                           choose port, listen address, tmux socket, token, TLS
                                      (config.toml; asked on the first tmm gateway too)
  tmm gateway                         ensure this machine's gateway service is installed and
                                      running (launchd agent / systemd user unit)
  tmm gateway start                   run the gateway in the foreground (what the service runs)
  tmm gateway install [--replace]     install the user service for THIS tmm + config root;
                                      a same-name service that is not ours is refused;
                                      a unit from before board #350 gains KillMode=process
                                      in place (daemon-reload), nothing restarted
  tmm gateway status [--show-token]   service state, the local probe's verdict, address
  tmm gateway restart|uninstall       restart / remove our service (only ours)
  tmm gateway logs [-f]               the service's log
  tmm ui [--open]                     the web UI this machine's gateway serves: its URL, or
                                      why there is none (--open: the default browser)
  tmm agent list                      agents in this project and their states
  tmm agent interrupt <name>          cancel the turn it is running (Escape into its pane)
  tmm agent mode <name> queue|steer   switch a kiro agent's queue/steer mode for this session
                                      (its Ctrl+S; a restart returns to the configured mode)
  tmm agent stop|restart <name>       stop it, or bring it back resuming its conversation
  tmm agent restart --team <team>     align a team with its CURRENT definition: restart who
                                      it still has, start who it gained, stop who it dropped
  tmm agent remove <name>             eject it: stop + forget its slot + delete its home
  tmm project list                    all projects
  tmm project create <path> [--name n] [--session s] [--with-agent {backends}]
  tmm project up <session>            bring a project's tmux session up
  tmm project rename <session> --name "New name"   rename it: the tmux session follows the
                                      name (slugged); the room, board and wakes move with it
  tmm project delete <session>        forget the project and delete its agents' homes
  tmm project down <session>          kill the session, keep the declaration
  tmm project archive <session>       remove from projects (session survives)
  tmm registry list                   centrally-defined agents
  tmm teams list                      configured agent teams (members + roles)
  tmm teams save --name <n> --def '<members json>' [--description <text>]
                                      members: [{"name","base","role"[,"model","effort","input_mode"]} | {"name","role","agent":{…}} | {"team":"<other team>"[,"role"]}]
  tmm teams delete <name>
  tmm registry save --name <n> --backend <{backends}> [--system <text>]
                    [--model m] [--effort low|medium|high|…] [--skills a,b] [--mcp <json>]
                    [--input-mode queue|steer]   a line typed while it is busy waits
                                      (queue, default) or enters the running turn
                                      (steer: kiro, codex only; no receipt, reply may
                                      go to the wrong sender). Applied on restart
  tmm registry delete <name>
  tmm prompt show|path                the app-wide agent instructions (<config>/AGENTS.md),
  tmm prompt set <text> | --file <p>  prepended to EVERY managed agent's system prompt at spawn;
  tmm prompt clear                    a running agent picks a change up on restart
  tmm skills list|delete|refresh <name>   app-managed skill store
  tmm skills save --name <n> --source <abs dir|github url>  (imports the files)
  tmm skills import <url|abs dir>     install EVERYTHING a source contains
                                      (a claude plugin/marketplace url works as-is)
  tmm mcp list|delete <name>          central MCP server defs
  tmm mcp save --name <n> --def '<json>' 

MCP TOOLS (local; config = $TMM_MCP_CONFIG, else .tmm/mcp.json up from cwd).
Progressive: each tier loads only what the last one made you want —
  tmm mcp servers                     1. configured servers (names only)
  tmm mcp tools [<server>]            2. one line per tool: name — description
  tmm mcp schema <server> <tool>      3. ONE tool's full input schema
  tmm mcp call <server> <tool> [key=value ...]   4. call it
                    [--args-json '{...}']        (whole argument object, verbatim)
  tmm mcp add <name> --def '{"command":...}'     add a server NOW (or edit
                                      .tmm/mcp.json); the next call reads it
  Inspector CLI from $TMM_MCP_CLI (default: npx -y @modelcontextprotocol/inspector --cli)

CONTEXT:
  --project <session>   which project (default: $TMM_PROJECT)
  --agent <name>        who is speaking (default: $TMM_AGENT, else "human")
  --server <ws://host:port>  (default: $TMM_SERVER, else config.toml)
  --output json         machine-readable output

EXIT CODES: 0 ok · 1 local/tmux failure · 2 server unreachable · 3 auth
            4 not found · 5 usage
"#;

/// The usage text with the spawnable backends filled in from the ONE list
/// (`SPAWNABLE_BACKENDS`, derived from the Backend enum): the CLI must not
/// advertise five backends while six spawn (tenet 14; kimi, board #224).
fn usage() -> String {
    USAGE.replace("{backends}", &backends_help())
}

fn backends_help() -> String {
    tmux_mobile::projects::agents::SPAWNABLE_BACKENDS.join("|")
}

struct Ctx {
    server: String,
    token: String,
    project: Option<String>,
    agent: Option<String>,
    json: bool,
}

fn fail(code: i32, msg: &str) -> ! {
    eprintln!("tmm: {msg}");
    std::process::exit(code);
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Everything after a bare `--` is a command to be run verbatim, so it must
    // never reach the flag parser — `-- cargo build --release` would otherwise
    // lose its `--release` to `flags`.
    let (head, cmdv) = match args.iter().position(|a| a == "--") {
        Some(i) => (&args[..i], args[i + 1..].to_vec()),
        None => (&args[..], Vec::new()),
    };
    let (flags, mut pos, repeated) = split_flags(head);
    if pos.is_empty() || flags.contains_key("help") {
        print!("{}", usage());
        std::process::exit(if pos.is_empty() { EXIT_USAGE } else { EXIT_OK });
    }

    let json = flags.get("output").cloned().flatten().as_deref() == Some("json");

    // Claude Code's official statusLine command: JSON arrives on stdin and one
    // compact row leaves on stdout. Pure formatting — it must never touch the
    // hub config/socket, and runs often enough that even a 2s timeout is wrong.
    if pos[0] == "claude-statusline" {
        let mut input = String::new();
        if std::io::stdin().read_to_string(&mut input).is_err() {
            std::process::exit(EXIT_ERR);
        }
        if let Some(line) = tmux_mobile::projects::vitals::claude_status_line(&input) {
            println!("{line}");
        }
        return;
    }

    // Local tmux subtree, dispatched before anything else: `Config::load()`
    // below seeds a token / machine id / team defaults into config.toml, and a
    // command that only talks to tmux has no business doing that.
    // `task wake` is the one task verb that talks to the server (board #275).
    if pos[0] == "task" && pos.get(1).map(String::as_str) != Some("wake") {
        cmd_task(&pos[1..], &cmdv, &flags, json);
        return;
    }

    // `mcp servers|tools|call` is the second local subtree: it shells out to
    // the MCP Inspector CLI against the project's .tmm/mcp.json — no server
    // socket, and Config::load() has no business running for it either.
    // (`mcp list|save|delete` — the central registry defs — stay on the RPC
    // path below.)
    if pos[0] == "mcp"
        && matches!(
            pos.get(1).map(String::as_str),
            Some("servers") | Some("tools") | Some("call") | Some("schema") | Some("add")
        )
    {
        cmd_mcp_local(&pos[1..], &flags, json);
        return;
    }

    // `gateway` is local too (board #323): it starts, probes and manages this
    // machine's server rather than talking to one.
    if pos[0] == "gateway" {
        cmd_gateway(&pos[1..], &flags).await;
        return;
    }
    if pos[0] == "ui" {
        cmd_ui(flags.contains_key("open")).await;
        return;
    }
    // `tmm setup` (board #323): before Config::load, which would create
    // config.toml with a token and so make every run look like a second one.
    if pos[0] == "setup" {
        match tmux_mobile::gateway::setup::run_interactive() {
            Ok(tmux_mobile::gateway::setup::FirstRun::Cancelled) => std::process::exit(EXIT_ERR),
            Ok(_) => {}
            Err(e) => fail(EXIT_ERR, &format!("setup: {e}")),
        }
        return;
    }

    let cfg = tmux_mobile::config::Config::load();
    let server = flags
        .get("server")
        .cloned()
        .flatten()
        .or_else(|| std::env::var("TMM_SERVER").ok())
        .unwrap_or_else(|| format!("ws://127.0.0.1:{}", cfg.port));
    let ctx = Ctx {
        server,
        token: std::env::var("TMM_TOKEN").ok().unwrap_or(cfg.token),
        project: flags.get("project").cloned().flatten().or_else(|| std::env::var("TMM_PROJECT").ok()).filter(|s| !s.is_empty()),
        agent: flags.get("agent").cloned().flatten().or_else(|| std::env::var("TMM_AGENT").ok()).filter(|s| !s.is_empty()),
        json,
    };

    let cmd = pos.remove(0);
    match (cmd.as_str(), pos) {
        ("send", rest) => {
            let text = rest.join(" ");
            let is_status = flags.contains_key("status");
            // `--image` may repeat. An image is sent as a REFERENCE (an http(s)
            // URL, or a path on the machine the server runs on) appended as
            // markdown; the client resolves a local path through the file
            // service when it renders. Nothing is ever base64'd into a chat
            // message — the room is a log, not a blob store.
            let images = image_refs(&repeated);
            if text.is_empty() && images.is_empty() {
                fail(EXIT_USAGE, "send needs text: tmm send \"@reviewer 看一下\" [--image shot.png]");
            }
            let body = with_images(&text, &images);
            if !is_status && !has_address(&body) {
                fail(EXIT_USAGE, "send needs a recipient such as @name, @all, or @human; use --status for ambient progress");
            }
            let session = need_project(&ctx);
            let from = ctx.agent.clone().unwrap_or_else(|| "human".into());
            // Later, not now (board #275): a wake, fired by the server.
            let at = flags.get("at").cloned().flatten();
            let within = flags.get("in").cloned().flatten();
            let re = flags.get("re").cloned().flatten().filter(|r| !r.trim().is_empty());
            if flags.contains_key("re") && re.is_none() {
                fail(EXIT_USAGE, "--re needs the quoted message's seq or id (tmm log --output json shows both)");
            }
            if at.is_some() || within.is_some() || flags.contains_key("at") || flags.contains_key("in") {
                if re.is_some() {
                    fail(EXIT_USAGE, "--re quotes a message now; a scheduled wake cannot carry a quote");
                }
                if is_status {
                    fail(EXIT_USAGE, "--status is ambient progress now; it cannot be scheduled");
                }
                let now = chrono::Local::now();
                let due = match (within.as_deref(), at.as_deref()) {
                    (Some(d), None) => parse_in(d).map(|s| now.timestamp() + s),
                    (None, Some(t)) => parse_at(t, now),
                    _ => Err("give one of --in <10m|2h|1h30m> or --at <14:30|2026-09-30 09:00>".into()),
                }
                .unwrap_or_else(|e| fail(EXIT_USAGE, &e));
                let w = rpc(&ctx, "hub_wake_add", json!({ "session": session, "from": from, "body": body, "due": due })).await;
                if ctx.json {
                    println!("{w}");
                } else {
                    println!("✓ wake #{} at {} ({}) — cancel: tmm wake cancel {}", w["id"], local_time(due), until(due - now.timestamp()), w["id"]);
                }
                return;
            }
            // A `/command` goes to the CLI, not its model — the composer's
            // rule, read by the same `address::slash_command` (board #274):
            // typed verbatim through hub_command, no chat stamp.
            // A quoted reply is a message, never a /command (board #290).
            match send_route(&body, &from, !is_status && images.is_empty() && re.is_none()) {
                SendRoute::Post => {}
                SendRoute::ToSelf => fail(EXIT_USAGE, &format!("{from} cannot send a command to itself")),
                SendRoute::Command { to, command } => {
                    // A command aimed at nobody fails loudly (orchestrator
                    // 08:36): a named target must be a managed agent here.
                    if to != "all" {
                        let agents = rpc(&ctx, "hub_agents", json!({ "session": session })).await;
                        if !managed_names(&agents).contains(&to) {
                            fail(EXIT_NOT_FOUND, &format!("no managed agent named '{to}' — a /command goes to an agent's CLI"));
                        }
                    }
                    let r = rpc(&ctx, "hub_command", json!({
                        "session": session, "agent": to, "text": command, "from": from
                    })).await;
                    if ctx.json {
                        println!("{r}");
                    } else {
                        let sent = r["sent"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                        println!("✓ {} → {sent}", command.split_whitespace().next().unwrap_or(&command));
                    }
                    return;
                }
            }
            // A message is never typed back into its sender's pane (the
            // server's skip, which stops a reply looping into its author), so
            // the CLI says so instead of printing ✓ for nobody (board #283:
            // five watcher notices were lost this way). A wake, above, is the
            // one mechanism that reaches its own sender.
            // Whether anyone else gets it is read from the live roster, the
            // same `hub_agents` read a /command target is checked against
            // (#274; orchestrator 14:28): say only what is true.
            //
            // Unless the call is not the agent's turn at all (board #285): a
            // watcher left behind with nohup inherits TMM_AGENT and even
            // TMUX_PANE, so only the process tree tells them apart. Detached,
            // its copy for the agent is exactly what the agent needs, and the
            // server types it (`detached`); a turn talking to itself is
            // refused or noted as before.
            let wants_self = !is_status
                && ctx.agent.as_deref().is_some_and(|me| me != "human")
                && (names_self(&body, ctx.agent.as_deref()) || tmux_mobile::address::mention_names(&body).iter().any(|n| n == "all"));
            let detached = wants_self && !from_own_pane(ctx.agent.as_deref().unwrap_or_default());
            if !detached && !is_status && names_self(&body, ctx.agent.as_deref()) {
                let me = ctx.agent.as_deref().unwrap_or_default();
                let names = tmux_mobile::address::mention_names(&body);
                let peers = if names.iter().all(|n| n == me) {
                    Vec::new()
                } else {
                    managed_names(&rpc(&ctx, "hub_agents", json!({ "session": session })).await)
                };
                let (reached, unknown) = others(&names, me, &peers);
                let unknown = if unknown.is_empty() { String::new() } else { format!(" (no managed agent named {})", unknown.join(", ")) };
                if !reached {
                    fail(EXIT_USAGE, &format!(
                        "a message to yourself is never typed into your own pane, and it names no one else here{unknown}; \
                         to be woken use tmm send \"@{from} …\" --in 10s (a wake reaches you) or \
                         tmm task start <name> --wake -- <cmd>"
                    ));
                }
                eprintln!("note: your own copy (@{from}) is not typed into your pane{unknown}");
            }
            let r = rpc(&ctx, "hub_post", json!({
                "session": session, "from": from, "body": body, "status": is_status, "detached": detached,
                "re": re
            })).await;
            if ctx.json {
                println!("{r}");
            } else {
                println!("✓ sent");
            }
            // A mention no pane received is SAID where the sender is looking
            // (board #347): the room keeps the line for the feed and for a
            // Team agent's next context, and this is the immediate word for
            // whoever typed the command. Not an error: the message IS in the
            // room, and nothing is queued for the absent agent — exit 0 with
            // a note, like the self-mention note above.
            say_offline(&r);
        }
        // The scratch terminal's session (board #324): the same server entry
        // the desktop panel uses, so an agent can open a scratch shell for a
        // person. It belongs to no project, so no --project is needed.
        ("scratch", _) => {
            let kill = flags.contains_key("kill");
            let r = rpc(&ctx, if kill { "scratch_kill" } else { "scratch_session" }, json!({})).await;
            if ctx.json {
                println!("{r}");
            } else if kill {
                println!("{}", if r["killed"].as_bool() == Some(true) { "✓ scratch session killed" } else { "no scratch session" });
            } else {
                println!("{}", r["target"].as_str().unwrap_or(""));
            }
        }
        ("log", _) => {
            let session = need_project(&ctx);
            let since = flags.get("since").cloned().flatten().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
            let limit = flags.get("limit").cloned().flatten().and_then(|s| s.parse::<i64>().ok()).unwrap_or(100);
            // `--grep` is repeatable — a term LIST, any-match — and turns the
            // read into a search over the room's FULL history (paging cursors
            // don't apply). `--global` widens it to every project's room.
            let terms: Vec<String> = repeated
                .iter()
                .filter(|(k, _)| k == "grep")
                .map(|(_, v)| v.clone())
                .collect();
            let global = flags.contains_key("global");
            if !terms.is_empty() {
                if flags.contains_key("f") || flags.contains_key("follow") {
                    fail(EXIT_USAGE, "--grep searches history; it does not combine with -f");
                }
                let limit = flags.get("limit").cloned().flatten().and_then(|s| s.parse::<i64>().ok()).unwrap_or(50);
                let r = rpc(&ctx, "hub_search", json!({ "session": session, "grep": terms, "global": global, "limit": limit })).await;
                print_log_with_rooms(&ctx, &r, global);
            } else if global {
                fail(EXIT_USAGE, "--global needs --grep: tmm log --grep \"deploy\" --global");
            } else if flags.contains_key("f") || flags.contains_key("follow") {
                follow_log(&ctx, &session, since, limit).await;
            } else {
                let r = rpc(&ctx, "hub_log", json!({ "session": session, "since_ts": since, "limit": limit })).await;
                print_log(&ctx, &r);
            }
        }
        // The project task board: the human writes issues on the board page,
        // agents keep their status current here. Identity = the caller
        // (TMM_AGENT, else "human"), same as chat.
        // A `--wake` task ended (board #275): run by its pane-died hook, with
        // the project and the starter in the environment. Schedules a wake due
        // now; fail-soft (the hook discards output, the exit is in task list).
        ("task", rest) => {
            let name = rest.get(1).cloned().unwrap_or_default();
            let Some(to) = flags.get("to").cloned().flatten() else { fail(EXIT_USAGE, "task wake <name> --to <who>") };
            let session = need_project(&ctx);
            let from = ctx.agent.clone().unwrap_or_else(|| "human".into());
            let code = flags.get("code").cloned().flatten().unwrap_or_default();
            let signal = flags.get("signal").cloned().flatten().unwrap_or_default();
            let task = tasks::find(&name);
            let age = task.as_ref().and_then(|t| t.age(tasks::unix_now()));
            let tail = tasks::logs(&name, WAKE_TAIL_LINES, None).unwrap_or_default();
            let body = task_end_body(&to, &name, &code, &signal, age, &tail);
            let due = chrono::Local::now().timestamp();
            match try_rpc(&ctx, "hub_wake_add", json!({ "session": session, "from": from, "body": body, "due": due })).await {
                Ok(w) => println!("✓ wake #{} for @{to}", w["id"]),
                // Fail-soft and VISIBLE (orchestrator 09:33): recorded on the
                // task, said by `tmm task status|list|logs`; exit 0, no retry.
                Err((_, e)) => {
                    let why = format!("@{to} was not woken ({})", e.lines().next().unwrap_or(""));
                    let _ = tasks::note_wake_failure(&name, &why);
                    eprintln!("tmm: task {name} ended but {why}");
                }
            }
        }
        // Scheduled wakes (board #275): list and cancel; `send --in/--at` adds.
        ("wake", rest) => {
            let session = need_project(&ctx);
            let who = ctx.agent.clone().unwrap_or_else(|| "human".into());
            match rest.first().map(String::as_str).unwrap_or("list") {
                "list" => {
                    let all = flags.contains_key("all");
                    let r = rpc(&ctx, "hub_wake_list", json!({ "session": session, "all": all })).await;
                    if ctx.json {
                        println!("{r}");
                        return;
                    }
                    let rows = r["wakes"].as_array().cloned().unwrap_or_default();
                    if rows.is_empty() {
                        println!("no pending wakes");
                    }
                    let now = chrono::Local::now().timestamp();
                    for w in rows {
                        let due = w["due_at"].as_i64().unwrap_or(0);
                        let body: String = w["body"].as_str().unwrap_or("").chars().take(60).collect();
                        let place = if all { format!("{} ", w["session"].as_str().unwrap_or("")) } else { String::new() };
                        println!("#{:<4} {} ({:>7})  {place}{}: {body}", w["id"], local_time(due), until(due - now), w["sender"].as_str().unwrap_or(""));
                    }
                }
                "cancel" => {
                    let Some(id) = rest.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok()) else {
                        fail(EXIT_USAGE, "wake cancel <id>  (the id from tmm wake list)");
                    };
                    let r = rpc(&ctx, "hub_wake_cancel", json!({ "session": session, "id": id, "by": who })).await;
                    if ctx.json { println!("{r}") } else { println!("✓ cancelled wake #{id}") }
                }
                other => fail(EXIT_USAGE, &format!("unknown wake verb '{other}': list | cancel <id>")),
            }
        }
        ("board", rest) => {
            let session = need_project(&ctx);
            let who = ctx.agent.clone().unwrap_or_else(|| "human".into());
            let sub = rest.first().map(String::as_str).unwrap_or("list");
            match sub {
                "list" => {
                    let r = rpc(&ctx, "hub_board_list", json!({ "session": session })).await;
                    if ctx.json { println!("{r}"); return; }
                    let empty = Vec::new();
                    let issues = r.get("issues").and_then(|v| v.as_array()).unwrap_or(&empty);
                    if issues.is_empty() {
                        println!("board is empty — tmm board add \"title\" [--body ...]");
                        return;
                    }
                    for status in ["todo", "doing", "review", "done"] {
                        let col: Vec<_> = issues.iter().filter(|i| i.get("status").and_then(|v| v.as_str()) == Some(status)).collect();
                        if col.is_empty() { continue; }
                        println!("── {status} ──");
                        for i in col {
                            let g = |k: &str| i.get(k).and_then(|v| v.as_str()).unwrap_or("");
                            let id = i.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                            let notes = i.get("notes").and_then(|v| v.as_i64()).unwrap_or(0);
                            let assignee = if g("assignee").is_empty() { String::new() } else { format!(" @{}", g("assignee")) };
                            let n = if notes > 0 { format!(" [{notes} notes]") } else { String::new() };
                            // A titleless issue is still NAMED (board #31):
                            // the same title → body → #id fallback every
                            // notice speaks.
                            println!("  #{id} {}{assignee}{n}", tmux_mobile::projects::issue_ref(g("title"), g("body"), id));
                        }
                    }
                }
                "show" => {
                    let Some(id) = rest.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok()) else {
                        fail(EXIT_USAGE, "board show needs an issue id: tmm board show 3");
                    };
                    let r = rpc(&ctx, "hub_board_get", json!({ "session": session, "id": id })).await;
                    if ctx.json { println!("{r}"); return; }
                    let g = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    println!("#{} [{}] {}", id, g("status"), tmux_mobile::projects::issue_ref(g("title"), g("body"), id));
                    if !g("assignee").is_empty() { println!("assignee: {}", g("assignee")); }
                    if !g("created_by").is_empty() { println!("opened by: {}", g("created_by")); }
                    if !g("body").is_empty() { println!("\n{}\n", g("body")); }
                    let empty = Vec::new();
                    for n in r.get("notes").and_then(|v| v.as_array()).unwrap_or(&empty) {
                        let a = n.get("author").and_then(|v| v.as_str()).unwrap_or("");
                        let b = n.get("body").and_then(|v| v.as_str()).unwrap_or("");
                        println!("  · {a}: {b}");
                    }
                }
                "add" => {
                    // The title is OPTIONAL (board #31): `tmm board add --body "…"`
                    // files a body-only issue. Something must be said, though.
                    let title = rest[1..].iter().filter(|a| !a.starts_with("--")).cloned().collect::<Vec<_>>().join(" ");
                    let images = image_refs(&repeated);
                    let given = match flags.get("body") { Some(Some(b)) => b.clone(), _ => String::new() };
                    // An image is a body too (board #329): its ref, like tmm send's.
                    let body = with_images(&given, &images);
                    if title.trim().is_empty() && body.trim().is_empty() {
                        fail(EXIT_USAGE, "board add needs a title or a --body: tmm board add \"fix the login flow\" [--body <text>] [--image <path|url>] [--assignee <name>]");
                    }
                    let mut params = json!({ "session": session, "title": title, "who": who });
                    if !body.is_empty() { params["body"] = json!(body); }
                    // An issue filed WITH an assignee hands it over at birth,
                    // like the page's create dialog (board #377): the save
                    // asks the server to tell the agent, and refuses before
                    // writing when this server cannot.
                    let assignee = match flags.get("assignee") { Some(Some(a)) => Some(assign_target(a).to_string()), _ => None };
                    let r = if let Some(a) = &assignee {
                        params["assignee"] = json!(a);
                        params["dispatch"] = json!(true);
                        rpc_needing(&ctx, "board_dispatch", "hub_board_save", params).await
                    } else {
                        rpc(&ctx, "hub_board_save", params).await
                    };
                    let id = r.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                    if ctx.json { println!("{r}"); } else { println!("✓ #{id} on the board"); }
                    if let Some(a) = assignee { settle_dispatch(id, &a, &r); }
                }
                "delete" => {
                    let Some(id) = rest.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok()) else {
                        fail(EXIT_USAGE, "board delete needs an issue id: tmm board delete 3");
                    };
                    let r = rpc(&ctx, "hub_board_delete", json!({ "session": session, "id": id })).await;
                    if ctx.json { println!("{r}"); } else { println!("✓ deleted #{id}"); }
                }
                // Handing an issue to SOMEONE ELSE (board #367). `take` is
                // the self-claim and `add --assignee` is assignment at
                // birth; between them there was no way to move an open
                // issue to another agent, which the UI has always been able
                // to do (non-negotiable 14). The SAME save as that UI: the
                // server hands the issue over (board #377), so the room
                // record and the @message that wakes the agent are the same
                // whichever surface asked, and this verb carries no brief
                // of its own.
                "assign" => {
                    let Some(id) = rest.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok()) else {
                        fail(EXIT_USAGE, "board assign needs an issue id and a name: tmm board assign 3 builder  (`-` clears the assignee)");
                    };
                    let Some(raw) = rest.get(2) else {
                        fail(EXIT_USAGE, "board assign needs a name: tmm board assign 3 builder  (`-` clears the assignee)");
                    };
                    let name = assign_target(raw);
                    // The issue is read FIRST: a wrong id must fail here,
                    // before anything is written, and a clear can say who
                    // had it.
                    let issue = rpc(&ctx, "hub_board_get", json!({ "session": session, "id": id })).await;
                    let was = issue.get("assignee").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    // A name is checked at the door, like `tmm send`'s: an
                    // assignment to a typo is an issue nobody is doing, and
                    // it would look exactly like a success.
                    if !name.is_empty() && name != "human" {
                        let peers = managed_names(&rpc(&ctx, "hub_agents", json!({ "session": session })).await);
                        if !peers.contains(&name.to_string()) {
                            fail(EXIT_USAGE, &format!(
                                "no managed agent named {name} in this project (tmm agent list); \
                                 assign to one of those, to human, or `-` to clear"
                            ));
                        }
                    }
                    // ONE request saves the assignee AND asks the server to
                    // tell the agent (`dispatch: true`). The save is
                    // committed first, so how the telling went is read from
                    // the ANSWER (`settle_dispatch`), not from an error. A
                    // lost answer leaves it unknown which half ran, and the
                    // recovery is the same either way: naming the assignee
                    // again saves the same value and sends the hand-off
                    // again (it may duplicate it; `tmm log --grep "board
                    // #N"` shows whether it was posted).
                    let r = rpc_needing(&ctx, "board_dispatch", "hub_board_save", json!({
                        "session": session, "id": id, "assignee": name, "who": who, "dispatch": true
                    })).await;
                    if ctx.json {
                        println!("{r}");
                    } else if name.is_empty() {
                        let was = if was.is_empty() { " (it had none)".to_string() } else { format!(" (was {was})") };
                        println!("✓ #{id} unassigned{was}");
                    } else {
                        println!("✓ #{id} → {name}");
                    }
                    settle_dispatch(id, name, &r);
                }
                "take" | "move" | "note" => {
                    let Some(id) = rest.get(1).and_then(|s| s.trim_start_matches('#').parse::<i64>().ok()) else {
                        fail(EXIT_USAGE, "board {take|move|note} needs an issue id first: tmm board move 3 review");
                    };
                    let r = match sub {
                        // take = claim it and start: assignee + doing in one move.
                        "take" => rpc(&ctx, "hub_board_save", json!({ "session": session, "id": id, "assignee": who, "status": "doing", "who": who })).await,
                        "move" => {
                            let Some(status) = rest.get(2).cloned() else {
                                fail(EXIT_USAGE, "board move needs a status: tmm board move 3 todo|doing|review|done");
                            };
                            rpc(&ctx, "hub_board_save", json!({ "session": session, "id": id, "status": status, "who": who })).await
                        }
                        _ => {
                            let text = with_images(&rest[2..].join(" "), &image_refs(&repeated));
                            if text.trim().is_empty() {
                                fail(EXIT_USAGE, "board note needs text or an image: tmm board note 3 \"blocked on the schema question\" [--image shot.png]");
                            }
                            rpc(&ctx, "hub_board_note", json!({ "session": session, "id": id, "body": text, "who": who })).await
                        }
                    };
                    if ctx.json { println!("{r}"); } else { println!("✓ #{id}"); }
                }
                other => fail(EXIT_USAGE, &format!("unknown board command '{other}': tmm board [list|show|add|take|assign|move|note|delete]")),
            }
        }
        ("spawn", _) if flags.get("team").cloned().flatten().is_some() => {
            let session = need_project(&ctx);
            let team = flags.get("team").cloned().flatten().unwrap_or_default();
            let brief = flags.get("brief").cloned().flatten().unwrap_or_default();
            let by = ctx.agent.clone().unwrap_or_default();
            let r = rpc(&ctx, "hub_spawn_team", json!({ "session": session, "team": team, "brief": brief, "by": by })).await;
            if ctx.json {
                println!("{r}");
            } else {
                let empty = Vec::new();
                for m in r.get("spawned").and_then(|v| v.as_array()).unwrap_or(&empty) {
                    println!("✓ spawned {} (team {team})", m.get("window_name").and_then(|v| v.as_str()).unwrap_or(""));
                }
                for e in r.get("errors").and_then(|v| v.as_array()).unwrap_or(&empty) {
                    eprintln!("✗ {}: {}", e.get("name").and_then(|v| v.as_str()).unwrap_or(""), e.get("error").and_then(|v| v.as_str()).unwrap_or(""));
                }
            }
        }
        ("teams", rest) if rest.first().map(String::as_str) == Some("list") => {
            let r = rpc(&ctx, "teams_list", json!({})).await;
            if ctx.json {
                println!("{r}");
            } else {
                let empty = Vec::new();
                for t in r.get("teams").and_then(|v| v.as_array()).unwrap_or(&empty) {
                    let s = |k: &str| t.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    let members: Vec<serde_json::Value> = serde_json::from_str(s("members")).unwrap_or_default();
                    let names: Vec<String> = members
                        .iter()
                        .map(|m| {
                            let n = m.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let base = m.get("base").and_then(|v| v.as_str()).unwrap_or("");
                            let model = m.get("model").and_then(|v| v.as_str()).unwrap_or("");
                            let sub = m.get("team").and_then(|v| v.as_str()).unwrap_or("");
                            if !sub.is_empty() { return format!("+{sub}"); }
                            match (base.is_empty(), model.is_empty()) {
                                (true, _) => n.to_string(),
                                (false, true) => format!("{n}←{base}"),
                                (false, false) => format!("{n}←{base}({model})"),
                            }
                        })
                        .collect();
                    println!("{} — {} [{}]", s("name"), s("description"), names.join(", "));
                }
            }
        }
        ("teams", rest) if rest.first().map(String::as_str) == Some("save") => {
            let Some(name) = flags.get("name").cloned().flatten() else {
                fail(EXIT_USAGE, "teams save needs --name <team> --def '<members json>'");
            };
            let Some(members) = flags.get("def").cloned().flatten() else {
                fail(EXIT_USAGE, "teams save needs --def '<members json>' (an array of {name, base, role} / {name, role, agent})");
            };
            if serde_json::from_str::<serde_json::Value>(&members).is_err() {
                fail(EXIT_USAGE, "--def must be valid JSON");
            }
            let description = flags.get("description").cloned().flatten().unwrap_or_default();
            let r = rpc(&ctx, "teams_save", json!({ "def": { "name": name, "description": description, "members": members } })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ saved team {name} ({} members)", r.get("members").and_then(|v| v.as_u64()).unwrap_or(0)); }
        }
        ("teams", rest) if rest.first().map(String::as_str) == Some("delete") => {
            let Some(name) = rest.get(1).cloned() else {
                fail(EXIT_USAGE, "teams delete needs a team name");
            };
            let r = rpc(&ctx, "teams_delete", json!({ "name": name })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ deleted team {name}"); }
        }
        ("spawn", rest) => {
            let session = need_project(&ctx);
            let Some(agent) = rest.first().cloned() else {
                fail(EXIT_USAGE, "spawn needs a registry agent name: tmm spawn codex --brief \"...\"");
            };
            let brief = flags.get("brief").cloned().flatten().unwrap_or_default();
            let by = ctx.agent.clone().unwrap_or_default();
            let r = rpc(&ctx, "hub_spawn", json!({ "session": session, "agent": agent, "brief": brief, "by": by })).await;
            if ctx.json {
                println!("{r}");
            } else {
                let win = r.get("window_name").and_then(|v| v.as_str()).unwrap_or(&agent);
                println!("✓ spawned {win}");
            }
        }
        ("registry", rest) if rest.first().map(String::as_str) == Some("list") => {
            let r = rpc(&ctx, "registry_list", json!({})).await;
            if ctx.json {
                println!("{r}");
            } else {
                let empty = Vec::new();
                for a in r.get("agents").and_then(|v| v.as_array()).unwrap_or(&empty) {
                    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    println!("{} [{}] — {}", s("name"), s("backend"), s("system").chars().take(60).collect::<String>());
                }
            }
        }
        ("agent", rest) if rest.first().map(String::as_str) == Some("list") => {
            let session = need_project(&ctx);
            let r = rpc(&ctx, "hub_agents", json!({ "session": session })).await;
            if ctx.json {
                println!("{r}");
            } else {
                let empty = Vec::new();
                let rows = r.get("agents").and_then(|a| a.as_array()).unwrap_or(&empty);
                for a in rows {
                    let s = |k: &str| a.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    let w = a.get("window").and_then(|v| v.as_u64()).unwrap_or(0);
                    let agent = a.get("agent").and_then(|v| v.as_str());
                    let detail = s("detail");
                    let tail = if detail.is_empty() { String::new() } else { format!(" — {detail}") };
                    match agent {
                        Some(b) => println!("{w}: {} [{b}] {}{tail}", s("name"), s("state")),
                        None => println!("{w}: {} (shell)", s("name")),
                    }
                }
            }
        }
        // Everything the chat UI can do to ONE agent, so an agent can do it too
        // (owner: parity between the buttons and the CLI). `remove` is the
        // eject button — stop + forget the slot + delete the isolated home.
        // Board #286: a TEAM restart is one server step, aligned with the
        // current definition — the same verb the team name's menu runs.
        ("agent", rest) if rest.first().map(String::as_str) == Some("restart") && flags.get("team").cloned().flatten().is_some() => {
            let session = need_project(&ctx);
            let team = flags.get("team").cloned().flatten().unwrap_or_default();
            let r = rpc(&ctx, "hub_team_restart", json!({ "session": session, "team": team })).await;
            if ctx.json {
                println!("{r}");
            } else {
                let list = |k: &str| r[k].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                for (k, verb) in [("restarted", "restarted"), ("spawned", "started (new)"), ("stopped", "stopped (left the team)")] {
                    if !list(k).is_empty() {
                        println!("✓ {verb}: {}", list(k));
                    }
                }
                let errors = r["errors"].as_array().cloned().unwrap_or_default();
                for e in &errors {
                    eprintln!("tmm: {}: {}", e["name"].as_str().unwrap_or("?"), e["error"].as_str().unwrap_or("?"));
                }
                if !errors.is_empty() {
                    std::process::exit(1);
                }
            }
        }
        ("agent", rest)
            if matches!(rest.first().map(String::as_str), Some("stop" | "restart" | "remove" | "interrupt")) =>
        {
            let action = rest[0].clone();
            let session = need_project(&ctx);
            let Some(name) = rest.get(1).cloned() else {
                fail(EXIT_USAGE, &format!("agent {action} needs a name: tmm agent {action} <name>"));
            };
            let method = match action.as_str() {
                "stop" => "hub_agent_stop",
                "restart" => "hub_agent_restart",
                "remove" => "hub_agent_remove",
                _ => "hub_agent_interrupt",
            };
            let r = rpc(&ctx, method, json!({ "session": session, "agent": name })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ {action} {name}"); }
        }
        // Board #271: queue/steer for THIS session, the card menu's verb.
        ("agent", rest) if rest.first().map(String::as_str) == Some("mode") => {
            let session = need_project(&ctx);
            let (Some(name), Some(mode)) = (rest.get(1).cloned(), rest.get(2).cloned()) else {
                fail(EXIT_USAGE, "agent mode needs a name and a mode: tmm agent mode <name> queue|steer");
            };
            if !matches!(mode.as_str(), "queue" | "steer") {
                fail(EXIT_USAGE, "agent mode is queue or steer: tmm agent mode <name> queue|steer");
            }
            let r = rpc(&ctx, "hub_agent_input_mode", json!({ "session": session, "agent": name, "mode": mode })).await;
            if ctx.json {
                println!("{r}");
            } else if r.get("changed").and_then(|v| v.as_bool()) == Some(false) {
                println!("✓ {name} already runs {mode} mode");
            } else {
                println!("✓ {name} → {mode} mode (this session; a restart returns to its configured mode)");
            }
        }
        ("project", rest) if rest.first().map(String::as_str) == Some("list") => {
            let r = rpc(&ctx, "project_list", json!({})).await;
            if ctx.json {
                println!("{r}");
            } else {
                let empty = Vec::new();
                let rows = r.get("projects").and_then(|a| a.as_array()).unwrap_or(&empty);
                for p in rows {
                    let live = p.get("live").and_then(|v| v.as_bool()).unwrap_or(false);
                    let proj = p.get("project").cloned().unwrap_or(Value::Null);
                    let s = |k: &str| proj.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    println!("{} {} ({})", if live { "●" } else { "○" }, s("session"), s("path"));
                }
            }
        }
        // ---- self-management: the app manages itself through the same CLI
        // its agents use. An agent already holds a shell (it can run tmux or
        // edit files directly), so these commands ADD no authority — they
        // turn abilities it already has into a first-class, documented
        // interface.
        ("project", rest) if rest.first().map(String::as_str) == Some("create") => {
            let Some(path) = rest.get(1).cloned() else {
                fail(EXIT_USAGE, &format!("project create needs a path: tmm project create /path/to/dir [--name n] [--session s] [--with-agent {}]", backends_help()));
            };
            let mut params = json!({ "path": path });
            for (flag, key) in [("name", "name"), ("session", "session"), ("with-agent", "agent")] {
                if let Some(Some(v)) = flags.get(flag) {
                    params[key] = json!(v);
                }
            }
            let r = rpc(&ctx, "project_create", params).await;
            if ctx.json {
                println!("{r}");
            } else {
                let proj = r.get("project").unwrap_or(&r);
                println!("✓ project {} (id {})",
                    proj.get("session").and_then(|v| v.as_str()).unwrap_or("?"),
                    proj.get("id").and_then(|v| v.as_str()).unwrap_or("?"));
            }
        }
        ("project", rest) if rest.first().map(String::as_str) == Some("rename") => {
            // Renames the project: the tmux session follows the name (slugged,
            // since 2026-08-19, board #278). The room is recorded on the
            // project and stays; the board and wakes move with the session,
            // and the old name keeps resolving for agents started under it.
            let Some(name) = rest.get(1).cloned() else {
                fail(EXIT_USAGE, "project rename needs a session and a new name: tmm project rename <session> --name \"New name\"");
            };
            let Some(Some(new_name)) = flags.get("name").cloned() else {
                fail(EXIT_USAGE, "project rename needs --name: tmm project rename <session> --name \"New name\"");
            };
            let id = resolve_project_id(&ctx, &name).await;
            let r = rpc(&ctx, "project_rename", json!({ "id": id, "name": new_name })).await;
            if ctx.json {
                println!("{r}");
            } else {
                // The session is what `--project` and TMM_PROJECT name: say it.
                let session = r["session"].as_str().unwrap_or(&name);
                println!("✓ renamed {name} → {new_name} (session {session})");
            }
        }
        ("project", rest) if matches!(rest.first().map(String::as_str), Some("up" | "down" | "archive" | "delete")) => {
            let action = rest[0].clone();
            let Some(name) = rest.get(1).cloned() else {
                fail(EXIT_USAGE, &format!("project {action} needs a session name: tmm project {action} <session>"));
            };
            let id = resolve_project_id(&ctx, &name).await;
            let method = match action.as_str() {
                "up" => "project_up",
                "down" => "project_down",
                "delete" => "project_delete",
                _ => "project_archive",
            };
            let r = rpc(&ctx, method, json!({ "id": id })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ {action} {name}"); }
        }
        ("registry", rest) if rest.first().map(String::as_str) == Some("save") => {
            // Self-evolution: an agent can define NEW agents (or refine
            // existing ones) and then spawn them.
            let Some(Some(name)) = flags.get("name").cloned() else {
                fail(EXIT_USAGE, "registry save needs --name and --backend (and usually --system):\n  tmm registry save --name tester --backend kiro --system \"You run the test suite …\" [--skills a,b] [--mcp '<json array>']");
            };
            let backend = flags.get("backend").cloned().flatten().unwrap_or_default();
            // --skills is a comma list of refs; --mcp is a raw JSON array
            // (server-validated either way).
            let skills: Vec<String> = flags
                .get("skills").cloned().flatten()
                .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
                .unwrap_or_default();
            let def = json!({
                "name": name,
                "backend": backend,
                "model": flags.get("model").cloned().flatten().unwrap_or_default(),
                "effort": flags.get("effort").cloned().flatten().unwrap_or_default(),
                "system": flags.get("system").cloned().flatten().unwrap_or_default(),
                "skills": serde_json::to_string(&skills).unwrap(),
                "mcp": flags.get("mcp").cloned().flatten().unwrap_or_else(|| "[]".into()),
                "input_mode": flags.get("input-mode").cloned().flatten().unwrap_or_else(|| "queue".into()),
            });
            let r = rpc(&ctx, "registry_save", json!({ "def": def })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ saved {name}"); }
        }
        ("skills", rest) if rest.first().map(String::as_str) == Some("list") => {
            let r = rpc(&ctx, "skills_list", json!({})).await;
            if ctx.json { println!("{r}"); } else {
                let empty = Vec::new();
                for sk in r.get("skills").and_then(|v| v.as_array()).unwrap_or(&empty) {
                    let s = |k: &str| sk.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    println!("{} ← {} {}", s("name"), s("source"), s("description"));
                }
            }
        }
        ("skills", rest) if rest.first().map(String::as_str) == Some("import") => {
            // One url installs EVERYTHING it contains — a claude plugin or
            // marketplace imports each of its skills, named by themselves.
            let Some(source) = rest.get(1).cloned().or_else(|| flags.get("source").cloned().flatten()) else {
                fail(EXIT_USAGE, "skills import needs a source: tmm skills import https://github.com/org/plugin-repo");
            };
            let r = rpc(&ctx, "skills_import", json!({ "source": source })).await;
            if ctx.json { println!("{r}"); } else {
                let names = r.get("imported").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                println!("✓ imported: {names}");
                if let Some(sk) = r.get("skipped").and_then(|v| v.as_array()).filter(|a| !a.is_empty()) {
                    println!("  skipped: {}", sk.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join(", "));
                }
            }
        }
        ("skills", rest) if rest.first().map(String::as_str) == Some("save") => {
            let source = flags.get("source").cloned().flatten().or_else(|| flags.get("ref").cloned().flatten());
            let (Some(Some(name)), Some(source)) = (flags.get("name").cloned(), source) else {
                fail(EXIT_USAGE, "skills save needs --name and --source: tmm skills save --name git-review --source https://github.com/org/repo/tree/main/skills/git-review");
            };
            let def = json!({ "name": name, "source": source, "description": flags.get("description").cloned().flatten().unwrap_or_default() });
            let r = rpc(&ctx, "skills_save", json!({ "def": def })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ imported {name}"); }
        }
        ("skills", rest) if rest.first().map(String::as_str) == Some("refresh") => {
            let Some(name) = rest.get(1).cloned() else { fail(EXIT_USAGE, "skills refresh <name>"); };
            let r = rpc(&ctx, "skills_refresh", json!({ "name": name })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ refreshed {name}"); }
        }
        ("skills", rest) if rest.first().map(String::as_str) == Some("delete") => {
            let Some(name) = rest.get(1).cloned() else { fail(EXIT_USAGE, "skills delete <name>"); };
            let r = rpc(&ctx, "skills_delete", json!({ "name": name })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ deleted {name}"); }
        }
        ("mcp", rest) if rest.first().map(String::as_str) == Some("list") => {
            let r = rpc(&ctx, "mcp_list", json!({})).await;
            if ctx.json { println!("{r}"); } else {
                let empty = Vec::new();
                for m in r.get("mcp").and_then(|v| v.as_array()).unwrap_or(&empty) {
                    let s = |k: &str| m.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    println!("{}: {}", s("name"), s("def"));
                }
            }
        }
        ("mcp", rest) if rest.first().map(String::as_str) == Some("save") => {
            let (Some(Some(name)), Some(Some(defv))) = (flags.get("name").cloned(), flags.get("def").cloned()) else {
                fail(EXIT_USAGE, "mcp save needs --name and --def '<json>': tmm mcp save --name files --def '{\"command\":\"mcp-files\"}'");
            };
            let r = rpc(&ctx, "mcp_save", json!({ "def": { "name": name, "def": defv } })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ saved {name}"); }
        }
        ("mcp", rest) if rest.first().map(String::as_str) == Some("delete") => {
            let Some(name) = rest.get(1).cloned() else { fail(EXIT_USAGE, "mcp delete <name>"); };
            let r = rpc(&ctx, "mcp_delete", json!({ "name": name })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ deleted {name}"); }
        }
        ("registry", rest) if rest.first().map(String::as_str) == Some("delete") => {
            let Some(name) = rest.get(1).cloned() else {
                fail(EXIT_USAGE, "registry delete needs a name: tmm registry delete <name>");
            };
            let r = rpc(&ctx, "registry_delete", json!({ "name": name })).await;
            if ctx.json { println!("{r}"); } else { println!("✓ deleted {name}"); }
        }
        // The app-wide agent instructions (`<config>/AGENTS.md`): the one
        // software-level system prompt, prepended to every managed agent's at
        // spawn. CLI/UI parity (CLAUDE.md rule 14): what the Settings editor
        // does, an agent can do too.
        ("prompt", rest) => {
            match rest.first().map(String::as_str) {
                Some("show") | None => {
                    let r = rpc(&ctx, "global_prompt_get", json!({})).await;
                    if ctx.json { println!("{r}"); } else {
                        let text = r.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if text.is_empty() {
                            eprintln!("(no global instructions — `tmm prompt set <text>` or edit {})", r.get("path").and_then(|v| v.as_str()).unwrap_or("<config>/AGENTS.md"));
                        } else {
                            println!("{text}");
                        }
                    }
                }
                Some("path") => {
                    let r = rpc(&ctx, "global_prompt_get", json!({})).await;
                    if ctx.json { println!("{r}"); } else { println!("{}", r.get("path").and_then(|v| v.as_str()).unwrap_or("")); }
                }
                Some("set") => {
                    let text = match flags.get("file").cloned().flatten() {
                        Some(f) => std::fs::read_to_string(&f).unwrap_or_else(|e| fail(EXIT_USAGE, &format!("cannot read {f}: {e}"))),
                        None => {
                            let t = rest[1..].join(" ");
                            if t.trim().is_empty() {
                                fail(EXIT_USAGE, "prompt set needs the text or --file <path>:\n  tmm prompt set \"Answer in Chinese. Never force-push.\"\n  tmm prompt set --file ./AGENTS.md");
                            }
                            t
                        }
                    };
                    let r = rpc(&ctx, "global_prompt_set", json!({ "text": text })).await;
                    if ctx.json { println!("{r}"); } else { println!("✓ global instructions set ({} bytes) — applies to agents spawned from now on; restart a running one to pick it up", r.get("bytes").and_then(|v| v.as_u64()).unwrap_or(0)); }
                }
                Some("clear") => {
                    let r = rpc(&ctx, "global_prompt_set", json!({ "text": "" })).await;
                    if ctx.json { println!("{r}"); } else { println!("✓ global instructions cleared"); }
                }
                Some(other) => fail(EXIT_USAGE, &format!("unknown prompt verb {other}: tmm prompt show|path|set|clear")),
            }
        }
        _ => {
            eprint!("{}", usage());
            std::process::exit(EXIT_USAGE);
        }
    }
}

type Flags = std::collections::HashMap<String, Option<String>>;

/// `tmm task …` — background tasks as tmux windows. The only subtree that
/// opens no socket and reads no config, so it stays usable when the hub is
/// down. Errors map onto the tiered codes via `task_fail`; 2 is unreachable.
/// `tmm mcp servers|tools|call` — the unified MCP door (mcp_cli.rs has the
/// why). Everything here is a thin shell around the inspector: resolve the
/// config, build the argv, inherit stdio so the agent reads the inspector's
/// own output, and pass its exit code through (the inspector's codes are a
/// stable contract: 4 unreachable, 5 tool error…).
fn cmd_mcp_local(rest: &[String], flags: &Flags, _json: bool) {
    use tmux_mobile::mcp_cli;
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let resolved = mcp_cli::resolve_config(std::env::var("TMM_MCP_CONFIG").ok(), &cwd);
    // `add` is allowed to START the config — a fresh workspace has none yet;
    // every reading verb needs it to exist.
    let config = match (&resolved, rest[0].as_str()) {
        (Some(p), "add") => p.clone(),
        (None, "add") => cwd.join(".tmm").join("mcp.json"),
        (Some(p), _) if p.is_file() => p.clone(),
        (Some(p), _) => fail(EXIT_USAGE, &format!("MCP config not found: {}", p.display())),
        (None, _) => fail(EXIT_USAGE, "no MCP config: create .tmm/mcp.json ({\"mcpServers\":{...}}), set $TMM_MCP_CONFIG, or add a server: tmm mcp add <name> --def '<json>'"),
    };
    if rest[0] == "add" {
        if let Some(dir) = config.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    let names = mcp_cli::server_names(&std::fs::read_to_string(&config).unwrap_or_default());

    let run = |args: Vec<String>| -> i32 {
        let argv = mcp_cli::inspector_argv(std::env::var("TMM_MCP_CLI").ok());
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..]).args(&args);
        match cmd.status() {
            Ok(st) => st.code().unwrap_or(1),
            Err(e) => {
                eprintln!("tmm: cannot run MCP inspector ({}): {e}", argv.join(" "));
                eprintln!("tmm: set $TMM_MCP_CLI or install it: npm i -g @modelcontextprotocol/inspector");
                EXIT_ERR
            }
        }
    };
    // Like `run`, but the JSON result comes back to US for reshaping (the
    // compact tools tier); the inspector's stderr passes through so its
    // one-line error envelope stays visible to the agent.
    let capture = |mut args: Vec<String>| -> Result<String, i32> {
        args.push("--format".into());
        args.push("json".into());
        let argv = mcp_cli::inspector_argv(std::env::var("TMM_MCP_CLI").ok());
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..]).args(&args).stderr(std::process::Stdio::inherit());
        match cmd.output() {
            Ok(out) if out.status.success() => Ok(String::from_utf8_lossy(&out.stdout).to_string()),
            Ok(out) => Err(out.status.code().unwrap_or(1)),
            Err(e) => {
                eprintln!("tmm: cannot run MCP inspector ({}): {e}", argv.join(" "));
                eprintln!("tmm: set $TMM_MCP_CLI or install it: npm i -g @modelcontextprotocol/inspector");
                Err(EXIT_ERR)
            }
        }
    };

    match rest[0].as_str() {
        "servers" => {
            if names.is_empty() {
                println!("(no servers in {})", config.display());
            } else {
                for n in &names { println!("{n}"); }
            }
        }
        "tools" => {
            // PROGRESSIVE by default: one line per tool (name — first line of
            // the description), never the schemas — a big server's full
            // listing is pages of JSON nobody asked for yet. `tmm mcp schema
            // <server> <tool>` is the next tier.
            let targets: Vec<String> = match rest.get(1) {
                Some(s) => vec![s.clone()],
                None => names.clone(),
            };
            if targets.is_empty() {
                fail(EXIT_USAGE, &format!("no servers in {}", config.display()));
            }
            let mut worst = 0;
            for s in &targets {
                if targets.len() > 1 { println!("── {s} ──"); }
                match capture(mcp_cli::method_args(&config, s, "tools/list", None, &[], None)) {
                    Ok(out) => {
                        let tools = mcp_cli::compact_tools(&out);
                        if tools.is_empty() {
                            println!("(no tools)");
                        }
                        for (name, desc) in tools {
                            if desc.is_empty() { println!("{name}"); } else { println!("{name} — {desc}"); }
                        }
                    }
                    Err(code) => worst = code,
                }
            }
            if worst == 0 && targets.len() == 1 {
                println!("\n(schema: tmm mcp schema {} <tool>)", targets[0]);
            }
            std::process::exit(worst);
        }
        "schema" => {
            let (Some(server), Some(tool)) = (rest.get(1), rest.get(2)) else {
                fail(EXIT_USAGE, "mcp schema <server> <tool>");
            };
            match capture(mcp_cli::method_args(&config, server, "tools/list", None, &[], None)) {
                Ok(out) => match mcp_cli::tool_schema(&out, tool) {
                    Some(t) => println!("{}", serde_json::to_string_pretty(&t).unwrap()),
                    None => fail(EXIT_NOT_FOUND, &format!("no tool {tool:?} on server {server:?} (try: tmm mcp tools {server})")),
                },
                Err(code) => std::process::exit(code),
            }
        }
        "add" => {
            // Dynamic by design (owner, 2026-08-28: "可以临时增加工具去调用"):
            // one line adds a server to .tmm/mcp.json and the NEXT call has it.
            // Editing the file by hand stays equally valid — this is sugar.
            let (Some(name), Some(Some(defv))) = (rest.get(1), flags.get("def").cloned()) else {
                fail(EXIT_USAGE, "mcp add <name> --def '{\"command\":\"npx\",\"args\":[...]}' (or edit .tmm/mcp.json directly)");
            };
            let def = match serde_json::from_str::<serde_json::Value>(&defv) {
                Ok(v) if v.is_object() => v,
                _ => fail(EXIT_USAGE, "--def must be a JSON object ({\"command\":...} or {\"url\":...})"),
            };
            let mut root: serde_json::Value = std::fs::read_to_string(&config)
                .ok().and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            if !root.get("mcpServers").map(|v| v.is_object()).unwrap_or(false) {
                root["mcpServers"] = serde_json::json!({});
            }
            root["mcpServers"][name.as_str()] = def;
            if let Err(e) = std::fs::write(&config, serde_json::to_string_pretty(&root).unwrap()) {
                fail(EXIT_ERR, &format!("write {}: {e}", config.display()));
            }
            println!("✓ {name} → {} (live on the next call)", config.display());
        }
        "call" => {
            let (Some(server), Some(tool)) = (rest.get(1), rest.get(2)) else {
                fail(EXIT_USAGE, "mcp call <server> <tool> [key=value ...]");
            };
            let kv: Vec<String> = rest[3..].to_vec();
            if let Some(bad) = kv.iter().find(|s| !mcp_cli::is_kv(s)) {
                fail(EXIT_USAGE, &format!("tool arguments are key=value (got {bad:?}); or pass --args-json '{{...}}'"));
            }
            let args_json = flags.get("args-json").cloned().flatten();
            std::process::exit(run(mcp_cli::method_args(
                &config, server, "tools/call", Some(tool), &kv, args_json.as_deref(),
            )));
        }
        _ => unreachable!("dispatch guards the verb"),
    }
}

/// Every `tmm task` verb reaps expired finished windows at its door (board
/// #206) — AFTER its own work and never its own target, so `logs`/`status`/`rm`
/// on an expired task still answer. `list` reaps first so what it prints is
/// what exists. Reaped names go to stderr, so `--json` stdout stays clean.
fn reap_at_the_door(except: Option<&str>, json: bool) {
    let reaped = tasks::reap_expired(except);
    if reaped.is_empty() {
        return;
    }
    let names: Vec<&str> = reaped.iter().map(|t| t.name.as_str()).collect();
    if json {
        eprintln!("{}", json!({ "reaped": names }));
    } else {
        eprintln!("(reaped {} finished task window{}: {})", names.len(), if names.len() == 1 { "" } else { "s" }, names.join(", "));
    }
}

fn cmd_task(rest: &[String], cmdv: &[String], flags: &Flags, json: bool) {
    let verb = rest.first().map(String::as_str).unwrap_or("");
    let arg = rest.get(1).map(String::as_str);
    if verb == "list" {
        reap_at_the_door(None, json);
    }
    match verb {
        "start" => {
            let Some(name) = arg else {
                fail(EXIT_USAGE, "task start needs a name: tmm task start dev -- npm run dev");
            };
            if cmdv.is_empty() {
                fail(EXIT_USAGE, "task start needs a command after `--`: tmm task start dev -- npm run dev");
            }
            let session = flags.get("session").cloned().flatten();
            // Who is starting it (board #291): the task and its wake both run
            // as this starter — one definition, `tasks::starter_env`.
            let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
            let project = flags.get("project").cloned().flatten().or_else(|| env("TMM_PROJECT")).filter(|v| !v.is_empty());
            let starter = flags.get("agent").cloned().flatten().or_else(|| env("TMM_AGENT")).filter(|v| !v.is_empty());
            // The server this task was started against, flag or env
            // (validator 09:31): its sends and its wake reach the same one.
            let server = flags.get("server").cloned().flatten().or_else(|| env("TMM_SERVER"));
            let starter_env = tasks::starter_env(project.as_deref(), starter.as_deref(), env("XDG_CONFIG_HOME").as_deref(), server.as_deref());
            // `--wake [@who]` (board #275): when the task ends by itself, the
            // server gets a wake for @who (default: the agent starting it).
            let wake = flags.contains_key("wake").then(|| {
                if project.is_none() {
                    fail(EXIT_USAGE, "--wake needs a project: run it as an agent, or pass --project");
                }
                let to = rest.get(2).and_then(|w| w.strip_prefix('@')).map(str::to_string).or_else(|| starter.clone())
                    .unwrap_or_else(|| fail(EXIT_USAGE, "--wake needs someone to wake: tmm task start build --wake @lead -- make"));
                let exe = std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "tmm".into());
                wake_shell(name, &to, &exe, &starter_env)
            });
            let t = tasks::start(name, cmdv, session.as_deref(), flags.contains_key("replace"), wake.as_deref(), &starter_env)
                .unwrap_or_else(|e| task_fail(e));
            if json {
                println!("{}", task_value(&t));
            } else {
                println!("✓ started {} in {} (pane {}, pid {})", t.name, t.target(), t.pane, t.pid);
                println!("  logs: tmm task logs {}", t.name);
                if wake.is_some() {
                    println!("  wakes the agent when it ends by itself (not on tmm task stop)");
                }
            }
            reap_at_the_door(Some(name), json);
        }
        "list" => {
            let rows = tasks::list();
            if json {
                let arr: Vec<Value> = rows.iter().map(task_value).collect();
                println!("{}", json!({ "tasks": arr }));
            } else if rows.is_empty() {
                println!("no tasks");
            } else {
                let now = tasks::unix_now();
                println!("{:<16} {:<11} {:>4}  {:<18} {}", "NAME", "STATE", "AGE", "TARGET", "COMMAND");
                for t in &rows {
                    println!(
                        "{:<16} {:<11} {:>4}  {:<18} {}",
                        t.name, t.state_str(), tasks::fmt_age(t.age(now)), t.target(), t.cmd
                    );
                    if !t.wake_error.is_empty() {
                        println!("{:<16} wake not sent: {}", "", t.wake_error);
                    }
                }
            }
        }
        "status" => {
            let Some(name) = arg else { fail(EXIT_USAGE, "task status <name>") };
            match tasks::find(name) {
                Some(t) => {
                    if json {
                        println!("{}", task_value(&t));
                    } else {
                        // State first, so `tmm task status x | awk '{print $1}'`
                        // and a bare `$(...)` comparison both work.
                        println!(
                            "{} {} {} pid {}",
                            t.state_str(),
                            tasks::fmt_age(t.age(tasks::unix_now())),
                            t.target(),
                            t.pid
                        );
                        if !t.wake_error.is_empty() {
                            println!("wake not sent: {}", t.wake_error);
                        }
                    }
                }
                None => {
                    if json {
                        println!("{}", json!({ "name": name, "state": "missing" }));
                    } else {
                        println!("missing");
                    }
                    reap_at_the_door(Some(name), json);
                    std::process::exit(EXIT_NOT_FOUND);
                }
            }
            reap_at_the_door(Some(name), json);
        }
        "logs" => {
            let Some(name) = arg else {
                fail(EXIT_USAGE, "task logs <name> [--limit N] [--grep <text>]");
            };
            let limit = flags
                .get("limit")
                .cloned()
                .flatten()
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(50);
            let grep = flags.get("grep").cloned().flatten();
            let text = tasks::logs(name, limit, grep.as_deref()).unwrap_or_else(|e| task_fail(e));
            if json {
                let lines: Vec<&str> = text.lines().collect();
                println!("{}", json!({ "name": name, "lines": lines }));
            } else if !text.is_empty() {
                println!("{text}");
            }
            // A --wake that could not be sent is said where the task is read.
            if !json {
                if let Some(t) = tasks::find(name).filter(|t| !t.wake_error.is_empty()) {
                    eprintln!("tmm: wake not sent: {}", t.wake_error);
                }
            }
            reap_at_the_door(Some(name), json);
        }
        "stop" => {
            let Some(name) = arg else { fail(EXIT_USAGE, "task stop <name> [--keep]") };
            let keep = flags.contains_key("keep");
            let out = tasks::stop(name, keep).unwrap_or_else(|e| task_fail(e));
            if json {
                let lines: Vec<&str> = out.tail.lines().collect();
                let mut v = task_value(&out.task);
                v["closed"] = json!(out.closed);
                v["tail"] = json!(lines);
                println!("{v}");
            } else {
                if !out.tail.is_empty() {
                    println!("{}", out.tail);
                }
                if out.closed {
                    println!("✓ stopped {} ({}); window closed — pass --keep to keep it", out.task.name, out.task.state_str());
                } else {
                    println!("✓ stopped {} ({}); window kept — logs: tmm task logs {}", out.task.name, out.task.state_str(), out.task.name);
                }
            }
            reap_at_the_door(Some(name), json);
        }
        "rm" => {
            let Some(name) = arg else { fail(EXIT_USAGE, "task rm <name>") };
            let t = tasks::remove(name).unwrap_or_else(|e| task_fail(e));
            if json {
                println!("{}", json!({ "removed": t.name }));
            } else {
                println!("✓ removed {}", t.name);
            }
            reap_at_the_door(Some(name), json);
        }
        _ => {
            eprint!("{}", usage());
            std::process::exit(EXIT_USAGE);
        }
    }
}

/// The module's typed errors are the reason this is not string sniffing.
fn task_fail(e: tasks::Error) -> ! {
    let code = match &e {
        tasks::Error::Invalid(_) => EXIT_USAGE,
        tasks::Error::NotFound(_) => EXIT_NOT_FOUND,
        tasks::Error::Tmux(_) => EXIT_ERR,
    };
    fail(code, &e.to_string())
}

fn task_value(t: &tasks::Task) -> Value {
    json!({
        "name": t.name,
        "state": t.state_str(),
        "wake_error": if t.wake_error.is_empty() { Value::Null } else { Value::from(t.wake_error.as_str()) },
        "exit_code": match &t.state {
            tasks::State::Exited(code) => Some(*code),
            _ => None,
        },
        "signal": match &t.state {
            tasks::State::Killed(sig) => Some(sig.as_str()),
            _ => None,
        },
        "session": t.session,
        "window": t.window,
        "pane": t.pane,
        "pid": t.pid,
        "started": t.started,
        "cmd": t.cmd,
    })
}

/// Accepts a session name or a raw project id; resolves via project_list so
/// humans and agents can address projects by the name they see in tmux.
async fn resolve_project_id(ctx: &Ctx, name: &str) -> String {
    let r = rpc(ctx, "project_list", json!({ "include_archived": true })).await;
    let empty = Vec::new();
    let rows = r.get("projects").and_then(|a| a.as_array()).unwrap_or(&empty);
    for p in rows {
        let proj = p.get("project").cloned().unwrap_or(Value::Null);
        let id = proj.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let session = proj.get("session").and_then(|v| v.as_str()).unwrap_or("");
        if session == name || id == name {
            return id.to_string();
        }
    }
    fail(EXIT_NOT_FOUND, &format!("no project with session or id '{name}' — try `tmm project list`"))
}

/// `tmm gateway …` (board #323). `TMM_GATEWAY_SERVICE` names the service
/// (default: the production label / unit); a smoke run sets its own, which
/// can never address the real one.
/// `tmm ui` (board #323): ask THIS machine's gateway, over the probe's own
/// authenticated session (the token is proven, never sent), whether it
/// serves the web UI, and print the page's URL or why there is none. Only
/// a provably-ours gateway that says it serves opens a browser.
async fn cmd_ui(open: bool) {
    use tmux_mobile::gateway::probe::{self, Asked, Verdict};
    let cfg = tmux_mobile::config::Config::peek_service();
    match probe::probe_and_ask(&cfg, Some("ui_info")).await {
        (Verdict::None, _) => fail(EXIT_NET, &format!("no gateway is running at {} — start it with: tmm gateway", probe::local_url(&cfg))),
        (Verdict::Occupied(why), _) => fail(EXIT_NET, &format!("not this machine's gateway: {why}")),
        (Verdict::Ours { url, .. }, asked) => match asked {
            Some(Asked::Result(r)) if r.get("served").and_then(|v| v.as_bool()) == Some(true) => {
                let page = page_url(&url);
                println!("{page}");
                println!("  from another device: this machine's address, port {} — the app asks for the token", cfg.port);
                if open {
                    open_browser(&page);
                }
            }
            Some(Asked::Result(r)) => {
                let why = r.get("reason").and_then(|v| v.as_str()).unwrap_or("no web UI");
                fail(EXIT_NOT_FOUND, &format!("the gateway at {url} serves no web UI: {why}"));
            }
            Some(Asked::Unknown) => fail(EXIT_NOT_FOUND, &format!("the gateway at {url} is an older version without a web UI — update tmm, then: tmm gateway restart")),
            Some(Asked::Failed(why)) => fail(EXIT_ERR, &format!("the gateway at {url}: {why}")),
            None => fail(EXIT_ERR, &format!("the gateway at {url} did not answer ui_info")),
        },
    }
}

/// The page on the gateway's own port: ws → http, wss → https.
fn page_url(ws_url: &str) -> String {
    let rest = ws_url.strip_prefix("wss://").map(|r| format!("https://{r}/"));
    rest.unwrap_or_else(|| format!("http://{}/", ws_url.strip_prefix("ws://").unwrap_or(ws_url)))
}

/// The platform opener, with the URL as one argv entry (never a shell).
fn open_browser(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    if let Err(e) = std::process::Command::new(opener).arg(url).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn() {
        eprintln!("could not run {opener}: {e} — open {url} yourself");
    }
}

async fn cmd_gateway(rest: &[String], flags: &Flags) {
    use tmux_mobile::gateway::{self, probe, service};
    let sub = rest.first().map(String::as_str).unwrap_or("");
    // No config.toml yet: the first-run setup, in this (foreground) caller.
    // The installed service (`--service`) never prompts: it has no terminal.
    if matches!(sub, "" | "install" | "start") && !flags.contains_key("service") {
        match tmux_mobile::gateway::setup::first_run() {
            Ok(tmux_mobile::gateway::setup::FirstRun::Cancelled) => fail(EXIT_ERR, "setup cancelled — nothing was installed or started"),
            Ok(_) => {}
            Err(e) => fail(EXIT_ERR, &format!("setup: {e}")),
        }
    }
    if sub == "start" {
        // `--service` (the installed unit's argv): config.toml ALONE, so the
        // service and `status` read the same thing.
        let cfg = if flags.contains_key("service") { tmux_mobile::config::Config::load_service() } else { tmux_mobile::config::Config::load() };
        if let Err(e) = gateway::start(cfg.clone()).await {
            // A taken port says WHO holds it (never another port, never a kill).
            let why = match probe::probe(&cfg).await {
                probe::Verdict::Ours { url, .. } => format!("{e} — this machine's gateway already answers at {url}"),
                probe::Verdict::Occupied(who) => format!("{e} — {who}"),
                probe::Verdict::None => e,
            };
            fail(EXIT_ERR, &format!("gateway: {why}"));
        }
        return;
    }
    let mac = cfg!(target_os = "macos");
    let name = std::env::var("TMM_GATEWAY_SERVICE").ok().filter(|s| !s.is_empty())
        .unwrap_or_else(|| (if mac { service::LABEL } else { service::UNIT }).to_string());
    if let Err(e) = service::valid_name(&name, mac) {
        fail(EXIT_USAGE, &format!("TMM_GATEWAY_SERVICE: {e}"));
    }
    // The service reads config.toml only; this shell's overrides do not reach it.
    let set: Vec<&str> = tmux_mobile::config::ENV_OVERRIDES.iter().copied().filter(|k| std::env::var_os(k).is_some()).collect();
    if !set.is_empty() {
        eprintln!("note: {} set in this shell — the service does not use them; it runs with {}", set.join(", "), tmux_mobile::config::config_dir().join("config.toml").display());
    }
    // Sys::real's probe builds its own runtime, so every call that may probe
    // runs on a blocking thread, off this current-thread runtime.
    match sub {
        "" | "install" => {
            let replace = flags.contains_key("replace");
            let n = name.clone();
            let r = tokio::task::spawn_blocking(move || {
                let sys = service::Sys::real()?;
                let done = service::install(&sys, &n, replace)?;
                println!("✓ {n}: {}", done_words(&done));
                Ok::<bool, String>(print_status(&sys, &n, false))
            }).await.unwrap_or_else(|e| Err(e.to_string()));
            match r {
                Ok(true) => {}
                Ok(false) => fail(EXIT_ERR, "gateway: installed, but this machine's gateway does not answer"),
                Err(e) => fail(EXIT_ERR, &format!("gateway install: {e}")),
            }
        }
        "uninstall" => match tokio::task::spawn_blocking({ let n = name.clone(); move || service::Sys::real().and_then(|sys| service::uninstall(&sys, &n)) }).await.unwrap_or_else(|e| Err(e.to_string())) {
            Ok(true) => println!("✓ {name} removed"),
            Ok(false) => println!("{name} is not installed"),
            Err(e) => fail(EXIT_ERR, &format!("gateway uninstall: {e}")),
        },
        "restart" => {
            let n = name.clone();
            let r = tokio::task::spawn_blocking(move || service::Sys::real().and_then(|sys| service::restart(&sys, &n)))
                .await.unwrap_or_else(|e| Err(e.to_string()));
            match r {
                Ok(pid) => println!("✓ {name} restarted (pid {pid})"),
                Err(e) => fail(EXIT_ERR, &format!("gateway restart: {e}")),
            }
        }
        "status" => {
            let n = name.clone();
            let show = flags.contains_key("show-token");
            let ok = tokio::task::spawn_blocking(move || service::Sys::real().map(|sys| print_status(&sys, &n, show)))
                .await.ok().and_then(|r| r.ok()).unwrap_or(false);
            if !ok {
                std::process::exit(EXIT_NOT_FOUND);
            }
        }
        "logs" => {
            let follow = flags.contains_key("f") || flags.contains_key("follow");
            let found = tokio::task::spawn_blocking({ let n = name.clone(); move || service::Sys::real().and_then(|sys| service::logs_command(&sys, &n, follow)) })
                .await.unwrap_or_else(|e| Err(e.to_string()));
            let (cmd, args) = match found {
                Ok(c) => c,
                Err(e) => fail(EXIT_ERR, &format!("gateway logs: {e}")),
            };
            let status = std::process::Command::new(&cmd).args(&args).status();
            if !matches!(status, Ok(s) if s.success()) {
                fail(EXIT_ERR, &format!("gateway logs: {cmd} {} failed", args.join(" ")));
            }
        }
        other => fail(EXIT_USAGE, &format!("gateway {other}: start | install | uninstall | status | restart | logs")),
    }
}

fn done_words(done: &tmux_mobile::gateway::service::Done) -> String {
    use tmux_mobile::gateway::service::Done;
    match done {
        Done::Installed(pid) => format!("installed and answering (pid {pid})"),
        Done::AlreadyRunning(pid) => format!("already installed and answering (pid {pid})"),
        Done::Started(pid) => format!("installed; started and answering (pid {pid})"),
        Done::Updated(pid) => format!("updated, restarted and answering (pid {pid})"),
        Done::Protected(pid) => format!("now KillMode={} in effect, applied in place — nothing was restarted (pid {pid})", tmux_mobile::gateway::service::KILL_MODE),
        Done::Replaced { pid, backup } => format!("replaced and answering (pid {pid}); the previous file is kept at {}", backup.display()),
    }
}

/// The service state and the local probe's verdict — read-only (nothing is
/// created); true when OUR gateway answers.
fn print_status(sys: &tmux_mobile::gateway::service::Sys, name: &str, show_token: bool) -> bool {
    use tmux_mobile::gateway::{probe, service};
    let cfg = tmux_mobile::config::Config::peek_service();
    let (installed, pid) = service::state(sys, name);
    let svc = match (&installed, pid) {
        (Ok(true), Some(p)) => format!("installed, running (pid {p})"),
        (Ok(true), None) => "installed, not running".into(),
        (Ok(false), _) => "not installed".into(),
        (Err(e), _) => e.clone(),
    };
    let verdict = (sys.probe)();
    let answer = match &verdict {
        probe::Verdict::Ours { url, .. } => format!("answering at {url} (this machine)"),
        probe::Verdict::Occupied(why) => format!("occupied — {why}"),
        probe::Verdict::None => "not running (nothing listens on the port)".into(),
    };
    println!("service   {name}: {svc}");
    if let Some(w) = service::protection_warning(sys, name) {
        eprintln!("warning   {w}");
    }
    println!("gateway   {answer}");
    if let probe::Verdict::Ours { build, .. } = &verdict {
        println!("build     {}", build_line(build.as_ref(), &tmux_mobile::build_info::Build::ours()));
    }
    println!("listen    {}:{}{}", cfg.host, cfg.port, if cfg.tls_cert.is_some() { " (TLS)" } else { "" });
    println!("config    {}", tmux_mobile::config::config_dir().display());
    let token = if cfg.token.is_empty() { " (none yet — run tmm setup or tmm gateway)".to_string() }
        else if show_token { format!(" {}", cfg.token) } else { " (tmm gateway status --show-token)".into() };
    println!("connect   from the app: the address of this machine, port {}, and the token{token}", cfg.port);
    matches!(verdict, probe::Verdict::Ours { .. })
}

/// The running gateway's build, as `tmm gateway status` prints it: its own
/// words (an older gateway sends none), and — when it is not the build of this
/// `tmm` — which one this is, because that mismatch is the stale-gateway tell
/// (board #368).
fn build_line(gateway: Option<&tmux_mobile::build_info::Build>, ours: &tmux_mobile::build_info::Build) -> String {
    match gateway {
        None => "unknown (this gateway predates build identity)".into(),
        Some(g) if g.commit == ours.commit && g.version == ours.version => g.line(),
        Some(g) => format!("{} — this tmm is {}", g.line(), ours.line()),
    }
}

fn need_project(ctx: &Ctx) -> String {
    ctx.project.clone().unwrap_or_else(|| {
        fail(EXIT_USAGE, "no project: set $TMM_PROJECT or pass --project <session>")
    })
}

/// The server's own reading of an address (board #248): a send the server
/// would deliver to nobody is refused here, before it reaches the room.
fn has_address(body: &str) -> bool {
    !tmux_mobile::address::mention_names(body).is_empty()
}

/// `--flag value` / `--flag` / `-f` → map; the rest are positionals.
/// Flags known to take a value consume the next arg; boolean flags don't.
/// The third return is every valued occurrence in order, so a flag that may be
/// REPEATED (`--image a.png --image b.png`) does not lose all but the last —
/// the map keeps one value per key by design and that is fine for the rest.
fn split_flags(args: &[String]) -> (std::collections::HashMap<String, Option<String>>, Vec<String>, Vec<(String, String)>) {
    const VALUED: &[&str] = &["project", "agent", "server", "output", "since", "limit", "brief",
                          "name", "session", "with-agent", "backend", "model", "effort", "input-mode", "system", "skills", "mcp",
                          "ref", "source", "description", "def", "grep", "image", "body", "assignee", "team", "file",
                          "in", "at", "to", "code", "signal", "re"];
    let mut flags = std::collections::HashMap::new();
    let mut pos = Vec::new();
    let mut repeats: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(name) = a.strip_prefix("--") {
            if VALUED.contains(&name) && i + 1 < args.len() {
                flags.insert(name.to_string(), Some(args[i + 1].clone()));
                repeats.push((name.to_string(), args[i + 1].clone()));
                i += 2;
                continue;
            }
            flags.insert(name.to_string(), None);
        } else if a.len() > 1 && a.starts_with('-') {
            // A LONE `-` is a positional, not a nameless flag (board #367,
            // found by running the verb): it is how a shell spells "nobody"
            // for `tmm board assign <id> -`, and `strip_prefix('-')` turned
            // it into a flag named "" that nothing reads, so the argument
            // vanished and the command asked for a name it had been given.
            flags.insert(a[1..].to_string(), None);
        } else {
            pos.push(a.clone());
        }
        i += 1;
    }
    (flags, pos, repeats)
}

/// An image reference as the client will have to resolve it. A URL is passed
/// through untouched; a filesystem path is made absolute against the agent's
/// cwd, because the reader is a phone in another room and "./shot.png" means
/// nothing there.
/// Every `--image` given (repeatable), as references a reader can resolve.
fn image_refs(repeated: &[(String, String)]) -> Vec<String> {
    repeated.iter().filter(|(k, _)| k == "image").map(|(_, v)| absolutize_ref(v)).collect()
}

/// `text` with each image appended as a markdown reference on its own line
/// — the ONE shape for chat messages, board bodies and notes (board #329).
/// An image is a REFERENCE, never bytes.
fn with_images(text: &str, images: &[String]) -> String {
    let mut body = text.to_string();
    for src in images {
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(&format!("![]({src})"));
    }
    body
}

fn absolutize_ref(src: &str) -> String {
    let s = src.trim();
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("data:") || s.starts_with('/') {
        return s.to_string();
    }
    if let Some(rest) = s.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::Path::new(&home).join(rest).to_string_lossy().to_string();
        }
    }
    std::env::current_dir()
        .map(|d| d.join(s).to_string_lossy().to_string())
        .unwrap_or_else(|_| s.to_string())
}

/// One connect → auth → call → close round trip. All failure modes funnel to
/// the tiered exit codes; success returns the RPC result value.
async fn rpc(ctx: &Ctx, method: &str, params: Value) -> Value {
    match try_rpc(ctx, method, params).await {
        Ok(v) => v,
        Err((code, msg)) => fail(code, &msg),
    }
}

async fn try_rpc(ctx: &Ctx, method: &str, params: Value) -> Result<Value, (i32, String)> {
    try_rpc_with(ctx, method, params, None).await
}

/// `rpc` for a call that only an up-to-date server can do (board #377): the
/// login answer's `caps` is read BEFORE the call is sent, so a server that
/// lacks `need` is refused with nothing written. Without this a `tmm board
/// assign` against an older gateway would save a label no agent is ever told
/// about and print a success line.
async fn rpc_needing(ctx: &Ctx, need: &str, method: &str, params: Value) -> Value {
    match try_rpc_with(ctx, method, params, Some(need)).await {
        Ok(v) => v,
        Err((code, msg)) => fail(code, &msg),
    }
}

async fn try_rpc_with(ctx: &Ctx, method: &str, params: Value, need: Option<&str>) -> Result<Value, (i32, String)> {
    let connect = tokio_tungstenite::connect_async(&ctx.server);
    let (mut ws, _) = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| (EXIT_NET, format!("server not reachable at {} (2s timeout) — is tmux-mobile running?", ctx.server)))?
        .map_err(|e| (EXIT_NET, format!("server not reachable at {}: {e}", ctx.server)))?;

    // Plain token auth (loopback default). id 1 = auth, id 2 = the call.
    let auth = json!({ "id": 1, "method": "auth", "params": { "token": ctx.token } });
    ws.send(Message::Text(auth.to_string().into()))
        .await
        .map_err(|e| (EXIT_NET, format!("send failed: {e}")))?;
    let auth_reply = read_reply(&mut ws, 1).await?;
    if auth_reply.get("error").is_some() {
        return Err((EXIT_AUTH, "auth rejected — check token in config.toml or $TMM_TOKEN".into()));
    }
    if let Some(need) = need {
        let has = auth_reply
            .pointer("/result/caps")
            .and_then(|c| c.as_array())
            .is_some_and(|caps| caps.iter().any(|c| c.as_str() == Some(need)));
        if !has {
            let _ = ws.close(None).await;
            return Err((EXIT_NOT_FOUND, format!(
                "this server cannot hand an assignment over (its login answer lacks `{need}`) — update the server to assign. Nothing was saved."
            )));
        }
    }

    let call = json!({ "id": 2, "method": method, "params": params });
    ws.send(Message::Text(call.to_string().into()))
        .await
        .map_err(|e| (EXIT_NET, format!("send failed: {e}")))?;
    let reply = read_reply(&mut ws, 2).await?;
    let _ = ws.close(None).await;

    if let Some(err) = reply.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("unknown error").to_string();
        // -32601 method-not-found → the hub isn't on this server (mobile, or
        // old build). -32602 covers "no window named X" style lookups.
        let exit = match code {
            -32601 => EXIT_NOT_FOUND,
            -32602 => EXIT_USAGE,
            _ => 1,
        };
        return Err((exit, msg));
    }
    Ok(reply.get("result").cloned().unwrap_or(Value::Null))
}

async fn read_reply(
    ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    want_id: u64,
) -> Result<Value, (i32, String)> {
    let deadline = tokio::time::Instant::now() + RPC_TIMEOUT;
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next())
            .await
            .map_err(|_| (EXIT_NET, "rpc timeout".to_string()))?
            .ok_or((EXIT_NET, "connection closed".to_string()))?
            .map_err(|e| (EXIT_NET, format!("recv failed: {e}")))?;
        if let Message::Text(text) = msg {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                // Skip pushes (no id) and other ids — we only await ours.
                if v.get("id").and_then(|i| i.as_u64()) == Some(want_id) {
                    return Ok(v);
                }
            }
        }
    }
}

fn print_log(ctx: &Ctx, r: &Value) {
    print_log_with_rooms(ctx, r, false);
}

/// Search output across projects names the room per line — `[proj:blog]` —
/// because a hit means nothing if you cannot tell WHERE it was said.
fn print_log_with_rooms(ctx: &Ctx, r: &Value, with_room: bool) {
    if ctx.json {
        println!("{r}");
        return;
    }
    let empty = Vec::new();
    for m in r.get("messages").and_then(|m| m.as_array()).unwrap_or(&empty) {
        let from = m.get("from").and_then(|v| v.as_str()).unwrap_or("?");
        let body = m.get("body").and_then(|v| v.as_str()).unwrap_or("");
        let ts = m.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
        if with_room {
            let room = m.get("room").and_then(|v| v.as_str()).unwrap_or("?");
            println!("[{}] [{room}] {from}: {body}", local_stamp(ts));
        } else {
            println!("[{}] {from}: {body}", local_stamp(ts));
        }
    }
}

/// Epoch MILLISECONDS -> local `2026-08-17 16:31`, for a reader that wants to
/// know when something was said. The raw epoch was printed here before, which
/// told an agent nothing it could reason about. Falls back to the raw number if
/// the value is not a sane timestamp.
fn local_stamp(ts_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ts_ms)
        .map(|dt| dt.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| ts_ms.to_string())
}

/// `-f`: poll with the since cursor. Polling (not push) keeps the CLI a plain
/// request/response client — no long-lived socket state to get wrong, and a
/// dead server surfaces as one error line, not a silent stall.
async fn follow_log(ctx: &Ctx, session: &str, mut since: i64, limit: i64) {
    loop {
        let r = try_rpc(ctx, "hub_log", json!({ "session": session, "since_ts": since, "limit": limit })).await;
        match r {
            Ok(v) => {
                let empty = Vec::new();
                let msgs = v.get("messages").and_then(|m| m.as_array()).unwrap_or(&empty);
                for m in msgs {
                    let ts = m.get("ts").and_then(|t| t.as_i64()).unwrap_or(0);
                    if ts > since {
                        since = ts;
                    }
                    if ctx.json {
                        println!("{m}");
                    } else {
                        let from = m.get("from").and_then(|x| x.as_str()).unwrap_or("?");
                        let body = m.get("body").and_then(|x| x.as_str()).unwrap_or("");
                        println!("[{}] {from}: {body}", local_stamp(ts));
                    }
                }
            }
            Err((code, msg)) => fail(code, &msg),
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// The last lines of a finished task a wake carries (board #275).
const WAKE_TAIL_LINES: usize = 15;

/// The hook's shell command for a `--wake` task (board #275): `tmm task wake`
/// run as the task's starter (`tasks::starter_env`, board #291 — the same
/// environment the task command itself has), and the exit status / signal
/// left as tmux placeholders filled in at death. Every literal is
/// shell-quoted and `#`-escaped for tmux's format expansion; the token is NOT
/// carried (tmm reads it from config, as an agent's tmm does).
fn wake_shell(name: &str, to: &str, exe: &str, env: &[(String, String)]) -> String {
    let q = |v: &str| tasks::format_literal(&tmux_mobile::shell::quote_always(v));
    let env: Vec<String> = env.iter().map(|(k, v)| format!("{k}={}", q(v))).collect();
    format!(
        "{} {} task wake {} --to {} --code '#{{pane_dead_status}}' --signal '#{{pane_dead_signal}}' >/dev/null 2>&1",
        env.join(" "), q(exe), q(name), q(to)
    )
}

/// The wake a finished task sends: who, which task, how it ended, after how
/// long, and its last lines. An `@` in the output is defused (a zero-width
/// space after it), so a log line never addresses someone (board #275).
fn task_end_body(to: &str, name: &str, code: &str, signal: &str, age: Option<u64>, tail: &str) -> String {
    let how = if !signal.is_empty() { format!("killed:{signal}") } else { format!("exited:{code}") };
    let after = age.map(|a| format!(" after {}", tasks::fmt_age(Some(a)))).unwrap_or_default();
    let lines: Vec<String> = tail.lines().map(|l| l.chars().take(200).collect::<String>().replace('@', "@\u{200b}")).collect();
    let tail = lines.join("\n");
    // The line ends with what to DO about it (board #355): an agent that had ended
    // its turn to wait read a bare "task X exited:0" as news and did not act on it
    // for hours (builder, 10-14 12:37 -> 15:36, the wake delivered the whole time).
    let next = "Continue the work this task was for: read the output and post the result.";
    if tail.trim().is_empty() {
        format!("@{to} task {name} {how}{after}. {next}")
    } else {
        format!("@{to} task {name} {how}{after}; last lines:\n```\n{tail}\n```\n{next}")
    }
}

/// `--in` (board #275): `10s`, `10m`, `2h`, `1d`, or a sum such as `1h30m`;
/// at least 10 seconds. Seconds.
fn parse_in(text: &str) -> Result<i64, String> {
    let bad = || format!("--in '{text}': use a duration such as 90s, 10m, 2h, 1h30m or 1d");
    let (mut total, mut n) = (0i64, String::new());
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            n.push(c);
            continue;
        }
        let unit = match c { 's' => 1, 'm' => 60, 'h' => 3600, 'd' => 86400, _ => return Err(bad()) };
        total += n.parse::<i64>().map_err(|_| bad())?.checked_mul(unit).ok_or_else(bad)?;
        n.clear();
    }
    if !n.is_empty() || total == 0 {
        return Err(bad());
    }
    if total < 10 {
        return Err(format!("--in '{text}': at least 10s"));
    }
    Ok(total)
}

/// `--at` (board #275, orchestrator 08:20 C): `HH:MM` is its NEXT
/// occurrence — today, or tomorrow when already past; a full local
/// `YYYY-MM-DD HH:MM` (or with `T`) is taken as written. Unix seconds.
fn parse_at(text: &str, now: chrono::DateTime<chrono::Local>) -> Result<i64, String> {
    use chrono::{Local, NaiveDateTime, NaiveTime, TimeZone};
    let t = text.trim();
    let local = |naive: NaiveDateTime| {
        Local.from_local_datetime(&naive).earliest().map(|d| d.timestamp()).ok_or_else(|| format!("--at '{t}': no such local time"))
    };
    if let Ok(time) = NaiveTime::parse_from_str(t, "%H:%M") {
        let today = local(now.date_naive().and_time(time))?;
        return if today > now.timestamp() { Ok(today) } else { local((now.date_naive() + chrono::Days::new(1)).and_time(time)) };
    }
    for f in ["%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(t, f) {
            return local(naive);
        }
    }
    Err(format!("--at '{t}': use 14:30 or 2026-09-30 09:00"))
}

fn local_time(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// "in 5h 50m" / "in 40s" / "overdue".
fn until(secs: i64) -> String {
    match secs {
        s if s < 0 => "overdue".into(),
        s if s < 60 => format!("in {s}s"),
        s if s < 3600 => format!("in {}m", s / 60),
        s if s < 86400 => format!("in {}h {}m", s / 3600, s % 3600 / 60),
        s => format!("in {}d {}h", s / 86400, s % 86400 / 3600),
    }
}

/// Where `tmm send` takes a body (board #274). `plain` = no `--status` and
/// no image: only plain text can be a command, as in the composer.
#[derive(Debug, PartialEq, Eq)]
enum SendRoute {
    /// An ordinary room message (`hub_post`).
    Post,
    /// Typed verbatim into `to`'s CLI (`hub_command`; `to` may be `all`).
    Command { to: String, command: String },
    /// A command the sender addressed to itself: refused.
    ToSelf,
}

fn send_route(body: &str, from: &str, plain: bool) -> SendRoute {
    let Some((to, command)) = plain.then(|| tmux_mobile::address::slash_command(body)).flatten() else {
        return SendRoute::Post;
    };
    // `@human` is a chat recipient, never a command target (validator /
    // orchestrator 08:36): "@human /compact" is said to the person, as before.
    if to.is_empty() || to == "human" {
        SendRoute::Post
    } else if to == from {
        SendRoute::ToSelf
    } else {
        SendRoute::Command { to, command }
    }
}

/// Does this message name its own sender (board #283)? Only a managed
/// AGENT has a pane a line could be typed back into: `human` is the reserved
/// identity with none (`--agent human`, TMM_AGENT=human, or no agent at all),
/// and the human writing `@human` is addressing the person (orchestrator 14:28).
fn names_self(body: &str, agent: Option<&str>) -> bool {
    agent.is_some_and(|me| me != "human" && tmux_mobile::address::mention_names(body).iter().any(|n| n == me))
}

/// Is this `tmm` a descendant of the process in `agent`'s own pane — a call
/// the agent's turn made (board #285)? `$TMUX_PANE` alone cannot say: a
/// script started with nohup from that pane inherits it, then outlives the
/// turn under init. No `$TMUX_PANE` (cron, a k8s hook), a pane that is gone,
/// or a pane that is not `agent`'s window (a `tmm task` pane) is not the
/// agent's pane.
fn from_own_pane(agent: &str) -> bool {
    let Ok(pane) = std::env::var("TMUX_PANE") else { return false };
    match tmux_mobile::tmux::pane_window_and_pid(&pane) {
        Ok((window, pid)) => window == agent && descends_from(std::process::id(), pid, parent_pid),
        Err(_) => false,
    }
}

/// Does `start`'s parent chain reach `target` (itself included)? Bounded:
/// a malformed chain ends the walk, never loops. Pure over `parent`.
fn descends_from(start: u32, target: u32, parent: impl Fn(u32) -> Option<u32>) -> bool {
    let mut pid = start;
    for _ in 0..64 {
        if pid == target {
            return true;
        }
        match parent(pid) {
            Some(p) if p != pid && p > 0 => pid = p,
            _ => return false,
        }
    }
    false
}

/// A process's parent: `/proc/<pid>/stat` (the field after the `)` that
/// ends the command name, which may itself hold spaces or parens), else
/// `ps -o ppid=` where there is no /proc (macOS).
fn parent_pid(pid: u32) -> Option<u32> {
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        return stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok();
    }
    let out = std::process::Command::new("ps").args(["-o", "ppid=", "-p", &pid.to_string()]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

/// For a message that names its sender `me`: does anyone ELSE get it, and
/// which names reach nobody? `peers` are the room's managed agents. `@human`
/// is a real recipient (the person reads the room); `@all` is one when there
/// is another managed agent; any other name must be a managed agent. Pure.
fn others(names: &[String], me: &str, peers: &[String]) -> (bool, Vec<String>) {
    let mut reached = false;
    let mut unknown = Vec::new();
    for n in names.iter().filter(|n| *n != me) {
        let real = match n.as_str() {
            "human" => true,
            "all" => peers.iter().any(|p| p != me),
            _ => peers.contains(n),
        };
        if real {
            reached = true;
        } else if n != "all" && !unknown.contains(n) {
            unknown.push(n.clone());
        }
    }
    (reached, unknown)
}

/// `tmm board assign <id> <name|->`: the name to save, where a single `-`
/// means CLEAR (board #367). An empty string is what `hub_board_save` stores
/// for "nobody", and `-` is how a shell says that without quoting an empty
/// argument — the same spelling the UI's picker offers as its first row.
fn assign_target(raw: &str) -> &str {
    let name = raw.trim().trim_start_matches('@');
    if name == "-" { "" } else { name }
}

/// A mention no pane received, SAID where the sender is looking (board #347):
/// `tmm send`'s answer and a board hand-off's (board #377) both carry the
/// rows, and this is the one place that words them. Not an error: the line IS
/// in the room, and nothing is queued for the absent agent.
fn say_offline(r: &Value) {
    for row in r.get("offline").and_then(|v| v.as_array()).into_iter().flatten() {
        let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let why = row.get("why").and_then(|v| v.as_str()).unwrap_or("");
        if why == "unchecked" {
            // tmux could not be asked, so this says what is KNOWN and
            // nothing about whether the agent runs (board #347).
            eprintln!("note: @{name} was not typed to anyone's pane — tmux could not be asked whether it is online; nothing is queued for it");
        } else {
            eprintln!("note: @{name} is not online ({why}) — it was not typed to anyone's pane and nothing is queued for it");
        }
    }
}

/// How the telling went after a save that asked for a hand-off (board #377),
/// said where the person at the keyboard is looking. The save is already
/// committed, so none of this undoes it: `offline` is a note (the assignment
/// is on the board, nothing was typed to anyone, nothing is queued) and exits
/// 0; only `failed` is a failure, because the agent was not told and the
/// command did not finish what it was asked. Nothing to say when the save
/// handed nothing over (a clear, `human`, the actor itself).
fn settle_dispatch(id: i64, name: &str, r: &Value) {
    let error = r.get("dispatch_error").and_then(|v| v.as_str()).unwrap_or("");
    match r.get("dispatch").and_then(|v| v.as_str()) {
        Some("failed") => fail(EXIT_ERR, &format!(
            "the hand-off could not be posted: {error}\n\
             #{id} IS assigned to {name} on the board, but {name} was not told. Re-running \
             `tmm board assign {id} {name}` sends it again."
        )),
        Some("offline") => {
            if r.get("offline").and_then(|v| v.as_array()).is_some_and(|rows| !rows.is_empty()) {
                say_offline(r);
            } else if !error.is_empty() {
                eprintln!("note: {error}; nothing is queued for it");
            }
        }
        _ => {}
    }
}

/// The managed agents in a `hub_agents` answer.
fn managed_names(agents: &Value) -> Vec<String> {
    agents["agents"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|r| r["managed"].as_bool() == Some(true))
                .filter_map(|r| r["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tmux_mobile::build_info::Build;

    /// Board #368: `tmm gateway status` names the running gateway's build, says
    /// so plainly when an older gateway sends none, and shows which build THIS
    /// tmm is when the two differ (a gateway not restarted after an update).
    #[test]
    fn the_status_build_line_names_the_gateway_and_flags_a_stale_one() {
        let ours = Build { version: "1.0.0".into(), commit: "46392f16".into(), built: "2026-10-14 07:40".into() };
        assert_eq!(build_line(Some(&ours), &ours), "v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC");
        let stale = Build { commit: "0badc0de".into(), built: "2026-10-12 01:00".into(), ..ours.clone() };
        assert_eq!(
            build_line(Some(&stale), &ours),
            "v1.0.0 · 0badc0de · 2026-10-12 01:00 UTC — this tmm is v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC"
        );
        assert!(build_line(None, &ours).starts_with("unknown"), "an older gateway sends none");
    }

    use super::*;

    /// Board #274 (validator / orchestrator 08:36): the CLI's routing.
    /// `@human /x` stays a room message with its exact body; `@dev /compact`
    /// and `@all /clear` are commands; a command to yourself is refused;
    /// `--status`, an image, prose and a path are messages.
    #[test]
    fn tmm_send_routes_a_command_like_the_composer_but_never_to_the_human() {
        let cmd = |to: &str, c: &str| SendRoute::Command { to: to.into(), command: c.into() };
        assert_eq!(send_route("@dev /compact", "lead", true), cmd("dev", "/compact"));
        assert_eq!(send_route("@all /clear", "lead", true), cmd("all", "/clear"));
        assert_eq!(send_route("@ghost /compact", "lead", true), cmd("ghost", "/compact"), "the roster check, not the rule, refuses a ghost");
        assert_eq!(send_route("@human /compact", "lead", true), SendRoute::Post, "the human is told, not commanded");
        assert_eq!(send_route("@human /compact", "human", true), SendRoute::Post, "…from any sender, never a self-refusal");
        assert_eq!(send_route("@lead /compact", "lead", true), SendRoute::ToSelf);
        assert_eq!(send_route("@dev /compact", "lead", false), SendRoute::Post, "--status or an image: a message");
        assert_eq!(send_route("@dev please /compact", "lead", true), SendRoute::Post);
        assert_eq!(send_route("@dev /usr/bin/ls", "lead", true), SendRoute::Post);
        assert_eq!(send_route("/compact", "lead", true), SendRoute::Post, "no target: a message, as in the composer");
    }

    /// Board #285: the pane test walks the parent chain; a chain that reaches
    /// the pane's pid is the agent's turn, one that ends at init (a nohup'd
    /// watcher) or cycles is not.
    #[test]
    fn a_call_is_the_agents_turn_only_when_it_descends_from_the_pane() {
        let tree = |pairs: &'static [(u32, u32)]| move |pid: u32| pairs.iter().find(|(c, _)| *c == pid).map(|(_, p)| *p);
        // tmm 50 <- zsh 40 <- kiro 30 <- pane zsh 20 <- tmux 10 <- systemd 1
        let turn: &[(u32, u32)] = &[(50, 40), (40, 30), (30, 20), (20, 10), (10, 1)];
        assert!(descends_from(50, 20, tree(turn)));
        assert!(descends_from(20, 20, tree(turn)), "the pane's own process");
        // The same watcher after its turn ended: reparented to systemd.
        let orphan: &[(u32, u32)] = &[(60, 55), (55, 3789), (3789, 1)];
        assert!(!descends_from(60, 20, tree(orphan)));
        let cycle: &[(u32, u32)] = &[(70, 71), (71, 70)];
        assert!(!descends_from(70, 20, tree(cycle)), "bounded");
        assert!(!descends_from(80, 20, |_| None), "no parent known");
        // The real process table: this test descends from itself and from
        // its parent, and never from a pid it does not descend from.
        let me = std::process::id();
        assert!(descends_from(me, me, parent_pid));
        let parent = parent_pid(me).expect("a parent");
        assert!(descends_from(me, parent, parent_pid));
        assert!(!descends_from(parent, me, parent_pid));
    }

    /// Board #283 (orchestrator 14:28): a send is refused when it names its
    /// sender and nobody else real — alone, with an unknown name, or with
    /// @all in a room where the sender is the only agent; with a real peer
    /// or the human it goes, naming any unknown token. The human identity
    /// never trips it.
    #[test]
    fn a_send_to_yourself_is_refused_unless_someone_real_else_gets_it() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let names = |b: &str| tmux_mobile::address::mention_names(b);
        let me = Some("engineer");
        for body in ["@engineer [watcher] job done", "@engineer @engineer twice", "@architect @engineer x", "@engineer @all hi"] {
            assert!(names_self(body, me), "{body}");
        }
        for (body, agent) in [("@architect job done", me), ("@engineers similar", me), ("mail a@engineer", me), ("@human hi", None), ("@human /compact", Some("human")), ("@human @lead hi", Some("human"))] {
            assert!(!names_self(body, agent), "{body} as {agent:?}");
        }
        let room = v(&["engineer", "architect"]);
        let alone = v(&["engineer"]);
        assert_eq!(others(&names("@engineer only"), "engineer", &room), (false, v(&[])));
        assert_eq!(others(&names("@engineer @ghost x"), "engineer", &room), (false, v(&["ghost"])), "self + unknown");
        assert_eq!(others(&names("@engineer @all x"), "engineer", &alone), (false, v(&[])), "self + @all, no peers");
        assert_eq!(others(&names("@engineer @all x"), "engineer", &room), (true, v(&[])));
        assert_eq!(others(&names("@architect @engineer x"), "engineer", &room), (true, v(&[])), "self + a real peer");
        assert_eq!(others(&names("@architect @engineer @ghost x"), "engineer", &room), (true, v(&["ghost"])), "sent, the unknown named");
        assert_eq!(others(&names("@engineer @human look"), "engineer", &alone), (true, v(&[])), "the human reads the room");
    }

    /// `--in` / `--at` take a value; were they boolean, "10m" would join the text.
    #[test]
    fn in_and_at_are_valued_flags() {
        let args: Vec<String> = ["send", "@dev check", "--in", "10m", "--at", "14:30"].iter().map(|s| s.to_string()).collect();
        let (flags, pos, _) = split_flags(&args);
        assert_eq!(pos, vec!["send", "@dev check"]);
        assert_eq!(flags.get("in").cloned().flatten().as_deref(), Some("10m"));
        assert_eq!(flags.get("at").cloned().flatten().as_deref(), Some("14:30"));
        // Board #290: --re takes the quoted message's seq or id.
        let args: Vec<String> = ["send", "@lead which one?", "--re", "4127"].iter().map(|s| s.to_string()).collect();
        let (flags, pos, _) = split_flags(&args);
        assert_eq!(pos, vec!["send", "@lead which one?"]);
        assert_eq!(flags.get("re").cloned().flatten().as_deref(), Some("4127"));
    }

    /// Board #275: the two time doors.
    #[test]
    fn in_and_at_resolve_to_one_absolute_time() {
        assert_eq!(parse_in("90s"), Ok(90));
        assert_eq!(parse_in("10m"), Ok(600));
        assert_eq!(parse_in("1h30m"), Ok(5400));
        assert_eq!(parse_in("2d"), Ok(172800));
        for bad in ["", "10", "5s", "m", "10x", "1.5h", "-3m"] {
            assert!(parse_in(bad).is_err(), "{bad:?}");
        }
        use chrono::TimeZone;
        let now = chrono::Local.with_ymd_and_hms(2026, 9, 29, 8, 30, 0).unwrap();
        let at = |y, mo, d, h, mi| chrono::Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp();
        assert_eq!(parse_at("14:30", now), Ok(at(2026, 9, 29, 14, 30)), "later today");
        assert_eq!(parse_at("08:00", now), Ok(at(2026, 9, 30, 8, 0)), "already past today: tomorrow (orchestrator 08:20 C)");
        assert_eq!(parse_at("08:30", now), Ok(at(2026, 9, 30, 8, 30)), "now is not the future");
        assert_eq!(parse_at("2026-10-01 09:15", now), Ok(at(2026, 10, 1, 9, 15)));
        assert_eq!(parse_at("2026-10-01T09:15", now), Ok(at(2026, 10, 1, 9, 15)));
        assert!(parse_at("25:00", now).is_err());
        assert!(parse_at("tomorrow", now).is_err());
        assert_eq!(until(40), "in 40s");
        assert_eq!(until(21000), "in 5h 50m");
        assert_eq!(until(-5), "overdue");
    }

    #[test]
    fn a_task_end_wake_says_how_it_ended_and_addresses_only_its_target() {
        let body = task_end_body("lead", "build", "7", "", Some(125), "ok\nmail dev@x and @all please\n");
        assert!(body.starts_with("@lead task build exited:7 after 2m; last lines:\n```\n"), "{body}");
        assert_eq!(tmux_mobile::address::mention_names(&body), vec!["lead".to_string()], "the log's @all addresses nobody: {body}");
        assert_eq!(task_end_body("dev", "t", "", "15", None, ""), "@dev task t killed:15. Continue the work this task was for: read the output and post the result.");
        assert!(body.ends_with("```\nContinue the work this task was for: read the output and post the result."), "the instruction rides last, after the log: {body}");
        let shell = wake_shell("build", "lead", "/bin/tmm", &tasks::starter_env(Some("my proj"), Some("dev"), None, None));
        assert_eq!(shell, "TMM_PROJECT='my proj' TMM_AGENT='dev' '/bin/tmm' task wake 'build' --to 'lead' --code '#{pane_dead_status}' --signal '#{pane_dead_signal}' >/dev/null 2>&1");
        let human = wake_shell("a#b", "x", "/t", &tasks::starter_env(Some("p"), None, Some("/c"), Some("ws://s")));
        assert!(human.contains("'a##b'"), "a literal # is escaped for tmux");
        assert!(human.starts_with("TMM_PROJECT='p' TMM_AGENT='' XDG_CONFIG_HOME='/c' TMM_SERVER='ws://s' "), "{human}");
    }

    /// Board #277: the built-in tmm-cli skill is how an agent learns tmm, so
    /// every verb and flag `tmm --help` teaches for these capabilities must
    /// appear there too — else agents keep sleeping instead of waking.
    /// A name here that the help drops is caught too.
    #[test]
    fn the_tmm_cli_skill_teaches_what_the_help_teaches() {
        let skill = include_str!("../../../assets/skills/tmm-cli/SKILL.md");
        let help = usage();
        assert!(!help.contains("session unchanged"), "a rename moves the session (#278)");
        for term in ["tmm wake list", "tmm wake cancel", "--wake", "--in ", "--at ", "/compact", "tmm agent mode", "--input-mode", "tmm agent restart --team", "--re "] {
            assert!(help.contains(term), "help lost {term:?}");
            assert!(skill.contains(term), "the tmm-cli skill does not teach {term:?}");
        }
        // The backend list is the ONE derived list, in the skill as in the help.
        let backends = backends_help();
        assert!(help.contains(&backends));
        assert!(skill.matches(backends.as_str()).count() >= 2, "project create and registry save list every spawnable backend: {backends}");
        assert!(!skill.contains("--can-hire"), "a retired flag (2026-09-26)");
        // A chat line never cancels a turn, and a steered one IS read inside
        // it (#276): the skill must not teach either myth (validator 10:27).
        for myth in ["INTERRUPTS", "only read between turns", "the line lands in", "assignment lands in", "session unchanged"] {
            assert!(!skill.contains(myth), "the skill still says {myth:?}");
        }
        // Every address in an example is a PLACEHOLDER, a variable, all or
        // human (validator / orchestrator 10:21): an invented name such as
        // `@me` is typed to nobody, and an agent copying it is never woken.
        let placeholders = ["name", "who", "all", "human", "$TMM_AGENT"];
        let mut bad = Vec::new();
        for (i, _) in skill.match_indices('@') {
            if skill[..i].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric() || "_.-".contains(c)) {
                continue; // an email / host, not an address
            }
            let token: String = skill[i + 1..].chars().take_while(|c| c.is_ascii_alphanumeric() || "_-$".contains(*c)).collect();
            if !token.is_empty() && !placeholders.contains(&token.as_str()) {
                bad.push(token);
            }
        }
        assert!(bad.is_empty(), "the skill addresses names that exist nowhere: {bad:?}");
        // The self-wake example resolves to the SENDER: with TMM_AGENT=dev the
        // shell turns it into an address the server reads as `dev` (the
        // delivery rule, address::mention_names), which a fired wake types
        // into dev's own pane.
        let example = skill.lines().find(|l| l.contains("--in 10m")).expect("a self-wake example");
        let body = example.split('"').nth(1).expect("quoted body").replace("$TMM_AGENT", "dev");
        assert_eq!(tmux_mobile::address::mention_names(&body), vec!["dev".to_string()], "{example}");
    }

    #[test]
    fn only_managed_rows_are_command_targets() {
        let agents = json!({ "agents": [
            { "name": "zsh", "managed": false }, { "name": "dev", "managed": true }, { "name": "hand", "managed": false },
        ] });
        assert_eq!(managed_names(&agents), vec!["dev".to_string()]);
        assert!(managed_names(&json!({})).is_empty());
    }

    #[test]
    fn board_images_are_references_in_the_body_like_send() {
        // Board #329: `board add --image` / `board note --image` reuse send's
        // shape exactly — one ref per line after the text, paths absolute.
        let args: Vec<String> = ["board", "note", "3", "see", "--image", "/a.png", "--image", "https://x/b.png"]
            .iter().map(|s| s.to_string()).collect();
        let (_flags, pos, repeated) = split_flags(&args);
        assert_eq!(pos, vec!["board", "note", "3", "see"]);
        let refs = image_refs(&repeated);
        assert_eq!(with_images("see", &refs), "see\n![](/a.png)\n![](https://x/b.png)");
        assert_eq!(with_images("", &refs[..1]), "![](/a.png)", "an image alone is a whole note");
        let rel = image_refs(&[("image".into(), "shot.png".into())]);
        assert!(std::path::Path::new(rel[0].as_str()).is_absolute(), "a relative path is made absolute: {}", rel[0]);
        assert_eq!(with_images("text", &[]), "text");
    }

    #[test]
    fn repeated_valued_flags_survive_the_map() {
        // The flag map keeps one value per key; `--image` may appear twice, and
        // the third return is what stops the first one being silently lost.
        let args: Vec<String> = ["send", "look", "--image", "a.png", "--image", "b.png"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (flags, pos, repeated) = split_flags(&args);
        assert_eq!(pos, vec!["send", "look"], "the text stays positional");
        assert_eq!(flags.get("image").cloned().flatten().as_deref(), Some("b.png"), "map keeps the last");
        let images: Vec<&str> = repeated.iter().filter(|(k, _)| k == "image").map(|(_, v)| v.as_str()).collect();
        assert_eq!(images, vec!["a.png", "b.png"], "both reach the sender");
    }

    #[test]
    fn registry_save_takes_an_input_mode_value() {
        // Board #245: `--input-mode` is a VALUED flag; were it boolean, its
        // value would fall out as a positional and the def would save queue.
        let args: Vec<String> = ["registry", "save", "--name", "dev", "--input-mode", "steer", "--backend", "kiro"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let (flags, pos, _) = split_flags(&args);
        assert_eq!(flags.get("input-mode").cloned().flatten().as_deref(), Some("steer"));
        assert_eq!(flags.get("backend").cloned().flatten().as_deref(), Some("kiro"));
        assert_eq!(pos, vec!["registry", "save"]);
    }

    /// Board #367: there was no way to hand an OPEN issue to another agent
    /// — `take` claims it for the caller and `--assignee` only works at
    /// creation — so the orchestrator could not do from the CLI what the UI
    /// does with its picker. `-` is how a shell spells "nobody". (The
    /// hand-off text is the server's since board #377 and is pinned in
    /// `hub_rpc`.)
    #[test]
    fn board_assign_reads_a_name_or_a_dash() {
        // The `-` has to SURVIVE the flag parser to reach `assign_target`.
        // It did not, and only running the verb showed it: a lone `-` became
        // a flag named "" and `board assign 3 -` answered "needs a name".
        let args: Vec<String> = ["board", "assign", "3", "-"].iter().map(|s| s.to_string()).collect();
        let (flags, pos, _) = split_flags(&args);
        assert_eq!(pos, vec!["board", "assign", "3", "-"], "a lone dash is a positional");
        assert!(flags.is_empty(), "and not a nameless flag");
        // A real flag still parses, and so does a valued one after a dash.
        let args: Vec<String> = ["board", "assign", "3", "-", "--output", "json"].iter().map(|s| s.to_string()).collect();
        let (flags, pos, _) = split_flags(&args);
        assert_eq!(pos, vec!["board", "assign", "3", "-"]);
        assert_eq!(flags.get("output").cloned().flatten().as_deref(), Some("json"));

        assert_eq!(super::assign_target("builder-2"), "builder-2");
        assert_eq!(super::assign_target("  @builder-2 "), "builder-2", "an @ is how the room spells a name");
        assert_eq!(super::assign_target("-"), "", "the one spelling of nobody");
        assert_eq!(super::assign_target("human"), "human");
    }

    #[test]
    fn send_distinguishes_addressed_messages_from_ambient_status() {
        assert!(has_address("@reviewer please check"));
        assert!(has_address("please check @reviewer."));
        assert!(!has_address("progress without a recipient"));

        let args: Vec<String> =
            ["send", "compiling", "--status"].iter().map(|s| s.to_string()).collect();
        let (flags, pos, _) = split_flags(&args);
        assert!(flags.contains_key("status"));
        assert_eq!(pos, vec!["send", "compiling"]);
    }

    #[test]
    fn log_timestamps_are_readable_local_time() {
        // The rendered value is LOCAL, so assert the
        // shape and that it round-trips through the same conversion rather than
        // hard-coding a zone the CI box may not share.
        let ms = 1_755_419_460_000_i64;   // 2025-08-17 08:31:00 UTC
        let got = local_stamp(ms);
        assert_eq!(got.len(), 16, "YYYY-MM-DD HH:MM, got {got:?}");
        assert!(got.starts_with("2025-08-1"), "the right day, got {got:?}");
        assert_eq!(
            got,
            chrono::DateTime::from_timestamp_millis(ms)
                .unwrap()
                .with_timezone(&chrono::Local)
                .format("%Y-%m-%d %H:%M")
                .to_string()
        );
        // A nonsense value degrades to the raw number instead of panicking.
        assert_eq!(local_stamp(i64::MAX), i64::MAX.to_string());
    }

    #[test]
    fn image_references_are_resolved_for_a_reader_somewhere_else() {        // URLs pass through untouched.
        for url in ["https://x/y.png", "http://x/y.png", "data:image/png;base64,AA"] {
            assert_eq!(absolutize_ref(url), url);
        }
        // An absolute path is already meaningful on the server's machine.
        assert_eq!(absolutize_ref("/tmp/shot.png"), "/tmp/shot.png");
        // A relative one is not: the reader is a phone, not this shell.
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(
            absolutize_ref("shot.png"),
            cwd.join("shot.png").to_string_lossy().to_string()
        );
        // `~` is the agent's home, expanded here rather than shipped as a tilde.
        if let Some(home) = std::env::var_os("HOME") {
            assert_eq!(
                absolutize_ref("~/shot.png"),
                std::path::Path::new(&home).join("shot.png").to_string_lossy().to_string()
            );
        }
    }
}
