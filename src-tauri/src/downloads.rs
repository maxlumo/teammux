//! A download being written to disk, resumable across sessions (board #305).
//!
//! Why pieces: Tauri 2 on Android never uses its binary IPC channel
//! (`ipc-protocol.js`: `canUseCustomProtocol = osName !== 'android'`), so a
//! `Uint8Array` argument is JSON-encoded as one number per byte. An 89 MB file
//! became an 89-million-element JS array and ~318 million JSON characters
//! crossing the Java bridge, and the phone failed with "Invalid array length"
//! (owner, 2026-10-04). The webview therefore hands every download over as
//! base64 pieces of at most 4 MiB while the bytes arrive; peak memory is one
//! piece. The desktop shell uses the same commands, so all native downloads
//! share one write path and one resume rule.
//!
//! Layout in `dir`: `.tmm-<id>.part` holds the bytes so far, `.tmm-<id>.json`
//! the server's ETag for them. `id` is the webview's fnv1a64 of server +
//! remote path (16 hex digits), so the same file from the same server finds
//! its part again after a restart. The sidecar records the file name, server
//! path and machine id (board #308, for the Downloads view). On Android the
//! part folder is the public Download/TmuxMobile, hidden only by the dot
//! prefix; on the desktop it is the app cache.
//! The helpers take `dir` as an argument so the tests run on a temp dir with
//! the real filesystem; they are not gated on `gui`, so `test:rust` runs them.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;

/// Where the Android shell keeps downloads: the public Download folder, so a
/// file outlives the app and the system file manager sees it.
pub const ANDROID_DIR: &str = "/storage/emulated/0/Download/TmuxMobile";

/// The prefix of every unfinished-download file; `list_downloads` hides it.
pub const PART_PREFIX: &str = ".tmm-";

/// Just the final path component, never `.`/`..`/empty: a name from the
/// remote server must not choose a directory.
pub fn sanitize_filename(name: &str) -> Result<String, String> {
    let fname = Path::new(name)
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or_else(|| "invalid filename".to_string())?;
    if fname.is_empty() || fname == "." || fname == ".." {
        return Err("invalid filename".to_string());
    }
    Ok(fname.to_string())
}

/// Exactly 16 lowercase hex digits, so an id can only ever name a file
/// inside `dir`.
fn check_id(id: &str) -> Result<(), String> {
    if id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        Ok(())
    } else {
        Err("invalid download id".to_string())
    }
}
fn part(dir: &Path, id: &str) -> PathBuf { dir.join(format!("{PART_PREFIX}{id}.part")) }
fn sidecar(dir: &Path, id: &str) -> PathBuf { dir.join(format!("{PART_PREFIX}{id}.json")) }

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
pub struct PartInfo {
    /// Bytes already on disk.
    pub received: u64,
    /// The server's ETag for those bytes, if it sent one.
    pub etag: Option<String>,
}

/// What a part is OF, so the Downloads view can list it and resume it
/// (board #308): the file name, its path on the server, and the server's
/// machine id (a part resumes only against the server that sent it). This
/// stays in the app's own part folder; `list_downloads` never returns it.
#[derive(serde::Serialize, serde::Deserialize, Default, Clone, Debug, PartialEq)]
pub struct About {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub server: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Sidecar {
    etag: Option<String>,
    #[serde(default, flatten)]
    about: About,
}

/// One unfinished download on disk, for the Downloads view.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct PartListing {
    pub id: String,
    pub received: u64,
    #[serde(flatten)]
    pub about: About,
}

/// Parts that have a writer in this process (validator #305). The webview
/// keeps one attempt per id (Files' module table); this is the second line:
/// `open_part` claims the id and refuses a second claim until `finish_part`
/// or `abort_part` releases it, or the writer gives up (`release_part`, a
/// network failure that keeps the part for a later resume).
static WRITERS: Mutex<Option<HashSet<(PathBuf, String)>>> = Mutex::new(None);

fn claim(dir: &Path, id: &str) -> Result<(), String> {
    let mut held = WRITERS.lock().map_err(|_| "download lock poisoned".to_string())?;
    if held.get_or_insert_with(HashSet::new).insert((dir.to_path_buf(), id.to_string())) {
        Ok(())
    } else {
        Err("this file is already downloading".to_string())
    }
}

/// A new webview (first load or a reload, while the process lives on) has no
/// writer of its own yet: claims left by the previous page are dead
/// (validator #305 P2). The shell calls this once when the page starts.
pub fn release_all() {
    if let Ok(mut held) = WRITERS.lock() { *held = None; }
}

/// Let go of an id without touching its files.
pub fn release_part(dir: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    if let Ok(mut held) = WRITERS.lock() {
        if let Some(set) = held.as_mut() { set.remove(&(dir.to_path_buf(), id.to_string())); }
    }
    Ok(())
}

/// What a previous session left: the part's size and its ETag. No part, or a
/// part without a readable sidecar, counts as nothing to resume.
pub fn open_part(dir: &Path, id: &str) -> Result<PartInfo, String> {
    check_id(id)?;
    claim(dir, id)?;
    let size = std::fs::metadata(part(dir, id)).map(|m| m.len()).ok();
    let meta: Option<Sidecar> = std::fs::read(sidecar(dir, id)).ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok());
    Ok(match (size, meta) {
        (Some(received), Some(meta)) => PartInfo { received, etag: meta.etag },
        _ => PartInfo { received: 0, etag: None },
    })
}

/// Start over for the version `etag` names: empty part, new sidecar.
pub fn reset_part(dir: &Path, id: &str, etag: Option<&str>, about: Option<&About>) -> Result<(), String> {
    check_id(id)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    std::fs::File::create(part(dir, id)).map_err(|e| format!("create: {e}"))?;
    let sidecar_value = Sidecar { etag: etag.map(str::to_string), about: about.cloned().unwrap_or_default() };
    let meta = serde_json::to_vec(&sidecar_value).map_err(|e| e.to_string())?;
    std::fs::write(sidecar(dir, id), meta).map_err(|e| format!("sidecar: {e}"))
}

/// Every unfinished download in `dir` that has a sidecar, newest first. A
/// part without one is not resumable and not listed (open_part's rule).
pub fn list_parts(dir: &Path) -> Vec<PartListing> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<(std::time::SystemTime, PartListing)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(id) = name.to_str()
            .and_then(|n| n.strip_prefix(PART_PREFIX))
            .and_then(|n| n.strip_suffix(".json")) else { continue };
        if check_id(id).is_err() { continue; }
        let Some(meta) = std::fs::read(entry.path()).ok()
            .and_then(|raw| serde_json::from_slice::<Sidecar>(&raw).ok()) else { continue };
        let Ok(stat) = std::fs::metadata(part(dir, id)) else { continue };
        out.push((stat.modified().unwrap_or(std::time::UNIX_EPOCH),
            PartListing { id: id.to_string(), received: stat.len(), about: meta.about }));
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out.into_iter().map(|(_, p)| p).collect()
}

/// Append one base64 piece. The part must have been opened by `reset_part`
/// (a fresh download) or found by `open_part` (a resume).
pub fn append_part(dir: &Path, id: &str, data_b64: &str) -> Result<(), String> {
    check_id(id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("decode: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(part(dir, id))
        .map_err(|e| format!("open part: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("write: {e}"))
}

/// What a finished download does with a file already at its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Existing {
    /// Replace it: the desktop, whose destination the person confirmed in the save dialog.
    Replace,
    /// Keep it, and save under the next free name, `<stem> (1).<ext>`, `(2)`, ... (Android, board #129).
    /// Under scoped storage a file another app or an earlier install owns cannot be replaced (EACCES,
    /// the owner's 'save: Permission denied (os error 13)'), and which files are ours cannot be told
    /// without MediaStore, so one rule for every file, the way browsers name a second download.
    KeepBoth,
}

/// Move the finished part to `dest` (or, with `KeepBoth` and a taken name, to the next free one) and
/// return where it was saved. A rename across volumes (app cache -> a folder on another disk) falls back
/// to copy + remove. A failure names the file it tried and deletes nothing: the caller (download.ts)
/// decides what becomes of the part.
pub fn finish_part(dir: &Path, id: &str, dest: &Path, existing: Existing) -> Result<PathBuf, String> {
    check_id(id)?;
    let from = part(dir, id);
    let saved = match existing {
        Existing::Replace => {
            if std::fs::rename(&from, dest).is_err() {
                std::fs::copy(&from, dest).map_err(|e| save_error(dest, &e))?;
                std::fs::remove_file(&from).map_err(|e| format!("remove part: {e}"))?;
            }
            dest.to_path_buf()
        }
        Existing::KeepBoth => keep_both(&from, dest, &mut |_| {})?,
    };
    let _ = std::fs::remove_file(sidecar(dir, id));
    release_part(dir, id)?;
    Ok(saved)
}

/// How many times in a row a claimed name may be taken from under us before the save gives up. Not a
/// cap on names (validator #129 note 8: every taken name moves on to the next): only the case where
/// another writer keeps replacing what we just created.
const MAX_LOST_CLAIMS: u32 = 3;

/// Claim the first free name with an exclusive create, and write the bytes ONLY through that handle: a
/// file someone else puts at the path afterwards is never written to (validator #129 note 7: a rename
/// onto the reservation would replace whatever is there by then). Once written, the path must still be
/// the file we created (same device and inode); if it is not, our bytes sit in a file nobody can see,
/// so the next free name is claimed and the part is copied again. The part goes only once it is saved.
fn keep_both(from: &Path, dest: &Path, after_claim: &mut dyn FnMut(&Path)) -> Result<PathBuf, String> {
    let mut n: u64 = 0;
    let mut lost = 0;
    loop {
        let candidate = if n == 0 { dest.to_path_buf() } else { numbered(dest, n) };
        n = n.checked_add(1).ok_or_else(|| format!("save {}: no free name", file_label(dest)))?;
        let mut claimed = match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(save_error(&candidate, &e)),
        };
        after_claim(&candidate);
        let written = std::fs::File::open(from)
            .and_then(|mut src| std::io::copy(&mut src, &mut claimed))
            .and_then(|_| claimed.sync_all());
        if let Err(e) = written {
            // Never unlink by path (leader #129 note 30): a file moved onto the path after any check would
            // be deleted. Our own file is emptied through the handle and left, and the error says so.
            // Emptying can fail too (validator #129 note 33: an I/O error refuses the truncate): then the
            // file may hold part of the download, and the error says that instead of 'empty'.
            let emptied = claimed.set_len(0);
            return Err(failed_save(&candidate, &e, emptied, still_ours(&candidate, &claimed)));
        }
        match still_ours(&candidate, &claimed) {
            Ok(true) => {
                std::fs::remove_file(from).map_err(|e| format!("remove part: {e}"))?;
                return Ok(candidate);
            }
            Ok(false) => {}
            // Not a lost claim: the save cannot be confirmed, and says why (board #129 AC3).
            Err(e) => return Err(save_error(&candidate, &e)),
        }
        lost += 1;
        if lost >= MAX_LOST_CLAIMS {
            return Err(format!("save {}: the file was replaced while it was saved", file_label(dest)));
        }
    }
}

/// The error of a failed write into our claimed file, saying truthfully what is left at its name: an
/// empty file (emptied through the handle), possibly part of the download (the emptying failed too:
/// validator #129 note 33), or nothing of ours (the path names another file, or cannot be checked).
fn failed_save(path: &Path, write: &std::io::Error, emptied: std::io::Result<()>, ours: std::io::Result<bool>) -> String {
    let name = file_label(path);
    let msg = save_error(path, write);
    match (emptied, ours) {
        (Ok(()), Ok(true)) => format!("{msg}; an empty {name} remains"),
        (Err(t), Ok(true)) => format!("{msg}; {name} may hold part of the download (emptying it failed: {t} ({:?}))", t.kind()),
        _ => msg,
    }
}

/// Whether the path still names the file behind `file` (same device and inode). `Ok(false)` is a lost
/// claim: the path is gone or names another file. Any other failure to look is an error of its own
/// (reviewer #129), never read as "lost".
fn still_ours(path: &Path, file: &std::fs::File) -> std::io::Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let held = file.metadata()?;
    match std::fs::metadata(path) {
        Ok(at) => Ok(at.dev() == held.dev() && at.ino() == held.ino()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// `cover.png` -> `cover (n).png`; the number goes before the LAST extension (`a.tar.gz` ->
/// `a.tar (n).gz`), after a name with none (`README (n)`, `.bashrc (n)`).
fn numbered(dest: &Path, n: u64) -> PathBuf {
    let stem = dest.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let name = match dest.extension() {
        Some(ext) => format!("{stem} ({n}).{}", ext.to_string_lossy()),
        None => format!("{stem} ({n})"),
    };
    dest.with_file_name(name)
}

fn file_label(path: &Path) -> String {
    path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// 'save <file>: <message> (<kind>)': the file it tried and the error kind, so a real permission
/// failure reads as one (board #129 AC3).
fn save_error(path: &Path, e: &std::io::Error) -> String {
    format!("save {}: {e} ({:?})", file_label(path), e.kind())
}

/// Drop an unfinished download. Absent is fine.
pub fn abort_part(dir: &Path, id: &str) -> Result<(), String> {
    check_id(id)?;
    for path in [part(dir, id), sidecar(dir, id)] {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("remove: {e}")),
        }
    }
    release_part(dir, id)
}

/// The desktop destination comes from the save dialog: it must be an absolute
/// file path in an existing folder.
pub fn checked_dest(dest: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(dest);
    let ok = path.is_absolute()
        && path.file_name().is_some()
        && !path.is_dir()
        && path.parent().is_some_and(|p| p.is_dir());
    if ok { Ok(path) } else { Err("invalid save location".to_string()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef";
    fn b64(bytes: &[u8]) -> String { base64::engine::general_purpose::STANDARD.encode(bytes) }
    fn tmp(tag: &str) -> PathBuf {
        let dir = crate::config::test_scratch(&format!("tmm-dl-{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_fresh_download_appends_in_order_and_finish_moves_it() {
        let dir = tmp("fresh");
        assert_eq!(open_part(&dir, ID).unwrap(), PartInfo { received: 0, etag: None });
        assert_eq!(open_part(&dir, ID).unwrap_err(), "this file is already downloading", "one writer per part");
        assert!(open_part(&tmp("fresh-other"), ID).is_ok(), "the same id in another folder is another part");
        release_part(&tmp("fresh-other"), ID).unwrap();
        reset_part(&dir, ID, Some("\"a-1\""), None).unwrap();
        append_part(&dir, ID, &b64(b"hello ")).unwrap();
        append_part(&dir, ID, &b64(b"world")).unwrap();
        let out = finish_part(&dir, ID, &dir.join("greeting.txt"), Existing::Replace).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"hello world");
        assert!(!part(&dir, ID).exists() && !sidecar(&dir, ID).exists(), "nothing unfinished is left");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_later_session_finds_the_part_and_its_etag() {
        let dir = tmp("resume");
        reset_part(&dir, ID, Some("\"a-1\""), None).unwrap();
        append_part(&dir, ID, &b64(b"12345")).unwrap();
        // A later session: nothing holds the id any more.
        assert_eq!(open_part(&dir, ID).unwrap(), PartInfo { received: 5, etag: Some("\"a-1\"".into()) });
        append_part(&dir, ID, &b64(b"678")).unwrap();
        release_part(&dir, ID).unwrap();
        assert_eq!(open_part(&dir, ID).unwrap().received, 8);
        release_part(&dir, ID).unwrap();
        // The file changed: start over for the new version.
        reset_part(&dir, ID, Some("\"b-2\""), None).unwrap();
        assert_eq!(open_part(&dir, ID).unwrap(), PartInfo { received: 0, etag: Some("\"b-2\"".into()) });
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_part_without_its_sidecar_is_not_resumed() {
        let dir = tmp("orphan");
        std::fs::write(part(&dir, ID), b"stale").unwrap();
        assert_eq!(open_part(&dir, ID).unwrap(), PartInfo { received: 0, etag: None });
        release_part(&dir, ID).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finish_replaces_a_same_name_file_and_abort_is_idempotent() {
        let dir = tmp("finish");
        std::fs::write(dir.join("v.mp4"), b"old").unwrap();
        reset_part(&dir, ID, None, None).unwrap();
        append_part(&dir, ID, &b64(b"new")).unwrap();
        finish_part(&dir, ID, &dir.join("v.mp4"), Existing::Replace).unwrap();
        assert_eq!(std::fs::read(dir.join("v.mp4")).unwrap(), b"new");
        reset_part(&dir, ID, None, None).unwrap();
        abort_part(&dir, ID).unwrap();
        abort_part(&dir, ID).unwrap();
        assert!(!part(&dir, ID).exists() && !sidecar(&dir, ID).exists());
        assert!(append_part(&dir, ID, &b64(b"x")).is_err(), "no append without a reset or a found part");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_refused_claim_leaves_the_first_writer_alone_and_a_new_page_frees_all() {
        let dir = tmp("claim");
        open_part(&dir, ID).unwrap();
        reset_part(&dir, ID, None, None).unwrap();
        append_part(&dir, ID, &b64(b"first")).unwrap();
        assert!(open_part(&dir, ID).is_err(), "the second writer is refused");
        append_part(&dir, ID, &b64(b" writer")).unwrap();
        assert_eq!(std::fs::read(part(&dir, ID)).unwrap(), b"first writer", "and the first keeps writing");
        release_all();
        assert!(open_part(&dir, ID).is_ok(), "a reloaded page may resume the part");
        release_part(&dir, ID).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_view_lists_parts_with_what_they_are_of() {
        let dir = tmp("list");
        let about = About { name: "v.mp4".into(), path: "/home/u/v.mp4".into(), server: "m1".into() };
        open_part(&dir, ID).unwrap();
        reset_part(&dir, ID, Some("\"a-1\""), Some(&about)).unwrap();
        append_part(&dir, ID, &b64(b"12345")).unwrap();
        release_part(&dir, ID).unwrap();
        std::fs::write(part(&dir, "fedcba9876543210"), b"orphan").unwrap();   // no sidecar: not listed
        std::fs::write(dir.join("v.mp4"), b"a finished file").unwrap();       // not a part
        assert_eq!(list_parts(&dir), vec![PartListing { id: ID.into(), received: 5, about: about.clone() }]);
        // The etag still resumes: the sidecar gained fields, it did not lose one.
        assert_eq!(open_part(&dir, ID).unwrap(), PartInfo { received: 5, etag: Some("\"a-1\"".into()) });
        release_part(&dir, ID).unwrap();
        // A sidecar from before #308 (etag only) is still read.
        std::fs::write(sidecar(&dir, ID), br#"{"etag":"\"a-1\""}"#).unwrap();
        assert_eq!(list_parts(&dir)[0].about, About::default());
        abort_part(&dir, ID).unwrap();
        assert!(list_parts(&dir).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn ids_names_and_destinations_cannot_escape() {
        let dir = tmp("escape");
        for bad in ["../../etc/passw", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdefa", ""] {
            assert!(reset_part(&dir, bad, None, None).is_err(), "{bad:?}");
            assert!(open_part(&dir, bad).is_err(), "{bad:?}");
            assert!(abort_part(&dir, bad).is_err(), "{bad:?}");
        }
        reset_part(&dir, ID, None, None).unwrap();
        assert!(append_part(&dir, ID, "not base64!").is_err());
        assert_eq!(sanitize_filename("../../etc/passwd").unwrap(), "passwd");
        assert!(sanitize_filename("..").is_err());
        assert!(checked_dest("relative/file.bin").is_err());
        assert!(checked_dest("/no/such/folder/file.bin").is_err());
        assert!(checked_dest(dir.to_str().unwrap()).is_err(), "a folder is not a file to save to");
        assert!(checked_dest(dir.join("out.bin").to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Board #129 (owner 2026-11-15: 'save: Permission denied (os error 13)' for cover.png on Android): under
    // scoped storage a file another app (or an earlier install) owns cannot be replaced, so Android never
    // replaces: the next free name is chosen the way browsers do, with an exclusive create.
    fn finished(dir: &Path, bytes: &[u8], name: &str) -> Result<PathBuf, String> {
        reset_part(dir, ID, None, None).unwrap();
        append_part(dir, ID, &b64(bytes)).unwrap();
        finish_part(dir, ID, &dir.join(name), Existing::KeepBoth)
    }

    #[test]
    fn keep_both_saves_under_the_name_when_it_is_free() {
        let dir = tmp("keep-free");
        let out = finished(&dir, b"new", "cover.png").unwrap();
        assert_eq!(out, dir.join("cover.png"));
        assert_eq!(std::fs::read(&out).unwrap(), b"new");
        assert!(!part(&dir, ID).exists() && !sidecar(&dir, ID).exists(), "the part is gone");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keep_both_never_replaces_a_same_name_file_and_takes_the_next_free_number() {
        let dir = tmp("keep-taken");
        std::fs::write(dir.join("cover.png"), b"the browser's").unwrap();
        let first = finished(&dir, b"ours 1", "cover.png").unwrap();
        assert_eq!(first, dir.join("cover (1).png"));
        let second = finished(&dir, b"ours 2", "cover.png").unwrap();
        assert_eq!(second, dir.join("cover (2).png"), "(1) is taken too");
        assert_eq!(std::fs::read(dir.join("cover.png")).unwrap(), b"the browser's", "the existing file is untouched");
        assert_eq!(std::fs::read(&first).unwrap(), b"ours 1");
        assert_eq!(std::fs::read(&second).unwrap(), b"ours 2");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keep_both_numbers_before_the_last_extension_and_after_a_bare_or_dot_name() {
        let dir = tmp("keep-names");
        for (name, want) in [("a.tar.gz", "a.tar (1).gz"), ("README", "README (1)"), (".bashrc", ".bashrc (1)"), ("旷野微光.png", "旷野微光 (1).png")] {
            std::fs::write(dir.join(name), b"old").unwrap();
            assert_eq!(finished(&dir, b"new", name).unwrap(), dir.join(want), "{name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keep_both_skips_a_name_that_appears_before_it_claims_one() {
        // The exclusive create is the claim: a name taken between the listing and the move is never
        // overwritten. Simulated by the free candidates being taken one after another up front.
        let dir = tmp("keep-race");
        for name in ["cover.png", "cover (1).png", "cover (2).png"] { std::fs::write(dir.join(name), name).unwrap(); }
        assert_eq!(finished(&dir, b"new", "cover.png").unwrap(), dir.join("cover (3).png"));
        for name in ["cover.png", "cover (1).png", "cover (2).png"] { assert_eq!(std::fs::read(dir.join(name)).unwrap(), name.as_bytes()); }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_real_permission_failure_is_reported_with_the_destination_and_its_kind() {
        // A folder this process may not write: the parts live elsewhere, the destination's folder is
        // read-only. The error names the file it tried and the error kind; nothing is renamed again.
        let dir = tmp("keep-denied");
        let shut = tmp("keep-denied-dest");
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o555)).unwrap();
        reset_part(&dir, ID, None, None).unwrap();
        append_part(&dir, ID, &b64(b"x")).unwrap();
        let err = finish_part(&dir, ID, &shut.join("cover.png"), Existing::KeepBoth).unwrap_err();
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.starts_with("save cover.png: "), "{err}");
        assert!(err.contains("PermissionDenied"), "{err}");
        assert!(part(&dir, ID).exists(), "finish_part deletes nothing on a failure: download.ts decides (a save failure aborts the part)");
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&shut).unwrap();
    }

    #[test]
    fn replace_still_replaces_the_path_the_desktop_dialog_confirmed() {
        let dir = tmp("replace");
        std::fs::write(dir.join("out.bin"), b"old").unwrap();
        reset_part(&dir, ID, None, None).unwrap();
        append_part(&dir, ID, &b64(b"new")).unwrap();
        assert_eq!(finish_part(&dir, ID, &dir.join("out.bin"), Existing::Replace).unwrap(), dir.join("out.bin"));
        assert_eq!(std::fs::read(dir.join("out.bin")).unwrap(), b"new");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Validator #129 notes 7-8: a name taken AFTER our claim. Whatever happens to the reserved path between
    // the claim and the write (replaced by another app's file, or removed), that file is never written to;
    // the download lands under the next free name and the returned path is where its bytes are.
    fn finished_with(dir: &Path, bytes: &[u8], name: &str, after_claim: &mut dyn FnMut(&Path)) -> Result<PathBuf, String> {
        reset_part(dir, ID, None, None).unwrap();
        append_part(dir, ID, &b64(bytes)).unwrap();
        let out = keep_both(&part(dir, ID), &dir.join(name), after_claim);
        if out.is_ok() { let _ = std::fs::remove_file(sidecar(dir, ID)); release_part(dir, ID).unwrap(); }
        out
    }

    #[test]
    fn a_reservation_replaced_after_the_claim_is_left_alone_and_the_download_takes_the_next_name() {
        let dir = tmp("keep-post-claim");
        let mut first = true;
        let out = finished_with(&dir, b"new-download", "cover.png", &mut |claimed| {
            if std::mem::take(&mut first) {
                std::fs::remove_file(claimed).unwrap();
                std::fs::write(claimed, b"other-app").unwrap();
            }
        }).unwrap();
        assert_eq!(std::fs::read(dir.join("cover.png")).unwrap(), b"other-app", "the other app's file is untouched");
        assert_eq!(out, dir.join("cover (1).png"));
        assert_eq!(std::fs::read(&out).unwrap(), b"new-download", "the returned path holds the download");
        assert!(!part(&dir, ID).exists(), "the part goes only once its bytes are saved");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_reservation_removed_after_the_claim_is_claimed_again_and_the_bytes_land() {
        let dir = tmp("keep-post-claim-gone");
        let mut first = true;
        let out = finished_with(&dir, b"new-download", "cover.png", &mut |claimed| {
            if std::mem::take(&mut first) { std::fs::remove_file(claimed).unwrap(); }
        }).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"new-download");
        assert!(out.starts_with(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn there_is_no_cap_on_the_number_a_name_may_take() {
        // Validator note 8: 'a download never fails because a file of that name already exists'.
        let dir = tmp("keep-many");
        std::fs::write(dir.join("cover.png"), b"0").unwrap();
        for n in 1..=1000 { std::fs::write(dir.join(format!("cover ({n}).png")), b"x").unwrap(); }
        assert_eq!(finished(&dir, b"new", "cover.png").unwrap(), dir.join("cover (1001).png"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failure_to_read_back_the_saved_file_is_reported_with_its_kind_not_as_a_lost_claim() {
        // Reviewer #129: only a missing path or another inode means the claim was lost; a stat that fails
        // for another reason (here PermissionDenied: the folder stops being searchable after the claim)
        // is reported as itself.
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("keep-stat-error");
        let dest_dir = tmp("keep-stat-error-dest");
        reset_part(&dir, ID, None, None).unwrap();
        append_part(&dir, ID, &b64(b"x")).unwrap();
        let err = keep_both(&part(&dir, ID), &dest_dir.join("cover.png"), &mut |_| {
            std::fs::set_permissions(&dest_dir, std::fs::Permissions::from_mode(0o600)).unwrap();
        }).unwrap_err();
        std::fs::set_permissions(&dest_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err.starts_with("save cover.png: ") && err.contains("PermissionDenied"), "{err}");
        assert!(!err.contains("replaced"), "{err}");
        assert!(part(&dir, ID).exists(), "nothing confirmed, so the part stays");
        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&dest_dir).unwrap();
    }

    // Leader #129 note 30 (reviewer notes 25, 29): a failed write never unlinks by path. Our own file is
    // emptied through the handle and left; a file someone moved onto the path meanwhile is not touched.
    fn unreadable_part(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(part(dir, ID), std::fs::Permissions::from_mode(0o000)).unwrap();
    }

    #[test]
    fn a_failed_write_empties_our_own_file_through_the_handle_and_says_it_remains() {
        let dir = tmp("keep-write-fails");
        let err = finished_with(&dir, b"new-download", "cover.png", &mut |_| unreadable_part(&dir)).unwrap_err();
        assert!(err.starts_with("save cover.png: ") && err.contains("PermissionDenied"), "{err}");
        assert!(err.ends_with("; an empty cover.png remains"), "{err}");
        assert_eq!(std::fs::metadata(dir.join("cover.png")).unwrap().len(), 0, "no partial content");
        assert!(part(&dir, ID).exists(), "nothing confirmed, so the part stays");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_failed_write_after_a_swap_leaves_the_file_moved_onto_the_path_alone() {
        let dir = tmp("keep-write-fails-swap");
        let err = finished_with(&dir, b"new-download", "cover.png", &mut |claimed| {
            std::fs::remove_file(claimed).unwrap();
            std::fs::write(claimed, b"moved-here").unwrap();
            unreadable_part(&dir);
        }).unwrap_err();
        assert_eq!(std::fs::read(dir.join("cover.png")).unwrap(), b"moved-here", "never unlinked, never written");
        assert!(err.contains("PermissionDenied") && !err.contains("remains"), "nothing of ours is at that name: {err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keep_both_never_unlinks_the_claimed_path() {
        // The race reviewer #129 found sat between an identity check and a pathname unlink, which no seam
        // can hold open deterministically; the rule is that the unlink does not exist (leader note 30).
        let src = include_str!("downloads.rs");
        let body = &src[src.find("fn keep_both(").unwrap()..src.find("fn still_ours(").unwrap()];
        assert!(!body.contains("remove_file(&candidate"), "keep_both must not unlink the claimed path");
        assert!(body.contains("set_len(0)"), "a failed write empties our own file through the handle");
    }

    #[test]
    fn a_failed_save_says_what_is_left_at_its_name_even_when_emptying_fails() {
        // Validator #129 note 33: emptying through the handle can be refused too (an I/O error); then the
        // file may hold part of the download, and the message must not call it empty.
        use std::io::{Error, ErrorKind};
        let path = Path::new("/d/cover.png");
        let eio = || Error::new(ErrorKind::Other, "Input/output error");
        let write = eio();
        assert_eq!(failed_save(path, &write, Ok(()), Ok(true)),
            "save cover.png: Input/output error (Other); an empty cover.png remains");
        assert_eq!(failed_save(path, &write, Err(eio()), Ok(true)),
            "save cover.png: Input/output error (Other); cover.png may hold part of the download (emptying it failed: Input/output error (Other))");
        assert_eq!(failed_save(path, &write, Ok(()), Ok(false)), "save cover.png: Input/output error (Other)",
            "the path names another file: nothing of ours is said to be there");
        assert_eq!(failed_save(path, &write, Err(eio()), Err(Error::from(ErrorKind::PermissionDenied))), "save cover.png: Input/output error (Other)");
    }
}
