//! `/api/t/{slug}/stripe…` (`factory/plans/stripe.sv`, S1;
//! `api::stripe` holds the provider). With `KEEP_STRIPE=off` every route
//! but `GET stripe` is 404.
//!
//! Connecting and disconnecting are an admin's, within the step-up hour;
//! every member reads the status. Nothing here touches the
//! organisation's file: which Stripe account is whose lives in
//! `platform.db`.

use axum::routing::{get, post};
use axum::{Extension, Json, Router};

use crate::stripe::{StripeConnectStart, StripeStatus};
use crate::{ApiError, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/stripe", get(status))
        .route("/stripe/connect", post(connect))
        .route("/stripe/disconnect", post(disconnect))
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
