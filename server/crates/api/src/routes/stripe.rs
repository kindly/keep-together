//! `/api/t/{slug}/stripe…` (`factory/plans/stripe.sv`, S1;
//! `api::stripe` holds the provider). With `KEEP_STRIPE=off` every route
//! but `GET stripe` is 404.
//!
//! Connecting and disconnecting are an admin's, within the step-up hour;
//! every member reads the status. Those touch nothing in the
//! organisation's file: which Stripe account is whose lives in
//! `platform.db`.
//!
//! S3: "Card payments to match". Any member lists the payments that
//! succeeded and couldn't be tied to a contact; staff say whose one is,
//! which makes its gift (and the donor's declaration, if they ticked
//! Gift Aid) in one transaction ([`crate::stripe::payments`]).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Executed, Source};
use giving::stripe::{DonationPage, DonationPagePayload, UnmatchedCardPayment};
use giving::types::GiftView;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::stripe::{StripeConnectStart, StripeStatus};
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/stripe", get(status))
        .route("/stripe/connect", post(connect))
        .route("/stripe/disconnect", post(disconnect))
        .route("/stripe/unmatched", get(unmatched))
        .route("/stripe/unmatched/{id}/match", post(match_payment))
        .route("/stripe/unmatched/{id}/dismiss", post(dismiss))
        .route("/stripe/unmatched/{id}/put-back", post(put_back))
        .route("/stripe/dismissed", get(dismissed))
        .route("/stripe/payments/{id}/name-checked", post(name_checked))
        .route("/stripe/page", get(page).post(save_page))
}

/// `GET stripe`: on or off here, this organisation's Stripe account and
/// how far its onboarding has got. Any member.
async fn status(Extension(t): Extension<Tenant>) -> Result<Json<StripeStatus>, ApiError> {
    t.stripe_status().await.map(Json)
}

/// `POST stripe/connect` → `{url, status}`: the organisation's Stripe
/// account is made if it has none, and `url` is Stripe's form for it
/// (send the browser there; it comes back to the group's settings with
/// `?stripe=return` or `?stripe=refresh`). `url` is null once Stripe
/// takes payments for the account. Stripe not answering: `503
/// stripe_unavailable`.
async fn connect(Extension(t): Extension<Tenant>) -> Result<Json<StripeConnectStart>, ApiError> {
    t.stripe_connect().await.map(Json)
}

/// `POST stripe/disconnect` → the status, now disconnected. The Stripe
/// account stays the organisation's.
async fn disconnect(Extension(t): Extension<Tenant>) -> Result<Json<StripeStatus>, ApiError> {
    t.stripe_disconnect().await.map(Json)
}

/// `GET stripe/unmatched` → `UnmatchedCardPayment[]`: card payments that
/// succeeded and nobody could be matched to (no gift yet), newest first,
/// at most 500, each with what its donor typed and the live contacts
/// that have their email address. Any member.
async fn unmatched(
    Extension(t): Extension<Tenant>,
) -> Result<Json<Vec<UnmatchedCardPayment>>, ApiError> {
    t.stripe()?;
    t.read(|r| Ok(giving::stripe::unmatched_view(r)?))
        .await
        .map(Json)
}

/// `POST stripe/unmatched/{id}/match`: whose it is.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MatchCardPayment {
    /// The payment's `matchVersion` as listed.
    #[ts(type = "number")]
    pub expected: i64,
    pub contact_id: String,
    /// The gift's source code: left out, the code the donor's page had.
    /// Needed for a payment with no submission (`sourceCodeId: null` in
    /// the list).
    #[serde(default)]
    #[ts(optional)]
    pub source_code_id: Option<String>,
}

/// A matched card payment's gift, read in the same transaction.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MatchedCardPayment {
    pub gift_id: String,
    pub gift: GiftView,
}

/// `POST stripe/unmatched/{id}/match {expected, contactId,
/// sourceCodeId?}` → `MatchedCardPayment`: the payment becomes the
/// contact's gift, with Stripe's amount, date and status; the donor's
/// Gift Aid declaration is made if they ticked it. Staff. Already
/// matched: `422 rejected already_matched`; `409 stale`.
async fn match_payment(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<MatchCardPayment>,
) -> Result<Json<MatchedCardPayment>, ApiError> {
    t.stripe()?;
    let slug = t.slug.clone();
    let out = t
        .write(move |ctx| {
            let gift_id = crate::stripe::payments::match_by_staff(
                ctx,
                &id,
                req.expected,
                &req.contact_id,
                req.source_code_id.as_deref(),
                &slug,
            )?;
            let gift = giving::get(ctx.tx.read(), &gift_id)?.ok_or(ApiError::NotFound)?;
            Ok(MatchedCardPayment { gift_id, gift })
        })
        .await?;
    Ok(Json(out))
}

/// `POST stripe/unmatched/{id}/dismiss`: not a donation, and why.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DismissCardPayment {
    /// The payment's `matchVersion` as listed.
    #[ts(type = "number")]
    pub expected: i64,
    /// Why it isn't a donation ("Stall hire"); needed.
    pub reason: String,
}

/// `POST stripe/unmatched/{id}/put-back`, `POST
/// stripe/payments/{id}/name-checked`: the payment's `matchVersion` as
/// read.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CardPaymentExpected {
    #[ts(type = "number")]
    pub expected: i64,
}

/// `POST stripe/unmatched/{id}/dismiss {expected, reason}` → `Executed`:
/// a payment taken some other way on the group's Stripe account (queued
/// as `no_submission`) is set aside as not a donation. It leaves the
/// queue for `stripe/dismissed` and makes no gift; nothing is deleted.
/// Staff. No reason: `422 invalid`; a payment that came through the
/// donation page: `422 rejected not_outside`; `409 stale`.
async fn dismiss(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DismissCardPayment>,
) -> Result<Json<Executed>, ApiError> {
    t.stripe()?;
    if req.reason.trim().is_empty() {
        return Err(
            contracts::ContractError::invalid("reason", "Say why it isn’t a donation").into(),
        );
    }
    t.write(move |ctx| {
        Ok(giving::stripe::set_dismissed(
            ctx,
            &id,
            Some(&req.reason),
            req.expected,
        )?)
    })
    .await
    .map(Json)
}

/// `POST stripe/unmatched/{id}/put-back {expected}` → `Executed`: a
/// payment set aside goes back in the queue. Staff. Not set aside: `422
/// rejected not_dismissed`; `409 stale`.
async fn put_back(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<CardPaymentExpected>,
) -> Result<Json<Executed>, ApiError> {
    t.stripe()?;
    t.write(move |ctx| Ok(giving::stripe::set_dismissed(ctx, &id, None, req.expected)?))
        .await
        .map(Json)
}

/// `GET stripe/dismissed` → `UnmatchedCardPayment[]`: the payments staff
/// set aside as not donations, newest first, at most 500, each with
/// `dismissed` (why) and `dismissedAt`. Any member.
async fn dismissed(
    Extension(t): Extension<Tenant>,
) -> Result<Json<Vec<UnmatchedCardPayment>>, ApiError> {
    t.stripe()?;
    t.read(|r| Ok(giving::stripe::dismissed_view(r)?))
        .await
        .map(Json)
}

/// `POST stripe/payments/{id}/name-checked {expected}` → the gift
/// (`GiftView`, its `card.firstNameTyped` now null): staff looked at
/// "first name differs" and it is the right person. Staff. `422 rejected
/// not_flagged`; `409 stale`.
async fn name_checked(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<CardPaymentExpected>,
) -> Result<Json<GiftView>, ApiError> {
    t.stripe()?;
    t.write(move |ctx| {
        giving::stripe::name_checked(ctx, &id, req.expected)?;
        let gift = giving::stripe::payment(ctx.tx.read(), &id)?
            .and_then(|p| p.matched.gift_id)
            .ok_or(ApiError::NotFound)?;
        giving::get(ctx.tx.read(), &gift)?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

/// `GET stripe/page` → `DonationPage`: the donation page's three
/// amounts, minimum and maximum (pence), its source code, the counter a
/// save sends and whether it is taking donations. Any member.
async fn page(Extension(t): Extension<Tenant>) -> Result<Json<DonationPage>, ApiError> {
    t.stripe()?;
    t.read(|r| Ok(giving::stripe::page(r)?)).await.map(Json)
}

/// `POST stripe/page`: the page's settings.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SaveDonationPage {
    /// `version` as last read; absent (or null) if the page was never
    /// saved.
    #[serde(default)]
    #[ts(optional, type = "number | null")]
    pub expected: Option<i64>,
    #[serde(flatten)]
    #[ts(flatten)]
    pub page: DonationPagePayload,
}

/// What the save executed, and the page as it now reads.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DonationPageSaved {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
    pub page: DonationPage,
}

/// `POST stripe/page {expected?, amounts, minimum, maximum,
/// sourceCodeId}` → `DonationPageSaved`: admin only. `422 invalid` for a
/// minimum under £1, a maximum over £1,000, or buttons outside them or
/// alike; a newly picked source code must be live; `409 stale`.
async fn save_page(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveDonationPage>,
) -> Result<Json<DonationPageSaved>, ApiError> {
    t.stripe()?;
    t.require_admin()?;
    t.write(move |ctx| {
        let Executed { id, counter } =
            giving::stripe::save_page(ctx, req.page, req.expected, Source::Ui)?;
        Ok(DonationPageSaved {
            id,
            counter,
            page: giving::stripe::page(ctx.tx.read())?,
        })
    })
    .await
    .map(Json)
}
