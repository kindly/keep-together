//! `/api/t/{slug}/giftaid/claims…` and `…/giftaid/hmrc-details`: Gift
//! Aid claims (rule 4) and the charity's HMRC details. Admin only, every
//! route, reads and downloads included (`Tenant::require_admin`: role
//! admin and a sign-in within the hour). Claims are never optimistic:
//! every write answers the claim as it now is, read in the same
//! transaction.
//!
//! The steps: preview (`GET claims/preview?periodEnd`), create (`POST
//! claims`), download the schedule (`GET claims/{id}/schedule?part&format`)
//! and upload it to Charities Online, then mark it ready, submitted and
//! paid (`POST claims/{id}/status`). `GET claims/{id}/xml` is the claim
//! as HMRC's XML: generated for checking and for HMRC's recognition,
//! never sent.

use axum::extract::Path;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Ctx, Executed, Source};
use giftaid::claim_types::{
    ClaimPreview, ClaimSaved, ClaimView, Claims, ClaimsCreated, CreateClaim, HmrcDetailsView,
    SaveHmrcDetails, SetClaimStatus,
};
use giftaid::schedule::Template;
use giftaid::xml::Envelope;
use serde::Deserialize;

use super::Params;
use super::giftaid::iso_date;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/giftaid/claims", get(list).post(create))
        .route("/giftaid/claims/preview", get(preview))
        .route("/giftaid/claims/{id}", get(one))
        .route("/giftaid/claims/{id}/status", post(status))
        .route("/giftaid/claims/{id}/schedule", get(schedule))
        .route("/giftaid/claims/{id}/xml", get(xml))
        .route("/giftaid/hmrc-details", get(details).post(save_details))
}

/// `GET giftaid/claims`: newest first, deleted drafts left out.
async fn list(Extension(t): Extension<Tenant>) -> Result<Json<Claims>, ApiError> {
    t.require_admin()?;
    t.read(|r| {
        Ok(Claims {
            claims: giftaid::claims::list(r)?,
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewQuery {
    period_end: String,
}

/// `GET giftaid/claims/preview?periodEnd`: what a claim to that date
/// would take now, what it leaves out and why, and the adjustments it
/// would carry. Judged on the server's UK today.
async fn preview(
    Extension(t): Extension<Tenant>,
    Params(q): Params<PreviewQuery>,
) -> Result<Json<ClaimPreview>, ApiError> {
    t.require_admin()?;
    iso_date("periodEnd", &q.period_end)?;
    let today = giftaid::uk_date(contracts::now_ms());
    t.read(move |r| Ok(giftaid::claims::preview(r, &q.period_end, &today)?))
        .await
        .map(Json)
}

fn view(ctx: &Ctx, id: &str) -> Result<ClaimView, ApiError> {
    giftaid::claims::view(ctx.tx.read(), id)?.ok_or(ApiError::NotFound)
}

/// `POST giftaid/claims {periodEnd, expectedLines?, expectedDonations?}`
/// → the new draft claims (one per 1,000 gifts, oldest first). `422
/// rejected`: `nothing_to_claim`, `preview_changed`.
async fn create(
    Extension(t): Extension<Tenant>,
    Body(req): Body<CreateClaim>,
) -> Result<Json<ClaimsCreated>, ApiError> {
    t.require_admin()?;
    t.write(move |ctx| {
        let ids = giftaid::claims::create_claim(ctx, req, Source::Ui)?;
        Ok(ClaimsCreated {
            claims: ids
                .iter()
                .map(|id| view(ctx, id))
                .collect::<Result<_, _>>()?,
        })
    })
    .await
    .map(Json)
}

/// `GET giftaid/claims/{id}`
async fn one(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<ClaimView>, ApiError> {
    t.require_admin()?;
    t.read(move |r| giftaid::claims::view(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

/// `POST giftaid/claims/{id}/status {expected, status, submittedOn?,
/// hmrcReference?, paidOn?, paidAmount?, reason?}`: `expected` is the
/// claim's `statusVersion`. `409 stale`; `422 rejected`: `claim_status`
/// (not a next step), `voided_gifts`, `adjusted_later`.
async fn status(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SetClaimStatus>,
) -> Result<Json<ClaimSaved>, ApiError> {
    t.require_admin()?;
    t.write(move |ctx| {
        let done =
            giftaid::claims::set_claim_status(ctx, &id, req.expected, req.payload, Source::Ui)?;
        // A deleted draft has no view.
        Ok(ClaimSaved {
            view: giftaid::claims::view(ctx.tx.read(), &done.id)?,
            id: done.id,
            counter: done.counter,
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
struct ScheduleQuery {
    format: Option<String>,
}

fn attachment(content_type: &'static str, filename: String, bytes: Vec<u8>) -> Response {
    let mut res = bytes.into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// `GET giftaid/claims/{id}/schedule?format=excel|libreoffice`: HMRC's
/// Gift Aid schedule for the claim (one per claim: at most 1,000
/// donations), filled from HMRC's own template for that software
/// (default Excel). A `.ods` download.
async fn schedule(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<ScheduleQuery>,
) -> Result<Response, ApiError> {
    t.require_admin()?;
    let template = match q.format.as_deref() {
        None => Template::Excel,
        Some(f) => Template::parse(f).ok_or_else(|| ApiError::Invalid {
            problems: vec![contracts::Problem::new("format", "excel or libreoffice")],
        })?,
    };
    let (bytes, number) = t
        .read(move |r| {
            let number = giftaid::claims::summary(r, &id)?
                .ok_or(ApiError::NotFound)?
                .number;
            let bytes =
                giftaid::schedule::for_claim(r, &id, template)?.ok_or(ApiError::NotFound)?;
            Ok((bytes, number))
        })
        .await?;
    Ok(attachment(
        "application/vnd.oasis.opendocument.spreadsheet",
        format!("gift-aid-claim-{number}.ods"),
        bytes,
    ))
}

/// `GET giftaid/claims/{id}/xml`: the claim as HMRC's claim XML, IRmark
/// stamped; `X-IRmark` carries its base32 form. `422 rejected
/// {reason: missing_hmrc_details}` until the HMRC details are complete.
async fn xml(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Response, ApiError> {
    t.require_admin()?;
    let org = t.name.clone();
    let (xml, mark, number) = t
        .read(move |r| {
            let number = giftaid::claims::summary(r, &id)?
                .ok_or(ApiError::NotFound)?
                .number;
            let env = Envelope::generated(contracts::now_ms());
            let (xml, mark) = giftaid::xml::for_claim(r, &id, &org, &env)?;
            Ok((xml, mark, number))
        })
        .await?;
    let mut res = attachment(
        "application/xml",
        format!("gift-aid-claim-{number}.xml"),
        xml.into_bytes(),
    );
    if let Ok(v) = HeaderValue::from_str(&mark.base32) {
        res.headers_mut().insert("x-irmark", v);
    }
    Ok(res)
}

/// `GET giftaid/hmrc-details`: the details, their counter and what HMRC
/// would refuse (warnings).
async fn details(Extension(t): Extension<Tenant>) -> Result<Json<HmrcDetailsView>, ApiError> {
    t.require_admin()?;
    t.read(|r| Ok(giftaid::hmrc::view(r)?)).await.map(Json)
}

/// `POST giftaid/hmrc-details {expected?, …details}`: `expected` absent
/// before the first save; `409 stale`.
async fn save_details(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveHmrcDetails>,
) -> Result<Json<Executed>, ApiError> {
    t.require_admin()?;
    t.write(move |ctx| {
        Ok(giftaid::hmrc::save(
            ctx,
            req.details,
            req.expected,
            Source::Ui,
        )?)
    })
    .await
    .map(Json)
}
