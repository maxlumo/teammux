
/// codex's first-use trust dialog and its ready furniture: what a spawn's
/// waiter and a restart's ready edge (board #38) read. The ready mark is the
/// empty composer's own placeholder, on a FRESH codex and on a RESUMED one
/// (`codex resume <id>`, #29), measured on 0.166.0. The banner a fresh start
/// paints (`OpenAI Codex`, `Starting MCP servers`) is NOT on a resumed screen,
/// so a restart's ready edge never fired on it (round 1, validator P1-a).
/// Board #47: a resuming codex paints that placeholder while still
/// `Resuming session…` and drops an Enter typed then (7/7 saved failures).
/// Not ready while its native loading block shows (`resuming`): typing only
/// once it is gone submitted 15/15 mid-turn resumes, 6/6 idle resumes and a
/// fresh start.
/// A resuming codex's NATIVE loading block (board #47 round 1), read by
/// structure, measured on 0.166.0 in every frame of two resumes: the last
/// composer line (`› ` at column 0) has directly above it, blank lines
/// aside, `Resuming session…`, the header's second line (`loading` or the
/// folder) and the `>_ OpenAI Codex (v…)` header; and directly below it, no
/// status line: the next line with text is `? for shortcuts`. A loaded
/// composer has its status line (`<model> · <folder>…`) there, so even a
/// reply that reproduces the whole block is not read as loading, and the
/// phrase quoted anywhere else is just transcript (the reviewer's P1-R1,
/// reproduced live by validator: a substring held a loaded codex forever).
fn resuming(screen: &str) -> bool {
    let lines: Vec<&str> = screen.lines().collect();
    let Some(composer) = lines.iter().rposition(|l| l.starts_with("\u{203a} ")) else { return false };
    let mut above = lines[..composer].iter().rev().filter(|l| !l.trim().is_empty());
    let block = (above.next(), above.next(), above.next());
    let native = matches!(block, (Some(resume), Some(second), Some(header))
        if resume.trim() == "Resuming session\u{2026}"
            && second.starts_with("     ") && !second.trim().is_empty()
            && header.trim_start().starts_with(">_ OpenAI Codex (v"));
    let below = lines[composer + 1..].iter().find(|l| !l.trim().is_empty());
    native && below.is_some_and(|l| l.trim_start().starts_with("? for shortcuts"))
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) fn startup_confirmation() -> Option<shared::StartupConfirmation> {
    Some(shared::StartupConfirmation {
        markers: shared::CODEX_FOLDER_TRUST_MARKERS.to_vec(),
        ready_markers: vec!["Ask Codex to do anything"],
        loading: Some(resuming),
        accept_keys: vec!["Enter"],
        timeout: std::time::Duration::from_secs(120),
    })
}
