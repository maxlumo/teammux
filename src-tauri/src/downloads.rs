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

/// Move the finished part to `dest`, replacing a file of that name (Android
/// has always overwritten a same-name download). A rename across volumes
/// (app cache → a folder on another disk) falls back to copy + remove.
pub fn finish_part(dir: &Path, id: &str, dest: &Path) -> Result<PathBuf, String> {
    check_id(id)?;
    let from = part(dir, id);
    if std::fs::rename(&from, dest).is_err() {
        std::fs::copy(&from, dest).map_err(|e| format!("save: {e}"))?;
        std::fs::remove_file(&from).map_err(|e| format!("remove part: {e}"))?;
    }
    let _ = std::fs::remove_file(sidecar(dir, id));
    release_part(dir, id)?;
    Ok(dest.to_path_buf())
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
        let out = finish_part(&dir, ID, &dir.join("greeting.txt")).unwrap();
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
        finish_part(&dir, ID, &dir.join("v.mp4")).unwrap();
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
}
