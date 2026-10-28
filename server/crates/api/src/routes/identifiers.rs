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

use platform::{ListKind, may_manage_list};

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
///
/// The list-manager check is here, in the route, not in the contract (as
/// Convex's `managesList` was, on every path, restore included). Nothing
/// else runs `contacts.identifierType` for a user today: contact restore
/// takes only `contacts` revisions. A route that restores or otherwise
/// executes a list entry's contract (identifier types, source codes,
/// fields) must make the same `may_manage_list` check.
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
