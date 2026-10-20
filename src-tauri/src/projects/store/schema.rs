//! The schema: version ladder, migrations and the on-open repairs.
//!
//! One family of the store (board #147): an `impl Store` block over the same
//! connection, the same migration ladder, the same tests — only the file moved.

use super::*;
// The v18 step backfills the omp default from the registry's own seed text.
use super::registry::{DEFAULT_KIMI_SYSTEM, DEFAULT_OMP_MODEL, DEFAULT_OMP_SYSTEM};

/// Bumped when the schema changes; `migrate` is the only place that knows the
/// steps. Stored in SQLite's own `user_version` pragma.
const SCHEMA_VERSION: i64 = 31;

impl Store {
    /// Ensure the durable half of Board editability exists, then
    /// conservatively backfill evidence an Agent already processed the issue.
    /// Current assignment is checked separately at read/write time: assigning
    /// and then undoing it before the Agent acts may legitimately reopen text.
    pub(super) fn ensure_issue_edit_lock(&self) -> Result<(), String> {
        let has_column: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM pragma_table_info('issues')
                    WHERE name = 'agent_touched'
                 )",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect Board edit lock: {e}"))?;
        if !has_column {
            self.conn
                .execute_batch(
                    "ALTER TABLE issues ADD COLUMN agent_touched INTEGER NOT NULL DEFAULT 0;
                     UPDATE issues
                        SET agent_touched = 1
                      WHERE status <> 'todo'
                         OR created_by <> 'human'
                         OR EXISTS (
                           SELECT 1 FROM issue_notes n
                            WHERE n.issue_id = issues.id AND n.author <> 'human'
                         );",
                )
                .map_err(|e| format!("add/backfill Board edit lock: {e}"))?;
        }
        Ok(())
    }

    /// Ensure every visible Board number is project/session-local while the
    /// original `issues.id` remains an invisible database row key for notes.
    /// A separate sequence remembers deleted high numbers, matching
    /// AUTOINCREMENT semantics independently for every project.
    pub(super) fn ensure_issue_numbering(&self) -> Result<(), String> {
        let has_column: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM pragma_table_info('issues')
                    WHERE name = 'project_number'
                 )",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect Board project numbers: {e}"))?;
        if !has_column {
            // SQLite cannot add a NOT NULL column to a populated table without
            // a fabricated default. Add nullable, then fill deterministically
            // by the old global row order inside EACH session.
            self.conn
                .execute_batch("ALTER TABLE issues ADD COLUMN project_number INTEGER;")
                .map_err(|e| format!("add Board project number: {e}"))?;
        }
        // Idempotent partial-migration repair. When every row is NULL (the
        // normal v15→v16 ALTER), this is the dense 1..N rank. If an older
        // binary later inserted NULL rows into an already-numbered v16 table,
        // start after BOTH the visible maximum and the durable sequence —
        // never collide with a gap or reuse a deleted high number.
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS issue_sequences (
                   session     TEXT PRIMARY KEY,
                   next_number INTEGER NOT NULL
                 );
                 UPDATE issues
                    SET project_number = MAX(
                          COALESCE((
                            SELECT MAX(numbered.project_number)
                              FROM issues numbered
                             WHERE numbered.session = issues.session
                               AND numbered.project_number IS NOT NULL
                          ), 0),
                          COALESCE((
                            SELECT seq.next_number - 1
                              FROM issue_sequences seq
                             WHERE seq.session = issues.session
                          ), 0)
                        ) + (
                          SELECT COUNT(*)
                            FROM issues pending
                           WHERE pending.session = issues.session
                             AND pending.project_number IS NULL
                             AND pending.id <= issues.id
                        )
                  WHERE project_number IS NULL;
                 CREATE UNIQUE INDEX IF NOT EXISTS issues_session_number
                   ON issues(session, project_number);
                 INSERT INTO issue_sequences (session, next_number)
                   SELECT session, MAX(project_number) + 1
                     FROM issues
                    GROUP BY session
                 ON CONFLICT(session) DO UPDATE SET
                   next_number = MAX(issue_sequences.next_number, excluded.next_number);",
            )
            .map_err(|e| format!("heal Board project numbers: {e}"))
    }

    pub(super) fn migrate(&mut self) -> Result<(), String> {
        let version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| format!("read user_version: {e}"))?;
        if version >= SCHEMA_VERSION {
            return Ok(());
        }
        // Every pending step and the version stamp in ONE transaction. Each
        // step used to autocommit on its own and `user_version` was written
        // last, so a failure after step k left a database that was HALF
        // migrated but still stamped old: the next open re-ran step k, hit
        // "table already exists" (the plain CREATEs are not idempotent) and
        // `Store::open` failed for ever — every project and hub RPC with it.
        // With the transaction the database is either fully at
        // SCHEMA_VERSION or exactly as it was. `PRAGMA foreign_keys` is set by
        // `init` BEFORE this point because SQLite ignores it inside a
        // transaction, which is also why no step may toggle it.
        self.conn
            .execute_batch("BEGIN IMMEDIATE;")
            .map_err(|e| format!("begin migration: {e}"))?;
        let stamped = self.migrate_steps(version).and_then(|()| {
            self.conn
                .pragma_update(None, "user_version", SCHEMA_VERSION)
                .map_err(|e| format!("set user_version: {e}"))
        });
        match stamped {
            Ok(()) => self
                .conn
                .execute_batch("COMMIT;")
                .map_err(|e| format!("commit migration: {e}")),
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    /// The version steps, oldest first, each guarded by `version < N`. Runs
    /// inside the transaction `migrate` opened — never call it directly.
    pub(super) fn migrate_steps(&self, version: i64) -> Result<(), String> {
        if version < 1 {
            self.conn
                .execute_batch(
                    "CREATE TABLE projects (
                       id           TEXT PRIMARY KEY,
                       name         TEXT NOT NULL,
                       path         TEXT NOT NULL UNIQUE,
                       icon         TEXT,
                       session      TEXT NOT NULL,
                       adopted      INTEGER NOT NULL DEFAULT 0,
                       autostart    INTEGER NOT NULL DEFAULT 0,
                       created_at   INTEGER NOT NULL,
                       last_up_at   INTEGER,
                       last_seen_at INTEGER,
                       archived_at  INTEGER
                     );
                     CREATE TABLE slots (
                       id            INTEGER PRIMARY KEY,
                       project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                       ord           INTEGER NOT NULL,
                       window_name   TEXT NOT NULL,
                       cwd           TEXT NOT NULL DEFAULT '',
                       kind          TEXT NOT NULL,
                       command       TEXT,
                       auto_run      INTEGER NOT NULL DEFAULT 0,
                       first_seen_at INTEGER NOT NULL,
                       settled_at    INTEGER,
                       UNIQUE (project_id, window_name)
                     );
                     CREATE TABLE snapshots (
                       id            INTEGER PRIMARY KEY,
                       project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                       at            INTEGER NOT NULL,
                       topology_json TEXT NOT NULL
                     );
                     CREATE INDEX snapshots_project ON snapshots(project_id, at DESC);",
                )
                .map_err(|e| format!("migrate to 1: {e}"))?;
        }
        if version < 2 {
            // v1 made `path` unique, which was wrong: two sessions may
            // legitimately sit in the same directory (several of them parked in
            // $HOME is the normal case), and adopting the second one failed with
            // "already project X". A project's identity is its SESSION — that is
            // the thing it projects onto, and two projects fighting over one
            // session name is the real conflict. Paths are merely indexed.
            self.conn
                .execute_batch(
                    "CREATE TABLE projects_v2 (
                       id           TEXT PRIMARY KEY,
                       name         TEXT NOT NULL,
                       path         TEXT NOT NULL,
                       icon         TEXT,
                       session      TEXT NOT NULL UNIQUE,
                       adopted      INTEGER NOT NULL DEFAULT 0,
                       autostart    INTEGER NOT NULL DEFAULT 0,
                       created_at   INTEGER NOT NULL,
                       last_up_at   INTEGER,
                       last_seen_at INTEGER,
                       archived_at  INTEGER
                     );
                     INSERT INTO projects_v2
                       SELECT id, name, path, icon, session, adopted, autostart,
                              created_at, last_up_at, last_seen_at, archived_at
                         FROM projects;
                     DROP TABLE projects;
                     ALTER TABLE projects_v2 RENAME TO projects;
                     CREATE INDEX projects_path ON projects(path);",
                )
                .map_err(|e| format!("migrate to 2: {e}"))?;
        }
        if version < 3 {
            // Remember which conversation each agent window was in, so `up`
            // resumes it instead of starting over.
            self.conn
                .execute_batch("ALTER TABLE slots ADD COLUMN agent_session_id TEXT;")
                .map_err(|e| format!("migrate to 3: {e}"))?;
        }
        if version < 4 {
            // Topology snapshots are gone. The declaration IS the last observed
            // state — closing a project does not touch it and a restart reads it
            // back — so a 20-deep history answered a question nobody had, while
            // `restore` could not even deliver: it rewrote the declaration
            // without projecting it, and on a live project the next capture tick
            // threw that away because live tmux is the truth. Two days of real
            // use produced exactly one snapshot per project: the one written at
            // adopt, identical to the current declaration.
            self.conn
                .execute_batch("DROP TABLE IF EXISTS snapshots;")
                .map_err(|e| format!("migrate to 4: {e}"))?;
        }
        if version < 5 {
            // Agents-v2: the agent registry. One centrally-defined agent =
            // backend + persona + skills + MCP servers + hire permission,
            // materialized into an ISOLATED per-agent home at spawn time so the
            // user's global CLI config never interferes. Skills are string refs
            // (local name or github url — resolved by the shared skills
            // resolver); MCP servers are embedded JSON defs. Both live in the
            // agent row: composition is by value here, the assets themselves
            // are external (skill dirs / the MCP servers they point at).
            self.conn
                .execute_batch(
                    "CREATE TABLE reg_agents (
                       name       TEXT PRIMARY KEY,
                       backend    TEXT NOT NULL,
                       model      TEXT NOT NULL DEFAULT '',
                       system     TEXT NOT NULL DEFAULT '',
                       skills     TEXT NOT NULL DEFAULT '[]',
                       mcp        TEXT NOT NULL DEFAULT '[]',
                       can_hire   INTEGER NOT NULL DEFAULT 0,
                       created_at INTEGER NOT NULL,
                       updated_at INTEGER NOT NULL
                     );",
                )
                .map_err(|e| format!("migrate to 5: {e}"))?;
        }
        if version < 6 {
            // Skills and MCP servers become first-class central assets
            // (owner: "集中化管理"): define once, reference from any agent by
            // NAME. A skill entry maps a name to a resolvable ref (local dir
            // or github url); an mcp entry holds the server def JSON. Agent
            // defs keep their existing columns — string entries in them now
            // resolve through these tables at spawn, inline values still work.
            self.conn
                .execute_batch(
                    "CREATE TABLE reg_skills (
                       name        TEXT PRIMARY KEY,
                       ref_        TEXT NOT NULL,
                       description TEXT NOT NULL DEFAULT '',
                       updated_at  INTEGER NOT NULL
                     );
                     CREATE TABLE reg_mcp (
                       name       TEXT PRIMARY KEY,
                       def        TEXT NOT NULL,
                       updated_at INTEGER NOT NULL
                     );",
                )
                .map_err(|e| format!("migrate to 6: {e}"))?;
        }
        if version < 7 {
            // Skills become APP-OWNED (owner: "存到你管理的目录里"): the files
            // live in <state dir>/skills/<name>/, and the row records the
            // SOURCE they were imported from (local path or git url) plus
            // when it was last synced — the source is sync metadata, not the
            // thing agents load. ref_ carried the same string; rename + add
            // the timestamp via rebuild. (This batch used to toggle
            // `PRAGMA foreign_keys` OFF then ON around the rebuild — the ON
            // outlived the step, so every later step ran with enforcement on,
            // and inside a transaction the pragma is a no-op anyway. `init`
            // owns that pragma; steps do not touch it.)
            self.conn
                .execute_batch(
                    "CREATE TABLE reg_skills_v7 (
                       name        TEXT PRIMARY KEY,
                       source      TEXT NOT NULL,
                       description TEXT NOT NULL DEFAULT '',
                       synced_at   INTEGER,
                       updated_at  INTEGER NOT NULL
                     );
                     INSERT INTO reg_skills_v7 (name, source, description, synced_at, updated_at)
                       SELECT name, ref_, description, NULL, updated_at FROM reg_skills;
                     DROP TABLE reg_skills;
                     ALTER TABLE reg_skills_v7 RENAME TO reg_skills;",
                )
                .map_err(|e| format!("migrate to 7: {e}"))?;
        }
        if version < 8 {
            // Renaming a project renames its tmux SESSION too — the session name
            // is what the Terminal and `tmux ls` show, so leaving it behind made
            // one thing wear two names (owner, 2026-08-19). Two additive columns
            // make that safe, and additive is the point: an ALTER cannot cascade
            // children away the way a table rebuild can.
            //
            //  · `room` decouples the chat from the name. The bus room used to be
            //    derived as `proj:<session>`, so a rename would have orphaned the
            //    conversation; now the room id is recorded once and never moves.
            //  · `prev_session` keeps the OLD name resolvable. A running agent has
            //    `TMM_PROJECT=<session>` baked into its environment, so without
            //    this every `tmm send/status/done` from an already-started agent
            //    would fail until it was restarted.
            self.conn
                .execute_batch(
                    "ALTER TABLE projects ADD COLUMN room TEXT NOT NULL DEFAULT '';
                     ALTER TABLE projects ADD COLUMN prev_session TEXT;
                     UPDATE projects SET room = 'proj:' || session WHERE room = '';",
                )
                .map_err(|e| format!("migrate to 8: {e}"))?;
        }
        if version < 9 {
            // v9: the activity log becomes durable. Tool calls, prompts, receipts
            // and status notes lived in a 120-entry in-memory ring, so a server
            // restart erased every tool lane in the conversation while the
            // messages around them survived — a feed with holes in it (owner,
            // 2026-08-19: "后台的工具调用 status之类的是不是没有持久化，好像重启就
            // 没了"). One flat table, written fail-soft: telemetry may never
            // block the thing it observes.
            self.conn
                .execute_batch(
                    "CREATE TABLE activity (
                       id      INTEGER PRIMARY KEY AUTOINCREMENT,
                       session TEXT NOT NULL,
                       window  INTEGER NOT NULL,
                       ts      INTEGER NOT NULL,
                       kind    TEXT NOT NULL,
                       text    TEXT NOT NULL DEFAULT '',
                       tool    TEXT NOT NULL DEFAULT '',
                       via     TEXT NOT NULL DEFAULT '',
                       state   TEXT NOT NULL DEFAULT ''
                     );
                     CREATE INDEX activity_session_ts ON activity(session, ts);",
                )
                .map_err(|e| format!("migrate to 9: {e}"))?;
        }
        if version < 10 {
            // v10: archived chat messages. Deleting a message is two steps —
            // archive hides it, and deleting it IN the archive forgets it for good
            // (owner, 2026-08-19) — so the middle state needs somewhere to live.
            // It lives HERE, in our own database, because `agora` (team.db) is a
            // faithful copy of an upstream crate and this is our feature, not its.
            //
            // The row carries a SNAPSHOT of the message: the archive view is then
            // self-contained (no join across two databases, no dependence on how
            // far back the room history was fetched), and a restore is just
            // dropping the row — the message itself never left team.db.
            self.conn
                .execute_batch(
                    "CREATE TABLE msg_archive (
                       room        TEXT NOT NULL,
                       msg_id      TEXT NOT NULL,
                       ts          INTEGER NOT NULL,
                       sender      TEXT NOT NULL,
                       body        TEXT NOT NULL,
                       archived_at INTEGER NOT NULL,
                       PRIMARY KEY (room, msg_id)
                     );",
                )
                .map_err(|e| format!("migrate to 10: {e}"))?;
        }
        if version < 11 {
            // v11: reasoning effort on the agent definition (owner, 2026-08-22:
            // "agent配置里应该有thinking effort的配置选项"). A plain column, not
            // a table rebuild, so no foreign-key dance is needed. Empty means
            // the backend's default, same contract as `model`.
            self.conn
                .execute_batch("ALTER TABLE reg_agents ADD COLUMN effort TEXT NOT NULL DEFAULT '';")
                .map_err(|e| format!("migrate to 11: {e}"))?;
        }
        if version < 12 {
            // v12: the project task BOARD (owner, 2026-08-29: "引入一个新的看板
            // 功能…人类有一个看板页面，能写任务issue，agent也可以读任务，修改任务
            // 状态，在看板上记录信息状态"). Keyed by SESSION like the chat room —
            // the board belongs to the project's conversation, not its folder.
            // Status is a fixed four-column vocabulary (todo/doing/review/done);
            // notes are the issue's own thread, separate from the chat.
            self.conn
                .execute_batch(
                    "CREATE TABLE issues (
                       id         INTEGER PRIMARY KEY,
                       session    TEXT NOT NULL,
                       title      TEXT NOT NULL,
                       body       TEXT NOT NULL DEFAULT '',
                       status     TEXT NOT NULL DEFAULT 'todo',
                       assignee   TEXT NOT NULL DEFAULT '',
                       created_by    TEXT NOT NULL DEFAULT '',
                       created_at    INTEGER NOT NULL,
                       updated_at    INTEGER NOT NULL,
                       agent_touched INTEGER NOT NULL DEFAULT 0,
                       project_number INTEGER NOT NULL
                     );
                     CREATE INDEX issues_session ON issues(session, status, updated_at DESC);
                     CREATE UNIQUE INDEX issues_session_number ON issues(session, project_number);
                     CREATE TABLE issue_sequences (
                       session     TEXT PRIMARY KEY,
                       next_number INTEGER NOT NULL
                     );
                     CREATE TABLE issue_notes (
                       id       INTEGER PRIMARY KEY,
                       issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
                       author   TEXT NOT NULL DEFAULT '',
                       body     TEXT NOT NULL,
                       at       INTEGER NOT NULL
                     );
                     CREATE INDEX issue_notes_issue ON issue_notes(issue_id, at);",
                )
                .map_err(|e| format!("migrate to 12: {e}"))?;
        }
        if version < 13 {
            // v13: outstanding DELIVERIES become durable. A line this app typed
            // into an agent's pane waits for the agent's `userPromptSubmit` echo
            // to confirm it, and that queue lived only in this process's memory —
            // so a server restart between the typing and the echo lost the
            // receipt: the hook could no longer attribute the prompt to us, the
            // event came back `via: local` (rendered as a prompt the human typed
            // at the keyboard) and the message it belonged to kept its hollow
            // ring for ever (owner, 2026-08-29: "发送了一条消息，然后后端的服务
            // 有重启了，然后agent又收到指令确认hooks，这个hooks没有正确把之前的
            // 未确认的消息变成已读状态，被单独写出来了"). An agent survives our
            // restart — it is a separate process, holding our line in its own
            // input queue — so the record of what we typed has to survive it too.
            //
            // One row per outstanding line, keyed by the line itself: re-typing
            // the same text replaces its entry rather than queueing a duplicate
            // that could never be acked twice, exactly like the in-memory queue.
            self.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS deliveries (
                       id      INTEGER PRIMARY KEY AUTOINCREMENT,
                       session TEXT NOT NULL,
                       window  INTEGER NOT NULL,
                       line    TEXT NOT NULL,
                       ts      INTEGER NOT NULL,
                       UNIQUE (session, window, line)
                     );
                     CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session, window);",
                )
                .map_err(|e| format!("migrate to 13: {e}"))?;
        }
        if version < 14 {
            // v14: Board rows follow the PROJECT session through a rename and
            // die with a permanently deleted project (board #41). v12 keyed
            // issues by session, but set_session only moved projects.session;
            // those issues became invisible, and reusing the old name could
            // expose them to a different project. Likewise delete_project
            // left issues behind. Repair existing databases in this order:
            // first move the most recent prev_session alias onto its current
            // session. Old builds could already have reused that alias: in
            // that case issues older than the new current owner follow the
            // previous project, while its newer issues stay put. Then remove
            // notes + issues whose session belongs to no project. Foreign
            // keys are OFF during migrations, so notes must be deleted
            // explicitly rather than relying on ON DELETE CASCADE.
            self.conn
                .execute_batch(
                    "UPDATE issues
                        SET session = (
                          SELECT previous_owner.session
                            FROM projects previous_owner
                           WHERE previous_owner.prev_session = issues.session
                           ORDER BY previous_owner.created_at DESC
                           LIMIT 1
                        )
                      WHERE EXISTS (SELECT 1 FROM projects p WHERE p.prev_session = issues.session)
                        AND (
                          NOT EXISTS (SELECT 1 FROM projects current_owner WHERE current_owner.session = issues.session)
                          OR issues.created_at < (
                            SELECT current_owner.created_at
                              FROM projects current_owner
                             WHERE current_owner.session = issues.session
                             LIMIT 1
                          )
                        );
                     DELETE FROM issue_notes
                      WHERE issue_id IN (
                        SELECT i.id FROM issues i
                         WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.session = i.session)
                      );
                     DELETE FROM issues
                      WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.session = issues.session);",
                )
                .map_err(|e| format!("migrate to 14: {e}"))?;
        }
        if version < 15 {
            // v15: original issue text becomes immutable once an Agent has
            // acted. A current assignee also locks it, but that part is live
            // state; this bit remembers activity after the issue is unassigned
            // or moved back (board #43).
            self.ensure_issue_edit_lock()?;
        }
        if version < 16 {
            // v16: visible/CLI #N values belong to ONE project and start at 1
            // there (latest owner ruling on board #41). The old global PK stays
            // internal so issue_notes need no rebuild.
            self.ensure_issue_numbering()?;
        }
        if version < 17 {
            // v17: agent TEAMS (owner, 2026-09-02, board #74: "可以定义 agent
            // team…agent 加上一个特定的角色补充设定，组成一个小组"). A team
            // is a named list of members; each member derives from a registry
            // agent plus a role supplement, or carries a team-only inline
            // definition. Members are one JSON column, like an agent's skills:
            // a team is edited whole-row and never joined against.
            self.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS reg_teams (
                       name        TEXT PRIMARY KEY,
                       description TEXT NOT NULL DEFAULT '',
                       members     TEXT NOT NULL DEFAULT '[]',
                       created_at  INTEGER NOT NULL,
                       updated_at  INTEGER NOT NULL
                     );",
                )
                .map_err(|e| format!("migrate to 17: {e}"))?;
        }
        if version < 18 {
            // A new backend default joins EXISTING installs exactly once.
            // `reg_seed` only plants on an empty table (so a deliberately
            // deleted default never resurrects at restart) — which also
            // meant every already-seeded install would never see the new
            // `omp` default. A one-shot migration is the mechanism that
            // threads that needle: rows > 0 gates out fresh databases
            // (reg_seed will plant every default right after open), NOT EXISTS
            // respects a user's own `omp` definition, and once stamped v18
            // the insert never runs again, so deleting it sticks.
            self.conn
                .execute(
                    "INSERT INTO reg_agents (name, backend, model, effort, system, skills, mcp, created_at, updated_at)
                     SELECT 'omp', 'omp', ?2, '', ?1, '[\"tmm-cli\",\"mem\",\"mcp-cli\"]', '[]',
                            CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
                     WHERE (SELECT COUNT(*) FROM reg_agents) > 0
                       AND NOT EXISTS (SELECT 1 FROM reg_agents WHERE name = 'omp')",
                    rusqlite::params![DEFAULT_OMP_SYSTEM, DEFAULT_OMP_MODEL],
                )
                .map_err(|e| format!("migrate to 18: {e}"))?;
        }
        if version < 19 {
            // v19: the hub's OWN message store (board #107). Hub chat used to
            // live on the vendored agora bus (team.db) behind TeamBridge; the
            // owner deleted the Team system whole (2026-09-09, board #100), and
            // tenet 7 names state.db as one of the only two truth stores — so
            // the room's transcript moves here. Column names mirror the agora
            // `messages` table so the one-off import (projects::rooms) is a
            // straight copy: `seq` is the log-position cursor hub_log pages on
            // (AUTOINCREMENT keeps imported seqs and new ones on one line),
            // `to_json` is the durable recipient route team-context rebuilding
            // reads, `kind` keeps imported join/leave/system rows faithful.
            // `meta` is a tiny kv for one-shot flags (the import marker).
            self.conn
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS hub_msgs (
                       seq     INTEGER PRIMARY KEY AUTOINCREMENT,
                       id      TEXT NOT NULL UNIQUE,
                       ts      INTEGER NOT NULL,
                       room    TEXT NOT NULL,
                       sender  TEXT NOT NULL,
                       to_json TEXT NOT NULL DEFAULT '[]',
                       kind    TEXT NOT NULL DEFAULT 'msg',
                       body    TEXT NOT NULL
                     );
                     CREATE INDEX IF NOT EXISTS hub_msgs_room_seq ON hub_msgs(room, seq);
                     CREATE TABLE IF NOT EXISTS meta (
                       key   TEXT PRIMARY KEY,
                       value TEXT NOT NULL
                     );",
                )
                .map_err(|e| format!("migrate to 19: {e}"))?;
        }
        if version < 20 {
            // v20 (board #120): telemetry rows are keyed by the window NAME —
            // the agent's identity — instead of the tmux window INDEX, which
            // `renumber-windows` reassigns (kill a lower window and every
            // higher one shifts; the store then paints one agent's edges on
            // whichever window inherited the number; measured 2026-09-09).
            // Readable migration: activity gains a `win` TEXT column (old rows
            // keep their index in `window` and read back as its decimal
            // string); deliveries are REBUILT because their UNIQUE key must
            // move to the name — old pending rows carry their index as the
            // name, never match a name-keyed echo, and are swept once as
            // unconfirmed, which is the honest reading of a cross-upgrade
            // delivery.
            self.ensure_activity_names()?;
            self.ensure_delivery_names()?;
        }
        if version < 21 {
            // v21 (board #122): duplicates of one line are DISTINCT promises,
            // so the (session, win, line) unique key goes — each delivery is
            // its own row, settled one at a time by its own echo.
            self.ensure_delivery_duplicates()?;
        }
        if version < 22 {
            // v22 (board #224): the `kimi` default joins EXISTING installs
            // exactly once — the v18 mechanism (rows > 0 gates out fresh
            // databases, NOT EXISTS respects a user's own `kimi` def, the
            // stamp makes a later delete stick). Same skills as its siblings
            // and the kiro-web-search shim (Bedrock K3 has no built-in
            // search); model empty = the user's own default_model.
            self.conn
                .execute(
                    "INSERT INTO reg_agents (name, backend, model, effort, system, skills, mcp, created_at, updated_at)
                     SELECT 'kimi', 'kimi', '', '', ?1, '[\"tmm-cli\",\"mem\",\"mcp-cli\"]',
                            '[{\"name\":\"kiro-web-search\",\"command\":\"uvx\",\"args\":[\"kiro-web-search==0.1.3\"]}]',
                            CAST(strftime('%s','now') AS INTEGER), CAST(strftime('%s','now') AS INTEGER)
                     WHERE (SELECT COUNT(*) FROM reg_agents) > 0
                       AND NOT EXISTS (SELECT 1 FROM reg_agents WHERE name = 'kimi')",
                    rusqlite::params![DEFAULT_KIMI_SYSTEM],
                )
                .map_err(|e| format!("migrate to 22: {e}"))?;
        }
        if version < 23 {
            // The Manager flag is retired (owner, 2026-09-26): hiring is an
            // ability every agent has through `tmm`, so a per-definition grant
            // gated nothing worth gating. The column goes with the field.
            let has_column = self
                .conn
                .prepare("SELECT 1 FROM pragma_table_info('reg_agents') WHERE name = 'can_hire'")
                .and_then(|mut s| s.exists([]))
                .map_err(|e| format!("migrate to 23: {e}"))?;
            if has_column {
                self.conn
                    .execute_batch("ALTER TABLE reg_agents DROP COLUMN can_hire;")
                    .map_err(|e| format!("migrate to 23: {e}"))?;
            }
        }
        if version < 24 {
            // v24 (board #249): a delivery row names the chat message it
            // carries and whether it was already reported; an activity event
            // names the delivery rows it is about (the echo that settled them,
            // or the warn that reported one). Additive, empty for every
            // existing row — those keep the content match they always had.
            self.ensure_delivery_msg_ids()?;
        }
        if version < 25 {
            // v25 (board #245): what a line typed at a busy agent does,
            // `queue` | `steer`, on the definition next to model and effort.
            // Every existing agent reads `queue` (owner, 2026-08-20: the
            // default for every agent), which is what kiro was already
            // pinned to; a codex agent moves from its CLI's steer to queue at
            // its next restart.
            self.ensure_input_mode()?;
        }
        if version < 26 {
            // v26 (board #257): a line for a busy queue-mode agent is HELD —
            // a row in the one deliveries table that was not typed yet —
            // and typed with the others at the turn's end. Existing rows
            // were all typed: 0.
            self.ensure_delivery_held()?;
        }
        if version < 27 {
            // v27 (board #257 review): a prompt row's requesters, parsed from
            // the FULL prompt, beside its display-truncated text. NULL for
            // older rows, which recovery parses from their text as before.
            self.ensure_activity_requesters()?;
        }
        if version < 28 {
            // v28 (board #264): a delivery row can be a slash command's
            // expected echo, with its own lifetime. Existing rows are lines: 0.
            self.ensure_delivery_command()?;
        }
        if version < 29 {
            // v29 (board #275): scheduled wakes, a declaration per row.
            self.ensure_wakes()?;
        }
        if version < 30 {
            // v30 (board #279): where a row's stamped line starts, recorded
            // by the producer that typed a Team context before it. Existing
            // rows have none: 0.
            self.ensure_delivery_ask_at()?;
        }
        if version < 31 {
            // v31 (board #334): the human's read mark per room, shared by
            // every client; every existing room starts read to its head.
            self.ensure_hub_read()?;
            self.seed_hub_read()?;
        }
        Ok(())
    }

    /// The v30 shape (also a heal floor): `deliveries.ask_at`, added only
    /// when absent.
    pub(super) fn ensure_delivery_ask_at(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('deliveries') WHERE name = 'ask_at')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect deliveries.ask_at: {e}"))?;
        if !has {
            self.conn
                .execute_batch("ALTER TABLE deliveries ADD COLUMN ask_at INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("add deliveries.ask_at: {e}"))?;
        }
        Ok(())
    }

    /// The v28 shape (also a heal floor): `deliveries.command`, added only
    /// when absent.
    pub(super) fn ensure_delivery_command(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('deliveries') WHERE name = 'command')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect deliveries.command: {e}"))?;
        if !has {
            self.conn
                .execute_batch("ALTER TABLE deliveries ADD COLUMN command INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("add deliveries.command: {e}"))?;
        }
        Ok(())
    }

    /// The v27 shape (also a heal floor): `activity.requesters`, added only
    /// when absent.
    pub(super) fn ensure_activity_requesters(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('activity') WHERE name = 'requesters')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect activity.requesters: {e}"))?;
        if !has {
            self.conn
                .execute_batch("ALTER TABLE activity ADD COLUMN requesters TEXT;")
                .map_err(|e| format!("add activity.requesters: {e}"))?;
        }
        Ok(())
    }

    /// The v26 shape (also a heal floor): `deliveries.held`, added only when
    /// absent.
    pub(super) fn ensure_delivery_held(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('deliveries') WHERE name = 'held')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect deliveries.held: {e}"))?;
        if !has {
            self.conn
                .execute_batch("ALTER TABLE deliveries ADD COLUMN held INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| format!("add deliveries.held: {e}"))?;
        }
        Ok(())
    }

    /// The v25 shape (also a heal floor): `reg_agents.input_mode`, added only
    /// when absent — a database copied back to an older stamp still has it.
    pub(super) fn ensure_input_mode(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('reg_agents') WHERE name = 'input_mode')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect reg_agents.input_mode: {e}"))?;
        if !has {
            self.conn
                .execute_batch("ALTER TABLE reg_agents ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'queue';")
                .map_err(|e| format!("add reg_agents.input_mode: {e}"))?;
        }
        Ok(())
    }

    /// The v24 shape (also a heal floor): `deliveries.msg_id`,
    /// `deliveries.warned` and `activity.deliveries`, each added only when
    /// absent.
    pub(super) fn ensure_delivery_msg_ids(&self) -> Result<(), String> {
        for (table, column, ddl) in [
            ("deliveries", "msg_id", "ALTER TABLE deliveries ADD COLUMN msg_id TEXT NOT NULL DEFAULT '';"),
            ("deliveries", "warned", "ALTER TABLE deliveries ADD COLUMN warned INTEGER NOT NULL DEFAULT 0;"),
            ("activity", "deliveries", "ALTER TABLE activity ADD COLUMN deliveries TEXT NOT NULL DEFAULT '';"),
        ] {
            let has: bool = self
                .conn
                .query_row(
                    &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name = '{column}')"),
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| format!("inspect {table}.{column}: {e}"))?;
            if !has {
                self.conn.execute_batch(ddl).map_err(|e| format!("add {table}.{column}: {e}"))?;
            }
        }
        Ok(())
    }

    /// The v21 deliveries shape (also a heal floor): no unique key — the
    /// presence of the `sqlite_autoindex` unique index is the marker.
    pub(super) fn ensure_delivery_duplicates(&self) -> Result<(), String> {
        let unique: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_index_list('deliveries') WHERE \"unique\" = 1)",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect deliveries uniqueness: {e}"))?;
        if !unique {
            return Ok(());
        }
        self.conn
            .execute_batch(
                "CREATE TABLE deliveries_v21 (
                   id      INTEGER PRIMARY KEY AUTOINCREMENT,
                   session TEXT NOT NULL,
                   win     TEXT NOT NULL,
                   line    TEXT NOT NULL,
                   ts      INTEGER NOT NULL
                 );
                 INSERT INTO deliveries_v21 (session, win, line, ts)
                   SELECT session, win, line, ts FROM deliveries;
                 DROP TABLE deliveries;
                 ALTER TABLE deliveries_v21 RENAME TO deliveries;
                 CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session, win);",
            )
            .map_err(|e| format!("rebuild deliveries for duplicates: {e}"))
    }

    /// The v20 activity shape (also a heal floor — see `heal`): a `win` TEXT
    /// column holding the window NAME for rows written after board #120.
    pub(super) fn ensure_activity_names(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('activity') WHERE name = 'win')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect activity shape: {e}"))?;
        if !has {
            self.conn
                .execute_batch("ALTER TABLE activity ADD COLUMN win TEXT NOT NULL DEFAULT '';")
                .map_err(|e| format!("add activity.win: {e}"))?;
        }
        Ok(())
    }

    /// The v20 deliveries shape (also a heal floor): keyed by window NAME.
    pub(super) fn ensure_delivery_names(&self) -> Result<(), String> {
        let has: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('deliveries') WHERE name = 'win')",
                [],
                |r| r.get(0),
            )
            .map_err(|e| format!("inspect deliveries shape: {e}"))?;
        if has {
            return Ok(());
        }
        self.conn
            .execute_batch(
                "CREATE TABLE deliveries_v20 (
                   id      INTEGER PRIMARY KEY AUTOINCREMENT,
                   session TEXT NOT NULL,
                   win     TEXT NOT NULL,
                   line    TEXT NOT NULL,
                   ts      INTEGER NOT NULL,
                   UNIQUE (session, win, line)
                 );
                 INSERT INTO deliveries_v20 (session, win, line, ts)
                   SELECT session, CAST(window AS TEXT), line, ts FROM deliveries;
                 DROP TABLE deliveries;
                 ALTER TABLE deliveries_v20 RENAME TO deliveries;
                 CREATE INDEX IF NOT EXISTS deliveries_session ON deliveries(session, win);",
            )
            .map_err(|e| format!("rebuild deliveries for names: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    /// v24 -> v25 (board #245): every existing agent definition gains
    /// `input_mode = 'queue'`, and a saved `steer` round-trips.
    #[test]
    fn v24_agents_gain_queue_input_mode() {
        let dir = std::env::temp_dir().join(format!("tmm-store-v25-{}", uuid::Uuid::new_v4()));
        let path = dir.join("state.db");
        {
            let store = Store::open(&path).unwrap();
            store.conn.execute_batch(
                "ALTER TABLE reg_agents DROP COLUMN input_mode;
                 INSERT OR REPLACE INTO reg_agents (name, backend, created_at, updated_at) VALUES ('old', 'codex', 1, 1);
                 PRAGMA user_version = 24;",
            ).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.reg_get("old").unwrap().unwrap().input_mode, "queue");
        let mut steer = store.reg_get("old").unwrap().unwrap();
        steer.input_mode = "steer".into();
        store.reg_save(&steer, 2).unwrap();
        assert_eq!(store.reg_get("old").unwrap().unwrap().input_mode, "steer");
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v23 -> v24 (board #249): an existing database keeps its outstanding
    /// deliveries and activity rows, and both gain the new columns empty — an
    /// old row therefore takes the content match it always had.
    #[test]
    fn v23_deliveries_and_activity_gain_message_ids_empty() {
        let dir = std::env::temp_dir().join(format!("tmm-store-v24-{}", uuid::Uuid::new_v4()));
        let path = dir.join("state.db");
        {
            let store = Store::open(&path).unwrap();
            store.conn.execute_batch(
                "DROP INDEX deliveries_unreported;
                 ALTER TABLE deliveries DROP COLUMN msg_id;
                 ALTER TABLE deliveries DROP COLUMN warned;
                 ALTER TABLE activity DROP COLUMN deliveries;
                 INSERT INTO deliveries (session, win, line, ts) VALUES ('s', 'w1', 'old line', 100);
                 INSERT INTO activity (session, window, win, ts, kind, text, tool, via, state)
                   VALUES ('s', 0, 'w1', 1000, 'prompt', 'old line', '', 'app', '');
                 PRAGMA user_version = 23;",
            ).unwrap();
        }
        let store = Store::open(&path).unwrap();
        let rows = store.pending_deliveries("s", None).unwrap();
        assert_eq!((rows.len(), rows[0].line.as_str(), rows[0].msg_id.as_str(), rows[0].warned), (1, "old line", "", false));
        let evs = store.activity_since("s", 0, 10).unwrap();
        assert_eq!((evs.len(), evs[0].deliveries.as_str()), (1, ""));
        store.insert_delivery("s", "w1", "new line", 0, 200, "m9").unwrap();
        assert_eq!(store.pending_deliveries("s", None).unwrap()[1].msg_id, "m9");
        // Re-running the step is harmless (the heal floor calls it on every open).
        store.ensure_delivery_msg_ids().unwrap();
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// v29 -> v30 (board #279): an outstanding row keeps its line and reads
    /// `ask_at` 0 (shown as typed); a new row stores its offset.
    #[test]
    fn v29_deliveries_gain_ask_at_zero() {
        // The guard exists before the database does (#268/#269): every exit
        // path, a panic included, removes it.
        let scratch = crate::tmux::Scratch::new("store-v30");
        let path = std::path::Path::new(&scratch.path()).join("state.db");
        {
            let store = Store::open(&path).unwrap();
            store.conn.execute_batch(
                "ALTER TABLE deliveries DROP COLUMN ask_at;
                 INSERT INTO deliveries (session, win, line, ts) VALUES ('s', 'w1', 'old line', 100);
                 PRAGMA user_version = 29;",
            ).unwrap();
        }
        let store = Store::open(&path).unwrap();
        let rows = store.pending_deliveries("s", None).unwrap();
        assert_eq!((rows.len(), rows[0].line.as_str(), rows[0].ask_at), (1, "old line", 0));
        store.insert_held_delivery("s", "w1", "ctx\n\nline", 5, 200, "m9").unwrap();
        assert_eq!(store.held_deliveries("s", "w1").unwrap()[0].shown(), "line\n\nctx");
        store.ensure_delivery_ask_at().unwrap();
    }

    /// v30 -> v31 (board #334): every room that already spoke starts read
    /// to its head (old history is read), a room born after the upgrade has
    /// no mark (every message counts), and the heal floor recreates a
    /// missing table EMPTY — seeding is the migration's, once.
    #[test]
    fn v30_rooms_start_read_to_their_head() {
        let scratch = crate::tmux::Scratch::new("store-v31");
        let path = std::path::Path::new(&scratch.path()).join("state.db");
        {
            let store = Store::open(&path).unwrap();
            store.conn.execute_batch("DROP TABLE hub_read; PRAGMA user_version = 30;").unwrap();
            store.hub_append("proj:old", "o1", 10, "lead", "[]", "msg", "old one").unwrap();
            store.hub_append("proj:old", "o2", 20, "lead", "[]", "msg", "old two").unwrap();
        }
        let store = Store::open(&path).unwrap();
        let head = store.hub_room_head("proj:old").unwrap().unwrap();
        assert_eq!(store.hub_read_mark("proj:old").unwrap(), Some(head), "old history is read");
        assert_eq!(store.hub_above("proj:old", Some(head.0), 0).unwrap().len(), 0);
        let after = store.hub_append("proj:old", "o3", 30, "lead", "[]", "msg", "after upgrade").unwrap();
        assert_eq!(store.hub_above("proj:old", Some(head.0), 0).unwrap()[0].0, after.seq, "a message after the upgrade counts");
        store.hub_append("proj:new", "n1", 40, "lead", "[]", "msg", "new room").unwrap();
        assert_eq!(store.hub_read_mark("proj:new").unwrap(), None, "a room born later is not baselined");
        store.conn.execute_batch("DROP TABLE hub_read;").unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.hub_read_mark("proj:old").unwrap(), None, "healed on open, empty");
    }

    /// The heal step, which is not hypothetical: a dev binary built in the
    /// seconds between the version bump and its migration block stamped this
    /// host's real state.db at v13 with no `deliveries` table, and a
    /// version-gated CREATE would have skipped it for ever after that.
    #[test]
    fn a_database_stamped_at_the_current_version_without_its_table_heals_on_open() {
        let dir = std::env::temp_dir().join(format!("tmm-store-heal-{}", uuid::Uuid::new_v4()));
        let path = dir.join("state.db");
        {
            let store = Store::open(&path).unwrap();
            // Seed legacy evidence before removing the new column: v14 had no
            // updater field, so a non-todo issue must conservatively reopen as
            // locked when v15 repairs the schema.
            let legacy = store.issue_save("legacy", None, Some("already moving"), None, None, None, "human", 10).unwrap();
            store.issue_save("legacy", Some(legacy), None, None, Some("doing"), None, "human", 11).unwrap();
            store.conn.execute_batch(
                "DROP TABLE deliveries;
                 DROP INDEX issues_session_number;
                 DROP TABLE issue_sequences;
                 ALTER TABLE issues DROP COLUMN agent_touched;
                 ALTER TABLE issues DROP COLUMN project_number;"
            ).unwrap();
            store.conn.pragma_update(None, "user_version", SCHEMA_VERSION).unwrap();
            assert!(store.pending_deliveries("s", None).is_err(), "the table really is gone");
        }
        let store = Store::open(&path).unwrap();
        store.insert_delivery("s", "w1", "hello", 0, 100, "").unwrap();
        assert_eq!(store.pending_deliveries("s", None).unwrap().len(), 1, "healed on open");
        assert_eq!(store.issue_get("legacy", 1).unwrap().unwrap()["editable"], false, "legacy workflow evidence is locked during repair");
        assert_eq!(
            store.issue_save("legacy", None, Some("next"), None, None, None, "human", 100).unwrap(),
            2,
            "the repaired sequence continues after the backfilled local #1",
        );
        let id = store.issue_save("s", None, Some("editable"), None, None, None, "human", 100).unwrap();
        assert_eq!(id, 1, "a different repaired project starts at one");
        assert_eq!(store.issue_get("s", id).unwrap().unwrap()["editable"], true, "Board edit lock and local number healed together");
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrating_v13_repairs_renamed_and_orphaned_boards() {
        let dir = std::env::temp_dir().join(format!("tmm-board-v14-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");

        // Seed the shape a pre-v14 build could leave: the project declaration
        // already moved old→new, its Board rows did not; a permanently deleted
        // project also left an orphan Board + note.
        let seed = Store::open(&path).unwrap();
        seed.insert_project(&project("alpha")).unwrap();
        let mut current_owner = project("current");
        current_owner.session = "old".into();
        current_owner.created_at = 20;
        seed.insert_project(&current_owner).unwrap();
        let moved = seed.issue_save("old", None, Some("follow rename"), None, None, None, "human", 10).unwrap();
        seed.issue_note("old", moved, "human", "keep me", 11).unwrap();
        let _stays = seed.issue_save("old", None, Some("new owner task"), None, None, None, "human", 30).unwrap();
        let orphan = seed.issue_save("deleted", None, Some("orphan"), None, None, None, "human", 12).unwrap();
        seed.issue_note("deleted", orphan, "human", "remove me", 13).unwrap();
        let orphan_row = issue_row_id(&seed, "deleted", orphan);
        seed.conn.execute(
            "UPDATE projects SET session = 'new', prev_session = 'old' WHERE id = 'alpha'",
            [],
        ).unwrap();
        // Remove the v16-only shape: the repair must first split the alias
        // (v14), then assign dense local numbers independently (v16).
        seed.conn.execute_batch(
            "DROP INDEX issues_session_number;
             DROP TABLE issue_sequences;
             ALTER TABLE issues DROP COLUMN project_number;"
        ).unwrap();
        seed.conn.pragma_update(None, "user_version", 13).unwrap();
        drop(seed);

        let repaired = Store::open(&path).unwrap();
        assert!(repaired.issue_get("old", 2).unwrap().is_none(), "the previous owner's old global ordering is not a visible handle");
        let got = repaired.issue_get("new", 1).unwrap().expect("renamed board repaired and starts at #1");
        assert_eq!(got["notes"].as_array().unwrap().len(), 1, "the issue thread survives the repair");
        assert_eq!(
            repaired.issue_get("old", 1).unwrap().unwrap()["title"],
            "new owner task",
            "the reused alias owner keeps its row and independently starts at #1",
        );
        assert!(repaired.issues_list("deleted").unwrap().is_empty(), "orphan board removed");
        let orphan_notes: i64 = repaired.conn.query_row(
            "SELECT COUNT(*) FROM issue_notes WHERE issue_id = ?1",
            [orphan_row],
            |r| r.get(0),
        ).unwrap();
        assert_eq!(orphan_notes, 0, "foreign keys are off in migration, so v14 removes orphan notes explicitly");
        let version: i64 = repaired.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        // A rolled-back v15 binary does not know project_number and can insert
        // NULL into an upgraded (nullable-by-ALTER) table. With a visible gap,
        // dense rank would collide; heal must continue after the remembered
        // sequence instead.
        assert_eq!(repaired.issue_save("old", None, Some("two"), None, None, None, "human", 40).unwrap(), 2);
        assert_eq!(repaired.issue_save("old", None, Some("three"), None, None, None, "human", 41).unwrap(), 3);
        assert!(repaired.issue_delete("old", 2).unwrap());
        repaired.conn.execute(
            "INSERT INTO issues
               (session, title, body, status, assignee, created_by, created_at, updated_at, agent_touched)
             VALUES ('old', 'written by v15', '', 'todo', '', 'human', 42, 42, 0)",
            [],
        ).unwrap();
        drop(repaired);
        let healed = Store::open(&path).unwrap();
        assert_eq!(healed.issue_get("old", 4).unwrap().unwrap()["title"], "written by v15");
        assert_eq!(
            healed.issue_save("old", None, Some("after heal"), None, None, None, "human", 43).unwrap(),
            5,
            "rollback repair advances without collision or reuse",
        );
        drop(healed);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// v1 shipped `path` as UNIQUE, which rejected the second session in a
    /// directory. The migration must lift that constraint, put uniqueness on
    /// `session` instead, and carry the existing rows across — including the
    /// children, which a naive `DROP TABLE projects` would cascade away.
    #[test]
    fn migrating_a_v1_database_keeps_its_rows_and_moves_the_unique_constraint() {
        let scratch = crate::tmux::Scratch::new("store-migrate");
        let path = std::path::PathBuf::from(scratch.path()).join("state.db");

        let v1 = Connection::open(&path).unwrap();
        v1.execute_batch(
            "CREATE TABLE projects (
               id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
               icon TEXT, session TEXT NOT NULL, adopted INTEGER NOT NULL DEFAULT 0,
               autostart INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
               last_up_at INTEGER, last_seen_at INTEGER, archived_at INTEGER);
             CREATE TABLE slots (
               id INTEGER PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               ord INTEGER NOT NULL, window_name TEXT NOT NULL,
               cwd TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, command TEXT,
               auto_run INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER NOT NULL,
               settled_at INTEGER, UNIQUE (project_id, window_name));
             CREATE TABLE snapshots (
               id INTEGER PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               at INTEGER NOT NULL, topology_json TEXT NOT NULL);
             INSERT INTO projects (id, name, path, session, created_at)
               VALUES ('old', 'old', '/w/shared', 'old', 100);
             INSERT INTO slots (project_id, ord, window_name, cwd, kind, first_seen_at, settled_at)
               VALUES ('old', 0, 'editor', '', 'shell', 100, 200);
             INSERT INTO snapshots (project_id, at, topology_json) VALUES ('old', 100, '[]');
             PRAGMA user_version = 1;",
        )
        .unwrap();
        drop(v1);

        let store = Store::open(&path).unwrap();
        assert_eq!(store.list_projects(false).unwrap().len(), 1, "row carried over");
        assert_eq!(store.slots("old").unwrap().len(), 1, "children survived the rebuild");

        let mut second = project("second");
        second.path = "/w/shared".into(); // same directory as `old`
        store
            .insert_project(&second)
            .expect("a second project in the same directory is allowed now");

        let mut clash = project("clash");
        clash.session = "old".into();
        assert!(
            store.insert_project(&clash).is_err(),
            "two projects must not fight over one tmux session"
        );

    }

    /// v18: an already-seeded registry (any pre-omp install) gains the `omp`
    /// default exactly once. Once stamped, deleting it sticks — the insert
    /// never re-runs — and a user's own `omp` definition is never overwritten.
    #[test]
    fn v18_backfills_omp_into_an_already_seeded_registry() {
        // Removed on drop, also on failure (board #269).
        let scratch = crate::tmux::Scratch::new("migrate-omp");
        let path = std::path::PathBuf::from(scratch.path()).join("state.db");

        // A fresh store, seeded, then rewound to look like a v17 install:
        // the omp row gone, the stamp pre-backfill.
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            store.reg_seed(1).unwrap();
            store.conn.execute("DELETE FROM reg_agents WHERE name='omp'", []).unwrap();
            store.conn.pragma_update(None, "user_version", 17).unwrap();
        }
        // Reopening migrates: the four-default registry gains omp once.
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            let omp = store.reg_get("omp").unwrap().expect("v18 backfills the omp default");
            assert_eq!(omp.system, DEFAULT_OMP_SYSTEM);
            assert_eq!(omp.model, DEFAULT_OMP_MODEL, "the backfill pins Fable 5.1 like the seed");
            assert_eq!(omp.skills, r#"["tmm-cli","mem","mcp-cli"]"#);
            // Deleting the default now sticks: the stamp is v18, the insert
            // is history.
            assert!(store.reg_delete("omp").unwrap());
        }
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            assert!(store.reg_get("omp").unwrap().is_none(), "a deleted default never resurrects");
            // A user's own `omp` definition survives a re-run of the step.
            let custom = RegAgent {
                name: "omp".into(),
                backend: "omp".into(),
                model: String::new(),
                effort: String::new(),
                input_mode: "queue".into(),
                system: "My own omp persona.".into(),
                skills: "[]".into(),
                mcp: "[]".into(),
            };
            store.reg_save(&custom, 2).unwrap();
            store.conn.pragma_update(None, "user_version", 17).unwrap();
        }
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            assert_eq!(
                store.reg_get("omp").unwrap().unwrap().system,
                "My own omp persona.",
                "NOT EXISTS respects a custom definition"
            );
        }
    }

    /// v22 (board #224): the v18 mechanism again for `kimi` — backfilled once
    /// into a seeded registry, a delete sticks, a custom def is respected.
    #[test]
    fn v22_backfills_kimi_into_an_already_seeded_registry() {
        let dir = std::env::temp_dir().join(format!("tmm-migrate-kimi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            store.reg_seed(1).unwrap();
            store.conn.execute("DELETE FROM reg_agents WHERE name='kimi'", []).unwrap();
            store.conn.pragma_update(None, "user_version", 21).unwrap();
        }
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            let kimi = store.reg_get("kimi").unwrap().expect("v22 backfills the kimi default");
            assert_eq!(kimi.system, DEFAULT_KIMI_SYSTEM);
            assert_eq!(kimi.model, "", "empty = the user's own default_model, carried into the home");
            assert_eq!(kimi.skills, r#"["tmm-cli","mem","mcp-cli"]"#);
            assert!(kimi.mcp.contains("kiro-web-search"), "Bedrock K3 has no built-in search");
            assert_eq!(
                store.reg_list().unwrap().iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
                ["kiro", "codex", "claude", "grok", "omp", "kimi"]
            );
            assert!(store.reg_delete("kimi").unwrap());
        }
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            assert!(store.reg_get("kimi").unwrap().is_none(), "a deleted default never resurrects");
            let custom = RegAgent {
                name: "kimi".into(),
                backend: "kimi".into(),
                model: String::new(),
                effort: String::new(),
                input_mode: "queue".into(),
                system: "My own kimi persona.".into(),
                skills: "[]".into(),
                mcp: "[]".into(),
            };
            store.reg_save(&custom, 2).unwrap();
            store.conn.pragma_update(None, "user_version", 21).unwrap();
        }
        {
            let store = Store::init(Connection::open(&path).unwrap()).unwrap();
            assert_eq!(store.reg_get("kimi").unwrap().unwrap().system, "My own kimi persona.");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn v4_to_v6_migration_adds_registry_and_assets() {
        // An existing v4 db (projects+slots only) must gain reg_agents.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
               icon TEXT, session TEXT NOT NULL UNIQUE, adopted INTEGER NOT NULL DEFAULT 0,
               autostart INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
               last_up_at INTEGER, last_seen_at INTEGER, archived_at INTEGER);
             CREATE TABLE slots (id INTEGER PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               ord INTEGER NOT NULL, window_name TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '',
               kind TEXT NOT NULL, command TEXT, auto_run INTEGER NOT NULL DEFAULT 0,
               first_seen_at INTEGER NOT NULL, settled_at INTEGER, agent_session_id TEXT,
               UNIQUE (project_id, window_name));
             PRAGMA user_version = 4;",
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        store.reg_seed(1).unwrap();
        let seeded = store.reg_list().unwrap();
        assert_eq!(seeded.len(), 6);
        assert_eq!(
            seeded.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["kiro", "codex", "claude", "grok", "omp", "kimi"]
        );
        let v: i64 = store.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        // v6 assets exist and are usable on a migrated db.
        store.skill_save(&RegSkill { name: "s".into(), source: "github.com/x/y".into(), description: String::new(), synced_at: None }, 1).unwrap();
        assert_eq!(store.skills_list().unwrap().len(), 1);
        // The v7 step no longer flips foreign_keys back ON behind init's back:
        // after open, enforcement is on because init turned it on, and a
        // fresh in-memory open that migrates from scratch agrees.
        let fk: i64 = store.conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(fk, 1, "init turns enforcement on after migrating");
    }

    /// The migration is ONE transaction: a step that fails leaves the database
    /// exactly as it was — still stamped at the old version, with none of the
    /// earlier steps' tables — instead of half-migrated and unopenable for
    /// ever. Simulated here by planting a table a later step creates (`activity`,
    /// v9, a plain CREATE) into a v4 database: v5–v8 succeed, v9 fails.
    #[test]
    fn a_failed_migration_step_rolls_every_step_back() {
        let dir = std::env::temp_dir().join(format!("tmm-migrate-atomic-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.db");
        let v4 = Connection::open(&path).unwrap();
        v4.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
               icon TEXT, session TEXT NOT NULL UNIQUE, adopted INTEGER NOT NULL DEFAULT 0,
               autostart INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
               last_up_at INTEGER, last_seen_at INTEGER, archived_at INTEGER);
             CREATE TABLE slots (id INTEGER PRIMARY KEY,
               project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
               ord INTEGER NOT NULL, window_name TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '',
               kind TEXT NOT NULL, command TEXT, auto_run INTEGER NOT NULL DEFAULT 0,
               first_seen_at INTEGER NOT NULL, settled_at INTEGER, agent_session_id TEXT,
               UNIQUE (project_id, window_name));
             CREATE TABLE activity (planted INTEGER);
             PRAGMA user_version = 4;",
        )
        .unwrap();
        drop(v4);

        let err = match Store::open(&path) {
            Ok(_) => panic!("the planted table makes step 9 fail"),
            Err(e) => e,
        };
        assert!(err.contains("migrate to 9"), "the failing step is named: {err}");

        let raw = Connection::open(&path).unwrap();
        let v: i64 = raw.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 4, "the stamp did not move");
        let tables: Vec<String> = raw
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            !tables.iter().any(|t| t == "reg_agents"),
            "step 5's table was rolled back with the rest: {tables:?}"
        );
        assert!(tables.iter().any(|t| t == "projects") && tables.iter().any(|t| t == "slots"), "{tables:?}");

        // Remove the obstacle: the SAME database now migrates cleanly — nothing
        // from the failed attempt is in the way.
        let raw2 = Connection::open(&path).unwrap();
        raw2.execute_batch("DROP TABLE activity;").unwrap();
        drop(raw2);
        drop(raw);
        let store = Store::open(&path).expect("a rolled-back database is a clean v4 database");
        let v: i64 = store.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        drop(store);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
