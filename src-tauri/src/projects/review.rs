//! Review annotations on a project's files (board #434): the store, the
//! cross-process lock and the containment that binds every object opened.
//!
//! Design CLEAR at delta 3 (pages/files-review.md has the full rules):
//!
//! - **The store** is `<project root>/.tmm/reviews/<sha256(relpath)>.json` =
//!   `{schema: 1, path: <relpath>, annotations: [...]}`. The hash is only a
//!   filename: a loaded store whose `schema` or `path` does not match is an
//!   error, never adopted. Unreadable or unparseable JSON is an error too,
//!   never `[]` followed by an overwrite.
//! - **One read-modify-write protocol** (`with_store`), for the gateway and
//!   any other process on the same workspace: `flock` on a stable sidecar
//!   `<key>.json.lock` (created once, never replaced, so the lock binds a
//!   stable inode), read, mutate, write an exclusive temp file, fsync,
//!   `renameat` over the store, fsync the directory, unlock.
//! - **Containment at the OBJECT** (`Root::open`, `Root::open_source`,
//!   `Root::reviews`): the project root is canonicalized once, its
//!   `(dev, ino)` recorded, opened `O_DIRECTORY | O_NOFOLLOW` and checked by
//!   `fstat` and by the fd's own path; everything below is opened RELATIVE to
//!   a verified directory handle with `O_NOFOLLOW`, regular files are checked
//!   by `fstat`, the temp file is created `O_EXCL`. A path is never resolved
//!   again after its handle was proved; an identity or path mismatch refuses,
//!   it never retries by path.
#![cfg(not(any(target_os = "android", target_os = "ios")))]

use serde::{Deserialize, Serialize};
use std::ffi::CString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

/// The store's schema version; a store with any other is refused.
pub const SCHEMA: u32 = 1;

/// One annotation. Positions are in the LINE model (`lines`): 1-based line,
/// 1-based column counted in Unicode scalar values, end exclusive.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
    /// The selected source text, LINE form (`\r\n` → `\n`).
    pub quote: String,
    /// Up to `CONTEXT` scalars of LINE text before and after the quote.
    pub pre: String,
    pub suf: String,
    pub note: String,
    /// `open` or `resolved`.
    pub status: String,
    /// The source revision (sha256 of the file's bytes) the range belongs to.
    pub revision: String,
    pub created: u64,
    pub updated: u64,
    pub by: String,
}

/// One file's review store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewFile {
    pub schema: u32,
    pub path: String,
    pub annotations: Vec<Annotation>,
}

impl ReviewFile {
    fn empty(rel: &str) -> Self {
        ReviewFile { schema: SCHEMA, path: rel.to_string(), annotations: Vec::new() }
    }
}

/// The store key of a relpath: a filename, nothing more.
pub fn store_key(rel: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(rel.as_bytes()))
}

/// The source revision: sha256 hex of the file's bytes.
pub fn revision(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| format!("a NUL in the name {s:?}"))
}

fn errno() -> std::io::Error {
    std::io::Error::last_os_error()
}

fn fstat(fd: &OwnedFd) -> Result<libc::stat, String> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 {
        return Err(format!("fstat: {}", errno()));
    }
    Ok(st)
}

fn is_dir(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFDIR
}

fn is_reg(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFREG
}

/// `openat(dir, name, flags)` — `name` is ONE component, never a path.
fn openat(dir: &OwnedFd, name: &str, flags: libc::c_int, mode: libc::mode_t) -> std::io::Result<OwnedFd> {
    let c = CString::new(name).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), flags | libc::O_CLOEXEC, mode as libc::c_uint) };
    if fd < 0 {
        return Err(errno());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// The path an open fd names right now, from the kernel.
fn fd_path(fd: &OwnedFd) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd())).map_err(|e| format!("the root's own path: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETPATH, buf.as_mut_ptr()) } == -1 {
            return Err(format!("the root's own path: {}", errno()));
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        use std::os::unix::ffi::OsStrExt;
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..end])))
    }
}

/// A project root proved to be the directory its canonical path names
/// (delta 3 P1-B): everything a review touches is opened relative to it.
pub struct Root {
    fd: OwnedFd,
    canonical: PathBuf,
}

// Test seams: each runs once at its point (the root's identity read and its
// open; the source walk; the reviews directory open), so a test can swap an
// object there (delta 3).
#[cfg(test)]
thread_local! {
    pub(crate) static BEFORE_ROOT_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
    pub(crate) static BEFORE_SOURCE_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
    pub(crate) static BEFORE_REVIEWS_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

fn seam(_which: &'static std::thread::LocalKey<std::cell::RefCell<Option<Box<dyn FnOnce()>>>>) {
    #[cfg(test)]
    if let Some(f) = _which.with(|h| h.borrow_mut().take()) {
        f();
    }
}

#[cfg(not(test))]
thread_local! {
    static BEFORE_ROOT_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static BEFORE_SOURCE_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    static BEFORE_REVIEWS_OPEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}

impl Root {
    /// Open a project's declared root: canonicalize ONCE, read its
    /// `(dev, ino)`, open the canonical path `O_DIRECTORY | O_NOFOLLOW`, and
    /// require the same identity by `fstat` AND the fd's own path equal to
    /// the canonical root. A root replaced in between — by a symlink, a
    /// symlinked parent, or another real directory — is refused.
    pub fn open(declared: &str) -> Result<Root, String> {
        let canonical = std::fs::canonicalize(declared).map_err(|e| format!("the project root {declared}: {e}"))?;
        let seen = std::fs::metadata(&canonical).map_err(|e| format!("the project root: {e}"))?;
        use std::os::unix::fs::MetadataExt;
        let (dev, ino) = (seen.dev(), seen.ino());
        seam(&BEFORE_ROOT_OPEN);
        let c = cstr(&canonical.to_string_lossy())?;
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(format!("the project root changed while it was opened ({})", errno()));
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let st = fstat(&fd)?;
        if st.st_dev as u64 != dev || st.st_ino as u64 != ino {
            return Err("the project root changed while it was opened (another directory)".into());
        }
        if fd_path(&fd)? != canonical {
            return Err("the project root changed while it was opened (its path)".into());
        }
        Ok(Root { fd, canonical })
    }

    pub fn canonical(&self) -> &Path {
        &self.canonical
    }

    /// The canonical path of `abs` relative to this root, refused when it is
    /// outside. Resolved once, here: a symlink inside the root is followed by
    /// `canonicalize` and its target must still be inside.
    pub fn relpath(&self, abs: &str) -> Result<String, String> {
        let canon = std::fs::canonicalize(abs).map_err(|e| format!("{abs}: {e}"))?;
        let rel = canon.strip_prefix(&self.canonical).map_err(|_| format!("{abs} is outside the project"))?;
        let rel = rel.to_string_lossy().to_string();
        if rel.is_empty() {
            return Err(format!("{abs} is the project root, not a file"));
        }
        Ok(rel)
    }

    /// Open `rel` (a canonical relpath from `relpath`) component by component
    /// from the root handle, `O_NOFOLLOW` on every step: a component swapped
    /// for a symlink after `relpath` resolved it fails, never follows. The
    /// final object must be a regular file. Returns its whole content, read
    /// from that one fd.
    pub fn read_source(&self, rel: &str) -> Result<Vec<u8>, String> {
        let parts: Vec<String> = Path::new(rel)
            .components()
            .map(|c| match c {
                Component::Normal(s) => Ok(s.to_string_lossy().to_string()),
                _ => Err(format!("{rel} is not a plain relative path")),
            })
            .collect::<Result<_, _>>()?;
        let (file, dirs) = parts.split_last().ok_or_else(|| format!("{rel} names nothing"))?;
        seam(&BEFORE_SOURCE_OPEN);
        let mut dir = self.fd.try_clone().map_err(|e| format!("dup root: {e}"))?;
        for d in dirs {
            dir = openat(&dir, d, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW, 0)
                .map_err(|e| format!("{rel}: {d} ({e})"))?;
        }
        let fd = openat(&dir, file, libc::O_RDONLY | libc::O_NOFOLLOW, 0).map_err(|e| format!("{rel}: {e}"))?;
        if !is_reg(&fstat(&fd)?) {
            return Err(format!("{rel} is not a regular file"));
        }
        use std::io::Read;
        let mut f = std::fs::File::from(fd);
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).map_err(|e| format!("read {rel}: {e}"))?;
        Ok(bytes)
    }

    /// `<root>/.tmm/reviews` as a verified directory handle: each level opened
    /// `O_DIRECTORY | O_NOFOLLOW` (made with `mkdirat` when absent and
    /// `create`), so a symlink at either level is refused.
    fn reviews(&self, create: bool) -> Result<Option<OwnedFd>, String> {
        seam(&BEFORE_REVIEWS_OPEN);
        let mut dir = self.fd.try_clone().map_err(|e| format!("dup root: {e}"))?;
        for name in [".tmm", "reviews"] {
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW;
            dir = match openat(&dir, name, flags, 0) {
                Ok(fd) => fd,
                Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {
                    if !create {
                        return Ok(None);
                    }
                    let c = cstr(name)?;
                    if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o755) } != 0 && errno().raw_os_error() != Some(libc::EEXIST) {
                        return Err(format!("mkdir {name}: {}", errno()));
                    }
                    openat(&dir, name, flags, 0).map_err(|e| format!("{name}: {e}"))?
                }
                Err(e) => return Err(format!("{name} is not a directory of this project ({e})")),
            };
            if !is_dir(&fstat(&dir)?) {
                return Err(format!("{name} is not a directory"));
            }
        }
        Ok(Some(dir))
    }
}

/// Lock mode of one store access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

// Test seam: runs once between the store read and the temp write, inside
// the lock — where a concurrent writer would land without it.
#[cfg(test)]
thread_local! {
    pub(crate) static INSIDE_LOCK: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

/// The ONE door to a file's review store. An absent store is empty; a store
/// that cannot be read or parsed, or whose schema or path does not match, is
/// an error and nothing is written.
///
/// `Read` is truly read-only: it opens nothing for writing, creates nothing
/// (no directory, no lock sidecar) and takes no lock, so it works in a
/// read-only `reviews` directory. It needs none: a writer replaces the store
/// by `renameat`, so a reader's one open sees one whole version, the one
/// before a concurrent write or the one after it.
///
/// `Write` creates the stable `<key>.json.lock` sidecar once, takes
/// `LOCK_EX` on it for the whole read-modify-write, and writes the changed
/// store atomically when `f` returns `Ok(true)`.
pub fn with_store<T>(root: &Root, rel: &str, access: Access, f: impl FnOnce(&mut ReviewFile) -> Result<(T, bool), String>) -> Result<T, String> {
    let key = store_key(rel);
    let Some(dir) = root.reviews(access == Access::Write)? else {
        let mut file = ReviewFile::empty(rel);
        return f(&mut file).map(|(v, _)| v);
    };
    if access == Access::Read {
        let mut file = read_store(&dir, &key, rel)?;
        return f(&mut file).map(|(v, _)| v);
    }
    let lock = openat(&dir, &format!("{key}.json.lock"), libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW, 0o600)
        .map_err(|e| format!("the review lock: {e}"))?;
    if !is_reg(&fstat(&lock)?) {
        return Err("the review lock is not a regular file".into());
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(format!("lock the review store: {}", errno()));
    }
    // Held until `lock` drops at the end of this function (close releases).
    let mut file = read_store(&dir, &key, rel)?;
    let (value, changed) = f(&mut file)?;
    if changed {
        #[cfg(test)]
        if let Some(h) = INSIDE_LOCK.with(|h| h.borrow_mut().take()) {
            h();
        }
        write_store(&dir, &key, &file)?;
    }
    drop(lock);
    Ok(value)
}

fn read_store(dir: &OwnedFd, key: &str, rel: &str) -> Result<ReviewFile, String> {
    let fd = match openat(dir, &format!("{key}.json"), libc::O_RDONLY | libc::O_NOFOLLOW, 0) {
        Ok(fd) => fd,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => return Ok(ReviewFile::empty(rel)),
        Err(e) => return Err(format!("the review store: {e}")),
    };
    if !is_reg(&fstat(&fd)?) {
        return Err("the review store is not a regular file".into());
    }
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::from(fd).read_to_string(&mut text).map_err(|e| format!("read the review store: {e}"))?;
    let file: ReviewFile = serde_json::from_str(&text).map_err(|e| format!("the review store is not valid ({e})"))?;
    if file.schema != SCHEMA {
        return Err(format!("the review store has schema {}, not {SCHEMA}", file.schema));
    }
    if file.path != rel {
        return Err(format!("the review store is for {:?}, not {rel:?}", file.path));
    }
    Ok(file)
}

fn write_store(dir: &OwnedFd, key: &str, file: &ReviewFile) -> Result<(), String> {
    let body = serde_json::to_string_pretty(file).map_err(|e| format!("encode the review store: {e}"))?;
    let tmp = format!("{key}.json.tmp.{}.{}", std::process::id(), uuid::Uuid::new_v4().simple());
    let fd = openat(dir, &tmp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW, 0o644)
        .map_err(|e| format!("the review temp file: {e}"))?;
    let written = (|| {
        use std::io::Write;
        let mut f = std::fs::File::from(fd);
        f.write_all(body.as_bytes()).map_err(|e| format!("write the review store: {e}"))?;
        f.sync_all().map_err(|e| format!("sync the review store: {e}"))?;
        let (from, to) = (cstr(&tmp)?, cstr(&format!("{key}.json"))?);
        if unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) } != 0 {
            return Err(format!("replace the review store: {}", errno()));
        }
        if unsafe { libc::fsync(dir.as_raw_fd()) } != 0 {
            return Err(format!("sync the reviews directory: {}", errno()));
        }
        Ok(())
    })();
    if written.is_err() {
        if let Ok(c) = cstr(&tmp) {
            unsafe { libc::unlinkat(dir.as_raw_fd(), c.as_ptr(), 0) };
        }
    }
    written
}

// ---- the LINE model, anchors and relocation (delta 1-3) ------------------

/// Context kept on each side of a quote, in scalars.
pub const CONTEXT: usize = 32;
/// How much of a selection the feedback block quotes, in scalars.
pub const QUOTE_CUT: usize = 60;

/// A file's text in the LINE model (delta 2, P1-A(1)): `\r\n` and `\n` both
/// end a line and are normalized to `\n`, once; a lone `\r` is an ordinary
/// character; nothing else is normalized. Quotes, context, relocation and
/// the feedback block's "in" line all read THIS text, while the revision
/// stays the hash of the raw bytes. A file that is not UTF-8 is not text and
/// cannot be reviewed.
pub struct Model {
    chars: Vec<char>,
    /// Char offset where each line starts (line 1 at index 0).
    starts: Vec<usize>,
}

impl Model {
    pub fn from_bytes(bytes: &[u8]) -> Result<Model, String> {
        let text = std::str::from_utf8(bytes).map_err(|_| "this file is not UTF-8 text, so it cannot be reviewed".to_string())?;
        Ok(Model::from_text(text))
    }

    pub fn from_text(text: &str) -> Model {
        let mut chars = Vec::with_capacity(text.len());
        let mut starts = vec![0];
        let mut it = text.chars().peekable();
        while let Some(c) = it.next() {
            if c == '\r' && it.peek() == Some(&'\n') {
                continue; // the CR of a CRLF: the LF below ends the line
            }
            chars.push(c);
            if c == '\n' {
                starts.push(chars.len());
            }
        }
        Model { chars, starts }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn line_count(&self) -> usize {
        self.starts.len()
    }

    /// Scalars on `line` (1-based), its terminator excluded.
    pub fn line_len(&self, line: usize) -> Option<usize> {
        let start = *self.starts.get(line.checked_sub(1)?)?;
        let end = self.starts.get(line).map(|n| n - 1).unwrap_or(self.chars.len());
        Some(end - start)
    }

    /// The model offset of `(line, col)`, both 1-based; `col` may be one
    /// past the line's last scalar (an exclusive end at the line's end).
    pub fn offset(&self, line: u32, col: u32) -> Option<usize> {
        let (l, c) = (line as usize, col as usize);
        let len = self.line_len(l)?;
        (c >= 1 && c <= len + 1).then(|| self.starts[l - 1] + c - 1)
    }

    /// `(line, col)` of a model offset.
    pub fn position(&self, off: usize) -> (u32, u32) {
        let l = self.starts.partition_point(|s| *s <= off);
        (l as u32, (off - self.starts[l - 1] + 1) as u32)
    }

    pub fn slice(&self, a: usize, b: usize) -> String {
        self.chars[a.min(self.chars.len())..b.min(self.chars.len())].iter().collect()
    }

    /// Lines `a..=b` (1-based), terminators excluded, joined by `\n`.
    pub fn lines_text(&self, a: u32, b: u32) -> String {
        let start = self.starts.get((a as usize).saturating_sub(1)).copied().unwrap_or(0);
        let end = self.starts.get(b as usize).map(|n| n - 1).unwrap_or(self.chars.len());
        self.slice(start, end.max(start))
    }
}

/// A range in wire coordinates (end exclusive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub line: u32,
    pub col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

impl Range {
    fn offsets(&self, m: &Model) -> Option<(usize, usize)> {
        let (a, b) = (m.offset(self.line, self.col)?, m.offset(self.end_line, self.end_col)?);
        (a < b).then_some((a, b))
    }

    fn of(m: &Model, a: usize, b: usize) -> Range {
        let ((line, col), (end_line, end_col)) = (m.position(a), m.position(b));
        Range { line, col, end_line, end_col }
    }
}

/// The quote at `r` and its context, refused when out of bounds, empty, or
/// whitespace only (delta 1).
pub fn take(m: &Model, r: &Range) -> Result<(String, String, String), String> {
    let (a, b) = r.offsets(m).ok_or("the selection is outside the file")?;
    let quote = m.slice(a, b);
    if quote.trim().is_empty() {
        return Err("a selection of only whitespace cannot be commented on".into());
    }
    Ok((quote, m.slice(a.saturating_sub(CONTEXT), a), m.slice(b, b + CONTEXT)))
}

/// Where an annotation is in the current text (delta 1): `located` with a
/// range, `missing`, or `ambiguous` — never a guessed position.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Located {
    Located(Range),
    Missing,
    Ambiguous,
}

impl Located {
    pub fn json(&self) -> serde_json::Value {
        match self {
            Located::Located(r) => serde_json::json!({ "state": "located", "range": r }),
            Located::Missing => serde_json::json!({ "state": "missing" }),
            Located::Ambiguous => serde_json::json!({ "state": "ambiguous" }),
        }
    }
}

/// Relocate `a` in the current text. The stored range is used only when the
/// revision is the stored one AND the text at it is the stored quote (a
/// store on disk is not trusted). Otherwise every exact occurrence of the
/// quote is a candidate, scored by the agreeing run of `pre` before it and
/// `suf` after it, counted in NON-whitespace scalars.
///
/// When the stored context holds any non-whitespace scalar, it is evidence,
/// and a candidate that scores zero against it is another copy, not the
/// commented text: none left is `missing`. When it is empty or only
/// whitespace there is no evidence either way, and every exact occurrence
/// stays a candidate. A unique best is `located`; a tie (identical context
/// included) is `ambiguous`. A heuristic that refuses rather than guesses,
/// not a proof of identity.
pub fn locate(m: &Model, current: &str, a: &Annotation) -> Located {
    let stored = Range { line: a.line, col: a.col, end_line: a.end_line, end_col: a.end_col };
    if a.revision == current {
        if let Some((x, y)) = stored.offsets(m) {
            if m.slice(x, y) == a.quote {
                return Located::Located(stored);
            }
        }
    }
    let q: Vec<char> = a.quote.chars().collect();
    if q.is_empty() || q.len() > m.chars.len() {
        return Located::Missing;
    }
    let hits: Vec<usize> = (0..=m.chars.len() - q.len()).filter(|&i| m.chars[i..i + q.len()] == q[..]).collect();
    if hits.is_empty() {
        return Located::Missing;
    }
    let pre: Vec<char> = a.pre.chars().collect();
    let suf: Vec<char> = a.suf.chars().collect();
    // The agreeing run on each side, counted in NON-whitespace scalars:
    // whitespace must agree for the run to go on, but the blank line every
    // paragraph has around it is not evidence of which copy this is.
    let score = |i: usize| -> usize {
        let before = pre.iter().rev().zip(m.chars[..i].iter().rev()).take_while(|(x, y)| x == y).filter(|(x, _)| !x.is_whitespace()).count();
        let after = suf.iter().zip(m.chars[i + q.len()..].iter()).take_while(|(x, y)| x == y).filter(|(x, _)| !x.is_whitespace()).count();
        before + after
    };
    // A candidate must agree with SOME of the stored context. A lone exact
    // occurrence whose surroundings match nothing is another copy of the
    // text, not the commented one moved (validator on 5b2a004f: two identical
    // paragraphs, the first edited, its comment silently landed on the
    // second). With no non-whitespace context (a comment on a whole short
    // file) there is nothing to disagree with.
    // Whitespace-only context is no evidence (reviewer on 93c1b929): a
    // one-line `hello\n` file converted to CRLF keeps its comment.
    let context = pre.iter().chain(suf.iter()).any(|c| !c.is_whitespace());
    let scored: Vec<(usize, usize)> = hits.iter().map(|&i| (score(i), i)).filter(|(s, _)| !context || *s > 0).collect();
    let Some(best) = scored.iter().map(|(s, _)| *s).max() else {
        return Located::Missing;
    };
    let top: Vec<usize> = scored.iter().filter(|(s, _)| *s == best).map(|(_, i)| *i).collect();
    if top.len() == 1 { Located::Located(Range::of(m, top[0], top[0] + q.len())) } else { Located::Ambiguous }
}

/// The ONE feedback formatter (delta 1, P1-D), the portal 批注 shape:
///
/// ```text
/// [Document feedback on <abs path> — N comments]
/// 1. (line L, col C, "<selection…>" in "<source line>"): "<comment>"
/// 2. (lines A–B, col C, "<selection…>" in "<source lines>"): "<comment>"
/// 3. ("<selection…>"): "<comment>"        ← missing or ambiguous
/// ```
///
/// Only open comments with a note. Every user-sourced field — the path, the
/// selection, the source line, the note — goes through
/// `address::unaddressed` (`@` → `＠`), so the block can never widen who a
/// message reaches. Whitespace runs that hold a newline become one space.
pub fn feedback(abs: &str, m: &Model, current: &str, annotations: &[Annotation]) -> (String, usize) {
    let open: Vec<&Annotation> = annotations.iter().filter(|a| a.status == "open" && !a.note.trim().is_empty()).collect();
    let safe = |t: &str| crate::address::unaddressed(&one_line(t));
    let cut = |t: &str| {
        let t = one_line(t);
        let short: String = t.chars().take(QUOTE_CUT).collect();
        crate::address::unaddressed(&if t.chars().count() > QUOTE_CUT { format!("{short}…") } else { t })
    };
    let n = open.len();
    let mut out = vec![format!("[Document feedback on {} — {n} comment{}]", crate::address::unaddressed(abs), if n == 1 { "" } else { "s" })];
    for (k, a) in open.iter().enumerate() {
        let sel = cut(&a.quote);
        let note = safe(&a.note);
        match locate(m, current, a) {
            Located::Located(r) => {
                let where_ = if r.line == r.end_line { format!("line {}, col {}", r.line, r.col) } else { format!("lines {}–{}, col {}", r.line, r.end_line, r.col) };
                out.push(format!("{}. ({where_}, \"{sel}\" in \"{}\"): \"{note}\"", k + 1, safe(&m.lines_text(r.line, r.end_line))));
            }
            Located::Missing | Located::Ambiguous => out.push(format!("{}. (\"{sel}\"): \"{note}\"", k + 1)),
        }
    }
    (out.join("\n"), n)
}

/// Runs of whitespace that contain a newline become one space; the result
/// is trimmed.
fn one_line(t: &str) -> String {
    let mut out = String::new();
    let mut pending: Option<bool> = None; // Some(saw_newline) inside a whitespace run
    for c in t.chars() {
        if c.is_whitespace() {
            let nl = c == '\n' || c == '\r';
            pending = Some(pending.unwrap_or(false) || nl);
            continue;
        }
        if let Some(nl) = pending.take() {
            out.push(' ');
            let _ = nl;
        }
        out.push(c);
    }
    out.trim().to_string()
}

// ---- the RPCs (`review_*`, desktop project dispatch) ----------------------

/// A review request's target, resolved by the server alone: the project by
/// its stable `project_id` (or, for `tmm`, the caller's `session`), its
/// verified root, and the canonical relpath of the absolute `path`.
pub struct Target {
    pub project_id: String,
    pub abs: String,
    pub rel: String,
    pub root: Root,
}

pub fn target(p: &serde_json::Value) -> Result<Target, String> {
    let s = |k: &str| p.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty());
    let project = match (s("project_id"), s("session")) {
        (Some(id), _) => super::with_store(|st| st.project(id))?.ok_or_else(|| format!("no project with id {id}"))?,
        (None, Some(session)) => super::project_for_session(session)?.ok_or_else(|| format!("no project for session {session}"))?,
        (None, None) => return Err("a review needs project_id (or session) and path".into()),
    };
    let path = s("path").ok_or("a review needs an absolute path")?;
    if !Path::new(path).is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }
    let root = Root::open(&project.path)?;
    let rel = root.relpath(path)?;
    let abs = root.canonical().join(&rel).to_string_lossy().to_string();
    Ok(Target { project_id: project.id, abs, rel, root })
}

fn now() -> u64 {
    super::now()
}

/// `review_list`: the CURRENT revision and every annotation with where it is
/// in the current text. The client paints highlights only when this
/// revision is the one of the content it rendered.
pub fn list(p: &serde_json::Value) -> Result<serde_json::Value, String> {
    let t = target(p)?;
    let bytes = t.root.read_source(&t.rel)?;
    let current = revision(&bytes);
    let m = Model::from_bytes(&bytes)?;
    with_store(&t.root, &t.rel, Access::Read, |f| {
        let rows: Vec<serde_json::Value> = f
            .annotations
            .iter()
            .map(|a| {
                let mut v = serde_json::to_value(a).unwrap_or_default();
                v["at"] = locate(&m, &current, a).json();
                v
            })
            .collect();
        Ok((serde_json::json!({ "project_id": t.project_id, "path": t.abs, "revision": current, "annotations": rows }), false))
    })
}

/// `review_add`: under the store's lock, the source is read ONCE; a stated
/// `revision` that is not that read's is refused as `{stale, revision}` (the
/// client keeps its draft); the quote and its context are cut from that same
/// read. `revision` absent (`tmm review add`) means the file as it is now.
pub fn add(p: &serde_json::Value) -> Result<serde_json::Value, String> {
    let t = target(p)?;
    let lines = Lines::from_params(p)?;
    let range: Option<Range> = match (p.get("range"), &lines) {
        (Some(r), None) => Some(serde_json::from_value(r.clone()).map_err(|e| format!("range: {e}"))?),
        (None, Some(_)) => None,
        _ => return Err("review_add takes a range, or lines (and cols)".into()),
    };
    let note = p.get("note").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let by = p.get("by").and_then(|v| v.as_str()).filter(|v| !v.is_empty()).unwrap_or("human").to_string();
    let stated = p.get("revision").and_then(|v| v.as_str()).map(str::to_string);
    with_store(&t.root, &t.rel, Access::Write, |f| {
        let bytes = t.root.read_source(&t.rel)?;
        let current = revision(&bytes);
        if stated.as_deref().is_some_and(|r| r != current) {
            return Ok((serde_json::json!({ "stale": true, "revision": current }), false));
        }
        let m = Model::from_bytes(&bytes)?;
        // `lines` (tmm review add) is expanded HERE, in the one read the
        // quote is cut from: the client never measures the file (#434 P1-D).
        let range = match (range, &lines) {
            (Some(r), _) => r,
            (None, Some(l)) => l.range(&m)?,
            (None, None) => unreachable!(),
        };
        let (quote, pre, suf) = take(&m, &range)?;
        let at = now();
        let a = Annotation {
            id: uuid::Uuid::new_v4().simple().to_string()[..12].to_string(),
            line: range.line, col: range.col, end_line: range.end_line, end_col: range.end_col,
            quote, pre, suf, note, status: "open".into(), revision: current, created: at, updated: at, by,
        };
        let v = serde_json::to_value(&a).unwrap_or_default();
        f.annotations.push(a);
        Ok((v, true))
    })
}

/// `tmm review add`'s selection by line (board #434 P1-D): `lines: [A, B]`
/// and optionally `cols: [C, D]`, INCLUSIVE columns (C on line A, D on line
/// B). Without `cols` it is the whole lines, measured by the server in the
/// same read the quote is cut from.
struct Lines {
    line: u32,
    end_line: u32,
    cols: Option<(u32, u32)>,
}

impl Lines {
    fn from_params(p: &serde_json::Value) -> Result<Option<Lines>, String> {
        let pair = |k: &str| -> Result<Option<(u32, u32)>, String> {
            let Some(v) = p.get(k) else { return Ok(None) };
            let a = v.as_array().filter(|a| a.len() == 2).ok_or_else(|| format!("{k} must be [first, last]"))?;
            let n = |x: &serde_json::Value| x.as_u64().filter(|n| *n > 0 && *n <= u32::MAX as u64).map(|n| n as u32).ok_or_else(|| format!("{k}: numbers from 1"));
            Ok(Some((n(&a[0])?, n(&a[1])?)))
        };
        let Some((line, end_line)) = pair("lines")? else {
            return if p.get("cols").is_some() { Err("cols needs lines".into()) } else { Ok(None) };
        };
        if end_line < line {
            return Err(format!("lines {line}-{end_line}: the end is before the start"));
        }
        let cols = pair("cols")?;
        if let Some((c, d)) = cols {
            if end_line == line && d < c {
                return Err(format!("cols {c}-{d}: the end is before the start"));
            }
        }
        Ok(Some(Lines { line, end_line, cols }))
    }

    fn range(&self, m: &Model) -> Result<Range, String> {
        let len = m.line_len(self.end_line as usize).ok_or_else(|| format!("line {}: the file has {} lines", self.end_line, m.line_count()))?;
        let (col, end_col) = match self.cols {
            Some((c, d)) => (c, d + 1),
            None => (1, len as u32 + 1),
        };
        Ok(Range { line: self.line, col, end_line: self.end_line, end_col })
    }
}

/// `review_update`: a note and/or a status (`open` | `resolved`) for one id.
/// The later write wins, field by field as sent.
pub fn update(p: &serde_json::Value) -> Result<serde_json::Value, String> {
    let t = target(p)?;
    let id = p.get("id").and_then(|v| v.as_str()).ok_or("review_update needs an id")?.to_string();
    let note = p.get("note").and_then(|v| v.as_str()).map(str::to_string);
    let status = p.get("status").and_then(|v| v.as_str()).map(str::to_string);
    if let Some(s) = &status {
        if s != "open" && s != "resolved" {
            return Err(format!("status must be open or resolved, not {s}"));
        }
    }
    with_store(&t.root, &t.rel, Access::Write, |f| {
        let a = f.annotations.iter_mut().find(|a| a.id == id).ok_or_else(|| format!("no annotation {id}"))?;
        if let Some(n) = note {
            a.note = n;
        }
        if let Some(s) = status {
            a.status = s;
        }
        a.updated = now();
        Ok((serde_json::to_value(&*a).unwrap_or_default(), true))
    })
}

/// `review_delete`: one id.
pub fn delete(p: &serde_json::Value) -> Result<serde_json::Value, String> {
    let t = target(p)?;
    let id = p.get("id").and_then(|v| v.as_str()).ok_or("review_delete needs an id")?.to_string();
    with_store(&t.root, &t.rel, Access::Write, |f| {
        let before = f.annotations.len();
        f.annotations.retain(|a| a.id != id);
        if f.annotations.len() == before {
            return Err(format!("no annotation {id}"));
        }
        Ok((serde_json::json!({ "ok": true }), true))
    })
}

/// `review_feedback`: the feedback block for the file's open comments.
pub fn feedback_rpc(p: &serde_json::Value) -> Result<serde_json::Value, String> {
    let t = target(p)?;
    let bytes = t.root.read_source(&t.rel)?;
    let current = revision(&bytes);
    let m = Model::from_bytes(&bytes)?;
    with_store(&t.root, &t.rel, Access::Read, |f| {
        let (text, count) = feedback(&t.abs, &m, &current, &f.annotations);
        Ok((serde_json::json!({ "project_id": t.project_id, "path": t.abs, "revision": current, "text": text, "count": count }), false))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("tmm-review-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn add(root: &Root, rel: &str, id: &str) -> Result<(), String> {
        with_store(root, rel, Access::Write, |f| {
            f.annotations.push(Annotation {
                id: id.into(), line: 1, col: 1, end_line: 1, end_col: 3, quote: "fn".into(), pre: String::new(), suf: " main".into(),
                note: "n".into(), status: "open".into(), revision: "r".into(), created: 1, updated: 1, by: "human".into(),
            });
            Ok(((), true))
        })
    }

    fn ids(root: &Root, rel: &str) -> Vec<String> {
        with_store(root, rel, Access::Read, |f| Ok((f.annotations.iter().map(|a| a.id.clone()).collect(), false))).unwrap()
    }

    #[test]
    fn a_store_round_trips_and_a_read_of_nothing_creates_nothing() {
        let d = scratch();
        let root = Root::open(d.to_str().unwrap()).unwrap();
        let rel = root.relpath(d.join("src/main.rs").to_str().unwrap()).unwrap();
        assert_eq!(rel, "src/main.rs");
        assert!(ids(&root, &rel).is_empty());
        assert!(!d.join(".tmm").exists(), "a read creates nothing");
        add(&root, &rel, "a1").unwrap();
        add(&root, &rel, "a2").unwrap();
        assert_eq!(ids(&root, &rel), ["a1", "a2"]);
        let on_disk: ReviewFile = serde_json::from_str(&std::fs::read_to_string(d.join(".tmm/reviews").join(format!("{}.json", store_key(&rel)))).unwrap()).unwrap();
        assert_eq!((on_disk.schema, on_disk.path.as_str(), on_disk.annotations.len()), (SCHEMA, "src/main.rs", 2));
        let left: Vec<String> = std::fs::read_dir(d.join(".tmm/reviews")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(left.iter().all(|n| !n.contains(".tmp.")), "no temp file left: {left:?}");
        assert_eq!(root.read_source(&rel).unwrap(), b"fn main() {}\n");
    }

    /// Reviewer P2 on 5b2a004f: a Read is truly read-only. With A's store
    /// (and its lock) on disk, reading B creates no B lock, and in a
    /// read-only `reviews` directory A and B both still read.
    #[test]
    fn a_read_creates_no_lock_and_works_in_a_read_only_reviews_dir() {
        use std::os::unix::fs::PermissionsExt;
        let d = scratch();
        std::fs::write(d.join("src/b.rs"), "b\n").unwrap();
        let root = Root::open(&d.to_string_lossy()).unwrap();
        add(&root, "src/main.rs", "a1").unwrap();
        let reviews = d.join(".tmm/reviews");
        let before: Vec<_> = std::fs::read_dir(&reviews).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert!(ids(&root, "src/b.rs").is_empty());
        let after: Vec<_> = std::fs::read_dir(&reviews).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(before, after, "reading B created nothing");
        std::fs::set_permissions(&reviews, std::fs::Permissions::from_mode(0o555)).unwrap();
        // Root bypasses directory permissions; the read-only half proves
        // something only for an ordinary user.
        let ordinary = unsafe { libc::geteuid() } != 0;
        assert_eq!(ids(&root, "src/main.rs"), ["a1"]);
        assert!(ids(&root, "src/b.rs").is_empty());
        if ordinary {
            assert!(add(&root, "src/b.rs", "b1").is_err(), "a write still needs a writable reviews dir");
        }
        std::fs::set_permissions(&reviews, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn a_corrupt_or_foreign_store_is_an_error_and_is_never_overwritten() {
        let d = scratch();
        let root = Root::open(d.to_str().unwrap()).unwrap();
        let rel = "src/main.rs";
        add(&root, rel, "a1").unwrap();
        let path = d.join(".tmm/reviews").join(format!("{}.json", store_key(rel)));
        for bad in ["{ half", r#"{"schema":2,"path":"src/main.rs","annotations":[]}"#, r#"{"schema":1,"path":"other.rs","annotations":[]}"#] {
            std::fs::write(&path, bad).unwrap();
            assert!(add(&root, rel, "a2").is_err(), "{bad}");
            assert!(with_store(&root, rel, Access::Read, |_| Ok(((), false))).is_err(), "{bad}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), bad, "never overwritten");
        }
    }

    #[test]
    fn concurrent_writers_never_lose_an_annotation() {
        let d = scratch();
        let rel = "src/main.rs";
        // A writer pauses inside its lock; another (its own Root, as another
        // process would hold) must wait, not interleave.
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let d = d.clone();
                std::thread::spawn(move || {
                    let root = Root::open(d.to_str().unwrap()).unwrap();
                    if i == 0 {
                        INSIDE_LOCK.with(|h| *h.borrow_mut() = Some(Box::new(|| std::thread::sleep(std::time::Duration::from_millis(100)))));
                    }
                    add(&root, rel, &format!("a{i}")).unwrap();
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        let root = Root::open(d.to_str().unwrap()).unwrap();
        let mut got = ids(&root, rel);
        got.sort();
        assert_eq!(got.len(), 8, "{got:?}");
    }

    #[test]
    fn paths_outside_the_root_and_symlinks_out_are_refused() {
        let d = scratch();
        let outside = std::env::temp_dir().join(format!("tmm-review-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.txt"), "x").unwrap();
        symlink(outside.join("secret.txt"), d.join("src/link-out.txt")).unwrap();
        symlink(d.join("src/main.rs"), d.join("src/link-in.rs")).unwrap();
        let root = Root::open(d.to_str().unwrap()).unwrap();
        assert!(root.relpath(outside.join("secret.txt").to_str().unwrap()).is_err());
        assert!(root.relpath(d.join("src/link-out.txt").to_str().unwrap()).is_err(), "a symlink out");
        assert!(root.relpath(d.join("src/../../x").to_str().unwrap()).is_err());
        assert_eq!(root.relpath(d.join("src/link-in.rs").to_str().unwrap()).unwrap(), "src/main.rs", "an internal link resolves once, to its target");
        assert!(root.read_source("src/../src/main.rs").is_err(), "only plain relpaths are walked");
    }

    #[test]
    fn planted_links_at_every_store_object_are_refused_or_never_followed() {
        let outside = std::env::temp_dir().join(format!("tmm-review-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        let rel = "src/main.rs";
        let key = store_key(rel);
        // `.tmm` and `reviews` as symlinks out.
        for at in [".tmm", ".tmm/reviews"] {
            let d = scratch();
            if at == ".tmm/reviews" {
                std::fs::create_dir_all(d.join(".tmm")).unwrap();
            }
            symlink(&outside, d.join(at)).unwrap();
            let root = Root::open(d.to_str().unwrap()).unwrap();
            assert!(add(&root, rel, "a").is_err(), "{at} as a link");
            assert!(std::fs::read_dir(&outside).unwrap().next().is_none(), "nothing written outside through {at}");
        }
        // The JSON and the lock as links.
        for name in [format!("{key}.json"), format!("{key}.json.lock")] {
            let d = scratch();
            std::fs::create_dir_all(d.join(".tmm/reviews")).unwrap();
            let target = outside.join(format!("t-{}", uuid::Uuid::new_v4()));
            std::fs::write(&target, "{}").unwrap();
            symlink(&target, d.join(".tmm/reviews").join(&name)).unwrap();
            let root = Root::open(d.to_str().unwrap()).unwrap();
            assert!(add(&root, rel, "a").is_err(), "{name} as a link");
            assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}", "the target is untouched");
        }
        // The source file itself as a link swapped in after relpath resolved.
        let d = scratch();
        let root = Root::open(d.to_str().unwrap()).unwrap();
        std::fs::remove_file(d.join("src/main.rs")).unwrap();
        std::fs::write(outside.join("main.rs"), "outside").unwrap();
        symlink(outside.join("main.rs"), d.join("src/main.rs")).unwrap();
        assert!(root.read_source(rel).is_err(), "never read through a swapped-in link");
    }

    #[test]
    fn a_root_swapped_between_its_identity_read_and_its_open_is_refused() {
        let outside = std::env::temp_dir().join(format!("tmm-review-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        // The root becomes a symlink to a directory outside.
        let d = scratch();
        let (d2, o2) = (d.clone(), outside.clone());
        BEFORE_ROOT_OPEN.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&d2, d2.with_extension("moved")).unwrap();
            symlink(&o2, &d2).unwrap();
        })));
        assert!(Root::open(d.to_str().unwrap()).is_err(), "a symlink in its place");
        // A parent of the root becomes a symlink (same name, same leaf).
        let parent = std::env::temp_dir().join(format!("tmm-review-parent-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(parent.join("ws")).unwrap();
        let other = std::env::temp_dir().join(format!("tmm-review-other-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(other.join("ws")).unwrap();
        let ws = std::fs::canonicalize(parent.join("ws")).unwrap();
        let (p2, op) = (std::fs::canonicalize(&parent).unwrap(), other.clone());
        BEFORE_ROOT_OPEN.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&p2, p2.with_extension("moved")).unwrap();
            symlink(&op, &p2).unwrap();
        })));
        assert!(Root::open(ws.to_str().unwrap()).is_err(), "a symlinked parent");
        // The root renamed away and a new real directory made at its path.
        let d = scratch();
        let d3 = d.clone();
        BEFORE_ROOT_OPEN.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&d3, d3.with_extension("old")).unwrap();
            std::fs::create_dir_all(&d3).unwrap();
        })));
        assert!(Root::open(d.to_str().unwrap()).is_err(), "another real directory");
        // Control: undisturbed, it opens.
        assert!(Root::open(scratch().to_str().unwrap()).is_ok());
    }

    #[test]
    fn a_reviews_dir_swapped_for_a_link_after_the_root_is_proved_is_never_followed() {
        let outside = std::env::temp_dir().join(format!("tmm-review-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        let d = scratch();
        std::fs::create_dir_all(d.join(".tmm/reviews")).unwrap();
        let root = Root::open(d.to_str().unwrap()).unwrap();
        let (d2, o2) = (d.clone(), outside.clone());
        BEFORE_REVIEWS_OPEN.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(d2.join(".tmm/reviews"), d2.join(".tmm/reviews.old")).unwrap();
            symlink(&o2, d2.join(".tmm/reviews")).unwrap();
        })));
        assert!(add(&root, "src/main.rs", "a").is_err());
        assert!(std::fs::read_dir(&outside).unwrap().next().is_none(), "the write stayed inside: nothing outside");
    }

    #[test]
    fn a_source_swapped_between_resolve_and_read_is_read_from_the_fd_it_opened() {
        let outside = std::env::temp_dir().join(format!("tmm-review-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("main.rs"), "outside").unwrap();
        let d = scratch();
        let root = Root::open(d.to_str().unwrap()).unwrap();
        let rel = root.relpath(d.join("src/main.rs").to_str().unwrap()).unwrap();
        let (d2, o2) = (d.clone(), outside.clone());
        BEFORE_SOURCE_OPEN.with(|h| *h.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(d2.join("src"), d2.join("src.old")).unwrap();
            symlink(&o2, d2.join("src")).unwrap();
        })));
        assert!(root.read_source(&rel).is_err(), "a directory swapped for a link is not walked through");
    }
}

/// The anchor case table (delta 1-3): the LINE model, `take` and `locate`.
#[cfg(test)]
mod anchor_tests {
    use super::*;

    fn r(line: u32, col: u32, end_line: u32, end_col: u32) -> Range {
        Range { line, col, end_line, end_col }
    }

    fn ann(text: &str, range: Range) -> Annotation {
        let m = Model::from_text(text);
        let (quote, pre, suf) = take(&m, &range).unwrap();
        Annotation {
            id: "a".into(), line: range.line, col: range.col, end_line: range.end_line, end_col: range.end_col,
            quote, pre, suf, note: "n".into(), status: "open".into(), revision: revision(text.as_bytes()),
            created: 0, updated: 0, by: "human".into(),
        }
    }

    fn at(text: &str, a: &Annotation) -> Located {
        locate(&Model::from_text(text), &revision(text.as_bytes()), a)
    }

    #[test]
    fn columns_are_scalars_and_lines_end_at_lf_or_crlf() {
        // The LINE model's shared rows: `review-anchor.test.ts` reads these
        // out of this file and runs `reviewLines`, so the two readers of the
        // model cannot disagree. Keep each row on one line:
        // `("<text>", <lines>, <scalars of the last line>),`.
        let shared: &[(&str, usize, usize)] = &[
            ("x\r\ny", 2, 1),
            ("a\rb", 1, 3),
            ("one\ntwo\r\nthree", 3, 5),
            ("a 👍🏽 b", 1, 6),
            ("中文注释\n", 2, 0),
            ("", 1, 0),
        ];
        for (text, lines, last) in shared {
            let m = Model::from_text(text);
            assert_eq!((m.line_count(), m.line_len(m.line_count()).unwrap()), (*lines, *last), "{text:?}");
        }
        // emoji: the thumb and its skin tone are two scalars.
        let m = Model::from_text("a 👍🏽 b");
        assert_eq!(take(&m, &r(1, 3, 1, 5)).unwrap().0, "👍🏽");
        // CJK.
        assert_eq!(take(&Model::from_text("中文注释"), &r(1, 3, 1, 5)).unwrap().0, "注释");
        // CRLF: the CR is part of the terminator, never of line 1.
        let crlf = Model::from_text("x\r\ny");
        assert_eq!((crlf.line_count(), crlf.text().as_str()), (2, "x\ny"));
        assert_eq!(take(&crlf, &r(2, 1, 2, 2)).unwrap().0, "y");
        assert!(take(&crlf, &r(1, 1, 1, 3)).is_err(), "line 1 has one scalar: col 3 is out");
        // A lone CR is an ordinary character.
        let cr = Model::from_text("a\rb");
        assert_eq!((cr.line_count(), take(&cr, &r(1, 2, 1, 4)).unwrap().0.as_str()), (1, "\rb"));
        // Multi-line: the quote holds an LF, never a CR.
        let ml = "one\r\ntwo three\r\nfour five\r\n";
        assert_eq!(take(&Model::from_text(ml), &r(2, 5, 3, 5)).unwrap().0, "three\nfour");
        // Whitespace only, empty and out of bounds are refused.
        let m = Model::from_text("a   b\n");
        assert!(take(&m, &r(1, 2, 1, 5)).is_err(), "whitespace only");
        assert!(take(&m, &r(1, 2, 1, 2)).is_err(), "empty");
        assert!(take(&m, &r(9, 1, 9, 2)).is_err(), "out of bounds");
    }

    #[test]
    fn relocation_says_located_missing_or_ambiguous_and_never_guesses() {
        let text = "fn a() {\n    foo();\n}\nfn b() {\n    foo();\n    bar();\n}\n";
        // Same revision: the stored range.
        let second = ann(text, r(5, 5, 5, 11));
        assert_eq!(at(text, &second), Located::Located(r(5, 5, 5, 11)));
        // Text inserted above: located, line shifted; the context picks the
        // second `foo();` (its suf is the `bar();` line).
        let moved = format!("// header\n{text}");
        assert_eq!(at(&moved, &second), Located::Located(r(6, 5, 6, 11)));
        // Duplicates with the same context: ambiguous, no range. The padding
        // is longer than CONTEXT, so both windows are identical.
        let pad = "p".repeat(CONTEXT + 8);
        let same = format!("{pad}\nx = 1\n{pad}\nx = 1\n{pad}\n");
        let mut first = ann(&same, r(2, 1, 2, 6));
        first.revision = "an older revision".into();
        assert_eq!(at(&same, &first), Located::Ambiguous);
        // The quote edited away: missing.
        assert_eq!(at("fn a() {}\n", &second), Located::Missing);
        // A store on disk is not trusted: same revision but the text at the
        // range is not the quote → relocated by text.
        let mut lying = ann(text, r(2, 5, 2, 11));
        lying.line = 4; lying.end_line = 4;
        assert_eq!(at(text, &lying), Located::Located(r(2, 5, 2, 11)));
    }

    /// Validator on 5b2a004f, orchestrator's ruling: a lone exact copy whose
    /// surroundings agree with none of the stored context is NOT the
    /// commented text moved. Two identical paragraphs, the first commented
    /// and then edited: missing, never located on the second, even though
    /// both copies sit between blank lines (whitespace is not context).
    /// A move keeps its context and is still located.
    #[test]
    fn a_lone_copy_with_no_matching_context_is_missing() {
        let para = "the same sentence in both places.";
        let text = format!("# Notes\n\n{para}\n\nmiddle words here\n\n{para}\n");
        let first = ann(&text, r(3, 1, 3, 34));
        assert_eq!(at(&text, &first), Located::Located(r(3, 1, 3, 34)), "unchanged: the stored range");
        let edited = format!("# Notes\n\nthe first one was rewritten.\n\nmiddle words here\n\n{para}\n");
        assert_eq!(at(&edited, &first), Located::Missing, "its own text is gone; the other copy is not it");
        // The same paragraph moved down under a new line keeps its context.
        let moved = format!("# Notes\n\nnew text above\n\n{para}\n\nmiddle words here\n\n{para}\n");
        let second = ann(&text, r(7, 1, 7, 34));
        assert_eq!(at(&moved, &second), Located::Located(r(9, 1, 9, 34)));
        // No stored context at all has nothing to disagree with.
        let mut bare = first.clone();
        bare.pre = String::new();
        bare.suf = String::new();
        assert_eq!(at(&edited, &bare), Located::Located(r(7, 1, 7, 34)));
    }

    /// Reviewer P2 on 93c1b929, orchestrator's ruling: whitespace-only
    /// context is NO context. A one-line `hello` file whose only context is
    /// its newline keeps its comment through LF→CRLF (the revision changes,
    /// the text does not); two such copies are ambiguous; a lone copy whose
    /// real context scores zero is still missing (the twins above).
    #[test]
    fn whitespace_only_context_is_no_evidence() {
        let lf = "hello\n";
        let a = ann(lf, r(1, 1, 1, 6));
        assert_eq!((a.pre.as_str(), a.suf.as_str()), ("", "\n"), "the only context is the newline");
        let crlf = "hello\r\n";
        assert_ne!(revision(lf.as_bytes()), revision(crlf.as_bytes()));
        assert_eq!(locate(&Model::from_bytes(crlf.as_bytes()).unwrap(), &revision(crlf.as_bytes()), &a), Located::Located(r(1, 1, 1, 6)));
        assert_eq!(at("hello\n\nhello\n", &a), Located::Ambiguous, "two copies with no evidence: no guess");
        let mut spaced = a.clone();
        spaced.pre = "  \n".into();
        assert_eq!(at("x\nhello\n", &spaced), Located::Located(r(2, 1, 2, 6)), "spaces and newlines are no evidence either");
    }

    #[test]
    fn a_crlf_conversion_does_not_lose_a_comment() {
        let crlf = "one\r\ntwo three\r\nfour five\r\n";
        let a = ann(crlf, r(2, 5, 3, 5));
        assert_eq!(a.quote, "three\nfour");
        // A line inserted above (revision moved): located, line +1.
        assert_eq!(at(&format!("zero\r\n{crlf}"), &a), Located::Located(r(3, 5, 4, 5)));
        // CRLF → LF, nothing else changed: the same range.
        let lf = crlf.replace("\r\n", "\n");
        assert_eq!(at(&lf, &a), Located::Located(r(2, 5, 3, 5)));
        // And LF → CRLF from an LF original.
        let b = ann(&lf, r(2, 5, 3, 5));
        assert_eq!(at(crlf, &b), Located::Located(r(2, 5, 3, 5)));
        // A lone CR survives a conversion of the other lines.
        let cr = ann("a\rb\nnext\n", r(1, 2, 1, 4));
        assert_eq!(at("a\rb\r\nnext\r\n", &cr), Located::Located(r(1, 2, 1, 4)));
    }

    #[test]
    fn the_feedback_block_is_the_portal_shape_and_widens_no_recipient() {
        let text = "intro\nask @lead about this line\nthe end\nfirst\nsecond\n";
        let mut a = ann(text, r(2, 5, 2, 10));
        a.note = "check with @builder, mail a@b.dev".into();
        let mut multi = ann(text, r(4, 1, 5, 7));
        multi.note = "two\nlines".into();
        let mut gone = ann(text, r(3, 1, 3, 8));
        gone.revision = "old".into();
        gone.quote = "removed text".into();
        gone.note = "lost".into();
        let mut resolved = ann(text, r(1, 1, 1, 6));
        resolved.status = "resolved".into();
        let m = Model::from_text(text);
        let (block, n) = feedback("/w/@lead/doc.md", &m, &revision(text.as_bytes()), &[a, multi, gone, resolved]);
        assert_eq!(n, 3, "only open comments");
        assert_eq!(
            block,
            "[Document feedback on /w/＠lead/doc.md — 3 comments]\n\
             1. (line 2, col 5, \"＠lead\" in \"ask ＠lead about this line\"): \"check with ＠builder, mail a＠b.dev\"\n\
             2. (lines 4–5, col 1, \"first second\" in \"first second\"): \"two lines\"\n\
             3. (\"removed text\"): \"lost\""
        );
        assert!(crate::address::mention_names(&block).is_empty(), "the block names nobody: {block}");
        let mut composer = format!("@builder {block}");
        assert_eq!(crate::address::mention_names(&composer), ["builder"], "the composer's own address is the only one");
        composer.clear();
        // A long selection is cut at QUOTE_CUT scalars.
        let long = format!("{}\n", "x".repeat(80));
        let la = ann(&long, r(1, 1, 1, 81));
        let (b, _) = feedback("/w/f", &Model::from_text(&long), &revision(long.as_bytes()), &[la]);
        assert!(b.contains(&format!("\"{}…\"", "x".repeat(QUOTE_CUT))), "{b}");
    }
}

/// The RPCs end to end on a real project in the test store.
#[cfg(test)]
mod rpc_tests {
    use super::*;
    use serde_json::json;

    fn project(path: &Path) -> String {
        crate::projects::tests::use_test_store();
        let id = format!("rev-{}", uuid::Uuid::new_v4());
        crate::projects::with_store(|s| s.insert_project(&crate::projects::Project {
            id: id.clone(), name: id.clone(), path: path.to_string_lossy().to_string(), icon: None,
            session: id.clone(), adopted: false, autostart: false, created_at: 1,
            last_up_at: None, last_seen_at: None, archived: false, room: String::new(),
        })).unwrap();
        id
    }

    /// Reviewer P1-D on 5b2a004f: `lines` (tmm review add) is expanded by
    /// the SERVER in the read the quote is cut from. Whole lines of a CRLF
    /// file end at the line's end, `cols` is inclusive, and a line past the
    /// end, a reversed range or cols without lines are refused.
    #[test]
    fn whole_lines_are_measured_by_the_server_in_its_own_read() {
        let d = std::env::temp_dir().join(format!("tmm-review-lines-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let file = d.join("f.txt");
        std::fs::write(&file, "first\r\nabcdef\r\nthird\n").unwrap();
        let id = project(&d);
        let path = std::fs::canonicalize(&file).unwrap().to_string_lossy().to_string();
        let with = |extra: serde_json::Value| { let mut v = json!({ "project_id": id, "path": path }); for (k, x) in extra.as_object().unwrap() { v[k] = x.clone(); } v };
        let a = add(&with(json!({ "lines": [2, 2], "note": "n" }))).unwrap();
        assert_eq!((a["quote"].as_str(), a["col"].as_u64(), a["end_col"].as_u64()), (Some("abcdef"), Some(1), Some(7)), "the whole line as the SERVER has it");
        let b = add(&with(json!({ "lines": [1, 3], "note": "n" }))).unwrap();
        assert_eq!(b["quote"], "first\nabcdef\nthird");
        let c = add(&with(json!({ "lines": [2, 2], "cols": [2, 4], "note": "n" }))).unwrap();
        assert_eq!(c["quote"], "bcd");
        assert!(add(&with(json!({ "lines": [9, 9], "note": "n" }))).is_err(), "past the end");
        assert!(add(&with(json!({ "lines": [3, 2], "note": "n" }))).is_err());
        assert!(add(&with(json!({ "cols": [1, 2], "note": "n" }))).is_err());
        assert!(add(&with(json!({ "lines": [1, 1], "range": { "line": 1, "col": 1, "end_line": 1, "end_col": 2 }, "note": "n" }))).is_err(), "one selection, not two");
    }

    #[test]
    fn add_list_update_delete_feedback_and_a_stale_revision() {
        let d = std::env::temp_dir().join(format!("tmm-review-rpc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(d.join("docs")).unwrap();
        let file = d.join("docs/plan.md");
        std::fs::write(&file, "# Plan\r\nship the parser\r\nthen the UI\r\n").unwrap();
        let id = project(&d);
        let path = std::fs::canonicalize(&file).unwrap().to_string_lossy().to_string();
        let (_, rev) = crate::fs::read_file_with_revision(&path).unwrap();
        let base = json!({ "project_id": id, "path": path });
        let with = |extra: serde_json::Value| { let mut v = base.clone(); for (k, x) in extra.as_object().unwrap() { v[k] = x.clone(); } v };

        // A stale revision is refused and nothing is stored.
        let stale = add(&with(json!({ "revision": "not it", "range": { "line": 2, "col": 6, "end_line": 2, "end_col": 12 }, "note": "n" }))).unwrap();
        assert_eq!((stale["stale"].as_bool(), stale["revision"].as_str()), (Some(true), Some(rev.as_str())));
        assert_eq!(list(&base).unwrap()["annotations"].as_array().unwrap().len(), 0);
        // The fs_read revision is the one add checks.
        let a = add(&with(json!({ "revision": rev, "range": { "line": 2, "col": 6, "end_line": 2, "end_col": 12 }, "note": "which parser?" }))).unwrap();
        assert_eq!(a["quote"], "the pa");
        let aid = a["id"].as_str().unwrap().to_string();
        // A session names the same project (the `tmm` path).
        let by_session = list(&json!({ "session": id, "path": path })).unwrap();
        assert_eq!(by_session["annotations"][0]["at"]["state"], "located");
        assert_eq!(by_session["revision"], rev);
        // A relative path is refused (never resolved against the gateway's cwd).
        assert!(list(&json!({ "project_id": id, "path": "docs/plan.md" })).is_err());
        // Update, feedback, resolve hides it from feedback, delete.
        assert_eq!(update(&with(json!({ "id": aid, "note": "the json one" }))).unwrap()["note"], "the json one");
        let fb = feedback_rpc(&base).unwrap();
        assert_eq!(fb["count"], 1);
        assert!(fb["text"].as_str().unwrap().contains("1. (line 2, col 6, \"the pa\" in \"ship the parser\"): \"the json one\""), "{}", fb["text"]);
        update(&with(json!({ "id": aid, "status": "resolved" }))).unwrap();
        assert_eq!(feedback_rpc(&base).unwrap()["count"], 0);
        assert!(update(&with(json!({ "id": aid, "status": "done" }))).is_err(), "only open|resolved");
        delete(&with(json!({ "id": aid }))).unwrap();
        assert!(delete(&with(json!({ "id": aid }))).is_err(), "already gone");
        // The file changes: the comment relocates.
        let b = add(&with(json!({ "range": { "line": 3, "col": 10, "end_line": 3, "end_col": 12 }, "note": "UI?" }))).unwrap();
        assert_eq!(b["quote"], "UI");
        std::fs::write(&file, "# Plan\nfirst the docs\nship the parser\nthen the UI\n").unwrap();
        let l = list(&base).unwrap();
        assert_eq!(l["annotations"][0]["at"], json!({ "state": "located", "range": { "line": 4, "col": 10, "end_line": 4, "end_col": 12 } }));
        assert_ne!(l["revision"], rev, "the revision is the current file's");
    }
}
