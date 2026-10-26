//! `POST /address-lookup {postcode}`: the addresses at a UK postcode, for
//! the contact form's "Find address" ([`crate::address`]). Staff and
//! admins. A `POST` because it spends: each lookup is counted against the
//! group's month in `platform.db`, so it goes through the write guards
//! (same origin, no viewers). Reads nothing from the org file and writes
//! nothing to it; the answer is `Cache-Control: no-store` (PAF terms).

use axum::http::header;
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::Deserialize;

use crate::address::AddressLookupResult;
use crate::{ApiError, Body, Tenant};

pub fn router() -> Router {
    Router::new().route("/address-lookup", post(lookup))
}

#[derive(Deserialize)]
struct Lookup {
    postcode: String,
}

async fn lookup(Extension(t): Extension<Tenant>, Body(q): Body<Lookup>) -> impl IntoResponse {
    let out: Result<_, ApiError> = t
        .lookup_address(&q.postcode)
        .await
        .map(|addresses| Json(AddressLookupResult { addresses }));
    ([(header::CACHE_CONTROL, "no-store")], out)
}
