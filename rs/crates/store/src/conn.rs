//! Connection setup shared by org and platform files.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::limits::Limit;
use rusqlite::{Connection, OpenFlags};

pub(crate) const BUSY_TIMEOUT_MS: u32 = 5_000;

/// Open one connection with the project's pragmas. No connection may
/// ATTACH another file: that would let a handler holding one org's
/// connection read another org's file.
pub(crate) fn open(path: &Path, create: bool, read_only: bool) -> rusqlite::Result<Connection> {
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let conn = Connection::open_with_flags(path, flags)?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
    conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS.into()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if read_only {
        conn.pragma_update(None, "query_only", "ON")?;
    }
    Ok(conn)
}

/// A fixed set of read-only connections. A reader takes the first free
/// one, or waits on one picked round-robin.
pub(crate) struct ReaderPool {
    conns: Vec<Mutex<Connection>>,
    next: AtomicUsize,
}

impl ReaderPool {
    pub(crate) fn open(path: &Path, size: usize) -> rusqlite::Result<Self> {
        let conns = (0..size.max(1))
            .map(|_| open(path, false, true).map(Mutex::new))
            .collect::<rusqlite::Result<_>>()?;
        Ok(Self {
            conns,
            next: AtomicUsize::new(0),
        })
    }

    pub(crate) fn with<T>(&self, f: impl FnOnce(&mut Connection) -> T) -> T {
        for conn in &self.conns {
            if let Ok(mut guard) = conn.try_lock() {
                return f(&mut guard);
            }
        }
        let i = self.next.fetch_add(1, Ordering::Relaxed) % self.conns.len();
        f(&mut self.conns[i].lock().unwrap())
    }
}
