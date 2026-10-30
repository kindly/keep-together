//! `banking.import` (create-only): one statement file imported into an
//! account, and the new credit lines it brought, as `bank_lines` rows
//! whose content is never edited afterwards. Their match state is
//! `banking.lineMatch`'s, a later step; an import leaves it unmatched.
//!
//! [`import_file`] reads the file, finds what the account already holds
//! with the same content keys or bank ids, dedupes, and executes the
//! contract with only the new lines: all in the caller's transaction, so
//! two imports can't both take a line for new.

use std::collections::{BTreeSet, HashMap};

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, OrgTx, Source, WriteTx, execute,
    mint_ids,
};
use giving::PENCE_MAX;
use giving::rules::is_iso_date;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::account::{CsvLayout, account};
use crate::csv::ColumnMapping;
use crate::presets::preset;
use crate::{Format, Held, RowError, dedupe, read};

pub const TABLE: &str = "bank_imports";
/// The largest statement file read, in bytes.
pub const FILE_BYTES_MAX: usize = 5 * 1024 * 1024;
/// Most credits one file may hold (Santander's downloads stop at 3,000
/// transactions).
pub const LINES_MAX: usize = 10_000;
pub const FILE_NAME_MAX: usize = 255;

/// The file kinds `bank_imports.format` records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "BankFileKind")]
pub enum FileKind {
    Csv,
    Ofx,
    Qif,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Csv => "csv",
            FileKind::Ofx => "ofx",
            FileKind::Qif => "qif",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        [FileKind::Csv, FileKind::Ofx, FileKind::Qif]
            .into_iter()
            .find(|k| k.as_str() == value)
    }
}

/// A new line, as the import stores it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportLine")]
pub struct ImportLine {
    /// Minted in `prepare`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    pub posted_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    #[serde(default)]
    pub payer: String,
    #[serde(default)]
    pub reference: String,
    #[serde(default)]
    pub narrative: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bank_id: Option<String>,
    pub dedupe_key: String,
    #[ts(type = "number")]
    pub occurrence: u32,
}

/// The `banking.import` slice: the import as made, frozen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportPayload")]
pub struct ImportPayload {
    pub account_id: String,
    pub file_name: String,
    pub format: FileKind,
    /// The preset a CSV was read with, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preset: Option<String>,
    /// The file's credits' first and last dates, duplicates included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_date: Option<String>,
    #[ts(type = "number")]
    pub duplicate_lines: i64,
    pub lines: Vec<ImportLine>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportState {
    #[serde(flatten)]
    pub payload: ImportPayload,
    pub imported_by: Option<i64>,
    pub imported_at: i64,
}

pub struct ImportContract;
pub static IMPORT: ImportContract = ImportContract;

fn is_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn prepare_import(mut p: ImportPayload) -> Result<ImportPayload, ContractError> {
    p.file_name = crate::text::clean(&p.file_name);
    if p.file_name.is_empty() {
        p.file_name = "statement".into();
    }
    if p.file_name.chars().count() > FILE_NAME_MAX {
        p.file_name = p.file_name.chars().take(FILE_NAME_MAX).collect();
    }
    if p.lines.len() > LINES_MAX {
        return Err(ContractError::invalid(
            "lines",
            format!("At most {LINES_MAX} lines a file"),
        ));
    }
    if p.duplicate_lines < 0 {
        return Err(ContractError::invalid("duplicateLines", "Not a count"));
    }
    for date in [&p.first_date, &p.last_date].into_iter().flatten() {
        if !is_iso_date(date) {
            return Err(ContractError::invalid("firstDate", "Not a date"));
        }
    }
    for line in &p.lines {
        if line.amount <= 0 || line.amount > PENCE_MAX {
            return Err(ContractError::invalid("lines", "A line is a credit in pence"));
        }
        if !is_iso_date(&line.posted_on) || !is_key(&line.dedupe_key) || line.occurrence < 1 {
            return Err(ContractError::invalid("lines", "A line's date or key is not one"));
        }
    }
    mint_ids(&mut p.lines, |l| &mut l.id);
    Ok(p)
}

/// The lines an import brought, in file order.
pub fn import_lines(conn: &Connection, import_id: &str) -> Result<Vec<ImportLine>, ContractError> {
    Ok(conn
        .prepare_cached(
            "SELECT id, posted_on, amount, payer, reference, narrative, bank_id, dedupe_key,
                    occurrence
             FROM bank_lines WHERE import_id = ?1 ORDER BY seq",
        )?
        .query_map([import_id], |r| {
            Ok(ImportLine {
                id: r.get(0)?,
                posted_on: r.get(1)?,
                amount: r.get(2)?,
                payer: r.get(3)?,
                reference: r.get(4)?,
                narrative: r.get(5)?,
                bank_id: r.get(6)?,
                dedupe_key: r.get(7)?,
                occurrence: r.get(8)?,
            })
        })?
        .collect::<Result<_, _>>()?)
}

impl Contract for ImportContract {
    const NAME: &'static str = "banking.import";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "version";
    type Payload = ImportPayload;
    type State = ImportState;

    fn prepare(&self, p: ImportPayload) -> Result<ImportPayload, ContractError> {
        prepare_import(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<ImportState, ContractError> {
        let conn = tx.read();
        let row = conn
            .prepare_cached(
                "SELECT account_id, file_name, format, preset, first_date, last_date,
                        duplicate_lines, imported_by, imported_at
                 FROM bank_imports WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                ))
            })
            .optional()?
            .ok_or(ContractError::NotFound)?;
        let (account_id, file_name, format, preset, first_date, last_date, dup, by, at) = row;
        Ok(ImportState {
            payload: ImportPayload {
                account_id,
                file_name,
                format: FileKind::parse(&format).ok_or(ContractError::NotFound)?,
                preset,
                first_date,
                last_date,
                duplicate_lines: dup,
                lines: import_lines(conn, id)?,
            },
            imported_by: by,
            imported_at: at,
        })
    }

    fn apply(
        &self,
        current: Option<&ImportState>,
        p: &ImportPayload,
        command: &Command,
    ) -> Result<ImportState, ContractError> {
        if current.is_some() {
            return Err(ContractError::rejected(
                "not_restorable",
                "An import is what the bank's file said; it can't be changed",
            ));
        }
        Ok(ImportState {
            payload: p.clone(),
            imported_by: command.actor,
            imported_at: command.at,
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&ImportState>,
        next: &ImportState,
    ) -> Result<(), ContractError> {
        let p = &next.payload;
        let active: bool = tx
            .prepare_cached("SELECT active FROM bank_accounts WHERE id = ?1")?
            .query_row([&p.account_id], |r| r.get(0))
            .optional()?
            .ok_or(ContractError::NotFound)?;
        if !active {
            return Err(ContractError::rejected(
                "account_inactive",
                "This account is archived; make it active to import into it",
            ));
        }
        tx.prepare_cached(
            "INSERT INTO bank_imports (id, account_id, file_name, format, preset, first_date,
                 last_date, new_lines, duplicate_lines, imported_by, imported_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?
        .execute(params![
            id,
            p.account_id,
            p.file_name,
            p.format.as_str(),
            p.preset,
            p.first_date,
            p.last_date,
            p.lines.len() as i64,
            p.duplicate_lines,
            next.imported_by,
            next.imported_at
        ])?;
        let mut insert = tx.prepare_cached(
            "INSERT INTO bank_lines (id, account_id, import_id, posted_on, amount, payer,
                 reference, narrative, bank_id, dedupe_key, occurrence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for line in &p.lines {
            insert.execute(params![
                line.id,
                p.account_id,
                id,
                line.posted_on,
                line.amount,
                line.payer,
                line.reference,
                line.narrative,
                line.bank_id,
                line.dedupe_key,
                line.occurrence
            ])?;
        }
        Ok(())
    }
}

/// How to read the file being imported; `None` in [`ImportRequest`]
/// means the account's saved CSV layout.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, rename = "BankFileLayout")]
pub enum FileLayout {
    Preset { id: String },
    Mapping { mapping: ColumnMapping },
    Ofx,
    Qif,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportRequest")]
pub struct ImportRequest {
    pub account_id: String,
    pub file_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub layout: Option<FileLayout>,
}

/// "41 new, 12 already imported".
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImported")]
pub struct Imported {
    pub id: String,
    #[ts(type = "number")]
    pub new_lines: usize,
    #[ts(type = "number")]
    pub duplicate_lines: usize,
    /// Money out in the file, never stored.
    #[ts(type = "number")]
    pub debits_dropped: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_date: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    /// The file can't be read as asked: nothing from it is stored.
    #[error("the file has {} problem(s)", .0.len())]
    File(Vec<RowError>),
    #[error(transparent)]
    Contract(#[from] ContractError),
}

impl From<rusqlite::Error> for ImportError {
    fn from(e: rusqlite::Error) -> Self {
        ImportError::Contract(e.into())
    }
}

fn file_error(message: impl Into<String>) -> ImportError {
    ImportError::File(vec![RowError::new(0, message)])
}

/// What `account_id` already holds with any of these keys or bank ids.
fn held(
    conn: &Connection,
    account_id: &str,
    keys: &BTreeSet<&str>,
    ids: &BTreeSet<&str>,
) -> Result<Held, ContractError> {
    // By line id, so a line found both ways counts once.
    let mut rows: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut by_key = conn.prepare_cached(
        "SELECT id, dedupe_key, bank_id FROM bank_lines WHERE account_id = ?1 AND dedupe_key = ?2",
    )?;
    let mut by_id = conn.prepare_cached(
        "SELECT id, dedupe_key, bank_id FROM bank_lines WHERE account_id = ?1 AND bank_id = ?2",
    )?;
    for key in keys {
        collect(&mut by_key, account_id, key, &mut rows)?;
    }
    for id in ids {
        collect(&mut by_id, account_id, id, &mut rows)?;
    }
    let mut held = Held::new();
    for (key, bank_id) in rows.values() {
        held.add(key, bank_id.as_deref());
    }
    Ok(held)
}

fn collect(
    stmt: &mut rusqlite::CachedStatement,
    account_id: &str,
    value: &str,
    rows: &mut HashMap<String, (String, Option<String>)>,
) -> rusqlite::Result<()> {
    for row in stmt.query_map(params![account_id, value], |r| {
        Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?)))
    })? {
        let (id, row) = row?;
        rows.insert(id, row);
    }
    Ok(())
}

/// A file read and deduped against an account, not yet stored.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Planned {
    pub payload: ImportPayload,
    pub debits_dropped: usize,
}

/// Lines a [`Preview`] shows.
pub const PREVIEW_LINES: usize = 20;

/// What an import would do, written nowhere: the counts and the first
/// new lines, to check a column mapping before importing with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportPreview")]
pub struct Preview {
    #[ts(type = "number")]
    pub new_lines: usize,
    #[ts(type = "number")]
    pub duplicate_lines: usize,
    #[ts(type = "number")]
    pub debits_dropped: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_date: Option<String>,
    /// The first [`PREVIEW_LINES`] new lines.
    pub lines: Vec<ImportLine>,
}

impl Planned {
    pub fn preview(&self) -> Preview {
        let p = &self.payload;
        Preview {
            new_lines: p.lines.len(),
            duplicate_lines: p.duplicate_lines as usize,
            debits_dropped: self.debits_dropped,
            first_date: p.first_date.clone(),
            last_date: p.last_date.clone(),
            lines: p.lines.iter().take(PREVIEW_LINES).cloned().collect(),
        }
    }
}

/// The layout a file is read with: the request's, else the account's.
fn resolve_layout(
    request: Option<FileLayout>,
    saved: Option<&CsvLayout>,
) -> Result<(Format, FileKind, Option<String>), ImportError> {
    let saved = || match saved {
        Some(CsvLayout::Preset { id }) => Some(FileLayout::Preset { id: id.clone() }),
        Some(CsvLayout::Mapping { mapping }) => Some(FileLayout::Mapping {
            mapping: mapping.clone(),
        }),
        None => None,
    };
    let layout = request
        .or_else(saved)
        .ok_or_else(|| file_error("Choose the bank's layout or map the columns"))?;
    Ok(match layout {
        FileLayout::Preset { id } => {
            let p = preset(&id).ok_or_else(|| file_error(format!("No preset {id}")))?;
            (Format::Csv { mapping: p.mapping }, FileKind::Csv, Some(id))
        }
        FileLayout::Mapping { mapping } => (Format::Csv { mapping }, FileKind::Csv, None),
        FileLayout::Ofx => (Format::Ofx, FileKind::Ofx, None),
        FileLayout::Qif => (Format::Qif, FileKind::Qif, None),
    })
}

/// Reads a statement file for an account and keeps only the lines it
/// doesn't hold yet. Writes nothing: [`import_file`] stores the plan, and
/// a preview shows it. A file that can't be read is
/// [`ImportError::File`].
pub fn plan_import(
    conn: &Connection,
    request: ImportRequest,
    bytes: &[u8],
) -> Result<Planned, ImportError> {
    if bytes.len() > FILE_BYTES_MAX {
        return Err(file_error(format!(
            "The file is over {} MB",
            FILE_BYTES_MAX / 1024 / 1024
        )));
    }
    let account = account(conn, &request.account_id)?.ok_or(ContractError::NotFound)?;
    if !account.payload.active {
        return Err(ContractError::rejected(
            "account_inactive",
            "This account is archived; make it active to import into it",
        )
        .into());
    }
    let (format, kind, preset_id) =
        resolve_layout(request.layout, account.payload.csv_layout.as_ref())?;
    let parsed = read(bytes, &format).map_err(ImportError::File)?;
    if parsed.credits.len() > LINES_MAX {
        return Err(file_error(format!(
            "At most {LINES_MAX} credits a file; import a shorter period"
        )));
    }
    let (first_date, last_date) = parsed
        .date_range()
        .map(|(a, b)| (Some(a.to_owned()), Some(b.to_owned())))
        .unwrap_or_default();
    let keys_owned: Vec<String> = parsed.credits.iter().map(crate::content_key).collect();
    let keys: BTreeSet<&str> = keys_owned.iter().map(String::as_str).collect();
    let ids: BTreeSet<&str> = parsed
        .credits
        .iter()
        .filter_map(|c| c.bank_id.as_deref())
        .collect();
    let held = held(conn, &request.account_id, &keys, &ids)?;
    let debits_dropped = parsed.debits_dropped;
    let deduped = dedupe(parsed.credits, &held);
    let lines = deduped
        .new
        .into_iter()
        .map(|k| ImportLine {
            id: None,
            posted_on: k.line.posted_on,
            amount: k.line.amount,
            payer: k.line.payer.unwrap_or_default(),
            reference: k.line.reference.unwrap_or_default(),
            narrative: k.line.narrative,
            bank_id: k.line.bank_id,
            dedupe_key: k.key,
            occurrence: k.occurrence,
        })
        .collect::<Vec<_>>();
    Ok(Planned {
        payload: ImportPayload {
            account_id: request.account_id,
            file_name: request.file_name,
            format: kind,
            preset: preset_id,
            first_date,
            last_date,
            duplicate_lines: deduped.duplicates as i64,
            lines,
        },
        debits_dropped,
    })
}

/// Imports one statement file into an account: [`plan_import`], then the
/// import recorded with its new lines, in the caller's transaction.
pub fn import_file(
    ctx: &Ctx,
    request: ImportRequest,
    bytes: &[u8],
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<Imported, ImportError> {
    let planned = plan_import(ctx.tx.read(), request, bytes)?;
    let p = &planned.payload;
    let (new_lines, duplicate_lines) = (p.lines.len(), p.duplicate_lines as usize);
    let (first_date, last_date) = (p.first_date.clone(), p.last_date.clone());
    let exec = match group {
        Some(g) => Exec::create(source).in_group(g),
        None => Exec::create(source),
    };
    let id = execute(ctx, &IMPORT, planned.payload, exec)?.id;
    Ok(Imported {
        id,
        new_lines,
        duplicate_lines,
        debits_dropped: planned.debits_dropped,
        first_date,
        last_date,
    })
}

/// An import in an account's list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankImportRow")]
pub struct ImportRow {
    pub id: String,
    pub file_name: String,
    pub format: FileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_date: Option<String>,
    #[ts(type = "number")]
    pub new_lines: i64,
    #[ts(type = "number")]
    pub duplicate_lines: i64,
    #[ts(type = "number | null")]
    pub imported_by: Option<i64>,
    #[ts(type = "number")]
    pub imported_at: i64,
}

pub const IMPORTS_PAGE: i64 = 100;

const IMPORT_COLUMNS: &str = "id, file_name, format, preset, first_date, last_date, new_lines,
     duplicate_lines, imported_by, imported_at";

fn import_row(r: &rusqlite::Row) -> rusqlite::Result<ImportRow> {
    Ok(ImportRow {
        id: r.get(0)?,
        file_name: r.get(1)?,
        format: FileKind::parse(&r.get::<_, String>(2)?).unwrap_or(FileKind::Csv),
        preset: r.get(3)?,
        first_date: r.get(4)?,
        last_date: r.get(5)?,
        new_lines: r.get(6)?,
        duplicate_lines: r.get(7)?,
        imported_by: r.get(8)?,
        imported_at: r.get(9)?,
    })
}

/// One import and the account it went into.
pub fn import_of(
    conn: &Connection,
    id: &str,
) -> Result<Option<(String, ImportRow)>, ContractError> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {IMPORT_COLUMNS}, account_id FROM bank_imports WHERE id = ?1"
        ))?
        .query_row([id], |r| Ok((r.get(10)?, import_row(r)?)))
        .optional()?)
}

/// An account's imports, newest first.
pub fn imports(conn: &Connection, account_id: &str) -> Result<Vec<ImportRow>, ContractError> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {IMPORT_COLUMNS} FROM bank_imports WHERE account_id = ?1
             ORDER BY seq DESC LIMIT ?2"
        ))?
        .query_map(params![account_id, IMPORTS_PAGE], import_row)?
        .collect::<Result<_, _>>()?)
}
