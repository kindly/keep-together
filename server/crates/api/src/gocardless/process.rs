//! Handling stored webhook events, one organisation's file at a time, in
//! the order they arrived (rowid: a batch's own order too) (`gocardless-events` job, and a run straight
//! after each webhook). Each event is handled in its own transaction as
//! the system, then marked handled in `platform.db`; a crash between the
//! two handles it again, which every handler takes as a no-op (gifts by
//! payment id, statuses that don't change).
//!
//! Nothing is dropped. A retryable failure (GoCardless unreachable or
//! failing, a busy file) stops that organisation's run, so later events
//! never overtake it, and the event waits [`backoff`] (30 s doubling to an
//! hour) before its next try. After [`MAX_ATTEMPTS`] tries (about two
//! days), or at once for a failure retrying can't mend (GoCardless refused
//! the request), the event is *parked*: outcome `failed`, reported to
//! the log and Sentry, never purged, counted in `GET gocardless`
//! (`failedEvents`), and put back in the queue by an admin's `POST
//! gocardless/events/retry` ([`requeue_failed`]). A parked event no
//! longer holds up the ones behind it.
//!
//! And a sweep after each run ([`sweep`]): any regular gift of a connected
//! organisation with a mandate, no subscription and not ended gets its
//! subscription, so a fulfilled billing request never leaves one
//! collecting nothing, whatever happened to its event.
//!
//! What each event does (actions from GoCardless's event pages):
//! - billing request `fulfilled`: the mandate its mandate request made is
//!   linked, and the subscription created on it (once: the idempotency
//!   key is the regular gift's); `cancelled`: a regular gift with no
//!   mandate yet is cancelled;
//! - mandate `active`: the regular gift is active; `failed`/`blocked`: it
//!   failed; `cancelled`/`expired`: it ended; `replaced`: it follows the
//!   new mandate. A mandate we don't know yet is identified by the
//!   metadata GoCardless copies to it from our billing request (events
//!   can overtake one another), never by making its subscription;
//! - subscription `cancelled`/`finished`: it ended;
//! - payment (any action): the payment is fetched and its *current*
//!   status recorded ([`giving::regular::record_payment`]): a gift only
//!   once `confirmed`, void on a chargeback, un-void if that's cancelled.

use std::sync::Arc;
use std::time::Duration;

use contracts::{ContractError, Ctx, Source};
use giving::regular::{
    self, PaymentReport, PaymentStatus, RegularFacts, RegularStatus, end_regular_gift,
    update_mandate,
};
use rusqlite::params;
use serde_json::Value;
use store::{OrgDb, Store, TenantId};

use super::GoCardless;
use super::client::{CallError, NewSubscription};
use crate::jobs::Job;

/// Tries before an event is parked (and reported): with [`backoff`],
/// about two days of a GoCardless outage.
pub const MAX_ATTEMPTS: i64 = 50;
/// Handled events are kept this long, then purged. Parked ones are kept.
pub const KEEP_HANDLED_MS: i64 = 90 * 24 * 60 * 60 * 1000;

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
}

impl From<CallError> for Failed {
    fn from(e: CallError) -> Self {
        if e.retryable() {
            Failed::Retry(format!("gocardless {e}"))
        } else {
            Failed::Permanent(format!("gocardless {e}"))
        }
    }
}

impl From<ContractError> for Failed {
    fn from(e: ContractError) -> Self {
        match e {
            ContractError::Sqlite(e) => Failed::Retry(e.to_string()),
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
    pub resource_type: String,
    pub action: String,
    links: Value,
    details: Value,
}

impl Event {
    pub fn parse(id: &str, body: &str) -> Self {
        let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
        let text = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        Self {
            id: id.to_owned(),
            resource_type: text("resource_type"),
            action: text("action"),
            links: v.get("links").cloned().unwrap_or(Value::Null),
            details: v.get("details").cloned().unwrap_or(Value::Null),
        }
    }

    fn link(&self, name: &str) -> Option<&str> {
        self.links.get(name).and_then(Value::as_str)
    }

    fn need(&self, name: &str) -> Result<&str, Failed> {
        self.link(name)
            .ok_or_else(|| Failed::Permanent(format!("no links.{name}")))
    }

    /// GoCardless's human description of why, when there is one.
    fn reason(&self) -> Option<String> {
        self.details
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

/// One organisation's file and its token, for the handlers.
struct Org {
    db: Arc<OrgDb>,
    token: Option<String>,
}

impl Org {
    async fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T> + Send + 'static,
    ) -> Result<T, Failed> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.read(|r| f(r)))
            .await
            .map_err(|e| Failed::Retry(e.to_string()))?
            .map_err(Failed::from)
    }

    async fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Ctx) -> Result<T, ContractError> + Send + 'static,
    ) -> Result<T, Failed> {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || contracts::transact(&db, None, f))
            .await
            .map_err(|e| Failed::Retry(e.to_string()))?
            .map_err(Failed::from)
    }

    fn token(&self) -> Result<&str, Failed> {
        self.token
            .as_deref()
            .ok_or_else(|| Failed::Permanent("not_connected".into()))
    }

    async fn facts_by(
        &self,
        column: &'static str,
        value: &str,
    ) -> Result<Option<RegularFacts>, Failed> {
        let value = value.to_owned();
        self.read(move |c| regular::facts_by(c, column, &value))
            .await
    }
}

struct Pending {
    id: String,
    tenant: TenantId,
    body: String,
    attempts: i64,
    next_attempt_at: Option<i64>,
}

/// Handle every stored event not yet handled, organisation by
/// organisation. One run at a time. Answers how many were handled.
pub async fn process_pending(store: Arc<Store>, gc: Arc<GoCardless>) -> Result<usize, String> {
    let _run = gc.processing.lock().await;
    let s = store.clone();
    type Row = (String, String, String, i64, Option<i64>);
    let pending: Vec<Row> = crate::blocking(move || {
        s.platform().with_read(|c| {
            c.prepare(
                "SELECT id, tenant_id, body, attempts, next_attempt_at FROM gocardless_events
                 WHERE processed_at IS NULL AND tenant_id IS NOT NULL
                 ORDER BY tenant_id, rowid",
            )?
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store::StoreError::from)
        })
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    let s = store.clone();
    let tenants = crate::blocking(move || s.each_org())
        .await
        .map_err(|e| format!("{e:?}"))?;
    let pending: Vec<Pending> = pending
        .into_iter()
        .filter_map(|(id, tenant, body, attempts, next_attempt_at)| {
            Some(Pending {
                id,
                tenant: tenants.iter().find(|t| t.as_str() == tenant)?.clone(),
                body,
                attempts,
                next_attempt_at,
            })
        })
        .collect();

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
        let (s, g, t) = (store.clone(), gc.clone(), tenant.clone());
        let opened = crate::blocking(move || {
            let db = s.org(&t)?;
            let token = db.read(|r| g.token(r))?;
            Ok::<_, crate::ApiError>(Org { db, token })
        })
        .await;
        let org = match opened {
            Ok(org) => org,
            Err(e) => {
                errors.push(format!("{tenant}: {e:?}"));
                continue;
            }
        };
        for p in batch {
            let now = contracts::now_ms();
            // Waiting out its backoff: so do the events behind it.
            if p.next_attempt_at.is_some_and(|at| at > now) {
                break;
            }
            let event = Event::parse(&p.id, &p.body);
            let result = handle(&org, &gc, &event).await;
            let tries = p.attempts + 1;
            let park = |e: &str, why: &str| {
                crate::observe::error(&format!(
                    "gocardless event {} ({} {}) for {tenant} parked ({why}): {e}",
                    p.id, event.resource_type, event.action
                ));
            };
            // (outcome, error, next try, stop this organisation's run)
            let (outcome, error, next, stop) = match result {
                Ok(outcome) => (Some(outcome.to_owned()), None, None, false),
                Err(Failed::Permanent(e)) if e == "not_connected" => {
                    (Some("not_connected".to_owned()), None, None, false)
                }
                Err(Failed::Permanent(e)) => {
                    park(&e, "not retryable");
                    (Some("failed".to_owned()), Some(e), None, false)
                }
                Err(Failed::Retry(e)) if tries >= MAX_ATTEMPTS => {
                    park(&e, &format!("{MAX_ATTEMPTS} tries"));
                    (Some("failed".to_owned()), Some(e), None, false)
                }
                Err(Failed::Retry(e)) => (None, Some(e), Some(now + backoff(tries)), true),
            };
            if outcome.is_some() {
                handled += 1;
            }
            let (s, id) = (store.clone(), p.id.clone());
            let marked = crate::blocking(move || {
                s.platform().with_write(|tx| {
                    tx.execute(
                        "UPDATE gocardless_events SET attempts = attempts + 1, last_error = ?2,
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
            if stop {
                break;
            }
        }
    }
    if let Err(e) = sweep(&store, &gc).await {
        errors.push(e);
    }
    if errors.is_empty() {
        Ok(handled)
    } else {
        Err(errors.join("; "))
    }
}

/// Handle one event; the outcome stored with it.
async fn handle(org: &Org, gc: &GoCardless, ev: &Event) -> Result<&'static str, Failed> {
    match (ev.resource_type.as_str(), ev.action.as_str()) {
        ("billing_requests", "fulfilled") => {
            let br = ev.need("billing_request")?;
            let Some(found) = org.facts_by("billing_request_id", br).await? else {
                return Ok("unknown_resource");
            };
            fulfilled(org, gc, found).await
        }
        ("billing_requests", "cancelled") => {
            let br = ev.need("billing_request")?;
            let Some(found) = org.facts_by("billing_request_id", br).await? else {
                return Ok("unknown_resource");
            };
            if found.mandate.mandate_id.is_some() {
                return Ok("ignored");
            }
            let reason = ev
                .reason()
                .or_else(|| Some("The donor’s sign-up was cancelled".into()));
            end(org, &found.id, RegularStatus::Cancelled, reason).await
        }
        ("mandates", action) => {
            let md = ev.need("mandate")?;
            let Some(found) = identify_mandate(org, gc, md).await? else {
                return Ok("unknown_resource");
            };
            match action {
                "active" => {
                    let id = found.id.clone();
                    org.write(move |ctx| {
                        update_mandate(ctx, &id, None, Source::System, None, |m| {
                            if m.status() == RegularStatus::Pending {
                                m.status = Some(RegularStatus::Active);
                            }
                        })
                    })
                    .await?;
                    // Whatever became of its billing request's event.
                    ensure_subscription(org, gc, &found.id).await
                }
                "failed" | "blocked" => {
                    end(org, &found.id, RegularStatus::Failed, ev.reason()).await
                }
                "cancelled" | "expired" => {
                    end(org, &found.id, RegularStatus::Cancelled, ev.reason()).await
                }
                "replaced" => {
                    let new = ev.need("new_mandate")?.to_owned();
                    let id = found.id.clone();
                    org.write(move |ctx| {
                        update_mandate(ctx, &id, None, Source::System, None, |m| {
                            m.mandate_id = Some(new)
                        })
                    })
                    .await?;
                    Ok("done")
                }
                _ => Ok("ignored"),
            }
        }
        ("subscriptions", "cancelled" | "finished") => {
            let sb = ev.need("subscription")?;
            let Some(found) = org.facts_by("subscription_id", sb).await? else {
                return Ok("unknown_resource");
            };
            end(org, &found.id, RegularStatus::Cancelled, ev.reason()).await
        }
        ("payments", _) => payment(org, gc, ev).await,
        _ => Ok("ignored"),
    }
}

async fn end(
    org: &Org,
    id: &str,
    status: RegularStatus,
    reason: Option<String>,
) -> Result<&'static str, Failed> {
    let id = id.to_owned();
    org.write(move |ctx| end_regular_gift(ctx, &id, None, status, reason, Source::System))
        .await?;
    Ok("done")
}

/// The regular gift on mandate `md`, by its id here; the first time we
/// hear of the mandate (its event overtook the billing request's), by the
/// regular gift its metadata names (one `GET mandates/{id}`: the billing
/// request's mandate request carries our id, and GoCardless copies it to
/// the mandate), which is then linked to it. Only identifies: never
/// makes a subscription, so a terminal mandate event always reaches the
/// regular gift's status, whatever came first.
async fn identify_mandate(
    org: &Org,
    gc: &GoCardless,
    md: &str,
) -> Result<Option<RegularFacts>, Failed> {
    if let Some(found) = org.facts_by("mandate_id", md).await? {
        return Ok(Some(found));
    }
    let Some(token) = org.token.as_deref() else {
        return Ok(None);
    };
    let mandate = gc.api.get_mandate(token, md).await?;
    let Some(id) = mandate.regular_gift else {
        return Ok(None);
    };
    let Some(found) = org.facts_by("id", &id).await? else {
        return Ok(None);
    };
    if found.mandate.mandate_id.is_some() {
        // Linked to another mandate already ("replaced" moves it).
        return Ok(None);
    }
    link(org, &id, md).await?;
    org.facts_by("id", &id).await
}

/// Record `md` as the regular gift's mandate, unless it has one.
async fn link(org: &Org, id: &str, md: &str) -> Result<(), Failed> {
    let (id, md) = (id.to_owned(), md.to_owned());
    org.write(move |ctx| {
        update_mandate(ctx, &id, None, Source::System, None, |m| {
            if m.mandate_id.is_none() {
                m.mandate_id = Some(md)
            }
        })
    })
    .await?;
    Ok(())
}

const MONTHS: [&str; 12] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
];

/// A billing request fulfilled: link the mandate its mandate request made
/// (asked of GoCardless), then make the subscription.
async fn fulfilled(
    org: &Org,
    gc: &GoCardless,
    found: RegularFacts,
) -> Result<&'static str, Failed> {
    if found.mandate.mandate_id.is_none() {
        let br = found.mandate.billing_request_id.clone().unwrap_or_default();
        let request = gc.api.get_billing_request(org.token()?, &br).await?;
        let Some(md) = request.mandate else {
            return Ok("ignored");
        };
        link(org, &found.id, &md).await?;
    }
    ensure_subscription(org, gc, &found.id).await
}

/// Make the regular gift's subscription if it has a mandate, none yet,
/// and hasn't ended. Read fresh, not from the caller's snapshot, and
/// again when it is recorded; created once whatever the retries (the
/// idempotency key is the regular gift's).
async fn ensure_subscription(org: &Org, gc: &GoCardless, id: &str) -> Result<&'static str, Failed> {
    let Some(found) = org.facts_by("id", id).await? else {
        return Ok("unknown_resource");
    };
    let (Some(mandate), None) = (&found.mandate.mandate_id, &found.mandate.subscription_id) else {
        return Ok("done");
    };
    if found.mandate.status().is_ended() {
        return Ok("done");
    }
    let t = &found.terms;
    let name = format!("Regular gift {}", giving::format_pence(t.amount));
    let subscription = gc
        .api
        .create_subscription(
            org.token()?,
            &NewSubscription {
                mandate,
                amount: t.amount,
                interval_unit: t.frequency.as_str(),
                day_of_month: t.day_of_month,
                month: t
                    .month
                    .and_then(|m| MONTHS.get(usize::from(m).wrapping_sub(1)).copied()),
                name: &name,
                regular_gift: id,
            },
        )
        .await?;
    // Checked again in the write's own transaction: if the regular gift
    // ended while GoCardless was answering (staff cancelled, the mandate
    // went), the subscription is recorded and cancelled at once.
    let (rid, sb) = (id.to_owned(), subscription.clone());
    let ended = org
        .write(move |ctx| {
            let now = regular::facts(ctx.tx.read(), &rid)?.ok_or(ContractError::NotFound)?;
            update_mandate(ctx, &rid, None, Source::System, None, |m| {
                m.subscription_id = Some(sb)
            })?;
            Ok(now.mandate.status().is_ended())
        })
        .await?;
    if ended {
        gc.api
            .cancel_subscription(org.token()?, &subscription)
            .await?;
    }
    Ok("done")
}

/// A payment event: fetch the payment and record its current status.
async fn payment(org: &Org, gc: &GoCardless, ev: &Event) -> Result<&'static str, Failed> {
    let pm = ev.need("payment")?;
    let p = gc.api.get_payment(org.token()?, pm).await?;
    let mut found = None;
    if let Some(sb) = &p.subscription {
        found = org.facts_by("subscription_id", sb).await?;
    }
    if found.is_none()
        && let Some(md) = &p.mandate
    {
        found = identify_mandate(org, gc, md).await?;
    }
    let Some(found) = found else {
        return Ok("unknown_resource");
    };
    if p.currency != "GBP" {
        return Ok("ignored");
    }
    let status = match p.status.as_str() {
        "confirmed" | "paid_out" => PaymentStatus::Confirmed,
        "failed" => PaymentStatus::Failed,
        "charged_back" => PaymentStatus::ChargedBack,
        "cancelled" | "customer_approval_denied" => PaymentStatus::Cancelled,
        _ => PaymentStatus::Pending,
    };
    let reason = match ev.action.as_str() {
        "failed" | "charged_back" | "cancelled" | "late_failure_settled" => ev.reason(),
        _ => None,
    };
    let report = PaymentReport {
        payment_id: p.id,
        amount: p.amount,
        charge_date: p.charge_date,
        status,
        reason,
    };
    let id = found.id;
    org.write(move |ctx| regular::record_payment(ctx, &id, report))
        .await?;
    Ok("done")
}

/// Every connected organisation's regular gifts with a mandate, no
/// subscription and not ended get their subscription. Failures are
/// reported and tried again on the next run.
async fn sweep(store: &Arc<Store>, gc: &Arc<GoCardless>) -> Result<(), String> {
    let s = store.clone();
    let connected: Vec<TenantId> = crate::blocking(move || {
        let ids: Vec<String> = s.platform().with_read(|c| {
            c.prepare("SELECT tenant_id FROM gocardless_connections")?
                .query_map([], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()
                .map_err(store::StoreError::from)
        })?;
        Ok::<_, crate::ApiError>(
            s.each_org()?
                .into_iter()
                .filter(|t| ids.iter().any(|i| i == t.as_str()))
                .collect(),
        )
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    let mut errors = Vec::new();
    for tenant in connected {
        let (s, g, t) = (store.clone(), gc.clone(), tenant.clone());
        let opened = crate::blocking(move || {
            let db = s.org(&t)?;
            let token = db.read(|r| g.token(r))?;
            Ok::<_, crate::ApiError>(Org { db, token })
        })
        .await;
        let org = match opened {
            Ok(org) => org,
            Err(e) => {
                errors.push(format!("{tenant}: {e:?}"));
                continue;
            }
        };
        let waiting: Vec<String> = match org
            .read(|c| {
                c.prepare(
                    "SELECT id FROM regular_gifts WHERE mandate_id IS NOT NULL
                         AND subscription_id IS NULL AND status IN ('pending', 'active')",
                )?
                .query_map([], |r| r.get(0))?
                .collect()
            })
            .await
        {
            Ok(w) => w,
            Err(e) => {
                errors.push(format!("{tenant}: {e:?}"));
                continue;
            }
        };
        for id in waiting {
            if let Err(e) = ensure_subscription(&org, gc, &id).await {
                errors.push(format!("{tenant}: subscription for {id}: {e:?}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// How many of `tenant`'s events are parked.
pub fn failed_count(store: &Store, tenant: &TenantId) -> Result<i64, store::StoreError> {
    store.platform().with_read(|c| {
        Ok(c.query_row(
            "SELECT count(*) FROM gocardless_events WHERE tenant_id = ?1 AND outcome = 'failed'",
            [tenant.as_str()],
            |r| r.get(0),
        )?)
    })
}

/// Put `tenant`'s parked events back in the queue, tries reset. How many.
pub fn requeue_failed(store: &Store, tenant: &TenantId) -> Result<usize, store::StoreError> {
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "UPDATE gocardless_events SET outcome = NULL, processed_at = NULL, attempts = 0,
                 next_attempt_at = NULL
             WHERE tenant_id = ?1 AND outcome = 'failed'",
            [tenant.as_str()],
        )?)
    })
}

/// Forget handled events older than [`KEEP_HANDLED_MS`]; parked ones stay
/// until handled.
pub fn purge(store: &Store, now: i64) -> Result<usize, store::StoreError> {
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "DELETE FROM gocardless_events
             WHERE processed_at IS NOT NULL AND processed_at < ?1 AND outcome <> 'failed'",
            [now - KEEP_HANDLED_MS],
        )?)
    })
}

/// `gocardless-events`: handle what a webhook run left (a retry, a crash),
/// and purge old events.
pub struct EventsJob {
    pub store: Arc<Store>,
    pub gc: Arc<GoCardless>,
}

impl Job for EventsJob {
    fn name(&self) -> &'static str {
        "gocardless-events"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(30)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(5)
    }
    fn run(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            process_pending(self.store.clone(), self.gc.clone()).await?;
            let store = self.store.clone();
            tokio::task::spawn_blocking(move || purge(&store, contracts::now_ms()))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}
