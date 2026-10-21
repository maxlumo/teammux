//! The gateway: the one way this machine's server is started (board #323,
//! owner 2026-10-09: "通过输入 tmm gateway 就可以启动后台的 server…做成 Linux 或
//! macOS 下的一个后台进程任务").
//!
//! - `start` is the foreground entry — what `tmm gateway start`, the `server`
//!   binary (a thin alias kept for the dev watcher and existing units) and the
//!   installed service run.
//! - `probe` answers "is OUR gateway already answering here?" with a real
//!   loopback auth compared on machine id, so the desktop app and `status`
//!   never start a second one and no unauthenticated method is added.
//! - `service` renders and manages the per-user launchd agent / systemd user
//!   unit, by identity (name + executable + config root), never by name alone.
//!
//! Desktop-only, like `projects`: a phone is a client of a desktop server.

pub mod probe;
pub mod setup;
pub mod service;

use crate::config::Config;

/// Run the server for `cfg` in the foreground until it fails. Every line
/// the process writes from here on starts with its local time
/// (`stamp_output_lines`, board #417).
pub async fn start(cfg: Config) -> Result<(), String> {
    stamp_output_lines();
    start_ready(cfg, None).await
}

/// Board #417: a gateway's log is its stdout and stderr, and launchd keeps
/// what it is given — no time on a line (measured on clawdbjs: 7152 lines of
/// server.log, none with a time, so no disconnect could be matched to the
/// moment the owner saw it). So the time becomes PART OF THE LINE, for every
/// writer at once — our println!/eprintln!, a panic message, a child's
/// output: fds 1 and 2 are pointed at a pipe, and one thread per stream
/// writes each line to the original fd as `YYYY-MM-DD HH:MM:SS.mmm <line>`
/// (`stamp_line`; a line longer than `STAMP_PIECE` is written in pieces, each
/// after the first marked `+ `, so nothing is held without bound).
///
/// - A stream that IS systemd's journal is left alone: the journal stamps
///   every line itself. `JOURNAL_STREAM` names the journal stream's
///   `device:inode`, and only an fd whose fstat matches it is skipped — the
///   variable alone proves nothing, as a redirected child can inherit it.
/// - Diagnostics fail OPEN (review P1): the reader thread is running before
///   the live fd is touched, and any failure along the way leaves that fd as
///   it was, with nothing of ours left open.
/// - At a normal exit or `process::exit` (atexit) the streams are closed and
///   drained for at most a second. A SIGKILL or a fatal signal runs no
///   atexit handler, so what was still in the pipe then is lost.
///
/// Unix only.
#[cfg(unix)]
pub fn stamp_output_lines() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let journal = std::env::var("JOURNAL_STREAM").ok().and_then(|v| parse_journal_stream(&v));
        let streams: Vec<_> = [libc::STDOUT_FILENO, libc::STDERR_FILENO]
            .into_iter()
            .filter(|fd| journal.is_none_or(|j| fd_identity(*fd) != Some(j)))
            .filter_map(stamp_fd)
            .collect();
        if !streams.is_empty() {
            let _ = STAMPED.set(std::sync::Mutex::new(streams));
            extern "C" fn drain() {
                drain_stamped(std::time::Duration::from_secs(1));
            }
            unsafe { libc::atexit(drain) };
        }
    });
}

#[cfg(not(unix))]
pub fn stamp_output_lines() {}

/// `JOURNAL_STREAM` = `<device>:<inode>`, both decimal (systemd.exec(5)).
fn parse_journal_stream(v: &str) -> Option<(u64, u64)> {
    let (dev, ino) = v.trim().split_once(':')?;
    Some((dev.parse().ok()?, ino.parse().ok()?))
}

/// An fd's (device, inode), as `JOURNAL_STREAM` names a stream.
#[cfg(unix)]
fn fd_identity(fd: i32) -> Option<(u64, u64)> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstat(fd, &mut st) } == 0).then_some((st.st_dev as u64, st.st_ino as u64))
}

/// A stamped stream: its fd, and the receiver its thread signals at EOF.
#[cfg(unix)]
type Stamped = (i32, std::sync::mpsc::Receiver<()>);
#[cfg(unix)]
static STAMPED: std::sync::OnceLock<std::sync::Mutex<Vec<Stamped>>> = std::sync::OnceLock::new();

/// The most a stamped line holds before it is written: a longer line is
/// written in pieces of this size, each after the first marked `+ `.
const STAMP_PIECE: usize = 16 * 1024;

/// Point `fd` at a pipe whose reader stamps each line onto the original
/// fd. Every step that can fail happens BEFORE the live fd is replaced, and
/// a failure closes what was opened: the stream stays as it was.
#[cfg(unix)]
fn stamp_fd(fd: i32) -> Option<Stamped> {
    use std::os::fd::{FromRawFd, OwnedFd};
    let cloexec = |f: i32| unsafe { libc::fcntl(f, libc::F_SETFD, libc::FD_CLOEXEC) } == 0;
    // Owned from the start: an early return closes them.
    let orig = unsafe { libc::dup(fd) };
    if orig < 0 {
        return None;
    }
    let orig = unsafe { OwnedFd::from_raw_fd(orig) };
    let mut p = [0i32; 2];
    if unsafe { libc::pipe(p.as_mut_ptr()) } != 0 {
        return None;
    }
    let (read_end, write_end) = unsafe { (OwnedFd::from_raw_fd(p[0]), OwnedFd::from_raw_fd(p[1])) };
    use std::os::fd::AsRawFd;
    // Only the stamped fd itself is inherited by a child; these copies are ours.
    if !cloexec(orig.as_raw_fd()) || !cloexec(read_end.as_raw_fd()) || !cloexec(write_end.as_raw_fd()) {
        return None;
    }
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let reader = std::fs::File::from(read_end);
    let out = std::fs::File::from(orig);
    let job = move || {
        stamp_stream(reader, out, || chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string());
        let _ = done_tx.send(());
    };
    #[cfg(test)]
    if std::env::var_os("TMM_STAMP_FAIL_SPAWN").is_some() {
        drop(job); // what a failed spawn does with it
        return None;
    }
    std::thread::Builder::new().name(format!("stamp-fd{fd}")).spawn(job).ok()?;
    // The reader is running: only now is the live fd replaced. If that
    // fails, closing the write end gives the reader EOF and it ends.
    if unsafe { libc::dup2(write_end.as_raw_fd(), fd) } < 0 {
        return None;
    }
    drop(write_end);
    Some((fd, done_rx))
}

/// Copy `reader` to `out`, each line stamped (`stamp_line`): a line longer
/// than `STAMP_PIECE` goes out in pieces, each after the first marked `+ `;
/// a last line with no newline is written with one at EOF.
fn stamp_stream(mut reader: impl std::io::Read, mut out: impl std::io::Write, now: impl Fn() -> String) {
    let mut line: Vec<u8> = Vec::with_capacity(1024);
    let mut continued = false;
    let mut buf = [0u8; 8192];
    let emit = |line: &mut Vec<u8>, continued: bool, out: &mut dyn std::io::Write| {
        let mut stamped = stamp_line(&now(), if continued { b"+ ".as_slice() } else { b"".as_slice() }, line);
        stamped.push(b'\n');
        let _ = out.write_all(&stamped);
        line.clear();
    };
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &b in &buf[..n] {
            if b == b'\n' {
                emit(&mut line, continued, &mut out);
                continued = false;
            } else {
                line.push(b);
                if line.len() >= STAMP_PIECE {
                    emit(&mut line, continued, &mut out);
                    continued = true;
                }
            }
        }
    }
    if !line.is_empty() {
        emit(&mut line, continued, &mut out);
    }
}

/// One stamped line: the time, a space, the continuation mark if any, the
/// line as written.
fn stamp_line(time: &str, mark: &[u8], line: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(time.len() + 1 + mark.len() + line.len() + 1);
    v.extend_from_slice(time.as_bytes());
    v.push(b' ');
    v.extend_from_slice(mark);
    v.extend_from_slice(line);
    v
}

/// At exit: close our end of each stamped stream so its thread reads EOF,
/// and wait (bounded: a child that inherited the fd may keep it open) for
/// what was written last to reach the log.
#[cfg(unix)]
fn drain_stamped(within: std::time::Duration) {
    let Some(streams) = STAMPED.get() else { return };
    let Ok(streams) = streams.lock() else { return };
    let deadline = std::time::Instant::now() + within;
    for (fd, done) in streams.iter() {
        unsafe {
            let null = libc::open(c"/dev/null".as_ptr(), libc::O_WRONLY);
            if null >= 0 {
                libc::dup2(null, *fd);
                libc::close(null);
            }
        }
        let _ = done.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()));
    }
}

/// `start`, telling `ready` once the listener is bound (board #323).
pub async fn start_ready(cfg: Config, ready: Option<tokio::sync::oneshot::Sender<()>>) -> Result<(), String> {
    crate::tmux::set_scrollback(cfg.scrollback);
    crate::server::ui::configure(cfg.ui_dir.clone());
    crate::server::start_with_socket_ready(
        &cfg.host,
        cfg.port,
        &cfg.token,
        &cfg.machine_id,
        cfg.tmux_socket,
        cfg.tls_cert,
        cfg.tls_key,
        cfg.disconnect_grace_secs,
        cfg.trusted_proxies,
        ready,
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod stamp_tests {
    #[test]
    fn a_stamped_line_is_the_time_a_space_and_the_line() {
        assert_eq!(super::stamp_line("2026-10-17 22:50:01.123", b"", b"x y"), b"2026-10-17 22:50:01.123 x y");
        assert_eq!(super::stamp_line("T", b"+ ", b"rest"), b"T + rest");
    }

    /// Review P2-A: nothing is held without bound. A 40 KiB line with no
    /// newline goes out in `STAMP_PIECE` pieces, each after the first marked
    /// `+ `; a last line with no newline is written at EOF.
    #[test]
    fn a_long_or_unterminated_line_is_written_in_bounded_pieces() {
        let mut input = vec![b'x'; 40 * 1024];
        input.extend_from_slice(b"\nshort\ntail with no newline");
        let mut out = Vec::new();
        super::stamp_stream(std::io::Cursor::new(input), &mut out, || "T".to_string());
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.split_terminator('\n').collect();
        let piece = super::STAMP_PIECE;
        assert_eq!(lines.len(), 5, "{:?}", lines.iter().map(|l| l.len()).collect::<Vec<_>>());
        assert_eq!(lines[0], format!("T {}", "x".repeat(piece)));
        assert_eq!(lines[1], format!("T + {}", "x".repeat(piece)));
        assert_eq!(lines[2], format!("T + {}", "x".repeat(40 * 1024 - 2 * piece)));
        assert_eq!(lines[3], "T short");
        assert_eq!(lines[4], "T tail with no newline");
    }

    #[test]
    fn journal_stream_is_device_colon_inode() {
        assert_eq!(super::parse_journal_stream("8:4242"), Some((8, 4242)));
        assert_eq!(super::parse_journal_stream("8:"), None);
        assert_eq!(super::parse_journal_stream("x"), None);
    }

    fn open_fds() -> usize {
        std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0)
    }

    /// The child half of the tests below.
    #[test]
    #[ignore]
    fn stamp_child() {
        if std::env::var_os("TMM_STAMP_CHILD").is_none() {
            return;
        }
        use std::io::Write;
        // libtest has printed `test … ... ` with no newline: end that line.
        println!();
        eprintln!();
        let before = open_fds();
        super::stamp_output_lines();
        let added = open_fds() as i64 - before as i64;
        println!("out line");
        eprintln!("err line (fds added {added})");
        print!("out tail with no newline");
        let _ = std::io::stdout().flush();
        // The last lines before an exit still reach the log (the atexit drain).
        std::process::exit(3);
    }

    /// Run the child with `env`, its stdout on a pipe we made (so its
    /// identity is known); returns (stdout identity, stdout, stderr, code).
    fn run_child(env: &[(&str, String)], journal_is_stdout: bool) -> (String, String, Option<i32>) {
        use std::io::Read;
        use std::os::fd::FromRawFd;
        let mut p = [0i32; 2];
        assert_eq!(unsafe { libc::pipe(p.as_mut_ptr()) }, 0);
        let (r, w) = unsafe { (std::fs::File::from_raw_fd(p[0]), std::os::fd::OwnedFd::from_raw_fd(p[1])) };
        let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "gateway::stamp_tests::stamp_child", "--ignored", "--nocapture", "--test-threads=1"])
            .env("TMM_STAMP_CHILD", "1")
            .env_remove("JOURNAL_STREAM")
            .env_remove("TMM_STAMP_FAIL_SPAWN")
            .stderr(std::process::Stdio::piped());
        if journal_is_stdout {
            let (dev, ino) = super::fd_identity(p[0]).unwrap();
            cmd.env("JOURNAL_STREAM", format!("{dev}:{ino}"));
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.stdout(std::process::Stdio::from(w));
        let mut child = cmd.spawn().unwrap();
        drop(cmd); // our copy of the write end
        let mut err = String::new();
        child.stderr.take().unwrap().read_to_string(&mut err).unwrap();
        let code = child.wait().unwrap().code();
        let mut out = String::new();
        let mut r = r;
        r.read_to_string(&mut out).unwrap();
        (out, err, code)
    }

    fn stamped(line: &str) -> bool {
        line.len() > 24 && chrono::NaiveDateTime::parse_from_str(&line[..23], "%Y-%m-%d %H:%M:%S%.3f").is_ok() && &line[23..24] == " "
    }
    fn line_with<'a>(text: &'a str, want: &str) -> &'a str {
        text.lines().find(|l| l.contains(want)).unwrap_or_else(|| panic!("lost {want:?}: {text:?}"))
    }

    /// Board #417: a gateway process's stdout AND stderr lines start with
    /// the local time, down to the last line before `exit` and a last line
    /// with no newline.
    #[test]
    fn every_line_of_a_gateway_process_starts_with_its_time() {
        let (out, err, code) = run_child(&[], false);
        assert_eq!(code, Some(3));
        for (text, want) in [(&out, "out line"), (&out, "out tail with no newline"), (&err, "err line")] {
            let line = line_with(text, want);
            assert!(stamped(line) && line[24..].starts_with(want), "{line:?}");
        }
    }

    /// Review P2-B: only the stream that IS the journal is left alone —
    /// `JOURNAL_STREAM` naming the child's stdout pipe skips stdout and still
    /// stamps stderr; a value that names neither stamps both.
    #[test]
    fn only_the_stream_that_is_the_journal_is_left_unstamped() {
        let (out, err, code) = run_child(&[], true);
        assert_eq!(code, Some(3));
        assert_eq!(line_with(&out, "out line"), "out line", "stdout IS the journal stream");
        assert!(stamped(line_with(&err, "err line")), "stderr is not");
        let (out, err, _) = run_child(&[("JOURNAL_STREAM", "1:1".into())], false);
        assert!(stamped(line_with(&out, "out line")) && stamped(line_with(&err, "err line")), "an inherited value that names neither");
    }

    /// Review P1: diagnostics fail OPEN. The reader thread cannot be started
    /// (injected): both streams stay as they were — every line reaches its
    /// original sink, unstamped — no descriptor of ours is left open, and the
    /// exit is unchanged.
    #[test]
    fn a_stamper_that_cannot_start_leaves_the_streams_as_they_were() {
        let (out, err, code) = run_child(&[("TMM_STAMP_FAIL_SPAWN", "1".into())], false);
        assert_eq!(code, Some(3));
        assert_eq!(line_with(&out, "out line"), "out line");
        assert_eq!(line_with(&err, "err line"), "err line (fds added 0)", "nothing of ours left open");
        assert!(out.contains("out tail with no newline"));
    }
}
