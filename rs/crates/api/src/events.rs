//! `GET /api/t/{slug}/events`: the organisation's committed changes as
//! server-sent events, ids only (`store::OrgEvent`). Clients invalidate
//! and refetch what they show; the stream can't leak more than a viewer
//! may read.
//!
//! - Each change is an unnamed message: `id:` is the revision id (`seq`),
//!   `data:` the event JSON.
//! - `Last-Event-ID: n` replays `revisions` with `id > n`, at most
//!   [`REPLAY_MAX`]; further behind (or an unreadable id) the server sends
//!   one `event: reset` instead and the client refetches everything. A
//!   subscriber that lags the live channel is treated the same way.
//! - A keep-alive comment every 20 s.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use futures_util::stream;
use rusqlite::params;
use store::{OrgDb, OrgEvent};
use tokio::sync::broadcast::error::RecvError;

use crate::{ApiError, Tenant, blocking};

/// The most revisions a reconnect replays before it resets instead.
pub const REPLAY_MAX: i64 = 1000;
pub const KEEP_ALIVE: Duration = Duration::from_secs(20);

enum Item {
    Change(OrgEvent),
    Reset,
}

impl Item {
    fn event(&self) -> Event {
        match self {
            Item::Change(e) => Event::default()
                .id(e.seq.to_string())
                .data(serde_json::to_string(e).unwrap_or_default()),
            Item::Reset => Event::default().event("reset").data(""),
        }
    }
}

/// What a client resumes from: the revisions after `seq`, or a reset.
fn catch_up(db: &OrgDb, after: i64) -> Result<(Vec<Item>, i64), ApiError> {
    db.read(|r| {
        let mut stmt = r.prepare_cached(
            "SELECT id, entity, entity_id, contract, counter FROM revisions
             WHERE id > ?1 ORDER BY id LIMIT ?2",
        )?;
        let rows: Vec<OrgEvent> = stmt
            .query_map(params![after, REPLAY_MAX + 1], |row| {
                Ok(OrgEvent {
                    seq: row.get(0)?,
                    entity: row.get(1)?,
                    id: row.get(2)?,
                    contract: row.get(3)?,
                    counter: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if rows.len() as i64 > REPLAY_MAX {
            let head: i64 =
                r.query_row("SELECT coalesce(max(id), 0) FROM revisions", [], |row| {
                    row.get(0)
                })?;
            return Ok((vec![Item::Reset], head));
        }
        let last = rows.last().map_or(after, |e| e.seq);
        Ok((rows.into_iter().map(Item::Change).collect(), last))
    })
}

/// The most recent revision id now: where a fresh stream starts.
fn head(db: &OrgDb) -> Result<i64, ApiError> {
    db.read(|r| {
        Ok(
            r.query_row("SELECT coalesce(max(id), 0) FROM revisions", [], |row| {
                row.get(0)
            })?,
        )
    })
}

struct State {
    /// Holds the handle open (the LRU never closes one in use) and keeps
    /// the subscription on this very handle's channel.
    db: Arc<OrgDb>,
    rx: tokio::sync::broadcast::Receiver<OrgEvent>,
    queue: VecDeque<Item>,
    /// The last seq the client has (or was reset past).
    last: i64,
}

async fn next(mut s: State) -> Option<(Result<Event, Infallible>, State)> {
    loop {
        if let Some(item) = s.queue.pop_front() {
            return Some((Ok(item.event()), s));
        }
        match s.rx.recv().await {
            Ok(e) if e.seq <= s.last => continue,
            Ok(e) => {
                s.last = e.seq;
                return Some((Ok(Item::Change(e).event()), s));
            }
            Err(RecvError::Lagged(_)) => {
                let db = s.db.clone();
                let after = s.last;
                let (items, last) = blocking(move || catch_up(&db, after))
                    .await
                    .unwrap_or_else(|_| (vec![Item::Reset], after));
                s.queue.extend(items);
                s.last = last;
            }
            Err(RecvError::Closed) => return None,
        }
    }
}

/// The stream for one organisation, from `last_event_id` if given.
pub(crate) async fn stream(
    db: Arc<OrgDb>,
    last_event_id: Option<&str>,
) -> Result<impl Stream<Item = Result<Event, Infallible>> + Send + 'static + use<>, ApiError> {
    // Subscribe first, then read: nothing committed in between is missed
    // (duplicates are skipped by seq).
    let rx = db.subscribe();
    let resume = last_event_id.map(|v| v.trim().parse::<i64>().ok());
    let read = db.clone();
    let (queue, last) = blocking(move || match resume {
        None => Ok((Vec::new(), head(&read)?)),
        Some(None) => Ok((vec![Item::Reset], head(&read)?)),
        Some(Some(after)) => catch_up(&read, after),
    })
    .await?;
    Ok(stream::unfold(
        State {
            db,
            rx,
            queue: queue.into(),
            last,
        },
        next,
    ))
}

/// `GET /api/t/{slug}/events` (viewer and above).
pub async fn events(
    Extension(tenant): Extension<Tenant>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let last = headers
        .get("last-event-id")
        .map(|v| v.to_str().unwrap_or("?").to_owned());
    let stream = tenant.events(last.as_deref()).await?;
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEP_ALIVE)))
}
