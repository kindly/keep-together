//! In-process interval jobs (Workpool's replacement). Each job runs on its
//! own timer; a job that touches organisations loops over their files one
//! at a time ([`each_org`]) and never spans two files in one transaction.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use store::{OrgDb, PlatformSchema, Store, StoreError, TenantId};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

/// Close org handles nobody has used for this long.
pub const IDLE_CLOSE_AFTER: Duration = Duration::from_secs(10 * 60);

pub trait Job: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn every(&self) -> Duration;
    /// The delay before the first run after boot (default: one period).
    /// A job that must not wait a whole period after every deploy (the
    /// hourly snapshot) returns less.
    fn first_after(&self) -> Duration {
        self.every()
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;
}

#[derive(Default)]
pub struct Jobs {
    jobs: Vec<Arc<dyn Job>>,
}

impl Jobs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, job: impl Job) -> &mut Self {
        self.jobs.push(Arc::new(job));
        self
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.jobs.iter().map(|j| j.name()).collect()
    }

    /// Start every job: the first run `first_after` after start, then every
    /// period (a slow run delays the next, never overlaps it). Errors are
    /// logged with the job's name; the job keeps its schedule.
    pub fn spawn(self) -> Vec<JoinHandle<()>> {
        self.jobs
            .into_iter()
            .map(|job| {
                tokio::spawn(async move {
                    let every = job.every();
                    let start = tokio::time::Instant::now() + job.first_after();
                    let mut timer = tokio::time::interval_at(start, every);
                    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
                    loop {
                        timer.tick().await;
                        if let Err(err) = job.run().await {
                            eprintln!("job {}: {err}", job.name());
                        }
                    }
                })
            })
            .collect()
    }
}

/// Run `f` on each organisation's file in turn, off the async runtime.
/// One org's failure doesn't stop the others; the errors come back
/// together, each naming its org.
pub async fn each_org<F>(store: &Arc<Store>, f: F) -> Result<(), String>
where
    F: Fn(&TenantId, &OrgDb) -> Result<(), String> + Send + Sync + 'static,
{
    let store = store.clone();
    let f = Arc::new(f);
    tokio::task::spawn_blocking(move || {
        let mut errors = Vec::new();
        for id in store.each_org().map_err(|e| e.to_string())? {
            let done = store
                .org(&id)
                .map_err(|e| e.to_string())
                .and_then(|db| f(&id, &db));
            if let Err(err) = done {
                errors.push(format!("{id}: {err}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `platform.db`'s record of work an organisation has left part way
/// (`pending_jobs`), so a job visits only the orgs that need it and never
/// opens an idle one. A row per job and key (e.g. `field-retire`, the
/// field id): set before the work starts, cleared when it ends; a server
/// stopping in between leaves it for the job.
pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "jobs",
    steps: &[
        // 1: pending work, per organisation, job and key
        "CREATE TABLE pending_jobs (
             tenant_id TEXT NOT NULL REFERENCES tenants (id),
             job TEXT NOT NULL,
             key TEXT NOT NULL,
             since INTEGER NOT NULL,
             PRIMARY KEY (job, tenant_id, key)
         ) STRICT;",
    ],
};

/// Record `job`'s work on `key` in `tenant` as pending.
pub fn mark_pending(
    store: &Store,
    tenant: &TenantId,
    job: &str,
    key: &str,
) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "INSERT OR IGNORE INTO pending_jobs (tenant_id, job, key, since)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![tenant.as_str(), job, key, contracts::now_ms()],
        )
        .map(|_| ())
    })?;
    Ok(())
}

/// `job`'s work on `key` in `tenant` has ended.
pub fn clear_pending(
    store: &Store,
    tenant: &TenantId,
    job: &str,
    key: &str,
) -> Result<(), StoreError> {
    store.platform().with_write(|tx| {
        tx.execute(
            "DELETE FROM pending_jobs WHERE tenant_id = ?1 AND job = ?2 AND key = ?3",
            rusqlite::params![tenant.as_str(), job, key],
        )
        .map(|_| ())
    })?;
    Ok(())
}

/// One piece of pending work: its key, and since when (ms).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingKey {
    pub key: String,
    pub since: i64,
}

/// Work an org file shows part way, per job: the keys to mark pending.
type Unfinished = fn(&rusqlite::Connection) -> rusqlite::Result<Vec<String>>;

/// Every job whose work an org file records as unfinished.
const UNFINISHED: &[(&str, Unfinished)] = &[(crate::routes::fields::RETIRE_JOB, |c| {
    Ok(contacts::fields::retiring_fields(c)?
        .into_iter()
        .map(|(id, _)| id)
        .collect())
})];

/// At boot, after the migrations: mark pending any work an org file
/// shows unfinished that `platform.db` doesn't list. A recovery copies
/// `platform.db` and the org files at different moments (snapshots,
/// replicas), so a retire started between the two is in the org file
/// with no marker, and the job, visiting only marked orgs, would never
/// carry it on. Each file is read once on its own connection: no handle
/// stays open. Returns the markers added and the files that couldn't be
/// read (logged; the boot goes on).
pub fn reconcile_pending(store: &Store) -> Result<(usize, Vec<String>), StoreError> {
    let mut added = 0;
    let mut failed = Vec::new();
    for id in store.each_org()? {
        let found = store.read_org_file(&id, |c| {
            let mut out = Vec::new();
            for (job, unfinished) in UNFINISHED {
                out.extend(unfinished(c)?.into_iter().map(|key| (*job, key)));
            }
            Ok(out)
        });
        let found = match found {
            Ok(found) => found,
            Err(StoreError::MissingFile(_)) => continue,
            Err(e) => {
                failed.push(format!("{id}: {e}"));
                continue;
            }
        };
        for (job, key) in found {
            added += store.platform().with_write(|tx| {
                tx.execute(
                    "INSERT OR IGNORE INTO pending_jobs (tenant_id, job, key, since)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![id.as_str(), job, key, contracts::now_ms()],
                )
            })?;
        }
    }
    Ok((added, failed))
}

/// How old a marker must be before a job may clear it for work it finds
/// not started: the marker is written before the work's first commit
/// (write-ahead), so a fresh one may belong to work about to start.
pub const PENDING_GRACE_MS: i64 = 60_000;

/// The orgs with `job` work pending, each with its keys. Reads only
/// `platform.db`.
pub fn pending(store: &Store, job: &str) -> Result<Vec<(TenantId, Vec<PendingKey>)>, StoreError> {
    let rows: Vec<(String, PendingKey)> = store.platform().with_read(|conn| {
        conn.prepare(
            "SELECT tenant_id, key, since FROM pending_jobs WHERE job = ?1 ORDER BY tenant_id, key",
        )?
        .query_map([job], |r| {
            Ok((
                r.get(0)?,
                PendingKey {
                    key: r.get(1)?,
                    since: r.get(2)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })?;
    let mut out: Vec<(TenantId, Vec<PendingKey>)> = Vec::new();
    for id in store.each_org()? {
        let keys: Vec<PendingKey> = rows
            .iter()
            .filter(|(t, _)| t == id.as_str())
            .map(|(_, k)| k.clone())
            .collect();
        if !keys.is_empty() {
            out.push((id, keys));
        }
    }
    Ok(out)
}

/// [`each_org`] over only the orgs with `job` work pending, each with its
/// keys: an org with none is never opened.
pub async fn each_pending_org<F>(store: &Arc<Store>, job: &'static str, f: F) -> Result<(), String>
where
    F: Fn(&TenantId, &OrgDb, &[PendingKey]) -> Result<(), String> + Send + Sync + 'static,
{
    let store = store.clone();
    tokio::task::spawn_blocking(move || {
        let mut errors = Vec::new();
        for (id, keys) in pending(&store, job).map_err(|e| e.to_string())? {
            let done = store
                .org(&id)
                .map_err(|e| e.to_string())
                .and_then(|db| f(&id, &db, &keys));
            if let Err(err) = done {
                errors.push(format!("{id}: {err}"));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Close org handles idle for [`IDLE_CLOSE_AFTER`] (M2).
pub struct IdleClose(pub Arc<Store>);

impl Job for IdleClose {
    fn name(&self) -> &'static str {
        "idle-close"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60)
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            // Off the async runtime: closing a file may checkpoint it.
            let store = self.0.clone();
            tokio::task::spawn_blocking(move || store.close_idle(IDLE_CLOSE_AFTER))
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
    }
}

/// Forget expired sessions (L2; `auth::sessions` invariant 5), spent or
/// expired reset links and long-dead invites.
pub struct SessionPurge(pub Arc<Store>);

impl Job for SessionPurge {
    fn name(&self) -> &'static str {
        "session-purge"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60 * 60)
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let store = self.0.clone();
            tokio::task::spawn_blocking(move || {
                let now = contracts::now_ms();
                store
                    .platform()
                    .with_write(|tx| {
                        ::auth::sessions::sweep(tx, now)?;
                        ::auth::accounts::sweep(tx, now)
                    })
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }
}

/// Un-checkpointed WAL in one org file that `WalWatch` warns about: the
/// checkpointer is stuck, or a long read has pinned the WAL for minutes.
pub const WAL_WARN_BYTES: i64 = 64 << 20;

/// Warn (log and Sentry) when an open org file's WAL backlog passes
/// [`WAL_WARN_BYTES`]: once per crossing, not every minute.
pub struct WalWatch {
    store: Arc<Store>,
    over: AtomicBool,
}

impl WalWatch {
    pub fn new(store: Arc<Store>) -> Self {
        Self {
            store,
            over: AtomicBool::new(false),
        }
    }

    /// Whether `worst` bytes is news to warn about: over the line, and
    /// wasn't at the last check.
    pub fn crossed(&self, worst: i64) -> bool {
        let over = worst > WAL_WARN_BYTES;
        let was = self.over.swap(over, Ordering::SeqCst);
        over && !was
    }
}

impl Job for WalWatch {
    fn name(&self) -> &'static str {
        "wal-watch"
    }
    fn every(&self) -> Duration {
        Duration::from_secs(60)
    }
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let worst = self.store.wal_backlog_worst();
            if self.crossed(worst) {
                crate::observe::warning(&format!(
                    "an org file has {} MB of WAL not checkpointed",
                    worst >> 20
                ));
            }
            Ok(())
        })
    }
}

/// The jobs every server runs. F2's backup job registers here too.
pub fn standard(store: &Arc<Store>) -> Jobs {
    let mut jobs = Jobs::new();
    jobs.register(IdleClose(store.clone()))
        .register(SessionPurge(store.clone()))
        .register(WalWatch::new(store.clone()))
        // B1: retires left part way.
        .register(crate::routes::fields::FieldRetire(store.clone()))
        // Declaration scans: pairings, orphan blobs, discarded images.
        .register(crate::scans::PairingSweep(store.clone()))
        .register(crate::scans::OrphanSweep(store.clone()))
        .register(crate::scans::DiscardPurge(store.clone()))
        // Bank transfers step 5: standing orders' missed payments.
        .register(crate::routes::standing_orders::StandingOrdersMissed(
            store.clone(),
        ));
    jobs
}
