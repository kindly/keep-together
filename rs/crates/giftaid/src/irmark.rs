//! IRmark (HMRC "Generic IRmark specification" v1.2; "IRmark generation
//! step by step guide for Gateway protocol services" v2.0), as
//! `convex/giftaid/irmark.ts`:
//!
//!   1. take the `<Body>` element of the GovTalkMessage, inheriting the
//!      namespace declarations of `<GovTalkMessage>` onto `<Body>`;
//!   2. remove the `<IRmark>` element (keeping the whitespace around it);
//!   3. canonicalise (W3C C14N 1.0, without comments);
//!   4. SHA-1 → 20 bytes;
//!   5. base64 for the `<IRmark>` element (28 chars); base32 for display.
//!
//! We generate the submission XML ourselves in canonical form (attributes
//! sorted, text escaped per C14N, LF line ends), so steps 1–3 are string
//! operations rather than a full C14N implementation. Both HMRC-published
//! samples (`test/fixtures/hmrc`) hash correctly through this path.

use sha1::{Digest, Sha1};

const ENVELOPE_NS: &str = "http://www.govtalk.gov.uk/CM/envelope";

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("IRmark: {0}")]
pub struct IrmarkError(&'static str);

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The first `<name …>` start tag at or after `from` whose name is
/// exactly `name`: (start of `<`, the attributes text, end after `>`).
fn start_tag<'a>(text: &'a str, name: &str, from: usize) -> Option<(usize, &'a str, usize)> {
    let open = format!("<{name}");
    let mut at = from;
    while let Some(found) = text[at..].find(&open) {
        let start = at + found;
        let after = start + open.len();
        match text[after..].chars().next() {
            Some(c) if !is_word(c) && c != '-' && c != '.' && c != ':' => {
                let close = after + text[after..].find('>')?;
                return Some((start, &text[after..close], close + 1));
            }
            _ => at = after,
        }
    }
    None
}

/// The `xmlns` / `xmlns:prefix` declarations in a start tag's attributes.
fn namespace_declarations(attrs: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = attrs;
    while let Some(pos) = rest.find(char::is_whitespace) {
        let ws = rest[pos..].chars().next().map_or(1, char::len_utf8);
        rest = &rest[pos + ws..];
        let Some(tail) = rest.strip_prefix("xmlns") else {
            continue;
        };
        let (name_len, after) = match tail.strip_prefix(':') {
            Some(prefix) => {
                let n = prefix
                    .find(|c: char| !(is_word(c) || c == '.' || c == '-'))
                    .unwrap_or(prefix.len());
                if n == 0 {
                    continue;
                }
                ("xmlns:".len() + n, &prefix[n..])
            }
            None => ("xmlns".len(), tail),
        };
        let Some(value) = after.strip_prefix("=\"") else {
            continue;
        };
        let Some(end) = value.find('"') else {
            continue;
        };
        out.push((rest[..name_len].to_owned(), value[..end].to_owned()));
    }
    out
}

/// The canonical payload the IRmark is computed over.
pub fn canonical_payload(message: &str) -> Result<String, IrmarkError> {
    let text = message.replace("\r\n", "\n").replace('\r', "\n");
    let (_, attrs, _) =
        start_tag(&text, "GovTalkMessage", 0).ok_or(IrmarkError("no <GovTalkMessage> element"))?;
    let mut ns = namespace_declarations(attrs);
    if !ns.iter().any(|(name, _)| name == "xmlns") {
        ns.insert(0, ("xmlns".into(), ENVELOPE_NS.into()));
    }
    // C14N orders namespace declarations: default xmlns first, then by prefix.
    ns.sort_by(|(a, _), (b, _)| match (a == "xmlns", b == "xmlns") {
        (true, _) => std::cmp::Ordering::Less,
        (_, true) => std::cmp::Ordering::Greater,
        _ => a.cmp(b),
    });
    // `<Body>` or `<Body …>` (its own attributes dropped, as the Convex
    // version does); the inner text runs to the last `</Body>`.
    let (_, _, inner_start) =
        start_tag(&text, "Body", 0).ok_or(IrmarkError("no <Body> element"))?;
    let inner_end = text
        .rfind("</Body>")
        .filter(|&e| e >= inner_start)
        .ok_or(IrmarkError("no <Body> element"))?;
    let mut inner = text[inner_start..inner_end].to_owned();
    if let Some((start, _, open_end)) = start_tag(&inner, "IRmark", 0)
        && let Some(close) = inner[open_end..].find("</IRmark>")
    {
        inner.replace_range(start..open_end + close + "</IRmark>".len(), "");
    }
    let declarations: String = ns
        .iter()
        .map(|(name, value)| format!(" {name}=\"{value}\""))
        .collect();
    Ok(format!("<Body{declarations}>{inner}</Body>"))
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

pub fn base32(bytes: &[u8]) -> String {
    let mut out = String::new();
    let (mut bits, mut value) = (0u32, 0u32);
    for &byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(B32[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(B32[((value << (5 - bits)) & 31) as usize] as char);
    }
    while !out.len().is_multiple_of(8) {
        out.push('=');
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Irmark {
    /// 28 characters, goes in `<IRmark Type="generic">`.
    pub base64: String,
    /// 32 characters, shown to the user and printed on the claim.
    pub base32: String,
}

pub fn compute_irmark(message: &str) -> Result<Irmark, IrmarkError> {
    let digest = Sha1::digest(canonical_payload(message)?.as_bytes());
    Ok(Irmark {
        base64: base64(&digest),
        base32: base32(&digest),
    })
}

/// Insert (or replace) the IRmark in a message that already has the element.
pub fn stamp_irmark(message: &str) -> Result<(String, Irmark), IrmarkError> {
    let irmark = compute_irmark(message)?;
    let (_, _, open_end) = start_tag(message, "IRmark", 0)
        .ok_or(IrmarkError("message has no <IRmark> element to stamp"))?;
    let close = message[open_end..]
        .find("</IRmark>")
        .ok_or(IrmarkError("message has no <IRmark> element to stamp"))?;
    let mut stamped = message.to_owned();
    stamped.replace_range(open_end..open_end + close, &irmark.base64);
    Ok((stamped, irmark))
}

/// C14N text escaping for content we generate ourselves.
pub fn escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\r', "&#xD;")
}

pub fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
        .replace('\t', "&#x9;")
        .replace('\n', "&#xA;")
        .replace('\r', "&#xD;")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUBMISSION: &str =
        include_str!("../../../../test/fixtures/hmrc/irmarkexample-submission.xml");
    const CANONICALISED: &str =
        include_str!("../../../../test/fixtures/hmrc/irmarkexample-canonicalised.xml");
    const CLAIM: &str = include_str!("../../../../test/fixtures/hmrc/GAValidSample.xml");

    #[test]
    fn canonical_payload_matches_hmrcs_published_form_byte_for_byte() {
        assert_eq!(canonical_payload(SUBMISSION).unwrap(), CANONICALISED);
    }

    #[test]
    fn gateway_protocol_worked_example() {
        assert_eq!(
            compute_irmark(SUBMISSION).unwrap().base64,
            "RPfWtxHeCZRcwfitnIJmK9xc4OQ="
        );
    }

    #[test]
    fn charities_online_gift_aid_claim_sample() {
        let mark = compute_irmark(CLAIM).unwrap();
        assert_eq!(mark.base64, "nMs6zamBGcmT7n0selJHXuiQUEw=");
        assert_eq!(mark.base32.len(), 32);
    }

    #[test]
    fn stamping_replaces_the_element_content_and_is_idempotent() {
        let open = "<IRmark Type=\"generic\">";
        let start = CLAIM.find(open).unwrap() + open.len();
        let end = start + CLAIM[start..].find("</IRmark>").unwrap();
        let mut blank = CLAIM.to_owned();
        blank.replace_range(start..end, "");
        let (once, mark) = stamp_irmark(&blank).unwrap();
        assert_eq!(mark.base64, "nMs6zamBGcmT7n0selJHXuiQUEw=");
        assert_eq!(once, CLAIM);
        assert_eq!(stamp_irmark(&once).unwrap().0, CLAIM);
    }

    #[test]
    fn crlf_line_endings_normalise_to_lf_before_hashing() {
        let crlf = SUBMISSION.replace('\n', "\r\n");
        assert_eq!(
            compute_irmark(&crlf).unwrap().base64,
            "RPfWtxHeCZRcwfitnIJmK9xc4OQ="
        );
    }

    #[test]
    fn missing_elements_are_errors() {
        assert!(canonical_payload("<Body/>").is_err());
        assert!(canonical_payload("<GovTalkMessage></GovTalkMessage>").is_err());
        assert!(stamp_irmark(SUBMISSION.replace("IRmark", "Other").as_str()).is_err());
    }

    #[test]
    fn base64_and_base32_of_a_known_digest() {
        let bytes = b"foobar";
        assert_eq!(base64(bytes), "Zm9vYmFy");
        assert_eq!(base32(bytes), "MZXW6YTBOI======");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"f"), "Zg==");
    }

    #[test]
    fn escaping() {
        assert_eq!(escape_text("a<b>&\r"), "a&lt;b&gt;&amp;&#xD;");
        assert_eq!(escape_attribute("\"\t\n"), "&quot;&#x9;&#xA;");
    }
}
