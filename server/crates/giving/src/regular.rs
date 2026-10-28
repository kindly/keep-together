//! Regular gifts by Direct Debit (`factory/plans/gocardless.sv`, D2): a
//! donor's promise to give an amount monthly or yearly, collected by the
//! organisation's own GoCardless account. Provider-neutral in what it
//! stores beyond the ids GoCardless hands back; the GoCardless calls and
//! the webhook mapping live in `api::gocardless`.
//!
//! Two aggregates:
//! - a regular gift (`regular_gifts`), in two slices: `giving.regularGift`
//!   (the terms staff chose: donor, amount, frequency, day, code; fixed
//!   once set up, `terms_version`) and `giving.regularGiftMandate` (where
//!   it stands at GoCardless: status, the billing request and its hosted
//!   link, the mandate and subscription ids, why it ended;
//!   `mandate_version`), written by the system and by a staff cancel;
//! - a Direct Debit payment (`direct_debit_payments`), one per GoCardless
//!   payment, `giving.directDebitPayment` (`version`): its amount, charge
//!   date, status and reason, and the gift it became.
//!
//! Money is never optimistic: a payment becomes a gift only once
//! GoCardless says it is `confirmed` ([`record_payment`]), with the
//! payment id as the gift's reference (unique, so a replayed event can't
//! give twice). A charged-back payment voids its gift; a cancelled
//! chargeback un-voids it. A failed payment makes no gift and shows on
//! the regular gift.

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, Source,
    WriteTx, command_group, execute,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::rules::{CLIENT_KEY_MAX, PENCE_MAX, format_pence, is_iso_date};
use crate::types::{AllocationRow, GiftPayload, Method, Status};

pub const TABLE: &str = "regular_gifts";
pub const PAYMENTS: &str = "direct_debit_payments";

/// The most payments one read of a regular gift carries (newest first):
/// eight years of monthly gifts.
pub const PAYMENTS_LIMIT: usize = 100;
/// The longest reason kept from a provider (its own description).
pub const REASON_MAX: usize = 500;

/// How often a regular gift is collected.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "RegularGiftFrequency")]
pub enum Frequency {
    Monthly,
    Yearly,
}

impl Frequency {
    pub fn as_str(self) -> &'static str {
        match self {
            Frequency::Monthly => "monthly",
            Frequency::Yearly => "yearly",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "yearly" {
            Frequency::Yearly
        } else {
            Frequency::Monthly
        }
    }
}

/// Where a regular gift stands: `pending` until the donor's mandate is
/// active, then `active`; `cancelled` (by the donor, their bank, staff, or
/// an expired mandate) and `failed` (the mandate couldn't be set up) are
/// the end.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "RegularGiftStatus")]
pub enum RegularStatus {
    Pending,
    Active,
    Cancelled,
    Failed,
}

impl RegularStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RegularStatus::Pending => "pending",
            RegularStatus::Active => "active",
            RegularStatus::Cancelled => "cancelled",
            RegularStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "active" => RegularStatus::Active,
            "cancelled" => RegularStatus::Cancelled,
            "failed" => RegularStatus::Failed,
            _ => RegularStatus::Pending,
        }
    }

    /// Cancelled or failed: nothing more will be collected.
    pub fn is_ended(self) -> bool {
        matches!(self, RegularStatus::Cancelled | RegularStatus::Failed)
    }
}

/// A Direct Debit payment's status, as far as the gift goes: `pending`
/// (created or submitted, not yet collected), `confirmed` (collected: a
/// gift), `failed`, `chargedBack` (refunded under the Direct Debit
/// Guarantee: its gift void), `cancelled` (never collected).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DirectDebitPaymentStatus")]
pub enum PaymentStatus {
    Pending,
    Confirmed,
    Failed,
    ChargedBack,
    Cancelled,
}

impl PaymentStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            PaymentStatus::Pending => "pending",
            PaymentStatus::Confirmed => "confirmed",
            PaymentStatus::Failed => "failed",
            PaymentStatus::ChargedBack => "charged_back",
            PaymentStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "confirmed" => PaymentStatus::Confirmed,
            "failed" => PaymentStatus::Failed,
            "charged_back" => PaymentStatus::ChargedBack,
            "cancelled" => PaymentStatus::Cancelled,
            _ => PaymentStatus::Pending,
        }
    }
}

// ── the terms ──────────────────────────────────────────────────────────────

/// `giving.regularGift`: what staff set up. Fixed once created (changing
/// an amount = cancel and set up again).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegularGiftPayload {
    pub contact_id: String,
    /// Pence, over 0.
    #[ts(type = "number")]
    pub amount: i64,
    pub frequency: Frequency,
    /// 1–28: the day of the month it is collected.
    pub day_of_month: u8,
    /// Yearly only: 1–12, the month it is collected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub month: Option<u8>,
    /// The source code (a version) each payment's gift is allocated to.
    pub source_code_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_key: Option<String>,
}

/// Refuse terms that can't be stored: an amount out of range, a day
/// outside 1–28 (every month has it; GoCardless takes 1–28 or the last
/// day), a month missing on a yearly gift or present on a monthly one.
pub fn prepare_terms(p: RegularGiftPayload) -> Result<RegularGiftPayload, ContractError> {
    let mut problems = Vec::new();
    if p.amount <= 0 {
        problems.push(Problem::new("amount", "The amount must be over £0"));
    } else if p.amount > PENCE_MAX {
        problems.push(Problem::new("amount", "The amount is too large"));
    }
    if !(1..=28).contains(&p.day_of_month) {
        problems.push(Problem::new("dayOfMonth", "Choose a day from 1 to 28"));
    }
    match (p.frequency, p.month) {
        (Frequency::Yearly, None) => {
            problems.push(Problem::new("month", "A yearly gift needs its month"))
        }
        (Frequency::Yearly, Some(m)) if !(1..=12).contains(&m) => {
            problems.push(Problem::new("month", "Months are 1 to 12"))
        }
        (Frequency::Monthly, Some(_)) => {
            problems.push(Problem::new("month", "Only a yearly gift has a month"))
        }
        _ => {}
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
    if problems.is_empty() {
        Ok(p)
    } else {
        Err(ContractError::Invalid(problems))
    }
}

/// The terms as stored, plus who set it up and when (system-owned).
#[derive(Clone, Debug, Serialize)]
pub struct TermsState {
    #[serde(flatten)]
    pub terms: RegularGiftPayload,
    #[serde(skip)]
    entered_by: Option<i64>,
    #[serde(skip)]
    entered_at: i64,
}

pub struct RegularGift;
pub static REGULAR_GIFT: RegularGift = RegularGift;

impl Contract for RegularGift {
    const NAME: &'static str = "giving.regularGift";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "terms_version";
    type Payload = RegularGiftPayload;
    type State = TermsState;

    fn prepare(&self, p: RegularGiftPayload) -> Result<RegularGiftPayload, ContractError> {
        prepare_terms(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<TermsState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT contact_id, amount, frequency, day_of_month, month, source_code_id,
                     entered_by, entered_at
                 FROM regular_gifts WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(TermsState {
                    terms: RegularGiftPayload {
                        contact_id: r.get(0)?,
                        amount: r.get(1)?,
                        frequency: Frequency::parse(&r.get::<_, String>(2)?),
                        day_of_month: r.get(3)?,
                        month: r.get(4)?,
                        source_code_id: r.get(5)?,
                        client_key: None,
                    },
                    entered_by: r.get(6)?,
                    entered_at: r.get(7)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&TermsState>,
        p: &RegularGiftPayload,
        command: &Command,
    ) -> Result<TermsState, ContractError> {
        match current {
            None => Ok(TermsState {
                terms: p.clone(),
                entered_by: command.actor,
                entered_at: command.at,
            }),
            // The subscription at GoCardless was made from these terms.
            Some(_) => Err(ContractError::rejected(
                "terms_fixed",
                "A regular gift’s terms can’t change: cancel it and set up another",
            )),
        }
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&TermsState>,
        next: &TermsState,
    ) -> Result<(), ContractError> {
        let t = &next.terms;
        if let Some(key) = t.client_key.as_deref() {
            let existing: Option<String> = tx
                .prepare_cached("SELECT id FROM regular_gifts WHERE client_key = ?1")?
                .query_row([key], |r| r.get(0))
                .optional()?;
            if let Some(id) = existing {
                return Err(ContractError::Duplicate { id });
            }
        }
        if contacts::donors::kind_of(tx, &t.contact_id)?.is_none() {
            return Err(ContractError::rejected(
                "unknown_contact",
                "Contact must exist",
            ));
        }
        match sources::describe(tx, &t.source_code_id)? {
            None => {
                return Err(ContractError::rejected(
                    "unknown_source_code",
                    "The source code must be a full code (category, detail and version)",
                ));
            }
            Some(code) if !code.is_active => {
                return Err(ContractError::rejected(
                    "archived_source_code",
                    format!("{} is archived: choose another", code.code),
                ));
            }
            Some(_) => {
                sources::mark_used(tx, &t.source_code_id, false)?;
            }
        }
        tx.prepare_cached(
            "INSERT INTO regular_gifts (id, contact_id, amount, frequency, day_of_month, month,
                 source_code_id, status, entered_by, entered_at, client_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10)",
        )?
        .execute(params![
            id,
            t.contact_id,
            t.amount,
            t.frequency.as_str(),
            t.day_of_month,
            t.month,
            t.source_code_id,
            next.entered_by,
            next.entered_at,
            t.client_key
        ])?;
        Ok(())
    }
}

// ── the mandate ────────────────────────────────────────────────────────────

/// `giving.regularGiftMandate`: where the regular gift stands at the
/// provider. Every field is the system's (from GoCardless), except a
/// staff cancel.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MandatePayload {
    pub status: Option<RegularStatus>,
    /// Why it ended (the provider's description, or "Cancelled by staff").
    pub ended_reason: Option<String>,
    /// When it ended (ms since the epoch).
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    /// GoCardless's billing request (`BRQ…`) and its hosted page for the
    /// donor, with when that link expires (ISO timestamp).
    pub billing_request_id: Option<String>,
    pub flow_url: Option<String>,
    pub flow_expires_at: Option<String>,
    /// GoCardless's mandate (`MD…`) and subscription (`SB…`).
    pub mandate_id: Option<String>,
    pub subscription_id: Option<String>,
}

impl MandatePayload {
    pub fn status(&self) -> RegularStatus {
        self.status.unwrap_or(RegularStatus::Pending)
    }
}

pub struct RegularGiftMandate;
pub static REGULAR_GIFT_MANDATE: RegularGiftMandate = RegularGiftMandate;

fn load_mandate(conn: &Connection, id: &str) -> rusqlite::Result<Option<MandatePayload>> {
    conn.prepare_cached(
        "SELECT status, ended_reason, ended_at, billing_request_id, flow_url, flow_expires_at,
             mandate_id, subscription_id
         FROM regular_gifts WHERE id = ?1",
    )?
    .query_row([id], |r| {
        Ok(MandatePayload {
            status: Some(RegularStatus::parse(&r.get::<_, String>(0)?)),
            ended_reason: r.get(1)?,
            ended_at: r.get(2)?,
            billing_request_id: r.get(3)?,
            flow_url: r.get(4)?,
            flow_expires_at: r.get(5)?,
            mandate_id: r.get(6)?,
            subscription_id: r.get(7)?,
        })
    })
    .optional()
}

impl Contract for RegularGiftMandate {
    const NAME: &'static str = "giving.regularGiftMandate";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "mandate_version";
    type Payload = MandatePayload;
    type State = MandatePayload;

    fn prepare(&self, mut p: MandatePayload) -> Result<MandatePayload, ContractError> {
        p.ended_reason = p
            .ended_reason
            .map(|r| r.trim().chars().take(REASON_MAX).collect::<String>())
            .filter(|r| !r.is_empty());
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<MandatePayload, ContractError> {
        load_mandate(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&MandatePayload>,
        p: &MandatePayload,
        _: &Command,
    ) -> Result<MandatePayload, ContractError> {
        if current.is_none() {
            return Err(ContractError::rejected(
                "no_root",
                "giving.regularGiftMandate targets an existing regular gift",
            ));
        }
        Ok(MandatePayload {
            status: Some(p.status()),
            ..p.clone()
        })
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        _: Option<&MandatePayload>,
        next: &MandatePayload,
    ) -> Result<(), ContractError> {
        // The provider's ids are unique: two regular gifts never share one.
        for (column, value) in [
            ("billing_request_id", &next.billing_request_id),
            ("mandate_id", &next.mandate_id),
            ("subscription_id", &next.subscription_id),
        ] {
            let Some(value) = value else { continue };
            let other: Option<String> = tx
                .prepare_cached(&format!(
                    "SELECT id FROM regular_gifts WHERE {column} = ?1 AND id <> ?2"
                ))?
                .query_row(params![value, id], |r| r.get(0))
                .optional()?;
            if other.is_some() {
                return Err(ContractError::rejected(
                    "provider_id_taken",
                    format!("{column} belongs to another regular gift"),
                ));
            }
        }
        tx.prepare_cached(
            "UPDATE regular_gifts SET status = ?2, ended_reason = ?3, ended_at = ?4,
                 billing_request_id = ?5, flow_url = ?6, flow_expires_at = ?7, mandate_id = ?8,
                 subscription_id = ?9
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            next.status().as_str(),
            next.ended_reason,
            next.ended_at,
            next.billing_request_id,
            next.flow_url,
            next.flow_expires_at,
            next.mandate_id,
            next.subscription_id
        ])?;
        Ok(())
    }
}

/// The command group's name for a new regular gift: "regular gift £10
/// monthly".
pub fn regular_group_name(p: &RegularGiftPayload) -> String {
    format!(
        "regular gift {} {}",
        format_pence(p.amount),
        p.frequency.as_str()
    )
}

/// Set up a regular gift, pending, in the caller's transaction: the
/// terms, then the mandate slice as `link` has it (the billing request
/// and its hosted page made for it), so its history starts with the
/// set-up. `id` is pre-generated (the provider's requests carry it); one
/// that exists, or a `clientKey` already on one, is `Duplicate`.
pub fn create_regular_gift(
    ctx: &Ctx,
    id: &str,
    payload: RegularGiftPayload,
    link: MandatePayload,
    source: Source,
) -> Result<String, ContractError> {
    let group = command_group(ctx, &regular_group_name(&payload))?;
    let id = execute(
        ctx,
        &REGULAR_GIFT,
        payload,
        Exec::create_with_id(id, source).in_group(&group),
    )?
    .id;
    execute(
        ctx,
        &REGULAR_GIFT_MANDATE,
        MandatePayload {
            status: Some(RegularStatus::Pending),
            ended_reason: None,
            ended_at: None,
            ..link
        },
        Exec::update(&id, Some(0), source).in_group(&group),
    )?;
    Ok(id)
}

/// Change the mandate slice with `change` unless that changes nothing (a
/// replayed event): then `None`. `expected` (a staff action) is checked
/// as any save's; the system passes `None`. Unknown id: `NotFound`.
pub fn update_mandate(
    ctx: &Ctx,
    id: &str,
    expected: Option<i64>,
    source: Source,
    group: Option<&CommandGroup>,
    change: impl FnOnce(&mut MandatePayload),
) -> Result<Option<Executed>, ContractError> {
    let Some(current) = load_mandate(ctx.tx.read(), id)? else {
        return Err(ContractError::NotFound);
    };
    let mut next = current.clone();
    change(&mut next);
    if next == current {
        return Ok(None);
    }
    let exec = Exec::update(id, expected, source);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(ctx, &REGULAR_GIFT_MANDATE, next, exec).map(Some)
}

/// End a regular gift (cancelled or failed) with `reason`, at `at` (ms).
/// One already ended keeps its first end. `None` when nothing changed.
pub fn end_regular_gift(
    ctx: &Ctx,
    id: &str,
    expected: Option<i64>,
    status: RegularStatus,
    reason: Option<String>,
    source: Source,
) -> Result<Option<Executed>, ContractError> {
    debug_assert!(status.is_ended());
    let at = ctx.at;
    update_mandate(ctx, id, expected, source, None, |m| {
        if m.status().is_ended() {
            return;
        }
        m.status = Some(status);
        m.ended_reason = reason;
        m.ended_at = Some(at);
    })
}

/// What the provider glue needs of a regular gift. One read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegularFacts {
    pub id: String,
    pub terms: RegularGiftPayload,
    pub mandate: MandatePayload,
}

const FACT_COLUMNS: &str = "id, contact_id, amount, frequency, day_of_month, month, \
     source_code_id, status, ended_reason, ended_at, billing_request_id, flow_url, \
     flow_expires_at, mandate_id, subscription_id";

fn facts_row(r: &Row) -> rusqlite::Result<RegularFacts> {
    Ok(RegularFacts {
        id: r.get(0)?,
        terms: RegularGiftPayload {
            contact_id: r.get(1)?,
            amount: r.get(2)?,
            frequency: Frequency::parse(&r.get::<_, String>(3)?),
            day_of_month: r.get(4)?,
            month: r.get(5)?,
            source_code_id: r.get(6)?,
            client_key: None,
        },
        mandate: MandatePayload {
            status: Some(RegularStatus::parse(&r.get::<_, String>(7)?)),
            ended_reason: r.get(8)?,
            ended_at: r.get(9)?,
            billing_request_id: r.get(10)?,
            flow_url: r.get(11)?,
            flow_expires_at: r.get(12)?,
            mandate_id: r.get(13)?,
            subscription_id: r.get(14)?,
        },
    })
}

/// The regular gift with `id`.
pub fn facts(conn: &Connection, id: &str) -> rusqlite::Result<Option<RegularFacts>> {
    facts_by(conn, "id", id)
}

/// The regular gift a provider id belongs to: `column` is
/// `billing_request_id`, `mandate_id` or `subscription_id`.
pub fn facts_by(
    conn: &Connection,
    column: &'static str,
    value: &str,
) -> rusqlite::Result<Option<RegularFacts>> {
    debug_assert!(
        [
            "id",
            "billing_request_id",
            "mandate_id",
            "subscription_id",
            "client_key"
        ]
        .contains(&column)
    );
    conn.prepare_cached(&format!(
        "SELECT {FACT_COLUMNS} FROM regular_gifts WHERE {column} = ?1"
    ))?
    .query_row([value], facts_row)
    .optional()
}

// ── payments ───────────────────────────────────────────────────────────────

/// `giving.directDebitPayment`: one provider payment of a regular gift.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaymentPayload {
    /// GoCardless's payment id (`PM…`); fixed.
    pub payment_id: String,
    /// Fixed.
    pub regular_gift_id: String,
    #[ts(type = "number")]
    pub amount: i64,
    /// ISO date it is (or was) collected.
    pub charge_date: String,
    pub status: PaymentStatus,
    /// Why it failed or was charged back (the provider's description).
    pub reason: Option<String>,
    /// The gift it became, once confirmed.
    pub gift_id: Option<String>,
}

pub struct DirectDebitPayment;
pub static DIRECT_DEBIT_PAYMENT: DirectDebitPayment = DirectDebitPayment;

fn load_payment(conn: &Connection, id: &str) -> rusqlite::Result<Option<PaymentPayload>> {
    conn.prepare_cached(
        "SELECT payment_id, regular_gift_id, amount, charge_date, status, reason, gift_id
         FROM direct_debit_payments WHERE id = ?1",
    )?
    .query_row([id], payment_row)
    .optional()
}

fn payment_row(r: &Row) -> rusqlite::Result<PaymentPayload> {
    Ok(PaymentPayload {
        payment_id: r.get(0)?,
        regular_gift_id: r.get(1)?,
        amount: r.get(2)?,
        charge_date: r.get(3)?,
        status: PaymentStatus::parse(&r.get::<_, String>(4)?),
        reason: r.get(5)?,
        gift_id: r.get(6)?,
    })
}

impl Contract for DirectDebitPayment {
    const NAME: &'static str = "giving.directDebitPayment";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = PAYMENTS;
    const COUNTER: &'static str = "version";
    type Payload = PaymentPayload;
    type State = PaymentPayload;

    fn prepare(&self, mut p: PaymentPayload) -> Result<PaymentPayload, ContractError> {
        p.reason = p
            .reason
            .map(|r| r.trim().chars().take(REASON_MAX).collect::<String>())
            .filter(|r| !r.is_empty());
        let mut problems = Vec::new();
        if p.amount <= 0 || p.amount > PENCE_MAX {
            problems.push(Problem::new("amount", "The amount must be over £0"));
        }
        if !is_iso_date(&p.charge_date) {
            problems.push(Problem::new("chargeDate", "Dates are YYYY-MM-DD"));
        }
        if p.payment_id.trim().is_empty() {
            problems.push(Problem::new("paymentId", "A payment has its provider id"));
        }
        if problems.is_empty() {
            Ok(p)
        } else {
            Err(ContractError::Invalid(problems))
        }
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<PaymentPayload, ContractError> {
        load_payment(tx.read(), id)?.ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&PaymentPayload>,
        p: &PaymentPayload,
        _: &Command,
    ) -> Result<PaymentPayload, ContractError> {
        if let Some(current) = current
            && (current.payment_id != p.payment_id || current.regular_gift_id != p.regular_gift_id)
        {
            return Err(ContractError::rejected(
                "identity_immutable",
                "A payment’s provider id and regular gift can’t change",
            ));
        }
        Ok(p.clone())
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&PaymentPayload>,
        next: &PaymentPayload,
    ) -> Result<(), ContractError> {
        if before.is_none() {
            let held: Option<String> = tx
                .prepare_cached("SELECT id FROM direct_debit_payments WHERE payment_id = ?1")?
                .query_row([&next.payment_id], |r| r.get(0))
                .optional()?;
            if let Some(id) = held {
                return Err(ContractError::Duplicate { id });
            }
            tx.prepare_cached(
                "INSERT INTO direct_debit_payments (id, payment_id, regular_gift_id, amount,
                     charge_date, status, reason, gift_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?
            .execute(params![
                id,
                next.payment_id,
                next.regular_gift_id,
                next.amount,
                next.charge_date,
                next.status.as_str(),
                next.reason,
                next.gift_id
            ])?;
        } else {
            tx.prepare_cached(
                "UPDATE direct_debit_payments SET amount = ?2, charge_date = ?3, status = ?4,
                     reason = ?5, gift_id = ?6
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                next.amount,
                next.charge_date,
                next.status.as_str(),
                next.reason,
                next.gift_id
            ])?;
        }
        Ok(())
    }
}

/// A payment as the provider now reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentReport {
    pub payment_id: String,
    pub amount: i64,
    pub charge_date: String,
    pub status: PaymentStatus,
    /// Why, for a failure or chargeback; kept from an earlier report when
    /// this one has none.
    pub reason: Option<String>,
}

/// What [`record_payment`] did to the gifts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GiftChange {
    None,
    Recorded(String),
    Voided(String),
    Unvoided(String),
}

/// Bring the payment `report` describes up to date for the regular gift
/// `regular_id`, in the caller's transaction, as the system:
/// - first sight: the payment row;
/// - `confirmed` with no gift yet: a gift (`direct_debit`, the payment id
///   as reference, the charge date, all of it to the regular gift's code);
/// - `chargedBack`: its gift void;
/// - back to `confirmed` from `chargedBack` (the chargeback cancelled): its
///   gift un-voided.
///
/// A report that changes nothing writes nothing, so a replayed event is a
/// no-op.
pub fn record_payment(
    ctx: &Ctx,
    regular_id: &str,
    report: PaymentReport,
) -> Result<GiftChange, ContractError> {
    let conn = ctx.tx.read();
    let Some(regular) = facts(conn, regular_id)? else {
        return Err(ContractError::NotFound);
    };
    let held: Option<(String, PaymentPayload)> = conn
        .prepare_cached(
            "SELECT id, payment_id, regular_gift_id, amount, charge_date, status, reason,
                 gift_id
             FROM direct_debit_payments WHERE payment_id = ?1",
        )?
        .query_row([&report.payment_id], |r| {
            let p = PaymentPayload {
                payment_id: r.get(1)?,
                regular_gift_id: r.get(2)?,
                amount: r.get(3)?,
                charge_date: r.get(4)?,
                status: PaymentStatus::parse(&r.get::<_, String>(5)?),
                reason: r.get(6)?,
                gift_id: r.get(7)?,
            };
            Ok((r.get(0)?, p))
        })
        .optional()?;
    if let Some((_, p)) = &held
        && p.regular_gift_id != regular_id
    {
        return Err(ContractError::rejected(
            "payment_elsewhere",
            "This payment belongs to another regular gift",
        ));
    }
    let before = held.as_ref().map(|(_, p)| p.clone());
    let mut next = PaymentPayload {
        payment_id: report.payment_id.clone(),
        regular_gift_id: regular_id.to_owned(),
        amount: report.amount,
        charge_date: report.charge_date.clone(),
        status: report.status,
        reason: report
            .reason
            .clone()
            .or_else(|| before.as_ref().and_then(|b| b.reason.clone())),
        gift_id: before.as_ref().and_then(|b| b.gift_id.clone()),
    };
    let was = before.as_ref().map(|b| b.status);
    let mut change = GiftChange::None;
    let gift_status = |id: &str| crate::describe_gift(conn, id).map(|g| g.map(|g| g.status));

    let group_name = match report.status {
        PaymentStatus::Confirmed if next.gift_id.is_none() => Some(format!(
            "Direct Debit {} confirmed",
            format_pence(report.amount)
        )),
        PaymentStatus::ChargedBack => Some(format!(
            "Direct Debit {} charged back{}",
            format_pence(report.amount),
            next.reason
                .as_deref()
                .map(|r| format!(": {r}"))
                .unwrap_or_default()
        )),
        PaymentStatus::Confirmed if was == Some(PaymentStatus::ChargedBack) => Some(format!(
            "Direct Debit {} chargeback cancelled",
            format_pence(report.amount)
        )),
        _ => None,
    };
    if before.as_ref() == Some(&next) {
        return Ok(GiftChange::None);
    }
    let group = match &group_name {
        Some(name) => Some(command_group(ctx, name)?),
        None => None,
    };

    match report.status {
        PaymentStatus::Confirmed => match next.gift_id.clone() {
            None => {
                // A gift made by an earlier attempt whose payment row
                // didn't land is found by its reference, never made twice.
                let existing: Option<String> = conn
                    .prepare_cached(
                        "SELECT id FROM gifts WHERE method = 'direct_debit' AND reference = ?1",
                    )?
                    .query_row([&report.payment_id], |r| r.get(0))
                    .optional()?;
                let gift = match existing {
                    Some(id) => id,
                    None => crate::create_gift(
                        ctx,
                        GiftPayload {
                            contact_id: regular.terms.contact_id.clone(),
                            received_on: report.charge_date.clone(),
                            amount: report.amount,
                            method: Method::DirectDebit,
                            reference: Some(report.payment_id.clone()),
                            allocations: vec![AllocationRow {
                                key: None,
                                source_code_id: regular.terms.source_code_id.clone(),
                                amount: report.amount,
                            }],
                            client_key: None,
                        },
                        Source::System,
                        group.as_ref(),
                    )?,
                };
                change = GiftChange::Recorded(gift.clone());
                next.gift_id = Some(gift);
            }
            Some(gift) if was == Some(PaymentStatus::ChargedBack) => {
                if gift_status(&gift)? == Some(Status::Void) {
                    unvoid_or_void(ctx, &gift, Status::Completed, group.as_ref())?;
                    change = GiftChange::Unvoided(gift);
                }
            }
            Some(_) => {}
        },
        PaymentStatus::ChargedBack => {
            if let Some(gift) = next.gift_id.clone()
                && gift_status(&gift)? == Some(Status::Completed)
            {
                unvoid_or_void(ctx, &gift, Status::Void, group.as_ref())?;
                change = GiftChange::Voided(gift);
            }
        }
        _ => {}
    }

    match held {
        None => {
            let exec = Exec::create(Source::System);
            let exec = match &group {
                Some(g) => exec.in_group(g),
                None => exec,
            };
            execute(ctx, &DIRECT_DEBIT_PAYMENT, next, exec)?;
        }
        Some((id, _)) => {
            let exec = Exec::update(&id, None, Source::System);
            let exec = match &group {
                Some(g) => exec.in_group(g),
                None => exec,
            };
            execute(ctx, &DIRECT_DEBIT_PAYMENT, next, exec)?;
        }
    }
    Ok(change)
}

fn unvoid_or_void(
    ctx: &Ctx,
    gift: &str,
    status: Status,
    group: Option<&CommandGroup>,
) -> Result<(), ContractError> {
    let exec = Exec::update(gift, None, Source::System);
    let exec = match group {
        Some(g) => exec.in_group(g),
        None => exec,
    };
    execute(
        ctx,
        &crate::STATUS,
        crate::types::StatusPayload {
            status,
            reason: None,
        },
        exec,
    )?;
    Ok(())
}

// ── reads ──────────────────────────────────────────────────────────────────

/// One provider payment as the regular gift's card shows it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DirectDebitPaymentRow {
    pub id: String,
    pub payment_id: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub charge_date: String,
    pub status: PaymentStatus,
    pub reason: Option<String>,
    pub gift_id: Option<String>,
}

/// A regular gift with its code and its latest payments (newest charge
/// date first, at most [`PAYMENTS_LIMIT`]). `connected` is the api's: is
/// the organisation's GoCardless account connected now.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegularGiftView {
    pub id: String,
    pub contact_id: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub frequency: Frequency,
    pub day_of_month: u8,
    pub month: Option<u8>,
    pub source_code_id: String,
    /// The code as it reads now; null if it isn't one of this
    /// organisation's.
    pub source_code: Option<String>,
    pub status: RegularStatus,
    pub ended_reason: Option<String>,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
    pub billing_request_id: Option<String>,
    /// The donor's sign-up link (GoCardless's hosted page) while pending.
    pub flow_url: Option<String>,
    pub flow_expires_at: Option<String>,
    pub mandate_id: Option<String>,
    pub subscription_id: Option<String>,
    #[ts(type = "number | null")]
    pub entered_by: Option<i64>,
    #[ts(type = "number")]
    pub entered_at: i64,
    #[ts(type = "number")]
    pub terms_version: i64,
    #[ts(type = "number")]
    pub mandate_version: i64,
    /// The latest failed payment, if the latest payment failed.
    pub last_failure: Option<DirectDebitPaymentRow>,
    pub payments: Vec<DirectDebitPaymentRow>,
    pub connected: bool,
}

const VIEW_COLUMNS: &str = "id, contact_id, amount, frequency, day_of_month, month, \
     source_code_id, status, ended_reason, ended_at, billing_request_id, flow_url, \
     flow_expires_at, mandate_id, subscription_id, entered_by, entered_at, terms_version, \
     mandate_version";

fn view_row(r: &Row) -> rusqlite::Result<RegularGiftView> {
    Ok(RegularGiftView {
        id: r.get(0)?,
        contact_id: r.get(1)?,
        amount: r.get(2)?,
        frequency: Frequency::parse(&r.get::<_, String>(3)?),
        day_of_month: r.get(4)?,
        month: r.get(5)?,
        source_code_id: r.get(6)?,
        source_code: None,
        status: RegularStatus::parse(&r.get::<_, String>(7)?),
        ended_reason: r.get(8)?,
        ended_at: r.get(9)?,
        billing_request_id: r.get(10)?,
        flow_url: r.get(11)?,
        flow_expires_at: r.get(12)?,
        mandate_id: r.get(13)?,
        subscription_id: r.get(14)?,
        entered_by: r.get(15)?,
        entered_at: r.get(16)?,
        terms_version: r.get(17)?,
        mandate_version: r.get(18)?,
        last_failure: None,
        payments: vec![],
        connected: false,
    })
}

fn fill(conn: &Connection, mut v: RegularGiftView) -> rusqlite::Result<RegularGiftView> {
    v.source_code = sources::describe(conn, &v.source_code_id)?.map(|c| c.code);
    v.payments = conn
        .prepare_cached(
            "SELECT id, payment_id, amount, charge_date, status, reason, gift_id
             FROM direct_debit_payments WHERE regular_gift_id = ?1
             ORDER BY charge_date DESC, seq DESC LIMIT ?2",
        )?
        .query_map(params![v.id, PAYMENTS_LIMIT as i64], |r| {
            Ok(DirectDebitPaymentRow {
                id: r.get(0)?,
                payment_id: r.get(1)?,
                amount: r.get(2)?,
                charge_date: r.get(3)?,
                status: PaymentStatus::parse(&r.get::<_, String>(4)?),
                reason: r.get(5)?,
                gift_id: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    v.last_failure = v
        .payments
        .first()
        .filter(|p| p.status == PaymentStatus::Failed)
        .cloned();
    Ok(v)
}

/// One regular gift, or `None`.
pub fn get_regular(conn: &Connection, id: &str) -> rusqlite::Result<Option<RegularGiftView>> {
    let found = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gifts WHERE id = ?1"
        ))?
        .query_row([id], view_row)
        .optional()?;
    found.map(|v| fill(conn, v)).transpose()
}

/// A contact's regular gifts, newest set up first.
pub fn regular_by_contact(
    conn: &Connection,
    contact_id: &str,
) -> rusqlite::Result<Vec<RegularGiftView>> {
    let rows: Vec<RegularGiftView> = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gifts WHERE contact_id = ?1 ORDER BY seq DESC"
        ))?
        .query_map([contact_id], view_row)?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter().map(|v| fill(conn, v)).collect()
}

/// The org-schema step for Direct Debit (GoCardless D2), after
/// `giving::MIGRATION_CLAIM_LOCK` (Gift Aid claims' step 16): the rebuild
/// carries every column and index `gifts` has by then, Gift Aid's void
/// reason, claim lock and partial indexes included. Run by `api::schema` with foreign keys
/// deferred, since it rebuilds `gifts` (SQLite can't widen a CHECK in
/// place) while allocations and declarations point at it:
/// - `gifts.method` takes `direct_debit`, and a Direct Debit gift's
///   reference (its payment id) is unique;
/// - `regular_gifts` and `direct_debit_payments`.
pub const MIGRATION_DIRECT_DEBIT: &str = "
CREATE TABLE gifts_widen AS SELECT * FROM gifts;
DROP TABLE gifts;
CREATE TABLE gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'direct_debit')),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'void')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    gift_version INTEGER NOT NULL DEFAULT 0,
    status_version INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT,
    claim_id TEXT,
    claim_lock_version INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
    entered_by, entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version)
SELECT seq, id, contact_id, received_on, amount, method, reference, status, entered_by,
    entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version
FROM gifts_widen;
DROP TABLE gifts_widen;
CREATE INDEX gifts_by_contact ON gifts (contact_id, received_on, seq);
CREATE INDEX gifts_by_entered_by ON gifts (entered_by, seq);
CREATE INDEX gifts_unclaimed ON gifts (received_on)
    WHERE claim_id IS NULL AND status = 'completed';
CREATE INDEX gifts_claimed_void ON gifts (claim_id)
    WHERE claim_id IS NOT NULL AND status = 'void';
CREATE UNIQUE INDEX gifts_by_direct_debit_payment ON gifts (reference)
    WHERE method = 'direct_debit';

CREATE TABLE regular_gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    frequency TEXT NOT NULL CHECK (frequency IN ('monthly', 'yearly')),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
    month INTEGER CHECK (month BETWEEN 1 AND 12),
    source_code_id TEXT NOT NULL REFERENCES source_codes (id),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'cancelled', 'failed')),
    ended_reason TEXT,
    ended_at INTEGER,
    billing_request_id TEXT UNIQUE,
    flow_url TEXT,
    flow_expires_at TEXT,
    mandate_id TEXT UNIQUE,
    subscription_id TEXT UNIQUE,
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    terms_version INTEGER NOT NULL DEFAULT 0,
    mandate_version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX regular_gifts_by_contact ON regular_gifts (contact_id, seq);

CREATE TABLE direct_debit_payments (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    payment_id TEXT NOT NULL UNIQUE,
    regular_gift_id TEXT NOT NULL REFERENCES regular_gifts (id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    charge_date TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'confirmed', 'failed', 'charged_back', 'cancelled')),
    reason TEXT,
    gift_id TEXT REFERENCES gifts (id),
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX direct_debit_payments_by_regular_gift
    ON direct_debit_payments (regular_gift_id, charge_date, seq);
";

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> RegularGiftPayload {
        RegularGiftPayload {
            contact_id: "c".into(),
            amount: 1000,
            frequency: Frequency::Monthly,
            day_of_month: 5,
            month: None,
            source_code_id: "s".into(),
            client_key: None,
        }
    }

    fn fields(p: RegularGiftPayload) -> Vec<String> {
        match prepare_terms(p) {
            Ok(_) => vec![],
            Err(ContractError::Invalid(problems)) => {
                problems.into_iter().map(|p| p.field).collect()
            }
            Err(e) => panic!("{e}"),
        }
    }

    #[test]
    fn terms_are_pence_a_day_every_month_has_and_a_month_only_when_yearly() {
        assert!(fields(terms()).is_empty());
        assert_eq!(
            fields(RegularGiftPayload {
                amount: 0,
                ..terms()
            }),
            ["amount"]
        );
        assert_eq!(
            fields(RegularGiftPayload {
                amount: PENCE_MAX + 1,
                ..terms()
            }),
            ["amount"]
        );
        for day in [0, 29, 31] {
            assert_eq!(
                fields(RegularGiftPayload {
                    day_of_month: day,
                    ..terms()
                }),
                ["dayOfMonth"]
            );
        }
        assert_eq!(
            fields(RegularGiftPayload {
                frequency: Frequency::Yearly,
                ..terms()
            }),
            ["month"]
        );
        assert_eq!(
            fields(RegularGiftPayload {
                frequency: Frequency::Yearly,
                month: Some(13),
                ..terms()
            }),
            ["month"]
        );
        assert!(
            fields(RegularGiftPayload {
                frequency: Frequency::Yearly,
                month: Some(12),
                ..terms()
            })
            .is_empty()
        );
        assert_eq!(
            fields(RegularGiftPayload {
                month: Some(1),
                ..terms()
            }),
            ["month"]
        );
        assert_eq!(
            fields(RegularGiftPayload {
                source_code_id: " ".into(),
                ..terms()
            }),
            ["sourceCodeId"]
        );
    }

    #[test]
    fn statuses_round_trip_through_their_stored_words() {
        for s in [
            RegularStatus::Pending,
            RegularStatus::Active,
            RegularStatus::Cancelled,
            RegularStatus::Failed,
        ] {
            assert_eq!(RegularStatus::parse(s.as_str()), s);
        }
        for s in [
            PaymentStatus::Pending,
            PaymentStatus::Confirmed,
            PaymentStatus::Failed,
            PaymentStatus::ChargedBack,
            PaymentStatus::Cancelled,
        ] {
            assert_eq!(PaymentStatus::parse(s.as_str()), s);
        }
        assert!(RegularStatus::Cancelled.is_ended() && RegularStatus::Failed.is_ended());
        assert!(!RegularStatus::Active.is_ended());
    }
}
