//! `/api/t/{slug}/…giftaid…`: the contact page's Gift Aid panel. Viewers
//! read; staff and admins record declarations, complete their details,
//! cancellations and voids.
//! The record-gift save (`gifts.rs`) makes the tick's declaration in its
//! own transaction; `POST contacts/{id}/giftaid` is Convex's `declare`, a
//! declaration on its own (imports, QC set-up).
//!
//! The panel's writes take the panel's `?today` and answer its read for
//! that date with what they did, read in the same transaction: the panel
//! shows the answer, with no read after it.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Executed, Source};
use giftaid::types::{
    Cancelled, DeclarationPayload, Declarations, DetailsHistory, RecordCancellation,
    SaveDeclarationDetails, VoidPayload,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

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

/// A panel write's `?today`: optional, for callers that show no panel.
#[derive(Deserialize)]
struct PanelQuery {
    today: Option<String>,
}

/// A panel write's answer: what it did, and the contact's declarations as
/// `GET contacts/{id}/giftaid?today` answers them after it (null when no
/// `today` was sent).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PanelSaved<T> {
    pub done: T,
    pub declarations: Option<Declarations>,
}

fn panel<T>(
    conn: &Connection,
    contact_id: &str,
    today: Option<&str>,
    done: T,
) -> Result<PanelSaved<T>, ApiError> {
    Ok(PanelSaved {
        done,
        declarations: match today {
            Some(today) => Some(giftaid::by_contact(conn, contact_id, today)?),
            None => None,
        },
    })
}

/// The contact a declaration belongs to; 404 if there's none.
fn contact_of(conn: &Connection, declaration: &str) -> Result<String, ApiError> {
    giftaid::declarations::load(conn, declaration)?
        .map(|d| d.payload.contact_id)
        .ok_or(ApiError::NotFound)
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

/// `POST contacts/{id}/giftaid/cancel?today {cancelledFrom, note?}`: cancels
/// every declaration open at that date, in one group; `422` when none is.
async fn cancel(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<PanelQuery>,
    Body(req): Body<RecordCancellation>,
) -> Result<Json<PanelSaved<Cancelled>>, ApiError> {
    if let Some(today) = &q.today {
        iso_date("today", today)?;
    }
    t.write(move |ctx| {
        if contacts::donors::kind_of(ctx.tx.read(), &id)?.is_none() {
            return Err(ApiError::NotFound);
        }
        let done =
            giftaid::cancel_declarations(ctx, &id, &req.cancelled_from, req.note, Source::Ui)?;
        panel(ctx.tx.read(), &id, q.today.as_deref(), done)
    })
    .await
    .map(Json)
}

/// `POST giftaid/{id}/void?today {reason}`: made in error; `422 rejected
/// {reason: immutable}` when already voided.
async fn void(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<PanelQuery>,
    Body(req): Body<VoidPayload>,
) -> Result<Json<PanelSaved<Executed>>, ApiError> {
    if let Some(today) = &q.today {
        iso_date("today", today)?;
    }
    t.write(move |ctx| {
        let done = giftaid::void_declaration(ctx, &id, req.reason, Source::Ui)?;
        let contact = contact_of(ctx.tx.read(), &id)?;
        panel(ctx.tx.read(), &contact, q.today.as_deref(), done)
    })
    .await
    .map(Json)
}

/// `POST giftaid/{id}/details?today {expected, firstName, lastName,
/// addressLine1, postcode}`: the snapshot completed or corrected; `409
/// stale` with the snapshot now, `422 rejected {reason: voided}` on a
/// voided declaration.
async fn details(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<PanelQuery>,
    Body(req): Body<SaveDeclarationDetails>,
) -> Result<Json<PanelSaved<Executed>>, ApiError> {
    if let Some(today) = &q.today {
        iso_date("today", today)?;
    }
    t.write(move |ctx| {
        let done = giftaid::save_details(ctx, &id, req.expected, req.details, Source::Ui)?;
        let contact = contact_of(ctx.tx.read(), &id)?;
        panel(ctx.tx.read(), &contact, q.today.as_deref(), done)
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
