//! One organisation's file: a writer connection behind a mutex, a reader
//! pool, migrations on open, and the channel its committed changes are
//! published on.

use std::cell::RefCell;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior};
use rusqlite_migration::Migrations;
use tokio::sync::broadcast;

use crate::conn::{self, ReaderPool};
use crate::events::OrgEvent;
use crate::{StoreError, TenantId};

/// The stamp every org file carries, outside the migrated schema, so a
/// file copied or renamed onto another tenant's name is refused on open.
const STAMP_TABLE: &str = "CREATE TABLE IF NOT EXISTS _org (tenant_id TEXT NOT NULL)";

/// Events a subscriber may fall behind by before it is told it lagged
/// (and replays from `revisions`, or resets).
const EVENT_BUFFER: usize = 1024;

pub struct OrgDb {
    path: PathBuf,
    writer: Mutex<Connection>,
    readers: ReaderPool,
    events: broadcast::Sender<OrgEvent>,
}

/// Check the stamp on an open connection.
pub(crate) fn check_stamp(conn: &Connection, path: &Path, id: &TenantId) -> Result<(), StoreError> {
    let found: Option<String> = conn
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
    Ok(())
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

    /// Open a stamped file. Pending migrations run here too (a file that
    /// appeared after boot); at boot `Store::migrate_all` has already run
    /// them, with a copy first.
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
        check_stamp(&writer, path, id)?;
        migrations.to_latest(&mut writer)?;
        Ok(Self {
            path: path.to_path_buf(),
            writer: Mutex::new(writer),
            readers: ReaderPool::open(path, readers)?,
            events: broadcast::channel(EVENT_BUFFER).0,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Run `f` in a `BEGIN IMMEDIATE` transaction on the writer: commit on
    /// `Ok`, roll back on `Err` (or panic). After the commit, and before
    /// the writer is released (so events go out in commit order), every
    /// event `f` emitted is published. Blocking.
    ///
    /// The raw door to the file: domain code never gets here. It goes
    /// through `contracts::transact`, which wraps this transaction in a
    /// sealed `OrgTx` (see `contracts`).
    pub fn write_raw<T, E>(&self, f: impl FnOnce(&RawTx) -> Result<T, E>) -> Result<T, E>
    where
        E: From<rusqlite::Error>,
    {
        let mut conn = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        let raw = RawTx {
            tx: conn.transaction_with_behavior(TransactionBehavior::Immediate)?,
            events: RefCell::new(Vec::new()),
        };
        let out = f(&raw);
        // Whatever `f` did, the connection is writable again for the next
        // transaction (and for the rollback).
        let reset = raw.set_query_only(false);
        let out = out?;
        reset?;
        let RawTx { tx, events } = raw;
        tx.commit()?;
        for event in events.into_inner() {
            // No subscribers is fine.
            let _ = self.events.send(event);
        }
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

    /// Committed changes from now on, in commit order.
    pub fn subscribe(&self) -> broadcast::Receiver<OrgEvent> {
        self.events.subscribe()
    }
}

/// A write transaction on one organisation's file, with the events it
/// will publish if it commits. Only `contracts` (and this crate's tests)
/// use it; domain code gets `contracts::OrgTx`.
pub struct RawTx<'a> {
    tx: Transaction<'a>,
    events: RefCell<Vec<OrgEvent>>,
}

impl RawTx<'_> {
    pub fn conn(&self) -> &Connection {
        &self.tx
    }

    /// Publish `event` once this transaction commits; dropped on rollback.
    pub fn emit(&self, event: OrgEvent) {
        self.events.borrow_mut().push(event);
    }

    /// `PRAGMA query_only` on the writer, for the rest of this transaction
    /// (reset when it ends). `contracts` keeps it on except while a
    /// contract writes.
    pub fn set_query_only(&self, on: bool) -> rusqlite::Result<()> {
        self.tx
            .pragma_update(None, "query_only", if on { "ON" } else { "OFF" })
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
