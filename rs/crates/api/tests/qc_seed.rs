//! `POST /api/dev/qc-seed` and `qc-crowd`: refused without
//! `KEEP_QC_SEED=1`, idempotent with it. Its own test binary, since it
//! sets the env var for the process.

use std::sync::Arc;

use api::{AppState, app, routes, schema};
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use store::{Store, StoreConfig};
use tower::ServiceExt;

async fn post(app: &axum::Router, path: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("POST")
        .uri(path)
        .header(header::CONTENT_TYPE, "application/json")
        .body(HttpBody::from(body.to_string()))
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn qc_seed_builds_the_same_world_and_only_when_enabled() {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        Store::open(StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: schema::org_migrations(),
            readers: 1,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        })
        .unwrap(),
    );
    let app = app(
        AppState {
            store,
            dev_auth: true,
        },
        routes::router(),
    );
    let req = json!({ "runId": "7", "worker": 0 });

    let (s, _) = post(&app, "/api/dev/qc-seed", req.clone()).await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // SAFETY: this test binary has one test; nothing else reads the env.
    unsafe { std::env::set_var("KEEP_QC_SEED", "1") };
    let (s, world) = post(&app, "/api/dev/qc-seed", req.clone()).await;
    assert_eq!(s, StatusCode::OK, "{world}");
    assert_eq!(world["users"][0]["email"], "qc-r7w0-a@example.com");
    assert_eq!(world["users"][3]["role"], "viewer");
    assert_eq!(world["tenants"][1]["slug"], "r7w0-b");
    assert_eq!(
        world["tenants"][0]["contactIds"].as_array().unwrap().len(),
        3
    );
    let (_, again) = post(&app, "/api/dev/qc-seed", req).await;
    assert_eq!(again["tenants"], world["tenants"]);

    let (s, n) = post(
        &app,
        "/api/dev/qc-crowd",
        json!({ "slug": "r7w0-a", "lastName": "Crowd", "count": 150 }),
    )
    .await;
    assert_eq!((s, n), (StatusCode::OK, json!(150)));
}
