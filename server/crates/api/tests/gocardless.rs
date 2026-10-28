//! GoCardless (`api::gocardless`, plan gocardless.sv D1 and D2) end to end
//! against the fake, served on a real port so the HTTP client, the OAuth
//! redirects and the signed webhooks all cross the wire: connecting and
//! disconnecting, who may, the single-use OAuth state, the webhook's
//! signature and event store, and a regular gift from set-up through
//! mandate, payments, failure, chargeback and cancellation. Tenancy on
//! every route: B never sees A; A's ids under B's slug are 404.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;

use api::gocardless::fake::Fake;
use api::gocardless::webhook::{SIGNATURE_HEADER, sign};
use api::gocardless::{GoCardless, Origins, from_vars, process};
use api::{AppState, app, routes};
use axum::http::{StatusCode, header};
use common::{World, request, world};
use http_body_util::BodyExt;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use tower::ServiceExt;

struct T {
    w: World,
    gc: Arc<GoCardless>,
    fake: Arc<Fake>,
    base: String,
    http: reqwest::Client,
    ann: String,
    sam: String,
    val: String,
    bob: String,
    code: String,
    beta_code: String,
}

async fn ok(w: &World, method: &str, path: &str, cookie: &str, body: Option<Value>) -> Value {
    let (s, out) = w.call(method, path, cookie, body).await;
    assert_eq!(s, StatusCode::OK, "{method} {path}: {out}");
    out
}

/// A new full source code (version) under a seeded category.
async fn source_code(w: &World, slug: &str, cookie: &str) -> String {
    let tree = ok(w, "GET", &format!("/api/t/{slug}/sources"), cookie, None).await;
    let category = tree["parts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["parentId"].is_null())
        .expect("a seeded category")["id"]
        .clone();
    let made = ok(
        w,
        "POST",
        &format!("/api/t/{slug}/sources"),
        cookie,
        Some(json!({ "parentId": category, "name": "Direct", "isActive": true })),
    )
    .await;
    made["versionId"].as_str().unwrap().to_owned()
}

fn settings_key() -> platform::settings::SettingsKey {
    ::auth::keys::Keys::dev().settings_key().clone()
}

/// The two-org world with `KEEP_GOCARDLESS=fake`, served on a local port
/// (the fake's API and webhooks reach this same app over HTTP).
async fn setup() -> T {
    let mut w = world();
    for t in [&w.alpha, &w.beta] {
        let db = w.store.org(&t.id).unwrap();
        contracts::transact(&db, None, api::schema::seed_new_org).unwrap();
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let gc = from_vars(
        |name| (name == "KEEP_GOCARDLESS").then(|| "fake".to_owned()),
        Origins {
            app_origin: &base,
            self_base: &base,
        },
        settings_key(),
    )
    .unwrap()
    .map(Arc::new)
    .unwrap();
    w.app = app(
        AppState::new(w.store.clone(), true).with_gocardless(Some(gc.clone())),
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
    let code = source_code(&w, "alpha", &ann).await;
    let beta_code = source_code(&w, "beta", &bob).await;
    T {
        fake: gc.fake.clone().unwrap(),
        gc,
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
        code,
        beta_code,
    }
}

/// The payment `pm` on a regular gift's view.
fn payment(v: &Value, pm: &str) -> Value {
    v["payments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paymentId"] == pm)
        .unwrap_or_else(|| panic!("no {pm} in {v}"))
        .clone()
}

/// A GET through the app with a cookie, answering status and Location.
async fn navigate(w: &World, path: &str, cookie: &str) -> (StatusCode, String) {
    let res = w
        .app
        .clone()
        .oneshot(request("GET", path, Some(cookie), None))
        .await
        .unwrap();
    let location = res
        .headers()
        .get(header::LOCATION)
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (res.status(), location)
}

impl T {
    /// The fake's consent page, answered as a browser would: the callback
    /// path GoCardless sends the browser back to.
    async fn consent(&self, start_url: &str, decision: &str) -> String {
        self.consent_as(start_url, decision, "").await
    }

    /// The consent page, picking an existing fake account (`""`: a new
    /// one).
    async fn consent_as(&self, start_url: &str, decision: &str, account: &str) -> String {
        let url = reqwest::Url::parse(start_url).unwrap();
        assert!(
            url.as_str().starts_with(&format!(
                "{}/api/fake-gocardless/connect/oauth/authorize",
                self.base
            )),
            "{url}"
        );
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["scope"], "read_write");
        assert_eq!(q["client_id"], api::gocardless::fake::CLIENT_ID);
        let page = self.http.get(url.clone()).send().await.unwrap();
        assert_eq!(page.status(), 200);
        let res = self
            .http
            .post(format!(
                "{}/api/fake-gocardless/connect/oauth/decide",
                self.base
            ))
            .form(&[
                ("redirect_uri", q["redirect_uri"].as_str()),
                ("state", q["state"].as_str()),
                ("decision", decision),
                ("account", account),
            ])
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 303);
        let back = reqwest::Url::parse(res.headers()["location"].to_str().unwrap()).unwrap();
        assert_eq!(back.path(), "/api/gocardless/callback");
        format!("{}?{}", back.path(), back.query().unwrap())
    }

    /// Connect `slug` as `cookie` (its admin) all the way through.
    async fn connect(&self, slug: &str, cookie: &str) -> Value {
        let start = ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/gocardless/connect"),
            cookie,
            None,
        )
        .await;
        let callback = self
            .consent(start["url"].as_str().unwrap(), "connect")
            .await;
        let (s, landed) = navigate(&self.w, &callback, cookie).await;
        assert_eq!(s, StatusCode::SEE_OTHER);
        assert_eq!(landed, format!("/t/{slug}/settings?gocardless=connected"));
        ok(
            &self.w,
            "GET",
            &format!("/api/t/{slug}/gocardless"),
            cookie,
            None,
        )
        .await
    }

    async fn contact(&self, slug: &str, cookie: &str) -> String {
        ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/contacts"),
            cookie,
            Some(common::person("Jo", "Bloggs")),
        )
        .await["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn set_up(&self, slug: &str, cookie: &str, contact: &str, code: &str) -> Value {
        ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/contacts/{contact}/regular-gifts"),
            cookie,
            Some(json!({
                "amount": 1000, "frequency": "monthly", "dayOfMonth": 5,
                "sourceCodeId": code, "clientKey": contracts::new_id()
            })),
        )
        .await["view"]
            .clone()
    }

    /// The donor completes the hosted page.
    async fn sign(&self, flow_url: &str) {
        let page = self.http.get(flow_url).send().await.unwrap();
        assert_eq!(page.status(), 200);
        let text = page.text().await.unwrap();
        assert!(
            text.contains("name=\"given_name\" value=\"")
                && !text.contains("name=\"given_name\" value=\"\""),
            "the donor's name prefilled"
        );
        let done = self
            .http
            .post(format!("{flow_url}/complete"))
            .form(&[("given_name", "Jo"), ("family_name", "Bloggs")])
            .send()
            .await
            .unwrap();
        assert_eq!(done.status(), 200);
        assert!(!done.text().await.unwrap().contains("didn’t land"));
    }

    async fn simulate(&self, path: &str) -> Value {
        let res = self
            .http
            .post(format!("{}/api/fake-gocardless/simulate/{path}", self.base))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{path}");
        let out: Value = res.json().await.unwrap();
        assert_eq!(out["delivered"], true, "{path}: {out}");
        out
    }

    /// A fake control (`simulate/…`) that answers no webhook.
    async fn fake_post(&self, path: &str, body: Value) -> Value {
        let res = self
            .http
            .post(format!("{}/api/fake-gocardless/simulate/{path}", self.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{path}");
        res.json().await.unwrap()
    }

    /// Wait out any run the webhook started, then handle what's left.
    async fn settle(&self) {
        process::process_pending(self.w.store.clone(), self.gc.clone())
            .await
            .unwrap();
    }

    async fn regular(&self, slug: &str, cookie: &str, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/{slug}/regular-gifts/{id}"),
            cookie,
            None,
        )
        .await
    }

    /// alpha connected, Jo's regular gift signed and active: (contact,
    /// regular gift, subscription).
    async fn active(&self) -> (String, String, String) {
        self.connect("alpha", &self.ann).await;
        let jo = self.contact("alpha", &self.sam).await;
        let v = self.set_up("alpha", &self.sam, &jo, &self.code).await;
        let id = v["id"].as_str().unwrap().to_owned();
        self.sign(v["flowUrl"].as_str().unwrap()).await;
        self.settle().await;
        let v = self.regular("alpha", &self.val, &id).await;
        let mandate = v["mandateId"].as_str().unwrap().to_owned();
        self.simulate(&format!("mandates/{mandate}/activate")).await;
        self.settle().await;
        (jo, id, v["subscriptionId"].as_str().unwrap().to_owned())
    }

    /// A new payment on `sub`, confirmed: (payment id, gift id).
    async fn collected(&self, id: &str, sub: &str) -> (String, String) {
        let pm = self.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
            .as_str()
            .unwrap()
            .to_owned();
        self.simulate(&format!("payments/{pm}/confirm")).await;
        self.settle().await;
        let v = self.regular("alpha", &self.val, id).await;
        let row = payment(&v, &pm);
        (pm, row["giftId"].as_str().unwrap().to_owned())
    }

    async fn gift(&self, id: &str) -> Value {
        ok(
            &self.w,
            "GET",
            &format!("/api/t/alpha/gifts/{id}"),
            &self.val,
            None,
        )
        .await
    }

    async fn post_webhook(&self, body: &str, signature: &str) -> u16 {
        self.http
            .post(format!("{}/api/gocardless/webhook", self.base))
            .header("Content-Type", "application/json")
            .header(SIGNATURE_HEADER, signature)
            .body(body.to_owned())
            .send()
            .await
            .unwrap()
            .status()
            .as_u16()
    }

    fn events(&self) -> Vec<(String, Option<String>, Option<String>)> {
        self.w
            .store
            .platform()
            .with_read(|c| {
                c.prepare("SELECT id, tenant_id, outcome FROM gocardless_events ORDER BY id")?
                    .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_admin_connects_and_disconnects_with_partner_oauth() {
    let t = setup().await;
    let before = ok(&t.w, "GET", "/api/t/alpha/gocardless", &t.val, None).await;
    assert_eq!(
        (
            before["enabled"].clone(),
            before["mode"].clone(),
            before["connected"].clone()
        ),
        (json!(true), json!("fake"), json!(false))
    );
    let status = t.connect("alpha", &t.ann).await;
    assert_eq!(status["connected"], true);
    let org = status["organisationId"].as_str().unwrap().to_owned();
    assert!(org.starts_with("OR"), "{org}");
    // The token is sealed in alpha's file: no plaintext in the row or its
    // revision.
    let db = t.w.store.org(&t.w.alpha.id).unwrap();
    let raw: Vec<String> = db
        .read(|r| {
            r.prepare(
                "SELECT ciphertext FROM tenant_settings
                 UNION ALL SELECT payload FROM revisions WHERE contract = 'tenantSettings.value'",
            )?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap();
    assert!(!raw.is_empty());
    assert!(raw.iter().all(|r| !r.contains("fake_token_")));
    // Beta sees nothing of it.
    let beta = ok(&t.w, "GET", "/api/t/beta/gocardless", &t.bob, None).await;
    assert_eq!(beta["connected"], false);

    let gone = ok(
        &t.w,
        "POST",
        "/api/t/alpha/gocardless/disconnect",
        &t.ann,
        None,
    )
    .await;
    assert_eq!(gone["connected"], false);
    let token = db.read(|r| t.gc.token(r)).unwrap();
    assert_eq!(token, None);
    // Webhooks for that account are now no organisation's.
    let body = json!({"events": [{"id": "EVgone1", "resource_type": "mandates",
        "action": "active", "links": {"mandate": "MD1", "organisation": org}}]})
    .to_string();
    let sig = sign(api::gocardless::fake::WEBHOOK_SECRET, body.as_bytes());
    assert_eq!(t.post_webhook(&body, &sig).await, 204);
    assert!(
        t.events()
            .contains(&("EVgone1".into(), None, Some("unknown_organisation".into())))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn only_an_admin_connects_and_the_state_is_single_use_and_this_sessions() {
    let t = setup().await;
    for cookie in [&t.sam, &t.val] {
        let (s, _) =
            t.w.call("POST", "/api/t/alpha/gocardless/connect", cookie, None)
                .await;
        assert_eq!(s, StatusCode::FORBIDDEN);
    }
    let (s, _) =
        t.w.call("POST", "/api/t/alpha/gocardless/connect", &t.bob, None)
            .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, _) =
        t.w.call("POST", "/api/t/alpha/gocardless/disconnect", &t.sam, None)
            .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // A state from ann's session, brought back by another session of
    // hers: refused, and spent.
    let start = ok(
        &t.w,
        "POST",
        "/api/t/alpha/gocardless/connect",
        &t.ann,
        None,
    )
    .await;
    let callback = t.consent(start["url"].as_str().unwrap(), "connect").await;
    let other = t.w.login("ann@alpha.org").await;
    let (_, landed) = navigate(&t.w, &callback, &other).await;
    assert_eq!(landed, "/?gocardless=expired");
    let (_, landed) = navigate(&t.w, &callback, &t.ann).await;
    assert_eq!(landed, "/?gocardless=expired", "spent on first sight");
    // A good one works once.
    let start = ok(
        &t.w,
        "POST",
        "/api/t/alpha/gocardless/connect",
        &t.ann,
        None,
    )
    .await;
    let callback = t.consent(start["url"].as_str().unwrap(), "connect").await;
    let (_, landed) = navigate(&t.w, &callback, &t.ann).await;
    assert_eq!(landed, "/t/alpha/settings?gocardless=connected");
    let (_, landed) = navigate(&t.w, &callback, &t.ann).await;
    assert_eq!(landed, "/?gocardless=expired");
    // The admin saying no.
    let start = ok(&t.w, "POST", "/api/t/beta/gocardless/connect", &t.bob, None).await;
    let callback = t.consent(start["url"].as_str().unwrap(), "cancel").await;
    let (_, landed) = navigate(&t.w, &callback, &t.bob).await;
    assert_eq!(landed, "/t/beta/settings?gocardless=denied");
    let beta = ok(&t.w, "GET", "/api/t/beta/gocardless", &t.bob, None).await;
    assert_eq!(beta["connected"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_webhook_needs_gocardless_signature_and_each_event_counts_once() {
    let t = setup().await;
    let status = t.connect("alpha", &t.ann).await;
    let org = status["organisationId"].as_str().unwrap();
    let body = json!({"events": [
        {"id": "EVsig1", "resource_type": "creditors", "action": "updated",
         "links": {"organisation": org}},
        {"id": "EVsig2", "resource_type": "mandates", "action": "active",
         "links": {"mandate": "MDnobody", "organisation": "ORnobody"}}
    ]})
    .to_string();
    let good = sign(api::gocardless::fake::WEBHOOK_SECRET, body.as_bytes());
    assert_eq!(t.post_webhook(&body, "00").await, 498);
    assert_eq!(
        t.post_webhook(&body, &sign("wrong", body.as_bytes())).await,
        498
    );
    assert_eq!(t.post_webhook(&format!("{body} "), &good).await, 498);
    assert!(t.events().is_empty(), "nothing read before the signature");
    assert_eq!(t.post_webhook(&body, &good).await, 204);
    assert_eq!(t.post_webhook(&body, &good).await, 204);
    t.settle().await;
    let events = t.events();
    assert_eq!(events.len(), 2, "a repeat is no new event");
    assert_eq!(
        events[0],
        (
            "EVsig1".into(),
            Some(t.w.alpha.id.as_str().to_owned()),
            Some("ignored".into())
        )
    );
    assert_eq!(
        events[1],
        ("EVsig2".into(), None, Some("unknown_organisation".into()))
    );
    // Off: the route isn't there.
    let off = world();
    let res = off
        .app
        .clone()
        .oneshot(request(
            "POST",
            "/api/gocardless/webhook",
            None,
            Some(json!({})),
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    let _ = res.into_body().collect().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_regular_gift_runs_from_sign_up_to_gifts_failures_chargebacks_and_cancellation() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    assert_eq!(v["status"], "pending");
    assert_eq!(v["connected"], true);
    let flow = v["flowUrl"].as_str().unwrap().to_owned();
    assert!(flow.starts_with(&format!("{}/api/fake-gocardless/flow/BRF", t.base)));
    let br = v["billingRequestId"].as_str().unwrap();
    assert_eq!(
        t.fake.resource(br).unwrap()["metadata"]["keep_regular_gift"],
        id.as_str()
    );

    // The donor signs: the mandate is linked and the subscription made.
    t.sign(&flow).await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    let mandate = v["mandateId"].as_str().unwrap().to_owned();
    let sub = v["subscriptionId"].as_str().unwrap().to_owned();
    assert_eq!(v["status"], "pending");
    let s = t.fake.resource(&sub).unwrap();
    assert_eq!(
        (
            s["amount"].clone(),
            s["interval_unit"].clone(),
            s["day_of_month"].clone()
        ),
        (json!(1000), json!("monthly"), json!(5))
    );
    assert_eq!(t.fake.ids("subscriptions").len(), 1);

    t.simulate(&format!("mandates/{mandate}/activate")).await;
    t.settle().await;
    assert_eq!(t.regular("alpha", &t.val, &id).await["status"], "active");

    // A payment is made: pending, no gift.
    let pm = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["payments"][0]["status"], "pending");
    assert_eq!(v["payments"][0]["giftId"], Value::Null);
    let gifts = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/gifts"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(gifts["rows"].as_array().unwrap().len(), 0);

    // Confirmed: the gift.
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["payments"][0]["status"], "confirmed");
    let gift = v["payments"][0]["giftId"].as_str().unwrap().to_owned();
    let g = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/gifts/{gift}"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(
        (
            g["method"].clone(),
            g["reference"].clone(),
            g["amount"].clone(),
            g["status"].clone()
        ),
        (
            json!("direct_debit"),
            json!(pm),
            json!(1000),
            json!("completed")
        )
    );
    assert_eq!(g["allocations"][0]["sourceCodeId"], t.code.as_str());
    assert_eq!(g["contactId"], jo.as_str());

    // GoCardless sends it again (a retry): nothing new.
    let (last, _) = t.fake.deliveries().last().unwrap().clone();
    let raw = last.to_string();
    let sig = sign(api::gocardless::fake::WEBHOOK_SECRET, raw.as_bytes());
    assert_eq!(t.post_webhook(&raw, &sig).await, 204);
    // And another event about the same payment: still one gift.
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let gifts = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/gifts"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(gifts["rows"].as_array().unwrap().len(), 1);

    // What GoCardless collected can't be edited, nor a DD gift entered by
    // hand.
    let mut save = g.clone();
    save["expected"] = g["giftVersion"].clone();
    save["amount"] = json!(2000);
    save["allocations"][0]["amount"] = json!(2000);
    let (s, out) =
        t.w.call(
            "POST",
            &format!("/api/t/alpha/gifts/{gift}/save"),
            &t.sam,
            Some(save),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["reason"], "direct_debit_fixed");
    let (s, out) =
        t.w.call(
            "POST",
            "/api/t/alpha/gifts/record",
            &t.sam,
            Some(json!({
                "clientKey": contracts::new_id(), "contact": jo,
                "receivedOn": "2026-10-20", "amount": 500, "method": "direct_debit",
                "reference": "PMbyhand",
                "allocations": [{ "sourceCodeId": t.code, "amount": 500 }]
            })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["reason"], "direct_debit_by_hand");

    // The next payment fails: no gift, shown on the regular gift.
    let pm2 = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm2}/fail")).await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["lastFailure"]["paymentId"], pm2.as_str());
    assert_eq!(v["lastFailure"]["giftId"], Value::Null);
    assert!(
        v["lastFailure"]["reason"]
            .as_str()
            .unwrap()
            .contains("insufficient funds")
    );

    // The first is charged back: its gift void, with the reason; then the
    // chargeback is cancelled: un-void.
    t.simulate(&format!("payments/{pm}/charge_back")).await;
    t.settle().await;
    let g = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/gifts/{gift}"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(g["status"], "void");
    let v = t.regular("alpha", &t.val, &id).await;
    let first = v["payments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["paymentId"] == pm.as_str())
        .unwrap()
        .clone();
    assert_eq!(first["status"], "chargedBack");
    assert!(first["reason"].as_str().unwrap().contains("disputed"));
    let history = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/gifts/{gift}/history"),
        &t.val,
        None,
    )
    .await;
    assert!(history.to_string().contains("charged back"), "{history}");
    t.simulate(&format!("payments/{pm}/cancel_chargeback"))
        .await;
    t.settle().await;
    let g = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/gifts/{gift}"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(g["status"], "completed");

    // The donor's bank cancels the mandate: the regular gift ends.
    t.simulate(&format!("mandates/{mandate}/cancel")).await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["status"], "cancelled");
    assert!(v["endedReason"].as_str().unwrap().contains("closed"));
    let list = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/regular-gifts"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    // Every event was handled, none failed.
    assert!(
        t.events()
            .iter()
            .all(|(_, _, outcome)| matches!(outcome.as_deref(), Some("done" | "ignored"))),
        "{:?}",
        t.events()
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn staff_cancel_a_regular_gift_and_get_a_new_link() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    let first_flow = v["flowUrl"].as_str().unwrap().to_owned();

    let fresh = ok(
        &t.w,
        "POST",
        &format!("/api/t/alpha/regular-gifts/{id}/link"),
        &t.sam,
        Some(json!({ "expected": v["mandateVersion"] })),
    )
    .await["view"]
        .clone();
    assert_ne!(fresh["flowUrl"], first_flow.as_str());
    assert_eq!(fresh["billingRequestId"], v["billingRequestId"]);

    // Stale: refused before GoCardless is touched.
    let (s, out) =
        t.w.call(
            "POST",
            &format!("/api/t/alpha/regular-gifts/{id}/cancel"),
            &t.sam,
            Some(json!({ "expected": v["mandateVersion"] })),
        )
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{out}");
    let br = v["billingRequestId"].as_str().unwrap();
    assert_eq!(t.fake.resource(br).unwrap()["status"], "pending");

    let done = ok(
        &t.w,
        "POST",
        &format!("/api/t/alpha/regular-gifts/{id}/cancel"),
        &t.sam,
        Some(json!({ "expected": fresh["mandateVersion"] })),
    )
    .await["view"]
        .clone();
    assert_eq!(done["status"], "cancelled");
    // GoCardless's own "cancelled" webhook can land before the route's
    // write (the fake delivers it at once): either reason is true, and it
    // ends once.
    let staff_or_gocardless = |r: &Value| {
        [
            "Cancelled by staff",
            "This billing request has been cancelled.",
        ]
        .contains(&r.as_str().unwrap_or(""))
    };
    assert!(staff_or_gocardless(&done["endedReason"]), "{done}");
    assert_eq!(t.fake.resource(br).unwrap()["status"], "cancelled");
    t.settle().await;
    assert_eq!(
        t.regular("alpha", &t.val, &id).await["endedReason"],
        done["endedReason"]
    );

    // An active one: its mandate is cancelled at GoCardless.
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    let mandate = v["mandateId"].as_str().unwrap().to_owned();
    let done = ok(
        &t.w,
        "POST",
        &format!("/api/t/alpha/regular-gifts/{id}/cancel"),
        &t.sam,
        Some(json!({ "expected": v["mandateVersion"] })),
    )
    .await["view"]
        .clone();
    assert_eq!(done["status"], "cancelled");
    assert_eq!(t.fake.resource(&mandate).unwrap()["status"], "cancelled");
    let sub = v["subscriptionId"].as_str().unwrap();
    assert_eq!(t.fake.resource(sub).unwrap()["status"], "cancelled");
    t.settle().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn set_up_needs_a_connection_staff_and_good_terms() {
    let t = setup().await;
    let jo = t.contact("alpha", &t.sam).await;
    let path = format!("/api/t/alpha/contacts/{jo}/regular-gifts");
    let terms = json!({ "amount": 1000, "frequency": "monthly", "dayOfMonth": 5,
                        "sourceCodeId": t.code });
    let (s, out) = t.w.call("POST", &path, &t.sam, Some(terms.clone())).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["reason"], "not_connected");
    t.connect("alpha", &t.ann).await;
    let (s, _) = t.w.call("POST", &path, &t.val, Some(terms.clone())).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    for (bad, field) in [
        (json!({ "amount": 0 }), "amount"),
        (json!({ "dayOfMonth": 29 }), "dayOfMonth"),
        (json!({ "frequency": "yearly" }), "month"),
        (json!({ "month": 3 }), "month"),
    ] {
        let mut body = terms.clone();
        for (k, v) in bad.as_object().unwrap() {
            body[k] = v.clone();
        }
        let (s, out) = t.w.call("POST", &path, &t.sam, Some(body)).await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
        assert_eq!(out["problems"][0]["field"], field, "{out}");
    }
    let mut yearly = terms.clone();
    yearly["frequency"] = json!("yearly");
    yearly["month"] = json!(4);
    let (s, out) = t.w.call("POST", &path, &t.sam, Some(yearly)).await;
    assert_eq!(s, StatusCode::OK, "{out}");
    // Nothing reached GoCardless for the refusals.
    assert_eq!(t.fake.ids("billing_requests").len(), 1);
    // The same client key twice is the first one.
    let mut keyed = terms.clone();
    keyed["clientKey"] = json!("k-1");
    let first = ok(&t.w, "POST", &path, &t.sam, Some(keyed.clone())).await;
    let (s, out) = t.w.call("POST", &path, &t.sam, Some(keyed)).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(out["id"], first["id"]);
    // Another organisation's code.
    let mut theirs = terms.clone();
    theirs["sourceCodeId"] = json!(t.beta_code);
    let (s, out) = t.w.call("POST", &path, &t.sam, Some(theirs)).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["reason"], "unknown_source_code");
}

#[tokio::test(flavor = "multi_thread")]
async fn another_organisation_never_sees_a_regular_gift() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    t.connect("beta", &t.bob).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap();
    let body = Some(json!({ "expected": v["mandateVersion"] }));
    for (method, path, body) in [
        ("GET", format!("/api/t/beta/regular-gifts/{id}"), None),
        (
            "GET",
            format!("/api/t/beta/contacts/{jo}/regular-gifts"),
            None,
        ),
        (
            "POST",
            format!("/api/t/beta/regular-gifts/{id}/link"),
            body.clone(),
        ),
        (
            "POST",
            format!("/api/t/beta/regular-gifts/{id}/cancel"),
            body.clone(),
        ),
        (
            "POST",
            format!("/api/t/beta/contacts/{jo}/regular-gifts"),
            Some(
                json!({ "amount": 1000, "frequency": "monthly", "dayOfMonth": 5,
                         "sourceCodeId": t.beta_code }),
            ),
        ),
    ] {
        let (s, out) = t.w.call(method, &path, &t.bob, body).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{method} {path}: {out}");
    }
    // Under alpha's slug, bob is no member.
    let (s, _) =
        t.w.call(
            "GET",
            &format!("/api/t/alpha/regular-gifts/{id}"),
            &t.bob,
            None,
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    // Beta's own list is empty; alpha's payment events never reach beta.
    let beta_jo = t.contact("beta", &t.bob).await;
    let list = ok(
        &t.w,
        "GET",
        &format!("/api/t/beta/contacts/{beta_jo}/regular-gifts"),
        &t.bob,
        None,
    )
    .await;
    assert_eq!(list, json!([]));
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    t.settle().await;
    let beta_db = t.w.store.org(&t.w.beta.id).unwrap();
    let n: i64 = beta_db
        .read(|r| r.query_row("SELECT count(*) FROM regular_gifts", [], |row| row.get(0)))
        .unwrap();
    assert_eq!(n, 0);
    assert!(
        t.events()
            .iter()
            .all(|(_, tenant, _)| tenant.as_deref() == Some(t.w.alpha.id.as_str()))
    );
}

#[tokio::test]
async fn with_gocardless_off_only_the_status_answers() {
    let w = world();
    let ann = w.login("ann@alpha.org").await;
    let status = ok(&w, "GET", "/api/t/alpha/gocardless", &ann, None).await;
    assert_eq!(status["enabled"], false);
    assert_eq!(status["mode"], "off");
    for (method, path) in [
        ("POST", "/api/t/alpha/gocardless/connect"),
        ("POST", "/api/t/alpha/gocardless/disconnect"),
        (
            "GET",
            "/api/t/alpha/regular-gifts/0190f0c0a0b0c0d0e0f0a0b0c0d0e0e1",
        ),
    ] {
        let (s, _) = w.call(method, path, &ann, None).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
    }
    let (s, _) = navigate(&w, "/api/gocardless/callback?code=x&state=y", &ann).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

/// Routing a webhook reads `platform.db`; if that read fails the batch
/// fails (GoCardless retries a 5xx), and no event is filed as an unknown
/// organisation's.
#[test]
fn a_routing_read_that_fails_fails_the_batch() {
    let w = world();
    let events = api::gocardless::webhook::parse(
        br#"{"events":[{"id":"EVerr","resource_type":"payments","action":"confirmed",
            "links":{"payment":"PM1","organisation":"OR1"}}]}"#,
    )
    .unwrap();
    w.store
        .platform()
        .with_write(|tx| {
            tx.execute_batch(
                "ALTER TABLE gocardless_connections RENAME COLUMN organisation_id TO gone",
            )
        })
        .unwrap();
    let stored = api::gocardless::webhook::store_events(&w.store, &events, 1);
    assert!(stored.is_err(), "{stored:?}");
    let n: i64 = w
        .store
        .platform()
        .with_read(|c| c.query_row("SELECT count(*) FROM gocardless_events", [], |r| r.get(0)))
        .unwrap();
    assert_eq!(n, 0);
}

/// Reviewer H1: GoCardless can fail a payment after confirming it (a Bacs
/// late failure). The gift goes void with the reason; if a retry is then
/// collected, the same gift counts again (one payment id, one gift).
#[tokio::test(flavor = "multi_thread")]
async fn a_late_failure_voids_the_gift_and_a_collected_retry_restores_it() {
    let t = setup().await;
    let (jo, id, sub) = t.active().await;
    let (pm, gift) = t.collected(&id, &sub).await;
    assert_eq!(t.gift(&gift).await["status"], "completed");

    t.simulate(&format!("payments/{pm}/fail")).await;
    t.settle().await;
    assert_eq!(t.gift(&gift).await["status"], "void");
    let v = t.regular("alpha", &t.val, &id).await;
    let row = payment(&v, &pm);
    assert_eq!(row["status"], "failed");
    assert!(
        row["reason"]
            .as_str()
            .unwrap()
            .contains("insufficient funds")
    );
    let history = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/gifts/{gift}/history"),
        &t.val,
        None,
    )
    .await;
    assert!(
        history
            .to_string()
            .contains("failed after it was collected"),
        "{history}"
    );

    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    assert_eq!(t.gift(&gift).await["status"], "completed");
    let gifts = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/gifts"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(
        gifts["rows"].as_array().unwrap().len(),
        1,
        "never a second gift"
    );
}

/// Reviewer M4: a gift staff voided stays void when a chargeback on it is
/// cancelled; and staff can't un-void a charged-back gift (the money went
/// back to the donor).
#[tokio::test(flavor = "multi_thread")]
async fn a_staff_void_outlives_a_cancelled_chargeback_and_returned_money_stays_void() {
    let t = setup().await;
    let (_, id, sub) = t.active().await;

    let (pm, gift) = t.collected(&id, &sub).await;
    let g = t.gift(&gift).await;
    ok(
        &t.w,
        "POST",
        &format!("/api/t/alpha/gifts/{gift}/status"),
        &t.sam,
        Some(json!({ "expected": g["statusVersion"], "status": "void" })),
    )
    .await;
    t.simulate(&format!("payments/{pm}/charge_back")).await;
    t.settle().await;
    t.simulate(&format!("payments/{pm}/cancel_chargeback"))
        .await;
    t.settle().await;
    assert_eq!(t.gift(&gift).await["status"], "void", "staff's void kept");

    let (pm2, gift2) = t.collected(&id, &sub).await;
    t.simulate(&format!("payments/{pm2}/charge_back")).await;
    t.settle().await;
    let g = t.gift(&gift2).await;
    assert_eq!(g["status"], "void");
    let (s, out) =
        t.w.call(
            "POST",
            &format!("/api/t/alpha/gifts/{gift2}/status"),
            &t.sam,
            Some(json!({ "expected": g["statusVersion"], "status": "completed" })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["reason"], "direct_debit_returned");
    // The system still restores it when the chargeback is cancelled.
    t.simulate(&format!("payments/{pm2}/cancel_chargeback"))
        .await;
    t.settle().await;
    assert_eq!(t.gift(&gift2).await["status"], "completed");
}

/// Codex 4 and reviewer L3: a mandate's events can overtake its billing
/// request's. A cancellation that arrives first still ends the regular
/// gift (identifying a mandate never makes a subscription), the later
/// "fulfilled" makes none, and identifying it costs one mandate lookup,
/// not one per pending regular gift.
#[tokio::test(flavor = "multi_thread")]
async fn a_mandate_cancelled_before_its_billing_request_is_fulfilled_still_ends_the_gift() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    for _ in 0..3 {
        t.set_up("alpha", &t.sam, &jo, &t.code).await;
    }
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.fake_post("webhooks/hold", json!({})).await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    let br = t
        .fake
        .resource(v["billingRequestId"].as_str().unwrap())
        .unwrap();
    let mandate = br["links"]["mandate_request_mandate"]
        .as_str()
        .unwrap()
        .to_owned();
    t.fake_post(&format!("mandates/{mandate}/cancel"), json!({}))
        .await;
    let before = t.fake.calls("GET billing_requests");
    t.simulate("webhooks/release?reverse=true").await;
    t.settle().await;

    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["status"], "cancelled", "{v}");
    assert_eq!(v["mandateId"], mandate.as_str());
    assert_eq!(v["subscriptionId"], Value::Null);
    assert!(t.fake.ids("subscriptions").is_empty());
    assert!(
        t.fake.calls("GET billing_requests") - before <= 1,
        "no billing request lookup per pending regular gift"
    );
    assert!(
        t.events()
            .iter()
            .all(|(_, _, outcome)| matches!(outcome.as_deref(), Some("done" | "ignored"))),
        "{:?}",
        t.events()
    );
}

/// Codex 3 (a): staff cancel a regular gift whose donor has just signed
/// (the webhook not yet in): the billing request can't be cancelled any
/// more, so its mandate is, and no subscription follows.
#[tokio::test(flavor = "multi_thread")]
async fn cancelling_as_the_donor_signs_cancels_the_mandate_and_no_subscription_follows() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.fake_post("webhooks/hold", json!({})).await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    let done = ok(
        &t.w,
        "POST",
        &format!("/api/t/alpha/regular-gifts/{id}/cancel"),
        &t.sam,
        Some(json!({ "expected": v["mandateVersion"] })),
    )
    .await["view"]
        .clone();
    assert_eq!(done["status"], "cancelled");
    let br = t
        .fake
        .resource(v["billingRequestId"].as_str().unwrap())
        .unwrap();
    let mandate = br["links"]["mandate_request_mandate"].as_str().unwrap();
    assert_eq!(t.fake.resource(mandate).unwrap()["status"], "cancelled");
    t.simulate("webhooks/release").await;
    t.settle().await;
    assert!(t.fake.ids("subscriptions").is_empty());
    assert_eq!(t.regular("alpha", &t.val, &id).await["status"], "cancelled");
}

/// Codex 3 (b): the regular gift ends while GoCardless is making its
/// subscription. The subscription is recorded and cancelled at once, not
/// left collecting under a cancelled regular gift.
#[tokio::test(flavor = "multi_thread")]
async fn a_regular_gift_that_ends_while_its_subscription_is_made_cancels_it() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.fake_post(
        "outage",
        json!({ "calls": 1, "path": "subscriptions", "delay_ms": 1500 }),
    )
    .await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    // Ended meanwhile, here only (as a staff cancel racing it would).
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let db = t.w.store.org(&t.w.alpha.id).unwrap();
    let rid = id.clone();
    contracts::transact(&db, None, move |ctx| {
        giving::regular::end_regular_gift(
            ctx,
            &rid,
            None,
            giving::regular::RegularStatus::Cancelled,
            Some("ended meanwhile".into()),
            contracts::Source::Test,
        )
    })
    .unwrap();
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["status"], "cancelled");
    let sub = v["subscriptionId"].as_str().expect("recorded");
    assert_eq!(t.fake.resource(sub).unwrap()["status"], "cancelled");
}

impl T {
    /// Every queued event's wait cut short.
    fn due_now(&self) {
        self.w
            .store
            .platform()
            .with_write(|tx| {
                tx.execute(
                    "UPDATE gocardless_events SET next_attempt_at = 0
                     WHERE processed_at IS NULL",
                    [],
                )
            })
            .unwrap();
    }

    fn attempts(&self, event_outcome_null: bool) -> Vec<i64> {
        self.w
            .store
            .platform()
            .with_read(|c| {
                c.prepare(&format!(
                    "SELECT attempts FROM gocardless_events WHERE outcome IS {}NULL",
                    if event_outcome_null { "" } else { "NOT " }
                ))?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<i64>>>()
            })
            .unwrap()
    }
}

/// Reviewer H2: a GoCardless outage longer than a few runs never drops an
/// event. It waits (backing off) and is handled once GoCardless answers.
#[tokio::test(flavor = "multi_thread")]
async fn an_outage_delays_events_but_never_drops_them() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.fake_post("outage", json!({ "calls": 100_000, "status": 503 }))
        .await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    for _ in 0..15 {
        t.due_now();
        t.settle().await;
    }
    let waiting = t.attempts(true);
    assert!(!waiting.is_empty(), "still queued: {:?}", t.events());
    assert!(waiting.iter().any(|n| *n >= 15), "{waiting:?}");
    assert!(
        t.events()
            .iter()
            .all(|(_, _, o)| o.as_deref() != Some("failed")),
        "{:?}",
        t.events()
    );
    let next: i64 =
        t.w.store
            .platform()
            .with_read(|c| {
                c.query_row(
                    "SELECT max(next_attempt_at) FROM gocardless_events WHERE processed_at IS NULL",
                    [],
                    |r| r.get(0),
                )
            })
            .unwrap();
    assert!(next > contracts::now_ms(), "waiting, not hammering");

    t.fake_post("outage", json!({ "calls": 0 })).await;
    t.due_now();
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert!(v["subscriptionId"].is_string(), "{v}");
    assert!(t.attempts(true).is_empty(), "{:?}", t.events());
    assert!(backoff_is_bounded());
}

fn backoff_is_bounded() -> bool {
    use api::gocardless::process::backoff;
    backoff(1) == 30_000 && backoff(2) == 60_000 && backoff(50) == 3_600_000
}

/// Reviewer H2: an event GoCardless refuses outright is parked (counted,
/// an admin can put it back), and the regular gift its billing request
/// fulfilled still gets its subscription.
#[tokio::test(flavor = "multi_thread")]
async fn a_parked_event_is_visible_retryable_and_never_leaves_a_mandate_without_a_subscription() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.fake_post(
        "outage",
        json!({ "calls": 1, "status": 422, "path": "subscriptions" }),
    )
    .await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    t.settle().await;
    let status = ok(&t.w, "GET", "/api/t/alpha/gocardless", &t.val, None).await;
    assert_eq!(status["failedEvents"], 1, "{:?}", t.events());
    // The sweep made the subscription anyway.
    let v = t.regular("alpha", &t.val, &id).await;
    assert!(v["mandateId"].is_string());
    assert!(v["subscriptionId"].is_string(), "{v}");

    let (s, _) =
        t.w.call("POST", "/api/t/alpha/gocardless/events/retry", &t.sam, None)
            .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let status = ok(
        &t.w,
        "POST",
        "/api/t/alpha/gocardless/events/retry",
        &t.ann,
        None,
    )
    .await;
    assert_eq!(status["failedEvents"], 0);
    t.settle().await;
    assert!(
        t.events()
            .iter()
            .all(|(_, _, o)| matches!(o.as_deref(), Some("done" | "ignored"))),
        "{:?}",
        t.events()
    );
    assert_eq!(t.fake.ids("subscriptions").len(), 1);
}

impl T {
    /// The token sealed in `tenant`'s file, if any.
    fn token_of(&self, tenant: &store::Tenant) -> Option<String> {
        let db = self.w.store.org(&tenant.id).unwrap();
        db.read(|r| self.gc.token(r)).unwrap()
    }

    /// `slug`'s admin starts connecting and picks `account` on the consent
    /// page: the callback path to bring back.
    async fn start_connect(&self, slug: &str, cookie: &str, account: &str) -> String {
        let start = ok(
            &self.w,
            "POST",
            &format!("/api/t/{slug}/gocardless/connect"),
            cookie,
            None,
        )
        .await;
        self.consent_as(start["url"].as_str().unwrap(), "connect", account)
            .await
    }
}

/// Reviewer M1: a second group connecting an account another group here
/// holds is refused, keeps no token, and the holder keeps a working one
/// (GoCardless disabled its old token when it issued the new).
#[tokio::test(flavor = "multi_thread")]
async fn connecting_an_account_another_group_holds_is_refused_and_the_holder_keeps_working() {
    let t = setup().await;
    let status = t.connect("alpha", &t.ann).await;
    let account = status["organisationId"].as_str().unwrap().to_owned();
    let alpha_before = t.token_of(&t.w.alpha).unwrap();

    let callback = t.start_connect("beta", &t.bob, &account).await;
    let (_, landed) = navigate(&t.w, &callback, &t.bob).await;
    assert_eq!(landed, "/t/beta/settings?gocardless=taken");
    let beta = ok(&t.w, "GET", "/api/t/beta/gocardless", &t.bob, None).await;
    assert_eq!(beta["connected"], false);
    assert_eq!(
        t.token_of(&t.w.beta),
        None,
        "the refused group keeps no token"
    );

    let alpha_now = t.token_of(&t.w.alpha).unwrap();
    assert!(!t.fake.token_works(&alpha_before), "GoCardless disabled it");
    assert!(t.fake.token_works(&alpha_now), "the holder has the new one");
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    assert_eq!(v["status"], "pending");
    let beta_jo = t.contact("beta", &t.bob).await;
    let (s, out) =
        t.w.call(
            "POST",
            &format!("/api/t/beta/contacts/{beta_jo}/regular-gifts"),
            &t.bob,
            Some(
                json!({ "amount": 1000, "frequency": "monthly", "dayOfMonth": 5,
                         "sourceCodeId": t.beta_code }),
            ),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(out["reason"], "not_connected");
}

/// Reviewer M2 / codex 1: two groups' callbacks for one account at once.
/// One owns it; the other is refused and holds no token; the owner's
/// token is the one GoCardless still accepts.
#[tokio::test(flavor = "multi_thread")]
async fn two_groups_connecting_one_account_at_once_leave_one_owner_with_a_working_token() {
    let t = setup().await;
    let (account, _) = t.fake.connect_account();
    let a = t.start_connect("alpha", &t.ann, &account).await;
    let b = t.start_connect("beta", &t.bob, &account).await;
    let ((_, landed_a), (_, landed_b)) =
        tokio::join!(navigate(&t.w, &a, &t.ann), navigate(&t.w, &b, &t.bob));
    let mut outcomes: Vec<&str> = [&landed_a, &landed_b]
        .iter()
        .map(|l| l.rsplit('=').next().unwrap())
        .collect();
    outcomes.sort();
    assert_eq!(outcomes, ["connected", "taken"], "{landed_a} {landed_b}");
    let (owner, loser) = if landed_a.ends_with("connected") {
        (&t.w.alpha, &t.w.beta)
    } else {
        (&t.w.beta, &t.w.alpha)
    };
    assert_eq!(t.token_of(loser), None);
    assert!(t.fake.token_works(&t.token_of(owner).unwrap()));
    let owners: i64 =
        t.w.store
            .platform()
            .with_read(|c| {
                c.query_row(
                    "SELECT count(*) FROM gocardless_connections WHERE organisation_id = ?1",
                    [&account],
                    |r| r.get(0),
                )
            })
            .unwrap();
    assert_eq!(owners, 1);
}

/// Reviewer L5: switching to another GoCardless account revokes the old
/// account's token instead of leaving it live.
#[tokio::test(flavor = "multi_thread")]
async fn switching_accounts_revokes_the_old_accounts_token() {
    let t = setup().await;
    let first = t.connect("alpha", &t.ann).await;
    let old = t.token_of(&t.w.alpha).unwrap();
    let second = t.connect("alpha", &t.ann).await;
    assert_ne!(first["organisationId"], second["organisationId"]);
    assert!(
        !t.fake.token_works(&old),
        "the old account's token is revoked"
    );
    assert!(t.fake.token_works(&t.token_of(&t.w.alpha).unwrap()));
}

/// Reviewer L4: an admin who removed the app in GoCardless's dashboard
/// can still disconnect here (the revoke is refused: nothing to revoke).
#[tokio::test(flavor = "multi_thread")]
async fn disconnect_works_when_gocardless_no_longer_knows_the_token() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let token = t.token_of(&t.w.alpha).unwrap();
    let res = t
        .http
        .post(format!(
            "{}/api/fake-gocardless/connect/oauth/revoke",
            t.base
        ))
        .form(&[
            ("token", token.as_str()),
            ("client_id", api::gocardless::fake::CLIENT_ID),
            ("client_secret", api::gocardless::fake::CLIENT_SECRET),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let gone = ok(
        &t.w,
        "POST",
        "/api/t/alpha/gocardless/disconnect",
        &t.ann,
        None,
    )
    .await;
    assert_eq!(gone["connected"], false);
    assert_eq!(t.token_of(&t.w.alpha), None);
}

/// Reviewer M3: disconnecting doesn't stop GoCardless collecting, so
/// what happens meanwhile is kept: events queued at the disconnect (set
/// aside) and those that arrive after it (for an account no group here
/// holds) are replayed when the group connects the same account again.
#[tokio::test(flavor = "multi_thread")]
async fn payments_during_a_disconnect_become_gifts_on_reconnect() {
    let t = setup().await;
    let (jo, id, sub) = t.active().await;
    let status = ok(&t.w, "GET", "/api/t/alpha/gocardless", &t.val, None).await;
    let account = status["organisationId"].as_str().unwrap().to_owned();

    // One payment's events wait (GoCardless failing) at the disconnect...
    t.fake_post(
        "outage",
        json!({ "calls": 100_000, "status": 503, "path": "payments" }),
    )
    .await;
    let early = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{early}/confirm")).await;
    t.settle().await;
    ok(
        &t.w,
        "POST",
        "/api/t/alpha/gocardless/disconnect",
        &t.ann,
        None,
    )
    .await;
    t.fake_post("outage", json!({ "calls": 0 })).await;
    t.due_now();
    t.settle().await;
    // ...another arrives after it.
    let late = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{late}/confirm")).await;
    t.settle().await;
    let gifts = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/gifts"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(gifts["rows"].as_array().unwrap().len(), 0);

    let callback = t.start_connect("alpha", &t.ann, &account).await;
    let (_, landed) = navigate(&t.w, &callback, &t.ann).await;
    assert_eq!(landed, "/t/alpha/settings?gocardless=connected");
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    for pm in [&early, &late] {
        let row = payment(&v, pm);
        assert_eq!(row["status"], "confirmed", "{pm}: {v}");
        assert!(row["giftId"].is_string());
    }
    let gifts = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/gifts"),
        &t.val,
        None,
    )
    .await;
    assert_eq!(gifts["rows"].as_array().unwrap().len(), 2);
}

fn uk_day(days_from_now: i64) -> String {
    giftaid::uk_date(contracts::now_ms() + days_from_now * 86_400_000)
}

impl T {
    /// A Gift Aid donor (address, declaration) through a cash gift, as
    /// alpha's admin: the contact's id.
    async fn gift_aid_donor(&self) -> String {
        ok(
            &self.w,
            "POST",
            "/api/t/alpha/gifts/record",
            &self.ann,
            Some(json!({
                "clientKey": contracts::new_id(),
                "contact": { "kind": "individual", "firstName": "Ann", "lastName": "Smith",
                             "name": "" },
                "home": { "line1": "12 High Street", "postcode": "ls1 1aa" },
                "giftAid": {},
                "receivedOn": uk_day(-10),
                "amount": 500,
                "method": "cash",
                "allocations": [{ "sourceCodeId": self.code, "amount": 500 }],
            })),
        )
        .await["contactId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// A Gift Aid claim of everything eligible up to today, sent to HMRC.
    async fn claim_and_send(&self) -> Value {
        let claim = ok(
            &self.w,
            "POST",
            "/api/t/alpha/giftaid/claims",
            &self.ann,
            Some(json!({ "periodEnd": uk_day(0) })),
        )
        .await["claims"][0]
            .clone();
        let id = claim["id"].as_str().unwrap().to_owned();
        for step in [
            json!({ "status": "ready" }),
            json!({ "status": "submitted", "submittedOn": uk_day(0), "hmrcReference": "CHAR-1" }),
        ] {
            let now = ok(
                &self.w,
                "GET",
                &format!("/api/t/alpha/giftaid/claims/{id}"),
                &self.ann,
                None,
            )
            .await;
            let mut body = step;
            body["expected"] = now["statusVersion"].clone();
            ok(
                &self.w,
                "POST",
                &format!("/api/t/alpha/giftaid/claims/{id}/status"),
                &self.ann,
                Some(body),
            )
            .await;
        }
        claim
    }

    async fn adjustments(&self) -> Value {
        ok(
            &self.w,
            "GET",
            &format!(
                "/api/t/alpha/giftaid/claims/preview?periodEnd={}",
                uk_day(0)
            ),
            &self.ann,
            None,
        )
        .await["adjustments"]
            .clone()
    }
}

/// A Direct Debit gift already claimed for Gift Aid, then charged back
/// or failed late: voided with GoCardless's reason (a claimed gift needs
/// one), and the next claim pays its tax back (an adjustment). Its void
/// is final, so if the money comes back after all it is recorded again,
/// as a new gift: one completed gift per payment.
#[tokio::test(flavor = "multi_thread")]
async fn a_claimed_direct_debit_gift_charged_back_or_failed_late_is_adjusted_not_refused() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let ann = t.gift_aid_donor().await;
    let v = t.set_up("alpha", &t.sam, &ann, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    let sub = v["subscriptionId"].as_str().unwrap().to_owned();
    t.simulate(&format!(
        "mandates/{}/activate",
        v["mandateId"].as_str().unwrap()
    ))
    .await;
    let pay = |days: i64| format!("subscriptions/{sub}/payment?charge_date={}", uk_day(-days));

    // Collected, then claimed and sent to HMRC.
    let pm = t.simulate(&pay(5)).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let gift = payment(&t.regular("alpha", &t.val, &id).await, &pm)["giftId"]
        .as_str()
        .unwrap()
        .to_owned();
    let claim = t.claim_and_send().await;
    assert!(
        claim["lines"].to_string().contains(&gift),
        "the DD gift is claimed: {claim}"
    );
    assert_eq!(t.gift(&gift).await["claimId"], claim["id"]);

    // Charged back: void with the reason, and the next claim adjusts.
    t.simulate(&format!("payments/{pm}/charge_back")).await;
    t.settle().await;
    let g = t.gift(&gift).await;
    assert_eq!(g["status"], "void");
    let reason = g["voidReason"].as_str().unwrap();
    assert!(
        reason.starts_with("Charged back (GoCardless): "),
        "{reason}"
    );
    let adjustments = t.adjustments().await;
    assert_eq!(adjustments[0]["giftId"], gift.as_str(), "{adjustments}");
    assert_eq!(adjustments[0]["reason"], reason);
    assert!(
        t.events()
            .iter()
            .all(|(_, _, o)| matches!(o.as_deref(), Some("done" | "ignored"))),
        "nothing refused: {:?}",
        t.events()
    );

    // The chargeback is cancelled: the claimed void stays, a new gift
    // records the money.
    t.simulate(&format!("payments/{pm}/cancel_chargeback"))
        .await;
    t.settle().await;
    assert_eq!(t.gift(&gift).await["status"], "void");
    let row = payment(&t.regular("alpha", &t.val, &id).await, &pm);
    let again = row["giftId"].as_str().unwrap().to_owned();
    assert_ne!(again, gift);
    let g = t.gift(&again).await;
    assert_eq!(
        (
            g["status"].clone(),
            g["reference"].clone(),
            g["claimId"].clone()
        ),
        (json!("completed"), json!(pm), Value::Null)
    );

    // A later payment, claimed, then failed late: the same.
    let pm2 = t.simulate(&pay(3)).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm2}/confirm")).await;
    t.settle().await;
    let gift2 = payment(&t.regular("alpha", &t.val, &id).await, &pm2)["giftId"]
        .as_str()
        .unwrap()
        .to_owned();
    t.claim_and_send().await;
    assert!(t.gift(&gift2).await["claimId"].is_string());
    t.simulate(&format!("payments/{pm2}/fail")).await;
    t.settle().await;
    let g = t.gift(&gift2).await;
    assert_eq!(g["status"], "void");
    assert!(
        g["voidReason"]
            .as_str()
            .unwrap()
            .starts_with("Failed after it was collected (GoCardless): ")
    );
    assert!(t.adjustments().await.to_string().contains(gift2.as_str()));
}

impl T {
    /// Seal `token` into `tenant`'s file directly ("" forgets it).
    fn seal(&self, tenant: &store::Tenant, token: &str) {
        let db = self.w.store.org(&tenant.id).unwrap();
        let gc = self.gc.clone();
        let token = token.to_owned();
        contracts::transact(&db, None, move |ctx| {
            gc.put_token(ctx, &token, contracts::Source::Test)
        })
        .unwrap();
    }

    fn outcome_of_events(&self) -> Vec<Option<String>> {
        self.events().into_iter().map(|(_, _, o)| o).collect()
    }
}

/// Second review M-1: a run that finds an organisation connected (it owns
/// the mapping) but no token in its file (a connect still landing) never
/// sets its events aside: they wait, and become gifts once the token is
/// there.
#[tokio::test(flavor = "multi_thread")]
async fn connected_without_a_token_waits_and_never_sets_events_aside() {
    let t = setup().await;
    let (_, id, sub) = t.active().await;
    let token = t.token_of(&t.w.alpha).unwrap();
    t.seal(&t.w.alpha, "");
    let pm = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.due_now();
    t.settle().await;
    assert!(
        !t.outcome_of_events()
            .iter()
            .any(|o| o.as_deref() == Some("not_connected")),
        "{:?}",
        t.events()
    );
    assert!(!t.attempts(true).is_empty(), "still queued");

    t.seal(&t.w.alpha, &token);
    t.due_now();
    t.settle().await;
    let row = payment(&t.regular("alpha", &t.val, &id).await, &pm);
    assert!(row["giftId"].is_string(), "{row}");
}

/// Second review M-2: switching to another GoCardless account doesn't
/// lose the old one's money (GoCardless keeps collecting it): its events
/// queued at the switch are set aside, never run with the new account's
/// token; those that come after are kept through the purge; switching
/// back replays both.
#[tokio::test(flavor = "multi_thread")]
async fn switching_accounts_keeps_the_old_accounts_events_for_switching_back() {
    let t = setup().await;
    let (_, id, sub) = t.active().await;
    let x = ok(&t.w, "GET", "/api/t/alpha/gocardless", &t.val, None).await["organisationId"]
        .as_str()
        .unwrap()
        .to_owned();

    // One of X's payments is still queued at the switch...
    t.fake_post(
        "outage",
        json!({ "calls": 100_000, "status": 503, "path": "payments" }),
    )
    .await;
    let queued = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{queued}/confirm")).await;
    t.settle().await;
    let y = t.connect("alpha", &t.ann).await["organisationId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(x, y);
    t.fake_post("outage", json!({ "calls": 0 })).await;
    t.due_now();
    t.settle().await;
    assert!(
        !t.outcome_of_events()
            .iter()
            .any(|o| o.as_deref() == Some("failed")),
        "never run with Y's token: {:?}",
        t.events()
    );
    // ...another comes after it.
    let later = t.simulate(&format!("subscriptions/{sub}/payment")).await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{later}/confirm")).await;
    t.settle().await;
    let before = t.events().len();
    api::gocardless::process::purge(&t.w.store, contracts::now_ms() + 100 * 86_400_000).unwrap();
    let x_events: i64 =
        t.w.store
            .platform()
            .with_read(|c| {
                c.query_row(
                    "SELECT count(*) FROM gocardless_events WHERE organisation_id = ?1",
                    [&x],
                    |r| r.get(0),
                )
            })
            .unwrap();
    assert!(
        x_events >= 4,
        "X's events kept through the purge ({x_events} of {before})"
    );

    let callback = t.start_connect("alpha", &t.ann, &x).await;
    let (_, landed) = navigate(&t.w, &callback, &t.ann).await;
    assert_eq!(landed, "/t/alpha/settings?gocardless=connected");
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    for pm in [&queued, &later] {
        let row = payment(&v, pm);
        assert_eq!(row["status"], "confirmed", "{pm}: {v}");
        assert!(row["giftId"].is_string());
    }
}

/// Second review L-a: a gift is dated when GoCardless collected the money,
/// which decides its tax year. A late failure retried and collected on
/// another day is a new gift on that day; the failed attempt's stays void.
#[tokio::test(flavor = "multi_thread")]
async fn a_retry_collected_on_another_day_is_a_gift_on_that_day() {
    let t = setup().await;
    let (jo, id, sub) = t.active().await;
    let first_day = uk_day(-2);
    let pm = t
        .simulate(&format!(
            "subscriptions/{sub}/payment?charge_date={first_day}"
        ))
        .await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let first = payment(&t.regular("alpha", &t.val, &id).await, &pm)["giftId"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm}/fail")).await;
    t.settle().await;
    assert_eq!(t.gift(&first).await["status"], "void");

    let retry_day = uk_day(5);
    t.simulate(&format!("payments/{pm}/retry?charge_date={retry_day}"))
        .await;
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let row = payment(&t.regular("alpha", &t.val, &id).await, &pm);
    assert_eq!(row["chargeDate"], retry_day.as_str());
    let again = row["giftId"].as_str().unwrap().to_owned();
    assert_ne!(again, first);
    let g = t.gift(&again).await;
    assert_eq!(
        (g["status"].clone(), g["receivedOn"].clone()),
        (json!("completed"), json!(retry_day))
    );
    let f = t.gift(&first).await;
    assert_eq!(
        (f["status"].clone(), f["receivedOn"].clone()),
        (json!("void"), json!(first_day))
    );
    let gifts = ok(
        &t.w,
        "GET",
        &format!("/api/t/alpha/contacts/{jo}/gifts"),
        &t.val,
        None,
    )
    .await;
    let completed = gifts["rows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|g| g["status"] == "completed")
        .count();
    assert_eq!(completed, 1, "one completed gift per payment");
}

/// Second review L-b: a Direct Debit gift whose payment was recorded
/// again as another gift (a retry on another day here; or a claimed void
/// whose claim was later deleted) can't be un-voided: a clear 422, not
/// the unique index's 500.
#[tokio::test(flavor = "multi_thread")]
async fn un_voiding_a_gift_whose_payment_was_recorded_again_is_refused_clearly() {
    let t = setup().await;
    let (_, id, sub) = t.active().await;
    let pm = t
        .simulate(&format!(
            "subscriptions/{sub}/payment?charge_date={}",
            uk_day(-2)
        ))
        .await["payment"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let first = payment(&t.regular("alpha", &t.val, &id).await, &pm)["giftId"]
        .as_str()
        .unwrap()
        .to_owned();
    t.simulate(&format!("payments/{pm}/fail")).await;
    t.settle().await;
    t.simulate(&format!("payments/{pm}/retry?charge_date={}", uk_day(5)))
        .await;
    t.simulate(&format!("payments/{pm}/confirm")).await;
    t.settle().await;
    let g = t.gift(&first).await;
    assert_eq!(g["status"], "void");
    let (s, out) =
        t.w.call(
            "POST",
            &format!("/api/t/alpha/gifts/{first}/status"),
            &t.sam,
            Some(json!({ "expected": g["statusVersion"], "status": "completed" })),
        )
        .await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY, "{out}");
    assert_eq!(out["reason"], "direct_debit_recorded_again");
}

/// Second review L-c: a disconnect and another group's connect to the same
/// account can't interleave (disconnect takes the connect lock). Whatever
/// the order, every token GoCardless still accepts for the account is in
/// the file of the group that owns its mapping: none left live and lost.
#[tokio::test(flavor = "multi_thread")]
async fn a_disconnect_and_a_connect_to_the_same_account_dont_interleave() {
    let t = setup().await;
    let x = t.connect("alpha", &t.ann).await["organisationId"]
        .as_str()
        .unwrap()
        .to_owned();
    let callback = t.start_connect("beta", &t.bob, &x).await;
    // The revoke takes a while: long enough for the callback to run in
    // the middle of the disconnect, were it allowed to.
    t.fake_post(
        "outage",
        json!({ "calls": 1, "path": "revoke", "delay_ms": 800 }),
    )
    .await;
    let disconnect =
        t.w.call("POST", "/api/t/alpha/gocardless/disconnect", &t.ann, None);
    let connect = async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        navigate(&t.w, &callback, &t.bob).await
    };
    let ((s, _), (_, landed)) = tokio::join!(disconnect, connect);
    assert_eq!(s, StatusCode::OK);
    assert_eq!(landed, "/t/beta/settings?gocardless=connected");
    let owner: Option<String> =
        t.w.store
            .platform()
            .with_read(|c| {
                c.query_row(
                    "SELECT tenant_id FROM gocardless_connections WHERE organisation_id = ?1",
                    [&x],
                    |r| r.get(0),
                )
                .optional()
            })
            .unwrap();
    assert_eq!(owner.as_deref(), Some(t.w.beta.id.as_str()));
    assert_eq!(t.token_of(&t.w.alpha), None);
    let live = t.fake.live_tokens(&x);
    assert_eq!(
        live,
        vec![t.token_of(&t.w.beta).unwrap()],
        "no live token lost"
    );
}

/// Second review L-e: GoCardless rate-limiting the revoke (429) isn't
/// "already revoked": the disconnect answers 503 and changes nothing, the
/// token still live and held.
#[tokio::test(flavor = "multi_thread")]
async fn a_rate_limited_revoke_leaves_the_connection_as_it_was() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let token = t.token_of(&t.w.alpha).unwrap();
    t.fake_post(
        "outage",
        json!({ "calls": 1, "path": "revoke", "status": 429 }),
    )
    .await;
    let (s, out) =
        t.w.call("POST", "/api/t/alpha/gocardless/disconnect", &t.ann, None)
            .await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "{out}");
    let status = ok(&t.w, "GET", "/api/t/alpha/gocardless", &t.val, None).await;
    assert_eq!(status["connected"], true);
    assert_eq!(t.token_of(&t.w.alpha), Some(token.clone()));
    assert!(t.fake.token_works(&token));
}

/// Second review L-d: a regular gift whose mandate died at GoCardless
/// (its own terminal event lost) isn't asked for a subscription every run
/// for ever: the sweep's refusal finds the mandate dead and ends it.
#[tokio::test(flavor = "multi_thread")]
async fn the_sweep_ends_a_regular_gift_whose_mandate_died_unheard() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    let id = v["id"].as_str().unwrap().to_owned();
    t.fake_post("webhooks/hold", json!({})).await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    let br = t
        .fake
        .resource(v["billingRequestId"].as_str().unwrap())
        .unwrap();
    let mandate = br["links"]["mandate_request_mandate"]
        .as_str()
        .unwrap()
        .to_owned();
    t.fake_post(&format!("mandates/{mandate}/fail"), json!({}))
        .await;
    // Only the billing request's two events arrive: the mandate's failure
    // never does.
    t.simulate("webhooks/release?count=2").await;
    t.settle().await;
    let v = t.regular("alpha", &t.val, &id).await;
    assert_eq!(v["status"], "failed", "{v}");
    assert!(v["endedReason"].as_str().unwrap().contains("failed"));
    let calls = t.fake.calls("POST subscriptions");
    t.settle().await;
    t.settle().await;
    assert_eq!(t.fake.calls("POST subscriptions"), calls, "asked no more");
}

/// Second review L-d: a live mandate whose subscription GoCardless keeps
/// refusing is backed off between runs, then given up on.
#[tokio::test(flavor = "multi_thread")]
async fn the_sweep_backs_off_then_stops_for_a_refused_subscription() {
    let t = setup().await;
    t.connect("alpha", &t.ann).await;
    let jo = t.contact("alpha", &t.sam).await;
    let v = t.set_up("alpha", &t.sam, &jo, &t.code).await;
    t.fake_post(
        "outage",
        json!({ "calls": 100_000, "status": 422, "path": "subscriptions" }),
    )
    .await;
    t.sign(v["flowUrl"].as_str().unwrap()).await;
    t.settle().await;
    let calls = t.fake.calls("POST subscriptions");
    t.settle().await;
    t.settle().await;
    assert_eq!(t.fake.calls("POST subscriptions"), calls, "backed off");

    use api::gocardless::process::{SWEEP_MAX_REFUSALS, sweep_should_try};
    assert!(sweep_should_try(None, 0));
    assert!(!sweep_should_try(Some((1, 100)), 99));
    assert!(sweep_should_try(Some((1, 100)), 100));
    assert!(!sweep_should_try(Some((SWEEP_MAX_REFUSALS, 0)), i64::MAX));
}
