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
        thread::sleep(Duration::from_millis(1500));

        // Mixed literal payload: text + Ctrl-C + text, plus a lone Ctrl-F and
        // a Ctrl+Alt combo, exactly what the frontend key path produces.
        tmux::send_keys(s.name(), "ab\x03cd", true).unwrap();
        tmux::send_keys(s.name(), "\x06", true).unwrap();
        tmux::send_keys(s.name(), "\x1b\x14", true).unwrap();
        thread::sleep(Duration::from_millis(600));

        let output = tmux::capture_pane(s.name(), Some(50)).unwrap();
        println!("probe output:\n{}", output);
        assert!(output.contains("PROBE_READY"), "probe did not start");
        assert!(output.contains("'ab'"), "leading literal text lost");
        assert!(output.contains("\\x03"), "Ctrl-C byte dropped by extended-keys pane");
        assert!(output.contains("'cd'"), "trailing literal text lost");
        assert!(output.contains("\\x06"), "Ctrl-F byte dropped by extended-keys pane");
        assert!(output.contains("\\x1b\\x14"), "Ctrl+Alt-T (ESC + C0) dropped or split");
        println!("✅ literal ctrl bytes reach an extended-keys pane");
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
        thread::sleep(Duration::from_millis(1500));
        tmux::paste_text(s.name(), "line1\rline2\rline3").unwrap();
        thread::sleep(Duration::from_millis(600));
        let output = tmux::capture_pane(s.name(), Some(50)).unwrap();
        println!("bracketed probe:\n{}", output);
        assert!(output.contains("\\x1b[200~"), "missing bracketed paste start marker");
        assert!(output.contains("\\x1b[201~"), "missing bracketed paste end marker");
        assert!(output.contains("line1\\rline2\\rline3") || (output.contains("line1") && output.contains("line3")),
            "pasted body lost");
        s.kill();

        // 2) legacy pane (no ?2004): raw text, no markers
        s.spawn(&format!("python3 {script}"));
        thread::sleep(Duration::from_millis(1500));
        tmux::paste_text(s.name(), "plain\rpaste").unwrap();
        thread::sleep(Duration::from_millis(600));
        let output = tmux::capture_pane(s.name(), Some(50)).unwrap();
        println!("legacy probe:\n{}", output);
        assert!(!output.contains("\\x1b[200~"), "legacy pane must not receive paste markers");
        assert!(output.contains("plain") && output.contains("paste"), "pasted body lost");
        println!("✅ paste_text brackets iff the pane requested it");
    }
}
