//! `POST /api/stripe/webhook`: Stripe's events for every connected
//! account, on one platform route (a "connected accounts" endpoint;
//! <https://docs.stripe.com/webhooks>, <https://docs.stripe.com/connect/webhooks>).
//!
//! `Stripe-Signature` is `t=<unix seconds>,v1=<hex>,…`: the HMAC-SHA256
//! of `<t>.<raw body>` under the endpoint's signing secret (the whole
//! `whsec_…` string) must equal one of its `v1` entries (there are two
//! while a secret is being rolled), compared in constant time, and `t`
//! must be within [`TOLERANCE_SECS`] of now (a captured delivery can't be
//! replayed later). Other entries are ignored: Stripe adds them. Missing,
//! malformed, wrong or stale: `400` and nothing is read. Stripe sends a
//! failed delivery again, re-signed, for up to three days (a sandbox:
//! three times over a few hours).
//!
//! A signed event is stored in `platform.db` under Stripe's event id (a
//! repeat is a no-op), routed by its `account` to the organisation
//! connected to it. One for an account no organisation here is connected
//! to is stored and not run: `not_connected` when the account is an
//! organisation's that disconnected (replayed if it connects again),
//! `unknown_account` otherwise; an event of the other mode (`livemode`)
//! is `wrong_mode`. The answer is `200` straight away and a processing
//! run starts in the background ([`super::process`]).

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use hmac::{Hmac, Mac};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use sha2::Sha256;
use store::Store;

use super::Stripe;
use crate::AppState;

pub const SIGNATURE_HEADER: &str = "Stripe-Signature";
/// How far a signature's timestamp may be from now, either way (Stripe's
/// libraries' default).
pub const TOLERANCE_SECS: i64 = 300;

fn mac(secret: &str, timestamp: i64, body: &[u8]) -> Hmac<Sha256> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    mac
}

/// The `Stripe-Signature` header for `body` signed at `timestamp` (unix
/// seconds): how the fake signs.
pub fn sign(secret: &str, timestamp: i64, body: &[u8]) -> String {
    let hex: String = mac(secret, timestamp, body)
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("t={timestamp},v1={hex}")
}

/// Whether `header` signs `body` under `secret`, at a time within
/// [`TOLERANCE_SECS`] of `now` (unix seconds).
pub fn verify(secret: &str, body: &[u8], header: &str, now: i64) -> bool {
    let mut timestamp = None;
    let mut candidates = Vec::new();
    for entry in header.split(',') {
        match entry.trim().split_once('=') {
            // The first `t` only: a second can't move the signed time.
            Some(("t", v)) if timestamp.is_none() => timestamp = v.parse::<i64>().ok(),
            Some(("v1", v)) => candidates.push(v),
            _ => {}
        }
    }
    let Some(timestamp) = timestamp else {
        return false;
    };
    if (now - timestamp).abs() > TOLERANCE_SECS {
        return false;
    }
    candidates.iter().any(|hex| {
        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return false;
        }
        let bytes: Vec<u8> = (0..32)
            .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap_or(0))
            .collect();
        mac(secret, timestamp, body).verify_slice(&bytes).is_ok()
    })
}

/// One event as stored: what routing and processing need.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Incoming {
    pub id: String,
    /// The connected account it is about (`account`); none on an event
    /// of the platform's own account.
    pub account: Option<String>,
    pub kind: String,
    /// Stripe's `created` (unix seconds).
    pub created: i64,
    pub livemode: bool,
    pub body: String,
}

/// A signed body as an event; `None` if it isn't one (no `id` or `type`).
pub fn parse(body: &[u8]) -> Option<Incoming> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    Some(Incoming {
        id: text("id")?,
        account: text("account"),
        kind: text("type")?,
        created: v.get("created").and_then(Value::as_i64).unwrap_or(0),
        livemode: v.get("livemode").and_then(Value::as_bool).unwrap_or(false),
        body: v.to_string(),
    })
}

/// What [`store_event`] did with an event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stored {
    /// New, for a connected organisation: to process.
    Queued,
    /// Seen before: nothing done.
    Repeat,
    /// New and stored, but not to be run: why (the outcome stored).
    SetAside(&'static str),
}

/// Store `event` in `platform.db`, routed to its organisation, in one
/// transaction. `livemode`: the mode this server runs in.
pub fn store_event(
    store: &Store,
    event: &Incoming,
    livemode: bool,
    now: i64,
) -> Result<Stored, store::StoreError> {
    store.platform().with_write(|tx| {
        // A read that fails fails the delivery (a 5xx: Stripe sends it
        // again), never reads as an unknown account.
        let holder: Option<(String, Option<i64>)> = match &event.account {
            Some(account) => tx
                .query_row(
                    "SELECT tenant_id, disconnected_at FROM stripe_accounts
                     WHERE account_id = ?1",
                    [account],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?,
            None => None,
        };
        let (tenant, aside) = match holder {
            _ if event.livemode != livemode => (None, Some("wrong_mode")),
            Some((tenant, None)) => (Some(tenant), None),
            Some((tenant, Some(_))) => (Some(tenant), Some("not_connected")),
            None => (None, Some("unknown_account")),
        };
        let added = tx.execute(
            "INSERT OR IGNORE INTO stripe_events (id, account_id, tenant_id, type, created,
                 body, received_at, processed_at, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                event.id,
                event.account,
                tenant,
                event.kind,
                event.created,
                event.body,
                now,
                aside.map(|_| now),
                aside
            ],
        )?;
        Ok(match (added, aside) {
            (0, _) => Stored::Repeat,
            (_, None) => Stored::Queued,
            (_, Some(why)) => Stored::SetAside(why),
        })
    })
}

/// The route.
pub async fn receive(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(stripe) = state.stripe.clone() else {
        return crate::ApiError::NotFound.into_response();
    };
    let signature = headers
        .get(SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let now = contracts::now_ms();
    if !verify(
        stripe.webhook_secret().expose(),
        &body,
        signature,
        now / 1000,
    ) {
        eprintln!("stripe webhook: bad signature, refused");
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(event) = parse(&body) else {
        eprintln!("stripe webhook: a signed body that isn't an event");
        return StatusCode::BAD_REQUEST.into_response();
    };
    let (store, livemode, e) = (state.store.clone(), stripe.livemode(), event.clone());
    match crate::blocking(move || store_event(&store, &e, livemode, now)).await {
        Ok(stored) => {
            match stored {
                Stored::Queued => spawn_processing(state.store.clone(), stripe),
                Stored::Repeat => {}
                // By id and type only, never the payload.
                Stored::SetAside(why) => eprintln!(
                    "stripe webhook: event {} ({}) stored, not run: {why}",
                    event.id, event.kind
                ),
            }
            StatusCode::OK.into_response()
        }
        // Stripe retries anything but a 2xx: nothing is lost.
        Err(e) => e.into_response(),
    }
}

/// Start a processing run now, in the background.
pub fn spawn_processing(store: Arc<Store>, stripe: Arc<Stripe>) {
    tokio::spawn(async move {
        if let Err(e) = super::process::process_pending(store, stripe).await {
            crate::observe::error(&format!("stripe events: {e}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn a_signature_is_hmac_sha256_of_the_time_and_the_body() {
        let body = br#"{"id":"evt_1","type":"account.updated"}"#;
        let header = sign("whsec_x", NOW, body);
        assert!(header.starts_with(&format!("t={NOW},v1=")));
        assert!(verify("whsec_x", body, &header, NOW));
        assert!(!verify("whsec_y", body, &header, NOW), "another secret");
        assert!(!verify("whsec_x", b"{}", &header, NOW), "another body");
        assert!(!verify("whsec_x", body, "", NOW));
        assert!(!verify("whsec_x", body, "v1=abc", NOW), "no time");
        assert!(!verify("whsec_x", body, &format!("t={NOW}"), NOW), "no v1");
        assert!(!verify("whsec_x", body, &header[..header.len() - 1], NOW));
        // The time is signed: moving it breaks the signature.
        let moved = header.replace(&format!("t={NOW}"), &format!("t={}", NOW + 1));
        assert!(!verify("whsec_x", body, &moved, NOW));
        // Nor can a second `t` move it.
        assert!(!verify(
            "whsec_x",
            body,
            &format!("t={},{header}", NOW - 9999),
            NOW
        ));
    }

    #[test]
    fn a_stale_or_future_signature_is_refused() {
        let body = b"{}";
        let header = sign("s", NOW, body);
        assert!(verify("s", body, &header, NOW + TOLERANCE_SECS));
        assert!(!verify("s", body, &header, NOW + TOLERANCE_SECS + 1));
        assert!(verify("s", body, &header, NOW - TOLERANCE_SECS));
        assert!(!verify("s", body, &header, NOW - TOLERANCE_SECS - 1));
    }

    #[test]
    fn any_v1_may_match_and_entries_stripe_adds_are_ignored() {
        let body = b"{}";
        let good = sign("new", NOW, body);
        let v1 = good.split_once(",v1=").unwrap().1;
        let old = sign("old", NOW, body);
        let old_v1 = old.split_once(",v1=").unwrap().1;
        // A secret being rolled: one v1 per secret, in any order, among
        // entries we don't know.
        let header = format!("v0=zz, destination=we_1,t={NOW},v1={old_v1},v1={v1},payload=x");
        assert!(verify("new", body, &header, NOW));
        assert!(verify("old", body, &header, NOW));
        assert!(!verify("other", body, &header, NOW));
        // A v0 alone is not a signature.
        assert!(!verify("new", body, &format!("t={NOW},v0={v1}"), NOW));
    }

    #[test]
    fn an_event_needs_an_id_and_a_type() {
        let e = parse(
            br#"{"id":"evt_1","object":"event","type":"account.updated","account":"acct_1",
                 "created":1800000000,"livemode":true,"data":{"object":{"id":"acct_1"}}}"#,
        )
        .unwrap();
        assert_eq!(e.id, "evt_1");
        assert_eq!(e.account.as_deref(), Some("acct_1"));
        assert_eq!(e.kind, "account.updated");
        assert_eq!(e.created, 1_800_000_000);
        assert!(e.livemode);
        let own = parse(br#"{"id":"evt_2","type":"balance.available"}"#).unwrap();
        assert_eq!(own.account, None);
        assert!(!own.livemode);
        assert!(parse(br#"{"type":"account.updated"}"#).is_none());
        assert!(parse(br#"{"id":"evt_3"}"#).is_none());
        assert!(parse(b"not json").is_none());
    }
}
