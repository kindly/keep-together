//! `/api/t/{slug}/contacts…`

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::acquisition::{NewContact, create_contact};
use contacts::types::{
    ContactPage, ContactView, HistoryPage, RestoreRequest, SaveForm, SaveFormResult, SearchResult,
    SetArchived,
};
use contacts::{form, queries};
use contracts::Source;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts", get(list).post(create))
        .route("/contacts/search", get(search))
        .route("/contacts/by-client-key/{key}", get(by_client_key))
        .route("/contacts/{id}", get(contact))
        .route("/contacts/{id}/history", get(history))
        .route("/contacts/{id}/save", post(save))
        .route("/contacts/{id}/archive", post(archive))
        .route("/contacts/{id}/restore", post(restore))
}

/// `POST contacts`: the new contact and its view, so the page opens
/// without another round trip.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CreatedContact {
    pub id: String,
    #[ts(type = "number")]
    pub number: i64,
    pub view: ContactView,
}

/// `POST contacts/{id}/archive`: the archive slice's new counter and the
/// contact's view.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArchivedContact {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
    pub view: ContactView,
}

/// `POST contacts/{id}/restore`: what ran, and the contact's view after.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RestoredContact {
    /// The contracts that ran (empty: already in that state).
    pub restored: Vec<String>,
    pub view: ContactView,
}

/// The contact's view inside the write that changed it.
fn view(conn: &Connection, id: &str) -> Result<ContactView, ApiError> {
    queries::get(conn, id)?.ok_or(ApiError::NotFound)
}

/// `GET contacts?includeArchived&kind&fields&cursor&limit`
async fn list(
    Extension(t): Extension<Tenant>,
    Params(q): Params<queries::ListQuery>,
) -> Result<Json<ContactPage>, ApiError> {
    Ok(Json(t.read(move |r| Ok(queries::list(r, &q)?)).await?))
}

/// `GET contacts/search?q&includeArchived&kind&fields&fts`
async fn search(
    Extension(t): Extension<Tenant>,
    Params(q): Params<queries::SearchQuery>,
) -> Result<Json<SearchResult>, ApiError> {
    Ok(Json(t.read(move |r| Ok(queries::search(r, &q)?)).await?))
}

/// `GET contacts/{id}`
async fn contact(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<ContactView>, ApiError> {
    t.read(move |r| queries::get(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct KeyParam {
    key: String,
}

/// `GET contacts/by-client-key/{key}`: the contact a new-contact form
/// created with this `clientKey`; 404 until it exists.
async fn by_client_key(
    Extension(t): Extension<Tenant>,
    Path(KeyParam { key }): Path<KeyParam>,
) -> Result<Json<ContactView>, ApiError> {
    t.read(move |r| {
        let id = queries::by_client_key(r, &key)?.ok_or(ApiError::NotFound)?;
        view(r, &id)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
struct HistoryQuery {
    before: Option<i64>,
    limit: Option<usize>,
}

/// `GET contacts/{id}/history?before&limit`: newest first.
async fn history(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Params(q): Params<HistoryQuery>,
) -> Result<Json<HistoryPage>, ApiError> {
    t.read(move |r| {
        let exists: bool = r.query_row(
            "SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(ApiError::NotFound);
        }
        let limit = q.limit.unwrap_or(queries::HISTORY_PAGE_LIMIT);
        Ok(queries::history(r, &id, q.before, limit)?)
    })
    .await
    .map(Json)
}

/// `POST contacts`: details, and an acquisition code (A2) when the form
/// picked one; a duplicate `clientKey` or `id` is `409 duplicate {id}`.
async fn create(
    Extension(t): Extension<Tenant>,
    Body(req): Body<NewContact>,
) -> Result<Json<CreatedContact>, ApiError> {
    t.write(move |ctx| {
        let created = create_contact(ctx, req, Source::Ui)?;
        Ok(CreatedContact {
            view: view(ctx.tx.read(), &created.id)?,
            id: created.id,
            number: created.number,
        })
    })
    .await
    .map(Json)
}

/// `POST contacts/{id}/save`: the form. Stale and invalid slices come back
/// in the 200 body (`stale` + `current`, `problems`) while the rest save.
async fn save(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SaveForm>,
) -> Result<Json<SaveFormResult>, ApiError> {
    t.write(move |ctx| Ok(form::save_form(ctx, &id, req)?))
        .await
        .map(Json)
}

/// `POST contacts/{id}/archive {expected, archived}`: `409 stale` on a
/// counter mismatch.
async fn archive(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<SetArchived>,
) -> Result<Json<ArchivedContact>, ApiError> {
    t.write(move |ctx| {
        let done = form::set_archived(ctx, &id, req.expected, req.archived)?;
        Ok(ArchivedContact {
            view: view(ctx.tx.read(), &done.id)?,
            id: done.id,
            counter: done.counter,
        })
    })
    .await
    .map(Json)
}

/// `POST contacts/{id}/restore {revisionId} | {at}`
async fn restore(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<RestoreRequest>,
) -> Result<Json<RestoredContact>, ApiError> {
    t.write(move |ctx| {
        let done = form::restore_contact(ctx, &id, req)?;
        Ok(RestoredContact {
            restored: done.restored,
            view: view(ctx.tx.read(), &id)?,
        })
    })
    .await
    .map(Json)
}
