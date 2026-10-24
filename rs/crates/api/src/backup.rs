//! Hourly snapshots: the second backup beside Litestream (plan
//! `migration-rust.sv`, round 2). Every hour, each org file whose newest
//! revision id moved since its last snapshot, plus `platform.db`, is
//! copied (`VACUUM INTO`, one read transaction, so the copy is consistent
//! under writes), checked (`integrity_check`), compressed (zstd) and
//! uploaded to the snapshot bucket, which lives in another AWS account
//! with Object Lock. The app can put and read there, never delete.
//!
//! Keys are `<tier>/<env>/<tenant-id|platform>/<YYYY-MM-DDTHHZ>.db.zst`.
//! The tier is in the key so the bucket's lifecycle rules can expire by
//! prefix (`scripts/aws/backup.sh`: hourly 48 h, daily 30 d, monthly 12
//! months). Which tiers a file gets, per run:
//!
//! - **hourly** when its revision moved since the last snapshot (always
//!   for `platform.db`, which has no revisions);
//! - **daily** at the first run of a UTC day, when it moved since the last
//!   daily one: the end-of-yesterday state;
//! - **monthly** at the first run of a UTC month, whether it moved or
//!   not, so an org untouched for a year still has a copy.
//!
//! So the newest state of every file is always in the bucket: in the
//! hourly tier for 48 h, the daily for 30 d, then the monthly.
//!
//! What was uploaded is recorded in `platform.db` (`snapshots`). The job
//! never holds a transaction across two files.
//!
//! Also here: what `/healthz` reports about backups ([`health`]): the age
//! of the last snapshot and Litestream's replication lag, read from its
//! control socket (`GET /list`, `last_sync_at` per database).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use object_store::aws::{AmazonS3Builder, Checksum};
use object_store::path::Path as ObjectPath;
use object_store::{ObjectStore, ObjectStoreExt, PutPayload};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;

/// A named in-process job that runs every `every()`. The shape `api::jobs`
/// (F1) registers; until it lands, [`spawn`] runs one on its own.
pub trait Job: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    fn every(&self) -> Duration;
    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>>;
}

/// Run `job` every `every()`, the first time `first_after` from now.
/// Errors go to the log (and Sentry, through [`crate::observe`]).
pub fn spawn(job: Arc<dyn Job>, first_after: Duration) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(first_after).await;
        let mut tick = tokio::time::interval(job.every());
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            if let Err(err) = job.run().await {
                crate::observe::error(&format!("job {}: {err}", job.name()));
            }
        }
    })
}

const PLATFORM: &str = "platform";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tier {
    Hourly,
    Daily,
    Monthly,
}

impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Hourly => "hourly",
            Tier::Daily => "daily",
            Tier::Monthly => "monthly",
        }
    }
}

/// The object key of one snapshot.
pub fn key(tier: Tier, env: &str, name: &str, at: OffsetDateTime) -> ObjectPath {
    let stamp = at
        .to_offset(time::UtcOffset::UTC)
        .format(format_description!("[year]-[month]-[day]T[hour]Z"))
        .expect("format a UTC hour");
    ObjectPath::from(format!("{}/{env}/{name}/{stamp}.db.zst", tier.as_str()))
}

/// The snapshot job's settings.
pub struct SnapshotConfig {
    /// The data dir: `platform.db` and `orgs/`.
    pub data_dir: PathBuf,
    /// `KEEP_ENV`: the second key segment, so staging and prod can share a
    /// bucket and each IAM user is limited to its own.
    pub env: String,
    pub bucket: Arc<dyn ObjectStore>,
}

impl SnapshotConfig {
    /// From the environment; `None` when `KEEP_SNAPSHOT_BUCKET` is unset
    /// (dev, QC, tests: snapshots off).
    ///
    /// `KEEP_SNAPSHOT_BUCKET` (or `file:///some/dir`), `KEEP_SNAPSHOT_REGION`
    /// (default eu-west-2),
    /// `KEEP_SNAPSHOT_ACCESS_KEY_ID`, `KEEP_SNAPSHOT_SECRET_ACCESS_KEY`,
    /// optionally `KEEP_SNAPSHOT_ENDPOINT` (any S3-compatible store), and
    /// `KEEP_ENV` (default `dev`). Not the `AWS_*` names: those belong to
    /// Litestream's replica, which is another account and another key.
    pub fn from_env(data_dir: &Path) -> Result<Option<Self>, String> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let Some(bucket) = var("KEEP_SNAPSHOT_BUCKET") else {
            return Ok(None);
        };
        let env = var("KEEP_ENV").unwrap_or_else(|| "dev".into());
        // A directory standing in for the bucket: local runs of the image's
        // restore path, without S3.
        if let Some(dir) = bucket.strip_prefix("file://") {
            std::fs::create_dir_all(dir).map_err(|e| format!("{dir}: {e}"))?;
            let local = object_store::local::LocalFileSystem::new_with_prefix(dir)
                .map_err(|e| e.to_string())?;
            return Ok(Some(Self {
                data_dir: data_dir.to_path_buf(),
                env,
                bucket: Arc::new(local),
            }));
        }
        let need =
            |k: &str| var(k).ok_or_else(|| format!("{k} is required with KEEP_SNAPSHOT_BUCKET"));
        let mut s3 = AmazonS3Builder::new()
            .with_bucket_name(bucket)
            .with_region(var("KEEP_SNAPSHOT_REGION").unwrap_or_else(|| "eu-west-2".into()))
            .with_access_key_id(need("KEEP_SNAPSHOT_ACCESS_KEY_ID")?)
            .with_secret_access_key(need("KEEP_SNAPSHOT_SECRET_ACCESS_KEY")?)
            // An Object Lock bucket refuses a PUT without an integrity
            // checksum (Content-MD5 or x-amz-checksum-*).
            .with_checksum_algorithm(Checksum::SHA256);
        if let Some(endpoint) = var("KEEP_SNAPSHOT_ENDPOINT") {
            s3 = s3
                .with_allow_http(endpoint.starts_with("http://"))
                .with_endpoint(endpoint);
        }
        let bucket = s3.build().map_err(|e| e.to_string())?;
        Ok(Some(Self {
            data_dir: data_dir.to_path_buf(),
            env,
            bucket: Arc::new(bucket),
        }))
    }
}

/// What one run did.
#[derive(Debug, Default, Clone)]
pub struct RunReport {
    /// `(name, tiers)` for every file uploaded.
    pub uploaded: Vec<(String, Vec<Tier>)>,
    /// Files with nothing to do.
    pub skipped: usize,
    /// `(name, error)`: a failed file doesn't stop the others.
    pub failed: Vec<(String, String)>,
}

pub struct SnapshotJob {
    config: SnapshotConfig,
}

impl Job for SnapshotJob {
    fn name(&self) -> &'static str {
        "snapshots"
    }

    fn every(&self) -> Duration {
        Duration::from_secs(3600)
    }

    fn run(&self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async move {
            let report = self.run_once(OffsetDateTime::now_utc()).await?;
            let failed = report.failed.len();
            if let Some(state) = HEALTH.get() {
                *state.last_run.lock().unwrap() = Some(report.clone());
            }
            eprintln!(
                "snapshots: {} uploaded, {} unchanged, {failed} failed",
                report.uploaded.len(),
                report.skipped
            );
            if failed == 0 {
                Ok(())
            } else {
                Err(report
                    .failed
                    .iter()
                    .map(|(name, e)| format!("{name}: {e}"))
                    .collect::<Vec<_>>()
                    .join("; "))
            }
        })
    }
}

/// One source file: `platform.db` or an org file named by its tenant id.
struct Source {
    name: String,
    path: PathBuf,
}

/// A `snapshots` row.
#[derive(Default)]
struct Ledger {
    last_revision: Option<i64>,
    daily_revision: Option<i64>,
    daily_day: Option<String>,
    monthly_month: Option<String>,
}

impl SnapshotJob {
    pub fn new(config: SnapshotConfig) -> Self {
        Self { config }
    }

    /// Snapshot what's due at `now`. Errors only if the data dir or the
    /// ledger can't be read; a failing file is in the report.
    pub async fn run_once(&self, now: OffsetDateTime) -> Result<RunReport, String> {
        let dir = self.config.data_dir.clone();
        let sources = off(move || sources(&dir)).await?;
        let mut report = RunReport::default();
        for source in sources {
            match self.one(&source, now).await {
                Ok(tiers) if tiers.is_empty() => report.skipped += 1,
                Ok(tiers) => report.uploaded.push((source.name, tiers)),
                Err(e) => report.failed.push((source.name, e)),
            }
        }
        Ok(report)
    }

    async fn one(&self, source: &Source, now: OffsetDateTime) -> Result<Vec<Tier>, String> {
        let ledger_path = platform_path(&self.config.data_dir);
        let (name, path) = (source.name.clone(), source.path.clone());
        let tmp_dir = self.config.data_dir.join("snapshots-tmp");
        // Decide, copy, check, compress: all blocking.
        let prepared = off(move || {
            let revision = if name == PLATFORM {
                None
            } else {
                Some(latest_revision(&path)?)
            };
            let ledger = ledger_row(&ledger_path, &name)?;
            let tiers = due(&ledger, revision, now);
            if tiers.is_empty() {
                return Ok::<_, String>(None);
            }
            let bytes = copy_and_compress(&path, &tmp_dir, &name)?;
            Ok(Some((tiers, revision, bytes)))
        })
        .await?;
        let Some((tiers, revision, bytes)) = prepared else {
            return Ok(vec![]);
        };
        let payload = PutPayload::from(bytes);
        for tier in &tiers {
            let key = key(*tier, &self.config.env, &source.name, now);
            self.config
                .bucket
                .put(&key, payload.clone())
                .await
                .map_err(|e| format!("upload {key}: {e}"))?;
        }
        let ledger_path = platform_path(&self.config.data_dir);
        let (name, recorded) = (source.name.clone(), tiers.clone());
        off(move || record(&ledger_path, &name, revision, &recorded, now)).await?;
        Ok(tiers)
    }
}

/// Blocking SQLite and file work, off the async runtime.
async fn off<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

fn platform_path(data_dir: &Path) -> PathBuf {
    data_dir.join("platform.db")
}

/// `platform.db` first, then every `orgs/<32 hex>.db`, sorted. Anything
/// else in `orgs/` (premigrate copies, stray files) is not an org.
fn sources(data_dir: &Path) -> Result<Vec<Source>, String> {
    let mut out = vec![Source {
        name: PLATFORM.into(),
        path: platform_path(data_dir),
    }];
    let mut orgs = vec![];
    let entries = std::fs::read_dir(data_dir.join("orgs")).map_err(|e| e.to_string())?;
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let id = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".db"));
        if let Some(id) = id.filter(|id| is_tenant_id(id)) {
            orgs.push(Source {
                name: id.to_owned(),
                path: path.clone(),
            });
        }
    }
    orgs.sort_by(|a, b| a.name.cmp(&b.name));
    out.extend(orgs);
    Ok(out)
}

fn is_tenant_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A read-only connection outside the store's handle cache: the job never
/// takes an org's writer lock, and WAL lets it read beside the writer.
fn open_read_only(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("open {}: {e}", path.display()))?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn latest_revision(path: &Path) -> Result<i64, String> {
    open_read_only(path)?
        .query_row("SELECT coalesce(max(id), 0) FROM revisions", [], |r| {
            r.get(0)
        })
        .map_err(|e| format!("read revisions of {}: {e}", path.display()))
}

/// The ledger lives in `platform.db`. Created here until it joins the
/// platform migrations (F1).
const LEDGER: &str = "CREATE TABLE IF NOT EXISTS snapshots (
    tenant_id TEXT PRIMARY KEY,
    last_revision INTEGER,
    at INTEGER NOT NULL,
    daily_revision INTEGER,
    daily_day TEXT,
    monthly_month TEXT
) STRICT";

fn open_ledger(platform: &Path) -> Result<Connection, String> {
    let conn = Connection::open(platform).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(LEDGER).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn ledger_row(platform: &Path, name: &str) -> Result<Ledger, String> {
    let row = open_ledger(platform)?
        .query_row(
            "SELECT last_revision, daily_revision, daily_day, monthly_month
             FROM snapshots WHERE tenant_id = ?1",
            [name],
            |r| {
                Ok(Ledger {
                    last_revision: r.get(0)?,
                    daily_revision: r.get(1)?,
                    daily_day: r.get(2)?,
                    monthly_month: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(row.unwrap_or_default())
}

fn day(at: OffsetDateTime) -> String {
    at.date().to_string()
}

fn month(at: OffsetDateTime) -> String {
    format!("{}-{:02}", at.year(), u8::from(at.month()))
}

/// The tiers `ledger` is due at `now`, given its newest revision
/// (`None` for `platform.db`: always due hourly).
fn due(ledger: &Ledger, revision: Option<i64>, now: OffsetDateTime) -> Vec<Tier> {
    let mut tiers = vec![];
    let moved = |since: Option<i64>| revision.is_none() || since != revision;
    if moved(ledger.last_revision) {
        tiers.push(Tier::Hourly);
    }
    if ledger.daily_day.as_deref() != Some(&day(now)) && moved(ledger.daily_revision) {
        tiers.push(Tier::Daily);
    }
    if ledger.monthly_month.as_deref() != Some(&month(now)) {
        tiers.push(Tier::Monthly);
    }
    tiers
}

fn record(
    platform: &Path,
    name: &str,
    revision: Option<i64>,
    tiers: &[Tier],
    now: OffsetDateTime,
) -> Result<(), String> {
    let conn = open_ledger(platform)?;
    let at = (now.unix_timestamp_nanos() / 1_000_000) as i64;
    conn.execute(
        "INSERT INTO snapshots (tenant_id, at) VALUES (?1, ?2)
         ON CONFLICT (tenant_id) DO UPDATE SET at = excluded.at",
        rusqlite::params![name, at],
    )
    .map_err(|e| e.to_string())?;
    let set = |sql: &str, value: &dyn rusqlite::ToSql| {
        conn.execute(sql, rusqlite::params![value, name])
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    if tiers.contains(&Tier::Hourly) {
        set(
            "UPDATE snapshots SET last_revision = ?1 WHERE tenant_id = ?2",
            &revision,
        )?;
    }
    if tiers.contains(&Tier::Daily) {
        set(
            "UPDATE snapshots SET daily_revision = ?1 WHERE tenant_id = ?2",
            &revision,
        )?;
        set(
            "UPDATE snapshots SET daily_day = ?1 WHERE tenant_id = ?2",
            &day(now),
        )?;
    }
    if tiers.contains(&Tier::Monthly) {
        set(
            "UPDATE snapshots SET monthly_month = ?1 WHERE tenant_id = ?2",
            &month(now),
        )?;
    }
    Ok(())
}

/// `VACUUM INTO` a temp file, `integrity_check` it, zstd it. The temp
/// file is removed whatever happens.
fn copy_and_compress(path: &Path, tmp_dir: &Path, name: &str) -> Result<Vec<u8>, String> {
    std::fs::create_dir_all(tmp_dir).map_err(|e| e.to_string())?;
    let tmp = tmp_dir.join(format!("{name}.db"));
    let _ = std::fs::remove_file(&tmp);
    let out = (|| {
        open_read_only(path)?
            .execute("VACUUM INTO ?1", [tmp.to_string_lossy()])
            .map_err(|e| format!("copy {}: {e}", path.display()))?;
        let check: String = open_read_only(&tmp)?
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            return Err(format!("integrity_check of the copy: {check}"));
        }
        let file = std::fs::File::open(&tmp).map_err(|e| e.to_string())?;
        zstd::encode_all(file, 9).map_err(|e| e.to_string())
    })();
    let _ = std::fs::remove_file(&tmp);
    out
}

// ---- restore -----------------------------------------------------------

/// What [`restore_latest`] put back: `(name, key, bytes on disk)`.
pub type Restored = Vec<(String, String, u64)>;

/// Restore `platform.db` and every org it lists from the newest snapshot
/// of each (any tier), into an empty `data_dir`. Orgs the bucket holds
/// that the restored `platform.db` doesn't list (staging's reset leaves
/// old ones behind until they expire) are not restored. Each file is
/// checked with `integrity_check` before it's moved into place.
pub async fn restore_latest(
    bucket: &dyn ObjectStore,
    env: &str,
    data_dir: &Path,
) -> Result<Restored, String> {
    if platform_path(data_dir).exists() {
        return Err(format!(
            "{} exists: restore only into an empty data dir",
            platform_path(data_dir).display()
        ));
    }
    std::fs::create_dir_all(data_dir.join("orgs")).map_err(|e| e.to_string())?;
    let latest = latest_keys(bucket, env).await?;
    let platform_key = latest
        .get(PLATFORM)
        .ok_or_else(|| format!("no platform snapshot for env {env:?}"))?;
    let mut out = vec![];
    let size = fetch_into(bucket, platform_key, &platform_path(data_dir)).await?;
    out.push((PLATFORM.to_owned(), platform_key.to_string(), size));
    let platform = platform_path(data_dir);
    let tenants: Vec<String> = off(move || {
        let conn = open_read_only(&platform)?;
        let mut stmt = conn
            .prepare("SELECT id FROM tenants ORDER BY id")
            .map_err(|e| e.to_string())?;
        stmt.query_map([], |r| r.get(0))
            .and_then(|rows| rows.collect())
            .map_err(|e| e.to_string())
    })
    .await?;
    for id in tenants {
        if !is_tenant_id(&id) {
            return Err(format!("platform.db lists a malformed tenant id {id:?}"));
        }
        let key = latest
            .get(id.as_str())
            .ok_or_else(|| format!("no snapshot of org {id}"))?;
        let size = fetch_into(bucket, key, &data_dir.join("orgs").join(format!("{id}.db"))).await?;
        out.push((id, key.to_string(), size));
    }
    Ok(out)
}

/// The newest key per file name across the three tiers. Stamps sort as
/// strings (`YYYY-MM-DDTHHZ`), and the same hour in two tiers is the
/// same copy.
async fn latest_keys(
    bucket: &dyn ObjectStore,
    env: &str,
) -> Result<std::collections::HashMap<String, ObjectPath>, String> {
    use futures_util::TryStreamExt;
    let mut latest: std::collections::HashMap<String, (String, ObjectPath)> = Default::default();
    for tier in [Tier::Hourly, Tier::Daily, Tier::Monthly] {
        let prefix = ObjectPath::from(format!("{}/{env}", tier.as_str()));
        let metas: Vec<_> = bucket
            .list(Some(&prefix))
            .try_collect()
            .await
            .map_err(|e| format!("list {prefix}: {e}"))?;
        for meta in metas {
            let parts: Vec<_> = meta.location.parts().collect();
            let [_, _, name, file] = parts.as_slice() else {
                continue;
            };
            let Some(stamp) = file.as_ref().strip_suffix(".db.zst") else {
                continue;
            };
            let entry = latest.entry(name.as_ref().to_owned());
            let newer = |(s, _): &(String, ObjectPath)| stamp > s.as_str();
            match entry {
                std::collections::hash_map::Entry::Occupied(mut o) => {
                    if newer(o.get()) {
                        o.insert((stamp.to_owned(), meta.location.clone()));
                    }
                }
                std::collections::hash_map::Entry::Vacant(v) => {
                    v.insert((stamp.to_owned(), meta.location.clone()));
                }
            }
        }
    }
    Ok(latest.into_iter().map(|(n, (_, k))| (n, k)).collect())
}

/// Download, decompress to `<target>.restoring`, `integrity_check`, then
/// rename into place. Returns the restored size.
async fn fetch_into(
    bucket: &dyn ObjectStore,
    key: &ObjectPath,
    target: &Path,
) -> Result<u64, String> {
    let bytes = bucket
        .get(key)
        .await
        .map_err(|e| format!("get {key}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read {key}: {e}"))?;
    let target = target.to_path_buf();
    off(move || {
        let partial = target.with_extension("db.restoring");
        let raw = zstd::decode_all(&bytes[..]).map_err(|e| e.to_string())?;
        std::fs::write(&partial, &raw).map_err(|e| e.to_string())?;
        let check: String = open_read_only(&partial)?
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if check != "ok" {
            let _ = std::fs::remove_file(&partial);
            return Err(format!("{}: integrity_check: {check}", target.display()));
        }
        std::fs::rename(&partial, &target).map_err(|e| e.to_string())?;
        Ok(raw.len() as u64)
    })
    .await
}

// ---- health ------------------------------------------------------------

/// What `/healthz` reports about backups. Informational: the 15-minute
/// GitHub cron (`.github/workflows/health.yml`) judges it. A stale backup
/// must not fail Fly's health check, which would take the only machine
/// out of service.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupHealth {
    /// `off` (no bucket configured), or `on`.
    pub snapshots: &'static str,
    /// Seconds since the last `platform.db` snapshot, which every run
    /// takes; `None` before the first.
    pub snapshot_age_seconds: Option<i64>,
    /// Files that failed in the last run of this process.
    pub snapshot_errors: Vec<String>,
    /// `off` (no socket configured), `ok`, or `error` (unreachable, or a
    /// database not replicating).
    pub litestream: &'static str,
    /// The worst database's seconds since its last sync.
    pub litestream_lag_seconds: Option<i64>,
    /// Databases Litestream tracks.
    pub litestream_databases: usize,
    pub litestream_error: Option<String>,
}

struct HealthState {
    data_dir: PathBuf,
    snapshots: bool,
    litestream_socket: Option<PathBuf>,
    last_run: Mutex<Option<RunReport>>,
}

static HEALTH: OnceLock<HealthState> = OnceLock::new();

/// Set once at boot: where [`health`] looks. `litestream_socket` is
/// `KEEP_LITESTREAM_SOCKET` (the image sets `/run/litestream.sock`).
pub fn init_health(data_dir: &Path, snapshots: bool, litestream_socket: Option<PathBuf>) {
    let _ = HEALTH.set(HealthState {
        data_dir: data_dir.to_path_buf(),
        snapshots,
        litestream_socket,
        last_run: Mutex::new(None),
    });
}

/// The backup part of `/healthz`.
pub async fn health() -> BackupHealth {
    let mut out = BackupHealth {
        snapshots: "off",
        snapshot_age_seconds: None,
        snapshot_errors: vec![],
        litestream: "off",
        litestream_lag_seconds: None,
        litestream_databases: 0,
        litestream_error: None,
    };
    let Some(state) = HEALTH.get() else {
        return out;
    };
    let now = OffsetDateTime::now_utc();
    if state.snapshots {
        out.snapshots = "on";
        let platform = platform_path(&state.data_dir);
        out.snapshot_age_seconds = off(move || snapshot_age(&platform, now))
            .await
            .unwrap_or(None);
        if let Some(run) = state.last_run.lock().unwrap().as_ref() {
            out.snapshot_errors = run
                .failed
                .iter()
                .map(|(n, e)| format!("{n}: {e}"))
                .collect();
        }
    }
    if let Some(socket) = &state.litestream_socket {
        match litestream_list(socket).await {
            Ok(list) => {
                out.litestream_databases = list.databases.len();
                let (lag, problem) = lag(&list, now);
                out.litestream_lag_seconds = lag;
                out.litestream = if problem.is_none() { "ok" } else { "error" };
                out.litestream_error = problem;
            }
            Err(e) => {
                out.litestream = "error";
                out.litestream_error = Some(e);
            }
        }
    }
    out
}

fn snapshot_age(platform: &Path, now: OffsetDateTime) -> Result<Option<i64>, String> {
    let at: Option<i64> = open_ledger(platform)?
        .query_row(
            "SELECT at FROM snapshots WHERE tenant_id = ?1",
            [PLATFORM],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let now_ms = (now.unix_timestamp_nanos() / 1_000_000) as i64;
    Ok(at.map(|at| (now_ms - at) / 1000))
}

/// `GET /healthz`: 200 while `platform.db` answers (503 otherwise), with
/// the backup fields alongside. F1's `/healthz` replaces this route at
/// merge and keeps the body's `backup` field.
pub fn healthz_route(router: axum::Router, store: Arc<store::Store>) -> axum::Router {
    use axum::Json;
    use axum::http::StatusCode;
    router.route(
        "/healthz",
        axum::routing::get(move || {
            let store = store.clone();
            async move {
                let db = off(move || {
                    store
                        .platform()
                        .tenant_by_slug("-")
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                })
                .await;
                let status = if db.is_ok() {
                    StatusCode::OK
                } else {
                    StatusCode::SERVICE_UNAVAILABLE
                };
                let body = serde_json::json!({
                    "ok": db.is_ok(),
                    "db": db.err().unwrap_or_else(|| "ok".into()),
                    "backup": health().await,
                });
                (status, Json(body))
            }
        }),
    )
}

/// Litestream's `GET /list` on its control socket.
#[derive(Debug, Deserialize)]
pub struct LitestreamList {
    pub databases: Vec<LitestreamDb>,
}

#[derive(Debug, Deserialize)]
pub struct LitestreamDb {
    pub path: String,
    pub status: String,
    pub last_sync_at: Option<String>,
}

/// The worst lag, and what's wrong if anything is.
fn lag(list: &LitestreamList, now: OffsetDateTime) -> (Option<i64>, Option<String>) {
    let mut worst: Option<i64> = None;
    let mut problems = vec![];
    for db in &list.databases {
        if db.status != "replicating" {
            problems.push(format!("{} is {}", db.path, db.status));
        }
        match db
            .last_sync_at
            .as_deref()
            .map(|t| OffsetDateTime::parse(t, &Rfc3339))
        {
            Some(Ok(at)) => {
                let secs = (now - at).whole_seconds().max(0);
                worst = Some(worst.map_or(secs, |w| w.max(secs)));
            }
            Some(Err(e)) => problems.push(format!("{}: bad last_sync_at: {e}", db.path)),
            None => problems.push(format!("{} has never synced", db.path)),
        }
    }
    (worst, (!problems.is_empty()).then(|| problems.join("; ")))
}

/// One HTTP/1.0 request over the unix socket (no keep-alive, no chunked
/// body), with a 2 s budget.
async fn litestream_list(socket: &Path) -> Result<LitestreamList, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fetch = async {
        let mut stream = tokio::net::UnixStream::connect(socket)
            .await
            .map_err(|e| format!("connect {}: {e}", socket.display()))?;
        stream
            .write_all(b"GET /list HTTP/1.0\r\nHost: litestream\r\n\r\n")
            .await
            .map_err(|e| e.to_string())?;
        let mut raw = vec![];
        stream
            .read_to_end(&mut raw)
            .await
            .map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&raw);
        let (head, body) = text
            .split_once("\r\n\r\n")
            .ok_or("malformed response from litestream")?;
        if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
            return Err(format!(
                "litestream answered {}",
                head.lines().next().unwrap_or("")
            ));
        }
        serde_json::from_str(body).map_err(|e| format!("litestream /list: {e}"))
    };
    tokio::time::timeout(Duration::from_secs(2), fetch)
        .await
        .map_err(|_| "litestream socket timed out".to_owned())?
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn keys_carry_tier_env_file_and_utc_hour() {
        let at = datetime!(2026-10-24 13:59:12 +01:00);
        assert_eq!(
            key(Tier::Daily, "staging", "platform", at).as_ref(),
            "daily/staging/platform/2026-10-24T12Z.db.zst"
        );
    }

    #[test]
    fn tiers_due() {
        let now = datetime!(2026-10-24 13:00 UTC);
        let fresh = Ledger::default();
        assert_eq!(
            due(&fresh, Some(5), now),
            [Tier::Hourly, Tier::Daily, Tier::Monthly]
        );
        let done = Ledger {
            last_revision: Some(5),
            daily_revision: Some(5),
            daily_day: Some("2026-10-24".into()),
            monthly_month: Some("2026-10".into()),
        };
        assert!(due(&done, Some(5), now).is_empty());
        assert_eq!(due(&done, Some(6), now), [Tier::Hourly]);
        // platform.db: no revisions, so always hourly.
        assert_eq!(due(&done, None, now), [Tier::Hourly]);
        // A new day: daily only if it moved since the last daily.
        let tomorrow = datetime!(2026-10-25 00:10 UTC);
        assert!(due(&done, Some(5), tomorrow).is_empty());
        assert_eq!(due(&done, Some(6), tomorrow), [Tier::Hourly, Tier::Daily]);
        // A new month: monthly even when untouched.
        let next_month = datetime!(2026-11-01 00:10 UTC);
        assert_eq!(due(&done, Some(5), next_month), [Tier::Monthly]);
    }

    #[test]
    fn litestream_lag_is_the_worst_database() {
        let now = datetime!(2026-10-24 13:00:10 UTC);
        let list: LitestreamList = serde_json::from_str(
            r#"{"databases":[
                {"path":"/data/platform.db","status":"replicating","last_sync_at":"2026-10-24T13:00:09Z"},
                {"path":"/data/orgs/a.db","status":"replicating","last_sync_at":"2026-10-24T12:59:58.5Z"}
            ]}"#,
        )
        .unwrap();
        assert_eq!(lag(&list, now), (Some(11), None));
        let stuck: LitestreamList = serde_json::from_str(
            r#"{"databases":[{"path":"/data/orgs/b.db","status":"stopped"}]}"#,
        )
        .unwrap();
        let (worst, problem) = lag(&stuck, now);
        assert_eq!(worst, None);
        let problem = problem.unwrap();
        assert!(problem.contains("is stopped") && problem.contains("never synced"));
    }
}
