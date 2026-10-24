//! Passwords: argon2id (the crate's defaults, OWASP's minimum: 19 MiB,
//! 2 passes), PHC strings in `auth_credentials.password_hash`.
//!
//! No enumeration: a sign-in for an unknown email verifies against
//! [`dummy_hash`], so it costs what a wrong password costs.
//!
//! A new password (S1 review M4, ASVS 2.1.1/2.1.7) has 12 to 128
//! characters and isn't on the NCSC's list of the 100,000 passwords most
//! often found in breaches (SecLists
//! `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`, MIT).
//! The bundled file `data/breached-12plus.txt` keeps only the list's
//! entries of 12 characters or more, lower-cased (1,257 of them): shorter
//! ones are refused by length anyway. Checked offline; no external call.

use std::collections::HashSet;
use std::sync::OnceLock;

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};

use crate::AuthError;

pub const MIN_LEN: usize = 12;
/// Bounds the hashing work one request can ask for (a new password; a
/// sign-in still verifies up to [`VERIFY_MAX_LEN`]).
pub const MAX_LEN: usize = 128;
/// The longest password a sign-in verifies (the old rule's maximum, so a
/// password set before M4 still signs in).
const VERIFY_MAX_LEN: usize = 256;

fn breached() -> &'static HashSet<&'static str> {
    static LIST: OnceLock<HashSet<&'static str>> = OnceLock::new();
    LIST.get_or_init(|| {
        include_str!("../data/breached-12plus.txt")
            .lines()
            .collect()
    })
}

/// Whether `password` is on the bundled breached list (any case).
pub fn is_breached(password: &str) -> bool {
    breached().contains(password.to_lowercase().as_str())
}

/// Why a new password is refused (ADR 0015 tier 1: unstorable).
pub fn problem(password: &str) -> Option<&'static str> {
    let n = password.chars().count();
    if n < MIN_LEN {
        Some("Password must be at least 12 characters.")
    } else if n > MAX_LEN {
        Some("Password must be at most 128 characters.")
    } else if is_breached(password) {
        Some("That password is on a list of passwords leaked in data breaches. Choose another.")
    } else {
        None
    }
}

pub fn hash(password: &str) -> Result<String, AuthError> {
    // 128-bit salt from the OS RNG.
    let salt = SaltString::encode_b64(&crate::secret::random_bytes(16))
        .map_err(|e| AuthError::Hash(e.to_string()))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| AuthError::Hash(e.to_string()))
}

/// Whether `password` matches the PHC string `stored`. A malformed stored
/// hash is a mismatch, never a panic.
pub fn verify(password: &str, stored: &str) -> bool {
    if password.chars().count() > VERIFY_MAX_LEN {
        // Still do the work: refusing early would time differently.
        let _ = verify("", dummy_hash());
        return false;
    }
    match PasswordHash::new(stored) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// A hash of a random password, made once per process: what an unknown
/// email is verified against.
pub fn dummy_hash() -> &'static str {
    static DUMMY: OnceLock<String> = OnceLock::new();
    DUMMY.get_or_init(|| hash(&crate::secret::token()).expect("argon2 with default params"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_verify_and_are_argon2id_with_a_salt() {
        let h = hash("correct horse").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify("correct horse", &h));
        assert!(!verify("Correct horse", &h));
        assert_ne!(h, hash("correct horse").unwrap(), "salted");
        assert!(!verify("x", "not a phc string"));
    }

    #[test]
    fn the_length_rule() {
        assert!(problem("12345678901").is_some());
        assert!(problem("kettle-orchard-7").is_none());
        assert!(problem(&"x".repeat(128)).is_none());
        assert!(problem(&"x".repeat(129)).is_some());
        // Characters, not bytes.
        assert!(problem("ééééééééééé").is_some());
        assert!(problem("éééééééééééé").is_none());
    }

    #[test]
    fn breached_passwords_are_refused_in_any_case() {
        assert_eq!(breached().len(), 1257);
        for p in [
            "password1234",
            "PASSWORD1234",
            "passwordpassword",
            "qwertyuiopasdfghjkl",
        ] {
            assert!(problem(p).is_some_and(|m| m.contains("breaches")), "{p}");
        }
        assert!(problem("kettle-orchard-7").is_none());
    }

    #[test]
    fn a_password_set_under_the_old_rule_still_verifies() {
        let long = "y".repeat(200);
        let h = hash(&long).unwrap();
        assert!(verify(&long, &h));
    }
}
