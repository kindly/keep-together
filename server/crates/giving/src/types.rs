//! Payloads and views of the gift routes (`convex/giving/validators.ts`,
//! `types.ts`). Amounts are INTEGER pence end to end (rule 7): JSON
//! numbers, never pounds, never floats. Wire names match the Convex side
//! the SPA was written against.

use serde::{Deserialize, Serialize};
use sources::CodeDescription;
use ts_rs::TS;

/// How a gift was paid: by hand, on a card reader we don't drive (yet), or
/// by Direct Debit (a GoCardless payment GoCardless confirmed: recorded by
/// the system, never by hand).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "GiftMethod")]
pub enum Method {
    Cash,
    Card,
    DirectDebit,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Cash => "cash",
            Method::Card => "card",
            Method::DirectDebit => "direct_debit",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "card" => Method::Card,
            "direct_debit" => Method::DirectDebit,
            _ => Method::Cash,
        }
    }
}

/// Where a gift stands. `void` = entered by mistake: kept, counts for
/// nothing. Room for `pending` / `failed` / `refunded` (ADR 0008).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, rename = "GiftStatus")]
pub enum Status {
    Completed,
    Void,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Completed => "completed",
            Status::Void => "void",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "void" {
            Status::Void
        } else {
            Status::Completed
        }
    }
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
    /// payment id (unique: one gift per payment).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reference: Option<String>,
    pub allocations: Vec<AllocationRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client_key: Option<String>,
}

/// The `giving.status` slice (v2: `reason`). Voiding a gift that is in a
/// Gift Aid claim needs a reason (it goes into the next claim as an
/// adjustment); any other void may give one. Un-voiding clears it.
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
    /// Why it was voided, when a reason was given.
    pub void_reason: Option<String>,
    /// The Gift Aid claim it is in: amount, date and donor locked.
    pub claim_id: Option<String>,
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
    /// `void` gifts stay in the list, marked.
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
