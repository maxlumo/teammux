//! First-run setup (board #323, owner 2026-10-09: "如果本地没有 TMM 的配置，启动时
//! 可以提供配置引导").
//!
//! `tmm setup` runs it alone; `tmm gateway` / `gateway install|start` run it
//! when config.toml does not exist yet. A terminal only: without one nothing
//! is asked, and only what `Config::load` already does on its own happens
//! (a token and a machine id), which the caller says.
//!
//! The answers land in config.toml through the ONE schema Config reads
//! (`config::validate_file`), edited in place with `toml_edit`: every key it
//! did not ask about, and every comment, stays. Nothing is written when the
//! existing file does not parse, when the reader cancels (EOF / an empty
//! line where a value is required is not a cancel — it takes the default),
//! or when an answer is invalid. The write is atomic (a 0600 temp file in
//! the same directory, then rename), because the file holds the token.

use std::io::{BufRead, Write};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Answers {
    pub port: u16,
    pub host: String,
    /// None = tmux's default socket.
    pub tmux_socket: Option<String>,
    pub token: String,
    /// Both or neither.
    pub tls: Option<(String, String)>,
}

/// What the wizard starts from: the current file's values, else the defaults.
#[derive(Debug, Clone)]
pub struct Start {
    pub port: u16,
    pub host: String,
    pub tmux_socket: Option<String>,
    pub token: Option<String>,
    pub tls: Option<(String, String)>,
    /// The socket of a running tmux server, offered as a hint.
    pub detected_socket: Option<String>,
    /// What a relative path answer is resolved against (the caller's cwd)
    /// and what `~` means: paths are SAVED absolute, because the service
    /// runs from another directory.
    pub cwd: std::path::PathBuf,
    pub home: Option<std::path::PathBuf>,
}

/// `v` as an absolute path: `~` / `~/…` expanded, a relative path joined to
/// `cwd`. Lexical only — the file need not exist (a socket may not yet).
pub fn absolute(v: &str, cwd: &Path, home: Option<&Path>) -> Result<String, String> {
    let p = if v == "~" {
        home.ok_or("~ needs HOME")?.to_path_buf()
    } else if let Some(rest) = v.strip_prefix("~/") {
        home.ok_or("~ needs HOME")?.join(rest)
    } else if v.starts_with('~') {
        return Err(format!("{v}: only ~ and ~/… are expanded"));
    } else {
        cwd.join(v)
    };
    Ok(p.to_string_lossy().into_owned())
}

impl Start {
    pub fn from_file(text: &str, detected_socket: Option<String>, cwd: std::path::PathBuf, home: Option<std::path::PathBuf>) -> Result<Self, String> {
        crate::config::validate_file(text)?;
        let doc: toml_edit::DocumentMut = text.parse().map_err(|_| "not valid TOML".to_string())?;
        let s = |k: &str| doc.get(k).and_then(|v| v.as_str()).map(str::to_string).filter(|v| !v.is_empty());
        let port = doc.get("port").and_then(|v| v.as_integer()).and_then(|p| u16::try_from(p).ok()).unwrap_or(9899);
        let tls = match (s("tls_cert"), s("tls_key")) {
            (Some(c), Some(k)) => Some((c, k)),
            _ => None,
        };
        Ok(Start { port, host: s("host").unwrap_or_else(|| "0.0.0.0".into()), tmux_socket: s("tmux_socket"), token: s("token"), tls, detected_socket, cwd, home })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Done(Answers),
    Cancelled,
}

fn ask(input: &mut dyn BufRead, out: &mut dyn Write, prompt: &str, default: &str) -> Result<Option<String>, String> {
    if default.is_empty() {
        write!(out, "{prompt}: ").map_err(|e| e.to_string())?;
    } else {
        write!(out, "{prompt} [{default}]: ").map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    if input.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
        return Ok(None); // EOF: cancelled
    }
    let v = line.trim();
    Ok(Some(if v.is_empty() { default.to_string() } else { v.to_string() }))
}

/// The wizard over any input/output (pure enough to test with scripted
/// answers). Re-asks an invalid answer up to three times, then cancels.
pub fn wizard(input: &mut dyn BufRead, out: &mut dyn Write, start: &Start, new_token: &dyn Fn() -> String) -> Result<Outcome, String> {
    macro_rules! get {
        ($prompt:expr, $default:expr, $check:expr) => {{
            let mut got = None;
            for _ in 0..3 {
                let Some(v) = ask(input, out, $prompt, $default)? else { return Ok(Outcome::Cancelled) };
                match $check(&v) {
                    Ok(x) => { got = Some(x); break; }
                    Err(e) => writeln!(out, "  {e}").map_err(|e| e.to_string())?,
                }
            }
            match got { Some(x) => x, None => return Ok(Outcome::Cancelled) }
        }};
    }
    writeln!(out, "Teammux setup — {}", crate::config::config_file().display()).map_err(|e| e.to_string())?;
    let port = get!("Port", &start.port.to_string(), |v: &str| v.parse::<u16>().ok().filter(|p| *p > 0).ok_or("a port is 1–65535".to_string()));
    writeln!(out, "  0.0.0.0 = reachable from your phone on this network (the token is the guard, not encryption — use TLS or Tailscale off your LAN);").map_err(|e| e.to_string())?;
    writeln!(out, "  127.0.0.1 = this machine only.").map_err(|e| e.to_string())?;
    let host = get!("Listen on", &start.host, |v: &str| v.parse::<std::net::IpAddr>().map(|_| v.to_string()).map_err(|_| "an IP address, e.g. 0.0.0.0 or 127.0.0.1".to_string()));
    if let Some(d) = &start.detected_socket {
        writeln!(out, "  a running tmux server uses {d}; leave empty for tmux's default socket.").map_err(|e| e.to_string())?;
    }
    let sock_default = start.tmux_socket.clone().unwrap_or_default();
    let abs = |v: &str| absolute(v, &start.cwd, start.home.as_deref());
    // With a value already set, Enter KEEPS it; `-` is how to clear it.
    let sock_prompt = if sock_default.is_empty() { "tmux socket (-S path, empty = default)" } else { "tmux socket (-S path; Enter keeps it, - = default)" };
    let tmux_socket = get!(sock_prompt, &sock_default, |v: &str| {
        if v.is_empty() || v == "-" { Ok(None) } else { abs(v).map(Some) }
    });
    let token = match &start.token {
        Some(t) => {
            let keep = get!("Keep the existing token? (y/n)", "y", |v: &str| match v.to_ascii_lowercase().as_str() {
                "y" | "yes" => Ok(true),
                "n" | "no" => Ok(false),
                _ => Err("y or n".to_string()),
            });
            if keep { t.clone() } else { new_token() }
        }
        None => new_token(),
    };
    let tls_default = start.tls.as_ref().map(|(c, _)| c.clone()).unwrap_or_default();
    let cert_prompt = if tls_default.is_empty() { "TLS certificate (PEM path, empty = no TLS)" } else { "TLS certificate (PEM path; Enter keeps it, - = no TLS)" };
    let cert = get!(cert_prompt, &tls_default, |v: &str| {
        if v.is_empty() || v == "-" { return Ok(None) }
        let a = abs(v)?;
        if Path::new(&a).is_file() { Ok(Some(a)) } else { Err(format!("no file at {a}")) }
    });
    let tls = match cert {
        None => None,
        Some(c) => {
            let key_default = start.tls.as_ref().map(|(_, k)| k.clone()).unwrap_or_default();
            let key = get!("TLS private key (PEM path)", &key_default, |v: &str| {
                let a = abs(v)?;
                if Path::new(&a).is_file() { Ok(a) } else { Err(format!("a key file is required with a certificate (no file at {a:?})")) }
            });
            Some((c, key))
        }
    };
    Ok(Outcome::Done(Answers { port, host, tmux_socket, token, tls }))
}

/// `existing` with the answers set — every other key and comment kept —
/// checked against the one schema.
pub fn apply(existing: &str, a: &Answers) -> Result<String, String> {
    crate::config::validate_file(existing).map_err(|e| format!("config.toml does not parse ({e}); fix or move it — nothing was written"))?;
    let mut doc: toml_edit::DocumentMut = existing.parse().map_err(|_| "config.toml is not valid TOML — nothing was written".to_string())?;
    doc["port"] = toml_edit::value(i64::from(a.port));
    doc["host"] = toml_edit::value(a.host.as_str());
    doc["token"] = toml_edit::value(a.token.as_str());
    match &a.tmux_socket {
        Some(s) => doc["tmux_socket"] = toml_edit::value(s.as_str()),
        None => { doc.remove("tmux_socket"); }
    }
    match &a.tls {
        Some((c, k)) => {
            doc["tls_cert"] = toml_edit::value(c.as_str());
            doc["tls_key"] = toml_edit::value(k.as_str());
        }
        None => {
            doc.remove("tls_cert");
            doc.remove("tls_key");
        }
    }
    let text = doc.to_string();
    crate::config::validate_file(&text)?;
    Ok(text)
}

/// Replace `path` with `text` atomically, mode 0600 from the first byte.
pub fn write_0600(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("config path has no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".config.toml.{}.tmp", std::process::id()));
    {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })?;
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn detect_socket() -> Option<String> {
    let out = std::process::Command::new("tmux").args(["display-message", "-p", "#{socket_path}"]).output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !p.is_empty()).then_some(p)
}

/// config.toml as it is: `None` only when it does not EXIST. Any other
/// read failure, non-UTF-8 bytes or a file the schema rejects is an error —
/// and nothing is written or initialised after one (fail closed).
pub fn read_existing(path: &Path) -> Result<Option<String>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{} cannot be read ({}) — nothing was written", path.display(), e.kind())),
    };
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8 text — nothing was written", path.display()))?;
    crate::config::validate_file(&text).map_err(|e| format!("{} does not parse ({e}); fix or move it — nothing was written", path.display()))?;
    Ok(Some(text))
}

/// What the setup step decided.
#[derive(Debug, PartialEq, Eq)]
pub enum FirstRun {
    /// config.toml already existed and parses: nothing asked.
    Existing,
    /// The reader answered and config.toml was written.
    Proceed,
    /// The reader cancelled (EOF, three bad answers): nothing was written,
    /// and the command that asked MUST stop — no unit, no start.
    Cancelled,
    /// No terminal and no config.toml: the defaults a first start makes (a
    /// token and a machine id) were created, and the caller says so.
    NonInteractiveDefaults,
}

/// The one setup step, over any input/output. `interactive` = a terminal
/// is attached; `force` = `tmm setup` (ask even when the file exists).
pub fn setup_step(path: &Path, interactive: bool, force: bool, input: &mut dyn BufRead, out: &mut dyn Write, detected: Option<String>, cwd: std::path::PathBuf, home: Option<std::path::PathBuf>, new_token: &dyn Fn() -> String, init_defaults: &dyn Fn()) -> Result<FirstRun, String> {
    // The same read/validate boundary in every mode, BEFORE anything else.
    let existing = read_existing(path)?;
    if existing.is_some() && !force {
        return Ok(FirstRun::Existing);
    }
    if !interactive {
        if existing.is_some() {
            return Ok(FirstRun::Existing);
        }
        init_defaults();
        return Ok(FirstRun::NonInteractiveDefaults);
    }
    let text = existing.unwrap_or_default();
    let start = Start::from_file(&text, detected, cwd, home)?;
    match wizard(input, out, &start, new_token)? {
        Outcome::Cancelled => Ok(FirstRun::Cancelled),
        Outcome::Done(a) => {
            let next = apply(&text, &a)?;
            write_0600(path, &next)?;
            Ok(FirstRun::Proceed)
        }
    }
}

fn step_here(force: bool) -> Result<FirstRun, String> {
    use std::io::IsTerminal;
    let path = crate::config::config_file();
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();
    let mut input = stdin.lock();
    let mut out = std::io::stdout();
    let cwd = std::env::current_dir().map_err(|e| format!("cwd: {e}"))?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let r = setup_step(&path, interactive, force, &mut input, &mut out, detect_socket(), cwd, home,
        &|| uuid::Uuid::new_v4().to_string(), &|| { let _ = crate::config::Config::load(); })?;
    match r {
        FirstRun::Proceed => {
            println!("✓ wrote {}", path.display());
            println!("  next: tmm gateway   (installs and starts the background service)");
        }
        FirstRun::Cancelled => println!("\nsetup cancelled — nothing was written"),
        FirstRun::NonInteractiveDefaults => eprintln!("setup: not a terminal — nothing asked; defaults apply ({} has a token and nothing else). Run tmm setup in a terminal to choose.", path.display()),
        FirstRun::Existing if force => eprintln!("setup: not a terminal — nothing asked; {} is unchanged", path.display()),
        FirstRun::Existing => {}
    }
    Ok(r)
}

/// `tmm setup`.
pub fn run_interactive() -> Result<FirstRun, String> {
    step_here(true)
}

/// The first-run step of `tmm gateway`: asks only when there is no
/// config.toml yet; refuses (Err) when the existing file cannot be read.
pub fn first_run() -> Result<FirstRun, String> {
    step_here(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(text: &str) -> Start {
        Start::from_file(text, Some("/tmp/tmux-1000/default".into()), "/work/here".into(), Some("/home/u".into())).unwrap()
    }
    fn run(text: &str, script: &str) -> (Outcome, String) {
        let mut out = Vec::new();
        let o = wizard(&mut script.as_bytes(), &mut out, &start(text), &|| "fresh-token".into()).unwrap();
        (o, String::from_utf8(out).unwrap())
    }

    #[test]
    fn defaults_come_from_the_file_and_an_empty_answer_keeps_them() {
        let (o, out) = run("port = 9900\nhost = \"127.0.0.1\"\ntoken = \"old\"\n", "\n\n\n\n\n");
        assert_eq!(o, Outcome::Done(Answers { port: 9900, host: "127.0.0.1".into(), tmux_socket: None, token: "old".into(), tls: None }));
        assert!(out.contains("0.0.0.0 = reachable from your phone") && out.contains("127.0.0.1 = this machine only"));
        assert!(out.contains("/tmp/tmux-1000/default"), "the detected socket is offered");
        let (o, _) = run("", "\n\n\n\n");
        assert_eq!(o, Outcome::Done(Answers { port: 9899, host: "0.0.0.0".into(), tmux_socket: None, token: "fresh-token".into(), tls: None }), "fresh: 0.0.0.0 and a new token");
    }

    #[test]
    fn invalid_answers_are_asked_again_and_eof_cancels() {
        let (o, out) = run("", "99999\n0\n8080\nlocalhost\n127.0.0.1\n/tmp/s\n\n");
        assert!(out.contains("a port is 1–65535") && out.contains("an IP address"));
        assert_eq!(o, Outcome::Done(Answers { port: 8080, host: "127.0.0.1".into(), tmux_socket: Some("/tmp/s".into()), token: "fresh-token".into(), tls: None }));
        assert_eq!(run("", "8080\n").0, Outcome::Cancelled, "EOF mid-way writes nothing");
        assert_eq!(run("", "x\nx\nx\n").0, Outcome::Cancelled, "three bad answers cancel");
        // An existing value: Enter keeps it, and the prompt says how to clear it.
        let (o, out) = run("tmux_socket = \"/s\"\ntls_cert = \"/c\"\ntls_key = \"/k\"\n", "\n\n\n-\n");
        assert!(out.contains("Enter keeps it, - = default") && out.contains("Enter keeps it, - = no TLS"), "{out}");
        assert!(matches!(o, Outcome::Done(Answers { tmux_socket: Some(ref s), tls: None, .. }) if s == "/s"), "{o:?}");
        let (_, out) = run("", "\n\n\n\n");
        assert!(!out.contains("Enter keeps"), "no value: the plain prompt");
        let (o, _) = run("token = \"old\"\n", "\n\n\nn\n\n");
        assert!(matches!(o, Outcome::Done(Answers { ref token, .. }) if token == "fresh-token"), "declining to keep the token makes a new one");
    }

    #[test]
    fn tls_needs_both_existing_files() {
        let dir = std::env::temp_dir().join(format!("setup-tls-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (c, k) = (dir.join("c.pem"), dir.join("k.pem"));
        std::fs::write(&c, "x").unwrap();
        std::fs::write(&k, "x").unwrap();
        let script = format!("\n\n\n/nope.pem\n{}\n/nope.key\n{}\n", c.display(), k.display());
        let (o, out) = run("", &script);
        assert!(out.contains("no file at /nope.pem") && out.contains("a key file is required"));
        assert!(matches!(o, Outcome::Done(Answers { tls: Some(_), .. })));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_sets_the_answers_and_keeps_every_other_key_and_comment() {
        let existing = "# my notes\ntoken = \"old\"\nteam_rules = \"keep me\"\n# about tls\ntls_cert = \"/c\"\ntls_key = \"/k\"\n\n[extra]\nx = 1\n";
        let a = Answers { port: 9900, host: "127.0.0.1".into(), tmux_socket: Some("/s".into()), token: "old".into(), tls: None };
        let text = apply(existing, &a).unwrap();
        assert!(text.contains("# my notes") && text.contains("team_rules = \"keep me\"") && text.contains("[extra]\nx = 1"));
        assert!(text.contains("port = 9900") && text.contains("host = \"127.0.0.1\"") && text.contains("tmux_socket = \"/s\""));
        assert!(!text.contains("tls_cert") && !text.contains("tls_key"), "no TLS answered: both removed");
        crate::config::validate_file(&text).unwrap();
        assert!(apply("port = \"not a number\"\n", &a).is_err(), "a file that does not parse is never rewritten");
        assert!(apply("port = 99999\n", &a).is_err(), "out of range for the schema");
    }

    #[cfg(unix)]
    #[test]
    fn the_write_is_atomic_and_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("setup-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("config.toml");
        std::fs::write(&p, "token = \"a\"\n").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_0600(&p, "token = \"b\"\n").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "token = \"b\"\n");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp file left behind");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("setup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// One step with scripted answers; `inits` counts default initialisation.
    fn step(path: &Path, interactive: bool, force: bool, script: &str, cwd: &Path) -> (Result<FirstRun, String>, usize) {
        let n = std::cell::Cell::new(0);
        let mut out = Vec::new();
        let r = setup_step(path, interactive, force, &mut script.as_bytes(), &mut out, None, cwd.to_path_buf(), Some("/home/u".into()), &|| "fresh".into(), &|| n.set(n.get() + 1));
        (r, n.get())
    }

    #[test]
    fn a_cancel_writes_nothing_and_says_cancelled() {
        let d = scratch("cancel");
        let p = d.join("config.toml");
        assert_eq!(step(&p, true, false, "8080\n", &d).0, Ok(FirstRun::Cancelled), "EOF");
        assert_eq!(step(&p, true, false, "x\nx\nx\n", &d).0, Ok(FirstRun::Cancelled), "three strikes");
        assert!(!p.exists(), "nothing written");
        assert_eq!(step(&p, true, false, "\n\n\n\n", &d).0, Ok(FirstRun::Proceed));
        assert!(p.exists());
        assert_eq!(step(&p, true, false, "", &d).0, Ok(FirstRun::Existing), "an existing file is not asked again");
        std::fs::remove_dir_all(&d).ok();
    }

    /// Only NotFound is a first run. Unreadable, non-UTF-8 or invalid →
    /// Err in BOTH modes, bytes unchanged, no defaults initialised.
    #[test]
    fn a_file_that_cannot_be_read_fails_closed_in_both_modes() {
        let d = scratch("closed");
        let p = d.join("config.toml");
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("invalid toml", b"token = \"DUMMY-SECRET-0123\"x\n".to_vec()),
            ("wrong type", b"token = \"DUMMY-SECRET-0123\"\nport = \"DUMMY-SECRET-0123\"\n".to_vec()),
            ("not utf-8", vec![0x74, 0x6f, 0xff, 0xfe, 0x0a]),
        ];
        for (what, bytes) in &cases {
            std::fs::write(&p, bytes).unwrap();
            for interactive in [true, false] {
                for force in [true, false] {
                    let (r, inits) = step(&p, interactive, force, "\n\n\n\n\n", &d);
                    let e = r.expect_err(what);
                    assert!(!e.contains("DUMMY-SECRET"), "{what}: the error quotes the file: {e}");
                    assert_eq!(inits, 0, "{what}: no token/machine id created");
                    assert_eq!(&std::fs::read(&p).unwrap(), bytes, "{what}: bytes unchanged");
                }
            }
        }
        // A directory where the file should be: a read error, not "absent".
        std::fs::remove_file(&p).unwrap();
        std::fs::create_dir(&p).unwrap();
        let (r, inits) = step(&p, false, false, "", &d);
        assert!(r.is_err() && inits == 0, "{r:?}");
        std::fs::remove_dir(&p).unwrap();
        // Missing + no terminal: the defaults a first start makes.
        assert_eq!(step(&p, false, false, "", &d), (Ok(FirstRun::NonInteractiveDefaults), 1));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_parse_error_names_kind_and_place_never_the_line() {
        let e = crate::config::validate_file("port = 1\ntoken = \"DUMMY-SECRET-0123\"x\n").unwrap_err();
        assert!(!e.contains("DUMMY") && e.contains("not valid TOML") && e.contains("line 2"), "{e}");
        let e = crate::config::validate_file("port = \"DUMMY-SECRET-0123\"\n").unwrap_err();
        assert!(!e.contains("DUMMY") && e.contains("wrong type") && e.contains("line 1"), "{e}");
    }

    /// Paths are saved absolute (the service runs elsewhere): a relative
    /// answer resolves against the caller's cwd, `~` against HOME; a socket
    /// need not exist yet.
    #[test]
    fn paths_are_saved_absolute() {
        let d = scratch("abs");
        std::fs::write(d.join("c.pem"), "x").unwrap();
        std::fs::write(d.join("k.pem"), "x").unwrap();
        let p = d.join("config.toml");
        assert_eq!(step(&p, true, false, "\n\nrun/tmux.sock\nc.pem\nk.pem\n", &d).0, Ok(FirstRun::Proceed));
        let text = std::fs::read_to_string(&p).unwrap();
        let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(&format!("{k} = \""))).map(|v| v.trim_end_matches('"').to_string()).unwrap();
        assert_eq!(get("tls_cert"), d.join("c.pem").to_string_lossy());
        assert_eq!(get("tls_key"), d.join("k.pem").to_string_lossy());
        assert_eq!(get("tmux_socket"), d.join("run/tmux.sock").to_string_lossy(), "a socket not created yet is still absolute");
        // Read from anywhere else, the same files are named.
        for k in ["tls_cert", "tls_key"] { assert!(Path::new(&get(k)).is_absolute() && Path::new(&get(k)).is_file()); }
        assert_eq!(absolute("~/s", Path::new("/x"), Some(Path::new("/home/u"))).unwrap(), "/home/u/s");
        assert!(absolute("~bob/s", Path::new("/x"), Some(Path::new("/home/u"))).is_err());
        std::fs::remove_dir_all(&d).ok();
    }
}
