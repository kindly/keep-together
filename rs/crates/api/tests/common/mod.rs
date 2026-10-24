//! A two-organisation world on the real org schema, for route tests.
//! alpha: ann (admin), val (viewer); beta: bob (admin).

#![allow(dead_code)]

use std::sync::Arc;

use api::{AppState, app, routes, schema};
use axum::Router;
use axum::body::Body as HttpBody;
use axum::http::{Request, StatusCode, header};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use store::{Role, Store, StoreConfig, Tenant};
use tower::ServiceExt;

pub struct World {
    _tmp: tempfile::TempDir,
    pub store: Arc<Store>,
    pub alpha: Tenant,
    pub beta: Tenant,
    pub app: Router,
}

pub fn world() -> World {
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
        app: app(AppState::new(store.clone(), true), routes::router()),
        store,
        alpha,
        beta,
    }
}

pub fn request(
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
) -> Request<HttpBody> {
    let mut req = Request::builder().method(method).uri(path);
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    match body {
        Some(b) => req
            .header(header::CONTENT_TYPE, "application/json")
            .body(HttpBody::from(b.to_string())),
        None => req.body(HttpBody::empty()),
    }
    .unwrap()
}

impl World {
    pub async fn call(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let res = self
            .app
            .clone()
            .oneshot(request(method, path, Some(cookie), body))
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    pub async fn login(&self, email: &str) -> String {
        let res = self
            .app
            .clone()
            .oneshot(request(
                "POST",
                "/api/dev/login",
                None,
                Some(json!({ "email": email })),
            ))
            .await
            .unwrap();
        let cookie = res.headers()[header::SET_COOKIE].to_str().unwrap();
        cookie.split(';').next().unwrap().to_owned()
    }
}

pub fn person(first: &str, last: &str) -> Value {
    json!({
        "kind": "individual", "title": "", "firstName": first, "lastName": last,
        "nickname": "", "name": "", "isDeceased": false
    })
}
