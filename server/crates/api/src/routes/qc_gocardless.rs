//! The QC GoCardless surface (plan gocardless-sandbox-qc.sv, G2): the
//! routes the QC run calls to act at GoCardless for its own `qc-`
//! organisation, so the runner never holds a GoCardless credential.
//!
//! - `POST /api/qc/gocardless/connect {slug}`: connect the org with the
//!   QC account's token, as the OAuth callback would. An older `qc-` org
//!   holding the account gives it up; a real org holding it is `409
//!   taken`. Answers `{organisationId}`, never the token.
//! - `POST …/sign {slug, regularGiftId, givenName?, familyName?}`: the
//!   donor's side of the gift's own billing request, through the API
//!   (customer details, the sandbox's test bank account, confirm, fulfil).
//!   Answers `{mandateId}`; the app learns of it from GoCardless's
//!   webhook, as from the hosted page.
//! - `POST …/simulate {slug, scenario, resource}`: an allowlisted
//!   scenario simulator ([`qc::SCENARIOS`]) on a mandate or payment the
//!   org's rows name.
//! - `GET …/peek/{slug}/{kind}/{id}`: a trimmed GoCardless view of the
//!   org's own `mandate`, `subscription` or `payment`.
//! - `POST …/catchup {slug}`: the catch-up, for this org, now.
//! - `POST …/cleanup {slug}`: delete at GoCardless the customers behind
//!   the org's mandates, and sweep QC-tagged customers older than two
//!   days.
//!
//! The token routes sit behind [`QcCaller`] (the `/api/qc/*` rules:
//! `KEEP_ENV=staging`, `KEEP_QC_TOKEN`, rate limits). Their dev twins,
//! `/api/dev/qc-gocardless/*`, need `KEEP_DEV_AUTH=1` and
//! `KEEP_QC_SEED=1` (the fake, locally). Both are 404 unless GoCardless
//! is `sandbox` with the QC account's variables, or `fake`; and both
//! reach only `qc-` organisations, and only resources their rows name
//! (anything else is 404). Every GoCardless call here carries an
//! `Idempotency-Key` and is retried once on a 5xx or a timeout
//! ([`qc`]); connect and catch-up are production's own code paths.

use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::request::Parts;
use contracts::Source;
use giving::regular::{self, ProviderKind};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use store::{Store, TenantId};
use ts_rs::TS;

use super::qc_seed::{QcCaller, is_qc_slug};
use crate::gocardless::qc::{self, Seen};
use crate::gocardless::{CallError, GoCardless, Mode};
use crate::{ApiError, AppState, Body, blocking};

/// A caller that passed the surface's gate, with GoCardless.
pub struct QcGoCardless(Arc<GoCardless>);

impl FromRequestParts<AppState> for QcGoCardless {
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
        match state.gocardless.clone() {
            Some(gc) if matches!(gc.mode, Mode::Sandbox | Mode::Fake) && gc.qc.is_some() => {
                Ok(QcGoCardless(gc))
            }
            _ => Err(ApiError::NotFound),
        }
    }
}

/// A `qc-` organisation by slug; anything else is 404.
fn qc_tenant(store: &Store, slug: &str) -> Result<TenantId, ApiError> {
    if !is_qc_slug(slug) {
        return Err(ApiError::NotFound);
    }
    Ok(store
        .platform()
        .tenant_by_slug(slug)?
        .ok_or(ApiError::NotFound)?
        .id)
}

fn not_connected() -> ApiError {
    ApiError::Rejected {
        reason: "not_connected".into(),
        message: "Connect the QC organisation to GoCardless first (qc/gocardless/connect)".into(),
    }
}

/// GoCardless's answer, for the caller: 404 for what it doesn't know, its
/// reason for a refusal, 503 when it can't be reached (after the retry).
fn gc_err(slug: &str, e: CallError) -> ApiError {
    match e {
        CallError::Refused { status: 404, .. } => ApiError::NotFound,
        CallError::Refused { status, reason } if (400..500).contains(&status) && status != 429 => {
            ApiError::Rejected {
                reason: reason.unwrap_or_else(|| "gocardless_refused".into()),
                message: format!("GoCardless refused it ({status})"),
            }
        }
        CallError::Unauthorized => not_connected(),
        e => {
            eprintln!("qc gocardless ({slug}): {e}");
            ApiError::GocardlessUnavailable
        }
    }
}

/// The org's file, its token, and whether its rows name `id` as `kind`.
async fn owned(
    state: &AppState,
    gc: &Arc<GoCardless>,
    slug: &str,
    named: Option<(ProviderKind, String)>,
) -> Result<(TenantId, String), ApiError> {
    let (store, g, slug) = (state.store.clone(), gc.clone(), slug.to_owned());
    blocking(move || {
        let tenant = qc_tenant(&store, &slug)?;
        let db = store.org(&tenant)?;
        db.read(|r| {
            if let Some((kind, id)) = &named
                && !regular::names_provider_resource(r, *kind, id)?
            {
                return Err(ApiError::NotFound);
            }
            let token = g.token(r)?.ok_or_else(not_connected)?;
            Ok((tenant.clone(), token))
        })
    })
    .await
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct QcGoCardlessSlug {
    pub slug: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcConnected {
    pub organisation_id: String,
}

/// `POST …/connect {slug}` (module docs).
pub async fn connect(
    QcGoCardless(gc): QcGoCardless,
    State(state): State<AppState>,
    Body(req): Body<QcGoCardlessSlug>,
) -> Result<Json<QcConnected>, ApiError> {
    let account = gc.qc.as_ref().ok_or(ApiError::NotFound)?;
    let organisation = account.organisation_id.clone();
    let store = state.store.clone();
    let slug = req.slug.clone();
    let (tenant, admin) = blocking(move || {
        let tenant = qc_tenant(&store, &slug)?;
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
    // As the OAuth callback: one connect at a time, and no processing run
    // between the reservation and the token.
    let _connecting = gc.connecting.lock().await;
    let _processing = gc.processing.lock().await;
    // Who holds the account now: an older qc- org gives it up (its token
    // emptied, its mapping forgotten; the token isn't revoked, it is the
    // one being moved); a real org keeps it.
    let (store, org, t) = (state.store.clone(), organisation.clone(), tenant.clone());
    let holder: Option<(TenantId, String)> = blocking(move || {
        store.platform().with_read(|c| {
            let found: Option<(String, String)> = c
                .query_row(
                    "SELECT g.tenant_id, t.slug FROM gocardless_connections g
                     JOIN tenants t ON t.id = g.tenant_id
                     WHERE g.organisation_id = ?1 AND g.tenant_id <> ?2",
                    [org.as_str(), t.as_str()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            Ok::<_, ApiError>(found.and_then(|(id, slug)| {
                crate::gocardless::known_tenant(&store, &id)
                    .ok()
                    .flatten()
                    .map(|id| (id, slug))
            }))
        })
    })
    .await?;
    if let Some((holder, holder_slug)) = holder {
        if !is_qc_slug(&holder_slug) {
            return Err(ApiError::Taken);
        }
        let (store, g) = (state.store.clone(), gc.clone());
        blocking(move || {
            let db = store.org(&holder)?;
            contracts::transact(&db, None, |ctx| {
                g.put_token(ctx, "", "", Source::System)
                    .map_err(ApiError::from)
            })?;
            crate::gocardless::forget_connection(&store, &holder)?;
            Ok::<_, ApiError>(())
        })
        .await?;
    }
    let (store, t, org) = (state.store.clone(), tenant.clone(), organisation.clone());
    let previous = match blocking(move || {
        crate::gocardless::record_connection(&store, &t, &org, admin, contracts::now_ms())
    })
    .await?
    {
        Ok(previous) => previous,
        Err(crate::gocardless::ConnectRefused::Taken(_)) => return Err(ApiError::Taken),
    };
    crate::gocardless::oauth::land_token(
        &state.store,
        &gc,
        &tenant,
        &req.slug,
        previous,
        account.token(),
        &organisation,
        None,
        Source::System,
    )
    .await
    .map_err(|()| ApiError::Internal)?;
    drop(_processing);
    drop(_connecting);
    crate::gocardless::webhook::spawn_processing(state.store.clone(), gc.clone());
    Ok(Json(QcConnected {
        organisation_id: organisation,
    }))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcSign {
    pub slug: String,
    pub regular_gift_id: String,
    /// The payer's names; by default the donor's (as the hosted page
    /// prefills them). The sandbox reads some given names as scenarios.
    #[ts(optional)]
    pub given_name: Option<String>,
    #[ts(optional)]
    pub family_name: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcSigned {
    pub mandate_id: String,
}

/// `POST …/sign` (module docs).
pub async fn sign(
    QcGoCardless(gc): QcGoCardless,
    State(state): State<AppState>,
    Body(req): Body<QcSign>,
) -> Result<Json<QcSigned>, ApiError> {
    let (_, token) = owned(&state, &gc, &req.slug, None).await?;
    let (store, slug, id) = (
        state.store.clone(),
        req.slug.clone(),
        req.regular_gift_id.clone(),
    );
    let (br, donor) = blocking(move || {
        let db = store.org(&qc_tenant(&store, &slug)?)?;
        db.read(|r| {
            let found = regular::facts(r, &id)?.ok_or(ApiError::NotFound)?;
            let donor = contacts::donors::describe_donor(r, &found.contact_id)?
                .ok_or(ApiError::NotFound)?;
            Ok::<_, ApiError>((found, donor))
        })
    })
    .await
    .and_then(|(found, donor)| {
        match (
            found.mandate.status(),
            &found.mandate.mandate_id,
            &found.mandate.billing_request_id,
        ) {
            (regular::RegularStatus::Pending, None, Some(br)) => Ok((br.clone(), donor)),
            _ => Err(ApiError::Rejected {
                reason: "not_pending".into(),
                message: "Only a regular gift waiting for the donor can be signed".into(),
            }),
        }
    })?;
    let pick = |given: &Option<String>, own: &str, fallback: &str| {
        given
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(Some(own.trim()).filter(|s| !s.is_empty()))
            .unwrap_or(fallback)
            .to_owned()
    };
    let given = pick(&req.given_name, &donor.first_name, "QC");
    let family = pick(&req.family_name, &donor.last_name, "Donor");
    let email = format!(
        "qc+{}@example.com",
        req.slug.trim_start_matches(super::qc_seed::QC_SLUG_PREFIX)
    );
    let payer = qc::Payer {
        given_name: &given,
        family_name: &family,
        email: &email,
        tag: &req.slug,
    };
    let mandate_id = qc::sign(&gc.api, &token, &br, &payer)
        .await
        .map_err(|e| gc_err(&req.slug, e))?;
    Ok(Json(QcSigned { mandate_id }))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct QcSimulate {
    pub slug: String,
    pub scenario: String,
    pub resource: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct QcSimulated {
    pub ok: bool,
}

/// `POST …/simulate` (module docs). A scenario off the list is 404.
pub async fn simulate(
    QcGoCardless(gc): QcGoCardless,
    State(state): State<AppState>,
    Body(req): Body<QcSimulate>,
) -> Result<Json<QcSimulated>, ApiError> {
    let kind = qc::scenario(&req.scenario).ok_or(ApiError::NotFound)?;
    let (_, token) = owned(&state, &gc, &req.slug, Some((kind, req.resource.clone()))).await?;
    qc::run_scenario(&gc.api, &token, &req.scenario, &req.resource)
        .await
        .map_err(|e| gc_err(&req.slug, e))?;
    Ok(Json(QcSimulated { ok: true }))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcUpcoming {
    pub charge_date: String,
    /// Pence.
    pub amount: i64,
}

/// GoCardless's view of one resource, trimmed: amounts in pence.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcPeek {
    pub id: String,
    pub status: String,
    pub amount: Option<i64>,
    pub charge_date: Option<String>,
    pub next_possible_charge_date: Option<String>,
    /// A subscription's next charges.
    pub upcoming_payments: Vec<QcUpcoming>,
    /// A mandate's or a subscription's payments, any status.
    pub payments: Vec<QcPeek>,
}

impl From<Seen> for QcPeek {
    fn from(s: Seen) -> Self {
        QcPeek {
            id: s.id,
            status: s.status,
            amount: s.amount,
            charge_date: s.charge_date,
            next_possible_charge_date: s.next_possible_charge_date,
            upcoming_payments: s
                .upcoming
                .into_iter()
                .map(|(charge_date, amount)| QcUpcoming {
                    charge_date,
                    amount,
                })
                .collect(),
            payments: s.payments.into_iter().map(QcPeek::from).collect(),
        }
    }
}

/// `GET …/peek/{slug}/{kind}/{id}` (module docs): `kind` is `mandate`,
/// `subscription` or `payment`.
pub async fn peek(
    QcGoCardless(gc): QcGoCardless,
    State(state): State<AppState>,
    Path((slug, kind, id)): Path<(String, String, String)>,
) -> Result<Json<QcPeek>, ApiError> {
    let kind = match kind.as_str() {
        "mandate" => ProviderKind::Mandate,
        "subscription" => ProviderKind::Subscription,
        "payment" => ProviderKind::Payment,
        _ => return Err(ApiError::NotFound),
    };
    let (_, token) = owned(&state, &gc, &slug, Some((kind, id.clone()))).await?;
    let seen = qc::peek(&gc.api, &token, kind, &id)
        .await
        .map_err(|e| gc_err(&slug, e))?;
    Ok(Json(seen.into()))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcCaughtUp {
    /// Events GoCardless listed.
    pub read: u32,
    /// Of those, new here: webhooks that never came.
    pub missed: u32,
}

/// `POST …/catchup {slug}` (module docs).
pub async fn catchup(
    QcGoCardless(gc): QcGoCardless,
    State(state): State<AppState>,
    Body(req): Body<QcGoCardlessSlug>,
) -> Result<Json<QcCaughtUp>, ApiError> {
    let (tenant, _) = owned(&state, &gc, &req.slug, None).await?;
    let caught = crate::gocardless::catchup::catch_up_tenant(state.store.clone(), gc, &tenant)
        .await
        .map_err(|e| {
            eprintln!("qc gocardless ({}): catch-up: {e}", req.slug);
            ApiError::GocardlessUnavailable
        })?
        .ok_or_else(not_connected)?;
    let n = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
    Ok(Json(QcCaughtUp {
        read: n(caught.read),
        missed: n(caught.missed),
    }))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QcCleaned {
    /// This org's customers deleted (or gone already).
    pub own: u32,
    /// Older QC customers swept.
    pub swept: u32,
    /// Customers GoCardless wouldn't delete.
    pub refused: u32,
}

/// `POST …/cleanup {slug}` (module docs).
pub async fn cleanup(
    QcGoCardless(gc): QcGoCardless,
    State(state): State<AppState>,
    Body(req): Body<QcGoCardlessSlug>,
) -> Result<Json<QcCleaned>, ApiError> {
    let (tenant, token) = owned(&state, &gc, &req.slug, None).await?;
    let store = state.store.clone();
    let mandates = blocking(move || {
        let db = store.org(&tenant)?;
        Ok::<Vec<String>, ApiError>(db.read(|r| regular::provider_mandates(r))?)
    })
    .await?;
    let older_than = time::OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(contracts::now_ms() - qc::SWEEP_AFTER_MS) * 1_000_000,
    )
    .ok()
    .and_then(|t| {
        t.format(&time::format_description::well_known::Rfc3339)
            .ok()
    })
    .ok_or(ApiError::Internal)?;
    let done = qc::cleanup(&gc.api, &token, &mandates, &older_than)
        .await
        .map_err(|e| gc_err(&req.slug, e))?;
    let n = |v: usize| u32::try_from(v).unwrap_or(u32::MAX);
    Ok(Json(QcCleaned {
        own: n(done.own),
        swept: n(done.swept),
        refused: n(done.refused),
    }))
}
