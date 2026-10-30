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
    self, Frequency, MandatePayload, RegularGiftView, RegularStatus, SetUp, UnknownSubscription,
    UnmatchedPayment, prepare_setup,
};
use giving::requests::{ProviderRequestPayload, RequestKind, record_request, set_provider_ref};
use giving::terms::{self, TermChange};
use giving::types::{GiftView, Provider};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::Params;
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
        .route("/regular-gifts/{id}/terms", post(change_terms))
        .route("/regular-gifts/{id}/terms/{termId}", post(edit_terms))
        .route(
            "/regular-gifts/{id}/terms/{termId}/withdraw",
            post(withdraw_terms),
        )
        .route("/regular-gifts/{id}/terms/{termId}/code", post(code_terms))
        .route("/regular-gifts/{id}/expected", get(expected))
        .route("/reports/expected", get(expected_report))
        .route(
            "/gocardless/unknown-subscriptions",
            get(unknown_subscriptions),
        )
        .route(
            "/gocardless/unknown-subscriptions/{id}/adopt",
            post(adopt_subscription),
        )
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

/// `GET regular-gifts/{id}`: with its chain, and `upcoming`: the next
/// payments to pick a change's date from, GoCardless's own forecast
/// while connected with a subscription (else the chain's projection),
/// each marked whether a change sent now can still reach it.
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<RegularGiftView>, ApiError> {
    let gc = t.gocardless()?;
    let owned = t.gocardless_owned().await?;
    let g = gc.clone();
    let (v, token) = t
        .read(move |r| {
            let v = regular::get_regular(r, &id, &today())?.ok_or(ApiError::NotFound)?;
            let token = g.token(r)?.filter(|_| owned);
            Ok((v, token))
        })
        .await?;
    let forecast = match (&token, &v.subscription_id, v.status.is_ended()) {
        (Some(token), Some(sb), false) => gc.api.get_subscription(token, sb).await.ok(),
        _ => None,
    };
    let (rid, connected) = (v.id.clone(), token.is_some());
    let out = t
        .read(move |r| {
            let day = today();
            let upcoming = match forecast {
                Some(sub) => sub
                    .upcoming
                    .into_iter()
                    .map(|(charge_date, amount)| {
                        Ok(regular::UpcomingPayment {
                            changeable: regular::changeable(r, &rid, &day, &charge_date)?,
                            charge_date,
                            amount,
                        })
                    })
                    .collect::<rusqlite::Result<_>>()?,
                None if v.status.is_ended() => vec![],
                None => regular::projected_upcoming(r, &rid, &day, 10)?,
            };
            Ok(RegularGiftView {
                upcoming,
                ..with_connection(v, connected)
            })
        })
        .await?;
    Ok(Json(out))
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
    let (rid, md) = (id.clone(), found.mandate.mandate_id.clone());
    let shared = match md {
        Some(md) => {
            t.read(move |r| Ok(regular::others_on_mandate(r, &rid, &md)?))
                .await?
        }
        None => false,
    };
    match (
        &found.mandate.mandate_id,
        &found.mandate.billing_request_id,
        &found.mandate.subscription_id,
    ) {
        // Another regular gift (one adopted) collects on the same mandate:
        // stop only this one's subscription.
        (Some(_), _, Some(sb)) if shared => gc.api.cancel_subscription(&token, sb).await,
        // Nothing of its own collects yet: leave the shared mandate be.
        (Some(_), _, None) if shared => Ok(()),
        (Some(md), _, _) => gc.api.cancel_mandate(&token, md).await,
        // Adopted from GoCardless: no mandate of its own, its
        // subscription is what collects (review H2).
        (None, _, Some(sb)) => gc.api.cancel_subscription(&token, sb).await,
        (None, Some(br), None) => match gc.api.cancel_billing_request(&token, br).await {
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
        (None, None, None) => Ok(()),
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
    /// What GoCardless was asked to collect, in pence: the request's as
    /// first recorded under this key (a retry's own amount is ignored).
    pub amount: i64,
    pub status: String,
    pub charge_date: String,
}

/// Refuse what can't be sent: an amount out of range or over £1,000
/// (`giving::rules::ONE_OFF_MAX`, for everyone: more is a bank
/// transfer), a malformed date or key; then the code must be a live one
/// of ours.
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
    } else if amount > giving::rules::ONE_OFF_MAX {
        problems.push(contracts::Problem::new(
            "amount",
            giving::rules::ONE_OFF_MAX_MESSAGE,
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
    over_cap(asked.amount)?;
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
        amount: asked.amount,
        status: p.status,
        charge_date: p.charge_date,
    }))
}

/// A request on record for more than the cap (one saved before it) is
/// refused all the same: what is sent is the request's own amount.
fn over_cap(amount: i64) -> Result<(), ApiError> {
    if amount > giving::rules::ONE_OFF_MAX {
        return Err(ContractError::invalid("amount", giving::rules::ONE_OFF_MAX_MESSAGE).into());
    }
    Ok(())
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
    /// What the link charges, in pence: the request's as first recorded
    /// under this key (a retry's own amount is ignored).
    pub amount: i64,
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
    over_cap(asked.amount)?;
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
        amount: asked.amount,
        flow_url: flow.authorisation_url,
        flow_expires_at: flow.expires_at,
    }))
}

// ── terms (ADR 0026) ───────────────────────────────────────────────────────

/// `regular-gifts/{id}/terms/{termId}…`.
#[derive(Deserialize)]
pub struct TermParam {
    pub id: String,
    #[serde(rename = "termId")]
    pub term_id: String,
}

/// `POST regular-gifts/{id}/terms`: a change from a date.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeTerms {
    #[serde(flatten)]
    pub change: TermChange,
    /// 32 lower-case hex, the form's own: the new row's id, so a retry
    /// is `409 duplicate`.
    #[serde(default)]
    #[ts(optional)]
    pub client_key: Option<String>,
}

/// `POST regular-gifts/{id}/terms/{termId}`: the row as now wanted, while
/// it is scheduled.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EditTerms {
    /// The row's `termsVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
    /// The row's `codeVersion` as last read: needed when `changeCodeId`
    /// changes the code (a code set meanwhile is then `409 stale`).
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub code_expected: Option<i64>,
    #[serde(flatten)]
    pub change: TermChange,
}

/// `POST …/terms/{termId}/code`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CodeTerms {
    /// The row's `codeVersion` as last read.
    #[ts(type = "number")]
    pub expected: i64,
    pub change_code_id: Option<String>,
}

/// The row `term_id` of regular gift `id` (here), or `404`.
fn term_of(r: &rusqlite::Connection, id: &str, term_id: &str) -> Result<(), ApiError> {
    match terms::get_term(r, term_id)? {
        Some(t) if t.regular_gift_id == id => Ok(()),
        _ => Err(ApiError::NotFound),
    }
}

/// `POST regular-gifts/{id}/terms {effectiveFrom, amount, frequency?,
/// dayOfMonth?, month?, changeCodeId?, allocations?, note?, clientKey?}`
/// → `RegularGiftSaved`: a new row, scheduled, sent to GoCardless when it
/// falls due (a run starts now). Staff. An upgrade needs `changeCodeId`
/// (the difference goes to it); without `allocations` the split is the
/// row before's, moved newest money first. `422 rejected`:
/// `regular_gift_ended`, `term_too_early`, `term_clash`.
async fn change_terms(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<ChangeTerms>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    t.gocardless()?;
    if req
        .client_key
        .as_deref()
        .is_some_and(|k| !contracts::is_client_id(k))
    {
        return Err(ContractError::invalid("clientKey", "32 lower-case hex characters").into());
    }
    let out = t
        .write(move |ctx| {
            terms::change_terms(ctx, &id, req.client_key.as_deref(), req.change, Source::Ui)?;
            saved(ctx, &id)
        })
        .await?;
    t.gocardless_sync_terms();
    Ok(Json(out))
}

/// `POST regular-gifts/{id}/terms/{termId} {expected, …change}` →
/// `RegularGiftSaved`. Staff; only while scheduled (`422 rejected
/// term_sent`); `409 stale`.
async fn edit_terms(
    Extension(t): Extension<Tenant>,
    Path(TermParam { id, term_id }): Path<TermParam>,
    Body(req): Body<EditTerms>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    t.gocardless()?;
    let out = t
        .write(move |ctx| {
            term_of(ctx.tx.read(), &id, &term_id)?;
            terms::edit_terms(
                ctx,
                &term_id,
                req.expected,
                req.code_expected,
                req.change,
                Source::Ui,
            )?;
            saved(ctx, &id)
        })
        .await?;
    t.gocardless_sync_terms();
    Ok(Json(out))
}

/// `POST …/terms/{termId}/withdraw {expected}` (the row's
/// `termsVersion`) → `RegularGiftSaved`. Staff; only while scheduled.
async fn withdraw_terms(
    Extension(t): Extension<Tenant>,
    Path(TermParam { id, term_id }): Path<TermParam>,
    Body(req): Body<Expected>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    t.gocardless()?;
    let out = t
        .write(move |ctx| {
            term_of(ctx.tx.read(), &id, &term_id)?;
            terms::withdraw(ctx, &term_id, Some(req.expected), Source::Ui, None)?;
            saved(ctx, &id)
        })
        .await?;
    Ok(Json(out))
}

/// `POST …/terms/{termId}/code {expected, changeCodeId}` →
/// `RegularGiftSaved`: the code credited with a change, at any state (a
/// change made in GoCardless is "not coded" until then). Staff.
async fn code_terms(
    Extension(t): Extension<Tenant>,
    Path(TermParam { id, term_id }): Path<TermParam>,
    Body(req): Body<CodeTerms>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    t.gocardless()?;
    let out = t
        .write(move |ctx| {
            term_of(ctx.tx.read(), &id, &term_id)?;
            terms::set_code(ctx, &term_id, req.expected, req.change_code_id, Source::Ui)?;
            saved(ctx, &id)
        })
        .await?;
    Ok(Json(out))
}

/// `GET gocardless/unknown-subscriptions`: subscriptions payments came
/// from that no regular gift here runs under (made in GoCardless's
/// dashboard): their payments are one-off gifts. Any member.
async fn unknown_subscriptions(
    Extension(t): Extension<Tenant>,
) -> Result<Json<Vec<UnknownSubscription>>, ApiError> {
    t.gocardless()?;
    t.read(|r| Ok(regular::unknown_subscriptions(r)?))
        .await
        .map(Json)
}

/// `POST gocardless/unknown-subscriptions/{id}/adopt`.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AdoptSubscription {
    /// The code the whole amount goes to.
    pub source_code_id: String,
    /// 32 lower-case hex: the new regular gift's id.
    pub client_key: String,
}

/// `POST gocardless/unknown-subscriptions/{id}/adopt {sourceCodeId,
/// clientKey}` → `RegularGiftSaved`: the subscription becomes a regular
/// gift of its mandate's donor, active, its first row GoCardless's terms
/// from its next payment. Nothing is sent to GoCardless (it is collecting
/// already); its earlier payments stay one-off gifts. Staff. Not listed:
/// `404`; a schedule we don't keep (weekly, a day past the 28th): `422
/// rejected unsupported_schedule`.
async fn adopt_subscription(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id: sb }): Path<IdParam>,
    Body(req): Body<AdoptSubscription>,
) -> Result<Json<RegularGiftSaved>, ApiError> {
    let gc = t.gocardless()?;
    let owned = t.gocardless_owned().await?;
    if !contracts::is_client_id(&req.client_key) {
        return Err(ContractError::invalid("clientKey", "32 lower-case hex characters").into());
    }
    let (g, s) = (gc.clone(), sb.clone());
    let (token, contact) = t
        .read(move |r| {
            let listed = regular::unknown_subscription(r, &s)?.ok_or(ApiError::NotFound)?;
            let contact = listed.contact_id.ok_or_else(|| {
                ApiError::from(ContractError::rejected(
                    "unknown_contact",
                    "Its mandate isn’t one of a donor’s here",
                ))
            })?;
            let token = g.token(r)?.filter(|_| owned).ok_or_else(not_connected)?;
            Ok((token, contact))
        })
        .await?;
    let sub = gc
        .api
        .get_subscription(&token, &sb)
        .await
        .map_err(|e| provider(&t.slug, e))?;
    if sub.status != "active" {
        return Err(ContractError::rejected(
            "subscription_not_active",
            format!(
                "This subscription is {} at GoCardless: it collects nothing",
                sub.status
            ),
        )
        .into());
    }
    let unsupported = || {
        ApiError::from(ContractError::rejected(
            "unsupported_schedule",
            "Only monthly or yearly subscriptions on days 1 to 28 can be adopted",
        ))
    };
    let frequency = match sub.interval_unit.as_str() {
        "monthly" => Frequency::Monthly,
        "yearly" => Frequency::Yearly,
        _ => return Err(unsupported()),
    };
    let day = sub
        .day_of_month
        .filter(|d| (1..=28).contains(d))
        .ok_or_else(unsupported)?;
    // `frequency` is GoCardless's: monthly or yearly.
    let month = match frequency {
        Frequency::Monthly | Frequency::Quarterly => None,
        Frequency::Yearly => Some(
            sub.month
                .as_deref()
                .and_then(|m| MONTH_NAMES.iter().position(|x| *x == m))
                .map(|i| i as u8 + 1)
                .ok_or_else(unsupported)?,
        ),
    };
    let from = sub
        .upcoming
        .first()
        .map(|(d, _)| d.clone())
        .unwrap_or_else(today);
    let out = t
        .write(move |ctx| {
            let id = regular::adopt_subscription(
                ctx,
                &req.client_key,
                &sb,
                SetUp {
                    contact_id: contact,
                    amount: sub.amount,
                    frequency,
                    day_of_month: day,
                    month,
                    source_code_id: req.source_code_id,
                    client_key: Some(req.client_key.clone()),
                },
                &from,
                Source::Ui,
            )?;
            saved(ctx, &id)
        })
        .await?;
    Ok(Json(out))
}

const MONTH_NAMES: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

// ── expected against actual (ADR 0026) ─────────────────────────────────────

/// `?from=YYYY-MM&to=YYYY-MM` (default: the 12 months to this one) and,
/// for the report, `by=code|detail|category` (default code).
#[derive(Deserialize)]
pub struct ExpectedQuery {
    pub from: Option<String>,
    pub to: Option<String>,
    pub by: Option<giving::expected::By>,
}

/// The months asked for, checked: `YYYY-MM`, `from` no later than `to`,
/// at most ten years.
fn months(q: &ExpectedQuery) -> Result<(String, String), ApiError> {
    use giving::terms_rules::{month_index, month_label};
    let now = month_index(&today()).unwrap_or_default();
    let parse = |field: &str, v: &Option<String>, default: i32| -> Result<i32, ApiError> {
        match v {
            None => Ok(default),
            Some(m) => month_index(m)
                .filter(|_| m.len() == 7)
                .ok_or_else(|| ContractError::invalid(field, "Months are YYYY-MM").into()),
        }
    };
    let to = parse("to", &q.to, now)?;
    let from = parse("from", &q.from, to - 11)?;
    if from > to || to - from >= 120 {
        return Err(
            ContractError::invalid("from", "From comes before to, at most ten years").into(),
        );
    }
    Ok((month_label(from), month_label(to)))
}

/// `GET regular-gifts/{id}/expected?from&to` → `ExpectedRow[]`: each
/// period's expected amount and split from the chain, and what happened
/// (collected, pending, failed, cancelled, missing, upcoming). Any
/// member; the card shows the default 12.
async fn expected(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<ExpectedQuery>,
) -> Result<Json<Vec<giving::expected::ExpectedRow>>, ApiError> {
    t.gocardless()?;
    let (from, to) = months(&q)?;
    t.read(move |r| {
        giving::expected::for_regular_gift(r, &id, &from, &to, &today())?.ok_or(ApiError::NotFound)
    })
    .await
    .map(Json)
}

/// `GET reports/expected?from&to&by` → `ExpectedReport`: expected,
/// received, failed (arrears), missing and pending by code, detail or
/// category; upgrade value by the code credited (annualised, with the
/// monthly figure), from the first payment collected at the new amount;
/// upgrades not realised. Any member.
async fn expected_report(
    Extension(t): Extension<Tenant>,
    Params(q): Params<ExpectedQuery>,
) -> Result<Json<giving::expected::ExpectedReport>, ApiError> {
    t.gocardless()?;
    let (from, to) = months(&q)?;
    let by = q.by.unwrap_or(giving::expected::By::Code);
    t.read(move |r| Ok(giving::expected::report(r, &from, &to, by, &today())?))
        .await
        .map(Json)
}
