//! The signed HTTP upload channel on the gateway port (board #23), the /dl
//! door's twin. An authenticated `fs_upload_begin` fixes the destination
//! (through `fs::upload_target`, the one upload validator) and the size, and
//! answers an id and a short-lived signed URL. The bytes then arrive as
//! `PUT …/up/{id}?exp=E&sig=S` chunks, each carrying its `Upload-Offset`;
//! only the next expected offset is accepted. They go to a part file beside
//! the destination, which is renamed onto it when the last byte lands.
//!
//! The request carries NO path and NO size: both come from the server's own
//! entry, and the signature covers them, so one URL can write exactly one
//! destination, at most its declared size, and nothing else. The registry is
//! in memory (tenet 7): a restart forgets every upload, and the next begin in
//! that directory sweeps its stale part files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// What the client sends per PUT. 4 MiB, the phone's download chunk.
pub(super) const CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// The largest body one PUT may carry: two chunks, so a client may pick a
/// bigger chunk later without a server change, and nothing larger is buffered.
const MAX_PUT_BYTES: u64 = 2 * CHUNK_BYTES;
/// A signed URL lives this long; `fs_upload_resume` mints a fresh one.
const URL_TTL_SECS: u64 = 15 * 60;
/// An upload with no PUT and no resume for this long is expired: its part
/// file is removed and its id forgotten.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// Domain separation: the upload MAC is keyed by HMAC(token, UPLOAD_LABEL),
/// so an upload tag never verifies as a /dl or a scope tag, or the reverse.
const UPLOAD_LABEL: &[u8] = b"tmm-upload-v1";
const PART_SUFFIX: &str = ".tmm-part";
/// A body read that waits this long for a byte counts as a dropped
/// connection. A phone that loses its network sends no FIN, and without
/// this the PUT would hold the upload's lock for ever and every resume
/// would answer "busy" (found by the cut-body test, #23).
const BODY_STALL: Duration = Duration::from_secs(30);

/// One upload. What the signature binds is fixed at begin and read without
/// the lock; the progress is behind it, held by the one PUT writing.
///
/// Every filesystem step after begin goes through handles begin opened
/// (validator-2, round 1): `dir`, the destination's directory, and `file`, the
/// part it created there with `openat(…, O_CREAT|O_EXCL|O_NOFOLLOW)`. Chunks
/// are written through `file`, never a reopened path; the commit is
/// `renameat` in `dir`, abort and expiry `unlinkat`. Before each chunk and the
/// commit the part's NAME must still be that file (`fstatat` without following
/// a link, against `ino`); holding `file` keeps its inode from being reused by
/// a replacement. A symlink or another file swapped in at the part's name is
/// refused, and a directory swapped in at the parent's path is never looked
/// at: no step resolves a path again. What can still be swapped is an entry INSIDE that directory, which
/// whoever can do so could already replace at the destination itself; nothing
/// is ever written through a link.
struct Upload {
    dest: PathBuf,
    part: PathBuf,
    dir: std::fs::File,
    file: std::fs::File,
    part_name: std::ffi::CString,
    dest_name: std::ffi::CString,
    /// (dev, ino) of the part file begin created.
    ino: (u64, u64),
    size: u64,
    /// The mode the destination gets at commit.
    mode: u32,
    state: tokio::sync::Mutex<Progress>,
}

fn cstr(name: &std::ffi::OsStr) -> std::io::Result<std::ffi::CString> {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(name.as_bytes()).map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
}

fn cvt(r: libc::c_int) -> std::io::Result<libc::c_int> {
    if r < 0 { Err(std::io::Error::last_os_error()) } else { Ok(r) }
}

/// The directory `path` names, opened once (`O_DIRECTORY|O_NOFOLLOW`).
fn open_dir(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    let c = cstr(path.as_os_str())?;
    // SAFETY: `c` is NUL-terminated; a non-negative result is a new fd we own.
    let fd = cvt(unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

/// A new `name` in `dir`, created exclusively, never through a symlink.
fn create_in(dir: &std::fs::File, name: &std::ffi::CStr) -> std::io::Result<std::fs::File> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let flags = libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_CREAT | libc::O_EXCL;
    // SAFETY: a valid directory fd and a NUL-terminated name; we own the result.
    let fd = cvt(unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags, 0o666 as libc::c_uint) })?;
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

fn rename_in(dir: &std::fs::File, from: &std::ffi::CStr, to: &std::ffi::CStr) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: a valid directory fd and two NUL-terminated names.
    cvt(unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) }).map(|_| ())
}

fn unlink_in(dir: &std::fs::File, name: &std::ffi::CStr) {
    use std::os::fd::AsRawFd;
    // SAFETY: a valid directory fd and a NUL-terminated name.
    unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) };
}

/// Whether `name` in `dir` is, without following a link, the file `ino` names.
fn names(dir: &std::fs::File, name: &std::ffi::CStr, ino: (u64, u64)) -> bool {
    use std::os::fd::AsRawFd;
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: a valid directory fd, a NUL-terminated name, a valid out-pointer.
    if unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 { return false; }
    (st.st_mode & libc::S_IFMT) == libc::S_IFREG && (st.st_dev as u64, st.st_ino as u64) == ino
}

fn dev_ino(f: &std::fs::File) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    f.metadata().ok().map(|m| (m.dev(), m.ino()))
}

/// `received` is the part file's real length, read from the file at every
/// PUT and resume (validator, round 1 P1: it was a counter that a failed
/// write could run ahead of). Within a PUT it advances by what each
/// positional write RETURNED, never by what was handed over.
struct Progress {
    received: u64,
    last: Instant,
}

/// What the part file holds, from the file itself.
fn on_disk(up: &Upload) -> Option<u64> {
    up.file.metadata().ok().map(|m| m.len())
}

type Slot = Arc<Upload>;

/// The uploads this process knows: `live` ones, and a `done` receipt for each
/// committed one (reviewer P1-R1 on 651962df). A receipt lets a client whose
/// final 201 was lost learn from `fs_upload_resume` that the file landed,
/// instead of "no such upload" and a Retry from byte 0 over a complete file.
/// It is written only after the commit's rename succeeded, holds no file or
/// directory handle, does not hold the destination (a new upload may begin
/// there), and expires after IDLE like an idle upload; abort forgets it.
#[derive(Default)]
struct Registry {
    live: HashMap<String, Slot>,
    done: HashMap<String, Receipt>,
}

struct Receipt {
    size: u64,
    at: Instant,
}

fn registry() -> &'static Mutex<Registry> {
    static R: OnceLock<Mutex<Registry>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Registry::default()))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

fn upload_mac(token: &str, id: &str, exp: u64, size: u64, dest: &Path) -> Hmac<Sha256> {
    let mut key = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes()).unwrap();
    key.update(UPLOAD_LABEL);
    let key = key.finalize().into_bytes();
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).unwrap();
    // NUL-separated: the id is hex, exp and size are decimal, and a
    // destination holds no NUL (refused by `upload_target`).
    mac.update(b"v1\0");
    mac.update(id.as_bytes());
    mac.update(b"\0");
    mac.update(exp.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(size.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(dest.as_os_str().as_encoded_bytes());
    mac
}

fn sign_upload(token: &str, id: &str, exp: u64, size: u64, dest: &Path) -> String {
    hex::encode(upload_mac(token, id, exp, size, dest).finalize().into_bytes())
}

/// Constant time (`verify_slice`), the expiry inside its ceiling, every
/// bound field from the server's entry.
fn verify_upload(token: &str, id: &str, exp: u64, sig: &str, e: &Upload) -> bool {
    let now = unix_now();
    if exp < now || exp > now + URL_TTL_SECS { return false; }
    let Ok(sig) = hex::decode(sig) else { return false };
    upload_mac(token, id, exp, e.size, &e.dest).verify_slice(&sig).is_ok()
}

fn url_for(token: &str, id: &str, e: &Upload) -> String {
    let exp = unix_now() + URL_TTL_SECS;
    format!("/up/{id}?exp={exp}&sig={}", sign_upload(token, id, exp, e.size, &e.dest))
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// `.<name>.<32 hex>.tmm-part`, the ONLY shape the stale sweep removes.
fn part_name(name: &std::ffi::OsStr, id: &str) -> std::ffi::OsString {
    let mut s = std::ffi::OsString::from(".");
    s.push(name);
    s.push(format!(".{id}{PART_SUFFIX}"));
    s
}

fn is_part_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix('.').and_then(|r| r.strip_suffix(PART_SUFFIX)) else { return false };
    let Some((stem, id)) = rest.rsplit_once('.') else { return false };
    !stem.is_empty() && valid_id(id)
}

/// Forget every entry idle since before `now - IDLE`, removing its part file.
/// Entries busy in a PUT are left alone (their lock is held).
fn expire_idle(now: Instant) {
    let mut reg = registry().lock().unwrap();
    reg.done.retain(|_, r| now.saturating_duration_since(r.at) <= IDLE);
    reg.live.retain(|_, up| {
        let Ok(p) = up.state.try_lock() else { return true };
        if now.saturating_duration_since(p.last) <= IDLE { return true; }
        unlink_in(&up.dir, &up.part_name);
        false
    });
}

/// After a restart the registry is empty but part files may remain: remove
/// those in `dir` that have our exact name shape, are not a live upload's,
/// and were last written before IDLE. Nothing else in the directory is
/// touched (orchestrator, #23 design note b).
fn sweep_stale_parts(dir: &Path) {
    let live: Vec<PathBuf> = registry().lock().unwrap().live.values().map(|u| u.part.clone()).collect();
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let name = ent.file_name();
        if !name.to_str().is_some_and(is_part_name) { continue; }
        let path = ent.path();
        if live.contains(&path) { continue; }
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() { continue; }
        let old = meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age > IDLE);
        if old { let _ = std::fs::remove_file(&path); }
    }
}

/// Free bytes for an unprivileged writer in the opened directory.
fn free_bytes(dir: &std::fs::File) -> Option<u64> {
    use std::os::fd::AsRawFd;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: a valid fd and a valid out-pointer.
    if unsafe { libc::fstatvfs(dir.as_raw_fd(), &mut st) } != 0 { return None; }
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

fn mib(n: u64) -> String { format!("{:.1} MiB", n as f64 / (1024.0 * 1024.0)) }

/// `fs_upload_begin {path, size}`.
pub(super) fn begin(token: &str, path: &str, size: u64) -> Result<serde_json::Value, String> {
    let dest = crate::fs::upload_target(path)?;
    let dir = dest.parent().ok_or("upload path has no directory")?.to_path_buf();
    let name = dest.file_name().ok_or("upload path has no file name")?.to_os_string();
    expire_idle(Instant::now());
    sweep_stale_parts(&dir);
    let dirf = open_dir(&dir).map_err(|e| format!("cannot open {}: {e}", dir.display()))?;
    if let Some(free) = free_bytes(&dirf) {
        if free < size {
            return Err(format!("not enough space in {}: {} needed, {} free", dir.display(), mib(size), mib(free)));
        }
    }
    let id = hex::encode(rand::random::<[u8; 16]>());
    let pname = part_name(&name, &id);
    let part = dir.join(&pname);
    let part_c = cstr(&pname).map_err(|e| format!("upload path: {e}"))?;
    let dest_c = cstr(&name).map_err(|e| format!("upload path: {e}"))?;
    let mut reg = registry().lock().unwrap();
    let map = &mut reg.live;
    // One upload per destination. One that is not writing a chunk and has
    // gained nothing for BODY_STALL is abandoned (a page reload, a closed tab;
    // validator-2, round 1): this begin takes it over, its part removed and its
    // id forgotten. One whose chunk is being written is never taken over.
    let mut abandoned = None;
    for (other, up) in map.iter() {
        if up.dest != dest { continue; }
        let idle = up.state.try_lock().is_ok_and(|p| p.last.elapsed() >= BODY_STALL);
        if !idle { return Err(format!("upload in progress: {}", dest.display())); }
        abandoned = Some(other.clone());
    }
    if let Some(other) = abandoned {
        if let Some(up) = map.remove(&other) { unlink_in(&up.dir, &up.part_name); }
    }
    // The committed file gets the mode `fs::write` gave an upload: an
    // existing file keeps its own, a new one is 0666 under the umask. The
    // part file is created that way to learn the mode without touching the
    // process umask, then held at 0600 while it is incomplete.
    use std::os::unix::fs::PermissionsExt;
    let file = create_in(&dirf, &part_c).map_err(|e| format!("cannot create {}: {e}", part.display()))?;
    let new_mode = file.metadata().map(|m| m.permissions().mode() & 0o777).unwrap_or(0o644);
    // `& 0o777`: an overwrite by `fs::write` made the kernel drop S_ISUID and
    // S_ISGID, so the committed file carries neither (validator, round 1 P2).
    let mode = std::fs::metadata(&dest).map(|m| m.permissions().mode() & 0o777).unwrap_or(new_mode);
    let ino = dev_ino(&file).ok_or("cannot stat the part file")?;
    if size == 0 {
        // Nothing to send: the empty file commits now, by the same rename.
        let _ = file.set_permissions(std::fs::Permissions::from_mode(mode));
        drop(file);
        rename_in(&dirf, &part_c, &dest_c).map_err(|e| { unlink_in(&dirf, &part_c); format!("upload commit: {e}") })?;
        reg.done.insert(id.clone(), Receipt { size: 0, at: Instant::now() });
        return Ok(serde_json::json!({ "id": id, "url": "", "chunk": CHUNK_BYTES, "received": 0, "done": true }));
    }
    let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    let up = Arc::new(Upload {
        dest, part, dir: dirf, file, part_name: part_c, dest_name: dest_c, ino, size, mode,
        state: tokio::sync::Mutex::new(Progress { received: 0, last: Instant::now() }),
    });
    let url = url_for(token, &id, &up);
    map.insert(id.clone(), up);
    Ok(serde_json::json!({ "id": id, "url": url, "chunk": CHUNK_BYTES, "received": 0 }))
}

/// `fs_upload_resume {id}`: a fresh URL and the bytes the server holds.
/// While a PUT is still writing (the client gave up on it before the server
/// noticed), its count is not final: "busy", and the client asks again.
pub(super) fn resume(token: &str, id: &str) -> Result<serde_json::Value, String> {
    expire_idle(Instant::now());
    let up = {
        let reg = registry().lock().unwrap();
        if let Some(r) = reg.done.get(id) {
            return Ok(serde_json::json!({ "url": "", "received": r.size, "chunk": CHUNK_BYTES, "done": true }));
        }
        reg.live.get(id).cloned().ok_or_else(|| format!("no such upload: {id}"))?
    };
    let mut p = up.state.try_lock().map_err(|_| "upload busy: a chunk is still being written".to_string())?;
    p.received = on_disk(&up).ok_or("cannot read the part file")?;
    p.last = Instant::now();
    Ok(serde_json::json!({ "url": url_for(token, id, &up), "received": p.received, "chunk": CHUNK_BYTES }))
}

/// `fs_upload_abort {id}`: the id is forgotten and the part file removed. A
/// PUT still writing goes on into the unlinked file through its handle, and
/// its commit finds the part's name no longer that file, so nothing reaches
/// the destination.
pub(super) fn abort(id: &str) -> Result<serde_json::Value, String> {
    let mut reg = registry().lock().unwrap();
    reg.done.remove(id);
    if let Some(up) = reg.live.remove(id) {
        unlink_in(&up.dir, &up.part_name);
    }
    Ok(serde_json::json!({ "ok": true }))
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Upload-Offset\r\n";

/// The preflight a cross-origin PUT with `Upload-Offset` needs (a Tauri page,
/// the Vite dev server). It checks nothing and touches no file.
const PREFLIGHT: &str = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: PUT\r\nAccess-Control-Allow-Headers: Upload-Offset, Content-Type\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

async fn answer<S: tokio::io::AsyncWrite + Unpin>(stream: &mut S, status: &str, offset: Option<u64>) {
    use tokio::io::AsyncWriteExt;
    let off = offset.map(|o| format!("Upload-Offset: {o}\r\n")).unwrap_or_default();
    let _ = stream.write_all(format!("HTTP/1.1 {status}\r\n{off}{CORS}Content-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await;
    let _ = stream.flush().await;
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.split("\r\n").skip(1).find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// The door's tail: the LAST `/up/` whose segment is a well-formed id, so a
/// proxy prefix (`/tmux/up/x/…`) cannot be mistaken for it.
fn parse_target(target: &str) -> Option<(&str, u64, &str)> {
    let (path, query) = target.split_once('?')?;
    let at = path.rfind("/up/")?;
    let id = &path[at + 4..];
    if !valid_id(id) { return None; }
    let mut exp = None;
    let mut sig = None;
    for kv in query.split('&') {
        match kv.split_once('=') {
            Some(("exp", v)) => exp = v.parse().ok(),
            Some(("sig", v)) => sig = Some(v),
            _ => {}
        }
    }
    Some((id, exp?, sig?))
}

pub(super) async fn handle_http_upload<S>(stream: S, token: Arc<String>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    serve(stream, token, BODY_STALL).await
}

async fn serve<S>(mut stream: S, token: Arc<String>, stall: Duration)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Ok((buf, end)) = super::dispatch::read_head(&mut stream).await else { return };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut body_start = buf[end..].to_vec();
    let line = head.split("\r\n").next().unwrap_or("");
    let mut parts = line.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    if method == "OPTIONS" {
        let _ = stream.write_all(PREFLIGHT.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }
    if method != "PUT" { return answer(&mut stream, "405 Method Not Allowed", None).await; }
    let Some((id, exp, sig)) = parse_target(target) else { return answer(&mut stream, "403 Forbidden", None).await };
    let up = registry().lock().unwrap().live.get(id).cloned();
    let Some(up) = up else { return answer(&mut stream, "403 Forbidden", None).await };
    if !verify_upload(&token, id, exp, sig, &up) {
        eprintln!("🚫 HTTP upload rejected (invalid or expired signature)");
        return answer(&mut stream, "403 Forbidden", None).await;
    }
    if header(&head, "transfer-encoding").is_some() { return answer(&mut stream, "411 Length Required", None).await; }
    let Some(len) = header(&head, "content-length").and_then(|v| v.parse::<u64>().ok()) else {
        return answer(&mut stream, "411 Length Required", None).await;
    };
    // From here a refusal reads the body it was sent before answering
    // (validator-2, round 1): closing with it unread makes the kernel reset
    // the connection, and the client loses the answer and its offset. Only a
    // signed request gets this, and only up to MAX_PUT_BYTES.
    let refuse = |status: &'static str, offset: Option<u64>| (status, offset);
    let verdict = 'v: {
        let Some(offset) = header(&head, "upload-offset").and_then(|v| v.parse::<u64>().ok()) else {
            break 'v Err(refuse("400 Bad Request", None));
        };
        // One PUT at a time per upload: a second one is refused, uncounted.
        let Ok(mut e) = up.state.try_lock() else { break 'v Err(refuse("409 Conflict", None)) };
        match on_disk(&up) {
            Some(n) => e.received = n,
            None => break 'v Err(refuse("500 Internal Server Error", None)),
        }
        if offset != e.received { break 'v Err(refuse("409 Conflict", Some(e.received))); }
        if len > MAX_PUT_BYTES || offset + len > up.size { break 'v Err(refuse("413 Content Too Large", Some(e.received))); }
        // The part's name must still be the file begin created; the bytes go
        // through begin's handle, never a reopened path.
        match up.file.try_clone() {
            Ok(f) if names(&up.dir, &up.part_name, up.ino) => Ok((e, f)),
            _ => {
                eprintln!("🚫 HTTP upload refused: the part file is not the one begin created");
                Err(refuse("409 Conflict", Some(e.received)))
            }
        }
    };
    let (mut e, file) = match verdict {
        Ok(v) => v,
        Err((status, offset)) => {
            if len <= MAX_PUT_BYTES { drain(&mut stream, len.saturating_sub(body_start.len() as u64), stall).await; }
            return answer(&mut stream, status, offset).await;
        }
    };
    e.last = Instant::now();

    // Bytes count as received only once a positional write at their offset
    // has RETURNED them as written (validator, round 1 P1: the async file
    // returned before writing, and its error surfaced later or never). A body
    // cut short keeps what was written, and the client resumes from there.
    let file = Arc::new(file);
    let mut left = len;
    body_start.truncate(left as usize);
    let mut chunk = body_start;
    let mut tmp = vec![0u8; 64 * 1024];
    loop {
        if !chunk.is_empty() {
            let (f, at, piece) = (file.clone(), e.received, std::mem::take(&mut chunk));
            let (written, failed) = tokio::task::spawn_blocking(move || write_at(&f, &piece, at)).await.unwrap_or((0, true));
            e.received += written;
            left -= written;
            if failed {
                e.last = Instant::now();
                return answer(&mut stream, "500 Internal Server Error", Some(e.received)).await;
            }
        }
        if left == 0 { break; }
        let want = (left as usize).min(tmp.len());
        match tokio::time::timeout(stall, stream.read(&mut tmp[..want])).await.unwrap_or(Ok(0)) {
            Ok(0) | Err(_) => { e.last = Instant::now(); return; }
            Ok(n) => chunk = tmp[..n].to_vec(),
        }
    }
    e.last = Instant::now();
    if e.received < up.size { return answer(&mut stream, "204 No Content", Some(e.received)).await; }

    // Commit: the bytes in THIS file are exactly the declared size, then ONE
    // renameat in begin's directory puts them at the destination. Nothing is
    // written there before.
    // The fsync of a large file blocks: it runs off the async runtime.
    let commit = up.clone();
    let ok = tokio::task::spawn_blocking(move || {
        use std::os::unix::fs::PermissionsExt;
        let f = &commit.file;
        f.sync_all().is_ok()
            && f.metadata().map(|m| m.len() == commit.size).unwrap_or(false)
            && f.set_permissions(std::fs::Permissions::from_mode(commit.mode)).is_ok()
            && names(&commit.dir, &commit.part_name, commit.ino)
            && rename_in(&commit.dir, &commit.part_name, &commit.dest_name).is_ok()
    }).await.unwrap_or(false);
    drop(file);
    {
        // The receipt replaces the live entry in one step, and only after the
        // rename: resume can never report done for a file that did not land.
        let mut reg = registry().lock().unwrap();
        reg.live.remove(id);
        if ok { reg.done.insert(id.to_string(), Receipt { size: up.size, at: Instant::now() }); }
    }
    if ok {
        answer(&mut stream, "201 Created", Some(e.received)).await;
    } else {
        unlink_in(&up.dir, &up.part_name);
        answer(&mut stream, "500 Internal Server Error", None).await;
    }
}

/// Write `buf` at `at`; (bytes the kernel accepted, whether a write failed).
fn write_at(f: &std::fs::File, buf: &[u8], at: u64) -> (u64, bool) {
    use std::os::unix::fs::FileExt;
    let mut done = 0usize;
    while done < buf.len() {
        match f.write_at(&buf[done..], at + done as u64) {
            Ok(0) => return (done as u64, true),
            Ok(n) => done += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return (done as u64, true),
        }
    }
    (done as u64, false)
}

/// Read and discard `n` more body bytes, each read bounded by `stall`.
async fn drain<S: tokio::io::AsyncRead + Unpin>(stream: &mut S, mut n: u64, stall: Duration) {
    use tokio::io::AsyncReadExt;
    let mut tmp = vec![0u8; 64 * 1024];
    while n > 0 {
        let want = (n as usize).min(tmp.len());
        match tokio::time::timeout(stall, stream.read(&mut tmp[..want])).await {
            Ok(Ok(k)) if k > 0 => n -= k as u64,
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TOK: &str = "tok-23";

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = crate::config::test_scratch(&format!("up-{tag}"));
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn begun(dest: &std::path::Path, size: u64) -> (String, String) {
        let v = begin(TOK, dest.to_str().unwrap(), size).expect("begin");
        (v["id"].as_str().unwrap().to_string(), v["url"].as_str().unwrap().to_string())
    }

    /// One raw HTTP exchange through the handler: (status, Upload-Offset).
    async fn http(raw: Vec<u8>) -> (u16, Option<u64>) {
        let (mut client, server) = tokio::io::duplex(1 << 20);
        // A short stall, so a cut body (the client stops sending and never
        // closes, as a phone that lost its network) ends the PUT quickly.
        let task = tokio::spawn(serve(server, Arc::new(TOK.to_string()), Duration::from_millis(200)));
        // A refusal may answer and close before the body is read: the write
        // then fails, as a browser's would, and the answer is still there.
        let _ = client.write_all(&raw).await;
        let mut out = Vec::new();
        let _ = client.read_to_end(&mut out).await;
        task.await.unwrap();
        let text = String::from_utf8_lossy(&out).to_string();
        let status = text.get(9..12).and_then(|s| s.parse().ok()).unwrap_or(0);
        let offset = text.lines().find_map(|l| l.strip_prefix("Upload-Offset: ")).and_then(|v| v.trim().parse().ok());
        (status, offset)
    }

    async fn put(url: &str, offset: u64, body: &[u8]) -> (u16, Option<u64>) {
        let mut raw = format!("PUT {url} HTTP/1.1\r\nHost: h\r\nUpload-Offset: {offset}\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        raw.extend_from_slice(body);
        http(raw).await
    }

    #[tokio::test]
    async fn chunks_in_order_land_whole_at_the_destination_only_on_the_last_one() {
        let d = scratch("ok");
        let dest = d.join("big.bin");
        let (_id, url) = begun(&dest, 10);
        assert_eq!(put(&url, 0, b"hello").await, (204, Some(5)));
        assert!(!dest.exists(), "nothing at the destination before the last byte");
        assert_eq!(put(&url, 5, b"world").await.0, 201);
        assert_eq!(std::fs::read(&dest).unwrap(), b"helloworld");
        let left: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, vec![std::ffi::OsString::from("big.bin")], "the part file was renamed, not copied");
    }

    #[tokio::test]
    async fn the_commit_replaces_an_existing_file_as_fs_upload_did() {
        let d = scratch("over");
        let dest = d.join("a.txt");
        std::fs::write(&dest, b"old contents").unwrap();
        let (_id, url) = begun(&dest, 3);
        assert_eq!(std::fs::read(&dest).unwrap(), b"old contents", "untouched while uploading");
        assert_eq!(put(&url, 0, b"new").await.0, 201);
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
    }

    #[tokio::test]
    async fn the_committed_file_has_the_mode_fs_upload_gave_it() {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;
        let d = scratch("mode");
        // An existing file keeps its mode, as fs::write's truncate kept it.
        let old = d.join("old");
        std::fs::write(&old, b"x").unwrap();
        std::fs::set_permissions(&old, std::fs::Permissions::from_mode(0o640)).unwrap();
        let (_id, url) = begun(&old, 2);
        assert_eq!(put(&url, 0, b"ab").await.0, 201);
        assert_eq!(mode(&old), 0o640);
        // A new file gets what fs::write would have created under this umask.
        std::fs::write(d.join("probe"), b"").unwrap();
        let (_id, url) = begun(&d.join("new"), 1);
        assert_eq!(put(&url, 0, b"a").await.0, 201);
        assert_eq!(mode(&d.join("new")), mode(&d.join("probe")));
    }

    /// One exchange over REAL TCP. A server that closes with the body unread
    /// makes the kernel reset the connection, and the answer is lost; the
    /// in-memory duplex cannot show that.
    async fn tcp_put(url: &str, offset: u64, body: Vec<u8>) -> (u16, Option<u64>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            serve(s, Arc::new(TOK.to_string()), Duration::from_secs(2)).await;
        });
        let conn = tokio::net::TcpStream::connect(addr).await.unwrap();
        let (mut rd, mut wr) = conn.into_split();
        let head = format!("PUT {url} HTTP/1.1\r\nHost: h\r\nUpload-Offset: {offset}\r\nContent-Length: {}\r\n\r\n", body.len());
        // The whole body first, then the answer, as validator-2's probe and
        // an HTTP/1.1 client without early-response handling do.
        // A body write that fails is a lost answer: a browser reports the
        // exchange as a network error and never reads the status.
        let wrote = wr.write_all(head.as_bytes()).await.is_ok() && wr.write_all(&body).await.is_ok();
        let mut out = Vec::new();
        let _ = rd.read_to_end(&mut out).await;
        if !wrote { out.clear(); }
        let _ = server.await;
        let text = String::from_utf8_lossy(&out).to_string();
        let status = text.get(9..12).and_then(|s| s.parse().ok()).unwrap_or(0);
        let offset = text.lines().find_map(|l| l.strip_prefix("Upload-Offset: ")).and_then(|v| v.trim().parse().ok());
        (status, offset)
    }

    #[tokio::test]
    async fn a_refused_chunk_still_reaches_the_client_with_its_offset() {
        // validator-2 P2 on 83b6b705: a 409/413 was answered and the socket
        // closed with the 4 MiB body unread, so the client saw a reset.
        let d = scratch("drain");
        let size = 3 * CHUNK_BYTES;
        let (_id, url) = begun(&d.join("f"), size);
        // The largest body a PUT may carry: more than loopback's socket
        // buffers hold, so an unread body cannot all be absorbed.
        let big = vec![7u8; MAX_PUT_BYTES as usize];
        assert_eq!(tcp_put(&url, 0, vec![7u8; CHUNK_BYTES as usize]).await, (204, Some(CHUNK_BYTES)));
        for round in 0..5 {
            assert_eq!(tcp_put(&url, 0, big.clone()).await, (409, Some(CHUNK_BYTES)), "an overlap, round {round}");
        }
        let (_id2, url2) = begun(&d.join("g"), MAX_PUT_BYTES - 1);
        assert_eq!(tcp_put(&url2, 0, big.clone()).await, (413, Some(0)), "past the size");
    }

    #[tokio::test]
    async fn a_part_file_swapped_for_a_symlink_is_never_written_through() {
        let d = scratch("swap");
        let dest = d.join("f");
        let (id, url) = begun(&dest, 4);
        assert_eq!(put(&url, 0, b"ab").await.0, 204);
        let part = d.join(part_files(&d)[0].clone());
        let victim = d.join("victim");
        std::fs::write(&victim, b"precious").unwrap();
        std::fs::remove_file(&part).unwrap();
        std::os::unix::fs::symlink(&victim, &part).unwrap();
        let (status, _) = put(&url, 2, b"cd").await;
        assert_eq!(status, 409, "refused");
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious", "the link's target is untouched");
        // A regular file of someone else's in the part's place is not ours either.
        std::fs::remove_file(&part).unwrap();
        std::fs::write(&part, b"ab").unwrap();
        assert_eq!(put(&url, 2, b"cd").await.0, 409, "another file at the part's name");
        assert_eq!(std::fs::read(&part).unwrap(), b"ab", "and it is not written");
        assert!(!dest.exists());
        abort(&id).unwrap();
    }

    #[tokio::test]
    async fn a_parent_directory_swapped_between_chunks_does_not_move_the_upload() {
        let d = scratch("parent");
        std::fs::create_dir(d.join("in")).unwrap();
        let (_id, url) = begun(&d.join("in/f"), 4);
        assert_eq!(put(&url, 0, b"ab").await.0, 204);
        std::fs::rename(d.join("in"), d.join("moved")).unwrap();
        std::fs::create_dir(d.join("in")).unwrap();
        assert_eq!(put(&url, 2, b"cd").await.0, 201);
        assert_eq!(std::fs::read(d.join("moved/f")).unwrap(), b"abcd", "the commit lands in the directory begin opened");
        assert_eq!(std::fs::read_dir(d.join("in")).unwrap().count(), 0, "nothing appears at the path's new directory");
    }

    #[tokio::test]
    async fn a_begin_takes_over_an_abandoned_upload_to_the_same_destination() {
        // validator-2 P2 on 83b6b705: after a page reload the destination said
        // "upload in progress" for up to 10 minutes.
        let d = scratch("takeover");
        let dest = d.join("f");
        let (old, old_url) = begun(&dest, 4);
        assert_eq!(put(&old_url, 0, b"ab").await.0, 204);
        assert!(begin(TOK, dest.to_str().unwrap(), 4).unwrap_err().contains("upload in progress"), "a live upload is not taken over");
        let up = registry().lock().unwrap().live.get(&old).cloned().unwrap();
        up.state.try_lock().unwrap().last = Instant::now() - BODY_STALL - Duration::from_secs(1);
        let (new, new_url) = begun(&dest, 4);
        assert_ne!(new, old);
        assert!(resume(TOK, &old).unwrap_err().contains("no such upload"), "the abandoned id is gone");
        assert_eq!(put(&old_url, 2, b"cd").await.0, 403, "and its URL writes nothing");
        assert_eq!(part_files(&d).len(), 1, "its part file is removed");
        assert_eq!(put(&new_url, 0, b"wxyz").await.0, 201);
        assert_eq!(std::fs::read(&dest).unwrap(), b"wxyz");
    }

    #[tokio::test]
    async fn a_begin_never_takes_over_an_upload_whose_chunk_is_being_written() {
        let d = scratch("busy");
        let dest = d.join("f");
        let (id, _url) = begun(&dest, 4);
        let up = registry().lock().unwrap().live.get(&id).cloned().unwrap();
        let mut held = up.state.try_lock().unwrap(); // a PUT in progress holds this
        held.last = Instant::now() - IDLE; // however old its last byte
        assert!(begin(TOK, dest.to_str().unwrap(), 4).unwrap_err().contains("upload in progress"));
        drop(held);
        abort(&id).unwrap();
    }

    /// validator, round 1 P1: a write that fails was counted as received (the
    /// async write returned before the bytes were written), and a resume then
    /// committed a file with a zero-filled hole. A real failure is injected:
    /// the test re-runs itself in a CHILD process under a 10 MiB file-size
    /// limit (SIGXFSZ ignored, so a write past it fails with EFBIG), which
    /// limits nothing else in the suite.
    #[test]
    fn a_write_that_fails_is_never_counted_and_a_resume_leaves_no_hole() {
        const LIMIT: u64 = 10 * 1024 * 1024;
        if std::env::var_os("TMM_UPLOAD_FSIZE_CHILD").is_none() {
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "server::upload::tests::a_write_that_fails_is_never_counted_and_a_resume_leaves_no_hole", "--test-threads=1", "--nocapture"])
                .env("TMM_UPLOAD_FSIZE_CHILD", "1")
                .output().unwrap();
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            assert!(out.status.success() && text.contains("1 passed"), "the child run: {text}");
            return;
        }
        let set_limit = |soft: u64| {
            let mut lim: libc::rlimit = unsafe { std::mem::zeroed() };
            // SAFETY: valid out-pointer, then the same struct with a lowered or restored soft limit.
            unsafe { libc::getrlimit(libc::RLIMIT_FSIZE, &mut lim) };
            lim.rlim_cur = soft as libc::rlim_t;
            assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &lim) }, 0);
        };
        // SAFETY: ignoring a signal for this child process only.
        unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let d = scratch("fsize");
            let dest = d.join("f.bin");
            let size = 20 * 1024 * 1024;
            let src: Vec<u8> = (0..size).map(|i| (i % 251) as u8 + 1).collect(); // no zero byte, so a hole shows
            let (id, url) = begun(&dest, size as u64);
            let c = CHUNK_BYTES as usize;
            assert_eq!(put(&url, 0, &src[..c]).await.0, 204);
            assert_eq!(put(&url, c as u64, &src[c..2 * c]).await.0, 204);
            set_limit(LIMIT);
            let (status, offset) = put(&url, 2 * c as u64, &src[2 * c..3 * c]).await;
            let on_disk = std::fs::metadata(d.join(&part_files(&d)[0])).unwrap().len();
            assert_eq!(status, 500, "the failed write is reported");
            assert_eq!(on_disk, LIMIT, "the kernel stopped the part at the limit");
            assert_eq!(offset, Some(on_disk), "the answer counts only what is on disk");
            let r = resume(TOK, &id).unwrap();
            assert_eq!(r["received"], on_disk, "resume counts only what is on disk");
            set_limit(libc::RLIM_INFINITY as u64); // space or quota comes back
            let url = r["url"].as_str().unwrap().to_string();
            let mut at = on_disk as usize;
            loop {
                let end = (at + c).min(size);
                let (status, offset) = put(&url, at as u64, &src[at..end]).await;
                at = offset.unwrap() as usize;
                if status == 201 { break; }
                assert_eq!(status, 204);
            }
            assert!(std::fs::read(&dest).unwrap() == src, "the committed file is the source, with no hole");
        });
    }

    #[tokio::test]
    async fn an_overwrite_drops_the_setuid_bit_as_a_plain_write_did() {
        // validator, round 1 P2: fs::write's overwrite made the kernel drop
        // S_ISUID/S_ISGID; the commit carried them over.
        use std::os::unix::fs::PermissionsExt;
        let d = scratch("suid");
        let dest = d.join("tool");
        std::fs::write(&dest, b"x").unwrap();
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o6755)).unwrap();
        let (_id, url) = begun(&dest, 2);
        assert_eq!(put(&url, 0, b"ab").await.0, 201);
        assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o7777, 0o755);
    }

    #[tokio::test]
    async fn a_committed_upload_whose_answer_was_lost_resumes_to_done() {
        // reviewer P1-R1 on 651962df: the id was forgotten at commit, so a
        // lost 201 resumed to "no such upload" and Retry began from zero.
        let d = scratch("receipt");
        let dest = d.join("f");
        let (id, url) = begun(&dest, 4);
        assert_eq!(put(&url, 0, b"ab").await.0, 204);
        let _lost = put(&url, 2, b"cd").await; // the 201 never reaches the client
        let r = resume(TOK, &id).unwrap();
        assert_eq!(r["done"], true, "{r}");
        assert_eq!(r["received"], 4);
        assert_eq!(std::fs::read(&dest).unwrap(), b"abcd");
        assert_eq!(put(&url, 4, b"").await.0, 403, "a done upload takes no more chunks");
        assert_eq!(resume(TOK, &id).unwrap()["done"], true, "asking again says the same");
        // The destination is free for a new upload while the receipt stands.
        let (new, new_url) = begun(&dest, 2);
        assert_eq!(put(&new_url, 0, b"zz").await.0, 201);
        assert_eq!(resume(TOK, &id).unwrap()["done"], true, "the old receipt is the old id's");
        assert_eq!(resume(TOK, &new).unwrap()["done"], true);
        // Abort of a done id forgets the receipt and leaves the file alone.
        abort(&id).unwrap();
        assert!(resume(TOK, &id).unwrap_err().contains("no such upload"));
        assert_eq!(std::fs::read(&dest).unwrap(), b"zz");
    }

    #[tokio::test]
    async fn a_receipt_expires_like_an_idle_upload() {
        let d = scratch("receipt-exp");
        let (id, url) = begun(&d.join("f"), 1);
        assert_eq!(put(&url, 0, b"x").await.0, 201);
        registry().lock().unwrap().done.get_mut(&id).unwrap().at = Instant::now() - IDLE - Duration::from_secs(1);
        expire_idle(Instant::now());
        assert!(resume(TOK, &id).unwrap_err().contains("no such upload"));
    }

    #[tokio::test]
    async fn a_failed_commit_leaves_no_receipt() {
        let d = scratch("receipt-fail");
        let dest = d.join("f");
        let (id, url) = begun(&dest, 2);
        assert_eq!(put(&url, 0, b"a").await.0, 204);
        // The part's name no longer the held file: the commit refuses.
        let part = d.join(part_files(&d)[0].clone());
        std::fs::rename(&part, d.join("elsewhere")).unwrap();
        assert_ne!(put(&url, 1, b"b").await.0, 201);
        let r = resume(TOK, &id);
        assert!(r.as_ref().map_or(true, |v| v["done"] != true), "never done without a commit: {r:?}");
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn a_proxy_prefix_reaches_the_same_door() {
        let d = scratch("proxy");
        let (_id, url) = begun(&d.join("p"), 2);
        assert_eq!(put(&format!("/tmux{url}"), 0, b"ok").await.0, 201);
    }
    fn url_with(id: &str, exp: u64, sig: &str) -> String { format!("/up/{id}?exp={exp}&sig={sig}") }

    fn part_files(d: &std::path::Path) -> Vec<String> {
        std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".tmm-part")).collect()
    }

    #[tokio::test]
    async fn a_bad_signature_is_refused_and_writes_nothing() {
        let d = scratch("badsig");
        let (id, url) = begun(&d.join("f"), 4);
        let exp: u64 = url.split("exp=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
        let mut forged = sign_upload(TOK, &id, exp, 4, &d.join("f"));
        forged.replace_range(0..1, if forged.starts_with('0') { "1" } else { "0" });
        for bad in [url_with(&id, exp, &forged), url_with(&id, exp, "zz"), url_with(&id, exp, ""),
                    url_with(&id, exp, &sign_upload("other-token", &id, exp, 4, &d.join("f"))),
                    // the signature binds size and destination: another size or path does not verify
                    url_with(&id, exp, &sign_upload(TOK, &id, exp, 5, &d.join("f"))),
                    url_with(&id, exp, &sign_upload(TOK, &id, exp, 4, &d.join("g"))),
                    // a /dl signature over the same destination is a different key
                    url_with(&id, exp, &super::super::download::sign_download(TOK, false, d.join("f").to_str().unwrap(), exp))] {
            assert_eq!(put(&bad, 0, b"abcd").await.0, 403, "{bad}");
        }
        assert_eq!(std::fs::metadata(d.join(&part_files(&d)[0])).unwrap().len(), 0, "no byte written");
        assert!(!d.join("f").exists());
    }

    #[tokio::test]
    async fn one_uploads_url_does_not_open_another() {
        let d = scratch("cross");
        let (_a, url_a) = begun(&d.join("a"), 2);
        let (b, _url_b) = begun(&d.join("b"), 2);
        let query = url_a.split_once('?').unwrap().1;
        assert_eq!(put(&format!("/up/{b}?{query}"), 0, b"xx").await.0, 403);
        assert_eq!(put(&format!("/up/{}?{query}", "0".repeat(32)), 0, b"xx").await.0, 403, "an unknown id");
    }

    #[tokio::test]
    async fn an_expired_or_overlong_url_is_refused() {
        let d = scratch("exp");
        let dest = d.join("f");
        let (id, _url) = begun(&dest, 2);
        let now = unix_now();
        let past = now - 1;
        assert_eq!(put(&url_with(&id, past, &sign_upload(TOK, &id, past, 2, &dest)), 0, b"xx").await.0, 403, "expired");
        let far = now + URL_TTL_SECS + 60;
        assert_eq!(put(&url_with(&id, far, &sign_upload(TOK, &id, far, 2, &dest)), 0, b"xx").await.0, 403, "beyond the ceiling");
        assert!(!dest.exists());
    }

    #[tokio::test]
    async fn more_bytes_than_declared_are_refused_whole() {
        let d = scratch("size");
        let (_id, url) = begun(&d.join("f"), 4);
        assert_eq!(put(&url, 0, b"abcde").await, (413, Some(0)), "past the declared size");
        assert_eq!(put(&url, 0, b"ab").await, (204, Some(2)));
        assert_eq!(put(&url, 2, b"cde").await, (413, Some(2)), "a later chunk past the size");
        let big = vec![0u8; (MAX_PUT_BYTES + 1) as usize];
        let (_id2, url2) = begun(&d.join("g"), 3 * MAX_PUT_BYTES);
        assert_eq!(put(&url2, 0, &big).await, (413, Some(0)), "one body over the PUT ceiling");
    }

    #[tokio::test]
    async fn only_the_next_offset_is_accepted() {
        let d = scratch("order");
        let dest = d.join("f");
        let (_id, url) = begun(&dest, 6);
        assert_eq!(put(&url, 2, b"cd").await, (409, Some(0)), "out of order: told where to resume");
        assert_eq!(put(&url, 0, b"ab").await, (204, Some(2)));
        assert_eq!(put(&url, 0, b"ab").await, (409, Some(2)), "a repeat");
        assert_eq!(put(&url, 1, b"bc").await, (409, Some(2)), "an overlap");
        assert_eq!(put(&url, 2, b"cdef").await.0, 201);
        assert_eq!(std::fs::read(&dest).unwrap(), b"abcdef");
    }

    #[tokio::test]
    async fn a_request_without_length_or_offset_is_refused() {
        let d = scratch("hdr");
        let (_id, url) = begun(&d.join("f"), 2);
        let (s, _) = http(format!("PUT {url} HTTP/1.1\r\nUpload-Offset: 0\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n0\r\n\r\n").into_bytes()).await;
        assert_eq!(s, 411);
        let (s, _) = http(format!("PUT {url} HTTP/1.1\r\nContent-Length: 2\r\n\r\nab").into_bytes()).await;
        assert_eq!(s, 400, "no Upload-Offset");
        let (s, _) = http(format!("GET {url} HTTP/1.1\r\n\r\n").into_bytes()).await;
        assert_eq!(s, 405);
    }

    #[tokio::test]
    async fn a_dropped_chunk_keeps_its_bytes_and_resume_continues_from_them() {
        let d = scratch("drop");
        let dest = d.join("f");
        let (id, url) = begun(&dest, 8);
        // The client promised 6 bytes and the connection died after 3.
        let mut raw = format!("PUT {url} HTTP/1.1\r\nUpload-Offset: 0\r\nContent-Length: 6\r\n\r\n").into_bytes();
        raw.extend_from_slice(b"abc");
        let (s, _) = http(raw).await;
        assert_eq!(s, 0, "no answer on a cut body");
        let r = resume(TOK, &id).unwrap();
        assert_eq!(r["received"], 3);
        let fresh = r["url"].as_str().unwrap().to_string();
        assert_eq!(put(&fresh, 3, b"defgh").await.0, 201);
        assert_eq!(std::fs::read(&dest).unwrap(), b"abcdefgh");
        assert_eq!(resume(TOK, &id).unwrap()["done"], true, "a committed id answers done (its receipt, P1-R1)");
    }

    #[tokio::test]
    async fn begin_takes_the_shared_validators_answer() {
        let d = scratch("path");
        std::fs::create_dir(d.join("sub")).unwrap();
        let v = begin(TOK, &format!("{}/sub/../t.bin", d.display()), 1).unwrap();
        assert_eq!(put(v["url"].as_str().unwrap(), 0, b"x").await.0, 201);
        assert!(d.join("t.bin").exists(), "the traversal resolved to the canonical target, as fs_upload's");
        for bad in ["rel/x".to_string(), format!("{}/missing/x", d.display()), format!("{}/sub", d.display()), format!("{}/a\0b", d.display())] {
            assert_eq!(begin(TOK, &bad, 1).unwrap_err(), crate::fs::upload_target(&bad).unwrap_err(), "{bad:?}");
        }
        assert!(part_files(&d).is_empty());
    }

    #[tokio::test]
    async fn a_second_upload_to_the_same_destination_is_refused_until_the_first_ends() {
        let d = scratch("conc");
        let dest = d.join("f");
        let (id, _url) = begun(&dest, 2);
        let e = begin(TOK, dest.to_str().unwrap(), 2).unwrap_err();
        assert!(e.contains("upload in progress"), "{e}");
        abort(&id).unwrap();
        begun(&dest, 2);
    }

    #[tokio::test]
    async fn abort_leaves_no_part_file_and_kills_the_url() {
        let d = scratch("abort");
        let (id, url) = begun(&d.join("f"), 4);
        assert_eq!(put(&url, 0, b"ab").await.0, 204);
        assert_eq!(part_files(&d).len(), 1);
        abort(&id).unwrap();
        assert!(part_files(&d).is_empty());
        assert_eq!(put(&url, 2, b"cd").await.0, 403);
        assert!(!d.join("f").exists());
    }

    #[tokio::test]
    async fn an_idle_upload_expires_with_its_part_file() {
        let d = scratch("idle");
        let (id, _url) = begun(&d.join("f"), 4);
        // Backdate THIS upload only: the registry is shared by parallel tests.
        let up = registry().lock().unwrap().live.get(&id).cloned().unwrap();
        up.state.try_lock().unwrap().last = Instant::now() - IDLE - Duration::from_secs(1);
        expire_idle(Instant::now());
        assert!(part_files(&d).is_empty());
        assert!(resume(TOK, &id).is_err());
    }

    #[tokio::test]
    async fn the_restart_sweep_removes_only_our_old_part_files() {
        let d = scratch("sweep");
        let old = std::time::SystemTime::now() - IDLE - Duration::from_secs(60);
        let ours = format!(".movie.mp4.{}.tmm-part", "ab".repeat(16));
        let others = [".movie.mp4.short.tmm-part".to_string(), "notes.tmm-part".to_string(),
                      format!(".x.{}.tmm-part.bak", "ab".repeat(16)), format!("..{}.tmm-part", "ab".repeat(16))];
        for n in std::iter::once(&ours).chain(others.iter()) {
            let f = std::fs::File::create(d.join(n)).unwrap();
            f.set_modified(old).unwrap();
        }
        let fresh = format!(".new.{}.tmm-part", "cd".repeat(16));
        std::fs::File::create(d.join(&fresh)).unwrap();
        begun(&d.join("trigger"), 1);
        assert!(!d.join(&ours).exists(), "an old part file of ours is swept");
        for n in &others { assert!(d.join(n).exists(), "{n} is not ours and stays"); }
        assert!(d.join(&fresh).exists(), "a recent one may be a live upload of another gateway");
    }

    #[test]
    fn begin_refuses_a_size_the_disk_cannot_hold() {
        let d = scratch("space");
        let e = begin(TOK, d.join("f").to_str().unwrap(), u64::MAX / 2).unwrap_err();
        assert!(e.contains("not enough space"), "{e}");
        assert!(part_files(&d).is_empty());
    }

    #[tokio::test]
    async fn an_empty_file_commits_at_begin() {
        let d = scratch("empty");
        let v = begin(TOK, d.join("e").to_str().unwrap(), 0).unwrap();
        assert_eq!(v["done"], true);
        assert_eq!(std::fs::read(d.join("e")).unwrap(), b"");
        assert!(part_files(&d).is_empty());
    }

    #[tokio::test]
    async fn the_preflight_grants_the_put_and_touches_nothing() {
        let (mut client, server) = tokio::io::duplex(4096);
        tokio::spawn(handle_http_upload(server, Arc::new(TOK.to_string())));
        client.write_all(b"OPTIONS /up/x HTTP/1.1\r\n\r\n").await.unwrap();
        let mut out = String::new();
        client.read_to_string(&mut out).await.unwrap();
        assert!(out.starts_with("HTTP/1.1 204") && out.contains("Allow-Methods: PUT") && out.contains("Upload-Offset"), "{out}");
    }

    #[tokio::test]
    async fn the_rpcs_begin_resume_and_abort_over_the_session() {
        let d = scratch("rpc");
        let call = |method: &str, params: serde_json::Value| {
            let req: super::super::rpc::Request = serde_json::from_value(serde_json::json!({ "id": 1, "method": method, "params": params })).unwrap();
            serde_json::to_value(super::super::rpc::handle_request(&req, TOK)).unwrap()
        };
        let dest = d.join("r.bin");
        let began = call("fs_upload_begin", serde_json::json!({ "path": dest, "size": 3 }));
        let id = began["result"]["id"].as_str().unwrap().to_string();
        assert_eq!(began["result"]["chunk"], CHUNK_BYTES);
        assert_eq!(put(began["result"]["url"].as_str().unwrap(), 0, b"a").await.0, 204);
        assert_eq!(call("fs_upload_resume", serde_json::json!({ "id": id }))["result"]["received"], 1);
        assert_eq!(call("fs_upload_abort", serde_json::json!({ "id": id }))["result"]["ok"], true);
        assert!(part_files(&d).is_empty());
        assert!(call("fs_upload_begin", serde_json::json!({ "path": dest }))["error"]["message"].as_str().unwrap().contains("size"));
        assert!(call("fs_upload_resume", serde_json::json!({ "id": id }))["error"]["message"].as_str().unwrap().contains("no such upload"));
    }
}
