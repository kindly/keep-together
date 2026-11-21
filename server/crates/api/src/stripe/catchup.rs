//! `stripe-catchup`: the daily safety net for missed webhooks (plan
//! stripe.sv, S3; `gocardless::catchup` is its model). For each connected
//! organisation, Stripe's events for its account since the last run are
//! read (`GET /v1/events` on the account, the types processing handles,
//! page by page) and stored in the same event store as webhooks
//! ([`super::webhook::store_event`]: `INSERT OR IGNORE` by event id, so
//! one a webhook already brought is a no-op). How many were new is
//! logged, and reported to Sentry as a warning when it isn't zero: that
//! means webhooks are being missed. Then a processing run handles them.
//!
//! The cursor (`platform.db`, `stripe_catchup`) is per organisation and
//! account: the start of the last run, read again from an hour earlier
//! (events are deduplicated, and clocks drift). The first run for an
//! account starts from when it was connected, at most a week back, and no
//! run reads further back than Stripe keeps events (30 days, less a day).

use std::sync::Arc;
use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use store::{Store, TenantId};

use super::Stripe;
use super::client::{EVENTS_PAGE, handled_events};
use super::webhook::{Incoming, Stored, store_event};
use crate::jobs::Job;

/// Pages read per organisation per run at most (20,000 events).
pub const MAX_PAGES: usize = 200;
/// How far before the cursor each run reads again.
pub const OVERLAP_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// How far back any run reads at most: Stripe keeps events 30 days.
pub const FLOOR_MS: i64 = 29 * DAY_MS;
const _: () = assert!(FLOOR_MS < super::process::KEEP_HANDLED_MS);
/// How far back an account's first run reads at most: since it was
/// connected, or a week.
pub const FIRST_RUN_MS: i64 = 7 * DAY_MS;

/// Where a run starting at `started` reads from (ms): an hour before the
/// cursor, or (first run) since the connection at most a week back; and
/// never further back than Stripe keeps events, whatever the cursor.
fn since(cursor: Option<i64>, connected_at: i64, started: i64) -> i64 {
    (cursor.unwrap_or_else(|| connected_at.max(started - FIRST_RUN_MS)) - OVERLAP_MS)
        .max(started - FLOOR_MS)
}

/// What one organisation's catch-up found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caught {
    pub tenant: TenantId,
    /// Events read from Stripe.
    pub read: usize,
    /// Of those, new here and queued: webhooks we missed.
    pub missed: usize,
    /// Where the read started (ms): events created before it weren't
    /// asked for.
    pub since: i64,
}

/// Catch up every connected organisation, one at a time; the events
/// found are handled by a processing run. One organisation's failure
/// (Stripe down, an account gone) is reported and the rest go on.
pub async fn catch_up(store: Arc<Store>, stripe: Arc<Stripe>) -> Result<Vec<Caught>, String> {
    catch_up_paged(store, stripe, MAX_PAGES).await
}

/// [`catch_up`] reading at most `max_pages` pages per organisation (tests
/// pass a small number).
pub async fn catch_up_paged(
    store: Arc<Store>,
    stripe: Arc<Stripe>,
    max_pages: usize,
) -> Result<Vec<Caught>, String> {
    let s = store.clone();
    let connected: Vec<(String, String, i64)> = crate::blocking(move || {
        s.platform().with_read(|c| {
            c.prepare(
                "SELECT tenant_id, account_id, connected_at FROM stripe_accounts
                 WHERE account_id IS NOT NULL AND disconnected_at IS NULL
                 ORDER BY tenant_id",
            )?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(store::StoreError::from)
        })
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    let mut out = vec![];
    let mut errors = vec![];
    for (tenant, account, connected_at) in connected {
        match one(&store, &stripe, &tenant, &account, connected_at, max_pages).await {
            Ok(Some(caught)) => {
                if caught.missed > 0 {
                    crate::observe::warning(&format!(
                        "stripe catch-up: {} event(s) for {} that no webhook brought",
                        caught.missed, caught.tenant
                    ));
                } else {
                    eprintln!(
                        "stripe catch-up: {}: {} event(s) read, none missed",
                        caught.tenant, caught.read
                    );
                }
                out.push(caught);
            }
            Ok(None) => {}
            Err(e) => errors.push(format!("{tenant}: {e}")),
        }
    }
    if out.iter().any(|c| c.missed > 0) {
        super::webhook::spawn_processing(store.clone(), stripe.clone());
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors.join("; "))
    }
}

async fn one(
    store: &Arc<Store>,
    stripe: &Arc<Stripe>,
    tenant: &str,
    account: &str,
    connected_at: i64,
    max_pages: usize,
) -> Result<Option<Caught>, String> {
    let (s, raw, acct) = (store.clone(), tenant.to_owned(), account.to_owned());
    let found = crate::blocking(move || {
        let Some(id) = crate::gocardless::known_tenant(&s, &raw)? else {
            return Ok::<_, store::StoreError>(None);
        };
        // The cursor counts only for the account it was read for.
        let cursor: Option<i64> = s.platform().with_read(|c| {
            Ok::<_, store::StoreError>(
                c.query_row(
                    "SELECT since FROM stripe_catchup WHERE tenant_id = ?1 AND account_id = ?2",
                    params![raw, acct],
                    |r| r.get(0),
                )
                .optional()?,
            )
        })?;
        Ok(Some((id, cursor)))
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    let Some((id, cursor)) = found else {
        return Ok(None);
    };
    let started = contracts::now_ms();
    let since = since(cursor, connected_at, started);

    let types = handled_events();
    let mut events: Vec<Value> = vec![];
    let mut after: Option<String> = None;
    let mut more = true;
    for _ in 0..max_pages {
        let page = stripe
            .api
            .list_events(account, since / 1000, &types, after.as_deref())
            .await
            .map_err(|e| format!("stripe {e}"))?;
        after = page
            .events
            .last()
            .and_then(|e| e.get("id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        more = page.has_more && after.is_some();
        events.extend(page.events);
        if !more {
            break;
        }
    }
    if more {
        // Stripe lists newest first: the oldest beyond the pages read
        // weren't reached, so say so; the cursor doesn't move (below).
        crate::observe::warning(&format!(
            "stripe catch-up: {tenant}: more than {} events since {since}; only the newest \
             were read, the next run reads the window again",
            EVENTS_PAGE * max_pages
        ));
    }
    // Oldest first, as webhooks would have brought them (the list is
    // newest first; a stable sort keeps a second's events in that order).
    events.reverse();
    events.sort_by_key(|e| e["created"].as_i64().unwrap_or(0));
    let livemode = stripe.livemode();
    let incoming: Vec<Incoming> = events
        .iter()
        .filter_map(|e| {
            let text = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
            Some(Incoming {
                id: text("id")?,
                // Listed on this account, whatever the event itself says.
                account: Some(account.to_owned()),
                kind: text("type")?,
                created: e.get("created").and_then(Value::as_i64).unwrap_or(0),
                livemode: e
                    .get("livemode")
                    .and_then(Value::as_bool)
                    .unwrap_or(livemode),
                body: e.to_string(),
            })
        })
        .collect();
    let read = incoming.len();
    // Pages ran out: the oldest events of the window weren't reached, so
    // the cursor stays where this run read from and the next run reads
    // the window again (by then webhooks or this run have most of it).
    let next = if more { since + OVERLAP_MS } else { started };
    let (s, t, acct) = (store.clone(), tenant.to_owned(), account.to_owned());
    let missed = crate::blocking(move || {
        let now = contracts::now_ms();
        let mut missed = 0;
        for event in &incoming {
            if store_event(&s, event, livemode, now)? == Stored::Queued {
                missed += 1;
            }
        }
        s.platform().with_write(|tx| {
            tx.execute(
                "INSERT INTO stripe_catchup (tenant_id, account_id, since, last_run_at,
                     last_found)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (tenant_id) DO UPDATE SET account_id = excluded.account_id,
                     since = excluded.since, last_run_at = excluded.last_run_at,
                     last_found = excluded.last_found",
                params![t, acct, next, now, missed as i64],
            )?;
            Ok::<_, store::StoreError>(())
        })?;
        Ok::<_, store::StoreError>(missed)
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    Ok(Some(Caught {
        tenant: id,
        read,
        missed,
        since,
    }))
}

/// `stripe-catchup`: daily, its first run a quarter of an hour after
/// boot.
pub struct CatchUpJob {
    pub store: Arc<Store>,
    pub stripe: Arc<Stripe>,
}

impl Job for CatchUpJob {
    fn name(&self) -> &'static str {
        "stripe-catchup"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(24 * 60 * 60)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(15 * 60)
    }
    fn run(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            catch_up(self.store.clone(), self.stripe.clone()).await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_reads_from_an_hour_before_its_cursor_and_never_past_what_stripe_keeps() {
        let now = 1_793_260_800_000;
        assert_eq!(since(Some(now - DAY_MS), 0, now), now - DAY_MS - OVERLAP_MS);
        // First run: since connected, at most a week back.
        assert_eq!(
            since(None, now - 2 * DAY_MS, now),
            now - 2 * DAY_MS - OVERLAP_MS
        );
        assert_eq!(since(None, 0, now), now - FIRST_RUN_MS - OVERLAP_MS);
        // A cursor from a year ago: floored inside Stripe's 30 days.
        assert_eq!(since(Some(now - 365 * DAY_MS), 0, now), now - FLOOR_MS);
    }
}
