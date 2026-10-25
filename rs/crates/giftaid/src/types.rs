//! Payloads and views of the Gift Aid routes (`convex/giftaid/validators.ts`).
//! Wire names match the Convex side the SPA was written against: the gift
//! a declaration names is `contributionId`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Which gifts a declaration covers (HMRC detailed guidance 3.6.2, 3.9):
/// the gift it was made with, it and every later gift, or those plus the
/// gifts of the 4 years before it (HMRC's model enduring wording, the
/// default: plan g2q5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeclarationScope")]
pub enum Scope {
    ThisGift,
    Future,
    FutureAndPast4y,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::ThisGift => "thisGift",
            Scope::Future => "future",
            Scope::FutureAndPast4y => "futureAndPast4y",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "thisGift" => Scope::ThisGift,
            "future" => Scope::Future,
            _ => Scope::FutureAndPast4y,
        }
    }
}

/// How the declaration was made, recorded honestly even when HMRC's
/// conditions aren't met yet: an oral one only takes effect once the
/// donor is sent a written record (3.10.1), and staff ticking a box is
/// not "on screen by the donor". `staffTickedNoEvidence` is the honest
/// default the gift form's tick records. `onScreenByDonor` is refused
/// until a donor-facing screen exists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeclarationMethod")]
pub enum Method {
    StaffTickedNoEvidence,
    PaperForm,
    OnScreenByDonor,
    Oral,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::StaffTickedNoEvidence => "staffTickedNoEvidence",
            Method::PaperForm => "paperForm",
            Method::OnScreenByDonor => "onScreenByDonor",
            Method::Oral => "oral",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "paperForm" => Method::PaperForm,
            "onScreenByDonor" => Method::OnScreenByDonor,
            "oral" => Method::Oral,
            _ => Method::StaffTickedNoEvidence,
        }
    }
}

/// The `giftaid.declaration` slice: everything a declaration says, as
/// made. Create-only: what was declared (scope, date, method, wording,
/// gift) is never edited (the chain is add-only). `firstName` … `postcode`
/// are a snapshot of the name and home address it was made under (3.6.2:
/// house number or name and postcode suffice): the audit record, kept
/// through erasure for HMRC's 6 years (3.30). The create sets them; after
/// that they belong to `giftaid.declarationDetails` ([`DetailsPayload`]),
/// so a declaration saved before staff had the address can be completed,
/// and a typo fixed, each change a revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeclarationPayload")]
pub struct DeclarationPayload {
    pub contact_id: String,
    pub scope: Scope,
    /// The gift it was made with, which it always covers; required for
    /// `thisGift`. Absent for a declaration made on its own.
    #[serde(
        default,
        rename = "contributionId",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional, rename = "contributionId")]
    pub gift_id: Option<String>,
    /// ISO date.
    pub made_on: String,
    pub method: Method,
    /// Which wording the donor agreed to; [`crate::HMRC_MODEL_WORDING_VERSION`] today.
    pub wording_version: String,
    pub first_name: String,
    pub last_name: String,
    pub address_line1: String,
    pub postcode: String,
}

impl DeclarationPayload {
    /// The snapshot, as `giftaid.declarationDetails` holds it.
    pub fn details(&self) -> DetailsPayload {
        DetailsPayload {
            first_name: self.first_name.clone(),
            last_name: self.last_name.clone(),
            address_line1: self.address_line1.clone(),
            postcode: self.postcode.clone(),
        }
    }
}

/// The `giftaid.declarationDetails` slice: the declaration's snapshot of
/// the donor's name and home address, completed or corrected after it
/// was saved. Not the contact's details: changing the contact never
/// changes it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeclarationDetails")]
pub struct DetailsPayload {
    pub first_name: String,
    pub last_name: String,
    pub address_line1: String,
    pub postcode: String,
}

/// The `giftaid.cancellation` slice. No `cancelledFrom` = not cancelled.
/// A cancellation covers gifts on or after its date (3.8.2).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "CancellationPayload")]
pub struct CancellationPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cancelled_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// The `giftaid.void` slice: the declaration was recorded in error (wrong
/// contact, never made). Who and when are the command's actor and time.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename = "VoidDeclaration")]
pub struct VoidPayload {
    pub reason: String,
}

/// A tier-2 warning on a declaration (ADR 0015): storable, not yet enough
/// for HMRC.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "DeclarationWarning")]
pub struct Warning {
    /// The field the warning is about; empty = the whole declaration.
    pub anchor: String,
    pub label: String,
    pub message: String,
}

/// One declaration as stored, for the contact page's Gift Aid panel.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Declaration {
    pub id: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: DeclarationPayload,
    pub cancelled_from: Option<String>,
    pub cancellation_note: Option<String>,
    pub void_reason: Option<String>,
    /// ms since the epoch; present = voided.
    #[ts(type = "number | null")]
    pub voided_at: Option<i64>,
    #[ts(type = "number | null")]
    pub voided_by: Option<i64>,
    #[ts(type = "number | null")]
    pub entered_by: Option<i64>,
    /// ms since the epoch.
    #[ts(type = "number")]
    pub entered_at: i64,
    #[ts(type = "number")]
    pub declaration_version: i64,
    #[ts(type = "number")]
    pub cancellation_version: i64,
    #[ts(type = "number")]
    pub void_version: i64,
    #[ts(type = "number")]
    pub details_version: i64,
}

/// One row of the Gift Aid panel: the declaration and its warnings (none
/// on a voided one: it never applied, so nothing to fix).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeclarationRow {
    #[serde(flatten)]
    #[ts(flatten)]
    pub declaration: Declaration,
    pub warnings: Vec<Warning>,
}

/// `GET contacts/{id}/giftaid?today`: newest made first, and the one
/// current on `today`, if any.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Declarations {
    pub declarations: Vec<DeclarationRow>,
    pub current_id: Option<String>,
}

/// What other modules learn about a declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DeclarationSummary {
    pub id: String,
    pub scope: Scope,
    pub method: Method,
    pub made_on: String,
    pub cancelled_from: Option<String>,
}

/// `POST contacts/{id}/giftaid/cancel`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RecordCancellation {
    pub cancelled_from: String,
    #[serde(default)]
    #[ts(optional)]
    pub note: Option<String>,
}

/// What a cancellation changed: every declaration it cancelled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Cancelled {
    pub cancelled: Vec<String>,
}

/// `POST giftaid/{id}/details {expected, …details}`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveDeclarationDetails {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub details: DetailsPayload,
}

/// One snapshot field a details change changed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, rename = "DeclarationDetailsChange")]
pub struct DetailsChange {
    /// `firstName`, `lastName`, `addressLine1` or `postcode`.
    pub field: String,
    pub from: String,
    pub to: String,
}

/// One saved change to a declaration's snapshot: who, when, old → new.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeclarationDetailsEdit")]
pub struct DetailsEdit {
    #[ts(type = "number")]
    pub revision_id: i64,
    /// ms since the epoch.
    #[ts(type = "number")]
    pub at: i64,
    #[ts(type = "number | null")]
    pub actor: Option<i64>,
    pub source: contracts::Source,
    pub changes: Vec<DetailsChange>,
}

/// `GET giftaid/{id}/history`: the snapshot's changes since the
/// declaration was made, newest first; a save that changed nothing isn't
/// listed. `more`: older changes exist beyond the newest
/// DETAILS_HISTORY_LIMIT.
#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "DeclarationDetailsHistory")]
pub struct DetailsHistory {
    pub edits: Vec<DetailsEdit>,
    pub more: bool,
}
