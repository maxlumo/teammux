//! The ONE bounded runner for a short probe of this host's CLIs: the
//! recovery drift guard's `--version` (board #362) and the backend readiness
//! check (board #492). Moved here from `projects::recovery` when the second
//! caller arrived, so both share one lifecycle instead of each growing its
//! own: a second runner that waits only on its leader would leave a child
//! holding the pipe, which is the bug #362's review rounds closed.
//!
//! What a caller gets is the probe's answer on ONE channel, its stdout or its
//! fd 3, or the CLASS of why there is none (`Failure`). Never the probe's
//! stderr or any raw error text: a reason is a word, so nothing a CLI prints
//! about itself can reach a log or a reply through this door.

use std::io::Read;
use std::os::unix::process::CommandExt;

/// The most of an answer that is read. The answer is one line; a probe that
/// keeps writing must not grow the gateway's memory (reviewer round 2, #362).
pub const READ_CAP: u64 = 64 * 1024;

/// Why a probe gave no answer, as a class (board #492, reviewer P1-C: a
/// missing binary, a failed start, a timeout and a failing exit are distinct
/// facts, and none of them is "not configured").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The program is not there to start.
    NotFound,
    /// It is there and would not start (permissions, a bad interpreter, …).
    SpawnFailed,
    /// The one total limit passed before the exit and the read both ended.
    Timeout,
    /// It exited unsuccessfully (a code or a signal).
    Exit,
    /// It exited 0 and its answer could not be read as text.
    Unreadable,
    /// Its leader's state could not be told (reaped elsewhere, or waitid
    /// failed): nothing more is known.
    Lost,
    /// A strict (fd-3) answer was longer than its cap.
    Overflow,
}

impl Failure {
    /// The class as the word a reply carries.
    pub fn word(self) -> &'static str {
        match self {
            Failure::NotFound => "not_found",
            Failure::SpawnFailed => "spawn_failed",
            Failure::Timeout => "timeout",
            Failure::Exit => "exit",
            Failure::Unreadable => "unreadable",
            Failure::Lost => "lost",
            Failure::Overflow => "overflow",
        }
    }
}

/// Where the answer comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// The probe's stdout (a `--version`).
    Stdout,
    /// A pipe on the probe's fd 3; its stdin, stdout and stderr are all
    /// `/dev/null` (board #492: a login shell's rc may print anything to the
    /// standard streams, and none of it may become the answer).
    Fd3,
}

/// `run` on stdout with the standard cap, as an `Option`: the drift guard's
/// form, which needs no reason.
pub fn output(cmd: std::process::Command, limit: std::time::Duration) -> Option<String> {
    run(cmd, limit, Channel::Stdout, READ_CAP).ok()
}

/// Run `cmd` and return what it wrote on `channel`, at most `cap` bytes,
/// within ONE total `limit` for the start, the exit and the read (reviewer
/// P2-2, #362): a wrapper that exits while a child it forked keeps the pipe
/// open would otherwise block the read, and the caller with it, forever. The
/// pipe is read on its own thread, and the thread STOPS reading after `cap`
/// bytes and drops the pipe; the caller waits for the exit and then for that
/// thread, both against the same deadline. Only a SUCCESSFUL exit's output
/// is used.
///
/// The probe runs in a session and process group of its own (`setsid`), and
/// the group is killed on every way out (reviewer round 2, #362): a child holding the pipe, or one
/// still writing, ends with the probe, and its pipe closing ends the reader
/// thread. The signal can reach this probe's processes and nothing else: the
/// group is a NEW one (`setsid`, its id the leader's pid, never the
/// gateway's group), and it is signalled while the leader is NOT yet reaped
/// (its exit is watched with `waitid(WNOWAIT)`, which leaves it a zombie), so
/// the kernel still holds that pid and no other process can own a group of
/// that id. A leader that something else reaped is not signalled at all.
/// Anything that `setsid`s itself away is its own choice, as for
/// `tasks::stop`.
pub fn run(cmd: std::process::Command, limit: std::time::Duration, channel: Channel, cap: u64) -> Result<String, Failure> {
    match run_status(cmd, limit, channel, cap)? {
        (out, Some(0)) => Ok(out),
        _ => Err(Failure::Exit),
    }
}

/// `run`, keeping the answer of an UNSUCCESSFUL exit too, with the exit code
/// (`None` when a signal ended it): for a CLI whose failing answer is itself the fact
/// (Claude Code's `auth status` exits 1 with `loggedIn: false` when signed
/// out, measured on 2.1.304, board #492). The same single lifecycle; `Exit`
/// is never returned from here.
pub fn run_status(cmd: std::process::Command, limit: std::time::Duration, channel: Channel, cap: u64) -> Result<(String, Option<i32>), Failure> {
    run_status_as(cmd, limit, channel, cap, Group::Own)
}

/// Which process group a probe runs in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
    /// A new session and group of its own: the ROOT probe of a check. Its
    /// deadline kills the whole group.
    Own,
    /// The caller's group, for a probe that a root probe's own process runs
    /// (the readiness helper's CLIs, reviewer P1-C on #492): the root's kill
    /// then reaches it, and nothing it starts sits in a group of ours that
    /// the root cannot see. Its own deadline ends its leader only.
    Caller,
}

/// `run_status` with the group chosen (see `Group`).
pub fn run_status_as(mut cmd: std::process::Command, limit: std::time::Duration, channel: Channel, cap: u64, group: Group) -> Result<(String, Option<i32>), Failure> {
    let deadline = std::time::Instant::now() + limit;
    cmd.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if group == Group::Own {
        // A new SESSION, so a new process group with no controlling terminal
        // (board #492, measured: an interactive zsh probe started by a
        // gateway that had a terminal opened /dev/tty from a background group
        // and sat STOPPED until the deadline). The group's id is the
        // leader's pid, as with `process_group(0)` before.
        // SAFETY: setsid is async-signal-safe; a freshly forked child is
        // never a group leader, so it cannot fail for that reason.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    // The fd-3 pipe (`std::io::pipe`: close-on-exec on every platform, so no
    // other child ever inherits it): the write end is placed on the child's
    // fd 3 between fork and exec, and the parent's copy is dropped right
    // after the spawn, so the pipe closes when the probe's last process lets
    // go of it.
    let mut fd3: Option<std::io::PipeReader> = None;
    let mut fd3_write: Option<std::io::PipeWriter> = None;
    match channel {
        Channel::Stdout => {
            cmd.stdout(std::process::Stdio::piped());
        }
        Channel::Fd3 => {
            cmd.stdout(std::process::Stdio::null());
            let (read, write) = std::io::pipe().map_err(|_| Failure::SpawnFailed)?;
            let w = {
                use std::os::fd::AsRawFd;
                write.as_raw_fd()
            };
            // SAFETY: dup2 is async-signal-safe; the new fd 3 is not
            // close-on-exec (dup2 clears the flag), the original stays so.
            unsafe {
                cmd.pre_exec(move || {
                    if libc::dup2(w, 3) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            fd3 = Some(read);
            fd3_write = Some(write);
        }
    }
    let spawned = cmd.spawn();
    drop(fd3_write);
    let mut child = spawned.map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { Failure::NotFound } else { Failure::SpawnFailed })?;
    let pid = child.id() as libc::pid_t;
    // End the probe, then reap its leader. Called only while the leader is
    // unreaped (see above).
    let end = |child: &mut std::process::Child| {
        match group {
            // SAFETY: a plain syscall; `pid` is this probe's unreaped leader,
            // so the group of that id is the one `spawn` created.
            Group::Own => unsafe {
                libc::killpg(pid, libc::SIGKILL);
            },
            Group::Caller => {
                let _ = child.kill();
            }
        }
        child.wait().ok()
    };
    let pipe: Box<dyn Read + Send> = match (channel, child.stdout.take(), fd3) {
        (Channel::Stdout, Some(out), _) => Box::new(out),
        (Channel::Fd3, _, Some(file)) => Box::new(file),
        _ => {
            end(&mut child);
            return Err(Failure::SpawnFailed);
        }
    };
    // The fd-3 frame is strict (reviewer P2-F): an answer over `cap` is
    // refused whole, never accepted as its first `cap` bytes. A `--version`
    // on stdout keeps its truncation.
    let read_cap = if channel == Channel::Fd3 { cap + 1 } else { cap };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = String::new();
        let _ = tx.send(pipe.take(read_cap).read_to_string(&mut out).ok().map(|_| out));
    });
    let exited = match wait_until(deadline, || leader_wait(pid)) {
        LeaderWait::Exited => true,
        LeaderWait::Running | LeaderWait::Interrupted => false,
        // Reaped by someone else (ECHILD): its pid, and so its group id,
        // may already be another process's. Nothing is signalled.
        LeaderWait::ReapedElsewhere => {
            eprintln!("probe {pid}: its leader was reaped elsewhere; its group is not signalled");
            return Err(Failure::Lost);
        }
        // The kernel would not say. The leader is still this probe's own
        // unreaped child, so it alone is ended by its pid; the group is not
        // signalled on a guess (review P2-3).
        LeaderWait::Failed(errno) => {
            eprintln!("probe {pid}: waitid failed (errno {errno}); only the leader is ended");
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::Lost);
        }
    };
    // The leader stays unreaped while the read runs, so the group id stays
    // this probe's until `end` below.
    let out = if exited {
        match rx.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())) {
            Ok(Some(text)) if text.len() as u64 > cap => Err(Failure::Overflow),
            Ok(Some(text)) => Ok(text),
            Ok(None) => Err(Failure::Unreadable),
            Err(_) => Err(Failure::Timeout),
        }
    } else {
        Err(Failure::Timeout)
    };
    let status = end(&mut child);
    let out = out?;
    // A signal is no code (`None`); an exit nobody could read (the wait
    // failed) is -1, a failure either way.
    let code = match status {
        Some(s) => s.code(),
        None => Some(-1),
    };
    Ok((out, code))
}

/// What waiting on the probe's leader said (review P2-3 on 6111d25b: every
/// waitid failure used to read as "reaped elsewhere", EINTR included, which
/// skipped the group cleanup).
#[derive(Debug, PartialEq)]
enum LeaderWait {
    Exited,
    Running,
    /// EINTR: ask again.
    Interrupted,
    /// ECHILD: it is no longer our child to wait for, so its pid may be reused.
    ReapedElsewhere,
    /// Any other failure, with its errno: the leader's state is unknown.
    Failed(i32),
}

/// Has the leader `pid` exited? Asked WITHOUT reaping it (`WNOWAIT`), so its
/// pid stays held and its group id stays this probe's.
fn leader_wait(pid: libc::pid_t) -> LeaderWait {
    // SAFETY: `info` is a zeroed out-parameter the call fills; si_pid is read
    // after it, as waitid(2) says to tell "exited" from "nothing yet" under
    // WNOHANG.
    let (r, errno, si_pid) = unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        let r = libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT);
        (r, std::io::Error::last_os_error().raw_os_error().unwrap_or(0), info.si_pid())
    };
    classify_wait(r, errno, si_pid, pid)
}

/// Ask `wait` until it says something final or `deadline` passes: a
/// leader still running is asked again after 20 ms, an interrupted wait at
/// once, and BOTH only while the deadline holds (review P2 on 4cd26dc9: a
/// steady stream of EINTR must not outlast the probe's one total limit).
/// Returns the last answer: `Running` or `Interrupted` means out of time.
fn wait_until(deadline: std::time::Instant, mut wait: impl FnMut() -> LeaderWait) -> LeaderWait {
    loop {
        let answer = wait();
        let in_time = std::time::Instant::now() < deadline;
        match answer {
            LeaderWait::Running if in_time => std::thread::sleep(std::time::Duration::from_millis(20)),
            LeaderWait::Interrupted if in_time => {}
            done => return done,
        }
    }
}

/// `leader_wait`'s reading of one waitid answer. Pure.
fn classify_wait(r: i32, errno: i32, si_pid: i32, pid: i32) -> LeaderWait {
    match (r, errno) {
        (0, _) if si_pid == pid => LeaderWait::Exited,
        (0, _) => LeaderWait::Running,
        (_, libc::EINTR) => LeaderWait::Interrupted,
        (_, libc::ECHILD) => LeaderWait::ReapedElsewhere,
        (_, e) => LeaderWait::Failed(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The drift guard's form under its old name, so the moved tests read as
    /// they did in `projects::recovery`.
    fn version_output(cmd: std::process::Command, limit: std::time::Duration) -> Option<String> {
        output(cmd, limit)
    }
    const VERSION_READ_CAP: u64 = READ_CAP;

    /// Board #362, reviewer P2-2: ONE deadline for the start, the exit and
    /// the read. Controllable wrappers, never a real CLI: a plain answer is
    /// read; the caller returns at the limit on a hang, and on a wrapper that
    /// exits at once while a child it forked keeps stdout open (the read
    /// alone would wait for the child); a failing exit is not read.
    #[test]
    fn the_version_probe_is_bounded_end_to_end_and_reads_only_a_success() {
        let sh = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let limit = std::time::Duration::from_millis(800);
        assert_eq!(version_output(sh("echo 'kiro-cli 2.31.0'"), limit).as_deref(), Some("kiro-cli 2.31.0\n"));
        for (what, script) in [("a hang", "sleep 30"), ("a parent that exits while its child holds stdout", "(sleep 30; echo late) & echo early")] {
            let t0 = std::time::Instant::now();
            assert_eq!(version_output(sh(script), limit), None, "{what}");
            assert!(t0.elapsed() < limit + std::time::Duration::from_millis(700), "{what}: cut at the limit, took {:?}", t0.elapsed());
        }
        assert_eq!(version_output(sh("echo 'kiro-cli 2.31.0'; exit 3"), limit), None, "a failing exit is not read");
        assert_eq!(version_output(std::process::Command::new("/nonexistent/tmm-no-such-cli"), limit), None, "not installed");
    }

    /// Board #362, reviewer round 2: the caller returning at its deadline is
    /// not enough; the probe's own processes end with it, and ONLY its own.
    /// Each wrapper forks a child that writes its pid to a file, and after the
    /// probe returns that child is gone: under a leader that hangs, and
    /// holding stdout after its leader exited 0. A process outside the probe
    /// (in this test's own group, as the gateway's tmux and agents are in
    /// theirs) is alive after every probe. The cap STOPS the read: a child
    /// that keeps writing is read only up to the cap, and a LEADER that writes
    /// forever dies of SIGPIPE once the reader lets go of the pipe, long
    /// before the deadline (a read that ran on and only cut the answer would
    /// keep it alive until the deadline).
    #[test]
    fn the_version_probe_leaves_none_of_its_processes_and_reads_at_most_its_cap() {
        let limit = std::time::Duration::from_millis(1500);
        let alive = |pid: libc::pid_t| unsafe { libc::kill(pid, 0) } == 0;
        fn poll(what: &str, mut ok: impl FnMut() -> bool) {
            for _ in 0..100 {
                if ok() {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!("{what}");
        }
        let mut outside = std::process::Command::new("sleep").arg("30").spawn().expect("a process outside the probe");
        let outside_pid = outside.id() as libc::pid_t;
        let child = r#"sh -c 'echo $$ > "$PIDF"; exec sleep 30'"#;
        for (i, (what, script)) in
            [("a hang", format!("{child} & wait")), ("a child holding stdout after its leader exited 0", format!("{child} & echo early"))]
                .into_iter()
                .enumerate()
        {
            let pidf = crate::config::test_scratch(&format!("tmm-probe-{i}"));
            let _ = std::fs::remove_file(&pidf);
            let mut cmd = std::process::Command::new("sh");
            cmd.args(["-c", &script]).env("PIDF", &pidf);
            let t0 = std::time::Instant::now();
            assert_eq!(version_output(cmd, limit), None, "{what}");
            assert!(t0.elapsed() < limit + std::time::Duration::from_millis(700), "{what}: returned at the limit, took {:?}", t0.elapsed());
            let mut pid: libc::pid_t = 0;
            poll(&format!("{what}: the child wrote its pid"), || {
                pid = std::fs::read_to_string(&pidf).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                pid > 1
            });
            poll(&format!("{what}: child {pid} outlived the probe"), || !alive(pid));
            let _ = std::fs::remove_file(&pidf);
            assert!(alive(outside_pid), "{what}: the probe signalled a process that is not its own");
        }
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sh -c 'while :; do echo 2.31.0; done' & sleep 0.3"]);
        let out = version_output(cmd, limit).expect("an endless writer is read up to the cap, not to the deadline");
        assert_eq!(out.len() as u64, VERSION_READ_CAP);
        assert!(out.starts_with("2.31.0\n"));
        let long = std::time::Duration::from_secs(5);
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "while :; do echo 2.31.0; done"]);
        let t0 = std::time::Instant::now();
        assert_eq!(version_output(cmd, long), None, "a leader killed by SIGPIPE did not succeed");
        assert!(t0.elapsed() < long / 2, "the read stopped at the cap and let go of the pipe: took {:?}", t0.elapsed());
        assert!(alive(outside_pid), "the probe signalled a process that is not its own");
        let _ = outside.kill();
        let _ = outside.wait();
    }

    /// Board #362 review P2-3: the probe's wait tells its failures apart.
    /// EINTR is asked again; ECHILD (the leader was reaped by someone else,
    /// shown here for real) means its pid may be reused, so nothing is
    /// signalled; any other failure leaves the leader's state unknown.
    #[test]
    fn the_probe_wait_tells_an_interrupt_from_a_reaped_leader_from_a_failure() {
        assert_eq!(classify_wait(0, 0, 42, 42), LeaderWait::Exited);
        assert_eq!(classify_wait(0, 0, 0, 42), LeaderWait::Running, "WNOHANG, nothing yet");
        assert_eq!(classify_wait(-1, libc::EINTR, 0, 42), LeaderWait::Interrupted);
        assert_eq!(classify_wait(-1, libc::ECHILD, 0, 42), LeaderWait::ReapedElsewhere);
        assert_eq!(classify_wait(-1, libc::EINVAL, 0, 42), LeaderWait::Failed(libc::EINVAL));
        // EINTR is retried, but only inside the one total deadline.
        let limit = std::time::Duration::from_millis(300);
        let t0 = std::time::Instant::now();
        assert_eq!(wait_until(t0 + limit, || LeaderWait::Interrupted), LeaderWait::Interrupted, "out of time");
        assert!(t0.elapsed() < limit + std::time::Duration::from_millis(200), "a stream of EINTR stops at the deadline: {:?}", t0.elapsed());
        let mut n = 0;
        assert_eq!(wait_until(t0 + std::time::Duration::from_secs(5), || { n += 1; if n < 3 { LeaderWait::Interrupted } else { LeaderWait::Exited } }), LeaderWait::Exited, "retried, then answered");
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        assert_eq!(leader_wait(pid), LeaderWait::Running);
        let _ = child.kill();
        let mut exited = false;
        for _ in 0..100 {
            if leader_wait(pid) == LeaderWait::Exited { exited = true; break; }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(exited, "an exited leader is seen, and not reaped by the asking");
        // Reaped by someone else: ECHILD.
        let mut status = 0;
        // SAFETY: reaping this test's own child, standing in for "someone else".
        assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
        assert_eq!(leader_wait(pid), LeaderWait::ReapedElsewhere);
        drop(child); // std's Child never waits or kills on drop
    }

    /// Board #492: a probe has no controlling terminal, so an interactive
    /// shell cannot stop on /dev/tty.
    #[test]
    fn a_probe_has_no_terminal() {
        let sh = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let out = output(sh("(exec 9</dev/tty) 2>/dev/null && echo tty || echo no-tty"), std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(out, "no-tty\n");
    }

    /// Board #492: the ROOT probe leads its own session; a probe run with
    /// `Group::Caller` stays in its caller's group, where the root's kill
    /// reaches it (reviewer P1-C). Linux reads the ids from /proc.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_root_probe_leads_its_own_session_and_a_nested_one_stays_in_its_callers_group() {
        let sh = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let limit = std::time::Duration::from_secs(3);
        // field 5 is the process group, field 6 the session
        let ids = "echo $$; cut -d' ' -f5,6 /proc/self/stat";
        let out = output(sh(ids), limit).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 2, "{out}");
        assert_eq!(lines[1], format!("{0} {0}", lines[0]), "the root probe's shell leads its group and session");
        let (out, code) = run_status_as(sh(ids), limit, Channel::Stdout, READ_CAP, Group::Caller).unwrap();
        assert_eq!(code, Some(0));
        // SAFETY: plain getters.
        let ours = unsafe { format!("{} {}", libc::getpgrp(), libc::getsid(0)) };
        assert_eq!(out.lines().nth(1), Some(ours.as_str()), "a nested probe is in its caller's group and session");
        let t0 = std::time::Instant::now();
        assert_eq!(run_status_as(sh("sleep 30"), std::time::Duration::from_millis(500), Channel::Stdout, READ_CAP, Group::Caller), Err(Failure::Timeout));
        assert!(t0.elapsed() < std::time::Duration::from_secs(2), "its own deadline ends it");
    }

    /// Board #492, reviewer P1-C: a failure is a CLASS, never collapsed. A
    /// missing program, a failing exit and a timeout are three different
    /// facts, and `output` (the drift guard's door) still reads all as None.
    #[test]
    fn a_probe_failure_is_named_by_its_class() {
        let sh = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let limit = std::time::Duration::from_millis(800);
        let run_out = |c| run(c, limit, Channel::Stdout, READ_CAP);
        assert_eq!(run_out(std::process::Command::new("/nonexistent/tmm-no-such-cli")), Err(Failure::NotFound));
        assert_eq!(run_out(sh("echo partial; exit 3")), Err(Failure::Exit));
        assert_eq!(run_out(sh("sleep 30")), Err(Failure::Timeout));
        assert_eq!(run_out(sh("printf '\\377\\376'")), Err(Failure::Unreadable), "not text");
        let dir = crate::config::fresh_process_dir("tmm-probe-noexec");
        let script = dir.join("not-executable");
        std::fs::write(&script, "#!/bin/sh\necho hi\n").unwrap();
        assert_eq!(run_out(std::process::Command::new(&script)), Err(Failure::SpawnFailed), "there, but it will not start");
        assert_eq!(output(sh("echo partial; exit 3"), limit), None);
    }

    /// Board #492, reviewer P1-B: on the fd-3 channel the answer is fd 3 and
    /// ONLY fd 3. What the probe prints on stdout or stderr reaches nothing,
    /// and the read is capped like stdout's.
    #[test]
    fn the_fd3_channel_reads_fd3_only() {
        let sh = |script: &str| { let mut c = std::process::Command::new("sh"); c.args(["-c", script]); c };
        let limit = std::time::Duration::from_millis(1500);
        let got = run(sh("echo SENTINEL-OUT; echo SENTINEL-ERR >&2; echo answer >&3"), limit, Channel::Fd3, READ_CAP);
        assert_eq!(got.as_deref(), Ok("answer\n"));
        let got = run(sh("echo only-stdout"), limit, Channel::Fd3, READ_CAP);
        assert_eq!(got.as_deref(), Ok(""), "nothing on fd 3 is an empty answer, not stdout");
        let got = run(sh("while :; do echo flood >&3; done"), std::time::Duration::from_secs(5), Channel::Fd3, 4096);
        assert_eq!(got, Err(Failure::Overflow), "a flood is refused whole, never read as its first 4096 bytes");
        // The strict cap is exact: `cap` bytes are an answer, one more is not.
        let got = run(sh("head -c 4096 /dev/zero | tr '\\0' x >&3"), limit, Channel::Fd3, 4096);
        assert_eq!(got.map(|t| t.len()), Ok(4096));
        let got = run(sh("head -c 4097 /dev/zero | tr '\\0' x >&3"), limit, Channel::Fd3, 4096);
        assert_eq!(got, Err(Failure::Overflow));
        let got = run(sh("(sleep 30) 3>&3 & echo early >&3"), limit, Channel::Fd3, READ_CAP);
        assert_eq!(got, Err(Failure::Timeout), "a child still holding fd 3 is cut at the deadline");
    }
}
