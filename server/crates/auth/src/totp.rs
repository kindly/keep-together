//! TOTP (RFC 6238: SHA-1, 6 digits, 30 s), one step of skew either way.
//! A code is accepted at most once: the matched step is stored
//! (`auth_credentials.totp_last_step`) and a step at or before it is
//! refused, so a code seen over a shoulder can't be replayed.

use qrcodegen::{QrCode, QrCodeEcc};
use totp_rs::{Algorithm, TOTP};

use crate::secret;

pub const STEP_SECS: u64 = 30;
const DIGITS: usize = 6;

/// A new secret: 160 bits (RFC 4226's recommendation), base32 without
/// padding, the form authenticator apps take.
pub fn new_secret() -> String {
    base32::encode(
        base32::Alphabet::Rfc4648 { padding: false },
        &secret::random_bytes(20),
    )
}

fn totp(secret_b32: &str) -> Option<TOTP> {
    let bytes = base32::decode(base32::Alphabet::Rfc4648 { padding: false }, secret_b32)?;
    Some(TOTP::new_unchecked(
        Algorithm::SHA1,
        DIGITS,
        1,
        STEP_SECS,
        bytes,
    ))
}

/// The code for `unix_secs` (tests and QC's test secret).
pub fn code_at(secret_b32: &str, unix_secs: u64) -> Option<String> {
    Some(totp(secret_b32)?.generate(unix_secs))
}

/// The step `code` matches at `unix_secs` (±1 step), if it is after
/// `last_step`. The caller stores the returned step.
pub fn verify(secret_b32: &str, code: &str, unix_secs: u64, last_step: i64) -> Option<i64> {
    let code = code.trim();
    if code.len() != DIGITS || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let t = totp(secret_b32)?;
    let now = (unix_secs / STEP_SECS) as i64;
    let mut found = None;
    // Check every candidate (no early exit), compare in constant time.
    for step in [now - 1, now, now + 1] {
        if step <= last_step || step < 0 {
            continue;
        }
        if secret::same(&t.generate(step as u64 * STEP_SECS), code) && found.is_none() {
            found = Some(step);
        }
    }
    found
}

/// The `otpauth://` URL an authenticator app scans.
pub fn url(secret_b32: &str, issuer: &str, account: &str) -> String {
    fn enc(s: &str) -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'@' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    }
    format!(
        "otpauth://totp/{}:{}?secret={secret_b32}&issuer={}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECS}",
        enc(issuer),
        enc(account),
        enc(issuer)
    )
}

/// `text` as a QR code, an SVG document (dark modules on white).
pub fn qr_svg(text: &str) -> String {
    let Ok(qr) = QrCode::encode_text(text, QrCodeEcc::Medium) else {
        return String::new();
    };
    let border = 4;
    let size = qr.size() + border * 2;
    let mut path = String::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{},{}h1v1h-1z", x + border, y + border));
            }
        }
    }
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="{path}" fill="#000"/></svg>"##
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_vector() {
        // RFC 6238 appendix B, SHA-1, T = 59 → 94287082 (8 digits); the
        // 6-digit code is its last six.
        let secret = base32::encode(
            base32::Alphabet::Rfc4648 { padding: false },
            b"12345678901234567890",
        );
        assert_eq!(code_at(&secret, 59).unwrap(), "287082");
    }

    #[test]
    fn a_code_is_accepted_once_and_within_one_step() {
        let s = new_secret();
        let t = 1_800_000_000;
        let code = code_at(&s, t).unwrap();
        let step = verify(&s, &code, t, 0).expect("current code");
        // Replay at the same step, or after it was used: refused.
        assert_eq!(verify(&s, &code, t, step), None);
        assert_eq!(verify(&s, &code, t + 30, step), None);
        // One step late is still fine the first time.
        assert!(verify(&s, &code, t + 30, 0).is_some());
        // Two steps late is not.
        assert_eq!(verify(&s, &code, t + 61, 0), None);
        assert_eq!(verify(&s, "12345", t, 0), None);
        assert_eq!(verify(&s, "abcdef", t, 0), None);
    }

    #[test]
    fn the_url_and_qr() {
        let u = url("ABC", "keep-together", "ann@example.org");
        assert!(u.starts_with("otpauth://totp/keep-together:ann@example.org?secret=ABC"));
        assert!(qr_svg(&u).starts_with("<svg"));
    }
}
