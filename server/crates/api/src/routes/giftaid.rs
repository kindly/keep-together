//! `/api/t/{slug}/…giftaid…`: the contact page's Gift Aid panel. Viewers
//! read; staff and admins record declarations, complete their details,
//! cancellations and voids.
//! The record-gift save (`gifts.rs`) makes the tick's declaration in its
//! own transaction; `POST contacts/{id}/giftaid` is Convex's `declare`, a
//! declaration on its own (imports, QC set-up).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Executed, Source};
use giftaid::types::{
    Cancelled, DeclarationPayload, Declarations, DetailsHistory, RecordCancellation,
    SaveDeclarationDetails, VoidPayload,
};
use serde::Deserialize;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts/{id}/giftaid", get(by_contact).post(declare))
        .route("/contacts/{id}/giftaid/cancel", post(cancel))
        .route("/giftaid/{id}/void", post(void))
        .route("/giftaid/{id}/details", post(details))
        .route("/giftaid/{id}/history", get(history))
}

#[derive(Deserialize)]
struct TodayQuery {
    today: String,
}

/// `GET contacts/{id}/giftaid?today`: the contact's declarations, newest
/// made first with their warnings, and the one current on `today` (the
/// caller's date).
async fn by_contact(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<TodayQuery>,
) -> Result<Json<Declarations>, ApiError> {
    iso_date("today", &q.today)?;
    t.read(move |r| {
        if contacts::donors::kind_of(r, &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        Ok(giftaid::by_contact(r, &id, &q.today)?)
    })
    .await
    .map(Json)
}

/// A query's date: coverage compares ISO dates as strings, so anything
/// else would answer wrongly rather than fail. `422 invalid` instead.
pub(super) fn iso_date(field: &str, value: &str) -> Result<(), ApiError> {
    if giftaid::is_iso_date(value) {
        Ok(())
    } else {
        Err(ApiError::Invalid {
            problems: vec![contracts::Problem::new(field, "A date, YYYY-MM-DD")],
        })
    }
}

/// `POST contacts/{id}/giftaid {…declaration}`: a declaration as made
/// (the path's contact; the body's `contactId` must match it).
async fn declare(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<DeclarationPayload>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        if req.contact_id != id {
            return Err(ApiError::Invalid {
                problems: vec![contracts::Problem::new(
                    "contactId",
                    "The declaration's contact is the one in the path",
                )],
            });
        }
        Ok(giftaid::make_declaration(ctx, req, Source::Ui, None)?)
    })
    .await
    .map(Json)
}

/// `POST contacts/{id}/giftaid/cancel {cancelledFrom, note?}`: cancels
/// every declaration open at that date, in one group; `422` when none is.
async fn cancel(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<RecordCancellation>,
) -> Result<Json<Cancelled>, ApiError> {
    t.write(move |ctx| {
        if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        Ok(giftaid::cancel_declarations(
            ctx,
            &id,
            &req.cancelled_from,
            req.note,
            Source::Ui,
        )?)
    })
    .await
    .map(Json)
}

/// `POST giftaid/{id}/void {reason}`: made in error; `422 rejected
/// {reason: immutable}` when already voided.
async fn void(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<VoidPayload>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| Ok(giftaid::void_declaration(ctx, &id, req.reason, Source::Ui)?))
        .await
        .map(Json)
}

/// `POST giftaid/{id}/details {expected, firstName, lastName,
/// addressLine1, postcode}`: the snapshot completed or corrected; `409
/// stale` with the snapshot now, `422 rejected {reason: voided}` on a
/// voided declaration.
async fn details(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SaveDeclarationDetails>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        Ok(giftaid::save_details(
            ctx,
            &id,
            req.expected,
            req.details,
            Source::Ui,
        )?)
    })
    .await
    .map(Json)
}

/// `GET giftaid/{id}/history`: the snapshot's changes, newest first, who
/// and when, old → new.
async fn history(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<DetailsHistory>, ApiError> {
    t.read(move |r| giftaid::details_history(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}
