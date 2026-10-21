//! Is OUR gateway already answering on this machine? (board #323)
//!
//! A real loopback login with this machine's own token, compared on machine
//! id — the server's existing auth, so no unauthenticated method is added.
//! Three verdicts, and only `None` (the connection was refused: nothing is
//! listening) lets a caller start a server:
//!
//! - `Ours` — the login succeeded and the machine id is ours.
//! - `Occupied` — something answers but cannot be proven ours: not a
//!   WebSocket, the token is refused, another machine's id, a TLS failure
//!   (including a certificate that does not name the loopback address), or
//!   no answer within the deadline. Never treated as free.
//! - `None` — connection refused.
//!
//! The address and scheme come from the effective `Config`: a wildcard bind
//! (`0.0.0.0` / `::`) is reached on the matching loopback, a specific address
//! on itself; `wss` when a TLS certificate is configured, trusting exactly
//! that certificate (a self-signed gateway proves itself) and checking it
//! against the address dialled.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;

pub const DEADLINE: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// `build` is the gateway's own, from its login answer; None for a
    /// gateway older than board #368, which sends none. `lockout` is how
    /// that process keys its auth lockout (board #441), None before #441.
    Ours { machine_id: String, url: String, build: Option<crate::build_info::Build>, lockout: Option<serde_json::Value> },
    Occupied(String),
    None,
}

/// Where a local client reaches the gateway `cfg` describes (the one rule:
/// `Config::local_url`, which the desktop app's first address uses too).
pub fn local_url(cfg: &Config) -> String {
    cfg.local_url()
}

/// The pure verdict over a DECRYPTED login answer (tested without a socket).
/// Peer text never reaches the reason.
pub(crate) fn judge(answer: &serde_json::Value, our_machine: &str, url: &str) -> Verdict {
    let r = answer.get("result");
    if r.and_then(|r| r.get("authenticated")).and_then(|v| v.as_bool()) != Some(true) {
        return Verdict::Occupied(format!("{url} answered, but not as a tmux-mobile gateway"));
    }
    let id = r.and_then(|r| r.get("machine_id")).and_then(|v| v.as_str()).unwrap_or("");
    if id == our_machine && !id.is_empty() {
        Verdict::Ours { machine_id: id.to_string(), url: url.to_string(), build: r.and_then(crate::build_info::parse), lockout: r.and_then(|r| r.get("lockout")).cloned() }
    } else {
        Verdict::Occupied(format!("{url} is another machine's gateway"))
    }
}

pub async fn probe(cfg: &Config) -> Verdict {
    probe_and_ask(cfg, None).await.0
}

/// What an authenticated request on the probe's own session answered.
#[derive(Debug, Clone, PartialEq)]
pub enum Asked {
    Result(serde_json::Value),
    /// The gateway does not know the method (an older version).
    Unknown,
    /// It answered with an error, or not within the deadline — classified.
    Failed(String),
}

/// Probe, and — only when the gateway is provably OURS — send ONE request
/// on the SAME authenticated session (board #323: `tmm ui` asks `ui_info`
/// this way; never a second connection, never the raw token). Bounded by
/// the probe deadline as a whole.
pub async fn probe_and_ask(cfg: &Config, ask: Option<&str>) -> (Verdict, Option<Asked>) {
    let url = local_url(cfg);
    match tokio::time::timeout(DEADLINE, attempt(cfg, &url, ask)).await {
        Ok(v) => v,
        Err(_) => (Verdict::Occupied(format!("{url} did not answer within {} ms", DEADLINE.as_millis())), None),
    }
}

async fn attempt(cfg: &Config, url: &str, ask: Option<&str>) -> (Verdict, Option<Asked>) {
    let authority = url.split("://").nth(1).unwrap_or_default().to_string();
    let tcp = match TcpStream::connect(&authority.replace(['[', ']'], "")).await {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => return (Verdict::None, None),
        Err(e) => return (Verdict::Occupied(format!("cannot reach {url}: {e}")), None),
    };
    if url.starts_with("wss://") {
        match tls_connect(cfg, &authority, tcp).await {
            Ok(s) => session(s, url, cfg, ask).await,
            Err(e) => (Verdict::Occupied(format!("TLS to {url} failed: {e}")), None),
        }
    } else {
        session(tcp, url, cfg, ask).await
    }
}

async fn session<S>(stream: S, url: &str, cfg: &Config, ask: Option<&str>) -> (Verdict, Option<Asked>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (answer, mut sess) = match login(stream, url, &cfg.token).await {
        Ok(x) => x,
        Err(r) => return (Verdict::Occupied(r.say(url)), None),
    };
    let verdict = judge(&answer, &cfg.machine_id, url);
    let asked = match (ask, &verdict) {
        (Some(method), Verdict::Ours { .. }) => Some(sess.request(method).await),
        _ => None,
    };
    let _ = sess.ws.close(None).await;
    (verdict, asked)
}

/// An authenticated session: frames sealed under c2s / opened under s2c,
/// each direction with its own counter (the server's `HalfCipher` rule:
/// nonce = 4 zero bytes + the counter, big-endian).
pub(crate) struct Session<S> {
    ws: tokio_tungstenite::WebSocketStream<S>,
    c2s: aes_gcm::Aes256Gcm,
    s2c: aes_gcm::Aes256Gcm,
    sent: u64,
    received: u64,
}

fn nonce(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    n
}

impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin> Session<S> {
    fn open(&mut self, b: &[u8]) -> Result<serde_json::Value, Refusal> {
        use aes_gcm::aead::Aead;
        let n = nonce(self.received);
        self.received += 1;
        let plain = self.s2c.decrypt(aes_gcm::Nonce::from_slice(&n), b).map_err(|_| Refusal::Undecryptable)?;
        let json = crate::server::decode_wire_payload(&plain).map_err(|_| Refusal::Undecryptable)?;
        serde_json::from_str(&json).map_err(|_| Refusal::Undecryptable)
    }

    /// One request (id 2), then the sealed frames in order until its reply.
    /// Error text from the peer is never quoted.
    async fn request(&mut self, method: &str) -> Asked {
        use aes_gcm::aead::Aead;
        let req = serde_json::json!({ "id": 2, "method": method, "params": {} }).to_string();
        let n = nonce(self.sent);
        self.sent += 1;
        let Ok(sealed) = self.c2s.encrypt(aes_gcm::Nonce::from_slice(&n), crate::server::encode_wire_payload(&req).as_slice()) else {
            return Asked::Failed("could not seal the request".into());
        };
        if self.ws.send(Message::Binary(sealed.into())).await.is_err() {
            return Asked::Failed("the gateway closed the session".into());
        }
        while let Some(m) = self.ws.next().await {
            match m {
                Ok(Message::Binary(b)) => match self.open(&b) {
                    Ok(v) if v.get("id").and_then(|i| i.as_i64()) == Some(2) => {
                        if let Some(r) = v.get("result") {
                            return Asked::Result(r.clone());
                        }
                        let code = v.get("error").and_then(|e| e.get("code")).and_then(|c| c.as_i64());
                        return if code == Some(-32601) { Asked::Unknown } else { Asked::Failed(format!("the gateway refused {method}")) };
                    }
                    Ok(_) => continue, // a notification on the session
                    Err(_) => return Asked::Failed("a reply that did not decrypt".into()),
                },
                Ok(Message::Ping(_) | Message::Pong(_)) => continue,
                _ => break,
            }
        }
        Asked::Failed("the gateway closed the session".into())
    }
}

/// The server's own challenge login, so the token never crosses the wire:
/// wait for the `server_nonce` greeting (anything else is not our gateway),
/// answer with a fresh client nonce and an HMAC proof under the v2 proof
/// key, and accept only a reply ENCRYPTED under the s2c key — which only a
/// holder of the same token can produce. A peer that does not greet, or
/// whose reply does not decrypt, is classified, never quoted.
pub(crate) async fn login<S, R>(stream: S, url: R, token: &str) -> Result<(serde_json::Value, Session<S>), Refusal>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    R: tokio_tungstenite::tungstenite::client::IntoClientRequest + Unpin,
{
    use aes_gcm::KeyInit;
    use hmac::Mac;
    use rand::RngCore;
    let (mut ws, _) = tokio_tungstenite::client_async(url, stream).await.map_err(|_| Refusal::NotWebSocket)?;
    // 1. The greeting.
    let server_nonce = loop {
        match ws.next().await {
            Some(Ok(Message::Text(t))) => {
                let v: serde_json::Value = serde_json::from_str(&t).map_err(|_| Refusal::NoGreeting)?;
                let hex = v.get("server_nonce").and_then(|n| n.as_str()).ok_or(Refusal::NoGreeting)?;
                let bytes = hex::decode(hex).map_err(|_| Refusal::NoGreeting)?;
                break <[u8; 16]>::try_from(bytes.as_slice()).map_err(|_| Refusal::NoGreeting)?;
            }
            Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
            _ => return Err(Refusal::NoGreeting),
        }
    };
    // 2. Prove, never send, the token.
    let mut client_nonce = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut client_nonce);
    let keys = crate::server::derive_session_keys(token, &server_nonce, &client_nonce);
    let mut mac = <hmac::Hmac<sha2::Sha256> as Mac>::new_from_slice(&keys.proof).map_err(|_| Refusal::NoGreeting)?;
    mac.update(&server_nonce);
    mac.update(&client_nonce);
    let proof = hex::encode(mac.finalize().into_bytes());
    let hello = serde_json::json!({ "id": 1, "method": "auth",
        "params": { "client_nonce": hex::encode(client_nonce), "proof": proof, "e2e": crate::server::E2E_VERSION } });
    ws.send(Message::Text(hello.to_string().into())).await.map_err(|_| Refusal::NoGreeting)?;
    // 3. Only an answer sealed under our s2c key counts.
    while let Some(m) = ws.next().await {
        match m {
            Ok(Message::Binary(b)) => {
                let c2s = aes_gcm::Aes256Gcm::new_from_slice(&keys.c2s).map_err(|_| Refusal::Undecryptable)?;
                let s2c = aes_gcm::Aes256Gcm::new_from_slice(&keys.s2c).map_err(|_| Refusal::Undecryptable)?;
                let mut sess = Session { ws, c2s, s2c, sent: 0, received: 0 };
                // The first frame of the s2c stream.
                let answer = sess.open(&b)?;
                return Ok((answer, sess));
            }
            // A plain answer here is an auth error (or not our gateway).
            Ok(Message::Text(_)) => return Err(Refusal::TokenRefused),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return Err(Refusal::TokenRefused),
        }
    }
    Err(Refusal::TokenRefused)
}

/// Why a listener is not provably ours — classified, so no peer bytes (which
/// could be our own request echoed back) ever reach a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Refusal {
    NotWebSocket,
    NoGreeting,
    TokenRefused,
    Undecryptable,
}

impl Refusal {
    fn say(self, url: &str) -> String {
        match self {
            Refusal::NotWebSocket => format!("{url} is not a WebSocket server"),
            Refusal::NoGreeting => format!("{url} speaks WebSocket but not the tmux-mobile protocol"),
            Refusal::TokenRefused => format!("a gateway at {url} refused this machine's token"),
            Refusal::Undecryptable => format!("{url} answered without knowing this machine's token"),
        }
    }
}

async fn tls_connect(
    cfg: &Config,
    authority: &str,
    tcp: TcpStream,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    use tokio_rustls::rustls;
    let path = cfg.tls_cert.as_deref().ok_or("no certificate configured")?;
    let pem = std::fs::read(path).map_err(|e| format!("cannot read {path}: {e}"))?;
    let certs: Vec<_> = rustls_pemfile::certs(&mut &pem[..]).filter_map(|c| c.ok()).collect();
    let leaf = certs.first().cloned().ok_or_else(|| format!("{path} holds no certificate"))?;
    let mut roots = rustls::RootCertStore::empty();
    for c in &certs {
        roots.add(c.clone()).map_err(|e| e.to_string())?;
    }
    let provider = rustls::crypto::CryptoProvider::get_default().cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
    // The TLS library's own verification (signature, validity period,
    // subjectAltName against the dialled address), with the configured
    // certificate as the only trust anchor — plus a pin, so a different leaf
    // that the configured file could vouch for is not accepted either.
    let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
        .build().map_err(|e| e.to_string())?;
    let verifier = Arc::new(Pinned { leaf: leaf.as_ref().to_vec(), inner: webpki });
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions().map_err(|e| e.to_string())?
        .dangerous().with_custom_certificate_verifier(verifier).with_no_client_auth();
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority).trim_matches(['[', ']']).to_string();
    let name = rustls::pki_types::ServerName::try_from(host).map_err(|e| e.to_string())?;
    tokio_rustls::TlsConnector::from(Arc::new(config)).connect(name, tcp).await.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("CaUsedAsEndEntity") {
            "the configured certificate is a CA certificate; the gateway needs a leaf certificate (basicConstraints CA:FALSE) naming this address".into()
        } else {
            msg
        }
    })
}

/// The pinned leaf, then the library's full verification.
#[derive(Debug)]
struct Pinned {
    leaf: Vec<u8>,
    inner: Arc<tokio_rustls::rustls::client::WebPkiServerVerifier>,
}

impl tokio_rustls::rustls::client::danger::ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        intermediates: &[tokio_rustls::rustls::pki_types::CertificateDer<'_>],
        server_name: &tokio_rustls::rustls::pki_types::ServerName<'_>,
        ocsp: &[u8],
        now: tokio_rustls::rustls::pki_types::UnixTime,
    ) -> Result<tokio_rustls::rustls::client::danger::ServerCertVerified, tokio_rustls::rustls::Error> {
        if end_entity.as_ref() != self.leaf.as_slice() {
            return Err(tokio_rustls::rustls::Error::General("the gateway's certificate is not the configured one".into()));
        }
        self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        dss: &tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<tokio_rustls::rustls::client::danger::HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &tokio_rustls::rustls::pki_types::CertificateDer<'_>,
        dss: &tokio_rustls::rustls::DigitallySignedStruct,
    ) -> Result<tokio_rustls::rustls::client::danger::HandshakeSignatureValid, tokio_rustls::rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(port: u16) -> Config {
        let mut c = Config::load();
        c.host = "0.0.0.0".into();
        c.port = port;
        c.token = "tok-ours".into();
        c.machine_id = "m-ours".into();
        c.tls_cert = None;
        c.tls_key = None;
        c
    }

    #[test]
    fn the_local_url_follows_the_bind_and_tls() {
        let mut c = cfg(9899);
        assert_eq!(local_url(&c), "ws://127.0.0.1:9899");
        c.host = "::".into();
        assert_eq!(local_url(&c), "ws://[::1]:9899");
        c.host = "100.64.0.7".into();
        assert_eq!(local_url(&c), "ws://100.64.0.7:9899", "a specific bind is dialled on itself");
        c.host = "fd00::2".into();
        assert_eq!(local_url(&c), "ws://[fd00::2]:9899");
        c.tls_cert = Some("/c.pem".into());
        c.tls_key = Some("/k.pem".into());
        assert!(local_url(&c).starts_with("wss://"));
    }

    /// Board #368: `tmm gateway status` names the RUNNING gateway's build from
    /// its login answer; an older gateway sends none and says so.
    #[test]
    fn ours_carries_the_gateways_build_when_the_login_answer_has_one() {
        let url = "ws://127.0.0.1:1";
        let with = serde_json::json!({ "id": 1, "result": { "authenticated": true, "machine_id": "m", "build": crate::build_info::json() } });
        let Verdict::Ours { build, .. } = judge(&with, "m", url) else { panic!("ours") };
        assert_eq!(build, Some(crate::build_info::Build::ours()));
        let without = serde_json::json!({ "id": 1, "result": { "authenticated": true, "machine_id": "m" } });
        let Verdict::Ours { build, .. } = judge(&without, "m", url) else { panic!("ours") };
        assert_eq!(build, None, "an older gateway sends no build");
    }

    #[test]
    fn the_verdict_is_ours_only_for_a_login_with_our_machine_id() {
        let url = "ws://127.0.0.1:1";
        let ok = |id: &str| serde_json::json!({ "id": 1, "result": { "authenticated": true, "machine_id": id } });
        assert!(matches!(judge(&ok("m-ours"), "m-ours", url), Verdict::Ours { .. }));
        assert!(matches!(judge(&ok("m-else"), "m-ours", url), Verdict::Occupied(_)), "another machine");
        assert!(matches!(judge(&ok(""), "m-ours", url), Verdict::Occupied(_)));
        assert!(matches!(judge(&serde_json::json!({ "hello": 1 }), "m-ours", url), Verdict::Occupied(_)));
    }

    /// A fake listener for each case, on a free loopback port.
    async fn listener() -> (tokio::net::TcpListener, u16) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let p = l.local_addr().unwrap().port();
        (l, p)
    }
    /// A WebSocket peer that greets like a gateway (or not) and then sends
    /// one plain text frame.
    async fn ws_answering(greet: bool, answer: serde_json::Value) -> u16 {
        let (l, port) = listener().await;
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            if greet {
                let _ = ws.send(Message::Text(serde_json::json!({ "server_nonce": "00112233445566778899aabbccddeeff", "e2e": 2 }).to_string().into())).await;
                let _ = ws.next().await;
            }
            let _ = ws.send(Message::Text(answer.to_string().into())).await;
        });
        port
    }

    #[tokio::test]
    async fn the_probe_tells_occupied_and_free_apart_without_quoting_the_peer() {
        // A gateway-shaped peer refusing the proof (a plain error frame).
        let refused = ws_answering(true, serde_json::json!({ "id": 1, "error": { "code": -32001, "message": "LEAK-ME" } })).await;
        match probe(&cfg(refused)).await { Verdict::Occupied(w) => assert!(w.contains("refused") && !w.contains("LEAK-ME"), "{w}"), v => panic!("{v:?}") }
        // A plain-text "authenticated" answer cannot be ours: ours is sealed.
        let forged = ws_answering(true, serde_json::json!({ "id": 1, "result": { "authenticated": true, "machine_id": "m-ours" } })).await;
        assert!(matches!(probe(&cfg(forged)).await, Verdict::Occupied(_)), "an unsealed success is a forgery");
        // A WebSocket that does not greet with a nonce.
        let mute = ws_answering(false, serde_json::json!({ "hello": "LEAK-ME" })).await;
        match probe(&cfg(mute)).await { Verdict::Occupied(w) => assert!(w.contains("not the tmux-mobile protocol") && !w.contains("LEAK-ME"), "{w}"), v => panic!("{v:?}") }
        // A listener that is not a WebSocket at all.
        let (l, plain) = listener().await;
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            let (mut s, _) = l.accept().await.unwrap();
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi").await;
        });
        assert!(matches!(probe(&cfg(plain)).await, Verdict::Occupied(_)), "an HTTP server on the port is not free");
        // A listener that accepts and never answers.
        let (l, silent) = listener().await;
        tokio::spawn(async move {
            let (_s, _) = l.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        match probe(&cfg(silent)).await {
            Verdict::Occupied(why) => assert!(why.contains("did not answer"), "{why}"),
            v => panic!("a silent listener is not free: {v:?}"),
        }
        // Nothing listening: the port of a listener we just dropped.
        let (l, free) = listener().await;
        drop(l);
        assert_eq!(probe(&cfg(free)).await, Verdict::None);
    }

    /// Board #323, the desktop app's start: `ready` fires only once the
    /// listener is bound (and then the probe proves it ours); a port taken
    /// between the probe and the bind returns an error with `ready` never
    /// sent — so the app says `failed`, never a false `embedded`, and no
    /// second instance runs.
    #[tokio::test]
    async fn ready_fires_only_for_a_bound_listener() {
        // Starting a server sets the process-global tmux socket (board #349):
        // one scope for the test — serial check, lock, snapshot, restore on drop.
        let _tmux = crate::tmux::test_support::GlobalSocket::hold();
        let (l, port) = listener().await;
        drop(l);
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = crate::server::start_with_socket_ready("127.0.0.1", port, "tok-ours", "m-ours", None, None, None, 5, Default::default(), Some(tx)).await;
        });
        tokio::time::timeout(Duration::from_secs(5), rx).await.expect("ready in time").expect("ready sent");
        assert!(matches!(probe(&cfg(port)).await, Verdict::Ours { .. }), "ready means really listening");

        // The race: something takes the port after a None probe.
        let (held, busy) = listener().await;
        let (tx, rx) = tokio::sync::oneshot::channel();
        let r = crate::server::start_with_socket_ready("127.0.0.1", busy, "tok-ours", "m-ours", None, None, None, 5, Default::default(), Some(tx)).await;
        assert!(r.is_err(), "the bind fails");
        assert!(rx.await.is_err(), "ready was never sent");
        drop(held);
        // A TLS file that does not load fails after the bind, still before ready.
        let (l, port) = listener().await;
        drop(l);
        let (tx, rx) = tokio::sync::oneshot::channel();
        let r = crate::server::start_with_socket_ready("127.0.0.1", port, "tok-ours", "m-ours", None, Some("/nonexistent/c.pem".into()), Some("/nonexistent/k.pem".into()), 5, Default::default(), Some(tx)).await;
        assert!(r.is_err() && rx.await.is_err(), "no ready for a server that cannot serve");
    }

    /// The real (plain) server: Ours with our token, Occupied with another
    /// token or another machine id.
    #[tokio::test]
    async fn the_real_server_is_ours_only_with_our_token_and_machine() {
        // Starting a server sets the process-global tmux socket (board #349):
        // one scope for the test — serial check, lock, snapshot, restore on drop.
        let _tmux = crate::tmux::test_support::GlobalSocket::hold();
        let (l, port) = listener().await;
        drop(l);
        tokio::spawn(async move {
            let _ = crate::server::start_with_socket("127.0.0.1", port, "tok-ours", "m-ours", None, None, None, 5).await;
        });
        let mut v = Verdict::None;
        for _ in 0..40 {
            v = probe(&cfg(port)).await;
            if v != Verdict::None { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(matches!(v, Verdict::Ours { .. }), "{v:?}");
        // The real sealed login answer carries the server's build (board #368).
        let Verdict::Ours { build, .. } = &v else { unreachable!() };
        assert_eq!(build.as_ref(), Some(&crate::build_info::Build::ours()), "the real gateway names its build");
        let mut wrong = cfg(port);
        wrong.token = "tok-else".into();
        assert!(matches!(probe(&wrong).await, Verdict::Occupied(_)), "a refused token is not free");
        let mut other = cfg(port);
        other.machine_id = "m-else".into();
        assert!(matches!(probe(&other).await, Verdict::Occupied(_)), "our token, another machine id");
    }

    #[tokio::test]
    async fn a_tls_gateway_with_a_certificate_that_does_not_name_loopback_is_occupied_not_free() {
        // A configured cert that cannot be read or does not cover the address
        // dialled is never accepted and never reads as free.
        let (l, port) = listener().await;
        tokio::spawn(async move { let _ = l.accept().await; tokio::time::sleep(Duration::from_secs(3)).await; });
        let mut c = cfg(port);
        c.tls_cert = Some("/nonexistent/cert.pem".into());
        c.tls_key = Some("/nonexistent/key.pem".into());
        match probe(&c).await {
            Verdict::Occupied(why) => assert!(why.contains("TLS"), "{why}"),
            v => panic!("{v:?}"),
        }
    }

    /// A self-signed cert for `san`. `Err(None)` = this host has no openssl
    /// at all (the only skip); `Err(Some(why))` = openssl refused these
    /// arguments (e.g. an openssl without -not_before) — a failure, never a
    /// silent skip. `extra` adds openssl args (validity window, CA flag).
    fn self_signed(dir: &std::path::Path, san: &str, extra: &[&str]) -> Result<(String, String), Option<String>> {
        let (c, k) = (dir.join("c.pem"), dir.join("k.pem"));
        let out = std::process::Command::new("openssl")
            .args(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=gw",
                "-addext", &format!("subjectAltName={san}")])
            .args(extra)
            .arg("-keyout").arg(&k).arg("-out").arg(&c)
            .output();
        match out {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(None),
            Err(e) => Err(Some(e.to_string())),
            Ok(o) if o.status.success() => Ok((c.to_string_lossy().into(), k.to_string_lossy().into())),
            Ok(o) => Err(Some(String::from_utf8_lossy(&o.stderr).trim().to_string())),
        }
    }

    /// A real TLS gateway (the server's own TLS path). Ours only for a LEAF
    /// certificate that names 127.0.0.1, is in its validity window and is the
    /// configured one; every other case is Occupied — never None.
    #[tokio::test]
    async fn a_tls_gateway_is_ours_only_for_the_configured_valid_leaf_naming_the_address() {
        // Starting a server sets the process-global tmux socket (board #349):
        // one scope for the test — serial check, lock, snapshot, restore on drop.
        let _tmux = crate::tmux::test_support::GlobalSocket::hold();
        const LEAF: &str = "basicConstraints=critical,CA:FALSE";
        let guard = crate::tmux::Scratch::new("tlsprobe");
        let cases: &[(&str, &[&str], bool, bool, &str)] = &[
            ("ok", &["-addext", LEAF], true, false, ""),
            ("dns-only", &["-addext", LEAF], false, false, "DNS:gateway.example"),
            ("expired", &["-addext", LEAF, "-not_before", "20200101000000Z", "-not_after", "20200102000000Z"], false, false, ""),
            ("not-yet", &["-addext", LEAF, "-not_before", "20990101000000Z", "-not_after", "20990102000000Z"], false, false, ""),
            ("ca", &[], false, false, ""),
            ("other-cert", &["-addext", LEAF], false, true, ""),
        ];
        for (tag, extra, ours, other, san) in cases {
            let san = if san.is_empty() { "IP:127.0.0.1" } else { san };
            let dir = std::path::Path::new(&guard.path()).join(tag);
            std::fs::create_dir_all(&dir).unwrap();
            let (cert, key) = match self_signed(&dir, san, extra) {
                Ok(ck) => ck,
                Err(None) => { eprintln!("SKIPPED: no openssl on this host — the TLS probe cases did not run"); return }
                Err(Some(why)) => panic!("{tag}: openssl could not make the fixture ({why}) — this case would otherwise be skipped silently"),
            };
            let (l, port) = listener().await;
            drop(l);
            let (c2, k2) = (cert.clone(), key.clone());
            tokio::spawn(async move {
                let _ = crate::server::start_with_socket("127.0.0.1", port, "tok-ours", "m-ours", None, Some(c2), Some(k2), 5).await;
            });
            let mut c = cfg(port);
            c.host = "127.0.0.1".into();
            c.tls_key = Some(key);
            c.tls_cert = Some(if *other {
                let d2 = dir.join("other");
                std::fs::create_dir_all(&d2).unwrap();
                self_signed(&d2, san, extra).unwrap().0
            } else { cert });
            let mut v = Verdict::None;
            for _ in 0..40 {
                v = probe(&c).await;
                if v != Verdict::None { break; }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if *ours {
                assert!(matches!(v, Verdict::Ours { .. }), "{tag}: {v:?}");
            } else {
                match v { Verdict::Occupied(why) => assert!(why.contains("TLS"), "{tag}: {why}"), v => panic!("{tag}: {v:?}") }
            }
        }
    }

    /// The token never crosses the wire, and nothing a peer sends is quoted:
    /// an echo server receives only a nonce and a proof, and the verdict
    /// carries no peer bytes.
    #[tokio::test]
    async fn an_echo_server_learns_nothing_and_is_never_quoted() {
        const SECRET: &str = "DUMMY-TOKEN-0123456789abcdef";
        let (l, port) = listener().await;
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            for _ in 0..2 {
                let (s, _) = l.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
                // Pretend to be a gateway: greet, then echo whatever arrives.
                let _ = ws.send(Message::Text(serde_json::json!({ "server_nonce": "00112233445566778899aabbccddeeff", "e2e": 2 }).to_string().into())).await;
                while let Some(Ok(m)) = ws.next().await {
                    if let Message::Text(t) = &m { seen2.lock().unwrap().push(t.to_string()); }
                    let _ = ws.send(m).await;
                }
            }
        });
        let mut c = cfg(port);
        c.token = SECRET.into();
        let v = probe(&c).await;
        match &v {
            Verdict::Occupied(why) => assert!(!why.contains(SECRET) && !why.contains("proof") && !why.contains("client_nonce"), "{why}"),
            v => panic!("an echo is not our gateway: {v:?}"),
        }
        let sent = seen.lock().unwrap().join("\n");
        assert!(!sent.is_empty(), "the probe did talk to it");
        assert!(!sent.contains(SECRET), "the token never crosses the wire: {sent}");
        assert!(sent.contains("\"proof\"") && sent.contains("\"client_nonce\""), "a challenge proof instead");
    }

    /// `tmm ui`'s question rides the probe's own sealed session (board
    /// #323): against the real server it is answered, and only for ours.
    #[tokio::test]
    async fn ui_info_is_asked_on_the_authenticated_session_and_only_of_ours() {
        // Starting a server sets the process-global tmux socket (board #349):
        // one scope for the test — serial check, lock, snapshot, restore on drop.
        let _tmux = crate::tmux::test_support::GlobalSocket::hold();
        let (l, port) = listener().await;
        drop(l);
        tokio::spawn(async move {
            let _ = crate::server::start_with_socket("127.0.0.1", port, "tok-ours", "m-ours", None, None, None, 5).await;
        });
        let mut got = (Verdict::None, None);
        for _ in 0..40 {
            got = probe_and_ask(&cfg(port), Some("ui_info")).await;
            if got.0 != Verdict::None { break; }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(matches!(got.0, Verdict::Ours { .. }), "{got:?}");
        match got.1 {
            Some(Asked::Result(r)) => assert!(r.get("served").and_then(|v| v.as_bool()).is_some(), "{r}"),
            a => panic!("ui_info on the sealed session: {a:?}"),
        }
        // An unknown method is reported as such (an older gateway).
        assert_eq!(probe_and_ask(&cfg(port), Some("no_such_method_323")).await.1, Some(Asked::Unknown));
        // Not ours: nothing is asked at all.
        let mut other = cfg(port);
        other.machine_id = "m-else".into();
        let (v, asked) = probe_and_ask(&other, Some("ui_info")).await;
        assert!(matches!(v, Verdict::Occupied(_)) && asked.is_none(), "{v:?} {asked:?}");
    }

    /// An echo server pretending to be a gateway hears no token and no
    /// request: the question is only sent after a sealed, provably-ours login.
    #[tokio::test]
    async fn an_echo_server_is_never_asked_ui_info() {
        const SECRET: &str = "DUMMY-TOKEN-0123456789abcdef";
        let (l, port) = listener().await;
        let seen = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let seen2 = seen.clone();
        tokio::spawn(async move {
            let (s, _) = l.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let _ = ws.send(Message::Text(serde_json::json!({ "server_nonce": "00112233445566778899aabbccddeeff", "e2e": 2 }).to_string().into())).await;
            while let Some(Ok(m)) = ws.next().await {
                match &m {
                    Message::Text(t) => seen2.lock().unwrap().push(t.to_string()),
                    Message::Binary(b) => seen2.lock().unwrap().push(String::from_utf8_lossy(b).to_string()),
                    _ => {}
                }
                let _ = ws.send(m).await;
            }
        });
        let mut c = cfg(port);
        c.token = SECRET.into();
        let (v, asked) = probe_and_ask(&c, Some("ui_info")).await;
        assert!(matches!(v, Verdict::Occupied(_)) && asked.is_none(), "{v:?} {asked:?}");
        let sent = seen.lock().unwrap().join("\n");
        assert!(!sent.contains(SECRET) && !sent.contains("ui_info"), "{sent}");
    }
}
