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
use giving::stripe::UnmatchedCardPayment;
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
