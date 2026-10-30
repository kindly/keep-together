//! The gift's blocking checks (tier 1, ADR 0015), pure
//! (`convex/giving/rules.ts`).

use contracts::{ContractError, Problem, mint_ids};

use crate::types::{BatchStatus, GiftPayload, Method, PayingInBatchPayload, StatusPayload};

/// Most source codes one gift is split across.
pub const ALLOCATION_LIMIT: usize = 20;

/// Longest reference kept (a receipt or transaction id, a donor's bank
/// reference, a cheque number).
pub const REFERENCE_MAX: usize = 200;
/// The most pence an amount may be: 2^53 − 1, the largest integer a
/// JavaScript number holds exactly. Pence travel as JSON numbers, so a
/// larger one would reach the SPA rounded (codex C1 #9).
pub const PENCE_MAX: i64 = (1 << 53) - 1;
/// The widest a client key may be (characters): the SPA mints 32 hex;
/// imports and seeds use their own keys.
pub const CLIENT_KEY_MAX: usize = 200;

/// The most staff may charge a donor once through GoCardless (a one-off
/// on a mandate, an Instant Bank Pay link): £1,000. More is a bank
/// transfer: a mistyped amount on a Direct Debit is the donor's money
/// gone before anyone notices. For everyone, admins included.
pub const ONE_OFF_MAX: i64 = 100_000;

/// The refusal for a one-off over [`ONE_OFF_MAX`].
pub const ONE_OFF_MAX_MESSAGE: &str =
    "At most £1,000 can be taken this way: for more, ask the donor for a bank transfer";

/// Longest void reason kept.
pub const VOID_REASON_MAX: usize = 1000;

/// A void reason trimmed (blank = none) and at most [`VOID_REASON_MAX`]
/// characters; whether one is needed is the contract's call (it knows
/// whether the gift is claimed).
pub fn prepare_status(mut p: StatusPayload) -> Result<StatusPayload, ContractError> {
    p.reason = p
        .reason
        .map(|r| r.trim().to_owned())
        .filter(|r| !r.is_empty());
    if p.reason
        .as_ref()
        .is_some_and(|r| r.chars().count() > VOID_REASON_MAX)
    {
        return Err(ContractError::invalid(
            "reason",
            format!("At most {VOID_REASON_MAX} characters"),
        ));
    }
    Ok(p)
}

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
/// less or over [`PENCE_MAX`], a date that isn't one, allocations missing, not positive or not
/// summing to the amount, a reference on a cash gift, a Direct
/// Debit gift without its payment id, a gift from a statement line that
/// isn't a bank transfer, or a batch gift that isn't cash or a cheque.
/// Mints missing allocation keys; an empty reference is none.
pub fn prepare_gift(mut p: GiftPayload) -> Result<GiftPayload, ContractError> {
    let mut problems = Vec::new();
    p.reference = p
        .reference
        .map(|r| r.trim().to_owned())
        .filter(|r| !r.is_empty());
    p.received_on = p.received_on.trim().to_owned();
    if p.client_key
        .as_ref()
        .is_some_and(|k| contacts::rules::too_long(k, CLIENT_KEY_MAX))
    {
        problems.push(Problem::new(
            "clientKey",
            format!("At most {CLIENT_KEY_MAX} characters"),
        ));
    }
    if p.amount <= 0 {
        problems.push(Problem::new("amount", "The amount must be over £0"));
    } else if p.amount > PENCE_MAX {
        problems.push(Problem::new("amount", "The amount is too large"));
    }
    if !is_iso_date(&p.received_on) {
        problems.push(Problem::new("receivedOn", "Dates are YYYY-MM-DD"));
    }
    if p.reference.is_some() && p.method == Method::Cash {
        problems.push(Problem::new("reference", "A cash gift has no reference"));
    }
    if p.from_line.is_some() && (p.method != Method::BankTransfer || p.origin.is_some()) {
        problems.push(Problem::new(
            "method",
            "A gift from a statement line is a bank transfer",
        ));
    }
    if p.instalment.is_some() && (p.method != Method::BankTransfer || p.origin.is_some()) {
        problems.push(Problem::new(
            "method",
            "A standing-order payment is a bank transfer",
        ));
    }
    if p.instalment
        .as_ref()
        .is_some_and(|i| !is_iso_date(&i.scheduled_on))
    {
        problems.push(Problem::new("instalment", "Dates are YYYY-MM-DD"));
    }
    if p.paying_in_batch_id.is_some() && !p.method.is_paid_in() {
        problems.push(Problem::new(
            "payingInBatchId",
            "Only cash and cheques are paid in on a slip",
        ));
    }
    if p.reference.is_none() && p.method == Method::DirectDebit {
        problems.push(Problem::new(
            "reference",
            "A Direct Debit gift carries its payment's id",
        ));
    }
    if p.reference
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
    let shares_ok = if p.allocations.iter().any(|a| a.amount <= 0) {
        problems.push(Problem::new("allocations", "Each share must be over £0"));
        false
    } else if p.allocations.iter().any(|a| a.amount > PENCE_MAX) {
        problems.push(Problem::new("allocations", "A share is too large"));
        false
    } else {
        true
    };
    // Checked so a sum past i64 is "doesn't add up", never a wrap.
    let total = p
        .allocations
        .iter()
        .try_fold(0i64, |sum, a| sum.checked_add(a.amount));
    if shares_ok && !p.allocations.is_empty() && total != Some(p.amount) {
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

/// Longest paying-in slip number kept.
pub const SLIP_NUMBER_MAX: usize = 50;

/// Normalise a paying-in batch and refuse what can't be stored: a slip
/// number over [`SLIP_NUMBER_MAX`], a date that isn't one, a total of 0 or
/// less or over [`PENCE_MAX`], and a closed batch without its total and
/// date. A blank slip number is kept blank; a blank date is none.
pub fn prepare_batch(mut p: PayingInBatchPayload) -> Result<PayingInBatchPayload, ContractError> {
    let mut problems = Vec::new();
    p.slip_number = p.slip_number.trim().to_owned();
    p.banked_on = p
        .banked_on
        .map(|d| d.trim().to_owned())
        .filter(|d| !d.is_empty());
    if contacts::rules::too_long(&p.slip_number, SLIP_NUMBER_MAX) {
        problems.push(Problem::new(
            "slipNumber",
            format!("At most {SLIP_NUMBER_MAX} characters"),
        ));
    }
    if p.banked_on.as_deref().is_some_and(|d| !is_iso_date(d)) {
        problems.push(Problem::new("bankedOn", "Dates are YYYY-MM-DD"));
    }
    match p.total {
        Some(t) if t <= 0 => problems.push(Problem::new("total", "The total must be over £0")),
        Some(t) if t > PENCE_MAX => problems.push(Problem::new("total", "The total is too large")),
        _ => {}
    }
    if p.status != BatchStatus::Open {
        if p.total.is_none() {
            problems.push(Problem::new("total", "Enter the slip’s total to close it"));
        }
        if p.banked_on.is_none() {
            problems.push(Problem::new("bankedOn", "Enter the date it was paid in"));
        }
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
            from_line: None,
            paying_in_batch_id: None,
            instalment: None,
            origin: None,
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
        assert!(contracts::is_client_id(
            p.allocations[0].key.as_deref().unwrap()
        ));
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

    #[test]
    fn a_direct_debit_gift_carries_its_payment_id_and_cash_none() {
        let base = || GiftPayload {
            contact_id: "c".into(),
            received_on: "2026-10-20".into(),
            amount: 1000,
            method: Method::DirectDebit,
            reference: Some("PM123".into()),
            allocations: vec![crate::types::AllocationRow {
                key: None,
                source_code_id: "s".into(),
                amount: 1000,
            }],
            client_key: None,
            from_line: None,
            paying_in_batch_id: None,
            instalment: None,
            origin: None,
        };
        assert!(prepare_gift(base()).is_ok());
        let fields = |p| match prepare_gift(p) {
            Err(ContractError::Invalid(problems)) => {
                problems.into_iter().map(|p| p.field).collect::<Vec<_>>()
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(
            fields(GiftPayload {
                reference: None,
                ..base()
            }),
            ["reference"]
        );
        assert_eq!(
            fields(GiftPayload {
                method: Method::Cash,
                ..base()
            }),
            ["reference"]
        );
        assert_eq!(
            Method::parse(Method::DirectDebit.as_str()),
            Method::DirectDebit
        );
    }

    #[test]
    fn the_bank_methods_round_trip_and_only_cash_or_cheques_are_paid_in() {
        for m in [Method::BankTransfer, Method::Cheque] {
            assert_eq!(Method::parse(m.as_str()), m);
        }
        assert!(Method::Cash.is_paid_in() && Method::Cheque.is_paid_in());
        assert!(!Method::BankTransfer.is_paid_in() && !Method::Card.is_paid_in());
        let in_batch = |method| GiftPayload {
            method,
            paying_in_batch_id: Some("b".into()),
            ..gift(2000)
        };
        assert!(prepare_gift(in_batch(Method::Cheque)).is_ok());
        assert_eq!(fields(in_batch(Method::BankTransfer)), ["payingInBatchId"]);
        let from_line = |method| GiftPayload {
            method,
            from_line: Some("l".into()),
            ..gift(2000)
        };
        assert!(prepare_gift(from_line(Method::BankTransfer)).is_ok());
        assert_eq!(fields(from_line(Method::Cheque)), ["method"]);
    }

    #[test]
    fn batch_refusals_name_their_field() {
        let open = || PayingInBatchPayload {
            account_id: "a".into(),
            slip_number: " 000123 ".into(),
            banked_on: Some(" ".into()),
            total: None,
            status: BatchStatus::Open,
        };
        let p = prepare_batch(open()).unwrap();
        assert_eq!((p.slip_number.as_str(), p.banked_on), ("000123", None));
        let fields = |p| match prepare_batch(p) {
            Err(ContractError::Invalid(problems)) => {
                problems.into_iter().map(|p| p.field).collect::<Vec<_>>()
            }
            other => panic!("{other:?}"),
        };
        assert_eq!(
            fields(PayingInBatchPayload {
                slip_number: "1".repeat(SLIP_NUMBER_MAX + 1),
                ..open()
            }),
            ["slipNumber"]
        );
        assert_eq!(
            fields(PayingInBatchPayload {
                banked_on: Some("19/10/2026".into()),
                ..open()
            }),
            ["bankedOn"]
        );
        assert_eq!(
            fields(PayingInBatchPayload {
                status: BatchStatus::Closed,
                ..open()
            }),
            ["total", "bankedOn"]
        );
        let closed = PayingInBatchPayload {
            status: BatchStatus::Closed,
            total: Some(3000),
            banked_on: Some("2026-10-19".into()),
            ..open()
        };
        assert!(prepare_batch(closed).is_ok());
    }
}
