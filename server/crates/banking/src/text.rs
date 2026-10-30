//! Bytes to text, and the whitespace rules every reader shares.

/// UTF-8 (a byte-order mark dropped), UTF-16 with its byte-order mark
/// (Excel's "Unicode text"), or else Windows-1252: what UK bank exports
/// are when they aren't UTF-8 (a `£` as one byte, 0xA3).
pub(crate) fn decode(bytes: &[u8]) -> String {
    let utf16 = |rest: &[u8], unit: fn([u8; 2]) -> u16| {
        let units = rest.chunks_exact(2).map(|c| unit([c[0], c[1]]));
        char::decode_utf16(units)
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect()
    };
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return utf16(rest, u16::from_be_bytes);
    }
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    }
}

fn windows_1252(b: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž',
        '\u{8F}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ',
        '\u{9D}', 'ž', 'Ÿ',
    ];
    match b {
        0x80..=0x9F => HIGH[usize::from(b - 0x80)],
        _ => char::from(b),
    }
}

/// Trimmed, with every whitespace run (Barclays pads its memo with tabs)
/// one space.
pub(crate) fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// [`clean`], or `None` when nothing is left.
pub(crate) fn non_empty(value: &str) -> Option<String> {
    Some(clean(value)).filter(|v| !v.is_empty())
}

/// The non-empty parts, cleaned, joined by one space.
pub(crate) fn join<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    parts
        .into_iter()
        .filter_map(non_empty)
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_with_a_bom_and_windows_1252_both_decode() {
        assert_eq!(decode(b"\xEF\xBB\xBFDate,\xC2\xA310"), "Date,£10");
        assert_eq!(decode(b"Date,\xA310 \x96 gift"), "Date,£10 – gift");
    }

    #[test]
    fn utf16_with_a_bom_decodes() {
        let le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("Date,£10".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        assert_eq!(decode(&le), "Date,£10");
        let be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("Date".encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        assert_eq!(decode(&be), "Date");
    }

    #[test]
    fn whitespace_runs_collapse() {
        assert_eq!(clean("  J SMITH\t\t  REF 100016 "), "J SMITH REF 100016");
        assert_eq!(non_empty(" \t "), None);
        assert_eq!(join(["A ", "", "  B"]), "A B");
    }
}
