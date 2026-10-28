//! `/api/t/{slug}/gocardless…` and regular gifts by Direct Debit
//! (`factory/plans/gocardless.sv`, D1 and D2; `api::gocardless` holds the
//! provider). With `KEEP_GOCARDLESS=off` every route but `GET gocardless`
//! is 404.
//!
//! Connecting and disconnecting are an admin's, within the step-up hour.
//! Staff set up, re-link and cancel regular gifts; viewers read. A regular
//! gift is made only once GoCardless has made its billing request and
//! hosted page, so a GoCardless failure leaves nothing behind here (`503
//! gocardless_unavailable`). Nothing about money is optimistic: payments
//! and gifts arrive by webhook ([`crate::gocardless::process`]).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Contract, ContractError, Source};
use giving::regular::{
    self, Frequency, MandatePayload, RegularGiftPayload, RegularGiftView, RegularStatus,
    prepare_terms,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::gocardless::client::{CallError, Prefill};
use crate::gocardless::{ConnectStart, GoCardless, GoCardlessStatus};
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/gocardless", get(status))
        .route("/gocardless/connect", post(connect))
        .route("/gocardless/disconnect", post(disconnect))
        .route("/gocardless/events/retry", post(retry_events))
        .route("/contacts/{id}/regular-gifts", get(by_contact).post(set_up))
        .route("/regular-gifts/{id}", get(one))
        .route("/regular-gifts/{id}/link", post(new_link))
        .route("/regular-gifts/{id}/cancel", post(cancel))
}

/// `GET gocardless`: on or off here, and this organisation's connection.
/// Any member.
async fn status(Extension(t): Extension<Tenant>) -> Result<Json<GoCardlessStatus>, ApiError> {
    t.gocardless_status().await.map(Json)
}

/// `POST gocardless/connect` → `{url}`: send the browser there; it comes
/// back to `/api/gocardless/callback`, then to the group's settings.
async fn connect(Extension(t): Extension<Tenant>) -> Result<Json<ConnectStart>, ApiError> {
    t.gocardless_connect().await.map(Json)
}

/// `POST gocardless/disconnect` → the status, now disconnected.
async fn disconnect(Extension(t): Extension<Tenant>) -> Result<Json<GoCardlessStatus>, ApiError> {
    t.gocardless_disconnect().await.map(Json)
}

/// `POST gocardless/events/retry` → the status: parked webhook events
/// back in the queue (admin).
async fn retry_events(Extension(t): Extension<Tenant>) -> Result<Json<GoCardlessStatus>, ApiError> {
    t.gocardless_retry_failed().await.map(Json)
}

/// A GoCardless failure as the route answers it: a refused token means
/// the account was disconnected at GoCardless's end.
fn provider(slug: &str, e: CallError) -> ApiError {
    match e {
        CallError::Unauthorized => not_connected(),
        e => {
            eprintln!("gocardless ({slug}): {e}");
            ApiError::GocardlessUnavailable
        }
    }
}

fn not_connected() -> ApiError {
    ApiError::Rejected {
        reason: "not_connected".into(),
        message: "Connect your GoCardless account in Settings first".into(),
    }
}

/// A view with `connected` filled in from the organisation's token.
fn with_connection(mut v: RegularGiftView, connected: bool) -> RegularGiftView {
    v.connected = connected;
    v
}

/// `GET contacts/{id}/regular-gifts`: newest set up first, each with its
/// latest payments. Unknown contact: `404`.
async fn by_contact(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<RegularGiftView>>, ApiError> {
    let gc = t.gocardless()?;
    t.read(move |r| {
        if contacts::donors::kind_of(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        let connected = gc.token(r)?.is_some();
        Ok(regular::regular_by_contact(r, &id)?
            .into_iter()
            .map(|v| with_connection(v, connected))
            .collect())
    })
    .await
    .map(Json)
}

/// `GET regular-gifts/{id}`
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<RegularGiftView>, ApiError> {
    let gc = t.gocardless()?;
    t.read(move |r| {
        let v = regular::get_regular(r, &id)?.ok_or(ApiError::NotFound)?;
        Ok(with_connection(v, gc.token(r)?.is_some()))
    })
    .await
    .map(Json)
}

/// `POST contacts/{id}/regular-gifts`: what staff choose; the contact is
/// the path's.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetUpRegularGift {
    #[ts(type = "number")]
    pub amount: i64,
    pub frequency: Frequency,
    pub day_of_month: u8,
    #[serde(default)]
    #[ts(optional)]
    pub month: Option<u8>,
    pub source_code_id: String,
    #[serde(default)]
    #[ts(optional)]
    pub client_key: Option<String>,
}

/// A regular-gift write's answer: the regular gift as it now is, read in
/// the same transaction. `view.flowUrl` is the donor's sign-up link.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RegularGiftSaved {
    pub id: String,
    pub view: RegularGiftView,
}

fn saved(ctx: &contracts::Ctx, id: &str) -> Result<RegularGiftSaved, ApiError> {
    let view = regular::get_regular(ctx.tx.read(), id)?.ok_or(ApiError::NotFound)?;
    Ok(RegularGiftSaved {
        id: id.to_owned(),
        view: with_connection(view, true),
    })
}

/// The donor's name for GoCardless's page to prefill.
fn prefill(donor: &contacts::donors::Donor) -> Prefill {
    let filled = |s: &str| Some(s.trim().to_owned()).filter(|s| !s.is_empty());
    match donor.kind {
        contacts::types::Kind::Individual => Prefill {
            given_name: filled(&donor.first_name),
            family_name: filled(&donor.last_name),
            company_name: None,
        },
        _ => Prefill {
            company_name: filled(&donor.display_name),
            ..Prefill::default()
        },
    }
}

/// `POST contacts/{id}/regular-gifts {amount, frequency, dayOfMonth,
/// month?, sourceCodeId, clientKey?}` → `RegularGiftSaved`, pending, with
/// the donor's link. Checked here first (`422`, `409 duplicate`), then
/// GoCardless makes the billing request (Bacs, GBP) and its hosted page,
/// then it is stored. Not connected: `422 rejected not_connected`.
async fn set_up(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id: contact }): Path<IdParam>,
    Body(req): Body<SetUpRegularGift>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    let gc = t.gocardless()?;
    let terms = prepare_terms(RegularGiftPayload {
        contact_id: contact,
        amount: req.amount,
        frequency: req.frequency,
        day_of_month: req.day_of_month,
        month: req.month,
        source_code_id: req.source_code_id,
        client_key: req.client_key,
    })?;
    let (g, check) = (gc.clone(), terms.clone());
    let (token, prefill) = t
        .read(move |r| {
            let Some(donor) = contacts::donors::describe_donor(r, &check.contact_id)? else {
                return Err(ApiError::NotFound);
            };
            if let Some(key) = &check.client_key
                && let Some(held) = regular::facts_by(r, "client_key", key)?
            {
                return Err(ApiError::Duplicate { id: held.id });
            }
            match sources::describe(r, &check.source_code_id)? {
                None => {
                    return Err(ContractError::rejected(
                        "unknown_source_code",
                        "The source code must be a full code (category, detail and version)",
                    )
                    .into());
                }
                Some(code) if !code.is_active => {
                    return Err(ContractError::rejected(
                        "archived_source_code",
                        format!("{} is archived: choose another", code.code),
                    )
                    .into());
                }
                Some(_) => {}
            }
            let token = g.token(r)?.ok_or_else(not_connected)?;
            Ok((token, prefill(&donor)))
        })
        .await?;
    let id = contracts::new_id();
    let link = make_link(&gc, &t.slug, &token, &id, None, &prefill).await?;
    let out = t
        .write(move |ctx| {
            regular::create_regular_gift(ctx, &id, terms, link, Source::Ui)?;
            saved(ctx, &id)
        })
        .await?;
    Ok(Json(out))
}

/// A billing request for regular gift `id` (unless it has one) and a new
/// hosted page for it: the mandate slice's link fields.
async fn make_link(
    gc: &GoCardless,
    slug: &str,
    token: &str,
    id: &str,
    billing_request: Option<String>,
    prefill: &Prefill,
) -> Result<MandatePayload, ApiError> {
    let billing_request = match billing_request {
        Some(br) => br,
        None => {
            gc.api
                .create_billing_request(token, id)
                .await
                .map_err(|e| provider(slug, e))?
                .id
        }
    };
    let flow = gc
        .api
        .create_flow(token, &billing_request, prefill)
        .await
        .map_err(|e| provider(slug, e))?;
    Ok(MandatePayload {
        billing_request_id: Some(billing_request),
        flow_url: Some(flow.authorisation_url),
        flow_expires_at: flow.expires_at,
        ..MandatePayload::default()
    })
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "RegularGiftCommand")]
pub struct Expected {
    /// The regular gift's `mandateVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
}

/// `POST regular-gifts/{id}/link {expected}`: a new sign-up link (a hosted
/// page lasts 7 days) for a regular gift still waiting for its mandate.
/// Anything else: `422 rejected not_pending`.
async fn new_link(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<Expected>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    let gc = t.gocardless()?;
    let (g, rid) = (gc.clone(), id.clone());
    let (token, found, prefill) = t
        .read(move |r| {
            let found = regular::facts(r, &rid)?.ok_or(ApiError::NotFound)?;
            let donor = contacts::donors::describe_donor(r, &found.terms.contact_id)?
                .ok_or(ApiError::NotFound)?;
            let token = g.token(r)?.ok_or_else(not_connected)?;
            Ok((token, found, prefill(&donor)))
        })
        .await?;
    if found.mandate.status() != RegularStatus::Pending || found.mandate.mandate_id.is_some() {
        return Err(ContractError::rejected(
            "not_pending",
            "Only a regular gift waiting for the donor gets a new link",
        )
        .into());
    }
    let link = make_link(
        &gc,
        &t.slug,
        &token,
        &id,
        found.mandate.billing_request_id.clone(),
        &prefill,
    )
    .await?;
    let out = t
        .write(move |ctx| {
            regular::update_mandate(ctx, &id, Some(req.expected), Source::Ui, None, |m| {
                m.billing_request_id = link.billing_request_id;
                m.flow_url = link.flow_url;
                m.flow_expires_at = link.flow_expires_at;
            })?;
            saved(ctx, &id)
        })
        .await?;
    Ok(Json(out))
}

/// `POST regular-gifts/{id}/cancel {expected}`: stop it at GoCardless
/// (its mandate, which takes the subscription and pending payments with
/// it; or, before the donor signed, its billing request), then mark it
/// cancelled. One already ended is answered as it is.
async fn cancel(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<Expected>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    let gc = t.gocardless()?;
    let (g, rid) = (gc.clone(), id.clone());
    let (token, found, counter) = t
        .read(move |r| {
            let view = regular::get_regular(r, &rid)?.ok_or(ApiError::NotFound)?;
            let found = regular::facts(r, &rid)?.ok_or(ApiError::NotFound)?;
            Ok((g.token(r)?, found, view.mandate_version))
        })
        .await?;
    if found.mandate.status().is_ended() {
        let out = t.write(move |ctx| saved(ctx, &id)).await?;
        return Ok(Json(out));
    }
    if counter != req.expected {
        // The refusal a save gives, before GoCardless is touched.
        return Err(ApiError::Stale {
            contract: giving::regular::RegularGiftMandate::NAME.into(),
            counter,
            current: serde_json::to_value(&found.mandate).map_err(ApiError::internal)?,
        });
    }
    let token = token.ok_or_else(not_connected)?;
    match (&found.mandate.mandate_id, &found.mandate.billing_request_id) {
        (Some(md), _) => gc.api.cancel_mandate(&token, md).await,
        (None, Some(br)) => match gc.api.cancel_billing_request(&token, br).await {
            // The donor signed meanwhile (we haven't heard yet): cancel the
            // mandate the request made, which takes any subscription with
            // it. Ours ends below, so none is made after.
            Err(CallError::Refused { status: 422, .. }) => {
                match gc.api.get_billing_request(&token, br).await {
                    Ok(request) => match request.mandate {
                        Some(md) => gc.api.cancel_mandate(&token, &md).await,
                        None => Ok(()),
                    },
                    Err(e) => Err(e),
                }
            }
            other => other,
        },
        (None, None) => Ok(()),
    }
    .map_err(|e| provider(&t.slug, e))?;
    let out = t
        .write(move |ctx| {
            regular::end_regular_gift(
                ctx,
                &id,
                Some(req.expected),
                RegularStatus::Cancelled,
                Some("Cancelled by staff".into()),
                Source::Ui,
            )?;
            saved(ctx, &id)
        })
        .await?;
    Ok(Json(out))
}
