//! Handling stored webhook events, one organisation at a time, in the
//! order they arrived (rowid) (`stripe-events` job, and a run straight
//! after each webhook). Each event is handled, then marked handled in
//! `platform.db`; a crash between the two handles it again, which every
//! handler must take as a no-op.
//!
//! Stripe doesn't promise events in order, so no handler trusts an
//! event's own snapshot: it reads what the event is about from Stripe as
//! it is *now* and records that. Any order of the same events ends in
//! the same state.
//!
//! Nothing is dropped. A retryable failure (Stripe unreachable or
//! failing, a busy file) stops that organisation's run, so later events
//! never overtake it, and the event waits [`backoff`] (30 s doubling to an
//! hour) before its next try. After [`MAX_ATTEMPTS`] tries (about two
//! days), or at once for a failure retrying can't mend, the event is
//! *parked*: outcome `failed`, reported to the log and Sentry, never
//! purged, counted in `GET stripe` (`failedEvents`), and put back in the
//! queue by [`requeue_failed`] (`keep stripe requeue <slug>`). A parked
//! event no longer holds up the ones behind it.
//!
//! One failure is neither: Stripe refusing the *platform's key* (a 401,
//! or a 403 for a permission the restricted key lacks). That is our
//! fault, not the event's, and it hits every organisation at once, so
//! such an event is never parked: it stays queued, tried again after
//! each backoff, until the key is put right ([`Failed::Platform`]).
//!
//! An event is run only for the organisation connected to its account
//! *now*: one stored for an organisation that has since disconnected (or
//! holds another account) is set aside untouched (`not_connected`) and
//! requeued if it connects that account again
//! ([`super::accounts::requeue_set_aside`]).
//!
//! What each event does ([`handle`]):
//! - `account.updated`: the account is read from Stripe and its
//!   onboarding state stored ([`super::accounts::set_status`]);
//! - `account.application.deauthorized`: the organisation removed us in
//!   its Stripe Dashboard: it is disconnected here, once Stripe itself
//!   says the account is no longer ours (the event alone isn't believed);
//! - a Checkout Session's, a PaymentIntent's, a refund's or a dispute's
//!   ([`super::payments`]): the payment is read from Stripe and recorded,
//!   with everything that follows from it, in one org-file transaction;
//! - anything else: `ignored`.
//!
//! Events routed to an organisation that no longer exists are closed
//! (`no_organisation`) instead of waiting for ever. Events set aside for
//! a reconnect (`not_connected`) are kept [`KEEP_SET_ASIDE_MS`] (30 days,
//! the human's decision of 2026-11-21: as long as Stripe itself keeps
//! events, so the catch-up can still read whatever a reconnect needs),
//! then purged with the rest.

use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde_json::Value;
use store::{Store, TenantId};

use super::client::{ACCOUNT_DEAUTHORIZED, ACCOUNT_UPDATED, CallError};
use super::{Stripe, accounts};
use crate::jobs::Job;

/// Tries before an event is parked (and reported): with [`backoff`],
/// about two days of a Stripe outage.
pub const MAX_ATTEMPTS: i64 = 50;
/// Handled events are kept this long, then purged (Stripe itself keeps
/// 30 days; the catch-up reads inside that). Parked ones are kept.
pub const KEEP_HANDLED_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// Events set aside because their organisation had disconnected
/// (`not_connected`) are kept this long for a reconnect to replay, then
/// purged: Stripe keeps events 30 days itself.
pub const KEEP_SET_ASIDE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// How long an event waits after its `attempts`-th failed try: 30 s,
/// doubling, at most an hour.
pub fn backoff(attempts: i64) -> i64 {
    let doublings = (attempts.max(1) - 1).min(7) as u32;
    (30_000i64 << doublings).min(60 * 60 * 1000)
}

/// Why an event wasn't handled.
#[derive(Debug)]
pub enum Failed {
    /// Try again on the next run.
    Retry(String),
    /// Give up: reported.
    Permanent(String),
    /// Stripe refuses the platform's key (rolled, or missing a
    /// permission): our fault, not the event's. Tried again after the
    /// backoff however many times it takes, never parked; reported.
    Platform(String),
}

impl From<CallError> for Failed {
    fn from(e: CallError) -> Self {
        if e.platform_key() {
            Failed::Platform(format!("stripe {e}"))
        } else if e.retryable() {
            Failed::Retry(format!("stripe {e}"))
        } else {
            Failed::Permanent(format!("stripe {e}"))
        }
    }
}

impl From<contracts::ContractError> for Failed {
    fn from(e: contracts::ContractError) -> Self {
        match e {
            contracts::ContractError::Sqlite(e) => Failed::Retry(e.to_string()),
            other => Failed::Permanent(other.to_string()),
        }
    }
}

impl From<rusqlite::Error> for Failed {
    fn from(e: rusqlite::Error) -> Self {
        Failed::Retry(e.to_string())
    }
}

impl From<crate::ApiError> for Failed {
    fn from(e: crate::ApiError) -> Self {
        Failed::Retry(format!("{e:?}"))
    }
}

/// A stored event, parsed.
#[derive(Clone, Debug)]
pub struct Event {
    pub id: String,
    /// Stripe's `type` (`account.updated`, …).
    pub kind: String,
    /// The connected account it came for: the one its organisation holds.
    pub account: String,
    /// `data.object`: the resource as it was when the event was made.
    /// Good for its id; for its state, ask Stripe (module docs).
    pub object: Value,
}

impl Event {
    pub fn parse(id: &str, kind: &str, account: &str, body: &str) -> Self {
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        Self {
            id: id.to_owned(),
            kind: kind.to_owned(),
            account: account.to_owned(),
            object: v.pointer("/data/object").cloned().unwrap_or(Value::Null),
        }
    }
}

struct Pending {
    id: String,
    tenant: TenantId,
    account: Option<String>,
    kind: String,
    body: String,
    attempts: i64,
    next_attempt_at: Option<i64>,
}

/// Handle every stored event not yet handled, organisation by
/// organisation. One run at a time. Answers how many were handled.
pub async fn process_pending(store: Arc<Store>, stripe: Arc<Stripe>) -> Result<usize, String> {
    let _run = stripe.processing.lock().await;
    let s = store.clone();
    type Row = (
        String,
        String,
        Option<String>,
        String,
        String,
        i64,
        Option<i64>,
    );
    let pending: Vec<Row> = crate::blocking(move || {
        s.platform().with_read(|c| {
            c.prepare(
                "SELECT id, tenant_id, account_id, type, body, attempts, next_attempt_at
                 FROM stripe_events
                 WHERE processed_at IS NULL AND tenant_id IS NOT NULL
                 ORDER BY tenant_id, rowid",
            )?
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store::StoreError::from)
        })
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    if pending.is_empty() {
        return Ok(0);
    }
    let s = store.clone();
    let tenants = crate::blocking(move || s.each_org())
        .await
        .map_err(|e| format!("{e:?}"))?;
    // An organisation that no longer exists: its events are closed, not
    // left pending for ever.
    let mut vanished: Vec<String> = Vec::new();
    let pending: Vec<Pending> = pending
        .into_iter()
        .filter_map(
            |(id, tenant, account, kind, body, attempts, next_attempt_at)| {
                let Some(tenant) = tenants.iter().find(|t| t.as_str() == tenant) else {
                    vanished.push(id);
                    return None;
                };
                Some(Pending {
                    id,
                    tenant: tenant.clone(),
                    account,
                    kind,
                    body,
                    attempts,
                    next_attempt_at,
                })
            },
        )
        .collect();
    if !vanished.is_empty() {
        let s = store.clone();
        crate::blocking(move || {
            s.platform().with_write(|tx| {
                for id in &vanished {
                    tx.execute(
                        "UPDATE stripe_events SET outcome = 'no_organisation', processed_at = ?2
                         WHERE id = ?1 AND processed_at IS NULL",
                        params![id, contracts::now_ms()],
                    )?;
                }
                Ok::<_, store::StoreError>(())
            })
        })
        .await
        .map_err(|e| format!("{e:?}"))?;
    }

    let mut handled = 0;
    let mut errors = Vec::new();
    let mut i = 0;
    while i < pending.len() {
        let tenant = pending[i].tenant.clone();
        let end = pending[i..]
            .iter()
            .position(|p| p.tenant != tenant)
            .map_or(pending.len(), |n| i + n);
        let batch = &pending[i..end];
        i = end;
        // The account this organisation is connected to now. Events for
        // any other (it disconnected since they came) are set aside
        // untouched: never run against an organisation that doesn't hold
        // their account.
        let (s, t) = (store.clone(), tenant.clone());
        let current = match crate::blocking(move || accounts::connected_account(&s, &t)).await {
            Ok(c) => c,
            Err(e) => {
                errors.push(format!("{tenant}: {e:?}"));
                continue;
            }
        };
        let foreign: Vec<String> = batch
            .iter()
            .filter(|p| current.is_none() || p.account != current)
            .map(|p| p.id.clone())
            .collect();
        if !foreign.is_empty() {
            let s = store.clone();
            let set_aside = crate::blocking(move || {
                s.platform().with_write(|tx| {
                    for id in &foreign {
                        tx.execute(
                            "UPDATE stripe_events SET outcome = 'not_connected',
                                 processed_at = ?2 WHERE id = ?1",
                            params![id, contracts::now_ms()],
                        )?;
                    }
                    Ok::<_, store::StoreError>(())
                })
            })
            .await;
            if let Err(e) = set_aside {
                errors.push(format!("{tenant}: {e:?}"));
                continue;
            }
        }
        let Some(account) = current else {
            continue;
        };
        for p in batch
            .iter()
            .filter(|p| p.account.as_deref() == Some(&account))
        {
            let now = contracts::now_ms();
            // Waiting out its backoff: so do the events behind it.
            if p.next_attempt_at.is_some_and(|at| at > now) {
                break;
            }
            let event = Event::parse(&p.id, &p.kind, &account, &p.body);
            let result = handle(&store, &stripe, &tenant, &event).await;
            let tries = p.attempts + 1;
            let park = |e: &str, why: &str| {
                crate::observe::error(&format!(
                    "stripe event {} ({}) for {tenant} parked ({why}): {e}",
                    p.id, p.kind
                ));
            };
            // (outcome, error, next try, stop this organisation's run)
            let (outcome, error, next, stop) = match result {
                Ok(outcome) => (Some(outcome.to_owned()), None, None, false),
                Err(Failed::Permanent(e)) => {
                    park(&e, "not retryable");
                    (Some("failed".to_owned()), Some(e), None, false)
                }
                Err(Failed::Retry(e)) if tries >= MAX_ATTEMPTS => {
                    park(&e, &format!("{MAX_ATTEMPTS} tries"));
                    (Some("failed".to_owned()), Some(e), None, false)
                }
                Err(Failed::Retry(e)) => (None, Some(e), Some(now + backoff(tries)), true),
                Err(Failed::Platform(e)) => {
                    // Once per event (its first try), not once per retry.
                    if p.attempts == 0 {
                        crate::observe::error(&format!(
                            "stripe event {} ({}) for {tenant} is waiting: Stripe refuses \
                             the platform's key ({e}); it is retried, never parked",
                            p.id, p.kind
                        ));
                    }
                    (None, Some(e), Some(now + backoff(tries)), true)
                }
            };
            if outcome.is_some() {
                handled += 1;
            }
            let disconnected = outcome.as_deref() == Some("disconnected");
            let (s, id) = (store.clone(), p.id.clone());
            let marked = crate::blocking(move || {
                s.platform().with_write(|tx| {
                    tx.execute(
                        "UPDATE stripe_events SET attempts = attempts + 1, last_error = ?2,
                             outcome = ?3, next_attempt_at = ?5,
                             processed_at = CASE WHEN ?3 IS NULL THEN NULL ELSE ?4 END
                         WHERE id = ?1",
                        params![id, error, outcome, now, next],
                    )?;
                    Ok::<_, store::StoreError>(())
                })
            })
            .await;
            if let Err(e) = marked {
                errors.push(format!("{tenant}: marking {}: {e:?}", p.id));
                break;
            }
            // Disconnected by this very event: the rest are no longer
            // this organisation's to run (the next run sets them aside).
            if stop || disconnected {
                break;
            }
        }
    }
    if errors.is_empty() {
        Ok(handled)
    } else {
        Err(errors.join("; "))
    }
}

/// Handle one event of `tenant`'s connected account; the outcome stored
/// with it.
async fn handle(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    tenant: &TenantId,
    ev: &Event,
) -> Result<&'static str, Failed> {
    match ev.kind.as_str() {
        ACCOUNT_UPDATED => refresh_account(store, stripe, tenant, &ev.account).await,
        ACCOUNT_DEAUTHORIZED => {
            // The event says the owner removed us; Stripe's own answer
            // for the account decides (an event is never believed alone).
            match stripe.api.get_account(&ev.account).await {
                Err(e) if e.account_gone() => {}
                Err(e) => return Err(e.into()),
                Ok(_) => {
                    crate::observe::warning(&format!(
                        "stripe: an event says {tenant}'s account {} removed us, but \
                         Stripe still answers for it: left connected",
                        ev.account
                    ));
                    return Ok("ignored");
                }
            }
            let (s, t) = (store.clone(), tenant.clone());
            crate::blocking(move || accounts::disconnect(&s, &t, contracts::now_ms())).await?;
            crate::observe::warning(&format!(
                "stripe: {tenant}'s account {} removed us from its Stripe Dashboard: \
                 disconnected here",
                ev.account
            ));
            Ok("disconnected")
        }
        kind if super::payments::handles(kind) => {
            super::payments::handle(store, stripe, tenant, ev).await
        }
        _ => Ok("ignored"),
    }
}

/// Read `account` from Stripe and store its onboarding state. An account
/// Stripe says isn't ours any more changes nothing here.
async fn refresh_account(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    tenant: &TenantId,
    account: &str,
) -> Result<&'static str, Failed> {
    let now_is = match stripe.api.get_account(account).await {
        Ok(a) => a,
        Err(e) if e.account_gone() => {
            crate::observe::warning(&format!(
                "stripe: {tenant}'s account {account} is no longer ours at Stripe"
            ));
            return Ok("account_gone");
        }
        Err(e) => return Err(e.into()),
    };
    let s = store.clone();
    crate::blocking(move || {
        s.platform().with_write(|tx| {
            accounts::set_status(tx, &now_is, contracts::now_ms())?;
            Ok::<_, store::StoreError>(())
        })
    })
    .await?;
    Ok("done")
}

/// How many of `tenant`'s events are parked.
pub fn failed_count(store: &Store, tenant: &TenantId) -> Result<i64, store::StoreError> {
    store.platform().with_read(|c| {
        Ok(c.query_row(
            "SELECT count(*) FROM stripe_events WHERE tenant_id = ?1 AND outcome = 'failed'",
            [tenant.as_str()],
            |r| r.get(0),
        )?)
    })
}

/// Put `tenant`'s parked events back in the queue, tries reset. How many.
pub fn requeue_failed(store: &Store, tenant: &TenantId) -> Result<usize, store::StoreError> {
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "UPDATE stripe_events SET outcome = NULL, processed_at = NULL, attempts = 0,
                 next_attempt_at = NULL
             WHERE tenant_id = ?1 AND outcome = 'failed'",
            [tenant.as_str()],
        )?)
    })
}

/// Forget handled events older than [`KEEP_HANDLED_MS`], and those set
/// aside for a reconnect (`not_connected`) older than
/// [`KEEP_SET_ASIDE_MS`]; parked ones stay.
pub fn purge(store: &Store, now: i64) -> Result<usize, store::StoreError> {
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "DELETE FROM stripe_events
             WHERE processed_at IS NOT NULL
               AND ((processed_at < ?1 AND outcome NOT IN ('failed', 'not_connected'))
                 OR (processed_at < ?2 AND outcome = 'not_connected'))",
            params![now - KEEP_HANDLED_MS, now - KEEP_SET_ASIDE_MS],
        )?)
    })
}

/// `stripe-events`: handle what a webhook run left (a retry, a crash),
/// and purge old events.
pub struct EventsJob {
    pub store: Arc<Store>,
    pub stripe: Arc<Stripe>,
}

impl Job for EventsJob {
    fn name(&self) -> &'static str {
        "stripe-events"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(30)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(5)
    }
    fn run(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            process_pending(self.store.clone(), self.stripe.clone()).await?;
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || purge(&store, contracts::now_ms()))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_doubles_from_thirty_seconds_to_an_hour() {
        assert_eq!(backoff(1), 30_000);
        assert_eq!(backoff(2), 60_000);
        assert_eq!(backoff(7), 1_920_000);
        assert_eq!(backoff(8), 3_600_000);
        assert_eq!(backoff(50), 3_600_000);
    }

    #[test]
    fn an_event_carries_its_object() {
        let e = Event::parse(
            "evt_1",
            "account.updated",
            "acct_1",
            r#"{"id":"evt_1","data":{"object":{"id":"acct_1","charges_enabled":true}}}"#,
        );
        assert_eq!(e.object["id"], "acct_1");
        assert_eq!(Event::parse("e", "t", "a", "nope").object, Value::Null);
    }
}
