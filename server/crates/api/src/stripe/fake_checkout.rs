//! The fake's Checkout Sessions (`super`'s child module `checkout`; plan
//! `factory/plans/stripe.sv`, step S4). Made on a connected account
//! (`Stripe-Account`), kept in memory in Stripe's shape.
//!
//! API (behind the fake's gate: the key and the pinned version):
//! - `POST v1/checkout/sessions` (form): a session for one card payment
//!   in pounds. As Stripe: `Stripe-Account` must be an account of ours
//!   that takes payments, `mode=payment`, one line with a `unit_amount`
//!   of at least 30p, a `success_url`, an `expires_at` 30 minutes to 24
//!   hours away, and a `customer_email` that is one (`400 email_invalid`);
//! - `GET v1/checkout/sessions/{id}`: the session as it is now (`url` is
//!   null once it is no longer open).
//!
//! The page a browser visits (what Stripe hosts), at the session's `url`:
//! - `GET checkout/{id}`: Stripe's payment page, as two buttons. "Pay"
//!   completes the session (`payment_status: paid`, a `pi_…` succeeded),
//!   delivers `checkout.session.completed` and sends the browser to
//!   `success_url`; "Back" changes nothing and goes to `cancel_url`. A
//!   session that isn't open any more says so.
//!
//! Simulator, `POST`, answering JSON once the webhook has been delivered:
//! - `simulate/checkout/{id}/expire`: the session runs out unpaid:
//!   `checkout.session.expired`.
//!
//! What follows a payment is S3's (`fake_payments.rs`: PaymentIntents and
//! their charges, refunds, disputes, `GET v1/events`). "Pay" asks it for
//! the payment ([`Fake::pay`]) and emits only the session's own event.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Form, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, extract::Request};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Fake, account_invalid, invalid, simulated};

pub const SESSION_COMPLETED: &str = "checkout.session.completed";
pub const SESSION_EXPIRED: &str = "checkout.session.expired";

/// Stripe's shortest and longest life for a session, in seconds.
const MIN_LIFE_SECS: i64 = 30 * 60;
const MAX_LIFE_SECS: i64 = 24 * 60 * 60;
/// The least Stripe charges a card in pounds: 30p.
const MIN_AMOUNT: i64 = 30;

/// Every session made, by id, in Stripe's shape.
#[derive(Default)]
pub struct Checkout {
    sessions: HashMap<String, Value>,
    /// Session ids, oldest first.
    order: Vec<String>,
}

impl Fake {
    fn checkout(&self) -> std::sync::MutexGuard<'_, Checkout> {
        self.checkout.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A Checkout Session as Stripe would answer it.
    pub fn checkout_session(&self, id: &str) -> Option<Value> {
        self.checkout().sessions.get(id).cloned()
    }

    /// Every Checkout Session made, oldest first.
    pub fn checkout_sessions(&self) -> Vec<Value> {
        let c = self.checkout();
        c.order
            .iter()
            .filter_map(|id| c.sessions.get(id).cloned())
            .collect()
    }

    /// The donor pays on Stripe's page: a PaymentIntent that succeeded
    /// ([`Fake::pay`]), the session complete and naming it, and the
    /// session's `checkout.session.completed` event, not yet delivered.
    /// `None`: no such session, or one no longer open.
    pub fn pay_checkout(&self, id: &str) -> Option<Value> {
        let open = self
            .checkout_session(id)
            .filter(|s| s["status"] == "open")?;
        let account = open["account"].as_str().unwrap_or_default().to_owned();
        let intent = self.pay(
            &account,
            open["amount_total"].as_i64().unwrap_or(0),
            open["currency"].as_str().unwrap_or("gbp"),
            open["client_reference_id"].as_str(),
        );
        let session = {
            let mut c = self.checkout();
            let s = c.sessions.get_mut(id)?;
            // Paid meanwhile by another press: that one's event stands.
            if s["status"] != "open" {
                return None;
            }
            s["status"] = json!("complete");
            s["payment_status"] = json!("paid");
            s["payment_intent"] = intent["id"].clone();
            s["url"] = Value::Null;
            s.clone()
        };
        Some(self.event(&account, SESSION_COMPLETED, public(&session)))
    }

    /// The session runs out unpaid: its `checkout.session.expired` event,
    /// not yet delivered. `None`: no such session, or one no longer open.
    pub fn expire_checkout(&self, id: &str) -> Option<Value> {
        let (account, session) = {
            let mut c = self.checkout();
            let s = c.sessions.get_mut(id)?;
            if s["status"] != "open" {
                return None;
            }
            s["status"] = json!("expired");
            s["url"] = Value::Null;
            (
                s["account"].as_str().unwrap_or_default().to_owned(),
                s.clone(),
            )
        };
        Some(self.event(&account, SESSION_EXPIRED, public(&session)))
    }
}

/// The session without what only the fake keeps on it.
fn public(session: &Value) -> Value {
    let mut out = session.clone();
    if let Some(o) = out.as_object_mut() {
        o.remove("account");
    }
    out
}

/// The API routes: merged inside the fake's gate.
pub(super) fn api() -> Router<Arc<Fake>> {
    Router::new()
        .route("/v1/checkout/sessions", post(create))
        .route("/v1/checkout/sessions/{id}", get(read))
}

/// The hosted page and the simulator: outside the gate (a browser has no
/// key).
pub(super) fn pages() -> Router<Arc<Fake>> {
    Router::new()
        .route("/checkout/{id}", get(page))
        .route("/checkout/{id}/decide", post(decide))
        .route("/simulate/checkout/{id}/expire", post(simulate_expire))
}

fn connected_account(headers: &HeaderMap) -> Option<String> {
    headers
        .get("Stripe-Account")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

/// `metadata[…]`-style keys under `prefix` as an object.
fn nested(form: &HashMap<String, String>, prefix: &str) -> Value {
    Value::Object(
        form.iter()
            .filter_map(|(k, v)| {
                let name = k
                    .strip_prefix(prefix)?
                    .strip_prefix('[')?
                    .strip_suffix(']')?;
                Some((name.to_owned(), json!(v)))
            })
            .collect(),
    )
}

/// `POST v1/checkout/sessions`.
async fn create(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let field = |k: &str| form.get(k).map(String::as_str);
    let Some(account) = connected_account(&headers) else {
        return invalid(
            "parameter_missing",
            "A donation is a direct charge: Stripe-Account is required",
        );
    };
    {
        let w = fake.world();
        if !Fake::reachable(&w, &account) {
            return account_invalid();
        }
        if w.accounts[&account]["charges_enabled"] != json!(true) {
            return invalid(
                "account_capability_not_active",
                "The account can't take card payments yet",
            );
        }
    }
    if field("mode") != Some("payment") {
        return invalid("parameter_invalid", "mode: payment");
    }
    let amount =
        field("line_items[0][price_data][unit_amount]").and_then(|a| a.parse::<i64>().ok());
    let Some(amount) = amount.filter(|a| *a >= MIN_AMOUNT) else {
        return invalid("amount_too_small", "line_items[0][price_data][unit_amount]");
    };
    let currency = field("line_items[0][price_data][currency]").unwrap_or_default();
    if currency.is_empty() || field("line_items[0][quantity]") != Some("1") {
        return invalid("parameter_missing", "line_items[0]");
    }
    let (Some(success_url), cancel_url) = (field("success_url"), field("cancel_url")) else {
        return invalid("parameter_missing", "success_url");
    };
    if let Some(email) = field("customer_email")
        && !email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !local.contains("..")
                && domain.contains('.')
                && !email.contains(char::is_whitespace)
        })
    {
        return invalid("email_invalid", "Invalid email address");
    }
    let now = contracts::now_ms() / 1000;
    let expires_at = match field("expires_at") {
        None => now + MAX_LIFE_SECS,
        Some(at) => match at.parse::<i64>() {
            Ok(at) if at >= now + MIN_LIFE_SECS && at <= now + MAX_LIFE_SECS => at,
            _ => {
                return invalid(
                    "parameter_invalid",
                    "expires_at: 30 minutes to 24 hours from now",
                );
            }
        },
    };
    let id = fake.world().id("cs_test_");
    let session = json!({
        "id": id,
        "object": "checkout.session",
        "account": account,
        "mode": "payment",
        "submit_type": field("submit_type"),
        "status": "open",
        "payment_status": "unpaid",
        "payment_intent": null,
        "amount_total": amount,
        "currency": currency.to_lowercase(),
        "customer_email": field("customer_email"),
        "client_reference_id": field("client_reference_id"),
        "metadata": nested(&form, "metadata"),
        "description": field("line_items[0][price_data][product_data][name]"),
        "success_url": success_url,
        "cancel_url": cancel_url,
        "created": now,
        "expires_at": expires_at,
        "livemode": false,
        "url": format!("{}/checkout/{id}", fake.public_base)
    });
    let mut c = fake.checkout();
    c.order.push(id.clone());
    c.sessions.insert(id, session.clone());
    Json(public(&session)).into_response()
}

/// The session `id` if it is `account`'s.
fn owned(fake: &Fake, headers: &HeaderMap, id: &str) -> Option<Value> {
    let account = connected_account(headers)?;
    fake.checkout_session(id)
        .filter(|s| s["account"] == json!(account))
}

/// `GET v1/checkout/sessions/{id}`.
async fn read(State(fake): State<Arc<Fake>>, Path(id): Path<String>, req: Request) -> Response {
    match owned(&fake, req.headers(), &id) {
        Some(s) => Json(public(&s)).into_response(),
        None => super::error(
            StatusCode::NOT_FOUND,
            "invalid_request_error",
            "resource_missing",
            "No such checkout.session",
        ),
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `GET checkout/{id}`: Stripe's hosted payment page.
async fn page(State(fake): State<Arc<Fake>>, Path(id): Path<String>) -> Response {
    let Some(s) = fake.checkout_session(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let head = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
         <title>Fake Stripe: pay</title></head><body><h1>Fake Stripe</h1>";
    if s["status"] != "open" {
        return Html(format!(
            "{head}<p data-fake-stripe=\"closed\">This payment page is no longer open \
             (<code>{}</code>).</p></body></html>",
            escape(s["status"].as_str().unwrap_or_default())
        ))
        .into_response();
    }
    let pence = s["amount_total"].as_i64().unwrap_or(0);
    Html(format!(
        "{head}<p>{}</p><p data-fake-stripe=\"amount\">£{}.{:02}</p>\
         <p>This is keep-together’s stand-in for Stripe’s payment page: no card is \
         charged.</p>\
         <form method=\"post\" action=\"{}/checkout/{id}/decide\">\
         <button name=\"decision\" value=\"pay\">Pay</button> \
         <button name=\"decision\" value=\"back\">Back</button>\
         </form></body></html>",
        escape(s["description"].as_str().unwrap_or("Donation")),
        pence / 100,
        pence % 100,
        fake.public_base
    ))
    .into_response()
}

#[derive(Deserialize)]
struct Decide {
    decision: String,
}

/// `POST checkout/{id}/decide`: what the donor did on the page.
async fn decide(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Form(d): Form<Decide>,
) -> Response {
    let Some(s) = fake.checkout_session(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let to = |key: &str| match s[key].as_str() {
        Some(url) => Redirect::to(url).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    };
    match d.decision.as_str() {
        "pay" => {
            let Some(event) = fake.pay_checkout(&id) else {
                return Redirect::to(&format!("{}/checkout/{id}", fake.public_base))
                    .into_response();
            };
            fake.deliver(vec![event]).await;
            to("success_url")
        }
        "back" => to("cancel_url"),
        _ => invalid("parameter_invalid", "decision"),
    }
}

/// `POST simulate/checkout/{id}/expire`.
async fn simulate_expire(State(fake): State<Arc<Fake>>, Path(id): Path<String>) -> Response {
    let Some(event) = fake.expire_checkout(&id) else {
        return invalid("resource_missing", "No such open checkout.session");
    };
    let event_id = event["id"].clone();
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "event": event_id }))
}
