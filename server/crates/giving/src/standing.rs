//! Standing orders (plan `bank-transfers.sv` step 5, g1q4, g2q1–g2q3,
//! ADR 0027): regular gifts of kind `standing_order`, set up by the donor
//! in their own bank. No provider: the group can't start, change or stop
//! one, and nothing tells it when one stops. Their expected payments come
//! from the terms chain as a Direct Debit's do (ADR 0026); a statement
//! line matched to one becomes its instalment (a gift made from the line,
//! with the regular gift and the due date of the period it pays: a late
//! payment still pays its own period).
//!
//! A payment still unmatched [`MISSED_AFTER_DAYS`] after it was due is
//! **missed** (`giving.standingOrderMissed`, counter `missed_version`):
//! the oldest such due date, set by the daily job and by every match, and
//! cleared when a late payment turns up or the standing order ends. Staff
//! decide what to do (g2q2): it stays active until someone ends it.
//!
//! Frequencies are monthly, quarterly or yearly (g2q1); a Direct Debit
//! stays monthly or yearly (`giving.regularGiftTerms` refuses quarterly
//! on one).

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, Source,
    WriteTx, command_group, execute,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::expected::{self, ExpectedRow, PeriodStatus};
use crate::regular::{
    Frequency, Kind, MandatePayload, REGULAR_GIFT, REGULAR_GIFT_MANDATE, RegularGiftPayload,
    RegularStatus, check_live_code, end_regular_gift, schedule_problems,
};
use crate::rules::{CLIENT_KEY_MAX, REFERENCE_MAX, format_pence, is_iso_date};
use crate::terms::{self, TermView};
use crate::terms_rules::{
    Share, add_days, date_of_ms, month_index, month_label, split_for_collected,
};
use crate::types::Instalment;

/// Org schema step 23 (bank transfers step 5). `regular_gift_terms` is
/// rebuilt (SQLite can't widen a CHECK in place) with every column and
/// index it has by step 20, its frequency now monthly, quarterly or
/// yearly. `regular_gifts` gains a standing order's bank reference and the
/// missed slice; two indexes find the standing orders and the missed ones.
pub const MIGRATION: &str = "
CREATE TABLE regular_gift_terms_widen AS SELECT * FROM regular_gift_terms;
DROP TABLE regular_gift_terms;
CREATE TABLE regular_gift_terms (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    regular_gift_id TEXT NOT NULL REFERENCES regular_gifts (id),
    effective_from TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
    month INTEGER CHECK (month BETWEEN 1 AND 12),
    note TEXT,
    withdrawn INTEGER NOT NULL DEFAULT 0 CHECK (withdrawn IN (0, 1)),
    origin TEXT NOT NULL DEFAULT 'staff' CHECK (origin IN ('setup', 'staff', 'gocardless')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    change_code_id TEXT REFERENCES source_codes (id),
    state TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (state IN ('scheduled', 'sending', 'sent', 'applied')),
    subscription_id TEXT,
    sent_at INTEGER,
    applies_from TEXT,
    sync_error TEXT,
    sync_error_terms_version INTEGER,
    terms_version INTEGER NOT NULL DEFAULT 0,
    sync_version INTEGER NOT NULL DEFAULT 0,
    code_version INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO regular_gift_terms (seq, id, regular_gift_id, effective_from, amount, frequency,
    day_of_month, month, note, withdrawn, origin, entered_by, entered_at, change_code_id, state,
    subscription_id, sent_at, applies_from, sync_error, sync_error_terms_version, terms_version,
    sync_version, code_version)
SELECT seq, id, regular_gift_id, effective_from, amount, frequency, day_of_month, month, note,
    withdrawn, origin, entered_by, entered_at, change_code_id, state, subscription_id, sent_at,
    applies_from, sync_error, sync_error_terms_version, terms_version, sync_version, code_version
FROM regular_gift_terms_widen;
DROP TABLE regular_gift_terms_widen;
CREATE INDEX regular_gift_terms_by_gift ON regular_gift_terms (regular_gift_id, effective_from);
CREATE INDEX regular_gift_terms_due ON regular_gift_terms (effective_from)
    WHERE state IN ('scheduled', 'sending');
CREATE INDEX regular_gift_terms_by_subscription ON regular_gift_terms (subscription_id)
    WHERE subscription_id IS NOT NULL;

ALTER TABLE regular_gifts ADD COLUMN bank_reference TEXT;
ALTER TABLE regular_gifts ADD COLUMN missed_on TEXT;
ALTER TABLE regular_gifts ADD COLUMN missed_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX regular_gifts_by_kind ON regular_gifts (kind, status, seq);
CREATE INDEX regular_gifts_missed ON regular_gifts (missed_on) WHERE missed_on IS NOT NULL;
";

/// Days after its due date that a payment still unmatched is missed.
pub const MISSED_AFTER_DAYS: i64 = 14;
/// How far before its due date a statement line may pay a period (a bank
/// a few days early), and how far after (a weekend, a slow bank): −5/+15,
/// as CiviBanking does.
pub const EARLY_DAYS: i64 = 5;
pub const LATE_DAYS: i64 = 15;
/// Why a standing order ended when staff give no reason.
pub const ENDED_BY_STAFF: &str = "Ended by staff";

// ── set-up and end ─────────────────────────────────────────────────────────

/// "Record a standing order" (g2q3): the donor, the amount, how often,
/// the day (and month: yearly, or a quarterly one's first), the reference
/// the donor's bank shows, the code, and the first payment's date.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StandingOrderSetUp {
    #[serde(default)]
    #[ts(optional)]
    pub client_key: Option<String>,
    #[ts(type = "number")]
    pub amount: i64,
    pub frequency: Frequency,
    pub day_of_month: u8,
    #[serde(default)]
    #[ts(optional)]
    pub month: Option<u8>,
    pub source_code_id: String,
    #[serde(default)]
    #[ts(optional)]
    pub bank_reference: Option<String>,
    /// ISO: the first payment's due date (its row is in force from then).
    pub starts_on: String,
}

fn prepare(p: &StandingOrderSetUp) -> Result<(), ContractError> {
    let mut problems = Vec::new();
    schedule_problems(
        p.amount,
        p.frequency,
        p.day_of_month,
        p.month,
        &mut problems,
    );
    if !is_iso_date(&p.starts_on) {
        problems.push(Problem::new("startsOn", "Dates are YYYY-MM-DD"));
    }
    if p.source_code_id.trim().is_empty() {
        problems.push(Problem::new("sourceCodeId", "Pick a source code"));
    }
    if p.client_key
        .as_ref()
        .is_some_and(|k| contacts::rules::too_long(k, CLIENT_KEY_MAX))
    {
        problems.push(Problem::new(
            "clientKey",
            format!("At most {CLIENT_KEY_MAX} characters"),
        ));
    }
    if p.bank_reference
        .as_ref()
        .is_some_and(|r| contacts::rules::too_long(r, REFERENCE_MAX))
    {
        problems.push(Problem::new(
            "bankReference",
            format!("At most {REFERENCE_MAX} characters"),
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// The command group's name: "standing order £10 monthly".
pub fn standing_group_name(amount: i64, frequency: Frequency) -> String {
    format!(
        "standing order {} {}",
        format_pence(amount),
        frequency.as_str()
    )
}

/// Record a standing order for `contact_id`, in the caller's transaction,
/// under `group` or one of its own: the set-up (kind `standing_order`,
/// its reference), its chain's first row (in force from `startsOn`, the
/// whole amount to the code), and `active` at once: the donor has set it
/// up already. A `clientKey` already on a regular gift is `Duplicate`.
pub fn create_standing_order(
    ctx: &Ctx,
    contact_id: &str,
    setup: StandingOrderSetUp,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<String, ContractError> {
    prepare(&setup)?;
    let own;
    let group = match group {
        Some(g) => g,
        None => {
            own = command_group(ctx, &standing_group_name(setup.amount, setup.frequency))?;
            &own
        }
    };
    let id = execute(
        ctx,
        &REGULAR_GIFT,
        RegularGiftPayload {
            contact_id: contact_id.to_owned(),
            client_key: setup.client_key.clone(),
            kind: Kind::StandingOrder,
            bank_reference: setup.bank_reference.clone(),
        },
        Exec::create(source).in_group(group),
    )?
    .id;
    check_live_code(ctx.tx.read(), &setup.source_code_id)?;
    terms::create_first_row(
        ctx,
        &id,
        &setup.starts_on,
        setup.amount,
        setup.frequency,
        setup.day_of_month,
        setup.month,
        &setup.source_code_id,
        None,
        group,
    )?;
    execute(
        ctx,
        &REGULAR_GIFT_MANDATE,
        MandatePayload {
            status: Some(RegularStatus::Active),
            ..MandatePayload::default()
        },
        Exec::update(&id, Some(0), source).in_group(group),
    )?;
    Ok(id)
}

/// Refuse anything that isn't a standing order (a Direct Debit is ended
/// at GoCardless, through its own route).
fn require_standing(conn: &Connection, id: &str) -> Result<(), ContractError> {
    match crate::regular::kind_of(conn, id)? {
        None => Err(ContractError::NotFound),
        Some(Kind::StandingOrder) => Ok(()),
        Some(Kind::DirectDebit) => Err(ContractError::rejected(
            "not_a_standing_order",
            "This is a Direct Debit: cancel it at GoCardless",
        )),
    }
}

/// End a standing order (the donor stopped it, or staff decided after a
/// miss): `cancelled`, with `reason` (else "Ended by staff"), against the
/// mandate slice's `expected`. Nothing is expected from then; its missed
/// flag is cleared. One already ended keeps its first end.
pub fn end_standing_order(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    reason: Option<String>,
    source: Source,
) -> Result<Option<Executed>, ContractError> {
    require_standing(ctx.tx.read(), id)?;
    let reason = reason
        .map(|r| r.trim().to_owned())
        .filter(|r| !r.is_empty())
        .unwrap_or_else(|| ENDED_BY_STAFF.to_owned());
    let done = end_regular_gift(
        ctx,
        id,
        Some(expected),
        RegularStatus::Cancelled,
        Some(reason),
        source,
    )?;
    refresh_missed(ctx, id, &date_of_ms(ctx.at), source, None)?;
    Ok(done)
}

// ── instalments ────────────────────────────────────────────────────────────

/// A gift's instalment must name a standing order of its own donor.
pub(crate) fn check_instalment(
    conn: &Connection,
    contact_id: &str,
    i: &Instalment,
) -> Result<(), ContractError> {
    let found: Option<(String, String)> = conn
        .prepare_cached("SELECT contact_id, kind FROM regular_gifts WHERE id = ?1")?
        .query_row([&i.regular_gift_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    match found {
        Some((contact, kind)) if Kind::parse(&kind) == Kind::StandingOrder => {
            if contact != contact_id {
                return Err(ContractError::rejected(
                    "instalment_contact",
                    "A standing order’s payment is from its own donor",
                ));
            }
            Ok(())
        }
        _ => Err(ContractError::rejected(
            "unknown_standing_order",
            "The standing order must exist",
        )),
    }
}

/// One of a standing order's expected payments a statement line could
/// pay: its due date and amount, and the split its terms give it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DuePayment {
    pub regular_gift_id: String,
    pub contact_id: String,
    pub due_on: String,
    pub amount: i64,
    pub frequency: Frequency,
    pub split: Vec<Share>,
}

/// The active standing orders, `(id, contact)`, oldest first
/// (`regular_gifts_by_kind`).
fn active_standing_orders(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    conn.prepare_cached(
        "SELECT id, contact_id FROM regular_gifts INDEXED BY regular_gifts_by_kind
         WHERE kind = 'standing_order' AND status = 'active' ORDER BY seq",
    )?
    .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
    .collect()
}

/// The unpaid expected payments of active standing orders that a line
/// posted on `posted_on` for `amount` pays: the exact amount, due from
/// [`LATE_DAYS`] before the posting to [`EARLY_DAYS`] after it (the line
/// came at most 5 days early or 15 late). Oldest due first.
pub fn payments_for_line(
    conn: &Connection,
    posted_on: &str,
    amount: i64,
) -> rusqlite::Result<Vec<DuePayment>> {
    let (Some(from), Some(to)) = (
        add_days(posted_on, -LATE_DAYS),
        add_days(posted_on, EARLY_DAYS),
    ) else {
        return Ok(vec![]);
    };
    let (Some(a), Some(b)) = (month_index(&from), month_index(&to)) else {
        return Ok(vec![]);
    };
    let (first, last) = (month_label(a), month_label(b));
    let mut out = Vec::new();
    for (id, contact) in active_standing_orders(conn)? {
        let Some(rows) = expected::for_regular_gift(conn, &id, &first, &last, posted_on)? else {
            continue;
        };
        let chain = terms::chain(conn, &id)?;
        for row in rows {
            if row.gift_id.is_some()
                || row.expected != amount
                || row.due_on.as_str() < from.as_str()
                || row.due_on.as_str() > to.as_str()
            {
                continue;
            }
            let frequency = chain
                .iter()
                .find(|t| t.id == row.term_id)
                .map(|t| t.frequency)
                .unwrap_or(Frequency::Monthly);
            out.push(DuePayment {
                regular_gift_id: id.clone(),
                contact_id: contact.clone(),
                due_on: row.due_on,
                amount: row.expected,
                frequency,
                split: row.split,
            });
        }
    }
    out.sort_by(|a, b| a.due_on.cmp(&b.due_on));
    Ok(out)
}

/// The split a payment of `amount` for the period due `scheduled_on`
/// takes (g2q6): its terms' split, moved by whole layers when the amount
/// differs. Empty when the standing order expects nothing then.
pub fn instalment_split(
    conn: &Connection,
    regular_gift_id: &str,
    scheduled_on: &str,
    amount: i64,
) -> rusqlite::Result<Vec<Share>> {
    let Some(index) = month_index(scheduled_on) else {
        return Ok(vec![]);
    };
    let month = month_label(index);
    let rows = expected::for_regular_gift(conn, regular_gift_id, &month, &month, scheduled_on)?
        .unwrap_or_default();
    Ok(rows
        .into_iter()
        .find(|r| r.due_on == scheduled_on)
        .map(|r| {
            if r.expected == amount {
                r.split
            } else {
                split_for_collected(&r.split, amount)
            }
        })
        .unwrap_or_default())
}

// ── missed ─────────────────────────────────────────────────────────────────

/// `giving.standingOrderMissed`: the due date of a standing order's
/// oldest payment still unmatched [`MISSED_AFTER_DAYS`] after it, or none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "StandingOrderMissed")]
pub struct MissedPayload {
    pub missed_on: Option<String>,
}

/// The missed flag (g2q2): the system's, worked out from the chain and
/// the instalments by [`refresh_missed`]. A restore is refused: the next
/// refresh would say otherwise.
pub struct StandingOrderMissed;
pub static STANDING_ORDER_MISSED: StandingOrderMissed = StandingOrderMissed;

impl Contract for StandingOrderMissed {
    const NAME: &'static str = "giving.standingOrderMissed";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = crate::regular::TABLE;
    const COUNTER: &'static str = "missed_version";
    type Payload = MissedPayload;
    type State = MissedPayload;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<MissedPayload, ContractError> {
        tx.read()
            .prepare_cached("SELECT missed_on FROM regular_gifts WHERE id = ?1")?
            .query_row([id], |r| {
                Ok(MissedPayload {
                    missed_on: r.get(0)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&MissedPayload>,
        p: &MissedPayload,
        command: &Command,
    ) -> Result<MissedPayload, ContractError> {
        if current.is_none() {
            return Err(ContractError::rejected(
                "no_root",
                "giving.standingOrderMissed targets an existing standing order",
            ));
        }
        if command.source == Source::Restore {
            return Err(ContractError::rejected(
                "not_restorable",
                "Whether a payment is missed is worked out, never restored",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&MissedPayload>,
        next: &MissedPayload,
    ) -> Result<(), ContractError> {
        tx.prepare_cached("UPDATE regular_gifts SET missed_on = ?2 WHERE id = ?1")?
            .execute(params![id, next.missed_on])?;
        Ok(())
    }
}

/// The due date of standing order `id`'s oldest payment that is missed
/// as of `today`: due [`MISSED_AFTER_DAYS`] or more days ago and still
/// unmatched. `None` for one not active (ended: nothing more expected,
/// and the flag goes) or with nothing missed.
pub fn missed_on(conn: &Connection, id: &str, today: &str) -> rusqlite::Result<Option<String>> {
    let found: Option<(String, String)> = conn
        .prepare_cached("SELECT kind, status FROM regular_gifts WHERE id = ?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?;
    let Some((kind, status)) = found else {
        return Ok(None);
    };
    if Kind::parse(&kind) != Kind::StandingOrder
        || RegularStatus::parse(&status) != RegularStatus::Active
    {
        return Ok(None);
    }
    let Some(cutoff) = add_days(today, -MISSED_AFTER_DAYS) else {
        return Ok(None);
    };
    let chain = terms::chain(conn, id)?;
    let (Some(first), Some(last)) = (
        chain.first().and_then(|t| month_index(&t.effective_on)),
        month_index(&cutoff),
    ) else {
        return Ok(None);
    };
    if first > last {
        return Ok(None);
    }
    let rows =
        expected::for_regular_gift(conn, id, &month_label(first), &month_label(last), today)?
            .unwrap_or_default();
    Ok(rows
        .into_iter()
        .find(|r| r.status == PeriodStatus::Missing && r.due_on.as_str() <= cutoff.as_str())
        .map(|r| r.due_on))
}

/// Set standing order `id`'s missed flag as of `today` (a match, the
/// job, its end), under `group` when given. `false` when it already says
/// so (nothing written).
pub fn refresh_missed(
    ctx: &Ctx,
    id: &str,
    today: &str,
    source: Source,
    group: Option<&CommandGroup>,
) -> Result<bool, ContractError> {
    let next = missed_on(ctx.tx.read(), id, today)?;
    let held: Option<String> = ctx
        .tx
        .read()
        .prepare_cached("SELECT missed_on FROM regular_gifts WHERE id = ?1")?
        .query_row([id], |r| r.get(0))?;
    if held == next {
        return Ok(false);
    }
    let exec = Exec::update(id, None, source);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(
        ctx,
        &STANDING_ORDER_MISSED,
        MissedPayload { missed_on: next },
        exec,
    )?;
    Ok(true)
}

/// The daily job's work in one organisation: every standing order that
/// is active or still flagged, refreshed as of `today`, under one group
/// when anything changes. Answers how many changed.
pub fn refresh_all_missed(ctx: &Ctx, today: &str) -> Result<usize, ContractError> {
    let ids: Vec<String> = ctx
        .tx
        .read()
        .prepare_cached(
            "SELECT id FROM regular_gifts
             WHERE kind = 'standing_order' AND (status = 'active' OR missed_on IS NOT NULL)
             ORDER BY seq",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut group = None;
    let mut changed = 0;
    for id in ids {
        if missed_on(ctx.tx.read(), &id, today)?
            == ctx
                .tx
                .read()
                .prepare_cached("SELECT missed_on FROM regular_gifts WHERE id = ?1")?
                .query_row([&id], |r| r.get::<_, Option<String>>(0))?
        {
            continue;
        }
        if group.is_none() {
            group = Some(command_group(ctx, "standing orders: missed payments")?);
        }
        refresh_missed(ctx, &id, today, Source::System, group.as_ref())?;
        changed += 1;
    }
    Ok(changed)
}

// ── reads ──────────────────────────────────────────────────────────────────

/// A standing order as its card and lists show it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StandingOrderView {
    pub id: String,
    pub contact_id: String,
    pub contact_name: Option<String>,
    pub status: RegularStatus,
    pub bank_reference: Option<String>,
    /// The oldest missed payment's due date: staff decide (g2q2).
    pub missed_on: Option<String>,
    pub ended_reason: Option<String>,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    pub chain: Vec<TermView>,
    /// The last 12 months to the next 3, as of today.
    pub expected: Vec<ExpectedRow>,
    #[ts(type = "number")]
    pub setup_version: i64,
    #[ts(type = "number")]
    pub mandate_version: i64,
    #[ts(type = "number")]
    pub missed_version: i64,
}

const VIEW_COLUMNS: &str = "id, contact_id, status, bank_reference, missed_on, ended_reason, \
     ended_at, setup_version, mandate_version, missed_version";

fn view(conn: &Connection, r: ViewRow, today: &str) -> rusqlite::Result<StandingOrderView> {
    let (from, to) = match month_index(today) {
        Some(i) => (month_label(i - 11), month_label(i + 3)),
        None => (String::new(), String::new()),
    };
    Ok(StandingOrderView {
        contact_name: contacts::donors::name_of(conn, &r.contact_id)?.map(|(n, _)| n),
        chain: terms::chain(conn, &r.id)?,
        expected: expected::for_regular_gift(conn, &r.id, &from, &to, today)?.unwrap_or_default(),
        id: r.id,
        contact_id: r.contact_id,
        status: r.status,
        bank_reference: r.bank_reference,
        missed_on: r.missed_on,
        ended_reason: r.ended_reason,
        ended_at: r.ended_at,
        setup_version: r.setup_version,
        mandate_version: r.mandate_version,
        missed_version: r.missed_version,
    })
}

struct ViewRow {
    id: String,
    contact_id: String,
    status: RegularStatus,
    bank_reference: Option<String>,
    missed_on: Option<String>,
    ended_reason: Option<String>,
    ended_at: Option<i64>,
    setup_version: i64,
    mandate_version: i64,
    missed_version: i64,
}

fn view_row(r: &rusqlite::Row) -> rusqlite::Result<ViewRow> {
    Ok(ViewRow {
        id: r.get(0)?,
        contact_id: r.get(1)?,
        status: RegularStatus::parse(&r.get::<_, String>(2)?),
        bank_reference: r.get(3)?,
        missed_on: r.get(4)?,
        ended_reason: r.get(5)?,
        ended_at: r.get(6)?,
        setup_version: r.get(7)?,
        mandate_version: r.get(8)?,
        missed_version: r.get(9)?,
    })
}

/// One standing order as of `today`, or `None` (a Direct Debit is none).
pub fn get(
    conn: &Connection,
    id: &str,
    today: &str,
) -> rusqlite::Result<Option<StandingOrderView>> {
    let found = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gifts WHERE id = ?1 AND kind = 'standing_order'"
        ))?
        .query_row([id], view_row)
        .optional()?;
    found.map(|r| view(conn, r, today)).transpose()
}

/// A contact's standing orders, newest first.
pub fn of_contact(
    conn: &Connection,
    contact_id: &str,
    today: &str,
) -> rusqlite::Result<Vec<StandingOrderView>> {
    let rows: Vec<ViewRow> = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gifts
             WHERE contact_id = ?1 AND kind = 'standing_order' ORDER BY seq DESC"
        ))?
        .query_map([contact_id], view_row)?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter().map(|r| view(conn, r, today)).collect()
}

/// A standing order with a missed payment, for the list staff work from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MissedStandingOrder {
    pub id: String,
    pub contact_id: String,
    pub contact_name: Option<String>,
    pub missed_on: String,
    /// The amount and frequency in force now.
    #[ts(type = "number | null")]
    pub amount: Option<i64>,
    pub frequency: Option<Frequency>,
}

/// Every standing order with a missed payment, oldest miss first
/// (`regular_gifts_missed`).
pub fn missed(conn: &Connection, today: &str) -> rusqlite::Result<Vec<MissedStandingOrder>> {
    let rows: Vec<(String, String, String)> = conn
        .prepare_cached(
            "SELECT id, contact_id, missed_on FROM regular_gifts INDEXED BY regular_gifts_missed
             WHERE missed_on IS NOT NULL ORDER BY missed_on, seq",
        )?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for (id, contact_id, missed_on) in rows {
        let chain = terms::chain(conn, &id)?;
        let now = terms::in_force(&chain, today);
        out.push(MissedStandingOrder {
            contact_name: contacts::donors::name_of(conn, &contact_id)?.map(|(n, _)| n),
            amount: now.map(|t| t.amount),
            frequency: now.map(|t| t.frequency),
            id,
            contact_id,
            missed_on,
        });
    }
    Ok(out)
}

/// A contact's active standing orders as `(id, amount in force today)`:
/// what "make this a standing order" checks it isn't offering twice.
pub fn active_of_contact(
    conn: &Connection,
    contact_id: &str,
    today: &str,
) -> rusqlite::Result<Vec<(String, i64)>> {
    let ids: Vec<String> = conn
        .prepare_cached(
            "SELECT id FROM regular_gifts
             WHERE contact_id = ?1 AND kind = 'standing_order' AND status = 'active'",
        )?
        .query_map([contact_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    for id in ids {
        let chain = terms::chain(conn, &id)?;
        if let Some(t) = terms::in_force(&chain, today).or(chain.first()) {
            out.push((id, t.amount));
        }
    }
    Ok(out)
}
