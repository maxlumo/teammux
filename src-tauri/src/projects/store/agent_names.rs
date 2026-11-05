//! Agent labels (board #20): the logical names an agent has or had in a
//! project, beside its unchanged physical name.
//!
//! One family of the store (board #147). A row is one name: `agent` is the
//! PHYSICAL name (window, home, `TMM_AGENT`, every other store key), `name`
//! a label it has (`current = 1`) or had (`current = 0`, reserved and still
//! resolving, like `projects.prev_session`). Keyed by project ID, so a
//! project rename moves nothing, and gone with its project (ON DELETE
//! CASCADE). An agent with no current row is shown by its physical name.

use super::*;
use crate::address::Label;

impl Store {
    /// The v33 shape (also a heal floor): the `agent_names` table.
    pub(super) fn ensure_agent_names(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS agent_names (
                   project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                   agent      TEXT NOT NULL,
                   name       TEXT NOT NULL,
                   current    INTEGER NOT NULL DEFAULT 0,
                   set_at     INTEGER NOT NULL,
                   PRIMARY KEY (project_id, name)
                 );
                 CREATE INDEX IF NOT EXISTS agent_names_agent ON agent_names(project_id, agent);",
            )
            .map_err(|e| format!("ensure agent names: {e}"))
    }

    /// Every agent with a name row in `project_id`: its current label (its
    /// physical name after a reset) and its previous labels, in the order
    /// they were first given.
    pub fn agent_names(&self, project_id: &str) -> Result<Vec<Label>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT agent, name, current FROM agent_names WHERE project_id = ?1 ORDER BY rowid")
            .map_err(|e| format!("read agent names: {e}"))?;
        let rows = stmt
            .query_map(params![project_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0)))
            .map_err(|e| format!("read agent names: {e}"))?;
        let mut out: Vec<Label> = Vec::new();
        for row in rows {
            let (agent, name, current) = row.map_err(|e| format!("read agent names: {e}"))?;
            let i = match out.iter().position(|l| l.agent == agent) {
                Some(i) => i,
                None => {
                    out.push(Label { agent: agent.clone(), label: agent.clone(), aliases: Vec::new() });
                    out.len() - 1
                }
            };
            if current { out[i].label = name } else { out[i].aliases.push(name) }
        }
        Ok(out)
    }

    /// Which agent has or had `name` as a label in any project declared at
    /// `path` (board #20): what a NEW physical name must not be.
    pub fn label_holder(&self, path: &str, name: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT n.agent FROM agent_names n JOIN projects p ON p.id = n.project_id
                  WHERE p.path = ?1 AND n.name = ?2 LIMIT 1",
                params![path, name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("check agent labels: {e}"))
    }

    /// Give `agent` the label `label` in `project_id` (None or its own
    /// physical name = reset). Its current label, if any, becomes a previous
    /// one. A name another agent has or had here is refused, naming that
    /// agent, and nothing is written. One transaction.
    pub fn set_agent_label(&self, project_id: &str, agent: &str, label: Option<&str>, now: u64) -> Result<(), String> {
        let label = label.filter(|l| *l != agent);
        let tx = self.conn.unchecked_transaction().map_err(|e| format!("rename agent transaction: {e}"))?;
        if let Some(l) = label {
            let holder: Option<String> = tx
                .query_row("SELECT agent FROM agent_names WHERE project_id = ?1 AND name = ?2", params![project_id, l], |r| r.get(0))
                .optional()
                .map_err(|e| format!("check agent name: {e}"))?;
            if let Some(h) = holder.filter(|h| h != agent) {
                return Err(format!("'{l}' is already a name of agent '{h}' in this project"));
            }
        }
        tx.execute("UPDATE agent_names SET current = 0 WHERE project_id = ?1 AND agent = ?2 AND current = 1", params![project_id, agent])
            .map_err(|e| format!("rename agent: {e}"))?;
        if let Some(l) = label {
            tx.execute(
                "INSERT INTO agent_names (project_id, agent, name, current, set_at) VALUES (?1, ?2, ?3, 1, ?4)
                 ON CONFLICT(project_id, name) DO UPDATE SET current = 1, set_at = excluded.set_at",
                params![project_id, agent, l, now as i64],
            )
            .map_err(|e| format!("rename agent: {e}"))?;
        }
        tx.commit().map_err(|e| format!("commit agent rename: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::project;
    use super::*;

    fn store() -> Store {
        let s = Store::open_memory().unwrap();
        s.insert_project(&project("p")).unwrap();
        s.insert_project(&project("q")).unwrap();
        s
    }

    fn names(s: &Store, p: &str) -> Vec<(String, String, Vec<String>)> {
        s.agent_names(p).unwrap().into_iter().map(|l| (l.agent, l.label, l.aliases)).collect()
    }

    fn row(agent: &str, label: &str, aliases: &[&str]) -> (String, String, Vec<String>) {
        (agent.into(), label.into(), aliases.iter().map(|a| a.to_string()).collect())
    }

    /// Board #20: a rename sets the label; a second keeps the first as a
    /// previous label; a reset shows the physical name and keeps both; going
    /// back to a previous label makes it current again. Per project.
    #[test]
    fn a_rename_keeps_every_previous_label_and_a_reset_shows_the_physical_name() {
        let s = store();
        assert_eq!(names(&s, "p"), []);
        s.set_agent_label("p", "builder", Some("bob"), 1).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "bob", &[])]);
        s.set_agent_label("p", "builder", Some("robert"), 2).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "robert", &["bob"])]);
        s.set_agent_label("p", "builder", None, 3).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "builder", &["bob", "robert"])], "reset: physical name shown, both reserved");
        s.set_agent_label("p", "builder", Some("bob"), 4).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "bob", &["robert"])], "a previous label can be current again");
        s.set_agent_label("p", "builder", Some("builder"), 5).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "builder", &["bob", "robert"])], "its own physical name is a reset");
        s.set_agent_label("p", "builder", Some("bob"), 6).unwrap();
        s.set_agent_label("p", "builder", Some("bob"), 7).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "bob", &["robert"])], "the same label twice changes nothing");
        assert_eq!(names(&s, "q"), [], "another project is untouched");
    }

    /// Board #20: a name another agent has or had in the project is refused,
    /// whether current or previous; the same name in another project is free.
    #[test]
    fn a_label_another_agent_has_or_had_is_refused() {
        let s = store();
        s.set_agent_label("p", "builder", Some("bob"), 1).unwrap();
        s.set_agent_label("p", "builder", Some("robert"), 2).unwrap();
        for taken in ["bob", "robert"] {
            let e = s.set_agent_label("p", "validator", Some(taken), 3).unwrap_err();
            assert_eq!(e, format!("'{taken}' is already a name of agent 'builder' in this project"));
        }
        assert_eq!(names(&s, "p"), [row("builder", "robert", &["bob"])], "a refusal writes nothing");
        s.set_agent_label("q", "validator", Some("bob"), 3).unwrap();
        assert_eq!(names(&s, "q"), [row("validator", "bob", &[])]);
    }

    /// Board #20 (orchestrator 13:35): removing an agent deletes its names in
    /// the same transaction as its slot, so a later agent with the same
    /// physical name inherits none of them and they are free again. A
    /// deleted project takes its names with it.
    #[test]
    fn removing_an_agent_frees_its_names_and_a_deleted_project_takes_them() {
        let mut s = store();
        s.replace_slots("p", &[super::test_support::slot("builder", 0), super::test_support::slot("validator", 1)]).unwrap();
        s.set_agent_label("p", "builder", Some("coder"), 1).unwrap();
        s.set_agent_label("p", "builder", Some("bob"), 2).unwrap();
        s.set_agent_label("p", "validator", Some("val"), 2).unwrap();
        assert!(s.delete_slot("p", "builder").unwrap());
        assert_eq!(names(&s, "p"), [row("validator", "val", &[])], "only the removed agent's names go");
        s.set_agent_label("p", "validator", Some("coder"), 3).unwrap();
        assert_eq!(names(&s, "p"), [row("validator", "coder", &["val"])], "a removed agent's label is free again");
        s.set_agent_label("q", "x", Some("y"), 3).unwrap();
        assert!(s.delete_project("q").unwrap());
        let left: i64 = s.conn.query_row("SELECT COUNT(*) FROM agent_names WHERE project_id = 'q'", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0, "ON DELETE CASCADE");
    }

    /// Board #20: a v32 database migrates to the table (non-negotiable 9: the
    /// ladder runs with foreign_keys OFF, set by `init`), keeps its rows, and
    /// the table then works.
    #[test]
    fn a_v32_database_migrates_to_agent_names() {
        let s = store();
        s.conn.execute_batch("DROP TABLE agent_names; PRAGMA user_version = 32;").unwrap();
        let conn = s.conn;
        let s = Store::init(conn).unwrap();
        let v: i64 = s.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert!(v >= 33);
        assert!(s.project("p").unwrap().is_some(), "existing rows kept");
        s.set_agent_label("p", "builder", Some("bob"), 1).unwrap();
        assert_eq!(names(&s, "p"), [row("builder", "bob", &[])]);
    }
}
