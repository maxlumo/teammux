//! Board #133: Motion Photo detection on SYNTHETIC files built here (never the owner's).
//! Expected offsets are literals from the fixtures' own layout, not recomputed by the code.
use super::{motion_photo, Motion};

/// A minimal JPEG: SOI, an APP1 XMP segment carrying `xmp`, an SOS marker, a few scan
/// bytes, EOI. 2 + (4 + 29 + xmp.len()) + 2 + 4 + 2 bytes.
pub(crate) fn jpeg(xmp: &str) -> Vec<u8> {
    let ns = b"http://ns.adobe.com/xap/1.0/\0";
    let len = (2 + ns.len() + xmp.len()) as u16;
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xE1];
    v.extend_from_slice(&len.to_be_bytes());
    v.extend_from_slice(ns);
    v.extend_from_slice(xmp.as_bytes());
    v.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
    v
}

/// A 24-byte MP4 head: an 'ftyp' box (size 24, brand mp42) and nothing else.
pub(crate) fn mp4() -> Vec<u8> {
    let mut v = vec![0, 0, 0, 24];
    v.extend_from_slice(b"ftypmp42\0\0\0\0mp42isom");
    v
}

pub(crate) fn container(len: usize) -> String {
    format!(r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description GCamera:MotionPhoto="1" GCamera:MotionPhotoVersion="1"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="image/jpeg" Item:Semantic="Primary" Item:Length="0"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Mime="video/mp4" Item:Semantic="MotionPhoto" Item:Length="{len}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>"#)
}

/// A whole Motion Photo whose video is `mp4() + tail`: (the file, the video's offset). For the
/// `/dl` window tests too (`crate::fs::motion_fixture`).
pub(crate) fn fixture(tail: &[u8]) -> (Vec<u8>, u64) {
    let mut video = mp4();
    video.extend_from_slice(tail);
    let mut f = jpeg(&container(video.len()));
    let offset = f.len() as u64;
    f.extend(video);
    (f, offset)
}

fn scratch(tag: &str) -> std::path::PathBuf {
    let d = crate::config::test_scratch(&format!("motion-{tag}"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p.to_string_lossy().into_owned()
}

#[test]
fn a_motion_photo_names_its_video_window_after_the_still() {
    let dir = scratch("a_motion_photo_names_its");
    let still = jpeg(&container(24));
    let mut f = still.clone();
    f.extend(mp4());
    let p = write(&dir, "live.jpg", &f);
    assert_eq!(motion_photo(&p), Some(Motion { offset: still.len() as u64, length: 24 }));
}

#[test]
fn the_name_does_not_decide_content_does() {
    let dir = scratch("the_name_does_not_decide");
    let mut f = jpeg(&container(24));
    f.extend(mp4());
    let p = write(&dir, "no-suffix", &f);
    assert!(motion_photo(&p).is_some(), "a Motion Photo without .jpg is still one");
    let p = write(&dir, "fake.jpg", b"not a jpeg at all, GCamera:MotionPhoto=\"1\"");
    assert_eq!(motion_photo(&p), None, "a .jpg that is not a JPEG is not one");
}

#[test]
fn a_plain_jpeg_is_untouched() {
    let dir = scratch("a_plain_jpeg_is_untouche");
    let p = write(&dir, "plain.jpg", &jpeg(r#"<x:xmpmeta><rdf:Description tiff:Make="x"/></x:xmpmeta>"#));
    assert_eq!(motion_photo(&p), None);
}

#[test]
fn a_flag_without_the_mp4_box_is_a_plain_image() {
    let dir = scratch("a_plain_jpeg_is_untouche");
    let mut f = jpeg(&container(24));
    f.extend_from_slice(&[0u8; 24]);   // 24 bytes where the video should be, but no 'ftyp'
    let p = write(&dir, "flag.jpg", &f);
    assert_eq!(motion_photo(&p), None);
}

#[test]
fn a_length_at_or_past_the_file_size_is_a_plain_image() {
    let dir = scratch("a_length_at_or_past_the_");
    for len in [10_000_000usize, 0] {
        let mut f = jpeg(&container(len));
        f.extend(mp4());
        let p = write(&dir, &format!("big-{len}.jpg"), &f);
        assert_eq!(motion_photo(&p), None, "Length {len}");
    }
}

#[test]
fn the_legacy_micro_video_form_is_read_too() {
    let dir = scratch("the_legacy_micro_video_f");
    let still = jpeg(r#"<x:xmpmeta><rdf:Description GCamera:MicroVideo="1" GCamera:MicroVideoVersion="1" GCamera:MicroVideoOffset="24" GCamera:MicroVideoPresentationTimestampUs="0"/></x:xmpmeta>"#);
    let mut f = still.clone();
    f.extend(mp4());
    let p = write(&dir, "micro.jpg", &f);
    assert_eq!(motion_photo(&p), Some(Motion { offset: still.len() as u64, length: 24 }));
}

#[test]
fn the_element_form_of_the_xmp_is_read_too() {
    let dir = scratch("the_element_form_of_the_");
    let still = jpeg("<x:xmpmeta><rdf:Description><GCamera:MotionPhoto>1</GCamera:MotionPhoto><Container:Directory><rdf:Seq><rdf:li><Container:Item><Item:Semantic>MotionPhoto</Item:Semantic><Item:Mime>video/mp4</Item:Mime><Item:Length>24</Item:Length></Container:Item></rdf:li></rdf:Seq></Container:Directory></rdf:Description></x:xmpmeta>");
    let mut f = still.clone();
    f.extend(mp4());
    let p = write(&dir, "element.jpg", &f);
    assert_eq!(motion_photo(&p), Some(Motion { offset: still.len() as u64, length: 24 }));
}

#[test]
fn a_flag_set_to_zero_is_not_a_motion_photo() {
    let dir = scratch("a_flag_set_to_zero_is_no");
    let mut f = jpeg(&container(24).replace(r#"GCamera:MotionPhoto="1""#, r#"GCamera:MotionPhoto="0""#));
    f.extend(mp4());
    let p = write(&dir, "zero.jpg", &f);
    assert_eq!(motion_photo(&p), None);
}

/// Validator-2, #133 note 7 (measured 262,155 bytes read for a 205-byte head): the walk reads
/// as it goes, segment header then that segment, and stops at the XMP or the scan.
struct Counting<R> { inner: R, read: u64 }
impl<R: std::io::Read> std::io::Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        Ok(n)
    }
}
impl<R: std::io::Seek> std::io::Seek for Counting<R> {
    fn seek(&mut self, pos: std::io::SeekFrom) -> std::io::Result<u64> { self.inner.seek(pos) }
}

#[test]
fn the_walk_reads_only_the_segments_up_to_the_xmp_or_the_scan() {
    // A Motion Photo with a 128 KiB EXIF-like APP1 BEFORE its XMP: skipped, never read.
    let (photo, _) = fixture(&[7u8; 300_000]);
    let mut big = vec![0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF];
    big.extend(std::iter::repeat_n(0u8, 0xFFFD));
    big.extend_from_slice(&[0xFF, 0xE2, 0xFF, 0xFF]);
    big.extend(std::iter::repeat_n(0u8, 0xFFFD));
    big.extend_from_slice(&photo[2..]);
    let xmp_end = 2 + 2 * (2 + 0xFFFF) + (photo.len() - 300_024 - 10) as u64;   // up to the XMP's end
    let mut r = Counting { inner: std::io::Cursor::new(big.clone()), read: 0 };
    assert!(super::motion_in(&mut r, big.len() as u64).is_some());
    assert!(r.read < 3 * 1024, "read {} bytes (the head is {xmp_end} bytes with 128 KiB skipped)", r.read);

    // A plain JPEG with a 205-byte head and a 300 KB scan: up to the SOS and no further.
    let mut plain = jpeg(r#"<x:xmpmeta><rdf:Description tiff:Make="x"/></x:xmpmeta>"#);
    plain.truncate(plain.len() - 2);
    plain.extend(std::iter::repeat_n(0x11u8, 300_000));
    plain.extend_from_slice(&[0xFF, 0xD9]);
    let mut r = Counting { inner: std::io::Cursor::new(plain.clone()), read: 0 };
    assert_eq!(super::motion_in(&mut r, plain.len() as u64), None);
    assert!(r.read < 1024, "read {} bytes of a {}-byte file", r.read, plain.len());
}

/// Validator-2, #133 note 27 (measured): fill bytes and TEM/RST markers carried the walk past
/// the 256 KiB cap (to 320-640 KB). The cap is the reader's own: nothing past it is read.
#[test]
fn the_cap_is_hard_on_every_path_of_the_walk() {
    const CAP: u64 = 256 * 1024;
    let mut fill = vec![0xFF, 0xD8, 0xFF];
    fill.extend(std::iter::repeat_n(0xFFu8, 320_000));            // fill bytes
    let mut tem = vec![0xFF, 0xD8];
    for _ in 0..160_000 { tem.extend_from_slice(&[0xFF, 0x01]); }  // TEM, no length
    let mut rst = vec![0xFF, 0xD8];
    for _ in 0..160_000 { rst.extend_from_slice(&[0xFF, 0xD3]); }  // RST3, no length
    let mut segs = vec![0xFF, 0xD8];
    for _ in 0..6 { segs.extend_from_slice(&[0xFF, 0xE2, 0xFF, 0xFF]); segs.extend(std::iter::repeat_n(0u8, 0xFFFD)); }
    for (name, bytes) in [("fill", fill), ("tem", tem), ("rst", rst), ("segments", segs)] {
        let mut r = Counting { inner: std::io::Cursor::new(bytes.clone()), read: 0 };
        assert_eq!(super::motion_in(&mut r, bytes.len() as u64), None, "{name}");
        assert!(r.read <= CAP, "{name}: read {} bytes, past the {CAP}-byte cap", r.read);
    }
}
