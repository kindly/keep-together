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
//!
//! ADR 0025: staff list the payments nobody could be matched to and match
//! one to a contact (its gift is made then); they take a one-off on an
//! existing mandate, or send an Instant Bank Pay link. Neither makes a
//! gift here: the gift comes with GoCardless's events, like any other.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Contract, ContractError, Source};
use giving::regular::{
    self, Frequency, MandatePayload, RegularGiftView, RegularStatus, SetUp, UnmatchedPayment,
    prepare_setup,
};
use giving::requests::{ProviderRequestPayload, RequestKind, record_request, set_provider_ref};
use giving::types::{GiftView, Provider};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::gocardless::client::{CallError, NewPayment, Prefill};
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
        .route("/regular-gifts/{id}/one-off", post(one_off))
        .route("/contacts/{id}/instant-payment", post(instant_payment))
        .route("/gocardless/unmatched", get(unmatched))
        .route("/gocardless/unmatched/{id}/match", post(match_payment))
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

/// Today's date (UTC), for what a read shows as in force.
pub(crate) fn today() -> String {
    giving::terms_rules::date_of_ms(contracts::now_ms())
}

fn not_connected() -> ApiError {
    ApiError::Rejected {
        reason: "not_connected".into(),
        message: "Connect your GoCardless account in Settings first".into(),
    }
}

/// A view with `connected` filled in: the organisation owns its
/// GoCardless account's mapping and holds its token.
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
    let owned = t.gocardless_owned().await?;
    t.read(move |r| {
        if contacts::donors::kind_of(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        let connected = owned && gc.token(r)?.is_some();
        Ok(regular::regular_by_contact(r, &id, &today())?
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
    let owned = t.gocardless_owned().await?;
    t.read(move |r| {
        let v = regular::get_regular(r, &id, &today())?.ok_or(ApiError::NotFound)?;
        Ok(with_connection(v, owned && gc.token(r)?.is_some()))
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
    let view = regular::get_regular(ctx.tx.read(), id, &giving::terms_rules::date_of_ms(ctx.at))?
        .ok_or(ApiError::NotFound)?;
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
    // Connected = this organisation owns the account's mapping, not
    // merely holds a token.
    let owned = t.gocardless_owned().await?;
    let terms = prepare_setup(SetUp {
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
            let token = g.token(r)?.filter(|_| owned).ok_or_else(not_connected)?;
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
    // Connected = this organisation owns the account's mapping, not
    // merely holds a token.
    let owned = t.gocardless_owned().await?;
    let (g, rid) = (gc.clone(), id.clone());
    let (token, found, prefill) = t
        .read(move |r| {
            let found = regular::facts(r, &rid)?.ok_or(ApiError::NotFound)?;
            let donor = contacts::donors::describe_donor(r, &found.contact_id)?
                .ok_or(ApiError::NotFound)?;
            let token = g.token(r)?.filter(|_| owned).ok_or_else(not_connected)?;
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
    // Connected = this organisation owns the account's mapping, not
    // merely holds a token.
    let owned = t.gocardless_owned().await?;
    let (g, rid) = (gc.clone(), id.clone());
    let (token, found, counter) = t
        .read(move |r| {
            let view = regular::get_regular(r, &rid, &today())?.ok_or(ApiError::NotFound)?;
            let found = regular::facts(r, &rid)?.ok_or(ApiError::NotFound)?;
            Ok((g.token(r)?.filter(|_| owned), found, view.mandate_version))
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

/// `GET gocardless/unmatched`: payments GoCardless reported that nobody
/// here could be matched to (no gift yet), newest first. Any member.
async fn unmatched(
    Extension(t): Extension<Tenant>,
) -> Result<Json<Vec<UnmatchedPayment>>, ApiError> {
    t.gocardless()?;
    t.read(|r| Ok(regular::unmatched(r)?)).await.map(Json)
}

/// `POST gocardless/unmatched/{id}/match`: whose it is.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MatchPayment {
    /// The payment's `version` as listed.
    #[ts(type = "number")]
    pub expected: i64,
    pub contact_id: String,
    pub source_code_id: String,
}

/// A matched payment's gift, read in the same transaction.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MatchedPayment {
    pub gift_id: String,
    pub gift: GiftView,
}

/// `POST gocardless/unmatched/{id}/match {expected, contactId,
/// sourceCodeId}` → `MatchedPayment`: the payment becomes the contact's
/// gift, with GoCardless's amount, date and status, to that (live) code.
/// Staff. Already matched: `422 rejected already_matched`; `409 stale`.
async fn match_payment(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<MatchPayment>,
) -> Result<Json<MatchedPayment>, ApiError> {
    t.gocardless()?;
    let out = t
        .write(move |ctx| {
            let gift_id = regular::match_payment(
                ctx,
                &id,
                req.expected,
                &req.contact_id,
                &req.source_code_id,
                Source::Ui,
            )?;
            let gift = giving::get(ctx.tx.read(), &gift_id)?.ok_or(ApiError::NotFound)?;
            Ok(MatchedPayment { gift_id, gift })
        })
        .await?;
    Ok(Json(out))
}

/// `POST regular-gifts/{id}/one-off`: charge its mandate once.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TakeOneOff {
    #[ts(type = "number")]
    pub amount: i64,
    /// YYYY-MM-DD; none: the earliest GoCardless can.
    #[serde(default)]
    #[ts(optional)]
    pub charge_date: Option<String>,
    pub source_code_id: String,
    /// 32 lower-case hex, the form's own: a retry takes it once.
    pub client_key: String,
}

/// What GoCardless made: the gift follows from its events.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OneOffStarted {
    /// Our record of the request (who asked): the form's `clientKey`.
    pub request_id: String,
    pub payment_id: String,
    pub status: String,
    pub charge_date: String,
}

/// Refuse what can't be sent: an amount out of range, a malformed date or
/// key; then the code must be a live one of ours.
fn check_one_off(
    r: &rusqlite::Connection,
    amount: i64,
    charge_date: Option<&str>,
    source_code_id: &str,
    client_key: &str,
) -> Result<(), ApiError> {
    let mut problems = vec![];
    if amount <= 0 || amount > giving::PENCE_MAX {
        problems.push(contracts::Problem::new(
            "amount",
            "The amount must be over £0",
        ));
    }
    if charge_date.is_some_and(|d| !giving::rules::is_iso_date(d)) {
        problems.push(contracts::Problem::new(
            "chargeDate",
            "Dates are YYYY-MM-DD",
        ));
    }
    if !contracts::is_client_id(client_key) {
        problems.push(contracts::Problem::new(
            "clientKey",
            "32 lower-case hex characters",
        ));
    }
    if !problems.is_empty() {
        return Err(ContractError::Invalid(problems).into());
    }
    match sources::describe(r, source_code_id)? {
        None => Err(ContractError::rejected(
            "unknown_source_code",
            "The source code must be a full code (category, detail and version)",
        )
        .into()),
        Some(code) if !code.is_active => Err(ContractError::rejected(
            "archived_source_code",
            format!("{} is archived: choose another", code.code),
        )
        .into()),
        Some(_) => Ok(()),
    }
}

/// `POST regular-gifts/{id}/one-off {amount, chargeDate?, sourceCodeId,
/// clientKey}` → `OneOffStarted`: GoCardless takes a payment on the
/// regular gift's mandate once, tagged with its donor, the code and our
/// request (recorded first as the staff member: who asked). Staff.
/// No mandate yet or ended: `422 rejected no_mandate`. The gift arrives
/// with GoCardless's event (pending until collected).
async fn one_off(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<TakeOneOff>,
) -> Result<Json<OneOffStarted>, ApiError> {
    let gc = t.gocardless()?;
    let owned = t.gocardless_owned().await?;
    let (g, check) = (gc.clone(), req.clone());
    let (token, found) = t
        .read(move |r| {
            let found = regular::facts(r, &id)?.ok_or(ApiError::NotFound)?;
            check_one_off(
                r,
                check.amount,
                check.charge_date.as_deref(),
                &check.source_code_id,
                &check.client_key,
            )?;
            let token = g.token(r)?.filter(|_| owned).ok_or_else(not_connected)?;
            Ok((token, found))
        })
        .await?;
    let Some(mandate) = found
        .mandate
        .mandate_id
        .clone()
        .filter(|_| !found.mandate.status().is_ended())
    else {
        return Err(ContractError::rejected(
            "no_mandate",
            "This regular gift has no live mandate to charge",
        )
        .into());
    };
    // Who asked, on record before GoCardless is called; a retry with the
    // same key is the same request, as first asked.
    let asked = ask(
        &t,
        &req.client_key,
        ProviderRequestPayload {
            kind: RequestKind::OneOff,
            provider: Provider::Gocardless,
            contact_id: found.contact_id.clone(),
            regular_gift_id: Some(found.id.clone()),
            amount: req.amount,
            source_code_id: req.source_code_id.clone(),
            charge_date: req.charge_date.clone(),
            provider_ref: None,
        },
    )
    .await?;
    let description = format!("One-off gift {}", giving::format_pence(asked.amount));
    let p = gc
        .api
        .create_payment(
            &token,
            &NewPayment {
                mandate: &mandate,
                amount: asked.amount,
                charge_date: asked.charge_date.as_deref(),
                description: &description,
                contact: &asked.contact_id,
                source_code: &asked.source_code_id,
                key: &req.client_key,
            },
        )
        .await
        .map_err(|e| provider(&t.slug, e))?;
    answered(&t, &req.client_key, &p.id).await?;
    Ok(Json(OneOffStarted {
        request_id: req.client_key,
        payment_id: p.id,
        status: p.status,
        charge_date: p.charge_date,
    }))
}

/// Record a staff request to GoCardless as the caller (review M2), before
/// GoCardless is called. A key already used for another request (another
/// kind, donor or regular gift) is `409 duplicate`.
async fn ask(
    t: &Tenant,
    key: &str,
    payload: ProviderRequestPayload,
) -> Result<ProviderRequestPayload, ApiError> {
    let key = key.to_owned();
    t.write(move |ctx| {
        let asked = record_request(ctx, &key, payload.clone(), Source::Ui)?;
        if (asked.kind, &asked.contact_id, &asked.regular_gift_id)
            != (payload.kind, &payload.contact_id, &payload.regular_gift_id)
        {
            return Err(ApiError::Duplicate { id: key });
        }
        Ok(asked)
    })
    .await
}

/// GoCardless's id for what the request made, on the request.
async fn answered(t: &Tenant, key: &str, provider_ref: &str) -> Result<(), ApiError> {
    let (key, provider_ref) = (key.to_owned(), provider_ref.to_owned());
    t.write(move |ctx| Ok(set_provider_ref(ctx, &key, &provider_ref)?))
        .await
}

/// `POST contacts/{id}/instant-payment`: a link to pay once by bank.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstantPayment {
    #[ts(type = "number")]
    pub amount: i64,
    pub source_code_id: String,
    /// What the donor sees; default "Gift of £x".
    #[serde(default)]
    #[ts(optional)]
    pub description: Option<String>,
    /// 32 lower-case hex, the form's own: a retry makes one request.
    pub client_key: String,
}

/// The donor's page to pay on (GoCardless's hosted page).
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstantPaymentLink {
    /// Our record of the request (who asked): the form's `clientKey`.
    pub request_id: String,
    pub billing_request_id: String,
    pub flow_url: String,
    pub flow_expires_at: Option<String>,
}

/// The longest description sent to GoCardless.
const DESCRIPTION_MAX: usize = 100;

/// `POST contacts/{id}/instant-payment {amount, sourceCodeId,
/// description?, clientKey}` → `InstantPaymentLink`: an Instant Bank Pay
/// request (a payment request, no mandate; the group switches Instant
/// Bank Pay on in GoCardless), tagged with the contact and code, and its
/// hosted page for staff to send. Staff. Only the request is stored here
/// (who asked, [`giving::requests`]): the payment becomes the contact's
/// gift from GoCardless's events, with the requester as its actor.
async fn instant_payment(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id: contact }): Path<IdParam>,
    Body(req): Body<InstantPayment>,
) -> Result<Json<InstantPaymentLink>, ApiError> {
    let gc = t.gocardless()?;
    let owned = t.gocardless_owned().await?;
    let (g, check, c) = (gc.clone(), req.clone(), contact.clone());
    let (token, prefill) = t
        .read(move |r| {
            let donor = contacts::donors::describe_donor(r, &c)?.ok_or(ApiError::NotFound)?;
            check_one_off(
                r,
                check.amount,
                None,
                &check.source_code_id,
                &check.client_key,
            )?;
            let token = g.token(r)?.filter(|_| owned).ok_or_else(not_connected)?;
            Ok((token, prefill(&donor)))
        })
        .await?;
    let asked = ask(
        &t,
        &req.client_key,
        ProviderRequestPayload {
            kind: RequestKind::Instant,
            provider: Provider::Gocardless,
            contact_id: contact.clone(),
            regular_gift_id: None,
            amount: req.amount,
            source_code_id: req.source_code_id.clone(),
            charge_date: None,
            provider_ref: None,
        },
    )
    .await?;
    let description = req
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(|d| d.chars().take(DESCRIPTION_MAX).collect::<String>())
        .unwrap_or_else(|| format!("Gift of {}", giving::format_pence(asked.amount)));
    let request = gc
        .api
        .create_instant_payment_request(
            &token,
            asked.amount,
            &description,
            &asked.contact_id,
            &asked.source_code_id,
            &req.client_key,
        )
        .await
        .map_err(|e| provider(&t.slug, e))?;
    answered(&t, &req.client_key, &request.id).await?;
    let flow = gc
        .api
        .create_flow(&token, &request.id, &prefill)
        .await
        .map_err(|e| provider(&t.slug, e))?;
    Ok(Json(InstantPaymentLink {
        request_id: req.client_key,
        billing_request_id: request.id,
        flow_url: flow.authorisation_url,
        flow_expires_at: flow.expires_at,
    }))
}
