//! GoCardless over HTTP: the partner OAuth endpoints on `connect` and the
//! few API calls a regular gift needs. The same client talks to the fake
//! ([`super::fake`]), the sandbox and live.
//!
//! Every API call sends `Authorization: Bearer <the organisation's
//! token>` (a sensitive header), `GoCardless-Version`, and on creates an
//! `Idempotency-Key` derived from our own id, so a retried create answers
//! the first one's resource (GoCardless's `409
//! idempotent_creation_conflict` with `links.conflicting_resource_id`).
//! Errors carry the status and GoCardless's `reason` only: never a token,
//! a secret, a URL or a body.

use std::time::Duration;

use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use reqwest::{Client, Method, StatusCode, Url};
use serde::Deserialize;
use serde_json::{Value, json};

/// The API version we code against (GoCardless's only one so far).
pub const VERSION: &str = "2015-07-06";
pub const TIMEOUT: Duration = Duration::from_secs(10);

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

/// The partner app's OAuth client.
#[derive(Clone, Debug)]
pub struct Credentials {
    id: String,
    secret: Secret,
}

impl Credentials {
    pub fn new(id: &str, secret: &str) -> Self {
        Self {
            id: id.to_owned(),
            secret: Secret::new(secret),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CallError {
    /// Never reached GoCardless, or no answer in time: try again later.
    Unreachable(String),
    /// The organisation's token is revoked or unknown (401).
    Unauthorized,
    /// GoCardless refused or failed: its status and `reason`.
    Refused { status: u16, reason: Option<String> },
    /// An answer we couldn't read.
    Malformed(String),
}

impl CallError {
    /// Worth retrying: unreachable, or GoCardless's own failure (5xx, 429).
    pub fn retryable(&self) -> bool {
        match self {
            CallError::Unreachable(_) => true,
            CallError::Refused { status, .. } => *status >= 500 || *status == 429,
            _ => false,
        }
    }
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Unreachable(e) => write!(f, "unreachable: {e}"),
            CallError::Unauthorized => f.write_str("token not accepted (401)"),
            CallError::Refused { status, reason } => write!(
                f,
                "status {status}, reason {}",
                reason.as_deref().unwrap_or("none")
            ),
            CallError::Malformed(e) => write!(f, "malformed answer: {e}"),
        }
    }
}

/// `POST /oauth/access_token`'s answer (the token itself is in
/// `access_token`; `organisation_id` matches webhooks).
#[derive(Clone, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub organisation_id: String,
    #[serde(default)]
    pub email: Option<String>,
}

impl std::fmt::Debug for TokenResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenResponse")
            .field("organisation_id", &self.organisation_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BillingRequest {
    pub id: String,
    pub status: String,
    /// The mandate made from its mandate request, once fulfilled.
    pub mandate: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Flow {
    pub id: String,
    pub authorisation_url: String,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mandate {
    pub id: String,
    pub status: String,
    /// `metadata.keep_regular_gift`: ours, if we made it.
    pub regular_gift: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub id: String,
    pub amount: i64,
    pub currency: String,
    pub charge_date: String,
    pub status: String,
    pub mandate: Option<String>,
    pub subscription: Option<String>,
}

/// A subscription to create on a mandate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewSubscription<'a> {
    pub mandate: &'a str,
    pub amount: i64,
    /// `monthly` or `yearly`.
    pub interval_unit: &'a str,
    pub day_of_month: u8,
    /// Yearly: `january` … `december`.
    pub month: Option<&'static str>,
    pub name: &'a str,
    /// Our regular gift's id, as metadata and in the idempotency key.
    pub regular_gift: &'a str,
}

/// The donor's name to prefill on the hosted page.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Prefill {
    pub given_name: Option<String>,
    pub family_name: Option<String>,
    pub company_name: Option<String>,
}

pub struct Api {
    http: Client,
    base: Url,
    connect: Url,
}

impl Api {
    pub fn new(base: &str, connect: &str) -> Result<Self, String> {
        let http = Client::builder()
            .timeout(TIMEOUT)
            // Tokens ride in headers: never follow them anywhere else.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("gocardless client: {}", e.without_url()))?;
        let parse = |s: &str| Url::parse(s).map_err(|e| format!("gocardless base url: {e}"));
        Ok(Self {
            http,
            base: parse(base)?,
            connect: parse(connect)?,
        })
    }

    fn url(base: &Url, path: &[&str]) -> Url {
        let mut url = base.clone();
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
        let reason = body
            .pointer("/error/errors/0/reason")
            .or_else(|| body.pointer("/error/type"))
            .or_else(|| body.get("error"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Err(CallError::Refused {
            status: status.as_u16(),
            reason,
        })
    }

    fn unreachable(e: reqwest::Error) -> CallError {
        CallError::Unreachable(e.without_url().to_string())
    }

    async fn call(
        &self,
        method: Method,
        token: &str,
        path: &[&str],
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<Value, CallError> {
        let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| CallError::Malformed("a token that isn't a header value".into()))?;
        auth.set_sensitive(true);
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, auth);
        headers.insert("GoCardless-Version", HeaderValue::from_static(VERSION));
        if let Some(key) = idempotency_key {
            headers.insert(
                "Idempotency-Key",
                HeaderValue::from_str(key).map_err(|_| CallError::Malformed("key".into()))?,
            );
        }
        let mut req = self
            .http
            .request(method, Self::url(&self.base, path))
            .headers(headers);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let response = req.send().await.map_err(Self::unreachable)?;
        Self::read(response).await
    }

    /// A create, answering the resource under `envelope`. A repeat with
    /// the same idempotency key (a retry) fetches the resource the first
    /// one made, which GoCardless names in its conflict.
    async fn create_once(
        &self,
        token: &str,
        path: &str,
        envelope: &str,
        body: Value,
        key: &str,
    ) -> Result<Value, CallError> {
        let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| CallError::Malformed("a token that isn't a header value".into()))?;
        auth.set_sensitive(true);
        let response = self
            .http
            .post(Self::url(&self.base, &[path]))
            .header(AUTHORIZATION, auth)
            .header("GoCardless-Version", VERSION)
            .header("Idempotency-Key", key)
            .json(&body)
            .send()
            .await
            .map_err(Self::unreachable)?;
        if response.status() == StatusCode::CONFLICT {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            let conflicting = body
                .pointer("/error/errors/0/links/conflicting_resource_id")
                .and_then(Value::as_str);
            let reason = body
                .pointer("/error/errors/0/reason")
                .and_then(Value::as_str);
            return match (reason, conflicting) {
                (Some("idempotent_creation_conflict"), Some(id)) => {
                    let v = self
                        .call(Method::GET, token, &[path, id], None, None)
                        .await?;
                    v.get(envelope)
                        .cloned()
                        .ok_or_else(|| CallError::Malformed(format!("no {envelope} in the answer")))
                }
                _ => Err(CallError::Refused {
                    status: 409,
                    reason: reason.map(str::to_owned),
                }),
            };
        }
        let v = Self::read(response).await?;
        v.get(envelope)
            .cloned()
            .ok_or_else(|| CallError::Malformed(format!("no {envelope} in the answer")))
    }

    // ── OAuth ──────────────────────────────────────────────────────────────

    /// Trade the callback's `code` for the organisation's token.
    pub async fn exchange_code(
        &self,
        creds: &Credentials,
        code: &str,
        redirect_uri: &str,
    ) -> Result<TokenResponse, CallError> {
        let response = self
            .http
            .post(Self::url(&self.connect, &["oauth", "access_token"]))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("client_id", creds.id.as_str()),
                ("client_secret", creds.secret.expose()),
            ])
            .send()
            .await
            .map_err(Self::unreachable)?;
        let v = Self::read(response).await?;
        serde_json::from_value(v).map_err(|_| CallError::Malformed("token answer".into()))
    }

    /// Revoke an organisation's token (GoCardless answers 200 whether or
    /// not it was live).
    pub async fn revoke(&self, creds: &Credentials, token: &str) -> Result<(), CallError> {
        let response = self
            .http
            .post(Self::url(&self.connect, &["oauth", "revoke"]))
            .form(&[
                ("token", token),
                ("client_id", creds.id.as_str()),
                ("client_secret", creds.secret.expose()),
            ])
            .send()
            .await
            .map_err(Self::unreachable)?;
        Self::read(response).await.map(|_| ())
    }

    // ── billing requests ───────────────────────────────────────────────────

    /// A mandate-only billing request (Bacs, GBP) for our regular gift. Our
    /// id rides as metadata on the request and on its mandate request
    /// (GoCardless copies that to the mandate it makes), so a mandate
    /// event names its regular gift with one `GET mandates/{id}`.
    pub async fn create_billing_request(
        &self,
        token: &str,
        regular_gift: &str,
    ) -> Result<BillingRequest, CallError> {
        let body = json!({
            "billing_requests": {
                "mandate_request": {
                    "scheme": "bacs",
                    "currency": "GBP",
                    "metadata": { "keep_regular_gift": regular_gift }
                },
                "metadata": { "keep_regular_gift": regular_gift }
            }
        });
        let v = self
            .create_once(
                token,
                "billing_requests",
                "billing_requests",
                body,
                &format!("keep-br-{regular_gift}"),
            )
            .await?;
        billing_request(&v)
    }

    pub async fn get_billing_request(
        &self,
        token: &str,
        id: &str,
    ) -> Result<BillingRequest, CallError> {
        let v = self
            .call(Method::GET, token, &["billing_requests", id], None, None)
            .await?;
        billing_request(v.get("billing_requests").unwrap_or(&Value::Null))
    }

    pub async fn cancel_billing_request(&self, token: &str, id: &str) -> Result<(), CallError> {
        self.call(
            Method::POST,
            token,
            &["billing_requests", id, "actions", "cancel"],
            Some(json!({ "data": {} })),
            None,
        )
        .await
        .map(|_| ())
    }

    /// The hosted page for a billing request (each lasts 7 days).
    pub async fn create_flow(
        &self,
        token: &str,
        billing_request: &str,
        prefill: &Prefill,
    ) -> Result<Flow, CallError> {
        let mut customer = serde_json::Map::new();
        for (k, v) in [
            ("given_name", &prefill.given_name),
            ("family_name", &prefill.family_name),
            ("company_name", &prefill.company_name),
        ] {
            if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
                customer.insert(k.into(), Value::String(v.into()));
            }
        }
        let body = json!({
            "billing_request_flows": {
                "links": { "billing_request": billing_request },
                "prefilled_customer": customer,
                "lock_currency": true
            }
        });
        let v = self
            .call(
                Method::POST,
                token,
                &["billing_request_flows"],
                Some(body),
                None,
            )
            .await?;
        let flow = v.get("billing_request_flows").unwrap_or(&Value::Null);
        let text = |k: &str| flow.get(k).and_then(Value::as_str).map(str::to_owned);
        Ok(Flow {
            id: text("id").ok_or_else(|| CallError::Malformed("flow id".into()))?,
            authorisation_url: text("authorisation_url")
                .ok_or_else(|| CallError::Malformed("flow url".into()))?,
            expires_at: text("expires_at"),
        })
    }

    // ── subscriptions, mandates, payments ──────────────────────────────────

    /// A subscription for our regular gift; created once whatever the
    /// retries (the key is the regular gift's).
    pub async fn create_subscription(
        &self,
        token: &str,
        s: &NewSubscription<'_>,
    ) -> Result<String, CallError> {
        let mut sub = json!({
            "amount": s.amount,
            "currency": "GBP",
            "interval_unit": s.interval_unit,
            "day_of_month": s.day_of_month,
            "name": s.name,
            "metadata": { "keep_regular_gift": s.regular_gift },
            "links": { "mandate": s.mandate }
        });
        if let Some(month) = s.month {
            sub["month"] = Value::String(month.into());
        }
        let v = self
            .create_once(
                token,
                "subscriptions",
                "subscriptions",
                json!({ "subscriptions": sub }),
                &format!("keep-sub-{}", s.regular_gift),
            )
            .await?;
        v.get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| CallError::Malformed("subscription id".into()))
    }

    /// Cancel a mandate: GoCardless cancels its subscriptions and pending
    /// payments with it. One already cancelled is fine.
    pub async fn cancel_mandate(&self, token: &str, id: &str) -> Result<(), CallError> {
        match self
            .call(
                Method::POST,
                token,
                &["mandates", id, "actions", "cancel"],
                Some(json!({ "data": {} })),
                None,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(CallError::Refused { status: 422, .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// A mandate's status and the regular gift its metadata names.
    pub async fn get_mandate(&self, token: &str, id: &str) -> Result<Mandate, CallError> {
        let v = self
            .call(Method::GET, token, &["mandates", id], None, None)
            .await?;
        let m = v.get("mandates").unwrap_or(&Value::Null);
        Ok(Mandate {
            id: m
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| CallError::Malformed("mandate id".into()))?
                .to_owned(),
            status: m
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            regular_gift: m
                .pointer("/metadata/keep_regular_gift")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// Cancel a subscription (one already cancelled is fine).
    pub async fn cancel_subscription(&self, token: &str, id: &str) -> Result<(), CallError> {
        match self
            .call(
                Method::POST,
                token,
                &["subscriptions", id, "actions", "cancel"],
                Some(json!({ "data": {} })),
                None,
            )
            .await
        {
            Ok(_) | Err(CallError::Refused { status: 422, .. }) => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn get_payment(&self, token: &str, id: &str) -> Result<Payment, CallError> {
        let v = self
            .call(Method::GET, token, &["payments", id], None, None)
            .await?;
        let p = v.get("payments").unwrap_or(&Value::Null);
        let text = |k: &str| p.get(k).and_then(Value::as_str).map(str::to_owned);
        let link = |k: &str| {
            p.pointer(&format!("/links/{k}"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let amount = p
            .get("amount")
            .and_then(|a| a.as_i64().or_else(|| a.as_str()?.parse().ok()))
            .ok_or_else(|| CallError::Malformed("payment amount".into()))?;
        Ok(Payment {
            id: text("id").ok_or_else(|| CallError::Malformed("payment id".into()))?,
            amount,
            currency: text("currency").unwrap_or_default(),
            charge_date: text("charge_date")
                .ok_or_else(|| CallError::Malformed("payment charge date".into()))?,
            status: text("status").unwrap_or_default(),
            mandate: link("mandate"),
            subscription: link("subscription"),
        })
    }
}

fn billing_request(v: &Value) -> Result<BillingRequest, CallError> {
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    Ok(BillingRequest {
        id: text("id").ok_or_else(|| CallError::Malformed("billing request id".into()))?,
        status: text("status").unwrap_or_default(),
        mandate: v
            .pointer("/links/mandate_request_mandate")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
