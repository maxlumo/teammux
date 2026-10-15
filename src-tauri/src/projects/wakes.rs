//! Waking an agent later (board #275): a room message scheduled for a time.
//!
//! Owner, 2026-09-29 08:04: agents sit in `sleep` waiting for long jobs. A
//! sleep blocks the turn and burns context; a wake lets the agent end its
//! turn and be typed into again when the time comes — itself, a teammate or
//! the human's addressee. `tmm send "@name text" --in 10m | --at 14:30`.
//!
//! - **A declaration** (`store::Wake`, state.db v29): survives a server
//!   restart; the one sleeper below is its disposable projection.
//! - **One fire path**: at `due_at` the server posts `[wake] text` as the
//!   scheduler and delivers it through `deliver_mentions`, so busy / queue /
//!   steer and team context apply exactly as for a line sent now. Recipients
//!   are resolved at fire time.
//! - **At most once**: a fire CLAIMS the row before posting; a restart fires
//!   every past-due row once, marked late (orchestrator 08:20: no drop window,
//!   the 7-day bound caps it).
//! - **Cancel**: the scheduler or the human; a teammate cannot cancel your
//!   reminder (orchestrator 08:20 A).

use super::store::Wake;

/// The furthest ahead a wake may be set (orchestrator 08:20: this bound is
/// also what caps a late fire after downtime).
pub const MAX_AHEAD_SECS: i64 = 7 * 24 * 3600;
/// How far in the past `due` may already be when scheduled: a task-end wake
/// is due NOW, and clocks between `tmm` and the server may differ a little.
const SLACK_SECS: i64 = 60;
/// Pending wakes per project: a runaway loop must not fill state.db.
pub const MAX_PENDING: usize = 50;
/// Past due by more than this when fired = said to be late.
pub const LATE_SECS: i64 = 60;

fn now() -> i64 {
    super::now() as i64
}

/// Schedule `body` from `sender` in `session` at `due` (unix seconds).
/// The body must address someone and must not be a `/command` (orchestrator
/// 08:20: a scheduled command is not supported yet).
pub fn schedule(session: &str, sender: &str, body: &str, due: i64) -> Result<Wake, String> {
    let body = body.trim();
    if crate::address::mention_names(body).is_empty() {
        return Err("a wake needs a recipient such as @name, @all or @human".into());
    }
    if crate::address::slash_command(body).is_some_and(|(to, _)| !to.is_empty()) {
        return Err("a scheduled /command is not supported; schedule a message".into());
    }
    let now = now();
    if due < now - SLACK_SECS {
        return Err("that time has already passed".into());
    }
    if due > now + MAX_AHEAD_SECS {
        return Err("a wake can be at most 7 days ahead".into());
    }
    let wake = super::with_store(|s| {
        if s.pending_wakes(Some(session))?.len() >= MAX_PENDING {
            return Err(format!("{MAX_PENDING} wakes are already pending in this project; cancel one first"));
        }
        let id = s.insert_wake(session, sender, body, due, now)?;
        s.wake(id)?.ok_or_else(|| "the wake vanished".to_string())
    })?;
    kick();
    Ok(wake)
}

/// Cancel wake `id` of `session`, asked by `by`.
pub fn cancel(session: &str, id: i64, by: &str) -> Result<(), String> {
    super::with_store(|s| {
        let Some(w) = s.wake(id)?.filter(|w| w.session == session) else {
            return Err(format!("no pending wake #{id} in this project"));
        };
        if by != w.sender && by != "human" {
            return Err(format!("wake #{id} was set by {}; only they or the human can cancel it", w.sender));
        }
        if !s.cancel_wake(id, now())? {
            return Err(format!("wake #{id} has just fired"));
        }
        Ok(())
    })?;
    kick();
    Ok(())
}

/// Pending wakes, soonest first: one project's, or every project's. A store
/// that cannot be read reads as none — right for a list a person looks at; a
/// caller that ACTS on "there is none" asks `try_pending`.
pub fn pending(session: Option<&str>) -> Vec<Wake> {
    try_pending(session).unwrap_or_default()
}

/// `pending`, but "could not read the store" is an error and not "no wakes".
pub fn try_pending(session: Option<&str>) -> Result<Vec<Wake>, String> {
    super::with_store(|s| s.pending_wakes(session))
}

/// Does wake `w` address `name`? The ONE reading of a wake's recipients: a
/// `@name` that names it, or `@all` (`schedule` accepts `@all`, and a fired
/// wake reaches every managed agent). The card's "next wake" and the stall
/// nudge both ask this, so neither keeps a narrower second definition.
pub fn addressed_to(w: &Wake, name: &str) -> bool {
    crate::address::mention_names(&w.body).iter().any(|m| m == name || m == "all")
}

/// The body a fired wake posts: the `[wake]` marker in the `[reply]` shape
/// (orchestrator 08:20), and when a restart fires it late, when it was due.
pub fn fired_body(w: &Wake, now: i64) -> String {
    if now - w.due_at > LATE_SECS {
        let due = chrono::DateTime::from_timestamp(w.due_at, 0)
            .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_default();
        format!("[wake] {} (late: was due {due})", w.body)
    } else {
        format!("[wake] {}", w.body)
    }
}

/// Claim wake `id` for firing and return its row AS IT IS NOW — for exactly
/// one caller. The claim and the read are one store transaction-free step
/// under the store lock, so a rename (which moves the row's session in its
/// own transaction) lands wholly before or after; the fire uses what this
/// returns, never the sleeper's earlier snapshot (validator 09:54).
pub fn claim(id: i64) -> Option<Wake> {
    super::with_store(|s| if s.claim_wake(id, now())? { s.wake_row(id) } else { Ok(None) }).ok().flatten()
}

fn notify() -> &'static tokio::sync::Notify {
    static N: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    N.get_or_init(tokio::sync::Notify::new)
}

/// Wake the sleeper: the earliest due time may have changed.
fn kick() {
    notify().notify_one();
}

/// The one sleeper: waits until the earliest pending wake is due (or a
/// schedule / cancel changes that), then hands its ID to `fire` on a
/// blocking thread. It holds only the id and the due time; `fire` claims the
/// row and reads it (`claim`). No tick. At start the earliest rows are
/// already due, so a restart fires every missed wake once, in due order.
pub async fn run(fire: fn(i64)) {
    loop {
        let changed = notify().notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        let next = tokio::task::spawn_blocking(|| pending(None).into_iter().next()).await.ok().flatten();
        match next.map(|w| (w.id, w.due_at)) {
            None => changed.await,
            Some((id, due_at)) => {
                let wait = due_at - now();
                if wait <= 0 {
                    let _ = tokio::task::spawn_blocking(move || fire(id)).await;
                    // A fire that could not claim (a store error) leaves the
                    // row pending: back off instead of spinning on it.
                    let stuck = tokio::task::spawn_blocking(move || pending(None).first().is_some_and(|n| n.id == id)).await.unwrap_or(false);
                    if stuck {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                } else {
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(wait as u64)) => {}
                        _ = &mut changed => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> String {
        super::super::tests::use_test_store();
        format!("wake-{}", uuid::Uuid::new_v4())
    }

    #[test]
    fn scheduling_checks_the_body_the_time_and_the_cap() {
        let s = session();
        let now = now();
        assert!(schedule(&s, "lead", "no address", now + 60).unwrap_err().contains("recipient"));
        assert!(schedule(&s, "lead", "@dev /compact", now + 60).unwrap_err().contains("/command"));
        assert!(schedule(&s, "lead", "@dev x", now - 3600).unwrap_err().contains("passed"));
        assert!(schedule(&s, "lead", "@dev x", now + MAX_AHEAD_SECS + 60).unwrap_err().contains("7 days"));
        let w = schedule(&s, "lead", "  @dev check the build  ", now + 600).unwrap();
        assert_eq!((w.sender.as_str(), w.body.as_str(), w.due_at), ("lead", "@dev check the build", now + 600));
        assert!(schedule(&s, "lead", "@dev due now (a task end)", now).is_ok());
        for i in 2..MAX_PENDING {
            schedule(&s, "lead", &format!("@dev {i}"), now + 60).unwrap();
        }
        assert!(schedule(&s, "lead", "@dev one too many", now + 60).unwrap_err().contains("already pending"));
    }

    /// Orchestrator 08:20 (A): the scheduler or the human cancels, a
    /// teammate cannot; another project's wake is not found.
    #[test]
    fn only_the_scheduler_or_the_human_cancels() {
        let s = session();
        let w = schedule(&s, "lead", "@dev a", now() + 600).unwrap();
        assert!(cancel(&s, w.id, "dev").unwrap_err().contains("only they or the human"));
        assert!(cancel("other-project", w.id, "lead").unwrap_err().contains("no pending wake"));
        cancel(&s, w.id, "lead").unwrap();
        assert!(cancel(&s, w.id, "lead").unwrap_err().contains("no pending wake"), "gone once cancelled");
        let h = schedule(&s, "lead", "@dev b", now() + 600).unwrap();
        cancel(&s, h.id, "human").unwrap();
        assert!(pending(Some(&s)).is_empty());
    }

    static FIRED: std::sync::Mutex<Vec<i64>> = std::sync::Mutex::new(Vec::new());
    fn record(id: i64) {
        if let Some(w) = claim(id) {
            FIRED.lock().unwrap().push(w.id);
        }
    }

    /// The sleeper: at start every past-due wake fires once, in due order
    /// (a restart); a wake scheduled while it sleeps is picked up without a
    /// tick; a cancelled one never fires.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_sleeper_fires_missed_wakes_once_then_new_ones_on_time() {
        let s = session();
        let now = now();
        let (late_b, late_a) = super::super::with_store(|st| {
            Ok((st.insert_wake(&s, "lead", "@dev b", now - 3000, now - 4000)?, st.insert_wake(&s, "lead", "@dev a", now - 5000, now - 6000)?))
        })
        .unwrap();
        let task = tokio::spawn(run(record));
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let soon = tokio::task::spawn_blocking({
            let s = s.clone();
            move || schedule(&s, "lead", "@dev soon", now + 2).unwrap()
        })
        .await
        .unwrap();
        let gone = tokio::task::spawn_blocking({
            let s = s.clone();
            move || {
                let w = schedule(&s, "lead", "@dev never", now + 2).unwrap();
                cancel(&s, w.id, "lead").unwrap();
                w
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(3500)).await;
        task.abort();
        let mine: Vec<i64> = FIRED.lock().unwrap().iter().copied().filter(|id| [late_a, late_b, soon.id, gone.id].contains(id)).collect();
        assert_eq!(mine, vec![late_a, late_b, soon.id], "missed ones once in due order, then the new one; never the cancelled one");
        assert!(pending(Some(&s)).is_empty());
    }

    #[test]
    fn a_wake_addresses_its_names_and_everyone_for_all() {
        let wake = |body: &str| Wake { id: 1, session: "s".into(), sender: "lead".into(), body: body.into(), due_at: 0, created_at: 0 };
        assert!(addressed_to(&wake("@dev check the build"), "dev"));
        assert!(!addressed_to(&wake("@dev check the build"), "qa"));
        assert!(addressed_to(&wake("@all stand-up"), "qa"), "@all reaches every agent");
        assert!(addressed_to(&wake("@qa @dev both"), "dev"));
        assert!(!addressed_to(&wake("mail dev@qa.example"), "qa"), "an address is not a mention");
    }

    #[test]
    fn a_late_fire_says_when_it_was_due() {
        let w = Wake { id: 1, session: "s".into(), sender: "lead".into(), body: "@dev go".into(), due_at: 1_000_000, created_at: 0 };
        assert_eq!(fired_body(&w, 1_000_030), "[wake] @dev go");
        let late = fired_body(&w, 1_000_000 + 3600);
        assert!(late.starts_with("[wake] @dev go (late: was due "), "{late}");
    }
}
