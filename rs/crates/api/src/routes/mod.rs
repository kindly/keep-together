//! The domain routes under `/api/t/{slug}`: a stateless `Router` whose
//! handlers get a [`Tenant`](crate::Tenant) and nothing else.

mod comms;
mod contacts;
pub mod fields;
pub mod groups;
mod identifiers;
mod notes;
mod preferences;
pub mod qc_seed;
mod relationships;
mod sources;

use axum::Router;
use axum::extract::rejection::QueryRejection;
use axum::extract::{FromRequestParts, Query};
use axum::http::request::Parts;
use contracts::Problem;
use serde::de::DeserializeOwned;

use crate::ApiError;

pub fn router() -> Router {
    Router::new()
        .merge(contacts::router())
        .merge(fields::router())
        .merge(preferences::router())
        .merge(identifiers::router())
        .merge(notes::router())
        .merge(relationships::router())
        .merge(comms::router())
        .merge(sources::router())
}

/// A query string whose rejection is an [`ApiError::Invalid`], like
/// [`crate::Body`] for bodies.
pub struct Params<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequestParts<S> for Params<T> {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, ApiError> {
        match Query::<T>::from_request_parts(parts, state).await {
            Ok(Query(value)) => Ok(Params(value)),
            Err(rejection) => Err(ApiError::Invalid {
                problems: vec![Problem::new("", message(&rejection))],
            }),
        }
    }
}

fn message(rejection: &QueryRejection) -> String {
    rejection.body_text()
}
