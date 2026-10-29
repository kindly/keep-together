//! The dated chain's pure rules (ADR 0026), mirrored line for line in
//! `src/lib/domain/regular-terms.ts`: which row is in force, how an
//! upgrade, a downgrade or a different collected amount moves the split
//! across source codes, what kind of change a row is, and the periods a
//! chain expects. Pence only, and nothing here divides (rule 7): a split
//! moves by whole layers, newest money first.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::regular::Frequency;

/// One layer of a split: pence to a source code (a version). Layers are
/// in order, oldest money first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "TermShare")]
pub struct Share {
    pub source_code_id: String,
    #[ts(type = "number")]
    pub amount: i64,
}

impl Share {
    pub fn new(code: &str, amount: i64) -> Self {
        Self {
            source_code_id: code.to_owned(),
            amount,
        }
    }
}

/// What a terms row says, as the rules read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    /// The first payment it governs (ISO date): `applies_from` when the
    /// change missed its intended payment, else `effective_from`.
    pub effective_on: String,
    pub amount: i64,
    pub frequency: Frequency,
    pub day_of_month: u8,
    pub month: Option<u8>,
    pub split: Vec<Share>,
}

/// The total of a split, `None` past `i64`.
pub fn total(split: &[Share]) -> Option<i64> {
    split.iter().try_fold(0i64, |sum, s| sum.checked_add(s.amount))
}

/// The row in force on `date` (ISO): the last whose `effective_on` is on
/// or before it. `chain` is in effective order.
pub fn term_in_force<'a>(chain: &'a [Terms], date: &str) -> Option<&'a Terms> {
    chain
        .iter()
        .rev()
        .find(|t| t.effective_on.as_str() <= date)
}

/// A new total of `new_amount`, at least the split's: the difference goes
/// to `code` as a new last layer, merged into the last layer if that is
/// already `code`. The existing layers are kept.
pub fn upgrade_split(split: &[Share], new_amount: i64, code: &str) -> Vec<Share> {
    let mut out = split.to_vec();
    let diff = new_amount - total(split).unwrap_or(new_amount);
    if diff <= 0 {
        return out;
    }
    match out.last_mut() {
        Some(last) if last.source_code_id == code => last.amount += diff,
        _ => out.push(Share::new(code, diff)),
    }
    out
}

/// A new total of `new_amount` (over 0), at most the split's: pence come
/// off the last layer first, then the one before, and a layer left with
/// nothing goes.
pub fn downgrade_split(split: &[Share], new_amount: i64) -> Vec<Share> {
    let mut out = split.to_vec();
    let mut cut = total(split).unwrap_or(new_amount) - new_amount;
    while cut > 0 {
        let Some(last) = out.last_mut() else { break };
        if last.amount > cut {
            last.amount -= cut;
            cut = 0;
        } else {
            cut -= last.amount;
            out.pop();
        }
    }
    out
}

/// The split a payment of `collected` pence takes from the row in force:
/// less than its amount comes off the newest layer first
/// ([`downgrade_split`]); more goes on the newest layer.
pub fn split_for_collected(split: &[Share], collected: i64) -> Vec<Share> {
    let held = total(split).unwrap_or(collected);
    if collected <= held {
        return downgrade_split(split, collected);
    }
    match split.last() {
        Some(last) => upgrade_split(split, collected, &last.source_code_id.clone()),
        None => vec![],
    }
}

/// A year's worth of `amount` at `frequency`, in pence.
pub fn annual_value(amount: i64, frequency: Frequency) -> i64 {
    match frequency {
        Frequency::Monthly => amount.saturating_mul(12),
        Frequency::Yearly => amount,
    }
}

/// What a row changed, from the one before it (derived, never chosen).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "TermChangeKind")]
pub enum ChangeKind {
    /// The first row: the gift as set up.
    Setup,
    /// More a year.
    Upgrade,
    /// Less a year.
    Downgrade,
    /// The same a year, collected on another day or frequency.
    Schedule,
    /// The same money and schedule, split differently.
    Reallocation,
    /// Nothing changed.
    Unchanged,
}

/// Annual value first, then the schedule, then the split.
pub fn change_kind(old: Option<&Terms>, new: &Terms) -> ChangeKind {
    let Some(old) = old else {
        return ChangeKind::Setup;
    };
    let (was, now) = (
        annual_value(old.amount, old.frequency),
        annual_value(new.amount, new.frequency),
    );
    if now > was {
        ChangeKind::Upgrade
    } else if now < was {
        ChangeKind::Downgrade
    } else if (old.frequency, old.day_of_month, old.month)
        != (new.frequency, new.day_of_month, new.month)
    {
        ChangeKind::Schedule
    } else if old.split != new.split {
        ChangeKind::Reallocation
    } else {
        ChangeKind::Unchanged
    }
}

// ── dates, as months ───────────────────────────────────────────────────────

/// `YYYY-MM-DD` (or `YYYY-MM`) as a month count: year × 12 + month − 1.
pub fn month_index(date: &str) -> Option<i32> {
    let y: i32 = date.get(0..4)?.parse().ok()?;
    let m: i32 = date.get(5..7)?.parse().ok()?;
    (1..=12).contains(&m).then_some(y * 12 + m - 1)
}

/// Days since 1970-01-01 of an ISO date (Howard Hinnant's
/// `days_from_civil`).
pub fn day_number(date: &str) -> Option<i64> {
    let y: i64 = date.get(0..4)?.parse().ok()?;
    let m: i64 = date.get(5..7)?.parse().ok()?;
    let d: i64 = date.get(8..10)?.parse().ok()?;
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// The ISO date `days` after 1970-01-01 (`civil_from_days`).
pub fn date_of_day(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The UTC date of a moment (ms since the epoch).
pub fn date_of_ms(ms: i64) -> String {
    date_of_day(ms.div_euclid(86_400_000))
}

/// `date` moved by `days` (negative: earlier).
pub fn add_days(date: &str, days: i64) -> Option<String> {
    Some(date_of_day(day_number(date)? + days))
}

/// A month count as `YYYY-MM`.
pub fn month_label(index: i32) -> String {
    format!("{:04}-{:02}", index.div_euclid(12), index.rem_euclid(12) + 1)
}

/// Day `day` of month `index`, as an ISO date (days 1–28: every month
/// has them).
pub fn day_in(index: i32, day: u8) -> String {
    format!("{}-{day:02}", month_label(index))
}

/// When `t` is due in month `index`, if it is due that month at all.
fn due_in(t: &Terms, index: i32) -> Option<String> {
    match t.frequency {
        Frequency::Monthly => Some(day_in(index, t.day_of_month)),
        Frequency::Yearly => (t.month.map(i32::from) == Some(index.rem_euclid(12) + 1))
            .then(|| day_in(index, t.day_of_month)),
    }
}

/// The due dates after `date` (ISO) under `t`, at most `n`, from the
/// month `date` is in: the payments a schedule would make next.
pub fn next_due(t: &Terms, date: &str, n: usize) -> Vec<String> {
    let Some(mut index) = month_index(date) else {
        return vec![];
    };
    let mut out = Vec::new();
    // A yearly row is due once in any 12 months: at most 12·(n + 1)
    // steps of a month.
    let mut guard = 0;
    while out.len() < n && guard < 12 * (n + 1) {
        if let Some(due) = due_in(t, index)
            && due.as_str() > date
        {
            out.push(due);
        }
        index += 1;
        guard += 1;
    }
    out
}

/// One period a chain expects a payment in.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExpectedPeriod {
    /// `YYYY-MM`: the month it is due in (gifts match by the month of
    /// their `scheduled_on`).
    pub period: String,
    pub due_on: String,
    pub amount: i64,
    pub split: Vec<Share>,
    /// Which row of the chain (its index) governs it.
    pub row: usize,
}

/// The payments `chain` (in effective order) expects with due dates from
/// `from` to `to` (ISO dates, both included), and before `ended_on` (the
/// day it was cancelled: nothing is expected from then). A row governs
/// the months from the month of its `effective_on` until the next row's:
/// a monthly row expects one payment a month, on its day; a yearly row
/// one in its month.
pub fn expected_periods(
    chain: &[Terms],
    ended_on: Option<&str>,
    from: &str,
    to: &str,
) -> Vec<ExpectedPeriod> {
    let (Some(first), Some(last)) = (month_index(from), month_index(to)) else {
        return vec![];
    };
    let starts: Vec<Option<i32>> = chain.iter().map(|t| month_index(&t.effective_on)).collect();
    let mut out = Vec::new();
    for index in first..=last {
        let Some(row) = starts.iter().rposition(|s| s.is_some_and(|s| s <= index)) else {
            continue;
        };
        let t = &chain[row];
        let Some(due) = due_in(t, index) else {
            continue;
        };
        if due.as_str() < from || due.as_str() > to {
            continue;
        }
        if ended_on.is_some_and(|e| due.as_str() >= e) {
            break;
        }
        out.push(ExpectedPeriod {
            period: month_label(index),
            due_on: due,
            amount: t.amount,
            split: t.split.clone(),
            row,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREET: &str = "street";
    const TEL: &str = "telephone";

    fn street10() -> Vec<Share> {
        vec![Share::new(STREET, 1000)]
    }

    fn terms(on: &str, amount: i64, split: Vec<Share>) -> Terms {
        Terms {
            effective_on: on.into(),
            amount,
            frequency: Frequency::Monthly,
            day_of_month: 5,
            month: None,
            split,
        }
    }

    #[test]
    fn an_upgrade_gives_the_difference_to_the_code_that_won_it() {
        assert_eq!(
            upgrade_split(&street10(), 1200, TEL),
            [Share::new(STREET, 1000), Share::new(TEL, 200)]
        );
        // Merged into the last layer when it is that code already.
        assert_eq!(
            upgrade_split(&[Share::new(STREET, 1000), Share::new(TEL, 200)], 1500, TEL),
            [Share::new(STREET, 1000), Share::new(TEL, 500)]
        );
        assert_eq!(upgrade_split(&street10(), 1000, TEL), street10());
    }

    #[test]
    fn a_downgrade_comes_off_the_newest_money_first() {
        let split = [Share::new(STREET, 1000), Share::new(TEL, 200)];
        assert_eq!(
            downgrade_split(&split, 1100),
            [Share::new(STREET, 1000), Share::new(TEL, 100)]
        );
        assert_eq!(downgrade_split(&split, 800), [Share::new(STREET, 800)]);
        assert_eq!(downgrade_split(&split, 1000), [Share::new(STREET, 1000)]);
    }

    #[test]
    fn a_payment_copies_the_split_with_the_newest_layer_absorbing_the_difference() {
        let split = [Share::new(STREET, 1000), Share::new(TEL, 200)];
        assert_eq!(split_for_collected(&split, 1000), [Share::new(STREET, 1000)]);
        assert_eq!(
            split_for_collected(&split, 1300),
            [Share::new(STREET, 1000), Share::new(TEL, 300)]
        );
        assert_eq!(split_for_collected(&split, 1200), split);
    }

    #[test]
    fn every_split_sums_to_its_amount() {
        let split = [
            Share::new(STREET, 700),
            Share::new(TEL, 250),
            Share::new("mail", 51),
        ];
        for amount in 1..=2000 {
            let up = upgrade_split(&split, amount.max(1001), TEL);
            assert_eq!(total(&up), Some(amount.max(1001)));
            let down = downgrade_split(&split, amount.min(1001));
            assert_eq!(total(&down), Some(amount.min(1001)));
            let got = split_for_collected(&split, amount);
            assert_eq!(total(&got), Some(amount));
            assert!(got.iter().all(|s| s.amount > 0));
        }
    }

    #[test]
    fn the_row_in_force_includes_its_effective_date() {
        let chain = [
            terms("2026-01-05", 1000, street10()),
            terms("2026-12-05", 1200, vec![]),
        ];
        assert_eq!(term_in_force(&chain, "2026-01-04"), None);
        assert_eq!(term_in_force(&chain, "2026-12-04").unwrap().amount, 1000);
        assert_eq!(term_in_force(&chain, "2026-12-05").unwrap().amount, 1200);
        assert_eq!(term_in_force(&chain, "2027-03-05").unwrap().amount, 1200);
    }

    #[test]
    fn the_change_kind_is_by_annual_value_then_schedule_then_split() {
        let old = terms("2026-01-05", 1000, street10());
        let up = terms("2026-12-05", 1200, vec![]);
        assert_eq!(change_kind(None, &old), ChangeKind::Setup);
        assert_eq!(change_kind(Some(&old), &up), ChangeKind::Upgrade);
        assert_eq!(change_kind(Some(&up), &old), ChangeKind::Downgrade);
        let yearly = Terms {
            amount: 12_000,
            frequency: Frequency::Yearly,
            month: Some(3),
            ..old.clone()
        };
        assert_eq!(change_kind(Some(&old), &yearly), ChangeKind::Schedule);
        let day = Terms {
            day_of_month: 20,
            ..old.clone()
        };
        assert_eq!(change_kind(Some(&old), &day), ChangeKind::Schedule);
        let moved = Terms {
            split: vec![Share::new(TEL, 1000)],
            ..old.clone()
        };
        assert_eq!(change_kind(Some(&old), &moved), ChangeKind::Reallocation);
        assert_eq!(change_kind(Some(&old), &old), ChangeKind::Unchanged);
        assert_eq!(annual_value(200, Frequency::Monthly), 2400);
        assert_eq!(annual_value(200, Frequency::Yearly), 200);
    }

    #[test]
    fn expected_periods_follow_the_row_in_force_and_stop_at_cancellation() {
        let chain = [
            terms("2026-09-05", 1000, street10()),
            terms(
                "2026-12-05",
                1200,
                vec![Share::new(STREET, 1000), Share::new(TEL, 200)],
            ),
        ];
        let got = expected_periods(&chain, None, "2026-08-01", "2027-01-31");
        let amounts: Vec<(&str, i64)> = got.iter().map(|p| (p.period.as_str(), p.amount)).collect();
        assert_eq!(
            amounts,
            [
                ("2026-09", 1000),
                ("2026-10", 1000),
                ("2026-11", 1000),
                ("2026-12", 1200),
                ("2027-01", 1200)
            ]
        );
        assert_eq!(got[3].due_on, "2026-12-05");
        assert_eq!(got[3].row, 1);
        // Cancelled on 10 November: nothing from the November due date on
        // if it came after, and nothing at all after.
        let ended = expected_periods(&chain, Some("2026-11-03"), "2026-08-01", "2027-01-31");
        assert_eq!(ended.len(), 2);
        // A yearly row expects one payment in its month.
        let yearly = [Terms {
            frequency: Frequency::Yearly,
            month: Some(3),
            ..terms("2026-03-05", 12_000, vec![Share::new(STREET, 12_000)])
        }];
        let got = expected_periods(&yearly, None, "2026-01-01", "2028-12-31");
        assert_eq!(
            got.iter().map(|p| p.due_on.as_str()).collect::<Vec<_>>(),
            ["2026-03-05", "2027-03-05", "2028-03-05"]
        );
    }

    #[test]
    fn next_due_lists_the_coming_payment_dates() {
        let t = terms("2026-09-05", 1000, street10());
        assert_eq!(
            next_due(&t, "2026-10-05", 3),
            ["2026-11-05", "2026-12-05", "2027-01-05"]
        );
        assert_eq!(next_due(&t, "2026-10-04", 1), ["2026-10-05"]);
        assert_eq!(month_label(month_index("2026-12-31").unwrap() + 1), "2027-01");
    }

    #[test]
    fn dates_count_in_days() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(date_of_day(day_number("2024-02-28").unwrap() + 1), "2024-02-29");
        assert_eq!(add_days("2026-12-05", -14).as_deref(), Some("2026-11-21"));
        assert_eq!(add_days("2026-12-25", 10).as_deref(), Some("2027-01-04"));
        assert_eq!(date_of_ms(1_793_000_000_000), "2026-10-26");
    }
}
