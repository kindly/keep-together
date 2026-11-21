//! Stripe Checkout for a donation (`factory/plans/stripe.sv`, step S4):
//! the session a donor pays on, made on the organisation's own account (a
//! direct charge: `Stripe-Account`). Reading one back is S3's
//! (`client.rs`); nothing here needs to.
//!
//! Stripe's pages this follows:
//! <https://docs.stripe.com/api/checkout/sessions/create>,
//! <https://docs.stripe.com/payments/checkout/how-checkout-works>.
//!
//! What a session carries: one line, the amount in pence under the
//! organisation's name, `submit_type=donate`, cards only, the donor's
//! email (Stripe's receipt goes there), and the submission's id as
//! `client_reference_id` and as metadata on the session and on its
//! PaymentIntent, so the payment is traced back to what the donor typed
//! whichever object an event names. No other personal data goes to
//! Stripe from here: not the name, not the address, not the declaration.
//!
//! No idempotency key: a create whose answer never reached us leaves a
//! session nobody was given the address of, which runs out unpaid; the
//! next try makes another. A key would have to change with every try
//! anyway (Stripe answers a key's first result again, a failure
//! included, and `expires_at` moves on).

use reqwest::Method;
use serde_json::Value;

use super::client::{Api, CallError};

/// How long a donor has on Stripe's page, in seconds: Stripe's shortest
/// (30 minutes) and a minute over, so the time is still inside Stripe's
/// range when the request lands.
pub const SESSION_SECS: i64 = 31 * 60;

/// A session to make.
pub struct NewSession<'a> {
    /// The organisation's Stripe account (`acct_…`).
    pub account: &'a str,
    /// The submission it is for (32 hex).
    pub submission_id: &'a str,
    /// Pence.
    pub amount: i64,
    pub email: &'a str,
    /// The line Stripe's page and receipt show.
    pub description: &'a str,
    /// Where Stripe sends the donor after paying (proof of nothing).
    pub success_url: &'a str,
    /// Where "back" on Stripe's page goes.
    pub cancel_url: &'a str,
    /// When it runs out (seconds since the epoch).
    pub expires_at: i64,
}

/// A Checkout Session as far as we read it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Session {
    /// `cs_…`.
    pub id: String,
    /// Stripe's page for it, while it is open.
    pub url: Option<String>,
    /// Still open: the donor can pay on it.
    pub open: bool,
}

impl Session {
    pub fn from_value(v: &Value) -> Result<Self, CallError> {
        let id = v
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| CallError::Malformed("a checkout session with no id".into()))?;
        Ok(Self {
            id: id.to_owned(),
            url: v.get("url").and_then(Value::as_str).map(str::to_owned),
            open: v.get("status").and_then(Value::as_str) == Some("open"),
        })
    }
}

const PATH: [&str; 3] = ["v1", "checkout", "sessions"];

/// Make the session (module docs).
pub async fn create(api: &Api, s: &NewSession<'_>) -> Result<Session, CallError> {
    let amount = s.amount.to_string();
    let expires_at = s.expires_at.to_string();
    let form = [
        ("mode", "payment"),
        ("submit_type", "donate"),
        ("payment_method_types[0]", "card"),
        ("line_items[0][quantity]", "1"),
        ("line_items[0][price_data][currency]", "gbp"),
        ("line_items[0][price_data][unit_amount]", amount.as_str()),
        (
            "line_items[0][price_data][product_data][name]",
            s.description,
        ),
        ("customer_email", s.email),
        ("client_reference_id", s.submission_id),
        ("metadata[keep_submission]", s.submission_id),
        (
            "payment_intent_data[metadata][keep_submission]",
            s.submission_id,
        ),
        ("success_url", s.success_url),
        ("cancel_url", s.cancel_url),
        ("expires_at", expires_at.as_str()),
    ];
    let made = api
        .on_account(Method::POST, s.account, &PATH, Some(&form), None)
        .await?;
    Session::from_value(&made)
}

/// Stripe refused the donor's email address as one.
pub fn email_refused(e: &CallError) -> bool {
    matches!(e, CallError::Refused { status: 400, code: Some(code) } if code == "email_invalid")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_session_is_read_from_stripes_shape() {
        let s = Session::from_value(&json!({
            "id": "cs_test_1", "status": "open", "url": "https://checkout.stripe.com/c/pay/cs_test_1"
        }))
        .unwrap();
        assert!(s.open);
        assert_eq!(
            s.url.as_deref(),
            Some("https://checkout.stripe.com/c/pay/cs_test_1")
        );
        // Paid or run out: Stripe answers no url.
        let done =
            Session::from_value(&json!({ "id": "cs_test_1", "status": "complete", "url": null }))
                .unwrap();
        assert!(!done.open && done.url.is_none());
        assert!(Session::from_value(&json!({})).is_err());
    }

    #[test]
    fn only_stripes_email_refusal_is_the_donors_to_mend() {
        let refused = |status, code: &str| CallError::Refused {
            status,
            code: Some(code.into()),
        };
        assert!(email_refused(&refused(400, "email_invalid")));
        assert!(!email_refused(&refused(400, "parameter_missing")));
        assert!(!email_refused(&refused(500, "email_invalid")));
    }
}
