//! `KEEP_GOCARDLESS=fake`: a GoCardless mock mounted on this server at
//! [`super::FAKE_PREFIX`], for local runs, cargo tests and QC. It answers
//! the calls [`super::client::Api`] makes, in GoCardless's shapes (the
//! `{"<resources>": {...}}` envelopes, error bodies, idempotency
//! conflicts), keeps everything in memory, and delivers webhooks to this
//! server signed like GoCardless's (`Webhook-Signature`, HMAC-SHA256 hex
//! under [`WEBHOOK_SECRET`]), with `links.organisation` as an OAuth app's
//! webhooks carry. Its credentials are published constants: `KEEP_ENV=prod`
//! refuses fake mode.
//!
//! Pages a browser visits (what GoCardless hosts):
//! - `GET connect/oauth/authorize?…`: "Connect with GoCardless"; Connect
//!   makes a new fake account and sends the browser to `redirect_uri`
//!   with a code; Cancel with `error=access_denied`;
//! - `GET flow/{BRF…}`: the donor's Direct Debit sign-up; Set up makes a
//!   customer and a mandate (`pending_submission`) and fulfils the
//!   billing request. For an Instant Bank Pay request (a payment request,
//!   no mandate) it is "Pay by bank": a customer and a `confirmed`
//!   payment, which (unlike the request) carries no metadata, so only the
//!   billing request's `fulfilled` event names its donor.
//!
//! API beyond the client's D2 calls: `POST payments` (a one-off on a
//! mandate), `GET events` (`created_at[gte]`, `limit`, `after`: newest
//! first, as GoCardless lists).
//!
//! Scenario simulators (like the sandbox's), `POST`, answering JSON:
//! - `simulate/mandates/{id}/{activate|fail|cancel|expire}` (fail, cancel
//!   and expire cancel its subscriptions too, as GoCardless does);
//! - `simulate/subscriptions/{id}/payment`: the subscription's next
//!   payment (`pending_submission`), answering `{payment}`;
//! - `simulate/mandates/{id}/payment?amount=&subscription=`: a one-off on
//!   the mandate with no metadata (as if taken in GoCardless's
//!   dashboard), or naming a subscription;
//! - `simulate/organisations/{OR…}/payment?amount=`: a payment from a
//!   stranger (a new customer and mandate we never asked for), answering
//!   `{payment, mandate}`;
//! - `simulate/payments/{id}/{retry|submit|confirm|fail|charge_back|cancel_chargeback}`
//!   (`retry?charge_date=`: a new charge date);
//! - `GET simulate/webhooks`: what was delivered (ids, statuses).
//!
//! Every simulator answers once the webhook has been delivered (or failed
//! to be: `delivered: false`).

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

use super::webhook::{SIGNATURE_HEADER, sign};

/// The fake partner app's published credentials.
pub const CLIENT_ID: &str = "fake-gocardless-client";
pub const CLIENT_SECRET: &str = "fake-gocardless-client-secret";
pub const WEBHOOK_SECRET: &str = "fake-gocardless-webhook-secret";

#[derive(Clone, Debug)]
struct Resource {
    org: String,
    kind: &'static str,
    body: Value,
}

#[derive(Default)]
struct World {
    seq: u64,
    /// token → organisation id
    tokens: HashMap<String, String>,
    /// code → (organisation id, redirect_uri)
    codes: HashMap<String, (String, String)>,
    /// id → resource (billing requests, flows, customers, mandates,
    /// subscriptions, payments)
    resources: HashMap<String, Resource>,
    /// (organisation, idempotency key) → resource id
    idempotency: HashMap<(String, String), String>,
    /// Every webhook body delivered, oldest first, and whether it landed.
    deliveries: Vec<(Value, bool)>,
    /// While set, events wait here instead of being delivered
    /// (`simulate/webhooks/hold`), to be released in or out of order.
    held: Option<Vec<Value>>,
    /// The next `calls` API requests whose path holds `path` answer
    /// `status` (`simulate/outage`).
    outage: Option<Outage>,
    /// API requests answered, by `"<METHOD> <resource>"`.
    calls: HashMap<String, usize>,
    /// Every event made, delivered or not, oldest first: `GET events`.
    events: Vec<(String, Value)>,
}

#[derive(Clone, Debug, Deserialize)]
struct Outage {
    calls: usize,
    /// 0: answer normally (after the delay).
    #[serde(default)]
    status: u16,
    #[serde(default)]
    path: String,
    /// Wait this long before answering.
    #[serde(default)]
    delay_ms: u64,
}

impl World {
    fn id(&mut self, prefix: &str) -> String {
        self.seq += 1;
        let tail = uuid::Uuid::new_v4().simple().to_string().to_uppercase();
        format!("{prefix}{}{:04}", &tail[..8], self.seq % 10_000)
    }
}

pub struct Fake {
    /// Where browsers reach the fake (`{KEEP_APP_ORIGIN}{FAKE_PREFIX}`).
    public_base: String,
    /// Where webhooks go.
    webhook_url: String,
    http: reqwest::Client,
    world: Mutex<World>,
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
        }
    }

    fn world(&self) -> std::sync::MutexGuard<'_, World> {
        self.world.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Make a connected account and its token directly (tests).
    pub fn connect_account(&self) -> (String, String) {
        let mut w = self.world();
        let org = w.id("OR");
        let token = format!("fake_token_{}", uuid::Uuid::new_v4().simple());
        w.tokens.insert(token.clone(), org.clone());
        (org, token)
    }

    /// The live tokens of account `org` (tests).
    pub fn live_tokens(&self, org: &str) -> Vec<String> {
        self.world()
            .tokens
            .iter()
            .filter(|(_, o)| *o == org)
            .map(|(t, _)| t.clone())
            .collect()
    }

    /// Whether `token` is live (tests).
    pub fn token_works(&self, token: &str) -> bool {
        self.world().tokens.contains_key(token)
    }

    /// A resource's JSON as GoCardless would answer it (tests, QC).
    pub fn resource(&self, id: &str) -> Option<Value> {
        self.world().resources.get(id).map(|r| r.body.clone())
    }

    /// Ids of every resource of `kind` (`billing_requests`, `mandates`, …).
    pub fn ids(&self, kind: &str) -> Vec<String> {
        let mut ids: Vec<String> = self
            .world()
            .resources
            .iter()
            .filter(|(_, r)| r.kind == kind)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// API requests answered so far as `"<METHOD> <resource>"` (e.g.
    /// `"GET billing_requests"`).
    pub fn calls(&self, what: &str) -> usize {
        self.world().calls.get(what).copied().unwrap_or(0)
    }

    /// Every webhook body delivered so far.
    pub fn deliveries(&self) -> Vec<(Value, bool)> {
        self.world().deliveries.clone()
    }

    fn event(
        w: &mut World,
        org: &str,
        resource_type: &str,
        action: &str,
        links: Value,
        cause: &str,
        description: &str,
    ) -> Value {
        let mut links = links;
        links["organisation"] = Value::String(org.to_owned());
        let event = json!({
            "id": w.id("EV"),
            "created_at": now_iso(),
            "resource_type": resource_type,
            "action": action,
            "links": links,
            "details": {
                "origin": "gocardless",
                "cause": cause,
                "description": description
            },
            "metadata": {},
            "resource_metadata": {}
        });
        w.events.push((org.to_owned(), event.clone()));
        event
    }

    /// A new payment of `org`'s, `pending_submission` (or `status`), and
    /// its `created` event.
    #[allow(clippy::too_many_arguments)]
    fn new_payment(
        w: &mut World,
        org: &str,
        amount: i64,
        charge_date: String,
        status: &str,
        description: Value,
        metadata: Value,
        links: Value,
    ) -> (String, Value) {
        let payment = w.id("PM");
        let body = json!({
            "id": payment,
            "created_at": now_iso(),
            "amount": amount,
            "currency": "GBP",
            "charge_date": charge_date,
            "status": status,
            "description": description,
            "metadata": metadata,
            "links": links
        });
        w.resources.insert(
            payment.clone(),
            Resource {
                org: org.to_owned(),
                kind: "payments",
                body,
            },
        );
        let event = Fake::event(
            w,
            org,
            "payments",
            "created",
            json!({ "payment": payment }),
            "payment_created",
            "Payment created.",
        );
        (payment, event)
    }

    /// Deliver `events` in one signed webhook; whether it got a 2xx.
    pub async fn deliver(&self, events: Vec<Value>) -> bool {
        if events.is_empty() {
            return true;
        }
        if let Some(held) = self.world().held.as_mut() {
            held.extend(events);
            return true;
        }
        self.send(events).await
    }

    /// Deliver `events` now, holding or not.
    async fn send(&self, events: Vec<Value>) -> bool {
        if events.is_empty() {
            return true;
        }
        let body = json!({ "events": events });
        let raw = body.to_string();
        let signature = sign(WEBHOOK_SECRET, raw.as_bytes());
        let landed = self
            .http
            .post(&self.webhook_url)
            .header("Content-Type", "application/json")
            .header(SIGNATURE_HEADER, signature)
            .body(raw)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        self.world().deliveries.push((body, landed));
        landed
    }

    fn set_status(&self, id: &str, status: &str) -> Option<Resource> {
        let mut w = self.world();
        let r = w.resources.get_mut(id)?;
        r.body["status"] = Value::String(status.into());
        Some(r.clone())
    }
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

fn today_plus(days: i64) -> String {
    let d = time::OffsetDateTime::now_utc().date() + time::Duration::days(days);
    format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())
}

/// GoCardless's error envelope.
fn error(status: StatusCode, kind: &str, reason: &str, message: &str, links: Value) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "type": kind,
                "code": status.as_u16(),
                "message": message,
                "request_id": "fake",
                "documentation_url": "https://docs.gocardless.com/",
                "errors": [{ "reason": reason, "message": message, "links": links }]
            }
        })),
    )
        .into_response()
}

fn not_found() -> Response {
    error(
        StatusCode::NOT_FOUND,
        "invalid_api_usage",
        "resource_not_found",
        "Resource not found",
        json!({}),
    )
}

/// The organisation the request's bearer token belongs to, after the
/// headers every API call carries. (The refusal is the response itself,
/// as handlers answer it.)
#[allow(clippy::result_large_err)]
fn caller(fake: &Fake, headers: &HeaderMap) -> Result<String, Response> {
    if headers
        .get("GoCardless-Version")
        .and_then(|v| v.to_str().ok())
        != Some(super::client::VERSION)
    {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_api_usage",
            "missing_version_header",
            "GoCardless-Version header missing or unknown",
            json!({}),
        ));
    }
    let token = headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    fake.world().tokens.get(token).cloned().ok_or_else(|| {
        error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_usage",
            "access_token_not_found",
            "Access token not found",
            json!({}),
        )
    })
}

pub fn router<S: Clone + Send + Sync + 'static>(fake: Arc<Fake>) -> Router<S> {
    let api = Router::new()
        .route("/billing_requests", post(create_billing_request))
        .route("/billing_requests/{id}", get(get_resource))
        .route(
            "/billing_requests/{id}/actions/cancel",
            post(cancel_billing_request),
        )
        .route("/billing_request_flows", post(create_flow))
        .route("/subscriptions", post(create_subscription))
        .route("/subscriptions/{id}", get(get_resource))
        .route(
            "/subscriptions/{id}/actions/cancel",
            post(cancel_subscription),
        )
        .route("/mandates/{id}", get(get_resource))
        .route("/mandates/{id}/actions/cancel", post(cancel_mandate))
        .route("/payments", post(create_payment))
        .route("/payments/{id}", get(get_resource))
        .route("/events", get(list_events))
        .layer(axum::middleware::from_fn_with_state(fake.clone(), gate));
    Router::new()
        .route("/connect/oauth/authorize", get(authorize))
        .route("/connect/oauth/decide", post(decide))
        .nest(
            "/connect/oauth",
            Router::new()
                .route("/access_token", post(access_token))
                .route("/revoke", post(revoke))
                .layer(axum::middleware::from_fn_with_state(fake.clone(), gate)),
        )
        .nest("/api", api)
        .route("/flow/{id}", get(flow_page))
        .route("/flow/{id}/complete", post(complete_flow))
        .route(
            "/simulate/mandates/{id}/payment",
            post(simulate_mandate_payment),
        )
        .route("/simulate/mandates/{id}/{action}", post(simulate_mandate))
        .route(
            "/simulate/organisations/{org}/payment",
            post(simulate_stranger_payment),
        )
        .route(
            "/simulate/subscriptions/{id}/payment",
            post(simulate_payment),
        )
        .route(
            "/simulate/payments/{id}/{action}",
            post(simulate_payment_action),
        )
        .route("/simulate/webhooks", get(webhooks))
        .route("/simulate/webhooks/hold", post(hold_webhooks))
        .route("/simulate/webhooks/release", post(release_webhooks))
        .route("/simulate/outage", post(outage))
        .with_state(fake)
}

/// Every API request (and the token exchange and revoke): counted, and
/// answered by an outage while one lasts.
async fn gate(
    State(fake): State<Arc<Fake>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_owned();
    let resource = path.trim_start_matches('/').split('/').next().unwrap_or("");
    let failing = {
        let mut w = fake.world();
        *w.calls
            .entry(format!("{} {resource}", req.method()))
            .or_default() += 1;
        match w.outage.as_mut() {
            Some(o) if o.calls > 0 && path.contains(&o.path) => {
                o.calls -= 1;
                Some((o.status, o.delay_ms))
            }
            _ => None,
        }
    };
    if let Some((_, delay)) = failing
        && delay > 0
    {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
    }
    match failing.map(|(status, _)| status).filter(|s| *s != 0) {
        Some(status) => error(
            StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            "gocardless",
            "simulated_outage",
            "A simulated outage",
            json!({}),
        ),
        None => next.run(req).await,
    }
}

/// `POST simulate/outage {calls, status?, path?, delay_ms?}`: the next
/// `calls` API requests (whose path holds `path`) wait `delay_ms`, then
/// answer `status` (0 or none: as usual); `calls: 0` ends it.
async fn outage(State(fake): State<Arc<Fake>>, Json(o): Json<Outage>) -> Response {
    fake.world().outage = Some(o);
    Json(json!({ "ok": true })).into_response()
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
    /// rest (never delivered unless released later).
    count: Option<usize>,
}

/// `POST simulate/webhooks/release?reverse`: deliver what was held, in
/// one batch, in order or reversed, and stop holding.
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

async fn cancel_subscription(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let event = {
        let mut w = fake.world();
        let Some(r) = w
            .resources
            .get_mut(&id)
            .filter(|r| r.org == org && r.kind == "subscriptions")
        else {
            return not_found();
        };
        if r.body["status"] == "cancelled" {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_state",
                "subscription_already_cancelled",
                "The subscription is already cancelled",
                json!({}),
            );
        }
        r.body["status"] = json!("cancelled");
        let mut e = Fake::event(
            &mut w,
            &org,
            "subscriptions",
            "cancelled",
            json!({ "subscription": id }),
            "subscription_cancelled",
            "The subscription was cancelled at your request.",
        );
        e["details"]["origin"] = json!("api");
        e
    };
    let body = fake.resource(&id).unwrap_or_default();
    fake.deliver(vec![event]).await;
    Json(json!({ "subscriptions": body })).into_response()
}

fn page(title: &str, body: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title}</title>\
         <style>body{{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}}\
         .fake{{background:#fde68a;padding:.5rem .75rem;border-radius:.375rem}}\
         button{{font-size:1rem;padding:.5rem 1rem;margin-right:.5rem}}\
         label{{display:block;margin:.75rem 0}}input{{font-size:1rem;width:100%}}</style>\
         </head><body><p class=\"fake\">Fake GoCardless: no real money or bank details.</p>\
         <h1>{title}</h1>{body}</body></html>"
    ))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[derive(Deserialize)]
struct Authorize {
    client_id: Option<String>,
    redirect_uri: Option<String>,
    state: Option<String>,
    response_type: Option<String>,
    scope: Option<String>,
}

async fn authorize(Query(q): Query<Authorize>) -> Response {
    if q.client_id.as_deref() != Some(CLIENT_ID)
        || q.response_type.as_deref() != Some("code")
        || !matches!(q.scope.as_deref(), Some("read_write" | "read_only"))
    {
        return (StatusCode::BAD_REQUEST, "invalid_request").into_response();
    }
    let redirect = escape(q.redirect_uri.as_deref().unwrap_or(""));
    let state = escape(q.state.as_deref().unwrap_or(""));
    page(
        "Connect with GoCardless",
        &format!(
            "<p>keep-together would like to collect Direct Debits through your GoCardless \
             account.</p>\
             <form method=\"post\" action=\"decide\">\
             <input type=\"hidden\" name=\"redirect_uri\" value=\"{redirect}\">\
             <input type=\"hidden\" name=\"state\" value=\"{state}\">\
             <label>An existing account id (blank: a new account) \
             <input name=\"account\" value=\"\"></label>\
             <button name=\"decision\" value=\"connect\">Connect</button>\
             <button name=\"decision\" value=\"cancel\">Cancel</button></form>"
        ),
    )
    .into_response()
}

#[derive(Deserialize)]
struct Decide {
    redirect_uri: String,
    state: String,
    decision: String,
    /// An account the fake already knows (`OR…`); blank: a new one.
    #[serde(default)]
    account: String,
}

async fn decide(State(fake): State<Arc<Fake>>, Form(d): Form<Decide>) -> Response {
    let Ok(mut url) = reqwest::Url::parse(&d.redirect_uri) else {
        return (StatusCode::BAD_REQUEST, "redirect_uri").into_response();
    };
    if d.decision == "connect" {
        let mut w = fake.world();
        let account = d.account.trim();
        let org = if account.is_empty() {
            w.id("OR")
        } else {
            account.to_owned()
        };
        let code = format!("fake_code_{}", uuid::Uuid::new_v4().simple());
        w.codes.insert(code.clone(), (org, d.redirect_uri.clone()));
        url.query_pairs_mut()
            .append_pair("code", &code)
            .append_pair("state", &d.state);
    } else {
        url.query_pairs_mut()
            .append_pair("error", "access_denied")
            .append_pair("error_description", "The user cancelled the authorisation")
            .append_pair("state", &d.state);
    }
    Redirect::to(url.as_str()).into_response()
}

#[derive(Deserialize)]
struct TokenForm {
    grant_type: String,
    code: String,
    redirect_uri: String,
    client_id: String,
    client_secret: String,
}

async fn access_token(State(fake): State<Arc<Fake>>, Form(f): Form<TokenForm>) -> Response {
    if f.client_id != CLIENT_ID || f.client_secret != CLIENT_SECRET {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid_client"})),
        )
            .into_response();
    }
    if f.grant_type != "authorization_code" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "unsupported_grant_type"})),
        )
            .into_response();
    }
    let mut w = fake.world();
    match w.codes.remove(&f.code) {
        Some((org, redirect)) if redirect == f.redirect_uri => {
            // Reconnecting an account issues a new token and disables any
            // existing one (GoCardless's OAuth reference).
            w.tokens.retain(|_, o| *o != org);
            let token = format!("fake_token_{}", uuid::Uuid::new_v4().simple());
            w.tokens.insert(token.clone(), org.clone());
            Json(json!({
                "access_token": token,
                "scope": "read_write",
                "token_type": "bearer",
                "email": "accounts@fake-gocardless.invalid",
                "organisation_id": org
            }))
            .into_response()
        }
        _ => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid_grant"})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
struct RevokeForm {
    token: String,
    client_id: String,
    client_secret: String,
}

async fn revoke(State(fake): State<Arc<Fake>>, Form(f): Form<RevokeForm>) -> Response {
    if f.client_id != CLIENT_ID || f.client_secret != CLIENT_SECRET {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid_client"})),
        )
            .into_response();
    }
    // Stricter than GoCardless documents (200 either way): an unknown
    // token is refused, so a disconnect is proven to cope with one.
    match fake.world().tokens.remove(&f.token) {
        Some(_) => StatusCode::OK.into_response(),
        None => (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "invalid_token"})),
        )
            .into_response(),
    }
}

/// A create under an idempotency key: a repeat is GoCardless's conflict,
/// naming the first resource.
#[allow(clippy::result_large_err)]
fn idempotent(w: &mut World, org: &str, headers: &HeaderMap) -> Result<Option<String>, Response> {
    let Some(key) = headers.get("Idempotency-Key").and_then(|v| v.to_str().ok()) else {
        return Ok(None);
    };
    if let Some(id) = w.idempotency.get(&(org.to_owned(), key.to_owned())) {
        return Err(error(
            StatusCode::CONFLICT,
            "invalid_state",
            "idempotent_creation_conflict",
            "A resource has already been created with this idempotency key",
            json!({ "conflicting_resource_id": id }),
        ));
    }
    Ok(Some(key.to_owned()))
}

async fn create_billing_request(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let req = body.get("billing_requests").cloned().unwrap_or(Value::Null);
    let instant = req.get("payment_request").is_some();
    let currency = if instant {
        "/payment_request/currency"
    } else {
        "/mandate_request/currency"
    };
    if req.pointer(currency).and_then(Value::as_str) != Some("GBP") {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "invalid_currency",
            "the request's currency must be GBP here",
            json!({}),
        );
    }
    let mut w = fake.world();
    let key = match idempotent(&mut w, &org, &headers) {
        Ok(key) => key,
        Err(r) => return r,
    };
    let id = w.id("BRQ");
    let mut br = json!({
        "id": id,
        "created_at": now_iso(),
        "status": "pending",
        "metadata": req.get("metadata").cloned().unwrap_or(json!({})),
        "links": {}
    });
    if instant {
        br["payment_request"] = json!({
            "amount": req.pointer("/payment_request/amount").cloned().unwrap_or(json!(0)),
            "currency": "GBP",
            "description": req.pointer("/payment_request/description").cloned()
                .unwrap_or(Value::Null),
            "scheme": "faster_payments",
            "metadata": req.pointer("/payment_request/metadata").cloned().unwrap_or(json!({}))
        });
    } else {
        br["mandate_request"] = json!({
            "scheme": req.pointer("/mandate_request/scheme").cloned().unwrap_or(json!("bacs")),
            "currency": "GBP",
            "metadata": req.pointer("/mandate_request/metadata").cloned().unwrap_or(json!({}))
        });
    }
    w.resources.insert(
        id.clone(),
        Resource {
            org: org.clone(),
            kind: "billing_requests",
            body: br.clone(),
        },
    );
    if let Some(key) = key {
        w.idempotency.insert((org, key), id);
    }
    (StatusCode::CREATED, Json(json!({ "billing_requests": br }))).into_response()
}

/// `GET <resources>/{id}`: the caller's own only.
async fn get_resource(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    match fake.world().resources.get(&id) {
        Some(r) if r.org == org => {
            let mut out = serde_json::Map::new();
            out.insert(r.kind.to_owned(), r.body.clone());
            Json(Value::Object(out)).into_response()
        }
        _ => not_found(),
    }
}

async fn cancel_billing_request(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let event = {
        let mut w = fake.world();
        let Some(r) = w.resources.get_mut(&id).filter(|r| r.org == org) else {
            return not_found();
        };
        if r.body["status"] == "fulfilled" {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_state",
                "billing_request_fulfilled",
                "A fulfilled billing request can't be cancelled",
                json!({}),
            );
        }
        r.body["status"] = json!("cancelled");
        Fake::event(
            &mut w,
            &org,
            "billing_requests",
            "cancelled",
            json!({ "billing_request": id }),
            "billing_request_cancelled",
            "This billing request has been cancelled.",
        )
    };
    let body = fake.resource(&id).unwrap_or_default();
    fake.deliver(vec![event]).await;
    Json(json!({ "billing_requests": body })).into_response()
}

async fn create_flow(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let req = body
        .get("billing_request_flows")
        .cloned()
        .unwrap_or(Value::Null);
    let Some(br) = req
        .pointer("/links/billing_request")
        .and_then(Value::as_str)
    else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "missing_billing_request",
            "links.billing_request is required",
            json!({}),
        );
    };
    let mut w = fake.world();
    if w.resources.get(br).is_none_or(|r| r.org != org) {
        return not_found();
    }
    let id = w.id("BRF");
    let expires = (time::OffsetDateTime::now_utc() + time::Duration::days(7))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default();
    let flow = json!({
        "id": id,
        "created_at": now_iso(),
        "authorisation_url": format!("{}/flow/{id}", fake.public_base),
        "expires_at": expires,
        "prefilled_customer": req.get("prefilled_customer").cloned().unwrap_or(json!({})),
        "redirect_uri": req.get("redirect_uri").cloned().unwrap_or(Value::Null),
        "links": { "billing_request": br }
    });
    w.resources.insert(
        id,
        Resource {
            org,
            kind: "billing_request_flows",
            body: flow.clone(),
        },
    );
    (
        StatusCode::CREATED,
        Json(json!({ "billing_request_flows": flow })),
    )
        .into_response()
}

async fn flow_page(State(fake): State<Arc<Fake>>, Path(id): Path<String>) -> Response {
    let Some(flow) = fake.resource(&id) else {
        return (
            StatusCode::NOT_FOUND,
            page("Link not found", "<p>This link isn’t valid.</p>"),
        )
            .into_response();
    };
    let br = flow
        .pointer("/links/billing_request")
        .and_then(Value::as_str)
        .unwrap_or("");
    let status = fake
        .resource(br)
        .and_then(|b| b.get("status").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    if status != "pending" {
        return page(
            "Already done",
            &format!("<p>This sign-up is {}.</p>", escape(&status)),
        )
        .into_response();
    }
    let pre = |k: &str| {
        escape(
            flow.pointer(&format!("/prefilled_customer/{k}"))
                .and_then(Value::as_str)
                .unwrap_or(""),
        )
    };
    if let Some(amount) = fake
        .resource(br)
        .and_then(|b| b.pointer("/payment_request/amount").and_then(Value::as_i64))
    {
        return page(
            "Pay by bank",
            &format!(
                "<form method=\"post\" action=\"{id}/complete\">\
                 <p>Pay <strong data-amount>{amount}</strong> pence from your bank.</p>\
                 <label>First name <input name=\"given_name\" value=\"{}\"></label>\
                 <label>Last name <input name=\"family_name\" value=\"{}\"></label>\
                 <p>(Not really: this is the fake.)</p>\
                 <button>Pay</button></form>",
                pre("given_name"),
                pre("family_name")
            ),
        )
        .into_response();
    }
    page(
        "Set up a Direct Debit",
        &format!(
            "<form method=\"post\" action=\"{id}/complete\">\
             <label>First name <input name=\"given_name\" value=\"{}\"></label>\
             <label>Last name <input name=\"family_name\" value=\"{}\"></label>\
             <label>Sort code <input name=\"sort_code\" value=\"200000\"></label>\
             <label>Account number <input name=\"account_number\" value=\"55779911\"></label>\
             <p>The Direct Debit Guarantee applies. (Not really: this is the fake.)</p>\
             <button>Set up Direct Debit</button></form>",
            pre("given_name"),
            pre("family_name")
        ),
    )
    .into_response()
}

#[derive(Deserialize)]
struct Completed {
    #[serde(default)]
    given_name: String,
    #[serde(default)]
    family_name: String,
}

/// The donor completes the flow: a customer, a mandate and the billing
/// request fulfilled, with their events.
async fn complete_flow(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Form(c): Form<Completed>,
) -> Response {
    let (events, mandate) = {
        let mut w = fake.world();
        let Some(flow) = w.resources.get(&id).cloned() else {
            return (StatusCode::NOT_FOUND, "no such flow").into_response();
        };
        let org = flow.org.clone();
        let br = flow.body["links"]["billing_request"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        if w.resources.get(&br).map(|r| r.body["status"].clone()) != Some(json!("pending")) {
            return page("Already done", "<p>This sign-up is already complete.</p>")
                .into_response();
        }
        if let Some(request) = w
            .resources
            .get(&br)
            .and_then(|r| r.body.get("payment_request").cloned())
        {
            // Instant Bank Pay: paid at once; the payment carries no
            // metadata, the request's `fulfilled` event names it.
            let customer = w.id("CU");
            let (payment, created) = Fake::new_payment(
                &mut w,
                &org,
                request["amount"].as_i64().unwrap_or(0),
                today_plus(0),
                "confirmed",
                request["description"].clone(),
                json!({}),
                json!({ "customer": customer }),
            );
            if let Some(r) = w.resources.get_mut(&br) {
                r.body["status"] = json!("fulfilled");
                r.body["links"] =
                    json!({ "customer": customer, "payment_request_payment": payment });
            }
            let fulfilled = Fake::event(
                &mut w,
                &org,
                "billing_requests",
                "fulfilled",
                json!({ "billing_request": br, "customer": customer,
                        "payment_request_payment": payment }),
                "billing_request_fulfilled",
                "This billing request has been fulfilled, and the resources have been created.",
            );
            (vec![created, fulfilled], payment)
        } else {
            let customer = w.id("CU");
            let mandate = w.id("MD");
            w.resources.insert(
                customer.clone(),
                Resource {
                    org: org.clone(),
                    kind: "customers",
                    body: json!({
                        "id": customer, "given_name": c.given_name, "family_name": c.family_name
                    }),
                },
            );
            let metadata = w
                .resources
                .get(&br)
                .and_then(|r| r.body.pointer("/mandate_request/metadata").cloned())
                .unwrap_or(json!({}));
            w.resources.insert(
                mandate.clone(),
                Resource {
                    org: org.clone(),
                    kind: "mandates",
                    body: json!({
                        "id": mandate, "status": "pending_submission", "scheme": "bacs",
                        "next_possible_charge_date": today_plus(5),
                        // GoCardless copies the mandate request's metadata.
                        "metadata": metadata,
                        "links": { "customer": customer }
                    }),
                },
            );
            if let Some(r) = w.resources.get_mut(&br) {
                r.body["status"] = json!("fulfilled");
                r.body["links"] =
                    json!({ "customer": customer, "mandate_request_mandate": mandate });
            }
            let fulfilled = Fake::event(
                &mut w,
                &org,
                "billing_requests",
                "fulfilled",
                json!({ "billing_request": br, "customer": customer,
                    "mandate_request_mandate": mandate }),
                "billing_request_fulfilled",
                "This billing request has been fulfilled, and the resources have been created.",
            );
            let created = Fake::event(
                &mut w,
                &org,
                "mandates",
                "created",
                json!({ "mandate": mandate }),
                "mandate_created",
                "Mandate created via the API.",
            );
            (vec![fulfilled, created], mandate)
        }
    };
    let delivered = fake.deliver(events).await;
    if mandate.starts_with("PM") {
        return page(
            "Paid",
            &format!(
                "<p>Thank you: paid.</p><p>Payment <code data-payment>{mandate}</code>{}</p>",
                if delivered {
                    ""
                } else {
                    " (the webhook didn’t land)"
                }
            ),
        )
        .into_response();
    }
    page(
        "Direct Debit set up",
        &format!(
            "<p>Thank you: your Direct Debit is set up.</p>\
             <p>Mandate <code data-mandate>{mandate}</code>{}</p>",
            if delivered {
                ""
            } else {
                " (the webhook didn’t land)"
            }
        ),
    )
    .into_response()
}

async fn create_subscription(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let s = body.get("subscriptions").cloned().unwrap_or(Value::Null);
    let mandate = s
        .pointer("/links/mandate")
        .and_then(Value::as_str)
        .unwrap_or("");
    let interval = s.get("interval_unit").and_then(Value::as_str).unwrap_or("");
    let amount = s.get("amount").and_then(Value::as_i64).unwrap_or(0);
    let day = s.get("day_of_month").and_then(Value::as_i64).unwrap_or(0);
    let mut w = fake.world();
    let key = match idempotent(&mut w, &org, &headers) {
        Ok(key) => key,
        Err(r) => return r,
    };
    match w.resources.get(mandate) {
        Some(r) if r.org == org && r.kind == "mandates" => {
            let status = r.body["status"].as_str().unwrap_or("");
            if matches!(status, "cancelled" | "failed" | "expired") {
                return error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid_state",
                    "mandate_is_inactive",
                    "The mandate is not active",
                    json!({}),
                );
            }
        }
        _ => return not_found(),
    }
    if amount <= 0
        || !matches!(interval, "weekly" | "monthly" | "yearly")
        || !(1..=28).contains(&day)
        || s.get("currency").and_then(Value::as_str) != Some("GBP")
        || (interval == "yearly") != s.get("month").is_some()
    {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "invalid_subscription",
            "amount, currency, interval_unit, day_of_month or month is invalid",
            json!({}),
        );
    }
    let id = w.id("SB");
    let sub = json!({
        "id": id,
        "created_at": now_iso(),
        "amount": amount,
        "currency": "GBP",
        "status": "active",
        "interval_unit": interval,
        "interval": 1,
        "day_of_month": day,
        "month": s.get("month").cloned().unwrap_or(Value::Null),
        "name": s.get("name").cloned().unwrap_or(Value::Null),
        "metadata": s.get("metadata").cloned().unwrap_or(json!({})),
        "links": { "mandate": mandate }
    });
    w.resources.insert(
        id.clone(),
        Resource {
            org: org.clone(),
            kind: "subscriptions",
            body: sub.clone(),
        },
    );
    if let Some(key) = key {
        w.idempotency.insert((org, key), id);
    }
    (StatusCode::CREATED, Json(json!({ "subscriptions": sub }))).into_response()
}

/// Cancel a mandate and its live subscriptions, with their events.
fn end_mandate(
    w: &mut World,
    org: &str,
    mandate: &str,
    status: &str,
    action: &str,
    cause: &str,
    description: &str,
) -> Vec<Value> {
    let mut events = Vec::new();
    if let Some(r) = w.resources.get_mut(mandate) {
        r.body["status"] = json!(status);
    }
    events.push(Fake::event(
        w,
        org,
        "mandates",
        action,
        json!({ "mandate": mandate }),
        cause,
        description,
    ));
    let subs: Vec<String> = w
        .resources
        .iter()
        .filter(|(_, r)| {
            r.kind == "subscriptions"
                && r.body["links"]["mandate"] == mandate
                && r.body["status"] == "active"
        })
        .map(|(id, _)| id.clone())
        .collect();
    for sb in subs {
        if let Some(r) = w.resources.get_mut(&sb) {
            r.body["status"] = json!("cancelled");
        }
        events.push(Fake::event(
            w,
            org,
            "subscriptions",
            "cancelled",
            json!({ "subscription": sb }),
            "mandate_cancelled",
            "The subscription was cancelled because its mandate was cancelled.",
        ));
    }
    events
}

async fn cancel_mandate(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let events = {
        let mut w = fake.world();
        match w.resources.get(&id) {
            Some(r) if r.org == org && r.kind == "mandates" => {
                if r.body["status"] == "cancelled" {
                    return error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_state",
                        "mandate_already_cancelled",
                        "The mandate is already cancelled",
                        json!({}),
                    );
                }
            }
            _ => return not_found(),
        }
        let mut events = end_mandate(
            &mut w,
            &org,
            &id,
            "cancelled",
            "cancelled",
            "mandate_cancelled",
            "The mandate was cancelled at your request.",
        );
        for e in &mut events {
            e["details"]["origin"] = json!("api");
        }
        events
    };
    let body = fake.resource(&id).unwrap_or_default();
    fake.deliver(events).await;
    Json(json!({ "mandates": body })).into_response()
}

fn simulated(delivered: bool, extra: Value) -> Response {
    let mut out = json!({ "delivered": delivered });
    if let (Some(o), Some(e)) = (out.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    Json(out).into_response()
}

async fn simulate_mandate(
    State(fake): State<Arc<Fake>>,
    Path((id, action)): Path<(String, String)>,
) -> Response {
    let events = {
        let mut w = fake.world();
        let Some(org) = w
            .resources
            .get(&id)
            .filter(|r| r.kind == "mandates")
            .map(|r| r.org.clone())
        else {
            return not_found();
        };
        match action.as_str() {
            "activate" => {
                if let Some(r) = w.resources.get_mut(&id) {
                    r.body["status"] = json!("active");
                }
                vec![Fake::event(
                    &mut w,
                    &org,
                    "mandates",
                    "active",
                    json!({ "mandate": id }),
                    "mandate_activated",
                    "The time window after submission for the banks to refuse a mandate has ended without any errors being received, so this mandate is now active.",
                )]
            }
            "fail" => end_mandate(
                &mut w,
                &org,
                &id,
                "failed",
                "failed",
                "invalid_bank_details",
                "The bank account details were invalid.",
            ),
            "cancel" => end_mandate(
                &mut w,
                &org,
                &id,
                "cancelled",
                "cancelled",
                "bank_account_closed",
                "The customer's bank account was closed.",
            ),
            "expire" => end_mandate(
                &mut w,
                &org,
                &id,
                "expired",
                "expired",
                "mandate_expired",
                "The mandate expired because no collections were made against it for longer than the scheme's dormancy period.",
            ),
            _ => return (StatusCode::NOT_FOUND, "unknown action").into_response(),
        }
    };
    let delivered = fake.deliver(events).await;
    simulated(delivered, json!({ "mandate": id }))
}

#[derive(Deserialize)]
struct NextPayment {
    /// YYYY-MM-DD; default a few days out (a month later for each payment
    /// the subscription already has).
    charge_date: Option<String>,
}

/// The subscription's next payment: its amount, charged a few days out
/// (or on `?charge_date=`).
async fn simulate_payment(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Query(q): Query<NextPayment>,
) -> Response {
    let (event, payment) = {
        let mut w = fake.world();
        let Some(sub) = w
            .resources
            .get(&id)
            .filter(|r| r.kind == "subscriptions")
            .cloned()
        else {
            return not_found();
        };
        if sub.body["status"] != "active" {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_state",
                "subscription_not_active",
                "The subscription is not active",
                json!({}),
            );
        }
        let payment = w.id("PM");
        let charged = w
            .resources
            .values()
            .filter(|r| r.kind == "payments" && r.body["links"]["subscription"] == id.as_str())
            .count() as i64;
        let body = json!({
            "id": payment,
            "created_at": now_iso(),
            "amount": sub.body["amount"],
            "currency": "GBP",
            "charge_date": q.charge_date.clone().unwrap_or_else(|| today_plus(3 + 31 * charged)),
            "status": "pending_submission",
            "description": sub.body["name"],
            "metadata": {},
            "links": { "mandate": sub.body["links"]["mandate"], "subscription": id }
        });
        w.resources.insert(
            payment.clone(),
            Resource {
                org: sub.org.clone(),
                kind: "payments",
                body,
            },
        );
        let event = Fake::event(
            &mut w,
            &sub.org,
            "payments",
            "created",
            json!({ "payment": payment, "subscription": id }),
            "payment_created",
            "Payment created by a subscription.",
        );
        (event, payment)
    };
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "payment": payment }))
}

#[derive(Deserialize)]
struct Retry {
    /// `retry`: the new charge date (YYYY-MM-DD); default a week out.
    charge_date: Option<String>,
}

async fn simulate_payment_action(
    State(fake): State<Arc<Fake>>,
    Path((id, action)): Path<(String, String)>,
    Query(retry): Query<Retry>,
) -> Response {
    let (status, event_action, cause, description) = match action.as_str() {
        "retry" => (
            "submitted",
            "resubmission_requested",
            "payment_retried",
            "The payment was retried.",
        ),
        "submit" => (
            "submitted",
            "submitted",
            "payment_submitted",
            "Payment submitted to the banks.",
        ),
        "confirm" => (
            "confirmed",
            "confirmed",
            "payment_confirmed",
            "Enough time has passed since the payment was submitted for the banks to return an error, so this payment is now confirmed.",
        ),
        "fail" => (
            "failed",
            "failed",
            "insufficient_funds",
            "The customer's account had insufficient funds to make this payment.",
        ),
        "charge_back" => (
            "charged_back",
            "charged_back",
            "authorisation_disputed",
            "The customer has disputed that the amount taken differs from the amount they were notified of.",
        ),
        "cancel_chargeback" => (
            "paid_out",
            "chargeback_cancelled",
            "chargeback_cancelled",
            "The customer's bank has cancelled the chargeback request for this payment.",
        ),
        _ => return (StatusCode::NOT_FOUND, "unknown action").into_response(),
    };
    let Some(payment) = fake
        .set_status(&id, status)
        .filter(|r| r.kind == "payments")
    else {
        return not_found();
    };
    if action == "retry"
        && let Some(r) = fake.world().resources.get_mut(&id)
    {
        r.body["charge_date"] = json!(retry.charge_date.unwrap_or_else(|| today_plus(7)));
    }
    let event = {
        let mut w = fake.world();
        Fake::event(
            &mut w,
            &payment.org,
            "payments",
            event_action,
            json!({ "payment": id }),
            cause,
            description,
        )
    };
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "payment": id, "status": status }))
}

async fn webhooks(State(fake): State<Arc<Fake>>) -> Response {
    let out: Vec<Value> = fake
        .deliveries()
        .into_iter()
        .map(|(body, landed)| json!({ "body": body, "delivered": landed }))
        .collect();
    Json(out).into_response()
}

/// `POST payments`: a one-off on one of the caller's mandates (not
/// ended), `pending_submission`, charged on `charge_date` or a few days
/// out; its `created` event is delivered.
async fn create_payment(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let req = body.get("payments").cloned().unwrap_or(Value::Null);
    if req.get("currency").and_then(Value::as_str) != Some("GBP") {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "invalid_currency",
            "currency must be GBP here",
            json!({}),
        );
    }
    let amount = req.get("amount").and_then(Value::as_i64).unwrap_or(0);
    if amount <= 0 {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "validation_failed",
            "invalid_amount",
            "amount must be a positive integer",
            json!({}),
        );
    }
    let mandate = req
        .pointer("/links/mandate")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let (body, event) = {
        let mut w = fake.world();
        match w.resources.get(&mandate) {
            Some(r) if r.org == org && r.kind == "mandates" => {
                if matches!(
                    r.body["status"].as_str(),
                    Some("cancelled" | "failed" | "expired" | "blocked")
                ) {
                    return error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        "invalid_state",
                        "mandate_is_inactive",
                        "The mandate is not active",
                        json!({}),
                    );
                }
            }
            _ => return not_found(),
        }
        let key = match idempotent(&mut w, &org, &headers) {
            Ok(key) => key,
            Err(r) => return r,
        };
        let (payment, event) = Fake::new_payment(
            &mut w,
            &org,
            amount,
            req.get("charge_date")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| today_plus(3)),
            "pending_submission",
            req.get("description").cloned().unwrap_or(Value::Null),
            req.get("metadata").cloned().unwrap_or(json!({})),
            json!({ "mandate": mandate }),
        );
        if let Some(key) = key {
            w.idempotency.insert((org, key), payment.clone());
        }
        (w.resources[&payment].body.clone(), event)
    };
    fake.deliver(vec![event]).await;
    (StatusCode::CREATED, Json(json!({ "payments": body }))).into_response()
}

#[derive(Deserialize)]
struct EventsQuery {
    #[serde(rename = "created_at[gte]")]
    created_at_gte: Option<String>,
    limit: Option<usize>,
    after: Option<String>,
}

fn instant(s: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
}

/// `GET events`: the caller's events, newest first, from `after` (the
/// last id of the previous page), at most `limit` (≤ 500).
async fn list_events(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Response {
    let org = match caller(&fake, &headers) {
        Ok(org) => org,
        Err(r) => return r,
    };
    let since = q.created_at_gte.as_deref().and_then(instant);
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let w = fake.world();
    let mine: Vec<&Value> = w
        .events
        .iter()
        .rev()
        .filter(|(o, _)| *o == org)
        .map(|(_, e)| e)
        .filter(|e| {
            since.is_none_or(|since| {
                e["created_at"]
                    .as_str()
                    .and_then(instant)
                    .is_some_and(|at| at >= since)
            })
        })
        .collect();
    let start = match &q.after {
        Some(after) => mine
            .iter()
            .position(|e| e["id"] == after.as_str())
            .map_or(mine.len(), |i| i + 1),
        None => 0,
    };
    let page: Vec<Value> = mine[start..]
        .iter()
        .take(limit)
        .map(|e| (*e).clone())
        .collect();
    let more = start + page.len() < mine.len();
    let after = more
        .then(|| {
            page.last()
                .and_then(|e| e["id"].as_str())
                .map(str::to_owned)
        })
        .flatten();
    Json(json!({
        "events": page,
        "meta": { "cursors": { "before": Value::Null, "after": after }, "limit": limit }
    }))
    .into_response()
}

#[derive(Deserialize)]
struct Amount {
    amount: Option<i64>,
    /// A subscription to name in the payment's links.
    subscription: Option<String>,
}

/// A one-off on mandate `id` with no metadata: as if taken in
/// GoCardless's dashboard.
async fn simulate_mandate_payment(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Query(q): Query<Amount>,
) -> Response {
    let (event, payment) = {
        let mut w = fake.world();
        let Some(org) = w
            .resources
            .get(&id)
            .filter(|r| r.kind == "mandates")
            .map(|r| r.org.clone())
        else {
            return not_found();
        };
        let (payment, event) = Fake::new_payment(
            &mut w,
            &org,
            q.amount.unwrap_or(2500),
            today_plus(3),
            "pending_submission",
            json!("One-off"),
            json!({}),
            match &q.subscription {
                Some(sb) => json!({ "mandate": id, "subscription": sb }),
                None => json!({ "mandate": id }),
            },
        );
        (event, payment)
    };
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "payment": payment }))
}

/// A payment from a stranger to account `org`: a customer and an active
/// mandate we never asked for, and a payment on it.
async fn simulate_stranger_payment(
    State(fake): State<Arc<Fake>>,
    Path(org): Path<String>,
    Query(q): Query<Amount>,
) -> Response {
    let (event, payment, mandate) = {
        let mut w = fake.world();
        if !w.tokens.values().any(|o| *o == org) {
            return not_found();
        }
        let customer = w.id("CU");
        let mandate = w.id("MD");
        w.resources.insert(
            mandate.clone(),
            Resource {
                org: org.clone(),
                kind: "mandates",
                body: json!({
                    "id": mandate, "status": "active", "scheme": "bacs", "metadata": {},
                    "links": { "customer": customer }
                }),
            },
        );
        let (payment, event) = Fake::new_payment(
            &mut w,
            &org,
            q.amount.unwrap_or(1500),
            today_plus(3),
            "pending_submission",
            json!("From a stranger"),
            json!({}),
            json!({ "mandate": mandate }),
        );
        (event, payment, mandate)
    };
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "payment": payment, "mandate": mandate }))
}
