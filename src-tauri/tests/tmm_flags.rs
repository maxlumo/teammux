//! `tmm`'s flag door through the REAL binary (board #456). Four things are pinned here:
//!
//! 1. A flag the command does not read is refused BEFORE anything runs: exit 5, nothing on
//!    stdout, the flag named, and nothing created or started. The rows run with an empty HOME
//!    and a PATH that holds no `tmux` and no service manager, so a refusal that came too late
//!    would show as a file, a child, or a different exit code.
//! 2. Text that begins with a dash is text (`- done`), `--` ends flags, `--name=value` and
//!    `--args-json '{…}'` mean what they say, and a valued flag without a value is refused.
//! 3. The sub-verb-specific flags of the commands that share one dispatch arm are CONSUMED by the
//!    sub-verb that lists them: changing the flag's value changes what is sent (the source scan
//!    in `tmm.rs` sees arms, not sub-verbs).
//! 4. `--help` is the one exception.
//!
//! The fake gateway speaks what `try_rpc` speaks: plain token auth as id 1, then calls from id 2,
//! each answered `{ok:true,id:12}` and recorded.
#![cfg(target_os = "linux")]

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

struct Fake {
    calls: Calls,
    addr: String,
    /// Set on drop: the accept loop ends and the thread is joined, so a finished test leaves no
    /// listener and no thread behind (the shape `log_files_cli.rs` settled on).
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    ended: std::sync::mpsc::Receiver<()>,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // `accept` waits for a connection: one wakes it, and it sees the flag.
        let _ = std::net::TcpStream::connect(self.addr.trim_start_matches("ws://"));
        let ended = self.ended.recv_timeout(std::time::Duration::from_secs(5));
        if let Some(t) = self.thread.take() {
            if ended.is_ok() {
                let _ = t.join();
            }
        }
        if ended.is_err() && !std::thread::panicking() {
            panic!("the fake gateway's thread did not stop within 5 s of being dropped");
        }
    }
}

fn fake() -> Fake {
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let (ended_tx, ended) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().build().unwrap();
        rt.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap().to_string()).unwrap();
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                if stopped.load(Ordering::SeqCst) {
                    return;
                }
                let seen = seen.clone();
                tokio::spawn(async move {
                    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else { return };
                    let Some(Ok(Message::Text(_))) = ws.next().await else { return };
                    let login = r#"{"id":1,"result":{"ok":true,"authenticated":true,"caps":["board_dispatch","hub_files","agent_team","spawn_join","mcp_masked"]}}"#;
                    let _ = ws.send(Message::Text(login.to_string().into())).await;
                    while let Some(Ok(Message::Text(raw))) = ws.next().await {
                        let call: Value = serde_json::from_str(&raw).unwrap();
                        let id = call["id"].clone();
                        seen.lock().unwrap().push((call["method"].as_str().unwrap_or_default().to_string(), call["params"].clone()));
                        // Most calls are answered `{ok:true,id:12}`; a command that first looks a project up needs the list.
                        let result = match call["method"].as_str() {
                            Some("project_list") => json!({ "projects": [{ "project": { "id": "s", "session": "s", "name": "s", "path": "/s" }, "live": true }] }),
                            _ => json!({ "ok": true, "id": 12 }),
                        };
                        let answer = json!({ "id": id, "result": result });
                        if ws.send(Message::Text(answer.to_string().into())).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        }));
        let _ = ended_tx.send(());
    });
    Fake { calls, addr: format!("ws://{}", rx.recv().unwrap()), stop, thread: Some(thread), ended }
}

/// A new, empty directory to stand in for HOME, removed when the test is done with it.
struct Home(PathBuf);

impl std::ops::Deref for Home {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn empty_home(label: &str) -> Home {
    let dir = std::env::temp_dir().join(format!("tmm-flags-{label}-{}-{:?}", std::process::id(), std::thread::current().id()).replace(['(', ')', ' '], ""));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    Home(dir)
}

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Run tmm with a scrubbed environment. `PATH` holds no tmux, no systemctl, no npx.
fn tmm(args: &[&str], home: &Path, server: Option<&str>, extra: &[(&str, &str)]) -> Out {
    let mut cmd = std::process::Command::new(env!("CARGO_BIN_EXE_tmm"));
    cmd.args(args).env_clear().env("PATH", "/nonexistent-tmm-flags-path").env("HOME", home).current_dir(home);
    if let Some(addr) = server {
        cmd.env("TMM_SERVER", addr).env("TMM_TOKEN", "t").env("TMM_PROJECT", "p").env("TMM_AGENT", "builder-2");
    }
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let out = cmd.output().unwrap();
    Out {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    }
}

fn entries(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect()
}

// ---- 1. refused before anything runs ----------------------------------------------------

#[test]
fn an_unknown_flag_is_refused_before_anything_runs() {
    // (command line, the flag it must name). Local commands first: these would start a window, a
    // service or a child if the refusal came after dispatch.
    let rows: &[(&[&str], &str)] = &[
        (&["board", "list", "--json"], "--json"),
        (&["send", "--json", "@x hi"], "--json"),
        (&["log", "--kill"], "--kill"),
        (&["scratch", "--grep", "x"], "--grep"),
        (&["task", "list", "--wake"], "--wake"),
        (&["task", "logs", "x", "--wake"], "--wake"),
        (&["task", "status", "x", "--keep"], "--keep"),
        (&["task", "rm", "x", "--session", "s"], "--session"),
        (&["gateway", "status", "--replace"], "--replace"),
        (&["gateway", "restart", "--service"], "--service"),
        (&["gateway", "restart", "--server", "ws://other"], "--server"),
        (&["gateway", "logs", "--show-token"], "--show-token"),
        (&["gateway", "uninstall", "--nope"], "--nope"),
        (&["mcp", "servers", "--args-json", "x"], "--args-json"),
        (&["mcp", "servers", "--output", "json"], "--output"),
        (&["mcp", "call", "s", "t", "--def", "x"], "--def"),
        (&["ui", "--replace"], "--replace"),
        (&["setup", "--nope"], "--nope"),
        (&["claude-statusline", "--output", "json"], "--output"),
        (&["agent", "stop", "dev", "--team", "t"], "--team"),
        (&["project", "rename", "s", "--session", "x"], "--session"),
        (&["board", "note", "3", "hi", "--body", "x"], "--body"),
    ];
    for (args, flag) in rows {
        let home = empty_home("refuse");
        let out = tmm(args, &home, None, &[]);
        let said = format!("tmm {}", args.join(" "));
        assert_eq!(out.code, 5, "{said}: {out:?}", out = (&out.stdout, &out.stderr));
        assert_eq!(out.stdout, "", "{said}: nothing on stdout");
        assert!(out.stderr.starts_with(&format!("tmm: unknown flag {flag} for \"tmm ")), "{said}: {}", out.stderr);
        assert_eq!(entries(&home), Vec::<String>::new(), "{said}: nothing was created (no config.toml, no socket, no window)");
    }
}

#[test]
fn json_is_answered_with_the_form_the_command_has() {
    let home = empty_home("suggest");
    let out = tmm(&["board", "list", "--json"], &home, None, &[]);
    assert_eq!(out.stderr.trim_end(), "tmm: unknown flag --json for \"tmm board list\": did you mean --output json? (text that starts with a dash goes after --)");
}

#[test]
fn help_is_the_one_exception() {
    let home = empty_home("help");
    let out = tmm(&["board", "list", "--nope", "--help"], &home, None, &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("USAGE"), "{}", out.stdout);
    // …even beside a value that is missing.
    let out = tmm(&["log", "--limit", "--help"], &home, None, &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
}

// ---- 2. the parse rules, end to end ------------------------------------------------------

#[test]
fn a_valued_flag_with_no_value_is_refused_and_sends_nothing() {
    let f = fake();
    for args in [vec!["log", "--limit"], vec!["log", "--limit", "--grep", "x"], vec!["board", "add", "t", "--assignee"]] {
        let home = empty_home("novalue");
        let out = tmm(&args, &home, Some(&f.addr), &[]);
        assert_eq!(out.code, 5, "{args:?}: {}", out.stderr);
        assert!(out.stderr.contains("needs a value"), "{args:?}: {}", out.stderr);
    }
    assert!(f.calls.lock().unwrap().is_empty(), "a refused command line never reaches the server");
}

#[test]
fn text_that_begins_with_a_dash_is_recorded_not_dropped() {
    let f = fake();
    let home = empty_home("dash");
    for (args, want) in [
        (vec!["board", "note", "7", "- done"], "- done"),
        (vec!["board", "note", "7", "--", "-json"], "-json"),
        (vec!["board", "note", "7", "-5"], "-5"),
    ] {
        f.calls.lock().unwrap().clear();
        let out = tmm(&args, &home, Some(&f.addr), &[]);
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
        let calls = f.calls.lock().unwrap();
        let note = calls.iter().find(|(m, _)| m == "hub_board_note").unwrap_or_else(|| panic!("{args:?} sent no note: {calls:?}"));
        assert_eq!(note.1["body"], want, "{args:?}");
    }
    f.calls.lock().unwrap().clear();
    let out = tmm(&["send", "@x -5", "--status"], &home, Some(&f.addr), &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(f.calls.lock().unwrap().iter().any(|(m, p)| m == "hub_post" && p["body"].as_str().unwrap().contains("@x -5")), "{:?}", f.calls.lock().unwrap());
}

#[test]
fn the_equals_form_and_a_flag_shaped_value_reach_the_server() {
    let f = fake();
    let home = empty_home("equals");
    let out = tmm(&["board", "add", "title", "--body=--literal", "--output=json"], &home, Some(&f.addr), &[]);
    assert_eq!(out.code, 0, "{}", out.stderr);
    let calls = f.calls.lock().unwrap();
    let save = calls.iter().find(|(m, _)| m == "hub_board_save").unwrap_or_else(|| panic!("{calls:?}"));
    assert_eq!(save.1["body"], "--literal", "a literal that looks like a flag, written with =");
    assert!(out.stdout.trim_start().starts_with('{'), "--output=json is the JSON output flag: {}", out.stdout);
}

#[test]
fn text_after_a_double_dash_is_the_title_as_given() {
    let f = fake();
    let home = empty_home("title");
    for (args, want) in [
        (vec!["board", "add", "--body", "kept", "--", "--literal"], "--literal"),
        (vec!["board", "add", "--", "--literal"], "--literal"),
        (vec!["board", "add", "fix", "--", "-- note"], "fix -- note"),
        (vec!["board", "add", "- a bullet"], "- a bullet"),
    ] {
        f.calls.lock().unwrap().clear();
        let out = tmm(&args, &home, Some(&f.addr), &[]);
        assert_eq!(out.code, 0, "{args:?}: {}", out.stderr);
        let calls = f.calls.lock().unwrap();
        let save = calls.iter().find(|(m, _)| m == "hub_board_save").unwrap_or_else(|| panic!("{args:?} saved nothing: {calls:?}"));
        assert_eq!(save.1["title"], want, "{args:?}: the issue filed is the one that was typed");
    }
}

#[test]
fn an_illegal_value_on_a_switch_is_never_washed_out_by_a_later_legal_one() {
    for args in [
        vec!["scratch", "--kill=0", "--kill"],
        vec!["scratch", "--kill", "--kill=0"],
        vec!["task", "start", "x", "--wake=@other", "--wake", "--", "true"],
        vec!["task", "start", "x", "--wake", "--wake=@other", "--", "true"],
    ] {
        let home = empty_home("washed");
        let out = tmm(&args, &home, None, &[]);
        let said = args.join(" ");
        assert_eq!(out.code, 5, "{said}: {}", out.stderr);
        assert!(out.stderr.contains("takes no value"), "{said}: {}", out.stderr);
        assert!(!out.stderr.contains("@other") && !out.stderr.contains("=0"), "{said}: the value is not echoed: {}", out.stderr);
        assert_eq!(out.stdout, "", "{said}");
        assert_eq!(entries(&home), Vec::<String>::new(), "{said}: refused before anything ran (no scratch session, no task window, no config)");
    }
}

#[test]
fn a_switch_given_a_value_is_refused() {
    let home = empty_home("switch");
    let out = tmm(&["scratch", "--kill=1"], &home, None, &[]);
    assert_eq!(out.code, 5);
    assert!(out.stderr.contains("--kill takes no value"), "{}", out.stderr);
    let out = tmm(&["task", "start", "x", "--wake=@lead", "--", "true"], &home, None, &[]);
    assert_eq!(out.code, 5);
    assert!(out.stderr.contains("--wake @lead"), "{}", out.stderr);
    assert_eq!(entries(&home), Vec::<String>::new());
}

#[test]
fn args_json_is_a_valued_flag_and_reaches_the_inspector_verbatim() {
    let home = empty_home("argsjson");
    let config = home.join("mcp.json");
    std::fs::write(&config, r#"{"mcpServers":{"s":{"command":"x"}}}"#).unwrap();
    let record = home.join("argv.txt");
    let script = home.join("inspector.sh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", record.display())).unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let out = tmm(
        &["mcp", "call", "s", "t", "--args-json", r#"{"a":1}"#], &home, None,
        &[("TMM_MCP_CONFIG", config.to_str().unwrap()), ("TMM_MCP_CLI", script.to_str().unwrap())],
    );
    assert_eq!(out.code, 0, "{} {}", out.stdout, out.stderr);
    let argv = std::fs::read_to_string(&record).unwrap();
    assert!(argv.lines().any(|l| l.contains(r#"{"a":1}"#)), "the JSON reached the inspector: {argv}");
}

// ---- 3. each sub-verb consumes the flags it lists ----------------------------------------

/// What one run sent: every (method, params) the fake saw.
fn sent(f: &Fake, args: &[&str], extra: &[(&str, &str)]) -> Value {
    f.calls.lock().unwrap().clear();
    let home = empty_home("consume");
    let out = tmm(args, &home, Some(&f.addr), extra);
    assert_ne!(out.code, 5, "tmm {} was refused at the door: {}", args.join(" "), out.stderr);
    // What reached the server, and what was printed: a flag can be consumed on either side
    // (`review list --all` filters what is printed after the same request).
    let calls: Vec<Value> = f.calls.lock().unwrap().iter().map(|(m, p)| json!({ "method": m, "params": p })).collect();
    json!({ "calls": calls, "stdout": out.stdout, "stderr": out.stderr })
}

/// A valued flag changes what is sent when its VALUE changes: it is consumed by this sub-verb.
fn valued(f: &Fake, base: &[&str], flag: &str, a: &str, b: &str) {
    let with = |value: &str| -> Vec<String> { base.iter().map(|s| s.to_string()).chain([flag.to_string(), value.to_string()]).collect() };
    let (wa, wb) = (with(a), with(b));
    let (ra, rb) = (wa.iter().map(String::as_str).collect::<Vec<_>>(), wb.iter().map(String::as_str).collect::<Vec<_>>());
    let (one, two) = (sent(f, &ra, &[]), sent(f, &rb, &[]));
    assert_ne!(one["calls"], json!([]), "tmm {} reached the server: {}", ra.join(" "), one["stderr"]);
    assert_ne!(one, two, "tmm {} changes nothing sent when {flag}'s value changes: the sub-verb does not read it", base.join(" "));
}

/// A switch changes what is sent when it is present.
fn switch(f: &Fake, base: &[&str], flag: &str) {
    let with: Vec<&str> = base.iter().copied().chain([flag]).collect();
    let (one, two) = (sent(f, base, &[]), sent(f, &with, &[]));
    assert_ne!(one["calls"], json!([]), "tmm {} reached the server: {}", base.join(" "), one["stderr"]);
    assert_ne!(one, two, "tmm {} does not read {flag}", base.join(" "));
}

#[test]
fn a_sub_verb_reads_the_flags_it_lists() {
    let f = fake();
    // board: add and note are two sub-verbs of one arm.
    valued(&f, &["board", "add", "title"], "--body", "one", "two");
    valued(&f, &["board", "add", "title"], "--assignee", "alice", "bob");
    valued(&f, &["board", "add", "title"], "--image", "https://h/a.png", "https://h/b.png");
    valued(&f, &["board", "note", "3", "text"], "--image", "https://h/a.png", "https://h/b.png");
    // review: list, add.
    switch(&f, &["review", "list", "f.rs"], "--all");
    valued(&f, &["review", "add", "f.rs", "--lines", "1-2", "--note", "n"], "--cols", "1-3", "2-4");
    valued(&f, &["review", "add", "f.rs", "--note", "n"], "--lines", "1-2", "3-4");
    valued(&f, &["review", "add", "f.rs", "--lines", "1-2"], "--note", "n", "m");
    // wake.
    switch(&f, &["wake", "list"], "--all");
    // agent.
    valued(&f, &["agent", "fork", "dev"], "--as", "one", "two");
    valued(&f, &["agent", "restart"], "--team", "t1", "t2");
    // project.
    valued(&f, &["project", "create", "/tmp/x"], "--name", "one", "two");
    valued(&f, &["project", "create", "/tmp/x"], "--session", "one", "two");
    valued(&f, &["project", "create", "/tmp/x"], "--with-agent", "kiro", "codex");
    valued(&f, &["project", "rename", "s"], "--name", "one", "two");
    switch(&f, &["project", "restore"], "--run");
    switch(&f, &["project", "restore"], "--abandon");
    // registry / teams / skills / mcp / prompt.
    valued(&f, &["registry", "save", "--backend", "kiro"], "--name", "one", "two");
    valued(&f, &["registry", "save", "--name", "n"], "--backend", "kiro", "codex");
    for flag in ["--model", "--effort", "--system", "--skills", "--input-mode"] {
        valued(&f, &["registry", "save", "--name", "n", "--backend", "kiro"], flag, "x", "y");
    }
    valued(&f, &["registry", "save", "--name", "n", "--backend", "kiro"], "--mcp", "[]", "[1]");
    valued(&f, &["teams", "save", "--def", "[]"], "--name", "one", "two");
    valued(&f, &["teams", "save", "--name", "n"], "--def", "[]", "[1]");
    valued(&f, &["teams", "save", "--name", "n", "--def", "[]"], "--description", "one", "two");
    valued(&f, &["skills", "save", "--source", "/abs"], "--name", "one", "two");
    valued(&f, &["skills", "save", "--name", "n"], "--source", "/abs/one", "/abs/two");
    valued(&f, &["skills", "save", "--name", "n", "--source", "/abs"], "--description", "one", "two");
    // `--ref` is the older spelling of `--source`: it is read only when `--source` is absent.
    valued(&f, &["skills", "save", "--name", "n"], "--ref", "/abs/one", "/abs/two");
    valued(&f, &["mcp", "save", "--def", "{}"], "--name", "one", "two");
    valued(&f, &["mcp", "save", "--name", "n"], "--def", "{}", r#"{"a":1}"#);
    // spawn, send, scratch, log.
    valued(&f, &["spawn", "dev"], "--brief", "one", "two");
    valued(&f, &["spawn", "dev"], "--join", "t1", "t2");
    valued(&f, &["spawn"], "--team", "t1", "t2");
    switch(&f, &["send", "@bob hi"], "--status");
    valued(&f, &["send", "@bob hi"], "--re", "1", "2");
    valued(&f, &["send", "@bob hi"], "--image", "https://h/a.png", "https://h/b.png");
    valued(&f, &["send", "@bob hi"], "--in", "10m", "20m");
    valued(&f, &["send", "@bob hi"], "--at", "14:30", "15:30");
    switch(&f, &["scratch"], "--kill");
    valued(&f, &["log"], "--limit", "5", "6");
    valued(&f, &["log"], "--since", "5", "6");
    valued(&f, &["log", "--grep", "a"], "--from", "bob", "kiro");
    switch(&f, &["log", "--grep", "a"], "--global");
    switch(&f, &["log", "--grep", "a", "--grep", "b"], "--all");
    switch(&f, &["log"], "--files");
    valued(&f, &["log", "--files"], "--before", "5", "6");
}

#[test]
fn prompt_set_reads_its_file() {
    let f = fake();
    let home = empty_home("promptfile");
    let (a, b) = (home.join("a.md"), home.join("b.md"));
    std::fs::write(&a, "one").unwrap();
    std::fs::write(&b, "two").unwrap();
    valued(&f, &["prompt", "set"], "--file", a.to_str().unwrap(), b.to_str().unwrap());
}

// ---- the fixtures clean up after themselves ----------------------------------------------

#[test]
fn a_fake_gateway_that_is_dropped_stops_listening_and_a_home_is_removed() {
    let (addr, dir) = {
        let f = fake();
        let home = empty_home("cleanup");
        std::fs::write(home.join("x"), "x").unwrap();
        (f.addr.trim_start_matches("ws://").to_string(), home.0.clone())
    };
    assert!(std::net::TcpStream::connect(&addr).is_err(), "nothing listens on {addr} after the fake is dropped");
    assert!(!dir.exists(), "{dir:?} is removed when its test is done");
}
