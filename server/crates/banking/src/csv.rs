//! CSV statements: a small RFC 4180 reader and the column mapping that
//! turns its rows into credits. Every bank lays its CSV out differently,
//! so a mapping is a preset's (`presets`) or one staff saved on the
//! account.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::money::{Decimal, parse_pence};
use crate::text::{clean, join, non_empty};
use crate::{CreditLine, Errors, Parsed, RowError, dates};

/// A column, by its header text (matched ignoring case and whitespace
/// runs) or by position (0-based, for files whose header text we don't
/// know or trust).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankColumn")]
pub enum Column {
    Name(String),
    Index(#[ts(type = "number")] u16),
}

impl Column {
    pub fn name(name: &str) -> Self {
        Column::Name(name.to_owned())
    }
}

/// Where the amount is: one signed column (money in positive), or a
/// paid-in and a paid-out column. Either way, a credit's amount is
/// positive pence; a paid-in column's sign is ignored (some banks sign
/// both).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, rename = "BankAmountColumns")]
pub enum AmountColumns {
    Signed { column: Column },
    PaidInOut { paid_in: Column, paid_out: Column },
}

/// Where the data starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, rename = "BankHeaderRow")]
pub enum HeaderRow {
    /// The first row holding every column named by text; everything above
    /// it (a printed-statement preamble) is passed over.
    Find,
    /// Pass over this many rows; every column must be by position.
    Skip {
        #[ts(type = "number")]
        rows: u16,
    },
}

/// How one CSV layout maps to a credit line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "BankColumnMapping")]
pub struct ColumnMapping {
    pub header: HeaderRow,
    pub date: Column,
    pub amount: AmountColumns,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub payer: Option<Column>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference: Option<Column>,
    /// Joined, in order, with one space.
    #[serde(default)]
    pub narrative: Vec<Column>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bank_id: Option<Column>,
    /// When set, a row in any currency but GBP is an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub currency: Option<Column>,
}

/// Most columns a mapping may name, and the highest position.
pub const COLUMNS_MAX: usize = 20;
pub const INDEX_MAX: u16 = 255;
pub const NAME_MAX: usize = 100;

impl ColumnMapping {
    fn columns(&self) -> impl Iterator<Item = &Column> {
        let amount = match &self.amount {
            AmountColumns::Signed { column } => vec![column],
            AmountColumns::PaidInOut { paid_in, paid_out } => vec![paid_in, paid_out],
        };
        [Some(&self.date)]
            .into_iter()
            .chain(amount.into_iter().map(Some))
            .chain([self.payer.as_ref(), self.reference.as_ref()])
            .chain(self.narrative.iter().map(Some))
            .chain([self.bank_id.as_ref(), self.currency.as_ref()])
            .flatten()
    }

    /// Whether the mapping can be used at all; the message says why not.
    pub fn check(&self) -> Result<(), String> {
        if self.narrative.len() + 6 > COLUMNS_MAX {
            return Err(format!("At most {} narrative columns", COLUMNS_MAX - 6));
        }
        for column in self.columns() {
            match column {
                Column::Index(i) if *i > INDEX_MAX => {
                    return Err(format!("Column positions go up to {INDEX_MAX}"));
                }
                Column::Name(name) if clean(name).is_empty() => {
                    return Err("A column name is empty".into());
                }
                Column::Name(name) if name.chars().count() > NAME_MAX => {
                    return Err(format!("Column names are at most {NAME_MAX} characters"));
                }
                Column::Name(_) if matches!(self.header, HeaderRow::Skip { .. }) => {
                    return Err("Columns named by text need the header row found".into());
                }
                _ => {}
            }
        }
        Ok(())
    }
}

/// One CSV record and the file line it starts on (1-based).
pub(crate) struct Record {
    line: usize,
    fields: Vec<String>,
}

/// Rows [`peek`] returns, and the most cells and characters of each.
pub const PEEK_ROWS: usize = 30;
pub const PEEK_CELLS: usize = 60;
pub const PEEK_CELL_CHARS: usize = 200;

/// A raw CSV row, for mapping columns by eye.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "BankPeekRow")]
pub struct PeekRow {
    #[ts(type = "number")]
    pub line: usize,
    pub cells: Vec<String>,
}

/// The first [`PEEK_ROWS`] rows of a CSV file, as text (cells cut to
/// [`PEEK_CELL_CHARS`]): what the column-mapping screen shows.
pub fn peek(text: &str) -> Result<Vec<PeekRow>, RowError> {
    Ok(records(text)?
        .into_iter()
        .take(PEEK_ROWS)
        .map(|r| PeekRow {
            line: r.line,
            cells: r
                .fields
                .into_iter()
                .take(PEEK_CELLS)
                .map(|c| c.chars().take(PEEK_CELL_CHARS).collect())
                .collect(),
        })
        .collect())
}

/// Splits CSV text into records: `,`-separated, `"`-quoted fields with
/// `""` for a quote, quoted newlines kept, CRLF or LF.
pub(crate) fn records(text: &str) -> Result<Vec<Record>, RowError> {
    let mut out = vec![];
    let mut fields = vec![];
    let mut field = String::new();
    let mut line = 1;
    let mut start = 1;
    let mut quoted = false;
    let mut at_field_start = true;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                '\n' => {
                    line += 1;
                    field.push('\n');
                }
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if at_field_start => {
                quoted = true;
                at_field_start = false;
            }
            ',' => {
                fields.push(std::mem::take(&mut field));
                at_field_start = true;
            }
            '\r' if chars.peek() == Some(&'\n') => {}
            '\n' => {
                fields.push(std::mem::take(&mut field));
                out.push(Record {
                    line: start,
                    fields: std::mem::take(&mut fields),
                });
                line += 1;
                start = line;
                at_field_start = true;
            }
            _ => {
                field.push(c);
                at_field_start = false;
            }
        }
    }
    if quoted {
        return Err(RowError::new(start, "A quoted field never ends"));
    }
    if !field.is_empty() || !fields.is_empty() {
        fields.push(field);
        out.push(Record {
            line: start,
            fields,
        });
    }
    Ok(out)
}

fn header_key(cell: &str) -> String {
    clean(cell).to_lowercase()
}

/// The data rows' cells for each mapped column.
struct Resolved<'m> {
    mapping: &'m ColumnMapping,
    names: Vec<String>,
}

impl Resolved<'_> {
    fn index(&self, column: &Column) -> Option<usize> {
        match column {
            Column::Index(i) => Some(usize::from(*i)),
            Column::Name(name) => {
                let key = header_key(name);
                self.names.iter().position(|n| *n == key)
            }
        }
    }

    fn cell<'r>(&self, record: &'r Record, column: &Column) -> &'r str {
        self.index(column)
            .and_then(|i| record.fields.get(i))
            .map_or("", String::as_str)
    }
}

/// Reads a CSV statement with `mapping`.
pub fn read(text: &str, mapping: &ColumnMapping) -> Result<Parsed, Vec<RowError>> {
    mapping.check().map_err(|m| vec![RowError::new(0, m)])?;
    let records = records(text).map_err(|e| vec![e])?;
    let mut parsed = Parsed::default();

    let (header_at, names) = match mapping.header {
        HeaderRow::Skip { rows } => (usize::from(rows), vec![]),
        HeaderRow::Find => {
            let wanted: Vec<String> = mapping
                .columns()
                .filter_map(|c| match c {
                    Column::Name(n) => Some(header_key(n)),
                    Column::Index(_) => None,
                })
                .collect();
            let found = records.iter().position(|r| {
                let keys: Vec<String> = r.fields.iter().map(|f| header_key(f)).collect();
                wanted.iter().all(|w| keys.contains(w))
            });
            let Some(at) = found else {
                let list: Vec<&str> = mapping
                    .columns()
                    .filter_map(|c| match c {
                        Column::Name(n) => Some(n.as_str()),
                        Column::Index(_) => None,
                    })
                    .collect();
                return Err(vec![RowError::new(
                    0,
                    format!("No row has the columns {}", list.join(", ")),
                )]);
            };
            // A transaction taken for the column names: its amount is money.
            // Its credit would be lost unseen, and next month's file would
            // look for columns called `25.00`.
            let amounts = match &mapping.amount {
                AmountColumns::Signed { column } => vec![column],
                AmountColumns::PaidInOut { paid_in, paid_out } => vec![paid_in, paid_out],
            };
            let money = amounts.iter().any(|c| match c {
                Column::Name(n) => matches!(parse_pence(n, Decimal::Point), Ok(Some(_))),
                Column::Index(_) => false,
            });
            if money {
                return Err(vec![RowError::new(
                    records[at].line,
                    "This line is a transaction, not column names: choose \"No header row\"",
                )]);
            }
            let names = records[at].fields.iter().map(|f| header_key(f)).collect();
            (at + 1, names)
        }
    };
    parsed.rows_skipped = header_at.min(records.len());
    let header_keys = (!names.is_empty()).then(|| names.clone());
    let cols = Resolved { mapping, names };

    let mut errors = Errors::default();
    for record in records.iter().skip(header_at) {
        let keys = || record.fields.iter().map(|f| header_key(f)).collect::<Vec<_>>();
        let blank = record.fields.iter().all(|f| f.trim().is_empty());
        // A header repeated further down (Lloyds: one per export joined).
        if blank || header_keys.as_ref().is_some_and(|h| *h == keys()) {
            parsed.rows_skipped += 1;
            continue;
        }
        match row(record, &cols) {
            Ok(Row::Credit(credit)) => parsed.credits.push(credit),
            Ok(Row::Debit) => parsed.debits_dropped += 1,
            Ok(Row::Skip) => parsed.rows_skipped += 1,
            Ok(Row::Undated(amount)) => {
                parsed.rows_skipped += 1;
                parsed.undated(record.line, amount);
            }
            Err(message) => errors.push(record.line, message),
        }
    }
    errors.finish(parsed)
}

enum Row {
    Credit(CreditLine),
    Debit,
    Skip,
    /// Money in on a row with no date: skipped, and reported.
    Undated(i64),
}

/// The row's money, signed (in positive): `None` when no amount column
/// holds one.
fn signed(record: &Record, cols: &Resolved) -> Result<i64, String> {
    let amount = |column: &Column| parse_pence(cols.cell(record, column), Decimal::Point);
    Ok(match &cols.mapping.amount {
        AmountColumns::Signed { column } => amount(column)?.unwrap_or(0),
        AmountColumns::PaidInOut { paid_in, paid_out } => {
            // Banks sign the paid-out column; a negative paid-in is a
            // reversal or a returned credit, never a gift: refuse it.
            let paid_in = amount(paid_in)?.unwrap_or(0);
            if paid_in < 0 {
                return Err("A negative amount in the paid-in column".into());
            }
            let paid_out = amount(paid_out)?.unwrap_or(0).abs();
            if paid_in != 0 && paid_out != 0 {
                return Err("Both paid in and paid out".into());
            }
            paid_in - paid_out
        }
    })
}

fn row(record: &Record, cols: &Resolved) -> Result<Row, String> {
    let m = cols.mapping;
    let date = cols.cell(record, &m.date);
    // Footers, totals and notes: no date in the date column. One that
    // carries money in is skipped all the same (a totals row looks just
    // like it), but reported, so a wrong date column can't lose a gift
    // unseen.
    if !date.bytes().any(|b| b.is_ascii_digit()) {
        return Ok(match signed(record, cols) {
            Ok(amount) if amount > 0 => Row::Undated(amount),
            _ => Row::Skip,
        });
    }
    let posted_on = dates::day_first(date)?;
    if let Some(currency) = &m.currency {
        let c = clean(cols.cell(record, currency));
        if !c.is_empty() && !c.eq_ignore_ascii_case("GBP") {
            return Err(format!("Not in pounds: {c}"));
        }
    }
    let signed = signed(record, cols)?;
    if signed < 0 {
        return Ok(Row::Debit);
    }
    // An opening balance or an information row: no money moved.
    if signed == 0 {
        return Ok(Row::Skip);
    }
    let text = |c: &Option<Column>| c.as_ref().and_then(|c| non_empty(cols.cell(record, c)));
    Ok(Row::Credit(CreditLine {
        line: record.line,
        posted_on,
        amount: signed,
        payer: text(&m.payer),
        reference: text(&m.reference),
        narrative: join(m.narrative.iter().map(|c| cols.cell(record, c))),
        bank_id: text(&m.bank_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed() -> ColumnMapping {
        ColumnMapping {
            header: HeaderRow::Find,
            date: Column::name("Date"),
            amount: AmountColumns::Signed {
                column: Column::name("Amount"),
            },
            payer: Some(Column::name("Payer")),
            reference: Some(Column::name("Reference")),
            narrative: vec![Column::name("Payer"), Column::name("Reference")],
            bank_id: None,
            currency: None,
        }
    }

    fn in_out() -> ColumnMapping {
        ColumnMapping {
            amount: AmountColumns::PaidInOut {
                paid_in: Column::name("Paid in"),
                paid_out: Column::name("Paid out"),
            },
            ..signed()
        }
    }

    #[test]
    fn quoted_fields_commas_quotes_and_newlines() {
        let r = records("a,\"b, c\",\"say \"\"hi\"\"\"\r\n\"two\nlines\",x\nlast").unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].fields, ["a", "b, c", "say \"hi\""]);
        assert_eq!((r[1].line, r[1].fields[0].as_str()), (2, "two\nlines"));
        assert_eq!((r[2].line, r[2].fields[0].as_str()), (4, "last"));
        assert_eq!(records("a,\"b\nc").err().unwrap().line, 1);
    }

    #[test]
    fn debits_are_dropped_and_credits_are_positive_pence() {
        let text = "Date,Payer,Reference,Amount\n\
                    01/11/2026,J SMITH,100016,10.00\n\
                    02/11/2026,ACME LTD,INV 4,-250.00\n\
                    03/11/2026,A JONES,,5\n";
        let p = read(text, &signed()).unwrap();
        assert_eq!(p.debits_dropped, 1);
        let got: Vec<_> = p.credits.iter().map(|c| (c.posted_on.as_str(), c.amount)).collect();
        assert_eq!(got, [("2026-11-01", 1000), ("2026-11-03", 500)]);
        assert_eq!(p.credits[0].payer.as_deref(), Some("J SMITH"));
        assert_eq!(p.credits[0].reference.as_deref(), Some("100016"));
        assert_eq!(p.credits[0].narrative, "J SMITH 100016");
        assert_eq!(p.credits[1].reference, None);
        assert!(p.credits.iter().all(|c| c.amount > 0));
    }

    #[test]
    fn paid_in_and_paid_out_columns_give_the_same_credits() {
        let text = "Date,Payer,Reference,Paid in,Paid out\n\
                    01/11/2026,J SMITH,100016,10.00,\n\
                    02/11/2026,ACME LTD,INV 4,,250.00\n\
                    02/11/2026,PRINT SHOP,INV 5,,-84.50\n\
                    03/11/2026,A JONES,,5.00,\n";
        let p = read(text, &in_out()).unwrap();
        assert_eq!(p.debits_dropped, 2);
        let got: Vec<_> = p.credits.iter().map(|c| c.amount).collect();
        assert_eq!(got, [1000, 500]);
        // A negative paid-in is a reversal: refused, never a credit.
        let reversed = "Date,Payer,Reference,Paid in,Paid out\n03/11/2026,A JONES,,-5.00,\n";
        let errors = read(reversed, &in_out()).unwrap_err();
        assert_eq!(errors[0].line, 2);
        assert!(errors[0].message.contains("negative"), "{errors:?}");
        let both = "Date,Payer,Reference,Paid in,Paid out\n01/11/2026,X,,1.00,2.00\n";
        assert_eq!(read(both, &in_out()).unwrap_err()[0].line, 2);
    }

    #[test]
    fn preamble_footer_balance_and_repeated_header_rows_are_skipped() {
        let text = "Statement of account\n\
                    Account,12345678\n\
                    \n\
                    Date,Payer,Reference,Amount\n\
                    01/11/2026,Opening balance,,\n\
                    01/11/2026,J SMITH,100016,10.00\n\
                    Date,Payer,Reference,Amount\n\
                    02/11/2026,A JONES,,5.00\n\
                    ,,Total,15.00\n\
                    End of statement\n";
        let p = read(text, &signed()).unwrap();
        assert_eq!(p.credits.len(), 2);
        assert_eq!(p.credits[1].line, 8);
        assert_eq!(p.rows_skipped, 8);
        // The totals row carries money in, so it is reported, not lost.
        assert_eq!(p.undated, [crate::UndatedRow { line: 9, amount: 1500 }]);
    }

    #[test]
    fn a_dateless_row_with_money_in_is_skipped_and_reported() {
        // A layout that prints each day's date only once.
        let text = "Date,Payer,Reference,Amount\n\
                    01/11/2026,J SMITH,100016,10.00\n\
                    ,A JONES,,50.00\n\
                    ,ACME LTD,,-20.00\n\
                    ,,Balance carried,\n\
                    02/11/2026,B BROWN,,5.00\n";
        let p = read(text, &signed()).unwrap();
        assert_eq!(p.credits.len(), 2);
        assert_eq!(p.undated, [crate::UndatedRow { line: 3, amount: 5000 }]);
        assert_eq!(p.undated_count, 1);
        let mut many = String::from("Date,Payer,Reference,Amount\n01/11/2026,J,,1.00\n");
        for _ in 0..60 {
            many.push_str(",X,,1.00\n");
        }
        let p = read(&many, &signed()).unwrap();
        assert_eq!((p.undated.len(), p.undated_count), (crate::ROW_ERRORS_MAX, 60));
    }

    #[test]
    fn a_malformed_row_refuses_the_file_by_line() {
        let text = "Date,Payer,Reference,Amount\n\
                    01/11/2026,J SMITH,100016,10.00\n\
                    31/02/2026,J SMITH,100016,10.00\n\
                    02/11/2026,J SMITH,100016,ten\n\
                    03/11/2026,J SMITH,100016,10.00\n";
        let errors = read(text, &signed()).unwrap_err();
        let lines: Vec<usize> = errors.iter().map(|e| e.line).collect();
        assert_eq!(lines, [3, 4]);
        assert!(errors[1].message.contains("ten"), "{errors:?}");
    }

    #[test]
    fn too_many_bad_rows_are_counted_not_listed() {
        let mut text = String::from("Date,Payer,Reference,Amount\n");
        for _ in 0..60 {
            text.push_str("01/11/2026,X,,ten\n");
        }
        let errors = read(&text, &signed()).unwrap_err();
        assert_eq!(errors.len(), crate::ROW_ERRORS_MAX + 1);
        assert_eq!(errors.last().unwrap().message, "…and 10 more rows");
    }

    #[test]
    fn a_headerless_file_reads_from_line_1_by_position() {
        let mapping = ColumnMapping {
            header: HeaderRow::Skip { rows: 0 },
            date: Column::Index(0),
            amount: AmountColumns::Signed {
                column: Column::Index(2),
            },
            payer: Some(Column::Index(1)),
            reference: None,
            narrative: vec![Column::Index(1)],
            bank_id: None,
            currency: None,
        };
        let text = "02/11/2026,J SMITH,25.00\n03/11/2026,A JONES,10.00\n";
        let p = read(text, &mapping).unwrap();
        let got: Vec<_> = p.credits.iter().map(|c| (c.line, c.amount)).collect();
        assert_eq!(got, [(1, 2500), (2, 1000)]);
        assert_eq!(p.rows_skipped, 0);
    }

    #[test]
    fn a_transaction_taken_for_the_header_is_refused() {
        // Columns named after line 1's cells: the mapping took a data row
        // for the names.
        let mapping = ColumnMapping {
            header: HeaderRow::Find,
            date: Column::name("02/11/2026"),
            amount: AmountColumns::Signed {
                column: Column::name("25.00"),
            },
            payer: None,
            reference: None,
            narrative: vec![Column::name("J SMITH")],
            bank_id: None,
            currency: None,
        };
        let text = "02/11/2026,J SMITH,25.00\n03/11/2026,A JONES,10.00\n";
        let errors = read(text, &mapping).unwrap_err();
        assert_eq!(errors[0].line, 1);
        assert!(errors[0].message.contains("No header row"), "{errors:?}");
    }

    #[test]
    fn peek_shows_the_first_rows_raw() {
        let mut text = String::from("Statement\nDate,\"Amount, GBP\"\n");
        for i in 0..40 {
            text.push_str(&format!("01/11/2026,{i}\n"));
        }
        let rows = peek(&text).unwrap();
        assert_eq!(rows.len(), PEEK_ROWS);
        assert_eq!(rows[1], PeekRow { line: 2, cells: vec!["Date".into(), "Amount, GBP".into()] });
    }

    #[test]
    fn no_header_row_is_one_error() {
        let errors = read("a,b\n1,2\n", &signed()).unwrap_err();
        assert_eq!(errors[0].line, 0);
        assert!(errors[0].message.contains("Date"), "{errors:?}");
    }

    #[test]
    fn headers_match_ignoring_case_and_spaces() {
        let text = "  DATE ,payer,REFERENCE,  amount\n01/11/2026,J SMITH,,1.00\n";
        assert_eq!(read(text, &signed()).unwrap().credits.len(), 1);
    }

    #[test]
    fn other_currencies_are_refused() {
        let mapping = ColumnMapping {
            currency: Some(Column::name("Currency")),
            ..signed()
        };
        let text = "Date,Payer,Reference,Amount,Currency\n\
                    01/11/2026,A,,1.00,GBP\n\
                    01/11/2026,B,,1.00,EUR\n";
        assert_eq!(read(text, &mapping).unwrap_err()[0].line, 3);
    }

    #[test]
    fn columns_by_position_after_skipped_rows() {
        let mapping = ColumnMapping {
            header: HeaderRow::Skip { rows: 1 },
            date: Column::Index(0),
            amount: AmountColumns::Signed {
                column: Column::Index(2),
            },
            payer: None,
            reference: None,
            narrative: vec![Column::Index(1)],
            bank_id: None,
            currency: None,
        };
        let p = read("whatever\n01/11/2026,J SMITH,1.00\n", &mapping).unwrap();
        assert_eq!(p.credits[0].narrative, "J SMITH");
        let named = ColumnMapping {
            date: Column::name("Date"),
            ..mapping
        };
        assert!(named.check().is_err());
    }
}
