//! Payloads and views of the Gift Aid claim routes. Money is INTEGER
//! pence (rule 7), dates ISO `YYYY-MM-DD`, times ms since the epoch.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::types::Warning;

/// Where a claim stands: `draft → ready → submitted → paid`, or
/// `rejected` (from ready or submitted). A draft can be deleted: it is
/// kept as `deleted` (its revisions name it) and lets its gifts go.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimStatus")]
pub enum ClaimStatus {
    Draft,
    Ready,
    Submitted,
    Paid,
    Rejected,
    Deleted,
}

impl ClaimStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ClaimStatus::Draft => "draft",
            ClaimStatus::Ready => "ready",
            ClaimStatus::Submitted => "submitted",
            ClaimStatus::Paid => "paid",
            ClaimStatus::Rejected => "rejected",
            ClaimStatus::Deleted => "deleted",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "ready" => ClaimStatus::Ready,
            "submitted" => ClaimStatus::Submitted,
            "paid" => ClaimStatus::Paid,
            "rejected" => ClaimStatus::Rejected,
            "deleted" => ClaimStatus::Deleted,
            _ => ClaimStatus::Draft,
        }
    }

    /// Holds its gifts: everything but rejected and deleted.
    pub fn is_live(self) -> bool {
        !matches!(self, ClaimStatus::Rejected | ClaimStatus::Deleted)
    }
}

/// One donation in a claim: the gift, the declaration that covers it,
/// and the donor as sent to HMRC. A snapshot: it stays as sent if the
/// contact changes or is anonymised later (rule 3: it is a tax record).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimLine")]
pub struct ClaimLine {
    /// The line's id; the create mints it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    pub gift_id: String,
    pub declaration_id: String,
    pub contact_id: String,
    pub title: String,
    pub first_name: String,
    pub last_name: String,
    /// House name or number; a non-UK donor's address.
    pub house: String,
    /// Empty for a donor outside the UK (`overseas`).
    pub postcode: String,
    pub overseas: bool,
    pub received_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    /// floor(amount / 4).
    #[ts(type = "number")]
    pub reclaim: i64,
}

/// Tax given back to HMRC: a gift an earlier claim (submitted or paid)
/// claimed, voided since. HMRC's "previously over-claimed amount": the
/// tax, not the donation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimAdjustment")]
pub struct ClaimAdjustment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    pub gift_id: String,
    /// The claim that claimed it.
    pub original_claim_id: String,
    #[ts(type = "number")]
    pub amount: i64,
    /// Why the gift was voided.
    pub reason: String,
}

/// The `giftaid.claim` slice: the claim as made, frozen. Create-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimPayload")]
pub struct ClaimPayload {
    /// The end date asked for: gifts received on or before it.
    pub period_end: String,
    pub lines: Vec<ClaimLine>,
    pub adjustments: Vec<ClaimAdjustment>,
}

/// The `giftaid.claimStatus` slice: one step of the claim's life. Each
/// status names what it needs: `submitted` a date (and HMRC's reference,
/// if given), `paid` the amount received and its date, `rejected` a
/// reason. Earlier steps' facts are kept.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimStatusPayload")]
pub struct ClaimStatusPayload {
    pub status: ClaimStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub submitted_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub hmrc_reference: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paid_on: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub paid_amount: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// A claim's money: what it claims, what it pays back, and the net.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimTotals")]
pub struct ClaimTotals {
    #[ts(type = "number")]
    pub lines: i64,
    /// The donations claimed on.
    #[ts(type = "number")]
    pub donations: i64,
    /// Sum of the lines' reclaims.
    #[ts(type = "number")]
    pub reclaim: i64,
    /// Sum of the adjustments.
    #[ts(type = "number")]
    pub adjustment: i64,
    /// `reclaim − adjustment`: what HMRC should pay (negative: owed to it).
    #[ts(type = "number")]
    pub net: i64,
}

/// A gift left out of a claim, and every reason, worded for staff.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidExcludedGift")]
pub struct ExcludedGift {
    pub gift_id: String,
    pub contact_id: String,
    /// The contact's display name now.
    pub contact_name: String,
    pub received_on: String,
    #[ts(type = "number")]
    pub amount: i64,
    pub reasons: Vec<String>,
}

/// `GET giftaid/claims/preview?periodEnd`: what "Create claim" would
/// claim now, and what it leaves out and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimPreview")]
pub struct ClaimPreview {
    pub period_end: String,
    /// The UK date the server judged on.
    pub today: String,
    /// Gifts before this are over the 4-year limit.
    pub claimable_from: String,
    /// Oldest first.
    pub lines: Vec<ClaimLine>,
    pub adjustments: Vec<ClaimAdjustment>,
    /// Oldest first.
    pub excluded: Vec<ExcludedGift>,
    pub totals: ClaimTotals,
    /// How many claims "Create" makes: one per 1,000 lines (HMRC's
    /// schedule limit), oldest gifts first; the adjustments go on the
    /// first.
    #[ts(type = "number")]
    pub claims: i64,
}

/// One claim in the Gift Aid page's list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimSummary")]
pub struct ClaimSummary {
    pub id: String,
    /// 1, 2, 3 … per organisation.
    #[ts(type = "number")]
    pub number: i64,
    pub status: ClaimStatus,
    pub period_end: String,
    /// The earliest donation date in it.
    pub earliest_date: String,
    pub totals: ClaimTotals,
    pub submitted_on: Option<String>,
    pub hmrc_reference: Option<String>,
    pub paid_on: Option<String>,
    #[ts(type = "number | null")]
    pub paid_amount: Option<i64>,
    pub rejected_reason: Option<String>,
    #[ts(type = "number | null")]
    pub created_by: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub status_version: i64,
}

/// `GET giftaid/claims/{id}`: the claim, its lines and adjustments,
/// and what stops its next step.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimView")]
pub struct ClaimView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub claim: ClaimSummary,
    pub lines: Vec<ClaimLine>,
    pub adjustments: Vec<ClaimAdjustment>,
    /// Gifts of this claim voided since it was made: while it is a draft
    /// or ready, they stop it being sent (delete the draft or reject it
    /// and claim again).
    pub voided_gifts: Vec<String>,
}

/// `GET giftaid/claims`: newest first, deleted ones left out.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaims")]
pub struct Claims {
    pub claims: Vec<ClaimSummary>,
}

/// `POST giftaid/claims {periodEnd, expectedLines?, expectedDonations?}`:
/// claim every eligible gift received on or before `periodEnd`, in as
/// many claims of at most 1,000 lines as it takes. The
/// expected counts are the preview's: if what is eligible changed since,
/// the create is refused (`preview_changed`) rather than claiming
/// something else.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "CreateGiftAidClaim")]
pub struct CreateClaim {
    pub period_end: String,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected_lines: Option<i64>,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub expected_donations: Option<i64>,
}

/// `POST giftaid/claims/{id}/status {expected, …}`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "SetGiftAidClaimStatus")]
pub struct SetClaimStatus {
    #[ts(type = "number")]
    pub expected: i64,
    #[serde(flatten)]
    #[ts(flatten)]
    pub payload: ClaimStatusPayload,
}

/// `POST giftaid/claims`: the claims made, numbered in turn, oldest
/// gifts first; read in the same transaction.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimsCreated")]
pub struct ClaimsCreated {
    pub claims: Vec<ClaimView>,
}

/// A claim write's answer: the claim as it now is, read in the same
/// transaction (never optimistic: rule 4).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "GiftAidClaimSaved")]
pub struct ClaimSaved {
    pub id: String,
    /// The claim's `statusVersion` now.
    #[ts(type = "number")]
    pub counter: i64,
    /// `null` once the draft is deleted.
    pub view: Option<ClaimView>,
}

/// The charity's regulator, as HMRC's claim names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "CharityRegulator")]
pub enum Regulator {
    /// Charity Commission for England and Wales.
    Ccew,
    /// Charity Commission for Northern Ireland.
    Ccni,
    /// Office of the Scottish Charity Regulator.
    Oscr,
    /// Not registered with a regulator (an excepted or exempt charity, a
    /// small one under the threshold, a CASC).
    None,
}

impl Regulator {
    pub fn as_str(self) -> &'static str {
        match self {
            Regulator::Ccew => "ccew",
            Regulator::Ccni => "ccni",
            Regulator::Oscr => "oscr",
            Regulator::None => "none",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "ccew" => Some(Regulator::Ccew),
            "ccni" => Some(Regulator::Ccni),
            "oscr" => Some(Regulator::Oscr),
            "none" => Some(Regulator::None),
            _ => None,
        }
    }
}

/// The `giftaid.hmrcDetails` slice: what the claim tells HMRC about the
/// charity and who signs it. The admin settings page sets it. Each field
/// is storable as typed; what HMRC would refuse is a warning
/// ([`HmrcDetailsView::warnings`]) until the XML needs it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HmrcDetails {
    /// HMRC's charity reference ("AA12345").
    pub hmrc_reference: String,
    pub regulator: Option<Regulator>,
    pub regulator_number: String,
    /// The authorised official.
    pub official_title: String,
    pub official_first_name: String,
    pub official_last_name: String,
    pub official_postcode: String,
    pub official_phone: String,
}

/// `GET giftaid/hmrc-details`
#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct HmrcDetailsView {
    #[serde(flatten)]
    #[ts(flatten)]
    pub details: HmrcDetails,
    /// The counter a save sends as `expected`; `null` before the first.
    #[ts(type = "number | null")]
    pub version: Option<i64>,
    pub warnings: Vec<Warning>,
}

/// `POST giftaid/hmrc-details {expected?, …details}`
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveHmrcDetails {
    #[serde(default)]
    #[ts(optional, type = "number | null")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub details: HmrcDetails,
}
