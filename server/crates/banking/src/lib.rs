//! Bank statements: the group's bank accounts, statement imports and
//! their credit lines, the outside record for gifts entered by hand
//! (plan `bank-transfers.sv`, ADR 0027). A domain crate: depends on
//! `contracts`, `giving` and `sources` through their public
//! functions, never on `store` or `platform`; it can't name an
//! organisation. Money is INTEGER pence (rule 7).
//!
//! Reading a file is pure: [`read`] turns its bytes into [`CreditLine`]s,
//! and [`dedupe`] decides which of them are new for an account. Debits
//! are dropped while the file is read and never stored. A file with any
//! malformed row gives only errors, so nothing from it is stored.
//!
//! ```text
//!   banking.account  — a named account: sort code, last four digits,
//!                      default source code, saved CSV layout, active
//!   banking.import   — one file imported: its new `bank_lines` (content
//!                      written once) and the duplicate count. Create-only
//! ```

pub mod account;
pub mod csv;
pub mod dates;
pub mod dedupe;
pub mod import;
pub mod money;
pub mod ofx;
pub mod presets;
pub mod qif;
mod text;

use std::sync::LazyLock;

use contracts::{ContractError, Ctx, Exec, Executed, Registry, Source, execute};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use account::{ACCOUNT, Account, AccountPayload, AccountRow, CsvLayout, accounts};
pub use csv::{AmountColumns, Column, ColumnMapping, HeaderRow, PeekRow};
pub use dedupe::{Deduped, Held, Keyed, content_key, dedupe};
pub use import::{
    FileLayout, IMPORT, ImportError, ImportRequest, ImportRow, Imported, Planned, Preview,
    import_file, import_lines, import_of, imports, plan_import,
};
pub use presets::{AWAITING_SAMPLES, Preset, preset, presets};

/// Every contract restore may meet in an org file's banking history.
pub static REGISTRY: LazyLock<Registry> = LazyLock::new(|| Registry::new(&[&ACCOUNT, &IMPORT]));

/// A new bank account (admins only: the route checks).
pub fn create_account(
    ctx: &Ctx,
    payload: AccountPayload,
    source: Source,
) -> Result<Executed, ContractError> {
    execute(ctx, &ACCOUNT, payload, Exec::create(source))
}

/// Saves an account; `expected` is its `version`.
pub fn save_account(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    payload: AccountPayload,
    source: Source,
) -> Result<Executed, ContractError> {
    execute(ctx, &ACCOUNT, payload, Exec::update(id, Some(expected), source))
}

/// Most row errors one read reports; past it the file is refused all the
/// same, with a last error saying how many more there were.
pub const ROW_ERRORS_MAX: usize = 50;

/// One credit (money in) read from a statement. Its content is the bank's
/// and is never edited once stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankCreditLine")]
pub struct CreditLine {
    /// The file line it starts on (1-based), for messages.
    #[ts(type = "number")]
    pub line: usize,
    /// The date the money reached the bank, YYYY-MM-DD.
    pub posted_on: String,
    /// Pence, always positive.
    #[ts(type = "number")]
    pub amount: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub payer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference: Option<String>,
    /// The bank's description, whitespace runs collapsed.
    pub narrative: String,
    /// The bank's own transaction id, when the format has one (OFX
    /// `FITID`, a CSV id column).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bank_id: Option<String>,
}

/// A row the reader refused. `line` is 1-based; 0 means the whole file
/// (no header row, not an OFX file, …).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename = "BankRowError")]
pub struct RowError {
    #[ts(type = "number")]
    pub line: usize,
    pub message: String,
}

impl RowError {
    pub fn new(line: usize, message: impl Into<String>) -> Self {
        RowError {
            line,
            message: message.into(),
        }
    }
}

/// A row skipped for having no date though it carries money in: a
/// totals row, or a credit the layout (or a wrong date column) hides.
/// Reported so staff can check, never stored.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "BankUndatedRow")]
pub struct UndatedRow {
    #[ts(type = "number")]
    pub line: usize,
    #[ts(type = "number")]
    pub amount: i64,
}

/// A file read without errors.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub credits: Vec<CreditLine>,
    /// Money out: counted, never kept.
    pub debits_dropped: usize,
    /// Header, footer, balance, blank and zero rows passed over.
    pub rows_skipped: usize,
    /// The first [`ROW_ERRORS_MAX`] dateless rows with money in, and how
    /// many there were.
    pub undated: Vec<UndatedRow>,
    pub undated_count: usize,
    /// The account the file says it is for (OFX `ACCTID`), if it says.
    pub source_account: Option<String>,
}

/// What one transaction of a file is.
pub(crate) enum Movement {
    Credit(CreditLine),
    Debit,
    /// No money moved (an information line, `-0.00`).
    Zero,
}

impl Parsed {
    pub(crate) fn take(&mut self, movement: Movement) {
        match movement {
            Movement::Credit(credit) => self.credits.push(credit),
            Movement::Debit => self.debits_dropped += 1,
            Movement::Zero => self.rows_skipped += 1,
        }
    }

    pub(crate) fn undated(&mut self, line: usize, amount: i64) {
        self.undated_count += 1;
        if self.undated.len() < ROW_ERRORS_MAX {
            self.undated.push(UndatedRow { line, amount });
        }
    }

    /// The first and last posted dates, if there are any credits.
    pub fn date_range(&self) -> Option<(&str, &str)> {
        let first = self.credits.iter().map(|c| c.posted_on.as_str()).min()?;
        let last = self.credits.iter().map(|c| c.posted_on.as_str()).max()?;
        Some((first, last))
    }
}

/// How to read a file: CSV with a column mapping (a preset's or one saved
/// on the account), OFX or QIF.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, rename = "BankFileFormat")]
pub enum Format {
    Csv { mapping: ColumnMapping },
    Ofx,
    Qif,
}

/// Reads a statement file to its credits. Any malformed row makes the
/// whole read an error (at most [`ROW_ERRORS_MAX`] of them, by line), and
/// so does a file with no transactions at all, which is usually the wrong
/// layout passing every row over.
pub fn read(bytes: &[u8], format: &Format) -> Result<Parsed, Vec<RowError>> {
    let text = text::decode(bytes);
    let parsed = match format {
        Format::Csv { mapping } => csv::read(&text, mapping),
        Format::Ofx => ofx::read(&text),
        Format::Qif => qif::read(&text),
    }?;
    if parsed.credits.is_empty() && parsed.debits_dropped == 0 {
        let message = match format {
            Format::Csv { .. } => "No transactions found: check the columns",
            Format::Ofx | Format::Qif => "No transactions in this file",
        };
        return Err(vec![RowError::new(0, message)]);
    }
    Ok(parsed)
}

/// The first rows of a CSV file as text, for mapping its columns.
pub fn peek_csv(bytes: &[u8]) -> Result<Vec<PeekRow>, RowError> {
    csv::peek(&text::decode(bytes))
}

/// Collects row errors up to [`ROW_ERRORS_MAX`], counting the rest.
#[derive(Default)]
pub(crate) struct Errors {
    errors: Vec<RowError>,
    more: usize,
}

impl Errors {
    pub(crate) fn push(&mut self, line: usize, message: impl Into<String>) {
        if self.errors.len() < ROW_ERRORS_MAX {
            self.errors.push(RowError::new(line, message));
        } else {
            self.more += 1;
        }
    }

    pub(crate) fn finish(mut self, parsed: Parsed) -> Result<Parsed, Vec<RowError>> {
        if self.errors.is_empty() {
            return Ok(parsed);
        }
        if self.more > 0 {
            self.errors
                .push(RowError::new(0, format!("…and {} more rows", self.more)));
        }
        Err(self.errors)
    }
}
