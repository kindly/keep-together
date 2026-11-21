//! Stripe over HTTP: the few calls connecting an organisation needs. The
//! same client talks to the fake ([`super::fake`]), a sandbox and live
//! (one host for both: the key says which).
//!
//! Every call sends `Authorization: Bearer <the platform's key>` (a
//! sensitive header) and `Stripe-Version: `[`VERSION`], so Stripe's
//! answers keep one shape whatever the account's default version becomes.
//! A call on an organisation's behalf adds `Stripe-Account: acct_…`
//! ([`Api::on_account`]; S3 and S4 use it). Creates carry an
//! `Idempotency-Key` of ours, so a create tried again is the first one's
//! resource. Errors carry the status and Stripe's error `code` only:
//! never a key, a URL or a body.
//!
//! **Which Accounts API** is decided here and nowhere else:
//! [`ACCOUNTS_API`]. Stripe has two ways to make a connected account
//! (read from its docs on 2026-11-18):
//!
//! - *v2* (`POST /v2/core/accounts`, JSON): what Stripe recommends for
//!   new platforms, in the released version since `2025-12-15.clover`.
//!   Its docs warn that a new platform "might need to enable Accounts v1
//!   support" before `POST /v1/accounts` works at all.
//! - *v1* (`POST /v1/accounts`, form-encoded) with `controller`
//!   properties.
//!
//! Either way the organisation gets the same account: the full Stripe
//! Dashboard, its own fees, Stripe carrying the losses and collecting the
//! requirements. The plan's rule is "v2 if it runs on a released version,
//! otherwise v1", so v2 it is; v1 is kept beside it, a one-word change,
//! because nobody has run either against a real sandbox yet (S0).
//! Whichever makes the account, it is *read* through `GET
//! /v1/accounts/{id}` and its changes arrive as v1 `account.updated`
//! events: Stripe documents both for v2 accounts, and one shape is
//! enough.

use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::{Value, json};

/// The API version we code against, sent on every call.
pub const VERSION: &str = "2026-10-28.endive";
pub const TIMEOUT: Duration = Duration::from_secs(10);

/// Stripe's two Accounts APIs (module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountsApi {
    V1,
    V2,
}

/// The one we use to make an account and its onboarding link.
pub const ACCOUNTS_API: AccountsApi = AccountsApi::V2;

/// The event types that say a connected account changed, on a
/// "connected accounts" webhook endpoint. v1 snapshot events, which v2
/// accounts send too.
pub const ACCOUNT_UPDATED: &str = "account.updated";
/// The account's owner removed the platform from their Stripe account.
pub const ACCOUNT_DEAUTHORIZED: &str = "account.application.deauthorized";

/// The payment events of a connected account that processing handles
/// ([`super::payments`]), and the catch-up asks for. A Checkout Session's
/// events name its PaymentIntent and our submission; the rest name the
/// PaymentIntent, on the object itself (`payment_intent.*`) or as its
/// `payment_intent` (a charge, a refund, a dispute).
pub const SESSION_EVENTS: &[&str] = &[
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
];
pub const SESSION_EXPIRED: &str = "checkout.session.expired";
pub const PAYMENT_INTENT_EVENTS: &[&str] = &[
    "payment_intent.succeeded",
    "payment_intent.payment_failed",
    "payment_intent.canceled",
];
pub const CHARGE_EVENTS: &[&str] = &[
    "charge.refunded",
    "charge.refund.updated",
    "charge.dispute.created",
    "charge.dispute.updated",
    "charge.dispute.closed",
    "charge.dispute.funds_withdrawn",
    "charge.dispute.funds_reinstated",
];

/// Every event type the catch-up reads for an account.
pub fn handled_events() -> Vec<&'static str> {
    [ACCOUNT_UPDATED, ACCOUNT_DEAUTHORIZED]
        .into_iter()
        .chain(SESSION_EVENTS.iter().copied())
        .chain(PAYMENT_INTENT_EVENTS.iter().copied())
        .chain(CHARGE_EVENTS.iter().copied())
        .collect()
}

/// The most events Stripe lists in one page.
pub const EVENTS_PAGE: usize = 100;

/// A secret string whose `Debug` never prints it.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: &str) -> Self {
        Self(value.to_owned())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(..)")
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallError {
    /// Never reached Stripe, or no answer in time: try again later.
    Unreachable(String),
    /// Stripe doesn't accept the platform's key (401).
    Unauthorized,
    /// Stripe refused or failed: its status and error `code` (or `type`).
    Refused { status: u16, code: Option<String> },
    /// An answer we couldn't read.
    Malformed(String),
}

impl CallError {
    /// Worth retrying: unreachable, Stripe's own failure (5xx), a rate
    /// limit (429) or a request still in flight under the same
    /// idempotency key (409).
    pub fn retryable(&self) -> bool {
        match self {
            CallError::Unreachable(_) => true,
            CallError::Refused { status, .. } => *status >= 500 || *status == 429 || *status == 409,
            _ => false,
        }
    }

    /// Stripe refuses the platform's key itself: not accepted (401), or
    /// without the permission the call needs (a 403 that isn't
    /// [`Self::account_gone`]). Nothing about the request is wrong.
    pub fn platform_key(&self) -> bool {
        match self {
            CallError::Unauthorized => true,
            CallError::Refused { status: 403, .. } => !self.account_gone(),
            _ => false,
        }
    }

    /// Whether a create that failed this way may be tried again under
    /// the same idempotency key. Only when Stripe may have made the
    /// resource without our hearing (no answer), or says to come back
    /// (429, a 409 for a request still in flight). Anything else Stripe
    /// stores against the key and answers again for as long as it keeps
    /// it (a 500 included), so the next try needs a new key.
    pub fn same_key_again(&self) -> bool {
        match self {
            CallError::Unreachable(_) => true,
            CallError::Refused { status, .. } => *status == 429 || *status == 409,
            _ => false,
        }
    }

    /// The account isn't the platform's (any more): it doesn't exist,
    /// was never connected, or its owner removed us. Stripe answers all
    /// three alike, `403 account_invalid`.
    pub fn account_gone(&self) -> bool {
        matches!(self, CallError::Refused { status: 403, code: Some(code) }
            if code == "account_invalid")
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Unreachable(e) => write!(f, "unreachable: {e}"),
            CallError::Unauthorized => f.write_str("key not accepted (401)"),
            CallError::Refused { status, code } => write!(
                f,
                "status {status}, code {}",
                code.as_deref().unwrap_or("none")
            ),
            CallError::Malformed(e) => write!(f, "malformed answer: {e}"),
        }
    }
}

/// A connected account as Stripe has it now: what we keep of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub id: String,
    /// The owner sent Stripe's form in.
    pub details_submitted: bool,
    /// Stripe takes card payments for it.
    pub charges_enabled: bool,
    pub payouts_enabled: bool,
    /// How many things Stripe asks for now or is overdue
    /// (`requirements.currently_due` and `past_due`, each counted once).
    pub requirements_due: i64,
    /// `requirements.disabled_reason`.
    pub disabled_reason: Option<String>,
}

impl Account {
    /// From Stripe's v1 Account object (`GET /v1/accounts/{id}`).
    pub fn from_v1(v: &Value) -> Result<Self, CallError> {
        let id = v
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| CallError::Malformed("an account with no id".into()))?;
        let flag = |k: &str| v.get(k).and_then(Value::as_bool).unwrap_or(false);
        let mut due: Vec<&str> = ["currently_due", "past_due"]
            .iter()
            .filter_map(|k| v.pointer(&format!("/requirements/{k}"))?.as_array())
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        due.sort_unstable();
        due.dedup();
        Ok(Self {
            id: id.to_owned(),
            details_submitted: flag("details_submitted"),
            charges_enabled: flag("charges_enabled"),
            payouts_enabled: flag("payouts_enabled"),
            requirements_due: due.len() as i64,
            disabled_reason: v
                .pointer("/requirements/disabled_reason")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

/// A PaymentIntent as Stripe has it now, with its latest charge: what we
/// keep of a payment (<https://docs.stripe.com/api/payment_intents/object>,
/// <https://docs.stripe.com/api/charges/object>). Amounts are minor units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentIntent {
    /// `pi_…`.
    pub id: String,
    pub amount: i64,
    /// Lower case, as Stripe sends it (`gbp`).
    pub currency: String,
    /// Stripe's own: `succeeded`, `processing`, `requires_payment_method`,
    /// `canceled`, …
    pub status: String,
    /// When the money was taken (its charge's `created`, unix seconds);
    /// the intent's own `created` when it has no charge.
    pub paid_at: i64,
    /// `latest_charge.amount_refunded`: refunded in all.
    pub refunded: i64,
    /// Why the last attempt failed (`last_payment_error`: its decline
    /// code, else its code), or why it was cancelled.
    pub failure: Option<String>,
    /// The last attempt failed (`last_payment_error` is set).
    pub attempt_failed: bool,
    /// `metadata.keep_submission`: the submission whose Checkout Session
    /// made it (Stripe copies it from the session's
    /// `payment_intent_data.metadata`), when it carries one.
    pub submission: Option<String>,
}

impl PaymentIntent {
    /// From `GET /v1/payment_intents/{id}?expand[]=latest_charge`.
    pub fn from_v1(v: &Value) -> Result<Self, CallError> {
        let text = |p: &str| v.pointer(p).and_then(Value::as_str).map(str::to_owned);
        let number = |p: &str| v.pointer(p).and_then(Value::as_i64);
        let (Some(id), Some(amount), Some(currency), Some(status)) = (
            text("/id"),
            number("/amount"),
            text("/currency"),
            text("/status"),
        ) else {
            return Err(CallError::Malformed(
                "a payment intent with no id, amount, currency or status".into(),
            ));
        };
        Ok(Self {
            id,
            amount,
            currency: currency.to_lowercase(),
            status,
            paid_at: number("/latest_charge/created")
                .or_else(|| number("/created"))
                .unwrap_or(0),
            refunded: number("/latest_charge/amount_refunded").unwrap_or(0),
            failure: text("/last_payment_error/decline_code")
                .or_else(|| text("/last_payment_error/code"))
                .or_else(|| text("/cancellation_reason")),
            attempt_failed: v.get("last_payment_error").is_some_and(|e| !e.is_null()),
            submission: text("/metadata/keep_submission"),
        })
    }
}

/// A card dispute as Stripe has it now
/// (<https://docs.stripe.com/api/disputes/object>).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dispute {
    pub id: String,
    /// `needs_response`, `under_review`, `won`, `lost`, or a `warning_…`
    /// (an inquiry: no money has moved).
    pub status: String,
    /// The cardholder's bank's reason (`fraudulent`, `duplicate`, …).
    pub reason: Option<String>,
    pub created: i64,
}

/// One page of `GET /v1/events`, newest first.
#[derive(Clone, Debug, PartialEq)]
pub struct EventPage {
    pub events: Vec<Value>,
    pub has_more: bool,
}

/// What a request carries.
enum Payload<'a> {
    None,
    /// v1: `application/x-www-form-urlencoded`, nested keys in brackets.
    Form(&'a [(&'a str, &'a str)]),
    /// v2: JSON.
    Json(Value),
}

pub struct Api {
    http: Client,
    base: Url,
    key: Secret,
}

impl Api {
    pub fn new(base: &str, key: Secret) -> Result<Self, String> {
        let http = Client::builder()
            .timeout(TIMEOUT)
            // The key rides in a header: never follow it anywhere else.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("stripe client: {}", e.without_url()))?;
        HeaderValue::from_str(&format!("Bearer {}", key.expose()))
            .map_err(|_| "KEEP_STRIPE_API_KEY isn't a header value".to_owned())?;
        Ok(Self {
            http,
            base: Url::parse(base).map_err(|e| format!("stripe base url: {e}"))?,
            key,
        })
    }

    fn url(&self, path: &[&str]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("an http(s) base")
            .pop_if_empty()
            .extend(path);
        url
    }

    async fn read(response: reqwest::Response) -> Result<Value, CallError> {
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(CallError::Unauthorized);
        }
        let code = body
            .pointer("/error/code")
            .or_else(|| body.pointer("/error/type"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Err(CallError::Refused {
            status: status.as_u16(),
            code,
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &[&str],
        account: Option<&str>,
        payload: Payload<'_>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CallError> {
        self.call_with(method, path, &[], account, payload, idempotency_key)
            .await
    }

    /// [`Self::call`] with a query string (a `GET`'s filters).
    async fn call_with(
        &self,
        method: Method,
        path: &[&str],
        query: &[(&str, &str)],
        account: Option<&str>,
        payload: Payload<'_>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CallError> {
        let header = |v: &str, what: &str| {
            HeaderValue::from_str(v).map_err(|_| CallError::Malformed(what.into()))
        };
        let mut auth = header(&format!("Bearer {}", self.key.expose()), "key")?;
        auth.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth);
        headers.insert("Stripe-Version", HeaderValue::from_static(VERSION));
        if let Some(account) = account {
            headers.insert("Stripe-Account", header(account, "account id")?);
        }
        if let Some(key) = idempotency_key {
            headers.insert("Idempotency-Key", header(key, "idempotency key")?);
        }
        let mut url = self.url(path);
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        let mut req = self.http.request(method, url).headers(headers);
        req = match payload {
            Payload::None => req,
            Payload::Form(pairs) => req.form(pairs),
            Payload::Json(body) => req.json(&body),
        };
        let response = req
            .send()
            .await
            .map_err(|e| CallError::Unreachable(e.without_url().to_string()))?;
        Self::read(response).await
    }

    /// A v1 call on a connected account's behalf (`Stripe-Account`): a
    /// direct charge's Checkout Session, its events. `form` for a `POST`.
    /// For S3 and S4.
    pub async fn on_account(
        &self,
        method: Method,
        account: &str,
        path: &[&str],
        form: Option<&[(&str, &str)]>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CallError> {
        let payload = form.map_or(Payload::None, Payload::Form);
        self.call(method, path, Some(account), payload, idempotency_key)
            .await
    }

    /// The PaymentIntent `id` on connected `account`, as it is now, with
    /// its latest charge (what was refunded, when it was taken).
    pub async fn get_payment_intent(
        &self,
        account: &str,
        id: &str,
    ) -> Result<PaymentIntent, CallError> {
        let v = self
            .call_with(
                Method::GET,
                &["v1", "payment_intents", id],
                &[("expand[]", "latest_charge")],
                Some(account),
                Payload::None,
                None,
            )
            .await?;
        PaymentIntent::from_v1(&v)
    }

    /// The disputes on a PaymentIntent, newest first (a payment has one
    /// at most at a time; an inquiry may come before a chargeback).
    pub async fn list_disputes(
        &self,
        account: &str,
        payment_intent: &str,
    ) -> Result<Vec<Dispute>, CallError> {
        let v = self
            .call_with(
                Method::GET,
                &["v1", "disputes"],
                &[("payment_intent", payment_intent), ("limit", "10")],
                Some(account),
                Payload::None,
                None,
            )
            .await?;
        let mut out: Vec<Dispute> = v
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| CallError::Malformed("a dispute list with no data".into()))?
            .iter()
            .filter_map(|d| {
                Some(Dispute {
                    id: d.get("id")?.as_str()?.to_owned(),
                    status: d.get("status")?.as_str()?.to_owned(),
                    reason: d.get("reason").and_then(Value::as_str).map(str::to_owned),
                    created: d.get("created").and_then(Value::as_i64).unwrap_or(0),
                })
            })
            .collect();
        out.sort_by_key(|d| std::cmp::Reverse(d.created));
        Ok(out)
    }

    /// One page of connected `account`'s events of `types` created at or
    /// after `since` (unix seconds), newest first; `starting_after`: the
    /// last event id of the page before (<https://docs.stripe.com/api/events/list>;
    /// Stripe keeps 30 days).
    pub async fn list_events(
        &self,
        account: &str,
        since: i64,
        types: &[&str],
        starting_after: Option<&str>,
    ) -> Result<EventPage, CallError> {
        let (since, limit) = (since.to_string(), EVENTS_PAGE.to_string());
        let mut query = vec![("created[gte]", since.as_str()), ("limit", limit.as_str())];
        query.extend(types.iter().map(|t| ("types[]", *t)));
        if let Some(after) = starting_after {
            query.push(("starting_after", after));
        }
        let v = self
            .call_with(
                Method::GET,
                &["v1", "events"],
                &query,
                Some(account),
                Payload::None,
                None,
            )
            .await?;
        Ok(EventPage {
            events: v
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| CallError::Malformed("an event list with no data".into()))?,
            has_more: v.get("has_more").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    /// Make the organisation's Stripe account, answering its id
    /// (`acct_…`). The full Dashboard, the account pays Stripe's fees,
    /// Stripe carries the losses and collects the requirements; in the
    /// UK, asked for card payments. Everything else (who they are, their
    /// bank account) Stripe's own form asks the organisation.
    /// `idempotency_key`: tried again under it, the same account. Stripe
    /// refuses a key reused with another body, so the body holds nothing
    /// that can change between tries: not the organisation's name (a
    /// rename would do it), only `tenant`, its id here, as metadata
    /// (`keep_tenant`), which also traces the account back from Stripe's
    /// side.
    pub async fn create_account(
        &self,
        tenant: &str,
        idempotency_key: &str,
    ) -> Result<String, CallError> {
        let made = match ACCOUNTS_API {
            AccountsApi::V2 => {
                let body = json!({
                    "dashboard": "full",
                    "identity": { "country": "gb" },
                    "configuration": { "merchant": { "capabilities": {
                        "card_payments": { "requested": true }
                    } } },
                    "defaults": { "responsibilities": {
                        "fees_collector": "stripe",
                        "losses_collector": "stripe"
                    } },
                    "metadata": { "keep_tenant": tenant }
                });
                self.call(
                    Method::POST,
                    &["v2", "core", "accounts"],
                    None,
                    Payload::Json(body),
                    Some(idempotency_key),
                )
                .await?
            }
            AccountsApi::V1 => {
                let form = [
                    ("country", "GB"),
                    ("controller[stripe_dashboard][type]", "full"),
                    ("controller[fees][payer]", "account"),
                    ("controller[losses][payments]", "stripe"),
                    ("controller[requirement_collection]", "stripe"),
                    ("capabilities[card_payments][requested]", "true"),
                    ("metadata[keep_tenant]", tenant),
                ];
                self.call(
                    Method::POST,
                    &["v1", "accounts"],
                    None,
                    Payload::Form(&form),
                    Some(idempotency_key),
                )
                .await?
            }
        };
        made.get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| CallError::Malformed("an account with no id".into()))
    }

    /// The account as Stripe has it now. One that isn't ours (any more):
    /// [`CallError::account_gone`].
    pub async fn get_account(&self, id: &str) -> Result<Account, CallError> {
        let v = self
            .call(
                Method::GET,
                &["v1", "accounts", id],
                None,
                Payload::None,
                None,
            )
            .await?;
        Account::from_v1(&v)
    }

    /// A link to Stripe's hosted onboarding form for `account`: single
    /// use, good for minutes. Stripe sends the browser to `return_url`
    /// when the admin finishes or leaves (which proves nothing: read the
    /// account), and to `refresh_url` when the link is spent or expired
    /// (make another).
    pub async fn create_onboarding_link(
        &self,
        account: &str,
        refresh_url: &str,
        return_url: &str,
    ) -> Result<String, CallError> {
        let made = match ACCOUNTS_API {
            AccountsApi::V2 => {
                let body = json!({
                    "account": account,
                    "use_case": {
                        "type": "account_onboarding",
                        "account_onboarding": {
                            "configurations": ["merchant"],
                            "refresh_url": refresh_url,
                            "return_url": return_url
                        }
                    }
                });
                self.call(
                    Method::POST,
                    &["v2", "core", "account_links"],
                    None,
                    Payload::Json(body),
                    None,
                )
                .await?
            }
            AccountsApi::V1 => {
                let form = [
                    ("account", account),
                    ("type", "account_onboarding"),
                    ("refresh_url", refresh_url),
                    ("return_url", return_url),
                ];
                self.call(
                    Method::POST,
                    &["v1", "account_links"],
                    None,
                    Payload::Form(&form),
                    None,
                )
                .await?
            }
        };
        made.get("url")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| CallError::Malformed("an account link with no url".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_account_is_read_from_stripes_v1_shape() {
        let a = Account::from_v1(&json!({
            "id": "acct_1",
            "details_submitted": true,
            "charges_enabled": false,
            "payouts_enabled": false,
            "requirements": {
                "currently_due": ["external_account", "tos_acceptance.date"],
                "past_due": ["external_account"],
                "eventually_due": ["company.tax_id"],
                "disabled_reason": "requirements.past_due"
            }
        }))
        .unwrap();
        assert_eq!(
            a,
            Account {
                id: "acct_1".into(),
                details_submitted: true,
                charges_enabled: false,
                payouts_enabled: false,
                requirements_due: 2,
                disabled_reason: Some("requirements.past_due".into()),
            }
        );
        // Nothing but an id: nothing done yet.
        let bare = Account::from_v1(&json!({ "id": "acct_2" })).unwrap();
        assert!(!bare.details_submitted && !bare.charges_enabled);
        assert_eq!(bare.requirements_due, 0);
        assert!(Account::from_v1(&json!({})).is_err());
    }

    #[test]
    fn a_payment_intent_is_read_with_its_charge() {
        let p = PaymentIntent::from_v1(&json!({
            "id": "pi_1", "amount": 2500, "currency": "GBP", "status": "succeeded",
            "created": 100,
            "latest_charge": { "id": "ch_1", "created": 160, "amount_refunded": 500 },
            "last_payment_error": null,
            "metadata": { "keep_submission": "abc" }
        }))
        .unwrap();
        assert_eq!((p.amount, p.currency.as_str()), (2500, "gbp"));
        assert_eq!((p.paid_at, p.refunded), (160, 500));
        assert_eq!(p.submission.as_deref(), Some("abc"));
        assert!(!p.attempt_failed);
        let declined = PaymentIntent::from_v1(&json!({
            "id": "pi_2", "amount": 1000, "currency": "gbp",
            "status": "requires_payment_method", "created": 100, "latest_charge": null,
            "last_payment_error": { "code": "card_declined",
                "decline_code": "insufficient_funds" }
        }))
        .unwrap();
        assert!(declined.attempt_failed);
        assert_eq!(declined.failure.as_deref(), Some("insufficient_funds"));
        assert_eq!((declined.paid_at, declined.refunded), (100, 0));
        assert!(PaymentIntent::from_v1(&json!({ "id": "pi_3" })).is_err());
    }

    #[test]
    fn which_failures_are_worth_another_try() {
        let refused = |status, code: &str| CallError::Refused {
            status,
            code: Some(code.into()),
        };
        assert!(CallError::Unreachable("timeout".into()).retryable());
        assert!(refused(500, "api_error").retryable());
        assert!(refused(429, "rate_limit").retryable());
        assert!(refused(409, "idempotency_key_in_use").retryable());
        assert!(!refused(400, "parameter_missing").retryable());
        assert!(!CallError::Unauthorized.retryable());
        assert!(refused(403, "account_invalid").account_gone());
        // A restricted key without the permission is a 403 too, and the
        // account is still there.
        assert!(!refused(403, "permission_denied").account_gone());
        assert!(!refused(404, "resource_missing").account_gone());
        // The platform's key at fault, not the request.
        assert!(CallError::Unauthorized.platform_key());
        assert!(refused(403, "permission_denied").platform_key());
        assert!(!refused(403, "account_invalid").platform_key());
        assert!(!refused(400, "parameter_missing").platform_key());
        assert!(!refused(500, "api_error").platform_key());
        // A failed create under the same key again: only when Stripe
        // hasn't stored an answer against it.
        assert!(CallError::Unreachable("timeout".into()).same_key_again());
        assert!(refused(409, "idempotency_key_in_use").same_key_again());
        assert!(refused(429, "rate_limit").same_key_again());
        assert!(!refused(500, "api_error").same_key_again());
        assert!(!refused(400, "idempotency_error").same_key_again());
        assert!(!CallError::Unauthorized.same_key_again());
    }
}
