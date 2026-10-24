//! `/api/t/{slug}/…giftaid…`: the contact page's Gift Aid panel. Viewers
//! read; staff and admins record declarations, cancellations and voids.
//! The record-gift save (`gifts.rs`) makes the tick's declaration in its
//! own transaction; `POST contacts/{id}/giftaid` is Convex's `declare`, a
//! declaration on its own (imports, QC set-up).

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Executed, Source};
use giftaid::types::{
    Cancelled, DeclarationPayload, Declarations, RecordCancellation, VoidPayload,
};
use serde::Deserialize;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts/{id}/giftaid", get(by_contact).post(declare))
        .route("/contacts/{id}/giftaid/cancel", post(cancel))
        .route("/giftaid/{id}/void", post(void))
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
