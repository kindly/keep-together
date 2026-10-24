//! `GET /api/t/{slug}/events`: the organisation's committed changes as
//! server-sent events, ids only (`store::OrgEvent`). Clients invalidate
//! and refetch what they show; the stream can't leak more than a viewer
//! may read.
//!
//! - Each change is an unnamed message: `id:` is the cursor
//!   `<generation>.<seq>` (the file's recovery generation, the revision
//!   id), `data:` the event JSON.
//! - `Last-Event-ID: g.n` (or `?after=g.n`, for the first connect, which
//!   `EventSource` can't give a header; the header wins, since a browser
//!   reconnect keeps the URL but sends its latest id) replays `revisions`
//!   with `id > n`, at most [`REPLAY_MAX`]. Further behind, an unreadable
//!   cursor, one of another generation, or one *ahead* of the file gets
//!   one `event: reset` instead, whose `id:` is the file's head; the
//!   client refetches everything. A subscriber that lags the live channel
//!   is treated the same way.
//! - A bare number is a tab on the bundle from before generations: it
//!   gets ids it can keep (`Ids::Legacy`), so it resets once, not on
//!   every reopen.
//! - The generation is a random id in the org file ([`MIGRATION`]),
//!   rotated whenever the file is put back from a copy (`restore.sh`,
//!   `rollback-migration.sh`, so the restore drill too). A restored file's
//!   revision ids are reused for different commands once writes carry on,
//!   so a cursor's seq alone can't tell that history was replaced: a tab
//!   at 100, a restore to 80 and new writes to 110 would replay nothing
//!   of 81–100's replacements. The generation can.
//! - A cold load opens the stream with `?after=` the cursor its `/boot`
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
use futures_util::{StreamExt, stream};
use rusqlite::{Connection, params};
use serde::Deserialize;
use store::{OrgDb, OrgEvent};
use tokio::sync::broadcast::error::RecvError;

use crate::auth::Account;
use crate::{ApiError, Tenant, blocking};

/// The most revisions a reconnect replays before it resets instead.
pub const REPLAY_MAX: i64 = 1000;
pub const KEEP_ALIVE: Duration = Duration::from_secs(20);

/// The org file's recovery generation: a random id, one row
/// ([`generation`]), rotated by the scripts that put a file back from a
/// copy: `UPDATE recovery SET generation = lower(hex(randomblob(16)))`.
pub const MIGRATION: &str = "
CREATE TABLE recovery (generation TEXT NOT NULL) STRICT;
INSERT INTO recovery (generation) VALUES (lower(hex(randomblob(16))));
";

/// Give a file put back from a copy a new recovery generation. A file
/// from before the table existed is left: it gets a fresh one when it
/// migrates. `restore.sh` and `rollback-migration.sh` run the same SQL.
pub fn rotate_generation(conn: &Connection) -> rusqlite::Result<()> {
    let has: bool = conn.query_row(
        "SELECT count(*) = 1 FROM sqlite_master WHERE type = 'table' AND name = 'recovery'",
        [],
        |row| row.get(0),
    )?;
    if has {
        conn.execute(
            "UPDATE recovery SET generation = lower(hex(randomblob(16)))",
            [],
        )?;
    }
    Ok(())
}

/// The file's recovery generation (see the top).
pub fn generation(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT generation FROM recovery LIMIT 1", [], |row| {
        row.get(0)
    })
}

/// An event id: `<generation>.<seq>`.
fn cursor_id(generation: &str, seq: i64) -> String {
    format!("{generation}.{seq}")
}

/// The cursor at this snapshot's head: what `/boot` hands the stream.
pub fn head_cursor(conn: &Connection) -> rusqlite::Result<String> {
    Ok(cursor_id(&generation(conn)?, head_seq(conn)?))
}

/// How a stream writes its ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ids {
    /// `<generation>.<seq>`.
    Cursor,
    /// For a tab still running the bundle from before generations, which
    /// keeps only an id that is a safe integer (and else reopens with its
    /// old number, a reset every time): `tag << 32 | seq`, the tag
    /// (1..=2^20) taken from the generation, so the id stays below 2^53
    /// and a restore still resets it. Such a tab resets once, then
    /// resumes like any other.
    Legacy,
}

const LEGACY_SHIFT: u32 = 32;

/// The generation's tag in a legacy id: its first 20 bits, plus one (a
/// pre-generation number, below 2^32, has tag 0).
fn legacy_tag(generation: &str) -> i64 {
    generation
        .get(..5)
        .and_then(|h| i64::from_str_radix(h, 16).ok())
        .unwrap_or(0)
        + 1
}

impl Ids {
    fn id(self, generation: &str, seq: i64) -> String {
        match self {
            Ids::Legacy if (0..1 << LEGACY_SHIFT).contains(&seq) => {
                ((legacy_tag(generation) << LEGACY_SHIFT) | seq).to_string()
            }
            _ => cursor_id(generation, seq),
        }
    }
}

/// How a cursor's stream writes ids, and the seq it names if it is of
/// `generation` (else the client gets a reset).
fn parse_cursor(cursor: &str, generation: &str) -> (Ids, Option<i64>) {
    let cursor = cursor.trim();
    if let Some((g, seq)) = cursor.split_once('.') {
        return (
            Ids::Cursor,
            (g == generation).then(|| seq.parse().ok()).flatten(),
        );
    }
    match cursor.parse::<i64>() {
        Ok(n) if n >= 0 => {
            let ours = n >> LEGACY_SHIFT == legacy_tag(generation);
            (Ids::Legacy, ours.then_some(n & ((1 << LEGACY_SHIFT) - 1)))
        }
        _ => (Ids::Cursor, None),
    }
}

enum Item {
    Change(OrgEvent),
    /// Refetch everything; resume after this seq.
    Reset(i64),
}

impl Item {
    fn event(&self, generation: &str, ids: Ids) -> Event {
        match self {
            Item::Change(e) => Event::default()
                .id(ids.id(generation, e.seq))
                .data(serde_json::to_string(e).unwrap_or_default()),
            Item::Reset(head) => Event::default()
                .id(ids.id(generation, *head))
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
            // The file went back in time and its generation wasn't
            // rotated: ids after `head` will be reused.
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
    /// The file's recovery generation, in every id sent.
    generation: String,
    ids: Ids,
}

async fn next(mut s: State) -> Option<(Result<Event, Infallible>, State)> {
    loop {
        if let Some(item) = s.queue.pop_front() {
            return Some((Ok(item.event(&s.generation, s.ids)), s));
        }
        match s.rx.recv().await {
            Ok(e) if e.seq <= s.last => continue,
            Ok(e) => {
                s.last = e.seq;
                return Some((Ok(Item::Change(e).event(&s.generation, s.ids)), s));
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
    let resume = last_event_id.map(str::to_owned);
    let read = db.clone();
    let (queue, last, generation, ids) = blocking(move || {
        let generation = read.read(|r| generation(r)).map_err(ApiError::from)?;
        // Unreadable, or of another generation (the file was put back
        // from a copy since): refetch everything.
        let (ids, queue, last) = match resume.map(|c| parse_cursor(&c, &generation)) {
            None => (Ids::Cursor, Vec::new(), head(&read)?),
            Some((ids, None)) => {
                let head = head(&read)?;
                (ids, vec![Item::Reset(head)], head)
            }
            Some((ids, Some(after))) => {
                let (queue, last) = catch_up(&read, after)?;
                (ids, queue, last)
            }
        };
        Ok::<_, ApiError>((queue, last, generation, ids))
    })
    .await?;
    Ok(stream::unfold(
        State {
            db,
            rx,
            queue: queue.into(),
            last,
            generation,
            ids,
        },
        next,
    ))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    after: Option<String>,
}

/// `GET /api/t/{slug}/events[?after=g.n]` (viewer and above).
pub async fn events(
    Extension(tenant): Extension<Tenant>,
    Extension(account): Extension<Account>,
    headers: HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let last = headers
        .get("last-event-id")
        .map(|v| v.to_str().unwrap_or("?").to_owned())
        .or(q.after);
    // Ends when the session is revoked (sign-out, revoke-all) or the
    // membership is removed; the client's reconnect then gets a 401/403.
    let slug = tenant.slug.clone();
    let ended = Box::pin(account.ended(slug));
    let stream = tenant.events(last.as_deref()).await?.take_until(ended);
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
            generation: "g".into(),
            ids: Ids::Cursor,
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
