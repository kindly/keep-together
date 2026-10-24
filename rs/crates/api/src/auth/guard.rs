//! Request guards in front of every route.
//!
//! - [`csrf`]: a state-changing `/api` request (anything but `GET`,
//!   `HEAD`, `OPTIONS`) from a browser must come from the app's own
//!   origin. `SameSite=Lax` alone lets a sibling subdomain post with the
//!   cookie, so: `Sec-Fetch-Site` must be `same-origin` or `none`, or the
//!   `Origin` must be the app's (`KEEP_APP_ORIGIN`) or the request's own
//!   host. A request with neither header isn't from a browser (browsers
//!   send `Origin` on every cross-origin `POST`), so it can't carry a
//!   victim's cookie by itself and passes.
//! - [`dev_host`]: `/api/dev/*` only when `Host` is loopback (or absent),
//!   so a DNS-rebinding page, or Vite's proxy reached over the tailnet,
//!   can't use the dev login.

use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::{host, is_loopback_host};
use crate::AppState;
use crate::error::ApiError;

/// Whether this request may change state, by its fetch metadata and
/// origin (module docs).
pub fn same_origin(headers: &HeaderMap, app_origin: &str) -> bool {
    let origin = headers.get("origin").and_then(|v| v.to_str().ok());
    let site = headers.get("sec-fetch-site").and_then(|v| v.to_str().ok());
    if matches!(site, Some("same-origin" | "none")) {
        return true;
    }
    let Some(origin) = origin else {
        // No Origin: not a browser if Sec-Fetch-Site is absent too; a
        // browser that says same-site/cross-site without an Origin is
        // refused.
        return site.is_none();
    };
    if origin == app_origin {
        return true;
    }
    // The request's own host, over either scheme (behind a TLS proxy the
    // api sees http).
    let Some(h) = headers.get("host").and_then(|v| v.to_str().ok()) else {
        return false;
    };
    origin == format!("https://{h}") || origin == format!("http://{h}")
}

pub async fn csrf(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe
        && req.uri().path().starts_with("/api/")
        && !same_origin(req.headers(), &state.auth.config.app_origin)
    {
        return ApiError::Forbidden.into_response();
    }
    next.run(req).await
}

pub async fn dev_host(req: Request, next: Next) -> Response {
    if req.uri().path().starts_with("/api/dev/")
        && host(req.headers()).is_some_and(|h| !is_loopback_host(&h))
    {
        return ApiError::Forbidden.into_response();
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    #[test]
    fn origin_rules() {
        let app = "https://app.keep-together.org.uk";
        assert!(same_origin(&headers(&[]), app), "not a browser");
        assert!(same_origin(
            &headers(&[("sec-fetch-site", "same-origin")]),
            app
        ));
        assert!(same_origin(
            &headers(&[("origin", app), ("sec-fetch-site", "same-site")]),
            app
        ));
        assert!(!same_origin(
            &headers(&[
                ("origin", "https://evil.keep-together.org.uk"),
                ("sec-fetch-site", "same-site")
            ]),
            app
        ));
        assert!(!same_origin(
            &headers(&[("origin", "https://evil.example")]),
            app
        ));
        assert!(!same_origin(
            &headers(&[("sec-fetch-site", "cross-site")]),
            app
        ));
        assert!(same_origin(
            &headers(&[
                ("origin", "http://localhost:3000"),
                ("host", "localhost:3000")
            ]),
            app
        ));
        assert!(!same_origin(&headers(&[("origin", "null")]), app));
    }
}
