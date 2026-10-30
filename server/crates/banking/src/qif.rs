//! QIF statements (Lloyds, Santander and First Direct offer only this):
//! one field per line, a letter then its value, `^` ending each record.
//! `D` date (day-first, as UK banks write it), `T` (or `U`) amount, `P`
//! payee, `M` memo, `N` number. QIF has no transaction id.

use crate::money::{Decimal, parse_pence};
use crate::text::{join, non_empty};
use crate::{CreditLine, Errors, Movement, Parsed, RowError, dates};

#[derive(Default)]
struct Record<'a> {
    line: usize,
    date: Option<&'a str>,
    amount: Option<&'a str>,
    payee: Option<&'a str>,
    memo: Option<&'a str>,
    number: Option<&'a str>,
}

pub fn read(text: &str) -> Result<Parsed, Vec<RowError>> {
    let mut lines = text
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l.trim_end_matches('\r')))
        .filter(|(_, l)| !l.trim().is_empty());
    let mut in_transactions = match lines.next() {
        Some((_, first)) if first.trim_start().starts_with('!') => transactions_follow(first),
        _ => return Err(vec![RowError::new(0, "Not a QIF file")]),
    };
    let mut parsed = Parsed::default();
    let mut errors = Errors::default();
    let mut record: Option<Record> = None;
    let mut finish = |r: Record, parsed: &mut Parsed| match transaction(&r) {
        Ok(movement) => parsed.take(movement),
        Err(message) => errors.push(r.line, message),
    };
    for (n, line) in lines {
        let line = line.trim_start();
        if line.starts_with('!') {
            in_transactions = transactions_follow(line);
            continue;
        }
        if !in_transactions {
            continue;
        }
        let (code, value) = line.split_at(line.chars().next().map_or(0, char::len_utf8));
        if code == "^" {
            match record.take() {
                Some(r) => finish(r, &mut parsed),
                None => parsed.rows_skipped += 1,
            }
            continue;
        }
        let r = record.get_or_insert_with(|| Record {
            line: n,
            ..Record::default()
        });
        let slot = match code {
            "D" => &mut r.date,
            "T" => &mut r.amount,
            "U" => {
                r.amount.get_or_insert(value);
                continue;
            }
            "P" => &mut r.payee,
            "M" => &mut r.memo,
            "N" => &mut r.number,
            _ => continue,
        };
        *slot = Some(value);
    }
    if let Some(r) = record.take() {
        finish(r, &mut parsed);
    }
    errors.finish(parsed)
}

/// Quicken pads dates with spaces (`D 1/ 5' 3`) and writes years from
/// 2000 after an apostrophe, in one or two digits.
fn qif_date(value: &str) -> Result<String, String> {
    // Drop only the padding beside a separator: `3 Nov 2026` keeps its
    // spaces, ` 1/ 5' 3` becomes `1/5'3`.
    let separator = |c: char| matches!(c, '/' | '-' | '.' | '\'');
    let chars: Vec<char> = value.trim().chars().collect();
    let beside = |i: usize, step: isize| {
        let mut j = i as isize;
        loop {
            j += step;
            match chars.get(j as usize) {
                Some(c) if c.is_whitespace() && j >= 0 => continue,
                Some(&c) if j >= 0 => return separator(c),
                _ => return false,
            }
        }
    };
    let compact: String = chars
        .iter()
        .enumerate()
        .filter(|&(i, c)| !(c.is_whitespace() && (beside(i, -1) || beside(i, 1))))
        .map(|(_, c)| c)
        .collect();
    let compact = match compact.split_once('\'') {
        Some((day_month, year)) if (1..=2).contains(&year.len()) => {
            format!("{day_month}/{year:0>2}")
        }
        _ => compact,
    };
    dates::day_first(&compact).map_err(|_| format!("Not a date: {:?}", value.trim()))
}

/// Whether a `!` line starts transactions (`!Type:Bank`, `!Type:CCard`,
/// …) rather than `!Account`, `!Option` or a category list.
fn transactions_follow(line: &str) -> bool {
    let header = line.trim_start().get(1..).unwrap_or("").to_ascii_lowercase();
    header.starts_with("type:") && !header.starts_with("type:cat") && !header.starts_with("type:class")
}

fn transaction(r: &Record) -> Result<Movement, String> {
    let posted_on = qif_date(r.date.ok_or("No date (D)")?)?;
    let amount = parse_pence(r.amount.ok_or("No amount (T)")?, Decimal::Point)?.unwrap_or(0);
    if amount < 0 {
        return Ok(Movement::Debit);
    }
    if amount == 0 {
        return Ok(Movement::Zero);
    }
    Ok(Movement::Credit(CreditLine {
        line: r.line,
        posted_on,
        amount,
        payer: r.payee.and_then(non_empty),
        reference: r.number.and_then(non_empty),
        narrative: join([r.payee, r.memo].into_iter().flatten()),
        bank_id: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QIF: &str = "!Type:Bank\r\nD03/11/2026\r\nT10.00\r\nPJ SMITH\r\nM100016 FP\r\n^\r\n\
        D04/11'26\r\nT-1,250.00\r\nPACME LTD\r\n^\r\nD5/11/26\r\nU5.00\r\nT5.00\r\nPA JONES\r\nN42\r\n^\r\n";

    #[test]
    fn records_to_credits_and_dropped_debits() {
        let p = read(QIF).unwrap();
        assert_eq!(p.debits_dropped, 1);
        let got: Vec<_> = p
            .credits
            .iter()
            .map(|c| (c.line, c.posted_on.as_str(), c.amount))
            .collect();
        assert_eq!(got, [(2, "2026-11-03", 1000), (11, "2026-11-05", 500)]);
        assert_eq!(p.credits[0].narrative, "J SMITH 100016 FP");
        assert_eq!(p.credits[1].reference.as_deref(), Some("42"));
    }

    #[test]
    fn quicken_padded_dates() {
        assert_eq!(qif_date(" 1/ 5' 3").as_deref(), Ok("2003-05-01"));
        assert_eq!(qif_date("01/05'26").as_deref(), Ok("2026-05-01"));
        assert_eq!(qif_date("1/5/2026").as_deref(), Ok("2026-05-01"));
        // Month names keep their spaces.
        assert_eq!(qif_date("3 Nov 2026").as_deref(), Ok("2026-11-03"));
        assert_eq!(qif_date(" 3 Nov 2026 ").as_deref(), Ok("2026-11-03"));
        assert!(qif_date("31/2'26").is_err());
    }

    #[test]
    fn zero_amounts_are_skipped_not_debits() {
        let p = read(&QIF.replace("T-1,250.00", "T0.00")).unwrap();
        assert_eq!((p.debits_dropped, p.rows_skipped), (0, 1));
    }

    #[test]
    fn account_blocks_are_not_transactions() {
        let text = format!("!Account\nNCurrent\nTBank\n^\n{QIF}");
        assert_eq!(read(&text).unwrap().credits.len(), 2);
    }

    #[test]
    fn a_bad_record_refuses_the_file() {
        let bad = QIF.replace("D03/11/2026", "D31/02/2026");
        assert_eq!(read(&bad).unwrap_err()[0].line, 2);
        let no_amount = QIF.replace("T10.00\r\n", "");
        assert_eq!(read(&no_amount).unwrap_err()[0].line, 2);
        assert_eq!(read("Date,Amount\n").unwrap_err()[0].line, 0);
    }
}
