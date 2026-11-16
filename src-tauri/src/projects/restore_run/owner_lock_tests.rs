//! Board #136 (diagnosed in the isolated runner, #136 notes): an OwnerLock dropped while ANY
//! thread of the process has a child between fork and exec stayed held. The child's copy of
//! the fd table keeps the lock's open file description referenced until its execve closes
//! it, and a flock is released only when the description's last reference closes. Measured:
//! a tmux `capture-pane` forked by a detached startup-confirmation thread held restore.lock
//! while a test, and in a gateway any thread, re-acquired it right after a drop, and got Busy.
use super::super::tests::use_test_store;
use super::OwnerLock;
use crate::flock::parked_child::ParkedChild;

#[test]
fn a_dropped_owner_lock_is_free_while_a_child_forked_under_it_has_not_exec_d_yet() {
    use_test_store();
    let held = OwnerLock::try_acquire().unwrap().expect("the lock is free");
    // The child itself says it is forked (holding the lease's description) and parked.
    let child = ParkedChild::spawn();
    drop(held);
    let again = OwnerLock::try_acquire().unwrap();
    assert!(again.is_some(), "a dropped lease is free at once, whatever a child still references");
    drop(again);
    drop(child);
}
