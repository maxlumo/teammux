/// File system operations for remote file browsing
use serde::Serialize;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_READ_SIZE: u64 = 50 * 1024 * 1024; // 50MB
const MAX_PREVIEW_SIZE: u64 = 512 * 1024; // 512KB for text preview

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub file_type: String, // "file", "dir", "broken" (target type for navigation; "broken" = dangling symlink)
    pub size: u64,
    pub modified: u64, // unix timestamp
    pub permissions: String,
    pub hidden: bool,
    /// True if this entry is a symbolic link (regardless of target type).
    /// `file_type` reflects the *target* type so navigation Just Works
    /// (clicking a symlink-to-dir behaves like a dir); `is_symlink` lets the
    /// UI render an overlay/badge to distinguish links from regular entries.
    #[serde(default)]
    pub is_symlink: bool,
    /// For symlinks: the raw target path (`readlink`). Empty otherwise.
    /// Useful for tooltips and broken-link diagnostics.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub link_target: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileStat {
    pub path: String,
    pub name: String,
    #[serde(rename = "type")]
    pub file_type: String,
    pub size: u64,
    pub modified: u64,
    pub permissions: String,
    pub readable: bool,
    pub writable: bool,
    pub is_text: bool,
    pub mime_hint: String,
    #[serde(default)]
    pub is_symlink: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub link_target: String,
}

pub fn resolve(p: &str) -> String {
    resolve_path(p).to_string_lossy().to_string()
}

/// Expand `~` to the user's home directory but do NOT canonicalize.
///
/// `list_dir` and `stat_file` use this so the path the user navigated to is
/// preserved verbatim through the response — clicking a symlinked folder
/// keeps you under the symlink path instead of jumping to the canonical
/// target. (`fs::read_dir` and `fs::metadata` follow symlinks at the
/// filesystem layer, so the contents/stat still reflect the real target.)
pub(crate) fn expand_path(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix('~') {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest.trim_start_matches('/'));
        }
    }
    PathBuf::from(p)
}

fn resolve_path(p: &str) -> PathBuf {
    let expanded = expand_path(p);
    // Canonicalize if exists, otherwise return as-is.
    // Used by read/write/delete/rename/upload/download where canonicalization
    // is harmless and helps normalize `..` traversal.
    expanded.canonicalize().unwrap_or(expanded)
}

fn format_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(10);
    let types = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (bit, ch) in types {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
}

pub(crate) fn mime_hint(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "toml" => "application/toml",
        "yaml" | "yml" => "application/yaml",
        "xml" | "html" | "htm" => "text/html",
        "js" | "mjs" | "cjs" => "text/javascript",
        "ts" | "tsx" => "text/typescript",
        "rs" => "text/rust",
        "py" => "text/python",
        "rb" => "text/ruby",
        "go" => "text/go",
        "java" => "text/java",
        "c" | "h" => "text/c",
        "cpp" | "cc" | "cxx" | "hpp" => "text/cpp",
        "css" | "scss" | "less" => "text/css",
        "sh" | "bash" | "zsh" | "fish" => "text/shell",
        "sql" => "text/sql",
        "svelte" => "text/svelte",
        "vue" => "text/vue",
        "txt" | "log" | "env" | "gitignore" | "dockerignore" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" => "application/archive",
        other => streamed_media_type(other).unwrap_or("application/octet-stream"),
    }
    .to_string()
}

/// The ONE lookup for what a browser's own `<video>` / `<audio>` plays from a
/// streamed `/dl` URL (board #182 video, #416 audio): `mime_hint` (what Files
/// calls it) and `server::download::media_content_type` (what `/dl` serves it
/// as, and what may carry a stream signature) both read these rows, so they
/// cannot drift apart. `ext` is lower-case, without the dot. Everything else is
/// `None`: documents and executables never get a media type off `/dl`.
pub(crate) fn streamed_media_type(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        // m4a is AAC in an MP4 container; a bare .aac is ADTS, its own type (review #416).
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "weba" => "audio/webm",
        _ => return None,
    })
}

fn is_text_file(path: &Path, name: &str) -> bool {
    let mime = mime_hint(name);
    if mime.starts_with("text/")
        || mime == "application/json"
        || mime == "application/toml"
        || mime == "application/yaml"
    {
        return true;
    }
    // Check first 512 bytes for binary content
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read;
        let mut buf = [0u8; 512];
        if let Ok(n) = f.read(&mut buf) {
            return !buf[..n].contains(&0);
        }
    }
    false
}

pub fn get_cwd(session: &str) -> Result<String, String> {
    // No session (Files opened standalone, before any terminal pane) → start in
    // the user's home directory. A live session that fails to report a path
    // (e.g. it was just killed) falls back the same way rather than erroring.
    if session.trim().is_empty() {
        return Ok(crate::tmux::home_dir());
    }
    Ok(crate::tmux::pane_cwd(session).unwrap_or_else(|_| crate::tmux::home_dir()))
}

pub fn list_dir(path: &str, show_hidden: bool) -> Result<Vec<FileEntry>, String> {
    // Use expand_path (no canonicalize) so navigating into a symlinked
    // directory keeps the symlink path in the address bar.
    // `fs::read_dir` follows symlinks transparently at the OS level, so the
    // contents listed are still the target's contents.
    let dir = expand_path(path);
    let entries =
        fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {}", dir.display(), e))?;

    let mut result: Vec<FileEntry> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let hidden = name.starts_with('.');
        if !show_hidden && hidden {
            continue;
        }

        // `entry.file_type()` does NOT traverse symlinks (uses dirent/lstat),
        // so it returns Ok even for broken links — that's how we display
        // dangling symlinks instead of silently dropping them.
        let raw_ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let is_symlink = raw_ft.is_symlink();
        let entry_path = entry.path();

        let (file_type, size, modified, mode, link_target) = if is_symlink {
            // Read the link target for display ("readlink" semantics).
            let link_target = fs::read_link(&entry_path)
                .ok()
                .map(|t| t.to_string_lossy().to_string())
                .unwrap_or_default();

            // Try to follow the link to determine target type for navigation
            // and to surface the target's size/mtime (more useful than the
            // link's own metadata for the file list).
            match fs::metadata(&entry_path) {
                Ok(target_meta) => {
                    let kind = if target_meta.is_dir() { "dir" } else { "file" };
                    let m = target_meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    (
                        kind,
                        target_meta.len(),
                        m,
                        target_meta.permissions().mode(),
                        link_target,
                    )
                }
                Err(_) => {
                    // Dangling symlink — fall back to the link's own metadata
                    // (lstat). Marked "broken" so the UI can highlight it.
                    let sm = fs::symlink_metadata(&entry_path).ok();
                    let m = sm
                        .as_ref()
                        .and_then(|s| s.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let mo = sm.as_ref().map(|s| s.permissions().mode()).unwrap_or(0);
                    let sz = sm.as_ref().map(|s| s.len()).unwrap_or(0);
                    ("broken", sz, m, mo, link_target)
                }
            }
        } else {
            // Regular file or directory.
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let kind = if meta.is_dir() { "dir" } else { "file" };
            let m = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (
                kind,
                meta.len(),
                m,
                meta.permissions().mode(),
                String::new(),
            )
        };

        result.push(FileEntry {
            path: entry_path.to_string_lossy().to_string(),
            name,
            file_type: file_type.to_string(),
            size,
            modified,
            permissions: format_permissions(mode),
            hidden,
            is_symlink,
            link_target,
        });
    }

    // Sort: dirs first, then alphabetical (case-insensitive).
    // "broken" symlinks sort with files (after dirs).
    result.sort_by(|a, b| {
        let dir_ord = (a.file_type != "dir").cmp(&(b.file_type != "dir"));
        dir_ord.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(result)
}

pub fn stat_file(path: &str) -> Result<FileStat, String> {
    // Don't canonicalize: keep the path the caller asked for so symlink
    // navigation paths stay stable through the response.
    let p = expand_path(path);
    // First check if it's a symlink (lstat). If yes, capture target for
    // diagnostics and try to follow for the actual stat. Broken symlinks
    // are surfaced with the link's own metadata + "broken" file_type.
    let link_meta = fs::symlink_metadata(&p)
        .map_err(|e| format!("stat error: {} — {}", e, p.display()))?;
    let is_symlink = link_meta.file_type().is_symlink();
    let link_target = if is_symlink {
        fs::read_link(&p)
            .ok()
            .map(|t| t.to_string_lossy().to_string())
            .unwrap_or_default()
    } else {
        String::new()
    };

    let (meta, broken) = match fs::metadata(&p) {
        Ok(m) => (m, false),
        Err(_) if is_symlink => (link_meta.clone(), true),
        Err(e) => return Err(format!("stat error: {} — {}", e, p.display())),
    };

    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let file_type = if broken {
        "broken"
    } else if meta.is_dir() {
        "dir"
    } else {
        "file"
    };
    let mode = meta.permissions().mode();
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let is_text = if !broken && meta.is_file() {
        is_text_file(&p, &name)
    } else {
        false
    };

    Ok(FileStat {
        path: p.to_string_lossy().to_string(),
        name,
        file_type: file_type.to_string(),
        size: meta.len(),
        modified,
        permissions: format_permissions(mode),
        readable: mode & 0o400 != 0,
        writable: mode & 0o200 != 0,
        is_text,
        mime_hint: mime_hint(&p.to_string_lossy()),
        is_symlink,
        link_target,
    })
}

pub fn read_file(path: &str) -> Result<String, String> {
    let p = resolve_path(path);
    let meta = fs::metadata(&p).map_err(|e| format!("read error: {}", e))?;
    if meta.len() > MAX_PREVIEW_SIZE {
        return Err(format!(
            "File too large for preview: {} bytes (max {})",
            meta.len(),
            MAX_PREVIEW_SIZE
        ));
    }
    fs::read_to_string(&p).map_err(|e| format!("read error: {}", e))
}

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    let p = resolve_path(path);
    fs::write(&p, content).map_err(|e| format!("write error: {}", e))
}

pub fn create_dir(path: &str) -> Result<(), String> {
    let p = resolve_path(path);
    fs::create_dir_all(&p).map_err(|e| format!("mkdir error: {}", e))
}

pub fn delete_path(path: &str) -> Result<(), String> {
    let p = resolve_path(path);
    if p.is_dir() {
        fs::remove_dir_all(&p).map_err(|e| format!("delete error: {}", e))
    } else {
        fs::remove_file(&p).map_err(|e| format!("delete error: {}", e))
    }
}

pub fn rename_path(from: &str, to: &str) -> Result<(), String> {
    let f = resolve_path(from);
    let t = resolve_path(to);
    fs::rename(&f, &t).map_err(|e| format!("rename error: {}", e))
}

pub fn download_file(path: &str) -> Result<(String, String), String> {
    let p = resolve_path(path);
    let meta = fs::metadata(&p).map_err(|e| format!("download error: {}", e))?;
    if meta.len() > MAX_READ_SIZE {
        return Err(format!(
            "File too large: {} bytes (max {})",
            meta.len(),
            MAX_READ_SIZE
        ));
    }
    let bytes = fs::read(&p).map_err(|e| format!("download error: {}", e))?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok((name, b64))
}

pub fn upload_file(path: &str, data_b64: &str) -> Result<(), String> {
    let p = resolve_path(path);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| format!("invalid base64: {}", e))?;
    fs::write(&p, &bytes).map_err(|e| format!("upload error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::mime_hint;

    #[test]
    fn video_extensions_are_video_so_files_streams_them() {
        // Board #182: the rows match server::download::media_content_type.
        assert_eq!(mime_hint("demo.MP4"), "video/mp4");
        assert_eq!(mime_hint("/a/b/clip.m4v"), "video/mp4");
        assert_eq!(mime_hint("screen.webm"), "video/webm");
        assert_eq!(mime_hint("take.mov"), "video/quicktime");
        assert_eq!(mime_hint("rip.mkv"), "video/x-matroska");
        // Board #416: audio, one row per extension, the same as media_content_type.
        for (name, mime) in [
            ("song.mp3", "audio/mpeg"), ("MEMO.M4A", "audio/mp4"), ("voice.aac", "audio/aac"),
            ("take.ogg", "audio/ogg"), ("/a/take.oga", "audio/ogg"), ("clip.opus", "audio/ogg"),
            ("beep.wav", "audio/wav"), ("lossless.flac", "audio/flac"), ("clip.weba", "audio/webm"),
        ] {
            assert_eq!(mime_hint(name), mime, "{name}");
        }
        assert_eq!(mime_hint("notes.md"), "text/markdown");
        assert_eq!(mime_hint("blob.bin"), "application/octet-stream");
    }
}
