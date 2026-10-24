//! `/api/t/{slug}/contacts…`

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::types::{
    ContactPage, ContactView, CreateContact, Created, HistoryPage, RestoreRequest, Restored,
    SaveForm, SaveFormResult, SearchResult, SetArchived,
};
use contacts::{form, queries};
use contracts::{Executed, Source};
use serde::Deserialize;

use super::Params;
use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts", get(list).post(create))
        .route("/contacts/search", get(search))
        .route("/contacts/{id}", get(contact))
        .route("/contacts/{id}/history", get(history))
        .route("/contacts/{id}/save", post(save))
        .route("/contacts/{id}/archive", post(archive))
        .route("/contacts/{id}/restore", post(restore))
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
        let limit = q.limit.unwrap_or(queries::HISTORY_PAGE_LIMIT);
        Ok(queries::history(r, &id, q.before, limit)?)
    })
    .await
    .map(Json)
}

/// `POST contacts`: details only; a duplicate `clientKey` or `id` is
/// `409 duplicate {id}`.
async fn create(
    Extension(t): Extension<Tenant>,
    Body(req): Body<CreateContact>,
) -> Result<Json<Created>, ApiError> {
    t.write(move |ctx| Ok(form::create(ctx, req, Source::Ui)?))
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
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| Ok(form::set_archived(ctx, &id, req.expected, req.archived)?))
        .await
        .map(Json)
}

/// `POST contacts/{id}/restore {revisionId} | {at}`
async fn restore(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
    Body(req): Body<RestoreRequest>,
) -> Result<Json<Restored>, ApiError> {
    t.write(move |ctx| Ok(form::restore_contact(ctx, &id, req)?))
        .await
        .map(Json)
}
