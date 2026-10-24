//! Random tokens and their stored form. Every token we hand out (session
//! cookie, invite link, reset link) is 32 bytes from the OS RNG, sent as
//! 64 hex characters; only its SHA-256 is stored, and lookups are by
//! that hash, so a leaked `platform.db` holds no usable token.

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// `n` bytes from the OS RNG.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("the OS random number generator");
    buf
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A new token: 256 random bits as 64 lower-case hex characters.
pub fn token() -> String {
    hex(&random_bytes(32))
}

/// The stored form of a token or code: SHA-256, hex.
pub fn hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

/// Whether `token` has a token's shape, so junk never reaches a lookup.
pub fn well_formed(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Constant-time equality, for codes compared in memory.
pub fn same(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// A uniformly random integer in `0..bound` (rejection sampling).
pub fn below(bound: u32) -> u32 {
    let zone = u32::MAX - (u32::MAX % bound);
    loop {
        let b = random_bytes(4);
        let v = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        if v < zone {
            return v % bound;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_256_bits_of_hex_and_never_repeat() {
        let a = token();
        let b = token();
        assert!(well_formed(&a) && well_formed(&b));
        assert_ne!(a, b);
        assert_eq!(hash(&a).len(), 64);
        assert_ne!(hash(&a), a);
        assert!(!well_formed("../etc"));
        assert!(!well_formed(&a.to_uppercase()));
    }

    #[test]
    fn below_stays_in_range() {
        for _ in 0..1000 {
            assert!(below(10) < 10);
        }
    }
}
