//! What an organisation's SSE stream carries (`GET /api/t/{slug}/events`):
//! one [`OrgEvent`] per committed contract, ids only, never data. The
//! client refetches what it shows, so the stream can't leak more than a
//! viewer may read.
//!
//! On the wire each change is an unnamed SSE message (`onmessage`):
//! `id:` is `seq`, `data:` is the JSON below. A client whose
//! `Last-Event-ID` is too far behind to replay gets one `event: reset`
//! (empty data) instead, and refetches everything.

use std::cell::Cell;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One executed contract, published after its transaction commits.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OrgEvent {
    /// The revision row id: monotonic per org file; the SSE `id:`.
    #[ts(type = "number")]
    pub seq: i64,
    /// The root table, e.g. `"contacts"`.
    pub entity: String,
    /// The root's id.
    pub id: String,
    /// The contract that ran, e.g. `"contacts.details"`.
    pub contract: String,
    /// That contract's counter after the command.
    #[ts(type = "number")]
    pub counter: i64,
}

thread_local! {
    /// The `seq` of the last event the last commit on this thread
    /// published, until taken: [`take_published_seq`].
    static PUBLISHED_SEQ: Cell<Option<i64>> = const { Cell::new(None) };
}

/// Called by `OrgDb::write_raw` after it publishes a commit's events.
pub(crate) fn published(seq: i64) {
    PUBLISHED_SEQ.with(|c| c.set(Some(seq)));
}

/// The `seq` of the last event published by a commit on this thread
/// since the last call, if any: the api answers it (`keep-seq`), so a
/// client that shows a write's answer knows which events it already
/// reflects. Every event up to it committed before the answer was read.
pub fn take_published_seq() -> Option<i64> {
    PUBLISHED_SEQ.with(|c| c.take())
}
