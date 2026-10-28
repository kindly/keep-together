//! `/api/t/{slug}/preferences`: the three "staff can manage …" switches
//! (`convex/platform/preferences.ts`). Everyone reads them; only admins
//! switch them.

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Executed, Source};
use platform::preferences::{self, ListKind, Preferences};
use serde::Deserialize;
use ts_rs::TS;

use crate::{ApiError, Body, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/preferences", get(read))
        .route("/preferences/{kind}", post(set))
}

/// `GET preferences`
async fn read(Extension(t): Extension<Tenant>) -> Result<Json<Preferences>, ApiError> {
    t.read(|r| Ok(preferences::read(r)?)).await.map(Json)
}

#[derive(Deserialize)]
struct KindParam {
    kind: String,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SetPreference {
    /// The switch's counter as last read; absent (or null) if no
    /// preference had been saved yet.
    #[serde(default)]
    #[ts(optional, type = "number | null")]
    pub expected: Option<i64>,
    pub staff_can_manage: bool,
}

/// `POST preferences/{identifierTypes|sourceCodes|fields} {expected?,
/// staffCanManage}`: admin only; a stale `expected` (or none, when a row
/// exists) is `409 stale`.
async fn set(
    Extension(t): Extension<Tenant>,
    Path(KindParam { kind }): Path<KindParam>,
    Body(req): Body<SetPreference>,
) -> Result<Json<Executed>, ApiError> {
    let kind: ListKind =
        serde_json::from_value(serde_json::Value::String(kind)).map_err(|_| ApiError::NotFound)?;
    t.require_admin()?;
    t.write(move |ctx| {
        Ok(preferences::set(
            ctx,
            kind,
            req.staff_can_manage,
            req.expected,
            Source::Ui,
        )?)
    })
    .await
    .map(Json)
}
