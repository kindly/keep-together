//! The contacts routes over HTTP, on the real org schema: tenancy on every
//! route, the form save round trip, and the error shapes.

use std::sync::Arc;

use api::{AppState, app, routes, schema};
use axum::Router;
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use store::{Role, Store, StoreConfig};
use tower::ServiceExt;

struct World {
    _tmp: tempfile::TempDir,
    app: Router,
}

/// alpha (ann admin, val viewer) and beta (bob admin).
fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        Store::open_with(
            StoreConfig {
                dir: tmp.path().to_path_buf(),
                org_migrations: schema::org_migrations(),
                readers: 2,
                max_open: StoreConfig::DEFAULT_MAX_OPEN,
            },
            schema::PLATFORM_SCHEMAS,
        )
        .unwrap(),
    );
    let p = store.platform();
    let alpha = store.create_tenant("alpha", "Alpha").unwrap();
    let beta = store.create_tenant("beta", "Beta").unwrap();
    for (email, tenant, role) in [
        ("ann@alpha.org", &alpha, Role::Admin),
        ("val@alpha.org", &alpha, Role::Viewer),
        ("bob@beta.org", &beta, Role::Admin),
    ] {
        p.set_membership(p.upsert_user(email).unwrap(), &tenant.id, role)
            .unwrap();
    }
    World {
        _tmp: tmp,
        app: app(AppState::new(store, true), routes::router()),
    }
}

impl World {
    async fn call(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let req = Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, cookie);
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(HttpBody::from(b.to_string())),
            None => req.body(HttpBody::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        assert!(res.headers().contains_key("server-timing"));
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn login(&self, email: &str) -> String {
        let req = Request::builder()
            .method("POST")
            .uri("/api/dev/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(HttpBody::from(json!({ "email": email }).to_string()))
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let cookie = res.headers()[header::SET_COOKIE].to_str().unwrap();
        cookie.split(';').next().unwrap().to_owned()
    }
}

fn person(first: &str, last: &str) -> Value {
    json!({
        "kind": "individual", "title": "", "firstName": first, "lastName": last,
        "nickname": "", "name": "", "isDeceased": false
    })
}

#[tokio::test]
async fn every_contacts_route_is_scoped_to_the_callers_organisation() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;

    let (s, a) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Ann", "Smith")),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let a_id = a["id"].as_str().unwrap().to_owned();
    let (s, _) = w
        .call(
            "POST",
            "/api/t/beta/contacts",
            &bob,
            Some(person("Bea", "Smith")),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, field) = w
        .call(
            "POST",
            "/api/t/alpha/fields",
            &ann,
            Some(json!({ "label": "Volunteer status", "appliesTo": ["individual"], "isActive": true })),
        )
        .await;
    let field_id = field["id"].as_str().unwrap().to_owned();

    // ann on beta's slug, for every route: 403, the same as an unknown slug.
    let routes: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", "/contacts".into(), None),
        ("GET", "/contacts/search?q=smith".into(), None),
        ("GET", format!("/contacts/{a_id}"), None),
        ("GET", format!("/contacts/{a_id}/history"), None),
        ("POST", "/contacts".into(), Some(person("X", "Y"))),
        ("POST", format!("/contacts/{a_id}/save"), Some(json!({}))),
        (
            "POST",
            format!("/contacts/{a_id}/archive"),
            Some(json!({ "expected": 0, "archived": true })),
        ),
        (
            "POST",
            format!("/contacts/{a_id}/restore"),
            Some(json!({ "revisionId": 1 })),
        ),
        ("GET", "/fields".into(), None),
        (
            "POST",
            "/fields".into(),
            Some(json!({ "label": "X", "appliesTo": ["individual"], "isActive": true })),
        ),
        (
            "POST",
            "/fields/options".into(),
            Some(json!({ "fieldId": field_id, "label": "X", "position": 0, "isActive": true })),
        ),
    ];
    for (method, path, body) in &routes {
        for slug in ["beta", "nobody"] {
            let (s, b) = w
                .call(method, &format!("/api/t/{slug}{path}"), &ann, body.clone())
                .await;
            assert_eq!(
                (s, b["kind"].as_str()),
                (StatusCode::FORBIDDEN, Some("forbidden")),
                "{method} {slug}{path}"
            );
        }
    }
    // Nothing leaked either way: each sees its own Smith only.
    let (_, a_found) = w
        .call("GET", "/api/t/alpha/contacts/search?q=smith", &ann, None)
        .await;
    let (_, b_found) = w
        .call("GET", "/api/t/beta/contacts/search?q=smith", &bob, None)
        .await;
    assert_eq!(a_found["rows"].as_array().unwrap().len(), 1);
    assert_eq!(b_found["rows"][0]["displayName"], "Bea Smith");
    // A's id on B's own slug: not found in B's file.
    let (s, _) = w
        .call("GET", &format!("/api/t/beta/contacts/{a_id}"), &bob, None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _) = w
        .call(
            "POST",
            &format!("/api/t/beta/contacts/{a_id}/save"),
            &bob,
            Some(json!({})),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (_, a_history) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{a_id}/history"),
            &ann,
            None,
        )
        .await;
    let a_revision = a_history["revisions"][0]["id"].clone();
    assert!(a_revision.is_i64());
    for (method, path, body) in [
        ("GET", format!("/api/t/beta/contacts/{a_id}/history"), None),
        (
            "POST",
            format!("/api/t/beta/contacts/{a_id}/archive"),
            Some(json!({ "expected": 0, "archived": true })),
        ),
        (
            "POST",
            format!("/api/t/beta/contacts/{a_id}/restore"),
            Some(json!({ "at": 0 })),
        ),
        (
            "POST",
            format!("/api/t/beta/contacts/{a_id}/restore"),
            Some(json!({ "revisionId": a_revision })),
        ),
    ] {
        let (s, b) = w.call(method, &path, &bob, body).await;
        assert_eq!(
            (s, b["kind"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found")),
            "{method} {path}"
        );
    }
    // B can't name A's field in its own filters.
    let (s, b) = w
        .call(
            "GET",
            &format!("/api/t/beta/contacts?fields={field_id}:none"),
            &bob,
            None,
        )
        .await;
    assert_eq!(
        (s, b["kind"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("rejected"))
    );
}

#[tokio::test]
async fn viewers_read_but_never_write_and_fields_are_for_admins() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let (_, a) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Ann", "Smith")),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    let (s, _) = w
        .call("GET", &format!("/api/t/alpha/contacts/{id}"), &val, None)
        .await;
    assert_eq!(s, StatusCode::OK);
    for (path, body) in [
        ("/contacts".to_owned(), person("V", "W")),
        (format!("/contacts/{id}/save"), json!({})),
        (
            format!("/contacts/{id}/archive"),
            json!({ "expected": 0, "archived": true }),
        ),
        (
            "/fields".to_owned(),
            json!({ "label": "X", "appliesTo": ["individual"], "isActive": true }),
        ),
    ] {
        let (s, _) = w
            .call("POST", &format!("/api/t/alpha{path}"), &val, Some(body))
            .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "{path}");
    }
}

#[tokio::test]
async fn the_form_round_trip() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let (_, a) = w
        .call(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Ann", "Smith")),
        )
        .await;
    let id = a["id"].as_str().unwrap();
    assert_eq!(a["number"], 10001);
    let save_path = format!("/api/t/alpha/contacts/{id}/save");
    let save = |body: Value| w.call("POST", &save_path, &ann, Some(body));

    let (s, out) = save(json!({
        "methods": { "expected": 0, "emails": [{ "label": "home", "address": "ann@x.org", "isPrimary": true }], "phones": [] },
        "addresses": { "expected": 0, "addresses": [{ "label": "home", "line1": "1 High St", "line2": "", "line3": "",
            "town": "Leeds", "postcode": "ls6 2ab", "country": "gb", "isPrimary": true }] }
    }))
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(out["saved"], json!(["methods", "addresses"]));

    // The other tab, still on counter 0: stale with the state now, in-band.
    let (s, out) = save(json!({
        "methods": { "expected": 0, "emails": [], "phones": [] },
        "details": { "expected": 0, "kind": "individual", "title": "Dr", "firstName": "Ann",
            "lastName": "Smith", "nickname": "", "name": "", "isDeceased": false }
    }))
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(out["saved"], json!(["details"]));
    assert_eq!(out["stale"]["methods"], 1);
    assert_eq!(
        out["current"]["methods"]["emails"][0]["address"],
        "ann@x.org"
    );

    let (_, view) = w
        .call("GET", &format!("/api/t/alpha/contacts/{id}"), &ann, None)
        .await;
    assert_eq!(view["details"]["title"], "Dr");
    assert_eq!(view["addresses"]["addresses"][0]["postcode"], "LS6 2AB");
    assert_eq!(
        view["counters"],
        json!({ "details": 1, "methods": 1, "addresses": 1, "archive": 0, "fields": 0,
               "identifiers": 0, "acquisition": 0 })
    );

    // Single-slice archive: 409 stale with the current slice.
    let (s, err) = w
        .call(
            "POST",
            &format!("/api/t/alpha/contacts/{id}/archive"),
            &ann,
            Some(json!({ "expected": 3, "archived": true })),
        )
        .await;
    assert_eq!(
        (s, err["kind"].as_str(), err["counter"].as_i64()),
        (StatusCode::CONFLICT, Some("stale"), Some(0))
    );
    assert_eq!(err["current"], json!({ "archived": false }));

    // Malformed input is a 422, never a 500 or plain text.
    let (s, err) = w
        .call("GET", "/api/t/alpha/contacts?cursor=nonsense", &ann, None)
        .await;
    assert_eq!(
        (s, err["kind"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid"))
    );
    let (s, err) = w
        .call("GET", "/api/t/alpha/contacts?kind=robot", &ann, None)
        .await;
    assert_eq!(
        (s, err["kind"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("invalid"))
    );
    // FTS syntax in the entry is just text.
    let (s, out) = w
        .call(
            "GET",
            "/api/t/alpha/contacts/search?q=%22smith%22%20OR%20NEAR(a*%20b)%20%5E",
            &ann,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{out}");

    let (_, hist) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{id}/history?limit=2"),
            &ann,
            None,
        )
        .await;
    assert_eq!(hist["revisions"].as_array().unwrap().len(), 2);
    let before = hist["nextBefore"].as_i64().unwrap();
    let (_, older) = w
        .call(
            "GET",
            &format!("/api/t/alpha/contacts/{id}/history?before={before}"),
            &ann,
            None,
        )
        .await;
    assert_eq!(older["revisions"].as_array().unwrap().len(), 2);
    assert_eq!(older["nextBefore"], Value::Null);
}
