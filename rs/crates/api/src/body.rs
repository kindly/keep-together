//! Every request body is read in full, within [`BODY_TIMEOUT`] and up to a
//! size limit, before routing on (S1 codex C5, C6). A client can't hold a
//! request open by trickling its body (a write authorised at the start
//! and committed hours later, or a connection pinned), and `/api/auth/*`
//! takes no more than [`AUTH_BODY_LIMIT`]. Since the body is in hand
//! before the tenant middleware runs, its session and membership check is
//! as late as the handler's start.

use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;

/// How long a client has to send its whole body.
pub const BODY_TIMEOUT: Duration = Duration::from_secs(30);
/// Bodies of `/api/auth/*` (an email, a password, a code or a token).
pub const AUTH_BODY_LIMIT: usize = 16 * 1024;
/// Bodies elsewhere (axum's own default).
pub const BODY_LIMIT: usize = 2 * 1024 * 1024;

pub async fn buffer(req: Request, next: Next) -> Response {
    let limit = if req.uri().path().starts_with("/api/auth/") {
        AUTH_BODY_LIMIT
    } else {
        BODY_LIMIT
    };
    let (parts, body) = req.into_parts();
    match tokio::time::timeout(BODY_TIMEOUT, to_bytes(body, limit)).await {
        Err(_) => (
            StatusCode::REQUEST_TIMEOUT,
            axum::Json(serde_json::json!({ "kind": "timeout" })),
        )
            .into_response(),
        Ok(Err(_)) => ApiError::Invalid {
            problems: vec![contracts::Problem::new(
                "body",
                format!("at most {limit} bytes"),
            )],
        }
        .into_response(),
        Ok(Ok(bytes)) => {
            next.run(Request::from_parts(parts, Body::from(bytes)))
                .await
        }
    }
}
