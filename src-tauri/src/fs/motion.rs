//! Board #133: is this file a Motion Photo? (owner, 2026-11-16: "虽然是jpg后缀，但是检测到
//! livephoto，要能够预览"). The ONE definition, by CONTENT, never by the name.
//!
//! A Google Motion Photo (written by vivo's kit on the owner's files, measured on #133) is a
//! JPEG whose XMP says `GCamera:MotionPhoto="1"` and lists a `Container:Item` with
//! `Item:Semantic="MotionPhoto"` and `Item:Length=L`; the MP4 is the file's LAST L bytes. The
//! legacy form says `GCamera:MicroVideo="1"` with `GCamera:MicroVideoOffset=N`, the video
//! being the last N bytes. Either is CONFIRMED only by an MP4 `ftyp` box at the video's start:
//! a flag without the box is a plain image.
//!
//! Cost, bounded: 2 bytes for any file; for a JPEG, 4 bytes per segment header up to the XMP
//! or the scan (SOS), whichever comes first, plus the XMP packet itself; other segments are
//! seeked past, never read, and nothing past `HEAD_MAX` is looked at; then 8 bytes at the
//! video's start. Never the whole file. It runs in the stat
//! of ONE file (`fs::stat_file`) and in `/dl`'s window check, never per entry of a listing.

use std::io::{Read, Seek, SeekFrom};

/// The most of a JPEG's head the walk reads looking for the XMP.
const HEAD_MAX: usize = 256 * 1024;
const XMP_NS: &[u8; 29] = b"http://ns.adobe.com/xap/1.0/\0";

/// The embedded video: the byte window `[offset, offset + length)` of the same file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Motion { pub offset: u64, pub length: u64 }

pub fn motion_photo(path: &str) -> Option<Motion> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    motion_in(&mut f, size)
}

/// `motion_photo` over any reader of a file of `size` bytes.
pub(crate) fn motion_in<R: Read + Seek>(f: &mut R, size: u64) -> Option<Motion> {
    // SOI; the walk's first byte is the 0xFF that completes the FF D8 FF gate.
    let mut soi = [0u8; 2];
    f.read_exact(&mut soi).ok()?;
    if soi != [0xFF, 0xD8] { return None; }
    let xmp = xmp(f)?;
    let length = video_length(&String::from_utf8_lossy(&xmp))?;
    if length == 0 || length >= size { return None; }
    let offset = size - length;
    let mut box_head = [0u8; 8];
    f.seek(SeekFrom::Start(offset)).ok()?;
    f.read_exact(&mut box_head).ok()?;
    (&box_head[4..8] == b"ftyp").then_some(Motion { offset, length })
}

/// The walk's reader: nothing at or past `cap` is read or seeked to (validator-2, #133 note
/// 27: fill bytes and TEM/RST markers had carried a walk with the check in some branches to
/// 640 KB). Either fails, which ends the walk as "not a Motion Photo".
struct Capped<'a, R> { inner: &'a mut R, pos: u64, cap: u64 }

impl<R: Read> Read for Capped<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let room = self.cap.saturating_sub(self.pos).min(buf.len() as u64) as usize;
        if room == 0 { return Err(std::io::Error::other("past the head cap")); }
        let n = self.inner.read(&mut buf[..room])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl<R: Seek> Seek for Capped<'_, R> {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let SeekFrom::Start(at) = to else { return Err(std::io::Error::other("the walk seeks from the start only")) };
        if at > self.cap { return Err(std::io::Error::other("past the head cap")); }
        self.pos = self.inner.seek(to)?;
        Ok(self.pos)
    }
}

/// The standard XMP packet: the payload of the first APP1 segment in the XMP namespace. The
/// walk READS AS IT GOES (validator-2, #133 note 7): a segment's marker and length, then only
/// an APP1's namespace (and, when it is the XMP's, its payload); every other segment is
/// seeked past. It stops at the XMP, at the scan (SOS) or EOI; the `Capped` reader ends it at
/// `HEAD_MAX` on every path.
fn xmp<R: Read + Seek>(f: &mut R) -> Option<Vec<u8>> {
    let f = &mut Capped { inner: f, pos: 2, cap: HEAD_MAX as u64 };
    let mut at: u64 = 2;
    loop {
        let mut marker = [0u8; 2];
        f.read_exact(&mut marker).ok()?;
        if marker[0] != 0xFF { return None; }
        // Fill bytes (0xFF) before the code: each read once, the next byte being the code.
        while marker[1] == 0xFF {
            let mut code = [0u8; 1];
            f.read_exact(&mut code).ok()?;
            marker[1] = code[0];
            at += 1;
        }
        match marker[1] {
            0xDA | 0xD9 => return None,                                          // the scan (or EOI): no XMP before it
            0x01 | 0xD0..=0xD7 => { at += 2; continue; }                         // markers without a length
            _ => {}
        }
        let mut len = [0u8; 2];
        f.read_exact(&mut len).ok()?;
        let len = u16::from_be_bytes(len) as u64;
        let end = at + 2 + len;
        if len < 2 { return None; }
        let payload = (len - 2) as usize;
        if marker[1] == 0xE1 && payload >= XMP_NS.len() {
            let mut ns = [0u8; XMP_NS.len()];
            f.read_exact(&mut ns).ok()?;
            if &ns == XMP_NS {
                let mut packet = vec![0u8; payload - XMP_NS.len()];
                f.read_exact(&mut packet).ok()?;
                return Some(packet);
            }
        }
        at = end;
        f.seek(SeekFrom::Start(at)).ok()?;
    }
}

/// The video's length from the XMP, in either form, or `None` when it names no motion.
fn video_length(x: &str) -> Option<u64> {
    if value(x, "GCamera:MotionPhoto").as_deref() == Some("1") {
        // Each Container:Item up to the next one: the one whose Semantic is MotionPhoto.
        for item in x.split("<Container:Item").skip(1) {
            if value(item, "Item:Semantic").as_deref() == Some("MotionPhoto") {
                return value(item, "Item:Length")?.parse().ok();
            }
        }
    }
    if value(x, "GCamera:MicroVideo").as_deref() == Some("1") {
        return value(x, "GCamera:MicroVideoOffset")?.parse().ok();
    }
    None
}

/// An XMP property's value, written as an attribute (`k="v"`) or as an element (`<k>v</k>`).
fn value(x: &str, key: &str) -> Option<String> {
    for quote in ['"', '\''] {
        let attr = format!("{key}={quote}");
        if let Some(at) = x.find(&attr) {
            let rest = &x[at + attr.len()..];
            return rest.find(quote).map(|end| rest[..end].trim().to_string());
        }
    }
    let open = format!("<{key}>");
    let at = x.find(&open)?;
    let rest = &x[at + open.len()..];
    rest.find('<').map(|end| rest[..end].trim().to_string())
}

#[cfg(test)]
#[path = "motion_tests.rs"]
pub(crate) mod tests;
