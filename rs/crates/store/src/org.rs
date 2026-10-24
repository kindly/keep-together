//! One organisation's file: a writer connection behind a mutex, a reader
//! pool, migrations on open.

use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use rusqlite_migration::Migrations;

use crate::conn::{self, ReaderPool};
use crate::{StoreError, TenantId};

/// The stamp every org file carries, outside the migrated schema, so a
/// file copied or renamed onto another tenant's name is refused on open.
const STAMP_TABLE: &str = "CREATE TABLE IF NOT EXISTS _org (tenant_id TEXT NOT NULL)";

pub struct OrgDb {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: ReaderPool,
}

impl OrgDb {
    pub(crate) fn create(
        path: &Path,
        id: &TenantId,
        migrations: &Migrations<'static>,
        readers: usize,
    ) -> Result<Self, StoreError> {
        if path.exists() {
            return Err(StoreError::WrongFile {
                path: path.to_path_buf(),
                expected: id.as_str().into(),
                found: "(an existing file)".into(),
            });
        }
        let conn = conn::open(path, true, false)?;
        conn.execute_batch(STAMP_TABLE)?;
        conn.execute("INSERT INTO _org (tenant_id) VALUES (?1)", [id.as_str()])?;
        drop(conn);
        Self::open(path, id, migrations, readers)
    }

    pub(crate) fn open(
        path: &Path,
        id: &TenantId,
        migrations: &Migrations<'static>,
        readers: usize,
    ) -> Result<Self, StoreError> {
        if !path.exists() {
            return Err(StoreError::MissingFile(path.to_path_buf()));
        }
        let mut writer = conn::open(path, false, false)?;
        let found: Option<String> = writer
            .query_row("SELECT tenant_id FROM _org", [], |r| r.get(0))
            .optional()
            .or_else(|_| Ok::<_, rusqlite::Error>(None))?;
        if found.as_deref() != Some(id.as_str()) {
            return Err(StoreError::WrongFile {
                path: path.to_path_buf(),
                expected: id.as_str().into(),
                found: found.unwrap_or_else(|| "(no stamp)".into()),
            });
        }
        migrations.to_latest(&mut writer)?;
        Ok(Self {
            path: path.to_path_buf(),
            writer: Mutex::new(writer),
            readers: ReaderPool::open(path, readers)?,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run `f` in a `BEGIN IMMEDIATE` transaction on the writer: commit on
    /// `Ok`, roll back on `Err` (or panic). Blocking: call from
    /// `spawn_blocking` in async code.
    pub fn write<T, E>(&self, f: impl FnOnce(&OrgTx) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let tx = OrgTx(conn.transaction_with_behavior(TransactionBehavior::Immediate)?);
        let out = f(&tx)?;
        tx.0.commit()?;
        Ok(out)
    }

    /// Run `f` in a read transaction on a pooled read-only connection: one
    /// consistent snapshot for all its queries. Blocking.
    pub fn read<T, E>(&self, f: impl FnOnce(&OrgRead) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        self.readers.with(|conn| {
            let tx = OrgRead(conn.transaction_with_behavior(TransactionBehavior::Deferred)?);
            let out = f(&tx)?;
            // Nothing to commit; ending the transaction releases the snapshot.
            tx.0.finish()?;
            Ok(out)
        })
    }
}

/// A write transaction on one organisation's file: everything a domain
/// write function can touch.
pub struct OrgTx<'a>(Transaction<'a>);

impl Deref for OrgTx<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.0
    }
}

/// A read snapshot of one organisation's file.
pub struct OrgRead<'a>(Transaction<'a>);

impl Deref for OrgRead<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.0
    }
}
