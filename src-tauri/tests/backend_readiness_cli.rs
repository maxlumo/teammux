//! Board #492, reviewer P1-B: the readiness baseline's login shell through
//! REAL processes. A fake login shell sources a fake rc, then runs the
//! gateway's fixed script, which execs the real `tmm readiness-probe`. What
//! the rc prints, traces, forges or floods must never become the answer, a
//! variable's VALUE never appears in it, a name with shell syntax runs
//! nothing, and a hang ends at the deadline.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tmux_mobile::backends::readiness::{shell_probe, Ask, Baseline, Frame, Scratch};

const TMM: &str = env!("CARGO_BIN_EXE_tmm");

struct Rig {
    root: PathBuf,
}

impl Rig {
    fn new(tag: &str, rc: &str) -> Rig {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("readiness-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("home")).unwrap();
        // A login shell as tmux would run it: refuses any other argument
        // shape, runs the rc, then the script with its arguments.
        let shell = root.join("bin").join("sh");
        std::fs::write(
            &shell,
            "#!/bin/sh\n[ \"$1\" = -l ] && [ \"$2\" = -i ] && [ \"$3\" = -c ] || exit 97\nscript=$4; shift 4\n. \"$HOME/.fakerc\"\nexec /bin/sh -c \"$script\" \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(root.join("home").join(".fakerc"), rc).unwrap();
        Rig { root }
    }

    fn home(&self) -> PathBuf {
        self.root.join("home")
    }

    fn base(&self) -> Baseline {
        Baseline {
            shell: self.root.join("bin").join("sh"),
            env: vec![("HOME".into(), self.home().into()), ("PATH".into(), "/usr/bin:/bin".into())],
            home: self.home(),
        }
    }

    fn ask(&self, names: &[&str], within: Duration) -> Result<Frame, &'static str> {
        let ask = Ask::Refresh { names: names.iter().map(|n| n.to_string()).collect(), claude_dir: None };
        shell_probe(&self.base(), Path::new(TMM), "/usr/bin:/bin", &ask, Instant::now() + within)
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn env_of(frame: &Frame) -> Vec<(String, bool)> {
    match frame {
        Frame::Refresh { env, .. } => env.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        other => panic!("not a refresh frame: {other:?}"),
    }
}

#[test]
fn what_the_rc_prints_or_traces_never_becomes_the_answer_and_no_value_is_returned() {
    let rc = "echo SENTINEL-OUT\necho SENTINEL-ERR >&2\nset -x\nexport SECRET_SPACE='SENTINEL a b *'\nexport SECRET_NL='SENTINEL\nsecond line'\nyes SENTINEL-FLOOD | head -c 2000000\n";
    let rig = Rig::new("print", rc);
    // A variable of THIS process (the gateway's) is not in the baseline.
    std::env::set_var("READINESS_GATEWAY_ONLY", "1");
    let got = rig.ask(&["SECRET_SPACE", "SECRET_NL", "UNSET_ONE", "READINESS_GATEWAY_ONLY"], Duration::from_secs(10)).expect("an answer");
    assert_eq!(
        env_of(&got),
        [("READINESS_GATEWAY_ONLY".to_string(), false), ("SECRET_NL".into(), true), ("SECRET_SPACE".into(), true), ("UNSET_ONE".into(), false)]
    );
    let text = format!("{got:?}");
    assert!(!text.contains("SENTINEL") && !text.contains("second line"), "{text}");
}

#[test]
fn a_forged_extra_frame_or_a_flood_on_fd3_is_refused() {
    let forged = "echo '00000000000000000000000000000000 {\"mode\":\"refresh\",\"env\":{\"A\":true},\"claude\":null}' >&3\n";
    assert_eq!(Rig::new("forge", forged).ask(&["A"], Duration::from_secs(10)), Err("probe_protocol"), "a second line is not a frame");
    let flood = "yes SENTINEL | head -c 100000 >&3\n";
    let got = Rig::new("flood", flood).ask(&["A"], Duration::from_secs(10));
    assert!(matches!(got, Err("probe_protocol") | Err("probe_failed")), "{got:?}");
}

#[test]
fn a_name_with_shell_syntax_runs_nothing() {
    let rig = Rig::new("syntax", "true\n");
    for name in ["$(touch PWNED)", "`touch PWNED`", "a;touch PWNED", "A B"] {
        assert_eq!(rig.ask(&[name], Duration::from_secs(10)), Err("probe_failed"), "{name}: the helper refuses and answers nothing");
    }
    assert!(!rig.home().join("PWNED").exists(), "nothing ran");
}

/// A CLI the helper runs never inherits fd 3: a `claude` whose detached
/// child lingers after it answered must not hold the gateway's read open
/// until the deadline (the helper marks fd 3 close-on-exec).
#[test]
fn a_lingering_child_of_a_cli_does_not_hold_the_answer_open() {
    use std::os::unix::fs::PermissionsExt;
    let rig = Rig::new("linger", "true\n");
    let pidfile = rig.root.join("sleeper.pid");
    let claude = rig.root.join("bin").join("claude");
    // The detached child records its pid BEFORE claude answers, so it is
    // running (in a session of its own, out of reach of the inner kill)
    // when the helper reads claude's exit; without that wait the inner kill
    // could reach it first and the test would prove nothing. `/bin/sh` by
    // path: the rig's `bin/sh` on this PATH is the fake login shell.
    std::fs::write(
        &claude,
        format!(
            "#!/bin/sh\nsetsid /bin/sh -c 'echo $$ > {p}; exec sleep 30' </dev/null >/dev/null 2>&1 &\nwhile [ ! -s {p} ]; do sleep 0.01; done\necho '{{\"loggedIn\":true,\"authMethod\":\"api_key\",\"apiProvider\":\"firstParty\"}}'\n",
            p = pidfile.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_dir = rig.root.join("cc");
    std::fs::create_dir_all(&config_dir).unwrap();
    let overlay = format!("{}:/usr/bin:/bin", rig.root.join("bin").display());
    let ask = Ask::Refresh { names: Vec::new(), claude_dir: Some(config_dir) };
    let t0 = Instant::now();
    let got = shell_probe(&rig.base(), Path::new(TMM), &overlay, &ask, Instant::now() + Duration::from_secs(12));
    let took = t0.elapsed();
    for _ in 0..50 {
        if pidfile.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let pid = std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<i32>().ok());
    if let Some(pid) = pid {
        // SAFETY: signalling the sleeper this test started.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
    assert!(pid.is_some(), "the lingering child really ran");
    match got {
        Ok(Frame::Refresh { claude: Some(c), .. }) => {
            assert_eq!((c.signed_in, c.method.as_deref(), c.provider.as_deref()), (Some(true), Some("api_key"), Some("first_party")));
        }
        other => panic!("{other:?}"),
    }
    assert!(took < Duration::from_secs(5), "the answer came at once, not at the deadline: {took:?}");
}

/// Reviewer P1-C: the ROOT probe's deadline ends everything the check
/// started. The helper is stopped (SIGSTOP) once its CLI runs, so its own
/// deadline can never fire; the outer kill must still end the CLI and the
/// CLI's child, and nothing outside the probe.
#[test]
fn the_outer_deadline_ends_the_helpers_cli_even_when_the_helper_hangs() {
    use std::os::unix::fs::PermissionsExt;
    let rig = Rig::new("stop", "true\n");
    let ids = rig.root.join("ids");
    let claude = rig.root.join("bin").join("claude");
    std::fs::write(
        &claude,
        format!("#!/bin/sh\n/bin/sleep 30 &\necho \"$$ $PPID $!\" > {}\nexec /bin/sleep 30\n", ids.display()),
    )
    .unwrap();
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config_dir = rig.root.join("cc");
    std::fs::create_dir_all(&config_dir).unwrap();
    let mut outside = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
    let overlay = format!("{}:/usr/bin:/bin", rig.root.join("bin").display());
    let base = rig.base();
    let probe = std::thread::spawn(move || {
        let ask = Ask::Refresh { names: Vec::new(), claude_dir: Some(config_dir) };
        shell_probe(&base, Path::new(TMM), &overlay, &ask, Instant::now() + Duration::from_secs(6))
    });
    let mut pids: Vec<i32> = Vec::new();
    for _ in 0..200 {
        if let Ok(t) = std::fs::read_to_string(&ids) {
            pids = t.split_whitespace().filter_map(|p| p.parse().ok()).collect();
            if pids.len() == 3 {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(pids.len(), 3, "the CLI ran and said who it is");
    let (cli, helper, child) = (pids[0], pids[1], pids[2]);
    // SAFETY: stopping the helper this test's probe started.
    unsafe { libc::kill(helper, libc::SIGSTOP) };
    assert_eq!(probe.join().unwrap(), Err("probe_timeout"));
    let gone = |pid: i32| {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).map_or(true, |s| s.rsplit(')').next().is_some_and(|r| r.trim_start().starts_with('Z')))
    };
    let mut ended = false;
    for _ in 0..100 {
        if [cli, helper, child].iter().all(|p| gone(*p)) {
            ended = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let alive = outside.try_wait().unwrap().is_none();
    let _ = outside.kill();
    let _ = outside.wait();
    for p in [cli, helper, child] {
        if !gone(p) {
            // SAFETY: cleaning up this test's own, still running, processes
            // if the check failed (a gone pid is never signalled: it may be
            // reused).
            unsafe { libc::kill(p, libc::SIGKILL) };
        }
    }
    assert!(ended, "the CLI {cli}, its child {child} and the helper {helper} ended with the outer deadline");
    assert!(alive, "a process outside the probe was not signalled");
}

/// The scratch the claude carry is written to, through the BUILT library
/// (no `cfg(test)`): the private writer the unit tests reach has a test-only
/// door, and the first version of this wrote through `write_private`, which
/// in a real gateway refuses any directory not under `.tmm` (seen on the
/// live rig: every baseline row read "a private scratch directory could not
/// be made").
#[test]
fn the_carry_scratch_is_written_privately_by_the_built_library() {
    use std::os::unix::fs::PermissionsExt;
    let s = Scratch::new().expect("a scratch dir");
    let dir = s.path().to_path_buf();
    let f = s.write("settings.json", "{\"env\":{}}").expect("written in a real build");
    assert_eq!(std::fs::read_to_string(&f).unwrap(), "{\"env\":{}}");
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(std::fs::metadata(&f).unwrap().permissions().mode() & 0o777, 0o600);
    drop(s);
    assert!(!dir.exists(), "removed with everything in it");
}

#[test]
fn an_rc_that_hangs_ends_at_the_deadline() {
    let rig = Rig::new("hang", "sleep 30\n");
    let t0 = Instant::now();
    assert_eq!(rig.ask(&["A"], Duration::from_secs(4)), Err("probe_timeout"));
    assert!(t0.elapsed() < Duration::from_secs(6), "took {:?}", t0.elapsed());
}
