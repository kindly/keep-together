//! `/api/t/{slug}/fields…`: dropdown field definitions. Managing them is
//! for admins; setting a contact's values is ordinary staff editing.

use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contacts::fields::{FIELD, FIELD_OPTION, definitions};
use contacts::types::{FieldDefinition, SaveField, SaveFieldOption};
use contracts::{Exec, Executed, Source, execute};
use store::Role;

use crate::{ApiError, Body, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/fields", get(list).post(save_field))
        .route("/fields/options", post(save_option))
}

/// `GET fields`: every field with its options, archived included.
async fn list(Extension(t): Extension<Tenant>) -> Result<Json<Vec<FieldDefinition>>, ApiError> {
    t.read(|r| Ok(definitions(r)?)).await.map(Json)
}

fn exec(id: &Option<String>, expected: Option<i64>) -> Exec<'_> {
    match id {
        Some(id) => Exec::update(id, Some(expected.unwrap_or(-1)), Source::Ui),
        None => Exec::create(Source::Ui),
    }
}

/// `POST fields {id?, expected?, label, appliesTo, isActive}`
async fn save_field(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveField>,
) -> Result<Json<Executed>, ApiError> {
    if t.role < Role::Admin {
        return Err(ApiError::Forbidden);
    }
    t.write(move |ctx| Ok(execute(ctx, &FIELD, req.payload, exec(&req.id, req.expected))?))
        .await
        .map(Json)
}

/// `POST fields/options {id?, expected?, fieldId, label, position, isActive}`
async fn save_option(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveFieldOption>,
) -> Result<Json<Executed>, ApiError> {
    if t.role < Role::Admin {
        return Err(ApiError::Forbidden);
    }
    t.write(move |ctx| {
        Ok(execute(ctx, &FIELD_OPTION, req.payload, exec(&req.id, req.expected))?)
    })
    .await
    .map(Json)
}
