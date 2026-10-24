//! JSON errors. Every non-2xx response from `/api` is an [`ApiError`]
//! body, tagged by `kind`.

use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use contracts::{ContractError, Problem};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use store::StoreError;
use ts_rs::TS;

#[derive(Debug, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum ApiError {
    /// 401: no valid session.
    Unauthenticated,
    /// 403: not a member of this organisation (or unknown slug: the two
    /// look the same), or the role can't do this.
    Forbidden,
    /// 403: an admin-only action needs a sign-in within the last hour;
    /// step up (`POST /api/auth/step-up`) and retry.
    StepUpRequired,
    /// 404
    NotFound,
    /// 409: the slice changed since the caller read `expected`. `current`
    /// is the slice's state now; merge it and retry with `counter`.
    Stale {
        contract: String,
        #[ts(type = "number")]
        counter: i64,
        #[ts(type = "unknown")]
        current: Value,
    },
    /// 409: a create with a pre-generated id that already exists.
    Duplicate { id: String },
    /// 422: unstorable or invariant-breaking input (ADR 0015 tier 1).
    Invalid { problems: Vec<Problem> },
    /// 422: the handler refused the command (e.g. identity_immutable).
    Rejected { reason: String, message: String },
    /// 429: too many attempts; try again later.
    RateLimited,
    /// 500. Details go to the server log, not the client.
    Internal,
}

impl ApiError {
    fn status(&self) -> StatusCode {
        match self {
            ApiError::Unauthenticated => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden | ApiError::StepUpRequired => StatusCode::FORBIDDEN,
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::Stale { .. } | ApiError::Duplicate { .. } => StatusCode::CONFLICT,
            ApiError::Invalid { .. } | ApiError::Rejected { .. } => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            ApiError::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            ApiError::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        eprintln!("internal error: {err}");
        ApiError::Internal
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status(), Json(self)).into_response()
    }
}

impl From<ContractError> for ApiError {
    fn from(err: ContractError) -> Self {
        match err {
            ContractError::Stale {
                contract,
                counter,
                current,
            } => ApiError::Stale {
                contract: contract.into(),
                counter,
                current,
            },
            ContractError::NotFound => ApiError::NotFound,
            ContractError::Duplicate { id } => ApiError::Duplicate { id },
            ContractError::Invalid(problems) => ApiError::Invalid { problems },
            ContractError::Rejected { reason, message } => ApiError::Rejected { reason, message },
            other => ApiError::internal(other),
        }
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(err: rusqlite::Error) -> Self {
        ApiError::internal(err)
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::InvalidSlug(_) => ApiError::Invalid {
                problems: vec![Problem::new(
                    "slug",
                    "lower-case letters, digits and hyphens",
                )],
            },
            StoreError::SlugTaken(_) => ApiError::Invalid {
                problems: vec![Problem::new("slug", "taken")],
            },
            other => ApiError::internal(other),
        }
    }
}

/// A JSON request body whose rejection is an [`ApiError::Invalid`], not
/// axum's plain-text 4xx. Use it instead of `axum::Json` for inputs.
pub struct Body<T>(pub T);

impl<T: DeserializeOwned, S: Send + Sync> FromRequest<S> for Body<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(Body(value)),
            Err(rejection) => Err(ApiError::Invalid {
                problems: vec![Problem::new("", body_message(&rejection))],
            }),
        }
    }
}

fn body_message(rejection: &JsonRejection) -> String {
    rejection.body_text()
}
