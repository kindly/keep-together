//! Each preset and format reads its hand-made sample file
//! (`tests/fixtures/`) to the expected credits. The samples follow the
//! layouts the presets were written from, not real exports: replace each
//! with a group's anonymised file when one arrives, and mark the preset
//! verified.

use banking::{CreditLine, Format, Held, dedupe, preset, presets, read};

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn read_preset(id: &str) -> banking::Parsed {
    let mapping = preset(id).unwrap().mapping;
    read(&fixture(&format!("{id}.csv")), &Format::Csv { mapping })
        .unwrap_or_else(|e| panic!("{id}: {e:?}"))
}

fn summary(credits: &[CreditLine]) -> Vec<(&str, i64, &str)> {
    credits
        .iter()
        .map(|c| (c.posted_on.as_str(), c.amount, c.narrative.as_str()))
        .collect()
}

#[test]
fn every_preset_has_a_sample_file() {
    for p in presets() {
        let parsed = read_preset(p.id);
        assert!(!parsed.credits.is_empty(), "{}", p.id);
        assert!(parsed.debits_dropped > 0, "{}: the sample should hold a debit", p.id);
    }
}

#[test]
fn natwest_bankline_statement() {
    let p = read_preset("natwest-bankline-statement");
    assert_eq!(
        summary(&p.credits),
        [
            ("2026-11-02", 2500, "J SMITH 100016 DONATION FP 02/11/26 1032"),
            ("2026-11-03", 1000, "A JONES STANDING ORDER"),
            ("2026-11-03", 1000, "A JONES STANDING ORDER"),
            ("2026-11-04", 125_000, "SMITH, P & R GIFT"),
        ]
    );
    assert_eq!(p.debits_dropped, 1);
    assert!(p.credits.iter().all(|c| c.bank_id.is_none()));
}

#[test]
fn natwest_bankline_search_has_the_bank_reference() {
    let p = read_preset("natwest-bankline-search");
    assert_eq!(p.credits.len(), 2);
    assert_eq!(p.credits[0].bank_id.as_deref(), Some("NW0000000000101"));
    assert_eq!(p.credits[1].amount, 1000);
}

#[test]
fn barclays_signed_amounts_and_tabbed_memo() {
    let p = read_preset("barclays");
    assert_eq!(
        summary(&p.credits),
        [
            ("2026-11-02", 2500, "J SMITH 100016 DONATION BGC"),
            ("2026-11-03", 1000, "A JONES SO STO"),
        ]
    );
}

#[test]
fn lloyds_credit_and_debit_columns() {
    let p = read_preset("lloyds");
    assert_eq!(
        summary(&p.credits),
        [
            ("2026-11-02", 2500, "J SMITH 100016 DONATION"),
            ("2026-11-03", 1000, "A JONES SO"),
        ]
    );
    assert_eq!(p.debits_dropped, 1);
}

#[test]
fn ofx_and_qif_samples() {
    let ofx = read(&fixture("statement.ofx"), &Format::Ofx).unwrap();
    let qif = read(&fixture("statement.qif"), &Format::Qif).unwrap();
    for (p, ids) in [(&ofx, true), (&qif, false)] {
        assert_eq!(
            summary(&p.credits),
            [
                ("2026-11-02", 2500, "J SMITH 100016 DONATION"),
                ("2026-11-03", 1000, "A JONES SO"),
            ]
        );
        assert_eq!(p.debits_dropped, 1);
        assert_eq!(p.credits[0].bank_id.is_some(), ids);
    }
    assert_eq!(ofx.credits[0].bank_id.as_deref(), Some("202611020001"));
    assert_eq!(ofx.date_range(), Some(("2026-11-02", "2026-11-03")));
}

#[test]
fn a_sample_imported_twice_keeps_its_two_identical_standing_orders() {
    let p = read_preset("natwest-bankline-statement");
    let mut held = Held::new();
    let first = dedupe(p.credits.clone(), &held);
    assert_eq!((first.new.len(), first.duplicates), (4, 0));
    for k in &first.new {
        held.add(&k.key, k.line.bank_id.as_deref());
    }
    let again = dedupe(p.credits, &held);
    assert_eq!((again.new.len(), again.duplicates), (0, 4));
}

#[test]
fn the_wrong_preset_refuses_the_file() {
    let lloyds = preset("lloyds").unwrap().mapping;
    let errors = read(&fixture("barclays.csv"), &Format::Csv { mapping: lloyds }).unwrap_err();
    assert_eq!(errors[0].line, 0);
    // NatWest's positions over Barclays' columns find no dates at all.
    let natwest = preset("natwest-bankline-statement").unwrap().mapping;
    let errors = read(&fixture("barclays.csv"), &Format::Csv { mapping: natwest }).unwrap_err();
    assert_eq!(errors[0].line, 0);
    assert_eq!(read(b"!Type:Bank\n", &Format::Qif).unwrap_err()[0].line, 0);
}
