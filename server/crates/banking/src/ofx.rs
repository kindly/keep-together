//! OFX statements, 1.x (SGML: elements need not close) and 2.x (XML),
//! read by one tolerant tag scanner. Each `<STMTTRN>` is a transaction;
//! its `FITID` is the bank's id (meant to be unique per account, though
//! some banks issue new ones per download: content dedupe still holds).

use crate::money::{Decimal, parse_pence};
use crate::text::{clean, join, non_empty};
use crate::{CreditLine, Errors, Movement, Parsed, RowError, dates};

#[derive(Default)]
struct Transaction {
    line: usize,
    posted: Option<String>,
    amount: Option<String>,
    fitid: Option<String>,
    name: Option<String>,
    memo: Option<String>,
    refnum: Option<String>,
}

/// `<TAG>value` pairs (value up to the next `<`), with the line each
/// tag is on; closing tags come through as `/TAG` with no value.
fn tags(text: &str) -> Vec<(usize, &str, &str)> {
    let mut out = vec![];
    let mut rest = text;
    let mut line = 1;
    while let Some(open) = rest.find('<') {
        line += rest[..open].matches('\n').count();
        rest = &rest[open + 1..];
        let Some(close) = rest.find('>') else { break };
        let tag = rest[..close].trim();
        rest = &rest[close + 1..];
        let end = rest.find('<').unwrap_or(rest.len());
        out.push((line, tag, &rest[..end]));
        line += rest[..end].matches('\n').count();
        rest = &rest[end..];
    }
    out
}

fn unescape(value: &str) -> String {
    clean(value)
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

pub fn read(text: &str) -> Result<Parsed, Vec<RowError>> {
    let tags = tags(text);
    if !tags.iter().any(|(_, t, _)| t.eq_ignore_ascii_case("OFX")) {
        return Err(vec![RowError::new(0, "Not an OFX file")]);
    }
    // One statement (one account) per file: business banking can export
    // every account as one OFX, and reading it whole would put another
    // account's credits into this one.
    let statements = tags
        .iter()
        .filter(|(_, t, _)| t.eq_ignore_ascii_case("STMTRS") || t.eq_ignore_ascii_case("CCSTMTRS"))
        .count();
    if statements > 1 {
        return Err(vec![RowError::new(
            0,
            format!("This file holds {statements} accounts; download one account at a time"),
        )]);
    }
    let mut parsed = Parsed::default();
    let mut errors = Errors::default();
    let mut current: Option<Transaction> = None;
    let finish = |t: Transaction, parsed: &mut Parsed, errors: &mut Errors| match transaction(&t) {
        Ok(movement) => parsed.take(movement),
        Err(message) => errors.push(t.line, message),
    };
    for (line, tag, value) in tags {
        let tag = tag.to_ascii_uppercase();
        let value = || non_empty(&unescape(value));
        match tag.as_str() {
            "CURDEF" => {
                let currency = value().unwrap_or_default();
                if !currency.eq_ignore_ascii_case("GBP") {
                    errors.push(line, format!("Not in pounds: {currency}"));
                }
            }
            "ACCTID" if parsed.source_account.is_none() => parsed.source_account = value(),
            "STMTTRN" => {
                if let Some(t) = current.take() {
                    finish(t, &mut parsed, &mut errors);
                }
                current = Some(Transaction {
                    line,
                    ..Transaction::default()
                });
            }
            "/STMTTRN" | "/BANKTRANLIST" => {
                if let Some(t) = current.take() {
                    finish(t, &mut parsed, &mut errors);
                }
            }
            _ => {
                let Some(t) = current.as_mut() else { continue };
                let slot = match tag.as_str() {
                    "DTPOSTED" => &mut t.posted,
                    "TRNAMT" => &mut t.amount,
                    "FITID" => &mut t.fitid,
                    "NAME" => &mut t.name,
                    "MEMO" => &mut t.memo,
                    "REFNUM" | "CHECKNUM" => &mut t.refnum,
                    _ => continue,
                };
                if slot.is_none() {
                    *slot = value();
                }
            }
        }
    }
    if let Some(t) = current.take() {
        finish(t, &mut parsed, &mut errors);
    }
    errors.finish(parsed)
}

/// What one `<STMTTRN>` is.
fn transaction(t: &Transaction) -> Result<Movement, String> {
    let posted = t.posted.as_deref().ok_or("No DTPOSTED")?;
    let amount = t.amount.as_deref().ok_or("No TRNAMT")?;
    let posted_on = dates::ofx(posted)?;
    let amount = parse_pence(amount, Decimal::PointOrComma)?.unwrap_or(0);
    if amount < 0 {
        return Ok(Movement::Debit);
    }
    if amount == 0 {
        return Ok(Movement::Zero);
    }
    Ok(Movement::Credit(CreditLine {
        line: t.line,
        posted_on,
        amount,
        payer: t.name.clone(),
        reference: t.refnum.clone(),
        narrative: join([t.name.as_deref(), t.memo.as_deref()].into_iter().flatten()),
        bank_id: t.fitid.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SGML: &str = "OFXHEADER:100\nDATA:OFXSGML\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><STMTRS>\n\
        <CURDEF>GBP\n<BANKTRANLIST>\n\
        <STMTTRN>\n<TRNTYPE>CREDIT\n<DTPOSTED>20261103\n<TRNAMT>10.00\n<FITID>A1\n<NAME>J SMITH\n<MEMO>100016\n\
        <STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20261104\n<TRNAMT>-25.00\n<FITID>A2\n<NAME>ACME\n\
        </BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n";

    #[test]
    fn sgml_without_closing_tags() {
        let p = read(SGML).unwrap();
        assert_eq!(p.debits_dropped, 1);
        assert_eq!(p.credits.len(), 1);
        let c = &p.credits[0];
        assert_eq!(
            (c.line, c.posted_on.as_str(), c.amount),
            (8, "2026-11-03", 1000)
        );
        assert_eq!(c.bank_id.as_deref(), Some("A1"));
        assert_eq!(c.payer.as_deref(), Some("J SMITH"));
        assert_eq!(c.narrative, "J SMITH 100016");
    }

    #[test]
    fn xml_with_closing_tags_and_entities() {
        let xml = "<?xml version=\"1.0\"?><OFX><CURDEF>GBP</CURDEF><BANKTRANLIST>\
            <STMTTRN><DTPOSTED>20261103120000[0:GMT]</DTPOSTED><TRNAMT>12,50</TRNAMT>\
            <FITID>X</FITID><NAME>SMITH &amp; CO</NAME></STMTTRN></BANKTRANLIST></OFX>";
        let p = read(xml).unwrap();
        assert_eq!(p.credits[0].amount, 1250);
        assert_eq!(p.credits[0].payer.as_deref(), Some("SMITH & CO"));
    }

    #[test]
    fn one_account_per_file_and_its_id_is_kept() {
        let one = SGML.replace(
            "<CURDEF>GBP",
            "<CURDEF>GBP\n<BANKACCTFROM><BANKID>200000<ACCTID>12345678</BANKACCTFROM>",
        );
        assert_eq!(
            read(&one).unwrap().source_account.as_deref(),
            Some("12345678")
        );
        let two = SGML.replace(
            "</STMTRS>",
            "</STMTRS><STMTRS><CURDEF>GBP<BANKTRANLIST></BANKTRANLIST></STMTRS>",
        );
        let errors = read(&two).unwrap_err();
        assert_eq!(errors[0].line, 0);
        assert!(errors[0].message.contains("2 accounts"), "{errors:?}");
    }

    #[test]
    fn zero_amounts_are_skipped_not_debits() {
        let zero = SGML.replace("<TRNAMT>-25.00", "<TRNAMT>-0.00");
        let p = read(&zero).unwrap();
        assert_eq!((p.debits_dropped, p.rows_skipped), (0, 1));
    }

    #[test]
    fn bad_transactions_and_other_currencies_refuse_the_file() {
        let bad = SGML.replace("<TRNAMT>10.00", "<TRNAMT>ten");
        assert_eq!(read(&bad).unwrap_err()[0].line, 8);
        let usd = SGML.replace("<CURDEF>GBP", "<CURDEF>USD");
        assert_eq!(read(&usd).unwrap_err()[0].line, 6);
        assert_eq!(read("Date,Amount\n").unwrap_err()[0].line, 0);
    }
}
