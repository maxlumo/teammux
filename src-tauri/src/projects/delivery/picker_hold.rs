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
/// marks the window for `release`. A screen that cannot be read is not a
/// picker: the other holds (#77's not-running, #38's start) answer for it.
pub(super) fn open(session: &str, window: &str) -> bool {
    let Some(backend) = super::recipe_backend(session, window).filter(|b| b.picker_holds_delivery()) else { return false };
    let Some(pane) = crate::tmux::find_window_by_name(session, window) else { return false };
    let open = backend.picker_open(&crate::tmux::capture_pane_plain(&pane, Some(0)).unwrap_or_default());
    if open {
        WAITING.lock().unwrap().insert((session.to_string(), window.to_string()));
    }
    open
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
