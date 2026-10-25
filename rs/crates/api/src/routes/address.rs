//! `GET /address-lookup?postcode=…`: the addresses at a UK postcode, for
//! the contact form's "Find address" ([`crate::address`]). Staff and
//! admins; reads nothing from the org file and writes nothing to it.

use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;

use super::Params;
use crate::address::AddressLookupResult;
use crate::{ApiError, Tenant};

pub fn router() -> Router {
    Router::new().route("/address-lookup", get(lookup))
}

#[derive(Deserialize)]
struct Query {
    postcode: String,
}

async fn lookup(
    Extension(t): Extension<Tenant>,
    Params(q): Params<Query>,
) -> Result<Json<AddressLookupResult>, ApiError> {
    let addresses = t.lookup_address(&q.postcode).await?;
    Ok(Json(AddressLookupResult { addresses }))
}
