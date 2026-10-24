//! The built SPA (`dist/`), served by the API from the same origin so the
//! session cookie needs no CORS. On when `KEEP_STATIC_DIR` is set (the
//! image sets it); in dev Vite serves the SPA and proxies `/api` instead.
//!
//! Any path that isn't a file gets `index.html` (the router resolves it in
//! the browser), except `/api/*` and `/healthz`, which answer a JSON 404:
//! a mistyped API call must never come back as a 200 HTML page.

use std::path::{Path, PathBuf};

use axum::Router;
use axum::extract::Request;
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::ApiError;

/// `router` plus the SPA from `dir` for every path it doesn't route.
pub fn with_static(router: Router, dir: impl Into<PathBuf>) -> Router {
    let dir = dir.into();
    router.fallback(move |req: Request| serve(dir.clone(), req))
}

/// `KEEP_STATIC_DIR`, if set.
pub fn dir_from_env() -> Option<PathBuf> {
    std::env::var_os("KEEP_STATIC_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn never_falls_back(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/") || path == "/healthz"
}

async fn serve(dir: PathBuf, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    if never_falls_back(&path) {
        return ApiError::NotFound.into_response();
    }
    // A missing chunk under assets/ (an old tab after a deploy) is a 404,
    // not index.html served as JavaScript.
    let served = if path.starts_with("/assets/") {
        ServeDir::new(&dir).oneshot(req).await
    } else {
        ServeDir::new(&dir)
            .fallback(ServeFile::new(index(&dir)))
            .oneshot(req)
            .await
    };
    let mut res = match served {
        Ok(res) => res.into_response(),
        Err(never) => match never {},
    };
    // Vite fingerprints everything under assets/, so those can be cached
    // for good; anything else (index.html above all) is revalidated, so a
    // deploy is picked up on the next load.
    let cache = if path.starts_with("/assets/") && res.status().is_success() {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    res.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}

fn index(dir: &Path) -> PathBuf {
    dir.join("index.html")
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::StatusCode;
    use axum::routing::get;
    use http_body_util::BodyExt;

    use super::*;

    fn app(dir: &Path) -> Router {
        let api = Router::new().route("/api/me", get(|| async { "me" }));
        with_static(api, dir)
    }

    async fn get_path(app: Router, path: &str) -> (StatusCode, String, String) {
        let res = app
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let cache = res
            .headers()
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap().to_owned())
            .unwrap_or_default();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        (status, cache, String::from_utf8_lossy(&body).into_owned())
    }

    /// `<tmp>/dist` with an index and one asset, and `<tmp>/secret.txt`
    /// beside it.
    struct Dist(tempfile::TempDir);

    impl Dist {
        fn path(&self) -> PathBuf {
            self.0.path().join("dist")
        }
    }

    fn dist() -> Dist {
        let tmp = tempfile::tempdir().unwrap();
        let dist = tmp.path().join("dist");
        std::fs::create_dir_all(dist.join("assets")).unwrap();
        std::fs::write(dist.join("index.html"), "<html>spa</html>").unwrap();
        std::fs::write(dist.join("assets/app-abc123.js"), "js").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "s").unwrap();
        Dist(tmp)
    }

    #[tokio::test]
    async fn files_are_served_and_assets_cached_for_good() {
        let tmp = dist();
        let (status, cache, body) = get_path(app(&tmp.path()), "/assets/app-abc123.js").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "js"));
        assert_eq!(cache, "public, max-age=31536000, immutable");
    }

    #[tokio::test]
    async fn unknown_paths_get_the_spa_and_are_revalidated() {
        let tmp = dist();
        for path in ["/", "/t/riverside/contacts/abc", "/sign-in"] {
            let (status, cache, body) = get_path(app(&tmp.path()), path).await;
            assert_eq!(
                (status, body.as_str()),
                (StatusCode::OK, "<html>spa</html>"),
                "{path}"
            );
            assert_eq!(cache, "no-cache", "{path}");
        }
    }

    #[tokio::test]
    async fn api_routes_win_and_unknown_api_paths_never_fall_back() {
        let tmp = dist();
        let (status, _, body) = get_path(app(&tmp.path()), "/api/me").await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "me"));
        for path in ["/api", "/api/nope", "/api/t/x/contacts/y", "/healthz"] {
            let (status, _, body) = get_path(app(&tmp.path()), path).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
            assert_eq!(body, r#"{"kind":"not_found"}"#, "{path}");
        }
    }

    #[tokio::test]
    async fn a_missing_asset_is_a_404_not_the_spa() {
        let tmp = dist();
        let (status, cache, _) = get_path(app(&tmp.path()), "/assets/gone-123.js").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(cache, "no-cache");
    }

    #[tokio::test]
    async fn paths_cannot_escape_the_dir() {
        let tmp = dist();
        for path in [
            "/../secret.txt",
            "/%2e%2e/secret.txt",
            "/assets/../../secret.txt",
        ] {
            let (_, _, body) = get_path(app(&tmp.path()), path).await;
            assert_ne!(body, "s", "{path}");
        }
    }
}
