#[cfg(feature = "gui")]
fn main() {
    tmux_mobile::run();
}

// A headless build (`gui` off, see src-tauri/Cargo.toml) has no Tauri shell to
// start. This bin still has to compile so `--bins` works there; the entry point
// in that build is `server`.
#[cfg(not(feature = "gui"))]
fn main() {
    eprintln!("built without the `gui` feature — run the `server` binary instead");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use std::thread;
    use std::time::Duration;
    use tmux_mobile::tmux;

    /// One tmux session per test, named for this process and test (board
    /// #265): every cargo run on the host shares ONE tmux server, so the old
    /// fixed `_tmux_mobile_test` let a second run kill or reuse
    /// the first run's session mid-test (t06 flaked during #264). The guard
    /// kills its session, and removes its probe scripts, on drop — also when
    /// an assertion panics (the #251 rule: guarded from the moment it exists).
    struct TestSession {
        name: String,
        files: Vec<std::path::PathBuf>,
    }

    impl TestSession {
        /// A clean name; nothing is spawned yet.
        fn new(test: &str) -> Self {
            let name = format!("_tmux_mobile_test_{}_{}", std::process::id(), test);
            let _ = tmux::kill_session(&name);
            TestSession { name, files: Vec::new() }
        }
        /// The session with a default shell.
        fn shell(test: &str) -> Self {
            let s = Self::new(test);
            tmux::new_session(&s.name, None, None).expect("Failed to create session");
            s
        }
        fn name(&self) -> &str { &self.name }
        /// Write a probe script beside this session's name; removed on drop.
        fn probe(&mut self, body: &str) -> String {
            let path = std::env::temp_dir().join(format!("{}_{}.py", self.name, self.files.len()));
            std::fs::write(&path, body).unwrap();
            self.files.push(path.clone());
            path.display().to_string()
        }
        /// Start `command` as this session's only pane.
        fn spawn(&self, command: &str) {
            let ok = std::process::Command::new("tmux")
                .args(["new-session", "-d", "-s", &self.name, command])
                .status()
                .unwrap()
                .success();
            assert!(ok, "Failed to create session {}", self.name);
        }
        fn kill(&self) { let _ = tmux::kill_session(&self.name); }

        /// Poll the pane until `needle` is painted (or the deadline passes)
        /// and return the last capture. Tests share the host's tmux server, so
        /// a fixed sleep makes host load decide the verdict (board #208: t07
        /// waited 1 s for 100 echo lines and failed under a parallel cargo
        /// build). Same idea as `wait_dead` in the tasks tests.
        fn pane_shows(&self, needle: &str, lines: usize) -> String {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let out = tmux::capture_pane(&self.name, Some(lines)).unwrap_or_default();
                if out.contains(needle) || std::time::Instant::now() >= deadline {
                    return out;
                }
                thread::sleep(Duration::from_millis(50));
            }
        }

        /// What a `GOT <repr>` probe has read so far, as ONE byte stream: the
        /// repr bodies of its reads, concatenated in order. How tmux's writes
        /// fall into the probe's reads is the host's scheduling, not tmux's
        /// behaviour (board #430: under load `ab` and `\x03` arrived as one
        /// read), so the bytes are asserted, not the chunks. Polls
        /// until the stream contains `needle` (10 s), like `pane_shows`.
        fn probe_stream(&self, needle: &str) -> (String, String) {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            loop {
                let out = tmux::capture_pane(&self.name, Some(50)).unwrap_or_default();
                let stream = probe_reads(&out).concat();
                if stream.contains(needle) || std::time::Instant::now() >= deadline {
                    return (stream, out);
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
    }

    /// Each `GOT b'…'` line's repr body, in order. A bytes repr escapes every
    /// byte on its own, so the bodies concatenate into the repr of the whole
    /// stream (the payloads here hold no quote characters).
    fn probe_reads(out: &str) -> Vec<String> {
        out.lines()
            .filter_map(|l| l.trim_end().strip_prefix("GOT b"))
            .filter_map(|r| r.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')).or_else(|| r.strip_prefix('"').and_then(|r| r.strip_suffix('"'))))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn probe_reads_join_into_one_stream_however_the_reads_fell() {
        let split = "PROBE_READY\nGOT b'ab'\nGOT b'\\x03'\nGOT b'cd'\nGOT b'\\x06'\nGOT b'\\x1b\\x14'\n";
        let coalesced = "PROBE_READY\nGOT b'ab\\x03'\nGOT b'cd'\nGOT b'\\x06'\nGOT b'\\x1b\\x14'\n";
        // ESC and its C0 byte in two reads: a legal split, the same stream.
        let esc_apart = "PROBE_READY\nGOT b'ab\\x03cd\\x06'\nGOT b'\\x1b'\nGOT b'\\x14'\n";
        for out in [split, coalesced, esc_apart] {
            assert_eq!(probe_reads(out).concat(), "ab\\x03cd\\x06\\x1b\\x14", "{out}");
            check_extended_keys_stream(&probe_reads(out).concat());
        }
        // A missing C0 byte, ESC and C0 reversed, and an extra byte still fail.
        for bad in ["abcd\\x06\\x1b\\x14", "ab\\x03cd\\x06\\x14\\x1b", "ab\\x03cd\\x06\\x1b\\x14x"] {
            let bad = bad.to_string();
            assert!(std::panic::catch_unwind(move || check_extended_keys_stream(&bad)).is_err(), "accepted a wrong stream");
        }
        assert_eq!(probe_reads("GOT b\"it's\"\n"), vec!["it's".to_string()]);
    }

    impl Drop for TestSession {
        fn drop(&mut self) {
            self.kill();
            for f in &self.files { let _ = std::fs::remove_file(f); }
        }
    }

    // These three used to assert on the DEVELOPER's server — "a server is
    // running", "it has sessions" — which the suite reached through the
    // inherited environment. Since board #349 the suite runs in an isolated
    // TMUX_TMPDIR where no server exists until a test makes one, so each
    // test now creates what it then observes. Nothing about tmux changed.
    #[test]
    fn t01_server_running() {
        let s = TestSession::shell("t01");
        assert!(tmux::is_server_running(), "a server runs once a session exists");
        drop(s);
        println!("✅ tmux server answers");
    }

    #[test]
    fn t02_list_sessions() {
        let s = TestSession::shell("t02");
        let sessions = tmux::list_sessions().expect("Failed to list sessions");
        println!("✅ Found {} sessions:", sessions.len());
        for x in &sessions {
            println!(
                "   - {} ({} windows, attached={})",
                x.name, x.windows, x.attached
            );
        }
        assert!(sessions.iter().any(|x| x.name == s.name()), "the session we made is listed");
    }

    #[test]
    fn t03_create_and_kill_session() {
        let s = TestSession::shell("t03");
        let sessions = tmux::list_sessions().unwrap();
        assert!(
            sessions.iter().any(|x| x.name == s.name()),
            "Test session not found"
        );
        println!("✅ Created session: {}", s.name());

        tmux::kill_session(s.name()).expect("Failed to kill session");
        // Killing the server's last session ends the server, and then
        // `list-sessions` is an error ("no server running") rather than an
        // empty list — on the developer's server other sessions hid that.
        let sessions = tmux::list_sessions().unwrap_or_default();
        assert!(
            !sessions.iter().any(|x| x.name == s.name()),
            "Test session still exists"
        );
        println!("✅ Killed session: {}", s.name());
    }

    #[test]
    fn t04_list_panes() {
        let s = TestSession::shell("t04");
        let panes = tmux::list_panes(s.name()).expect("Failed to list panes");
        println!("✅ Session {} has {} pane(s):", s.name(), panes.len());
        for p in &panes {
            println!(
                "   - window:{} pane:{} ({}x{}) cmd={}",
                p.window, p.pane, p.width, p.height, p.current_command
            );
        }
        assert!(!panes.is_empty(), "No panes found");
    }

    #[test]
    fn t05_send_command_and_capture() {
        let s = TestSession::shell("t05");
        thread::sleep(Duration::from_millis(200));

        let marker = "TMUX_MOBILE_TEST_12345";
        tmux::send_command(s.name(), &format!("echo {}", marker)).unwrap();

        let output = s.pane_shows(marker, 50);
        println!("✅ Captured pane output ({} chars)", output.len());
        assert!(output.contains(marker), "Marker not found in output");
        println!("✅ Command output verified!");
    }

    #[test]
    fn t06_send_special_keys() {
        let s = TestSession::shell("t06");
        thread::sleep(Duration::from_millis(200));

        tmux::send_keys(s.name(), "echo partial", true).unwrap();
        thread::sleep(Duration::from_millis(100));
        tmux::send_keys(s.name(), "C-c", false).unwrap();
        thread::sleep(Duration::from_millis(200));

        let marker = "AFTER_CTRL_C_OK";
        tmux::send_command(s.name(), &format!("echo {}", marker)).unwrap();

        let output = s.pane_shows(marker, 20);
        assert!(output.contains(marker), "Pane should work after Ctrl-C");
        println!("✅ Special keys (C-c) work correctly");
    }

    #[test]
    fn t07_capture_scrollback() {
        let s = TestSession::shell("t07");
        thread::sleep(Duration::from_millis(200));

        tmux::send_command(
            s.name(),
            "for i in $(seq 1 100); do echo \"line_$i\"; done",
        )
        .unwrap();

        let output = s.pane_shows("line_100", 50);
        assert!(output.contains("line_100"), "Should capture line_100");
        println!("✅ Scrollback capture works");
    }

    #[test]
    fn t08_literal_ctrl_bytes_reach_extended_keys_pane() {
        // With `extended-keys on`, tmux DROPS raw C0 bytes sent via
        // `send-keys -l` to panes in extended key mode (modifyOtherKeys /
        // kitty — what every modern agent TUI enables). send_keys must
        // translate them to named keys so they survive. The probe puts its
        // tty in raw mode, enables modifyOtherKeys level 1 (tmux shows
        // `Ext 1`, same as kiro-cli), and echoes the repr of every byte read.
        let mut s = TestSession::new("t08");
        let probe = "import sys, tty, os, time\n\
                     tty.setraw(0)\n\
                     time.sleep(0.3)\n\
                     sys.stdout.write('\\x1b[>4;1m'); sys.stdout.flush()\n\
                     sys.stdout.write('PROBE_READY\\r\\n'); sys.stdout.flush()\n\
                     [sys.stdout.write('GOT ' + repr(os.read(0, 64)) + '\\r\\n') or sys.stdout.flush() for _ in iter(int, 1)]";
        let script = s.probe(probe);
        s.spawn(&format!("python3 {script}"));
        // PROBE_READY is printed after the modifyOtherKeys request, so a pane
        // that shows it is already in extended key mode.
        assert!(s.pane_shows("PROBE_READY", 50).contains("PROBE_READY"), "probe did not start");

        // Mixed literal payload: text + Ctrl-C + text, plus a lone Ctrl-F and
        // a Ctrl+Alt combo, exactly what the frontend key path produces.
        tmux::send_keys(s.name(), "ab\x03cd", true).unwrap();
        tmux::send_keys(s.name(), "\x06", true).unwrap();
        tmux::send_keys(s.name(), "\x1b\x14", true).unwrap();

        // The bytes, in order, however the probe's reads fell (board #430).
        let (stream, output) = s.probe_stream("\\x1b\\x14");
        println!("probe output:\n{}", output);
        check_extended_keys_stream(&stream);
        println!("✅ literal ctrl bytes reach an extended-keys pane");
    }

    /// t08's verdict on the probe's byte stream. Read boundaries are not key
    /// boundaries (#430 review P1), so even ESC + the C0 byte of Ctrl+Alt-T is
    /// judged as two ADJACENT bytes of the stream, never as one read.
    fn check_extended_keys_stream(stream: &str) {
        assert!(stream.starts_with("ab"), "leading literal text lost: {stream}");
        assert!(stream.contains("\\x03"), "Ctrl-C byte dropped by extended-keys pane: {stream}");
        assert!(stream.contains("\\x03cd"), "trailing literal text lost: {stream}");
        assert!(stream.contains("\\x06"), "Ctrl-F byte dropped by extended-keys pane: {stream}");
        assert!(stream.contains("\\x1b\\x14"), "Ctrl+Alt-T is not ESC immediately followed by its C0 byte: {stream}");
        assert_eq!(stream, "ab\\x03cd\\x06\\x1b\\x14", "every byte, in order, nothing extra");
    }

    #[test]
    fn t09_paste_text_brackets_iff_pane_requested() {
        // paste_text must reproduce real terminal paste semantics: apps that
        // enabled bracketed paste (mode ?2004) receive \x1b[200~ … \x1b[201~
        // around the block (so pasted newlines are NOT executed line by
        // line); apps that didn't get the raw text.
        let mut s = TestSession::new("t09");
        let probe = "import sys, tty, os, time\n\
                     tty.setraw(0)\n\
                     time.sleep(0.3)\n\
                     if os.environ.get('BRACKET'): sys.stdout.write('\\x1b[?2004h'); sys.stdout.flush()\n\
                     sys.stdout.write('PROBE_READY\\r\\n'); sys.stdout.flush()\n\
                     [sys.stdout.write('GOT ' + repr(os.read(0, 256)) + '\\r\\n') or sys.stdout.flush() for _ in iter(int, 1)]";
        let script = s.probe(probe);

        // 1) bracketed-paste pane
        s.spawn(&format!("BRACKET=1 python3 {script}"));
        assert!(s.pane_shows("PROBE_READY", 50).contains("PROBE_READY"), "bracketed probe did not start");
        tmux::paste_text(s.name(), "line1\rline2\rline3").unwrap();
        // Asserted on the byte stream, not per read (board #430).
        let (stream, output) = s.probe_stream("\\x1b[201~");
        println!("bracketed probe:\n{}", output);
        assert!(stream.contains("\\x1b[200~"), "missing bracketed paste start marker: {stream}");
        assert!(stream.contains("\\x1b[201~"), "missing bracketed paste end marker: {stream}");
        assert!(stream.contains("line1\\rline2\\rline3"), "pasted body lost: {stream}");
        s.kill();

        // 2) legacy pane (no ?2004): raw text, no markers
        s.spawn(&format!("python3 {script}"));
        assert!(s.pane_shows("PROBE_READY", 50).contains("PROBE_READY"), "legacy probe did not start");
        tmux::paste_text(s.name(), "plain\rpaste").unwrap();
        let (stream, output) = s.probe_stream("plain\\rpaste");
        println!("legacy probe:\n{}", output);
        assert!(!stream.contains("\\x1b[200~"), "legacy pane must not receive paste markers: {stream}");
        assert!(stream.contains("plain\\rpaste"), "pasted body lost: {stream}");
        println!("✅ paste_text brackets iff the pane requested it");
    }
}
