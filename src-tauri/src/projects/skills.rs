//! Skills, both halves in one file (board #152):
//!
//! * RESOLUTION for spawning agents — local/team-bundled skill dirs and
//!   GitHub-referenced skills (sparse-cloned into a shared cache), plus the
//!   compact skills index injected into CLI system prompts (split from
//!   team.rs 2026-07-22);
//! * the CENTRAL ASSETS — the registry-owned skill and MCP definitions
//!   (owner: 集中化管理), referenced from agent defs by name, imported from
//!   git/local sources into `<state>/skills/<name>/`, seeded with the
//!   built-ins (moved from projects/mod.rs, board #152).

use std::path::PathBuf;

use super::{db_path, mcp_mask, now, store, with_store};

use serde_json::{json, Value};

pub(crate) struct ResolvedSkill {
    pub(crate) name: String,
    pub(crate) dir: PathBuf,
    pub(crate) description: String,
}

/// A compact system-level skills index for backends without a native skill
/// mechanism (claude/codex). Kiro instead gets `skill://` resources.
pub(crate) fn skills_index_text(skills: &[ResolvedSkill]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut s = String::from("Skills available — read the named SKILL.md before a matching task:");
    for sk in skills {
        s += &format!(" [{}] {} (at {}/SKILL.md);", sk.name, sk.description, sk.dir.display());
    }
    s
}


fn skills_cache_dir() -> PathBuf {
    crate::config::config_dir().join("skills-cache")
}

/// Resolve each skill reference to a local directory. A reference is either a
/// local path (relative to the team folder, or absolute) or a GitHub URL, which
/// is sparse-cloned into a shared cache (reused across teams/agents).
pub(crate) fn resolve_skills(refs: &[String], team_dir: &str) -> Vec<ResolvedSkill> {
    let mut out = Vec::new();
    for r in refs {
        let r = r.trim();
        if r.is_empty() {
            continue;
        }
        let dir = if r.starts_with("http://") || r.starts_with("https://") {
            match fetch_git_skill(r) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("⚠️  team: skill '{}' fetch failed: {}", r, e);
                    continue;
                }
            }
        } else {
            let p = PathBuf::from(r);
            let p = if p.is_absolute() { p } else { PathBuf::from(team_dir).join(r) };
            if p.is_file() {
                p.parent().map(|x| x.to_path_buf()).unwrap_or(p)
            } else {
                p
            }
        };
        if !dir.exists() {
            eprintln!("⚠️  team: skill path not found: {}", dir.display());
            continue;
        }
        let (name, description) = read_skill_meta(&dir);
        out.push(ResolvedSkill { name, dir, description });
    }
    out
}

/// Parse SKILL.md YAML frontmatter for name/description (best-effort).
pub(crate) fn read_skill_meta(dir: &std::path::Path) -> (String, String) {
    let fallback = dir.file_name().and_then(|s| s.to_str()).unwrap_or("skill").to_string();
    let md = std::fs::read_to_string(dir.join("SKILL.md")).unwrap_or_default();
    let mut name = fallback;
    let mut desc = String::new();
    if let Some(rest) = md.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let fm = rest[..end].trim_start_matches('\n');
            if let Ok(v) = serde_yaml_ng::from_str::<Value>(fm) {
                if let Some(n) = v.get("name").and_then(|x| x.as_str()) {
                    name = n.to_string();
                }
                if let Some(d) = v.get("description").and_then(|x| x.as_str()) {
                    desc = d.to_string();
                }
            }
        }
    }
    (name, desc)
}

/// Drop the clone cache for a GitHub skill URL so the next resolve re-fetches
/// the remote's current state. Used by the registry's skill refresh — the
/// cache is keyed owner/repo/ref and otherwise lives forever.
pub(crate) fn invalidate_git_cache(url: &str) {
    if let Ok((owner, repo, gitref, _)) = parse_github(url) {
        let _ = std::fs::remove_dir_all(skills_cache_dir().join(&owner).join(&repo).join(&gitref));
    }
}

/// Sparse-clone a GitHub `tree/<ref>/<subpath>` URL (or a bare repo URL) into the
/// shared skills cache and return the skill directory. Cache key = owner/repo/ref;
/// repeated refs to the same repo reuse the clone (sparse-checkout adds subpaths).
fn fetch_git_skill(url: &str) -> Result<PathBuf, String> {
    let (owner, repo, gitref, subpath) = parse_github(url)?;
    let repo_cache = skills_cache_dir().join(&owner).join(&repo).join(&gitref);
    let resolved = if subpath.is_empty() { repo_cache.clone() } else { repo_cache.join(&subpath) };
    // Cache hit: the subpath already materialised.
    if resolved.join("SKILL.md").is_file() || (subpath.is_empty() && resolved.exists()) {
        return Ok(resolved);
    }
    let repo_url = format!("https://github.com/{}/{}", owner, repo);
    if !repo_cache.join(".git").exists() {
        if let Some(p) = repo_cache.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let _ = std::fs::remove_dir_all(&repo_cache);
        let out = std::process::Command::new("git")
            .args(["clone", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", &gitref, &repo_url])
            .arg(&repo_cache)
            .output()
            .map_err(|e| format!("spawn git: {}", e))?;
        if !out.status.success() {
            return Err(format!("git clone: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    }
    if !subpath.is_empty() {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&repo_cache)
            .args(["sparse-checkout", "set", &subpath])
            .output()
            .map_err(|e| format!("spawn git: {}", e))?;
        if !out.status.success() {
            return Err(format!("git sparse-checkout: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
    }
    Ok(resolved)
}

/// Fetch a GitHub URL with the FULL tree materialized (sparse-checkout
/// disabled) and return the dir the URL points at. Discovery (a claude
/// plugin's `skills/*`, a marketplace's `plugins/*`) has to SEE the tree;
/// the per-subpath sparse fetch above is for a known skill dir.
pub(crate) fn fetch_git_full(url: &str) -> Result<PathBuf, String> {
    let (owner, repo, gitref, subpath) = parse_github(url)?;
    fetch_git_skill(url)?; // ensures the clone exists (cache key owner/repo/ref)
    let repo_cache = skills_cache_dir().join(&owner).join(&repo).join(&gitref);
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(&repo_cache)
        .args(["sparse-checkout", "disable"])
        .output()
        .map_err(|e| format!("spawn git: {}", e))?;
    if !out.status.success() {
        return Err(format!("git sparse-checkout disable: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(if subpath.is_empty() { repo_cache } else { repo_cache.join(subpath) })
}

/// Parse a GitHub URL into (owner, repo, ref, subpath). Supports the `tree/<ref>/
/// <subpath>` form and a bare `owner/repo` (defaults ref=main, no subpath).
pub(crate) fn parse_github(url: &str) -> Result<(String, String, String, String), String> {
    let u = url.trim().trim_end_matches('/');
    let rest = u
        .strip_prefix("https://github.com/")
        .or_else(|| u.strip_prefix("http://github.com/"))
        .ok_or_else(|| format!("only github.com skill URLs are supported: {}", url))?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 2 {
        return Err(format!("expected github.com/owner/repo…: {}", url));
    }
    let owner = parts[0].to_string();
    let repo = parts[1].trim_end_matches(".git").to_string();
    if parts.len() >= 4 && (parts[2] == "tree" || parts[2] == "blob") {
        Ok((owner, repo, parts[3].to_string(), parts[4..].join("/")))
    } else {
        Ok((owner, repo, "main".to_string(), String::new()))
    }
}

// ---- central skills / MCP assets: the registry-owned skill and MCP definitions (owner: 集中化管理), referenced from agent defs by name and resolved at spawn (moved from projects/mod.rs, board #152) ----

/// Built-in skills: shipped IN the binary and materialized into the managed
/// store at server start (owner, 2026-08-28: "应该有一个默认的内置的skill…
/// 来源就是内置的"). The row's `source` is the literal "builtin"; refresh and
/// reseed rewrite the files from the embedded copy, so they always match the
/// running build — and a deleted/overwritten one would silently drift, which
/// is why save/delete refuse the reserved names instead.
pub(crate) const BUILTIN_SKILLS: &[(&str, &str)] = &[
    ("tmm-cli", include_str!("../../../assets/skills/tmm-cli/SKILL.md")),
    ("mem", include_str!("../../../assets/skills/mem/SKILL.md")),
    ("mcp-cli", include_str!("../../../assets/skills/mcp-cli/SKILL.md")),
];

pub(crate) fn builtin_skill(name: &str) -> Option<&'static str> {
    BUILTIN_SKILLS.iter().find(|(n, _)| *n == name).map(|(_, md)| *md)
}

/// Frontmatter description off an embedded SKILL.md (best-effort — the
/// listed description should read the same as an imported skill's).
pub(super) fn builtin_description(md: &str) -> String {
    md.strip_prefix("---")
        .and_then(|rest| rest.find("\n---").map(|end| &rest[..end]))
        .and_then(|fm| {
            fm.lines().find_map(|l| l.strip_prefix("description:").map(|d| d.trim().to_string()))
        })
        .unwrap_or_default()
}

/// Materialize every built-in into the managed store. Called once at server
/// start (capture loop startup); fail-soft — a read-only disk must not stop
/// the server, the skill just stays stale/absent.
pub fn seed_builtin_skills() {
    for (name, md) in BUILTIN_SKILLS {
        let dir = managed_skills_dir().join(name);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let path = dir.join("SKILL.md");
        // Rewrite only on change: a no-op start must not bump mtimes.
        if std::fs::read_to_string(&path).ok().as_deref() != Some(*md) && std::fs::write(&path, md).is_err() {
            continue;
        }
        let row = store::RegSkill {
            name: (*name).to_string(),
            source: "builtin".into(),
            description: builtin_description(md),
            synced_at: Some(now()),
        };
        let _ = with_store(|store| store.skill_save(&row, now()));
    }
}

/// Every skill in the store, each with its managed `root` — the directory
/// holding its SKILL.md — so a reader can go from the list to the files
/// (board #418).
pub fn skills_list() -> Result<Value, String> {
    let rows = with_store(|store| store.skills_list())?;
    let skills = rows
        .into_iter()
        .map(|row| {
            let root = skill_root(&row.name)?.to_string_lossy().into_owned();
            let mut v = json!(row);
            v["root"] = json!(root);
            Ok(v)
        })
        .collect::<Result<Vec<Value>, String>>()?;
    Ok(json!({ "skills": skills }))
}

/// A skill's managed directory as an ABSOLUTE path on the gateway's own
/// filesystem (board #418 review P2-B): `TMM_STATE_DB` may be relative, and
/// a reader in another cwd must not resolve it against its own. Canonical
/// when it exists, else made absolute against the gateway's cwd. The one
/// boundary `skills_list` and `skill_load` both answer through.
fn skill_root(name: &str) -> Result<std::path::PathBuf, String> {
    let root = managed_skills_dir().join(name);
    std::fs::canonicalize(&root)
        .or_else(|_| std::path::absolute(&root))
        .map_err(|e| format!("the skill directory {} cannot be made absolute: {e}", root.display()))
}

/// The app-OWNED skills storage: `<state dir>/skills/<name>/`. Lives beside
/// state.db so the TMM_STATE_DB test override isolates it too. Agents load
/// from HERE; the recorded source is sync metadata.
pub fn managed_skills_dir() -> std::path::PathBuf {
    db_path().parent().map(|p| p.join("skills")).unwrap_or_else(|| "skills".into())
}

/// Copy the resolved source directory into the managed store (atomic: build
/// a temp sibling, then swap).
pub(super) fn sync_skill_files(name: &str, source: &str) -> Result<(), String> {
    let source = source.trim();
    if source == "builtin" {
        // The embedded copy IS the source; a refresh rewrites from the binary.
        let md = builtin_skill(name).ok_or_else(|| format!("'{name}' is not a built-in skill"))?;
        let dir = managed_skills_dir().join(name);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return std::fs::write(dir.join("SKILL.md"), md).map_err(|e| e.to_string());
    }
    if source.starts_with("http://") || source.starts_with("https://") {
        // A refresh must see the remote's CURRENT state, not the clone cache.
        crate::projects::skills::invalidate_git_cache(source);
    } else if !std::path::Path::new(source).is_absolute() {
        return Err("local source must be an absolute path".into());
    }
    let resolved = crate::projects::skills::resolve_skills(&[source.to_string()], "");
    let src_dir = resolved
        .first()
        .map(|r| r.dir.clone())
        .ok_or_else(|| format!("source did not resolve to a skill directory: {source}"))?;
    if !src_dir.join("SKILL.md").is_file() {
        return Err(format!("no SKILL.md in {}", src_dir.display()));
    }
    install_skill_files(name, &src_dir)
}

/// Copy an already-resolved skill dir into the managed store (atomic:
/// build a temp sibling, then swap).
pub(super) fn install_skill_files(name: &str, src_dir: &std::path::Path) -> Result<(), String> {
    let root = managed_skills_dir();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let tmp = root.join(format!(".tmp-{name}"));
    let dest = root.join(name);
    let _ = std::fs::remove_dir_all(&tmp);
    copy_dir(src_dir, &tmp)?;
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).map_err(|e| format!("swap into place: {e}"))
}

/// Walk `root` for directories containing a SKILL.md (depth-capped). This is
/// what makes a claude PLUGIN url installable as-is: a plugin keeps skills in
/// `skills/<name>/`, a marketplace in `plugins/<p>/skills/<name>/` — instead
/// of teaching each layout, find every SKILL.md and let its own directory be
/// the skill (owner, 2026-08-28: "输入一个url就能装上 不需要下载下来").
pub(super) fn discover_skills(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    fn walk(dir: &std::path::Path, depth: u32, out: &mut Vec<std::path::PathBuf>) {
        if depth > 5 || out.len() >= 50 {
            return;
        }
        if dir.join("SKILL.md").is_file() {
            out.push(dir.to_path_buf());
            return; // a skill dir's subdirs are its assets, not more skills
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut subdirs: Vec<_> = rd
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .filter(|p| {
                let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
                !n.starts_with('.') && n != "node_modules"
            })
            .collect();
        subdirs.sort();
        for sub in subdirs {
            walk(&sub, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out
}

/// A store-safe skill name off a discovered dir: frontmatter `name:` when it
/// parses, else the directory basename — squeezed into [a-zA-Z0-9_-].
pub(super) fn discovered_name(dir: &std::path::Path) -> String {
    let (meta_name, _) = crate::projects::skills::read_skill_meta(dir);
    let raw = if meta_name.trim().is_empty() { dir.file_name().and_then(|s| s.to_str()).unwrap_or("skill").to_string() } else { meta_name };
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_string();
    if cleaned.is_empty() { "skill".into() } else { cleaned }
}

/// Install every skill a source contains. ONE url does the whole job: a bare
/// skill dir imports as itself, a claude plugin imports each `skills/*`
/// entry, a marketplace repo imports every plugin's skills. Each row records
/// a source pointing at ITS OWN directory (a `tree/<ref>/<subpath>` url or an
/// absolute path), so `skill_refresh` keeps working per skill.
pub fn skill_import(source: &str) -> Result<Value, String> {
    let source = source.trim();
    let (root, mk_source): (std::path::PathBuf, Box<dyn Fn(&std::path::Path) -> String>) =
        if source.starts_with("http://") || source.starts_with("https://") {
            crate::projects::skills::invalidate_git_cache(source);
            let (owner, repo, gitref, subpath) = crate::projects::skills::parse_github(source)?;
            let root = crate::projects::skills::fetch_git_full(source)?;
            let base = root.clone();
            (root.clone(), Box::new(move |dir: &std::path::Path| {
                let rel = dir.strip_prefix(&base).ok().and_then(|p| p.to_str()).unwrap_or("");
                let full = [subpath.as_str(), rel].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("/");
                if full.is_empty() {
                    format!("https://github.com/{owner}/{repo}/tree/{gitref}")
                } else {
                    format!("https://github.com/{owner}/{repo}/tree/{gitref}/{full}")
                }
            }))
        } else {
            let p = std::path::PathBuf::from(source);
            if !p.is_absolute() {
                return Err("local source must be an absolute path".into());
            }
            (p, Box::new(|dir: &std::path::Path| dir.to_string_lossy().into_owned()))
        };
    let found = discover_skills(&root);
    if found.is_empty() {
        return Err(format!("no SKILL.md found under {source}"));
    }
    let mut imported: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    for dir in &found {
        let mut name = discovered_name(dir);
        if builtin_skill(&name).is_some() {
            skipped.push(format!("{name} (built-in name)"));
            continue;
        }
        // Two skills in one import wearing one name: suffix the later one.
        let base = name.clone();
        let mut n = 2;
        while !taken.insert(name.clone()) {
            name = format!("{base}-{n}");
            n += 1;
        }
        let (_, desc) = crate::projects::skills::read_skill_meta(dir);
        if let Err(e) = install_skill_files(&name, dir) {
            skipped.push(format!("{name} ({e})"));
            continue;
        }
        let row = store::RegSkill { name: name.clone(), source: mk_source(dir), description: desc, synced_at: Some(now()) };
        match with_store(|store| store.skill_save(&row, now())) {
            Ok(()) => imported.push(name),
            Err(e) => skipped.push(format!("{name} ({e})")),
        }
    }
    Ok(json!({ "ok": !imported.is_empty(), "imported": imported, "skipped": skipped }))
}

/// The most files a listing names, SKILL.md NOT counted (it is the body,
/// not a resource).
const MAX_LISTED_FILES: usize = 200;

/// A skill's managed files as `(relative path, size)`, SKILL.md first then by
/// path — the ONE walk the UI preview (`skill_files`) and `tmm skills load`
/// (`skill_load`) both read. At most `MAX_LISTED_FILES` besides SKILL.md;
/// `truncated` is true only when a further file was actually found (board
/// #418 review P2-A). A directory or file that cannot be read is an error,
/// never a shorter list: a reader is told what it cannot see.
struct Listing {
    files: Vec<(String, u64)>,
    truncated: bool,
}

fn managed_files(root: &std::path::Path) -> Result<Listing, String> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Listing, counted: &mut usize) -> Result<(), String> {
        let rd = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut entries = Vec::new();
        for e in rd {
            entries.push(e.map_err(|e| format!("{}: {e}", dir.display()))?);
        }
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let p = e.path();
            let ty = e.file_type().map_err(|err| format!("{}: {err}", p.display()))?;
            if ty.is_dir() {
                walk(&p, root, out, counted)?;
                if out.truncated {
                    return Ok(());
                }
                continue;
            }
            let meta = e.metadata().map_err(|err| format!("{}: {err}", p.display()))?;
            let rel = p.strip_prefix(root).map_err(|err| format!("{}: {err}", p.display()))?.to_string_lossy().into_owned();
            if rel == "SKILL.md" {
                continue; // taken before the walk
            }
            if *counted == MAX_LISTED_FILES {
                out.truncated = true;
                return Ok(());
            }
            *counted += 1;
            out.files.push((rel, meta.len()));
        }
        Ok(())
    }
    let mut out = Listing { files: Vec::new(), truncated: false };
    // The root SKILL.md first, outside the budget (review round 2): a walk
    // that stops at the 201st resource must not have skipped it.
    match std::fs::metadata(root.join("SKILL.md")) {
        Ok(meta) => out.files.push(("SKILL.md".into(), meta.len())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", root.join("SKILL.md").display())),
    }
    walk(root, root, &mut out, &mut 0)?;
    out.files.sort_by_key(|(rel, _)| (rel != "SKILL.md", rel.clone()));
    Ok(out)
}

/// The managed files of a skill, relative paths + sizes (for the UI preview).
pub fn skill_files(name: &str) -> Result<Value, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid skill name".into());
    }
    let listing = managed_files(&managed_skills_dir().join(name))?;
    let files: Vec<Value> = listing.files.into_iter().map(|(rel, size)| json!({ "path": rel, "size": size })).collect();
    let mut answer = json!({ "name": name, "files": files });
    if listing.truncated {
        answer["truncated"] = json!(true);
    }
    Ok(answer)
}

/// Everything an agent needs to load ONE skill from the command line (board
/// #418, `tmm skills load`): its managed root, the SKILL.md text, and every
/// other file as an absolute path with its size — paths, never contents, so a
/// large resource is not dumped. Read-only, from the same store the Skills
/// page reads. An unknown name names the near matches.
pub fn skill_load(name: &str) -> Result<Value, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid skill name".into());
    }
    let rows = with_store(|store| store.skills_list())?;
    if !rows.iter().any(|r| r.name == name) {
        let near = near_names(name, rows.iter().map(|r| r.name.as_str()));
        return Err(if near.is_empty() {
            format!("no skill '{name}' — try `tmm skills list`")
        } else {
            format!("no skill '{name}' — did you mean: {}?", near.join(", "))
        });
    }
    let root = skill_root(name)?;
    let skill_md = std::fs::read_to_string(root.join("SKILL.md"))
        .map_err(|e| format!("'{name}' is in the store but {} cannot be read: {e} — try `tmm skills refresh {name}`", root.join("SKILL.md").display()))?;
    let listing = managed_files(&root).map_err(|e| format!("'{name}': its files cannot all be read: {e}"))?;
    let files: Vec<Value> = listing
        .files
        .into_iter()
        .filter(|(rel, _)| rel != "SKILL.md")
        .map(|(rel, size)| json!({ "rel": rel, "path": root.join(&rel).to_string_lossy(), "size": size }))
        .collect();
    // The description is the FRONTMATTER's, read now with the store's own
    // parser (review P2-C): the truth of the files. The registry row's
    // description is the declaration the Skills page shows, and may differ.
    let (_, description) = read_skill_meta(&root);
    let mut answer = json!({
        "name": name,
        "description": description,
        "root": root.to_string_lossy(),
        "skill_md": skill_md,
        "files": files,
    });
    if listing.truncated {
        answer["truncated"] = json!(true);
    }
    Ok(answer)
}

/// Up to five store names that look like `wanted`: one contains the other,
/// or they share a three-letter start (case-insensitive).
fn near_names<'a>(wanted: &str, names: impl Iterator<Item = &'a str>) -> Vec<String> {
    let w = wanted.to_ascii_lowercase();
    let mut near: Vec<String> = names
        .filter(|n| {
            let n = n.to_ascii_lowercase();
            let start = |s: &str| s.chars().take(3).collect::<String>();
            n.contains(&w) || w.contains(&n) || (w.chars().count() >= 3 && start(&n) == start(&w))
        })
        .map(str::to_string)
        .collect();
    near.sort();
    near.truncate(5);
    near
}

/// One managed file's text (for the UI preview). Rejects path escapes and
/// anything that is not small readable text.
pub fn skill_file(name: &str, rel: &str) -> Result<Value, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid skill name".into());
    }
    let rel_path = std::path::Path::new(rel);
    if rel_path.is_absolute()
        || rel_path.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("invalid file path".into());
    }
    let path = managed_skills_dir().join(name).join(rel_path);
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat {rel}: {e}"))?;
    if meta.len() > 256 * 1024 {
        return Err(format!("{rel} is too large to preview ({} KB)", meta.len() / 1024));
    }
    let content = std::fs::read_to_string(&path).map_err(|_| format!("{rel} is not a text file"))?;
    Ok(json!({ "name": name, "path": rel, "content": content }))
}

pub(super) fn copy_dir(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dest = to.join(entry.file_name());
        if ty.is_dir() {
            // .git in a copied local repo would be dead weight in the store.
            if entry.file_name() == ".git" {
                continue;
            }
            copy_dir(&entry.path(), &dest)?;
        } else if ty.is_file() {
            std::fs::copy(entry.path(), &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Import (or re-import) a skill: pull the files from `source` into the
/// managed store, then record the row. Name doubles as the directory name.
pub fn skill_save(def: &Value) -> Result<Value, String> {
    let mut sk: store::RegSkill = serde_json::from_value(def.clone()).map_err(|e| format!("invalid skill: {e}"))?;
    sk.name = sk.name.trim().to_string();
    if sk.name.is_empty() || sk.source.trim().is_empty() {
        return Err("skill needs a name and a source".into());
    }
    if !sk.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("skill name must be [a-zA-Z0-9_-] (it names a directory)".into());
    }
    if builtin_skill(&sk.name).is_some() && sk.source.trim() != "builtin" {
        return Err(format!("'{}' is a built-in skill — its files ship with the app and reseed at start", sk.name));
    }
    sync_skill_files(&sk.name, &sk.source)?;
    sk.synced_at = Some(now());
    with_store(|store| {
        store.skill_save(&sk, now())?;
        Ok(json!({ "ok": true, "name": sk.name, "synced_at": sk.synced_at }))
    })
}

/// Re-sync a skill's files from its recorded source.
pub fn skill_refresh(name: &str) -> Result<Value, String> {
    let sk = with_store(|store| store.skill_get(name))?
        .ok_or_else(|| format!("no skill named '{name}'"))?;
    sync_skill_files(&sk.name, &sk.source)?;
    let mut updated = sk;
    updated.synced_at = Some(now());
    with_store(|store| {
        store.skill_save(&updated, now())?;
        Ok(json!({ "ok": true, "name": updated.name, "synced_at": updated.synced_at }))
    })
}

/// SKILL.md content from the managed store (for the UI preview).
pub fn skill_read(name: &str) -> Result<Value, String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid skill name".into());
    }
    let path = managed_skills_dir().join(name).join("SKILL.md");
    let content = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    Ok(json!({ "name": name, "content": content }))
}

pub fn skill_delete(name: &str) -> Result<Value, String> {
    if builtin_skill(name).is_some() {
        return Err(format!("'{name}' is built-in — it would reseed at the next server start"));
    }
    let deleted = with_store(|store| store.skill_delete(name))?;
    if deleted {
        let _ = std::fs::remove_dir_all(managed_skills_dir().join(name));
    }
    Ok(json!({ "ok": deleted }))
}

/// The central MCP defs, every env/header value masked (board #451). One row
/// that cannot be read safely fails the whole answer: no half list, no text.
pub fn mcp_list() -> Result<Value, String> {
    with_store(|store| {
        let rows = store.mcp_list()?;
        let masked = rows
            .into_iter()
            .map(|m| Ok(json!({ "name": m.name, "def": mcp_mask::masked_central(&m.name, &m.def)? })))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(json!({ "mcp": masked }))
    })
}

/// Save a central def. A `"<set>"` value keeps the value stored for the same
/// server and key, read in the SAME store section that writes (board #451).
pub fn mcp_save(def: &Value) -> Result<Value, String> {
    let mut m: store::RegMcp = serde_json::from_value(def.clone()).map_err(|_| "invalid mcp: give {\"name\": \"…\", \"def\": \"<def JSON text>\"}".to_string())?;
    if m.name.trim().is_empty() {
        return Err("mcp server needs a name".into());
    }
    mcp_mask::check_central(&m.name, &m.def)?;
    with_store(|store| {
        let stored = store.mcp_list()?.into_iter().find(|s| s.name == m.name).map(|s| s.def);
        m.def = mcp_mask::restore_central(&m.name, &m.def, stored.as_deref())?;
        store.mcp_save(&m, now())?;
        Ok(json!({ "ok": true, "name": m.name }))
    })
}

pub fn mcp_delete(name: &str) -> Result<Value, String> {
    with_store(|store| Ok(json!({ "ok": store.mcp_delete(name)? })))
}

#[cfg(test)]
mod tests {
    use super::super::tests::use_test_store;
    use super::super::{with_registry_skills, with_store};
    use super::*;

    #[test]
    fn parse_github_tree_url() {
        let (o, r, gr, sub) = parse_github(
            "https://github.com/anthropics/claude-code/tree/main/plugins/frontend-design/skills/frontend-design",
        )
        .unwrap();
        assert_eq!(o, "anthropics");
        assert_eq!(r, "claude-code");
        assert_eq!(gr, "main");
        assert_eq!(sub, "plugins/frontend-design/skills/frontend-design");
    }

    #[test]
    fn parse_github_bare_repo_defaults_main() {
        let (o, r, gr, sub) = parse_github("https://github.com/owner/repo").unwrap();
        assert_eq!((o.as_str(), r.as_str(), gr.as_str(), sub.as_str()), ("owner", "repo", "main", ""));
        assert!(parse_github("https://gitlab.com/x/y").is_err(), "only github.com supported");
    }

    #[test]
    fn skill_load_gives_the_root_the_skill_md_and_every_other_file_as_a_path() {
        use_test_store();
        let tag = &uuid::Uuid::new_v4().to_string()[..8];
        // A bundle skill (SKILL.md + scripts + references) and a flat one.
        let bundle = std::env::temp_dir().join(format!("tmm-skill-bundle-{tag}"));
        std::fs::create_dir_all(bundle.join("scripts")).unwrap();
        std::fs::create_dir_all(bundle.join("references")).unwrap();
        std::fs::write(bundle.join("SKILL.md"), "---\nname: bundle\ndescription: does bundled things\n---\nRun scripts/x.sh.\n").unwrap();
        std::fs::write(bundle.join("scripts/x.sh"), "#!/bin/sh\necho x\n").unwrap();
        std::fs::write(bundle.join("references/a.md"), "# A\n").unwrap();
        let flat = std::env::temp_dir().join(format!("tmm-skill-flat-{tag}"));
        std::fs::create_dir_all(&flat).unwrap();
        std::fs::write(flat.join("SKILL.md"), "---\nname: flat\n---\nJust text.").unwrap();
        let (b, f) = (format!("load-bundle-{tag}"), format!("load-flat-{tag}"));
        // The registry row's description differs from the frontmatter's on
        // purpose: load answers the FILE's (review P2-C).
        skill_save(&serde_json::json!({ "name": b, "source": bundle.to_string_lossy(), "description": "the registry's own words" })).unwrap();
        skill_save(&serde_json::json!({ "name": f, "source": flat.to_string_lossy(), "description": "" })).unwrap();

        let r = skill_load(&b).unwrap();
        let root = managed_skills_dir().join(&b).canonicalize().unwrap();
        assert_eq!(r["root"], root.to_string_lossy().as_ref(), "the MANAGED copy, not the source");
        assert_eq!(r["description"], "does bundled things");
        assert!(r["skill_md"].as_str().unwrap().contains("Run scripts/x.sh."), "{r}");
        let files: Vec<(String, String)> = r["files"].as_array().unwrap().iter()
            .map(|f| (f["rel"].as_str().unwrap().to_string(), f["path"].as_str().unwrap().to_string()))
            .collect();
        assert_eq!(files, vec![
            ("references/a.md".to_string(), root.join("references/a.md").to_string_lossy().into_owned()),
            ("scripts/x.sh".to_string(), root.join("scripts/x.sh").to_string_lossy().into_owned()),
        ], "every other file, as an absolute path; SKILL.md is the body, not a file row");
        for (_, path) in &files {
            assert!(std::path::Path::new(path).is_file(), "{path} exists");
        }
        assert_eq!(r["files"][1]["size"], 17);
        assert!(r.get("truncated").is_none());

        let r = skill_load(&f).unwrap();
        assert_eq!(r["files"], serde_json::json!([]), "a flat skill has nothing besides SKILL.md");
        assert_eq!(r["skill_md"].as_str().unwrap(), "---\nname: flat\n---\nJust text.");
        assert_eq!(r["description"], "", "no frontmatter description is an empty one, not the registry's");

        let unknown = skill_load(&format!("load-bundl-{tag}"));
        assert!(unknown.as_ref().is_err_and(|e| e.contains("did you mean") && e.contains(&b)), "{unknown:?}");
        let none = skill_load("zzz-nothing-like-it");
        assert!(none.as_ref().is_err_and(|e| e.contains("try `tmm skills list`")), "{none:?}");
        for path_like in ["../etc", "a/b", ".", "x y"] {
            let refused = skill_load(path_like);
            assert!(refused.as_ref().is_err_and(|e| e == "invalid skill name"), "{path_like}: refused before the store, not merely unknown: {refused:?}");
            let refused = skill_files(path_like);
            assert!(refused.as_ref().is_err_and(|e| e == "invalid skill name"), "{path_like}: the preview refuses it too: {refused:?}");
        }

        // 201 resources in a directory that sorts BEFORE SKILL.md: the body
        // is still there, SKILL.md still leads the preview's listing, and
        // the listing says it is truncated.
        let early = root.join("A");
        std::fs::create_dir_all(&early).unwrap();
        for i in 0..=MAX_LISTED_FILES {
            std::fs::write(early.join(format!("r{i:03}")), "x").unwrap();
        }
        let r = skill_load(&b).unwrap();
        assert!(r["skill_md"].as_str().unwrap().contains("Run scripts/x.sh."));
        assert_eq!(r["truncated"], true);
        let preview = skill_files(&b).unwrap();
        assert_eq!(preview["files"][0]["path"], "SKILL.md", "the preview can always go back to SKILL.md");
        assert_eq!(preview["truncated"], true);
        std::fs::remove_dir_all(&early).unwrap();

        let listed = skills_list().unwrap();
        let row = listed["skills"].as_array().unwrap().iter().find(|s| s["name"] == b.as_str()).unwrap().clone();
        assert_eq!(row["root"], root.to_string_lossy().as_ref(), "the list leads to the files");
        assert_eq!(row["description"], "the registry's own words", "the list shows the declaration, as the Skills page does");

        // A multi-line frontmatter description stays as written in JSON.
        std::fs::write(managed_skills_dir().join(&f).join("SKILL.md"), "---\nname: flat\ndescription: |\n  first line\n  second line\n---\nbody").unwrap();
        assert_eq!(skill_load(&f).unwrap()["description"], "first line\nsecond line");

        // A RELATIVE TMM_STATE_DB (review P2-B): the roots are still absolute,
        // resolved on the gateway's side, and name the same directory.
        let db = std::path::PathBuf::from(std::env::var_os("TMM_STATE_DB").unwrap());
        let cwd = std::env::current_dir().unwrap();
        let up = "../".repeat(cwd.components().count().saturating_sub(1));
        let relative = format!("{up}{}", db.to_string_lossy().trim_start_matches('/'));
        assert!(!relative.starts_with('/'));
        struct Restore(std::ffi::OsString);
        impl Drop for Restore {
            fn drop(&mut self) {
                std::env::set_var("TMM_STATE_DB", &self.0);
            }
        }
        let _restore = Restore(db.clone().into_os_string());
        std::env::set_var("TMM_STATE_DB", &relative);
        let r = skill_load(&b).unwrap();
        assert!(r["root"].as_str().unwrap().starts_with('/'), "{r}");
        assert_eq!(r["root"], root.to_string_lossy().as_ref());
        assert!(r["files"].as_array().unwrap().iter().all(|f| f["path"].as_str().unwrap().starts_with('/')));
        let listed = skills_list().unwrap();
        assert!(listed["skills"].as_array().unwrap().iter().all(|s| s["root"].as_str().unwrap().starts_with('/')), "{listed}");
        drop(_restore);

        for n in [&b, &f] {
            let _ = skill_delete(n);
        }
        let _ = std::fs::remove_dir_all(&bundle);
        let _ = std::fs::remove_dir_all(&flat);
    }

    /// Review P2-A: the listing is bounded per FILE, SKILL.md does not count,
    /// "truncated" means a further file was really found, and a part that
    /// cannot be read is an error, never a shorter list.
    #[test]
    fn the_file_listing_is_bounded_per_file_and_an_unreadable_part_is_an_error() {
        let dir = std::env::temp_dir().join(format!("tmm-skill-walk-{}", uuid::Uuid::new_v4()));
        let make = |sub: &str, n: usize| {
            let d = dir.join(sub);
            std::fs::create_dir_all(&d).unwrap();
            for i in 0..n {
                std::fs::write(d.join(format!("f{i:03}")), "x").unwrap();
            }
        };
        let fresh = |name: &str| {
            let root = dir.join(name);
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("SKILL.md"), "---\nname: x\n---\n").unwrap();
            root
        };
        let others = |l: &Listing| l.files.iter().filter(|(rel, _)| rel != "SKILL.md").count();

        let exact = fresh("exact");
        make("exact", MAX_LISTED_FILES);
        let l = managed_files(&exact).unwrap();
        assert_eq!((others(&l), l.truncated), (MAX_LISTED_FILES, false), "exactly the cap is complete");
        assert_eq!(l.files[0].0, "SKILL.md", "SKILL.md leads and is not counted");

        let over = fresh("over");
        make("over", MAX_LISTED_FILES + 1);
        let l = managed_files(&over).unwrap();
        assert_eq!((others(&l), l.truncated), (MAX_LISTED_FILES, true), "one more is truncated");

        let nested = fresh("nested");
        make("nested/a", 150);
        make("nested/b/deep", 51);
        let l = managed_files(&nested).unwrap();
        assert_eq!((others(&l), l.truncated), (MAX_LISTED_FILES, true), "the cap runs across directories");
        let nested_ok = fresh("nested-ok");
        make("nested-ok/a", 150);
        make("nested-ok/b/deep", 50);
        let l = managed_files(&nested_ok).unwrap();
        assert_eq!((others(&l), l.truncated), (MAX_LISTED_FILES, false));
        assert!(l.files.iter().any(|(rel, _)| rel == "b/deep/f049"));

        // A directory that sorts before SKILL.md and alone exceeds the cap:
        // the walk stops inside it, and SKILL.md still leads the listing.
        let early = fresh("early");
        make("early/A", MAX_LISTED_FILES + 1);
        let l = managed_files(&early).unwrap();
        assert_eq!(l.files[0].0, "SKILL.md", "SKILL.md is taken before the budget runs out");
        assert_eq!((others(&l), l.truncated), (MAX_LISTED_FILES, true));

        let locked = fresh("locked");
        make("locked/secret", 1);
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped the unreadable-dir case: root reads a 0000 directory (this is not coverage)");
        } else {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(locked.join("secret"), std::fs::Permissions::from_mode(0o000)).unwrap();
            let r = managed_files(&locked);
            std::fs::set_permissions(locked.join("secret"), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(r.as_ref().is_err_and(|e| e.contains("secret")), "an unreadable dir is an error naming it: {:?}", r.as_ref().map(|l| l.files.len()));
        }
        assert!(managed_files(&dir.join("absent")).is_err(), "a missing root is not an empty skill");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Review round 2, P2-B: a root that cannot be made absolute is an
    /// error, never the relative path passed off as resolved. A relative
    /// state path whose cwd is gone cannot be made absolute.
    #[test]
    fn a_root_that_cannot_be_made_absolute_is_an_error() {
        // `std::path::absolute` of a relative path needs the cwd; run the
        // case in a child whose cwd was removed, so this process's is never
        // touched.
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "projects::skills::tests::root_resolution_child", "--nocapture", "--test-threads=1", "--ignored"])
            .env("TMM_SKILL_ROOT_CHILD", "1")
            .output()
            .unwrap();
        let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        assert!(out.status.success() && text.contains("1 passed"), "{text}");
    }

    #[test]
    #[ignore = "run only as a child of a_root_that_cannot_be_made_absolute_is_an_error"]
    fn root_resolution_child() {
        if std::env::var_os("TMM_SKILL_ROOT_CHILD").is_none() {
            return;
        }
        let gone = std::env::temp_dir().join(format!("tmm-gone-cwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&gone).unwrap();
        std::env::set_current_dir(&gone).unwrap();
        std::fs::remove_dir(&gone).unwrap();
        std::env::set_var("TMM_STATE_DB", "rel/state.db");
        let r = skill_root("absent-skill");
        assert!(r.as_ref().is_err_and(|e| e.contains("cannot be made absolute")), "{r:?}");
    }

    #[test]
    fn skill_import_owns_the_files_and_refresh_resyncs() {
        use_test_store();
        // A local source directory with a SKILL.md.
        let src = std::env::temp_dir().join(format!("tmm-skill-src-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: demo\n---\nv1").unwrap();
        std::fs::write(src.join("helper.py"), "print(1)").unwrap();

        // Import copies the files into the app-managed store.
        skill_save(&serde_json::json!({
            "name": "demo-skill",
            "source": src.to_string_lossy(),
            "description": "d"
        }))
        .unwrap();
        let managed = managed_skills_dir().join("demo-skill");
        assert!(managed.join("SKILL.md").is_file(), "files live in the managed dir");
        assert!(managed.join("helper.py").is_file());
        assert!(std::fs::read_to_string(managed.join("SKILL.md")).unwrap().ends_with("v1"));
        let listed = with_store(|st| st.skills_list()).unwrap();
        assert!(listed[0].synced_at.is_some(), "import records the sync time");

        // Agents resolve to the MANAGED copy, not the source.
        let map = with_registry_skills();
        assert_eq!(map.get("demo-skill").unwrap(), &managed.to_string_lossy().to_string());

        // Source changes → refresh re-syncs the managed copy.
        std::fs::write(src.join("SKILL.md"), "---\nname: demo\n---\nv2").unwrap();
        skill_refresh("demo-skill").unwrap();
        assert!(std::fs::read_to_string(managed.join("SKILL.md")).unwrap().ends_with("v2"));

        // Delete removes row AND files.
        skill_delete("demo-skill").unwrap();
        assert!(!managed.exists());
        std::fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn builtin_skills_seed_and_are_guarded() {
        use_test_store();
        seed_builtin_skills();
        // Every built-in: a row with source "builtin" + files in the store.
        let listed = with_store(|st| st.skills_list()).unwrap();
        for (name, md) in BUILTIN_SKILLS {
            let row = listed.iter().find(|s| s.name == *name).unwrap_or_else(|| panic!("{name} seeded"));
            assert_eq!(row.source, "builtin");
            assert!(!row.description.is_empty(), "{name}: frontmatter description surfaced");
            let on_disk = std::fs::read_to_string(managed_skills_dir().join(name).join("SKILL.md")).unwrap();
            assert_eq!(&on_disk, *md, "{name}: managed copy matches the embedded one");
        }
        // Reserved: neither deletable nor overwritable from another source.
        let err = skill_delete("mem").unwrap_err();
        assert!(err.contains("built-in"), "{err}");
        let err = skill_save(&serde_json::json!({ "name": "mem", "source": "/tmp/elsewhere" })).unwrap_err();
        assert!(err.contains("built-in"), "{err}");
        // Refresh re-syncs from the BINARY: a drifted managed copy heals.
        std::fs::write(managed_skills_dir().join("mem").join("SKILL.md"), "drifted").unwrap();
        skill_refresh("mem").unwrap();
        let healed = std::fs::read_to_string(managed_skills_dir().join("mem").join("SKILL.md")).unwrap();
        assert_eq!(healed, builtin_skill("mem").unwrap());
        // Reseeding is idempotent.
        seed_builtin_skills();
        assert_eq!(with_store(|st| st.skills_list()).unwrap().len(), listed.len());
    }

    #[test]
    fn skill_import_discovers_plugin_layouts() {
        use_test_store();
        // A claude-plugin-shaped tree: skills live under skills/<name>/.
        let root = std::env::temp_dir().join(format!("tmm-plugin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("skills/alpha")).unwrap();
        std::fs::create_dir_all(root.join("skills/beta/scripts")).unwrap();
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::write(root.join(".claude-plugin/plugin.json"), "{}").unwrap();
        std::fs::write(root.join("skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: first\n---\nA").unwrap();
        std::fs::write(root.join("skills/beta/SKILL.md"), "---\nname: beta\n---\nB").unwrap();
        std::fs::write(root.join("skills/beta/scripts/run.sh"), "echo hi").unwrap();

        let r = skill_import(root.to_str().unwrap()).unwrap();
        let imported: Vec<String> = serde_json::from_value(r["imported"].clone()).unwrap();
        assert_eq!(imported, vec!["alpha", "beta"], "both skills of the plugin land");
        // Each row's source points at ITS OWN dir, so per-skill refresh works.
        let rows = with_store(|st| st.skills_list()).unwrap();
        let alpha = rows.iter().find(|s| s.name == "alpha").unwrap();
        assert!(alpha.source.ends_with("skills/alpha"), "{}", alpha.source);
        assert_eq!(alpha.description, "first");
        skill_refresh("alpha").unwrap();

        // The preview RPCs: files listed (SKILL.md first), text served,
        // escapes refused.
        let f = skill_files("beta").unwrap();
        let paths: Vec<String> = f["files"].as_array().unwrap().iter().map(|v| v["path"].as_str().unwrap().to_string()).collect();
        assert_eq!(paths, vec!["SKILL.md", "scripts/run.sh"]);
        let c = skill_file("beta", "scripts/run.sh").unwrap();
        assert_eq!(c["content"], "echo hi");
        assert!(skill_file("beta", "../alpha/SKILL.md").is_err());
        assert!(skill_file("beta", "/etc/passwd").is_err());

        // A built-in name inside an import is SKIPPED, not stolen.
        let clash = std::env::temp_dir().join(format!("tmm-clash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(clash.join("skills/mem")).unwrap();
        std::fs::write(clash.join("skills/mem/SKILL.md"), "---\nname: mem\n---\nX").unwrap();
        let r = skill_import(clash.to_str().unwrap()).unwrap();
        assert_eq!(r["imported"].as_array().unwrap().len(), 0);
        assert!(r["skipped"][0].as_str().unwrap().contains("mem"));

        std::fs::remove_dir_all(&root).ok();
        std::fs::remove_dir_all(&clash).ok();
    }

    #[test]
    fn skill_import_rejects_bad_names_and_sources() {
        use_test_store();
        let err = skill_save(&serde_json::json!({ "name": "../evil", "source": "/tmp" })).unwrap_err();
        assert!(err.contains("a-zA-Z0-9"), "directory-unsafe names refused: {err}");
        let err = skill_save(&serde_json::json!({ "name": "ok", "source": "relative/path" })).unwrap_err();
        assert!(err.contains("absolute"), "{err}");
        let empty = std::env::temp_dir().join(format!("tmm-noskill-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&empty).unwrap();
        let err = skill_save(&serde_json::json!({ "name": "ok", "source": empty.to_string_lossy() })).unwrap_err();
        assert!(err.contains("SKILL.md"), "{err}");
        std::fs::remove_dir_all(&empty).ok();
    }
}
