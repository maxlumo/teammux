//! Board #133: a Motion Photo's video is served as a WINDOW of the same file. Synthetic
//! fixtures only (`crate::fs::motion_fixture`): a JPEG with its XMP, then a 34-byte "MP4"
//! (a 24-byte ftyp box + "0123456789").
use super::*;
use std::sync::Arc;

fn scratch(tag: &str) -> std::path::PathBuf {
    let d = crate::config::test_scratch(&format!("dl-motion-{tag}"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The fixture on disk: (path, offset). The video is 34 bytes.
fn photo(tag: &str) -> (String, u64) {
    let (bytes, offset) = crate::fs::motion_fixture(b"0123456789");
    let p = scratch(tag).join("live.jpg");
    std::fs::write(&p, bytes).unwrap();
    (p.to_string_lossy().into_owned(), offset)
}

fn url(path: &str, exp: u64, off: u64, len: u64, sig: &str) -> String {
    format!("/dl?path={}&exp={exp}&sig={sig}&motion={off}-{len}", urlencoding::encode(path))
}

async fn get(target: &str, extra: &str) -> (String, Vec<u8>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let (mut client, server) = tokio::io::duplex(1 << 16);
    client.write_all(format!("GET {target} HTTP/1.1\r\nHost: h\r\n{extra}\r\n").as_bytes()).await.unwrap();
    handle_http_download(server, "127.0.0.1:1".parse().unwrap(), Arc::new("tok".into())).await;
    let mut out = Vec::new();
    client.read_to_end(&mut out).await.unwrap();
    let at = out.windows(4).position(|w| w == b"\r\n\r\n").unwrap_or(out.len());
    let body = out.get(at + 4..).unwrap_or_default().to_vec();
    (String::from_utf8_lossy(&out[..at]).into_owned(), body)
}

const VIDEO: &[u8] = b"\0\0\0\x18ftypmp42\0\0\0\0mp42isom0123456789";

#[tokio::test]
async fn the_window_answers_as_its_own_mp4_with_ranges_relative_to_it() {
    let (path, off) = photo("window");
    let exp = unix_now() + 3600;
    let target = url(&path, exp, off, 34, &sign_motion("tok", &path, exp, off, 34));
    let (head, body) = get(&target, "").await;
    assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
    assert!(head.contains("Content-Type: video/mp4\r\n") && head.contains("Content-Length: 34\r\n"), "{head}");
    assert!(head.contains("Content-Disposition: attachment; filename=\"live.mp4\""), "the window saves as <stem>.mp4 (note 19): {head}");
    assert_eq!(body, VIDEO, "exactly the video's bytes, nothing of the still");
    let (head, body) = get(&target, "Range: bytes=4-7\r\n").await;
    assert!(head.starts_with("HTTP/1.1 206 ") && head.contains("Content-Range: bytes 4-7/34\r\n"), "{head}");
    assert_eq!(body, b"ftyp");
    let (head, body) = get(&target, "Range: bytes=30-999\r\n").await;
    assert!(head.contains("Content-Range: bytes 30-33/34\r\n"), "clamped to the window: {head}");
    assert_eq!(body, b"6789", "never a byte past the window");
    let (head, _) = get(&target, "Range: bytes=34-\r\n").await;
    assert!(head.starts_with("HTTP/1.1 416 ") && head.contains("Content-Range: bytes */34\r\n"), "{head}");
    let (whole, _) = get(&format!("/dl?path={}&exp={}&sig={}", urlencoding::encode(&path), unix_now() + 50, sign_download("tok", false, &path, unix_now() + 50)), "").await;
    let etag = |h: &str| h.lines().find(|l| l.starts_with("ETag:")).map(str::to_owned);
    let windowed = etag(&get(&target, "").await.0);
    assert!(windowed.is_some() && etag(&whole).is_some());
    assert_ne!(windowed, etag(&whole), "the window is its own resource for If-Range");
}

#[tokio::test]
async fn the_signature_covers_the_window() {
    let (path, off) = photo("tamper");
    let exp = unix_now() + 3600;
    let sig = sign_motion("tok", &path, exp, off, 34);
    for (o, l) in [(off - 1, 35), (0, 34 + off), (off, 33)] {
        let (head, _) = get(&url(&path, exp, o, l, &sig), "").await;
        assert!(head.starts_with("HTTP/1.1 403 "), "window {o}-{l}: {head}");
    }
}

#[tokio::test]
async fn a_motion_signature_is_its_own_mode() {
    let (path, off) = photo("modes");
    let exp = unix_now() + 3600;
    let motion = sign_motion("tok", &path, exp, off, 34);
    assert!(!verify_download("tok", true, &path, exp, &motion), "not a stream");
    assert!(!verify_download("tok", false, &path, exp, &motion), "not a download");
    let (head, _) = get(&format!("/dl?path={}&exp={exp}&sig={motion}&stream=1", urlencoding::encode(&path)), "").await;
    assert!(head.starts_with("HTTP/1.1 403 "), "{head}");
    let (head, _) = get(&url(&path, exp, off, 34, &sign_download("tok", true, &path, exp)), "").await;
    assert!(head.starts_with("HTTP/1.1 403 "), "a stream signature does not open a window: {head}");
    let late = unix_now() + DL_STREAM_TTL_SECS + 60;
    let (head, _) = get(&url(&path, late, off, 34, &sign_motion("tok", &path, late, off, 34)), "").await;
    assert!(head.starts_with("HTTP/1.1 403 "), "the stream ceiling holds: {head}");
}

#[tokio::test]
async fn a_file_changed_since_signing_answers_404_never_other_bytes() {
    let (path, off) = photo("changed");
    let exp = unix_now() + 3600;
    let target = url(&path, exp, off, 34, &sign_motion("tok", &path, exp, off, 34));
    std::fs::write(&path, crate::fs::motion_fixture(b"").0).unwrap();   // now a 24-byte video at another offset
    let (head, body) = get(&target, "").await;
    assert!(head.starts_with("HTTP/1.1 404 "), "{head}");
    assert!(body.is_empty());
}

/// The mint door: the client asks for `motion: true`, the SERVER finds the window and signs
/// it, and the URL it hands out opens exactly the video. A file that is not a Motion Photo is
/// refused at the door; the stat of one file names the window, a plain one has no `motion`.
#[tokio::test]
async fn the_server_finds_the_window_it_signs_and_the_stat_names_it() {
    use super::super::{rpc::handle_request, test_util::req};
    let (path, off) = photo("mint");
    let r = handle_request(&req("fs_download_url", serde_json::json!({ "path": path, "motion": true })), "tok");
    let url = r.result.expect("minted")["url"].as_str().unwrap().to_string();
    assert!(url.contains(&format!("&motion={off}-34")), "{url}");
    let (head, body) = get(&url, "").await;
    assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
    assert_eq!(body, VIDEO);
    let stat = serde_json::to_value(crate::fs::stat_file(&path).unwrap()).unwrap();
    assert_eq!(stat["motion"], serde_json::json!({ "offset": off, "length": 34 }));
    assert_eq!(stat["mime_hint"], "image/jpeg", "the still keeps its own type");

    let plain = scratch("mint").join("plain.jpg");
    std::fs::write(&plain, crate::fs::motion_fixture(b"").0.split_at(off as usize).0).unwrap();
    let plain = plain.to_string_lossy().into_owned();
    let r = handle_request(&req("fs_download_url", serde_json::json!({ "path": plain, "motion": true })), "tok");
    assert!(r.result.is_none() && r.error.is_some(), "not a Motion Photo: refused at the door");
    let stat = serde_json::to_value(crate::fs::stat_file(&plain).unwrap()).unwrap();
    assert!(stat.get("motion").is_none(), "a plain JPEG's stat is as before: {stat}");
    // A listing never measures it (ruling note 2): its entries carry no `motion`.
    let dir = std::path::Path::new(&path).parent().unwrap().to_string_lossy().into_owned();
    for entry in crate::fs::list_dir(&dir, true).unwrap() {
        assert!(serde_json::to_value(entry).unwrap().get("motion").is_none());
    }
}

/// Validator-2, #133 note 17 (measured): /dl detected by PATH and served from a SECOND open,
/// so a file swapped in between had a window of a plain file served as video/mp4. Every 200
/// must be the video detected at request time: 'ftyp' at its +4, exactly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_file_swapped_during_a_request_never_serves_another_files_bytes_as_the_window() {
    let (path, off) = photo("swap");
    let motion = std::fs::read(&path).unwrap();
    let plain = vec![b'X'; motion.len()];
    let dir = std::path::Path::new(&path).parent().unwrap().to_path_buf();
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let swapper = {
        let (stop, path, dir) = (stop.clone(), path.clone(), dir.clone());
        std::thread::spawn(move || {
            let mut i = 0u64;
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                let tmp = dir.join(format!("swap-{i}"));
                std::fs::write(&tmp, if i % 2 == 0 { &plain } else { &motion }).unwrap();
                std::fs::rename(&tmp, &path).unwrap();
                i += 1;
            }
        })
    };
    let exp = unix_now() + 3600;
    let target = url(&path, exp, off, 34, &sign_motion("tok", &path, exp, off, 34));
    let (mut ok, mut gone) = (0, 0);
    for n in 0..400 {
        let (head, body) = get(&target, "").await;
        if head.starts_with("HTTP/1.1 200 ") {
            ok += 1;
            assert_eq!(body, VIDEO, "request {n}: a 200 is the detected video, never another file's bytes");
        } else {
            assert!(head.starts_with("HTTP/1.1 404 ") && body.is_empty(), "request {n}: {head}");
            gone += 1;
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    swapper.join().unwrap();
    eprintln!("swap: {ok} served, {gone} refused");
}
