//! Passwords: argon2id (the crate's defaults, OWASP's minimum: 19 MiB,
//! 2 passes), PHC strings in `auth_credentials.password_hash`.
//!
//! No enumeration: a sign-in for an unknown email verifies against
//! [`dummy_hash`], so it costs what a wrong password costs.

use std::sync::OnceLock;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;

use crate::AuthError;

pub const MIN_LEN: usize = 8;
/// Bounds the hashing work one request can ask for.
pub const MAX_LEN: usize = 256;

/// Why a new password is refused (ADR 0015 tier 1: unstorable).
pub fn problem(password: &str) -> Option<&'static str> {
    let n = password.chars().count();
    if n < MIN_LEN {
        Some("Password must be at least 8 characters.")
    } else if n > MAX_LEN {
        Some("Password must be at most 256 characters.")
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
    if password.chars().count() > MAX_LEN {
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
        assert!(problem("1234567").is_some());
        assert!(problem("12345678").is_none());
        assert!(problem(&"x".repeat(257)).is_some());
        // Characters, not bytes.
        assert!(problem("ééééééé").is_some());
    }
}
