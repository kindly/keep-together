//! The two-org world with `KEEP_STRIPE=fake`, served on a local port (the
//! fake's API and webhooks reach this same app over HTTP).

#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;

use api::stripe::fake::Fake;
use api::stripe::{Origins, Stripe, from_vars, process};
use api::{AppState, app, routes};
use axum::http::StatusCode;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};

use crate::common::{World, world};

pub struct T {
    pub w: World,
    pub stripe: Arc<Stripe>,
    pub fake: Arc<Fake>,
    pub base: String,
    pub http: reqwest::Client,
    pub ann: String,
    pub sam: String,
    pub val: String,
    pub bob: String,
}

pub async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

pub async fn setup() -> T {
    let mut w = world();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stripe = from_vars(
        |name| (name == "KEEP_STRIPE").then(|| "fake".to_owned()),
        Origins {
            app_origin: &base,
            self_base: &base,
        },
    )
    .unwrap()
    .map(Arc::new)
    .unwrap();
    w.app = app(
        AppState::new(w.store.clone(), true).with_stripe(Some(stripe.clone())),
        routes::router(),
    );
    let served = w.app.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            served.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap()
    });
    let ann = w.login("ann@alpha.org").await;
    let sam = w.login("sam@alpha.org").await;
    let val = w.login("val@alpha.org").await;
    let bob = w.login("bob@beta.org").await;
    T {
        fake: stripe.fake.clone().unwrap(),
        stripe,
        w,
        base,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
        ann,
        sam,
        val,
        bob,
    }
}

impl T {
    /// `POST stripe/connect` as `cookie`.
    pub async fn start(&self, slug: &str, cookie: &str) -> Value {
        ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/stripe/connect"),
            cookie,
            None,
        )
        .await
    }

    /// The fake's onboarding page, answered as a browser would
    /// (`complete`, `partial` or `leave`): where Stripe sends it back to.
    pub async fn onboard(&self, url: &str, decision: &str) -> String {
        let page = self.http.get(url).send().await.unwrap();
        assert_eq!(page.status(), 200, "{url}");
        let res = self
            .http
            .post(format!("{url}/decide"))
            .form(&[("decision", decision)])
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 303);
        res.headers()["location"].to_str().unwrap().to_owned()
    }

    /// Connect `slug` all the way: the account, Stripe's form completed,
    /// its event run. The status after.
    pub async fn connect(&self, slug: &str, cookie: &str) -> Value {
        let start = self.start(slug, cookie).await;
        self.onboard(start["url"].as_str().unwrap(), "complete")
            .await;
        self.settle().await;
        let s = ok(
            &self.w,
            "GET",
            &format!("/api/t/{slug}/stripe"),
            cookie,
            None,
        )
        .await;
        assert_eq!(s["onboarding"], "complete", "{s}");
        s
    }

    /// Every stored event that can run has run (a run waits for the one
    /// a webhook started).
    pub async fn settle(&self) {
        process::process_pending(self.w.store.clone(), self.stripe.clone())
            .await
            .unwrap();
    }

    /// `simulate/accounts/{id}/update`: its answer (`event`, `delivered`).
    pub async fn simulate(&self, account: &str, patch: Value) -> Value {
        let res = self
            .http
            .post(format!(
                "{}/api/fake-stripe/simulate/accounts/{account}/update",
                self.base
            ))
            .json(&patch)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        res.json().await.unwrap()
    }

    pub async fn outage(&self, calls: usize, status: u16, path: &str) {
        let res = self
            .http
            .post(format!("{}/api/fake-stripe/simulate/outage", self.base))
            .json(&json!({ "calls": calls, "status": status, "path": path }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }

    pub async fn fake_post(&self, path: &str) -> Value {
        let res = self
            .http
            .post(format!("{}/api/fake-stripe/{path}", self.base))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{path}");
        res.json().await.unwrap()
    }

    /// A stored event's outcome and the organisation it was routed to.
    pub fn event(&self, id: &str) -> (Option<String>, Option<String>) {
        self.w
            .store
            .platform()
            .with_read(|c| {
                Ok::<_, store::StoreError>(
                    c.query_row(
                        "SELECT outcome, tenant_id FROM stripe_events WHERE id = ?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?,
                )
            })
            .unwrap()
            .unwrap_or_else(|| panic!("no event {id} stored"))
    }

    pub fn event_count(&self) -> i64 {
        self.w
            .store
            .platform()
            .with_read(|c| {
                Ok::<_, store::StoreError>(c.query_row(
                    "SELECT count(*) FROM stripe_events",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap()
    }
}
