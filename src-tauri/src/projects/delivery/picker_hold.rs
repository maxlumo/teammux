//! A delivery waits while its codex pane shows one of codex's own pickers
//! (board #66): a line typed there answers the picker instead of reaching the
//! composer. Measured on codex-cli 0.166.0 in the live rig: a delivery typed
//! into `/new`'s "Where should the new conversation run?" had its `2` pick
//! "Create new Git worktree", and the rest of the line became the prompt.
//! The reading is the backend's own (`Backend::picker_open`); this module is
//! the hold and its release. A picker closes with no hook, so the capture
//! tick (`release`) is the trigger that notices it, besides the next
//! delivery and the feed read; it flushes only windows this hold kept, so no
//! other held line is released by a tick.

use std::collections::BTreeSet;
use std::sync::Mutex;

/// The windows whose held lines wait for a picker to close.
static WAITING: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());

/// Is a picker that holds deliveries open in `window` now? Read from its
/// visible screen, under the window lock (`strict_occupied`). An open one
/// marks the window for `release`. A screen that cannot be read counts as
/// open (round 2, reviewer): #77 establishes only that the CLI runs, not
/// that no menu is up, so only a successful read without one releases.
pub(super) fn open(session: &str, window: &str) -> bool {
    let Some(backend) = super::recipe_backend(session, window).filter(|b| b.picker_holds_delivery()) else { return false };
    let screen = crate::tmux::find_window_by_name(session, window)
        .ok_or_else(|| format!("no window '{window}'"))
        .and_then(|pane| crate::tmux::capture_pane_plain(&pane, Some(0)));
    // Test seam (round 2): only the capture fails; the pane, its process and the typing work.
    #[cfg(test)]
    let screen = if FAIL_CAPTURE.load(std::sync::atomic::Ordering::SeqCst) { Err("capture failed (test)".to_string()) } else { screen };
    let open = reads_open(backend, screen);
    if open {
        WAITING.lock().unwrap().insert((session.to_string(), window.to_string()));
    }
    open
}

#[cfg(test)]
pub(crate) static FAIL_CAPTURE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The decision on one read: a picker on a screen that was read, or a
/// screen that could not be read.
fn reads_open(backend: crate::backends::Backend, screen: Result<String, String>) -> bool {
    screen.map_or(true, |screen| backend.picker_open(&screen))
}

/// The capture tick's pass: each window held for a picker whose picker has
/// closed gets its held lines flushed by the one release rule (`flush`).
pub fn release() {
    let waiting: Vec<_> = WAITING.lock().unwrap().iter().cloned().collect();
    for (session, window) in waiting {
        if super::telemetry::held_rows(&session, &window).is_empty() || !open(&session, &window) {
            WAITING.lock().unwrap().remove(&(session.clone(), window.clone()));
            super::flush(&session, &window);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backends::Backend;

    /// Round 2 (reviewer): a capture that fails holds, and only a screen read
    /// without a menu releases.
    #[test]
    fn an_unread_screen_holds_and_only_a_read_without_a_menu_releases() {
        assert!(reads_open(Backend::Codex, Err("capture failed".into())));
        assert!(reads_open(Backend::Codex, Ok("  Where should the new conversation run?\n\n  enter select \u{b7} esc back\n".into())));
        assert!(!reads_open(Backend::Codex, Ok("\u{203a} Ask Codex to do anything\n\n  ? for shortcuts\n".into())));
    }
}
