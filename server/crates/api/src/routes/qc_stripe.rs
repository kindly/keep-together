//! The QC Stripe surface (plan stripe.sv, S6): the one thing the QC run
//! can't do for its own `qc-` organisation through the app.
//!
//! Every run seeds new organisations, and an organisation that presses
//! "Connect Stripe" gets a new Stripe account that takes no payment until
//! a person has filled in Stripe's hosted form. So the run's organisation
//! is given an account that was onboarded once, by hand, in keep-qc's
//! sandbox (`KEEP_QC_STRIPE_ACCOUNT`; on the fake, one the fake makes):
//!
//! - `POST /api/qc/stripe/connect {slug}`: the organisation is connected
//!   to the QC account, with what Stripe says of it now. An older `qc-`
//!   organisation holding it gives it up; a real one holding it is `409
//!   taken`. An account the organisation had made for itself is
//!   forgotten. Answers `{accountId, chargesEnabled}`.
//!
//! From there on it is production's path: the donor's page, Stripe's
//! Checkout, the platform's webhook endpoint routed by account id.
//! Events kept for the account from earlier runs are not replayed into
//! the new organisation, and its first catch-up reads only from an hour
//! before this connect. But an event Stripe sends later about an earlier
//! run's payment (a dispute closing days on) is routed to whoever holds
//! the account now, so that payment can turn up in the new
//! organisation's "Card payments to match" as taken some other way.
//!
//! The token route sits behind [`QcCaller`] (the `/api/qc/*` rules:
//! `KEEP_ENV=staging`, `KEEP_QC_TOKEN`, rate limits). Its dev twin,
//! `/api/dev/qc-stripe/connect`, needs `KEEP_DEV_AUTH=1` and
//! `KEEP_QC_SEED=1`. Both are 404 unless Stripe is `test` with
//! `KEEP_QC_STRIPE_ACCOUNT`, or `fake`; never `live` (the boot refuses
//! the variable with `KEEP_ENV=prod`, and the route refuses the mode).
//! Both reach only `qc-` organisations.

use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::qc_seed::{QcCaller, is_qc_slug};
use crate::stripe::accounts::{self, Attached};
use crate::stripe::{Mode, Stripe};
use crate::{ApiError, AppState, Body, blocking};

/// A caller that passed the surface's gate, with Stripe and the QC
/// account's id.
pub struct QcStripe(Arc<Stripe>, String);

impl FromRequestParts<AppState> for QcStripe {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        if parts.uri.path().starts_with("/api/dev/") {
            let seeding = std::env::var("KEEP_QC_SEED").is_ok_and(|v| v == "1");
            if !(state.dev_auth && seeding) {
                return Err(ApiError::NotFound);
            }
        } else {
            QcCaller::from_request_parts(parts, state).await?;
        }
        let Some(stripe) = state.stripe.clone() else {
            return Err(ApiError::NotFound);
        };
        let account = match (stripe.mode, &stripe.qc_account, &stripe.fake) {
            (Mode::Test | Mode::Fake, Some(id), _) => id.clone(),
            (Mode::Fake, None, Some(fake)) => fake.qc_account(),
            _ => return Err(ApiError::NotFound),
        };
        Ok(QcStripe(stripe, account))
    }
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct QcStripeSlug {
    pub slug: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcStripeConnected {
    pub account_id: String,
    /// Whether Stripe takes card payments for the account: false means
    /// its onboarding was never finished, and no donation page opens.
    pub charges_enabled: bool,
}

/// `POST …/connect {slug}` (module docs).
pub async fn connect(
    QcStripe(stripe, account_id): QcStripe,
    State(state): State<AppState>,
    Body(req): Body<QcStripeSlug>,
) -> Result<Json<QcStripeConnected>, ApiError> {
    if !is_qc_slug(&req.slug) {
        return Err(ApiError::NotFound);
    }
    let (store, slug) = (state.store.clone(), req.slug.clone());
    let (tenant, admin) = blocking(move || {
        let tenant = store
            .platform()
            .tenant_by_slug(&slug)?
            .ok_or(ApiError::NotFound)?
            .id;
        let admin: Option<i64> = store.platform().with_read(|c| {
            Ok::<_, ApiError>(
                c.query_row(
                    "SELECT user_id FROM memberships WHERE tenant_id = ?1
                     ORDER BY role <> 'admin', user_id LIMIT 1",
                    [tenant.as_str()],
                    |r| r.get(0),
                )
                .optional()?,
            )
        })?;
        Ok::<_, ApiError>((tenant, admin.ok_or(ApiError::NotFound)?))
    })
    .await?;
    // As a connect from Settings: one at a time, and no event run between
    // reading the account and recording who holds it.
    let _connecting = stripe.connecting.lock().await;
    let _processing = stripe.processing.lock().await;
    let account = stripe.api.get_account(&account_id).await.map_err(|e| {
        if e.account_gone() {
            return ApiError::Rejected {
                reason: "account_gone".into(),
                message: format!(
                    "Stripe doesn't know {} as this platform's connected account",
                    crate::stripe::QC_ACCOUNT_VAR
                ),
            };
        }
        // The status and Stripe's error code only.
        crate::observe::warning(&format!("qc stripe connect ({}): {e}", req.slug));
        ApiError::StripeUnavailable
    })?;
    let (store, t) = (state.store.clone(), tenant.clone());
    let attached = blocking(move || {
        accounts::attach(&store, &t, &account, admin, contracts::now_ms(), is_qc_slug)
    })
    .await?;
    drop(_processing);
    drop(_connecting);
    match attached {
        Attached::Taken => Err(ApiError::Taken),
        Attached::Done { row, moved_from } => {
            if let Some(from) = moved_from {
                eprintln!("qc stripe: {account_id} moved from {from} to {}", req.slug);
            }
            crate::stripe::webhook::spawn_processing(state.store.clone(), stripe);
            Ok(Json(QcStripeConnected {
                account_id,
                charges_enabled: row.charges_enabled,
            }))
        }
    }
}
