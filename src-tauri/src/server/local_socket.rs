//! The gateway's LOCAL door (board #440): a Unix socket in a private
//! directory of the operator's config dir, for this host's own `tmm`.
//!
//! Why: the TCP lockout is keyed by source IP, and on this host 127.0.0.1 is
//! everyone at once — every agent's tmm, the Vite proxy and the reverse SSH
//! tunnel the internet arrives through. Five bad tokens from any of them
//! locked the whole team out for a minute (validator rig, 2026-10-20 14:52).
//! A socket that only the operator's uid can open is "local" as a checked
//! fact, so it carries no lockout: a process that can open it can read the
//! config.toml beside it anyway. It speaks the same WebSocket JSON-RPC with
//! the same token auth; the TCP listener and its lockout are unchanged.
//!
//! Ownership, start to exit (design delta 1, its table): every step works
//! from an O_DIRECTORY handle of `<config>/sock/`, and any failure leaves the
//! gateway TCP-only with the reason said — never a wider socket.
#![cfg(all(unix, not(any(target_os = "android", target_os = "ios"))))]

use std::ffi::CString;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub(super) const DIR: &str = "sock";
pub(super) const NODE: &str = "gateway.sock";
const LOCK: &str = "gateway.lock";

/// A bound, claimed local socket. Dropping it removes the node it bound
/// (only that node), then releases the claim.
pub(super) struct LocalSocket {
    pub(super) path: PathBuf,
    pub(super) listener: std::os::unix::net::UnixListener,
    dir: File,
    node: (u64, u64),
    _lock: File,
}

/// `<config>/sock/gateway.sock`: where this config's gateway binds its local
/// socket, and where a tmm with no recipe looks for it.
pub fn path_in(config_dir: &Path) -> PathBuf {
    config_dir.join(DIR).join(NODE)
}

fn errno() -> std::io::Error { std::io::Error::last_os_error() }

fn stat_at(dir: &File, name: &str) -> std::io::Result<libc::stat> {
    let c = CString::new(name).unwrap();
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 { return Err(errno()); }
    Ok(st)
}

fn is_type(st: &libc::stat, kind: libc::mode_t) -> bool { st.st_mode & libc::S_IFMT == kind }

/// The private directory: created 0700 if absent, then opened without
/// following a symlink and checked — a directory, ours, exactly 0700.
fn open_dir(config_dir: &Path) -> Result<File, String> {
    use std::os::unix::fs::DirBuilderExt;
    let path = config_dir.join(DIR);
    match std::fs::DirBuilder::new().mode(0o700).create(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let c = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| "a NUL in the config path".to_string())?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(format!("{}: {}", path.display(), errno())); }
    let dir = unsafe { File::from_raw_fd(fd) };
    let m = dir.metadata().map_err(|e| e.to_string())?;
    if !m.is_dir() || m.uid() != unsafe { libc::geteuid() } || m.mode() & 0o777 != 0o700 {
        return Err(format!("{} is not a directory of ours with mode 0700 (mode {:o}, uid {})", path.display(), m.mode() & 0o777, m.uid()));
    }
    Ok(dir)
}

/// The claim: an flock on `sock/gateway.lock`, opened without following a
/// symlink and checked to be our own regular file, held for the gateway's
/// life. Another live gateway holding it means this one does not touch the
/// socket at all.
fn claim(dir: &File) -> Result<File, String> {
    let c = CString::new(LOCK).unwrap();
    let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if fd < 0 { return Err(format!("{LOCK}: {}", errno())); }
    let lock = unsafe { File::from_raw_fd(fd) };
    let m = lock.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() || m.uid() != unsafe { libc::geteuid() } {
        return Err(format!("{LOCK} is not a regular file of ours"));
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(format!("another gateway holds {LOCK} ({})", errno()));
    }
    Ok(lock)
}

/// What a liveness probe of an existing socket found (review P1-A).
#[derive(Debug, PartialEq)]
enum Probe { Live, Refused, Unknown(String) }

/// One NONBLOCKING connect: it never waits, so a listener that stopped
/// accepting with a full backlog cannot hold the gateway's start (the TCP
/// accept loop and `ready` come after this). What its answer proves differs
/// by OS (`reclaimable`): ECONNREFUSED means "no listener" on Linux, but on
/// macOS (XNU) a full backlog answers ECONNREFUSED too (review, 18:45).
fn probe(path: &Path) -> Probe {
    use socket2::{Domain, SockAddr, Socket, Type};
    let sock = match Socket::new(Domain::UNIX, Type::STREAM, None) {
        Ok(s) => s,
        Err(e) => return Probe::Unknown(e.to_string()),
    };
    if let Err(e) = sock.set_nonblocking(true) { return Probe::Unknown(e.to_string()); }
    let addr = match SockAddr::unix(path) {
        Ok(a) => a,
        Err(e) => return Probe::Unknown(e.to_string()),
    };
    match sock.connect(&addr) {
        Ok(()) => Probe::Live,
        Err(e) if e.raw_os_error() == Some(libc::ECONNREFUSED) => Probe::Refused,
        Err(e) => Probe::Unknown(e.to_string()),
    }
}

/// Whether an existing socket of ours may be removed, given that THIS gateway
/// holds the claim (so no live gateway of this config serves anything here).
/// The claim is the cross-platform liveness fact (orchestrator ruling,
/// 18:45); `recorded` says the node is the one the previous claim holder
/// bound (it writes the (dev, ino) into the lock file). Per OS:
///
/// | probe     | recorded node      | not recorded                        |
/// |-----------|--------------------|-------------------------------------|
/// | connects  | keep               | keep                                |
/// | refused   | reclaim            | Linux: reclaim (no listener, proven) |
/// |           |                    | macOS/other: keep (may be a full backlog) |
/// | other     | keep               | keep                                |
///
/// So a node a gateway left when it was killed is reclaimed everywhere, and a
/// listener that is not a gateway's is never removed on a full backlog.
fn reclaimable(linux: bool, recorded: bool, probe: &Probe) -> bool {
    matches!(probe, Probe::Refused) && (recorded || linux)
}

/// The (dev, ino) the previous claim holder recorded in the lock file.
fn recorded_node(lock: &File) -> Option<(u64, u64)> {
    use std::io::{Read, Seek};
    let mut text = String::new();
    let mut f = lock;
    f.seek(std::io::SeekFrom::Start(0)).ok()?;
    f.read_to_string(&mut text).ok()?;
    let mut it = text.split_whitespace().map(|n| n.parse::<u64>().ok());
    Some((it.next()??, it.next()??))
}

/// Record the node this claim holder bound, for the next holder's decision.
fn record_node(lock: &File, node: (u64, u64)) -> std::io::Result<()> {
    use std::io::{Seek, Write};
    let mut f = lock;
    f.set_len(0)?;
    f.seek(std::io::SeekFrom::Start(0))?;
    f.write_all(format!("{} {}\n", node.0, node.1).as_bytes())
}

/// A fault injected right after bind, for the cleanup test (review P2).
#[cfg(test)]
static AFTER_BIND: std::sync::Mutex<Option<fn(&Path)>> = std::sync::Mutex::new(None);

/// Bind this config's local socket, or say why not.
pub(super) fn open(config_dir: &Path) -> Result<LocalSocket, String> {
    let dir = open_dir(config_dir)?;
    let lock = claim(&dir)?;
    let me = unsafe { libc::geteuid() };
    let dir_path = config_dir.join(DIR);
    let path = dir_path.join(NODE);
    // sun_path: 108 bytes on Linux, 104 on macOS, the NUL included.
    let max = if cfg!(target_os = "macos") { 103 } else { 107 };
    if path.as_os_str().len() > max { return Err(format!("{} is longer than a socket path may be", path.display())); }
    // The pathname must still name the directory we hold (bind is a pathname
    // interface): checked before and after bind.
    let held = dir.metadata().map_err(|e| e.to_string())?;
    let names_held = || std::fs::symlink_metadata(&dir_path).is_ok_and(|m| m.dev() == held.dev() && m.ino() == held.ino());
    if !names_held() { return Err(format!("{} no longer names the directory opened", dir_path.display())); }
    match stat_at(&dir, NODE) {
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
        Ok(st) if is_type(&st, libc::S_IFSOCK) && st.st_uid == me => {
            // A socket of ours, while WE hold the claim: see `reclaimable`.
            let recorded = recorded_node(&lock) == Some((st.st_dev as u64, st.st_ino as u64));
            match probe(&path) {
                p if reclaimable(cfg!(target_os = "linux"), recorded, &p) => {
                    let c = CString::new(NODE).unwrap();
                    if unsafe { libc::unlinkat(dir.as_raw_fd(), c.as_ptr(), 0) } != 0 { return Err(format!("{}: {}", path.display(), errno())); }
                }
                Probe::Live => return Err(format!("{} answers: another process listens there", path.display())),
                Probe::Refused => return Err(format!("{} refuses, but on this OS that may be a full backlog and no gateway recorded it: left untouched", path.display())),
                Probe::Unknown(why) => return Err(format!("{} cannot be told dead ({why}): left untouched", path.display())),
            }
        }
        Ok(_) => return Err(format!("{} exists and is not a socket of ours: left untouched", path.display())),
    }
    let listener = std::os::unix::net::UnixListener::bind(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    // From here the node is ours: the guard is built at once, so any later
    // failure drops it and removes THIS node (by its (dev, ino)), not one a
    // replacer bound later, with the claim still held.
    let bound = stat_at(&dir, NODE).map_err(|e| format!("{}: {e}", path.display()))?;
    let socket = LocalSocket { path, listener, dir, node: (bound.st_dev as u64, bound.st_ino as u64), _lock: lock };
    #[cfg(test)]
    if let Some(fault) = AFTER_BIND.lock().unwrap().take() {
        fault(&socket.path);
        return Err("a fault injected after bind".into());
    }
    let c = CString::new(NODE).unwrap();
    if unsafe { libc::fchmodat(socket.dir.as_raw_fd(), c.as_ptr(), 0o600, 0) } != 0 { return Err(format!("{}: {}", socket.path.display(), errno())); }
    let st = stat_at(&socket.dir, NODE).map_err(|e| format!("{}: {e}", socket.path.display()))?;
    if !names_held() || !is_type(&st, libc::S_IFSOCK) || st.st_uid != me || st.st_mode & 0o777 != 0o600
        || (st.st_dev as u64, st.st_ino as u64) != socket.node {
        return Err(format!("{} is not the 0600 socket just bound", socket.path.display()));
    }
    socket.listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    // For the next claim holder: this node is a gateway's.
    record_node(&socket._lock, socket.node).map_err(|e| format!("{LOCK}: {e}"))?;
    Ok(socket)
}

impl Drop for LocalSocket {
    fn drop(&mut self) {
        // Only the node this instance bound: a node someone bound later is
        // left alone. The claim is released after (the field drops last).
        if let Ok(st) = stat_at(&self.dir, NODE) {
            if (st.st_dev as u64, st.st_ino as u64) == self.node {
                let c = CString::new(NODE).unwrap();
                unsafe { libc::unlinkat(self.dir.as_raw_fd(), c.as_ptr(), 0) };
            }
        }
    }
}

/// The uid on the other end of a connected local socket (SO_PEERCRED on
/// Linux, getpeereid on macOS).
pub fn peer_uid(stream: &impl AsRawFd) -> std::io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let r = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
        if r != 0 { return Err(errno()); }
        Ok(cred.uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut uid, mut gid) = (0 as libc::uid_t, 0 as libc::gid_t);
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 { return Err(errno()); }
        Ok(uid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn config_dir(tag: &str) -> PathBuf {
        // Short: a socket path is limited to ~104 bytes.
        let d = PathBuf::from(format!("/tmp/t440-{tag}-{}", &uuid::Uuid::new_v4().to_string()[..8]));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn mode(p: &Path) -> u32 { std::fs::symlink_metadata(p).unwrap().mode() & 0o777 }
    fn ident(p: &Path) -> (u64, u64) { let m = std::fs::symlink_metadata(p).unwrap(); (m.dev(), m.ino()) }

    #[test]
    fn it_binds_a_0600_socket_in_a_private_0700_dir_and_removes_only_its_own_node() {
        let cfg = config_dir("own");
        let s = open(&cfg).unwrap();
        assert_eq!(s.path, path_in(&cfg));
        assert_eq!(mode(&cfg.join(DIR)), 0o700);
        assert_eq!(mode(&s.path), 0o600);
        assert!(std::fs::symlink_metadata(&s.path).unwrap().file_type().is_socket_like());
        let lock = std::fs::symlink_metadata(cfg.join(DIR).join(LOCK)).unwrap();
        assert!(lock.is_file());
        drop(s);
        assert!(std::fs::symlink_metadata(path_in(&cfg)).is_err(), "its own node is removed at drop");
        // A node someone bound after us is left at our drop.
        let s = open(&cfg).unwrap();
        std::fs::remove_file(&s.path).unwrap();
        let theirs = std::os::unix::net::UnixListener::bind(path_in(&cfg)).unwrap();
        let theirs_id = ident(&path_in(&cfg));
        drop(s);
        assert_eq!(ident(&path_in(&cfg)), theirs_id, "a later node is not ours to remove");
        drop(theirs);
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn a_second_gateway_on_the_same_dir_leaves_the_first_alone() {
        let cfg = config_dir("two");
        let first = open(&cfg).unwrap();
        let before = ident(&first.path);
        let err = open(&cfg).err().unwrap();
        assert!(err.contains("another gateway holds"), "{err}");
        assert_eq!(ident(&first.path), before, "the first one's socket is untouched");
        assert!(std::os::unix::net::UnixStream::connect(&first.path).is_ok(), "and still answers");
        drop(first);
        let _ = std::fs::remove_dir_all(&cfg);
    }

    /// On Linux an UNRECORDED dead socket is reclaimed too (refused is proof);
    /// the macOS row of that case is in `the_reclaim_decision_follows_the_per_os_table`.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_dead_socket_is_reclaimed_a_live_one_or_a_foreign_node_never_is() {
        let cfg = config_dir("stale");
        std::fs::create_dir(cfg.join(DIR)).unwrap();
        std::fs::set_permissions(cfg.join(DIR), std::fs::Permissions::from_mode(0o700)).unwrap();
        // Dead: bound, then the listener closed without unlinking (a killed gateway).
        drop(std::os::unix::net::UnixListener::bind(path_in(&cfg)).unwrap());
        let dead = ident(&path_in(&cfg));
        let s = open(&cfg).unwrap();
        assert_ne!(ident(&s.path), dead, "a dead socket of ours is replaced");
        drop(s);
        // Live: something listens there, but holds no claim.
        let live = std::os::unix::net::UnixListener::bind(path_in(&cfg)).unwrap();
        let live_id = ident(&path_in(&cfg));
        let err = open(&cfg).err().unwrap();
        assert!(err.contains("answers"), "{err}");
        assert_eq!(ident(&path_in(&cfg)), live_id, "a live socket is never reclaimed");
        drop(live);
        std::fs::remove_file(path_in(&cfg)).unwrap();
        // A regular file and a symlink: refused, left as they are.
        std::fs::write(path_in(&cfg), "x").unwrap();
        assert!(open(&cfg).err().unwrap().contains("not a socket of ours"));
        assert_eq!(std::fs::read_to_string(path_in(&cfg)).unwrap(), "x");
        std::fs::remove_file(path_in(&cfg)).unwrap();
        std::os::unix::fs::symlink("/tmp", path_in(&cfg)).unwrap();
        assert!(open(&cfg).err().unwrap().contains("not a socket of ours"));
        assert!(std::fs::symlink_metadata(path_in(&cfg)).unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&cfg);
    }

    /// Review P1-A: a listener of ours that stopped accepting with its backlog
    /// full cannot hold the start. The probe never waits, the node is kept,
    /// and open() says so at once. What a full backlog answers is per OS
    /// (review P2, 19:05): EAGAIN on Linux (Unknown), ECONNREFUSED on macOS
    /// and the other unixes (XNU), where an unrecorded Refused is kept. This
    /// listener is no gateway's, so nothing recorded it. Only the Linux
    /// branch has run here; the other is written to the XNU contract and has
    /// not been run on a Mac.
    #[test]
    fn a_busy_listener_neither_blocks_the_start_nor_is_reclaimed() {
        use socket2::{Domain, SockAddr, Socket, Type};
        let cfg = config_dir("busy");
        std::fs::create_dir(cfg.join(DIR)).unwrap();
        std::fs::set_permissions(cfg.join(DIR), std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = path_in(&cfg);
        let l = Socket::new(Domain::UNIX, Type::STREAM, None).unwrap();
        l.bind(&SockAddr::unix(&path).unwrap()).unwrap();
        l.listen(0).unwrap();
        // Fill the backlog with nonblocking clients, never accepted, until a
        // connect is turned away the way this OS turns a full backlog away.
        let full = if cfg!(target_os = "linux") { libc::EAGAIN } else { libc::ECONNREFUSED };
        let mut held = Vec::new();
        loop {
            let c = Socket::new(Domain::UNIX, Type::STREAM, None).unwrap();
            c.set_nonblocking(true).unwrap();
            match c.connect(&SockAddr::unix(&path).unwrap()) {
                Ok(()) => held.push(c),
                Err(e) if e.raw_os_error() == Some(full) => break,
                Err(e) => panic!("unexpected connect error filling the backlog: {e}"),
            }
            assert!(held.len() < 64, "the backlog never filled");
        }
        let before = ident(&path);
        // Both on a thread with a budget: a probe that waited would hang for
        // ever, and the test must fail instead of hanging with it.
        let (tx, rx) = std::sync::mpsc::channel();
        let (dir, at) = (cfg.clone(), path.clone());
        std::thread::spawn(move || { let _ = tx.send((probe(&at), open(&dir).err())); });
        let (probed, err) = rx.recv_timeout(std::time::Duration::from_secs(2)).expect("the probe or open() did not return within 2 s: it waited");
        let err = err.unwrap();
        if cfg!(target_os = "linux") {
            assert_eq!(probed, Probe::Unknown(std::io::Error::from_raw_os_error(libc::EAGAIN).to_string()), "a busy listener is undetermined");
            assert!(err.contains("cannot be told dead"), "{err}");
        } else {
            assert_eq!(probed, Probe::Refused, "XNU answers a full backlog with ECONNREFUSED");
            assert!(err.contains("may be a full backlog"), "an unrecorded Refused is kept: {err}");
        }
        assert_eq!(ident(&path), before, "a busy listener's node is kept");
        drop(held);
        drop(l);
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn the_private_dir_must_be_ours_and_0700_and_is_never_widened_or_followed() {
        let cfg = config_dir("dir");
        std::fs::create_dir(cfg.join(DIR)).unwrap();
        std::fs::set_permissions(cfg.join(DIR), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(open(&cfg).err().unwrap().contains("mode 0700"));
        assert_eq!(mode(&cfg.join(DIR)), 0o755, "not chmod-ed on the operator's behalf");
        std::fs::remove_dir(cfg.join(DIR)).unwrap();
        let elsewhere = config_dir("elsewhere");
        std::os::unix::fs::symlink(&elsewhere, cfg.join(DIR)).unwrap();
        assert!(open(&cfg).is_err(), "a symlinked dir is not followed");
        assert!(std::fs::read_dir(&elsewhere).unwrap().next().is_none(), "nothing was made through it");
        let _ = std::fs::remove_dir_all(&cfg);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn a_lock_that_is_not_our_regular_file_is_refused() {
        let cfg = config_dir("lock");
        std::fs::create_dir(cfg.join(DIR)).unwrap();
        std::fs::set_permissions(cfg.join(DIR), std::fs::Permissions::from_mode(0o700)).unwrap();
        // The target lives in this test's own dir: a mutant that follows the
        // link creates it there, never in a shared place a later run reads.
        let target = cfg.join("nowhere");
        std::os::unix::fs::symlink(&target, cfg.join(DIR).join(LOCK)).unwrap();
        assert!(open(&cfg).is_err(), "a symlinked lock is not opened");
        assert!(std::fs::symlink_metadata(&target).is_err(), "and nothing was created through it");
        let _ = std::fs::remove_dir_all(&cfg);
    }

    /// Review 18:45 + ruling: ECONNREFUSED is "no listener" only on Linux;
    /// on macOS a full backlog says it too. Both OS rows of the table, on any
    /// host: the decision takes the OS as a parameter.
    #[test]
    fn the_reclaim_decision_follows_the_per_os_table() {
        let refused = Probe::Refused;
        let busy = Probe::Unknown("EAGAIN".into());
        for linux in [true, false] {
            assert!(reclaimable(linux, true, &refused), "a recorded node that refuses is reclaimed (linux={linux})");
            assert!(!reclaimable(linux, true, &Probe::Live), "a node that answers is kept");
            assert!(!reclaimable(linux, true, &busy), "an undetermined one is kept");
            assert!(!reclaimable(linux, false, &busy));
            assert!(!reclaimable(linux, false, &Probe::Live));
        }
        assert!(reclaimable(true, false, &refused), "Linux: refused is proof of no listener");
        assert!(!reclaimable(false, false, &refused), "macOS/other: refused may be a full backlog, and no gateway recorded the node");
    }

    /// The record the next claim holder decides by: the bound node's
    /// (dev, ino), written once the socket is ready.
    #[test]
    fn a_ready_socket_records_its_node_in_the_claim() {
        let cfg = config_dir("rec");
        let s = open(&cfg).unwrap();
        assert_eq!(recorded_node(&s._lock), Some(ident(&s.path)));
        drop(s);
        let _ = std::fs::remove_dir_all(&cfg);
    }

    /// Review P2: a failure after bind removes this instance's node, and
    /// leaves a node a replacer bound in between.
    #[test]
    fn a_failure_after_bind_removes_only_its_own_node() {
        let cfg = config_dir("fault");
        *AFTER_BIND.lock().unwrap() = Some(|_| {});
        let err = open(&cfg).err().unwrap();
        assert!(err.contains("injected"), "{err}");
        assert!(std::fs::symlink_metadata(path_in(&cfg)).is_err(), "its own node is removed");
        static REPLACER: std::sync::Mutex<Option<std::os::unix::net::UnixListener>> = std::sync::Mutex::new(None);
        *AFTER_BIND.lock().unwrap() = Some(|path| {
            std::fs::remove_file(path).unwrap();
            *REPLACER.lock().unwrap() = Some(std::os::unix::net::UnixListener::bind(path).unwrap());
        });
        assert!(open(&cfg).is_err());
        let theirs = REPLACER.lock().unwrap().take().unwrap();
        assert!(std::fs::symlink_metadata(path_in(&cfg)).is_ok(), "a replacer's node is left");
        assert!(std::os::unix::net::UnixStream::connect(path_in(&cfg)).is_ok(), "and still answers");
        drop(theirs);
        let _ = std::fs::remove_dir_all(&cfg);
    }

    #[test]
    fn the_peer_uid_is_read_from_the_connection() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a).unwrap(), unsafe { libc::geteuid() });
    }

    trait SocketLike { fn is_socket_like(&self) -> bool; }
    impl SocketLike for std::fs::FileType {
        fn is_socket_like(&self) -> bool { use std::os::unix::fs::FileTypeExt; self.is_socket() }
    }
}
