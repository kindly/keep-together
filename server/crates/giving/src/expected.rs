//! Expected against actual (ADR 0026): what each regular gift should
//! have brought in, period by period, derived from its dated chain and
//! never stored, beside what happened to the payment for that period
//! (matched by the month of its `scheduled_on`: a retry collected later
//! keeps its period).
//!
//! A regular gift expects payments from its first payment's period (or,
//! active with none yet, from its first row); a pending or failed set-up
//! with no payment expects nothing. Cancellation ends what is expected
//! from then on. A failed payment stays expected and unpaid (arrears);
//! a period with no payment once its day has passed is missing.
//!
//! The report sums the expected splits and the money received on the
//! matched gifts (their own allocations: staff may have corrected one) by
//! code, detail or category, and values upgrades and downgrades by the
//! code credited with them, annualised (the monthly figure beside it),
//! from the first payment collected at the new amount; one never
//! collected is "not realised".

use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::regular::{Frequency, RegularStatus};
use crate::terms::{self, TermView};
use crate::terms_rules::{
    self, ChangeKind, Share, annual_value, date_of_ms, expected_periods, month_index, month_label,
};
use crate::types::Status;

/// What happened in a period.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ExpectedStatus")]
pub enum PeriodStatus {
    /// Money received.
    Collected,
    /// GoCardless has the payment; not collected yet.
    Pending,
    /// Failed, charged back or refunded: arrears.
    Failed,
    /// The payment was cancelled.
    Cancelled,
    /// Its day has passed with no payment.
    Missing,
    /// Still to come.
    Upcoming,
}

/// One period of one regular gift.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExpectedRow {
    /// `YYYY-MM`.
    pub period: String,
    pub due_on: String,
    #[ts(type = "number")]
    pub expected: i64,
    pub split: Vec<Share>,
    /// The chain's row that governs it.
    pub term_id: String,
    pub status: PeriodStatus,
    /// The gift for the period's payment, if any.
    pub gift_id: Option<String>,
    /// What that payment is for (its amount, whatever its status).
    #[ts(type = "number | null")]
    pub amount: Option<i64>,
}

/// A regular gift's gift as matching reads it.
struct Paid {
    id: String,
    amount: i64,
    status: Status,
}

/// How much a status says about a period: a completed payment beats a
/// pending one, which beats a failed or cancelled one.
fn rank(s: Status) -> u8 {
    match s {
        Status::Completed => 3,
        Status::Pending => 2,
        Status::Failed | Status::ChargedBack | Status::Refunded => 1,
        _ => 0,
    }
}

/// The gifts of regular gift `id` by period (month of `scheduled_on`),
/// void ones (staff's mistakes) left out; the most telling per period.
fn paid_by_period(conn: &Connection, id: &str) -> rusqlite::Result<BTreeMap<String, Paid>> {
    let rows: Vec<(String, String, i64, String)> = conn
        .prepare_cached(
            "SELECT id, scheduled_on, amount, status FROM gifts INDEXED BY gifts_by_scheduled
             WHERE regular_gift_id = ?1 AND scheduled_on IS NOT NULL AND status <> 'void'
             ORDER BY scheduled_on, seq /* any status: each period marks what happened */",
        )?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out: BTreeMap<String, Paid> = BTreeMap::new();
    for (gift, scheduled, amount, status) in rows {
        let status = Status::parse(&status);
        let Some(period) = month_index(&scheduled).map(month_label) else {
            continue;
        };
        if out
            .get(&period)
            .is_some_and(|p| rank(p.status) >= rank(status))
        {
            continue;
        }
        out.insert(
            period,
            Paid {
                id: gift,
                amount,
                status,
            },
        );
    }
    Ok(out)
}

/// A regular gift's facts the expected side needs.
struct Gift {
    id: String,
    contact_id: String,
    status: RegularStatus,
    /// A standing order: expected from its first row, paid or not.
    standing: bool,
    ended_on: Option<String>,
    chain: Vec<TermView>,
}

fn gift(conn: &Connection, id: &str) -> rusqlite::Result<Option<Gift>> {
    let row: Option<(String, String, Option<i64>, String)> = conn
        .prepare_cached(
            "SELECT contact_id, status, ended_at, kind FROM regular_gifts WHERE id = ?1",
        )?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e),
        })?;
    let Some((contact_id, status, ended_at, kind)) = row else {
        return Ok(None);
    };
    let status = RegularStatus::parse(&status);
    Ok(Some(Gift {
        id: id.to_owned(),
        contact_id,
        status,
        standing: crate::regular::Kind::parse(&kind) == crate::regular::Kind::StandingOrder,
        ended_on: ended_at.filter(|_| status.is_ended()).map(date_of_ms),
        chain: terms::chain(conn, id)?,
    }))
}

/// The periods of `g` due from `from` to `to` (ISO dates) as of `today`.
fn rows_of(
    g: &Gift,
    paid: &BTreeMap<String, Paid>,
    from: &str,
    to: &str,
    today: &str,
) -> Vec<ExpectedRow> {
    let live: Vec<&TermView> = g.chain.iter().filter(|t| t.is_live()).collect();
    let rules: Vec<terms_rules::Terms> = live.iter().map(|t| t.rules()).collect();
    // Where expecting starts: its first payment's period, else (active
    // with none yet) its first row. A standing order is active from its
    // set-up, so from its first row (a payment missed before the first
    // one that came is still missed).
    let start = match paid.keys().next() {
        _ if g.standing => rules.first().map(|t| t.effective_on.clone()),
        Some(first) => Some(format!("{first}-01")),
        None if g.status == RegularStatus::Active => rules.first().map(|t| t.effective_on.clone()),
        None => None,
    };
    let Some(start) = start else {
        return vec![];
    };
    let from = if start.as_str() > from {
        start.as_str()
    } else {
        from
    };
    expected_periods(&rules, g.ended_on.as_deref(), from, to)
        .into_iter()
        .map(|p| {
            let found = paid.get(&p.period);
            let status = match found.map(|f| f.status) {
                Some(Status::Completed) => PeriodStatus::Collected,
                Some(Status::Pending) => PeriodStatus::Pending,
                Some(Status::Cancelled) => PeriodStatus::Cancelled,
                Some(_) => PeriodStatus::Failed,
                None if p.due_on.as_str() < today => PeriodStatus::Missing,
                None => PeriodStatus::Upcoming,
            };
            ExpectedRow {
                term_id: live[p.row].id.clone(),
                period: p.period,
                due_on: p.due_on,
                expected: p.amount,
                split: p.split,
                status,
                gift_id: found.map(|f| f.id.clone()),
                amount: found.map(|f| f.amount),
            }
        })
        .collect()
}

/// The first and last day of `YYYY-MM` months `from` and `to`.
pub fn month_range(from: &str, to: &str) -> Option<(String, String)> {
    let (a, b) = (month_index(from)?, month_index(to)?);
    let after = terms_rules::day_in(b + 1, 1);
    Some((
        terms_rules::day_in(a, 1),
        terms_rules::add_days(&after, -1)?,
    ))
}

/// Regular gift `id`'s periods due in months `from` ..= `to` (`YYYY-MM`)
/// as of `today` (ISO). `None`: no such regular gift.
pub fn for_regular_gift(
    conn: &Connection,
    id: &str,
    from: &str,
    to: &str,
    today: &str,
) -> rusqlite::Result<Option<Vec<ExpectedRow>>> {
    let Some(g) = gift(conn, id)? else {
        return Ok(None);
    };
    let Some((first, last)) = month_range(from, to) else {
        return Ok(Some(vec![]));
    };
    let paid = paid_by_period(conn, id)?;
    Ok(Some(rows_of(&g, &paid, &first, &last, today)))
}

/// How the report groups codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "ExpectedGrouping")]
pub enum By {
    Code,
    Detail,
    Category,
}

/// One code (or detail, or category) over the period range, in pence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExpectedLine {
    /// The version, detail or category id; `null` for changes credited
    /// to no code (upgrades only).
    pub id: Option<String>,
    pub label: String,
    #[ts(type = "number")]
    pub expected: i64,
    /// Money received on the periods' payments, by the gifts' own split.
    #[ts(type = "number")]
    pub received: i64,
    /// Expected on periods whose payment failed (arrears).
    #[ts(type = "number")]
    pub failed: i64,
    /// Expected on periods with no payment once due.
    #[ts(type = "number")]
    pub missing: i64,
    /// Expected on periods still pending or to come.
    #[ts(type = "number")]
    pub pending: i64,
}

/// Upgrades (and downgrades, negative) credited to one code, realised
/// in the range: from the first payment collected at the new amount.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpgradeLine {
    pub id: Option<String>,
    pub label: String,
    pub upgrades: u32,
    pub downgrades: u32,
    /// Change in annual value: monthly deltas × 12, yearly ones as they
    /// are.
    #[ts(type = "number")]
    pub annual: i64,
    /// The monthly figure (monthly gifts' changes only; a yearly one has
    /// none without dividing).
    #[ts(type = "number")]
    pub monthly: i64,
}

/// An upgrade that hasn't collected at its new amount (cancelled before
/// its first payment, or not yet due).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NotRealised {
    pub regular_gift_id: String,
    pub term_id: String,
    pub contact_id: String,
    pub change_code_id: Option<String>,
    pub change_code: Option<String>,
    pub effective_on: String,
    /// Whether the regular gift has ended (it never will be).
    pub ended: bool,
    #[ts(type = "number")]
    pub annual: i64,
    #[ts(type = "number | null")]
    pub monthly: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ExpectedReport {
    pub from: String,
    pub to: String,
    pub by: By,
    pub lines: Vec<ExpectedLine>,
    pub total: ExpectedLine,
    pub upgrades: Vec<UpgradeLine>,
    pub not_realised: Vec<NotRealised>,
}

/// Groups codes by `by`, labels and all, reading each version once.
struct Grouper<'c> {
    conn: &'c Connection,
    by: By,
    seen: BTreeMap<String, (Option<String>, String)>,
}

impl Grouper<'_> {
    fn group(&mut self, version: &str) -> rusqlite::Result<(Option<String>, String)> {
        if let Some(g) = self.seen.get(version) {
            return Ok(g.clone());
        }
        let g = match sources::describe(self.conn, version)? {
            Some(d) => match self.by {
                By::Code => (Some(d.version_id), d.code),
                By::Detail => (
                    Some(d.detail_id),
                    sources::rules::join_code(&[&d.category_name, &d.detail_name]),
                ),
                By::Category => (Some(d.category_id), d.category_name),
            },
            None => (Some(version.to_owned()), version.to_owned()),
        };
        self.seen.insert(version.to_owned(), g.clone());
        Ok(g)
    }
}

/// The report over months `from` ..= `to` (`YYYY-MM`), grouped `by`, as
/// of `today`: every regular gift's periods in range, then upgrades.
pub fn report(
    conn: &Connection,
    from: &str,
    to: &str,
    by: By,
    today: &str,
) -> rusqlite::Result<ExpectedReport> {
    let mut out = ExpectedReport {
        from: from.to_owned(),
        to: to.to_owned(),
        by,
        lines: vec![],
        total: ExpectedLine {
            label: "Total".into(),
            ..ExpectedLine::default()
        },
        upgrades: vec![],
        not_realised: vec![],
    };
    let Some((first, last)) = month_range(from, to) else {
        return Ok(out);
    };
    let ids: Vec<String> = conn
        .prepare_cached("SELECT id FROM regular_gifts ORDER BY seq")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut grouper = Grouper {
        conn,
        by,
        seen: BTreeMap::new(),
    };
    let mut lines: BTreeMap<(Option<String>, String), ExpectedLine> = BTreeMap::new();
    let mut upgrades: BTreeMap<(Option<String>, String), UpgradeLine> = BTreeMap::new();
    for id in ids {
        let Some(g) = gift(conn, &id)? else { continue };
        let paid = paid_by_period(conn, &id)?;
        for row in rows_of(&g, &paid, &first, &last, today) {
            for share in &row.split {
                let key = grouper.group(&share.source_code_id)?;
                let line = lines.entry(key.clone()).or_insert_with(|| ExpectedLine {
                    id: key.0.clone(),
                    label: key.1.clone(),
                    ..ExpectedLine::default()
                });
                line.expected += share.amount;
                match row.status {
                    PeriodStatus::Failed => line.failed += share.amount,
                    PeriodStatus::Missing => line.missing += share.amount,
                    PeriodStatus::Pending | PeriodStatus::Upcoming => line.pending += share.amount,
                    _ => {}
                }
            }
            if row.status == PeriodStatus::Collected
                && let Some(gift_id) = &row.gift_id
            {
                for a in crate::gift::load_allocations(conn, gift_id)? {
                    let key = grouper.group(&a.source_code_id)?;
                    lines
                        .entry(key.clone())
                        .or_insert_with(|| ExpectedLine {
                            id: key.0.clone(),
                            label: key.1.clone(),
                            ..ExpectedLine::default()
                        })
                        .received += a.amount;
                }
            }
        }
        changes(
            &g,
            &paid,
            &first,
            &last,
            &mut grouper,
            &mut upgrades,
            &mut out,
        )?;
    }
    for line in lines.values() {
        out.total.expected += line.expected;
        out.total.received += line.received;
        out.total.failed += line.failed;
        out.total.missing += line.missing;
        out.total.pending += line.pending;
    }
    out.lines = lines.into_values().collect();
    out.upgrades = upgrades.into_values().collect();
    Ok(out)
}

/// Gift `g`'s upgrades and downgrades: realised in range (their first
/// collected payment at the new amount, in its period) into `upgrades`;
/// upgrades that never collected and take effect by the range's end into
/// `out.not_realised`.
#[allow(clippy::too_many_arguments)]
fn changes(
    g: &Gift,
    paid: &BTreeMap<String, Paid>,
    first: &str,
    last: &str,
    grouper: &mut Grouper,
    upgrades: &mut BTreeMap<(Option<String>, String), UpgradeLine>,
    out: &mut ExpectedReport,
) -> rusqlite::Result<()> {
    let live: Vec<&TermView> = g.chain.iter().filter(|t| t.is_live()).collect();
    for (i, t) in live.iter().enumerate().skip(1) {
        if !matches!(t.change_kind, ChangeKind::Upgrade | ChangeKind::Downgrade) {
            continue;
        }
        let before = live[i - 1];
        let annual =
            annual_value(t.amount, t.frequency) - annual_value(before.amount, before.frequency);
        let monthly = (t.frequency == Frequency::Monthly && before.frequency == Frequency::Monthly)
            .then_some(t.amount - before.amount);
        // Governed by this row: on or after it, before the next.
        let until = live.get(i + 1).map(|n| n.effective_on.clone());
        let realised = paid
            .iter()
            .filter(|(period, p)| {
                p.status == Status::Completed
                    && p.amount == t.amount
                    && period.as_str() >= &t.effective_on[..7]
                    && until.as_deref().is_none_or(|u| period.as_str() < &u[..7])
            })
            .map(|(period, _)| period.clone())
            .next();
        match realised {
            Some(period) => {
                if period.as_str() < &first[..7] || period.as_str() > &last[..7] {
                    continue;
                }
                let key = match &t.change_code_id {
                    Some(code) => grouper.group(code)?,
                    None => (None, "Not coded".to_owned()),
                };
                let line = upgrades.entry(key.clone()).or_insert_with(|| UpgradeLine {
                    id: key.0.clone(),
                    label: key.1.clone(),
                    ..UpgradeLine::default()
                });
                if t.change_kind == ChangeKind::Upgrade {
                    line.upgrades += 1;
                } else {
                    line.downgrades += 1;
                }
                line.annual += annual;
                line.monthly += monthly.unwrap_or(0);
            }
            None if t.change_kind == ChangeKind::Upgrade
                && t.effective_on.as_str() >= first
                && t.effective_on.as_str() <= last =>
            {
                out.not_realised.push(NotRealised {
                    regular_gift_id: g.id.clone(),
                    term_id: t.id.clone(),
                    contact_id: g.contact_id.clone(),
                    change_code_id: t.change_code_id.clone(),
                    change_code: t.change_code.clone(),
                    effective_on: t.effective_on.clone(),
                    ended: g.status.is_ended(),
                    annual,
                    monthly,
                });
            }
            None => {}
        }
    }
    Ok(())
}

/// One regular gift's line for `keep expected`: its period in month
/// `month` (`YYYY-MM`), if it expects one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonthLine {
    pub regular_gift_id: String,
    pub contact_id: String,
    pub row: ExpectedRow,
}

/// Every regular gift's period in `month` as of `today`.
pub fn month(conn: &Connection, month: &str, today: &str) -> rusqlite::Result<Vec<MonthLine>> {
    let ids: Vec<String> = conn
        .prepare_cached("SELECT id FROM regular_gifts ORDER BY seq")?
        .query_map(params![], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let Some((first, last)) = month_range(month, month) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for id in ids {
        let Some(g) = gift(conn, &id)? else { continue };
        let paid = paid_by_period(conn, &id)?;
        for row in rows_of(&g, &paid, &first, &last, today) {
            out.push(MonthLine {
                regular_gift_id: g.id.clone(),
                contact_id: g.contact_id.clone(),
                row,
            });
        }
    }
    Ok(out)
}
