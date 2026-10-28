//! Connection setup shared by org and platform files.

use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
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
    conn.busy_handler(Some(busy_poll))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if read_only {
        conn.pragma_update(None, "query_only", "ON")?;
        conn.authorizer(Some(reader_authorizer))?;
    }
    Ok(conn)
}

/// Wait for a lock another connection holds by polling every millisecond,
/// for up to `BUSY_TIMEOUT_MS`. SQLite's own busy timeout sleeps 1, 2, 5,
/// 10, … 100 ms between tries, so a writer kept waiting by Litestream's
/// checkpoint (its write lock, 150–250 ms) slept on to the next step:
/// waits measured 53, 178, 228, 328 ms, the steps' running totals.
fn busy_poll(tries: i32) -> bool {
    if tries as u32 >= BUSY_TIMEOUT_MS {
        return false;
    }
    std::thread::sleep(std::time::Duration::from_millis(1));
    true
}

/// Reader connections may not switch `query_only` (or the schema-trust
/// pragmas) back off; table-valued pragmas like `pragma_table_info(t)`
/// stay readable. Writes are refused by `query_only` itself.
fn reader_authorizer(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Pragma { pragma_name, .. }
            if ["query_only", "writable_schema", "trusted_schema"]
                .contains(&pragma_name.to_ascii_lowercase().as_str()) =>
        {
            Authorization::Deny
        }
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
        _ => Authorization::Allow,
    }
}

/// For SQL text from outside the code (`keep sql`): plain `SELECT`s only.
/// Reading tables and columns, calling functions and recursive CTEs are
/// allowed; every write, `ATTACH`, `PRAGMA` and transaction statement is
/// refused at prepare time.
pub fn read_only_authorizer(ctx: AuthContext<'_>) -> Authorization {
    match ctx.action {
        AuthAction::Select
        | AuthAction::Read { .. }
        | AuthAction::Function { .. }
        | AuthAction::Recursive => Authorization::Allow,
        _ => Authorization::Deny,
    }
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
