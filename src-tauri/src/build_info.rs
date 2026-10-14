//! The build's identity (board #368): which version, which commit, which
//! minute. The server says it in its login answer; the UI bakes its own the
//! same way (`src/lib/core/build-info.ts`), so a stale phone is a mismatch
//! someone can read instead of a guess.
//!
//! `COMMIT` is `dev` and `BUILT` is `unknown` when build.rs could not read
//! git or the clock (a source archive); they are never empty.

use serde_json::{json, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = match option_env!("TMM_GIT_SHA") {
    Some(sha) => sha,
    None => "dev",
};
pub const BUILT: &str = match option_env!("TMM_BUILD_TIME") {
    Some(at) => at,
    None => "unknown",
};

/// What a server tells about the build it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Build {
    pub version: String,
    pub commit: String,
    pub built: String,
}

impl Build {
    /// This binary's own build.
    pub fn ours() -> Build {
        Build { version: VERSION.into(), commit: COMMIT.into(), built: BUILT.into() }
    }

    /// `v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC`, the one line every surface
    /// speaks (the UI's `formatBuild` is the same words).
    pub fn line(&self) -> String {
        let built = if self.built == "unknown" { self.built.clone() } else { format!("{} UTC", self.built) };
        format!("v{} · {} · {}", self.version, self.commit, built)
    }
}

/// The login answer's `build` member.
pub fn json() -> Value {
    json!({ "version": VERSION, "commit": COMMIT, "built": BUILT })
}

/// Read a login answer's `build` back. None when it is absent or not three
/// plain strings (an older server sends none), never a partial build.
pub fn parse(answer_result: &Value) -> Option<Build> {
    let b = answer_result.get("build")?;
    let field = |k: &str| b.get(k)?.as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Some(Build { version: field("version")?, commit: field("commit")?, built: field("built")? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_build_is_never_empty_and_says_what_it_is() {
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
        assert!(!COMMIT.is_empty() && !BUILT.is_empty());
        let built_ok = BUILT == "unknown" || {
            let b = BUILT.as_bytes();
            b.len() == 16 && b[4] == b'-' && b[7] == b'-' && b[10] == b' ' && b[13] == b':'
                && BUILT.chars().filter(|c| c.is_ascii_digit()).count() == 12
        };
        assert!(built_ok, "BUILT is `YYYY-MM-DD HH:MM` UTC: {BUILT:?}");
        // The clock is this year or later (the formatter, not just its shape).
        assert!(BUILT == "unknown" || BUILT[..4].parse::<u32>().unwrap() >= 2026, "{BUILT}");
    }

    /// The commit is the CHECKOUT'S HEAD, read with the same command build.rs
    /// ran. Skipped only where git cannot answer (a source archive builds as
    /// `dev`). Without TMM_GIT_SHA in build.rs this reads `dev` and fails.
    #[test]
    fn the_commit_is_the_checkouts_head() {
        let head = std::process::Command::new("git")
            .args(["rev-parse", "--short=8", "HEAD"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output();
        let Ok(out) = head else { return };
        if !out.status.success() {
            assert_eq!(COMMIT, "dev", "no git: the build says dev");
            return;
        }
        let head = String::from_utf8(out.stdout).unwrap().trim().to_string();
        assert!(COMMIT.chars().all(|c| c.is_ascii_hexdigit()) && COMMIT.len() == 8, "{COMMIT}");
        // A later commit in this checkout moves HEAD past what a stale test
        // binary baked in; cargo reruns build.rs when HEAD moves, so equal.
        assert_eq!(COMMIT, head);
    }

    #[test]
    fn the_login_answer_round_trips_and_an_older_server_has_none() {
        let result = json!({ "authenticated": true, "build": json() });
        assert_eq!(parse(&result), Some(Build::ours()));
        assert_eq!(parse(&json!({ "authenticated": true, "machine_id": "m" })), None, "an older server sends none");
        for bad in [
            json!({ "build": "v1" }),
            json!({ "build": { "version": "1.0.0", "commit": "abc" } }),
            json!({ "build": { "version": "1.0.0", "commit": "", "built": "x" } }),
            json!({ "build": { "version": 1, "commit": "abc", "built": "x" } }),
        ] {
            assert_eq!(parse(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_line_is_the_words_the_ui_speaks() {
        let b = Build { version: "1.0.0".into(), commit: "46392f16".into(), built: "2026-10-14 07:40".into() };
        assert_eq!(b.line(), "v1.0.0 · 46392f16 · 2026-10-14 07:40 UTC");
        let unknown = Build { built: "unknown".into(), ..b };
        assert_eq!(unknown.line(), "v1.0.0 · 46392f16 · unknown");
    }
}
