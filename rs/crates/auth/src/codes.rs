//! Emailed one-time codes and recovery codes.

use crate::secret;

/// A 6-digit code for email (the emailed second factor).
pub fn email_code() -> String {
    format!("{:06}", secret::below(1_000_000))
}

const RECOVERY_ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";

/// A recovery code: 10 characters from a 31-character alphabet without
/// look-alikes (≈ 50 bits), shown as `xxxxx-xxxxx`.
pub fn recovery_code() -> String {
    let mut out = String::with_capacity(11);
    for i in 0..10 {
        if i == 5 {
            out.push('-');
        }
        out.push(RECOVERY_ALPHABET[secret::below(RECOVERY_ALPHABET.len() as u32) as usize] as char);
    }
    out
}

/// A typed recovery code in its stored form's input: lower case, no
/// spaces or hyphens. `None` if it can't be one.
pub fn normalise_recovery(input: &str) -> Option<String> {
    let s: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .flat_map(char::to_lowercase)
        .collect();
    (s.len() == 10 && s.bytes().all(|b| RECOVERY_ALPHABET.contains(&b))).then_some(s)
}

/// Whether the input looks like a 6-digit code rather than a recovery code.
pub fn is_six_digits(input: &str) -> bool {
    let s = input.trim();
    s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes() {
        let c = email_code();
        assert!(is_six_digits(&c));
        let r = recovery_code();
        assert_eq!(r.len(), 11);
        assert_eq!(&r[5..6], "-");
        assert_eq!(
            normalise_recovery(&r.to_uppercase()).unwrap(),
            r.replace('-', "")
        );
        assert_eq!(
            normalise_recovery(" abcde fghjk ").as_deref(),
            Some("abcdefghjk")
        );
        assert_eq!(
            normalise_recovery("abcde-fghj1"),
            None,
            "1 isn't in the alphabet"
        );
    }
}
