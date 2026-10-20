//! The token-signed HTTP download side-channel on the WS port: same TCP
//! listener, requests that *look like* GET /dl are peeled off before the
//! WebSocket upgrade and streamed with Range support. Split from server.rs
//! 2026-07-22 — content unchanged.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use sha2::Sha256;

/// A download URL lives one minute: the client fetches it at once (and
/// re-signs on every resume), so a leaked URL is dead before it travels.
const DL_TOKEN_TTL_SECS: u64 = 60;
/// A STREAM URL lives as long as a viewing does (board #182). A `<video>`
/// element keeps coming back to the same URL for the whole playback —
/// Chromium suspends loading once its buffer is full and re-issues a Range
/// request from the next offset, every seek is a fresh request — so a 60 s
/// signature 403s the second request a minute into the film. The lifetime is
/// carried IN the signature as an absolute expiry (`exp`), so the verifier
/// needs no second rule; the request kind picks the lifetime at mint time.
/// 4 h is the ceiling: a leaked stream URL replays for at most that long,
/// which covers any film and nothing more; downloads keep their minute.
pub(super) const DL_STREAM_TTL_SECS: u64 = 4 * 3600;

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// When a URL minted now expires: a download in a minute, a stream in hours.
pub(super) fn download_expiry(stream: bool) -> u64 {
    unix_now() + if stream { DL_STREAM_TTL_SECS } else { DL_TOKEN_TTL_SECS }
}

/// Only what a `<video>` or an `<audio>` plays may carry a stream signature —
/// the long life is for media elements, never for arbitrary files (`stream:
/// true` on a .env is refused at mint AND at /dl).
pub(super) fn streams(name: &str) -> bool {
    let ctype = media_content_type(name);
    ctype.starts_with("video/") || ctype.starts_with("audio/")
}

/// The signed tuple. The MODE is a literal in the MAC input, so a stream
/// signature and a download signature over the same path and expiry are
/// different strings: a long-lived one can only ever verify as a stream.
fn mac_input(stream: bool, path: &str, exp: u64) -> String {
    if stream { format!("dl:stream:{}:{}", path, exp) } else { format!("dl:{}:{}", path, exp) }
}

pub(super) fn sign_download(token: &str, stream: bool, path: &str, exp: u64) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes()).unwrap();
    mac.update(mac_input(stream, path, exp).as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

/// The signature is verified by the MAC itself (`verify_slice` is constant
/// time), never by comparing hex strings with `==`, which would return at the
/// first wrong nibble and time-leak the expected signature byte by byte.
/// `exp` and the mode are bound into the MAC, so a client cannot extend a
/// URL's life or relabel a download as a stream; each mode has its own
/// ceiling, and a stream signature verifies only for a path that streams.
fn verify_download(token: &str, stream: bool, path: &str, exp: u64, sig: &str) -> bool {
    let now = unix_now();
    let ttl = if stream { DL_STREAM_TTL_SECS } else { DL_TOKEN_TTL_SECS };
    if exp < now || exp > now + ttl { return false; }
    if stream && !streams(path) { return false; }
    let Ok(sig_bytes) = hex::decode(sig) else { return false };
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes()).unwrap();
    mac.update(mac_input(stream, path, exp).as_bytes());
    mac.verify_slice(&sig_bytes).is_ok()
}

// WebSocket frame / message limits. A legitimate `fs_upload` can carry a
// file up to fs::MAX_READ_SIZE (50 MB) inside a base64 string (~67 MB text),
// plus JSON envelope + encryption overhead. 80 MB accommodates that with
// margin; anything bigger is almost certainly malformed or abusive.
// tokio-tungstenite's default (64 MB) is too small for a max-size upload,
// and without an explicit cap an attacker could force per-connection buffer
// growth up to that limit on every frame.

/// Find the end of the HTTP header block (offset of the CRLFCRLF terminator).
fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// The byte window a `Range` header asks for, inclusive and clamped to the
/// file, or `None` for no/unsupported Range (a server may ignore Range and
/// answer 200 with the full body). `Err` = unsatisfiable (start past the end).
///
/// `bytes=N-` is what our resume client sends. `bytes=N-M` is what a media
/// element sends (board #182): WebKit probes with `bytes=0-1` and refuses to
/// play unless the answer is a 206 of exactly two bytes; Chromium seeks with
/// bounded ranges too. Suffix (`-N`) and multi-range forms stay unsupported.
/// A strong validator for one version of a file (board #305): its size and
/// modification time, both in hex. Derived from metadata, never from the
/// content: hashing an 89 MB file to answer one header is not worth it, and a
/// rewrite that keeps both size and mtime to the nanosecond is not a case a
/// download needs to catch. Strong (no `W/`) because If-Range compares
/// strongly (RFC 7233 §3.2).
fn etag_for(size: u64, mtime_ns: u128) -> String {
    format!("\"{size:x}-{mtime_ns:x}\"")
}

/// `Last-Modified` in IMF-fixdate, the only date form a client may echo back.
/// By hand: this module is compiled into the Android shell too, where
/// `chrono` is not a dependency (Cargo.toml gates it to the desktop).
/// Days → civil date is Howard Hinnant's `civil_from_days`.
fn http_date(secs: i64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        DAYS[days.rem_euclid(7) as usize], day, MONTHS[(month - 1) as usize], year,
        rem / 3600, rem % 3600 / 60, rem % 60)
}

fn header_value<'a>(req: &'a str, name: &str) -> Option<&'a str> {
    req.lines().skip(1).find_map(|line| {
        let (k, v) = line.split_once(':')?;
        k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
    })
}

/// Whether a Range may be honoured: always without `If-Range`; with it, only
/// when it names THIS version (the exact ETag or the exact Last-Modified).
/// Otherwise the file changed since the client's partial copy, and the answer
/// is the whole new file as a 200 (RFC 7233 §3.2), which is how a resuming
/// client learns to restart.
fn if_range_allows(req: &str, etag: &str, last_modified: &str) -> bool {
    match header_value(req, "if-range") {
        None => true,
        Some(v) => v == etag || v == last_modified,
    }
}

/// The CORS preflight for /dl. A Tauri page (tauri://localhost,
/// http://tauri.localhost) is cross-origin to /dl, and `If-Range` is not a
/// safelisted request header, so the webview asks first. The answer grants
/// GET with exactly the two headers a resume sends; it checks no signature
/// and touches no file, so it reveals nothing. A Chromium webview that applies
/// Private Network Access (a page reaching a LAN/Tailscale address) adds
/// `Access-Control-Request-Private-Network` to this same preflight and needs
/// the matching allow line; it grants nothing beyond the signed GET.
const DL_PREFLIGHT: &str = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET\r\nAccess-Control-Allow-Headers: Range, If-Range\r\nAccess-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

fn parse_range(req: &str, size: u64) -> Result<Option<(u64, u64)>, ()> {
    for line in req.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        if !k.trim().eq_ignore_ascii_case("range") {
            continue;
        }
        let Some(spec) = v.trim().strip_prefix("bytes=") else { return Ok(None) };
        let Some((start, rest)) = spec.split_once('-') else { return Ok(None) };
        let Ok(start) = start.trim().parse::<u64>() else { return Ok(None) };
        let end = if rest.trim().is_empty() {
            size.saturating_sub(1)
        } else {
            let Ok(end) = rest.trim().parse::<u64>() else { return Ok(None) };
            end.min(size.saturating_sub(1))
        };
        if size == 0 || start >= size || start > end { return Err(()) }
        return Ok(Some((start, end)));
    }
    Ok(None)
}

/// Is this request a /dl download? The ONE classifier (`dispatch::classify`)
/// decides; this name stays so the download tests read as they always did.
#[cfg(test)]
pub(super) fn looks_like_dl_request(prelude: &[u8]) -> bool {
    super::dispatch::classify(prelude) == super::dispatch::Route::Download
}

pub(super) async fn handle_http_download<S>(mut stream: S, addr: SocketAddr, token: Arc<String>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Read until the full header block has arrived. Reverse proxies often
    // deliver the request line and headers across multiple TCP segments;
    // a single read() truncates the query string mid-signature and rejects
    // a perfectly valid request with 403. (Direct LAN/Tailscale clients
    // virtually always deliver everything in one segment, which is why
    // this only ever bit through a proxy.)
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 2048];
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 16 * 1024 {
            return; // oversized header block — not a legitimate /dl request
        }
        match stream.read(&mut tmp).await {
            Ok(0) => return,
            Ok(n) => buf.extend_from_slice(&tmp[..n]),
            Err(_) => return,
        }
    };
    let req = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let first_line = req.lines().next().unwrap_or("");
    if first_line.starts_with("OPTIONS ") {
        let _ = stream.write_all(DL_PREFLIGHT.as_bytes()).await;
        let _ = stream.flush().await;
        return;
    }

    // Parse "GET <path>/dl?path=...&ts=...&sig=... HTTP/1.1". Locate the
    // "/dl?" segment instead of assuming it starts the path, so a proxy
    // prefix doesn't break query extraction.
    let url_part = first_line.split_whitespace().nth(1).unwrap_or("");
    // The scope door (board #433): path-style, `…/dl/s/…`, its own verifier.
    // A proxy prefix may itself hold `/dl/s/` (review P2): the door is the
    // first occurrence whose tail has the signed shape. With none it is not a
    // scope request at all, and the ordinary `/dl?` below answers it — a
    // prefix like `/dl/s/proxy/` must not turn every download into a 403
    // (validator P2); a malformed scope tail is refused there (no `path`).
    let scope_at = url_part.match_indices("/dl/s/").map(|(i, _)| i + "/dl/s/".len())
        .find(|&at| parse_scope(&url_part[at..]).is_some());
    if let Some(at) = scope_at {
        serve_scope(&mut stream, addr, &token, &url_part[at..], &req).await;
        return;
    }
    let query = match url_part.find("/dl?") {
        Some(i) => &url_part[i + 4..],
        None => "",
    };
    let params: HashMap<&str, &str> = query.split('&')
        .filter_map(|p| p.split_once('='))
        .collect();

    let path = match params.get("path") {
        Some(p) => urlencoding::decode(p).unwrap_or_default().to_string(),
        None => { let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await; return; }
    };
    let exp: u64 = params.get("exp").and_then(|s| s.parse().ok()).unwrap_or(0);
    let sig = params.get("sig").unwrap_or(&"");
    let as_stream = params.get("stream").is_some_and(|v| *v == "1");

    if !verify_download(&token, as_stream, &path, exp, sig) {
        eprintln!("🚫 HTTP download rejected for {} (invalid sig)", addr);
        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        let _ = stream.flush().await;
        return;
    }

    // Read file and stream response
    let file_path = std::path::Path::new(&path);
    let metadata = match std::fs::metadata(file_path) {
        Ok(m) => m,
        Err(_) => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
            let _ = stream.flush().await;
            return;
        }
    };
    let name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let Ok(file) = tokio::fs::File::open(&path).await else { return };
    // Images and videos declare their REAL type: a chat `<img>` and a Files
    // `<video>` stream through /dl, and SVG never renders from
    // `application/octet-stream` (browsers do not sniff SVG — the dashed
    // fallback frame in every bubble, 2026-09-08). `Content-Disposition:
    // attachment` stays on everything, so a top-level navigation still
    // downloads instead of rendering — an SVG's scripts never execute from an
    // <img> context, and never get a document here. Everything else keeps
    // octet-stream: downloads, not documents.
    send_file(&mut stream, &req, file, &metadata, &attachment(&name), media_content_type(&name), "").await;
}

/// A download's `Content-Disposition` (#433 review P1-B). The name never
/// enters the header raw: `filename=` is a printable-ASCII fallback (any
/// other character, `"` and `\` become `_`), `filename*=` the exact name,
/// UTF-8 percent-encoded (RFC 6266 / RFC 8187). No CR, LF or other control
/// byte can reach the header block.
fn attachment(name: &str) -> String {
    let fallback: String = name.chars()
        .map(|c| if (' '..='~').contains(&c) && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    let mut exact = String::new();
    for b in name.bytes() {
        if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) { exact.push(b as char); }
        else { exact.push_str(&format!("%{b:02X}")); }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{exact}")
}

/// Answer a GET for an already OPENED file: validators, Range (resume and a
/// media element's bounded ranges), the headers, then the bytes, all from
/// that one handle. Shared by /dl and the scope door (#433), so neither can
/// drift from the other's Range/ETag handling. `disposition` is the whole
/// Content-Disposition value (`attachment(name)` or a fixed `attachment`);
/// `extra` is whole header lines.
async fn send_file<S>(stream: &mut S, req: &str, file: tokio::fs::File, metadata: &std::fs::Metadata, disposition: &str, ctype: &str, extra: &str)
where
    S: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
    let size = metadata.len();
    let modified = metadata.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    let etag = etag_for(size, modified.as_nanos());
    let last_modified = http_date(modified.as_secs() as i64);
    let validators = format!("ETag: {etag}\r\nLast-Modified: {last_modified}\r\n");

    // Range support: lets the client RESUME an interrupted transfer instead
    // of restarting from byte 0. Critical through reverse proxies on the
    // public internet, where long-lived large responses get cut by proxy
    // idle/total timeouts — without resume, a 100 MB file that dies at 95%
    // restarts from scratch and may never complete.
    // `Connection: close` matters behind reverse proxies: we serve one
    // request per TCP connection and then drop it. Without the header,
    // HTTP/1.1 defaults to keep-alive and the proxy may pool the (already
    // closed) backend connection, surfacing as intermittent 502s on the
    // next download.
    // If-Range names an older version: ignore Range, send the new file.
    let range = if !if_range_allows(req, &etag, &last_modified) { Ok(None) } else { parse_range(req, size) };
    let range = match range {
        Ok(r) => r,
        Err(()) => {
            let _ = stream.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range\r\n{extra}Connection: close\r\n\r\n", size).as_bytes()).await;
            let _ = stream.flush().await;
            return;
        }
    };
    let header = match range {
        Some((start, end)) => format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {}\r\nContent-Disposition: {}\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\n{}{}Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified\r\nConnection: close\r\n\r\n",
            ctype, disposition, end - start + 1, start, end, size, validators, extra
        ),
        None => format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{}{}Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified\r\nConnection: close\r\n\r\n",
            ctype, disposition, size, validators, extra
        ),
    };
    if stream.write_all(header.as_bytes()).await.is_err() { return; }

    let mut file = file;
    let mut remaining = size;
    if let Some((start, end)) = range {
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return;
        }
        remaining = end - start + 1;
    }
    let mut file = file.take(remaining);
    let mut chunk = vec![0u8; 65536];
    loop {
        let n = match file.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if stream.write_all(&chunk[..n]).await.is_err() { break; }
    }
    // Flush any data still sitting in BufStream's write buffer — on drop
    // that buffer is discarded and the tail of the file would be lost.
    let _ = stream.flush().await;
}

// ── The scope mode: a preview's directory cap (board #433) ──────────────
//
// An HTML preview is a srcdoc iframe; its relative `<link>`, `<img>`, CSS
// `url()` and media resolve against an injected `<base href>` that points
// HERE: `…/dl/s/{exp}/{dev}.{ino}/{sig}/{b64url(root)}/{dir…}/`. Path-style,
// because a relative reference drops a base's query. The cap is signed at mint
// for ONE canonical root, pinned by its (dev, ino), for at most
// DL_STREAM_TTL_SECS. A request is verified before the filesystem is touched,
// opened from the root's directory handle segment by segment with no symlink
// followed, and served from that one verified handle. Only subresource types
// are served, never a document or a script.
//
// Domain separation: the scope MAC is keyed by HMAC(token, SCOPE_LABEL), not by
// the token. A scope tag and a download/stream tag are HMACs under different
// keys, so no choice of path or root makes one verify as the other (a legacy
// path may itself begin with "scope:"). The legacy inputs are unchanged.
const SCOPE_LABEL: &[u8] = b"tmm-dl-scope-v1";

/// What a scope response adds to the shared headers: no sniffing, no
/// Referer carrying the cap, and a sandboxing CSP, so a DOCUMENT made from a
/// scope response (a top-level visit, an <iframe>, an <object> holding the
/// cap; an SVG is the case) runs no script on the gateway origin. An <img> or
/// <link> subresource ignores the CSP header.
const SCOPE_HEADERS: &str = "X-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'\r\n";

fn scope_mac(token: &str, exp: u64, dev: u64, ino: u64, root: &str) -> Hmac<Sha256> {
    let mut key = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes()).unwrap();
    key.update(SCOPE_LABEL);
    let key = key.finalize().into_bytes();
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&key).unwrap();
    // NUL-separated: exp, dev and ino are decimal digits, and a root holds no
    // NUL (refused at mint and at verify), so no field runs into another.
    mac.update(b"v1\0");
    mac.update(exp.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(dev.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(ino.to_string().as_bytes());
    mac.update(b"\0");
    mac.update(root.as_bytes());
    mac
}

pub(super) fn sign_scope(token: &str, exp: u64, dev: u64, ino: u64, root: &str) -> String {
    hex::encode(scope_mac(token, exp, dev, ino, root).finalize().into_bytes())
}

fn verify_scope(token: &str, exp: u64, dev: u64, ino: u64, root: &str, sig: &str) -> bool {
    let now = unix_now();
    if exp < now || exp > now + DL_STREAM_TTL_SECS { return false; }
    if !root.starts_with('/') || root.contains('\0') { return false; }
    let Ok(sig_bytes) = hex::decode(sig) else { return false };
    scope_mac(token, exp, dev, ino, root).verify_slice(&sig_bytes).is_ok()
}

/// Mint a scope base for `root` (already derived and canonicalized by the
/// caller) at `dir` (segments of the HTML's directory below the root). The
/// root is pinned by the (dev, ino) of the directory itself, not following a
/// symlink.
pub(super) fn scope_base(token: &str, root: &str, dir: &[String]) -> Result<String, String> {
    use base64::Engine;
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    if !root.starts_with('/') || root.contains('\0') { return Err("a scope root is an absolute path".into()); }
    let meta = std::fs::symlink_metadata(root).map_err(|e| format!("scope root {root}: {e}"))?;
    if !meta.is_dir() { return Err(format!("scope root {root} is not a directory")); }
    #[cfg(unix)]
    let (dev, ino) = (meta.dev(), meta.ino());
    #[cfg(not(unix))]
    let (dev, ino) = (0u64, 0u64);
    let exp = unix_now() + DL_STREAM_TTL_SECS;
    let sig = sign_scope(token, exp, dev, ino, root);
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(root.as_bytes());
    let mut out = format!("/dl/s/{exp}/{dev}.{ino}/{sig}/{b64}/");
    for seg in dir {
        out.push_str(&urlencoding::encode(seg));
        out.push('/');
    }
    Ok(out)
}

/// A parsed scope request: the signed fields and the target's segments.
#[derive(Debug, PartialEq)]
pub(super) struct ScopeRequest {
    exp: u64,
    dev: u64,
    ino: u64,
    sig: String,
    root: String,
    segs: Vec<String>,
}

/// Parse what follows `/dl/s/` in a request target. A query (a stylesheet's
/// `?v=2`) is ignored. Each target segment is percent-decoded EXACTLY once;
/// an empty segment, `.`, `..`, or a decoded segment holding `/`, `\` or NUL
/// refuses the whole request, so `%2e%2e` (decodes to `..`) is refused and
/// `%252e` is the literal name `%2e`.
pub(super) fn parse_scope(after: &str) -> Option<ScopeRequest> {
    use base64::Engine;
    let path = after.split(['?', '#']).next().unwrap_or("");
    let mut parts = path.split('/');
    let exp = parts.next()?.parse().ok()?;
    let (dev, ino) = parts.next()?.split_once('.')?;
    let (dev, ino) = (dev.parse().ok()?, ino.parse().ok()?);
    let sig = parts.next()?.to_string();
    let root = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts.next()?).ok()?;
    let root = String::from_utf8(root).ok()?;
    let mut segs = Vec::new();
    for raw in parts {
        let seg = urlencoding::decode(raw).ok()?.into_owned();
        if seg.is_empty() || seg == "." || seg == ".." || seg.contains(['/', '\\', '\0']) { return None; }
        segs.push(seg);
    }
    if segs.is_empty() { return None; }
    Some(ScopeRequest { exp, dev, ino, sig, root, segs })
}

/// The types a preview's subresources may be served as: stylesheets, images,
/// fonts, and the existing video/audio types. Everything else (html, js,
/// json, …) is refused: no document or script ever leaves the scope door.
fn scope_content_type(name: &str) -> Option<&'static str> {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    Some(match ext.as_str() {
        "css" => "text/css",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        other => return crate::fs::streamed_media_type(other),
    })
}

/// Open the target UNDER the signed root, from a directory handle, never by
/// path: the root opens with O_NOFOLLOW and must be the signed (dev, ino);
/// each segment opens from the one before with O_NOFOLLOW, so a symlink at
/// ANY step is refused (ELOOP/ENOTDIR), in-scope ones included (v1); the last
/// must be a regular file. The file returned is the object checked. `Err` is
/// the HTTP status to answer: 404 for a missing segment, 403 otherwise.
#[cfg(unix)]
fn open_in_scope(root: &str, dev: u64, ino: u64, segs: &[String]) -> Result<std::fs::File, u16> {
    use std::ffi::CString;
    use std::os::fd::FromRawFd;
    struct Fd(libc::c_int);
    impl Drop for Fd {
        fn drop(&mut self) { if self.0 >= 0 { unsafe { libc::close(self.0) }; } }
    }
    let status = |errno: i32| if errno == libc::ENOENT { 404 } else { 403 };
    let errno = || std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let c = |s: &str| CString::new(s).map_err(|_| 403u16);
    let dir_flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut fd = Fd(unsafe { libc::open(c(root)?.as_ptr(), dir_flags) });
    if fd.0 < 0 { return Err(403); }
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.0, &mut st) } != 0 { return Err(403); }
    if st.st_dev as u64 != dev || st.st_ino as u64 != ino { return Err(403); }
    let (last, dirs) = segs.split_last().ok_or(403u16)?;
    for seg in dirs {
        let next = Fd(unsafe { libc::openat(fd.0, c(seg)?.as_ptr(), dir_flags) });
        if next.0 < 0 { return Err(status(errno())); }
        fd = next;
    }
    let file_flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK;
    let target = unsafe { libc::openat(fd.0, c(last)?.as_ptr(), file_flags) };
    if target < 0 { return Err(status(errno())); }
    let file = unsafe { std::fs::File::from_raw_fd(target) };
    match file.metadata() {
        Ok(m) if m.is_file() => Ok(file),
        _ => Err(403),
    }
}

#[cfg(not(unix))]
fn open_in_scope(_root: &str, _dev: u64, _ino: u64, _segs: &[String]) -> Result<std::fs::File, u16> {
    Err(403)
}

/// Serve one scope request. Nothing here logs the request target: a cap URL
/// is a bearer, and only the peer address appears in the reject line.
async fn serve_scope<S>(stream: &mut S, addr: SocketAddr, token: &str, after: &str, req: &str)
where
    S: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;
    async fn status<S: tokio::io::AsyncWrite + Unpin>(stream: &mut S, code: u16) {
        let line = if code == 404 { "404 Not Found" } else { "403 Forbidden" };
        let _ = stream.write_all(format!("HTTP/1.1 {line}\r\nContent-Length: 0\r\n{SCOPE_HEADERS}Connection: close\r\n\r\n").as_bytes()).await;
        let _ = stream.flush().await;
    }
    let Some(r) = parse_scope(after) else { return status(stream, 403).await };
    if !verify_scope(token, r.exp, r.dev, r.ino, &r.root, &r.sig) {
        eprintln!("🚫 scope request rejected for {} (invalid sig)", addr);
        return status(stream, 403).await;
    }
    let file = match open_in_scope(&r.root, r.dev, r.ino, &r.segs) {
        Ok(f) => f,
        Err(code) => return status(stream, code).await,
    };
    // The type is the OPENED object's: with no symlink followed, its name is
    // the last segment itself.
    let name = r.segs.last().map(String::as_str).unwrap_or("file");
    let Some(ctype) = scope_content_type(name) else { return status(stream, 403).await };
    let Ok(metadata) = file.metadata() else { return status(stream, 403).await };
    // A FIXED disposition: a resource name never enters the header (#433
    // review P1-B), so no decoded CR, LF or quote can move the header block.
    send_file(stream, req, tokio::fs::File::from_std(file), &metadata, "attachment", ctype, SCOPE_HEADERS).await;
}

/// The Content-Type for /dl: image and video extensions get their real type
/// so a chat `<img>` and a Files `<video>` can render them (SVG hard-requires
/// `image/svg+xml`; bitmaps are sniffed but say the truth anyway; WebKit
/// wants a `video/*` type before it asks AVFoundation). Media never execute
/// anything. Everything else stays octet-stream — /dl serves DOWNLOADS, not
/// documents (html/js/css must never render off this endpoint: same-origin +
/// a token-signed URL would be an XSS gift). Video and audio come from
/// `fs::streamed_media_type`, the one lookup `fs::mime_hint` shares: what Files
/// calls a video or a sound, /dl serves as one.
fn media_content_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        // Video and audio: the one lookup `fs::mime_hint` shares (board #182, #416).
        other => crate::fs::streamed_media_type(other).unwrap_or("application/octet-stream"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_declare_their_real_type_everything_else_stays_a_download() {
        // SVG is the load-bearing case: an <img> never renders it from
        // octet-stream (the dashed fallback in every chat bubble, 2026-09-08).
        assert_eq!(media_content_type("harness-layers.svg"), "image/svg+xml");
        assert_eq!(media_content_type("SHOT.PNG"), "image/png");
        assert_eq!(media_content_type("a.b.jpeg"), "image/jpeg");
        // Video (board #182): a Files <video> streams off /dl; WebKit wants the type.
        assert_eq!(media_content_type("demo.MP4"), "video/mp4");
        assert_eq!(media_content_type("clip.m4v"), "video/mp4");
        assert_eq!(media_content_type("screen.webm"), "video/webm");
        assert_eq!(media_content_type("take.mov"), "video/quicktime");
        assert_eq!(media_content_type("rip.mkv"), "video/x-matroska");
        // Audio (board #416): the same rows as fs::mime_hint, one per extension.
        for (name, ctype) in [
            ("song.mp3", "audio/mpeg"), ("MEMO.M4A", "audio/mp4"), ("voice.aac", "audio/aac"),
            ("take.ogg", "audio/ogg"), ("take.oga", "audio/ogg"), ("clip.opus", "audio/ogg"),
            ("beep.wav", "audio/wav"), ("lossless.flac", "audio/flac"), ("clip.weba", "audio/webm"),
        ] {
            assert_eq!(media_content_type(name), ctype, "{name}");
        }
        // The two callers read ONE lookup: whatever Files calls a streamed kind, /dl serves as that type.
        for ext in ["mp4", "m4v", "webm", "mov", "mkv", "ogv", "mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac", "weba"] {
            let name = format!("x.{ext}");
            assert_eq!(media_content_type(&name), crate::fs::mime_hint(&name), "{ext}");
            assert_eq!(Some(media_content_type(&name)), crate::fs::streamed_media_type(ext), "{ext}");
        }
        // Documents and executables must never render off /dl.
        assert_eq!(media_content_type("index.html"), "application/octet-stream");
        assert_eq!(media_content_type("report.pdf"), "application/octet-stream");
        assert_eq!(media_content_type("player.js"), "application/octet-stream");
        assert_eq!(media_content_type("noext"), "application/octet-stream");
    }

    #[test]
    fn etag_is_strong_and_follows_size_and_mtime() {
        assert_eq!(etag_for(255, 4096), "\"ff-1000\"");
        assert_ne!(etag_for(255, 4096), etag_for(255, 4097), "a touch is a new version");
        assert_ne!(etag_for(255, 4096), etag_for(256, 4096));
        assert!(!etag_for(1, 1).starts_with("W/"), "If-Range needs a strong validator");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(784_111_777), "Sun, 06 Nov 1994 08:49:37 GMT", "RFC 9110's own example");
        assert_eq!(http_date(951_782_400), "Tue, 29 Feb 2000 00:00:00 GMT", "a leap day in a century leap year");
        assert_eq!(http_date(1_790_502_579), "Sun, 27 Sep 2026 09:49:39 GMT");
    }

    #[test]
    fn if_range_honours_range_only_for_the_same_version() {
        let tag = "\"ff-1000\"";
        let date = "Thu, 01 Jan 1970 00:00:00 GMT";
        let req = |extra: &str| format!("GET /dl?path=x HTTP/1.1\r\nHost: h\r\nRange: bytes=10-\r\n{extra}");
        assert!(if_range_allows(&req(""), tag, date), "no If-Range: plain Range as before");
        assert!(if_range_allows(&req("If-Range: \"ff-1000\"\r\n"), tag, date));
        assert!(if_range_allows(&req("if-range: Thu, 01 Jan 1970 00:00:00 GMT\r\n"), tag, date), "header name is case-insensitive; the date form works");
        assert!(!if_range_allows(&req("If-Range: \"ff-0fff\"\r\n"), tag, date), "another version: whole file, 200");
        assert!(!if_range_allows(&req("If-Range: W/\"ff-1000\"\r\n"), tag, date), "a weak tag never matches (strong comparison)");
        assert!(!if_range_allows(&req("If-Range: Fri, 02 Jan 1970 00:00:00 GMT\r\n"), tag, date));
    }

    #[test]
    fn preflight_is_recognised_and_grants_only_the_resume_headers() {
        assert!(looks_like_dl_request(b"OPTIONS /dl?path=%2Fx HTTP/1.1\r\n"));
        assert!(!looks_like_dl_request(b"OPTIONS /ws HTTP/1.1\r\n"), "only /dl, never the WS path");
        assert!(DL_PREFLIGHT.starts_with("HTTP/1.1 204 "));
        assert!(DL_PREFLIGHT.contains("Access-Control-Allow-Headers: Range, If-Range\r\n"));
        assert!(DL_PREFLIGHT.contains("Access-Control-Allow-Methods: GET\r\n"));
        assert!(DL_PREFLIGHT.contains("Access-Control-Allow-Private-Network: true\r\n"));
        // A resume whose part is already complete gets 416; a cross-origin
        // page can only read its Content-Range if CORS covers it.
        assert!(include_str!("download.rs").contains("416 Range Not Satisfiable\\r\\nContent-Range: bytes */{}\\r\\nContent-Length: 0\\r\\nAccess-Control-Allow-Origin: *\\r\\nAccess-Control-Expose-Headers: Content-Range"));
    }

    #[test]
    fn range_header_open_ended_parses() {
        let req = "GET /dl?path=x HTTP/1.1\r\nHost: h\r\nRange: bytes=12345-\r\n";
        assert_eq!(parse_range(req, 20_000), Ok(Some((12345, 19_999))));
        // From byte 0 is a valid range too: a media element's first request.
        assert_eq!(parse_range("Range: bytes=0-\r\n", 10), Ok(Some((0, 9))));
    }

    #[test]
    fn range_header_case_insensitive() {
        let req = "GET /dl?path=x HTTP/1.1\r\nrange: bytes=7-\r\n";
        assert_eq!(parse_range(req, 100), Ok(Some((7, 99))));
    }

    #[test]
    fn range_header_bounded_form_serves_exactly_that_window() {
        // Board #182: WebKit probes a video with `bytes=0-1` and needs 206 of
        // exactly two bytes; a seek asks for a bounded window. Clamp to the file.
        assert_eq!(parse_range("Range: bytes=0-1\r\n", 1_000), Ok(Some((0, 1))));
        assert_eq!(parse_range("Range: bytes=500-999\r\n", 1_000), Ok(Some((500, 999))));
        assert_eq!(parse_range("Range: bytes=500-5000\r\n", 1_000), Ok(Some((500, 999))), "end clamps to the last byte");
        // Unsatisfiable: past the end, inverted, or an empty file → 416.
        assert_eq!(parse_range("Range: bytes=1000-\r\n", 1_000), Err(()));
        assert_eq!(parse_range("Range: bytes=9-3\r\n", 1_000), Err(()));
        assert_eq!(parse_range("Range: bytes=0-\r\n", 0), Err(()));
    }

    #[test]
    fn range_header_unsupported_forms_fall_back_to_the_full_body() {
        // Suffix and malformed forms are not emitted by our clients; a server
        // may ignore Range and answer 200 (RFC 7233).
        assert_eq!(parse_range("Range: bytes=-500\r\n", 1_000), Ok(None));
        assert_eq!(parse_range("Range: items=0-5\r\n", 1_000), Ok(None));
        assert_eq!(parse_range("Range: bytes=abc-\r\n", 1_000), Ok(None));
        assert_eq!(parse_range("GET / HTTP/1.1\r\nHost: h\r\n", 1_000), Ok(None));
    }

    #[test]
    fn dl_detection_with_and_without_proxy_prefix() {
        assert!(looks_like_dl_request(b"GET /dl?path=a&ts=1&sig=b HTTP/1.1\r\n"));
        // Reverse proxy that forwards its location prefix unstripped.
        assert!(looks_like_dl_request(b"GET /tmux/dl?path=a HTTP/1.1\r\n"));
        assert!(!looks_like_dl_request(b"GET / HTTP/1.1\r\nUpgrade: websocket\r\n"));
        // "/dl?" appearing only in a header (not the request line) must not match.
        assert!(!looks_like_dl_request(b"GET /ws HTTP/1.1\r\nReferer: /dl?x\r\n"));
        assert!(!looks_like_dl_request(b"POST /dl?path=a HTTP/1.1\r\n"));
    }

    #[test]
    fn header_end_detection() {
        assert_eq!(find_header_end(b"GET / HTTP/1.1\r\nHost: h\r\n\r\nbody"), Some(23));
        assert_eq!(find_header_end(b"GET / HTTP/1.1\r\nHost: h\r\n"), None);
    }

    #[test]
    fn download_signature_verifies_only_the_exact_mac() {
        let exp = download_expiry(false);
        let sig = sign_download("tok", false, "/a/b.txt", exp);
        assert!(verify_download("tok", false, "/a/b.txt", exp, &sig));
        // Any change to the signed tuple, or to the signature, is rejected.
        assert!(!verify_download("tok", false, "/a/c.txt", exp, &sig), "path is bound");
        assert!(!verify_download("tok", false, "/a/b.txt", exp + 1, &sig), "exp is bound: a client cannot extend a URL's life");
        assert!(!verify_download("other", false, "/a/b.txt", exp, &sig), "token is bound");
        let mut flipped = sig.clone();
        flipped.replace_range(0..1, if sig.starts_with('0') { "1" } else { "0" });
        assert!(!verify_download("tok", false, "/a/b.txt", exp, &flipped));
        // Not hex, wrong length, empty: rejected without panicking.
        assert!(!verify_download("tok", false, "/a/b.txt", exp, "zz"));
        assert!(!verify_download("tok", false, "/a/b.txt", exp, &sig[..10]));
        assert!(!verify_download("tok", false, "/a/b.txt", exp, ""));
        // Expired.
        let gone = unix_now() - 1;
        assert!(!verify_download("tok", false, "/a/b.txt", gone, &sign_download("tok", false, "/a/b.txt", gone)));
        // A download signature never outlives its minute, however it is labelled.
        let long = unix_now() + DL_TOKEN_TTL_SECS + 5;
        assert!(!verify_download("tok", false, "/a/b.txt", long, &sign_download("tok", false, "/a/b.txt", long)));
    }

    #[test]
    fn stream_signatures_are_a_separate_mode_for_video_and_audio_only() {
        // Board #182: a <video> (or an <audio>, #416) re-requests its URL for the whole playback,
        // so a stream signature lives hours — and therefore ONLY for media.
        let now = unix_now();
        let dl = download_expiry(false);
        let st = download_expiry(true);
        assert!(dl >= now + DL_TOKEN_TTL_SECS && dl <= now + DL_TOKEN_TTL_SECS + 1);
        assert!(st >= now + DL_STREAM_TTL_SECS && st <= now + DL_STREAM_TTL_SECS + 1);
        assert_eq!(DL_STREAM_TTL_SECS, 4 * 3600, "a leaked URL replays for at most one film");
        let sig = sign_download("tok", true, "/v.mp4", st);
        assert!(verify_download("tok", true, "/v.mp4", st, &sig));
        // The mode is in the MAC: the same tuple signed as a download is not a stream, and vice versa.
        assert_ne!(sig, sign_download("tok", false, "/v.mp4", st));
        assert!(!verify_download("tok", false, "/v.mp4", st, &sig), "a stream signature does not verify as a download");
        assert!(!verify_download("tok", true, "/v.mp4", dl, &sign_download("tok", false, "/v.mp4", dl)), "a download signature does not verify as a stream");
        // Board #416: audio streams under the same rule, every extension of the table and nothing else.
        for name in ["/a/song.mp3", "/a/memo.m4a", "/a/voice.aac", "/a/take.ogg", "/a/take.oga", "/a/clip.opus", "/a/beep.wav", "/a/lossless.flac", "/a/clip.weba"] {
            assert!(streams(name), "{name}");
            assert!(verify_download("tok", true, name, st, &sign_download("tok", true, name, st)), "{name}");
            assert!(!verify_download("tok", false, name, st, &sign_download("tok", true, name, st)), "{name}: the mode stays in the MAC");
        }
        assert!(!streams("/a/playlist.m3u") && !streams("/a/song.mp3.txt") && !streams("/a/cover.jpg"), "a lookalike or a picture does not get the long life");
        // A stream signature over a non-media path is refused even when the MAC is right.
        let env = sign_download("tok", true, "/srv/.env", st);
        assert!(!streams("/srv/.env"));
        assert!(!verify_download("tok", true, "/srv/.env", st, &env), "the long life is for media elements only");
        assert!(!verify_download("tok", true, "/srv/index.html", st, &sign_download("tok", true, "/srv/index.html", st)));
        assert!(!verify_download("tok", true, "/shot.png", st, &sign_download("tok", true, "/shot.png", st)), "images arrive as bytes; they do not stream");
        // Even a correctly signed expiry beyond the ceiling is refused.
        let far = now + DL_STREAM_TTL_SECS + 60;
        assert!(!verify_download("tok", true, "/v.mp4", far, &sign_download("tok", true, "/v.mp4", far)));
    }

    // ── The scope mode (board #433) ─────────────────────────────────────

    fn scope_dir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tmm-433-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }
    #[cfg(unix)]
    fn pin(p: &std::path::Path) -> (u64, u64) {
        use std::os::unix::fs::MetadataExt;
        let m = std::fs::symlink_metadata(p).unwrap();
        (m.dev(), m.ino())
    }

    #[test]
    fn a_scope_signature_verifies_for_its_own_fields_only() {
        let exp = unix_now() + 60;
        let sig = sign_scope("tok", exp, 7, 9, "/tmp/r:1700000000");
        assert!(verify_scope("tok", exp, 7, 9, "/tmp/r:1700000000", &sig), "a root with colons is just a root");
        assert!(!verify_scope("tok", exp + 1, 7, 9, "/tmp/r:1700000000", &sig), "exp");
        assert!(!verify_scope("tok", exp, 8, 9, "/tmp/r:1700000000", &sig), "dev");
        assert!(!verify_scope("tok", exp, 7, 10, "/tmp/r:1700000000", &sig), "ino");
        assert!(!verify_scope("tok", exp, 7, 9, "/tmp/r", &sig), "root");
        assert!(!verify_scope("other", exp, 7, 9, "/tmp/r:1700000000", &sig), "token");
        assert!(!verify_scope("tok", exp, 7, 9, "/tmp/r:1700000000", ""), "no signature");
        assert!(!verify_scope("tok", exp, 7, 9, "relative", &sign_scope("tok", exp, 7, 9, "relative")), "a relative root");
        let past = unix_now() - 1;
        assert!(!verify_scope("tok", past, 7, 9, "/r", &sign_scope("tok", past, 7, 9, "/r")), "expired");
        let far = unix_now() + DL_STREAM_TTL_SECS + 60;
        assert!(!verify_scope("tok", far, 7, 9, "/r", &sign_scope("tok", far, 7, 9, "/r")), "past the ceiling");
    }

    /// #433 review: a legacy download path may itself begin with "scope:".
    /// With a derived key no such path, and no root, makes one mode's tag
    /// verify as another's, in any direction.
    #[test]
    fn the_scope_tag_is_an_hmac_under_the_derived_key() {
        // Known answer, computed outside this code (Python hmac/hashlib):
        // K = HMAC-SHA256("tok", "tmm-dl-scope-v1"),
        // tag = HMAC-SHA256(K, "v1\0" 1700000000 "\0" 7 "\0" 9 "\0" "/tmp/r").
        // The token itself never keys a scope tag (#433 review P1).
        assert_eq!(sign_scope("tok", 1_700_000_000, 7, 9, "/tmp/r"),
            "d43b1121ba82ccbbe999bb4a3733a43cff1409e27034173fdb1ff2d4cf7cb7dd");
    }

    #[test]
    fn scope_download_and_stream_signatures_never_stand_in_for_each_other() {
        let (e, d, i) = (unix_now() + 50, 11u64, 22u64);
        // The review's counterexample to a text-prefixed design: the legacy
        // download input for path "scope:E:D:I:/tmp/r" is
        // "dl:scope:E:D:I:/tmp/r:E", exactly what "dl:scope:E:D:I:<root>"
        // would have been for the root "/tmp/r:E". Under the derived key the
        // two never verify as each other.
        let crafted = format!("scope:{e}:{d}:{i}:/tmp/r");
        let root = format!("/tmp/r:{e}");
        assert_eq!(mac_input(false, &crafted, e), format!("dl:scope:{e}:{d}:{i}:{root}"), "the counterexample's two inputs are the same text");
        let download = sign_download("tok", false, &crafted, e);
        assert!(!verify_scope("tok", e, d, i, &root, &download), "a crafted download tag is no scope tag");
        let scope = sign_scope("tok", e, d, i, &root);
        assert!(!verify_download("tok", false, &crafted, e, &scope), "a scope tag is no download tag");
        assert!(!verify_download("tok", true, "/tmp/r/v.mp4", e, &scope), "nor a stream tag");
        let stream = sign_download("tok", true, "/tmp/r/v.mp4", e);
        assert!(!verify_scope("tok", e, d, i, "/tmp/r/v.mp4", &stream), "a stream tag is no scope tag");
        assert!(!verify_scope("tok", e, d, i, "/tmp/r", &sign_download("tok", false, "/tmp/r", e)), "nor a plain download tag");
    }

    #[test]
    fn scope_segments_are_decoded_once_and_refused_when_they_could_climb() {
        let at = |rest: &str| parse_scope(&format!("9/1.2/ab/{}/{rest}", "L3RtcA")).map(|r| r.segs);
        assert_eq!(at("a.css"), Some(vec!["a.css".into()]));
        assert_eq!(at("css/a.css?v=2"), Some(vec!["css".into(), "a.css".into()]), "a query is ignored");
        assert_eq!(at("a%20b/%E4%B8%AD.png"), Some(vec!["a b".into(), "中.png".into()]), "space and Chinese");
        assert_eq!(at("100%25.css"), Some(vec!["100%.css".into()]), "a literal %");
        assert_eq!(at("%252e"), Some(vec!["%2e".into()]), "decoded once: the literal name %2e");
        assert_eq!(at("%2e%2e/x.css"), None, "%2e%2e is .. after one decode");
        assert_eq!(at("%2E%2E/x.css"), None, "upper-case hex too");
        for bad in ["", "x//a.css", "./a.css", "../a.css", "a/../b.css", "a%2Fb.css", "a%2fb.css", "a%5Cb.css", "a%00.css", "dir/"] {
            assert_eq!(at(bad), None, "{bad:?}");
        }
        let r = parse_scope("1700000000/66.77/cafe/L3Rtcg/x.css").unwrap();
        assert_eq!((r.exp, r.dev, r.ino, r.sig.as_str(), r.root.as_str()), (1700000000, 66, 77, "cafe", "/tmr"));
        assert_eq!(parse_scope("nope/1.2/ab/L3Rtcg/x.css"), None, "exp is digits");
        assert_eq!(parse_scope("9/12/ab/L3Rtcg/x.css"), None, "dev.ino");
        assert_eq!(parse_scope("9/1.2/ab/!!/x.css"), None, "the root is base64url");
    }

    #[test]
    fn only_subresource_types_leave_the_scope_door() {
        for (name, ctype) in [("a.css", "text/css"), ("A.PNG", "image/png"), ("i.svg", "image/svg+xml"), ("f.woff2", "font/woff2"), ("f.ttf", "font/ttf"), ("v.mp4", "video/mp4"), ("s.mp3", "audio/mpeg")] {
            assert_eq!(scope_content_type(name), Some(ctype), "{name}");
        }
        for name in ["index.html", "x.htm", "app.js", "m.mjs", "d.json", ".env", "noext", "x.xhtml"] {
            assert_eq!(scope_content_type(name), None, "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_scope_opens_only_what_lies_under_its_pinned_root_without_a_symlink() {
        let root = scope_dir("root");
        let outside = scope_dir("outside");
        std::fs::create_dir_all(root.join("css/deep")).unwrap();
        std::fs::write(root.join("a.css"), "a{}").unwrap();
        std::fs::write(root.join("css/deep/b.css"), "b{}").unwrap();
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        std::fs::write(outside.join("x.css"), "x{}").unwrap();
        std::os::unix::fs::symlink(outside.join("x.css"), root.join("escape.css")).unwrap();
        std::os::unix::fs::symlink(root.join("a.css"), root.join("inner.css")).unwrap();
        std::os::unix::fs::symlink(root.join(".env"), root.join("alias.css")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        let r = root.to_string_lossy().to_string();
        let (d, i) = pin(&root);
        let open = |segs: &[&str]| open_in_scope(&r, d, i, &segs.iter().map(|s| s.to_string()).collect::<Vec<_>>()).map(|_| ());
        assert_eq!(open(&["a.css"]), Ok(()), "a sibling");
        assert_eq!(open(&["css", "deep", "b.css"]), Ok(()), "a nested file");
        assert_eq!(open(&["missing.css"]), Err(404));
        assert_eq!(open(&["css", "nope", "b.css"]), Err(404));
        assert_eq!(open(&["css"]), Err(403), "a directory is never streamed");
        assert_eq!(open(&["escape.css"]), Err(403), "a static symlink out of the scope");
        assert_eq!(open(&["inner.css"]), Err(403), "an in-scope symlink, refused in v1");
        assert_eq!(open(&["alias.css"]), Err(403), "alias.css -> .env");
        assert_eq!(open(&["out", "x.css"]), Err(403), "a symlinked directory out of the scope");
        // The target swapped for a symlink after the cap was minted.
        std::fs::remove_file(root.join("a.css")).unwrap();
        std::os::unix::fs::symlink(outside.join("x.css"), root.join("a.css")).unwrap();
        assert_eq!(open(&["a.css"]), Err(403), "a swapped target");
        // The root re-pointed after mint: renamed away, and its name now a
        // symlink to another directory, then a fresh directory of that name.
        let moved = root.with_extension("moved");
        std::fs::rename(&root, &moved).unwrap();
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        assert_eq!(open(&["x.css"]), Err(403), "the root's name is a symlink now");
        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("x.css"), "x{}").unwrap();
        assert_eq!(open(&["x.css"]), Err(403), "another directory under the same name has another inode");
        for d in [&root, &moved, &outside] { let _ = std::fs::remove_dir_all(d); }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_scope_answer_carries_its_isolation_headers_and_ranges() {
        use tokio::io::AsyncReadExt;
        let root = scope_dir("serve");
        std::fs::write(root.join("a.css"), "body{color:red}").unwrap();
        std::fs::write(root.join("p.html"), "<script>x</script>").unwrap();
        let r = root.to_string_lossy().to_string();
        let base = scope_base("tok", &r, &[]).unwrap();
        let after = |name: &str| format!("{}{name}", base.strip_prefix("/dl/s/").unwrap());
        let ask = |after: String, extra: &'static str| async move {
            let (mut client, mut server) = tokio::io::duplex(1 << 16);
            let req = format!("GET /dl/s/{after} HTTP/1.1\r\nHost: h\r\n{extra}\r\n");
            serve_scope(&mut server, "127.0.0.1:1".parse().unwrap(), "tok", &after, &req).await;
            drop(server);
            let mut out = String::new();
            client.read_to_string(&mut out).await.unwrap();
            out
        };
        let css = ask(after("a.css"), "").await;
        assert!(css.starts_with("HTTP/1.1 200 OK\r\n"), "{css}");
        for h in ["Content-Type: text/css\r\n", "Content-Disposition: attachment", "X-Content-Type-Options: nosniff\r\n", "Referrer-Policy: no-referrer\r\n", "Content-Security-Policy: sandbox; default-src 'none'"] {
            assert!(css.contains(h), "{h}: {css}");
        }
        assert!(css.ends_with("body{color:red}"), "{css}");
        let part = ask(after("a.css"), "Range: bytes=5-9\r\n").await;
        assert!(part.starts_with("HTTP/1.1 206 ") && part.ends_with("color"), "{part}");
        assert!(ask(after("p.html"), "").await.starts_with("HTTP/1.1 403 "), "a document is refused");
        assert!(ask(after("none.css"), "").await.starts_with("HTTP/1.1 404 "));
        let forged = format!("{}/1.2/{}/{}/a.css", unix_now() + 60, "00", base.split('/').nth(6).unwrap());
        assert!(ask(forged, "").await.starts_with("HTTP/1.1 403 "), "a bad signature, before any file is read");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_download_name_never_enters_its_header_raw() {
        assert_eq!(attachment("plain.txt"), "attachment; filename=\"plain.txt\"; filename*=UTF-8''plain.txt");
        let d = attachment("a\"b\r\nX-Evil: 1\r\n\r\n中.css");
        assert!(!d.contains(['\r', '\n']), "{d}");
        assert_eq!(d, "attachment; filename=\"a_b__X-Evil: 1_____.css\"; filename*=UTF-8''a%22b%0D%0AX-Evil%3A%201%0D%0A%0D%0A%E4%B8%AD.css");
        assert_eq!(attachment("back\\slash"), "attachment; filename=\"back_slash\"; filename*=UTF-8''back%5Cslash");
    }

    /// Real HTTP through the one entry, for a scope cap and a legacy /dl
    /// URL, over files whose NAMES hold a quote, CR, LF and a blank line
    /// (#433 review P1-B): the header block ends once, at the real end; the
    /// body is the file's bytes exactly; no injected line becomes a header,
    /// and the scope's security headers are all in the block, on 200 and 206.
    #[cfg(unix)]
    #[tokio::test]
    async fn names_with_quotes_and_line_breaks_cannot_move_the_header_block() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = scope_dir("crlf");
        let r = root.to_string_lossy().to_string();
        let base = scope_base("tok", &r, &[]).unwrap();
        async fn ask(target: String, extra: &str) -> (String, String) {
            let (mut client, server) = tokio::io::duplex(1 << 16);
            let req = format!("GET {target} HTTP/1.1\r\nHost: h\r\n{extra}\r\n");
            client.write_all(req.as_bytes()).await.unwrap();
            handle_http_download(server, "127.0.0.1:1".parse().unwrap(), Arc::new("tok".into())).await;
            let mut out = String::new();
            client.read_to_string(&mut out).await.unwrap();
            let (head, body) = out.split_once("\r\n\r\n").unwrap_or((&out, ""));
            (head.to_string(), body.to_string())
        }
        for name in ["q\"uote.css", "cr\r.css", "lf\n.css", "crlf\r\n\r\nX-Evil: 1.css", "x\r\nX-Evil: 1\r\n.css"] {
            std::fs::write(root.join(name), "body{color:red}").unwrap();
            let scope = format!("{base}{}", urlencoding::encode(name));
            let path = root.join(name).to_string_lossy().to_string();
            let exp = unix_now() + 50;
            let legacy = format!("/dl?path={}&exp={exp}&sig={}", urlencoding::encode(&path), sign_download("tok", false, &path, exp));
            for (target, is_scope) in [(scope, true), (legacy, false)] {
                for (range, status, body) in [("", "200 OK", "body{color:red}"), ("Range: bytes=5-9\r\n", "206 Partial Content", "color")] {
                    let (head, got) = ask(target.clone(), range).await;
                    let what = format!("{name:?} scope={is_scope} {status}");
                    assert!(head.starts_with(&format!("HTTP/1.1 {status}\r\n")), "{what}: {head}");
                    assert_eq!(got, body, "{what}: the body is the file, so the block ended at its real end");
                    assert!(!head.lines().any(|l| l.starts_with("X-Evil")), "{what}: {head}");
                    let dispositions: Vec<&str> = head.lines().filter(|l| l.starts_with("Content-Disposition:")).collect();
                    if is_scope {
                        assert_eq!(dispositions, ["Content-Disposition: attachment"], "{what}");
                        for h in ["X-Content-Type-Options: nosniff", "Referrer-Policy: no-referrer", "Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'"] {
                            assert!(head.lines().any(|l| l == h), "{what}: {h} in {head}");
                        }
                    } else {
                        assert_eq!(dispositions, [format!("Content-Disposition: {}", attachment(name)).as_str()], "{what}");
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The type is the LAST segment's, the object actually opened (validator
    /// V5): a directory's name never lends a file its type.
    #[tokio::test]
    async fn a_nested_path_takes_its_type_from_the_file_it_opens() {
        use tokio::io::AsyncReadExt;
        let root = scope_dir("nested-type");
        for d in ["css", "d.png", "x.css"] { std::fs::create_dir_all(root.join(d)).unwrap(); }
        std::fs::write(root.join("css/a.css"), "body{}").unwrap();
        std::fs::write(root.join("d.png/x.html"), "<script>x</script>").unwrap();
        std::fs::write(root.join("x.css/p.png"), "png").unwrap();
        let base = scope_base("tok", &root.to_string_lossy(), &[]).unwrap();
        let ask = |rest: &str| {
            let after = format!("{}{rest}", base.strip_prefix("/dl/s/").unwrap());
            async move {
                let (mut client, mut server) = tokio::io::duplex(1 << 16);
                let req = format!("GET /dl/s/{after} HTTP/1.1\r\nHost: h\r\n\r\n");
                serve_scope(&mut server, "127.0.0.1:1".parse().unwrap(), "tok", &after, &req).await;
                drop(server);
                let mut out = String::new();
                client.read_to_string(&mut out).await.unwrap();
                out
            }
        };
        let css = ask("css/a.css").await;
        assert!(css.starts_with("HTTP/1.1 200 OK\r\n") && css.contains("Content-Type: text/css\r\n"), "{css}");
        let html = ask("d.png/x.html").await;
        assert!(html.starts_with("HTTP/1.1 403 ") && !html.contains("<script>"), "a .png directory lends no type: {html}");
        let png = ask("x.css/p.png").await;
        assert!(png.starts_with("HTTP/1.1 200 OK\r\n") && png.contains("Content-Type: image/png\r\n"), "{png}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A proxy prefix that itself holds `/dl/s/` (review P2) still reaches
    /// the door: the first occurrence with the signed shape is it.
    #[tokio::test]
    async fn a_proxy_prefix_holding_the_door_segment_still_reaches_the_door() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let root = scope_dir("nested");
        std::fs::write(root.join("a.css"), "body{}").unwrap();
        let base = scope_base("tok", &root.to_string_lossy(), &[]).unwrap();
        async fn get(target: &str) -> String {
            let (mut client, server) = tokio::io::duplex(1 << 16);
            client.write_all(format!("GET {target} HTTP/1.1\r\nHost: h\r\n\r\n").as_bytes()).await.unwrap();
            handle_http_download(server, "127.0.0.1:1".parse().unwrap(), Arc::new("tok".into())).await;
            let mut out = String::new();
            client.read_to_string(&mut out).await.unwrap();
            out
        }
        for target in [format!("{base}a.css"), format!("/dl/s/proxy{base}a.css"), format!("/x/dl/s/1/dl/s/proxy{base}a.css")] {
            let out = get(&target).await;
            assert!(out.starts_with("HTTP/1.1 200 OK\r\n") && out.ends_with("body{}"), "{target}: {out}");
        }
        // The same prefix in front of an ORDINARY download (validator P2): the
        // legacy /dl answers it; the prefix's /dl/s/ is not a scope request.
        let path = root.join("a.css").to_string_lossy().to_string();
        let exp = unix_now() + 50;
        let legacy = format!("/dl?path={}&exp={exp}&sig={}", urlencoding::encode(&path), sign_download("tok", false, &path, exp));
        for prefix in ["", "/dl/s/proxy", "/x/dl/s/1/dl/s/proxy"] {
            let out = get(&format!("{prefix}{legacy}")).await;
            assert!(out.starts_with("HTTP/1.1 200 OK\r\n") && out.ends_with("body{}"), "{prefix}: {out}");
        }
        // No signed shape anywhere and no /dl? either: refused, never served.
        let out = get("/dl/s/proxy/dl/s/nope/a.css").await;
        assert!(out.starts_with("HTTP/1.1 4"), "refused: {out}");
        assert!(!out.contains("body{}"), "{out}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
