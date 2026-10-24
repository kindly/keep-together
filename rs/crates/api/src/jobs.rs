//! In-process interval jobs (Workpool's replacement). Each job runs on its
//! own timer; a job that touches organisations loops over their files one
//! at a time ([`each_org`]) and never spans two files in one transaction.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use store::{OrgDb, Store, TenantId};
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
            self.0.close_idle(IDLE_CLOSE_AFTER);
            Ok(())
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

/// The jobs every server runs. F2's backup job registers here too.
pub fn standard(store: &Arc<Store>) -> Jobs {
    let mut jobs = Jobs::new();
    jobs.register(IdleClose(store.clone()))
        .register(SessionPurge(store.clone()));
    jobs
}
