//! Board #472, B1: which directory is the configuration root, through REAL processes.
//!
//! The root is chosen once, by a table (config::resolve_root): a fresh install is
//! `teammux`, an install that has `tmux-mobile` keeps it, and two names that lead to
//! DIFFERENT places refuse before anything is written, whichever side is empty.
//! These tests start the real `tmm` and `server` binaries on constructed bases and
//! check what the table cannot: that an entry which reads no configuration still
//! answers on a refused base, that an entry which does read it refuses and writes
//! nothing, and that a name reached through an external link never changes the XDG
//! base the gateway service records.
#![cfg(target_os = "linux")]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

struct Base {
    root: PathBuf,
}

impl Base {
    fn new(tag: &str) -> Base {
        let root = std::env::temp_dir().join(format!("config-root-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("cfg")).unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("tmux")).unwrap();
        Base { root }
    }
    fn cfg(&self) -> PathBuf {
        self.root.join("cfg")
    }
    fn dir(&self, rel: &str, file: Option<(&str, &str)>) -> PathBuf {
        let d = self.root.join(rel);
        std::fs::create_dir_all(&d).unwrap();
        if let Some((name, body)) = file {
            std::fs::write(d.join(name), body).unwrap();
        }
        d
    }
    fn run(&self, program: &str, args: &[&str], stdin: &str) -> Output {
        self.run_in(&self.cfg(), program, args, stdin)
    }
    fn run_in(&self, xdg: &Path, program: &str, args: &[&str], stdin: &str) -> Output {
        self.run_env(xdg, &[], program, args, stdin)
    }
    fn run_env(&self, xdg: &Path, extra: &[(&str, &str)], program: &str, args: &[&str], stdin: &str) -> Output {
        let mut child = Command::new(program)
            .args(args)
            .env_clear()
            .env("HOME", self.root.join("home"))
            .env("XDG_CONFIG_HOME", xdg)
            .env("PATH", "/usr/bin:/bin")
            // A tmux this test starts, or asks, is a private empty one: never the operator's.
            .env("TMUX_TMPDIR", self.root.join("tmux"))
            .envs(extra.iter().copied())
            .current_dir(&self.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }
    /// A listing of everything under the base: a name, its kind, its size and its bytes.
    fn tree(&self) -> Vec<String> {
        fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
            let mut names: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name()).collect();
            names.sort();
            for n in names {
                if rel.is_empty() && n == "tmux" {
                    continue; // the private tmux directory: not configuration, and tmux may touch it
                }
                let p = dir.join(&n);
                let r = format!("{rel}/{}", n.to_string_lossy());
                let m = std::fs::symlink_metadata(&p).unwrap();
                if m.file_type().is_symlink() {
                    out.push(format!("{r} -> {}", std::fs::read_link(&p).unwrap().display()));
                } else if m.is_dir() {
                    out.push(format!("{r}/"));
                    walk(&p, &r, out);
                } else {
                    out.push(format!("{r} {} {:?}", m.len(), std::fs::read(&p).unwrap_or_default()));
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, "", &mut out);
        out
    }
}

impl Drop for Base {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

const TMM: &str = env!("CARGO_BIN_EXE_tmm");
const SERVER: &str = env!("CARGO_BIN_EXE_server");

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

fn config_line(out: &Output) -> String {
    text(&out.stdout).lines().find(|l| l.starts_with("config ")).unwrap_or("").trim_start_matches("config").trim().to_string()
}

#[test]
fn a_fresh_base_chooses_teammux_and_writes_nothing() {
    let b = Base::new("fresh");
    let before = b.tree();
    let out = b.run(TMM, &["gateway", "status"], "");
    assert_eq!(config_line(&out), b.cfg().join("teammux").to_string_lossy(), "{}", text(&out.stdout));
    assert!(!text(&out.stdout).contains("predates"), "a fresh install says nothing about a rename");
    assert_eq!(b.tree(), before, "status is read-only");
}

#[test]
fn an_install_that_has_tmux_mobile_keeps_it_and_nothing_is_added() {
    let b = Base::new("old");
    b.dir("cfg/tmux-mobile", Some(("config.toml", "token = \"t\"\nport = 1\n")));
    let before = b.tree();
    let out = b.run(TMM, &["gateway", "status"], "");
    assert_eq!(config_line(&out), b.cfg().join("tmux-mobile").to_string_lossy());
    assert!(text(&out.stdout).contains("predates the rename"), "status says why the old name is kept: {}", text(&out.stdout));
    assert_eq!(b.tree(), before, "no alias, no link, no rename");
}

#[test]
fn two_names_for_the_same_external_directory_choose_teammux_and_keep_the_base() {
    // Both names are links to one directory on another disk. The logical root is
    // <base>/teammux, so its PARENT is still the base the service records, not the disk.
    let b = Base::new("alias");
    let ext = b.dir("ext/state", Some(("config.toml", "token = \"t\"\nport = 1\n")));
    std::os::unix::fs::symlink(&ext, b.cfg().join("teammux")).unwrap();
    std::os::unix::fs::symlink(&ext, b.cfg().join("tmux-mobile")).unwrap();
    let out = b.run(TMM, &["gateway", "status"], "");
    let root = config_line(&out);
    assert_eq!(root, b.cfg().join("teammux").to_string_lossy(), "{}", text(&out.stdout));
    assert_eq!(Path::new(&root).parent().unwrap(), b.cfg(), "the XDG base is untouched by where the links lead");

    // A process that gets ONLY the base (what a service does) comes back to the same root. The unit
    // that records the base is rendered by the real service code in tests/config_root_service.rs.
    let child = b.run_in(&b.cfg(), TMM, &["gateway", "status"], "");
    assert_eq!(config_line(&child), root, "a second process picks the same root");
}

const REFUSAL: &str = "Two configuration directories exist";

/// Both names exist and lead to different places. `new_files`/`old_files` choose which sides hold anything.
fn ambiguous(tag: &str, new_files: bool, old_files: bool) -> Base {
    let b = Base::new(tag);
    b.dir("cfg/teammux", new_files.then_some(("config.toml", "token = \"new\"\n")));
    b.dir("cfg/tmux-mobile", old_files.then_some(("config.toml", "token = \"old\"\n")));
    b
}

#[test]
fn entries_that_read_no_configuration_still_answer_on_a_refused_base() {
    let b = ambiguous("config-free", true, true);
    let before = b.tree();
    let help = b.run(TMM, &["log", "--help"], "");
    assert!(help.status.success() && text(&help.stdout).contains("tmm"), "--help answers: {}", text(&help.stderr));
    assert!(!text(&help.stderr).contains(REFUSAL));
    let bare = b.run(TMM, &["--help"], "");
    assert!(text(&bare.stdout).contains("tmm"), "a bare --help prints the usage (its exit code is the existing one): {}", text(&bare.stderr));
    assert!(!text(&bare.stderr).contains(REFUSAL));
    let flag = b.run(TMM, &["log", "--no-such-flag"], "");
    assert_eq!(flag.status.code(), Some(5), "an unknown flag keeps its usage error (#456), not the refusal: {}", text(&flag.stderr));
    assert!(!text(&flag.stderr).contains(REFUSAL));
    let status = b.run(TMM, &["claude-statusline"], r#"{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/tmp"}}"#);
    assert!(status.status.success(), "the status line formats its stdin: {}", text(&status.stderr));
    assert!(!text(&status.stderr).contains(REFUSAL));
    let task = b.run(TMM, &["task", "status", "no-such-task-472"], "");
    assert!(!text(&task.stderr).contains(REFUSAL), "a local task is not blocked by the root: {}", text(&task.stderr));
    assert_eq!(b.tree(), before, "none of them wrote anything");
}

#[test]
fn an_unknown_gateway_subcommand_is_the_usage_error_even_with_overrides_set_on_a_refused_base() {
    // The environment note for PORT, TOKEN and the like names the config file, so it used to be a
    // reason to read the root before an unknown subcommand was refused.
    let b = ambiguous("unknown-sub", true, true);
    let before = b.tree();
    let out = b.run_env(&b.cfg(), &[("PORT", "1"), ("TOKEN", "x"), ("HOST", "127.0.0.1")], TMM, &["gateway", "bogus"], "");
    assert_eq!(out.status.code(), Some(5), "usage error: {}", text(&out.stderr));
    assert!(text(&out.stderr).contains("gateway bogus"), "{}", text(&out.stderr));
    assert!(!text(&out.stderr).contains(REFUSAL) && !text(&out.stderr).contains("panicked"), "{}", text(&out.stderr));
    assert_eq!(b.tree(), before);
}

#[test]
fn entries_that_read_it_refuse_and_write_nothing_in_every_empty_or_full_combination() {
    for (tag, new_files, old_files) in [("ee", false, false), ("ef", false, true), ("fe", true, false), ("ff", true, true)] {
        let b = ambiguous(tag, new_files, old_files);
        let before = b.tree();
        for (program, args) in [
            (TMM, vec!["gateway", "status"]),
            (TMM, vec!["gateway"]),
            (TMM, vec!["ui"]),
            (TMM, vec!["setup"]),
            (TMM, vec!["log"]),
            (SERVER, vec![]),
        ] {
            let out = b.run(program, &args, "");
            assert_eq!(out.status.code(), Some(1), "{program} {args:?} must refuse with exit 1 (new files {new_files}, old files {old_files}): {}", text(&out.stderr));
            assert!(text(&out.stderr).contains(REFUSAL), "{program} {args:?}: {}", text(&out.stderr));
            // The refusal comes from the explicit init at the entry, a clean line. A panic (exit 101) would
            // mean the entry forgot it and only the lazy backstop stopped the process.
            assert!(!text(&out.stderr).contains("panicked"), "{program} {args:?} reached the backstop: {}", text(&out.stderr));
            assert!(text(&out.stderr).contains("Nothing was changed"), "{}", text(&out.stderr));
            assert_eq!(b.tree(), before, "{program} {args:?} wrote something (new files {new_files}, old files {old_files})");
        }
    }
}

#[test]
fn a_relative_xdg_config_home_is_ignored_and_nothing_is_created_beside_it() {
    // XDG says a relative value is invalid and must be ignored: the base falls back to $HOME/.config.
    let b = Base::new("relative");
    let before = b.tree();
    let out = b.run_in(Path::new("relative/xdg"), TMM, &["gateway", "status"], "");
    assert_eq!(config_line(&out), b.root.join("home/.config/teammux").to_string_lossy(), "{}", text(&out.stdout));
    assert_eq!(b.tree(), before, "the relative path was not created or used, and nothing else was either");
}

#[test]
fn a_looping_link_a_dangling_link_and_a_file_refuse_without_a_write() {
    let cases: [(&str, fn(&Base)); 3] = [
        ("loop", |b| std::os::unix::fs::symlink(b.cfg().join("teammux"), b.cfg().join("teammux")).unwrap()),
        ("dangling", |b| std::os::unix::fs::symlink(b.root.join("nowhere"), b.cfg().join("tmux-mobile")).unwrap()),
        ("file", |b| std::fs::write(b.cfg().join("teammux"), "not a directory").unwrap()),
    ];
    for (tag, make) in cases {
        let b = Base::new(tag);
        make(&b);
        let before = b.tree();
        let out = b.run(TMM, &["gateway", "status"], "");
        assert!(!out.status.success(), "{tag}: {}", text(&out.stdout));
        assert!(text(&out.stderr).contains("Nothing was changed"), "{tag}: {}", text(&out.stderr));
        assert_eq!(b.tree(), before, "{tag}: nothing written");
    }
}
