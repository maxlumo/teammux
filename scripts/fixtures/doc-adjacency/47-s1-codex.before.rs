
/// codex's first-use trust dialog and its ready furniture: what a spawn's
/// waiter and a restart's ready edge (board #38) read. The ready mark is the
/// empty composer's own placeholder, on a FRESH codex and on a RESUMED one
/// (`codex resume <id>`, #29), measured on 0.166.0. The banner a fresh start
/// paints (`OpenAI Codex`, `Starting MCP servers`) is NOT on a resumed screen,
/// so a restart's ready edge never fired on it (round 1, validator P1-a).
/// Board #47: a resuming codex paints that placeholder while still
/// `Resuming session…` and drops an Enter typed then (7/7 saved failures).
/// Not ready while it shows: typing only once it is gone submitted 15/15
/// mid-turn resumes, 6/6 idle resumes and a fresh start.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn startup_confirmation() -> Option<shared::StartupConfirmation> {
    Some(shared::StartupConfirmation {
        markers: shared::CODEX_FOLDER_TRUST_MARKERS.to_vec(),
        ready_markers: vec!["Ask Codex to do anything"],
        not_ready_markers: vec!["Resuming session"],
        accept_keys: vec!["Enter"],
        timeout: std::time::Duration::from_secs(120),
    })
}
