//! Comms on the contact page: which of a contact's addresses are on hold
//! (with "also used by", one request: both are about its saved emails),
//! and an admin's release of a hold.

use std::collections::BTreeMap;

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use comms::{Hold, Release};
use contacts::queries::{Sharers, also_used_by, email_addresses};
use contacts::slices::load_methods;
use contracts::Executed;
use serde::Serialize;
use store::Role;
use ts_rs::TS;

use crate::{ApiError, Body, IdParam, Tenant};

pub fn router() -> Router {
    Router::new()
        .route("/contacts/{id}/email-context", get(email_context))
        .route("/comms/release", post(release))
}

/// `GET contacts/{id}/email-context`: advisory, so the form asks for it
/// after the contact, off a save's critical path.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EmailContext {
    /// Per saved email row (by key) that another contact also uses.
    pub also_used_by: BTreeMap<String, Sharers>,
    /// The held addresses, keyed by normalised address.
    pub held: BTreeMap<String, Hold>,
}

async fn email_context(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<EmailContext>, ApiError> {
    t.read(move |r| {
        let found: bool = r.query_row(
            "SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?1)",
            [&id],
            |row| row.get(0),
        )?;
        if !found {
            return Err(ApiError::NotFound);
        }
        let methods = load_methods(r, &id)?;
        Ok(EmailContext {
            also_used_by: also_used_by(r, &id, &methods)?,
            held: comms::held(r, &email_addresses(r, &id)?)?,
        })
    })
    .await
    .map(Json)
}

/// `POST comms/release {address, expected, note}`: admins only. Lifts our
/// suppression; after the commit, tells the provider.
async fn release(
    Extension(t): Extension<Tenant>,
    Body(req): Body<Release>,
) -> Result<Json<Executed>, ApiError> {
    if t.role < Role::Admin {
        return Err(ApiError::Forbidden);
    }
    let address = req.address.clone();
    let done = t.write(move |ctx| Ok(comms::release(ctx, req)?)).await?;
    comms::release_at_provider(&address);
    Ok(Json(done))
}
