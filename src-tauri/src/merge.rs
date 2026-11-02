//! `tmm merge <issue> <branch> --expect <tip>` (board #445): ONE command
//! squash-merges a reviewed branch onto the branch checked out here, proves
//! the squash diff equals the branch diff, and writes the issue note from the
//! values THIS process read. It exists because "paste the hash from returned
//! output" was broken by every agent, orchestrator included, about a hundred
//! times (the tally on #445): a rule everyone breaks under load is a rule in
//! the wrong layer. The contract (reviewer design CLEAR 2026-11-02 11:02) is in
//! tmm-cli.md § tmm merge; the reasons sit next to each step below.
//!
//! What it never does: push, deploy, delete a branch, run a hook, stash,
//! clean or reset. What it does NOT claim: atomicity against another writer of
//! this checkout. That is a stated precondition, DETECTED at fixed
//! checkpoints; `tmm-merge.lock` only keeps a second `tmm merge` out.

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What the caller asked for.
pub struct Options {
    pub issue: i64,
    pub branch: String,
    pub expect: String,
    pub message_file: Option<PathBuf>,
    pub dry_run: bool,
    pub cwd: PathBuf,
    /// Who confirmed the gates (the operator; `TMM_AGENT`), named in the note.
    pub operator: String,
}

/// How the issue note went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteResult {
    Posted,
    /// The server answered with an error: the note is not on the card.
    Refused(String),
    /// No answer after the request may have been sent: it may be on the card.
    Unknown(String),
}

/// The gaps a test may act in (a takeover, an interruption). Production
/// passes a no-op; there is no env var or flag behind these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gap {
    BeforeSwap,
    /// After the pre-swap re-read and the `swapping` record, just before
    /// update-ref: the window only the compare-and-swap guards (X7).
    BeforeCas,
    /// Right after a successful compare-and-swap, before `swapped` is recorded.
    SwapDone,
    AfterSwap,
    AfterCheckout,
}

/// The faults a test may inject where real git cannot be made to fail on cue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault<'a> {
    /// The swap ran, but its result is reported as an error.
    SwapReportsError,
    /// Saving the record of this phase fails.
    Record(&'a str),
    /// The process dies halfway through writing this phase's record: half
    /// the bytes reach the file being written, then nothing more.
    TornRecord(&'a str),
}

/// The outside world: the board note, and the test seams.
pub trait Io {
    fn note(&mut self, text: &str) -> NoteResult;
    /// Return false to stop right here, as an interrupted process would.
    fn at(&mut self, _gap: Gap, _root: &Path) -> bool {
        true
    }
    /// Return true to inject that fault. Production never does.
    fn fault(&mut self, _f: Fault) -> bool {
        false
    }
}

/// The result class (tmm-cli.md § tmm merge, "Outcomes").
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Nothing changed: no ref, index or worktree write (unreferenced git
    /// objects may exist).
    Refused,
    /// `--dry-run`: everything checked, nothing written.
    Planned,
    /// The swap, the checkout and every read-back succeeded.
    Landed,
    /// The target ref is NEW and this command wrote nothing to the index or
    /// files: a takeover was detected, or a checkout refused untouched.
    RefLandedCheckoutNotStarted,
    /// The target ref is NEW, and the checkout failed after it may have
    /// written something.
    RefLandedCheckoutIncomplete,
    /// After the swap, a read-back did not match or a step could not be read.
    Unconfirmed,
    /// The process stopped (a test's interruption) with the lock left.
    Interrupted,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub kind: Kind,
    /// The one line printed, and (after a swap) the issue note.
    pub line: String,
    pub note: Option<NoteResult>,
    pub json: Value,
    /// A phase record that could not be saved after the swap: the run stopped
    /// there and posted nothing (reviewer P1-C residual on 8533a8cf).
    pub record_lost: Option<String>,
}

impl Report {
    fn refused(why: impl Into<String>) -> Report {
        let why = why.into();
        Report { kind: Kind::Refused, line: format!("tmm merge refused: {why} Nothing was merged."), note: None, json: json!({ "outcome": "refused", "reason": why }), record_lost: None }
    }
    /// A refusal because a previous run's lock is there: THIS run did
    /// nothing, and what the previous one did is in the text, not denied.
    fn refused_by_lock(why: String) -> Report {
        Report { kind: Kind::Refused, line: format!("tmm merge refused: {why} This run did nothing."), note: None, json: json!({ "outcome": "refused", "reason": why, "lock": true }), record_lost: None }
    }
    pub fn ok(&self) -> bool {
        matches!(self.kind, Kind::Landed | Kind::Planned) && self.record_lost.is_none() && self.note.as_ref().is_none_or(|n| *n == NoteResult::Posted)
    }
}

// ── git, bound to one repository, with no hook and no inherited binding ──

struct Git {
    root: PathBuf,
}

struct Out {
    code: i32,
    stdout: Vec<u8>,
    stderr: String,
}

impl Git {
    fn command(dir: &Path) -> Command {
        let mut c = Command::new("git");
        // `core.hooksPath=/dev/null`: read-tree fires post-index-change and
        // update-ref fires reference-transaction (measured, git 2.50.1); an
        // integration command runs no hook at all (contract P1-C).
        c.arg("-C").arg(dir).args(["-c", "core.hooksPath=/dev/null"]);
        // No opportunistic lock-and-write by a read (`status` and friends).
        // It does NOT stop `git diff --quiet` from saving refreshed stat data
        // (measured, git 2.50.1), which is why the content check below runs
        // on a private copy of the index.
        c.arg("--no-optional-locks");
        // The repository is the one bound at the start, never an inherited one.
        for v in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"] {
            c.env_remove(v);
        }
        c.env("LC_ALL", "C").env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null());
        c
    }
    fn run_in(dir: &Path, args: &[&str], input: Option<&[u8]>) -> Result<Out, String> {
        Self::run_with(dir, args, input, None)
    }
    fn run_with(dir: &Path, args: &[&str], input: Option<&[u8]>, index: Option<&Path>) -> Result<Out, String> {
        let mut c = Self::command(dir);
        if let Some(index) = index {
            c.env("GIT_INDEX_FILE", index);
        }
        c.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
        if input.is_some() {
            c.stdin(Stdio::piped());
        }
        let mut child = c.spawn().map_err(|e| format!("git could not start: {e}"))?;
        if let Some(bytes) = input {
            let mut stdin = child.stdin.take().ok_or("git stdin")?;
            stdin.write_all(bytes).map_err(|e| format!("git stdin: {e}"))?;
        }
        let o = child.wait_with_output().map_err(|e| format!("git: {e}"))?;
        Ok(Out { code: o.status.code().unwrap_or(-1), stdout: o.stdout, stderr: String::from_utf8_lossy(&o.stderr).trim().to_string() })
    }
    fn run(&self, args: &[&str], input: Option<&[u8]>) -> Result<Out, String> {
        Self::run_in(&self.root, args, input)
    }
    /// Exit 0 required; the trimmed stdout.
    fn text(&self, args: &[&str]) -> Result<String, String> {
        let o = self.run(args, None)?;
        if o.code != 0 {
            return Err(format!("git {} failed: {}", args.join(" "), first_line(&o.stderr)));
        }
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    }
    fn bytes(&self, args: &[&str]) -> Result<Vec<u8>, String> {
        let o = self.run(args, None)?;
        if o.code != 0 {
            return Err(format!("git {} failed: {}", args.join(" "), first_line(&o.stderr)));
        }
        Ok(o.stdout)
    }
    /// A yes/no question git answers with exit 0/1 (`--quiet` diffs).
    fn yes(&self, args: &[&str]) -> Result<bool, String> {
        let o = self.run(args, None)?;
        match o.code {
            0 => Ok(true),
            1 => Ok(false),
            _ => Err(format!("git {} failed: {}", args.join(" "), first_line(&o.stderr))),
        }
    }
    fn piped(&self, args: &[&str], input: &[u8]) -> Result<Vec<u8>, String> {
        let o = self.run(args, Some(input))?;
        if o.code != 0 {
            return Err(format!("git {} failed: {}", args.join(" "), first_line(&o.stderr)));
        }
        Ok(o.stdout)
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// A path as git stores it (raw bytes from `-z` output), shown with its
/// control characters escaped, never used for a lookup.
fn show(p: &[u8]) -> String {
    format!("{:?}", String::from_utf8_lossy(p))
}

fn os(p: &[u8]) -> &std::ffi::OsStr {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::OsStr::from_bytes(p)
}

/// The `\0`-separated records of a `-z` listing.
fn z_records(bytes: &[u8]) -> Vec<Vec<u8>> {
    bytes.split(|b| *b == 0).filter(|r| !r.is_empty()).map(|r| r.to_vec()).collect()
}

// ── the diff that is compared, byte for byte ──

/// The ONE diff form both sides are produced with (contract P1-D): no colour,
/// no external diff or textconv, binary payloads, no renames, a fixed
/// algorithm and prefixes, three lines of context.
const DIFF: &[&str] = &[
    "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.relative=false",
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--binary", "--no-renames", "--diff-algorithm=myers",
    "--src-prefix=a/", "--dst-prefix=b/", "-U3", "--ignore-submodules=none",
];

fn diff(git: &Git, from: &str, to: &str) -> Result<Vec<u8>, String> {
    let mut args: Vec<&str> = DIFF.to_vec();
    args.extend([from, to]);
    git.bytes(&args)
}

/// The only normalisation: drop a file header's `index ` line and the line
/// numbers in `@@ -a,b +c,d @@`. Whitespace, modes, binary payloads and the
/// function context after `@@` all stay.
pub fn normalise(diff: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(diff.len());
    let mut in_header = false;
    for line in diff.split_inclusive(|b| *b == b'\n') {
        if line.starts_with(b"diff --git ") {
            in_header = true;
        } else if line.starts_with(b"@@") || line.starts_with(b"GIT binary patch") || line.starts_with(b"Binary files ") {
            in_header = false;
        }
        if in_header && line.starts_with(b"index ") {
            continue;
        }
        if line.starts_with(b"@@ ") {
            if let Some(end) = line[3..].windows(3).position(|w| w == b" @@").map(|p| p + 3) {
                out.extend_from_slice(b"@@ @@");
                out.extend_from_slice(&line[end + 3..]);
                continue;
            }
        }
        out.extend_from_slice(line);
    }
    out
}

// ── the commit message: only the Co-authored-by set is replaced ──

const COAUTHOR: &str = "co-authored-by";

fn parse_trailers(git: &Git, msg: &str) -> Result<Vec<String>, String> {
    let o = git.piped(&["interpret-trailers", "--parse"], msg.as_bytes())?;
    Ok(String::from_utf8_lossy(&o).lines().map(|l| l.to_string()).filter(|l| !l.is_empty()).collect())
}

fn is_coauthor(trailer_line: &str) -> bool {
    trailer_line.split(':').next().is_some_and(|k| k.trim().eq_ignore_ascii_case(COAUTHOR))
}

/// The message with its Co-authored-by trailers replaced by `set` and every
/// other trailer kept, checked by git's own trailer parser afterwards.
fn rebuild_with(git: &Git, msg: &str, set: &[String]) -> Result<String, String> {
    let msg = msg.trim_end();
    if msg.trim().is_empty() {
        return Err("the commit message is empty".into());
    }
    let all = parse_trailers(git, msg)?;
    let (body, kept_lines): (String, Vec<String>) = if all.is_empty() {
        (msg.to_string(), Vec::new())
    } else {
        // git's trailer block is the message's last paragraph; confirm it by
        // parsing that paragraph alone, never by guessing. git never reads a
        // message's FIRST paragraph as trailers, so it gets a stand-in subject.
        let cut = msg.rfind("\n\n").ok_or("the message has trailers but no body before them")?;
        let (head, last) = (&msg[..cut], &msg[cut + 2..]);
        if parse_trailers(git, &format!("subject\n\n{last}"))? != all {
            return Err("cannot tell which paragraph holds the trailers; write the message with --message-file".into());
        }
        let mut kept = Vec::new();
        let mut dropping = false;
        for line in last.lines() {
            let continuation = line.starts_with(' ') || line.starts_with('\t');
            if continuation {
                if !dropping {
                    kept.push(line.to_string());
                }
                continue;
            }
            dropping = is_coauthor(line);
            if !dropping {
                kept.push(line.to_string());
            }
        }
        (head.trim_end().to_string(), kept)
    };
    if body.trim().is_empty() {
        return Err("the commit message has no subject".into());
    }
    let mut block = kept_lines;
    block.extend(set.iter().map(|v| format!("Co-authored-by: {v}")));
    let out = if block.is_empty() { format!("{body}\n") } else { format!("{body}\n\n{}\n", block.join("\n")) };
    // The check: the other trailers are exactly the original's, and the
    // Co-authored-by ones are exactly the set, in its order.
    let got = parse_trailers(git, &out)?;
    let others = |v: &[String]| v.iter().filter(|l| !is_coauthor(l)).cloned().collect::<Vec<_>>();
    let coauthors: Vec<String> = got.iter().filter(|l| is_coauthor(l)).map(|l| l.split_once(':').map(|(_, v)| v.trim().to_string()).unwrap_or_default()).collect();
    if others(&got) != others(&all) || coauthors != set {
        return Err("the rebuilt message's trailers do not read back as intended".into());
    }
    Ok(out)
}

// ── the lock: one tmm merge per repository, and the record of where it is ──

const LOCK: &str = "tmm-merge.lock";

/// The lock file IS the mutex (created exclusively) and the record of the
/// run (rewritten atomically: a temp file, fsync, rename, fsync of the dir),
/// so a process killed mid-write leaves the previous valid record.
struct Lock {
    path: PathBuf,
    state: Value,
}

impl Lock {
    fn take(common: &Path, state: Value) -> Result<Lock, String> {
        let path = common.join(LOCK);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => {
                let mut l = Lock { path, state };
                if let Err(e) = l.write() {
                    let _ = std::fs::remove_file(&l.path);
                    return Err(e);
                }
                Ok(l)
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!("{} already exists (read just now by another run?).", path.display())),
            Err(e) => Err(format!("cannot create {}: {e}", path.display())),
        }
    }
    /// Record `fields` with `phase`; a failure leaves the previous record.
    fn record(&mut self, io: &mut dyn Io, phase: &str, fields: Value) -> Result<(), String> {
        if io.fault(Fault::Record(phase)) {
            return Err(format!("the record of phase '{phase}' could not be saved (injected)"));
        }
        let torn = io.fault(Fault::TornRecord(phase));
        let before = self.state.clone();
        if let Value::Object(m) = fields {
            for (k, v) in m {
                self.state[k] = v;
            }
        }
        self.state["phase"] = json!(phase);
        let r = self.write_torn(torn);
        if r.is_err() {
            self.state = before;
        }
        r
    }
    fn write(&mut self) -> Result<(), String> {
        self.write_torn(false)
    }
    fn write_torn(&mut self, torn: bool) -> Result<(), String> {
        let tmp = self.path.with_extension("lock.tmp");
        let bytes = serde_json::to_vec_pretty(&self.state).map_err(|e| format!("the record: {e}"))?;
        let save = || -> std::io::Result<()> {
            let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(&tmp)?;
            if torn {
                f.write_all(&bytes[..bytes.len() / 2])?;
                return Err(std::io::Error::other("the write was cut halfway (injected)"));
            }
            f.write_all(&bytes)?;
            f.sync_all()?;
            std::fs::rename(&tmp, &self.path)?;
            if let Some(dir) = self.path.parent() {
                std::fs::File::open(dir)?.sync_all()?;
            }
            Ok(())
        };
        save().map_err(|e| format!("the record {} could not be saved: {e}", self.path.display()))
    }
    fn release(self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// An existing lock, read BEFORE anything else (reviewer P1-B on f3a34d16):
/// a live holder, or a stopped run with what it recorded and what git says
/// now. Never removed by this command.
fn lock_text(git: &Git, path: &Path) -> String {
    let v: Value = match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
        Ok(v) => v,
        Err(e) => return format!(
            "{} exists but cannot be read ({e}): a tmm merge may have stopped in this repository. Check the target ref, the index and `git status` by hand, then remove it.",
            path.display()
        ),
    };
    let pid = v["pid"].as_i64().unwrap_or(0);
    if pid > 0 && crate::config::process_alive(pid as libc::pid_t) {
        return format!("another tmm merge (pid {pid}) is running in this repository ({}).", path.display());
    }
    let g = |k: &str| v[k].as_str().unwrap_or("").to_string();
    let (phase, target, old, new) = (g("phase"), g("target"), g("old"), g("new"));
    // What git says NOW decides what happened, not the last checkpoint.
    let ref_now = if target.is_empty() { None } else { git.text(&["rev-parse", "--verify", "--quiet", &target]).ok() };
    let ref_says = match ref_now.as_deref() {
        None => "the target ref cannot be read".to_string(),
        Some(r) if !new.is_empty() && r == new => format!("{target} is now NEW {new}: the swap happened"),
        Some(r) if r == old => format!("{target} is OLD {old} now"),
        Some(r) => format!("{target} is now {r}, neither OLD {old} nor NEW {}", if new.is_empty() { "(none recorded)" } else { &new }),
    };
    let index_is = |oid: &str| !oid.is_empty() && git.yes(&["diff-index", "--cached", "--quiet", oid, "--"]).unwrap_or(false);
    // The lock is in the COMMON git dir, so the index read here is THIS
    // checkout's, which need not be the one the run worked in.
    let here = git.root.display().to_string();
    let index_says = format!(
        "{} (read in this checkout, {here}{})",
        if index_is(&new) { "the index matches NEW" } else if index_is(&old) { "the index matches OLD" } else { "the index matches neither OLD nor NEW" },
        match v["repo"].as_str() { Some(r) if r != here => format!("; the run worked in {r}"), _ => String::new() }
    );
    let note = v["note"].as_str().map(|n| format!(" Saved note: {n}")).unwrap_or_default();
    format!(
        "a previous tmm merge stopped without finishing (pid {pid} is gone). It recorded phase '{phase}' for issue #{}, branch {} at {}. Now: {ref_says}; {index_says}. \
         Check `git status` here and whether a note is on the card (tmm board show {}) before anything else; then remove {} by hand. This command never removes it, and re-running it is not the fix.{note}",
        v["issue"], g("src_ref"), g("src"), v["issue"], path.display()
    )
}

// ── signals: ignored from the swap to the end of the read-back ──

struct NoInterrupt {
    prev: [libc::sighandler_t; 2],
}

impl NoInterrupt {
    fn start() -> NoInterrupt {
        // SAFETY: setting a signal's disposition to SIG_IGN and back.
        unsafe { NoInterrupt { prev: [libc::signal(libc::SIGINT, libc::SIG_IGN), libc::signal(libc::SIGTERM, libc::SIG_IGN)] } }
    }
}

impl Drop for NoInterrupt {
    fn drop(&mut self) {
        // SAFETY: restoring the dispositions saved in `start`.
        unsafe {
            libc::signal(libc::SIGINT, self.prev[0]);
            libc::signal(libc::SIGTERM, self.prev[1]);
        }
    }
}

// ── the checkout, read without writing it ──

#[derive(Debug, PartialEq, Eq)]
struct IndexId {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: i64,
    mtime_ns: i64,
}

fn index_id(git_dir: &Path) -> Result<IndexId, String> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(git_dir.join("index")).map_err(|e| format!("the index cannot be read: {e}"))?;
    Ok(IndexId { dev: m.dev(), ino: m.ino(), len: m.len(), mtime: m.mtime(), mtime_ns: m.mtime_nsec() })
}

/// The index holds exactly `oid`'s tree.
fn index_is(git: &Git, oid: &str) -> Result<bool, String> {
    git.yes(&["diff-index", "--cached", "--quiet", oid, "--"])
}

/// Every tracked file matches the index, by content: a stale stat cache is not
/// a change. `git diff --quiet` refreshes stat data and SAVES it to the index
/// it reads (measured, git 2.50.1, with or without --no-optional-locks), so it
/// reads a private copy that is removed afterwards: the real index is never
/// written by a check (reviewer P1-B on f3a34d16).
fn files_match_index(git: &Git, git_dir: &Path) -> Result<bool, String> {
    let copy = git_dir.join(format!("tmm-merge-index-{}", std::process::id()));
    std::fs::copy(git_dir.join("index"), &copy).map_err(|e| format!("the index cannot be copied for a check: {e}"))?;
    let o = Git::run_with(&git.root, &["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none"], None, Some(&copy));
    let _ = std::fs::remove_file(&copy);
    let o = o?;
    match o.code {
        0 => Ok(true),
        1 => Ok(false),
        _ => Err(format!("git diff --quiet failed: {}", first_line(&o.stderr))),
    }
}

/// What is at `p`: `Ok(true)` something, `Ok(false)` nothing (NotFound, or a
/// file where a parent directory should be, which the ancestor check reports),
/// and any other error a refusal: a path that cannot be checked is never
/// treated as free (reviewer P1-A on f3a34d16).
fn occupied(root: &Path, p: &[u8]) -> Result<bool, String> {
    match std::fs::symlink_metadata(root.join(os(p))) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => Ok(false),
        Err(e) => Err(format!("{} cannot be checked ({e})", show(p))),
    }
}

/// The first thing in the way of a path NEW adds (contract P1-C): anything at
/// the path, or an ancestor that exists as a non-directory and is not a file
/// OLD tracks. git read-tree would overwrite an ignored file there.
fn in_the_way(root: &Path, added: &[Vec<u8>], tracked: &std::collections::HashSet<Vec<u8>>) -> Result<Option<Vec<u8>>, String> {
    for p in added {
        if occupied(root, p)? {
            return Ok(Some(p.clone()));
        }
        let parts: Vec<&[u8]> = p.split(|b| *b == b'/').collect();
        for depth in 1..parts.len() {
            let prefix = parts[..depth].join(&b'/');
            match std::fs::symlink_metadata(root.join(os(&prefix))) {
                Ok(m) if !m.is_dir() && !tracked.contains(&prefix) => return Ok(Some(prefix)),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(libc::ENOTDIR) => break,
                Err(e) => return Err(format!("{} cannot be checked ({e})", show(&prefix))),
            }
        }
    }
    Ok(None)
}

/// Every check the swap and the checkout rely on, re-read at a checkpoint.
fn checkout_still_ours(git: &Git, b: &Bound, id: &IndexId, tracked: &std::collections::HashSet<Vec<u8>>) -> Result<(), String> {
    let head = git.run(&["symbolic-ref", "-q", "HEAD"], None)?;
    let head = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head != b.target {
        return Err(format!("HEAD now points at {} instead of {}", if head.is_empty() { "a detached commit" } else { &head }, b.target));
    }
    if index_id(&b.git_dir)? != *id {
        return Err("the index file was changed by someone else".into());
    }
    if !index_is(git, &b.old)? {
        return Err("the index no longer matches OLD".into());
    }
    if !files_match_index(git, &b.git_dir)? {
        return Err("a tracked file was changed".into());
    }
    if let Some(p) = in_the_way(&b.root, &b.added, tracked)? {
        return Err(format!("{} now exists where the merge adds a path", show(&p)));
    }
    Ok(())
}

// ── binding: every value read once, then only full OIDs ──

struct Repo {
    root: PathBuf,
    git_dir: PathBuf,
    common: PathBuf,
}

/// The repository of `cwd`: read-only, before the lock is looked at.
fn locate(cwd: &Path) -> Result<Repo, String> {
    let top = Git::run_in(cwd, &["rev-parse", "--show-toplevel"], None)?;
    if top.code != 0 {
        return Err(format!("{} is not inside a git checkout.", cwd.display()));
    }
    let root = PathBuf::from(String::from_utf8_lossy(&top.stdout).trim());
    let git = Git { root: root.clone() };
    let git_dir = PathBuf::from(git.text(&["rev-parse", "--absolute-git-dir"])?);
    let common = PathBuf::from(git.text(&["rev-parse", "--path-format=absolute", "--git-common-dir"])?);
    Ok(Repo { root, git_dir, common })
}

struct Bound {
    root: PathBuf,
    git_dir: PathBuf,
    target: String,
    old: String,
    src_ref: String,
    src: String,
    base: String,
    commits: Vec<String>,
    tree: String,
    author: (String, String),
    trailers: Vec<String>,
    message: String,
    diff_len: usize,
    patch_id: String,
    added: Vec<Vec<u8>>,
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A unique abbreviation in THIS repository (at least 8), never a fixed cut.
fn ab(git: &Git, oid: &str) -> String {
    git.text(&["rev-parse", "--short=8", oid]).unwrap_or_else(|_| oid.to_string())
}

fn bind(o: &Options, repo: &Repo) -> Result<Bound, String> {
    if o.expect.len() < 8 || !is_hex(&o.expect) {
        return Err(format!("--expect must be at least 8 hex characters of the reviewed tip (got '{}').", o.expect));
    }
    let (root, git_dir) = (repo.root.clone(), repo.git_dir.clone());
    let git = Git { root: root.clone() };
    for state in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply", "sequencer"] {
        let p = git.text(&["rev-parse", "--path-format=absolute", "--git-path", state])?;
        if Path::new(&p).exists() {
            return Err(format!("this checkout is in the middle of another operation ({state} exists); finish or abort it first."));
        }
    }
    let head = git.run(&["symbolic-ref", "-q", "HEAD"], None)?;
    let target = String::from_utf8_lossy(&head.stdout).trim().to_string();
    if head.code != 0 || !target.starts_with("refs/heads/") {
        return Err("HEAD is detached; check out the branch to merge onto.".into());
    }
    let old = git.text(&["rev-parse", "--verify", &target])?;
    let name = git.text(&["config", "user.name"]).unwrap_or_default();
    let email = git.text(&["config", "user.email"]).unwrap_or_default();
    if name.is_empty() || email.is_empty() {
        return Err("git user.name and user.email must be configured: the squash keeps the configured author.".into());
    }
    let src_ref = if o.branch.starts_with("refs/heads/") { o.branch.clone() } else if o.branch.starts_with("refs/") {
        return Err(format!("{} is not a branch (only refs/heads/ is merged).", o.branch));
    } else {
        format!("refs/heads/{}", o.branch)
    };
    if src_ref == target {
        return Err(format!("{src_ref} is the branch checked out here."));
    }
    // An existing branch ref, exactly: `feat~1` is a revision, not a branch
    // (reviewer P2-E on f3a34d16).
    if !git.yes(&["show-ref", "--verify", "--quiet", &src_ref])? {
        return Err(format!("no branch {src_ref} here (a branch name, not a revision)."));
    }
    let src = git.text(&["rev-parse", "--verify", &format!("{src_ref}^{{commit}}")])?;
    let exp = git.run(&["rev-parse", "--verify", "--quiet", &format!("{}^{{commit}}", o.expect)], None)?;
    let exp_oid = String::from_utf8_lossy(&exp.stdout).trim().to_string();
    if exp.code != 0 || exp_oid.is_empty() {
        return Err(format!("--expect {} does not name exactly one commit here (unknown or ambiguous).", o.expect));
    }
    if exp_oid != src {
        return Err(format!("{src_ref} is at {}, not at --expect {} ({}): the branch moved after it was reviewed, or the hash is another commit.", ab(&git, &src), o.expect, ab(&git, &exp_oid)));
    }
    let bases = git.text(&["merge-base", "--all", &old, &src]).map_err(|_| format!("{src_ref} shares no history with {target}."))?;
    let bases: Vec<&str> = bases.lines().collect();
    if bases.len() != 1 {
        return Err(format!("{src_ref} and {target} have {} merge bases; rebase the branch first.", bases.len()));
    }
    let base = bases[0].to_string();
    let commits: Vec<String> = git.text(&["rev-list", "--reverse", "--topo-order", &format!("{base}..{src}")])?.lines().map(str::to_string).collect();
    if commits.is_empty() {
        return Err(format!("{src_ref} has no commit that {target} lacks."));
    }
    // The tracked tree must be clean, read without writing the index.
    if !index_is(&git, &old)? || !files_match_index(&git, &git_dir)? {
        return Err("tracked files have changes here; commit or move them first.".into());
    }
    // The merge, computed without touching the checkout.
    let mt = git.run(&["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", &old, &src], None)?;
    let records = z_records(&mt.stdout);
    match mt.code {
        0 => {}
        1 => {
            let paths: Vec<String> = records.iter().skip(1).map(|p| show(p)).collect();
            return Err(format!("the merge has conflicts ({}); rebase the branch first.", paths.join(", ")));
        }
        _ => return Err(format!("git merge-tree failed (git 2.38 or newer is needed): {}", first_line(&mt.stderr))),
    }
    let tree = records.first().map(|t| String::from_utf8_lossy(t).trim().to_string()).unwrap_or_default();
    // A submodule change is not supported in v1.
    for side in [(&base, &src), (&old, &tree)] {
        let raw = git.text(&["diff", "--raw", "--no-renames", "--no-abbrev", side.0, side.1])?;
        if raw.lines().any(|l| l.split_whitespace().take(2).any(|m| m.trim_start_matches(':') == "160000")) {
            return Err("the change touches a submodule (gitlink), which tmm merge does not merge.".into());
        }
    }
    // Diff equality, before any commit exists (contract P1-D).
    let branch_diff = diff(&git, &base, &src)?;
    if branch_diff.is_empty() {
        return Err(format!("{src_ref} changes nothing against {}.", ab(&git, &base)));
    }
    let squash_diff = diff(&git, &old, &tree)?;
    if normalise(&branch_diff) != normalise(&squash_diff) {
        return Err(format!(
            "the squash diff onto {} is not byte-for-byte the branch diff from {} (beyond index lines and @@ line numbers). \
             Usually {target} changed lines next to the branch's hunks; rebase the branch onto {target} and review that tip.",
            ab(&git, &old), ab(&git, &base)
        ));
    }
    let patch_id = String::from_utf8_lossy(&git.piped(&["patch-id", "--verbatim"], &branch_diff)?).split_whitespace().next().unwrap_or("").to_string();
    // Trailers: the branch's own Co-authored-by values, oldest first, once.
    let mut trailers: Vec<String> = Vec::new();
    for c in &commits {
        for v in git.text(&["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly,unfold)", c])?.lines() {
            let v = v.trim().to_string();
            if !v.is_empty() && !trailers.contains(&v) {
                trailers.push(v);
            }
        }
    }
    let raw_message = match &o.message_file {
        Some(p) => std::fs::read_to_string(p).map_err(|e| format!("--message-file {}: {e}", p.display()))?,
        None if commits.len() == 1 => git.text(&["log", "-1", "--format=%B", &src])?,
        None => return Err(format!("{src_ref} has {} commits; give the squash message with --message-file.", commits.len())),
    };
    let message = rebuild_with(&git, &raw_message, &trailers)?;
    // Paths as git stores them: raw `-z` records, never quoted or lossy text.
    let added = z_records(&git.bytes(&["diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", &old, &tree])?);
    Ok(Bound { root, git_dir, target, old, src_ref, src, base, commits, tree, author: (name, email), trailers, message, diff_len: branch_diff.len(), patch_id, added })
}

fn tracked_set(git: &Git, rev: &str) -> Result<std::collections::HashSet<Vec<u8>>, String> {
    Ok(z_records(&git.bytes(&["ls-tree", "-r", "-z", "--name-only", "--full-tree", rev])?).into_iter().collect())
}

/// `tree`, `parent`s and `author` of a commit object.
fn read_commit(git: &Git, oid: &str) -> Result<(String, Vec<String>, String, String), String> {
    let text = git.text(&["cat-file", "commit", oid])?;
    let (mut tree, mut parents, mut name, mut email) = (String::new(), Vec::new(), String::new(), String::new());
    for line in text.lines() {
        if line.is_empty() {
            break;
        }
        if let Some(t) = line.strip_prefix("tree ") {
            tree = t.to_string();
        } else if let Some(p) = line.strip_prefix("parent ") {
            parents.push(p.to_string());
        } else if let Some(a) = line.strip_prefix("author ") {
            if let (Some(lt), Some(gt)) = (a.find('<'), a.find('>')) {
                name = a[..lt].trim().to_string();
                email = a[lt + 1..gt].to_string();
            }
        }
    }
    Ok((tree, parents, name, email))
}

fn facts(b: &Bound) -> Value {
    json!({
        "repo": b.root, "target": b.target, "old": b.old, "src_ref": b.src_ref, "src": b.src, "base": b.base,
        "commits": b.commits.len(), "tree": b.tree, "author": format!("{} <{}>", b.author.0, b.author.1),
        "trailers": b.trailers, "diff_bytes": b.diff_len, "patch_id_verbatim": b.patch_id,
    })
}

fn note_json(n: &NoteResult) -> Value {
    match n {
        NoteResult::Posted => json!({ "state": "posted" }),
        NoteResult::Refused(why) => json!({ "state": "refused", "reason": why }),
        NoteResult::Unknown(why) => json!({ "state": "unknown", "reason": why }),
    }
}

/// After a successful checkout, ALL of these must hold (contract P1-B).
fn read_back(git: &Git, b: &Bound, new: &str) -> Result<(), String> {
    let now = git.text(&["rev-parse", "--verify", &b.target])?;
    if now != new {
        return Err(format!("{} is at {now}, not {new}", b.target));
    }
    let head = git.text(&["symbolic-ref", "-q", "HEAD"]).unwrap_or_default();
    if head != b.target {
        return Err(format!("HEAD points at {head}"));
    }
    let (tree, parents, _, _) = read_commit(git, new)?;
    if tree != b.tree || parents != [b.old.clone()] {
        return Err("the commit's tree or parent changed".into());
    }
    if !index_is(git, new)? {
        return Err("the index does not match the new commit".into());
    }
    if !files_match_index(git, &b.git_dir)? {
        return Err("a tracked file does not match the index".into());
    }
    Ok(())
}

fn interrupted(phase: &str, new: &str) -> Report {
    Report { kind: Kind::Interrupted, line: format!("tmm merge stopped at phase '{phase}' (new commit {new})"), note: None, json: json!({ "outcome": "interrupted", "phase": phase, "new": new }), record_lost: None }
}

/// Run it. The caller has already read the issue (it exists in this project).
pub fn run(o: &Options, io: &mut dyn Io) -> Report {
    // The repository, then an existing lock, BEFORE any other work: a stopped
    // run is reported with what it recorded, never bound over.
    let repo = match locate(&o.cwd) {
        Ok(r) => r,
        Err(e) => return Report::refused(e),
    };
    let git = Git { root: repo.root.clone() };
    let lock_path = repo.common.join(LOCK);
    if std::fs::symlink_metadata(&lock_path).is_ok() {
        return Report::refused_by_lock(lock_text(&git, &lock_path));
    }
    // A real run holds the lock from here: its own checks run alone.
    let lock = if o.dry_run {
        None
    } else {
        match Lock::take(&repo.common, json!({ "pid": std::process::id(), "issue": o.issue, "repo": repo.root, "phase": "binding" })) {
            Ok(l) => Some(l),
            Err(e) => return Report::refused(e),
        }
    };
    let refuse = |lock: Option<Lock>, why: String| {
        if let Some(l) = lock {
            l.release();
        }
        Report::refused(why)
    };
    let b = match bind(o, &repo) {
        Ok(b) => b,
        Err(e) => return refuse(lock, e),
    };
    let tracked = match tracked_set(&git, &b.old) {
        Ok(t) => t,
        Err(e) => return refuse(lock, e),
    };
    match in_the_way(&b.root, &b.added, &tracked) {
        Ok(None) => {}
        Ok(Some(p)) => return refuse(lock, format!("{} exists (untracked or ignored) where the merge adds a path; move it yourself first, tmm merge never removes a file.", show(&p))),
        Err(e) => return refuse(lock, format!("{e}, so the paths the merge adds cannot be confirmed free.")),
    }
    let trailers = if b.trailers.is_empty() { "none".to_string() } else { b.trailers.join("; ") };
    let pid12 = &b.patch_id[..b.patch_id.len().min(12)];
    let Some(mut lock) = lock else {
        let line = format!(
            "tmm merge --dry-run #{}: {} at {} ({} commits on {}) would squash onto {} at {}; author {} <{}>; trailers: {trailers}; \
             branch diff = squash diff, byte-exact ({} bytes, patch-id --verbatim {pid12}). No ref, index or file was changed and no note was posted.",
            o.issue, b.src_ref, ab(&git, &b.src), b.commits.len(), ab(&git, &b.base), b.target, ab(&git, &b.old), b.author.0, b.author.1, b.diff_len
        );
        let mut j = facts(&b);
        j["outcome"] = json!("planned");
        j["message"] = json!(b.message);
        return Report { kind: Kind::Planned, line, note: None, json: j, record_lost: None };
    };
    if let Err(e) = lock.record(io, "bound", json!({ "target": b.target, "old": b.old, "src_ref": b.src_ref, "src": b.src })) {
        return refuse(Some(lock), e);
    }
    // The commit object: the configured author, one parent, no hook.
    let new = match git.piped(&["commit-tree", &b.tree, "-p", &b.old, "-F", "-"], b.message.as_bytes()) {
        Ok(o) => String::from_utf8_lossy(&o).trim().to_string(),
        Err(e) => return refuse(Some(lock), e),
    };
    let built = (|| -> Result<(), String> {
        let (tree, parents, name, email) = read_commit(&git, &new)?;
        if tree != b.tree || parents != [b.old.clone()] || (name.as_str(), email.as_str()) != (b.author.0.as_str(), b.author.1.as_str()) {
            return Err(format!("the new commit {new} does not read back as built (tree, one parent {}, author).", b.old));
        }
        let got: Vec<String> = git.text(&["log", "-1", "--format=%(trailers:key=Co-authored-by,valueonly,unfold)", &new])?.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        if got != b.trailers {
            return Err(format!("the new commit {new} carries other Co-authored-by trailers than the branch's."));
        }
        Ok(())
    })();
    if let Err(e) = built.and_then(|_| lock.record(io, "committed", json!({ "new": new }))) {
        return refuse(Some(lock), e);
    }
    // ── the landing ──
    if !io.at(Gap::BeforeSwap, &b.root) {
        return interrupted("committed", &new);
    }
    let id = match index_id(&b.git_dir) {
        Ok(id) => id,
        Err(e) => return refuse(Some(lock), e),
    };
    let ready = checkout_still_ours(&git, &b, &id, &tracked).and_then(|_| {
        let now = git.text(&["rev-parse", "--verify", &b.target])?;
        if now != b.old { Err(format!("{} moved to {now} since it was read", b.target)) } else { Ok(()) }
    });
    if let Err(e) = ready {
        return refuse(Some(lock), format!("before landing: {e}."));
    }
    // The intent is durable BEFORE the swap: a crash after it says "swapping".
    if let Err(e) = lock.record(io, "swapping", json!({})) {
        return refuse(Some(lock), e);
    }
    let guard = NoInterrupt::start();
    if !io.at(Gap::BeforeCas, &b.root) {
        drop(guard);
        return interrupted("swapping", &new);
    }
    let mut swap = git.run(&["update-ref", "-m", &format!("tmm merge #{} {}", o.issue, b.src_ref), &b.target, &new, &b.old], None);
    if io.fault(Fault::SwapReportsError) {
        swap = Err("update-ref reported an error (injected)".into());
    }
    if !io.at(Gap::SwapDone, &b.root) {
        drop(guard);
        return interrupted("swapping", &new);
    }
    // A failed swap is classified by reading the ref, never assumed.
    let swap_err = match swap {
        Ok(out) if out.code == 0 => None,
        Ok(out) => Some(first_line(&out.stderr).to_string()),
        Err(e) => Some(e),
    };
    // Set when a phase record after the swap could not be saved: from there
    // nothing more is written, the issue note included.
    let mut lost: Option<String> = None;
    let outcome: (Kind, String) = 'land: {
        if let Some(err) = swap_err {
            match git.text(&["rev-parse", "--verify", &b.target]) {
                Ok(now) if now == b.old => {
                    drop(guard);
                    return refuse(Some(lock), format!("the compare-and-swap of {} refused ({err}); it is still OLD {}.", b.target, b.old));
                }
                Ok(now) if now == new => break 'land (Kind::Unconfirmed, format!(
                    "the swap reported an error ({err}) but {} reads NEW {new} (was {}); tmm merge did not update the index or any file. Check `git status`; nothing was rolled back.",
                    b.target, b.old
                )),
                Ok(now) => break 'land (Kind::Unconfirmed, format!(
                    "the swap reported an error ({err}) and {} reads {now}, neither OLD {} nor NEW {new}; tmm merge stopped there. Check it by hand.", b.target, b.old
                )),
                Err(e) => break 'land (Kind::Unconfirmed, format!(
                    "the swap reported an error ({err}) and {} cannot be read ({e}); tmm merge stopped there. Check it by hand.", b.target
                )),
            }
        }
        if let Err(e) = lock.record(io, "swapped", json!({})) {
            lost = Some(e.clone());
            break 'land (Kind::Unconfirmed, format!(
                "{} is NEW {new} (was {}), but {e}; tmm merge stopped before touching the index or any file. Check `git status`.", b.target, b.old
            ));
        }
        if !io.at(Gap::AfterSwap, &b.root) {
            drop(guard);
            return interrupted("swapped", &new);
        }
        if let Err(why) = checkout_still_ours(&git, &b, &id, &tracked) {
            break 'land (Kind::RefLandedCheckoutNotStarted, format!(
                "{} is now {new} (was {}), but this checkout was taken over after the swap ({why}), so tmm merge did not update the index or any file. Check `git status` here and decide by hand; nothing was rolled back.",
                b.target, b.old
            ));
        }
        if let Err(e) = lock.record(io, "checking-out", json!({})) {
            lost = Some(e.clone());
            break 'land (Kind::Unconfirmed, format!(
                "{} is NEW {new} (was {}), but {e}; tmm merge stopped before touching the index or any file. Check `git status`.", b.target, b.old
            ));
        }
        let rt = git.run(&["read-tree", "-m", "-u", &b.old, &new], None);
        match rt {
            Ok(out) if out.code == 0 => {}
            other => {
                let err = match other { Ok(o) => first_line(&o.stderr).to_string(), Err(e) => e };
                let untouched = index_is(&git, &b.old).unwrap_or(false)
                    && files_match_index(&git, &b.git_dir).unwrap_or(false)
                    && matches!(in_the_way(&b.root, &b.added, &tracked), Ok(None));
                break 'land if untouched {
                    (Kind::RefLandedCheckoutNotStarted, format!(
                        "{} is now {new} (was {}), but the checkout refused ({err}). Read back: the index and files are still OLD's, untouched. Once the cause is dealt with, `git read-tree -m -u {} {new}` finishes it.",
                        b.target, b.old, b.old
                    ))
                } else {
                    (Kind::RefLandedCheckoutIncomplete, format!(
                        "{} is now {new} (was {}), and the checkout failed partway ({err}). The index or files may be partly updated. Inspect `git rev-parse {}`, `git status` and `git diff --stat`; nothing was replayed or rolled back.",
                        b.target, b.old, b.target
                    ))
                };
            }
        }
        if let Err(e) = lock.record(io, "checked-out", json!({})) {
            lost = Some(e.clone());
            break 'land (Kind::Unconfirmed, format!("{} is NEW {new} and checked out, but {e}; the read-back was not trusted to a lost record. Check `git status`.", b.target));
        }
        if !io.at(Gap::AfterCheckout, &b.root) {
            drop(guard);
            return interrupted("checked-out", &new);
        }
        match read_back(&git, &b, &new) {
            Ok(()) => (Kind::Landed, String::new()),
            Err(why) => (Kind::Unconfirmed, format!(
                "{} was swapped to {new} (from {}) and checked out, but a read-back did not match: {why}. Check `git rev-parse {}` and `git status`; nothing was rolled back.",
                b.target, b.old, b.target
            )),
        }
    };
    drop(guard);
    let text = if outcome.0 == Kind::Landed {
        format!(
            "tmm merge #{}: {} at {} ({} commits on {}) squashed onto {} as {}, parent {}; author {} <{}>; trailers: {trailers}; \
             branch diff = squash diff, byte-exact ({} bytes, patch-id --verbatim {pid12}). Tip locked by --expect {}; the gates were confirmed by {}, not checked by this command. Not pushed or deployed; the branch is kept.",
            o.issue, b.src_ref, ab(&git, &b.src), b.commits.len(), ab(&git, &b.base), b.target, ab(&git, &new), ab(&git, &b.old), b.author.0, b.author.1,
            b.diff_len, o.expect, o.operator
        )
    } else {
        format!("tmm merge #{} did NOT finish: {}", o.issue, outcome.1)
    };
    let mut j = facts(&b);
    j["new"] = json!(new);
    j["outcome"] = json!(format!("{:?}", outcome.0));
    j["text"] = json!(text);
    // The note is posted only after its record is durable; a lost record at
    // any phase after the swap (or of the note itself) ends the run here.
    if lost.is_none() {
        if let Err(e) = lock.record(io, if outcome.0 == Kind::Landed { "noting" } else { "unsettled" }, json!({ "note": text, "outcome": format!("{:?}", outcome.0) })) {
            lost = Some(e);
        }
    }
    if let Some(e) = lost {
        let landed = if outcome.0 == Kind::Landed { "The merge LANDED and every read-back matched" } else { "The merge did not finish (above)" };
        let line = format!(
            "{text} [RECORD NOT SAVED: {e}. {landed}, but the run stopped there: no note was posted. The lock {} keeps the last record that was saved; check `git status`, post the note by hand, then remove the lock.]",
            lock.path.display()
        );
        j["record"] = json!({ "state": "lost", "reason": e });
        j["note"] = json!({ "state": "not_attempted" });
        return Report { kind: outcome.0, line, note: None, json: j, record_lost: Some(e) };
    }
    j["record"] = json!({ "state": "saved" });
    let note = io.note(&text);
    let mut line = text.clone();
    match &note {
        NoteResult::Posted => {}
        NoteResult::Refused(why) => line.push_str(&format!(" [NOTE NOT POSTED: the server refused it ({why}). Post this text with tmm board note {}.]", o.issue)),
        NoteResult::Unknown(why) => line.push_str(&format!(" [NOTE UNKNOWN: no confirmed answer ({why}); it may be on the card. Check tmm board show {} before posting this text by hand. Do not re-run tmm merge.]", o.issue)),
    }
    if outcome.0 == Kind::Landed && note == NoteResult::Posted {
        lock.release();
    } else {
        // An unsettled state stays recorded until a person has looked.
        line.push_str(&format!(" The lock {} is kept with the state; remove it by hand after checking.", lock.path.display()));
    }
    j["note"] = note_json(&note);
    Report { kind: outcome.0, line, note: Some(note), json: j, record_lost: None }
}

#[cfg(test)]
mod tests;
