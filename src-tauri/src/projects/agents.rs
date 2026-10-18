//! Which agent CLI is running in a pane, and how to start it again.
//!
//! One table, two uses: detection during capture and the launch line `up`
//! replays. Keeping them together is the point — a detector that recognises
//! "codex" but relaunches something else would silently rebuild the wrong
//! workspace. P2 replaces this table with the real agent definitions on disk
//! (see `docs/exec-plans/projects-and-tasks.md` §5); until then it stays
//! deliberately small.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KnownAgent {
    /// Stable name we store in the slot.
    pub backend: &'static str,
    /// The executable file names this CLI runs as (`kiro-cli`, `codex` or
    /// `codex.js` under node), matched EXACTLY by `by_program` (board #260).
    pub programs: &'static [&'static str],
    /// What `up` runs when there is no conversation to go back to.
    pub launch: &'static str,
    /// Resume the newest conversation **of this directory**. `None` where the
    /// CLI has no directory-scoped resume — see `codex` below.
    pub resume_recent: Option<&'static str>,
    /// Resume one exact conversation; `{id}` is substituted.
    pub resume_id: Option<&'static str>,
    /// The CLI's ONE documented install layout whose binary name does not
    /// say what it is: `Some("claude/versions")` means a binary at
    /// `…/claude/versions/<version>` is this CLI (board #260). Detection reads
    /// no other directory — a path is a label.
    pub versioned_binary_dir: Option<&'static str>,
}

use crate::tmux::TmuxPane;

/// The detection/relaunch table, one row per recognisable CLI. The six
/// SPAWNABLE backends contribute their rows from their own files
/// (`Backend::known`, board #129 — resume strings and the recipe resume
/// dialect are one file per backend now, closing todo §D2); openclaw is
/// DETECTION-ONLY — recognised in panes, never spawnable, no resume wired up
/// because its flags are unverified here (it relaunches clean rather than
/// guess). kimi moved from this list to a backend of its own (board #224).
fn known() -> &'static [KnownAgent] {
    static KNOWN: std::sync::OnceLock<Vec<KnownAgent>> = std::sync::OnceLock::new();
    KNOWN.get_or_init(|| {
        let mut rows = vec![
            KnownAgent {
                backend: "openclaw",
                programs: &["openclaw"],
                launch: "openclaw",
                resume_recent: None,
                resume_id: None,
                versioned_binary_dir: None,
            },
        ];
        rows.extend(crate::backends::Backend::ALL.into_iter().map(|b| b.known()));
        rows
    })
}

/// The backends `spawn` can materialize an isolated home for — the ONE list
/// `registry_save`, team validation and the CLI help read, so adding a
/// backend cannot miss a validator again (omp did, 2026-09-07: the render
/// arm existed while `registry_save` still said "must be kiro|claude|codex|
/// grok"). Detection (`KNOWN`) is wider: openclaw is recognized in panes but
/// not spawnable.
pub const SPAWNABLE_BACKENDS: &[&str] = &crate::backends::Backend::NAMES;

/// The longest agent name we accept — a tmux window name and a directory
/// component; anything longer is a mistake, not an identity.
pub const MAX_NAME_LEN: usize = 64;

/// Is `name` something an agent may be called?
///
/// The name is reused in FOUR places with four parsers, and the rule is the
/// intersection of what all of them treat as a plain word:
///
/// * a directory component under `<ws>/.tmm/agents/` — so no `/`, `\`, NUL,
///   and never the components `.` or `..` (`agent_remove("../..")` resolved to
///   the workspace itself, which `is_dir()`, and would have deleted it);
/// * a tmux window name that also appears inside targets (`session:name.pane`)
///   — so no `:` `.` `=` (tmux's target separators and exact-match prefix) and
///   no whitespace or glob characters (`*` `?` `[`), which tmux matches as a
///   pattern;
/// * the first argv element after a flag on the CLI (`tmm agent remove <name>`)
///   — so it cannot start with `-`;
/// * an `@name` address in chat — so no whitespace or `@`.
///
/// A whitelist is the only shape of that rule that stays true when a fifth
/// parser arrives: letters and digits (any script — a Chinese agent name is
/// an ordinary name), `-` and `_`, starting with a letter or digit, at most
/// `MAX_NAME_LEN` characters.
pub fn valid_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("agent name must not be empty".into());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("agent name must be at most {MAX_NAME_LEN} characters"));
    }
    if !name.chars().next().is_some_and(char::is_alphanumeric) {
        return Err(format!(
            "agent name '{name}' must start with a letter or digit — it is a window name, a directory and an @address"
        ));
    }
    // One definition of a name character, shared with the address parser
    // (`address::name_char`, board #248).
    if let Some(bad) = name.chars().find(|c| !crate::address::name_char(*c)) {
        return Err(format!(
            "agent name '{name}' cannot contain '{bad}' — only letters, digits, '-' and '_' survive tmux targets, paths and @addresses unchanged"
        ));
    }
    Ok(())
}

/// The isolated home of `name` under `workspace`, or `None` for a name that
/// must never become a path (see `valid_name`). Every `<ws>/.tmm/agents/<x>`
/// path in the projects module is built here, so no caller can skip the check.
pub fn home_dir(workspace: &str, name: &str) -> Option<std::path::PathBuf> {
    valid_name(name).ok()?;
    Some(std::path::Path::new(workspace).join(".tmm").join("agents").join(name))
}

/// The agent in a MANAGED window: the launch recipe's recorded backend first,
/// the pane's process-derived agent (`TmuxPane::agent`) as the fallback for
/// windows we did not create.
///
/// The process evidence can be empty for a backend we ourselves spawned (an
/// interpreter whose argv was clipped, a `ps` that failed), and a managed
/// window that fell back to a shell is still that agent's slot for delivery,
/// the roster, vitals and recovery (found live 2026-08-22: a spawned cx-probe
/// never received its @mention). We WROTE the backend into `launch.json` at
/// spawn — for our own windows the record beats the sniff.
fn recipe_agent(workspace: Option<&str>, window_name: &str) -> Option<&'static KnownAgent> {
    let recipe = workspace.and_then(|ws| home_dir(ws, window_name))?.join("launch.json");
    let backend = std::fs::read_to_string(recipe)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("backend").and_then(|b| b.as_str().map(str::to_owned)))?;
    known().iter().find(|a| a.backend == backend)
}

/// Interpreters whose SCRIPT is the program: the npm codex is `node
/// …/bin/codex`, a Python CLI can be `python3 …/bin/kimi-code`.
fn is_interpreter(base: &str) -> bool {
    matches!(base, "node" | "nodejs" | "bun" | "deno" | "python" | "python3")
        || base.strip_prefix("python3.").is_some_and(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
}

/// The last path component: what a process is CALLED, not where it lives.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// The CLI whose documented versioned layout `path` is
/// (`KnownAgent::versioned_binary_dir`): `…/<dir>/<version>`, version made
/// of digits and dots. Claude Code installs this way (projects.md), so its
/// process name is a bare version and only the directories above say what it
/// is. The ONE path shape detection reads (orchestrator, #260) — every other
/// directory is a label (`~/work/kiro-tools/bin/deploy` is not kiro).
fn versioned_binary(path: &str) -> Option<&'static KnownAgent> {
    let (parent, version) = path.rsplit_once('/')?;
    let is_version = version.bytes().any(|b| b.is_ascii_digit())
        && version.bytes().all(|b| b.is_ascii_digit() || b == b'.');
    if !is_version {
        return None;
    }
    known().iter().find(|a| {
        a.versioned_binary_dir
            .is_some_and(|dir| parent.strip_suffix(dir).is_some_and(|rest| rest.is_empty() || rest.ends_with('/')))
    })
}

/// The CLI a program NAME is: exactly one of a backend's `programs`, after
/// dropping a script extension (`codex.js`). Exact, not a word match: the
/// helper `kiro-web-search` is not the `kiro-cli` CLI, and `docker-compose`
/// is not `omp` (validator, board #260).
fn by_program(name: &str) -> Option<&'static KnownAgent> {
    let name = [".js", ".mjs", ".cjs", ".py"]
        .iter()
        .find_map(|ext| name.strip_suffix(ext))
        .unwrap_or(name);
    known().iter().find(|a| a.programs.iter().any(|p| p.eq_ignore_ascii_case(name)))
}

/// The CLI one process RUNS, from its argv, by NAME only: argv[0]'s file
/// name and, when that is an interpreter, its script's file name (first
/// non-flag argument). Never another argument — `rg grok`, `vim kiro.md`
/// and `uvx kiro-web-search` name an agent in an argument while running
/// something else (validator, board #260) — and never a directory, except
/// a CLI's documented versioned layout (`versioned_binary`).
fn process_agent(argv: &str) -> Option<&'static KnownAgent> {
    let mut args = argv.split_whitespace();
    let exe = args.next()?;
    if let Some(agent) = versioned_binary(exe) {
        return Some(agent);
    }
    let name = file_name(exe);
    if is_interpreter(name) {
        return args.find(|a| !a.starts_with('-')).and_then(|script| by_program(file_name(script)));
    }
    by_program(name)
}

/// The agent a pane's PROCESSES run, shallow → deep (board #260): the
/// process tmux reports in the foreground (`pane_current_command`), then,
/// per process on the chain from the pane process down (`argvs`), the
/// program it runs (`process_agent`); the shallowest match wins, since a
/// deeper one is a subprocess the agent spawned — where an interpreter-launched CLI such
/// as the npm codex (`node …/bin/codex`) or Claude Code (a version-named
/// binary under `…/claude/versions/`) finally says its own name. Each level
/// is read on its own: an argument is data, not the program.
///
/// Labels are NOT evidence. `pane_title` is whatever the last CLI wrote with
/// an OSC title sequence and nothing resets it when that CLI exits: the
/// owner's `tmux-mobile:1` read `current_command zsh, title grok` after grok
/// quit, and the old haystack (command + title + window name + child argv)
/// painted the shell as grok. The window name is a label too — a window named
/// after the kirocrew project is not kiro. ONE function, called once per pane
/// in the listing (`tmux::parse_pane_lines`), so the server and the client
/// read the same verdict off `TmuxPane::agent` instead of each re-deriving it.
pub fn detect_processes(current_command: &str, argvs: &[&str]) -> Option<&'static KnownAgent> {
    by_program(current_command).or_else(|| argvs.iter().find_map(|argv| process_agent(argv)))
}

/// The agent in `pane`: its launch recipe first (managed windows), its
/// process-derived agent second — the one way to ask about a pane.
pub fn detect_pane(workspace: Option<&str>, pane: &TmuxPane) -> Option<&'static KnownAgent> {
    recipe_agent(workspace, &pane.window_name)
        .or_else(|| pane.agent.and_then(|b| known().iter().find(|a| a.backend == b)))
}

/// The launch line for a backend name we stored earlier.
///
/// Restoring a workspace should put you back in the conversation, not in a
/// blank prompt, so the exact conversation id wins when we have one, a
/// directory-scoped resume is the next best thing, and a clean start is the
/// last resort.
pub fn launch_line(backend: &str, session_id: Option<&str>) -> Option<String> {
    let agent = known().iter().find(|a| a.backend == backend)?;
    if let (Some(id), Some(template)) = (session_id.filter(|s| !s.is_empty()), agent.resume_id) {
        return Some(template.replace("{id}", id));
    }
    Some(agent.resume_recent.unwrap_or(agent.launch).to_string())
}

/// The plain launch line, ignoring any conversation history.
pub fn launch_for(backend: &str) -> Option<&'static str> {
    known().iter().find(|a| a.backend == backend).map(|a| a.launch)
}

/// The generic exact-resume line (`resume_id` with `{id}` substituted), or
/// `None` — never the recent or blank fallbacks of `launch_line`. The strict
/// door for an ADOPTED agent window in a restore after a reboot (board #422).
pub fn launch_line_exact(backend: &str, session_id: &str) -> Option<String> {
    // The backend's own id rule (no option-shaped recent selector), and the
    // id goes in as ONE shell-quoted data argument (review P1-E).
    if !crate::backends::Backend::parse(backend)?.exact_id_ok(session_id) {
        return None;
    }
    let template = known().iter().find(|a| a.backend == backend)?.resume_id?;
    Some(template.replace("{id}", &crate::shell::quote(session_id)))
}

/// Can `backend` go back to ONE exact conversation from the generic line
/// (`resume_id`)? A restore after a reboot relaunches an adopted agent only
/// then — never into "the newest one here" or a blank prompt (board #422).
pub fn resumes_exactly(backend: &str) -> bool {
    known().iter().any(|a| a.backend == backend && a.resume_id.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Board #248 (orchestrator): the name rule and the address parser are ONE
    /// definition. Every valid name reads back whole from `@name` followed by
    /// any punctuation, and a character `valid_name` refuses ends an address.
    #[test]
    fn every_valid_name_is_addressable_whole() {
        for name in ["bob", "builder-2", "dev_squad", "翻译", "राम", "kiro-v3_1", "a1"] {
            assert!(valid_name(name).is_ok(), "{name}");
            for tail in ["", " hi", ",", "。", ")", "**", ": x", "!"] {
                assert_eq!(crate::address::mention_names(&format!("(@{name}{tail}")), vec![name.to_string()], "{name}{tail}");
            }
        }
        for bad in ['.', ':', '/', '@', '*', ' '] {
            assert!(valid_name(&format!("bob{bad}x")).is_err(), "{bad:?} is not a name character");
        }
    }

    #[test]
    fn detects_the_shallowest_agent_not_the_first_listed() {
        // codex spawning a kiro-cli subprocess: the deeper kiro loses.
        let a = detect_processes("node", &["-zsh", "node /Users/me/.codex/bin/codex", "kiro-cli chat"]).unwrap();
        assert_eq!(a.backend, "codex");
    }

    /// The rule that keeps a name from becoming a path or a tmux pattern.
    /// `../..` is the case that mattered: `agent_remove` joined it under
    /// `<ws>/.tmm/agents/`, landed on the workspace itself, and
    /// `remove_dir_all` would have taken the whole project.
    #[test]
    fn a_name_is_a_plain_word_or_nothing() {
        for ok in ["lead", "builder-2", "cx_probe", "经理", "a", "Z9"] {
            assert!(valid_name(ok).is_ok(), "{ok} is an ordinary name");
        }
        for bad in [
            "", ".", "..", "../..", "a/b", "a\\b", "-flag", "_lead", "a b", "a.b", "a:b", "a=b",
            "a*", "a?", "a[1]", "@lead", "a\0b", "a\nb",
        ] {
            assert!(valid_name(bad).is_err(), "{bad:?} must be rejected");
        }
        assert!(valid_name(&"x".repeat(MAX_NAME_LEN)).is_ok());
        assert!(valid_name(&"x".repeat(MAX_NAME_LEN + 1)).is_err());
    }

    fn pane(cmd: &str, title: &str, window_name: &str, child: &str) -> TmuxPane {
        TmuxPane {
            session: "s".into(),
            window: 1,
            pane: 0,
            width: 80,
            height: 24,
            current_command: cmd.into(),
            window_name: window_name.into(),
            pane_title: title.into(),
            current_path: "/w".into(),
            active: true,
            child_cmd: child.into(),
            agent: detect_processes(cmd, &["-zsh", child]).map(|a| a.backend),
        }
    }

    /// Board #260, the owner's case: grok exited, its OSC title stayed. A
    /// shell with a stale agent title, or an agent-named window, and no agent
    /// process is a shell — labels are not evidence.
    #[test]
    fn a_stale_title_or_window_name_is_not_an_agent() {
        // tmux-mobile:1 measured 2026-09-28: current_command zsh, title grok.
        assert!(detect_pane(None, &pane("zsh", "grok", "zsh", "")).is_none());
        for label in ["kiro", "claude", "Claude Code", "codex", "grok", "omp", "kimi", "openclaw"] {
            assert!(detect_pane(None, &pane("zsh", label, "w", "")).is_none(), "title {label}");
            assert!(detect_pane(None, &pane("bash", "~", label, "")).is_none(), "window {label}");
        }
        assert!(detect_pane(None, &pane("zsh", "~", "shell", "")).is_none());
    }

    /// Each backend is found by its PROCESSES alone, spelled the way this
    /// host's panes spell them (`ps -o args`, 2026-09-28), with a title that
    /// says nothing — and the process tmux started still outranks a
    /// subprocess (shallow → deep).
    #[test]
    fn every_backend_is_found_by_its_processes() {
        for (cmd, child, want) in [
            ("kiro-cli", "kiro-cli chat --agent builder --trust-all-tools", "kiro"),
            ("claude", "claude --mcp-config /w/.tmm/agents/lead/mcp.json", "claude"),
            ("2.1.141", "/home/u/.local/share/claude/versions/2.1.141 --resume", "claude"),
            ("node", "node /home/u/.local/bin/codex -c mcp_servers.kiro-web-search.command=uvx", "codex"),
            ("grok", "grok --model grok-code", "grok"),
            ("omp", "/home/u/.local/bin/omp --continue", "omp"),
            ("kimi-code", "kimi-code uv tool uvx kiro-web-search", "kimi"),
        ] {
            assert_eq!(detect_pane(None, &pane(cmd, "host.example.com", "w", child)).map(|a| a.backend), Some(want), "{cmd}");
        }
        // The pane process itself is evidence too: a window created with the
        // CLI as its command has no shell above it (`node codex.js` is root).
        assert_eq!(detect_processes("node", &["node /x/@openai/codex/bin/codex.js"]).map(|a| a.backend), Some("codex"));
        assert_eq!(detect_processes("node", &["-zsh", "node --no-warnings /x/codex.js resume abc"]).map(|a| a.backend), Some("codex"));
        assert_eq!(detect_processes("python3", &["-zsh", "/usr/bin/python3.12 /home/u/.local/bin/kimi-code"]).map(|a| a.backend), Some("kimi"));
        // Shallow beats deep: the process tmux started wins over a subprocess.
        assert_eq!(detect_processes("kiro-cli", &["-zsh", "kiro-cli chat", "node kiro-web-search"]).map(|a| a.backend), Some("kiro"));
    }

    /// Validator on board #260: an agent's name in an ARGUMENT is not an
    /// agent. Only each process's executable (and an interpreter's script)
    /// counts, level by level.
    #[test]
    fn an_agent_named_in_an_argument_is_not_an_agent() {
        for argv in [
            "rg grok",
            "vim notes/kiro.md",
            "git log --grep codex",
            "uvx kiro-web-search",
            "/local/home/u/.local/bin/uv tool uvx kiro-web-search",
            "tail -f /tmp/claude.log",
            "node server.js --name omp",
            "python3 -m http.server --bind kimi",
            // A directory is a label (orchestrator, #260).
            "/home/u/work/kiro-tools/bin/deploy",
            "/home/u/claude-notes/run --fast",
            "node /home/u/codex-scratch/server.js",
            "/opt/grok/bin/python3 /srv/app/main.py",
            "/home/u/.local/share/claude/versions/latest-notes",
            "/home/u/tools/versions/2.1.141",
        ] {
            let cmd = argv.split_whitespace().next().unwrap().rsplit('/').next().unwrap();
            assert!(detect_processes(cmd, &["-zsh", argv]).is_none(), "{argv}");
        }
    }

    #[test]
    fn an_invalid_name_has_no_home() {
        assert!(home_dir("/tmp/ws", "../..").is_none());
        assert!(home_dir("/tmp/ws", "").is_none());
        assert_eq!(
            home_dir("/tmp/ws", "lead").as_deref(),
            Some(std::path::Path::new("/tmp/ws/.tmm/agents/lead"))
        );
    }

    /// Validator on #260: a program is its EXACT name, not a word inside
    /// it. `kiro-web-search` (this project's live MCP helper) and
    /// `docker-compose` contain agent words at hyphen boundaries; run
    /// directly, or as the child uvx starts, they are not agents.
    #[test]
    fn a_program_is_its_exact_name_not_a_word_in_it() {
        for chain in [
            &["-zsh", "kiro-web-search --help"][..],
            &["-zsh", "/home/u/.local/bin/uv tool uvx kiro-web-search", "/home/u/.cache/uv/archive-v0/x/bin/python /home/u/.cache/uv/archive-v0/x/bin/kiro-web-search"],
            &["-zsh", "docker-compose up"],
            &["-zsh", "node component-lab"],
            &["-zsh", "kirocrew-in-agentcore"],
            &["-zsh", "claude-code-router start"],
            &["-zsh", "/usr/bin/grok-tools"],
        ] {
            let cmd = file_name(chain.last().unwrap().split_whitespace().next().unwrap());
            assert!(detect_processes(cmd, chain).is_none(), "{chain:?}");
        }
        // kimi-code keeps its identity over the kiro-web-search helper it runs.
        assert_eq!(detect_processes("kimi-code", &["-zsh", "kimi-code", "uvx kiro-web-search"]).map(|a| a.backend), Some("kimi"));
        assert_eq!(detect_processes("omp", &["-zsh"]).map(|a| a.backend), Some("omp"));
    }

    /// Every spawnable backend must also be detectable/relaunchable: the
    /// KNOWN table is what `up`, restart and adoption read.
    #[test]
    fn every_spawnable_backend_is_known() {
        for b in SPAWNABLE_BACKENDS {
            assert!(known().iter().any(|a| a.backend == *b), "{b} missing from KNOWN");
        }
    }

    /// Every spelling each CLI runs under on this host, by current_command
    /// alone and by argv alone.
    #[test]
    fn each_backend_program_name_is_recognised() {
        for (name, want) in [
            ("kiro-cli", "kiro"), ("kiro-cli-chat", "kiro"), ("claude", "claude"), ("codex", "codex"),
            ("codex.js", "codex"), ("grok", "grok"), ("omp", "omp"), ("kimi", "kimi"), ("kimi-code", "kimi"),
            ("openclaw", "openclaw"),
        ] {
            assert_eq!(by_program(name).map(|a| a.backend), Some(want), "{name}");
            let argv = format!("/x/bin/{name} --flag");
            assert_eq!(detect_processes("zsh", &["-zsh", &argv]).map(|a| a.backend), Some(want), "{name}");
        }
    }

    #[test]
    fn claude_is_found_through_its_version_named_binary_path() {
        let a = detect_processes("2.1.141", &["-zsh", "/Users/me/.local/share/claude/versions/2.1.141"]).unwrap();
        assert_eq!(a.backend, "claude");
        assert_eq!(a.launch, "claude");
    }

    #[test]
    fn a_plain_shell_is_not_an_agent() {
        assert!(detect_processes("zsh", &["-zsh"]).is_none());
        assert!(detect_processes("npm", &["-zsh", "npm run dev"]).is_none());
        assert!(detect_processes("", &[]).is_none());
    }

    #[test]
    fn launch_lines_round_trip_by_backend_name() {
        assert_eq!(launch_for("kiro"), Some("kiro-cli chat"));
        assert_eq!(launch_for("nope"), None);
    }

    #[test]
    fn a_recorded_conversation_id_beats_a_directory_resume() {
        assert_eq!(
            launch_line("kiro", Some("abc-123")).as_deref(),
            Some("kiro-cli chat --resume-id abc-123")
        );
        assert_eq!(
            launch_line("claude", Some("abc-123")).as_deref(),
            Some("claude --resume abc-123")
        );
        assert_eq!(
            launch_line("codex", Some("abc-123")).as_deref(),
            Some("codex resume abc-123")
        );
    }

    #[test]
    fn without_an_id_we_resume_this_directory_where_the_cli_can() {
        assert_eq!(launch_line("kiro", None).as_deref(), Some("kiro-cli chat --resume"));
        assert_eq!(launch_line("claude", None).as_deref(), Some("claude --continue"));
        // The generic path shares ~/.codex: --last could cross projects, so
        // no id means a clean start. Managed recipes use isolated CODEX_HOME
        // and may safely use cwd-filtered `resume --last` (spawn.rs).
        assert_eq!(launch_line("codex", None).as_deref(), Some("codex"));
        // kimi's `-c` is cwd-scoped ("Continue the previous session for the
        // working directory"), `-S <id>` exact (board #224).
        assert_eq!(launch_line("kimi", None).as_deref(), Some("kimi -c"));
        assert_eq!(launch_line("kimi", Some("session_x")).as_deref(), Some("kimi -S session_x"));
        // omp's --continue is cwd-scoped (sessions live per encoded cwd), so
        // the recent fallback is safe; an exact id wins when recorded.
        assert_eq!(launch_line("omp", None).as_deref(), Some("omp --continue"));
        assert_eq!(launch_line("omp", Some("abc-123")).as_deref(), Some("omp --resume abc-123"));
        assert_eq!(launch_line("", Some("x")), None);
    }

    #[test]
    fn an_empty_id_is_not_a_conversation() {
        assert_eq!(launch_line("kiro", Some("")).as_deref(), Some("kiro-cli chat --resume"));
    }

    /// The exact live failure (2026-08-22): a spawned codex runs under the
    /// npm `node` shim — pane shows `cmd=node`, title = project name, window
    /// name = agent name; nothing says "codex", so the sniff misses and the
    /// window fell out of delivery/roster/vitals/recovery. The recipe we
    /// wrote at spawn is the record, so it wins for managed windows.
    #[test]
    fn a_managed_window_is_detected_by_its_recipe_not_its_process_name() {
        let ws = std::env::temp_dir().join(format!("tmm-detect-{}", std::process::id()));
        let home = ws.join(".tmm").join("agents").join("cx-probe");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("launch.json"), r#"{"backend":"codex","cmd":"command codex"}"#).unwrap();
        // measured: cmd node, title = project, window = agent name, no argv clue
        let probe = pane("node", "bedrock-e2e", "cx-probe", "");
        assert!(probe.agent.is_none(), "the processes alone say nothing — that is the bug");
        let hit = detect_pane(Some(ws.to_str().unwrap()), &probe);
        assert_eq!(hit.map(|a| a.backend), Some("codex"), "the recipe is the record");
        // No workspace (a hand-started window) reads the processes only.
        assert!(detect_pane(None, &probe).is_none());
        assert_eq!(
            detect_pane(None, &pane("kiro-cli", "t", "w", "kiro-cli chat")).map(|a| a.backend),
            Some("kiro")
        );
        // A recipe naming an unknown backend falls back to the processes.
        std::fs::write(home.join("launch.json"), r#"{"backend":"martian"}"#).unwrap();
        assert!(detect_pane(Some(ws.to_str().unwrap()), &probe).is_none());
        std::fs::remove_dir_all(&ws).ok();
    }
}
