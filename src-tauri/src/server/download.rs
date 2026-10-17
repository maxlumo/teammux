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
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

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
    let name = file_path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
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
    let range = if !if_range_allows(&req, &etag, &last_modified) { Ok(None) } else { parse_range(&req, size) };
    let range = match range {
        Ok(r) => r,
        Err(()) => {
            let _ = stream.write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range\r\nConnection: close\r\n\r\n", size).as_bytes()).await;
            let _ = stream.flush().await;
            return;
        }
    };
    // Images and videos declare their REAL type: a chat `<img>` and a Files
    // `<video>` stream through /dl, and SVG never renders from
    // `application/octet-stream` (browsers do not sniff SVG — the dashed
    // fallback frame in every bubble, 2026-09-08). `Content-Disposition:
    // attachment` stays on everything, so a top-level navigation still
    // downloads instead of rendering — an SVG's scripts never execute from an
    // <img> context, and never get a document here. Everything else keeps
    // octet-stream: downloads, not documents.
    let ctype = media_content_type(&name);
    let header = match range {
        Some((start, end)) => format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nAccept-Ranges: bytes\r\n{}Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified\r\nConnection: close\r\n\r\n",
            ctype, name, end - start + 1, start, end, size, validators
        ),
        None => format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{}Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified\r\nConnection: close\r\n\r\n",
            ctype, name, size, validators
        ),
    };
    if stream.write_all(header.as_bytes()).await.is_err() { return; }

    // Stream file in chunks
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return,
    };
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
}
