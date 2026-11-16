//! One exclusive `flock`, released EXPLICITLY (board #136, measured in the isolated runner).
//!
//! A flock belongs to the open file DESCRIPTION, and any thread's fork copies the whole fd
//! table: a child between fork and exec (a gateway forks tmux all the time, from the capture
//! loop and the startup-prompt waiters) keeps the description, close-on-exec or not, until
//! its execve closes it. Closing our fd therefore did not release the lock in that window,
//! and an acquire right after a release saw it held. `LOCK_UN` on drop releases it on the
//! description itself, whatever a child still references. Every try-acquired lock whose
//! release can be followed by an acquire that must succeed goes through this guard
//! (the restore owner lock, the local socket's claim).
use std::fs::File;
use std::os::unix::io::AsRawFd;

pub(crate) struct Flock {
    file: File,
}

impl Flock {
    /// `LOCK_EX | LOCK_NB` on `file`: `Ok(Some)` taken, `Ok(None)` another description holds
    /// it, `Err` for any other failure.
    pub(crate) fn try_exclusive(file: File) -> std::io::Result<Option<Flock>> {
        // SAFETY: a valid open fd; flock has no other preconditions.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(Flock { file }));
        }
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EWOULDBLOCK) { Ok(None) } else { Err(e) }
    }

    /// The locked file (its contents are the holder's: the socket claim records its node).
    pub(crate) fn file(&self) -> &File {
        &self.file
    }
}

impl Drop for Flock {
    fn drop(&mut self) {
        // SAFETY: a valid open fd; LOCK_UN has no other preconditions.
        unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// Board #136's test seam: a child process PARKED between fork and exec, so it holds a copy
/// of every fd this process had at its fork (a held lock's description included). The child
/// SAYS it exists: in pre_exec it writes one byte to a pipe, then blocks reading a second
/// one; `spawn` waits for that byte (bounded, failing loudly), and the drop opens the gate
/// and reaps the child in every path: success, an assertion failure, a timeout. No clock
/// decides anything (testing.md: a wait observes the fact the assertion reads).
#[cfg(test)]
pub(crate) mod parked_child {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;

    /// A close-on-exec pipe (validator-2 note 21: the helper builds wherever the lock does):
    /// pipe2 on Linux; pipe + fcntl(FD_CLOEXEC) on the other unixes (macOS has no pipe2).
    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut p = [0i32; 2];
        #[cfg(target_os = "linux")]
        // SAFETY: a two-int buffer.
        let ok = unsafe { libc::pipe2(p.as_mut_ptr(), libc::O_CLOEXEC) } == 0;
        #[cfg(not(target_os = "linux"))]
        // SAFETY: a two-int buffer; then each fd of it.
        let ok = unsafe {
            libc::pipe(p.as_mut_ptr()) == 0
                && libc::fcntl(p[0], libc::F_SETFD, libc::FD_CLOEXEC) == 0
                && libc::fcntl(p[1], libc::F_SETFD, libc::FD_CLOEXEC) == 0
        };
        assert!(ok, "pipe: {}", std::io::Error::last_os_error());
        // SAFETY: both fds were just created and are owned here alone.
        unsafe { (OwnedFd::from_raw_fd(p[0]), OwnedFd::from_raw_fd(p[1])) }
    }

    pub(crate) struct ParkedChild {
        pid: libc::pid_t,
        release: OwnedFd,
        spawner: Option<std::thread::JoinHandle<std::io::Result<std::process::ExitStatus>>>,
    }

    impl ParkedChild {
        /// Fork a child from another thread and return once the CHILD has said it is forked
        /// and parked (it sends its pid; 10 s bound).
        pub(crate) fn spawn() -> ParkedChild {
            let (ready_r, ready_w) = pipe();
            let (release_r, release_w) = pipe();
            let (rw, rr) = (ready_w.as_raw_fd(), release_r.as_raw_fd());
            let spawner = std::thread::spawn(move || {
                let _child_ends = (ready_w, release_r); // open in this process until the child is reaped
                let mut cmd = std::process::Command::new("/bin/true");
                // SAFETY: only getpid, write, read and errno, async-signal-safe, between fork
                // and exec.
                unsafe {
                    cmd.pre_exec(move || {
                        let interrupted = || std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR);
                        let pid = libc::getpid().to_ne_bytes();
                        loop {
                            match libc::write(rw, pid.as_ptr().cast(), pid.len()) {
                                n if n == pid.len() as isize => break,
                                -1 if interrupted() => continue,
                                _ => return Err(std::io::Error::last_os_error()),
                            }
                        }
                        // The gate is a real hold (validator-2 note 21): a signal interrupts the
                        // read with EINTR and the child waits again; only a byte, or EOF (the
                        // test process gone), releases it. Any other error ends the child
                        // WITHOUT exec.
                        let mut gate = 0u8;
                        loop {
                            match libc::read(rr, (&mut gate as *mut u8).cast(), 1) {
                                0 | 1 => return Ok(()),
                                -1 if interrupted() => continue,
                                _ => return Err(std::io::Error::last_os_error()),
                            }
                        }
                    });
                }
                cmd.status()
            });
            let mut child = ParkedChild { pid: 0, release: release_w, spawner: Some(spawner) };
            let mut ready = libc::pollfd { fd: ready_r.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            let n = unsafe { libc::poll(&mut ready, 1, 10_000) };
            assert_eq!(n, 1, "the child never said it was forked and parked within 10 s");
            let mut pid = [0u8; std::mem::size_of::<libc::pid_t>()];
            // SAFETY: a valid fd and a buffer of that length (a pipe write this small is atomic).
            assert_eq!(unsafe { libc::read(ready_r.as_raw_fd(), pid.as_mut_ptr().cast(), pid.len()) }, pid.len() as isize);
            child.pid = libc::pid_t::from_ne_bytes(pid);
            child
        }

        /// The parked child's pid, as the child itself sent it.
        pub(crate) fn pid(&self) -> libc::pid_t {
            self.pid
        }

        /// Has the child exec'd (and been reaped) before its gate was opened?
        pub(crate) fn gone(&self) -> bool {
            self.spawner.as_ref().is_some_and(|s| s.is_finished())
        }
    }

    impl Drop for ParkedChild {
        fn drop(&mut self) {
            // Open the gate (a byte: the child holds a copy of this write end itself, so a
            // close alone would never reach it as EOF), then reap.
            // SAFETY: a valid fd and a one-byte buffer.
            unsafe { libc::write(self.release.as_raw_fd(), b"g".as_ptr().cast(), 1) };
            if let Some(s) = self.spawner.take() {
                let status = s.join();
                if !std::thread::panicking() {
                    assert!(status.unwrap().unwrap().success(), "the parked child exits cleanly once released");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Flock;

    fn open(path: &std::path::Path) -> std::fs::File {
        std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(path).unwrap()
    }

    /// Board #136's mechanism on a plain file: a child forked while the lock is held, and
    /// parked between fork and exec (`ParkedChild` proves both), keeps the lock's description;
    /// after the guard drops, a new description takes the lock at once. Without the explicit
    /// unlock it is refused until that child execs.
    #[test]
    fn a_dropped_guard_is_free_while_a_child_forked_under_it_has_not_exec_d_yet() {
        let dir = crate::config::test_scratch("flock-child");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.lock");
        let held = Flock::try_exclusive(open(&path)).unwrap().expect("free");
        assert!(Flock::try_exclusive(open(&path)).unwrap().is_none(), "held: a second description is refused");
        let child = super::parked_child::ParkedChild::spawn(); // forked while held, parked before its exec
        drop(held);
        assert!(Flock::try_exclusive(open(&path)).unwrap().is_some(), "free at once after the drop");
        drop(child);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Validator-2 note 21 (measured): a signal delivered to the parked child interrupted its
    /// gate read, the ignored -1 let it exec before the test released it. The gate holds
    /// through a signal: a handler installed without SA_RESTART (inherited by the child), the
    /// child seen asleep in its read, SIGUSR1 to it, and it is still parked a second later
    /// (a wait for what must NOT happen can only miss).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_signal_does_not_open_the_parked_childs_gate() {
        extern "C" fn on_usr1(_: libc::c_int) {}
        struct Restore(libc::sigaction);
        impl Drop for Restore {
            fn drop(&mut self) {
                // SAFETY: restoring the action saved below.
                unsafe { libc::sigaction(libc::SIGUSR1, &self.0, std::ptr::null_mut()) };
            }
        }
        // SAFETY: a zeroed sigaction with a no-op handler, no SA_RESTART.
        let _restore = unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = on_usr1 as *const () as usize;
            libc::sigemptyset(&mut action.sa_mask);
            let mut old: libc::sigaction = std::mem::zeroed();
            assert_eq!(libc::sigaction(libc::SIGUSR1, &action, &mut old), 0);
            Restore(old)
        };
        let child = super::parked_child::ParkedChild::spawn();
        let pid = child.pid();
        // Asleep in its gate read (state S), so the signal lands IN the read.
        let state = || std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s| s.rsplit(')').next().and_then(|r| r.split_whitespace().next()).map(str::to_string));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while state().as_deref() != Some("S") {
            assert!(std::time::Instant::now() < deadline, "the child never slept in its gate read: {:?}", state());
            std::thread::yield_now();
        }
        // SAFETY: a plain signal to our own child.
        assert_eq!(unsafe { libc::kill(pid, libc::SIGUSR1) }, 0);
        let until = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while std::time::Instant::now() < until {
            assert!(!child.gone(), "the signal let the child exec before its gate was opened");
            std::thread::yield_now();
        }
        drop(child);
    }
}
