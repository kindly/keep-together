//! One organisation's files db: `files/<tenant-id>.db`, beside its org
//! file (plan `declaration-scans.sv`, g1q1). Scanned pages (and, later,
//! other immutable files) as blobs, content-addressed by SHA-256.
//!
//! - **Per organisation.** Stamped with the tenant id like an org file
//!   (`_files`), refused on open if the stamp is another's; the same bytes
//!   in two organisations are two rows in two files. Only this crate opens
//!   it, through the org's own handle ([`crate::OrgDb::files`]), so it
//!   lives and closes with the org's LRU slot.
//! - **Immutable.** A blob is put once and never changed: outside
//!   contracts and revisions (ADR 0024 amendment). The org file's rows
//!   (`declaration_scan_pages`) say which blobs are wanted; there is no
//!   transaction across the two files. A write puts the blob first, then
//!   commits the row; a deletion commits the row first, then the blob goes
//!   ([`FilesDb::delete_unreferenced`], which never touches a blob put in
//!   the last `put_before`).
//! - **Capped.** [`CAP_BYTES`] per organisation: a put that would pass it
//!   is refused ([`FilesError::Full`]); a blob already held never is.
//! - **Created lazily**, at the first put: an organisation that never
//!   scanned has no files db, and reads find nothing.
//! - **Its own migrations** ([`migrations`]), append-only, run on open.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use rusqlite_migration::{M, Migrations};
use sha2::{Digest, Sha256};

use crate::conn::{self, ReaderPool};
use crate::{StoreError, TenantId};

/// At most this many bytes of blobs per organisation (g1q7): 2 GB.
pub const CAP_BYTES: i64 = 2_000_000_000;

/// The stamp, outside the migrated schema (as `_org` on an org file).
const STAMP_TABLE: &str = "CREATE TABLE IF NOT EXISTS _files (tenant_id TEXT NOT NULL)";

/// The files db's schema. Append-only, like the org schema.
pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![
        // 1: blobs, and the change counter the snapshot job reads (a files
        // db has no revisions to tell it something moved).
        M::up(
            "CREATE TABLE blobs (
                sha256 TEXT PRIMARY KEY,
                bytes BLOB NOT NULL,
                content_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                last_put_at INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE changes (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                seq INTEGER NOT NULL
            ) STRICT;
            INSERT INTO changes (id, seq) VALUES (1, 0);",
        ),
    ])
}

#[derive(Debug, thiserror::Error)]
pub enum FilesError {
    #[error(transparent)]
    Store(#[from] StoreError),
    /// The organisation's files db would pass [`CAP_BYTES`].
    #[error("the organisation's files are at their cap ({used} of {cap} bytes)")]
    Full { used: i64, cap: i64 },
}

impl From<rusqlite::Error> for FilesError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Store(e.into())
    }
}

/// What [`FilesDb::put`] stored (or found).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Put {
    /// Lower-case hex.
    pub sha256: String,
    pub size: i64,
    /// False if the blob was already there.
    pub new: bool,
}

#[derive(Clone, Debug)]
pub struct Blob {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// The SHA-256 of `bytes`, lower-case hex: a blob's key.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A blob key: 64 lower-case hex characters. Anything else is never
/// looked up.
pub fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub struct FilesDb {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: ReaderPool,
}

impl FilesDb {
    /// Open `path` for tenant `id`, creating and stamping it if `create`
    /// and it isn't there (`MissingFile` otherwise). Migrates.
    pub(crate) fn open(
        path: &Path,
        id: &TenantId,
        create: bool,
        readers: usize,
    ) -> Result<Self, StoreError> {
        if !path.exists() {
            if !create {
                return Err(StoreError::MissingFile(path.to_path_buf()));
            }
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            // Made under a temporary name and renamed into place, so a
            // crash mid-create never leaves an unstamped file that every
            // later open would refuse.
            let tmp = path.with_extension("db.creating");
            crate::remove_db_files(&tmp);
            {
                let conn = conn::open(&tmp, true, false)?;
                conn.execute_batch(STAMP_TABLE)?;
                conn.execute("INSERT INTO _files (tenant_id) VALUES (?1)", [id.as_str()])?;
                // Out of WAL, so the rename moves one complete file.
                conn.pragma_update(None, "journal_mode", "DELETE")?;
            }
            std::fs::rename(&tmp, path)?;
        }
        let mut writer = conn::open(path, false, false)?;
        check_stamp(&writer, path, id)?;
        migrations().to_latest(&mut writer)?;
        Ok(Self {
            path: path.to_path_buf(),
            writer: Mutex::new(writer),
            readers: ReaderPool::open(path, readers.min(2))?,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Store `bytes` under their SHA-256, unless already held. Refused
    /// with [`FilesError::Full`] if a new blob would take the file past
    /// `cap`. Idempotent: putting the same bytes again stores nothing new
    /// but marks the blob as just put, so a sweep running beside the
    /// write that will reference it keeps it.
    pub fn put(
        &self,
        bytes: &[u8],
        content_type: &str,
        now: i64,
        cap: i64,
    ) -> Result<Put, FilesError> {
        let sha256 = sha256_hex(bytes);
        let size = bytes.len() as i64;
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let held = tx.execute(
            "UPDATE blobs SET last_put_at = max(last_put_at, ?2) WHERE sha256 = ?1",
            params![sha256, now],
        )? == 1;
        if held {
            tx.commit()?;
            return Ok(Put {
                sha256,
                size,
                new: false,
            });
        }
        let used: i64 =
            tx.query_row("SELECT coalesce(sum(size), 0) FROM blobs", [], |r| r.get(0))?;
        if used + size > cap {
            return Err(FilesError::Full { used, cap });
        }
        tx.execute(
            "INSERT INTO blobs (sha256, bytes, content_type, size, created_at, last_put_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![sha256, bytes, content_type, size, now],
        )?;
        tx.execute("UPDATE changes SET seq = seq + 1 WHERE id = 1", [])?;
        tx.commit()?;
        Ok(Put {
            sha256,
            size,
            new: true,
        })
    }

    /// One blob, or `None` (never held, or deleted).
    pub fn get(&self, sha256: &str) -> Result<Option<Blob>, StoreError> {
        if !is_sha256(sha256) {
            return Ok(None);
        }
        Ok(self.readers.with(|conn| {
            conn.query_row(
                "SELECT bytes, content_type FROM blobs WHERE sha256 = ?1",
                [sha256],
                |r| {
                    Ok(Blob {
                        bytes: r.get(0)?,
                        content_type: r.get(1)?,
                    })
                },
            )
            .optional()
        })?)
    }

    /// Bytes of blobs held (what [`CAP_BYTES`] counts).
    pub fn usage(&self) -> Result<i64, StoreError> {
        Ok(self.readers.with(|conn| {
            conn.query_row("SELECT coalesce(sum(size), 0) FROM blobs", [], |r| r.get(0))
        })?)
    }

    /// Delete every blob not in `referenced` and not put since
    /// `put_before` (ms): orphans of a write whose contract was refused,
    /// and blobs whose last reference went. The grace keeps a blob
    /// that a write in flight has put and not yet committed a row for.
    /// `referenced` is read from the org file before this is called; the
    /// grace covers a reference committed after that read. Returns the
    /// deleted keys.
    pub fn delete_unreferenced(
        &self,
        referenced: &HashSet<String>,
        put_before: i64,
    ) -> Result<Vec<String>, StoreError> {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidates: Vec<String> = tx
            .prepare("SELECT sha256 FROM blobs WHERE last_put_at < ?1 ORDER BY sha256")?
            .query_map([put_before], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let gone: Vec<String> = candidates
            .into_iter()
            .filter(|sha| !referenced.contains(sha))
            .collect();
        for sha in &gone {
            tx.execute("DELETE FROM blobs WHERE sha256 = ?1", [sha])?;
        }
        if !gone.is_empty() {
            tx.execute("UPDATE changes SET seq = seq + 1 WHERE id = 1", [])?;
        }
        tx.commit()?;
        Ok(gone)
    }

    /// The change counter: moves with every blob added or deleted (the
    /// snapshot job's "did it change").
    pub fn changes(&self) -> Result<i64, StoreError> {
        Ok(self.readers.with(|conn| {
            conn.query_row("SELECT seq FROM changes WHERE id = 1", [], |r| r.get(0))
        })?)
    }
}

fn check_stamp(conn: &Connection, path: &Path, id: &TenantId) -> Result<(), StoreError> {
    let found: Option<String> = conn
        .query_row("SELECT tenant_id FROM _files", [], |r| r.get(0))
        .optional()
        .or_else(|_| Ok::<_, rusqlite::Error>(None))?;
    if found.as_deref() != Some(id.as_str()) {
        return Err(StoreError::WrongFile {
            path: path.to_path_buf(),
            expected: id.as_str().into(),
            found: found.unwrap_or_else(|| "(no stamp)".into()),
        });
    }
    Ok(())
}
