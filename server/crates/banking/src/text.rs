//! Bytes to text, and the whitespace rules every reader shares.

/// UTF-8 (a byte-order mark dropped), or else Windows-1252: what UK bank
/// exports are when they aren't UTF-8 (a `£` as one byte, 0xA3).
pub(crate) fn decode(bytes: &[u8]) -> String {
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
    fn whitespace_runs_collapse() {
        assert_eq!(clean("  J SMITH\t\t  REF 100016 "), "J SMITH REF 100016");
        assert_eq!(non_empty(" \t "), None);
        assert_eq!(join(["A ", "", "  B"]), "A B");
    }
}
