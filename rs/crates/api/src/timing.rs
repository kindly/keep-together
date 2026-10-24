//! `Server-Timing` on every `/api` response: `platform` (session +
//! membership lookups), `db` (time inside org-file closures, lock wait
//! included) and `total`, in ms. Measure scripts and QC read server time
//! from it without logs.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
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
    res
}
