//! Payloads and views of the gift routes (`convex/giving/validators.ts`,
//! `types.ts`). Amounts are INTEGER pence end to end (rule 7): JSON
//! numbers, never pounds, never floats. Wire names match the Convex side
//! the SPA was written against.

use serde::{Deserialize, Serialize};
use sources::CodeDescription;
use ts_rs::TS;

/// How a gift was paid: by hand, on a card reader we don't drive (yet), by
/// Direct Debit (a GoCardless payment: recorded by the system from
/// GoCardless's events, never by hand), by bank transfer (a one-off or a
/// standing order: entered by hand, or made from a statement line), or by
/// cheque (pending until it clears, ADR 0027).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "GiftMethod")]
pub enum Method {
    Cash,
    Card,
    DirectDebit,
    BankTransfer,
    Cheque,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Cash => "cash",
            Method::Card => "card",
            Method::DirectDebit => "direct_debit",
            Method::BankTransfer => "bank_transfer",
            Method::Cheque => "cheque",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "card" => Method::Card,
            "direct_debit" => Method::DirectDebit,
            "bank_transfer" => Method::BankTransfer,
            "cheque" => Method::Cheque,
            _ => Method::Cash,
        }
    }

    /// Paid in at the bank on a paying-in slip: what a batch holds.
    pub fn is_paid_in(self) -> bool {
        matches!(self, Method::Cash | Method::Cheque)
    }
}

/// Where a gift stands (ADR 0025: a gift is every payment attempt).
/// Only `completed` is money received ([`crate::RECEIVED`]): it alone
/// counts as income and can be claimed for Gift Aid. `void` is the
/// staff's word (entered by mistake: kept, counts for nothing); the rest
/// are a provider's, following its payment: `pending` (not collected
/// yet), `failed`, `cancelled` (never collected), `refunded`,
/// `chargedBack` (returned under the Direct Debit Guarantee).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "GiftStatus")]
pub enum Status {
    Pending,
    Completed,
    Failed,
    Cancelled,
    Refunded,
    ChargedBack,
    Void,
}

impl Status {
    pub const ALL: [Status; 7] = [
        Status::Pending,
        Status::Completed,
        Status::Failed,
        Status::Cancelled,
        Status::Refunded,
        Status::ChargedBack,
        Status::Void,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Cancelled => "cancelled",
            Status::Refunded => "refunded",
            Status::ChargedBack => "charged_back",
            Status::Void => "void",
        }
    }

    /// The stored word; anything else (never written: a CHECK holds the
    /// column) reads as void, which counts for nothing.
    pub fn parse(s: &str) -> Self {
        Status::ALL
            .into_iter()
            .find(|v| v.as_str() == s)
            .unwrap_or(Status::Void)
    }

    /// Money received: counts as income, may be claimed.
    pub fn is_received(self) -> bool {
        self == Status::Completed
    }
}

/// The payment provider a gift came from. None = entered by hand.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "GiftProvider")]
pub enum Provider {
    Gocardless,
    Stripe,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Gocardless => "gocardless",
            Provider::Stripe => "stripe",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "gocardless" => Some(Provider::Gocardless),
            "stripe" => Some(Provider::Stripe),
            _ => None,
        }
    }
}

/// A provider gift's origin: create-only, the system's (a payment the
/// provider reported). `paymentId` is unique per provider: one gift per
/// payment, for its whole life.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftOrigin")]
pub struct ProviderRef {
    pub provider: Provider,
    pub payment_id: String,
    /// The regular gift it was collected for; none for a one-off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub regular_gift_id: Option<String>,
    /// The charge date the provider first gave the payment (ISO; kept
    /// through retries): its period. A regular gift's payments only
    /// (ADR 0026).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scheduled_on: Option<String>,
}

/// A share of the gift under one source code (a version), in pence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AllocationRow {
    /// Omitted = a new row; the contract mints it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    pub source_code_id: String,
    #[ts(type = "number")]
    pub amount: i64,
}

/// The `giving.gift` slice: donor, date, amount, method, card reference
/// and the split across source codes. `contactId` is set on create and
/// never changes (g3q2): a wrong donor is void and record again.
/// `clientKey` is create-only (a form's double submit is `duplicate`);
/// no save carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftPayload {
    pub contact_id: String,
    /// ISO date.
    pub received_on: String,
    /// Pence, over 0.
    #[ts(type = "number")]
    pub amount: i64,
    pub method: Method,
    /// Card: the reader's receipt id. Direct Debit: the GoCardless
    /// payment id (unique: one gift per payment). Bank transfer: the
    /// donor's reference. Cheque: its number. Cash has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference: Option<String>,
    pub allocations: Vec<AllocationRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_key: Option<String>,
    /// The provider payment it is (create-only, the system's; v2). A save
    /// may leave it out: it never changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub origin: Option<ProviderRef>,
    /// The statement line it was made from (v4, ADR 0027): create-only.
    /// Its amount, date, method and reference are the line's, locked as a
    /// provider gift's are; voiding it frees the line. A save may leave
    /// it out: it never changes. (A gift entered by hand and matched to a
    /// line later is linked by `giving.line` instead.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from_line: Option<String>,
    /// The paying-in batch it was banked in (v4): cash or a cheque, set
    /// when it is recorded, while the batch is open. A save may leave it
    /// out: it never changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paying_in_batch_id: Option<String>,
}

/// The `giving.status` slice (v2: `reason`). Staff set `completed` or
/// `void`, and on a cheque `pending` and `failed` (bounced) too; the
/// provider's statuses are the system's. Voiding a gift that
/// is in a Gift Aid claim needs a reason (it goes into the next claim as
/// an adjustment); any other void may give one. A provider status that
/// isn't money received carries the provider's reason. `completed`
/// clears it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename = "GiftStatusPayload")]
pub struct StatusPayload {
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// The `giving.claimLock` slice: the Gift Aid claim the gift is in, or
/// none. Set when a claim takes the gift, cleared when that claim is
/// deleted (a draft) or rejected. While set, the gift's amount, date and
/// donor can't change, voiding it needs a reason, and a void can't be
/// undone. Never restored: only a claim moves it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftClaimLock")]
pub struct ClaimLockPayload {
    pub claim_id: Option<String>,
}

/// An allocation with its code as it reads now (`code` null: not a
/// version of this organisation), whether that code is still assignable
/// (`isActive`: false once it or a parent is archived) and its dates, for
/// the gift page's picker.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AllocationView {
    pub key: String,
    pub source_code_id: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub code: Option<String>,
    pub is_active: bool,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

impl AllocationView {
    pub(crate) fn new(
        key: String,
        source_code_id: String,
        amount: i64,
        code: Option<&CodeDescription>,
    ) -> Self {
        Self {
            key,
            source_code_id,
            amount,
            code: code.map(|c| c.code.clone()),
            is_active: code.is_some_and(|c| c.is_active),
            start_date: code.and_then(|c| c.start_date.clone()),
            end_date: code.and_then(|c| c.end_date.clone()),
        }
    }
}

/// One gift as stored, its allocations described.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftRow {
    pub id: String,
    pub contact_id: String,
    pub received_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub method: Method,
    pub reference: Option<String>,
    pub allocations: Vec<AllocationView>,
    pub status: Status,
    /// Why it doesn't count (voided, failed, charged back…), when a
    /// reason was given.
    pub void_reason: Option<String>,
    /// The provider it came from (none: entered by hand), its payment id
    /// and the regular gift it was collected for (none: a one-off).
    pub provider: Option<Provider>,
    pub provider_payment_id: Option<String>,
    pub regular_gift_id: Option<String>,
    /// The Gift Aid claim it is in: amount, date and donor locked.
    pub claim_id: Option<String>,
    /// The statement line it is on (ADR 0027), and whether it was made
    /// from that line (amount, date and reference are the line's; voiding
    /// it frees the line) or entered by hand and matched to it.
    pub bank_line_id: Option<String>,
    /// (Not `fromLine`: that is the payload's line id, and a page may
    /// post a row back as its save.)
    pub made_from_line: bool,
    /// A bank transfer entered by hand, received, that no statement line
    /// is matched to yet (derived, never stored).
    pub not_on_a_statement: bool,
    /// The paying-in batch it was banked in.
    pub paying_in_batch_id: Option<String>,
    /// The platform user who entered it; null = system.
    #[ts(type = "number | null")]
    pub entered_by: Option<i64>,
    /// When it was entered (ms since the epoch).
    #[ts(type = "number")]
    pub entered_at: i64,
    #[ts(type = "number")]
    pub gift_version: i64,
    #[ts(type = "number")]
    pub status_version: i64,
    #[ts(type = "number")]
    pub line_version: i64,
}

/// The gift's donor as the gift page shows it.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftDonor {
    pub id: String,
    pub display_name: String,
    pub kind: contacts::types::Kind,
}

/// `GET gifts/{id}`: the gift, its donor and each allocation's code.
/// Warnings come from `giftWarnings(gift, today)` in the SPA (the
/// caller's today).
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub gift: GiftRow,
    pub contact: Option<GiftDonor>,
}

/// `GET contacts/{id}/gifts?cursor&limit`: newest date first.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftPage {
    pub rows: Vec<GiftRow>,
    /// Pass as `cursor` for the next page; null when `isDone`.
    pub next_cursor: Option<String>,
    pub is_done: bool,
}

/// One row of `GET gifts/recent`: the caller's last gifts, newest entered
/// first.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecentGift {
    pub id: String,
    /// When it was entered (ms since the epoch); the list's order.
    #[ts(type = "number")]
    pub entered_at: i64,
    pub contact_id: String,
    /// The contact's display name as it reads now.
    pub contact_name: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub received_on: String,
    pub method: Method,
    /// Every status stays in the list, marked.
    pub status: Status,
}

/// `POST gifts/{id}/save`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveGift {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: GiftPayload,
}

/// `POST gifts/{id}/status`: void or un-void. Re-sending the current
/// status is a no-op.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetGiftStatus {
    #[ts(type = "number")]
    pub expected: i64,
    pub status: Status,
    /// Needed to void a gift in a Gift Aid claim.
    #[serde(default)]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// A gift write's answer: the slice's new counter and the gift as it
/// now is, read in the same transaction (gifts are never optimistic).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GiftSaved {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
    pub view: GiftView,
}

/// The `giving.line` slice: the statement line a gift entered by hand is
/// matched to, or none (ADR 0027). Only a bank transfer; a gift made from
/// a line has it for good (`fromLine`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftLine")]
pub struct LinePayload {
    pub line_id: Option<String>,
}

/// Where a paying-in batch stands: `open` (gifts going in) or `closed`
/// (its slip's total and date written). A closed batch is matched once it
/// names its statement line (`giving.batchLine`): then its cheques have
/// cleared.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum BatchStatus {
    Open,
    Closed,
}

impl BatchStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            BatchStatus::Open => "open",
            BatchStatus::Closed => "closed",
        }
    }

    /// The stored word (a CHECK holds the column).
    pub fn parse(s: &str) -> Self {
        match s {
            "closed" => BatchStatus::Closed,
            _ => BatchStatus::Open,
        }
    }
}

/// The `giving.payingInBatch` contract (counter `version`): cash and
/// cheques paid in together on one slip (ADR 0027 decision 6). Opened on
/// an account, closed with the slip's total (pence) and the date it was
/// paid in. Its statement line is `giving.batchLine`'s, never this
/// payload's. The account never changes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PayingInBatchPayload {
    pub account_id: String,
    /// The paying-in slip's number; may be blank.
    #[serde(default)]
    pub slip_number: String,
    /// ISO date it was paid in; needed to close.
    #[serde(default)]
    pub banked_on: Option<String>,
    /// The slip's total in pence, over 0; needed to close.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub total: Option<i64>,
    pub status: BatchStatus,
}

/// The `giving.batchLine` slice (counter `line_version`): the statement
/// line a closed batch is matched to, or none. Moved only by matching and
/// unmatching, which clear and re-pend the batch's cheques with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BatchLinePayload {
    pub line_id: Option<String>,
}

/// A paying-in batch as stored, with what its gifts add up to. A
/// difference against the slip or its line is shown, never forced.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PayingInBatchRow {
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub batch: PayingInBatchPayload,
    /// The statement line it is matched to: matched exactly when set.
    pub line_id: Option<String>,
    #[ts(type = "number | null")]
    pub opened_by: Option<i64>,
    #[ts(type = "number")]
    pub opened_at: i64,
    #[ts(type = "number | null")]
    pub closed_by: Option<i64>,
    #[ts(type = "number | null")]
    pub closed_at: Option<i64>,
    /// The gifts in it that aren't void (pending cheques included: they
    /// were paid in), and their sum in pence.
    #[ts(type = "number")]
    pub gift_count: i64,
    #[ts(type = "number")]
    pub gifts_total: i64,
    #[ts(type = "number")]
    pub version: i64,
    #[ts(type = "number")]
    pub line_version: i64,
}
