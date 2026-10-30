//! Bank statements: the group's bank accounts, statement imports and
//! their credit lines, the outside record for gifts entered by hand
//! (plan `bank-transfers.sv`). A domain crate: depends on `contracts`,
//! `contacts` and `giving` through their public functions, never on
//! `store` or `platform`; it can't name an organisation. Money is INTEGER
//! pence (rule 7).
//!
//! Reading a file is pure: [`read`] turns its bytes into [`CreditLine`]s,
//! and [`dedupe`] decides which of them are new for an account. Debits
//! are dropped while the file is read and never stored. A file with any
//! malformed row gives only errors, so nothing from it is stored.

pub mod csv;
pub mod dates;
pub mod dedupe;
pub mod money;
pub mod ofx;
pub mod presets;
pub mod qif;
mod text;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use csv::{AmountColumns, Column, ColumnMapping, HeaderRow};
pub use dedupe::{Deduped, Held, Keyed, content_key, dedupe};
pub use presets::{AWAITING_SAMPLES, Preset, preset, presets};

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

/// A file read without errors.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    pub credits: Vec<CreditLine>,
    /// Money out: counted, never kept.
    pub debits_dropped: usize,
    /// Header, footer, balance and blank rows passed over.
    pub rows_skipped: usize,
}

impl Parsed {
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
