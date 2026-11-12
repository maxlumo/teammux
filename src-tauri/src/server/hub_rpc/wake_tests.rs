//! Board #122: a due wake is never consumed when its room line could not be stored: the
//! claim and the line are one store transaction, a failure keeps the wake due, and the
//! sleeper's next try fires it once. In a file of its own because hub_rpc.rs is over
//! code-quality.md's 2000-line limit.

use super::*;
use crate::projects::rooms;
use super::tests::project_with;

/// The room INSERT is rejected (a TEMP trigger on the test store's connection; the suite
/// is sequential), the rest of the store stays up. Dropped on drop, even on a panic.
struct RoomInsertsRejected;
impl RoomInsertsRejected {
    fn now() -> RoomInsertsRejected {
        crate::projects::restore_hold::with_store_for_test(|s| s.exec_test_sql("CREATE TEMP TRIGGER no_room_lines_122 BEFORE INSERT ON hub_msgs BEGIN SELECT RAISE(ABORT, 'the room line cannot be stored'); END;")).unwrap();
        RoomInsertsRejected
    }
}
impl Drop for RoomInsertsRejected {
    fn drop(&mut self) {
        let _ = crate::projects::restore_hold::with_store_for_test(|s| s.exec_test_sql("DROP TRIGGER IF EXISTS no_room_lines_122;"));
    }
}

/// Validator's case (#122, measured on 83b358cc): the room line cannot be stored. Before,
/// the wake was claimed first and the post failed after, so it was consumed with no line
/// and no retry. Now nothing is stored at all: the wake is still due, with no room row and
/// no claim; with the store well again the next try fires it once, in its project's room.
#[test]
fn a_wake_whose_room_line_cannot_be_stored_stays_due_and_fires_once_later() {
    let session = project_with(&["lead"]);
    let project = crate::projects::project_for_session(&session).unwrap().unwrap();
    let room = crate::projects::rooms::session_room(&session);
    let w = crate::projects::wakes::schedule(&session, "lead", "@lead check the build", crate::projects::now() as i64).unwrap();
    let lines = |r: &str| -> usize {
        rooms::history_page(r, None, 50)["messages"].as_array().unwrap().iter().filter(|m| m["body"].as_str().unwrap_or("").contains("check the build")).count()
    };
    {
        let _rejected = RoomInsertsRejected::now();
        fire_wake(w.id);
    }
    assert_eq!(lines(&room), 0, "no line was stored");
    assert!(crate::projects::wakes::pending(None).iter().any(|p| p.id == w.id), "still due: the claim rolled back with the line");
    fire_wake(w.id);
    assert_eq!(lines(&room), 1, "fired once, in the project's room");
    assert!(!crate::projects::wakes::pending(None).iter().any(|p| p.id == w.id), "and consumed now");
    fire_wake(w.id);
    assert_eq!(lines(&room), 1, "a second fire of the same wake stores nothing");
    crate::projects::restore_hold::with_store_for_test(|s| s.delete_project(&project.id)).ok();
}
