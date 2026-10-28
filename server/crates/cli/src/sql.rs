//! `keep sql <slug> "<select…>"`: read-only SQL on one organisation's file,
//! safe by construction for SQL text from anywhere (an agent, a report):
//!
//! - the file is opened `SQLITE_OPEN_READ_ONLY` with `query_only` on;
//! - an authorizer allows only `SELECT`, reading columns, functions and
//!   recursive CTEs, so every write, `ATTACH`, `PRAGMA` and transaction
//!   statement fails at prepare time (`ATTACH` is also limited to 0);
//! - one statement only;
//! - a progress handler interrupts after [`TIMEOUT`].
//!
//! Output is CSV (a header row, then rows), or JSON objects with `--json`.

use std::path::Path;
use std::time::{Duration, Instant};

use rusqlite::limits::Limit;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};

pub const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Csv,
    Json,
}

#[derive(Debug)]
pub enum SqlError {
    UnknownOrg(String),
    Sqlite(rusqlite::Error),
    NotReadOnly,
}

impl std::fmt::Display for SqlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SqlError::UnknownOrg(slug) => write!(f, "no organisation {slug:?}"),
            SqlError::Sqlite(e) => write!(f, "{e}"),
            SqlError::NotReadOnly => write!(f, "only a read-only SELECT is allowed"),
        }
    }
}

impl std::error::Error for SqlError {}

impl From<rusqlite::Error> for SqlError {
    fn from(e: rusqlite::Error) -> Self {
        SqlError::Sqlite(e)
    }
}

fn read_only(path: &Path) -> rusqlite::Result<Connection> {
    Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
}

/// The org file for `slug`, from `platform.db` (read-only too).
fn org_file(data: &Path, slug: &str) -> Result<std::path::PathBuf, SqlError> {
    let platform = read_only(&data.join("platform.db"))?;
    let id: Option<String> = platform
        .query_row("SELECT id FROM tenants WHERE slug = ?1", [slug], |r| {
            r.get(0)
        })
        .optional()?;
    let id = id
        .filter(|id| id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        .ok_or_else(|| SqlError::UnknownOrg(slug.into()))?;
    Ok(data.join("orgs").join(format!("{id}.db")))
}

/// Open one org's file for untrusted SQL.
pub fn open(data: &Path, slug: &str) -> Result<Connection, SqlError> {
    let conn = read_only(&org_file(data, slug)?)?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
    conn.pragma_update(None, "query_only", "ON")?;
    conn.authorizer(Some(store::read_only_authorizer))?;
    Ok(conn)
}

fn value(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Value::from(b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
    }
}

fn csv_field(v: &Value) -> String {
    let s = match v {
        Value::Null => return String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// Run one read-only statement and render its rows.
pub fn run(conn: &Connection, sql: &str, format: Format) -> Result<String, SqlError> {
    run_within(conn, sql, format, TIMEOUT)
}

/// [`run`], interrupted after `timeout`.
pub fn run_within(
    conn: &Connection,
    sql: &str,
    format: Format,
    timeout: Duration,
) -> Result<String, SqlError> {
    let start = Instant::now();
    conn.progress_handler(1_000, Some(move || start.elapsed() > timeout))?;
    let out = render(conn, sql, format);
    conn.progress_handler(0, None::<fn() -> bool>)?;
    out
}

fn render(conn: &Connection, sql: &str, format: Format) -> Result<String, SqlError> {
    let mut stmt = conn.prepare(sql)?;
    if !stmt.readonly() {
        return Err(SqlError::NotReadOnly);
    }
    let names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let values = (0..names.len())
            .map(|i| row.get_ref(i).map(value))
            .collect::<rusqlite::Result<Vec<_>>>()?;
        out.push(values);
    }
    Ok(match format {
        Format::Csv => {
            let mut text = names
                .iter()
                .map(|n| csv_field(&Value::from(n.as_str())))
                .collect::<Vec<_>>()
                .join(",");
            text.push('\n');
            for row in out {
                text.push_str(&row.iter().map(csv_field).collect::<Vec<_>>().join(","));
                text.push('\n');
            }
            text
        }
        Format::Json => {
            let rows: Vec<Value> = out
                .into_iter()
                .map(|row| Value::Object(names.iter().cloned().zip(row).collect::<Map<_, _>>()))
                .collect();
            let mut text = serde_json::to_string_pretty(&rows).unwrap_or_default();
            text.push('\n');
            text
        }
    })
}
