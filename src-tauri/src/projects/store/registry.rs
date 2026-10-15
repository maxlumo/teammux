//! The registry: agent, team, skill and MCP definitions, and the shipped defaults.
//!
//! One family of the store (board #147): an `impl Store` block over the same
//! connection, the same migration ladder, the same tests — only the file moved.

use super::*;

/// The `omp` default's system text — shared by `reg_seed` (fresh installs)
/// and the v18 backfill migration (existing installs), so the two cannot
/// drift.
pub(super) const DEFAULT_OMP_SYSTEM: &str = "You are a powerful 10x developer running on OMP (oh-my-pi) who can handle any task with decisive execution and minimal words.";

/// The omp default's model (owner, 2026-09-07: "设定默认的 omp agent 模型为
/// fable 5.1"). `bedrock-extra` is the provider the user's `~/.omp/agent/
/// models.yml` declares (the bundled omp catalog lacks Fable 5.1 on Bedrock);
/// `render_omp` carries that file into every isolated home, so the selector
/// resolves for spawned agents. On a machine without the catalog entry, omp
/// warns and falls back to its own default — the same soft degradation the
/// claude seed's Bedrock pin relies on.
pub(super) const DEFAULT_OMP_MODEL: &str = "bedrock-extra/global.anthropic.claude-fable-5-1";

/// The `kimi` default's system text — shared by `reg_seed` and the v22
/// backfill migration (board #224), so the two cannot drift. The model stays
/// EMPTY: a kimi model is an alias of the user's own `[models]` table, which
/// `render_kimi` carries into every isolated home together with the user's
/// `default_model` — so "backend default" already means the owner's Bedrock
/// K3 here and needs no per-machine alias in the seed.
pub(super) const DEFAULT_KIMI_SYSTEM: &str = "You are a powerful 10x developer running on Kimi Code who can handle any task with decisive execution and minimal words.";

/// The shipped `kiro` default: the persona line and NOTHING else (board #344,
/// owner 2026-10-11 / 10-15: "这个提示词是我们自己的 tmm 配置，发布版本的默认配置
/// 不应该有这些"). A release must carry no personal workflow rules, so the seed
/// no longer names a worktree location, a Git author rule or the Kiro
/// co-author trailer: those are one owner's conventions, and they live where
/// a person declares them — the app-wide `<config>/AGENTS.md` that leads every
/// managed agent's prompt, and the stored definitions that person already has.
/// It is the same sentence the other five seeds use for their own backend.
pub(super) const DEFAULT_KIRO_SYSTEM: &str = "You are a powerful 10x developer running on Kiro CLI who can handle any task with decisive execution and minimal words.";

/// A central skill asset. The FILES live in the app-managed skills dir; the
/// `source` (local path or git url) is where they were imported from and what
/// a refresh re-syncs against.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegSkill {
    pub name: String,
    pub source: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub synced_at: Option<u64>,
}

/// A central MCP server def: name → def JSON ({command,args,env} or {url,headers}).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegMcp {
    pub name: String,
    pub def: String,
}

/// A registry agent definition. `skills` and `mcp` are stored as JSON text
/// (refs and defs respectively) — parsed only at spawn time.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegAgent {
    pub name: String,
    pub backend: String,
    #[serde(default)]
    pub model: String,
    /// Reasoning effort (low|medium|high|…, backend-specific). Empty = the
    /// backend's default, same contract as `model`.
    #[serde(default)]
    pub effort: String,
    /// What a line typed at the BUSY agent does (board #245): `queue` waits
    /// for the turn to end and becomes the next prompt, `steer` goes into the
    /// running turn. Only a backend whose switch is measured
    /// (`Backend::switches_input_mode`) accepts `steer`, and its backend file
    /// renders the value into its own config. A NEW def that names no mode
    /// gets its backend's default at the door (`registry::with_default_input_mode`,
    /// board #336: kiro steers); this serde default (`queue`) is what a STORED
    /// text without the field (a team member's inline agent saved before
    /// #245) has always meant, so it stays.
    #[serde(default = "default_input_mode")]
    pub input_mode: String,
    #[serde(default)]
    pub system: String,
    /// JSON array of skill refs (local names or github URLs).
    #[serde(default = "empty_json_array")]
    pub skills: String,
    /// JSON array of MCP server defs ({name, command/url, args, env, headers}).
    #[serde(default = "empty_json_array")]
    pub mcp: String,
}

pub(super) fn empty_json_array() -> String {
    "[]".to_string()
}

pub(crate) fn default_input_mode() -> String {
    "queue".to_string()
}

/// An agent TEAM (board #74): a named list of members. `members` is a JSON
/// array of `teams::Member` — kept as text for the same reason an agent's
/// `skills` is: the row is edited whole and never joined against.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RegTeam {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "empty_json_array")]
    pub members: String,
}

pub(super) fn row_to_reg_team(r: &rusqlite::Row<'_>) -> rusqlite::Result<RegTeam> {
    Ok(RegTeam { name: r.get(0)?, description: r.get(1)?, members: r.get(2)? })
}

pub(super) fn row_to_reg_agent(r: &rusqlite::Row<'_>) -> rusqlite::Result<RegAgent> {
    Ok(RegAgent {
        name: r.get(0)?,
        backend: r.get(1)?,
        model: r.get(2)?,
        effort: r.get(3)?,
        system: r.get(4)?,
        skills: r.get(5)?,
        mcp: r.get(6)?,
        input_mode: r.get(7)?,
    })
}

impl Store {
    pub fn reg_list(&self) -> Result<Vec<RegAgent>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT name, backend, model, effort, system, skills, mcp, input_mode
                   FROM reg_agents
                  ORDER BY CASE name
                    WHEN 'kiro' THEN 0
                    WHEN 'codex' THEN 1
                    WHEN 'claude' THEN 2
                    WHEN 'grok' THEN 3
                    WHEN 'omp' THEN 4
                    WHEN 'kimi' THEN 5
                    ELSE 6
                  END, name"
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_reg_agent)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn reg_get(&self, name: &str) -> Result<Option<RegAgent>, String> {
        self.conn
            .query_row(
                "SELECT name, backend, model, effort, system, skills, mcp, input_mode FROM reg_agents WHERE name = ?1",
                [name],
                row_to_reg_agent,
            )
            .map(Some)
            .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })
    }

    /// Upsert by name — the registry is edited whole-row (like team templates).
    pub fn reg_save(&self, a: &RegAgent, now: u64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO reg_agents (name, backend, model, effort, system, skills, mcp, input_mode, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?9, ?8, ?8)
                 ON CONFLICT(name) DO UPDATE SET
                   backend=?2, model=?3, effort=?4, system=?5, skills=?6, mcp=?7, input_mode=?9, updated_at=?8",
                rusqlite::params![
                    a.name,
                    a.backend,
                    a.model,
                    a.effort,
                    a.system,
                    a.skills,
                    a.mcp,
                    now as i64,
                    a.input_mode,
                ],
            )
            .map(|_| ())
            .map_err(|e| format!("save agent {}: {e}", a.name))
    }

    pub fn reg_delete(&self, name: &str) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM reg_agents WHERE name = ?1", [name])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    pub fn teams_list(&self) -> Result<Vec<RegTeam>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, description, members FROM reg_teams ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_reg_team)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn team_get(&self, name: &str) -> Result<Option<RegTeam>, String> {
        self.conn
            .query_row("SELECT name, description, members FROM reg_teams WHERE name = ?1", [name], row_to_reg_team)
            .map(Some)
            .or_else(|e| if e == rusqlite::Error::QueryReturnedNoRows { Ok(None) } else { Err(e.to_string()) })
    }

    /// Upsert by name — whole-row, like `reg_save`.
    pub fn team_save(&self, t: &RegTeam, now: u64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO reg_teams (name, description, members, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(name) DO UPDATE SET description=?2, members=?3, updated_at=?4",
                rusqlite::params![t.name, t.description, t.members, now as i64],
            )
            .map(|_| ())
            .map_err(|e| format!("save team {}: {e}", t.name))
    }

    pub fn team_delete(&self, name: &str) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM reg_teams WHERE name = ?1", [name])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    /// Seed the six backend-native defaults once (empty table only).
    /// `docs` / `reviewer` and `*-default` aliases are deliberately retired:
    /// one obvious entry per backend, with the defaults pinned to the top of
    /// every registry consumer by `reg_list`.
    pub fn reg_seed(&self, now: u64) -> Result<(), String> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM reg_agents", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if count > 0 {
            // A stored definition is the user's DECLARATION (tenet 7), and this
            // runs on every registry read: it seeds an EMPTY table and does
            // nothing else. It used to upgrade a stored `kiro` whose system
            // text equalled an older shipped default to a newer one — which is
            // how a Git workflow and a personal co-author trailer were written
            // into definitions nobody had asked to change (board #344). The
            // shipped default no longer carries them, so there is nothing to
            // upgrade TO, and rewriting a stored prompt behind its owner's back
            // is not a thing the seed does.
            return Ok(());
        }
        // backend-seeds:begin — the shipped default agent per backend. The
        // ONE place outside src/backends/ allowed to spell backend names: a
        // seed is registry DATA (a name, a persona), not backend knowledge,
        // and the literal guard (backends::tests) skips this fenced region.
        // Each seed starts in its backend's default input mode (board #336:
        // kiro steers), the one definition a new def without a mode gets.
        let mode = |backend: &str| crate::backends::Backend::parse(backend).map_or("queue", |b| b.default_input_mode()).to_string();
        let seeds = [
            RegAgent {
                name: "kiro".into(),
                backend: "kiro".into(),
                model: String::new(),
                effort: String::new(),
                input_mode: mode("kiro"),
                system: DEFAULT_KIRO_SYSTEM.into(),
                skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
                mcp: "[]".into(),
            },
            RegAgent {
                name: "codex".into(),
                backend: "codex".into(),
                model: String::new(),
                effort: String::new(),
                input_mode: mode("codex"),
                system: "You are a powerful 10x developer running on Codex who can handle any task with decisive execution and minimal words.".into(),
                skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
                mcp: r#"[{"name":"kiro-web-search","command":"uvx","args":["kiro-web-search==0.1.3"]}]"#.into(),
            },
            RegAgent {
                name: "claude".into(),
                backend: "claude".into(),
                model: "global.anthropic.claude-fable-5-1[1m]".into(),
                effort: String::new(),
                input_mode: mode("claude"),
                system: "You are a powerful 10x developer running on Claude Code who can handle any task with decisive execution and minimal words.".into(),
                skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
                mcp: r#"[{"name":"kiro-web-search","command":"uvx","args":["kiro-web-search==0.1.3"]}]"#.into(),
            },
            RegAgent {
                name: "grok".into(),
                backend: "grok".into(),
                model: String::new(),
                effort: String::new(),
                input_mode: mode("grok"),
                system: "You are a powerful 10x developer running on Grok who can handle any task with decisive execution and minimal words.".into(),
                skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
                mcp: r#"[{"name":"kiro-web-search","command":"uvx","args":["kiro-web-search==0.1.3"]}]"#.into(),
            },
            RegAgent {
                name: "omp".into(),
                backend: "omp".into(),
                model: DEFAULT_OMP_MODEL.into(),
                effort: String::new(),
                input_mode: mode("omp"),
                system: DEFAULT_OMP_SYSTEM.into(),
                skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
                // omp ships its own web_search tool — no MCP search shim needed.
                mcp: "[]".into(),
            },
            RegAgent {
                name: "kimi".into(),
                backend: "kimi".into(),
                model: String::new(),
                effort: String::new(),
                input_mode: mode("kimi"),
                system: DEFAULT_KIMI_SYSTEM.into(),
                skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
                // kimi's built-in search is the Moonshot service (a Kimi API
                // key); on Bedrock it has none, so the MCP shim like codex.
                mcp: r#"[{"name":"kiro-web-search","command":"uvx","args":["kiro-web-search==0.1.3"]}]"#.into(),
            },
        ];
        // backend-seeds:end
        for s in &seeds {
            self.reg_save(s, now)?;
        }
        Ok(())
    }

    pub fn skills_list(&self) -> Result<Vec<RegSkill>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, source, description, synced_at FROM reg_skills ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RegSkill {
                    name: r.get(0)?,
                    source: r.get(1)?,
                    description: r.get(2)?,
                    synced_at: r.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn skill_get(&self, name: &str) -> Result<Option<RegSkill>, String> {
        Ok(self.skills_list()?.into_iter().find(|s| s.name == name))
    }

    pub fn skill_save(&self, sk: &RegSkill, now: u64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO reg_skills (name, source, description, synced_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(name) DO UPDATE SET source=?2, description=?3, synced_at=?4, updated_at=?5",
                rusqlite::params![sk.name, sk.source, sk.description, sk.synced_at.map(|v| v as i64), now as i64],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn skill_delete(&self, name: &str) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM reg_skills WHERE name = ?1", [name])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }

    pub fn mcp_list(&self) -> Result<Vec<RegMcp>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT name, def FROM reg_mcp ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok(RegMcp { name: r.get(0)?, def: r.get(1)? }))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn mcp_save(&self, m: &RegMcp, now: u64) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO reg_mcp (name, def, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(name) DO UPDATE SET def=?2, updated_at=?3",
                rusqlite::params![m.name, m.def, now as i64],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn mcp_delete(&self, name: &str) -> Result<bool, String> {
        self.conn
            .execute("DELETE FROM reg_mcp WHERE name = ?1", [name])
            .map(|n| n > 0)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_crud_roundtrip() {
        let store = Store::open_memory().unwrap();
        store.reg_seed(100).unwrap();
        let seeded = store.reg_list().unwrap();
        assert_eq!(
            seeded.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["kiro", "codex", "claude", "grok", "omp", "kimi"],
            "the six backend defaults are the fixed leading group"
        );
        assert!(seeded.iter().all(|a| a.skills == r#"["tmm-cli","mem","mcp-cli"]"#));
        // Board #336: each seed starts in its backend's default mode.
        assert_eq!(
            seeded.iter().map(|a| (a.name.as_str(), a.input_mode.as_str())).collect::<Vec<_>>(),
            [("kiro", "steer"), ("codex", "queue"), ("claude", "queue"), ("grok", "queue"), ("omp", "queue"), ("kimi", "queue")]
        );
        assert_eq!(
            seeded[0].system,
            "You are a powerful 10x developer running on Kiro CLI who can handle any task with decisive execution and minimal words.",
            "the shipped Kiro default is the persona line and nothing else"
        );
        // The owner's rule for a RELEASE (board #344): the shipped defaults
        // carry no personal workflow. A worktree location, a Git author rule
        // or a co-author trailer is one person's convention and lives in the
        // app-wide AGENTS.md and in that person's own stored definitions —
        // never in what every fresh install is handed. Checked over ALL six
        // seeds, so adding a rule to any backend's default fails here.
        for a in &seeded {
            let lower = a.system.to_lowercase();
            for word in ["worktree", "co-authored-by", "trailer", "git author", "git workflow", "commit"] {
                assert!(!lower.contains(word), "the {} seed must not carry workflow text ({word:?}): {}", a.name, a.system);
            }
            assert!(a.system.starts_with("You are a powerful 10x developer running on "), "{}: {}", a.name, a.system);
        }
        assert_eq!(seeded[0].mcp, "[]", "Kiro uses its built-in web search");
        assert_eq!(seeded[4].mcp, "[]", "OMP ships its own web_search tool");
        assert!(seeded[1..4].iter().all(|a| a.mcp.contains("kiro-web-search")));
        assert!(seeded[5].mcp.contains("kiro-web-search"), "Bedrock K3 has no built-in search");
        assert_eq!(seeded[5].model, "", "kimi's model is the user's own default_model");
        assert!(!seeded.iter().any(|a| matches!(a.name.as_str(), "docs" | "reviewer")));

        // Seeding twice must not duplicate.
        store.reg_seed(200).unwrap();
        assert_eq!(store.reg_list().unwrap().len(), 6);

        // A custom definition alphabetically before the defaults stays AFTER
        // their fixed group; the rest of the list is alphabetical.
        let custom = RegAgent {
            name: "aaa-custom".into(),
            backend: "kiro".into(),
            model: String::new(),
            effort: String::new(),
            input_mode: "queue".into(),
            system: "custom".into(),
            skills: "[]".into(),
            mcp: "[]".into(),
        };
        store.reg_save(&custom, 250).unwrap();
        assert_eq!(
            store.reg_list().unwrap().iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["kiro", "codex", "claude", "grok", "omp", "kimi", "aaa-custom"]
        );

        // Upsert edits in place.
        let mut kiro = store.reg_get("kiro").unwrap().unwrap();
        kiro.model = "gpt-5.6-sol".into();
        store.reg_save(&kiro, 300).unwrap();
        assert_eq!(store.reg_get("kiro").unwrap().unwrap().model, "gpt-5.6-sol");
        assert_eq!(store.reg_list().unwrap().len(), 7, "save by name is an upsert");

        assert!(store.reg_delete("aaa-custom").unwrap());
        assert!(!store.reg_delete("aaa-custom").unwrap(), "second delete is a no-op");
        assert_eq!(store.reg_list().unwrap().len(), 6);
    }

    /// Board #344: a stored definition is the user's declaration and the seed
    /// never rewrites it. `reg_seed` used to upgrade a stored `kiro` whose
    /// system text equalled an older shipped default — and the "newer" one
    /// ADDED a Git workflow and a personal co-author trailer to definitions
    /// nobody had asked to change. These are the texts it used to rewrite,
    /// spelled out here ONLY to prove they now come through untouched: the
    /// original terse sentence, the first verbose Git version, and the
    /// worktree-plus-trailer version that briefly shipped as the default.
    #[test]
    fn registry_seed_never_rewrites_a_stored_definition() {
        let terse = "You are a powerful 10x developer running on Kiro CLI who can handle any task with decisive execution and minimal words.";
        let verbose = concat!(
            "You are a powerful 10x developer running on Kiro CLI who can handle any task with decisive execution and minimal words.",
            "\n\nGit workflow:\n",
            "- Before changing tracked files, create or reuse a dedicated Git worktree and task branch. If this session already runs inside that task worktree, use it; otherwise keep the launch checkout for reading, coordination, and final integration only.\n",
            "- Use the worktree's absolute path for every file edit, test, build, and Git command. Verify and commit in the worktree before integrating.\n",
            "- Preserve the user's configured Git author. Every commit you materially author must end with exactly one trailer, separated from the body by a blank line:\n",
            "  Co-authored-by: Kiro Agent <244629292+kiro-agent@users.noreply.github.com>\n",
            "- Do not add the Kiro trailer when you only review or integrate someone else's commit."
        );
        let concise = concat!(
            "You are a powerful 10x developer running on Kiro CLI who can handle any task with decisive execution and minimal words.",
            "\n\nFor code changes, use a dedicated Git worktree instead of the launch checkout. Preserve the user's configured Git author and add this trailer to every commit you author:\n",
            "Co-authored-by: Kiro Agent <244629292+kiro-agent@users.noreply.github.com>"
        );
        let store = Store::open_memory().unwrap();
        let mut kiro = RegAgent {
            name: "kiro".into(),
            backend: "kiro".into(),
            model: "gpt-5.6-sol".into(),
            effort: "high".into(),
            input_mode: "queue".into(),
            system: String::new(),
            skills: r#"["tmm-cli","mem","mcp-cli"]"#.into(),
            mcp: "[]".into(),
        };
        // Every text the seed ever shipped, plus a custom one, plus the
        // current shipped default: each must be byte-identical after seeding.
        let mut at = 100;
        for (label, text) in [
            ("the original terse default", terse),
            ("the first verbose Git version", verbose),
            ("the worktree-and-trailer default that briefly shipped", concise),
            ("a custom persona", "My deliberately customized Kiro persona."),
            ("the current shipped default", DEFAULT_KIRO_SYSTEM),
        ] {
            kiro.system = text.into();
            store.reg_save(&kiro, at).unwrap();
            store.reg_seed(at + 50).unwrap();
            let kept = store.reg_get("kiro").unwrap().unwrap();
            assert_eq!(kept.system, text, "{label}: a stored definition is the user's declaration");
            assert_eq!(kept.model, "gpt-5.6-sol", "{label}: the model is untouched");
            assert_eq!(kept.effort, "high", "{label}: the effort is untouched");
            assert_eq!(kept.skills, kiro.skills, "{label}: skills are untouched");
            assert_eq!(kept.mcp, kiro.mcp, "{label}: MCP is untouched");
            assert_eq!(kept.input_mode, "queue", "{label}: a stored queue stays queue though a new kiro steers (#336)");
            let stamp: i64 = store
                .conn
                .query_row("SELECT updated_at FROM reg_agents WHERE name='kiro'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(stamp, at as i64, "{label}: not even the timestamp moves — nothing was written");
            at += 100;
        }
        // And a fresh table still seeds the persona-only default.
        let fresh = Store::open_memory().unwrap();
        fresh.reg_seed(1).unwrap();
        assert_eq!(fresh.reg_get("kiro").unwrap().unwrap().system, DEFAULT_KIRO_SYSTEM);
    }
}
