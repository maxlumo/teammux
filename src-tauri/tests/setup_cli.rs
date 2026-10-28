//! Board #323 (reviewer setup P1-1/2/4): the first-run setup through the REAL
//! `tmm gateway install` control flow — an isolated HOME and config root, a
//! fake init system on PATH that only logs, and a test service name. A
//! cancel or an unreadable config stops the whole command: no config, no
//! unit, no native call, no secret on the terminal.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::process::Command;

struct World {
    root: PathBuf,
    calls: PathBuf,
}

impl World {
    fn new(tag: &str) -> World {
        let root = std::env::temp_dir().join(format!("setup-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("cfg/tmux-mobile")).unwrap();
        let calls = root.join("calls.log");
        for tool in ["systemctl", "launchctl", "journalctl"] {
            let f = root.join("bin").join(tool);
            std::fs::write(&f, format!("#!/bin/sh\necho \"{tool} $*\" >> '{}'\nexit 0\n", calls.display())).unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        World { root, calls }
    }
    fn config(&self) -> PathBuf {
        self.root.join("cfg/tmux-mobile/config.toml")
    }
    fn cmd(&self, program: &str) -> Command {
        let mut c = Command::new(program);
        c.env_clear()
            .env("HOME", &self.root)
            .env("XDG_CONFIG_HOME", self.root.join("cfg"))
            .env("PATH", format!("{}:/usr/bin:/bin", self.root.join("bin").display()))
            .env("TMM_GATEWAY_SERVICE", format!("tmux-mobile-gateway-test-{}.service", std::process::id()))
            .current_dir(&self.root);
        c
    }
    fn native_calls(&self) -> String {
        std::fs::read_to_string(&self.calls).unwrap_or_default()
    }
    fn units(&self) -> usize {
        std::fs::read_dir(self.root.join(".config/systemd/user")).map(|d| d.count()).unwrap_or(0)
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn have(tool: &str) -> bool {
    Command::new("sh").args(["-c", &format!("command -v {tool}")]).output().map(|o| o.status.success()).unwrap_or(false)
}

/// `tmm gateway install` in a pty, with `answers` on its stdin then EOF.
fn in_pty(w: &World, answers: &str) -> (i32, String) {
    let tmm = env!("CARGO_BIN_EXE_tmm");
    let mut c = w.cmd("script");
    c.args(["-qec", &format!("{tmm} gateway install"), "/dev/null"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = c.spawn().unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(answers.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

#[test]
fn a_cancelled_first_run_installs_and_starts_nothing() {
    if !have("script") {
        eprintln!("SKIPPED: no script(1) for a pty");
        return;
    }
    let w = World::new("cancel");
    let (code, out) = in_pty(&w, "8080\n");
    assert_ne!(code, 0, "{out}");
    assert!(out.contains("setup cancelled") && out.contains("nothing was installed or started"), "{out}");
    assert!(!w.config().exists(), "no config written");
    assert!(!w.root.join("cfg/tmux-mobile/machine_id").exists(), "no machine id");
    assert_eq!(w.units(), 0, "no unit");
    assert_eq!(w.native_calls(), "", "no native call");
}

#[test]
fn an_unreadable_config_stops_the_command_and_quotes_nothing() {
    let w = World::new("closed");
    let bad = "port = 1\ntoken = \"DUMMY-SECRET-0123\"x\n";
    std::fs::write(w.config(), bad).unwrap();
    let tmm = env!("CARGO_BIN_EXE_tmm");
    // No terminal (stdin closed) and, where available, a terminal too.
    let out = w.cmd(tmm).args(["gateway", "install"]).stdin(std::process::Stdio::null()).output().unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(!out.status.success(), "{text}");
    assert!(text.contains("does not parse") && text.contains("line 2"), "{text}");
    let mut seen = vec![text];
    if have("script") {
        let (code, t) = in_pty(&w, "\n\n\n\n\n");
        assert_ne!(code, 0, "{t}");
        seen.push(t);
    }
    for t in &seen {
        assert!(!t.contains("DUMMY-SECRET"), "the secret reached the terminal: {t}");
    }
    assert_eq!(std::fs::read_to_string(w.config()).unwrap(), bad, "bytes unchanged");
    assert!(!w.root.join("cfg/tmux-mobile/machine_id").exists(), "no machine id");
    assert_eq!(w.units(), 0);
    assert_eq!(w.native_calls(), "", "no native call");
}

#[test]
fn paths_answered_relative_are_absolute_for_the_service() {
    if !have("script") {
        eprintln!("SKIPPED: no script(1) for a pty");
        return;
    }
    if !have("openssl") {
        eprintln!("SKIPPED: no openssl to make a certificate");
        return;
    }
    let w = World::new("abs");
    let ok = Command::new("openssl")
        .args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=gw", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", "k.pem", "-out", "c.pem"])
        .current_dir(&w.root).output().unwrap();
    assert!(ok.status.success(), "openssl: {}", String::from_utf8_lossy(&ok.stderr));
    let tmm = env!("CARGO_BIN_EXE_tmm");
    // A FREE port, never a fixed one (board #476): two agents' Rust gates on
    // one host ran this test at once and the second gateway failed with
    // 'Address already in use'. The OS hands out a port nobody holds; it is
    // released at once for the gateway to take.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    // `tmm setup` from the scratch dir with relative answers …
    let mut c = w.cmd("script");
    c.args(["-qec", &format!("{tmm} setup"), "/dev/null"]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped());
    let mut child = c.spawn().unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(format!("{port}\n127.0.0.1\nsock\nc.pem\nk.pem\n").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
    // … and the service's view (config.toml alone) from ANOTHER cwd names the same files.
    let text = std::fs::read_to_string(w.config()).unwrap();
    for (k, f) in [("tls_cert", "c.pem"), ("tls_key", "k.pem"), ("tmux_socket", "sock")] {
        let want = format!("{k} = \"{}\"", w.root.join(f).display());
        assert!(text.contains(&want), "{k}: {text}");
    }
    // The managed start, from `/`: it must load the cert and key it was told.
    let mut srv = w.cmd(tmm).current_dir("/").args(["gateway", "start", "--service"])
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1500));
    let _ = srv.kill();
    let out = srv.wait_with_output().unwrap();
    let log = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(log.contains(&format!("listening on wss://127.0.0.1:{port}")), "the service started from / found its TLS files: {log}");
}
