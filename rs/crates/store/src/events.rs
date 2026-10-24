//! What an organisation's SSE stream carries (`GET /api/t/{slug}/events`):
//! one [`OrgEvent`] per committed contract, ids only, never data. The
//! client refetches what it shows, so the stream can't leak more than a
//! viewer may read.
//!
//! On the wire each change is an unnamed SSE message (`onmessage`):
//! `id:` is `seq`, `data:` is the JSON below. A client whose
//! `Last-Event-ID` is too far behind to replay gets one `event: reset`
//! (empty data) instead, and refetches everything.

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
