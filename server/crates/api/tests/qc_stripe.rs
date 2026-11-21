//! The QC Stripe surface (`routes::qc_stripe`, plan stripe.sv S6), on the
//! fake: the connect, its 404s (no token or a wrong one, outside staging
//! or dev, Stripe off, live, or a sandbox without the QC account, a group
//! that isn't `qc-`), the account moving from an older `qc-` group, a
//! real group keeping it, and an account Stripe doesn't know.

use std::net::SocketAddr;
use std::sync::Arc;

use api::auth::{Config, Runtime};
use api::routes::qc_seed::{QC_TOKEN_HEADER, QcAccess};
use api::stripe::{Origins, Stripe, accounts, from_vars};
use api::{AppState, app, routes, schema};
use comms::mail::Mailer;
use serde_json::{Value, json};
use store::{Role, Store, StoreConfig};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CONNECT: &str = "/api/qc/stripe/connect";
const DEV_CONNECT: &str = "/api/dev/qc-stripe/connect";

struct H {
    _tmp: tempfile::TempDir,
    store: Arc<Store>,
    stripe: Option<Arc<Stripe>>,
    base: String,
    http: reqwest::Client,
}

/// How the server under test is set up.
struct Setup {
    /// `KEEP_STRIPE` and the variables beside it.
    vars: Vec<(&'static str, String)>,
    /// The token surface (staging with `KEEP_QC_TOKEN`).
    qc: bool,
    dev_auth: bool,
}

fn staging_fake() -> Setup {
    Setup {
        vars: vec![("KEEP_STRIPE", "fake".into())],
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
    let stripe = from_vars(
        |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.clone())
        },
        Origins {
            app_origin: &base,
            self_base: &base,
        },
    )
    .unwrap()
    .map(Arc::new);
    let state = AppState::new(store.clone(), setup.dev_auth)
        .with_auth(Runtime::new(Config::default(), Mailer::log()))
        .with_qc(setup.qc.then(|| QcAccess::new(TOKEN).unwrap()))
        .with_stripe(stripe.clone());
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
        stripe,
        base,
        http: reqwest::Client::new(),
    }
}

impl H {
    async fn post(&self, path: &str, token: Option<&str>, body: Value) -> (u16, Value) {
        let mut req = self.http.post(format!("{}{path}", self.base)).json(&body);
        if let Some(t) = token {
            req = req.header(QC_TOKEN_HEADER, t);
        }
        let res = req.send().await.unwrap();
        let status = res.status().as_u16();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn connect(&self, slug: &str) -> (u16, Value) {
        self.post(CONNECT, Some(TOKEN), json!({ "slug": slug }))
            .await
    }

    /// A seeded QC world's two slugs.
    async fn seed(&self, run: &str) -> (String, String) {
        let (s, world) = self
            .post(
                "/api/qc/seed",
                Some(TOKEN),
                json!({ "runId": run, "worker": 0 }),
            )
            .await;
        assert_eq!(s, 200, "{world}");
        let slug = |i: usize| world["tenants"][i]["slug"].as_str().unwrap().to_owned();
        (slug(0), slug(1))
    }

    /// A group that isn't QC's, with an admin: its slug.
    fn real_group(&self, slug: &str) -> store::Tenant {
        let tenant = self.store.create_tenant(slug, "Real").unwrap();
        let p = self.store.platform();
        p.set_membership(
            p.upsert_user(&format!("admin@{slug}.org")).unwrap(),
            &tenant.id,
            Role::Admin,
        )
        .unwrap();
        tenant
    }

    fn row(&self, slug: &str) -> Option<accounts::Row> {
        let tenant = self.store.platform().tenant_by_slug(slug).unwrap().unwrap();
        accounts::account(&self.store, &tenant.id).unwrap()
    }

    fn held_by(&self, account: &str) -> Option<String> {
        accounts::tenant_for(&self.store, account)
            .unwrap()
            .map(|t| t.as_str().to_owned())
    }

    fn tenant_id(&self, slug: &str) -> String {
        self.store
            .platform()
            .tenant_by_slug(slug)
            .unwrap()
            .unwrap()
            .id
            .as_str()
            .to_owned()
    }
}

#[tokio::test]
async fn connect_gives_the_qc_group_the_qc_account_taking_payments() {
    let h = serve(staging_fake()).await;
    let (a, _) = h.seed("one").await;
    let (s, out) = h.connect(&a).await;
    assert_eq!(s, 200, "{out}");
    let account = out["accountId"].as_str().unwrap().to_owned();
    assert!(account.starts_with("acct_"), "{out}");
    assert_eq!(out["chargesEnabled"], true);
    let row = h.row(&a).unwrap();
    assert!(row.connected());
    assert_eq!(row.account_id.as_deref(), Some(account.as_str()));
    assert!(row.charges_enabled && row.details_submitted);
    assert_eq!(h.held_by(&account), Some(h.tenant_id(&a)));
    // Again is the same account and the same connection.
    let (s, again) = h.connect(&a).await;
    assert_eq!(s, 200);
    assert_eq!(again["accountId"], account.as_str());
    let after = h.row(&a).unwrap();
    assert_eq!(after.connected_at, row.connected_at);
}

#[tokio::test]
async fn no_token_or_a_wrong_one_is_404() {
    let h = serve(staging_fake()).await;
    let (a, _) = h.seed("tok").await;
    for token in [None, Some("f".repeat(64))] {
        let (s, _) = h
            .post(CONNECT, token.as_deref(), json!({ "slug": a }))
            .await;
        assert_eq!(s, 404, "token {token:?}");
    }
    assert_eq!(h.row(&a), None);
    // The dev twin isn't there without dev auth and KEEP_QC_SEED=1.
    let (s, _) = h.post(DEV_CONNECT, Some(TOKEN), json!({ "slug": a })).await;
    assert_eq!(s, 404);
    assert_eq!(h.row(&a), None);
}

#[tokio::test]
async fn off_staging_the_token_surface_is_404() {
    // No `KEEP_QC_TOKEN` surface (not staging): the right token is nothing.
    let h = serve(Setup {
        qc: false,
        ..staging_fake()
    })
    .await;
    h.real_group("qc-looks-like-one");
    let (s, _) = h.connect("qc-looks-like-one").await;
    assert_eq!(s, 404);
    assert_eq!(h.row("qc-looks-like-one"), None);
}

#[tokio::test]
async fn a_group_that_is_not_qc_is_404() {
    let h = serve(staging_fake()).await;
    h.real_group("riverside");
    let (s, _) = h.connect("riverside").await;
    assert_eq!(s, 404);
    assert_eq!(h.row("riverside"), None);
    // Nor a qc- slug nobody seeded.
    let (s, _) = h.connect("qc-nobody").await;
    assert_eq!(s, 404);
}

#[tokio::test]
async fn stripe_off_live_or_a_sandbox_without_the_account_is_404() {
    let key = |mode: &str| ("KEEP_STRIPE_API_KEY", format!("rk_{mode}_s3cret"));
    let webhook = ("KEEP_STRIPE_WEBHOOK_SECRET", "whsec_s3cret".to_owned());
    for (what, vars) in [
        ("off", vec![("KEEP_STRIPE", "off".to_owned())]),
        ("unset", vec![]),
        (
            "live",
            vec![
                ("KEEP_STRIPE", "live".into()),
                ("KEEP_ENV", "prod".into()),
                key("live"),
                webhook.clone(),
            ],
        ),
        (
            "a sandbox with no QC account",
            vec![
                ("KEEP_STRIPE", "test".into()),
                ("KEEP_ENV", "staging".into()),
                key("test"),
                webhook.clone(),
            ],
        ),
    ] {
        let h = serve(Setup {
            vars,
            qc: true,
            dev_auth: false,
        })
        .await;
        let (a, _) = h.seed("off").await;
        let (s, out) = h.connect(&a).await;
        assert_eq!(s, 404, "{what}: {out}");
        assert_eq!(h.row(&a), None, "{what}");
    }
}

/// Live never has a QC account at all: the boot refuses the variable
/// with `KEEP_ENV=prod`, the only place `live` runs.
#[test]
fn live_with_a_qc_account_does_not_boot() {
    let vars = [
        ("KEEP_STRIPE", "live"),
        ("KEEP_ENV", "prod"),
        ("KEEP_STRIPE_API_KEY", "rk_live_s3cret"),
        ("KEEP_STRIPE_WEBHOOK_SECRET", "whsec_s3cret"),
        ("KEEP_QC_STRIPE_ACCOUNT", "acct_1Qc"),
    ];
    let err = from_vars(
        |name| {
            vars.iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        },
        Origins {
            app_origin: "https://app.example",
            self_base: "http://127.0.0.1:1",
        },
    )
    .err()
    .expect("booted");
    assert!(err.contains("KEEP_QC_STRIPE_ACCOUNT"), "{err}");
}

#[tokio::test]
async fn the_account_moves_from_an_older_qc_group() {
    let h = serve(staging_fake()).await;
    let (old, other) = h.seed("old").await;
    let (new, _) = h.seed("new").await;
    let (s, first) = h.connect(&old).await;
    assert_eq!(s, 200, "{first}");
    let account = first["accountId"].as_str().unwrap().to_owned();

    let (s, moved) = h.connect(&new).await;
    assert_eq!(s, 200, "{moved}");
    assert_eq!(moved["accountId"], account.as_str());
    assert_eq!(h.held_by(&account), Some(h.tenant_id(&new)));
    assert!(h.row(&new).unwrap().charges_enabled);
    // The older group's row is as new: no account, nothing enabled.
    let gave_up = h.row(&old).unwrap();
    assert_eq!(gave_up.account_id, None);
    assert!(!gave_up.connected());
    assert!(!gave_up.charges_enabled && !gave_up.details_submitted);
    // And a group that never had it is untouched.
    assert_eq!(h.row(&other), None);
}

#[tokio::test]
async fn an_account_the_group_made_for_itself_is_replaced() {
    let h = serve(staging_fake()).await;
    let (a, _) = h.seed("own").await;
    let tenant = h.store.platform().tenant_by_slug(&a).unwrap().unwrap().id;
    let fake = h.stripe.as_ref().unwrap().fake.clone().unwrap();
    // As "Connect Stripe" leaves it: an account of its own, form not done.
    let own = api::stripe::client::Account {
        id: "acct_itsown".into(),
        details_submitted: false,
        charges_enabled: false,
        payouts_enabled: false,
        requirements_due: 3,
        disabled_reason: None,
    };
    accounts::reserve(&h.store, &tenant, 1, 1).unwrap();
    accounts::connect(&h.store, &tenant, &own, 1, 1).unwrap();
    let (s, out) = h.connect(&a).await;
    assert_eq!(s, 200, "{out}");
    assert_eq!(out["accountId"], fake.qc_account().as_str());
    assert_eq!(out["chargesEnabled"], true);
    assert_eq!(h.held_by("acct_itsown"), None);
}

#[tokio::test]
async fn a_real_group_holding_the_account_keeps_it() {
    // The variable names an account a real group is connected to.
    let h = serve(Setup {
        vars: vec![
            ("KEEP_STRIPE", "fake".into()),
            ("KEEP_QC_STRIPE_ACCOUNT", "acct_real".into()),
        ],
        qc: true,
        dev_auth: false,
    })
    .await;
    let real = h.real_group("riverside");
    let held = api::stripe::client::Account {
        id: "acct_real".into(),
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        requirements_due: 0,
        disabled_reason: None,
    };
    accounts::reserve(&h.store, &real.id, 1, 1).unwrap();
    accounts::connect(&h.store, &real.id, &held, 1, 1).unwrap();
    let (a, _) = h.seed("take").await;
    let (s, out) = h.connect(&a).await;
    // The fake doesn't know the id (nobody made it there), as a sandbox
    // wouldn't know another's: refused before anything moves.
    assert_eq!(s, 422, "{out}");
    assert_eq!(out["reason"], "account_gone", "{out}");
    assert_eq!(h.held_by("acct_real"), Some(real.id.as_str().to_owned()));
    assert_eq!(h.row(&a), None);
}

#[tokio::test]
async fn a_real_group_holding_an_account_stripe_knows_is_409() {
    let h = serve(staging_fake()).await;
    let fake = h.stripe.as_ref().unwrap().fake.clone().unwrap();
    let account = fake.qc_account();
    let real = h.real_group("riverside");
    let held = api::stripe::client::Account {
        id: account.clone(),
        details_submitted: true,
        charges_enabled: true,
        payouts_enabled: true,
        requirements_due: 0,
        disabled_reason: None,
    };
    accounts::reserve(&h.store, &real.id, 1, 1).unwrap();
    accounts::connect(&h.store, &real.id, &held, 1, 1).unwrap();
    let (a, _) = h.seed("held").await;
    let (s, out) = h.connect(&a).await;
    assert_eq!(s, 409, "{out}");
    assert_eq!(h.held_by(&account), Some(real.id.as_str().to_owned()));
    assert_eq!(h.row(&a), None);
}
