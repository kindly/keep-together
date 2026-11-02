//! `Server-Timing` on every `/api` response: `platform` (session +
//! membership lookups), `db` (time inside org-file closures, lock wait
//! included) and `total`, in ms. Measure scripts and QC read server time
//! from it without logs.
//!
//! A tenant write also answers `keep-seq`: the last event its commit
//! published (`store::take_published_seq`). The SPA installs a write's
//! answer and skips refetching it for the events up to that one
//! (src/lib/data/events.ts): the answer already shows them. That holds
//! only when the answer is read in that commit, so a request that
//! committed twice answers no `keep-seq` (another user's commit between
//! its two would be claimed too), and the SPA marks nothing fresh.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::HeaderValue;
use axum::middleware::Next;
use axum::response::Response;

#[derive(Clone, Default)]
pub struct Timing(Arc<Counters>);

#[derive(Default)]
struct Counters {
    platform_ns: AtomicU64,
    db_ns: AtomicU64,
    /// The last event this request's writes published; 0: none.
    seq: AtomicI64,
    /// How many of this request's commits published events.
    writes: AtomicU32,
}

impl Timing {
    pub fn add_platform(&self, d: Duration) {
        self.0
            .platform_ns
            .fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
    }

    pub fn add_db(&self, d: Duration) {
        self.0
            .db_ns
            .fetch_add(d.as_nanos() as u64, Ordering::Relaxed);
    }

    /// A commit of this request published events up to `seq`.
    pub fn wrote(&self, seq: i64) {
        self.0.seq.fetch_max(seq, Ordering::Relaxed);
        self.0.writes.fetch_add(1, Ordering::Relaxed);
    }

    /// `keep-seq`: the one commit's last event; none after two commits.
    fn keep_seq(&self) -> Option<i64> {
        let seq = self.0.seq.load(Ordering::Relaxed);
        (self.0.writes.load(Ordering::Relaxed) == 1 && seq > 0).then_some(seq)
    }

    fn header(&self, total: Duration) -> String {
        let ms = |ns: u64| ns as f64 / 1e6;
        format!(
            "platform;dur={:.3}, db;dur={:.3}, total;dur={:.3}",
            ms(self.0.platform_ns.load(Ordering::Relaxed)),
            ms(self.0.db_ns.load(Ordering::Relaxed)),
            ms(total.as_nanos() as u64),
        )
    }
}

/// Not on `/api/auth/*`: there the time a request took could tell a known
/// address from an unknown one (S1 codex C7).
pub async fn middleware(mut req: Request, next: Next) -> Response {
    let start = Instant::now();
    let timing = Timing::default();
    let auth = req.uri().path().starts_with("/api/auth/");
    req.extensions_mut().insert(timing.clone());
    let mut res = next.run(req).await;
    if auth {
        return res;
    }
    if let Ok(value) = HeaderValue::from_str(&timing.header(start.elapsed())) {
        res.headers_mut().insert("server-timing", value);
    }
    if let Some(seq) = timing.keep_seq() {
        res.headers_mut().insert("keep-seq", HeaderValue::from(seq));
    }
    res
}

#[cfg(test)]
mod tests {
    use super::Timing;

    #[test]
    fn keep_seq_names_one_commit_and_none_after_two() {
        let t = Timing::default();
        assert_eq!(t.keep_seq(), None, "nothing written");
        t.wrote(7);
        assert_eq!(t.keep_seq(), Some(7));
        // A second commit: its answer can't vouch for what came between.
        t.wrote(9);
        assert_eq!(t.keep_seq(), None);
    }
}
