//! The lockout's key behind a trusted proxy (board #441).
//!
//! Why: every client of the owner's remote route (CloudFront -> Caddy -> the
//! reverse SSH tunnel) reaches the gateway from 127.0.0.1, so the per-IP auth
//! lockout keyed by the TCP peer let five bad tokens from any stranger lock the
//! owner's phone out for 60 s, again every minute.
//!
//! The rule, one mechanism and one header: when the TCP peer is inside
//! `trusted_proxies` (config.toml, OFF when absent), the key is the RIGHT-MOST
//! `X-Forwarded-For` entry that is not itself inside `trusted_proxies`. Every
//! entry to its left was written by someone the walk does not trust, so it is
//! never read. Anything that does not give a clean answer FAILS CLOSED to the
//! peer: no header, an empty or unparsable entry reached before an untrusted
//! one, or every entry trusted. That keeps today's keying; it does not skip
//! authentication. A peer that is not trusted is keyed by itself and its header
//! is never read: without a trusted proxy the header is anyone's to write.
//!
//! The header comes from the request head `dispatch` has already read (bounded
//! by `MAX_HEAD`), by its field name in any case. Repeated `X-Forwarded-For`
//! lines are one list, in order (RFC 9110 § 5.3). An entry may carry a port
//! (`1.2.3.4:5`, `[2001:db8::1]:5`): CloudFront-Viewer-Address, which the edge
//! copies into this header, is `ip:port`. A whole IP is tried FIRST, so an
//! unbracketed `2001:db8::1:443` is an IPv6 address, never an address and a
//! port. IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is read as the IPv4 address, for
//! the peer, the entries and the CIDRs alike.

use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};

/// One `trusted_proxies` entry: an address with a prefix length.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    bits: u8,
}

impl Cidr {
    /// `127.0.0.1`, `127.0.0.1/32`, `::1`, `fd00::/8`. A mapped IPv6 network
    /// is read as its IPv4 network (`::ffff:10.0.0.0/104` is `10.0.0.0/8`);
    /// a mapped prefix shorter than the mapping itself (/96) is refused, it
    /// would mix v4 and v6 space.
    pub fn parse(s: &str) -> Option<Cidr> {
        let s = s.trim();
        let (addr, bits) = match s.split_once('/') {
            Some((a, b)) => (a, Some(b.parse::<u8>().ok()?)),
            None => (s, None),
        };
        let ip: IpAddr = addr.parse().ok()?;
        match ip {
            IpAddr::V4(_) => {
                let bits = bits.unwrap_or(32);
                (bits <= 32).then_some(Cidr { net: ip, bits })
            }
            IpAddr::V6(v6) => {
                let bits = bits.unwrap_or(128);
                if bits > 128 { return None; }
                match v6.to_ipv4_mapped() {
                    Some(v4) if bits >= 96 => Some(Cidr { net: IpAddr::V4(v4), bits: bits - 96 }),
                    Some(_) => None,
                    None => Some(Cidr { net: ip, bits }),
                }
            }
        }
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.net, canonical(ip)) {
            (IpAddr::V4(n), IpAddr::V4(a)) => prefix_eq(&n.octets(), &a.octets(), self.bits),
            (IpAddr::V6(n), IpAddr::V6(a)) => prefix_eq(&n.octets(), &a.octets(), self.bits),
            _ => false,
        }
    }
}

impl std::fmt::Display for Cidr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.net, self.bits)
    }
}

fn prefix_eq(a: &[u8], b: &[u8], bits: u8) -> bool {
    let (full, rest) = ((bits / 8) as usize, bits % 8);
    if a[..full] != b[..full] { return false; }
    rest == 0 || (a[full] ^ b[full]) >> (8 - rest) == 0
}

/// The address an IPv4-mapped IPv6 address stands for; any other unchanged.
pub fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        v4 => v4,
    }
}

/// One `X-Forwarded-For` entry: a whole IP first, then `[v6]:port`, then
/// `v4:port`. Anything else (`unknown`, an obfuscated node, a hostname) is not
/// an address.
pub fn parse_entry(s: &str) -> Option<IpAddr> {
    let s = s.trim();
    if let Ok(ip) = s.parse::<IpAddr>() { return Some(canonical(ip)); }
    if let Some(rest) = s.strip_prefix('[') {
        let (addr, port) = rest.split_once("]:")?;
        port.parse::<u16>().ok()?;
        return addr.parse::<std::net::Ipv6Addr>().ok().map(|v6| canonical(IpAddr::V6(v6)));
    }
    let (addr, port) = s.rsplit_once(':')?;
    port.parse::<u16>().ok()?;
    addr.parse::<std::net::Ipv4Addr>().ok().map(IpAddr::V4)
}

/// What `trusted_proxies` in config.toml asked for.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum TrustedProxies {
    /// Absent or empty: the lockout is keyed by the TCP peer.
    #[default]
    Off,
    On(Vec<Cidr>),
    /// An entry that is not an address or a CIDR turns the whole key off
    /// (the peer keys, as when absent); the reason is said once at start and
    /// in the login answer.
    Ignored(String),
}

impl TrustedProxies {
    pub fn from_config(entries: Option<&[String]>) -> TrustedProxies {
        let Some(entries) = entries else { return TrustedProxies::Off };
        if entries.is_empty() { return TrustedProxies::Off; }
        let mut out = Vec::with_capacity(entries.len());
        for (i, e) in entries.iter().enumerate() {
            match Cidr::parse(e) {
                Some(c) => out.push(c),
                // The position only: the value is the person's, and a log
                // line has no business repeating config text.
                None => return TrustedProxies::Ignored(format!("entry {} is not an IP address or CIDR", i + 1)),
            }
        }
        TrustedProxies::On(out)
    }

    /// The policy as the login answer and `tmm gateway status` say it.
    pub fn describe(&self) -> serde_json::Value {
        match self {
            TrustedProxies::Off => serde_json::json!({ "keyed_by": "peer" }),
            TrustedProxies::On(c) => serde_json::json!({ "keyed_by": "x-forwarded-for", "trusted_proxies": c.iter().map(|c| c.to_string()).collect::<Vec<_>>() }),
            TrustedProxies::Ignored(why) => serde_json::json!({ "keyed_by": "peer", "ignored": why }),
        }
    }
}

/// Why a trusted peer's request was keyed by the peer after all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fallback {
    NoHeader,
    Malformed,
    AllTrusted,
}

impl Fallback {
    fn said(self) -> &'static AtomicBool {
        static NO_HEADER: AtomicBool = AtomicBool::new(false);
        static MALFORMED: AtomicBool = AtomicBool::new(false);
        static ALL_TRUSTED: AtomicBool = AtomicBool::new(false);
        match self { Fallback::NoHeader => &NO_HEADER, Fallback::Malformed => &MALFORMED, Fallback::AllTrusted => &ALL_TRUSTED }
    }
    fn words(self) -> &'static str {
        match self {
            Fallback::NoHeader => "sent no X-Forwarded-For",
            Fallback::Malformed => "sent an X-Forwarded-For entry that is not an address",
            Fallback::AllTrusted => "sent an X-Forwarded-For whose every entry is a trusted proxy",
        }
    }
}

/// The lockout key for a TCP peer (`peer` is its address, `head` the request
/// head as read). `Ok(key)` is the forwarded client when the walk gave one,
/// else the peer itself; `Err(reason)` is a trusted peer that fell back to
/// itself, with why.
pub fn lockout_key(peer: IpAddr, head: &[u8], trusted: &TrustedProxies) -> Result<IpAddr, (IpAddr, Fallback)> {
    let peer = canonical(peer);
    let TrustedProxies::On(cidrs) = trusted else { return Ok(peer) };
    let is_trusted = |ip: IpAddr| cidrs.iter().any(|c| c.contains(ip));
    if !is_trusted(peer) { return Ok(peer); }
    let values = forwarded_for(head);
    if values.is_empty() { return Err((peer, Fallback::NoHeader)); }
    let joined = values.join(",");
    for entry in joined.rsplit(',') {
        let Some(ip) = parse_entry(entry) else { return Err((peer, Fallback::Malformed)) };
        if !is_trusted(ip) { return Ok(ip); }
    }
    Err((peer, Fallback::AllTrusted))
}

/// `lockout_key`, saying a fallback once per gateway process per reason. The
/// line names the peer and the reason, never the header's text: it is written
/// by whoever the walk did not trust.
pub fn lockout_key_logged(peer: IpAddr, head: &[u8], trusted: &TrustedProxies) -> IpAddr {
    match lockout_key(peer, head, trusted) {
        Ok(ip) => ip,
        Err((ip, why)) => {
            if !why.said().swap(true, Ordering::Relaxed) {
                eprintln!("⚠️ trusted proxy {ip} {}: the lockout keys on the proxy (said once)", why.words());
            }
            ip
        }
    }
}

/// Every `X-Forwarded-For` field value of the head, in order, by name in any
/// case. The request line and the body are not read.
fn forwarded_for(head: &[u8]) -> Vec<&str> {
    let Ok(text) = std::str::from_utf8(head) else { return Vec::new() };
    text.split("\r\n")
        .skip(1)
        .take_while(|l| !l.is_empty())
        .filter_map(|l| l.split_once(':'))
        .filter(|(name, _)| name.trim_end().eq_ignore_ascii_case("x-forwarded-for") && !name.starts_with([' ', '\t']))
        .map(|(_, v)| v.trim())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(list: &[&str]) -> TrustedProxies {
        TrustedProxies::from_config(Some(&list.iter().map(|s| s.to_string()).collect::<Vec<_>>()))
    }
    fn head(lines: &[&str]) -> Vec<u8> {
        let mut h = String::from("GET /ws HTTP/1.1\r\nHost: localhost:9899\r\n");
        for l in lines { h.push_str(l); h.push_str("\r\n"); }
        h.push_str("\r\n");
        h.into_bytes()
    }
    fn ip(s: &str) -> IpAddr { s.parse().unwrap() }
    const LOOP: &str = "127.0.0.1";

    #[test]
    fn the_key_table() {
        let t = on(&["127.0.0.1/32", "::1"]);
        let k = |peer: &str, lines: &[&str]| lockout_key(ip(peer), &head(lines), &t);
        // An untrusted peer: the header is never read.
        assert_eq!(k("203.0.113.9", &["X-Forwarded-For: 198.51.100.1"]), Ok(ip("203.0.113.9")));
        // Trusted: the right-most entry outside the list.
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1"]), Ok(ip("198.51.100.1")));
        assert_eq!(k(LOOP, &["x-forwarded-for: 198.51.100.1"]), Ok(ip("198.51.100.1")), "the name in any case");
        // CloudFront-Viewer-Address copied in by the edge: ip:port and [v6]:port.
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1:51234"]), Ok(ip("198.51.100.1")));
        assert_eq!(k(LOOP, &["X-Forwarded-For: [2001:db8::7]:51234"]), Ok(ip("2001:db8::7")));
        // A whole IPv6 first: the last group is not a port.
        assert_eq!(k(LOOP, &["X-Forwarded-For: 2001:db8::1:443"]), Ok(ip("2001:db8::1:443")));
        // A spoofed left part is never read.
        assert_eq!(k(LOOP, &["X-Forwarded-For: 10.6.6.6, garbage, 198.51.100.1"]), Ok(ip("198.51.100.1")));
        // Trusted hops on the right are skipped.
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1, 127.0.0.1, ::1"]), Ok(ip("198.51.100.1")));
        // Repeated fields are one list, in order: the client in an earlier line,
        // a trusted hop in the last.
        assert_eq!(k(LOOP, &["X-Forwarded-For: 10.6.6.6", "X-Forwarded-For: 198.51.100.1"]), Ok(ip("198.51.100.1")));
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1", "X-Forwarded-For: 127.0.0.1"]), Ok(ip("198.51.100.1")));
        // Mapped v4, the peer and the entry alike.
        assert_eq!(k("::ffff:127.0.0.1", &["X-Forwarded-For: ::ffff:198.51.100.1"]), Ok(ip("198.51.100.1")));
        assert_eq!(k("::1", &["X-Forwarded-For: 198.51.100.1"]), Ok(ip("198.51.100.1")));
        // The peer is normalised too, so a fallback and an untrusted peer key
        // by the IPv4 address a mapped one stands for.
        assert_eq!(k("::ffff:127.0.0.1", &[]), Err((ip(LOOP), Fallback::NoHeader)));
        assert_eq!(k("::ffff:203.0.113.9", &["X-Forwarded-For: 198.51.100.1"]), Ok(ip("203.0.113.9")));
        // Fail closed to the peer.
        let peer = ip(LOOP);
        assert_eq!(k(LOOP, &[]), Err((peer, Fallback::NoHeader)));
        assert_eq!(k(LOOP, &["X-Forwarded-For: "]), Err((peer, Fallback::Malformed)), "an empty value");
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1,"]), Err((peer, Fallback::Malformed)), "an empty entry on the right");
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1, unknown"]), Err((peer, Fallback::Malformed)), "a bad entry before an untrusted one");
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1, 127.0.0.1, nope"]), Err((peer, Fallback::Malformed)), "a bad entry in the trusted suffix");
        assert_eq!(k(LOOP, &["X-Forwarded-For: 127.0.0.1, ::1"]), Err((peer, Fallback::AllTrusted)));
        assert_eq!(k(LOOP, &["X-Forwarded-For: 198.51.100.1:99999"]), Err((peer, Fallback::Malformed)), "a port out of range");
        // Only the X-Forwarded-For field: not a look-alike, not the target, not a folded line.
        assert_eq!(k(LOOP, &["X-Forwarded-For-Not: 198.51.100.1"]), Err((peer, Fallback::NoHeader)));
        assert_eq!(lockout_key(ip(LOOP), b"GET /ws?X-Forwarded-For:198.51.100.1 HTTP/1.1\r\nHost: x\r\n\r\n", &t), Err((peer, Fallback::NoHeader)));
        assert_eq!(k(LOOP, &[" X-Forwarded-For: 198.51.100.1"]), Err((peer, Fallback::NoHeader)), "a continuation line is not a field");
    }

    #[test]
    fn off_and_ignored_configs_key_by_the_peer_and_never_read_the_header() {
        let h = head(&["X-Forwarded-For: 198.51.100.1"]);
        for t in [TrustedProxies::from_config(None), on(&[]), on(&["127.0.0.1", "not-an-ip"]), on(&["127.0.0.1/33"]), on(&["::ffff:127.0.0.1/95"])] {
            assert!(!matches!(t, TrustedProxies::On(_)), "{t:?}");
            assert_eq!(lockout_key(ip(LOOP), &h, &t), Ok(ip(LOOP)), "{t:?}");
        }
        assert_eq!(on(&["127.0.0.1", "not-an-ip"]), TrustedProxies::Ignored("entry 2 is not an IP address or CIDR".into()), "the position, never the value");
    }

    #[test]
    fn cidrs_match_by_prefix_and_mapped_networks_are_ipv4() {
        let c = |s: &str| Cidr::parse(s).unwrap();
        assert!(c("10.0.0.0/8").contains(ip("10.255.0.1")));
        assert!(!c("10.0.0.0/8").contains(ip("11.0.0.1")));
        assert!(c("10.0.0.0/9").contains(ip("10.127.0.1")) && !c("10.0.0.0/9").contains(ip("10.128.0.1")));
        assert!(c("::ffff:10.0.0.0/104").contains(ip("10.1.2.3")), "a mapped network is the IPv4 network");
        assert!(c("10.0.0.0/8").contains(ip("::ffff:10.1.2.3")), "a mapped address is the IPv4 address");
        assert!(c("fd00::/8").contains(ip("fd12::1")) && !c("fd00::/8").contains(ip("fe80::1")));
        assert!(!c("0.0.0.0/0").contains(ip("::1")), "v4 space never matches v6");
        assert!(c("0.0.0.0/0").contains(ip("192.0.2.1")));
        assert_eq!(c("::1").to_string(), "::1/128");
    }

    #[test]
    fn the_policy_is_described_for_the_login_answer() {
        assert_eq!(TrustedProxies::Off.describe(), serde_json::json!({ "keyed_by": "peer" }));
        assert_eq!(on(&["127.0.0.1", "::1"]).describe(), serde_json::json!({ "keyed_by": "x-forwarded-for", "trusted_proxies": ["127.0.0.1/32", "::1/128"] }));
        assert_eq!(on(&["x"]).describe(), serde_json::json!({ "keyed_by": "peer", "ignored": "entry 1 is not an IP address or CIDR" }));
    }
}
