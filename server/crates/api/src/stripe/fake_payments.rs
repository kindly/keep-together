//! The fake's payments (plan stripe.sv, S3): PaymentIntents with their
//! charge, refunds, disputes and the event list, in Stripe's shapes. The
//! Checkout Sessions that make most payments are S4's
//! (`fake_checkout.rs`); its Pay button calls [`Fake::pay`].
//!
//! API (the platform's key, `Stripe-Version` and `Stripe-Account`):
//! - `GET v1/payment_intents/{id}`: the PaymentIntent, its charge under
//!   `latest_charge` (always expanded); another account's, or unknown:
//!   `404 resource_missing`;
//! - `GET v1/disputes?payment_intent=`: its disputes, newest first;
//! - `GET v1/events?created[gte]=&types[]=&limit=&starting_after=`: the
//!   account's events, newest first, `has_more` (what the catch-up reads).
//!
//! Simulators, `POST`, answering once the webhook has been delivered:
//! - `simulate/accounts/{id}/payment {amount, currency?, submission?,
//!   declined?}`: a payment taken on the account outside Checkout (or a
//!   card declined): `payment_intent.succeeded` / `.payment_failed`;
//! - `simulate/payments/{pi}/refund {amount?}`: refund that much more
//!   (all that is left by default): `charge.refunded`;
//! - `simulate/payments/{pi}/dispute`: the cardholder disputes it:
//!   `charge.dispute.created`;
//! - `simulate/payments/{pi}/dispute/close {outcome: won|lost}`:
//!   `charge.dispute.closed`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{Fake, account_invalid, error, invalid, simulated};

fn missing(what: &str) -> Response {
    error(
        StatusCode::NOT_FOUND,
        "invalid_request_error",
        "resource_missing",
        &format!("No such {what}"),
    )
}

impl Fake {
    fn intent(
        &self,
        account: &str,
        amount: i64,
        currency: &str,
        submission: Option<&str>,
        declined: bool,
    ) -> Value {
        let mut w = self.world();
        let (id, charge) = (w.id("pi_"), w.id("ch_"));
        let now = contracts::now_ms() / 1000;
        let metadata = match submission {
            Some(s) => json!({ "keep_submission": s }),
            None => json!({}),
        };
        let intent = json!({
            "id": id,
            "object": "payment_intent",
            "account": account,
            "amount": amount,
            "amount_received": if declined { 0 } else { amount },
            "currency": currency.to_lowercase(),
            "created": now,
            "status": if declined { "requires_payment_method" } else { "succeeded" },
            "cancellation_reason": null,
            "last_payment_error": if declined {
                json!({ "type": "card_error", "code": "card_declined",
                    "decline_code": "insufficient_funds",
                    "message": "Your card has insufficient funds." })
            } else {
                Value::Null
            },
            "latest_charge": if declined {
                Value::Null
            } else {
                json!({ "id": charge, "object": "charge", "amount": amount,
                    "amount_refunded": 0, "refunded": false, "disputed": false,
                    "created": now, "currency": currency.to_lowercase(),
                    "payment_intent": id, "status": "succeeded" })
            },
            "metadata": metadata
        });
        w.payments.insert(id, intent.clone());
        intent
    }

    /// A card payment that succeeded on connected `account`: a `pi_…`
    /// with its charge, answered as Stripe's PaymentIntent. `submission`
    /// is what a Checkout Session's `payment_intent_data.metadata`
    /// copies onto it (`keep_submission`). Emits nothing: the caller
    /// makes the events it wants ([`Fake::event`], [`Fake::deliver`]).
    pub fn pay(
        &self,
        account: &str,
        amount: i64,
        currency: &str,
        submission: Option<&str>,
    ) -> Value {
        self.intent(account, amount, currency, submission, false)
    }

    /// A card declined: a `requires_payment_method` PaymentIntent with
    /// its `last_payment_error` and no charge.
    pub fn decline(
        &self,
        account: &str,
        amount: i64,
        currency: &str,
        submission: Option<&str>,
    ) -> Value {
        self.intent(account, amount, currency, submission, true)
    }

    /// A PaymentIntent as Stripe would answer it now.
    pub fn payment(&self, id: &str) -> Option<Value> {
        self.world().payments.get(id).cloned()
    }

    fn account_of(&self, payment: &str) -> Option<String> {
        self.payment(payment)?["account"]
            .as_str()
            .map(str::to_owned)
    }

    /// Refund `amount` more of payment `id` (`None`: all that is left):
    /// its `charge.refunded` event, not yet delivered. `None`: no such
    /// payment, or nothing was charged.
    pub fn refund(&self, id: &str, amount: Option<i64>) -> Option<Value> {
        let charge = {
            let mut w = self.world();
            let charge = w.payments.get_mut(id)?.get_mut("latest_charge")?;
            let total = charge.get("amount")?.as_i64()?;
            let so_far = charge["amount_refunded"].as_i64().unwrap_or(0);
            let now = (so_far + amount.unwrap_or(total - so_far)).clamp(0, total);
            charge["amount_refunded"] = json!(now);
            charge["refunded"] = json!(now == total);
            charge.clone()
        };
        Some(self.event(&self.account_of(id)?, "charge.refunded", charge))
    }

    /// The cardholder disputes payment `id`: `charge.dispute.created`,
    /// not yet delivered.
    pub fn dispute(&self, id: &str) -> Option<Value> {
        let account = self.account_of(id)?;
        let dispute = {
            let mut w = self.world();
            let dispute_id = w.id("dp_");
            let p = w.payments.get_mut(id)?;
            let charge = p.get_mut("latest_charge").filter(|c| !c.is_null())?;
            charge["disputed"] = json!(true);
            let dispute = json!({
                "id": dispute_id, "object": "dispute", "account": account,
                "amount": charge["amount"], "charge": charge["id"],
                "payment_intent": id, "reason": "fraudulent",
                "status": "needs_response", "created": contracts::now_ms() / 1000
            });
            w.disputes.push(dispute.clone());
            dispute
        };
        Some(self.event(&account, "charge.dispute.created", dispute))
    }

    /// Payment `id`'s open dispute ends, `won` by the group or lost:
    /// `charge.dispute.closed`, not yet delivered.
    pub fn close_dispute(&self, id: &str, won: bool) -> Option<Value> {
        let account = self.account_of(id)?;
        let dispute = {
            let mut w = self.world();
            let d = w
                .disputes
                .iter_mut()
                .rev()
                .find(|d| d["payment_intent"] == id)?;
            d["status"] = json!(if won { "won" } else { "lost" });
            d.clone()
        };
        Some(self.event(&account, "charge.dispute.closed", dispute))
    }
}

/// The connected account a call is made for (`Stripe-Account`), if the
/// platform can reach it.
#[allow(clippy::result_large_err)]
fn on_account(fake: &Fake, headers: &HeaderMap) -> Result<String, Response> {
    let Some(account) = headers.get("Stripe-Account").and_then(|v| v.to_str().ok()) else {
        return Err(invalid("parameter_missing", "Stripe-Account"));
    };
    if !Fake::reachable(&fake.world(), account) {
        return Err(account_invalid());
    }
    Ok(account.to_owned())
}

/// The API routes (behind the gate).
pub(super) fn api() -> Router<Arc<Fake>> {
    Router::new()
        .route("/v1/payment_intents/{id}", get(get_intent))
        .route("/v1/disputes", get(list_disputes))
        .route("/v1/events", get(list_events))
}

/// The simulators.
pub(super) fn simulators() -> Router<Arc<Fake>> {
    Router::new()
        .route("/simulate/accounts/{id}/payment", post(simulate_payment))
        .route("/simulate/payments/{id}/refund", post(simulate_refund))
        .route("/simulate/payments/{id}/dispute", post(simulate_dispute))
        .route(
            "/simulate/payments/{id}/dispute/close",
            post(simulate_close),
        )
}

async fn get_intent(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let account = match on_account(&fake, &headers) {
        Ok(a) => a,
        Err(refused) => return refused,
    };
    match fake.payment(&id).filter(|p| p["account"] == account) {
        Some(p) => Json(p).into_response(),
        None => missing("payment_intent"),
    }
}

/// A query string's pairs, repeated keys kept (`types[]=a&types[]=b`).
fn pairs(raw: Option<String>) -> Vec<(String, String)> {
    reqwest::Url::parse(&format!("http://fake/?{}", raw.unwrap_or_default()))
        .map(|u| u.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

async fn list_disputes(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let account = match on_account(&fake, &headers) {
        Ok(a) => a,
        Err(refused) => return refused,
    };
    let query: HashMap<String, String> = pairs(raw).into_iter().collect();
    let intent = query.get("payment_intent");
    let data: Vec<Value> = fake
        .world()
        .disputes
        .iter()
        .rev()
        .filter(|d| d["account"] == account)
        .filter(|d| intent.is_none_or(|i| d["payment_intent"] == i.as_str()))
        .cloned()
        .collect();
    Json(json!({ "object": "list", "data": data, "has_more": false, "url": "/v1/disputes" }))
        .into_response()
}

async fn list_events(
    State(fake): State<Arc<Fake>>,
    headers: HeaderMap,
    RawQuery(raw): RawQuery,
) -> Response {
    let account = match on_account(&fake, &headers) {
        Ok(a) => a,
        Err(refused) => return refused,
    };
    let query = pairs(raw);
    let one = |k: &str| {
        query
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    };
    let types: Vec<&str> = query
        .iter()
        .filter(|(k, _)| k == "types[]")
        .map(|(_, v)| v.as_str())
        .collect();
    let since = one("created[gte]")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let limit = one("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(10)
        .clamp(1, 100);
    // Newest first, as Stripe lists them.
    let all: Vec<Value> = fake
        .world()
        .events
        .iter()
        .rev()
        .filter(|e| e["account"] == account)
        .filter(|e| e["created"].as_i64().unwrap_or(0) >= since)
        .filter(|e| types.is_empty() || types.iter().any(|t| e["type"] == *t))
        .cloned()
        .collect();
    let start = match one("starting_after") {
        Some(after) => match all.iter().position(|e| e["id"] == after) {
            Some(i) => i + 1,
            None => return missing("event"),
        },
        None => 0,
    };
    let page: Vec<Value> = all.iter().skip(start).take(limit).cloned().collect();
    let has_more = start + page.len() < all.len();
    Json(json!({ "object": "list", "data": page, "has_more": has_more, "url": "/v1/events" }))
        .into_response()
}

#[derive(Deserialize)]
struct NewPayment {
    amount: i64,
    #[serde(default)]
    currency: Option<String>,
    #[serde(default)]
    submission: Option<String>,
    #[serde(default)]
    declined: bool,
}

/// `POST simulate/accounts/{id}/payment`.
async fn simulate_payment(
    State(fake): State<Arc<Fake>>,
    Path(account): Path<String>,
    Json(p): Json<NewPayment>,
) -> Response {
    if !Fake::reachable(&fake.world(), &account) {
        return account_invalid();
    }
    let currency = p.currency.as_deref().unwrap_or("gbp");
    let (intent, kind) = if p.declined {
        (
            fake.decline(&account, p.amount, currency, p.submission.as_deref()),
            "payment_intent.payment_failed",
        )
    } else {
        (
            fake.pay(&account, p.amount, currency, p.submission.as_deref()),
            "payment_intent.succeeded",
        )
    };
    let event = fake.event(&account, kind, intent.clone());
    let event_id = event["id"].clone();
    let delivered = fake.deliver(vec![event]).await;
    simulated(
        delivered,
        json!({ "event": event_id, "payment_intent": intent["id"] }),
    )
}

async fn sent(fake: &Fake, event: Option<Value>) -> Response {
    let Some(event) = event else {
        return missing("payment_intent");
    };
    let event_id = event["id"].clone();
    let delivered = fake.deliver(vec![event]).await;
    simulated(delivered, json!({ "event": event_id }))
}

#[derive(Default, Deserialize)]
struct Refund {
    #[serde(default)]
    amount: Option<i64>,
}

/// `POST simulate/payments/{pi}/refund {amount?}`.
async fn simulate_refund(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    body: Option<Json<Refund>>,
) -> Response {
    let amount = body.and_then(|Json(r)| r.amount);
    sent(&fake, fake.refund(&id, amount)).await
}

/// `POST simulate/payments/{pi}/dispute`.
async fn simulate_dispute(State(fake): State<Arc<Fake>>, Path(id): Path<String>) -> Response {
    sent(&fake, fake.dispute(&id)).await
}

#[derive(Deserialize)]
struct Close {
    outcome: String,
}

/// `POST simulate/payments/{pi}/dispute/close {outcome}`.
async fn simulate_close(
    State(fake): State<Arc<Fake>>,
    Path(id): Path<String>,
    Json(c): Json<Close>,
) -> Response {
    sent(&fake, fake.close_dispute(&id, c.outcome == "won")).await
}
