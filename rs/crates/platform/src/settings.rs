//! Per-organisation secrets (`tenantSettings` on Convex): a webhook secret,
//! a provider key. Never an env var per organisation (CLAUDE.md), never
//! plaintext at rest: AES-256-GCM under one deployment key,
//! `KEEP_SETTINGS_KEY` (32 bytes, base64), with the setting's name as
//! associated data so a ciphertext can't be moved to another name.
//!
//! Stored in the org file, written through the `tenantSettings.value`
//! contract like any other org data. Its payload, and so its revisions,
//! carry only ciphertext. No feature reads one yet.

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use contracts::{
    Command, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Source, WriteTx, execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// Org schema step: the settings rows.
pub const MIGRATION: &str = "
CREATE TABLE tenant_settings (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
";

/// The deployment's settings key. Its `Debug` doesn't print it.
#[derive(Clone)]
pub struct SettingsKey(Key<Aes256Gcm>);

impl std::fmt::Debug for SettingsKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SettingsKey(..)")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("KEEP_SETTINGS_KEY is not set")]
    NoKey,
    #[error("KEEP_SETTINGS_KEY must be 32 bytes, base64")]
    BadKey,
    /// Wrong key, a tampered row, or a row moved to another name.
    #[error("setting {0:?} could not be decrypted")]
    Undecryptable(String),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl SettingsKey {
    /// From base64 of exactly 32 bytes.
    pub fn parse(b64: &str) -> Result<Self, SettingsError> {
        let raw = B64.decode(b64.trim()).map_err(|_| SettingsError::BadKey)?;
        if raw.len() != 32 {
            return Err(SettingsError::BadKey);
        }
        Ok(Self(*Key::<Aes256Gcm>::from_slice(&raw)))
    }

    /// `KEEP_SETTINGS_KEY`.
    pub fn from_env() -> Result<Self, SettingsError> {
        Self::parse(&std::env::var("KEEP_SETTINGS_KEY").map_err(|_| SettingsError::NoKey)?)
    }

    /// A fresh random key, base64 (for an operator generating one).
    pub fn generate() -> String {
        B64.encode(Aes256Gcm::generate_key(&mut OsRng))
    }

    fn seal(&self, name: &str, plaintext: &str) -> Sealed {
        let cipher = Aes256Gcm::new(&self.0);
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext.as_bytes(),
                    aad: name.as_bytes(),
                },
            )
            .expect("AES-GCM encryption of an in-memory string");
        Sealed {
            name: name.to_owned(),
            nonce: B64.encode(nonce),
            ciphertext: B64.encode(ciphertext),
        }
    }

    fn open(&self, sealed: &Sealed) -> Result<String, SettingsError> {
        let fail = || SettingsError::Undecryptable(sealed.name.clone());
        let nonce = B64.decode(&sealed.nonce).map_err(|_| fail())?;
        let ciphertext = B64.decode(&sealed.ciphertext).map_err(|_| fail())?;
        if nonce.len() != 12 {
            return Err(fail());
        }
        let plain = Aes256Gcm::new(&self.0)
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: sealed.name.as_bytes(),
                },
            )
            .map_err(|_| fail())?;
        String::from_utf8(plain).map_err(|_| fail())
    }
}

/// A setting as stored: the payload of `tenantSettings.value`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sealed {
    pub name: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub struct SettingContract;
pub static SETTING: SettingContract = SettingContract;

impl Contract for SettingContract {
    const NAME: &'static str = "tenantSettings.value";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "tenant_settings";
    const COUNTER: &'static str = "version";
    type Payload = Sealed;
    type State = Sealed;

    fn prepare(&self, p: Sealed) -> Result<Sealed, ContractError> {
        if p.name.trim().is_empty() || p.name.len() > 100 {
            return Err(ContractError::invalid("name", "1 to 100 characters"));
        }
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Sealed, ContractError> {
        Ok(tx.read().query_row(
            "SELECT name, nonce, ciphertext FROM tenant_settings WHERE id = ?1",
            [id],
            |r| {
                Ok(Sealed {
                    name: r.get(0)?,
                    nonce: r.get(1)?,
                    ciphertext: r.get(2)?,
                })
            },
        )?)
    }

    fn apply(
        &self,
        current: Option<&Sealed>,
        p: &Sealed,
        _: &Command,
    ) -> Result<Sealed, ContractError> {
        if let Some(current) = current
            && current.name != p.name
        {
            return Err(ContractError::rejected(
                "identity_immutable",
                "a setting's name cannot change",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&Sealed>,
        next: &Sealed,
    ) -> Result<(), ContractError> {
        if before.is_none() {
            tx.execute(
                "INSERT INTO tenant_settings (id, name, nonce, ciphertext) VALUES (?1, ?2, ?3, ?4)",
                params![id, next.name, next.nonce, next.ciphertext],
            )?;
        } else {
            tx.execute(
                "UPDATE tenant_settings SET nonce = ?2, ciphertext = ?3 WHERE id = ?1",
                params![id, next.nonce, next.ciphertext],
            )?;
        }
        Ok(())
    }
}

/// Set the organisation's secret `name` to `plaintext` (encrypted here;
/// only ciphertext reaches the file and its revision).
pub fn put(
    ctx: &Ctx,
    key: &SettingsKey,
    name: &str,
    plaintext: &str,
    source: Source,
) -> Result<Executed, ContractError> {
    let sealed = key.seal(name, plaintext);
    let id: Option<String> = ctx
        .tx
        .read()
        .query_row(
            "SELECT id FROM tenant_settings WHERE name = ?1",
            [name],
            |r| r.get(0),
        )
        .optional()?;
    match id {
        Some(id) => execute(ctx, &SETTING, sealed, Exec::update(&id, None, source)),
        None => execute(ctx, &SETTING, sealed, Exec::create(source)),
    }
}

/// The organisation's secret `name`, decrypted; `None` if unset.
pub fn get(
    conn: &Connection,
    key: &SettingsKey,
    name: &str,
) -> Result<Option<String>, SettingsError> {
    let sealed = conn
        .query_row(
            "SELECT name, nonce, ciphertext FROM tenant_settings WHERE name = ?1",
            [name],
            |r| {
                Ok(Sealed {
                    name: r.get(0)?,
                    nonce: r.get(1)?,
                    ciphertext: r.get(2)?,
                })
            },
        )
        .optional()?;
    sealed.map(|s| key.open(&s)).transpose()
}
