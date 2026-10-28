//! The server-side secrets auth needs so that a copy of `platform.db` (a
//! Litestream replica, a snapshot) gives nothing usable (S1 review M2):
//!
//! - TOTP secrets (enrolled and being enrolled) are AES-256-GCM under
//!   `KEEP_SETTINGS_KEY`, the scheme of A3's tenant settings
//!   (`platform::settings`), with the user as associated data, so a
//!   ciphertext can't be moved to another user.
//! - Recovery codes and emailed codes are stored as HMAC-SHA256 under
//!   `KEEP_AUTH_PEPPER`, a secret that is never in the database, so the
//!   stored form can't be brute-forced offline.
//!
//! Both come from the env; a deployed environment refuses to boot without
//! them (`api::auth::boot`). Local dev and tests use [`Keys::dev`].

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hmac::{Hmac, Mac};
use platform::settings::{Sealed, SettingsKey};
use rusqlite::{Connection, params};
use sha2::Sha256;

/// The stored form of a sealed secret starts with this.
const SEALED: &str = "v1:";

#[derive(Clone)]
pub struct Keys {
    seal: SettingsKey,
    pepper: Vec<u8>,
}

impl std::fmt::Debug for Keys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Keys(..)")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeyError {
    #[error("KEEP_SETTINGS_KEY must be 32 bytes, base64")]
    SettingsKey,
    #[error("KEEP_AUTH_PEPPER must be at least 32 bytes, base64")]
    Pepper,
}

impl Keys {
    /// From `KEEP_SETTINGS_KEY` (32 bytes, base64) and `KEEP_AUTH_PEPPER`
    /// (at least 32 bytes, base64).
    pub fn parse(settings_key: &str, pepper: &str) -> Result<Self, KeyError> {
        let seal = SettingsKey::parse(settings_key).map_err(|_| KeyError::SettingsKey)?;
        let pepper = B64.decode(pepper.trim()).map_err(|_| KeyError::Pepper)?;
        if pepper.len() < 32 {
            return Err(KeyError::Pepper);
        }
        Ok(Self { seal, pepper })
    }

    /// Fixed, published keys for local dev and tests. Never for real data:
    /// a deployed environment can't boot with them.
    pub fn dev() -> Self {
        Self::parse(&B64.encode([7u8; 32]), &B64.encode([11u8; 32])).expect("dev keys")
    }

    /// A fresh random value for either variable (an operator setting up).
    pub fn generate() -> String {
        B64.encode(crate::secret::random_bytes(32))
    }

    /// The `KEEP_SETTINGS_KEY` itself, for an organisation's secrets
    /// (`platform::settings`: a GoCardless access token).
    pub fn settings_key(&self) -> &SettingsKey {
        &self.seal
    }

    /// `plaintext` sealed for `aad` (e.g. `totp:<user>`), as stored.
    pub fn seal(&self, aad: &str, plaintext: &str) -> String {
        let s = self.seal.seal(aad, plaintext);
        format!("{SEALED}{}:{}", s.nonce, s.ciphertext)
    }

    /// The plaintext of a stored value sealed for `aad`. `None` for a
    /// wrong key, a tampered or moved value, or one never sealed: fail
    /// closed.
    pub fn open(&self, aad: &str, stored: &str) -> Option<String> {
        let (nonce, ciphertext) = stored.strip_prefix(SEALED)?.split_once(':')?;
        self.seal
            .open(&Sealed {
                name: aad.into(),
                nonce: nonce.into(),
                ciphertext: ciphertext.into(),
            })
            .ok()
    }

    /// The stored form of a short secret (a code): HMAC-SHA256 under the
    /// pepper over `purpose` and `value`, hex.
    pub fn mac(&self, purpose: &str, value: &str) -> String {
        let mut m = Hmac::<Sha256>::new_from_slice(&self.pepper).expect("HMAC takes any key");
        m.update(purpose.as_bytes());
        m.update(&[0]);
        m.update(value.as_bytes());
        m.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

/// Associated data for a user's TOTP secret, enrolled or pending.
pub fn totp_aad(user: i64) -> String {
    format!("totp:{user}")
}

/// Seal every TOTP secret still stored in plaintext (written before auth
/// schema step 3). Run at boot, after the store's migrations (and so after
/// its pre-migration copy); idempotent. Returns how many were sealed.
pub fn seal_plaintext_secrets(conn: &Connection, keys: &Keys) -> rusqlite::Result<usize> {
    let rows: Vec<(i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT user_id, totp_secret FROM auth_credentials
             WHERE totp_secret IS NOT NULL AND totp_secret NOT LIKE 'v1:%'",
        )?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    for (user, plain) in &rows {
        conn.execute(
            "UPDATE auth_credentials SET totp_secret = ?2 WHERE user_id = ?1",
            params![user, keys.seal(&totp_aad(*user), plain)],
        )?;
    }
    Ok(rows.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_values_open_only_for_their_user_and_key() {
        let k = Keys::dev();
        let stored = k.seal(&totp_aad(1), "JBSWY3DPEHPK3PXP");
        assert!(stored.starts_with("v1:"));
        assert!(!stored.contains("JBSWY3DPEHPK3PXP"));
        assert_eq!(
            k.open(&totp_aad(1), &stored).as_deref(),
            Some("JBSWY3DPEHPK3PXP")
        );
        assert_eq!(k.open(&totp_aad(2), &stored), None, "moved to another user");
        let other = Keys::parse(&Keys::generate(), &Keys::generate()).unwrap();
        assert_eq!(other.open(&totp_aad(1), &stored), None, "another key");
        assert_eq!(k.open(&totp_aad(1), "JBSWY3DPEHPK3PXP"), None, "plaintext");
    }

    #[test]
    fn macs_depend_on_the_pepper_and_the_purpose() {
        let k = Keys::dev();
        let other = Keys::parse(&Keys::generate(), &Keys::generate()).unwrap();
        assert_eq!(k.mac("recovery", "abc"), k.mac("recovery", "abc"));
        assert_ne!(k.mac("recovery", "abc"), other.mac("recovery", "abc"));
        assert_ne!(k.mac("recovery", "abc"), k.mac("email", "abc"));
        assert_ne!(k.mac("recovery", "abc"), crate::secret::hash("abc"));
    }

    #[test]
    fn bad_keys_are_refused() {
        assert!(Keys::parse("short", &Keys::generate()).is_err());
        assert!(Keys::parse(&Keys::generate(), &B64.encode([1u8; 16])).is_err());
        assert_eq!(format!("{:?}", Keys::dev()), "Keys(..)");
    }
}
