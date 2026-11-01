//! The QC GoCardless surface (`routes::qc_gocardless`, plan
//! gocardless-sandbox-qc.sv, G2), on the fake: each route's happy path,
//! its 404s (no token, outside staging or dev, GoCardless off, live or
//! without the QC account, a non-qc org, another org's resource, a
//! scenario off the list), isolation between two qc- orgs, the boot's
//! refusals, and the retry.

use std::net::SocketAddr;
use std::sync::Arc;

use api::auth::{Config, Runtime};
use api::gocardless::fake::Fake;
use api::gocardless::{GoCardless, Origins, from_vars, process};
use api::routes::qc_seed::{QC_TOKEN_HEADER, QcAccess};
use api::{AppState, app, routes, schema};
use comms::mail::Mailer;
use serde_json::{Value, json};
use store::{Store, StoreConfig};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn settings_key() -> platform::settings::SettingsKey {
    ::auth::keys::Keys::dev().settings_key().clone()
}

struct H {
    _tmp: tempfile::TempDir,
    store: Arc<Store>,
    gc: Option<Arc<GoCardless>>,
    base: String,
    http: reqwest::Client,
}

/// How the server under test is set up.
struct Setup {
    /// `KEEP_GOCARDLESS` and the variables beside it.
    vars: Vec<(&'static str, &'static str)>,
    /// The token surface (staging with `KEEP_QC_TOKEN`).
    qc: bool,
    dev_auth: bool,
}

fn staging_fake() -> Setup {
    Setup {
        vars: vec![("KEEP_GOCARDLESS", "fake")],
        qc: true,
        dev_auth: false,
    }
}

async fn serve(setup: Setup) -> H {
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
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let vars = setup.vars;
    let gc = from_vars(
        |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        },
        Origins {
            app_origin: &base,
            self_base: &base,
        },
        settings_key(),
    )
    .unwrap()
    .map(Arc::new);
    let state = AppState::new(store.clone(), setup.dev_auth)
        .with_auth(Runtime::new(Config::default(), Mailer::log()))
        .with_qc(setup.qc.then(|| QcAccess::new(TOKEN).unwrap()))
        .with_gocardless(gc.clone());
    let served = app(state, routes::router());
    tokio::spawn(async move {
        axum::serve(
            listener,
            served.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap()
    });
    H {
        _tmp: tmp,
        store,
        gc,
        base,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap(),
    }
}

/// A seeded QC world (two qc- orgs) on a staging-like server.
struct W {
    h: H,
    /// A's and B's slugs.
    a: String,
    b: String,
    /// A's Ada, B's Ada.
    ada_a: String,
    ada_b: String,
    /// Sessions: A's admin, B's admin.
    admin_a: String,
    admin_b: String,
}

impl H {
    fn fake(&self) -> Arc<Fake> {
        self.gc.as_ref().unwrap().fake.clone().unwrap()
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        token: Option<&str>,
        cookie: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value, String) {
        let mut req = self.http.request(method, format!("{}{path}", self.base));
        if let Some(t) = token {
            req = req.header(QC_TOKEN_HEADER, t);
        }
        if let Some(c) = cookie {
            req = req.header("cookie", c);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        let text = res.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(Value::Null),
            text,
        )
    }

    /// A token route of the surface: `POST /api/qc/gocardless/<what>`.
    async fn qc(&self, what: &str, body: Value) -> (u16, Value) {
        let (s, v, _) = self
            .send(
                reqwest::Method::POST,
                &format!("/api/qc/gocardless/{what}"),
                Some(TOKEN),
                None,
                Some(body),
            )
            .await;
        (s, v)
    }

    async fn qc_ok(&self, what: &str, body: Value) -> Value {
        let (s, v) = self.qc(what, body).await;
        assert_eq!(s, 200, "{what}: {v}");
        v
    }

    async fn peek(&self, slug: &str, kind: &str, id: &str) -> (u16, Value) {
        let (s, v, _) = self
            .send(
                reqwest::Method::GET,
                &format!("/api/qc/gocardless/peek/{slug}/{kind}/{id}"),
                Some(TOKEN),
                None,
                None,
            )
            .await;
        (s, v)
    }

    async fn user(
        &self,
        method: reqwest::Method,
        path: &str,
        cookie: &str,
        body: Option<Value>,
    ) -> Value {
        let (s, v, _) = self.send(method, path, None, Some(cookie), body).await;
        assert_eq!(s, 200, "{path}: {v}");
        v
    }

    async fn session(&self, email: &str) -> String {
        let res = self
            .http
            .post(format!("{}/api/qc/session", self.base))
            .header(QC_TOKEN_HEADER, TOKEN)
            .json(&json!({ "email": email }))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        res.headers()
            .get_all("set-cookie")
            .iter()
            .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_owned())
            .collect::<Vec<_>>()
            .join("; ")
    }

    async fn settle(&self) {
        process::process_pending(self.store.clone(), self.gc.clone().unwrap())
            .await
            .unwrap();
    }

    /// A fake-only control (`simulate/…`), as the sandbox's own clock
    /// would do (a subscription's next payment).
    async fn fake_simulate(&self, path: &str) -> Value {
        let res = self
            .http
            .post(format!("{}/api/fake-gocardless/simulate/{path}", self.base))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{path}");
        res.json().await.unwrap()
    }
}

async fn seeded(run: &str) -> W {
    let h = serve(staging_fake()).await;
    let (s, world, _) = h
        .send(
            reqwest::Method::POST,
            "/api/qc/seed",
            Some(TOKEN),
            None,
            Some(json!({ "runId": run, "worker": 0 })),
        )
        .await;
    assert_eq!(s, 200, "{world}");
    let slug = |i: usize| world["tenants"][i]["slug"].as_str().unwrap().to_owned();
    let ada = |i: usize| {
        world["tenants"][i]["contactIds"][0]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let email = |i: usize| world["users"][i]["email"].as_str().unwrap().to_owned();
    let admin_a = h.session(&email(0)).await;
    let admin_b = h.session(&email(1)).await;
    W {
        a: slug(0),
        b: slug(1),
        ada_a: ada(0),
        ada_b: ada(1),
        admin_a,
        admin_b,
        h,
    }
}

impl W {
    /// A new live source code in `slug`.
    async fn code(&self, slug: &str, cookie: &str) -> String {
        let tree = self
            .h
            .user(
                reqwest::Method::GET,
                &format!("/api/t/{slug}/sources"),
                cookie,
                None,
            )
            .await;
        let category = tree["parts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["parentId"].is_null())
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        self.h
            .user(
                reqwest::Method::POST,
                &format!("/api/t/{slug}/sources"),
                cookie,
                Some(json!({ "parentId": category, "name": "Direct", "isActive": true })),
            )
            .await["versionId"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    /// `slug` connected through the surface, and a regular gift for its
    /// Ada waiting for the donor: its id.
    async fn gift(&self, slug: &str) -> String {
        let (cookie, ada) = if slug == self.a {
            (&self.admin_a, &self.ada_a)
        } else {
            (&self.admin_b, &self.ada_b)
        };
        self.h.qc_ok("connect", json!({ "slug": slug })).await;
        let code = self.code(slug, cookie).await;
        self.h
            .user(
                reqwest::Method::POST,
                &format!("/api/t/{slug}/contacts/{ada}/regular-gifts"),
                cookie,
                Some(json!({
                    "amount": 1000, "frequency": "monthly", "dayOfMonth": 5,
                    "sourceCodeId": code, "clientKey": contracts::new_id()
                })),
            )
            .await["view"]["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn regular(&self, slug: &str, id: &str) -> Value {
        let cookie = if slug == self.a {
            &self.admin_a
        } else {
            &self.admin_b
        };
        self.h
            .user(
                reqwest::Method::GET,
                &format!("/api/t/{slug}/regular-gifts/{id}"),
                cookie,
                None,
            )
            .await
    }

    /// Signed through the surface and its webhooks handled: the mandate.
    async fn signed(&self, slug: &str, id: &str) -> String {
        let out = self
            .h
            .qc_ok("sign", json!({ "slug": slug, "regularGiftId": id }))
            .await;
        self.h.settle().await;
        out["mandateId"].as_str().unwrap().to_owned()
    }
}

/// Every route of the token surface, with a body for each.
fn every_route(slug: &str) -> Vec<(reqwest::Method, String, Option<Value>)> {
    let post = |what: &str, body: Value| {
        (
            reqwest::Method::POST,
            format!("/api/qc/gocardless/{what}"),
            Some(body),
        )
    };
    vec![
        post("connect", json!({ "slug": slug })),
        post(
            "sign",
            json!({ "slug": slug, "regularGiftId": "0123456789abcdef0123456789abcdef" }),
        ),
        post(
            "simulate",
            json!({ "slug": slug, "scenario": "mandate_activated", "resource": "MD1" }),
        ),
        (
            reqwest::Method::GET,
            format!("/api/qc/gocardless/peek/{slug}/mandate/MD1"),
            None,
        ),
        post("catchup", json!({ "slug": slug })),
        post("cleanup", json!({ "slug": slug })),
    ]
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_gocardless_routes_404_without_the_qc_token() {
    let w = seeded("t1").await;
    // Each refusal counts towards the token's failure limit (10 per
    // address in 10 minutes), so: every route once without a token, two
    // with a session instead, one with a wrong token.
    for (i, (method, path, body)) in every_route(&w.a).into_iter().enumerate() {
        let (s, v, _) =
            w.h.send(method.clone(), &path, None, None, body.clone())
                .await;
        assert_eq!(s, 404, "{path} without a token: {v}");
        if i < 2 {
            // A staff session is no token either.
            let (s, _, _) = w.h.send(method, &path, None, Some(&w.admin_a), body).await;
            assert_eq!(s, 404, "{path} with a session");
        }
    }
    // A wrong token is 404 too.
    let (method, path, body) = every_route(&w.a).remove(0);
    let (s, _, _) =
        w.h.send(method, &path, Some(&TOKEN.replace('0', "1")), None, body)
            .await;
    assert_eq!(s, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_gocardless_routes_404_outside_staging_or_dev() {
    // No token surface (KEEP_ENV isn't staging) and no dev auth: the token
    // routes and the dev twins are all 404.
    let h = serve(Setup {
        vars: vec![("KEEP_GOCARDLESS", "fake")],
        qc: false,
        dev_auth: false,
    })
    .await;
    for (method, path, body) in every_route("qc-x") {
        let (s, _, _) = h
            .send(method.clone(), &path, Some(TOKEN), None, body.clone())
            .await;
        assert_eq!(s, 404, "{path}");
        let dev = path.replace("/api/qc/gocardless/", "/api/dev/qc-gocardless/");
        let (s, _, _) = h.send(method, &dev, None, None, body).await;
        assert_eq!(s, 404, "{dev}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_gocardless_routes_404_when_gocardless_is_off_or_live() {
    let live = vec![
        ("KEEP_ENV", "prod"),
        ("KEEP_GOCARDLESS", "live"),
        ("KEEP_GOCARDLESS_CLIENT_ID", "id"),
        ("KEEP_GOCARDLESS_CLIENT_SECRET", "secret"),
        ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "hook"),
    ];
    // The sandbox without the QC account's variables is off too.
    let sandbox = vec![
        ("KEEP_GOCARDLESS", "sandbox"),
        ("KEEP_GOCARDLESS_CLIENT_ID", "id"),
        ("KEEP_GOCARDLESS_CLIENT_SECRET", "secret"),
        ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "hook"),
    ];
    for vars in [vec![("KEEP_GOCARDLESS", "off")], live, sandbox] {
        let h = serve(Setup {
            vars: vars.clone(),
            qc: true,
            dev_auth: false,
        })
        .await;
        for (method, path, body) in every_route("qc-x") {
            let (s, _, _) = h.send(method, &path, Some(TOKEN), None, body).await;
            assert_eq!(s, 404, "{vars:?}: {path}");
        }
    }
}

fn boot(vars: &[(&str, &str)]) -> Result<Option<GoCardless>, String> {
    from_vars(
        |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        },
        Origins {
            app_origin: "https://x.example",
            self_base: "http://127.0.0.1:1",
        },
        settings_key(),
    )
}

const QC_VARS: [(&str, &str); 2] = [
    ("KEEP_QC_GOCARDLESS_TOKEN", "sandbox_token_never_shown"),
    ("KEEP_QC_GOCARDLESS_ORGANISATION", "OR123"),
];

#[test]
fn boot_refuses_qc_gocardless_secrets_with_prod() {
    for gocardless in ["off", "live"] {
        let mut vars = vec![
            ("KEEP_ENV", "prod"),
            ("KEEP_GOCARDLESS", gocardless),
            ("KEEP_GOCARDLESS_CLIENT_ID", "id"),
            ("KEEP_GOCARDLESS_CLIENT_SECRET", "secret"),
            ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "hook"),
        ];
        for one in QC_VARS {
            vars.push(one);
            let err = boot(&vars).err().expect("refused");
            assert!(err.contains("KEEP_ENV=prod"), "{err}");
            assert!(!err.contains("sandbox_token_never_shown"), "{err}");
        }
    }
}

#[test]
fn boot_refuses_qc_gocardless_secrets_with_live() {
    // Live without prod is refused on its own; with the QC variables the
    // refusal names them whatever the environment says.
    let mut vars = vec![
        ("KEEP_ENV", "staging"),
        ("KEEP_GOCARDLESS", "live"),
        ("KEEP_GOCARDLESS_CLIENT_ID", "id"),
        ("KEEP_GOCARDLESS_CLIENT_SECRET", "secret"),
        ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "hook"),
    ];
    vars.extend(QC_VARS);
    assert!(boot(&vars).is_err());
    // Sandbox: both or neither; one alone stops the boot, naming the other.
    let sandbox = [
        ("KEEP_ENV", "staging"),
        ("KEEP_GOCARDLESS", "sandbox"),
        ("KEEP_GOCARDLESS_CLIENT_ID", "id"),
        ("KEEP_GOCARDLESS_CLIENT_SECRET", "secret"),
        ("KEEP_GOCARDLESS_WEBHOOK_SECRET", "hook"),
    ];
    let both: Vec<_> = sandbox.iter().copied().chain(QC_VARS).collect();
    let gc = boot(&both).unwrap().unwrap();
    assert_eq!(gc.qc.as_ref().unwrap().organisation_id, "OR123");
    assert!(!format!("{:?}", gc.qc).contains("sandbox_token_never_shown"));
    let alone: Vec<_> = sandbox.iter().copied().chain([QC_VARS[0]]).collect();
    let err = boot(&alone).err().unwrap();
    assert!(err.contains("KEEP_QC_GOCARDLESS_ORGANISATION"), "{err}");
    assert!(boot(&sandbox).unwrap().unwrap().qc.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_connect_moves_the_account_from_an_older_qc_org() {
    let w = seeded("t2").await;
    let first = w.h.qc_ok("connect", json!({ "slug": w.a })).await;
    let org = first["organisationId"].as_str().unwrap().to_owned();
    assert!(org.starts_with("OR"));
    let second = w.h.qc_ok("connect", json!({ "slug": w.b })).await;
    assert_eq!(second["organisationId"], org.as_str());
    let a = w.h.store.platform().tenant_by_slug(&w.a).unwrap().unwrap();
    let b = w.h.store.platform().tenant_by_slug(&w.b).unwrap().unwrap();
    assert!(
        api::gocardless::connection(&w.h.store, &a.id)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        api::gocardless::connection(&w.h.store, &b.id)
            .unwrap()
            .unwrap()
            .organisation_id,
        org
    );
    let gc = w.h.gc.clone().unwrap();
    let token = |id: &store::TenantId| w.h.store.org(id).unwrap().read(|r| gc.token(r)).unwrap();
    assert_eq!(token(&a.id), None);
    assert!(token(&b.id).is_some());
    // Connecting again is fine (the same account, the same org).
    w.h.qc_ok("connect", json!({ "slug": w.b })).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_connect_refuses_when_a_real_org_holds_the_account() {
    let w = seeded("t3").await;
    let real = w.h.store.create_tenant("riverside", "Riverside").unwrap();
    let org =
        w.h.gc
            .as_ref()
            .unwrap()
            .qc
            .as_ref()
            .unwrap()
            .organisation_id
            .clone();
    api::gocardless::record_connection(&w.h.store, &real.id, &org, 1, contracts::now_ms())
        .unwrap()
        .unwrap();
    let (s, v) = w.h.qc("connect", json!({ "slug": w.a })).await;
    assert_eq!(s, 409, "{v}");
    assert_eq!(v["kind"], "taken");
    assert_eq!(
        api::gocardless::connection(&w.h.store, &real.id)
            .unwrap()
            .unwrap()
            .organisation_id,
        org
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_connect_never_answers_the_token() {
    let w = seeded("t4").await;
    let (s, _, text) =
        w.h.send(
            reqwest::Method::POST,
            "/api/qc/gocardless/connect",
            Some(TOKEN),
            None,
            Some(json!({ "slug": w.a })),
        )
        .await;
    assert_eq!(s, 200);
    let org =
        w.h.gc
            .as_ref()
            .unwrap()
            .qc
            .as_ref()
            .unwrap()
            .organisation_id
            .clone();
    let tokens = w.h.fake().live_tokens(&org);
    assert!(!tokens.is_empty());
    for t in tokens {
        assert!(!text.contains(&t), "the token is in the answer");
    }
    assert!(!text.to_lowercase().contains("token"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_gocardless_routes_refuse_non_qc_slugs() {
    let w = seeded("t5").await;
    w.h.store.create_tenant("riverside", "Riverside").unwrap();
    for slug in ["riverside", "nowhere"] {
        for (method, path, body) in every_route(slug) {
            let (s, v, _) = w.h.send(method, &path, Some(TOKEN), None, body).await;
            assert_eq!(s, 404, "{path}: {v}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_sign_on_the_fake_activates_like_the_hosted_page() {
    let w = seeded("t6").await;
    let id = w.gift(&w.a).await;
    let mandate = w.signed(&w.a, &id).await;
    let v = w.regular(&w.a, &id).await;
    assert_eq!(v["mandateId"], mandate.as_str());
    assert_eq!(v["status"], "pending");
    // GoCardless's customer is the donor, with QC's tag and address.
    let fake = w.h.fake();
    let md = fake.resource(&mandate).unwrap();
    let customer = fake
        .resource(md["links"]["customer"].as_str().unwrap())
        .unwrap();
    assert_eq!(customer["given_name"], "Ada");
    assert_eq!(customer["metadata"]["keep_qc"], w.a.as_str());
    assert!(customer["email"].as_str().unwrap().starts_with("qc+"));
    // Signing again is refused: it isn't waiting for the donor.
    let (s, _) =
        w.h.qc("sign", json!({ "slug": w.a, "regularGiftId": id }))
            .await;
    assert_eq!(s, 422);
    // The sandbox activates it: the app shows it active, with a
    // subscription GoCardless has.
    w.h.qc_ok(
        "simulate",
        json!({ "slug": w.a, "scenario": "mandate_activated", "resource": mandate }),
    )
    .await;
    w.h.settle().await;
    let v = w.regular(&w.a, &id).await;
    assert_eq!(v["status"], "active");
    let sub = v["subscriptionId"].as_str().unwrap().to_owned();
    let (s, seen) = w.h.peek(&w.a, "subscription", &sub).await;
    assert_eq!(s, 200, "{seen}");
    assert_eq!(seen["status"], "active");
    assert_eq!(seen["amount"], 1000);
    assert!(!seen["upcomingPayments"].as_array().unwrap().is_empty());
    // A payment: pending, then confirmed by the simulator.
    let pm =
        w.h.fake_simulate(&format!("subscriptions/{sub}/payment"))
            .await["payment"]
            .as_str()
            .unwrap()
            .to_owned();
    w.h.settle().await;
    let (_, seen) = w.h.peek(&w.a, "mandate", &mandate).await;
    assert_eq!(seen["status"], "active");
    assert_eq!(seen["payments"][0]["id"], pm.as_str());
    assert_eq!(seen["payments"][0]["status"], "pending_submission");
    w.h.qc_ok(
        "simulate",
        json!({ "slug": w.a, "scenario": "payment_confirmed", "resource": pm }),
    )
    .await;
    w.h.settle().await;
    let (_, seen) = w.h.peek(&w.a, "payment", &pm).await;
    assert_eq!(seen["status"], "confirmed");
    assert_eq!(seen["amount"], 1000);
    // A confirmed payment can't be confirmed again (the sandbox's rule).
    let (s, v) =
        w.h.qc(
            "simulate",
            json!({ "slug": w.a, "scenario": "payment_confirmed", "resource": pm }),
        )
        .await;
    assert_eq!(s, 422, "{v}");
    // Every webhook landed: the catch-up finds nothing missed.
    let caught = w.h.qc_ok("catchup", json!({ "slug": w.a })).await;
    assert!(caught["read"].as_u64().unwrap() > 0, "{caught}");
    assert_eq!(caught["missed"], 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn simulate_allowlist() {
    let w = seeded("t7").await;
    let id = w.gift(&w.a).await;
    let mandate = w.signed(&w.a, &id).await;
    for scenario in [
        "mandate_expired",
        "mandate_transferred",
        "billing_request_fulfilled",
        "creditor_verification_status_action_required",
        "",
    ] {
        let (s, v) =
            w.h.qc(
                "simulate",
                json!({ "slug": w.a, "scenario": scenario, "resource": mandate }),
            )
            .await;
        assert_eq!(s, 404, "{scenario}: {v}");
    }
    // A payment scenario on a mandate: not a payment the org's rows name.
    let (s, _) =
        w.h.qc(
            "simulate",
            json!({ "slug": w.a, "scenario": "payment_confirmed", "resource": mandate }),
        )
        .await;
    assert_eq!(s, 404);
    // Nothing reached the fake's simulators.
    assert_eq!(w.h.fake().calls("POST scenario_simulators"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_simulate_and_peek_refuse_another_orgs_resource() {
    let w = seeded("t8").await;
    let id = w.gift(&w.a).await;
    let mandate = w.signed(&w.a, &id).await;
    // B is connected too (the account moves to it; A's rows still name
    // the mandate, B's don't).
    w.h.qc_ok("connect", json!({ "slug": w.b })).await;
    let (s, _) =
        w.h.qc(
            "simulate",
            json!({ "slug": w.b, "scenario": "mandate_activated", "resource": mandate }),
        )
        .await;
    assert_eq!(s, 404);
    let (s, _) = w.h.peek(&w.b, "mandate", &mandate).await;
    assert_eq!(s, 404);
    assert_eq!(w.h.fake().calls("POST scenario_simulators"), 0);
    assert_eq!(
        w.h.fake().resource(&mandate).unwrap()["status"],
        "pending_submission"
    );
    // Under its own slug, with the account back, A may.
    w.h.qc_ok("connect", json!({ "slug": w.a })).await;
    let (s, seen) = w.h.peek(&w.a, "mandate", &mandate).await;
    assert_eq!(s, 200, "{seen}");
    assert_eq!(seen["status"], "pending_submission");
    // A kind that isn't peekable is 404.
    let (s, _) = w.h.peek(&w.a, "customer", &mandate).await;
    assert_eq!(s, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn qc_cleanup_deletes_only_its_own_customers() {
    let w = seeded("t9").await;
    let fake = w.h.fake();
    // B's donor signs first (its customer is recent and QC-tagged), then
    // A's.
    let b_gift = w.gift(&w.b).await;
    let b_mandate = w.signed(&w.b, &b_gift).await;
    let a_gift = w.gift(&w.a).await;
    let a_mandate = w.signed(&w.a, &a_gift).await;
    let customer = |md: &str| {
        fake.resource(md).unwrap()["links"]["customer"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let (a_customer, b_customer) = (customer(&a_mandate), customer(&b_mandate));
    let org =
        w.h.gc
            .as_ref()
            .unwrap()
            .qc
            .as_ref()
            .unwrap()
            .organisation_id
            .clone();
    let stale = fake.old_customer(&org, Some("qc-old-run"), 3);
    let untagged = fake.old_customer(&org, None, 3);
    let fresh = fake.old_customer(&org, Some("qc-other-run"), 1);
    // Another account's old QC-tagged customer is never reached.
    let (other_org, _) = fake.connect_account();
    let elsewhere = fake.old_customer(&other_org, Some("qc-old-run"), 3);
    let out = w.h.qc_ok("cleanup", json!({ "slug": w.a })).await;
    assert_eq!(out["own"], 1, "{out}");
    assert_eq!(out["swept"], 1, "{out}");
    assert_eq!(out["refused"], 0, "{out}");
    assert!(fake.resource(&a_customer).is_none());
    assert!(fake.resource(&stale).is_none());
    for kept in [&b_customer, &untagged, &fresh, &elsewhere] {
        assert!(fake.resource(kept).is_some(), "{kept} was deleted");
    }
    // Again: nothing left of A's, nothing old to sweep.
    let out = w.h.qc_ok("cleanup", json!({ "slug": w.a })).await;
    assert_eq!(
        (out["own"].as_u64(), out["swept"].as_u64()),
        (Some(1), Some(0))
    );
}

/// Every call to GoCardless from the surface is retried once, under the
/// same key, when GoCardless answers a 5xx; twice is the caller's 503.
#[tokio::test(flavor = "multi_thread")]
async fn qc_calls_retry_once_on_a_5xx() {
    let w = seeded("t10").await;
    let id = w.gift(&w.a).await;
    let mandate = w.signed(&w.a, &id).await;
    let outage = |calls: usize| {
        w.h.http
            .post(format!("{}/api/fake-gocardless/simulate/outage", w.h.base))
            .json(&json!({ "calls": calls, "status": 503, "path": "scenario_simulators" }))
            .send()
    };
    outage(1).await.unwrap();
    let body = json!({ "slug": w.a, "scenario": "mandate_activated", "resource": mandate });
    w.h.qc_ok("simulate", body.clone()).await;
    assert_eq!(w.h.fake().calls("POST scenario_simulators"), 2);
    assert_eq!(w.h.fake().resource(&mandate).unwrap()["status"], "active");
    outage(2).await.unwrap();
    let (s, v) =
        w.h.qc(
            "simulate",
            json!({ "slug": w.a, "scenario": "mandate_failed", "resource": mandate }),
        )
        .await;
    assert_eq!(s, 503, "{v}");
    assert_eq!(w.h.fake().calls("POST scenario_simulators"), 4);
    let _ = body;
}

/// The dev twins (`KEEP_DEV_AUTH=1` + `KEEP_QC_SEED=1`, the fake
/// locally) answer as the token routes do, without a token.
#[tokio::test(flavor = "multi_thread")]
async fn the_dev_twins_work_on_the_fake_with_dev_auth_and_qc_seed() {
    // SAFETY: only this test binary's tests read it, and each sets it the
    // same way before any request.
    unsafe { std::env::set_var("KEEP_QC_SEED", "1") };
    let h = serve(Setup {
        vars: vec![("KEEP_GOCARDLESS", "fake")],
        qc: false,
        dev_auth: true,
    })
    .await;
    let (s, world, _) = h
        .send(
            reqwest::Method::POST,
            "/api/dev/qc-seed",
            None,
            None,
            Some(json!({ "runId": "dev1", "worker": 0 })),
        )
        .await;
    assert_eq!(s, 200, "{world}");
    let slug = world["tenants"][0]["slug"].as_str().unwrap();
    let (s, v, _) = h
        .send(
            reqwest::Method::POST,
            "/api/dev/qc-gocardless/connect",
            None,
            None,
            Some(json!({ "slug": slug })),
        )
        .await;
    assert_eq!(s, 200, "{v}");
    assert!(v["organisationId"].as_str().unwrap().starts_with("OR"));
    // The token routes stay off (not staging).
    let (s, _, _) = h
        .send(
            reqwest::Method::POST,
            "/api/qc/gocardless/connect",
            Some(TOKEN),
            None,
            Some(json!({ "slug": slug })),
        )
        .await;
    assert_eq!(s, 404);
}
