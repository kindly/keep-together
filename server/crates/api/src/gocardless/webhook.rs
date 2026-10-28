//! `POST /api/gocardless/webhook`: GoCardless's events for every connected
//! organisation, on one platform route
//! (<https://docs.gocardless.com/docs/api-reference/webhooks>).
//!
//! The raw body's HMAC-SHA256 (hex, keyed with the partner app's webhook
//! secret) must match `Webhook-Signature`, compared in constant time, or
//! the answer is `498` (GoCardless's "token invalid": logged by them, not
//! retried) and nothing is read. A signed batch is stored event by event
//! in `platform.db` under the event id (a repeat is a no-op), each routed
//! by `links.organisation` to our organisation; one we don't know is
//! stored as handled and logged by id, never with its payload. The answer
//! is `204` straight away (GoCardless waits 10 s at most) and a
//! processing run starts in the background ([`super::process`]).

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

use super::GoCardless;
use crate::AppState;

pub const SIGNATURE_HEADER: &str = "Webhook-Signature";

/// GoCardless's "token invalid", for a bad signature.
pub fn invalid_token() -> StatusCode {
    StatusCode::from_u16(498).expect("498 is a valid status")
}

/// The hex HMAC-SHA256 of `body` under `secret` (also how the fake signs).
pub fn sign(secret: &str, body: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(body);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Whether `signature` (hex) is `body`'s, in constant time.
pub fn verify(secret: &str, body: &[u8], signature: &str) -> bool {
    let signature = signature.trim();
    if signature.len() != 64 || !signature.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let bytes: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&signature[2 * i..2 * i + 2], 16).unwrap_or(0))
        .collect();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key");
    mac.update(body);
    mac.verify_slice(&bytes).is_ok()
}

/// One event as stored: what routing and processing need.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Incoming {
    pub id: String,
    pub organisation: Option<String>,
    pub resource_type: String,
    pub action: String,
    pub body: String,
}

/// The events of a signed batch (`{"events": [...]}`); `None` if it isn't
/// one. An event without an id, type or action is skipped.
pub fn parse(body: &[u8]) -> Option<Vec<Incoming>> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let events = v.get("events")?.as_array()?;
    Some(
        events
            .iter()
            .filter_map(|e| {
                let text = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
                Some(Incoming {
                    id: text("id")?,
                    organisation: e
                        .pointer("/links/organisation")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    resource_type: text("resource_type")?,
                    action: text("action")?,
                    body: e.to_string(),
                })
            })
            .collect(),
    )
}

/// What [`store_events`] did with a batch.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Stored {
    /// New events for a connected organisation, to process.
    pub queued: usize,
    /// Seen before: nothing done.
    pub repeats: usize,
    /// For a GoCardless organisation not connected here: stored, ignored.
    pub unknown: Vec<String>,
}

/// Store `events` in `platform.db`, each routed to its organisation, in
/// one transaction.
pub fn store_events(
    store: &Store,
    events: &[Incoming],
    now: i64,
) -> Result<Stored, store::StoreError> {
    store.platform().with_write(|tx| {
        let mut out = Stored::default();
        for e in events {
            // A read that fails fails the batch (a 5xx: GoCardless sends
            // it again), never reads as an unknown organisation.
            let tenant: Option<String> = match &e.organisation {
                Some(org) => tx
                    .query_row(
                        "SELECT tenant_id FROM gocardless_connections WHERE organisation_id = ?1",
                        [org],
                        |r| r.get(0),
                    )
                    .optional()?,
                None => None,
            };
            let (processed_at, outcome) = match tenant {
                Some(_) => (None, None),
                None => (Some(now), Some("unknown_organisation")),
            };
            let added = tx.execute(
                "INSERT OR IGNORE INTO gocardless_events (id, organisation_id, tenant_id,
                     resource_type, action, body, received_at, processed_at, outcome)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    e.id,
                    e.organisation,
                    tenant,
                    e.resource_type,
                    e.action,
                    e.body,
                    now,
                    processed_at,
                    outcome
                ],
            )?;
            match (added, &tenant) {
                (0, _) => out.repeats += 1,
                (_, Some(_)) => out.queued += 1,
                (_, None) => out.unknown.push(e.id.clone()),
            }
        }
        Ok(out)
    })
}

/// The route.
pub async fn receive(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(gc) = state.gocardless.clone() else {
        return crate::ApiError::NotFound.into_response();
    };
    let signature = headers
        .get(SIGNATURE_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !verify(gc.webhook_secret().expose(), &body, signature) {
        eprintln!("gocardless webhook: bad signature, refused");
        return invalid_token().into_response();
    }
    let Some(events) = parse(&body) else {
        eprintln!("gocardless webhook: a signed body that isn't a batch of events");
        return StatusCode::BAD_REQUEST.into_response();
    };
    let store = state.store.clone();
    let now = contracts::now_ms();
    let stored = crate::blocking(move || store_events(&store, &events, now)).await;
    match stored {
        Ok(stored) => {
            for id in &stored.unknown {
                eprintln!(
                    "gocardless webhook: event {id} is for an organisation not connected here: ignored"
                );
            }
            if stored.queued > 0 {
                spawn_processing(state.store.clone(), gc);
            }
            StatusCode::NO_CONTENT.into_response()
        }
        // GoCardless retries a 5xx: nothing is lost.
        Err(e) => e.into_response(),
    }
}

/// Start a processing run now, in the background.
pub fn spawn_processing(store: Arc<Store>, gc: Arc<GoCardless>) {
    tokio::spawn(async move {
        if let Err(e) = super::process::process_pending(store, gc).await {
            crate::observe::error(&format!("gocardless events: {e}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_are_hmac_sha256_hex_and_checked_whole() {
        let body = br#"{"events":[]}"#;
        let sig = sign("secret", body);
        assert_eq!(sig.len(), 64);
        assert!(verify("secret", body, &sig));
        assert!(verify("secret", body, &sig.to_uppercase()));
        assert!(!verify("other", body, &sig));
        assert!(!verify("secret", br#"{"events":[1]}"#, &sig));
        assert!(!verify("secret", body, &sig[..63]));
        assert!(!verify("secret", body, ""));
        assert!(!verify("secret", body, &format!("{}zz", &sig[..62])));
    }

    #[test]
    fn a_batch_is_events_with_id_type_and_action() {
        let events = parse(
            br#"{"events":[
                {"id":"EV1","resource_type":"payments","action":"confirmed",
                 "links":{"payment":"PM1","organisation":"OR1"}},
                {"id":"EV2","resource_type":"mandates"},
                {"id":"EV3","resource_type":"mandates","action":"active","links":{}}
            ]}"#,
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].organisation.as_deref(), Some("OR1"));
        assert_eq!(events[1].organisation, None);
        assert!(parse(b"[]").is_none());
        assert!(parse(b"not json").is_none());
    }
}
