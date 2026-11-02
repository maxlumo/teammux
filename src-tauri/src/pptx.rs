//! .pptx → HTML text extraction for file preview.
//!
//! A .pptx is a zip of XML parts. Everything the preview needs — slide order,
//! paragraph text, tables — is in `ppt/presentation.xml` and
//! `ppt/slides/slideN.xml`, so we read the zip and scan the XML directly
//! instead of shelling out to `python3` + `python-pptx`: that made previews
//! depend on a Python package nobody installs on the server machine (the
//! failure surfaced in the UI as a raw `ModuleNotFoundError` traceback).
//!
//! Deliberate limits: zip64 archives are rejected with a clear error rather
//! than mis-parsed (PowerPoint and every generator we've seen write plain
//! zip for decks under 4 GB), and only text/tables are extracted — images,
//! charts and layout are out of scope for a phone preview.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const EOCD_SIG: u32 = 0x0605_4b50;
const CDH_SIG: u32 = 0x0201_4b50;
const LFH_SIG: u32 = 0x0403_4b50;
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;
/// Per-part inflate cap. Slide XML is kilobytes; this only bounds memory
/// against a malformed or hostile archive.
const MAX_PART_SIZE: u64 = 16 * 1024 * 1024;

/// Render every slide of `path` as a sequence of HTML cards.
pub fn to_html(path: &Path) -> Result<String, String> {
    let mut zip = Zip::open(path)?;
    let mut out = String::new();
    for (i, name) in slide_order(&mut zip).iter().enumerate() {
        let xml = zip.read_part(name)?;
        out.push_str(&slide_html(&xml, i + 1));
    }
    Ok(out)
}

// ---------------------------------------------------------------- zip reading

struct Entry {
    name: String,
    method: u16,
    comp_size: u64,
    uncomp_size: u64,
    crc32: u32,
    offset: u64,
}

struct Zip {
    file: File,
    entries: Vec<Entry>,
}

impl Zip {
    fn open(path: &Path) -> Result<Zip, String> {
        let mut file = File::open(path).map_err(|e| format!("open: {}", e))?;
        let len = file.metadata().map_err(|e| format!("stat: {}", e))?.len();
        if len < 22 {
            return Err("not a .pptx file (too small)".into());
        }

        // End-of-central-directory record: 22 bytes plus an optional comment of
        // up to 64 KB, so it lives somewhere in the last ~64 KB.
        let tail_len = len.min(22 + 0xFFFF) as usize;
        let mut tail = vec![0u8; tail_len];
        file.seek(SeekFrom::Start(len - tail_len as u64))
            .and_then(|_| file.read_exact(&mut tail))
            .map_err(|e| format!("read: {}", e))?;
        let eocd = (0..=tail_len - 22)
            .rev()
            .find(|&i| u32le(&tail, i) == EOCD_SIG)
            .ok_or("not a .pptx file (no zip end record)")?;

        let count = u16le(&tail, eocd + 10) as usize;
        let cd_size = u32le(&tail, eocd + 12) as u64;
        let cd_offset = u32le(&tail, eocd + 16) as u64;
        if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
            return Err("zip64 .pptx is not supported".into());
        }
        if cd_offset + cd_size > len {
            return Err("corrupt .pptx (central directory out of range)".into());
        }

        let mut cd = vec![0u8; cd_size as usize];
        file.seek(SeekFrom::Start(cd_offset))
            .and_then(|_| file.read_exact(&mut cd))
            .map_err(|e| format!("read: {}", e))?;

        let mut entries = Vec::with_capacity(count);
        let mut pos = 0usize;
        while pos + 46 <= cd.len() && u32le(&cd, pos) == CDH_SIG {
            let nlen = u16le(&cd, pos + 28) as usize;
            let elen = u16le(&cd, pos + 30) as usize;
            let clen = u16le(&cd, pos + 32) as usize;
            if pos + 46 + nlen > cd.len() {
                break;
            }
            entries.push(Entry {
                name: String::from_utf8_lossy(&cd[pos + 46..pos + 46 + nlen]).into_owned(),
                method: u16le(&cd, pos + 10),
                crc32: u32le(&cd, pos + 16),
                comp_size: u32le(&cd, pos + 20) as u64,
                uncomp_size: u32le(&cd, pos + 24) as u64,
                offset: u32le(&cd, pos + 42) as u64,
            });
            pos += 46 + nlen + elen + clen;
        }
        if entries.is_empty() {
            return Err("not a .pptx file (empty zip)".into());
        }
        Ok(Zip { file, entries })
    }

    fn has(&self, name: &str) -> bool {
        self.entries.iter().any(|e| e.name == name)
    }

    /// Decompress one part as UTF-8 text.
    fn read_part(&mut self, name: &str) -> Result<String, String> {
        let idx = self
            .entries
            .iter()
            .position(|e| e.name == name)
            .ok_or_else(|| format!("missing part in .pptx: {}", name))?;
        let (method, comp_size, uncomp_size, crc32, offset) = {
            let e = &self.entries[idx];
            (e.method, e.comp_size, e.uncomp_size, e.crc32, e.offset)
        };
        if uncomp_size > MAX_PART_SIZE {
            return Err(format!("{} is too large to preview", name));
        }

        // The local header repeats the name/extra lengths; its sizes may be
        // zeroed (data descriptor), so only the central directory's are used.
        let mut lfh = [0u8; 30];
        self.file
            .seek(SeekFrom::Start(offset))
            .and_then(|_| self.file.read_exact(&mut lfh))
            .map_err(|e| format!("read: {}", e))?;
        if u32le(&lfh, 0) != LFH_SIG {
            return Err("corrupt .pptx (bad local header)".into());
        }
        let skip = u16le(&lfh, 26) as u64 + u16le(&lfh, 28) as u64;
        self.file
            .seek(SeekFrom::Start(offset + 30 + skip))
            .map_err(|e| format!("read: {}", e))?;

        let mut raw = Vec::new();
        let mut src = (&mut self.file).take(comp_size);
        let read_result = match method {
            METHOD_STORE => src.read_to_end(&mut raw),
            METHOD_DEFLATE => flate2::read::DeflateDecoder::new(src)
                .take(MAX_PART_SIZE)
                .read_to_end(&mut raw),
            m => return Err(format!("unsupported zip compression in .pptx: {}", m)),
        };
        read_result.map_err(|e| format!("{}: {}", name, e))?;

        let mut crc = flate2::Crc::new();
        crc.update(&raw);
        if crc.sum() != crc32 {
            return Err(format!("corrupt .pptx (checksum mismatch in {})", name));
        }
        Ok(String::from_utf8_lossy(&raw).into_owned())
    }
}

fn u16le(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

fn u32le(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}

// -------------------------------------------------------------- slide order

/// Slides in presentation order.
///
/// File names are not the order: PowerPoint keeps `slideN.xml` fixed when you
/// reorder or delete slides. `<p:sldIdLst>` in `ppt/presentation.xml` holds the
/// real sequence via relationship ids. If either part is unreadable we fall
/// back to a numeric sort of the slide parts, which is right for freshly
/// generated decks.
fn slide_order(zip: &mut Zip) -> Vec<String> {
    let ordered = (|| -> Option<Vec<String>> {
        let pres = zip.read_part("ppt/presentation.xml").ok()?;
        let rels = zip.read_part("ppt/_rels/presentation.xml.rels").ok()?;
        let list_start = pres.find("<p:sldIdLst")?;
        let list_end = pres[list_start..]
            .find("</p:sldIdLst>")
            .map(|e| list_start + e)?;
        let names: Vec<String> = attr_values(&pres[list_start..list_end], "r:id=\"")
            .into_iter()
            .filter_map(|rid| rel_target(&rels, &rid))
            .map(|target| resolve_rel("ppt", &target))
            .filter(|name| zip.has(name))
            .collect();
        if names.is_empty() {
            None
        } else {
            Some(names)
        }
    })();
    if let Some(names) = ordered {
        return names;
    }

    let mut fallback: Vec<(u32, String)> = zip
        .entries
        .iter()
        .filter(|e| e.name.starts_with("ppt/slides/slide") && e.name.ends_with(".xml"))
        .map(|e| {
            let digits: String = e.name["ppt/slides/slide".len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            (digits.parse().unwrap_or(u32::MAX), e.name.clone())
        })
        .collect();
    fallback.sort();
    fallback.into_iter().map(|(_, name)| name).collect()
}

/// Collect the values of every occurrence of `prefix` (an `attr="` literal).
fn attr_values(xml: &str, prefix: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(prefix) {
        rest = &rest[start + prefix.len()..];
        match rest.find('"') {
            Some(end) => {
                out.push(unescape_xml(&rest[..end]));
                rest = &rest[end + 1..];
            }
            None => break,
        }
    }
    out
}

/// `Target` of the `<Relationship>` whose `Id` is `rid`.
fn rel_target(rels: &str, rid: &str) -> Option<String> {
    let needle = format!("Id=\"{}\"", rid);
    let at = rels.find(&needle)?;
    // Stay inside this element: attributes may come in either order, so scan
    // the whole tag around the matched Id.
    let start = rels[..at].rfind('<')?;
    let end = rels[at..].find('>').map(|e| at + e)?;
    attr_values(&rels[start..end], "Target=\"").into_iter().next()
}

/// Resolve a relationship target against the part directory holding the rels.
fn resolve_rel(base: &str, target: &str) -> String {
    let mut parts: Vec<&str> = if let Some(abs) = target.strip_prefix('/') {
        abs.split('/').collect()
    } else {
        base.split('/').chain(target.split('/')).collect()
    };
    let mut normalized: Vec<&str> = Vec::with_capacity(parts.len());
    for part in parts.drain(..) {
        match part {
            "" | "." => {}
            ".." => {
                normalized.pop();
            }
            p => normalized.push(p),
        }
    }
    normalized.join("/")
}

// ------------------------------------------------------------ slide → HTML

/// One slide as an HTML card: paragraphs in document order, tables as tables.
///
/// DrawingML text lives in `<a:t>` runs grouped by `<a:p>` paragraphs, and
/// table cells (`<a:tc>`) contain paragraphs of their own — hence the single
/// scan with a "currently inside a cell" buffer rather than two passes.
fn slide_html(xml: &str, number: usize) -> String {
    let mut body = String::new();
    let mut para = String::new();
    let mut cell: Option<String> = None;
    let mut table_depth = 0usize;
    let mut in_text = false;

    let mut i = 0usize;
    while i < xml.len() {
        let Some(lt) = xml[i..].find('<').map(|o| i + o) else { break };
        if in_text && lt > i {
            para.push_str(&unescape_xml(&xml[i..lt]));
        }
        let Some(gt) = xml[lt..].find('>').map(|o| lt + o) else { break };
        let tag = &xml[lt + 1..gt];
        i = gt + 1;

        let closing = tag.starts_with('/');
        let self_closing = tag.ends_with('/');
        let name = tag
            .trim_start_matches('/')
            .split([' ', '\t', '\r', '\n', '/'])
            .next()
            .unwrap_or("");

        match name {
            "a:t" => in_text = !closing && !self_closing,
            "a:p" => {
                if closing {
                    flush_para(&mut para, &mut cell, &mut body);
                } else if !self_closing {
                    para.clear();
                }
            }
            "a:tbl" if !self_closing => {
                if closing {
                    table_depth = table_depth.saturating_sub(1);
                    if table_depth == 0 {
                        body.push_str("</table>");
                    }
                } else {
                    if table_depth == 0 {
                        body.push_str(
                            "<table border=1 cellpadding=4 style='border-collapse:collapse;margin:8px 0'>",
                        );
                    }
                    table_depth += 1;
                }
            }
            "a:tr" if table_depth > 0 && !self_closing => {
                body.push_str(if closing { "</tr>" } else { "<tr>" });
            }
            "a:tc" if table_depth > 0 && !self_closing => {
                if closing {
                    let text = cell.take().unwrap_or_default();
                    body.push_str(&format!("<td>{}</td>", escape_html(text.trim())));
                } else {
                    cell = Some(String::new());
                }
            }
            _ => {}
        }
    }
    // An unclosed table would leak into the next slide's card.
    for _ in 0..table_depth {
        body.push_str("</table>");
    }

    format!(
        "<div style='border:1px solid #ccc;border-radius:8px;padding:16px;margin:12px 0'><b>Slide {}</b><br>{}</div>",
        number, body
    )
}

fn flush_para(para: &mut String, cell: &mut Option<String>, body: &mut String) {
    let text = para.trim();
    if !text.is_empty() {
        match cell {
            Some(buf) => {
                if !buf.is_empty() {
                    buf.push(' ');
                }
                buf.push_str(text);
            }
            None => body.push_str(&format!("<p>{}</p>", escape_html(text))),
        }
    }
    para.clear();
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

fn unescape_xml(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(semi) = rest.find(';') else {
            break;
        };
        let entity = &rest[1..semi];
        match entity {
            "amp" => out.push('&'),
            "lt" => out.push('<'),
            "gt" => out.push('>'),
            "quot" => out.push('"'),
            "apos" => out.push('\''),
            e => {
                let code = e
                    .strip_prefix("#x")
                    .or_else(|| e.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| e.strip_prefix('#').and_then(|d| d.parse().ok()));
                match code.and_then(char::from_u32) {
                    Some(c) => out.push(c),
                    // Unknown entity: keep it verbatim rather than dropping text.
                    None => out.push_str(&rest[..=semi]),
                }
            }
        }
        rest = &rest[semi + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Minimal zip writer so the tests exercise the real reader (both
    /// compression methods) instead of a mocked archive.
    fn zip_bytes(parts: &[(&str, &str, u16)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, content, method) in parts {
            let raw = content.as_bytes();
            let mut crc = flate2::Crc::new();
            crc.update(raw);
            let data = match *method {
                METHOD_STORE => raw.to_vec(),
                METHOD_DEFLATE => {
                    let mut enc = flate2::write::DeflateEncoder::new(
                        Vec::new(),
                        flate2::Compression::default(),
                    );
                    enc.write_all(raw).unwrap();
                    enc.finish().unwrap()
                }
                m => panic!("unsupported method {}", m),
            };
            let offset = out.len() as u32;
            let mut header = Vec::new();
            header.extend_from_slice(&20u16.to_le_bytes()); // version needed
            header.extend_from_slice(&0u16.to_le_bytes()); // flags
            header.extend_from_slice(&method.to_le_bytes());
            header.extend_from_slice(&0u32.to_le_bytes()); // time+date
            header.extend_from_slice(&crc.sum().to_le_bytes());
            header.extend_from_slice(&(data.len() as u32).to_le_bytes());
            header.extend_from_slice(&(raw.len() as u32).to_le_bytes());
            header.extend_from_slice(&(name.len() as u16).to_le_bytes());
            header.extend_from_slice(&0u16.to_le_bytes()); // extra len

            out.extend_from_slice(&LFH_SIG.to_le_bytes());
            out.extend_from_slice(&header);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&data);

            central.extend_from_slice(&CDH_SIG.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes()); // version made by
            central.extend_from_slice(&header);
            central.extend_from_slice(&0u16.to_le_bytes()); // comment len
            central.extend_from_slice(&0u16.to_le_bytes()); // disk number
            central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        let count = parts.len() as u16;
        out.extend_from_slice(&central);
        out.extend_from_slice(&EOCD_SIG.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // disk number
        out.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // comment len
        out
    }

    fn write_temp(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = crate::config::test_scratch("tmm-pptx");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn slide(body: &str) -> String {
        format!(
            "<?xml version=\"1.0\"?><p:sld xmlns:a=\"a\" xmlns:p=\"p\"><p:cSld><p:spTree>{}</p:spTree></p:cSld></p:sld>",
            body
        )
    }

    fn text_shape(paragraphs: &[&str]) -> String {
        let body: String = paragraphs
            .iter()
            .map(|t| format!("<a:p><a:r><a:t>{}</a:t></a:r></a:p>", t))
            .collect();
        format!("<p:sp><p:txBody>{}</p:txBody></p:sp>", body)
    }

    #[test]
    fn extracts_paragraphs_in_presentation_order() {
        // sldIdLst points at slide2 first: file names are not the order.
        let pres = r#"<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>"#;
        let rels = r#"<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>"#;
        let s1 = slide(&text_shape(&["First file", "  "]));
        let s2 = slide(&text_shape(&["Second file"]));
        let bytes = zip_bytes(&[
            ("ppt/presentation.xml", pres, METHOD_DEFLATE),
            ("ppt/_rels/presentation.xml.rels", rels, METHOD_DEFLATE),
            ("ppt/slides/slide1.xml", &s1, METHOD_DEFLATE),
            ("ppt/slides/slide2.xml", &s2, METHOD_STORE),
        ]);
        let path = write_temp("tmm_pptx_order.pptx", &bytes);

        let html = to_html(&path).unwrap();
        assert!(html.contains("<b>Slide 1</b>"), "{}", html);
        assert!(html.contains("<b>Slide 2</b>"), "{}", html);
        let first = html.find("Second file").unwrap();
        let second = html.find("First file").unwrap();
        assert!(first < second, "presentation order not honored: {}", html);
        // Blank paragraphs are dropped, not rendered as empty <p>.
        assert!(!html.contains("<p></p>"), "{}", html);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn renders_tables_and_escapes_text() {
        let table = format!(
            "<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr>{}{}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
            "<a:tc><a:txBody><a:p><a:r><a:t>a &amp; b</a:t></a:r></a:p></a:txBody></a:tc>",
            "<a:tc><a:txBody><a:p><a:r><a:t>line1</a:t></a:r></a:p><a:p><a:r><a:t>line2</a:t></a:r></a:p></a:txBody></a:tc>"
        );
        // Real pptx XML always escapes markup in run text; the round trip must
        // unescape it and then re-escape for HTML.
        let s1 = slide(&format!("{}{}", text_shape(&["Title &lt;script&gt;"]), table));
        let bytes = zip_bytes(&[("ppt/slides/slide1.xml", &s1, METHOD_DEFLATE)]);
        let path = write_temp("tmm_pptx_table.pptx", &bytes);

        let html = to_html(&path).unwrap();
        // No presentation.xml → numeric fallback still finds the slide.
        assert!(html.contains("<b>Slide 1</b>"), "{}", html);
        assert!(html.contains("<p>Title &lt;script&gt;</p>"), "{}", html);
        assert!(html.contains("<td>a &amp; b</td>"), "{}", html);
        // Multiple paragraphs in one cell collapse to a single cell.
        assert!(html.contains("<td>line1 line2</td>"), "{}", html);
        assert_eq!(html.matches("<table").count(), 1, "{}", html);
        assert_eq!(html.matches("</table>").count(), 1, "{}", html);
        // Table text must not also appear as a loose paragraph.
        assert!(!html.contains("<p>line1</p>"), "{}", html);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn rejects_non_pptx_input() {
        let path = write_temp("tmm_pptx_bogus.pptx", b"not a zip at all");
        let err = to_html(&path).unwrap_err();
        assert!(err.contains("not a .pptx"), "{}", err);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn detects_corrupt_part() {
        let s1 = slide(&text_shape(&["hello"]));
        let mut bytes = zip_bytes(&[("ppt/slides/slide1.xml", &s1, METHOD_STORE)]);
        // Flip a byte inside the stored payload: CRC must catch it.
        let at = bytes
            .windows(5)
            .position(|w| w == b"hello")
            .expect("payload present");
        bytes[at] = b'j';
        let path = write_temp("tmm_pptx_corrupt.pptx", &bytes);
        let err = to_html(&path).unwrap_err();
        assert!(err.contains("checksum"), "{}", err);
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn resolves_relationship_targets() {
        assert_eq!(resolve_rel("ppt", "slides/slide1.xml"), "ppt/slides/slide1.xml");
        assert_eq!(resolve_rel("ppt", "../ppt/slides/slide2.xml"), "ppt/slides/slide2.xml");
        assert_eq!(resolve_rel("ppt", "/ppt/slides/slide3.xml"), "ppt/slides/slide3.xml");
    }

    #[test]
    fn unescapes_entities() {
        assert_eq!(unescape_xml("a &amp; b &#65;&#x42; &unknown;"), "a & b AB &unknown;");
    }
}
