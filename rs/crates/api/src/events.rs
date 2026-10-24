//! `GET /api/t/{slug}/events`: the organisation's committed changes as
//! server-sent events, ids only (`store::OrgEvent`). Clients invalidate
//! and refetch what they show; the stream can't leak more than a viewer
//! may read.
//!
//! - Each change is an unnamed message: `id:` is the revision id (`seq`),
//!   `data:` the event JSON.
//! - `Last-Event-ID: n` (or `?after=n`, for the first connect, which
//!   `EventSource` can't give a header; the header wins, since a browser
//!   reconnect keeps the URL but sends its latest id) replays `revisions`
//!   with `id > n`, at most [`REPLAY_MAX`]. Further behind, an unreadable
//!   id, or an id *ahead* of the file (it was restored from a backup or
//!   rolled back), gets one `event: reset` instead, whose `id:` is the
//!   file's head; the client refetches everything. A subscriber that lags
//!   the live channel is treated the same way.
//! - A cold load opens the stream with `?after=` the `seq` its `/boot`
//!   response carried, so nothing committed in between is missed.
//! - A keep-alive comment every 20 s.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::extract::Query;
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use futures_util::stream;
use rusqlite::{Connection, params};
use serde::Deserialize;
use store::{OrgDb, OrgEvent};
use tokio::sync::broadcast::error::RecvError;

use crate::{ApiError, Tenant, blocking};

/// The most revisions a reconnect replays before it resets instead.
pub const REPLAY_MAX: i64 = 1000;
pub const KEEP_ALIVE: Duration = Duration::from_secs(20);

enum Item {
    Change(OrgEvent),
    /// Refetch everything; resume after this seq.
    Reset(i64),
}

impl Item {
    fn event(&self) -> Event {
        match self {
            Item::Change(e) => Event::default()
                .id(e.seq.to_string())
                .data(serde_json::to_string(e).unwrap_or_default()),
            Item::Reset(head) => Event::default()
                .id(head.to_string())
                .event("reset")
                .data(""),
        }
    }
}

/// The newest revision id in this snapshot (0 for an empty file): the
/// `seq` a stream resumes after.
pub fn head_seq(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT coalesce(max(id), 0) FROM revisions", [], |row| {
        row.get(0)
    })
}

/// What a client resumes from: the revisions after `seq`, or a reset.
fn catch_up(db: &OrgDb, after: i64) -> Result<(Vec<Item>, i64), ApiError> {
    db.read(|r| {
        let head = head_seq(r)?;
        if after > head {
            // The file went back in time (restore, rollback): ids after
            // `head` will be reused for different commands.
            return Ok((vec![Item::Reset(head)], head));
        }
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
            return Ok((vec![Item::Reset(head)], head));
        }
        let last = rows.last().map_or(after, |e| e.seq);
        Ok((rows.into_iter().map(Item::Change).collect(), last))
    })
}

/// The most recent revision id now: where a fresh stream starts.
fn head(db: &OrgDb) -> Result<i64, ApiError> {
    db.read(|r| Ok(head_seq(r)?))
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
                    .unwrap_or_else(|_| (vec![Item::Reset(after)], after));
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
        Some(None) => {
            let head = head(&read)?;
            Ok((vec![Item::Reset(head)], head))
        }
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

#[derive(Deserialize)]
pub struct EventsQuery {
    after: Option<String>,
}

/// `GET /api/t/{slug}/events[?after=n]` (viewer and above).
pub async fn events(
    Extension(tenant): Extension<Tenant>,
    headers: HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let last = headers
        .get("last-event-id")
        .map(|v| v.to_str().unwrap_or("?").to_owned())
        .or(q.after);
    let stream = tenant.events(last.as_deref()).await?;
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEP_ALIVE)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use contracts::{Source, transact};
    use store::{Store, StoreConfig};

    fn event(seq: i64) -> OrgEvent {
        OrgEvent {
            seq,
            entity: "contacts".into(),
            id: String::new(),
            contract: "contacts.details".into(),
            counter: 0,
        }
    }

    /// A subscriber that falls behind the live channel catches up from
    /// `revisions` (and skips what it then gets twice).
    #[tokio::test]
    async fn a_lagging_subscriber_replays_from_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(StoreConfig {
            dir: tmp.path().to_path_buf(),
            org_migrations: crate::schema::org_migrations(),
            readers: 1,
            max_open: 4,
        })
        .unwrap();
        let t = store.create_tenant("alpha", "Alpha").unwrap();
        let db = store.org(&t.id).unwrap();
        transact(&db, None, |ctx| {
            for i in 0..5 {
                let req = serde_json::from_value(serde_json::json!({
                    "kind": "individual", "title": "", "firstName": "P",
                    "lastName": format!("n{i}"), "nickname": "", "name": "", "isDeceased": false
                }))
                .unwrap();
                contacts::form::create(ctx, req, Source::Seed)?;
            }
            Ok::<_, contracts::ContractError>(())
        })
        .unwrap();
        // A channel of 2 that has seen all 5: the receiver lagged.
        let (tx, rx) = tokio::sync::broadcast::channel(2);
        for seq in 1..=5 {
            tx.send(event(seq)).unwrap();
        }
        let mut state = State {
            db,
            rx,
            queue: VecDeque::new(),
            last: 1,
        };
        let mut seen = vec![];
        for _ in 0..4 {
            let (_, s) = next(state).await.unwrap();
            seen.push(s.last);
            state = s;
        }
        // 2..=5 from the file (replay), then the buffered 4 and 5 skipped.
        assert_eq!(seen, vec![5, 5, 5, 5]);
        assert_eq!(state.queue.len(), 0);
        drop(tx);
        assert!(next(state).await.is_none());
    }
}
