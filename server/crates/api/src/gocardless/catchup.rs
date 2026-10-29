//! `gocardless-catchup`: the nightly safety net for missed webhooks (plan
//! gocardless.sv, round 2). For each connected organisation, GoCardless's
//! events for its account since the last run are read (`GET events`,
//! page by page) and stored in the same event store as webhooks
//! ([`super::webhook::store_events`]: `INSERT OR IGNORE` by event id, so
//! one a webhook already brought is a no-op). How many were new is
//! logged, and reported to Sentry as a warning when it isn't zero: that
//! means webhooks are being missed. Then a processing run handles them.
//!
//! The cursor (`platform.db`, `gocardless_catchup`) is per organisation
//! and account: the start of the last run, read again from an hour
//! earlier (events are deduplicated, and clocks drift). The first run for
//! an account starts from when it was connected, at most a week back, and
//! no run reads further back than handled events are kept (85 days).

use std::sync::Arc;
use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde_json::Value;
use store::{Store, TenantId};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::GoCardless;
use super::webhook::{Incoming, store_events};
use crate::jobs::Job;

/// Events read per page (GoCardless's most).
pub const PAGE: usize = 500;
/// Pages read per organisation per run at most (100,000 events).
pub const MAX_PAGES: usize = 200;
/// How far before the cursor each run reads again.
pub const OVERLAP_MS: i64 = 60 * 60 * 1000;
/// How far back any run reads at most: inside the 90 days handled events
/// are kept ([`super::process::KEEP_HANDLED_MS`]), with a margin.
pub const FLOOR_MS: i64 = super::process::KEEP_HANDLED_MS - 5 * 24 * 60 * 60 * 1000;
const _: () = assert!(FLOOR_MS > 0 && FLOOR_MS < super::process::KEEP_HANDLED_MS);
/// How far back an account's first run reads at most: since it was
/// connected, or a week (handled events are kept 90 days, so older ones
/// would come back as "missed").
pub const FIRST_RUN_MS: i64 = 7 * 24 * 60 * 60 * 1000;

fn rfc3339(ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|t| t.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into())
}

fn ms_of(s: &str) -> Option<i64> {
    OffsetDateTime::parse(s, &Rfc3339)
        .ok()
        .map(|t| (t.unix_timestamp_nanos() / 1_000_000) as i64)
}

/// Where a run starting at `started` reads from (ms): an hour before the
/// cursor, or (first run) since the connection at most a week back; and
/// never further back than handled events are kept, whatever the cursor
/// (a long disconnect, runs failing for months): older events would come
/// back as "missed" (review L5).
fn since(cursor: Option<&str>, connected_at: i64, started: i64) -> i64 {
    (cursor
        .and_then(ms_of)
        .unwrap_or_else(|| connected_at.max(started - FIRST_RUN_MS))
        - OVERLAP_MS)
        .max(started - FLOOR_MS)
}

/// What one organisation's catch-up found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Caught {
    pub tenant: TenantId,
    /// Events read from GoCardless.
    pub read: usize,
    /// Of those, new here: webhooks we missed.
    pub missed: usize,
}

/// Catch up every connected organisation, one at a time; the events
/// found are handled by a processing run. One organisation's failure
/// (GoCardless down, a token refused) is reported and the rest go on.
pub async fn catch_up(store: Arc<Store>, gc: Arc<GoCardless>) -> Result<Vec<Caught>, String> {
    let s = store.clone();
    let connected: Vec<(String, String, i64)> = crate::blocking(move || {
        s.platform().with_read(|c| {
            c.prepare(
                "SELECT tenant_id, organisation_id, connected_at FROM gocardless_connections
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
    for (tenant, organisation, connected_at) in connected {
        match one(&store, &gc, &tenant, &organisation, connected_at).await {
            Ok(Some(caught)) => {
                if caught.missed > 0 {
                    crate::observe::warning(&format!(
                        "gocardless catch-up: {} event(s) for {} that no webhook brought",
                        caught.missed, caught.tenant
                    ));
                } else {
                    eprintln!(
                        "gocardless catch-up: {}: {} event(s) read, none missed",
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
        super::webhook::spawn_processing(store.clone(), gc.clone());
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(errors.join("; "))
    }
}

async fn one(
    store: &Arc<Store>,
    gc: &Arc<GoCardless>,
    tenant: &str,
    organisation: &str,
    connected_at: i64,
) -> Result<Option<Caught>, String> {
    let (s, g, raw, org) = (
        store.clone(),
        gc.clone(),
        tenant.to_owned(),
        organisation.to_owned(),
    );
    let opened = crate::blocking(move || {
        let Some(id) = super::known_tenant(&s, &raw)? else {
            return Ok::<_, crate::ApiError>(None);
        };
        let db = s.org(&id)?;
        // Only this account's token: during a switch the mapping and the
        // token land in different files (review L7).
        let token = db.read(|r| g.token_for(r, &org))?;
        Ok(Some((id, token)))
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    // A connect (or a switch) still landing: the next run.
    let Some((id, Some(token))) = opened else {
        return Ok(None);
    };
    let (s, t, org) = (store.clone(), tenant.to_owned(), organisation.to_owned());
    let cursor: Option<String> = crate::blocking(move || {
        s.platform().with_read(|c| {
            Ok::<_, store::StoreError>(
                c.query_row(
                    "SELECT since FROM gocardless_catchup
                     WHERE tenant_id = ?1 AND organisation_id = ?2",
                    params![t, org],
                    |r| r.get(0),
                )
                .optional()?,
            )
        })
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    let started = contracts::now_ms();
    let since_ms = since(cursor.as_deref(), connected_at, started);
    let since = rfc3339(since_ms);

    let mut events: Vec<Value> = vec![];
    let mut after: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let page = gc
            .api
            .list_events(&token, &since, after.as_deref(), PAGE)
            .await
            .map_err(|e| format!("gocardless {e}"))?;
        events.extend(page.events);
        after = page.after;
        if after.is_none() {
            break;
        }
    }
    if after.is_some() {
        // GoCardless lists newest first: the oldest beyond the pages read
        // are never reached, so say so and move on (review L6).
        crate::observe::warning(&format!(
            "gocardless catch-up: {tenant}: more than {} events since {since}; \
             only the newest were read, older ones are not caught up",
            PAGE * MAX_PAGES
        ));
    }
    // Oldest first, as webhooks would have brought them; each for this
    // account, whatever its links say.
    events.sort_by(|a, b| {
        let at = |e: &Value| e["created_at"].as_str().and_then(ms_of).unwrap_or(0);
        at(a).cmp(&at(b))
    });
    let incoming: Vec<Incoming> = events
        .iter()
        .filter_map(|e| {
            let text = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
            Some(Incoming {
                id: text("id")?,
                organisation: Some(organisation.to_owned()),
                resource_type: text("resource_type")?,
                action: text("action")?,
                body: e.to_string(),
            })
        })
        .collect();
    let read = incoming.len();
    let (s, t, org) = (store.clone(), tenant.to_owned(), organisation.to_owned());
    let next = rfc3339(started);
    let stored = crate::blocking(move || {
        let stored = store_events(&s, &incoming, contracts::now_ms())?;
        s.platform().with_write(|tx| {
            tx.execute(
                "INSERT INTO gocardless_catchup (tenant_id, organisation_id, since, last_run_at,
                     last_found)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (tenant_id) DO UPDATE SET organisation_id = excluded.organisation_id,
                     since = excluded.since, last_run_at = excluded.last_run_at,
                     last_found = excluded.last_found",
                params![t, org, next, contracts::now_ms(), stored.queued as i64],
            )?;
            Ok::<_, store::StoreError>(())
        })?;
        Ok::<_, store::StoreError>(stored)
    })
    .await
    .map_err(|e| format!("{e:?}"))?;
    Ok(Some(Caught {
        tenant: id,
        read,
        missed: stored.queued,
    }))
}

/// `gocardless-catchup`: daily, its first run a quarter of an hour after
/// boot.
pub struct CatchUpJob {
    pub store: Arc<Store>,
    pub gc: Arc<GoCardless>,
}

impl Job for CatchUpJob {
    fn name(&self) -> &'static str {
        "gocardless-catchup"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(24 * 60 * 60)
    }
    fn first_after(&self) -> Duration {
        Duration::from_secs(15 * 60)
    }
    fn run(&self) -> std::pin::Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            catch_up(self.store.clone(), self.gc.clone()).await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_round_trips_through_rfc_3339() {
        let ms = 1_793_000_000_123;
        assert_eq!(ms_of(&rfc3339(ms)), Some(ms));
        assert_eq!(ms_of("2026-10-29T08:00:00Z"), Some(1_793_260_800_000));
        assert_eq!(ms_of("yesterday"), None);
    }

    #[test]
    fn a_run_reads_from_an_hour_before_its_cursor_and_never_past_retention() {
        let day = 24 * 60 * 60 * 1000;
        let now = 1_793_260_800_000;
        let cursor = rfc3339(now - day);
        assert_eq!(since(Some(&cursor), 0, now), now - day - OVERLAP_MS);
        // First run: since connected, at most a week back.
        assert_eq!(since(None, now - 2 * day, now), now - 2 * day - OVERLAP_MS);
        assert_eq!(since(None, 0, now), now - FIRST_RUN_MS - OVERLAP_MS);
        // A cursor from a year ago: floored inside retention.
        let ancient = rfc3339(now - 365 * day);
        assert_eq!(since(Some(&ancient), 0, now), now - FLOOR_MS);
    }
}
