//! The project page store (board #111; docs/design-docs/features/dashboard.md
//! § The project page). One static page per project, published by its agents
//! with `tmm dashboard publish <dir>` and shown inert as the Dashboard's last
//! section.
//!
//! ```text
//! <ws>/.tmm/dashboard/
//!   page.json        {"current": N|null, "next": N+1, "revisions": [{rev, by, at_ms, retired_ms}]}
//!   .lock            the flock every pointer read-and-mint and every pointer move holds
//!   <N>/             one revision: index.html and its files, never written after the move
//!   .staging-<id>/   a publication being copied
//! ```
//!
//! The server is the only writer (the CLI hands it a path; #434 P1-D's rule).
//! A publication is copied OUTSIDE the lock, then renamed to its number and
//! made current INSIDE it; a load reads the pointer, the page and mints the
//! document's file access inside the same lock (AC2), so a revision is
//! retired no earlier than any cap minted for it, and removed only once it has
//! not been current for the door's whole lifetime (`keep_ms`, the caller's
//! `DL_STREAM_TTL_SECS`). page.json lists only LIVE revisions (R7): the
//! current one and those retired within `keep_ms`.
//!
//! Every step is a held directory handle (`safe_fs::Dir`): a symlink anywhere
//! in the store, or in a bundle being published, is never followed.

use crate::safe_fs::{self, Dir};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;

/// The preview's text limit (file-preview.ts `isPreviewable`): the page's
/// document travels in the load's answer.
pub const INDEX_MAX_BYTES: u64 = 512 * 1024;
/// A bundle is a page and its own small files; a mix or a film is a project
/// file the page points at, not a copy.
pub const BUNDLE_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const BUNDLE_MAX_FILES: usize = 500;
pub const BUNDLE_MAX_DEPTH: usize = 16;
/// Where a revision lives below the project root. A page reaches a project
/// file as `../../../<path from the project root>`: the depth is part of the
/// authoring contract (leader, #111 note 8, Q1), pinned by a test.
pub const REVISION_DIR: [&str; 2] = [".tmm", "dashboard"];

const STORE: &str = "page.json";
const LOCK: &str = ".lock";
const STAGING: &str = ".staging-";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Revision {
    pub rev: u64,
    pub by: String,
    pub at_ms: u64,
    pub retired_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Default, Debug, PartialEq)]
pub struct Manifest {
    pub current: Option<u64>,
    pub next: u64,
    pub revisions: Vec<Revision>,
}

/// The current page's head: what the dashboard read carries.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Head {
    pub rev: u64,
    pub by: String,
    pub at_ms: u64,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Published {
    pub rev: u64,
    pub files: usize,
    pub bytes: u64,
    /// Published, but not known durable (the folder sync after the commit failed).
    pub warning: Option<String>,
}

/// One load: the current revision, its document, its absolute directory (a
/// relative link's base in the client) and the cap minted for it.
#[derive(Serialize, Debug)]
pub struct Loaded {
    pub rev: u64,
    pub by: String,
    pub at_ms: u64,
    pub html: String,
    pub dir: String,
    pub base: String,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_link(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFLNK
}

fn io(what: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| format!("{what}: {e}")
}

/// The project root, canonical, as a held handle.
fn root_of(ws: &Path) -> Result<(String, Dir), String> {
    let root = std::fs::canonicalize(ws).map_err(|e| format!("project folder {}: {e}", ws.display()))?;
    let dir = Dir::open(&root).map_err(|e| format!("project folder {}: {e}", root.display()))?;
    Ok((root.to_string_lossy().into_owned(), dir))
}

/// `<root>/.tmm/dashboard`, never through a symlink. `create` makes the
/// missing steps (publish); otherwise an absent or symlinked step is `None`
/// (no page).
fn store_of(root: &Dir, create: bool) -> Result<Option<Dir>, String> {
    let mut dir = None::<Dir>;
    for name in REVISION_DIR {
        let parent = dir.as_ref().unwrap_or(root);
        match parent.stat_at(name).map_err(io(name))? {
            Some(st) if safe_fs::is_dir(&st) => {}
            Some(_) if !create => return Ok(None),
            Some(_) => return Err(format!("{}: not a directory (a symlink is never followed)", REVISION_DIR.join("/"))),
            None if !create => return Ok(None),
            // mkdir -p semantics (F4): a concurrent first publication may make
            // it between the stat and here; the open below checks what it is.
            None => match parent.mkdir(name, 0o755) {
                Ok(()) => {}
                Err(e) if e.raw_os_error() == Some(libc::EEXIST) => {}
                Err(e) => return Err(format!("{name}: {e}")),
            },
        }
        let opened = parent.open_dir(name).map_err(|e| match e.raw_os_error() {
            Some(libc::ELOOP) | Some(libc::ENOTDIR) => format!("{}: not a directory (a symlink is never followed)", REVISION_DIR.join("/")),
            _ => format!("{name}: {e}"),
        })?;
        dir = Some(opened);
    }
    Ok(dir)
}

/// The store's lock: the ONE flock guard (`crate::flock`, board #136), blocking,
/// released with LOCK_UN on drop (a forked child holds the open file description
/// until its execve, so a close alone could keep it held).
fn lock(store: &Dir) -> Result<crate::flock::Flock, String> {
    let f = open_regular(store, LOCK, libc::O_RDWR | libc::O_CREAT, 0o600)?;
    crate::flock::Flock::exclusive(f).map_err(|e| format!("{LOCK}: {e}"))
}

/// Open a store file that must be a REGULAR file (F3): O_NONBLOCK, so a FIFO
/// or a device never blocks the opener, O_NOFOLLOW (the handle walk adds it),
/// and the opened object fstat-checked. Anything else is an error at once.
fn open_regular(store: &Dir, name: &str, flags: libc::c_int, mode: libc::mode_t) -> Result<std::fs::File, String> {
    let f = store.open_file(name, flags | libc::O_NONBLOCK, mode).map_err(|e| match e.raw_os_error() {
        Some(libc::ELOOP) => format!("{name} is a symlink, not the page store's file"),
        _ => format!("{name}: {e}"),
    })?;
    if !f.metadata().map_err(io(name))?.is_file() {
        return Err(format!("{name} is not a regular file"));
    }
    Ok(f)
}

fn read_manifest(store: &Dir) -> Result<Manifest, String> {
    match store.stat_at(STORE).map_err(io(STORE))? {
        None => return Ok(Manifest::default()),
        Some(st) if !safe_fs::is_file(&st) => return Err(format!("{STORE} is not a regular file; remove it to start the page store again")),
        Some(_) => {}
    }
    let mut text = String::new();
    open_regular(store, STORE, libc::O_RDONLY, 0)?.read_to_string(&mut text).map_err(io(STORE))?;
    serde_json::from_str(&text).map_err(|e| format!("{STORE} is not readable ({e}); remove it to start the page store again"))
}

/// tmp + fsync + rename + directory fsync: a reader sees the old file or the
/// new one, never half.
/// THE COMMIT POINT is the rename (leader, #111 note 18). Before it, any
/// failure removes the tmp it wrote and answers `Err`: page.json is as it was.
/// After it the new pointer IS the store; a failure to sync the folder is
/// `Ok(Some(warning))`, a durability warning, never a refusal.
fn write_manifest(store: &Dir, m: &Manifest) -> Result<Option<String>, String> {
    let tmp = format!("{STORE}.tmp");
    let mut f = open_regular(store, &tmp, libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC, 0o644)?;
    let written = fault("tmp-write").and_then(|()| f.write_all(serde_json::to_string(m).unwrap_or_default().as_bytes()))
        .and_then(|()| fault("tmp-sync")).and_then(|()| f.sync_all())
        .map_err(io(&tmp))
        .and_then(|()| fault("rename").and_then(|()| store.rename(&tmp, STORE)).map_err(io(STORE)));
    if let Err(e) = written {
        let _ = store.unlink(&tmp);
        return Err(e);
    }
    Ok(fault("dir-sync").and_then(|()| store.sync()).err().map(|e| format!("{STORE} is written but the store folder could not be synced: {e}")))
}

/// Test-only fault injection at a named step of the commit (#111 note 18);
/// always Ok in production.
fn fault(_at: &str) -> std::io::Result<()> {
    #[cfg(test)]
    if tests::fault_hits(_at) {
        return Err(std::io::Error::from_raw_os_error(libc::EIO));
    }
    Ok(())
}

/// Remove `name` below `parent`: files unlinked, directories emptied then
/// removed, a symlink unlinked as itself and never followed.
fn remove_tree(parent: &Dir, name: &str) -> std::io::Result<()> {
    let dir = match parent.open_dir(name) {
        Ok(d) => d,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
        Err(e) => return Err(e),
    };
    for child in dir.names()? {
        match dir.stat_at(&child)? {
            Some(st) if safe_fs::is_dir(&st) => remove_tree(&dir, &child)?,
            Some(_) => dir.unlink(&child)?,
            None => {}
        }
    }
    parent.rmdir(name)
}

/// The page that is current, if any; `Ok(None)` for no page, or for a store
/// whose revision directory or index.html is a symlink (AC3: no page).
pub fn head(ws: &Path) -> Result<Option<Head>, String> {
    let (_, root) = root_of(ws)?;
    let Some(store) = store_of(&root, false)? else { return Ok(None) };
    let m = read_manifest(&store)?;
    let Some(rev) = m.current else { return Ok(None) };
    if !page_intact(&store, rev)? {
        return Ok(None);
    }
    Ok(m.revisions.iter().find(|r| r.rev == rev).map(|r| Head { rev, by: r.by.clone(), at_ms: r.at_ms }))
}

fn page_intact(store: &Dir, rev: u64) -> Result<bool, String> {
    let name = rev.to_string();
    match store.stat_at(&name).map_err(io(&name))? {
        Some(st) if safe_fs::is_dir(&st) => {}
        _ => return Ok(false),
    }
    let dir = store.open_dir(&name).map_err(io(&name))?;
    Ok(dir.stat_at("index.html").map_err(io("index.html"))?.is_some_and(|st| safe_fs::is_file(&st)))
}

/// Load the current page: the pointer, the document and the cap, in ONE
/// critical section (AC2). `mint(root, dir)` signs the door for `dir` below
/// `root` (download::scope_base); it runs while the lock is held, so no
/// publication can retire the revision between the read and the mint.
pub fn load(ws: &Path, mint: &mut dyn FnMut(&str, &[String]) -> Result<String, String>) -> Result<Option<Loaded>, String> {
    let (root_path, root) = root_of(ws)?;
    let Some(store) = store_of(&root, false)? else { return Ok(None) };
    let _held = lock(&store)?;
    let m = read_manifest(&store)?;
    let Some(rev) = m.current else { return Ok(None) };
    let Some(meta) = m.revisions.iter().find(|r| r.rev == rev) else { return Ok(None) };
    let name = rev.to_string();
    let Ok(dir) = store.open_dir(&name) else { return Ok(None) };
    let Ok(mut f) = dir.open_file("index.html", libc::O_RDONLY | libc::O_NONBLOCK, 0) else { return Ok(None) };
    let st = f.metadata().map_err(io("index.html"))?;
    if !st.is_file() || st.len() > INDEX_MAX_BYTES {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes).map_err(io("index.html"))?;
    let segs: Vec<String> = REVISION_DIR.iter().map(|s| s.to_string()).chain([name.clone()]).collect();
    let base = mint(&root_path, &segs)?;
    Ok(Some(Loaded {
        rev,
        by: meta.by.clone(),
        at_ms: meta.at_ms,
        html: String::from_utf8_lossy(&bytes).into_owned(),
        dir: format!("{root_path}/{}", segs.join("/")),
        base,
    }))
}

struct Budget {
    files: usize,
    bytes: u64,
}

/// Walk `src`, refusing anything but regular files and folders, within the
/// ceilings. With `dst` the files are COPIED there (bytes counted as they are
/// read, the opened object re-checked); without it the walk only VALIDATES,
/// from the entries' own stat, and writes nothing. `rel` names the place for a
/// refusal.
fn copy_tree(src: &Dir, dst: Option<&Dir>, rel: &str, depth: usize, b: &mut Budget) -> Result<(), String> {
    let mut names = src.names().map_err(|e| format!("{}: {e}", if rel.is_empty() { "." } else { rel }))?;
    names.sort();
    for name in names {
        let at = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if !safe_fs::plain_name(&name) {
            return Err(format!("{at}: not a plain file name"));
        }
        let Some(st) = src.stat_at(&name).map_err(io(&at))? else { return Err(format!("{at}: vanished while publishing")) };
        if is_link(&st) {
            return Err(format!("{at} is a symlink; a page holds regular files only"));
        }
        if safe_fs::is_dir(&st) {
            if depth + 1 > BUNDLE_MAX_DEPTH {
                return Err(format!("{at}: deeper than {BUNDLE_MAX_DEPTH} folders"));
            }
            let from = src.open_dir(&name).map_err(io(&at))?;
            match dst {
                Some(dst) => {
                    dst.mkdir(&name, 0o755).map_err(io(&at))?;
                    let to = dst.open_dir(&name).map_err(io(&at))?;
                    copy_tree(&from, Some(&to), &at, depth + 1, b)?;
                }
                None => copy_tree(&from, None, &at, depth + 1, b)?,
            }
            continue;
        }
        if !safe_fs::is_file(&st) {
            return Err(format!("{at} is not a regular file"));
        }
        b.files += 1;
        if b.files > BUNDLE_MAX_FILES {
            return Err(format!("more than {BUNDLE_MAX_FILES} files"));
        }
        let limit = if at == "index.html" { INDEX_MAX_BYTES } else { BUNDLE_MAX_BYTES };
        let over = |copied: u64, total: u64| -> Result<(), String> {
            if copied > limit {
                return Err(format!("{at}: larger than {} KiB", limit / 1024));
            }
            if total > BUNDLE_MAX_BYTES {
                return Err(format!("the page's files are larger than {} MiB together", BUNDLE_MAX_BYTES / (1024 * 1024)));
            }
            Ok(())
        };
        let Some(dst) = dst else {
            b.bytes += st.st_size as u64;
            over(st.st_size as u64, b.bytes)?;
            continue;
        };
        let mut from = src.open_file(&name, libc::O_RDONLY | libc::O_NONBLOCK, 0).map_err(io(&at))?;
        // The opened object is the one checked: a name swapped for a fifo or a
        // device after the stat is refused here.
        if !from.metadata().map_err(io(&at))?.is_file() {
            return Err(format!("{at} is not a regular file"));
        }
        let mut to = dst.open_file(&name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o644).map_err(io(&at))?;
        let mut copied = 0u64;
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let n = from.read(&mut chunk).map_err(io(&at))?;
            if n == 0 {
                break;
            }
            copied += n as u64;
            b.bytes += n as u64;
            over(copied, b.bytes)?;
            to.write_all(&chunk[..n]).map_err(io(&at))?;
        }
        to.sync_all().map_err(io(&at))?;
    }
    Ok(())
}

/// The bundle's index.html, read from `dir`'s own entry: present, a regular
/// file, within the limit.
fn index_ok(dir: &Dir, what: &str) -> Result<(), String> {
    match dir.stat_at("index.html").map_err(io("index.html"))? {
        None => Err(format!("{what} has no index.html")),
        Some(st) if is_link(&st) => Err("index.html is a symlink; a page holds regular files only".into()),
        Some(st) if !safe_fs::is_file(&st) => Err("index.html is not a regular file".into()),
        Some(st) if st.st_size as u64 > INDEX_MAX_BYTES => Err(format!("index.html: larger than {} KiB", INDEX_MAX_BYTES / 1024)),
        Some(_) => Ok(()),
    }
}

/// Validate and copy `src` as a new revision, then make it current (the last
/// publish wins). A refusal changes nothing (F1, leader notes 18 and 23): the
/// whole bundle is validated before anything is created; a failure before
/// the commit (the rename of page.json) leaves no new revision, no tmp and
/// page.json byte-identical (or still absent); only the store's empty
/// skeleton may remain. After the commit, nothing the pointer names is
/// deleted and every later problem is the answer's `warning`.
pub fn publish(ws: &Path, src: &Path, by: &str, keep_ms: u64, now: &dyn Fn() -> u64) -> Result<Published, String> {
    let shown = src.display();
    // Named before the open: Linux answers a symlink opened O_DIRECTORY|O_NOFOLLOW
    // with ENOTDIR, not ELOOP. The open below still refuses a link swapped in after.
    match std::fs::symlink_metadata(src) {
        Ok(m) if m.file_type().is_symlink() => return Err(format!("{shown} is a symlink; publish the folder itself")),
        Ok(m) if !m.is_dir() => return Err(format!("{shown} is not a folder")),
        Ok(_) => {}
        Err(e) => return Err(format!("{shown}: {e}")),
    }
    let from = Dir::open(src).map_err(|e| format!("{shown}: {e}"))?;
    index_ok(&from, &shown.to_string())?;
    copy_tree(&from, None, "", 0, &mut Budget { files: 0, bytes: 0 })?;
    #[cfg(test)]
    tests::AFTER_VALIDATION.with(|h| if let Some(f) = h.borrow().as_ref() { f() });
    let (_, root) = root_of(ws)?;
    // The store's skeleton (the folder and, later, its .lock) may be made by
    // any attempt and is not a change: it holds no revision and no pointer.
    // It is never removed by a failing publisher, whose concurrent peer may
    // hold or wait on that lock (leader note 23, A).
    let store = store_of(&root, true)?.ok_or("the page store could not be made")?;
    let staging = format!("{STAGING}{}", uuid::Uuid::new_v4().simple());
    let mut budget = Budget { files: 0, bytes: 0 };
    let copied = store.mkdir(&staging, 0o755).map_err(io(&staging))
        .and_then(|()| store.open_dir(&staging).map_err(io(&staging)))
        .and_then(|to| {
            copy_tree(&from, Some(&to), "", 0, &mut budget)?;
            // F2: what is published is what was COPIED.
            index_ok(&to, "the copied page")
        });
    if let Err(e) = copied {
        let _ = remove_tree(&store, &staging);
        return Err(e);
    }
    let held = match lock(&store) {
        Ok(h) => h,
        Err(e) => {
            let _ = remove_tree(&store, &staging);
            return Err(e);
        }
    };
    let committed = (|| {
        let mut m = read_manifest(&store)?;
        let mut rev = m.next.max(1);
        while store.stat_at(&rev.to_string()).map_err(io("revision"))?.is_some() {
            rev += 1;
        }
        store.rename(&staging, &rev.to_string()).map_err(io("revision"))?;
        let t = now();
        retire(&mut m, t);
        m.revisions.push(Revision { rev, by: by.to_string(), at_ms: t, retired_ms: None });
        m.current = Some(rev);
        m.next = rev + 1;
        match write_manifest(&store, &m) {
            // Not committed: the pointer is untouched, so the revision goes.
            Err(e) => {
                let _ = remove_tree(&store, &rev.to_string());
                Err(e)
            }
            Ok(warning) => Ok::<(u64, Manifest, u64, Option<String>), String>((rev, m, t, warning)),
        }
    })();
    let (rev, mut m, t, warning) = match committed {
        Ok(c) => c,
        Err(e) => {
            let _ = remove_tree(&store, &staging);
            return Err(e);
        }
    };
    // Committed: collection may now remove what the door no longer reaches.
    // Only after a durable commit: on a warning nothing more is touched.
    let warning = match warning {
        Some(w) => Some(w),
        None => collect(&store, &mut m, keep_ms, t),
    };
    drop(held);
    Ok(Published { rev, files: budget.files, bytes: budget.bytes, warning })
}

/// Take the page down (R6): no revision is current; the one that was is
/// retired like a replaced one. `Ok(None)` when there was no page.
pub fn unpublish(ws: &Path, keep_ms: u64, now: &dyn Fn() -> u64) -> Result<Option<(u64, Option<String>)>, String> {
    let (_, root) = root_of(ws)?;
    let Some(store) = store_of(&root, false)? else { return Ok(None) };
    let _held = lock(&store)?;
    let mut m = read_manifest(&store)?;
    let Some(was) = m.current else { return Ok(None) };
    let t = now();
    retire(&mut m, t);
    m.current = None;
    let warning = match write_manifest(&store, &m)? {
        Some(w) => Some(w),
        None => collect(&store, &mut m, keep_ms, t),
    };
    Ok(Some((was, warning)))
}

fn retire(m: &mut Manifest, t: u64) {
    if let Some(cur) = m.current {
        if let Some(r) = m.revisions.iter_mut().find(|r| r.rev == cur) {
            r.retired_ms.get_or_insert(t);
        }
    }
}

/// Inside the lock, AFTER a synced commit (F1): every revision retired at
/// least `keep_ms` ago goes, however many publications came between; the
/// current one never. The shortened manifest is COMMITTED FIRST and only then
/// are the folders removed, so nothing page.json still lists is ever deleted
/// (leader note 23, B). A failure of that rewrite, or its folder sync, is the
/// publication's durability warning, never its failure. An UNLISTED revision
/// or staging folder (a crash between the rename and the write, a
/// publication that died mid-copy, a removal that failed) goes once it is
/// older than `keep_ms` by its own mtime, so nothing a live document could
/// still read is removed, and nothing is left forever.
fn collect(store: &Dir, m: &mut Manifest, keep_ms: u64, t: u64) -> Option<String> {
    let current = m.current;
    let expired: Vec<u64> = m.revisions.iter()
        .filter(|r| Some(r.rev) != current && r.retired_ms.is_some_and(|at| at.saturating_add(keep_ms) <= t))
        .map(|r| r.rev).collect();
    let mut warning = None;
    if !expired.is_empty() {
        let kept = Manifest { current, next: m.next, revisions: m.revisions.iter().filter(|r| !expired.contains(&r.rev)).cloned().collect() };
        match write_manifest(store, &kept) {
            Err(e) => return Some(format!("the page is published; old revisions were not collected: {e}")),
            Ok(w) => {
                warning = w;
                *m = kept;
                for rev in &expired {
                    let _ = remove_tree(store, &rev.to_string());
                }
            }
        }
    }
    let listed: Vec<String> = m.revisions.iter().map(|r| r.rev.to_string()).collect();
    for name in store.names().unwrap_or_default() {
        let numbered = !name.is_empty() && name.bytes().all(|c| c.is_ascii_digit());
        if !(numbered || name.starts_with(STAGING)) || listed.contains(&name) {
            continue;
        }
        let Ok(Some(st)) = store.stat_at(&name) else { continue };
        let mtime_ms = (st.st_mtime as u64).saturating_mul(1000);
        if safe_fs::is_dir(&st) && mtime_ms.saturating_add(keep_ms) <= t {
            let _ = remove_tree(store, &name);
        }
    }
    warning
}

/// `tmm dashboard`'s printed lines: no I/O here.
pub mod cli {
    use serde_json::Value;

    pub fn published_line(r: &Value, project: &str) -> String {
        let bytes = r["bytes"].as_u64().unwrap_or(0);
        let size = if bytes >= 1024 * 1024 { format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0)) } else { format!("{} KiB", bytes.div_ceil(1024)) };
        format!("✓ published revision {} of {project}'s page ({} files, {size})", r["rev"], r["files"])
    }

    /// The durability warning of a publication that happened (#111 note 18), for stderr.
    pub fn warning_line(r: &Value) -> Option<String> {
        r["warning"].as_str().map(|w| format!("warning: {w}"))
    }

    pub fn unpublished_line(r: &Value, project: &str) -> String {
        match r["rev"].as_u64() {
            Some(rev) => format!("✓ took {project}'s page down (revision {rev}); the Dashboard shows no page"),
            None => format!("{project} has no page published; nothing changed"),
        }
    }
}

#[cfg(test)]
#[path = "page_tests.rs"]
mod tests;
