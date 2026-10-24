//! `/api/t/{slug}/…relationship…`: relationships between contacts and
//! their types. Backend only: no page uses them yet.

use axum::extract::Path;
use axum::routing::get;
use axum::{Extension, Json, Router};
use contacts::relationships::{
    RELATIONSHIP, RELATIONSHIP_TYPE, RelationshipType, RelationshipView, SaveRelationship,
    SaveRelationshipType, relationship_types, relationships_for,
};
use contracts::{Exec, Executed, Source, execute};

use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/relationship-types", get(types).post(save_type))
        .route("/relationships", axum::routing::post(save))
        .route("/contacts/{id}/relationships", get(for_contact))
}

fn exec(id: &Option<String>, expected: Option<i64>) -> Exec<'_> {
    match id {
        Some(id) => Exec::update(id, Some(expected.unwrap_or(-1)), Source::Ui),
        None => Exec::create(Source::Ui),
    }
}

/// `GET relationship-types`
async fn types(Extension(t): Extension<Tenant>) -> Result<Json<Vec<RelationshipType>>, ApiError> {
    t.read(|r| Ok(relationship_types(r)?)).await.map(Json)
}

/// `POST relationship-types {id?, expected?, labelAB, labelBA, kindA?, kindB?, isActive}`
async fn save_type(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveRelationshipType>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        Ok(execute(
            ctx,
            &RELATIONSHIP_TYPE,
            req.payload,
            exec(&req.id, req.expected),
        )?)
    })
    .await
    .map(Json)
}

/// `POST relationships {id?, expected?, contactA, contactB, typeId, …}`
async fn save(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveRelationship>,
) -> Result<Json<Executed>, ApiError> {
    t.write(move |ctx| {
        Ok(execute(
            ctx,
            &RELATIONSHIP,
            req.payload,
            exec(&req.id, req.expected),
        )?)
    })
    .await
    .map(Json)
}

/// `GET contacts/{id}/relationships`: both directions, as seen from it.
async fn for_contact(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<Vec<RelationshipView>>, ApiError> {
    t.read(move |r| {
        let found: bool = r.query_row(
            "SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if !found {
            return Err(ApiError::NotFound);
        }
        Ok(relationships_for(r, &id)?)
    })
    .await
    .map(Json)
}
