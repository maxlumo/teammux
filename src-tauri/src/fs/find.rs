//! Board #144 (owner, 2026-11-16: "如果文件你找不到，你能不能帮我去find一下 … 必须后边完全匹配才算，
//! 如果匹配到一个，直接显示，如果匹配到多个，就显示一个选项卡"): a path an agent wrote relative to a
//! SUBFOLDER of the project is found where it ends. A candidate is <root>/<one or more
//! folders>/<ref>, the ref matching as whole trailing segments (one stat of `<dir>/<ref>` per
//! directory, so `b/c.txt` is never `x/ab/c.txt`), case as the filesystem compares it.
//!
//! Method (measured on #144, note 1): an in-process walk of DIRECTORIES only, nearest first
//! (breadth first, children by name), one stat per directory; no file listing is matched, no
//! process started, nothing installed. Within 1.1-1.8x of fd warm; a 55k-directory tree's
//! first touch took 28 s, so the walk is bounded (`LIMITS`) and says when it stopped.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Directories never entered: version control and dependency or build stores, matched by
/// exact name. Git-ignored folders ARE searched (agents write into temp/ and worktree/).
pub const SKIP: &[&str] = &[".git", ".hg", ".svn", "node_modules", "target", ".cargo", ".rustup", ".venv", "venv", "__pycache__", ".cache", ".pnpm-store", ".gradle"];

/// How many matches are collected (the app shows the 10 nearest and says when there are more).
pub const COLLECT: usize = 21;

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub dirs: usize,
    pub ms: u64,
}

/// The walk's bounds: 2 s or 100,000 directories, whichever comes first.
pub const LIMITS: Limits = Limits { dirs: 100_000, ms: 2_000 };

#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Found {
    /// Root-relative paths, nearest first.
    pub matches: Vec<String>,
    /// More than `COLLECT` exist (the walk stopped collecting).
    pub more: bool,
    /// Not complete: `"time"` or `"dirs"` when a limit ended the walk before it covered the
    /// tree; `"unreadable"` when a folder could not be listed (a failed read is never an empty
    /// folder: validator-2 note 39, ruled 40), the walk going on past it. A limit, the later
    /// and wider stop, names the reason when both happened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<&'static str>,
}

/// The reference as searched: relative, without `./`, and no `..` segment, NUL, `~` or
/// absolute form (those are never searched).
pub fn reference(r: &str) -> Result<&str, String> {
    let r = r.strip_prefix("./").unwrap_or(r);
    if r.is_empty() || r == "." || r.starts_with('/') || r.starts_with('~') || r.contains('\0') || r.split('/').any(|s| s == "..") {
        return Err(format!("not a relative reference: {r:?}"));
    }
    Ok(r)
}

pub fn find_tail(root: &Path, r: &str, limits: Limits) -> Result<Found, String> {
    let r = reference(r)?;
    let root = std::fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    if super::too_wide(&root) {
        return Err(format!("{}: too wide to search", root.display()));
    }
    let deadline = Instant::now() + Duration::from_millis(limits.ms);
    let mut found = Found { matches: Vec::new(), more: false, stopped: None };
    let mut queue: VecDeque<PathBuf> = VecDeque::new();
    children(&root, &mut queue, &mut found);
    let mut seen = 0usize;
    // One real file is one match (validator-2 note 12, ruled note 13): a reference's own
    // segments resolve as a direct open would, a symlinked one included, so one file can be
    // reached by two spellings; the nearest (first in walk order) is the one kept.
    let mut canonical: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    while let Some(dir) = queue.pop_front() {
        if Instant::now() >= deadline { found.stopped = Some("time"); break; }
        if seen >= limits.dirs { found.stopped = Some("dirs"); break; }
        seen += 1;
        let cand = dir.join(r);
        let real = std::fs::symlink_metadata(&cand).ok().and_then(|_| std::fs::canonicalize(&cand).ok()).filter(|c| c.starts_with(&root));
        if let Some(real) = real.filter(|c| !canonical.contains(c)) {
            if found.matches.len() == COLLECT { found.more = true; break; }
            canonical.insert(real);
            found.matches.push(cand.strip_prefix(&root).unwrap_or(&cand).to_string_lossy().into_owned());
        }
        children(&dir, &mut queue, &mut found);
    }
    Ok(found)
}

/// Queue a directory's subdirectories by name: real directories only (a symlink is not
/// followed), none named in `SKIP`. A listing or an entry that cannot be read marks the answer
/// `"unreadable"`; what could be read is still queued.
fn children(dir: &Path, queue: &mut VecDeque<PathBuf>, found: &mut Found) {
    let mut unreadable = || { found.stopped.get_or_insert("unreadable"); };
    let Ok(rd) = std::fs::read_dir(dir) else { unreadable(); return };
    let mut out: Vec<PathBuf> = Vec::new();
    for e in rd {
        let Ok(e) = e else { unreadable(); continue };
        let Ok(t) = e.file_type() else { unreadable(); continue };
        if t.is_dir() && !SKIP.contains(&e.file_name().to_string_lossy().as_ref()) { out.push(e.path()); }
    }
    out.sort();
    queue.extend(out);
}

#[cfg(test)]
#[path = "find_tests.rs"]
mod tests;
