//! `/api/t/{slug}/identifier-types…`: the organisation's identifier types.
//! Any member reads them; admins manage them, and staff too while the
//! organisation's "staff can manage identifier types" switch is on.
//! Putting identifiers on a contact is ordinary staff editing (the form).

use axum::routing::get;
use axum::{Extension, Json, Router};
use contacts::identifiers::{
    IDENTIFIER_TYPE, IdentifierType, SaveIdentifierType, identifier_types,
};
use contracts::{ContractError, Exec, Executed, Source, execute};
use serde::Deserialize;

use super::Params;
use crate::{ApiError, Body, Tenant};

// TODO(A3): replace with `use platform::{ListKind, may_manage_list};`
// once port/a3 merges (same signature; Role becomes `platform::Role`).
use stub::{ListKind, may_manage_list};

mod stub {
    use rusqlite::Connection;
    use store::Role;

    pub enum ListKind {
        IdentifierTypes,
    }

    /// lib/lists.ts `mayManageList`: admin → yes; staff → the list's
    /// switch, which is off until A3 brings the preferences; viewer → no.
    pub fn may_manage_list(
        _conn: &Connection,
        role: Role,
        kind: ListKind,
    ) -> rusqlite::Result<bool> {
        let ListKind::IdentifierTypes = kind;
        Ok(role == Role::Admin)
    }
}

pub fn router() -> Router {
    Router::new().route("/identifier-types", get(list).post(save))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListQuery {
    #[serde(default)]
    include_inactive: bool,
}

/// `GET identifier-types?includeInactive`: alphabetical; archived ones
/// only when asked (the settings page). Never truncated.
async fn list(
    Extension(t): Extension<Tenant>,
    Params(q): Params<ListQuery>,
) -> Result<Json<Vec<IdentifierType>>, ApiError> {
    t.read(move |r| Ok(identifier_types(r, q.include_inactive)?))
        .await
        .map(Json)
}

/// `POST identifier-types {id?, expected?, name, isActive}`: create, or
/// rename / archive / reactivate. Never deleted.
async fn save(
    Extension(t): Extension<Tenant>,
    Body(req): Body<SaveIdentifierType>,
) -> Result<Json<Executed>, ApiError> {
    let role = t.role;
    t.write(move |ctx| {
        if !may_manage_list(ctx.tx.read(), role, ListKind::IdentifierTypes)? {
            return Err(ApiError::Forbidden);
        }
        let opts = match &req.id {
            Some(id) => {
                let Some(expected) = req.expected else {
                    return Err(ContractError::invalid(
                        "expected",
                        "An update needs the version it edits",
                    )
                    .into());
                };
                Exec::update(id, Some(expected), Source::Ui)
            }
            None => Exec::create(Source::Ui),
        };
        Ok(execute(ctx, &IDENTIFIER_TYPE, req.payload, opts)?)
    })
    .await
    .map(Json)
}
