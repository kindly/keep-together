//! `keep stripe requeue <slug>`: put an organisation's parked Stripe
//! webhook events back in the queue (`api::stripe::process`). An event
//! is parked (`failed`) when Stripe refused what handling it needed, or
//! after two days of retries; once the cause is mended this is how it
//! runs again. The running api's `stripe-events` job picks them up
//! within 30 seconds; nothing is called from here.

use std::path::Path;

/// How many events went back in the queue.
pub fn requeue(data: &Path, slug: &str) -> Result<usize, String> {
    let store = crate::tenant::open(data).map_err(|e| e.to_string())?;
    let tenant = store
        .platform()
        .tenant_by_slug(slug)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no organisation {slug:?}"))?;
    api::stripe::process::requeue_failed(&store, &tenant.id).map_err(|e| e.to_string())
}
