//! A1's routes over HTTP (identifier types, the identifiers slice, notes,
//! relationships, email context and release, byClientKey): every route
//! scoped to the caller's organisation, roles, and the round trips.

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
    store: Arc<Store>,
    app: Router,
}

/// alpha (ann admin, sam staff, val viewer) and beta (bob admin).
fn world() -> World {
    let tmp = tempfile::tempdir().unwrap();
    let store = Arc::new(
        Store::open(StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: schema::org_migrations(),
            readers: 2,
            max_open: StoreConfig::DEFAULT_MAX_OPEN,
        })
        .unwrap(),
    );
    let p = store.platform();
    let alpha = store.create_tenant("alpha", "Alpha").unwrap();
    let beta = store.create_tenant("beta", "Beta").unwrap();
    for (email, tenant, role) in [
        ("ann@alpha.org", &alpha, Role::Admin),
        ("sam@alpha.org", &alpha, Role::Staff),
        ("val@alpha.org", &alpha, Role::Viewer),
        ("bob@beta.org", &beta, Role::Admin),
    ] {
        p.set_membership(p.upsert_user(email).unwrap(), &tenant.id, role)
            .unwrap();
    }
    World {
        _tmp: tmp,
        app: app(
            AppState {
                store: store.clone(),
                dev_auth: true,
            },
            routes::router(),
        ),
        store,
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
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn ok(&self, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
        let (s, b) = self.call(method, path, cookie, body).await;
        assert_eq!(s, StatusCode::OK, "{method} {path}: {b}");
        b
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

    /// As the provider's webhook would: hold an address in `slug`.
    fn bounce(&self, slug: &str, address: &str) {
        let tenant = self.store.platform().tenant_by_slug(slug).unwrap().unwrap();
        let db = self.store.org(&tenant.id).unwrap();
        contracts::transact(&db, None, |ctx| {
            comms::suppress_address(ctx, address, None, None)
        })
        .unwrap();
    }
}

fn person(first: &str, last: &str) -> Value {
    json!({
        "kind": "individual", "title": "", "firstName": first, "lastName": last,
        "nickname": "", "name": "", "isDeceased": false
    })
}

fn org(name: &str) -> Value {
    json!({
        "kind": "organization", "title": "", "firstName": "", "lastName": "",
        "nickname": "", "name": name, "isDeceased": false
    })
}

/// A's world: a contact with an email, an identifier type and row, a note,
/// a relationship type and a relationship. Returns their ids.
struct Alpha {
    contact: String,
    client_key: String,
    id_type: String,
    note: String,
    note_revision: Value,
    rel_type: String,
    relationship: String,
}

async fn alpha(w: &World, ann: &str) -> Alpha {
    let client_key = "0".repeat(31) + "1";
    let c = w
        .ok("POST", "/api/t/alpha/contacts", ann, Some(json!({ "clientKey": client_key, "kind": "individual", "title": "", "firstName": "Ann", "lastName": "Smith", "nickname": "", "name": "", "isDeceased": false })))
        .await;
    let contact = c["id"].as_str().unwrap().to_owned();
    let t = w
        .ok(
            "POST",
            "/api/t/alpha/identifier-types",
            ann,
            Some(json!({ "name": "Member no", "isActive": true })),
        )
        .await;
    let id_type = t["id"].as_str().unwrap().to_owned();
    let saved = w
        .ok(
            "POST",
            &format!("/api/t/alpha/contacts/{contact}/save"),
            ann,
            Some(json!({
                "methods": { "expected": 0, "emails": [{ "label": "home", "address": "ann@x.org", "isPrimary": true }], "phones": [] },
                "identifiers": { "expected": 0, "identifiers": [{ "typeId": id_type, "value": "M1" }] }
            })),
        )
        .await;
    assert_eq!(saved["saved"], json!(["methods", "identifiers"]));
    let n = w
        .ok(
            "POST",
            "/api/t/alpha/notes",
            ann,
            Some(json!({ "contactId": contact, "body": "Met at the fair" })),
        )
        .await;
    let note = n["id"].as_str().unwrap().to_owned();
    let trust = w
        .ok(
            "POST",
            "/api/t/alpha/contacts",
            ann,
            Some(org("Leeds Trust")),
        )
        .await;
    let rt = w
        .ok(
            "POST",
            "/api/t/alpha/relationship-types",
            ann,
            Some(json!({ "labelAB": "Employee of", "labelBA": "Employer of", "kindA": "individual", "kindB": "organization", "isActive": true })),
        )
        .await;
    let rel_type = rt["id"].as_str().unwrap().to_owned();
    let rel = w
        .ok(
            "POST",
            "/api/t/alpha/relationships",
            ann,
            Some(json!({ "contactA": contact, "contactB": trust["id"], "typeId": rel_type, "isActive": true, "description": "" })),
        )
        .await;
    // The note's create revision, from the revisions table.
    let tenant = w.store.platform().tenant_by_slug("alpha").unwrap().unwrap();
    let db = w.store.org(&tenant.id).unwrap();
    let note_revision: i64 = db
        .read(|c| {
            c.query_row(
                "SELECT id FROM revisions WHERE entity_id = ?1",
                [&note],
                |r| r.get(0),
            )
        })
        .unwrap();
    Alpha {
        contact,
        client_key,
        id_type,
        note,
        note_revision: json!(note_revision),
        rel_type,
        relationship: rel["id"].as_str().unwrap().to_owned(),
    }
}

#[tokio::test]
async fn every_a1_route_is_scoped_to_the_callers_organisation() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let a = alpha(&w, &ann).await;
    w.bounce("alpha", "ann@x.org");
    let c = &a.contact;
    let n = &a.note;

    // Ann on beta's slug, or an unknown one, for every route: 403.
    let routes: Vec<(&str, String, Option<Value>)> = vec![
        ("GET", "/identifier-types".into(), None),
        (
            "POST",
            "/identifier-types".into(),
            Some(json!({ "name": "X", "isActive": true })),
        ),
        ("GET", format!("/contacts/{c}/notes"), None),
        ("GET", format!("/contacts/{c}/notes/archived"), None),
        (
            "POST",
            "/notes".into(),
            Some(json!({ "contactId": c, "body": "x" })),
        ),
        (
            "POST",
            format!("/notes/{n}/save"),
            Some(json!({ "expected": 0, "body": "x" })),
        ),
        (
            "POST",
            format!("/notes/{n}/pin"),
            Some(json!({ "value": true })),
        ),
        (
            "POST",
            format!("/notes/{n}/archive"),
            Some(json!({ "value": true })),
        ),
        (
            "POST",
            format!("/notes/{n}/restore"),
            Some(json!({ "revisionId": a.note_revision })),
        ),
        ("GET", "/relationship-types".into(), None),
        (
            "POST",
            "/relationship-types".into(),
            Some(json!({ "labelAB": "a", "labelBA": "b", "isActive": true })),
        ),
        (
            "POST",
            "/relationships".into(),
            Some(
                json!({ "contactA": c, "contactB": c, "typeId": a.rel_type, "isActive": true, "description": "" }),
            ),
        ),
        ("GET", format!("/contacts/{c}/relationships"), None),
        ("GET", format!("/contacts/{c}/email-context"), None),
        (
            "GET",
            format!("/contacts/by-client-key/{}", a.client_key),
            None,
        ),
        (
            "POST",
            "/comms/release".into(),
            Some(json!({ "address": "ann@x.org", "expected": 0, "note": "x" })),
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

    // A's ids under B's own slug: not found in B's file.
    let not_found: Vec<(&str, String, Option<Value>)> = vec![
        (
            "POST",
            "/identifier-types".into(),
            Some(json!({ "id": a.id_type, "expected": 0, "name": "Mine", "isActive": true })),
        ),
        ("GET", format!("/contacts/{c}/notes"), None),
        ("GET", format!("/contacts/{c}/notes/archived"), None),
        (
            "POST",
            format!("/notes/{n}/save"),
            Some(json!({ "expected": 0, "body": "x" })),
        ),
        (
            "POST",
            format!("/notes/{n}/pin"),
            Some(json!({ "value": true })),
        ),
        (
            "POST",
            format!("/notes/{n}/archive"),
            Some(json!({ "value": true })),
        ),
        (
            "POST",
            format!("/notes/{n}/restore"),
            Some(json!({ "revisionId": a.note_revision })),
        ),
        (
            "POST",
            "/relationship-types".into(),
            Some(
                json!({ "id": a.rel_type, "expected": 0, "labelAB": "a", "labelBA": "b", "isActive": true }),
            ),
        ),
        (
            "POST",
            "/relationships".into(),
            Some(
                json!({ "id": a.relationship, "expected": 0, "contactA": c, "contactB": "f".repeat(32), "typeId": a.rel_type, "isActive": true, "description": "" }),
            ),
        ),
        ("GET", format!("/contacts/{c}/relationships"), None),
        ("GET", format!("/contacts/{c}/email-context"), None),
        (
            "GET",
            format!("/contacts/by-client-key/{}", a.client_key),
            None,
        ),
    ];
    for (method, path, body) in not_found {
        let (s, b) = w
            .call(method, &format!("/api/t/beta{path}"), &bob, body)
            .await;
        assert_eq!(
            (s, b["kind"].as_str()),
            (StatusCode::NOT_FOUND, Some("not_found")),
            "{method} beta{path}: {b}"
        );
    }
    // A's ids inside a body B sends are unknown there, and refused.
    for (path, body, reason) in [
        (
            "/notes",
            json!({ "contactId": c, "body": "x" }),
            "unknown_contact",
        ),
        (
            "/comms/release",
            json!({ "address": "ann@x.org", "expected": 0, "note": "x" }),
            "not_held",
        ),
    ] {
        let (s, b) = w
            .call("POST", &format!("/api/t/beta{path}"), &bob, Some(body))
            .await;
        assert_eq!(
            (s, b["reason"].as_str()),
            (StatusCode::UNPROCESSABLE_ENTITY, Some(reason)),
            "{path}"
        );
    }
    let bea = w
        .ok(
            "POST",
            "/api/t/beta/contacts",
            &bob,
            Some(person("Bea", "Brown")),
        )
        .await;
    let (_, saved) = w
        .call(
            "POST",
            &format!("/api/t/beta/contacts/{}/save", bea["id"].as_str().unwrap()),
            &bob,
            Some(json!({ "identifiers": { "expected": 0, "identifiers": [{ "typeId": a.id_type, "value": "M1" }] } })),
        )
        .await;
    assert_eq!(saved["saved"], json!([]));
    assert!(saved["problems"]["identifiers"].is_array());
    // Nothing of A's shows in B's lists; A's are as they were.
    assert_eq!(
        w.ok(
            "GET",
            "/api/t/beta/identifier-types?includeInactive=true",
            &bob,
            None
        )
        .await,
        json!([])
    );
    assert_eq!(
        w.ok("GET", "/api/t/beta/relationship-types", &bob, None)
            .await,
        json!([])
    );
    assert_eq!(
        w.ok(
            "GET",
            &format!("/api/t/alpha/contacts/{c}/notes"),
            &ann,
            None
        )
        .await["notes"][0]["body"],
        "Met at the fair"
    );
}

#[tokio::test]
async fn viewers_never_write_and_lists_and_releases_are_for_admins() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let a = alpha(&w, &ann).await;
    w.bounce("alpha", "ann@x.org");
    let c = &a.contact;
    let n = &a.note;
    let writes: Vec<(String, Value)> = vec![
        (
            "/identifier-types".into(),
            json!({ "name": "X", "isActive": true }),
        ),
        ("/notes".into(), json!({ "contactId": c, "body": "x" })),
        (
            format!("/notes/{n}/save"),
            json!({ "expected": 0, "body": "x" }),
        ),
        (format!("/notes/{n}/pin"), json!({ "value": true })),
        (format!("/notes/{n}/archive"), json!({ "value": true })),
        (
            format!("/notes/{n}/restore"),
            json!({ "revisionId": a.note_revision }),
        ),
        (
            "/relationship-types".into(),
            json!({ "labelAB": "a", "labelBA": "b", "isActive": true }),
        ),
        (
            "/comms/release".into(),
            json!({ "address": "ann@x.org", "expected": 0, "note": "x" }),
        ),
    ];
    for (path, body) in &writes {
        let (s, _) = w
            .call(
                "POST",
                &format!("/api/t/alpha{path}"),
                &val,
                Some(body.clone()),
            )
            .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "viewer {path}");
    }
    // Every member reads.
    for path in [
        "/identifier-types".to_owned(),
        format!("/contacts/{c}/notes"),
        format!("/contacts/{c}/email-context"),
        format!("/contacts/{c}/relationships"),
    ] {
        w.ok("GET", &format!("/api/t/alpha{path}"), &val, None)
            .await;
    }
    // Staff write notes, but manage identifier types only when the switch
    // (A3) lets them, and never release a hold.
    w.ok(
        "POST",
        "/api/t/alpha/notes",
        &sam,
        Some(json!({ "contactId": c, "body": "staff note" })),
    )
    .await;
    for (path, body) in [
        (
            "/identifier-types",
            json!({ "name": "Staff type", "isActive": true }),
        ),
        (
            "/comms/release",
            json!({ "address": "ann@x.org", "expected": 0, "note": "x" }),
        ),
    ] {
        let (s, _) = w
            .call("POST", &format!("/api/t/alpha{path}"), &sam, Some(body))
            .await;
        assert_eq!(s, StatusCode::FORBIDDEN, "staff {path}");
    }
    w.ok(
        "POST",
        "/api/t/alpha/comms/release",
        &ann,
        Some(json!({ "address": "ANN@x.org", "expected": 0, "note": "Confirmed" })),
    )
    .await;
}

#[tokio::test]
async fn identifier_types_and_the_identifiers_slice_round_trip() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let a = alpha(&w, &ann).await;
    // An update needs the version it edits; a stale one is 409.
    let (s, b) = w
        .call(
            "POST",
            "/api/t/alpha/identifier-types",
            &ann,
            Some(json!({ "id": a.id_type, "name": "Member number", "isActive": true })),
        )
        .await;
    assert_eq!(
        (s, b["problems"][0]["field"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("expected"))
    );
    w.ok(
        "POST",
        "/api/t/alpha/identifier-types",
        &ann,
        Some(json!({ "id": a.id_type, "expected": 0, "name": "Member number", "isActive": false })),
    )
    .await;
    let (s, b) = w
        .call(
            "POST",
            "/api/t/alpha/identifier-types",
            &ann,
            Some(json!({ "id": a.id_type, "expected": 0, "name": "X", "isActive": true })),
        )
        .await;
    assert_eq!(
        (s, b["kind"].as_str(), b["counter"].as_i64()),
        (StatusCode::CONFLICT, Some("stale"), Some(1))
    );
    assert_eq!(
        w.ok("GET", "/api/t/alpha/identifier-types", &ann, None)
            .await,
        json!([])
    );
    let all = w
        .ok(
            "GET",
            "/api/t/alpha/identifier-types?includeInactive=true",
            &ann,
            None,
        )
        .await;
    assert_eq!(all[0]["name"], "Member number");
    // The view names the row by its (now archived) type; counters carry it.
    let v = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/{}", a.contact),
            &ann,
            None,
        )
        .await;
    assert_eq!(v["identifiers"][0]["typeName"], "Member number");
    assert_eq!(v["identifiers"][0]["typeActive"], false);
    assert_eq!(v["counters"]["identifiers"], 1);
    // The list search finds the identifier exactly.
    let found = w
        .ok("GET", "/api/t/alpha/contacts/search?q=m1", &ann, None)
        .await;
    assert_eq!(found["rows"][0]["id"], a.contact.as_str());
    // A second contact taking the pair: to fix on the row, naming Ann.
    let bob = w
        .ok(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Bob", "Jones")),
        )
        .await;
    let t2 = w
        .ok(
            "POST",
            "/api/t/alpha/identifier-types",
            &ann,
            Some(json!({ "name": "Old id", "isActive": true })),
        )
        .await;
    let saved = w
        .ok(
            "POST",
            &format!("/api/t/alpha/contacts/{}/save", bob["id"].as_str().unwrap()),
            &ann,
            Some(json!({ "identifiers": { "expected": 0, "identifiers": [{ "typeId": a.id_type, "value": "m1" }, { "typeId": t2["id"], "value": "OLD-1" }] } })),
        )
        .await;
    let problems = saved["problems"]["identifiers"].as_array().unwrap();
    assert_eq!(problems.len(), 1);
    assert_eq!(
        problems[0]["message"],
        "That type has been archived: choose another"
    );
}

#[tokio::test]
async fn notes_round_trip_and_answer_the_note() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let a = alpha(&w, &ann).await;
    let n = &a.note;
    let pinned = w
        .ok(
            "POST",
            &format!("/api/t/alpha/notes/{n}/pin"),
            &ann,
            Some(json!({ "value": true })),
        )
        .await;
    assert_eq!(
        (pinned["pinned"].as_bool(), pinned["flagsVersion"].as_i64()),
        (Some(true), Some(1))
    );
    let edited = w
        .ok(
            "POST",
            &format!("/api/t/alpha/notes/{n}/save"),
            &ann,
            Some(json!({ "expected": 0, "body": "Met at the summer fair" })),
        )
        .await;
    assert_eq!(
        (edited["bodyVersion"].as_i64(), edited["pinned"].as_bool()),
        (Some(1), Some(true))
    );
    let (s, b) = w
        .call(
            "POST",
            &format!("/api/t/alpha/notes/{n}/save"),
            &ann,
            Some(json!({ "expected": 0, "body": "mine" })),
        )
        .await;
    assert_eq!(
        (s, b["current"]["body"].as_str()),
        (StatusCode::CONFLICT, Some("Met at the summer fair"))
    );
    w.ok(
        "POST",
        &format!("/api/t/alpha/notes/{n}/archive"),
        &ann,
        Some(json!({ "value": true })),
    )
    .await;
    let live = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/{}/notes", a.contact),
            &ann,
            None,
        )
        .await;
    assert_eq!(live, json!({ "notes": [], "truncated": false }));
    let gone = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/{}/notes/archived", a.contact),
            &ann,
            None,
        )
        .await;
    assert_eq!(gone["notes"][0]["body"], "Met at the summer fair");
    let (s, b) = w
        .call(
            "POST",
            &format!("/api/t/alpha/notes/{n}/save"),
            &ann,
            Some(json!({ "expected": 1, "body": "x" })),
        )
        .await;
    assert_eq!(
        (s, b["reason"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("archived"))
    );
    // A pinned note made in one go.
    let made = w
        .ok(
            "POST",
            "/api/t/alpha/notes",
            &ann,
            Some(json!({ "contactId": a.contact, "body": "Pinned", "pinned": true })),
        )
        .await;
    assert_eq!(made["pinned"], true);
}

#[tokio::test]
async fn the_email_context_says_who_else_uses_an_address_and_what_is_held() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let a = alpha(&w, &ann).await;
    let ctx = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/{}/email-context", a.contact),
            &ann,
            None,
        )
        .await;
    assert_eq!(ctx, json!({ "alsoUsedBy": {}, "held": {} }));
    let bob = w
        .ok(
            "POST",
            "/api/t/alpha/contacts",
            &ann,
            Some(person("Bob", "Jones")),
        )
        .await;
    let bob_id = bob["id"].as_str().unwrap();
    w.ok(
        "POST",
        &format!("/api/t/alpha/contacts/{bob_id}/save"),
        &ann,
        Some(json!({ "methods": { "expected": 0, "emails": [{ "label": "work", "address": "ANN@x.org", "isPrimary": true }], "phones": [] } })),
    )
    .await;
    w.bounce("alpha", "ann@x.org");
    let ctx = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/{}/email-context", a.contact),
            &ann,
            None,
        )
        .await;
    let shared = ctx["alsoUsedBy"].as_object().unwrap();
    assert_eq!(shared.len(), 1);
    let sharers = shared.values().next().unwrap();
    assert_eq!(sharers["contacts"][0]["displayName"], "Bob Jones");
    assert_eq!(ctx["held"]["ann@x.org"]["reason"], "bounce");
    assert_eq!(ctx["held"]["ann@x.org"]["saveVersion"], 0);
    // Released: no longer held, for either contact.
    w.ok(
        "POST",
        "/api/t/alpha/comms/release",
        &ann,
        Some(json!({ "address": "ann@x.org", "expected": 0, "note": "Fixed" })),
    )
    .await;
    let ctx = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/{bob_id}/email-context"),
            &ann,
            None,
        )
        .await;
    assert_eq!(ctx["held"], json!({}));
    // byClientKey finds the form's contact with its view.
    let v = w
        .ok(
            "GET",
            &format!("/api/t/alpha/contacts/by-client-key/{}", a.client_key),
            &ann,
            None,
        )
        .await;
    assert_eq!(v["id"], a.contact.as_str());
}
