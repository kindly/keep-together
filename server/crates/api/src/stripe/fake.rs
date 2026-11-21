//! `KEEP_STRIPE=fake`: a Stripe mock mounted on this server at
//! [`super::FAKE_PREFIX`], for local runs, cargo tests and QC. It answers
//! the calls [`super::client::Api`] makes in Stripe's shapes (form-encoded
//! v1 and JSON v2 requests, the `{"error": {...}}` body, idempotency
//! keys), keeps everything in memory, and delivers webhooks to this
//! server one event a request, signed like Stripe's (`Stripe-Signature:
//! t=…,v1=…` under [`WEBHOOK_SECRET`]), each naming its connected
//! `account`. Its key and secret are published constants: `KEEP_ENV=prod`
//! refuses fake mode.
//!
//! API (every call needs the key and `Stripe-Version`):
//! - `POST v2/core/accounts` (JSON) and `POST v1/accounts` (form): a new
//!   connected account, nothing submitted, nothing enabled. Both end as
//!   the same account, kept in v1's shape. As Stripe, a repeat under the
//!   same `Idempotency-Key` answers the first one's, the same key with
//!   another body is `400 idempotency_error`, and a keyed request that
//!   failed (a 500 included; not a 401 or 429) answers that failure
//!   again;
//! - `GET v1/accounts/{id}`: the account; one that doesn't exist, or
//!   whose owner removed the platform: `403 account_invalid`, as Stripe;
//! - `POST v2/core/account_links` (JSON) and `POST v1/account_links`
//!   (form): a single-use onboarding link, good for five minutes.
//!
//! The page a browser visits (what Stripe hosts):
//! - `GET onboarding/{token}`: Stripe's form, as three buttons. "Complete"
//!   submits everything (charges and payouts enabled); "Submit, more
//!   needed" submits with a requirement outstanding (charges not
//!   enabled); "Leave" changes nothing. Each sends the browser to the
//!   link's `return_url`, after the `account.updated` webhook (if any)
//!   has been delivered. A spent, expired or unknown link goes to its
//!   `refresh_url` (unknown: 404).
//!
//! Simulators, `POST`, answering JSON once the webhook has been delivered
//! (or failed to be: `delivered: false`):
//! - `simulate/accounts/{id}/update`: a JSON body of any of
//!   `details_submitted`, `charges_enabled`, `payouts_enabled`,
//!   `currently_due`, `past_due`, `eventually_due` (lists), `disabled_reason` (a string or null): the
//!   account changes and its `account.updated` is sent;
//! - `simulate/accounts/{id}/deauthorize`: the owner removes the platform
//!   in their Dashboard: `account.application.deauthorized`, and the
//!   account is `account_invalid` to us from then on;
//! - `simulate/webhooks/hold`: keep events back from now on;
//!   `simulate/webhooks/release?reverse&count=`: deliver what was held,
//!   in order or reversed (Stripe promises no order);
//! - `simulate/outage {calls, status?, path?, after?}`: the next `calls`
//!   API requests (whose path holds `path`) answer `status` (default
//!   503); with `after`, only once the call is done (Stripe acted, and
//!   we never heard so);
//! - `GET simulate/webhooks`: what was delivered (ids, types, landed).
//!
//! Payments, refunds, disputes and `GET v1/events` are in [`payments`]
//! (`fake_payments.rs`, S3); Checkout Sessions are S4's.

#[path = "fake_payments.rs"]
pub mod payments;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::Router;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

/// Checkout Sessions and their hosted page (S4).
#[path = "fake_checkout.rs"]
pub mod checkout;

use super::client::{ACCOUNT_DEAUTHORIZED, ACCOUNT_UPDATED, VERSION};
use super::webhook::{SIGNATURE_HEADER, sign};

/// The fake platform's published key and webhook signing secret.
pub const API_KEY: &str = "sk_test_fake_stripe_platform_key";
pub const WEBHOOK_SECRET: &str = "whsec_fake_stripe_webhook_secret";
/// How long an onboarding link lasts.
pub const LINK_TTL_MS: i64 = 5 * 60 * 1000;

#[derive(Clone, Debug)]
struct Link {
    account: String,
    refresh_url: String,
    return_url: String,
    expires_at: i64,
    used: bool,
}

#[derive(Clone, Debug, Deserialize)]
struct Outage {
    calls: usize,
    #[serde(default)]
    status: u16,
    #[serde(default)]
    path: String,
    /// Answer `status` only after doing the call: Stripe acted, and we
    /// never heard so.
    #[serde(default)]
    after: bool,
}

#[derive(Default)]
struct World {
    seq: u64,
    /// id → the account, in v1's shape.
    accounts: HashMap<String, Value>,
    /// Accounts whose owner removed the platform.
    removed: Vec<String>,
    /// Idempotency key → the body it was first sent with and the
    /// account it made.
    idempotency: HashMap<String, (String, String)>,
    /// Idempotency key → the failure Stripe stored against it, answered
    /// again for as long as the key is kept.
    failed_keys: HashMap<String, u16>,
    /// Onboarding link token → the link.
    links: HashMap<String, Link>,
    /// Every event made, delivered or not, oldest first.
    events: Vec<Value>,
    /// Every webhook body delivered, oldest first, and whether it landed.
    deliveries: Vec<(Value, bool)>,
    /// While set, events wait here instead of being delivered.
    held: Option<Vec<Value>>,
    outage: Option<Outage>,
    /// API requests answered, by `"<METHOD> <path without ids>"`.
    calls: HashMap<String, usize>,
    /// PaymentIntent id → the intent in Stripe's shape, its charge under
    /// `latest_charge` and its connected `account` ([`payments`]).
    payments: HashMap<String, Value>,
    /// Every dispute, oldest first, each naming its `payment_intent`.
    disputes: Vec<Value>,
    /// The QC run's account ([`Fake::qc_account`]), once made.
    qc_account: Option<String>,
}

impl World {
    fn id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        let tail = uuid::Uuid::new_v4().simple().to_string();
        format!("{prefix}{}{:04}", &tail[..12], self.seq % 10_000)
    }
}

pub struct Fake {
    /// Where browsers reach the fake (`{KEEP_APP_ORIGIN}{FAKE_PREFIX}`).
    public_base: String,
    /// Where webhooks go.
    webhook_url: String,
    http: reqwest::Client,
    world: Mutex<World>,
    checkout: Mutex<checkout::Checkout>,
}

impl Fake {
    pub fn new(public_base: String, webhook_url: String) -> Self {
        Self {
            public_base,
            webhook_url,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("a reqwest client"),
            world: Mutex::new(World::default()),
            checkout: Mutex::default(),
        }
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// An account as Stripe would answer it (v1's shape).
    pub fn account(&self, id: &str) -> Option<Value> {
        self.world().accounts.get(id).cloned()
    }

    /// Every account's id, oldest first.
    pub fn account_ids(&self) -> Vec<String> {
        let w = self.world();
        let mut ids: Vec<(i64, String)> = w
            .accounts
            .iter()
            .map(|(id, a)| (a["created_seq"].as_i64().unwrap_or(0), id.clone()))
            .collect();
        ids.sort();
        ids.into_iter().map(|(_, id)| id).collect()
    }

    /// API requests answered so far as `"<METHOD> <path without ids>"`
    /// (e.g. `"GET /v1/accounts"`).
    pub fn calls(&self, what: &str) -> usize {
        self.world().calls.get(what).copied().unwrap_or(0)
    }

    /// Every webhook body delivered so far, and whether it landed.
    pub fn deliveries(&self) -> Vec<(Value, bool)> {
        self.world().deliveries.clone()
    }

    /// Every event made so far, delivered or not, oldest first.
    pub fn events(&self) -> Vec<Value> {
        self.world().events.clone()
    }

    /// Make an event of `kind` about `object` on connected `account`, in
    /// Stripe's shape, and remember it. Not delivered: [`Self::deliver`].
    pub fn event(&self, account: &str, kind: &str, object: Value) -> Value {
        let mut w = self.world();
        let event = json!({
            "id": w.id("evt_"),
            "object": "event",
            "api_version": VERSION,
            "created": contracts::now_ms() / 1000,
            "livemode": false,
            "type": kind,
            "account": account,
            "pending_webhooks": 1,
            "request": { "id": null, "idempotency_key": null },
            "data": { "object": object }
        });
        w.events.push(event.clone());
        event
    }

    /// Deliver `events`, each in its own signed webhook, in order;
    /// whether every one got a 2xx. While holding, they wait instead.
    pub async fn deliver(&self, events: Vec<Value>) -> bool {
        if let Some(held) = self.world().held.as_mut() {
            held.extend(events);
            return true;
        }
        self.send(events).await
    }

    /// Deliver `events` now, holding or not.
    async fn send(&self, events: Vec<Value>) -> bool {
        let mut all = true;
        for event in events {
            let raw = event.to_string();
            let signature = sign(WEBHOOK_SECRET, contracts::now_ms() / 1000, raw.as_bytes());
            let landed = self
                .http
                .post(&self.webhook_url)
                .header("Content-Type", "application/json")
                .header(SIGNATURE_HEADER, signature)
                .body(raw)
                .send()
                .await
                .is_ok_and(|r| r.status().is_success());
            self.world().deliveries.push((event, landed));
            all &= landed;
        }
        all
    }

    /// Change an account (`patch`: `simulate/accounts/{id}/update`'s
    /// body) and answer its `account.updated` event, not yet delivered.
    /// `None`: no such account.
    pub fn update_account(&self, id: &str, patch: &Value) -> Option<Value> {
        let snapshot = {
            let mut w = self.world();
            let a = w.accounts.get_mut(id)?;
            for flag in ["details_submitted", "charges_enabled", "payouts_enabled"] {
                if let Some(v) = patch.get(flag).and_then(Value::as_bool) {
                    a[flag] = json!(v);
                }
            }
            for list in ["currently_due", "past_due", "eventually_due"] {
                if let Some(due) = patch.get(list).filter(|v| v.is_array()) {
                    a["requirements"][list] = due.clone();
                }
            }
            if let Some(reason) = patch.get("disabled_reason") {
                a["requirements"]["disabled_reason"] = reason.clone();
            }
            a.clone()
        };
        Some(self.event(id, ACCOUNT_UPDATED, snapshot))
    }

    /// The account's owner removes the platform: its
    /// `account.application.deauthorized` event, not yet delivered, and
    /// `account_invalid` for the account from now on.
    pub fn remove_platform(&self, id: &str) -> Option<Value> {
        {
            let mut w = self.world();
            if !w.accounts.contains_key(id) {
                return None;
            }
            w.removed.push(id.to_owned());
        }
        Some(self.event(
            id,
            ACCOUNT_DEAUTHORIZED,
            json!({ "id": "ca_fake", "object": "application", "name": "keep-together" }),
        ))
    }

    /// Forget every account, as a wiped sandbox would (tests).
    pub fn wipe(&self) {
        let mut w = self.world();
        w.accounts.clear();
        w.qc_account = None;
        w.idempotency.clear();
        w.failed_keys.clear();
        w.links.clear();
    }

    /// The QC run's connected account, as the one onboarded by hand in a
    /// sandbox is: Stripe's form sent in and card payments on. Made on
    /// first use and the same from then on (`routes::qc_stripe`).
    pub fn qc_account(&self) -> String {
        let mut w = self.world();
        if let Some(id) = w
            .qc_account
            .clone()
            .filter(|id| w.accounts.contains_key(id))
        {
            return id;
        }
        let made = Self::new_account(
            &mut w,
            "QC",
            "gb",
            "full",
            "account",
            "stripe",
            json!({ "keep_qc": "1" }),
        );
        let id = made["id"].as_str().expect("an account id").to_owned();
        let a = w.accounts.get_mut(&id).expect("just made");
        for flag in ["details_submitted", "charges_enabled", "payouts_enabled"] {
            a[flag] = json!(true);
        }
        a["requirements"] = json!({
            "currently_due": [], "past_due": [], "eventually_due": [],
            "disabled_reason": null
        });
        w.qc_account = Some(id.clone());
        id
    }

    fn new_account(
        w: &mut World,
        name: &str,
        country: &str,
        dashboard: &str,
        fees: &str,
        losses: &str,
        metadata: Value,
    ) -> Value {
        let id = w.id("acct_");
        let account = json!({
            "id": id,
            "object": "account",
            "country": country.to_uppercase(),
            "created": contracts::now_ms() / 1000,
            "created_seq": w.seq,
            "business_profile": { "name": name },
            "controller": {
                "stripe_dashboard": { "type": dashboard },
                "fees": { "payer": fees },
                "losses": { "payments": losses },
                "requirement_collection": "stripe"
            },
            "details_submitted": false,
            "charges_enabled": false,
            "payouts_enabled": false,
            "requirements": {
                "currently_due": ["business_profile.url", "external_account",
                    "tos_acceptance.date"],
                "past_due": ["business_profile.url", "external_account",
                    "tos_acceptance.date"],
                "eventually_due": ["business_profile.url", "external_account",
                    "tos_acceptance.date"],
                "disabled_reason": "requirements.past_due"
            },
            "metadata": metadata
        });
        w.accounts.insert(id, account.clone());
        account
    }

    fn new_link(&self, account: &str, refresh_url: &str, return_url: &str) -> (String, i64) {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let expires_at = contracts::now_ms() + LINK_TTL_MS;
        self.world().links.insert(
            token.clone(),
            Link {
                account: account.to_owned(),
                refresh_url: refresh_url.to_owned(),
                return_url: return_url.to_owned(),
                expires_at,
                used: false,
            },
        );
        (
            format!("{}/onboarding/{token}", self.public_base),
            expires_at,
        )
    }

    /// Whether the platform can reach `id`.
    fn reachable(w: &World, id: &str) -> bool {
        w.accounts.contains_key(id) && !w.removed.iter().any(|r| r == id)
    }
}

/// Stripe's error body.
fn error(status: StatusCode, kind: &str, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "error": { "type": kind, "code": code, "message": message,
                "doc_url": format!("https://docs.stripe.com/error-codes/{code}") }
        })),
    )
        .into_response()
}

fn invalid(code: &str, message: &str) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "invalid_request_error",
        code,
        message,
    )
}

/// What Stripe answers for an account that isn't the platform's.
fn account_invalid() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "invalid_request_error",
        "account_invalid",
        "The provided key does not have access to that account (or it does not exist).",
    )
}

pub fn router<S: Clone + Send + Sync + 'static>(fake: Arc<Fake>) -> Router<S> {
    let api = Router::new()
        .route("/v2/core/accounts", post(create_account_v2))
        .route("/v1/accounts", post(create_account_v1))
        .route("/v1/accounts/{id}", get(get_account))
        .route("/v2/core/account_links", post(create_link_v2))
        .route("/v1/account_links", post(create_link_v1))
        .merge(payments::api())
        .merge(checkout::api())
        .layer(axum::middleware::from_fn_with_state(fake.clone(), gate));
    Router::new()
        .merge(api)
        .merge(checkout::pages())
        .route("/onboarding/{token}", get(onboarding_page))
        .route("/onboarding/{token}/decide", post(onboarding_decide))
        .route("/simulate/accounts/{id}/update", post(simulate_update))
        .route(
            "/simulate/accounts/{id}/deauthorize",
            post(simulate_deauthorize),
        )
        .route("/simulate/webhooks", get(list_deliveries))
        .route("/simulate/webhooks/hold", post(hold_webhooks))
        .route("/simulate/webhooks/release", post(release_webhooks))
        .route("/simulate/outage", post(outage))
        .merge(payments::simulators())
        .with_state(fake)
}

/// Every API request: counted, answered by an outage while one lasts,
/// and refused without the platform's key and the version we pin.
async fn gate(
    State(fake): State<Arc<Fake>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_owned();
    let counted = format!(
        "{} /{}",
        req.method(),
        path.split('/')
            .filter(|s| !s.is_empty() && !s.starts_with("acct_"))
            .collect::<Vec<_>>()
            .join("/")
    );
    let key = idempotency_key(req.headers());
    let outage = |status: u16| {
        error(
            StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            "api_error",
            "simulated_outage",
            "A simulated outage",
        )
    };
    let failing = {
        let mut w = fake.world();
        *w.calls.entry(counted).or_default() += 1;
        // A failure stored against this key is all the key answers now.
        if let Some(status) = key.as_ref().and_then(|k| w.failed_keys.get(k)) {
            return outage(*status);
        }
        match w.outage.as_mut() {
            Some(o) if o.calls > 0 && path.contains(&o.path) => {
                o.calls -= 1;
                Some((if o.status == 0 { 503 } else { o.status }, o.after))
            }
            _ => None,
        }
    };
    match failing {
        // Done, but the caller never hears so.
        Some((status, true)) => {
            let _ = next.run(req).await;
            return outage(status);
        }
        Some((status, false)) => {
            // As Stripe: what a keyed request came to is stored against
            // its key, a 500 included (not a 401 or a 429).
            if let Some(key) = key
                && status != 401
                && status != 429
            {
                fake.world().failed_keys.insert(key, status);
            }
            return outage(status);
        }
        None => {}
    }
    let (keyed, versioned) = {
        let header = |name: &str| req.headers().get(name).and_then(|v| v.to_str().ok());
        (
            header("Authorization").and_then(|v| v.strip_prefix("Bearer ")) == Some(API_KEY),
            header("Stripe-Version") == Some(VERSION),
        )
    };
    if !keyed {
        return error(
            StatusCode::UNAUTHORIZED,
            "invalid_request_error",
            "api_key_invalid",
            "Invalid API Key provided",
        );
    }
    if !versioned {
        return invalid(
            "invalid_api_version",
            "Stripe-Version header missing or not the pinned version",
        );
    }
    next.run(req).await
}

fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// What a create under `key` already came to: the account it made, or
/// Stripe's refusal when the key comes back with another body.
#[allow(clippy::result_large_err)]
fn replay(w: &World, key: &Option<String>, body: &str) -> Result<Option<Value>, Response> {
    let Some((first, id)) = key.as_ref().and_then(|k| w.idempotency.get(k)) else {
        return Ok(None);
    };
    if first != body {
        return Err(invalid(
            "idempotency_error",
            "Keys for idempotent requests can only be used with the same parameters \
             they were first used with.",
        ));
    }
    Ok(w.accounts.get(id).cloned())
}

/// `POST v2/core/accounts`: JSON. The properties we need must be asked
/// for (the full Dashboard, Stripe collecting fees from the account and
/// carrying the losses): Stripe has no default we could lean on in v2.
async fn create_account_v2(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let text = |p: &str| body.pointer(p).and_then(Value::as_str);
    let key = idempotency_key(&headers);
    let sent = body.to_string();
    let mut w = fake.world();
    let account = match replay(&w, &key, &sent) {
        Err(refused) => return refused,
        Ok(Some(a)) => a,
        Ok(None) => {
            let (Some(dashboard), Some(fees), Some(losses)) = (
                text("/dashboard"),
                text("/defaults/responsibilities/fees_collector"),
                text("/defaults/responsibilities/losses_collector"),
            ) else {
                return invalid(
                    "parameter_missing",
                    "dashboard and defaults.responsibilities are required",
                );
            };
            // v2 names who collects; v1 names who pays.
            let payer = if fees == "stripe" {
                "account"
            } else {
                "application"
            };
            let a = Fake::new_account(
                &mut w,
                text("/display_name").unwrap_or(""),
                text("/identity/country").unwrap_or(""),
                dashboard,
                payer,
                losses,
                body.get("metadata").cloned().unwrap_or(json!({})),
            );
            if let Some(key) = key {
                w.idempotency
                    .insert(key, (sent, a["id"].as_str().unwrap_or("").to_owned()));
            }
            a
        }
    };
    Json(json!({
        "id": account["id"],
        "object": "v2.core.account",
        "display_name": account["business_profile"]["name"],
        "dashboard": account["controller"]["stripe_dashboard"]["type"],
        "metadata": account["metadata"]
    }))
    .into_response()
}

/// `POST v1/accounts`: form-encoded, nested keys in brackets. Unsaid
/// controller properties take Stripe's defaults (which are ours).
async fn create_account_v1(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let field =
        |k: &str, default: &'static str| form.get(k).map_or(default.to_owned(), |v| v.to_owned());
    let key = idempotency_key(&headers);
    let mut pairs: Vec<String> = form.iter().map(|(k, v)| format!("{k}={v}")).collect();
    pairs.sort();
    let sent = pairs.join("&");
    let mut w = fake.world();
    let account = match replay(&w, &key, &sent) {
        Err(refused) => return refused,
        Ok(Some(a)) => a,
        Ok(None) => {
            let metadata: serde_json::Map<String, Value> = form
                .iter()
                .filter_map(|(k, v)| {
                    let name = k.strip_prefix("metadata[")?.strip_suffix(']')?;
                    Some((name.to_owned(), json!(v)))
                })
                .collect();
            let a = Fake::new_account(
                &mut w,
                &field("business_profile[name]", ""),
                &field("country", "GB"),
                &field("controller[stripe_dashboard][type]", "full"),
                &field("controller[fees][payer]", "account"),
                &field("controller[losses][payments]", "stripe"),
                Value::Object(metadata),
            );
            if let Some(key) = key {
                w.idempotency
                    .insert(key, (sent, a["id"].as_str().unwrap_or("").to_owned()));
            }
            a
        }
    };
    Json(account).into_response()
}

async fn get_account(State(fake): State<Arc<Fake>>, Path(id): Path<String>) -> Response {
    let w = fake.world();
    if !Fake::reachable(&w, &id) {
        return account_invalid();
    }
    Json(w.accounts[&id].clone()).into_response()
}

/// Both link creates, once their fields are out of their bodies.
fn link(
    fake: &Fake,
    account: Option<&str>,
    refresh: Option<&str>,
    ret: Option<&str>,
    v2: bool,
) -> Response {
    let (Some(account), Some(refresh), Some(ret)) = (account, refresh, ret) else {
        return invalid(
            "parameter_missing",
            "account, refresh_url and return_url are required",
        );
    };
    if !Fake::reachable(&fake.world(), account) {
        return account_invalid();
    }
    let (url, expires_at) = fake.new_link(account, refresh, ret);
    if v2 {
        let expires = time::OffsetDateTime::from_unix_timestamp(expires_at / 1000)
            .ok()
            .and_then(|t| {
                t.format(&time::format_description::well_known::Rfc3339)
                    .ok()
            });
        Json(json!({
            "object": "v2.core.account_link", "account": account, "url": url,
            "expires_at": expires
        }))
        .into_response()
    } else {
        Json(json!({
            "object": "account_link", "created": contracts::now_ms() / 1000,
            "expires_at": expires_at / 1000, "url": url
        }))
        .into_response()
    }
}

async fn create_link_v2(State(fake): State<Arc<Fake>>, Json(body): Json<Value>) -> Response {
    let text = |p: &str| body.pointer(p).and_then(Value::as_str);
    if text("/use_case/type") != Some("account_onboarding") {
        return invalid("parameter_invalid", "use_case.type: account_onboarding");
    }
    link(
        &fake,
        text("/account"),
        text("/use_case/account_onboarding/refresh_url"),
        text("/use_case/account_onboarding/return_url"),
        true,
    )
}

async fn create_link_v1(
    State(fake): State<Arc<Fake>>,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let field = |k: &str| form.get(k).map(String::as_str);
    if field("type") != Some("account_onboarding") {
        return invalid("parameter_invalid", "type: account_onboarding");
    }
    link(
        &fake,
        field("account"),
        field("refresh_url"),
        field("return_url"),
        false,
    )
}

/// The link behind `token` if it can still be used; else where to send
/// the browser instead (its `refresh_url`), or nothing for no such link.
fn usable(fake: &Fake, token: &str) -> Result<Link, Option<String>> {
    let w = fake.world();
    let link = w.links.get(token).ok_or(None)?;
    if link.used || link.expires_at < contracts::now_ms() || !Fake::reachable(&w, &link.account) {
        return Err(Some(link.refresh_url.clone()));
    }
    Ok(link.clone())
}

fn elsewhere(to: Option<String>) -> Response {
    match to {
        Some(url) => Redirect::to(&url).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `GET onboarding/{token}`: Stripe's hosted form.
async fn onboarding_page(State(fake): State<Arc<Fake>>, Path(token): Path<String>) -> Response {
    let link = match usable(&fake, &token) {
        Ok(link) => link,
        Err(to) => return elsewhere(to),
    };
    let action = format!("{}/onboarding/{token}/decide", fake.public_base);
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <title>Fake Stripe: set up your account</title></head><body>\
         <h1>Fake Stripe</h1>\
         <p>Set up payments for account <code>{}</code>. This is keep-together’s \
         stand-in for Stripe’s onboarding form: no real account exists.</p>\
         <form method=\"post\" action=\"{action}\">\
         <button name=\"decision\" value=\"complete\">Complete</button> \
         <button name=\"decision\" value=\"partial\">Submit, more needed</button> \
         <button name=\"decision\" value=\"leave\">Leave</button>\
         </form></body></html>",
        link.account
    ))
    .into_response()
}

#[derive(Deserialize)]
struct Decide {
    decision: String,
}

/// `POST onboarding/{token}/decide`: what the admin did on the form.
async fn onboarding_decide(
    State(fake): State<Arc<Fake>>,
    Path(token): Path<String>,
    Form(d): Form<Decide>,
) -> Response {
    let link = match usable(&fake, &token) {
        Ok(link) => link,
        Err(to) => return elsewhere(to),
    };
    let patch = match d.decision.as_str() {
        "complete" => Some(json!({
            "details_submitted": true, "charges_enabled": true, "payouts_enabled": true,
            "currently_due": [], "past_due": [], "eventually_due": [],
            "disabled_reason": null
        })),
        "partial" => Some(json!({
            "details_submitted": true, "charges_enabled": false, "payouts_enabled": false,
            "currently_due": ["external_account"], "past_due": [],
            "eventually_due": ["external_account"],
            "disabled_reason": "requirements.pending_verification"
        })),
        "leave" => None,
        _ => return invalid("parameter_invalid", "decision"),
    };
    if let Some(l) = fake.world().links.get_mut(&token) {
        l.used = true;
    }
    if let Some(patch) = patch
        && let Some(event) = fake.update_account(&link.account, &patch)
    {
        fake.deliver(vec![event]).await;
    }
    Redirect::to(&link.return_url).into_response()
}

fn simulated(delivered: bool, mut extra: Value) -> Response {
    extra["ok"] = json!(true);
    extra["delivered"] = json!(delivered);
    Json(extra).into_response()
}

/// `POST simulate/accounts/{id}/update`.
async fn simulate_update(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Json(patch): Json<Value>,
) -> Response {
    let Some(event) = fake.update_account(&id, &patch) else {
        return account_invalid();
    };
    let event_id = event["id"].clone();
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "event": event_id }))
}

/// `POST simulate/accounts/{id}/deauthorize`.
async fn simulate_deauthorize(State(fake): State<Arc<Fake>>, Path(id): Path<String>) -> Response {
    let Some(event) = fake.remove_platform(&id) else {
        return account_invalid();
    };
    let event_id = event["id"].clone();
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "event": event_id }))
}

/// `GET simulate/webhooks`.
async fn list_deliveries(State(fake): State<Arc<Fake>>) -> Response {
    let out: Vec<Value> = fake
        .deliveries()
        .iter()
        .map(|(e, landed)| {
            json!({ "id": e["id"], "type": e["type"], "account": e["account"],
                "landed": landed })
        })
        .collect();
    Json(json!({ "deliveries": out })).into_response()
}

/// `POST simulate/webhooks/hold`: keep events back from now on.
async fn hold_webhooks(State(fake): State<Arc<Fake>>) -> Response {
    fake.world().held.get_or_insert_with(Vec::new);
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    reverse: bool,
    /// Deliver only the first `count` held events and keep holding the
    /// rest.
    count: Option<usize>,
}

/// `POST simulate/webhooks/release?reverse&count=`: deliver what was
/// held, in order or reversed, and (without `count`) stop holding.
async fn release_webhooks(State(fake): State<Arc<Fake>>, Query(r): Query<Release>) -> Response {
    let mut events = {
        let mut w = fake.world();
        match (r.count, w.held.as_mut()) {
            (Some(n), Some(held)) => held.drain(..n.min(held.len())).collect(),
            _ => w.held.take().unwrap_or_default(),
        }
    };
    if r.reverse {
        events.reverse();
    }
    let n = events.len();
    let delivered = fake.send(events).await;
    simulated(delivered, json!({ "events": n }))
}

/// `POST simulate/outage {calls, status?, path?, after?}`; `calls: 0` ends it.
async fn outage(State(fake): State<Arc<Fake>>, Json(o): Json<Outage>) -> Response {
    fake.world().outage = Some(o);
    Json(json!({ "ok": true })).into_response()
}
