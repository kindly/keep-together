//! The gift's blocking checks (tier 1, ADR 0015), pure
//! (`convex/giving/rules.ts`).

use contracts::{ContractError, Problem, mint_ids};

use crate::types::{GiftPayload, Method};

/// Most source codes one gift is split across.
pub const ALLOCATION_LIMIT: usize = 20;

/// Longest card reference kept (a receipt or transaction id).
pub const REFERENCE_MAX: usize = 200;

/// Whether `value` is a real calendar date written YYYY-MM-DD.
pub fn is_iso_date(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let num = |r: std::ops::Range<usize>| {
        b[r.clone()]
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| value[r].parse::<u32>().ok())
            .flatten()
    };
    let (Some(y), Some(m), Some(d)) = (num(0..4), num(5..7), num(8..10)) else {
        return false;
    };
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&d)
}

/// Normalise a gift and refuse what can't be stored: an amount of 0 or
/// less, a date that isn't one, allocations missing, not positive or not
/// summing to the amount, or a reference on a cash gift. Mints missing
/// allocation keys; an empty reference is none.
pub fn prepare_gift(mut p: GiftPayload) -> Result<GiftPayload, ContractError> {
    let mut problems = Vec::new();
    p.reference = p
        .reference
        .map(|r| r.trim().to_owned())
        .filter(|r| !r.is_empty());
    p.received_on = p.received_on.trim().to_owned();
    if p.amount <= 0 {
        problems.push(Problem::new("amount", "The amount must be over £0"));
    }
    if !is_iso_date(&p.received_on) {
        problems.push(Problem::new("receivedOn", "Dates are YYYY-MM-DD"));
    }
    if p.reference.is_some() && p.method != Method::Card {
        problems.push(Problem::new(
            "reference",
            "Only a card payment has a reference",
        ));
    }
    if p
        .reference
        .as_deref()
        .is_some_and(|r| r.chars().count() > REFERENCE_MAX)
    {
        problems.push(Problem::new(
            "reference",
            format!("At most {REFERENCE_MAX} characters"),
        ));
    }
    if p.allocations.is_empty() {
        problems.push(Problem::new("allocations", "Pick a source code"));
    } else if p.allocations.len() > ALLOCATION_LIMIT {
        problems.push(Problem::new(
            "allocations",
            format!("At most {ALLOCATION_LIMIT} source codes"),
        ));
    }
    mint_ids(&mut p.allocations, |a| &mut a.key);
    let keys: std::collections::HashSet<_> = p.allocations.iter().map(|a| &a.key).collect();
    if keys.len() != p.allocations.len() {
        problems.push(Problem::new("allocations", "Duplicate row key"));
    }
    if p.allocations.iter().any(|a| a.amount <= 0) {
        problems.push(Problem::new("allocations", "Each share must be over £0"));
    }
    // Checked so a sum past i64 is "doesn't add up", never a wrap.
    let total = p
        .allocations
        .iter()
        .try_fold(0i64, |sum, a| sum.checked_add(a.amount));
    if !p.allocations.is_empty() && total != Some(p.amount) {
        problems.push(Problem::new(
            "allocations",
            "The shares must add up to the amount",
        ));
    }
    if problems.is_empty() {
        Ok(p)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// Pence as pounds for names and messages: `£20`, `£20.50`, `£1,250`.
pub fn format_pence(amount: i64) -> String {
    let sign = if amount < 0 { "-" } else { "" };
    let abs = amount.unsigned_abs();
    let digits = (abs / 100).to_string();
    let mut pounds = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            pounds.push(',');
        }
        pounds.push(c);
    }
    match abs % 100 {
        0 => format!("{sign}£{pounds}"),
        pence => format!("{sign}£{pounds}.{pence:02}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AllocationRow;

    fn row(code: &str, amount: i64) -> AllocationRow {
        AllocationRow {
            key: None,
            source_code_id: code.into(),
            amount,
        }
    }

    fn gift(amount: i64) -> GiftPayload {
        GiftPayload {
            contact_id: "c".into(),
            received_on: "2026-10-20".into(),
            amount,
            method: Method::Cash,
            reference: None,
            allocations: vec![row("v", amount)],
            client_key: None,
        }
    }

    fn fields(p: GiftPayload) -> Vec<String> {
        match prepare_gift(p) {
            Err(ContractError::Invalid(problems)) => {
                problems.into_iter().map(|p| p.field).collect()
            }
            other => panic!("expected invalid, got {other:?}"),
        }
    }

    #[test]
    fn dates() {
        assert!(is_iso_date("2024-02-29"));
        assert!(!is_iso_date("2026-02-29"));
        assert!(!is_iso_date("2026-1-01"));
        assert!(!is_iso_date("2026-00-01"));
    }

    #[test]
    fn format_pence_groups_thousands_and_shows_pence_only_when_there_are_some() {
        assert_eq!(format_pence(2000), "£20");
        assert_eq!(format_pence(2050), "£20.50");
        assert_eq!(format_pence(123_456_705), "£1,234,567.05");
        assert_eq!(format_pence(100_000), "£1,000");
        assert_eq!(format_pence(5), "£0.05");
        assert_eq!(format_pence(-2050), "-£20.50");
    }

    #[test]
    fn mints_keys_and_tidies_the_reference() {
        let p = prepare_gift(GiftPayload {
            method: Method::Card,
            reference: Some("  SUMUP-123 ".into()),
            ..gift(2000)
        })
        .unwrap();
        assert_eq!(p.reference.as_deref(), Some("SUMUP-123"));
        assert!(contracts::is_client_id(p.allocations[0].key.as_deref().unwrap()));
        let blank = prepare_gift(GiftPayload {
            method: Method::Card,
            reference: Some(" ".into()),
            ..gift(2000)
        })
        .unwrap();
        assert_eq!(blank.reference, None);
    }

    #[test]
    fn refusals_name_their_field() {
        let split = |a, b| vec![row("v", a), row("w", b)];
        assert_eq!(fields(gift(0)), ["amount", "allocations"]);
        assert!(fields(gift(-100)).contains(&"amount".to_owned()));
        assert_eq!(
            fields(GiftPayload {
                received_on: "2026-02-30".into(),
                ..gift(2000)
            }),
            ["receivedOn"]
        );
        assert_eq!(
            fields(GiftPayload {
                allocations: vec![],
                ..gift(2000)
            }),
            ["allocations"]
        );
        assert_eq!(
            fields(GiftPayload {
                allocations: split(1500, 400),
                ..gift(2000)
            }),
            ["allocations"]
        );
        assert!(
            fields(GiftPayload {
                allocations: split(2000, 0),
                ..gift(2000)
            })
            .contains(&"allocations".to_owned())
        );
        assert_eq!(
            fields(GiftPayload {
                reference: Some("R1".into()),
                ..gift(2000)
            }),
            ["reference"]
        );
        assert_eq!(
            fields(GiftPayload {
                allocations: (0..21).map(|_| row("v", 1)).collect(),
                ..gift(21)
            }),
            ["allocations"]
        );
        assert_eq!(
            fields(GiftPayload {
                allocations: vec![row("v", i64::MAX), row("w", 2)],
                ..gift(1)
            }),
            ["allocations"]
        );
    }

    #[test]
    fn a_duplicate_row_key_is_refused() {
        let k = "0".repeat(32);
        let p = fields(GiftPayload {
            allocations: vec![
                AllocationRow {
                    key: Some(k.clone()),
                    ..row("v", 1000)
                },
                AllocationRow {
                    key: Some(k),
                    ..row("w", 1000)
                },
            ],
            ..gift(2000)
        });
        assert_eq!(p, ["allocations"]);
    }
}
