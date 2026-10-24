//! Two organisations, two files, HTTP all the way: tenancy, the error
//! shapes, and Server-Timing. The domain is a toy (`toys.details`) mounted
//! the way real domain routes are.

use std::sync::Arc;

use api::{ApiError, AppState, Body, IdParam, Tenant, app, schema};
use axum::body::Body as HttpBody;
use axum::extract::Path;
use axum::http::{Request, StatusCode, header};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use contracts::{Command, Contract, ContractError, Exec, Executed, Source, execute};
use http_body_util::BodyExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use store::{M, OrgTx, Role, Store, StoreConfig};
use tower::ServiceExt;

const TOY_SCHEMA: &str = "CREATE TABLE toys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    details_version INTEGER NOT NULL DEFAULT 0
) STRICT;";

struct Details;

#[derive(Clone, Serialize, Deserialize)]
struct Name {
    name: String,
}

impl Contract for Details {
    const NAME: &'static str = "toys.details";
    const VERSION: u32 = 1;
    const ENTITY: &'static str = "toys";
    const COUNTER: &'static str = "details_version";
    type Payload = Name;
    type State = Name;

    fn load(&self, tx: &OrgTx, id: &str) -> Result<Name, ContractError> {
        Ok(tx.query_row("SELECT name FROM toys WHERE id = ?1", [id], |r| {
            Ok(Name { name: r.get(0)? })
        })?)
    }

    fn apply(&self, _: Option<&Name>, p: &Name, _: &Command) -> Result<Name, ContractError> {
        if p.name.is_empty() {
            return Err(ContractError::invalid("name", "required"));
        }
        Ok(p.clone())
    }

    fn write(&self, tx: &OrgTx, id: &str, before: Option<&Name>, next: &Name) -> Result<(), ContractError> {
        let sql = if before.is_none() {
            "INSERT INTO toys (id, name) VALUES (?1, ?2)"
        } else {
            "UPDATE toys SET name = ?2 WHERE id = ?1"
        };
        tx.execute(sql, params![id, next.name])?;
        Ok(())
    }
}

#[derive(Deserialize)]
struct Save {
    expected: i64,
    #[serde(flatten)]
    slice: Name,
}

fn toy_routes() -> Router {
    Router::new()
        .route(
            "/toys",
            get(|Extension(t): Extension<Tenant>| async move {
                let names = t
                    .read(|r| {
                        let mut s = r.prepare("SELECT name FROM toys ORDER BY name")?;
                        let names = s
                            .query_map([], |row| row.get::<_, String>(0))?
                            .collect::<rusqlite::Result<Vec<_>>>()?;
                        Ok(names)
                    })
                    .await?;
                Ok::<_, ApiError>(Json(names))
            })
            .post(|Extension(t): Extension<Tenant>, Body(p): Body<Name>| async move {
                let out = t
                    .write(move |ctx| Ok(execute(ctx, &Details, p, Exec::create(Source::Ui))?))
                    .await?;
                Ok::<_, ApiError>(Json(out))
            }),
        )
        .route(
            "/toys/{id}",
            get(|Extension(t): Extension<Tenant>, Path(IdParam { id }): Path<IdParam>| async move {
                let name = t
                    .read(move |r| {
                        r.query_row("SELECT name FROM toys WHERE id = ?1", [&id], |row| {
                            row.get::<_, String>(0)
                        })
                        .map_err(|e| match e {
                            rusqlite::Error::QueryReturnedNoRows => ApiError::NotFound,
                            e => e.into(),
                        })
                    })
                    .await?;
                Ok::<_, ApiError>(Json(name))
            }),
        )
        .route(
            "/toys/{id}/save",
            post(
                |Extension(t): Extension<Tenant>, Path(IdParam { id }): Path<IdParam>, Body(s): Body<Save>| async move {
                    let out = t
                        .write(move |ctx| {
                            Ok(execute(
                                ctx,
                                &Details,
                                s.slice,
                                Exec::update(&id, Some(s.expected), Source::Ui),
                            )?)
                        })
                        .await?;
                    Ok::<_, ApiError>(Json(out))
                },
            ),
        )
}

struct World {
    _tmp: tempfile::TempDir,
    store: Arc<Store>,
    app: Router,
}

/// Two organisations, alpha and beta. ann is admin of alpha, bob admin of
/// beta, val a viewer of alpha.
fn world(dev_auth: bool) -> World {
    let tmp = tempfile::tempdir().unwrap();
    let mut steps = vec![M::up(contracts::MIGRATION)];
    steps.push(M::up(TOY_SCHEMA));
    let _ = schema::org_migrations(); // the real list builds
    let store = Arc::new(
        Store::open(StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: store::Migrations::new(steps),
            readers: 2,
        })
        .unwrap(),
    );
    let p = store.platform();
    let alpha = store.create_tenant("alpha", "Alpha").unwrap();
    let beta = store.create_tenant("beta", "Beta").unwrap();
    p.set_membership(p.upsert_user("ann@alpha.org").unwrap(), &alpha.id, Role::Admin).unwrap();
    p.set_membership(p.upsert_user("bob@beta.org").unwrap(), &beta.id, Role::Admin).unwrap();
    p.set_membership(p.upsert_user("val@alpha.org").unwrap(), &alpha.id, Role::Viewer).unwrap();
    let app = app(AppState { store: store.clone(), dev_auth }, toy_routes());
    World { _tmp: tmp, store, app }
}

struct Res {
    status: StatusCode,
    timing: Option<String>,
    cookie: Option<String>,
    body: Value,
}

impl World {
    async fn call(&self, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> Res {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(c) = cookie {
            req = req.header(header::COOKIE, c);
        }
        let req = match body {
            Some(b) => req
                .header(header::CONTENT_TYPE, "application/json")
                .body(HttpBody::from(b.to_string())),
            None => req.body(HttpBody::empty()),
        }
        .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let header = |name| res.headers().get(name).map(|v: &header::HeaderValue| v.to_str().unwrap().to_owned());
        let (status, timing, cookie) = (res.status(), header("server-timing"), header("set-cookie"));
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Res {
            status,
            timing,
            cookie,
            body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        }
    }

    async fn login(&self, email: &str) -> String {
        let res = self.call("POST", "/api/dev/login", None, Some(json!({ "email": email }))).await;
        assert_eq!(res.status, StatusCode::OK);
        res.cookie.unwrap().split(';').next().unwrap().to_owned()
    }

    async fn create_toy(&self, cookie: &str, slug: &str, name: &str) -> Executed {
        let res = self
            .call("POST", &format!("/api/t/{slug}/toys"), Some(cookie), Some(json!({ "name": name })))
            .await;
        assert_eq!(res.status, StatusCode::OK, "{:?}", res.body);
        serde_json::from_value(res.body).unwrap()
    }
}

#[tokio::test]
async fn a_member_of_one_org_gets_403_on_every_route_of_another() {
    let w = world(true);
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let beta_toy = w.create_toy(&bob, "beta", "beta's toy").await;

    let routes = [
        ("GET", "/api/t/beta".to_owned(), None),
        ("GET", "/api/t/beta/toys".to_owned(), None),
        ("POST", "/api/t/beta/toys".to_owned(), Some(json!({ "name": "x" }))),
        ("GET", format!("/api/t/beta/toys/{}", beta_toy.id), None),
        (
            "POST",
            format!("/api/t/beta/toys/{}/save", beta_toy.id),
            Some(json!({ "expected": 0, "name": "hijacked" })),
        ),
    ];
    for (method, path, body) in routes {
        let res = w.call(method, &path, Some(&ann), body.clone()).await;
        assert_eq!(res.status, StatusCode::FORBIDDEN, "{method} {path}");
        assert_eq!(res.body, json!({ "kind": "forbidden" }));
        // No session at all: 401.
        let res = w.call(method, &path, None, body).await;
        assert_eq!(res.status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    // An unknown slug looks exactly like someone else's.
    let res = w.call("GET", "/api/t/gamma/toys", Some(&ann), None).await;
    assert_eq!((res.status, res.body), (StatusCode::FORBIDDEN, json!({ "kind": "forbidden" })));

    // beta's toy is untouched.
    let res = w.call("GET", &format!("/api/t/beta/toys/{}", beta_toy.id), Some(&bob), None).await;
    assert_eq!(res.body, json!("beta's toy"));
}

#[tokio::test]
async fn each_org_sees_only_its_own_file() {
    let w = world(true);
    let ann = w.login("ann@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    let alpha_toy = w.create_toy(&ann, "alpha", "smith").await;
    w.create_toy(&bob, "beta", "jones").await;

    let res = w.call("GET", "/api/t/alpha/toys", Some(&ann), None).await;
    assert_eq!(res.body, json!(["smith"]));
    let res = w.call("GET", "/api/t/beta/toys", Some(&bob), None).await;
    assert_eq!(res.body, json!(["jones"]));
    // alpha's id asked of beta's file: not there.
    let res = w.call("GET", &format!("/api/t/beta/toys/{}", alpha_toy.id), Some(&bob), None).await;
    assert_eq!(res.status, StatusCode::NOT_FOUND);

    // And on disk: each file holds exactly its own rows.
    for (slug, name) in [("alpha", "smith"), ("beta", "jones")] {
        let tenant = w.store.platform().tenant_by_slug(slug).unwrap().unwrap();
        let names: Vec<String> = w
            .store
            .org(&tenant.id)
            .unwrap()
            .read(|r| {
                let mut s = r.prepare("SELECT name FROM toys")?;
                s.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()
            })
            .unwrap();
        assert_eq!(names, vec![name.to_owned()]);
    }
}

#[tokio::test]
async fn stale_saves_get_409_with_the_current_slice() {
    let w = world(true);
    let ann = w.login("ann@alpha.org").await;
    let toy = w.create_toy(&ann, "alpha", "first").await;
    let path = format!("/api/t/alpha/toys/{}/save", toy.id);
    let save = |expected: i64, name: &str| {
        w.call(
            "POST",
            &path,
            Some(&ann),
            Some(json!({ "expected": expected, "name": name })),
        )
    };
    let res = save(0, "second").await;
    assert_eq!((res.status, res.body), (StatusCode::OK, json!({ "id": toy.id, "counter": 1 })));

    let res = save(0, "lost").await;
    assert_eq!(res.status, StatusCode::CONFLICT);
    assert_eq!(
        res.body,
        json!({ "kind": "stale", "contract": "toys.details", "counter": 1, "current": { "name": "second" } })
    );

    let res = save(1, "").await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.body, json!({ "kind": "invalid", "problems": [{ "field": "name", "message": "required" }] }));

    // A malformed body is the same error shape, not axum's plain text.
    let res = w
        .call("POST", &format!("/api/t/alpha/toys/{}/save", toy.id), Some(&ann), Some(json!({ "name": 3 })))
        .await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(res.body["kind"], "invalid");
}

#[tokio::test]
async fn viewers_cannot_write() {
    let w = world(true);
    let val = w.login("val@alpha.org").await;
    let res = w.call("GET", "/api/t/alpha/toys", Some(&val), None).await;
    assert_eq!(res.status, StatusCode::OK);
    let res = w.call("POST", "/api/t/alpha/toys", Some(&val), Some(json!({ "name": "x" }))).await;
    assert_eq!(res.status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn dev_auth_off_refuses_login_and_every_session() {
    // A session minted while dev auth was on…
    let on = world(true);
    let ann = on.login("ann@alpha.org").await;
    // …is worthless once the flag is off (same data, new server).
    let off = World {
        app: app(AppState { store: on.store.clone(), dev_auth: false }, toy_routes()),
        ..on
    };
    let res = off.call("POST", "/api/dev/login", None, Some(json!({ "email": "ann@alpha.org" }))).await;
    assert_eq!((res.status, res.body), (StatusCode::FORBIDDEN, json!({ "kind": "forbidden" })));
    assert!(res.cookie.is_none());
    let res = off.call("GET", "/api/t/alpha/toys", Some(&ann), None).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
    let res = off.call("GET", "/api/me", Some(&ann), None).await;
    assert_eq!(res.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn me_lists_memberships_and_dev_tenants_make_the_caller_admin() {
    let w = world(true);
    let ann = w.login("ANN@alpha.org").await;
    let res = w.call("GET", "/api/me", Some(&ann), None).await;
    assert_eq!(
        res.body,
        json!({ "email": "ann@alpha.org", "memberships": [{ "slug": "alpha", "name": "Alpha", "role": "admin" }] })
    );
    let res = w
        .call("POST", "/api/dev/tenants", Some(&ann), Some(json!({ "slug": "gamma", "name": "Gamma" })))
        .await;
    assert_eq!(res.status, StatusCode::OK);
    let res = w.call("GET", "/api/t/gamma", Some(&ann), None).await;
    assert_eq!(res.body, json!({ "slug": "gamma", "name": "Gamma", "role": "admin" }));
    let res = w
        .call("POST", "/api/dev/tenants", Some(&ann), Some(json!({ "slug": "../x", "name": "X" })))
        .await;
    assert_eq!(res.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn every_response_carries_server_timing() {
    let w = world(true);
    let ann = w.login("ann@alpha.org").await;
    let res = w.call("GET", "/api/t/alpha/toys", Some(&ann), None).await;
    let timing = res.timing.unwrap();
    for part in ["platform;dur=", "db;dur=", "total;dur="] {
        assert!(timing.contains(part), "{timing}");
    }
    // Errors too.
    let res = w.call("GET", "/api/t/beta/toys", Some(&ann), None).await;
    assert!(res.timing.is_some());
}
