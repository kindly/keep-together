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
//!   payment, `giving.directDebitPayment` (`version`): the provider's raw
//!   record (amount, charge date, status and reason, the mandate and
//!   regular gift) and its gift.
//!
//! ADR 0025: each payment is one gift for its whole life, made when we
//! first hear of it and following it ([`record_payment`]): `pending`
//! until GoCardless collects it, `completed` once it says `confirmed`
//! (only then money received), `failed`, `cancelled` or `charged_back`
//! after. One gift per payment (`(provider, provider_payment_id)` is
//! unique), so a replayed event can't give twice. A payment we can't tie
//! to a donor is kept with no gift and listed for staff to match.

use contracts::{
    Command, CommandGroup, Contract, ContractError, Ctx, Exec, Executed, OrgTx, Problem, Source,
    WriteTx, command_group, execute,
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::rules::{CLIENT_KEY_MAX, PENCE_MAX, format_pence, is_iso_date};
use crate::terms_rules::Share;
use crate::types::{
    AllocationRow, GiftPayload, Method, Provider, ProviderRef, Status, StatusPayload,
};

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

// ── the set-up ─────────────────────────────────────────────────────────────

/// `giving.regularGift` (v2): who it is from and the form's key, fixed
/// once set up. The terms are its chain ([`crate::terms`]).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegularGiftPayload {
    pub contact_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_key: Option<String>,
}

/// What staff choose to set a regular gift up: the donor and the first
/// row of its chain (one code for the whole amount).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetUp {
    pub contact_id: String,
    /// Pence, over 0.
    pub amount: i64,
    pub frequency: Frequency,
    /// 1–28: the day of the month it is collected.
    pub day_of_month: u8,
    /// Yearly only: 1–12, the month it is collected.
    pub month: Option<u8>,
    /// The source code (a version) the whole amount is allocated to.
    pub source_code_id: String,
    pub client_key: Option<String>,
}

/// An amount out of range, a day outside 1–28 (every month has it;
/// GoCardless takes 1–28 or the last day), a month missing on a yearly
/// gift or present on a monthly one.
pub fn schedule_problems(
    amount: i64,
    frequency: Frequency,
    day_of_month: u8,
    month: Option<u8>,
    problems: &mut Vec<Problem>,
) {
    if amount <= 0 {
        problems.push(Problem::new("amount", "The amount must be over £0"));
    } else if amount > PENCE_MAX {
        problems.push(Problem::new("amount", "The amount is too large"));
    }
    if !(1..=28).contains(&day_of_month) {
        problems.push(Problem::new("dayOfMonth", "Choose a day from 1 to 28"));
    }
    match (frequency, month) {
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
}

/// Refuse a set-up that can't be stored: [`schedule_problems`], no code,
/// a client key too long.
pub fn prepare_setup(p: SetUp) -> Result<SetUp, ContractError> {
    let mut problems = Vec::new();
    schedule_problems(
        p.amount,
        p.frequency,
        p.day_of_month,
        p.month,
        &mut problems,
    );
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

/// The set-up as stored, plus who set it up and when (system-owned).
#[derive(Clone, Debug, Serialize)]
pub struct SetUpState {
    #[serde(flatten)]
    pub setup: RegularGiftPayload,
    #[serde(skip)]
    entered_by: Option<i64>,
    #[serde(skip)]
    entered_at: i64,
}

pub struct RegularGift;
pub static REGULAR_GIFT: RegularGift = RegularGift;

impl Contract for RegularGift {
    const NAME: &'static str = "giving.regularGift";
    /// v2: the terms moved to the chain (ADR 0026).
    const VERSION: u32 = 2;
    const ENTITY: &'static str = TABLE;
    const COUNTER: &'static str = "setup_version";
    type Payload = RegularGiftPayload;
    type State = SetUpState;

    fn prepare(&self, p: RegularGiftPayload) -> Result<RegularGiftPayload, ContractError> {
        if p.client_key
            .as_ref()
            .is_some_and(|k| contacts::rules::too_long(k, CLIENT_KEY_MAX))
        {
            return Err(ContractError::invalid(
                "clientKey",
                format!("At most {CLIENT_KEY_MAX} characters"),
            ));
        }
        Ok(p)
    }

    fn load(&self, tx: &OrgTx, id: &str) -> Result<SetUpState, ContractError> {
        tx.read()
            .prepare_cached(
                "SELECT contact_id, entered_by, entered_at FROM regular_gifts WHERE id = ?1",
            )?
            .query_row([id], |r| {
                Ok(SetUpState {
                    setup: RegularGiftPayload {
                        contact_id: r.get(0)?,
                        client_key: None,
                    },
                    entered_by: r.get(1)?,
                    entered_at: r.get(2)?,
                })
            })
            .optional()?
            .ok_or(ContractError::NotFound)
    }

    fn apply(
        &self,
        current: Option<&SetUpState>,
        p: &RegularGiftPayload,
        command: &Command,
    ) -> Result<SetUpState, ContractError> {
        match current {
            None => Ok(SetUpState {
                setup: p.clone(),
                entered_by: command.actor,
                entered_at: command.at,
            }),
            // Restoring an old revision says the same: nothing changes
            // (the terms it held are the chain's now).
            Some(c) if c.setup.contact_id == p.contact_id => Ok(c.clone()),
            Some(_) => Err(ContractError::rejected(
                "setup_fixed",
                "A regular gift’s donor can’t change: cancel it and set up another",
            )),
        }
    }

    /// v1 held the terms, which are the chain's first row now: dropped.
    fn upcast(&self, from: u32, payload: serde_json::Value) -> Option<serde_json::Value> {
        if from != 1 {
            return None;
        }
        let mut payload = payload;
        if let Some(o) = payload.as_object_mut() {
            for k in ["amount", "frequency", "dayOfMonth", "month", "sourceCodeId"] {
                o.remove(k);
            }
        }
        Some(payload)
    }

    fn write(
        &self,
        tx: &WriteTx,
        id: &str,
        before: Option<&SetUpState>,
        next: &SetUpState,
    ) -> Result<(), ContractError> {
        if before.is_some() {
            return Ok(());
        }
        let t = &next.setup;
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
        tx.prepare_cached(
            "INSERT INTO regular_gifts (id, contact_id, status, entered_by, entered_at, client_key)
             VALUES (?1, ?2, 'pending', ?3, ?4, ?5)",
        )?
        .execute(params![
            id,
            t.contact_id,
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
pub fn regular_group_name(amount: i64, frequency: Frequency) -> String {
    format!(
        "regular gift {} {}",
        format_pence(amount),
        frequency.as_str()
    )
}

/// Set up a regular gift, pending, in the caller's transaction: the
/// set-up, the first row of its chain (in force from today: GoCardless
/// takes the first payment once the donor has signed), then the mandate
/// slice as `link` has it (the billing request and its hosted page made
/// for it), so its history starts with the set-up. `id` is pre-generated
/// (the provider's requests carry it); one that exists, or a `clientKey`
/// already on one, is `Duplicate`.
pub fn create_regular_gift(
    ctx: &Ctx,
    id: &str,
    setup: SetUp,
    link: MandatePayload,
    source: Source,
) -> Result<String, ContractError> {
    let setup = prepare_setup(setup)?;
    let group = command_group(ctx, &regular_group_name(setup.amount, setup.frequency))?;
    let id = execute(
        ctx,
        &REGULAR_GIFT,
        RegularGiftPayload {
            contact_id: setup.contact_id.clone(),
            client_key: setup.client_key.clone(),
        },
        Exec::create_with_id(id, source).in_group(&group),
    )?
    .id;
    check_live_code(ctx.tx.read(), &setup.source_code_id)?;
    crate::terms::create_first_row(
        ctx,
        &id,
        &crate::terms_rules::date_of_ms(ctx.at),
        setup.amount,
        setup.frequency,
        setup.day_of_month,
        setup.month,
        &setup.source_code_id,
        None,
        &group,
    )?;
    execute(
        ctx,
        &REGULAR_GIFT_MANDATE,
        MandatePayload {
            status: Some(link.status.unwrap_or(RegularStatus::Pending)),
            ended_reason: None,
            ended_at: None,
            ..link
        },
        Exec::update(&id, Some(0), source).in_group(&group),
    )?;
    Ok(id)
}

/// A code staff may give new money to: one of this organisation's full
/// codes, not archived.
pub fn check_live_code(conn: &Connection, source_code_id: &str) -> Result<(), ContractError> {
    match sources::describe(conn, source_code_id)? {
        None => Err(ContractError::rejected(
            "unknown_source_code",
            "The source code must be a full code (category, detail and version)",
        )),
        Some(code) if !code.is_active => Err(ContractError::rejected(
            "archived_source_code",
            format!("{} is archived: choose another", code.code),
        )),
        Some(_) => Ok(()),
    }
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

/// End a regular gift (cancelled or failed) with `reason`, at `at` (ms),
/// and withdraw the changes it had scheduled. One already ended keeps its
/// first end. `None` when nothing changed.
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
    let done = update_mandate(ctx, id, expected, source, None, |m| {
        if m.status().is_ended() {
            return;
        }
        m.status = Some(status);
        m.ended_reason = reason;
        m.ended_at = Some(at);
    })?;
    crate::terms::withdraw_scheduled(ctx, id, None)?;
    Ok(done)
}

/// What the provider glue needs of a regular gift. One read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RegularFacts {
    pub id: String,
    pub contact_id: String,
    pub mandate: MandatePayload,
    /// The row GoCardless runs now ([`crate::terms::current_at_provider`]).
    pub current: Option<crate::terms::TermView>,
}

impl RegularFacts {
    /// The code a one-off on its mandate goes to: the oldest layer of the
    /// terms GoCardless runs (the code that recruited the donor).
    pub fn code(&self) -> Option<String> {
        self.current
            .as_ref()?
            .allocations
            .first()
            .map(|a| a.source_code_id.clone())
    }
}

const FACT_COLUMNS: &str = "id, contact_id, status, ended_reason, ended_at, billing_request_id, \
     flow_url, flow_expires_at, mandate_id, subscription_id";

fn facts_row(r: &Row) -> rusqlite::Result<RegularFacts> {
    Ok(RegularFacts {
        id: r.get(0)?,
        contact_id: r.get(1)?,
        mandate: MandatePayload {
            status: Some(RegularStatus::parse(&r.get::<_, String>(2)?)),
            ended_reason: r.get(3)?,
            ended_at: r.get(4)?,
            billing_request_id: r.get(5)?,
            flow_url: r.get(6)?,
            flow_expires_at: r.get(7)?,
            mandate_id: r.get(8)?,
            subscription_id: r.get(9)?,
        },
        current: None,
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
    let Some(mut found) = conn
        .prepare_cached(&format!(
            "SELECT {FACT_COLUMNS} FROM regular_gifts WHERE {column} = ?1"
        ))?
        .query_row([value], facts_row)
        .optional()?
    else {
        return Ok(None);
    };
    let chain = crate::terms::chain(conn, &found.id)?;
    found.current = crate::terms::current_at_provider(&chain).cloned();
    Ok(Some(found))
}

// ── payments ───────────────────────────────────────────────────────────────

impl PaymentStatus {
    /// The status its gift has: the gift follows its payment (ADR 0025).
    pub fn gift_status(self) -> Status {
        match self {
            PaymentStatus::Pending => Status::Pending,
            PaymentStatus::Confirmed => Status::Completed,
            PaymentStatus::Failed => Status::Failed,
            PaymentStatus::ChargedBack => Status::ChargedBack,
            PaymentStatus::Cancelled => Status::Cancelled,
        }
    }
}

/// [`PaymentStatus::gift_status`] in SQL, over a payment row `p`.
const GIFT_STATUS_OF_PAYMENT: &str =
    "CASE p.status WHEN 'confirmed' THEN 'completed' ELSE p.status END";

/// `giving.directDebitPayment` (v2): one GoCardless payment, as GoCardless
/// reports it: the provider's raw record beside its gift.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PaymentPayload {
    /// GoCardless's payment id (`PM…`); fixed.
    pub payment_id: String,
    /// The regular gift it was collected for; none for a one-off, or a
    /// payment not matched to a donor. Fixed.
    #[serde(default)]
    pub regular_gift_id: Option<String>,
    /// The mandate it was taken on (none: Instant Bank Pay).
    #[serde(default)]
    pub mandate_id: Option<String>,
    #[ts(type = "number")]
    pub amount: i64,
    /// ISO date it is (or was) collected.
    pub charge_date: String,
    pub status: PaymentStatus,
    /// Why it failed or was charged back (the provider's description).
    pub reason: Option<String>,
    /// Its gift (one for the payment's whole life); none while unmatched.
    /// Set once.
    pub gift_id: Option<String>,
    /// The charge date GoCardless first gave it (ISO): its period, kept
    /// through retries. Set once.
    #[serde(default)]
    pub scheduled_on: Option<String>,
    /// The subscription it was created by, if any.
    #[serde(default)]
    pub subscription_id: Option<String>,
}

pub struct DirectDebitPayment;
pub static DIRECT_DEBIT_PAYMENT: DirectDebitPayment = DirectDebitPayment;

const PAYMENT_COLUMNS: &str = "payment_id, regular_gift_id, mandate_id, amount, charge_date, \
     status, reason, gift_id, scheduled_on, subscription_id";

fn load_payment(conn: &Connection, id: &str) -> rusqlite::Result<Option<PaymentPayload>> {
    conn.prepare_cached(&format!(
        "SELECT {PAYMENT_COLUMNS} FROM direct_debit_payments WHERE id = ?1"
    ))?
    .query_row([id], payment_row)
    .optional()
}

fn payment_row(r: &Row) -> rusqlite::Result<PaymentPayload> {
    Ok(PaymentPayload {
        payment_id: r.get(0)?,
        regular_gift_id: r.get(1)?,
        mandate_id: r.get(2)?,
        amount: r.get(3)?,
        charge_date: r.get(4)?,
        status: PaymentStatus::parse(&r.get::<_, String>(5)?),
        reason: r.get(6)?,
        gift_id: r.get(7)?,
        scheduled_on: r.get(8)?,
        subscription_id: r.get(9)?,
    })
}

/// The payment row for GoCardless's payment id: its row id and payload.
fn payment_by_provider_id(
    conn: &Connection,
    payment_id: &str,
) -> rusqlite::Result<Option<(String, PaymentPayload)>> {
    conn.prepare_cached(&format!(
        "SELECT id, {PAYMENT_COLUMNS} FROM direct_debit_payments WHERE payment_id = ?1"
    ))?
    .query_row([payment_id], |r| {
        let p = PaymentPayload {
            payment_id: r.get(1)?,
            regular_gift_id: r.get(2)?,
            mandate_id: r.get(3)?,
            amount: r.get(4)?,
            charge_date: r.get(5)?,
            status: PaymentStatus::parse(&r.get::<_, String>(6)?),
            reason: r.get(7)?,
            gift_id: r.get(8)?,
            scheduled_on: r.get(9)?,
            subscription_id: r.get(10)?,
        };
        Ok((r.get(0)?, p))
    })
    .optional()
}

impl Contract for DirectDebitPayment {
    const NAME: &'static str = "giving.directDebitPayment";
    /// v2: `mandateId`; `regularGiftId` optional; no `giftVoided`
    /// (ADR 0025). v3: `scheduledOn`, `subscriptionId` (ADR 0026).
    const VERSION: u32 = 3;
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
        // A payment stored unmatched (no gift) may be adopted by its
        // regular gift; after that, neither changes.
        let adopting = |c: &PaymentPayload| c.regular_gift_id.is_none() && c.gift_id.is_none();
        if let Some(current) = current
            && (current.payment_id != p.payment_id
                || (current.regular_gift_id != p.regular_gift_id && !adopting(current))
                || (current.gift_id.is_some() && current.gift_id != p.gift_id)
                || (current.scheduled_on.is_some() && current.scheduled_on != p.scheduled_on))
        {
            return Err(ContractError::rejected(
                "identity_immutable",
                "A payment’s provider id, regular gift and gift can’t change",
            ));
        }
        Ok(p.clone())
    }

    /// v1 had `giftVoided` (ignored now) and always a regular gift; v2
    /// no `scheduledOn` or `subscriptionId` (none): the same JSON reads
    /// as v3.
    fn upcast(&self, from: u32, payload: serde_json::Value) -> Option<serde_json::Value> {
        (from == 1 || from == 2).then_some(payload)
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
                "INSERT INTO direct_debit_payments (id, payment_id, regular_gift_id, mandate_id,
                     amount, charge_date, status, reason, gift_id, scheduled_on, subscription_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            )?
            .execute(params![
                id,
                next.payment_id,
                next.regular_gift_id,
                next.mandate_id,
                next.amount,
                next.charge_date,
                next.status.as_str(),
                next.reason,
                next.gift_id,
                next.scheduled_on,
                next.subscription_id
            ])?;
        } else {
            tx.prepare_cached(
                "UPDATE direct_debit_payments SET mandate_id = ?2, amount = ?3, charge_date = ?4,
                     status = ?5, reason = ?6, gift_id = ?7, regular_gift_id = ?8,
                     scheduled_on = ?9, subscription_id = ?10
                 WHERE id = ?1",
            )?
            .execute(params![
                id,
                next.mandate_id,
                next.amount,
                next.charge_date,
                next.status.as_str(),
                next.reason,
                next.gift_id,
                next.regular_gift_id,
                next.scheduled_on,
                next.subscription_id
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
    /// The mandate it was taken on, if any.
    pub mandate_id: Option<String>,
    /// The subscription that created it, if any.
    pub subscription_id: Option<String>,
}

/// Whose a payment is, as the provider glue worked it out. A payment
/// already on record keeps the regular gift it was recorded for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaymentOwner {
    /// An instalment of this regular gift: its donor and code.
    Regular(String),
    /// A one-off from this donor (a payment on a mandate we know but no
    /// subscription, one staff took, or an Instant Bank Pay link),
    /// allocated to this code.
    OneOff {
        contact_id: String,
        source_code_id: String,
        /// The staff request it answers ([`crate::requests`]): its gift is
        /// made as the staff member who asked.
        request: Option<String>,
    },
    /// Nobody we know: stored with no gift, listed for staff to match.
    Unmatched,
}

/// What [`record_payment`] did to the gifts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GiftChange {
    None,
    /// The payment's gift, made now.
    Recorded(String),
    /// Its gift brought up to date.
    Updated(String),
    /// Stored with no gift: nobody to give it to yet.
    Unmatched,
}

/// A split as gift allocation rows (new keys).
fn allocation_rows(split: Vec<Share>) -> Vec<AllocationRow> {
    split
        .into_iter()
        .map(|s| AllocationRow {
            key: None,
            source_code_id: s.source_code_id,
            amount: s.amount,
        })
        .collect()
}

/// "collected", "failed", "charged back": what a payment's status says.
fn said(status: PaymentStatus) -> &'static str {
    match status {
        PaymentStatus::Pending => "pending",
        PaymentStatus::Confirmed => "collected",
        PaymentStatus::Failed => "failed",
        PaymentStatus::ChargedBack => "charged back",
        PaymentStatus::Cancelled => "cancelled",
    }
}

/// Why the gift doesn't count, from GoCardless: "Charged back
/// (GoCardless): the customer disputed…". None for money received.
fn gift_reason(status: PaymentStatus, reason: Option<&str>) -> Option<String> {
    if status.gift_status().is_received() {
        return None;
    }
    let what = match status {
        PaymentStatus::Pending => "Not collected yet",
        PaymentStatus::Failed => "Failed",
        PaymentStatus::ChargedBack => "Charged back",
        _ => "Cancelled",
    };
    Some(match reason {
        Some(r) => format!("{what} (GoCardless): {r}"),
        None => format!("{what} (GoCardless)"),
    })
}

/// Bring the payment `report` describes up to date, and its gift with it,
/// in the caller's transaction, as the system (ADR 0025): one gift per
/// payment for its whole life, following the payment.
/// - First sight: the payment row, and (if `owner` names a donor) its
///   gift: `direct_debit`, the payment id as reference and origin, dated
///   the charge date, all of it to the regular gift's (or the one-off's)
///   code, with the payment's status.
/// - Later reports: the same gift takes the payment's status (with
///   GoCardless's reason when it doesn't count), and its amount and date
///   (the date the money was collected decides its tax year), except
///   that a gift in a Gift Aid claim keeps the amount and date it was
///   claimed on (its status still follows: a claimed gift that stops
///   counting is paid back by the next claim), and a gift staff voided
///   stays void.
/// - A payment on record with no gift (unmatched) gets one once `owner`
///   names a donor.
///
/// A report that changes nothing writes nothing, so a replayed event is a
/// no-op.
pub fn record_payment(
    ctx: &Ctx,
    report: PaymentReport,
    owner: PaymentOwner,
) -> Result<GiftChange, ContractError> {
    record(ctx, report, owner, None)
}

fn record(
    ctx: &Ctx,
    report: PaymentReport,
    owner: PaymentOwner,
    staff: Option<(i64, Source)>,
) -> Result<GiftChange, ContractError> {
    let conn = ctx.tx.read();
    let held = payment_by_provider_id(conn, &report.payment_id)?;
    let before = held.as_ref().map(|(_, p)| p.clone());
    let regular_id = match (&before, &owner) {
        (Some(b), PaymentOwner::Regular(id))
            if b.regular_gift_id.as_ref().is_some_and(|r| r != id) =>
        {
            return Err(ContractError::rejected(
                "payment_elsewhere",
                "This payment belongs to another regular gift",
            ));
        }
        // Stored unmatched before its regular gift was known: adopted.
        (Some(b), PaymentOwner::Regular(id))
            if b.regular_gift_id.is_none() && b.gift_id.is_none() =>
        {
            Some(id.clone())
        }
        (Some(b), _) => b.regular_gift_id.clone(),
        (None, PaymentOwner::Regular(id)) => Some(id.clone()),
        (None, _) => None,
    };
    let mut next = PaymentPayload {
        payment_id: report.payment_id.clone(),
        regular_gift_id: regular_id.clone(),
        mandate_id: report
            .mandate_id
            .clone()
            .or_else(|| before.as_ref().and_then(|b| b.mandate_id.clone())),
        amount: report.amount,
        charge_date: report.charge_date.clone(),
        status: report.status,
        reason: report
            .reason
            .clone()
            .or_else(|| before.as_ref().and_then(|b| b.reason.clone())),
        gift_id: before.as_ref().and_then(|b| b.gift_id.clone()),
        // The date it was first given: its period for good.
        scheduled_on: before
            .as_ref()
            .and_then(|b| b.scheduled_on.clone())
            .or_else(|| Some(report.charge_date.clone())),
        subscription_id: report
            .subscription_id
            .clone()
            .or_else(|| before.as_ref().and_then(|b| b.subscription_id.clone())),
    };
    let scheduled_on = next.scheduled_on.clone().unwrap_or_default();
    // Who the gift is for and its split, while the payment has none, and
    // the staff request it answers.
    let donor: Option<(String, Vec<AllocationRow>, Option<String>)> = if next.gift_id.is_some() {
        None
    } else if let Some(id) = &regular_id {
        let regular = facts(conn, id)?.ok_or(ContractError::NotFound)?;
        // The rows GoCardless has that this payment settles, then the
        // split in force on its scheduled date (ADR 0026).
        crate::terms::on_payment(ctx, id, &scheduled_on, report.amount, None)?;
        let chain = crate::terms::chain(ctx.tx.read(), id)?;
        let row = crate::terms::in_force(&chain, &scheduled_on)
            .or_else(|| chain.iter().find(|t| t.is_live()))
            .ok_or(ContractError::NotFound)?;
        let split = crate::terms_rules::split_for_collected(&row.split(), report.amount);
        Some((regular.contact_id, allocation_rows(split), None))
    } else if let PaymentOwner::OneOff {
        contact_id,
        source_code_id,
        request,
    } = &owner
    {
        Some((
            contact_id.clone(),
            vec![AllocationRow {
                key: None,
                source_code_id: source_code_id.clone(),
                amount: report.amount,
            }],
            request.clone(),
        ))
    } else {
        None
    };
    if before.as_ref() == Some(&next) && donor.is_none() {
        return Ok(GiftChange::None);
    }

    let amount = format_pence(report.amount);
    let because = next
        .reason
        .as_deref()
        .filter(|_| !report.status.gift_status().is_received())
        .map(|r| format!(": {r}"))
        .unwrap_or_default();
    let target = report.status.gift_status();
    let reason = gift_reason(report.status, next.reason.as_deref());

    let mut change = GiftChange::None;
    if let Some((contact_id, allocations, request)) = donor {
        // Asked for by staff: the gift is theirs to answer for (its
        // history names them), though GoCardless's word made it.
        let requester = match &request {
            Some(r) => crate::requests::requested_by(conn, r)?.flatten(),
            None => None,
        };
        let acting;
        let ctx = match requester {
            Some(actor) => {
                acting = Ctx {
                    tx: ctx.tx,
                    actor: Some(actor),
                    at: ctx.at,
                };
                &acting
            }
            None => ctx,
        };
        let name = match (staff, requester) {
            (Some(_), _) => format!("Direct Debit {amount} matched to a donor"),
            (None, Some(_)) => format!(
                "Direct Debit {amount} {}{because}, as asked by staff",
                said(report.status)
            ),
            (None, None) => format!("Direct Debit {amount} {}{because}", said(report.status)),
        };
        let group = command_group(ctx, &name)?;
        let gift = crate::create_provider_gift(
            ctx,
            GiftPayload {
                contact_id,
                received_on: report.charge_date.clone(),
                amount: report.amount,
                method: Method::DirectDebit,
                reference: Some(report.payment_id.clone()),
                allocations,
                client_key: None,
                origin: Some(ProviderRef {
                    provider: Provider::Gocardless,
                    payment_id: report.payment_id.clone(),
                    regular_gift_id: regular_id.clone(),
                    scheduled_on: regular_id.as_ref().map(|_| scheduled_on.clone()),
                }),
            },
            target,
            reason,
            &group,
        )?;
        next.gift_id = Some(gift.clone());
        change = GiftChange::Recorded(gift);
        let exec = match (&held, staff) {
            (None, _) => Exec::create(Source::System),
            (Some((id, _)), Some((expected, source))) => Exec::update(id, Some(expected), source),
            (Some((id, _)), None) => Exec::update(id, None, Source::System),
        };
        execute(ctx, &DIRECT_DEBIT_PAYMENT, next, exec.in_group(&group))?;
        return Ok(change);
    }

    let group = command_group(
        ctx,
        &format!("Direct Debit {amount} {}{because}", said(report.status)),
    )?;
    if let Some(gift) = next.gift_id.clone() {
        if sync_gift(ctx, &gift, &report, target, reason, &group)? {
            change = GiftChange::Updated(gift);
        }
    } else {
        change = GiftChange::Unmatched;
    }
    let exec = match &held {
        None => Exec::create(Source::System),
        Some((id, _)) => Exec::update(id, None, Source::System),
    };
    execute(ctx, &DIRECT_DEBIT_PAYMENT, next, exec.in_group(&group))?;
    Ok(change)
}

/// The payment's gift takes its amount, date and status, unless a claim
/// holds the amount and date or staff voided it. Whether it changed.
fn sync_gift(
    ctx: &Ctx,
    gift: &str,
    report: &PaymentReport,
    target: Status,
    reason: Option<String>,
    group: &CommandGroup,
) -> Result<bool, ContractError> {
    let conn = ctx.tx.read();
    let Some((status, claimed)) = conn
        .prepare_cached(
            "SELECT status, claim_id IS NOT NULL FROM gifts WHERE id = ?1
             /* any status: one gift */",
        )?
        .query_row([gift], |r| {
            Ok((Status::parse(&r.get::<_, String>(0)?), r.get::<_, bool>(1)?))
        })
        .optional()?
    else {
        return Err(ContractError::NotFound);
    };
    let mut changed = false;
    if !claimed {
        let current = crate::get(conn, gift)?.ok_or(ContractError::NotFound)?.gift;
        if current.amount != report.amount || current.received_on != report.charge_date {
            // The gift's own split (staff may have corrected it), with
            // its newest layer absorbing a new amount (ADR 0026); a
            // layer kept keeps its key.
            let split: Vec<Share> = current
                .allocations
                .iter()
                .map(|a| Share::new(&a.source_code_id, a.amount))
                .collect();
            let allocations = crate::terms_rules::split_for_collected(&split, report.amount)
                .into_iter()
                .enumerate()
                .map(|(i, s)| AllocationRow {
                    key: current
                        .allocations
                        .get(i)
                        .filter(|a| a.source_code_id == s.source_code_id)
                        .map(|a| a.key.clone()),
                    source_code_id: s.source_code_id,
                    amount: s.amount,
                })
                .collect();
            execute(
                ctx,
                &crate::GIFT,
                GiftPayload {
                    contact_id: current.contact_id,
                    received_on: report.charge_date.clone(),
                    amount: report.amount,
                    method: current.method,
                    reference: current.reference,
                    allocations,
                    client_key: None,
                    origin: None,
                },
                Exec::update(gift, None, Source::System).in_group(group),
            )?;
            changed = true;
        }
    }
    // A void is staff's: it outlives what the provider says next.
    if status != Status::Void {
        let held_reason: Option<String> = conn
            .prepare_cached(
                "SELECT void_reason FROM gifts WHERE id = ?1 /* any status: one gift */",
            )?
            .query_row([gift], |r| r.get(0))?;
        if status != target || (!target.is_received() && held_reason != reason) {
            execute(
                ctx,
                &crate::STATUS,
                StatusPayload {
                    status: target,
                    reason,
                },
                Exec::update(gift, None, Source::System).in_group(group),
            )?;
            changed = true;
        }
    }
    Ok(changed)
}

/// Whether gift `gift_id`'s payment now says another amount or charge
/// date than the gift (which a claim holds): a draft claim holding it is
/// held back (Gift Aid's Ready check, review L4).
pub fn payment_moved(conn: &Connection, gift_id: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT 1 FROM direct_debit_payments p JOIN gifts g ON g.id = p.gift_id
         WHERE p.gift_id = ?1 AND (p.amount <> g.amount OR p.charge_date <> g.received_on)
         /* any status: one gift */",
    )?
    .exists([gift_id])
}

/// Bring a provider gift up to its payment again (after a claim let it
/// go: what the claim held may have moved since), under `group`. A gift
/// with no payment row is left as it is.
pub fn resync_gift(ctx: &Ctx, gift_id: &str, group: &CommandGroup) -> Result<(), ContractError> {
    let Some(p) = ctx
        .tx
        .read()
        .prepare_cached(&format!(
            "SELECT {PAYMENT_COLUMNS} FROM direct_debit_payments WHERE gift_id = ?1"
        ))?
        .query_row([gift_id], payment_row)
        .optional()?
    else {
        return Ok(());
    };
    let report = PaymentReport {
        payment_id: p.payment_id,
        amount: p.amount,
        charge_date: p.charge_date,
        status: p.status,
        reason: p.reason.clone(),
        mandate_id: p.mandate_id,
        subscription_id: p.subscription_id,
    };
    let reason = gift_reason(p.status, p.reason.as_deref());
    sync_gift(ctx, gift_id, &report, p.status.gift_status(), reason, group)?;
    Ok(())
}

/// Staff match an unmatched payment (row `id`, `expected` its version) to
/// a donor: its gift is made, with the payment's facts and status,
/// allocated to `source_code_id` (which must be live). Its id.
pub fn match_payment(
    ctx: &Ctx,
    id: &str,
    expected: i64,
    contact_id: &str,
    source_code_id: &str,
    source: Source,
) -> Result<String, ContractError> {
    let conn = ctx.tx.read();
    let (p, version): (PaymentPayload, i64) = conn
        .prepare_cached(&format!(
            "SELECT {PAYMENT_COLUMNS}, version FROM direct_debit_payments WHERE id = ?1"
        ))?
        .query_row([id], |r| Ok((payment_row(r)?, r.get(10)?)))
        .optional()?
        .ok_or(ContractError::NotFound)?;
    if p.gift_id.is_some() || p.regular_gift_id.is_some() {
        return Err(ContractError::rejected(
            "already_matched",
            "This payment is already a donor’s gift",
        ));
    }
    if version != expected {
        return Err(ContractError::Stale {
            contract: DirectDebitPayment::NAME,
            counter: version,
            current: serde_json::to_value(&p).unwrap_or_default(),
        });
    }
    if contacts::donors::kind_of(conn, contact_id)?.is_none() {
        return Err(ContractError::rejected(
            "unknown_contact",
            "Contact must exist",
        ));
    }
    match sources::describe(conn, source_code_id)? {
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
        Some(_) => {}
    }
    let report = PaymentReport {
        payment_id: p.payment_id.clone(),
        amount: p.amount,
        charge_date: p.charge_date.clone(),
        status: p.status,
        reason: p.reason.clone(),
        mandate_id: p.mandate_id.clone(),
        subscription_id: p.subscription_id.clone(),
    };
    match record(
        ctx,
        report,
        PaymentOwner::OneOff {
            contact_id: contact_id.to_owned(),
            source_code_id: source_code_id.to_owned(),
            request: None,
        },
        Some((expected, source)),
    )? {
        GiftChange::Recorded(gift) => Ok(gift),
        _ => Err(ContractError::rejected(
            "already_matched",
            "This payment is already a donor’s gift",
        )),
    }
}

/// The status a provider payment gives its gift now, and the provider's
/// reason: what un-voiding the gift restores. None: no payment row.
pub fn payment_status_of_gift(
    conn: &Connection,
    gift_id: &str,
) -> rusqlite::Result<Option<(Status, Option<String>)>> {
    conn.prepare_cached("SELECT status, reason FROM direct_debit_payments WHERE gift_id = ?1")?
        .query_row([gift_id], |r| {
            let status = PaymentStatus::parse(&r.get::<_, String>(0)?);
            let reason: Option<String> = r.get(1)?;
            Ok((status.gift_status(), gift_reason(status, reason.as_deref())))
        })
        .optional()
}

/// A payment we couldn't tie to a donor, as staff see it to match it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnmatchedPayment {
    pub id: String,
    pub payment_id: String,
    pub mandate_id: Option<String>,
    #[ts(type = "number")]
    pub amount: i64,
    pub charge_date: String,
    pub status: PaymentStatus,
    pub reason: Option<String>,
    /// Pass as `expected` to match it.
    #[ts(type = "number")]
    pub version: i64,
}

/// The most unmatched payments one read lists (newest first).
pub const UNMATCHED_LIMIT: usize = 500;

/// Payments with no gift: nobody to give them to yet. Newest first.
pub fn unmatched(conn: &Connection) -> rusqlite::Result<Vec<UnmatchedPayment>> {
    conn.prepare_cached(
        "SELECT id, payment_id, mandate_id, amount, charge_date, status, reason, version
         FROM direct_debit_payments INDEXED BY direct_debit_payments_unmatched
         WHERE gift_id IS NULL ORDER BY seq DESC LIMIT ?1",
    )?
    .query_map([UNMATCHED_LIMIT as i64], |r| {
        Ok(UnmatchedPayment {
            id: r.get(0)?,
            payment_id: r.get(1)?,
            mandate_id: r.get(2)?,
            amount: r.get(3)?,
            charge_date: r.get(4)?,
            status: PaymentStatus::parse(&r.get::<_, String>(5)?),
            reason: r.get(6)?,
            version: r.get(7)?,
        })
    })?
    .collect()
}

/// The regular gift (if any) whose mandate is `mandate_id`.
pub fn by_mandate(conn: &Connection, mandate_id: &str) -> rusqlite::Result<Option<RegularFacts>> {
    facts_by(conn, "mandate_id", mandate_id)
}

/// Every way a provider payment and the gifts disagree (ADR 0025,
/// decision 7): a matched payment without exactly one gift, a gift
/// whose amount, date or status isn't its payment's (a claimed gift keeps
/// its claimed amount and date; a staff void stands), a gift of another
/// regular gift or (for an instalment) another donor, a provider gift
/// with no payment, or one with no payment id that isn't void. Empty
/// when consistent. Read-only.
pub fn consistency(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut problems: Vec<String> = conn
        .prepare(&format!(
            "SELECT p.payment_id,
                 (SELECT count(*) FROM gifts g WHERE g.provider = 'gocardless'
                      AND g.provider_payment_id = p.payment_id /* any status: the payment's */),
                 g.id, g.amount, g.received_on, g.status, g.claim_id IS NOT NULL,
                 p.gift_id, p.amount, p.charge_date, {GIFT_STATUS_OF_PAYMENT},
                 p.regular_gift_id IS NOT NULL
             FROM direct_debit_payments p
             LEFT JOIN gifts g ON g.provider = 'gocardless'
                 AND g.provider_payment_id = p.payment_id /* any status: the payment's */
             ORDER BY p.seq"
        ))?
        .query_map([], |r| {
            let payment: String = r.get(0)?;
            let count: i64 = r.get(1)?;
            let gift: Option<String> = r.get(2)?;
            let linked: Option<String> = r.get(7)?;
            let matched = linked.is_some() || r.get::<_, bool>(11)?;
            Ok(if count != 1 {
                (count != 0 || matched)
                    .then(|| format!("payment {payment}: {count} gifts, not one"))
            } else if gift != linked {
                Some(format!(
                    "payment {payment}: its gift is {}, but {} names it",
                    linked.as_deref().unwrap_or("none"),
                    gift.as_deref().unwrap_or("none")
                ))
            } else {
                let (amount, date, status, claimed): (i64, String, String, bool) =
                    (r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?);
                let (p_amount, p_date, p_status): (i64, String, String) =
                    (r.get(8)?, r.get(9)?, r.get(10)?);
                if !claimed && (amount != p_amount || date != p_date) {
                    Some(format!(
                        "payment {payment}: gift is {amount}p on {date}, payment {p_amount}p on {p_date}"
                    ))
                } else if status != p_status && status != "void" {
                    Some(format!(
                        "payment {payment}: gift is {status}, payment says {p_status}"
                    ))
                } else {
                    None
                }
            })
        })?
        .filter_map(Result::transpose)
        .collect::<rusqlite::Result<_>>()?;
    let orphans: Vec<String> = conn
        .prepare(
            "SELECT g.id, g.provider_payment_id FROM gifts g
             WHERE g.provider = 'gocardless' AND g.provider_payment_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM direct_debit_payments p
                               WHERE p.payment_id = g.provider_payment_id)
             /* any status: every provider gift */",
        )?
        .query_map([], |r| {
            Ok(format!(
                "gift {}: payment {} isn't on record",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    problems.extend(orphans);
    // A provider gift with no payment id is D2's superseded attempt: it
    // must stay void, or the same money counts twice (review L2).
    let loose: Vec<String> = conn
        .prepare(
            "SELECT g.id, g.status FROM gifts g
             WHERE g.provider IS NOT NULL AND g.provider_payment_id IS NULL
               AND g.status <> 'void'
             /* any status: every provider gift without a payment */",
        )?
        .query_map([], |r| {
            Ok(format!(
                "gift {}: a provider gift with no payment id is {}, not void",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    problems.extend(loose);
    // The gift is the payment's regular gift's, and an instalment's donor
    // is its regular gift's.
    let owners: Vec<String> = conn
        .prepare(
            "SELECT p.payment_id, g.id FROM direct_debit_payments p
             JOIN gifts g ON g.id = p.gift_id /* any status: the payment's */
             LEFT JOIN regular_gifts r ON r.id = p.regular_gift_id
             WHERE g.regular_gift_id IS NOT p.regular_gift_id
                OR (r.id IS NOT NULL AND g.contact_id <> r.contact_id)",
        )?
        .query_map([], |r| {
            Ok(format!(
                "payment {}: its gift {} names another regular gift or donor",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    problems.extend(owners);
    Ok(problems)
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
    /// The date it was first scheduled: its period.
    pub scheduled_on: Option<String>,
    pub status: PaymentStatus,
    pub reason: Option<String>,
    pub gift_id: Option<String>,
}

/// A payment GoCardless will take next, as staff pick a change's first
/// payment from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpcomingPayment {
    pub charge_date: String,
    #[ts(type = "number")]
    pub amount: i64,
    /// Far enough off for a change sent now to reach it.
    pub changeable: bool,
}

/// A regular gift with its chain and its latest payments (newest charge
/// date first, at most [`PAYMENTS_LIMIT`]). The amount, schedule and
/// split are the row in force today (or the first row, before it
/// starts). `upcoming` and `connected` are the api's: GoCardless's next
/// payments (one regular gift's read only) and whether the
/// organisation's account is connected now.
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
    /// The oldest layer's code: the one that recruited the donor.
    pub source_code_id: String,
    /// The code as it reads now; null if it isn't one of this
    /// organisation's.
    pub source_code: Option<String>,
    /// The split in force, oldest money first.
    pub allocations: Vec<crate::terms::TermAllocationView>,
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
    pub setup_version: i64,
    #[ts(type = "number")]
    pub mandate_version: i64,
    /// The chain, in effective order, withdrawn rows included.
    pub terms: Vec<crate::terms::TermView>,
    /// The next change still to reach GoCardless, if any.
    pub scheduled: Option<crate::terms::TermView>,
    /// A change GoCardless told us of is waiting for its code.
    pub change_not_coded: bool,
    pub upcoming: Vec<UpcomingPayment>,
    /// The latest failed payment, if the latest payment failed.
    pub last_failure: Option<DirectDebitPaymentRow>,
    pub payments: Vec<DirectDebitPaymentRow>,
    pub connected: bool,
}

const VIEW_COLUMNS: &str = "id, contact_id, status, ended_reason, ended_at, billing_request_id, \
     flow_url, flow_expires_at, mandate_id, subscription_id, entered_by, entered_at, \
     setup_version, mandate_version";

fn view_row(r: &Row) -> rusqlite::Result<RegularGiftView> {
    Ok(RegularGiftView {
        id: r.get(0)?,
        contact_id: r.get(1)?,
        amount: 0,
        frequency: Frequency::Monthly,
        day_of_month: 1,
        month: None,
        source_code_id: String::new(),
        source_code: None,
        allocations: vec![],
        status: RegularStatus::parse(&r.get::<_, String>(2)?),
        ended_reason: r.get(3)?,
        ended_at: r.get(4)?,
        billing_request_id: r.get(5)?,
        flow_url: r.get(6)?,
        flow_expires_at: r.get(7)?,
        mandate_id: r.get(8)?,
        subscription_id: r.get(9)?,
        entered_by: r.get(10)?,
        entered_at: r.get(11)?,
        setup_version: r.get(12)?,
        mandate_version: r.get(13)?,
        terms: vec![],
        scheduled: None,
        change_not_coded: false,
        upcoming: vec![],
        last_failure: None,
        payments: vec![],
        connected: false,
    })
}

/// Fill a view's chain and payments; `today` (ISO) picks the row in
/// force.
fn fill(
    conn: &Connection,
    mut v: RegularGiftView,
    today: &str,
) -> rusqlite::Result<RegularGiftView> {
    v.terms = crate::terms::chain(conn, &v.id)?;
    if let Some(now) =
        crate::terms::in_force(&v.terms, today).or_else(|| v.terms.iter().find(|t| t.is_live()))
    {
        v.amount = now.amount;
        v.frequency = now.frequency;
        v.day_of_month = now.day_of_month;
        v.month = now.month;
        v.allocations = now.allocations.clone();
        if let Some(first) = now.allocations.first() {
            v.source_code_id = first.source_code_id.clone();
            v.source_code = first.source_code.clone();
        }
    }
    v.scheduled = v
        .terms
        .iter()
        .find(|t| t.status == crate::terms::TermStatus::Scheduled)
        .cloned();
    v.change_not_coded = v.terms.iter().any(|t| t.uncoded);
    v.payments = conn
        .prepare_cached(
            "SELECT id, payment_id, amount, charge_date, scheduled_on, status, reason, gift_id
             FROM direct_debit_payments WHERE regular_gift_id = ?1
             ORDER BY charge_date DESC, seq DESC LIMIT ?2",
        )?
        .query_map(params![v.id, PAYMENTS_LIMIT as i64], |r| {
            Ok(DirectDebitPaymentRow {
                id: r.get(0)?,
                payment_id: r.get(1)?,
                amount: r.get(2)?,
                charge_date: r.get(3)?,
                scheduled_on: r.get(4)?,
                status: PaymentStatus::parse(&r.get::<_, String>(5)?),
                reason: r.get(6)?,
                gift_id: r.get(7)?,
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

/// One regular gift as of `today` (ISO), or `None`.
pub fn get_regular(
    conn: &Connection,
    id: &str,
    today: &str,
) -> rusqlite::Result<Option<RegularGiftView>> {
    let found = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gifts WHERE id = ?1"
        ))?
        .query_row([id], view_row)
        .optional()?;
    found.map(|v| fill(conn, v, today)).transpose()
}

/// A contact's regular gifts as of `today` (ISO), newest set up first.
pub fn regular_by_contact(
    conn: &Connection,
    contact_id: &str,
    today: &str,
) -> rusqlite::Result<Vec<RegularGiftView>> {
    let rows: Vec<RegularGiftView> = conn
        .prepare_cached(&format!(
            "SELECT {VIEW_COLUMNS} FROM regular_gifts WHERE contact_id = ?1 ORDER BY seq DESC"
        ))?
        .query_map([contact_id], view_row)?
        .collect::<rusqlite::Result<_>>()?;
    rows.into_iter().map(|v| fill(conn, v, today)).collect()
}

/// The next payments of a regular gift as its chain projects them after
/// `today` (when GoCardless can't be asked): at most `n`, each changeable
/// if it is more than a week off and no payment for it exists yet.
pub fn projected_upcoming(
    conn: &Connection,
    id: &str,
    today: &str,
    n: usize,
) -> rusqlite::Result<Vec<UpcomingPayment>> {
    let chain = crate::terms::chain(conn, id)?;
    let Some(now) = crate::terms::current_at_provider(&chain) else {
        return Ok(vec![]);
    };
    let rules = crate::terms::live_rules(&chain);
    let mut out = Vec::new();
    for date in crate::terms_rules::next_due(&now.rules(), today, n) {
        let amount =
            crate::terms_rules::term_in_force(&rules, &date).map_or(now.amount, |t| t.amount);
        out.push(UpcomingPayment {
            changeable: changeable(conn, id, today, &date)?,
            charge_date: date,
            amount,
        });
    }
    Ok(out)
}

/// Whether a change can still reach the payment due on `date`: it is more
/// than a week after `today` and GoCardless hasn't created it.
pub fn changeable(conn: &Connection, id: &str, today: &str, date: &str) -> rusqlite::Result<bool> {
    let soon = crate::terms_rules::add_days(today, 7).unwrap_or_default();
    if date <= soon.as_str() {
        return Ok(false);
    }
    Ok(crate::terms::payment_on_or_after(conn, id, date)?.is_none())
}

/// A subscription nobody here set up, on a mandate we know: its payments
/// are one-off gifts until staff adopt it as a regular gift.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UnknownSubscription {
    pub subscription_id: String,
    pub mandate_id: Option<String>,
    /// The donor its mandate's regular gift is from.
    pub contact_id: Option<String>,
    #[ts(type = "number")]
    pub payments: i64,
    /// The latest payment's amount and charge date.
    #[ts(type = "number")]
    pub last_amount: i64,
    pub last_charge_date: String,
}

/// Subscriptions payments came from that no regular gift here has ever
/// run under, newest payment first, at most [`UNMATCHED_LIMIT`].
pub fn unknown_subscriptions(conn: &Connection) -> rusqlite::Result<Vec<UnknownSubscription>> {
    unknown(conn, None)
}

/// Subscription `sb` if it is one of [`unknown_subscriptions`], however
/// far down the list.
pub fn unknown_subscription(
    conn: &Connection,
    sb: &str,
) -> rusqlite::Result<Option<UnknownSubscription>> {
    Ok(unknown(conn, Some(sb))?.pop())
}

/// Whether a regular gift other than `id`, not ended, collects on mandate
/// `md`: its own mandate, or (adopted) a subscription whose payments were
/// taken on it. Cancelling the mandate would end that one too.
pub fn others_on_mandate(conn: &Connection, id: &str, md: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached(
        "SELECT 1 FROM regular_gifts r
         WHERE r.id <> ?1 AND r.status IN ('pending', 'active')
           AND (r.mandate_id = ?2
                OR EXISTS (SELECT 1 FROM direct_debit_payments p
                           WHERE p.subscription_id = r.subscription_id AND p.mandate_id = ?2))",
    )?
    .exists(params![id, md])
}

fn unknown(conn: &Connection, only: Option<&str>) -> rusqlite::Result<Vec<UnknownSubscription>> {
    conn.prepare_cached(
        "WITH unknown AS (
             SELECT p.subscription_id AS sb, max(p.mandate_id) AS mandate, count(*) AS n,
                 max(p.charge_date) AS last, max(p.seq) AS latest
             FROM direct_debit_payments p INDEXED BY direct_debit_payments_by_subscription
             WHERE p.subscription_id IS NOT NULL AND p.regular_gift_id IS NULL
               AND (?2 IS NULL OR p.subscription_id = ?2)
               AND NOT EXISTS (SELECT 1 FROM regular_gifts r
                               WHERE r.subscription_id = p.subscription_id)
               AND NOT EXISTS (SELECT 1 FROM regular_gift_terms t
                               WHERE t.subscription_id = p.subscription_id)
             GROUP BY p.subscription_id)
         SELECT u.sb, u.mandate, u.n,
             (SELECT q.amount FROM direct_debit_payments q
              WHERE q.subscription_id = u.sb ORDER BY q.charge_date DESC, q.seq DESC LIMIT 1),
             u.last,
             (SELECT r.contact_id FROM regular_gifts r WHERE r.mandate_id = u.mandate)
         FROM unknown u ORDER BY u.latest DESC LIMIT ?1",
    )?
    .query_map(params![UNMATCHED_LIMIT as i64, only], |r| {
        Ok(UnknownSubscription {
            subscription_id: r.get(0)?,
            mandate_id: r.get(1)?,
            payments: r.get(2)?,
            last_amount: r.get(3)?,
            last_charge_date: r.get(4)?,
            contact_id: r.get(5)?,
        })
    })?
    .collect()
}

/// Staff adopt subscription `sb` as a new regular gift of `contact_id`
/// (`id` pre-generated): active, the subscription its own, its first row
/// applied from GoCardless's terms (`setup`) in force from
/// `effective_from` (its next payment). No GoCardless call: it is
/// collecting already. Payments before stay one-off gifts.
pub fn adopt_subscription(
    ctx: &Ctx,
    id: &str,
    sb: &str,
    setup: SetUp,
    effective_from: &str,
    source: Source,
) -> Result<String, ContractError> {
    let setup = prepare_setup(setup)?;
    let conn = ctx.tx.read();
    if crate::terms::regular_gift_of_subscription(conn, sb)?.is_some() {
        return Err(ContractError::rejected(
            "already_adopted",
            "This subscription is already a regular gift",
        ));
    }
    check_live_code(conn, &setup.source_code_id)?;
    let group = command_group(
        ctx,
        &format!(
            "{} adopted from GoCardless",
            regular_group_name(setup.amount, setup.frequency)
        ),
    )?;
    let id = execute(
        ctx,
        &REGULAR_GIFT,
        RegularGiftPayload {
            contact_id: setup.contact_id.clone(),
            client_key: setup.client_key.clone(),
        },
        Exec::create_with_id(id, source).in_group(&group),
    )?
    .id;
    crate::terms::create_first_row(
        ctx,
        &id,
        effective_from,
        setup.amount,
        setup.frequency,
        setup.day_of_month,
        setup.month,
        &setup.source_code_id,
        Some(sb.to_owned()),
        &group,
    )?;
    execute(
        ctx,
        &REGULAR_GIFT_MANDATE,
        MandatePayload {
            status: Some(RegularStatus::Active),
            subscription_id: Some(sb.to_owned()),
            ..MandatePayload::default()
        },
        Exec::update(&id, Some(0), source).in_group(&group),
    )?;
    Ok(id)
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
    WHERE method = 'direct_debit' AND status = 'completed';

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
    gift_voided INTEGER NOT NULL DEFAULT 0 CHECK (gift_voided IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX direct_debit_payments_by_regular_gift
    ON direct_debit_payments (regular_gift_id, charge_date, seq);
-- giving.status reads a gift's payment on every void and un-void.
CREATE INDEX direct_debit_payments_by_gift ON direct_debit_payments (gift_id)
    WHERE gift_id IS NOT NULL;
";

/// Org schema step 18 (ADR 0025: gifts are every payment attempt), after
/// [`MIGRATION_DIRECT_DEBIT`]. Run with foreign keys deferred (it
/// rebuilds two tables others point at):
/// - `gifts.status` widens to every attempt's status, and a gift names
///   its provider, provider payment (unique per provider) and regular
///   gift; `gifts_claimed_void` becomes `gifts_claimed_uncounted` (a
///   claimed gift that stopped counting, whatever the reason), and the
///   Direct Debit reference index gives way to the provider pair;
/// - `direct_debit_payments`: the regular gift is optional (one-offs,
///   unmatched payments), the mandate is kept, `gift_voided` goes, and a
///   gift belongs to one payment;
/// - `provider_requests`: what staff asked a provider for (a one-off
///   charge, an Instant Bank Pay link), recorded as them before the
///   call ([`crate::requests`]);
/// - every existing payment gets exactly one gift: one confirmed under D2
///   keeps its gift, which takes the payment's status (a void staff made
///   stays void); one never confirmed gets a new gift with its status, to
///   its regular gift's code; a D2 gift a retry superseded (void) keeps
///   its provider, out of the unique pair.
pub const MIGRATION_UNIFIED: &str = "
CREATE TABLE gifts_widen AS SELECT * FROM gifts;
CREATE TABLE payments_widen AS SELECT * FROM direct_debit_payments;
DROP TABLE direct_debit_payments;
DROP TABLE gifts;
CREATE TABLE gifts (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    received_on TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'direct_debit')),
    reference TEXT,
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed',
        'cancelled', 'refunded', 'charged_back', 'void')),
    entered_by INTEGER,
    entered_at INTEGER NOT NULL,
    client_key TEXT UNIQUE,
    gift_version INTEGER NOT NULL DEFAULT 0,
    status_version INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT,
    claim_id TEXT,
    claim_lock_version INTEGER NOT NULL DEFAULT 0,
    provider TEXT CHECK (provider IN ('gocardless', 'stripe')),
    provider_payment_id TEXT CHECK (provider_payment_id IS NULL OR provider IS NOT NULL),
    regular_gift_id TEXT REFERENCES regular_gifts (id)
) STRICT;
INSERT INTO gifts (seq, id, contact_id, received_on, amount, method, reference, status,
    entered_by, entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version)
SELECT seq, id, contact_id, received_on, amount, method, reference, status, entered_by,
    entered_at, client_key, gift_version, status_version, void_reason, claim_id,
    claim_lock_version
FROM gifts_widen;
DROP TABLE gifts_widen;

-- A D2 payment's gift takes the payment's status (a staff void stays).
UPDATE gifts SET
    provider = 'gocardless',
    provider_payment_id = (SELECT p.payment_id FROM payments_widen p WHERE p.gift_id = gifts.id),
    regular_gift_id = (SELECT p.regular_gift_id FROM payments_widen p WHERE p.gift_id = gifts.id),
    status = (SELECT CASE
                  WHEN gifts.status = 'void' AND p.gift_voided = 0 THEN 'void'
                  WHEN p.status = 'confirmed' THEN 'completed'
                  ELSE p.status END
              FROM payments_widen p WHERE p.gift_id = gifts.id)
WHERE id IN (SELECT gift_id FROM payments_widen WHERE gift_id IS NOT NULL);
-- A gift a retry superseded: void, its provider kept, no payment id.
UPDATE gifts SET
    provider = 'gocardless',
    regular_gift_id = (SELECT p.regular_gift_id FROM payments_widen p
                       WHERE p.payment_id = gifts.reference)
WHERE method = 'direct_debit' AND provider IS NULL;
-- A payment never confirmed: its gift now, with its status.
INSERT INTO gifts (id, contact_id, received_on, amount, method, reference, status, void_reason,
    entered_by, entered_at, provider, provider_payment_id, regular_gift_id)
SELECT lower(hex(randomblob(16))), r.contact_id, p.charge_date, p.amount, 'direct_debit',
    p.payment_id, CASE p.status WHEN 'confirmed' THEN 'completed' ELSE p.status END,
    -- As live processing words it (`gift_reason`).
    CASE p.status
        WHEN 'confirmed' THEN NULL
        ELSE (CASE p.status WHEN 'pending' THEN 'Not collected yet' WHEN 'failed' THEN 'Failed'
                  WHEN 'charged_back' THEN 'Charged back' ELSE 'Cancelled' END)
             || ' (GoCardless)' || coalesce(': ' || p.reason, '') END,
    NULL,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'gocardless', p.payment_id,
    p.regular_gift_id
FROM payments_widen p JOIN regular_gifts r ON r.id = p.regular_gift_id
WHERE p.gift_id IS NULL
ORDER BY p.seq;
INSERT INTO gift_allocations (id, gift_id, position, source_code_id, amount)
SELECT lower(hex(randomblob(16))), g.id, 0, r.source_code_id, g.amount
FROM gifts g JOIN regular_gifts r ON r.id = g.regular_gift_id
WHERE g.provider_payment_id IN (SELECT payment_id FROM payments_widen WHERE gift_id IS NULL);
INSERT INTO gift_allocation_index (allocation_id, gift_id, contact_id, source_code_id,
    detail_id, category_id, received_on, amount, status)
SELECT a.id, g.id, g.contact_id, a.source_code_id, d.id, d.parent_id, g.received_on, a.amount,
    g.status
FROM gift_allocations a
JOIN gifts g ON g.id = a.gift_id
JOIN source_codes v ON v.id = a.source_code_id
JOIN source_codes d ON d.id = v.parent_id
WHERE g.provider_payment_id IN (SELECT payment_id FROM payments_widen WHERE gift_id IS NULL);
UPDATE gift_allocation_index SET status = (SELECT g.status FROM gifts g
                                           WHERE g.id = gift_allocation_index.gift_id)
WHERE gift_id IN (SELECT gift_id FROM payments_widen WHERE gift_id IS NOT NULL);

CREATE INDEX gifts_by_contact ON gifts (contact_id, received_on, seq);
CREATE INDEX gifts_by_entered_by ON gifts (entered_by, seq);
CREATE INDEX gifts_unclaimed ON gifts (received_on)
    WHERE claim_id IS NULL AND status = 'completed';
CREATE INDEX gifts_claimed_uncounted ON gifts (claim_id)
    WHERE claim_id IS NOT NULL AND status <> 'completed';
CREATE UNIQUE INDEX gifts_by_provider_payment ON gifts (provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;
CREATE INDEX gifts_by_regular_gift ON gifts (regular_gift_id, received_on)
    WHERE regular_gift_id IS NOT NULL;

CREATE TABLE direct_debit_payments (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    payment_id TEXT NOT NULL UNIQUE,
    regular_gift_id TEXT REFERENCES regular_gifts (id),
    mandate_id TEXT,
    amount INTEGER NOT NULL CHECK (amount > 0),
    charge_date TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('pending', 'confirmed', 'failed', 'charged_back', 'cancelled')),
    reason TEXT,
    gift_id TEXT UNIQUE REFERENCES gifts (id),
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO direct_debit_payments (seq, id, payment_id, regular_gift_id, mandate_id, amount,
    charge_date, status, reason, gift_id, version)
SELECT p.seq, p.id, p.payment_id, p.regular_gift_id, r.mandate_id, p.amount, p.charge_date,
    p.status, p.reason,
    (SELECT g.id FROM gifts g WHERE g.provider = 'gocardless'
         AND g.provider_payment_id = p.payment_id),
    p.version
FROM payments_widen p LEFT JOIN regular_gifts r ON r.id = p.regular_gift_id;
DROP TABLE payments_widen;
CREATE INDEX direct_debit_payments_by_regular_gift
    ON direct_debit_payments (regular_gift_id, charge_date, seq);
CREATE INDEX direct_debit_payments_unmatched ON direct_debit_payments (seq)
    WHERE gift_id IS NULL;

CREATE TABLE provider_requests (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('one_off', 'instant')),
    provider TEXT NOT NULL CHECK (provider IN ('gocardless', 'stripe')),
    contact_id TEXT NOT NULL REFERENCES contacts (id),
    regular_gift_id TEXT REFERENCES regular_gifts (id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    source_code_id TEXT NOT NULL REFERENCES source_codes (id),
    charge_date TEXT,
    provider_ref TEXT,
    requested_by INTEGER,
    requested_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX provider_requests_by_ref ON provider_requests (provider, provider_ref)
    WHERE provider_ref IS NOT NULL;
";

#[cfg(test)]
mod tests {
    use super::*;

    fn terms() -> SetUp {
        SetUp {
            contact_id: "c".into(),
            amount: 1000,
            frequency: Frequency::Monthly,
            day_of_month: 5,
            month: None,
            source_code_id: "s".into(),
            client_key: None,
        }
    }

    fn fields(p: SetUp) -> Vec<String> {
        match prepare_setup(p) {
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
            fields(SetUp {
                amount: 0,
                ..terms()
            }),
            ["amount"]
        );
        assert_eq!(
            fields(SetUp {
                amount: PENCE_MAX + 1,
                ..terms()
            }),
            ["amount"]
        );
        for day in [0, 29, 31] {
            assert_eq!(
                fields(SetUp {
                    day_of_month: day,
                    ..terms()
                }),
                ["dayOfMonth"]
            );
        }
        assert_eq!(
            fields(SetUp {
                frequency: Frequency::Yearly,
                ..terms()
            }),
            ["month"]
        );
        assert_eq!(
            fields(SetUp {
                frequency: Frequency::Yearly,
                month: Some(13),
                ..terms()
            }),
            ["month"]
        );
        assert!(
            fields(SetUp {
                frequency: Frequency::Yearly,
                month: Some(12),
                ..terms()
            })
            .is_empty()
        );
        assert_eq!(
            fields(SetUp {
                month: Some(1),
                ..terms()
            }),
            ["month"]
        );
        assert_eq!(
            fields(SetUp {
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
