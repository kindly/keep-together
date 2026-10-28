//! Handling stored webhook events, one organisation's file at a time, in
//! the order they arrived (rowid: a batch's own order too) (`gocardless-events` job, and a run straight
//! after each webhook). Each event is handled in its own transaction as
//! the system, then marked handled in `platform.db`; a crash between the
//! two handles it again, which every handler takes as a no-op (gifts by
//! payment id, statuses that don't change). A retryable failure (GoCardless
//! unreachable or failing) stops that organisation's run, so later events
//! never overtake it, and is retried on the next run, up to
//! [`MAX_ATTEMPTS`]; anything else is marked failed and reported.
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

/// Tries before an event is given up on (and reported).
pub const MAX_ATTEMPTS: i64 = 10;
/// Handled events are kept this long, then purged.
pub const KEEP_HANDLED_MS: i64 = 90 * 24 * 60 * 60 * 1000;

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
}

/// Handle every stored event not yet handled, organisation by
/// organisation. One run at a time. Answers how many were handled.
pub async fn process_pending(store: Arc<Store>, gc: Arc<GoCardless>) -> Result<usize, String> {
    let _run = gc.processing.lock().await;
    let s = store.clone();
    let pending: Vec<(String, String, String, i64)> = crate::blocking(move || {
        s.platform().with_read(|c| {
            c.prepare(
                "SELECT id, tenant_id, body, attempts FROM gocardless_events
                 WHERE processed_at IS NULL AND tenant_id IS NOT NULL
                 ORDER BY tenant_id, rowid",
            )?
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
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
        .filter_map(|(id, tenant, body, attempts)| {
            Some(Pending {
                id,
                tenant: tenants.iter().find(|t| t.as_str() == tenant)?.clone(),
                body,
                attempts,
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
            let event = Event::parse(&p.id, &p.body);
            let result = handle(&org, &gc, &event).await;
            let (outcome, error, stop) = match result {
                Ok(outcome) => (Some(outcome.to_owned()), None, false),
                Err(Failed::Permanent(e)) if e == "not_connected" => {
                    (Some("not_connected".to_owned()), None, false)
                }
                Err(Failed::Permanent(e)) => {
                    crate::observe::error(&format!(
                        "gocardless event {} ({} {}) for {tenant}: {e}",
                        p.id, event.resource_type, event.action
                    ));
                    (Some("failed".to_owned()), Some(e), false)
                }
                Err(Failed::Retry(e)) if p.attempts + 1 >= MAX_ATTEMPTS => {
                    crate::observe::error(&format!(
                        "gocardless event {} for {tenant}: given up after {MAX_ATTEMPTS} tries: {e}",
                        p.id
                    ));
                    (Some("failed".to_owned()), Some(e), false)
                }
                Err(Failed::Retry(e)) => (None, Some(e), true),
            };
            if outcome.is_some() {
                handled += 1;
            }
            let (s, id) = (store.clone(), p.id.clone());
            let now = contracts::now_ms();
            let marked = crate::blocking(move || {
                s.platform().with_write(|tx| {
                    tx.execute(
                        "UPDATE gocardless_events SET attempts = attempts + 1, last_error = ?2,
                             outcome = ?3, processed_at = CASE WHEN ?3 IS NULL THEN NULL ELSE ?4 END
                         WHERE id = ?1",
                        params![id, error, outcome, now],
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
                    Ok("done")
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
/// and hasn't ended. Read fresh, not from the caller's snapshot; created
/// once whatever the retries (the idempotency key is the regular gift's).
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
    let id = id.to_owned();
    org.write(move |ctx| {
        update_mandate(ctx, &id, None, Source::System, None, |m| {
            m.subscription_id = Some(subscription)
        })
    })
    .await?;
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

/// Forget handled events older than [`KEEP_HANDLED_MS`].
pub fn purge(store: &Store, now: i64) -> Result<usize, store::StoreError> {
    store.platform().with_write(|tx| {
        Ok(tx.execute(
            "DELETE FROM gocardless_events WHERE processed_at IS NOT NULL AND processed_at < ?1",
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
