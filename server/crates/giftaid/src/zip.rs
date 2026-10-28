//! Just enough ZIP for an OpenDocument file: read every entry of HMRC's
//! schedule template, write a new archive with `mimetype` first and
//! stored (as ODF requires), the rest deflated. No zip64, no encryption:
//! neither template needs them.

use miniz_oxide::deflate::compress_to_vec;
use miniz_oxide::inflate::decompress_to_vec;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("zip: {0}")]
pub struct ZipError(&'static str);

/// One archive member.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub data: Vec<u8>,
}

fn u16_at(b: &[u8], at: usize) -> Result<u16, ZipError> {
    b.get(at..at + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or(ZipError("truncated"))
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, ZipError> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or(ZipError("truncated"))
}

/// Every member, in central-directory order, inflated.
pub fn read(archive: &[u8]) -> Result<Vec<Entry>, ZipError> {
    let end = (0..archive.len().saturating_sub(21))
        .rev()
        .find(|&i| archive[i..].starts_with(&[0x50, 0x4b, 0x05, 0x06]))
        .ok_or(ZipError("no end of central directory"))?;
    let count = u16_at(archive, end + 10)? as usize;
    let mut at = u32_at(archive, end + 16)? as usize;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        if u32_at(archive, at)? != 0x0201_4b50 {
            return Err(ZipError("bad central directory entry"));
        }
        let method = u16_at(archive, at + 10)?;
        let crc = u32_at(archive, at + 16)?;
        let compressed = u32_at(archive, at + 20)? as usize;
        let name_len = u16_at(archive, at + 28)? as usize;
        let extra_len = u16_at(archive, at + 30)? as usize;
        let comment_len = u16_at(archive, at + 32)? as usize;
        let local = u32_at(archive, at + 42)? as usize;
        let name = archive
            .get(at + 46..at + 46 + name_len)
            .ok_or(ZipError("truncated"))?;
        let name = String::from_utf8(name.to_vec()).map_err(|_| ZipError("name not UTF-8"))?;
        at += 46 + name_len + extra_len + comment_len;

        if u32_at(archive, local)? != 0x0403_4b50 {
            return Err(ZipError("bad local header"));
        }
        let start = local
            + 30
            + u16_at(archive, local + 26)? as usize
            + u16_at(archive, local + 28)? as usize;
        let raw = archive
            .get(start..start + compressed)
            .ok_or(ZipError("truncated"))?;
        let data = match method {
            0 => raw.to_vec(),
            8 => decompress_to_vec(raw).map_err(|_| ZipError("bad deflate data"))?,
            _ => return Err(ZipError("unsupported compression")),
        };
        if crc32(&data) != crc {
            return Err(ZipError("checksum mismatch"));
        }
        out.push(Entry { name, data });
    }
    Ok(out)
}

/// An archive of `entries` in order: `mimetype` stored, the rest
/// deflated (directories, names ending `/`, stored and empty). A fixed
/// DOS time (1 Jan 1980) so the same input gives the same bytes.
pub fn write(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for e in entries {
        let stored = e.name == "mimetype" || e.name.ends_with('/') || e.data.is_empty();
        let body = if stored {
            e.data.clone()
        } else {
            compress_to_vec(&e.data, 6)
        };
        let method: u16 = if stored { 0 } else { 8 };
        let crc = crc32(&e.data);
        let offset = out.len() as u32;
        let name = e.name.as_bytes();
        let header = |sig: u32, central: bool| {
            let mut h = Vec::new();
            h.extend_from_slice(&sig.to_le_bytes());
            if central {
                h.extend_from_slice(&20u16.to_le_bytes()); // made by
            }
            h.extend_from_slice(&20u16.to_le_bytes()); // needed to extract
            h.extend_from_slice(&0u16.to_le_bytes()); // flags
            h.extend_from_slice(&method.to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // time
            h.extend_from_slice(&0x21u16.to_le_bytes()); // date: 1980-01-01
            h.extend_from_slice(&crc.to_le_bytes());
            h.extend_from_slice(&(body.len() as u32).to_le_bytes());
            h.extend_from_slice(&(e.data.len() as u32).to_le_bytes());
            h.extend_from_slice(&(name.len() as u16).to_le_bytes());
            h.extend_from_slice(&0u16.to_le_bytes()); // extra
            if central {
                h.extend_from_slice(&0u16.to_le_bytes()); // comment
                h.extend_from_slice(&0u16.to_le_bytes()); // disk
                h.extend_from_slice(&0u16.to_le_bytes()); // internal attributes
                h.extend_from_slice(&0u32.to_le_bytes()); // external attributes
                h.extend_from_slice(&offset.to_le_bytes());
            }
            h.extend_from_slice(name);
            h
        };
        out.extend(header(0x0403_4b50, false));
        out.extend_from_slice(&body);
        central.extend(header(0x0201_4b50, true));
    }
    let central_at = out.len() as u32;
    let central_len = central.len() as u32;
    out.extend(central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]); // disk numbers
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&central_len.to_le_bytes());
    out.extend_from_slice(&central_at.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// CRC-32 (IEEE 802.3), as ZIP stores it.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc ^= u32::from(b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xEDB8_8320 & (crc & 1).wrapping_neg());
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_of_a_known_string() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn what_is_written_reads_back() {
        let entries = vec![
            Entry {
                name: "mimetype".into(),
                data: b"application/vnd.oasis.opendocument.spreadsheet".to_vec(),
            },
            Entry {
                name: "Configurations2/".into(),
                data: vec![],
            },
            Entry {
                name: "content.xml".into(),
                data: "<x>".repeat(1000).into_bytes(),
            },
        ];
        let archive = write(&entries);
        assert_eq!(read(&archive).unwrap(), entries);
        // ODF: `mimetype` first, stored, at offset 38 its bytes.
        assert_eq!(&archive[30..38], b"mimetype");
        assert_eq!(&archive[38..84], entries[0].data.as_slice());
    }
}
