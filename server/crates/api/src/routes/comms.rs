//! Comms on the contact page: which of a contact's addresses are on hold
//! (with "also used by", one request: both are about its saved emails),
//! and an admin's release of a hold, which answers the context of the
//! contact it was made from.

use std::collections::BTreeMap;

use axum::extract::Path;
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use comms::{Hold, Release};
use contacts::queries::{Sharers, also_used_by, email_addresses};
use contacts::slices::load_methods;
use contracts::Executed;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use store::Role;
use ts_rs::TS;

use super::Params;
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

/// A contact's email context; None if there's no such contact.
fn context_of(r: &Connection, id: &str) -> Result<Option<EmailContext>, ApiError> {
    let found: bool = r.query_row(
        "SELECT EXISTS (SELECT 1 FROM contacts WHERE id = ?1)",
        [id],
        |row| row.get(0),
    )?;
    if !found {
        return Ok(None);
    }
    let methods = load_methods(r, id)?;
    Ok(Some(EmailContext {
        also_used_by: also_used_by(r, id, &methods)?,
        held: comms::held(r, &email_addresses(r, id)?)?,
    }))
}

async fn email_context(
    Extension(t): Extension<Tenant>,
    Path(IdParam { id }): Path<IdParam>,
) -> Result<Json<EmailContext>, ApiError> {
    t.read(move |r| context_of(r, &id)?.ok_or(ApiError::NotFound))
        .await
        .map(Json)
}

#[derive(Deserialize)]
struct ReleaseQuery {
    /// The contact page the release was made from.
    contact: Option<String>,
}

/// A release's answer: what it executed, and the email context of the
/// contact it was made from (`?contact`) as `GET contacts/{id}/
/// email-context` answers it after the release; null without one, or for
/// an unknown contact (the release still stands).
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Released {
    pub id: String,
    #[ts(type = "number")]
    pub counter: i64,
    pub context: Option<EmailContext>,
}

/// `POST comms/release?contact {address, expected, note}`: admins only.
/// Lifts our suppression; after the commit, tells the provider.
async fn release(
    Extension(t): Extension<Tenant>,
    Params(q): Params<ReleaseQuery>,
    Body(req): Body<Release>,
) -> Result<Json<Released>, ApiError> {
    if t.role < Role::Admin {
        return Err(ApiError::Forbidden);
    }
    let address = req.address.clone();
    let done = t
        .write(move |ctx| {
            let Executed { id, counter } = comms::release(ctx, req)?;
            let context = match &q.contact {
                Some(contact) => context_of(ctx.tx.read(), contact)?,
                None => None,
            };
            Ok(Released {
                id,
                counter,
                context,
            })
        })
        .await?;
    comms::release_at_provider(&address);
    Ok(Json(done))
}
