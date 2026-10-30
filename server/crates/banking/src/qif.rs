//! QIF statements (Lloyds, Santander and First Direct offer only this):
//! one field per line, a letter then its value, `^` ending each record.
//! `D` date (day-first, as UK banks write it), `T` (or `U`) amount, `P`
//! payee, `M` memo, `N` number. QIF has no transaction id.

use crate::money::{Decimal, parse_pence};
use crate::text::{join, non_empty};
use crate::{CreditLine, Errors, Parsed, RowError, dates};

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
        Ok(Some(credit)) => parsed.credits.push(credit),
        Ok(None) => parsed.debits_dropped += 1,
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

/// Whether a `!` line starts transactions (`!Type:Bank`, `!Type:CCard`,
/// …) rather than `!Account`, `!Option` or a category list.
fn transactions_follow(line: &str) -> bool {
    let header = line.trim_start().get(1..).unwrap_or("").to_ascii_lowercase();
    header.starts_with("type:") && !header.starts_with("type:cat") && !header.starts_with("type:class")
}

fn transaction(r: &Record) -> Result<Option<CreditLine>, String> {
    let posted_on = dates::day_first(r.date.ok_or("No date (D)")?)?;
    let amount = parse_pence(r.amount.ok_or("No amount (T)")?, Decimal::Point)?.unwrap_or(0);
    if amount <= 0 {
        return Ok(None);
    }
    Ok(Some(CreditLine {
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
