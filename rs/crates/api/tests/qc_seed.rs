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
        Store::open_with(
            StoreConfig {
                dir: tmp.path().to_path_buf(),
                org_migrations: schema::org_migrations(),
                readers: 1,
                max_open: StoreConfig::DEFAULT_MAX_OPEN,
            },
            schema::PLATFORM_SCHEMAS,
        )
        .unwrap(),
    );
    let app = app(AppState::new(store.clone(), true), routes::router());
    let req = json!({ "runId": "7", "worker": 0 });

    let (s, _) = post(&app, "/api/dev/qc-seed", req.clone()).await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // SAFETY: this test binary has one test; nothing else reads the env.
    unsafe { std::env::set_var("KEEP_QC_SEED", "1") };
    let (s, world) = post(&app, "/api/dev/qc-seed", req.clone()).await;
    assert_eq!(s, StatusCode::OK, "{world}");
    assert_eq!(
        world["users"][0]["email"],
        "qc-r7w0-a@qc.keep-together.invalid"
    );
    assert_eq!(world["users"][3]["role"], "viewer");
    assert_eq!(world["tenants"][1]["slug"], "qc-r7w0-b");
    assert_eq!(
        world["tenants"][0]["contactIds"].as_array().unwrap().len(),
        3
    );
    let (_, again) = post(&app, "/api/dev/qc-seed", req).await;
    assert_eq!(again["tenants"], world["tenants"]);

    // qcSeed.test.ts › each side's Street category holds its own detail;
    // Event holds Gala; nothing else. And: Charles and the Trust coded
    // under Street; Event-Gala free.
    for (i, side) in ["Alpha", "Bravo"].into_iter().enumerate() {
        let slug = world["tenants"][i]["slug"].as_str().unwrap();
        let tenant = store.platform().tenant_by_slug(slug).unwrap().unwrap();
        let db = store.org(&tenant.id).unwrap();
        let codes: Vec<String> = db
            .read(|c| sources::tree(c))
            .unwrap()
            .into_iter()
            .filter(|p| p.level != sources::Level::Category)
            .map(|p| p.code)
            .collect();
        let street = format!("Street-{side}7");
        assert_eq!(
            codes,
            [
                "Event-Gala".to_owned(),
                "Event-Gala-001".into(),
                "Event-Gala-002".into(),
                street.clone(),
                format!("{street}-001"),
                format!("{street}-002"),
            ]
        );
        let ids = world["tenants"][i]["contactIds"].as_array().unwrap();
        let coded: Vec<Option<String>> = ids
            .iter()
            .map(|id| {
                db.read(|c| contacts::acquisition::acquisition_of(c, id.as_str().unwrap()))
                    .unwrap()
                    .map(|d| d.code)
            })
            .collect();
        assert_eq!(
            coded,
            [
                None,
                Some(format!("{street}-001")),
                Some(format!("{street}-002"))
            ]
        );
    }

    // Gifts and Gift Aid: the Trust's gift under its code, Ada's
    // declaration, on each side.
    for (i, pence) in api::routes::qc_seed::QC_GIFT_PENCE.into_iter().enumerate() {
        let t = &world["tenants"][i];
        let tenant = store
            .platform()
            .tenant_by_slug(t["slug"].as_str().unwrap())
            .unwrap()
            .unwrap();
        let db = store.org(&tenant.id).unwrap();
        let gift_ids = t["giftIds"].as_array().unwrap();
        assert_eq!(gift_ids.len(), 1);
        let (contact, amount): (String, i64) = db
            .read(|c| {
                c.query_row(
                    "SELECT contact_id, amount FROM gifts WHERE id = ?1",
                    [gift_ids[0].as_str().unwrap()],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap();
        assert_eq!(
            (contact.as_str(), amount),
            (t["contactIds"][2].as_str().unwrap(), pence)
        );
        let decl = t["declarationIds"].as_array().unwrap();
        assert_eq!(decl.len(), 1);
        let holder: String = db
            .read(|c| {
                c.query_row(
                    "SELECT contact_id FROM gift_aid_declarations WHERE id = ?1",
                    [decl[0].as_str().unwrap()],
                    |r| r.get(0),
                )
            })
            .unwrap();
        assert_eq!(holder, t["contactIds"][0].as_str().unwrap());
    }

    let (s, n) = post(
        &app,
        "/api/dev/qc-crowd",
        json!({ "slug": "qc-r7w0-a", "lastName": "Crowd", "count": 150 }),
    )
    .await;
    assert_eq!((s, n), (StatusCode::OK, json!(150)));
}
