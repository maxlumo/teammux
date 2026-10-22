//! Directory-handle file access (board #448, extracted from #433/#434's
//! `server::download::open_in_scope`): every step acts on ONE held directory
//! object, never on a path resolved again at each step. A directory opens
//! with O_DIRECTORY|O_NOFOLLOW, each child is reached with `openat` from the
//! handle before it, and stats, modes, creation, renames and removals are
//! all relative to the held handle (`fstat`, `fchmod`, `fstatat`, `mkdirat`,
//! `renameat`, `unlinkat`). So a symlink at any step is refused by the kernel
//! (ELOOP/ENOTDIR), and a directory whose NAME is swapped after it was opened
//! keeps receiving every operation on the object that was checked.
//!
//! Unix only. Windows has no equivalent here, and no mode guarantee is made
//! there (the #448 rules are Unix-only).

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::Path;

/// The flags every directory handle opens with.
const DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

fn cstr(s: &str) -> io::Result<CString> {
    CString::new(s).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
}

fn check(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(rc) }
}

/// A held directory handle.
pub(crate) struct Dir(OwnedFd);

impl Dir {
    /// Open the directory at `path`, refusing a symlink at its last component.
    pub(crate) fn open(path: &Path) -> io::Result<Dir> {
        use std::os::unix::ffi::OsStrExt;
        let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
        let fd = check(unsafe { libc::open(c.as_ptr(), DIR_FLAGS) })?;
        Ok(Dir(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    /// Open the child directory `name` from this handle (no symlink).
    pub(crate) fn open_dir(&self, name: &str) -> io::Result<Dir> {
        let fd = check(unsafe { libc::openat(self.fd(), cstr(name)?.as_ptr(), DIR_FLAGS) })?;
        Ok(Dir(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    /// Open the child file `name` from this handle with `flags` (and `mode`
    /// when it creates one). O_NOFOLLOW and O_CLOEXEC are always added.
    pub(crate) fn open_file(&self, name: &str, flags: libc::c_int, mode: libc::mode_t) -> io::Result<std::fs::File> {
        let flags = flags | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        let fd = check(unsafe { libc::openat(self.fd(), cstr(name)?.as_ptr(), flags, mode as libc::c_uint) })?;
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    /// `fstat` of the held directory itself.
    pub(crate) fn stat(&self) -> io::Result<libc::stat> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        check(unsafe { libc::fstat(self.fd(), &mut st) })?;
        Ok(st)
    }

    /// `fstatat(name, AT_SYMLINK_NOFOLLOW)`: the entry itself, a symlink
    /// included as a symlink. `None` when there is no such entry.
    pub(crate) fn stat_at(&self, name: &str) -> io::Result<Option<libc::stat>> {
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        match check(unsafe { libc::fstatat(self.fd(), cstr(name)?.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) }) {
            Ok(_) => Ok(Some(st)),
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `mkdirat(name, mode)`. The umask may clear bits from `mode`; callers
    /// that need an exact mode open the new directory and `chmod` it.
    pub(crate) fn mkdir(&self, name: &str, mode: libc::mode_t) -> io::Result<()> {
        check(unsafe { libc::mkdirat(self.fd(), cstr(name)?.as_ptr(), mode) }).map(|_| ())
    }

    /// `fchmod` of the held directory.
    pub(crate) fn chmod(&self, mode: libc::mode_t) -> io::Result<()> {
        check(unsafe { libc::fchmod(self.fd(), mode) }).map(|_| ())
    }

    /// `renameat(from, to)`, both inside this directory.
    pub(crate) fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        check(unsafe { libc::renameat(self.fd(), cstr(from)?.as_ptr(), self.fd(), cstr(to)?.as_ptr()) }).map(|_| ())
    }

    /// `unlinkat(name, 0)`: a file or a symlink itself, never its target.
    pub(crate) fn unlink(&self, name: &str) -> io::Result<()> {
        check(unsafe { libc::unlinkat(self.fd(), cstr(name)?.as_ptr(), 0) }).map(|_| ())
    }

    /// `symlinkat(target, name)`: a link named `name` in this directory.
    pub(crate) fn symlink(&self, target: &Path, name: &str) -> io::Result<()> {
        use std::os::unix::ffi::OsStrExt;
        let t = CString::new(target.as_os_str().as_bytes()).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
        check(unsafe { libc::symlinkat(t.as_ptr(), self.fd(), cstr(name)?.as_ptr()) }).map(|_| ())
    }

    /// `readlinkat(name)`: where the link `name` points, never followed.
    pub(crate) fn read_link(&self, name: &str) -> io::Result<std::path::PathBuf> {
        use std::os::unix::ffi::OsStringExt;
        let mut buf = vec![0u8; libc::PATH_MAX as usize];
        let n = unsafe { libc::readlinkat(self.fd(), cstr(name)?.as_ptr(), buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        if n < 0 { return Err(io::Error::last_os_error()); }
        buf.truncate(n as usize);
        Ok(std::path::PathBuf::from(std::ffi::OsString::from_vec(buf)))
    }

    /// `fsync` of the directory, so a rename in it is durable.
    pub(crate) fn sync(&self) -> io::Result<()> {
        check(unsafe { libc::fsync(self.fd()) }).map(|_| ())
    }

    fn fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}

/// The euid of this process.
pub(crate) fn euid() -> u32 {
    unsafe { libc::geteuid() }
}

pub(crate) fn is_dir(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFDIR
}

pub(crate) fn is_file(st: &libc::stat) -> bool {
    st.st_mode & libc::S_IFMT == libc::S_IFREG
}

// ---- private publication (board #448) ---------------------------------------

/// A single path component we may create or open: not empty, not `.` or
/// `..`, no `/`, no NUL. Every name handed to the private writers is one.
pub(crate) fn plain_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0')
}

fn denied(what: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, format!("Permission denied: {what}"))
}

/// One step of a private walk: the child directory `name` of `dir`, created
/// when absent (`mkdirat`), opened without following a link, and verified to
/// be a directory owned by our euid. `mode` makes it exactly that mode
/// (`fchmod` on the opened handle, so the umask never matters); `None`
/// leaves the mode as it is (a directory we only pass through).
pub(crate) fn step(dir: &Dir, name: &str, mode: Option<libc::mode_t>) -> io::Result<Dir> {
    if !plain_name(name) {
        return Err(io::Error::from_raw_os_error(libc::EINVAL));
    }
    if dir.stat_at(name)?.is_none() {
        match dir.mkdir(name, mode.unwrap_or(0o755)) {
            Err(e) if e.raw_os_error() != Some(libc::EEXIST) => return Err(e),
            _ => {}
        }
    }
    let child = dir.open_dir(name)?;
    let st = child.stat()?;
    if !is_dir(&st) || st.st_uid != euid() {
        return Err(denied(format!("{name} is not a directory of this user")));
    }
    match mode {
        Some(m) if st.st_mode & 0o7777 != m => child.chmod(m)?,
        // A directory we only pass through keeps its mode, but never one
        // other users can write (board #448 A2): names inside a writable
        // directory can be swapped whatever handle we hold.
        None if st.st_mode & 0o022 != 0 => child.chmod((st.st_mode & 0o7777 & !0o022) as libc::mode_t)?,
        _ => {}
    }
    Ok(child)
}

/// The base a private walk starts from: the directory at `path`, resolved
/// to its CANONICAL path first (a legitimate alias such as a HOME symlink is
/// followed here, once), then opened as a handle.
fn base(path: &Path) -> io::Result<Dir> {
    Dir::open(&std::fs::canonicalize(path)?)
}

/// The directory `dir`, held and private (0700, ours), walked from its
/// canonical parent: the directory a private file is published in.
pub(crate) fn private_dir(dir: &Path) -> io::Result<Dir> {
    let name = dir.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
    let parent = dir.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    step(&base(parent)?, name, Some(0o700))
}

/// A managed agent's home, held and private: for `<root>/.tmm/agents/<name>`
/// the walk starts at the canonical project root and opens `.tmm` (ours,
/// mode kept), `agents` (0700) and the home (0700) one handle after the
/// other, never through a link; any other home is walked from its canonical
/// parent. Created when absent.
pub(crate) fn private_home(home: &Path) -> io::Result<Dir> {
    let name = home.file_name().and_then(|n| n.to_str()).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
    let parent = home.parent().ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
    let agents_dir = parent.file_name().is_some_and(|n| n == "agents")
        && parent.parent().and_then(|p| p.file_name()).is_some_and(|n| n == ".tmm");
    if agents_dir {
        let root = parent.parent().and_then(|p| p.parent()).filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        // The workspace itself is not ours to protect, only to exist.
        std::fs::create_dir_all(root)?;
        let tmm = step(&base(root)?, ".tmm", None)?;
        let agents = step(&tmm, "agents", Some(0o700))?;
        return step(&agents, name, Some(0o700));
    }
    private_dir(home)
}

#[cfg(test)]
thread_local! {
    /// Test seams: run after the directory handle is held (a swap of its
    /// name), and fail between the write and the rename.
    pub(crate) static AFTER_DIR_OPEN: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
    pub(crate) static FAIL_BEFORE_RENAME: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Publish `bytes` as `name` in the held private directory `dir`:
/// - a temp `.<name>.tmp-<uuid>` is created with O_CREAT|O_EXCL (an existing
///   temp is never reused) and made exactly 0600 by `fchmod` before the first
///   byte, whatever the umask;
/// - written and fsynced;
/// - the target is checked with `fstatat` (no link followed): absent, or a
///   regular file of ours, is replaced by `renameat`; a symlink, anything
///   else or another user's file is an ERROR and is left as it is;
/// - the directory is fsynced.
///
/// Any failure removes the temp and returns the error.
pub(crate) fn publish(dir: &Dir, name: &str, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    if !plain_name(name) {
        return Err(io::Error::from_raw_os_error(libc::EINVAL));
    }
    // A directory other users can write is refused, never published into:
    // they could swap the temp's or the target's name (A2).
    let st = dir.stat()?;
    if st.st_mode & 0o022 != 0 || st.st_uid != euid() {
        return Err(denied("the directory is not this user's own, or other users can write to it; nothing was published".to_string()));
    }
    let temp = format!(".{name}.tmp-{}", uuid::Uuid::new_v4());
    let mut file = dir.open_file(&temp, libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY, 0o600)?;
    let written = (|| {
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        #[cfg(test)]
        if FAIL_BEFORE_RENAME.with(|f| f.get()) {
            return Err(io::Error::other("injected failure before the rename"));
        }
        match dir.stat_at(name)? {
            None => {}
            Some(st) if is_file(&st) && st.st_uid == euid() => {}
            Some(_) => return Err(denied(format!("{name} exists and is not a regular file of this user; it was left as it is"))),
        }
        dir.rename(&temp, name)?;
        dir.sync()
    })();
    if written.is_err() {
        let _ = dir.unlink(&temp);
    }
    written
}

/// Remove `name` from the held directory: absent is done; a regular file of
/// ours is unlinked; anything else is an error and is left as it is.
pub(crate) fn remove(dir: &Dir, name: &str) -> io::Result<()> {
    if !plain_name(name) {
        return Err(io::Error::from_raw_os_error(libc::EINVAL));
    }
    match dir.stat_at(name)? {
        None => Ok(()),
        Some(st) if is_file(&st) && st.st_uid == euid() => dir.unlink(name),
        Some(_) => Err(denied(format!("{name} is not a regular file of this user; it was left as it is"))),
    }
}

/// The held directory a private file under `.tmm` lives in, walked from the
/// ENTRY (board #448 P1-A): the prefix before the path's `.tmm` component
/// (the project root, where a legitimate HOME alias is resolved, once) is
/// opened from its canonical path, then `.tmm` (ours, its mode kept) and
/// every component below it one handle after the other with O_NOFOLLOW,
/// each verified ours and made 0700. A link anywhere inside the home is
/// refused; nothing below the entry is ever resolved again. A path with no
/// `.tmm` component is refused in production (every agent home and the
/// workspace's own MCP file are under it); a test's scratch directory is
/// walked from its canonical parent.
fn held_dir(dir: &Path) -> io::Result<Dir> {
    use std::path::Component;
    let parts: Vec<Component> = dir.components().collect();
    let Some(at) = parts.iter().rposition(|c| matches!(c, Component::Normal(n) if *n == ".tmm")) else {
        #[cfg(test)]
        return private_dir(dir);
        #[cfg(not(test))]
        return Err(denied(format!("{} is not under a .tmm directory; nothing is written there privately", dir.display())));
    };
    let root: std::path::PathBuf = parts[..at].iter().collect();
    let root = if root.as_os_str().is_empty() { std::path::PathBuf::from(".") } else { root };
    std::fs::create_dir_all(&root)?;
    let mut d = step(&base(&root)?, ".tmm", None)?;
    for c in &parts[at + 1..] {
        let Component::Normal(n) = c else { return Err(io::Error::from_raw_os_error(libc::EINVAL)) };
        let n = n.to_str().ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
        d = step(&d, n, Some(0o700))?;
    }
    Ok(d)
}

/// The directory `dir` (under `.tmm`), held private through the entry walk:
/// for a caller that works on several names in it (codex's inheritance).
pub(crate) fn private_subdir(dir: &Path) -> io::Result<Dir> {
    held_dir(dir)
}

/// Is `p`'s directory there? `Ok(false)` only for NotFound; anything else
/// (permission, I/O) cannot be audited and is an error (P2).
fn dir_present(p: Option<&Path>) -> io::Result<bool> {
    let Some(p) = p.filter(|p| !p.as_os_str().is_empty()) else { return Ok(true) };
    match std::fs::metadata(p) {
        Ok(m) => Ok(m.is_dir()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// `path`'s directory and file name, the directory held private.
fn held(path: &Path) -> io::Result<(Dir, String)> {
    let name = path.file_name().and_then(|n| n.to_str()).filter(|n| plain_name(n)).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
    let dir = held_dir(path.parent().ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?)?;
    #[cfg(test)]
    AFTER_DIR_OPEN.with(|h| if let Some(f) = h.borrow().as_ref() { f() });
    Ok((dir, name.to_string()))
}

/// Make the EXISTING file `name` in `dir` 0600, verified on the opened
/// object (board #448 P1-D): opened O_RDONLY|O_NONBLOCK|O_NOFOLLOW (a link is
/// refused by the kernel, and a FIFO swapped in cannot block), then `fstat`
/// of THAT fd must say a regular file of ours before `fchmod`. Absent is
/// nothing to do.
pub(crate) fn fix_mode(dir: &Dir, name: &str) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    if dir.stat_at(name)?.is_none() {
        return Ok(());
    }
    let f = match dir.open_file(name, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
        Ok(f) => f,
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => return Ok(()),
        Err(e) if e.raw_os_error() == Some(libc::ELOOP) => return Err(denied(format!("{name} is a link; it was left as it is"))),
        Err(e) => return Err(e),
    };
    let m = f.metadata()?;
    if !m.is_file() || m.uid() != euid() {
        return Err(denied(format!("{name} is not a regular file of this user; it was left as it is")));
    }
    if m.mode() & 0o7777 != 0o600 {
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Make an existing private file 0600 in place, through the same held walk
/// as `write_private` (its content untouched).
pub(crate) fn tighten_file(path: &Path) -> Result<(), String> {
    match dir_present(path.parent()) {
        Ok(false) => return Ok(()),
        Ok(true) => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    held(path).and_then(|(dir, name)| fix_mode(&dir, &name)).map_err(|e| format!("{}: {e}", path.display()))
}

/// Write `bytes` to `path` privately (see `publish`).
pub(crate) fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    held(path).and_then(|(dir, name)| publish(&dir, &name, bytes)).map_err(|e| format!("{}: {e}", path.display()))
}

/// Write `text` to `path` privately (see `publish`): the directory is held
/// and made 0700, the file is 0600 from its first byte, and it replaces the
/// old file whole.
pub(crate) fn write_private(path: &Path, text: &str) -> Result<(), String> {
    write_private_bytes(path, text.as_bytes())
}

/// Remove `path` through its held directory (see `remove`).
pub(crate) fn remove_private(path: &Path) -> Result<(), String> {
    // Nothing to remove where the directory is not there; never create it.
    match dir_present(path.parent()) {
        Ok(false) => return Ok(()),
        Ok(true) => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    match held(path) {
        Ok((dir, name)) => remove(&dir, &name),
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        Err(e) => Err(e),
    }
    .map_err(|e| format!("{}: {e}", path.display()))
}

/// Test support: a file the private writer cannot replace. Its name becomes
/// a link to its own content, so a write fails (`publish` refuses a link)
/// while every reader still sees the old file. `unjam` puts the file back.
/// (A read-only directory no longer fails a write: the writer makes a
/// directory of ours 0700.)
#[cfg(test)]
pub(crate) fn jam(path: &Path) {
    let real = path.with_extension("jammed");
    std::fs::rename(path, &real).unwrap();
    std::os::unix::fs::symlink(&real, path).unwrap();
}

#[cfg(test)]
pub(crate) fn unjam(path: &Path) {
    std::fs::remove_file(path).unwrap();
    std::fs::rename(path.with_extension("jammed"), path).unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o7777
    }
    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tmm-safefs-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    /// Every file under `dir` whose bytes contain `needle`.
    fn holding(dir: &Path, needle: &str) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if std::fs::symlink_metadata(&p).unwrap().is_dir() { out.extend(holding(&p, needle)); continue; }
            if std::fs::read(&p).map(|b| String::from_utf8_lossy(&b).contains(needle)).unwrap_or(false) { out.push(p); }
        }
        out
    }
    fn with_umask<T>(m: libc::mode_t, f: impl FnOnce() -> T) -> T {
        let old = unsafe { libc::umask(m) };
        let r = f();
        unsafe { libc::umask(old) };
        r
    }

    #[test]
    fn a_private_file_is_exactly_0600_from_its_first_byte_under_any_umask() {
        // 0o277 would leave a plain 0600 create at 0400: the fchmod makes it exact.
        for um in [0o000, 0o022, 0o077, 0o277] {
            let d = scratch("umask");
            let p = d.join("home/mcp.json");
            with_umask(um, || write_private(&p, "SENTINEL-umask")).unwrap();
            assert_eq!(mode(&p), 0o600, "umask {um:o}");
            assert_eq!(mode(&d.join("home")), 0o700, "its directory is private too (umask {um:o})");
            assert_eq!(std::fs::read_to_string(&p).unwrap(), "SENTINEL-umask");
            std::fs::remove_dir_all(&d).ok();
        }
    }

    #[test]
    fn an_old_wide_file_of_ours_is_replaced_whole_and_private_and_no_temp_is_reused() {
        let d = scratch("replace");
        let home = d.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = home.join("launch.json");
        std::fs::write(&p, "old").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        // A pre-placed temp of the same shape: never opened (O_EXCL, a fresh uuid).
        let planted = home.join(".launch.json.tmp-planted");
        std::fs::write(&planted, "planted").unwrap();
        write_private(&p, "new SENTINEL").unwrap();
        assert_eq!((std::fs::read_to_string(&p).unwrap().as_str(), mode(&p)), ("new SENTINEL", 0o600));
        assert_eq!(mode(&home), 0o700, "a 0755 directory of ours is closed");
        assert_eq!(std::fs::read_to_string(&planted).unwrap(), "planted", "the planted temp is untouched");
        let temps = std::fs::read_dir(&home).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp-") && e.path() != planted).count();
        assert_eq!(temps, 0, "no temp is left behind");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_link_at_the_target_or_the_directory_is_refused_and_its_target_never_touched() {
        let d = scratch("links");
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
        let sentinel = outside.join("user.toml");
        std::fs::write(&sentinel, "the user's own").unwrap();
        std::fs::set_permissions(&sentinel, std::fs::Permissions::from_mode(0o644)).unwrap();
        // The target name is a link to an outside file.
        let home = d.join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::os::unix::fs::symlink(&sentinel, home.join("profile.toml")).unwrap();
        let err = write_private(&home.join("profile.toml"), "SENTINEL-secret").unwrap_err();
        assert!(err.contains("not a regular file"), "{err}");
        // The directory itself is a link to an outside directory.
        std::os::unix::fs::symlink(&outside, d.join("linked")).unwrap();
        assert!(write_private(&d.join("linked/x.json"), "SENTINEL-secret").is_err());
        assert!(remove_private(&home.join("profile.toml")).is_err(), "a removal does not unlink through a link either");
        assert_eq!((std::fs::read_to_string(&sentinel).unwrap().as_str(), mode(&sentinel)), ("the user's own", 0o644));
        assert_eq!(mode(&outside), 0o755, "nothing was chmodded through the link");
        assert!(holding(&d, "SENTINEL-secret").is_empty(), "no file anywhere holds the secret: {:?}", holding(&d, "SENTINEL-secret"));
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_directory_swapped_after_it_was_opened_still_receives_the_write_not_the_new_name() {
        let d = scratch("swap");
        let home = d.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (h, o, moved) = (home.clone(), outside.clone(), d.join("moved"));
        let m = moved.clone();
        AFTER_DIR_OPEN.with(|s| *s.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&h, &m).unwrap();
            std::os::unix::fs::symlink(&o, &h).unwrap();
        })));
        let r = write_private(&home.join("mcp.json"), "SENTINEL-swap");
        AFTER_DIR_OPEN.with(|s| *s.borrow_mut() = None);
        r.unwrap();
        assert_eq!(std::fs::read_to_string(moved.join("mcp.json")).unwrap(), "SENTINEL-swap", "the held (moved) directory got the file");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0, "the new name's target got nothing");
        assert_eq!(mode(&outside), 0o755);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_failure_between_the_write_and_the_rename_leaves_the_target_and_no_temp() {
        let d = scratch("fail");
        let p = d.join("home/launch.json");
        write_private(&p, "before").unwrap();
        FAIL_BEFORE_RENAME.with(|f| f.set(true));
        let r = write_private(&p, "SENTINEL-after");
        FAIL_BEFORE_RENAME.with(|f| f.set(false));
        assert!(r.is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "before");
        assert!(holding(&d, "SENTINEL-after").is_empty(), "the temp is gone");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_managed_home_is_walked_from_the_project_root_and_closed() {
        let d = scratch("home");
        let ws = d.join("ws");
        let home = ws.join(".tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        for p in [ws.join(".tmm"), ws.join(".tmm/agents"), home.clone()] {
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        private_home(&home).unwrap();
        assert_eq!((mode(&ws.join(".tmm")), mode(&ws.join(".tmm/agents")), mode(&home)), (0o755, 0o700, 0o700), ".tmm keeps its mode; agents and the home close");
        // `.tmm` as a link to an outside directory: refused, nothing chmodded through it.
        let ws2 = d.join("ws2");
        let outside = d.join("outside");
        std::fs::create_dir_all(outside.join("agents/dev")).unwrap();
        std::fs::set_permissions(outside.join("agents"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::create_dir_all(&ws2).unwrap();
        std::os::unix::fs::symlink(&outside, ws2.join(".tmm")).unwrap();
        assert!(private_home(&ws2.join(".tmm/agents/dev")).is_err());
        assert_eq!(mode(&outside.join("agents")), 0o755);
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_name_is_one_plain_component() {
        for bad in ["", ".", "..", "a/b", "a\0b"] {
            assert!(!plain_name(bad), "{bad:?}");
        }
        assert!(plain_name("tmm-agent.config.toml") && plain_name(".launch.json.tmp-x"));
    }
}

// ---- private SQLite files (board #448 D3) -------------------------------------

/// The trust rule for a directory a database lives under (pure, so a test
/// can inject a uid). The DIRECT parent: a directory owned by `euid` with
/// neither group nor other write. An ANCESTOR above it: owned by root or
/// `euid` (always required), AND either no group/other write or the sticky
/// bit. Sticky relaxes only the write bit under a trusted owner: the owner
/// of a sticky directory may still rename anyone's entries, so a 1777
/// directory of another uid is refused.
pub(crate) fn trusted(uid: u32, mode: u32, euid: u32, parent: bool) -> bool {
    let wide = mode & 0o022 != 0;
    if parent {
        return uid == euid && !wide;
    }
    (uid == 0 || uid == euid) && (!wide || mode & libc::S_ISVTX as u32 != 0)
}

/// The SQLite file names that belong to a database called `leaf`.
pub(crate) fn sqlite_siblings(leaf: &str) -> [String; 3] {
    [format!("{leaf}-wal"), format!("{leaf}-shm"), format!("{leaf}-journal")]
}

/// Make the database at `path` private BEFORE SQLite opens it, and answer
/// the path SQLite must open:
/// - only the PARENT prefix is canonicalized (a legitimate HOME alias); the
///   leaf keeps its name and is never resolved;
/// - `own_dir` (the app's own config directory): the parent is created and
///   made 0700 through its handle. Otherwise (a custom TMM_STATE_DB/TEAM_DB)
///   the parent is only checked;
/// - the parent and every ancestor must pass `trusted`, or the store is
///   REFUSED: SQLite opens by pathname and makes its sidecars by pathname,
///   which no handle can bind, so the chain must be one no other user can
///   change;
/// - the leaf, through the parent's handle: absent → created empty with
///   O_CREAT|O_EXCL at 0600 (SQLite's first write lands in a 0600 file, and
///   its WAL/SHM/journal take the main file's mode); a regular file of ours
///   → `fchmod` 0600; a link or anything else → refused, nothing touched.
///   Each existing `-wal`/`-shm`/`-journal` gets the same check;
/// - the answer is `<canonical parent>/<leaf>`, the verified pair.
pub(crate) fn private_db(path: &Path, own_dir: bool) -> io::Result<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let leaf = path.file_name().and_then(|n| n.to_str()).filter(|n| plain_name(n)).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    if own_dir {
        private_dir(parent)?;
    } else {
        std::fs::create_dir_all(parent)?;
    }
    let (canonical, dir) = trusted_parent(parent)?;
    if dir.stat_at(leaf)?.is_none() {
        // New: created empty at exactly 0600, so SQLite's first write lands
        // in a private file (an O_EXCL race loser falls through to the check).
        match dir.open_file(leaf, libc::O_CREAT | libc::O_EXCL | libc::O_RDWR, 0o600) {
            Ok(f) => f.set_permissions(std::fs::Permissions::from_mode(0o600))?,
            Err(e) if e.raw_os_error() == Some(libc::EEXIST) => {}
            Err(e) => return Err(e),
        }
    }
    fix_mode(&dir, leaf)?;
    for s in sqlite_siblings(leaf) {
        fix_mode(&dir, &s)?;
    }
    Ok(canonical.join(leaf))
}

/// `parent`, canonicalized (the prefix only) and held, IF it passes the trust
/// rule with every ancestor (see `trusted`); otherwise refused.
fn trusted_parent(parent: &Path) -> io::Result<(std::path::PathBuf, Dir)> {
    use std::os::unix::fs::MetadataExt;
    let canonical = std::fs::canonicalize(parent)?;
    let dir = Dir::open(&canonical)?;
    let st = dir.stat()?;
    let me = euid();
    if !is_dir(&st) || !trusted(st.st_uid, st.st_mode as u32, me, true) {
        return Err(denied(format!("the directory {} is not this user's own, or other users can write to it; choose a private directory", canonical.display())));
    }
    for a in canonical.ancestors().skip(1) {
        let m = std::fs::metadata(a)?;
        if !trusted(m.uid(), m.mode(), me, false) {
            return Err(denied(format!("{} (above {}) can be changed by another user; choose a private directory", a.display(), canonical.display())));
        }
    }
    Ok((canonical, dir))
}

/// Tighten an EXISTING database and its siblings in place (the legacy
/// team.db, which is only read): the parent must pass the same trust rule as
/// `private_db` (otherwise an error: NOT tightened, nothing touched), and
/// each existing file is verified on its opened fd (`fix_mode`). A missing
/// directory or file is nothing to do.
pub(crate) fn tighten_db(path: &Path) -> io::Result<()> {
    let leaf = path.file_name().and_then(|n| n.to_str()).filter(|n| plain_name(n)).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))?;
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    // Only NotFound is absent; an orphan sidecar is tightened even when the
    // main file is gone (P2).
    if !dir_present(Some(parent))? {
        return Ok(());
    }
    let (_, dir) = trusted_parent(parent)?;
    fix_mode(&dir, leaf)?;
    for s in sqlite_siblings(leaf) {
        fix_mode(&dir, &s)?;
    }
    Ok(())
}

#[cfg(test)]
mod db_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o7777
    }
    fn scratch(tag: &str, m: u32) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tmm-safedb-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(m)).unwrap();
        d
    }

    #[test]
    fn the_trust_rule_never_lets_sticky_excuse_a_foreign_owner() {
        let (me, other) = (1000, 2000);
        // Ancestors.
        assert!(trusted(0, 0o040755, me, false), "root, not writable");
        assert!(trusted(0, 0o041777, me, false), "root + sticky (/tmp)");
        assert!(trusted(me, 0o040755, me, false), "ours, not writable");
        assert!(!trusted(other, 0o041777, me, false), "another uid's sticky directory can rename our entries");
        assert!(!trusted(other, 0o040755, me, false), "another uid's directory");
        assert!(!trusted(0, 0o040775, me, false), "root, group-writable, no sticky");
        // The direct parent: ours and not writable, no sticky exception.
        assert!(trusted(me, 0o040700, me, true) && trusted(me, 0o040755, me, true));
        assert!(!trusted(me, 0o041777, me, true), "ours + sticky + world-writable: refused as the parent");
        assert!(!trusted(other, 0o040700, me, true), "a foreign parent");
        assert!(!trusted(0, 0o040755, me, true), "root's directory is not ours to keep a database in");
    }

    #[test]
    fn a_new_store_is_0600_before_sqlites_first_write_and_its_sidecars_follow_it() {
        let d = scratch("new", 0o755);
        let db = d.join("state.db");
        let opened = with_umask(0o022, || private_db(&db, false)).unwrap();
        assert_eq!((std::fs::metadata(&opened).unwrap().len(), mode(&opened)), (0, 0o600), "an empty 0600 file before SQLite opens it");
        assert_eq!(mode(&d), 0o755, "a custom parent of ours is checked, never chmodded");
        // The bundled SQLite (rusqlite) under umask 022: WAL and SHM take the main file's mode,
        // also when they are re-created after a checkpoint and a reopen.
        let c = rusqlite::Connection::open(&opened).unwrap();
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES (1);").unwrap();
        assert_eq!((mode(&d.join("state.db-wal")), mode(&d.join("state.db-shm"))), (0o600, 0o600));
        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").unwrap();
        drop(c);
        for s in ["state.db-wal", "state.db-shm"] { let _ = std::fs::remove_file(d.join(s)); }
        let c = rusqlite::Connection::open(&opened).unwrap();
        c.execute_batch("INSERT INTO t VALUES (2);").unwrap();
        assert_eq!((mode(&d.join("state.db-wal")), mode(&d.join("state.db-shm"))), (0o600, 0o600), "re-created");
        drop(c);
        std::fs::remove_dir_all(&d).ok();
    }

    fn with_umask<T>(m: libc::mode_t, f: impl FnOnce() -> T) -> T {
        let old = unsafe { libc::umask(m) };
        let r = f();
        unsafe { libc::umask(old) };
        r
    }

    #[test]
    fn an_old_wide_store_and_its_wal_close_before_the_open() {
        let d = scratch("old", 0o755);
        for (name, body) in [("state.db", "x"), ("state.db-wal", "w")] {
            std::fs::write(d.join(name), body).unwrap();
            std::fs::set_permissions(d.join(name), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        private_db(&d.join("state.db"), false).unwrap();
        assert_eq!((mode(&d.join("state.db")), mode(&d.join("state.db-wal"))), (0o600, 0o600));
        assert_eq!(std::fs::read_to_string(d.join("state.db")).unwrap(), "x", "content kept");
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn a_shared_writable_parent_is_refused_and_nothing_is_created_in_it() {
        let d = scratch("shared", 0o777);
        let err = private_db(&d.join("state.db"), false).unwrap_err();
        assert!(err.to_string().contains("choose a private directory"), "{err}");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 0, "nothing created");
        assert_eq!(mode(&d), 0o777, "a shared parent is never chmodded");
        // An ancestor that another user could change (group-writable, no sticky).
        let top = scratch("anc", 0o775);
        let inner = top.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::set_permissions(&inner, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(private_db(&inner.join("state.db"), false).is_err());
        assert!(!inner.join("state.db").exists());
        // Our private parent under a root-owned sticky /tmp is accepted
        // (every other private_db test here lives there).
        let ok = scratch("ok", 0o700);
        assert!(private_db(&ok.join("state.db"), false).is_ok());
        std::fs::remove_dir_all(&ok).ok();
        std::fs::remove_dir_all(&d).ok();
        std::fs::remove_dir_all(&top).ok();
    }

    #[test]
    fn a_linked_store_or_wal_is_refused_and_its_target_untouched_through_the_full_open() {
        let d = scratch("links", 0o700);
        let outside = scratch("outside", 0o755);
        let target = outside.join("real.db");
        std::fs::write(&target, "the user's").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(&target, d.join("state.db")).unwrap();
        let err = crate::projects::store::Store::open(&d.join("state.db")).err().expect("a linked state.db is refused");
        assert!(err.contains("is a link") || err.contains("not a regular file"), "{err}");
        assert_eq!((std::fs::read_to_string(&target).unwrap().as_str(), mode(&target)), ("the user's", 0o644));
        // A linked -wal beside a real database.
        let d2 = scratch("walink", 0o700);
        std::fs::write(d2.join("state.db"), "").unwrap();
        std::os::unix::fs::symlink(&target, d2.join("state.db-wal")).unwrap();
        assert!(crate::projects::store::Store::open(&d2.join("state.db")).is_err());
        assert_eq!(mode(&target), 0o644);
        for p in [&d, &d2, &outside] { std::fs::remove_dir_all(p).ok(); }
    }

    #[test]
    fn an_alias_parent_opens_at_its_canonical_path_and_a_bad_leaf_is_refused() {
        let d = scratch("alias", 0o700);
        let real = d.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::os::unix::fs::symlink(&real, d.join("alias")).unwrap();
        let opened = private_db(&d.join("alias/state.db"), false).unwrap();
        assert_eq!(opened, real.canonicalize().unwrap().join("state.db"), "the HOME-style alias resolves; the leaf keeps its name");
        assert!(crate::projects::store::Store::open(&d.join("alias/state.db")).is_ok());
        for bad in ["..", "."] {
            assert!(private_db(&d.join(bad), false).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn the_legacy_team_db_closes_in_place_and_a_link_is_left_as_it_is() {
        let d = scratch("team", 0o755);
        for name in ["team.db", "team.db-wal"] {
            std::fs::write(d.join(name), "t").unwrap();
            std::fs::set_permissions(d.join(name), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        tighten_db(&d.join("team.db")).unwrap();
        assert_eq!((mode(&d.join("team.db")), mode(&d.join("team.db-wal"))), (0o600, 0o600));
        assert!(tighten_db(&d.join("absent/team.db")).is_ok(), "nothing there is nothing to do");
        let outside = scratch("team-out", 0o755);
        std::fs::write(outside.join("real"), "x").unwrap();
        std::fs::set_permissions(outside.join("real"), std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::remove_file(d.join("team.db-wal")).unwrap();
        std::os::unix::fs::symlink(outside.join("real"), d.join("team.db-wal")).unwrap();
        assert!(tighten_db(&d.join("team.db")).is_err(), "a link is an error");
        assert_eq!(mode(&outside.join("real")), 0o644, "and its target is untouched");
        std::fs::remove_dir_all(&outside).ok();
        std::fs::remove_dir_all(&d).ok();
    }
}

#[cfg(test)]
mod walk_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o7777
    }
    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tmm-walk-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Board #448 P1-A: a same-uid link INSIDE a managed home (home/dsh ->
    /// an outside directory holding profiles/tmm) is refused on the nested
    /// write; nothing below the entry is resolved again.
    #[test]
    fn a_link_inside_a_home_is_refused_on_a_nested_write_and_the_outside_is_untouched() {
        let d = scratch("nested");
        let home = d.join("ws/.tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        let outside = d.join("outside");
        std::fs::create_dir_all(outside.join("profiles/tmm")).unwrap();
        std::fs::set_permissions(outside.join("profiles/tmm"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("dsh")).unwrap();
        let err = write_private(&home.join("dsh/profiles/tmm/cordis.patch.yml"), "SENTINEL-nested").unwrap_err();
        assert!(!err.is_empty());
        assert_eq!(std::fs::read_dir(outside.join("profiles/tmm")).unwrap().count(), 0, "nothing published outside");
        assert_eq!(mode(&outside.join("profiles/tmm")), 0o755, "nothing chmodded outside");
        assert!(remove_private(&home.join("dsh/profiles/tmm/cordis.patch.yml")).is_err(), "an owned unlink walks the same way");
        // A link at `.tmm/agents` itself is refused the same way.
        let ws2 = d.join("ws2");
        std::fs::create_dir_all(ws2.join(".tmm")).unwrap();
        std::fs::create_dir_all(outside.join("agents/dev")).unwrap();
        std::os::unix::fs::symlink(outside.join("agents"), ws2.join(".tmm/agents")).unwrap();
        assert!(write_private(&ws2.join(".tmm/agents/dev/launch.json"), "SENTINEL-agents").is_err());
        assert!(!outside.join("agents/dev/launch.json").exists());
        std::fs::remove_dir_all(&d).ok();
    }

    /// P1-A: the home checked, then its NAME swapped for a link to an
    /// outside sentinel directory: the write lands in the held object.
    #[test]
    fn a_home_renamed_after_the_walk_still_receives_the_write_not_the_link() {
        let d = scratch("rename");
        let home = d.join("ws/.tmm/agents/dev");
        std::fs::create_dir_all(&home).unwrap();
        let outside = d.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
        let (h, o, m) = (home.clone(), outside.clone(), d.join("ws/.tmm/agents/moved"));
        let moved = m.clone();
        AFTER_DIR_OPEN.with(|s| *s.borrow_mut() = Some(Box::new(move || {
            std::fs::rename(&h, &m).unwrap();
            std::os::unix::fs::symlink(&o, &h).unwrap();
        })));
        let r = write_private(&home.join("launch.json"), "SENTINEL-rename");
        AFTER_DIR_OPEN.with(|s| *s.borrow_mut() = None);
        r.unwrap();
        assert_eq!(std::fs::read_to_string(moved.join("launch.json")).unwrap(), "SENTINEL-rename");
        assert_eq!((std::fs::read_dir(&outside).unwrap().count(), mode(&outside)), (0, 0o755));
        std::fs::remove_dir_all(&d).ok();
    }

    /// P1-D: an existing file is verified on its OPENED fd: a FIFO swapped in
    /// cannot block (O_NONBLOCK) and is refused; a link is refused.
    #[test]
    fn a_fifo_or_link_in_place_of_a_file_is_refused_without_blocking() {
        let d = scratch("fifo");
        let dir = Dir::open(&d).unwrap();
        let fifo = std::ffi::CString::new(d.join("state.db-wal").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        let started = std::time::Instant::now();
        assert!(fix_mode(&dir, "state.db-wal").is_err(), "not a regular file");
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "it did not block on the FIFO");
        std::fs::write(d.join("real"), "x").unwrap();
        std::fs::set_permissions(d.join("real"), std::fs::Permissions::from_mode(0o644)).unwrap();
        std::os::unix::fs::symlink(d.join("real"), d.join("linked")).unwrap();
        assert!(fix_mode(&dir, "linked").is_err());
        assert_eq!(mode(&d.join("real")), 0o644, "the link's target is untouched");
        std::fs::remove_dir_all(&d).ok();
    }

    /// P1-D: the legacy team.db gets the same trust rule as the store: in a
    /// directory others can write it is NOT tightened, and nothing changes.
    #[test]
    fn a_legacy_db_in_a_shared_directory_is_left_and_reported() {
        let d = scratch("legacy");
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o777)).unwrap();
        std::fs::write(d.join("team.db"), "t").unwrap();
        std::fs::set_permissions(d.join("team.db"), std::fs::Permissions::from_mode(0o644)).unwrap();
        let err = tighten_db(&d.join("team.db")).unwrap_err();
        assert!(err.to_string().contains("choose a private directory"), "{err}");
        assert_eq!(mode(&d.join("team.db")), 0o644);
        std::fs::remove_dir_all(&d).ok();
    }

    /// P1-C: an owned file closes in place, content untouched.
    #[test]
    fn an_owned_file_tightens_in_place() {
        let d = scratch("owned");
        let p = d.join("ws/.tmm/mcp.json");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{\"mcpServers\":{}}").unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
        tighten_file(&p).unwrap();
        assert_eq!((mode(&p), std::fs::read_to_string(&p).unwrap().as_str()), (0o600, "{\"mcpServers\":{}}"));
        std::fs::remove_dir_all(&d).ok();
    }

    /// A2: a `.tmm` other users can write is closed (ours, so tightened to
    /// no group/other write) before anything is published in it; and a held
    /// directory that is still writable by others is never published into.
    #[test]
    fn a_writable_tmm_is_closed_first_and_a_writable_dir_is_never_published_into() {
        let d = scratch("tmm777");
        let tmm = d.join("ws/.tmm");
        std::fs::create_dir_all(&tmm).unwrap();
        std::fs::set_permissions(&tmm, std::fs::Permissions::from_mode(0o777)).unwrap();
        write_private(&tmm.join("mcp.json"), "{}").unwrap();
        assert_eq!((mode(&tmm), mode(&tmm.join("mcp.json"))), (0o755, 0o600), ".tmm keeps its mode minus group/other write");
        let open = d.join("open");
        std::fs::create_dir_all(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        let held = Dir::open(&open).unwrap();
        assert!(publish(&held, "x.json", b"SENTINEL").is_err());
        assert_eq!(std::fs::read_dir(&open).unwrap().count(), 0, "no temp name was ever created in it");
        std::fs::remove_dir_all(&d).ok();
    }

    /// P2: an orphan sidecar (the main file gone) is still closed; a parent
    /// that cannot be audited is an error, never "absent".
    #[test]
    fn an_orphan_sidecar_closes_and_an_unauditable_parent_is_an_error() {
        let d = scratch("orphan");
        std::fs::write(d.join("team.db-wal"), "w").unwrap();
        std::fs::set_permissions(d.join("team.db-wal"), std::fs::Permissions::from_mode(0o644)).unwrap();
        tighten_db(&d.join("team.db")).unwrap();
        assert_eq!(mode(&d.join("team.db-wal")), 0o600);
        if unsafe { libc::geteuid() } != 0 {
            let locked = d.join("locked");
            std::fs::create_dir_all(locked.join("inner/.tmm")).unwrap();
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
            let r1 = tighten_db(&locked.join("inner/team.db"));
            let r2 = tighten_file(&locked.join("inner/.tmm/mcp.json"));
            let r3 = remove_private(&locked.join("inner/.tmm/mcp.json"));
            std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).unwrap();
            assert!(r1.is_err() && r2.is_err() && r3.is_err(), "{r1:?} {r2:?} {r3:?}");
        }
        std::fs::remove_dir_all(&d).ok();
    }
}
