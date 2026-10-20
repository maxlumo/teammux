//! One door for every connection on the gateway port, plain or TLS (board
//! #323). The request HEAD is read once, bounded (16 KiB up to the blank
//! line, 5 s), and classified from the parsed request line and headers:
//!
//! - a `…/dl?` request PATH (GET or OPTIONS) → the signed download handler;
//! - an `Upgrade: websocket` request → the WebSocket handshake;
//! - any other GET or HEAD → the static web UI (`server::ui`);
//! - anything else → 400.
//!
//! The handler gets a stream that REPLAYS every byte already read, then
//! the socket — so the download parser and tungstenite see the request
//! exactly as the client sent it. This replaces the earlier 256-byte peek
//! (plain) and the BufStream `fill_buf` (TLS): one mechanism, which also
//! sees a head split across TCP segments.

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};

pub const MAX_HEAD: usize = 16 * 1024;
pub const HEAD_DEADLINE: Duration = Duration::from_secs(5);

/// A stream that yields `prefix` first, then `inner`; writes go to `inner`.
pub struct Prefixed<S> {
    prefix: Vec<u8>,
    pos: usize,
    inner: S,
}

impl<S> Prefixed<S> {
    pub fn new(prefix: Vec<u8>, inner: S) -> Self {
        Prefixed { prefix, pos: 0, inner }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Prefixed<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        if self.pos < self.prefix.len() {
            let n = (self.prefix.len() - self.pos).min(buf.remaining());
            let start = self.pos;
            buf.put_slice(&self.prefix[start..start + n]);
            self.pos += n;
            if self.pos == self.prefix.len() {
                self.prefix = Vec::new();
                self.pos = 0;
            }
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Prefixed<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// What a request head asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Download,
    WebSocket,
    /// GET/HEAD for the web UI: method and the raw request target.
    Static { head: bool, target: String, accept: String },
    Bad,
}

/// Classify a complete request head (up to and including the blank line).
pub fn classify(head: &[u8]) -> Route {
    let Ok(text) = std::str::from_utf8(head) else { return Route::Bad };
    let mut lines = text.split("\r\n");
    let line = lines.next().unwrap_or("");
    let mut parts = line.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else { return Route::Bad };
    if parts.next().is_some() || !version.starts_with("HTTP/1.") {
        return Route::Bad;
    }
    let mut upgrade_ws = false;
    let mut accept = String::new();
    for h in lines.take_while(|l| !l.is_empty()) {
        let Some((name, value)) = h.split_once(':') else { continue };
        let value = value.trim();
        if name.eq_ignore_ascii_case("upgrade") {
            upgrade_ws |= value.split(',').any(|t| t.trim().eq_ignore_ascii_case("websocket"));
        } else if name.eq_ignore_ascii_case("accept") {
            accept = value.to_string();
        }
    }
    // The PATH (not the query) ends in …/dl — a reverse-proxy prefix is fine.
    let path = target.split('?').next().unwrap_or("");
    // The scope door of a preview's cap (board #433) is path-style:
    // `…/dl/s/{exp}/…`, a reverse-proxy prefix allowed the same way.
    let is_dl = (target.contains('?') && (path == "/dl" || path.ends_with("/dl")))
        || path.starts_with("/dl/s/") || path.contains("/dl/s/");
    match method {
        "GET" | "OPTIONS" if is_dl => Route::Download,
        "GET" if upgrade_ws => Route::WebSocket,
        "GET" | "HEAD" => Route::Static { head: method == "HEAD", target: target.to_string(), accept },
        _ => Route::Bad,
    }
}

/// Where a head ends: the index just past `\r\n\r\n`.
fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

/// Read until the head is complete. `Ok(bytes)` holds EVERYTHING read (the
/// head and whatever followed in the same segments), so the replay is
/// exact; `Err` = closed, timed out, or a head over MAX_HEAD.
pub async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Result<(Vec<u8>, usize), &'static str> {
    let fut = async {
        let mut buf = Vec::with_capacity(1024);
        let mut tmp = [0u8; 4096];
        loop {
            // The limit is on the HEAD; bytes after it (a client's first
            // WebSocket frame in the same segment) do not count.
            if let Some(end) = head_end(&buf) {
                return if end > MAX_HEAD { Err("request head too large") } else { Ok((buf, end)) };
            }
            if buf.len() >= MAX_HEAD {
                return Err("request head too large");
            }
            let n = stream.read(&mut tmp).await.map_err(|_| "read failed")?;
            if n == 0 {
                return Err("closed before the request head ended");
            }
            buf.extend_from_slice(&tmp[..n]);
            if head_end(&buf).is_none() && buf.len() > MAX_HEAD {
                return Err("request head too large");
            }
        }
    };
    tokio::time::timeout(HEAD_DEADLINE, fut).await.unwrap_or(Err("request head timed out"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(s: &str) -> Route {
        classify(s.as_bytes())
    }

    #[test]
    fn requests_are_classified_from_the_parsed_line_and_headers() {
        assert_eq!(route("GET /dl?path=x&sig=y HTTP/1.1\r\nHost: h\r\n\r\n"), Route::Download);
        assert_eq!(route("OPTIONS /dl?path=x HTTP/1.1\r\n\r\n"), Route::Download);
        assert_eq!(route("GET /tmux/dl?path=x HTTP/1.1\r\n\r\n"), Route::Download, "a proxy prefix");
        assert_eq!(route("GET /dl/s/9/1.2/ab/L3I/a.css HTTP/1.1\r\n\r\n"), Route::Download, "the scope door (#433)");
        assert_eq!(route("GET /tmux/dl/s/9/1.2/ab/L3I/a.css HTTP/1.1\r\n\r\n"), Route::Download, "the scope door behind a proxy prefix");
        assert_ne!(route("GET /dls/x HTTP/1.1\r\n\r\n"), Route::Download, "not a lookalike");
        assert_eq!(route("GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUPGRADE: WebSocket\r\n\r\n"), Route::WebSocket, "case-insensitive");
        assert_eq!(route("GET / HTTP/1.1\r\nUpgrade: h2c, websocket\r\n\r\n"), Route::WebSocket, "a token list");
        assert!(matches!(route("GET /?x=/dl?y HTTP/1.1\r\n\r\n"), Route::Static { .. }), "/dl? in the QUERY is not a download");
        assert!(matches!(route("GET /dlx?y HTTP/1.1\r\n\r\n"), Route::Static { .. }));
        assert!(matches!(route("GET /dl HTTP/1.1\r\n\r\n"), Route::Static { .. }), "no query: not a signed download");
        assert_eq!(route("HEAD /assets/a.js HTTP/1.1\r\nAccept: */*\r\n\r\n"), Route::Static { head: true, target: "/assets/a.js".into(), accept: "*/*".into() });
        assert_eq!(route("POST / HTTP/1.1\r\n\r\n"), Route::Bad);
        assert_eq!(route("GET / HTTP/2\r\n\r\n"), Route::Bad);
        assert_eq!(route("garbage\r\n\r\n"), Route::Bad);
    }

    #[tokio::test]
    async fn a_head_split_across_segments_is_read_whole_and_replayed_byte_exact() {
        let (mut client, server) = tokio::io::duplex(64);
        let req = b"GET /ws HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\n\r\nFIRST-FRAME-BYTES";
        let writer = tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            for chunk in req.chunks(7) {
                client.write_all(chunk).await.unwrap();
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            client
        });
        let mut server = server;
        let (bytes, end) = read_head(&mut server).await.unwrap();
        assert_eq!(classify(&bytes[..end]), Route::WebSocket);
        let mut replay = Prefixed::new(bytes, server);
        let _client = writer.await.unwrap();
        let mut got = vec![0u8; req.len()];
        replay.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, req, "every byte, in order, once");
    }

    #[tokio::test]
    async fn an_oversized_or_unfinished_head_is_refused() {
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        use tokio::io::AsyncWriteExt;
        client.write_all(&vec![b'a'; MAX_HEAD + 10]).await.unwrap();
        assert_eq!(read_head(&mut server).await.unwrap_err(), "request head too large");
        let (client, mut server) = tokio::io::duplex(64);
        drop(client);
        assert!(read_head(&mut server).await.is_err());
        // One segment carrying a head past the limit is refused too.
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        let mut big = b"GET / HTTP/1.1\r\nX: ".to_vec();
        big.resize(MAX_HEAD + 100, b'x');
        big.extend_from_slice(b"\r\n\r\n");
        client.write_all(&big).await.unwrap();
        assert_eq!(read_head(&mut server).await.unwrap_err(), "request head too large");
        // A head that ends exactly at the limit is fine, and frame bytes after it do not count.
        let (mut client, mut server) = tokio::io::duplex(64 * 1024);
        let mut head = b"GET / HTTP/1.1\r\nX: ".to_vec();
        head.resize(MAX_HEAD - 4, b'x');
        head.extend_from_slice(b"\r\n\r\n");
        head.extend_from_slice(&[0u8; 2048]);
        client.write_all(&head).await.unwrap();
        let (bytes, end) = read_head(&mut server).await.unwrap();
        assert_eq!(end, MAX_HEAD);
        // What followed the head arrives through the replay, read or not.
        let mut replay = Prefixed::new(bytes, server);
        let mut got = vec![0u8; head.len()];
        replay.read_exact(&mut got).await.unwrap();
        assert_eq!(got, head, "head + trailing bytes, exact");
    }
}
